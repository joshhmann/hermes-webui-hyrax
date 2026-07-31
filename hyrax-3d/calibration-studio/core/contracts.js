import { sha256Signature } from './sha256.js?v=1'

export const CONTRACT_SCHEMAS = Object.freeze({
  somaMotion: 'soma.motion-ir',
  avatarRig: 'soma.avatar-rig-ir',
  calibrationProfile: 'soma.avatar-calibration',
})

export const CONTRACT_VERSION = '1.0.0'

export class ContractValidationError extends Error {
  constructor(contractName, issues) {
    super(`${contractName} contract invalid: ${issues.join('; ')}`)
    this.name = 'ContractValidationError'
    this.contractName = contractName
    this.issues = issues
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function isVector(value, length) {
  return Array.isArray(value)
    && value.length === length
    && value.every(isFiniteNumber)
}

function requireString(value, path, issues) {
  if (typeof value !== 'string' || value.length === 0) {
    issues.push(`${path} must be a non-empty string`)
  }
}

function requireSchema(value, expected, issues) {
  if (!isRecord(value)) {
    issues.push('$ must be an object')
    return false
  }
  if (value.schema !== expected) issues.push(`schema must equal "${expected}"`)
  if (value.schema_version !== CONTRACT_VERSION) {
    issues.push(`schema_version must equal "${CONTRACT_VERSION}"`)
  }
  return true
}

function validateParentOrder(names, parents, path, issues) {
  if (!Array.isArray(names) || !Array.isArray(parents)) return
  if (names.length !== parents.length) {
    issues.push(`${path} names and parents must have equal length`)
    return
  }
  const seen = new Set()
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]
    const parent = parents[index]
    requireString(name, `${path}.names[${index}]`, issues)
    if (seen.has(name)) issues.push(`${path}.names[${index}] duplicates "${name}"`)
    if (index === 0 && parent !== null) {
      issues.push(`${path}.parents[0] must be null`)
    } else if (index > 0 && (!seen.has(parent) || parent === name)) {
      issues.push(`${path}.parents[${index}] must name an earlier joint`)
    }
    seen.add(name)
  }
}

export function validateSomaMotionIR(value, canonicalSkeleton = null) {
  const issues = []
  if (!requireSchema(value, CONTRACT_SCHEMAS.somaMotion, issues)) return issues
  requireString(value.skeleton_id, 'skeleton_id', issues)
  requireString(value.skeleton_version, 'skeleton_version', issues)
  requireString(value.skeleton_signature, 'skeleton_signature', issues)
  requireString(value.motion_signature, 'motion_signature', issues)
  if (value.rotation_space !== 'global') issues.push('rotation_space must equal "global"')
  if (value.rotation_representation !== 'mat3-row-major') {
    issues.push('rotation_representation must equal "mat3-row-major"')
  }
  if (!isFiniteNumber(value.fps) || value.fps <= 0) issues.push('fps must be positive')
  validateParentOrder(value.joints, value.parents, 'hierarchy', issues)

  const jointCount = Array.isArray(value.joints) ? value.joints.length : 0
  const frameCount = Number.isInteger(value.frame_count) ? value.frame_count : -1
  if (frameCount < 1) issues.push('frame_count must be a positive integer')
  if (!Array.isArray(value.global_rot_mats)
      || value.global_rot_mats.length !== frameCount) {
    issues.push('global_rot_mats length must equal frame_count')
  } else {
    value.global_rot_mats.forEach((frame, frameIndex) => {
      if (!Array.isArray(frame) || frame.length !== jointCount) {
        issues.push(`global_rot_mats[${frameIndex}] must contain ${jointCount} joints`)
      } else if (frame.some((matrix) => !isVector(matrix, 9))) {
        issues.push(`global_rot_mats[${frameIndex}] contains an invalid mat3`)
      }
    })
  }
  if (!Array.isArray(value.root_positions)
      || value.root_positions.length !== frameCount
      || value.root_positions.some((position) => !isVector(position, 3))) {
    issues.push('root_positions must contain one vec3 per frame')
  }
  if (!Array.isArray(value.rest_offsets_m)
      || value.rest_offsets_m.length !== jointCount
      || value.rest_offsets_m.some((offset) => !isVector(offset, 3))) {
    issues.push('rest_offsets_m must contain one vec3 per joint')
  }
  if (value.foot_contacts !== undefined
      && (!Array.isArray(value.foot_contacts)
        || value.foot_contacts.length !== frameCount
        || value.foot_contacts.some((contacts) => !isVector(contacts, 4)))) {
    issues.push('foot_contacts must contain four numeric channels per frame')
  }

  if (canonicalSkeleton) {
    const expectedJoints = canonicalSkeleton.joints.map((joint) => joint.name)
    const expectedParents = canonicalSkeleton.joints.map((joint) => joint.parent)
    if (JSON.stringify(value.joints) !== JSON.stringify(expectedJoints)) {
      issues.push('joints do not match the canonical SOMA77 order')
    }
    if (JSON.stringify(value.parents) !== JSON.stringify(expectedParents)) {
      issues.push('parents do not match the canonical SOMA77 hierarchy')
    }
    if (value.skeleton_id !== canonicalSkeleton.id) {
      issues.push(`skeleton_id must equal "${canonicalSkeleton.id}"`)
    }
    if (value.skeleton_version !== canonicalSkeleton.version) {
      issues.push(`skeleton_version must equal "${canonicalSkeleton.version}"`)
    }
  }
  return issues
}

