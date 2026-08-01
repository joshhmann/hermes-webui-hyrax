/**
 * ArdyMotionSource — P4 live integration of the ARDY motion stream into the
 * Synthesis Loft.
 *
 * Owns the full pipeline behind one per-frame entry point:
 *
 *   ArdyClient (WS) → ChunkBuffer → PlaybackClock → PoseSampler
 *     → CanonicalRetargeter (normalized VRM bones)
 *     → RootMotionAdapter (Phase 5: nav-approved XZ/yaw on the AvatarRoot,
 *       bounded residual + scaled Y on the hips bone)
 *
 * Health model: 'connecting' | 'live' | 'stale' | 'offline'. update(dt)
 * returns true only on frames where this source wrote the pose, so
 * TaiRoomScene can keep ProceduralLocomotion and this source mutually
 * exclusive per frame (the pose-ownership audit flags double writes).
 * Transitions ramp a 0.3 s crossfade — retargeted quats are blended with
 * node.quaternion.slerp(target, weight) semantics, never hard-cut.
 *
 * Reconnect is a FULL session reset (ARDY §4.4): clock re-anchor, retarget
 * re-anchor, exponential backoff.
 *
 * Retarget path: when the calibration profile (default tai-embodiment-v3.json,
 * the user-validated profile shared with the debug page) loads, the stream is
 * retargeted by ProfiledLiveRetargeter — AvatarRetargeter semantics. Rest
 * offsets come from the profile's embedded canonical source rest
 * (rest_pose.source_rest, the settled capture-tpose T-pose — the live stream
 * has no T-pose settle of its own), measured after a resetNormalizedPose();
 * profiles without source_rest fall back to measuring settled stream frame 20.
 * When the profile fetch/init fails the source falls back to the gestalt-motion
 * CanonicalRetargeter (previous behavior) rather than breaking the loft.
 */
import { Quaternion, Vector3 } from 'three'

import { ArdyClient } from 'gestalt-motion/ArdyClient.ts'
import type { ArdyClientCallbacks } from 'gestalt-motion/ArdyClient.ts'
import { SampleState } from 'gestalt-motion/ChunkBuffer.ts'
import type { ChunkBuffer, FrameRef } from 'gestalt-motion/ChunkBuffer.ts'
import { PlaybackClock } from 'gestalt-motion/PlaybackClock.ts'
import { PoseSampler } from 'gestalt-motion/PoseSampler.ts'
import type { SampledPose } from 'gestalt-motion/PoseSampler.ts'
import { createCanonicalRetargeter } from 'gestalt-motion/CanonicalRetargeter.ts'
import type { CanonicalRetargeter } from 'gestalt-motion/CanonicalRetargeter.ts'
import { RootMotionAdapter } from 'gestalt-motion/RootMotionAdapter.ts'
import type { NavDelta, NavigationInterface } from 'gestalt-motion/RootMotionAdapter.ts'
import { selectAdapter } from 'gestalt-motion/adapters/registry.ts'
import { loadProfile } from 'gestalt-motion/profile.ts'
import type { SkeletonContract, Vec3 } from 'gestalt-motion/canonical.ts'
import { qmul, qnormalize, qyaw } from 'gestalt-motion/quat.ts'
import type { Object3DLike, VrmLike } from 'gestalt-motion/vrmLike.ts'
import { wrapThreeVrm } from 'gestalt-motion/threeAdapter.ts'

import { ProfiledLiveRetargeter } from './ProfiledLiveRetargeter.ts'
import type { AvatarRetargeterProfile } from '../../../calibrate/AvatarRetargeter.js'
import type { AvatarRig } from '../rig/AvatarRig'
import type { RoomNavigation } from '../navigation/RoomNavigation'

export type ArdyMotionState = 'connecting' | 'live' | 'stale' | 'offline'

const DEFAULT_ARDY_PATH = '/api/hyrax/ardy/ws'
const DEFAULT_PROFILE_PATH = '/api/hyrax/3d/calibrate/calibration-profiles/tai-embodiment-v3.json'
const DEFAULT_INITIAL_PROMPT = 'a person stands idle'
const CROSSFADE_SECONDS = 0.3
const INITIAL_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 10000
const RESET_COOLDOWN_MS = 2000

/**
 * Profile fetch cache (one profile for the whole loft lifetime; shared across
 * reconnects and ArdyMotionSource instances). Fetch failure resolves to null
 * — the caller falls back to the gestalt-motion retarget path.
 */
