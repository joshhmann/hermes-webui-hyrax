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
 *   1. WHERE EVERYONE IS — ledger table, one row per sister: now / working
 *                    on / waiting / stuck, plus a stuck-card list with
 *                    reasons (presence state from GET /api/hyrax/presence,
 *                    shared with HQ — see docs/embodiment-surfaces.md)
 *   2. NEEDS YOU  — parked needs_input cards (bounded options inline in
 *                    the block reason; answering stays on Discord/board)
 *   3. RECENT ACTIVITY — last 20 meaningful events (completions, gate
 *                    verdicts, blocks with reasons) — never heartbeats;
 *                    tool-progress telemetry hidden by default
 *   4. PROGRAMS   — active work programs (steering cards + Promises merged)
 *                    with cards-N/M-done progress; finished ones collapsed
 *                    under "recently finished"
 *   5. QA QUEUE   — one plain line, no gauge
 * Plus a PULSE LINE in the header: working / stuck / waiting / need you.
 *
 * Plain-language pass (Rei QA review): every visible label uses everyday
 * words — no DIRECT/GATE/Promise/lane/HIGH/read-only without a plain
 * subtitle. Visible copy maps: DIRECTIVES+COMMITMENTS → Programs, THE
 * FLOOR/OPERATOR PRESENCE → Where everyone is, GATE QUEUE → QA queue,
 * SUBSTANCE FEED → Recent activity, JOSH ASKS → Needs you, running →
 * working, blocked → stuck, queued → waiting.
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
var LANES = ['tai', 'rei', 'nei', 'mai', 'aya'];
// Tool-progress feed rows are hidden by default (plain-language pass); the
// Recent activity "show tool activity" toggle reveals them.
var _feedShowProgress = false;

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
  return { sec: sec, body: body, head: head };
}

/** Plain word for a card/program status (running → working, blocked → stuck, …). */
function _plainStatus(status) {
  var map = {
    running: 'working', blocked: 'stuck', review: 'in review',
    todo: 'waiting', ready: 'waiting', triage: 'waiting', scheduled: 'waiting',
    planned: 'waiting', done: 'done',
  };
  return map[status] || status || '';
}

/** Plain word for a feed event kind (visible chip text; CSS class keeps the raw kind). */
function _plainKind(kind) {
  var map = {
    completed: 'finished', blocked: 'blocked', unblocked: 'unblocked',
    created: 'started', promoted: 'moved', promoted_manual: 'moved',
    commented: 'commented', attached: 'attached', decomposed: 'split',
    progress: 'tool activity',
  };
  return map[kind] || kind || '';
}

/** The four pulse numbers: working / stuck / waiting / need you. */
function _pulseCounts(payload) {
  var lanes = (payload && payload.floor && payload.floor.lanes) || [];
  var working = 0, stuck = 0, waiting = 0;
  lanes.forEach(function(l) {
    var s = laneSummary(l.counts);
    working += s.running;
    stuck += s.blocked;
    waiting += s.queued;
  });
  return {
    working: working,
    stuck: stuck,
    waiting: waiting,
    needYou: (payload && payload.josh_asks ? payload.josh_asks.length : 0),
  };
}

/** Header pulse line: big plain numbers + updated-ago. */
function _renderPulse(header, payload, lastUpdated) {
  if (!payload) return;
  var c = _pulseCounts(payload);
  var pulse = _el('div', 'wr-pulse');
  [[c.working, 'working'], [c.stuck, 'stuck'], [c.waiting, 'waiting'], [c.needYou, 'need you']]
    .forEach(function(pair) {
      var cell = _el('div', 'wr-pulse-cell');
      cell.appendChild(_el('strong', null, String(pair[0])));
      cell.appendChild(_el('span', null, pair[1]));
      pulse.appendChild(cell);
    });
  if (lastUpdated && payload.generated_at) {
    pulse.appendChild(_el('span', 'wr-pulse-updated',
      'updated ' + ageLabel(Math.max(0, lastUpdated - payload.generated_at)) + ' ago'));
  }
  header.appendChild(pulse);
}

/** Oldest stuck age for a lane (seconds; 0 when none). */
function _oldestStuckAge(laneId, blocked) {
  var best = 0;
  (blocked || []).forEach(function(b) {
    if (b.lane === laneId && b.age_seconds > best) best = b.age_seconds;
  });
  return best;
}

