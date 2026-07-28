# [SPEC] Phase D2 — Live Autonomous Execution (Free Tier)

## Problem

Phase D1 proved the front half: operators notice irritations, form wants, and
propose them to Josh as messages. But proposals are read-only — Josh still
executes everything manually. The division needs operators to perform
bounded, reversible, journaled actions on their own, starting with the
safest class: documentation and notes.

## Constraints

- essenced writes ONLY its covenant files (derived_state.json, journal.jsonl,
  outreach_journal.jsonl); all action writes go through the lease/executor path
- No Hermes core modifications; reuse essence_proposal.approve_proposal and
  execution_lease_manager as-is (extend, don't fork)
- Whitelists are data (governance yaml), not code
- Every action must be reversible before it runs (pre-image captured first)
- Report-back is mandatory: every executed action produces a §19 outreach
  message on both lanes. Silence = failure state.
- Per-operator enable flags, default OFF; pilot = mai only

## Shape

```
want (D1) → proposal (D1) → essenced approval caller (NEW) → execution lease (NEW class)
          → executor handler (NEW: docs_wiki_notes) → rollback marker → execution
          → report-back outreach message (both lanes) → journal complete
```

Components:

1. **essenced approval caller** (`approver.py` in essenced): first real caller
   of `essence_proposal.approve_proposal()`. Approves iff: proposal maps to an
   enabled free-tier lease class AND G1–G6 gates pass AND guardrails clear
   (caps/cooldowns/breaker). Actor string: `essenced:governor-pilot`.
2. **Lease class `docs_wiki_notes`** in execution_lease_manager's
   ALLOWED_PROPOSAL_TYPES + ALLOWED_ACTIONS + DEFAULT_TTL: append-or-edit of
   markdown/notes under whitelisted roots only
   (`/root/hermes-webui-hyrax/docs/`, profile `notes/` dirs). TTL 30 min.
   Rate limit 2/operator/day (config).
3. **Executor handler** (essence_local_executor or a thin essenced wrapper):
   - capture pre-image (backup copy to `<file>.bak.<timestamp>` or git ref)
   - write rollback marker BEFORE the action runs
   - perform the edit (append or bounded section edit, never full-file rewrite)
   - write execution record + evidence hash
4. **Report-back**: executed action → composition turn (what she did, why,
   how it went) → both lanes, same fire_id as the proposal.
5. **Failure path**: any executor error → rollback restore attempted
   automatically, journaled, report-back says it failed honestly.

## Acceptance criteria

- [ ] Seeded broken doc (test fixture with an obvious error) → mai proposes →
      essenced approves → lease issued → doc fixed → backup exists → rollback
      marker written BEFORE the edit → report-back message arrives on both lanes
- [ ] Approval caller refuses: non-free-tier class, gate failure, breaker open,
      rate limit hit — each journaled with reason
- [ ] Rollback proven: corrupt the post-edit state, run rollback restore,
      original content returns
- [ ] Adversarial QA: can't write outside whitelisted roots (traversal battery),
      can't execute without valid lease, can't get a lease without stored
      policy-trusted approval
- [ ] essenced test suite green + real propose() chain tests

## Non-goals

- No code edits, no config changes, no deletions, no external services
- No approval-tier (G8/josh path) — that's D3
- No kanban_create lease — that's D3
- No multi-operator enablement — pilot is mai only; D4 graduates others

## Links

Spec: gameplan §2, ESSENCE_ACTIVE_RUNTIME.md §20 (D2)
Assignee: tai | Reviewer: rei | Pilot operator: mai
