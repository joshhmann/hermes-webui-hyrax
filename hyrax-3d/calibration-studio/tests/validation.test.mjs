import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { adaptConverterMotionJson } from '../adapters/soma-motion-json.js'
import {
  calibrateRoot,
  calibrateScale,
  captureRestCalibration,
  configureFootGroundIk,
} from '../core/calibration.js'
import { assertCalibrationProfile } from '../core/contracts.js'
import { solveRetargetFrame } from '../core/retarget.js'
import {
  promoteValidatedProfile,
  validateCalibration,
  verifyValidatedProfile,
} from '../core/validation.js'

const here = new URL('../', import.meta.url)
const load = async (path) => JSON.parse(await readFile(new URL(path, here)))
const contract = await load('contracts/soma77.skeleton.json')
const rig = await load('evidence/tai.avatar-rig-ir.json')
const draft = await load('evidence/tai.avatar-calibration.draft.json')
const converterMotion = await load('evidence/kimodo-150.soma77.json')
const hardcodedBaseline = await load('evidence/tai-hardcoded-baseline.json')
const secondRig = await load(
  'evidence/avatar-9042366629077953442.avatar-rig-ir.json',
)
const secondProfile = await load(
  'evidence/avatar-9042366629077953442.calibration.validated.json',
)
const compatibilityProfile = await load(
  'evidence/tai.legacy-compatibility.validated.json',
)
const compatibilityComparison = await load(
  'evidence/tai-legacy-compat-vs-hardcoded.json',
)
const footIkProfile = await load('evidence/tai.foot-ik.validated.json')
const footIkEvidence = await load('evidence/tai.foot-ik.validation-evidence.json')
const detailedTaiRig = await load('evidence/tai.humanoid54.avatar-rig-ir.json')
const detailedTaiProfile = await load(
  'evidence/tai.humanoid54.calibration.validated.json',
)
const detailedTaiEvidence = await load(
  'evidence/tai.humanoid54.validation-evidence.json',
)
const qualifiedTaiProfile = await load(
  'evidence/tai.humanoid54.foot-ik.validated.json',
)
const qualifiedTaiEvidence = await load(
  'evidence/tai.humanoid54.foot-ik.validation-evidence.json',
)
const motion = await adaptConverterMotionJson(converterMotion, contract)

function calibratedDraft() {
  let profile = captureRestCalibration({
    profile: draft,
    avatarRig: rig,
    motion,
    frame: 0,
    canonicalSkeleton: contract,
  })
  profile = calibrateRoot({
    profile,
    avatarRig: rig,
    motion,
    frame: 0,
    canonicalSkeleton: contract,
  })
  return calibrateScale({
    profile,
    avatarRig: rig,
    motion,
    canonicalSkeleton: contract,
  })
}

test('the pure consumer records all four transforms for every driven bone', () => {
  const pose = solveRetargetFrame({
    profile: calibratedDraft(),
    avatarRig: rig,
    motion,
    frame: 74,
    canonicalSkeleton: contract,
  })
  assert.equal(pose.bones.length, draft.mapping.length)
  for (const bone of pose.bones) {
    assert.equal(bone.local_position.length, 3)
    assert.equal(bone.local_quaternion.length, 4)
    assert.equal(bone.world_position.length, 3)
    assert.equal(bone.world_quaternion.length, 4)
  }
})

