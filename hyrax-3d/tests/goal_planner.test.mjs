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
import { InteractableStateMachine } from '../src/embodiment/room/interactableState.ts'
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
    // Turn-execution tail (live stream model, 2026-08-03 drift class):
    // the live ARDY stream executes a turn ask at 79-240% of the request
    // and the raw yaw KEEPS MOVING past the requested heading after the
    // planner's settle window closes (reset chunk lands 1.5-2.5 s after
    // send; the yaw mid-execution is spin garbage — the EMA reads aligned
    // as the raw crosses the target, then the raw keeps rotating past it).
    // Model: after the requested turn target is reached, the yaw swings
    // PAST it (up to turnSwingDeg, damped back to the target over
    // turnSwingS). A walk prompt sent during that swing goes off-heading
    // into the nearest obstacle — the drift class the regression locks.
    swingDeg: opts.turnSwingDeg ?? 0,
    swingS: opts.turnSwingS ?? 2,
    swingDelayS: opts.turnSwingDelayS ?? 0,
    swingAt: null, // sim-seconds when the swing starts (after the delay)
    turnSwingBase: 0,
    simS: 0,
    // Live-honest default: the stop-prompt latency measured on the raw
    // stream (prompt → service reset → new stream → settle ≈ 1.2 s at
    // 20 fps + ~0.1 s generation; the planner's braking lead is sized for
    // exactly this). Tests that need a different coast pass it explicitly.
    coastS: opts.coastS ?? 1.2,
    coastLeft: 0,
    // Never-settling turn sweep (2026-08-04 drift class): the live
    // stream's yaw demonstrably keeps rotating after a turn ask — the
    // tels sweep 0°→180° continuously for 68+ s with zero prompts in
    // flight (desk2), and the raw gate's "wait for settle" becomes an
    // unbounded hold (the reissue budget never exhausts because the yaw
    // is never "settled"). Model: after the requested turn target is
    // reached, the yaw keeps rotating at neverSettleDegS until the NEXT
    // prompt (a walk prompt replaces the stream and freezes the heading,
    // exactly like the live yaw-continuity re-anchor).
    neverSettleDegS: opts.neverSettleDegS ?? 0,
    // Walk-prompt landing latency (s) — 2026-08-04 never-settling stream
    // class: live, a walk prompt takes 1.5-2.5 s to REPLACE the old
    // stream (the reset chunk lands, then the new walk stream starts).
    // During the landing the body does not move and the OLD stream's yaw
    // behavior continues (the sweep keeps sweeping). Pre-fix the planner
    // measured the old stream's heading on the same tick the walk prompt
    // was sent and yanked the walk back into turn before it ever moved
    // (measured live: turn↔walk oscillation, each walk phase ~1 tick).
    // WALK_SETTLE_S suppresses steering until the landing + re-anchor
    // complete; this option makes the sim reproduce the live loop.
    walkLandS: opts.walkLandS ?? 0,
    walkLandLeft: 0,
    // Walk-stream frozen heading (deg) — the live yaw-continuity
    // re-anchor: when the walk prompt's reset chunk lands, the new walk
    // stream freezes the heading at the direction the walk actually
    // starts moving (live desk2: the walk at 42° error moved her 4.2 →
    // 1.2 m — a usable frozen heading). null = freeze at the current
    // sweep position (the unlucky case). The regression that locks the
    // landing-window gate uses a USABLE frozen heading: the walk can
    // complete IF the planner lets it land instead of yanking on the
    // OLD stream's pre-landing sweep garbage.
    // Function form (walk-absorption class, 2026-08-08): a per-walk
    // freeze — (walkIndex) => deg|null — models the sweep's unlucky
    // sampling deterministically (the first walk(s) freeze off-heading
    // into an obstacle, a later walk freezes usable). walkIndex counts
    // walk prompts that LAND.
    walkFreezeYawDeg: opts.walkFreezeYawDeg ?? null,
    walkCount: 0,
    // Obstacle absorption (2026-08-08 walk-absorption class): when a
    // navigation is provided, walk steps are nav-constrained EXACTLY like
    // the live RoomNavigationApproval (proposed → constrainMovement →
    // approved position) — motion into an obstacle AABB is REJECTED and
    // absorbed (the body stays at the boundary; absorbed++ per rejected
    // frame), mirroring navAbsorbCount live (desk1: 69 absorbs, travelM
    // 0.194 — the walk fired but never translated). Default off keeps
    // every pre-existing test's body free to walk through furniture.
    navigation: opts.navigation ?? null,
    absorbed: 0,
    step(dt) {
      this.simS += dt
      if (this.turnTarget !== null) {
        // A new turn prompt cancels any in-flight swing (the stream
        // re-anchors on the new ask).
        this.swingAt = null
        const err = wrapAngle(this.turnTarget - this.yaw)
        const maxStep = (this.turnRateDegS * dt * Math.PI) / 180
        if (Math.abs(err) <= maxStep) {
          this.yaw = this.turnTarget
          this.turnTarget = null
          if (this.swingDeg > 0) {
            this.turnSwingBase = this.yaw
            this.swingAt = this.simS + this.swingDelayS
          }
        } else {
          this.yaw += Math.sign(err) * maxStep
        }
      }
      // Turn-execution tail: override the yaw while the swing is live —
      // the walk (if any) moves at the swung heading, exactly like the
      // live stream's walk going off-heading into the coffee table.
      if (this.swingAt !== null) {
        const u = Math.max(0, Math.min(1, (this.simS - this.swingAt) / this.swingS))
        this.yaw = this.turnSwingBase + (this.swingDeg * Math.PI / 180) * Math.sin(Math.PI * u) * (1 - u)
        if (u >= 1) this.swingAt = null
      }
      // Never-settling sweep: the yaw keeps rotating after the requested
      // turn (no settle-back) until the next prompt arrives — a walk
      // prompt replaces the stream and freezes the heading (the live
      // yaw-continuity re-anchor). Only while no turn is in flight AND
      // she is not walking (the walk re-anchors the heading, so the
      // sweep belongs to turn execution alone).
      if (this.neverSettleDegS !== 0 && this.turnTarget === null && this.swingAt === null && !this.walking) {
        this.yaw = wrapAngle(this.yaw + (this.neverSettleDegS * dt * Math.PI) / 180)
      }
      if ((this.walking || this.coastLeft > 0) && this.turnTarget === null) {
        if (!this.walking) this.coastLeft = Math.max(0, this.coastLeft - dt)
        if (this.navigation) {
          // Walk-absorption model (2026-08-08): nav-constrain the step
          // like the live RoomNavigationApproval — motion that would
          // enter an obstacle AABB is rejected and ABSORBED: the body
          // does not move at all (the live treadmill folds the rejected
          // motion into the origin offset — "an absorbed frame: the
          // rejected motion never happened"). absorbed++ per rejected
          // frame mirrors live navAbsorbCount (desk1: 69 absorbs,
          // travelM 0.194 — the walk fired but never translated).
          const from = new Vector3(this.x, 0, this.z)
          const to = new Vector3(
            this.x + Math.sin(this.yaw) * this.speed * dt,
            0,
            this.z + Math.cos(this.yaw) * this.speed * dt,
          )
          const res = this.navigation.constrainMovement(from, to)
          const moved = Math.hypot(res.position.x - to.x, res.position.z - to.z)
          if (moved > 1e-6) {
            this.absorbed += 1
          } else {
            this.x = res.position.x
            this.z = res.position.z
          }
        } else {
          this.x = clamp(this.x + Math.sin(this.yaw) * this.speed * dt, bounds.minX, bounds.maxX)
          this.z = clamp(this.z + Math.cos(this.yaw) * this.speed * dt, bounds.minZ, bounds.maxZ)
        }
        this.yaw += (this.driftDegS * dt * Math.PI) / 180
      } else if (this.walkLandLeft > 0) {
        // Walk-prompt landing (2026-08-04 never-settling stream class):
        // the prompt has been sent but the new walk stream has not landed
        // yet — the body does NOT move and the yaw continues whatever the
        // OLD stream was doing (the never-settling sweep keeps sweeping).
        this.walkLandLeft = Math.max(0, this.walkLandLeft - dt)
        if (this.walkLandLeft === 0) {
          // Landing complete: the new walk stream starts — the yaw
          // re-anchors on the walk (live yaw-continuity re-anchor), the
          // body starts moving at the frozen heading (walkFreezeYawDeg,
          // the heading the walk actually moves at; null = the current
          // sweep position, the unlucky case; function = per-walk).
          this.walkCount += 1
          const freeze = typeof this.walkFreezeYawDeg === 'function'
            ? this.walkFreezeYawDeg(this.walkCount - 1)
            : this.walkFreezeYawDeg
          if (freeze !== null) {
            this.yaw = (freeze * Math.PI) / 180
          }
          this.walking = true
        }
      }
    },
  }
}

