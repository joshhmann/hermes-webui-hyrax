/**
 * GoalPlanner — intents to motion sequences (spatial layer 3b).
 *
 * Spec: docs/gestalt-vn/specs/GOAL_PLANNER_SPEC.md
 *
 * A goal is `{ interaction: <object id>.<interaction id> }` resolved from the
 * scene manifest's objects[].interactions[] vocabulary (spot + facingDeg +
 * motion prompt). The planner:
 *
 *   1. plans an obstacle-aware path over RoomNavigation's existing grid
 *      (planRoute — the A* grid + two-hop/perimeter fallbacks; waypoint
 *      following never cuts through obstacle AABBs),
 *   2. walks turn-then-walk segments, re-anchoring EVERY segment on the
 *      ACTUAL root probe (rig XZ + yaw) — never dead-reckon: turn prompts
 *      are re-measured against live yaw, walk progress against live XZ,
 *   3. on arrival (≤ ARRIVE_TOLERANCE_M of the interaction's RESOLVED
 *      standing point — the authored spot may sit inside a collision AABB,
 *      e.g. the daybed's spot is its center), plays one arrive stop prompt,
 *      turns to the interaction facing, plays the interaction's motion
 *      prompt for its duration, then completes and returns to ambient.
 *
 * Priority extends the reflex layer exactly (watchdog > user > reflex >
 * planner > ambient):
 *  - USER prompt cancels the active goal (journaled, no queue) — detected
 *    via the channel's lastUserPromptAtMs (planner prompts go through
 *    sendPlannerPrompt and never bump it);
 *  - REFLEX interrupts a segment: while a reaction plays, the planner sends
 *    nothing and freezes segment timers; the reflex layer's restore
 *    re-issues the planner's segment prompt, so the segment resumes with no
 *    planner action needed;
 *  - WATCHDOG hold suspends the planner (no sends, timers frozen); the goal
 *    resumes or is abandoned on recovery (user prompt during the hold still
 *    cancels);
 *  - AMBIENT idle driver is the lowest owner: after AMBIENT_AFTER_S of no
 *    prompt activity it picks a weighted goal from the tiny deck (data,
 *    per-goal cooldowns) and lets the planner execute it — the v1 alive-proof.
 *
 * Segment prompts are VARIANTS (2-4 per kind — walk/turn/arrive, data),
 * rotated deterministically seeded by the goal id, so a long walk never
 * plays the same animation loop forever.
 */
import { Vector3 } from 'three'

import type { RoomNavigation } from '../navigation/RoomNavigation'
import type { SceneInteraction, SceneManifest } from '../room/sceneManifest'

export type PlannerSegmentKind = 'walk' | 'turn' | 'arrive'
export type PlannerPromptKind = PlannerSegmentKind | 'interact'
export type PlannerPhase = 'planning' | 'turn' | 'walk' | 'arrive' | 'face' | 'interact' | 'done'
export type PlannerGoalSource = 'debug' | 'ambient'

/** Prompt variants per segment kind. Turn templates take {dir}/{deg} slots. */
export interface PlannerVariants {
  walk: readonly string[]
  turn: readonly string[]
  arrive: readonly string[]
}

export interface AmbientDeckEntry {
  goal: string
  weight: number
  cooldownS: number
}

/**
 * All planner policy as data (mirrors the ARDY_REFLEX block pattern).
 * Thresholds/variants/deck/cooldowns live here, never in code.
 */
export interface GoalPlannerPolicy {
  /** Arrival radius (m) around the resolved standing point (spec: 0.35). */
  ARRIVE_TOLERANCE_M: number
  /** Heading error (deg) above which a turn segment precedes a walk. */
  HEADING_ERROR_TURN_DEG: number
  /** Heading/facing error (deg) at which a turn segment is accepted. */
  TURN_TOLERANCE_DEG: number
  /** Max turn re-issues per turn segment. Bounds a non-responding stream;
   * sized for the 45° request ceiling (a 180° error needs 4 steps). */
  MAX_TURN_REISSUES: number
  /** Wait (s) after a turn prompt before measuring the result. The prompt's
   * reset chunk lands ~1.5-2.5 s after send (measured live 2026-08-02) and
   * the yaw mid-execution is spin garbage (swings ±70° around the target
   * through the T2 crossfade); measuring before the settle reads the OLD
   * stream's heading and declares false alignment mid-spin. */
  TURN_SETTLE_S: number
  /** Ceiling (deg) on a single turn request — asks past 45° are
   * direction-UNRELIABLE live (60-90° "left" landed right in every sniff
   * trial); at/below 45° the re-measure loop converges (see turnAskDeg). */
  TURN_REQUEST_MAX_DEG: number
  /** No steering turns within this distance (m) of the current waypoint —
   * unless she is facing AWAY from it (|err| ≥ 90°, walking would open the
   * distance): this close, heading error is mostly lateral-offset noise
   * (a 0.1 m offset reads as a huge angle) and the arrival radius takes
   * over. Live evidence both ways: a 0.49 m miss with 74° error made the
   * pre-exemption planner turn her AWAY from the desk (so the zone exists),
   * but a 1.0 m zone made the arrival re-approach unwalkable — stopping
   * ~1 m out with 60-89° of error forced a walk in a wrong direction and
   * rosetted until the goal failed (2026-08-02 e2e, three separate runs).
   * 0.5 m keeps the noise exemption where it belongs and lets 0.5-1 m
   * re-approaches steer. */
  WALK_NO_TURN_M: number
  /** Wrap-aware EMA time constant (s) for the measured yaw. The live root
   * yaw wobbles ±70° around the settled heading during/after turns and
   * walks curve ~10-16°/s (mocap drift, T1); single-sample heading
   * decisions read garbage, so every steering/facing decision measures the
   * smoothed heading instead. */
  YAW_EMA_TAU_S: number
  /** Debounce (s) in the face phase: after the smoothed facing error
   * converges, hold before playing the interaction so the RAW yaw settles
   * next to the smoothed value (the honest-facing sample the GEVS reads). */
  FACE_HOLD_S: number
  /** Radius (m) around the current waypoint that ends a walk segment. */
  WALK_WAYPOINT_ARRIVE_M: number
  /** Path smoothing: merge a non-final waypoint closer than this (m) when
   * the direct segment to the next waypoint is verified clear. */
  SMOOTH_SKIP_M: number
  /** Braking lead: seconds of closing motion to anticipate when triggering
   * the arrive stop on the FINAL waypoint. Arrival != motion trust — the
   * stop prompt takes ~1-1.5 s to take effect (prompt → service reset → new
   * stream), and a walk at 0.5 m/s coasts ~1 m in that window (measured
   * live 2026-08-02: arrival triggered at 0.35 m while moving read 1.3 m at
   * the interaction). The final-waypoint arrival radius is
   * ARRIVE_TOLERANCE_M + min(closingSpeed × ARRIVE_LEAD_S, ARRIVE_LEAD_MAX_M),
   * so a fast approach stops early and coasts ONTO the spot. */
  ARRIVE_LEAD_S: number
  /** Cap (m) on the braking lead above the arrival tolerance. */
  ARRIVE_LEAD_MAX_M: number
  /** Net progress (m) below which a walk is considered stalled. */
  STALL_PROGRESS_EPS_M: number
  /** No net progress for this long (s) → replan once, then fail. */
  WALK_STALL_S: number
  /** No net progress toward the TARGET for this long (s), across waypoints
   * and turn/walk oscillation → replan once, then fail with reason. The
   * per-waypoint WALK_STALL_S is blind to wandering with sporadic progress
   * (measured live: a steering oscillation near the west wall improved the
   * waypoint distance every few seconds while never converging — the goal
   * wandered to its 120 s timeout instead of failing as blocked). 30 s
   * leaves room for a near-target turn hunt (2-3 capped turn re-aims plus
   * walk legs at stream pace) before declaring the block. */
  TARGET_STALL_S: number
  /** Max path replans per goal (spec: one replan, then fail with reason). */
  MAX_WALK_REPLANS: number
  /** Rotate the walk prompt variant every this many seconds of walking. */
  WALK_PROMPT_ROTATE_S: number
  /** How long the arrive stop prompt plays (s). */
  ARRIVE_PROMPT_S: number
  /** How long the interaction prompt plays before the goal completes (ms). */
  INTERACTION_MS: number
  /** Cap on the whole goal (s) — a goal that cannot finish fails with reason. */
  MAX_GOAL_SECONDS: number
  /** Prompt journal size kept in telemetry (oldest dropped). */
  PROMPT_LOG_CAP: number
  /** Ambient idle driver: idle this long (s) before picking a deck goal. */
  AMBIENT_AFTER_S: number
  /** Ambient deck (data): weighted goals with per-goal cooldowns. */
  AMBIENT_DECK: readonly AmbientDeckEntry[]
  /** Segment prompt variants (data; rotated seeded by goal id). */
  PROMPTS: PlannerVariants
}