function validateTransform(transform, path, issues) {
  if (!isRecord(transform)) {
    issues.push(`${path} must be an object`)
    return
  }
  if (!isVector(transform.position, 3)) issues.push(`${path}.position must be a vec3`)
  if (!isVector(transform.quaternion, 4)) issues.push(`${path}.quaternion must be xyzw`)
  if (!isVector(transform.scale, 3)) issues.push(`${path}.scale must be a vec3`)
}

export function validateAvatarRigIR(value) {
  const issues = []
  if (!requireSchema(value, CONTRACT_SCHEMAS.avatarRig, issues)) return issues
  requireString(value.rig_id, 'rig_id', issues)
  requireString(value.rig_signature, 'rig_signature', issues)
  if (!isRecord(value.source)) {
    issues.push('source must be an object')
  } else {
    requireString(value.source.format, 'source.format', issues)
    requireString(value.source.format_version, 'source.format_version', issues)
    requireString(value.source.asset_signature, 'source.asset_signature', issues)
    requireString(value.source.importer, 'source.importer', issues)
    requireString(value.source.importer_version, 'source.importer_version', issues)
    if (!['raw', 'normalized'].includes(value.source.rig_space)) {
      issues.push('source.rig_space must equal "raw" or "normalized"')
    }
    requireString(value.source.basis_correction, 'source.basis_correction', issues)
  }
  if (!isRecord(value.coordinate_system)) {
    issues.push('coordinate_system must be an object')
  } else {
    if (!['declared', 'unresolved'].includes(value.coordinate_system.status)) {
      issues.push('coordinate_system.status must equal "declared" or "unresolved"')
    }
    for (const field of [
      'handedness',
      'up_axis',
      'forward_axis',
      'linear_unit',
    ]) {
      requireString(
        value.coordinate_system[field],
        `coordinate_system.${field}`,
        issues,
      )
    }
    if (value.coordinate_system.status === 'declared'
        && value.coordinate_system.linear_unit !== 'meter') {
      issues.push('a declared coordinate_system.linear_unit must equal "meter"')
    }
  }
  if (!Array.isArray(value.bones) || value.bones.length === 0) {
    issues.push('bones must be a non-empty array')
    return issues
  }

  const seenIds = new Set()
  const seenSemantics = new Set()
  value.bones.forEach((bone, index) => {
    const path = `bones[${index}]`
    if (!isRecord(bone)) {
      issues.push(`${path} must be an object`)
      return
    }
    requireString(bone.id, `${path}.id`, issues)
    requireString(bone.name, `${path}.name`, issues)
    if (seenIds.has(bone.id)) issues.push(`${path}.id duplicates "${bone.id}"`)
    if (bone.parent_id !== null && !seenIds.has(bone.parent_id)) {
      issues.push(`${path}.parent_id must name an earlier bone`)
    }
    if (bone.semantic !== null) {
      requireString(bone.semantic, `${path}.semantic`, issues)
      if (seenSemantics.has(bone.semantic)) {
        issues.push(`${path}.semantic duplicates "${bone.semantic}"`)
      }
      seenSemantics.add(bone.semantic)
    }
    validateTransform(bone.rest_local, `${path}.rest_local`, issues)
    validateTransform(bone.rest_world, `${path}.rest_world`, issues)
    seenIds.add(bone.id)
  })
  return issues
}

