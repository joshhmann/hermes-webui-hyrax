// AvatarRetargeter.js — Profile-driven avatar retargeter.
//
// Replaces hardcoded SomaVrmRetargeter.js with a generic class that
// reads its configuration from a calibration profile JSON.
//
// Usage:
//   const ret = new AvatarRetargeter(vrm, profile, { srcHipsHeight: 0.954, restFrame: 0 })
//   ret.setMotion(motionData)
//   ret.applyFrame(42)
//
// No hardcoded skeleton knowledge. The profile supplies:
//   skeleton_maps    — SOMA joint → VRM bone name
//   solve_order      — topological bone order (parents before children)
//   vrm_bone_parents — VRM bone parent hierarchy
//   rest_pose        — default heights, rest frame recommendations

import * as THREE from 'three'

export class AvatarRetargeter {
  /**
   * @param {VRM} vrm  Loaded VRM 1.0 model (must have humanoid)
   * @param {object} profile  Calibration profile JSON
   * @param {object} opts
   * @param {number} opts.srcHipsHeight  Source subject hip height (default from profile)
   * @param {number} opts.restFrame  Frame to use for rest offset measurement
   */
  constructor(vrm, profile, opts = {}) {
    /** @private */ this.vrm = vrm
    /** @private */ this.profile = profile
    this.solveOrder = profile.solve_order
    this.vrmParent = profile.vrm_bone_parents
    /** @private */ this.srcHipsHeight = opts.srcHipsHeight ?? profile.rest_pose.default_src_hips_height_m
    /** @private */ this.restFrame = opts.restFrame ?? profile.rest_pose.rest_frame_default ?? 0

    // Motion state — set via setMotion()
    /** @private */ this.motion = null
    /** @private */ this.jointIndex = null
    /** @private */ this.boneMap = null
    /** @private */ this.offsets = {}
    /** @private */ this.hipsScale = 1.0
    /** @private */ this.hipsNode = null
    /** @private */ this._groundCorr = 0
  }

  /**
   * Load motion data. Call before applyFrame().
   * @param {object} motion  Parsed motion JSON with .joints, .rot, .root, .parentIdx, .offsets, .contacts, .skeleton
   */
  setMotion(motion) {
    this.motion = motion
    this.jointIndex = Object.fromEntries(motion.joints.map((n, i) => [n, i]))

    // Normalize field names — accept both debug-page shape (global_rot_mats)
    // and calibrate-page shape (rot).
    if (!this.motion.rot && this.motion.global_rot_mats) this.motion.rot = this.motion.global_rot_mats
    if (!this.motion.root && this.motion.root_positions) this.motion.root = this.motion.root_positions
    if (!this.motion.contacts && this.motion.foot_contacts) this.motion.contacts = this.motion.foot_contacts

    // Safety: verify motion data shape before proceeding
    if (!this.motion.rot || !this.motion.rot[0]) {
      console.error('[AvatarRetargeter] setMotion: no rotation data', this.motion.skeleton, Object.keys(this.motion))
      this.boneMap = null
      return
    }
    const frameJoints = this.motion.rot[0]
    if (!Array.isArray(frameJoints)) {
      console.error('[AvatarRetargeter] setMotion: rot[0] is not an array, type=', typeof frameJoints)
      this.boneMap = null
      return
    }

    // Resolve skeleton map from profile
    const skelKey = motion.skeleton
    let map = this.profile.skeleton_maps[skelKey]
    if (!map) {
      const alias = this.profile.skeleton_maps[skelKey + '_alias']
      if (alias) map = this.profile.skeleton_maps[alias]
    }
    this.boneMap = map

    // Precompute rest offsets for every mapped bone
    this.offsets = {}
    if (map) {
      for (const [bone, joint] of Object.entries(map)) {
        const node = this.vrm.humanoid.getNormalizedBoneNode(bone)
        if (!node) continue
        const rest = this._srcWorldQuat(joint, this.restFrame)
        this.offsets[bone] = rest.invert().clone()
      }
    }

    // Hips scale
    this.hipsNode = this.vrm.humanoid.getNormalizedBoneNode('hips')
    const hipsWorldY = this.hipsNode.getWorldPosition(new THREE.Vector3()).y
    this.hipsScale = hipsWorldY / this.srcHipsHeight

    // Reset per-chunk state
    this._groundCorr = 0
  }

  /**
   * Swap the motion being POSED without re-measuring rest offsets.
   *
   * Use after setMotion() when the rest reference and the posed motion are
   * different objects — e.g. the loft's live path measures offsets from the
   * profile's canonical source rest (settled T-pose) and then poses a live
   * stream that contains no T-pose of its own. Keeps boneMap, offsets,
   * hipsScale and the ground-correction lowpass; only the per-frame data
   * handle (and its joint index) is replaced.
   * @param {object} motion  Same shape as setMotion(), minus the rest frame
   *                    requirement — rot frames are written by the caller.
   */
  setPoseMotion(motion) {
    if (!motion || !Array.isArray(motion.joints)) {
      console.error('[AvatarRetargeter] setPoseMotion: bad motion shape', motion && Object.keys(motion))
      return
    }
    if (!motion.rot && motion.global_rot_mats) motion.rot = motion.global_rot_mats
    if (!motion.root && motion.root_positions) motion.root = motion.root_positions
    if (!motion.contacts && motion.foot_contacts) motion.contacts = motion.foot_contacts
    if (!Array.isArray(motion.rot)) {
      console.error('[AvatarRetargeter] setPoseMotion: no rotation data', Object.keys(motion))
      return
    }
    this.motion = motion
    this.jointIndex = Object.fromEntries(motion.joints.map((n, i) => [n, i]))
  }

