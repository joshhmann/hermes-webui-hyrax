/**
 * Goal planner tests — intents to motion sequences (spatial layer 3b).
 *
 * Spec: docs/gestalt-vn/specs/GOAL_PLANNER_SPEC.md
 *
 *  - A* over the existing nav grid: obstacle-aware paths from the authored
 *    manifest; waypoint-following never cuts through obstacle AABBs.
 *  - setGoal desk.work from across the room → she turns, walks, arrives
 *    ≤0.35 m, faces the desk, plays the work prompt; telemetry + prompt log
 *    prove each phase (against a deterministic fake stream that honors
 *    turn/walk prompts like the real one does — the planner re-anchors on
 *    the ACTUAL probe every segment).
 *  - Prompt variants: a 30s+ walk uses ≥2 DISTINCT walk prompts (rotation,
 *    seeded by goal id).
 *  - Priority extends the reflex layer exactly: user prompt cancels the
 *    goal; an active reflex blocks planner sends and the goal resumes after
 *    the reaction clears; a watchdog hold suspends (no sends, timers
 *    frozen) and the goal completes after recovery.
 *  - Blocked path: one replan, then fail with a journaled reason (never an
 *    infinite walk-into-wall).
 *  - Ambient idle driver: after AMBIENT_AFTER_S of no prompt activity it
 *    picks a weighted deck goal (cooldowns honored, unknown goals skipped
 *    fail-closed) and the planner executes it.
 *
 * Pure-logic: real manifest + real RoomNavigation, fake prompt channel and
 * a fake root probe driven by the planner's own prompt journal — no DOM, no
 * WebSocket.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { Vector3 } from 'three'

import { GoalPlanner, GOAL_PLANNER } from '../src/embodiment/planning/GoalPlanner.ts'
import { RoomNavigation } from '../src/embodiment/navigation/RoomNavigation.ts'
import { parseSceneManifest } from '../src/embodiment/room/sceneManifest.ts'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const LOFT_ACTOR_RADIUS = 0.22

async function loadManifest() {
  const raw = await readFile(join(packageRoot, 'rooms/tai-loft.json'), 'utf8')
  const { manifest, errors } = parseSceneManifest(JSON.parse(raw))
  assert.ok(manifest, `manifest must parse: ${errors.join('; ')}`)
  return manifest
}

function makeNavigation(manifest) {
  return RoomNavigation.fromManifest(manifest, LOFT_ACTOR_RADIUS)
}

// ── fakes ─────────────────────────────────────────────────────────

function makeChannel() {
  return {
    prompts: [],
    reflexActive: false,
    watchdogHolding: false,
    userPromptAtMs: -Infinity,
    sendPlannerPrompt(text) {
      this.prompts.push(text)
    },
    isReflexActive() {
      return this.reflexActive
    },
    isWatchdogHolding() {
      return this.watchdogHolding
    },
    lastUserPromptAtMs() {
      return this.userPromptAtMs
    },
  }
}

function wrapAngle(a) {
  let r = a % (2 * Math.PI)
  if (r <= -Math.PI) r += 2 * Math.PI
  else if (r > Math.PI) r -= 2 * Math.PI
  return r
}

/**
 * Fake stream body: honors the planner's prompts like the live service does
 * (relative turns, sustained walking while a walk prompt plays), with
 * deterministic speed/turn-rate. The planner never dead-reckons — it probes
 * this state every tick, exactly like the real rig probe. Position is
 * clamped to the room bounds like the real RoomNavigationApproval does, so
 * overshoot during a reflex pinches at the wall instead of walking to
 * infinity. Optional `driftDegS` models the live stream's stochastic
 * heading (T1) — the steering-under-test. Optional `coastS` models the
 * stop-prompt latency: walking continues for that many seconds after an
 * arrive/interact prompt arrives (prompt → service reset → new stream →
 * stop-move settle — measured ~1-2 s live), the arrival-overshoot case.
 */
function makeSim(x, z, yaw, opts = {}) {
  const bounds = opts.bounds ?? { minX: -3.65, maxX: 3.65, minZ: -3.65, maxZ: 3.65 }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
  return {
    x: clamp(x, bounds.minX, bounds.maxX),
    z: clamp(z, bounds.minZ, bounds.maxZ),
    yaw,
    walking: false,
    turnTarget: null,
    speed: opts.speed ?? 0.6,
    turnRateDegS: opts.turnRate ?? 120,
    driftDegS: opts.driftDegS ?? 0,
    // Live-honest default: the stop-prompt latency measured on the raw
    // stream (prompt → service reset → new stream → settle ≈ 1.2 s at
    // 20 fps + ~0.1 s generation; the planner's braking lead is sized for
    // exactly this). Tests that need a different coast pass it explicitly.
    coastS: opts.coastS ?? 1.2,
    coastLeft: 0,
    step(dt) {
      if (this.turnTarget !== null) {
        const err = wrapAngle(this.turnTarget - this.yaw)
        const maxStep = (this.turnRateDegS * dt * Math.PI) / 180
        if (Math.abs(err) <= maxStep) {
          this.yaw = this.turnTarget
          this.turnTarget = null
        } else {
          this.yaw += Math.sign(err) * maxStep
        }
      } else if (this.walking || this.coastLeft > 0) {
        if (!this.walking) this.coastLeft = Math.max(0, this.coastLeft - dt)
        this.x = clamp(this.x + Math.sin(this.yaw) * this.speed * dt, bounds.minX, bounds.maxX)
        this.z = clamp(this.z + Math.cos(this.yaw) * this.speed * dt, bounds.minZ, bounds.maxZ)
        this.yaw += (this.driftDegS * dt * Math.PI) / 180
      }
    },
  }
}

function makePlanner(manifest, navigation, channel, sim, clock, opts = {}) {
  return new GoalPlanner({
    navigation,
    manifest,
    channel,
    probe: () => ({ x: sim.x, z: sim.z, yaw: sim.yaw }),
    nowMs: () => clock.ms,
    random: opts.random ?? (() => 0),
    essenceState: opts.essenceState ?? (() => null),
    // The sim executes turns instantly and exactly; TURN_SETTLE_S is a
    // LIVE-stream prompt-latency guard (reset chunk lands ~1.5-2.5 s after
    // send) and YAW_EMA_TAU_S smooths live root wobble. Neither exists in
    // the sim, and with the 45° turn-request ceiling exact-executor
    // convergence takes more turn steps than the old full-error ask — the
    // uncompressed pair makes the harness settle-bound (120 s goal-cap
    // timeouts), while compressing ONLY the settle desyncs the EMA from
    // the measurement window (stale-yaw wrong-direction decisions). Both
    // are compressed together, keeping their ratio.
    policy: { TURN_SETTLE_S: 1.0, YAW_EMA_TAU_S: 0.25, ...opts.policy },
  })
}

