import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { Object3D } from 'three'

import {
  adaptViewerMotion,
  createStudioViewerRetargeter,
  isStudioCalibrationProfile,
} from '../debug/StudioProfileRuntime.js'

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url)))

function concatenate(chunks) {
  const first = chunks[0]
  const jointIndex = new Map(first.joints.map((name, index) => [name, index]))
  return {
    skeleton: first.skeleton,
    sourceSkeleton: first.source_skeleton ?? first.skeleton,
    rotationSpace: first.rotation_space ?? 'global',
    fps: first.fps,
    joints: first.joints,
    parentIdx: first.parents.map((parent) => (
      parent === null ? -1 : jointIndex.get(parent)
    )),
    offsets: first.rest_offsets_m,
    rot: chunks.flatMap((chunk) => chunk.global_rot_mats),
    root: chunks.flatMap((chunk) => chunk.root_positions),
    contacts: chunks.flatMap((chunk) => chunk.foot_contacts),
  }
}

test('normal viewer consumes a validated Studio profile deterministically', async () => {
  const [profile, avatarRig, canonicalSkeleton, ...chunks] = await Promise.all([
    readJson('../calibration-studio/evidence/tai.humanoid54.foot-ik.validated.json'),
    readJson('../calibration-studio/evidence/tai.humanoid54.avatar-rig-ir.json'),
    readJson('../calibration-studio/contracts/soma77.skeleton.json'),
    readJson('../debug/data/capture-turn-chunk_000.json'),
    readJson('../debug/data/capture-turn-chunk_001.json'),
    readJson('../debug/data/capture-turn-chunk_002.json'),
  ])
  assert.equal(isStudioCalibrationProfile(profile), true)

  const motion = await adaptViewerMotion(concatenate(chunks), canonicalSkeleton)
  assert.equal(motion.skeleton_id, 'soma77')
  assert.equal(motion.frame_count, 120)

  const objectByRigId = new Map(profile.mapping.map((mapping) => [
    mapping.target_bone_id,
    new Object3D(),
  ]))
  const retargeter = createStudioViewerRetargeter({
    profile,
    avatarRig,
    motion,
    canonicalSkeleton,
    objectByRigId,
  })

  retargeter.applyFrame(0)
  retargeter.applyFrame(1)
  const first = structuredClone(retargeter.applyFrame(37))
  retargeter.onReset()
  const replayed = structuredClone(retargeter.applyFrame(37))
  assert.deepEqual(replayed, first)
  for (const object of objectByRigId.values()) {
    assert.equal(object.position.toArray().every(Number.isFinite), true)
    assert.equal(object.quaternion.toArray().every(Number.isFinite), true)
  }
})

test('normal viewer refuses a draft Studio profile at runtime', async () => {
  const [profile, avatarRig, canonicalSkeleton, source] = await Promise.all([
    readJson('../calibration-studio/evidence/tai.humanoid54.calibration.draft.json'),
    readJson('../calibration-studio/evidence/tai.humanoid54.avatar-rig-ir.json'),
    readJson('../calibration-studio/contracts/soma77.skeleton.json'),
    readJson('../debug/data/capture-turn-chunk_000.json'),
  ])
  const motion = await adaptViewerMotion(concatenate([source]), canonicalSkeleton)
  const objectByRigId = new Map(profile.mapping.map((mapping) => [
    mapping.target_bone_id,
    new Object3D(),
  ]))
  const retargeter = createStudioViewerRetargeter({
    profile,
    avatarRig,
    motion,
    canonicalSkeleton,
    objectByRigId,
  })
  assert.throws(
    () => retargeter.applyFrame(0),
    /runtime profile must have status "validated"|requires a validated profile/,
  )
})

