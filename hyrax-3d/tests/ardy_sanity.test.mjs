/**
 * Stream sanity gate tests (fail-closed).
 *
 * Live-stream evidence (see the task worklog): long autoregressive ARDY
 * generations DRIFT — the source itself starts emitting a progressive hips
 * lean (the "idle lean"), then full joint garbage at standing root height
 * (the "joint explosion"). A hard reset recovers sanity for only a few
 * seconds. The loft must therefore:
 *
 *  1. NEVER write an implausible frame (hips lean-from-vertical > 45°, or
 *     root height out of bounds) to the rig — the last plausible sample is
 *     held instead (a transient garbage frame must not reach the bones).
 *  2. On sustained drift (lean EMA > 12° while upright), release the pose to
 *     ProceduralLocomotion (update() → false after the stale crossfade),
 *     journal the reason, and request ONE hard stream reset.
 *  3. Reclaim ownership after sustained sanity.
 *  4. Protect legitimate poses: crouches (lean but LOW root) and turns
 *     (180° yaw reads 0° lean — the metric is yaw-invariant).
 *  5. A user prompt during the hold clears it and hard-resets the stream so
 *     the command starts a fresh rollout (the service retains drifted
 *     conditioning history across prompts otherwise).
 *
 * Pure-logic: mock client (real ChunkBuffer), fake VrmLike, gestalt path
 * (the gate sits in update() before the retarget dispatch — path-agnostic).
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { ChunkBuffer } from 'gestalt-motion/ChunkBuffer.ts'
import { CSKEL27_SOURCE_JOINT_NAMES, CSKEL27_BUILTIN_MAP } from 'gestalt-motion/adapters/cskel27.ts'
import { SEMANTIC_V1 } from 'gestalt-motion/semanticV1.ts'

import { ArdyMotionSource } from '../src/embodiment/motion/ArdyMotionSource.ts'

// ── Fixtures (mirrors tests/ardy_motion.test.mjs) ───────────────────

const JOINT_NAMES = CSKEL27_SOURCE_JOINT_NAMES

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
    skeleton_id: 'ardy-cskel27',
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

function makeFakeVrm() {
  const nodes = new Map()
  for (const [semantic, sourceName] of Object.entries(CSKEL27_BUILTIN_MAP)) {
    if (sourceName === null || SEMANTIC_V1[semantic].optional) continue
    nodes.set(semantic, fakeNode(semantic === 'hips' ? 0.95 : 0.5))
  }
  return {
    nodes,
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
    poseWrites: 0,
    setRootPosition(x, z) { this.scene.position.x = x; this.scene.position.z = z },
    setFacingYaw() {},
    markPoseWrite() { this.poseWrites += 1 },
  }
}

const QIDENT = [1, 0, 0, 0]

function qAxisAngle(axis, rad) {
  const s = Math.sin(rad / 2)
  return [Math.cos(rad / 2), axis[0] * s, axis[1] * s, axis[2] * s]
}

const LEAN80 = qAxisAngle([1, 0, 0], (80 * Math.PI) / 180) // garbage: bent 80° at standing height
const LEAN20 = qAxisAngle([1, 0, 0], (20 * Math.PI) / 180) // drift-zone lean
const YAW180 = qAxisAngle([0, 1, 0], Math.PI) // legit 180° turn (lean reads 0°)

function makeChunk({ t0, frameCount, frameSeqStart, fps = 20, rootQuat = QIDENT, rootY = 0.95, reset = false }) {
  const jointCount = JOINT_NAMES.length
  const timestamps = new Float32Array(frameCount)
  const localRots = new Float32Array(frameCount * jointCount * 4)
  const contacts = new Uint8Array(frameCount)
  const root = []
  for (let i = 0; i < frameCount; i += 1) {
    timestamps[i] = t0 + i / fps
    root.push({ position_m: [0, rootY, 0], orientation_wxyz: rootQuat })
    for (let j = 0; j < jointCount; j += 1) localRots[(i * jointCount + j) * 4] = 1
    // Hips (joint 0, parent -1): its local rotation IS its global rotation.
    localRots.set(rootQuat, (i * jointCount) * 4)
  }
  return {
    session_id: 's1',
    chunk_seq: frameSeqStart,
    frame_seq_start: frameSeqStart,
    fps,
    skeleton_id: 'ardy-cskel27',
    frame_count: frameCount,
    reset,
    timestamps_s: timestamps,
    root,
    local_rot_wxyz: localRots,
    contacts,
  }
}

function makeSource(client, rig, nowRef, vrm = makeFakeVrm()) {
  return new ArdyMotionSource({
    rig,
    navigation: { constrainMovement: (_from, to) => ({ position: to }) },
    url: 'ws://test.invalid/ws',
    clientFactory: (callbacks) => { client.callbacks = callbacks; return client },
    vrmLikeFactory: () => vrm,
    autoConnect: true,
    nowMs: () => nowRef.now,
    profileFetcher: () => Promise.resolve(null), // gestalt path
  })
}

function flushBuild() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function connectAndBuild(client, source) {
  client.connected = true
  client.callbacks.onOpen('s1')
  client.callbacks.onSkeleton(makeContract())
  await flushBuild()
}

/** Tick update() at dt=1/30 while advancing the wall clock; returns owned. */
function tick(source, nowRef, seconds, dt = 1 / 30) {
  let owned = false
  const steps = Math.round(seconds / dt)
  for (let i = 0; i < steps; i += 1) {
    owned = source.update(dt)
    nowRef.now += dt * 1000
  }
  return owned
}

