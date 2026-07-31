import {
  assertAvatarRigIR,
  assertCalibrationProfile,
  assertSomaMotionIR,
  canonicalStringify,
  contractSignature,
} from './contracts.js?v=10'
import { calibrationReadiness } from './calibration.js?v=10'
import {
  createRetargetSession,
  solveRetargetFrame,
} from './retarget.js?v=9'
import { referenceDirectionError } from './auto-tune.js?v=4'

function validatePose(pose, tolerance, profile) {
  const issues = []
  for (const bone of pose.bones) {
    for (const [field, length] of [
      ['local_position', 3],
      ['local_quaternion', 4],
      ['world_position', 3],
      ['world_quaternion', 4],
    ]) {
      if (!Array.isArray(bone[field])
          || bone[field].length !== length
          || bone[field].some((value) => !Number.isFinite(value))) {
        issues.push(`${bone.semantic}.${field} is not finite`)
      }
    }
    for (const field of ['local_quaternion', 'world_quaternion']) {
      const norm = Math.hypot(...bone[field])
      if (Math.abs(norm - 1) > tolerance.quaternion_norm_absolute) {
        issues.push(`${bone.semantic}.${field} norm ${norm} exceeds tolerance`)
      }
    }
  }
  for (const [targetId, result] of Object.entries(pose.ik ?? {})) {
    const targetTolerance = profile.ik.targets[targetId]?.tolerance_m
    if (!Number.isFinite(result.error_m)
        || result.error_m > targetTolerance) {
      issues.push(
        `${targetId} IK error ${result.error_m} exceeds ${targetTolerance}`,
      )
    }
  }
  return issues
}

function contactCoverage(motion, target) {
  const active = motion.foot_contacts.map(
    (contacts) => contacts[target.contact_channel] > target.contact_threshold,
  )
  let transitions = 0
  let longestActiveStreak = 0
  let streak = 0
  active.forEach((isActive, index) => {
    streak = isActive ? streak + 1 : 0
    longestActiveStreak = Math.max(longestActiveStreak, streak)
    if (index > 0 && isActive !== active[index - 1]) transitions += 1
  })
  return {
    frame_count: active.length,
    active_frames: active.filter(Boolean).length,
    inactive_frames: active.filter((value) => !value).length,
    transitions,
    longest_active_streak: longestActiveStreak,
  }
}

function quaternionAngleDegrees(left, right) {
  const leftLength = Math.hypot(...left)
  const rightLength = Math.hypot(...right)
  const cosine = left.reduce(
    (sum, value, index) => sum + value * right[index],
    0,
  ) / (leftLength * rightLength)
  return 2 * Math.acos(Math.min(1, Math.abs(cosine))) * 180 / Math.PI
}

