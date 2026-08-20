import {
  AmbientLight,
  BoxGeometry,
  Clock,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  Euler,
  FogExp2,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Quaternion,
  Scene,
  SkeletonHelper,
  Vector3,
  WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

import { TimeOfDaySystem, type TimeOfDayPreset } from './atmosphere/TimeOfDaySystem'
import { FaceController } from './face/FaceController'
import { FleetLayer, type FleetPresenceItem } from './fleet/FleetLayer'
import type { FleetConfig } from './fleet/fleetConfig'
import { loadModel } from './loaders/loadModel'
import {
  DEFAULT_PROCEDURAL_TUNING,
  ProceduralLocomotion,
  type ProceduralTuning,
} from './locomotion/ProceduralLocomotion'
import { ArdyMotionSource, type ArdyMotionState, type ArdyTelemetry } from './motion/ArdyMotionSource'
import { PickupSystem, type PickupProbe } from './interactables/PickupSystem'
import { GoalPlanner, type EssenceStateSnapshot, type GoalPlannerPolicy, type GoalPlannerTelemetry } from './planning/GoalPlanner'
import type { SelfCollisionTargetReport } from './collision/SelfCollision.ts'
import { RoomNavigation } from './navigation/RoomNavigation'
import { AvatarRig } from './rig/AvatarRig'
import roomManifest from './room/roomObjects.json'
import { InteractableStateMachine, type StateJournalEntry } from './room/interactableState'
import type { SceneInteraction, SceneManifest, SceneObject } from './room/sceneManifest'
import type { RoomObjectDefinition } from './types'
import { VisemeController } from './voice/VisemeController'

export type CameraMode = 'room' | 'follow' | 'portrait'
export type MotionPreview = 'idle' | 'crouch' | 'kick-left' | 'kick-right' | 'balance-left' | 'balance-right' | 'jumping-jacks' | 'jump' | 'bend' | 'walk'

/** Avatar footprint radius (m) — geometry, not room data; added to manifest obstacle padding. */
const LOFT_ACTOR_RADIUS = 0.22

/** Presence poll cadence (ms) — the essence driver's state source cadence
 * (ESSENCE_GOALS_SPEC.md: "polls it on the presence cadence (~30s)"). */
const PRESENCE_POLL_MS = 30_000

/** Essence driver options for the tai loft (spatial layer 4). */
export interface TaiRoomEssenceOptions {
  /** The operator whose presence drives her goals (tai for the tai-loft; the
   * mechanism is operator-generic — presence items carry operatorId). */
  operator?: string
}

/** Fleet-layer options (card t_ee790be9 — the loft is the fleet's living
 * room): when a fleet config is supplied, every operator in it is embodied
 * as a 2D billboard (portrait holo-card) driven by her own presence item,
 * alongside Tai's VRM. Absent → single-operator loft exactly as before. */
export interface TaiRoomFleetOptions {
  config: FleetConfig
}

/** Minimal shape of one /api/hyrax/presence item (the fields the essence
 * driver consumes; anything else is ignored, fail-closed). */
interface PresenceItem {
  operatorId?: string
  activity?: { type?: string }
  derivedState?: {
    fresh?: boolean
    mood?: string | null
    energy?: number | null
    focus?: number | null
    stress?: number | null
    sociability?: number | null
  }
}

/** Map a presence item to the planner's EssenceStateSnapshot. Missing fields
 * become null (the driver's clauses fail closed on them). */
function presenceItemToEssenceState(item: PresenceItem): EssenceStateSnapshot {
  const ds = item.derivedState ?? {}
  return {
    fresh: ds.fresh === true,
    mood: typeof ds.mood === 'string' ? ds.mood : null,
    energy: typeof ds.energy === 'number' ? ds.energy : null,
    focus: typeof ds.focus === 'number' ? ds.focus : null,
    stress: typeof ds.stress === 'number' ? ds.stress : null,
    sociability: typeof ds.sociability === 'number' ? ds.sociability : null,
    activity: typeof item.activity?.type === 'string' ? item.activity.type : null,
  }
}

export type RigDiagnosticSnapshot = {
  capturedAt: string
  frameRate: number
  frameTimeMs: number
  cameraMode: CameraMode
  motionPreview: MotionPreview
  visualBounds: { center: number[]; size: number[] } | null
  tuning: ProceduralTuning
  bone: {
    name: string
    found: boolean
    localEulerDegrees?: number[]
    worldEulerDegrees?: number[]
    worldPosition?: number[]
  } | null
  roomObjectIds: string[]
}

/**
 * Tai's body and room only. Hermes/Division Gateway remain the sole source of
 * conversation, decisions, memory, and future motion commands.
 */
export class TaiRoomScene {
  private readonly scene = new Scene()
  private readonly camera = new PerspectiveCamera(45, 1, 0.1, 100)
  private readonly renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
  private readonly controls: OrbitControls
  private readonly clock = new Clock()
  private readonly navigation: RoomNavigation
  private readonly face = new FaceController()
  private readonly visemes = new VisemeController()
  /** Bounded pickup (spatial layer 5): attach-to-bone, carry, putdown. */
  private readonly pickup = new PickupSystem()
  /** Stateful interactables (spatial layer 5): per-object state machines
   * (INTERACTABLES_SPEC.md) — current state, requires gating, and the
   * journaled sets transition on interaction completion. */
  private readonly objectStates: InteractableStateMachine
  private readonly objects = new Map<string, Mesh>()
  private readonly resizeObserver: ResizeObserver
  private readonly ambient: AmbientLight
  private readonly directional: DirectionalLight
  private readonly pendant: PointLight
  private readonly projector: PointLight
  private readonly server: PointLight
  private readonly timeOfDay: TimeOfDaySystem
  private rig: AvatarRig | null = null
  private locomotion: ProceduralLocomotion | null = null
  private ardySource: ArdyMotionSource | null = null
  private planner: GoalPlanner | null = null
  private skeletonHelper: SkeletonHelper | null = null
  private frame = 0
  private destroyed = false
  private reducedMotion = false
  private readonly contextAbort = new AbortController()
  /** Essence driver: the operator whose presence drives her goals. */
  private readonly operatorId: string
  /** Essence driver: latest polled snapshot (fail-closed null on any fetch
   * problem — no state → no essence goals → ambient deck path unchanged). */
  private lastEssenceSnapshot: EssenceStateSnapshot | null = null
  /** Essence driver: test-only presence override (spec AC "test-only presence
   * override"); while set, the driver reads THIS instead of the poll. */
  private essenceOverride: EssenceStateSnapshot | null = null
  private presenceTimer: number | null = null
  private cameraMode: CameraMode = 'room'
  private motionPreview: MotionPreview = 'idle'
  private motionPreviewStartedAt = 0
  private frameRate = 0
  private smoothedFrameTime = 0
  /** Fleet layer (card t_ee790be9): billboard embodiments for the other
   * operators, driven by the SAME presence poll as the essence driver. */
  private fleet: FleetLayer | null = null
  /** Latest full presence items array (fleet layer + essence driver both
   * read from the one poll — no second polling loop). */
  private lastPresenceItems: FleetPresenceItem[] = []

  constructor(
    private readonly container: HTMLElement,
    private readonly vrmUrl: string,
    private readonly manifest: SceneManifest,
    /**
     * Test/dev seam: goal-planner policy overrides (compressed cadence —
     * e.g. AMBIENT_AFTER_S: 10 for live ambient-driver verification).
     * Production mounts omit it; all policy defaults stay in GOAL_PLANNER.
     */
    private readonly plannerPolicy: Partial<GoalPlannerPolicy> = {},
    /** Essence driver options (spatial layer 4): which operator's presence
     * drives her goals. */
    private readonly essenceOptions: TaiRoomEssenceOptions = {},
    /** Fleet options (card t_ee790be9): multi-operator 2D embodiment. */
    private readonly fleetOptions: TaiRoomFleetOptions | null = null,
  ) {
    // Collision is data now (SCENE_MANIFEST_SPEC.md): bounds + obstacles
    // come from the manifest. LOFT_ACTOR_RADIUS is avatar geometry, not
    // room data, so it stays here (matches the pre-manifest 0.22).
    this.operatorId = this.essenceOptions.operator ?? 'tai'
    this.navigation = RoomNavigation.fromManifest(manifest, LOFT_ACTOR_RADIUS)
    this.objectStates = new InteractableStateMachine(manifest)
    this.scene.background = new Color('#0c1220')
    this.scene.fog = new FogExp2('#080c14', 0.018)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.outputColorSpace = 'srgb'
    this.renderer.shadowMap.enabled = true
    this.renderer.domElement.setAttribute('aria-label', "Interactive 3D view of Tai's Synthesis Loft")
    this.container.append(this.renderer.domElement)

    this.camera.position.set(6.4, 4.2, 7.2)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.set(0, 1.05, 0)
    this.controls.enableDamping = true
    this.controls.minDistance = 1.3
    this.controls.maxDistance = 11
    this.controls.maxPolarAngle = Math.PI * 0.49

    this.ambient = new AmbientLight('#fff0df', 0.58)
    this.directional = new DirectionalLight('#ffe0b5', 0.9)
    this.directional.position.set(3, 6, 2)
    this.directional.castShadow = true
    this.pendant = new PointLight('#ffb86b', 1.15, 6.5)
    this.pendant.position.set(-0.2, 2.35, 1.1)
    this.projector = new PointLight('#7ec8ff', 0.45, 6)
    this.projector.position.set(0, 2.1, -3.45)
    this.server = new PointLight('#6ee7ff', 0.55, 4.5)
    this.server.position.set(-3.45, 1.25, -1.1)
    this.scene.add(this.ambient, this.directional, this.pendant, this.projector, this.server)
    this.timeOfDay = new TimeOfDaySystem(this.scene, this.ambient, this.directional, this.pendant, this.projector, this.server)

    // Fleet layer (card t_ee790be9): 2D billboard embodiments for every
    // operator in the fleet config (the sisters + aya), each driven by her
    // own presence item via the scene's single poll. Absent → the loft
    // stays exactly the single-operator room it always was.
    if (this.fleetOptions && this.fleetOptions.config.operators.length > 0) {
      this.fleet = new FleetLayer(this.scene, this.camera, container, this.fleetOptions.config.operators)
    }

    this.seedRoom()
    // Stateful interactables (spatial layer 5): object-declared collision
    // (door_01's AABB) joins the nav grid, then each object's initial state
    // applies its mesh_rotation + obstacle flag (closed door = blocking).
    this.registerStatefulObstacles()
    this.applyInitialObjectStates()
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(this.container)

    // Detect reduced motion preference
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    // WebGL context loss/restore — degrade to shell fallback
    this.renderer.domElement.addEventListener('webglcontextlost', (event) => {
      event.preventDefault()
      this.renderingDegraded('WebGL context lost')
    }, { signal: this.contextAbort.signal })
    this.renderer.domElement.addEventListener('webglcontextrestored', () => {
      this.renderingDegraded('WebGL context restored — refresh to continue')
    }, { signal: this.contextAbort.signal })
  }

  async initialize(): Promise<void> {
    const model = await loadModel(this.vrmUrl, this.contextAbort.signal)
    // Guard: disposed while loading — do not attach, restart RAF, or resurrect
    if (this.destroyed) {
      this.disposeModelIfSafe(model)
      return
    }
    this.rig = new AvatarRig(model)
    const size = this.rig.getVisualSize()
    if (size.y > 100 || size.y < 0.1) {
      const scale = 1.7 / Math.max(size.y, 0.001)
      this.rig.scene.scale.setScalar(scale)
    }
    this.rig.scene.position.set(0, 0, 0.15)
    this.rig.scene.rotation.y = 0
    this.scene.add(this.rig.scene)
    this.locomotion = new ProceduralLocomotion(this.rig)
    this.ardySource = new ArdyMotionSource({ rig: this.rig, navigation: this.navigation })
    // Goal planner (spatial layer 3b): intents → motion sequences. The
    // source satisfies PlannerPromptChannel structurally; the probe reads
    // the ACTUAL rendered root (never dead-reckon). Ambient idle driver is
    // the lowest-priority prompt owner; the essence driver (spatial layer 4)
    // reads the operator's presence-derived state through the provider
    // (override ?? last polled snapshot).
    if (this.ardySource) {
      this.planner = new GoalPlanner({
        navigation: this.navigation,
        manifest: this.manifest,
        channel: this.ardySource,
        policy: this.plannerPolicy,
        essenceState: () => this.essenceOverride ?? this.lastEssenceSnapshot,
        probe: () => {
          const rig = this.rig
          return rig
            ? {
                x: rig.scene.position.x,
                z: rig.scene.position.z,
                yaw: rig.scene.rotation.y,
                // Graze-class re-aim signal: the body's nav-rejection
                // counter (a walk pressed into an obstacle absorbs
                // frames — the reflex may never fire on a slow graze).
                navAbsorbCount: this.ardySource?.navAbsorbCountSnapshot ?? 0,
              }
            : { x: 0, z: 0.15, yaw: 0, navAbsorbCount: 0 }
        },
        // Live object state for the requires gate (spatial layer 5): the
        // planner refuses requires-gated interactions while the object is
        // in the wrong state (an open door can't be opened) — journaled.
        objectState: (objectId) => this.objectStates.stateOf(objectId),
        // Interaction-completion hook (spatial layer 5): pickup/putdown and
        // sets state transitions live HERE (the scene), not in the planner
        // — the planner just reports that the interaction finished playing.
        onInteractionComplete: (interactionId, interaction) =>
          this.handleInteractionComplete(interactionId, interaction),
      })
    }
    this.face.applyIntent({ face: { expression: 'relaxed', intensity: 0.25, talking: false } })
    this.resize()
    this.setCameraMode('room')
    this.startEssencePoller()
    this.animate()
  }

  setCameraMode(mode: CameraMode): void {
    this.cameraMode = mode
    if (mode === 'room') {
      this.camera.position.set(6.4, 4.2, 7.2)
      this.controls.target.set(0, 1, 0)
    } else if (mode === 'portrait') {
      this.camera.position.set(0.15, 1.58, 1.35)
      this.controls.target.set(0, 1.48, 0)
    } else {
      this.camera.position.set(2.4, 1.9, 3.1)
      this.controls.target.set(0, 1.05, 0)
    }
    this.controls.update()
  }

  setTimeOfDay(preset: TimeOfDayPreset | null): void {
    this.timeOfDay.setFixedPhase(preset)
  }

  setExpression(expression: string, intensity: number): void {
    this.face.applyIntent({ face: { expression, intensity, talking: false } })
  }

  setProceduralTuning(tuning: Partial<ProceduralTuning>): void {
    this.locomotion?.setTuning(tuning)
  }

  setArdyPrompt(text: string): void {
    this.ardySource?.setPrompt(text)
  }

  /** Live toggle for the bounded self-collision pass (__ardy debug seam). */
  setArdySelfCollision(enabled: boolean): void {
    this.ardySource?.setSelfCollisionEnabled(enabled)
  }

  /** Debug probe: current per-target self-collision penetration. */
  getArdySelfCollisionReport(): SelfCollisionTargetReport[] | null {
    return this.ardySource?.selfCollisionReport() ?? null
  }

  getArdyState(): ArdyMotionState {
    return this.ardySource?.state ?? 'offline'
  }

  /** EMB-1: latency/buffer/reconnect telemetry for the debug overlay.
   * Merges the goal planner's telemetry under `planner` (spatial layer 3b). */
  getArdyTelemetry(): (ArdyTelemetry & { planner: GoalPlannerTelemetry | null }) | null {
    const base = this.ardySource?.getTelemetry() ?? null
    if (!base) return null
    return { ...base, planner: this.planner?.getTelemetry() ?? null }
  }

  /** Goal planner seam (spatial layer 3b): start a manifest interaction goal
   * (e.g. "desk.work"). Returns false when the interaction is unknown.
   *
   * Pickup gate (spatial layer 5, INTERACTABLES_SPEC.md v1 — the door task
   * owns states/requires/sets; until those land, the pickup/putdown pairing
   * is gated HERE): a pickup goal is refused while she is already holding,
   * and a putdown goal (a non-pickup interaction on a pickable object) is
   * refused while she is empty-handed. One held object at a time. */
  setGoal(interactionId: string): boolean {
    const [objectId, interactionName] = interactionId.split('.')
    const object = this.manifest.objects.find((o) => o.id === objectId)
    const interaction = object?.interactions?.find((i) => i.id === interactionName)
    if (interaction?.kind === 'pickup' && this.pickup.heldObjectId !== null) {
      console.warn(`[pickup] refusing ${interactionId}: already holding "${this.pickup.heldObjectId}"`)
      return false
    }
    const pickable = object?.interactions?.some((i) => i.kind === 'pickup') ?? false
    if (pickable && interaction && interaction.kind !== 'pickup' && this.pickup.heldObjectId !== objectId) {
      console.warn(`[pickup] refusing ${interactionId}: not holding "${objectId}"`)
      return false
    }
    return this.planner?.setGoal(interactionId) ?? false
  }

  /**
   * Interaction-completion hook (spatial layer 5): applies pickup/putdown
   * semantics when a manifest interaction finishes playing.
   *   - `kind: "pickup"` → bounded attach: the object's mesh parents to the
   *     attach bone with the offset (no IK, no physics — parenting IS the
   *     tracking). Refused (journaled) when out of bounded range, bone
   *     missing, or already holding.
   *   - any other interaction on a pickable object while she holds it →
   *     putdown: the mesh unparents and is placed at the object's authored
   *     home position, where it stays.
   */
  private handleInteractionComplete(interactionId: string, interaction: SceneInteraction): void {
    const objectId = interactionId.split('.')[0]
    const object = this.manifest.objects.find((o) => o.id === objectId)
    if (!object) {
      console.warn(`[pickup] completion for unknown object "${objectId}"`)
      return
    }
    // Stateful interactables (spatial layer 5 — door slice): apply the
    // interaction's `sets` transition on completion — mesh response + nav
    // collision toggle, journaled. Independent of pickup semantics below.
    this.applyStateTransition(object, interaction)
    const home = new Vector3(object.position[0], object.position[1], object.position[2])
    const mesh = this.objects.get(this.bakedMeshForObject(objectId))
    if (!mesh) {
      console.warn(`[pickup] no baked mesh for object "${objectId}" (${interactionId})`)
      return
    }
    if (interaction.kind === 'pickup') {
      if (!interaction.attach) return // validator rejects this; belt-and-suspenders
      const hold = this.pickup.pickUp(
        objectId,
        mesh,
        interaction.attach,
        this.resolveBone(interaction.attach.bone),
        { x: this.rig?.scene.position.x ?? 0, z: this.rig?.scene.position.z ?? 0 },
        home,
      )
      console.info(
        hold
          ? `[pickup] ${interactionId} → ${interaction.attach.bone} (offset ${interaction.attach.offset.join(',')})`
          : `[pickup] ${interactionId} refused: ${this.pickup.lastReason}`,
      )
      return
    }
    // Putdown: any completed interaction on the held object's manifest
    // entry releases it (spec: "putdown reverses at a target spot"). Only
    // pickable objects take this path — stateful props (the door) don't.
    if (!this.isPickableObject(objectId)) return
    if (this.pickup.putDown(objectId)) {
      console.info(`[pickup] ${interactionId} → cup placed at (${home.x.toFixed(2)}, ${home.y.toFixed(2)}, ${home.z.toFixed(2)})`)
    } else if (this.pickup.lastReason) {
      console.warn(`[pickup] ${interactionId} putdown refused: ${this.pickup.lastReason}`)
    }
  }

  /** Baked-visual binding: manifest object id → seeded mesh id. The manifest
   * is the spatial truth; rendering is downstream (SCENE_MANIFEST_SPEC) —
   * the cup's visual is the baked coffee-mug cylinder. */
  private bakedMeshForObject(objectId: string): string {
    return objectId === 'cup' ? 'coffee-mug' : objectId
  }

  /** Resolve an attach bone to the node the motion actually writes (the
   * normalized humanoid rig — pose-probe vocabulary), with the rig's
   * general bone resolver as fallback. Null when the rig is absent. */
  private resolveBone(name: string): Object3D | null {
    const humanoid = this.rig?.vrm?.humanoid
    return humanoid?.getNormalizedBoneNode(name as any) ?? this.rig?.getBone(name) ?? null
  }

  /** Live pickup probe for the GEVS pickup-cup check (measured state: held
   * object id, attach bone, cup/hand world positions, carry-follow error,
   * last placement, last range refusal). */
  getPickupProbe(): PickupProbe {
    const probe = this.pickup.probe()
    if (probe.home === null) {
      const object = this.manifest.objects.find((o) => o.id === 'cup')
      if (object) probe.home = [...object.position] as [number, number, number]
    }
    return probe
  }

  // ── stateful interactables (spatial layer 5 — door slice) ────────

  /** Stateful-interactable completion: apply the interaction's `sets`
   * transition — mesh_rotation on the baked mesh + nav obstacle toggle per
   * the new state's `obstacle` flag. Journaled by the machine; no-op when
   * the interaction has no `sets` (or the object has no machine). */
  private applyStateTransition(object: SceneObject, interaction: SceneInteraction): void {
    const transition = this.objectStates.applySets(object, interaction)
    if (!transition) return
    this.applyObjectStateEffects(object, transition.to)
    console.info(`[loft] ${object.id}: ${transition.from} → ${transition.to} (interaction "${interaction.id}" completed)`)
  }

  /** Apply a state's declared effects: mesh rotation (Euler, radians) +
   * nav obstacle enabled-ness. Called at load for the initial state and on
   * every transition (spec: the world responds). */
  private applyObjectStateEffects(object: SceneObject, stateName: string): void {
    const state = object.states?.[stateName]
    if (!state) return
    const mesh = this.objects.get(object.id)
    if (mesh) mesh.rotation.set(state.mesh_rotation[0], state.mesh_rotation[1], state.mesh_rotation[2])
    if (object.obstacle) this.navigation.setObstacleEnabled(object.id, state.obstacle)
  }

  /** Register stateful-object collision AABBs (manifest object.obstacle)
   * with the nav grid. Enabled-ness follows the current state. */
  private registerStatefulObstacles(): void {
    for (const object of this.manifest.objects) {
      if (!object.states || !object.obstacle) continue
      this.navigation.addBoxObstacle(
        object.id,
        new Vector3(object.obstacle.center[0], 0, object.obstacle.center[1]),
        new Vector3(object.obstacle.halfSize[0] * 2, 1, object.obstacle.halfSize[1] * 2),
        object.obstacle.padding,
      )
    }
  }

  /** Apply each stateful object's initial state effects (load-time). */
  private applyInitialObjectStates(): void {
    for (const object of this.manifest.objects) {
      if (!object.states || !object.state) continue
      this.applyObjectStateEffects(object, object.state)
    }
  }

  /** True when the object is a pickable object (declares a pickup
   * interaction) — the putdown path only applies to those; stateful props
   * (the door) and plain furniture never put down. */
  private isPickableObject(objectId: string): boolean {
    return (
      this.manifest.objects.find((o) => o.id === objectId)?.interactions?.some(
        (i) => i.kind === 'pickup',
      ) ?? false
    )
  }

  /** Current state of a stateful object (null when no machine). */
  getObjectState(objectId: string): string | null {
    return this.objectStates.stateOf(objectId)
  }

  /** The baked mesh's current Euler rotation in degrees (null when the
   * object has no rendered mesh) — the visible mesh-response probe. */
  getObjectRotationDeg(objectId: string): [number, number, number] | null {
    const mesh = this.objects.get(objectId)
    if (!mesh) return null
    return [
      roundNumber((mesh.rotation.x * 180) / Math.PI),
      roundNumber((mesh.rotation.y * 180) / Math.PI),
      roundNumber((mesh.rotation.z * 180) / Math.PI),
    ]
  }

  /** Nav obstacle enabled-state for an object id (null when the object is
   * not a registered nav obstacle). */
  getNavObstacle(objectId: string): { enabled: boolean } | null {
    const obstacle = this.navigation.listObstacles().find((o) => o.id === objectId)
    return obstacle ? { enabled: obstacle.enabled } : null
  }

  /** State-transition journal (GEVS evidence: transitions are journaled). */
  getStateJournal(): StateJournalEntry[] {
    return this.objectStates.journal()
  }

  /** Direct XZ route-clear probe against the CURRENT nav state (GEVS: the
   * doorway route must be blocked while closed and clear once open). */
  isNavRouteClear(x1: number, z1: number, x2: number, z2: number): boolean {
    return this.navigation.isRouteClear(new Vector3(x1, 0, z1), [new Vector3(x2, 0, z2)])
  }

  // ── essence driver (spatial layer 4) ─────────────────────────────

  /** Start the presence poll (spec: ~30s cadence) feeding the planner's
   * essence driver. Fail-closed: any fetch problem drops the snapshot — no
   * state → no essence goals → the ambient deck path stays exactly as before. */
  private startEssencePoller(): void {
    void this.pollEssencePresence()
    this.presenceTimer = window.setInterval(() => void this.pollEssencePresence(), PRESENCE_POLL_MS)
  }

  private async pollEssencePresence(): Promise<void> {
    try {
      const response = await fetch('/api/hyrax/presence', { signal: this.contextAbort.signal })
      if (!response.ok) {
        this.lastEssenceSnapshot = null
        return
      }
      const body = (await response.json()) as { items?: PresenceItem[] }
      const items = body.items ?? []
      // Fleet layer consumes the SAME poll (acceptance: presence flows at
      // the existing cadence, no second loop).
      this.lastPresenceItems = items
      this.fleet?.updatePresence(items)
      const item = items.find((p) => p.operatorId === this.operatorId) ?? null
      this.lastEssenceSnapshot = item === null ? null : presenceItemToEssenceState(item)
    } catch {
      this.lastEssenceSnapshot = null
    }
  }

  /** Test/dev seam (spec AC: "a test-only presence override"): while set, the
   * planner's essence driver reads THIS snapshot instead of the presence
   * poll. Pass null to clear. Used by the GEVS level-4 check and the
   * seeded-state live run. */
  setEssenceOverride(state: EssenceStateSnapshot | null): void {
    this.essenceOverride = state
  }

  /** The snapshot the essence driver currently reads (override ?? polled). */
  getEssenceState(): EssenceStateSnapshot | null {
    return this.essenceOverride ?? this.lastEssenceSnapshot
  }

  /** Fleet layer accessor (card t_ee790be9) — the mount's window.__fleet
   * debug seam (presence overrides + per-actor probes). Null in
   * single-operator mode. */
  getFleet(): FleetLayer | null {
    return this.fleet
  }

  /** Cancel the active goal (journaled). No-op when idle. */
  clearGoal(): void {
    this.planner?.clearGoal()
  }

  /** Current goal id (null when idle). */
  getGoal(): string | null {
    return this.planner?.getGoal() ?? null
  }

  /**
   * Bench seam (GEVS): re-anchor the avatar at a clear floor spot between
   * checks so displacement metrics start from a deterministic position.
   * Returns false when the stream is not live.
   */
  recenterArdyRoot(x: number, z: number): boolean {
    return this.ardySource?.recenterRoot(x, z) ?? false
  }

  /** Hips bone world-space Y (ARDY E2E probe; null when no rig/bone). */
  getHipsWorldY(): number | null {
    const bone = this.rig?.getBone('hips')
    if (!bone) return null
    return bone.getWorldPosition(this.diagnosticVector).y
  }

  /**
   * Foot bone world-space Y vs the floor plane (ARDE foot-ground probe):
   * lowest of the foot/toe bones per side, plus the overall lowest. Nulls
   * when a bone is absent. Values below ~0 mean ground penetration.
   */
  getFootWorldY(): Record<string, number | null> | null {
    const humanoid = this.rig?.vrm?.humanoid
    if (!humanoid) return null
    const out: Record<string, number | null> = {}
    let lowest: number | null = null
    for (const name of ['leftFoot', 'rightFoot', 'leftToes', 'rightToes']) {
      const node = humanoid.getNormalizedBoneNode(name as any)
      const y = node ? node.getWorldPosition(this.diagnosticVector).y : null
      out[name] = y
      if (y !== null && (lowest === null || y < lowest)) lowest = y
    }
    out.lowest = lowest
    return out
  }

  /**
   * ARDY E2E probe (T2): one rendered-pose sample for discontinuity
   * measurement — scene-root XZ/yaw plus the normalized bone quats (xyzw)
   * the retarget path writes. Null when there is no rig/humanoid.
   */
  getArdyPoseProbe(boneNames: string[] = ['hips', 'spine', 'leftUpperArm', 'rightUpperArm']): {
    x: number
    z: number
    yaw: number
    bones: Record<string, [number, number, number, number] | null>
    world: Record<string, [number, number, number] | null>
  } | null {
    const humanoid = this.rig?.vrm?.humanoid
    if (!this.rig || !humanoid) return null
    const bones: Record<string, [number, number, number, number] | null> = {}
    const world: Record<string, [number, number, number] | null> = {}
    for (const name of boneNames) {
      const node = humanoid.getNormalizedBoneNode(name as any)
      const q = node?.quaternion
      bones[name] = q ? [q.x, q.y, q.z, q.w] : null
      world[name] = node
        ? (node.getWorldPosition(this.diagnosticVector).toArray() as [number, number, number])
        : null
    }
    return {
      x: this.rig.scene.position.x,
      z: this.rig.scene.position.z,
      yaw: this.rig.scene.rotation.y,
      bones,
      world,
    }
  }

  getProceduralTuning(): ProceduralTuning {
    return this.locomotion?.getTuning() ?? { ...DEFAULT_PROCEDURAL_TUNING }
  }

  setSkeletonVisible(visible: boolean): void {
    if (!this.rig) return
    if (visible && !this.skeletonHelper) {
      this.skeletonHelper = new SkeletonHelper(this.rig.scene)
      this.skeletonHelper.name = 'rig-lab-skeleton'
      this.scene.add(this.skeletonHelper)
    }
    if (this.skeletonHelper) this.skeletonHelper.visible = visible
  }

  triggerMotion(preview: MotionPreview): void {
    this.motionPreview = preview
    this.motionPreviewStartedAt = performance.now() / 1000
  }

  getDiagnosticSnapshot(boneName?: string): RigDiagnosticSnapshot {
    const bone = boneName && this.rig ? this.rig.getPoseBone(boneName) : null
    let boneDetail: RigDiagnosticSnapshot['bone'] = boneName ? { name: boneName, found: Boolean(bone) } : null
    if (bone && boneDetail) {
      const local = bone.rotation
      const world = bone.getWorldQuaternion(this.diagnosticQuaternion).normalize()
      this.diagnosticEuler.setFromQuaternion(world, 'XYZ')
      boneDetail = {
        ...boneDetail,
        localEulerDegrees: [local.x, local.y, local.z].map(radToRoundedDegrees),
        worldEulerDegrees: [this.diagnosticEuler.x, this.diagnosticEuler.y, this.diagnosticEuler.z].map(radToRoundedDegrees),
        worldPosition: bone.getWorldPosition(this.diagnosticVector).toArray().map(roundNumber),
      }
    }
    const size = this.rig?.getVisualSize()
    const center = this.rig?.getVisualCenter()
    return {
      capturedAt: new Date().toISOString(),
      frameRate: roundNumber(this.frameRate),
      frameTimeMs: roundNumber(this.smoothedFrameTime * 1000),
      cameraMode: this.cameraMode,
      motionPreview: this.motionPreview,
      visualBounds: size && center ? { center: center.toArray().map(roundNumber), size: size.toArray().map(roundNumber) } : null,
      tuning: this.getProceduralTuning(),
      bone: boneDetail,
      roomObjectIds: [...this.objects.keys()].sort(),
    }
  }

  captureScreenshot(): void {
    this.renderer.render(this.scene, this.camera)
    this.renderer.domElement.toBlob((blob) => {
      if (!blob) return
      downloadBlob(blob, `tai-rig-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
    }, 'image/png')
  }

  exportDiagnostics(boneName?: string): void {
    const json = JSON.stringify(this.getDiagnosticSnapshot(boneName), null, 2)
    downloadBlob(new Blob([json], { type: 'application/json' }), `tai-rig-diagnostics-${Date.now()}.json`)
  }

  get roomObjects(): readonly RoomObjectDefinition[] {
    return (roomManifest.objects || []) as RoomObjectDefinition[]
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true

    // Stop the presence poll (essence driver source) and animation loop
    if (this.presenceTimer !== null) {
      window.clearInterval(this.presenceTimer)
      this.presenceTimer = null
    }
    cancelAnimationFrame(this.frame)

    // Fleet layer (card t_ee790be9): remove billboards, badges, textures.
    this.fleet?.destroy()
    this.fleet = null

    // Disconnect observers
    this.resizeObserver.disconnect()

    // Clear objects map — collect meshes for disposal
    for (const mesh of this.objects.values()) {
      this.disposeMesh(mesh)
    }
    this.objects.clear()

    // Dispose scene children recursively (geometries, materials, textures)
    this.disposeSceneTree()

    // Clear scene children (lights, helpers, floor, walls, etc.)
    while (this.scene.children.length > 0) {
      this.scene.remove(this.scene.children[0])
    }

    // Dispose subsystems
    this.controls.dispose()
    this.skeletonHelper?.removeFromParent()
    this.rig?.stopAllActions()
    this.rig?.dispose()
    this.rig?.scene.removeFromParent()
    this.locomotion?.dispose()
    this.locomotion = null
    this.ardySource?.dispose()
    this.ardySource = null
    this.planner = null
    this.skeletonHelper = null

    // Dispose face/viseme/gaze
    this.face.dispose()
    this.visemes.dispose()
    this.timeOfDay.dispose()

    // Dispose renderer
    this.renderer.dispose()
    this.renderer.domElement.remove()

    // Clear references — help GC and prevent use-after-dispose
    this.contextAbort.abort()
    this.rig = null
  }

  /** Recursively dispose all scene object geometries and materials. */
  private disposeSceneTree(): void {
    const objectsToDispose: Object3D[] = []
    this.scene.traverse((obj) => objectsToDispose.push(obj))

    for (const obj of objectsToDispose) {
      if (obj instanceof Mesh) {
        this.disposeMesh(obj)
      }
    }
  }

  private disposeMesh(mesh: Mesh): void {
    if (mesh.geometry) mesh.geometry.dispose()
    const material = mesh.material
    if (Array.isArray(material)) {
      for (const mat of material) mat.dispose()
    } else if (material) {
      material.dispose()
    }
    mesh.removeFromParent()
  }

  /** Called when a model resolves after dispose — avoid resource leak. */
  private disposeModelIfSafe(model: { scene: Object3D }): void {
    model.scene.traverse((child) => {
      if (child instanceof Mesh) {
        this.disposeMesh(child)
      }
    })
  }

  /** Renderer/WebGL failure — insert fallback UI into container. */
  private renderingDegraded(reason: string): void {
    if (this.destroyed) return
    this.destroyed = true
    cancelAnimationFrame(this.frame)
    this.resizeObserver.disconnect()
    this.locomotion?.dispose()
    this.ardySource?.dispose()
    this.ardySource = null
    this.face.dispose()
    this.visemes.dispose()
    this.timeOfDay.dispose()
    this.controls.dispose()
    this.rig?.stopAllActions()
    this.rig?.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
    this.contextAbort.abort()
    const fallback = document.createElement('div')
    fallback.className = 'tai-loft-error'
    fallback.textContent = `Rendering degraded: ${reason}`
    this.container.append(fallback)
  }

  private resize(): void {
    const width = Math.max(1, this.container.clientWidth)
    const height = Math.max(1, this.container.clientHeight)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height, false)
  }

  private animate = (): void => {
    if (this.destroyed) return
    this.frame = requestAnimationFrame(this.animate)
    // Double-guard: if destroy() was called synchronously right before
    // requestAnimationFrame, the cancelled frame won't fire, but be safe.
    if (this.destroyed) { cancelAnimationFrame(this.frame); return }
    const rawDt = this.clock.getDelta()
    const dt = Math.min(rawDt, 1 / 30)
    this.smoothedFrameTime += (rawDt - this.smoothedFrameTime) * 0.08
    this.frameRate = this.smoothedFrameTime > 0 ? 1 / this.smoothedFrameTime : 0
    this.controls.update()
    this.timeOfDay.update()
    if (this.rig && this.locomotion) {
      this.rig.beginPoseAuditFrame()
      this.rig.advanceAnimation(dt)
      // ARDY live stream and procedural locomotion are mutually exclusive per
      // frame — the pose-ownership audit flags any bone written by two phases.
      let ardyOwned = false
      if (this.ardySource) {
        this.rig.beginPoseAuditPhase('ardyMotion')
        ardyOwned = this.ardySource.update(dt)
        this.rig.endPoseAuditPhase()
      }
      // Goal planner (spatial layer 3b): prompt-driven, stepped every frame
      // regardless of pose ownership (it only sends prompts; the source
      // owns the stream).
      this.planner?.update(dt)
      if (!ardyOwned) {
        this.rig.beginPoseAuditPhase('proceduralIdle')
        this.locomotion.update(dt, this.motionInput())
        this.rig.endPoseAuditPhase()
      }
      this.rig.beginPoseAuditPhase('faceGaze')
      this.face.update(this.rig, dt)
      this.visemes.update(this.rig, dt)
      this.rig.endPoseAuditPhase()
      this.rig.beginPoseAuditPhase('poseCommit+vrm')
      this.rig.commitPose(dt)
      this.rig.endPoseAuditPhase()
      this.rig.endPoseAuditFrame()
      if (this.cameraMode !== 'room') {
        this.controls.target.lerp(this.rig.getVisualCenter(), 0.06)
      }
    }
    // Fleet layer (card t_ee790be9): idle bob, crossfades, badge projection.
    this.fleet?.update(dt, performance.now())
    this.renderer.render(this.scene, this.camera)
  }

  private readonly diagnosticVector = new Vector3()
  private readonly diagnosticQuaternion = new Quaternion()
  private readonly diagnosticEuler = new Euler()

  private motionInput(): Parameters<ProceduralLocomotion['update']>[1] {
    const elapsed = performance.now() / 1000 - this.motionPreviewStartedAt
    if (this.motionPreview !== 'idle' && this.motionPreview !== 'walk' && elapsed > 2.2) this.motionPreview = 'idle'
    const base = { velocity: new Vector3(), speed: 0, locomotionState: 'idle' as const }
    switch (this.motionPreview) {
      case 'crouch': return { ...base, crouchIntensity: 1 }
      case 'kick-left': return { ...base, kickSide: 'left' }
      case 'kick-right': return { ...base, kickSide: 'right' }
      case 'balance-left': return { ...base, balanceSide: 'left' }
      case 'balance-right': return { ...base, balanceSide: 'right' }
      case 'jumping-jacks': return { ...base, jumpingJacks: true }
      case 'jump': return { ...base, jumping: true }
      case 'bend': return { ...base, bendIntensity: 1 }
      case 'walk': return { velocity: new Vector3(0, 0, -1), speed: 0.8, locomotionState: 'walking' }
      default: return base
    }
  }

  private material(color: string, options: { emissive?: string; intensity?: number; roughness?: number; metalness?: number } = {}): MeshStandardMaterial {
    return new MeshStandardMaterial({ color, roughness: options.roughness ?? 0.78, metalness: options.metalness ?? 0.05,
      emissive: options.emissive ?? '#000000', emissiveIntensity: options.intensity ?? 0 })
  }

  private box(id: string, position: Vector3, size: Vector3, color: string,
              options?: Parameters<TaiRoomScene['material']>[1]): Mesh {
    const mesh = new Mesh(new BoxGeometry(size.x, size.y, size.z), this.material(color, options))
    mesh.name = `synthesis-loft-${id}`
    mesh.position.copy(position)
    mesh.castShadow = true
    mesh.receiveShadow = true
    this.scene.add(mesh)
    this.objects.set(id, mesh)
    return mesh
  }

  private cylinder(id: string, position: Vector3, top: number, bottom: number, height: number, color: string,
                   options?: Parameters<TaiRoomScene['material']>[1]): Mesh {
    const mesh = new Mesh(new CylinderGeometry(top, bottom, height, 24), this.material(color, options))
    mesh.name = `synthesis-loft-${id}`
    mesh.position.copy(position)
    mesh.castShadow = true
    this.scene.add(mesh)
    this.objects.set(id, mesh)
    return mesh
  }

  private seedRoom(): void {
    const floor = new Mesh(new PlaneGeometry(8, 8), this.material('#2b211f', { roughness: 0.9 }))
    floor.rotation.x = -Math.PI / 2
    floor.receiveShadow = true
    this.scene.add(floor)
    const wall = this.material('#2f2930', { roughness: 0.92 })
    this.box('back-wall', new Vector3(0, 1.75, -4), new Vector3(8, 3.5, 0.15), '#2f2930')
    this.box('left-wall', new Vector3(-4, 1.75, 0), new Vector3(0.15, 3.5, 8), '#2f2930')
    this.box('right-wall', new Vector3(4, 1.75, 0), new Vector3(0.15, 3.5, 8), '#2f2930')
    wall.dispose()
    this.addSocialHub()
    this.addCommandZone()
    this.addProjectionWall()
    this.addUtilitySpine()
    this.addResetChamber()
    this.addAnalogAccents()
    this.addWarmFixtures()
    this.addDoor()
  }

  private addSocialHub(): void {
    this.box('couch-base', new Vector3(0, 0.23, 2.25), new Vector3(2.4, 0.46, 0.65), '#4b2639')
    this.box('couch-back', new Vector3(0, 0.66, 2.55), new Vector3(2.55, 0.82, 0.22), '#5a2f46')
    this.box('couch-left-arm', new Vector3(-1.33, 0.53, 2.25), new Vector3(0.24, 0.68, 0.74), '#5a2f46')
    this.box('couch-right-arm', new Vector3(1.33, 0.53, 2.25), new Vector3(0.24, 0.68, 0.74), '#5a2f46')
    for (const x of [-0.72, 0, 0.72]) this.box(`cushion-${x}`, new Vector3(x, 0.53, 2.13), new Vector3(0.68, 0.14, 0.55), '#6f3f5d')
    const left = this.box('chair', new Vector3(-2.25, 0.34, 1.25), new Vector3(0.82, 0.68, 0.82), '#33405c')
    left.rotation.y = -0.35
    const right = this.box('chair-right', new Vector3(2, 0.34, 1), new Vector3(0.78, 0.68, 0.78), '#6a4a2c')
    right.rotation.y = 0.45
    this.box('coffee-table', new Vector3(0, 0.28, 1.15), new Vector3(1.25, 0.12, 0.62), '#2c1f1a')
    this.cylinder('coffee-mug', new Vector3(0.2, 0.4, 0.92), 0.045, 0.04, 0.1, '#eeeeee')
  }

  private addCommandZone(): void {
    this.box('walnut-credenza', new Vector3(-3.63, 0.55, -1.35), new Vector3(0.42, 0.74, 2.8), '#2f1f15', { roughness: 0.54 })
    this.box('workstation', new Vector3(-3.83, 1.38, -1.35), new Vector3(0.06, 0.86, 1.42), '#101821', { emissive: '#1d8cff', intensity: 0.28, roughness: 0.35 })
    for (const z of [-2.28, -1.98, -1.68]) this.box(`server-slot-${z}`, new Vector3(-3.86, 0.67, z), new Vector3(0.045, 0.065, 0.18), '#69f0ff', { emissive: '#69f0ff', intensity: 0.9 })
    this.box('server-panel', new Vector3(-3.84, 0.9, -0.45), new Vector3(0.055, 1.1, 0.7), '#182533', { emissive: '#2dd4bf', intensity: 0.2 })
    this.cylinder('desk-stool', new Vector3(-2.9, 0.32, -0.35), 0.28, 0.24, 0.62, '#242938')
  }

  private addProjectionWall(): void {
    this.box('projection-surface', new Vector3(0, 1.65, -3.91), new Vector3(3.9, 1.72, 0.035), '#17213a', { emissive: '#315f9f', intensity: 0.22, roughness: 0.42 })
    for (let i = 0; i < 9; i += 1) {
      const x = -1.65 + i * 0.42
      const y = 1.42 + Math.sin(i * 0.9) * 0.34
      this.cylinder(`projection-star-${i}`, new Vector3(x, y, -3.86), 0.018, 0.018, 0.02, '#b8d7ff', { emissive: '#9fd1ff', intensity: 1.1 })
    }
  }

  private addUtilitySpine(): void {
    this.box('library-wall', new Vector3(2.15, 1.32, -3.92), new Vector3(2.6, 2.45, 0.06), '#2b201a')
    for (const x of [1.2, 1.72, 2.24, 2.76, 3.28]) this.box(`library-line-${x}`, new Vector3(x, 1.32, -3.86), new Vector3(0.035, 2.2, 0.035), '#5b3d27')
    this.box('kitchen', new Vector3(2.18, 0.48, -3.48), new Vector3(1.62, 0.55, 0.5), '#3b2b20')
    this.box('espresso-machine', new Vector3(1.62, 0.9, -3.44), new Vector3(0.34, 0.28, 0.25), '#11161c', { metalness: 0.35 })
    this.box('vintage-fridge', new Vector3(3.22, 0.7, -3.4), new Vector3(0.46, 1, 0.42), '#4b2430', { emissive: '#ff6a88', intensity: 0.08 })
  }

  private addResetChamber(): void {
    this.box('daybed-base', new Vector3(2.75, 0.28, 1.9), new Vector3(1.55, 0.36, 1.05), '#2a2f3d')
    this.box('daybed-linen', new Vector3(2.75, 0.52, 1.9), new Vector3(1.42, 0.16, 0.92), '#d3c3ae')
    this.box('weighted-blanket', new Vector3(2.98, 0.64, 1.92), new Vector3(0.82, 0.14, 0.88), '#6f5364')
    this.box('pillow-a', new Vector3(2.18, 0.71, 2.26), new Vector3(0.34, 0.18, 0.32), '#eee0cc')
    this.box('pillow-b', new Vector3(2.56, 0.72, 2.27), new Vector3(0.34, 0.18, 0.32), '#b9907f')
  }

  private addAnalogAccents(): void {
    this.cylinder('plant-pot', new Vector3(3.25, 0.28, -0.28), 0.28, 0.22, 0.46, '#74452f')
    this.cylinder('plant-stem', new Vector3(3.25, 0.88, -0.28), 0.035, 0.045, 0.96, '#416a37')
    for (let i = 0; i < 7; i += 1) {
      const leaf = new Mesh(new ConeGeometry(0.2, 0.62, 5), this.material('#4f8d4a', { roughness: 0.9 }))
      leaf.position.set(3.25 + Math.sin(i) * 0.18, 1.18 + (i % 2) * 0.12, -0.28 + Math.cos(i) * 0.18)
      leaf.rotation.set(0.8, 0, (i / 7) * Math.PI * 2)
      this.scene.add(leaf)
    }
    this.box('record-console', new Vector3(-1.55, 0.42, 3.58), new Vector3(1.1, 0.5, 0.28), '#221713')
    this.cylinder('turntable', new Vector3(-1.82, 0.71, 3.5), 0.18, 0.18, 0.035, '#080808')
  }

  private addWarmFixtures(): void {
    for (const x of [-1.35, 0, 1.35]) {
      this.cylinder(`pendant-${x}`, new Vector3(x, 2.45, 0.75), 0.18, 0.28, 0.24, '#ffbe75', { emissive: '#ff9f45', intensity: 0.65 })
      this.cylinder(`cord-${x}`, new Vector3(x, 2.72, 0.75), 0.012, 0.012, 0.45, '#19110f')
    }
  }

  /**
   * door_01 — the stateful interactable (INTERACTABLES_SPEC.md, spatial
   * layer 5). Panel is hinged at its LEFT edge: the geometry is translated
   * so the origin IS the hinge, and the manifest's `states.<s>.mesh_rotation`
   * swings it (closed [0,0,0] → panel along the back wall; open
   * [0,-1.57,0] → panel swings INTO the room). The engine applies the
   * rotation + nav obstacle toggle on transition (applyObjectStateEffects);
   * the handle is a child of the panel so it swings along. The manifest
   * position (-2.4, 1.2, -3.9) is the panel's authored center; the hinge
   * world point is -0.35 x of it (panel half-width).
   */
  private addDoor(): void {
    const panel = new Mesh(new BoxGeometry(0.7, 1.9, 0.08), this.material('#3a2f28', { roughness: 0.55, metalness: 0.12 }))
    panel.geometry.translate(0.35, 0, 0) // origin = hinge edge
    panel.name = 'synthesis-loft-door_01'
    panel.position.set(-2.75, 1.2, -3.93)
    panel.castShadow = true
    panel.receiveShadow = true
    this.scene.add(panel)
    this.objects.set('door_01', panel)
    const handle = new Mesh(
      new CylinderGeometry(0.03, 0.03, 0.14, 12),
      this.material('#c9a45c', { metalness: 0.55, roughness: 0.4 }),
    )
    handle.position.set(0.62, 0.95, 0.02)
    panel.add(handle)
    this.box('door-jamb', new Vector3(-2.8, 1.2, -3.99), new Vector3(0.9, 2.05, 0.06), '#241c17')
  }
}

function roundNumber(value: number): number {
  return Math.round(value * 1000) / 1000
}

function radToRoundedDegrees(value: number): number {
  return roundNumber(value * 180 / Math.PI)
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