/**
 * Drive the planner + sim loop against a shared wall clock. Reacts to NEW
 * prompt-journal entries the way the real service does (walk → sustain
 * walking, turn → rotate by the requested amount, arrive/interact → stop),
 * records telemetry evidence, and stops when the goal finishes.
 *
 * Returns { tel, minDistanceM, minFacingErrDeg, phases, walkPrompts,
 * turnPrompts, allPrompts }.
 */
function drive(planner, channel, sim, clock, opts = {}) {
  const dt = opts.dt ?? 0.1
  const maxTicks = opts.maxTicks ?? 30000
  let lastLogLen = 0
  let minDistanceM = Infinity
  let minFacingErrDeg = Infinity
  const phases = new Set()
  let ticks = 0
  while (ticks++ < maxTicks) {
    if (opts.beforeEach) opts.beforeEach(clock.ms, planner, channel, sim)
    planner.update(dt)
    const tel = planner.getTelemetry()
    if (tel.phase !== null) phases.add(tel.phase)
    if (tel.distanceToSpot !== null) minDistanceM = Math.min(minDistanceM, tel.distanceToSpot)
    if (tel.facingErrDeg !== null) minFacingErrDeg = Math.min(minFacingErrDeg, tel.facingErrDeg)
    const log = tel.promptLog
    for (let i = lastLogLen; i < log.length; i += 1) {
      const entry = log[i]
      if (entry.kind === 'walk') {
        sim.walking = true
        sim.turnTarget = null
      } else if (entry.kind === 'arrive' || entry.kind === 'interact') {
        // Stop-prompt latency: the walk coasts for sim.coastS before the
        // stop takes effect (0 in every pre-existing scenario).
        if (sim.walking) sim.coastLeft = sim.coastS
        sim.walking = false
        sim.turnTarget = null
      } else if (entry.kind === 'turn') {
        sim.walking = false
        const deg = /(\d+)\s*degrees/.exec(entry.prompt)
        const dir = /left/.test(entry.prompt) ? 1 : -1
        sim.turnTarget = sim.yaw + (dir * (deg ? Number(deg[1]) : 45) * Math.PI) / 180
      }
    }
    lastLogLen = log.length
    // The reflex reaction (or the watchdog's procedural hold) owns the
    // stream: the walk does not progress while either is active — the real
    // service is generating the reaction prompt, not the walk. On release
    // the segment RESUMES: the reflex layer's restore re-issues the
    // planner's prompt, and the watchdog's hard reset restarts generation
    // of the current one (the service keeps runner._prompt across
    // request_reset) — model both by restoring the pre-hold motion state.
    if (channel.reflexActive || channel.watchdogHolding) {
      if (sim.heldBackup === undefined) {
        sim.heldBackup = { walking: sim.walking, turnTarget: sim.turnTarget }
      }
      sim.walking = false
      sim.turnTarget = null
    } else if (sim.heldBackup !== undefined) {
      sim.walking = sim.heldBackup.walking
      sim.turnTarget = sim.heldBackup.turnTarget
      sim.heldBackup = undefined
    }
    sim.step(dt)
    clock.ms += dt * 1000
    if (opts.afterEach) opts.afterEach(clock.ms, planner, channel, sim)
    if (planner.getTelemetry().goal === null && ticks > 2) break
  }
  const tel = planner.getTelemetry()
  return {
    tel,
    minDistanceM: minDistanceM === Infinity ? null : minDistanceM,
    minFacingErrDeg: minFacingErrDeg === Infinity ? null : minFacingErrDeg,
    phases: [...phases],
    walkPrompts: tel.promptLog.filter((e) => e.kind === 'walk').map((e) => e.prompt),
    turnPrompts: tel.promptLog.filter((e) => e.kind === 'turn').map((e) => e.prompt),
    allPrompts: tel.promptLog.map((e) => e.prompt),
  }
}

/** Advance the clock without a goal until the ambient driver picks one. */
function waitForAmbientGoal(planner, channel, sim, clock, maxTicks = 20000) {
  let ticks = 0
  while (ticks++ < maxTicks) {
    clock.ms += 100
    planner.update(0.1)
    const goal = planner.getGoal()
    if (goal !== null) return goal
  }
  return null
}

// ── essence driver helpers (spatial layer 4) ─────────────────────

/** A neutral fresh state snapshot; overrides spread on top. */
function ESSENCE_STATE(over = {}) {
  return {
    fresh: true,
    energy: 0.5,
    focus: 0.5,
    stress: 0.3,
    sociability: 0.3,
    mood: 'neutral',
    activity: 'idle',
    ...over,
  }
}

/** The reviewed drive-rule data with per-rule overrides (tests shrink the
 * 600 s production cooldowns / 45 s dwell to keep the clock cheap). */
function driveRulesWith(patch) {
  return GOAL_PLANNER.ESSENCE_DRIVE_RULES.map((r) => ({ ...r, ...patch }))
}

/** Step the clock in 100 ms ticks (planner.update each tick). */
function stepMs(clock, planner, ms) {
  const deadline = clock.ms + ms
  while (clock.ms < deadline) {
    clock.ms += 100
    planner.update(0.1)
  }
}

/** Advance idle time until an essence-driven goal fires (or null). */
function waitForEssenceGoal(planner, clock, maxMs = 200000) {
  const deadline = clock.ms + maxMs
  while (clock.ms < deadline) {
    clock.ms += 100
    planner.update(0.1)
    const goal = planner.getGoal()
    if (goal !== null) return goal
  }
  return null
}

// ── A* over the existing nav grid ──────────────────────────────────

test('planRoute is obstacle-aware: desk goal path avoids every AABB', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const start = new Vector3(0, 0, 0.15)
  const target = navigation.resolveStandingPoint(new Vector3(-2.9, 0, -0.35))
  const route = navigation.planRoute(start, target)

  assert.ok(route.length >= 1)
  assert.equal(navigation.isRouteClear(start, route), true)
  // The last waypoint IS the resolved standing point (the walkable spot).
  assert.ok(route[route.length - 1].distanceTo(target) < 1e-6)
})

