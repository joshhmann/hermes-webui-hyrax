/**
 * Hyraxknot Division — HQ Panel Controller (ES module)
 *
 * Registers through bootstrap.js as the native `hq` extension panel
 * (window.HermesPanels). Renders the 2D isometric Division HQ map on mount,
 * refreshes presence on a 30s visibility-gated interval, and owns the
 * on-demand Tai Loft launch (lazy 3D bundle import, exact-once cleanup).
 *
 * The VN surface is a sub-view of the HQ host: a chibi click mounts that
 * sister's VN inside #mainHq through the vn controller; "back to HQ" from the
 * VN re-renders the 2D map (no stale mount state).
 *
 * Legacy compat: the classic vnShell module still calls window.__hqLaunch3d /
 * __hqShow2d / __hqMount / __hqUnmount — those hooks are exposed below so the
 * working VN keeps functioning unchanged.
 *
 * No switchPanel wrapper, no registry mutation, no polling loops.
 */
'use strict';

import {
  mount as vnMount,
  unmount as vnUnmount,
  reopen as vnReopen,
  closeStream as vnCloseStream,
  isMounted as vnIsMounted,
} from './vn.js';

var _mounted = false;
var _modulePromise = null;     // cached import() promise for the 3D bundle
var _unmount3d = null;         // cleanup returned by the 3D bundle (exact-once)
var _mountGen = 0;             // epoch counter: invalidates stale async work
var _presenceTimer = null;     // 30s visibility-gated presence refresh

// 3D module path (generated local ES module).
var MODULE_URL = '/static/hyrax/3d/embodiment-bundle.js';

// Test seam: a harness may point the lazy 3D import at a fixture via
// window.__HYRAX_3D_URL. Production always uses MODULE_URL above.
function bundleUrl() {
  try {
    var root = typeof window !== 'undefined' ? window : globalThis;
    if (typeof root.__HYRAX_3D_URL === 'string' && root.__HYRAX_3D_URL) {
      return root.__HYRAX_3D_URL;
    }
  } catch (_) { /* fall through to production URL */ }
  return MODULE_URL;
}

// Presence refresh cadence (ms). Gated on HQ visibility + page visibility.
var PRESENCE_INTERVAL_MS = 30000;

// ── Rooms ──
// Declared with `var` — tests/test_hyrax_vocabulary.py regex-extracts these
// blocks as the vocabulary lockstep contract. Do not rename/restructure.
var HQ_ROOMS = [
  { id: 'security',  label: 'Security Alcove' },
  { id: 'common',    label: 'Common Area' },
  { id: 'coffee',    label: 'Coffee Station' },
  { id: 'corridor',  label: 'Main Corridor' },
  { id: 'director',  label: "Director's Office" },
  { id: 'ops',       label: 'Operations Hub' },
  { id: 'lab',       label: 'Research Lab' },
  { id: 'logistics', label: 'Logistics Annex' },
  { id: 'entrance',  label: 'Entrance' },
];

// ── Sisters ──
var HQ_SISTERS = [
  { id: 'tai', name: 'Tai',  room: 'Operations Hub',   role: 'implementation' },
  { id: 'rei', name: 'Rei',  room: 'Security Alcove',   role: 'verification'  },
  { id: 'nei', name: 'Nei',  room: 'Research Lab',      role: 'contracts'     },
  { id: 'mai', name: 'Mai',  room: 'Logistics Annex',   role: 'blocked triage' },
];

// Room label (HQ_SISTERS.room) → room id (HQ_ROOMS.id) lookup.
var ROOM_ID_BY_LABEL = {};
HQ_ROOMS.forEach(function(r) { ROOM_ID_BY_LABEL[r.label] = r.id; });

function ownRoomId(sister) {
  return ROOM_ID_BY_LABEL[sister.room] || 'common';
}

// ── Activity-driven placement ──
// Maps presence activity.type → room id. `null` means the sister's own
// room (derived from HQ_SISTERS.room via ROOM_ID_BY_LABEL).
var ACTIVITY_ROOM = {
  'conversing': 'common',
  'tool-working': null,
  'waiting-approval': 'director',
  'background-working': null,
  'resting': 'coffee',
  'idle': 'common',
  'offline': null,
};

// Pure placement helper — used by BOTH initial render and refresh.
function roomFor(sister, presence) {
  var own = ownRoomId(sister);
  if (!presence || presence.available === false) return own;
  var type = presence.activity && presence.activity.type;
  var mapped = ACTIVITY_ROOM[type];
  return mapped || own;
}

