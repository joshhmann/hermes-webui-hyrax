/**
 * ArdyMotionSource logic tests (P4).
 *
 * Pure-logic, no real WebSocket and no real three-vrm: a mock ArdyClient
 * (real ChunkBuffer underneath) plus a fake VrmLike drive the live/offline
 * state machine, and the Phase-5 root-motion decomposition is checked
 * against a mock navigation clamp.
 *
 * Node 24 strips types from the imported .ts sources (gestalt-motion is a
 * file: symlink, so its realpath lives outside node_modules).
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { ChunkBuffer } from 'gestalt-motion/ChunkBuffer.ts'
import { RootMotionAdapter } from 'gestalt-motion/RootMotionAdapter.ts'
import { ARDY_CORE27_TO_VRM } from 'gestalt-motion/boneMap.ts'

import {
  ArdyMotionSource,
  RoomNavigationApproval,
} from '../src/embodiment/motion/ArdyMotionSource.ts'

// ── Fixtures ────────────────────────────────────────────────────────

const JOINT_NAMES = ARDY_CORE27_TO_VRM.map((e) => e.ardyName)

// Parents precede children (contract invariant). Only FK consistency and a
// non-degenerate pelvis→foot span matter for calibration.
const PARENT_INDICES = [
  -1, 0, 1, 2, 3, 4, 5, 4, 7, 8, 9, 10, 10, 4, 13, 14, 15, 16, 16, 0, 19, 20, 21, 0, 23, 24, 25,
]

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
  return {
    skeleton_id: 'test-core27',
    joint_names: JOINT_NAMES,
    parent_indices: PARENT_INDICES,
    rest_offsets_m: REST_OFFSETS,
    coord_frame: 'right_handed_y_up_z_forward',
  }
}

function fakeNode(y = 0) {
  return {
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
    position: { x: 0, y, z: 0 },
    getWorldQuaternion(target) {
      target.x = this.quaternion.x; target.y = this.quaternion.y
      target.z = this.quaternion.z; target.w = this.quaternion.w
      return target
    },
    getWorldPosition(target) {
      target.x = this.position.x; target.y = this.position.y; target.z = this.position.z
      return target
    },
  }
}

/** VrmLike with all required bones present, optional ones absent. */
function makeFakeVrm() {
  const nodes = new Map()
  for (const entry of ARDY_CORE27_TO_VRM) {
    if (entry.vrmBone === null || entry.optional) continue
    nodes.set(entry.vrmBone, fakeNode(entry.vrmBone === 'hips' ? 0.95 : 0.5))
  }
  return {
    humanoid: {
      getNormalizedBoneNode: (name) => nodes.get(name) ?? null,
    },
    scene: fakeNode(0),
    meta: { metaVersion: '1.0' },
  }
}

function makeMockClient() {
  return {
    buffer: new ChunkBuffer(),
    connected: false,
    callbacks: null,
    prompts: [],
    resets: 0,
    reconnects: 0,
    disconnects: 0,
    connect() {},
    disconnect() { this.disconnects += 1; this.connected = false },
    reconnect() { this.reconnects += 1; this.connected = true },
    sendPrompt(text) { this.prompts.push(text) },
    sendReset() { this.resets += 1 },
  }
}

function makeMockRig() {
  return {
    scene: { position: { x: 0, z: 0.15 } },
    yaws: [],
    poseWrites: 0,
    setRootPosition(x, z) { this.scene.position.x = x; this.scene.position.z = z },
    setFacingYaw(yaw) { this.yaws.push(yaw) },
    markPoseWrite() { this.poseWrites += 1 },
  }
}