test('planRoute routes AROUND a blocking obstacle (couch), never through it', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  // Straight line from the spawn to behind the couch crosses the couch AABB.
  const start = new Vector3(0, 0, 0.15)
  const behindCouch = new Vector3(0, 0, 3.2)
  assert.ok(navigation.firstBlockingObstacleId(start, [behindCouch]) !== null)

  const route = navigation.planRoute(start, navigation.resolveStandingPoint(behindCouch))
  assert.ok(route.length >= 1)
  assert.equal(navigation.isRouteClear(start, route), true)
})

// ── full desk.work execution ───────────────────────────────────────

test('setGoal desk.work: turns, walks, arrives ≤0.35m, faces, plays the work prompt', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  const sim = makeSim(0, 0.15, 0)
  const clock = { ms: 0 }
  const planner = makePlanner(manifest, navigation, channel, sim, clock)

  assert.equal(planner.setGoal('desk.work'), true)
  assert.equal(planner.getGoal(), 'desk.work')

  const out = drive(planner, channel, sim, clock)

  // Goal completed, no failure.
  assert.equal(out.tel.goal, null)
  assert.equal(out.tel.lastFailure, null)
  // Arrived within tolerance of the resolved standing point (0.35).
  assert.ok(out.minDistanceM !== null && out.minDistanceM <= 0.35,
    `arrival ${out.minDistanceM} must be ≤ 0.35`)
  // Faced the desk: manifest facingDeg -90 (facing -X); tolerance 20°.
  assert.ok(out.minFacingErrDeg !== null && out.minFacingErrDeg <= 25,
    `facing error ${out.minFacingErrDeg}° must be ≤ 25°`)
  // Phase order: turned (heading error >60° from spawn), walked, arrived,
  // played the interaction.
  for (const phase of ['turn', 'walk', 'arrive', 'interact']) {
    assert.ok(out.phases.includes(phase), `phases: ${out.phases.join(',')} (missing ${phase})`)
  }
  const walkIdx = out.allPrompts.findIndex((p) => p.includes('walks forward') || p.includes('walks ahead') || p.includes('strolls'))
  const interactIdx = out.allPrompts.indexOf('a person sits at a desk working')
  assert.ok(walkIdx !== -1 && interactIdx > walkIdx, 'walk prompt must precede the interaction prompt')
  // The interaction prompt is the manifest's authored prompt.
  assert.ok(out.allPrompts.includes('a person sits at a desk working'))
  // Turned toward the desk before walking (heading error ~100° from spawn).
  assert.ok(out.turnPrompts.length >= 1)
  assert.match(out.turnPrompts[0], /(turns (left|right),? about|pivots (left|right) roughly) \d+ degrees/)
})

test('already at the spot: skips walking, goes straight to arrive → interact', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  const target = navigation.resolveStandingPoint(new Vector3(-2.9, 0, -0.35))
  const sim = makeSim(target.x, target.z, (-90 * Math.PI) / 180)
  const clock = { ms: 0 }
  const planner = makePlanner(manifest, navigation, channel, sim, clock)

  assert.equal(planner.setGoal('desk.work'), true)
  const out = drive(planner, channel, sim, clock)
  assert.equal(out.tel.lastFailure, null)
  assert.equal(out.walkPrompts.length, 0)
  assert.ok(out.allPrompts.includes('a person sits at a desk working'))
  assert.ok(out.phases.includes('arrive') && out.phases.includes('interact'))
})

test('unknown interactions fail closed (journaled, never throw)', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  const sim = makeSim(0, 0.15, 0)
  const clock = { ms: 0 }
  const planner = makePlanner(manifest, navigation, channel, sim, clock)

  for (const bad of ['nope.nothing', 'desk', 'desk.typing', '.work', 'desk.']) {
    assert.equal(planner.setGoal(bad), false)
    assert.match(planner.getTelemetry().lastFailure ?? '', /unknown interaction/)
  }
  assert.equal(planner.getGoal(), null)
})

// ── prompt variants (no same-loop-forever) ─────────────────────────

test('a 30s+ walk uses ≥2 DISTINCT walk prompts (seeded rotation)', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  // 0.1 m/s over the ~2.9 m desk walk → ~29s of walking, crossing two
  // WALK_PROMPT_ROTATE_S (12s) boundaries.
  const sim = makeSim(0, 0.15, 0, { speed: 0.1 })
  const clock = { ms: 0 }
  const planner = makePlanner(manifest, navigation, channel, sim, clock)

  assert.equal(planner.setGoal('desk.work'), true)
  const out = drive(planner, channel, sim, clock)
  assert.equal(out.tel.lastFailure, null)
  assert.ok(out.walkPrompts.length >= 2, `walk prompts: ${out.walkPrompts.length}`)
  const distinct = new Set(out.walkPrompts)
  assert.ok(distinct.size >= 2, `distinct walk prompts: ${[...distinct].join(' | ')}`)
  // Rotation is deterministic per goal id: same goal → same sequence.
  const channel2 = makeChannel()
  const sim2 = makeSim(0, 0.15, 0, { speed: 0.1 })
  const clock2 = { ms: 0 }
  const planner2 = makePlanner(manifest, navigation, channel2, sim2, clock2)
  planner2.setGoal('desk.work')
  const out2 = drive(planner2, channel2, sim2, clock2)
  assert.deepEqual(out2.walkPrompts, out.walkPrompts)
})

// ── priority: watchdog > user > reflex > planner > ambient ─────────

test('steering: a drifting walk is re-aimed mid-segment (never let error compound)', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  // 20°/s of stochastic heading drift while walking: after ~3s the error
  // crosses HEADING_ERROR_TURN_DEG (60° — coarse steering, calibrated
  // live: the stream's walks curve ~10-16°/s) and the planner must
  // interrupt the walk with a steering turn — then resume — and still
  // complete the goal.
  const sim = makeSim(0, 0.15, 0, { driftDegS: 20 })
  const clock = { ms: 0 }
  const planner = makePlanner(manifest, navigation, channel, sim, clock)

  assert.equal(planner.setGoal('desk.work'), true)
  const out = drive(planner, channel, sim, clock)
  assert.equal(out.tel.lastFailure, null, `unexpected failure: ${out.tel.lastFailure}`)
  // ≥2 turn prompts: the initial heading turn + at least one steering turn
  // mid-walk (the desk path is single-waypoint, so any extra turn IS a
  // steering re-aim).
  assert.ok(out.turnPrompts.length >= 2, `turn prompts: ${out.turnPrompts.join(' | ')}`)
  assert.ok(out.allPrompts.includes('a person sits at a desk working'))
  // Still arrived within tolerance (steering kept her on course).
  assert.ok(out.minDistanceM !== null && out.minDistanceM <= 0.35,
    `arrival ${out.minDistanceM} must be ≤ 0.35`)
})

