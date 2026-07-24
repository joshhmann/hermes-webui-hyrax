/**
 * Hyraxknot Division — HQ Panel
 *
 * Lazy-loads the 3D embodiment module on first mount. Falls back to a
 * 2D isometric map if the module fails to load (CSP/WebGL unavailable).
 *
 * Mount/unmount lifecycle driven by bootstrap.js via window.__hqMount
 * and window.__hqUnmount, which are registered as HermesPanels hooks.
 *
 * No switchPanel wrapper, no direct panel-list mutation, no polling.
 */
(function() {
  'use strict';

  var _mounted = false;
  var _modulePromise = null;     // cached import() promise for the 3D bundle
  var _unmount3d = null;         // cleanup function returned by 3D module
  var _mountGen = 0;             // epoch counter: increments on each mount

  // 3D module path (generated local ES module).
  var MODULE_URL = '/static/hyrax/3d/embodiment-bundle.js';

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

    // Always render the 2D isometric map first.
    // The 3D space is launched on demand from the VN conversation.
    render2dFallback(content);
  }

  // ── Unmount (called by HermesPanels unmount hook) ──
  function __hqUnmount(id) {
    if (!_mounted) return;
    _mountGen++; // increment generation — invalidate any pending mount work
    _mounted = false;
    if (typeof _unmount3d === 'function') {
      _unmount3d();
      _unmount3d = null;
    }
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
      + '<p class="muted">Click a sister\'s chibi to open a conversation.</p>';
    page.appendChild(head);

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

    // Chibis
    fetchProfiles().then(function(profiles) {
      HQ_SISTERS.forEach(function(s) {
        stage.appendChild(createChibi(s, profiles));
      });
    }).catch(function() {
      HQ_SISTERS.forEach(function(s) {
        stage.appendChild(createChibi(s, []));
      });
    });

    page.appendChild(stage);
    container.replaceChildren(page);
  }

  // ── Chibi element factory ──
  function createChibi(sister, profiles) {
    var chibi = document.createElement('button');
    chibi.className = 'chibi chibi-' + sister.id;
    chibi.setAttribute('aria-label', 'Talk with ' + sister.name);

    var img = document.createElement('img');
    img.src = '/api/hyrax/assets/' + sister.id + '.chibi.stand';
    img.alt = '';
    img.loading = 'lazy';

    var name = document.createElement('strong');
    name.textContent = sister.name;

    var role = document.createElement('span');
    role.textContent = sister.role;

    chibi.appendChild(img);
    chibi.appendChild(name);
    chibi.appendChild(role);

    // Presence gating
    var profile = profiles.find(function(p) { return p.id === sister.id; });
    if (!profile || !profile.available) {
      chibi.classList.add('staged');
      chibi.setAttribute('aria-disabled', 'true');
    }

    // Click → dispatch custom event that vn.js catches
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
  function fetchProfiles() {
    try {
      var data = api('/api/hyrax/vn/profiles');
      if (data && typeof data.then === 'function') {
        return data.then(function(r) { return r?.items || []; }).catch(function() { return []; });
      }
      return Promise.resolve(data?.items || []);
    } catch (_) {
      return Promise.resolve([]);
    }
  }

  function refreshPresence() {
    fetchProfiles().then(function(profiles) {
      HQ_SISTERS.forEach(function(s) {
        var chibiEl = document.querySelector('.chibi-' + s.id);
        if (!chibiEl) return;
        var profile = profiles.find(function(p) { return p.id === s.id; });
        if (!profile || !profile.available) {
          chibiEl.classList.add('staged');
          chibiEl.setAttribute('aria-disabled', 'true');
        } else {
          chibiEl.classList.remove('staged');
          chibiEl.removeAttribute('aria-disabled');
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
