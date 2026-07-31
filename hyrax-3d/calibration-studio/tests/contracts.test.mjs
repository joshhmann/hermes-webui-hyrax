import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { Bone, Group } from 'three'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'

import { extractThreeAvatarRig } from '../adapters/three-avatar-rig.js'
import {
  fbxUnitScaleToMeters,
  inspectThreeFbxAvatarRig,
  normalizeAndExtractThreeFbxAvatarRig,
} from '../adapters/three-fbx-avatar-rig.js'
import {
  extractThreeVrmAvatarRig,
  extractThreeVrmAvatarRigVariants,
} from '../adapters/three-vrm-avatar-rig.js'
import {
  adaptConverterMotionJson,
  adaptCskel27MotionJson,
} from '../adapters/soma-motion-json.js'
import { sha256Hex, sha256Signature } from '../core/sha256.js'
import {
  CONTRACT_SCHEMAS,
  CONTRACT_VERSION,
  ContractValidationError,
  assertSomaMotionIR,
  canonicalStringify,
  contractSignature,
  createCalibrationProfileDraft,
  validateAvatarRigIR,
  validateCalibrationProfile,
  validateSomaMotionIR,
} from '../core/contracts.js'

const contractUrl = new URL('../contracts/soma77.skeleton.json', import.meta.url)
const humanoidCatalogUrl = new URL(
  '../contracts/humanoid54.authoring.json',
  import.meta.url,
)
const taiRigUrl = new URL('../evidence/tai.avatar-rig-ir.json', import.meta.url)
const detailedTaiRigUrl = new URL(
  '../evidence/tai.humanoid54.avatar-rig-ir.json',
  import.meta.url,
)
const taiDraftUrl = new URL('../evidence/tai.avatar-calibration.draft.json', import.meta.url)
const taiAssetUrl = new URL('../../../hyrax-assets/embodiment/tai.embodiment.vrm', import.meta.url)
const fbxFixtureUrl = new URL(
  'fixtures/minimal-humanoid-centimeters.fbx',
  import.meta.url,
)
const soma77 = JSON.parse(await readFile(contractUrl, 'utf8'))
const humanoid54 = JSON.parse(await readFile(humanoidCatalogUrl, 'utf8'))
const IDENTITY_MAT3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]

function validSomaMotion() {
  const joints = soma77.joints.map((joint) => joint.name)
  const parents = soma77.joints.map((joint) => joint.parent)
  return {
    schema: CONTRACT_SCHEMAS.somaMotion,
    schema_version: CONTRACT_VERSION,
    skeleton_id: 'soma77',
    skeleton_version: '1.0.0',
    skeleton_signature: `sha256:${'0'.repeat(64)}`,
    motion_signature: `sha256:${'1'.repeat(64)}`,
    rotation_space: 'global',
    rotation_representation: 'mat3-row-major',
    fps: 30,
    frame_count: 1,
    joints,
    parents,
    global_rot_mats: [[...joints.map(() => [...IDENTITY_MAT3])]],
    root_positions: [[0, 0.95, 0]],
    rest_offsets_m: joints.map(() => [0, 0, 0]),
    foot_contacts: [[0, 0, 0, 0]],
  }
}

function makeThreeRig() {
  const root = new Group()
  root.name = 'Avatar'
  const armature = new Group()
  armature.name = 'Armature'
  root.add(armature)

  const hips = new Bone()
  hips.name = 'Hips'
  hips.position.set(0, 0.9, 0)
  armature.add(hips)

  const spine = new Bone()
  spine.name = 'Spine'
  spine.position.set(0, 0.15, 0)
  hips.add(spine)

  const chest = new Bone()
  chest.name = 'Chest'
  chest.position.set(0, 0.2, 0)
  chest.rotation.z = 0.1
  spine.add(chest)

  const helper = new Group()
  helper.name = 'NonBoneHelper'
  chest.add(helper)

  const head = new Bone()
  head.name = 'Head'
  head.position.set(0, 0.3, 0)
  helper.add(head)

  return { root, hips, spine, chest, head }
}