test('arrival overshoot: coasting past the spot re-approaches ONCE, then proceeds bounded', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  // Coast latency far beyond the braking-lead window (ARRIVE_LEAD_S 1.2):
  // every arrive stop lands past the spot. The planner must re-anchor on
  // the ACTUAL position and re-approach exactly once (shared replan
  // budget), then proceed to the interaction with the residual journaled —
  // never an infinite approach loop (MotionBricks re-anchor, spec §planner
  // loop "arrival != motion trust").
  const sim = makeSim(0, 0.15, 0, { speed: 0.6, coastS: 3.0 })
  const clock = { ms: 0 }
  const planner = makePlanner(manifest, navigation, channel, sim, clock)

  assert.equal(planner.setGoal('desk.work'), true)
  let arriveEndDist = null
  let replansAtFirstMiss = null
  const out = drive(planner, channel, sim, clock, {
    beforeEach: (_ms, p) => {
      const tel = p.getTelemetry()
      if (tel.phase === 'arrive') arriveEndDist = tel.distanceToSpot
      if (tel.replans > 0 && replansAtFirstMiss === null) replansAtFirstMiss = tel.replans
    },
  })
  assert.equal(out.tel.goal, null, 'goal finished (not stuck re-approaching)')
  assert.equal(out.tel.lastFailure, null, `unexpected failure: ${out.tel.lastFailure}`)
  assert.equal(out.tel.replans, 1, 'exactly one re-approach (shared replan budget)')
  assert.ok(arriveEndDist === null || arriveEndDist > 0.35,
    `the coast model must actually overshoot (arrive-end distance ${arriveEndDist})`)
  assert.ok(out.allPrompts.includes('a person sits at a desk working'),
    'proceeds to the interaction after the budget is exhausted')
  // The approaches themselves crossed the spot (min distance), even though
  // the coast carried her past it each time.
  assert.ok(out.minDistanceM !== null && out.minDistanceM <= 0.35,
    `closest approach ${out.minDistanceM} must be ≤ 0.35`)
})

test('fallback route (ends AWAY from the target) is a block: replan once, then fail with reason — never interact from afar', async () => {
  const manifest = await loadManifest()
  // Mock navigation: the only "route" ends at a point 2 m from the target
  // (planRoute's closestClearPoint fallback, measured live on couch.sit).
  const navigation = {
    resolveStandingPoint: (p) => p,
    planRoute: () => [new Vector3(-1.2, 0, 0.9)],
    constrainMovement: (_from, to) => ({ position: to }),
  }
  const channel = makeChannel()
  // Far corner: she never enters the desk's arrive region (≤ tolerance +
  // max lead) on the way to the fallback point — the block must FAIL.
  const sim = makeSim(2.8, 2.8, 0)
  const clock = { ms: 0 }
  const planner = new GoalPlanner({
    navigation,
    manifest,
    channel,
    probe: () => ({ x: sim.x, z: sim.z, yaw: sim.yaw }),
    nowMs: () => clock.ms,
    policy: { TARGET_STALL_S: 3 },
  })
  assert.equal(planner.setGoal('desk.work'), true)
  const out = drive(planner, channel, sim, clock)
  assert.equal(out.tel.goal, null, 'goal ended (bounded)')
  assert.ok(out.tel.lastFailure !== null && out.tel.lastFailure.includes('blocked path'),
    `journaled blocked-path failure (got: ${out.tel.lastFailure})`)
  assert.equal(out.tel.replans, 1, 'exactly one replan before failing')
  assert.ok(!out.allPrompts.includes('a person sits at a desk working'),
    'never plays the interaction from 2 m away')
})

test('target-progress watchdog: wandering with sporadic progress fails bounded (not a 120s timeout)', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  // Stubborn stream: orbits a point ~2 m from the desk spot forever,
  // ignoring turn prompts. Each lap dips the TARGET distance to the same
  // minimum — sporadic "progress" that defeats the per-waypoint stall
  // timer; only the target-progress watchdog bounds it.
  const orbit = {
    x: -0.8, z: -0.35, yaw: 0, walking: false, turnTarget: null, coastLeft: 0, coastS: 0,
    theta: 0,
    step(dt) {
      if (this.walking) this.theta += (0.6 / 0.38) * dt
      this.x = -0.8 + 0.38 * Math.cos(this.theta)
      this.z = -0.35 + 0.38 * Math.sin(this.theta)
      this.yaw = this.theta
    },
  }
  const clock = { ms: 0 }
  const planner = makePlanner(manifest, navigation, channel, orbit, clock, {
    policy: { TARGET_STALL_S: 4, MAX_GOAL_SECONDS: 300 },
  })
  assert.equal(planner.setGoal('desk.work'), true)
  const startedMs = clock.ms
  const out = drive(planner, channel, orbit, clock)
  assert.equal(out.tel.goal, null, 'goal ended (bounded)')
  assert.ok(out.tel.lastFailure !== null, `journaled failure (got: ${out.tel.lastFailure})`)
  const elapsedS = (clock.ms - startedMs) / 1000
  assert.ok(elapsedS < 60, `failed fast (${elapsedS.toFixed(0)}s ≪ 120s timeout / 300s cap)`)
  assert.ok(!out.allPrompts.includes('a person sits at a desk working'),
    'never interacts from the wander')
})