export async function validateCalibration({
  profile,
  avatarRig,
  motion,
  qualificationMotion = null,
  frames,
  canonicalSkeleton = null,
  tolerance = {
    quaternion_norm_absolute: 1e-9,
    repeat_canonical_bytes: 0,
  },
}) {
  assertAvatarRigIR(avatarRig)
  assertSomaMotionIR(motion, canonicalSkeleton)
  if (qualificationMotion) {
    assertSomaMotionIR(qualificationMotion, canonicalSkeleton)
  }
  assertCalibrationProfile(profile, { avatarRig, canonicalSkeleton })
  const readiness = calibrationReadiness(profile)
  if (!readiness.ready_for_validation) {
    throw new Error('profile calibration is incomplete')
  }
  if (profile.authoring?.coverage?.core_complete === false) {
    throw new Error('profile is missing required core humanoid mappings')
  }
  const samples = [...new Set(frames)]
  if (samples.length === 0) throw new Error('validation requires fixed frame samples')

  const run = (runMotion, runSamples) => {
    if (!profile.runtime_corrections?.ground_contact?.enabled
        && !profile.ik?.enabled) {
      const snapshots = runSamples.map((frame) => solveRetargetFrame({
        profile,
        avatarRig,
        motion: runMotion,
        frame,
        canonicalSkeleton,
      }))
      return { snapshots, allPoses: snapshots }
    }
    const requested = new Set(runSamples)
    const session = createRetargetSession({
      profile,
      avatarRig,
      motion: runMotion,
      canonicalSkeleton,
    })
    const output = []
    const allPoses = []
    for (let frame = 0; frame <= Math.max(...runSamples); frame += 1) {
      const pose = session.solve(frame)
      allPoses.push(pose)
      if (requested.has(frame)) output.push(pose)
    }
    return { snapshots: output, allPoses }
  }
  const firstRun = run(motion, samples)
  const secondRun = run(motion, samples)
  const qualification = qualificationMotion
    ? {
      motion: qualificationMotion,
      samples: [qualificationMotion.frame_count - 1],
    }
    : { motion, samples }
  const qualificationFirstRun = qualificationMotion
    ? run(qualification.motion, qualification.samples)
    : firstRun
  const qualificationSecondRun = qualificationMotion
    ? run(qualification.motion, qualification.samples)
    : secondRun
  const first = firstRun.snapshots
  const second = secondRun.snapshots
  const firstCanonical = canonicalStringify({
    baseline: first,
    qualification: qualificationFirstRun.snapshots,
  })
  const secondCanonical = canonicalStringify({
    baseline: second,
    qualification: qualificationSecondRun.snapshots,
  })
  const repeatDelta = firstCanonical === secondCanonical ? 0 : 1
  const issues = first.flatMap((pose) => validatePose(pose, tolerance, profile))
  let qualificationResult = null
  const referenceThreshold =
    profile.authoring?.validation_policy?.reference_direction_mean_deg_max
  if (Number.isFinite(referenceThreshold)) {
    const referenceFit = referenceDirectionError({
      profile,
      avatarRig,
      motion,
      frame: profile.rest_calibration.source_frame ?? 0,
    })
    qualificationResult = {
      tier: 'fk-reference-direction',
      reference_fit: {
        mean_direction_error_deg: referenceFit.mean_degrees,
        maximum_mean_direction_error_deg: referenceThreshold,
      },
      visual_acceptance: 'required-separately',
    }
    if (referenceFit.mean_degrees > referenceThreshold) {
      issues.push(
        `FK reference direction error ${referenceFit.mean_degrees} exceeds ${referenceThreshold} degrees`,
      )
    }
  }
  const enhancedTargets = Object.entries(profile.ik?.targets ?? {}).filter(
    ([, target]) => (target.lock_horizontal || target.lock_orientation)
      && target.lock_blend_frames !== undefined,
  )
  if (enhancedTargets.length > 0) {
    const targets = {}
    for (const [targetId, target] of enhancedTargets) {
      const coverage = contactCoverage(qualification.motion, target)
      const results = qualificationFirstRun.allPoses
        .map((pose) => pose.ik?.[targetId])
        .filter(Boolean)
      const maxResidual = results.reduce(
        (maximum, result) => Math.max(maximum, result.error_m),
        0,
      )
      const maximumPelvisLowering = results.reduce(
        (maximum, result) => Math.max(
          maximum,
          -(result.pelvis_lowering_m ?? 0),
        ),
        0,
      )
      const fullyLockedOrientations = target.lock_orientation
        ? results.filter(
          (result) => result.lock_weight >= 1 - 1e-12
            && result.target_world_quaternion
            && result.solved_world_quaternion,
        )
        : []
      const maxOrientationResidual = fullyLockedOrientations.reduce(
        (maximum, result) => Math.max(
          maximum,
          quaternionAngleDegrees(
            result.solved_world_quaternion,
            result.target_world_quaternion,
          ),
        ),
        0,
      )
      targets[targetId] = {
        ...coverage,
        maximum_target_residual_m: maxResidual,
        tolerance_m: target.tolerance_m,
        maximum_pelvis_lowering_m: maximumPelvisLowering,
      }
      if (target.lock_orientation) {
        targets[targetId].fully_locked_orientation_frames =
          fullyLockedOrientations.length
        targets[targetId].maximum_orientation_residual_deg =
          maxOrientationResidual
        targets[targetId].orientation_tolerance_deg =
          target.orientation_tolerance_deg
        if (fullyLockedOrientations.length === 0) {
          issues.push(
            `${targetId} orientation qualification has no fully locked frames`,
          )
        } else if (maxOrientationResidual > target.orientation_tolerance_deg) {
          issues.push(
            `${targetId} IK orientation residual ${maxOrientationResidual} exceeds ${target.orientation_tolerance_deg} degrees`,
          )
        }
      }
      if (coverage.active_frames === 0) {
        issues.push(`${targetId} IK qualification has no planted frames`)
      }
      if (coverage.inactive_frames === 0 || coverage.transitions === 0) {
        issues.push(
          `${targetId} IK qualification does not exercise contact release`,
        )
      }
      if (maxResidual > target.tolerance_m) {
        issues.push(
          `${targetId} IK maximum residual ${maxResidual} exceeds ${target.tolerance_m}`,
        )
      }
    }
    qualificationResult = {
      ...(qualificationResult ?? {}),
      tier: qualificationResult
        ? 'fk-reference-plus-temporal-foot-ik'
        : 'fk-determinism-plus-temporal-foot-ik',
      motion_signature: qualification.motion.motion_signature,
      distinct_motion: Boolean(qualificationMotion),
      targets,
      visual_acceptance: 'required-separately',
    }
  }
  if (repeatDelta > tolerance.repeat_canonical_bytes) {
    issues.push('two validation runs produced different canonical output')
  }
  const profileInputSignature = await contractSignature(profile)
  const suite = {
    id: 'soma-studio-fixed-frames-v1',
    motion_signature: motion.motion_signature,
    frames: samples,
    tolerance,
    correction_mode: profile.runtime_corrections?.mode ?? 'none',
  }
  if (qualificationMotion) {
    suite.qualification_motion_signature = qualificationMotion.motion_signature
  }
  if (profile.authoring?.mapping_catalog?.signature) {
    suite.mapping_catalog_signature = profile.authoring.mapping_catalog.signature
  }
  const suiteSignature = await contractSignature(suite)
  const resultBody = {
    suite_signature: suiteSignature,
    avatar_rig_signature: avatarRig.rig_signature,
    profile_id: profile.profile_id,
    profile_input_signature: profileInputSignature,
    deterministic_runs: 2,
    repeat_canonical_delta: repeatDelta,
    frame_count: samples.length,
    driven_bone_count: profile.mapping.length,
    issues,
    snapshots: first,
  }
  if (qualificationResult) resultBody.qualification = qualificationResult
  if (profile.authoring?.coverage) {
    resultBody.coverage = structuredClone(profile.authoring.coverage)
  }
  const resultSignature = await contractSignature(resultBody)
  return {
    passed: issues.length === 0,
    suite,
    suite_signature: suiteSignature,
    result: resultBody,
    result_signature: resultSignature,
  }
}

