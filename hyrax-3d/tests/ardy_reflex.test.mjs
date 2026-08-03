/**
 * Reflex layer tests (walls exist to her).
 *
 * The treadmill absorb makes nav-rejected motion silent; the reflex layer
 * makes sustained rejection VISIBLE: one reaction prompt, then the intent
 * prompt is restored. Policy under test (ARDY_REFLEX block in
 * ArdyMotionSource.ts):
 *
 *  1. Sustained wall contact fires ONE reaction prompt (direction variant),
 *     then restores the intent prompt after DURATION_MS.
 *  2. COOLDOWN_MS caps the cadence while grinding; rejection during cooldown
 *     keeps absorbing silently.
 *  3. Direction: the rejected vector is classified against the avatar's
 *     facing — frontal contact → front variant, lateral → left/right.
 *  4. The pilot wins: a user prompt during a reflex cancels it (no restore).
 *  5. The watchdog wins: no reflex while held; a reflex interrupted by the
 *     hold restores the intent prompt on gate RECOVERY (never into the
 *     drifted stream), and garbage frames during a reflex are still
 *     hard-rejected (fail-closed gate untouched).
 *
 * Pure-logic: mock client (real ChunkBuffer), fake VrmLike, gestalt path —
 * mirrors tests/ardy_motion.test.mjs fixtures.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { ChunkBuffer } from 'gestalt-motion/ChunkBuffer.ts'
import { CSKEL27_SOURCE_JOINT_NAMES, CSKEL27_BUILTIN_MAP } from 'gestalt-motion/adapters/cskel27.ts'
import { SEMANTIC_V1 } from 'gestalt-motion/semanticV1.ts'

import { ArdyMotionSource, ARDY_REFLEX } from '../src/embodiment/motion/ArdyMotionSource.ts'
import { RoomNavigation } from '../src/embodiment/navigation/RoomNavigation.ts'
import { parseSceneManifest } from '../src/embodiment/room/sceneManifest.ts'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))

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
    connect() {},
    disconnect() { this.connected = false },
    reconnect() { this.reconnects = (this.reconnects ?? 0) + 1; this.connected = true },
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

/** Clamp nav: walls at |x| ≤ 1.0 and |z| ≤ 1.0 (avatar spawns at z=0.15). */
const CLAMP_NAV = {
  constrainMovement: (_from, to) => ({
    position: { x: Math.min(1.0, Math.max(-1.0, to.x)), z: Math.min(1.0, Math.max(-1.0, to.z)) },
  }),
}

const QIDENT = [1, 0, 0, 0]

function qAxisAngle(axis, rad) {
  const s = Math.sin(rad / 2)
  return [Math.cos(rad / 2), axis[0] * s, axis[1] * s, axis[2] * s]
}

const LEAN20 = qAxisAngle([1, 0, 0], (20 * Math.PI) / 180) // drift-zone lean
const LEAN80 = qAxisAngle([1, 0, 0], (80 * Math.PI) / 180) // hard-reject garbage

