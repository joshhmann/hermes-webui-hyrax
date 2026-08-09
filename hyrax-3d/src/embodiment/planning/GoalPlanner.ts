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
export type PlannerGoalSource = 'debug' | 'ambient' | 'essence'

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
 * Live derived state snapshot the essence driver consumes (spatial layer 4).
 * The loft polls /api/hyrax/presence on the presence cadence (~30s) and maps
 * the operator's derivedState block + activity into this shape. `fresh` is the
 * server's freshness flag (<120s since essenced wrote derived_state.json) —
 * only fresh state may drive goals.
 */
export interface EssenceStateSnapshot {
  fresh: boolean
  energy: number | null
  focus: number | null
  stress: number | null
  sociability: number | null
  mood: string | null
  /** Presence activity.type ('idle' | 'conversing' | 'tool-working' | ...). */
  activity: string | null
}

export type EssenceDriveField = 'energy' | 'focus' | 'stress' | 'sociability' | 'activity'
export type EssenceDriveOp = '<' | '<=' | '>' | '>=' | 'eq'

/** One AND-ed condition on the state snapshot (rules are DATA, not code). */
export interface EssenceDriveClause {
  field: EssenceDriveField
  op: EssenceDriveOp
  value: number | string
}

export interface EssenceDriveRule {
  /** Journaled rule id (telemetry goalSource.rule — the legible "why"). */
  rule: string
  /** Manifest interaction id (<object>.<interaction>; fail-closed when
   * unresolved — never crash, never execute, same discipline as the deck). */
  goal: string
  /** AND-ed clauses; a missing (null) state field fails the clause. */
  when: readonly EssenceDriveClause[]
  /** Per-goal cooldown (s): a goal the driver fired won't re-fire sooner. */
  cooldownS: number
  /** Hysteresis (s): a new essence rule can't fire until this long after the
   * last essence goal STARTED — a fast fail/cancel can't immediately re-fire
   * a different goal, so a mid-goal state flip never ping-pongs. */
  minDwellS: number
}

/** The legible cause of an essence-driven goal ("she lay down because energy
 * 0.24"): telemetry planner.goalSource. */
export interface PlannerGoalSourceTelemetry {
  kind: 'essence'
  rule: string
  /** The state snapshot that matched (frozen at fire time). */
  state: EssenceStateSnapshot
}

/** Essence-driver blocked-evaluation counters (Mai RCA t_af24521d): the
 * driver used to return quietly on every gate — essenceGoalSeen=0 was the
 * only signal. These counters make "no rule matched" vs "driver blocked"
 * legible in telemetry (GEVS metric essenceDriverSkips). */
export interface PlannerDriverSkips {
  essence: {
    /** Evaluations blocked by the reflex layer or a watchdog hold. */
    reflexWatchdog: number
    /** Evaluations blocked by the post-user-prompt quiet window. */
    userQuiet: number
    /** Evaluations with no fresh state to evaluate (null or stale). */
    noState: number
    /** Full evaluations where no drive rule was actionable (no match,
     * cooldown, or min-dwell). */
    noRule: number
  }
}

/**
 * All planner policy as data (mirrors the ARDY_REFLEX block pattern).
 * Thresholds/variants/deck/cooldowns live here, never in code.
 */