const THREE_COORDINATE_SYSTEM = {
  status: 'declared',
  handedness: 'right',
  up_axis: '+Y',
  forward_axis: '+Z',
  linear_unit: 'meter',
}

async function extractTestRig() {
  const nodes = makeThreeRig()
  const rig = await extractThreeAvatarRig({
    root: nodes.root,
    format: 'glb',
    formatVersion: '2.0',
    assetSignature: 'sha256:avatar-test',
    importer: 'three',
    importerVersion: '0.160.0',
    rigSpace: 'raw',
    basisCorrection: 'none',
    coordinateSystem: THREE_COORDINATE_SYSTEM,
    semanticBones: {
      hips: nodes.hips,
      spine: nodes.spine,
      chest: nodes.chest,
      head: nodes.head,
    },
    rigId: 'test-avatar-v1',
  })
  return { rig, nodes }
}

test('the frozen SOMA77 hierarchy is complete and accepted verbatim', () => {
  assert.equal(soma77.id, 'soma77')
  assert.equal(soma77.joints.length, 77)
  assert.equal(soma77.hierarchy_policy.ingress_collapse, 'none')
  assert.equal(soma77.rotation_contract.space, 'global')

  const motion = validSomaMotion()
  assert.deepEqual(validateSomaMotionIR(motion, soma77), [])
  assert.equal(assertSomaMotionIR(motion, soma77), motion)
})

test('the detailed authoring catalog exposes 54 unique roles without changing SOMA77', () => {
  assert.equal(humanoid54.id, 'soma-humanoid54')
  assert.equal(humanoid54.version, '1.0.0')
  assert.equal(humanoid54.roles.length, 54)
  assert.equal(new Set(humanoid54.roles.map((role) => role.semantic)).size, 54)
  assert.equal(humanoid54.roles.filter((role) => role.required).length, 17)
  const somaNames = new Set(soma77.joints.map((joint) => joint.name))
  assert(humanoid54.roles.every((role) => somaNames.has(role.soma_joint)))

  const leftIndex = Object.fromEntries(
    humanoid54.roles
      .filter((role) => role.semantic.startsWith('leftIndex'))
      .map((role) => [role.semantic, role.soma_joint]),
  )
  assert.deepEqual(leftIndex, {
    leftIndexProximal: 'LeftHandIndex1',
    leftIndexIntermediate: 'LeftHandIndex2',
    leftIndexDistal: 'LeftHandIndex4',
  })
  const leftThumb = Object.fromEntries(
    humanoid54.roles
      .filter((role) => role.semantic.startsWith('leftThumb'))
      .map((role) => [role.semantic, role.soma_joint]),
  )
  assert.deepEqual(leftThumb, {
    leftThumbMetacarpal: 'LeftHandThumb1',
    leftThumbProximal: 'LeftHandThumb2',
    leftThumbDistal: 'LeftHandThumb3',
  })
})

test('SOMA Motion IR fails closed on space, order, shape, and parent drift', () => {
  const local = validSomaMotion()
  local.rotation_space = 'local'
  assert.match(validateSomaMotionIR(local, soma77).join('\n'), /rotation_space/)

  const reordered = validSomaMotion()
  ;[reordered.joints[1], reordered.joints[2]] = [reordered.joints[2], reordered.joints[1]]
  assert.match(validateSomaMotionIR(reordered, soma77).join('\n'), /canonical SOMA77 order/)

  const badParent = validSomaMotion()
  badParent.parents[1] = 'Head'
  assert.match(validateSomaMotionIR(badParent, soma77).join('\n'), /earlier joint/)

  const ragged = validSomaMotion()
  ragged.global_rot_mats[0].pop()
  assert.match(validateSomaMotionIR(ragged, soma77).join('\n'), /77 joints/)
})