test('the pure consumer includes unmapped intermediate target rest rotations', () => {
  const quarterTurnZ = [0, 0, Math.SQRT1_2, Math.SQRT1_2]
  const identity = [0, 0, 0, 1]
  const transform = (position, quaternion) => ({
    position,
    quaternion,
    scale: [1, 1, 1],
  })
  const syntheticRig = {
    schema: 'soma.avatar-rig-ir',
    schema_version: '1.0.0',
    rig_id: 'intermediate-parent-rig',
    rig_signature: 'sha256:intermediate-parent-rig',
    source: {
      format: 'glb',
      format_version: '2.0',
      asset_signature: 'sha256:intermediate-parent-asset',
      importer: 'test',
      importer_version: '1',
      rig_space: 'raw',
      basis_correction: 'none',
    },
    coordinate_system: {
      status: 'declared',
      handedness: 'right',
      up_axis: '+Y',
      forward_axis: '+Z',
      linear_unit: 'meter',
    },
    bones: [
      {
        id: 'root',
        name: 'Root',
        parent_id: null,
        semantic: 'hips',
        rest_local: transform([0, 0, 0], identity),
        rest_world: transform([0, 0, 0], identity),
      },
      {
        id: 'helper',
        name: 'Helper',
        parent_id: 'root',
        semantic: null,
        rest_local: transform([0, 1, 0], quarterTurnZ),
        rest_world: transform([0, 1, 0], quarterTurnZ),
      },
      {
        id: 'head',
        name: 'Head',
        parent_id: 'helper',
        semantic: 'head',
        rest_local: transform([1, 0, 0], identity),
        rest_world: transform([0, 2, 0], quarterTurnZ),
      },
    ],
  }
  const syntheticProfile = {
    schema: 'soma.avatar-calibration',
    schema_version: '1.0.0',
    profile_id: 'intermediate-parent-profile',
    status: 'draft',
    soma_contract: {
      id: 'soma77',
      version: '1.0.0',
      signature: `sha256:${'0'.repeat(64)}`,
    },
    avatar: {
      format: 'glb',
      asset_signature: syntheticRig.source.asset_signature,
      rig_signature: syntheticRig.rig_signature,
    },
    mapping: [
      {
        semantic: 'hips',
        soma_joint: 'Hips',
        target_bone_id: 'root',
        target_parent_semantic: null,
      },
      {
        semantic: 'head',
        soma_joint: 'Head',
        target_bone_id: 'head',
        target_parent_semantic: 'hips',
      },
    ],
    rest_calibration: {
      rotation_model: 'test',
      source_frame: 0,
      per_bone: {
        hips: {
          status: 'captured',
          source_rest_world_quaternion: identity,
          source_rest_inverse_quaternion: identity,
          target_rest_world_quaternion: identity,
          target_parent_rest_world_quaternion: identity,
          target_parent_rest_world_position: [0, 0, 0],
          user_offset_quaternion: identity,
        },
        head: {
          status: 'captured',
          source_rest_world_quaternion: identity,
          source_rest_inverse_quaternion: identity,
          target_rest_world_quaternion: quarterTurnZ,
          target_parent_rest_world_quaternion: quarterTurnZ,
          target_parent_rest_world_position: [0, 1, 0],
          user_offset_quaternion: identity,
        },
      },
    },
    root_calibration: {
      status: 'calibrated',
      source_rest_position_m: [0, 0, 0],
      target_rest_world_position_m: [0, 0, 0],
      enabled_axes: ['x', 'y', 'z'],
    },
    scale_calibration: {
      status: 'calibrated',
      translation_scale: 1,
    },
    ik: { enabled: false, targets: {} },
    validation: null,
  }
  const identityMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1]
  const syntheticMotion = {
    schema: 'soma.motion-ir',
    schema_version: '1.0.0',
    skeleton_id: 'soma77',
    skeleton_version: '1.0.0',
    skeleton_signature: `sha256:${'1'.repeat(64)}`,
    motion_signature: `sha256:${'2'.repeat(64)}`,
    rotation_space: 'global',
    rotation_representation: 'mat3-row-major',
    fps: 30,
    frame_count: 1,
    joints: contract.joints.map((joint) => joint.name),
    parents: contract.joints.map((joint) => joint.parent),
    global_rot_mats: [contract.joints.map(() => identityMatrix)],
    root_positions: [[0, 0, 0]],
    rest_offsets_m: contract.joints.map(() => [0, 0, 0]),
  }
  const pose = solveRetargetFrame({
    profile: syntheticProfile,
    avatarRig: syntheticRig,
    motion: syntheticMotion,
    frame: 0,
    canonicalSkeleton: contract,
  })
  const head = pose.bones.find((bone) => bone.semantic === 'head')
  assert.deepEqual(head.local_quaternion, identity)
  assert.deepEqual(head.world_position.map((value) => Math.round(value)), [0, 2, 0])
})

test('fixed Kimodo frames reproduce byte-for-byte and promote explicitly', async () => {
  const profile = calibratedDraft()
  const evidence = await validateCalibration({
    profile,
    avatarRig: rig,
    motion,
    frames: [0, 37, 74, 111, 149],
    canonicalSkeleton: contract,
  })
  assert.equal(evidence.passed, true)
  assert.equal(evidence.result.repeat_canonical_delta, 0)
  assert.deepEqual(evidence.result.issues, [])
  const promoted = promoteValidatedProfile({
    profile,
    evidence,
    avatarRig: rig,
    canonicalSkeleton: contract,
  })
  assert.equal(promoted.status, 'validated')
  assert.equal(
    assertCalibrationProfile(promoted, {
      requireComplete: true,
      avatarRig: rig,
      canonicalSkeleton: contract,
    }),
    promoted,
  )
})

