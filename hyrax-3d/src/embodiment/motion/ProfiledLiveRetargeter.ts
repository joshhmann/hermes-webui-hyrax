/**
 * ProfiledLiveRetargeter — adapter that runs the loft's LIVE ARDY stream
 * through the user-validated calibration profile (tai-embodiment-v3.json)
 * instead of the gestalt-motion CanonicalRetargeter semantics.
 *
 * Single-implementation rule: the retarget math lives ONLY in
 * hyrax-3d/calibrate/AvatarRetargeter.js (the same module the debug page's
 * validated profiled path uses). This adapter does no retarget math of its
 * own; it only reshapes the live stream into the motion-object shape
 * AvatarRetargeter consumes:
 *
 *   PoseChunk local quats (w-first) → FK world quats (fkSkeleton)
 *     → VRM 0.x source-side Y180 conjugation (debug-proven
 *       conjugateClipY180 equivalent: q' = (w, −x, y, −z), the quaternion
 *       form of R' = Y·R·Yᵀ with Y = 180° yaw)
 *     → row-major rotation matrices (AvatarRetargeter's global_rot_mats)
 *
 * Rest reference: the canonical settled T-pose embedded in the profile
 * (rest_pose.source_rest — capture-tpose frame 20, the same "TRUE source rest
 * reference" the debug page loads as its restClip). The live generator stream
 * contains NO T-pose settle (it is idle motion from frame 0), so measuring
 * rest from a stream frame captures an arms-down pose and every per-frame
 * delta collapses to identity — the rendered avatar freezes in her normalized
 * rest (T-pose). When the profile carries source_rest, calibration completes
 * IMMEDIATELY at construction: the rig is reset to its normalized rest pose,
 * AvatarRetargeter measures rest offsets from the embedded reference, then
 * its motion handle is swapped to the live slot (setPoseMotion). Profiles
 * without source_rest keep the legacy behavior: incoming stream frames are
 * buffered and rest is measured from settled stream frame `restFrame`
 * (profile rest_pose.rest_frame_recommended — 20 for the Core27 carrier, 0
 * for the SOMA carriers), valid only for streams with a T-pose settle; until
 * then `calibrated` is false and ArdyMotionSource leaves
 * ProceduralLocomotion in charge of the rig.
 *
 * Ownership split: the RootMotionAdapter keeps owning root XZ/yaw and the
 * hips node position (nav-approval seam unchanged) — applyFrame runs with
 * writeHipsPosition:false and this adapter writes the adapter-supplied hips
 * position plus AvatarRetargeter's lowpassed ground-contact correction. The
 * profile's own hips handling (delta-from-frame-0 × 0.954 scale) is
 * therefore deliberately NOT used on the live path; only its bone-rotation
 * semantics are. Root positions are also NOT Y180-conjugated: navigation
 * moves the unflipped AvatarRoot, and the conjugation exists only to fix
 * bone rotations inside the rotateVRM0-flipped VRM scene. (Yaw is invariant
 * under the Y180 conjugation, so the scene-root yaw channel is unaffected.)
 */
import { AvatarRetargeter } from '../../../calibrate/AvatarRetargeter.js'
import type { AvatarRetargeterProfile } from '../../../calibrate/AvatarRetargeter.js'
import { fkSkeleton } from 'gestalt-motion/calibrate.ts'
import { Vrm0xCompatAdapter } from 'gestalt-motion/CanonicalRetargeter.ts'
import { PoseSampler } from 'gestalt-motion/PoseSampler.ts'
import type { FrameRef } from 'gestalt-motion/ChunkBuffer.ts'
import type { QuatWXYZ, SkeletonContract, Vec3 } from 'gestalt-motion/canonical.ts'
import type { Object3DLike, VrmLike } from 'gestalt-motion/vrmLike.ts'

/** VRM 0.x source-side conjugation: q' = Y180 ⊗ q ⊗ Y180⁻¹ (w-first). */
function conjY180(q: QuatWXYZ): QuatWXYZ {
  return [q[0], -q[1], q[2], -q[3]]
}

