import {
  assertAvatarRigIR,
  assertCalibrationProfile,
  assertSomaMotionIR,
} from './contracts.js?v=10'
import {
  invertQuaternion,
  multiplyQuaternions,
} from './calibration.js?v=10'
import { somaWorldPositions } from './authoring.js?v=1'

export const AUTO_TUNE_SOLVER = 'soma-reference-direction-fit'
export const AUTO_TUNE_VERSION = '1.0.0'

const EPSILON = 1e-9
const IDENTITY_QUATERNION = Object.freeze([0, 0, 0, 1])

function clone(value) {
  return structuredClone(value)
}

function subtract(left, right) {
  return left.map((component, index) => component - right[index])
}

function dot(left, right) {
  return left.reduce(
    (sum, component, index) => sum + component * right[index],
    0,
  )
}

function cross([ax, ay, az], [bx, by, bz]) {
  return [
    ay * bz - az * by,
    az * bx - ax * bz,
    ax * by - ay * bx,
  ]
}

function length(vector) {
  return Math.hypot(...vector)
}

function normalizeVector(vector) {
  const magnitude = length(vector)
  if (!Number.isFinite(magnitude) || magnitude < EPSILON) return null
  return vector.map((component) => component / magnitude)
}

function normalizeQuaternion(quaternion) {
  const magnitude = Math.hypot(...quaternion)
  if (!Number.isFinite(magnitude) || magnitude < EPSILON) {
    throw new TypeError('quaternion must have finite, non-zero length')
  }
  const normalized = quaternion.map((component) => component / magnitude)
  return normalized[3] < 0
    ? normalized.map((component) => -component)
    : normalized
}

function rotateVector([vx, vy, vz], [x, y, z, w]) {
  const tx = 2 * (y * vz - z * vy)
  const ty = 2 * (z * vx - x * vz)
  const tz = 2 * (x * vy - y * vx)
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ]
}

function angleDegrees(left, right) {
  const cosine = Math.max(-1, Math.min(1, dot(left, right)))
  return Math.acos(cosine) * 180 / Math.PI
}

function quaternionFromUnitVectors(from, to) {
  const cosine = dot(from, to)
  if (cosine > 1 - 1e-12) return [...IDENTITY_QUATERNION]
  if (cosine < -1 + 1e-12) {
    const basis = Math.abs(from[0]) <= Math.abs(from[1])
      && Math.abs(from[0]) <= Math.abs(from[2])
      ? [1, 0, 0]
      : (Math.abs(from[1]) <= Math.abs(from[2]) ? [0, 1, 0] : [0, 0, 1])
    return normalizeQuaternion([...normalizeVector(cross(from, basis)), 0])
  }
  return normalizeQuaternion([...cross(from, to), 1 + cosine])
}

function hasOrientationConstraint(vectors) {
  const first = vectors[0]
  return vectors.slice(1).some(
    (vector) => length(cross(first, vector)) > 1e-4,
  )
}

