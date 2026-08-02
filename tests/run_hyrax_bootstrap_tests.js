#!/usr/bin/env node
/**
 * Execution-level Node harness for Hyrax bootstrap.js registration.
 *
 * Sets up a minimal fake DOM + HermesPanels environment, evaluates the
 * production bootstrap.js, and verifies correct HermesPanels registration
 * with no switchPanel wrapper, no private-array mutation.
 *
 * Usage:
 *   node tests/run_hyrax_bootstrap_tests.js
 *
 * Exit code: 0 = all pass, 1 = any failure.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Resolve paths ──────────────────────────────────────────────────────────
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

// Track elements injected into the sidebar
const injectedPanelDivs = [];
const injectedNavButtons = { rail: [], sidebar: [] };

const fakeDoc = {
  _listeners: {},
  _headChildren: [],
  createElement(tag) {
    const clsList = [];
    const el = {
      tagName: tag.toUpperCase(),
      className: '',
      textContent: '',
      innerHTML: '',
      style: {},
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
          valueOf() { return clsList.join(' '); },
          [Symbol.iterator]() { return clsList[Symbol.iterator](); },
        };
      },
      setAttribute(k, v) { this._attrs[k] = v; if (k.startsWith('data-')) { const key = k.slice(5); this.dataset[key] = v; } },
      getAttribute(k) { return this._attrs[k] || null; },
      hasAttribute(k) { return k in this._attrs; },
      removeAttribute(k) { delete this._attrs[k]; },
      appendChild(c) { if (c) this._children.push(c); },
      insertBefore(c, ref) {
        if (c) this._children.push(c);
      },
      replaceChildren(...children) { this._children = children.filter(Boolean); },
      append(...children) { children.forEach(c => { if (c != null) this._children.push(c); }); },
      addEventListener() {},
      removeEventListener() {},
      querySelector() { return null; },
      querySelectorAll() { return { forEach() {}, length: 0 }; },
      closest() { return null; },
      focus() {},
      remove() {},
    };
    return el;
  },
  createTextNode(t) { return { textContent: String(t) }; },
  getElementById() { return null; },
  querySelector(sel) {
    if (sel === 'aside.sidebar') return fakeSidebar;
    if (sel === 'main.main') return fakeMain;
    if (sel === '#sidebarResize') return fakeResizeHandle;
    if (sel === 'link[href*="/static/hyrax/hyrax.css"]') return null;
    if (sel === '.rail') return fakeRail;
    if (sel === '.sidebar-nav') return fakeSidebarNav;
    return null;
  },
  querySelectorAll(sel) {
    if (sel === '.rail, .sidebar-nav') {
      return [fakeRail, fakeSidebarNav];
    }
    if (sel === '.rail, .sidebar-nav, .rail .rail-btn') {
      return [fakeRail, fakeSidebarNav];
    }
    if (sel === 'aside.sidebar') {
      return [fakeSidebar];
    }
    return [];
  },
  addEventListener(ev, fn, opts) {
    if (!this._listeners[ev]) this._listeners[ev] = [];
    this._listeners[ev].push(fn);
    if (opts && opts.once) {
      // Mark as once — we handle this by checking a flag
      fn._once = true;
    }
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
  head: {
    appendChild(el) {
      if (el) fakeDoc._headChildren.push(el);
    },
  },
};

// Fake DOM elements
const fakeResizeHandle = fakeDoc.createElement('div');
fakeResizeHandle._attrs = { id: 'sidebarResize' };

const fakeSidebar = fakeDoc.createElement('aside');
fakeSidebar.className = 'sidebar';
fakeSidebar._children = [];

const fakeRail = fakeDoc.createElement('nav');
fakeRail.className = 'rail';
fakeRail._children = [];
// Add a settings anchor
const settingsBtn = fakeDoc.createElement('button');
settingsBtn._attrs['data-panel'] = 'settings';
fakeRail._children.push(settingsBtn);

const fakeSidebarNav = fakeDoc.createElement('div');
fakeSidebarNav.className = 'sidebar-nav';
fakeSidebarNav._children = [];
const settingsBtn2 = fakeDoc.createElement('button');
settingsBtn2._attrs['data-panel'] = 'settings';
fakeSidebarNav._children.push(settingsBtn2);

const fakeMain = fakeDoc.createElement('main');
fakeMain.className = 'main';
fakeMain._children = [];

// ── Extract and evaluate bootstrap.js ──────────────────────────────────────
function extractBootstrapIife(src) {
  // Find the IIFE start
  const start = src.indexOf('(function()');
  if (start === -1) throw new Error('IIFE start not found in bootstrap.js');

  // Find the closing `})();`
  const end = src.lastIndexOf('})();');
  if (end === -1) throw new Error('IIFE end not found in bootstrap.js');

  // Extract the IIFE body (everything inside (function() { ... }) )
  // The function body starts after the opening {
  const braceOpen = src.indexOf('{', start + 9);
  if (braceOpen === -1) throw new Error('IIFE opening brace not found');

  // Track brace depth from the opening brace
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

const bootstrapSrc = fs.readFileSync(BOOTSTRAP_PATH, 'utf-8');
const iifeBody = extractBootstrapIife(bootstrapSrc);

// ── Shared test context ───────────────────────────────────────────────────
// Track HermesPanels calls
const registerCalls = [];
const origSwitchPanelRef = Symbol('switchPanel');

const ctx = {
  window: globalThis,
  document: fakeDoc,
  CustomEvent: FakeCustomEvent,
  console: { warn(msg) { process.stderr.write('[bootstrap] ' + msg + '\n'); }, log() {}, error() {} },
  setTimeout: setTimeout,
  setInterval: setInterval,
  clearInterval: clearInterval,
  clearTimeout: clearTimeout,

  // HermesPanels reference — we provide a minimal one that tracks calls
  // This gets patched by panels.js in production; here we install it directly
  HermesPanels: {
    register(def) {
      registerCalls.push(def);
      // Track which panels got registered
      return function unregister() {};
    },
  },

  // Core panel structures (mimicking panels.js)
  APP_TITLEBAR_KEYS: {
    chat: 'tab_chat', tasks: 'tab_tasks', skills: 'tab_skills',
    memory: 'tab_memory', workspaces: 'tab_workspaces',
    profiles: 'tab_profiles', todos: 'tab_todos', insights: 'tab_insights',
    logs: 'tab_logs', settings: 'tab_settings',
  },
  MAIN_VIEW_PANELS: ['settings','skills','memory','tasks','kanban',
    'workspaces','profiles','insights','logs','plugin'],
  MAIN_VIEW_SIDEBAR_PANEL_FALLBACKS: { plugin: 'settings' },

  // switchPanel — preserved native identity (must NOT be patched by bootstrap)
  _switchPanelCalls: [],
  _currentPanel: 'chat',
  switchPanel(name, opts) {
    this._switchPanelCalls.push({ name: name || 'chat', opts: opts || {} });
    this._currentPanel = name || 'chat';
    return Promise.resolve(true);
  },
};

// Install HermesPanels on globalThis so bootstrap's
// `window.HermesPanels` check resolves (window=globalThis in our eval).
globalThis.HermesPanels = ctx.HermesPanels;
// Stub the __hqMount / __hqUnmount hooks that hq.js will populate
globalThis.__hqMount = function(id) { return Promise.resolve(); };
globalThis.__hqUnmount = function(id) {};

// ── Run tests ──────────────────────────────────────────────────────────────
function runTests() {
  console.log('═══ Hyrax Bootstrap Execution Tests ═══\n');

  // 1. Bootstrap code should NOT reference MAIN_VIEW_PANELS directly
  console.log('── No private-array mutation ──');
  const hasMvpRef = bootstrapSrc.includes('MAIN_VIEW_PANELS');
  assert(!hasMvpRef, 'bootstrap.js must NOT reference MAIN_VIEW_PANELS directly');

  const hasSwitchPanelWrap = bootstrapSrc.includes('origSwitchPanel');
  const hasSwitchPanelAssign = bootstrapSrc.includes('window.switchPanel =');
  assert(!hasSwitchPanelWrap, 'bootstrap.js must NOT wrap origSwitchPanel');
  assert(!hasSwitchPanelAssign, 'bootstrap.js must NOT reassign window.switchPanel');

  // 2. Bootstrap code should reference HermesPanels
  console.log('\n── HermesPanels registration ──');
  const hasHermesPanelsRef = bootstrapSrc.includes('HermesPanels');
  assert(hasHermesPanelsRef, 'bootstrap.js must reference window.HermesPanels');

  // Evaluate the IIFE body in our context
  registerCalls.length = 0; // Reset

  const evalFn = new Function(
    'window', 'document', 'CustomEvent', 'console',
    'setTimeout', 'setInterval', 'clearInterval', 'clearTimeout',
    'APP_TITLEBAR_KEYS', 'MAIN_VIEW_PANELS',
    'MAIN_VIEW_SIDEBAR_PANEL_FALLBACKS',
    '_currentPanel', 'switchPanel',
    iifeBody
  );

  evalFn(
    globalThis, fakeDoc, FakeCustomEvent, console,
    setTimeout, setInterval, clearInterval, clearTimeout,
    ctx.APP_TITLEBAR_KEYS, ctx.MAIN_VIEW_PANELS,
    ctx.MAIN_VIEW_SIDEBAR_PANEL_FALLBACKS,
    ctx._currentPanel, ctx.switchPanel
  );

  // 3. Verify panels were registered
  console.log('\n── Panel registration counts ──');
  // HQ-centric surface: hq + approvals (D3 Josh approval-tier panel).
  // Placeholder panels retired 2026-07-24 — upstream panels stay untouched.
  assert(registerCalls.length === 2, `exactly 2 panels registered (got ${registerCalls.length})`);

  const registeredIds = registerCalls.map(d => d.id);
  assert(registeredIds.includes('hq'), '"hq" panel registered');
  assert(registeredIds.includes('approvals'), '"approvals" panel registered');
  assert(!registeredIds.includes('projects'), '"projects" panel NOT registered (retired)');

  // 4. HQ mount/unmount hooks
  console.log('\n── HQ mount/unmount hooks ──');
  const hqReg = registerCalls.find(d => d.id === 'hq');
  assert(hqReg !== undefined, 'hq registration found');
  assert(typeof hqReg.mount === 'function', 'hq mount is a function');
  assert(typeof hqReg.unmount === 'function', 'hq unmount is a function');

  // 5. HQ mount returns a value (or undefined) — should not throw
  console.log('\n── HQ mount invocation ──');
  try {
    const result = hqReg.mount('hq');
    // mount can return undefined or a promise — either is fine
    assert(true, 'hq mount() did not throw');
  } catch (e) {
    assert(false, 'hq mount() threw: ' + e.message);
  }

  // 6. HQ unmount invocation
  console.log('\n── HQ unmount invocation ──');
  try {
    hqReg.unmount('hq');
    assert(true, 'hq unmount() did not throw');
  } catch (e) {
    assert(false, 'hq unmount() threw: ' + e.message);
  }

  // 7. Nav buttons injected
  console.log('\n── Nav button injection ──');
  // Check that the rail has buttons with data-panel attributes
  const railHasHyraxBtn = fakeRail._children.some(el =>
    el.dataset && el.dataset.panel === 'hq'
  );
  assert(railHasHyraxBtn, 'rail has hq button');

  const sidebarHasHyraxBtn = fakeSidebarNav._children.some(el =>
    el.dataset && el.dataset.panel === 'hq'
  );
  assert(sidebarHasHyraxBtn, 'sidebar has hq button');

  // 8. Panel divs injected into main.main (main-view, not sidebar)
  console.log('\n── Panel div injection ──');
  const hqPanelDiv = fakeMain._children.find(el =>
    el.id === 'mainHq'
  );
  assert(hqPanelDiv !== undefined, 'mainHq div injected into main.main');

  const projectsPanelDiv = fakeMain._children.find(el =>
    el.id === 'mainProjects'
  );
  assert(projectsPanelDiv === undefined, 'mainProjects div NOT injected (retired)');

  // 8b. Approvals panel: registration + hooks + main-view div
  console.log('\n── Approvals panel registration ──');
  const aprReg = registerCalls.find(d => d.id === 'approvals');
  assert(aprReg !== undefined, 'approvals registration found');
  assert(typeof aprReg.mount === 'function', 'approvals mount is a function');
  assert(typeof aprReg.unmount === 'function', 'approvals unmount is a function');
  assert(aprReg.sidebarFallback === 'hq', 'approvals sidebar falls back to hq');
  try {
    aprReg.mount('approvals');   // approvals.js not loaded here — must be graceful
    aprReg.unmount('approvals');
    assert(true, 'approvals mount/unmount did not throw without approvals.js');
  } catch (e) {
    assert(false, 'approvals mount/unmount threw: ' + e.message);
  }
  const aprPanelDiv = fakeMain._children.find(el =>
    el.id === 'mainApprovals'
  );
  assert(aprPanelDiv !== undefined, 'mainApprovals div injected into main.main');
  const aprNavBtn = fakeRail._children.some(el =>
    el.dataset && el.dataset.panel === 'approvals'
  );
  assert(aprNavBtn, 'rail has approvals button');

  // 9. CSS link injected
  console.log('\n── CSS injection ──');
  const hasCssLink = fakeDoc._headChildren.some(el =>
    el.href && el.href.indexOf('/static/hyrax/hyrax.css') !== -1
  );
  assert(hasCssLink, 'hyrax.css link injected into document head');

  // 10. No switchPanel monkey-patch
  console.log('\n── No switchPanel monkey-patch ──');
  // The native switchPanel identity should remain (Symbol comparison)
  // Since we use the context's switchPanel, check bootstrap didn't reassign it
  assert(typeof ctx.switchPanel === 'function', 'switchPanel is still a function');
  // Verify bootstrap.js doesn't contain window.switchPanel = 
  const noSwitchPanelOverride = !bootstrapSrc.includes('window.switchPanel =');
  assert(noSwitchPanelOverride, 'bootstrap.js does NOT reassign window.switchPanel');

  // 11. No polling / MutationObserver
  console.log('\n── No polling ──');
  const noPolling = !bootstrapSrc.includes('setInterval') &&
    !bootstrapSrc.includes('MutationObserver');
  assert(noPolling, 'bootstrap.js does NOT use setInterval or MutationObserver');

  // 12. Uses hermes:panel-ready event
  console.log('\n── API-ready ordering ──');
  const usesReadyEvent = bootstrapSrc.includes('hermes:panel-ready');
  assert(usesReadyEvent, 'bootstrap.js listens for hermes:panel-ready event');

  // ── Report ──
  console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══\n`);
  if (failures.length > 0) {
    console.error('FAILURES:');
    failures.forEach(f => console.error('  ✗ ' + f));
    process.exit(1);
  }
}

runTests();