const profileCache = new Map<string, Promise<unknown | null>>()
function fetchProfile(url: string): Promise<unknown | null> {
  let cached = profileCache.get(url)
  if (cached === undefined) {
    cached = (async () => {
      try {
        const response = await fetch(url)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return (await response.json()) as unknown
      } catch (error) {
        console.warn(
          `[ardy] calibration profile fetch failed (${url}): ${String(error)} — ` +
          'falling back to gestalt-motion retarget',
        )
        return null
      }
    })()
    profileCache.set(url, cached)
  }
  return cached
}

/** Structural subset of ArdyClient so tests can inject a mock (no real WS). */
export interface ArdyClientLike {
  readonly buffer: ChunkBuffer
  readonly connected: boolean
  connect(url: string): void
  disconnect(): void
  reconnect(): void
  sendPrompt(text: string): void
  sendReset(): void
}

/** Structural subset of AvatarRig used by this source. */
export interface ArdyRigLike {
  scene: { position: { x: number; z: number } }
  setRootPosition(x: number, z: number): void
  setFacingYaw(yaw: number): void
  markPoseWrite(): void
}

/** Structural subset of RoomNavigation used by RoomNavigationApproval. */
export interface ArdyNavigationLike {
  constrainMovement(from: Vector3, to: Vector3): { position: { x: number; z: number } }
}

/**
 * gestalt-motion NavigationInterface over the loft's RoomNavigation:
 * proposed planar deltas are collision/bounds-checked via constrainMovement
 * and only the approved portion is reported back. Tracks the approved
 * position so absolute clamping works on deltas; reset() re-syncs it with
 * the RootMotionAdapter's anchor (stream start / full session reset).
 */
export class RoomNavigationApproval implements NavigationInterface {
  private x = 0
  private z = 0
  private readonly navigation: ArdyNavigationLike

  constructor(navigation: ArdyNavigationLike) {
    this.navigation = navigation
  }

  reset(x: number, z: number): void {
    this.x = x
    this.z = z
  }

  approve(deltaXZ: [number, number], deltaYaw: number): NavDelta {
    const from = new Vector3(this.x, 0, this.z)
    const to = new Vector3(this.x + deltaXZ[0], 0, this.z + deltaXZ[1])
    const resolved = this.navigation.constrainMovement(from, to)
    this.x = resolved.position.x
    this.z = resolved.position.z
    return { deltaXZ: [this.x - from.x, this.z - from.z], deltaYaw }
  }
}

export interface ArdyMotionSourceOptions {
  rig: AvatarRig
  navigation: RoomNavigation
  /** WS URL; defaults to ?ardyWs= or the same-origin WebUI proxy (/api/hyrax/ardy/ws). */
  url?: string
  /** Test seam: mock client factory (avoids a real WebSocket). */
  clientFactory?: (callbacks: ArdyClientCallbacks) => ArdyClientLike
  /** Test seam: mock VrmLike factory (avoids real three-vrm objects). */
  vrmLikeFactory?: () => VrmLike | null
  /**
   * Prompt sent right after each skeleton handshake. The service's producer
   * idles until the FIRST prompt arrives (gestalt-ardy-service session.py),
   * so without a kick-off prompt no chunks ever flow.
   */
  initialPrompt?: string
  /** Wall clock override for the PlaybackClock (tests). */
  nowMs?: () => number
  /** Set false to construct without connecting. Default: connect when the avatar has a VRM humanoid. */
  autoConnect?: boolean
  /**
   * Calibration profile URL (served by the WebUI). Defaults to the validated
   * tai-embodiment-v3 profile. Null disables the profiled path entirely
   * (always gestalt-motion retarget semantics).
   */
  profileUrl?: string | null
  /** Test seam: profile fetch override. Resolve null or reject → gestalt fallback. */
  profileFetcher?: (url: string) => Promise<unknown>
}

function defaultUrl(): string {
  if (typeof window !== 'undefined') {
    const override = new URLSearchParams(window.location.search).get('ardyWs')
    if (override) return override
    // Same-origin WebUI proxy: browsers off the LAN (Tailscale/cellular)
    // cannot reach the upstream's private IP directly.
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
    return `${scheme}://${window.location.host}${DEFAULT_ARDY_PATH}`
  }
  return DEFAULT_ARDY_PATH
}