export const GOAL_PLANNER: GoalPlannerPolicy = {
  ARRIVE_TOLERANCE_M: 0.35,
  // Steering is COARSE on purpose (calibrated live 2026-08-02, trace + GEVS
  // runs): the stream's walks curve ~10-16°/s and turns execute 79-240% of
  // the request, so a 30° re-steer threshold fires every ~2 s, each
  // correction overshoots, and the heading never converges (measured:
  // left/right alternation, goal left incomplete). 60° tolerates the walk
  // drift (≈4-5 s of straight progress per segment) while the stall
  // detector + replan handle true blocks, and 90°-capped requests bound
  // the overshoot damage.
  HEADING_ERROR_TURN_DEG: 60,
  TURN_TOLERANCE_DEG: 20,
  TURN_SETTLE_S: 3.0,
  TURN_REQUEST_MAX_DEG: 45,
  MAX_TURN_REISSUES: 4,
  WALK_NO_TURN_M: 0.5,
  YAW_EMA_TAU_S: 0.8,
  FACE_HOLD_S: 1.5,
  WALK_WAYPOINT_ARRIVE_M: 0.3,
  SMOOTH_SKIP_M: 1.2,
  ARRIVE_LEAD_S: 1.2,
  ARRIVE_LEAD_MAX_M: 0.7,
  STALL_PROGRESS_EPS_M: 0.02,
  WALK_STALL_S: 6,
  TARGET_STALL_S: 20,
  MAX_WALK_REPLANS: 1,
  WALK_PROMPT_ROTATE_S: 12,
  ARRIVE_PROMPT_S: 2.5,
  INTERACTION_MS: 20000,
  MAX_GOAL_SECONDS: 120,
  PROMPT_LOG_CAP: 32,
  AMBIENT_AFTER_S: 90,
  AMBIENT_DECK: [
    { goal: 'daybed.nap', weight: 1, cooldownS: 180 },
    { goal: 'couch.sit', weight: 2, cooldownS: 150 },
    { goal: 'desk.work', weight: 2, cooldownS: 150 },
  ],
  PROMPTS: {
    walk: [
      'a person walks forward with steady steps',
      'a person walks ahead calmly',
      'a person strolls forward, taking their time',
    ],
    turn: [
      'a person turns {dir} about {deg} degrees',
      'a person pivots {dir} roughly {deg} degrees',
      'a person turns {dir}, about {deg} degrees',
    ],
    arrive: [
      // In-place stops, NOT "steps up and halts" variants: the arrive prompt
      // plays right at the spot, and stepping variants carried her ~0.5 m
      // PAST it before stopping (measured live 2026-08-02: 0.22 m at arrival
      // → 0.89 m at interaction start — an honest arrival metric fails on
      // prompt-induced overshoot, not on planner error).
      'a person stops walking and stands still',
      'a person comes to a halt, standing relaxed',
      'a person stops and stands, catching her breath',
    ],
  },
}

/**
 * The prompt channel the planner speaks through. ArdyMotionSource satisfies
 * this structurally (sendPlannerPrompt + the three state getters) — the
 * planner never touches the source's internals, and the source owns the
 * priority model (watchdog gate, reflex, user prompts).
 */
export interface PlannerPromptChannel {
  /**
   * Send a prompt as the planner's INTENT: updates the intent/restore
   * target (so a reflex restore or reconnect re-kick resumes the planner's
   * segment) but must NOT cancel an active reflex or watchdog hold.
   */
  sendPlannerPrompt(text: string): void
  /** True while a reflex reaction prompt is playing (planner must wait). */
  isReflexActive(): boolean
  /** True while the drift watchdog holds the pose (planner suspends). */
  isWatchdogHolding(): boolean
  /** Wall-clock ms of the last USER/shuffle prompt (planner prompts excluded). */
  lastUserPromptAtMs(): number
}

