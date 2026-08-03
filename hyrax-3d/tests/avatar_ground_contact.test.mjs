/**
 * AvatarRetargeter ground-contact correction tests (shared math — the loft's
 * profiled live path AND the debug page run this code).
 *
 * Fake VRM models the real descendant propagation: foot world Y = posed Y +
 * hips delta (the correction moves the whole body through the hips write).
 * Covers:
 *  1. EXACT fixed point: measuring against the uncorrected pose converges to
 *     the full correction (the old lagged measurement settled at half — the
 *     documented ~2× undershoot).
 *  2. Toe bones drive toe contacts: a pointed toe below its rest silhouette
 *     LIFTS the hips even when the ankle silhouette reads clean.
 *  3. Deepest-point semantics: a penetrating foot wins over a planted one;
 *     the float gate ignores garbage "contact" bits high above the floor
 *     (crouches/sit/lie still pass).
 *  4. Rest silhouette heights are measured per bone at setMotion; rigs
 *     without toe bones fall back to the ankle.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import * as THREE from 'three'

import { AvatarRetargeter } from '../calibrate/AvatarRetargeter.js'

const PROFILE = {
  skeleton_maps: {
    test: {
      hips: 'Hips',
      leftFoot: 'LeftFoot',
      leftToes: 'LeftToes',
      rightFoot: 'RightFoot',
      rightToes: 'RightToes',
    },
  },
  solve_order: ['hips', 'leftFoot', 'leftToes', 'rightFoot', 'rightToes'],
  vrm_bone_parents: { hips: null, leftFoot: 'hips', leftToes: 'leftFoot', rightFoot: 'hips', rightToes: 'rightFoot' },
  rest_pose: { default_src_hips_height_m: 0.954, rest_frame_default: 0 },
}

const JOINTS = ['Hips', 'LeftFoot', 'LeftToes', 'RightFoot', 'RightToes']
const IDENT_MAT = [1, 0, 0, 0, 1, 0, 0, 0, 1]

function makeMotion(contacts) {
  return {
    skeleton: 'test',
    joints: JOINTS,
    rot: [JOINTS.map(() => IDENT_MAT.slice())],
    root: [[0, 0.954, 0]],
    contacts: [contacts],
  }
}

/**
 * Fake VRM. `restY` = each foot bone's world Y at the normalized rest pose
 * (set at construction, when setMotion measures). `poseFoot(bone, y)` moves
 * a foot for the "current frame"; world Y = posed Y + hips delta, so the
 * ground correction propagates to the feet like on a real rig.
 */
function makeVrm(restY) {
  const hipsNode = {
    quaternion: new THREE.Quaternion(),
    position: new THREE.Vector3(0, 0.954, 0),
    userData: {},
    getWorldPosition(t) { t.x = this.position.x; t.y = this.position.y; t.z = this.position.z; return t },
  }
  const posed = { ...restY }
  const nodes = new Map()
  nodes.set('hips', hipsNode)
  const hipsRestY = hipsNode.position.y
  for (const bone of ['leftFoot', 'leftToes', 'rightFoot', 'rightToes']) {
    if (!(bone in restY)) continue
    nodes.set(bone, {
      quaternion: new THREE.Quaternion(),
      position: { x: 0, y: restY[bone], z: 0 },
      getWorldPosition(t) {
        t.x = 0
        t.y = posed[bone] + (hipsNode.position.y - hipsRestY)
        t.z = 0
        return t
      },
    })
  }
  return {
    nodes,
    hipsNode,
    poseFoot(bone, y) { posed[bone] = y },
    footWorldY(bone) {
      const t = new THREE.Vector3()
      return nodes.get(bone).getWorldPosition(t).y
    },
    humanoid: {
      getNormalizedBoneNode: (name) => nodes.get(name) ?? null,
      update() {},
    },
    scene: {
      position: { x: 0, y: 0, z: 0 },
      updateMatrixWorld() {},
    },
    meta: { metaVersion: '1.0' },
  }
}

function build(vrm, contacts) {
  const ret = new AvatarRetargeter(vrm, PROFILE, { srcHipsHeight: 0.954, restFrame: 0 })
  ret.setMotion(makeMotion(contacts))
  assert(ret.boneMap, 'test skeleton map resolved')
  return ret
}

// Contact confidence arrays [L-heel, L-toe, R-heel, R-toe] (the shape
// ProfiledLiveRetargeter.bitmaskToContacts produces).

/** Run n frames on the LIVE path semantics (writeHipsPosition:false — the
 * RootMotionAdapter owns the hips and adds groundCorrection afterward,
 * mirrored here exactly like ProfiledLiveRetargeter.applyPose). */
function runLive(ret, vrm, frames = 12) {
  for (let i = 0; i < frames; i += 1) {
    ret.applyFrame(0, { writeHipsPosition: false })
    vrm.hipsNode.position.y = 0.954 + ret.groundCorrection
  }
}