export function validateCalibrationProfile(
  value,
  { requireComplete = false, avatarRig = null, canonicalSkeleton = null } = {},
) {
  const issues = []
  if (!requireSchema(value, CONTRACT_SCHEMAS.calibrationProfile, issues)) return issues
  requireString(value.profile_id, 'profile_id', issues)
  if (!['draft', 'validated'].includes(value.status)) {
    issues.push('status must equal "draft" or "validated"')
  }
  if (requireComplete && value.status !== 'validated') {
    issues.push('a runtime profile must have status "validated"')
  }
  for (const section of ['soma_contract', 'avatar', 'root_calibration', 'scale_calibration']) {
    if (!isRecord(value[section])) issues.push(`${section} must be an object`)
  }
  requireString(value.soma_contract?.signature, 'soma_contract.signature', issues)
  requireString(value.avatar?.asset_signature, 'avatar.asset_signature', issues)
  requireString(value.avatar?.rig_signature, 'avatar.rig_signature', issues)

  const mappingEntries = Array.isArray(value.mapping) ? value.mapping : []
  if (mappingEntries.length === 0) {
    issues.push('mapping must be a non-empty array')
  } else {
    const semantics = new Set()
    const targets = new Set()
    mappingEntries.forEach((entry, index) => {
      const path = `mapping[${index}]`
      if (!isRecord(entry)) {
        issues.push(`${path} must be an object`)
        return
      }
      requireString(entry.semantic, `${path}.semantic`, issues)
      requireString(entry.soma_joint, `${path}.soma_joint`, issues)
      requireString(entry.target_bone_id, `${path}.target_bone_id`, issues)
      if (semantics.has(entry.semantic)) issues.push(`${path}.semantic is duplicated`)
      if (targets.has(entry.target_bone_id)) issues.push(`${path}.target_bone_id is duplicated`)
      semantics.add(entry.semantic)
      targets.add(entry.target_bone_id)
    })
  }
  if (!isRecord(value.rest_calibration)
      || !isRecord(value.rest_calibration.per_bone)) {
    issues.push('rest_calibration.per_bone must be an object')
  }
  if (requireComplete) {
    if (!avatarRig) issues.push('runtime validation requires the imported Avatar Rig IR')
    if (!canonicalSkeleton) issues.push('runtime validation requires the SOMA skeleton contract')
    const calibrated = new Set(Object.keys(value.rest_calibration?.per_bone ?? {}))
    for (const entry of mappingEntries) {
      if (!isRecord(entry)) continue
      if (!calibrated.has(entry.semantic)) {
        issues.push(`rest_calibration.per_bone.${entry.semantic} is missing`)
        continue
      }
      const calibration = value.rest_calibration.per_bone[entry.semantic]
      const path = `rest_calibration.per_bone.${entry.semantic}`
      if (!isRecord(calibration) || calibration.status !== 'captured') {
        issues.push(`${path}.status must equal "captured"`)
        continue
      }
      for (const field of [
        'source_rest_world_quaternion',
        'source_rest_inverse_quaternion',
        'target_rest_world_quaternion',
        'target_parent_rest_world_quaternion',
        'user_offset_quaternion',
      ]) {
        if (!isVector(calibration[field], 4)) {
          issues.push(`${path}.${field} must be an xyzw quaternion`)
        }
      }
      if (!isVector(calibration.target_parent_rest_world_position, 3)) {
        issues.push(`${path}.target_parent_rest_world_position must be a vec3`)
      }
    }
    if (value.root_calibration?.status !== 'calibrated') {
      issues.push('root_calibration.status must equal "calibrated"')
    }
    if (value.scale_calibration?.status !== 'calibrated') {
      issues.push('scale_calibration.status must equal "calibrated"')
    }
    if (!isFiniteNumber(value.scale_calibration?.translation_scale)
        || value.scale_calibration.translation_scale <= 0) {
      issues.push('scale_calibration.translation_scale must be positive')
    }
    if (!isVector(value.root_calibration?.source_rest_position_m, 3)) {
      issues.push('root_calibration.source_rest_position_m must be a vec3')
    }
    if (!isVector(value.root_calibration?.target_rest_world_position_m, 3)) {
      issues.push('root_calibration.target_rest_world_position_m must be a vec3')
    }
    if (!Array.isArray(value.root_calibration?.enabled_axes)
        || value.root_calibration.enabled_axes.some(
          (axis) => !['x', 'y', 'z'].includes(axis),
        )) {
      issues.push('root_calibration.enabled_axes must contain only x, y, and z')
    }
    requireString(value.validation?.suite_signature, 'validation.suite_signature', issues)
    requireString(value.validation?.result_signature, 'validation.result_signature', issues)
    requireString(value.validation?.motion_signature, 'validation.motion_signature', issues)
    if (value.validation?.qualification_motion_signature !== undefined) {
      requireString(
        value.validation.qualification_motion_signature,
        'validation.qualification_motion_signature',
        issues,
      )
    }
    requireString(
      value.validation?.profile_input_signature,
      'validation.profile_input_signature',
      issues,
    )
    if (value.runtime_corrections !== undefined
        && value.runtime_corrections !== null) {
      const correction = value.runtime_corrections
      if (!isRecord(correction)) {
        issues.push('runtime_corrections must be an object or null')
      } else {
        requireString(correction.mode, 'runtime_corrections.mode', issues)
        if (!['add-delta-to-rest', 'legacy-replace-xz-add-y'].includes(
          correction.root_position_mode,
        )) {
          issues.push(
            'runtime_corrections.root_position_mode is not a supported mode',
          )
        }
        if (!isFiniteNumber(correction.translation_scale_override)
            || correction.translation_scale_override <= 0) {
          issues.push('runtime_corrections.translation_scale_override must be positive')
        }
        const ground = correction.ground_contact
        if (!isRecord(ground)) {
          issues.push('runtime_corrections.ground_contact must be an object')
        } else if (ground.enabled) {
          if (!isFiniteNumber(ground.ground_y)) {
            issues.push('runtime_corrections.ground_contact.ground_y must be finite')
          }
          if (!isFiniteNumber(ground.contact_threshold)) {
            issues.push(
              'runtime_corrections.ground_contact.contact_threshold must be finite',
            )
          }
          if (!isFiniteNumber(ground.smoothing_factor)
              || ground.smoothing_factor < 0
              || ground.smoothing_factor > 1) {
            issues.push(
              'runtime_corrections.ground_contact.smoothing_factor must be between 0 and 1',
            )
          }
          if (!isRecord(ground.contact_channels)
              || Object.values(ground.contact_channels).some(
                (channel) => !Number.isInteger(channel) || channel < 0,
              )) {
            issues.push(
              'runtime_corrections.ground_contact.contact_channels must map to channel indices',
            )
          }
        }
      }
    }
    if (value.ik?.enabled) {
      const pelvis = value.ik.pelvis_compensation
      if (pelvis !== undefined
          && (!isRecord(pelvis)
            || typeof pelvis.enabled !== 'boolean'
            || !isFiniteNumber(pelvis.max_lowering_m)
            || pelvis.max_lowering_m < 0)) {
        issues.push(
          'ik.pelvis_compensation must declare enabled and non-negative max_lowering_m',
        )
      }
      if (!isRecord(value.ik.targets)
          || Object.keys(value.ik.targets).length === 0) {
        issues.push('enabled IK requires at least one target')
      } else {
        const mappedSemantics = new Set(
          mappingEntries.map((entry) => entry.semantic),
        )
        for (const [targetId, target] of Object.entries(value.ik.targets)) {
          const path = `ik.targets.${targetId}`
          if (!isRecord(target)) {
            issues.push(`${path} must be an object`)
            continue
          }
          if (!Array.isArray(target.chain)
              || target.chain.length < 2
              || target.chain.some((semantic) => !mappedSemantics.has(semantic))) {
            issues.push(`${path}.chain must contain at least two mapped semantics`)
          }
          if (!Number.isInteger(target.contact_channel)
              || target.contact_channel < 0) {
            issues.push(`${path}.contact_channel must be a non-negative integer`)
          }
          for (const field of [
            'contact_threshold',
            'ground_y',
            'tolerance_m',
          ]) {
            if (!isFiniteNumber(target[field])) {
              issues.push(`${path}.${field} must be finite`)
            }
          }
          if (typeof target.lock_horizontal !== 'boolean') {
            issues.push(`${path}.lock_horizontal must be boolean`)
          }
          if (target.lock_orientation !== undefined
              && typeof target.lock_orientation !== 'boolean') {
            issues.push(`${path}.lock_orientation must be boolean`)
          }
          if (target.orientation_tolerance_deg !== undefined
              && (!isFiniteNumber(target.orientation_tolerance_deg)
                || target.orientation_tolerance_deg <= 0)) {
            issues.push(`${path}.orientation_tolerance_deg must be positive`)
          }
          if (target.lock_orientation
              && target.orientation_tolerance_deg === undefined) {
            issues.push(
              `${path}.orientation_tolerance_deg is required when orientation locks`,
            )
          }
          if (target.sole_offset_m !== undefined
              && !isFiniteNumber(target.sole_offset_m)) {
            issues.push(`${path}.sole_offset_m must be finite`)
          }
          if (target.contact_hysteresis !== undefined
              && (!isFiniteNumber(target.contact_hysteresis)
                || target.contact_hysteresis < 0)) {
            issues.push(`${path}.contact_hysteresis must be non-negative`)
          }
          if (target.lock_blend_frames !== undefined
              && (!Number.isInteger(target.lock_blend_frames)
                || target.lock_blend_frames < 1)) {
            issues.push(`${path}.lock_blend_frames must be a positive integer`)
          }
          if (target.pole_world_direction !== undefined
              && !isVector(target.pole_world_direction, 3)) {
            issues.push(`${path}.pole_world_direction must be a vec3`)
          }
          if (!Number.isInteger(target.max_iterations)
              || target.max_iterations < 1) {
            issues.push(`${path}.max_iterations must be a positive integer`)
          }
        }
      }
    }
  }
  if (avatarRig) {
    const targetIds = new Set(avatarRig.bones?.map((bone) => bone.id) ?? [])
    for (const entry of mappingEntries) {
      if (!isRecord(entry)) continue
      if (!targetIds.has(entry.target_bone_id)) {
        issues.push(`mapping target "${entry.target_bone_id}" is absent from the avatar rig`)
      }
    }
    if (value.avatar?.rig_signature !== avatarRig.rig_signature) {
      issues.push('avatar.rig_signature does not match the imported avatar rig')
    }
    if (value.avatar?.asset_signature !== avatarRig.source?.asset_signature) {
      issues.push('avatar.asset_signature does not match the imported avatar asset')
    }
  }
  if (canonicalSkeleton) {
    const somaJoints = new Set(canonicalSkeleton.joints?.map((joint) => joint.name) ?? [])
    for (const entry of mappingEntries) {
      if (!isRecord(entry)) continue
      if (!somaJoints.has(entry.soma_joint)) {
        issues.push(`mapping SOMA joint "${entry.soma_joint}" is absent from the contract`)
      }
    }
    if (value.soma_contract?.id !== canonicalSkeleton.id) {
      issues.push('soma_contract.id does not match the canonical skeleton')
    }
    if (value.soma_contract?.version !== canonicalSkeleton.version) {
      issues.push('soma_contract.version does not match the canonical skeleton')
    }
  }
  return issues
}

