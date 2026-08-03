/**
 * Acrobatics exemption tests (sanity gate must not cut legitimate flips).
 *
 * Live-stream evidence (2026-08 raw-stream sniff, ws://192.168.0.17:8791):
 * the RAW stream contains complete cartwheels/backflips — the root itself
 * rotates through inversion at a sustained 3.3-7 rad/s and lands upright
 * every ~2 s. The pre-exemption gate froze every flip at its first inverted
 * frame (95/241 cartwheel frames rejected) and the drift watchdog
 * hard-reset the stream 3.1 s in — the visible "cut mid-move". Drift
 * garbage, by contrast, creeps at ≤0.11 rad/s (idle p95) or sits statically
 * tilted. Under test (policy block at ROOT_SPIN_RAD_S in
 * ArdyMotionSource.ts):
 *
 *  1. A fast-spinning root (a flip) plays THROUGH inversion — inverted
 *     frames reach the bones, no watchdog release, no stream reset.
 *  2. Fail-closed is retained: a root that STOPS spinning at a garbage
 *     tilt drains the accumulator in MOVE_ACCUM_S/2 and is rejected again;
 *     sustained garbage still releases ownership and hard-resets.
 *  3. The watchdog's drift timer resets on any plausible upright frame
 *     (drift never returns to upright; acrobatics land every cycle), so an
 *     oscillating-lean move never releases — while a monotone lean creep
 *     (ardy_sanity.test.mjs) still does.
 *
 * Pure-logic: mock client (real ChunkBuffer), fake VrmLike, gestalt path —
 * mirrors tests/ardy_sanity.test.mjs fixtures.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { ChunkBuffer } from 'gestalt-motion/ChunkBuffer.ts'
import { CSKEL27_SOURCE_JOINT_NAMES, CSKEL27_BUILTIN_MAP } from 'gestalt-motion/adapters/cskel27.ts'
import { SEMANTIC_V1 } from 'gestalt-motion/semanticV1.ts'

import { ArdyMotionSource } from '../src/embodiment/motion/ArdyMotionSource.ts'

// ── Fixtures (mirrors tests/ardy_sanity.test.mjs) ───────────────────

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
    connect() {},
    disconnect() { this.connected = false },
    reconnect() { this.connected = true },
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

/**
 * Realistic cartwheel cycle (matches the live sniff: full root rotation in
 * ~1.2 s at 3.3-7 rad/s, then an upright landing pause where lean < 8°
 * resets the drift timer). rotS + pauseS = one cycle.
 */
function spinCycle(rotS, pauseS) {
  const cycle = rotS + pauseS
  return (s) => {
    const ph = s % cycle
    const theta = ph < rotS ? (2 * Math.PI * ph) / rotS : 0
    return qAxisAngle([0, 0, 1], theta)
  }
}

/**
 * Chunk with a per-frame root orientation. rootQuatAt(t - t0) returns the
 * w-first root quat at chunk-relative time; joints mirror it on the hips
 * (joint 0) like the sanity fixtures. Contacts default to all-four-down.
 */
