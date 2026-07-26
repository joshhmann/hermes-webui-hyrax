#!/usr/bin/env node
/**
 * Execution-level Node harness for Hyrax HQ (hq.js) module.
 *
 * Verifies lazy-loading of the 3D embodiment module, 2D fallback on
 * import failure, idempotent mount/unmount, and the correct lifecycle.
 *
 * Usage:
 *   node tests/run_hyrax_hq_tests.js
 *
 * Exit code: 0 = all pass, 1 = any failure.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Resolve paths ──────────────────────────────────────────────────────────
const HQ_PATH = path.join(__dirname, '..', 'static', 'hyrax', 'hq.js');

// ── Helpers ────────────────────────────────────────────────────────────────
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

// ── Fake DOM ──────────────────────────────────────────────────────────────
const dispatchedEvents = [];

class FakeCustomEvent {
  constructor(type, opts = {}) {
    this.type = type;
    this.bubbles = !!opts.bubbles;
    this.cancelable = !!opts.cancelable;
    this.detail = opts.detail || null;
  }
}

let _createElementCalls = [];

function makeEl(tag) {
  const clsList = [];
  const el = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    innerHTML: '',
    style: {},
    id: '',
    hidden: false,
    _children: [],
    _attrs: {},
    dataset: {},
    get classList() {
      return {
        contains(c) { return clsList.indexOf(c) !== -1; },
        add(...c) { c.forEach(x => { if (clsList.indexOf(x) === -1) clsList.push(x); }); },
        remove(...c) { c.forEach(x => { const i = clsList.indexOf(x); if (i !== -1) clsList.splice(i, 1); }); },
        toggle(c) { const i = clsList.indexOf(c); if (i !== -1) { clsList.splice(i, 1); return false; } else { clsList.push(c); return true; } },
        toString() { return clsList.join(' '); },
        [Symbol.iterator]() { return clsList[Symbol.iterator](); },
      };
    },
    setAttribute(k, v) { this._attrs[k] = v; if (k.startsWith('data-')) { const key = k.slice(5); this.dataset[key] = v; } },
    getAttribute(k) { return this._attrs[k] || null; },
    hasAttribute(k) { return k in this._attrs; },
    removeAttribute(k) { delete this._attrs[k]; },
    appendChild(c) { if (c != null) this._children.push(c); },
    insertBefore(c, ref) { if (c) this._children.push(c); },
    replaceChildren(...children) { this._children = children.filter(Boolean); },
    append(...children) { children.forEach(c => { if (c != null) this._children.push(c); }); },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    focus() {},
    remove() {},
    get children() { return this._children; },
  };
  return el;
}

// Track dynamic import calls
const importCalls = [];

// Mock import() function — signature matches _dynamicImport in eval params
function mockImport(url) {
  importCalls.push(url);
  if (url.includes('embodiment-bundle')) {
    return Promise.resolve({
      mountTaiLoft: async function(container, returnCb, opts) {
        // Simulate successful mount
        container.dataset._3dMounted = 'true';
        return function cleanup() {
          delete container.dataset._3dMounted;
        };
      },
    });
  }
  return Promise.reject(new Error('Module not found'));
}

// Tracks whether window.__mockImport (malicious override) was called
var attackerImportCalled = false;

// Track interval timers (hq.js arms a 30s visibility-gated presence
// refresh). Mocks keep the Node event loop free and let tests inspect
// arm/clear behavior.
const intervalCalls = [];
const clearedIntervals = [];
function mockSetInterval(fn, ms) {
  const id = intervalCalls.length + 1;
  intervalCalls.push({ id: id, ms: ms });
  return id;
}
function mockClearInterval(id) {
  clearedIntervals.push(id);
}

// Main content element (simulates #mainHq)
const mainHqEl = makeEl('div');
mainHqEl.id = 'mainHq';

const fakeDoc = {
  _listeners: {},
  createElement(tag) { _createElementCalls.push(tag); return makeEl(tag); },
  createTextNode(t) { return { textContent: String(t) }; },
  getElementById(id) {
    if (id === 'mainHq') return mainHqEl;
    return null;
  },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  addEventListener(ev, fn, opts) {
    if (!this._listeners[ev]) this._listeners[ev] = [];
    this._listeners[ev].push(fn);
    if (opts && opts.once) fn._once = true;
  },
  dispatchEvent(ev) {
    dispatchedEvents.push(ev);
    const arr = this._listeners[ev.type];
    if (arr) arr.slice().forEach(fn => {
      fn(ev);
      if (fn._once) {
        const idx = this._listeners[ev.type].indexOf(fn);
        if (idx !== -1) this._listeners[ev.type].splice(idx, 1);
      }
    });
  },
  head: { appendChild() {} },
};

// ── Extract IIFE body from hq.js (or use raw source if no IIFE) ──
function extractIifeBody(src) {
  const start = src.indexOf('(function()');
  if (start === -1) {
    // Old-style plain script — RED phase: returns whole source so
    // assertions about missing __hqMount etc. can be checked
    return src;
  }
  const braceOpen = src.indexOf('{', start + 9);
  if (braceOpen === -1) throw new Error('IIFE opening brace not found');
  if (braceOpen === -1) throw new Error('IIFE opening brace not found');

  let depth = 1;
  let i = braceOpen + 1;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  if (depth !== 0) throw new Error('IIFE braces unbalanced');
  return src.slice(braceOpen + 1, i - 1);
}

const hqSrc = fs.readFileSync(HQ_PATH, 'utf-8');
const iifeBody = extractIifeBody(hqSrc);

// ── Run tests ──────────────────────────────────────────────────────────────
function runTests() {
  console.log('═══ Hyrax HQ Execution Tests ═══\n');

  // 1. Static checks
  console.log('── No forbidden patterns ──');
  assert(!hqSrc.includes('origSwitchPanel'), 'hq.js must NOT wrap switchPanel');
  assert(!hqSrc.includes('window.switchPanel ='), 'hq.js must NOT reassign switchPanel');
  assert(!hqSrc.includes('MAIN_VIEW_PANELS'), 'hq.js must NOT touch MAIN_VIEW_PANELS');
  // Living HQ: one setInterval is allowed — the 30s presence refresh —
  // and it must be visibility-gated and cleared on unmount.
  var intervalRefs = (hqSrc.match(/setInterval/g) || []).length;
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

  // 2. Check HermesPanels integration patterns
  console.log('\n── HermesPanels integration ──');
  assert(hqSrc.includes('__hqMount'), 'hq.js must expose __hqMount');
  assert(hqSrc.includes('__hqUnmount'), 'hq.js must expose __hqUnmount');

  // 3. Evaluate — transform import() expression for Node harness
  _createElementCalls = [];
  importCalls.length = 0;
  delete mainHqEl.dataset._3dMounted;
  mainHqEl._children = [];

  // Transform the dynamic-import expression so the Node harness
  // intercepts it without requiring caller-set __mockImport.
  // Production code uses `await import(MODULE_URL)` — replace with
  // call to `_dynamicImport` that the eval context provides.
  var evalBody = iifeBody.replace(
    /\bimport\s*\(\s*MODULE_URL\s*\)/g,
    '_dynamicImport(MODULE_URL)'
  );

  const evalFn = new Function(
    '_dynamicImport',
    'window', 'document', 'CustomEvent', 'console',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    evalBody
  );

  evalFn(
    mockImport,    // _dynamicImport = our mock
    globalThis, fakeDoc, FakeCustomEvent, console,
    setTimeout, clearTimeout, mockSetInterval, mockClearInterval
  );

  // 4. __hqMount accessible
  console.log('\n── __hqMount / __hqUnmount ──');
  assert(typeof globalThis.__hqMount === 'function', '__hqMount is a function');
  assert(typeof globalThis.__hqUnmount === 'function', '__hqUnmount is a function');
  assert(typeof globalThis.__hqLaunch3d === 'function', '__hqLaunch3d is a function');

  // 5. First mount renders 2D (sync, no import)
  console.log('\n── First mount (2D, no import) ──');
  var importBefore = importCalls.length;
  var intervalsBefore = intervalCalls.length;
  globalThis.__hqMount('hq');
  assert(importCalls.length === importBefore, 'first mount does NOT trigger import');
  assert(mainHqEl._children && mainHqEl._children.length > 0, 'mount renders content');

  // 5b. Mount arms the visibility-gated presence refresh (30s)
  console.log('\n── Presence refresh timer ──');
  assert(intervalCalls.length === intervalsBefore + 1, 'mount arms one interval timer');
  assert(intervalCalls[intervalCalls.length - 1].ms === 30000,
    'presence refresh interval is 30s (got ' + intervalCalls[intervalCalls.length - 1].ms + ')');

  // 6. Second mount refreshes presence, no re-import
  console.log('\n── Second mount (refresh, no import) ──');
  globalThis.__hqMount('hq');
  assert(importCalls.length === importBefore, 'second mount does NOT re-import');

  // 7. Unmount
  console.log('\n── Unmount ──');
  var clearedBefore = clearedIntervals.length;
  globalThis.__hqUnmount('hq');
  assert(clearedIntervals.length === clearedBefore + 1,
    'unmount clears the presence refresh interval');

  // 8. Idempotent unmount
  console.log('\n── Idempotent unmount ──');
  globalThis.__hqUnmount('hq');
  assert(true, 'double unmount does not throw');

  // 9. Re-mount after unmount
  console.log('\n── Re-mount after unmount ──');
  globalThis.__hqMount('hq');
  assert(importCalls.length === importBefore, 're-mount does not trigger import');

  return Promise.resolve();
}

runTests().then(function() {
  // Test 10: window.__mockImport attacker isolation (first-mount path)
  // Eval a fresh copy of the IIFE with attacker __mockImport set.
  // The fresh eval means _imported is false — the import code path runs.
  // Production MUST NOT call window.__mockImport.
  console.log('\n── __mockImport isolation (attacker override) ──');
  attackerImportCalled = false;

  // Set attacker override BEFORE eval so it's visible at mount time
  globalThis.__mockImport = function() {
    attackerImportCalled = true;
    return Promise.resolve({});
  };

  // Fresh eval of the IIFE with attacker __mockImport set
  importCalls.length = 0;
  var attackerBody = iifeBody.replace(
    /\bimport\s*\(\s*MODULE_URL\s*\)/g,
    '_dynamicImport(MODULE_URL)'
  );
  var attackerEvalFn = new Function(
    '_dynamicImport',
    'window', 'document', 'CustomEvent', 'console',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    attackerBody
  );
  attackerEvalFn(
    mockImport,    // _dynamicImport = our mock (should be used, NOT __mockImport)
    globalThis, fakeDoc, FakeCustomEvent, console,
    setTimeout, clearTimeout, mockSetInterval, mockClearInterval
  );

  return globalThis.__hqLaunch3d().then(function() {
    assert(!attackerImportCalled,
      'window.__mockImport must NOT be called (attacker override on fresh eval)');
    // Verify the real import mechanism was used instead
    var lastImport = importCalls[importCalls.length - 1] || '';
    assert(lastImport.indexOf('embodiment-bundle') !== -1,
      'launch3d uses real import, not attacker __mockImport');
    globalThis.__hqUnmount('hq');
    delete globalThis.__mockImport;
  });
}).then(function() {
  // ── Mount generation/epoch tests ──
  // Each test evals a fresh IIFE with a controlled mock import
  // to verify stale imports don't affect newer mounts.
  console.log('\n── Mount generation tests ──');

  // Helper: create a deferred promise
  function createDeferred() {
    var res, rej;
    var p = new Promise(function(resolve, reject) { res = resolve; rej = reject; });
    return { promise: p, resolve: res, reject: rej };
  }

  // Helper: fresh eval with custom _dynamicImport
  function evalWithImport(mockFn) {
    var body = iifeBody.replace(/\bimport\s*\(MODULE_URL\)/g, '_dynamicImport(MODULE_URL)');
    var fn = new Function(
      '_dynamicImport', 'window', 'document', 'CustomEvent', 'console',
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', body
    );
    fn(mockFn, globalThis, fakeDoc, FakeCustomEvent, console,
      setTimeout, clearTimeout, mockSetInterval, mockClearInterval);
  }

  // 11: __hqMount renders 2D immediately (no async import)
  var genTestsChain = (function testMountRenders2d() {
    evalWithImport(function() { return Promise.resolve({}); });
    mainHqEl.innerHTML = '<div id="original">ORIGINAL</div>';

    var result = globalThis.__hqMount('hq');
    assert(mainHqEl._children && mainHqEl._children.length > 0,
      'mount renders 2D HQ immediately');
    assert(result === undefined, 'mount does not return a promise');
    return Promise.resolve();
  })();

  // 12: __hqLaunch3d triggers import and mounts 3D
  genTestsChain = genTestsChain.then(function testLaunch3dImports() {
    var mountTaiLoftCalled = false;
    var importCount = 0;

    function genMock(url) {
      importCalls.push(url);
      importCount++;
      return Promise.resolve({
        mountTaiLoft: async function() {
          mountTaiLoftCalled = true;
          return function() {};
        },
      });
    }

    evalWithImport(genMock);
    mainHqEl.innerHTML = '<div id="original">ORIGINAL</div>';

    return globalThis.__hqLaunch3d().then(function() {
      assert(importCount === 1, 'launch3d triggers one import');
      assert(mountTaiLoftCalled, 'launch3d mounts 3D');
    });
  });

  // 13: launch3d renders 2D fallback when import fails
  genTestsChain = genTestsChain.then(function testLaunch3dFallback() {
    var importCount = 0;

    function genMock(url) {
      importCalls.push(url);
      importCount++;
      return Promise.reject(new Error('import failed'));
    }

    evalWithImport(genMock);
    mainHqEl.innerHTML = '<div id="original">ORIGINAL</div>';

    return globalThis.__hqLaunch3d().then(function() {
      assert(importCount === 1, 'launch3d tried import');
      assert(mainHqEl._children && mainHqEl._children.length > 0,
        'fallback renders 2D HQ after import failure');
    });
  });

  return genTestsChain;
}).then(function() {
  if (failures.length > 0) {
    console.error('FAILURES:');
    failures.forEach(f => console.error('  ✗ ' + f));
    process.exit(1);
  }
}).catch(err => {
  console.error('UNEXPECTED ERROR:', err);
  process.exit(1);
});
