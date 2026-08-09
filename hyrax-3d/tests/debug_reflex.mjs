// Debug: reflex timing with the concurrent natural-boundary deferral.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ChunkBuffer } from 'gestalt-motion/ChunkBuffer.ts'
import { CSKEL27_SOURCE_JOINT_NAMES, CSKEL27_BUILTIN_MAP } from 'gestalt-motion/adapters/cskel27.ts'
import { SEMANTIC_V1 } from 'gestalt-motion/semanticV1.ts'
import { ArdyMotionSource, ARDY_REFLEX } from '../src/embodiment/motion/ArdyMotionSource.ts'

const JOINT_NAMES = CSKEL27_SOURCE_JOINT_NAMES
const PARENT_INDICES = [-1, 0, 1, 2, 3, 4, 5, 4, 7, 8, 9, 10, 10, 4, 13, 14, 15, 16, 16, 0, 19, 20, 21, 0, 23, 24, 25]
const REST_OFFSETS = JOINT_NAMES.map((name) => {
  switch (name) {
    case 'Hips': return [0, 1.0, 0]
    case 'LeftUpLeg': return [0.1, -0.05, 0]
    case 'LeftLeg': return [0, -0.45, 0]
    case 'LeftFoot': return [0, -0.45, 0]
    case 'RightUpLeg': return [-0.1, -0.05, 0]
    case 'RightLeg': return [0, -0.45, 0]
    case 'RightFoot': return [0, -0.45, 0]
    default: return [0, 0.08, 0]
  }
})
function makeContract() {
  return { skeleton_id: 'ardy-cskel27', joint_names: JOINT_NAMES, parent_indices: PARENT_INDICES, rest_offsets_m: REST_OFFSETS, coord_frame: 'right_handed_y_up_z_forward' }
}
function fakeNode(y = 0) {
  return { quaternion: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 0, y, z: 0 },
    getWorldQuaternion(t) { t.x = this.quaternion.x; t.y = this.quaternion.y; t.z = this.quaternion.z; t.w = this.quaternion.w; return t },
    getWorldPosition(t) { t.x = this.position.x; t.y = this.position.y; t.z = this.position.z; return t } }
}
function makeFakeVrm() {
  const nodes = new Map()
  for (const [semantic, sourceName] of Object.entries(CSKEL27_BUILTIN_MAP)) {
    if (sourceName === null || SEMANTIC_V1[semantic].optional) continue
    nodes.set(semantic, fakeNode(semantic === 'hips' ? 0.95 : 0.5))
  }
  return { nodes, humanoid: { getNormalizedBoneNode: (n) => nodes.get(n) ?? null }, scene: fakeNode(0), meta: { metaVersion: '1.0' } }
}
function makeMockClient() {
  return { buffer: new ChunkBuffer(), connected: false, callbacks: null, prompts: [], resets: 0,
    connect() {}, disconnect() { this.connected = false }, reconnect() { this.connected = true }, sendPrompt(t) { this.prompts.push(t) }, sendReset() { this.resets += 1 } }
}
function makeMockRig() {
  return { scene: { position: { x: 0, z: 0.15 } }, poseWrites: 0,
    setRootPosition(x, z) { this.scene.position.x = x; this.scene.position.z = z }, setFacingYaw() {}, markPoseWrite() { this.poseWrites += 1 } }
}
const CLAMP_NAV = { constrainMovement: (_f, to) => ({ position: { x: Math.min(1, Math.max(-1, to.x)), z: Math.min(1, Math.max(-1, to.z)) } }) }
const QIDENT = [1, 0, 0, 0]
function makeChunk({ t0, frameCount, frameSeqStart, fps = 20, rootQuat = QIDENT, rootY = 0.95, walk = [0, 0], contactsAll = 0 }) {
  const jointCount = JOINT_NAMES.length
  const timestamps = new Float32Array(frameCount)
  const localRots = new Float32Array(frameCount * jointCount * 4)
  const contacts = new Uint8Array(frameCount)
  contacts.fill(contactsAll)
  const root = []
  for (let i = 0; i < frameCount; i += 1) {
    const t = t0 + i / fps
    timestamps[i] = t
    root.push({ position_m: [walk[0] * (t - t0), rootY, walk[1] * (t - t0)], orientation_wxyz: rootQuat })
    for (let j = 0; j < jointCount; j += 1) localRots[(i * jointCount + j) * 4] = 1
    localRots.set(rootQuat, (i * jointCount) * 4)
  }
  return { session_id: 's1', chunk_seq: frameSeqStart, frame_seq_start: frameSeqStart, fps, skeleton_id: 'ardy-cskel27', frame_count: frameCount, reset: false, timestamps_s: timestamps, root, local_rot_wxyz: localRots, contacts }
}
const nowRef = { now: 1000 }
const client = makeMockClient()
const rig = makeMockRig()
const source = new ArdyMotionSource({
  rig, navigation: CLAMP_NAV, url: 'ws://test.invalid/ws',
  clientFactory: (c) => { client.callbacks = c; return client }, vrmLikeFactory: () => makeFakeVrm(),
  autoConnect: true, nowMs: () => nowRef.now, profileFetcher: () => Promise.resolve(null),
})
client.connected = true
client.callbacks.onOpen('s1')
client.callbacks.onSkeleton(makeContract())
await new Promise((r) => setTimeout(r, 0))

client.buffer.push(makeChunk({ t0: 5, frameCount: 200, frameSeqStart: 0, walk: [0, 1.0] }))
for (let i = 0; i < 120; i += 1) { // 4 s
  source.update(1 / 30)
  nowRef.now += 1000 / 30
  if (i % 15 === 0) {
    const t = source.getTelemetry()
    console.log(`t=${((nowRef.now - 1000) / 1000).toFixed(1)}s reflex.active=${t.reflex.active} count=${t.reflex.count} absorb=${t.navAbsorbCount}`)
  }
}
console.log('prompts:', client.prompts)
source.dispose()
