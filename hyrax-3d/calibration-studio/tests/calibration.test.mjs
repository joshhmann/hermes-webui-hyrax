import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  calibrateRoot,
  calibrateScale,
  calibrationReadiness,
  captureRestCalibration,
  mat3RowMajorToQuaternion,
  multiplyQuaternions,
  setBoneUserOffset,
} from '../core/calibration.js'
import {
  mappingCoverage,
  mirrorLocalOffset,
  somaWorldPositions,
} from '../core/authoring.js'
import {
  autoTuneReferencePose,
  referenceDirectionError,
} from '../core/auto-tune.js'
import { adaptConverterMotionJson } from '../adapters/soma-motion-json.js'

const here = new URL('../', import.meta.url)
const contract = JSON.parse(await readFile(new URL('contracts/soma77.skeleton.json', here)))
const rig = JSON.parse(await readFile(new URL('evidence/tai.avatar-rig-ir.json', here)))
const profile = JSON.parse(
  await readFile(new URL('evidence/tai.avatar-calibration.draft.json', here)),
)
const humanoid54 = JSON.parse(
  await readFile(new URL('contracts/humanoid54.authoring.json', here)),
)
const detailedRig = JSON.parse(
  await readFile(new URL('evidence/tai.humanoid54.avatar-rig-ir.json', here)),
)
const detailedProfile = JSON.parse(
  await readFile(new URL('evidence/tai.humanoid54.calibration.draft.json', here)),
)
const kimodoMotion = await adaptConverterMotionJson(
  JSON.parse(await readFile(new URL('evidence/kimodo-150.soma77.json', here))),
  contract,
)

function identityMotion() {
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1]
  return {
    schema: 'soma.motion-ir',
    schema_version: '1.0.0',
    skeleton_id: contract.id,
    skeleton_version: contract.version,
    skeleton_signature: `sha256:${'0'.repeat(64)}`,
    motion_signature: `sha256:${'1'.repeat(64)}`,
    rotation_space: 'global',
    rotation_representation: 'mat3-row-major',
    fps: 30,
    frame_count: 1,
    joints: contract.joints.map((joint) => joint.name),
    parents: contract.joints.map((joint) => joint.parent),
    global_rot_mats: [contract.joints.map(() => [...identity])],
    root_positions: [[0, 0.954, 0]],
    rest_offsets_m: contract.joints.map((joint, index) => {
      if (index === 0) return [0, 0.954, 0]
      if (joint.name === 'LeftLeg' || joint.name === 'RightLeg') return [0, -0.42, 0]
      if (joint.name === 'LeftShin' || joint.name === 'RightShin') return [0, -0.42, 0]
      if (joint.name === 'LeftFoot' || joint.name === 'RightFoot') return [0, -0.1, 0.05]
      return [0, 0.01, 0]
    }),
  }
}

test('row-major matrices use stable xyzw quaternion math', () => {
  assert.deepEqual(mat3RowMajorToQuaternion([1, 0, 0, 0, 1, 0, 0, 0, 1]), [0, 0, 0, 1])
  const halfTurnY = mat3RowMajorToQuaternion([-1, 0, 0, 0, 1, 0, 0, 0, -1])
  assert.ok(Math.abs(Math.abs(halfTurnY[1]) - 1) < 1e-12)
  assert.ok(Math.abs(halfTurnY[3]) < 1e-12)
  assert.deepEqual(multiplyQuaternions([0, 0, 0, 1], halfTurnY), halfTurnY)
})

test('rest, root, and scale calibration remain draft but become validation-ready', () => {
  const motion = identityMotion()
  const withRest = captureRestCalibration({
    profile,
    avatarRig: rig,
    motion,
    canonicalSkeleton: contract,
  })
  assert.equal(withRest.status, 'draft')
  assert.equal(Object.keys(withRest.rest_calibration.per_bone).length, profile.mapping.length)
  assert.equal(calibrationReadiness(withRest).root, false)

  const withRoot = calibrateRoot({
    profile: withRest,
    avatarRig: rig,
    motion,
    canonicalSkeleton: contract,
  })
  const complete = calibrateScale({
    profile: withRoot,
    avatarRig: rig,
    motion,
    canonicalSkeleton: contract,
  })
  const readiness = calibrationReadiness(complete)
  assert.equal(complete.status, 'draft')
  assert.equal(complete.validation, null)
  assert.equal(readiness.ready_for_validation, true)
  assert.ok(complete.scale_calibration.translation_scale > 0)
})

test('rest capture fails closed on an out-of-range frame', () => {
  assert.throws(
    () => captureRestCalibration({
      profile,
      avatarRig: rig,
      motion: identityMotion(),
      frame: 2,
      canonicalSkeleton: contract,
    }),
    /rest frame must be between/,
  )
})

test('per-bone user offsets are normalized and remain explicit draft data', () => {
  const withRest = captureRestCalibration({
    profile,
    avatarRig: rig,
    motion: identityMotion(),
    canonicalSkeleton: contract,
  })
  const changed = setBoneUserOffset({
    profile: withRest,
    semantic: 'leftUpperArm',
    quaternion: [0, 0, 2, 2],
    avatarRig: rig,
    canonicalSkeleton: contract,
  })
  assert.equal(changed.status, 'draft')
  assert.equal(changed.validation, null)
  const offset =
    changed.rest_calibration.per_bone.leftUpperArm.user_offset_quaternion
  assert.deepEqual(offset.slice(0, 2), [0, 0])
  assert(Math.abs(offset[2] - Math.SQRT1_2) < 1e-15)
  assert(Math.abs(offset[3] - Math.SQRT1_2) < 1e-15)
  assert.throws(
    () => setBoneUserOffset({
      profile: withRest,
      semantic: 'unmapped',
      quaternion: [0, 0, 0, 1],
      avatarRig: rig,
      canonicalSkeleton: contract,
    }),
    /before "unmapped" rest calibration is captured/,
  )
})