/** ACTUAL root state probe — never dead-reckon. */
export interface PlannerRootProbe {
  x: number
  z: number
  yaw: number
}

export interface PlannerPromptLogEntry {
  t: number
  kind: PlannerPromptKind
  prompt: string
}

export interface GoalPlannerTelemetry {
  goal: string | null
  phase: PlannerPhase | null
  /** Distance (m) from the ACTUAL root to the goal's resolved standing point. */
  distanceToSpot: number | null
  /** |error| (deg) between the actual facing and the interaction facing. */
  facingErrDeg: number | null
  /** Path replans used by the current/last goal. */
  replans: number
  /** Journaled failure reason of the last failed goal (null when none). */
  lastFailure: string | null
  /** Every prompt the planner sent (capped; proof for the GEVS prompt log). */
  promptLog: readonly PlannerPromptLogEntry[]
  ambient: { lastGoal: string | null; lastGoalAtMs: number | null }
}

export interface GoalPlannerOptions {
  navigation: RoomNavigation
  manifest: SceneManifest
  channel: PlannerPromptChannel
  /** ACTUAL root probe (rig scene position + yaw). */
  probe: () => PlannerRootProbe
  /** Wall clock override (tests). */
  nowMs?: () => number
  /** RNG override (tests — ambient deck picks). */
  random?: () => number
  /** Policy override (tests — deterministic timing). */
  policy?: Partial<GoalPlannerPolicy>
}

interface ActiveGoal {
  id: string
  interaction: SceneInteraction
  target: Vector3
  path: Vector3[]
  source: PlannerGoalSource
  startedAtMs: number
  phase: PlannerPhase
  phaseStartedAtMs: number
  waypointIndex: number
  variantSeed: number
  variantUse: Record<PlannerSegmentKind, number>
  turnReissues: number
  replans: number
  sentPrompt: string | null
  /** Wall clock when the current turn prompt was SENT (settle window). */
  turnSentAtMs: number
  /** Face phase: when the smoothed facing error first converged (hold
   * debounce — the RAW yaw needs time to settle next to the EMA). */
  faceAlignedAtMs: number | null
  walkPromptSentAtMs: number
  bestDistance: number
  stallSinceMs: number | null
  /** Closing-speed tracking for the arrival braking lead (last probe). */
  prevWaypointDist: number
  prevProbeAtMs: number
  /** Target-progress watchdog (policy at TARGET_STALL_S): the REMAINING
   * route length (distance to the current waypoint + the summed segment
   * lengths after it) must improve by STALL_PROGRESS_EPS_M within
   * TARGET_STALL_S, across waypoints and turn/walk oscillation. Route
   * length, not raw target distance: a legit obstacle detour temporarily
   * INCREASES the target distance (measured: the desk re-approach route
   * loops west/north first, d: 0.45 → 0.75 m — a target-distance watchdog
   * false-fires mid-detour), while wandering-forever oscillation never
   * advances along the route. */
  bestTargetDist: number
  targetStallSinceMs: number | null
  /** remaining[i] = route length (m) from waypoint i to the path end. */
  pathRemaining: number[]
  /** False when the path's last point is NOT the goal target (planRoute's
   * closestClearPoint fallback): reaching it is a block, not an arrival. */
  pathEndsAtTarget: boolean
  /** True once she has been within the arrive region (tolerance + max lead)
   * of the target this goal — a later short/fallback re-approach proceeds
   * with a journaled residual instead of failing as blocked (she DID get
   * there; the target is reachable). */
  everNearTarget: boolean
}

function wrapAngle(a: number): number {
  let r = a % (2 * Math.PI)
  if (r <= -Math.PI) r += 2 * Math.PI
  else if (r > Math.PI) r -= 2 * Math.PI
  return r
}

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

function distanceXZ(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(bx - ax, bz - az)
}

export class GoalPlanner {
  private readonly navigation: RoomNavigation
  private readonly manifest: SceneManifest
  private readonly channel: PlannerPromptChannel
  private readonly probe: () => PlannerRootProbe
  private readonly nowMs: () => number
  private readonly random: () => number
  private readonly policy: GoalPlannerPolicy

  private goal: ActiveGoal | null = null
  private lastFailure: string | null = null
  /** Replan count of the last finished goal (telemetry: "current/last goal"). */
  private lastReplans = 0
  private readonly promptLog: PlannerPromptLogEntry[] = []
  private lastActivityMs: number
  private readonly ambientLastPickedAt = new Map<string, number>()
  /** Wrap-aware EMA of the measured root yaw (policy at YAW_EMA_TAU_S) —
   * every steering/facing decision reads this, never the single-sample yaw
   * (the live root wobbles ±70° around its settled heading mid/after turns). */
  private yawEma: number | null = null

  constructor(options: GoalPlannerOptions) {
    this.navigation = options.navigation
    this.manifest = options.manifest
    this.channel = options.channel
    this.probe = options.probe
    this.nowMs = options.nowMs ?? (() => performance.now())
    this.random = options.random ?? (() => Math.random())
    this.policy = { ...GOAL_PLANNER, ...options.policy }
    this.lastActivityMs = this.nowMs()
  }

