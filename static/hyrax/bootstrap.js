/**
 * Hyraxknot Division — Hermes WebUI Extension Bootstrap
 *
 * The ONE Hyrax integration script (index.html loads exactly this, deferred).
 *
 * Responsibilities:
 *   - wait for the native extension-panel API (window.HermesPanels /
 *     `hermes:panel-ready`) and register EXACTLY the working panels
 *     `projects` and `hq` through HermesPanels.register
 *   - lazy dynamic imports of the controller ES modules (./projects.js,
 *     ./hq.js — the VN controller ./vn.js is imported by hq.js on demand)
 *   - inject only the necessary nav buttons (listener-based, no inline
 *     handlers) and the HQ sidebar Operators view
 *   - load hyrax.css once (version-cache-busted from this script's own URL)
 *   - HQ-first landing when the URL carries no explicit intent
 *
 * Explicitly NOT done here: switchPanel wrapping/reassignment, registry
 * mutation (HermesPanels.register owns that), polling, observer workarounds,
 * duplicate bootstrap.
 */
(function() {
  'use strict';

  // Idempotence guard — one bootstrap per page load, even if init somehow
  // runs twice (e.g. hermes:panel-ready racing a direct HermesPanels check).
  if (window.__hyraxBootstrapped) return;
  window.__hyraxBootstrapped = true;

  // ── Panel definitions ──
  // Exactly the working panels: projects (native kanban aggregation) and HQ.
  // Retired 2026-08-04: approvals / warroom / dispatch / verify / promises
  // placeholder panels (dead DOM + nav removed; approvals data still reaches
  // the UI through presence pending-approval dots).
  var HYRAX_PANELS = [
    { id: 'projects', label: 'Projects', icon: 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z' },
    { id: 'hq', label: 'HQ', icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
  ];

  // Panels whose main view renders entirely from JS (no placeholder chrome).
  var MAIN_ONLY_PANELS = ['hq', 'projects'];

  // Panels whose sidebar shows another panel's view while active.
  var SIDEBAR_FALLBACKS = { 'projects': 'hq' };

  // ── Lazy module loading ──
  // Controllers are ES modules; they load on first panel open. A failed
  // import clears the cache so the next open retries.
  var _modules = {};
  function loadModule(name) {
    if (!_modules[name]) {
      _modules[name] = import('./' + name + '.js').catch(function(err) {
        _modules[name] = null;
        throw err;
      });
    }
    return _modules[name];
  }

  // ── Mount/unmount hooks (HermesPanels contract: fn(panelId)) ──
  function mountPanel(id) {
    if (id === 'projects') {
      return loadModule('projects').then(function(m) {
        if (typeof m.mount === 'function') return m.mount(id);
      }).catch(function() {
        if (typeof window.showToast === 'function') {
          try { window.showToast('Projects panel failed to load — refresh the page.'); } catch (_) {}
        }
      });
    }
    if (id === 'hq') {
      return loadModule('hq').then(function(m) {
        if (typeof m.mount === 'function') return m.mount(id);
      }).catch(function() {
        if (typeof window.showToast === 'function') {
          try { window.showToast('HQ panel failed to load — refresh the page.'); } catch (_) {}
        }
      });
    }
    return Promise.resolve();
  }

  function unmountPanel(id) {
    if (id === 'projects') {
      return loadModule('projects').then(function(m) {
        if (typeof m.unmount === 'function') m.unmount(id);
      }).catch(function() { /* already gone — nothing to unmount */ });
    }
    if (id === 'hq') {
      return loadModule('hq').then(function(m) {
        if (typeof m.unmount === 'function') m.unmount(id);
      }).catch(function() { /* already gone — nothing to unmount */ });
    }
    return Promise.resolve();
  }

  // ── Init: register panels via HermesPanels ──
  function init() {
    // Graceful: if HermesPanels isn't installed yet, wait for the
    // hermes:panel-ready event (dispatched by panels.js once).
    if (typeof window.HermesPanels === 'undefined') {
      document.addEventListener('hermes:panel-ready', init, { once: true });
      return;
    }

    var hp = window.HermesPanels;
    var i, p;
    for (i = 0; i < HYRAX_PANELS.length; i++) {
      p = HYRAX_PANELS[i];
      var def = {
        id: p.id,
        label: p.label,
        mainView: true,
        mount: mountPanel,
        unmount: unmountPanel,
      };
      // register() rejects an own sidebarFallback key that isn't a string,
      // so only add the key when this panel actually has a fallback.
      if (SIDEBAR_FALLBACKS[p.id]) def.sidebarFallback = SIDEBAR_FALLBACKS[p.id];
      hp.register(def);
    }

    injectNavButtons();
    injectHqSidebarView();
    injectProjectsHost();
    injectCss();
    scheduleHomePanel();
  }

  // ── HQ-first landing ──
  // After the app settles (window load, or a deferred check when load
  // already fired), land on HQ when the URL carries no explicit intent
  // and the user hasn't chosen chat as home. Explicit intents — ?session=,
  // /session/<id>, ?panel=, ?q=, #session= — are never hijacked, except
  // ?panel=<hyrax-panel> (hq, projects, …) which always opens that panel
  // regardless of the stored pref.
  function hasExplicitIntent(search, path, hash) {
    if (/[?&](session|panel|q)=/.test(search)) return true;
    if (path.indexOf('/session/') !== -1) return true;
    if (hash.indexOf('session=') !== -1) return true;
    return false;
  }

  function homePref() {
    try {
      return window.localStorage ? window.localStorage.getItem('hyrax-home') : null;
    } catch (_) {
      return null;
    }
  }

  function isHyraxPanel(id) {
    for (var i = 0; i < HYRAX_PANELS.length; i++) {
      if (HYRAX_PANELS[i].id === id) return true;
    }
    return false;
  }

  function maybeLandOnHq() {
    try {
      var loc = window.location || {};
      var search = typeof loc.search === 'string' ? loc.search : '';
      var path = typeof loc.pathname === 'string' ? loc.pathname : '';
      var hash = typeof loc.hash === 'string' ? loc.hash : '';
      var m = search.match(/[?&]panel=([a-z][a-z0-9-]{0,31})([&#]|$)/);
      var requested = m ? m[1] : null;
      if (!isHyraxPanel(requested)) {
        if (hasExplicitIntent(search, path, hash)) return;
        if (homePref() === 'chat') return;
        requested = 'hq';
      }
      if (typeof switchPanel === 'function') switchPanel(requested);
    } catch (_) {}
  }

  function scheduleHomePanel() {
    var settle = function() { setTimeout(maybeLandOnHq, 0); };
    if (typeof window.addEventListener === 'function'
        && document.readyState !== 'complete') {
      window.addEventListener('load', settle, { once: true });
    } else {
      settle();
    }
  }

  // ── Inject the HQ sidebar panel-view (Operators list) ──
  // The sidebar falls back to the chat panel on HQ because no #panelHq
  // panel-view exists. Inject one; hq.js fills #hyraxHqOperators on mount.
  function injectHqSidebarView() {
    if (document.getElementById('panelHq')) return;
    var ref = document.getElementById('panelChat');
    if (!ref || !ref.parentNode) return;
    var view = document.createElement('div');
    view.className = 'panel-view';
    view.id = 'panelHq';
    view.innerHTML = '<div class="panel-head"><span>Operators</span></div>'
      + '<div class="hyrax-hq-operators" id="hyraxHqOperators"></div>';
    ref.parentNode.appendChild(view);
  }

  // ── Ensure the projects main-view host exists (index.html ships it) ──
  function injectProjectsHost() {
    if (document.getElementById('mainProjects')) return;
    var mainEl = document.querySelector('main.main');
    if (!mainEl) return;
    var div = document.createElement('div');
    div.id = 'mainProjects';
    div.className = 'main-view';
    mainEl.appendChild(div);
  }

  // ── Inject nav buttons into rail + sidebar-nav ──
  function injectNavButtons() {
    var containers = document.querySelectorAll('.rail, .sidebar-nav');
    var cIdx, container;
    for (cIdx = 0; cIdx < containers.length; cIdx++) {
      container = containers[cIdx];
      if (!container) continue;

      var isRail = container.classList.contains('rail');
      var pIdx, p, btn;

      for (pIdx = 0; pIdx < HYRAX_PANELS.length; pIdx++) {
        p = HYRAX_PANELS[pIdx];

        // Skip if button already exists (idempotent injection)
        if (container.querySelector('[data-panel="' + p.id + '"]')) continue;

        btn = document.createElement('button');
        btn.className = (isRail ? 'rail-btn ' : '') + 'nav-tab has-tooltip' + (isRail ? '' : ' has-tooltip--bottom');
        btn.dataset.panel = p.id;
        btn.dataset.label = p.label;
        btn.title = p.label;
        btn.setAttribute('data-tooltip', p.label);
        if (isRail) btn.setAttribute('aria-label', p.label);
        btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + p.icon + '"/></svg>';

        // Listener-based navigation — no inline handlers.
        btn.addEventListener('click', function(panelId) {
          return function() {
            if (typeof switchPanel === 'function') {
              switchPanel(panelId, { fromRailClick: true });
            }
          };
        }(p.id));

        // Insert before settings/logs anchor
        var anchor = container.querySelector('[data-panel="settings"], [data-panel="logs"]');
        container.insertBefore(btn, anchor || null);
      }
    }
  }

  // ── Load hyrax CSS (once) ──
  function injectCss() {
    if (document.querySelector('link[href*="/static/hyrax/hyrax.css"]')) return;
    // Extract version from our own script tag for cache-busting
    var version = '';
    var scripts = document.querySelectorAll('script');
    for (var si = 0; si < scripts.length; si++) {
      var src = scripts[si].src || '';
      var m = src.match(/bootstrap\.js\?v=(.+)/);
      if (m) { version = m[1]; break; }
    }
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/static/hyrax/hyrax.css' + (version ? '?v=' + version : '');
    document.head.appendChild(link);
  }

  // ── Boot ──
  init();
})();
