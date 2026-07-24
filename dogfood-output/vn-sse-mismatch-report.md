# VN Conversation SSE Event Type Mismatch — Rei QA Report

**Task:** t_3be9d27e
**Date:** 2026-07-23
**Method:** Source code audit + live browser test against deployed Hyrax (192.168.0.187:8787)

---

## A. System Health Summary

| Area | Status | Detail |
|------|--------|--------|
| VN /turns POST | 🟢 Working | 200 OK (96ms) — turn accepted |
| VN /events SSE | 🟢 Connected | 200 OK, `text/event-stream`, **140,435 bytes transferred** |
| VN route alias | 🟢 OK | `_handle_session_sse_stream_for_session` → `_handle_session_run_journal_stream_for_session` (routes.py:17734 alias verified) |
| VN → native delegation | 🟢 OK | hyrax_routes.py:1075 imports alias from routes.py |
| **SSE event delivery** | **🔴 BROKEN** | **Client registers 0 matching EventSource listeners** |
| **Expression events** | **🔴 ABSENT** | Server never emits `expression` event type |
| **Backlog rendering** | **🔴 SILENT** | 140KB transferred, zero bytes rendered in VN backlog |

---

## B. The Mismatch

### Server-side SSE event type names

The server emits events with these named `event:` lines via `_sse(handler, event, data)`:

| Server event | SSE `event:` line | Data payload shape | Source |
|---|---|---|---|
| Text delta | `token` | `{"text": "..."}` | streaming.py:8023, gateway_chat.py:671,1131 |
| Tool started | `tool` | `{"event_type":"tool.started","name":"...","preview":"...","args":{...}}` | streaming.py:8218 |
| Tool completed | `tool_complete` | `{"event_type":"tool.completed","name":"...","is_error":bool}` | streaming.py:8275 |
| Run completed | `done` | `{"session":{...},"usage":{...}}` | streaming.py:10551, gateway_chat.py:1321 |
| Cancelled | `cancel` | `{"message":"..."}` | streaming.py:7617, gateway_chat.py:569,1038,1164 |
| Error | `apperror` | `{"label":"...","type":"...","message":"...","hint":"..."}` | streaming.py:9702, gateway_chat.py:1334 |
| Reasoning | `reasoning` | `{"text":"..."}` | streaming.py:7922,8067,8181; gateway_chat.py:1115,1125 |
| Stream end | `stream_end` | `{"session_id":"..."}` | streaming.py:10580, gateway_chat.py:1322 |

### Client-side expected EventSource listeners

From `vn.js` line 422:
```javascript
var eventTypes = ['message.delta', 'run.completed', 'run.failed', 'run.cancelled', 'tool.started', 'expression'];
```

Plus `_handleRunEvent` handles `run.started` at line 456.

**Zero overlap.** No server-side event type name matches any client-side listener.

---

## C. Root Cause Analysis

The browser `EventSource` API dispatches named events **only** to typed listeners registered via `.addEventListener('name', callback)`. The generic `.onmessage` handler fires **only** for unnamed events (no `event:` line, or `event: message`). Since every SSE frame from the server carries a named event type, and no typed listener has a matching name, **every event is silently discarded by the EventSource API**.

Additionally, even if events reached `_handleRunEvent`, the data payload shapes don't match:

| Expected (client) | Received (server) | Problem |
|---|---|---|
| `event.event_type === 'message.delta'`, `event.payload.delta` | `{"text": "..."}` | No `event_type` or `payload` fields |
| `event.event_type === 'run.completed'`, `event.payload.output` | `{"session":{...}, "usage":{...}}` | No `event_type`/`payload.output` |
| `event.event_type === 'run.cancelled'`, `event.payload.message` | `{"message": "..."}` | `event_type` missing, but `message` field usable |
| `event.event_type === 'tool.started'` | `{"event_type":"tool.started","name":...}` | `event_type` IS present — this one would work if the SSE event type matched |
| `event.event_type === 'expression'` | **Never emitted** | Entire feature absent |

The `expression` event type does not appear in any Python file — it is not emitted by any server-side code path.

---

## D. Live Browser Evidence

Test performed against deployed Hyrax at http://192.168.0.187:8787 (session 4943a7e606c1, sister: Mai):

1. **POST /api/hyrax/vn/conversations/4943a7e606c1/turns** → `200 OK` (96ms) ✅
2. **GET /api/hyrax/vn/conversations/4943a7e606c1/events** → `200 OK`, `Content-Type: text/event-stream`, 140,435 bytes transferred over 41+ seconds ✅
3. **Backlog DOM after 40s**: only contains `<div class="line"><strong>Josh</strong><p>Hey Mai, how are you?</p></div>` — no Mai response rendered ❌
4. **Portrait** stayed on `mai.portrait.neutral` — never switched to `mai.portrait.observant` (the `tool.started` handler sets this) ❌
5. **Empty state placeholder** (`<div class="vn-empty">...`) still present ❌
6. **Send button** re-enabled (POST returned) but no streaming response arrived ❌
7. **Zero console errors** — events are silently consumed by EventSource with no matching listeners ❌

---

## E. Minimal Fix

### File: `static/hyrax/vn.js`

Two changes required:

**1. `_connectEvents` function** — register EventSource listeners for server-side event type names (replace lines 422-432):

```javascript
// Typed handlers — match server-side SSE event type names
var serverEvents = ['token', 'tool', 'tool_complete', 'done', 'cancel', 'apperror', 'reasoning', 'stream_end'];
for (var i = 0; i < serverEvents.length; i++) {
  (function(type) {
    es.addEventListener(type, function(event) {
      if (_raceToken !== token) { es.close(); return; }
      try {
        _handleRunEvent(JSON.parse(event.data), profileId, token);
      } catch (_) {}
    });
  })(serverEvents[i]);
}
```

**2. `_handleRunEvent` function** — add payload-shape normalization at the top (before the existing `if` chain, around line 443):

```javascript
// Normalize server-side event shapes to client-side event_type+payload contract
if (event.event_type === undefined) {
  if (event.text !== undefined) {
    event = { event_type: 'message.delta', payload: { delta: event.text }};
  } else if (event.session !== undefined) {
    var finalOut = _streamed || '';
    event = { event_type: 'run.completed', payload: { output: finalOut }};
  } else if (event.message !== undefined && event.event_type === undefined) {
    event = { event_type: 'run.cancelled', payload: { message: event.message }};
  } else if (event.label !== undefined) {
    event = { event_type: 'run.failed', payload: { error: event.message || event.label }};
  }
}
```

**3. `expression` event** — server never emits it. Either:
- (a) Add server-side emission in the agent streaming loop when mood/expression data is available (requires Essence integration)
- (b) Client-side: on `done` event, derive expression from session metadata or default to `neutral` (trivial, don't block on this)

---

## F. Recommendations

1. **Apply Option E.1 + E.2** as the minimal fix — restores VN conversation to working state. Single file, zero server changes.
2. **Add `expression` as a follow-up enhancement** (server-side emission or `done` event derivation) — not blocking.
3. **No rollback risk** — vn.js is only loaded on the VN page, and this file only affects VN SSE processing.

**Rollback:** `git checkout -- static/hyrax/vn.js` to revert.

— Rei
