/**
 * SelfCollision tests (bounded capsule push-out).
 *
 * Fake rig: a minimal FK chain (world transforms computed on the fly from
 * parent links — no three.js). Covers:
 *  1. capsule derivation from the skeleton (lengths from pose-invariant
 *     local offsets, radii from the data block);
 *  2. a forced hand-through-chest pose gets rotated OUT (penetration
 *     decreases to ≈0 within the angle budget);
 *  3. bounds: a penetration needing >15° is LEFT (fail-open) and the joint
 *     never exceeds its total budget — no exploded pose;
 *  4. no penetration → no-op (quats untouched); disabled → no-op;
 *  5. hot path: 1200 frames without a retarget, bounded + telemetry sane.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { SelfCollision, SELF_COLLISION_CONFIG } from '../src/embodiment/collision/SelfCollision.ts'

// ── Minimal quaternion / vector helpers (tests may allocate) ────────

function qmul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ]
}

function qrot(q, v) {
  const [x, y, z, w] = q
  const tx = 2 * (y * v[2] - z * v[1])
  const ty = 2 * (z * v[0] - x * v[2])
  const tz = 2 * (x * v[1] - y * v[0])
  return [v[0] + w * tx + y * tz - z * ty, v[1] + w * ty + z * tx - x * tz, v[2] + w * tz + x * ty - y * tx]
}

function qAxisAngleZ(deg) {
  const r = (deg * Math.PI) / 360
  return [0, 0, Math.sin(r), Math.cos(r)]
}

function quatAngleDeg(a, b) {
  const dot = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))
  return 2 * Math.acos(dot) * 180 / Math.PI
}

// ── FK fake rig ─────────────────────────────────────────────────────

function makeBone(bones, name, parentName, offset) {
  const bone = {
    name,
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
    position: { x: offset[0], y: offset[1], z: offset[2] },
    getWorldQuaternion(target) {
      const local = [bone.quaternion.x, bone.quaternion.y, bone.quaternion.z, bone.quaternion.w]
      const parent = parentName ? bones.get(parentName) : null
      if (!parent) {
        target.x = local[0]; target.y = local[1]; target.z = local[2]; target.w = local[3]
        return target
      }
      const pq = { x: 0, y: 0, z: 0, w: 1 }
      parent.getWorldQuaternion(pq)
      const world = qmul([pq.x, pq.y, pq.z, pq.w], local)
      target.x = world[0]; target.y = world[1]; target.z = world[2]; target.w = world[3]
      return target
    },
    getWorldPosition(target) {
      const parent = parentName ? bones.get(parentName) : null
      if (!parent) {
        target.x = bone.position.x; target.y = bone.position.y; target.z = bone.position.z
        return target
      }
      const pq = { x: 0, y: 0, z: 0, w: 1 }
      parent.getWorldQuaternion(pq)
      const pp = { x: 0, y: 0, z: 0 }
      parent.getWorldPosition(pp)
      const rotated = qrot([pq.x, pq.y, pq.z, pq.w], [bone.position.x, bone.position.y, bone.position.z])
      target.x = pp.x + rotated[0]; target.y = pp.y + rotated[1]; target.z = pp.z + rotated[2]
      return target
    },
  }
  bones.set(name, bone)
  return bone
}

function makeRig() {
  const bones = new Map()
  const mk = (name, parent, offset) => makeBone(bones, name, parent, offset)
  mk('hips', null, [0, 0.9, 0])
  mk('chest', 'hips', [0, 0.25, 0])
  mk('neck', 'chest', [0, 0.25, 0])
  mk('head', 'neck', [0, 0.12, 0])
  mk('leftUpperArm', 'chest', [-0.18, 0.28, 0])
  mk('leftLowerArm', 'leftUpperArm', [-0.28, 0, 0])
  mk('leftHand', 'leftLowerArm', [-0.26, 0, 0])
  mk('rightUpperArm', 'chest', [0.18, 0.28, 0])
  mk('rightLowerArm', 'rightUpperArm', [0.28, 0, 0])
  mk('rightHand', 'rightLowerArm', [0.26, 0, 0])
  mk('leftUpperLeg', 'hips', [-0.1, -0.05, 0])
  mk('leftLowerLeg', 'leftUpperLeg', [0, -0.42, 0])
  mk('rightUpperLeg', 'hips', [0.1, -0.05, 0])
  mk('rightLowerLeg', 'rightUpperLeg', [0, -0.42, 0])
  return {
    bones,
    vrm: {
      humanoid: { getNormalizedBoneNode: (name) => bones.get(name) ?? null },
      scene: {
        position: { x: 0, y: 0, z: 0 },
        quaternion: { x: 0, y: 0, z: 0, w: 1 },
        getWorldQuaternion(t) { t.x = 0; t.y = 0; t.z = 0; t.w = 1; return t },
        getWorldPosition(t) { t.x = 0; t.y = 0; t.z = 0; return t },
      },
    },
  }
}

function setQuat(bone, q) {
  bone.quaternion.x = q[0]; bone.quaternion.y = q[1]
  bone.quaternion.z = q[2]; bone.quaternion.w = q[3]
}

function getQuat(bone) {
  return [bone.quaternion.x, bone.quaternion.y, bone.quaternion.z, bone.quaternion.w]
}

/** Torso-only config for correction tests (fake proportions: radius 0.15). */
const TORSO_CONFIG = {
  CAPSULES: [{ name: 'torso', boneA: 'hips', boneB: 'chest', radiusFactor: 0.6, minRadius: 0.1 }],
  TARGETS: [
    { name: 'leftHand', bone: 'leftHand', chain: ['leftLowerArm', 'leftUpperArm'], radius: 0.03, ignoreCapsules: [] },
  ],
}

