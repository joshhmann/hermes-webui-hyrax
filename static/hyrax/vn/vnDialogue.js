/**
 * Gestalt VN revamp (vn2) — vnDialogue.js
 *
 * Transcript region: history via window.renderTranscript, live streaming
 * bubble, tool cards, collapsed reasoning rows, "load earlier" paging,
 * auto-scroll with user-scroll-up suppression.
 *
 * Classic script, IIFE. Registers onto window.GestaltVN.dialogue.
 * Consumes GestaltVN.events (sole SSE subscriber) and GestaltVN.session.
 *
 * API:
 *   init({container, operatorName})  build + wire the region
 *   resync()                         re-fetch transcript and re-render history
 *   appendUserMessage(text)          optimistic user row (reconciled by done)
 *   dispose()
 *
 * Rendering safety: history goes through window.renderTranscript/renderMd
 * (the sanctioned pipeline); anything we render ourselves is textContent-only.
 */
(function() {
  'use strict';

  var root = typeof window !== 'undefined' ? window : globalThis;
  var ns = root.GestaltVN = root.GestaltVN || {};

  var PAGE_SIZE = 200;
  var SCROLL_SUPPRESS_PX = 40;
  var ARGS_PREVIEW_MAX = 200;

  // ── State ──
  var _container = null;
  var _scroller = null;
  var _loadEarlierBtn = null;
  var _historyEl = null;
  var _liveEl = null;
  var _operatorName = '';
  var _streamed = '';
  var _streamBody = null;     // body element of the in-flight bubble
  var _streamRow = null;
  var _reasoningText = '';
  var _reasoningRow = null;
  var _tools = {};            // correlationId|name → {row, statusEl, start}
  var _unsubs = [];
  var _userScrolledUp = false;
  var _earliestId = null;
  var _renderedIds = {};
  var _disposed = true;

  // ── Helpers ──

  function _el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = String(text);
    return e;
  }

  function _events() { return ns.events; }
  function _session() { return ns.session; }

  function _scrollDown() {
    if (_userScrolledUp || !_scroller) return;
    try { _scroller.scrollTop = _scroller.scrollHeight; } catch (_) {}
  }

  function _onScroll() {
    if (!_scroller) return;
    try {
      var gap = _scroller.scrollHeight - _scroller.scrollTop - (_scroller.clientHeight || 0);
      _userScrolledUp = gap > SCROLL_SUPPRESS_PX;
    } catch (_) { /* keep prior state */ }
  }

  // Render final markdown into an element, falling back to textContent.
  function _renderMarkdownInto(el, text) {
    var md = root.renderMd;
    if (typeof md === 'function') {
      try {
        var html = md(text);
        if (html != null) {
          el.innerHTML = html;
          if (typeof root.postProcessRenderedMessages === 'function') {
            try { root.postProcessRenderedMessages(el); } catch (_) {}
          }
          return;
        }
      } catch (_) { /* fall through to textContent */ }
    }
    el.textContent = text;
  }

  function _renderHistory(messages) {
    if (!_historyEl) return;
    _renderedIds = {};
    var list = Array.isArray(messages) ? messages : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && typeof list[i].id === 'string') _renderedIds[list[i].id] = true;
    }
    _earliestId = (list.length && list[0] && typeof list[0].id === 'string') ? list[0].id : null;
    if (typeof root.renderTranscript === 'function') {
      try {
        root.renderTranscript(_historyEl, list, { skipEmpty: true });
        _syncLoadEarlier(list.length >= PAGE_SIZE);
        return;
      } catch (_) { /* fall through to safe manual render */ }
    }
    // Fallback: textContent-only rows.
    _historyEl.replaceChildren();
    for (var j = 0; j < list.length; j++) {
      var m = list[j];
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
      var row = _el('div', 'msg-row');
      row.setAttribute('data-role', m.role);
      var body = _el('div', 'msg-body', typeof m.content === 'string' ? m.content : (m.text || ''));
      row.appendChild(body);
      _historyEl.appendChild(row);
    }
    _syncLoadEarlier(list.length >= PAGE_SIZE);
  }

  function _syncLoadEarlier(hasMore) {
    if (_loadEarlierBtn) _loadEarlierBtn.hidden = !hasMore;
  }

  // ── Streaming bubble ──

  function _ensureStreamRow() {
    if (_streamRow || !_liveEl) return;
    _streamRow = _el('div', 'msg-row vn2-bubble vn2-bubble--streaming');
    _streamRow.setAttribute('data-role', 'assistant');
    var name = _el('div', 'vn2-bubble-name', _operatorName || 'Assistant');
    _streamBody = _el('div', 'msg-body vn2-bubble-body', '…');
    _streamRow.appendChild(name);
    _streamRow.appendChild(_streamBody);
    _liveEl.appendChild(_streamRow);
    _scrollDown();
  }

  function _onToken(ev) {
    var p = ev.payload || {};
    _ensureStreamRow();
    if (ev.nativeType === 'interim_assistant') {
      // Snapshot payload, not a delta.
      _streamed = typeof p.text === 'string' ? p.text : _streamed;
    } else {
      var delta = typeof p.delta === 'string' ? p.delta
        : (typeof p.text === 'string' ? p.text : '');
      _streamed += delta;
    }
    if (_streamBody) _streamBody.textContent = _streamed;
    _scrollDown();
  }

  function _finalizeStream(finalText, failed) {
    if (!_streamRow) { _streamed = ''; return; }
    var text = typeof finalText === 'string' && finalText ? finalText : _streamed;
    if (failed) {
      _streamRow.classList.add('vn2-bubble--error');
      if (_streamBody) _streamBody.textContent = text || 'Response failed';
    } else if (_streamBody) {
      _renderMarkdownInto(_streamBody, text);
    }
    _streamRow.classList.remove('vn2-bubble--streaming');
    _streamRow = null;
    _streamBody = null;
    _streamed = '';
    _scrollDown();
  }

  // ── Tool cards ──

  function _toolKey(p) {
    if (p && typeof p.tool_call_id === 'string' && p.tool_call_id) return p.tool_call_id;
    if (p && typeof p.id === 'string' && p.id) return p.id;
    if (p && typeof p.name === 'string' && p.name) return p.name;
    return 'tool';
  }

  function _argsPreview(p) {
    var raw = (p && (p.preview !== undefined ? p.preview : p.args));
    if (raw == null) return '';
    var s = typeof raw === 'string' ? raw : (function() {
      try { return JSON.stringify(raw); } catch (_) { return ''; }
    })();
    if (s.length > ARGS_PREVIEW_MAX) s = s.slice(0, ARGS_PREVIEW_MAX) + '…';
    return s;
  }

  function _onToolStarted(ev) {
    if (!_liveEl) return;
    var p = ev.payload || {};
    var key = _toolKey(p);
    var row = _el('div', 'vn2-tool-card');
    row.setAttribute('data-tool-status', 'running');
    var head = _el('div', 'vn2-tool-head');
    head.appendChild(_el('span', 'vn2-tool-name', p.name || 'tool'));
    var statusEl = _el('span', 'vn2-tool-status', 'running');
    head.appendChild(statusEl);
    row.appendChild(head);
    var preview = _argsPreview(p);
    if (preview) row.appendChild(_el('div', 'vn2-tool-args', preview));
    _liveEl.appendChild(row);
    _tools[key] = { row: row, statusEl: statusEl, start: Date.now() };
    _scrollDown();
  }

  function _setToolStatus(entry, status, extra) {
    entry.row.setAttribute('data-tool-status', status);
    var label = status;
    if (extra) label += ' · ' + extra;
    entry.statusEl.textContent = label;
  }

  function _onToolCompleted(ev) {
    var p = ev.payload || {};
    var entry = _tools[_toolKey(p)];
    if (!entry) return;
    var dur = (typeof p.duration_ms === 'number' && isFinite(p.duration_ms))
      ? Math.round(p.duration_ms) + 'ms'
      : Math.max(0, Date.now() - entry.start) + 'ms';
    _setToolStatus(entry, 'done', dur);
    delete _tools[_toolKey(p)];
  }

  function _failOpenTools() {
    for (var key in _tools) {
      if (Object.prototype.hasOwnProperty.call(_tools, key)) {
        _setToolStatus(_tools[key], 'error');
        delete _tools[key];
      }
    }
  }

  // ── Reasoning (collapsed rows) ──

  function _onReasoning(ev) {
    if (!_liveEl) return;
    var p = ev.payload || {};
    var delta = typeof p.delta === 'string' ? p.delta
      : (typeof p.text === 'string' ? p.text : '');
    if (!delta) return;
    _reasoningText += delta;
    if (!_reasoningRow) {
      _reasoningRow = _el('div', 'vn2-reasoning');
      var toggle = _el('button', 'vn2-reasoning-toggle', 'Reasoning');
      toggle.setAttribute('type', 'button');
      toggle.setAttribute('aria-expanded', 'false');
      var bodyEl = _el('div', 'vn2-reasoning-body');
      bodyEl.hidden = true;
      toggle.addEventListener('click', function() {
        bodyEl.hidden = !bodyEl.hidden;
        toggle.setAttribute('aria-expanded', bodyEl.hidden ? 'false' : 'true');
      });
      _reasoningRow.appendChild(toggle);
      _reasoningRow.appendChild(bodyEl);
      _reasoningRow._body = bodyEl;
      _liveEl.appendChild(_reasoningRow);
    }
    _reasoningRow._body.textContent = _reasoningText;
  }

  // ── Run lifecycle ──

  function _onDone(ev) {
    var p = ev.payload || {};
    var output = typeof p.output === 'string' ? p.output : null;
    _finalizeStream(output, false);
    _failOpenTools();
    _reasoningRow = null;
    _reasoningText = '';
    // Reconcile against the authoritative session payload (ARCH §3) —
    // best-effort refresh updates busy/expression/title for the shell.
    var s = _session();
    if (s && typeof s.refresh === 'function') {
      try { s.refresh().catch(function() {}); } catch (_) {}
    }
  }

  function _onCancel() {
    _finalizeStream(null, false);
    _failOpenTools();
    if (_liveEl) {
      _liveEl.appendChild(_el('div', 'vn2-system-line', 'Cancelled'));
      _scrollDown();
    }
  }

  function _onError(ev) {
    var p = ev.payload || {};
    var msg = typeof p.error === 'string' ? p.error
      : (typeof p.message === 'string' ? p.message
        : (typeof p.label === 'string' ? p.label : 'Response failed'));
    _finalizeStream(msg, true);
    _failOpenTools();
    if (_liveEl) {
      _liveEl.appendChild(_el('div', 'vn2-system-line vn2-system-line--error', msg));
      _scrollDown();
    }
  }

  // ── Load earlier ──

  function _onLoadEarlier() {
    var s = _session();
    if (!s || typeof s.fetchTranscript !== 'function') return;
    _loadEarlierBtn.disabled = true;
    s.fetchTranscript({ limit: PAGE_SIZE, before: _earliestId || undefined }).then(function(res) {
      if (_disposed) return;
      var fresh = (res && res.messages) || [];
      var added = 0;
      for (var i = 0; i < fresh.length; i++) {
        var m = fresh[i];
        if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
        if (m.id && _renderedIds[m.id]) continue;
        var row = _el('div', 'msg-row');
        row.setAttribute('data-role', m.role);
        row.appendChild(_el('div', 'msg-body', typeof m.content === 'string' ? m.content : (m.text || '')));
        _historyEl.insertBefore(row, _historyEl.children[0] || null);
        if (m.id) _renderedIds[m.id] = true;
        added++;
      }
      if (fresh.length && fresh[0] && fresh[0].id) _earliestId = fresh[0].id;
      _syncLoadEarlier(added > 0 && !!(res && res.hasMore));
    }).catch(function() {
      _syncLoadEarlier(false);
    }).then(function() {
      if (_loadEarlierBtn) _loadEarlierBtn.disabled = false;
    });
  }

  // ── Public API ──

  function init(opts) {
    opts = opts || {};
    dispose();
    if (!opts.container) return false;
    _disposed = false;
    _container = opts.container;
    _operatorName = typeof opts.operatorName === 'string' ? opts.operatorName : '';

    _scroller = _el('div', 'vn2-scroller');
    _scroller.setAttribute('role', 'log');
    _scroller.setAttribute('aria-live', 'polite');
    _scroller.setAttribute('aria-label', 'Conversation');
    _scroller.addEventListener('scroll', _onScroll);

    _loadEarlierBtn = _el('button', 'vn2-load-earlier', 'Load earlier');
    _loadEarlierBtn.setAttribute('type', 'button');
    _loadEarlierBtn.hidden = true;
    _loadEarlierBtn.addEventListener('click', _onLoadEarlier);

    _historyEl = _el('div', 'vn2-history');
    _liveEl = _el('div', 'vn2-live');

    _scroller.appendChild(_loadEarlierBtn);
    _scroller.appendChild(_historyEl);
    _scroller.appendChild(_liveEl);
    _container.appendChild(_scroller);

    var s = _session();
    var cur = s && typeof s.current === 'function' ? s.current() : null;
    _renderHistory(cur ? cur.messages : []);

    var ev = _events();
    if (ev) {
      _unsubs.push(ev.subscribe('response.token', _onToken));
      _unsubs.push(ev.subscribe('tool.started', _onToolStarted));
      _unsubs.push(ev.subscribe('tool.completed', _onToolCompleted));
      _unsubs.push(ev.subscribe('reasoning.delta', _onReasoning));
      _unsubs.push(ev.subscribe('response.completed', _onDone));
      _unsubs.push(ev.subscribe('interruption', _onCancel));
      _unsubs.push(ev.subscribe('response.failed', _onError));
      // Approval/clarify rendering is delegated to vnApprovals; nudge its
      // reconciliation poll so cards surface without waiting a full tick.
      _unsubs.push(ev.subscribe('approval.requested', _nudgeApprovals));
      _unsubs.push(ev.subscribe('clarify.requested', _nudgeApprovals));
    }
    return true;
  }

  function _nudgeApprovals() {
    var a = ns.approvals;
    if (a && typeof a.refresh === 'function') {
      try { a.refresh(); } catch (_) {}
    }
  }

  function resync() {
    var s = _session();
    if (!s || typeof s.fetchTranscript !== 'function') return;
    s.fetchTranscript({ limit: PAGE_SIZE }).then(function(res) {
      if (_disposed) return;
      _renderHistory(res ? res.messages : []);
      _scrollDown();
    }).catch(function() { /* stale transcript stays; fail visibly silent */ });
  }

  function appendUserMessage(text) {
    if (!_liveEl) return;
    var row = _el('div', 'msg-row');
    row.setAttribute('data-role', 'user');
    row.appendChild(_el('div', 'msg-body', String(text == null ? '' : text)));
    _liveEl.appendChild(row);
    _userScrolledUp = false;
    _scrollDown();
  }

  function dispose() {
    for (var i = 0; i < _unsubs.length; i++) {
      try { _unsubs[i](); } catch (_) {}
    }
    _unsubs = [];
    if (_scroller) {
      try { _scroller.remove(); } catch (_) {}
    }
    _container = null;
    _scroller = null;
    _loadEarlierBtn = null;
    _historyEl = null;
    _liveEl = null;
    _streamed = '';
    _streamBody = null;
    _streamRow = null;
    _reasoningText = '';
    _reasoningRow = null;
    _tools = {};
    _renderedIds = {};
    _earliestId = null;
    _userScrolledUp = false;
    _disposed = true;
  }

  ns.dialogue = {
    init: init,
    resync: resync,
    appendUserMessage: appendUserMessage,
    dispose: dispose,
  };
})();
