/**
 * Scene manifest tests — the room as data (spatial layer 3).
 *
 * Spec: docs/gestalt-vn/specs/SCENE_MANIFEST_SPEC.md
 *
 *  - manifest_version 1.0 schema + FAIL-CLOSED validator: bad bounds,
 *    obstacle without id, interaction without spot, unknown kind, etc.
 *    all reject the whole manifest (never a partial room).
 *  - tai-loft.json (authored from the former hardcoded TaiRoomScene
 *    values) validates and is byte-equivalent to the old constructor +
 *    addBoxObstacle navigation — same collision everywhere.
 *  - RoomNavigation.fromManifest consumes the manifest; labelForBlockerId
 *    resolves manifest labels ("coffee table" not "coffee-table";
 *    room_boundary → "the wall").
 *  - loadSceneManifest: success path + fail-closed default + warning.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { Vector3 } from 'three'

import {
  DEFAULT_SCENE_MANIFEST,
  SCENE_MANIFEST_VERSION,
  loadSceneManifest,
  parseSceneManifest,
} from '../src/embodiment/room/sceneManifest.ts'
import { InteractableStateMachine } from '../src/embodiment/room/interactableState.ts'
import { RoomNavigation } from '../src/embodiment/navigation/RoomNavigation.ts'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))

async function readAuthoredManifest() {
  const raw = await readFile(join(packageRoot, 'rooms/tai-loft.json'), 'utf8')
  return JSON.parse(raw)
}

// ── Valid manifests ────────────────────────────────────────────────

test('authored tai-loft.json validates and carries the current hardcoded room', async () => {
  const { manifest, errors } = parseSceneManifest(await readAuthoredManifest())
  assert.equal(errors.length, 0, JSON.stringify(errors))
  assert.ok(manifest)
  assert.equal(manifest.manifest_version, SCENE_MANIFEST_VERSION)
  assert.equal(manifest.room_id, 'tai-loft')
  assert.deepEqual(manifest.bounds, { minX: -3.65, maxX: 3.65, minZ: -3.65, maxZ: 3.65 })
  // The five collision obstacles from the former seedRoom().
  assert.deepEqual(
    manifest.obstacles.map((o) => o.id),
    ['couch', 'coffee-table', 'command-zone', 'kitchen', 'daybed'],
  )
  // HalfSizes are the old full sizes / 2 (XZ footprint).
  const couch = manifest.obstacles.find((o) => o.id === 'couch')
  assert.deepEqual(couch?.center, [0, 2.28])
  assert.deepEqual(couch?.halfSize, [1.425, 0.5])
  assert.equal(couch?.padding, 0.1)
  assert.ok(manifest.objects.length >= 10, 'canonical prop positions recorded')
  assert.equal(manifest.vn?.background, 'vn/backgrounds/tai-loft.png')
})

test('DEFAULT_SCENE_MANIFEST (fail-closed empty room) validates', () => {
  const { manifest, errors } = parseSceneManifest(DEFAULT_SCENE_MANIFEST)
  assert.equal(errors.length, 0, JSON.stringify(errors))
  assert.ok(manifest)
  assert.equal(manifest.obstacles.length, 0)
  assert.equal(manifest.objects.length, 0)
})

// ── Fail-closed validator ──────────────────────────────────────────

function validBase() {
  return {
    manifest_version: SCENE_MANIFEST_VERSION,
    room_id: 'tai-loft',
    name: 'The Synthesis Loft',
    bounds: { minX: -3.65, maxX: 3.65, minZ: -3.65, maxZ: 3.65 },
    obstacles: [
      { id: 'coffee-table', label: 'coffee table', center: [0, 1.15], halfSize: [0.725, 0.41], padding: 0.1 },
    ],
    objects: [
      {
        id: 'desk',
        label: 'her desk',
        position: [0, 1, 0],
        interactions: [{ id: 'work', kind: 'sit', spot: [0, 0.5], facingDeg: 0, prompt: 'a person sits at a desk working' }],
      },
    ],
  }
}

test('validator rejects: non-object root', () => {
  for (const raw of [null, 42, 'room', [1, 2]]) {
    const { manifest, errors } = parseSceneManifest(raw)
    assert.equal(manifest, null, JSON.stringify(raw))
    assert.ok(errors.length > 0)
  }
})

test('validator rejects: unsupported manifest_version', () => {
  const wrongVersions = ['2.0', '9.9', 1, null]
  // The exact current version is valid — reject anything ELSE (a sibling
  // slice bumped 1.0 → 1.1; the test must not hardcode a version).
  assert.equal(parseSceneManifest(validBase()).manifest?.manifest_version, SCENE_MANIFEST_VERSION)
  for (const version of wrongVersions) {
    if (version === SCENE_MANIFEST_VERSION) continue
    const { manifest, errors } = parseSceneManifest({ ...validBase(), manifest_version: version })
    assert.equal(manifest, null, String(version))
    assert.match(errors.join('; '), /manifest_version/)
  }
})

test('validator rejects: bad bounds (swapped, missing, non-finite)', () => {
  const badBounds = [
    { minX: 3.65, maxX: -3.65, minZ: -3.65, maxZ: 3.65 }, // minX >= maxX
    { minX: -3.65, maxX: 3.65, minZ: 3.65, maxZ: -3.65 }, // minZ >= maxZ
    { minX: -3.65, maxX: 3.65, maxZ: 3.65 }, // missing minZ
    { minX: -3.65, maxX: 3.65, minZ: -3.65, maxZ: 'wide' }, // non-number
    { minX: -3.65, maxX: Infinity, minZ: -3.65, maxZ: 3.65 }, // non-finite
  ]
  for (const bounds of badBounds) {
    const { manifest, errors } = parseSceneManifest({ ...validBase(), bounds })
    assert.equal(manifest, null, JSON.stringify(bounds))
    assert.match(errors.join('; '), /bounds/)
  }
})

test('validator rejects: obstacle without id / bad geometry', () => {
  const badObstacles = [
    { id: '', label: 'x', center: [0, 1], halfSize: [1, 1], padding: 0.1 }, // empty id
    { label: 'x', center: [0, 1], halfSize: [1, 1], padding: 0.1 }, // missing id
    { id: 'a', label: 'x', center: [0, 1, 2], halfSize: [1, 1], padding: 0.1 }, // center not [x,z]
    { id: 'a', label: 'x', center: [0, '1'], halfSize: [1, 1], padding: 0.1 }, // non-number
    { id: 'a', label: 'x', center: [0, 1], halfSize: [NaN, 1], padding: 0.1 }, // non-finite halfSize
    { id: 'a', label: 'x', center: [0, 1], halfSize: [-1, 1], padding: 0.1 }, // negative halfSize
    { id: 'a', label: 'x', center: [0, 1], halfSize: [1, 1], padding: -0.2 }, // negative padding
    { id: 'a', label: 7, center: [0, 1], halfSize: [1, 1], padding: 0.1 }, // non-string label
  ]
  for (const obstacle of badObstacles) {
    const { manifest, errors } = parseSceneManifest({ ...validBase(), obstacles: [obstacle] })
    assert.equal(manifest, null, JSON.stringify(obstacle))
    assert.match(errors.join('; '), /obstacles\[0\]/)
  }
})

test('validator rejects: duplicate obstacle ids', () => {
  const { manifest, errors } = parseSceneManifest({
    ...validBase(),
    obstacles: [
      { id: 'table', label: 'a', center: [0, 1], halfSize: [1, 1], padding: 0.1 },
      { id: 'table', label: 'b', center: [0, 2], halfSize: [1, 1], padding: 0.1 },
    ],
  })
  assert.equal(manifest, null)
  assert.match(errors.join('; '), /duplicated/)
})

test('validator rejects: interaction without spot / unknown kind / bad fields', () => {
  const badInteractions = [
    { id: 'work', kind: 'sit', facingDeg: 0, prompt: 'p' }, // no spot
    { id: 'work', kind: 'sit', spot: [0], facingDeg: 0, prompt: 'p' }, // spot not [x,z]
    { id: 'work', kind: 'fly', spot: [0, 1], facingDeg: 0, prompt: 'p' }, // unknown kind
    { id: 'work', kind: 'sit', spot: [0, 1], facingDeg: NaN, prompt: 'p' }, // non-finite facing
    { id: 'work', kind: 'sit', spot: [0, 1], facingDeg: 0 }, // missing prompt
    { kind: 'sit', spot: [0, 1], facingDeg: 0, prompt: 'p' }, // missing id
  ]
  for (const interaction of badInteractions) {
    const { manifest, errors } = parseSceneManifest({
      ...validBase(),
      objects: [{ ...validBase().objects[0], interactions: [interaction] }],
    })
    assert.equal(manifest, null, JSON.stringify(interaction))
    assert.match(errors.join('; '), /interactions\[0\]/)
  }
})

test('validator rejects: object with bad position / bad objects array', () => {
  const badObjects = [
    { id: 'desk', label: 'her desk', position: [0, 1] }, // not [x,y,z]
    { id: 'desk', label: 'her desk', position: [0, '1', 0] }, // non-number
    { id: 'desk', position: [0, 1, 0] }, // missing label
    { label: 'her desk', position: [0, 1, 0] }, // missing id
    'desk', // not an object
  ]
  for (const object of badObjects) {
    const { manifest, errors } = parseSceneManifest({ ...validBase(), objects: [object] })
    assert.equal(manifest, null, JSON.stringify(object))
    assert.match(errors.join('; '), /objects\[0\]/)
  }
  const noArray = parseSceneManifest({ ...validBase(), obstacles: 'none' })
  assert.equal(noArray.manifest, null)
  assert.match(noArray.errors.join('; '), /obstacles must be an array/)
})

test('validator rejects: vn must be an object with a string background', () => {
  for (const vn of [42, [], 'bg', { background: 7 }]) {
    const { manifest, errors } = parseSceneManifest({ ...validBase(), vn })
    assert.equal(manifest, null, JSON.stringify(vn))
    assert.match(errors.join('; '), /vn/)
  }
})

test('validator accepts: vn omitted or empty', () => {
  const { manifest } = parseSceneManifest({ ...validBase(), vn: undefined })
  assert.ok(manifest)
  const withBg = parseSceneManifest({ ...validBase(), vn: { background: 'x.png' } })
  assert.equal(withBg.manifest?.vn?.background, 'x.png')
})

// ── pickup attach (spatial layer 5, INTERACTABLES_SPEC.md) ─────────

function pickupBase() {
  return {
    ...validBase(),
    objects: [
      {
        id: 'cup',
        label: 'the mug',
        position: [0.2, 0.4, 1.15],
        interactions: [
          {
            id: 'pickup',
            kind: 'pickup',
            spot: [0.2, 1.15],
            facingDeg: 180,
            prompt: 'a person picks up a cup from the table',
            attach: { bone: 'rightHand', offset: [0, 0.05, 0] },
          },
        ],
      },
    ],
  }
}

test('validator accepts: kind pickup with attach {bone, offset}', () => {
  const { manifest, errors } = parseSceneManifest(pickupBase())
  assert.equal(errors.length, 0, JSON.stringify(errors))
  assert.ok(manifest)
  assert.deepEqual(manifest.objects[0].interactions[0].attach, {
    bone: 'rightHand',
    offset: [0, 0.05, 0],
  })
})

test('validator rejects: attach on a non-pickup kind (fail-closed pairing)', () => {
  const bad = validBase()
  bad.objects[0].interactions[0].attach = { bone: 'rightHand', offset: [0, 0.05, 0] }
  const { manifest, errors } = parseSceneManifest(bad)
  assert.equal(manifest, null)
  assert.match(errors.join('; '), /only allowed on kind "pickup"/)
})

test('validator rejects: kind pickup without an attach spec', () => {
  const bad = pickupBase()
  delete bad.objects[0].interactions[0].attach
  const { manifest, errors } = parseSceneManifest(bad)
  assert.equal(manifest, null)
  assert.match(errors.join('; '), /requires attach/)
})

test('validator rejects: malformed attach (empty/missing bone, bad offset)', () => {
  const attaches = [
    { bone: '', offset: [0, 0.05, 0] },
    { bone: 'rightHand' },
    { bone: 'rightHand', offset: [0, 0.05] },
    { bone: 'rightHand', offset: [0, '0.05', 0] },
    { bone: 'rightHand', offset: [0, 0.05, NaN] },
    { bone: 7, offset: [0, 0.05, 0] },
    'rightHand',
  ]
  for (const attach of attaches) {
    const bad = pickupBase()
    bad.objects[0].interactions[0].attach = attach
    const { manifest, errors } = parseSceneManifest(bad)
    assert.equal(manifest, null, JSON.stringify(attach))
    assert.match(errors.join('; '), /attach/)
  }
})

test('authored tai-loft.json carries the cup with pickup/putdown interactions', async () => {
  const { manifest, errors } = parseSceneManifest(await readAuthoredManifest())
  assert.equal(errors.length, 0, JSON.stringify(errors))
  const cup = manifest.objects.find((o) => o.id === 'cup')
  assert.ok(cup, 'cup object must be authored')
  assert.deepEqual(cup.position, [0.2, 0.4, 0.92])
  const pickup = cup.interactions.find((i) => i.id === 'pickup')
  assert.equal(pickup.kind, 'pickup')
  assert.deepEqual(pickup.attach, { bone: 'rightHand', offset: [0, 0.05, 0] })
  assert.equal(pickup.prompt, 'a person picks up a cup from the table')
  assert.ok(cup.interactions.some((i) => i.id === 'putdown'), 'putdown interaction authored')
})

// ── RoomNavigation consumes the manifest (byte-equivalent) ─────────

/** The PRE-manifest hardcoded construction from TaiRoomScene.ts (deleted). */
function legacyNavigation() {
  const nav = new RoomNavigation({ minX: -3.65, maxX: 3.65, minZ: -3.65, maxZ: 3.65 }, 0.22)
  // Former obstacle() helper calls (full size + padding default 0.1).
  nav.addBoxObstacle('couch', new Vector3(0, 0, 2.28), new Vector3(2.85, 0.7, 1), 0.1)
  nav.addBoxObstacle('coffee-table', new Vector3(0, 0, 1.15), new Vector3(1.45, 0.35, 0.82), 0.1)
  nav.addBoxObstacle('command-zone', new Vector3(-3.5, 0, -1.35), new Vector3(0.7, 0.8, 2.95), 0.1)
  nav.addBoxObstacle('kitchen', new Vector3(2.18, 0, -3.48), new Vector3(1.82, 0.6, 0.7), 0.1)
  nav.addBoxObstacle('daybed', new Vector3(2.75, 0, 1.9), new Vector3(1.75, 0.45, 1.25), 0.1)
  return nav
}

