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
import { loadModel } from './loaders/loadModel'
import {
  DEFAULT_PROCEDURAL_TUNING,
  ProceduralLocomotion,
  type ProceduralTuning,
} from './locomotion/ProceduralLocomotion'
import { ArdyMotionSource, type ArdyMotionState, type ArdyTelemetry } from './motion/ArdyMotionSource'
import { RoomNavigation } from './navigation/RoomNavigation'
import { AvatarRig } from './rig/AvatarRig'
import roomManifest from './room/roomObjects.json'
import type { RoomObjectDefinition } from './types'
import { VisemeController } from './voice/VisemeController'

export type CameraMode = 'room' | 'follow' | 'portrait'
export type MotionPreview = 'idle' | 'crouch' | 'kick-left' | 'kick-right' | 'balance-left' | 'balance-right' | 'jumping-jacks' | 'jump' | 'bend' | 'walk'

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
  private readonly navigation = new RoomNavigation({ minX: -3.65, maxX: 3.65, minZ: -3.65, maxZ: 3.65 }, 0.22)
  private readonly face = new FaceController()
  private readonly visemes = new VisemeController()
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
  private skeletonHelper: SkeletonHelper | null = null
  private frame = 0
  private destroyed = false
  private reducedMotion = false
  private readonly contextAbort = new AbortController()
  private cameraMode: CameraMode = 'room'
  private motionPreview: MotionPreview = 'idle'
  private motionPreviewStartedAt = 0
  private frameRate = 0
  private smoothedFrameTime = 0

  constructor(
    private readonly container: HTMLElement,
    private readonly vrmUrl: string,
  ) {
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

    this.seedRoom()
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
    this.face.applyIntent({ face: { expression: 'relaxed', intensity: 0.25, talking: false } })
    this.resize()
    this.setCameraMode('room')
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

  getArdyState(): ArdyMotionState {
    return this.ardySource?.state ?? 'offline'
  }

  /** EMB-1: latency/buffer/reconnect telemetry for the debug overlay. */
  getArdyTelemetry(): ArdyTelemetry | null {
    return this.ardySource?.getTelemetry() ?? null
  }

  /** Hips bone world-space Y (ARDY E2E probe; null when no rig/bone). */
  getHipsWorldY(): number | null {
    const bone = this.rig?.getBone('hips')
    if (!bone) return null
    return bone.getWorldPosition(this.diagnosticVector).y
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
  } | null {
    const humanoid = this.rig?.vrm?.humanoid
    if (!this.rig || !humanoid) return null
    const bones: Record<string, [number, number, number, number] | null> = {}
    for (const name of boneNames) {
      const q = humanoid.getNormalizedBoneNode(name as any)?.quaternion
      bones[name] = q ? [q.x, q.y, q.z, q.w] : null
    }
    return {
      x: this.rig.scene.position.x,
      z: this.rig.scene.position.z,
      yaw: this.rig.scene.rotation.y,
      bones,
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

    // Stop animation loop
    cancelAnimationFrame(this.frame)

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

  private obstacle(id: string, position: Vector3, size: Vector3, padding = 0.1): void {
    this.navigation.addBoxObstacle(id, position, size, padding)
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
    this.cylinder('coffee-mug', new Vector3(0.2, 0.4, 1.15), 0.045, 0.04, 0.1, '#eeeeee')
    this.obstacle('couch', new Vector3(0, 0, 2.28), new Vector3(2.85, 0.7, 1))
    this.obstacle('coffee-table', new Vector3(0, 0, 1.15), new Vector3(1.45, 0.35, 0.82))
  }

  private addCommandZone(): void {
    this.box('walnut-credenza', new Vector3(-3.63, 0.55, -1.35), new Vector3(0.42, 0.74, 2.8), '#2f1f15', { roughness: 0.54 })
    this.box('workstation', new Vector3(-3.83, 1.38, -1.35), new Vector3(0.06, 0.86, 1.42), '#101821', { emissive: '#1d8cff', intensity: 0.28, roughness: 0.35 })
    for (const z of [-2.28, -1.98, -1.68]) this.box(`server-slot-${z}`, new Vector3(-3.86, 0.67, z), new Vector3(0.045, 0.065, 0.18), '#69f0ff', { emissive: '#69f0ff', intensity: 0.9 })
    this.box('server-panel', new Vector3(-3.84, 0.9, -0.45), new Vector3(0.055, 1.1, 0.7), '#182533', { emissive: '#2dd4bf', intensity: 0.2 })
    this.cylinder('desk-stool', new Vector3(-2.9, 0.32, -0.35), 0.28, 0.24, 0.62, '#242938')
    this.obstacle('command-zone', new Vector3(-3.5, 0, -1.35), new Vector3(0.7, 0.8, 2.95))
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
    this.obstacle('kitchen', new Vector3(2.18, 0, -3.48), new Vector3(1.82, 0.6, 0.7))
  }

  private addResetChamber(): void {
    this.box('daybed-base', new Vector3(2.75, 0.28, 1.9), new Vector3(1.55, 0.36, 1.05), '#2a2f3d')
    this.box('daybed-linen', new Vector3(2.75, 0.52, 1.9), new Vector3(1.42, 0.16, 0.92), '#d3c3ae')
    this.box('weighted-blanket', new Vector3(2.98, 0.64, 1.92), new Vector3(0.82, 0.14, 0.88), '#6f5364')
    this.box('pillow-a', new Vector3(2.18, 0.71, 2.26), new Vector3(0.34, 0.18, 0.32), '#eee0cc')
    this.box('pillow-b', new Vector3(2.56, 0.72, 2.27), new Vector3(0.34, 0.18, 0.32), '#b9907f')
    this.obstacle('daybed', new Vector3(2.75, 0, 1.9), new Vector3(1.75, 0.45, 1.25))
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
