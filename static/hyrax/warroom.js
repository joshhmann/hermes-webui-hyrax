/**
 * Hyraxknot Division — War Room Panel Controller (ES module)
 *
 * Registered through bootstrap.js as the `war-room` extension panel
 * (window.HermesPanels). ONE screen answering "where is the line, what is
 * blocked" — a read-only factory-floor view over the live kanban board,
 * served by GET /api/kanban/war-room (kanban_bridge.py). No writes, ever:
 * the panel only fetches and renders.
 *
 * Sections (single auto-refreshing view, ~30s, quiet by default):
 *   1. DIRECTIVES  — DIRECT/GATE cards with child-chain progress
 *   2. THE FLOOR   — per-lane counts + blocked cards (age + reason, stale
 *                    >24h highlighted) + OPERATOR PRESENCE strip (per-lane
 *                    presence/status/mood/activity + freshness, read-only,
 *                    from GET /api/hyrax/presence — the shared presence
 *                    state for the three-surface doctrine, see
 *                    docs/embodiment-surfaces.md)
 *   3. GATE QUEUE  — Rei's open review gates vs HIGH=8 backpressure mark;
 *                    Yui (hx-tester) mechanical gates shown separately
 *   4. SUBSTANCE FEED — last 20 meaningful events (completions, gate
 *                    verdicts, blocks with reasons) — never heartbeats
 *   5. JOSH ASKS   — parked needs_input cards (bounded options inline in
 *                    the block reason; answering stays on Discord/board)
 *
 * Presence is fetched alongside the board snapshot in the SAME 30s cycle
 * (no second timer); a presence failure fails soft — the board renders,
 * the strip hides. No pings, no notifications: read-only, quiet by default.
 *
 * COMMITMENTS consumes the canonical Promise control-plane projection: owner,
 * state, exact member-card progress, budget use, pending notifications, and
 * cross-Promise dependencies. It is read-only and does not derive state from
 * legacy promise notes or card titles.
 *
 * Scoped classes: .wr-* (hyrax.css). Failures are visible + actionable
 * (inline error + Retry), never silent. Mount/unmount are idempotent; all
 * async work is generation/abort guarded so a stale fetch cannot mutate a
 * later mount; exactly ONE interval (the 30s refresh), cleared on unmount.
 */
'use strict';

var _mounted = false;
var _gen = 0;
var _abort = null;
var _timer = null;
var _hostEl = null;

var REFRESH_MS = 30 * 1000;
var STALE_SECONDS = 24 * 3600;
var GATE_HIGH_MARK = 8;
var LANES = ['tai', 'rei', 'nei', 'mai', 'aya'];

// Vocabulary lockstep with hq.js ACTIVITY_LABELS (test_hyrax_vocabulary
// extracts both as the contract — keep values identical).
var ACTIVITY_LABELS = {
  'idle': 'idle',
  'conversing': 'chatting',
  'tool-working': 'working',
  'waiting-approval': 'needs approval',
  'background-working': 'background',
  'resting': 'resting',
  'offline': 'offline',
};

function _truncate(s, n) {
  s = String(s == null ? '' : s);
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + '…';
}

/** Compact one-line presence label: activity · mood (offline when unavailable). */
function presenceActivityLabel(item) {
  if (!item) return 'offline';
  if (item.available === false) return 'offline';
  var type = item.activity && item.activity.type;
  var label = ACTIVITY_LABELS[type] || type || 'idle';
  var mood = item.expression && item.expression.current;
  return label + (mood && mood !== 'neutral' ? ' · ' + mood : '');
}

/** Derived-state freshness: live / stale Nd / offline / '' (unknown). */
function presenceFreshness(item) {
  if (!item) return '';
  if (item.available === false) return 'offline';
  var ds = item.derivedState;
  if (ds && ds.fresh === true) return 'live';
  if (ds && typeof ds.staleness_days === 'number' && ds.staleness_days > 0) {
    return 'stale ' + ds.staleness_days + 'd';
  }
  return '';
}

function _root() {
  return typeof window !== 'undefined' ? window : globalThis;
}