test('fromManifest is byte-equivalent to the legacy hardcoded navigation', async () => {
  const { manifest } = parseSceneManifest(await readAuthoredManifest())
  assert.ok(manifest)
  const fromManifest = RoomNavigation.fromManifest(manifest, 0.22)
  const legacy = legacyNavigation()

  // Same obstacle geometry (centers/halfSizes/paddings, order preserved).
  const shape = (nav) => nav.listObstacles().map((o) => ({
    id: o.id,
    center: [o.center.x, o.center.z],
    halfSize: [o.halfSize.x, o.halfSize.z],
    padding: o.padding,
  }))
  assert.deepEqual(shape(fromManifest), shape(legacy))

  // Same collision everywhere: sweep constrainMovement over a grid of
  // from/to pairs crossing obstacles and the room boundary.
  const probePoints = []
  for (let x = -3.9; x <= 3.9; x += 0.6) {
    for (let z = -3.9; z <= 3.9; z += 0.6) {
      probePoints.push(new Vector3(x, 0, z))
    }
  }
  for (const from of probePoints) {
    for (const to of probePoints) {
      const a = fromManifest.constrainMovement(from, to)
      const b = legacy.constrainMovement(from, to)
      assert.equal(a.position.x, b.position.x, `x ${from.x},${from.z} -> ${to.x},${to.z}`)
      assert.equal(a.position.z, b.position.z, `z ${from.x},${from.z} -> ${to.x},${to.z}`)
      assert.equal(a.hit, b.hit)
      assert.equal(a.obstacleId, b.obstacleId)
    }
  }

  // Same route planning for a set of goals (walks, wall approaches, around furniture).
  const routes = [
    [0, 0.15, 0, 2.0],
    [0, 0.15, 2.5, 2.0],
    [-1, 0.15, -3.5, -1.35],
    [0, 0.15, 3.0, -3.0],
    [2.5, 0.15, 3.0, 2.0],
    [0, 0.15, -2.9, -0.35],
  ]
  for (const [sx, sz, gx, gz] of routes) {
    const start = new Vector3(sx, 0, sz)
    const goal = new Vector3(gx, 0, gz)
    const a = fromManifest.planRoute(start, goal)
    const b = legacy.planRoute(start, goal)
    assert.equal(a.length, b.length, `route len ${sx},${sz} -> ${gx},${gz}`)
    for (let i = 0; i < a.length; i += 1) {
      assert.equal(a[i].x, b[i].x, `route ${i} x`)
      assert.equal(a[i].z, b[i].z, `route ${i} z`)
    }
  }
})

