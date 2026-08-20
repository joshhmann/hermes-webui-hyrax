#!/usr/bin/env node
/**
 * Execution-level Node harness for the Hyrax War Room controller (warroom.js).
 *
 * Loads the PRODUCTION warroom.js ES module against a minimal fake DOM /
 * api / timer environment and proves the War Room contracts:
 *
 *   - pure helpers: ageLabel boundaries, feedDetail mapping, laneSummary
 *   - mount renders all five sections (WHERE EVERYONE IS / NEEDS YOU /
 *     RECENT ACTIVITY / PROGRAMS / QA QUEUE) plus the header pulse line
 *     from a mocked read-only payload
 *   - plain-language contract (Rei QA review): visible labels are plain
 *     words (working / stuck / waiting / need you / programs / view only);
 *     Promise budgets and relation IDs are dropped; progress telemetry is
 *     hidden by default and revealed by the feed toggle
 *   - stale (>24h) blocked cards get .wr-stale; fresh ones do not
 *   - exactly ONE 30s refresh interval is armed; re-mount does not duplicate
 *     it; unmount clears it and empties the host
 *   - api failure renders the inline error + Retry (visible, not silent);
 *     a non-read-only payload is rejected with an error box
 *   - flight recorder: clicking any card row opens the per-card trace
 *     waterfall; runs are expandable; heartbeats render as cadence; evidence
 *     pane shows envelopes / verdicts / verify runs / attestations; empty
 *     state for a never-run card; deep link #card=t_xxx opens on mount;
 *     back returns to the board
 *
 * Usage:  node tests/run_hyrax_warroom_tests.js
 * Exit code: 0 = all pass, 1 = any failure.
 */
'use strict';

const path = require('path');

const REPO = path.join(__dirname, '..');
const HYRAX = path.join(REPO, 'static', 'hyrax');

let passed = 0;
let failed = 0;
const failures = [];

function assert(ok, msg) {
  if (ok) { passed++; return; }
  failed++;
  const e = new Error();
  const stack = (e.stack || '').split('\n').slice(2, 4).join(' → ').trim();
  failures.push(`${msg}  [${stack || '?'}]`);
}

function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) { passed++; return; }
  failed++;
  const e = new Error();
  const stack = (e.stack || '').split('\n').slice(2, 4).join(' → ').trim();
  failures.push(`${msg} — expected ${b}, got ${a}  [${stack || '?'}]`);
}

async function tick(n = 5) {
  for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r));
}

// ── Fake browser environment ─────────────────────────────────────────────
globalThis.window = globalThis;
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'node-harness', language: 'en', onLine: true },
    configurable: true,
  });
} catch (_) { /* leave existing navigator */ }

// setInterval / clearInterval spies (do NOT arm real timers — the harness
// drives refresh ticks manually so the process can exit cleanly).
const intervalCalls = [];
const clearedIntervals = [];
let _fakeTimerId = 1;
globalThis.setInterval = function(fn, ms) {
  const id = _fakeTimerId++;
  intervalCalls.push({ id, fn, ms });
  return id;
};
globalThis.clearInterval = function(id) {
  clearedIntervals.push(id);
  return id;
};

// location + hashchange spy for the #card= deep link.
globalThis.location = { hash: '' };
const winListeners = {};
globalThis.addEventListener = function(type, fn) {
  (winListeners[type] = winListeners[type] || []).push(fn);
};
globalThis.removeEventListener = function(type, fn) {
  const arr = winListeners[type] || [];
  const i = arr.indexOf(fn);
  if (i !== -1) arr.splice(i, 1);
};

function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    className: '',
    style: {},
    hidden: false,
    disabled: false,
    _children: [],
    _attrs: {},
    _listeners: {},
    dataset: {},
    title: '',
    setAttribute(k, v) { this._attrs[k] = String(v); if (k.startsWith('data-')) this.dataset[k.slice(5)] = String(v); },
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
    addEventListener(ev, fn) {
      if (!this._listeners[ev]) this._listeners[ev] = [];
      if (this._listeners[ev].indexOf(fn) === -1) this._listeners[ev].push(fn);
    },
    dispatchEvent(ev) {
      ev.target = el;
      (this._listeners[ev.type] || []).slice().forEach(fn => { try { fn(ev); } catch (_) {} });
      return true;
    },
    appendChild(c) { if (c) this._children.push(c); return c; },
    append(...children) { children.forEach(c => { if (c != null) this._children.push(c); }); return el; },
    replaceChildren(...children) { this._children = children.filter(Boolean); },
    remove() { el._removed = true; },
    focus() {},
    click() {
      const ev = { type: 'click', target: el, preventDefault() {}, stopPropagation() {}, key: '' };
      (this._listeners.click || []).slice().forEach(fn => { try { fn(ev); } catch (_) {} });
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  el.classList = {
    add(...names) {
      names.forEach(n => { if (!String(el.className || '').split(/\s+/).includes(n)) el.className = (el.className ? el.className + ' ' : '') + n; });
    },
    remove(...names) {
      el.className = String(el.className || '').split(/\s+/).filter(c => c && !names.includes(c)).join(' ');
    },
    toggle(name, force) {
      const has = String(el.className || '').split(/\s+/).includes(name);
      const want = force === undefined ? !has : !!force;
      if (want && !has) el.classList.add(name);
      if (!want && has) el.classList.remove(name);
      return want;
    },
    contains(name) { return String(el.className || '').split(/\s+/).includes(name); },
  };
  Object.defineProperty(el, 'textContent', {
    get() {
      if (el._text !== undefined) return el._text;
      // Real-DOM semantics: parent text = concatenation of children's text.
      return (el._children || []).map(c => (c && c.textContent) || '').join('');
    },
    set(v) { el._text = String(v); el._children = []; },
  });
  Object.defineProperty(el, 'innerHTML', {
    get() { return ''; },
    set(v) { if (v === '') el._children = []; },
  });
  return el;
}