function _api(url, opts) {
  var w = _root();
  if (typeof w.api === 'function') return w.api(url, opts || {});
  if (typeof fetch === 'function') {
    return fetch(url, opts || {}).then(function(r) {
      if (!r.ok) {
        var err = new Error('HTTP ' + r.status);
        err.status = r.status;
        throw err;
      }
      return r.json();
    });
  }
  return Promise.reject(new Error('no transport'));
}

function _host(idOrEl) {
  if (typeof idOrEl === 'string') {
    return _root().document ? _root().document.getElementById('mainWarRoom') : null;
  }
  return idOrEl || null;
}

function _el(tag, className, text) {
  var e = _root().document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = String(text);
  return e;
}

// ── Pure helpers (exported for the Node harness) ─────────────────────────

/** Seconds → compact relative label. */
function ageLabel(seconds) {
  if (seconds == null) return '';
  var s = Number(seconds);
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  if (s < 7 * 86400) return Math.floor(s / 86400) + 'd';
  return Math.floor(s / (7 * 86400)) + 'w';
}

/** One-line "what happened" for a substance-feed event. */
function feedDetail(kind, payload) {
  payload = payload || {};
  if (kind === 'completed') return payload.summary || '';
  if (kind === 'blocked' || kind === 'unblocked') return payload.reason || '';
  if (kind === 'progress') {
    var bits = [payload.tool || ''];
    if (payload.artifact) bits.push(payload.artifact);
    return bits.join(' → ');
  }
  if (kind === 'created') return payload.status ? 'status: ' + payload.status : '';
  if (kind === 'promoted' || kind === 'promoted_manual') return payload.status ? '→ ' + payload.status : '';
  if (kind === 'commented') return payload.author ? 'by ' + payload.author : '';
  if (kind === 'attached') return payload.filename ? 'attached ' + payload.filename : '';
  if (kind === 'decomposed') return payload.child_count ? payload.child_count + ' children' : '';
  return '';
}

/** Lane counts → the three numbers Josh watches: running / blocked / queued. */
function laneSummary(counts) {
  counts = counts || {};
  var queued = (counts.todo || 0) + (counts.ready || 0);
  return {
    running: counts.running || 0,
    blocked: counts.blocked || 0,
    queued: queued,
  };
}

// ── Renderers ────────────────────────────────────────────────────────────

function _chip(parent, text, cls) {
  var c = _el('span', 'wr-chip' + (cls ? ' ' + cls : ''), text);
  parent.appendChild(c);
  return c;
}

function _section(title, hint) {
  var sec = _el('section', 'wr-section');
  var head = _el('div', 'wr-section-head');
  head.appendChild(_el('h3', 'wr-section-title', title));
  if (hint) head.appendChild(_el('span', 'wr-section-hint', hint));
  sec.appendChild(head);
  var body = _el('div', 'wr-section-body');
  sec.appendChild(body);
  return { sec: sec, body: body };
}

function _renderDirectives(body, directives) {
  if (!directives || !directives.length) {
    body.appendChild(_el('p', 'wr-empty', 'No DIRECT cards — nothing is steering the board.'));
    return;
  }
  directives.forEach(function(d) {
    var row = _el('div', 'wr-directive' + (d.status === 'done' ? ' wr-done' : ''));
    var top = _el('div', 'wr-directive-top');
    _chip(top, String(d.status || '?').toUpperCase(), 'wr-chip-' + (d.status || 'todo'));
    top.appendChild(_el('span', 'wr-directive-title', d.title));
    if (d.assignee) top.appendChild(_el('span', 'wr-directive-lane', d.assignee));
    row.appendChild(top);

    var total = d.children ? d.children.total : 0;
    if (total > 0) {
      var done = d.children.done || 0;
      var pct = Math.round((done / total) * 100);
      var bar = _el('div', 'wr-bar');
      var fill = _el('div', 'wr-bar-fill');
      fill.style.width = pct + '%';
      bar.appendChild(fill);
      row.appendChild(bar);
      var meta = _el('div', 'wr-directive-meta');
      meta.appendChild(_el('span', null, done + '/' + total + ' done (' + pct + '%)'));
      meta.appendChild(_el('span', null, 'stage: ' + (d.current_stage || 'complete')));
      row.appendChild(meta);
    } else {
      row.appendChild(_el('div', 'wr-directive-meta', 'no child cards linked'));
    }
    body.appendChild(row);
  });
}