export interface GoalPlannerPolicy {
  /** Arrival radius (m) around the resolved standing point (spec: 0.35). */
  ARRIVE_TOLERANCE_M: number
  /**
   * Final-approach lateral gate (2026-08-04): perpendicular miss (range ×
   * sin(err)) beyond which the FINAL waypoint walk steers. The coarse
   * steering threshold (60°) tolerates a residual heading error that the
   * raw-gate turn phase leaves at ≤25° — at 2-3 m range that is a
   * 0.5-1.2 m perpendicular miss and the walk line NEVER enters the
   * arrive band (measured in the unit sim: straight walk, goal failed
   * arrival at 0.5 m). Sized just under ARRIVE_TOLERANCE_M so the
   * corrected line crosses the spot with margin for tick/coast
   * quantization; the no-turn zone still applies inside WALK_NO_TURN_M.
   */
  FINAL_APPROACH_LATERAL_M: number
  /** Heading error (deg) above which a turn segment precedes a walk. */
  HEADING_ERROR_TURN_DEG: number
  /** Heading/facing error (deg) at which a turn segment is accepted. */
  TURN_TOLERANCE_DEG: number
  /** Max turn re-issues per turn segment. Bounds a non-responding stream;
   * sized for the 45° request ceiling (a 180° error needs 4 steps). */
  MAX_TURN_REISSUES: number
  /**
   * Wall-clock cap (s) on ONE turn phase (2026-08-04 drift class). The
   * raw gate (TURN_RAW_*) requires the yaw to SETTLE before the walk may
   * start — but the live stream's yaw demonstrably does not settle after
   * a turn ask: the tels sweep 0°→180° continuously for 68+ s with zero
   * prompts in flight (desk2), the reissue budget never exhausts (the
   * yaw is never "settled" → the settle-spread wait holds), and the 20 s
   * TARGET watchdog then consumes the goal's single replan on a TURN
   * stall (desk1: travelM 0.224 — she never even walked). The cap hands
   * the phase to the walk: the walk prompt REPLACES the circling stream
   * (proven live: desk2's walk moved her 3.7 m) and the walk phase's
   * steering + stall detection own the residual. A healthy turn
   * (settle + hold) completes in ~4.5 s — far under the cap — so the
   * fast path is untouched. Sized above settle+hold and below the
   * TARGET_STALL_S watchdog so the handoff always beats the watchdog.
   */
  TURN_PHASE_MAX_S: number
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
  /**
   * Raw-yaw tolerance (deg) for the turn→walk transition (2026-08-03
   * drift class). The EMA alone can read "aligned" while the RAW yaw is
   * still rotating PAST the target — the live stream executes a turn ask
   * at 79-240% of the request and the execution tail outlives the settle
   * window (measured: 4×45° asks → the raw crossed the target then kept
   * rotating 76°+ past; the walk started off-heading into the coffee
   * table). The walk prompt only goes out when BOTH the smoothed and the
   * raw yaw are within tolerance of the waypoint. Sized between the 20°
   * EMA acceptance (noisier raw) and the 60° steering threshold (a walk
   * starting at 25° still arrives — the braking lead + re-approach own
   * the residual). */
  TURN_RAW_TOLERANCE_DEG: number
  /** Hold (s) of the aligned state (EMA + raw within tolerance) before
   * the turn→walk transition fires — mirror of FACE_HOLD_S: a transient
   * crossing must not start a walk. The raw yaw demonstrably settles
   * next to the target within this window or the hold resets. */
  TURN_RAW_HOLD_S: number
  /** |raw − EMA| spread (deg) below which the yaw is considered SETTLED
   * (the turn finished executing). Re-issues only fire on a settled yaw:
   * re-issuing onto a still-moving stream compounds the overshoot
   * (measured live: 4×45° asks executed 79-240% each and the heading
   * never converged — the walk then went out at ~100° off). */
  TURN_RAW_SETTLE_SPREAD_DEG: number
  /**
   * Walk-prompt landing window (s) — 2026-08-04 never-settling stream
   * class (desk2 live: goal failed with the yaw sweeping 0°→180° for the
   * whole goal). After a TURN_PHASE_MAX_S cap hands off to the walk, the
   * walk prompt takes 1.5-2.5 s to REPLACE the old stream — during that
   * landing the measured heading is still the OLD stream's garbage, and
   * a steering check on the same tick yanks the walk back into turn
   * before it ever moves (measured live: turn↔walk oscillation, each
   * walk phase ~1 tick, the goal's route length never improves, the
   * target watchdog consumes the replan). Suppress steering for this
   * window after each walk prompt so the new walk stream lands and the
   * yaw re-anchors on the walk; the walk then moves and the steering /
   * lateral gate decide from an honest heading. The landing window also
   * does not count as per-waypoint stall time (the body cannot move
   * until the prompt lands). A healthy stream is unaffected: its walk
   * prompts follow an aligned turn and steering would not fire anyway.
   */
  WALK_SETTLE_S: number
  /** Yaw-motion spread (deg) at walk-prompt send that decides whether
   * the landing window is open (see the default's comment — the send
   * snapshot discriminator between a sweep-handoff and a settled
   * handoff). */
  WALK_LANDED_SPREAD_DEG: number
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
   * so a fast approach stops early and coasts ONTO the spot. Sized 0.9 s
   * (2026-08-08): the 1.2 s value systematically overshot — live desk runs
   * landed a deterministic 0.48 m short (trigger 0.83 m, coast 0.35 m at
   * 0.4 m/s = 0.875 s; the 0.45 m GEVS arrival bar sits 3 cm under the
   * landing) — the lead must match the ACTUAL coast, not the prompt
   * latency. */
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
  /** An arrival miss (m) at or below this is accepted without a replan —
   * the interaction prompt supplies the motion. Sized to the GEVS
   * planner-desk-work arrival bar (0.45 m pass / 0.6 m partial at the
   * first interact sample): accepting at 0.75 m guarantees a partial at
   * best, so a miss in the 0.45-0.75 m band re-approaches (a SHORT walk —
   * the load-fragile class was a multi-meter re-approach; the pickup-cup
   * putdown's fragile step is isolated by its phase recenter). */
  CLOSE_ARRIVE_ACCEPT_M: number
  /** A face phase that drifts the body beyond this distance from the spot
   * is re-approached instead of interacting from range (2026-08-08
   * arrival-quality class: arrival accepted on the spot, face reissues
   * orbited her to 1.11 m live). Sized as the accept band + turn-drift
   * slack. */
  FACE_DRIFT_REAIM_M: number
  /** Debounce (s) for the face-drift re-aim — a transient turn-execution
   * drift must not fire the re-approach. */
  FACE_DRIFT_GUARD_S: number
  /** Walk-prompt absorption budget (frames): a walk whose nav-REJECTED
   * frames reach this count WITHOUT approach progress is re-aimed (a
   * heading problem — turn) instead of left to the stall detector (which
   * replans — a path problem — and burns the goal's single replan on the
   * SAME heading; live r2: 129 absorbs, 14 walks, travelM 1.05, no reflex
   * line, blocked). */
  WALK_ABSORB_REAIM_N: number
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
  /** Essence driver: re-evaluate the drive rules at most this often (s) —
   * the presence cadence the loft polls derived state on (~30s). */
  ESSENCE_POLL_S: number
  /** Essence driver: quiet window after a USER prompt before the driver may
   * fire (s) — user intent outranks the driver (priority model). */
  ESSENCE_USER_QUIET_S: number
  /** Drive rules (data, ordered first-match — mirrors the essence thresholds;
   * thresholds are reviewed data, changed by humans, never self-tuned). The
   * driver REPLACES the static ambient deck as the lowest tier: unmatched
   * rules fall through to the deck exactly as before. */
  ESSENCE_DRIVE_RULES: readonly EssenceDriveRule[]
  /** Segment prompt variants (data; rotated seeded by goal id). */
  PROMPTS: PlannerVariants
}

