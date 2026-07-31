import {
  assertAvatarRigIR,
  assertCalibrationProfile,
  assertSomaMotionIR,
} from './contracts.js?v=10'
import {
  invertQuaternion,
  mat3RowMajorToQuaternion,
  multiplyQuaternions,
} from './calibration.js?v=10'
import { createIkSession } from './ik.js?v=9'

function add(left, right) {
  return left.map((component, index) => component + right[index])
}

function scale(vector, factor) {
  return vector.map((component) => component * factor)
}

function rotateVector(vector, quaternion) {
  const [x, y, z, w] = quaternion
  const [vx, vy, vz] = vector
  const tx = 2 * (y * vz - z * vy)
  const ty = 2 * (z * vx - x * vz)
  const tz = 2 * (x * vy - y * vx)
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ]
}

function subtract(left, right) {
  return left.map((component, index) => component - right[index])
}

function requireFrame(frame, motion) {
  if (!Number.isInteger(frame) || frame < 0 || frame >= motion.frame_count) {
    throw new RangeError(`frame must be between 0 and ${motion.frame_count - 1}`)
  }
}

/**
 * Pure profile consumer. It computes target transforms without importing
 * Three.js, VRM, or an avatar-specific bone list.
 */
export function solveRetargetFrame({
  profile,
  avatarRig,
  motion,
  frame,
  canonicalSkeleton = null,
  requireValidated = false,
  translationScaleOverride = null,
  rootPositionMode = 'add-delta-to-rest',
}) {
  assertAvatarRigIR(avatarRig)
  assertSomaMotionIR(motion, canonicalSkeleton)
  assertCalibrationProfile(profile, {
    requireComplete: requireValidated,
    avatarRig,
    canonicalSkeleton,
  })
  if (requireValidated && profile.status !== 'validated') {
    throw new Error('runtime pose solving requires a validated profile')
  }
  requireFrame(frame, motion)

  const jointIndex = new Map(motion.joints.map((name, index) => [name, index]))
  const boneById = new Map(avatarRig.bones.map((bone) => [bone.id, bone]))
  const mappingByBoneId = new Map(
    profile.mapping.map((mapping) => [mapping.target_bone_id, mapping]),
  )
  const desiredWorldByBoneId = new Map()
  const rootDelta = subtract(
    motion.root_positions[frame],
    profile.root_calibration.source_rest_position_m,
  )
  const translationScale = translationScaleOverride
    ?? profile.scale_calibration.translation_scale

  for (const mapping of profile.mapping) {
    const calibration = profile.rest_calibration.per_bone[mapping.semantic]
    const sourceQuaternion = mat3RowMajorToQuaternion(
      motion.global_rot_mats[frame][jointIndex.get(mapping.soma_joint)],
    )
    let worldQuaternion = multiplyQuaternions(
      calibration.target_rest_world_quaternion,
      sourceQuaternion,
    )
    worldQuaternion = multiplyQuaternions(
      worldQuaternion,
      calibration.source_rest_inverse_quaternion,
    )
    worldQuaternion = multiplyQuaternions(
      worldQuaternion,
      calibration.user_offset_quaternion,
    )
    desiredWorldByBoneId.set(mapping.target_bone_id, worldQuaternion)
  }

  const poseByBoneId = new Map()
  for (const bone of avatarRig.bones) {
    const mapping = mappingByBoneId.get(bone.id) ?? null
    const calibration = mapping
      ? profile.rest_calibration.per_bone[mapping.semantic]
      : null
    const parentPose = bone.parent_id ? poseByBoneId.get(bone.parent_id) : null
    let parentWorldQuaternion
    let parentWorldPosition
    if (parentPose) {
      parentWorldQuaternion = parentPose.world_quaternion
      parentWorldPosition = parentPose.world_position
    } else if (calibration) {
      parentWorldQuaternion = calibration.target_parent_rest_world_quaternion
      parentWorldPosition = calibration.target_parent_rest_world_position
    } else {
      parentWorldQuaternion = multiplyQuaternions(
        bone.rest_world.quaternion,
        invertQuaternion(bone.rest_local.quaternion),
      )
      const rotatedLocalPosition = rotateVector(
        bone.rest_local.position,
        parentWorldQuaternion,
      )
      parentWorldPosition = subtract(
        bone.rest_world.position,
        rotatedLocalPosition,
      )
    }

    const desiredWorldQuaternion = desiredWorldByBoneId.get(bone.id) ?? null
    const localQuaternion = desiredWorldQuaternion
      ? multiplyQuaternions(
        invertQuaternion(parentWorldQuaternion),
        desiredWorldQuaternion,
      )
      : [...bone.rest_local.quaternion]
    const localPosition = [...bone.rest_local.position]
    if (mapping?.semantic === 'hips') {
      const translated = scale(rootDelta, translationScale)
      if (rootPositionMode === 'legacy-replace-xz-add-y') {
        localPosition[0] = translated[0]
        localPosition[1] += translated[1]
        localPosition[2] = translated[2]
      } else {
        for (const axis of profile.root_calibration.enabled_axes) {
          const index = { x: 0, y: 1, z: 2 }[axis]
          localPosition[index] += translated[index]
        }
      }
    }
    const worldPosition = add(
      parentWorldPosition,
      rotateVector(localPosition, parentWorldQuaternion),
    )
    const worldQuaternion = desiredWorldQuaternion
      ?? multiplyQuaternions(parentWorldQuaternion, localQuaternion)
    poseByBoneId.set(bone.id, {
      semantic: mapping?.semantic ?? null,
      target_bone_id: mapping ? bone.id : null,
      local_position: localPosition,
      local_quaternion: localQuaternion,
      world_position: worldPosition,
      world_quaternion: worldQuaternion,
    })
  }

  return {
    frame,
    source_time_s: frame / motion.fps,
    bones: profile.mapping.map(
      (mapping) => poseByBoneId.get(mapping.target_bone_id),
    ),
  }
}

