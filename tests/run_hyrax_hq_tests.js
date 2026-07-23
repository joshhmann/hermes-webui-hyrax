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
  assert(!hqSrc.includes('setInterval'), 'hq.js must NOT use polling (setInterval)');
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
    'setTimeout', 'clearTimeout',
    evalBody
  );

  evalFn(
    mockImport,    // _dynamicImport = our mock
    globalThis, fakeDoc, FakeCustomEvent, console,
    setTimeout, clearTimeout
  );

  // 4. __hqMount accessible
  console.log('\n── __hqMount / __hqUnmount ──');
  assert(typeof globalThis.__hqMount === 'function', '__hqMount is a function');
  assert(typeof globalThis.__hqUnmount === 'function', '__hqUnmount is a function');

  // 5. First mount triggers import
  console.log('\n── First mount (lazy import) ──');
  // Install mock import before mounting
  var importBefore = importCalls.length;
  return globalThis.__hqMount('hq').then(function() {
    assert(importCalls.length > importBefore, 'first mount triggers dynamic import');
    const importCall = importCalls[importCalls.length - 1] || '';
    assert(importCall.includes('embodiment-bundle'), 'imports embodiment-bundle.js');

    // 6. Second mount does NOT re-import
    console.log('\n── Second mount (no re-import) ──');
    const importCount = importCalls.length;
    return globalThis.__hqMount('hq').then(() => {
      assert(importCalls.length === importCount, 'second mount does NOT re-import');

      // 7. Unmount
      console.log('\n── Unmount ──');
      globalThis.__hqUnmount('hq');

      // 8. Idempotent unmount
      console.log('\n── Idempotent unmount ──');
      globalThis.__hqUnmount('hq'); // Second call should be no-op
      assert(true, 'double unmount does not throw');

      // 9. Re-mount after unmount
      console.log('\n── Re-mount after unmount ──');
      const importAfterUnmount = importCalls.length;
      return globalThis.__hqMount('hq').then(() => {
        // Should not re-import (module is cached in memory)
        assert(importCalls.length === importAfterUnmount, 're-mount does not re-import cached module');
      });
    });
  });
} // end of inner-most chain exposed for the attacker test below

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
    'setTimeout', 'clearTimeout',
    attackerBody
  );
  attackerEvalFn(
    mockImport,    // _dynamicImport = our mock (should be used, NOT __mockImport)
    globalThis, fakeDoc, FakeCustomEvent, console,
    setTimeout, clearTimeout
  );

  return globalThis.__hqMount('hq').then(function() {
    assert(!attackerImportCalled,
      'window.__mockImport must NOT be called (attacker override on fresh eval)');
    // Verify the real import mechanism was used instead
    var lastImport = importCalls[importCalls.length - 1] || '';
    assert(lastImport.indexOf('embodiment-bundle') !== -1,
      'import must be through _dynamicImport, not __mockImport');
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
      'setTimeout', 'clearTimeout', body
    );
    fn(mockFn, globalThis, fakeDoc, FakeCustomEvent, console, setTimeout, clearTimeout);
  }

  // 11: Unmount before import resolve → stale doesn't mount
  var genTestsChain = (function testUnmountBeforeImportResolve() {
    var deferred = createDeferred();
    var mountTaiLoftCalled = false;
    var importCount = 0;

    function genMock(url) {
      importCalls.push(url);
      importCount++;
      if (importCount === 1) return deferred.promise;
      return Promise.resolve({
        mountTaiLoft: async function() {
          mountTaiLoftCalled = true;
          return function() {};
        },
      });
    }

    evalWithImport(genMock);
    mainHqEl.innerHTML = '<div id="original">ORIGINAL</div>';

    // Mount starts slow import
    var mountPromise = globalThis.__hqMount('hq');
    assert(mainHqEl.innerHTML.indexOf('Loading Division HQ') !== -1,
      'mount sets loading state');

    // Unmount before import resolves
    globalThis.__hqUnmount('hq');

    // Resolve the deferred (slow import completes after unmount)
    deferred.resolve({
      mountTaiLoft: async function() {
        mountTaiLoftCalled = true;
        return function() {};
      },
    });

    return mountPromise.then(function() {
      assert(!mountTaiLoftCalled,
        'stale import after unmount must NOT call mountTaiLoft');
      assert(mainHqEl.innerHTML.indexOf('Loading') !== -1,
        'stale import must not overwrite content with fallback');
    });
  })();

  // 12: Unmount+remount → old import resolves after new gen renders 2D
  genTestsChain = genTestsChain.then(function testUnmountRemountThenOldImport() {
    var deferred = createDeferred();
    var mountTaiLoftCalled = 0;
    var importCount = 0;

    function genMock2(url) {
      importCalls.push(url);
      importCount++;
      if (importCount === 1) return deferred.promise;
      // Second call instant success (but won't be invoked since _imported is true)
      return Promise.resolve({
        mountTaiLoft: async function() {
          mountTaiLoftCalled++;
          return function() {};
        },
      });
    }

    evalWithImport(genMock2);
    mainHqEl.innerHTML = '<div id="original">ORIGINAL</div>';

    // Mount gen=1 — starts slow import, _imported = true
    var mount1 = globalThis.__hqMount('hq');
    assert(importCount === 1, 'gen=1 triggers one import');

    // Unmount — gen becomes stale, _imported still true
    globalThis.__hqUnmount('hq');

    // Remount gen=2 — _imported=true, skips import block, renders 2D fallback
    var mount2 = globalThis.__hqMount('hq');

    // Now resolve the old deferred — gen=1 import completes
    deferred.resolve({
      mountTaiLoft: async function() {
        mountTaiLoftCalled++;
        return function() {};
      },
    });

    return Promise.all([mount1, mount2]).then(function() {
      // gen=1 was stale — must NOT call mountTaiLoft
      assert(mountTaiLoftCalled === 0,
        'stale gen=1 must NOT call mountTaiLoft (got ' + mountTaiLoftCalled + ')');
      // gen=2 renders 2D fallback (skip import) — content should show HQ page
      assert(importCount === 1,
        'only one import call (gen=2 skips import, uses 2D fallback)');
    });
  });

  // 13: Stale import rejects after new mount → 2D fallback preserved
  genTestsChain = genTestsChain.then(function testStaleRejectAfterNewMount() {
    var deferred = createDeferred();
    var mountTaiLoftCalled = false;
    var importCount = 0;

    function genMock3(url) {
      importCalls.push(url);
      importCount++;
      if (importCount === 1) return deferred.promise;
      return Promise.resolve({
        mountTaiLoft: async function() {
          mountTaiLoftCalled = true;
          return function() {};
        },
      });
    }

    evalWithImport(genMock3);
    mainHqEl.innerHTML = '<div id="original">ORIGINAL</div>';

    // Mount gen=1 — starts slow import
    var mount1 = globalThis.__hqMount('hq');
    assert(mainHqEl.innerHTML.indexOf('Loading') !== -1, 'mount1 shows loading');

    // Remount gen=2 — _imported=true, renders 2D fallback
    globalThis.__hqUnmount('hq');
    var mount2 = globalThis.__hqMount('hq');

    // Gen=1 import REJECTS after gen=2 fallback is active
    deferred.reject(new Error('stale failure'));

    return mount1.then(function() {
      // Gen=1 rejection caught — must NOT overwrite gen=2's fallback
      // Gen=2 rendered fallback (no mountTaiLoft since _imported=true)
      assert(!mountTaiLoftCalled,
        'gen=1 rejection must NOT trigger mount side effects');
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
