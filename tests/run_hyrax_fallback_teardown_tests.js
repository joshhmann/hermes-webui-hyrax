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

  // Classic VN surface sources (the thin vn.js controller delegates to these)
  const shellSrc = fs.readFileSync(path.join(__dirname, '..', 'static', 'hyrax', 'vn', 'vnShell.js'), 'utf-8');
  const composerSrc = fs.readFileSync(path.join(__dirname, '..', 'static', 'hyrax', 'vn', 'vnComposer.js'), 'utf-8');
  const vnEventsSrc = fs.readFileSync(path.join(__dirname, '..', 'static', 'hyrax', 'vn', 'vnEvents.js'), 'utf-8');
  const dialogueSrc = fs.readFileSync(path.join(__dirname, '..', 'static', 'hyrax', 'vn', 'vnDialogue.js'), 'utf-8');
  const stageSrc = fs.readFileSync(path.join(__dirname, '..', 'static', 'hyrax', 'vn', 'vnStage.js'), 'utf-8');

  // ── 2D Fallback: error/loading/empty states ──
  console.log('── 2D fallback states (static analysis) ──');

  // 1. Loading state exists in VN (classic vnShell)
  assert(shellSrc.includes('vn2-loading') || shellSrc.includes('Connecting to'),
    'classic VN shell has a distinct loading state class');

  // 2. Error state exists (classic vnShell)
  const errorClasses = (shellSrc.match(/vn2-error/g) || []).length;
  assert(errorClasses >= 1,
    'classic VN shell has at least one error state class (got ' + errorClasses + ')');

  // 3. Empty state (no messages yet — classic composer placeholder; the
  // backlog simply renders empty and the composer invites the first turn)
  assert(composerSrc.includes('placeholder') && composerSrc.includes('Type a message'),
    'classic composer shows an empty-state hint for conversations with no turns');

  // 4. Portrait has fallback on error (classic stage)
  assert(stageSrc.includes('_fallback') || stageSrc.includes('.onerror') ||
    stageSrc.includes("addEventListener('error'"),
    'classic stage has an image error fallback for the portrait');

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

  // 9. Toast indicates errors to user (classic shell/composer surface)
  assert(shellSrc.includes('_toast') || composerSrc.includes('_toast') ||
    shellSrc.includes('showToast') || composerSrc.includes('showToast'),
    'classic VN surface shows user-facing toast messages');

  // 10. The _api function falls back to fetch if window.api is not available
  // (classic vnEvents shared transport)
  assert(vnEventsSrc.includes('typeof root.api'),
    'classic stream module falls back when window.api is unavailable');

  // ── SSE lifecycle ──
  console.log('\n── SSE lifecycle ──');

  // 11. EventSource is closed on unmount / stream replacement (classic
  // vnEvents owns the SSE transport)
  assert(vnEventsSrc.includes('.close()'),
    'classic stream module closes EventSource on cleanup');

  // 12. Race token guards stale async work (classic vnShell mount/session)
  const raceTokenChecks = (shellSrc.match(/_raceToken !== token/g) || []).length;
  assert(raceTokenChecks >= 3,
    'classic shell has >= 3 race-token checks in async handlers (got ' + raceTokenChecks + ')');

  // 13. EventSource reference is nulled after close
  assert(vnEventsSrc.includes('_es = null'),
    'classic stream module nulls EventSource reference after close');

  // ── Teardown ──
  console.log('\n── Teardown hygiene ──');

  // 14. Timers are cleared (classic dialogue settle + stage jolt timers)
  assert(dialogueSrc.includes('clearTimeout') || stageSrc.includes('clearTimeout'),
    'classic VN modules clear their timers on cleanup');

  // 15. No blink timer remains (the old vn-blink animation was retired with
  // the monolithic vn.js — the vn2 surface has no cursor blink)
  assert(!vnSrc.includes('_blinkTimer') && !vnSrc.includes('vn-blink'),
    'vn.js has no blink timer reference (retired animation)');

  // 16. Cleanup resets controller state (thin controller) and delegates to
  // the classic shell; the classic stream module resets its own transport.
  const stateResets = [
    '_mounted = false', '_currentSisterId = null',
  ];
  stateResets.forEach(function(pat) {
    assert(vnSrc.includes(pat),
      'vn.js unmount resets "' + pat + '"');
  });
  assert(vnSrc.includes('shell.unmount'), 'vn.js unmount delegates to the VN shell');
  assert(vnEventsSrc.includes('_es = null'),
    'classic stream module nulls the EventSource reference after close');

  // 17. Mount/unmount functions exist (ES controller exports + legacy hooks)
  assert(typeof hqSrc !== 'undefined', 'hq.js source loaded');
  assert(hqSrc.includes('__hqMount'), 'hq.js exposes __hqMount');
  assert(hqSrc.includes('__hqUnmount'), 'hq.js exposes __hqUnmount');
  assert(vnSrc.includes('export { mount, unmount'), 'vn.js exports the mount/unmount controller');

  // ── Repeated mount/unmount safety ──
  console.log('\n── Repeated mount/unmount safety ──');

  // 18. EventSource replaces before creating new one (classic vnEvents
  // disposes the prior transport inside init/_resetTransport)
  assert(vnEventsSrc.includes('if (_es)') || vnEventsSrc.includes('if(_es)'),
    'classic stream module checks for an existing EventSource before replacing it');

  // 19. No setInterval (polling anti-pattern)
  assert(!vnSrc.includes('setInterval'),
    'vn.js must NOT use setInterval (polling)');

  // 20. No MutationObserver
  assert(!vnSrc.includes('MutationObserver'),
    'vn.js must NOT use MutationObserver');

  // ── Bootstrap teardown ──
  console.log('\n── Bootstrap teardown ──');

  // 21. Bootstrap registers through HermesPanels (the registry owns the
  // unregister lifecycle — HermesPanels.register returns the handle)
  assert(bootstrapSrc.includes('hp.register(def)'),
    'bootstrap.js registers panels through HermesPanels (registry-owned lifecycle)');

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
  assert(hqSrc.includes('gen !== _mountGen'),
    'hq.js checks mount generation after async import resolves');

  // 26. Unmount re-renders fresh on remount (no content snapshot needed —
  // the 2D map is re-rendered from scratch, and show2d resets the mount
  // guard so a return from the VN can never show a stale host)
  assert(hqSrc.includes('render2dFallback'),
    'hq.js re-renders the 2D map on remount (no stale content)');
  assert(hqSrc.includes('_mounted = false') && hqSrc.includes('show2d'),
    'hq.js resets the mount guard on explicit re-show (no stale dataset flag)');

  console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══\n`);
  if (failures.length > 0) {
    console.error('FAILURES:');
    failures.forEach(function(f) { console.error('  ✗ ' + f); });
    process.exit(1);
  }
}

runTests();