test('converter adapter canonicalizes aliases but rejects legacy collapsed payloads', async () => {
  const ir = validSomaMotion()
  const converterJson = {
    skeleton: 'somaskel77',
    source_skeleton: 'somaskel77',
    rotation_space: ir.rotation_space,
    fps: ir.fps,
    joints: ir.joints,
    parents: ir.parents,
    global_rot_mats: ir.global_rot_mats,
    root_positions: ir.root_positions,
    rest_offsets_m: ir.rest_offsets_m,
    foot_contacts: ir.foot_contacts,
  }
  const adapted = await adaptConverterMotionJson(converterJson, soma77)
  assert.equal(adapted.skeleton_id, 'soma77')
  assert.equal(adapted.joints.length, 77)
  assert.match(adapted.skeleton_signature, /^sha256:[0-9a-f]{64}$/)

  const legacyCollapsed = structuredClone(converterJson)
  legacyCollapsed.joints = legacyCollapsed.joints.slice(0, 30)
  legacyCollapsed.parents = legacyCollapsed.parents.slice(0, 30)
  legacyCollapsed.rest_offsets_m = legacyCollapsed.rest_offsets_m.slice(0, 30)
  legacyCollapsed.global_rot_mats[0] = legacyCollapsed.global_rot_mats[0].slice(0, 30)
  await assert.rejects(
    adaptConverterMotionJson(legacyCollapsed, soma77),
    /canonical SOMA77 order/,
  )
})

test('the captured Core27 turn suite becomes a signed SOMA77 qualification carrier', async () => {
  const chunks = await Promise.all([0, 1, 2].map(
    async (index) => JSON.parse(await readFile(new URL(
      `../../debug/data/capture-turn-chunk_00${index}.json`,
      import.meta.url,
    ))),
  ))
  const qualification = await adaptCskel27MotionJson(chunks, soma77)
  assert.equal(qualification.frame_count, 120)
  assert.deepEqual(
    qualification.joints,
    soma77.joints.map((joint) => joint.name),
  )
  assert.equal(qualification.source.source_skeleton, 'cskel27')
  assert.equal(qualification.source.source_chunk_count, 3)
  for (const channel of [1, 3]) {
    const active = qualification.foot_contacts.map(
      (contacts) => contacts[channel] > 0.5,
    )
    assert(active.some(Boolean))
    assert(active.some((value) => !value))
    assert(active.slice(1).some((value, index) => value !== active[index]))
  }
})

