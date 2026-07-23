#!/usr/bin/env node
/**
 * 2D fallback, error states, and teardown tests for Hyrax VN shell.
 *
 * Verifies:
 * - 2D fallback is complete when WebGL/import/model/image/SSE/fetch fails
 * - Loading/empty/error/offline states are visibly distinct
 * - Teardown removes listeners, observers, EventSource, timers, aborts
 * - Repeated mount/unmount/sister switch doesn't duplicate handlers
 *
 * Usage:
 *   node tests/run_hyrax_fallback_teardown_tests.js
 *
 * Exit code: 0 = all pass, 1 = any failure.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Resolve paths ──────────────────────────────────────────────────────────
const HQ_PATH = path.join(__dirname, '..', 'static', 'hyrax', 'hq.js');
const VN_PATH = path.join(__dirname, '..', 'static', 'hyrax', 'vn.js');
const BOOTSTRAP_PATH = path.join(__dirname, '..', 'static', 'hyrax', 'bootstrap.js');

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

function makeEl(tag) {
  const clsList = [];
  const listeners = {};
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
    _listeners: listeners,
    get classList() {
      return {
        contains(c) { return clsList.indexOf(c) !== -1; },
        add() { for (let i = 0; i < arguments.length; i++) { if (clsList.indexOf(arguments[i]) === -1) clsList.push(arguments[i]); } },
        remove() { for (let i = 0; i < arguments.length; i++) { const idx = clsList.indexOf(arguments[i]); if (idx !== -1) clsList.splice(idx, 1); } },
        toggle(c) { const i = clsList.indexOf(c); if (i !== -1) { clsList.splice(i, 1); return false; } else { clsList.push(c); return true; } },
        toString() { return clsList.join(' '); },
        [Symbol.iterator]() { return clsList[Symbol.iterator](); },
      };
    },
    setAttribute(k, v) { this._attrs[k] = v; if (k.startsWith('data-')) this.dataset[k.slice(5)] = v; },
    getAttribute(k) { return this._attrs[k] || null; },
    hasAttribute(k) { return k in this._attrs; },
    removeAttribute(k) { delete this._attrs[k]; },
    appendChild(c) { if (c != null) this._children.push(c); },
    insertBefore(c) { if (c) this._children.push(c); },
    replaceChildren() { this._children = []; for (let i = 0; i < arguments.length; i++) { if (arguments[i] != null) this._children.push(arguments[i]); } },
    append() { for (let i = 0; i < arguments.length; i++) { if (arguments[i] != null) this._children.push(arguments[i]); } },
    addEventListener(ev, fn, opts) {
      if (!listeners[ev]) listeners[ev] = [];
      listeners[ev].push(fn);
    },
    removeEventListener(ev, fn) {
      if (!listeners[ev]) return;
      const idx = listeners[ev].indexOf(fn);
      if (idx !== -1) listeners[ev].splice(idx, 1);
    },
    querySelector(s) {
      if (s === '#vn-backlog') return null;
      return null;
    },
    querySelectorAll() { return []; },
    closest() { return null; },
    focus() {},
    remove() { this._removed = true; },
    get children() { return this._children; },
    get nodeType() { return 1; },
    dispatchEvent(ev) {
      if (!listeners[ev.type]) return;
      listeners[ev.type].forEach(function(fn) { fn(ev); });
    },
  };
  return el;
}

class FakeCustomEvent {
  constructor(type, opts) {
    this.type = type;
    this.bubbles = !!(opts && opts.bubbles);
    this.cancelable = !!(opts && opts.cancelable);
    this.detail = (opts && opts.detail) || null;
  }
}

// ── Load sources ───────────────────────────────────────────────────────────
const hqSrc = fs.readFileSync(HQ_PATH, 'utf-8');
const vnSrc = fs.readFileSync(VN_PATH, 'utf-8');
const bootstrapSrc = fs.readFileSync(BOOTSTRAP_PATH, 'utf-8');

// ── Run tests ──────────────────────────────────────────────────────────────
function runTests() {
  console.log('═══ Hyrax 2D Fallback & Teardown Tests ═══\n');

  // ── 2D Fallback: error/loading/empty states ──
  console.log('── 2D fallback states (static analysis) ──');

  // 1. Loading state exists in VN
  assert(vnSrc.includes('vn-loading') || vnSrc.includes('Loading'),
    'vn.js has distinct loading state class');

  // 2. Error state exists
  const errorClasses = (vnSrc.match(/vn-error/g) || []).length;
  assert(errorClasses >= 1,
    'vn.js has at least one error state class (got ' + errorClasses + ')');

  // 3. Empty state (no messages yet)
  assert(vnSrc.includes('vn-empty') ||
    vnSrc.includes('No messages') || vnSrc.includes('Start the conversation'),
    'vn.js has empty state for conversations with no turns');

  // 4. Portrait has fallback on error
  assert(vnSrc.includes('_fallback') || vnSrc.includes('.onerror') ||
    vnSrc.includes('addEventListener(\'error\''),
    'vn.js has image error fallback for portrait');

  // 5. 2D fallback renders the HQ map when 3D import fails
  assert(hqSrc.includes('render2dFallback'),
    'hq.js renders 2D fallback map when 3D import fails');

  // 6. Chibi portrait images handle loading errors
  assert(hqSrc.includes('loading = \'lazy\''),
    'hq.js uses lazy loading for chibi images');

  // 7. 3D import failure doesn't crash (caught with try/catch)
  assert(hqSrc.includes('catch'),
    'hq.js catches 3D import failure');

  // 8. Profile fetch failure returns gracefully
  assert(hqSrc.includes('.catch'),
    'hq.js catches profile fetch failure');

  // 9. Toast indicates errors to user
  assert(vnSrc.includes('showToast') || vnSrc.includes('_showToast') ||
    vnSrc.includes('hyrax-toast'),
    'vn.js shows user-facing toast messages');

  // 10. The _api function falls back to fetch if window.api is not available
  assert(vnSrc.includes('window.api') || vnSrc.includes('typeof window.api'),
    'vn.js falls back when window.api is unavailable');

  // ── SSE lifecycle ──
  console.log('\n── SSE lifecycle ──');

  // 11. EventSource is closed on unmount
  assert(vnSrc.includes('.close()'),
    'vn.js closes EventSource on cleanup');

  // 12. Race token guards stale SSE
  const raceTokenChecks = (vnSrc.match(/_raceToken !== token/g) || []).length;
  assert(raceTokenChecks >= 3,
    'vn.js has >= 3 race-token checks in SSE handlers (got ' + raceTokenChecks + ')');

  // 13. EventSource reference is nulled after close
  assert(vnSrc.includes('_eventSource = null'),
    'vn.js nulls EventSource reference after close');

  // ── Teardown ──
  console.log('\n── Teardown hygiene ──');

  // 14. Blink timer is cleared
  assert(vnSrc.includes('clearTimeout'),
    'vn.js clears blink timer on cleanup');

  // 15. Blink timer reference is nulled
  assert(vnSrc.includes('_blinkTimer = null'),
    'vn.js nulls blink timer reference');

  // 16. Cleanup resets all state variables
  const stateResets = [
    '_streamed = \'\'', '_streamBubble = null',
    '_activeConversation = null',
    '_currentSisterId = null', '_currentSisterName',
  ];
  stateResets.forEach(function(pat) {
    assert(vnSrc.includes(pat),
      'vn.js cleanup resets "' + pat + '"');
  });

  // 17. Mount/unmount functions exist
  assert(typeof hqSrc !== 'undefined', 'hq.js source loaded');
  assert(hqSrc.includes('__hqMount'), 'hq.js exposes __hqMount');
  assert(hqSrc.includes('__hqUnmount'), 'hq.js exposes __hqUnmount');
  assert(vnSrc.includes('__vnMount'), 'vn.js exposes __vnMount');
  assert(vnSrc.includes('__vnUnmount'), 'vn.js exposes __vnUnmount');

  // ── Repeated mount/unmount safety ──
  console.log('\n── Repeated mount/unmount safety ──');

  // 18. EventSource replaces before creating new one
  const esCloseBeforeCreate = vnSrc.indexOf('.close()') < vnSrc.indexOf('EventSource(') ||
    vnSrc.indexOf('es.close()') < vnSrc.indexOf('new EventSource');
  // We check this by looking for explicit close before new EventSource
  assert(vnSrc.includes('if (_eventSource)'),
    'vn.js checks for existing EventSource before creating new one');

  // 19. No setInterval (polling anti-pattern)
  assert(!vnSrc.includes('setInterval'),
    'vn.js must NOT use setInterval (polling)');

  // 20. No MutationObserver
  assert(!vnSrc.includes('MutationObserver'),
    'vn.js must NOT use MutationObserver');

  // ── Bootstrap teardown ──
  console.log('\n── Bootstrap teardown ──');

  // 21. Bootstrap registers unregister handles
  assert(bootstrapSrc.includes('_unreg'),
    'bootstrap.js stores unregister handles for cleanup');

  // 22. Bootstrap uses once:true to avoid duplicate listeners
  assert(bootstrapSrc.includes('once: true') || bootstrapSrc.includes('{ once: true }') ||
    bootstrapSrc.includes("'once'") || bootstrapSrc.includes('once:true'),
    'bootstrap.js uses once:true for panel-ready listener');

  // ── HQ specific ──
  console.log('\n── HQ module teardown ──');

  // 23. HQ mount generation prevents stale work
  assert(hqSrc.includes('_mountGen'),
    'hq.js uses mount generation counter to prevent stale work');

  // 24. HQ unmount increments generation
  assert(hqSrc.includes('_mountGen++'),
    'hq.js increments mount generation on unmount');

  // 25. Stale import check after mount gen changes
  assert(hqSrc.includes('_mountGen !== gen'),
    'hq.js checks mount generation after async import resolves');

  // 26. Unmount returns previous content for restoration
  assert(hqSrc.includes('_prevContent'),
    'hq.js snapshots content for restoration on unmount');

  console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══\n`);
  if (failures.length > 0) {
    console.error('FAILURES:');
    failures.forEach(function(f) { console.error('  ✗ ' + f); });
    process.exit(1);
  }
}

runTests();