function handPen(sc) {
  const r = sc.report().find((e) => e.target === 'leftHand')
  return r ? r.penetrationM : null
}

// ── Tests ───────────────────────────────────────────────────────────

test('capsule derivation: lengths from local offsets, radii from the data block', () => {
  const { vrm } = makeRig()
  const sc = new SelfCollision(vrm)
  const caps = Object.fromEntries(sc.describeCapsules().map((c) => [c.name, c]))
  assert.equal(sc.capsuleCount, 7)
  assert.deepEqual(sc.skipped, [])
  assert(Math.abs(caps.torso.length - 0.25) < 1e-9)
  assert(Math.abs(caps.torso.radius - Math.max(0.6 * 0.25, 0.1)) < 1e-9)
  assert(Math.abs(caps.head.length - 0.12) < 1e-9)
  assert(Math.abs(caps.head.radius - Math.max(1.3 * 0.12, 0.12)) < 1e-9)
  assert(Math.abs(caps.leftUpperArm.length - 0.28) < 1e-9)
  assert(Math.abs(caps.leftThigh.radius - Math.max(0.22 * 0.42, 0.05)) < 1e-9)
})

test('hand through chest: rotated OUT within budget; per-frame step ≤ 5°', () => {
  const { bones, vrm } = makeRig()
  const sc = new SelfCollision(vrm, TORSO_CONFIG)
  // Arm down, elbow bent 13.35°: hand at (-0.12, 0.797, 0) — 0.06 m inside.
  setQuat(bones.get('leftUpperArm'), qAxisAngleZ(90))
  setQuat(bones.get('leftLowerArm'), qAxisAngleZ(13.35))
  const pen0 = handPen(sc)
  assert(pen0 !== null && pen0 > 0.04, `forced penetration present (got ${pen0})`)

  let prevElbow = getQuat(bones.get('leftLowerArm'))
  for (let i = 0; i < 12; i += 1) {
    sc.correct(1 / 60)
    const step = quatAngleDeg(prevElbow, getQuat(bones.get('leftLowerArm')))
    assert(step <= 5.0 + 1e-6, `per-frame step ${step.toFixed(2)}° ≤ 5°`)
    prevElbow = getQuat(bones.get('leftLowerArm'))
  }
  const pen1 = handPen(sc)
  assert(pen1 < pen0, `penetration decreased (${pen0.toFixed(3)} → ${pen1.toFixed(3)})`)
  assert(pen1 <= SELF_COLLISION_CONFIG.EPS_PEN_M + 1e-9, `resolved to ≤ eps (got ${pen1})`)
  assert(sc.telemetry().correctionsTotal > 0)
  const total = quatAngleDeg(getQuat(bones.get('leftLowerArm')), qAxisAngleZ(13.35))
  assert(total <= 15.0 + 1e-6, `total correction ${total.toFixed(1)}° within budget`)
})

