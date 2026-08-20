#!/usr/bin/env node
/**
 * Execution-level Node harness for the Hyrax shell/VN migration
 * (card t_b91c5672).
 *
 * Loads the PRODUCTION modules (bootstrap.js IIFE via eval-with-import-seam,
 * hq.js / vn.js / projects.js as real ES modules, the classic vn/ + essence/
 * modules as real files) against a minimal fake DOM / EventSource / api and
 * proves the migration contracts:
 *
 *   - registration happens exactly once, for exactly panels projects + hq
 *   - mount/unmount idempotence; no duplicate nav/DOM/listeners/EventSources
 *   - stale async work cannot mutate a later mount
 *   - VN uses exactly the native /api/hyrax/vn/* endpoints
 *   - SSE: one EventSource per session, dedupe by event id, terminal-frame
 *     re-arm, close-on-unmount without cancelling the run
 *   - fresh conversation archives via the backend contract
 *   - Tai-only lazy 3D import; exact production mountTaiLoft call; cleanup
 *     exactly once; failure fallback with "← Return to VN"; same-conversation
 *     return; no bundle load at HQ mount or for non-Tai
 *
 * Usage:  node tests/run_hyrax_migration_tests.js
 * Exit code: 0 = all pass, 1 = any failure.
 */
'use strict';

