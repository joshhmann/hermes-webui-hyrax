/**
 * Hyraxknot Division — HQ Panel
 *
 * Lazy-loads the 3D embodiment module on first mount. Falls back to a
 * 2D isometric map if the module fails to load (CSP/WebGL unavailable).
 *
 * Mount/unmount lifecycle driven by bootstrap.js via window.__hqMount
 * and window.__hqUnmount, which are registered as HermesPanels hooks.
 *
 * Living HQ: chibi placement is activity-driven (data-room attribute),
 * presence refreshes on a 30s visibility-gated interval, and a war-room
 * strip summarizes kanban state across the sisters.
 *
 * No switchPanel wrapper, no direct panel-list mutation.
 */
(function() {
  'use strict';

  var _mounted = false;
  var _modulePromise = null;     // cached import() promise for the 3D bundle
  var _unmount3d = null;         // cleanup function returned by 3D module
  var _mountGen = 0;             // epoch counter: increments on each mount
  var _presenceTimer = null;     // 30s visibility-gated presence refresh

  // 3D module path (generated local ES module).
  var MODULE_URL = '/static/hyrax/3d/embodiment-bundle.js';

  // Presence refresh cadence (ms). Gated on HQ visibility + page visibility.
  var PRESENCE_INTERVAL_MS = 30000;

  // ── Rooms ──
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

  // ── Mount (called by HermesPanels mount hook) ──
  function __hqMount(id) {
    var content = document.getElementById('mainHq');
    if (!content) return;

    // Already mounted — refresh presence data
    if (_mounted) {
      refreshPresence();
      return;
    }

    // Increment generation — any stale import/mount in-flight belongs
    // to an older generation and must not execute mount side effects.
    var gen = ++_mountGen;
    _mounted = true;
    armPresenceTimer();

    // Always render the 2D isometric map first.
    // The 3D space is launched on demand from the VN conversation.
    render2dFallback(content);
  }

  // ── Unmount (called by HermesPanels unmount hook) ──
  function __hqUnmount(id) {
    if (!_mounted) return;
    _mountGen++; // increment generation — invalidate any pending mount work
    _mounted = false;
    if (_presenceTimer) {
      clearInterval(_presenceTimer);
      _presenceTimer = null;
    }
    if (typeof _unmount3d === 'function') {
      _unmount3d();
      _unmount3d = null;
    }
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
      if (typeof switchPanel === 'function') switchPanel('kanban');
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
  // When presence carries a sister's currentTask, her chip shows the task
  // title (truncated, full text in the tooltip) instead of bare counts —
  // the "no invisible work" rule made visible.
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
  function renderOperatorsPanel(presenceMap) {
    var host = document.getElementById('hyraxHqOperators');
    if (!host) return;
    host.replaceChildren();
    HQ_SISTERS.forEach(function(s) {
      var presence = presenceMap[s.id] || null;
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
      host.appendChild(card);
    });
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

    // Click → dispatch custom event that vn.js catches (VN stage)
    chibi.addEventListener('click', function onClick() {
      var event = new CustomEvent('hyrax:open-conversation', {
        detail: { sisterId: sister.id, sisterName: sister.name, role: sister.role },
        bubbles: true,
      });
      document.dispatchEvent(event);
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
  // state so the intent pipeline (essenceIntents → vnStage.applyIntent)
  // picks up pose/scene changes through THIS polling path — no new
  // polling. Fresh derived state only; anything else leaves the current
  // presentation untouched (fail closed).
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
  // unstyled and the canvas collapses (the "fills only the top quarter"
  // symptom).
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

  // ── Launch 3D Loft (called from VN conversation) ──
  // Overlay button injected into #mainHq while the 3D loft is mounted.
  // Opens the ARDY debug page (mirrored under static/) in a new tab.
  // #mainHq is position:relative while shown, and its innerHTML is reset on
  // every remount / 2D fallback / VN reopen, so the button never outlives
  // the loft it belongs to.
  var DEBUG_URL = '/static/hyrax/3d/debug/ardy.html';

  function inject3dDebugButton(content) {
    if (!content || content.querySelector('#hqDebug3dBtn')) return;
    var btn = document.createElement('button');
    btn.id = 'hqDebug3dBtn';
    btn.type = 'button';
    btn.textContent = 'Debug';
    btn.title = 'Open the ARDY debug view (capture player / retarget compare) in a new tab';
    btn.setAttribute('aria-label', btn.title);
    btn.style.cssText = 'position:absolute;top:10px;right:10px;z-index:30;' +
      'background:rgba(22,27,34,.85);color:#c9d1d9;border:1px solid #30363d;' +
      'border-radius:4px;padding:4px 10px;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;' +
      'cursor:pointer;';
    btn.addEventListener('mouseenter', function() { btn.style.background = '#30363d'; });
    btn.addEventListener('mouseleave', function() { btn.style.background = 'rgba(22,27,34,.85)'; });
    btn.addEventListener('click', function() {
      window.open(DEBUG_URL, '_blank', 'noopener');
    });
    content.appendChild(btn);
  }

  // ── Launch 3D Loft (called from VN conversation) ──
  async function launch3d() {
    var content = document.getElementById('mainHq');
    if (!content) return;

    // Tear down an already-mounted 3D space before re-mounting
    if (typeof _unmount3d === 'function') {
      try { _unmount3d(); } catch (_) {}
      _unmount3d = null;
    }

    content.innerHTML = '<p class="muted">Loading 3D Loft...</p>';
    var gen = _mountGen;

    try {
      // The module import is cached; the mount runs on EVERY click. (The
      // old one-shot flag made the loft reachable exactly once per page
      // load — later clicks fell through to the 2D map.)
      if (!_modulePromise) _modulePromise = import(MODULE_URL);
      var mod = await _modulePromise;
      if (gen !== _mountGen) return; // panel switched while loading

      if (mod && typeof mod.mountTaiLoft === 'function') {
        inject3dCss();
        var returnToVn = function() {
          if (typeof _unmount3d === 'function') _unmount3d();
          _unmount3d = null;
          // Return to current VN conversation, not the 2D map
          if (typeof window.__vnReopen === 'function') {
            window.__vnReopen();
          } else {
            render2dFallback(content);
          }
        };
        var cleanup = await mod.mountTaiLoft(
          content,
          returnToVn,
          { vrmUrl: '/api/hyrax/assets/tai.embodiment.vrm' }
        );
        if (gen !== _mountGen) {
          // Unmounted while the scene was initializing — dispose at once
          if (typeof cleanup === 'function') {
            try { cleanup(); } catch (_) {}
          }
          return;
        }
        _unmount3d = cleanup;
        inject3dDebugButton(content);
        return;
      }
    } catch (_) {
      // Import or mount failed — clear the cached promise so the next
      // click retries instead of reusing a rejected promise forever.
      _modulePromise = null;
    }
    if (gen !== _mountGen) return;
    // 3D failed — show 2D map
    render2dFallback(content);
  }

  // ── Expose for bootstrap ──
  window.__hqMount = __hqMount;
  window.__hqUnmount = __hqUnmount;
  window.__hqLaunch3d = launch3d;
  // Force full 2D re-render (used by VN "back to HQ" which clears content first)
  window.__hqShow2d = function(container) {
    _mounted = false;  // reset so __hqMount does a full render
    __hqMount('hq');
  };

})();