test('labelForBlockerId resolves manifest labels and the boundary', async () => {
  const { manifest } = parseSceneManifest(await readAuthoredManifest())
  assert.ok(manifest)
  const nav = RoomNavigation.fromManifest(manifest, 0.22)
  assert.equal(nav.labelForBlockerId('coffee-table'), 'coffee table')
  assert.equal(nav.labelForBlockerId('couch'), 'the couch')
  assert.equal(nav.labelForBlockerId('daybed'), 'the daybed')
  assert.equal(nav.labelForBlockerId('room_boundary'), 'the wall')
  assert.equal(nav.labelForBlockerId('unknown-thing'), 'unknown-thing')
  // The boundary id surfaces from constrainMovement with the manifest id.
  const hit = nav.constrainMovement(new Vector3(0, 0, 3.5), new Vector3(0, 0, 4.5))
  assert.equal(hit.hit, true)
  assert.equal(hit.obstacleId, 'room_boundary')
  assert.equal(nav.labelForBlockerId(hit.obstacleId), 'the wall')
})

// ── loadSceneManifest (fail-closed mount) ──────────────────────────

test('loadSceneManifest resolves a valid served manifest', async () => {
  const raw = await readAuthoredManifest()
  const okFetch = async () => ({ ok: true, status: 200, json: async () => raw })
  const manifest = await loadSceneManifest('/api/hyrax/3d/rooms/tai-loft.json', okFetch)
  assert.equal(manifest.room_id, 'tai-loft')
  assert.equal(manifest.obstacles.length, 5)
})

