#!/usr/bin/env node
/**
 * Execution-level Node harness for the Gestalt VN revamp client-core
 * (static/hyrax/vn/vn2 modules: vnEvents, vnSession, vnDialogue, vnComposer,
 * vnApprovals, vnTechDrawer, vnShell).
 *
 * Same style as run_hyrax_vn_tests.js: IIFE extraction, fake DOM, fake
 * EventSource, mock window.api.
 *
 * Usage:
 *   node tests/run_hyrax_vn2_tests.js
 *
 * Exit code: 0 = all pass, 1 = any failure.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const VN_DIR = path.join(__dirname, '..', 'static', 'hyrax', 'vn');
const MODULES = [
  'vnEvents.js', 'vnSession.js', 'vnDialogue.js', 'vnComposer.js',
  'vnApprovals.js', 'vnTechDrawer.js', 'vnShell.js',
];

// ── Helpers ────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function assert(ok, msg) {
  if (ok) { passed++; return; }
  failed++;
  const e = new Error();
  const stack = (e.stack || '').split('\n').slice(2, 4).join(' → ').trim();
  failures.push(msg + '  [' + (stack || '?') + ']');
}

function flush() {
  // One macrotask drains the full microtask queue (all resolved-promise
  // chains settle); two ticks covers timer-adjacent continuations.
  return new Promise(function(r) {
    setTimeout(function() { setTimeout(r, 0); }, 0);
  });
}

// ── Fake DOM ───────────────────────────────────────────────────────────────
function matchesToken(el, token) {
  if (!el || !token) return false;
  if (token.charAt(0) === '#') return el.id === token.slice(1) || el._attrs.id === token.slice(1);
  if (token.charAt(0) === '.') return el._cls.indexOf(token.slice(1)) !== -1;
  return el.tagName === token.toUpperCase();
}

function walkAll(el, out) {
  for (let i = 0; i < el._children.length; i++) {
    const c = el._children[i];
    if (c && c.tagName) {
      out.push(c);
      walkAll(c, out);
    }
  }
  return out;
}

function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    _children: [],
    _attrs: {},
    _cls: [],
    _listeners: {},
    _parent: null,
    _text: '',
    _html: '',
    id: '',
    hidden: false,
    disabled: false,
    value: '',
    style: {},
    dataset: {},
    files: null,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    get className() { return this._cls.join(' '); },
    set className(v) {
      this._cls = String(v || '').split(/\s+/).filter(Boolean);
    },
    get classList() {
      const self = this;
      return {
        contains(c) { return self._cls.indexOf(c) !== -1; },
        add() { for (let i = 0; i < arguments.length; i++) { if (self._cls.indexOf(arguments[i]) === -1) self._cls.push(arguments[i]); } },
        remove() { for (let i = 0; i < arguments.length; i++) { const idx = self._cls.indexOf(arguments[i]); if (idx !== -1) self._cls.splice(idx, 1); } },
        toggle(c) { const idx = self._cls.indexOf(c); if (idx !== -1) { self._cls.splice(idx, 1); return false; } self._cls.push(c); return true; },
      };
    },
    get textContent() {
      if (this._children.length) {
        return this._children.map(function(c) { return (c && c.textContent) || ''; }).join('');
      }
      return this._text;
    },
    set textContent(v) {
      this._children = [];
      this._text = String(v == null ? '' : v);
    },
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._children = [];
      this._html = String(v == null ? '' : v);
    },
    get children() { return this._children.slice(); },
    setAttribute(k, v) {
      this._attrs[k] = String(v);
      if (k === 'id') this.id = String(v);
      if (k.indexOf('data-') === 0) this.dataset[k.slice(5)] = String(v);
    },
    getAttribute(k) { return (k in this._attrs) ? this._attrs[k] : null; },
    hasAttribute(k) { return k in this._attrs; },
    removeAttribute(k) { delete this._attrs[k]; },
    appendChild(c) {
      if (c != null) { c._parent = this; this._children.push(c); }
      return c;
    },
    append() {
      for (let i = 0; i < arguments.length; i++) this.appendChild(arguments[i]);
    },
    insertBefore(c, ref) {
      if (c == null) return c;
      const idx = ref ? this._children.indexOf(ref) : -1;
      c._parent = this;
      if (idx === -1) this._children.push(c);
      else this._children.splice(idx, 0, c);
      return c;
    },
    removeChild(c) {
      const idx = this._children.indexOf(c);
      if (idx !== -1) this._children.splice(idx, 1);
      return c;
    },
    replaceChildren() {
      this._children = [];
      for (let i = 0; i < arguments.length; i++) this.appendChild(arguments[i]);
    },
    remove() {
      if (this._parent) this._parent.removeChild(this);
      this._parent = null;
    },
    addEventListener(type, fn) {
      if (!this._listeners[type]) this._listeners[type] = [];
      this._listeners[type].push(fn);
    },
    removeEventListener(type, fn) {
      const arr = this._listeners[type];
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx !== -1) arr.splice(idx, 1);
    },
    dispatchEvent(ev) {
      if (!ev.target) ev.target = this;
      if (!ev.preventDefault) ev.preventDefault = function() {};
      const arr = this._listeners[ev.type];
      if (arr) arr.slice().forEach(function(fn) { fn(ev); });
      return true;
    },
    click() { this.dispatchEvent({ type: 'click' }); },
    focus() {},
    querySelector(token) {
      const all = walkAll(this, []);
      for (let i = 0; i < all.length; i++) {
        if (matchesToken(all[i], token)) return all[i];
      }
      return null;
    },
    querySelectorAll(token) {
      return walkAll(this, []).filter(function(c) { return matchesToken(c, token); });
    },
  };
  return el;
}

// ── Fake EventSource ───────────────────────────────────────────────────────
class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = {};
    this.onmessage = null;
    this.closed = false;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, fn) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(fn);
  }
  removeEventListener(type, fn) {
    const arr = this.listeners[type];
    if (!arr) return;
    const idx = arr.indexOf(fn);
    if (idx !== -1) arr.splice(idx, 1);
  }
  close() { this.readyState = 2; this.closed = true; }
  // Test helpers
  _open() {
    this.readyState = 1;
    (this.listeners.open || []).slice().forEach(function(fn) { fn({ type: 'open' }); });
  }
  _emit(type, data, lastEventId) {
    const ev = { data: JSON.stringify(data), lastEventId: lastEventId || '' };
    (this.listeners[type] || []).slice().forEach(function(fn) { fn(ev); });
  }
  _emitUntyped(data, lastEventId) {
    if (typeof this.onmessage === 'function') {
      this.onmessage({ data: JSON.stringify(data), lastEventId: lastEventId || '' });
    }
  }
}
FakeEventSource.instances = [];
globalThis.EventSource = FakeEventSource;

// ── Fake document / window globals ─────────────────────────────────────────
const mainHqEl = makeEl('div');
mainHqEl.id = 'mainHq';
const layoutEl = makeEl('div');
layoutEl.className = 'layout';

const fakeDoc = {
  _listeners: {},
  createElement(tag) { return makeEl(tag); },
  createTextNode(t) { return { textContent: String(t) }; },
  getElementById(id) { return id === 'mainHq' ? mainHqEl : null; },
  querySelector(s) { return s === '.layout' ? layoutEl : null; },
  querySelectorAll() { return []; },
  addEventListener(type, fn) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(fn);
  },
  removeEventListener(type, fn) {
    const arr = this._listeners[type];
    if (!arr) return;
    const idx = arr.indexOf(fn);
    if (idx !== -1) arr.splice(idx, 1);
  },
  dispatchEvent(ev) {
    const arr = this._listeners[ev.type];
    if (arr) arr.slice().forEach(function(fn) { fn(ev); });
  },
  body: makeEl('body'),
  head: makeEl('head'),
};

// window.api mock — routes set per-test via apiRoutes
const apiCalls = [];
let apiRoutes = []; // [{match(url, opts), reply}]

globalThis.api = function(url, opts) {
  apiCalls.push({ url: url, opts: opts || null });
  for (let i = 0; i < apiRoutes.length; i++) {
    if (apiRoutes[i].match(url, opts)) {
      const r = typeof apiRoutes[i].reply === 'function' ? apiRoutes[i].reply(url, opts) : apiRoutes[i].reply;
      if (r && r.__reject) return Promise.reject(new Error(r.__reject));
      return Promise.resolve(r);
    }
  }
  return Promise.resolve({});
};

const fetchCalls = [];
globalThis.fetch = function(url, opts) {
  fetchCalls.push({ url: String(url), opts: opts || null });
  if (String(url).indexOf('api/upload') !== -1) {
    return Promise.resolve({
      ok: true,
      json: function() {
        return Promise.resolve({ filename: 'a.png', path: '/tmp/up/a.png', mime: 'image/png', size: 5 });
      },
    });
  }
  return Promise.resolve({ ok: true, json: function() { return Promise.resolve({}); } });
};

class FakeFormData {
  constructor() { this.entries = []; }
  append(k, v, name) { this.entries.push({ key: k, name: name || null }); }
}
globalThis.FormData = FakeFormData;

globalThis.location = { search: '', hash: '', pathname: '/' };
const toasts = [];
globalThis.showToast = function(msg) { toasts.push(String(msg)); };
const loadSessionCalls = [];
globalThis.loadSession = function(sid) { loadSessionCalls.push(sid); };
globalThis.confirm = function() { return true; };
const renderTranscriptCalls = [];
globalThis.renderTranscript = function(container, messages, opts) {
  renderTranscriptCalls.push({ messages: messages, opts: opts });
  return container;
};
globalThis.renderMd = null;
globalThis.postProcessRenderedMessages = null;
globalThis.executeCommand = null;
globalThis.switchPanel = null;

// ── Extract + evaluate module IIFEs ────────────────────────────────────────
function extractIifeBody(src) {
  const start = src.indexOf('(function()');
  if (start === -1) return src;
  const braceOpen = src.indexOf('{', start + 9);
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

function evalModule(file) {
  const src = fs.readFileSync(path.join(VN_DIR, file), 'utf-8');
  const body = extractIifeBody(src);
  const fn = new Function(
    'window', 'document', 'console',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    body
  );
  fn(globalThis, fakeDoc, console, setTimeout, clearTimeout, setInterval, clearInterval);
}

MODULES.forEach(evalModule);

const GestaltVN = globalThis.GestaltVN;

// ── Route helpers ──────────────────────────────────────────────────────────
function isGet(opts) { return !opts || !opts.method || opts.method === 'GET'; }
function isPost(opts) { return opts && opts.method === 'POST'; }
function bodyOf(opts) { try { return JSON.parse((opts && opts.body) || '{}'); } catch (_) { return {}; } }

// ═══ Tests ═══════════════════════════════════════════════════════════════

async function testEvents() {
  console.log('── vnEvents: normalization / dedupe / replay / dispose ──');
  FakeEventSource.instances = [];
  const ok = GestaltVN.events.init({ sessionId: 's1', operatorId: 'nei' });
  assert(ok === true, 'events.init returns true with valid sessionId');
  assert(FakeEventSource.instances.length === 1, 'one EventSource opened');
  const es = FakeEventSource.instances[0];
  assert(es.url === '/api/hyrax/vn/conversations/s1/events',
    'EventSource URL is the VN events endpoint (got ' + es.url + ')');

  const received = [];
  GestaltVN.events.subscribe('response.token', function(ev) { received.push(ev); });
  const toolEvents = [];
  GestaltVN.events.subscribe('tool.*', function(ev) { toolEvents.push(ev); });
  const allEvents = [];
  GestaltVN.events.subscribe('*', function(ev) { allEvents.push(ev); });
  const reconnects = [];
  GestaltVN.events.subscribe('reconnect', function(ev) { reconnects.push(ev); });

  es._open();
  es._emit('token', { text: 'Hello' }, 'e1');
  assert(received.length === 1, 'token frame → exactly one response.token event');
  const ev1 = received[0];
  assert(ev1.kind === 'response.token', 'kind mapped token→response.token');
  assert(ev1.source === 'hermes', 'source is hermes');
  assert(ev1.sessionId === 's1', 'sessionId stamped');
  assert(ev1.operatorId === 'nei', 'operatorId stamped');
  assert(ev1.payload && ev1.payload.text === 'Hello', 'payload preserved');
  assert(typeof ev1.id === 'string' && ev1.id.length > 0, 'id present');
  assert(typeof ev1.timestamp === 'string' && ev1.timestamp.length > 0, 'timestamp present');
  assert(typeof ev1.sequence === 'number', 'sequence present');

  es._emit('tool', { name: 'bash', args: { cmd: 'ls' } }, 'e2');
  assert(toolEvents.length === 1, 'tool.* wildcard matches tool.started');
  assert(toolEvents[0].kind === 'tool.started', 'kind mapped tool→tool.started');

  es._emit('metering', { tps: 12 }, 'e3');
  assert(allEvents.some(function(e) { return e.kind === 'metering.update'; }),
    'kind mapped metering→metering.update');

  // Dedupe by server event id
  es._emit('token', { text: 'Hello again' }, 'e1');
  assert(received.length === 1, 'duplicate server event id is dropped');

  // Untyped frame heuristics
  es._emitUntyped({ text: 'untyped delta' }, 'e5');
  assert(received.length === 2, 'untyped text payload treated as token');

  // Terminal frame (apperror): the server serves one run per connection and
  // never writes to it again — the module must close the spent EventSource
  // and re-arm a fresh one with the after_event_id resume cursor.
  es._emit('apperror', { label: 'boom' }, 'e4');
  assert(allEvents.some(function(e) { return e.kind === 'response.failed'; }),
    'kind mapped apperror→response.failed');
  assert(FakeEventSource.instances.length === 2,
    'terminal frame re-arms a fresh EventSource');
  assert(es.closed === true, 'terminal frame closes the spent EventSource');
  const es2 = FakeEventSource.instances[1];
  assert(es2.url === '/api/hyrax/vn/conversations/s1/events?after_event_id=e4',
    're-armed stream resumes after the last server id (got ' + es2.url + ')');

  // The spent connection is dead: frames from it are dropped.
  es._emit('token', { text: 'stale frame' }, 'e9');
  assert(received.length === 2, 'frames from the closed stream are dropped');

  // Dedupe survives the re-arm (the ring is transport-independent).
  es2._emit('token', { text: 'Hello again' }, 'e1');
  assert(received.length === 2, 'duplicate server id dropped across re-arm');

  // Reconnect signal on the re-armed stream's first open.
  es2._open();
  assert(reconnects.length === 1, 're-armed open emits reconnect to subscribers');

  // Turn 2 on the re-armed stream: events flow again.
  es2._emit('token', { text: 'turn two' }, 'e6');
  assert(received.length === 3 && received[2].payload.text === 'turn two',
    'next turn streams on the re-armed connection');

  // The native `error` type is terminal server-side too — mapped and re-armed.
  es2._emit('error', { label: 'native error' }, 'e7');
  assert(allEvents.filter(function(e) { return e.kind === 'response.failed'; }).length === 2,
    'kind mapped error→response.failed');
  assert(FakeEventSource.instances.length === 3 &&
    FakeEventSource.instances[2].url.indexOf('after_event_id=e7') !== -1,
    'native error re-arms with the resume cursor');
  const es3 = FakeEventSource.instances[2];

  // stream_end re-arms as well (the normal end-of-run path).
  es3._emit('stream_end', { session_id: 's1' }, 'e8');
  assert(allEvents.some(function(e) { return e.kind === 'stream.end'; }),
    'kind mapped stream_end→stream.end');
  assert(FakeEventSource.instances.length === 4 &&
    FakeEventSource.instances[3].url.indexOf('after_event_id=e8') !== -1,
    'stream_end re-arms with the resume cursor');
  const es4 = FakeEventSource.instances[3];

  // Replay: ordered ring buffer (undisturbed by re-arms)
  const replayed = [];
  GestaltVN.events.replay(function(ev) { replayed.push(ev.id); });
  assert(replayed.join(',') === 'e1,e2,e3,e5,e4,e6,e7,e8',
    'replay delivers buffered events in order (got ' + replayed.join(',') + ')');
  assert(GestaltVN.events.getSequence() >= 8, 'getSequence advances');

  // Dispose
  GestaltVN.events.dispose();
  assert(es4.closed === true, 'dispose closes the EventSource');
  es4._emit('token', { text: 'after dispose' }, 'e10');
  assert(received.length === 3, 'frames after dispose are dropped');
  const empty = [];
  GestaltVN.events.replay(function(ev) { empty.push(ev); });
  assert(empty.length === 0, 'dispose clears the ring buffer');

  // Fail closed: no sessionId
  assert(GestaltVN.events.init({}) === false, 'init without sessionId fails closed');
}

async function testSession() {
  console.log('\n── vnSession: selection precedence ──');

  // 1. Deep link wins — GET validation, no POST
  globalThis.location = { search: '?session=deep1', hash: '', pathname: '/' };
  apiCalls.length = 0;
  apiRoutes = [
    { match: function(url, opts) { return url === '/api/hyrax/vn/conversations/deep1' && isGet(opts); },
      reply: { conversation: { session_id: 'deep1', profile: 'nei', messages: [] } } },
    { match: function(url, opts) { return url === '/api/hyrax/vn/conversations' && isPost(opts); },
      reply: { conversation: { session_id: 'should_not_happen' } } },
  ];
  let ref = await GestaltVN.session.open({ operatorId: 'nei' });
  assert(ref && ref.sessionId === 'deep1', 'deep link ?session= is selected first');
  const posted = apiCalls.some(function(c) { return c.url === '/api/hyrax/vn/conversations' && isPost(c.opts); });
  assert(!posted, 'deep link path does not POST select-or-create');

  // 2. No deep link → POST select-or-create, pathname session as context seed
  globalThis.location = { search: '', hash: '', pathname: '/session/ctx9' };
  apiCalls.length = 0;
  apiRoutes = [
    { match: function(url, opts) { return url === '/api/hyrax/vn/conversations' && isPost(opts); },
      reply: { conversation: { session_id: 'vn1', profile_id: 'nei', active_stream_id: 'st1', messages: [{ role: 'user', content: 'hi', id: 'm1' }] } } },
  ];
  ref = await GestaltVN.session.open({ operatorId: 'nei', source: { kind: 'chibi' } });
  assert(ref && ref.sessionId === 'vn1', 'select-or-create returns SessionRef');
  const postCall = apiCalls.find(function(c) { return c.url === '/api/hyrax/vn/conversations' && isPost(c.opts); });
  const body = bodyOf(postCall && postCall.opts);
  assert(body.profile_id === 'nei', 'POST body carries profile_id');
  assert(body.fresh === false, 'POST body fresh:false');
  assert(body.current_session_id === 'ctx9',
    'pathname /session/<sid> seeds current_session_id (audit §3 fix)');
  assert(GestaltVN.session.busy() === true, 'busy() reflects active_stream_id');
  assert(ref.projectId === 'hyrax-vn', 'SessionRef.projectId is hyrax-vn');

  // 3. Deep link that 404s → falls through to select-or-create (fail closed)
  globalThis.location = { search: '?session=gone1', hash: '', pathname: '/' };
  apiCalls.length = 0;
  apiRoutes = [
    { match: function(url, opts) { return url === '/api/hyrax/vn/conversations/gone1' && isGet(opts); },
      reply: { __reject: '404 not found' } },
    { match: function(url, opts) { return url === '/api/hyrax/vn/conversations' && isPost(opts); },
      reply: { conversation: { session_id: 'vn2', profile_id: 'nei', messages: [] } } },
  ];
  ref = await GestaltVN.session.open({ operatorId: 'nei' });
  assert(ref && ref.sessionId === 'vn2', 'failed deep link falls through to select-or-create');
  assert(GestaltVN.session.busy() === false, 'busy() false without active_stream_id');

  // 4. fetchTranscript paging shape
  apiRoutes = [
    { match: function(url) { return url.indexOf('/api/hyrax/vn/conversations/vn2') === 0 && isGet({ method: 'GET' }); },
      reply: { conversation: { session_id: 'vn2', messages: [
        { role: 'user', content: 'a', id: 'm1' },
        { role: 'assistant', content: 'b', id: 'm2' },
        { role: 'user', content: 'c', id: 'm3' },
      ] } } },
  ];
  const page = await GestaltVN.session.fetchTranscript({ limit: 2, before: 'm3' });
  assert(page.messages.length === 2 && page.messages[0].id === 'm1',
    'fetchTranscript slices before/limit client-side');

  // 5. openInStandardChat delegates to native loadSession
  loadSessionCalls.length = 0;
  const opened = GestaltVN.session.openInStandardChat();
  assert(opened === true && loadSessionCalls[0] === 'vn2',
    'openInStandardChat calls loadSession with the VN session id');
}

async function testComposer() {
  console.log('\n── vnComposer: send path / busy disable / attachments / slash ──');

  // Idle session (no active stream)
  globalThis.location = { search: '', hash: '', pathname: '/' };
  apiRoutes = [
    { match: function(url, opts) { return url === '/api/hyrax/vn/conversations' && isPost(opts); },
      reply: { conversation: { session_id: 'vnC', profile_id: 'nei', messages: [] } } },
    { match: function(url, opts) { return url.indexOf('/turns') !== -1 && isPost(opts); },
      reply: { stream_id: 'st9', pending: true, status: 200 } },
  ];
  await GestaltVN.session.open({ operatorId: 'nei' });

  const container = makeEl('div');
  assert(GestaltVN.composer.init({ container: container }) === true, 'composer.init builds');

  const textarea = container.querySelector('textarea');
  const sendBtn = container.querySelector('.vn2-btn--send');
  assert(!!textarea && !!sendBtn, 'textarea + send button exist');
  assert(textarea.getAttribute('maxlength') === '4000', 'maxlength synced to server limit 4000');

  // Plain send
  apiCalls.length = 0;
  textarea.value = 'hello nei';
  sendBtn.click();
  await flush();
  const turnCall = apiCalls.find(function(c) { return c.url.indexOf('/turns') !== -1; });
  assert(!!turnCall, 'send POSTs to the turn endpoint');
  assert(turnCall && turnCall.url.indexOf('/api/hyrax/vn/conversations/vnC/turns') === 0,
    'turn endpoint targets the current session');
  const turnBody = bodyOf(turnCall && turnCall.opts);
  assert(turnBody.text === 'hello nei', 'turn body carries trimmed text');
  assert(!('attachments' in turnBody), 'no attachments key when nothing staged');
  assert(textarea.value === '', 'textarea cleared after send');
  assert(sendBtn.disabled === true, 'send disabled while turn in flight');
  const cancelBtn = container.querySelector('.vn2-btn--cancel');
  assert(cancelBtn && cancelBtn.hidden === false, 'cancel visible while in flight');

  // Cancel
  apiCalls.length = 0;
  await GestaltVN.composer.cancel();
  const cancelCall = apiCalls.find(function(c) { return c.url.indexOf('/api/chat/cancel') === 0; });
  assert(!!cancelCall && cancelCall.url.indexOf('stream_id=st9') !== -1,
    'cancel hits /api/chat/cancel with the in-flight stream_id');
  assert(sendBtn.disabled === false, 'send re-enabled after cancel');

  // Busy session → send is gated (duplicate-send prevention, SPEC §3)
  apiRoutes = [
    { match: function(url, opts) { return url === '/api/hyrax/vn/conversations' && isPost(opts); },
      reply: { conversation: { session_id: 'vnC', profile_id: 'nei', active_stream_id: 'stX', messages: [] } } },
  ];
  await GestaltVN.session.open({ operatorId: 'nei' });
  apiCalls.length = 0;
  toasts.length = 0;
  textarea.value = 'should not send';
  sendBtn.click();
  await flush();
  assert(!apiCalls.some(function(c) { return c.url.indexOf('/turns') !== -1; }),
    'send is blocked while the session is busy');
  assert(toasts.length > 0, 'busy send surfaces a note');

  // Back to idle for attachment staging
  apiRoutes = [
    { match: function(url, opts) { return url === '/api/hyrax/vn/conversations' && isPost(opts); },
      reply: { conversation: { session_id: 'vnC', profile_id: 'nei', messages: [] } } },
    { match: function(url, opts) { return url.indexOf('/turns') !== -1 && isPost(opts); },
      reply: { stream_id: 'st10', pending: true, status: 200 } },
  ];
  await GestaltVN.session.open({ operatorId: 'nei' });

  fetchCalls.length = 0;
  apiCalls.length = 0;
  GestaltVN.composer.stageFiles([{ name: 'a.png', size: 5 }]);
  const tray = container.querySelector('.vn2-attach-tray');
  assert(tray && tray.hidden === false, 'staged attachment shows in the tray');
  assert(tray.querySelectorAll('.vn2-attach-chip').length === 1, 'one chip per staged file');
  textarea.value = 'with file';
  sendBtn.click();
  await flush();
  assert(fetchCalls.some(function(c) { return c.url.indexOf('api/upload') !== -1; }),
    'staged file uploads via api/upload before the turn');
  const turn2 = apiCalls.find(function(c) { return c.url.indexOf('/turns') !== -1; });
  const body2 = bodyOf(turn2 && turn2.opts);
  assert(Array.isArray(body2.attachments) && body2.attachments.length === 1,
    'turn body includes uploaded attachment refs');
  assert(body2.attachments && body2.attachments[0].path === '/tmp/up/a.png',
    'attachment ref carries the server path');
  await GestaltVN.composer.cancel(); // settle

  // Slash commands: handler missing/throwing → degrade to plain text + note
  globalThis.executeCommand = function() { throw new Error('needs main chat DOM'); };
  apiCalls.length = 0;
  toasts.length = 0;
  textarea.value = '/model foo';
  sendBtn.click();
  await flush();
  const slashTurn = apiCalls.find(function(c) { return c.url.indexOf('/turns') !== -1; });
  assert(!!slashTurn && bodyOf(slashTurn.opts).text === '/model foo',
    'throwing slash handler degrades to a plain text send');
  assert(toasts.some(function(t) { return t.indexOf('main chat') !== -1; }),
    'degraded slash send is noted');

  // Slash commands: handled → no turn
  globalThis.executeCommand = function() { return { noEcho: true }; };
  apiCalls.length = 0;
  textarea.value = '/help';
  sendBtn.click();
  await flush();
  assert(!apiCalls.some(function(c) { return c.url.indexOf('/turns') !== -1; }),
    'handled slash command does not POST a turn');
  globalThis.executeCommand = null;

  // Regenerate → native retry endpoint
  await GestaltVN.composer.cancel(); // settle the in-flight from slash test… (none; safe no-op)
  apiCalls.length = 0;
  apiRoutes.push({ match: function(url, opts) { return url === '/api/session/retry' && isPost(opts); }, reply: { ok: true } });
  await GestaltVN.composer.regenerate();
  const retryCall = apiCalls.find(function(c) { return c.url === '/api/session/retry'; });
  assert(!!retryCall && bodyOf(retryCall.opts).session_id === 'vnC',
    'regenerate posts to /api/session/retry for the VN session');

  GestaltVN.composer.dispose();
  assert(container._form === null || container._form === undefined, 'composer.dispose removes the form');
}

async function testApprovals() {
  console.log('\n── vnApprovals: poll + respond ──');
  apiRoutes = [
    { match: function(url) { return url.indexOf('/approvals/pending') !== -1; },
      reply: { pending: { approval_id: 'a1', description: 'Run shell command', command: 'rm -rf /tmp/x', risk: 'high' }, pending_count: 1 } },
    { match: function(url) { return url.indexOf('/clarify/pending') !== -1; },
      reply: { pending: { clarify_id: 'c1', question: 'Which environment?', choices_offered: ['staging', 'prod'] } } },
    { match: function(url, opts) { return url === '/api/approval/respond' && isPost(opts); }, reply: { ok: true } },
    { match: function(url, opts) { return url === '/api/clarify/respond' && isPost(opts); }, reply: { ok: true, response: 'staging' } },
  ];

  const container = makeEl('div');
  assert(GestaltVN.approvals.init({ container: container, sessionId: 'vnA' }) === true,
    'approvals.init starts');
  GestaltVN.approvals.refresh();
  await flush();

  const card = container.querySelector('.vn2-approval-card');
  assert(!!card, 'pending approval renders a card');
  assert(card && card.getAttribute('role') === 'alert', 'approval card is role=alert (SR-loud)');
  assert(card && card.textContent.indexOf('rm -rf /tmp/x') !== -1, 'approval card shows the command');

  const clarify = container.querySelector('.vn2-clarify-card');
  assert(!!clarify, 'pending clarify renders a card');
  assert(clarify && clarify.getAttribute('role') === 'alert', 'clarify card is role=alert');
  assert(clarify && clarify.querySelectorAll('.vn2-clarify-btn').length === 2,
    'clarify choices render as buttons');

  // Approve once
  apiCalls.length = 0;
  card.querySelector('.vn2-approval-btn--once').click();
  await flush();
  const respondCall = apiCalls.find(function(c) { return c.url === '/api/approval/respond'; });
  assert(!!respondCall, 'approve posts to /api/approval/respond');
  const respondBody = bodyOf(respondCall && respondCall.opts);
  assert(respondBody.session_id === 'vnA' && respondBody.choice === 'once' && respondBody.approval_id === 'a1',
    'respond body carries session/choice/approval_id');
  // Poll after ok → server now reports nothing pending → card removed
  apiRoutes[0].reply = { pending: null };
  GestaltVN.approvals.refresh();
  await flush();
  assert(!container.querySelector('.vn2-approval-card'), 'resolved approval card is removed');

  // Clarify choice
  apiCalls.length = 0;
  clarify.querySelectorAll('.vn2-clarify-btn')[0].click();
  await flush();
  const clarifyCall = apiCalls.find(function(c) { return c.url === '/api/clarify/respond'; });
  assert(!!clarifyCall, 'clarify choice posts to /api/clarify/respond');
  const clarifyBody = bodyOf(clarifyCall && clarifyCall.opts);
  assert(clarifyBody.response === 'staging' && clarifyBody.clarify_id === 'c1',
    'clarify respond body carries response + clarify_id');

  GestaltVN.approvals.dispose();
  GestaltVN.approvals.refresh(); // must be a no-op after dispose
  assert(true, 'dispose + post-dispose refresh does not throw');
}

async function testShell() {
  console.log('\n── vnShell: mount/unmount contract ──');
  globalThis.location = { search: '', hash: '', pathname: '/' };
  renderTranscriptCalls.length = 0;
  FakeEventSource.instances = [];
  apiRoutes = [
    { match: function(url) { return url === '/api/hyrax/vn/profiles'; },
      reply: { items: [{ id: 'nei', name: 'Nei', available: true }, { id: 'rei', name: 'Rei', available: true }] } },
    { match: function(url, opts) { return url === '/api/hyrax/vn/conversations' && isPost(opts); },
      reply: function(url, opts) {
        const b = bodyOf(opts);
        return { conversation: {
          session_id: b.profile_id === 'rei' ? 'vn200' : 'vn100',
          profile_id: b.profile_id,
          messages: [
            { role: 'user', content: 'hi', id: 'm1' },
            { role: 'assistant', content: 'hello', id: 'm2' },
          ],
          expression: { current: 'smile', intensity: 0.6 },
        } };
      } },
    { match: function(url) { return url.indexOf('/approvals/pending') !== -1; }, reply: { pending: null } },
    { match: function(url) { return url.indexOf('/clarify/pending') !== -1; }, reply: { pending: null } },
  ];

  // Mount
  await globalThis.__vnMount({ sisterId: 'nei', sisterName: 'Nei' });
  await flush();
  assert(GestaltVN.shell.isMounted() === true, '__vnMount mounts the shell');
  const regions = GestaltVN.shell.regions();
  assert(!!(regions && regions.root && regions.topBar && regions.stage &&
    regions.dialogue && regions.sidebar && regions.drawer && regions.composer &&
    regions.approvals),
    'shell exposes all layout regions (PRODUCT_SPEC §2)');
  assert(renderTranscriptCalls.length > 0 && renderTranscriptCalls[0].messages.length === 2,
    'history renders through window.renderTranscript');
  assert(regions.moodEl.textContent === 'smile', 'top bar mood comes from the session expression');
  const portrait = regions.root.querySelector('.vn2-portrait');
  assert(portrait && portrait.getAttribute('src').indexOf('/api/hyrax/assets/nei.portrait.neutral') !== -1,
    'static portrait fallback uses <op>.portrait.neutral');
  assert(FakeEventSource.instances.length === 1 &&
    FakeEventSource.instances[0].url.indexOf('/conversations/vn100/events') !== -1,
    'single SSE connection for the mounted session');
  assert(layoutEl.classList.contains('sidebar-collapsed'),
    'sidebar collapsed via the centralized core-DOM path');

  // setTopBar / setState surface for the experience layer
  GestaltVN.shell.setTopBar({ mood: 'focused' });
  assert(regions.moodEl.textContent === 'focused', 'setTopBar updates the mood badge');
  GestaltVN.shell.setState({ busy: true });
  assert(regions.stateEl.getAttribute('data-state') === 'busy', 'setState updates the state chip');

  // Unmount — full dispose
  const es = FakeEventSource.instances[0];
  globalThis.__vnUnmount();
  assert(GestaltVN.shell.isMounted() === false, '__vnUnmount flips the mounted guard');
  assert(es.closed === true, 'unmount closes the SSE connection');
  assert(!layoutEl.classList.contains('sidebar-collapsed'), 'unmount restores the sidebar');
  assert(GestaltVN.shell.regions() === null, 'regions cleared on unmount');

  // Idempotent unmount
  globalThis.__vnUnmount();
  assert(true, 'double __vnUnmount does not throw');

  // Remount works after unmount
  await globalThis.__vnMount({ sisterId: 'nei', sisterName: 'Nei' });
  await flush();
  assert(GestaltVN.shell.isMounted() === true, 'remount after unmount works');
  globalThis.__vnUnmount();

  // hyrax:open-conversation entry (same contract as legacy vn.js)
  FakeEventSource.instances = [];
  fakeDoc.dispatchEvent({ type: 'hyrax:open-conversation', detail: { sisterId: 'rei', sisterName: 'Rei' } });
  await flush();
  assert(GestaltVN.shell.isMounted() === true, 'hyrax:open-conversation mounts the VN');
  assert(FakeEventSource.instances.length === 1 &&
    FakeEventSource.instances[0].url.indexOf('/conversations/vn200/events') !== -1,
    'event entry connects the sister session stream');

  // __vnReopen remounts the current props
  globalThis.__vnReopen();
  await flush();
  assert(GestaltVN.shell.isMounted() === true, '__vnReopen remounts');
  globalThis.__vnUnmount();

  // Malformed event detail is ignored (fail closed)
  fakeDoc.dispatchEvent({ type: 'hyrax:open-conversation', detail: {} });
  await flush();
  assert(GestaltVN.shell.isMounted() === false, 'detail without sisterId is ignored');
}

// ── Run ────────────────────────────────────────────────────────────────────
(async function() {
  console.log('═══ Gestalt VN (vn2) Client-Core Execution Tests ═══\n');
  assert(!!GestaltVN, 'window.GestaltVN namespace exists');
  ['events', 'session', 'dialogue', 'composer', 'approvals', 'techDrawer', 'shell'].forEach(function(k) {
    assert(!!(GestaltVN && GestaltVN[k]), 'GestaltVN.' + k + ' registered');
  });
  assert(typeof globalThis.__vnMount === 'function', '__vnMount exposed');
  assert(typeof globalThis.__vnUnmount === 'function', '__vnUnmount exposed');
  assert(typeof globalThis.__vnReopen === 'function', '__vnReopen exposed');

  await testEvents();
  await testSession();
  await testComposer();
  await testApprovals();
  await testShell();
})().then(function() {
  console.log('\n═══ Results: ' + passed + ' passed, ' + failed + ' failed ═══\n');
  if (failures.length > 0) {
    console.error('FAILURES:');
    failures.forEach(function(f) { console.error('  ✗ ' + f); });
    process.exit(1);
  }
  process.exit(0); // Force exit — polling timers keep the loop alive
}).catch(function(err) {
  console.error('UNEXPECTED ERROR:', err);
  process.exit(1);
});