  /**
   * Retarget one frame.
   * @param {number} frame  Frame index
   * @param {object} opts
   * @param {number} opts.groundY  Ground plane Y (default 0)
   * @param {number} opts.contactSmoothing  Lowpass factor for ground correction (default 0.4)
   * @param {boolean} opts.writeHipsPosition  Write the scaled delta-from-frame-0
   *                    hips position (default true). Pass false when an external
   *                    owner (e.g. the loft's RootMotionAdapter) owns the hips
   *                    node position — the ground-contact lowpass still runs and
   *                    is exposed via groundCorrection for that owner to apply.
   * @returns {object}  Snapshot { quat: {bone: THREE.Quaternion}, hipsPos: THREE.Vector3 }
   *                    for validation / inspection — not needed for normal use.
   */
  applyFrame(frame, opts = {}) {
    const { groundY = 0, contactSmoothing = 0.4, writeHipsPosition = true } = opts
    const map = this.boneMap
    if (!map || !this.motion) return null

    const snapshot = { quat: {}, hipsPos: new THREE.Vector3() }
    const world = {}
    const q = new THREE.Quaternion()

    for (const bone of this.solveOrder) {
      const joint = map[bone]
      if (!joint || !this.offsets[bone]) continue
      const node = this.vrm.humanoid.getNormalizedBoneNode(bone)
      if (!node) continue
      const W = this._srcWorldQuat(joint, frame).multiply(this.offsets[bone]).clone()
      world[bone] = W
      const parentW = world[this.vrmParent[bone]]
      const localQ = parentW ? q.copy(parentW).invert().multiply(W) : W
      node.quaternion.copy(localQ)
      snapshot.quat[bone] = W.clone()
    }

    if (writeHipsPosition) {
      // Hips position: delta-from-frame-0 scaled
      const p = this.motion.root[frame]
      const p0 = this.motion.root[0]
      this.hipsNode.userData.restY = this.hipsNode.userData.restY ?? this.hipsNode.position.y
      this.hipsNode.position.set(
        (p[0] - p0[0]) * this.hipsScale,
        this.hipsNode.userData.restY + (p[1] - p0[1]) * this.hipsScale,
        (p[2] - p0[2]) * this.hipsScale,
      )
      snapshot.hipsPos.copy(this.hipsNode.position)
    }

    // Ground contact
    if (this.motion.contacts) {
      this.vrm.scene.updateMatrixWorld(true)
      let minY = Infinity
      const c = this.motion.contacts[frame]
      for (const [foot, ci] of [['leftFoot', 1], ['rightFoot', 3]]) {
        if (c[ci] > 0.5) {
          const y = this.vrm.humanoid.getNormalizedBoneNode(foot).getWorldPosition(new THREE.Vector3()).y
          minY = Math.min(minY, y)
        }
      }
      if (isFinite(minY)) {
        const err = groundY - minY
        this._groundCorr += (err - this._groundCorr) * contactSmoothing
        if (writeHipsPosition) this.hipsNode.position.y += this._groundCorr
      }
    }

    this.vrm.humanoid.update()
    return snapshot
  }

  /**
   * Current lowpassed ground-contact correction (meters). When
   * applyFrame runs with writeHipsPosition:false, the external hips owner
   * adds this to its own hips Y instead.
   */
  get groundCorrection() { return this._groundCorr }

  /**
   * Apply multiple frames. More efficient than per-frame calls if
   * you don't need the snapshot for validation.
   */
  applyBatch(frameStart, frameCount) {
    const end = Math.min(frameStart + frameCount, this.motion.T)
    for (let f = frameStart; f < end; f++) {
      this.applyFrame(f)
    }
  }

  /** Signal chunk boundary — resets ground correction (streaming). */
  onReset() { this._groundCorr = 0 }

  /**
   * Read back a bone's retargeted world-space quaternion.
   * Call after applyFrame().
   */
  getBoneQuaternion(boneName) {
    const node = this.vrm.humanoid.getNormalizedBoneNode(boneName)
    if (!node) return null
    this.vrm.scene.updateMatrixWorld(true)
    const q = new THREE.Quaternion()
    node.getWorldQuaternion(q)
    return q
  }

  /** Read back the current hips world position. */
  getHipsPosition() {
    this.vrm.scene.updateMatrixWorld(true)
    return this.hipsNode.getWorldPosition(new THREE.Vector3())
  }

  // ── Private helpers ─────────────────────────────────────────────────