function makePlanner(manifest, navigation, channel, sim, clock, opts = {}) {
  return new GoalPlanner({
    navigation,
    manifest,
    channel,
    probe: () => ({ x: sim.x, z: sim.z, yaw: sim.yaw, navAbsorbCount: sim.absorbed }),
    nowMs: () => clock.ms,
    random: opts.random ?? (() => 0),
    essenceState: opts.essenceState ?? (() => null),
    objectState: opts.objectState,
    onInteractionComplete: opts.onInteractionComplete,
    // The sim executes turns instantly and exactly; TURN_SETTLE_S is a
    // LIVE-stream prompt-latency guard (reset chunk lands ~1.5-2.5 s after
    // send) and YAW_EMA_TAU_S smooths live root wobble. Neither exists in
    // the sim, and with the 45° turn-request ceiling exact-executor
    // convergence takes more turn steps than the old full-error ask — the
    // uncompressed pair makes the harness settle-bound (120 s goal-cap
    // timeouts), while compressing ONLY the settle desyncs the EMA from
    // the measurement window (stale-yaw wrong-direction decisions). Both
    // are compressed together, keeping their ratio. TURN_RAW_SETTLE_SPREAD_DEG
    // is the same physical quantity as the EMA lag (|raw − EMA| ≈ rate ×
    // tau): with the tau compressed 0.8 → 0.25, a moving yaw produces
    // ~1/3.2 of the live spread — the live 20° gate would read the sim's
    // turn-execution tail (spread 14-16° while swinging) as "settled" and
    // re-issue onto the moving stream, compounding the overshoot. 6° keeps
    // the discrimination: settled ≈ 0-2°, tail ≥ 14°.
    policy: {
      TURN_SETTLE_S: 1.0,
      YAW_EMA_TAU_S: 0.25,
      TURN_RAW_SETTLE_SPREAD_DEG: 6,
      // Same "moving vs settled" discriminator, snapshotted at walk-prompt
      // send: the sim's never-settling sweep (40°/s × 0.25 tau ≈ 10°
      // spread) opens the landing window; a settled handoff (~0°) stays
      // closed. Pinned to match TURN_RAW_SETTLE_SPREAD_DEG.
      WALK_LANDED_SPREAD_DEG: 6,
      ...opts.policy,
    },
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
        if (sim.walkLandS > 0) {
          // Live landing latency (2026-08-04 never-settling stream class):
          // the prompt is sent but the new walk stream takes walkLandS to
          // land — the body does not move yet, the yaw keeps sweeping.
          sim.walkLandLeft = sim.walkLandS
          sim.walking = false
        } else {
          sim.walking = true
        }
        sim.turnTarget = null
      } else if (entry.kind === 'arrive' || entry.kind === 'interact') {
        // Stop-prompt latency: the walk coasts for sim.coastS before the
        // stop takes effect (0 in every pre-existing scenario).
        if (sim.walking) sim.coastLeft = sim.coastS
        sim.walking = false
        sim.turnTarget = null
        sim.walkLandLeft = 0
      } else if (entry.kind === 'turn') {
        sim.walking = false
        sim.walkLandLeft = 0
        const deg = /(\d+)\s*degrees/.exec(entry.prompt)
        const dir = /left/.test(entry.prompt) ? 1 : -1
        const ask = deg ? Number(deg[1]) : 45
        sim.turnAskDeg = ask
        sim.turnDir = dir
        sim.turnTarget = sim.yaw + (dir * ask * Math.PI) / 180
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
  // the arrive stop prompt coasts her ~1.4 m past the spot (coast runs at
  // sim speed for the ARRIVE_PROMPT_S window: 1.0 m/s × 2.5 s ≈ 2.5 m from
  // a ~1.05 m stop distance) — decisively beyond the close-arrival accept
  // radius (CLOSE_ARRIVE_ACCEPT_M 0.75, 2026-08-08) so the re-approach
  // path is what runs. The planner must re-anchor on the ACTUAL position
  // and re-approach exactly once (shared replan budget), then proceed to
  // the interaction with the residual journaled — never an infinite
  // approach loop (MotionBricks re-anchor, spec §planner loop "arrival !=
  // motion trust"). Couch goal: the desk spot is 0.75 m from the west wall
  // — the sim's bounds clamp would swallow the overshoot right at the
  // accept boundary; the couch has 1.45 m of clearance north.
  const sim = makeSim(0, 0.15, 0, { speed: 1.0, coastS: 4.0 })
  const clock = { ms: 0 }
  const planner = makePlanner(manifest, navigation, channel, sim, clock)

  assert.equal(planner.setGoal('couch.sit'), true)
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
  assert.ok(arriveEndDist === null || arriveEndDist > 0.75,
    `the coast model must overshoot past the close-accept radius (arrive-end distance ${arriveEndDist})`)
  assert.ok(out.allPrompts.includes('a person sits on a couch'),
    'proceeds to the interaction after the budget is exhausted')
  // The approaches themselves crossed the spot (min distance), even though
  // the coast carried her past it each time.
  assert.ok(out.minDistanceM !== null && out.minDistanceM <= 0.35,
    `closest approach ${out.minDistanceM} must be ≤ 0.35`)
})

test('close arrival miss: within CLOSE_ARRIVE_ACCEPT_M the goal proceeds WITHOUT a replan', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  // Moderate stop-prompt coast: every arrive stop lands ~0.4 m past the
  // spot — an arrival miss, but inside the close-arrival accept radius
  // (0.75 m, 2026-08-08 pickup-cup bench: the arrive stop prompt itself
  // drifts the root 0.4-0.6 m off the spot, and the re-approach turn is
  // the load-fragile step). The planner must accept the near-arrival and
  // go straight to face/interact — the interaction prompt supplies the
  // motion — WITHOUT burning the goal's single replan on a re-approach
  // walk. Desk goal is fine here: the ~0.4 m overshoot stays inside the
  // 0.75 m of clearance to the west wall.
  const sim = makeSim(0, 0.15, 0, { speed: 0.6, coastS: 2.0 })
  const clock = { ms: 0 }
  const planner = makePlanner(manifest, navigation, channel, sim, clock)

  assert.equal(planner.setGoal('desk.work'), true)
  const out = drive(planner, channel, sim, clock)
  assert.equal(out.tel.goal, null, 'goal finished (not stuck re-approaching)')
  assert.equal(out.tel.lastFailure, null, `unexpected failure: ${out.tel.lastFailure}`)
  assert.equal(out.tel.replans, 0, 'a close arrival miss must not consume the replan budget')
  assert.ok(out.allPrompts.includes('a person sits at a desk working'),
    'proceeds to the interaction directly from the close-accepted arrival')
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
    probe: () => ({ x: sim.x, z: sim.z, yaw: sim.yaw, navAbsorbCount: sim.absorbed }),
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
      probe: () => ({ x: sim.x, z: sim.z, yaw: sim.yaw, navAbsorbCount: sim.absorbed }), nowMs: () => clock.ms,
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
      probe: () => ({ x: sim.x, z: sim.z, yaw: sim.yaw, navAbsorbCount: sim.absorbed }), nowMs: () => clock.ms,
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

test('essence driver: a reflex-blocked poll does NOT burn the 30s slot — the goal fires on the first clean tick (RCA t_af24521d)', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  const sim = makeSim(0, 0.15, 0)
  const clock = { ms: 0 }
  const planner = makePlanner(manifest, navigation, channel, sim, clock, {
    essenceState: () => ESSENCE_STATE({ energy: 0.2 }),
  })
  // The body is pinned against the daybed by the nav reflex (the RCA run's
  // proximate trigger) for 31 s — two poll boundaries pass while blocked.
  channel.reflexActive = true
  stepMs(clock, planner, 31_000)
  assert.equal(planner.getGoal(), null, 'reflex blocks the driver')
  let skips = planner.getTelemetry().driverSkips.essence
  assert.ok(skips.reflexWatchdog >= 1, `the gate block must be journaled, got ${JSON.stringify(skips)}`)
  assert.equal(skips.noRule, 0, 'a blocked poll is not a rule evaluation')

  // Reflex clears → the FIRST tick fires. Pre-fix the blocked polls had
  // consumed the cadence and the driver would have waited out the full 30s
  // (letting the ambient deck claim the slot meanwhile).
  const clearedAt = clock.ms
  channel.reflexActive = false
  const picked = waitForEssenceGoal(planner, clock, 10_000)
  assert.equal(picked, 'daybed.nap')
  assert.ok(clock.ms - clearedAt < 30_000,
    `fire must come from the first clean tick, not a fresh cadence (waited ${clock.ms - clearedAt}ms)`)
  assert.equal(planner.getTelemetry().goalSource.rule, 'energy-low')
})

test('essence driver: a matching rule outranks the ambient deck on the same idle tick — ambient never claims the slot (RCA t_af24521d)', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  const sim = makeSim(0, 0.15, 0)
  const clock = { ms: 0 }
  let current = null // no presence state until the seed lands at t=90s
  const planner = makePlanner(manifest, navigation, channel, sim, clock, {
    essenceState: () => current,
    random: () => 0,
  })
  // 90 s of idle: the ambient deck gate (AMBIENT_AFTER_S) opens at exactly
  // the same tick the presence seed lands — the tick where the deck would
  // otherwise claim the single goal slot after reflex-clear.
  let seeded = false
  let ticks = 0
  while (clock.ms < 200_000 && planner.getGoal() === null && ticks++ < 5000) {
    clock.ms += 100
    if (clock.ms >= 90_000 && !seeded) {
      seeded = true
      current = ESSENCE_STATE({ energy: 0.2 })
    }
    planner.update(0.1)
  }
  assert.ok(seeded)
  assert.equal(planner.getGoal(), 'daybed.nap', 'the essence driver claims the slot on the seed tick')
  const tel = planner.getTelemetry()
  assert.equal(tel.goalSource.rule, 'energy-low', 'the goal is essence-driven, not deck')
  assert.equal(tel.ambient.lastGoal, null, 'the ambient deck never picked (essence outranks it)')
  const skips = tel.driverSkips.essence
  assert.ok(skips.noState > 0, `pre-seed evaluations are journaled as no-state: ${JSON.stringify(skips)}`)
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

// ── interaction-completion hook (spatial layer 5) ─────────────────

test('onInteractionComplete fires once when a goal completes with its interaction played', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  const sim = makeSim(0, 0.15, 0)
  const clock = { ms: 0 }
  const completed = []
  const planner = makePlanner(manifest, navigation, channel, sim, clock, {
    onInteractionComplete: (id, interaction) =>
      completed.push([id, interaction.kind, interaction.prompt]),
  })

  planner.setGoal('desk.work')
  const out = drive(planner, channel, sim, clock)
  assert.equal(out.tel.lastFailure, null)
  assert.equal(completed.length, 1, 'hook fires exactly once')
  assert.deepEqual(completed[0], ['desk.work', 'sit', 'a person sits at a desk working'])
})

test('cup.pickup resolves through the planner and the hook carries the attach spec', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  const sim = makeSim(0, 0.15, 0)
  const clock = { ms: 0 }
  const completed = []
  const planner = makePlanner(manifest, navigation, channel, sim, clock, {
    onInteractionComplete: (id, interaction) => completed.push([id, interaction.kind, interaction.attach]),
  })

  assert.equal(planner.setGoal('cup.pickup'), true)
  const out = drive(planner, channel, sim, clock)
  assert.equal(out.tel.lastFailure, null)
  assert.ok(out.allPrompts.includes('a person picks up a cup from the table'))
  assert.equal(completed.length, 1)
  assert.equal(completed[0][0], 'cup.pickup')
  assert.equal(completed[0][1], 'pickup')
  assert.deepEqual(completed[0][2], { bone: 'rightHand', offset: [0, 0.05, 0] })
})

