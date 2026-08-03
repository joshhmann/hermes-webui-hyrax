/**
 * SelfCollision — bounded capsule push-out for the loft avatar (spatial
 * layer: self-collision, option 1).
 *
 * The retarget is blind to the avatar's own body: a stream frame can put a
 * hand through the chest or a forearm through the head. This module runs
 * AFTER the retarget write as a bounded correction:
 *
 *   ~7 static capsules (torso, chest, head, upper arms, thighs — derived
 *   from the VRM normalized skeleton: segment lengths from pose-invariant
 *   local bone offsets, radii as data) are auto-positioned from bone world
 *   transforms each frame, and the hands + forearms (the visible 80%:
 *   hand-through-chest, arm-through-head) are checked against them.
 *
 * Correction: the offending joint (elbow, then shoulder — the target's own
 * chain) is rotated along the shortest escape direction, bounded to
 * MAX_STEP_DEG per frame and MAX_TOTAL_DEG per joint (budget recovers when
 * not correcting), so a bad stream frame can't explode the pose. If a
 * penetration is unresolvable within budget, it is LEFT — fail-open is
 * correct here: clipping beats a broken pose.
 *
 * No physics engine, no allocations in the per-frame hot path (all temps
 * are preallocated fields; debug report() may allocate), no bone-ownership
 * fight: the retarget re-writes the pose every frame and this nudges the
 * result afterward. Pure tuple math (xyzw quaternions, matching the
 * three.js layout the bones carry) so tests run on tiny FK fakes.
 */
import type { Object3DLike, VrmLike } from 'gestalt-motion/vrmLike.ts'

// ── Config (policy as data) ─────────────────────────────────────────

export const SELF_COLLISION_CONFIG = {
  /** Master toggle (also live-toggleable via __ardy.setSelfCollision). */
  ENABLED: true,
  /** Correction gain: fraction of the escape distance applied per frame. */
  GAIN: 1.0,
  /** Penetration below this (m) is ignored (rest-contact hysteresis). */
  EPS_PEN_M: 0.002,
  /** Per-frame correction cap per joint. */
  MAX_STEP_DEG: 5,
  /** Total correction cap per joint (budget recovers when not correcting). */
  MAX_TOTAL_DEG: 15,
  /** Budget recovery rate once a joint has been quiet (no correction). */
  BUDGET_RECOVER_DEG_PER_S: 60,
  /** A joint's budget only recovers after this long without correcting —
   * otherwise sustained penetration would lease unlimited slow drift past
   * MAX_TOTAL_DEG (0.5°/frame forever). The cap applies per episode. */
  BUDGET_QUIET_MS: 300,
  /**
   * Static capsules. Length = |boneB local offset| (pose-invariant);
   * radius = max(radiusFactor × length, minRadius). Capsules whose bones are
   * absent from the rig are skipped (report lists them).
   */
  CAPSULES: [
    { name: 'torso', boneA: 'hips', boneB: 'chest', radiusFactor: 0.6, minRadius: 0.1 },
    { name: 'chest', boneA: 'chest', boneB: 'neck', radiusFactor: 1.0, minRadius: 0.09 },
    { name: 'head', boneA: 'neck', boneB: 'head', radiusFactor: 1.3, minRadius: 0.12 },
    { name: 'leftUpperArm', boneA: 'leftUpperArm', boneB: 'leftLowerArm', radiusFactor: 0.35, minRadius: 0.035 },
    { name: 'rightUpperArm', boneA: 'rightUpperArm', boneB: 'rightLowerArm', radiusFactor: 0.35, minRadius: 0.035 },
    { name: 'leftThigh', boneA: 'leftUpperLeg', boneB: 'leftLowerLeg', radiusFactor: 0.22, minRadius: 0.05 },
    { name: 'rightThigh', boneA: 'rightUpperLeg', boneB: 'rightLowerLeg', radiusFactor: 0.22, minRadius: 0.05 },
  ],
  /**
   * Check targets. chain = joints tried in order to rotate the point out
   * (elbow then shoulder for a hand; shoulder for a forearm).
   * ignoreCapsules: structural self-contacts — a forearm point sits ON its
   * upper-arm capsule endpoint and would read as permanent penetration.
   */
  TARGETS: [
    { name: 'leftHand', bone: 'leftHand', chain: ['leftLowerArm', 'leftUpperArm'], radius: 0.03, ignoreCapsules: [] },
    { name: 'rightHand', bone: 'rightHand', chain: ['rightLowerArm', 'rightUpperArm'], radius: 0.03, ignoreCapsules: [] },
    { name: 'leftForearm', bone: 'leftLowerArm', chain: ['leftUpperArm'], radius: 0.025, ignoreCapsules: ['leftUpperArm'] },
    { name: 'rightForearm', bone: 'rightLowerArm', chain: ['rightUpperArm'], radius: 0.025, ignoreCapsules: ['rightUpperArm'] },
  ],
} as const