// Assign each sister a room + a slot index within that room so
// co-located sisters don't overlap (CSS offsets per data-slot).
function assignSlots(presenceMap) {
  var slots = {};
  var counts = {};
  HQ_SISTERS.forEach(function(s) {
    var room = roomFor(s, presenceMap[s.id] || null);
    var slot = counts[room] || 0;
    counts[room] = slot + 1;
    slots[s.id] = { room: room, slot: slot };
  });
  return slots;
}

// ── Mount (HermesPanels hook) ──
function mount(id) {
  var content = document.getElementById('mainHq');
  if (!content) return;

  // Already mounted — refresh presence data
  if (_mounted) {
    refreshPresence();
    return;
  }

  // Increment generation — any stale import/mount in-flight belongs
  // to an older generation and must not execute mount side effects.
  _mountGen++;
  _mounted = true;
  armPresenceTimer();

  // Always render the 2D isometric map first.
  // The 3D space is launched on demand from the VN conversation.
  render2dFallback(content);
}

// ── Unmount (HermesPanels hook) ──
function unmount(id) {
  _mountGen++; // invalidate any pending mount/launch work
  _mounted = false;
  if (_presenceTimer) {
    clearInterval(_presenceTimer);
    _presenceTimer = null;
  }
  dispose3d();
  // Closing the panel also closes an open VN stream (no run cancellation).
  vnUnmount();
}

// ── Visibility-gated presence refresh ──
// The interval is cheap; the gate keeps it from hammering the presence
// endpoint while the HQ panel (or the whole tab) is hidden.
function armPresenceTimer() {
  if (_presenceTimer) return;
  _presenceTimer = setInterval(function() {
    if (hqVisible()) refreshPresence();
  }, PRESENCE_INTERVAL_MS);
}

function hqVisible() {
  var main = document.querySelector('main');
  if (!main || !main.classList || !main.classList.contains('showing-hq')) return false;
  return document.visibilityState === 'visible';
}

// ── 2D fallback: isometric map with chibis ──
function render2dFallback(container) {
  var page = document.createElement('div');
  page.className = 'hq-page';

  // Header
  var head = document.createElement('div');
  head.className = 'page-head';
  head.innerHTML = '<p class="eyebrow">SPATIAL OVERVIEW</p>'
    + '<h1>Division Headquarters</h1>'
    + '<p class="muted">Click a chibi for the VN stage; use a sidebar card for standard chat.</p>';
  head.appendChild(createHomeToggle());
  page.appendChild(head);

  // War-room strip (kanban totals across sisters → native kanban panel)
  var warroom = document.createElement('button');
  warroom.type = 'button';
  warroom.className = 'hq-warroom';
  warroom.title = 'Open kanban board';
  warroom.setAttribute('aria-label', 'Open the kanban war room');
  warroom.addEventListener('click', function() {
    if (typeof switchPanel === 'function') switchPanel('war-room');
  });
  page.appendChild(warroom);

  // Map stage
  var stage = document.createElement('div');
  stage.className = 'map-stage';

  // Iso floor
  var floor = document.createElement('div');
  floor.className = 'iso-floor';
  floor.setAttribute('aria-label', 'Isometric Division HQ map');
  HQ_ROOMS.forEach(function(r) {
    var room = document.createElement('div');
    room.className = 'room room-' + r.id;
    room.textContent = r.label;
    floor.appendChild(room);
  });
  stage.appendChild(floor);
  applyTimeTint(floor);

  // Chibis — presence endpoint first (live activity/mood/approvals),
  // profiles endpoint as availability fallback.
  fetchPresence().then(function(presenceMap) {
    feedEssencePresentation(presenceMap);
    var slots = assignSlots(presenceMap);
    HQ_SISTERS.forEach(function(s) {
      stage.appendChild(createChibi(s, presenceMap[s.id] || null, slots[s.id]));
    });
    updateWarRoom(warroom, presenceMap);
    renderOperatorsPanel(presenceMap);
  }).catch(function() {
    var slots = assignSlots({});
    HQ_SISTERS.forEach(function(s) {
      stage.appendChild(createChibi(s, null, slots[s.id]));
    });
    updateWarRoom(warroom, {});
    renderOperatorsPanel({});
  });

  page.appendChild(stage);
  container.replaceChildren(page);
}