function assertValid(name, issues, value) {
  if (issues.length > 0) throw new ContractValidationError(name, issues)
  return value
}

export function assertSomaMotionIR(value, canonicalSkeleton = null) {
  return assertValid('SOMA Motion IR', validateSomaMotionIR(value, canonicalSkeleton), value)
}

export function assertAvatarRigIR(value) {
  return assertValid('Avatar Rig IR', validateAvatarRigIR(value), value)
}

export function assertCalibrationProfile(value, options = {}) {
  return assertValid(
    'Avatar Calibration Profile',
    validateCalibrationProfile(value, options),
    value,
  )
}

export function canonicalize(value, path = '$') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (isFiniteNumber(value)) return Object.is(value, -0) ? 0 : value
  if (Array.isArray(value)) {
    return value.map((entry, index) => canonicalize(entry, `${path}[${index}]`))
  }
  if (!isRecord(value)) {
    throw new TypeError(`contract value at ${path} must be JSON-compatible`)
  }
  return Object.fromEntries(
    Object.keys(value).sort().map(
      (key) => [key, canonicalize(value[key], `${path}.${key}`)],
    ),
  )
}

export function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value))
}

export async function contractSignature(value) {
  const bytes = new TextEncoder().encode(canonicalStringify(value))
  return sha256Signature(bytes)
}