/** Unit quaternion (w-first) → row-major 3×3 rotation matrix (x' = R x). */
function quatToMat3RowMajor(q: QuatWXYZ): number[] {
  const [w, x, y, z] = q
  const x2 = x + x
  const y2 = y + y
  const z2 = z + z
  const xx = x * x2
  const xy = x * y2
  const xz = x * z2
  const yy = y * y2
  const yz = y * z2
  const zz = z * z2
  const wx = w * x2
  const wy = w * y2
  const wz = w * z2
  return [
    1 - (yy + zz), xy - wz, xz + wy,
    xy + wz, 1 - (xx + zz), yz - wx,
    xz - wy, yz + wx, 1 - (xx + yy),
  ]
}

/** Contact bitmask (L-heel|L-toe|R-heel|R-toe) → confidence array [4]. */
function bitmaskToContacts(bits: number): number[] {
  return [bits & 1 ? 1 : 0, bits & 2 ? 1 : 0, bits & 4 ? 1 : 0, bits & 8 ? 1 : 0]
}

interface ResolvedMap {
  key: string
  map: Record<string, string>
}

export class ProfiledLiveRetargeter {
  private readonly contract: SkeletonContract
  private readonly vrm: VrmLike
  private readonly profile: AvatarRetargeterProfile
  private readonly srcHipsHeight: number
  private readonly conjugate: boolean
  private readonly jointCount: number
  readonly skeletonKey: string
  readonly restFrame: number
  private readonly boneMap: Record<string, string>
  /** Growing during calibration feed; slot 0 reused per posed frame after. */
  private readonly motion: {
    skeleton: string
    joints: string[]
    rot: number[][][]
    root: Vec3[]
    contacts: number[][]
  }
  private lastFedSeq = -1
  private retargeter: AvatarRetargeter | null = null
  private _blendBones: Object3DLike[] = []
  private _hipsNode: Object3DLike | null = null

  /**
   * Throws (→ caller falls back to the gestalt-motion path) when the profile
   * has no skeleton map whose joints all exist in the contract, or the
   * avatar lacks a hips bone.
   */
  constructor(contract: SkeletonContract, vrm: VrmLike, profile: AvatarRetargeterProfile) {
    this.contract = contract
    this.vrm = vrm
    this.profile = profile
    this.jointCount = contract.joint_names.length

    const resolved = ProfiledLiveRetargeter.resolveSkeletonMap(profile, contract)
    if (resolved === null) {
      throw new Error(
        `no profile skeleton map matches contract "${contract.skeleton_id}" ` +
        `(${contract.joint_names.length} joints)`,
      )
    }
    this.skeletonKey = resolved.key
    this.boneMap = resolved.map
    if (!Array.isArray(profile.solve_order) || typeof profile.vrm_bone_parents !== 'object') {
      throw new Error('profile is missing solve_order / vrm_bone_parents')
    }
    this._hipsNode = vrm.humanoid.getNormalizedBoneNode('hips') ?? null
    if (this._hipsNode === null) {
      throw new Error('avatar has no normalized hips bone')
    }

    const restPose = profile.rest_pose ?? {}
    this.srcHipsHeight = restPose.default_src_hips_height_m ?? 0.954
    this.restFrame = restPose.rest_frame_recommended?.[resolved.key] ?? restPose.rest_frame_default ?? 0
    this.conjugate = Vrm0xCompatAdapter.needsAdapter(vrm)

    this.motion = {
      skeleton: resolved.key,
      joints: contract.joint_names.slice(),
      rot: [],
      root: [],
      contacts: [],
    }

    // Canonical source rest embedded in the profile (the live stream has no
    // T-pose settle): calibrate immediately instead of waiting for a settled
    // stream frame that would capture non-rest motion.
    const sourceRest = ProfiledLiveRetargeter.resolveSourceRest(restPose, resolved.map)
    if (sourceRest !== null) {
      this.finalizeCalibration(ProfiledLiveRetargeter.buildRestMotion(
        resolved.key,
        sourceRest,
        this.conjugate,
        this.srcHipsHeight,
      ))
    }
  }

  get calibrated(): boolean {
    return this.retargeter !== null
  }

  /** Valid after calibration (AvatarRetargeter world-Y ratio vs srcHipsHeight). */
  get hipsScale(): number {
    return this.retargeter?.hipsScale ?? 1
  }

  /** Normalized bone nodes the retargeter writes (for the 0.3 s crossfade). */
  get blendBones(): Object3DLike[] {
    return this._blendBones
  }