test('live path: exact fixed point — full correction, not the ~2× undershoot', () => {
  const vrm = makeVrm({ leftFoot: 0.05, rightFoot: 0.05 })
  const ret = build(vrm, [1, 0, 0, 0]) // L-heel contact
  vrm.poseFoot('leftFoot', 0.15) // pose floats 10 cm above its rest silhouette
  runLive(ret, vrm)
  // err = 0 − (0.15 − 0.05) = −0.10 exactly (lagged measurement settled at −0.075).
  assert(Math.abs(ret.groundCorrection - -0.10) < 0.006,
    `correction converges to −0.10 (got ${ret.groundCorrection.toFixed(4)})`)
  assert(Math.abs(vrm.footWorldY('leftFoot') - 0.05) < 0.006,
    `rendered foot back at its rest silhouette (got ${vrm.footWorldY('leftFoot').toFixed(3)})`)
})

test('debug path (writeHipsPosition:true): already exact — unchanged by the live fix', () => {
  const vrm = makeVrm({ leftFoot: 0.05, rightFoot: 0.05 })
  const ret = build(vrm, [1, 0, 0, 0])
  vrm.poseFoot('leftFoot', 0.15)
  for (let i = 0; i < 12; i += 1) ret.applyFrame(0)
  assert(Math.abs(ret.groundCorrection - -0.10) < 0.006,
    `correction converges to −0.10 (got ${ret.groundCorrection.toFixed(4)})`)
  assert(Math.abs(vrm.hipsNode.position.y - (0.954 - 0.10)) < 0.006,
    'hips carry the correction on the debug path too')
})

test('toe contact: a pointed toe below its rest silhouette LIFTS, even with a clean ankle', () => {
  const vrm = makeVrm({ leftFoot: 0.05, leftToes: 0.01, rightFoot: 0.05, rightToes: 0.01 })
  const ret = build(vrm, [0, 1, 0, 0]) // L-toe contact only
  vrm.poseFoot('leftFoot', 0.05) // ankle exactly at its silhouette (clean)
  vrm.poseFoot('leftToes', 0.0) // toe joint 1 cm BELOW its silhouette
  runLive(ret, vrm)
  assert(Math.abs(ret.groundCorrection - 0.01) < 0.004,
    `toe drives a +0.01 lift (got ${ret.groundCorrection.toFixed(4)})`)
  assert(Math.abs(vrm.footWorldY('leftToes') - 0.01) < 0.004,
    'toe joint back at its rest silhouette')
})

test('deepest point wins across feet; float gate ignores garbage high contacts', () => {
  const vrm = makeVrm({ leftFoot: 0.05, rightFoot: 0.05 })
  const ret = build(vrm, [1, 0, 1, 0]) // both heels "contacting"
  // Left genuinely planted low (silhouette −0.05), right garbage-floating
  // (silhouette +0.30): the penetrating foot drives, the garbage one is
  // naturally outvoted by the max.
  vrm.poseFoot('leftFoot', 0.0)
  vrm.poseFoot('rightFoot', 0.35)
  runLive(ret, vrm)
  assert(Math.abs(ret.groundCorrection - 0.05) < 0.004,
    `planted foot drives +0.05 (got ${ret.groundCorrection.toFixed(4)})`)

  // BOTH contacts floating high (airborne pose with garbage bits): the gate
  // holds the lowpass — no correction at all.
  const vrm2 = makeVrm({ leftFoot: 0.05, rightFoot: 0.05 })
  const ret2 = build(vrm2, [1, 0, 1, 0])
  vrm2.poseFoot('leftFoot', 0.35)
  vrm2.poseFoot('rightFoot', 0.40)
  runLive(ret2, vrm2)
  assert.equal(ret2.groundCorrection, 0, 'float gate: airborne "contacts" ignored')

  // Crouch/sit with feet planted (silhouette ≈ −0.02) still passes the gate.
  const vrm3 = makeVrm({ leftFoot: 0.05, rightFoot: 0.05 })
  const ret3 = build(vrm3, [1, 0, 1, 0])
  vrm3.poseFoot('leftFoot', 0.03)
  vrm3.poseFoot('rightFoot', 0.035)
  runLive(ret3, vrm3)
  assert(ret3.groundCorrection > 0.01,
    `planted low feet still correct (got ${ret3.groundCorrection.toFixed(4)})`)
})

test('rest silhouette heights measured per bone; toeless rigs fall back to the ankle', () => {
  const vrm = makeVrm({ leftFoot: 0.055, rightFoot: 0.052 })
  const ret = build(vrm, [1, 0, 0, 0])
  assert(Math.abs(ret._restFootY.leftFoot - 0.055) < 1e-9)
  assert(Math.abs(ret._restFootY.rightFoot - 0.052) < 1e-9)
  assert(!('leftToes' in ret._restFootY), 'missing toe bones are skipped')

  // Toe contact on a toeless rig: the ankle fallback answers ci=1.
  const ret2 = build(vrm, [0, 1, 0, 0])
  vrm.poseFoot('leftFoot', 0.155)
  runLive(ret2, vrm)
  assert(Math.abs(ret2.groundCorrection - -0.10) < 0.006,
    `ankle fallback drives toe contacts (got ${ret2.groundCorrection.toFixed(4)})`)
})
