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
  var _imported = false;
  var _unmount3d = null;         // cleanup function returned by 3D module
  var _prevContent = null;       // snapshot of HQ content for unmount
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
    _prevContent = content.innerHTML;

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
    _prevContent = null;
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

  // ── Launch 3D Loft (called from VN conversation) ──
  async function launch3d() {
    var content = document.getElementById('mainHq');
    if (!content) return;
    content.innerHTML = '<p class="muted">Loading 3D Loft...</p>';

    if (!_imported) {
      _imported = true;
      try {
        var mod = await import(MODULE_URL);
        if (mod && typeof mod.mountTaiLoft === 'function') {
          var returnToVn = function() {
            if (typeof _unmount3d === 'function') _unmount3d();
            _unmount3d = null;
            render2dFallback(content);
          };
          var cleanup = await mod.mountTaiLoft(
            content,
            returnToVn,
            { vrmUrl: '/api/hyrax/assets/tai.embodiment.vrm' }
          );
          _unmount3d = cleanup;
          return;
        }
      } catch (_) {}
    }
    // 3D failed — show 2D map
    render2dFallback(content);
  }

  // ── Expose for bootstrap ──
  window.__hqMount = __hqMount;
  window.__hqUnmount = __hqUnmount;
  window.__hqLaunch3d = launch3d;

})();
