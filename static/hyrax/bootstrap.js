/**
 * Hyraxknot Division — Hermes WebUI Extension Bootstrap
 * 
 * Registers division panels, injects DOM elements, and hooks into
 * the existing Hermes WebUI panel system WITHOUT modifying core files.
 * 
 * Loaded by index.html via: <script src="/static/hyrax/bootstrap.js">
 */
(function() {
  'use strict';

  // ── Panel definitions ──
  // Each entry: { id, label, icon (SVG path), file }
  const HYRAX_PANELS = [
    { id: 'projects', label: 'Projects', icon: 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z' },
    { id: 'warroom',  label: 'War Room', icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z' },
    { id: 'dispatch', label: 'Dispatch', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
    { id: 'verify',   label: 'Verify', icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z' },
    { id: 'promises', label: 'Promises', icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
    { id: 'hq',       label: 'HQ', icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
  ];

  // ── 1. Register panel names ──
  // Push into Hermes' MAIN_VIEW_PANELS array so switchPanel() knows about us
  if (typeof MAIN_VIEW_PANELS !== 'undefined') {
    HYRAX_PANELS.forEach(p => {
      if (!MAIN_VIEW_PANELS.includes(p.id)) MAIN_VIEW_PANELS.push(p.id);
    });
  }

  // ── 2. Inject panel divs ──
  // Find the panels container (the element holding .panel-view elements)
  const panelsContainer = document.querySelector('.panels');
  if (panelsContainer) {
    HYRAX_PANELS.forEach(p => {
      const div = document.createElement('div');
      div.id = 'panel' + p.id.charAt(0).toUpperCase() + p.id.slice(1);
      div.className = 'panel-view';
      div.innerHTML = '<div class="panel-page"><div class="page-header"><h2>' + p.label + '</h2></div><div class="panel-content" id="hyrax-' + p.id + '-content"></div></div>';
      panelsContainer.appendChild(div);
    });
  }

  // ── 3. Add sidebar nav buttons ──
  const sidebarNav = document.querySelector('.sidebar-nav');
  if (sidebarNav) {
    // Find the settings button as anchor (insert before it)
    const anchor = sidebarNav.querySelector('[data-panel="settings"]');
    HYRAX_PANELS.forEach(p => {
      const btn = document.createElement('button');
      btn.className = 'nav-tab has-tooltip has-tooltip--bottom';
      btn.dataset.panel = p.id;
      btn.dataset.label = p.label;
      btn.title = p.label;
      btn.setAttribute('data-tooltip', p.label);
      btn.setAttribute('onclick', "switchPanel('" + p.id + "',{fromRailClick:true})");
      btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + p.icon + '"/></svg>';
      sidebarNav.insertBefore(btn, anchor || null);
    });
  }

  // ── 4. Hook lazy-load into switchPanel ──
  // Monkey-patch switchPanel to trigger our load functions
  if (typeof switchPanel === 'function') {
    const origSwitchPanel = switchPanel;
    window.switchPanel = async function(name, opts) {
      const result = await origSwitchPanel(name, opts);
      // Check if this is one of our panels
      const panel = HYRAX_PANELS.find(p => p.id === name);
      if (panel && typeof window['load' + panel.id.charAt(0).toUpperCase() + panel.id.slice(1)] === 'function') {
        window['load' + panel.id.charAt(0).toUpperCase() + panel.id.slice(1)]();
      }
      return result;
    };
  }

  // ── 5. Load hyrax CSS ──
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/static/hyrax/hyrax.css';
  document.head.appendChild(link);
})();
