/**
 * Fleet loft config tests (card t_ee790be9 — the loft is the fleet's
 * living room).
 *
 *  - parseFleetConfig: valid placement config parses; per-operator
 *    FAIL-CLOSED (a broken entry is dropped with the reason, the rest of
 *    the fleet still mounts); malformed top level → empty fleet.
 *  - rooms/fleet-loft.json (the production placement config) validates —
 *    every operator has a base/fallback asset URL and its expression
 *    tokens all resolve to asset URLs (no client-side guessing).
 *  - loadFleetConfig: success path + fail-closed default + warning.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  EMPTY_FLEET_CONFIG,
  loadFleetConfig,
  parseFleetConfig,
} from '../src/embodiment/fleet/fleetConfig.ts'

const fixture = {
  version: 1,
  room: 'tai-loft.json',
  operators: [
    {
      id: 'rei',
      label: 'Rei',
      role: 'QA',
      position: [-2.35, 0, 2.55],
      height: 1.5,
      base: '/api/hyrax/assets/rei.portrait.neutral',
      fallback: '/api/hyrax/assets/rei.chibi.stand',
      expressions: { calm: '/api/hyrax/assets/rei.portrait.calm' },
    },
    {
      id: 'aya',
      label: 'Aya',
      role: 'Director',
      position: [1.05, 0, -2.85],
      height: 1.5,
      base: '/api/hyrax/assets/aya.portrait.neutral',
      fallback: '/api/hyrax/assets/aya.chibi.stand',
      expressions: { joy: '/api/hyrax/assets/aya.portrait.joy' },
    },
  ],
}

test('a valid fleet config parses completely', () => {
  const { config, errors } = parseFleetConfig(fixture)
  assert.deepEqual(errors, [])
  assert.equal(config.version, 1)
  assert.equal(config.room, 'tai-loft.json')
  assert.equal(config.operators.length, 2)
  assert.deepEqual(config.operators[0].position, [-2.35, 0, 2.55])
  assert.equal(config.operators[0].expressions.calm, '/api/hyrax/assets/rei.portrait.calm')
})

test('per-operator FAIL-CLOSED: a broken entry is dropped, the fleet survives', () => {
  const raw = {
    version: 1,
    room: 'tai-loft.json',
    operators: [
      fixture.operators[0],
      { ...fixture.operators[1], position: ['north', 0, 0] }, // malformed
      { ...fixture.operators[1], id: 'nei', expressions: { thinking: 42 } }, // malformed expression
    ],
  }
  const { config, errors } = parseFleetConfig(raw)
  assert.equal(config.operators.length, 1, 'only the valid operator survives')
  assert.equal(config.operators[0].id, 'rei')
  assert(errors.some((e) => e.includes('position')), 'position error named')
  assert(errors.some((e) => e.includes('expressions')), 'expression error named')
})

test('duplicate operator ids are dropped with a reason', () => {
  const raw = { ...fixture, operators: [fixture.operators[0], fixture.operators[0]] }
  const { config, errors } = parseFleetConfig(raw)
  assert.equal(config.operators.length, 1)
  assert(errors.some((e) => e.includes('duplicated')), 'duplicate named')
})

test('malformed top level fails closed to the empty fleet', () => {
  for (const raw of [null, 'nope', { version: 2, room: 'x', operators: [] }, { version: 1, room: '', operators: 'x' }]) {
    const { config, errors } = parseFleetConfig(raw)
    assert.equal(config.operators.length, 0, `empty fleet for ${JSON.stringify(raw)}`)
    assert(errors.length > 0, 'reason recorded')
  }
})

test('production rooms/fleet-loft.json validates and covers the sister set', async () => {
  const source = await readFile(
    new URL('../rooms/fleet-loft.json', import.meta.url),
    'utf8',
  )
  const { config, errors } = parseFleetConfig(JSON.parse(source))
  assert.deepEqual(errors, [], 'production fleet config has no issues')
  const ids = config.operators.map((o) => o.id).sort()
  assert.deepEqual(ids, ['aya', 'mai', 'nei', 'rei'], 'sisters + aya, no tai (VRM)')
  for (const op of config.operators) {
    assert.match(op.base, /^\/api\/hyrax\/assets\//, `${op.id} base is an asset URL`)
    assert.match(op.fallback, /^\/api\/hyrax\/assets\//, `${op.id} fallback is an asset URL`)
    for (const [token, url] of Object.entries(op.expressions)) {
      assert.equal(typeof token, 'string')
      assert.match(url, /^\/api\/hyrax\/assets\//, `${op.id}.expressions.${token} is an asset URL`)
    }
    assert(op.height > 0, `${op.id} height positive`)
  }
})

test('loadFleetConfig: success path resolves the parsed config', async () => {
  const fetcher = async () => ({ ok: true, json: async () => fixture })
  const config = await loadFleetConfig('/test/fleet-loft.json', fetcher)
  assert.equal(config.operators.length, 2)
})

test('loadFleetConfig: failure resolves fail-closed to the empty fleet', async () => {
  for (const fetcher of [
    async () => ({ ok: false, json: async () => ({}) }),
    async () => { throw new Error('network down') },
    async () => ({ ok: true, json: async () => ({ nope: true }) }),
  ]) {
    const config = await loadFleetConfig('/test/fleet-loft.json', fetcher)
    assert.deepEqual(config, EMPTY_FLEET_CONFIG, 'fail-closed empty fleet')
    assert.equal(config.operators.length, 0)
  }
})
