#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { VRMHumanoidLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

import {
  extractThreeVrmAvatarRig,
  extractThreeVrmAvatarRigVariants,
} from '../adapters/three-vrm-avatar-rig.js'

function usage() {
  console.error('usage: extract-vrm-rig.mjs <avatar.vrm> <output.json> [--detailed]')
}

function parseGlbJson(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error('input is not a binary glTF/VRM')
  const jsonLength = view.getUint32(12, true)
  const jsonType = view.getUint32(16, true)
  if (jsonType !== 0x4e4f534a) throw new Error('first GLB chunk is not JSON')
  const jsonBytes = bytes.subarray(20, 20 + jsonLength)
  return JSON.parse(new TextDecoder().decode(jsonBytes).replace(/\0+$/u, '').trimEnd())
}

function detectVrmVersion(json) {
  if (json.extensions?.VRM) return '0'
  const version = json.extensions?.VRMC_vrm?.specVersion
  if (version) return version
  throw new Error('asset has no VRM extension')
}

const [, , inputArg, outputArg, modeArg] = process.argv
if (!inputArg || !outputArg) {
  usage()
  process.exit(2)
}

const inputPath = path.resolve(inputArg)
const outputPath = path.resolve(outputArg)
const bytes = await readFile(inputPath)
const gltfJson = parseGlbJson(bytes)
const formatVersion = detectVrmVersion(gltfJson)
const assetSignature = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const threeVrmPackage = JSON.parse(
  await readFile(path.join(packageRoot, 'node_modules/@pixiv/three-vrm/package.json'), 'utf8'),
)

globalThis.self = globalThis
const loader = new GLTFLoader()
loader.register((parser) => new VRMHumanoidLoaderPlugin(parser))
const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
const gltf = await loader.parseAsync(arrayBuffer, `${path.dirname(inputPath)}/`)
const vrm = {
  scene: gltf.scene,
  humanoid: gltf.userData.vrmHumanoid,
  meta: { metaVersion: formatVersion },
}

let basisCorrection = 'none'
if (formatVersion === '0') {
  VRMUtils.rotateVRM0(vrm)
  basisCorrection = 'VRMUtils.rotateVRM0(scene-yaw-180)'
}

const extractionOptions = {
  vrm,
  assetSignature,
  formatVersion,
  importerVersion: threeVrmPackage.version,
  basisCorrection,
  coordinateSystem: {
    status: 'declared',
    handedness: 'right',
    up_axis: '+Y',
    forward_axis: formatVersion === '0' ? '-Z-scene-local-after-normalization' : '+Z',
    linear_unit: 'meter',
  },
  rigId: `vrm:${path.basename(inputPath)}:${assetSignature.slice(7, 19)}`,
}
let rig
if (modeArg === '--detailed') {
  const catalog = JSON.parse(
    await readFile(new URL('../contracts/humanoid54.authoring.json', import.meta.url), 'utf8'),
  )
  const variants = await extractThreeVrmAvatarRigVariants({
    ...extractionOptions,
    detailedSemanticNames: catalog.roles.map((role) => role.semantic),
  })
  rig = variants.detailed
} else {
  if (modeArg !== undefined) {
    usage()
    process.exit(2)
  }
  rig = await extractThreeVrmAvatarRig(extractionOptions)
}

await writeFile(outputPath, `${JSON.stringify(rig, null, 2)}\n`)
console.log(
  `wrote ${outputPath}: ${rig.bones.length} normalized bones, ${rig.rig_signature}`,
)
