/**
 * T2 reset-crossfade tests (ARDY_TRANSITIONS_AND_DRIFT.md §T2a).
 *
 * The service now drops its conditioning history on every new prompt
 * (ARDY_DROP_HISTORY_ON_PROMPT=1, T1 deployed) and on drift-watchdog hard
 * resets — each arrives as a reset chunk that used to hard-cut the pose.
 * ArdyMotionSource must instead:
 *
 *  1. Crossfade from the CURRENT rendered pose into the new stream over
 *     ~0.45 s — no per-frame bone discontinuity across a prompt transition.
 *  2. Re-anchor root motion across the reset WITHOUT teleporting (the
 *     session-start anchor logic applied to resets); the heading difference
 *     eases over via a critically damped spring (MotionBricks Eq. 6), never
 *     snaps.
 *  3. Stay fail-closed: a garbage frame during the crossfade is still
 *     rejected by the sanity gate (never blended in) and the drift watchdog
 *     still releases ownership.
 *
 * Pure-logic: mock client (real ChunkBuffer), fake VrmLike, gestalt path
 * (fixtures mirror tests/ardy_sanity.test.mjs). Profiled-path calibration
 * scope across resets is covered in tests/ardy_profiled.test.mjs.
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
    yaws: [],
    poseWrites: 0,
    setRootPosition(x, z) { this.scene.position.x = x; this.scene.position.z = z },
    setFacingYaw(yaw) { this.yaws.push(yaw) },
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
 * Build a stream chunk. rootFn(frame) returns the root state (default:
 * standing at the origin with rootQuat); localRotFn(frame, jointName)
 * returns a w-first quat (default identity). Hips local is set to rootQuat
 * (joint 0 has parent -1: its local rotation IS its global rotation).
 */
