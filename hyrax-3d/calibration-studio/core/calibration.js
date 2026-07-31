import {
  assertAvatarRigIR,
  assertCalibrationProfile,
  assertSomaMotionIR,
} from './contracts.js?v=10'

const IDENTITY_QUATERNION = Object.freeze([0, 0, 0, 1])

function clone(value) {
  return structuredClone(value)
}

function normalizeQuaternion([x, y, z, w]) {
  const length = Math.hypot(x, y, z, w)
  if (!Number.isFinite(length) || length < 1e-12) {
    throw new TypeError('quaternion must have finite, non-zero length')
  }
  return [x / length, y / length, z / length, w / length]
}

export function invertQuaternion(quaternion) {
  const [x, y, z, w] = normalizeQuaternion(quaternion)
  return [-x, -y, -z, w]
}

export function multiplyQuaternions(left, right) {
  const [ax, ay, az, aw] = left
  const [bx, by, bz, bw] = right
  return normalizeQuaternion([
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ])
}

export function mat3RowMajorToQuaternion(matrix) {
  if (!Array.isArray(matrix)
      || matrix.length !== 9
      || matrix.some((value) => !Number.isFinite(value))) {
    throw new TypeError('rotation matrix must be a finite row-major mat3')
  }
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = matrix
  const trace = m00 + m11 + m22
  let x
  let y
  let z
  let w
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2
    w = 0.25 * s
    x = (m21 - m12) / s
    y = (m02 - m20) / s
    z = (m10 - m01) / s
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2
    w = (m21 - m12) / s
    x = 0.25 * s
    y = (m01 + m10) / s
    z = (m02 + m20) / s
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2
    w = (m02 - m20) / s
    x = (m01 + m10) / s
    y = 0.25 * s
    z = (m12 + m21) / s
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2
    w = (m10 - m01) / s
    x = (m02 + m20) / s
    y = (m12 + m21) / s
    z = 0.25 * s
  }
  return normalizeQuaternion([x, y, z, w])
}

function restWorldPositions(motion) {
  const positions = []
  const jointIndex = new Map(motion.joints.map((name, index) => [name, index]))
  motion.joints.forEach((name, index) => {
    const offset = motion.rest_offsets_m[index]
    const parent = motion.parents[index]
    if (parent === null) {
      positions.push([...offset])
      return
    }
    const parentPosition = positions[jointIndex.get(parent)]
    positions.push(offset.map((component, axis) => component + parentPosition[axis]))
  })
  return positions
}

