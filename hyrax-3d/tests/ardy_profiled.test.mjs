/**
 * Profiled live retarget path tests (AvatarRetargeter / tai-embodiment-v3).
 *
 * Covers the unification of the loft's live ARDY retarget onto the
 * user-validated calibration profile:
 *
 *  1. Legacy profiles (no rest_pose.source_rest): calibration waits for the
 *     settled idle stream frame (profile rest_frame_recommended.cskel27 = 20)
 *     before writing any poses — ProceduralLocomotion owns the rig until then.
 *  2. The profile bone map is honored: upperChest ← Spine2 (the deleted
 *     legacy table mapped upperChest ← Spine3; the profile superseded it).
 *  3. Profile-fetch failure falls back to the gestalt-motion path (poses
 *     immediately, no settled-frame wait).
 *  4. REGRESSION (frozen T-pose): the shipped profile embeds
 *     rest_pose.source_rest (canonical capture-tpose T-pose) because the live
 *     generator stream contains NO T-pose settle — measuring rest from a
 *     stream frame captured arms-down idle and every per-frame delta
 *     collapsed to identity, freezing the avatar in her normalized rest
 *     (T-pose) while the source claimed pose ownership. With source_rest the
 *     same no-T-pose stream must pose the arms DOWN, and a malformed
 *     source_rest must fail closed to the gestalt fallback.
 *  5. PARITY: on the recorded capture-idle chunk, the live path (ArdyMotionSource
 *     + ProfiledLiveRetargeter, VRM 0.x conjugation) must produce the same
 *     per-bone local quaternions as the debug page's validated profiled flow
 *     (rest measured from capture-tpose frame 20, motion swapped to the
 *     played clip via AvatarRetargeter.setPoseMotion).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import * as THREE from 'three'

import { ChunkBuffer } from 'gestalt-motion/ChunkBuffer.ts'
import { CSKEL27_SOURCE_JOINT_NAMES } from 'gestalt-motion/adapters/cskel27.ts'

import { ArdyMotionSource } from '../src/embodiment/motion/ArdyMotionSource.ts'
import { AvatarRetargeter } from '../calibrate/AvatarRetargeter.js'

// ── Fixtures ────────────────────────────────────────────────────────

const PROFILE = JSON.parse(readFileSync(
  new URL('../calibrate/calibration-profiles/tai-embodiment-v3.json', import.meta.url),
  'utf8',
))
const REST_FRAME = PROFILE.rest_pose.rest_frame_recommended.cskel27 // 20

/**
 * Legacy profile shape (pre-source_rest): rest is measured from settled
 * stream frame 20 — valid only for streams with a T-pose settle. The shipped
 * profile embeds rest_pose.source_rest (canonical capture-tpose T-pose) and
 * calibrates immediately; these clones exercise the legacy feed path.
 */
function legacyProfile() {
  const p = structuredClone(PROFILE)
  delete p.rest_pose.source_rest
  return p
}

const JOINT_NAMES = CSKEL27_SOURCE_JOINT_NAMES
const JOINT_INDEX = Object.fromEntries(JOINT_NAMES.map((n, i) => [n, i]))

// Parents precede children (same Core27 topology as the live contract).
const PARENT_INDICES = [
  -1, 0, 1, 2, 3, 4, 5, 4, 7, 8, 9, 10, 10, 4, 13, 14, 15, 16, 16, 0, 19, 20, 21, 0, 23, 24, 25,
]

