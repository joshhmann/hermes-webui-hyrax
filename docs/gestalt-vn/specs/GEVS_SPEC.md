# [SPEC] GEVS — Gestalt Embodiment Validation Suite

## Purpose

Every calibration profile, IK change, runtime update, and new motion model
must pass GEVS before it's considered production-ready. Wrongness in
embodiment is instantly visible (sliding feet, twisted hips, timing drift) —
GEVS makes it *measurable*: per-category scores per avatar, comparable over
time, gateable in CI.

## Principles

- **Measure, don't eyeball.** Every check is a probe metric (root trajectory,
  foot clearance, yaw delta, gate events, live-%) with thresholds. Stills/
  clips are evidence, not scores.
- **Fail before, pass after.** A GEVS check must demonstrably fail when the
  thing it guards breaks (proven by reverting).
- **Same harness, every consumer.** One suite drives the debug page, the
  loft, and future avatars — no per-benchmark forks (the cha-cha bench
  scripts in /tmp are the embryo; promote them into the repo).
- **Honest scoring.** Scores are computed from metrics with stated
  thresholds — never "looks about right." Partial credit is explicit.
- Copyright: benchmark *patterns* (line-dance primitives), never the
  original choreography/recordings.

## Levels

### Level 1 — Basic kinematics (v1)
idle (lean drift, sway bounds) · walk forward/backward (travel, direction,
path straightness) · strafe left/right · turn 90° (yaw delta ±tolerance) ·
sit → stand (rootY transition, recovery)

### Level 2 — Human motion (v1)
short shuffle sequence (step R×2, step L×2, heel R, heel L, quarter turn,
repeat ×2 — measures locomotion, coordination, turning, timing, repeats) ·
wave (amplitude, no explosion) · reach left/right · squat (rootY range,
feet planted) · balance one foot 3s (lean, foot swap)

### Level 3 — Interaction (future — needs scene objects)
pick up cube · push button · open door · carry object · climb stairs ·
push door / pull lever

### Level 4 — Embodied intelligence (future — needs behavior layer)
follow a person · react to voice · navigate a room to a named spot ·
complete a multi-step task

## Score model (v1)

Per check: measured metric vs threshold → pass/partial/fail with the
numbers recorded. Per category (locomotion, turning, hands, foot-contact,
dance, balance): mean of checks × 100. Overall: mean of categories.
Report = JSON (machine) + markdown table (human), stored per run with
profile id, git sha, service config (history budget, model) for
reproducibility.

Categories and their v1 checks:
- Locomotion: walks, strafes (travel error vs requested)
- Turning: turn 90, quarter turns in shuffle (yaw error)
- Hands: wave, reach (hand path amplitude, symmetry)
- Foot contact: all checks (lowest foot Y ≥ threshold, no slide during
  contact frames)
- Dance: shuffle sequence (phrase completion %, timing consistency)
- Balance: idle sway, one-foot balance, squat recovery

## v1 acceptance criteria

- [ ] Harness lives in repo (hyrax-3d/tests/bench/ or debug/bench/), runs
      headless against the live service + isolated WebUI, produces JSON +
      markdown report with the score table
- [ ] Level 1 + Level 2 checks implemented with thresholds; each check
      records evidence (metrics JSON + key stills)
- [ ] Tai's baseline run committed to docs (score table)
- [ ] At least one check proven to fail when its subsystem is broken
      (e.g. disable treadmill absorb → walk-into-wall check fails)
- [ ] Nightly/manual invocation documented; CI hook is future work
- [ ] Shortened shuffle sequence defined as data (prompt list + timing),
      not hardcoded choreography

## Non-goals (v1)

- No music synchronization (timing is measured vs prompt schedule, not BPM)
- No Level 3/4 (scene objects, behavior layer required)
- No visual/choreographic fidelity scoring (leg-crossing quality etc.)
- No multi-avatar comparison automation (run per avatar, compare by eye)

## Links

REsearch/ARDY_TRANSITIONS_AND_DRIFT.md (T1/T2), EMBODIMENT_PLATFORM_ARCHITECTURE.md
(validation-as-you-go amendment), cha-cha benchmark run 2026-08-02 (7/8 phrases)
Assignee: kimi/tai | Reviewer: rei | First subject: tai (tai-embodiment-v3)