/**
 * "Where everyone is" — a ledger table, one row per sister: now / working
 * on / waiting / stuck. Presence state feeds the Now + Working on columns
 * (fail soft — no presence, those columns read "—").
 */
function _renderWhere(body, floor, presenceItems) {
  floor = floor || {};
  var lanes = floor.lanes || [];
  var blocked = floor.blocked || [];

  var byId = {};
  (presenceItems || []).forEach(function(it) { if (it && it.operatorId) byId[it.operatorId] = it; });

  var grid = _el('div', 'wr-ledger');
  ['Sister', 'Now', 'Working on', 'Waiting', 'Stuck'].forEach(function(col) {
    grid.appendChild(_el('div', 'wr-ledger-head', col));
  });
  lanes.forEach(function(l) {
    var s = laneSummary(l.counts);
    var item = byId[l.lane];
    var row = _el('div', 'wr-ledger-row');
    row.setAttribute('data-lane', l.lane);

    row.appendChild(_el('div', 'wr-ledger-cell wr-ledger-lane', l.lane));

    var now = '—';
    if (item) {
      now = presenceActivityLabel(item);
      var fresh = presenceFreshness(item);
      // "live" is the common case and reads as noise — only flag staleness.
      if (fresh && fresh !== 'live' && fresh !== 'offline') now += ' · ' + fresh;
    }
    row.appendChild(_el('div', 'wr-ledger-cell' + (now === '—' ? ' wr-ledger-muted' : ''), now));

    var task = item && item.currentTask && item.currentTask.title;
    var workCell = _el('div', 'wr-ledger-cell' + (task ? '' : ' wr-ledger-muted'),
      task ? _truncate(task, 60) : '—');
    if (task) workCell.title = task;
    row.appendChild(workCell);

    row.appendChild(_el('div', 'wr-ledger-cell wr-ledger-num', String(s.queued)));

    var stuckAge = _oldestStuckAge(l.lane, blocked);
    var stuckText = s.blocked
      ? String(s.blocked) + (stuckAge > 0 ? ' · ' + ageLabel(stuckAge) : '')
      : '—';
    var stuckCell = _el('div', 'wr-ledger-cell' + (s.blocked ? ' wr-ledger-stuck-num' : ' wr-ledger-muted'), stuckText);
    row.appendChild(stuckCell);

    grid.appendChild(row);
  });
  body.appendChild(grid);

  // Stuck cards with reasons — clickable into the flight recorder.
  var subhead = _el('div', 'wr-subhead');
  subhead.appendChild(_el('span', null, 'Stuck'));
  subhead.appendChild(_el('span', 'wr-subhead-count', String(blocked.length)));
  body.appendChild(subhead);
  _renderStuckList(body, blocked);
}

function _renderStuckList(body, blocked) {
  if (!blocked || !blocked.length) {
    body.appendChild(_el('p', 'wr-empty', 'Nothing stuck.'));
    return;
  }
  blocked.forEach(function(b) {
    var row = _el('div', 'wr-blocked' + (b.stale ? ' wr-stale' : ''));
    row.setAttribute('data-task', b.id);
    _wireCardClick(row, b.id);
    var top = _el('div', 'wr-blocked-top');
    _chip(top, b.lane, 'wr-chip-lane');
    if (b.block_kind) _chip(top, b.block_kind, 'wr-chip-kind');
    top.appendChild(_el('span', 'wr-blocked-age', ageLabel(b.age_seconds)));
    if (b.stale) top.appendChild(_el('span', 'wr-stale-tag', 'stuck 24h+'));
    row.appendChild(top);
    row.appendChild(_el('div', 'wr-blocked-title', b.title));
    if (b.reason) row.appendChild(_el('div', 'wr-blocked-reason', b.reason));
    body.appendChild(row);
  });
}

/** QA queue — one plain line (no gauge, no HIGH marks). */
function _renderQaQueue(body, gq) {
  gq = gq || {};
  var depth = gq.depth || 0;
  var mech = (gq.mechanical || []).length;
  if (!depth && !mech) {
    body.appendChild(_el('p', 'wr-empty', 'QA queue: clear.'));
    return;
  }
  var line = _el('div', 'wr-qa-line' + (gq.over ? ' wr-qa-busy' : ''));
  line.appendChild(_el('span', null, 'QA queue: '));
  line.appendChild(_el('strong', null, String(depth) + ' waiting'));
  body.appendChild(line);
  if (mech) body.appendChild(_el('div', 'wr-qa-sub', 'auto-checks: ' + mech + ' waiting'));
}

