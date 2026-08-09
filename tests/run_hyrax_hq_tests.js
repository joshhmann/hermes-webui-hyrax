#!/usr/bin/env node
/**
 * Execution-level Node harness for the Hyrax HQ controller (post-migration).
 *
 * Loads the PRODUCTION hq.js ES module (and its vn.js dependency) against a
 * minimal fake DOM / api / timer environment and proves the migration
 * contracts for the HQ controller:
 *
 *   - static bans: no switchPanel wrapper/reassignment, no registry mutation,
 *     at most ONE setInterval (the visibility-gated 30s presence refresh),
 *     no MutationObserver / CT112 / iframe / postMessage / blob / data URLs,
 *     no attacker-override import seam (__mockImport)
 *   - legacy window hooks stay alive: __hqMount / __hqUnmount / __hqLaunch3d
 *   - first mount renders the 2D map synchronously WITHOUT any 3D import and
 *     arms exactly one 30s presence timer
 *   - second mount does not duplicate DOM or timers; unmount clears the timer
 *     and is idempotent; re-mount renders again
 *   - launch3d imports the production bundle exactly once per launch, calls
 *     mountTaiLoft with the HQ host + onExit, cleanup is exactly-once, and a
 *     failed import renders the accessible "← Return to VN" fallback
 *
 * Usage:  node tests/run_hyrax_hq_tests.js
 * Exit code: 0 = all pass, 1 = any failure.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const HYRAX = path.join(REPO, 'static', 'hyrax');
const HQ_PATH = path.join(HYRAX, 'hq.js');

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

// setInterval / clearInterval spies
const intervalCalls = [];
const clearedIntervals = [];
const _origSetInterval = globalThis.setInterval;
const _origClearInterval = globalThis.clearInterval;
globalThis.setInterval = function(fn, ms) {
  intervalCalls.push({ fn, ms });
  return _origSetInterval(fn, ms);
};
globalThis.clearInterval = function(id) {
  clearedIntervals.push(id);
  return _origClearInterval(id);
};

function makeEl(tag) {
  const clsList = [];
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
    get classList() {
      return {
        contains(c) { return clsList.indexOf(c) !== -1; },
        add(...c) { c.forEach(x => { if (clsList.indexOf(x) === -1) clsList.push(x); }); },
        remove(...c) { c.forEach(x => { const i = clsList.indexOf(x); if (i !== -1) clsList.splice(i, 1); }); },
        toggle(c) { const i = clsList.indexOf(c); if (i !== -1) { clsList.splice(i, 1); return false; } else { clsList.push(c); return true; } },
        toString() { return clsList.join(' '); },
        valueOf() { return clsList.join(' '); },
        [Symbol.iterator]() { return clsList[Symbol.iterator](); },
      };
    },
    setAttribute(k, v) { this._attrs[k] = String(v); if (k.startsWith('data-')) this.dataset[k.slice(5)] = String(v); },
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
    hasAttribute(k) { return k in this._attrs; },
    removeAttribute(k) { delete this._attrs[k]; },
    addEventListener(ev, fn) {
      if (!this._listeners[ev]) this._listeners[ev] = [];
      if (this._listeners[ev].indexOf(fn) === -1) this._listeners[ev].push(fn);
    },
    removeEventListener(ev, fn) {
      const arr = this._listeners[ev];
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i !== -1) arr.splice(i, 1);
    },
    dispatchEvent(ev) {
      ev.target = el;
      (this._listeners[ev.type] || []).slice().forEach(fn => { try { fn(ev); } catch (_) { /* isolated */ } });
      return true;
    },
    appendChild(c) { if (c) this._children.push(c); return c; },
    insertBefore(c) { if (c) this._children.push(c); return c; },
    append(...children) { children.forEach(c => { if (c != null) this._children.push(c); }); return el; },
    replaceChildren(...children) { this._children = children.filter(Boolean); },
    remove() { el._removed = true; },
    focus() {},
    click() {
      const ev = { type: 'click', target: el, preventDefault() {}, stopPropagation() {}, key: '' };
      (this._listeners.click || []).slice().forEach(fn => { try { fn(ev); } catch (_) { /* isolated */ } });
    },
    querySelector(sel) { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    getContext() { return new Proxy({}, { get: () => () => {}, set: () => true }); },
  };
  Object.defineProperty(el, 'textContent', {
    get() { return el._text || ''; },
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

const mainHqEl = makeEl('div');
mainHqEl._attrs.id = 'mainHq';
mainHqEl.className = 'main-view';
const mainEl = makeEl('main');
mainEl.className = 'main';
mainEl._children.push(mainHqEl);

const fakeDoc = {
  readyState: 'complete',
  body: makeEl('body'),
  head: { appendChild() {}, querySelector() { return null; } },
  createElement: makeEl,
  createTextNode(t) { return { textContent: String(t), nodeType: 3 }; },
  getElementById(id) { return id === 'mainHq' ? mainHqEl : null; },
  querySelector(sel) {
    if (sel === 'main' || sel === 'main.main') return mainEl;
    return null;
  },
  querySelectorAll() { return []; },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() { return true; },
};
globalThis.document = fakeDoc;

const apiCalls = [];
function fakeApi(url, opts = {}) {
  apiCalls.push({ url, method: opts.method || 'GET' });
  if (url === '/api/hyrax/presence') return Promise.resolve({ items: [] });
  return Promise.resolve({});
}
globalThis.api = fakeApi;
globalThis.showToast = () => {};
globalThis.switchPanel = () => {};
globalThis.localStorage = (() => {
  const m = new Map();
  return {
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { m.set(k, String(v)); },
    removeItem(k) { m.delete(k); },
  };
})();
globalThis.location = { search: '', hash: '', pathname: '/' };
globalThis.confirm = () => true;
globalThis.matchMedia = () => ({ matches: false, addListener() {}, addEventListener() {} });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.CustomEvent = class { constructor(type, opts = {}) { this.type = type; this.detail = opts.detail || null; } };
globalThis.fetch = () => Promise.reject(new Error('no fetch in harness'));
globalThis.EventSource = class { constructor() {} close() {} addEventListener() {} removeEventListener() {} };

const FAKE_BUNDLE = 'file://' + path.join(REPO, 'tests', 'fixtures', 'fake-embodiment-bundle.mjs').replace(/\\/g, '/');
const MISSING_BUNDLE = 'file://' + path.join(REPO, 'tests', 'fixtures', 'does-not-exist.mjs').replace(/\\/g, '/');
function resetLoftSpies() {
  delete globalThis.__FAKE_LOFT_CALLS;
  delete globalThis.__FAKE_LOFT_CLEANUPS;
  delete globalThis.__FAKE_LOFT_MOUNTED;
}

// ── Load the production module ───────────────────────────────────────────
const hqSrc = fs.readFileSync(HQ_PATH, 'utf-8');
let hqMod = null;
async function loadHq() {
  if (!hqMod) hqMod = await import('file://' + HQ_PATH.replace(/\\/g, '/'));
  return hqMod;
}

(async () => {
  try {
    // ── 1. Static checks ──
    console.log('═══ Hyrax HQ Execution Tests ═══\n');
    console.log('── No forbidden patterns ──');
    assert(!hqSrc.includes('origSwitchPanel'), 'hq.js must NOT wrap switchPanel');
    assert(!hqSrc.includes('window.switchPanel ='), 'hq.js must NOT reassign switchPanel');
    assert(!hqSrc.includes('MAIN_VIEW_PANELS'), 'hq.js must NOT touch the panel registry');
    // Living HQ: one setInterval is allowed — the 30s presence refresh —
    // and it must be visibility-gated and cleared on unmount.
    const intervalRefs = (hqSrc.match(/setInterval/g) || []).length;
    assert(intervalRefs <= 1,
      'hq.js uses at most one setInterval (the visibility-gated presence refresh), got ' + intervalRefs);
    assert(hqSrc.includes('visibilityState'),
      'presence refresh must be gated on document.visibilityState');
    assert(hqSrc.includes('showing-hq'),
      'presence refresh must be gated on HQ panel visibility (showing-hq)');
    assert(hqSrc.includes('clearInterval'),
      'presence refresh interval must be cleared on unmount');
    assert(!hqSrc.includes('MutationObserver'), 'hq.js must NOT use MutationObserver');
    assert(!hqSrc.includes('CT112'), 'hq.js must NOT reference CT112');
    assert(!hqSrc.includes('iframe'), 'hq.js must NOT use iframe');
    assert(!hqSrc.includes('postMessage'), 'hq.js must NOT use postMessage');
    assert(!hqSrc.includes('blob:'), 'hq.js must NOT use blob URLs');
    assert(!hqSrc.includes('data:'), 'hq.js must NOT use data URLs');
    assert(!hqSrc.includes('__mockImport'), 'hq.js must NOT reference __mockImport (attacker override)');
    assert(hqSrc.includes('import(bundleUrl())'),
      'hq.js lazily imports through bundleUrl() (the only dynamic import site)');

    // ── 2. Legacy window hooks (classic vnShell contract) ──
    console.log('\n── Legacy window hooks ──');
    const hq = await loadHq();
    assert(typeof globalThis.__hqMount === 'function', '__hqMount is a function');
    assert(typeof globalThis.__hqUnmount === 'function', '__hqUnmount is a function');
    assert(typeof globalThis.__hqLaunch3d === 'function', '__hqLaunch3d is a function');
    assert(typeof hq.mount === 'function' && typeof hq.unmount === 'function',
      'ES controller exports mount/unmount');

    // ── 3. First mount: 2D sync render, one 30s timer, no import ──
    console.log('\n── First mount (2D, no import) ──');
    intervalCalls.length = 0;
    clearedIntervals.length = 0;
    resetLoftSpies();
    const importBefore = 0;
    const result = hq.mount('hq');
    assert(result === undefined, 'mount is synchronous (no promise)');
    assert(findByClass(mainHqEl, 'hq-page').length === 1, 'mount renders the 2D map');
    assert(!globalThis.__FAKE_LOFT_CALLS, 'first mount does NOT import the 3D bundle');

    console.log('\n── Presence refresh timer ──');
    assert(intervalCalls.length === 1, 'mount arms exactly one interval timer');
    assert(intervalCalls[0] && intervalCalls[0].ms === 30000,
      'presence refresh interval is 30s (got ' + (intervalCalls[0] && intervalCalls[0].ms) + ')');

    await tick(4); // presence resolves → chibis
    assert(findByClass(mainHqEl, 'chibi-tai').length === 1, 'mount renders chibis after presence');

    // ── 4. Second mount: no duplicate DOM, no new timer ──
    console.log('\n── Second mount (refresh, no duplicate) ──');
    const timersBefore = intervalCalls.length;
    hq.mount('hq');
    assert(findByClass(mainHqEl, 'hq-page').length === 1, 'second mount does not duplicate the 2D map');
    assert(intervalCalls.length === timersBefore, 'second mount does not arm a second timer');

    // ── 5. Unmount: clears the timer, idempotent ──
    console.log('\n── Unmount ──');
    hq.unmount('hq');
    assert(clearedIntervals.length >= 1, 'unmount clears the presence refresh interval');
    hq.unmount('hq');
    assert(true, 'double unmount does not throw');

    // ── 6. Re-mount after unmount ──
    console.log('\n── Re-mount after unmount ──');
    hq.mount('hq');
    assert(findByClass(mainHqEl, 'hq-page').length === 1, 're-mount renders the 2D map again');

    // ── 7. launch3d failure: accessible fallback with Return to VN ──
    // Runs FIRST (fresh module cache — the launch path caches the import
    // promise, so a failure scenario must start from a never-imported state).
    console.log('\n── launch3d failure fallback ──');
    globalThis.__HYRAX_3D_URL = MISSING_BUNDLE;
    resetLoftSpies();
    await hq.launch3d();
    await tick(10);
    const allBtns = (function collect(root) {
      const out = [];
      const stack = [root];
      while (stack.length) {
        const el = stack.pop();
        if (!el) continue;
        if (el._children) { for (let i = el._children.length - 1; i >= 0; i--) stack.push(el._children[i]); }
        if (el.tagName === 'BUTTON') out.push(el);
      }
      return out;
    })(mainHqEl);
    const retryBtn = allBtns.find(b => (b.textContent || '').includes('Return to VN'));
    assert(retryBtn !== undefined, 'failure renders a "← Return to VN" fallback button');
    if (retryBtn) {
      retryBtn.click();
      await tick(10);
      assert(findByClass(mainHqEl, 'hq-page').length === 1 || findByClass(mainHqEl, 'vn2').length === 1,
        'failure fallback returns to a live view (not a dead state)');
    }

    // ── 8. launch3d: exact production mount, exact-once cleanup ──
    console.log('\n── launch3d success path ──');
    globalThis.__HYRAX_3D_URL = FAKE_BUNDLE;
    resetLoftSpies();
    await hq.launch3d();
    await tick(10);
    assert(globalThis.__FAKE_LOFT_CALLS && globalThis.__FAKE_LOFT_CALLS.length === 1,
      'mountTaiLoft called exactly once');
    if (globalThis.__FAKE_LOFT_CALLS && globalThis.__FAKE_LOFT_CALLS[0]) {
      const call = globalThis.__FAKE_LOFT_CALLS[0];
      assert(call.host === mainHqEl, 'mountTaiLoft receives the HQ host');
      assert(typeof call.onExit === 'function', 'mountTaiLoft receives an onExit callback');
      assert(call.configuration && call.configuration.vrmUrl === '/api/hyrax/assets/tai.embodiment.vrm',
        'mountTaiLoft uses the production vrmUrl default');
      assert(call.configuration && call.configuration.development === undefined,
        'mountTaiLoft uses production defaults (no development flag)');
      await call.onExit();
      await tick(10);
      assert(globalThis.__FAKE_LOFT_CLEANUPS === 1, 'cleanup called exactly once on exit');
      await call.onExit();
      assert(globalThis.__FAKE_LOFT_CLEANUPS === 1,
        'cleanup stays exactly-once across repeated exit calls');
    }
    delete globalThis.__HYRAX_3D_URL;
    hq.unmount('hq');

    // ── Report ──
    console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══\n`);
    if (failures.length > 0) {
      console.error('FAILURES:');
      failures.forEach(f => console.error('  ✗ ' + f));
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    failed++;
    failures.push('HARNESS ERROR: ' + (err && err.stack ? err.stack : String(err)));
    console.error('\nFAILURES:');
    failures.forEach(f => console.error('  ✗ ' + f));
    process.exit(1);
  }
})();