test('Three.js adapter emits deterministic local/world rest transforms and stable IDs', async () => {
  const first = await extractTestRig()
  const second = await extractTestRig()

  assert.deepEqual(validateAvatarRigIR(first.rig), [])
  assert.equal(first.rig.rig_signature, second.rig.rig_signature)
  assert.deepEqual(first.rig, second.rig)

  const hips = first.rig.bones.find((bone) => bone.semantic === 'hips')
  const head = first.rig.bones.find((bone) => bone.semantic === 'head')
  assert.deepEqual(hips.rest_local.position, [0, 0.9, 0])
  const expectedHeadY = 0.9 + 0.15 + 0.2 + Math.cos(0.1) * 0.3
  assert(Math.abs(head.rest_world.position[1] - expectedHeadY) < 1e-12)
  assert.equal(head.parent_id, first.rig.bones.find((bone) => bone.semantic === 'chest').id)
  assert.match(head.id, /^three:\/Avatar\[0\]\/Armature\[0\]\//)
})

test('rig extraction requires declared coordinates and rejects ambiguous semantics', async () => {
  const nodes = makeThreeRig()
  await assert.rejects(
    extractThreeAvatarRig({
      root: nodes.root,
      format: 'glb',
      formatVersion: '2.0',
      assetSignature: 'sha256:test',
      importer: 'three',
      importerVersion: '0.160.0',
      rigSpace: 'raw',
      basisCorrection: 'none',
    }),
    /coordinateSystem/,
  )
  await assert.rejects(
    extractThreeAvatarRig({
      root: nodes.root,
      format: 'glb',
      formatVersion: '2.0',
      assetSignature: 'sha256:test',
      importer: 'three',
      importerVersion: '0.160.0',
      rigSpace: 'raw',
      basisCorrection: 'none',
      coordinateSystem: THREE_COORDINATE_SYSTEM,
      semanticBones: { hips: nodes.hips, pelvis: nodes.hips },
    }),
    /more than one semantic/,
  )
})

test('VRM wrapper records normalized-rig and facing decisions without guessing', async () => {
  const nodes = makeThreeRig()
  const bySemantic = {
    hips: nodes.hips,
    spine: nodes.spine,
    chest: nodes.chest,
    head: nodes.head,
  }
  const vrm = {
    scene: nodes.root,
    humanoid: {
      getNormalizedBoneNode: (semantic) => bySemantic[semantic] ?? null,
    },
  }
  const rig = await extractThreeVrmAvatarRig({
    vrm,
    assetSignature: 'sha256:vrm-test',
    formatVersion: '0',
    importerVersion: '3.0.0',
    basisCorrection: 'VRMUtils.rotateVRM0(scene-yaw-180)',
    coordinateSystem: {
      ...THREE_COORDINATE_SYSTEM,
      forward_axis: '-Z-scene-local-after-normalization',
    },
    semanticNames: Object.keys(bySemantic),
  })
  assert.equal(rig.source.format, 'vrm')
  assert.equal(rig.source.format_version, '0')
  assert.equal(rig.source.rig_space, 'normalized')
  assert.equal(rig.source.basis_correction, 'VRMUtils.rotateVRM0(scene-yaw-180)')
  assert.equal(rig.bones.length, 4)
})

test('VRM extraction keeps the core signature while adding a detailed rig variant', async () => {
  const nodes = makeThreeRig()
  const leftEye = new Bone()
  leftEye.name = 'LeftEye'
  nodes.head.add(leftEye)
  const bySemantic = {
    hips: nodes.hips,
    spine: nodes.spine,
    chest: nodes.chest,
    head: nodes.head,
    leftEye,
  }
  const vrm = {
    scene: nodes.root,
    humanoid: {
      getNormalizedBoneNode: (semantic) => bySemantic[semantic] ?? null,
    },
  }
  const options = {
    vrm,
    assetSignature: 'sha256:vrm-variants',
    formatVersion: '1',
    importerVersion: '3.0.0',
    basisCorrection: 'none',
    coordinateSystem: THREE_COORDINATE_SYSTEM,
    rigId: 'variants',
  }
  const oldCore = await extractThreeVrmAvatarRig({
    ...options,
    semanticNames: ['hips', 'spine', 'chest', 'head'],
  })
  const variants = await extractThreeVrmAvatarRigVariants({
    ...options,
    coreSemanticNames: ['hips', 'spine', 'chest', 'head'],
    detailedSemanticNames: [...Object.keys(bySemantic)],
  })
  assert.equal(variants.core.rig_signature, oldCore.rig_signature)
  assert.equal(variants.core.bones.length, 4)
  assert.equal(variants.detailed.bones.length, 5)
  assert.equal(variants.detailed.bones.at(-1).semantic, 'leftEye')
})

test('FBX inspection remains unresolved until explicit unit and facing normalization', async () => {
  const unresolvedNodes = makeThreeRig()
  const unresolved = await inspectThreeFbxAvatarRig({
    object: unresolvedNodes.root,
    assetSignature: 'sha256:fbx-test',
    filename: 'avatar.fbx',
    importerVersion: '160',
  })
  assert.equal(unresolved.coordinate_system.status, 'unresolved')
  assert.equal(unresolved.source.rig_space, 'raw')
  assert.deepEqual(validateAvatarRigIR(unresolved), [])

  const somaSignature = await contractSignature(soma77)
  assert.throws(
    () => createCalibrationProfileDraft({
      profileId: 'unresolved-fbx',
      somaContract: { ...soma77, signature: somaSignature },
      avatarRig: unresolved,
      mapping: [{
        semantic: 'hips',
        soma_joint: 'Hips',
        target_bone_id: unresolved.bones.find((bone) => bone.name === 'Hips').id,
      }],
    }),
    /coordinate system must be declared/,
  )

  const normalizedNodes = makeThreeRig()
  const normalized = await normalizeAndExtractThreeFbxAvatarRig({
    object: normalizedNodes.root,
    assetSignature: 'sha256:fbx-test',
    filename: 'avatar.fbx',
    importerVersion: '160',
    sourceFacing: '-Z',
    unitScaleFactor: 1,
  })
  assert.equal(fbxUnitScaleToMeters(1), 0.01)
  assert.equal(fbxUnitScaleToMeters(100), 1)
  assert.equal(normalized.coordinate_system.status, 'declared')
  assert.equal(normalized.coordinate_system.linear_unit, 'meter')
  assert.equal(normalized.source.rig_space, 'normalized')
  assert.match(normalized.source.basis_correction, /unit-scale:1cm/)
  const hips = normalized.bones.find((bone) => bone.name === 'Hips')
  assert(Math.abs(hips.rest_world.position[1] - 0.009) < 1e-12)

  await assert.rejects(
    normalizeAndExtractThreeFbxAvatarRig({
      object: normalizedNodes.root,
      assetSignature: 'sha256:fbx-test',
      filename: 'avatar.fbx',
      importerVersion: '160',
      sourceFacing: '+Z',
      unitScaleFactor: 100,
    }),
    /already been normalized/,
  )
  assert.throws(() => fbxUnitScaleToMeters(0), /greater than zero/)
})

test('FBXLoader fixture reaches the same fail-closed browser adapter contract', async () => {
  const bytes = await readFile(fbxFixtureUrl)
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const object = new FBXLoader().parse(arrayBuffer, '')
  assert.equal(object.userData.unitScaleFactor, undefined)

  const unresolved = await inspectThreeFbxAvatarRig({
    object,
    assetSignature: 'sha256:fbx-fixture',
    filename: 'minimal-humanoid-centimeters.fbx',
    importerVersion: '160',
  })
  assert.equal(unresolved.coordinate_system.status, 'unresolved')
  assert.equal(unresolved.bones.length, 1)
  assert.deepEqual(unresolved.bones[0].rest_world.position, [0, 90, 0])

  const normalized = await normalizeAndExtractThreeFbxAvatarRig({
    object,
    assetSignature: 'sha256:fbx-fixture',
    filename: 'minimal-humanoid-centimeters.fbx',
    importerVersion: '160',
    sourceFacing: '+Z',
    unitScaleFactor: 1,
  })
  assert.equal(normalized.coordinate_system.status, 'declared')
  assert(Math.abs(normalized.bones[0].rest_world.position[1] - 0.9) < 1e-12)
})

test('checked-in Tai rig evidence is signed, reproducible input-bound data', async () => {
  const rig = JSON.parse(await readFile(taiRigUrl, 'utf8'))
  assert.deepEqual(validateAvatarRigIR(rig), [])
  assert.equal(rig.bones.length, 22)

  const assetBytes = await readFile(taiAssetUrl)
  const assetSignature = `sha256:${createHash('sha256').update(assetBytes).digest('hex')}`
  assert.equal(rig.source.asset_signature, assetSignature)

  const expectedRigSignature = await contractSignature({ ...rig, rig_signature: null })
  assert.equal(rig.rig_signature, expectedRigSignature)
})

test('detailed Tai evidence adds 54 controls without rewriting core evidence', async () => {
  const [coreRig, detailedRig] = await Promise.all([
    readFile(taiRigUrl, 'utf8').then(JSON.parse),
    readFile(detailedTaiRigUrl, 'utf8').then(JSON.parse),
  ])
  assert.equal(coreRig.bones.length, 22)
  assert.equal(detailedRig.bones.length, 54)
  assert.notEqual(detailedRig.rig_signature, coreRig.rig_signature)
  assert.deepEqual(validateAvatarRigIR(detailedRig), [])
  assert.equal(
    detailedRig.bones.filter((bone) => bone.semantic?.includes('Thumb')).length,
    6,
  )
  const expected = await contractSignature({
    ...detailedRig,
    rig_signature: null,
  })
  assert.equal(detailedRig.rig_signature, expected)
})

test('checked-in Tai profile is a context-valid draft and cannot pass the runtime gate', async () => {
  const [rig, profile] = await Promise.all([
    readFile(taiRigUrl, 'utf8').then(JSON.parse),
    readFile(taiDraftUrl, 'utf8').then(JSON.parse),
  ])
  assert.deepEqual(
    validateCalibrationProfile(profile, { avatarRig: rig, canonicalSkeleton: soma77 }),
    [],
  )
  assert.equal(profile.mapping.length, 22)
  assert.equal(profile.status, 'draft')

  const runtimeIssues = validateCalibrationProfile(profile, {
    requireComplete: true,
    avatarRig: rig,
    canonicalSkeleton: soma77,
  })
  assert.match(runtimeIssues.join('\n'), /status "validated"/)
  assert.match(runtimeIssues.join('\n'), /root_calibration.status/)
  assert.match(runtimeIssues.join('\n'), /scale_calibration.status/)
  assert.match(runtimeIssues.join('\n'), /rest_calibration\.per_bone\.hips/)
})

test('profile builder creates an unresolved draft, never a runtime-trusted profile', async () => {
  const { rig } = await extractTestRig()
  const somaSignature = await contractSignature(soma77)
  const hips = rig.bones.find((bone) => bone.semantic === 'hips')
  const profile = createCalibrationProfileDraft({
    profileId: 'test-profile-v1',
    somaContract: {
      ...soma77,
      signature: somaSignature,
    },
    avatarRig: rig,
    mapping: [{
      semantic: 'hips',
      soma_joint: 'Hips',
      target_bone_id: hips.id,
    }],
  })

  assert.equal(profile.status, 'draft')
  assert.equal(profile.root_calibration.status, 'unresolved')
  assert.equal(profile.scale_calibration.status, 'unresolved')
  assert.equal(profile.ik.enabled, false)
  assert.deepEqual(validateCalibrationProfile(profile), [])
  assert.match(
    validateCalibrationProfile(profile, { requireComplete: true }).join('\n'),
    /status "validated"/,
  )

  assert.throws(
    () => createCalibrationProfileDraft({
      profileId: 'bad-target',
      somaContract: profile.soma_contract,
      avatarRig: rig,
      mapping: [{
        semantic: 'hips',
        soma_joint: 'Hips',
        target_bone_id: 'missing',
      }],
    }),
    ContractValidationError,
  )
})

test('profile validation reports hostile mapping entries instead of throwing', async () => {
  const { rig } = await extractTestRig()
  const profile = JSON.parse(await readFile(taiDraftUrl, 'utf8'))
  profile.mapping = [null]
  assert.doesNotThrow(() => validateCalibrationProfile(profile, {
    requireComplete: true,
    avatarRig: rig,
    canonicalSkeleton: soma77,
  }))
  assert.match(
    validateCalibrationProfile(profile).join('\n'),
    /mapping\[0\] must be an object/,
  )
})

test('contract signatures are independent of object key insertion order', async () => {
  const left = { z: 1, nested: { b: true, a: [3, 2, 1] }, a: 'first' }
  const right = { a: 'first', nested: { a: [3, 2, 1], b: true }, z: 1 }
  assert.equal(canonicalStringify(left), canonicalStringify(right))
  assert.equal(await contractSignature(left), await contractSignature(right))
})

test('browser-local SHA-256 fallback matches native hashes without Web Crypto', async () => {
  const text = new TextEncoder().encode('abc')
  assert.equal(
    await sha256Hex(text, { subtle: null }),
    'ba7816bf8f01cfea414140de5dae2223'
      + 'b00361a396177a9cb410ff61f20015ad',
  )
  assert.equal(
    await sha256Signature(new Uint8Array(), { subtle: null }),
    'sha256:e3b0c44298fc1c149afbf4c8996fb924'
      + '27ae41e4649b934ca495991b7852b855',
  )
  const binary = Uint8Array.from(
    { length: 65_539 },
    (_, index) => (index * 31 + 17) & 0xff,
  )
  const expected = createHash('sha256').update(binary).digest('hex')
  assert.equal(await sha256Hex(binary, { subtle: null }), expected)
})