test('onInteractionComplete does NOT fire on clear / user-cancel / timeout', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)

  // clear
  {
    const channel = makeChannel()
    const sim = makeSim(0, 0.15, 0)
    const clock = { ms: 0 }
    const completed = []
    const planner = makePlanner(manifest, navigation, channel, sim, clock, {
      onInteractionComplete: (id) => completed.push(id),
    })
    planner.setGoal('desk.work')
    planner.clearGoal()
    stepMs(clock, planner, 2000)
    assert.equal(planner.getGoal(), null)
    assert.equal(completed.length, 0, 'cleared goal must not fire the hook')
  }

  // user cancel mid-goal (priority model: user intent cancels, journaled)
  {
    const channel = makeChannel()
    const sim = makeSim(0, 0.15, 0)
    const clock = { ms: 0 }
    const completed = []
    const planner = makePlanner(manifest, navigation, channel, sim, clock, {
      onInteractionComplete: (id) => completed.push(id),
    })
    planner.setGoal('desk.work')
    stepMs(clock, planner, 1000)
    channel.userPromptAtMs = clock.ms
    stepMs(clock, planner, 2000)
    assert.equal(planner.getGoal(), null)
    assert.equal(completed.length, 0, 'user-cancelled goal must not fire the hook')
  }

  // goal-cap timeout (never reached the interaction)
  {
    const channel = makeChannel()
    const sim = makeSim(0, 0.15, 0)
    const clock = { ms: 0 }
    const completed = []
    const planner = makePlanner(manifest, navigation, channel, sim, clock, {
      onInteractionComplete: (id) => completed.push(id),
      policy: { MAX_GOAL_SECONDS: 1 },
    })
    planner.setGoal('desk.work')
    stepMs(clock, planner, 5000)
    assert.equal(planner.getGoal(), null)
    assert.ok(planner.getTelemetry().lastFailure, 'must fail with a journaled reason')
    assert.equal(completed.length, 0, 'timed-out goal must not fire the hook')
  }
})