/** Lean-from-vertical (degrees) of an xyzw bone quaternion, yaw-invariant. */
function boneLeanDeg(q) {
  const vy = 1 - 2 * (q.x * q.x + q.z * q.z)
  return (Math.acos(Math.max(-1, Math.min(1, vy))) * 180) / Math.PI
}

// ── Tests ───────────────────────────────────────────────────────────

test('explosion: garbage frames never reach the bones; sustained garbage releases ownership + hard-resets; sanity reclaims', async () => {
  const nowRef = { now: 1000 }
  const client = makeMockClient()
  const rig = makeMockRig()
  const vrm = makeFakeVrm()
  const source = makeSource(client, rig, nowRef, vrm)
  await connectAndBuild(client, source)

  // Sane stream: 3 s idle.
  client.buffer.push(makeChunk({ t0: 5, frameCount: 60, frameSeqStart: 0 }))
  const owned = tick(source, nowRef, 1.8)
  assert(owned, 'live on the sane stream')

  // The sane pose is constant — capture the written hips orientation.
  const hips = vrm.nodes.get('hips')
  const writesAtSane = rig.poseWrites

  // Garbage stream: hips bent 80° at standing height, 15 s worth.
  client.buffer.push(makeChunk({ t0: 8, frameCount: 300, frameSeqStart: 60, rootQuat: LEAN80 }))

  // Playback reaches the garbage at now ≈ 4000 (t=8 ↔ now=1000+3000).
  tick(source, nowRef, 1.0)
  // 0.3 s into the garbage: rejected frames hold the last plausible pose.
  // (The sampler's boundary interpolation between the last sane frame and
  // the first garbage frame passes intermediate leans through the gate —
  // bounded by the reject threshold. The full 80° garbage must never land.)
  tick(source, nowRef, 0.4)
  assert(rig.poseWrites > writesAtSane, 'held pose keeps being written during rejects')
  assert(
    boneLeanDeg(hips.quaternion) < 45,
    `implausible lean reached the bones (${boneLeanDeg(hips.quaternion).toFixed(1)}° ≥ 45°)`,
  )

  // Sustained garbage: EMA crosses the drift threshold fast; after
  // INSANE_HOLD_MS the hold fires, then the stale ramp crossfades out.
  const ownedAfter = tick(source, nowRef, 3.5)
  assert(!ownedAfter, 'ownership released after sustained garbage')
  assert(
    boneLeanDeg(hips.quaternion) < 45,
    'bones still hold a plausible pose through the release crossfade',
  )
  assert(client.resets >= 1, 'exactly one hard reset requested on release')
  assert(
    source.getTelemetry().lastReason?.includes('degraded'),
    `journaled reason (got ${source.getTelemetry().lastReason})`,
  )
  assert.equal(source.state, 'stale', 'held state presents as stale')

  // Service honours the reset: fresh, sane generation (reset chunk).
  client.buffer.push(makeChunk({ t0: 23, frameCount: 200, frameSeqStart: 360, reset: true }))
  const reclaimed = tick(source, nowRef, 6.0)
  assert(reclaimed, 'ownership reclaimed after sustained sanity')
  assert.equal(source.state, 'live')
  source.dispose()
})