function _renderPresenceStrip(body, items) {
  if (!items || !items.length) return; // fail soft — no presence, no strip
  // LANES order first, then any extra operators (e.g. aya-class extras).
  var byId = {};
  items.forEach(function(it) { if (it && it.operatorId) byId[it.operatorId] = it; });
  var ordered = [];
  LANES.forEach(function(lane) {
    if (byId[lane]) { ordered.push(byId[lane]); delete byId[lane]; }
  });
  Object.keys(byId).forEach(function(id) { ordered.push(byId[id]); });

  var head = _el('div', 'wr-subhead');
  head.appendChild(_el('span', null, 'OPERATOR PRESENCE'));
  head.appendChild(_el('span', 'wr-subhead-count', String(ordered.length)));
  body.appendChild(head);

  var strip = _el('div', 'wr-presence');
  strip.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin:4px 0 10px';
  ordered.forEach(function(item) {
    var row = _el('div', 'wr-presence-row');
    row.style.cssText = 'display:flex;flex-wrap:wrap;align-items:baseline;gap:6px';
    _chip(row, item.operatorId, 'wr-chip-lane');
    row.appendChild(_el('span', 'wr-blocked-age', presenceActivityLabel(item)));
    var fresh = presenceFreshness(item);
    // Offline already shows via the activity label — only tag live/stale.
    if (fresh && fresh !== 'offline') {
      row.appendChild(_el('span', 'wr-blocked-age', fresh));
    }
    var task = item.currentTask && item.currentTask.title;
    if (task) {
      var t = _el('span', 'wr-blocked-title', _truncate(task, 72));
      t.style.cssText = 'max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      t.title = task;
      row.appendChild(t);
    }
    strip.appendChild(row);
  });
  body.appendChild(strip);
}

function _renderFloor(body, floor, presenceItems) {
  floor = floor || {};
  var grid = _el('div', 'wr-lane-grid');
  var lanes = floor.lanes || [];
  lanes.forEach(function(l) {
    var s = laneSummary(l.counts);
    var card = _el('div', 'wr-lane wr-lane-' + l.lane);
    card.appendChild(_el('span', 'wr-lane-name', l.lane));
    var counts = _el('div', 'wr-lane-counts');
    counts.appendChild(_el('span', 'wr-num wr-num-running', String(s.running)));
    counts.appendChild(_el('span', 'wr-num wr-num-blocked', String(s.blocked)));
    counts.appendChild(_el('span', 'wr-num wr-num-queued', String(s.queued)));
    card.appendChild(counts);
    var labels = _el('div', 'wr-lane-labels');
    labels.appendChild(_el('span', null, 'running'));
    labels.appendChild(_el('span', null, 'blocked'));
    labels.appendChild(_el('span', null, 'queued'));
    card.appendChild(labels);
    grid.appendChild(card);
  });
  body.appendChild(grid);

  // Operator presence strip — the shared presence state (read-only, quiet).
  _renderPresenceStrip(body, presenceItems);

  var blocked = floor.blocked || [];
  var blockHead = _el('div', 'wr-subhead');
  blockHead.appendChild(_el('span', null, 'BLOCKED'));
  blockHead.appendChild(_el('span', 'wr-subhead-count', String(blocked.length)));
  body.appendChild(blockHead);
  if (!blocked.length) {
    body.appendChild(_el('p', 'wr-empty', 'Nothing blocked — the floor is clear.'));
    return;
  }
  blocked.forEach(function(b) {
    var row = _el('div', 'wr-blocked' + (b.stale ? ' wr-stale' : ''));
    row.setAttribute('data-task', b.id);
    var top = _el('div', 'wr-blocked-top');
    _chip(top, b.lane, 'wr-chip-lane');
    if (b.block_kind) _chip(top, b.block_kind, 'wr-chip-kind');
    top.appendChild(_el('span', 'wr-blocked-age', ageLabel(b.age_seconds)));
    if (b.stale) top.appendChild(_el('span', 'wr-stale-tag', 'STALE >24h'));
    row.appendChild(top);
    row.appendChild(_el('div', 'wr-blocked-title', b.title));
    if (b.reason) row.appendChild(_el('div', 'wr-blocked-reason', b.reason));
    body.appendChild(row);
  });
}