test('a kimodo somaskel77 capture loads under the validated Studio profile (regression t_983e0f42)', async () => {
  const [profile, avatarRig, canonicalSkeleton, kimodo] = await Promise.all([
    readJson('../calibration-studio/evidence/tai.humanoid54.foot-ik.validated.json'),
    readJson('../calibration-studio/evidence/tai.humanoid54.avatar-rig-ir.json'),
    readJson('../calibration-studio/contracts/soma77.skeleton.json'),
    readJson('../debug/data/kimodo_05f37604cdc2_1783916923.json'),
  ])
  assert.equal(kimodo.skeleton, 'somaskel77')
  assert.equal(kimodo.joints.length, 30)

  const motion = await adaptViewerMotion(concatenate([kimodo]), canonicalSkeleton)
  assert.equal(motion.skeleton_id, 'soma77')
  assert.equal(motion.joints.length, 77)
  assert.equal(motion.frame_count, 150)
  assert.equal(motion.source.adapter, 'soma30-to-soma77-qualification')

  const objectByRigId = new Map(profile.mapping.map((mapping) => [
    mapping.target_bone_id,
    new Object3D(),
  ]))
  const retargeter = createStudioViewerRetargeter({
    profile,
    avatarRig,
    motion,
    canonicalSkeleton,
    objectByRigId,
  })
  retargeter.applyFrame(0)
  const posed = structuredClone(retargeter.applyFrame(37))
  for (const object of objectByRigId.values()) {
    assert.equal(object.position.toArray().every(Number.isFinite), true)
    assert.equal(object.quaternion.toArray().every(Number.isFinite), true)
  }
  retargeter.onReset()
  const replayed = structuredClone(retargeter.applyFrame(37))
  assert.deepEqual(replayed, posed)
})

test('the lossless SOMA77 carrier (kmd-lossless-150) loads under the validated Studio profile (t_44d64179)', async () => {
  const [profile, avatarRig, canonicalSkeleton, lossless] = await Promise.all([
    readJson('../calibration-studio/evidence/tai.humanoid54.foot-ik.validated.json'),
    readJson('../calibration-studio/evidence/tai.humanoid54.avatar-rig-ir.json'),
    readJson('../calibration-studio/contracts/soma77.skeleton.json'),
    readJson('../calibration-studio/evidence/kimodo-150.soma77.json'),
  ])
  assert.equal(lossless.skeleton, 'soma77')
  assert.equal(lossless.joints.length, 77)

  // Debug-page shape: concatChunks → viewerMotionJson → adaptMotionJson
  // (viewerMotionJson is exercised through adaptViewerMotion, the same call
  // the debug page makes; strict lossless pass-through via the converter).
  const motion = await adaptViewerMotion(concatenate([lossless]), canonicalSkeleton)
  assert.equal(motion.skeleton_id, 'soma77')
  assert.equal(motion.joints.length, 77)
  assert.equal(motion.frame_count, 150)
  assert.equal(motion.source.adapter, 'lossless-converter-json')

  // Measured hands/eyes survive the pass-through (studio-identical joints).
  const meanSqDev = (name) => {
    const i = motion.joints.indexOf(name)
    assert.ok(i >= 0, `lossless IR retains ${name}`)
    const m0 = motion.global_rot_mats[0][i]
    let acc = 0
    for (let f = 1; f < motion.global_rot_mats.length; f += 1) {
      const m = motion.global_rot_mats[f][i]
      for (let k = 0; k < 9; k += 1) acc += (m[k] - m0[k]) ** 2
    }
    return acc / (motion.global_rot_mats.length - 1)
  }
  for (const name of ['LeftEye', 'RightEye', 'Jaw', 'LeftHandIndex1', 'LeftHandPinky3']) {
    assert.ok(meanSqDev(name) > 1e-3, `${name} retains non-degenerate motion`)
  }

  const objectByRigId = new Map(profile.mapping.map((mapping) => [
    mapping.target_bone_id,
    new Object3D(),
  ]))
  const retargeter = createStudioViewerRetargeter({
    profile,
    avatarRig,
    motion,
    canonicalSkeleton,
    objectByRigId,
  })
  retargeter.applyFrame(0)
  const posed = structuredClone(retargeter.applyFrame(37))
  for (const object of objectByRigId.values()) {
    assert.equal(object.position.toArray().every(Number.isFinite), true)
    assert.equal(object.quaternion.toArray().every(Number.isFinite), true)
  }
  retargeter.onReset()
  const replayed = structuredClone(retargeter.applyFrame(37))
  assert.deepEqual(replayed, posed)
})

// ── Debug-page source-reference view (t_900a10ee) ───────────────────
// The debug page renders its stick skeleton from skelMotion() =
// viewMotion ?? motion, where viewMotion is studioMotionView() — the
// adapted canonical carrier in the debug motion shape. These helpers
// mirror ardy.js exactly (studioMotionView + fkPositions) so the node
// probe exercises the same mapping the page uses.
function studioMotionView(studioMotion) {
  const nameIdx = new Map(studioMotion.joints.map((n, i) => [n, i]))
  return {
    skeleton: studioMotion.skeleton_id,
    joints: studioMotion.joints,
    parentIdx: studioMotion.parents.map((p) => (p === null ? -1 : nameIdx.get(p))),
    offsets: studioMotion.rest_offsets_m,
    rot: studioMotion.global_rot_mats,
    root: studioMotion.root_positions,
    T: studioMotion.frame_count,
  }
}

