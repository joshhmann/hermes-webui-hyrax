import {
  CONTRACT_SCHEMAS,
  CONTRACT_VERSION,
  assertSomaMotionIR,
  contractSignature,
} from '../core/contracts.js?v=10'

function canonicalSkeletonId(inputId, skeletonContract) {
  if (inputId === skeletonContract.id) return inputId
  return skeletonContract.compatibility_aliases?.[inputId] ?? inputId
}

/**
 * Adapt the lossless converter JSON into the Studio's SOMA Motion IR.
 *
 * This is deliberately strict: legacy files that say somaskel77 while carrying
 * only a collapsed 30-joint payload are rejected by the canonical hierarchy
 * check. Compatibility aliases rename identities; they never relax shape.
 */
export async function adaptConverterMotionJson(input, skeletonContract) {
  if (!input || typeof input !== 'object') throw new TypeError('motion input must be an object')
  if (!skeletonContract || typeof skeletonContract !== 'object') {
    throw new TypeError('skeletonContract must be supplied')
  }

  const skeletonSignature = await contractSignature(skeletonContract)
  const motionSignature = await contractSignature(input)
  const motion = {
    schema: CONTRACT_SCHEMAS.somaMotion,
    schema_version: CONTRACT_VERSION,
    skeleton_id: canonicalSkeletonId(input.skeleton, skeletonContract),
    skeleton_version: skeletonContract.version,
    skeleton_signature: skeletonSignature,
    motion_signature: motionSignature,
    rotation_space: input.rotation_space,
    rotation_representation: 'mat3-row-major',
    fps: input.fps,
    frame_count: input.global_rot_mats?.length ?? 0,
    joints: structuredClone(input.joints),
    parents: structuredClone(input.parents),
    global_rot_mats: structuredClone(input.global_rot_mats),
    root_positions: structuredClone(input.root_positions),
    rest_offsets_m: structuredClone(input.rest_offsets_m),
    foot_contacts: structuredClone(input.foot_contacts),
    source: {
      adapter: 'lossless-converter-json',
      source_skeleton: input.source_skeleton ?? input.skeleton,
    },
  }
  return assertSomaMotionIR(motion, skeletonContract)
}

const CSKEL27_TO_SOMA77 = Object.freeze({
  Hips: 'Hips',
  Spine1: 'Spine',
  Spine2: 'Spine1',
  Chest: 'Spine2',
  Neck1: 'Neck',
  Neck2: 'Neck',
  Head: 'Head',
  HeadEnd: 'Head',
  Jaw: 'Head',
  LeftEye: 'Head',
  RightEye: 'Head',
  LeftShoulder: 'LeftShoulder',
  LeftArm: 'LeftArm',
  LeftForeArm: 'LeftForeArm',
  LeftHand: 'LeftHand',
  LeftHandThumb1: 'LeftHandThumb1',
  LeftHandThumb2: 'LeftHandThumb1',
  LeftHandThumb3: 'LeftHandThumb1',
  LeftHandThumbEnd: 'LeftHandThumb1',
  LeftHandIndex1: 'LeftHandEnd',
  LeftHandIndex2: 'LeftHandEnd',
  LeftHandIndex3: 'LeftHandEnd',
  LeftHandIndex4: 'LeftHandEnd',
  LeftHandIndexEnd: 'LeftHandEnd',
  LeftHandMiddle1: 'LeftHandEnd',
  LeftHandMiddle2: 'LeftHandEnd',
  LeftHandMiddle3: 'LeftHandEnd',
  LeftHandMiddle4: 'LeftHandEnd',
  LeftHandMiddleEnd: 'LeftHandEnd',
  LeftHandRing1: 'LeftHandEnd',
  LeftHandRing2: 'LeftHandEnd',
  LeftHandRing3: 'LeftHandEnd',
  LeftHandRing4: 'LeftHandEnd',
  LeftHandRingEnd: 'LeftHandEnd',
  LeftHandPinky1: 'LeftHandEnd',
  LeftHandPinky2: 'LeftHandEnd',
  LeftHandPinky3: 'LeftHandEnd',
  LeftHandPinky4: 'LeftHandEnd',
  LeftHandPinkyEnd: 'LeftHandEnd',
  RightShoulder: 'RightShoulder',
  RightArm: 'RightArm',
  RightForeArm: 'RightForeArm',
  RightHand: 'RightHand',
  RightHandThumb1: 'RightHandThumb1',
  RightHandThumb2: 'RightHandThumb1',
  RightHandThumb3: 'RightHandThumb1',
  RightHandThumbEnd: 'RightHandThumb1',
  RightHandIndex1: 'RightHandEnd',
  RightHandIndex2: 'RightHandEnd',
  RightHandIndex3: 'RightHandEnd',
  RightHandIndex4: 'RightHandEnd',
  RightHandIndexEnd: 'RightHandEnd',
  RightHandMiddle1: 'RightHandEnd',
  RightHandMiddle2: 'RightHandEnd',
  RightHandMiddle3: 'RightHandEnd',
  RightHandMiddle4: 'RightHandEnd',
  RightHandMiddleEnd: 'RightHandEnd',
  RightHandRing1: 'RightHandEnd',
  RightHandRing2: 'RightHandEnd',
  RightHandRing3: 'RightHandEnd',
  RightHandRing4: 'RightHandEnd',
  RightHandRingEnd: 'RightHandEnd',
  RightHandPinky1: 'RightHandEnd',
  RightHandPinky2: 'RightHandEnd',
  RightHandPinky3: 'RightHandEnd',
  RightHandPinky4: 'RightHandEnd',
  RightHandPinkyEnd: 'RightHandEnd',
  LeftLeg: 'LeftUpLeg',
  LeftShin: 'LeftLeg',
  LeftFoot: 'LeftFoot',
  LeftToeBase: 'LeftToeBase',
  LeftToeEnd: 'LeftToeBase',
  RightLeg: 'RightUpLeg',
  RightShin: 'RightLeg',
  RightFoot: 'RightFoot',
  RightToeBase: 'RightToeBase',
  RightToeEnd: 'RightToeBase',
})

