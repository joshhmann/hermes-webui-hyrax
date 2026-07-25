/**
 * Gestalt VN revamp (vn2) — vnApprovals.js
 *
 * Approval + clarify cards. Unmistakable, screen-reader loud (role=alert),
 * never narrative flavor (SPEC §4/§5).
 *
 * Reconciliation pattern (ARCH §7): deliberate 1.5s polling of
 * /api/approval/pending and /api/clarify/pending while mounted (browser
 * 6-connection pool — no extra SSE), PLUS immediate nudges from vnEvents
 * approval/clarify frames. The card never depends on SSE alone.
 *
 * Classic script, IIFE. Registers onto window.GestaltVN.approvals.
 *
 * API:
 *   init({container, sessionId})  start polling + render cards as needed
 *   refresh()                     one immediate reconciliation tick
 *   dispose()                     stop polling, remove cards
 */
(function() {
  'use strict';

  var root = typeof window !== 'undefined' ? window : globalThis;
  var ns = root.GestaltVN = root.GestaltVN || {};

  var POLL_MS = 1500;

  // ── State ──
  var _container = null;
  var _sessionId = null;
  var _timer = null;
  var _inFlight = false;
  var _approvalCard = null;
  var _approvalId = null;
  var _clarifyCard = null;
  var _clarifyId = null;
  var _unsubs = [];
  var _disposed = true;

  function _el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = String(text);
    return e;
  }

  function _api(url, opts) {
    if (typeof root.api === 'function') return root.api(url, opts);
    return fetch(url, opts).then(function(r) { return r.json(); });
  }

  function _toast(msg) {
    if (typeof root.showToast === 'function') {
      try { root.showToast(msg); } catch (_) {}
    }
  }

  // ── Approval card ──

  function _removeApprovalCard() {
    if (_approvalCard) {
      try { _approvalCard.remove(); } catch (_) {}
      _approvalCard = null;
      _approvalId = null;
    }
  }

  function _renderApproval(pending) {
    if (!_container) return;
    _removeApprovalCard();
    _approvalId = (pending && typeof pending.approval_id === 'string') ? pending.approval_id : null;

    var card = _el('div', 'vn2-approval-card');
    card.setAttribute('role', 'alert');
    card.setAttribute('aria-live', 'assertive');

    card.appendChild(_el('div', 'vn2-approval-title', 'Approval required'));

    var desc = (pending && (pending.description || pending.action)) || 'The agent requests approval.';
    card.appendChild(_el('div', 'vn2-approval-desc', String(desc)));

    var cmd = pending && pending.command;
    if (cmd) card.appendChild(_el('pre', 'vn2-approval-cmd', String(cmd)));

    var keys = pending && (pending.pattern_keys || (pending.pattern_key ? [pending.pattern_key] : []));
    var risk = (pending && pending.risk) || (keys && keys.length ? keys.join(', ') : '');
    if (risk) card.appendChild(_el('div', 'vn2-approval-risk', 'Risk: ' + String(risk)));

    var tool = pending && pending.tool;
    if (tool) card.appendChild(_el('div', 'vn2-approval-tool', 'Tool: ' + String(tool)));

    var btns = _el('div', 'vn2-approval-buttons');
    var choices = [
      ['once', 'Allow once'],
      ['session', 'Allow for session'],
      ['always', 'Always allow'],
      ['deny', 'Deny'],
    ];
    for (var i = 0; i < choices.length; i++) {
      (function(choice, label) {
        var b = _el('button', 'vn2-btn vn2-approval-btn vn2-approval-btn--' + choice, label);
        b.setAttribute('type', 'button');
        b.addEventListener('click', function() { _respondApproval(card, choice); });
        btns.appendChild(b);
      })(choices[i][0], choices[i][1]);
    }
    card.appendChild(btns);

    _container.appendChild(card);
    _approvalCard = card;
  }

  function _respondApproval(card, choice) {
    var buttons = card.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = true;
    _api('/api/approval/respond', {
      method: 'POST',
      body: JSON.stringify({
        session_id: _sessionId,
        choice: choice,
        approval_id: _approvalId,
      }),
    }).then(function(result) {
      if (_disposed) return;
      if (result && result.ok) {
        _removeApprovalCard();
      } else {
        var msg = (result && result.error) || 'Approval response not accepted.';
        _toast(String(msg));
        for (var j = 0; j < buttons.length; j++) buttons[j].disabled = false;
      }
    }).catch(function(err) {
      if (_disposed) return;
      _toast('Approval failed' + ((err && err.message) ? ': ' + err.message : ''));
      for (var j = 0; j < buttons.length; j++) buttons[j].disabled = false;
    });
  }

  // ── Clarify card ──

  function _removeClarifyCard() {
    if (_clarifyCard) {
      try { _clarifyCard.remove(); } catch (_) {}
      _clarifyCard = null;
      _clarifyId = null;
    }
  }

  function _renderClarify(pending) {
    if (!_container) return;
    _removeClarifyCard();
    _clarifyId = (pending && typeof pending.clarify_id === 'string') ? pending.clarify_id : null;

    var card = _el('div', 'vn2-clarify-card');
    card.setAttribute('role', 'alert');
    card.setAttribute('aria-live', 'assertive');

    card.appendChild(_el('div', 'vn2-clarify-title', 'Question from the agent'));
    var question = (pending && (pending.question || pending.description)) || '';
    card.appendChild(_el('div', 'vn2-clarify-question', String(question)));

    var choices = pending && (Array.isArray(pending.choices_offered)
      ? pending.choices_offered
      : (Array.isArray(pending.choices) ? pending.choices : []));

    var btns = _el('div', 'vn2-clarify-buttons');
    for (var i = 0; i < choices.length; i++) {
      (function(choice) {
        var b = _el('button', 'vn2-btn vn2-clarify-btn', String(choice));
        b.setAttribute('type', 'button');
        b.addEventListener('click', function() { _respondClarify(card, String(choice)); });
        btns.appendChild(b);
      })(choices[i]);
    }
    card.appendChild(btns);

    // Free-form answer ("Other") — always available.
    var input = _el('input', 'vn2-clarify-input');
    input.setAttribute('type', 'text');
    input.setAttribute('placeholder', 'Or type an answer…');
    input.setAttribute('aria-label', 'Clarification answer');
    var submit = _el('button', 'vn2-btn vn2-clarify-submit', 'Answer');
    submit.setAttribute('type', 'button');
    submit.addEventListener('click', function() {
      var v = (input.value || '').trim();
      if (v) _respondClarify(card, v);
    });
    input.addEventListener('keydown', function(event) {
      if (event && event.key === 'Enter') {
        if (event.preventDefault) event.preventDefault();
        var v = (input.value || '').trim();
        if (v) _respondClarify(card, v);
      }
    });
    card.appendChild(input);
    card.appendChild(submit);

    _container.appendChild(card);
    _clarifyCard = card;
  }

  function _respondClarify(card, response) {
    var buttons = card.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = true;
    _api('/api/clarify/respond', {
      method: 'POST',
      body: JSON.stringify({
        session_id: _sessionId,
        response: response,
        clarify_id: _clarifyId || '',
      }),
    }).then(function(result) {
      if (_disposed) return;
      if (result && result.ok) {
        _removeClarifyCard();
      } else {
        var msg = (result && result.error) || 'Clarification response not accepted.';
        _toast(String(msg));
        for (var j = 0; j < buttons.length; j++) buttons[j].disabled = false;
      }
    }).catch(function(err) {
      if (_disposed) return;
      _toast('Clarify failed' + ((err && err.message) ? ': ' + err.message : ''));
      for (var j = 0; j < buttons.length; j++) buttons[j].disabled = false;
    });
  }

  // ── Reconciliation tick ──

  function _tick() {
    if (_disposed || !_sessionId || _inFlight) return;
    _inFlight = true;
    var sid = encodeURIComponent(_sessionId);
    // Poll the VN aliases — the native endpoints 404 cross-profile for
    // sister sessions (the alias delegates under the sister's profile).
    var approvalQ = _api('/api/hyrax/vn/conversations/' + sid + '/approvals/pending', { timeoutToast: false })
      .then(function(data) {
        if (_disposed) return;
        var pending = data && data.pending;
        var pid = pending && pending.approval_id;
        if (pending) {
          if (!_approvalCard || pid !== _approvalId) _renderApproval(pending);
        } else {
          _removeApprovalCard();
        }
      })
      .catch(function() { /* poll errors ignored; next tick retries */ });
    var clarifyQ = _api('/api/hyrax/vn/conversations/' + sid + '/clarify/pending', { timeoutToast: false })
      .then(function(data) {
        if (_disposed) return;
        var pending = data && data.pending;
        var cid = pending && pending.clarify_id;
        if (pending) {
          if (!_clarifyCard || cid !== _clarifyId) _renderClarify(pending);
        } else {
          _removeClarifyCard();
        }
      })
      .catch(function() { /* poll errors ignored */ });
    Promise.all([approvalQ, clarifyQ]).then(function() {
      _inFlight = false;
    }, function() {
      _inFlight = false;
    });
  }

  function refresh() {
    _tick();
  }

  // ── Lifecycle ──

  function init(opts) {
    opts = opts || {};
    dispose();
    if (!opts.container || typeof opts.sessionId !== 'string' || !opts.sessionId) return false;
    _disposed = false;
    _container = opts.container;
    _sessionId = opts.sessionId;

    // SSE frames nudge an immediate reconciliation; the 1.5s poll is the
    // authoritative backstop (card never depends on SSE alone, ARCH §7).
    var ev = ns.events;
    if (ev) {
      _unsubs.push(ev.subscribe('approval.requested', _tick));
      _unsubs.push(ev.subscribe('clarify.requested', _tick));
    }
    _timer = setInterval(_tick, POLL_MS);
    _tick(); // surface an already-blocked session instantly
    return true;
  }

  function dispose() {
    if (_timer) {
      clearInterval(_timer);
      _timer = null;
    }
    for (var i = 0; i < _unsubs.length; i++) {
      try { _unsubs[i](); } catch (_) {}
    }
    _unsubs = [];
    _removeApprovalCard();
    _removeClarifyCard();
    _container = null;
    _sessionId = null;
    _inFlight = false;
    _disposed = true;
  }

  ns.approvals = {
    init: init,
    refresh: refresh,
    dispose: dispose,
  };
})();