// Horn's quaternion form of the orthogonal Procrustes solution. The symmetric
// 4x4 eigensystem is solved with deterministic Jacobi rotations.
function bestFitQuaternion(constraints) {
  if (constraints.length === 1
      || !hasOrientationConstraint(constraints.map(({ target }) => target))
      || !hasOrientationConstraint(constraints.map(({ source }) => source))) {
    return {
      quaternion: quaternionFromUnitVectors(
        constraints[0].target,
        constraints[0].source,
      ),
      confidence: 'swing-only',
      twistStatus: 'unresolved',
    }
  }

  const covariance = Array.from({ length: 3 }, () => [0, 0, 0])
  for (const { target, source } of constraints) {
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        covariance[row][column] += target[row] * source[column]
      }
    }
  }
  const [
    [sxx, sxy, sxz],
    [syx, syy, syz],
    [szx, szy, szz],
  ] = covariance
  const trace = sxx + syy + szz
  const matrix = [
    [trace, syz - szy, szx - sxz, sxy - syx],
    [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
    [szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy],
    [sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz],
  ]
  const eigenvectors = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ]
  for (let iteration = 0; iteration < 64; iteration += 1) {
    let p = 0
    let q = 1
    let largest = 0
    for (let row = 0; row < 4; row += 1) {
      for (let column = row + 1; column < 4; column += 1) {
        if (Math.abs(matrix[row][column]) > largest) {
          largest = Math.abs(matrix[row][column])
          p = row
          q = column
        }
      }
    }
    if (largest < 1e-14) break
    const angle = 0.5 * Math.atan2(
      2 * matrix[p][q],
      matrix[q][q] - matrix[p][p],
    )
    const cosine = Math.cos(angle)
    const sine = Math.sin(angle)
    for (let index = 0; index < 4; index += 1) {
      if (index === p || index === q) continue
      const left = matrix[index][p]
      const right = matrix[index][q]
      matrix[index][p] = cosine * left - sine * right
      matrix[p][index] = matrix[index][p]
      matrix[index][q] = sine * left + cosine * right
      matrix[q][index] = matrix[index][q]
    }
    const app = matrix[p][p]
    const aqq = matrix[q][q]
    const apq = matrix[p][q]
    matrix[p][p] =
      cosine * cosine * app - 2 * sine * cosine * apq + sine * sine * aqq
    matrix[q][q] =
      sine * sine * app + 2 * sine * cosine * apq + cosine * cosine * aqq
    matrix[p][q] = 0
    matrix[q][p] = 0
    for (let row = 0; row < 4; row += 1) {
      const left = eigenvectors[row][p]
      const right = eigenvectors[row][q]
      eigenvectors[row][p] = cosine * left - sine * right
      eigenvectors[row][q] = sine * left + cosine * right
    }
  }
  let largestIndex = 0
  for (let index = 1; index < 4; index += 1) {
    if (matrix[index][index] > matrix[largestIndex][largestIndex]) {
      largestIndex = index
    }
  }
  const [w, x, y, z] = eigenvectors.map((row) => row[largestIndex])
  return {
    quaternion: normalizeQuaternion([x, y, z, w]),
    confidence: 'multi-axis',
    twistStatus: 'constrained',
  }
}

function buildConstraints({ profile, avatarRig, motion, frame }) {
  const boneById = new Map(avatarRig.bones.map((bone) => [bone.id, bone]))
  const mappingBySemantic = new Map(
    profile.mapping.map((mapping) => [mapping.semantic, mapping]),
  )
  const sourceIndex = new Map(
    motion.joints.map((joint, index) => [joint, index]),
  )
  const sourcePositions = somaWorldPositions(motion, frame)
  const constraintsBySemantic = new Map(
    profile.mapping.map((mapping) => [mapping.semantic, []]),
  )

  for (const childMapping of profile.mapping) {
    const parentMapping = mappingBySemantic.get(childMapping.target_parent_semantic)
    if (!parentMapping) continue
    const parentBone = boneById.get(parentMapping.target_bone_id)
    const childBone = boneById.get(childMapping.target_bone_id)
    const parentSourceIndex = sourceIndex.get(parentMapping.soma_joint)
    const childSourceIndex = sourceIndex.get(childMapping.soma_joint)
    if (!parentBone || !childBone
        || parentSourceIndex === undefined || childSourceIndex === undefined) {
      continue
    }
    const target = normalizeVector(subtract(
      childBone.rest_world.position,
      parentBone.rest_world.position,
    ))
    const source = normalizeVector(subtract(
      sourcePositions[childSourceIndex],
      sourcePositions[parentSourceIndex],
    ))
    if (!target || !source) continue
    constraintsBySemantic.get(parentMapping.semantic).push({
      child_semantic: childMapping.semantic,
      target,
      source,
    })
  }
  return constraintsBySemantic
}

function worldDeltaFromOffset(targetRestWorld, offset) {
  return multiplyQuaternions(
    multiplyQuaternions(targetRestWorld, offset),
    invertQuaternion(targetRestWorld),
  )
}

function offsetFromWorldDelta(targetRestWorld, worldDelta) {
  return multiplyQuaternions(
    multiplyQuaternions(invertQuaternion(targetRestWorld), worldDelta),
    targetRestWorld,
  )
}

function constraintError(constraints, worldDelta) {
  if (constraints.length === 0) return null
  const errors = constraints.map(({ target, source }) => (
    angleDegrees(rotateVector(target, worldDelta), source)
  ))
  return errors.reduce((sum, error) => sum + error, 0) / errors.length
}