export class ArdyMotionSource {
  private readonly rig: ArdyRigLike
  private readonly url: string
  private readonly client: ArdyClientLike
  private readonly clock: PlaybackClock
  private readonly approval: RoomNavigationApproval
  private readonly vrmLikeFactory: () => VrmLike | null
  private readonly nowMs: () => number
  private retargeter: CanonicalRetargeter | null = null
  private profiled: ProfiledLiveRetargeter | null = null
  private rootMotion: RootMotionAdapter | null = null
  private jointCount = 0
  private blendBones: Object3DLike[] = []
  private hipsNode: Object3DLike | null = null
  private blendWeight = 0
  private needsAnchor = true
  private originOffset: [number, number] = [0, 0]
  private lastSample: SampledPose | null = null
  private everOpened = false
  private disposed = false
  private backoffMs = INITIAL_BACKOFF_MS
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private suppressNextClose = false
  private lastResetSentAtMs = -Infinity
  private lastPrompt: string | null = null
  private readonly initialPrompt: string
  private readonly profileReady: Promise<unknown | null>
  private buildSeq = 0
  private currentState: ArdyMotionState = 'connecting'
  private readonly slerpFrom = new Quaternion()
  private readonly slerpTo = new Quaternion()

  constructor(options: ArdyMotionSourceOptions) {
    this.rig = options.rig
    this.url = options.url ?? defaultUrl()
    this.nowMs = options.nowMs ?? (() => performance.now())
    this.initialPrompt = options.initialPrompt ?? DEFAULT_INITIAL_PROMPT
    this.clock = new PlaybackClock({ nowMs: this.nowMs })
    this.approval = new RoomNavigationApproval(options.navigation)
    this.vrmLikeFactory = options.vrmLikeFactory ?? (() => {
      const vrm = options.rig.vrm
      // The cast bridges the two @types/three copies (hyrax-3d 0.170 vs
      // gestalt-motion's dev copy); the wrapper is structural at runtime.
      return vrm ? wrapThreeVrm(vrm as unknown as Parameters<typeof wrapThreeVrm>[0]) : null
    })

    const profileUrl = options.profileUrl === undefined ? DEFAULT_PROFILE_PATH : options.profileUrl
    this.profileReady = profileUrl === null
      ? Promise.resolve(null)
      : options.profileFetcher !== undefined
        ? options.profileFetcher(profileUrl).then((p) => p ?? null).catch((error) => {
            console.warn(`[ardy] calibration profile fetch failed: ${String(error)} — falling back to gestalt-motion retarget`)
            return null
          })
        : fetchProfile(profileUrl)

    const callbacks: ArdyClientCallbacks = {
      onOpen: () => {
        this.everOpened = true
        this.backoffMs = INITIAL_BACKOFF_MS
        this.currentState = 'connecting'
      },
      onClose: (reason) => {
        if (this.disposed) return
        if (this.suppressNextClose) {
          this.suppressNextClose = false
          return
        }
        console.warn(`[ardy] connection closed: ${reason}`)
        this.clock.notifyReset()
        this.currentState = 'offline'
        this.scheduleReconnect()
      },
      onError: (message) => {
        console.warn(`[ardy] ${message}`)
      },
      onSkeleton: (contract) => {
        this.buildRetargeter(contract)
      },
    }
    this.client = options.clientFactory
      ? options.clientFactory(callbacks)
      : new ArdyClient({ callbacks })

    // No VRM humanoid → the stream can never be retargeted; stay offline
    // instead of opening a doomed socket (also keeps non-VRM test fakes inert).
    const autoConnect = options.autoConnect ?? Boolean(options.rig.vrm?.humanoid)
    if (autoConnect) {
      try {
        this.client.connect(this.url)
      } catch (error) {
        console.warn(`[ardy] connect failed: ${String(error)}`)
        this.currentState = 'offline'
        this.scheduleReconnect()
      }
    } else {
      this.currentState = 'offline'
    }
  }

  get state(): ArdyMotionState {
    return this.currentState
  }

  isLive(): boolean {
    return this.currentState === 'live'
  }

  setPrompt(text: string): void {
    const trimmed = text.trim()
    if (!trimmed || this.disposed) return
    this.lastPrompt = trimmed
    this.client.sendPrompt(trimmed)
  }