function distance(left, right) {
  return Math.hypot(
    left[0] - right[0],
    left[1] - right[1],
    left[2] - right[2],
  )
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

function mappedBone(profile, avatarRig, semantic) {
  const mapping = profile.mapping.find((entry) => entry.semantic === semantic)
  if (!mapping) throw new Error(`profile does not map "${semantic}"`)
  const bone = avatarRig.bones.find((candidate) => candidate.id === mapping.target_bone_id)
  if (!bone) throw new Error(`avatar rig does not contain mapped "${semantic}" bone`)
  return { mapping, bone }
}

export function captureRestCalibration({
  profile,
  avatarRig,
  motion,
  frame = 0,
  canonicalSkeleton = null,
}) {
  assertAvatarRigIR(avatarRig)
  assertCalibrationProfile(profile, { avatarRig, canonicalSkeleton })
  assertSomaMotionIR(motion, canonicalSkeleton)
  if (!Number.isInteger(frame) || frame < 0 || frame >= motion.frame_count) {
    throw new RangeError(`rest frame must be between 0 and ${motion.frame_count - 1}`)
  }

  const jointIndex = new Map(motion.joints.map((name, index) => [name, index]))
  const boneById = new Map(avatarRig.bones.map((bone) => [bone.id, bone]))
  const perBone = {}
  for (const mapping of profile.mapping) {
    const sourceIndex = jointIndex.get(mapping.soma_joint)
    const targetBone = boneById.get(mapping.target_bone_id)
    if (sourceIndex === undefined || !targetBone) {
      throw new Error(`cannot capture rest calibration for "${mapping.semantic}"`)
    }
    const sourceRest = mat3RowMajorToQuaternion(
      motion.global_rot_mats[frame][sourceIndex],
    )
    const targetRestWorld = normalizeQuaternion(targetBone.rest_world.quaternion)
    const targetRestLocal = normalizeQuaternion(targetBone.rest_local.quaternion)
    const targetParentRestWorld = multiplyQuaternions(
      targetRestWorld,
      invertQuaternion(targetRestLocal),
    )
    const rotatedLocalPosition = rotateVector(
      targetBone.rest_local.position,
      targetParentRestWorld,
    )
    perBone[mapping.semantic] = {
      status: 'captured',
      source_rest_world_quaternion: sourceRest,
      source_rest_inverse_quaternion: invertQuaternion(sourceRest),
      target_rest_world_quaternion: targetRestWorld,
      target_parent_rest_world_quaternion: targetParentRestWorld,
      target_parent_rest_world_position: targetBone.rest_world.position.map(
        (component, axis) => component - rotatedLocalPosition[axis],
      ),
      user_offset_quaternion: [...IDENTITY_QUATERNION],
    }
  }

  const next = clone(profile)
  next.rest_calibration = {
    rotation_model: 'target-rest-world * source-world * inverse(source-rest-world) * user-offset',
    source_motion_signature: motion.motion_signature ?? null,
    source_frame: frame,
    per_bone: perBone,
  }
  if (next.authoring?.auto_tuning) delete next.authoring.auto_tuning
  next.status = 'draft'
  next.validation = null
  return assertCalibrationProfile(next, { avatarRig, canonicalSkeleton })
}

export function calibrateRoot({
  profile,
  avatarRig,
  motion,
  frame = profile.rest_calibration?.source_frame ?? 0,
  canonicalSkeleton = null,
}) {
  assertAvatarRigIR(avatarRig)
  assertCalibrationProfile(profile, { avatarRig, canonicalSkeleton })
  assertSomaMotionIR(motion, canonicalSkeleton)
  if (!Number.isInteger(frame) || frame < 0 || frame >= motion.frame_count) {
    throw new RangeError(`root frame must be between 0 and ${motion.frame_count - 1}`)
  }
  const { mapping, bone } = mappedBone(profile, avatarRig, 'hips')
  const next = clone(profile)
  next.root_calibration = {
    status: 'calibrated',
    source_joint: mapping.soma_joint,
    target_bone_id: bone.id,
    source_rest_position_m: [...motion.root_positions[frame]],
    target_rest_world_position_m: [...bone.rest_world.position],
    translation_mode: 'delta-from-calibration-frame',
    rotation_mode: 'mapped-hips',
    enabled_axes: ['x', 'y', 'z'],
  }
  next.status = 'draft'
  next.validation = null
  return assertCalibrationProfile(next, { avatarRig, canonicalSkeleton })
}

export function calibrateScale({
  profile,
  avatarRig,
  motion,
  canonicalSkeleton = null,
}) {
  assertAvatarRigIR(avatarRig)
  assertCalibrationProfile(profile, { avatarRig, canonicalSkeleton })
  assertSomaMotionIR(motion, canonicalSkeleton)
  const sourcePositions = restWorldPositions(motion)
  const sourceByName = new Map(
    motion.joints.map((name, index) => [name, sourcePositions[index]]),
  )
  const { mapping: hipsMapping, bone: hipsBone } = mappedBone(profile, avatarRig, 'hips')
  const samples = []
  for (const footSemantic of ['leftFoot', 'rightFoot']) {
    const { mapping, bone } = mappedBone(profile, avatarRig, footSemantic)
    const sourceLength = distance(
      sourceByName.get(hipsMapping.soma_joint),
      sourceByName.get(mapping.soma_joint),
    )
    const targetLength = distance(
      hipsBone.rest_world.position,
      bone.rest_world.position,
    )
    if (sourceLength > 1e-8 && targetLength > 1e-8) {
      samples.push({
        semantic: footSemantic,
        source_length_m: sourceLength,
        target_length_m: targetLength,
        ratio: targetLength / sourceLength,
      })
    }
  }
  if (samples.length === 0) {
    throw new Error('scale calibration requires measurable hips-to-foot mappings')
  }
  const factor = samples.reduce((sum, sample) => sum + sample.ratio, 0) / samples.length
  const next = clone(profile)
  next.scale_calibration = {
    status: 'calibrated',
    method: 'mean-mapped-hips-to-feet-rest-distance',
    translation_scale: factor,
    samples,
  }
  next.status = 'draft'
  next.validation = null
  return assertCalibrationProfile(next, { avatarRig, canonicalSkeleton })
}

export function setBoneUserOffset({
  profile,
  semantic,
  quaternion,
  avatarRig = null,
  canonicalSkeleton = null,
}) {
  assertCalibrationProfile(profile, { avatarRig, canonicalSkeleton })
  if (typeof semantic !== 'string' || semantic.length === 0) {
    throw new TypeError('offset semantic must be a non-empty string')
  }
  const calibration = profile.rest_calibration?.per_bone?.[semantic]
  if (calibration?.status !== 'captured') {
    throw new Error(`cannot set offset before "${semantic}" rest calibration is captured`)
  }
  const next = clone(profile)
  const normalized = normalizeQuaternion(quaternion)
  next.rest_calibration.per_bone[semantic].user_offset_quaternion = normalized
  const autoSuggestion = next.authoring?.auto_tuning?.suggestions?.[semantic]
  if (autoSuggestion?.auto_offset_quaternion) {
    autoSuggestion.final_offset_quaternion = [...normalized]
    autoSuggestion.manual_residual_quaternion = multiplyQuaternions(
      invertQuaternion(autoSuggestion.auto_offset_quaternion),
      normalized,
    )
  }
  next.status = 'draft'
  next.validation = null
  return assertCalibrationProfile(next, { avatarRig, canonicalSkeleton })
}

export function calibrationReadiness(profile) {
  const mapped = profile.mapping?.map((entry) => entry.semantic) ?? []
  const captured = profile.rest_calibration?.per_bone ?? {}
  const missingRest = mapped.filter((semantic) => captured[semantic]?.status !== 'captured')
  return {
    rest: missingRest.length === 0 && mapped.length > 0,
    root: profile.root_calibration?.status === 'calibrated',
    scale: profile.scale_calibration?.status === 'calibrated',
    missing_rest_semantics: missingRest,
    ready_for_validation: missingRest.length === 0
      && mapped.length > 0
      && profile.root_calibration?.status === 'calibrated'
      && profile.scale_calibration?.status === 'calibrated',
  }
}

export function configureFootGroundIk({
  profile,
  avatarRig = null,
  enabled,
  groundY = null,
  soleOffsetM = null,
  contactThreshold = 0.5,
  contactHysteresis = 0,
  lockHorizontal = false,
  lockOrientation = false,
  orientationToleranceDeg = 0.1,
  pelvisCompensationMaxM = 0,
  lockBlendFrames = 1,
  useRestPosePoles = false,
  maxIterations = 8,
  toleranceM = 0.01,
}) {
  if (groundY !== null && !Number.isFinite(groundY)) {
    throw new TypeError('IK groundY must be finite or null')
  }
  if (!Number.isFinite(contactThreshold)
      || contactThreshold < 0
      || !Number.isFinite(contactHysteresis)
      || contactHysteresis < 0) {
    throw new TypeError('IK contact thresholds must be finite and non-negative')
  }
  if (!Number.isInteger(lockBlendFrames) || lockBlendFrames < 1) {
    throw new TypeError('IK lockBlendFrames must be a positive integer')
  }
  if (!Number.isFinite(orientationToleranceDeg)
      || orientationToleranceDeg <= 0) {
    throw new TypeError('IK orientationToleranceDeg must be positive')
  }
  if (!Number.isFinite(pelvisCompensationMaxM)
      || pelvisCompensationMaxM < 0) {
    throw new TypeError('IK pelvisCompensationMaxM must be non-negative')
  }
  const declaredSoleOffsets = typeof soleOffsetM === 'number'
    ? [soleOffsetM]
    : Object.values(soleOffsetM ?? {})
  if (declaredSoleOffsets.some((value) => !Number.isFinite(value))) {
    throw new TypeError('IK sole offsets must be finite')
  }
  const next = clone(profile)
  const targetBone = (semantic) => {
    const mapping = profile.mapping.find((entry) => entry.semantic === semantic)
    const bone = avatarRig?.bones.find(
      (candidate) => candidate.id === mapping?.target_bone_id,
    )
    if (!bone) {
      throw new Error(
        `automatic ${semantic} IK height requires the imported Avatar Rig IR`,
      )
    }
    return bone
  }
  const targetHeight = (semantic) => (
    groundY === null ? targetBone(semantic).rest_world.position[1] : groundY
  )
  const soleOffset = (semantic) => {
    if (soleOffsetM !== null) {
      if (typeof soleOffsetM === 'number') return soleOffsetM
      const explicit = soleOffsetM[semantic]
      if (Number.isFinite(explicit)) return explicit
    }
    return groundY === null
      ? 0
      : targetBone(semantic).rest_world.position[1] - groundY
  }
  const restPole = (chain) => {
    if (!useRestPosePoles) return null
    const positions = chain.map(
      (semantic) => targetBone(semantic).rest_world.position,
    )
    const axis = positions[2].map(
      (component, index) => component - positions[0][index],
    )
    const axisLength = Math.hypot(...axis)
    if (axisLength < 1e-8) return null
    const unitAxis = axis.map((component) => component / axisLength)
    const knee = positions[1].map(
      (component, index) => component - positions[0][index],
    )
    const projection = knee.reduce(
      (sum, component, index) => sum + component * unitAxis[index],
      0,
    )
    const pole = knee.map(
      (component, index) => component - unitAxis[index] * projection,
    )
    const poleLength = Math.hypot(...pole)
    return poleLength < 1e-8
      ? null
      : pole.map((component) => component / poleLength)
  }
  const enhanced = groundY !== null
    || soleOffsetM !== null
    || contactHysteresis !== 0
    || lockHorizontal
    || lockOrientation
    || lockBlendFrames !== 1
    || useRestPosePoles
  const targetConfig = (semantic, chain, contactChannel) => {
    const config = {
      chain,
      contact_channel: contactChannel,
      contact_threshold: contactThreshold,
      ground_y: targetHeight(semantic),
      lock_horizontal: lockHorizontal,
      lock_orientation: lockOrientation,
      max_iterations: maxIterations,
      tolerance_m: toleranceM,
    }
    if (enhanced) {
      config.sole_offset_m = soleOffset(semantic)
      config.contact_hysteresis = contactHysteresis
      config.lock_blend_frames = lockBlendFrames
      const pole = restPole(chain)
      if (pole) config.pole_world_direction = pole
      if (lockOrientation) {
        config.orientation_tolerance_deg = orientationToleranceDeg
      }
    }
    return config
  }
  next.status = 'draft'
  next.validation = null
  next.ik = enabled
    ? {
        enabled: true,
        pelvis_compensation: {
          enabled: pelvisCompensationMaxM > 0,
          max_lowering_m: pelvisCompensationMaxM,
        },
        targets: {
          leftFoot: targetConfig(
            'leftFoot',
            ['leftUpperLeg', 'leftLowerLeg', 'leftFoot'],
            1,
          ),
          rightFoot: targetConfig(
            'rightFoot',
            ['rightUpperLeg', 'rightLowerLeg', 'rightFoot'],
            3,
          ),
        },
      }
    : {
        enabled: false,
        targets: {},
      }
  return next
}