function makeChunk({ t0, frameCount, frameSeqStart, fps = 20, rootQuat = QIDENT, reset = false, rootFn = null, localRotFn = null }) {
  const jointCount = JOINT_NAMES.length
  const timestamps = new Float32Array(frameCount)
  const localRots = new Float32Array(frameCount * jointCount * 4)
  const contacts = new Uint8Array(frameCount)
  const root = []
  for (let i = 0; i < frameCount; i += 1) {
    timestamps[i] = t0 + i / fps
    root.push(rootFn ? rootFn(i) : { position_m: [0, 0.95, 0], orientation_wxyz: rootQuat })
    for (let j = 0; j < jointCount; j += 1) {
      const q = localRotFn ? (localRotFn(i, JOINT_NAMES[j]) ?? QIDENT) : QIDENT
      localRots.set(q, (i * jointCount + j) * 4)
    }
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

async function connectAndBuild(client) {
  client.connected = true
  client.callbacks.onOpen('s1')
  client.callbacks.onSkeleton(makeContract())
  await flushBuild()
}

/** Tick update() at dt while advancing the wall clock; returns last owned. */
function tick(source, nowRef, seconds, dt = 1 / 30) {
  let owned = false
  const steps = Math.round(seconds / dt)
  for (let i = 0; i < steps; i += 1) {
    owned = source.update(dt)
    nowRef.now += dt * 1000
  }
  return owned
}

/** Angular distance (degrees) between two xyzw quats, sign-insensitive. */
function quatAngleDeg(a, b) {
  const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w)
  return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI
}

/** Lean-from-vertical (degrees) of an xyzw bone quaternion, yaw-invariant. */
function boneLeanDeg(q) {
  const vy = 1 - 2 * (q.x * q.x + q.z * q.z)
  return (Math.acos(Math.max(-1, Math.min(1, vy))) * 180) / Math.PI
}

function wrapAngle(a) {
  let r = a % (2 * Math.PI)
  if (r <= -Math.PI) r += 2 * Math.PI
  else if (r > Math.PI) r -= 2 * Math.PI
  return r
}

// ── Tests ───────────────────────────────────────────────────────────

test('prompt transition: reset chunk crossfades — no bone/yaw/root discontinuity, converges to the new stream', async () => {
  const nowRef = { now: 1000 }
  const client = makeMockClient()
  const rig = makeMockRig()
  const vrm = makeFakeVrm()
  const source = makeSource(client, rig, nowRef, vrm)
  await connectAndBuild(client)

  // Stream A: idle, arm at rest (identity), yaw 0. Run past the fade-in.
  client.buffer.push(makeChunk({ t0: 5, frameCount: 60, frameSeqStart: 0 }))
  assert(tick(source, nowRef, 1.5), 'live on stream A')

  const arm = vrm.nodes.get('leftUpperArm')
  const preResetArm = { ...arm.quaternion }

  // Prompt transition (T1: the service drops history and restarts the
  // generation — arrives as a reset chunk): arm raised 90°, stream yaw 90°.
  const armB = qAxisAngle([0, 0, 1], Math.PI / 2)
  const yawB = Math.PI / 2
  client.buffer.push(makeChunk({
    t0: 10,
    frameCount: 120,
    frameSeqStart: 60,
    reset: true,
    rootQuat: qAxisAngle([0, 1, 0], yawB),
    localRotFn: (_frame, joint) => (joint === 'LeftArm' ? armB : null),
  }))

  // Step through the transition at 60 Hz measuring per-frame deltas. A hard
  // cut would show ~90° in a single frame on the arm bone and the facing.
  let maxBoneDeg = 0
  let maxYawDeg = 0
  let maxRootM = 0
  let prevQ = { ...arm.quaternion }
  let prevYaw = rig.yaws.at(-1)
  let prevPos = { x: rig.scene.position.x, z: rig.scene.position.z }
  let alwaysOwned = true
  for (let i = 0; i < 120; i += 1) { // 2 s — the whole crossfade + settle
    alwaysOwned = source.update(1 / 60) && alwaysOwned
    nowRef.now += 1000 / 60
    maxBoneDeg = Math.max(maxBoneDeg, quatAngleDeg(prevQ, arm.quaternion))
    const yaw = rig.yaws.at(-1)
    maxYawDeg = Math.max(maxYawDeg, (Math.abs(wrapAngle(yaw - prevYaw)) * 180) / Math.PI)
    maxRootM = Math.max(
      maxRootM,
      Math.hypot(rig.scene.position.x - prevPos.x, rig.scene.position.z - prevPos.z),
    )
    prevQ = { ...arm.quaternion }
    prevYaw = yaw
    prevPos = { x: rig.scene.position.x, z: rig.scene.position.z }
  }

  assert(alwaysOwned, 'the crossfade keeps pose ownership across the reset (no procedural flap)')
  assert(
    maxBoneDeg < 12,
    `bone discontinuity across the reset: ${maxBoneDeg.toFixed(1)}° in one frame (a hard cut would show ~90°)`,
  )
  assert(
    maxYawDeg < 10,
    `facing snap across the reset: ${maxYawDeg.toFixed(1)}° in one frame (a hard cut would show 90°)`,
  )
  assert(
    maxRootM < 0.02,
    `root teleport across the reset: ${(maxRootM * 100).toFixed(1)} cm in one frame`,
  )

  // The transition actually happened: the arm reached the new stream's pose
  // and the facing converged onto the new stream's heading.
  assert(
    quatAngleDeg(arm.quaternion, preResetArm) > 45,
    `arm must reach the new stream's pose (moved ${quatAngleDeg(arm.quaternion, preResetArm).toFixed(1)}°)`,
  )
  assert(
    Math.abs(wrapAngle(rig.yaws.at(-1) - yawB)) < 0.1,
    `facing must converge to the new stream's yaw (got ${rig.yaws.at(-1).toFixed(3)}, want ${yawB.toFixed(3)})`,
  )
  assert(
    quatAngleDeg(prevQ, arm.quaternion) < 1,
    'pose is stable after the crossfade settles',
  )
  source.dispose()
})

test('anchor continuity: reset re-anchors root motion at the avatar position — no XZ teleport, new stream walks on from the current spot', async () => {
  const nowRef = { now: 1000 }
  const client = makeMockClient()
  const rig = makeMockRig()
  const source = makeSource(client, rig, nowRef)
  await connectAndBuild(client)

  // Stream A: walk +Z at 0.8 m/s.
  client.buffer.push(makeChunk({
    t0: 5,
    frameCount: 60,
    frameSeqStart: 0,
    rootFn: (i) => ({ position_m: [0, 0.95, 0.8 * (i / 20)], orientation_wxyz: QIDENT }),
  }))
  assert(tick(source, nowRef, 1.5), 'live on stream A')
  const zBefore = rig.scene.position.z
  assert(zBefore > 0.3, `avatar walked forward (z=${zBefore.toFixed(2)})`)

  // New generation: stream-space root restarts FAR away ([7.5, -4.0]) and
  // walks +X at 0.5 m/s. Without re-anchoring this teleports her ~8.5 m.
  client.buffer.push(makeChunk({
    t0: 10,
    frameCount: 120,
    frameSeqStart: 60,
    reset: true,
    rootFn: (i) => ({ position_m: [7.5 + 0.5 * (i / 20), 0.95, -4.0], orientation_wxyz: QIDENT }),
  }))

  let maxJump = 0
  let prev = { x: rig.scene.position.x, z: rig.scene.position.z }
  for (let i = 0; i < 120; i += 1) { // 2 s
    source.update(1 / 60)
    nowRef.now += 1000 / 60
    maxJump = Math.max(
      maxJump,
      Math.hypot(rig.scene.position.x - prev.x, rig.scene.position.z - prev.z),
    )
    prev = { x: rig.scene.position.x, z: rig.scene.position.z }
  }
  assert(
    maxJump < 0.05,
    `root teleported across the reset: ${(maxJump * 100).toFixed(1)} cm in one frame ` +
    '(walk speed is ≤ 1.4 cm/frame at 60 Hz; a teleport would be meters)',
  )
  // The new stream's +X walk applies from the avatar's current spot.
  assert(
    rig.scene.position.x > 0.3,
    `new stream's walk must apply from the current spot (x=${rig.scene.position.x.toFixed(2)})`,
  )
  assert(
    Math.abs(rig.scene.position.z - zBefore) < 0.35,
    `no Z drift from the far-away stream origin (z ${zBefore.toFixed(2)} → ${rig.scene.position.z.toFixed(2)})`,
  )
  source.dispose()
})

test('fail-closed through the crossfade: garbage frames in the new stream are never blended in; the watchdog still releases', async () => {
  const nowRef = { now: 1000 }
  const client = makeMockClient()
  const rig = makeMockRig()
  const vrm = makeFakeVrm()
  const source = makeSource(client, rig, nowRef, vrm)
  await connectAndBuild(client)

  client.buffer.push(makeChunk({ t0: 5, frameCount: 60, frameSeqStart: 0 }))
  assert(tick(source, nowRef, 1.5), 'live on the sane stream')

  const hips = vrm.nodes.get('hips')

  // The fresh generation arrives as a reset chunk of pure garbage (80° lean
  // at standing height) — exactly during the reset crossfade window.
  client.buffer.push(makeChunk({ t0: 10, frameCount: 200, frameSeqStart: 60, reset: true, rootQuat: LEAN80 }))

  let maxLean = 0
  let owned = true
  for (let i = 0; i < 300; i += 1) { // 5 s — crossfade + INSANE_HOLD + release
    owned = source.update(1 / 60)
    nowRef.now += 1000 / 60
    maxLean = Math.max(maxLean, boneLeanDeg(hips.quaternion))
  }
  assert(
    maxLean < 45,
    `garbage reached the bones during the reset crossfade (${maxLean.toFixed(1)}° ≥ 45°)`,
  )
  assert(!owned, 'watchdog still releases ownership on sustained garbage')
  assert(client.resets >= 1, 'watchdog still requests the hard stream reset')
  assert.equal(source.state, 'stale')
  source.dispose()
})

test('held pose keeps the old anchor when the new stream opens with rejected frames (no mis-anchored teleport)', async () => {
  const nowRef = { now: 1000 }
  const client = makeMockClient()
  const rig = makeMockRig()
  const vrm = makeFakeVrm()
  const source = makeSource(client, rig, nowRef, vrm)
  await connectAndBuild(client)

  client.buffer.push(makeChunk({ t0: 5, frameCount: 60, frameSeqStart: 0 }))
  assert(tick(source, nowRef, 1.5), 'live on the sane stream')
  const posBefore = { x: rig.scene.position.x, z: rig.scene.position.z }

  // New generation whose FIRST frames are garbage (rejected) at a far-away
  // stream origin, turning sane after ~0.5 s. Anchoring on the held old pose
  // would mis-map the new stream's origin — the anchor must wait for the
  // first plausible NEW-stream sample. (0.5 s of garbage stays under the
  // watchdog's 2 s sustained-drift hold, so the sane tail is reached without
  // a release.)
  client.buffer.push(makeChunk({
    t0: 10,
    frameCount: 200,
    frameSeqStart: 60,
    reset: true,
    rootQuat: QIDENT,
    rootFn: (i) => ({
      position_m: [7.5, 0.95, -4.0],
      orientation_wxyz: i < 10 ? LEAN80 : QIDENT,
    }),
    localRotFn: (i) => (i < 10 ? LEAN80 : null),
  }))

  let maxJump = 0
  let prev = { ...posBefore }
  for (let i = 0; i < 240; i += 1) { // 4 s
    source.update(1 / 60)
    nowRef.now += 1000 / 60
    maxJump = Math.max(maxJump, Math.hypot(rig.scene.position.x - prev.x, rig.scene.position.z - prev.z))
    prev = { x: rig.scene.position.x, z: rig.scene.position.z }
  }
  assert(
    maxJump < 0.05,
    `root jumped when the new stream anchored late: ${(maxJump * 100).toFixed(1)} cm in one frame`,
  )
  // The sane tail poses the avatar (lean back under the recover threshold).
  assert(boneLeanDeg(vrm.nodes.get('hips').quaternion) < 12, 'sane tail poses after the garbage opens')
  source.dispose()
})