const REST_OFFSETS = JOINT_NAMES.map((name) => {
  switch (name) {
    case 'Hips': return [0, 0.954, 0]
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
    skeleton_id: 'cskel27',
    joint_names: JOINT_NAMES,
    parent_indices: PARENT_INDICES,
    rest_offsets_m: REST_OFFSETS,
    coord_frame: 'rh-yup-zforward-m',
  }
}

// Fake normalized-bone node with a REAL three.js quaternion (AvatarRetargeter
// calls node.quaternion.copy(...) — plain-object fakes do not satisfy it).
function fakeNode(y = 0) {
  return {
    quaternion: new THREE.Quaternion(),
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
    updateMatrixWorld() {},
  }
}

function makeFakeVrm(metaVersion = '1.0') {
  const nodes = new Map()
  for (const bone of Object.keys(PROFILE.skeleton_maps.cskel27)) {
    nodes.set(bone, fakeNode(bone === 'hips' ? 0.95 : bone.endsWith('Foot') ? 0.05 : 0.5))
  }
  const vrm = {
    nodes,
    resets: 0,
    humanoid: {
      getNormalizedBoneNode: (name) => nodes.get(name) ?? null,
      update() {},
      resetNormalizedPose() {
        vrm.resets += 1
        for (const node of nodes.values()) node.quaternion.identity()
      },
    },
    scene: fakeNode(0),
    meta: { metaVersion },
  }
  return vrm
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

const QIDENT = [1, 0, 0, 0]

function qAxisAngle(axis, rad) {
  const s = Math.sin(rad / 2)
  return [Math.cos(rad / 2), axis[0] * s, axis[1] * s, axis[2] * s]
}

/**
 * Build a stream chunk. localRotFn(frame, jointName) returns a w-first quat
 * (default identity). contactsFn(frame) returns a contact bitmask (default 0).
 */
function makeChunk({
  t0 = 5, frameCount = 40, frameSeqStart = 0, fps = 20,
  localRotFn = null, contactsFn = null, rootFn = null, chunkSeq = 0, reset = false,
}) {
  const jointCount = JOINT_NAMES.length
  const timestamps = new Float32Array(frameCount)
  const localRots = new Float32Array(frameCount * jointCount * 4)
  const contacts = new Uint8Array(frameCount)
  const root = []
  for (let i = 0; i < frameCount; i += 1) {
    const t = t0 + i / fps
    timestamps[i] = t
    root.push(rootFn ? rootFn(i) : { position_m: [0, 0.954, 0], orientation_wxyz: QIDENT })
    for (let j = 0; j < jointCount; j += 1) {
      const q = localRotFn ? (localRotFn(i, JOINT_NAMES[j]) ?? QIDENT) : QIDENT
      localRots.set(q, (i * jointCount + j) * 4)
    }
    contacts[i] = contactsFn ? contactsFn(i) : 0
  }
  return {
    session_id: 's1',
    chunk_seq: chunkSeq,
    frame_seq_start: frameSeqStart,
    fps,
    skeleton_id: 'cskel27',
    frame_count: frameCount,
    reset,
    timestamps_s: timestamps,
    root,
    local_rot_wxyz: localRots,
    contacts,
  }
}

function makeSource(client, rig, vrm, profilePromise, nowRef) {
  return new ArdyMotionSource({
    rig,
    navigation: { constrainMovement: (_from, to) => ({ position: to }) },
    url: 'ws://test.invalid/ws',
    clientFactory: (callbacks) => { client.callbacks = callbacks; return client },
    vrmLikeFactory: () => vrm,
    autoConnect: true,
    nowMs: () => nowRef.now,
    profileFetcher: () => profilePromise,
  })
}

function flushBuild() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Angular distance (degrees) between two xyzw quats, sign-insensitive. */
function quatAngleDeg(a, b) {
  const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w)
  return 2 * Math.acos(Math.min(1, dot)) * 180 / Math.PI
}

// ── Tests ───────────────────────────────────────────────────────────

test('profiled path (legacy, no source_rest): calibration waits for the settled idle stream frame before writing poses', async () => {
  const nowRef = { now: 1000 }
  const client = makeMockClient()
  const rig = makeMockRig()
  const vrm = makeFakeVrm('1.0')
  const source = makeSource(client, rig, vrm, Promise.resolve(legacyProfile()), nowRef)

  client.connected = true
  client.callbacks.onOpen('s1')
  client.callbacks.onSkeleton(makeContract())
  await flushBuild()
  assert.deepEqual(client.prompts, ['a person stands idle'], 'prompt kicked after retargeter build')

  // Stream: 40 idle frames at 20 fps starting at t=5. Frame k plays at
  // now = 1000 + k*50 ms, so settled frame 20 arrives at now = 2000.
  client.buffer.push(makeChunk({ t0: 5 }))
  client.callbacks.onChunk?.()

  let firstOwnedNow = null
  let calibratedNow = null
  for (let i = 0; i < 200 && firstOwnedNow === null; i += 1) {
    const owned = source.update(0.02)
    if (vrm.resets === 1 && calibratedNow === null) calibratedNow = nowRef.now
    if (owned) {
      firstOwnedNow = nowRef.now
    } else {
      assert.equal(rig.poseWrites, 0, `no pose writes before ownership (now=${nowRef.now})`)
    }
    nowRef.now += 20
  }

  assert(calibratedNow !== null, 'calibration ran (rig reset to normalized rest once)')
  assert(
    calibratedNow >= 1000 + REST_FRAME * 50,
    `calibration must wait for settled frame ${REST_FRAME} (reset at now=${calibratedNow}, ` +
    `frame time ${1000 + REST_FRAME * 50})`,
  )
  assert.equal(vrm.resets, 1, 'resetNormalizedPose ran exactly once, at calibration')
  assert(firstOwnedNow !== null, 'profiled source eventually owns the pose')
  assert(
    firstOwnedNow >= 1000 + REST_FRAME * 50,
    `poses must not start before settled frame ${REST_FRAME} (owned at now=${firstOwnedNow}, ` +
    `frame time ${1000 + REST_FRAME * 50})`,
  )
  assert(
    firstOwnedNow < 1000 + REST_FRAME * 50 + 500,
    `poses should start soon after the settled frame (owned at now=${firstOwnedNow})`,
  )
  assert(rig.poseWrites > 0)
  source.dispose()
})

test('profiled path (legacy, no source_rest): upperChest follows Spine2 (profile map), not Spine3 (gestalt map)', async () => {
  const nowRef = { now: 1000 }
  const client = makeMockClient()
  const rig = makeMockRig()
  const vrm = makeFakeVrm('1.0')
  const source = makeSource(client, rig, vrm, Promise.resolve(legacyProfile()), nowRef)

  // Rest: frames 0..20 identity. Motion: Spine2 twists 0.5 rad about Z,
  // Spine3 twists 0.9 rad about X — if upperChest were (wrongly) fed Spine3's
  // world delta it would pick up the 0.9 rad X component.
  const spine2Rot = qAxisAngle([0, 0, 1], 0.5)
  const spine3Rot = qAxisAngle([1, 0, 0], 0.9)
  const localRotFn = (frame, joint) => {
    if (frame <= REST_FRAME) return null
    if (joint === 'Spine2') return spine2Rot
    if (joint === 'Spine3') return spine3Rot
    return null
  }

  client.connected = true
  client.callbacks.onOpen('s1')
  client.callbacks.onSkeleton(makeContract())
  await flushBuild()
  client.buffer.push(makeChunk({ t0: 5, localRotFn }))
  client.callbacks.onChunk?.()

  // Run until calibration completes, the pose is owned, and the crossfade has
  // fully ramped (0.3 s), sampling a post-rest frame.
  let owned = false
  for (let i = 0; i < 400; i += 1) {
    owned = source.update(1 / 30) || owned
    nowRef.now += 33
    if (owned && nowRef.now > 1000 + (REST_FRAME + 5) * 50 + 600) break
  }
  assert(owned, 'profiled source owns the pose after calibration')

  const upperChest = vrm.nodes.get('upperChest').quaternion
  const expected = new THREE.Quaternion(spine2Rot[1], spine2Rot[2], spine2Rot[3], spine2Rot[0])
  assert(
    quatAngleDeg(upperChest, expected) < 1,
    `upperChest should equal the Spine2 delta (got ${quatAngleDeg(upperChest, expected).toFixed(2)}° off)`,
  )
  // The gestalt mapping (upperChest ← Spine3) would produce Spine3's world
  // delta = Spine2∘Spine3 — far from what the profiled path must write.
  const gestaltWorld = new THREE.Quaternion(spine2Rot[1], spine2Rot[2], spine2Rot[3], spine2Rot[0])
    .multiply(new THREE.Quaternion(spine3Rot[1], spine3Rot[2], spine3Rot[3], spine3Rot[0]))
  assert(
    quatAngleDeg(upperChest, gestaltWorld) > 30,
    'upperChest must NOT carry Spine3 world delta (gestalt Spine3 mapping)',
  )
  source.dispose()
})

test('profile-fetch failure falls back to the gestalt-motion path (no settled-frame wait)', async () => {
  const nowRef = { now: 1000 }
  const client = makeMockClient()
  const rig = makeMockRig()
  const vrm = makeFakeVrm('1.0')
  const source = makeSource(
    client, rig, vrm,
    Promise.reject(new Error('profile fetch boom')),
    nowRef,
  )

  client.connected = true
  client.callbacks.onOpen('s1')
  client.callbacks.onSkeleton(makeContract())
  await flushBuild()
  client.buffer.push(makeChunk({ t0: 5 }))
  client.callbacks.onChunk?.()

  // Gestalt fallback poses immediately (frame 0, now=1000) — the profiled
  // path would hold the pose until frame 20 (now=2000).
  let firstOwnedNow = null
  for (let i = 0; i < 100 && firstOwnedNow === null; i += 1) {
    if (source.update(1 / 60)) firstOwnedNow = nowRef.now
    nowRef.now += 20
  }
  assert(firstOwnedNow !== null, 'fallback path still goes live')
  assert(
    firstOwnedNow < 1000 + REST_FRAME * 50,
    `fallback must not wait for the settled frame (owned at now=${firstOwnedNow})`,
  )
  assert.equal(vrm.resets, 0, 'gestalt fallback never resets the normalized pose')
  assert(source.isLive())
  source.dispose()
})

test('REGRESSION (frozen T-pose): source_rest calibrates immediately and a no-T-pose stream poses arms-down', async () => {
  // The live generator stream is idle motion from frame 0 — it NEVER passes
  // through a T-pose. The legacy settled-frame-20 measurement therefore
  // captured an arms-down pose as "rest", every per-frame delta collapsed to
  // identity, and the rendered avatar froze in her normalized rest (T-pose)
  // while the source claimed pose ownership. The profile's embedded
  // source_rest (canonical capture-tpose T-pose) is the rest reference
  // instead. This stream holds a fixed arms-down LeftArm at EVERY frame —
  // the legacy path would write identity (the freeze); source_rest must
  // write the large arms-down rotation.
  const nowRef = { now: 1000 }
  const client = makeMockClient()
  const rig = makeMockRig()
  const vrm = makeFakeVrm('1.0')
  const source = makeSource(client, rig, vrm, Promise.resolve(PROFILE), nowRef)

  const armDown = qAxisAngle([0, 0, 1], 1.2)
  const localRotFn = (_frame, joint) => (joint === 'LeftArm' ? armDown : null)

  client.connected = true
  client.callbacks.onOpen('s1')
  client.callbacks.onSkeleton(makeContract())
  await flushBuild()
  assert.equal(vrm.resets, 1, 'calibration ran at build (embedded source_rest — no settled-frame wait)')
  client.buffer.push(makeChunk({ t0: 5, localRotFn }))
  client.callbacks.onChunk?.()

  // Ownership must start on the first sampled frame (frame 0, now=1000),
  // far ahead of the legacy settled-frame-20 time (now=2000).
  let firstOwnedNow = null
  for (let i = 0; i < 100 && firstOwnedNow === null; i += 1) {
    if (source.update(1 / 60)) firstOwnedNow = nowRef.now
    nowRef.now += 20
  }
  assert(firstOwnedNow !== null, 'profiled source owns the pose')
  assert(
    firstOwnedNow < 1000 + REST_FRAME * 50,
    `no settled-frame wait with embedded source_rest (owned at now=${firstOwnedNow})`,
  )

  // Run past the 0.3 s crossfade so the written pose is the full target.
  for (let i = 0; i < 60; i += 1) {
    source.update(1 / 30)
    nowRef.now += 33
  }
  const leftUpperArm = vrm.nodes.get('leftUpperArm').quaternion
  const identity = new THREE.Quaternion()
  const deg = quatAngleDeg(leftUpperArm, identity)
  assert(
    deg > 30,
    `frozen T-pose regression: leftUpperArm must hold the arms-down rotation, ` +
    `not the identity normalized rest (got ${deg.toFixed(2)}° from identity; ` +
    `the legacy settled-frame measurement produced ≈0° — the freeze)`,
  )
  source.dispose()
})

test('malformed source_rest fails closed: profiled init throws, gestalt fallback poses', async () => {
  const broken = structuredClone(PROFILE)
  broken.rest_pose.source_rest = {
    joints: ['Hips'],
    world_rot_mats: [[1, 0, 0, 0, 1, 0, 0, 0, 1]],
  }
  const nowRef = { now: 1000 }
  const client = makeMockClient()
  const rig = makeMockRig()
  const vrm = makeFakeVrm('1.0')
  const source = makeSource(client, rig, vrm, Promise.resolve(broken), nowRef)

  client.connected = true
  client.callbacks.onOpen('s1')
  client.callbacks.onSkeleton(makeContract())
  await flushBuild()
  client.buffer.push(makeChunk({ t0: 5 }))
  client.callbacks.onChunk?.()

  let firstOwnedNow = null
  for (let i = 0; i < 100 && firstOwnedNow === null; i += 1) {
    if (source.update(1 / 60)) firstOwnedNow = nowRef.now
    nowRef.now += 20
  }
  assert(firstOwnedNow !== null, 'gestalt fallback still goes live')
  assert(
    firstOwnedNow < 1000 + REST_FRAME * 50,
    `fallback must not wait for the settled frame (owned at now=${firstOwnedNow})`,
  )
  assert.equal(vrm.resets, 0, 'failed profiled init never resets the normalized pose')
  assert(source.isLive())
  source.dispose()
})

// ── Parity: live path vs the debug page's validated profiled path ───

/** debug ardy.js:269-279 — VRM 0.x source-side Y180 conjugation, verbatim. */
function conjugateClipY180(m) {
  return {
    ...m,
    global_rot_mats: m.global_rot_mats.map((frame) => frame.map((r) => [
      r[0], -r[1], r[2],
      -r[3], r[4], -r[5],
      r[6], -r[7], r[8],
    ])),
    root_positions: m.root_positions.map((p) => [-p[0], p[1], -p[2]]),
  }
}

test('PARITY: live profiled path matches the debug profiled path on capture-idle', async () => {
  const capture = JSON.parse(readFileSync(
    new URL('../debug/data/capture-idle-chunk_000.json', import.meta.url),
    'utf8',
  ))
  assert.equal(capture.skeleton, 'cskel27')
  const fps = capture.fps
  const T = capture.global_rot_mats.length
  assert(T > REST_FRAME + 10, 'capture must extend past the settled rest frame')

  const joints = capture.joints
  const nameIdx = Object.fromEntries(joints.map((n, i) => [n, i]))
  const parentIdx = capture.parents.map((p) => (p === null ? -1 : nameIdx[p]))

  // Global rotation matrices → per-joint local quats (what the live stream
  // carries): L_j = G_parent⁻¹ ⊗ G_j.
  const m4 = new THREE.Matrix4()
  const globalQuat = (f, j) => {
    const m = capture.global_rot_mats[f][j]
    m4.set(m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1)
    return new THREE.Quaternion().setFromRotationMatrix(m4)
  }
  const chunk = (() => {
    const timestamps = new Float32Array(T)
    const localRots = new Float32Array(T * joints.length * 4)
    const contacts = new Uint8Array(T)
    const root = []
    for (let f = 0; f < T; f += 1) {
      timestamps[f] = 5 + f / fps
      // Root orientation identity → the loft's yaw-strip is a no-op, keeping
      // the hips comparable with the debug path (which has no nav yaw seam).
      root.push({ position_m: capture.root_positions[f], orientation_wxyz: QIDENT })
      for (let j = 0; j < joints.length; j += 1) {
        const g = globalQuat(f, j)
        const p = parentIdx[j]
        const local = p < 0 ? g : globalQuat(f, p).invert().multiply(g)
        localRots.set([local.w, local.x, local.y, local.z], (f * joints.length + j) * 4)
      }
      contacts[f] = capture.foot_contacts[f].reduce(
        (bits, c, i) => bits | (c > 0.5 ? 1 << i : 0), 0,
      )
    }
    return {
      session_id: 's1', chunk_seq: 0, frame_seq_start: 0, fps,
      skeleton_id: 'cskel27', frame_count: T, reset: false,
      timestamps_s: timestamps, root, local_rot_wxyz: localRots, contacts,
    }
  })()

  const contract = {
    skeleton_id: 'cskel27',
    joint_names: joints,
    parent_indices: parentIdx,
    rest_offsets_m: capture.rest_offsets_m,
    coord_frame: 'rh-yup-zforward-m',
  }

  // Path A — the debug page's validated profiled flow (ardy.js restClip):
  // rest measured from the SETTLED capture-tpose T-pose (frame 20, the TRUE
  // source rest reference), then the motion handle swapped to the played
  // capture-idle clip. Both clips conjugated for VRM 0.x.
  const tposeCap = JSON.parse(readFileSync(
    new URL('../debug/data/capture-tpose-chunk_000.json', import.meta.url),
    'utf8',
  ))
  assert(tposeCap.global_rot_mats.length > REST_FRAME, 'tpose rest clip covers the rest frame')
  const vrmA = makeFakeVrm('0')
  const cmpRest = conjugateClipY180({
    global_rot_mats: tposeCap.global_rot_mats,
    root_positions: tposeCap.root_positions,
  })
  const cmpMotion = conjugateClipY180({
    global_rot_mats: capture.global_rot_mats,
    root_positions: capture.root_positions,
  })
  const retA = new AvatarRetargeter(vrmA, PROFILE, {
    srcHipsHeight: PROFILE.rest_pose.default_src_hips_height_m,
    restFrame: REST_FRAME,
  })
  retA.setMotion({
    skeleton: 'cskel27',
    joints: tposeCap.joints,
    rot: cmpRest.global_rot_mats,
    root: cmpRest.root_positions,
    contacts: tposeCap.foot_contacts,
  })
  assert(retA.boneMap, 'debug-path retargeter resolved the cskel27 map')
  retA.setPoseMotion({
    skeleton: 'cskel27',
    joints,
    rot: cmpMotion.global_rot_mats,
    root: cmpMotion.root_positions,
    contacts: capture.foot_contacts,
  })

  // Path B — the loft's live path: synthetic stream through ArdyMotionSource.
  const nowRef = { now: 1000 }
  const client = makeMockClient()
  const rig = makeMockRig()
  const vrmB = makeFakeVrm('0')
  const source = makeSource(client, rig, vrmB, Promise.resolve(PROFILE), nowRef)
  client.connected = true
  client.callbacks.onOpen('s1')
  client.callbacks.onSkeleton(contract)
  await flushBuild()
  client.buffer.push(chunk)
  client.callbacks.onChunk?.()

  // Tick until calibrated and fully crossfaded (now=1000 ↔ stream t=5).
  let owned = false
  for (let i = 0; i < 400; i += 1) {
    owned = source.update(1 / 30) || owned
    nowRef.now += 33
    if (owned && nowRef.now > 1000 + REST_FRAME * 50 + 700) break
  }
  assert(owned, 'live profiled path owns the pose after calibration')
  assert.equal(vrmB.resets, 1, 'live path reset the rig before measuring rest')

  // Compare per-bone local quats on representative post-rest frames.
  const bones = Object.keys(PROFILE.skeleton_maps.cskel27)
  const frames = [REST_FRAME + 1, REST_FRAME + 10, T - 1]
  const report = []
  let maxDeg = 0
  let sumDeg = 0
  let n = 0
  for (const f of frames) {
    retA.applyFrame(f, { writeHipsPosition: false })
    nowRef.now = 1000 + f * (1000 / fps) // stream t = 5 + f/fps exactly
    assert.equal(source.update(1 / 60), true, `live path poses at frame ${f}`)
    for (const bone of bones) {
      const deg = quatAngleDeg(
        vrmA.nodes.get(bone).quaternion,
        vrmB.nodes.get(bone).quaternion,
      )
      report.push(`${bone}@f${f}=${deg.toFixed(4)}°`)
      maxDeg = Math.max(maxDeg, deg)
      sumDeg += deg
      n += 1
    }
  }
  const meanDeg = sumDeg / n
  console.log(
    `[parity] ${n} bone-frame samples over frames ${frames.join('/')}: ` +
    `max ${maxDeg.toFixed(5)}°, mean ${meanDeg.toFixed(5)}°`,
  )
  if (maxDeg >= 0.5) console.log('[parity] worst:', report.filter((r) => !r.endsWith('0.0000°')).slice(0, 10))
  assert(
    maxDeg < 0.5,
    `live profiled path diverges from the debug profiled path (max ${maxDeg.toFixed(3)}°)`,
  )
  source.dispose()
})