// ── Home preference toggle (HQ-first landing, see bootstrap.js) ──
function createHomeToggle() {
  var toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'hq-home-toggle';

  var read = function() {
    try {
      return window.localStorage ? window.localStorage.getItem('hyrax-home') : null;
    } catch (_) {
      return null;
    }
  };
  var sync = function() {
    toggle.textContent = read() === 'chat' ? 'Set HQ as home' : 'Set chat as home';
  };
  toggle.addEventListener('click', function() {
    try {
      if (window.localStorage) {
        window.localStorage.setItem('hyrax-home', read() === 'chat' ? 'hq' : 'chat');
      }
    } catch (_) {}
    sync();
  });
  sync();
  return toggle;
}

// ── War-room strip ──
// Sums kanban running/blocked counts across the sisters. Text, never
// color-only (ARCH a11y). Always rendered — zero counts read "all clear".
var CHIP_TITLE_MAX = 28;

function truncateTitle(title) {
  if (title.length <= CHIP_TITLE_MAX) return title;
  return title.slice(0, CHIP_TITLE_MAX).replace(/\s+$/, '') + '…';
}

function kanbanTotals(presenceMap) {
  var totals = { running: 0, blocked: 0, perSister: [] };
  HQ_SISTERS.forEach(function(s) {
    var p = presenceMap[s.id];
    var k = p && p.kanban;
    var run = k && typeof k.running === 'number' ? k.running : 0;
    var blk = k && typeof k.blocked === 'number' ? k.blocked : 0;
    totals.running += run;
    totals.blocked += blk;
    var task = p && p.currentTask;
    var taskTitle = task && typeof task.title === 'string' ? task.title.trim() : '';
    if (run > 0 || blk > 0 || taskTitle) {
      totals.perSister.push({
        name: s.name, running: run, blocked: blk, taskTitle: taskTitle,
      });
    }
  });
  return totals;
}

function updateWarRoom(strip, presenceMap) {
  if (!strip) return;
  var t = kanbanTotals(presenceMap || {});
  strip.replaceChildren();

  var summary = document.createElement('span');
  summary.className = 'hq-warroom-summary';
  summary.textContent = (t.running === 0 && t.blocked === 0)
    ? 'War room — all clear'
    : 'War room — ' + t.running + ' running · ' + t.blocked + ' blocked';
  strip.appendChild(summary);

  t.perSister.forEach(function(c) {
    var chip = document.createElement('span');
    chip.className = 'hq-warroom-chip';
    if (c.blocked > 0) chip.setAttribute('data-blocked', 'true');
    var counts = c.running + ' run · ' + c.blocked + ' blk';
    if (c.taskTitle) {
      chip.textContent = c.name + ' · ' + truncateTitle(c.taskTitle);
      chip.title = c.name + ' — ' + c.taskTitle + ' (' + counts + ')';
    } else {
      chip.textContent = c.name + ' ' + counts;
      chip.title = c.name + ' — ' + counts;
    }
    strip.appendChild(chip);
  });
}

// ── Time-of-day tint on the iso floor ──
var TIME_CLASSES = ['hq-time-dawn', 'hq-time-day', 'hq-time-dusk', 'hq-time-night'];

function applyTimeTint(floor) {
  floor = floor || document.querySelector('.iso-floor');
  if (!floor || !floor.classList) return;
  var h = new Date().getHours();
  var cls = (h >= 5 && h < 8) ? 'hq-time-dawn'
    : (h >= 8 && h < 17) ? 'hq-time-day'
    : (h >= 17 && h < 20) ? 'hq-time-dusk'
    : 'hq-time-night';
  for (var i = 0; i < TIME_CLASSES.length; i++) floor.classList.remove(TIME_CLASSES[i]);
  floor.classList.add(cls);
}

// ── Operators sidebar panel-view ──
// Card click opens STANDARD chat with the sister's session; chibi click
// on the map opens the VN. Both stay <button> for keyboard access.
var _lastPresence = {};        // last presence map (panel re-renders)
var _whimsPanelFor = null;     // operator id with an open whims panel
var _dismissPending = {};      // whim id -> true (veto filed, awaiting close)