function makeChunk({ t0 = 5, frameCount = 40, frameSeqStart = 0, fps = 20, walkSpeed = 0, reset = false, rootYaw = 0 }) {
  const jointCount = JOINT_NAMES.length
  const timestamps = new Float32Array(frameCount)
  const localRots = new Float32Array(frameCount * jointCount * 4)
  const contacts = new Uint8Array(frameCount)
  const root = []
  const rootQuat = [Math.cos(rootYaw / 2), 0, Math.sin(rootYaw / 2), 0]
  for (let i = 0; i < frameCount; i += 1) {
    const t = t0 + i / fps
    timestamps[i] = t
    root.push({ position_m: [0, 1.0, walkSpeed * (t - t0)], orientation_wxyz: rootQuat })
    for (let j = 0; j < jointCount; j += 1) localRots[(i * jointCount + j) * 4] = 1 // identity, w-first
    // Hips (joint 0, parent -1): its local rotation IS its global rotation.
    localRots.set(rootQuat, (i * jointCount) * 4)
  }
  return {
    session_id: 's1',
    chunk_seq: 0,
    frame_seq_start: frameSeqStart,
    fps,
    skeleton_id: 'test-core27',
    frame_count: frameCount,
    reset,
    timestamps_s: timestamps,
    root,
    local_rot_wxyz: localRots,
    contacts,
  }
}

function makeSource(client, rig, extra = {}) {
  return new ArdyMotionSource({
    rig,
    navigation: { constrainMovement: (_from, to) => ({ position: to }) },
    url: 'ws://test.invalid/ws',
    clientFactory: (callbacks) => { client.callbacks = callbacks; return client },
    vrmLikeFactory: () => makeFakeVrm(),
    autoConnect: true,
    nowMs: extra.nowMs ?? (() => extra.now ?? 1000),
    ...extra,
  })
}

// ── Tests ───────────────────────────────────────────────────────────

test('offline → not owning the pose (procedural fallback), live → owning, disconnect → fade-out → fallback', () => {
  let now = 1000
  const client = makeMockClient()
  const rig = makeMockRig()
  const source = makeSource(client, rig, { nowMs: () => now })

  // Offline: update must return false so TaiRoomScene runs ProceduralLocomotion.
  assert.equal(source.update(1 / 60), false)
  assert.equal(source.isLive(), false)
  assert.equal(source.state, 'connecting')

  // Handshake + first chunk → live.
  client.connected = true
  client.callbacks.onOpen('s1')
  client.callbacks.onSkeleton(makeContract())
  client.buffer.push(makeChunk({ t0: 5 }))
  client.callbacks.onChunk?.()
  now = 1000
  assert.equal(source.update(1 / 60), true, 'live source must own the pose')
  assert.equal(source.isLive(), true)
  assert.equal(rig.poseWrites, 1, 'markPoseWrite once per owned frame')

  // First frame anchors the stream origin onto the avatar's current spot.
  assert(Math.abs(rig.scene.position.x - 0) < 1e-6)
  assert(Math.abs(rig.scene.position.z - 0.15) < 1e-6)

  // Walk prompt: root moves +Z at 0.8 m/s; approved root follows.
  client.buffer.push(makeChunk({ t0: 7, frameSeqStart: 40, walkSpeed: 0.8 }))
  for (let i = 0; i < 60; i += 1) {
    now += 50
    assert.equal(source.update(1 / 20), true)
  }
  assert(rig.scene.position.z > 0.2, `avatar root should walk forward, z=${rig.scene.position.z}`)

  // Disconnect → fade-out: still owns the pose briefly, then hands back.
  client.connected = false
  client.callbacks.onClose('test shutdown')
  assert.equal(source.state, 'offline')
  let ownedFrames = 0
  for (let i = 0; i < 30; i += 1) {
    now += 50
    if (source.update(0.05)) ownedFrames += 1
  }
  assert(ownedFrames > 0, 'crossfade keeps ownership during fade-out')
  assert(ownedFrames < 30, 'ownership ends after the 0.3 s crossfade')
  assert.equal(source.update(0.05), false, 'procedural owns the pose again')

  source.dispose()
  assert.equal(client.disconnects, 1)
})

test('prompt forwarding and trim/empty guard', () => {
  const client = makeMockClient()
  const source = makeSource(client, makeMockRig())
  source.setPrompt('  a person walks forward and waves  ')
  source.setPrompt('   ')
  assert.deepEqual(client.prompts, ['a person walks forward and waves'])
  source.dispose()
})