// ── requires gate + sets transition (spatial layer 5, door slice) ──

/** door_01 manifest fixture (same geometry as rooms/tai-loft.json). */
function doorManifest() {
  return {
    manifest_version: '1.1',
    room_id: 'tai-loft',
    name: 'The Synthesis Loft',
    bounds: { minX: -3.65, maxX: 3.65, minZ: -3.65, maxZ: 3.65 },
    obstacles: [],
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

/** Register door_01's stateful obstacle exactly like the scene does. */
function addDoorObstacle(navigation, manifest) {
  const door = manifest.objects.find((o) => o.id === 'door_01')
  navigation.addBoxObstacle(
    door.id,
    new Vector3(door.obstacle.center[0], 0, door.obstacle.center[1]),
    new Vector3(door.obstacle.halfSize[0] * 2, 1, door.obstacle.halfSize[1] * 2),
    door.obstacle.padding,
  )
}

test('requires gate: door_01.open is refused while the door is open (journaled)', async () => {
  const { manifest } = parseSceneManifest(doorManifest())
  assert.ok(manifest)
  const navigation = RoomNavigation.fromManifest(manifest, 0.22)
  addDoorObstacle(navigation, manifest)
  const channel = makeChannel()
  const sim = makeSim(0, 0.15, 0)
  const clock = { ms: 0 }
  const machine = new InteractableStateMachine(manifest, () => clock.ms)
  // Flip the machine to open (a completed open interaction did it).
  const door = manifest.objects[0]
  machine.applySets(door, door.interactions.find((i) => i.id === 'open'))
  assert.equal(machine.stateOf('door_01'), 'open')
  const planner = makePlanner(manifest, navigation, channel, sim, clock, {
    objectState: (id) => machine.stateOf(id),
  })

  assert.equal(planner.setGoal('door_01.open'), false)
  assert.equal(planner.getGoal(), null)
  assert.match(planner.getTelemetry().lastFailure ?? '', /requires "closed"/)
  assert.match(planner.getTelemetry().lastFailure ?? '', /is open/)
  // Journaled in the prompt log (GEVS-visible evidence).
  assert.ok(planner.getTelemetry().promptLog.some((e) => e.prompt.includes('refused')), 'refusal journaled')
  // The still-valid close interaction goes through.
  assert.equal(planner.setGoal('door_01.close'), true)
})

test('requires gate: fail-closed without a state provider (unknown state → refused)', async () => {
  const { manifest } = parseSceneManifest(doorManifest())
  assert.ok(manifest)
  const navigation = RoomNavigation.fromManifest(manifest, 0.22)
  const channel = makeChannel()
  const sim = makeSim(0, 0.15, 0)
  const clock = { ms: 0 }
  const planner = makePlanner(manifest, navigation, channel, sim, clock) // no objectState

  assert.equal(planner.setGoal('door_01.open'), false)
  assert.match(planner.getTelemetry().lastFailure ?? '', /is unknown/)
})

test('door_01.open completes → onInteractionComplete fires and the machine transitions closed → open', async () => {
  const { manifest } = parseSceneManifest(doorManifest())
  assert.ok(manifest)
  const navigation = RoomNavigation.fromManifest(manifest, 0.22)
  addDoorObstacle(navigation, manifest)
  const channel = makeChannel()
  const sim = makeSim(0, 0.15, 0)
  const clock = { ms: 0 }
  const machine = new InteractableStateMachine(manifest, () => clock.ms)
  const completed = []
  const planner = makePlanner(manifest, navigation, channel, sim, clock, {
    objectState: (id) => machine.stateOf(id),
    // Scene contract: the real handler (TaiRoomScene.handleInteractionComplete)
    // applies the sets transition here — mesh + nav effects are scene-side.
    onInteractionComplete: (interactionId, interaction) => {
      completed.push({ interactionId, interaction })
      machine.applySets(manifest.objects[0], interaction)
    },
  })

  assert.equal(planner.setGoal('door_01.open'), true)
  const out = drive(planner, channel, sim, clock)
  assert.equal(out.tel.lastFailure, null, `unexpected failure: ${out.tel.lastFailure}`)
  // The interaction prompt actually played.
  assert.ok(out.allPrompts.includes('a person opens a door'))
  // Completion hook fired exactly once with the full interaction id.
  assert.equal(completed.length, 1)
  assert.equal(completed[0].interactionId, 'door_01.open')
  assert.equal(completed[0].interaction.id, 'open')
  // The sets transition applied: machine now says open, journaled.
  assert.equal(machine.stateOf('door_01'), 'open')
  assert.deepEqual(machine.journal().map((e) => [e.objectId, e.from, e.to]), [['door_01', 'closed', 'open']])
  // The planner itself never touches navigation state — the scene's
  // applyObjectStateEffects toggles the obstacle (out of scope here).
  assert.equal(navigation.listObstacles().find((o) => o.id === 'door_01').enabled, true)
})

// ── drift class: turn-execution tail (live walk drift) ─────────────

test('drift class: a turn whose raw yaw keeps rotating past the target after the settle window must not start the walk off-heading — the goal completes under reflex churn', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  // Live-stream turn-execution tail (2026-08-03 drift class): the live
  // ARDY stream executes a turn ask at 79-240% of the request — the raw
  // yaw holds at the requested heading briefly (EMA reads aligned), then
  // swings PAST it (up to turnSwingDeg, damped back over turnSwingS).
  // A walk prompt sent during that swing goes off-heading into the
  // nearest obstacle — the live failure (4/4 completion-fail, walk into
  // the coffee table / daybed, navAbsorbs 24-53, "blocked path after 1
  // replan").
  const sim = makeSim(0, 0.15, 0, {
    turnSwingDeg: 90,
    turnSwingS: 2,
    turnSwingDelayS: 0.8,
  })
  const clock = { ms: 0 }
  const planner = makePlanner(manifest, navigation, channel, sim, clock)
  assert.equal(planner.setGoal('desk.work'), true)
  let reflexFired = false
  let firstWalkMs = null
  const out = drive(planner, channel, sim, clock, {
    beforeEach(ms, _planner, ch, _sim) {
      // Simulated reflex churn: one nav-reflex reaction DURING the walk,
      // 4 s after the first walk prompt (the turn-execution swing has
      // settled by then — the live reflex fires mid-walk, after the
      // off-heading walk bumps the coffee table). The walk freezes for
      // 2.5 s, then resumes (the reflex layer's restore re-issues the
      // segment).
      const tel = _planner.getTelemetry()
      if (firstWalkMs === null && tel.promptLog.some((e) => e.kind === 'walk')) firstWalkMs = ms
      if (!reflexFired && firstWalkMs !== null && ms >= firstWalkMs + 4000) {
        reflexFired = true
        ch.reflexActive = true
      }
      if (reflexFired && ch.reflexActive && firstWalkMs !== null && ms >= firstWalkMs + 6500) {
        ch.reflexActive = false
      }
    },
  })
  assert.equal(reflexFired, true, 'reflex churn actually fired')
  // The goal completes despite the execution tail + reflex churn: no
  // failure, the interaction prompt played.
  assert.equal(out.tel.lastFailure, null, `goal must complete: ${out.tel.lastFailure}`)
  assert.ok(out.allPrompts.includes('a person sits at a desk working'), 'interaction prompt played')
  assert.ok(out.tel.promptLog.some((e) => e.prompt.includes('desk.work') && e.prompt.includes('failed')) === false)
})

test('drift class: a turn whose raw yaw NEVER settles (continuous stream sweep) must not deadlock the goal — the bounded turn phase hands off to the walk (walk prompts fire, the turn phase cannot hold forever)', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  // Live stream, 2026-08-04 drift class (desk1/desk2 tels): after a turn
  // ask the yaw does NOT settle — it sweeps 0°→180° continuously for
  // 68+ s with zero prompts in flight. At 40°/s the sweep crosses the
  // raw gate's 25° tolerance in ~1.25 s (< the 1.5 s hold), and the
  // |raw − EMA| spread (≈ rate × tau = 10°) exceeds the 6° settle-spread
  // gate, so the reissue budget never exhausts and the raw gate holds
  // FOREVER — the 20 s TARGET watchdog then consumes the goal's single
  // replan on a TURN stall (measured live: desk1 travelM 0.224, never
  // walked; desk2 68 s of silence then fail). The bounded turn phase
  // (TURN_PHASE_MAX_S) must hand off to the walk — the walk prompt
  // freezes the heading (live yaw-continuity re-anchor) and the walk
  // phase's steering + lateral gate own the residual. The class lock:
  // PRE-FIX the turn phase holds until the watchdog fails the goal with
  // ZERO walk prompts ever sent; POST-FIX the walk prompt fires (the
  // handoff happened) and the goal ends bounded — completed, or
  // journaled-failed by the WALK machinery, never by a turn deadlock.
  const sim = makeSim(0, 0.15, 0, { neverSettleDegS: 40 })
  const clock = { ms: 0 }
  const planner = makePlanner(manifest, navigation, channel, sim, clock)
  assert.equal(planner.setGoal('desk.work'), true)
  const out = drive(planner, channel, sim, clock)
  assert.equal(out.tel.goal, null, 'goal ended (bounded — not a turn-phase hang)')
  assert.ok(out.walkPrompts.length > 0, `walk prompt fired (turn phase handed off): ${out.walkPrompts.join(' | ')}`)
  // The handoff is the fix: pre-fix, no walk prompt ever fires (the raw
  // gate holds the turn phase until the watchdog consumes the replan).
  assert.ok(
    out.tel.lastFailure === null || /blocked path|no path|timed out/.test(out.tel.lastFailure ?? ''),
    `failure (if any) is a WALK-phase outcome, never a turn deadlock: ${out.tel.lastFailure}`,
  )
})