test('promotion fails closed without passing signed evidence', () => {
  assert.throws(
    () => promoteValidatedProfile({
      profile: calibratedDraft(),
      evidence: { passed: false, result: { issues: ['failed'] } },
      avatarRig: rig,
      canonicalSkeleton: contract,
    }),
    /only passing validation/,
  )
})

test('capability-aware evidence fails closed when required core roles are missing', async () => {
  const incomplete = calibratedDraft()
  incomplete.authoring = {
    coverage: {
      core_complete: false,
      missing_required: ['hips'],
    },
  }
  await assert.rejects(
    validateCalibration({
      profile: incomplete,
      avatarRig: rig,
      motion,
      frames: [0],
      canonicalSkeleton: contract,
    }),
    /missing required core humanoid mappings/,
  )
})

test('the untouched Tai baseline covers every required clip class twice', () => {
  assert.equal(hardcodedBaseline.deterministic, true)
  assert.equal(hardcodedBaseline.runs, 2)
  assert.equal(hardcodedBaseline.canonical_repeat_delta, 0)
  assert.deepEqual(
    hardcodedBaseline.clips.map((clip) => clip.id),
    [
      'rest-pose',
      'known-good-cskel27',
      'corrected-kimodo-soma77',
      'locomotion-turn',
      'torso-arm-crouch',
    ],
  )
  for (const clip of hardcodedBaseline.clips) {
    for (const sample of clip.samples) {
      assert.equal(sample.bones.length, 22)
      for (const bone of sample.bones) {
        assert.equal(bone.local_position.length, 3)
        assert.equal(bone.local_quaternion.length, 4)
        assert.equal(bone.world_position.length, 3)
        assert.equal(bone.world_quaternion.length, 4)
      }
    }
  }
})

test('the same SOMA motion validates a second non-Tai avatar profile', () => {
  assert.notEqual(secondRig.rig_signature, rig.rig_signature)
  assert.notEqual(
    secondProfile.scale_calibration.translation_scale,
    calibratedDraft().scale_calibration.translation_scale,
  )
  assert.equal(secondProfile.status, 'validated')
  assert.equal(
    assertCalibrationProfile(secondProfile, {
      requireComplete: true,
      avatarRig: secondRig,
      canonicalSkeleton: contract,
    }),
    secondProfile,
  )
})

test('the optional compatibility profile reproduces legacy Tai within tolerance', async () => {
  await verifyValidatedProfile({
    profile: compatibilityProfile,
    avatarRig: rig,
    canonicalSkeleton: contract,
  })
  assert.equal(compatibilityComparison.passed, true)
  assert.ok(
    compatibilityComparison.metrics.local_position_m.max
      <= compatibilityComparison.tolerance.position_m,
  )
  assert.ok(
    compatibilityComparison.metrics.world_angular_rad.max
      <= compatibilityComparison.tolerance.angular_rad,
  )
})

test('the detailed Tai profile deterministically drives 54 controls with tiered coverage', async () => {
  assert.equal(detailedTaiProfile.mapping.length, 54)
  assert.equal(detailedTaiProfile.authoring.coverage.core_complete, true)
  assert.deepEqual(detailedTaiProfile.authoring.coverage.groups.hands, {
    mapped: 30,
    total: 30,
    required: 0,
  })
  assert.equal(detailedTaiEvidence.passed, true)
  assert.equal(detailedTaiEvidence.result.driven_bone_count, 54)
  assert.equal(detailedTaiEvidence.result.repeat_canonical_delta, 0)
  await verifyValidatedProfile({
    profile: detailedTaiProfile,
    avatarRig: detailedTaiRig,
    canonicalSkeleton: contract,
  })
})