  get hipsNode(): Object3DLike | null {
    return this._hipsNode
  }

  /**
   * Feed one distinct buffered stream frame (dedupes by frameSeq). When the
   * settled rest frame has arrived, resets the rig to its normalized rest
   * pose and finishes calibration (mirrors debug ardy.js:371-373 + the
   * AvatarRetargeter construction at ardy.js:400-404).
   */
  feedFrame(frame: FrameRef): void {
    if (this.calibrated || frame.frameSeq <= this.lastFedSeq) return
    const pose = PoseSampler.sample(frame, null, 0, this.jointCount)
    this.motion.rot.push(this.worldMats(pose.localRots))
    this.motion.root.push(pose.rootPos)
    this.motion.contacts.push(bitmaskToContacts(pose.contacts))
    this.lastFedSeq = frame.frameSeq
    if (this.motion.rot.length > this.restFrame) this.finalizeCalibration()
  }

  /** A reset chunk dropped the pre-calibration buffer — start the feed over. */
  resetFeed(): void {
    if (this.calibrated) {
      this.retargeter!.onReset() // drop ground-correction state (chunk boundary)
      return
    }
    this.motion.rot.length = 0
    this.motion.root.length = 0
    this.motion.contacts.length = 0
    this.lastFedSeq = -1
  }

  /**
   * Retarget one sampled pose. `localRots` is the sampler output ([J*4]
   * w-first, hips yaw already stripped by the caller's RootMotionAdapter
   * decomposition); `hipsPosition` is the RootMotionAdapter output.
   */
  applyPose(localRots: Float32Array, hipsPosition: Vec3, contacts: number): void {
    const retargeter = this.retargeter
    if (retargeter === null) return
    // Rest offsets were cached in setMotion, so slot 0 is reusable per frame.
    this.motion.rot[0] = this.worldMats(localRots)
    this.motion.contacts[0] = bitmaskToContacts(contacts)
    retargeter.applyFrame(0, { writeHipsPosition: false })
    if (this._hipsNode !== null) {
      this._hipsNode.position.x = hipsPosition[0]
      this._hipsNode.position.y = hipsPosition[1] + retargeter.groundCorrection
      this._hipsNode.position.z = hipsPosition[2]
    }
  }

  // ── internals ──────────────────────────────────────────────────────

  /**
   * Reset the rig to its normalized rest and build the AvatarRetargeter.
   * With `restMotion` (canonical source rest from the profile) offsets are
   * measured from its frame 0 and the retargeter's motion handle is then
   * swapped to the live slot (setPoseMotion); without it, offsets are
   * measured from the buffered live frames at `restFrame` (legacy path,
   * mirrors debug ardy.js:371-373 + ardy.js:400-404).
   */
  private finalizeCalibration(restMotion?: {
    skeleton: string
    joints: string[]
    rot: number[][][]
    root: Vec3[]
    contacts: number[][]
  }): void {
    // Re-establish the signed import rest state before measuring (debug
    // ardy.js:371-373) — never calibrate against the live, animating rig.
    this.vrm.humanoid.resetNormalizedPose?.()
    this.vrm.humanoid.update?.()
    this.vrm.scene.updateMatrixWorld?.(true)
    const retargeter = new AvatarRetargeter(this.vrm, this.profile, {
      srcHipsHeight: this.srcHipsHeight,
      restFrame: restMotion !== undefined ? 0 : this.restFrame,
    })
    retargeter.setMotion(restMotion ?? this.motion)
    if (retargeter.boneMap === null) {
      throw new Error(`profile skeleton map "${this.skeletonKey}" rejected by AvatarRetargeter`)
    }
    if (restMotion !== undefined) {
      // Offsets now come from the canonical rest; pose the live slot instead.
      retargeter.setPoseMotion(this.motion)
    }
    this.retargeter = retargeter
    this._blendBones = []
    for (const bone of this.profile.solve_order) {
      if (!this.boneMap[bone]) continue
      const node = this.vrm.humanoid.getNormalizedBoneNode(bone)
      if (node) this._blendBones.push(node)
    }
  }

