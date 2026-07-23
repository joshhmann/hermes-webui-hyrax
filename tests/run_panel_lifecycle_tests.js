#!/usr/bin/env node
/**
 * Execution-level Node harness for window.HermesPanels.
 *
 * Sets up a minimal fake DOM (no jsdom/npm) and evaluates the
 * HermesPanels block from panels.js to test runtime contract behaviour.
 * Accepts an optional --path=<panels.js> argument.
 *
 * Usage:
 *   node tests/run_panel_lifecycle_tests.js
 *   node tests/run_panel_lifecycle_tests.js --path=/path/to/panels.js
 *
 * Exit code: 0 = all pass, 1 = any failure.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Resolve panels.js path ────────────────────────────────────────────────
const PANELS_ARG = process.argv.find(a => a.startsWith('--path='));
const PANELS_PATH = PANELS_ARG
  ? PANELS_ARG.slice('--path='.length)
  : path.join(__dirname, '..', 'static', 'panels.js');

// ── Helpers ────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

// Track hermes:panel-ready dispatch (fires via setTimeout(0) after eval)
let _readyEventFired = false;

function assert(ok, msg) {
  if (ok) { passed++; return; }
  failed++;
  const e = new Error();
  const stack = (e.stack || '').split('\n').slice(2, 4).join(' → ').trim();
  failures.push(`${msg}  [${stack || '?'}]`);
}

// ── Minimal fake DOM ──────────────────────────────────────────────────────
const dispatchedEvents = [];

class FakeCustomEvent {
  constructor(type, opts = {}) {
    this.type = type;
    this.bubbles = !!opts.bubbles;
    this.cancelable = !!opts.cancelable;
    this.detail = opts.detail || null;
  }
}

const fakeDoc = {
  _listeners: {},
  createElement(tag) {
    return { tagName: tag, className: '', textContent: '', style: {}, hidden: false, _children: [] };
  },
  createTextNode(t) {
    return { textContent: String(t) };
  },
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return { forEach() {} }; },
  addEventListener(ev, fn) {
    if (!this._listeners[ev]) this._listeners[ev] = [];
    this._listeners[ev].push(fn);
  },
  dispatchEvent(ev) {
    dispatchedEvents.push(ev);
    const arr = this._listeners[ev.type];
    if (arr) arr.forEach(fn => fn(ev));
  },
};

// ── Shared test context ───────────────────────────────────────────────────
const ctx = {
  // DOM
  window: globalThis,
  document: fakeDoc,
  CustomEvent: FakeCustomEvent,
  console: { warn(msg) { process.stderr.write('[HermesPanels] ' + msg + '\n'); }, log() {}, error() {} },
  setTimeout: setTimeout,

  // Core panel structures
  APP_TITLEBAR_KEYS: {
    chat: 'tab_chat', tasks: 'tab_tasks', skills: 'tab_skills',
    memory: 'tab_memory', workspaces: 'tab_workspaces',
    profiles: 'tab_profiles', todos: 'tab_todos', insights: 'tab_insights',
    logs: 'tab_logs', settings: 'tab_settings',
  },
  MAIN_VIEW_PANELS: ['settings','skills','memory','tasks','kanban',
    'workspaces','profiles','insights','logs','plugin'],
  MAIN_VIEW_SIDEBAR_PANEL_FALLBACKS: { plugin: 'settings' },

  // Runtime state
  _currentPanel: 'chat',
  $() { return null; },

  // switchPanel stub — verifies plumbing
  _switchPanelCalls: [],
  switchPanel(name, opts) {
    this._switchPanelCalls.push({ name: name || 'chat', opts: opts || {} });
    const nextPanel = name || 'chat';
    const prevPanel = this._currentPanel;
    if (prevPanel !== nextPanel) {
      if (typeof this._callExtensionUnmountHook === 'function')
        this._callExtensionUnmountHook(prevPanel);
    }
    this._currentPanel = nextPanel;
    if (prevPanel !== nextPanel) {
      if (typeof this._callExtensionMountHook === 'function')
        this._callExtensionMountHook(nextPanel);
    }
    return Promise.resolve(true);
  },
};

// Also expose ctx symbols as globals for the evaluated code
function setupGlobals() {
  for (const [k, v] of Object.entries(ctx)) {
    if (k === 'console') continue; // preserve real console
    globalThis[k] = v;
  }
}
setupGlobals();

// ── Extract HermesPanels block from panels.js ──────────────────────────────
function extractHermesPanels(src) {
  const marker = '// ── Extension panel registry / lifecycle ──';
  const start = src.indexOf(marker);
  if (start === -1) throw new Error('HermesPanels block marker not found');

  const assignMarker = 'window.HermesPanels =';
  const assignPos = src.indexOf(assignMarker, start);
  if (assignPos === -1) throw new Error('window.HermesPanels assignment not found');

  // Find the opening { of the assignment
  const brace = src.indexOf('{', assignPos);
  if (brace === -1) throw new Error('HermesPanels opening brace not found');

  // Track depth from the opening brace
  let depth = 1;
  let i = brace + 1;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  if (depth !== 0) throw new Error('HermesPanels block braces unbalanced');

  // Also capture the setTimeout(0) ready-event dispatch that follows
  // the HermesPanels assignment (outside the object literal).
  // Skip `};` and any whitespace/comment lines before setTimeout.
  let end = i;
  let rest = src.slice(i);
  // Find `setTimeout` in the remaining source
  let stPos = rest.indexOf('setTimeout');
  if (stPos !== -1 && stPos < 500) {
    // Confirm this is the ready-event dispatch by checking for 'panel-ready'
    // near this setTimeout (within the next 200 chars).
    let stArea = rest.slice(stPos, stPos + 200);
    if (stArea.indexOf('hermes:panel-ready') !== -1) {
      // Find the closing of setTimeout(..., 0);
      // The function body starts after setTimeout(function() {
      let fnStart = rest.indexOf('{', stPos + 9); // after 'setTimeout'
      if (fnStart !== -1 && fnStart < stPos + 100) {
        // Count braces to find the matching } of the function body
        let bDepth = 1;
        let bIdx = fnStart + 1;
        while (bIdx < rest.length && bDepth > 0) {
          if (rest[bIdx] === '{') bDepth++;
          else if (rest[bIdx] === '}') bDepth--;
          bIdx++;
        }
        if (bDepth === 0) {
          // The `}, 0);` follows the function body's `}`
          // Find the `);` after the `}` — that's the setTimeout close
          let closeParen = rest.indexOf(');', bIdx);
          if (closeParen !== -1 && closeParen < bIdx + 20) {
            end = i + closeParen + 2;
          }
        }
      }
    }
  }

  return src.slice(start, end);
}

// ── Extract syncAppTitlebar function from panels.js ─────────────────────────
// Extracts the standalone production syncAppTitlebar() function declaration
// as a string so it can be eval'd alongside the HermesPanels block.
function extractSyncAppTitlebar(src) {
  const marker = 'function syncAppTitlebar()';
  const pos = src.indexOf(marker);
  if (pos === -1) throw new Error('syncAppTitlebar function not found');

  const brace = src.indexOf('{', pos);
  if (brace === -1) throw new Error('syncAppTitlebar opening brace not found');

  let depth = 1;
  let i = brace + 1;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  if (depth !== 0) throw new Error('syncAppTitlebar function braces unbalanced');

  return src.slice(pos, i);
}

// ── Run tests ──────────────────────────────────────────────────────────────
function runTests() {
  console.log('═══ HermesPanels Execution Tests ═══\n');

  // 1. Validation tests
  console.log('── Validation ──');
  assert(typeof ctx.window.HermesPanels === 'object', 'HermesPanels is an object');
  assert(typeof ctx.window.HermesPanels.register === 'function', 'register is a function');

  // null/undefined def
  try { ctx.window.HermesPanels.register(null); assert(false, 'null def should throw'); }
  catch (e) { assert(true, 'null def rejected'); }

  try { ctx.window.HermesPanels.register(undefined); assert(false, 'undefined def should throw'); }
  catch (e) { assert(true, 'undefined def rejected'); }

  try { ctx.window.HermesPanels.register(42); assert(false, 'number def should throw'); }
  catch (e) { assert(true, 'number def rejected'); }

  try { ctx.window.HermesPanels.register('string'); assert(false, 'string def should throw'); }
  catch (e) { assert(true, 'string def rejected'); }

  // id validation
  try { ctx.window.HermesPanels.register({ label: 'X' }); assert(false, 'empty id should throw'); }
  catch (e) { assert(true, 'empty id rejected'); }

  try { ctx.window.HermesPanels.register({ id: '', label: 'X' }); assert(false, 'blank id should throw'); }
  catch (e) { assert(true, 'blank id rejected'); }

  try { ctx.window.HermesPanels.register({ id: 'UPPER', label: 'X' }); assert(false, 'upper id should throw'); }
  catch (e) { assert(true, 'uppercase id rejected'); }

  try { ctx.window.HermesPanels.register({ id: 'has space', label: 'X' }); assert(false, 'space id should throw'); }
  catch (e) { assert(true, 'spaces in id rejected'); }

  try { ctx.window.HermesPanels.register({ id: 'a', label: 'X' }); assert(true, 'short alnum id accepted'); }
  catch (e) { assert(false, 'short alnum id should be accepted: ' + e.message); }

  // label validation
  try { ctx.window.HermesPanels.register({ id: 'no-label', label: '' }); assert(false, 'empty label should throw'); }
  catch (e) { assert(true, 'empty label rejected'); }

  try { ctx.window.HermesPanels.register({ id: 'long-label', label: 'x'.repeat(65) }); assert(false, 'label >64 should throw'); }
  catch (e) { assert(true, 'label >64 rejected'); }

  // Reset: unregister the two we created
  let unreg;
  const hp = ctx.window.HermesPanels;

  // 2. Core collision
  console.log('\n── Core collision ──');
  for (const coreId of ['chat', 'tasks', 'settings', 'plugin']) {
    try {
      hp.register({ id: coreId, label: 'Collide' });
      assert(false, `"${coreId}" should collide with core`);
    } catch (e) {
      assert(true, `"${coreId}" core collision detected`);
    }
  }

  // 3. Duplicate rejection
  console.log('\n── Duplicate rejection ──');
  unreg = hp.register({ id: 'test-dupe', label: 'First' });
  assert(typeof unreg === 'function', 'register returns a function');
  try {
    hp.register({ id: 'test-dupe', label: 'Second' });
    assert(false, 'duplicate id should throw');
  } catch (e) {
    assert(true, 'duplicate id rejected');
  }
  unreg(); // clean up
  // Re-register after unregister should work
  const reReg = hp.register({ id: 'test-dupe', label: 'Re-reg' });
  assert(typeof reReg === 'function', 're-register after unregister works');

  // 4. Frozen metadata
  console.log('\n── Frozen metadata ──');
  const metaReg = hp.register({ id: 'test-meta', label: 'Meta', mount() {}, unmount() {} });
  assert(typeof metaReg === 'function', 'register with hooks returns unregister');
  // The frozen meta is stored internally, so we check it indirectly by verifying
  // that the registration was accepted and the panel is in MAIN_VIEW_PANELS
  assert(ctx.MAIN_VIEW_PANELS.indexOf('test-meta') !== -1, 'test-meta in MAIN_VIEW_PANELS');
  metaReg();

  // 5. List / fallback / title label integration
  console.log('\n── Integration ──');
  const savedKeysLen = Object.keys(ctx.APP_TITLEBAR_KEYS).length;
  const savedMvpLen = ctx.MAIN_VIEW_PANELS.length;
  const savedSfLen = Object.keys(ctx.MAIN_VIEW_SIDEBAR_PANEL_FALLBACKS).length;

  const i1 = hp.register({ id: 'test-ext1', label: 'Ext One' });
  assert(ctx.APP_TITLEBAR_KEYS['test-ext1'] === 'Ext One', 'APP_TITLEBAR_KEYS extended');
  assert(ctx.MAIN_VIEW_PANELS.indexOf('test-ext1') !== -1, 'MAIN_VIEW_PANELS extended (default mainView)');
  assert(Object.keys(ctx.APP_TITLEBAR_KEYS).length === savedKeysLen + 1, 'titlebar keys count +1');

  const i2 = hp.register({ id: 'test-ext2', label: 'Ext Two', mainView: false });
  assert(ctx.MAIN_VIEW_PANELS.indexOf('test-ext2') === -1, 'mainView=false: not in MAIN_VIEW_PANELS');
  assert(ctx.APP_TITLEBAR_KEYS['test-ext2'] === 'Ext Two', 'APP_TITLEBAR_KEYS still extended');

  const i3 = hp.register({ id: 'test-ext3', label: 'Ext Three', sidebarFallback: 'settings' });
  assert(ctx.MAIN_VIEW_PANELS.indexOf('test-ext3') !== -1, 'mainView default: in MAIN_VIEW_PANELS');
  assert(ctx._EXT_SIDEBAR_FALLBACKS['test-ext3'] === 'settings', 'sidebarFallback stored');

  i1(); i2(); i3();
  assert(ctx.MAIN_VIEW_PANELS.indexOf('test-ext1') === -1, 'unregister removes from MAIN_VIEW_PANELS');
  assert(ctx.APP_TITLEBAR_KEYS['test-ext1'] === undefined, 'unregister removes from APP_TITLEBAR_KEYS');
  assert(Object.keys(ctx.APP_TITLEBAR_KEYS).length === savedKeysLen, 'titlebar keys count restored');

  // 6. Mount / unmount hooks
  console.log('\n── Mount/unmount hooks ──');
  const mountCalls = [];
  const unmountCalls = [];
  const mReg = hp.register({
    id: 'test-hooks',
    label: 'Hooks',
    mount(id) { mountCalls.push(id); },
    unmount(id) { unmountCalls.push(id); },
  });

  // Direct hook invocation test
  ctx._callExtensionUnmountHook('test-hooks');
  assert(unmountCalls.length === 1, 'unmount called by _callExtensionUnmountHook');
  assert(unmountCalls[0] === 'test-hooks', 'unmount called with correct id');

  ctx._callExtensionMountHook('test-hooks');
  assert(mountCalls.length === 1, 'mount called by _callExtensionMountHook');
  assert(mountCalls[0] === 'test-hooks', 'mount called with correct id');

  // switchPanel plumbed test
  ctx.switchPanel('test-hooks');
  assert(ctx._currentPanel === 'test-hooks', 'switchPanel changes _currentPanel');
  assert(mountCalls.length === 2, 'mount called by switchPanel');
  assert(mountCalls[1] === 'test-hooks', 'mount called with correct id in switchPanel');

  ctx.switchPanel('chat');
  assert(ctx._currentPanel === 'chat', 'switchPanel back to chat');
  assert(unmountCalls.length === 2, 'unmount called by switchPanel');
  assert(unmountCalls[1] === 'test-hooks', 'unmount called with correct id');

  mReg();

  // 7. Same-panel no-op
  console.log('\n── Same-panel no-op ──');
  const mountCalls2 = [];
  const unmountCalls2 = [];
  const sReg = hp.register({
    id: 'test-same',
    label: 'Same',
    mount(id) { mountCalls2.push(id); },
    unmount(id) { unmountCalls2.push(id); },
  });
  ctx.switchPanel('test-same');
  const mBefore = mountCalls2.length;
  const uBefore = unmountCalls2.length;
  ctx.switchPanel('test-same'); // Same-panel switch
  assert(mountCalls2.length === mBefore, 'same-panel: no mount call');
  assert(unmountCalls2.length === uBefore, 'same-panel: no unmount call');

  // Switch back to clean up
  ctx.switchPanel('chat');
  sReg();

  // 8. Rejected hook isolation + sanitized event
  console.log('\n── Hook error isolation ──');
  const errEvents = [];
  const mountEvents = [];
  const origDispatch = fakeDoc.dispatchEvent.bind(fakeDoc);
  fakeDoc.dispatchEvent = function(ev) {
    if (ev.type === 'hermes:panel-hook-error') errEvents.push(ev);
    if (ev.type === 'hermes:panel-mounted') mountEvents.push(ev);
    return origDispatch(ev);
  };

  const eReg = hp.register({
    id: 'test-error',
    label: 'Error',
    mount() { throw new Error('mount fail'); },
    unmount() { throw new Error('unmount fail'); },
  });

  // Trigger mount (will throw, but should be caught)
  ctx._callExtensionMountHook('test-error');
  assert(errEvents.length >= 1, 'hook-error event dispatched on mount throw');
  if (errEvents.length > 0) {
    assert(errEvents[errEvents.length - 1].detail.id === 'test-error', 'error event detail.id');
    assert(errEvents[errEvents.length - 1].detail.phase === 'mount', 'error event detail.phase');
  }

  // Trigger unmount
  const errBefore = errEvents.length;
  ctx._callExtensionUnmountHook('test-error');
  assert(errEvents.length === errBefore + 1, 'hook-error event dispatched on unmount throw');
  if (errEvents.length > errBefore) {
    assert(errEvents[errEvents.length - 1].detail.phase === 'unmount', 'unmount error detail.phase');
  }

  eReg();
  fakeDoc.dispatchEvent = origDispatch; // restore

  // 9. Ready event
  console.log('\n── Ready event ──');
  const readyEvents = [];
  fakeDoc.addEventListener('hermes:panel-ready', ev => readyEvents.push(ev));
  const rReg = hp.register({ id: 'test-ready', label: 'Ready' });
  // The ready event is dispatched via setTimeout(0), so it may be async.
  // We check synchronously here; setTimeout(0) won't have fired yet.
  // Instead, we verify the event setup by checking the code dispatches it.
  assert(typeof rReg === 'function', 'ready registration works');
  // Verify by checking setTimeout-delayed dispatch
  // (We can't easily test async here, but the static test confirms the source)
  assert(readyEvents.length === 0,
    'ready event dispatched via setTimeout(0) — async, not immediate');
  rReg();

  // 10. Unregister while active
  console.log('\n── Unregister while active ──');
  const switchCallsBefore = ctx._switchPanelCalls.length;
  const aReg = hp.register({ id: 'test-active', label: 'Active' });
  ctx.switchPanel('test-active');
  assert(ctx._currentPanel === 'test-active', 'switched to test-active');
  aReg(); // Unregister while active
  assert(ctx.APP_TITLEBAR_KEYS['test-active'] === undefined, 'unregister removes titlebar key');
  assert(ctx.MAIN_VIEW_PANELS.indexOf('test-active') === -1, 'unregister removes from MAIN_VIEW_PANELS');
  // 11. Unregister idempotence
  console.log('\n── Unregister idempotence ──');
  const idemReg = hp.register({ id: 'test-idem', label: 'Idem' });
  idemReg(); // First call — should work
  // Second call — should be no-op
  try {
    idemReg();
    assert(true, 'second unregister call is safe (no-op)');
  } catch (e) {
    assert(false, 'second unregister call threw: ' + e.message);
  }
  // Make sure the registry is clean
  assert(ctx.MAIN_VIEW_PANELS.indexOf('test-idem') === -1, 'test-idem not in MAIN_VIEW_PANELS after unregister');
  // Can re-register the same id after unregister
  const reReg2 = hp.register({ id: 'test-idem', label: 'Idem2' });
  assert(typeof reReg2 === 'function', 're-register after full unregister works');
  reReg2();

  // 12. switchPanel identity
  console.log('\n── switchPanel identity ──');
  // Check that the switchPanel stub was not reassigned by the HermesPanels code
  const switchRefBefore = typeof ctx.switchPanel;
  // Re-test by checking the HermesPanels code doesn't reassign it
  // (verified by static test; here we just confirm it still works)
  assert(typeof ctx.switchPanel === 'function', 'switchPanel still a function');

  // 13. Generic error logging — no raw err in console.warn
  console.log('\n── Error logging sanitation ──');
  (function() {
    const warnArgs = [];
    const origWarn = console.warn;
    console.warn = function() { warnArgs.push(Array.from(arguments)); };

    // Clean up any previously registered panel from other tests
    // Register a new panel with a sync hook that throws
    const cleanupE = hp.register({
      id: 'test-errlog',
      label: 'ErrLog',
      mount() { throw new TypeError('SENSITIVE_STACK'); },
    });
    // Trigger mount hook — should warn
    ctx._callExtensionMountHook('test-errlog');
    // Restore console
    console.warn = origWarn;

    // Check each captured warn call
    for (const args of warnArgs) {
      assert(args.length <= 1, 'console.warn must not receive err as second argument (got ' + args.length + ' args)');
      if (args[0] && typeof args[0] === 'string') {
        assert(args[0].indexOf('SENSITIVE_STACK') === -1,
          'console.warn must not contain error message content');
        assert(args[0].indexOf('test-errlog') !== -1 || args[0].indexOf('mount') !== -1,
          'console.warn must mention validated id and phase');
      }
    }
    cleanupE();
  })();

  // 14. Strict hook validation — own property with invalid type throws
  console.log('\n── Strict hook validation ──');
  assert(!ctx._EXT_IDS.has('test-hook-ownprop'), 'precondition: test-hook-ownprop not registered');
  try {
    hp.register({ id: 'test-hook-ownprop', label: 'HO', mount: 'not-a-function' });
    assert(false, 'mount="string" should throw (own property, invalid type)');
  } catch (e) {
    assert(true, 'mount="string" rejected: ' + e.message);
  }
  assert(!ctx._EXT_IDS.has('test-hook-ownprop'), 'no registry mutation after mount type rejection');
  assert(ctx.APP_TITLEBAR_KEYS['test-hook-ownprop'] === undefined, 'no titlebar key after mount type rejection');

  try {
    hp.register({ id: 'test-hook-ownprop2', label: 'HO2', unmount: 42 });
    assert(false, 'unmount=number should throw');
  } catch (e) {
    assert(true, 'unmount=number rejected: ' + e.message);
  }
  assert(!ctx._EXT_IDS.has('test-hook-ownprop2'), 'no registry entry after unmount type rejection');

  // Own property with function still works
  try {
    const okReg = hp.register({ id: 'test-hook-ok', label: 'OK', mount() {}, unmount() {} });
    assert(true, 'hook function accepted');
    okReg();
  } catch (e) {
    assert(false, 'hook function should be accepted: ' + e.message);
  }

  // 15. Strict definition types
  console.log('\n── Strict definition types ──');
  // id must be string
  try {
    hp.register({ id: 123, label: 'NumId' });
    assert(false, 'numeric id should throw');
  } catch (e) {
    assert(true, 'numeric id rejected: ' + e.message);
  }
  try {
    hp.register({ id: { toString() { return 'side-effect'; } }, label: 'ObjId' });
    assert(false, 'object id should throw (no toString coercion)');
  } catch (e) {
    assert(true, 'object id rejected: ' + e.message);
  }

  // label must be string
  try {
    hp.register({ id: 'str-label', label: 42 });
    assert(false, 'numeric label should throw');
  } catch (e) {
    assert(true, 'numeric label rejected: ' + e.message);
  }
  try {
    hp.register({ id: 'str-label2', label: { toString() { return 'side-effect'; } } });
    assert(false, 'object label should throw (no toString coercion)');
  } catch (e) {
    assert(true, 'object label rejected: ' + e.message);
  }

  // mainView if supplied must be boolean
  try {
    hp.register({ id: 'str-mainview', label: 'MV', mainView: 'yes' });
    assert(false, 'string mainView should throw');
  } catch (e) {
    assert(true, 'string mainView rejected: ' + e.message);
  }
  try {
    hp.register({ id: 'str-mainview2', label: 'MV2', mainView: 1 });
    assert(false, 'numeric mainView should throw');
  } catch (e) {
    assert(true, 'numeric mainView rejected: ' + e.message);
  }

  // 16. sidebarFallback strict validation
  console.log('\n── sidebarFallback validation ──');
  // Self-referencing sidebarFallback rejected
  try {
    hp.register({ id: 'test-sf-self', label: 'SFSelf', sidebarFallback: 'test-sf-self' });
    assert(false, 'self-referencing sidebarFallback should throw');
  } catch (e) {
    assert(true, 'self-referencing sidebarFallback rejected: ' + e.message);
  }
  assert(!ctx._EXT_IDS.has('test-sf-self'), 'no registry entry after self-referencing sidebarFallback');
  assert(ctx._EXT_SIDEBAR_FALLBACKS['test-sf-self'] === undefined, 'no sidebar fallback stored after self-ref rejection');

  // Invalid format sidebarFallback rejected
  try {
    hp.register({ id: 'test-sf-bad', label: 'SFBad', sidebarFallback: 'UPPERCASE' });
    assert(false, 'UPPERCASE sidebarFallback should throw');
  } catch (e) {
    assert(true, 'UPPERCASE sidebarFallback rejected: ' + e.message);
  }

  // sidebarFallback null/undefined should be accepted (valid omission)
  try {
    const noSfReg = hp.register({ id: 'test-sf-none', label: 'SFNone' });
    assert(true, 'no sidebarFallback accepted');
    noSfReg();
  } catch (e) {
    assert(false, 'no sidebarFallback should be accepted: ' + e.message);
  }

  // sidebarFallback string with spaces should be rejected
  try {
    hp.register({ id: 'test-sf-space', label: 'SFSpace', sidebarFallback: 'has space' });
    assert(false, 'sidebarFallback with spaces should throw');
  } catch (e) {
    assert(true, 'sidebarFallback with spaces rejected: ' + e.message);
  }

  // Valid sidebarFallback (core panel) accepted
  try {
    const sfCoreReg = hp.register({
      id: 'test-sf-valid', label: 'SFValid', sidebarFallback: 'settings'
    });
    assert(true, 'sidebarFallback to core panel accepted');
    assert(ctx._EXT_SIDEBAR_FALLBACKS['test-sf-valid'] === 'settings',
      'sidebarFallback stored correctly');
    sfCoreReg();
  } catch (e) {
    assert(false, 'valid sidebarFallback should be accepted: ' + e.message);
  }

  // 17. Ready event — register must NOT fire it
  console.log('\n── Ready event semantics ──');
  (function() {
    const readyEvents = [];
    fakeDoc.addEventListener('hermes:panel-ready', ev => readyEvents.push(ev));

    // Register a panel — should NOT fire hermes:panel-ready
    const r1Reg = hp.register({ id: 'test-ready-no', label: 'NoReady' });
    assert(readyEvents.length === 0,
      'register must not fire hermes:panel-ready (got ' + readyEvents.length + ' events)');
    r1Reg();

    // Register a second panel — still no extra events
    const r2Reg = hp.register({ id: 'test-ready-no2', label: 'NoReady2' });
    assert(readyEvents.length === 0,
      'second register must also not fire hermes:panel-ready');
    r2Reg();
  })();

  // 18. Literal title labels — extension labels must bypass t()
  console.log('\n── Literal title labels ──');
  (function() {
    // RED: assert production syncAppTitlebar is extracted and callable
    // (this fails until extractSyncAppTitlebar and eval wiring is active)
    assert(typeof ctx.syncAppTitlebar === 'function',
      'production syncAppTitlebar must be extracted and callable');

    const savedT = globalThis.t;
    const savedRenaming = globalThis._renamingAppTitlebar;
    const savedPanel = globalThis._currentPanel;
    const savedGetElementById = fakeDoc.getElementById;
    const tCalls = [];
    globalThis.t = function(key) {
      tCalls.push(key);
      return 'MANGLED:' + key;
    };
    globalThis._renamingAppTitlebar = false;
    const titleEl = { textContent: '' };
    fakeDoc.getElementById = function(id) {
      if (id === 'appTitlebarTitle') return titleEl;
      if (id === 'appTitlebarSub') return null;
      return null;
    };

    const extLabel = 'My Ext Label';
    const extId = 'test-lit-label';
    const litReg = hp.register({ id: extId, label: extLabel });
    assert(ctx.APP_TITLEBAR_KEYS[extId] === extLabel, 'titlebar key set to literal label');

    // Extension panel: REAL syncAppTitlebar must use literal label
    globalThis._currentPanel = extId;
    ctx._currentPanel = extId;
    ctx.syncAppTitlebar();
    assert(titleEl.textContent === extLabel,
      'extension label must be literal: got "' + titleEl.textContent + '" expected "' + extLabel + '"');
    assert(tCalls.length === 0,
      't() must not be called for extension labels');

    // Core panel: t() must still be invoked through i18n
    globalThis._currentPanel = 'tasks';
    ctx._currentPanel = 'tasks';
    const tCallsBefore = tCalls.length;
    ctx.syncAppTitlebar();
    assert(tCalls.length === tCallsBefore + 1,
      't() must be called for core panel label');
    assert(titleEl.textContent === 'MANGLED:tab_tasks',
      'core panel label goes through t(): got "' + titleEl.textContent + '"');
    // GREEN: production syncAppTitlebar executed for both paths — literal label
    // and i18n-translated — without reimplementing its decision branch.

    // Clean up
    litReg();
    fakeDoc.getElementById = savedGetElementById;
    globalThis._renamingAppTitlebar = savedRenaming;
    globalThis._currentPanel = savedPanel;
    ctx._currentPanel = savedPanel;
    globalThis.t = savedT;
  })();

  // 19. Safe own-property checks — malicious hasOwnProperty on def
  console.log('\n── Safe own-property checks ──');

  // Def with hasOwnProperty=null must not bypass validation
  try {
    hp.register({
      id: 'test-sop-null',
      label: 'SOPNull',
      mount: 'not-a-function',
      hasOwnProperty: null
    });
    assert(false, 'def with hasOwnProperty=null must still validate and throw');
  } catch (e) {
    assert(true, 'def with hasOwnProperty=null rejected: ' + e.message);
  }
  assert(!ctx._EXT_IDS.has('test-sop-null'),
    'no registry entry after def with hasOwnProperty=null');

  // Def with hasOwnProperty=()=>true must not bypass validation
  try {
    hp.register({
      id: 'test-sop-true',
      label: 'SOPTrue',
      mount: 'not-a-function',
      hasOwnProperty: function() { return true; }
    });
    assert(false, 'def with hasOwnProperty=()=>true must still validate and throw');
  } catch (e) {
    assert(true, 'def with hasOwnProperty=()=>true rejected: ' + e.message);
  }
  assert(!ctx._EXT_IDS.has('test-sop-true'),
    'no registry entry after def with hasOwnProperty=()=>true');

  // Def with hasOwnProperty=()=>false must still correctly apply checks
  try {
    hp.register({
      id: 'test-sop-false',
      label: 'SOPFalse',
      mount: 'not-a-function',
      hasOwnProperty: function() { return false; }
    });
    assert(false, 'def with hasOwnProperty=()=>false must still validate mount');
  } catch (e) {
    assert(true, 'def with hasOwnProperty=()=>false rejected: ' + e.message);
  }

  // Valid def with hasOwnProperty=null must still register successfully
  try {
    const sopOk = hp.register({
      id: 'test-sop-ok',
      label: 'SOPOK',
      mount: function() {},
      hasOwnProperty: null
    });
    assert(true, 'valid def with hasOwnProperty=null registers OK');
    assert(ctx._EXT_IDS.has('test-sop-ok'),
      'test-sop-ok in registry despite hasOwnProperty=null');
    sopOk();
  } catch (e) {
    assert(false, 'valid def with hasOwnProperty=null should register: ' + e.message);
  }

  // 20. Async ready event verification — fires after setTimeout(0)
  // (Assertion runs in the deferred exit handler after runTests completes,
  //  because the event fires asynchronously in the next event loop tick.)
  console.log('\n── Async ready event ──');
  // No assertion here — the deferred handler after runTests() will check it.

  // ── Summary ──
  console.log(`\n═══ Results: ${passed} passed, ${failed} failed, ${failures.length > 0 ? failures.length : 0} failures ═══`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log('  ✗ ' + f));
  }
}

// ── Bootstrap ──────────────────────────────────────────────────────────────
function die(err) {
  process.stderr.write('FATAL: ' + (err && err.message || String(err)) + '\n');
  if (err && err.stack) process.stderr.write(err.stack + '\n');
  process.exit(1);
}

try {
  const src = fs.readFileSync(PANELS_PATH, 'utf-8');
  const extBlock = extractHermesPanels(src);
  const syncFn = extractSyncAppTitlebar(src);

  // Wrap the block so const/function declarations are explicitly exported
  // to globalThis.  eval() in strict mode creates its own lexical scope for
  // const/let, so bare eval would hide these symbols from the test harness.
  const wrapped = [
    '(function(global) {',
    syncFn,
    extBlock,
    '  global.__exports__ = {',
    '    _EXT_IDS, _EXT_REGISTRY, _EXT_SIDEBAR_FALLBACKS,',
    '    _EXT_MOUNT_HOOKS, _EXT_UNMOUNT_HOOKS,',
    '    _isCorePanel, _runExtensionHook,',
    '    _callExtensionUnmountHook, _callExtensionMountHook,',
    '    syncAppTitlebar,',
    '  };',
    '  // window.HermesPanels is set by the block on globalThis.window',
    '})(globalThis);',
  ].join('\n');

  // Register for the ready event BEFORE eval so we capture the
  // setTimeout(0) dispatch that fires after synchronous code completes.
  fakeDoc.addEventListener('hermes:panel-ready', function() { _readyEventFired = true; });

  eval(wrapped);

  // Copy exports into the shared context for test assertions
  const x = globalThis.__exports__;
  if (!x) throw new Error('__exports__ not set — eval likely failed');
  ctx._EXT_IDS = x._EXT_IDS;
  ctx._EXT_REGISTRY = x._EXT_REGISTRY;
  ctx._EXT_SIDEBAR_FALLBACKS = x._EXT_SIDEBAR_FALLBACKS;
  ctx._EXT_MOUNT_HOOKS = x._EXT_MOUNT_HOOKS;
  ctx._EXT_UNMOUNT_HOOKS = x._EXT_UNMOUNT_HOOKS;
  ctx._isCorePanel = x._isCorePanel;
  ctx._runExtensionHook = x._runExtensionHook;
  ctx._callExtensionUnmountHook = x._callExtensionUnmountHook;
  ctx._callExtensionMountHook = x._callExtensionMountHook;
  ctx.syncAppTitlebar = x.syncAppTitlebar;
  delete globalThis.__exports__;

  // Run all synchronous tests first.
  runTests();

  // After synchronous tests complete, the event loop picks up the
  // queued setTimeout(0) that fires hermes:panel-ready.  Schedule a
  // follow-up tick to verify the ready event and exit cleanly.
  setTimeout(function() {
    // The ready event should have fired by now (setTimeout(0) from eval
    // runs before this setTimeout(10) since we queue later).
    if (!_readyEventFired) {
      failed++;
      failures.push('hermes:panel-ready must be dispatched asynchronously after window.HermesPanels installation');
      console.log('\n  ✗ ' + failures[failures.length - 1]);
    } else {
      passed++;
    }
    process.exit(failed > 0 ? 1 : 0);
  }, 10);
} catch (err) {
  die(err);
}