  /** Resolve + start a goal from the manifest vocabulary. Returns false when
   * the interaction id is unknown (journaled; never throws). A new goal
   * supersedes an active one. */
  setGoal(interactionId: string, source: PlannerGoalSource = 'debug'): boolean {
    const resolved = this.resolveInteraction(interactionId)
    if (!resolved) {
      this.lastFailure = `unknown interaction "${interactionId}"`
      this.journalPrompt('interact', `[goal] ${this.lastFailure}`)
      console.warn(`[planner] ${this.lastFailure}`)
      return false
    }
    if (this.goal !== null) {
      console.info(`[planner] goal ${this.goal.id} superseded by ${interactionId}`)
    }
    const { interaction } = resolved
    const target = this.navigation.resolveStandingPoint(
      new Vector3(interaction.spot[0], 0, interaction.spot[1]),
    )
    const path = this.navigation.planRoute(this.probePosition(), target)
    if (path.length === 0) {
      this.lastFailure = `no path to "${interactionId}"`
      console.warn(`[planner] ${this.lastFailure}`)
      return false
    }
    this.lastFailure = null
    this.goal = {
      id: interactionId,
      interaction,
      target,
      path,
      source,
      startedAtMs: this.nowMs(),
      phase: 'planning',
      phaseStartedAtMs: this.nowMs(),
      waypointIndex: 0,
      variantSeed: hashString(interactionId),
      variantUse: { walk: 0, turn: 0, arrive: 0 },
      turnReissues: 0,
      replans: 0,
      sentPrompt: null,
      turnSentAtMs: 0,
      faceAlignedAtMs: null,
      walkPromptSentAtMs: -Infinity,
      bestDistance: Infinity,
      stallSinceMs: null,
      prevWaypointDist: Infinity,
      prevProbeAtMs: 0,
      bestTargetDist: Infinity,
      targetStallSinceMs: null,
      pathRemaining: this.computePathRemaining(path),
      pathEndsAtTarget: path[path.length - 1]!.distanceTo(target) < 1e-6,
      everNearTarget: distanceXZ(this.probe().x, this.probe().z, target.x, target.z) <=
        this.policy.ARRIVE_TOLERANCE_M + this.policy.ARRIVE_LEAD_MAX_M,
    }
    this.lastActivityMs = this.nowMs()
    console.info(
      `[planner] goal ${interactionId} (${source}) — path ${path.length} waypoint(s), ` +
      `target (${target.x.toFixed(2)}, ${target.z.toFixed(2)})`,
    )
    return true
  }

  /** Cancel the active goal (journaled). No-op when idle. */
  clearGoal(): void {
    if (this.goal === null) return
    this.journalPrompt('interact', `[goal] ${this.goal.id} cleared`)
    this.finishGoal('cleared')
  }

  /** Current goal id (null when idle). */
  getGoal(): string | null {
    return this.goal?.id ?? null
  }