test('loadSceneManifest fails closed: HTTP error → default empty room + warning', async () => {
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    const badStatus = async () => ({ ok: false, status: 404, json: async () => ({}) })
    const manifest = await loadSceneManifest('/api/hyrax/3d/rooms/tai-loft.json', badStatus)
    assert.equal(manifest, DEFAULT_SCENE_MANIFEST)
    assert.equal(manifest.obstacles.length, 0)
    assert.ok(warnings.some((w) => w.includes('falling back')), warnings.join(' | '))
  } finally {
    console.warn = originalWarn
  }
})

test('loadSceneManifest fails closed: network failure → default empty room + warning', async () => {
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    const brokenFetch = async () => { throw new Error('ECONNREFUSED') }
    const manifest = await loadSceneManifest('/api/hyrax/3d/rooms/tai-loft.json', brokenFetch)
    assert.equal(manifest, DEFAULT_SCENE_MANIFEST)
    assert.ok(warnings.some((w) => w.includes('ECONNREFUSED')), warnings.join(' | '))
  } finally {
    console.warn = originalWarn
  }
})

test('loadSceneManifest fails closed: malformed JSON → default empty room + warning', async () => {
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    const malformedFetch = async () => ({ ok: true, status: 200, json: async () => ({ manifest_version: '9.9', room_id: 'x' }) })
    const manifest = await loadSceneManifest('/api/hyrax/3d/rooms/tai-loft.json', malformedFetch)
    assert.equal(manifest, DEFAULT_SCENE_MANIFEST)
    assert.ok(warnings.some((w) => w.includes('invalid manifest')), warnings.join(' | '))
  } finally {
    console.warn = originalWarn
  }
})

