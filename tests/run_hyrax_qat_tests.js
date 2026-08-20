#!/usr/bin/env node
/**
 * Execution-level Node harness for the Hyrax QAT panel controller (qat.js).
 *
 * Loads the PRODUCTION qat.js ES module against a minimal fake DOM / api
 * environment and proves the QAT panel contracts:
 *
 *   - pure helpers: testId/overallId composition, byTestId indexing
 *     (last-row-wins), verdictCounts, milestoneStatus gating
 *   - mount renders the packet: header, ledger strip, per-milestone
 *     sections (active M4/M5.1/M5.2 with requirements + setup + test rows,
 *     gated M5.3 with lock note), master sheet
 *   - recorded verdicts render as .qat-recorded rows; unrecorded active
 *     tests render .qat-composer buttons; gated tests render .qat-locked
 *   - clicking a verdict button with a why triggers POST /api/hyrax/qat/verdicts
 *     and re-mounts (fresh GET) — a submitted verdict appears on reload
 *   - api failure renders the inline error + Retry (visible, not silent)
 *   - mount/unmount are idempotent; unmount clears the host
 *
 * Usage:  node tests/run_hyrax_qat_tests.js
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
    value: '',
    maxLength: 0,
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
hostEl._attrs.id = 'mainQat';
hostEl.className = 'main-view';

const fakeDoc = {
  readyState: 'complete',
  body: makeEl('body'),
  head: { appendChild() {}, querySelector() { return null; } },
  createElement: makeEl,
  createTextNode(t) { return { textContent: String(t), nodeType: 3 }; },
  getElementById(id) { return id === 'mainQat' ? hostEl : null; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() { return true; },
};
globalThis.document = fakeDoc;

// ── Packet fixture (trimmed to what the panel needs) ─────────────────────
const PACKET = {
  id: 'JOSH-QAT-PACKET-M4-M5.x',
  date: '2026-08-17',
  how_it_works: ['Fast-forward shape: spawn -> .kit hytest -> .teleport mirage -> verdicts.'],
  milestones: [
    {
      id: 'M4',
      title: 'M4 — Trade / craft / transport',
      status: 'active',
      engineering_status: 'EXIT RECORD merged + deployed; feel unproven.',
      requirements: [{ req: 'REQ-M4-1', mechanic: 'Crafting' }, { req: 'REQ-M4-2', mechanic: 'Trade packs' }],
      setup: ['1. Login.', '2. .kit hytest.', '3. .teleport mirage.'],
      tests: [
        { id: 'S1', step: 'Harvest: work the potato doodad (2259)', pass: 'Items appear in inventory', feel: 'Does harvest feel alive?' },
        { id: 'S2', step: 'Craft golden potato pack 26489', pass: 'Pack appears in Backpack slot', feel: 'Does the pack look carried?' },
        { id: 'S6', step: 'Restart spot-check', pass: 'Vehicle + cargo exactly once', feel: '', optional: true },
      ],
      verdict_format: ['M4-S1: PASS / FAIL / CAVEAT — why'],
      ledger: 'H=PASS/FAIL per REQ-M4-1..5 into EVIDENCE-LEDGER M4 row.',
      overall: { id: 'OVERALL', label: 'OVERALL M4 FEEL', reqs: 'REQ-M4-4 / REQ-M4-5' },
    },
    {
      id: 'M5.1',
      title: 'M5.1 — Economic extension',
      status: 'active',
      engineering_status: '9 actions merged, Rei-gated.',
      requirements: [{ req: 'REQ-M5.1-1', mechanic: 'Economic action surface' }],
      setup: ['Same as M4.'],
      tests: [
        { id: 'E1', step: 'Plant: use a seed on the farm plot', pass: 'Seed consumes; crop spawns', feel: 'Does planting read right?' },
      ],
      verdict_format: ['M5.1-E1..E8: PASS / FAIL / CAVEAT — why'],
      ledger: 'H=PASS/FAIL per REQ-M5.1-1..5.',
      overall: { id: 'OVERALL', label: 'OVERALL M5.1 FEEL', reqs: 'REQ-M5.1-1..5' },
    },
    {
      id: 'M5.2',
      title: 'M5.2 — Housing.Build',
      status: 'active',
      engineering_status: 'BuildHouse merged; feel unproven.',
      requirements: [{ req: 'REQ-M5.2-1', mechanic: 'BuildHouse over real path' }],
      setup: ['Same fast-forward.'],
      tests: [
        { id: 'H1', step: 'Place: use the house design at a valid spot', pass: 'Placement accepted', feel: 'Does placement read correctly?' },
      ],
      verdict_format: ['M5.2-H1: PASS / FAIL / CAVEAT — why'],
      ledger: 'H=PASS/FAIL per REQ-M5.2-1, -3.',
      overall: { id: 'OVERALL', label: 'OVERALL M5.2 FEEL', reqs: 'REQ-M5.2-1, -3' },
    },
    {
      id: 'M5.3',
      title: 'M5.3 — Core surface',
      status: 'gated',
      gate_note: 'SPEC MERGED; implementation parked at the M5.2 cap. Do not run before then.',
      engineering_status: 'Spec merged; impl parked.',
      requirements: [{ req: 'REQ-M5.3-2', mechanic: 'Observe' }],
      setup: ['Same fast-forward.'],
      tests: [
        { id: 'C1', step: 'Observe: run one Observe call', pass: 'Snapshot equals client', feel: 'Does it match?' },
      ],
      verdict_format: ['M5.3-C1..C5: PASS / FAIL / CAVEAT — why'],
      ledger: 'H=PASS/FAIL per REQ-M5.3-2..6.',
      overall: { id: 'OVERALL', label: 'OVERALL M5.3 FEEL', reqs: 'REQ-M5.3-2..6' },
    },
  ],
  master_sheet: {
    header: 'Date:  Runtime:  Venue: Mirage Isle',
    ledger_landing: 'Each PASS/FAIL lands in EVIDENCE-LEDGER class 7.',
  },
  sources: ['ROADMAP.md', 'EVIDENCE-LEDGER.md'],
};

const VERDICTS = [
  { test_id: 'M4-S1', milestone: 'M4', verdict: 'PASS', why: 'crops animate cleanly', source: 'hyrax-qat', at: 1000 },
  { test_id: 'M5.2-OVERALL', milestone: 'M5.2', verdict: 'CAVEAT', why: 'door slow', source: 'hyrax-qat', at: 2000 },
];

// ── api fake ─────────────────────────────────────────────────────────────
const apiCalls = [];
let apiMode = 'ok'; // 'ok' | 'packetfail' | 'netfail'
let submitted = null;

async function fakeApi(url, opts) {
  apiCalls.push({ url, method: (opts && opts.method) || 'GET' });
  if (apiMode === 'netfail') {
    const e = new Error('HTTP 500');
    e.status = 500;
    throw e;
  }
  if (url === '/api/hyrax/qat/packet') {
    if (apiMode === 'packetfail') return { error: 'not found' };
    return { packet: PACKET };
  }
  if (url === '/api/hyrax/qat/verdicts' && (!opts || !opts.method || opts.method === 'GET')) {
    return { items: VERDICTS, total: VERDICTS.length };
  }
  if (url === '/api/hyrax/qat/verdicts' && opts && opts.method === 'POST') {
    submitted = JSON.parse(opts.body);
    return { ok: true, record: Object.assign({ source: 'hyrax-qat', at: 3000 }, submitted) };
  }
  return { error: 'not found' };
}
globalThis.api = fakeApi;

const toasts = [];
globalThis.showToast = function(msg) { toasts.push(String(msg)); };

// ══════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════

async function testHelpers(qat) {
  assertEqual(qat.testId('M4', 'S1'), 'M4-S1', 'testId composes milestone + local id');
  assertEqual(qat.testId('M5.1', 'E1'), 'M5.1-E1', 'testId keeps dot in milestone id');
  assertEqual(qat.overallId('M4'), 'M4-OVERALL', 'overallId suffix');

  const idx = qat.byTestId([{ test_id: 'M4-S1', verdict: 'PASS' }, { test_id: 'M4-S1', verdict: 'FAIL' }]);
  assertEqual(Object.keys(idx), ['M4-S1'], 'byTestId indexes by test_id');
  assertEqual(idx['M4-S1'].verdict, 'FAIL', 'byTestId last row wins');

  const counts = qat.verdictCounts([
    { verdict: 'PASS' }, { verdict: 'PASS' }, { verdict: 'FAIL' }, { verdict: 'CAVEAT' }, { verdict: 'NOPE' },
  ]);
  assertEqual(counts, { PASS: 2, FAIL: 1, CAVEAT: 1 }, 'verdictCounts counts only valid values');

  assertEqual(qat.milestoneStatus(PACKET, 'M4'), 'active', 'milestoneStatus active');
  assertEqual(qat.milestoneStatus(PACKET, 'M5.3'), 'gated', 'milestoneStatus gated');
  assertEqual(qat.milestoneStatus(PACKET, 'M9'), 'unknown', 'milestoneStatus unknown');
  assertEqual(qat.milestoneStatus(null, 'M4'), 'unknown', 'milestoneStatus null packet');
  console.log('testHelpers ✓');
}

async function testMount(qat) {
  apiMode = 'ok';
  hostEl.replaceChildren();
  qat.mount('qat');
  await tick(8);

  const text = hostEl.textContent || '';
  assert(text.indexOf('QAT — Human Test Packet') !== -1, 'header rendered');
  assert(text.indexOf('JOSH-QAT-PACKET-M4-M5.x') !== -1, 'packet id rendered');
  assert(text.indexOf('VERDICT LEDGER') !== -1, 'ledger strip rendered');
  assert(text.indexOf('2 recorded') !== -1, 'ledger shows recorded count');

  // Active milestones render their sections + composers.
  assert(findByClass(hostEl, 'qat-ms').length >= 4, 'four milestone sections rendered');
  assert(text.indexOf('M4 — Trade / craft / transport') !== -1, 'M4 title rendered');
  assert(text.indexOf('REQ-M4-1') !== -1, 'M4 requirements rendered');
  assert(text.indexOf('.kit hytest') !== -1, 'prerequisite setup rendered');
  assert(text.indexOf('Harvest: work the potato doodad') !== -1, 'M4 S1 step rendered');

  // Recorded verdicts render as .qat-recorded; unrecorded active tests get composers.
  const recorded = findByClass(hostEl, 'qat-recorded');
  assertEqual(recorded.length, 2, 'recorded rows rendered (M4-S1 + M5.2-OVERALL)');
  assert(findByClass(hostEl, 'qat-composer').length >= 5, 'composers for unrecorded active tests');
  assert(findByClass(hostEl, 'qat-btn').length >= 15, 'verdict buttons rendered (3 per composer)');

  // Overall row rendered.
  assert(text.indexOf('OVERALL M4 FEEL') !== -1, 'overall row label rendered');

  // Gated milestone shows lock note, no composers inside M5.3.
  assert(text.indexOf('SPEC MERGED; implementation parked') !== -1, 'M5.3 gate note rendered');
  assert(text.indexOf('Gated — verdicts locked') !== -1, 'M5.3 test shows locked state');

  // Master sheet.
  assert(text.indexOf('VERDICT FORMAT / LEDGER LANDING') !== -1, 'master sheet rendered');
  console.log('testMount ✓');
}

async function testSubmit(qat) {
  apiMode = 'ok';
  submitted = null;
  toasts.length = 0;
  apiCalls.length = 0;
  hostEl.replaceChildren();
  qat.mount('qat');
  await tick(8);

  // Find the first composer and click its PASS button.
  const composers = findByClass(hostEl, 'qat-composer');
  const first = composers[0];
  assert(first, 'composer exists');
  // Set the why input value, then click PASS.
  const whys = findByClass(first, 'qat-why');
  assert(whys.length >= 1, 'why input rendered');
  whys[0].value = 'feels great';
  const passBtn = findByClass(first, 'qat-pass')[0];
  assert(passBtn, 'PASS button exists');
  passBtn.click();
  await tick(10);

  assert(submitted !== null, 'POST fired on verdict click');
  assertEqual(submitted.verdict, 'PASS', 'submitted verdict is PASS');
  assertEqual(submitted.why, 'feels great', 'submitted why captured');
  assert(apiCalls.some(c => c.url === '/api/hyrax/qat/verdicts' && c.method === 'POST'),
    'POST /api/hyrax/qat/verdicts called');
  assert(toasts.some(t => t.indexOf('Verdict recorded') !== -1), 'success toast shown');
  // Re-mount after submit re-fetches the ledger (visible on reload).
  assert(apiCalls.filter(c => c.url === '/api/hyrax/qat/packet').length >= 2,
    'packet re-fetched after submit');
  console.log('testSubmit ✓');
}

async function testErrors(qat) {
  apiMode = 'netfail';
  hostEl.replaceChildren();
  qat.mount('qat');
  await tick(8);
  const text = hostEl.textContent || '';
  assert(text.indexOf('Could not load the QAT page') !== -1, 'net failure shows inline error');
  assert(findByClass(hostEl, 'qat-error').length >= 1, 'error box rendered');
  assert(findByClass(hostEl, 'qat-btn').length >= 1, 'Retry button rendered');

  apiMode = 'packetfail';
  hostEl.replaceChildren();
  qat.mount('qat');
  await tick(8);
  const text2 = hostEl.textContent || '';
  assert(text2.indexOf('Could not load the QAT packet') !== -1, 'missing packet shows inline error');
  console.log('testErrors ✓');
}

async function testLifecycle(qat) {
  apiMode = 'ok';
  hostEl.replaceChildren();
  qat.mount('qat');
  await tick(8);
  assert(hostEl._children.length > 0, 'mount populated host');
  qat.unmount('qat');
  assertEqual(hostEl._children.length, 0, 'unmount clears host');
  // Re-mount works after unmount.
  qat.mount('qat');
  await tick(8);
  assert(hostEl._children.length > 0, 're-mount repopulates host');
  qat.unmount('qat');
  console.log('testLifecycle ✓');
}

// ══════════════════════════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════════════════════════
(async function main() {
  const qat = await import('file://' + path.join(HYRAX, 'qat.js').replace(/\\/g, '/'));

  await testHelpers(qat);
  await testMount(qat);
  await testSubmit(qat);
  await testErrors(qat);
  await testLifecycle(qat);

  if (failures.length) {
    console.error(`\nrun_hyrax_qat_tests.js: ${failed} FAILED / ${passed} passed`);
    failures.forEach(f => console.error('  ✗ ' + f));
    process.exit(1);
  }
  console.log(`run_hyrax_qat_tests.js: ${passed} passed, 0 failed`);
  process.exit(0);
})().catch(err => {
  console.error('run_hyrax_qat_tests.js crashed:', err);
  process.exit(1);
});