test('drift class: the walk prompt must land before steering can interrupt it — a never-settling stream completes instead of oscillating turn↔walk forever (landing-window gate)', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  // Live desk2 (2026-08-04, load 14.45): the turn phase capped at 10 s
  // (yaw never settles — the sweep runs the whole goal), handed off to
  // the walk, and the walk prompt was yanked back into turn on the SAME
  // tick: the steering check read the OLD stream's pre-landing heading
  // (the walk prompt takes 1.5-2.5 s to REPLACE the old stream) and
  // declared a >60° error the walk never had a chance to fix. The
  // oscillation burned the route-length watchdog budget, consumed the
  // goal's single replan on a turn↔walk churn, and the goal failed with
  // travelM 3.36 and zero completion. Model: neverSettleDegS keeps the
  // yaw sweeping during turn phases (live: 0°→180° for 68+ s) AND
  // walkLandS delays the walk's body motion (live: the reset chunk
  // lands 1.5-2.5 s after send) while the yaw keeps sweeping — the
  // same-tick steering check then reads sweep garbage exactly like the
  // live stream. WALK_SETTLE_S must hold the steering decision until
  // the walk stream lands and the yaw re-anchors on the walk.
  // walkFreezeYawDeg: -100 = a USABLE frozen heading (live desk2: the
  // walk at 42° error moved her 4.2 → 1.2 m) — the direction of the
  // desk's single path waypoint (-2.83, -0.35) from the start position
  // (0, 0.15). The walk CAN complete if the planner lets it land
  // instead of yanking on the pre-landing sweep garbage; a random
  // sweep freeze (walkFreezeYawDeg: null) models the degenerate case
  // that must NOT be the regression's subject.
  const sim = makeSim(0, 0.15, 0, { neverSettleDegS: 40, walkLandS: 2.2, walkFreezeYawDeg: -100 })
  const clock = { ms: 0 }
  const planner = makePlanner(manifest, navigation, channel, sim, clock)
  assert.equal(planner.setGoal('desk.work'), true)
  const out = drive(planner, channel, sim, clock)
  // The goal completes: the walk prompt landed, the body moved, the
  // walk machinery (steering + lateral gate + arrival) owned the
  // residual instead of the turn↔walk oscillation.
  assert.equal(out.tel.lastFailure, null, `goal must complete: ${out.tel.lastFailure}`)
  assert.ok(out.allPrompts.includes('a person sits at a desk working'), 'interaction prompt played')
  // The walk phase must have moved the body — multiple walk prompts,
  // none yanked before it could land.
  assert.ok(out.walkPrompts.length > 0, `walk prompts fired: ${out.walkPrompts.join(' | ')}`)
})

