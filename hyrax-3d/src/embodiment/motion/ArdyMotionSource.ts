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
 */
import { Quaternion, Vector3 } from 'three'

import { ArdyClient } from 'gestalt-motion/ArdyClient.ts'
import type { ArdyClientCallbacks } from 'gestalt-motion/ArdyClient.ts'
import { SampleState } from 'gestalt-motion/ChunkBuffer.ts'
import type { ChunkBuffer } from 'gestalt-motion/ChunkBuffer.ts'
import { PlaybackClock } from 'gestalt-motion/PlaybackClock.ts'
import { PoseSampler } from 'gestalt-motion/PoseSampler.ts'
import type { SampledPose } from 'gestalt-motion/PoseSampler.ts'
import { createCanonicalRetargeter } from 'gestalt-motion/CanonicalRetargeter.ts'
import type { CanonicalRetargeter } from 'gestalt-motion/CanonicalRetargeter.ts'
import { RootMotionAdapter } from 'gestalt-motion/RootMotionAdapter.ts'
import type { NavDelta, NavigationInterface } from 'gestalt-motion/RootMotionAdapter.ts'
import { MAPPED_BONES } from 'gestalt-motion/boneMap.ts'
import type { SkeletonContract, Vec3 } from 'gestalt-motion/canonical.ts'
import { qmul, qnormalize, qyaw } from 'gestalt-motion/quat.ts'
import type { Object3DLike, VrmLike } from 'gestalt-motion/vrmLike.ts'
import { wrapThreeVrm } from 'gestalt-motion/threeAdapter.ts'

import type { AvatarRig } from '../rig/AvatarRig'
import type { RoomNavigation } from '../navigation/RoomNavigation'

export type ArdyMotionState = 'connecting' | 'live' | 'stale' | 'offline'

const DEFAULT_ARDY_URL = 'ws://192.168.0.17:8791/ws'
const DEFAULT_INITIAL_PROMPT = 'a person stands idle'
const CROSSFADE_SECONDS = 0.3
const INITIAL_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 10000
const RESET_COOLDOWN_MS = 2000

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
  /** WS URL; defaults to ?ardyWs= or ws://192.168.0.17:8791/ws. */
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
}

function defaultUrl(): string {
  if (typeof window !== 'undefined') {
    const override = new URLSearchParams(window.location.search).get('ardyWs')
    if (override) return override
  }
  return DEFAULT_ARDY_URL
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
    }
    this.clock.update(buffer)

    let sampleState: SampleState = SampleState.BUFFERING
    let pose: SampledPose | null = null
    const t = this.clock.now()
    if (t !== null && this.retargeter !== null && this.jointCount > 0) {
      const result = buffer.sample(t)
      sampleState = result.state
      if (
        (result.state === SampleState.OK || result.state === SampleState.GAP_HOLD) &&
        result.a !== null
      ) {
        pose = PoseSampler.sample(result.a, result.b, result.alpha, this.jointCount)
        buffer.dropPlayed(result.a.frameSeq)
      }
    }

    this.currentState = this.resolveState(sampleState)
    if (pose !== null) this.lastSample = pose

    const ramp = (this.currentState === 'live' ? dt : -dt) / CROSSFADE_SECONDS
    this.blendWeight = Math.min(1, Math.max(0, this.blendWeight + ramp))

    if (
      this.blendWeight <= 0 ||
      this.retargeter === null ||
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
    if (this.retargeter === null) return 'connecting'
    if (sampleState === SampleState.OK || sampleState === SampleState.GAP_HOLD) return 'live'
    if (sampleState === SampleState.STALE) return 'stale'
    return 'connecting'
  }

  private buildRetargeter(contract: SkeletonContract): void {
    try {
      const vrmLike = this.vrmLikeFactory()
      if (vrmLike === null) {
        console.warn('[ardy] avatar has no VRM humanoid; motion stream unusable')
        this.currentState = 'offline'
        return
      }
      const built = createCanonicalRetargeter(contract, vrmLike)
      this.retargeter = built.retargeter
      this.jointCount = contract.joint_names.length
      // Phase 5 seam: hips scale comes from calibration (§2.2.4).
      this.rootMotion = new RootMotionAdapter(this.approval, {
        hipsScale: built.retargeter.hipsScale,
      })
      this.blendBones = []
      for (const entry of MAPPED_BONES) {
        if (entry.vrmBone === null) continue
        const node = vrmLike.humanoid.getNormalizedBoneNode(entry.vrmBone)
        if (node) this.blendBones.push(node)
      }
      this.hipsNode = vrmLike.humanoid.getNormalizedBoneNode('hips') ?? null
      this.needsAnchor = true
      console.info(
        `[ardy] retargeter ready (path ${built.path}, hipsScale ${built.retargeter.hipsScale.toFixed(3)})`,
      )
      // Kick off generation: the service idles until the first prompt, and a
      // fresh session (reconnect) has forgotten any earlier one.
      this.client.sendPrompt(this.lastPrompt ?? this.initialPrompt)
    } catch (error) {
      console.warn(`[ardy] retargeter init failed: ${String(error)}`)
      this.retargeter = null
      this.rootMotion = null
      this.currentState = 'offline'
    }
  }

  private applySampled(sample: SampledPose, weight: number): void {
    const retargeter = this.retargeter!
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
      retargeter.applyPose(localRots, { hipsPosition: out.hipsPos })
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
      retargeter.applyPose(localRots, { hipsPosition: out.hipsPos })
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
