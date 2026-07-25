/**
 * Gestalt VN revamp (vn2) — vnSession.js
 *
 * Session/profile continuity (ARCH §4). One active Hermes session per VN
 * instance; the native session is the source of truth.
 *
 * Classic script, IIFE. Registers onto window.GestaltVN.session.
 *
 * API:
 *   open({operatorId, source}) → Promise<SessionRef|null>
 *     Selection precedence:
 *       1. explicit ?session=<sid> deep link (location.search or hash) —
 *          validated with GET conversations/{sid} (fail closed to step 2)
 *       2. POST /api/hyrax/vn/conversations {profile_id, fresh:false,
 *          current_session_id from pathname /session/<sid> when present}
 *   current()          → SessionRef | null
 *   busy()             → boolean (from active_stream_id, ARCH §4)
 *   fresh()            → Promise<SessionRef|null> new VN session (confirm upstream)
 *   openInStandardChat() → loadSession(sid) — native, same session (SPEC §3)
 *   fetchTranscript({limit, before}) → Promise<{messages, hasMore}>
 *   refresh()          → re-fetch conversation, update SessionRef, emit change
 *   on(fn) / off(fn)   → change listeners (fn(SessionRef))
 *
 * SessionRef: {sessionId, operatorId, projectId:'hyrax-vn', activeStreamId,
 *              busy, title, expression, messages, archived}
 */
