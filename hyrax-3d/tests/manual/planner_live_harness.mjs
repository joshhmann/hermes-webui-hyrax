// Scripted live sanity (NO browser): real ARDY ws stream through
// ArdyMotionSource (gestalt path, fake rig/vrm — the unit-test pattern),
// real RoomNavigation + manifest, real GoalPlanner. setGoal desk.work from
// spawn (0, 0.15) — the GEVS scenario. Asserts via planner telemetry:
// turn → walk → arrive/interact, arrival ≤0.35 m at interact, the manifest
// work prompt in the prompt log, no watchdog holds, no blocked failure.
import { ArdyClient } from 'gestalt-motion/ArdyClient.ts'
import { ChunkBuffer } from 'gestalt-motion/ChunkBuffer.ts'
import { CSKEL27_SOURCE_JOINT_NAMES, CSKEL27_BUILTIN_MAP } from 'gestalt-motion/adapters/cskel27.ts'
import { SEMANTIC_V1 } from 'gestalt-motion/semanticV1.ts'

import { ArdyMotionSource } from '../../src/embodiment/motion/ArdyMotionSource.ts'
import { GoalPlanner } from '../../src/embodiment/planning/GoalPlanner.ts'
import { RoomNavigation } from '../../src/embodiment/navigation/RoomNavigation.ts'
import { parseSceneManifest } from '../../src/embodiment/room/sceneManifest.ts'
import { readFileSync } from 'node:fs'

const WS_URL = process.env.ARDY_URL ?? 'ws://192.168.0.17:8791/ws'
const TIMEOUT_S = Number(process.env.GOAL_TIMEOUT_S ?? 180)

const { manifest, errors } = parseSceneManifest(
  JSON.parse(readFileSync(new URL('../../rooms/tai-loft.json', import.meta.url), 'utf8')),
)
if (!manifest) { console.error('manifest failed:', errors); process.exit(2) }
const navigation = RoomNavigation.fromManifest(manifest, 0.22)

function fakeNode(y = 0) {
  return {
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
    position: { x: 0, y, z: 0 },
    getWorldQuaternion(t) { t.x = this.quaternion.x; t.y = this.quaternion.y; t.z = this.quaternion.z; t.w = this.quaternion.w; return t },
    getWorldPosition(t) { t.x = this.position.x; t.y = this.position.y; t.z = this.position.z; return t },
  }
}
const nodes = new Map()
for (const [semantic, sourceName] of Object.entries(CSKEL27_BUILTIN_MAP)) {
  if (sourceName === null || SEMANTIC_V1[semantic].optional) continue
  nodes.set(semantic, fakeNode(semantic === 'hips' ? 0.95 : 0.5))
}
const vrm = { humanoid: { getNormalizedBoneNode: (n) => nodes.get(n) ?? null }, scene: fakeNode(0), meta: { metaVersion: '1.0' } }

const rig = {
  vrm,
  scene: { position: { x: 0, z: 0.15 }, rotation: { y: 0 } },
  setRootPosition(x, z) { this.scene.position.x = x; this.scene.position.z = z },
  setFacingYaw(yaw) { this.scene.rotation.y = yaw },
  markPoseWrite() {},
}

const source = new ArdyMotionSource({
  rig,
  navigation,
  url: WS_URL,
  vrmLikeFactory: () => ({
    humanoid: vrm.humanoid,
    scene: vrm.scene,
  }),
  profileFetcher: () => Promise.resolve(null), // gestalt path
})
// Wrap the real client in the structural subset the source expects (it IS one).
const planner = new GoalPlanner({
  navigation,
  manifest,
  channel: source,
  probe: () => ({ x: rig.scene.position.x, z: rig.scene.position.z, yaw: rig.scene.rotation.y }),
})

const t0 = Date.now()
const elapsed = () => (Date.now() - t0) / 1000
let lastKey = ''
const phases = []
let arrivalAtInteract = null
let watchdogHolds = 0

console.log('[harness] connecting', WS_URL)
const ok = planner.setGoal('desk.work', 'debug')
console.log('[harness] setGoal desk.work →', ok)

const TICK_MS = 33
const timer = setInterval(() => {
  source.update(TICK_MS / 1000)
  planner.update(TICK_MS / 1000)
  const tel = planner.getTelemetry()
  const stel = source.getTelemetry()
  if (stel.gate.hold) watchdogHolds += 1
  if (tel.phase !== null && !phases.includes(tel.phase)) phases.push(tel.phase)
  if (tel.phase === 'interact' && arrivalAtInteract === null) arrivalAtInteract = tel.distanceToSpot
  const key = `${tel.phase}|${(tel.promptLog || []).length}`
  if (key !== lastKey) {
    lastKey = key
    const tail = tel.promptLog[tel.promptLog.length - 1]
    console.log(
      `t=${elapsed().toFixed(1).padStart(6)} st=${stel.state.padEnd(9)} ph=${String(tel.phase).padEnd(9)} ` +
      `d=${tel.distanceToSpot} ferr=${tel.facingErrDeg} replans=${tel.replans} ` +
      `pos=(${rig.scene.position.x.toFixed(2)}, ${rig.scene.position.z.toFixed(2)}) ` +
      `${tail ? tail.kind + ':' + tail.prompt.slice(0, 48) : ''}`,
    )
  }
  if (tel.goal === null && elapsed() > 2) {
    clearInterval(timer)
    finish(tel, stel)
  } else if (elapsed() > TIMEOUT_S) {
    clearInterval(timer)
    console.log('[harness] TIMEOUT with goal still active')
    finish(tel, stel, true)
  }
}, TICK_MS)

function finish(tel, stel, timedOut = false) {
  const log = tel.promptLog.map((e) => `${e.kind}:${e.prompt}`)
  const results = {
    phases_seen_turn_walk: phases.includes('turn') && phases.includes('walk'),
    reached_interact: phases.includes('interact'),
    arrival_le_035: arrivalAtInteract !== null && arrivalAtInteract <= 0.35,
    arrival_value_m: arrivalAtInteract,
    work_prompt_in_log: log.some((l) => l.includes('sits at a desk working')),
    no_blocked_failure: tel.lastFailure === null || !tel.lastFailure.includes('blocked'),
    no_watchdog_holds: watchdogHolds === 0,
    stream_live_at_end: stel.state === 'live' || stel.state === 'stale',
    no_residual_resets: stel.residualResetCount === 0,
    not_timed_out: !timedOut,
  }
  console.log('\n[harness] lastFailure:', tel.lastFailure, '| state:', stel.state,
    '| residualResets:', stel.residualResetCount, '| reconnects:', stel.reconnectCount)
  console.log('[harness] prompt log:')
  for (const l of log) console.log('   ', l)
  console.log('\n── results ──')
  let pass = true
  for (const [k, v] of Object.entries(results)) {
    if (typeof v === 'boolean') {
      console.log(`  ${v ? 'PASS' : 'FAIL'}  ${k}`)
      pass = pass && v
    } else {
      console.log(`  info  ${k} = ${v}`)
    }
  }
  console.log(`VERDICT: ${pass ? 'PASS' : 'FAIL'}`)
  source.dispose()
  process.exit(pass ? 0 : 1)
}