export interface SelfCollisionTelemetry {
  enabled: boolean
  /** Corrections applied per second (EMA). */
  correctionsPerSec: number
  /** Lifetime corrections applied. */
  correctionsTotal: number
  /** Deepest penetration seen in the last ~1 s (m, 0 when clean). */
  maxPenetrationM: number
  /** Mean correct() cost over the last ~1 s, microseconds. */
  avgCostUs: number
  /** Capsule count actually built (skipped bones reduce it). */
  capsuleCount: number
}

export interface SelfCollisionTargetReport {
  target: string
  penetrationM: number
  capsule: string | null
}

// ── Pure math (xyz vectors as tuples, xyzw quaternions as tuples) ───

type V = [number, number, number]
type Q = [number, number, number, number] // x, y, z, w (three.js layout)

function qmul(a: Q, b: Q, out: Q): Q {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3]
  const bx = b[0], by = b[1], bz = b[2], bw = b[3]
  out[0] = aw * bx + ax * bw + ay * bz - az * by
  out[1] = aw * by - ax * bz + ay * bw + az * bx
  out[2] = aw * bz + ax * by - ay * bx + az * bw
  out[3] = aw * bw - ax * bx - ay * by - az * bz
  return out
}

function qconj(q: Q, out: Q): Q {
  out[0] = -q[0]; out[1] = -q[1]; out[2] = -q[2]; out[3] = q[3]
  return out
}

function qnorm(q: Q): Q {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1
  q[0] /= n; q[1] /= n; q[2] /= n; q[3] /= n
  return q
}

function qrot(q: Q, v: V, out: V): V {
  // v' = q ⊗ (v,0) ⊗ q⁻¹, expanded.
  const x = q[0], y = q[1], z = q[2], w = q[3]
  const tx = 2 * (y * v[2] - z * v[1])
  const ty = 2 * (z * v[0] - x * v[2])
  const tz = 2 * (x * v[1] - y * v[0])
  out[0] = v[0] + w * tx + y * tz - z * ty
  out[1] = v[1] + w * ty + z * tx - x * tz
  out[2] = v[2] + w * tz + x * ty - y * tx
  return out
}

function qaxisAngle(axis: V, angleRad: number, out: Q): Q {
  const s = Math.sin(angleRad / 2)
  out[0] = axis[0] * s; out[1] = axis[1] * s; out[2] = axis[2] * s
  out[3] = Math.cos(angleRad / 2)
  return out
}

/** Closest point on segment ab to p → out; returns squared distance to p. */
function closestOnSegment(p: V, a: V, b: V, out: V): number {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2]
  const apx = p[0] - a[0], apy = p[1] - a[1], apz = p[2] - a[2]
  const len2 = abx * abx + aby * aby + abz * abz
  let t = len2 > 1e-12 ? (apx * abx + apy * aby + apz * abz) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  out[0] = a[0] + abx * t; out[1] = a[1] + aby * t; out[2] = a[2] + abz * t
  const dx = p[0] - out[0], dy = p[1] - out[1], dz = p[2] - out[2]
  return dx * dx + dy * dy + dz * dz
}

// ── Module ──────────────────────────────────────────────────────────

interface Capsule {
  name: string
  nodeA: Object3DLike
  nodeB: Object3DLike
  radius: number
  length: number
  /** Preallocated world endpoints. */
  aw: V
  bw: V
}

interface ChainJoint {
  name: string
  node: Object3DLike
  /** Spent correction budget, degrees (recovers after a quiet period). */
  spentDeg: number
  /** Last correction timestamp (budget recovery quiet period). */
  lastCorrectAtMs: number
}

