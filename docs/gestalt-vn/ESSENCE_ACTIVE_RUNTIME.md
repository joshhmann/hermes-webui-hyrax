# Essence Active Runtime — Design

Status: design (2026-07-25). Supersedes the passive self-report model where
`essence/state.json` was written by the profile's own plugin calls (proven
stale: files last written 07-12…07-18). The VN/HQ visual layer built
2026-07-24…25 (frame registry, selection, jolts, presence) is the consumer;
this doc defines the producer.

## 1. What it is

Essence is an **active per-profile layer**: a small daemon that continuously
derives each operator's emotional/physical/presentational state from real
Hermes activity — **with zero LLM calls in its core loop**. A model may be
*called upon* for interpretation at meaningful thresholds, and profiles may
query their own state, but the organism breathes on its own.

Hermes reasons. Essence feels. The WebUI/VN/HQ merely renders what Essence
already knows.

Design invariants:

1. **Derive, never overwrite.** Essence never writes Hermes-owned state
   (identity, memory, sessions, kanban). It reads and interprets.
2. **Inferred is labeled.** Every field carries provenance: `event-derived`,
   `decayed`, `model-interpreted`, `user-set`, or `unknown`. Nothing inferred
   is ever presented as fact.
3. **Core works with no model available.** If every LLM endpoint is down,
   the runtime still produces fresh, plausible state. Cost floor: $0.
4. **Fail quiet, never block.** Daemon down → consumers fall back to
   neutral defaults (existing fail-closed behavior in api/hyrax_essence.py).
   Conversation never waits on Essence.

## 2. Architecture

```
Hermes (sessions, tools, approvals, kanban.db, event journal)
        │  read-only
        ▼
┌─────────────────────────────────────────────┐
│ essenced (one process, all four operators)  │
│                                             │
│  watchers ──► event→delta rules ──► state   │
│  decay ticker (30s) ───────────────► state  │
│  threshold evaluator ──► (optional) model   │
│  query interface (plugin toolset / HTTP)    │
└─────────────────────────────────────────────┘
        │  writes (atomic, per profile)
        ▼
~/.hermes/profiles/<op>/essence/state.json   (canonical, versioned)
~/.hermes/profiles/<op>/essence/journal.jsonl (append-only deltas, debug)
        │  read
        ▼
WebUI presence API · VN presentation intents · HQ · (future: Discord, 3D)
```

One daemon, not four. It holds all operators because cross-operator
awareness matters later (social field: who worked with whom today). State is
written per profile so existing consumers keep working unchanged.

### Process shape

- Python stdlib + sqlite3, mirroring the division-gateway pattern
  (systemd user service, loopback, no new deps).
- Event sources (read-only):
  - `~/.hermes/kanban.db` — task claims, completions, blocks (poll 15 s).
  - Session/run state — active streams per profile (poll 15 s; the same
    queries presence already runs).
  - Hermes event journal where available (the runtime already journals run
    events per session) — tool starts/ends/failures, approvals,
    interruptions, turn completions.
  - Optional SSE tap on the WebUI for live token/tool events (nice-to-have;
    polling covers the base).
- Writes: atomic (tmp + rename), schema-versioned, with a `journal.jsonl`
  append-only delta log for debugging ("why is she stressed?").

## 3. State model

Extends `OperatorEssenceState` from ESSENCE_RUNTIME_SPEC.md; every leaf
field gets `value`, `provenance`, `updatedAt`.