test('path smoothing: a sub-meter waypoint is merged when the merged segment is clear — kept when blocked', async () => {
  const manifest = await loadManifest()
  // Path with a 0.5 m first waypoint (unexecutable precision leg): the
  // smoothed planner aims at the FINAL waypoint (right, err ≈ -100°);
  // unsmoothed it would aim at the 0.5 m waypoint (left, err ≈ +90°).
  const mkNav = (clear) => ({
    resolveStandingPoint: (p) => p,
    planRoute: () => [new Vector3(0.5, 0, 0.15), new Vector3(-2.83, 0, -0.35)],
    isRouteClear: () => clear,
    constrainMovement: (_from, to) => ({ position: to }),
  })
  {
    const channel = makeChannel()
    const sim = makeSim(0, 0.15, 0)
    const clock = { ms: 0 }
    const planner = new GoalPlanner({
      navigation: mkNav(true), manifest, channel,
      probe: () => ({ x: sim.x, z: sim.z, yaw: sim.yaw }), nowMs: () => clock.ms,
    })
    assert.equal(planner.setGoal('desk.work'), true)
    drive(planner, channel, sim, clock, { maxTicks: 200 })
    const firstTurn = channel.prompts.find((p) => /degrees/.test(p))
    assert.ok(firstTurn !== undefined && /right/.test(firstTurn),
      `merged path aims at the final waypoint (got: ${firstTurn})`)
  }
  {
    const channel = makeChannel()
    const sim = makeSim(0, 0.15, 0)
    const clock = { ms: 0 }
    const planner = new GoalPlanner({
      navigation: mkNav(false), manifest, channel,
      probe: () => ({ x: sim.x, z: sim.z, yaw: sim.yaw }), nowMs: () => clock.ms,
    })
    assert.equal(planner.setGoal('desk.work'), true)
    drive(planner, channel, sim, clock, { maxTicks: 200 })
    const firstTurn = channel.prompts.find((p) => /degrees/.test(p))
    assert.ok(firstTurn !== undefined && /left/.test(firstTurn),
      `blocked merge keeps the corner waypoint (got: ${firstTurn})`)
  }
})

test('priority: a user prompt mid-goal cancels the goal (journaled, no queue)', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  const sim = makeSim(0, 0.15, 0)
  const clock = { ms: 0 }
  const planner = makePlanner(manifest, navigation, channel, sim, clock)

  planner.setGoal('desk.work')
  let userPrompted = false
  const out = drive(planner, channel, sim, clock, {
    beforeEach: (ms) => {
      if (!userPrompted && ms > 4000) {
        userPrompted = true
        channel.userPromptAtMs = ms // mid-walk user prompt
      }
    },
  })
  assert.equal(out.tel.goal, null)
  assert.match(out.tel.lastFailure ?? '', /cancelled by user prompt/)
  // Cancelled before the interaction ever played.
  assert.ok(!out.allPrompts.includes('a person sits at a desk working'))
  // Journaled: the cancellation entry is in the prompt log.
  assert.ok(out.allPrompts.some((p) => p.includes('cancelled by user prompt')))
})

test('priority: a reflex interrupts a segment — no planner sends during it, goal resumes after', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  const sim = makeSim(0, 0.15, 0)
  const clock = { ms: 0 }
  const planner = makePlanner(manifest, navigation, channel, sim, clock)

  planner.setGoal('desk.work')
  let reflexTriggered = false
  let reflexUntil = -1
  let preLen = 0
  let sentDuringReflex = 0
  const out = drive(planner, channel, sim, clock, {
    beforeEach: (ms) => {
      // A one-shot reflex fires mid-walk at 5s and plays for 3s.
      if (!reflexTriggered && ms >= 5000) {
        reflexTriggered = true
        channel.reflexActive = true
        reflexUntil = ms + 3000
      }
      if (channel.reflexActive && ms >= reflexUntil) channel.reflexActive = false
      preLen = channel.prompts.length
    },
    afterEach: () => {
      if (channel.reflexActive && channel.prompts.length > preLen) sentDuringReflex += 1
    },
  })
  assert.equal(sentDuringReflex, 0, 'planner must not send while the reflex plays')
  assert.ok(out.tel.lastFailure === null, `unexpected failure: ${out.tel.lastFailure}`)
  // The goal resumed after the reaction cleared and completed normally.
  assert.ok(out.allPrompts.includes('a person sits at a desk working'))
  assert.equal(out.tel.goal, null)
})

test('priority: a watchdog hold suspends the planner — no sends, goal completes after recovery', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  const sim = makeSim(0, 0.15, 0)
  const clock = { ms: 0 }
  const planner = makePlanner(manifest, navigation, channel, sim, clock)

  planner.setGoal('desk.work')
  let holdTriggered = false
  let holdsUntil = -1
  let preLen = 0
  let sentDuringHold = 0
  const out = drive(planner, channel, sim, clock, {
    beforeEach: (ms) => {
      // A one-shot watchdog hold takes the rig mid-goal at 6s for 5s.
      if (!holdTriggered && ms >= 6000) {
        holdTriggered = true
        channel.watchdogHolding = true
        holdsUntil = ms + 5000
      }
      if (channel.watchdogHolding && ms >= holdsUntil) channel.watchdogHolding = false
      preLen = channel.prompts.length
    },
    afterEach: () => {
      if (channel.watchdogHolding && channel.prompts.length > preLen) sentDuringHold += 1
    },
  })
  assert.equal(sentDuringHold, 0, 'planner must not send while the watchdog holds')
  assert.ok(out.tel.lastFailure === null, `unexpected failure: ${out.tel.lastFailure}`)
  assert.ok(out.allPrompts.includes('a person sits at a desk working'))
  assert.equal(out.tel.goal, null)
})

// ── blocked path ───────────────────────────────────────────────────

test('blocked path: one replan, then fails with a journaled reason (no infinite walk)', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  // Frozen stream: she never moves (obstacle/rejection), even while walking.
  const sim = makeSim(0, 0.15, 0, { speed: 0 })
  const clock = { ms: 0 }
  const planner = makePlanner(manifest, navigation, channel, sim, clock)

  planner.setGoal('desk.work')
  const out = drive(planner, channel, sim, clock)
  assert.equal(out.tel.goal, null)
  assert.match(out.tel.lastFailure ?? '', /blocked path.*1 replan/)
  // Exactly two walk prompts: the original and the single replan.
  assert.equal(out.walkPrompts.length, 2, `walk prompts: ${out.walkPrompts.join(' | ')}`)
  // Journaled failure reason is in the prompt log.
  assert.ok(out.allPrompts.some((p) => p.includes('blocked path') && p.includes('failed')))
})

// ── ambient idle driver ────────────────────────────────────────────

