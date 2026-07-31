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