/** Feed rows: time | what | title — one consolidated "working on X" line per
 * active sister comes from the Where-everyone-is table, so tool-progress
 * telemetry is hidden by default (see _renderRecentActivity toggle). */
function _renderFeedRows(body, feed, showProgress) {
  if (!feed || !feed.length) {
    body.appendChild(_el('p', 'wr-empty', 'No activity yet.'));
    return;
  }
  var shown = 0;
  feed.forEach(function(ev) {
    if (ev.kind === 'progress' && !showProgress) return; // tool chatter hidden by default
    var row = _el('div', 'wr-feed-row');
    row.setAttribute('data-event', String(ev.id));
    if (ev.task_id) {
      row.setAttribute('data-task', ev.task_id);
      _wireCardClick(row, ev.task_id);
    }
    var top = _el('div', 'wr-blocked-top');
    _chip(top, _plainKind(ev.kind), 'wr-chip-' + ev.kind);
    top.appendChild(_el('span', 'wr-blocked-age', ageLabel(ev.age_seconds)));
    row.appendChild(top);
    if (ev.title) row.appendChild(_el('div', 'wr-feed-title', ev.title));
    var detail = feedDetail(ev.kind, ev.payload);
    if (detail) row.appendChild(_el('div', 'wr-feed-detail', detail));
    body.appendChild(row);
    shown++;
  });
  if (!shown) body.appendChild(_el('p', 'wr-empty', 'Only tool steps — toggle above to show them.'));
}

function _renderRecentActivity(body, feed) {
  var toggle = _el('button', 'wr-feed-toggle', _feedShowProgress ? 'Hide tool activity' : 'Show tool activity');
  toggle.type = 'button';
  toggle.addEventListener('click', function() {
    _feedShowProgress = !_feedShowProgress;
    toggle.textContent = _feedShowProgress ? 'Hide tool activity' : 'Show tool activity';
    body.replaceChildren();
    _renderFeedRows(body, feed, _feedShowProgress);
  });
  _renderFeedRows(body, feed, _feedShowProgress);
  return toggle; // caller appends it to the section head
}

/** Needs you — parked needs_input cards (what / who asked / how long / ask). */
function _renderNeedsYou(body, asks) {
  if (!asks || !asks.length) {
    body.appendChild(_el('p', 'wr-empty', 'Nothing needs you.'));
    return;
  }
  asks.forEach(function(a) {
    var row = _el('div', 'wr-ask' + (a.age_seconds > STALE_SECONDS ? ' wr-stale' : ''));
    row.setAttribute('data-task', a.id);
    _wireCardClick(row, a.id);
    var top = _el('div', 'wr-blocked-top');
    if (a.assignee) _chip(top, a.assignee, 'wr-chip-lane');
    top.appendChild(_el('span', 'wr-blocked-age', ageLabel(a.age_seconds)));
    row.appendChild(top);
    row.appendChild(_el('div', 'wr-ask-title', a.title));
    if (a.reason) row.appendChild(_el('div', 'wr-ask-reason', a.reason));
    row.appendChild(_el('div', 'wr-ask-hint', 'Answer on Discord or the board — this screen is view only.'));
    body.appendChild(row);
  });
}

// ── Flight recorder (per-card trace waterfall) ──────────────────────────

var _recorderTaskId = null;

/** Wire a card row so a click opens the per-card flight recorder. */
function _wireCardClick(row, taskId) {
  if (!row || !taskId) return;
  row.className = String(row.className || '') + ' wr-clickable';
  row.addEventListener('click', function() {
    _openRecorder(String(taskId));
  });
}

/** Human duration: 5s / 3m / 2h / 1d. Empty for null/zero. */
function fmtDuration(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds)) || seconds <= 0) return '';
  var s = Number(seconds);
  if (s < 60) return Math.round(s) + 's';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  return Math.round(s / 86400) + 'd';
}

