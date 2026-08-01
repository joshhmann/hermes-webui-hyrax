# [SPEC] Phase D3 — Kanban Lease Class + Approval Tier

## Problem

D2 proved free-tier autonomy: operators execute bounded docs/wiki/notes edits
alone. But most real work isn't doc edits — it's filing and tracking work
(tasks), and everything bigger (code, config, deletions, external calls)
currently has no path at all. D3 adds the two missing rungs: operators
managing their own work orders, and a governed route for Josh to approve
larger actions without becoming the bottleneck.

## Constraints

- Free tier stays exactly as D2 shipped — no behavior change to
  docs_wiki_notes execution
- kanban_create is self-assigned only: an operator may create/update tasks
  assigned to themselves. No status changes on others' tasks, no assignment
  to other operators, no deletes
- Approval tier never auto-executes: it produces a Josh-visible approval
  request and waits. Deny/expire = journaled no-op, not a failure
- essenced still never authors report content; the operator's model voices
  proposals and report-backs
- All new limits are data (rules.json + governor yaml), never code

## Shape

### Part 1 — `kanban_create` lease class

```
want ("track this work") → proposal (type kanban_create) → essenced approval
→ lease (TTL 30 min, 4/operator/day) → kanban_create/comment via the CLI
bridge (hermes kanban create --assignee <self>) → evidence journaled
→ report-back on both lanes ("i filed t_xxx for this")
```

- Allowed actions: create task (assignee=self), comment on own task,
  heartbeat own task. Forbidden: complete/block others' tasks, reassign,
  delete, edit others' fields.
- The want's payload carries title/body/links; the executor renders the CLI
  call, captures the task id, and links it into the proposal.
- Breaker: 3 consecutive denials → 6h open (existing machinery).

### Part 2 — Approval tier (the G8 josh gate)

```
want (bigger action) → proposal flagged approval_required
→ essenced does NOT approve → Josh approval request (WebUI approvals
   surface + optional Discord ping)
→ on approve: lease issued by the stored approval → execute → report-back
→ on deny/expire: journaled, want closes with a moodlet ("rejected, okay")
```

- G8 implementation: replaces the hardcoded not_checked stub in
  essence_proposal with a real check — proposals with risk class
  external_resource/config_write/code_edit/destructive require
  `approval_required` and route to Josh.
- Josh's approval surface: the WebUI approvals panel (existing
  infrastructure) + a compact Discord notification ("Mai wants to edit
  config.yaml — approve? [link]").
- Timeout: 24h default (config); expiry is neutral for the breaker.

## Input decisions (2026-08-01, from D2 review t_e5a65b3b)

Two findings from the D2 authority-model review became explicit D3 input
decisions. Josh approved the recommended defaults; no veto. Both are
reflected in the running config (rules.json / hyrax-governor.yaml) and
this spec.

### F3 — the autonomy daily cap counts execution ATTEMPTS, not deliveries

- Finding: a failed report-back did NOT increment the autonomy daily
  counter (proposals.py:274-281 pre-decision), so a second execution the
  same day stayed eligible up to the lease cap. §20.5 treats silence as
  failure; the cap should too.
- Decision: count execution ATTEMPTS toward the daily cap regardless of
  delivery (fail-closed leaning). The counter now increments at attempt
  time (approval clean + lease in hand), before executor outcome and
  independent of report-back delivery. A failed report-back still consumes
  the day's budget.
- Data: `autonomy.execution.count_attempts` in rules.json (default true;
  set false to restore delivered-only counting). The autonomy gate
  (`policy.py evaluate_autonomy_gate`) reads the same counter, so a second
  attempt the same day is refused once one attempt was made.
- Replay consistency: `replay_autonomy_counters` mirrors the runtime —
  autonomy_execution entries with outcome executed/failed increment daily
  regardless of the delivery entry; D1 proposal deliveries still count on
  delivery (no execution behind them).

### F5 — docs_wiki_notes whitelists the real wiki root

- Finding: the lease class whitelisted `/root/hermes-webui-hyrax/docs` +
  per-operator `profiles/<op>/notes`, but the actual wiki
  (`/root/workspace/wiki`) was NOT writable — fail-closed, correct, but
  the class name over-promised (a want targeting a wiki page was refused).
- Decision: add `/root/workspace/wiki` as an explicit whitelisted root in
  the D3 lease-class config, keeping every existing containment/bounds
  check (resolve + prefix containment, suffix/banned-part filters, executor
  re-check before the write). The class was always meant to cover wiki
  notes; the alternative (renaming the class to `docs_notes`) was rejected
  by default — no rename.
- Data: `hyrax-governor.yaml` → `proposal_governor.lease_classes.
  docs_wiki_notes.roots`.

### Live-proof requirement (Rei note 4, t_6fa64fe2)

- Future live proofs of D3 MUST drive through `autonomy_tick()` end-to-end
  (seeded want → gate → proposal → approval → lease → execute → report-back)
  so the gate/cap bookkeeping and the `autonomy_evaluation` journaling join
  the evidence trail. A harness that calls chain components directly does
  NOT count as a live proof of D3 (D2's live proof ran via harness; the
  evaluation record and persisted autonomy state were covered by tests
  only — D3 acceptance evidence must include them).

## Acceptance criteria

- [ ] Seeded want → mai files a real kanban task assigned to herself
      (visible in `hermes kanban list`), comment lands, task id linked in
      proposal + journal
- [ ] Self-assignment enforced: a crafted payload targeting another operator
      is refused with reason
- [ ] Rate limit: 5th task in a day refused (cap 4), journaled
- [ ] Approval-tier proposal (e.g. a config edit) produces a Josh approval
      request and does NOT execute; approve → executes + report-back;
      deny → journaled, no execution, no breaker denial
- [ ] G8 real check: free-tier classes never require Josh; approval-tier
      classes always do
- [ ] F3 (attempt-counting): an execution whose report-back FAILS still
      increments the autonomy daily counter — a second execution attempt
      the same day is refused at the daily cap (suite test + live proof
      through autonomy_tick())
- [ ] F5 (wiki root): a want targeting /root/workspace/wiki/<page>.md
      executes with backup + rollback marker; containment still refuses
      paths outside ALL whitelisted roots (docs, wiki, profile notes)
- [ ] Suite green + adversarial QA (self-assignment bypass attempts, approval
      spoofing, cooldown/breaker interactions)

## Non-goals

- No D4 graduation logic (per-operator enablement beyond mai)
- No playground/whims lease (that's the whims spec)
- No changes to the existing approval UI framework itself — reuse it
- No external-service actions (network, Discord posting by operators beyond
  their outreach lane)

## Links

Spec: gameplan §3, ESSENCE_ACTIVE_RUNTIME.md §20 (D3), D2_LIVE_EXECUTION_SPEC.md
Assignee: tai | Reviewer: rei | Pilot operator: mai