test('drift class: stalled walks still fail as blocked after the raw-settle gate (no false completion)', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  // Frozen stream: turns settle exactly, but walking makes no progress —
  // the raw-settle gate must NOT mask the blocked-path failure (the
  // pre-existing behavior is preserved: one replan, then fail).
  const sim = makeSim(0, 0.15, 0, { speed: 0 })
  const clock = { ms: 0 }
  const planner = makePlanner(manifest, navigation, channel, sim, clock)

  planner.setGoal('desk.work')
  const out = drive(planner, channel, sim, clock)
  assert.equal(out.tel.goal, null)
  assert.match(out.tel.lastFailure ?? '', /blocked path.*1 replan/)
  assert.equal(out.walkPrompts.length, 2, `walk prompts: ${out.walkPrompts.join(' | ')}`)
})

// ── walk-absorption class (2026-08-08 positional class, live desk1) ─

test('walk-absorption class: a walk frozen into an obstacle (nav rejects every frame) must re-aim on the reflex instead of pressing forever — the goal completes (live: walk fires, navAbsorbs 69, travelM 0.194, "blocked path after 1 replan")', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  // Live desk1 (2026-08-08, HEAD 2081c9d6): walkPromptCount=9 fired but
  // travelM=0.194 with navAbsorbs=69 — the walk froze at a sweep-garbage
  // heading that clipped the coffee table 0.27 m north of spawn, the nav
  // absorbed every frame (treadmill — the rejected motion never
  // happened), and the stall detector consumed the goal's single replan
  // ("blocked path after 1 replan — no progress toward spot"). This is
  // the POSITIONAL absorption class — distinct from the yaw-settle class
  // the other drift regressions lock (those sims walk THROUGH obstacles;
  // this one constrains the body like the live RoomNavigationApproval).
  //
  // Model: navigation-aware sim (walk steps are nav-constrained — motion
  // into an obstacle AABB is rejected and ABSORBED: the body does not
  // translate, exactly the live treadmill). Spawn sits just SOUTH of the
  // coffee table's padded AABB edge (z=0.40; the AABB's z-min is 0.42)
  // and the frozen walk heading is -55° (north-west): the FIRST step
  // enters the AABB and is rejected — the body never moves, so BOTH
  // steering gates stay silent (the coarse gate reads 50° < 60° heading
  // error to the desk; the moving-body lateral gate needs movedM > 0.02
  // which an absorbed body never has). The reflex layer's reaction
  // (sustained rejection fires one 3 s reaction prompt, then the walk is
  // restored) is the planner's ONLY signal of the absorption. The
  // reflex-clear edge must re-aim (turn toward the waypoint) instead of
  // re-pressing the wall. The frozen heading is a FUNCTION of walk
  // index: walks 0-3 freeze at -55° (absorbed; models the sweep
  // sampling the blocked cone across re-aim cycles AND the no-fix
  // replan), walk 4+ freezes at -105° (the usable desk bearing — a
  // re-aimed turn converges there).
  const sim = makeSim(0, 0.40, 0, {
    navigation,
    // Live landing latency: the walk prompt's reset chunk takes ~2.2 s
    // to land, and the frozen heading is applied AT landing (the
    // yaw-continuity re-anchor) — without this the drive loop starts
    // walking immediately at the pre-walk yaw and the freeze never
    // applies (the absorption class never happens).
    walkLandS: 2.2,
    walkFreezeYawDeg: (n) => (n < 4 ? -55 : -105),
  })
  const clock = { ms: 0 }
  const planner = makePlanner(manifest, navigation, channel, sim, clock)
  assert.equal(planner.setGoal('desk.work'), true)
  // Reflex driver: the ArdyMotionSource reflex layer fires on sustained
  // rejection (rejectAccum ≥ TRIGGER_ACCUM_M ≈ 0.15 m ≈ a few absorbed
  // frames) — model it as one 3 s reaction per absorption episode (the
  // walk is held, then restored), with the live 5 s cooldown.
  let reflexFiredAtMs = -Infinity
  let absorbedSeen = 0
  const out = drive(planner, channel, sim, clock, {
    beforeEach(ms, _planner, ch, s) {
      if (s.absorbed > absorbedSeen && !ch.reflexActive && ms - reflexFiredAtMs >= 5000) {
        absorbedSeen = s.absorbed
        ch.reflexActive = true
        reflexFiredAtMs = ms
      }
      if (ch.reflexActive && ms - reflexFiredAtMs >= 3000) {
        ch.reflexActive = false
      }
    },
  })
  // The class actually happened: walks fired and the nav absorbed the
  // motion (the walk prompt alone is not the class — the rejection is).
  assert.ok(sim.absorbed > 0, `the walk was nav-absorbed (absorbed=${sim.absorbed})`)
  assert.ok(out.walkPrompts.length > 0, `walk prompts fired: ${out.walkPrompts.join(' | ')}`)
  // The fix: the goal completes despite the absorbed walks — the
  // reflex-clear re-aim re-aims at the waypoint instead of pressing.
  assert.equal(out.tel.lastFailure, null, `goal must complete: ${out.tel.lastFailure}`)
  assert.ok(out.allPrompts.includes('a person sits at a desk working'), 'interaction prompt played')
})