test('the checked-in Tai turn qualification is signed and runtime eligible', async () => {
  await verifyValidatedProfile({
    profile: qualifiedTaiProfile,
    avatarRig: detailedTaiRig,
    canonicalSkeleton: contract,
  })
  assert.equal(qualifiedTaiEvidence.passed, true)
  assert.deepEqual(qualifiedTaiEvidence.result.issues, [])
  assert.equal(
    qualifiedTaiProfile.validation.qualification_motion_signature,
    qualifiedTaiEvidence.suite.qualification_motion_signature,
  )
  for (const target of Object.values(
    qualifiedTaiEvidence.result.qualification.targets,
  )) {
    assert(target.active_frames > 0)
    assert(target.inactive_frames > 0)
    assert(target.transitions > 0)
    assert(target.maximum_target_residual_m <= target.tolerance_m)
    assert(target.maximum_pelvis_lowering_m <= 0.08)
    assert(
      target.maximum_orientation_residual_deg
      <= target.orientation_tolerance_deg,
    )
  }
})

test('signed runtime corrections fail closed after mutation', async () => {
  const mutated = structuredClone(compatibilityProfile)
  mutated.runtime_corrections.ground_contact.smoothing_factor = 0.5
  await assert.rejects(
    verifyValidatedProfile({
      profile: mutated,
      avatarRig: rig,
      canonicalSkeleton: contract,
    }),
    /does not match its signed input/,
  )
})

test('optional foot IK is separately configured, signed, and residual-bounded', async () => {
  await verifyValidatedProfile({
    profile: footIkProfile,
    avatarRig: rig,
    canonicalSkeleton: contract,
  })
  assert.equal(footIkProfile.ik.enabled, true)
  assert.deepEqual(footIkEvidence.result.issues, [])
  for (const snapshot of footIkEvidence.result.snapshots) {
    for (const [targetId, result] of Object.entries(snapshot.ik)) {
      assert.ok(result.error_m <= footIkProfile.ik.targets[targetId].tolerance_m)
    }
  }
})

test('temporal IK qualification fails closed when contact release is unproven', async () => {
  const profile = configureFootGroundIk({
    profile: calibratedDraft(),
    avatarRig: rig,
    enabled: true,
    groundY: 0,
    soleOffsetM: {
      leftFoot: 0.1,
      rightFoot: 0.1,
    },
    lockHorizontal: true,
    lockOrientation: true,
    lockBlendFrames: 4,
    contactHysteresis: 0.1,
    useRestPosePoles: true,
  })
  const evidence = await validateCalibration({
    profile,
    avatarRig: rig,
    motion,
    frames: [0, 149],
    canonicalSkeleton: contract,
  })
  assert.equal(evidence.passed, false)
  assert.equal(
    evidence.result.qualification.tier,
    'fk-determinism-plus-temporal-foot-ik',
  )
  assert(
    evidence.result.issues.some(
      (issue) => issue.includes('does not exercise contact release'),
    ),
  )
})

test('temporal IK can use a distinct signed motion for contact qualification', async () => {
  const profile = configureFootGroundIk({
    profile: calibratedDraft(),
    avatarRig: rig,
    enabled: true,
    groundY: 0,
    soleOffsetM: {
      leftFoot: 0.1,
      rightFoot: 0.1,
    },
    lockHorizontal: true,
    lockOrientation: true,
    lockBlendFrames: 4,
    contactHysteresis: 0.1,
    useRestPosePoles: true,
  })
  const qualificationMotion = structuredClone(motion)
  qualificationMotion.motion_signature = `sha256:${'9'.repeat(64)}`
  qualificationMotion.foot_contacts = qualificationMotion.foot_contacts.map(
    (_, frame) => {
      const planted = Math.floor(frame / 10) % 2
      return planted ? [1, 1, 0, 0] : [0, 0, 1, 1]
    },
  )
  const evidence = await validateCalibration({
    profile,
    avatarRig: rig,
    motion,
    qualificationMotion,
    frames: [0, 149],
    canonicalSkeleton: contract,
  })
  assert.equal(evidence.result.qualification.distinct_motion, true)
  assert.equal(
    evidence.result.qualification.motion_signature,
    qualificationMotion.motion_signature,
  )
  assert.equal(
    evidence.suite.qualification_motion_signature,
    qualificationMotion.motion_signature,
  )
  assert(
    !evidence.result.issues.some(
      (issue) => issue.includes('does not exercise contact release'),
    ),
  )
  for (const target of Object.values(evidence.result.qualification.targets)) {
    assert(target.fully_locked_orientation_frames > 0)
    assert(
      target.maximum_orientation_residual_deg
      <= target.orientation_tolerance_deg,
    )
  }
})
