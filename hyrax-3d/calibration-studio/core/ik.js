import {
  invertQuaternion,
  multiplyQuaternions,
} from './calibration.js?v=10'

function add(left, right) {
  return left.map((value, index) => value + right[index])
}

function subtract(left, right) {
  return left.map((value, index) => value - right[index])
}

function scale(vector, factor) {
  return vector.map((value) => value * factor)
}

function length(vector) {
  return Math.hypot(...vector)
}

function normalize(vector) {
  const magnitude = length(vector)
  if (magnitude < 1e-12) throw new Error('IK encountered a zero-length direction')
  return scale(vector, 1 / magnitude)
}

function cross(left, right) {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ]
}

function dot(left, right) {
  return left.reduce((sum, value, index) => sum + value * right[index], 0)
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

function quaternionFromUnitVectors(from, to) {
  const left = normalize(from)
  const right = normalize(to)
  const cosine = dot(left, right)
  if (cosine < -0.999999) {
    const candidate = Math.abs(left[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
    const axis = normalize(cross(left, candidate))
    return [axis[0], axis[1], axis[2], 0]
  }
  const axis = cross(left, right)
  const quaternion = [axis[0], axis[1], axis[2], 1 + cosine]
  const magnitude = Math.hypot(...quaternion)
  return quaternion.map((value) => value / magnitude)
}

function normalizeQuaternion(quaternion) {
  const magnitude = Math.hypot(...quaternion)
  if (magnitude < 1e-12) throw new Error('IK encountered a zero-length quaternion')
  return quaternion.map((value) => value / magnitude)
}

function slerpQuaternions(from, to, amount) {
  const left = normalizeQuaternion(from)
  let right = normalizeQuaternion(to)
  let cosine = dot(left, right)
  if (cosine < 0) {
    right = right.map((value) => -value)
    cosine = -cosine
  }
  if (cosine > 0.9995) {
    return normalizeQuaternion(left.map(
      (value, index) => value + (right[index] - value) * amount,
    ))
  }
  const angle = Math.acos(Math.min(1, cosine))
  const sine = Math.sin(angle)
  const leftWeight = Math.sin((1 - amount) * angle) / sine
  const rightWeight = Math.sin(amount * angle) / sine
  return left.map(
    (value, index) => value * leftWeight + right[index] * rightWeight,
  )
}

function groundedFootQuaternion(current, rest) {
  const delta = multiplyQuaternions(current, invertQuaternion(rest))
  const yawTwist = Math.hypot(delta[1], delta[3]) < 1e-12
    ? [0, 0, 0, 1]
    : normalizeQuaternion([0, delta[1], 0, delta[3]])
  return multiplyQuaternions(yawTwist, rest)
}

export function solveFabrikPositions(
  inputPositions,
  target,
  { maxIterations = 8, toleranceM = 1e-5 } = {},
) {
  if (!Array.isArray(inputPositions) || inputPositions.length < 2) {
    throw new TypeError('FABRIK requires at least two chain points')
  }
  const positions = inputPositions.map((position) => [...position])
  const lengths = positions.slice(0, -1).map(
    (position, index) => length(subtract(positions[index + 1], position)),
  )
  if (lengths.some((segment) => segment < 1e-8)) {
    throw new Error('FABRIK chain contains a degenerate segment')
  }
  const origin = [...positions[0]]
  const totalLength = lengths.reduce((sum, segment) => sum + segment, 0)
  if (length(subtract(target, origin)) >= totalLength) {
    const direction = normalize(subtract(target, origin))
    positions[0] = origin
    for (let index = 0; index < lengths.length; index += 1) {
      positions[index + 1] = add(
        positions[index],
        scale(direction, lengths[index]),
      )
    }
    return positions
  }

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    positions[positions.length - 1] = [...target]
    for (let index = positions.length - 2; index >= 0; index -= 1) {
      const direction = normalize(subtract(positions[index], positions[index + 1]))
      positions[index] = add(
        positions[index + 1],
        scale(direction, lengths[index]),
      )
    }
    positions[0] = [...origin]
    for (let index = 0; index < positions.length - 1; index += 1) {
      const direction = normalize(subtract(positions[index + 1], positions[index]))
      positions[index + 1] = add(
        positions[index],
        scale(direction, lengths[index]),
      )
    }
    if (length(subtract(positions.at(-1), target)) <= toleranceM) break
  }
  return positions
}

function projectOntoPlane(vector, normal) {
  return subtract(vector, scale(normal, dot(vector, normal)))
}

export function solveTwoBonePositions(inputPositions, target, poleWorldDirection) {
  if (!Array.isArray(inputPositions) || inputPositions.length !== 3) {
    throw new TypeError('two-bone IK requires exactly three chain points')
  }
  const [origin, knee, foot] = inputPositions.map((position) => [...position])
  const upperLength = length(subtract(knee, origin))
  const lowerLength = length(subtract(foot, knee))
  if (upperLength < 1e-8 || lowerLength < 1e-8) {
    throw new Error('two-bone IK chain contains a degenerate segment')
  }
  let targetDirection = subtract(target, origin)
  let targetDistance = length(targetDirection)
  if (targetDistance < 1e-8) {
    targetDirection = subtract(foot, origin)
    targetDistance = length(targetDirection)
  }
  const axis = normalize(targetDirection)
  const minimumReach = Math.abs(upperLength - lowerLength) + 1e-9
  const maximumReach = upperLength + lowerLength - 1e-9
  const solvedDistance = Math.max(
    minimumReach,
    Math.min(maximumReach, targetDistance),
  )
  const solvedFoot = add(origin, scale(axis, solvedDistance))
  const along = (
    upperLength * upperLength
    - lowerLength * lowerLength
    + solvedDistance * solvedDistance
  ) / (2 * solvedDistance)
  const radius = Math.sqrt(Math.max(0, upperLength * upperLength - along * along))
  let pole = projectOntoPlane(poleWorldDirection, axis)
  if (length(pole) < 1e-8) {
    pole = projectOntoPlane(subtract(knee, origin), axis)
  }
  if (length(pole) < 1e-8) {
    const candidate = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1]
    pole = cross(axis, candidate)
  }
  const solvedKnee = add(
    add(origin, scale(axis, along)),
    scale(normalize(pole), radius),
  )
  return [origin, solvedKnee, solvedFoot]
}

export function createIkSession(profile) {
  const locks = new Map()

  function reset() {
    locks.clear()
  }

  function apply(pose, motion, frame) {
    if (!profile.ik?.enabled) return pose
    const contacts = motion.foot_contacts?.[frame]
    if (!contacts) throw new Error('enabled contact IK requires foot_contacts')
    const bySemantic = new Map(pose.bones.map((bone) => [bone.semantic, bone]))
    const mappingBySemantic = new Map(
      profile.mapping.map((mapping) => [mapping.semantic, mapping]),
    )
    const results = {}
    const pelvisConfig = profile.ik.pelvis_compensation
    let pelvisLowering = 0

    if (pelvisConfig?.enabled && pelvisConfig.max_lowering_m > 0) {
      for (const [targetId, config] of Object.entries(profile.ik.targets)) {
        const chain = config.chain.map((semantic) => bySemantic.get(semantic))
        if (chain.some((bone) => !bone)) continue
        const foot = chain.at(-1)
        const groundTarget = [
          foot.world_position[0],
          config.ground_y + (config.sole_offset_m ?? 0),
          foot.world_position[2],
        ]
        const previousLock = locks.get(targetId) ?? null
        const threshold = previousLock?.contact_active
          ? config.contact_threshold - (config.contact_hysteresis ?? 0)
          : config.contact_threshold
        const active = contacts[config.contact_channel] > threshold
        const temporalLock = config.lock_horizontal || config.lock_orientation
        const blendFrames = Math.max(1, config.lock_blend_frames ?? 1)
        let projectedLock = previousLock
        if (temporalLock) {
          if (active) {
            projectedLock = {
              target: previousLock?.contact_active
                ? previousLock.target
                : groundTarget,
              weight: Math.min(
                1,
                (previousLock?.weight ?? 0) + 1 / blendFrames,
              ),
            }
          } else if (previousLock) {
            const weight = Math.max(0, previousLock.weight - 1 / blendFrames)
            if (weight <= 1e-12) continue
            projectedLock = { target: previousLock.target, weight }
          } else {
            continue
          }
        } else if (!active) {
          continue
        }
        const target = config.lock_horizontal && projectedLock
          ? groundTarget.map(
            (component, index) => (
              component
              + (projectedLock.target[index] - component)
                * projectedLock.weight
            ),
          )
          : groundTarget
        const positions = chain.map((bone) => bone.world_position)
        const reach = positions.slice(0, -1).reduce(
          (sum, position, index) => (
            sum + length(subtract(positions[index + 1], position))
          ),
          0,
        )
        const origin = positions[0]
        const horizontalDistance = Math.hypot(
          target[0] - origin[0],
          target[2] - origin[2],
        )
        if (horizontalDistance >= reach) continue
        const verticalReach = Math.sqrt(
          reach * reach - horizontalDistance * horizontalDistance,
        )
        pelvisLowering = Math.min(
          pelvisLowering,
          target[1] + verticalReach - origin[1],
        )
      }
      pelvisLowering = Math.max(
        -pelvisConfig.max_lowering_m,
        pelvisLowering,
      )
      if (pelvisLowering < 0) {
        for (const bone of pose.bones) {
          bone.world_position[1] += pelvisLowering
        }
        const hips = bySemantic.get('hips')
        if (hips?.local_position) hips.local_position[1] += pelvisLowering
      }
    }

    for (const [targetId, config] of Object.entries(profile.ik.targets)) {
      const chain = config.chain.map((semantic) => {
        const bone = bySemantic.get(semantic)
        if (!bone) throw new Error(`IK chain target "${semantic}" is not mapped`)
        return bone
      })
      const foot = chain.at(-1)
      const groundTarget = [
        foot.world_position[0],
        config.ground_y + (config.sole_offset_m ?? 0),
        foot.world_position[2],
      ]
      const previousLock = locks.get(targetId) ?? null
      const threshold = previousLock?.contact_active
        ? config.contact_threshold - (config.contact_hysteresis ?? 0)
        : config.contact_threshold
      const active = contacts[config.contact_channel] > threshold
      const blendFrames = Math.max(1, config.lock_blend_frames ?? 1)
      const temporalLock = config.lock_horizontal || config.lock_orientation
      let lock = previousLock
      if (temporalLock) {
        if (active) {
          if (!lock || !lock.contact_active) {
            const restOrientation =
              profile.rest_calibration.per_bone[foot.semantic]
                .target_rest_world_quaternion
            lock = {
              target: [...groundTarget],
              orientation: config.lock_orientation
                ? groundedFootQuaternion(
                  foot.world_quaternion,
                  restOrientation,
                )
                : null,
              weight: lock?.weight ?? 0,
              contact_active: true,
            }
          }
          lock.contact_active = true
          lock.weight = Math.min(1, lock.weight + 1 / blendFrames)
          locks.set(targetId, lock)
        } else if (lock) {
          lock.contact_active = false
          lock.weight = Math.max(0, lock.weight - 1 / blendFrames)
          if (lock.weight <= 1e-12) {
            locks.delete(targetId)
            continue
          }
        } else {
          continue
        }
      } else if (!active) {
        continue
      }
      const lockWeight = temporalLock ? lock.weight : 0
      const target = config.lock_horizontal
        ? groundTarget.map(
          (component, index) => (
            component + (lock.target[index] - component) * lockWeight
          ),
        )
        : groundTarget
      const originalPositions = chain.map((bone) => [...bone.world_position])
      const originalFootPosition = [...foot.world_position]
      const originalFootQuaternion = [...foot.world_quaternion]
      const solvedPositions = chain.length === 3 && config.pole_world_direction
        ? solveTwoBonePositions(
          originalPositions,
          target,
          config.pole_world_direction,
        )
        : solveFabrikPositions(originalPositions, target, {
          maxIterations: config.max_iterations,
          toleranceM: config.tolerance_m,
        })
      for (let index = 0; index < chain.length - 1; index += 1) {
        const currentDirection = subtract(
          originalPositions[index + 1],
          originalPositions[index],
        )
        const solvedDirection = subtract(
          solvedPositions[index + 1],
          solvedPositions[index],
        )
        const delta = quaternionFromUnitVectors(currentDirection, solvedDirection)
        const worldQuaternion = multiplyQuaternions(
          delta,
          chain[index].world_quaternion,
        )
        const parentSemantic = mappingBySemantic.get(chain[index].semantic)
          ?.target_parent_semantic
        const parentWorld = parentSemantic
          ? bySemantic.get(parentSemantic)?.world_quaternion
          : profile.rest_calibration.per_bone[chain[index].semantic]
            .target_parent_rest_world_quaternion
        chain[index].world_quaternion = worldQuaternion
        chain[index].local_quaternion = multiplyQuaternions(
          invertQuaternion(parentWorld),
          worldQuaternion,
        )
        chain[index].world_position = solvedPositions[index]
      }
      const footDelta = subtract(solvedPositions.at(-1), chain.at(-1).world_position)
      chain.at(-1).world_position = solvedPositions.at(-1)
      let footRotationDelta = [0, 0, 0, 1]
      if (config.lock_orientation && lock?.orientation) {
        const lockedOrientation = slerpQuaternions(
          originalFootQuaternion,
          lock.orientation,
          lockWeight,
        )
        footRotationDelta = multiplyQuaternions(
          lockedOrientation,
          invertQuaternion(originalFootQuaternion),
        )
        foot.world_quaternion = lockedOrientation
        foot.local_quaternion = multiplyQuaternions(
          invertQuaternion(chain.at(-2).world_quaternion),
          lockedOrientation,
        )
      }
      const footSemantic = chain.at(-1).semantic
      for (const bone of pose.bones) {
        if (mappingBySemantic.get(bone.semantic)?.target_parent_semantic === footSemantic) {
          const relative = subtract(bone.world_position, originalFootPosition)
          bone.world_position = add(
            solvedPositions.at(-1),
            rotateVector(relative, footRotationDelta),
          )
          bone.world_quaternion = multiplyQuaternions(
            footRotationDelta,
            bone.world_quaternion,
          )
        }
      }
      results[targetId] = {
        contact_active: active,
        lock_weight: lockWeight,
        horizontal_lock: Boolean(config.lock_horizontal),
        orientation_lock: Boolean(config.lock_orientation),
        target_world_quaternion: lock?.orientation
          ? [...lock.orientation]
          : null,
        solved_world_quaternion: [...foot.world_quaternion],
        pelvis_lowering_m: pelvisLowering,
        target_world_position: [...target],
        solved_world_position: [...solvedPositions.at(-1)],
        error_m: length(subtract(solvedPositions.at(-1), target)),
      }
    }
    return {
      ...pose,
      corrections: {
        ...(pose.corrections ?? {}),
        pelvis_lowering_m: pelvisLowering,
      },
      ik: results,
    }
  }

  return { apply, reset }
}