test('capability-aware coverage requires only the 17-role core', () => {
  const coreMapping = humanoid54.roles
    .filter((role) => role.required)
    .map((role) => ({ semantic: role.semantic }))
  const coverage = mappingCoverage(humanoid54, coreMapping)
  assert.equal(coverage.core_complete, true)
  assert.deepEqual(coverage.missing_required, [])
  assert.deepEqual(coverage.groups.core_body, {
    mapped: 17,
    total: 17,
    required: 17,
  })
  assert.equal(coverage.groups.hands.mapped, 0)
  assert.equal(mappingCoverage(humanoid54, coreMapping.slice(1)).core_complete, false)
})

test('paired offsets mirror through target rest bases instead of Euler signs', () => {
  const halfTurnY = [0, 1, 0, 0]
  const quarterTurnX = [Math.sin(Math.PI / 8), 0, 0, Math.cos(Math.PI / 8)]
  const mirrored = mirrorLocalOffset({
    quaternion: quarterTurnX,
    sourceRestWorldQuaternion: [0, 0, 0, 1],
    targetRestWorldQuaternion: halfTurnY,
  })
  assert(Math.abs(mirrored[0] + quarterTurnX[0]) < 1e-12)
  assert(Math.abs(mirrored[1]) < 1e-12)
  assert(Math.abs(mirrored[2]) < 1e-12)
  assert(Math.abs(mirrored[3] - quarterTurnX[3]) < 1e-12)
})

test('SOMA reference points use parent global rotations and an explicit root anchor', () => {
  const halfTurnZ = [-1, 0, 0, 0, -1, 0, 0, 0, 1]
  const referenceMotion = {
    frame_count: 1,
    joints: ['Hips', 'Spine1', 'Spine2'],
    parents: [null, 'Hips', 'Spine1'],
    rest_offsets_m: [[0, 0, 0], [1, 0, 0], [1, 0, 0]],
    root_positions: [[3, 4, 5]],
    global_rot_mats: [[halfTurnZ, halfTurnZ, halfTurnZ]],
  }
  assert.deepEqual(
    somaWorldPositions(referenceMotion, 0, {
      scale: 2,
      rootAnchor: [10, 20, 30],
    }).map((position) => position.map((value) => Math.round(value))),
    [[10, 20, 30], [8, 20, 30], [6, 20, 30]],
  )
})

test('automatic reference fitting is deterministic and reduces Tai direction error', () => {
  const withRest = captureRestCalibration({
    profile: detailedProfile,
    avatarRig: detailedRig,
    motion: kimodoMotion,
    frame: 0,
    canonicalSkeleton: contract,
  })
  const withRoot = calibrateRoot({
    profile: withRest,
    avatarRig: detailedRig,
    motion: kimodoMotion,
    frame: 0,
    canonicalSkeleton: contract,
  })
  const calibrated = calibrateScale({
    profile: withRoot,
    avatarRig: detailedRig,
    motion: kimodoMotion,
    canonicalSkeleton: contract,
  })
  const first = autoTuneReferencePose({
    profile: calibrated,
    avatarRig: detailedRig,
    motion: kimodoMotion,
    frame: 0,
    canonicalSkeleton: contract,
  })
  const second = autoTuneReferencePose({
    profile: calibrated,
    avatarRig: detailedRig,
    motion: kimodoMotion,
    frame: 0,
    canonicalSkeleton: contract,
  })

  assert.deepEqual(first, second)
  assert.equal(first.report.solver_version, '1.0.0')
  assert.equal(first.report.source_frame, 0)
  assert.equal(
    first.profile.authoring.validation_policy.reference_direction_mean_deg_max,
    5,
  )
  assert(first.report.applied_semantics.includes('leftUpperArm'))
  assert(first.report.applied_semantics.includes('rightUpperArm'))
  assert(first.report.skipped_semantics.includes('leftEye'))
  assert(first.report.mean_direction_error_deg_after
    < first.report.mean_direction_error_deg_before)

  const before = referenceDirectionError({
    profile: calibrated,
    avatarRig: detailedRig,
    motion: kimodoMotion,
    frame: 0,
  })
  const after = referenceDirectionError({
    profile: first.profile,
    avatarRig: detailedRig,
    motion: kimodoMotion,
    frame: 0,
  })
  assert(after.mean_degrees < before.mean_degrees)

  const armSuggestion =
    first.profile.authoring.auto_tuning.suggestions.leftUpperArm
  assert.equal(armSuggestion.confidence, 'swing-only')
  assert.equal(armSuggestion.twist_status, 'unresolved')
  assert.deepEqual(
    armSuggestion.final_offset_quaternion,
    armSuggestion.auto_offset_quaternion,
  )

  const refined = setBoneUserOffset({
    profile: first.profile,
    semantic: 'leftUpperArm',
    quaternion: [0, 0, 0, 1],
    avatarRig: detailedRig,
    canonicalSkeleton: contract,
  })
  const refinedSuggestion =
    refined.authoring.auto_tuning.suggestions.leftUpperArm
  assert.deepEqual(refinedSuggestion.final_offset_quaternion, [0, 0, 0, 1])
  assert.deepEqual(
    refinedSuggestion.manual_residual_quaternion,
    [
      -armSuggestion.auto_offset_quaternion[0],
      -armSuggestion.auto_offset_quaternion[1],
      -armSuggestion.auto_offset_quaternion[2],
      armSuggestion.auto_offset_quaternion[3],
    ],
  )
})