function renderOperatorsPanel(presenceMap) {
  _lastPresence = presenceMap || {};
  var host = document.getElementById('hyraxHqOperators');
  if (!host) return;
  host.replaceChildren();
  HQ_SISTERS.forEach(function(s) {
    var presence = _lastPresence[s.id] || null;
    var wrap = document.createElement('div');
    wrap.className = 'hyrax-op-wrap';

    var card = document.createElement('button');
    card.className = 'hyrax-op-card hyrax-op-' + s.id;
    card.setAttribute('aria-label', 'Open chat with ' + s.name);
    card.title = 'Open chat with ' + s.name;

    var img = document.createElement('img');
    img.src = '/api/hyrax/assets/' + s.id + '.chibi.stand';
    img.alt = '';
    img.loading = 'lazy';

    var meta = document.createElement('div');
    meta.className = 'hyrax-op-meta';
    var nm = document.createElement('strong');
    nm.textContent = s.name;
    var act = document.createElement('span');
    var type = presence && presence.activity && presence.activity.type;
    var mood = presence && presence.expression && presence.expression.current;
    act.textContent = (ACTIVITY_LABELS[type] || 'idle') + (mood && mood !== 'neutral' ? ' · ' + mood : '');
    var hint = document.createElement('span');
    hint.className = 'hyrax-op-hint';
    hint.textContent = 'open chat';
    meta.appendChild(nm);
    meta.appendChild(act);
    meta.appendChild(hint);

    card.appendChild(img);
    card.appendChild(meta);

    if (presence && typeof presence.pendingApprovals === 'number' && presence.pendingApprovals > 0) {
      var dot = document.createElement('span');
      dot.className = 'chibi-approval-dot';
      dot.textContent = String(presence.pendingApprovals);
      dot.title = presence.pendingApprovals + ' approval(s) pending';
      card.appendChild(dot);
    }
    if (!presence || presence.available === false) {
      card.classList.add('staged');
      card.setAttribute('aria-disabled', 'true');
    }

    card.addEventListener('click', function() {
      openStandardChat(s, card);
    });
    wrap.appendChild(card);

    // Whims layer: active whims from essenced's derived state ride the
    // presence payload — one small chip button under the card opens the
    // whims panel (veto lives there, not on the chip).
    var derived = presence && presence.derivedState;
    var whims = derived && derived.whims;
    var hasWhims = Array.isArray(whims) && whims.length > 0;
    var fulfilledTotal = derived && typeof derived.whimFulfilledTotal === 'number'
      ? derived.whimFulfilledTotal : 0;
    var hasHistory = derived && ((Array.isArray(derived.whimHistory) && derived.whimHistory.length > 0)
      || fulfilledTotal > 0);
    if (hasWhims || hasHistory) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'hyrax-op-whim' + (hasWhims ? '' : ' hyrax-op-whim-quiet');
      chip.textContent = hasWhims
        ? 'wants to: ' + whims[0].text
        : 'whims · ' + fulfilledTotal + ' fulfilled';
      chip.title = hasWhims
        ? whims.map(function(w) { return 'wants to: ' + w.text; }).join('\n')
          + '\n— click for the whims panel'
        : 'No active whims — click for history';
      chip.setAttribute('aria-label', 'Open whims panel for ' + s.name);
      chip.setAttribute('aria-expanded', _whimsPanelFor === s.id ? 'true' : 'false');
      chip.addEventListener('click', function() {
        toggleWhimsPanel(s.id);
      });
      wrap.appendChild(chip);
    }

    if (_whimsPanelFor === s.id) {
      wrap.appendChild(buildWhimsPanel(s));
    }
    host.appendChild(wrap);
  });
}

// ── Whims panel (read-only + Josh's gentle veto) ──
function toggleWhimsPanel(operatorId) {
  _whimsPanelFor = (_whimsPanelFor === operatorId) ? null : operatorId;
  renderOperatorsPanel(_lastPresence);
}

function _fmtWhimTime(epochSeconds) {
  try {
    var d = new Date(epochSeconds * 1000);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit' });
  } catch (_) {
    return '';
  }
}

function _fmtWhimTs(iso) {
  if (typeof iso !== 'string' || !iso) return '';
  try {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit' });
  } catch (_) {
    return '';
  }
}

