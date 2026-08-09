/**
 * PickupSystem tests — bounded pickup (spatial layer 5).
 *
 * Spec: docs/gestalt-vn/specs/INTERACTABLES_SPEC.md (§ Pick-up (bounded v1))
 *
 *  - pickUp parents the mesh to the bone node with the bone-local offset
 *    (world = handWorld + R_bone·offset — the parenting math IS the attach;
 *    no IK, no physics, no per-frame code).
 *  - The mesh follows the bone when it moves (carry without IK).
 *  - Bounded interaction range: out-of-range pick-ups are refused
 *    (fail-closed, journaled), in-range ones attach.
 *  - One held object at a time; a second pick-up is refused.
 *  - putDown unparents, places the mesh at the authored home, restores the
 *    original parent; the probe reports the real placed position and the
 *    cup STAYS there (probe continuity after release).
 *  - A putdown for the wrong object / with nothing held is refused.
 *
 * Pure object-graph math: no DOM, no VRM, no WebGL.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { Object3D, Vector3 } from 'three'

import { PICKUP_RANGE_M, PickupSystem } from '../src/embodiment/interactables/PickupSystem.ts'

const CUP_HOME = new Vector3(0.2, 0.4, 1.15)
const ATTACH = { bone: 'rightHand', offset: [0, 0.05, 0] }

function makeWorld() {
  const scene = new Object3D()
  const mesh = new Object3D()
  mesh.position.copy(CUP_HOME)
  scene.add(mesh)
  const bone = new Object3D()
  bone.name = 'rightHand'
  bone.position.set(0.1, 1.2, 0.5)
  scene.add(bone)
  scene.updateMatrixWorld(true)
  return { scene, mesh, bone }
}

test('pickUp parents the mesh to the bone with the offset (world = hand + R·offset)', () => {
  const sys = new PickupSystem({ nowMs: () => 1000 })
  const { scene, mesh, bone } = makeWorld()
  const hold = sys.pickUp('cup', mesh, ATTACH, bone, { x: 0.1, z: 0.6 }, CUP_HOME)
  assert.ok(hold, 'in-range pick-up must attach')
  assert.equal(mesh.parent, bone, 'mesh must parent to the bone node')
  scene.updateMatrixWorld(true)
  const cupWorld = mesh.getWorldPosition(new Vector3())
  // Bone at (0.1, 1.2, 0.5), identity rotation: offset (0, 0.05, 0) →
  // cup at (0.1, 1.25, 0.5). Exact parenting math — the attach IS the truth.
  assert.ok(cupWorld.distanceTo(new Vector3(0.1, 1.25, 0.5)) < 1e-9,
    `cup world ${cupWorld.toArray()} must equal hand + offset`)
  assert.equal(sys.holding, true)
  assert.equal(sys.heldObjectId, 'cup')
})

test('pickUp honors the bone rotation (offset is bone-local)', () => {
  const sys = new PickupSystem({ nowMs: () => 1000 })
  const { scene, mesh, bone } = makeWorld()
  bone.rotation.y = Math.PI / 2 // rotates local +x toward -z
  scene.updateMatrixWorld(true)
  sys.pickUp('cup', mesh, ATTACH, bone, { x: 0.1, z: 0.6 }, CUP_HOME)
  scene.updateMatrixWorld(true)
  const cupWorld = mesh.getWorldPosition(new Vector3())
  // Offset (0, 0.05, 0) is along the bone's local Y — invariant under a
  // Y-axis rotation, so the cup still sits exactly above the hand.
  assert.ok(cupWorld.distanceTo(new Vector3(0.1, 1.25, 0.5)) < 1e-9,
    `cup world ${cupWorld.toArray()}`)
  // Sanity: a +X offset WOULD rotate — proves the offset is bone-local.
  const sys2 = new PickupSystem()
  const { scene: s2, mesh: m2, bone: b2 } = makeWorld()
  b2.rotation.y = Math.PI / 2
  s2.updateMatrixWorld(true)
  sys2.pickUp('cup', m2, { bone: 'rightHand', offset: [0.1, 0, 0] }, b2, { x: 0.1, z: 0.6 }, CUP_HOME)
  s2.updateMatrixWorld(true)
  const rotated = m2.getWorldPosition(new Vector3())
  assert.ok(rotated.distanceTo(new Vector3(0.1, 1.2, 0.4)) < 1e-9,
    `+x offset rotated 90° about Y must land at (0.1, 1.2, 0.4), got ${rotated.toArray()}`)
})

test('carry without IK: the mesh follows the bone exactly when it moves', () => {
  const sys = new PickupSystem({ nowMs: () => 1000 })
  const { scene, mesh, bone } = makeWorld()
  sys.pickUp('cup', mesh, ATTACH, bone, { x: 0.1, z: 0.6 }, CUP_HOME)
  // She walks: the bone sweeps across the room (walk cycle + root motion).
  for (let i = 0; i < 20; i += 1) {
    bone.position.x += 0.1
    bone.position.z -= 0.05
    bone.rotation.y += 0.02
    scene.updateMatrixWorld(true)
    const cupWorld = mesh.getWorldPosition(new Vector3())
    const probe = sys.probe()
    assert.ok(probe.attached && probe.holding === 'cup')
    assert.ok(probe.followErrorM !== null && probe.followErrorM < 1e-9,
      `carry-follow error ${probe.followErrorM} must be ~0 (parenting)`)
    assert.ok(probe.cupWorld !== null &&
      Math.abs(probe.cupWorld[0] - cupWorld.x) < 1e-9, 'probe reads the real mesh')
  }
})

test('bounded interaction range: out-of-range pick-up is refused, journaled, mesh untouched', () => {
  const sys = new PickupSystem({ nowMs: () => 1000 })
  const { scene, mesh, bone } = makeWorld()
  const far = { x: CUP_HOME.x + PICKUP_RANGE_M + 2, z: CUP_HOME.z }
  const hold = sys.pickUp('cup', mesh, ATTACH, bone, far, CUP_HOME)
  assert.equal(hold, null, 'out-of-range pick-up must be refused')
  assert.equal(sys.holding, false)
  assert.equal(mesh.parent, scene, 'mesh must stay in the scene when refused')
  assert.match(sys.lastReason, /out of bounded range/)
  const probe = sys.probe()
  assert.ok(probe.lastRangeRefusalM !== null && probe.lastRangeRefusalM > PICKUP_RANGE_M)
  // In-range still works after a refusal (no stuck state).
  const retry = sys.pickUp('cup', mesh, ATTACH, bone, { x: 0.1, z: 0.6 }, CUP_HOME)
  assert.ok(retry, 'in-range pick-up after a refusal must attach')
})

test('one held object at a time: a second pick-up is refused', () => {
  const sys = new PickupSystem({ nowMs: () => 1000 })
  const { mesh, bone } = makeWorld()
  assert.ok(sys.pickUp('cup', mesh, ATTACH, bone, { x: 0.1, z: 0.6 }, CUP_HOME))
  const second = new Object3D()
  const secondBone = new Object3D()
  const hold = sys.pickUp('cup2', second, ATTACH, secondBone, { x: 0.1, z: 0.6 }, new Vector3(0, 0, 0))
  assert.equal(hold, null, 'second pick-up while holding must be refused')
  assert.match(sys.lastReason, /already holding/)
  assert.equal(second.parent, null, 'second mesh must not be reparented')
})

test('missing bone is refused (fail-closed: no attach without a bone node)', () => {
  const sys = new PickupSystem({ nowMs: () => 1000 })
  const { mesh } = makeWorld()
  const hold = sys.pickUp('cup', mesh, ATTACH, null, { x: 0.1, z: 0.6 }, CUP_HOME)
  assert.equal(hold, null)
  assert.match(sys.lastReason, /bone .* not found/)
})

test('putDown unparents, places the mesh at home, restores the original parent', () => {
  const sys = new PickupSystem({ nowMs: () => 1000 })
  const { scene, mesh, bone } = makeWorld()
  sys.pickUp('cup', mesh, ATTACH, bone, { x: 0.1, z: 0.6 }, CUP_HOME)
  assert.equal(sys.putDown('cup'), true)
  assert.equal(sys.holding, false)
  assert.equal(mesh.parent, scene, 'mesh returns to its original parent')
  scene.updateMatrixWorld(true)
  const placed = mesh.getWorldPosition(new Vector3())
  assert.ok(placed.distanceTo(CUP_HOME) < 1e-9,
    `placed at home ${placed.toArray()}, expected ${CUP_HOME.toArray()}`)
  const probe = sys.probe()
  assert.equal(probe.holding, null)
  assert.deepEqual(probe.placedAt, CUP_HOME.toArray())
  assert.deepEqual(probe.cupWorld, CUP_HOME.toArray(), 'probe reads the real placed mesh')
  assert.deepEqual(probe.home, CUP_HOME.toArray())
})

test('putDown refuses: wrong object, and nothing held', () => {
  const sys = new PickupSystem({ nowMs: () => 1000 })
  const { mesh, bone } = makeWorld()
  assert.equal(sys.putDown('cup'), false, 'putdown with nothing held must be refused')
  assert.match(sys.lastReason, /nothing held/)
  sys.pickUp('cup', mesh, ATTACH, bone, { x: 0.1, z: 0.6 }, CUP_HOME)
  assert.equal(sys.putDown('other'), false, 'foreign putdown must not release the hold')
  assert.match(sys.lastReason, /does not match/)
  assert.equal(sys.holding, true, 'the hold survives a foreign putdown')
})

test('the placed cup STAYS (probe continuity: no re-attach, no drift in state)', () => {
  const sys = new PickupSystem({ nowMs: () => 1000 })
  const { scene, mesh, bone } = makeWorld()
  sys.pickUp('cup', mesh, ATTACH, bone, { x: 0.1, z: 0.6 }, CUP_HOME)
  sys.putDown('cup')
  // The hand keeps moving; the released mesh must not follow it.
  bone.position.x += 1.5
  scene.updateMatrixWorld(true)
  const probe = sys.probe()
  assert.equal(probe.attached, false)
  assert.equal(probe.holding, null)
  assert.deepEqual(probe.cupWorld, CUP_HOME.toArray(), 'released mesh stays at home')
})