/** Wall-clock label for a run/span timestamp (epoch seconds). */
function clockLabel(ts) {
  if (ts == null) return '';
  var d = new Date(Number(ts) * 1000);
  if (isNaN(d.getTime())) return '';
  var pad = function(n) { return String(n).padStart(2, '0'); };
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

/** Parse #card=t_xxx from a location hash ('' / null-safe). */
function cardIdFromHash(hash) {
  if (!hash) return null;
  var m = String(hash).match(/#card=([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

/** Chip class for a run status / outcome (falls back to the value itself). */
function _runChipClass(status) {
  return 'wr-chip-' + String(status || 'unknown').toLowerCase();
}

function _renderRecorderRuns(body, payload) {
  var runs = payload.runs || [];
  var cardEvents = payload.card_events || [];
  if (!runs.length && !cardEvents.length) {
    body.appendChild(_el('p', 'wr-empty',
      'No runs recorded yet — this card has never been dispatched. Its contract and evidence pane stays available.'));
    return;
  }

  if (cardEvents.length) {
    var cHead = _el('div', 'wr-subhead');
    cHead.appendChild(_el('span', null, 'CARD EVENTS'));
    cHead.appendChild(_el('span', 'wr-subhead-count', String(cardEvents.length)));
    body.appendChild(cHead);
    cardEvents.forEach(function(ev) {
      var row = _el('div', 'wr-span' + (ev.substance ? ' wr-span-substance' : ' wr-span-idle'));
      var top = _el('div', 'wr-blocked-top');
      _chip(top, ev.kind, ev.substance ? 'wr-chip-' + ev.kind : 'wr-chip-idle');
      top.appendChild(_el('span', 'wr-span-ts', clockLabel(ev.ts)));
      if (ev.duration) top.appendChild(_el('span', 'wr-span-dur', fmtDuration(ev.duration)));
      row.appendChild(top);
      if (ev.payload_summary) row.appendChild(_el('div', 'wr-span-summary', ev.payload_summary));
      body.appendChild(row);
    });
  }

  runs.forEach(function(run) {
    var box = _el('div', 'wr-run');
    var head = _el('div', 'wr-run-head');
    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');
    _chip(head, 'run ' + run.id, _runChipClass(run.outcome || run.status));
    if (run.profile) _chip(head, run.profile, 'wr-chip-lane');
    var meta = _el('span', 'wr-run-meta');
    meta.textContent =
      clockLabel(run.started_at) + ' → ' + clockLabel(run.ended_at) +
      (run.ended_at ? ' · ' + fmtDuration(run.ended_at - run.started_at) : ' · still running');
    head.appendChild(meta);
    if (run.outcome) head.appendChild(_el('span', 'wr-run-outcome', String(run.outcome).toUpperCase()));
    box.appendChild(head);

    var spansBody = _el('div', 'wr-run-spans');
    spansBody.style.display = 'none';
    head.addEventListener('click', function() {
      spansBody.style.display = spansBody.style.display === 'none' ? '' : 'none';
      if (head.classList) {
        head.classList.toggle('wr-run-open', spansBody.style.display !== 'none');
      }
    });
    head.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); head.click(); }
    });

    if (run.summary) spansBody.appendChild(_el('div', 'wr-run-summary', run.summary));
    if (run.error) spansBody.appendChild(_el('div', 'wr-run-error', 'error: ' + run.error));
    if (run.heartbeat && run.heartbeat.count) {
      var hb = run.heartbeat;
      var hbRow = _el('div', 'wr-span wr-span-idle');
      var hbTop = _el('div', 'wr-blocked-top');
      _chip(hbTop, 'heartbeat', 'wr-chip-idle');
      hbTop.appendChild(_el('span', 'wr-span-ts', clockLabel(hb.first)));
      hbTop.appendChild(_el('span', 'wr-span-dur',
        '\u00d7' + hb.count + ' over ' + fmtDuration(hb.last - hb.first)));
      hbRow.appendChild(hbTop);
      hbRow.appendChild(_el('div', 'wr-span-summary', 'liveness cadence — no substance'));
      spansBody.appendChild(hbRow);
    }
    (run.spans || []).forEach(function(ev) {
      var row = _el('div', 'wr-span' + (ev.substance ? ' wr-span-substance' : ' wr-span-idle'));
      var top = _el('div', 'wr-blocked-top');
      _chip(top, ev.kind, ev.substance ? 'wr-chip-' + ev.kind : 'wr-chip-idle');
      top.appendChild(_el('span', 'wr-span-ts', clockLabel(ev.ts)));
      if (ev.duration) top.appendChild(_el('span', 'wr-span-dur', fmtDuration(ev.duration)));
      row.appendChild(top);
      if (ev.payload_summary) row.appendChild(_el('div', 'wr-span-summary', ev.payload_summary));
      spansBody.appendChild(row);
    });
    box.appendChild(spansBody);
    body.appendChild(box);
  });
}