function buildWhimsPanel(sister) {
  var presence = _lastPresence[sister.id] || null;
  var derived = (presence && presence.derivedState) || {};
  var whims = Array.isArray(derived.whims) ? derived.whims : [];
  var history = Array.isArray(derived.whimHistory) ? derived.whimHistory : [];
  var total = typeof derived.whimFulfilledTotal === 'number'
    ? derived.whimFulfilledTotal : 0;

  // Clear pending-dismiss markers for whims no longer active.
  var activeIds = {};
  whims.forEach(function(w) { if (w && w.id) activeIds[w.id] = true; });
  Object.keys(_dismissPending).forEach(function(id) {
    if (!activeIds[id]) delete _dismissPending[id];
  });

  var panel = document.createElement('section');
  panel.className = 'hyrax-whims-panel';
  panel.setAttribute('aria-label', sister.name + ' whims');

  var head = document.createElement('div');
  head.className = 'hyrax-whims-head';
  var title = document.createElement('strong');
  title.textContent = sister.name + '’s whims';
  var close = document.createElement('button');
  close.type = 'button';
  close.className = 'hyrax-whims-close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close whims panel');
  close.addEventListener('click', function() { toggleWhimsPanel(sister.id); });
  head.appendChild(title);
  head.appendChild(close);
  panel.appendChild(head);

  var activeLabel = document.createElement('p');
  activeLabel.className = 'hyrax-whims-label';
  activeLabel.textContent = whims.length
    ? 'Active (' + whims.length + ')' : 'No active whims right now.';
  panel.appendChild(activeLabel);

  whims.forEach(function(w) {
    if (!w || !w.id) return;
    var row = document.createElement('div');
    row.className = 'hyrax-whim-row';
    var text = document.createElement('span');
    text.className = 'hyrax-whim-text';
    text.textContent = 'wants to: ' + (w.text || '');
    row.appendChild(text);

    var metaLine = document.createElement('span');
    metaLine.className = 'hyrax-whim-meta';
    var bits = [];
    if (w.source) bits.push('about ' + w.source);
    bits.push(w.firedAt ? 'fired ' + _fmtWhimTime(w.firedAt) : 'not fired yet');
    metaLine.textContent = bits.join(' · ');
    row.appendChild(metaLine);
    var dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'hyrax-whim-dismiss';
    if (_dismissPending[w.id]) {
      dismiss.textContent = 'dismiss filed…';
      dismiss.disabled = true;
      dismiss.title = 'Veto filed — she closes it on her next tick';
    } else {
      dismiss.textContent = 'dismiss';
      dismiss.title = 'Gently close this whim (she shrugs it off)';
      dismiss.addEventListener('click', function() {
        dismissWhim(sister, w, dismiss);
      });
    }
    row.appendChild(dismiss);
    panel.appendChild(row);
  });

  var totals = document.createElement('p');
  totals.className = 'hyrax-whims-label';
  totals.textContent = total + ' fulfilled all time';
  panel.appendChild(totals);

  if (history.length) {
    var histLabel = document.createElement('p');
    histLabel.className = 'hyrax-whims-label';
    histLabel.textContent = 'Recent';
    panel.appendChild(histLabel);
    var list = document.createElement('ul');
    list.className = 'hyrax-whims-history';
    history.forEach(function(h) {
      if (!h || !h.kind) return;
      var item = document.createElement('li');
      var what = h.kind === 'whim_fulfilled' ? 'fulfilled'
        : h.kind === 'whim_expired' ? 'expired'
        : h.kind === 'op_note_sent' ? 'note'
        : h.kind === 'op_note_received' ? 'note' : 'dismissed';
      // Op-notes lane: direction first — the sender sees "told mai",
      // the recipient "heard from tai" (OP_NOTES_SPEC.md).
      var subject = (h.direction ? h.direction : (h.text || h.whimId || ''));
      var parts = [what + ': ' + subject];
      if (h.about) parts.push(h.about);
      else if (h.direction && h.text) parts.push(h.text);
      if (h.moodlet) parts.push('moodlet ' + h.moodlet);
      var when = _fmtWhimTs(h.ts);
      if (when) parts.push(when);
      item.textContent = parts.join(' · ');
      list.appendChild(item);
    });
    panel.appendChild(list);
  }
  return panel;
}

// Josh's gentle veto: confirm, file the dismiss, refresh from presence.
function dismissWhim(sister, whim, button) {
  var msg = 'Dismiss this whim? She\'ll shrug it off.\n\nwants to: ' + (whim.text || '');
  try {
    if (typeof window.confirm === 'function' && !window.confirm(msg)) return;
  } catch (_) { /* no confirm available — proceed */ }
  button.disabled = true;
  button.textContent = 'dismissing…';
  var req;
  try {
    req = api('/api/hyrax/essence/whims/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operator: sister.id, whim_id: whim.id }),
    });
  } catch (_) {
    _whimDismissError(sister);
    return;
  }
  Promise.resolve(req).then(function(payload) {
    if (!payload || payload.recorded !== true) throw new Error('refused');
    _dismissPending[whim.id] = true;
    refreshPresence();
  }).catch(function() {
    _whimDismissError(sister);
  });
}

function _whimDismissError(sister) {
  // Re-render, then flag the failure inline (fail closed, never silent).
  renderOperatorsPanel(_lastPresence);
  var host = document.getElementById('hyraxHqOperators');
  if (!host) return;
  var panel = host.querySelector('.hyrax-whims-panel');
  if (!panel) return;
  var err = document.createElement('p');
  err.className = 'hyrax-whims-error';
  err.textContent = 'dismiss failed — try again';
  panel.appendChild(err);
}