function makeChunk({ t0, frameCount, frameSeqStart, fps = 20, rootQuat = QIDENT, rootY = 0.95, walk = [0, 0], reset = false, contactsAll = 0b1111, groundAfterS = null }) {
  const jointCount = JOINT_NAMES.length
  const timestamps = new Float32Array(frameCount)
  const localRots = new Float32Array(frameCount * jointCount * 4)
  const contacts = new Uint8Array(frameCount)
  const root = []
  for (let i = 0; i < frameCount; i += 1) {
    const t = t0 + i / fps
    timestamps[i] = t
    root.push({
      position_m: [walk[0] * (t - t0), rootY, walk[1] * (t - t0)],
      orientation_wxyz: rootQuat,
    })
    for (let j = 0; j < jointCount; j += 1) localRots[(i * jointCount + j) * 4] = 1
    // Hips (joint 0, parent -1): its local rotation IS its global rotation.
    localRots.set(rootQuat, (i * jointCount) * 4)
    // groundAfterS: airborne (no contacts) until s seconds in, then grounded —
    // a continuous "traveling move lands" segment for the deferral tests.
    contacts[i] = groundAfterS !== null && t - t0 < groundAfterS ? 0 : contactsAll
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
    navigation: CLAMP_NAV,
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

/** Tick update() at dt=1/30 while advancing the wall clock. */
function tick(source, nowRef, seconds, dt = 1 / 30) {
  const steps = Math.round(seconds / dt)
  for (let i = 0; i < steps; i += 1) {
    source.update(dt)
    nowRef.now += dt * 1000
  }
}

/** Lean-from-vertical (degrees) of an xyzw bone quaternion, yaw-invariant. */
function boneLeanDeg(q) {
  const vy = 1 - 2 * (q.x * q.x + q.z * q.z)
  return (Math.acos(Math.max(-1, Math.min(1, vy))) * 180) / Math.PI
}

const IDLE = 'a person stands idle'
const BUMP_VARIANTS = Object.values(ARDY_REFLEX.PROMPTS)

// ── Tests ───────────────────────────────────────────────────────────

test('sustained wall contact: fires ONE front bump, then restores the intent prompt', async () => {
  const nowRef = { now: 1000 }
  const client = makeMockClient()
  const rig = makeMockRig()
  const source = makeSource(client, rig, nowRef)
  await connectAndBuild(client, source)
  assert.deepEqual(client.prompts, [IDLE], 'kick-off prompt on handshake')

  // 1 m/s straight +z into the z=1.0 wall (spawn z=0.15 → contact ≈0.85 s).
  client.buffer.push(makeChunk({ t0: 5, frameCount: 200, frameSeqStart: 0, walk: [0, 1.0], contactsAll: 0b1111 }))
  tick(source, nowRef, 4.5) // fire ≈1.05 s, restore at +3 s, still inside cooldown

  assert.equal(source.getTelemetry().reflex.count, 1, 'exactly one reflex')
  const bumps = client.prompts.filter((p) => BUMP_VARIANTS.includes(p))
  assert.equal(bumps.length, 1, 'one reaction prompt, no spam while grinding')
  assert.equal(bumps[0], ARDY_REFLEX.PROMPTS.front, 'frontal contact → front variant')
  assert.deepEqual(
    client.prompts,
    [IDLE, ARDY_REFLEX.PROMPTS.front, IDLE],
    'reaction fires, then the INTENT prompt is restored',
  )
  assert.equal(source.getTelemetry().reflex.active, false, 'reflex completed')
  assert(source.getTelemetry().navAbsorbCount > 0, 'treadmill absorb still active')
  source.dispose()
})

test('cooldown cadence: grinding re-fires only after COOLDOWN; absorbs continue silently between', async () => {
  const nowRef = { now: 1000 }
  const client = makeMockClient()
  const rig = makeMockRig()
  const source = makeSource(client, rig, nowRef)
  await connectAndBuild(client, source)

  client.buffer.push(makeChunk({ t0: 5, frameCount: 400, frameSeqStart: 0, walk: [0, 1.0], contactsAll: 0b1111 }))
  tick(source, nowRef, 4.5) // first reflex + restore
  const promptsAfterFirst = client.prompts.length
  const absorbsAfterRestore = source.getTelemetry().navAbsorbCount

  tick(source, nowRef, 1.0) // deep in cooldown: silent absorb
  assert.equal(client.prompts.length, promptsAfterFirst, 'no prompt during cooldown')
  assert(source.getTelemetry().navAbsorbCount > absorbsAfterRestore, 'absorb keeps working silently')

  tick(source, nowRef, 4.5) // cooldown (5 s) + re-accumulation elapse → second reflex
  assert.equal(source.getTelemetry().reflex.count, 2, 'second reflex only after the cooldown')
  const bumps = client.prompts.filter((p) => BUMP_VARIANTS.includes(p))
  assert.equal(bumps.length, 2)
  source.dispose()
})

test('direction: lateral contact picks the matching side variant', async () => {
  const nowRef = { now: 1000 }
  const client = makeMockClient()
  const rig = makeMockRig()
  const source = makeSource(client, rig, nowRef)
  await connectAndBuild(client, source)

  // Facing +z (identity yaw), walking +x: +X is her LEFT (right-handed Y-up).
  client.buffer.push(makeChunk({ t0: 5, frameCount: 200, frameSeqStart: 0, walk: [1.0, 0], contactsAll: 0b1111 }))
  tick(source, nowRef, 3.0)
  const bumps = client.prompts.filter((p) => BUMP_VARIANTS.includes(p))
  assert.equal(bumps.length, 1)
  assert.equal(bumps[0], ARDY_REFLEX.PROMPTS.left, '+X contact while facing +Z is her left side')
  source.dispose()
})

test('the pilot wins: a user prompt during a reflex cancels it — no restore queued', async () => {
  const nowRef = { now: 1000 }
  const client = makeMockClient()
  const rig = makeMockRig()
  const source = makeSource(client, rig, nowRef)
  await connectAndBuild(client, source)

  client.buffer.push(makeChunk({ t0: 5, frameCount: 200, frameSeqStart: 0, walk: [0, 1.0], contactsAll: 0b1111 }))
  tick(source, nowRef, 2.0) // reflex fired ≈1.05 s, restore due ≈4.05 s
  assert.equal(source.getTelemetry().reflex.active, true)

  source.setPrompt('a person waves their right hand')
  assert.equal(source.getTelemetry().reflex.active, false, 'reflex cancelled immediately')

  // The service answers the wave with a reset chunk; keep grinding past the
  // cancelled restore deadline — nothing may be restored on top of the wave.
  client.buffer.push(makeChunk({ t0: 15, frameCount: 200, frameSeqStart: 200, walk: [0, 1.0], reset: true }))
  tick(source, nowRef, 3.5)
  const bumps = client.prompts.filter((p) => BUMP_VARIANTS.includes(p))
  assert.equal(bumps.length, 1, 'no new reflex inside the cancelled one\'s cooldown')
  assert.equal(client.prompts.at(-1), 'a person waves their right hand', 'the wave is the last word — no restore')
  source.dispose()
})

test('the watchdog wins: garbage during a reflex is still hard-rejected; hold defers the restore to recovery', async () => {
  const nowRef = { now: 1000 }
  const client = makeMockClient()
  const rig = makeMockRig()
  const vrm = makeFakeVrm()
  const source = new ArdyMotionSource({
    rig,
    navigation: CLAMP_NAV,
    url: 'ws://test.invalid/ws',
    clientFactory: (callbacks) => { client.callbacks = callbacks; return client },
    vrmLikeFactory: () => vrm,
    autoConnect: true,
    nowMs: () => nowRef.now,
    profileFetcher: () => Promise.resolve(null),
    // Long reaction window so the watchdog deterministically engages BEFORE
    // the restore deadline (the deferral path, not the normal restore).
    reflex: { DURATION_MS: 10000 },
  })
  await connectAndBuild(client, source)

  // Walk to the wall and fire the reflex (≈1.05 s in).
  client.buffer.push(makeChunk({ t0: 5, frameCount: 100, frameSeqStart: 0, walk: [0, 1.0], contactsAll: 0b1111 }))
  tick(source, nowRef, 2.0)
  assert.equal(source.getTelemetry().reflex.active, true)
  assert.equal(source.getTelemetry().reflex.variant, 'front')

  // Mid-reflex the generation explodes (80° lean garbage at standing height).
  client.buffer.push(makeChunk({ t0: 10, frameCount: 400, frameSeqStart: 100, rootQuat: LEAN80 }))
  const hips = vrm.nodes.get('hips')
  tick(source, nowRef, 7.0) // garbage sampled from t=10; hold engages ≈2.2 s later
  assert(
    boneLeanDeg(hips.quaternion) < 45,
    `garbage during a reflex is still hard-rejected (${boneLeanDeg(hips.quaternion).toFixed(1)}° ≥ 45°)`,
  )
  assert(client.resets >= 1, 'watchdog still releases + hard-resets during a reflex')
  assert.equal(source.state, 'stale', 'watchdog owns the rig')
  assert.equal(
    client.prompts.at(-1), ARDY_REFLEX.PROMPTS.front,
    'no restore into the drifted stream while the hold owns the rig',
  )

  // Tick past the (deferred) restore deadline — still held, still no restore.
  tick(source, nowRef, 4.0)
  assert.equal(client.prompts.at(-1), ARDY_REFLEX.PROMPTS.front, 'restore deferred by the hold')

  // The service honours the reset: sane generation returns (reset chunk).
  // The gate recovers after sustained sanity — and hands the INTENT prompt
  // back (otherwise she would keep bumping forever after recovery).
  client.buffer.push(makeChunk({ t0: 40, frameCount: 400, frameSeqStart: 500, reset: true }))
  tick(source, nowRef, 9.0)
  assert.equal(source.state, 'live', 'gate recovered')
  assert.equal(client.prompts.at(-1), IDLE, 'intent prompt restored on gate recovery')
  source.dispose()
})

test('no reflex while the watchdog holds the pose', async () => {
  const nowRef = { now: 1000 }
  const client = makeMockClient()
  const rig = makeMockRig()
  const source = makeSource(client, rig, nowRef)
  await connectAndBuild(client, source)

  // Hold FIRST: standing drift-zone lean engages the watchdog (EMA crosses
  // 12° at ≈0.6 s, INSANE_HOLD 2 s → hold ≈2.6 s).
  client.buffer.push(makeChunk({ t0: 5, frameCount: 200, frameSeqStart: 0, rootQuat: LEAN20 }))
  tick(source, nowRef, 5.0)
  assert(client.resets >= 1, 'watchdog engaged (drift while upright)')
  assert.equal(source.state, 'stale')

  // Now the (drifted) stream grinds into the wall: rejection must absorb
  // silently — the watchdog owns the rig, reflexes stay OFF.
  client.buffer.push(makeChunk({ t0: 15, frameCount: 300, frameSeqStart: 200, rootQuat: LEAN20, walk: [0, 1.0], contactsAll: 0b1111 }))
  tick(source, nowRef, 8.0)
  assert.equal(source.getTelemetry().reflex.count, 0, 'no reflex while held')
  assert.equal(client.prompts.filter((p) => BUMP_VARIANTS.includes(p)).length, 0)
  source.dispose()
})

test('manifest labels: room boundary reacts as "the wall", furniture by its label', async () => {
  // The REAL loft navigation, built from the authored manifest — the same
  // collision + label mapping the mount uses (SCENE_MANIFEST_SPEC.md).
  const raw = await readFile(join(packageRoot, 'rooms/tai-loft.json'), 'utf8')
  const { manifest } = parseSceneManifest(JSON.parse(raw))
  assert.ok(manifest, 'authored manifest must validate')
  const loftNav = RoomNavigation.fromManifest(manifest, 0.22)

  // ── Boundary contact: spawn (0, 0.15), walk −z 1 m/s → the z=−3.65 wall
  // (the x=0 lane to +z is blocked by the coffee table first, so −z is the
  // clean wall run).
  {
    const nowRef = { now: 1000 }
    const client = makeMockClient()
    const rig = makeMockRig()
    const source = new ArdyMotionSource({
      rig,
      navigation: loftNav,
      url: 'ws://test.invalid/ws',
      clientFactory: (callbacks) => { client.callbacks = callbacks; return client },
      vrmLikeFactory: () => makeFakeVrm(),
      autoConnect: true,
      nowMs: () => nowRef.now,
      profileFetcher: () => Promise.resolve(null),
    })
    await connectAndBuild(client, source)
    client.buffer.push(makeChunk({ t0: 5, frameCount: 300, frameSeqStart: 0, walk: [0, -1.0], contactsAll: 0b1111 }))
    tick(source, nowRef, 5.5) // contact ≈3.8 s, reflex ≈4.0 s
    assert.equal(source.getTelemetry().reflex.count, 1, 'boundary reflex fired')
    assert.equal(
      source.getTelemetry().reflex.lastBlockerLabel,
      'the wall',
      'room_boundary is reported as "the wall", not the raw id',
    )
    assert.equal(
      client.prompts.filter((p) => BUMP_VARIANTS.includes(p))[0],
      ARDY_REFLEX.PROMPTS.front,
      'frontal wall contact → front variant',
    )
    source.dispose()
  }

  // ── Furniture contact: the coffee table blocks z ∈ [0.42, 1.88] on the
  // x=0 lane → contact ≈0.3 s.
  {
    const nowRef = { now: 1000 }
    const client = makeMockClient()
    const rig = makeMockRig()
    const source = new ArdyMotionSource({
      rig,
      navigation: loftNav,
      url: 'ws://test.invalid/ws',
      clientFactory: (callbacks) => { client.callbacks = callbacks; return client },
      vrmLikeFactory: () => makeFakeVrm(),
      autoConnect: true,
      nowMs: () => nowRef.now,
      profileFetcher: () => Promise.resolve(null),
    })
    await connectAndBuild(client, source)
    assert.equal(source.getTelemetry().reflex.lastBlockerLabel, null, 'no contact yet')
    client.buffer.push(makeChunk({ t0: 5, frameCount: 200, frameSeqStart: 0, walk: [0, 1.0], contactsAll: 0b1111 }))
    tick(source, nowRef, 1.5) // contact ≈0.27 s, reflex ≈0.5 s
    assert.equal(source.getTelemetry().reflex.count, 1, 'furniture reflex fired')
    assert.equal(
      source.getTelemetry().reflex.lastBlockerLabel,
      'coffee table',
      'blocker id resolves to the manifest label ("coffee table" not "coffee-table")',
    )
    source.dispose()
  }
})

test('natural boundary: an airborne trigger defers; the prompt fires at the first grounded frame', async () => {
  const nowRef = { now: 1000 }
  const client = makeMockClient()
  const rig = makeMockRig()
  const source = new ArdyMotionSource({
    rig,
    navigation: CLAMP_NAV,
    url: 'ws://test.invalid/ws',
    clientFactory: (callbacks) => { client.callbacks = callbacks; return client },
    vrmLikeFactory: () => makeFakeVrm(),
    autoConnect: true,
    nowMs: () => nowRef.now,
    profileFetcher: () => Promise.resolve(null),
    // Long defer cap so the grounded frame, not the cap, wins the race.
    reflex: { DEFER_MAX_MS: 20000 },
  })
  await connectAndBuild(client, source)

  // Airborne grind: 1 m/s +z into the z=1.0 wall, feet off the ground for
  // the first 6 s (a traveling move mid-flight), then the move LANDS. The
  // reflex triggers ≈1.05 s — but the reaction prompt is a reset chunk:
  // fired mid-flight it would hard-cut the move.
  client.buffer.push(makeChunk({ t0: 5, frameCount: 400, frameSeqStart: 0, walk: [0, 1.0], groundAfterS: 6 }))
  tick(source, nowRef, 2.0)
  assert.equal(source.getTelemetry().reflex.count, 0, 'airborne: the reflex defers instead of cutting the move')
  assert.equal(client.prompts.filter((p) => BUMP_VARIANTS.includes(p)).length, 0)

  // The next sampled grounded frame (t = 11) is the natural cut point —
  // the reflex fires there, well before the (overridden) defer cap.
  tick(source, nowRef, 4.5)
  assert.equal(source.getTelemetry().reflex.count, 1, 'fired at the first grounded frame')
  assert.equal(client.prompts.filter((p) => BUMP_VARIANTS.includes(p))[0], ARDY_REFLEX.PROMPTS.front)
  source.dispose()
})

test('natural boundary: the defer cap bounds responsiveness — never grounded fires at DEFER_MAX_MS', async () => {
  const nowRef = { now: 1000 }
  const client = makeMockClient()
  const rig = makeMockRig()
  const source = makeSource(client, rig, nowRef)
  await connectAndBuild(client, source)

  client.buffer.push(makeChunk({ t0: 5, frameCount: 400, frameSeqStart: 0, walk: [0, 1.0], contactsAll: 0 }))
  tick(source, nowRef, 1.6) // trigger ≈1.05 s, deadline ≈2.05 s — not yet
  assert.equal(source.getTelemetry().reflex.count, 0, 'still deferred inside the cap')
  tick(source, nowRef, 0.6) // past the 1 s defer cap
  assert.equal(source.getTelemetry().reflex.count, 1, 'the cap forces the prompt (responsiveness bound)')
  assert.equal(client.prompts.filter((p) => BUMP_VARIANTS.includes(p)).length, 1)
  // Sustained airborne grinding must NOT extend the cap: the pending
  // reflex kept its original deadline (already fired above).
  tick(source, nowRef, 3.5) // restore deadline passes
  assert.deepEqual(
    client.prompts.filter((p) => p === IDLE || BUMP_VARIANTS.includes(p)),
    [IDLE, ARDY_REFLEX.PROMPTS.front, IDLE],
    'reaction fires once at the cap, then the intent restores',
  )
  source.dispose()
})

test('the pilot wins over a PENDING reflex: a user prompt cancels the deferral', async () => {
  const nowRef = { now: 1000 }
  const client = makeMockClient()
  const rig = makeMockRig()
  const source = makeSource(client, rig, nowRef)
  await connectAndBuild(client, source)

  client.buffer.push(makeChunk({ t0: 5, frameCount: 400, frameSeqStart: 0, walk: [0, 1.0], contactsAll: 0 }))
  tick(source, nowRef, 1.6) // triggered, deferred (airborne)
  assert.equal(source.getTelemetry().reflex.count, 0)

  source.setPrompt('a person waves their right hand')
  // The service answers the wave with a fresh (reset) idle generation —
  // the grind is over, nothing may re-trigger or fire the cancelled reflex.
  client.buffer.push(makeChunk({ t0: 15, frameCount: 200, frameSeqStart: 400, reset: true }))
  tick(source, nowRef, 2.0) // well past the defer cap — nothing may fire
  assert.equal(source.getTelemetry().reflex.count, 0, 'pending reflex cancelled by the pilot')
  assert.equal(client.prompts.filter((p) => BUMP_VARIANTS.includes(p)).length, 0)
  assert.equal(client.prompts.at(-1), 'a person waves their right hand')
  source.dispose()
})

// ── Goal-planner prompt channel contract (spatial layer 3b) ─────────
// The planner's sendPlannerPrompt is the reflex layer's priority model
// EXTENDED, not forked: planner prompts must never cancel an active reflex
// and never clear a watchdog hold (reflex > planner, watchdog > planner),
// they update the intent prompt (so a reflex restore re-issues the
// planner's segment — resume for free), and only setPrompt (user/shuffle)
// bumps lastUserPromptAtMs — the planner's cancel signal.

test('planner prompt during a reflex: reflex survives, restore re-issues the planner segment', async () => {
  const nowRef = { now: 1000 }
  const client = makeMockClient()
  const rig = makeMockRig()
  const source = makeSource(client, rig, nowRef)
  await connectAndBuild(client, source)

  client.buffer.push(makeChunk({ t0: 5, frameCount: 200, frameSeqStart: 0, walk: [0, 1.0], contactsAll: 0b1111 }))
  // Reflex trigger ≈1.05 s; all four foot contacts down + upright → the
  // natural-boundary deferral passes immediately (no deferral window).
  tick(source, nowRef, 2.0)
  assert.equal(source.getTelemetry().reflex.active, true)

  // A planner segment prompt lands mid-reaction.
  source.sendPlannerPrompt('a person walks forward with steady steps')
  assert.equal(source.getTelemetry().reflex.active, true, 'reflex > planner: reaction survives')
  assert.equal(client.prompts.at(-1), 'a person walks forward with steady steps')
  // The planner prompt did NOT touch the user-prompt timestamp.
  assert.equal(source.lastUserPromptAtMs(), -Infinity)

  // Restore deadline passes: the INTENT (now the planner's segment) returns.
  tick(source, nowRef, 3.0)
  assert.equal(source.getTelemetry().reflex.active, false)
  assert.equal(client.prompts.at(-1), 'a person walks forward with steady steps', 'restore re-issues the planner segment')
  source.dispose()
})

test('planner prompt during a watchdog hold: hold survives; only setPrompt bumps the user timestamp', async () => {
  const nowRef = { now: 1000 }
  const client = makeMockClient()
  const rig = makeMockRig()
  const source = makeSource(client, rig, nowRef)
  await connectAndBuild(client, source)

  // Drift-zone lean engages the watchdog (hold ≈2.6 s in).
  client.buffer.push(makeChunk({ t0: 5, frameCount: 200, frameSeqStart: 0, rootQuat: LEAN20 }))
  tick(source, nowRef, 5.0)
  assert.equal(source.state, 'stale')
  assert.equal(source.isWatchdogHolding(), true)

  // A planner prompt must NOT reclaim the pose from the watchdog.
  source.sendPlannerPrompt('a person walks forward')
  assert.equal(source.isWatchdogHolding(), true, 'watchdog > planner: hold survives')
  assert.equal(source.lastUserPromptAtMs(), -Infinity, 'planner prompts never bump the user timestamp')

  // The user path still wins over everything and IS the cancel signal.
  source.setPrompt('a person waves their right hand')
  assert.equal(source.lastUserPromptAtMs(), nowRef.now, 'setPrompt bumps the user timestamp')
  source.dispose()
})