export const GOAL_PLANNER: GoalPlannerPolicy = {
  ARRIVE_TOLERANCE_M: 0.35,
  // Final-approach lateral gate (2026-08-04): keeps the corrected walk
  // line within the arrival tolerance with margin for the tick/coast
  // quantization (the arrive trigger + stop coast land up to ~0.05 m off
  // the ideal line-crossing). Sized 0.5 m (2026-08-08): the 0.3 m value
  // fired on borderline-GOOD walks (live trace: err 11.7° at 1.46 m =
  // 0.30 m miss — a yank into a never-settling turn that never converged,
  // the goal churned and died; 4/9 live desk runs reached the 1.0-1.6 m
  // final-approach zone then died exactly this way). The arrival trigger
  // (radius 0.35 + braking lead ≈ 0.89 m at walking speed) catches any
  // line within 0.89 m of the spot — a 0.3-0.5 m miss is INSIDE that
  // band and completes; only lines that genuinely miss (> 0.5 m) re-aim.
  FINAL_APPROACH_LATERAL_M: 0.5,
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
  // Turn-phase wall-clock cap (2026-08-04 drift class): a stream whose
  // yaw never settles must not hold the phase forever — 10 s beats the
  // 20 s target watchdog (the handoff must arrive before the watchdog
  // consumes the goal's single replan on a TURN stall) and is >2× the
  // healthy settle+hold (~4.5 s), so only a never-settling stream ever
  // hits it. The walk prompt replaces the circling stream (desk2's walk
  // moved 3.7 m) and the walk's steering/stall machinery owns the rest.
  TURN_PHASE_MAX_S: 10,
  TURN_REQUEST_MAX_DEG: 45,
  MAX_TURN_REISSUES: 4,
  WALK_NO_TURN_M: 0.5,
  YAW_EMA_TAU_S: 0.8,
  // Raw-yaw settle gate for the turn→walk transition (2026-08-03 drift
  // class): the walk must not start while the raw yaw is still swinging
  // past the target — the EMA alone reads aligned mid-execution. 25° is
  // between the 20° EMA acceptance and the 60° steering threshold; the
  // 1.5 s hold mirrors FACE_HOLD_S (a transient crossing must not fire);
  // the 20° |raw − EMA| spread says "the yaw stopped moving" before a
  // re-issue (compounding overshoots is the live failure's second half).
  TURN_RAW_TOLERANCE_DEG: 25,
  TURN_RAW_HOLD_S: 1.5,
  TURN_RAW_SETTLE_SPREAD_DEG: 20,
  // Walk-prompt landing window (2026-08-04 never-settling stream class):
  // the walk prompt takes 1.5-2.5 s to replace the old stream (measured
  // live — the same reset-chunk latency TURN_SETTLE_S covers) AND the
  // walk must then MOVE at the frozen heading before steering can judge
  // it (a yank after 0.3 s of movement is a yank before the walk exists
  // — measured live: turn↔walk oscillation, each walk phase ~1 tick).
  // 4.0 s = landing (~2.2 s) + ~1.8 s of movement (~1.1 m at walk speed)
  // — enough displacement for the route-length watchdog to see progress
  // from a usable frozen heading, and below WALK_STALL_S (6 s) so a
  // stream that never moves after the window STILL stalls honestly.
  WALK_SETTLE_S: 4.0,
  // Walk-landed yaw-spread (deg) — the discriminator at WALK-PROMPT SEND
  // that decides whether a landing window is needed at all: |raw − EMA|
  // is the yaw's motion measure (rate × tau), and a prompt sent while the
  // yaw is MOVING (the never-settling turn sweep is live) is the case the
  // window exists for — the landing reads the OLD stream's sweep garbage
  // and the walk must be allowed to land + re-anchor before steering
  // judges it. A prompt sent from a SETTLED yaw (the normal converged
  // turn; unit sims land instantly) has no landing risk: the window
  // stays closed and the correction machinery is never suppressed.
  // Mirrors the TURN_RAW_SETTLE_SPREAD_DEG "moving vs settled"
  // discriminator (20 live; the unit sim's compressed-EMA override pins
  // it to 6 — the sim's sweep spread ≈ rate × tau = 40 × 0.25 = 10°).
  WALK_LANDED_SPREAD_DEG: 20,
  FACE_HOLD_S: 1.5,
  WALK_WAYPOINT_ARRIVE_M: 0.3,
  SMOOTH_SKIP_M: 1.2,
  ARRIVE_LEAD_S: 0.9,
  ARRIVE_LEAD_MAX_M: 0.7,
  STALL_PROGRESS_EPS_M: 0.02,
  WALK_STALL_S: 6,
  TARGET_STALL_S: 20,
  MAX_WALK_REPLANS: 1,
  WALK_PROMPT_ROTATE_S: 12,
  ARRIVE_PROMPT_S: 2.5,
  CLOSE_ARRIVE_ACCEPT_M: 0.45,
  // 0.85 m (2026-08-08): the 0.65 m value re-approached moderate face
  // drifts (live f3r3: drifted 0.67 m, the re-approach walk failed in the
  // never-settling mode and the goal died blocked — a completion lost for
  // 2 cm). Only the TERRIBLE drifts (the 1.11 m live class) are worth the
  // re-approach gamble; a 0.65-0.85 m drift completes with a poor-but-
  // honest arrival (the criterion is completion-gated).
  FACE_DRIFT_REAIM_M: 0.85,
  FACE_DRIFT_GUARD_S: 1.5,
  WALK_ABSORB_REAIM_N: 4,
  INTERACTION_MS: 20000,
  MAX_GOAL_SECONDS: 120,
  PROMPT_LOG_CAP: 32,
  AMBIENT_AFTER_S: 90,
  AMBIENT_DECK: [
    { goal: 'daybed.nap', weight: 1, cooldownS: 180 },
    { goal: 'couch.sit', weight: 2, cooldownS: 150 },
    { goal: 'desk.work', weight: 2, cooldownS: 150 },
  ],
  // Essence driver (spatial layer 4): the body follows the state. Rules are
  // ordered, first match wins; each goal carries a per-goal cooldown and a
  // min-dwell hysteresis (no ping-pong on state flips). Data mirrors the
  // thresholds essenced derives (ESSENCE_GOALS_SPEC.md) — reviewed, human-
  // edited, never self-tuned. NOTE: `stress-high → window.look` references an
  // interaction the tai-loft manifest does not have YET — it resolves
  // fail-closed (skipped) until the manifest grows a window; the rule stays
  // as the spec's reviewed data.
  ESSENCE_POLL_S: 30,
  ESSENCE_USER_QUIET_S: 30,
  ESSENCE_DRIVE_RULES: [
    {
      rule: 'energy-low',
      goal: 'daybed.nap',
      when: [{ field: 'energy', op: '<', value: 0.3 }],
      cooldownS: 600,
      minDwellS: 45,
    },
    {
      rule: 'energy-focus',
      goal: 'desk.work',
      when: [
        { field: 'energy', op: '>', value: 0.7 },
        { field: 'focus', op: '>', value: 0.6 },
      ],
      cooldownS: 600,
      minDwellS: 45,
    },
    {
      rule: 'stress-high',
      goal: 'window.look',
      when: [{ field: 'stress', op: '>', value: 0.65 }],
      cooldownS: 600,
      minDwellS: 45,
    },
    {
      rule: 'sociable-idle',
      goal: 'couch.sit',
      when: [
        { field: 'sociability', op: '>', value: 0.6 },
        { field: 'activity', op: 'eq', value: 'idle' },
      ],
      cooldownS: 600,
      minDwellS: 45,
    },
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
  /** Monotonic nav-rejection frame counter of the body (ArdyMotionSource
   * navAbsorbCount — the treadmill: a rejected frame never happened).
   * Optional: a probe without it disables the walk-absorption re-aim
   * (the reflex edge still works). */
  navAbsorbCount?: number
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
  /** The legible cause of the current/last essence-driven goal — the "she lay
   * down because energy 0.24" story. Set when an essence goal fires, retained
   * until a non-essence goal starts (null then, and while nothing fired). */
  goalSource: PlannerGoalSourceTelemetry | null
  /** Essence-driver blocked-evaluation counters (never reset; monotonic). */
  driverSkips: PlannerDriverSkips
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
  /** Essence state provider (spatial layer 4): the loft's presence poll cache
   * (operator derivedState + activity). null when unavailable → the driver
   * stays quiet and the ambient deck path is unchanged. */
  essenceState?: () => EssenceStateSnapshot | null
  /**
   * Live state of a stateful object (INTERACTABLES_SPEC.md — requires
   * gate): the host's interactable state machine. An interaction whose
   * `requires` does not match the object's current state is refused
   * (journaled, never executed). Absent provider = fail-closed for
   * requires-gated interactions (refused).
   */
  objectState?: (objectId: string) => string | null
  /**
   * Interaction-completion hook (INTERACTABLES_SPEC.md): invoked when a goal
   * COMPLETES after its interaction prompt actually played (phase
   * 'interact' → finishGoal('completed')). `interactionId` is the full
   * `<object>.<interaction>` id the goal resolved. NOT invoked on cancel,
   * clear, supersede, timeout, or failure — those never reached the
   * interaction. The scene uses this to apply `kind: "pickup"` attach/
   * putdown semantics and `sets` state transitions (behavior lives in the
   * scene, not the planner).
   */
  onInteractionComplete?: (interactionId: string, interaction: SceneInteraction) => void
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
  /** Turn phase: when BOTH the smoothed and the RAW yaw first aligned on
   * the waypoint (drift-class hold — the raw yaw must settle next to the
   * EMA before a walk prompt goes out; a transient mid-execution crossing
   * resets it). */
  turnRawAlignedAtMs: number | null
  walkPromptSentAtMs: number
  /** navAbsorbCount at the current walk prompt's send — the absorption
   * accounting baseline for the graze-class re-aim (2026-08-08). */
  walkAbsorbBaseline: number
  /** Face phase: wall clock when the body first drifted past
   * FACE_DRIFT_REAIM_M (debounce — a transient turn-execution drift must
   * not fire the re-approach). */
  faceDriftSinceMs: number | null
  /** Landing-window state, SNAPSHOTTED at walk-prompt send: true when the
   * yaw was MOVING at send (the never-settling sweep handoff — the walk
   * must be allowed to land + re-anchor before steering judges it);
   * false for a settled handoff (normal converged turn, instant-land
   * sims) where no suppression is needed. Re-snapshotted on rotate. */
  walkLandWindowOpen: boolean
  bestDistance: number
  stallSinceMs: number | null
  /** Closing-speed tracking for the arrival braking lead (last probe). */
  prevWaypointDist: number
  prevProbeAtMs: number
  /** Last probe XZ (m) — the walk-phase "body is actually moving"
   * discriminator (2026-08-04): the final-approach lateral gate must
   * fire on a TANGENT walk (perpendicular miss with ~0 closing speed —
   * measured live: straightness 0.295, 48 nav-absorbs into the door)
   * while still leaving a FROZEN body (no displacement) to the
   * stall/replan detector. */
  prevProbeX: number
  prevProbeZ: number
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

/** Telemetry/log formatting for a possibly-missing state score. */
function fmtScore(v: number | null): string {
  return v === null ? '?' : v.toFixed(2)
}

export class GoalPlanner {
  private readonly navigation: RoomNavigation
  private readonly manifest: SceneManifest
  private readonly channel: PlannerPromptChannel
  private readonly probe: () => PlannerRootProbe
  private readonly nowMs: () => number
  private readonly random: () => number
  private readonly essenceState: () => EssenceStateSnapshot | null
  private readonly objectState?: (objectId: string) => string | null
  private readonly onInteractionComplete?: (interactionId: string, interaction: SceneInteraction) => void
  private readonly policy: GoalPlannerPolicy

  private goal: ActiveGoal | null = null
  private lastFailure: string | null = null
  /** Replan count of the last finished goal (telemetry: "current/last goal"). */
  private lastReplans = 0
  /**
   * Reflex edge for the walk-absorption recovery (2026-08-08 positional
   * class, live desk1): a reflex that JUST cleared during the walk phase
   * means the walk was nav-REJECTED — the reflex layer only fires on
   * sustained rejection ("front, coffee table" — the walk pressed into an
   * obstacle AABB and every frame was absorbed; live: navAbsorbs 69,
   * travelM 0.194). Set in update() before the phase dispatch; consumed
   * by stepWalk.
   */
  private reflexJustCleared = false
  /** Previous tick's reflex state (edge detection for the above). */
  private reflexWasActive = false
  private readonly promptLog: PlannerPromptLogEntry[] = []
  private lastActivityMs: number
  private readonly ambientLastPickedAt = new Map<string, number>()
  /** Essence driver: wall clock of the last drive-rule evaluation (poll gate
   * at ESSENCE_POLL_S — state is re-read on the presence cadence). Stamped
   * only AFTER gate acceptance (Mai RCA t_af24521d): a reflex/watchdog/quiet
   * blocked evaluation must not burn the cadence. */
  private lastEssencePollMs = -Infinity
  /** Essence driver: blocked-evaluation counters (telemetry driverSkips). */
  private readonly driverSkips: PlannerDriverSkips = {
    essence: { reflexWatchdog: 0, userQuiet: 0, noState: 0, noRule: 0 },
  }
  /** Last journaled skip key (`driver:reason`) — the console line fires on
   * reason transitions only, so a sustained reflex (hundreds of frames) is
   * one line, not a flood. Reset when a goal fires. */
  private lastDriverSkipKey: string | null = null
  /** Essence driver: per-goal cooldown clock (goal id → last fire). */
  private readonly essenceLastFiredAt = new Map<string, number>()
  /** Essence driver: min-dwell hysteresis anchor — wall clock when the last
   * essence goal STARTED (a new rule waits minDwellS from here). */
  private essenceLastStartedAtMs = -Infinity
  /** The legible "why" of the current/last essence goal (telemetry). */
  private goalSource: PlannerGoalSourceTelemetry | null = null
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
    this.essenceState = options.essenceState ?? (() => null)
    this.objectState = options.objectState
    this.onInteractionComplete = options.onInteractionComplete
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
    const { interaction } = resolved
    // requires gate (INTERACTABLES_SPEC.md): an interaction that requires a
    // state is only valid while the object is IN that state — refused with
    // a journaled reason otherwise ("an open door can't be opened"). The
    // scene provides the live state via `objectState`; fail-closed: a
    // requires-gated interaction with no provider (or an object with no
    // machine) is refused, never executed.
    if (interaction.requires !== undefined) {
      const objectId = interactionId.slice(0, interactionId.indexOf('.'))
      const current = this.objectState ? this.objectState(objectId) : null
      if (current !== interaction.requires) {
        this.lastFailure =
          `interaction "${interactionId}" refused: requires "${interaction.requires}", object "${objectId}" is ${current ?? 'unknown'}`
        this.journalPrompt('interact', `[goal] ${this.lastFailure}`)
        console.warn(`[planner] ${this.lastFailure}`)
        return false
      }
    }
    if (this.goal !== null) {
      console.info(`[planner] goal ${this.goal.id} superseded by ${interactionId}`)
    }
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
      turnRawAlignedAtMs: null,
      walkPromptSentAtMs: -Infinity,
      walkAbsorbBaseline: 0,
      faceDriftSinceMs: null,
      walkLandWindowOpen: false,
      bestDistance: Infinity,
      stallSinceMs: null,
      prevWaypointDist: Infinity,
      prevProbeAtMs: 0,
      prevProbeX: this.probe().x,
      prevProbeZ: this.probe().z,
      bestTargetDist: Infinity,
      targetStallSinceMs: null,
      pathRemaining: this.computePathRemaining(path),
      pathEndsAtTarget: path[path.length - 1]!.distanceTo(target) < 1e-6,
      everNearTarget: distanceXZ(this.probe().x, this.probe().z, target.x, target.z) <=
        this.policy.ARRIVE_TOLERANCE_M + this.policy.ARRIVE_LEAD_MAX_M,
    }
    this.lastActivityMs = this.nowMs()
    // A non-essence goal replaces the story (the driver's cause no longer
    // describes what she is doing). Essence-sourced goals set it themselves
    // after a successful start (see maybeStartEssence).
    if (source !== 'essence') this.goalSource = null
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
      goalSource:
        this.goalSource === null
          ? null
          : { kind: 'essence', rule: this.goalSource.rule, state: { ...this.goalSource.state } },
      driverSkips: { essence: { ...this.driverSkips.essence } },
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
      // Lowest tier: the essence driver (live derived state) replaces the
      // static deck as the goal source; the deck remains the no-rule-match
      // fallback, exactly as before. A driver-consumed tick excludes the
      // deck — essence outranks ambient in single-goal selection (Mai RCA
      // t_af24521d: ambient silently claimed the slot after reflex-clear).
      const essenceConsumed = this.maybeStartEssence(now)
      if (!essenceConsumed) this.maybeStartAmbient(now)
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
    // Reflex edge (walk-absorption recovery, 2026-08-08): a reflex that
    // just CLEARED is the nav-rejection signal — the reflex layer only
    // fires on sustained rejection, so a reflex during the walk means
    // the walk was absorbed. The walk phase re-aims on this edge; other
    // phases (turn/arrive/face) resume normally.
    this.reflexJustCleared = !reflexActive && this.reflexWasActive
    this.reflexWasActive = reflexActive
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
    // Turn-phase wall-clock cap (2026-08-04 drift class): the raw gate
    // below waits for the yaw to SETTLE — a stream whose yaw never
    // settles (live: tels sweep 0°→180° continuously for 68+ s with
    // zero prompts in flight) would hold this phase forever until the
    // 20 s TARGET watchdog consumes the goal's single replan on a TURN
    // stall (desk1: travelM 0.224 — never walked). Hand off to the walk
    // instead: the walk prompt REPLACES the circling stream (desk2's
    // walk moved 3.7 m) and the walk phase's steering + stall detection
    // own the residual. A healthy turn converges (settle+hold ~4.5 s)
    // far under the cap; each reissue resets phaseStartedAtMs, so only
    // a phase making NO progress ever hits it.
    if (now - goal.phaseStartedAtMs > this.policy.TURN_PHASE_MAX_S * 1000) {
      console.info(`[planner] turn phase capped at ${this.policy.TURN_PHASE_MAX_S}s — walking with residual heading`)
      this.beginPhase('walk')
      return
    }
    // Turn prompt in flight (a turn was SENT this phase): wait out the
    // settle window before measuring — the prompt's reset chunk lands
    // ~1.5-2.5 s after send and the yaw mid-execution is spin garbage
    // (swings ±70° through the T2 crossfade, measured live 2026-08-02).
    // Measuring before the settle reads the OLD stream's heading and
    // declares false alignment mid-spin. `sentPrompt` alone cannot
    // identify this state: a reissue resets it while the stream is still
    // executing — the drift class's reissue loop (2026-08-03).
    if (goal.turnSentAtMs !== 0 && now - goal.turnSentAtMs < this.policy.TURN_SETTLE_S * 1000) return
    // Settle elapsed (or no turn in flight): measure the ACTUAL result
    // (re-anchor on reality). Drift-class gate (2026-08-03): the EMA
    // alone is NOT enough to declare a turn aligned. The live stream
    // executes a turn ask at 79-240% of the request and the raw yaw
    // keeps rotating past the target after the EMA reads aligned
    // (measured: the walk started with the raw yaw 76-100° off and
    // carried her into the coffee table). Require BOTH the smoothed and
    // the RAW yaw within tolerance of the waypoint, HELD (mirror of
    // FACE_HOLD_S) so a transient mid-execution crossing cannot fire the
    // walk prompt.
    const emaErr = Math.abs(this.headingErrorDeg(waypoint))
    const rawErr = Math.abs(this.rawHeadingErrorDeg(waypoint))
    if (emaErr <= this.policy.TURN_TOLERANCE_DEG && rawErr <= this.policy.TURN_RAW_TOLERANCE_DEG) {
      if (goal.turnRawAlignedAtMs === null) goal.turnRawAlignedAtMs = now
      if (now - goal.turnRawAlignedAtMs >= this.policy.TURN_RAW_HOLD_S * 1000) {
        this.beginPhase('walk')
        return
      }
      return // aligned but holding — the raw yaw must stay settled
    }
    goal.turnRawAlignedAtMs = null
    // Not aligned. If the yaw is still moving (raw diverged from the EMA
    // mid-execution), WAIT — re-issuing onto a still-rotating stream
    // compounds the overshoot (measured live: 4×45° asks executed
    // 79-240% each and the heading never converged). Only a SETTLED
    // misalignment consumes the reissue budget.
    const rawSpread = Math.abs((wrapAngle(this.probe().yaw - (this.yawEma ?? this.probe().yaw)) * 180) / Math.PI)
    if (rawSpread > this.policy.TURN_RAW_SETTLE_SPREAD_DEG) return
    // Error remains (settled): re-issue with the REMAINING error
    // immediately. The settle window (not a fixed timeout) paces
    // iterations — the 45° request ceiling means a gross error needs
    // several steps, and an 8 s-per-step timeout turned zigzag
    // convergence into goal timeouts (unit sim, 2026-08-02). The FIRST
    // ask of the phase is free (it is the measurement that starts the
    // loop); each correction after it consumes the reissue budget, which
    // bounds a non-responding stream. On exhaustion, accept the error
    // and walk (the stall/replan feedback corrects gross misalignment
    // downstream).
    if (goal.turnSentAtMs === 0 || goal.turnReissues < this.policy.MAX_TURN_REISSUES) {
      if (goal.turnSentAtMs !== 0) goal.turnReissues += 1
      goal.phaseStartedAtMs = now
      goal.turnSentAtMs = now
      this.sendTurnPrompt(waypoint)
    } else {
      this.beginPhase('walk')
    }
  }

  private stepWalk(now: number, reflexActive: boolean): void {
    const goal = this.goal!
    if (reflexActive) {
      this.freezeTargetStall(now)
      return // reflex owns the prompt; restore re-issues ours
    }
    // Walk-absorption recovery (2026-08-08 positional class): a reflex
    // that just cleared means the walk was nav-REJECTED — the reflex
    // layer only fires on sustained rejection (live desk1: the walk froze
    // at a sweep-garbage heading that clipped the coffee table 0.27 m
    // from spawn — navAbsorbs 69, travelM 0.194, walkPromptCount 9 with
    // zero translation). The reflex restore re-issues the SAME walk into
    // the SAME wall; the stall detector then replans the SAME clear route
    // and fails "blocked path after 1 replan". Re-aim instead: the turn
    // phase owns the heading, and the walk only re-fires through the raw
    // gate — a fresh aim, not a re-press.
    if (this.reflexJustCleared) {
      console.info(`[planner] goal ${goal.id} walk absorbed — re-aiming at waypoint`)
      this.beginPhase('turn')
      return
    }
    if (this.trackTargetProgress(now)) return
    const probe = this.probe()
    if (goal.sentPrompt === null) {
      this.sendSegmentPrompt('walk')
      goal.walkPromptSentAtMs = now
      // Absorption accounting baseline (graze-class re-aim): the body's
      // monotonic nav-rejection counter at THIS prompt's send — frames
      // rejected during this walk count against it.
      goal.walkAbsorbBaseline = this.probe().navAbsorbCount ?? -1
      // Landing-window snapshot (2026-08-05): decide at SEND whether the
      // walk prompt needs a landing window at all. The window exists for
      // the never-settling handoff — the turn-phase sweep is LIVE when the
      // cap fires, and the walk prompt's landing (1.5-2.5 s) reads the
      // OLD stream's sweep garbage unless steering is suppressed. A
      // settled handoff (converged turn; instant-land unit sims) has no
      // landing risk and must not eat the window. |raw − EMA| is the
      // yaw's motion measure (rate × tau), exactly the discriminator
      // TURN_RAW_SETTLE_SPREAD_DEG uses.
      const spreadAtSend = Math.abs((wrapAngle(probe.yaw - (this.yawEma ?? probe.yaw)) * 180) / Math.PI)
      goal.walkLandWindowOpen = spreadAtSend > this.policy.WALK_LANDED_SPREAD_DEG
      goal.bestDistance = Infinity
      goal.stallSinceMs = null
    }
    const waypoint = goal.path[goal.waypointIndex]!
    const d = distanceXZ(probe.x, probe.z, waypoint.x, waypoint.z)
    // Walk-prompt landing window (2026-08-04 never-settling stream class):
    // after a walk prompt is sent it takes 1.5-2.5 s to REPLACE the old
    // stream (the same reset-chunk latency TURN_SETTLE_S covers). Until
    // the window elapses, the measured heading is the OLD stream's garbage
    // — a steering check here yanks the walk back into turn before it
    // ever moves (measured live: turn↔walk oscillation, each walk phase
    // ~1 tick, route length never improves, the target watchdog consumes
    // the replan). Suppress steering + lateral-gate for the window; the
    // walk prompt is in flight and the arrival check below still runs (a
    // body already inside the arrive radius must still arrive). The
    // landing window also does not count as per-waypoint stall time
    // (stallSinceMs is reset only WHILE the window is open — after it,
    // the normal stall accumulation resumes so a genuinely frozen body
    // still stalls).
    const walkSettledMs = goal.walkPromptSentAtMs + this.policy.WALK_SETTLE_S * 1000
    // The window's stall-clock semantics stay honest: while the window is
    // open the landing does not count as per-waypoint stall time (a body
    // that is still landing is not stalled), capped at WALK_SETTLE_S — a
    // stream that never moves after the window still stalls. A CLOSED
    // window (settled handoff) never touches the stall clock: the walk
    // stalls from its first non-progress tick, exactly like pre-window
    // behavior.
    if (goal.walkLandWindowOpen && now < walkSettledMs) {
      goal.stallSinceMs = null
    }
    // Early-close (2026-08-05): the window's suppression ends the moment
    // the yaw RE-ANCHORS — the walk stream landing freezes the heading
    // (live yaw-continuity re-anchor), collapsing |raw − EMA|. From that
    // sample the walk's heading is honest and the steering/lateral gates
    // may judge it: a usable freeze is judged immediately (no blind
    // drift time), a garbage freeze is yanked as soon as the landing
    // completes instead of eating the full window. The WALK_SETTLE_S cap
    // still bounds a stream whose yaw never re-anchors (never lands).
    const walkLanded = goal.walkLandWindowOpen &&
      Math.abs((wrapAngle(probe.yaw - (this.yawEma ?? probe.yaw)) * 180) / Math.PI) <= this.policy.WALK_LANDED_SPREAD_DEG
    const landingHolds = !goal.walkLandWindowOpen || walkLanded || now >= walkSettledMs
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
    // Landing-window gate (2026-08-04): steering is suppressed until the
    // walk prompt has had WALK_SETTLE_S to replace the old stream — a
    // same-tick check reads the OLD heading and yanks the walk before it
    // moves (the never-settling stream class, desk2 live). The gate only
    // applies when the send snapshot found the yaw MOVING (sweep
    // handoff), and closes early the moment the yaw re-anchors
    // (walkLanded); a settled handoff keeps the pre-window behavior.
    if (landingHolds && this.shouldSteer(waypoint)) {
      this.beginPhase('turn')
      return
    }
    // Final-approach lateral gate (2026-08-04): the coarse 60° threshold
    // tolerates a residual heading error the raw-gate turn phase leaves at
    // ≤25° — at 2-3 m range that is a 0.5-1.2 m PERPENDICULAR miss, and
    // the walk line never enters the arrive band (measured in the unit
    // sim: a perfectly straight walk at 10° off failed arrival at 0.5 m).
    // For the FINAL waypoint, steer whenever the perpendicular miss
    // (range × sin(err)) exceeds the arrival tolerance (minus margin), so
    // the walk line crosses the spot instead of passing beside it. The
    // raw-gate turn phase owns the correction (settle + hold — no reissue
    // onto a moving stream), so a late final-approach turn cannot compound
    // into the rosette the coarse threshold was sized against. A body that
    // is MOVING triggers it — closing OR tangent: a tangent walk (lateral
    // miss, ~0 closing speed) is exactly the live meander (measured:
    // straightness 0.295, 48 nav-absorbs into the door — she walked
    // 3.7 m circling the spot at constant range, the closing-gate never
    // fired, and the stall watchdog consumed the replan). A FROZEN body
    // (no probe displacement) still belongs to the stall/replan detector
    // — steering it just churns phases forever (measured in the unit sim:
    // 22 walk prompts and no stall before the target watchdog). The
    // no-turn zone still applies: inside WALK_NO_TURN_M the arrival
    // radius + braking lead take over (heading error there is
    // lateral-offset noise).
    const movedM = Math.hypot(probe.x - goal.prevProbeX, probe.z - goal.prevProbeZ)
    goal.prevProbeX = probe.x
    goal.prevProbeZ = probe.z
    // Landing-window gate on the lateral gate too (2026-08-04): a same-tick
    // lateral check during the walk-prompt landing reads the OLD stream's
    // heading — the corrected walk line is unknown until the new stream
    // lands. The final-approach turn then decides from an honest heading.
    // Like the steering gate: sweep-handoff window only, early-close on
    // re-anchor.
    if (landingHolds && isFinal && (closingSpeed > 0 || movedM > 0.02) && d > this.policy.WALK_NO_TURN_M) {
      const errDeg = Math.abs(this.headingErrorDeg(waypoint))
      const lateralMissM = d * Math.sin((errDeg * Math.PI) / 180)
      if (lateralMissM > this.policy.FINAL_APPROACH_LATERAL_M) {
        this.beginPhase('turn')
        return
      }
    }
    // Graze-absorption re-aim (2026-08-08 positional class): a walk
    // whose frames are being nav-REJECTED without approach progress is
    // pressed into an obstacle — the reflex layer only fires on sustained
    // rejection (the accumulator leaks below trigger on a slow graze), so
    // the planner's ONLY signal here is the body's own absorption counter
    // (live r2: 129 absorbs, walkPromptCount 14, travelM 1.05, NO reflex
    // line, "blocked path after 1 replan" — the stall detector burned the
    // goal's single replan on the SAME heading). Absorption is a HEADING
    // problem (re-aim — the turn owns the fresh aim), NOT a path problem
    // (replan): re-aiming preserves the replan budget for a genuinely
    // blocked route. Gated by the landing window (a same-tick check reads
    // the OLD stream's sweep) and by progress (a healthy walk that grazes
    // a boundary while advancing must not re-aim). The reflex-active case
    // is already handled above (freeze + restore re-issues ours).
    if (landingHolds && goal.walkAbsorbBaseline >= 0 && probe.navAbsorbCount !== undefined) {
      const absorbedThisWalk = probe.navAbsorbCount - goal.walkAbsorbBaseline
      if (
        absorbedThisWalk >= this.policy.WALK_ABSORB_REAIM_N &&
        d >= goal.bestDistance - this.policy.STALL_PROGRESS_EPS_M
      ) {
        console.info(
          `[planner] goal ${goal.id} walk absorbed ${absorbedThisWalk} frame(s) without progress — re-aiming at waypoint`,
        )
        this.beginPhase('turn')
        return
      }
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
      // Re-snapshot the window: a rotate re-prompt sent from a settled
      // (drifting-only) walk gets no window; one sent mid-sweep does.
      const spreadAtRotate = Math.abs((wrapAngle(probe.yaw - (this.yawEma ?? probe.yaw)) * 180) / Math.PI)
      goal.walkLandWindowOpen = spreadAtRotate > this.policy.WALK_LANDED_SPREAD_DEG
      this.sendSegmentPrompt('walk')
    }
  }

  private stepArrive(now: number, reflexActive: boolean): void {
    const goal = this.goal!
    if (reflexActive) return
    if (goal.sentPrompt === null) this.sendSegmentPrompt('arrive')
    if (now - goal.phaseStartedAtMs > this.policy.ARRIVE_PROMPT_S * 1000) {
      // Arrival != motion trust (re-anchor on reality, MotionBricks): the
      // stop coasted, now measure where she ACTUALLY ended up.
      const d = distanceXZ(this.probe().x, this.probe().z, goal.target.x, goal.target.z)
      const arrived = this.arrivedAtTarget()
      // Close-arrival accept (2026-08-08, pickup-cup bench): an arrival
      // miss at interaction range is accepted WITHOUT burning the goal's
      // single replan on a re-approach walk — the prompt supplies the
      // motion, and the re-approach turn is the load-fragile step (a
      // capped turn fires the walk with a residual heading; the walk
      // stalls and the goal dies "blocked" under host load — measured
      // live twice on the putdown phase). Outside it, the re-approach
      // below still applies; the walk is the right tool at range.
      if (!arrived && d <= this.policy.CLOSE_ARRIVE_ACCEPT_M) {
        console.info(`[planner] goal ${goal.id} arrival off by ${d.toFixed(2)} m — within close-accept ${this.policy.CLOSE_ARRIVE_ACCEPT_M.toFixed(2)} m, proceeding to interact`)
      } else if (!arrived) {
        // Outside the tolerance — braking-lead miss, stepping turn, or
        // stream overshoot — replan from the live position and re-approach
        // ONCE (shares the goal's replan budget); a second miss proceeds
        // with the residual journaled rather than looping approaches
        // forever.
        if (goal.replans < this.policy.MAX_WALK_REPLANS) {
          console.info(`[planner] goal ${goal.id} arrival off by ${d.toFixed(2)} m — re-approaching from actual position`)
          this.replanFromActual()
          return
        }
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
    // Face-drift guard (2026-08-08 arrival-quality class): the face
    // phase's turns can DRIFT the body off the spot — live: arrival
    // accepted on the spot (minDistanceM 0.013), face reissues orbited
    // her to 1.11 m (navAbsorbs 87 — the never-settling stream turns in
    // circles) and the interaction fired from range (arrivalM 1.113).
    // A drift beyond the accept band is a positional problem — re-approach
    // (shared replan budget) instead of interacting from range. Gated on
    // replan budget (a re-approach must actually be possible) and
    // debounced (a transient turn-execution drift must not fire it).
    const dSpot = distanceXZ(this.probe().x, this.probe().z, goal.target.x, goal.target.z)
    if (dSpot > this.policy.FACE_DRIFT_REAIM_M) {
      if (goal.faceDriftSinceMs === null) goal.faceDriftSinceMs = now
      if (now - goal.faceDriftSinceMs >= this.policy.FACE_DRIFT_GUARD_S * 1000) {
        if (goal.replans < this.policy.MAX_WALK_REPLANS) {
          console.info(
            `[planner] goal ${goal.id} face drifted her ${dSpot.toFixed(2)} m off the spot — re-approaching`,
          )
          this.beginPhase('arrive')
          return
        }
        // No replan budget: proceed with the residual rather than loop.
        goal.faceDriftSinceMs = null
      }
    } else {
      goal.faceDriftSinceMs = null
    }
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
      // Reissue budget exhausted: accept the residual facing ONLY from
      // interaction range — a face that drifted her out of the accept
      // band re-approaches instead (the arrive gate replans once, then
      // proceeds journaled).
      const dAtExhaustion = distanceXZ(this.probe().x, this.probe().z, goal.target.x, goal.target.z)
      if (
        dAtExhaustion > this.policy.FACE_DRIFT_REAIM_M &&
        goal.replans < this.policy.MAX_WALK_REPLANS
      ) {
        console.info(
          `[planner] goal ${goal.id} face could not converge and drifted her ${dAtExhaustion.toFixed(2)} m off the spot — re-approaching`,
        )
        this.beginPhase('arrive')
      } else {
        this.beginPhase('interact')
      }
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
    if (phase === 'turn') {
      goal.turnRawAlignedAtMs = null
      // A fresh turn phase has no prompt in flight: the first measurement
      // is the phase's first ask (free), and corrections after it consume
      // the reissue budget (stepTurn).
      goal.turnSentAtMs = 0
    }
    if (phase === 'walk') {
      goal.walkPromptSentAtMs = -Infinity
      goal.walkLandWindowOpen = false
    }
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
    goal.turnRawAlignedAtMs = null
    goal.stallSinceMs = null
    goal.bestDistance = Infinity
    goal.sentPrompt = null
    goal.turnSentAtMs = 0
    goal.faceAlignedAtMs = null
    goal.prevWaypointDist = Infinity
    goal.prevProbeAtMs = 0
    goal.prevProbeX = probe.x
    goal.prevProbeZ = probe.z
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
    // Interaction-completion hook (INTERACTABLES_SPEC.md): fires ONLY when
    // the goal genuinely completed with its interaction prompt played
    // (phase 'interact'). Cancels/clears/supersedes/timeouts/failures never
    // reach the interaction, so they never invoke the hook — the scene's
    // pickup semantics (attach/putdown) must not fire on aborted goals.
    if (reason === 'completed' && goal.phase === 'interact') {
      this.onInteractionComplete?.(goal.id, goal.interaction)
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

  /** Signed heading error (deg) to a point vs the RAW probe facing — the
   * stream's ACTUAL executed heading, not the filtered one. The turn→walk
   * gate reads this (drift class): the EMA can read aligned while the raw
   * yaw is still rotating past the target, and a walk prompt sent then
   * goes off-heading into the nearest obstacle. */
  private rawHeadingErrorDeg(waypoint: Vector3): number {
    const probe = this.probe()
    const desired = Math.atan2(waypoint.x - probe.x, waypoint.z - probe.z)
    return (wrapAngle(desired - probe.yaw) * 180) / Math.PI
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

  /**
   * Essence idle driver (spatial layer 4) — the body follows the state.
   * Polls the state provider on the presence cadence (ESSENCE_POLL_S); when
   * nothing else owns the prompt (priority model: watchdog > user > reflex >
   * planner > essence-driver) and an ordered drive rule matches, starts the
   * goal and journals WHY (goalSource: rule + state snapshot). Only fresh
   * state drives goals; unmatched rules fall through to the ambient deck
   * exactly as before. No threshold tuning, no whims, no new interaction
   * points — the manifest vocabulary is the only goal space.
   *
   * Returns true when this tick's evaluation was consumed by the driver
   * (poll slot stamped + rules evaluated, whether or not a goal started);
   * false when the driver is not actionable (cadence-gated, owner-blocked,
   * no fresh state, or no rule matched) — the caller then lets the ambient
   * deck try, which is the designed fallback.
   */
  private maybeStartEssence(now: number): boolean {
    // Poll gate: the state provider is re-read on the presence cadence, not
    // every frame.
    if (now - this.lastEssencePollMs < this.policy.ESSENCE_POLL_S * 1000) return false
    // Transient prompt-owner gates do NOT consume the poll slot (Mai RCA
    // t_af24521d): a reflex/watchdog block or user-quiet window is a
    // condition, not an evaluation — stamping pre-gates burned the 30 s
    // cadence on blocked polls and let the ambient deck claim the single
    // goal slot before the driver got a clean window. The slot is stamped
    // only once the evaluation is accepted (fresh state read).
    if (this.channel.isReflexActive() || this.channel.isWatchdogHolding()) {
      this.driverSkip('reflex|watchdog')
      return false
    }
    // User intent outranks the driver: a recent user prompt silences it.
    if (now - this.channel.lastUserPromptAtMs() < this.policy.ESSENCE_USER_QUIET_S * 1000) {
      this.driverSkip('user-quiet')
      return false
    }
    const state = this.essenceState()
    if (state === null || state.fresh !== true) {
      this.driverSkip('no-state|stale')
      return false
    }
    // Stamp AFTER gate acceptance — a blocked evaluation never burns the
    // cadence, so the first clean tick can fire immediately.
    this.lastEssencePollMs = now
    const pick = this.pickEssenceGoal(now, state)
    if (pick === null) {
      this.driverSkip('no-rule')
      return false
    }
    // Record cooldown + dwell anchors BEFORE the attempt so a failed start
    // (no path) also cools down — the driver never hammers setGoal every poll.
    this.essenceLastFiredAt.set(pick.goal, now)
    this.essenceLastStartedAtMs = now
    this.lastDriverSkipKey = null
    if (!this.setGoal(pick.goal, 'essence')) return true
    this.goalSource = { kind: 'essence', rule: pick.rule, state: { ...state } }
    // Journal the cause in the prompt log (spec: "energy 0.2 → daybed.nap
    // observed in telemetry + prompt log") — the log stream ties the goal to
    // the rule that fired it.
    this.journalPrompt('interact', `[goal] ${pick.goal} (essence: ${pick.rule})`)
    console.info(
      `[planner] essence driver: rule "${pick.rule}" → ${pick.goal} ` +
      `(energy ${fmtScore(state.energy)}, focus ${fmtScore(state.focus)}, ` +
      `stress ${fmtScore(state.stress)}, sociability ${fmtScore(state.sociability)}, ` +
      `activity ${state.activity ?? '?'})`,
    )
    return true
  }

  /** Journal a blocked/empty essence evaluation: monotonic telemetry counter
   * (driverSkips) + a console line on reason transitions only. */
  private driverSkip(reason: 'reflex|watchdog' | 'user-quiet' | 'no-state|stale' | 'no-rule'): void {
    const counter = this.driverSkips.essence
    if (reason === 'reflex|watchdog') counter.reflexWatchdog += 1
    else if (reason === 'user-quiet') counter.userQuiet += 1
    else if (reason === 'no-state|stale') counter.noState += 1
    else counter.noRule += 1
    const key = `essence:${reason}`
    if (key !== this.lastDriverSkipKey) {
      console.info(`[planner] essence driver skipped: ${reason} (${counter.noRule + counter.noState + counter.userQuiet + counter.reflexWatchdog} total)`)
      this.lastDriverSkipKey = key
    }
  }

  /**
   * Ordered first-match drive-rule evaluation. A rule whose goal does not
   * resolve against the manifest is skipped fail-closed (never crash, never
   * execute — same discipline as the deck). Per-goal cooldown and the
   * min-dwell hysteresis gate every rule.
   */
  private pickEssenceGoal(
    now: number,
    state: EssenceStateSnapshot,
  ): { rule: string; goal: string } | null {
    for (const rule of this.policy.ESSENCE_DRIVE_RULES) {
      if (this.resolveInteraction(rule.goal) === null) continue
      if (!this.clausesMatch(rule.when, state)) continue
      const last = this.essenceLastFiredAt.get(rule.goal)
      if (last !== undefined && now - last < rule.cooldownS * 1000) continue
      if (now - this.essenceLastStartedAtMs < rule.minDwellS * 1000) continue
      return { rule: rule.rule, goal: rule.goal }
    }
    return null
  }

  /** AND-ed clause evaluation. A missing (null) state field fails the clause
   * — no state means no rule fires (fail-closed). */
  private clausesMatch(clauses: readonly EssenceDriveClause[], state: EssenceStateSnapshot): boolean {
    for (const clause of clauses) {
      const value = state[clause.field]
      if (value === null || value === undefined) return false
      if (clause.op === 'eq') {
        if (String(value) !== String(clause.value)) return false
        continue
      }
      const left = Number(value)
      const right = Number(clause.value)
      if (!Number.isFinite(left) || !Number.isFinite(right)) return false
      switch (clause.op) {
        case '<': if (!(left < right)) return false; break
        case '<=': if (!(left <= right)) return false; break
        case '>': if (!(left > right)) return false; break
        case '>=': if (!(left >= right)) return false; break
      }
    }
    return true
  }

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