// ── Operator card → standard chat ──
// Select-or-create the sister's VN session server-side, then hand the
// session id to the native chat surface. Card is disabled while the
// request is in flight to prevent double-clicks.
function openStandardChat(sister, card) {
  if (card.disabled) return;
  card.disabled = true;
  card.classList.add('hq-op-loading');

  var finish = function() {
    card.disabled = false;
    card.classList.remove('hq-op-loading');
  };
  var showError = function() {
    finish();
    var hint = card.querySelector('.hyrax-op-hint');
    if (hint) hint.textContent = 'chat unavailable — try again';
  };

  var req;
  try {
    req = api('/api/hyrax/vn/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile_id: sister.id, fresh: false }),
    });
  } catch (_) {
    showError();
    return;
  }
  Promise.resolve(req).then(function(payload) {
    var conv = (payload && payload.conversation) || payload || {};
    var sid = typeof conv.session_id === 'string' ? conv.session_id
      : (typeof conv.id === 'string' ? conv.id : '');
    if (!sid) throw new Error('no session id');
    if (typeof loadSession === 'function') loadSession(sid);
    if (typeof switchPanel === 'function') switchPanel('chat');
    finish();
  }).catch(function() {
    showError();
  });
}

// ── Chibi element factory ──
// Declared with `var` — vocabulary lockstep contract (see HQ_ROOMS).
var ACTIVITY_LABELS = {
  'idle': 'idle',
  'conversing': 'chatting',
  'tool-working': 'working',
  'waiting-approval': 'needs approval',
  'background-working': 'background',
  'resting': 'resting',
  'offline': 'offline',
};

var ACTIVITY_TYPES = [
  'idle', 'conversing', 'tool-working', 'waiting-approval',
  'background-working', 'resting', 'offline',
];

// Single source of truth for the chibi-active-<type> class — used by
// both initial render and refreshPresence.
function syncActivityClass(el, type) {
  for (var i = 0; i < ACTIVITY_TYPES.length; i++) {
    el.classList.remove('chibi-active-' + ACTIVITY_TYPES[i]);
  }
  if (type && type !== 'idle') el.classList.add('chibi-active-' + type);
}

function createChibi(sister, presence, placement) {
  var chibi = document.createElement('button');
  chibi.className = 'chibi chibi-' + sister.id;
  chibi.setAttribute('aria-label', 'Open VN with ' + sister.name);
  chibi.title = 'Open VN with ' + sister.name;
  chibi.setAttribute('data-room', placement ? placement.room : ownRoomId(sister));
  chibi.setAttribute('data-slot', placement ? String(placement.slot) : '0');

  var img = document.createElement('img');
  img.src = '/api/hyrax/assets/' + sister.id + '.chibi.stand';
  img.alt = '';
  img.loading = 'lazy';

  var name = document.createElement('strong');
  name.textContent = sister.name;

  var role = document.createElement('span');
  role.className = 'chibi-role';
  role.textContent = sister.role;

  // Live presence line: activity + mood (never color-only, ARCH a11y).
  var activity = document.createElement('span');
  activity.className = 'chibi-activity';
  var type = presence && presence.activity && presence.activity.type;
  var mood = presence && presence.expression && presence.expression.current;
  activity.textContent = (ACTIVITY_LABELS[type] || 'idle') + (mood && mood !== 'neutral' ? ' · ' + mood : '');
  syncActivityClass(chibi, type);

  chibi.appendChild(img);
  chibi.appendChild(name);
  chibi.appendChild(role);
  chibi.appendChild(activity);

  // Pending-approval dot with count (truthful, not ambient color).
  var approvals = presence && typeof presence.pendingApprovals === 'number'
    ? presence.pendingApprovals : 0;
  if (approvals > 0) {
    var dot = document.createElement('span');
    dot.className = 'chibi-approval-dot';
    dot.textContent = String(approvals);
    dot.title = approvals + ' approval' + (approvals > 1 ? 's' : '') + ' pending';
    dot.setAttribute('aria-label', dot.title);
    chibi.appendChild(dot);
  }

  // Availability gating (presence endpoint carries `available`).
  if (!presence || presence.available === false) {
    chibi.classList.add('staged');
    chibi.setAttribute('aria-disabled', 'true');
  }

  // Click → open that sister's VN inside the HQ host (controller path).
  // Failure messaging is owned by the vn controller (tracked toast); the
  // resolved false only signals "not mounted" to callers.
  chibi.addEventListener('click', function onClick() {
    vnMount({ sisterId: sister.id, sisterName: sister.name, role: sister.role });
  });

  return chibi;
}

