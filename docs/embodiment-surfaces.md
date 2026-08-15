# Embodiment Surfaces — Doctrine + v1 Integration

Status: DIRECT-4 (t_5b0e193b) · Owner: Tai (builder) · Reviewed: Rei (gate)

## The doctrine

One line, three surfaces:

- **Gestalt room = AMBIENT PRESENCE** (who's around, mood, activity).
- **VN = CONVERSATION.**
- **War room = OPS FLOOR.**

- **v1 integration = links + shared presence state, NOT a mega-merge.**
  Each surface keeps its own job; integration is cross-referencing
  presence/task state, not absorbing the others.

## What each surface is for

| Surface | Job | Shared state it consumes | Source |
|---|---|---|---|
| Gestalt room | Ambient presence — who is around, mood, activity | presence.json per operator (DIRECT-2 per-operator feeds) | `/api/hermes/status` on the room, `/api/hyrax/presence` on the WebUI |
| VN | Conversation — one sister, one thread, stage + dialogue | Current task context (what she is working on), via `/api/hyrax/presence` | `static/hyrax/vn.js` header chip |
| War room | Ops floor — where the line is, what is blocked | Operator presence strip per lane, via `/api/hyrax/presence` | `static/hyrax/warroom.js` floor section |

The shared presence state for v1 is **GET /api/hyrax/presence** — a single
server-side aggregation of per-sister activity, expression/mood, pending
approvals, kanban counts, and the current kanban task. All three surfaces
read from it. None writes to it.

## v1 scope (what this integration IS)

1. **Cross-references, not absorption.** Each surface links into the others'
   state through the shared presence endpoint, but keeps rendering its own
   view. The war room shows *who is on the floor*; the VN shows *what the
   sister you are talking to is working on*; the room shows *who is around*.
2. **Read-only everywhere.** Every integration point is a GET against
   `/api/hyrax/presence` (or the room's own status endpoint). No surface
   writes presence, no surface mutates another surface's state.
3. **One refresh cadence.** The war room keeps its single 30s refresh cycle
   (now fetching presence alongside the board snapshot); HQ keeps its 30s
   visibility-gated timer and pushes the fresh map into the VN header chip.
   No new polling loops were added anywhere.
4. **Quiet by default.** No pings, no notifications, no toasts, no sounds.
   Presence state renders silently; failures fail soft (a missing presence
   fetch hides the strip/chip, it never errors the surface).
5. **Doctrine is the contract.** If a future feature wants to merge two
   surfaces, or have one surface write another's state, that is a doctrine
   change — it needs a new card and an explicit decision, not a silent diff.

## Explicitly NOT v1

- **No mega-merge.** The three surfaces stay separate UIs with separate
  panels. There is no combined "one screen" and no plan for one.
- **No task tracker.** The VN header shows the *current* task context from
  presence only. It does not fetch kanban history, does not render a task
  list, and is not a board.
- **No server-side contract changes.** `/api/kanban/war-room` and
  `/api/hyrax/presence` are unchanged by this card. If a future integration
  needs new fields, that is a contract card with its own evidence.
- **No notification/ping machinery.** Quiet hours are preserved: nothing in
  v1 pings, dings, or alerts during quiet hours or any other time.
- **No duplication of the room.** The gestalt room already reflects live
  presence via DIRECT-2 per-operator feeds; v1 verifies it end-to-end and
  does not build a second room presence view.

## Promise control-plane projection

The War Room also projects the canonical Promise tables from the Kanban
database through `GET /api/kanban/war-room`. The `commitments` field is
read-only and contains only canonical Promise membership, state, aggregate
budget usage, pending durable notifications, and cross-Promise relations.
It never infers commitments from task titles or legacy notes, and the WebUI
has no write route for it. If the installed Agent lacks the Promise schema,
the field explicitly reports unavailable rather than showing a misleading
legacy approximation.

## Verification (DIRECT-4)

- `/api/hyrax/presence` returns the full operator set (tai, rei, nei, mai,
  aya) with activity, expression, mood (derivedState), and currentTask.
- `/api/hermes/status` on the gestalt room returns `connected: true` with
  actor presence (persona, status, mode, mood, activity, observed_at) —
  the room reflects live presence.json.
- `node --check` passes on warroom.js, hq.js, vn.js.
- War-room Node harness covers the presence strip; HQ/VN migration harness
  still passes with the new presence fetch.
