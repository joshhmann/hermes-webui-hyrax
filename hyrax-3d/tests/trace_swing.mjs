import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Vector3 } from 'three'
import { GoalPlanner } from '../src/embodiment/planning/GoalPlanner.ts'
import { RoomNavigation } from '../src/embodiment/navigation/RoomNavigation.ts'
import { parseSceneManifest } from '../src/embodiment/room/sceneManifest.ts'
const packageRoot = fileURLToPath(new URL('.', import.meta.url))
const raw = await readFile(join(packageRoot, '../rooms/tai-loft.json'), 'utf8')
const { manifest } = parseSceneManifest(JSON.parse(raw))
const navigation = RoomNavigation.fromManifest(manifest, 0.22)
function wrapAngle(a) { let r = a % (2 * Math.PI); if (r <= -Math.PI) r += 2 * Math.PI; else if (r > Math.PI) r -= 2 * Math.PI; return r }
const channel = { prompts: [], reflexActive: false, watchdogHolding: false, userPromptAtMs: -Infinity,
  sendPlannerPrompt(t) { this.prompts.push(t) }, isReflexActive() { return this.reflexActive },
  isWatchdogHolding() { return this.watchdogHolding }, lastUserPromptAtMs() { return this.userPromptAtMs } }
const bounds = { minX: -3.65, maxX: 3.65, minZ: -3.65, maxZ: 3.65 }
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const sim = { x: 0, z: 0.15, yaw: 0, walking: false, turnTarget: null, speed: 0.6,
  turnRateDegS: 120, driftDegS: 0, coastS: 1.2, coastLeft: 0,
  swingDeg: 90, swingS: 2, swingDelayS: 0.8, swingAt: null, turnSwingBase: 0, simS: 0,
  step(dt) {
    this.simS += dt
    if (this.turnTarget !== null) {
      this.swingAt = null
      const err = wrapAngle(this.turnTarget - this.yaw)
      const maxStep = (this.turnRateDegS * dt * Math.PI) / 180
      if (Math.abs(err) <= maxStep) { this.yaw = this.turnTarget; this.turnTarget = null
        if (this.swingDeg > 0) { this.turnSwingBase = this.yaw; this.swingAt = this.simS + this.swingDelayS } }
      else this.yaw += Math.sign(err) * maxStep
    }
    if (this.swingAt !== null) {
      const u = Math.max(0, Math.min(1, (this.simS - this.swingAt) / this.swingS))
      this.yaw = this.turnSwingBase + (this.swingDeg * Math.PI / 180) * Math.sin(Math.PI * u) * (1 - u)
      if (u >= 1) this.swingAt = null
    }
    if ((this.walking || this.coastLeft > 0) && this.turnTarget === null) {
      if (!this.walking) this.coastLeft = Math.max(0, this.coastLeft - dt)
      this.x = clamp(this.x + Math.sin(this.yaw) * this.speed * dt, bounds.minX, bounds.maxX)
      this.z = clamp(this.z + Math.cos(this.yaw) * this.speed * dt, bounds.minZ, bounds.maxZ)
      this.yaw += (this.driftDegS * dt * Math.PI) / 180
    }
  } }
const clock = { ms: 0 }
const planner = new GoalPlanner({ navigation, manifest, channel,
  probe: () => ({ x: sim.x, z: sim.z, yaw: sim.yaw }), nowMs: () => clock.ms, random: () => 0,
  essenceState: () => null, policy: { TURN_SETTLE_S: 1.0, YAW_EMA_TAU_S: 0.25 } })
planner.setGoal('desk.work')
let lastLogLen = 0
for (let tick = 0; tick < 30000; tick++) {
  planner.update(0.1)
  const tel = planner.getTelemetry()
  const log = tel.promptLog
  for (let i = lastLogLen; i < log.length; i++) {
    const e = log[i]
    if (e.kind === 'walk') { sim.walking = true; sim.turnTarget = null }
    else if (e.kind === 'arrive' || e.kind === 'interact') { if (sim.walking) sim.coastLeft = sim.coastS; sim.walking = false; sim.turnTarget = null }
    else if (e.kind === 'turn') { sim.walking = false
      const deg = /(\d+)\s*degrees/.exec(e.prompt); const dir = /left/.test(e.prompt) ? 1 : -1
      sim.turnTarget = sim.yaw + (dir * (deg ? Number(deg[1]) : 45) * Math.PI) / 180 }
  }
  lastLogLen = log.length
  sim.step(0.1)
  clock.ms += 100
  if ((tick % 20) === 0 && tel.goal) {
    const p = tel.promptLog[tel.promptLog.length - 1]
    console.log(`t=${(clock.ms/1000).toFixed(1)} phase=${tel.phase} x=${sim.x.toFixed(2)} z=${sim.z.toFixed(2)} yaw=${(sim.yaw*180/Math.PI).toFixed(0)} dist=${tel.distanceToSpot} last=${p?.kind}:${String(p?.prompt).slice(0,40)}`)
  }
  if (tel.goal === null && tick > 2) break
}
console.log('RESULT goal:', planner.getTelemetry().goal, 'failure:', planner.getTelemetry().lastFailure)