// ── Presence ──
// GET /api/hyrax/presence aggregates per-sister activity, expression,
// approvals, and kanban counts server-side (one request, no SSE fan-out).
function fetchPresence() {
  try {
    var data = api('/api/hyrax/presence');
    var toMap = function(items) {
      var map = {};
      (items || []).forEach(function(p) { if (p && p.operatorId) map[p.operatorId] = p; });
      return map;
    };
    if (data && typeof data.then === 'function') {
      return data.then(function(r) { return toMap(r && r.items); }).catch(function() { return {}; });
    }
    return Promise.resolve(toMap(data && data.items));
  } catch (_) {
    return Promise.resolve({});
  }
}

// ── Essence active runtime (Phase B) ──
// Presence items carry essenced's derived presentation intents in
// derivedState {poseIntent, sceneIntent}. Feed them into the VN essence
// state so the intent pipeline picks up pose/scene changes through THIS
// polling path — no new polling. Fresh derived state only; anything else
// leaves the current presentation untouched (fail closed).
function feedEssencePresentation(map) {
  try {
    var gv = window.GestaltVN || {};
    var essence = gv.essence || {};
    if (!essence.state || typeof essence.state.setPresentation !== 'function') return;
    Object.keys(map || {}).forEach(function(opId) {
      var item = map[opId];
      var ds = item && item.derivedState;
      if (!ds || ds.fresh !== true) return;
      var patch = {};
      if (typeof ds.poseIntent === 'string' && ds.poseIntent) patch.pose = ds.poseIntent;
      if (typeof ds.sceneIntent === 'string' && ds.sceneIntent) patch.location = ds.sceneIntent;
      if (Object.keys(patch).length) {
        try { essence.state.setPresentation(opId, patch); } catch (_) {}
      }
    });
  } catch (_) {}
}

function refreshPresence() {
  fetchPresence().then(function(map) {
    feedEssencePresentation(map);
    renderOperatorsPanel(map);
    updateWarRoom(document.querySelector('#mainHq .hq-warroom'), map);
    applyTimeTint();
    var slots = assignSlots(map);
    HQ_SISTERS.forEach(function(s) {
      var chibiEl = document.querySelector('.chibi-' + s.id);
      if (!chibiEl) return;
      var presence = map[s.id] || null;

      // Activity-driven placement (same pure helper as initial render).
      chibiEl.setAttribute('data-room', slots[s.id].room);
      chibiEl.setAttribute('data-slot', String(slots[s.id].slot));

      if (!presence || presence.available === false) {
        chibiEl.classList.add('staged');
        chibiEl.setAttribute('aria-disabled', 'true');
      } else {
        chibiEl.classList.remove('staged');
        chibiEl.removeAttribute('aria-disabled');
      }
      var type = presence && presence.activity && presence.activity.type;
      var mood = presence && presence.expression && presence.expression.current;
      syncActivityClass(chibiEl, type);
      var activityEl = chibiEl.querySelector('.chibi-activity');
      if (activityEl) {
        activityEl.textContent = (ACTIVITY_LABELS[type] || 'idle') + (mood && mood !== 'neutral' ? ' · ' + mood : '');
      }
      var dot = chibiEl.querySelector('.chibi-approval-dot');
      var approvals = presence && typeof presence.pendingApprovals === 'number'
        ? presence.pendingApprovals : 0;
      if (dot && approvals === 0) dot.remove();
      else if (!dot && approvals > 0) {
        var d = document.createElement('span');
        d.className = 'chibi-approval-dot';
        d.textContent = String(approvals);
        d.title = approvals + ' approval' + (approvals > 1 ? 's' : '') + ' pending';
        d.setAttribute('aria-label', d.title);
        chibiEl.appendChild(d);
      } else if (dot) {
        dot.textContent = String(approvals);
      }
    });
  });
}

// ── 3D bundle CSS ──
// The Vite build emits the styles as a separate file next to the JS
// bundle; nothing else loads it, so without this the 3D shell renders
// unstyled and the canvas collapses.
var CSS_URL = '/static/hyrax/3d/embodiment-bundle.css';
var _cssInjected = false;

function inject3dCss() {
  if (_cssInjected) return;
  try {
    if (document.querySelector('link[href*="/static/hyrax/3d/embodiment-bundle.css"]')) {
      _cssInjected = true;
      return;
    }
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_URL;
    document.head.appendChild(link);
    _cssInjected = true;
  } catch (_) {}
}

