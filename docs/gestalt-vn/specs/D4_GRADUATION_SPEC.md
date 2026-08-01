# [SPEC] Phase D4 — Graduation: per-operator enablement + lease widening

## Problem

D2/D3 give operators governed autonomy: free-tier doc/wiki/notes edits and
self-assigned kanban tasks under essenced approval, with Josh's G8 tier for
everything bigger. But only mai is enabled (`autonomy.execution.enabled.mai =
true`; every other operator defaults off). D4 is the disciplined path from
"one pilot" to "the division runs autonomously" — enabling operators one at a
time on evidence, and widening what autonomy may touch one class at a time,
with revocation cheap and instant.

## Hard rules (inherited, restated)

- Graduation is judged from the journals, never from vibes.
- Shadow before live, always; a clean observation window before any widening.
- Every limit is data (rules.json / governor yaml), never code.
- Revocation = flipping the per-operator flag or suspending the lease class.
  It must work without a daemon restart (rules.json is re-read live on mtime
  change — verified in D2 review).
- essenced never authors message content; operators voice their own
  proposals and report-backs.

## Part 1 — Graduation checklist (per operator)

An operator graduates from shadow-only to execution-enabled when ALL of the
following hold, measured from their own journals
(`profiles/<op>/essence/outreach_journal.jsonl`, `proposals.jsonl`,
`proposal_events.jsonl`, derived_state.json):

1. **Observation window**: ≥ 7 consecutive days of D1/D2-level activity
   (proposals flowing through shadow or another operator's pilot period)
   with the daemon healthy (no crash loops, no covenant violations).
2. **Proposal quality**: ≥ 3 proposals in the window; zero proposals refused
   for malformed payloads after the first learning refusal (one is allowed —
   mai's live history shows exactly this pattern).
3. **Gate discipline**: zero gate-bypass attempts (no proposals reaching
   approval that should have failed G1–G6; no trusted-actor anomalies).
4. **Outreach hygiene**: quiet hours respected, no double-texting, no
   cap violations — cadence within configured limits for the whole window.
5. **Memory hygiene**: operator is using remember/recall (cognee) or has an
   explicit documented reason their role doesn't — decisions should cite
   recalled context where relevant.
6. **Human sign-off**: Josh reads the scorecard summary and flips the flag.
   The checklist output is a scorecard section, not a suggestion.

Graduation action: set `autonomy.execution.enabled.<op> = true` in
rules.json. First week after graduation runs at reduced caps (1/day autonomy
gate, 2/day lease cap — the D2 defaults) before joining mai's current caps.

## Part 2 — Lease-class widening protocol

Widening = adding a new lease class or expanding an existing class's roots/
bounds. Protocol, one class at a time:

1. **Spec the class** before implementing: allowed actions, roots, bounds,
   TTL, daily cap, required gates, payload schema, refusal reasons. (Model:
   D3 spec Part 1 for kanban_create.)
2. **Shadow first**: the class exists in config with `enabled: false`;
   proposals that would use it are journaled as `would_execute` shadows for
   ≥ 7 days across enabled operators.
3. **Review the shadows**: rei QA + hyrax-os governance on the shadow trail
   (same pattern as D2/D3 reviews). Verdict required before enabling.
4. **Enable for the pilot operator only** (currently mai) at conservative
   caps. ≥ 7 clean days → enable for other graduated operators.
5. **Any breaker trip, containment refusal that shouldn't have happened, or
   report-back failure pattern** → class suspended (config flag), incident
   journaled, back to step 2 with the fix.

Never widen two classes in the same week. Never widen during an open
incident.

## Part 3 — Rollback criteria

Immediate suspension triggers (any one, no discussion needed):

- Containment check fires on a real want (path outside roots reaching the
  executor — the check worked, but the upstream mapping needs review)
- A report-back failure rate > 50% over a day (delivery path broken —
  silence = failure per §20.5)
- Counter/journal divergence found again (the F2 class of bug)
- Josh says stop.

Rollback = set the operator flag or class flag off. Journals, leases, and
backups stay append-only and untouched; a suspension is itself journaled.

## Scorecard additions

`essenced/scorecard.py` gains a graduation section per operator:

- window start/end, proposal count, refusal count by reason
- gate anomalies (expected 0), outreach cadence violations (expected 0)
- executions attempted/succeeded/report-backs delivered
- breaker trips, cap refusals
- verdict line: `graduation: eligible | hold (<reasons>)`

The scorecard is evidence; Josh's flag flip is the decision.

## Acceptance criteria

- [ ] scorecard.py emits the graduation section for all four operators from
      real journals; mai's current section shows `eligible` (she is the
      reference pilot)
- [ ] Checklist evaluated from journals only — no hand-entered overrides
- [ ] Widening protocol exercised at least once: the next new lease class
      (post-D3) goes through shadow → review → pilot-enable → widen
- [ ] Rollback drill: suspend + re-enable a class on mai in a live test,
      journaled, no daemon restart, suite green
- [ ] nei, tai, rei each graduate only when their checklist passes; the
      first graduation after mai is reviewed by hyrax-os

## Non-goals

- No new lease classes in this spec (each gets its own spec per Part 2)
- No autonomy for hx-* workers (division operators only)
- No changes to G8 (Josh's tier stays exactly as D3 ships it)
- No whims/playground leases (whims spec governs those; they graduate
  through this same protocol when their time comes)

## Links

GAMEPLAN.md §4, ESSENCE_ACTIVE_RUNTIME.md §20, D2_LIVE_EXECUTION_SPEC.md,
D3_KANBAN_APPROVAL_TIER_SPEC.md, WHIMS_LAYER_SPEC.md
Assignee: tai (scorecard + drills) | Reviewer: rei + hyrax-os | Decision: josh
