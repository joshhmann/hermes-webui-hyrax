/**
 * Gestalt VN revamp (vn2) — vnEvents.js
 *
 * The ONLY SSE subscriber for the VN surface. Every other module consumes
 * the normalized VNRuntimeEvent stream from here (ARCH §3).
 *
 * Classic script, IIFE. Registers onto window.GestaltVN.events.
 *
 * Stream: GET /api/hyrax/vn/conversations/{sid}/events (alias of the native
 * session SSE). Subscribes to the full native vocabulary and normalizes each
 * frame to:
 *   VNRuntimeEvent {
 *     id, timestamp, operatorId, sessionId, kind, source:'hermes',
 *     payload, sequence, nativeType
 *   }
 * (nativeType is an extra tolerated field so consumers can distinguish
 * delta vs snapshot payloads that share a kind.)
 *
 * API:
 *   init({sessionId, operatorId})  open the stream (disposes any prior one)
 *   subscribe(kindOrWildcard, fn)  → unsubscribe fn. '*' matches everything,
 *                                  'tool.*' prefix matches, else exact kind.
 *   replay(fn)                     deliver buffered events in order
 *   getSequence()                  last seen sequence number
 *   dispose()                      close ES, clear subscribers/buffer/dedupe
 *
 * Reconnect: native EventSource retry; on a subsequent `open` a synthetic
 * {kind:'reconnect', source:'gestalt'} event is fanned out so consumers can
 * re-sync (ARCH §7). Dedupe by server event id (lastEventId / payload.id).
 */