(function() {
  'use strict';

  var root = typeof window !== 'undefined' ? window : globalThis;
  var ns = root.GestaltVN = root.GestaltVN || {};

  var _current = null;
  var _listeners = [];
  var _eventsUnsub = null;

  var SAFE_ID = /^[A-Za-z0-9_-]+$/;

  function _api(url, opts) {
    if (typeof root.api === 'function') return root.api(url, opts);
    return fetch(url, opts).then(function(r) { return r.json(); });
  }

  function _location() {
    try { return root.location || {}; } catch (_) { return {}; }
  }

  // explicit ?session=<sid> deep link — search first, then hash (legacy
  // scraped only the hash, audit §3; we accept both, fail closed on junk).
  function _deepLinkSid() {
    var loc = _location();
    var sources = [];
    if (typeof loc.search === 'string') sources.push(loc.search);
    if (typeof loc.hash === 'string') sources.push(loc.hash);
    for (var i = 0; i < sources.length; i++) {
      var m = sources[i].match(/[?&]session=([A-Za-z0-9_-]+)/);
      if (m && SAFE_ID.test(m[1])) return m[1];
    }
    return null;
  }

  // Context seed: main chat keeps the sid in the pathname /session/<sid>
  // (audit §3 — the hash scrape was dead).
  function _pathnameSid() {
    var loc = _location();
    var path = typeof loc.pathname === 'string' ? loc.pathname : '';
    var m = path.match(/\/session\/([A-Za-z0-9_-]+)/);
    return (m && SAFE_ID.test(m[1])) ? m[1] : null;
  }

  function _toRef(conv, operatorId) {
    if (!conv || typeof conv !== 'object') return null;
    var sid = typeof conv.session_id === 'string' ? conv.session_id
      : (typeof conv.id === 'string' ? conv.id : '');
    if (!sid) return null;
    var activeStreamId = typeof conv.active_stream_id === 'string'
      ? conv.active_stream_id : null;
    return {
      sessionId: sid,
      operatorId: operatorId,
      projectId: 'hyrax-vn',
      activeStreamId: activeStreamId,
      busy: !!activeStreamId,
      title: typeof conv.title === 'string' ? conv.title : '',
      expression: (conv.expression && typeof conv.expression === 'object')
        ? conv.expression : null,
      messages: Array.isArray(conv.messages) ? conv.messages
        : (Array.isArray(conv.turns) ? conv.turns : []),
      archived: !!conv.archived,
    };
  }

  function _emit(ref) {
    var snapshot = _listeners.slice();
    for (var i = 0; i < snapshot.length; i++) {
      try { snapshot[i](ref); } catch (_) { /* listener errors isolated */ }
    }
  }

  function _setCurrent(ref) {
    _current = ref;
    _hookEvents();
    _emit(ref);
    return ref;
  }

  // Keep `_current.busy` truthful across the run lifecycle. The conversation
  // payload's active_stream_id is only a snapshot at open() time — without
  // this hook the composer stays busy forever after a settled run (found in
  // dogfood: response.failed arrived but the Cancel button never cleared).
  function _hookEvents() {
    if (_eventsUnsub) {
      try { _eventsUnsub(); } catch (_) {}
      _eventsUnsub = null;
    }
    var ev = ns.events;
    if (!ev || typeof ev.subscribe !== 'function') return;
    var unsubs = [];
    var settle = function() {
      if (!_current || !_current.busy) return;
      _current.busy = false;
      _current.activeStreamId = null;
      _emit(_current);
    };
    var start = function(e) {
      if (!_current) return;
      _current.busy = true;
      var sid = e && e.payload && typeof e.payload.stream_id === 'string'
        ? e.payload.stream_id : null;
      if (sid) _current.activeStreamId = sid;
      _emit(_current);
    };
    ['response.completed', 'response.failed', 'interruption', 'stream.end'].forEach(function(k) {
      unsubs.push(ev.subscribe(k, settle));
    });
    ['response.token', 'tool.started'].forEach(function(k) {
      unsubs.push(ev.subscribe(k, start));
    });
    _eventsUnsub = function() {
      for (var i = 0; i < unsubs.length; i++) {
        try { unsubs[i](); } catch (_) {}
      }
    };
  }

  async function open(opts) {
    opts = opts || {};
    var operatorId = typeof opts.operatorId === 'string' ? opts.operatorId : '';
    if (!operatorId) return null; // fail closed

    // 1. explicit deep link — validate the session exists and is a visible
    //    VN session before adopting it; any failure falls through to the
    //    select-or-create path.
    var deep = _deepLinkSid();
    if (deep) {
      try {
        var got = await _api('/api/hyrax/vn/conversations/' + encodeURIComponent(deep), { method: 'GET' });
        var deepConv = (got && got.conversation) || got;
        var deepRef = _toRef(deepConv, operatorId);
        if (deepRef) return _setCurrent(deepRef);
      } catch (_) { /* fall through to select-or-create */ }
    }

    // 2. select-or-create the sister's existing VN session; seed context
    //    from the main-chat session in the pathname when present.
    var body = { profile_id: operatorId, fresh: false };
    var seed = _pathnameSid();
    if (seed) body.current_session_id = seed;
    var resp = await _api('/api/hyrax/vn/conversations', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    var conv = (resp && resp.conversation) || resp;
    return _setCurrent(_toRef(conv, operatorId));
  }

  function current() {
    return _current;
  }

  function busy() {
    return !!(_current && _current.busy);
  }

  async function fresh() {
    if (!_current) return null;
    if (typeof root.confirm === 'function') {
      var ok = false;
      try { ok = !!root.confirm('Start a fresh conversation? The current session will be archived.'); }
      catch (_) { ok = false; }
      if (!ok) return null; // fail closed: no confirm, no archive
    }
    var resp = await _api('/api/hyrax/vn/conversations', {
      method: 'POST',
      body: JSON.stringify({ profile_id: _current.operatorId, fresh: true }),
    });
    var conv = (resp && resp.conversation) || resp;
    return _setCurrent(_toRef(conv, _current.operatorId));
  }

  function openInStandardChat() {
    if (!_current) return false;
    if (typeof root.loadSession !== 'function') return false;
    try {
      root.loadSession(_current.sessionId);
      return true;
    } catch (_) {
      return false;
    }
  }

  // Bounded transcript paging (ARCH §4: 200-row pages with "load earlier").
  // The server currently caps the transcript and ignores limit/before; we
  // pass them through for the paging-enabled endpoint and slice client-side
  // as a stopgap.
  async function fetchTranscript(opts) {
    opts = opts || {};
    if (!_current) return { messages: [], hasMore: false };
    var qs = [];
    if (typeof opts.limit === 'number' && opts.limit > 0) qs.push('limit=' + Math.floor(opts.limit));
    if (typeof opts.before === 'string' && opts.before) qs.push('before=' + encodeURIComponent(opts.before));
    var url = '/api/hyrax/vn/conversations/' + encodeURIComponent(_current.sessionId);
    if (qs.length) url += '?' + qs.join('&');
    var resp = await _api(url, { method: 'GET' });
    var conv = (resp && resp.conversation) || resp;
    var messages = (conv && Array.isArray(conv.messages)) ? conv.messages.slice() : [];

    var hasMore = false;
    if (typeof opts.before === 'string' && opts.before) {
      var cut = -1;
      for (var i = 0; i < messages.length; i++) {
        if (messages[i] && messages[i].id === opts.before) { cut = i; break; }
      }
      if (cut > 0) { messages = messages.slice(0, cut); hasMore = true; }
      else if (cut === 0) { messages = []; }
    }
    if (typeof opts.limit === 'number' && opts.limit > 0 && messages.length > opts.limit) {
      messages = messages.slice(messages.length - opts.limit);
      hasMore = true;
    }
    return { messages: messages, hasMore: hasMore };
  }

  async function refresh() {
    if (!_current) return null;
    var resp = await _api('/api/hyrax/vn/conversations/' + encodeURIComponent(_current.sessionId), { method: 'GET' });
    var conv = (resp && resp.conversation) || resp;
    var ref = _toRef(conv, _current.operatorId);
    if (!ref) return _current;
    return _setCurrent(ref);
  }

  function on(fn) {
    if (typeof fn !== 'function') return function() {};
    _listeners.push(fn);
    return function() { off(fn); };
  }

  function off(fn) {
    var idx = _listeners.indexOf(fn);
    if (idx !== -1) _listeners.splice(idx, 1);
  }

  ns.session = {
    open: open,
    current: current,
    busy: busy,
    fresh: fresh,
    openInStandardChat: openInStandardChat,
    fetchTranscript: fetchTranscript,
    refresh: refresh,
    on: on,
    off: off,
  };
})();
