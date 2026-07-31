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