// ── stateful interactables (spatial layer 5, INTERACTABLES_SPEC.md) ─

function doorBase() {
  return {
    ...validBase(),
    objects: [
      {
        id: 'door_01',
        label: 'the loft door',
        position: [-2.4, 1.2, -3.9],
        state: 'closed',
        states: {
          closed: { obstacle: true, mesh_rotation: [0, 0, 0] },
          open: { obstacle: false, mesh_rotation: [0, -1.57, 0] },
        },
        obstacle: { center: [-2.4, -3.5], halfSize: [0.42, 0.25], padding: 0.1 },
        interactions: [
          { id: 'open', kind: 'use', spot: [-2.6, -3.1], facingDeg: 180, prompt: 'a person opens a door', requires: 'closed', sets: 'open' },
          { id: 'close', kind: 'use', spot: [-2.6, -3.1], facingDeg: 180, prompt: 'a person closes a door', requires: 'open', sets: 'closed' },
        ],
      },
    ],
  }
}

test('validator accepts: door_01 state machine with requires/sets and obstacle', () => {
  const { manifest, errors } = parseSceneManifest(doorBase())
  assert.equal(errors.length, 0, JSON.stringify(errors))
  assert.ok(manifest)
  const door = manifest.objects[0]
  assert.equal(door.state, 'closed')
  assert.deepEqual(door.states.closed, { obstacle: true, mesh_rotation: [0, 0, 0] })
  assert.deepEqual(door.states.open, { obstacle: false, mesh_rotation: [0, -1.57, 0] })
  assert.equal(door.interactions[0].requires, 'closed')
  assert.equal(door.interactions[0].sets, 'open')
  assert.deepEqual(door.obstacle, { center: [-2.4, -3.5], halfSize: [0.42, 0.25], padding: 0.1 })
})