test('ambient driver: idle past AMBIENT_AFTER_S picks a weighted deck goal and executes it', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  const sim = makeSim(0, 0.15, 0)
  const clock = { ms: 0 }
  const planner = makePlanner(manifest, navigation, channel, sim, clock, { random: () => 0 })

  // Nothing owns the prompt for 90s → the ambient driver fires.
  const picked = waitForAmbientGoal(planner, channel, sim, clock)
  assert.equal(picked, 'daybed.nap', 'first deck entry (roll 0) after 90s idle')

  const out = drive(planner, channel, sim, clock)
  assert.equal(out.tel.lastFailure, null, `ambient goal failed: ${out.tel.lastFailure}`)
  // Executed the full sequence incl. the daybed interaction prompt.
  assert.ok(out.allPrompts.includes('a person lies down on a daybed'))
  assert.ok(out.walkPrompts.length >= 1, 'ambient goal must include walking')
  assert.ok(out.phases.includes('interact'))
  // Position trace: she moved from spawn toward the daybed.
  assert.ok(Math.hypot(sim.x, sim.z) > 1.0, `barely moved: (${sim.x.toFixed(2)}, ${sim.z.toFixed(2)})`)
})

test('ambient driver: per-goal cooldowns rotate the deck (no same-goal loop)', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  const sim = makeSim(0, 0.15, 0)
  const clock = { ms: 0 }
  const planner = makePlanner(manifest, navigation, channel, sim, clock, { random: () => 0 })

  const picked = []
  const first = waitForAmbientGoal(planner, channel, sim, clock)
  assert.equal(first, 'daybed.nap')
  picked.push(first)
  drive(planner, channel, sim, clock) // run the ambient goal to completion

  // 90s later daybed.nap is still on cooldown (180s) → the next candidate.
  const second = waitForAmbientGoal(planner, channel, sim, clock)
  assert.equal(second, 'couch.sit')
  picked.push(second)
  assert.deepEqual(picked, ['daybed.nap', 'couch.sit'])
})

test('ambient driver: unresolvable deck goals are skipped fail-closed', async () => {
  // Empty room: no deck goal resolves → ambient never fires, no crash.
  const emptyManifest = {
    manifest_version: '1.0',
    room_id: 'empty',
    name: 'Empty',
    bounds: { minX: -3.65, maxX: 3.65, minZ: -3.65, maxZ: 3.65 },
    obstacles: [],
    objects: [],
  }
  const navigation = RoomNavigation.fromManifest(emptyManifest, LOFT_ACTOR_RADIUS)
  const channel = makeChannel()
  const sim = makeSim(0, 0.15, 0)
  const clock = { ms: 0 }
  const planner = makePlanner(emptyManifest, navigation, channel, sim, clock, { random: () => 0 })

  for (let i = 0; i < 2000; i += 1) {
    clock.ms += 100
    planner.update(0.1)
  }
  assert.equal(planner.getGoal(), null)
  assert.equal(channel.prompts.length, 0)
  assert.equal(planner.getTelemetry().lastFailure, null)
})

// ── essence idle driver (spatial layer 4) ────────────────────────

test('essence driver: seeded energy 0.2 → daybed.nap fires; goalSource {kind essence, rule energy-low, state} is legible', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  const sim = makeSim(0, 0.15, 0)
  const clock = { ms: 0 }
  const state = ESSENCE_STATE({ energy: 0.2 })
  const planner = makePlanner(manifest, navigation, channel, sim, clock, { essenceState: () => state })

  // The driver fires on its first poll (nothing else owns the prompt).
  const picked = waitForEssenceGoal(planner, clock)
  assert.equal(picked, 'daybed.nap')
  const tel = planner.getTelemetry()
  assert.equal(tel.goalSource.kind, 'essence')
  assert.equal(tel.goalSource.rule, 'energy-low')
  assert.equal(tel.goalSource.state.energy, 0.2)
  assert.equal(tel.goalSource.state.fresh, true)
  // The goal start is journaled in the prompt log.
  assert.ok(tel.promptLog.some((e) => e.prompt.includes('[goal] daybed.nap')),
    `prompt log must journal the essence goal: ${tel.promptLog.map((e) => e.prompt).join(' | ')}`)

  // The essence goal EXECUTES through the normal planner (walk → nap prompt).
  const out = drive(planner, channel, sim, clock)
  assert.equal(out.tel.lastFailure, null, `essence goal failed: ${out.tel.lastFailure}`)
  assert.ok(out.allPrompts.includes('a person lies down on a daybed'))
  assert.ok(out.phases.includes('interact'))
  assert.ok(out.minDistanceM !== null && out.minDistanceM <= 0.35,
    `arrival ${out.minDistanceM} must be ≤ 0.35`)
  // The story survives completion (until another goal replaces it).
  assert.equal(out.tel.goalSource.rule, 'energy-low')
  assert.equal(out.tel.goalSource.state.energy, 0.2)
})

test('essence driver: rules are ordered first-match (energy-low beats energy-focus when both match)', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  const sim = makeSim(0, 0.15, 0)
  const clock = { ms: 0 }
  // Several rules would match: energy-low (energy 0.1), stress-high (stress
  // 0.9, unresolvable goal — skipped fail-closed) and sociable-idle
  // (sociability 0.9 + idle). First-match order wins: energy-low → daybed.nap.
  const state = ESSENCE_STATE({ energy: 0.1, focus: 0.9, stress: 0.9, sociability: 0.9 })
  const planner = makePlanner(manifest, navigation, channel, sim, clock, { essenceState: () => state })

  const picked = waitForEssenceGoal(planner, clock)
  assert.equal(picked, 'daybed.nap')
  assert.equal(planner.getTelemetry().goalSource.rule, 'energy-low')
})

test('essence driver: no rule matches → the ambient deck path is exactly as before', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  const sim = makeSim(0, 0.15, 0)
  const clock = { ms: 0 }
  // Neutral state matches no drive rule.
  const state = ESSENCE_STATE({})
  const planner = makePlanner(manifest, navigation, channel, sim, clock, {
    essenceState: () => state,
    random: () => 0,
  })

  // Essence polls at 0/30/60/90s find nothing; at 90s idle the weighted deck
  // fires exactly as before (unchanged fallback behavior).
  const picked = waitForAmbientGoal(planner, channel, sim, clock)
  assert.equal(picked, 'daybed.nap', 'deck fallback fires when no rule matches')
  assert.equal(planner.getTelemetry().goalSource, null, 'not essence-driven')
})

