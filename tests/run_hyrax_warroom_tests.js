#!/usr/bin/env node
/**
 * Execution-level Node harness for the Hyrax War Room controller (warroom.js).
 *
 * Loads the PRODUCTION warroom.js ES module against a minimal fake DOM /
 * api / timer environment and proves the War Room contracts:
 *
 *   - pure helpers: ageLabel boundaries, feedDetail mapping, laneSummary
 *   - mount renders all five sections (DIRECTIVES / THE FLOOR / GATE QUEUE /
 *     SUBSTANCE FEED / JOSH ASKS) from a mocked read-only payload
 *   - stale (>24h) blocked cards get .wr-stale; fresh ones do not
 *   - exactly ONE 30s refresh interval is armed; re-mount does not duplicate
 *     it; unmount clears it and empties the host
 *   - api failure renders the inline error + Retry (visible, not silent);
 *     a non-read-only payload is rejected with an error box
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
const SNAPSHOT = {
  read_only: true,
  generated_at: Math.floor(Date.now() / 1000) - 90,
  directives: [
    { id: 't_direct', title: 'DIRECT: Bot control plane initiative', status: 'todo',
      assignee: 'aya', age_seconds: 3600,
      children: { done: 1, total: 3 }, current_stage: 'running' },
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
      payload: { reason: 'mechanical gate awaiting runner' }, created_at: 1751999000, age_seconds: 1000 },
    { id: 9, kind: 'completed', task_id: 't_c1', title: 'child one',
      payload: { summary: 'REI GATE ACCEPT — verified independently' }, created_at: 1751998500, age_seconds: 1500 },
    { id: 8, kind: 'progress', task_id: 't_c2', title: 'child two',
      payload: { tool: 'patch', artifact: 'x.py', delta: 'patched' }, created_at: 1751998000, age_seconds: 2000 },
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

function fakeApi(url, opts = {}) {
  apiCalls.push({ url, method: opts.method || 'GET' });
  if (apiMode === 'fail') return Promise.reject(new Error('boom'));
  if (apiMode === 'nonreadonly') {
    return Promise.resolve(Object.assign({}, SNAPSHOT, { read_only: false }));
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
  hostEl.replaceChildren();
  hostEl._children = [];
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
}

// ══════════════════════════════════════════════════════════════════════
// 2. Mount renders the six sections from the read-only snapshot
// ══════════════════════════════════════════════════════════════════════
async function testMount(wr) {
  resetHarness();
  await wr.mount('war-room');
  await tick(6); // fetch resolves

  const sections = findByClass(hostEl, 'wr-section');
  assertEqual(sections.length, 6, 'mount renders exactly six sections');

  // 1. DIRECTIVES
  const directive = findByClass(hostEl, 'wr-directive');
  assertEqual(directive.length, 1, 'directive row rendered');
  if (directive[0]) {
    assert(directive[0].textContent.indexOf('DIRECT: Bot control plane initiative') !== -1,
      'directive title rendered');
  }
  const meta = findByClass(hostEl, 'wr-directive-meta');
  assert(meta.some(m => m.textContent.indexOf('1/3 done') !== -1), 'child-chain progress rendered (1/3 done)');
  assert(meta.some(m => m.textContent.indexOf('stage: running') !== -1), 'current stage rendered');

  const commitments = findByClass(hostEl, 'wr-commitment');
  assert(commitments.length === 1, 'canonical Promise commitment rendered');
  assert(commitments[0].textContent.indexOf('Verified economic exit') !== -1,
    'Promise title rendered from snapshot');
  assert(commitments[0].textContent.indexOf('1/3 cards done') !== -1,
    'canonical Promise membership progress rendered');
  assert(commitments[0].textContent.indexOf('LLM calls 4/12') !== -1,
    'aggregate Promise budget rendered');

  // 2. THE FLOOR — six lane cards + blocked rows with stale highlight
  const lanes = findByClass(hostEl, 'wr-lane');
  assertEqual(lanes.length, 6, 'six lane cards (5 sisters + other)');
  const laneNames = lanes.map(l => l.textContent);
  assert(laneNames.some(t => t.indexOf('tai') !== -1 && t.indexOf('1') !== -1),
    'tai lane shows its counts');

  // 2b. OPERATOR PRESENCE strip (inside the floor section, read-only)
  const presenceRows = findByClass(hostEl, 'wr-presence-row');
  assertEqual(presenceRows.length, 5, 'presence strip shows one row per operator');
  const presenceTexts = presenceRows.map(r => r.textContent || '');
  assert(presenceTexts.some(t => t.indexOf('tai') !== -1 && t.indexOf('working') !== -1),
    'tai row shows activity label');
  assert(presenceTexts.some(t => t.indexOf('live') !== -1),
    'fresh operators carry the live freshness tag');
  assert(presenceTexts.some(t => t.indexOf('REI GATE: control-plane') !== -1),
    'current task title surfaces in the strip');
  assert(presenceTexts.some(t => t.indexOf('offline') !== -1),
    'unavailable operator shows offline');

  const blockedRows = findByClass(hostEl, 'wr-blocked');
  assertEqual(blockedRows.length, 2, 'both blocked cards listed');
  const staleRows = findByClass(hostEl, 'wr-blocked wr-stale');
  // .wr-stale is a class on the same element; findByClass splits on className
  const staleAll = blockedRows.filter(r => String(r.className || '').split(/\s+/).includes('wr-stale'));
  assertEqual(staleAll.length, 1, 'exactly one blocked card highlighted stale (>24h)');
  assert(staleRows.length === 0, 'combined-class lookup not used (see staleAll)');
  const staleTag = findByClass(hostEl, 'wr-stale-tag');
  assertEqual(staleTag.length, 1, 'STALE >24h tag rendered on the old block');
  const reasonTexts = blockedRows.map(r => r.textContent || '');
  assert(reasonTexts.some(t => t.indexOf('Josh decision required') !== -1),
    'block reason text rendered');

  // 3. GATE QUEUE
  const gauge = findByClass(hostEl, 'wr-gauge');
  assertEqual(gauge.length, 1, 'gate depth gauge rendered');
  assert(gauge[0].textContent.indexOf('3 / HIGH 8') !== -1, 'depth vs HIGH mark shown');
  const gateRows = findByClass(hostEl, 'wr-gate-row');
  assertEqual(gateRows.length, 4, 'review gates + review-required blocks + mechanical rows');
  const gateTexts = gateRows.map(r => r.textContent || '');
  assert(gateTexts.some(t => t.indexOf('REI GATE: control-plane') !== -1), 'rei gate listed');
  assert(gateTexts.some(t => t.indexOf('TRIAL GATE (Yui)') !== -1), 'yui mechanical gate listed separately');

  // 4. SUBSTANCE FEED
  const feedRows = findByClass(hostEl, 'wr-feed-row');
  assertEqual(feedRows.length, 3, 'substance feed rows rendered');
  const feedTexts = feedRows.map(r => r.textContent || '');
  assert(feedTexts.some(t => t.indexOf('REI GATE ACCEPT') !== -1), 'completion verdict text rendered');
  assert(feedTexts.some(t => t.indexOf('patch → x.py') !== -1), 'progress tool → artifact rendered');

  // 5. JOSH ASKS
  const asks = findByClass(hostEl, 'wr-ask');
  assertEqual(asks.length, 1, 'josh ask row rendered');
  assert(asks[0] && asks[0].textContent.indexOf('read-only') !== -1, 'ask row notes read-only answering');

  // Read-only badge + status line
  const badge = findByClass(hostEl, 'wr-badge');
  assertEqual(badge.length, 1, 'READ-ONLY badge rendered');
  const status = findByClass(hostEl, 'wr-status');
  assert(status.length && status[0].textContent.indexOf('gate depth 3') !== -1,
    'status line shows gate depth');
  assert(status.length && /updated (\d+)(s|m|h) ago/.test(status[0].textContent),
    'status line shows a sane relative updated stamp (delta, not epoch)');
  assert(status[0].textContent.indexOf('2954w') === -1,
    'updated stamp is NOT the epoch-as-duration bug');

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
  assertEqual(findByClass(hostEl, 'wr-section').length, 6,
    'refresh re-renders six sections (no duplicates)');
  assertEqual(findByClass(hostEl, 'wr-presence-row').length, 5,
    'refresh re-renders the presence strip (no duplicates)');

  // Idempotent re-mount: no extra interval, no duplicate DOM.
  await wr.mount('war-room');
  await tick(6);
  assertEqual(intervalCalls.length, 1, 're-mount does not arm a second interval');
  assertEqual(findByClass(hostEl, 'wr-section').length, 6,
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
  assertEqual(findByClass(hostEl, 'wr-section').length, 6, 're-mount after unmount renders again');
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
  assertEqual(findByClass(hostEl, 'wr-section').length, 6, 'retry recovers and renders the board');
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
// Main
// ══════════════════════════════════════════════════════════════════════
(async function main() {
  const wr = await import('file://' + path.join(HYRAX, 'warroom.js').replace(/\\/g, '/'));

  await testHelpers(wr);
  await testMount(wr);
  await testLifecycle(wr);
  await testErrors(wr);

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