function concatenateCskel27Chunks(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new TypeError('cskel27 qualification input requires at least one chunk')
  }
  const first = chunks[0]
  if (first.skeleton !== 'cskel27') {
    throw new TypeError('qualification adapter only accepts cskel27 captures')
  }
  const joined = {
    ...structuredClone(first),
    global_rot_mats: [],
    root_positions: [],
    foot_contacts: [],
  }
  for (const chunk of chunks) {
    if (chunk.skeleton !== first.skeleton
        || chunk.fps !== first.fps
        || JSON.stringify(chunk.joints) !== JSON.stringify(first.joints)
        || JSON.stringify(chunk.parents) !== JSON.stringify(first.parents)
        || JSON.stringify(chunk.rest_offsets_m) !== JSON.stringify(first.rest_offsets_m)) {
      throw new TypeError('cskel27 qualification chunks have incompatible contracts')
    }
    if (chunk.global_rot_mats.length !== chunk.root_positions.length
        || chunk.global_rot_mats.length !== chunk.foot_contacts.length) {
      throw new TypeError('cskel27 qualification chunk frame fields disagree')
    }
    joined.global_rot_mats.push(...structuredClone(chunk.global_rot_mats))
    joined.root_positions.push(...structuredClone(chunk.root_positions))
    joined.foot_contacts.push(...structuredClone(chunk.foot_contacts))
  }
  return joined
}

/**
 * Normalize the known Core27 capture contract into a complete SOMA77 carrier.
 *
 * Core27 has no articulated fingers. Missing canonical joints inherit their
 * closest measured hand/head rotation and receive collapsed rest offsets.
 * This adapter is for cross-source preview and qualification; it does not
 * claim that Core27 measured the synthesized joints.
 */