// ── Exact-once 3D cleanup ──
// The bundle's cleanup may be reached from several exits (panel unmount,
// loft exit button, launch re-entry). Nulling before calling makes the
// disposal exactly-once regardless of how many paths fire.
function dispose3d() {
  if (typeof _unmount3d !== 'function') return;
  var fn = _unmount3d;
  _unmount3d = null;
  try { fn(); } catch (_) { /* isolated */ }
}

// Return to the SAME conversation after the loft exits (or fails); if the
// VN is not mounted, fall back to the 2D map.
function returnToConversation(content) {
  if (vnIsMounted()) {
    vnReopen();
    return;
  }
  render2dFallback(content);
}

// Accessible failure state with an explicit "← Return to VN" action.
function renderLoftFailure(content) {
  var box = document.createElement('div');
  box.className = 'vn2-error hyrax-loft-failure';
  box.setAttribute('role', 'alert');
  var p = document.createElement('p');
  p.textContent = 'The Synthesis Loft could not be started.';
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'vn2-btn';
  btn.textContent = '← Return to VN';
  btn.setAttribute('aria-label', 'Return to the VN conversation');
  btn.addEventListener('click', function() {
    returnToConversation(content);
  });
  box.appendChild(p);
  box.appendChild(btn);
  content.replaceChildren(box);
}

// ── Launch 3D Loft (called from the Tai VN conversation) ──
// Never loads the bundle at startup/HQ/non-Tai — only this explicit click.
// On click: closes the VN EventSource (conversation preserved), shows an
// accessible loading state, lazily imports the production bundle, mounts
// with production defaults, and guarantees exact-once cleanup. Exit and
// failure both return to the SAME conversation. No uncaught rejection.
async function launch3d() {
  var content = document.getElementById('mainHq');
  if (!content) return;

  // Close the VN's SSE connection — the run keeps going server-side and
  // reopen() reconnects with replay (after_event_id) so nothing is lost.
  vnCloseStream();

  // Tear down an already-mounted 3D space before re-mounting (exact-once).
  dispose3d();

  var gen = ++_mountGen;

  // Accessible loading state.
  var loading = document.createElement('div');
  loading.className = 'hyrax-loft-loading';
  loading.setAttribute('role', 'status');
  loading.textContent = 'Loading the Synthesis Loft…';
  content.replaceChildren(loading);

  var returnToVn = function() {
    dispose3d();
    returnToConversation(content);
  };

  try {
    // The module import is cached; the mount runs on EVERY click.
    if (!_modulePromise) _modulePromise = import(bundleUrl());
    var mod = await _modulePromise;
    if (gen !== _mountGen) return; // panel switched while loading

    if (mod && typeof mod.mountTaiLoft === 'function') {
      inject3dCss();
      // Production defaults: the VRM asset is the embodiment bundle's own
      // default configuration — only the allowlisted asset URL is supplied.
      var cleanup = await mod.mountTaiLoft(
        content,
        returnToVn,
        { vrmUrl: '/api/hyrax/assets/tai.embodiment.vrm' }
      );
      if (gen !== _mountGen) {
        // Unmounted while the scene was initializing — dispose at once.
        if (typeof cleanup === 'function') {
          try { cleanup(); } catch (_) {}
        }
        return;
      }
      if (typeof cleanup !== 'function') {
        throw new Error('mountTaiLoft did not return a cleanup function');
      }
      _unmount3d = cleanup;
      return;
    }
    throw new Error('embodiment bundle has no mountTaiLoft export');
  } catch (_) {
    // Import or mount failed — clear the cached promise so the next
    // click retries instead of reusing a rejected promise forever.
    _modulePromise = null;
  }
  if (gen !== _mountGen) return;
  renderLoftFailure(content);
}

// Force full 2D re-render (used by the VN "back to HQ" path which clears
// the host first). No stale `dataset.rendered` — the module-level _mounted
// flag is the only mount guard, and this explicitly resets it.
function show2d(container) {
  _mounted = false;
  mount('hq');
}

// ── Exports + legacy window hooks ──
// The classic vnShell module calls window.__hqLaunch3d / __hqShow2d /
// __hqMount / __hqUnmount — keep those hooks alive so the working VN keeps
// functioning unchanged. The panel system uses the ES exports.
var root = typeof window !== 'undefined' ? window : globalThis;
root.__hqMount = mount;
root.__hqUnmount = unmount;
root.__hqLaunch3d = launch3d;
root.__hqShow2d = show2d;

export { mount, unmount, launch3d, show2d };