function _renderRecorderEvidence(body, evidence) {
  evidence = evidence || {};
  var envelopes = evidence.envelopes || [];
  var verdicts = evidence.gate_verdicts || [];
  var verify = evidence.verify_runs || [];
  var attest = evidence.attestations || [];
  if (!envelopes.length && !verdicts.length && !verify.length && !attest.length) {
    body.appendChild(_el('p', 'wr-empty', 'No contract evidence for this card.'));
    return;
  }

  if (envelopes.length) {
    var eHead = _el('div', 'wr-subhead');
    eHead.appendChild(_el('span', null, 'COMPLETION RECORDS'));
    eHead.appendChild(_el('span', 'wr-subhead-count', String(envelopes.length)));
    body.appendChild(eHead);
    envelopes.forEach(function(env) {
      var box = _el('div', 'wr-evidence wr-evidence-envelope');
      var p = env.payload || {};
      var top = _el('div', 'wr-blocked-top');
      _chip(top, 'envelope', 'wr-chip-kind');
      if (p.status) _chip(top, p.status, 'wr-chip-' + String(p.status).toLowerCase());
      top.appendChild(_el('span', 'wr-blocked-age', ageLabel(Math.max(0, Date.now() / 1000 - (env.created_at || 0)))));
      box.appendChild(top);
      if (p.summary) box.appendChild(_el('div', 'wr-evidence-line', p.summary));
      if (p.changed_files && p.changed_files.length) {
        box.appendChild(_el('div', 'wr-evidence-label', 'changed_files'));
        p.changed_files.forEach(function(f) { box.appendChild(_el('div', 'wr-evidence-mono', String(f))); });
      }
      if (p.artifacts && p.artifacts.length) {
        box.appendChild(_el('div', 'wr-evidence-label', 'artifacts'));
        p.artifacts.forEach(function(f) { box.appendChild(_el('div', 'wr-evidence-mono', String(f))); });
      }
      if (p.evidence_refs && p.evidence_refs.length) {
        box.appendChild(_el('div', 'wr-evidence-label', 'evidence_refs'));
        p.evidence_refs.forEach(function(f) { box.appendChild(_el('div', 'wr-evidence-mono', String(f))); });
      }
      if (p.notes_for_next) box.appendChild(_el('div', 'wr-evidence-note', 'note: ' + p.notes_for_next));
      body.appendChild(box);
    });
  }

  if (verdicts.length) {
    var vHead = _el('div', 'wr-subhead');
    vHead.appendChild(_el('span', null, 'REVIEW VERDICTS'));
    vHead.appendChild(_el('span', 'wr-subhead-count', String(verdicts.length)));
    body.appendChild(vHead);
    verdicts.forEach(function(g) {
      var box = _el('div', 'wr-evidence');
      var p = g.payload || {};
      var top = _el('div', 'wr-blocked-top');
      _chip(top, g.kind, 'wr-chip-kind');
      if (p.verdict) _chip(top, String(p.verdict), 'wr-chip-' + String(p.verdict).toLowerCase());
      if (p.mode) top.appendChild(_el('span', 'wr-span-ts', p.mode));
      box.appendChild(top);
      (p.reason_codes || []).forEach(function(rc) {
        box.appendChild(_el('div', 'wr-evidence-mono', String(rc)));
      });
      if (p.diff_matches_claims !== undefined) {
        box.appendChild(_el('div', 'wr-evidence-line',
          'diff_matches_claims: ' + String(p.diff_matches_claims)));
      }
      body.appendChild(box);
    });
  }

  if (verify.length) {
    var vfHead = _el('div', 'wr-subhead');
    vfHead.appendChild(_el('span', null, 'CHECK RUNS'));
    vfHead.appendChild(_el('span', 'wr-subhead-count', String(verify.length)));
    body.appendChild(vfHead);
    verify.forEach(function(v) {
      var box = _el('div', 'wr-evidence');
      var top = _el('div', 'wr-blocked-top');
      _chip(top, v.phase || 'verify', 'wr-chip-kind');
      var statusText = v.timed_out ? 'TIMED OUT' : (v.exit_code == null ? '?' : 'exit ' + v.exit_code);
      _chip(top, statusText, v.timed_out || v.exit_code !== 0 ? 'wr-chip-failed' : 'wr-chip-ok');
      box.appendChild(top);
      if (v.command) {
        var cmd = _el('div', 'wr-evidence-mono', v.command);
        cmd.style.cssText = 'overflow-wrap:anywhere;max-width:640px';
        box.appendChild(cmd);
      }
      if (v.output_tail) {
        var tail = _el('div', 'wr-evidence-note', _truncate(v.output_tail, 300));
        tail.title = v.output_tail;
        box.appendChild(tail);
      }
      body.appendChild(box);
    });
  }

  if (attest.length) {
    var aHead = _el('div', 'wr-subhead');
    aHead.appendChild(_el('span', null, 'SIGN-OFFS'));
    aHead.appendChild(_el('span', 'wr-subhead-count', String(attest.length)));
    body.appendChild(aHead);
    attest.forEach(function(a) {
      var box = _el('div', 'wr-evidence');
      var top = _el('div', 'wr-blocked-top');
      _chip(top, a.role || 'attest', 'wr-chip-lane');
      if (a.verdict) _chip(top, String(a.verdict), 'wr-chip-' + String(a.verdict).toLowerCase());
      if (a.reviewer_task_id) top.appendChild(_el('span', 'wr-span-ts', 'reviewer ' + a.reviewer_task_id));
      box.appendChild(top);
      body.appendChild(box);
    });
  }
}