test('lean drift (below the hard reject): poses first, then releases — and garbage pose values are never written', async () => {
  const nowRef = { now: 1000 }
  const client = makeMockClient()
  const rig = makeMockRig()
  const source = makeSource(client, rig, nowRef)
  await connectAndBuild(client, source)

  client.buffer.push(makeChunk({ t0: 5, frameCount: 60, frameSeqStart: 0 }))
  assert(tick(source, nowRef, 1.5), 'live on sane stream')

  // 20° lean at standing height: below HARD_LEAN_REJECT_DEG (frames are
  // written — the reject must not fire) but above DRIFT_LEAN_DEG (the
  // watchdog must fire).
  client.buffer.push(makeChunk({ t0: 8, frameCount: 200, frameSeqStart: 60, rootQuat: LEAN20 }))
  tick(source, nowRef, 1.2) // playback reaches the lean at now ≈ 4000
  const stillOwned = tick(source, nowRef, 0.5)
  assert(stillOwned, 'lean frames below the hard reject are still written')

  const ownedAfter = tick(source, nowRef, 4.0)
  assert(!ownedAfter, 'watchdog releases on sustained upright lean')
  assert(client.resets >= 1)
  source.dispose()
})

test('crouch protection: lean with a LOW root is legitimate — no release, no reset', async () => {
  const nowRef = { now: 1000 }
  const client = makeMockClient()
  const rig = makeMockRig()
  const source = makeSource(client, rig, nowRef)
  await connectAndBuild(client, source)

  client.buffer.push(makeChunk({ t0: 5, frameCount: 60, frameSeqStart: 0 }))
  assert(tick(source, nowRef, 1.5), 'live on sane stream')

  // Crouch: 20° lean but rootY 0.6 (a crouch leans AND sits low).
  client.buffer.push(makeChunk({ t0: 8, frameCount: 300, frameSeqStart: 60, rootQuat: LEAN20, rootY: 0.6 }))
  const owned = tick(source, nowRef, 8.0)
  assert(owned, 'crouch keeps ARDY ownership (root-height discriminator)')
  assert.equal(client.resets, 0, 'no hard reset for a legitimate crouch')
  source.dispose()
})

test('turn protection: a 180° yaw reads 0° lean — no reject, no release', async () => {
  const nowRef = { now: 1000 }
  const client = makeMockClient()
  const rig = makeMockRig()
  const source = makeSource(client, rig, nowRef)
  await connectAndBuild(client, source)

  client.buffer.push(makeChunk({ t0: 5, frameCount: 60, frameSeqStart: 0 }))
  assert(tick(source, nowRef, 1.5), 'live on sane stream')

  client.buffer.push(makeChunk({ t0: 8, frameCount: 300, frameSeqStart: 60, rootQuat: YAW180 }))
  const owned = tick(source, nowRef, 6.0)
  assert(owned, 'turn keeps ARDY ownership (yaw-invariant lean)')
  assert.equal(client.resets, 0)
  source.dispose()
})

test('user prompt during the hold: clears the hold and hard-resets for a fresh rollout', async () => {
  const nowRef = { now: 1000 }
  const client = makeMockClient()
  const rig = makeMockRig()
  const source = makeSource(client, rig, nowRef)
  await connectAndBuild(client, source)

  client.buffer.push(makeChunk({ t0: 5, frameCount: 60, frameSeqStart: 0 }))
  assert(tick(source, nowRef, 1.5), 'live on sane stream')

  client.buffer.push(makeChunk({ t0: 8, frameCount: 300, frameSeqStart: 60, rootQuat: LEAN80 }))
  const ownedAfter = tick(source, nowRef, 5.0)
  assert(!ownedAfter, 'hold engaged after sustained garbage')
  const resetsBefore = client.resets
  assert(resetsBefore >= 1)

  source.setPrompt('a person waves their left hand high')
  assert(
    client.resets > resetsBefore,
    'prompt while degraded also hard-resets (fresh rollout — the service retains drifted history otherwise)',
  )
  assert(client.prompts.at(-1) === 'a person waves their left hand high')

  // Fresh generation arrives sane: ownership resumes and STAYS (no re-hold).
  client.buffer.push(makeChunk({ t0: 23, frameCount: 300, frameSeqStart: 360, reset: true }))
  const reclaimed = tick(source, nowRef, 6.0)
  assert(reclaimed, 'ownership resumes on the fresh generation')
  assert.equal(source.state, 'live')
  source.dispose()
})
