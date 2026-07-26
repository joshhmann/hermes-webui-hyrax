/**
 * Hyraxknot Division — Hermes WebUI Extension Bootstrap
 * 
 * Registers division panels via window.HermesPanels.register(), injects
 * DOM elements, and hooks into the Hermes WebUI panel system WITHOUT
 * modifying core arrays or monkey-patching switchPanel.
 * 
 * Loaded by index.html via: <script src="/static/hyrax/bootstrap.js" defer>
 */
(function() {
  'use strict';

  // ── Panel definitions ──
  // Hyrax is HQ-centric: the only added rail panel is HQ. The upstream
  // WebUI panels stay untouched (AGENTS: don't mess with the OEM surface).
  // (Retired 2026-07-24: projects/warroom/dispatch/verify/promises were
  // placeholder panels — redundant with the native panels.)
  var HYRAX_PANELS = [
    { id: 'hq', label: 'HQ', icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
  ];

  // ── HQ mount/unmount hooks (lazy 3D) ──
  // Delegates to window.__hqMount / __hqUnmount populated by hq.js.
  // The module-level functions in hq.js are referenced here so we don't
  // force eager loading — they're captured on first mount.
  function mountHq(id) {
    if (typeof window.__hqMount === 'function') {
      return window.__hqMount(id);
    }
  }

  function unmountHq(id) {
    if (typeof window.__hqUnmount === 'function') {
      return window.__hqUnmount(id);
    }
  }

  // ── 1. Init: register panels via HermesPanels ──
  function init() {
    // Graceful: if HermesPanels isn't installed yet, wait for the
    // hermes:panel-ready event (dispatched by panels.js once).
    if (typeof window.HermesPanels === 'undefined') {
      document.addEventListener('hermes:panel-ready', init, { once: true });
      return;
    }

    // Register each panel with its lifecycle hooks.
    var hp = window.HermesPanels;
    var i, p, unreg;
    for (i = 0; i < HYRAX_PANELS.length; i++) {
      p = HYRAX_PANELS[i];
      unreg = hp.register({
        id: p.id,
        label: p.label,
        mount: mountHq,
        unmount: unmountHq,
      });
      // Keep unregister handle for any future cleanup
      if (typeof p._unreg !== 'undefined') continue;
      p._unreg = unreg;
    }

    injectNavButtons();
    injectPanelDivs();
    injectHqSidebarView();
    injectCss();
    scheduleHomePanel();
  }

  // ── HQ-first landing ──
  // After the app settles (window load, or a deferred check when load
  // already fired), land on HQ when the URL carries no explicit intent
  // and the user hasn't chosen chat as home. Explicit intents — ?session=,
  // /session/<id>, ?panel=, ?q=, #session= — are never hijacked, except
  // ?panel=hq which always opens HQ regardless of the stored pref.
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

  function maybeLandOnHq() {
    try {
      var loc = window.location || {};
      var search = typeof loc.search === 'string' ? loc.search : '';
      var path = typeof loc.pathname === 'string' ? loc.pathname : '';
      var hash = typeof loc.hash === 'string' ? loc.hash : '';
      var wantsHq = /[?&]panel=hq([&#]|$)/.test(search);
      if (!wantsHq) {
        if (hasExplicitIntent(search, path, hash)) return;
        if (homePref() === 'chat') return;
      }
      if (typeof switchPanel === 'function') switchPanel('hq');
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

  // ── 3b. Inject the HQ sidebar panel-view (Operators list) ──
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

  // ── 2. Inject nav buttons into rail + sidebar-nav ──
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

        // Skip if button already exists
        if (container.querySelector('[data-panel="' + p.id + '"]')) continue;

        btn = document.createElement('button');
        btn.className = (isRail ? 'rail-btn ' : '') + 'nav-tab has-tooltip' + (isRail ? '' : ' has-tooltip--bottom');
        btn.dataset.panel = p.id;
        btn.dataset.label = p.label;
        btn.title = p.label;
        btn.setAttribute('data-tooltip', p.label);
        btn.setAttribute('onclick', "switchPanel('" + p.id + "',{fromRailClick:true})");
        if (isRail) btn.setAttribute('aria-label', p.label);
        btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + p.icon + '"/></svg>';

        // Insert before settings/logs anchor
        var anchor = container.querySelector('[data-panel="settings"], [data-panel="logs"]');
        container.insertBefore(btn, anchor || null);
      }
    }
  }

  // ── 3. Inject panel divs into main.main (main-view panels) ──
  function injectPanelDivs() {
    var mainEl = document.querySelector('main.main');
    if (!mainEl) return;

    var mainOnlyPanels = ['hq'];  // HQ gets its own mount/unmount lifecycle
    var pIdx, p, mid, existing, div;

    for (pIdx = 0; pIdx < HYRAX_PANELS.length; pIdx++) {
      p = HYRAX_PANELS[pIdx];
      mid = 'main' + p.id.charAt(0).toUpperCase() + p.id.slice(1);
      existing = document.getElementById(mid);
      if (existing) continue;

      div = document.createElement('div');
      div.id = mid;
      div.className = 'main-view';

      if (mainOnlyPanels.indexOf(p.id) !== -1) {
        // HQ — empty container; hq.js/vn.js render into #mainHq on mount.
        // (index.html already ships #mainHq, so this branch is a fallback
        // and must not duplicate ids like mainHqBody.)
        div.innerHTML = '';
      } else {
        div.innerHTML = '<div class="main-view-header"><h2 class="main-view-title">' + p.label + '</h2></div>'
          + '<div class="main-view-content" id="hyrax-' + p.id + '-content">'
          + '<p class="hyrax-placeholder">' + p.label + ' — coming soon.</p>'
          + '</div>';
      }

      mainEl.appendChild(div);
    }
  }

  // ── 4. Load hyrax CSS (once) ──
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

  // ── 5. Boot ──
  init();
})();