export async function adaptCskel27MotionJson(inputs, skeletonContract) {
  if (!skeletonContract || typeof skeletonContract !== 'object') {
    throw new TypeError('skeletonContract must be supplied')
  }
  const chunks = Array.isArray(inputs) ? inputs : [inputs]
  const input = concatenateCskel27Chunks(chunks)
  const sourceIndex = new Map(input.joints.map((name, index) => [name, index]))
  const canonicalJoints = skeletonContract.joints.map((joint) => joint.name)
  const canonicalParents = skeletonContract.joints.map((joint) => joint.parent)
  for (const joint of canonicalJoints) {
    const source = CSKEL27_TO_SOMA77[joint]
    if (!sourceIndex.has(source)) {
      throw new TypeError(`cskel27 qualification map cannot resolve "${joint}"`)
    }
  }

  const sourceRestWorld = []
  input.joints.forEach((name, index) => {
    const parent = input.parents[index]
    const parentPosition = parent === null
      ? [0, 0, 0]
      : sourceRestWorld[sourceIndex.get(parent)]
    sourceRestWorld.push(input.rest_offsets_m[index].map(
      (component, axis) => component + parentPosition[axis],
    ))
  })
  const canonicalRestWorld = canonicalJoints.map(
    (joint) => sourceRestWorld[sourceIndex.get(CSKEL27_TO_SOMA77[joint])],
  )
  const canonicalIndex = new Map(
    canonicalJoints.map((name, index) => [name, index]),
  )
  const restOffsets = canonicalJoints.map((joint, index) => {
    const parent = canonicalParents[index]
    if (parent === null) return [...canonicalRestWorld[index]]
    const parentPosition = canonicalRestWorld[canonicalIndex.get(parent)]
    return canonicalRestWorld[index].map(
      (component, axis) => component - parentPosition[axis],
    )
  })

  const skeletonSignature = await contractSignature(skeletonContract)
  const motionSignature = await contractSignature(chunks)
  const motion = {
    schema: CONTRACT_SCHEMAS.somaMotion,
    schema_version: CONTRACT_VERSION,
    skeleton_id: skeletonContract.id,
    skeleton_version: skeletonContract.version,
    skeleton_signature: skeletonSignature,
    motion_signature: motionSignature,
    rotation_space: 'global',
    rotation_representation: 'mat3-row-major',
    fps: input.fps,
    frame_count: input.global_rot_mats.length,
    joints: canonicalJoints,
    parents: canonicalParents,
    global_rot_mats: input.global_rot_mats.map((frame) => canonicalJoints.map(
      (joint) => [...frame[sourceIndex.get(CSKEL27_TO_SOMA77[joint])]],
    )),
    root_positions: structuredClone(input.root_positions),
    rest_offsets_m: restOffsets,
    foot_contacts: structuredClone(input.foot_contacts),
    source: {
      adapter: 'cskel27-to-soma77-qualification',
      source_skeleton: input.skeleton,
      source_chunk_count: chunks.length,
      inherited_joint_count:
        canonicalJoints.length
        - new Set(canonicalJoints.map((joint) => CSKEL27_TO_SOMA77[joint])).size,
    },
  }
  return assertSomaMotionIR(motion, skeletonContract)
}

/**
 * SOMA30 → canonical SOMA77 joint map.
 *
 * Verified against the real Kimodo capture payloads (`debug/data/kimodo_*.json`)
 * and `SOMA30` in `REsearch/kimodo-vrm-pipeline/npz_to_json.py`: the 30-joint
 * somaskel30/somaskel77 payload measures every direct joint below plus Jaw,
 * LeftEye, RightEye and both hand ThumbEnd/MiddleEnd ends. Only joints with no
 * measured source inherit the nearest measured joint (same philosophy as the
 * cskel27 adapter inheriting fingers from the hand end).
 */