  /** FK the canonical local quats to world rotation matrices (conjugated for VRM 0.x). */
  private worldMats(localRots: Float32Array): number[][] {
    const J = this.jointCount
    const locals: QuatWXYZ[] = new Array<QuatWXYZ>(J)
    for (let j = 0; j < J; j += 1) {
      const k = j * 4
      locals[j] = [localRots[k]!, localRots[k + 1]!, localRots[k + 2]!, localRots[k + 3]!]
    }
    const { worldRot } = fkSkeleton(this.contract, locals)
    return worldRot.map((q) => quatToMat3RowMajor(this.conjugate ? conjY180(q) : q))
  }

  /**
   * Validate the profile's embedded canonical source rest (fail-closed):
   * every mapped source joint must be present with a 9-element rotation
   * matrix. Null when the profile carries no source rest (→ legacy
   * settled-frame feed); THROWS when it is present but malformed (→ caller
   * falls back to the gestalt-motion path).
   */
  private static resolveSourceRest(
    restPose: AvatarRetargeterProfile['rest_pose'],
    boneMap: Record<string, string>,
  ): { joints: string[]; worldRotMats: number[][] } | null {
    const rest = restPose?.source_rest
    if (rest === undefined || rest === null) return null
    const joints = (rest as { joints?: unknown }).joints
    const mats = (rest as { world_rot_mats?: unknown }).world_rot_mats
    if (
      !Array.isArray(joints) ||
      !Array.isArray(mats) ||
      joints.length !== mats.length ||
      !joints.every((n) => typeof n === 'string')
    ) {
      throw new Error('profile rest_pose.source_rest is malformed (joints / world_rot_mats)')
    }
    const present = new Set(joints as string[])
    for (const joint of Object.values(boneMap)) {
      if (!present.has(joint)) {
        throw new Error(`profile rest_pose.source_rest is missing joint "${joint}"`)
      }
    }
    for (const m of mats as unknown[]) {
      if (!Array.isArray(m) || m.length !== 9 || !m.every((v) => Number.isFinite(v))) {
        throw new Error('profile rest_pose.source_rest has a malformed rotation matrix')
      }
    }
    return { joints: (joints as string[]).slice(), worldRotMats: mats as number[][] }
  }

  /** One-frame rest motion (AvatarRetargeter shape), conjugated like live frames. */
  private static buildRestMotion(
    skeletonKey: string,
    sourceRest: { joints: string[]; worldRotMats: number[][] },
    conjugate: boolean,
    srcHipsHeight: number,
  ): {
    skeleton: string
    joints: string[]
    rot: number[][][]
    root: Vec3[]
    contacts: number[][]
  } {
    const mats = conjugate
      ? sourceRest.worldRotMats.map((m) => [m[0]!, -m[1]!, m[2]!, -m[3]!, m[4]!, -m[5]!, m[6]!, -m[7]!, m[8]!])
      : sourceRest.worldRotMats.map((m) => m.slice())
    return {
      skeleton: skeletonKey,
      joints: sourceRest.joints.slice(),
      rot: [mats],
      root: [[0, srcHipsHeight, 0]],
      contacts: [[0, 0, 0, 0]],
    }
  }

  /**
   * Pick the profile skeleton map for this contract: exact skeleton_id key
   * (or its `_alias`), else the first object-valued map whose joints all
   * exist in the contract. Null when nothing matches (→ gestalt fallback).
   */
  private static resolveSkeletonMap(
    profile: AvatarRetargeterProfile,
    contract: SkeletonContract,
  ): ResolvedMap | null {
    const maps = profile.skeleton_maps
    if (typeof maps !== 'object' || maps === null) return null
    const joints = new Set(contract.joint_names)
    const usable = (m: unknown): m is Record<string, string> =>
      typeof m === 'object' && m !== null &&
      Object.values(m as Record<string, unknown>).every(
        (j) => typeof j === 'string' && joints.has(j),
      )
    const direct = maps[contract.skeleton_id]
    if (usable(direct)) return { key: contract.skeleton_id, map: direct }
    const alias = maps[`${contract.skeleton_id}_alias`]
    if (typeof alias === 'string') {
      const aliased = maps[alias]
      if (usable(aliased)) return { key: alias, map: aliased }
    }
    for (const [key, m] of Object.entries(maps)) {
      if (key.endsWith('_alias') || key === 'description') continue
      if (usable(m)) return { key, map: m }
    }
    return null
  }
}