function _renderGateQueue(body, gq) {
  gq = gq || {};
  var depth = gq.depth || 0;
  var high = gq.high_mark || GATE_HIGH_MARK;
  var over = !!gq.over;

  var gauge = _el('div', 'wr-gauge' + (over ? ' wr-gauge-over' : ''));
  var label = _el('div', 'wr-gauge-label');
  label.appendChild(_el('span', null, 'review depth'));
  label.appendChild(_el('strong', null, String(depth) + ' / HIGH ' + high));
  if (over) label.appendChild(_el('span', 'wr-gauge-tag', 'OVER'));
  gauge.appendChild(label);
  var bar = _el('div', 'wr-bar');
  var fill = _el('div', 'wr-bar-fill');
  fill.style.width = Math.min(100, Math.round((depth / Math.max(high, 1)) * 100)) + '%';
  bar.appendChild(fill);
  gauge.appendChild(bar);
  body.appendChild(gauge);

  function list(cards, emptyText) {
    if (!cards || !cards.length) {
      body.appendChild(_el('p', 'wr-empty', emptyText));
      return;
    }
    cards.forEach(function(g) {
      var row = _el('div', 'wr-gate-row');
      row.setAttribute('data-task', g.id);
      var top = _el('div', 'wr-blocked-top');
      _chip(top, g.status || '?', 'wr-chip-' + (g.status || 'todo'));
      top.appendChild(_el('span', 'wr-blocked-age', ageLabel(g.age_seconds)));
      row.appendChild(top);
      row.appendChild(_el('div', 'wr-blocked-title', g.title));
      if (g.reason) row.appendChild(_el('div', 'wr-blocked-reason', g.reason));
      body.appendChild(row);
    });
  }

  var rHead = _el('div', 'wr-subhead');
  rHead.appendChild(_el('span', null, 'REI REVIEW GATES'));
  rHead.appendChild(_el('span', 'wr-subhead-count', String((gq.review_gates || []).length + (gq.review_blocks || []).length)));
  body.appendChild(rHead);
  list((gq.review_gates || []).concat(gq.review_blocks || []), 'No open review gates.');

  var mHead = _el('div', 'wr-subhead');
  mHead.appendChild(_el('span', null, 'YUI MECHANICAL GATES (hx-tester)'));
  mHead.appendChild(_el('span', 'wr-subhead-count', String((gq.mechanical || []).length)));
  body.appendChild(mHead);
  list(gq.mechanical || [], 'No mechanical gates queued.');
}

function _renderFeed(body, feed) {
  if (!feed || !feed.length) {
    body.appendChild(_el('p', 'wr-empty', 'No substance events yet.'));
    return;
  }
  feed.forEach(function(ev) {
    var row = _el('div', 'wr-feed-row');
    row.setAttribute('data-event', String(ev.id));
    var top = _el('div', 'wr-blocked-top');
    _chip(top, ev.kind, 'wr-chip-' + ev.kind);
    top.appendChild(_el('span', 'wr-blocked-age', ageLabel(ev.age_seconds)));
    row.appendChild(top);
    if (ev.title) row.appendChild(_el('div', 'wr-feed-title', ev.title));
    var detail = feedDetail(ev.kind, ev.payload);
    if (detail) row.appendChild(_el('div', 'wr-feed-detail', detail));
    body.appendChild(row);
  });
}

