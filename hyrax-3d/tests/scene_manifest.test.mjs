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
    manifest_version: '1.0',
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
  for (const version of ['2.0', '1.1', 1, null]) {
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