function mean(values) {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length
}

export function referenceDirectionError({
  profile,
  avatarRig,
  motion,
  frame = profile.rest_calibration?.source_frame ?? 0,
}) {
  const constraintsBySemantic = buildConstraints({
    profile,
    avatarRig,
    motion,
    frame,
  })
  const perBone = {}
  for (const mapping of profile.mapping) {
    const constraints = constraintsBySemantic.get(mapping.semantic)
    if (!constraints?.length) continue
    const calibration = profile.rest_calibration.per_bone[mapping.semantic]
    const worldDelta = worldDeltaFromOffset(
      calibration.target_rest_world_quaternion,
      calibration.user_offset_quaternion,
    )
    perBone[mapping.semantic] = constraintError(constraints, worldDelta)
  }
  return {
    mean_degrees: mean(Object.values(perBone)),
    per_bone_degrees: perBone,
  }
}

export function autoTuneReferencePose({
  profile,
  avatarRig,
  motion,
  frame = profile.rest_calibration?.source_frame ?? 0,
  canonicalSkeleton = null,
}) {
  assertAvatarRigIR(avatarRig)
  assertCalibrationProfile(profile, { avatarRig, canonicalSkeleton })
  assertSomaMotionIR(motion, canonicalSkeleton)
  if (!profile.rest_calibration?.per_bone
      || Object.keys(profile.rest_calibration.per_bone).length === 0) {
    throw new Error('automatic fitting requires captured rest calibration')
  }
  if (!Number.isInteger(frame) || frame < 0 || frame >= motion.frame_count) {
    throw new RangeError(`auto-fit frame must be between 0 and ${motion.frame_count - 1}`)
  }

  const next = clone(profile)
  const constraintsBySemantic = buildConstraints({
    profile,
    avatarRig,
    motion,
    frame,
  })
  const suggestions = {}
  const skippedSemantics = []
  const beforeErrors = []
  const afterErrors = []

  for (const mapping of profile.mapping) {
    const semantic = mapping.semantic
    const calibration = profile.rest_calibration.per_bone[semantic]
    const constraints = constraintsBySemantic.get(semantic) ?? []
    if (!calibration || constraints.length === 0) {
      skippedSemantics.push(semantic)
      continue
    }
    const fitted = bestFitQuaternion(constraints)
    const autoOffset = offsetFromWorldDelta(
      calibration.target_rest_world_quaternion,
      fitted.quaternion,
    )
    const beforeWorldDelta = worldDeltaFromOffset(
      calibration.target_rest_world_quaternion,
      calibration.user_offset_quaternion,
    )
    const beforeError = constraintError(constraints, beforeWorldDelta)
    const afterError = constraintError(constraints, fitted.quaternion)
    beforeErrors.push(beforeError)
    afterErrors.push(afterError)
    next.rest_calibration.per_bone[semantic].user_offset_quaternion = autoOffset
    suggestions[semantic] = {
      original_offset_quaternion: [
        ...calibration.user_offset_quaternion,
      ],
      auto_offset_quaternion: [...autoOffset],
      final_offset_quaternion: [...autoOffset],
      manual_residual_quaternion: [...IDENTITY_QUATERNION],
      confidence: fitted.confidence,
      twist_status: fitted.twistStatus,
      constraint_count: constraints.length,
      child_semantics: constraints.map(({ child_semantic: child }) => child),
      mean_direction_error_deg_before: beforeError,
      mean_direction_error_deg_after: afterError,
    }
  }

  const report = {
    solver: AUTO_TUNE_SOLVER,
    solver_version: AUTO_TUNE_VERSION,
    source_motion_signature: motion.motion_signature ?? null,
    source_frame: frame,
    applied_semantics: Object.keys(suggestions),
    skipped_semantics: skippedSemantics,
    mean_direction_error_deg_before: mean(beforeErrors),
    mean_direction_error_deg_after: mean(afterErrors),
    suggestions,
  }
  next.authoring ??= {}
  next.authoring.auto_tuning = clone(report)
  next.authoring.validation_policy ??= {
    reference_direction_mean_deg_max: 5,
  }
  next.status = 'draft'
  next.validation = null
  return {
    profile: assertCalibrationProfile(next, { avatarRig, canonicalSkeleton }),
    report,
  }
}