export function createCalibrationProfileDraft({
  profileId,
  somaContract,
  avatarRig,
  mapping,
}) {
  assertAvatarRigIR(avatarRig)
  if (avatarRig.coordinate_system.status !== 'declared') {
    throw new ContractValidationError('Avatar Calibration Profile', [
      'avatar coordinate system must be declared before profile authoring',
    ])
  }
  if (!Array.isArray(mapping) || mapping.length === 0) {
    throw new ContractValidationError('Avatar Calibration Profile', [
      'mapping must be a non-empty array',
    ])
  }
  const boneIds = new Set(avatarRig.bones.map((bone) => bone.id))
  if (!Array.isArray(somaContract.joints) || somaContract.joints.length === 0) {
    throw new ContractValidationError('Avatar Calibration Profile', [
      'the complete SOMA skeleton contract is required to create a draft',
    ])
  }
  const somaJoints = new Set(somaContract.joints.map((joint) => joint.name))
  for (const entry of mapping) {
    if (!somaJoints.has(entry.soma_joint)) {
      throw new ContractValidationError('Avatar Calibration Profile', [
        `mapping SOMA joint "${entry.soma_joint}" is absent from the contract`,
      ])
    }
    if (!boneIds.has(entry.target_bone_id)) {
      throw new ContractValidationError('Avatar Calibration Profile', [
        `mapping target "${entry.target_bone_id}" is absent from the avatar rig`,
      ])
    }
  }
  const draft = {
    schema: CONTRACT_SCHEMAS.calibrationProfile,
    schema_version: CONTRACT_VERSION,
    profile_id: profileId,
    status: 'draft',
    soma_contract: {
      id: somaContract.id,
      version: somaContract.version,
      signature: somaContract.signature,
    },
    avatar: {
      format: avatarRig.source.format,
      asset_signature: avatarRig.source.asset_signature,
      rig_signature: avatarRig.rig_signature,
    },
    mapping: structuredClone(mapping),
    rest_calibration: {
      rotation_model: 'unresolved',
      per_bone: {},
    },
    root_calibration: {
      status: 'unresolved',
    },
    scale_calibration: {
      status: 'unresolved',
    },
    ik: {
      enabled: false,
      targets: {},
    },
    validation: null,
  }
  return assertCalibrationProfile(draft)
}