interface Target {
  name: string
  node: Object3DLike
  radius: number
  chain: ChainJoint[]
  ignore: Set<string>
}

export class SelfCollision {
  private readonly config: typeof SELF_COLLISION_CONFIG
  private readonly vrm: VrmLike
  private readonly nowMs: () => number
  private enabled: boolean
  private readonly capsules: Capsule[] = []
  private readonly targets: Target[] = []
  /** Capsule names skipped at build (bones absent from the rig). */
  readonly skipped: string[] = []

  private correctionsTotal = 0
  private corrRateEma = 0
  private costEmaUs = 0
  private frameMaxPen = 0
  private peakPen = 0
  private peakPenAtMs = -Infinity

  // Preallocated hot-path temps (zero per-frame allocation).
  private readonly tmpPos = { x: 0, y: 0, z: 0 }
  private readonly tmpQuat = { x: 0, y: 0, z: 0, w: 1 }
  private readonly tmpQuat2 = { x: 0, y: 0, z: 0, w: 1 }
  private readonly p: V = [0, 0, 0]
  private readonly closest: V = [0, 0, 0]
  private readonly escape: V = [0, 0, 0]
  private readonly r: V = [0, 0, 0]
  private readonly axis: V = [0, 0, 0]
  private readonly jw: V = [0, 0, 0]
  private readonly qWorld: Q = [0, 0, 0, 1]
  private readonly qLocal: Q = [0, 0, 0, 1]
  private readonly qParent: Q = [0, 0, 0, 1]
  private readonly qDelta: Q = [0, 0, 0, 1]
  private readonly qTmp: Q = [0, 0, 0, 1]
  private readonly qTmp2: Q = [0, 0, 0, 1]