test('bounds respected: penetration needing >15° is LEFT, not exploded (fail-open)', () => {
  const { bones, vrm } = makeRig()
  const sc = new SelfCollision(vrm, TORSO_CONFIG)
  // Elbow 90°: hand at (0.08, 1.05, 0) — 0.10 m deep, escape needs ≈22° at
  // the elbow, more than the 15° total budget (shoulder is the fallback).
  setQuat(bones.get('leftUpperArm'), qAxisAngleZ(90))
  setQuat(bones.get('leftLowerArm'), qAxisAngleZ(90))
  const elbow0 = getQuat(bones.get('leftLowerArm'))
  const shoulder0 = getQuat(bones.get('leftUpperArm'))
  const pen0 = handPen(sc)
  assert(pen0 > 0.08)

  for (let i = 0; i < 60; i += 1) sc.correct(1 / 60)
  const elbowTotal = quatAngleDeg(getQuat(bones.get('leftLowerArm')), elbow0)
  const shoulderTotal = quatAngleDeg(getQuat(bones.get('leftUpperArm')), shoulder0)
  assert(elbowTotal <= 15.0 + 0.5, `elbow total ${elbowTotal.toFixed(1)}° ≤ 15° budget`)
  assert(shoulderTotal <= 15.0 + 0.5, `shoulder total ${shoulderTotal.toFixed(1)}° ≤ 15° budget`)
  const pen1 = handPen(sc)
  assert(pen1 > 0, `unresolvable penetration is LEFT (got ${pen1.toFixed(3)})`)
  assert(pen1 < pen0, 'partial improvement still happened within budget')
})

test('no penetration → no-op; disabled → no-op', () => {
  const { bones, vrm } = makeRig()
  const sc = new SelfCollision(vrm, TORSO_CONFIG)
  const elbow0 = getQuat(bones.get('leftLowerArm'))
  const clean = handPen(sc)
  assert(clean !== null && clean <= 0, `rest arm is clean (got ${clean})`)
  sc.correct(1 / 60)
  assert.equal(sc.telemetry().correctionsTotal, 0)
  assert.deepEqual(getQuat(bones.get('leftLowerArm')), elbow0, 'quats untouched when clean')

  // Force penetration, then disable: no correction may run.
  setQuat(bones.get('leftUpperArm'), qAxisAngleZ(90))
  setQuat(bones.get('leftLowerArm'), qAxisAngleZ(90))
  sc.setEnabled(false)
  sc.correct(1 / 60)
  assert.equal(sc.telemetry().correctionsTotal, 0, 'disabled pass is a no-op')
  assert.equal(sc.telemetry().enabled, false)
})

test('hot path: 1200 frames bounded; telemetry sane; same probe object reuse', () => {
  const { bones, vrm } = makeRig()
  const sc = new SelfCollision(vrm, TORSO_CONFIG)
  setQuat(bones.get('leftUpperArm'), qAxisAngleZ(90))
  setQuat(bones.get('leftLowerArm'), qAxisAngleZ(30))
  for (let i = 0; i < 600; i += 1) sc.correct(1 / 60) // penetrating phase
  setQuat(bones.get('leftUpperArm'), qAxisAngleZ(0))
  setQuat(bones.get('leftLowerArm'), qAxisAngleZ(0))
  for (let i = 0; i < 600; i += 1) sc.correct(1 / 60) // clean phase
  const tel = sc.telemetry()
  assert(Number.isFinite(tel.avgCostUs) && tel.avgCostUs >= 0)
  assert(tel.avgCostUs < 2000, `avg cost ${tel.avgCostUs.toFixed(0)} µs is sane (node, fake rig)`)
  assert(Number.isFinite(tel.correctionsPerSec))
  assert(tel.correctionsTotal > 0)
})