function makeChunk({ t0, frameCount, frameSeqStart, fps = 20, rootQuatAt = null, rootQuat = QIDENT, rootY = 0.95, contacts = 0b1111 }) {
  const jointCount = JOINT_NAMES.length
  const timestamps = new Float32Array(frameCount)
  const localRots = new Float32Array(frameCount * jointCount * 4)
  const contactsArr = new Uint8Array(frameCount)
  const root = []
  for (let i = 0; i < frameCount; i += 1) {
    const t = t0 + i / fps
    timestamps[i] = t
    const q = rootQuatAt !== null ? rootQuatAt(t - t0) : rootQuat
    root.push({ position_m: [0, rootY, 0], orientation_wxyz: q })
    for (let j = 0; j < jointCount; j += 1) localRots[(i * jointCount + j) * 4] = 1
    localRots.set(q, (i * jointCount) * 4)
    contactsArr[i] = contacts
  }
  return {
    session_id: 's1',
    chunk_seq: frameSeqStart,
    frame_seq_start: frameSeqStart,
    fps,
    skeleton_id: 'ardy-cskel27',
    frame_count: frameCount,
    reset: false,
    timestamps_s: timestamps,
    root,
    local_rot_wxyz: localRots,
    contacts: contactsArr,
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

/** Tick update() at dt while advancing the wall clock; tracks max bone lean. */
function tick(source, nowRef, seconds, vrm, dt = 1 / 30) {
  let owned = false
  let maxBoneLean = 0
  const hips = vrm.nodes.get('hips')
  const steps = Math.round(seconds / dt)
  for (let i = 0; i < steps; i += 1) {
    owned = source.update(dt)
    const q = hips.quaternion
    const vy = 1 - 2 * (q.x * q.x + q.z * q.z)
    const lean = (Math.acos(Math.max(-1, Math.min(1, vy))) * 180) / Math.PI
    if (lean > maxBoneLean) maxBoneLean = lean
    nowRef.now += dt * 1000
  }
  return { owned, maxBoneLean }
}

// ── Tests ───────────────────────────────────────────────────────────

test('flip: a fast-spinning root plays THROUGH inversion — no freeze, no release, no reset', async () => {
  const nowRef = { now: 1000 }
  const client = makeMockClient()
  const rig = makeMockRig()
  const vrm = makeFakeVrm()
  const source = makeSource(client, rig, nowRef, vrm)
  await connectAndBuild(client, source)

  // Sane stream: 3 s idle.
  client.buffer.push(makeChunk({ t0: 5, frameCount: 60, frameSeqStart: 0 }))
  assert(tick(source, nowRef, 1.8, vrm).owned, 'live on the sane stream')

  // Cartwheel synthetic: three realistic cycles (1.2 s rotation + 0.8 s
  // upright landing each) — the live cartwheel measures 3.3-7 rad/s root
  // spin inverted and lands upright every ~2 s. Every inverted frame would
  // be hard-rejected without the exemption, and the old watchdog released.
  client.buffer.push(makeChunk({
    t0: 8,
    frameCount: 120, // 6 s
    frameSeqStart: 60,
    rootQuatAt: spinCycle(1.2, 0.8),
  }))
  let maxBoneLean = 0
  let ownedThroughout = true
  for (let k = 0; k < 12; k += 1) {
    const r = tick(source, nowRef, 0.5, vrm)
    maxBoneLean = Math.max(maxBoneLean, r.maxBoneLean)
    if (!r.owned) ownedThroughout = false
  }
  assert(
    maxBoneLean > 135,
    `inversion reached the bones (max bone lean ${maxBoneLean.toFixed(0)}° — a frozen flip never exceeds 45°)`,
  )
  assert(ownedThroughout, 'ownership kept through the whole flip')
  assert.equal(client.resets, 0, 'no watchdog hard-reset mid-move')
  assert.equal(source.getTelemetry().gate.hold, false, 'watchdog never engaged')
  assert.equal(source.state, 'live')
  source.dispose()
})

test('fail-closed retained: a root that STOPS spinning at a garbage tilt is rejected again + watchdog fires', async () => {
  const nowRef = { now: 1000 }
  const client = makeMockClient()
  const rig = makeMockRig()
  const vrm = makeFakeVrm()
  const source = makeSource(client, rig, nowRef, vrm)
  await connectAndBuild(client, source)

  client.buffer.push(makeChunk({ t0: 5, frameCount: 60, frameSeqStart: 0 }))
  assert(tick(source, nowRef, 1.8, vrm).owned, 'live on the sane stream')

  // 4 s of realistic flip cycles (builds the accumulator, lands upright
  // between rotations), then the root FREEZES at an 80° tilt — the
  // joint-garbage signature. The landing pauses drain the accumulator, so
  // the static garbage is rejected from its first frame.
  client.buffer.push(makeChunk({
    t0: 8,
    frameCount: 80, // 4 s
    frameSeqStart: 60,
    rootQuatAt: spinCycle(1.2, 0.8),
  }))
  client.buffer.push(makeChunk({ t0: 12, frameCount: 300, frameSeqStart: 140, rootQuat: LEAN80 }))
  tick(source, nowRef, 5.4, vrm) // through the flips, 0.2 s into the garbage
  const late = tick(source, nowRef, 1.0, vrm) // 0.2-1.2 s into the static garbage
  assert(
    late.maxBoneLean < 45,
    `static garbage tilt rejected again once the spin stopped (bone lean ${late.maxBoneLean.toFixed(0)}°)`,
  )
  const end = tick(source, nowRef, 4.0, vrm)
  assert(!end.owned, 'watchdog releases on sustained static garbage')
  assert(client.resets >= 1, 'one hard reset requested on release')
  source.dispose()
})

test('watchdog: an oscillating lean with upright landings never releases (drift never lands)', async () => {
  const nowRef = { now: 1000 }
  const client = makeMockClient()
  const rig = makeMockRig()
  const vrm = makeFakeVrm()
  const source = makeSource(client, rig, nowRef, vrm)
  await connectAndBuild(client, source)

  client.buffer.push(makeChunk({ t0: 5, frameCount: 60, frameSeqStart: 0 }))
  assert(tick(source, nowRef, 1.8, vrm).owned, 'live on the sane stream')

  // Lean oscillates 0°→30°→0° every 2 s at standing height: lean EMA
  // hovers ~15° > DRIFT_LEAN_DEG (the OLD watchdog released at the 2 s
  // hold), but every cycle dips below RECOVER_LEAN_DEG — a move, not drift.
  client.buffer.push(makeChunk({
    t0: 8,
    frameCount: 240, // 12 s
    frameSeqStart: 60,
    rootQuatAt: (s) => qAxisAngle([1, 0, 0], ((30 * Math.PI) / 180) * Math.abs(Math.sin(Math.PI * s))),
  }))
  let ownedThroughout = true
  for (let k = 0; k < 16; k += 1) {
    if (!tick(source, nowRef, 0.5, vrm).owned) ownedThroughout = false
  }
  assert(ownedThroughout, 'oscillating lean keeps ownership')
  assert.equal(client.resets, 0, 'no watchdog release while the move lands upright every cycle')
  assert.equal(source.state, 'live')
  source.dispose()
})