function fkPositions(view, f) {
  const J = view.joints.length
  const pos = new Float64Array(J * 3)
  pos[0] = view.root[f][0]; pos[1] = view.root[f][1]; pos[2] = view.root[f][2]
  for (let j = 1; j < view.parentIdx.length; j += 1) {
    const p = view.parentIdx[j]
    const m = view.rot[f][p]
    const o = view.offsets[j]
    const px = pos[p * 3], py = pos[p * 3 + 1], pz = pos[p * 3 + 2]
    pos[j * 3] = px + m[0] * o[0] + m[1] * o[1] + m[2] * o[2]
    pos[j * 3 + 1] = py + m[3] * o[0] + m[4] * o[1] + m[5] * o[2]
    pos[j * 3 + 2] = pz + m[6] * o[0] + m[7] * o[1] + m[8] * o[2]
  }
  return pos
}

function assertFinitePosed(view, frames) {
  for (const f of frames) {
    const pos = fkPositions(view, f)
    for (let j = 0; j < view.joints.length; j += 1) {
      assert.ok(
        Number.isFinite(pos[j * 3]) && Number.isFinite(pos[j * 3 + 1]) && Number.isFinite(pos[j * 3 + 2]),
        `frame ${f} joint ${view.joints[j]} must pose to finite world position`,
      )
    }
  }
}

test('debug view of the adapted kimodo carrier FK poses 77 canonical joints incl. fingers (t_900a10ee)', async () => {
  const [canonicalSkeleton, kimodo] = await Promise.all([
    readJson('../calibration-studio/contracts/soma77.skeleton.json'),
    readJson('../debug/data/kimodo_05f37604cdc2_1783916923.json'),
  ])
  const adapted = await adaptViewerMotion(concatenate([kimodo]), canonicalSkeleton)
  const view = studioMotionView(adapted)

  // View shape: full canonical contract, debug motion shape.
  assert.equal(view.skeleton, 'soma77')
  assert.equal(view.joints.length, 77)
  assert.equal(view.parentIdx.length, 77)
  assert.equal(view.offsets.length, 77)
  assert.equal(view.T, 150)
  for (const finger of ['LeftHandIndex1', 'LeftHandMiddle3', 'RightHandPinky4', 'LeftHandThumb3']) {
    assert.ok(view.joints.includes(finger), `view retains ${finger}`)
  }
  for (const [j, name] of view.joints.entries()) {
    if (j > 0) assert.ok(view.parentIdx[j] >= 0 && view.parentIdx[j] < j, `parent of ${name} precedes it`)
  }

  assertFinitePosed(view, [0, 37, 149])

  // The expanded carrier must reproduce every measured source joint's world
  // position exactly (collapsed rest offsets + inherited rotations).
  const source = concatenate([kimodo])
  const srcView = {
    joints: source.joints,
    parentIdx: source.parentIdx,
    offsets: source.offsets,
    rot: source.rot,
    root: source.root,
  }
  const srcIdx = new Map(source.joints.map((n, i) => [n, i]))
  let maxErr = 0
  for (const f of [0, 37, 149]) {
    const pos = fkPositions(view, f)
    const srcPos = fkPositions(srcView, f)
    for (const name of source.joints) {
      const j = view.joints.indexOf(name)
      const s = srcIdx.get(name)
      const err = Math.hypot(
        pos[j * 3] - srcPos[s * 3],
        pos[j * 3 + 1] - srcPos[s * 3 + 1],
        pos[j * 3 + 2] - srcPos[s * 3 + 2],
      )
      maxErr = Math.max(maxErr, err)
    }
  }
  assert.ok(maxErr < 1e-5, `adapted view must reproduce measured source joints exactly (max err ${maxErr.toExponential(2)} m)`)
})

test('debug view of the lossless carrier FK poses finite 77 canonical joints (t_900a10ee)', async () => {
  const [canonicalSkeleton, lossless] = await Promise.all([
    readJson('../calibration-studio/contracts/soma77.skeleton.json'),
    readJson('../calibration-studio/evidence/kimodo-150.soma77.json'),
  ])
  const adapted = await adaptViewerMotion(concatenate([lossless]), canonicalSkeleton)
  const view = studioMotionView(adapted)
  assert.equal(view.skeleton, 'soma77')
  assert.equal(view.joints.length, 77)
  assert.equal(view.T, 150)
  assertFinitePosed(view, [0, 1, 37, 75, 149])
})