  /**
   * Per-frame step. Returns true when this source wrote the pose this frame
   * (caller must NOT run ProceduralLocomotion on those frames).
   */
  update(dt: number): boolean {
    if (this.disposed) return false
    const buffer = this.client.buffer
    if (buffer.resetPending) {
      // A reset chunk dropped the buffered stream (§5). Re-anchor the clock
      // and the root-motion state at the avatar's current position — the new
      // stream's origin is a teleport acceptance, not a divergence.
      buffer.resetPending = false
      this.clock.notifyReset()
      this.needsAnchor = true
      this.profiled?.resetFeed()
    }
    this.clock.update(buffer)

    let sampleState: SampleState = SampleState.BUFFERING
    let pose: SampledPose | null = null
    let frameA: FrameRef | null = null
    const t = this.clock.now()
    if (t !== null && (this.retargeter !== null || this.profiled !== null) && this.jointCount > 0) {
      const result = buffer.sample(t)
      sampleState = result.state
      if (
        (result.state === SampleState.OK || result.state === SampleState.GAP_HOLD) &&
        result.a !== null
      ) {
        frameA = result.a
        pose = PoseSampler.sample(result.a, result.b, result.alpha, this.jointCount)
        buffer.dropPlayed(result.a.frameSeq)
      }
    }

    this.currentState = this.resolveState(sampleState)

    if (pose !== null && frameA !== null && this.profiled !== null && !this.profiled.calibrated) {
      // Profiled path: measure the source rest from the settled idle stream
      // (frame ~20) before writing any poses — until calibration completes,
      // ProceduralLocomotion keeps the rig (update() returns false).
      try {
        this.profiled.feedFrame(frameA)
      } catch (error) {
        console.warn(`[ardy] profiled calibration failed: ${String(error)} — falling back to gestalt-motion retarget`)
        this.profiled = null
        this.buildGestaltRetargeter()
      }
      if (this.profiled?.calibrated) this.finishProfiledCalibration()
      pose = null
    }
    if (pose !== null) this.lastSample = pose

    const ramp = (this.currentState === 'live' ? dt : -dt) / CROSSFADE_SECONDS
    this.blendWeight = Math.min(1, Math.max(0, this.blendWeight + ramp))

    if (
      this.blendWeight <= 0 ||
      !this.posingReady() ||
      this.rootMotion === null ||
      this.lastSample === null
    ) {
      return false
    }
    this.applySampled(this.lastSample, this.blendWeight)
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.client.disconnect()
  }

  // ── internals ──────────────────────────────────────────────────────

  private resolveState(sampleState: SampleState): ArdyMotionState {
    if (!this.client.connected) return this.everOpened ? 'offline' : 'connecting'
    if (!this.posingReady()) return 'connecting'
    if (sampleState === SampleState.OK || sampleState === SampleState.GAP_HOLD) return 'live'
    if (sampleState === SampleState.STALE) return 'stale'
    return 'connecting'
  }

  /** True once a retarget path is fully ready to write poses (for the
   * profiled path: after settled-frame calibration completes). */
  private posingReady(): boolean {
    return this.retargeter !== null || (this.profiled?.calibrated ?? false)
  }

  private buildRetargeter(contract: SkeletonContract): void {
    const seq = ++this.buildSeq
    this.retargeter = null
    this.profiled = null
    this.rootMotion = null
    this.jointCount = 0
    void (async () => {
      let vrmLike: VrmLike | null = null
      try {
        vrmLike = this.vrmLikeFactory()
      } catch (error) {
        console.warn(`[ardy] retargeter init failed: ${String(error)}`)
        this.currentState = 'offline'
        return
      }
      if (vrmLike === null) {
        console.warn('[ardy] avatar has no VRM humanoid; motion stream unusable')
        this.currentState = 'offline'
        return
      }
      const profile = await this.profileReady
      if (this.disposed || seq !== this.buildSeq) return // stale: reconnect re-handshook
      this.lastContract = contract
      this.lastVrmLike = vrmLike
      let path = '1.0'
      let hipsScale = 0
      if (profile !== null) {
        try {
          // EMB-2 fail-closed profile gate: unknown semantic keys,
          // unsupported profile_version/semantic_version throw here and the
          // source falls back to the adapter-driven gestalt-motion path.
          loadProfile(profile)
          this.profiled = new ProfiledLiveRetargeter(
            contract,
            vrmLike,
            profile as AvatarRetargeterProfile,
          )
          path = 'profiled'
        } catch (error) {
          console.warn(`[ardy] profiled retarget init failed: ${String(error)} — falling back to gestalt-motion`)
          this.profiled = null
        }
      }
      if (this.profiled !== null && this.profiled.calibrated) {
        // The profile embedded its canonical source rest: calibration already
        // completed in the ProfiledLiveRetargeter constructor — wire the pose
        // path immediately (no settled-frame wait).
        this.finishProfiledCalibration()
      }
      if (this.profiled === null) {
        if (!this.buildGestaltRetargeter(contract, vrmLike)) return
        path = this.retargeterPath
        hipsScale = this.retargeter!.hipsScale
      }
      this.jointCount = contract.joint_names.length
      this.needsAnchor = true
      console.info(
        `[ardy] retargeter ready (path ${path}` +
        (this.profiled !== null
          ? this.profiled.calibrated
            ? ''
            : `, calibrating over settled stream frame ${this.profiled.restFrame}`
          : `, hipsScale ${hipsScale.toFixed(3)}`) +
        ')',
      )
      // Kick off generation: the service idles until the first prompt, and a
      // fresh session (reconnect) has forgotten any earlier one.
      this.client.sendPrompt(this.lastPrompt ?? this.initialPrompt)
    })()
  }