function _renderJoshAsks(body, asks) {
  if (!asks || !asks.length) {
    body.appendChild(_el('p', 'wr-empty', 'No parked Josh decisions.'));
    return;
  }
  asks.forEach(function(a) {
    var row = _el('div', 'wr-ask' + (a.age_seconds > STALE_SECONDS ? ' wr-stale' : ''));
    row.setAttribute('data-task', a.id);
    var top = _el('div', 'wr-blocked-top');
    _chip(top, a.assignee, 'wr-chip-lane');
    top.appendChild(_el('span', 'wr-blocked-age', ageLabel(a.age_seconds)));
    row.appendChild(top);
    row.appendChild(_el('div', 'wr-ask-title', a.title));
    if (a.reason) row.appendChild(_el('div', 'wr-ask-reason', a.reason));
    row.appendChild(_el('div', 'wr-ask-hint', 'Answer on Discord or the board — this screen is read-only.'));
    body.appendChild(row);
  });
}

function _budgetLabel(name, budget) {
  if (!budget || budget.max == null) return '';
  return name + ' ' + budget.used + '/' + budget.max;
}

function _renderCommitments(body, commitments) {
  if (!commitments || commitments.available !== true) {
    body.appendChild(_el('p', 'wr-empty', 'Canonical Promise data is unavailable for this board.'));
    return;
  }
  var items = commitments.items || [];
  if (!items.length) {
    body.appendChild(_el('p', 'wr-empty', 'No active Promises on this board.'));
    return;
  }
  items.forEach(function(p) {
    var row = _el('div', 'wr-commitment' + (p.status === 'blocked' ? ' wr-stale' : ''));
    var top = _el('div', 'wr-blocked-top');
    _chip(top, p.status || '?', 'wr-chip-' + (p.status || 'planned'));
    _chip(top, p.owner || 'unowned', 'wr-chip-lane');
    if (p.pending_notifications) _chip(top, p.pending_notifications + ' pending notice', 'wr-chip-kind');
    row.appendChild(top);
    row.appendChild(_el('div', 'wr-commitment-title', p.title));
    var tasks = p.tasks || {};
    var progress = _el('div', 'wr-directive-meta');
    progress.appendChild(_el('span', null, (tasks.done || 0) + '/' + (tasks.total || 0) + ' cards done'));
    if (tasks.blocked) progress.appendChild(_el('span', null, tasks.blocked + ' blocked'));
    row.appendChild(progress);
    var budgets = p.budgets || {};
    var labels = [
      _budgetLabel('attempts', budgets.attempts),
      _budgetLabel('LLM calls', budgets.llm_calls),
      _budgetLabel('tokens', budgets.tokens),
      _budgetLabel('wall', budgets.wall_seconds),
    ].filter(Boolean);
    if (labels.length) row.appendChild(_el('div', 'wr-commitment-budget', labels.join(' · ')));
    if (p.relations && p.relations.length) {
      row.appendChild(_el('div', 'wr-commitment-relation', p.relations.map(function(r) {
        return r.type + ' ' + r.target_id;
      }).join(' · ')));
    }
    body.appendChild(row);
  });
}