function _renderRecorderLinks(body, links) {
  links = links || {};
  var parents = links.parents || [];
  var children = links.children || [];
  if (!parents.length && !children.length) {
    body.appendChild(_el('p', 'wr-empty', 'No parent/child links on this card.'));
    return;
  }
  if (parents.length) {
    var pHead = _el('div', 'wr-subhead');
    pHead.appendChild(_el('span', null, 'PARENTS'));
    pHead.appendChild(_el('span', 'wr-subhead-count', String(parents.length)));
    body.appendChild(pHead);
    parents.forEach(function(id) {
      var row = _el('div', 'wr-link-row');
      row.setAttribute('data-task', id);
      _wireCardClick(row, id);
      _chip(row, 'parent', 'wr-chip-kind');
      row.appendChild(_el('span', 'wr-link-id', id));
      body.appendChild(row);
    });
  }
  if (children.length) {
    var cHead = _el('div', 'wr-subhead');
    cHead.appendChild(_el('span', null, 'CHILDREN'));
    cHead.appendChild(_el('span', 'wr-subhead-count', String(children.length)));
    body.appendChild(cHead);
    children.forEach(function(id) {
      var row = _el('div', 'wr-link-row');
      row.setAttribute('data-task', id);
      _wireCardClick(row, id);
      _chip(row, 'child', 'wr-chip-kind');
      row.appendChild(_el('span', 'wr-link-id', id));
      body.appendChild(row);
    });
  }
}

function _renderRecorder(host, payload, error, lastUpdated) {
  host.replaceChildren();
  var page = _el('div', 'panel-page');
  var header = _el('div', 'page-header');
  var titleRow = _el('div', 'wr-title-row');
  var back = _el('button', 'wr-back', '\u2190 War Room');
  back.type = 'button';
  back.addEventListener('click', function() { _closeRecorder(); });
  titleRow.appendChild(back);
  titleRow.appendChild(_el('h2', 'page-title', 'Flight Recorder'));
  titleRow.appendChild(_el('span', 'wr-badge', 'VIEW ONLY'));
  header.appendChild(titleRow);
  if (payload && payload.card) {
    header.appendChild(_el('p', 'page-subtitle',
      payload.card.id + ' · ' + payload.card.title));
  }
  var statusLine = _el('div', 'wr-status');
  if (payload && payload.generated_at) {
    var updatedLabel = 'updated ' +
      ageLabel(Math.max(0, (lastUpdated || Date.now() / 1000) - payload.generated_at)) + ' ago';
    statusLine.appendChild(_el('span', null, updatedLabel));
  }
  if (payload) {
    var runs = payload.runs || [];
    var substanceTotal = runs.reduce(function(acc, r) { return acc + (r.substance_count || 0); }, 0);
    statusLine.appendChild(_el('span', null,
      String(runs.length) + ' runs · ' + substanceTotal + ' substance events'));
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
    retry.addEventListener('click', function() { _loadRecorder(); });
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
      'Unexpected response from /api/kanban/war-room/card — expected the read-only snapshot.'));
    content.appendChild(bad);
    page.appendChild(content);
    host.appendChild(page);
    return;
  }

  var t = _section('Run history', 'each dispatch, in order — click a run to expand its steps');
  _renderRecorderRuns(t.body, payload);
  content.appendChild(t.sec);

  var g = _section('Evidence', 'completion records · review verdicts · check runs · sign-offs');
  _renderRecorderEvidence(g.body, payload.evidence);
  content.appendChild(g.sec);

  var l = _section('LINKS', 'parent / child cards — click to jump');
  _renderRecorderLinks(l.body, payload.links);
  content.appendChild(l.sec);

  var refreshRow = _el('div', 'wr-refresh-row');
  var refresh = _el('button', 'panel-retry', 'Refresh');
  refresh.type = 'button';
  refresh.addEventListener('click', function() { _loadRecorder(); });
  refreshRow.appendChild(refresh);
  content.appendChild(refreshRow);

  page.appendChild(content);
  host.appendChild(page);
}