  constructor(
    vrm: VrmLike,
    config?: Partial<typeof SELF_COLLISION_CONFIG>,
    nowMs?: () => number,
  ) {
    this.vrm = vrm
    this.config = { ...SELF_COLLISION_CONFIG, ...config }
    this.enabled = this.config.ENABLED
    this.nowMs = nowMs ?? (() => performance.now())

    const bone = (name: string): Object3DLike | null =>
      this.vrm.humanoid.getNormalizedBoneNode(name) ?? null

    for (const c of this.config.CAPSULES) {
      const nodeA = bone(c.boneA)
      const nodeB = bone(c.boneB)
      if (nodeA === null || nodeB === null) {
        this.skipped.push(c.name)
        continue
      }
      // Segment length from the pose-invariant LOCAL offset of boneB.
      const length = Math.hypot(nodeB.position.x, nodeB.position.y, nodeB.position.z)
      this.capsules.push({
        name: c.name,
        nodeA,
        nodeB,
        radius: Math.max(c.radiusFactor * length, c.minRadius),
        length,
        aw: [0, 0, 0],
        bw: [0, 0, 0],
      })
    }

    const jointRegistry = new Map<string, ChainJoint>()
    for (const t of this.config.TARGETS) {
      const node = bone(t.bone)
      if (node === null) {
        this.skipped.push(t.name)
        continue
      }
      const chain: ChainJoint[] = []
      for (const j of t.chain) {
        const jn = bone(j)
        if (jn === null) continue
        // Shared budget per BONE across targets (a shoulder appearing in two
        // chains gets one 15° budget, not two).
        let entry = jointRegistry.get(j)
        if (entry === undefined) {
          entry = { name: j, node: jn, spentDeg: 0, lastCorrectAtMs: -Infinity }
          jointRegistry.set(j, entry)
        }
        chain.push(entry)
      }
      if (chain.length === 0) {
        this.skipped.push(`${t.name}(chain)`)
        continue
      }
      this.targets.push({
        name: t.name,
        node,
        radius: t.radius,
        chain,
        ignore: new Set(t.ignoreCapsules),
      })
    }
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  get capsuleCount(): number {
    return this.capsules.length
  }

  /** Capsule summary for tests/debug (name, length, radius). Allocates. */
  describeCapsules(): { name: string; length: number; radius: number }[] {
    return this.capsules.map((c) => ({ name: c.name, length: c.length, radius: c.radius }))
  }

  telemetry(): SelfCollisionTelemetry {
    const now = this.nowMs()
    return {
      enabled: this.enabled,
      correctionsPerSec: this.enabled ? this.corrRateEma : 0,
      correctionsTotal: this.correctionsTotal,
      maxPenetrationM: now - this.peakPenAtMs < 1000 ? this.peakPen : 0,
      avgCostUs: this.enabled ? this.costEmaUs : 0,
      capsuleCount: this.capsules.length,
    }
  }

  /**
   * Debug probe (__ardy): current penetration per target WITHOUT
   * correcting. Allocates — debug path only.
   */
  report(): SelfCollisionTargetReport[] {
    this.updateWorld()
    const out: SelfCollisionTargetReport[] = []
    for (const target of this.targets) {
      const pen = this.measureTarget(target)
      out.push({
        target: target.name,
        penetrationM: pen.depth,
        capsule: pen.capsule?.name ?? null,
      })
    }
    return out
  }

  /**
   * Post-retarget bounded correction. Runs once per render frame after the
   * pose write; no-ops when disabled or when nothing penetrates.
   */
  correct(dt: number): void {
    if (!this.enabled || this.capsules.length === 0 || this.targets.length === 0) return
    const start = this.nowMs()
    this.updateWorld()

    let corrected = 0
    this.frameMaxPen = 0
    for (const target of this.targets) {
      const pen = this.measureTarget(target)
      if (pen.depth > this.frameMaxPen) this.frameMaxPen = pen.depth
      if (pen.depth <= this.config.EPS_PEN_M || pen.capsule === null) continue
      if (this.correctTarget(target, pen.depth)) corrected += 1
    }
    if (this.frameMaxPen > this.peakPen || this.nowMs() - this.peakPenAtMs > 1000) {
      this.peakPen = this.frameMaxPen
      this.peakPenAtMs = this.nowMs()
    }

    // Budget recovery: only after a joint has been QUIET (no correction for
    // BUDGET_QUIET_MS) — recovering mid-episode would lease unlimited slow
    // drift past MAX_TOTAL_DEG.
    const now = this.nowMs()
    for (const target of this.targets) {
      for (const joint of target.chain) {
        if (joint.spentDeg > 0 && now - joint.lastCorrectAtMs > this.config.BUDGET_QUIET_MS) {
          joint.spentDeg = Math.max(0, joint.spentDeg - this.config.BUDGET_RECOVER_DEG_PER_S * dt)
        }
      }
    }

    const rate = dt > 0 ? corrected / dt : 0
    const alpha = Math.min(1, dt * 2)
    this.corrRateEma += (rate - this.corrRateEma) * alpha
    this.correctionsTotal += corrected
    const costUs = (this.nowMs() - start) * 1000
    this.costEmaUs += (costUs - this.costEmaUs) * alpha
  }

  // ── internals ──────────────────────────────────────────────────────

  /** Refresh capsule endpoints from current bone world transforms. */
  private updateWorld(): void {
    this.vrm.scene.updateMatrixWorld?.(true)
    for (const c of this.capsules) {
      this.readWorld(c.nodeA, c.aw)
      this.readWorld(c.nodeB, c.bw)
    }
  }

  private readWorld(node: Object3DLike, out: V): void {
    node.getWorldPosition(this.tmpPos)
    out[0] = this.tmpPos.x; out[1] = this.tmpPos.y; out[2] = this.tmpPos.z
  }

  /**
   * Deepest penetration of a target point over all non-ignored capsules.
   * Leaves the target's world position in this.p.
   */
  private measureTarget(target: Target): { depth: number; capsule: Capsule | null } {
    this.readWorld(target.node, this.p)
    let deepest = -Infinity
    let hit: Capsule | null = null
    for (const c of this.capsules) {
      if (target.ignore.has(c.name)) continue
      const d2 = closestOnSegment(this.p, c.aw, c.bw, this.closest)
      const depth = c.radius + target.radius - Math.sqrt(d2)
      if (depth > deepest) {
        deepest = depth
        hit = c
        // Keep the escape vector of the DEEPEST capsule for the corrector.
        this.escape[0] = this.p[0] - this.closest[0]
        this.escape[1] = this.p[1] - this.closest[1]
        this.escape[2] = this.p[2] - this.closest[2]
      }
    }
    return { depth: deepest, capsule: hit }
  }

  /**
   * Rotate the target's chain joints (elbow, then shoulder) along the
   * shortest escape direction, bounded per frame and per joint. Returns
   * true when a correction was applied. Fail-open: unresolvable within
   * budget → leave the pose.
   */
  private correctTarget(target: Target, depth: number): boolean {
    const escapeLen = Math.hypot(this.escape[0], this.escape[1], this.escape[2])
    if (escapeLen < 1e-9) return false // dead center — no shortest direction
    this.escape[0] /= escapeLen; this.escape[1] /= escapeLen; this.escape[2] /= escapeLen

    const maxStep = (this.config.MAX_STEP_DEG * Math.PI) / 180
    const maxTotal = (this.config.MAX_TOTAL_DEG * Math.PI) / 180
    for (const joint of target.chain) {
      const remaining = maxTotal - (joint.spentDeg * Math.PI) / 180
      if (remaining <= 1e-6) continue
      this.readWorld(joint.node, this.jw)
      this.r[0] = this.p[0] - this.jw[0]
      this.r[1] = this.p[1] - this.jw[1]
      this.r[2] = this.p[2] - this.jw[2]
      const rLen = Math.hypot(this.r[0], this.r[1], this.r[2])
      if (rLen < 0.01) continue // joint ON the target — no lever arm
      // Small-angle: the point moves ≈ angle × |r| along the escape arc.
      let angle = ((depth + this.config.EPS_PEN_M) / rLen) * this.config.GAIN
      angle = Math.min(angle, maxStep, remaining)
      if (angle <= 1e-6) continue
      // Rotation axis ⊥ both the lever arm and the escape direction.
      let ax = this.r[1] * this.escape[2] - this.r[2] * this.escape[1]
      let ay = this.r[2] * this.escape[0] - this.r[0] * this.escape[2]
      let az = this.r[0] * this.escape[1] - this.r[1] * this.escape[0]
      let aLen = Math.hypot(ax, ay, az)
      if (aLen < 1e-9) {
        // r ∥ escape: any perpendicular axis does.
        ax = -this.r[1]; ay = this.r[0]; az = 0
        aLen = Math.hypot(ax, ay, az)
        if (aLen < 1e-9) { ax = 0; ay = -this.r[2]; az = this.r[1]; aLen = Math.hypot(ax, ay, az) }
        if (aLen < 1e-9) continue
      }
      this.axis[0] = ax / aLen; this.axis[1] = ay / aLen; this.axis[2] = az / aLen

      // World-space delta → joint-local: localDelta = parentWorld⁻¹ ⊗ delta ⊗ parentWorld.
      joint.node.getWorldQuaternion(this.tmpQuat)
      this.qWorld[0] = this.tmpQuat.x; this.qWorld[1] = this.tmpQuat.y
      this.qWorld[2] = this.tmpQuat.z; this.qWorld[3] = this.tmpQuat.w
      this.qLocal[0] = joint.node.quaternion.x; this.qLocal[1] = joint.node.quaternion.y
      this.qLocal[2] = joint.node.quaternion.z; this.qLocal[3] = joint.node.quaternion.w
      qconj(this.qLocal, this.qTmp)
      qmul(this.qWorld, this.qTmp, this.qParent) // parentWorld = world ⊗ local⁻¹
      qaxisAngle(this.axis, angle, this.qDelta)
      qconj(this.qParent, this.qTmp)
      qmul(this.qTmp, this.qDelta, this.qTmp2)
      qmul(this.qTmp2, this.qParent, this.qTmp) // localDelta
      qmul(this.qTmp, this.qLocal, this.qTmp2) // newLocal = localDelta ⊗ local
      qnorm(this.qTmp2)
      joint.node.quaternion.x = this.qTmp2[0]; joint.node.quaternion.y = this.qTmp2[1]
      joint.node.quaternion.z = this.qTmp2[2]; joint.node.quaternion.w = this.qTmp2[3]
      joint.spentDeg += (angle * 180) / Math.PI
      joint.lastCorrectAtMs = this.nowMs()

      // Analytic follow-through: the corrected point for downstream targets
      // in this same frame (full scene re-FK happens next frame).
      qrot(this.qDelta, this.r, this.r)
      this.p[0] = this.jw[0] + this.r[0]
      this.p[1] = this.jw[1] + this.r[1]
      this.p[2] = this.jw[2] + this.r[2]
      return true
    }
    return false
  }
}