test('essence driver: per-goal cooldown blocks a re-fire while the state still matches, then allows it', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  // Start AT the daybed spot (no walk) with a short interaction so the goal
  // completes fast and the cooldown window is observable.
  const target = navigation.resolveStandingPoint(new Vector3(2.75, 0, 1.9))
  const sim = makeSim(target.x, target.z, 0)
  const clock = { ms: 0 }
  const state = ESSENCE_STATE({ energy: 0.2 })
  const planner = makePlanner(manifest, navigation, channel, sim, clock, {
    essenceState: () => state,
    policy: {
      ESSENCE_DRIVE_RULES: driveRulesWith({ cooldownS: 60 }),
      INTERACTION_MS: 3000,
    },
  })

  const first = waitForEssenceGoal(planner, clock)
  assert.equal(first, 'daybed.nap')
  const firedAt = clock.ms

  // After the goal completes, the still-matching state is NOT allowed to
  // re-fire inside the 60 s cooldown (polls at +30s are blocked).
  stepMs(clock, planner, 45_000)
  assert.equal(planner.getGoal(), null, 'no re-fire inside the per-goal cooldown')
  assert.equal(planner.getTelemetry().goalSource?.rule, 'energy-low', 'story retained')

  // Once the cooldown expires (and the 45 s min-dwell passed), the same rule
  // fires again — a fresh second goal.
  const second = waitForEssenceGoal(planner, clock, 40_000)
  assert.equal(second, 'daybed.nap')
  assert.ok(clock.ms - firedAt >= 60_000, `second fire at ${clock.ms - firedAt}ms must be ≥ cooldown`)
})

test('essence driver: min-dwell hysteresis — a mid-goal state flip never preempts; the next rule waits its min-dwell', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  const sim = makeSim(0, 0.15, 0)
  const clock = { ms: 0 }
  const state = ESSENCE_STATE({ energy: 0.2 })
  const planner = makePlanner(manifest, navigation, channel, sim, clock, {
    essenceState: () => state,
    policy: { ESSENCE_DRIVE_RULES: driveRulesWith({ minDwellS: 60 }), INTERACTION_MS: 5000 },
  })

  const picked = waitForEssenceGoal(planner, clock)
  assert.equal(picked, 'daybed.nap')
  const startedAt = clock.ms

  // Mid-goal the state flips to energized+focused (would match desk.work).
  let flipped = false
  const out = drive(planner, channel, sim, clock, {
    beforeEach: (ms) => {
      if (!flipped && ms > startedAt + 5000) {
        flipped = true
        state.energy = 0.9
        state.focus = 0.9
      }
    },
  })
  // The nap goal continued to completion — the flip never preempted it.
  assert.equal(out.tel.lastFailure, null, `goal failed: ${out.tel.lastFailure}`)
  assert.ok(out.allPrompts.includes('a person lies down on a daybed'))
  assert.equal(out.tel.goalSource.rule, 'energy-low', 'mid-goal flip did not change the running goal story')

  // After completion, desk.work must NOT fire before min-dwell (60 s since
  // the nap STARTED) — the poll at +30s is dwell-blocked.
  stepMs(clock, planner, 30_000 - (clock.ms - startedAt))
  assert.equal(planner.getGoal(), null, 'no new rule before min-dwell elapses')
  assert.ok(!channel.prompts.some((p) => p.includes('a person sits at a desk working')),
    'desk.work must wait out the hysteresis window')

  // Past the dwell window the flipped state fires desk.work (rule energy-focus).
  const second = waitForEssenceGoal(planner, clock, 40_000)
  assert.equal(second, 'desk.work')
  assert.equal(planner.getTelemetry().goalSource.rule, 'energy-focus')
  assert.equal(planner.getTelemetry().goalSource.state.energy, 0.9)
})

test('essence driver: priority — a user prompt cancels an essence goal (user wins, journaled)', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  const sim = makeSim(0, 0.15, 0)
  const clock = { ms: 0 }
  const planner = makePlanner(manifest, navigation, channel, sim, clock, {
    essenceState: () => ESSENCE_STATE({ energy: 0.2 }),
  })

  assert.equal(waitForEssenceGoal(planner, clock), 'daybed.nap')
  let userPrompted = false
  const out = drive(planner, channel, sim, clock, {
    beforeEach: (ms) => {
      if (!userPrompted && ms > 4000) {
        userPrompted = true
        channel.userPromptAtMs = ms // mid-walk user prompt
      }
    },
  })
  assert.equal(out.tel.goal, null)
  assert.match(out.tel.lastFailure ?? '', /cancelled by user prompt/)
  assert.ok(!out.allPrompts.includes('a person lies down on a daybed'),
    'cancelled before the nap interaction ever played')
  assert.ok(out.allPrompts.some((p) => p.includes('cancelled by user prompt')),
    'the user win is journaled')
})

test('essence driver: priority — a reflex interrupts a segment; the goal resumes and completes', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  const sim = makeSim(0, 0.15, 0)
  const clock = { ms: 0 }
  const planner = makePlanner(manifest, navigation, channel, sim, clock, {
    essenceState: () => ESSENCE_STATE({ energy: 0.2 }),
  })

  assert.equal(waitForEssenceGoal(planner, clock), 'daybed.nap')
  let reflexTriggered = false
  let reflexUntil = -1
  let preLen = 0
  let sentDuringReflex = 0
  const out = drive(planner, channel, sim, clock, {
    beforeEach: (ms) => {
      if (!reflexTriggered && ms >= 5000) {
        reflexTriggered = true
        channel.reflexActive = true
        reflexUntil = ms + 3000
      }
      if (channel.reflexActive && ms >= reflexUntil) channel.reflexActive = false
      preLen = channel.prompts.length
    },
    afterEach: () => {
      if (channel.reflexActive && channel.prompts.length > preLen) sentDuringReflex += 1
    },
  })
  assert.equal(sentDuringReflex, 0, 'planner must not send while the reflex plays')
  assert.equal(out.tel.lastFailure, null, `unexpected failure: ${out.tel.lastFailure}`)
  assert.ok(out.allPrompts.includes('a person lies down on a daybed'))
  assert.equal(out.tel.goalSource.rule, 'energy-low')
})