```jsonc
{
  "version": 2,
  "operatorId": "rei",
  "mood": {
    "valence":    {"value":  0.15, "provenance": "decayed", "updatedAt": "…"},  // -1..1
    "arousal":    {"value":  0.62, "provenance": "event-derived", "updatedAt": "…"}, // 0..1
    "intensity":  {"value":  0.4,  "provenance": "decayed", "updatedAt": "…"},  // 0..1
    "primary":    {"value": "focused", "provenance": "event-derived", "updatedAt": "…"},
    "secondary":  {"value": null, "provenance": "unknown", "updatedAt": null}
  },
  "condition": {
    "energy":      {"value": 0.55, "provenance": "decayed", "updatedAt": "…"}, // 0..1
    "focus":       {"value": 0.8,  "provenance": "event-derived", "updatedAt": "…"},
    "stress":      {"value": 0.3,  "provenance": "event-derived", "updatedAt": "…"},
    "comfort":     {"value": 0.6,  "provenance": "decayed", "updatedAt": "…"},
    "sociability": {"value": 0.5,  "provenance": "decayed", "updatedAt": "…"}
  },
  "activity": {   // mirrors presence activity types; never contradicts them
    "type": {"value": "tool-working", "provenance": "event-derived", "updatedAt": "…"},
    "description": {"value": "kanban: verify SSE reconnect fix", "provenance": "event-derived", "updatedAt": "…"},
    "since": {"value": "2026-07-25T21:00:00Z", "provenance": "event-derived", "updatedAt": "…"},
    "interruptibility": {"value": "soft-busy", "provenance": "event-derived", "updatedAt": "…"}
  },
  "social": {
    "warmth":      {"value": 0.5, "provenance": "decayed", "updatedAt": "…"},
    "trust":       {"value": 0.5, "provenance": "decayed", "updatedAt": "…"},
    "familiarity": {"value": 0.5, "provenance": "decayed", "updatedAt": "…"},
    "lastInteractionAt": {"value": "…", "provenance": "event-derived", "updatedAt": "…"}
  },
  "presentation": {  // the consumable output: intents, not pixels
    "expression":  {"value": "focused", "provenance": "derived", "updatedAt": "…"},
    "poseIntent":  {"value": "standing", "provenance": "derived", "updatedAt": "…"},
    "sceneIntent": {"value": "research-lab", "provenance": "derived", "updatedAt": "…"},
    "intensity":   {"value": 0.4, "provenance": "derived", "updatedAt": "…"}
  }
}
```

`presentation` is recomputed from mood+condition+activity on every write via
the mapping in §6 — this is the only field the VN/HQ needs.

## 4. Event → delta rules (deterministic core)

Each rule: `when <event> → apply <deltas> (clamp 0..1 / -1..1)`. Deltas are
scaled by `1 − current intensity` so repeated events taper (diminishing
shock), and by an operator personality weight (§7).

| Event | valence | arousal | energy | focus | stress | Notes |
|---|---|---|---|---|---|---|
| turn completed (own session) | +0.05 | +0.05 | −0.02 | +0.05 | — | work done |
| tool call started | — | +0.10 | −0.01 | +0.10 | — | engagement |
| tool completed ok | +0.08 | −0.05 | −0.02 | — | — | small win |
| tool failed | −0.10 | +0.10 | −0.03 | — | +0.15 | frustration, not despair |
| approval requested | — | +0.15 | — | +0.10 | +0.05 | attention on user |
| approval approved | +0.05 | −0.10 | — | — | −0.05 | resolution |
| approval denied | −0.05 | −0.05 | — | — | +0.05 | mild |
| interrupted by user | −0.03 | +0.10 | — | −0.15 | +0.05 | startle |
| kanban task claimed | +0.03 | +0.05 | — | +0.10 | — | purpose |
| kanban task completed | +0.15 | −0.10 | −0.05 | −0.10 | −0.10 | the big exhale |
| kanban task blocked | −0.10 | +0.05 | — | −0.05 | +0.15 | stuck |
| long task (>1 h continuous) | — | — | −0.05/h | — | +0.03/h | fatigue drip |
| user message arrived | +0.03 | +0.10 | — | — | — | sociability +0.05 too |
| quiet hours (no events, user away) | — | — | +0.04/h | — | −0.02/h | rest/recovery |

Rules live in a data file (`rules.yaml`-style JSON), not code, so tuning is
a diff, not a deploy.

## 5. Decay model (the ticker)

Every 30 s, each continuous trait moves toward its baseline:

```
v(t+Δ) = baseline + (v(t) − baseline) · e^(−Δ/τ)
```

