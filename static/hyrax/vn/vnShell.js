/**
 * Gestalt VN revamp (vn2) — vnShell.js
 *
 * Assembly + the external contract. Owns the layout regions (PRODUCT_SPEC
 * §2) and the mount/unmount lifecycle; the experience layer (Track C) will
 * populate stage/sidebar — the shell works with them ABSENT: static
 * portrait + background in the stage, disabled-reason sidebar placeholder.
 *
 * Classic script, IIFE. Registers onto window.GestaltVN.shell and exposes
 * the legacy-compatible globals:
 *   window.__vnMount(props)   props: {sisterId, sisterName, role?, source?}
 *   window.__vnUnmount()
 *   window.__vnReopen()
 * plus the `hyrax:open-conversation` document listener (same call semantics
 * as legacy vn.js — hq.js keeps working unchanged).
 *
 * Lifecycle: single _mounted guard + one teardown path (ARCH §5) — every
 * module dispose is called, every listener removed, the sidebar restored.
 * All core-DOM reaching is centralized in _coreDom() with guards.
 */
(function() {
  'use strict';

  var root = typeof window !== 'undefined' ? window : globalThis;
  var ns = root.GestaltVN = root.GestaltVN || {};

  // Static fallback backgrounds (Track C replaces the stage contents; the
  // portrait always comes from <op>.portrait.neutral). Missing entries or
  // broken images degrade to no background — fail closed, never 404-spam.
  var FALLBACK_BACKGROUNDS = {
    tai: 'tai.background.control-room',
    rei: 'rei.background.security',
    nei: 'nei.background.lab',
    mai: 'mai.background.supply-hub',
  };

  // ── State ──
  var _mounted = false;
  var _raceToken = 0;
  var _props = null;
  var _content = null;      // mount host (#mainHq)
  var _rootEl = null;
  var _regions = null;
  var _keyHandler = null;
  var _sessionUnsub = null;
  var _eventUnsubs = [];
  var _sidebarCollapsedByUs = false;

  // ── Centralized, guarded core-DOM access (ARCH §7, audit debt #5) ──

  function _coreDom(fn) {
    try { return fn(document); } catch (_) { return undefined; }
  }

  function _collapseSidebar() {
    _sidebarCollapsedByUs = false;
    _coreDom(function(doc) {
      var layout = doc.querySelector('.layout');
      if (!layout) return;
      var wide = true;
      try {
        wide = typeof root.matchMedia !== 'function' || root.matchMedia('(min-width: 641px)').matches;
      } catch (_) { wide = true; }
      if (wide && !layout.classList.contains('sidebar-collapsed')) {
        layout.classList.add('sidebar-collapsed');
        _sidebarCollapsedByUs = true;
      }
    });
  }

  function _restoreSidebar() {
    if (!_sidebarCollapsedByUs) return;
    _coreDom(function(doc) {
      var layout = doc.querySelector('.layout');
      if (layout) layout.classList.remove('sidebar-collapsed');
    });
    _sidebarCollapsedByUs = false;
  }

  // ── Small helpers ──

  function _el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = String(text);
    return e;
  }

  function _toast(msg) {
    if (typeof root.showToast === 'function') {
      try { root.showToast(msg); return; } catch (_) {}
    }
    // Fallback toast in the hyrax style when showToast is unavailable.
    _coreDom(function(doc) {
      var t = _el('div', 'hyrax-toast', String(msg));
      t.setAttribute('role', 'status');
      doc.body.appendChild(t);
      setTimeout(function() { try { t.remove(); } catch (_) {} }, 5000);
    });
  }

  function _api(url, opts) {
    if (typeof root.api === 'function') return root.api(url, opts);
    return fetch(url, opts).then(function(r) { return r.json(); });
  }

  function _prefKey(operatorId) {
    return 'gestalt.vn.ui.' + operatorId;
  }

  function _readPrefs(operatorId) {
    try {
      var raw = root.localStorage && root.localStorage.getItem(_prefKey(operatorId));
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (_) { return {}; }
  }

  function _writePrefs(operatorId, patch) {
    try {
      var prefs = _readPrefs(operatorId);
      for (var k in patch) prefs[k] = patch[k];
      root.localStorage.setItem(_prefKey(operatorId), JSON.stringify(prefs));
    } catch (_) {}
  }

  // style.setProperty is not guaranteed (test fakes expose plain style
  // objects) — fall back to direct assignment harmlessly.
  function _setStyleVar(el, name, value) {
    try {
      if (el && el.style && typeof el.style.setProperty === 'function') {
        el.style.setProperty(name, value);
      } else if (el && el.style) {
        el.style[name] = value;
      }
    } catch (_) {}
  }

  // ── Top bar / state API (consumed by the experience layer later) ──

  function setTopBar(opts) {
    if (!_regions) return;
    opts = opts || {};
    if (typeof opts.name === 'string' && _regions.nameEl) {
      _regions.nameEl.textContent = opts.name;
    }
    if (typeof opts.mood === 'string' && _regions.moodEl) {
      _regions.moodEl.textContent = opts.mood;
      _regions.moodEl.setAttribute('title', 'Mood: ' + opts.mood);
    }
    if (typeof opts.state === 'string') {
      _setStateChip(opts.state);
    }
  }

  function setState(opts) {
    if (!_regions) return;
    opts = opts || {};
    if (typeof opts.busy === 'boolean') {
      _setStateChip(opts.busy ? 'busy' : 'idle');
    }
  }

  function _setStateChip(state) {
    var chip = _regions && _regions.stateEl;
    if (!chip) return;
    chip.textContent = state;
    chip.setAttribute('data-state', state);
  }

  // ── Layout construction (PRODUCT_SPEC §2.1 desktop grid) ──

  function _buildLayout(operatorId, name, prefs) {
    var rootEl = _el('div', 'vn2');
    if (prefs && prefs.textFirst) rootEl.classList.add('vn2--text-first');

    // ── Top bar ──
    var topBar = _el('header', 'vn2-topbar');
    var backBtn = _el('button', 'vn2-btn vn2-back', '← HQ');
    backBtn.setAttribute('type', 'button');
    backBtn.addEventListener('click', _backToHq);
    var nameEl = _el('span', 'vn2-name', name);
    var moodEl = _el('span', 'vn2-mood', 'neutral');
    moodEl.setAttribute('title', 'Mood: neutral');
    var stateEl = _el('span', 'vn2-state-chip', 'connecting');
    stateEl.setAttribute('data-state', 'connecting');
    stateEl.setAttribute('role', 'status');
    var techBtn = _el('button', 'vn2-btn vn2-tech-toggle', '⚙ tech');
    techBtn.setAttribute('type', 'button');
    var chatBtn = _el('button', 'vn2-btn vn2-chat-toggle', '💬 standard chat');
    chatBtn.setAttribute('type', 'button');
    chatBtn.addEventListener('click', function() {
      var s = ns.session;
      if (s && typeof s.openInStandardChat === 'function') s.openInStandardChat();
    });
    topBar.appendChild(backBtn);
    topBar.appendChild(nameEl);
    topBar.appendChild(moodEl);
    topBar.appendChild(stateEl);
    topBar.appendChild(techBtn);
    topBar.appendChild(chatBtn);

    // ── Main row: stage+dialogue column, sidebar ──
    var main = _el('div', 'vn2-main');
    var center = _el('div', 'vn2-center');

    // Stage — static fallback until the experience layer populates it.
    var stage = _el('section', 'vn2-stage');
    var bgId = FALLBACK_BACKGROUNDS[operatorId];
    if (bgId) {
      var bg = _el('img', 'vn2-stage-bg');
      bg.setAttribute('src', '/api/hyrax/assets/' + bgId);
      bg.setAttribute('alt', '');
      bg.setAttribute('aria-hidden', 'true');
      bg.addEventListener('error', function() {
        try { bg.remove(); } catch (_) {}
      });
      stage.appendChild(bg);
    }
    var portrait = _el('img', 'vn2-portrait');
    portrait.setAttribute('src', '/api/hyrax/assets/' + operatorId + '.portrait.neutral');
    portrait.setAttribute('alt', name + ', neutral');
    portrait.addEventListener('error', function() {
      // Fail closed: broken portrait → text-first presentation.
      try { portrait.hidden = true; } catch (_) {}
      rootEl.classList.add('vn2--text-first');
    });
    stage.appendChild(portrait);

    // 3D Loft — only Tai has a 3D space (legacy contract); launches the
    // loft on demand via hq.js. Top-right stage overlay, same spot as legacy.
    if (operatorId === 'tai') {
      var loftBtn = _el('button', 'vn2-btn vn2-stage-loft', '3D Loft →');
      loftBtn.setAttribute('type', 'button');
      loftBtn.setAttribute('aria-label', 'Enter the 3D loft');
      loftBtn.addEventListener('click', function() {
        if (typeof root.__hqLaunch3d === 'function') {
          root.__hqLaunch3d();
        }
      });
      stage.appendChild(loftBtn);
    }

    // Dialogue region (transcript + approvals + composer).
    var dialogueRegion = _el('section', 'vn2-dialogue');
    var transcriptEl = _el('div', 'vn2-transcript-region');
    var approvalsEl = _el('div', 'vn2-approvals-region');
    var composerEl = _el('div', 'vn2-composer-region');
    dialogueRegion.appendChild(transcriptEl);
    dialogueRegion.appendChild(approvalsEl);
    dialogueRegion.appendChild(composerEl);

    // Draggable splitter between stage and chat (PRODUCT: the chat must not
    // eat the scene). prefs.split is the STAGE fraction of the center column
    // (0.3–0.85 → dialogue 70%–15%); the default keeps the dialogue at
    // roughly a third of the desktop viewport instead of half. Persisted per
    // operator via prefs.split, SHARED across viewport classes (one drag
    // preference per operator; the untouched default differs by class —
    // 0.66 desktop, 0.38 mobile bottom-sheet).
    var mobileLayout = false;
    try {
      mobileLayout = !!(root.matchMedia && root.matchMedia('(max-width: 719px)').matches);
    } catch (_) {}
    var defaultSplit = mobileLayout ? 0.38 : 0.66;
    var split = prefs && typeof prefs.split === 'number' ? prefs.split : defaultSplit;
    if (split < 0.3 || split > 0.85) split = defaultSplit;
    _setStyleVar(center, '--vn2-stage-h', (split * 100).toFixed(1) + '%');
    var splitter = _el('div', 'vn2-splitter');
    splitter.setAttribute('role', 'separator');
    splitter.setAttribute('aria-orientation', 'horizontal');
    splitter.setAttribute('aria-label', 'Resize chat and scene areas');
    splitter.setAttribute('tabindex', '0');
    var _syncSplitterAria = function() {
      // Value = dialogue (chat) share of the center column, in percent.
      splitter.setAttribute('aria-valuenow', String(Math.round((1 - split) * 100)));
    };
    splitter.setAttribute('aria-valuemin', '15');
    splitter.setAttribute('aria-valuemax', '70');
    _syncSplitterAria();
    var collapseBtn = _el('button', 'vn2-splitter-toggle',
      prefs && prefs.chatCollapsed ? '▲' : '▼');
    collapseBtn.setAttribute('type', 'button');
    collapseBtn.setAttribute('aria-label', 'Collapse or expand chat area');
    collapseBtn.setAttribute('title', 'Collapse / expand chat');
    if (prefs && prefs.chatCollapsed) rootEl.classList.add('vn2--chat-collapsed');
    collapseBtn.addEventListener('click', function() {
      var collapsed = rootEl.classList.toggle('vn2--chat-collapsed');
      collapseBtn.textContent = collapsed ? '▲' : '▼';
      _writePrefs(operatorId, { chatCollapsed: collapsed });
    });
    splitter.appendChild(collapseBtn);

    var dragging = false;
    splitter.addEventListener('pointerdown', function(e) {
      if (e.target === collapseBtn) return;
      dragging = true;
      try { splitter.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    splitter.addEventListener('pointermove', function(e) {
      if (!dragging) return;
      var rect = center.getBoundingClientRect();
      if (!rect.height) return;
      var ratio = (e.clientY - rect.top) / rect.height;
      if (ratio < 0.3) ratio = 0.3;
      if (ratio > 0.85) ratio = 0.85;
      _setStyleVar(center, '--vn2-stage-h', (ratio * 100).toFixed(1) + '%');
      split = ratio;
      _syncSplitterAria();
    });
    var endDrag = function() {
      if (!dragging) return;
      dragging = false;
      _writePrefs(operatorId, { split: split });
    };
    splitter.addEventListener('pointerup', endDrag);
    splitter.addEventListener('pointercancel', endDrag);
    // Keyboard resize (separator role): arrows step the split by 2%.
    splitter.addEventListener('keydown', function(e) {
      if (!e || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      if (e.preventDefault) e.preventDefault();
      var delta = e.key === 'ArrowUp' ? 0.02 : -0.02;
      var next = split + delta;
      if (next < 0.3) next = 0.3;
      if (next > 0.85) next = 0.85;
      split = next;
      _setStyleVar(center, '--vn2-stage-h', (split * 100).toFixed(1) + '%');
      _syncSplitterAria();
      _writePrefs(operatorId, { split: split });
    });

    center.appendChild(stage);
    center.appendChild(splitter);
    center.appendChild(dialogueRegion);

    // Sidebar — placeholder until the experience layer registers actions.
    var sidebar = _el('aside', 'vn2-sidebar');
    var sbTitle = _el('div', 'vn2-sidebar-title', 'Actions');
    // Mobile: actions collapse to a toggle so they don't dominate the
    // viewport (default collapsed ≤719px; desktop always expanded).
    var actionsToggle = _el('button', 'vn2-actions-toggle', '▾');
    actionsToggle.setAttribute('type', 'button');
    actionsToggle.setAttribute('aria-label', 'Show or hide actions');
    var mobileActions = false;
    try {
      mobileActions = !!(root.matchMedia && root.matchMedia('(max-width: 719px)').matches);
    } catch (_) {}
    if (mobileActions) {
      sidebar.classList.add('vn2-sidebar--collapsed');
      actionsToggle.textContent = '▸';
    }
    actionsToggle.addEventListener('click', function() {
      var collapsed = sidebar.classList.toggle('vn2-sidebar--collapsed');
      actionsToggle.textContent = collapsed ? '▸' : '▾';
    });
    sbTitle.appendChild(actionsToggle);
    var sbPlaceholder = _el('div', 'vn2-sidebar-placeholder',
      'Interactables are provided by the experience layer, which is not active yet.');
    sidebar.appendChild(sbTitle);
    sidebar.appendChild(sbPlaceholder);
    sidebar.initExperience = function() {
      // Experience layer took over — drop the placeholder note.
      try { sbPlaceholder.remove(); } catch (_) {}
      sidebar.initExperience = function() {};
    };

    main.appendChild(center);
    main.appendChild(sidebar);

    // Tech drawer — slide-over.
    var drawer = _el('aside', 'vn2-drawer-region');

    rootEl.appendChild(topBar);
    rootEl.appendChild(main);
    rootEl.appendChild(drawer);

    _regions = {
      root: rootEl,
      topBar: topBar,
      nameEl: nameEl,
      moodEl: moodEl,
      stateEl: stateEl,
      techBtn: techBtn,
      chatBtn: chatBtn,
      stage: stage,
      portrait: portrait,
      dialogue: transcriptEl,
      approvals: approvalsEl,
      composer: composerEl,
      sidebar: sidebar,
      drawer: drawer,
    };
    return rootEl;
  }

  // ── Back to HQ (mirrors legacy _showHqView) ──

  function _backToHq() {
    var content = _content;
    unmount();
    if (!content) return;
    try { content.dataset.vnActive = ''; } catch (_) {}
    if (typeof root.__hqShow2d === 'function') {
      try { root.__hqShow2d(content); return; } catch (_) {}
    }
    _coreDom(function() {
      try { content.innerHTML = ''; } catch (_) {}
      if (typeof root.__hqMount === 'function') root.__hqMount('hq');
    });
  }

  // ── Mount ──

  async function mount(props) {
    if (!props || typeof props.sisterId !== 'string' || !props.sisterId) return;
    var operatorId = props.sisterId;
    var name = typeof props.sisterName === 'string' && props.sisterName ? props.sisterName : operatorId;

    _raceToken = (_raceToken + 1) % 1000000;
    var token = _raceToken;
    _teardown();
    _mounted = true;
    _props = { sisterId: operatorId, sisterName: name, role: props.role, source: props.source };

    var content = _coreDom(function(doc) { return doc.getElementById('mainHq'); });
    if (!content) { _mounted = false; return; }
    _content = content;

    _collapseSidebar();

    try { content.innerHTML = ''; } catch (_) {}
    var loading = _el('div', 'vn2-loading', 'Connecting to ' + name + '…');
    loading.setAttribute('role', 'status');
    loading.setAttribute('aria-live', 'polite');
    content.appendChild(loading);

    // Profile availability check (best-effort, mirrors legacy).
    try {
      var profileData = await _api('/api/hyrax/vn/profiles', { method: 'GET' });
      if (_raceToken !== token || !_mounted) return;
      var items = (profileData && profileData.items) || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i] && items[i].id === operatorId && items[i].available === false) {
          _toast(name + ' is not available.');
          try { content.innerHTML = ''; } catch (_) {}
          content.appendChild(_el('div', 'vn2-error', name + ' is not available.'));
          return;
        }
      }
    } catch (_) {
      if (_raceToken !== token || !_mounted) return;
      // Continue without the profile check — select-or-create is authoritative.
    }

    // Session continuity (ARCH §4).
    var ref;
    try {
      ref = await ns.session.open({ operatorId: operatorId, source: props.source });
    } catch (_) {
      ref = null;
    }
    if (_raceToken !== token || !_mounted) return;
    if (!ref) {
      _toast('Conversation could not be created.');
      try { content.innerHTML = ''; } catch (_) {}
      var errEl = _el('div', 'vn2-error', 'Failed to start conversation.');
      errEl.setAttribute('role', 'alert');
      content.appendChild(errEl);
      return;
    }

    // Archived elsewhere → explicit state + one-click fresh (SPEC §5).
    if (ref.archived) {
      try { content.innerHTML = ''; } catch (_) {}
      var archivedBox = _el('div', 'vn2-error');
      archivedBox.setAttribute('role', 'alert');
      archivedBox.appendChild(_el('p', null, 'This conversation was archived.'));
      var freshBtn = _el('button', 'vn2-btn', 'Start a fresh conversation');
      freshBtn.setAttribute('type', 'button');
      freshBtn.addEventListener('click', function() {
        ns.session.fresh().then(function(freshRef) {
          if (!freshRef) return;
          if (_raceToken !== token || !_mounted) return;
          mount(_props);
        });
      });
      archivedBox.appendChild(freshBtn);
      content.appendChild(archivedBox);
      return;
    }

    // Build the layout.
    var prefs = _readPrefs(operatorId);
    var rootEl = _buildLayout(operatorId, name, prefs);
    try { content.innerHTML = ''; } catch (_) {}
    content.appendChild(rootEl);
    _rootEl = rootEl;

    var expr = ref.expression || {};
    setTopBar({ name: name, mood: expr.current || 'neutral' });
    setState({ busy: !!ref.busy });

    // Wire the modules. Dialogue renders the authoritative history first
    // (legacy pattern), then the single SSE subscriber connects. Each module
    // init is isolated: a failure in one must not abort the mount and leave
    // the other regions dead (the drawer, composer, and approvals stay
    // usable with explicit empty states).
    try { ns.dialogue.init({ container: _regions.dialogue, operatorName: name }); } catch (_) {}
    try { ns.composer.init({ container: _regions.composer }); } catch (_) {}
    try { ns.approvals.init({ container: _regions.approvals, sessionId: ref.sessionId }); } catch (_) {}
    try { ns.techDrawer.init({ container: _regions.drawer, toggleButton: _regions.techBtn }); } catch (_) {}

    var connected = false;
    try {
      connected = ns.events.init({ sessionId: ref.sessionId, operatorId: operatorId });
    } catch (_) { connected = false; }
    if (!connected) {
      _setStateChip('disconnected');
      _toast('Live updates unavailable — transcript still works.');
    } else {
      if (!ref.busy) _setStateChip('idle');
      _eventUnsubs.push(ns.events.subscribe('reconnect', function() {
        _setStateChip('reconnecting');
        ns.session.refresh().then(function() {
          if (_raceToken !== token || !_mounted) return;
          ns.dialogue.resync();
        }).catch(function() {});
      }));
    }

    // Session change → top bar mood/busy (reconnect resync, done-refresh).
    _sessionUnsub = ns.session.on(function(updated) {
      if (!updated || _raceToken !== token || !_mounted) return;
      var e2 = updated.expression || {};
      setTopBar({ mood: e2.current || 'neutral' });
      if (_regions && _regions.stateEl &&
          _regions.stateEl.getAttribute('data-state') !== 'disconnected') {
        setState({ busy: !!updated.busy });
      }
    });

    // Experience layer (essence + stage + sidebar) — optional, fail-closed.
    _wireExperience(operatorId, name, ref);

    // Escape → HQ (legacy parity).
    _keyHandler = function(event) {
      if (event && event.key === 'Escape') {
        if (event.preventDefault) event.preventDefault();
        _backToHq();
      }
    };
    _coreDom(function(doc) { doc.addEventListener('keydown', _keyHandler); });
  }

  // ── Experience-layer glue (essence state/intents, stage, sidebar) ──
  // Every piece is optional and fail-closed: the shell stays fully usable
  // with static imagery and the placeholder sidebar if any module is absent
  // or errors during init (ARCH §7).

  var OPERATOR_ROOM = { tai: 'ops', rei: 'security', nei: 'lab', mai: 'logistics' };

  function _wireExperience(operatorId, name, ref) {
    var vn = ns.vn || {};
    var essence = ns.essence || {};

    // Current staged room. Scene intents from essenced (Phase B) arrive as
    // intent.location through the essence state → intents pipeline; the
    // background layer is owned by room manifests (same machinery as
    // enterRoom), so a room CHANGE swaps the background here. Fail closed:
    // an unknown/unloadable room keeps the current background — never blank.
    var _stageLocation = OPERATOR_ROOM[operatorId] || null;
    function _syncSceneBackground(intent) {
      var roomId = intent && typeof intent.location === 'string' && intent.location
        ? intent.location : null;
      if (!roomId || roomId === _stageLocation) return;
      _stageLocation = roomId;
      if (!(vn.rooms && vn.stage && typeof vn.stage.setBackground === 'function')) return;
      var applyBg = function(manifest) {
        if (!manifest || typeof vn.rooms.backgroundUrl !== 'function') return;
        var url = vn.rooms.backgroundUrl(manifest);
        if (url) { try { vn.stage.setBackground(url); } catch (_) {} }
      };
      var manifest = typeof vn.rooms.get === 'function' ? vn.rooms.get(roomId) : null;
      if (manifest) { applyBg(manifest); return; }
      if (typeof vn.rooms.load === 'function') {
        vn.rooms.load(roomId).then(function(result) {
          if (!_mounted) return;
          applyBg(result && result.manifest ? result.manifest
            : (typeof vn.rooms.get === 'function' ? vn.rooms.get(roomId) : null));
        }).catch(function() {});
      }
    }

    // Presentation already fed by the HQ presence poll (Phase B: essenced's
    // derived poseIntent/sceneIntent) seeds the initial scene below — the
    // hardcoded standing/own-room intent must not stomp it.
    var _fedPresentation = null;
    try {
      var fedState = essence.state && typeof essence.state.get === 'function'
        ? essence.state.get(operatorId) : null;
      _fedPresentation = fedState && fedState.presentation ? fedState.presentation : null;
    } catch (_) { _fedPresentation = null; }

    // 1. Stage (Essence frames + providers).
    try {
      if (vn.stage && typeof vn.stage.init === 'function') {
        vn.stage.init(_regions.stage, { operatorId: operatorId });
        // The essence stage owns the scene from here — hide the shell's
        // static fallback portrait, or it bleeds through the sprite's
        // transparent margins (doubled figure behind the essence frame).
        if (_regions.portrait) _regions.portrait.hidden = true;
      }
    } catch (_) {}

    // 2. Essence state + intents → stage + top bar mood.
    try {
      if (essence.state && typeof essence.state.refresh === 'function') {
        essence.state.refresh(operatorId).catch(function() {});
      }
      if (essence.intents && typeof essence.intents.init === 'function') {
        essence.intents.init({ operatorId: operatorId });
      }
      if (essence.intents && typeof essence.intents.subscribe === 'function') {
        _eventUnsubs.push(essence.intents.subscribe(function(intent) {
          try {
            if (vn.stage && typeof vn.stage.applyIntent === 'function') {
              vn.stage.applyIntent(intent);
            }
            if (intent && intent.expressionIntent) {
              setTopBar({ mood: intent.expressionIntent });
            }
            _syncSceneBackground(intent);
          } catch (_) {}
        }));
      }
    } catch (_) {}

    // 3. Sidebar with full action context (INTERACTABLES_SPEC).
    try {
      // Initial scene: intents fire on *changes* — without an explicit
      // scene-entry intent the stage sits on its placeholder forever (QA:
      // empty frame, "loading scene…" stuck).
      if (vn.stage && typeof vn.stage.applyIntent === 'function') {
        var entryLocation = (_fedPresentation && _fedPresentation.location) ||
          OPERATOR_ROOM[operatorId];
        // Fed sceneIntent (≠ the operator's own room) swaps the background
        // at mount; _syncSceneBackground also advances _stageLocation.
        if (_fedPresentation && _fedPresentation.location) {
          _syncSceneBackground({ location: _fedPresentation.location });
        }
        vn.stage.applyIntent({
          operatorId: operatorId,
          location: entryLocation,
          poseIntent: (_fedPresentation && _fedPresentation.pose) || 'standing',
          trigger: 'scene-entry',
        });
      }
    } catch (_) {}
    try {
      if (vn.sidebar && typeof vn.sidebar.init === 'function') {
        var ctx = {
          operatorId: operatorId,
          sessionId: ref.sessionId,
          busy: !!ref.busy,
          surface: 'vn',
          sendText: function(text) {
            if (ns.composer && typeof ns.composer.send === 'function') {
              return ns.composer.send(text);
            }
          },
          focusComposer: function() {
            try {
              var ta = _regions.composer && _regions.composer.querySelector('textarea');
              if (ta && ta.focus) ta.focus();
            } catch (_) {}
          },
          // Client-action surface used by vnActions (INTERACTABLES_SPEC).
          openTechDrawer: function() {
            if (ns.techDrawer && typeof ns.techDrawer.toggle === 'function') {
              ns.techDrawer.toggle();
            }
          },
          showSessionPicker: function() {
            // Minimal honest implementation: the tech drawer owns session
            // details + links (standard chat / workspace) in v1.
            if (ns.techDrawer && typeof ns.techDrawer.open === 'function') {
              ns.techDrawer.open();
            }
          },
          showModelInfo: function() {
            if (ns.techDrawer && typeof ns.techDrawer.open === 'function') {
              ns.techDrawer.open();
            }
          },
          backToHq: function() {
            _backToHq();
          },
          enterRoom: function(roomId) {
            // Canonical path: manifest-driven location intent + background
            // swap (vn.rooms.applyScene). Bare location intent as fallback.
            _stageLocation = roomId || _stageLocation;
            var manifest = vn.rooms && typeof vn.rooms.get === 'function'
              ? vn.rooms.get(roomId) : null;
            if (manifest && typeof vn.rooms.applyScene === 'function') {
              vn.rooms.applyScene(manifest, {
                operatorId: operatorId, roomManifest: manifest,
              });
              return;
            }
            if (vn.stage && typeof vn.stage.applyIntent === 'function') {
              vn.stage.applyIntent({ operatorId: operatorId, location: roomId, trigger: 'navigation' });
            }
          },
        };
        if (typeof _regions.sidebar.initExperience === 'function') {
          _regions.sidebar.initExperience();
        }
        vn.sidebar.init(_regions.sidebar, ctx);
        // Room manifest → sidebar room section + stage location context.
        var roomId = OPERATOR_ROOM[operatorId];
        if (roomId && vn.rooms && typeof vn.rooms.load === 'function') {
          vn.rooms.load(roomId).then(function(result) {
            // load() resolves the validation envelope {ok, errors, manifest}
            // — the sidebar context needs the manifest itself (its roomId
            // gates the room object actions and the staged location).
            var manifest = result && result.manifest ? result.manifest : null;
            if (!manifest || !_mounted) return;
            try {
              if (vn.sidebar && typeof vn.sidebar.setRoom === 'function') {
                vn.sidebar.setRoom(manifest);
              }
              // Opening the VN from an HQ room click lands in the operator's
              // room: the manifest owns the stage background from here —
              // unless a fed sceneIntent (Phase B) already moved the stage
              // to another room, which owns the background instead.
              if (_stageLocation === roomId &&
                  vn.stage && typeof vn.stage.setBackground === 'function' &&
                  typeof vn.rooms.backgroundUrl === 'function') {
                vn.stage.setBackground(vn.rooms.backgroundUrl(manifest));
              }
            } catch (_) {}
          }).catch(function() {});
        }
      }
    } catch (_) {}
  }

  // ── Teardown ──

  function _teardown() {
    for (var i = 0; i < _eventUnsubs.length; i++) {
      try { _eventUnsubs[i](); } catch (_) {}
    }
    _eventUnsubs = [];
    if (_sessionUnsub) {
      try { _sessionUnsub(); } catch (_) {}
      _sessionUnsub = null;
    }
    if (_keyHandler) {
      _coreDom(function(doc) { doc.removeEventListener('keydown', _keyHandler); });
      _keyHandler = null;
    }
    // Module teardown order: consumers first, the SSE source last.
    var vn2 = ns.vn || {};
    var ess2 = ns.essence || {};
    if (vn2.sidebar) { try { vn2.sidebar.dispose(); } catch (_) {} }
    if (vn2.stage) { try { vn2.stage.dispose(); } catch (_) {} }
    if (ess2.intents && typeof ess2.intents.dispose === 'function') { try { ess2.intents.dispose(); } catch (_) {} }
    if (ns.techDrawer) { try { ns.techDrawer.dispose(); } catch (_) {} }
    if (ns.approvals) { try { ns.approvals.dispose(); } catch (_) {} }
    if (ns.composer) { try { ns.composer.dispose(); } catch (_) {} }
    if (ns.dialogue) { try { ns.dialogue.dispose(); } catch (_) {} }
    if (ns.events) { try { ns.events.dispose(); } catch (_) {} }
    if (_content && _rootEl) {
      try { _rootEl.remove(); } catch (_) {}
    }
    _rootEl = null;
    _regions = null;
    _restoreSidebar();
  }

  function unmount() {
    _raceToken = (_raceToken + 1) % 1000000;
    _teardown();
    _mounted = false;
    _props = null;
    _content = null;
  }

  function reopen() {
    if (!_mounted || !_props) return;
    mount(_props);
  }

  function isMounted() {
    return _mounted;
  }

  // ── Exports ──

  ns.shell = {
    mount: mount,
    unmount: unmount,
    reopen: reopen,
    isMounted: isMounted,
    setTopBar: setTopBar,
    setState: setState,
    regions: function() { return _regions; },
  };

  root.__vnMount = mount;
  root.__vnUnmount = unmount;
  root.__vnReopen = reopen;

  // HQ launches conversations through this event (same contract as legacy).
  _coreDom(function(doc) {
    doc.addEventListener('hyrax:open-conversation', function(e) {
      if (!e || !e.detail || !e.detail.sisterId) return;
      mount(e.detail);
    });
  });
})();