export const SOMA30_TO_SOMA77 = Object.freeze({
  Hips: 'Hips',
  Spine1: 'Spine1',
  Spine2: 'Spine2',
  Chest: 'Chest',
  Neck1: 'Neck1',
  Neck2: 'Neck2',
  Head: 'Head',
  HeadEnd: 'Head',
  Jaw: 'Jaw',
  LeftEye: 'LeftEye',
  RightEye: 'RightEye',
  LeftShoulder: 'LeftShoulder',
  LeftArm: 'LeftArm',
  LeftForeArm: 'LeftForeArm',
  LeftHand: 'LeftHand',
  LeftHandThumb1: 'LeftHandThumbEnd',
  LeftHandThumb2: 'LeftHandThumbEnd',
  LeftHandThumb3: 'LeftHandThumbEnd',
  LeftHandThumbEnd: 'LeftHandThumbEnd',
  LeftHandIndex1: 'LeftHandMiddleEnd',
  LeftHandIndex2: 'LeftHandMiddleEnd',
  LeftHandIndex3: 'LeftHandMiddleEnd',
  LeftHandIndex4: 'LeftHandMiddleEnd',
  LeftHandIndexEnd: 'LeftHandMiddleEnd',
  LeftHandMiddle1: 'LeftHandMiddleEnd',
  LeftHandMiddle2: 'LeftHandMiddleEnd',
  LeftHandMiddle3: 'LeftHandMiddleEnd',
  LeftHandMiddle4: 'LeftHandMiddleEnd',
  LeftHandMiddleEnd: 'LeftHandMiddleEnd',
  LeftHandRing1: 'LeftHandMiddleEnd',
  LeftHandRing2: 'LeftHandMiddleEnd',
  LeftHandRing3: 'LeftHandMiddleEnd',
  LeftHandRing4: 'LeftHandMiddleEnd',
  LeftHandRingEnd: 'LeftHandMiddleEnd',
  LeftHandPinky1: 'LeftHandMiddleEnd',
  LeftHandPinky2: 'LeftHandMiddleEnd',
  LeftHandPinky3: 'LeftHandMiddleEnd',
  LeftHandPinky4: 'LeftHandMiddleEnd',
  LeftHandPinkyEnd: 'LeftHandMiddleEnd',
  RightShoulder: 'RightShoulder',
  RightArm: 'RightArm',
  RightForeArm: 'RightForeArm',
  RightHand: 'RightHand',
  RightHandThumb1: 'RightHandThumbEnd',
  RightHandThumb2: 'RightHandThumbEnd',
  RightHandThumb3: 'RightHandThumbEnd',
  RightHandThumbEnd: 'RightHandThumbEnd',
  RightHandIndex1: 'RightHandMiddleEnd',
  RightHandIndex2: 'RightHandMiddleEnd',
  RightHandIndex3: 'RightHandMiddleEnd',
  RightHandIndex4: 'RightHandMiddleEnd',
  RightHandIndexEnd: 'RightHandMiddleEnd',
  RightHandMiddle1: 'RightHandMiddleEnd',
  RightHandMiddle2: 'RightHandMiddleEnd',
  RightHandMiddle3: 'RightHandMiddleEnd',
  RightHandMiddle4: 'RightHandMiddleEnd',
  RightHandMiddleEnd: 'RightHandMiddleEnd',
  RightHandRing1: 'RightHandMiddleEnd',
  RightHandRing2: 'RightHandMiddleEnd',
  RightHandRing3: 'RightHandMiddleEnd',
  RightHandRing4: 'RightHandMiddleEnd',
  RightHandRingEnd: 'RightHandMiddleEnd',
  RightHandPinky1: 'RightHandMiddleEnd',
  RightHandPinky2: 'RightHandMiddleEnd',
  RightHandPinky3: 'RightHandMiddleEnd',
  RightHandPinky4: 'RightHandMiddleEnd',
  RightHandPinkyEnd: 'RightHandMiddleEnd',
  LeftLeg: 'LeftLeg',
  LeftShin: 'LeftShin',
  LeftFoot: 'LeftFoot',
  LeftToeBase: 'LeftToeBase',
  LeftToeEnd: 'LeftToeBase',
  RightLeg: 'RightLeg',
  RightShin: 'RightShin',
  RightFoot: 'RightFoot',
  RightToeBase: 'RightToeBase',
  RightToeEnd: 'RightToeBase',
})

function concatenateSoma30Chunks(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new TypeError('soma30 qualification input requires at least one chunk')
  }
  const first = chunks[0]
  if (first.skeleton !== 'somaskel30' && first.skeleton !== 'somaskel77') {
    throw new TypeError('soma30 adapter only accepts somaskel30/somaskel77 captures')
  }
  const joined = {
    ...structuredClone(first),
    global_rot_mats: [],
    root_positions: [],
    foot_contacts: [],
  }
  for (const chunk of chunks) {
    if (chunk.skeleton !== first.skeleton
        || chunk.fps !== first.fps
        || JSON.stringify(chunk.joints) !== JSON.stringify(first.joints)
        || JSON.stringify(chunk.parents) !== JSON.stringify(first.parents)
        || JSON.stringify(chunk.rest_offsets_m) !== JSON.stringify(first.rest_offsets_m)) {
      throw new TypeError('soma30 qualification chunks have incompatible contracts')
    }
    if (chunk.global_rot_mats.length !== chunk.root_positions.length
        || chunk.global_rot_mats.length !== chunk.foot_contacts.length) {
      throw new TypeError('soma30 qualification chunk frame fields disagree')
    }
    joined.global_rot_mats.push(...structuredClone(chunk.global_rot_mats))
    joined.root_positions.push(...structuredClone(chunk.root_positions))
    joined.foot_contacts.push(...structuredClone(chunk.foot_contacts))
  }
  return joined
}

