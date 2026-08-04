# [SPEC] Essence-Driven Goals — the body follows the state (spatial layer 4)

## Problem

The goal planner (48639512) executes goals; today goals come from the user
(Go to button) or a tiny static ambient deck. The whole point of the stack
is that *she* decides: essence computes restlessness, fatigue, focus —
and the body acts on it. This layer swaps the goal source from the static
deck to her live derived state. Same planner, same seams, new driver.

## Design

### State source

The loft already reads essence for the VN/HQ: `/api/hyrax/presence`
serves `derivedState` (mood, condition, activity, presentation). The goal
driver polls it on the presence cadence (~30s) — no new backend.

### Drive rules (data, in the loft config — mirrors essence thresholds)

```
energy < 0.30           → daybed.nap      (tired → lie down)
energy > 0.70 & focus > 0.60
                        → desk.work       (energized + focused → work)
stress > 0.65           → window.look     (stressed → look out the window)
sociability high & idle → couch.sit       (relaxed → lounge)
```

- Rules are ordered, first match wins, each with `cooldown_s` (default
  600s per goal) and a `min_dwell_s` (don't abandon a goal early just
  because state flipped — hysteresis, not ping-pong).
- Only fires when nothing else owns the prompt (existing priority model:
  watchdog > user > reflex > planner > essence-driver — the driver
  REPLACES the static ambient deck as the lowest tier).
- If no rule matches: current ambient idle behavior (unchanged).
- Operator identity: the driver reads the operator the loft belongs to
  (tai for the tai-loft; the mechanism is operator-generic — the
  manifest's interaction ids + that operator's derived state).

### Journaling (visible cause)

Every essence-driven goal logs WHY (rule matched + state snapshot) into
telemetry (`planner.goalSource: { kind: 'essence', rule: 'energy-low',
state: {...} }`) so the story is legible: "she lay down because energy
0.24". The whims panel / derived state can surface this later; v1 is
telemetry-only.

## Acceptance criteria

- [ ] Drive rules as data (config block, not code); ordered first-match,
      per-goal cooldown, min-dwell hysteresis
- [ ] Seeded state (test seam setting derived values) → correct goal
      fires: energy 0.2 → daybed.nap observed in telemetry + prompt log
- [ ] Hysteresis: state flips mid-goal → goal continues to completion or
      min-dwell before a new rule can preempt
- [ ] Priority preserved: user prompt cancels an essence goal (journaled
      as user win); reflex interrupts/resumes; watchdog suspends
- [ ] No state change = no behavior change (rules unmatched → ambient
      deck path exactly as before)
- [ ] Live: manipulate mai/tai's derived state via the existing seed
      mechanism (or a test-only presence override) → watch her lie down
      when exhausted, on the real service; telemetry shows goalSource
      with the rule + snapshot
- [ ] Suites 144/144+ green; GEVS wall-absorb 1.0; new unit tests for
      rule matching/hysteresis/priority

## Non-goals

- No whims integration yet (whims as goal source is the NEXT increment —
  this is condition/mood, not wants)
- No changes to essenced (read-only consumption of derived state)
- No new interaction points (uses the existing manifest)
- No learning/tuning of rules (thresholds are reviewed data, changed by
  humans)

## Links

GOAL_PLANNER_SPEC.md (planner), SCENE_MANIFEST_SPEC.md (interactions),
ESSENCE_ACTIVE_RUNTIME.md (state semantics)
Assignee: tai | Reviewer: rei | Verify: kimi reviews + commits
