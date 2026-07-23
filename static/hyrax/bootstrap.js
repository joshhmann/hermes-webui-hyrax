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
  // HQ gets mount/unmount for lazy-loaded 3D.  Simple panels are
  // informational / placeholder only (mount stays null).
  var HYRAX_PANELS = [
    { id: 'projects', label: 'Projects', icon: 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z' },
    { id: 'warroom',  label: 'War Room', icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z' },
    { id: 'dispatch', label: 'Dispatch', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
    { id: 'verify',   label: 'Verify', icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z' },
    { id: 'promises', label: 'Promises', icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
    { id: 'hq',       label: 'HQ', icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
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

    // Register each panel.  HQ gets lifecycle hooks; the rest are
    // static (mount=null).
    var hp = window.HermesPanels;
    var i, p, unreg;
    for (i = 0; i < HYRAX_PANELS.length; i++) {
      p = HYRAX_PANELS[i];
      if (p.id === 'hq') {
        unreg = hp.register({
          id: p.id,
          label: p.label,
          mount: mountHq,
          unmount: unmountHq,
        });
      } else {
        unreg = hp.register({
          id: p.id,
          label: p.label,
          // mainView default (true) — gets its own main-content area
        });
      }
      // Keep unregister handle for any future cleanup
      if (typeof p._unreg !== 'undefined') return;
      p._unreg = unreg;
    }

    injectNavButtons();
    injectPanelDivs();
    injectCss();
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
        // HQ — minimal container; hq.js fills #mainHqBody on mount
        div.innerHTML = '<div id="mainHqBody"></div>';
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