  /**
   * Build the gestalt-motion CanonicalRetargeter (pre-profile behavior;
   * fallback when the calibration profile is unavailable). Returns false on
   * failure (source goes offline).
   */
  private buildGestaltRetargeter(contract?: SkeletonContract, vrmLike?: VrmLike): boolean {
    // Calibration-failure fallback mid-stream: reuse the live contract/VRM.
    const c = contract ?? this.lastContract
    const v = vrmLike ?? this.lastVrmLike
    if (c === null || v === null) return false
    try {
      // EMB-2: the contract's skeleton_id selects the source adapter
      // (fail-closed: unknown skeletons throw here and the source goes
      // offline rather than guessing). The retargeter consumes semantic
      // joints only.
      const built = createCanonicalRetargeter(selectAdapter(c), v)
      this.retargeter = built.retargeter
      this.retargeterPath = built.path
      this.jointCount = c.joint_names.length
      // Phase 5 seam: hips scale comes from calibration (§2.2.4).
      this.rootMotion = new RootMotionAdapter(this.approval, {
        hipsScale: built.retargeter.hipsScale,
      })
      this.blendBones = []
      for (const semantic of built.retargeter.mappedBones) {
        const node = v.humanoid.getNormalizedBoneNode(semantic)
        if (node) this.blendBones.push(node)
      }
      this.hipsNode = v.humanoid.getNormalizedBoneNode('hips') ?? null
      this.needsAnchor = true
      return true
    } catch (error) {
      console.warn(`[ardy] retargeter init failed: ${String(error)}`)
      this.retargeter = null
      this.rootMotion = null
      this.currentState = 'offline'
      return false
    }
  }

  private lastContract: SkeletonContract | null = null
  private lastVrmLike: VrmLike | null = null
  private retargeterPath = '1.0'

  /** Calibration complete: wire the profiled retargeter into the pose path. */
  private finishProfiledCalibration(): void {
    const profiled = this.profiled!
    this.rootMotion = new RootMotionAdapter(this.approval, {
      hipsScale: profiled.hipsScale,
    })
    this.blendBones = profiled.blendBones
    this.hipsNode = profiled.hipsNode
    this.needsAnchor = true
    console.info(
      `[ardy] profiled retarget calibrated (rest frame ${profiled.restFrame}, ` +
      `hipsScale ${profiled.hipsScale.toFixed(3)})`,
    )
  }