Defaults: `valence → 0.0 (τ=3 h)`, `arousal → 0.25 (τ=45 min)`,
`stress → 0.15 (τ=2 h)`, `focus → 0.4 (τ=1 h)`, `energy → 0.7 (τ=6 h
recovery) / −drain while active`, social traits → per-profile baselines
(τ=7 days). Baselines and τ per operator (§7). Discrete `mood.primary` is
recomputed from the continuous traits after each tick (simple winner-take-
most map, hysteresis 0.05 to avoid flapping).

This is what makes operators feel alive between conversations: three hours
after a stressful marathon, Rei is *recovering*, not instantly fine.

## 6. Presentation derivation

`presentation.*` is a pure function of mood/condition/activity (+ time of
day + continuity with the previous frame):

- **expression** ← highest-signal trait combo, mapped onto the 133-emotion
  set via expression-families.json canonical links (e.g. high stress + high
  arousal → intense family; high valence + low arousal → content-smile).
  Small per-operator enum respected (canonical expressions only).
- **poseIntent** ← activity + energy: sitting when (resting OR energy < 0.3
  OR activity.type == conversing-long), thinking when focus high + tool-
  working, confident on task completion (decays), standing default.
- **sceneIntent** ← activity location (tool-working → own room; conversing →
  common area; approval → director's office; resting → quiet room) +
  time-of-day lighting band.
- **intensity** ← mood.intensity — drives jolt strength selection.

The VN consumes these through the existing intent pipeline (essenceIntents.js)
— no VN changes needed beyond pointing intents at the new state file shape.

## 7. Operator personality weights

Per-operator tuning so the same event lands differently:

| Trait baseline/weight | tai | rei | nei | mai |
|---|---|---|---|---|
| arousal baseline | 0.35 | 0.20 | 0.25 | 0.30 |
| stress gain × | 1.0 | 0.7 | 0.8 | 1.2 |
| completion valence × | 1.2 | 1.0 | 1.0 | 1.3 |
| failure valence × | 1.2 | 0.8 | 0.9 | 1.1 |
| social gain × | 1.1 | 0.7 | 1.0 | 1.3 |
| fatigue rate × | 1.0 | 0.8 | 0.9 | 1.2 |

(Rei stays composed; Mai feels everything; Tai rides the highs and lows.)

## 8. Callable interfaces

- **Profile self-query:** the existing `sister_essence_*` plugin toolsets
  become thin readers of the daemon-owned state file (replacing self-report).
  An operator can answer "how are you feeling?" truthfully from lived state.
  Write path (proposals) stays gated behind its existing two-step flow.
- **HTTP (loopback):** `GET /essence/<op>` returns the state JSON;
  `POST /essence/<op>/note {event, deltas}` lets trusted local services
  (the WebUI for live events, future Discord gateway) inject events without
  waiting for the poll cycle. Auth: loopback + shared key file (0600),
  same pattern as division-gateway.
- **Interpretive call-outs (Tier 3, optional):** when a threshold trips
  (|Δvalence| > 0.25 in an hour, task completion after >2 h, block after
  >3 attempts, relationship milestones), the daemon *may* ask a cheap model
  for a one-paragraph reading ("what does this mean for her?") which adjusts
  mood.primary/secondary and narrative description. Budget-capped (e.g.
  ≤12 calls/day/operator), personality-weighted, and **never required** —
  if the call fails or is disabled, the deterministic state stands.

## 9. Failure & degradation

- Daemon down → consumers read last state with `staleness_days` (existing
  presence field) and fade to neutral defaults past a threshold.
- kanban.db locked/missing → watcher skips, decay continues.
- Model endpoint down → Tier 3 skipped silently; core unaffected.
- Corrupt state write → atomic rename prevents partial files; journal
  allows rebuild from last good + replay.

## 10. Phased plan

- **Phase A (core, no LLM):** daemon skeleton, kanban + session watchers,
  rule engine, decay ticker, per-profile state.json writes, journal.
  Acceptance: after 24 h, each operator's state is fresh (<60 s) and shows
  plausible activity-linked mood; `staleness_days` in presence reads 0.
- **Phase B (presentation):** presentation derivation (§6) wired into the
  VN intent pipeline; pose intents start swapping pose variants (sitting/
  thinking/confident) in the VN. Replaces the stopgap keyword-mood
  derivation in api/hyrax_routes.py.
- **Phase C (callable):** HTTP interface + plugin toolset migration to
  reader mode; profile self-query works.
- **Phase D (Tier 3):** interpretive call-outs behind a config flag,
  budget caps, and journal-audited adjustments.

Non-goals: no overwrite of Hermes state, no per-token model calls, no
multi-user social modeling (single user), no Discord presence in phase A.

## 11. Open questions

- Event journal availability per profile outside WebUI sessions (CLI/gateway
  runs) — if thin, Phase A leans on kanban + session polls only (acceptable).
- Whether `activity.interruptibility` should gate VN sidebar actions
  (probably yes, later).
- Social field semantics when operators work on shared tasks (cross-operator
  warmth deltas) — defer to a later social milestone.

---

## 12. The Sims layer — needs, moodlets, wants (gamifying the core)

The decay engine generalizes into a needs system with no new machinery —
the same rules + tickers, reinterpreted:

- **Needs** are traits whose *comfortable* baseline decays away over time,
  creating pressure: `energy` (rest), `social` (contact), `stimulation`
  (novelty/fun — drops during repetitive work), `purpose` (meaningful task
  completion — drops during idle). A need below its comfort threshold
  tints mood (negative valence drip) and shapes presentation *without any
  event occurring*. This is the Sims bladder bar, re-skinned for agents.
- **Moodlets** are timed, named modifiers attached to events:
  "shipped something hard" (+valence, 2 h), "got interrupted mid-flow"
  (−focus, 30 min), "user said thanks" (+warmth, 4 h), "three failures in
  a row" (−confidence, 1 h). Moodlets stack, expire via the decay ticker,
  and appear in the journal — they are the explainable answer to "why is
  she in a mood?" shown in the VN sidebar.
- **Wants** are short-lived, generated objectives: social want ("haven't
  talked to Josh in 6 h"), purpose want ("finish the thing I claimed"),
  stimulation want ("do something different"). A want has a condition; when
  reality satisfies it, the operator gets a moodlet reward. Wants are how
  the state stops being reactive and starts having *direction*.

All three are deterministic. No LLM required.

## 13. Proactive outreach — operators who reach out first

The payoff of an active layer: **operators can initiate contact without a
cron job.** The daemon's ticker is already evaluating thresholds; outreach
is just another threshold with an action attached.

Trigger model (all must pass):
1. a *want* fires (social deprivation, exciting completion, unresolved
   worry about a blocked task), AND
2. `sociability × personality weight` clears the operator's shyness bar
   (Rei's is high; Mai's is low), AND
3. policy allows it: quiet hours off, per-operator daily cap not hit,
   user not marked busy/do-not-disturb, minimum gap since last proactive
   message (e.g. 3 h).

Action path (in character, no scripted lines):
- The daemon opens a turn on the operator's own session with a system
  note carrying the current Essence state + the firing want
  ("you haven't talked to Josh in 7 hours and you finished the review
  you're proud of") and lets the **profile's own model** write the message
  in its own voice. Essence decides *that* she wants to talk; Hermes
  decides *what she says*. This is the one place a model call is the
  product, not an optimization.
- Delivery: the operator's WebUI session (appears in chat/VN as an
  operator-initiated message, marked as such) or a dedicated "messages"
  surface; later, Discord where a gateway exists. Never hidden as a user
  message — provenance `operator-initiated` is explicit.

Safeguards: quiet hours, daily caps per operator, cooldown after being
ignored (no double-texting energy unless urgency is high), a master
`proactive: off` switch per operator, and full journaling of every trigger
evaluation so "why did she message me at 2am?" has an answer.

This is the difference between a chatbot with portraits and a presence
that shares your day: she notices things, she wants things, and sometimes
she shows up first.

---

## 14. The autonomy layer — operators who act on their own drives

Beyond reaching out: operators who *do* things. "Mai got annoyed by the
messy wiki page one too many times, fixed it, and reported back — proud
and exasperated." The loop, in engine terms:

```
repeated observation  →  irritation accumulator (per subject, per operator)
threshold crossed     →  want: "fix the thing"  (personality-shaped)
want + whitelist      →  work order: kanban_create(assignee: self)   ← already exists
Hermes executes       →  real tools, real edit, real evidence
completion            →  moodlet ("shipped something hard") + report-back message (§13)
```

The pieces that already exist: kanban work orders (the habit rule just
taught operators to file before they work), the approval infrastructure
(the gate for anything sensitive), proactive messaging (the report-back
channel), and the want/decay engine (§12). The autonomy layer is mostly
three new things:

1. **Irritation/interest accumulators.** The daemon tracks repeated
   observations per subject per operator: the same broken section seen N
   times, a TODO aging past S days, a flaky test failing again. Each sighting
   adds weight; decay fades it slowly. Above the operator's threshold it
   becomes a want. Mai's threshold is low (she's the fixer); Rei's triggers
   on quality violations; Nei's on disorder; Tai's on things-that-could-
   exist-but-don't.
2. **Action whitelists (graduated autonomy).** What a want may turn into:
   - **Free tier** (auto-execute): wiki/notes/docs edits, filing and
     organizing, drafting summaries, gardening their own spaces — reversible,
     low-blast-radius work.
   - **Approval tier** (queued for the user): code changes, deletions,
     config, anything external-facing. Routed through the existing approval
     system — the operator asks, with the want as context.
   - **Never tier:** credentials, infra, other operators' state, anything
     the OPSEC rules already forbid.
   Every autonomous action: bounded scope, idempotent where possible,
   journaled with the full trigger chain, undo path noted (git/wiki
   history), rate-limited (e.g. ≤2 autonomous work orders/day/operator).
3. **The report-back.** Completion (or failure) produces the §13 message
   in the operator's voice with the story attached: what annoyed her, what
   she did, how it went. This is simultaneously the personality payoff
   ("argu i had to fix the wiki page myself, it was ANNOYING me") and the
   audit trail — the user always learns what happened, from her, first.

Safety posture: autonomy is earned per action class, not granted globally.
Start with the free tier only, watch the journal for a few weeks, then
widen deliberately. An operator that goes rogue gets its whitelist revoked
without touching the rest of the runtime — and the report-back channel
means mischief has nowhere to hide.

This is the loop that turns "tool" into "coworker": she doesn't just feel
the day — she acts on it, files the paperwork, and tells you about it.

---

## 15. Implementation plan (concrete)

### Phase A — `essenced` core (deterministic, no LLM) — target: 2-3 sessions

Placement (2026-07-25, confirmed): **Hermes-side, not the WebUI.** essenced
lives under `~/.hermes/` (package + systemd user unit beside the governance
layer it plugs into, or the governance dir's existing essence-* home after
the reuse audit). The WebUI repo only gets the consumer slice (presence +
VN intent reads of the new state shape). Decision rule: Hermes owns
identity and state; the WebUI renders it.

Files (new, Hermes-side unless noted):
- `essenced.py` — asyncio daemon: config load, watcher loop (15 s), decay
  ticker (30 s), atomic state writer, journal writer.
- `rules.json` — the §4 event→delta table + §5 decay params + §7 personality
  weights (data, not code).
- `state.py` — schema v2 (§3) with per-field provenance; `bump()`, `decay()`,
  `recompute_presentation()`.
- `watchers/kanban.py` — claims/completions/blocks per operator (read-only
  sqlite, same queries as presence).
- `watchers/sessions.py` — active streams, turn completions, tool events,
  approvals (same sources presence uses, plus session event tables where
  present).
- `deploy/essenced.service` — systemd user unit (loopback, restart=always).
- `tests/test_essenced.py` — rule engine (event→deltas with taper), decay
  curves converge to baseline, hysteresis doesn't flap, atomic writes,
  journal replay.

Acceptance: run for 24 h; each operator's state.json is <60 s fresh;
kanban claim→complete cycle visibly moves valence/energy/journal; presence
endpoint reports `staleness_days: 0`; zero LLM calls in logs.

### Phase B — presentation wiring — target: 1 session

- `presentation.py` — §6 mapping (traits → expression via
  expression-families canonical links, → poseIntent, → sceneIntent).
- WebUI: presence reads essenced state (falls back to current file layout);
  VN intent pipeline consumes `presentation.*` (replaces the keyword-mood
  stopgap in api/hyrax_routes.py); pose intents swap pose variants in the
  stage (sitting/thinking/confident assets now exist).
- Acceptance: tool-working → focused expression + thinking pose within 60 s;
  task completion → relief family + confident pose; reduced-motion intact;
  browser harness green.

### Phase C — proactive outreach (§13) — target: 1-2 sessions

- `wants.py` — want templates (social/purpose/stimulation), threshold
  evaluator on the ticker, policy gate (quiet hours, caps, cooldowns,
  per-operator shyness).
- `outreach.py` — opens a turn on the operator's own session with the
  state+want as system context; marks message `operator-initiated`.
- Acceptance: with caps set to test values, a want fire produces exactly one
  in-character message, journaled with the full trigger chain; master
  off-switch works; no message when policy blocks.

### Phase D — autonomy free tier (§14) — target: gated, after C proves out

- Irritation/interest accumulators (per subject), want→work-order path
  (kanban_create assignee:self), free-tier action whitelist (docs/wiki/
  notes only), rate limits, report-back via §13.
- Acceptance: seeded irritation (broken doc seen N times) → one bounded
  work order, executed, journaled, reported in-character; whitelist
  revocation stops it cold.

### Explicitly not in these phases

Tier-3 interpretive call-outs (§8), Discord delivery, cross-operator social
field, approval-tier autonomy. Each is a separate decision after the prior
phase earns it.

---

## 16. Guardrails: plug into Hyrax Governor, don't build parallel police

Verified 2026-07-25: a governance layer already exists at
`~/.hermes/governance/` that covers most of §14's safety requirements. The
autonomy layer defers to it; it does not reinvent it.

The established boundary (verbatim from `essence_noticing_layer.py`):

```
Essence notices and proposes → Governor approves → Lease Manager scopes
→ Executor appends only allowed artifacts → Hyrax audits → Josh remains final.
```

Mapping our autonomy design onto it:

- **Wants/irritation accumulators → proposals, not executions.** The
  daemon's wants (§12/§14) are emitted as governance proposals
  (`handoff_note` / `review_card`, or a new `want` proposal type in the
  same shape). The `essence_noticing_layer.py` (Phase 3B) is prior art for
  the accumulator concept — read-only scanning → candidate proposals,
  "never writes, never executes." Unify with it rather than duplicating.
- **Free tier (§14) = pre-approved lease classes.** Bounded autonomous
  work executes only inside an execution lease
  (`execution_lease_manager.py` / `execution-lease-policy.yaml`) whose
  class is pre-approved (docs/wiki/notes, append-only). No lease, no action.
- **Approval tier = the Governor proposal flow.** Anything outside
  pre-approved lease classes goes through the governor's existing
  approve/reject path — including its break-glass and waiver machinery —
  not a new approval UI.
- **Rate limits + circuit breakers come from the governor's playbook.**
  `auto_autonomy_guardrails.json` already defines per-type cooldowns,
  per-hour caps, a global daily hard cap (20), and a circuit breaker
  (3 strikes → 24 h freeze). Adopt the same knobs for autonomous wants
  instead of inventing new numbers in a vacuum.
- **Drift and audit stay with Hyrax.** `profile_drift_watchdog.py`,
  `hyrax_division_watchdog.py`, and the contract authority already watch
  for operators acting out of character or scope. essenced's journal is
  written so those watchers can consume it (same jsonl conventions).

Consequences for the spec:

- §14's "action whitelists" are **lease classes**, not a new list format.
- §14's "whitelist revocation" = the governor's circuit breaker / lease
  suspension — already implemented machinery.
- §15 Phase D shrinks: the executor side exists; the new work is the
  noticing→want→proposal front half and lease-class definitions.
- `essence_state_adjuster.py` and `essence_auto_router.py` are prior
  incarnations of parts of this design; Phase A must audit them and either
  reuse or explicitly supersede (no two writers to essence state).