/** Fetch + render the recorder for the currently open card (gen-guarded). */
function _loadRecorder() {
  if (!_recorderTaskId || !_mounted) return;
  var gen = ++_gen;
  var opts = {};
  if (typeof AbortController === 'function') {
    _abort = new AbortController();
    opts.signal = _abort.signal;
  }
  _api('/api/kanban/war-room/card/' + encodeURIComponent(_recorderTaskId), opts)
    .then(function(payload) {
      if (gen !== _gen || !_mounted) return;
      _renderRecorder(_hostEl, payload, null, Date.now() / 1000);
    })
    .catch(function() {
      if (gen !== _gen || !_mounted) return;
      _renderRecorder(_hostEl, null,
        'Could not load the flight recorder — is the kanban bridge up?', null);
    });
}

/** Open the flight recorder for a card (sets #card= deep link). */
function _openRecorder(taskId) {
  if (!taskId || !_hostEl) return;
  _recorderTaskId = String(taskId);
  _setHash('#card=' + _recorderTaskId);
  _loadRecorder();
}

/** Close the recorder, clear the deep link, and re-render the board. */
function _closeRecorder() {
  if (!_recorderTaskId) return;
  _recorderTaskId = null;
  _setHash('');
  if (_mounted) _load(_hostEl);
}

/** Set window.location.hash; returns true when the hash actually changed. */
function _setHash(hash) {
  try {
    var w = _root();
    if (w.location && typeof w.location.hash === 'string') {
      if (w.location.hash === hash) return false;
      w.location.hash = hash;
      return true;
    }
  } catch (_) {}
  return false;
}

/**
 * Hash-driven deep link: open/close the recorder when #card changes.
 * Same-id hashchange is a no-op (the recorder is already open for it); an
 * empty hash closes back to the board. Both directions are idempotent.
 */
function _onHashChange() {
  try {
    var w = _root();
    var id = cardIdFromHash(w.location ? w.location.hash : '');
    if (id && id !== _recorderTaskId) {
      _recorderTaskId = id;
      _loadRecorder();
    } else if (!id && _recorderTaskId) {
      _recorderTaskId = null;
      if (_mounted) _load(_hostEl);
    }
  } catch (_) {}
}


/**
 * Programs — steering cards (DIRECT/GATE) and Promises merged into one
 * plain list of work programs. Only active programs in the body; finished
 * ones collapse under "recently finished". Budgets and relation IDs are
 * internal machinery — dropped from the visible surface.
 */
function _renderPrograms(body, directives, commitments) {
  var items = [];
  (directives || []).forEach(function(d) {
    items.push({
      id: d.id, kind: 'steering', title: d.title, owner: d.assignee,
      status: d.status,
      done: d.children ? d.children.done : 0, total: d.children ? d.children.total : 0,
      blocked: 0, clickable: true,
    });
  });
  if (commitments && commitments.available === true) {
    (commitments.items || []).forEach(function(c) {
      var t = c.tasks || {};
      items.push({
        id: null, kind: 'promise', title: c.title, owner: c.owner,
        status: c.status,
        done: t.done || 0, total: t.total || 0, blocked: t.blocked || 0,
        clickable: false,
      });
    });
  }
  if (!items.length) {
    body.appendChild(_el('p', 'wr-empty', 'No programs yet.'));
    return;
  }
  var active = items.filter(function(it) { return it.status !== 'done'; });
  var finished = items.filter(function(it) { return it.status === 'done'; });

  active.forEach(function(it) { _renderProgramRow(body, it, false); });

  if (finished.length) {
    var subhead = _el('div', 'wr-subhead');
    subhead.appendChild(_el('span', null, 'Recently finished'));
    subhead.appendChild(_el('span', 'wr-subhead-count', String(finished.length)));
    body.appendChild(subhead);
    finished.forEach(function(it) { _renderProgramRow(body, it, true); });
  }
}