/**
 * Expand a SOMASkeleton30 payload (somaskel30, or somaskel77 carrying the
 * collapsed 30-joint selection) into a complete canonical SOMA77 carrier.
 *
 * SOMA30 measures the body chain plus Jaw/Eyes and the hand ThumbEnd/MiddleEnd
 * ends. Canonical joints without a measured source inherit the nearest
 * measured joint's rotation (Head for HeadEnd, hand ends for the fingers,
 * ToeBase for ToeEnd) and receive FK-consistent collapsed rest offsets, so a
 * posed FK of the expanded carrier reproduces the source's world positions
 * exactly. This adapter is for cross-source preview and qualification; it does
 * not claim that SOMA30 measured the synthesized joints.
 */
export async function adaptSoma30MotionJson(inputs, skeletonContract) {
  if (!skeletonContract || typeof skeletonContract !== 'object') {
    throw new TypeError('skeletonContract must be supplied')
  }
  const chunks = Array.isArray(inputs) ? inputs : [inputs]
  const input = concatenateSoma30Chunks(chunks)
  const sourceIndex = new Map(input.joints.map((name, index) => [name, index]))
  const canonicalJoints = skeletonContract.joints.map((joint) => joint.name)
  const canonicalParents = skeletonContract.joints.map((joint) => joint.parent)

  // The canonical 77 order visits the 30 measured sources in exactly the
  // SOMASkeleton30 order, so the expected source layout is derived from the
  // contract + map instead of being hardcoded a second time.
  const expectedSourceJoints = []
  const seenSources = new Set()
  for (const joint of canonicalJoints) {
    const source = SOMA30_TO_SOMA77[joint]
    if (!source) throw new TypeError(`soma30 map cannot resolve "${joint}"`)
    if (!seenSources.has(source)) {
      seenSources.add(source)
      expectedSourceJoints.push(source)
    }
  }
  if (JSON.stringify(input.joints) !== JSON.stringify(expectedSourceJoints)) {
    throw new TypeError(
      'soma30 payload joints do not match the SOMASkeleton30 order'
      + ` (expected ${expectedSourceJoints.length} joints, got ${input.joints.length})`,
    )
  }
  for (const joint of canonicalJoints) {
    if (!sourceIndex.has(SOMA30_TO_SOMA77[joint])) {
      throw new TypeError(`soma30 qualification map cannot resolve "${joint}"`)
    }
  }
  // Hierarchy check for the collapse. For a canonical joint whose source is s
  // and whose canonical parent maps to source s', the collapse is consistent
  // when s' is the source parent of s (direct 1:1 mapping) or when s' equals s
  // itself (chain collapse: e.g. HeadEnd inherits Head, Thumb2 inherits
  // ThumbEnd — the collapsed child re-uses its parent's source data).
  for (const joint of canonicalJoints) {
    const source = SOMA30_TO_SOMA77[joint]
    const canonicalParent = canonicalParents[canonicalJoints.indexOf(joint)]
    const mappedSourceParent = canonicalParent === null
      ? null
      : SOMA30_TO_SOMA77[canonicalParent]
    const actualSourceParent = input.parents[sourceIndex.get(source)]
    if (mappedSourceParent !== actualSourceParent
        && mappedSourceParent !== source) {
      throw new TypeError(
        `soma30 payload parent of "${source}" does not match the collapse hierarchy`
        + ` (expected ${mappedSourceParent ?? 'null'} or self, got ${actualSourceParent ?? 'null'})`,
      )
    }
  }

  const sourceRestWorld = []
  input.joints.forEach((name, index) => {
    const parent = input.parents[index]
    const parentPosition = parent === null
      ? [0, 0, 0]
      : sourceRestWorld[sourceIndex.get(parent)]
    sourceRestWorld.push(input.rest_offsets_m[index].map(
      (component, axis) => component + parentPosition[axis],
    ))
  })
  const canonicalRestWorld = canonicalJoints.map(
    (joint) => sourceRestWorld[sourceIndex.get(SOMA30_TO_SOMA77[joint])],
  )
  const canonicalIndex = new Map(
    canonicalJoints.map((name, index) => [name, index]),
  )
  const restOffsets = canonicalJoints.map((joint, index) => {
    const parent = canonicalParents[index]
    if (parent === null) return [...canonicalRestWorld[index]]
    const parentPosition = canonicalRestWorld[canonicalIndex.get(parent)]
    return canonicalRestWorld[index].map(
      (component, axis) => component - parentPosition[axis],
    )
  })

  const skeletonSignature = await contractSignature(skeletonContract)
  const motionSignature = await contractSignature(chunks)
  const motion = {
    schema: CONTRACT_SCHEMAS.somaMotion,
    schema_version: CONTRACT_VERSION,
    skeleton_id: skeletonContract.id,
    skeleton_version: skeletonContract.version,
    skeleton_signature: skeletonSignature,
    motion_signature: motionSignature,
    rotation_space: 'global',
    rotation_representation: 'mat3-row-major',
    fps: input.fps,
    frame_count: input.global_rot_mats.length,
    joints: canonicalJoints,
    parents: canonicalParents,
    global_rot_mats: input.global_rot_mats.map((frame) => canonicalJoints.map(
      (joint) => [...frame[sourceIndex.get(SOMA30_TO_SOMA77[joint])]],
    )),
    root_positions: structuredClone(input.root_positions),
    rest_offsets_m: restOffsets,
    foot_contacts: structuredClone(input.foot_contacts),
    source: {
      adapter: 'soma30-to-soma77-qualification',
      source_skeleton: input.skeleton,
      source_chunk_count: chunks.length,
      inherited_joint_count:
        canonicalJoints.length
        - new Set(canonicalJoints.map((joint) => SOMA30_TO_SOMA77[joint])).size,
    },
  }
  return assertSomaMotionIR(motion, skeletonContract)
}