test('authored tai-loft.json carries door_01 with the open/closed machine', async () => {
  const { manifest, errors } = parseSceneManifest(await readAuthoredManifest())
  assert.equal(errors.length, 0, JSON.stringify(errors))
  const door = manifest.objects.find((o) => o.id === 'door_01')
  assert.ok(door, 'door_01 object must be authored')
  assert.equal(door.state, 'closed')
  assert.deepEqual(Object.keys(door.states), ['closed', 'open'])
  assert.equal(door.interactions.find((i) => i.id === 'open').requires, 'closed')
  assert.equal(door.interactions.find((i) => i.id === 'open').sets, 'open')
  assert.equal(door.interactions.find((i) => i.id === 'close').requires, 'open')
  assert.equal(door.interactions.find((i) => i.id === 'close').sets, 'closed')
  assert.deepEqual(door.obstacle, { center: [-2.4, -3.5], halfSize: [0.42, 0.25], padding: 0.1 })
})

test('validator rejects: requires/sets referencing an undeclared state', () => {
  for (const field of ['requires', 'sets']) {
    for (const value of ['ajar', 'shut', '']) {
      const bad = doorBase()
      bad.objects[0].interactions[0][field] = value
      const { manifest, errors } = parseSceneManifest(bad)
      assert.equal(manifest, null, `${field}=${JSON.stringify(value)}`)
      assert.match(errors.join('; '), /requires|sets|state/)
    }
  }
})

