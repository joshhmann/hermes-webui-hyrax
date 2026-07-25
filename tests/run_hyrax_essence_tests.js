#!/usr/bin/env node
/**
 * Execution-level Node harness for the Gestalt VN experience layer:
 * essence runtime (state / frames / intents), VN stage + providers,
 * action registry, sidebar, room manifests.
 *
 * Verifies (per docs/gestalt-vn specs):
 *   - sceneSignature stability (coarse fields only; conversational noise excluded)
 *   - frame selection ranking + confidence floor + fallback ladder
 *   - intents: valid/invalid triggers, debounce, cooldown, reset/explicit bypass
 *   - sidebar availability from fixtures, overflow, confirmation dialog
 *   - action duplicate-execution lock + unregistered-id guard
 *   - room manifest schema validation (fail closed) + world-state effects
 *   - stage fallback ladder when the registry fetch fails
 *
 * Usage:
 *   node tests/run_hyrax_essence_tests.js
 *
 * Exit code: 0 = all pass, 1 = any failure.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const STATIC = path.join(__dirname, '..', 'static', 'hyrax');
const FILES = [
  path.join(STATIC, 'essence', 'essenceState.js'),
  path.join(STATIC, 'essence', 'essenceFrames.js'),
  path.join(STATIC, 'essence', 'essenceIntents.js'),
  path.join(STATIC, 'vn', 'vnActions.js'),
  path.join(STATIC, 'vn', 'vnStage.js'),
  path.join(STATIC, 'vn', 'vnSidebar.js'),
];

// ── Assertions ─────────────────────────────────────────────────────────────
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

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function deferred() {
  let res, rej;
  const p = new Promise(function (resolve, reject) { res = resolve; rej = reject; });
  return { promise: p, resolve: res, reject: rej };
}

// ── Fake DOM ───────────────────────────────────────────────────────────────
function makeEl(tag) {
  const clsList = [];
  const el = {
    tagName: String(tag).toUpperCase(),
    className: '',
    textContent: '',
    innerHTML: '',
    style: {},
    id: '',
    hidden: false,
    disabled: false,
    src: '',
    alt: '',
    _children: [],
    _attrs: {},
    _listeners: {},
    dataset: {},
    get classList() {
      return {
        contains(c) { return clsList.indexOf(c) !== -1; },
        add() { for (let i = 0; i < arguments.length; i++) { if (clsList.indexOf(arguments[i]) === -1) clsList.push(arguments[i]); } },
        remove() { for (let i = 0; i < arguments.length; i++) { const idx = clsList.indexOf(arguments[i]); if (idx !== -1) clsList.splice(idx, 1); } },
        toggle(c) { const idx = clsList.indexOf(c); if (idx !== -1) { clsList.splice(idx, 1); return false; } clsList.push(c); return true; },
        toString() { return clsList.join(' '); },
      };
    },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
    hasAttribute(k) { return k in this._attrs; },
    removeAttribute(k) { delete this._attrs[k]; },
    appendChild(c) { if (c != null) this._children.push(c); return c; },
    insertBefore(c) { if (c) this._children.push(c); return c; },
    replaceChildren() { this._children = []; for (let i = 0; i < arguments.length; i++) { if (arguments[i] != null) this._children.push(arguments[i]); } },
    append() { for (let i = 0; i < arguments.length; i++) { if (arguments[i] != null) this._children.push(arguments[i]); } },
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const arr = this._listeners[type];
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx !== -1) arr.splice(idx, 1);
    },
    _fire(type, ev) {
      const arr = this._listeners[type] || [];
      arr.slice().forEach(function (fn) { fn(ev || { type: type }); });
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    focus() {},
    remove() {},
    getBoundingClientRect() { return { width: 100, height: 100, left: 0, top: 0 }; },
    get children() { return this._children; },
  };
  return el;
}

function findAll(el, pred, out) {
  out = out || [];
  if (!el) return out;
  if (pred(el)) out.push(el);
  (el._children || []).forEach(function (c) { findAll(c, pred, out); });
  return out;
}

function byActionId(el, id) {
  return findAll(el, function (n) {
    return n._attrs && n._attrs['data-action-id'] === id;
  })[0] || null;
}

function byClass(el, cls) {
  return findAll(el, function (n) {
    return typeof n.className === 'string' && n.className.split(' ').indexOf(cls) !== -1;
  });
}

const fakeDoc = {
  createElement(tag) { return makeEl(tag); },
  createTextNode(t) { return { textContent: String(t) }; },
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  addEventListener() {},
  removeEventListener() {},
  head: { appendChild() {} },
  body: makeEl('body'),
};

// ── Mock window + api ──────────────────────────────────────────────────────
const apiCalls = [];
let registryFixture = null;    // payload for /api/hyrax/essence/frames?...
let registryError = false;
const essenceFixtures = {};    // operatorId -> payload | 'error'
const sentTexts = [];
const loadedSessions = [];
const switchedPanels = [];
const warnLog = [];

const fakeWindow = {
  api: function (url, opts) {
    apiCalls.push({ url: url, opts: opts });
    if (url.indexOf('/api/hyrax/essence/frames?') === 0) {
      if (registryError) return Promise.reject(new Error('registry down'));
      return Promise.resolve(registryFixture || { frames: [] });
    }
    if (url === '/api/hyrax/essence/frames/register') {
      return Promise.resolve({ ok: true });
    }
    const m = url.match(/^\/api\/hyrax\/essence\/([a-z]+)$/);
    if (m) {
      const fx = essenceFixtures[m[1]];
      if (fx === 'error') return Promise.reject(new Error('essence down'));
      return Promise.resolve(fx || {
        mood: { primary: 'neutral', valence: 0.2, arousal: 0.3 },
        energy: 0.7,
        social: { warmth: 0.5, trust: 0.6 },
        provenance: { 'mood.primary': 'read' },
        updatedAt: new Date().toISOString(),
      });
    }
    if (url === '/api/hyrax/presence') {
      return Promise.resolve({ items: [], meta: { generatedAt: new Date().toISOString() } });
    }
    if (url.indexOf('/api/kanban/tasks') === 0) {
      return Promise.resolve({ items: [{ id: 'task-1', title: 'Fix the thing' }] });
    }
    if (url === '/api/hyrax/vn/conversations' && opts && opts.method === 'POST') {
      return Promise.resolve({ conversation: { id: 'vn_new_1', profile_id: 'tai' } });
    }
    return Promise.resolve({});
  },
  showToast: function () {},
  loadSession: function (sid) { loadedSessions.push(sid); },
  switchPanel: function (p) { switchedPanels.push(p); },
};

const fakeConsole = {
  log: function () {},
  error: function () {},
  warn: function (msg) { warnLog.push(String(msg)); },
};

const fakeFetch = function () { return Promise.reject(new Error('fetch disabled in harness')); };

// ── IIFE extraction + eval ─────────────────────────────────────────────────
function extractIifeBody(src) {
  const start = src.indexOf('(function');
  if (start === -1) throw new Error('no IIFE found');
  const braceOpen = src.indexOf('{', start);
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

FILES.forEach(function (file) {
  const body = extractIifeBody(fs.readFileSync(file, 'utf-8'));
  const fn = new Function(
    'window', 'document', 'console', 'setTimeout', 'clearTimeout', 'fetch',
    body
  );
  fn(fakeWindow, fakeDoc, fakeConsole, setTimeout, clearTimeout, fakeFetch);
});

const GestaltVN = fakeWindow.GestaltVN;
const essenceState = GestaltVN.essence.state;
const frames = GestaltVN.essence.frames;
const intents = GestaltVN.essence.intents;
const actions = GestaltVN.vn.actions;
const roomsApi = GestaltVN.vn.rooms;
const stage = GestaltVN.vn.stage;
const sidebar = GestaltVN.vn.sidebar;
const providers = GestaltVN.vn.providers;

function mkState(over) {
  over = over || {};
  return {
    operatorId: over.operatorId || 'tai',
    mood: {
      primary: over.moodPrimary || 'neutral',
      intensity: typeof over.intensity === 'number' ? over.intensity : 0.4,
      confidence: typeof over.confidence === 'number' ? over.confidence : 0.7,
    },
    condition: {},
    activity: { type: over.activityType || 'idle', interruptibility: 'free' },
    social: {},
    presentation: {
      expression: over.expression || 'neutral',
      timeOfDay: over.timeOfDay || 'day',
      location: over.location || undefined,
      wardrobe: over.wardrobe || undefined,
      framing: over.framing || undefined,
    },
    provenance: {},
    updatedAt: new Date().toISOString(),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('═══ Gestalt VN Essence/Experience Tests ═══\n');

  // 1. Namespace surface
  console.log('── Namespace surface ──');
  assert(!!GestaltVN, 'window.GestaltVN exists');
  assert(!!essenceState && typeof essenceState.get === 'function' &&
    typeof essenceState.refresh === 'function' &&
    typeof essenceState.subscribe === 'function', 'essence.state surface');
  assert(!!frames && typeof frames.selectFrame === 'function' &&
    typeof frames.computeSceneSignature === 'function' &&
    typeof frames.registerDrop === 'function', 'essence.frames surface');
  assert(!!intents && typeof intents.evaluate === 'function' &&
    typeof intents.subscribe === 'function', 'essence.intents surface');
  assert(!!stage && typeof stage.init === 'function' &&
    typeof stage.applyIntent === 'function', 'vn.stage surface');
  assert(!!sidebar && typeof sidebar.init === 'function', 'vn.sidebar surface');
  assert(!!actions && typeof actions.run === 'function', 'vn.actions surface');
  assert(!!roomsApi && typeof roomsApi.validate === 'function', 'vn.rooms surface');
  assert(!!providers.get('static-essence-frames'), 'StaticEssenceFrameProvider registered');
  assert(!!providers.get('fallback-portrait'), 'FallbackPortraitProvider registered');

  // 2. Scene signature stability (spec §4)
  console.log('\n── Scene signatures ──');
  const coarse = {
    operatorId: 'tai', location: 'ops', wardrobe: 'casual',
    expression: 'smile', pose: 'standing', timeOfDay: 'day',
    framing: 'medium', props: ['lamp', 'desk'],
  };
  const sigA = frames.computeSceneSignature(coarse);
  assert(sigA === frames.computeSceneSignature(coarse), 'same coarse state → same signature');
  assert(typeof sigA === 'string' && sigA.length > 0, 'signature is a non-empty string');
  // Conversational noise must NOT change the signature.
  const noisy = Object.assign({}, coarse, {
    description: 'a long conversational ramble about tokens',
    progress: 0.42, tool: 'bash', tokens: 12345,
    updatedAt: '2026-07-24T00:00:00Z', reasoning: 'delta',
  });
  assert(frames.computeSceneSignature(noisy) === sigA,
    'conversational noise does not change signature');
  // Minor mood drift inside one expression family → same signature.
  assert(frames.computeSceneSignature(Object.assign({}, coarse, { expression: 'laughing' })) === sigA,
    'same expression family (smile→laughing) keeps signature');
  // Expression-family change → new signature.
  assert(frames.computeSceneSignature(Object.assign({}, coarse, { expression: 'sarcastic' })) !== sigA,
    'expression-family change (smile→sarcastic) changes signature');
  // Location / time-of-day band changes → new signature.
  assert(frames.computeSceneSignature(Object.assign({}, coarse, { location: 'lab' })) !== sigA,
    'location change changes signature');
  assert(frames.computeSceneSignature(Object.assign({}, coarse, { timeOfDay: 'night' })) !== sigA,
    'time-of-day band change changes signature');
  // Props: order-insensitive, capped at 3.
  assert(frames.computeSceneSignature(Object.assign({}, coarse, { props: ['desk', 'lamp'] })) === sigA,
    'props order-insensitive');
  assert(frames.computeSceneSignature(Object.assign({}, coarse, { props: ['desk', 'lamp', 'extra', 'fourth'] })) ===
    frames.computeSceneSignature(Object.assign({}, coarse, { props: ['lamp', 'desk', 'extra'] })),
    'props capped at 3');

  // 3. Frame selection ranking + ladder (spec §4)
  console.log('\n── Frame selection ──');
  const selIntent = {
    operatorId: 'tai', expressionIntent: 'happy-emote', poseIntent: 'working',
    location: 'ops', framing: 'medium',
  };
  const selCoarse = {
    operatorId: 'tai', location: 'ops', expression: 'happy-emote',
    pose: 'working', framing: 'medium',
  };
  const sigExact = frames.computeSceneSignature(selCoarse);
  function mkFrame(id, sig, state, quality) {
    return {
      id: id, operatorId: 'tai', version: '1', source: 'authored',
      sceneSignature: sig, state: state,
      assets: { imageUrl: '/img/' + id + '.png' },
      quality: quality || { approved: true },
      continuity: {},
    };
  }
  const fExact = mkFrame('f-exact', sigExact, { location: 'ops', expression: 'happy-emote', pose: 'working' });
  const fUnapproved = mkFrame('f-unapproved', sigExact, { location: 'ops', expression: 'happy-emote' }, { approved: false });
  const fLoc = mkFrame('f-loc', 'sig-loc', { location: 'ops', expression: 'neutral' });
  const fFam = mkFrame('f-fam', 'sig-fam', { location: 'lab', expression: 'smile' });
  const fFamLow = mkFrame('f-fam-low', 'sig-fam-low', { location: 'lab', expression: 'smile' }, { approved: true, score: 0.5 });
  const fDefault = mkFrame('f-default', 'sig-default', { expression: 'neutral' });

  async function loadFixture(list) {
    frames._reset('tai');
    registryError = false;
    registryFixture = { frames: list };
    await frames.load('tai');
  }

  await loadFixture([fUnapproved, fExact, fLoc, fFam, fDefault]);
  let sel = frames.selectFrame(selIntent, {});
  assert(sel.match === 'exact' && sel.frame.id === 'f-exact', 'exact signature wins');
  assert(sel.confidence === 1.0, 'exact match confidence 1.0');

  await loadFixture([fUnapproved, fLoc, fFam, fDefault]);
  sel = frames.selectFrame(selIntent, {});
  assert(sel.match === 'location' && sel.frame.id === 'f-loc',
    'unapproved exact skipped; same-location next');

  await loadFixture([fFam, fDefault]);
  sel = frames.selectFrame(selIntent, {});
  assert(sel.match === 'expression-family' && sel.frame.id === 'f-fam',
    'expression-family reuse ranks third');

  await loadFixture([fFamLow, fDefault]);
  sel = frames.selectFrame(selIntent, {});
  assert(sel.match === 'operator-default' && sel.frame.id === 'f-default',
    'below-floor (0.375) family frame skipped → operator default');

  await loadFixture([]);
  sel = frames.selectFrame(selIntent, {});
  assert(sel.match === 'generic' && sel.frame && sel.frame.source === 'fallback',
    'empty registry → generic portrait fallback');
  assert(sel.frame.assets.imageUrl.indexOf('/api/hyrax/assets/') === 0,
    'generic fallback served from /api/hyrax/assets/');

  // No-op on unchanged signature (§4 step 1).
  await loadFixture([fExact]);
  frames.noteApplied('tai', fExact, sigExact);
  sel = frames.selectFrame(selIntent, {});
  assert(sel.noOp === true && sel.match === 'exact', 'same signature as current → no-op');
  frames._reset('tai');

  // 4. Essence state assembly + confidence (spec §1, §2)
  console.log('\n── Essence state ──');
  essenceFixtures.mai = {
    mood: { primary: 'calm', valence: 0.4, arousal: 0.3 },
    energy: 0.8,
    social: { warmth: 0.6 },
    provenance: { 'mood.primary': 'read' },
    updatedAt: new Date().toISOString(),
  };
  let st = await essenceState.refresh('mai');
  assert(st.mood.primary === 'calm', 'mood.primary assembled from payload');
  assert(st.provenance['mood.primary'] === 'read', 'provenance preserved');
  // confidence = weighted min(read 0.9, derived 0.7, derived 0.7) = 0.7
  assert(Math.abs(st.mood.confidence - 0.7) < 1e-9,
    'mood.confidence = weighted minimum of inputs (0.7), got ' + st.mood.confidence);
  assert(st.condition.energy === 0.8, 'condition.energy read');
  assert(st.social.warmth === 0.6, 'social.warmth read');
  assert(['morning', 'day', 'evening', 'night'].indexOf(st.presentation.timeOfDay) !== -1,
    'deterministic time-of-day band present');

  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
  essenceFixtures.rei = {
    mood: { primary: 'neutral', valence: 0.1 },
    provenance: { 'mood.primary': 'read' },
    updatedAt: tenDaysAgo,
  };
  st = await essenceState.refresh('rei');
  assert(st.stalenessDays > 9, 'staleness computed from updatedAt');
  assert(st.stale === true, 'state marked stale > 3 days');
  // read weight floors at 0.4 beyond 7 days → min(0.4, derived 0.7) = 0.4
  assert(Math.abs(st.mood.confidence - 0.4) < 1e-9,
    'read confidence scaled by staleness to 0.4 floor, got ' + st.mood.confidence);

  essenceFixtures.nei = 'error';
  st = await essenceState.refresh('nei');
  assert(st.degraded === true && st.mood.primary === 'neutral',
    'endpoint failure fails closed to static defaults');
  assert(st.provenance['mood.primary'] === 'unknown',
    'degraded state provenance is unknown');

  // Activity from vnEvents.
  st = essenceState.handleEvent({ operatorId: 'tai', kind: 'tool.started', payload: { tool: 'bash' } });
  assert(st.activity.type === 'tool-working' && st.activity.description === 'bash',
    'tool.started → tool-working');
  st = essenceState.handleEvent({ operatorId: 'tai', kind: 'approval.requested', payload: {} });
  assert(st.activity.type === 'waiting-approval', 'approval.requested → waiting-approval');
  st = essenceState.handleEvent({ operatorId: 'tai', kind: 'response.completed', payload: {} });
  assert(st.activity.type === 'conversing', 'done → conversing (pre-decay)');

  // 5. Intents (spec §5)
  console.log('\n── Intents ──');
  intents.dispose();
  intents.configure({ debounceMs: 10, cooldownMs: 60 });
  const got = [];
  intents.subscribe(function (i) { got.push(i); });
  intents.init({ operatorId: 'tai' });
  assert(got.length === 1 && got[0].continuityToken, 'scene entry on init emits with continuityToken');
  await sleep(80); // lapse cooldown, drain any trailing emission

  // Prime a known baseline state.
  intents.evaluate(mkState({ expression: 'neutral', confidence: 0.7 }), {});
  let base = got.length;

  // Duplicate intent dropped.
  intents.evaluate(mkState({ expression: 'neutral', confidence: 0.7 }), {});
  assert(got.length === base, 'duplicate intent dropped');

  // Invalid triggers: tokens / reasoning / progress never emit.
  intents.handleEvent({ operatorId: 'tai', kind: 'response.token', payload: { token: 'x' } });
  intents.handleEvent({ operatorId: 'tai', kind: 'reasoning.delta', payload: {} });
  intents.handleEvent({ operatorId: 'tai', kind: 'tool.progress', payload: { pct: 40 } });
  await sleep(40);
  assert(got.length === base, 'token/reasoning/progress events are invalid triggers');

  // Low-confidence mood fluctuation is an invalid trigger (same activity,
  // same everything — only the expression family moved).
  intents.evaluate(mkState({ expression: 'smile', confidence: 0.3 }), {});
  assert(got.length === base, 'low-confidence (<0.5) mood fluctuation suppressed');
  intents.evaluate(mkState({ expression: 'smile', confidence: 0.7 }), {});
  await sleep(90); // may be held by cooldown; trailing emission counts
  assert(got.length === base + 1 && got[got.length - 1].expressionIntent === 'smile',
    'confident expression-family change emits (smile)');

  // Cooldown: a valid trigger inside the window is held, then trails.
  await sleep(80); // let cooldown lapse
  let before = got.length;
  intents.evaluate(mkState({ expression: 'neutral', confidence: 0.7 }), {}); // change → emits now
  assert(got.length === before + 1, 'post-cooldown intent emits immediately');
  intents.evaluate(mkState({ expression: 'focused', activityType: 'tool-working', confidence: 0.7 }), {});
  assert(got.length === before + 1, 'valid trigger during cooldown is held');
  await sleep(90);
  assert(got.length === before + 2 &&
    got[got.length - 1].expressionIntent === 'focused',
    'trailing intent emitted after cooldown');

  // Explicit user request bypasses cooldown.
  before = got.length;
  intents.requestBeat('observe');
  assert(got.length === before + 1, 'explicit user request bypasses cooldown');

  // Reset bypass.
  before = got.length;
  intents.reset();
  assert(got.length === before + 1, 'reset bypasses cooldown (scene entry)');

  // Beats: failure (small, confidence-scaled), approval, completion.
  await sleep(80);
  essenceState.handleEvent({ operatorId: 'tai', kind: 'response.completed', payload: {} });
  before = got.length;
  intents.handleEvent({ operatorId: 'tai', kind: 'tool.failed', payload: { tool: 'bash' } });
  await sleep(120);
  assert(got.length > before, 'tool.failed produces a beat');
  const failBeat = got[got.length - 1];
  assert(failBeat.trigger === 'failure', 'failure beat tagged');
  assert(failBeat.expressionIntent === 'sarcastic',
    'tai failure beat → sarcastic (playful-deflect, not sad), got ' + failBeat.expressionIntent);
  assert(failBeat.intensity <= 0.35,
    'failure beat intensity small + confidence-scaled, got ' + failBeat.intensity);

  await sleep(80);
  before = got.length;
  intents.handleEvent({ operatorId: 'tai', kind: 'approval.requested', payload: { tool: 'bash' } });
  await sleep(120);
  const apprBeat = got[got.length - 1];
  assert(got.length > before && apprBeat.trigger === 'approval', 'approval wait beat emitted');
  assert(apprBeat.gazeIntent === 'user', 'approval beat gazes at user');

  // Debounce coalescing: two rapid activity changes → one trailing eval.
  await sleep(100);
  before = got.length;
  intents.handleEvent({ operatorId: 'tai', kind: 'tool.started', payload: { tool: 'read' } });
  intents.handleEvent({ operatorId: 'tai', kind: 'tool.started', payload: { tool: 'write' } });
  await sleep(60);
  assert(got.length - before <= 2, 'debounce coalesces rapid events (got ' + (got.length - before) + ')');

  // Expression enum normalization (§6).
  const norm = intents.normalizeExpression('rei', 'happy-emote');
  assert(norm.expression === 'neutral' && norm.issue, 'unknown sister expression → neutral + issue');
  assert(intents.normalizeExpression('rei', 'alert').expression === 'alert',
    'valid sister expression passes through');
  intents.dispose();

  // 6. Room manifests: validation + world-state (INTERACTABLES_SPEC §6)
  console.log('\n── Room manifests ──');
  const roomIds = ['ops', 'security', 'lab', 'logistics'];
  const manifests = {};
  roomIds.forEach(function (id) {
    const raw = fs.readFileSync(path.join(STATIC, 'vn', 'rooms', id + '.json'), 'utf-8');
    const m = JSON.parse(raw);
    manifests[id] = m;
    const v = roomsApi.validate(m);
    assert(v.ok, 'manifest ' + id + ' validates (' + v.errors.join('; ') + ')');
    assert(m.backgroundFrameIds.length >= 1 &&
      m.backgroundFrameIds[0].indexOf(m.operatorId + '.background.') === 0,
      id + ' backgroundFrameIds use known asset ids');
    assert(m.visibleObjectIds.length >= 3 && m.visibleObjectIds.length <= 5,
      id + ' has 3-5 visible objects');
    roomsApi.register(m);
  });
  assert(roomsApi.list().length === 4, '4 rooms registered');

  const bad = roomsApi.validate({ roomId: 'BAD!!', operatorId: 'x', interactables: 'no' });
  assert(!bad.ok && bad.errors.length >= 3, 'invalid manifest rejected with schema errors');
  const badVerb = roomsApi.validate({
    roomId: 'ops', operatorId: 'tai', displayName: 'x',
    backgroundFrameIds: [], visibleObjectIds: [],
    interactables: ['room.desk.destroy'],
  });
  assert(!badVerb.ok, 'unknown room verb rejected');

  let loadRes = await roomsApi.load('ops', {
    fetchJson: function () { return Promise.reject(new Error('network down')); },
  });
  assert(loadRes.ok === false, 'manifest load fails closed on fetch error');
  loadRes = await roomsApi.load('../etc', {});
  assert(loadRes.ok === false, 'manifest load rejects bad roomId');
  loadRes = await roomsApi.load('ops', {
    fetchJson: function () { return Promise.resolve(manifests.ops); },
  });
  assert(loadRes.ok === true, 'manifest load + register via injected transport');

  // Generated room actions exist and run world-state effects.
  assert(!!actions.get('room.lamp.use'), 'room.lamp.use registered from manifest');
  assert(!!actions.get('room.main-console.inspect'), 'room inspect action registered');
  assert(!!actions.get('room.kanban-wall.ask'), 'room ask action registered');

  const roomCtx = {
    operatorId: 'tai', roomManifest: roomsApi.get('ops'),
    sendText: function (t) { sentTexts.push(t); return Promise.resolve({ ok: true }); },
  };
  assert(manifests.ops.ambientState.lamp === 'on', 'lamp starts on');
  let actRes = await actions.run('room.lamp.use', roomCtx);
  assert(actRes.ok === true && manifests.ops.ambientState.lamp === 'off',
    'world-state use toggles lamp off');
  assert(manifests.ops.ambientState.lighting === 'dim', 'lamp toggle drives lighting field');
  await actions.run('room.lamp.use', roomCtx);
  assert(manifests.ops.ambientState.lamp === 'on' &&
    manifests.ops.ambientState.lighting === 'warm', 'lamp toggles back on → warm lighting');
  await actions.run('room.main-console.inspect', roomCtx);
  assert(manifests.ops.ambientState.focus === 'main-console', 'inspect focuses object in ambientState');
  sentTexts.length = 0;
  await actions.run('room.main-console.ask', roomCtx);
  assert(sentTexts[0] === 'Tell me about main console.', 'room ask sends Hermes intent message');

  // 7. Action registry behavior (INTERACTABLES_SPEC §2, §4, §5)
  console.log('\n── Action registry ──');
  // All spec §3 static ids present.
  ['op.talk', 'op.ask-feeling', 'op.ask-doing', 'op.offer-help', 'op.observe',
    'op.invite-elsewhere', 'op.fresh-conversation',
    'work.current-task', 'work.open-issue', 'work.artifacts', 'work.approvals',
    'work.delegate',
    'sys.standard-chat', 'sys.tool-details', 'sys.workspace', 'sys.session-switch',
    'sys.model-info', 'sys.profile-settings'].forEach(function (id) {
    assert(!!actions.get(id), 'registry has ' + id);
  });

  // Unregistered-id guard + one-time log.
  const warnsBefore = warnLog.filter(function (w) { return w.indexOf('unregistered') !== -1; }).length;
  let un = await actions.run('room.ghost.inspect', {});
  assert(un.ok === false && un.reason === 'unregistered', 'unregistered id guarded');
  await actions.run('room.ghost.inspect', {});
  const warnsAfter = warnLog.filter(function (w) { return w.indexOf('unregistered') !== -1; }).length;
  assert(warnsAfter - warnsBefore === 1, 'unregistered id logged exactly once');

  // Duplicate-execution lock.
  const gate = deferred();
  const p1 = actions.run('op.ask-feeling', { sendText: function () { return gate.promise; } });
  const p2 = await actions.run('op.ask-feeling', { sendText: function () { return Promise.resolve(); } });
  assert(p2.ok === false && p2.reason === 'in-flight', 'duplicate execution locked while in-flight');
  gate.resolve({ ok: true });
  const r1 = await p1;
  assert(r1.ok === true, 'first execution completes');
  const r3 = await actions.run('op.ask-feeling', { sendText: function () { return Promise.resolve(); } });
  assert(r3.ok === true, 'lock released after completion');

  // Hermes-intent effect.
  sentTexts.length = 0;
  await actions.run('op.ask-doing', { sendText: function (t) { sentTexts.push(t); return Promise.resolve(); } });
  assert(sentTexts[0] === 'What are you working on?', 'hermes-intent calls ctx.sendText');

  // Read-only tool effect (kanban).
  apiCalls.length = 0;
  await actions.run('work.current-task', { operatorId: 'tai', tasks: [{ id: 'task-1' }] });
  assert(apiCalls.some(function (c) {
    return c.url.indexOf('/api/kanban/tasks') === 0 &&
      (!c.opts || !c.opts.method || c.opts.method === 'GET');
  }), 'work.current-task is a read-only kanban GET');

  // Navigation effect.
  loadedSessions.length = 0;
  await actions.run('sys.standard-chat', { sessionId: 'sess-9' });
  assert(loadedSessions[0] === 'sess-9', 'sys.standard-chat navigates via loadSession');

  // Failing run never throws; reports ok:false.
  const failRes = await actions.run('op.ask-doing', {
    sendText: function () { return Promise.reject(new Error('stream down')); },
  });
  assert(failRes.ok === false && failRes.reason === 'error', 'run failure surfaces as ok:false');

  // 8. Sidebar (INTERACTABLES_SPEC §3, §4, §7)
  console.log('\n── Sidebar ──');
  const sbContainer = makeEl('div');
  const sbCtx = {
    operatorId: 'tai', sessionId: 'sess-1', busy: false, approvalPending: false,
    activity: { type: 'idle' }, roomManifest: roomsApi.get('ops'),
    tasks: [{ id: 'task-1' }],
    sendText: function (t) { sentTexts.push(t); return Promise.resolve({ ok: true }); },
  };
  sidebar.init(sbContainer, sbCtx);
  const sbRoot = sbContainer._children[0];
  assert(sbRoot && sbRoot.className.split(' ').indexOf('gestalt-vn-sidebar') !== -1,
    'sidebar root carries CSS class hook (mobile bottom-sheet is CSS-driven)');

  const sectionIds = byClass(sbRoot, 'gestalt-vn-sidebar-section').map(function (s) {
    return s._attrs['data-section'];
  });
  ['operator', 'room', 'work', 'system'].forEach(function (id) {
    assert(sectionIds.indexOf(id) !== -1, 'section present: ' + id);
  });

  // Availability from fixtures: offer-help hidden when idle.
  assert(!byActionId(sbRoot, 'op.offer-help'), 'op.offer-help hidden while idle');
  sidebar.update({ activity: { type: 'tool-working' } });
  assert(!!byActionId(sbRoot, 'op.offer-help'), 'op.offer-help visible while tool-working');

  // Busy disables with reason tooltip + aria.
  sidebar.update({ busy: true });
  const feelingBtn = byActionId(sbRoot, 'op.ask-feeling');
  assert(feelingBtn && feelingBtn.disabled === true, 'busy disables op.ask-feeling');
  assert(feelingBtn.getAttribute('aria-disabled') === 'true' &&
    (feelingBtn.getAttribute('title') || '').indexOf('busy') !== -1,
    'disabled reason exposed via title + aria');
  sidebar.update({ busy: false });

  // Approval-gated visibility.
  assert(!byActionId(sbRoot, 'work.approvals'), 'work.approvals hidden without pending approval');
  sidebar.update({ approvalPending: true });
  assert(!!byActionId(sbRoot, 'work.approvals'), 'work.approvals visible when approval pending');
  sidebar.update({ approvalPending: false });

  // ≤5 visible + More… overflow (system section has 6 entries).
  function visibleActionButtons(sectionId) {
    const sec = byClass(sbRoot, 'gestalt-vn-sidebar-section').filter(function (s) {
      return s._attrs['data-section'] === sectionId;
    })[0];
    return sec ? byClass(sec, 'gestalt-vn-action') : [];
  }
  assert(visibleActionButtons('system').length === 5, 'system section caps at 5 visible');
  const sysSection = byClass(sbRoot, 'gestalt-vn-sidebar-section').filter(function (s) {
    return s._attrs['data-section'] === 'system';
  })[0];
  const moreBtn = byClass(sysSection, 'gestalt-vn-sidebar-more')[0];
  assert(!!moreBtn, 'More… overflow present');
  moreBtn._fire('click');
  assert(visibleActionButtons('system').length === 6, 'More… expands overflow');

  // Event-driven re-evaluation (no timers): inject a fake bus event.
  sidebar.update({ busy: false, activity: { type: 'idle' } });
  assert(!byActionId(sbRoot, 'op.offer-help'), 'offer-help hidden again after idle update');

  // Confirmation dialog for confirmation.required actions.
  apiCalls.length = 0;
  const freshBtn = byActionId(sbRoot, 'op.fresh-conversation');
  assert(!!freshBtn, 'op.fresh-conversation rendered');
  freshBtn._fire('click');
  const dialog = byClass(sbRoot, 'gestalt-vn-confirm')[0];
  assert(!!dialog, 'confirmation dialog shown for confirmation.required action');
  assert(apiCalls.every(function (c) { return c.url !== '/api/hyrax/vn/conversations'; }),
    'action not executed before confirm');
  byClass(dialog, 'gestalt-vn-confirm-ok')[0]._fire('click');
  await sleep(10);
  assert(apiCalls.some(function (c) {
    return c.url === '/api/hyrax/vn/conversations' && c.opts && c.opts.method === 'POST';
  }), 'confirmed action executes (POST new VN session)');
  assert(loadedSessions.indexOf('vn_new_1') !== -1, 'fresh session loaded after creation');

  sidebar.dispose();

  // 9. Stage + providers (ESSENCE_RUNTIME_SPEC §4, §9)
  console.log('\n── Stage ──');
  const stageContainer = makeEl('div');
  frames._reset('tai');
  registryError = true; // registry fetch fails → fallback ladder
  essenceFixtures.tai = undefined;
  stage.init(stageContainer, { operatorId: 'tai' });
  const stageRoot = stageContainer._children[0];
  assert(!!stageRoot, 'stage mounts root');
  assert(byClass(stageRoot, 'gestalt-vn-stage-bg').length === 1, 'background layer present');
  assert(byClass(stageRoot, 'gestalt-vn-stage-frame').length === 2, 'double-buffered frame layers');
  assert(byClass(stageRoot, 'gestalt-vn-stage-overlay').length === 1, 'overlay layer present');
  assert(byClass(stageRoot, 'gestalt-vn-stage-placeholder')[0].hidden === false,
    'loading placeholder visible before first frame');
  const bgImg = byClass(stageRoot, 'gestalt-vn-stage-bg')[0];
  assert(bgImg.src === '/api/hyrax/assets/tai.background.control-room',
    'background from known asset ids');
  assert(stage.getState().providerIds.join(',').indexOf('static-essence-frames') !== -1 &&
    stage.getState().providerIds.join(',').indexOf('fallback-portrait') !== -1,
    'both v1 providers instantiated');

  let applied = await stage.applyIntent({ operatorId: 'tai', expressionIntent: 'smile' });
  assert(applied.applied === true && applied.frame.source === 'fallback',
    'registry failure → fallback portrait applied');
  assert(applied.frame.assets.imageUrl === '/api/hyrax/assets/tai.portrait.smile',
    'fallback portrait expression-matched from known asset ids');
  assert(applied.transition === 'crossfade', 'crossfade transition at 300ms default');
  assert(byClass(stageRoot, 'gestalt-vn-stage-placeholder')[0].hidden === true,
    'placeholder hidden after first frame');
  const frameShown = byClass(stageRoot, 'gestalt-vn-stage-frame').filter(function (img) {
    return (img.alt || '').indexOf('Tai') === 0;
  })[0];
  assert(!!frameShown && frameShown.alt.indexOf('smile') !== -1,
    'alt text derived from frame state');

  // Stale indicator: essence state staleness > 3 days.
  const staleContainer = makeEl('div');
  essenceFixtures.rei = {
    mood: { primary: 'neutral', valence: -0.3, arousal: 0.4 },
    provenance: { 'mood.primary': 'read' },
    updatedAt: tenDaysAgo,
  };
  stage.init(staleContainer, { operatorId: 'rei' });
  await sleep(20);
  const staleRoot = staleContainer._children[0];
  const badge = byClass(staleRoot, 'gestalt-vn-stage-stale-badge')[0];
  assert(badge.hidden === false && badge.textContent.indexOf('stale') !== -1,
    'stale-image indicator when staleness > 3 days');
  const overlay = byClass(staleRoot, 'gestalt-vn-stage-overlay')[0];
  assert(overlay.className.indexOf('vignette-cold') !== -1,
    'mood-tinted vignette follows valence (negative → cold)');

  // Text-first mode toggle (class only).
  stage.setTextFirst(true);
  assert(staleRoot.classList.contains('text-first'), 'text-first toggle adds class');
  stage.setTextFirst(false);
  assert(!staleRoot.classList.contains('text-first'), 'text-first toggle removes class');

  // Registry-backed frame through StaticEssenceFrameProvider.
  // Fixture must be in place BEFORE init, so the init-time load caches it.
  const exactContainer = makeEl('div');
  const stageIntentCoarse = {
    operatorId: 'tai', location: 'ops', expression: 'focused',
    pose: 'working', framing: 'medium',
    timeOfDay: essenceState.get('tai').presentation.timeOfDay,
  };
  registryError = false;
  registryFixture = {
    frames: [mkFrame('stage-fx',
      frames.computeSceneSignature(stageIntentCoarse),
      { location: 'ops', expression: 'focused', pose: 'working' })],
  };
  frames._reset('tai');
  stage.init(exactContainer, { operatorId: 'tai' });
  await sleep(20);
  applied = await stage.applyIntent({
    operatorId: 'tai', expressionIntent: 'focused', poseIntent: 'working',
    location: 'ops', framing: 'medium',
  });
  assert(applied.applied === true && applied.frame.id === 'stage-fx',
    'registry exact frame applied by static provider');
  assert(applied.transition === 'crossfade', 'crossfade for registry frame');
  assert(stage.getState().currentFrame.id === 'stage-fx', 'current frame tracked');

  // Reduced motion → instant cut.
  const rmContainer = makeEl('div');
  frames._reset('tai');
  stage.init(rmContainer, { operatorId: 'tai', reducedMotion: true });
  applied = await stage.applyIntent({
    operatorId: 'tai', expressionIntent: 'focused', poseIntent: 'working',
    location: 'ops', framing: 'medium',
  });
  assert(applied.applied === true && applied.transition === 'cut',
    'reducedMotion → instant cut, no crossfade');
  stage.dispose();

  // ── Results ────────────────────────────────────────────────────────────
  console.log('\n═══ Results: ' + passed + ' passed, ' + failed + ' failed ═══\n');
  if (failures.length > 0) {
    console.error('FAILURES:');
    failures.forEach(function (f) { console.error('  ✗ ' + f); });
    process.exit(1);
  }
  process.exit(0);
}

main().catch(function (err) {
  console.error('UNEXPECTED ERROR:', err);
  process.exit(1);
});