function _render(host, payload, error, lastUpdated, presenceItems) {
  host.replaceChildren();
  var page = _el('div', 'panel-page');
  var header = _el('div', 'page-header');
  var titleRow = _el('div', 'wr-title-row');
  titleRow.appendChild(_el('h2', 'page-title', 'War Room'));
  var badge = _el('span', 'wr-badge', 'READ-ONLY');
  titleRow.appendChild(badge);
  header.appendChild(titleRow);
  header.appendChild(_el('p', 'page-subtitle',
    'The factory floor — where the line is, what is blocked. Live kanban view, auto-refresh 30s.'));
  var statusLine = _el('div', 'wr-status');
  var updatedLabel = '';
  if (lastUpdated && payload && payload.generated_at) {
    updatedLabel = 'updated ' + ageLabel(Math.max(0, lastUpdated - payload.generated_at)) + ' ago';
  }
  statusLine.appendChild(_el('span', null, updatedLabel));
  if (payload && payload.gate_queue) {
    var depth = payload.gate_queue.depth || 0;
    statusLine.appendChild(_el('span', 'wr-status-gate',
      'gate depth ' + depth + (payload.gate_queue.over ? ' — OVER HIGH ' + payload.gate_queue.high_mark : '')));
  }
  header.appendChild(statusLine);
  page.appendChild(header);

  var content = _el('div', 'panel-content');

  if (error) {
    var errBox = _el('div', 'panel-error');
    errBox.setAttribute('role', 'alert');
    errBox.appendChild(_el('p', null, error));
    var retry = _el('button', 'panel-retry', 'Retry');
    retry.type = 'button';
    retry.addEventListener('click', function() { _load(host); });
    errBox.appendChild(retry);
    content.appendChild(errBox);
    page.appendChild(content);
    host.appendChild(page);
    return;
  }

  if (!payload || payload.read_only !== true) {
    var bad = _el('div', 'panel-error');
    bad.setAttribute('role', 'alert');
    bad.appendChild(_el('p', null,
      'Unexpected response from /api/kanban/war-room — expected the read-only snapshot.'));
    content.appendChild(bad);
    page.appendChild(content);
    host.appendChild(page);
    return;
  }

  var d = _section('DIRECTIVES', 'steering cards · child-chain progress');
  _renderDirectives(d.body, payload.directives);
  content.appendChild(d.sec);

  var c = _section('COMMITMENTS', 'canonical Promise graph · read-only');
  _renderCommitments(c.body, payload.commitments);
  content.appendChild(c.sec);

  var f = _section('THE FLOOR', 'per-lane running / blocked / queued · operator presence');
  _renderFloor(f.body, payload.floor, presenceItems);
  content.appendChild(f.sec);

  var g = _section('GATE QUEUE', 'review depth vs HIGH=' + (payload.gate_queue.high_mark || GATE_HIGH_MARK));
  _renderGateQueue(g.body, payload.gate_queue);
  content.appendChild(g.sec);

  var s = _section('SUBSTANCE FEED', 'completions · verdicts · blocks — no heartbeats');
  _renderFeed(s.body, payload.substance_feed);
  content.appendChild(s.sec);

  var a = _section('JOSH ASKS', 'parked needs_input — answer on Discord / board');
  _renderJoshAsks(a.body, payload.josh_asks);
  content.appendChild(a.sec);

  page.appendChild(content);
  host.appendChild(page);
}

function _load(host) {
  var gen = ++_gen;
  var w = _root();
  if (_abort) { try { _abort.abort(); } catch (_) {} }
  if (typeof AbortController === 'function') {
    _abort = new AbortController();
  } else {
    _abort = null;
  }
  var opts = {};
  if (_abort) opts.signal = _abort.signal;

  // Presence is part of the SAME 30s cycle as the board snapshot — no second
  // timer. A presence failure fails soft (board still renders; strip hides).
  var boardP = _api('/api/kanban/war-room', opts);
  var presenceP = _api('/api/hyrax/presence', opts).catch(function() { return null; });

  Promise.all([boardP, presenceP]).then(function(res) {
    if (gen !== _gen || !_mounted) return; // stale — a newer mount owns the host
    var presenceItems = res[1] && Array.isArray(res[1].items) ? res[1].items : null;
    _render(host, res[0], null, Date.now() / 1000, presenceItems);
  }).catch(function() {
    if (gen !== _gen || !_mounted) return;
    _render(host, null, 'Could not load the war room — is the kanban bridge up?', null, null);
  });
}

/**
 * Mount the war-room panel into its host (panel id string or host element).
 * Arms exactly ONE 30s refresh interval; idempotent re-mount just refreshes.
 */
function mount(idOrEl) {
  var host = _host(idOrEl);
  if (!host) return;
  _hostEl = host;
  if (_mounted) {
    _load(host);
    return;
  }
  _mounted = true;
  _load(host);
  if (!_timer) {
    _timer = setInterval(function() {
      if (_mounted) _load(host);
    }, REFRESH_MS);
  }
}

/** Unmount: stop the timer, abort in-flight work, clear the host. */
function unmount(idOrEl) {
  _gen++;
  _mounted = false;
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  if (_abort) {
    try { _abort.abort(); } catch (_) {}
    _abort = null;
  }
  var host = _hostEl || _host(idOrEl);
  _hostEl = null;
  if (host) {
    try { host.replaceChildren(); } catch (_) {}
  }
}

export { mount, unmount, ageLabel, feedDetail, laneSummary, presenceActivityLabel, presenceFreshness };
