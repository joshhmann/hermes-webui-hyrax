import {
  invertQuaternion,
  mat3RowMajorToQuaternion,
  multiplyQuaternions,
} from './calibration.js?v=10'

function add(left, right) {
  return left.map((component, index) => component + right[index])
}

function scale(vector, factor) {
  return vector.map((component) => component * factor)
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

function normalizeQuaternion([x, y, z, w]) {
  const length = Math.hypot(x, y, z, w)
  if (!Number.isFinite(length) || length < 1e-12) {
    throw new TypeError('quaternion must have finite, non-zero length')
  }
  const normalized = [x / length, y / length, z / length, w / length]
  return normalized[3] < 0
    ? normalized.map((component) => -component)
    : normalized
}

export function mappingCoverage(catalog, mapping) {
  if (!Array.isArray(catalog?.groups) || !Array.isArray(catalog?.roles)) {
    throw new TypeError('authoring catalog must contain groups and roles')
  }
  if (!Array.isArray(mapping)) throw new TypeError('mapping must be an array')
  const mapped = new Set(mapping.map((entry) => entry?.semantic).filter(Boolean))
  const groups = Object.fromEntries(catalog.groups.map((group) => {
    const roles = catalog.roles.filter((role) => role.group === group.id)
    return [group.id, {
      mapped: roles.filter((role) => mapped.has(role.semantic)).length,
      total: roles.length,
      required: roles.filter((role) => role.required).length,
    }]
  }))
  const missingRequired = catalog.roles
    .filter((role) => role.required && !mapped.has(role.semantic))
    .map((role) => role.semantic)
  return {
    catalog_id: catalog.id,
    catalog_version: catalog.version,
    core_complete: missingRequired.length === 0,
    missing_required: missingRequired,
    groups,
  }
}

/**
 * Reflect a local correction across avatar X=0, accounting for different
 * source and paired-bone rest bases.
 */
export function mirrorLocalOffset({
  quaternion,
  sourceRestWorldQuaternion,
  targetRestWorldQuaternion,
}) {
  const sourceRest = normalizeQuaternion(sourceRestWorldQuaternion)
  const targetRest = normalizeQuaternion(targetRestWorldQuaternion)
  const localOffset = normalizeQuaternion(quaternion)
  const worldDelta = multiplyQuaternions(
    multiplyQuaternions(sourceRest, localOffset),
    invertQuaternion(sourceRest),
  )
  const mirroredWorldDelta = normalizeQuaternion([
    worldDelta[0],
    -worldDelta[1],
    -worldDelta[2],
    worldDelta[3],
  ])
  return normalizeQuaternion(multiplyQuaternions(
    multiplyQuaternions(invertQuaternion(targetRest), mirroredWorldDelta),
    targetRest,
  ))
}

export function somaWorldPositions(
  motion,
  frame,
  { scale: scaleFactor = 1, rootAnchor = null } = {},
) {
  if (!Number.isInteger(frame) || frame < 0 || frame >= motion?.frame_count) {
    throw new RangeError(`frame must be between 0 and ${motion?.frame_count - 1}`)
  }
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
    throw new TypeError('scale must be positive and finite')
  }
  if (rootAnchor !== null
      && (!Array.isArray(rootAnchor)
        || rootAnchor.length !== 3
        || rootAnchor.some((value) => !Number.isFinite(value)))) {
    throw new TypeError('rootAnchor must be a finite vec3 or null')
  }
  const indexByName = new Map(motion.joints.map((name, index) => [name, index]))
  const positions = []
  for (let index = 0; index < motion.joints.length; index += 1) {
    const parent = motion.parents[index]
    if (parent === null) {
      positions.push(rootAnchor
        ? [...rootAnchor]
        : scale(motion.root_positions[frame], scaleFactor))
      continue
    }
    const parentIndex = indexByName.get(parent)
    const parentRotation = mat3RowMajorToQuaternion(
      motion.global_rot_mats[frame][parentIndex],
    )
    positions.push(add(
      positions[parentIndex],
      rotateVector(
        scale(motion.rest_offsets_m[index], scaleFactor),
        parentRotation,
      ),
    ))
  }
  return positions
}