test('root motion decomposition: navigation clamp bounds the approved root, hips keeps bounded residual + scaled Y', () => {
  // Wall at z = 1.0 — the avatar may not pass.
  const clampNav = {
    constrainMovement: (_from, to) => ({
      position: { x: to.x, z: Math.min(to.z, 1.0) },
    }),
  }
  const approval = new RoomNavigationApproval(clampNav)
  approval.reset(0, 0)
  const adapter = new RootMotionAdapter(approval, { hipsScale: 1.2 })
  adapter.anchor([0, 1, 0], 0)

  // Unobstructed: approved == proposed, residual ≈ 0.
  let out = adapter.update([0, 1, 0.4], [1, 0, 0, 0])
  assert(Math.abs(out.sceneRootPos[2] - 0.4) < 1e-9)
  assert(Math.hypot(out.hipsPos[0], out.hipsPos[2]) < 1e-9)
  assert.equal(out.resetRequested, false)

  // Push far past the wall: approved clamps, residual stays ≤ 0.3, no snap.
  for (let i = 0; i < 40; i += 1) out = adapter.update([0, 1, 0.45 + i * 0.05], [1, 0, 0, 0])
  assert(out.sceneRootPos[2] <= 1.0 + 1e-9, `approved z=${out.sceneRootPos[2]} must clamp at the wall`)
  assert.equal(out.resetRequested, true, '>0.3 m divergence must request a reset')
  assert(
    Math.hypot(out.hipsPos[0], out.hipsPos[2]) <= 0.3 + 1e-9,
    'hips residual must be clamped (no teleport snap)',
  )
  assert(Math.abs(out.hipsPos[1] - 1.2 * 1.0) < 1e-9, 'hips Y is hipsScale × proposed Y')
})

test('non-finite navigation answers approve nothing (fail closed)', () => {
  const brokenNav = { constrainMovement: () => ({ position: { x: NaN, z: NaN } }) }
  const approval = new RoomNavigationApproval(brokenNav)
  approval.reset(0, 0)
  const adapter = new RootMotionAdapter(approval, { hipsScale: 1 })
  adapter.anchor([0, 1, 0], 0)
  const out = adapter.update([0, 1, 0.5], [1, 0, 0, 0])
  assert(Math.abs(out.sceneRootPos[2]) < 1e-9, 'broken nav must not move the avatar')
})

test('yaw decomposition: scene root owns yaw, hips bone does not double-apply it', () => {
  let now = 1000
  const client = makeMockClient()
  const rig = makeMockRig()
  const vrm = makeFakeVrm()
  const source = makeSource(client, rig, { nowMs: () => now, vrmLikeFactory: () => vrm })

  const yaw = Math.PI / 2 // 90° stream yaw — without the strip, hips also gets it
  client.connected = true
  client.callbacks.onOpen('s1')
  client.callbacks.onSkeleton(makeContract())
  client.buffer.push(makeChunk({ t0: 5, rootYaw: yaw }))
  client.callbacks.onChunk?.()
  // Run past the 0.3 s fade-in so the pose is fully ARDY-owned.
  for (let i = 0; i < 12; i += 1) {
    now += 33
    assert.equal(source.update(1 / 30), true)
  }

  // Scene root carries the full approved yaw.
  const rootYawApplied = rig.yaws[rig.yaws.length - 1]
  assert(Math.abs(rootYawApplied - yaw) < 1e-3, `scene root yaw ${rootYawApplied} != ${yaw}`)

  // Hips bone must carry yaw ≈ 0 (yaw applied exactly once, by the scene root).
  const hips = vrm.humanoid.getNormalizedBoneNode('hips')
  const q = hips.quaternion // xyzw (retargeter write boundary)
  const f = qyawFromXyzw(q)
  assert(Math.abs(f) < 0.05, `hips bone yaw ${f} rad — yaw double-applied (exorcist twist)`)
})

function qyawFromXyzw(q) {
  // yaw of rotated +Z axis: f = R(q) @ +Z; atan2(f.x, f.z)
  const { x, y, z, w } = q
  const fx = 2 * (x * z + w * y)
  const fz = 1 - 2 * (x * x + y * y)
  return Math.atan2(fx, fz)
}
