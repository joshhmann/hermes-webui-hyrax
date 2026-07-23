# Hyrax VN Native Session Adapter

- **Status:** Accepted
- **Author:** Hyraxknot Division
- **Created:** 2026-07-22

Implementation is tracked through the Hyrax integration task graph. The
control-plane donor remains a read-only fallback/reference until runtime parity
is approved.

## Decision

The Hyrax visual-novel surface is a presentation adapter over Hermes WebUI's native session and run model. It must not retain or recreate the control-plane gateway's conversation database, run coordinator, event journal, authentication layer, work-proposal system, or command materialization paths.

A VN conversation ID is the native Hermes `session_id`.

Native WebUI remains authoritative for:

- profile-owned session persistence;
- user and assistant transcript messages;
- model/provider/workspace resolution;
- active-run serialization and conflict handling;
- run cancellation;
- live stream events and durable run-journal replay;
- persistent session SSE and completed-during-gap recovery;
- archive state and session history.

The Hyrax adapter owns only:

- the fixed sister allowlist and display metadata;
- selecting or creating one active VN-tagged session per sister;
- mapping native session/message/event shapes to the existing VN presentation;
- validating that VN routes can access only VN-tagged sessions owned by an allowlisted sister profile;
- an authenticated same-origin SSE alias that applies VN ownership validation and then delegates to native session-event machinery.

## Dropped donor subsystems

The following control-plane constructs are not ported:

- `browser_sessions`, login attempts, or a second CSRF system;
- `conversations`, `turns`, or `events` SQLite tables;
- proposal drafts, work proposals, approvals, materialization, command drafts, receipts, or Plane-era dispatch;
- control-plane profile endpoint configuration;
- a duplicate agent runner, subprocess manager, active-run registry, cancellation registry, or replay journal;
- donor `/api/v1/*` compatibility aliases.

The control-plane checkout remains read-only fallback/reference until runtime parity is approved; it is not a runtime dependency.

## Native state mapping

Each VN session MUST have:

- `session.profile` equal to one of `tai`, `rei`, `nei`, or `mai`;
- `session.project_id == "hyrax-vn"`;
- native `session.archived` state;
- native message persistence.

The adapter returns only an allowlisted subset of session fields. It must never expose filesystem paths, provider credentials, raw tool arguments, environment data, or cross-profile sessions.

### Active conversation rule

For each sister profile:

1. Find unarchived sessions with `project_id == "hyrax-vn"` and matching `profile`.
2. Select the newest by native `updated_at`, then `created_at`, with deterministic `session_id` tie-break.
3. If more than one exists because of legacy/race state, keep the newest and archive the rest under the native session lock before returning.
4. If none exists, create one using native `new_session(profile=<sister>, project_id="hyrax-vn")` and a bounded display title such as `Tai VN`.
5. Session creation alone may remain in-memory under the native ghost-session contract; the first submitted turn is the natural persistence point.

Creating a fresh VN conversation archives the currently active VN session and creates a new native session. It does not delete history.

## Route namespace

All routes are authenticated same-origin WebUI routes under `/api/hyrax/vn`. They are explicitly dispatched; no import-time patch or wrapper is permitted.

### GET `/api/hyrax/vn/profiles`

Returns the fixed allowlist and presentation metadata only:

```json
{
  "items": [
    {
      "id": "tai",
      "name": "Tai",
      "role": "Builder",
      "available": true,
      "assets": {
        "neutral": "/api/hyrax/assets/tai.portrait.neutral",
        "background": "/api/hyrax/assets/tai.background.control-room",
        "chibi": "/api/hyrax/assets/tai.chibi.stand",
        "model": "/api/hyrax/assets/tai.embodiment.vrm"
      }
    }
  ]
}
```

Asset paths must be local allowlisted paths. Availability may be derived from installed profiles, but unknown profiles must never be reflected from caller input.

### POST `/api/hyrax/vn/conversations`

Body:

```json
{"profile_id":"tai","fresh":false}
```

Behavior:

- reject non-object JSON, unknown keys, non-string values, and non-allowlisted profiles;
- use native profile/session helpers without mutating process-global active profile;
- return the selected/created VN-tagged native session shaped as a VN conversation;
- when `fresh` is true, archive the current VN session and create a new one;
- serialize create/archive per profile to prevent duplicate active VN sessions.

### GET `/api/hyrax/vn/conversations/{session_id}`

Behavior:

- require a safe native session ID;
- load the full native session;
- require `project_id == "hyrax-vn"` and allowlisted `profile`;
- return bounded transcript messages in native order;
- map `role == "user"` to Josh and assistant-compatible roles to the sister;
- ignore internal/system/context-control rows that are not renderable transcript messages;
- include native `active_stream_id`, `message_count`, archive state, and timestamps only when needed by the client.

A profile/session mismatch returns sanitized 404, not an ownership oracle.

### POST `/api/hyrax/vn/conversations/{session_id}/turns`

Body:

```json
{"text":"Hello"}
```

Behavior:

- enforce CSRF using the existing WebUI write-route policy;
- validate VN session ownership as above;
- require trimmed non-empty UTF-8 text with a conservative bounded length;
- start the run through `start_session_turn(session_id, text, source="hyrax_vn")`;
- preserve native statuses, especially 400, 404, and active-stream 409;
- return the native `stream_id`, pending timestamp, and sanitized status only;
- never invoke a second runner or append a duplicate user turn manually.