test('validator rejects: state not declared in states / machine without initial state', () => {
  const badState = doorBase()
  badState.objects[0].state = 'ajar'
  let { manifest, errors } = parseSceneManifest(badState)
  assert.equal(manifest, null)
  assert.match(errors.join('; '), /state "ajar" is not declared/)

  const noInitial = doorBase()
  delete noInitial.objects[0].state
  ;({ manifest, errors } = parseSceneManifest(noInitial))
  assert.equal(manifest, null)
  assert.match(errors.join('; '), /state is required/)
})

test('validator rejects: state/requires/sets/obstacle without a state machine', () => {
  const base = validBase()
  const noMachine = doorBase()
  delete noMachine.objects[0].states
  let { manifest, errors } = parseSceneManifest(noMachine)
  assert.equal(manifest, null)
  assert.match(errors.join('; '), /state machine/)

  const stateOnly = validBase()
  stateOnly.objects[0].state = 'closed'
  ;({ manifest, errors } = parseSceneManifest(stateOnly))
  assert.equal(manifest, null)
  assert.match(errors.join('; '), /state machine/)

  const gateOnly = validBase()
  gateOnly.objects[0].interactions[0].requires = 'closed'
  ;({ manifest, errors } = parseSceneManifest(gateOnly))
  assert.equal(manifest, null)
  assert.match(errors.join('; '), /state machine/)

  const obstacleOnly = validBase()
  obstacleOnly.objects[0].obstacle = { center: [0, 0], halfSize: [1, 1], padding: 0.1 }
  ;({ manifest, errors } = parseSceneManifest(obstacleOnly))
  assert.equal(manifest, null)
  assert.match(errors.join('; '), /state machine/)
})

test('validator rejects: malformed states entries and obstacle geometry', () => {
  const badStates = [
    { closed: { obstacle: true } }, // missing mesh_rotation
    { closed: { obstacle: 'yes', mesh_rotation: [0, 0, 0] } },
    { closed: { obstacle: true, mesh_rotation: [0, 0] } },
    { closed: { obstacle: true, mesh_rotation: [0, 0, 'x'] } },
  ]
  for (const states of badStates) {
    const bad = doorBase()
    bad.objects[0].states = states
    const { manifest, errors } = parseSceneManifest(bad)
    assert.equal(manifest, null, JSON.stringify(states))
    assert.match(errors.join('; '), /mesh_rotation|obstacle/)
  }
  for (const obstacle of [
    { center: [0], halfSize: [1, 1], padding: 0.1 },
    { center: [0, 0], halfSize: [-1, 1], padding: 0.1 },
    { center: [0, 0], halfSize: [1, 1], padding: -0.1 },
    { center: [0, 0], halfSize: [1, 1] },
    'nope',
  ]) {
    const bad = doorBase()
    bad.objects[0].obstacle = obstacle
    const { manifest, errors } = parseSceneManifest(bad)
    assert.equal(manifest, null, JSON.stringify(obstacle))
    assert.match(errors.join('; '), /obstacle/)
  }
})

// ── InteractableStateMachine (state truth + journaled transitions) ─

