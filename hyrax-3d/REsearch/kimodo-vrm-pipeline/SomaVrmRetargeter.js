// SomaVrmRetargeter.js — retarget Kimodo/ARDY global rotations onto a VRM
// through the normalized rig. three >= 0.160, @pixiv/three-vrm v3.
// Corrections vs. naive version: both skeleton maps, measured source rest pose,
// scene-root yaw ownership, explicit parent-before-child traversal.
import * as THREE from 'three';

// VRM bone <- source joint, per skeleton. Core27 trap: "LeftLeg" is the KNEE there.
export const BONE_MAPS = {
  somaskel30: {
    hips: 'Hips', spine: 'Spine1', chest: 'Spine2', upperChest: 'Chest',
    neck: 'Neck1', head: 'Head',
    leftShoulder: 'LeftShoulder', rightShoulder: 'RightShoulder',
    leftUpperArm: 'LeftArm', rightUpperArm: 'RightArm',
    leftLowerArm: 'LeftForeArm', rightLowerArm: 'RightForeArm',
    leftHand: 'LeftHand', rightHand: 'RightHand',
    leftUpperLeg: 'LeftLeg', rightUpperLeg: 'RightLeg',   // SOMA: Leg = thigh
    leftLowerLeg: 'LeftShin', rightLowerLeg: 'RightShin',
    leftFoot: 'LeftFoot', rightFoot: 'RightFoot',
    leftToes: 'LeftToeBase', rightToes: 'RightToeBase',
  },
  cskel27: {
    hips: 'Hips', spine: 'Spine', chest: 'Spine1', upperChest: 'Spine2',
    neck: 'Neck', head: 'Head',
    leftShoulder: 'LeftShoulder', rightShoulder: 'RightShoulder',
    leftUpperArm: 'LeftArm', rightUpperArm: 'RightArm',
    leftLowerArm: 'LeftForeArm', rightLowerArm: 'RightForeArm',
    leftHand: 'LeftHand', rightHand: 'RightHand',
    leftUpperLeg: 'LeftUpLeg', rightUpperLeg: 'RightUpLeg', // Core27: UpLeg = thigh
    leftLowerLeg: 'LeftLeg', rightLowerLeg: 'RightLeg',     // Core27: Leg = knee!
    leftFoot: 'LeftFoot', rightFoot: 'RightFoot',
    leftToes: 'LeftToeBase', rightToes: 'RightToeBase',
  },
};
BONE_MAPS.somaskel77 = BONE_MAPS.somaskel30;

// Explicit topological order — never rely on object insertion order.
const SOLVE_ORDER = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes'];
const VRM_PARENT = { spine: 'hips', chest: 'spine', upperChest: 'chest', neck: 'upperChest',
  head: 'neck', leftShoulder: 'upperChest', rightShoulder: 'upperChest',
  leftUpperArm: 'leftShoulder', rightUpperArm: 'rightShoulder',
  leftLowerArm: 'leftUpperArm', rightLowerArm: 'rightUpperArm',
  leftHand: 'leftLowerArm', rightHand: 'rightLowerArm',
  leftUpperLeg: 'hips', rightUpperLeg: 'hips',
  leftLowerLeg: 'leftUpperLeg', rightLowerLeg: 'rightUpperLeg',
  leftFoot: 'leftLowerLeg', rightFoot: 'rightLowerLeg',
  leftToes: 'leftFoot', rightToes: 'rightFoot' };