  getTelemetry(): GoalPlannerTelemetry {
    const goal = this.goal
    const probe = goal !== null ? this.probe() : null
    let distanceToSpot: number | null = null
    let facingErrDeg: number | null = null
    if (goal !== null && probe !== null) {
      distanceToSpot = Math.round(distanceXZ(probe.x, probe.z, goal.target.x, goal.target.z) * 1000) / 1000
      facingErrDeg =
        Math.round(
          Math.abs((wrapAngle((goal.interaction.facingDeg * Math.PI) / 180 - probe.yaw) * 180) / Math.PI) * 10,
        ) / 10
    }
    return {
      goal: goal?.id ?? null,
      phase: goal?.phase ?? null,
      distanceToSpot,
      facingErrDeg,
      replans: goal?.replans ?? this.lastReplans,
      lastFailure: this.lastFailure,
      promptLog: [...this.promptLog],
      ambient: {
        lastGoal: [...this.ambientLastPickedAt.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
        lastGoalAtMs: [...this.ambientLastPickedAt.values()].sort((a, b) => b - a)[0] ?? null,
      },
    }
  }

  /** Per-frame step (drives the goal state machine + the ambient idle driver). */
  update(dt: number): void {
    const now = this.nowMs()
    // Smooth the measured yaw (wrap-aware EMA) — the steering/facing
    // decisions below read this, never the raw single-sample probe.
    const probe = this.probe()
    if (this.yawEma === null) {
      this.yawEma = probe.yaw
    } else {
      const alpha = 1 - Math.exp(-Math.max(1e-4, dt) / this.policy.YAW_EMA_TAU_S)
      this.yawEma = wrapAngle(this.yawEma + alpha * wrapAngle(probe.yaw - this.yawEma))
    }
    if (this.goal === null) {
      this.maybeStartAmbient(now)
      return
    }
    // Priority: user prompt cancels the active goal (journaled, no queue).
    if (this.channel.lastUserPromptAtMs() > this.goal.startedAtMs) {
      this.journalPrompt('interact', `[goal] ${this.goal.id} cancelled by user prompt`)
      this.finishGoal('cancelled by user prompt')
      return
    }
    // Priority: watchdog hold suspends the planner (no sends, timers frozen —
    // phaseStartedAtMs keeps counting only ACTIVE time because this branch
    // returns before any phase clock advances; the target-progress stall
    // clock is wall-based, so it is pushed forward explicitly here).
    if (this.channel.isWatchdogHolding()) {
      this.freezeTargetStall(now)
      return
    }
    if (now - this.goal.startedAtMs > this.policy.MAX_GOAL_SECONDS * 1000) {
      this.journalPrompt('interact', `[goal] ${this.goal.id} timed out after ${this.policy.MAX_GOAL_SECONDS}s`)
      this.finishGoal(`timed out after ${this.policy.MAX_GOAL_SECONDS}s`)
      return
    }
    // Priority: reflex interrupts a segment — no sends, no phase clock.
    const reflexActive = this.channel.isReflexActive()
    switch (this.goal.phase) {
      case 'planning': this.enterInitialSegment(); break
      case 'turn': this.stepTurn(now, reflexActive); break
      case 'walk': this.stepWalk(now, reflexActive); break
      case 'arrive': this.stepArrive(now, reflexActive); break
      case 'face': this.stepFace(now, reflexActive); break
      case 'interact': this.stepInteract(now, reflexActive); break
      case 'done': break
    }
  }

  // ── phase machine ──────────────────────────────────────────────────

  private enterInitialSegment(): void {
    const goal = this.goal!
    if (this.arrivedAtTarget()) {
      this.beginPhase('arrive')
      return
    }
    this.smoothNearWaypoints()
    const waypoint = goal.path[goal.waypointIndex]!
    if (this.shouldSteer(waypoint)) {
      this.beginPhase('turn')
    } else {
      this.beginPhase('walk')
    }
  }

  /**
   * Path smoothing (spec: "path smoothing optional"): skip a non-final
   * waypoint within SMOOTH_SKIP_M when the direct segment from the ACTUAL
   * position to the FOLLOWING waypoint is verified clear. Sub-meter legs
   * wedged between an obstacle and a wall are unexecutable with the
   * stream's ±45° per-ask heading noise (measured live 2026-08-02: a 0.9 m
   * first leg between the daybed and the north wall milled for 110 s
   * without progress; the merged 4.7 m leg along the wall is a robust
   * walk). Never skips when the merged segment clips an AABB — corner
   * waypoints earn their keep (isRouteClear is the same predicate the
   * obstacle-aware AC tests use).
   */
  private smoothNearWaypoints(): void {
    const goal = this.goal!
    const probe = this.probePosition()
    while (goal.waypointIndex < goal.path.length - 1) {
      const waypoint = goal.path[goal.waypointIndex]!
      if (distanceXZ(probe.x, probe.z, waypoint.x, waypoint.z) > this.policy.SMOOTH_SKIP_M) return
      const next = goal.path[goal.waypointIndex + 1]!
      if (!this.navigation.isRouteClear(probe, [next])) return
      console.info(
        `[planner] goal ${goal.id} smoothing: merging waypoint ` +
        `(${waypoint.x.toFixed(2)}, ${waypoint.z.toFixed(2)}) into ` +
        `(${next.x.toFixed(2)}, ${next.z.toFixed(2)})`,
      )
      goal.waypointIndex += 1
    }
  }

  private stepTurn(now: number, reflexActive: boolean): void {
    const goal = this.goal!
    if (reflexActive) {
      this.freezeTargetStall(now)
      return // reflex owns the prompt; restore re-issues ours
    }
    if (this.trackTargetProgress(now)) return
    const waypoint = goal.path[goal.waypointIndex]!
    if (distanceXZ(this.probe().x, this.probe().z, waypoint.x, waypoint.z) <= this.policy.WALK_WAYPOINT_ARRIVE_M) {
      this.advanceFromWaypoint()
      return
    }
    if (goal.sentPrompt === null) {
      if (this.shouldSteer(waypoint)) {
        goal.turnSentAtMs = now
        this.sendTurnPrompt(waypoint)
      } else {
        // Waypoint too close for a meaningful turn (arrival takes over) —
        // walk in.
        this.beginPhase('walk')
      }
      return
    }
    // Settle window (policy at TURN_SETTLE_S): the prompt's reset chunk
    // lands ~1.5-2.5 s after send and the yaw mid-execution is spin
    // garbage (swings ±70° through the T2 crossfade, measured live
    // 2026-08-02). Measuring before the settle reads the OLD stream's
    // heading and declares false alignment mid-spin.
    if (now - goal.turnSentAtMs < this.policy.TURN_SETTLE_S * 1000) return
    // Settle elapsed: measure the ACTUAL result (re-anchor on reality).
    if (Math.abs(this.headingErrorDeg(waypoint)) <= this.policy.TURN_TOLERANCE_DEG) {
      // Turn segment complete: aligned with the waypoint — start walking.
      this.beginPhase('walk')
      return
    }
    // Error remains: re-issue with the REMAINING error immediately. The
    // settle window (not a fixed timeout) paces iterations — the 45°
    // request ceiling means a gross error needs several steps, and an
    // 8 s-per-step timeout turned zigzag convergence into goal timeouts
    // (unit sim, 2026-08-02). The reissue budget bounds a non-responding
    // stream; on exhaustion, accept the error and walk (the stall/replan
    // feedback corrects gross misalignment downstream).
    if (goal.turnReissues < this.policy.MAX_TURN_REISSUES) {
      goal.turnReissues += 1
      goal.phaseStartedAtMs = now
      goal.sentPrompt = null
    } else {
      this.beginPhase('walk')
    }
  }

  private stepWalk(now: number, reflexActive: boolean): void {
    const goal = this.goal!
    if (reflexActive) {
      this.freezeTargetStall(now)
      return
    }
    if (this.trackTargetProgress(now)) return
    if (goal.sentPrompt === null) {
      this.sendSegmentPrompt('walk')
      goal.walkPromptSentAtMs = now
      goal.bestDistance = Infinity
      goal.stallSinceMs = null
    }
    const probe = this.probe()
    const waypoint = goal.path[goal.waypointIndex]!
    const d = distanceXZ(probe.x, probe.z, waypoint.x, waypoint.z)
    // Closing speed toward the waypoint (m/s, ≥0) — the braking lead for
    // the final waypoint's arrive trigger (policy at ARRIVE_LEAD_S).
    const probeDtS = Math.max(1e-3, (now - goal.prevProbeAtMs) / 1000)
    const closingSpeed = goal.prevProbeAtMs > 0
      ? Math.max(0, (goal.prevWaypointDist - d) / probeDtS)
      : 0
    goal.prevWaypointDist = d
    goal.prevProbeAtMs = now
    // Final waypoint: trigger the arrive stop EARLY by the braking lead so
    // the walk coasts onto the spot instead of past it — on EVERY approach,
    // re-approaches included: the prompt-latency coast is identical on the
    // second approach (measured live in the GEVS run of 2026-08-03: first
    // approach reached 0.1 m and coasted past, the lead-free re-approach
    // radius (strict 0.35) was unhittable at walk speed and the goal failed
    // "blocked" after having arrived). The unit sim models the same coast
    // (coastS = the live ~1.2 s), so lead and sim stay consistent.
    const isFinal = goal.waypointIndex >= goal.path.length - 1
    const leadM = isFinal
      ? Math.min(closingSpeed * this.policy.ARRIVE_LEAD_S, this.policy.ARRIVE_LEAD_MAX_M)
      : 0
    const arriveRadius = isFinal
      ? this.policy.ARRIVE_TOLERANCE_M + leadM
      : this.policy.WALK_WAYPOINT_ARRIVE_M
    if (d <= arriveRadius) {
      this.advanceFromWaypoint()
      return
    }
    // Steering (spec: walk + steering): the stream's heading is stochastic
    // (T1 — a walk prompt drifts and curves ~10-16°/s, measured live), so
    // re-anchor on the SMOOTHED yaw every tick: only once she strays past
    // the coarse turn threshold (and a turn is meaningful — see
    // shouldSteer) interrupt the walk with a turn segment re-aimed at the
    // waypoint, then resume walking. Coarse on purpose: fine corrections
    // overshoot the stochastic stream and the heading never converges.
    if (this.shouldSteer(waypoint)) {
      this.beginPhase('turn')
      return
    }
    // Arrival != motion trust: measure ACTUAL progress toward the CURRENT
    // waypoint; stalled (blocked or drifted) walks replan once from the
    // live position, then fail.
    if (d < goal.bestDistance - this.policy.STALL_PROGRESS_EPS_M) {
      goal.bestDistance = d
      goal.stallSinceMs = null
    } else if (goal.stallSinceMs === null) {
      goal.stallSinceMs = now
    } else if (now - goal.stallSinceMs > this.policy.WALK_STALL_S * 1000) {
      this.handleStalledWalk()
      return
    }
    // Long walks rotate the prompt variant (kills the same-loop-forever
    // effect even within one segment).
    if (now - goal.walkPromptSentAtMs > this.policy.WALK_PROMPT_ROTATE_S * 1000) {
      goal.sentPrompt = null
      goal.walkPromptSentAtMs = now
      this.sendSegmentPrompt('walk')
    }
  }

  private stepArrive(now: number, reflexActive: boolean): void {
    const goal = this.goal!
    if (reflexActive) return
    if (goal.sentPrompt === null) this.sendSegmentPrompt('arrive')
    if (now - goal.phaseStartedAtMs > this.policy.ARRIVE_PROMPT_S * 1000) {
      // Arrival != motion trust (re-anchor on reality, MotionBricks): the
      // stop coasted, now measure where she ACTUALLY ended up. Outside the
      // tolerance — braking-lead miss, stepping turn, or stream overshoot —
      // replan from the live position and re-approach ONCE (shares the
      // goal's replan budget); a second miss proceeds with the residual
      // journaled rather than looping approaches forever.
      if (!this.arrivedAtTarget()) {
        if (goal.replans < this.policy.MAX_WALK_REPLANS) {
          const d = distanceXZ(this.probe().x, this.probe().z, goal.target.x, goal.target.z)
          console.info(`[planner] goal ${goal.id} arrival off by ${d.toFixed(2)} m — re-approaching from actual position`)
          this.replanFromActual()
          return
        }
        const d = distanceXZ(this.probe().x, this.probe().z, goal.target.x, goal.target.z)
        console.warn(`[planner] goal ${goal.id} proceeding to interact ${d.toFixed(2)} m from the spot (re-approach budget exhausted)`)
      }
      const desired = (goal.interaction.facingDeg * Math.PI) / 180
      if (Math.abs(wrapAngle(desired - this.probe().yaw)) * 180 / Math.PI > this.policy.TURN_TOLERANCE_DEG) {
        this.beginPhase('face')
      } else {
        this.beginPhase('interact')
      }
    }
  }

  private stepFace(now: number, reflexActive: boolean): void {
    const goal = this.goal!
    if (reflexActive) return
    const desired = (goal.interaction.facingDeg * Math.PI) / 180
    const err = (Math.abs(wrapAngle(desired - (this.yawEma ?? this.probe().yaw))) * 180) / Math.PI
    if (err <= this.policy.TURN_TOLERANCE_DEG) {
      // Aligned on the SMOOTHED heading. Debounce (policy at FACE_HOLD_S):
      // hold the aligned state so the RAW yaw settles next to the EMA —
      // the interaction starts with an honest facing (the GEVS sample).
      if (goal.faceAlignedAtMs === null) goal.faceAlignedAtMs = now
      if (now - goal.faceAlignedAtMs >= this.policy.FACE_HOLD_S * 1000) {
        this.beginPhase('interact')
        return
      }
      // Mid-hold: if a turn is still executing (settle window), keep
      // waiting — the EMA will follow any overshoot and reset the hold.
      if (goal.sentPrompt !== null && now - goal.turnSentAtMs < this.policy.TURN_SETTLE_S * 1000) return
      return
    }
    goal.faceAlignedAtMs = null
    if (goal.sentPrompt === null) {
      goal.turnSentAtMs = now
      this.sendFaceTurnPrompt()
      return
    }
    if (now - goal.turnSentAtMs < this.policy.TURN_SETTLE_S * 1000) return
    // Settle elapsed, facing error remains: re-issue immediately (same
    // pacing change as stepTurn — the settle window paces iterations, the
    // reissue budget bounds a non-responding stream).
    if (goal.turnReissues < this.policy.MAX_TURN_REISSUES) {
      goal.turnReissues += 1
      goal.phaseStartedAtMs = now
      goal.sentPrompt = null
    } else {
      this.beginPhase('interact')
    }
  }

  private stepInteract(now: number, reflexActive: boolean): void {
    const goal = this.goal!
    if (reflexActive) return
    if (goal.sentPrompt === null) {
      // The interaction prompt is the manifest's authored prompt — not a
      // variant: variants rotate the WALK there, the interaction itself is
      // the destination behavior.
      this.sendPrompt('interact', goal.interaction.prompt)
    }
    if (now - goal.phaseStartedAtMs > this.policy.INTERACTION_MS) {
      console.info(`[planner] goal ${goal.id} complete (interaction played ${this.policy.INTERACTION_MS}ms)`)
      this.finishGoal('completed')
    }
  }

  // ── transitions ────────────────────────────────────────────────────

  private advanceFromWaypoint(): void {
    const goal = this.goal!
    if (this.arrivedAtTarget()) {
      this.beginPhase('arrive')
      return
    }
    if (goal.waypointIndex >= goal.path.length - 1) {
      // The path's last point is NOT the target (planRoute's
      // closestClearPoint fallback — measured live up to ~2 m short):
      // treating it as "arrived" played the interaction from across the
      // room. End-of-path without arrival IS a blocked path: replan once
      // from the actual position, then fail with reason. EXCEPTION: she is
      // already inside the arrive band (≤ tolerance + max braking lead,
      // measured at THIS advance — e.g. the braking-lead stop lands her
      // there with the final waypoint still a hair short): the arrive
      // phase owns the residual (re-approach once, then proceed journaled)
      // instead of failing a goal she already reached. A LATCH is wrong
      // here — "ever been near the target" also fires for a first approach
      // that merely passed the band en route, and then a far fallback end
      // would wrongly interact from across the room.
      if (
        goal.pathEndsAtTarget ||
        distanceXZ(this.probe().x, this.probe().z, goal.target.x, goal.target.z) <=
          this.policy.ARRIVE_TOLERANCE_M + this.policy.ARRIVE_LEAD_MAX_M
      ) {
        this.beginPhase('arrive')
      } else {
        this.handleStalledWalk()
      }
      return
    }
    goal.waypointIndex += 1
    this.smoothNearWaypoints()
    const waypoint = goal.path[goal.waypointIndex]!
    if (this.shouldSteer(waypoint)) {
      this.beginPhase('turn')
    } else {
      this.beginPhase('walk')
    }
  }

  private beginPhase(phase: PlannerPhase): void {
    const goal = this.goal!
    goal.phase = phase
    goal.phaseStartedAtMs = this.nowMs()
    goal.sentPrompt = null
    if (phase === 'face') {
      goal.turnReissues = 0
      goal.faceAlignedAtMs = null
    }
    if (phase === 'walk') goal.walkPromptSentAtMs = -Infinity
  }

  private arrivedAtTarget(): boolean {
    const goal = this.goal!
    const probe = this.probe()
    return distanceXZ(probe.x, probe.z, goal.target.x, goal.target.z) <= this.policy.ARRIVE_TOLERANCE_M
  }

  /**
   * Target-progress watchdog (policy at TARGET_STALL_S): the REMAINING route
   * length (distance to the current waypoint + the summed segment lengths
   * after it, see pathRemaining) must improve by STALL_PROGRESS_EPS_M within
   * TARGET_STALL_S, across waypoints and turn/walk oscillation. Route
   * length, NOT raw target distance: a legit obstacle detour temporarily
   * INCREASES the target distance (measured: the desk re-approach route
   * loops west/north first — d 0.45 → 0.75 m — and a target-distance
   * watchdog false-fires mid-detour), while wandering-forever oscillation
   * never advances along the route. Suspended time (watchdog hold, active
   * reflex) does not count — see freezeTargetStall. Returns true when the
   * stall fired (caller returns early).
   */
  private trackTargetProgress(now: number): boolean {
    const goal = this.goal!
    const probe = this.probe()
    const waypoint = goal.path[goal.waypointIndex]!
    const d = distanceXZ(probe.x, probe.z, waypoint.x, waypoint.z) + goal.pathRemaining[goal.waypointIndex]!
    if (distanceXZ(probe.x, probe.z, goal.target.x, goal.target.z) <=
        this.policy.ARRIVE_TOLERANCE_M + this.policy.ARRIVE_LEAD_MAX_M) {
      goal.everNearTarget = true
    }
    if (d < goal.bestTargetDist - this.policy.STALL_PROGRESS_EPS_M) {
      goal.bestTargetDist = d
      goal.targetStallSinceMs = null
      return false
    }
    if (goal.targetStallSinceMs === null) {
      goal.targetStallSinceMs = now
      return false
    }
    if (now - goal.targetStallSinceMs > this.policy.TARGET_STALL_S * 1000) {
      this.handleStalledWalk()
      return true
    }
    return false
  }

  /** remaining[i] = route length (m) from waypoint i to the path end. */
  private computePathRemaining(path: Vector3[]): number[] {
    const remaining = new Array<number>(path.length).fill(0)
    for (let i = path.length - 2; i >= 0; i -= 1) {
      remaining[i] = path[i]!.distanceTo(path[i + 1]!) + remaining[i + 1]!
    }
    return remaining
  }

  /** Reset the wall-clock stall timers while the planner is suspended
   * (watchdog hold / active reflex) — suspended time is not stall time. */
  private freezeTargetStall(now: number): void {
    if (this.goal === null) return
    if (this.goal.targetStallSinceMs !== null) this.goal.targetStallSinceMs = now
    if (this.goal.stallSinceMs !== null) this.goal.stallSinceMs = now
  }

  /** Replan once from the ACTUAL position; a second stall fails the goal. */
  private handleStalledWalk(): void {
    const goal = this.goal!
    if (goal.replans >= this.policy.MAX_WALK_REPLANS) {
      const reason = `blocked path to "${goal.id}" after ${goal.replans} replan(s) — no progress toward spot`
      console.warn(`[planner] ${reason}`)
      this.journalPrompt('interact', `[goal] ${goal.id} failed: ${reason}`)
      this.finishGoal(reason)
      return
    }
    this.replanFromActual()
  }

  /** Re-anchor on reality (MotionBricks): consume one replan budget, re-plan
   * the route from the ACTUAL probe position, and re-enter the segment
   * machine. Fails the goal with reason when no route exists. */
  private replanFromActual(): void {
    const goal = this.goal!
    goal.replans += 1
    const probe = this.probe()
    const path = this.navigation.planRoute(new Vector3(probe.x, 0, probe.z), goal.target)
    if (path.length === 0) {
      const reason = `no path to "${goal.id}" after replan`
      console.warn(`[planner] ${reason}`)
      this.finishGoal(reason)
      return
    }
    goal.path = path
    goal.waypointIndex = 0
    goal.turnReissues = 0
    goal.stallSinceMs = null
    goal.bestDistance = Infinity
    goal.sentPrompt = null
    goal.turnSentAtMs = 0
    goal.faceAlignedAtMs = null
    goal.prevWaypointDist = Infinity
    goal.prevProbeAtMs = 0
    goal.bestTargetDist = Infinity
    goal.targetStallSinceMs = null
    goal.pathRemaining = this.computePathRemaining(path)
    goal.pathEndsAtTarget = path[path.length - 1]!.distanceTo(goal.target) < 1e-6
    console.info(`[planner] goal ${goal.id} replan #${goal.replans} from (${probe.x.toFixed(2)}, ${probe.z.toFixed(2)})`)
    this.enterInitialSegment()
  }

  private finishGoal(reason: string): void {
    const goal = this.goal!
    if (reason !== 'completed' && reason !== 'cleared') {
      this.lastFailure = `${reason} (goal ${goal.id})`
    }
    this.lastReplans = goal.replans
    this.lastActivityMs = this.nowMs()
    this.goal = null
  }

  // ── prompting ──────────────────────────────────────────────────────

  private sendSegmentPrompt(kind: PlannerSegmentKind): void {
    this.sendPrompt(kind, this.pickVariant(kind))
  }

  private sendTurnPrompt(waypoint: Vector3): void {
    const err = this.headingErrorDeg(waypoint)
    const dir = err >= 0 ? 'left' : 'right'
    this.sendPrompt('turn', this.pickVariant('turn').replaceAll('{dir}', dir).replaceAll('{deg}', String(this.turnAskDeg(err))))
  }

  private sendFaceTurnPrompt(): void {
    const goal = this.goal!
    const desired = (goal.interaction.facingDeg * Math.PI) / 180
    const err = (wrapAngle(desired - (this.yawEma ?? this.probe().yaw)) * 180) / Math.PI
    const dir = err >= 0 ? 'left' : 'right'
    this.sendPrompt('turn', this.pickVariant('turn').replaceAll('{dir}', dir).replaceAll('{deg}', String(this.turnAskDeg(err))))
  }

  /**
   * Turn request magnitude: min(TURN_REQUEST_MAX_DEG, |err|). The 45°
   * ceiling is the reliability boundary measured on the raw stream
   * (2026-08-02, 40 trials): 45° asks are direction-reliable in every deck
   * phrasing (20/20 correct-side), while 60-90° asks came back INVERTED
   * (every 60°/90° "left" landed right) — so a full-error request past 45°
   * can spin her the wrong way by more than the original error. Residual
   * asks below the ceiling are direction-noisy live (20° random-signed,
   * 30° inverted) but only span ≤2x the acceptance tolerance, so a wrong
   * one costs a single re-aim iteration; magnitude still spreads 28-136°
   * per ask either way, and the re-measure loop owns convergence.
   */
  private turnAskDeg(errDeg: number): number {
    return Math.min(this.policy.TURN_REQUEST_MAX_DEG, Math.max(5, Math.round(Math.abs(errDeg))))
  }

  private pickVariant(kind: PlannerSegmentKind): string {
    const goal = this.goal!
    const variants = this.policy.PROMPTS[kind]
    const use = goal.variantUse[kind]
    goal.variantUse[kind] = use + 1
    return variants[(goal.variantSeed + use) % variants.length]!
  }

  private sendPrompt(kind: PlannerPromptKind, text: string): void {
    const goal = this.goal!
    goal.sentPrompt = text
    this.channel.sendPlannerPrompt(text)
    this.journalPrompt(kind, text)
  }

  private journalPrompt(kind: PlannerPromptKind, prompt: string): void {
    this.promptLog.push({ t: this.nowMs(), kind, prompt })
    if (this.promptLog.length > this.policy.PROMPT_LOG_CAP) this.promptLog.shift()
  }

  // ── geometry ───────────────────────────────────────────────────────

  private probePosition(): Vector3 {
    const probe = this.probe()
    return new Vector3(probe.x, 0, probe.z)
  }

  /** Signed heading error (deg) to a point vs the SMOOTHED facing; positive =
   * turn left (yaw-positive, consistent with the reflex direction classifier).
   * The yaw EMA (policy at YAW_EMA_TAU_S) filters the live root's ±70°
   * wobble — single-sample yaw decisions read garbage. */
  private headingErrorDeg(waypoint: Vector3): number {
    const probe = this.probe()
    const desired = Math.atan2(waypoint.x - probe.x, waypoint.z - probe.z)
    return (wrapAngle(desired - (this.yawEma ?? probe.yaw)) * 180) / Math.PI
  }

  /**
   * Steering decision (policy at HEADING_ERROR_TURN_DEG / WALK_NO_TURN_M):
   * turn when the smoothed heading error is gross. The no-turn near-waypoint
   * exception applies ONLY to the FINAL waypoint: there the arrival radius +
   * braking lead take over, and heading error is geometrically meaningless
   * for arrival (a 0.1 m lateral offset reads as a huge angle; live: a
   * 0.49 m miss with 74° error made the old planner turn her AWAY from the
   * desk) — unless she faces away (|err| ≥ 90°, walking would open the
   * distance). INTERMEDIATE waypoints must be navigated around: a 0.4 m
   * lateral gap at the wall corner needs its turn even when d < 1.0 (the
   * walk cannot close the gap by going straight — measured live in the
   * re-approach: no-turn → walk into the wall → false "blocked path").
   */
  private shouldSteer(waypoint: Vector3): boolean {
    const goal = this.goal!
    const probe = this.probe()
    const err = Math.abs(this.headingErrorDeg(waypoint))
    if (err <= this.policy.HEADING_ERROR_TURN_DEG) return false
    if (goal.waypointIndex >= goal.path.length - 1) {
      return (
        distanceXZ(probe.x, probe.z, waypoint.x, waypoint.z) > this.policy.WALK_NO_TURN_M || err >= 90
      )
    }
    return true
  }

  // ── ambient idle driver ────────────────────────────────────────────

  private maybeStartAmbient(now: number): void {
    const since = Math.max(this.lastActivityMs, this.channel.lastUserPromptAtMs())
    if (now - since < this.policy.AMBIENT_AFTER_S * 1000) return
    if (this.channel.isReflexActive() || this.channel.isWatchdogHolding()) return
    const pick = this.pickAmbientGoal(now)
    if (pick === null) return
    this.ambientLastPickedAt.set(pick, now)
    console.info(`[planner] ambient idle driver picked "${pick}"`)
    this.setGoal(pick, 'ambient')
  }

  private pickAmbientGoal(now: number): string | null {
    const candidates = this.policy.AMBIENT_DECK.filter((entry) => {
      const last = this.ambientLastPickedAt.get(entry.goal)
      return last === undefined || now - last >= entry.cooldownS * 1000
    })
    if (candidates.length === 0) return null
    // Deck entries that don't resolve against the manifest are skipped
    // fail-closed (never executed, never crash).
    const resolvable = candidates.filter((entry) => this.resolveInteraction(entry.goal) !== null)
    if (resolvable.length === 0) return null
    const total = resolvable.reduce((sum, entry) => sum + entry.weight, 0)
    let roll = this.random() * total
    for (const entry of resolvable) {
      roll -= entry.weight
      if (roll <= 0) return entry.goal
    }
    return resolvable[resolvable.length - 1]!.goal
  }

  private resolveInteraction(
    interactionId: string,
  ): { interaction: SceneInteraction } | null {
    const dot = interactionId.indexOf('.')
    if (dot <= 0 || dot === interactionId.length - 1) return null
    const objectId = interactionId.slice(0, dot)
    const interactionKey = interactionId.slice(dot + 1)
    const object = this.manifest.objects.find((o) => o.id === objectId)
    const interaction = object?.interactions?.find((i) => i.id === interactionKey)
    return interaction ? { interaction } : null
  }
}