  private applySampled(sample: SampledPose, weight: number): void {
    const rootMotion = this.rootMotion!

    if (this.needsAnchor) {
      // Map the stream's starting point onto the avatar's current spot so a
      // session start never teleports her across the room (the host owns the
      // world transform; ARDY root positions are proposals, §3.1).
      this.originOffset = [
        this.rig.scene.position.x - sample.rootPos[0],
        this.rig.scene.position.z - sample.rootPos[2],
      ]
      const anchored: Vec3 = [
        sample.rootPos[0] + this.originOffset[0],
        sample.rootPos[1],
        sample.rootPos[2] + this.originOffset[1],
      ]
      rootMotion.anchor(anchored, qyaw(sample.rootQuat))
      this.approval.reset(anchored[0], anchored[2])
      this.needsAnchor = false
    }

    const proposed: Vec3 = [
      sample.rootPos[0] + this.originOffset[0],
      sample.rootPos[1],
      sample.rootPos[2] + this.originOffset[1],
    ]
    const out = rootMotion.update(proposed, sample.rootQuat)

    // Navigation owns the AvatarRoot XZ + yaw; hips bone carries only the
    // bounded residual plus scaled vertical (RootMotionAdapter §3.1).
    this.rig.setRootPosition(out.sceneRootPos[0], out.sceneRootPos[2])
    this.rig.setFacingYaw(out.sceneRootYaw)

    if (out.resetRequested && this.nowMs() - this.lastResetSentAtMs > RESET_COOLDOWN_MS) {
      // Proposed/approved divergence > 0.3 m: clamp residual (already done by
      // the adapter — no snap) and ask the service to restart the stream (§3.3).
      this.lastResetSentAtMs = this.nowMs()
      console.warn('[ardy] root residual exceeded clamp; requesting stream reset')
      this.client.sendReset()
      this.clock.notifyReset()
      this.needsAnchor = true
    }

    // Yaw decomposition (resolves UNRESOLVED-07): the scene root carries the
    // approved yaw, so the hips bone must NOT also carry it — otherwise yaw
    // is applied twice and the body progressively twists ("exorcist") as the
    // stream turns. Strip the approved yaw from the pelvis orientation:
    // hipsLocal = yawQuat(-sceneRootYaw) ⊗ pelvisGlobal. Hips is joint 0 with
    // parent -1, so its local rotation IS its global rotation.
    const halfYaw = -out.sceneRootYaw / 2
    const yawStrip: [number, number, number, number] = [Math.cos(halfYaw), 0, Math.sin(halfYaw), 0]
    const localRots = sample.localRots.slice()
    const hipsQ: [number, number, number, number] = [localRots[0]!, localRots[1]!, localRots[2]!, localRots[3]!]
    const stripped = qnormalize(qmul(yawStrip, hipsQ))
    localRots[0] = stripped[0]
    localRots[1] = stripped[1]
    localRots[2] = stripped[2]
    localRots[3] = stripped[3]

    if (weight >= 0.999 || this.blendBones.length === 0) {
      this.writePose(localRots, out.hipsPos, sample.contacts)
    } else {
      // Crossfade: read current bone quats, write retargeted targets, then
      // slerp each bone from its previous value toward the target by weight.
      const previous = this.blendBones.map((node) => ({
        x: node.quaternion.x,
        y: node.quaternion.y,
        z: node.quaternion.z,
        w: node.quaternion.w,
      }))
      const previousHips = this.hipsNode
        ? { x: this.hipsNode.position.x, y: this.hipsNode.position.y, z: this.hipsNode.position.z }
        : null
      this.writePose(localRots, out.hipsPos, sample.contacts)
      for (let i = 0; i < this.blendBones.length; i += 1) {
        const node = this.blendBones[i]!
        const prev = previous[i]!
        this.slerpFrom.set(prev.x, prev.y, prev.z, prev.w)
        this.slerpTo.set(node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w)
        this.slerpFrom.slerp(this.slerpTo, weight)
        node.quaternion.x = this.slerpFrom.x
        node.quaternion.y = this.slerpFrom.y
        node.quaternion.z = this.slerpFrom.z
        node.quaternion.w = this.slerpFrom.w
      }
      if (this.hipsNode && previousHips) {
        this.hipsNode.position.x = previousHips.x + (this.hipsNode.position.x - previousHips.x) * weight
        this.hipsNode.position.y = previousHips.y + (this.hipsNode.position.y - previousHips.y) * weight
        this.hipsNode.position.z = previousHips.z + (this.hipsNode.position.z - previousHips.z) * weight
      }
    }
    this.rig.markPoseWrite()
  }

  /** Dispatch the yaw-stripped pose to the active retarget path. */
  private writePose(localRots: Float32Array, hipsPos: Vec3, contacts: number): void {
    if (this.profiled !== null && this.profiled.calibrated) {
      this.profiled.applyPose(localRots, hipsPos, contacts)
    } else {
      this.retargeter!.applyPose(localRots, { hipsPosition: hipsPos })
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) return
    const delay = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.disposed) return
      // Full session reset (§4.4): new session, re-handshake, re-anchor.
      this.clock.notifyReset()
      this.needsAnchor = true
      this.currentState = 'connecting'
      this.suppressNextClose = true
      try {
        this.client.reconnect()
      } catch (error) {
        this.suppressNextClose = false
        console.warn(`[ardy] reconnect failed: ${String(error)}`)
        this.currentState = 'offline'
        this.scheduleReconnect()
      }
    }, delay)
  }
}