test('essence driver: priority — a watchdog hold suspends the planner; the goal completes after recovery', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  const sim = makeSim(0, 0.15, 0)
  const clock = { ms: 0 }
  const planner = makePlanner(manifest, navigation, channel, sim, clock, {
    essenceState: () => ESSENCE_STATE({ energy: 0.2 }),
  })

  assert.equal(waitForEssenceGoal(planner, clock), 'daybed.nap')
  let holdTriggered = false
  let holdsUntil = -1
  let preLen = 0
  let sentDuringHold = 0
  const out = drive(planner, channel, sim, clock, {
    beforeEach: (ms) => {
      if (!holdTriggered && ms >= 6000) {
        holdTriggered = true
        channel.watchdogHolding = true
        holdsUntil = ms + 5000
      }
      if (channel.watchdogHolding && ms >= holdsUntil) channel.watchdogHolding = false
      preLen = channel.prompts.length
    },
    afterEach: () => {
      if (channel.watchdogHolding && channel.prompts.length > preLen) sentDuringHold += 1
    },
  })
  assert.equal(sentDuringHold, 0, 'planner must not send while the watchdog holds')
  assert.equal(out.tel.lastFailure, null, `unexpected failure: ${out.tel.lastFailure}`)
  assert.ok(out.allPrompts.includes('a person lies down on a daybed'))
})

test('essence driver: stale (unfresh) state never drives a goal — the deck fallback still works', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  const sim = makeSim(0, 0.15, 0)
  const clock = { ms: 0 }
  // Energy 0.2 would match energy-low, but the file is stale → no rule fires.
  const planner = makePlanner(manifest, navigation, channel, sim, clock, {
    essenceState: () => ESSENCE_STATE({ fresh: false, energy: 0.2 }),
    random: () => 0,
  })

  const picked = waitForAmbientGoal(planner, channel, sim, clock)
  assert.equal(picked, 'daybed.nap', 'deck fallback fires (unchanged)')
  assert.equal(planner.getTelemetry().goalSource, null, 'stale essence state drove nothing')
})

test('essence driver: an unresolvable rule goal (window.look) is skipped fail-closed; later resolvable rules still fire', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  const sim = makeSim(0, 0.15, 0)
  const clock = { ms: 0 }
  // stress 0.9 matches stress-high, but window.look does not exist in the
  // tai-loft manifest → skipped fail-closed; sociable-idle resolves next.
  const state = ESSENCE_STATE({ stress: 0.9, sociability: 0.9, activity: 'idle' })
  const planner = makePlanner(manifest, navigation, channel, sim, clock, { essenceState: () => state })

  const picked = waitForEssenceGoal(planner, clock)
  assert.equal(picked, 'couch.sit')
  assert.equal(planner.getTelemetry().goalSource.rule, 'sociable-idle')
})

test('essence driver: missing state fields fail their clause (never crash, never fire)', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  const sim = makeSim(0, 0.15, 0)
  const clock = { ms: 0 }
  // energy unknown → energy-low/energy-focus clauses fail; stress-high's goal
  // is unresolvable; sociability unknown → sociable-idle fails.
  const planner = makePlanner(manifest, navigation, channel, sim, clock, {
    essenceState: () => ESSENCE_STATE({ energy: null, stress: 0.9, sociability: null }),
  })

  stepMs(clock, planner, 60_000) // before the 90s deck gate
  assert.equal(planner.getGoal(), null)
  assert.equal(channel.prompts.length, 0)
  assert.equal(planner.getTelemetry().goalSource, null)
  assert.equal(planner.getTelemetry().lastFailure, null)
})

test('essence driver: a state change is noticed only on the poll cadence (ESSENCE_POLL_S)', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  const sim = makeSim(0, 0.15, 0)
  const clock = { ms: 0 }
  const state = ESSENCE_STATE({}) // neutral at mount (poll at t=0 finds nothing)
  const planner = makePlanner(manifest, navigation, channel, sim, clock, { essenceState: () => state })

  stepMs(clock, planner, 5000)
  state.energy = 0.2 // tired at t=5s — mid-poll-window
  stepMs(clock, planner, 20_000) // t=25s: still before the t=30s poll
  assert.equal(planner.getGoal(), null, 'no fire mid-poll-window')
  const picked = waitForEssenceGoal(planner, clock, 10_000)
  assert.equal(picked, 'daybed.nap', 'fires on the next poll boundary')
})

test('essence driver: a recent user prompt silences the driver (ESSENCE_USER_QUIET_S)', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  const sim = makeSim(0, 0.15, 0)
  const clock = { ms: 0 }
  const state = ESSENCE_STATE({ energy: 0.2 })
  const planner = makePlanner(manifest, navigation, channel, sim, clock, { essenceState: () => state })
  channel.userPromptAtMs = 0 // user prompt at t=0 — the driver must stay quiet

  stepMs(clock, planner, 25_000)
  assert.equal(planner.getGoal(), null, 'quiet window holds (25s < 30s)')
  const picked = waitForEssenceGoal(planner, clock, 10_000)
  assert.equal(picked, 'daybed.nap', 'fires once the quiet window elapsed')
})

test('essence driver: a non-essence goal replaces the story (goalSource clears)', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  const sim = makeSim(0, 0.15, 0)
  const clock = { ms: 0 }
  const planner = makePlanner(manifest, navigation, channel, sim, clock, {
    essenceState: () => ESSENCE_STATE({ energy: 0.2 }),
  })

  assert.equal(waitForEssenceGoal(planner, clock), 'daybed.nap')
  assert.equal(planner.getTelemetry().goalSource.rule, 'energy-low')
  // A user (debug) goal starts → the essence story no longer describes her.
  assert.equal(planner.setGoal('desk.work'), true)
  assert.equal(planner.getTelemetry().goalSource, null)
})

// ── telemetry ──────────────────────────────────────────────────────

test('telemetry exposes goal/phase/distanceToSpot/replans/promptLog through the run', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  const sim = makeSim(0, 0.15, 0)
  const clock = { ms: 0 }
  const planner = makePlanner(manifest, navigation, channel, sim, clock)

  const idleTel = planner.getTelemetry()
  assert.equal(idleTel.goal, null)
  assert.equal(idleTel.phase, null)
  assert.equal(idleTel.distanceToSpot, null)
  assert.deepEqual(idleTel.promptLog, [])

  planner.setGoal('desk.work')
  let sawGoal = false
  let sawDistance = false
  const out = drive(planner, channel, sim, clock, {
    beforeEach: () => {
      const t = planner.getTelemetry()
      if (t.goal === 'desk.work' && t.phase !== null) sawGoal = true
      if (t.distanceToSpot !== null && t.distanceToSpot >= 0) sawDistance = true
    },
  })
  assert.ok(sawGoal)
  assert.ok(sawDistance)
  assert.ok(out.tel.promptLog.length >= 4, 'prompt log must prove each phase')
})