test('graze-absorption class (NO reflex): a walk absorbed frame-by-frame with the reflex layer silent must re-aim on the absorption counter and complete — the stall replan is preserved for a real blockage (live r2: 129 absorbs, walkPromptCount 14, travelM 1.05, no reflex line, "blocked path after 1 replan")', async () => {
  const manifest = await loadManifest()
  const navigation = makeNavigation(manifest)
  const channel = makeChannel()
  // Same wall as the reflex-class test — spawn just south of the coffee
  // table's padded AABB, walk heading frozen into it — but the reflex
  // layer NEVER fires (the live slow-graze: the reflex accumulator leaks
  // below trigger on intermittent rejection, so the planner gets no
  // reflex edge at all — r2's 129 absorbs produced zero reflex lines).
  // Every walk freezes at -55° (the sweep's unlucky sampling persists
  // across re-aims AND the replan — live r2's replanned walk pressed the
  // same wall) until walk 4+ freezes at the usable desk bearing (-105°).
  // The absorption counter is the planner's ONLY signal of the rejection.
  const sim = makeSim(0, 0.40, 0, {
    navigation,
    walkLandS: 2.2,
    walkFreezeYawDeg: (n) => (n < 4 ? -55 : -105),
  })
  const clock = { ms: 0 }
  const planner = makePlanner(manifest, navigation, channel, sim, clock)
  assert.equal(planner.setGoal('desk.work'), true)
  // No reflex model: the channel never goes active — the walk is
  // re-aimed by the absorption counter alone, and the goal's single
  // replan is never spent on the same wall.
  const out = drive(planner, channel, sim, clock)
  assert.ok(sim.absorbed > 0, `the walk was nav-absorbed (absorbed=${sim.absorbed})`)
  assert.equal(channel.reflexActive, false, 'the reflex never fired (graze class)')
  assert.ok(out.walkPrompts.length > 2, `re-aimed walks fired: ${out.walkPrompts.join(' | ')}`)
  assert.equal(out.tel.lastFailure, null, `goal must complete: ${out.tel.lastFailure}`)
  assert.ok(out.allPrompts.includes('a person sits at a desk working'), 'interaction prompt played')
})