export function createRetargetSession({
  profile,
  avatarRig,
  motion,
  canonicalSkeleton = null,
  requireValidated = false,
}) {
  const correction = profile.runtime_corrections ?? null
  let previousFrame = -1
  let groundCorrection = 0
  const ikSession = createIkSession(profile)

  function reset() {
    previousFrame = -1
    groundCorrection = 0
    ikSession.reset()
  }

  function solve(frame) {
    if (correction?.ground_contact?.enabled
        || profile.ik?.enabled) {
      if (previousFrame >= 0
          && frame !== previousFrame + 1) {
        throw new Error(
          'stateful runtime correction requires sequential frames or an explicit reset',
        )
      }
    }
    const pose = solveRetargetFrame({
      profile,
      avatarRig,
      motion,
      frame,
      canonicalSkeleton,
      requireValidated,
      translationScaleOverride: correction?.translation_scale_override ?? null,
      rootPositionMode: correction?.root_position_mode ?? 'add-delta-to-rest',
    })
    const ground = correction?.ground_contact
    if (ground?.enabled) {
      const contacts = motion.foot_contacts?.[frame]
      if (!contacts) {
        throw new Error('ground correction requires foot_contacts for every frame')
      }
      const bySemantic = new Map(pose.bones.map((bone) => [bone.semantic, bone]))
      let minY = Infinity
      for (const [semantic, channel] of Object.entries(ground.contact_channels)) {
        if (contacts[channel] > ground.contact_threshold) {
          const foot = bySemantic.get(semantic)
          if (!foot) throw new Error(`ground correction target "${semantic}" is not mapped`)
          minY = Math.min(minY, foot.world_position[1])
        }
      }
      if (Number.isFinite(minY)) {
        const error = ground.ground_y - minY
        groundCorrection += (error - groundCorrection) * ground.smoothing_factor
        for (const bone of pose.bones) bone.world_position[1] += groundCorrection
        const hips = bySemantic.get('hips')
        if (!hips) throw new Error('ground correction requires a mapped hips bone')
        hips.local_position[1] += groundCorrection
      }
    }
    previousFrame = frame
    const correctedPose = {
      ...pose,
      corrections: {
        ground_y_offset_m: groundCorrection,
      },
    }
    return ikSession.apply(correctedPose, motion, frame)
  }

  return { reset, solve }
}

export function applyPoseToThreeObject(pose, objectByRigId) {
  for (const bonePose of pose.bones) {
    const object = objectByRigId.get(bonePose.target_bone_id)
    if (!object) throw new Error(`target object missing for "${bonePose.target_bone_id}"`)
    object.position.fromArray(bonePose.local_position)
    object.quaternion.fromArray(bonePose.local_quaternion)
  }
}