(function() {
  'use strict';

  var root = typeof window !== 'undefined' ? window : globalThis;
  var ns = root.GestaltVN = root.GestaltVN || {};

  // ── Native SSE type → VNRuntimeEventKind (API_CONTRACTS §3) ──
  var KIND_MAP = {
    token: 'response.token',
    interim_assistant: 'response.token',
    reasoning: 'reasoning.delta',
    tool: 'tool.started',
    tool_complete: 'tool.completed',
    todo_state: 'task.changed',
    approval: 'approval.requested',
    clarify: 'clarify.requested',
    state_saved: 'session.changed',
    title: 'session.changed',
    title_status: 'session.changed',
    context_status: 'context.status',
    goal: 'activity.changed',
    goal_continue: 'activity.changed',
    bg_task_complete: 'activity.changed',
    compressing: 'context.status',
    compressed: 'context.status',
    metering: 'metering.update',
    pending_steer_leftover: 'interruption',
    warning: 'warning',
    done: 'response.completed',
    cancel: 'interruption',
    apperror: 'response.failed',
    stream_end: 'stream.end',
  };

  var NATIVE_TYPES = [
    'token', 'interim_assistant', 'reasoning', 'tool', 'tool_complete',
    'todo_state', 'approval', 'clarify', 'state_saved', 'title',
    'title_status', 'context_status', 'goal', 'goal_continue',
    'bg_task_complete', 'compressing', 'compressed', 'metering',
    'pending_steer_leftover', 'warning', 'done', 'cancel', 'apperror',
    'stream_end',
  ];

  var BUFFER_MAX = 500;
  var SEEN_MAX = 1000;

  // ── State ──
  var _es = null;
  var _sessionId = null;
  var _operatorId = null;
  var _subs = [];        // [{matcher, fn}]
  var _buffer = [];      // ordered ring buffer
  var _seen = [];        // dedupe id ring (oldest first)
  var _seenSet = {};
  var _seq = 0;          // last sequence (server or internal)
  var _synthCounter = 0; // synthetic id counter
  var _everOpened = false;
  var _disposed = true;

  function _isoNow() {
    try { return new Date().toISOString(); } catch (_) { return ''; }
  }

  function _toIso(value) {
    if (typeof value === 'number' && isFinite(value)) {
      // Epoch seconds or ms.
      try { return new Date(value < 1e12 ? value * 1000 : value).toISOString(); }
      catch (_) { return _isoNow(); }
    }
    if (typeof value === 'string' && value) {
      var t = Date.parse(value);
      if (!isNaN(t)) {
        try { return new Date(t).toISOString(); } catch (_) { /* fall through */ }
      }
      return value;
    }
    return _isoNow();
  }

  function _nextSyntheticId() {
    _synthCounter += 1;
    return 'vn-' + _synthCounter;
  }

  function _seenBefore(id) {
    return Object.prototype.hasOwnProperty.call(_seenSet, id);
  }

  function _markSeen(id) {
    _seenSet[id] = true;
    _seen.push(id);
    while (_seen.length > SEEN_MAX) {
      var old = _seen.shift();
      delete _seenSet[old];
    }
  }

  function _normalize(nativeType, data, lastEventId) {
    var payload = (data && typeof data === 'object') ? data : {};
    var kind = KIND_MAP[nativeType] || String(nativeType || 'unknown');

    var id = null;
    if (typeof lastEventId === 'string' && lastEventId) id = lastEventId;
    if (!id && typeof payload.id === 'string' && payload.id) id = payload.id;
    var isServerId = !!id;
    if (!id) id = _nextSyntheticId();

    var seq = null;
    if (typeof payload.sequence === 'number' && isFinite(payload.sequence)) seq = payload.sequence;
    else if (typeof payload.seq === 'number' && isFinite(payload.seq)) seq = payload.seq;
    else { _seq += 1; seq = _seq; }
    if (seq > _seq) _seq = seq;

    return {
      id: id,
      timestamp: _toIso(payload.timestamp || payload.ts || payload.created_at),
      operatorId: _operatorId || null,
      sessionId: _sessionId || null,
      kind: kind,
      source: 'hermes',
      payload: payload,
      sequence: seq,
      nativeType: nativeType || null,
      _serverId: isServerId,
    };
  }

  // Untyped frames (onmessage): guess the native type from payload shape,
  // mirroring the legacy vn.js normalization (token/done/apperror/tool/cancel).
  function _guessNativeType(data) {
    if (!data || typeof data !== 'object') return 'unknown';
    if (typeof data.type === 'string' && KIND_MAP[data.type]) return data.type;
    if (data.text !== undefined) return 'token';
    if (data.session !== undefined) return 'done';
    if (data.label !== undefined) return 'apperror';
    if (data.name !== undefined) return 'tool';
    if (data.message !== undefined) return 'cancel';
    return 'unknown';
  }

  function _matches(matcher, kind) {
    if (matcher === '*') return true;
    if (matcher.slice(-2) === '.*') {
      return kind.slice(0, matcher.length - 1) === matcher.slice(0, -1);
    }
    return matcher === kind;
  }

  function _fanout(ev) {
    for (var i = 0; i < _subs.length; i++) {
      var sub = _subs[i];
      if (!_matches(sub.matcher, ev.kind)) continue;
      try { sub.fn(ev); } catch (_) { /* subscriber errors never break the stream */ }
    }
  }

  function _push(ev) {
    // Dedupe only when the server gave us a stable id — synthetic ids are
    // unique by construction, so dedupe on them would be a no-op anyway.
    if (ev._serverId) {
      if (_seenBefore(ev.id)) return false;
      _markSeen(ev.id);
    }
    _buffer.push(ev);
    while (_buffer.length > BUFFER_MAX) _buffer.shift();
    _fanout(ev);
    return true;
  }

  function _emitSynthetic(kind, payload) {
    var ev = {
      id: _nextSyntheticId(),
      timestamp: _isoNow(),
      operatorId: _operatorId || null,
      sessionId: _sessionId || null,
      kind: kind,
      source: 'gestalt',
      payload: payload || {},
      sequence: null,
      nativeType: null,
      _serverId: false,
    };
    // Synthetics are fanned out but not buffered — replay is for the
    // authoritative hermes stream only.
    _fanout(ev);
  }

  function _onFrame(nativeType, messageEvent) {
    if (_disposed) return;
    var data = null;
    try { data = JSON.parse(messageEvent && messageEvent.data); }
    catch (_) { return; } // fail closed: unparseable frames are dropped
    var type = nativeType || _guessNativeType(data);
    var lastEventId = messageEvent && typeof messageEvent.lastEventId === 'string'
      ? messageEvent.lastEventId : '';
    _push(_normalize(type, data, lastEventId));
  }

  function _onOpen() {
    if (_disposed) return;
    if (_everOpened) {
      // Native retry succeeded — tell consumers to re-sync (transcript
      // refetch) before live events resume (ARCH §7, SSE drop row).
      _emitSynthetic('reconnect', { sessionId: _sessionId });
    }
    _everOpened = true;
  }

  // ── Public API ──

  // Transport reset for (re-)init: close the stream and reset stream state,
  // but PRESERVE subscribers. Modules subscribe before events.init() runs
  // (shell wires consumers first, the SSE source last) — a full dispose()
  // here silently wiped every early subscription (found in dogfood: the
  // composer's response.failed handler never fired, Cancel stuck visible).
  function _resetTransport() {
    if (_es) {
      try { _es.close(); } catch (_) {}
      _es = null;
    }
    _buffer = [];
    _seen = [];
    _seenSet = {};
    _seq = 0;
    _sessionId = null;
    _operatorId = null;
    _everOpened = false;
  }

  function init(opts) {
    opts = opts || {};
    _resetTransport();
    _disposed = false;
    var sid = typeof opts.sessionId === 'string' ? opts.sessionId : '';
    if (!sid) return false; // fail closed: no session, no stream
    var ES = root.EventSource;
    if (typeof ES !== 'function') return false; // no SSE support — fail closed

    _disposed = false;
    _sessionId = sid;
    _operatorId = typeof opts.operatorId === 'string' ? opts.operatorId : null;

    var url = '/api/hyrax/vn/conversations/' + encodeURIComponent(sid) + '/events';
    _es = new ES(url);

    for (var i = 0; i < NATIVE_TYPES.length; i++) {
      (function(type) {
        _es.addEventListener(type, function(ev) { _onFrame(type, ev); });
      })(NATIVE_TYPES[i]);
    }
    _es.addEventListener('open', _onOpen);
    // Untyped frames (real EventSource supports the onmessage property).
    _es.onmessage = function(ev) { _onFrame(null, ev); };
    return true;
  }

  function subscribe(kindOrWildcard, fn) {
    if (typeof fn !== 'function') return function() {};
    var matcher = typeof kindOrWildcard === 'string' && kindOrWildcard ? kindOrWildcard : '*';
    var sub = { matcher: matcher, fn: fn };
    _subs.push(sub);
    return function unsubscribe() {
      var idx = _subs.indexOf(sub);
      if (idx !== -1) _subs.splice(idx, 1);
    };
  }

  function replay(fn) {
    if (typeof fn !== 'function') return;
    var snapshot = _buffer.slice();
    for (var i = 0; i < snapshot.length; i++) {
      try { fn(snapshot[i]); } catch (_) { /* keep replaying */ }
    }
  }

  function getSequence() {
    return _seq;
  }

  function dispose() {
    _resetTransport();
    _subs = [];
    _disposed = true;
  }

  ns.events = {
    init: init,
    subscribe: subscribe,
    replay: replay,
    getSequence: getSequence,
    dispose: dispose,
    KIND_MAP: KIND_MAP,
  };
})();
