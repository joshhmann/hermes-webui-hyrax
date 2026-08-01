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