  /** @private */
  _srcWorldQuat(jointName, frame) {
    const m9 = this.motion.rot[frame]?.[this.jointIndex[jointName]]
    if (!m9) return new THREE.Quaternion()
    const M = new THREE.Matrix4().set(
      m9[0], m9[1], m9[2], 0,
      m9[3], m9[4], m9[5], 0,
      m9[6], m9[7], m9[8], 0,
      0, 0, 0, 1,
    )
    return new THREE.Quaternion().setFromRotationMatrix(M)
  }

  // ── IK: FABRIK foot locking ─────────────────────────────────────────

  /**
   * Optional IK pass: adjust leg chains to keep contacted feet planted.
   * Call AFTER applyFrame().  Reads FK world positions, solves FABRIK for
   * each leg whose foot contact confidence > 0.5, then writes adjusted
   * local rotations back to the VRM bones.
   *
   * @param {number} frame  Frame index (used to read contact data)
   * @param {object} opts
   * @param {number} opts.maxIterations  FABRIK iterations (default 8)
   * @param {number} opts.groundY  Ground plane Y (default 0)
   */
  solveFootIK(frame, opts = {}) {
    const { maxIterations = 8, groundY = 0 } = opts
    const contacts = this.motion.contacts?.[frame]
    if (!contacts) return

    const chains = [
      { bones: ['leftUpperLeg', 'leftLowerLeg', 'leftFoot'], ci: 1,
        hip: 'leftUpperLeg', knee: 'leftLowerLeg', foot: 'leftFoot' },
      { bones: ['rightUpperLeg', 'rightLowerLeg', 'rightFoot'], ci: 3,
        hip: 'rightUpperLeg', knee: 'rightLowerLeg', foot: 'rightFoot' },
    ]

    this.vrm.scene.updateMatrixWorld(true)

    for (const ch of chains) {
      if (contacts[ch.ci] <= 0.5) continue

      // Read FK world positions of chain joints
      const p = ch.bones.map(b => {
        const v = new THREE.Vector3()
        this.vrm.humanoid.getNormalizedBoneNode(b).getWorldPosition(v)
        return v
      })

      // Segment lengths (from current FK pose — should be invariant)
      const segLen = []
      for (let i = 0; i < p.length - 1; i++) segLen.push(p[i].distanceTo(p[i + 1]))
      if (segLen.some(l => l < 0.001)) continue  // degenerate chain

      // Target: lock foot in place, clamp to ground
      const target = p[p.length - 1].clone()
      if (target.y < groundY) target.y = groundY
      const origin = p[0].clone()

      // FABRIK: forward (end→root) then backward (root→end)
      for (let iter = 0; iter < maxIterations; iter++) {
        // Forward
        p[p.length - 1].copy(target)
        for (let i = p.length - 2; i >= 0; i--) {
          const d = new THREE.Vector3().subVectors(p[i], p[i + 1]).normalize()
          p[i].copy(p[i + 1]).add(d.multiplyScalar(segLen[i]))
        }
        // Backward
        p[0].copy(origin)
        for (let i = 0; i < p.length - 1; i++) {
          const d = new THREE.Vector3().subVectors(p[i + 1], p[i]).normalize()
          p[i + 1].copy(p[i]).add(d.multiplyScalar(segLen[i]))
        }
      }

      // Convert IK world positions → local rotations for each bone.
      // Use the FK bone direction as reference and rotate to match the
      // IK direction via setFromUnitVectors.
      for (let i = 0; i < p.length - 1; i++) {
        const boneNode = this.vrm.humanoid.getNormalizedBoneNode(ch.bones[i])
        // FK direction: from bone to its child in world space
        const fkChildPos = new THREE.Vector3()
        this.vrm.humanoid.getNormalizedBoneNode(ch.bones[i + 1]).getWorldPosition(fkChildPos)
        const bonePos = new THREE.Vector3()
        boneNode.getWorldPosition(bonePos)
        const fkDir = new THREE.Vector3().subVectors(fkChildPos, bonePos).normalize()

        // IK direction: from bone pivot to child pivot
        const ikDir = new THREE.Vector3().subVectors(p[i + 1], p[i]).normalize()

        // Rotation delta: FK axis → IK axis
        const deltaQ = new THREE.Quaternion().setFromUnitVectors(fkDir, ikDir)

        // Current world rotation of this bone
        const curWorldQ = new THREE.Quaternion()
        boneNode.getWorldQuaternion(curWorldQ)

        // New world = delta × current
        const newWorldQ = deltaQ.clone().multiply(curWorldQ)

        // Convert to local under parent
        const parentKey = this.vrmParent[ch.bones[i]]
        if (parentKey) {
          const parentQ = new THREE.Quaternion()
          const pn = this.vrm.humanoid.getNormalizedBoneNode(parentKey)
          if (pn) {
            pn.getWorldQuaternion(parentQ)
            boneNode.quaternion.copy(parentQ.invert().multiply(newWorldQ))
            continue
          }
        }
        boneNode.quaternion.copy(newWorldQ)
      }
    }

    this.vrm.humanoid.update()
  }
}
