#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { VRMHumanoidLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'
import {
  Quaternion,
  Vector3,
} from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

import {
  BONE_MAPS,
  SomaVrmRetargeter,
} from '../../REsearch/kimodo-vrm-pipeline/SomaVrmRetargeter.js'
import {
  canonicalStringify,
  contractSignature,
} from '../core/contracts.js'

const [assetArg, suiteArg, outputArg] = process.argv.slice(2)
if (!outputArg) {
  console.error('usage: baseline-hardcoded-tai.mjs AVATAR SUITE OUTPUT')
  process.exit(2)
}

const assetPath = path.resolve(assetArg)
const suitePath = path.resolve(suiteArg)
const outputPath = path.resolve(outputArg)
const hyraxRoot = path.resolve(path.dirname(suitePath), '../..')
const avatarBytes = await readFile(assetPath)
const suite = JSON.parse(await readFile(suitePath, 'utf8'))
const assetSignature = `sha256:${createHash('sha256').update(avatarBytes).digest('hex')}`

globalThis.self = globalThis

async function loadAvatar() {
  const loader = new GLTFLoader()
  loader.register((parser) => new VRMHumanoidLoaderPlugin(parser))
  const bytes = avatarBytes.buffer.slice(
    avatarBytes.byteOffset,
    avatarBytes.byteOffset + avatarBytes.byteLength,
  )
  const gltf = await loader.parseAsync(bytes, `${path.dirname(assetPath)}/`)
  const vrm = {
    scene: gltf.scene,
    humanoid: gltf.userData.vrmHumanoid,
    meta: { metaVersion: '0' },
  }
  VRMUtils.rotateVRM0(vrm)
  return vrm
}

function array(vector) {
  return vector.toArray().map((value) => (Object.is(value, -0) ? 0 : value))
}

function snapshot(vrm, semantics) {
  vrm.scene.updateMatrixWorld(true)
  return semantics.map((semantic) => {
    const node = vrm.humanoid.getNormalizedBoneNode(semantic)
    return {
      semantic,
      local_position: array(node.position),
      local_quaternion: array(node.quaternion),
      world_position: array(node.getWorldPosition(new Vector3())),
      world_quaternion: array(node.getWorldQuaternion(new Quaternion())),
    }
  })
}

async function runOnce() {
  const clipResults = []
  for (const clip of suite.clips) {
    const motionPath = path.resolve(hyraxRoot, clip.path)
    const motionBytes = await readFile(motionPath)
    const motion = JSON.parse(motionBytes)
    const vrm = await loadAvatar()
    const retargeter = new SomaVrmRetargeter(vrm, motion, {
      restFrame: 0,
      srcHipsHeight: 0.954,
    })
    const semantics = Object.keys(BONE_MAPS[motion.skeleton]).filter(
      (semantic) => vrm.humanoid.getNormalizedBoneNode(semantic),
    )
    const requested = new Set(clip.frames)
    const samples = []
    for (let frame = 0; frame <= Math.max(...clip.frames); frame += 1) {
      retargeter.applyFrame(frame)
      if (requested.has(frame)) {
        samples.push({
          frame,
          bones: snapshot(vrm, semantics),
        })
      }
    }
    clipResults.push({
      id: clip.id,
      purpose: clip.purpose,
      source_signature:
        `sha256:${createHash('sha256').update(motionBytes).digest('hex')}`,
      skeleton: motion.skeleton,
      fps: motion.fps,
      frame_count: motion.global_rot_mats.length,
      driven_bones: semantics,
      samples,
    })
  }
  return clipResults
}

const first = await runOnce()
const second = await runOnce()
const firstCanonical = canonicalStringify(first)
const secondCanonical = canonicalStringify(second)
const deterministic = firstCanonical === secondCanonical
const result = {
  schema: 'soma.hardcoded-tai-baseline',
  schema_version: '1.0.0',
  implementation: {
    path: 'REsearch/kimodo-vrm-pipeline/SomaVrmRetargeter.js',
    avatar_asset_signature: assetSignature,
  },
  hardcoded_contract: {
    rest_frame: 0,
    source_hips_height_m: 0.954,
    root_mode: 'root_positions delta from frame 0',
    scale_mode: 'target normalized hips world Y / source hips height',
    ground_y: 0,
    contact_threshold: 0.5,
    contact_channels: { leftFoot: 1, rightFoot: 3 },
    contact_smoothing: 0.4,
    solve_order: [
      'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
      'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
      'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
      'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes',
      'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes'
    ],
  },
  suite_signature: await contractSignature(suite),
  runs: 2,
  deterministic,
  canonical_repeat_delta: deterministic ? 0 : 1,
  clips: first,
}
result.result_signature = await contractSignature(result)
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`)
console.log(
  `${deterministic ? 'PASS' : 'FAIL'} ${outputPath}: `
  + `${first.length} clips, ${first.reduce((sum, clip) => sum + clip.samples.length, 0)} samples, `
  + `${result.result_signature}`,
)
if (!deterministic) process.exit(1)
