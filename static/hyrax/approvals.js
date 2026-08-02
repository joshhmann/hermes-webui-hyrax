/**
 * Hyraxknot Division — Josh Approvals Panel
 *
 * The D3 G8 approval-tier surface: essenced files an approval request when
 * a proposal lands in a gated risk class (external_resource / config_write /
 * code_edit / destructive); Josh decides here. The panel only ever talks to
 * the two read/respond endpoints — the append-only governance store and the
 * execution lease stay server-side:
 *
 *   GET  /api/hyrax/essence/approvals          — pending + recent decisions
 *   POST /api/hyrax/essence/approvals/respond  — {request_id, decision}
 *
 * Honesty covenant (same as the whims dismiss): a filed decision is shown
 * as "decision filed…" until a poll confirms the request left the pending
 * list — the panel never pretends essenced already acted. essenced's
 * autonomy tick picks the decision up from the store one pass later.
 *
 * Poll cadence: 30s (HQ presence cadence), visibility-gated. The same poll
 * feeds the rail/sidebar nav badge with the pending count.
 *
 * All store-originated strings render via textContent — never HTML.
 */
(function() {
  'use strict';

  var LIST_URL = '/api/hyrax/essence/approvals';
  var DEFAULT_RESPOND_URL = '/api/hyrax/essence/approvals/respond';
  var POLL_INTERVAL_MS = 30000;   // matches HQ presence cadence
  var TICK_INTERVAL_MS = 30000;   // countdown/relative-time re-render

  var RISK_CLASSES = [
    'external_resource', 'config_write', 'code_edit', 'destructive',
  ];

  // ── Module state ──
  var _mounted = false;
  var _rendered = false;          // shell built in #mainApprovals
  var _lastData = null;           // last good GET payload
  var _lastUpdated = 0;           // Date.now() of last good fetch
  var _lastError = null;          // {status} of last failed fetch
  var _respondTo = DEFAULT_RESPOND_URL;
  var _filed = {};                // request_id -> decision (awaiting poll confirm)
  var _filing = {};               // request_id -> true (POST in flight)
  var _confirming = null;         // {id, decision} with an open confirm step
  var _openDetails = {};          // request_id -> true (payload detail open)
  var _pollTimer = null;
  var _tickTimer = null;
  var _actionError = null;        // {id, message} inline action failure

  // ── Helpers ──
  function asStr(v) { return (typeof v === 'string' && v) ? v : ''; }

  function parseTs(v) {
    var t = Date.parse(asStr(v));
    return isNaN(t) ? null : t;
  }

  function relTime(iso) {
    var t = parseTs(iso);
    if (t === null) return 'unknown time';
    var s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 48) return h + 'h ' + (m % 60) + 'm ago';
    return Math.floor(h / 24) + 'd ago';
  }

  function countdown(iso) {
    var t = parseTs(iso);
    if (t === null) return 'no expiry known';
    var s = Math.floor((t - Date.now()) / 1000);
    if (s <= 0) return 'expiring now';
    var m = Math.floor(s / 60);
    if (m < 1) return 'expires in <1m';
    if (m < 60) return 'expires in ' + m + 'm';
    var h = Math.floor(m / 60);
    if (h < 48) return 'expires in ' + h + 'h ' + (m % 60) + 'm';
    return 'expires in ' + Math.floor(h / 24) + 'd';
  }

  function expiresSoon(iso) {
    var t = parseTs(iso);
    return t !== null && (t - Date.now()) < 3600000;
  }

  function riskClass(risk) {
    return RISK_CLASSES.indexOf(risk) !== -1 ? risk : 'unknown';
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  // ── Data ──
  function normalize(payload) {
    var data = (payload && typeof payload === 'object') ? payload : {};
    var pending = Array.isArray(data.pending) ? data.pending : [];
    var decisions = Array.isArray(data.recent_decisions)
      ? data.recent_decisions : [];
    return {
      pending: pending.filter(function(r) {
        return r && typeof r === 'object' && asStr(r.request_id);
      }),
      pending_count: typeof data.pending_count === 'number'
        ? data.pending_count : pending.length,
      recent_decisions: decisions.filter(function(d) {
        return d && typeof d === 'object' && asStr(d.request_id);
      }).slice().reverse(),  // store order is oldest first; show newest first
      respond_to: asStr(data.respond_to) || DEFAULT_RESPOND_URL,
    };
  }

  function refresh() {
    var req;
    try {
      req = api(LIST_URL, { redirect401: false });
    } catch (_) {
      return;  // api helper itself unavailable — leave the last render alone
    }
    Promise.resolve(req).then(function(payload) {
      _lastData = normalize(payload);
      _respondTo = _lastData.respond_to;
      _lastUpdated = Date.now();
      _lastError = null;
      reconcileFiled();
      updateBadge();
      if (_mounted) render();
    }).catch(function(err) {
      _lastError = { status: (err && err.status) || 0 };
      updateBadge();
      if (_mounted) render();
    });
  }

  // Drop "decision filed…" markers once the poll confirms the request left
  // the pending list (decided here, decided elsewhere, or expired).
  function reconcileFiled() {
    if (!_lastData) return;
    var stillPending = {};
    _lastData.pending.forEach(function(r) {
      stillPending[asStr(r.request_id)] = true;
    });
    Object.keys(_filed).forEach(function(id) {
      if (!stillPending[id]) delete _filed[id];
    });
    if (_confirming && !stillPending[_confirming.id]) _confirming = null;
    if (_actionError && !stillPending[_actionError.id]) _actionError = null;
  }

  // ── Nav badge (pending count, subtle) ──
  function updateBadge() {
    var count = (_lastError || !_lastData) ? null : _lastData.pending.length;
    var btns = document.querySelectorAll('[data-panel="approvals"]');
    for (var i = 0; i < btns.length; i++) {
      var badge = btns[i].querySelector('.hyrax-nav-badge');
      if (count === null || count === 0) {
        if (badge) badge.remove();
        continue;
      }
      if (!badge) {
        badge = el('span', 'hyrax-nav-badge');
        btns[i].appendChild(badge);
      }
      badge.textContent = String(count);
      badge.title = count + ' approval' + (count > 1 ? 's' : '')
        + ' awaiting your call';
    }
  }

  // ── Respond action ──
  function respond(request, decision) {
    var id = asStr(request.request_id);
    if (!id || _filed[id] || _filing[id]) return;
    _confirming = null;
    _actionError = null;
    _filing[id] = decision;
    render();
    var req;
    try {
      req = api(_respondTo, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_id: id, decision: decision }),
        redirect401: false,
      });
    } catch (_) {
      delete _filing[id];
      _actionError = { id: id, message: 'decision failed — try again' };
      render();
      return;
    }
    Promise.resolve(req).then(function(payload) {
      delete _filing[id];
      if (!payload || payload.recorded !== true) throw new Error('refused');
      _filed[id] = decision;
      refresh();  // immediate poll confirms (store append is synchronous)
      if (_mounted) render();
    }).catch(function(err) {
      delete _filing[id];
      var msg = (err && err.status === 404)
        ? 'no longer pending — already decided or expired'
        : (err && err.status === 503)
          ? 'store unavailable — essenced governance store unreachable'
          : 'decision failed — try again';
      _actionError = { id: id, message: msg };
      refresh();
      if (_mounted) render();
    });
  }

  // ── Rendering ──
  function riskBadge(risk) {
    var cls = riskClass(risk);
    var badge = el('span', 'japr-risk japr-risk-' + cls,
      cls.replace(/_/g, ' '));
    return badge;
  }

  function buildConfirmBox(request, decision) {
    var box = el('div', 'japr-confirm japr-confirm-' + decision);
    box.appendChild(el('p', 'japr-confirm-q',
      decision === 'approve'
        ? 'Approve? This is exactly what ' + (asStr(request.operator) || 'she')
          + ' is cleared to execute:'
        : 'Deny? The proposal is journaled as a no-op — nothing executes.'));
    if (decision === 'approve') {
      var what = el('dl', 'japr-confirm-what');
      var pairs = [
        ['action', asStr(request.summary) || '(no summary)'],
        ['subject', asStr(request.subject) || '(none)'],
        ['type', asStr(request.proposal_type) || '(unknown)'],
        ['risk', riskClass(request.risk).replace(/_/g, ' ')],
      ];
      pairs.forEach(function(p) {
        what.appendChild(el('dt', null, p[0]));
        what.appendChild(el('dd', null, p[1]));
      });
      box.appendChild(what);
    }
    var row = el('div', 'japr-confirm-actions');
    var go = el('button',
      'japr-btn ' + (decision === 'approve'
        ? 'japr-btn-approve' : 'japr-btn-deny'),
      decision === 'approve' ? 'Confirm approve' : 'Confirm deny');
    go.type = 'button';
    go.addEventListener('click', function() { respond(request, decision); });
    var back = el('button', 'japr-btn japr-btn-back', 'Back');
    back.type = 'button';
    back.addEventListener('click', function() {
      _confirming = null;
      render();
    });
    row.appendChild(go);
    row.appendChild(back);
    box.appendChild(row);
    return box;
  }

  function buildPendingCard(request) {
    var id = asStr(request.request_id);
    var operator = asStr(request.operator) || 'unknown';
    var card = el('article', 'japr-card');

    var head = el('div', 'japr-card-head');
    head.appendChild(el('span', 'japr-operator', operator));
    head.appendChild(riskBadge(asStr(request.risk)));
    head.appendChild(el('span', 'japr-filed',
      'filed ' + relTime(request.created_at)));
    card.appendChild(head);

    card.appendChild(el('p', 'japr-summary',
      asStr(request.summary) || '(no summary)'));

    var meta = el('div', 'japr-meta');
    var cd = el('span', 'japr-countdown'
      + (expiresSoon(request.expires_at) ? ' japr-countdown-soon' : ''),
      countdown(request.expires_at));
    meta.appendChild(cd);
    var detailBtn = el('button', 'japr-detail-toggle',
      (_openDetails[id] ? 'hide' : 'show') + ' detail');
    detailBtn.type = 'button';
    detailBtn.setAttribute('aria-expanded', _openDetails[id] ? 'true' : 'false');
    detailBtn.addEventListener('click', function() {
      if (_openDetails[id]) delete _openDetails[id];
      else _openDetails[id] = true;
      render();
    });
    meta.appendChild(detailBtn);
    card.appendChild(meta);

    if (_openDetails[id]) {
      var detail = el('dl', 'japr-detail');
      [
        ['subject', asStr(request.subject) || '(none)'],
        ['proposal type', asStr(request.proposal_type) || '(unknown)'],
        ['proposal id', asStr(request.proposal_id) || '(unknown)'],
        ['request id', id],
        ['filed at', asStr(request.created_at) || 'unknown'],
        ['expires at', asStr(request.expires_at) || 'unknown'],
      ].forEach(function(p) {
        detail.appendChild(el('dt', null, p[0]));
        detail.appendChild(el('dd', null, p[1]));
      });
      card.appendChild(detail);
    }

    if (_filing[id]) {
      // POST in flight — buttons stay down until the server answers.
      card.classList.add('is-filed');
      card.appendChild(el('p', 'japr-filed-note',
        'filing ' + _filing[id] + '…'));
    } else if (_filed[id]) {
      // Filed, awaiting poll confirmation — never pretend essenced acted.
      card.classList.add('is-filed');
      card.appendChild(el('p', 'japr-filed-note',
        _filed[id] + ' filed — waiting for her next tick…'));
    } else if (_confirming && _confirming.id === id) {
      card.appendChild(buildConfirmBox(request, _confirming.decision));
    } else {
      var actions = el('div', 'japr-actions');
      var approve = el('button', 'japr-btn japr-btn-approve', 'Approve');
      approve.type = 'button';
      approve.addEventListener('click', function() {
        _confirming = { id: id, decision: 'approve' };
        render();
      });
      var deny = el('button', 'japr-btn japr-btn-deny', 'Deny');
      deny.type = 'button';
      deny.addEventListener('click', function() {
        _confirming = { id: id, decision: 'deny' };
        render();
      });
      actions.appendChild(approve);
      actions.appendChild(deny);
      card.appendChild(actions);
    }

    if (_actionError && _actionError.id === id) {
      card.appendChild(el('p', 'japr-error', _actionError.message));
    }
    return card;
  }

  function buildDecisionRow(decision) {
    var kind = asStr(decision.decision) || 'unknown';
    var row = el('div', 'japr-decision');
    var badgeCls = (kind === 'approve') ? 'approved'
      : (kind === 'deny') ? 'denied' : 'other';
    row.appendChild(el('span', 'japr-decision-badge japr-decision-' + badgeCls,
      kind === 'approve' ? 'approved'
        : kind === 'deny' ? 'denied' : kind));
    row.appendChild(el('span', 'japr-decision-id',
      asStr(decision.request_id)));
    row.appendChild(el('span', 'japr-decision-meta',
      'by ' + (asStr(decision.actor) || 'unknown')
      + ' · ' + relTime(decision.decided_at)));
    return row;
  }

  function render() {
    var host = document.getElementById('mainApprovals');
    if (!host) return;
    host.replaceChildren();
    var page = el('div', 'japr-page');

    // Header
    var head = el('div', 'japr-header');
    var titles = el('div', 'japr-titles');
    titles.appendChild(el('h2', 'japr-title', 'Approvals'));
    titles.appendChild(el('p', 'japr-sub',
      'G8 approval-tier proposals wait for your call before anything executes.'));
    head.appendChild(titles);
    var headRight = el('div', 'japr-head-right');
    if (_lastUpdated) {
      headRight.appendChild(el('span', 'japr-updated',
        'updated ' + relTime(new Date(_lastUpdated).toISOString())));
    }
    var refreshBtn = el('button', 'japr-btn japr-btn-refresh', 'Refresh');
    refreshBtn.type = 'button';
    refreshBtn.addEventListener('click', refresh);
    headRight.appendChild(refreshBtn);
    head.appendChild(headRight);
    page.appendChild(head);

    // Error banner (503 store unreachable / network); last good data, if
    // any, stays visible below it.
    if (_lastError) {
      var banner = el('div', 'japr-banner');
      banner.setAttribute('role', 'alert');
      banner.appendChild(el('p', null,
        _lastError.status === 503
          ? 'Approval store unavailable — the essenced governance store is unreachable. Nothing here is stale-safe; retry in a moment.'
          : 'Couldn’t reach the approvals endpoint — retry in a moment.'));
      var retry = el('button', 'japr-btn japr-btn-refresh', 'Retry');
      retry.type = 'button';
      retry.addEventListener('click', refresh);
      banner.appendChild(retry);
      page.appendChild(banner);
    }

    // Pending section
    var pendingSection = el('section', 'japr-section');
    var pending = _lastData ? _lastData.pending : [];
    pendingSection.appendChild(el('h3', 'japr-section-title',
      'Waiting on you' + (pending.length ? ' (' + pending.length + ')' : '')));
    if (!_lastData && _lastError) {
      pendingSection.appendChild(el('p', 'japr-empty',
        'Nothing to show while the store is unreachable.'));
    } else if (!_lastData) {
      pendingSection.appendChild(el('p', 'japr-empty', 'Loading…'));
    } else if (!pending.length) {
      pendingSection.appendChild(el('p', 'japr-empty',
        'Nothing needs your call.'));
    } else {
      var list = el('div', 'japr-list');
      pending.forEach(function(r) { list.appendChild(buildPendingCard(r)); });
      pendingSection.appendChild(list);
    }
    page.appendChild(pendingSection);

    // Recent decisions
    var decSection = el('section', 'japr-section');
    decSection.appendChild(el('h3', 'japr-section-title', 'Recent decisions'));
    var decisions = _lastData ? _lastData.recent_decisions : [];
    if (!decisions.length) {
      decSection.appendChild(el('p', 'japr-empty', 'No decisions yet.'));
    } else {
      var dlist = el('div', 'japr-decisions');
      decisions.forEach(function(d) {
        dlist.appendChild(buildDecisionRow(d));
      });
      decSection.appendChild(dlist);
    }
    page.appendChild(decSection);

    host.appendChild(page);
    _rendered = true;
  }

  // ── Lifecycle (bootstrap.js mount/unmount hooks) ──
  function __approvalsMount() {
    _mounted = true;
    if (!_rendered) render();
    refresh();
    if (!_tickTimer) {
      _tickTimer = setInterval(function() {
        if (document.visibilityState !== 'visible') return;
        if (_mounted) render();  // countdowns + relative times
      }, TICK_INTERVAL_MS);
    }
  }

  function __approvalsUnmount() {
    _mounted = false;
    if (_tickTimer) {
      clearInterval(_tickTimer);
      _tickTimer = null;
    }
  }

  window.__approvalsMount = __approvalsMount;
  window.__approvalsUnmount = __approvalsUnmount;

  // ── Poll: badge always, panel when mounted ──
  function pollTick() {
    if (document.visibilityState !== 'visible') return;
    refresh();
  }
  if (typeof document !== 'undefined') {
    _pollTimer = setInterval(pollTick, POLL_INTERVAL_MS);
    // First paint of the badge once the DOM (and nav buttons) exist.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', refresh, { once: true });
    } else {
      refresh();
    }
  }
})();