export function promoteValidatedProfile({
  profile,
  evidence,
  avatarRig,
  canonicalSkeleton,
}) {
  if (!evidence?.passed || evidence.result?.issues?.length !== 0) {
    throw new Error('only passing validation evidence can promote a profile')
  }
  const promoted = structuredClone(profile)
  promoted.status = 'validated'
  promoted.validation = {
    suite_signature: evidence.suite_signature,
    result_signature: evidence.result_signature,
    motion_signature: evidence.suite.motion_signature,
    profile_input_signature: evidence.result.profile_input_signature,
    frames: [...evidence.suite.frames],
    deterministic_runs: evidence.result.deterministic_runs,
    repeat_canonical_delta: evidence.result.repeat_canonical_delta,
  }
  if (evidence.result.coverage) {
    promoted.validation.coverage = structuredClone(evidence.result.coverage)
  }
  if (evidence.suite.qualification_motion_signature) {
    promoted.validation.qualification_motion_signature =
      evidence.suite.qualification_motion_signature
  }
  return assertCalibrationProfile(promoted, {
    requireComplete: true,
    avatarRig,
    canonicalSkeleton,
  })
}

export async function verifyValidatedProfile({
  profile,
  avatarRig,
  canonicalSkeleton,
}) {
  assertCalibrationProfile(profile, {
    requireComplete: true,
    avatarRig,
    canonicalSkeleton,
  })
  const input = structuredClone(profile)
  input.status = 'draft'
  input.validation = null
  const actual = await contractSignature(input)
  if (actual !== profile.validation.profile_input_signature) {
    throw new Error('validated profile content does not match its signed input')
  }
  return profile
}
