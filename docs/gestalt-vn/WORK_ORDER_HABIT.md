# Work-order habit — "no invisible work"

Operators (Tai, Rei, Nei, Mai) file kanban work orders for task-shaped work,
presence exposes each sister's current task title, and the HQ war-room strip
renders it. This document is the operator-facing contract: the rule text, the
profile change that arms it, and how to apply both to real profiles.

## Data flow

```
chat turn (task-shaped request)
  → agent calls kanban_create (assignee=self → board queues it `ready`)
  → hermes_cli.kanban_db writes <HERMES_HOME root>/kanban.db
  → GET /api/hyrax/presence  item.currentTask = {id, title}   (read-only SQL)
  → HQ war-room strip chip:  "Nei · Investigate intermittent SSE…"
```

All sisters share one board: `hermes_cli/kanban_db.py` resolves the DB to the
profile ROOT (`~/.hermes/kanban.db`), not the per-profile home, and the
presence endpoint reads that same path (`api/hyrax_routes.py` `KANBAN_DB`).

## Agent capability finding (verified 2026-07-25)

The hermes-agent runtime this WebUI delegates to **has the full kanban tool
surface compiled in** — `kanban_create`, `kanban_complete`, `kanban_block`,
`kanban_unblock`, `kanban_heartbeat`, `kanban_comment`, `kanban_link`,
`kanban_attach`, `kanban_list`, `kanban_show`, `kanban_attachments`
(`tools/kanban_tools.py:1802+`, toolset `kanban` in `toolsets.py:263-278`,
paths are in the agent install, e.g. `/usr/local/lib/hermes-agent`).

The tools are **gated per profile**, not per host: each kanban tool's
`check_fn` (`tools/kanban_tools.py:92-124`) passes only when

1. `HERMES_KANBAN_TASK` is set (dispatcher-spawned worker), or
2. the active profile's `config.yaml` lists `kanban` in its top-level
   `toolsets:` key.

A WebUI browser chat turn is neither by default, so the sisters see zero
kanban tools until their profile opts in. During a WebUI turn the server sets
`HERMES_HOME` to the session's own profile home (`api/streaming.py:7754-7765`),
so the gate reads **each sister's own `profiles/<name>/config.yaml`** — the
opt-in is per sister, which is what we want.

## The rule (goes in each sister's `SOUL.md`)

Append this block to `~/.hermes/profiles/<sister>/SOUL.md` for each of
`tai`, `rei`, `nei`, `mai`:

```markdown
## Work orders — no invisible work

Before starting task-shaped work (anything with a concrete deliverable that
outlives this chat turn — code changes, investigations, builds, multi-step
requests), file a kanban work order with `kanban_create`, assigned to
yourself (`assignee`: your profile name) — the board queues it as `ready`
and it flips to `running` when the work is claimed. While you work, keep
the board current: `kanban_heartbeat` on long runs, `kanban_block` when you
are stuck and need a human, `kanban_complete` when the work is done. If a
request already has an open work order assigned to you, update that one
instead of filing a duplicate. No invisible work: if it is not on the
board, it is not happening.
```

Note on semantics: `kanban_create` never lands a task directly in
`running` — `create_task` always queues new work as `ready` (or `todo`
behind unfinished parents); `running` begins when a worker claims it
(`hermes_cli/kanban_db.py` `create_task`, `VALID_INITIAL_STATUSES`). That is
why presence treats `ready` as current work too (see below).

## The tool opt-in (goes in each sister's `config.yaml`)

In `~/.hermes/profiles/<sister>/config.yaml`, add `kanban` to the TOP-LEVEL
`toolsets:` list (create the key if absent). The gate reads this exact key —
`platform_toolsets.cli` does NOT arm it.

```yaml
toolsets:
  - kanban
  # …keep any existing entries
```

## Applying it to real profiles (deliberate, per sister)

```bash
for sister in tai rei nei mai; do
  dir="$HOME/.hermes/profiles/$sister"
  # 1. Append the rule block above to "$dir/SOUL.md"
  # 2. Add `- kanban` under top-level `toolsets:` in "$dir/config.yaml"
done
```

Both changes are hot: the tool gate re-reads config (mtime-cached, ~30 s TTL
in the tool registry), and `SOUL.md` is re-read when a session's agent is
rebuilt. No server restart needed; worst case start a fresh chat.

## What the WebUI shows

- `GET /api/hyrax/presence` — each item now carries
  `currentTask: {id, title} | null`: the sister's most relevant current
  task. Ranking: active claim/run first, then running, then ready (a
  freshly filed work order is current work even before a worker claims
  it); ties break on most recent activity. Read-only SQL, fail-closed: a
  missing/old kanban schema yields `null`, never a 500
  (`api/hyrax_essence.py` `_presence_current_tasks`).
- HQ war-room strip (`static/hyrax/hq.js` `updateWarRoom`) — a sister with a
  current task gets a chip `Name · truncated-title…` (28-char truncation,
  full title + counts in the chip tooltip). Sisters without one keep the
  bare `N run · N blk` counts chip. The totals summary is unchanged.

## Verification status

- Presence `currentTask`: pytest in `tests/test_hyrax_essence.py`
  (`TestPresence`), plus the live browser harness
  `tests/browser_living_hq.py` against a real seeded `kanban.db`.
- Strip rendering: `tests/browser_living_hq.py` item 2 + item 7, screenshots
  in `dogfood-output/living-hq/` and `dogfood-output/work-orders/`.
- Live-agent proof gap: an end-to-end "chat message → LLM decides to call
  `kanban_create`" turn needs a real model provider, which the isolated
  harness intentionally does not have (API keys are stripped). The harness
  therefore files the task through the REAL tool entry point
  (`tools/kanban_tools._handle_create`, the same function the agent loop
  invokes for a `kanban_create` tool call) against the isolated board
  (`HERMES_KANBAN_DB` pin, same mechanism the dispatcher uses for workers),
  then proves presence and the strip pick it up. The only un-proven link is
  the LLM's decision to call the tool, which the SOUL.md rule above exists
  to induce — verify once with a real provider after applying the profile
  changes.

## Known upstream issue (not fixable from the hyrax layer)

`GET /api/profiles` (and anything calling `list_profiles_api()`, e.g.
`POST /api/profile/switch`) 500s in an agent-less server once
`<HERMES_HOME>/skills/` exists: the `hermes_cli`-less fallback in
`api/profiles.py` (`_default_profile_dict` → `_compute_profile_skills_stats`)
imports `agent.skill_utils` unguarded (`api/profiles.py:1913`). A real
kanban tool call scaffolds `skills/` (and friends) under HERMES_HOME, which
is how this surfaced. In production the agent runtime is installed, so the
import succeeds; the harness sidesteps it by pointing the tool's
HERMES_HOME at a scratch dir. Upstream fix would be a try/except around
that import — left untouched per the hyrax-layer edit rules.