test('state machine: initial states, applySets transitions, journaled', () => {
  const { manifest } = parseSceneManifest(doorBase())
  assert.ok(manifest)
  const machine = new InteractableStateMachine(manifest, () => 1234)
  const door = manifest.objects[0]

  assert.equal(machine.stateOf('door_01'), 'closed')
  assert.equal(machine.stateOf('desk'), null) // no machine → no state

  const open = door.interactions.find((i) => i.id === 'open')
  const transition = machine.applySets(door, open)
  assert.deepEqual(transition, { from: 'closed', to: 'open' })
  assert.equal(machine.stateOf('door_01'), 'open')
  assert.deepEqual(machine.journal(), [
    { t: 1234, objectId: 'door_01', from: 'closed', to: 'open', interaction: 'open' },
  ])

  // No-op when already in the target state (close requires open, sets closed).
  const close = door.interactions.find((i) => i.id === 'close')
  assert.equal(machine.applySets(door, close) === null, false)
  assert.equal(machine.stateOf('door_01'), 'closed')
  assert.equal(machine.journal().length, 2)
})

test('state machine: applySets is fail-closed (no sets / unknown target / no machine)', () => {
  const { manifest } = parseSceneManifest(doorBase())
  assert.ok(manifest)
  const machine = new InteractableStateMachine(manifest, () => 0)
  const door = manifest.objects[0]
  // A stateless object (not in this fixture — literal shape of the desk).
  const desk = { id: 'desk', label: 'her desk', position: [-3.83, 1.38, -1.35] }

  // Interaction without `sets` → null.
  assert.equal(machine.applySets(door, { id: 'look', kind: 'use', spot: [0, 0], facingDeg: 0, prompt: 'looks' }), null)
  // Unknown target state → null (defense-in-depth; validator rejects at load).
  assert.equal(machine.applySets(door, { id: 'x', kind: 'use', spot: [0, 0], facingDeg: 0, prompt: 'x', sets: 'ajar' }), null)
  // Object with no machine → null.
  assert.equal(machine.applySets(desk, { id: 'work', kind: 'sit', spot: [0, 0], facingDeg: 0, prompt: 'work', sets: 'done' }), null)
  assert.equal(machine.journal().length, 0)
})

test('RoomNavigation: stateful obstacle toggles route clearance (blocked closed → clear open)', () => {
  const { manifest } = parseSceneManifest(doorBase())
  assert.ok(manifest)
  const nav = RoomNavigation.fromManifest(manifest, 0.22)
  // door_01's object-declared obstacle (registered by the scene at load —
  // same addBoxObstacle math: halfSize*2 full size, authored padding).
  const door = manifest.objects.find((o) => o.id === 'door_01')
  nav.addBoxObstacle(
    door.id,
    new Vector3(door.obstacle.center[0], 0, door.obstacle.center[1]),
    new Vector3(door.obstacle.halfSize[0] * 2, 1, door.obstacle.halfSize[1] * 2),
    door.obstacle.padding,
  )
  // The doorway route: from the room's right-center to the back-left
  // doorway corner — crosses ONLY the door's AABB (the authored manifest
  // carries the cup + door; this fixture isolates the door).
  const start = new Vector3(1.5, 0, -1.5)
  const doorway = new Vector3(-2.3, 0, -3.4)

  assert.equal(nav.setObstacleEnabled('door_01', true), true, 'obstacle exists')
  assert.equal(nav.isRouteClear(start, [doorway]), false, 'closed: doorway route blocked')
  const obstacle = nav.listObstacles().find((o) => o.id === 'door_01')
  assert.equal(obstacle.enabled, true)

  assert.equal(nav.setObstacleEnabled('door_01', false), true)
  assert.equal(nav.isRouteClear(start, [doorway]), true, 'open: doorway route clear')
  assert.equal(nav.listObstacles().find((o) => o.id === 'door_01').enabled, false)
  // Disabled obstacles are skipped by movement constraints too.
  const probe = nav.constrainMovement(new Vector3(-2.3, 0, -3.5), new Vector3(-2.3, 0, -3.2))
  assert.equal(probe.hit, false, 'open door does not absorb movement')

  assert.equal(nav.setObstacleEnabled('no-such-obstacle', false), false)
})