### GET `/api/hyrax/vn/conversations/{session_id}/events`

This route is an ownership-validating alias over native `/api/sessions/{session_id}/events` behavior.

Requirements:

1. Validate safe session ID, `project_id == "hyrax-vn"`, and allowlisted owner profile before sending SSE headers.
2. Establish a request-scoped thread-local profile context for exactly the session's owner and restore the caller's prior request profile in `finally`.
3. Delegate to the existing native session run-journal stream implementation; do not duplicate subscription, replay, heartbeat, cursor, snapshot, or terminal-event logic.
4. Preserve `Last-Event-ID` and native query cursor behavior.
5. Preserve native disconnect cleanup and subscriber unsubscription.
6. Never mutate process-global active profile or `HERMES_HOME`.

A narrow helper extracted from the native handler is preferable if temporary request-profile rebinding would be error-prone. The resulting implementation must still retain the native session-profile guard for ordinary `/api/sessions/{sid}/events` requests.

## Event presentation mapping

The VN client consumes native SSE events and maps only presentation-relevant data:

- assistant content deltas update one in-progress dialogue bubble;
- tool lifecycle events may set a local focused/thinking expression but do not render raw tool arguments;
- terminal `stream_end`/completion settles the assistant dialogue and reloads the native session snapshot;
- `error` shows a sanitized retryable/non-retryable message and returns controls to idle;
- `cancel` returns controls to idle without fabricating assistant text;
- `session_snapshot` or completed-during-gap notification triggers an idempotent transcript reload;
- event IDs are retained for reconnect deduplication.

Expression inference is presentation-only and deterministic. It must not alter persisted transcript or agent prompts. The initial implementation may use neutral/focused/error states; richer expression events can be added later through a separate sanitized projection.

## Frontend lifecycle

`static/hyrax/vn.js` must expose an idempotent mount/unmount contract through the native extension-panel registry.

Mount:

- accepts the selected sister/profile;
- fetches profile metadata and selected/created conversation;
- renders backlog;
- opens exactly one SSE connection for the active conversation;
- restores input/focus semantics and reports loading/error state accessibly.

Unmount:

- closes EventSource;
- aborts in-flight fetches;
- removes every listener it owns;
- clears module-local references that would retain DOM;
- prevents late async completion from mutating an unmounted panel;
- does not cancel an active Hermes run merely because the user changed panels.

Remount reconnects to the same native session and uses native replay/snapshot recovery.

## Concurrency and safety invariants

- One active run per native session is enforced only by native WebUI locks/registries.
- One active VN session per sister is enforced by a small adapter lock keyed by profile.
- A VN route never accepts an arbitrary profile as filesystem input.
- Caller profile cookie does not grant cross-profile access by itself; the fixed VN allowlist plus VN-session ownership check is the additional authorization boundary.
- Unknown/mismatched session IDs return 404.
- Writes use existing auth and CSRF enforcement.
- SSE validation happens before headers.
- No iframe, `postMessage`, remote control-plane URL, polling loop, or process-global monkey patch.

## Required tests

### Backend unit/dispatch tests

- all four allowlisted profiles and rejection of unknown/traversal-shaped IDs;
- one active VN session per profile, deterministic duplicate reconciliation, and fresh-session archival;
- no cross-profile or non-VN session access;
- GET transcript shaping and filtering;
- turn submission delegates exactly once to `start_session_turn` with `source="hyrax_vn"`;
- native 409/cancel/error status preservation;
- explicit GET/POST dispatch with no import-time mutation;
- SSE alias validates before headers, binds/restores request profile, delegates exactly once, forwards cursor state, and cleans up on disconnect;
- ordinary native session visibility remains unchanged;
- auth/CSRF rejection occurs before VN mutation;
- unknown `/api/hyrax/vn/*` route is sanitized 404.

### Frontend executable tests

- mount/unmount/remount exact listener and EventSource counts;
- stale fetch/SSE callbacks cannot mutate a later mount;
- sending appends one user line, disables duplicate send, and handles native 409;
- delta events update one assistant line rather than adding one per token;
- terminal/error/cancel states restore controls;
- replayed event IDs do not double-render;
- new-conversation confirmation archives and selects a fresh native session;
- keyboard, focus, labels, reduced-motion, and narrow viewport behavior.

### Runtime smoke

Under authenticated WebUI:

1. enter HQ, open each sister, and verify the correct profile/session;
2. send one harmless message and observe live native streaming;
3. leave and re-enter during a run; verify reconnect without duplicate text;
4. start a fresh conversation; verify old history remains archived;
5. verify ordinary chat sessions and profile switching are unaffected;
6. confirm zero network requests to the old control-plane origin.

## Delivery sequence

1. Complete and review explicit `/api/hyrax/*` dispatch.
2. Implement backend adapter and tests.
3. Review backend adapter independently.
4. Migrate VN frontend to the adapter and native panel lifecycle.
5. Integrate Tai Loft lazy mount.
6. Harden 3D lifecycle and WebGL disposal.
7. Run authenticated browser/explorer regression.
8. Preserve the control-plane fallback until Josh approves cutover.