/**
 * Shape-aware carrier dispatch for Studio motion loading.
 *
 * The carrier decision is payload-shape based, never skeleton-id alone:
 * somaskel77 declares the same id for BOTH the collapsed 30-joint selection
 * (expanded here) and a true lossless 77-joint export (strict pass-through
 * via the converter adapter). cskel27 stays on its qualification adapter.
 */
export async function adaptMotionJson(inputs, skeletonContract) {
  if (!skeletonContract || typeof skeletonContract !== 'object') {
    throw new TypeError('skeletonContract must be supplied')
  }
  const chunks = Array.isArray(inputs) ? inputs : [inputs]
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new TypeError('motion input requires at least one chunk')
  }
  const first = chunks[0]
  if (!first || typeof first !== 'object') {
    throw new TypeError('motion input must be an object or array of chunks')
  }
  const jointCount = Array.isArray(first.joints) ? first.joints.length : null
  if (first.skeleton === 'cskel27') {
    return adaptCskel27MotionJson(chunks, skeletonContract)
  }
  if (jointCount === 30
      && (first.skeleton === 'somaskel30' || first.skeleton === 'somaskel77')) {
    return adaptSoma30MotionJson(chunks, skeletonContract)
  }
  if (jointCount === 77
      && (first.skeleton === skeletonContract.id
        || skeletonContract.compatibility_aliases?.[first.skeleton])) {
    return adaptConverterMotionJson(first, skeletonContract)
  }
  throw new TypeError(
    'no adapter for carrier '
    + `"${first.skeleton ?? '<missing>'}" (${jointCount ?? '?'} joints); `
    + 'supported carriers: cskel27 (27 joints), '
    + 'somaskel30/somaskel77 (30-joint payload), '
    + `or lossless ${skeletonContract.id} (77-joint carrier)`,
  )
}