function _renderProgramRow(body, it, isDone) {
  var row = _el('div', 'wr-program' + (isDone ? ' wr-done' : ''));
  if (it.clickable && it.id) {
    row.setAttribute('data-task', it.id);
    _wireCardClick(row, it.id);
  }
  var top = _el('div', 'wr-blocked-top');
  _chip(top, _plainStatus(it.status) || '?', 'wr-chip-' + (it.status || 'todo'));
  if (it.owner) _chip(top, it.owner, 'wr-chip-lane');
  row.appendChild(top);
  row.appendChild(_el('div', 'wr-program-title', it.title));
  if (it.total > 0) {
    var pct = Math.round((it.done / it.total) * 100);
    var bar = _el('div', 'wr-bar');
    var fill = _el('div', 'wr-bar-fill');
    fill.style.width = pct + '%';
    bar.appendChild(fill);
    row.appendChild(bar);
    var meta = _el('div', 'wr-directive-meta');
    meta.appendChild(_el('span', null, 'cards ' + it.done + '/' + it.total + ' done'));
    if (it.blocked > 0) meta.appendChild(_el('span', null, it.blocked + ' stuck'));
    row.appendChild(meta);
  } else {
    row.appendChild(_el('div', 'wr-directive-meta', 'no linked cards yet'));
  }
  body.appendChild(row);
}

function _render(host, payload, error, lastUpdated, presenceItems) {
  host.replaceChildren();
  var page = _el('div', 'panel-page');
  var header = _el('div', 'page-header');
  var titleRow = _el('div', 'wr-title-row');
  titleRow.appendChild(_el('h2', 'page-title', 'War Room'));
  var badge = _el('span', 'wr-badge', 'VIEW ONLY');
  titleRow.appendChild(badge);
  header.appendChild(titleRow);
  header.appendChild(_el('p', 'page-subtitle',
    'One glance at the flow — who is working, what is stuck, what needs you. View only · updates every 30s.'));
  _renderPulse(header, payload, lastUpdated);
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

  var w = _section('Where everyone is', 'one row per sister — now, working on, waiting, stuck');
  _renderWhere(w.body, payload.floor, presenceItems);
  content.appendChild(w.sec);

  var n = _section('Needs you', 'waiting on you — answer on Discord or the board');
  _renderNeedsYou(n.body, payload.josh_asks);
  content.appendChild(n.sec);

  var a = _section('Recent activity', 'completions · blocks · review verdicts — tool chatter hidden');
  var feedToggle = _renderRecentActivity(a.body, payload.substance_feed);
  if (feedToggle) a.head.appendChild(feedToggle);
  content.appendChild(a.sec);

  var p = _section('Programs', 'active work — cards N/M done');
  _renderPrograms(p.body, payload.directives, payload.commitments);
  content.appendChild(p.sec);

  var q = _section('QA queue', 'review backlog, plain and simple');
  _renderQaQueue(q.body, payload.gate_queue);
  content.appendChild(q.sec);

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
 * Registers the hashchange deep-link (#card=t_xxx) listener once per mount;
 * while the flight recorder is open the interval skips the board re-render
 * (no polling storm) — the recorder refreshes on open + manual Refresh.
 */
function mount(idOrEl) {
  var host = _host(idOrEl);
  if (!host) return;
  _hostEl = host;
  if (!_mounted) {
    try {
      _root().addEventListener('hashchange', _onHashChange);
    } catch (_) {}
  }
  if (_mounted) {
    if (_recorderTaskId) _loadRecorder();
    else _load(host);
    return;
  }
  _mounted = true;
  _load(host);
  var initial = cardIdFromHash(_root().location ? _root().location.hash : '');
  if (initial) {
    _recorderTaskId = initial;
    _loadRecorder();
  }
  if (!_timer) {
    _timer = setInterval(function() {
      if (!_mounted) return;
      if (_recorderTaskId) return; // recorder open — skip board re-render
      _load(host);
    }, REFRESH_MS);
  }
}

/** Unmount: stop the timer, abort in-flight work, clear the host. */
function unmount(idOrEl) {
  _gen++;
  _mounted = false;
  _recorderTaskId = null;
  try {
    _root().removeEventListener('hashchange', _onHashChange);
  } catch (_) {}
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

export { mount, unmount, ageLabel, feedDetail, laneSummary, presenceActivityLabel, presenceFreshness, fmtDuration, clockLabel, cardIdFromHash };