function findByClass(root, cls) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const el = stack.pop();
    if (!el) continue;
    if (el._children) {
      for (let i = el._children.length - 1; i >= 0; i--) stack.push(el._children[i]);
    }
    if (String(el.className || '').split(/\s+/).includes(cls)) out.push(el);
  }
  return out;
}

const hostEl = makeEl('div');
hostEl._attrs.id = 'mainWarRoom';
hostEl.className = 'main-view';

const fakeDoc = {
  readyState: 'complete',
  body: makeEl('body'),
  head: { appendChild() {}, querySelector() { return null; } },
  createElement: makeEl,
  createTextNode(t) { return { textContent: String(t), nodeType: 3 }; },
  getElementById(id) { return id === 'mainWarRoom' ? hostEl : null; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() { return true; },
};
globalThis.document = fakeDoc;

// ── api fake with a realistic read-only snapshot ─────────────────────────
const apiCalls = [];
let apiMode = 'ok'; // 'ok' | 'fail' | 'nonreadonly'
// generated_at is ~90s before "now" so the updated-stamp assertions see a
// sane delta (the epoch-as-duration bug would render weeks).
const NOW = Math.floor(Date.now() / 1000);
const SNAPSHOT = {
  read_only: true,
  generated_at: NOW - 90,
  directives: [
    { id: 't_direct', title: 'DIRECT: Bot control plane initiative', status: 'todo',
      assignee: 'aya', age_seconds: 3600,
      children: { done: 1, total: 3 }, current_stage: 'running' },
    { id: 't_done_d', title: 'DIRECT: finished initiative', status: 'done',
      assignee: 'rei', age_seconds: 90000,
      children: { done: 2, total: 2 }, current_stage: 'complete' },
  ],
  floor: {
    lanes: [
      { lane: 'tai', counts: { running: 1, blocked: 2, todo: 1, ready: 1, review: 0, done: 10 } },
      { lane: 'rei', counts: { running: 0, blocked: 0, todo: 1, ready: 1, review: 0, done: 9 } },
      { lane: 'nei', counts: { running: 0, blocked: 1, todo: 1, ready: 0, review: 0, done: 8 } },
      { lane: 'mai', counts: { running: 0, blocked: 1, todo: 0, ready: 0, review: 0, done: 7 } },
      { lane: 'aya', counts: { running: 0, blocked: 0, todo: 0, ready: 0, review: 0, done: 6 } },
      { lane: 'other', counts: { running: 0, blocked: 0, todo: 1, ready: 0, review: 0, done: 5 } },
    ],
    blocked: [
      { id: 't_old', title: 'Parked: Josh returns', assignee: 'mai', lane: 'mai',
        age_seconds: 25 * 3600, stale: true, block_kind: 'needs_input',
        reason: 'Parked: Josh returns Tue 8/11' },
      { id: 't_fresh', title: 'Envelope decision', assignee: 'nei', lane: 'nei',
        age_seconds: 3600, stale: false, block_kind: 'needs_input',
        reason: 'Josh decision required: approve envelope' },
    ],
  },
  gate_queue: {
    depth: 3,
    high_mark: 8,
    over: false,
    review_gates: [
      { id: 't_g1', title: 'REI GATE: control-plane API contract surface', status: 'todo', age_seconds: 7200 },
      { id: 't_g2', title: 'Rei gate: shadow hook wiring', status: 'ready', age_seconds: 5400 },
    ],
    review_blocks: [
      { id: 't_rb', title: 'review-required block', assignee: 'tai', status: 'blocked', age_seconds: 9000, reason: 'review-required: shipped' },
    ],
    mechanical: [
      { id: 't_yui', title: 'TRIAL GATE (Yui): mechanical rerun', status: 'blocked', age_seconds: 1800 },
    ],
  },
  substance_feed: [
    { id: 10, kind: 'blocked', task_id: 't_yui', title: 'TRIAL GATE (Yui): mechanical rerun',
      payload: { reason: 'mechanical gate awaiting runner' }, created_at: NOW - 1000, age_seconds: 1000 },
    { id: 9, kind: 'completed', task_id: 't_c1', title: 'child one',
      payload: { summary: 'REI GATE ACCEPT — verified independently' }, created_at: NOW - 1500, age_seconds: 1500 },
    { id: 8, kind: 'progress', task_id: 't_c2', title: 'child two',
      payload: { tool: 'patch', artifact: 'x.py', delta: 'patched' }, created_at: NOW - 2000, age_seconds: 2000 },
  ],
  josh_asks: [
    { id: 't_old', title: 'Parked: Josh returns', assignee: 'mai',
      age_seconds: 25 * 3600, block_kind: 'needs_input', reason: 'Parked: Josh returns Tue 8/11' },
  ],
  commitments: {
    available: true,
    items: [{
      id: 'p_1', title: 'Verified economic exit', owner: 'josh', status: 'blocked',
      tasks: { done: 1, total: 3, blocked: 1 },
      budgets: { attempts: { used: 2, max: 8 }, llm_calls: { used: 4, max: 12 } },
      pending_notifications: 1,
      relations: [{ type: 'depends_on', target_id: 'p_0' }],
    }],
  },
};

// Flight-recorder fixture: two runs (crashed + completed), heartbeat cadence,
// card-level event, envelope, gate verdict, verify runs, attestations, links.
const CARD_PAYLOAD = {
  read_only: true,
  generated_at: NOW - 5,
  card: { id: 't_heavy', title: '6h soak: bot run', status: 'done', assignee: 'tai', created_at: NOW - 22000 },
  runs: [
    {
      id: 1573, profile: 'tai', status: 'crashed', outcome: 'crashed',
      started_at: NOW - 3000, ended_at: NOW - 2900, last_heartbeat_at: NOW - 2910,
      summary: null, error: 'worker crashed',
      spans: [
        { kind: 'claimed', ts: NOW - 3000, duration: 0, payload_summary: '', substance: false },
        { kind: 'spawned', ts: NOW - 3000, duration: 90, payload_summary: '', substance: false },
        { kind: 'crashed', ts: NOW - 2910, duration: 0, payload_summary: '', substance: true },
      ],
      heartbeat: { count: 10, first: NOW - 2990, last: NOW - 2910 },
      substance_count: 1,
      idle_count: 10,
    },
    {
      id: 1669, profile: 'tai', status: 'done', outcome: 'completed',
      started_at: NOW - 2000, ended_at: NOW - 100, last_heartbeat_at: NOW - 150,
      summary: 'soak COMPLETED full window', error: null,
      spans: [
        { kind: 'claimed', ts: NOW - 2000, duration: 0, payload_summary: '', substance: false },
        { kind: 'spawned', ts: NOW - 2000, duration: 5, payload_summary: '', substance: false },
        { kind: 'progress', ts: NOW - 1995, duration: 1850, payload_summary: 'terminal → build/soak.sh', substance: true },
        { kind: 'completed', ts: NOW - 145, duration: 45, payload_summary: 'soak COMPLETED full window', substance: true },
      ],
      heartbeat: { count: 43, first: NOW - 1980, last: NOW - 160 },
      substance_count: 2,
      idle_count: 43,
    },
  ],
  card_events: [
    { kind: 'created', ts: NOW - 22000, duration: 19000, payload_summary: 'status: ready', substance: true },
  ],
  evidence: {
    envelopes: [{
      id: 901, run_id: 1669, created_at: NOW - 140,
      payload: {
        schema_version: 1, status: 'done', summary: 'soak completed',
        changed_files: ['scripts/soak.sh'], artifacts: ['build/soak.log'],
        evidence_refs: ['evidence-abc'], notes_for_next: 'retry flag still missing',
      },
    }],
    gate_verdicts: [{
      id: 900, run_id: 1669, kind: 'contract_completion_evaluated', created_at: NOW - 130,
      payload: { verdict: 'pass', mode: 'enforce', reason_codes: [], diff_matches_claims: true },
    }],
    verify_runs: [
      { id: 1, run_id: 1669, phase: 'baseline', command: 'bash verify_suite.sh {workspace}', expect_exit: 0, exit_code: 0, timed_out: false, output_tail: 'all green', started_at: NOW - 100 },
      { id: 2, run_id: 1573, phase: 'verify', command: 'node --check x.js', expect_exit: 0, exit_code: 1, timed_out: false, output_tail: 'SyntaxError', started_at: NOW - 2900 },
    ],
    attestations: [
      { attestation_id: 'att-1', role: 'reviewer:rei', verdict: 'pass', created_at: NOW - 90, reviewer_task_id: 't_gate1', reviewer_run_id: 1700 },
    ],
  },
  links: { parents: ['t_epic'], children: ['t_child1', 't_child2'] },
};

// Zero-run card: the empty state the recorder must handle gracefully.
const CARD_EMPTY = {
  read_only: true,
  generated_at: NOW,
  card: { id: 't_fresh', title: 'Never dispatched', status: 'todo', assignee: null, created_at: NOW - 50 },
  runs: [],
  card_events: [],
  evidence: { envelopes: [], gate_verdicts: [], verify_runs: [], attestations: [] },
  links: { parents: [], children: [] },
};

function fakeApi(url, opts = {}) {
  apiCalls.push({ url, method: opts.method || 'GET' });
  if (apiMode === 'fail') return Promise.reject(new Error('boom'));
  if (apiMode === 'nonreadonly') {
    return Promise.resolve(Object.assign({}, SNAPSHOT, { read_only: false }));
  }
  if (url.indexOf('/api/kanban/war-room/card/') === 0) {
    const id = url.slice('/api/kanban/war-room/card/'.length);
    return Promise.resolve(id === 't_fresh' ? CARD_EMPTY : CARD_PAYLOAD);
  }
  if (url === '/api/hyrax/presence') {
    return Promise.resolve({
      items: [
        { operatorId: 'tai', available: true,
          activity: { type: 'tool-working' }, expression: { current: 'calm' },
          currentTask: { id: 't_tai', title: 'DIRECT-4 · Three-surface tie-in — doctrine + war-room/VN presence' },
          derivedState: { fresh: true, staleness_days: 0 } },
        { operatorId: 'rei', available: true,
          activity: { type: 'waiting-approval' }, expression: { current: 'neutral' },
          currentTask: { id: 't_rei', title: 'REI GATE: control-plane API contract surface' },
          derivedState: { fresh: true, staleness_days: 0 } },
        { operatorId: 'nei', available: true,
          activity: { type: 'idle' }, expression: { current: 'neutral' },
          currentTask: null,
          derivedState: { fresh: false, staleness_days: 2 } },
        { operatorId: 'mai', available: true,
          activity: { type: 'conversing' }, expression: { current: 'light-smile' },
          currentTask: null,
          derivedState: { fresh: true, staleness_days: 0 } },
        { operatorId: 'aya', available: false,
          activity: { type: 'offline' }, expression: { current: 'neutral' },
          currentTask: null, derivedState: null },
      ],
      meta: { generatedAt: new Date().toISOString() },
    });
  }
  return Promise.resolve(SNAPSHOT);
}
globalThis.api = fakeApi;
globalThis.showToast = () => {};
globalThis.AbortController = typeof AbortController === 'function' ? AbortController : undefined;

function resetHarness() {
  apiCalls.length = 0;
  intervalCalls.length = 0;
  clearedIntervals.length = 0;
  apiMode = 'ok';
  globalThis.location = { hash: '' };
  hostEl.replaceChildren();
  hostEl._children = [];
}

function fireHashChange(hash) {
  globalThis.location = { hash };
  (winListeners.hashchange || []).slice().forEach(fn => { try { fn({ type: 'hashchange' }); } catch (_) {} });
}

// ══════════════════════════════════════════════════════════════════════
// 1. Pure helpers
// ══════════════════════════════════════════════════════════════════════
async function testHelpers(wr) {
  assertEqual(wr.ageLabel(30), 'now', 'ageLabel: <60s → now');
  assertEqual(wr.ageLabel(90), '1m', 'ageLabel: minutes');
  assertEqual(wr.ageLabel(7200), '2h', 'ageLabel: hours');
  assertEqual(wr.ageLabel(90000), '1d', 'ageLabel: days');
  assertEqual(wr.ageLabel(7 * 86400), '1w', 'ageLabel: weeks');
  assertEqual(wr.ageLabel(null), '', 'ageLabel: null → empty');
  assertEqual(wr.ageLabel(undefined), '', 'ageLabel: undefined → empty');

  assertEqual(wr.feedDetail('completed', { summary: 'done' }), 'done', 'feedDetail: completed → summary');
  assertEqual(wr.feedDetail('blocked', { reason: 'why' }), 'why', 'feedDetail: blocked → reason');
  assertEqual(wr.feedDetail('progress', { tool: 'patch', artifact: 'x.py' }), 'patch → x.py', 'feedDetail: progress → tool → artifact');
  assertEqual(wr.feedDetail('heartbeat', { n: 1 }), '', 'feedDetail: unknown/other → empty');

  assertEqual(wr.laneSummary({ running: 1, blocked: 2, todo: 1, ready: 3 }),
    { running: 1, blocked: 2, queued: 4 }, 'laneSummary: queued = todo + ready');
  assertEqual(wr.laneSummary(null), { running: 0, blocked: 0, queued: 0 }, 'laneSummary: null-safe');

  // Recorder helpers
  assertEqual(wr.fmtDuration(5), '5s', 'fmtDuration: seconds');
  assertEqual(wr.fmtDuration(90), '2m', 'fmtDuration: minutes');
  assertEqual(wr.fmtDuration(7200), '2h', 'fmtDuration: hours');
  assertEqual(wr.fmtDuration(2 * 86400), '2d', 'fmtDuration: days');
  assertEqual(wr.fmtDuration(null), '', 'fmtDuration: null → empty');
  assertEqual(wr.fmtDuration(0), '', 'fmtDuration: zero → empty');
  assertEqual(wr.cardIdFromHash('#card=t_abc123'), 't_abc123', 'cardIdFromHash: extracts id');
  assertEqual(wr.cardIdFromHash('#session=x'), null, 'cardIdFromHash: non-card hash → null');
  assertEqual(wr.cardIdFromHash(''), null, 'cardIdFromHash: empty → null');
  assertEqual(wr.cardIdFromHash(null), null, 'cardIdFromHash: null → null');
  assert(typeof wr.clockLabel(0) === 'string' && wr.clockLabel(0).length === 8,
    'clockLabel: HH:MM:SS shape');
}

// ══════════════════════════════════════════════════════════════════════
// 2. Mount renders the six sections from the read-only snapshot
// ══════════════════════════════════════════════════════════════════════
async function testMount(wr) {
  resetHarness();
  await wr.mount('war-room');
  await tick(6); // fetch resolves

  const sections = findByClass(hostEl, 'wr-section');
  assertEqual(sections.length, 5, 'mount renders exactly five sections');

  // 0. Header — plain-language chrome + pulse line
  const badge = findByClass(hostEl, 'wr-badge');
  assertEqual(badge.length, 1, 'view-only badge rendered');
  assert(badge[0] && badge[0].textContent.indexOf('VIEW ONLY') !== -1,
    'badge reads VIEW ONLY (plain, not READ-ONLY)');
  const subtitle = findByClass(hostEl, 'page-subtitle');
  assert(subtitle.length && subtitle[0].textContent.indexOf('View only') !== -1,
    'subtitle uses plain language (no factory-floor jargon)');
  const pulseCells = findByClass(hostEl, 'wr-pulse-cell');
  assertEqual(pulseCells.length, 4, 'pulse line has four numbers');
  assertEqual(pulseCells.map(c => c.textContent),
    ['1working', '4stuck', '6waiting', '1need you'],
    'pulse numbers: 1 working · 4 stuck · 6 waiting · 1 need you');
  const pulseText = hostEl.textContent || '';
  assert(/updated (\d+)(s|m|h) ago/.test(pulseText),
    'pulse carries a sane relative updated stamp (delta, not epoch)');
  assert(pulseText.indexOf('2954w') === -1,
    'updated stamp is NOT the epoch-as-duration bug');
  assert(pulseText.indexOf('gate depth') === -1 && pulseText.indexOf('HIGH') === -1,
    'no gate-depth gauge chrome in the header');

  // 1. WHERE EVERYONE IS — ledger table (one row per sister) + stuck list
  const ledgerRows = findByClass(hostEl, 'wr-ledger-row');
  assertEqual(ledgerRows.length, 6, 'ledger table has six rows (5 sisters + other)');
  const ledgerTexts = ledgerRows.map(r => r.textContent || '');
  assert(ledgerTexts.some(t => t.indexOf('tai') !== -1 && t.indexOf('working') !== -1),
    'tai row: now = working');
  assert(ledgerTexts.some(t => t.indexOf('DIRECT-4') !== -1),
    'tai row: working-on shows the current task title');
  assert(ledgerTexts.some(t => t.indexOf('REI GATE: control-plane') !== -1),
    'rei row: current task title surfaces in the table');
  assert(ledgerTexts.some(t => t.indexOf('needs approval') !== -1),
    'rei row: now = needs approval');
  assert(ledgerTexts.some(t => t.indexOf('offline') !== -1),
    'aya row: now = offline');
  assert(ledgerTexts.some(t => t.indexOf('idle · stale 2d') !== -1),
    'nei row: staleness flagged, not "live" noise');
  assert(ledgerTexts.some(t => t.indexOf('1 · 1h') !== -1),
    'stuck column shows count + age (nei: 1 · 1h)');

  const blockedRows = findByClass(hostEl, 'wr-blocked');
  assertEqual(blockedRows.length, 2, 'both stuck cards listed');
  const staleAll = blockedRows.filter(r => String(r.className || '').split(/\s+/).includes('wr-stale'));
  assertEqual(staleAll.length, 1, 'exactly one stuck card highlighted stale (>24h)');
  const staleTag = findByClass(hostEl, 'wr-stale-tag');
  assertEqual(staleTag.length, 1, 'stuck 24h+ tag rendered on the old block');
  assert(staleTag[0] && staleTag[0].textContent.indexOf('stuck 24h+') !== -1,
    'stale tag text is plain language');
  const reasonTexts = blockedRows.map(r => r.textContent || '');
  assert(reasonTexts.some(t => t.indexOf('Josh decision required') !== -1),
    'stuck reason text rendered');

  // 2. NEEDS YOU
  const asks = findByClass(hostEl, 'wr-ask');
  assertEqual(asks.length, 1, 'needs-you row rendered');
  assert(asks[0] && asks[0].textContent.indexOf('view only') !== -1,
    'needs-you row notes view-only answering');

  // 3. RECENT ACTIVITY — progress telemetry hidden by default
  const feedRows = findByClass(hostEl, 'wr-feed-row');
  assertEqual(feedRows.length, 2, 'feed shows substance rows only (progress hidden)');
  const feedTexts = feedRows.map(r => r.textContent || '');
  assert(feedTexts.some(t => t.indexOf('REI GATE ACCEPT') !== -1), 'completion verdict text rendered');
  assert(feedTexts.some(t => t.indexOf('finished') !== -1), 'kind chip reads plain "finished"');
  assert(!feedTexts.some(t => t.indexOf('patch → x.py') !== -1),
    'tool-progress telemetry hidden by default');
  const toggle = findByClass(hostEl, 'wr-feed-toggle');
  assertEqual(toggle.length, 1, 'feed has a show-tool-activity toggle');
  toggle[0].click();
  const feedRowsShown = findByClass(hostEl, 'wr-feed-row');
  assertEqual(feedRowsShown.length, 3, 'toggle reveals progress rows');
  assert(feedRowsShown.some(r => (r.textContent || '').indexOf('patch → x.py') !== -1),
    'progress row shows tool → artifact detail');
  toggle[0].click(); // reset to default for later tests
  assertEqual(findByClass(hostEl, 'wr-feed-row').length, 2, 'toggle hides progress rows again');

  // 4. PROGRAMS — steering cards + Promises merged, budgets dropped
  const programs = findByClass(hostEl, 'wr-program');
  assertEqual(programs.length, 3, 'program rows: 2 active + 1 recently finished');
  const programTexts = programs.map(r => r.textContent || '');
  assert(programTexts.some(t => t.indexOf('DIRECT: Bot control plane initiative') !== -1),
    'steering card rendered as a program');
  assert(programTexts.some(t => t.indexOf('cards 1/3 done') !== -1),
    'child-chain progress reads cards N/M done');
  assert(programTexts.some(t => t.indexOf('Verified economic exit') !== -1),
    'Promise rendered as a program');
  const doneProgram = programs.filter(r => String(r.className || '').split(/\s+/).includes('wr-done'));
  assertEqual(doneProgram.length, 1, 'finished program dimmed with .wr-done');
  assert(doneProgram[0] && doneProgram[0].textContent.indexOf('DIRECT: finished initiative') !== -1,
    'recently finished program listed under the collapsed group');
  const pageText = hostEl.textContent || '';
  assert(pageText.indexOf('Recently finished') !== -1, 'recently finished subhead rendered');
  assert(pageText.indexOf('LLM calls') === -1 && pageText.indexOf('tokens') === -1,
    'Promise budgets dropped from the visible surface');
  assert(pageText.indexOf('depends_on') === -1 && pageText.indexOf('p_0') === -1,
    'Promise relation IDs dropped from the visible surface');

  // 5. QA QUEUE — one plain line, no gauge
  const qaLines = findByClass(hostEl, 'wr-qa-line');
  assertEqual(qaLines.length, 1, 'qa queue is a single line');
  assert(qaLines[0].textContent.indexOf('QA queue: 3 waiting') !== -1,
    'qa line reads "QA queue: 3 waiting"');
  const qaSub = findByClass(hostEl, 'wr-qa-sub');
  assert(qaSub.length && qaSub[0].textContent.indexOf('auto-checks: 1 waiting') !== -1,
    'auto-checks collapsed to one line');
  assertEqual(findByClass(hostEl, 'wr-gauge').length, 0, 'no gauge anywhere');

  // Card rows are clickable into the flight recorder.
  const clickable = findByClass(hostEl, 'wr-clickable');
  assert(clickable.length >= 4,
    'stuck/needs-you/feed/program rows carry the wr-clickable recorder affordance');

  // Single fetch pair on mount: board snapshot + presence (same cycle).
  assertEqual(apiCalls.filter(c => c.url === '/api/kanban/war-room').length, 1,
    'mount fetches the war-room endpoint exactly once');
  assertEqual(apiCalls.filter(c => c.url === '/api/hyrax/presence').length, 1,
    'mount fetches the presence endpoint exactly once (shared presence state)');

  // Interval: exactly one, 30s
  assertEqual(intervalCalls.length, 1, 'exactly one refresh interval armed');
  assertEqual(intervalCalls[0].ms, 30 * 1000, 'interval is 30s');

  // Leave the module unmounted so the next test starts clean.
  wr.unmount('war-room');
}

// ══════════════════════════════════════════════════════════════════════
// 3. Refresh tick + idempotent re-mount + unmount cleanup
// ══════════════════════════════════════════════════════════════════════
async function testLifecycle(wr) {
  resetHarness();
  await wr.mount('war-room');
  await tick(6);
  assertEqual(apiCalls.length, 2, 'baseline: board + presence fetches');

  // Simulate a 30s tick: the interval callback re-fetches and re-renders.
  intervalCalls[0].fn();
  await tick(6);
  assertEqual(apiCalls.length, 4, 'refresh tick re-fetches the snapshot pair');
  assertEqual(findByClass(hostEl, 'wr-section').length, 5,
    'refresh re-renders five sections (no duplicates)');
  assertEqual(findByClass(hostEl, 'wr-ledger-row').length, 6,
    'refresh re-renders the ledger table (no duplicates)');

  // Idempotent re-mount: no extra interval, no duplicate DOM.
  await wr.mount('war-room');
  await tick(6);
  assertEqual(intervalCalls.length, 1, 're-mount does not arm a second interval');
  assertEqual(findByClass(hostEl, 'wr-section').length, 5,
    're-mount does not duplicate sections');

  // Unmount: clears the interval and empties the host.
  wr.unmount('war-room');
  assertEqual(clearedIntervals.length, 1, 'unmount clears the refresh interval');
  assertEqual(clearedIntervals[0], intervalCalls[0].id, 'clears the exact interval id');
  assertEqual(hostEl._children.length, 0, 'unmount empties the host');

  // Double unmount is safe.
  wr.unmount('war-room');
  assert(true, 'double unmount is safe');

  // Re-mount after unmount works (fresh generation).
  await wr.mount('war-room');
  await tick(6);
  assertEqual(findByClass(hostEl, 'wr-section').length, 5, 're-mount after unmount renders again');
  wr.unmount('war-room');
}

// ══════════════════════════════════════════════════════════════════════
// 4. Error paths: fetch failure and non-read-only payload
// ══════════════════════════════════════════════════════════════════════
async function testErrors(wr) {
  resetHarness();
  apiMode = 'fail';
  await wr.mount('war-room');
  await tick(6);
  const errBox = findByClass(hostEl, 'panel-error');
  assertEqual(errBox.length, 1, 'fetch failure renders the inline error box');
  const retry = findByClass(hostEl, 'panel-retry');
  assertEqual(retry.length, 1, 'error box carries a Retry button');

  // Retry recovers when the API comes back.
  apiMode = 'ok';
  retry[0].click();
  await tick(6);
  assertEqual(findByClass(hostEl, 'wr-section').length, 5, 'retry recovers and renders the board');
  wr.unmount('war-room');

  resetHarness();
  apiMode = 'nonreadonly';
  await wr.mount('war-room');
  await tick(6);
  const bad = findByClass(hostEl, 'panel-error');
  assertEqual(bad.length, 1, 'non-read-only payload is rejected with an error box');
  assert(bad[0].textContent.indexOf('read-only') !== -1, 'error names the read-only contract');
  assertEqual(findByClass(hostEl, 'wr-section').length, 0,
    'non-read-only payload renders no sections');
  wr.unmount('war-room');
}

// ══════════════════════════════════════════════════════════════════════
// 5. Flight recorder: click-to-open, run timeline, evidence, empty state
// ══════════════════════════════════════════════════════════════════════
async function testRecorder(wr) {
  resetHarness();
  await wr.mount('war-room');
  await tick(6);

  // Click a blocked card row → recorder opens with a card fetch.
  const blocked = findByClass(hostEl, 'wr-blocked');
  assert(blocked.length >= 1, 'blocked rows present before recorder');
  blocked[0].click();
  await tick(6);

  const runs = findByClass(hostEl, 'wr-run');
  assertEqual(runs.length, 2, 'recorder shows both runs in the timeline');
  assert(findByClass(hostEl, 'wr-back').length === 1, 'recorder has a back button');
  assert(findByClass(hostEl, 'wr-badge').length === 1, 'recorder keeps the VIEW ONLY badge');
  const pageText = hostEl.textContent || '';
  assert(pageText.indexOf('Flight Recorder') !== -1, 'recorder header rendered');
  assert(pageText.indexOf('6h soak: bot run') !== -1, 'recorder shows the card title');

  // Card-level events + substance marking (created is substance).
  const cardLevel = findByClass(hostEl, 'wr-subhead');
  assert(cardLevel.some(s => s.textContent.indexOf('CARD EVENTS') !== -1),
    'card-level events rendered as their own group');
  const substanceSpans = findByClass(hostEl, 'wr-span-substance');
  assert(substanceSpans.length >= 2, 'substance spans (created + progress/completed) marked');

  // Heartbeat cadence is aggregated, not one row per heartbeat.
  const idleSpans = findByClass(hostEl, 'wr-span-idle');
  assert(idleSpans.length >= 3, 'idle/liveness spans render (claimed/spawned/heartbeat cadence)');
  const idleTexts = idleSpans.map(s => s.textContent || '').join(' ');
  assert(/×43 over/.test(idleTexts), 'heartbeat cadence aggregated (×43 over …)');
  assert(/liveness cadence/.test(idleTexts), 'heartbeat cadence labelled as liveness, not substance');

  // Evidence pane: envelope contents, gate verdict, verify runs, attestation.
  const evText = hostEl.textContent || '';
  assert(evText.indexOf('COMPLETION RECORDS') !== -1, 'evidence pane lists completion records');
  assert(evText.indexOf('scripts/soak.sh') !== -1, 'envelope changed_files rendered');
  assert(evText.indexOf('build/soak.log') !== -1, 'envelope artifacts rendered');
  assert(evText.indexOf('evidence-abc') !== -1, 'envelope evidence_refs rendered');
  assert(evText.indexOf('diff_matches_claims: true') !== -1, 'envelope gate outcome rendered');
  assert(evText.indexOf('contract_completion_evaluated') !== -1, 'gate verdict kind rendered');
  assert(evText.indexOf('CHECK RUNS') !== -1, 'check runs section rendered');
  assert(evText.indexOf('verify_suite.sh') !== -1, 'verify command rendered');
  assert(evText.indexOf('reviewer:rei') !== -1, 'attestation role rendered');

  // Links pane: parents + children.
  assert(evText.indexOf('t_epic') !== -1, 'parent link rendered');
  assert(evText.indexOf('t_child1') !== -1, 'child link rendered');

  // Expand a run: its spans become visible.
  const runHeads = findByClass(hostEl, 'wr-run-head');
  assertEqual(runHeads.length, 2, 'each run has an expandable head');
  const runBodies = findByClass(hostEl, 'wr-run-spans');
  assertEqual(runBodies.length, 2, 'each run has a collapsible spans body');
  assertEqual(runBodies[1].style.display, 'none', 'run spans start collapsed');
  runHeads[1].click();
  assert(runBodies[1].style.display !== 'none', 'clicking a run head expands its spans');
  assert(runHeads[1].classList.contains('wr-run-open'), 'expanded run head carries .wr-run-open');
  runHeads[1].click();
  assertEqual(runBodies[1].style.display, 'none', 'clicking again collapses the run');

  // Recorder interval behavior: the 30s tick does NOT re-render the board
  // while the recorder is open (no polling storm, no view nuke).
  intervalCalls[0].fn();
  await tick(6);
  assert(findByClass(hostEl, 'wr-back').length === 1,
    '30s tick leaves the recorder open (no board nuke)');

  // Manual Refresh re-fetches the card (light auto-refresh contract).
  const cardCallsBefore = apiCalls.filter(c => c.url.indexOf('/api/kanban/war-room/card/') === 0).length;
  const refreshBtn = findByClass(hostEl, 'panel-retry');
  refreshBtn[refreshBtn.length - 1].click();
  await tick(6);
  const cardCallsAfter = apiCalls.filter(c => c.url.indexOf('/api/kanban/war-room/card/') === 0).length;
  assert(cardCallsAfter === cardCallsBefore + 1, 'Refresh button re-fetches the card payload');

  // Back returns to the board.
  findByClass(hostEl, 'wr-back')[0].click();
  await tick(6);
  assertEqual(findByClass(hostEl, 'wr-section').length, 5, 'back returns to the five-section board');
  assertEqual(findByClass(hostEl, 'wr-run').length, 0, 'recorder DOM is gone after back');

  // Deep link close: hashchange to empty closes the recorder too.
  blocked[0].click();
  await tick(6);
  assert(findByClass(hostEl, 'wr-run').length === 2, 'recorder reopened for deep-link test');
  fireHashChange('');
  await tick(6);
  assertEqual(findByClass(hostEl, 'wr-section').length, 5,
    'hash cleared → recorder closes back to the board');

  wr.unmount('war-room');
}

// ══════════════════════════════════════════════════════════════════════
// 6. Flight recorder: empty state (card with zero runs)
// ══════════════════════════════════════════════════════════════════════
async function testRecorderEmpty(wr) {
  resetHarness();
  await wr.mount('war-room');
  await tick(6);

  // t_fresh in the blocked list maps to CARD_EMPTY in the fake api.
  const blocked = findByClass(hostEl, 'wr-blocked');
  const freshRow = blocked.find(r => (r.dataset.task || '') === 't_fresh') || blocked[0];
  freshRow.click();
  await tick(6);

  const text = hostEl.textContent || '';
  assert(text.indexOf('No runs recorded yet') !== -1, 'zero-run card shows the empty state');
  assert(findByClass(hostEl, 'wr-run').length === 0, 'no run rows rendered for empty card');
  assert(text.indexOf('Evidence') !== -1, 'evidence section still renders');
  assert(text.indexOf('No contract evidence for this card.') !== -1, 'evidence pane empty state');

  // Back still works.
  findByClass(hostEl, 'wr-back')[0].click();
  await tick(6);
  assertEqual(findByClass(hostEl, 'wr-section').length, 5, 'back from empty recorder returns to board');
  wr.unmount('war-room');
}

// ══════════════════════════════════════════════════════════════════════
// 7. Flight recorder: deep link #card=t_xxx opens on mount
// ══════════════════════════════════════════════════════════════════════
async function testRecorderDeepLink(wr) {
  resetHarness();
  globalThis.location = { hash: '#card=t_heavy' };
  await wr.mount('war-room');
  await tick(8);

  assert(findByClass(hostEl, 'wr-back').length === 1,
    'mount with #card= opens the recorder directly');
  const text = hostEl.textContent || '';
  assert(text.indexOf('6h soak: bot run') !== -1, 'deep-linked card rendered');
  assertEqual(findByClass(hostEl, 'wr-run').length, 2, 'deep-linked card timeline rendered');

  // Live hashchange to another card switches the recorder.
  fireHashChange('#card=t_heavy'); // same id — no-op (same hash, no change event)
  fireHashChange('#card=t_fresh');
  await tick(6);
  assert(text.indexOf('No runs recorded yet') !== -1 || hostEl.textContent.indexOf('Never dispatched') !== -1,
    'hashchange to another card switches the recorder target');

  wr.unmount('war-room');
}

// ══════════════════════════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════════════════════════
(async function main() {
  const wr = await import('file://' + path.join(HYRAX, 'warroom.js').replace(/\\/g, '/'));

  await testHelpers(wr);
  await testMount(wr);
  await testLifecycle(wr);
  await testErrors(wr);
  await testRecorder(wr);
  await testRecorderEmpty(wr);
  await testRecorderDeepLink(wr);

  if (failures.length) {
    console.error(`\nrun_hyrax_warroom_tests.js: ${failed} FAILED / ${passed} passed`);
    failures.forEach(f => console.error('  ✗ ' + f));
    process.exit(1);
  }
  console.log(`run_hyrax_warroom_tests.js: ${passed} passed, 0 failed`);
  process.exit(0);
})().catch(err => {
  console.error('run_hyrax_warroom_tests.js crashed:', err);
  process.exit(1);
});