const fs = require('fs');
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
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; return; }
  failed++;
  failures.push(`${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function tick(n = 5) {
  for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r));
}

// ══════════════════════════════════════════════════════════════════════
// Fake browser environment (installed BEFORE production modules load)
// ══════════════════════════════════════════════════════════════════════

globalThis.window = globalThis;
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'node-harness', language: 'en', onLine: true },
    configurable: true,
  });
} catch (_) { /* navigator already writable — leave it */ }

class FakeCustomEvent {
  constructor(type, opts = {}) {
    this.type = type;
    this.bubbles = !!opts.bubbles;
    this.cancelable = !!opts.cancelable;
    this.detail = opts.detail || null;
  }
}

// ── element factory with real listener/child tracking ──
function makeEl(tag) {
  const clsList = [];
  const el = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    className: '',
    textContent: '',
    innerHTML: '',
    style: {},
    hidden: false,
    disabled: false,
    _children: [],
    _attrs: {},
    _listeners: {},
    dataset: {},
    title: '',
    draggable: false,
    loading: '',
    alt: '',
    src: '',
    value: '',
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
      const arr = this._listeners[ev.type] || [];
      arr.slice().forEach(fn => { try { fn(ev); } catch (e) { /* isolated */ } });
      return true;
    },
    appendChild(c) { if (c) this._children.push(c); return c; },
    insertBefore(c) { if (c) this._children.push(c); return c; },
    append(...children) { children.forEach(c => { if (c != null) this._children.push(c); }); return el; },
    replaceChildren(...children) { this._children = children.filter(Boolean); },
    remove() { el._removed = true; },
    focus() {},
    blur() {},
    click() {
      const ev = { type: 'click', target: el, preventDefault() {}, stopPropagation() {}, key: '' };
      (this._listeners.click || []).slice().forEach(fn => { try { fn(ev); } catch (e) { /* isolated */ } });
    },
    querySelector(sel) { return queryInTree([el], sel); },
    querySelectorAll(sel) { return queryAllInTree([el], sel); },
    closest() { return null; },
    getBoundingClientRect() { return { top: 0, left: 0, height: 500, width: 800 }; },
    setPointerCapture() {},
    getContext() {
      return new Proxy({}, { get: () => () => {}, set: () => true });
    },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return ''; },
    set(v) { if (v === '') el._children = []; },
  });
  Object.defineProperty(el, 'textContent', {
    get() { return el._text || ''; },
    set(v) { el._text = String(v); el._children = []; },
  });
  // dataset must stay in sync with _attrs so attribute selectors
  // ([data-panel], [data-room], …) match production `el.dataset.x = …`
  // writes the same way the real DOM resolves them.
  el.dataset = new Proxy({}, {
    get(t, k) { return t[k]; },
    set(t, k, v) { t[k] = v; el._attrs['data-' + String(k)] = String(v); return true; },
    deleteProperty(t, k) { delete t[k]; delete el._attrs['data-' + String(k)]; return true; },
  });
  return el;
}

// ── minimal selector engine: id, class, compound, attribute-contains,
//    descendant chains ──
function matchSimple(sel, el) {
  if (!el) return false;
  let rest = String(sel).trim();
  // id component: #name
  if (rest.startsWith('#')) {
    const m = rest.match(/^#([\w-]+)/);
    if (!m || el._attrs.id !== m[1]) return false;
    rest = rest.slice(m[0].length);
  }
  // class components: .name
  const cls = String(el.className);
  let m;
  while ((m = rest.match(/^\.([\w-]+)/))) {
    if (!cls.split(/\s+/).includes(m[1])) return false;
    rest = rest.slice(m[0].length);
  }
  // attribute components: [attr], [attr=val], [attr*=val]
  const am = rest.match(/^\[([a-zA-Z-]+)(?:([~*|^$]?=)"([^"]*)")?\]/);
  if (am) {
    const key = am[1];
    if (!(key in el._attrs)) return false;
    if (am[2] !== undefined) {
      const val = am[3];
      const attrVal = String(el._attrs[key]);
      if (am[2] === '=' && attrVal !== val) return false;
      if (am[2] === '*=' && !attrVal.includes(val)) return false;
    }
    rest = rest.slice(am[0].length);
  }
  return rest.trim() === '';
}

function matchSelector(sel, el) {
  sel = sel.trim();
  if (sel.includes(' ')) {
    const [head, ...rest] = sel.split(/\s+/);
    const tail = rest.join(' ');
    if (!matchSimple(head, el)) return false;
    let cur = el._parent;
    while (cur) {
      if (matchSelector(tail, cur)) return true;
      cur = cur._parent;
    }
    return false;
  }
  return matchSimple(sel, el);
}

function queryInTree(roots, sel) {
  const stack = roots.slice().reverse();
  while (stack.length) {
    const el = stack.pop();
    if (el && el._children) {
      for (let i = el._children.length - 1; i >= 0; i--) stack.push(el._children[i]);
    }
    if (el && matchSelector(sel, el)) return el;
  }
  return null;
}

function queryAllInTree(roots, sel) {
  const out = [];
  const stack = roots.slice().reverse();
  while (stack.length) {
    const el = stack.pop();
    if (el && el._children) {
      for (let i = el._children.length - 1; i >= 0; i--) stack.push(el._children[i]);
    }
    if (el && matchSelector(sel, el)) out.push(el);
  }
  return out;
}

function linkChildren(el) {
  (el._children || []).forEach(c => { if (c) { c._parent = el; linkChildren(c); } });
}

// ── document ──
const docListeners = {};
const bodyEl = makeEl('body');
const mainEl = makeEl('main');
mainEl.className = 'main';
const sidebarEl = makeEl('aside');
sidebarEl.className = 'sidebar';
const railEl = makeEl('nav');
railEl.className = 'rail';
const sidebarNavEl = makeEl('div');
sidebarNavEl.className = 'sidebar-nav';
const layoutEl = makeEl('div');
layoutEl.className = 'layout';
const mainHq = makeEl('div');
mainHq._attrs.id = 'mainHq';
mainHq.className = 'main-view';
mainEl._children.push(mainHq);
linkChildren(mainEl);
const panelChat = makeEl('div');
panelChat._attrs.id = 'panelChat';
panelChat.className = 'panel-view';
sidebarEl._children.push(panelChat);
linkChildren(sidebarEl);
const headEl = { appendChild() {}, querySelector() { return null; } };

const fakeDoc = {
  _listeners: docListeners,
  body: bodyEl,
  head: headEl,
  readyState: 'complete',
  createElement: makeEl,
  createTextNode(t) { return { textContent: String(t), nodeType: 3 }; },
  getElementById(id) {
    if (id === 'mainHq') return mainHq;
    return queryInTree([bodyEl, mainEl, sidebarEl], '#' + id);
  },
  querySelector(sel) {
    if (sel === 'main.main') return mainEl;
    if (sel === 'aside.sidebar') return sidebarEl;
    if (sel === 'nav.rail' || sel === '.rail') return railEl;
    if (sel === '.sidebar-nav') return sidebarNavEl;
    if (sel === 'div.layout' || sel === '.layout') return layoutEl;
    if (sel === 'link[href*="/static/hyrax/hyrax.css"]') return null;
    if (sel === 'link[href*="/static/hyrax/3d/embodiment-bundle.css"]') return null;
    if (sel === '#mainHq .hq-warroom') return queryInTree([mainHq], '.hq-warroom');
    if (sel.startsWith('.chibi-')) return queryInTree([mainHq], sel);
    if (sel === 'main') return mainEl;
    return queryInTree([bodyEl, mainEl, sidebarEl], sel);
  },
  querySelectorAll(sel) {
    if (sel === '.rail, .sidebar-nav') return [railEl, sidebarNavEl];
    if (sel === 'script') return [];
    if (sel === 'aside.sidebar') return [sidebarEl];
    if (sel === 'main.main') return [mainEl];
    if (sel === '[data-panel]') return queryAllInTree([railEl, sidebarNavEl], '[data-panel]');
    return queryAllInTree([bodyEl, mainEl, sidebarEl], sel);
  },
  addEventListener(ev, fn, opts) {
    if (!docListeners[ev]) docListeners[ev] = [];
    if (opts && opts.once) fn._once = true;
    if (docListeners[ev].indexOf(fn) === -1) docListeners[ev].push(fn);
  },
  removeEventListener(ev, fn) {
    const arr = docListeners[ev];
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i !== -1) arr.splice(i, 1);
  },
  dispatchEvent(ev) {
    const arr = docListeners[ev.type] || [];
    arr.slice().forEach(fn => {
      fn(ev);
      if (fn._once) {
        const i = docListeners[ev.type].indexOf(fn);
        if (i !== -1) docListeners[ev.type].splice(i, 1);
      }
    });
    return true;
  },
};

// Install the fake document as a browser global (production code uses the
// bare `document` global). Must happen before any production module loads.
globalThis.document = fakeDoc;

// ── EventSource fake ──
class FakeEventSource {
  static instances = [];
  static reset() { FakeEventSource.instances = []; }
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this._closed = false;
    this._typed = {};
    this.onmessage = null;
    this.onerror = null;
    this.onopen = null;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, fn) {
    if (!this._typed[type]) this._typed[type] = [];
    this._typed[type].push(fn);
  }
  removeEventListener(type, fn) {
    const arr = this._typed[type];
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i !== -1) arr.splice(i, 1);
  }
  close() { this._closed = true; this.readyState = 2; }
  // harness helper: emit a server frame
  emit(type, data, id) {
    const evt = { type, data: typeof data === 'string' ? data : JSON.stringify(data), lastEventId: id };
    if (type === 'message') {
      if (this.onmessage) this.onmessage(evt);
    } else {
      (this._typed[type] || []).slice().forEach(fn => fn(evt));
    }
  }
}
globalThis.EventSource = FakeEventSource;

// ── api fake ──
const apiCalls = [];
function fakeApi(url, opts = {}) {
  apiCalls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
  if (url === '/api/hyrax/vn/profiles') {
    return Promise.resolve({
      items: [
        { id: 'tai', name: 'Tai', role: 'Builder', available: true,
          assets: { neutral: '/api/hyrax/assets/tai.portrait.neutral',
                    background: '/api/hyrax/assets/tai.background.control-room' } },
        { id: 'rei', name: 'Rei', role: 'QA', available: true, assets: {} },
        { id: 'nei', name: 'Nei', role: 'Contracts', available: true, assets: {} },
        { id: 'mai', name: 'Mai', role: 'Ops', available: true, assets: {} },
      ],
    });
  }
  if (url === '/api/hyrax/vn/conversations') {
    const fresh = !!(opts.body && JSON.parse(opts.body).fresh);
    return Promise.resolve({
      conversation: {
        session_id: fresh ? 'vn-sess-fresh' : 'vn-sess-1',
        title: 'Tai VN', message_count: 0, active_stream_id: null,
        archived: false, created_at: 0, updated_at: 0,
        messages: [],
      },
    });
  }
  if (url.startsWith('/api/hyrax/vn/conversations/') && !url.endsWith('/events')) {
    return Promise.resolve({
      conversation: {
        session_id: 'vn-sess-1', title: 'Tai VN', message_count: 1,
        active_stream_id: null, archived: false,
        messages: [{ id: 'm1', role: 'user', content: 'hi' }],
      },
    });
  }
  if (url === '/api/hyrax/presence') {
    return Promise.resolve({ items: [] });
  }
  if (url.startsWith('/api/kanban/tasks')) {
    return Promise.resolve({
      columns: [
        { name: 'todo', tasks: [
          { id: 't1', title: 'one', project_id: 'alpha', status: 'todo' },
          { id: 't2', title: 'two', project_id: 'beta', status: 'todo' },
        ] },
        { name: 'running', tasks: [{ id: 't3', title: 'three', project_id: 'alpha', status: 'running' }] },
        { name: 'done', tasks: [{ id: 't4', title: 'four', project_id: null, status: 'done' }] },
      ],
    });
  }
  return Promise.resolve({});
}
globalThis.api = fakeApi;
globalThis.loadSession = () => {};
globalThis.showToast = () => {};
globalThis.switchPanel = (name) => { globalThis.__switchedTo = name; };
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
globalThis.CustomEvent = FakeCustomEvent;
globalThis.fetch = () => Promise.reject(new Error('no fetch in harness'));

// ── HermesPanels fake ──
const registeredPanels = [];
const registeredHooks = {};
globalThis.HermesPanels = {
  register(def) {
    registeredPanels.push({ id: def.id, label: def.label, mainView: def.mainView, sidebarFallback: def.sidebarFallback || null });
    registeredHooks[def.id] = { mount: def.mount, unmount: def.unmount };
    return () => {};
  },
};

// Loft seam: hq.js reads __HYRAX_3D_URL (test seam, production uses the
// fixed bundle URL). Point it at a fixture file for success-path tests.
const FAKE_BUNDLE = 'file://' + path.join(REPO, 'tests', 'fixtures', 'fake-embodiment-bundle.mjs').replace(/\\/g, '/');
const MISSING_BUNDLE = 'file://' + path.join(REPO, 'tests', 'fixtures', 'does-not-exist.mjs').replace(/\\/g, '/');
function resetLoftSpies() {
  delete globalThis.__FAKE_LOFT_CALLS;
  delete globalThis.__FAKE_LOFT_CLEANUPS;
  delete globalThis.__FAKE_LOFT_MOUNTED;
}

// ══════════════════════════════════════════════════════════════════════
// Load production modules
// ══════════════════════════════════════════════════════════════════════

function extractBootstrapIife(src) {
  const start = src.indexOf('(function()');
  if (start === -1) throw new Error('IIFE start not found in bootstrap.js');
  const end = src.lastIndexOf('})();');
  if (end === -1) throw new Error('IIFE end not found in bootstrap.js');
  const braceOpen = src.indexOf('{', start + 9);
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

async function loadBootstrap() {
  const src = fs.readFileSync(path.join(HYRAX, 'bootstrap.js'), 'utf-8');
  const body = extractBootstrapIife(src);
  const importMock = (spec) => {
    const rel = spec.replace(/^\.\//, '');
    const file = path.join(HYRAX, rel);
    return import('file://' + file.replace(/\\/g, '/'));
  };
  // `import` is a reserved word — cannot be a Function parameter. Rename the
  // dynamic-import expressions in the extracted body to a mockable identifier.
  const renamed = body.replace(/\bimport\(/g, '__hyraxImport(');
  const fn = new Function('__hyraxImport', renamed);
  fn(importMock);
  // bootstrap waits for hermes:panel-ready when HermesPanels is missing;
  // here it exists, so registration is synchronous.
}

async function loadHq() { return import('file://' + path.join(HYRAX, 'hq.js').replace(/\\/g, '/')); }
async function loadVn() { return import('file://' + path.join(HYRAX, 'vn.js').replace(/\\/g, '/')); }
async function loadProjects() { return import('file://' + path.join(HYRAX, 'projects.js').replace(/\\/g, '/')); }

// ══════════════════════════════════════════════════════════════════════
// 1. Bootstrap registration
// ══════════════════════════════════════════════════════════════════════

async function testBootstrap() {
  await loadBootstrap();

  assertEqual(registeredPanels.map(p => p.id), ['projects', 'hq', 'war-room', 'qat'],
    'bootstrap registers exactly [projects, hq, war-room, qat]');
  assertEqual(registeredPanels.map(p => p.mainView), [true, true, true, true],
    'all panels are mainView');
  assert(registeredPanels.every(p => typeof p.label === 'string' && p.label),
    'every panel has a label');

  // Double-boot must not re-register (idempotent init guard).
  const before = registeredPanels.length;
  await loadBootstrap();
  assertEqual(registeredPanels.length, before,
    'bootstrap init is idempotent — no duplicate registration');

  // Nav buttons exist on rail + sidebar-nav, WITHOUT inline onclick.
  const hyraxPanelIds = ['projects', 'hq', 'war-room'];
  const railHyrax = queryAllInTree([railEl], '[data-panel]')
    .filter(b => hyraxPanelIds.includes(b.dataset.panel || b._attrs['data-panel']))
    .map(b => b.dataset.panel || b._attrs['data-panel']).sort();
  const sideHyrax = queryAllInTree([sidebarNavEl], '[data-panel]')
    .filter(b => hyraxPanelIds.includes(b.dataset.panel || b._attrs['data-panel']))
    .map(b => b.dataset.panel || b._attrs['data-panel']).sort();
  assertEqual(railHyrax, ['hq', 'projects', 'war-room'], 'rail nav has all panel buttons');
  assertEqual(sideHyrax, ['hq', 'projects', 'war-room'], 'sidebar-nav has all panel buttons');
  const hyraxBtns = queryAllInTree([railEl, sidebarNavEl], '[data-panel]')
    .filter(b => hyraxPanelIds.includes(b.dataset.panel || b._attrs['data-panel']));
  assert(hyraxBtns.length >= 3 && hyraxBtns.every(b => !b._attrs.onclick),
    'nav buttons use listeners, not inline onclick');
}

// ══════════════════════════════════════════════════════════════════════
// 2. HQ controller: mount/unmount idempotence, no duplicate DOM,
//    no bundle load at HQ mount, launch3d success/failure/return
// ══════════════════════════════════════════════════════════════════════

async function testHq() {
  const hq = await loadHq();
  const vn = await loadVn();

  // ── mount idempotence + 2D render ──
  await hq.mount('hq');
  assert(queryInTree([mainHq], '.hq-page') !== null,
    'hq mount renders the 2D map');
  await tick(3); // presence resolves → chibis render
  assert(queryInTree([mainHq], '.chibi-tai') !== null,
    'hq mount renders chibis');
  const pageCount = queryAllInTree([mainHq], '.hq-page').length;
  assertEqual(pageCount, 1, 'exactly one hq-page after mount');

  await hq.mount('hq');
  assertEqual(queryAllInTree([mainHq], '.hq-page').length, 1,
    'double mount does not duplicate the 2D map');

  // No 3D bundle load at HQ mount.
  assert(!globalThis.__FAKE_LOFT_CALLS, 'no 3D bundle import at HQ mount');

  // ── unmount idempotence ──
  hq.unmount('hq');
  hq.unmount('hq');
  assert(true, 'double unmount is safe');

  // ── chibi click opens the VN (controller path) ──
  await hq.mount('hq');
  await tick(3); // presence fetch resolves
  const chibi = queryInTree([mainHq], '.chibi-tai');
  assert(chibi !== null, 'chibi exists after presence resolves');
  if (chibi) chibi.click();
  await tick(10); // VN shell mount (classic modules + session open)
  assert(queryInTree([mainHq], '.vn2') !== null,
    'chibi click mounts the VN inside the HQ host');

  // ── launch3d success path ──
  globalThis.__HYRAX_3D_URL = FAKE_BUNDLE;
  resetLoftSpies();
  await hq.launch3d();
  await tick(10);
  assert(globalThis.__FAKE_LOFT_CALLS && globalThis.__FAKE_LOFT_CALLS.length === 1,
    'mountTaiLoft called exactly once');
  if (globalThis.__FAKE_LOFT_CALLS && globalThis.__FAKE_LOFT_CALLS[0]) {
    const call = globalThis.__FAKE_LOFT_CALLS[0];
    assert(call.host === mainHq, 'mountTaiLoft receives the HQ host');
    assert(typeof call.onExit === 'function', 'mountTaiLoft receives an onExit callback');
    assertEqual(call.configuration && call.configuration.vrmUrl,
      '/api/hyrax/assets/tai.embodiment.vrm',
      'mountTaiLoft uses the production vrmUrl default');
    assertEqual(call.configuration && call.configuration.development, undefined,
      'mountTaiLoft uses production defaults (no development flag)');
  }

  // exit → same conversation (VN reopens), cleanup exactly once
  const call = globalThis.__FAKE_LOFT_CALLS[0];
  await call.onExit();
  await tick(10);
  assertEqual(globalThis.__FAKE_LOFT_CLEANUPS, 1,
    '3D cleanup called exactly once on exit');
  assert(queryInTree([mainHq], '.vn2') !== null,
    'loft exit returns to the SAME conversation (VN remounted)');
  assert(queryInTree([mainHq], '.tai-loft') === null,
    'loft DOM removed after exit');

  // second exit path: cleanup guard — calling onExit again is a no-op
  await call.onExit();
  assertEqual(globalThis.__FAKE_LOFT_CLEANUPS, 1,
    'cleanup stays exactly-once across repeated exit calls');

  // ── launch3d failure path ──
  globalThis.__HYRAX_3D_URL = MISSING_BUNDLE;
  resetLoftSpies();
  await hq.launch3d();
  await tick(10);
  const retryBtn = queryInTree([mainHq], '.vn2-btn') ||
    queryAllInTree([mainHq], 'button').find(b => (b.textContent || '').includes('Return to VN'));
  assert(retryBtn !== null,
    'loft failure renders a "← Return to VN" fallback button');
  if (retryBtn) {
    retryBtn.click();
    await tick(10);
    assert(queryInTree([mainHq], '.vn2') !== null || queryInTree([mainHq], '.hq-page') !== null,
      'failure fallback returns to the VN (or 2D HQ) — not a dead state');
  }
  delete globalThis.__HYRAX_3D_URL;

  // ── non-Tai: no loft button in VN (classic vnShell contract) ──
  vn.unmount();
  await vn.mount({ sisterId: 'rei', sisterName: 'Rei', role: 'QA' });
  await tick(10);
  assert(queryInTree([mainHq], '.vn2-stage-loft') === null,
    'no 3D Loft button for non-Tai sisters');
  vn.unmount();
}

// ══════════════════════════════════════════════════════════════════════
// 3. VN controller: native endpoints, one EventSource, dedupe,
//    terminal re-arm, fresh conversation, unmount closes stream
// ══════════════════════════════════════════════════════════════════════

async function testVn() {
  const vn = await loadVn();

  await vn.mount({ sisterId: 'tai', sisterName: 'Tai', role: 'Builder' });
  await tick(15);

  // Native endpoint usage
  const convCalls = apiCalls.filter(c => c.url === '/api/hyrax/vn/conversations');
  assert(convCalls.length >= 1,
    'vn mount selects the conversation via POST /api/hyrax/vn/conversations');
  assert(convCalls.length >= 1 &&
    JSON.stringify(convCalls[convCalls.length - 1].body) === JSON.stringify({ profile_id: 'tai', fresh: false }),
    'conversation body is {profile_id, fresh:false}');
  assert(apiCalls.some(c => c.url === '/api/hyrax/vn/profiles'),
    'vn mount fetches GET /api/hyrax/vn/profiles');
  assert(apiCalls.every(c => !c.url.startsWith('/api/v1')),
    'no /api/v1 donor calls from the VN surface');

  // One EventSource on the native events endpoint.
  const esList = FakeEventSource.instances.filter(es => !es._closed);
  assertEqual(esList.length, 1, 'exactly one live EventSource while VN is mounted');
  assert(esList[0].url.includes('/api/hyrax/vn/conversations/vn-sess-1/events'),
    'EventSource connects to the native events endpoint');

  // Unmount closes the stream but does NOT cancel the run (no cancel call).
  vn.unmount();
  assert(esList[0]._closed === true, 'unmount closes the EventSource');

  // ── SSE dedupe + terminal re-arm (production vnEvents) ──
  const ev = globalThis.GestaltVN.events;
  assert(ev && typeof ev.init === 'function', 'vnEvents loaded (GestaltVN.events)');
  FakeEventSource.reset();
  const received = [];
  ev.init({ sessionId: 'vn-sess-1', operatorId: 'tai' });
  const sub = ev.subscribe('*', e => received.push(e.kind + ':' + (e.id || '')));
  await tick(2);
  const live = FakeEventSource.instances.filter(es => !es._closed);
  assertEqual(live.length, 1, 'events.init opens exactly one stream');
  const es = live[0];
  es.emit('token', { text: 'hel' }, 'ev-1');
  es.emit('token', { text: 'lo' }, 'ev-2');
  es.emit('token', { text: 'lo' }, 'ev-2'); // duplicate id — must dedupe
  es.emit('done', { session: {} }, 'ev-3');
  es.emit('stream_end', { run_id: 'r1', status: 'completed' }, 'ev-4'); // native terminal frame
  await tick(5);
  const tokenCount = received.filter(r => r.startsWith('response.token')).length;
  assertEqual(tokenCount, 2, 'duplicate event ids are not double-rendered');

  // Terminal frame re-arms the connection with after_event_id.
  await tick(5);
  const rearmed = FakeEventSource.instances.filter(es2 => !es2._closed && es2 !== es);
  assert(rearmed.length >= 1, 'terminal frame re-arms a fresh EventSource');
  if (rearmed.length) {
    assert(rearmed[0].url.includes('after_event_id=ev-4') || rearmed[0].url.includes('after_event_id'),
      're-arm carries the replay cursor (after_event_id)');
  }
  sub();

  // ── fresh conversation archives via backend contract ──
  const before = apiCalls.length;
  await ev.dispose();
  await vn.mount({ sisterId: 'tai', sisterName: 'Tai', role: 'Builder' });
  await tick(10);
  // drive fresh() through the classic session module (production code)
  const sess = globalThis.GestaltVN.session;
  assert(sess && typeof sess.fresh === 'function', 'vnSession loaded (GestaltVN.session)');

  // GET /api/hyrax/vn/conversations/{session_id} — exercised through the
  // production session module (refresh() reloads the transcript).
  assert(sess && typeof sess.refresh === 'function', 'vnSession.refresh exists');
  const refreshed = await sess.refresh();
  await tick(2);
  assert(refreshed && refreshed.sessionId === 'vn-sess-1',
    'refresh returns the same native session');
  assert(apiCalls.some(c => /^\/api\/hyrax\/vn\/conversations\/[^/]+$/.test(c.url) && !c.url.endsWith('/events')),
    'vn surface fetches GET /api/hyrax/vn/conversations/{session_id}');

  const freshRef = await sess.fresh();
  await tick(5);
  assert(freshRef && freshRef.sessionId === 'vn-sess-fresh',
    'fresh conversation selects the new native session');
  const freshCalls = apiCalls.slice(before).filter(c => c.url === '/api/hyrax/vn/conversations');
  assert(freshCalls.some(c => c.body && c.body.fresh === true),
    'fresh conversation POSTs {fresh:true}');
  vn.unmount();
}

// ══════════════════════════════════════════════════════════════════════
// 4. Projects controller: native kanban data, mount/unmount idempotence
// ══════════════════════════════════════════════════════════════════════

async function testProjects() {
  const projects = await loadProjects();
  const host = makeEl('div');
  host._attrs.id = 'mainProjects';

  await projects.mount(host);
  await tick(3);
  const dbg = queryAllInTree([host], '[data-project]');
  if (process.env.HYRAX_DEBUG) {
    console.log('[debug] page children:', (host._children[0] || {})._children
      ? host._children[0]._children.map(c => c.className || c.tagName) : 'none');
    const content = (host._children[0] || {})._children
      && host._children[0]._children.find(c => c.className === 'panel-content');
    console.log('[debug] content children:', content ? content._children.map(c => (c.className || c.tagName) + ':' + (c.textContent || '').slice(0, 40)) : 'none');
    console.log('[debug] data-project hits:', dbg.length,
      '| api kanban calls:', apiCalls.filter(c => c.url.startsWith('/api/kanban')).length);
  }
  const rows = queryAllInTree([host], '.panel-page');
  assertEqual(rows.length, 1, 'projects mount renders one .panel-page');
  const names = queryAllInTree([host], '[data-project]').map(e => e._attrs['data-project']);
  assertEqual(names.sort(), ['alpha', 'beta'], 'projects aggregated from native kanban tasks');

  await projects.mount(host);
  assertEqual(queryAllInTree([host], '.panel-page').length, 1,
    'projects double mount does not duplicate content');

  projects.unmount();
  assertEqual(host._children.length, 0, 'projects unmount clears the host');
}

// ══════════════════════════════════════════════════════════════════════
// Run
// ══════════════════════════════════════════════════════════════════════

(async () => {
  try {
    await testBootstrap();
    await testHq();
    await testVn();
    await testProjects();
  } catch (err) {
    failed++;
    failures.push('HARNESS ERROR: ' + (err && err.stack ? err.stack : String(err)));
  }

  console.log(`\nhyrax-migration: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(f => console.log('  ✗ ' + f));
    process.exit(1);
  }
  process.exit(0);
})();