export class SomaVrmRetargeter {
  /**
   * @param {VRM} vrm   loaded VRM 1.0 model
   * @param {object} motion  parsed JSON from npz_to_json.py (has .skeleton)
   * @param {object} opts.sceneRoot  optional THREE.Object3D owning world XZ/yaw (interactive use)
   */
  constructor(vrm, motion, opts = {}) {
    this.vrm = vrm;
    this.motion = motion;
    this.sceneRoot = opts.sceneRoot ?? null;
    this.map = BONE_MAPS[motion.skeleton];
    if (!this.map) throw new Error(`No bone map for skeleton "${motion.skeleton}"`);
    this.jointIndex = Object.fromEntries(motion.joints.map((n, i) => [n, i]));

    // MEASURED source rest pose: use frame 0 only if the motion starts at rest;
    // otherwise measure from the skeleton asset / joints.p (audit GAP-3).
    this.offsets = {};
    for (const [bone, joint] of Object.entries(this.map)) {
      if (!vrm.humanoid.getNormalizedBoneNode(bone)) continue;
      const rest = this._srcWorld(joint, opts.restFrame ?? 0, new THREE.Quaternion());
      this.offsets[bone] = rest.invert();  // normalized rig rest is identity
    }

    const hipsNode = vrm.humanoid.getNormalizedBoneNode('hips');
    hipsNode.userData.restY = hipsNode.position.y;
    const hipsWorldY = hipsNode.getWorldPosition(new THREE.Vector3()).y;
    // Measured source hips height — Core27 ≈ 0.954 m; pass real value via opts.
    this.hipsScale = hipsWorldY / (opts.srcHipsHeight ?? 0.954);
  }

  _srcWorld(jointName, frame, outQuat) {
    // ARDY exports mat3 flattened ROW-major. THREE.Matrix4.fromArray expects
    // COLUMN-major (and 16 elements) — using it here would silently transpose
    // every rotation. Matrix4.set() takes row-major arguments — use that.
    const m9 = this.motion.global_rot_mats[frame][this.jointIndex[jointName]];
    const M = new THREE.Matrix4().set(
      m9[0], m9[1], m9[2], 0,
      m9[3], m9[4], m9[5], 0,
      m9[6], m9[7], m9[8], 0,
      0, 0, 0, 1,
    );
    return outQuat.setFromRotationMatrix(M);   // matrix space: no wxyz/xyzw trap
  }

  applyFrame(frame, groundY = 0, contactSmoothing = 0.4) {
    const world = {};
    const q = new THREE.Quaternion();
    for (const bone of SOLVE_ORDER) {                       // parents before children
      const joint = this.map[bone];
      if (!joint || !this.offsets[bone]) continue;
      const node = this.vrm.humanoid.getNormalizedBoneNode(bone);
      let W = this._srcWorld(joint, frame, q).multiply(this.offsets[bone]).clone();
      if (bone === 'hips' && this.sceneRoot) {
        // Strip scene yaw from the pelvis — yaw lives on the scene root (double-yaw fix).
        const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -this.sceneRoot.rotation.y);
        W = yaw.multiply(W);
      }
      world[bone] = W;
      const parentW = world[VRM_PARENT[bone]];
      node.quaternion.copy(parentW ? q.copy(parentW).invert().multiply(W) : W);
    }

    // Hips translation: scaled pelvis trajectory (never Kimodo's smooth_root_pos).
    const hips = this.vrm.humanoid.getNormalizedBoneNode('hips');
    const p = this.motion.root_positions[frame];
    const p0 = this.motion.root_positions[0];
    hips.position.set((p[0] - p0[0]) * this.hipsScale,
                      hips.userData.restY + (p[1] - p0[1]) * this.hipsScale,
                      (p[2] - p0[2]) * this.hipsScale);

    // Contact-aware ground offset: channels [L-heel, L-toe, R-heel, R-toe], >0.5.
    const c = this.motion.foot_contacts[frame];
    this.vrm.scene.updateMatrixWorld(true);
    let minY = Infinity;
    for (const [foot, ci] of [['leftFoot', 1], ['rightFoot', 3]]) {
      if (c[ci] > 0.5) {
        const y = this.vrm.humanoid.getNormalizedBoneNode(foot).getWorldPosition(new THREE.Vector3()).y;
        minY = Math.min(minY, y);
      }
    }
    if (isFinite(minY)) {
      const err = groundY - minY;
      this._groundCorr = (this._groundCorr ?? 0) + (err - (this._groundCorr ?? 0)) * contactSmoothing;
      hips.position.y += this._groundCorr;
    }
    this.vrm.humanoid.update();
  }

  /** Streaming helper: call on chunk boundaries flagged reset=True — never interpolate across. */
  onReset() { this._groundCorr = 0; }
}
