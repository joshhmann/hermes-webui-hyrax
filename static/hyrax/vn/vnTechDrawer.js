/**
 * Gestalt VN revamp (vn2) — vnTechDrawer.js
 *
 * Slide-over technical drawer: tool detail list (from the vnEvents ring
 * buffer), metering/TPS, context status, session id, model chip, and links
 * out to standard chat / workspace panel. Leaves the scene untouched
 * (SPEC §2.1).
 *
 * Classic script, IIFE. Registers onto window.GestaltVN.techDrawer.
 *
 * API:
 *   init({container, toggleButton})
 *   open() / close() / toggle()
 *   isOpen()
 *   dispose()
 */
(function() {
  'use strict';

  var root = typeof window !== 'undefined' ? window : globalThis;
  var ns = root.GestaltVN = root.GestaltVN || {};

  var MAX_TOOL_ROWS = 50;

  var _container = null;
  var _toggleButton = null;
  var _listEl = null;
  var _meteringEl = null;
  var _contextEl = null;
  var _sessionEl = null;
  var _modelEl = null;
  var _lastMetering = null;
  var _lastContext = null;
  var _open = false;
  var _unsubs = [];
  var _sessionUnsub = null;
  var _disposed = true;

  function _el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = String(text);
    return e;
  }

  function _pretty(obj) {
    try { return JSON.stringify(obj, null, 1); } catch (_) { return String(obj); }
  }

  // ── Content builders ──

  function _renderSession() {
    var s = ns.session;
    var cur = s && typeof s.current === 'function' ? s.current() : null;
    if (_sessionEl) {
      _sessionEl.textContent = cur
        ? cur.sessionId + (cur.busy ? ' (busy)' : '')
        : '—';
    }
    if (_modelEl) {
      // The bounded VN conversation payload does not expose the model; the
      // profile chip is the truthful value we have. Fail closed, no guesses.
      _modelEl.textContent = cur ? ('profile: ' + cur.operatorId) : '—';
    }
  }

  function _renderMetering() {
    if (_meteringEl) {
      _meteringEl.textContent = _lastMetering ? _pretty(_lastMetering) : '—';
    }
  }

  function _renderContext() {
    if (_contextEl) {
      _contextEl.textContent = _lastContext ? _pretty(_lastContext) : '—';
    }
  }

  function _renderTools() {
    if (!_listEl) return;
    _listEl.replaceChildren();
    var rows = [];
    var ev = ns.events;
    if (ev && typeof ev.replay === 'function') {
      ev.replay(function(e) {
        if (e && typeof e.kind === 'string' && e.kind.slice(0, 5) === 'tool.') rows.push(e);
      });
    }
    if (rows.length > MAX_TOOL_ROWS) rows = rows.slice(rows.length - MAX_TOOL_ROWS);
    if (!rows.length) {
      _listEl.appendChild(_el('div', 'vn2-drawer-empty', 'No tool activity yet.'));
      return;
    }
    for (var i = 0; i < rows.length; i++) {
      var e = rows[i];
      var p = e.payload || {};
      var name = typeof p.name === 'string' && p.name ? p.name : '(tool)';
      var line = _el('div', 'vn2-drawer-tool');
      line.appendChild(_el('span', 'vn2-drawer-tool-kind', e.kind));
      line.appendChild(_el('span', 'vn2-drawer-tool-name', name));
      line.appendChild(_el('span', 'vn2-drawer-tool-ts', e.timestamp || ''));
      _listEl.appendChild(line);
    }
  }

  function _renderAll() {
    _renderSession();
    _renderMetering();
    _renderContext();
    _renderTools();
  }

  // ── Links ──

  function _link(label, fn) {
    var b = _el('button', 'vn2-btn vn2-drawer-link', label);
    b.setAttribute('type', 'button');
    b.addEventListener('click', function() {
      try { fn(); } catch (_) {}
    });
    return b;
  }

  // ── Public API ──

  function init(opts) {
    opts = opts || {};
    dispose();
    if (!opts.container) return false;
    _disposed = false;
    _container = opts.container;
    _toggleButton = opts.toggleButton || null;
    _container.classList.add('vn2-drawer');

    _container.appendChild(_el('div', 'vn2-drawer-title', 'Technical'));

    var sessionRow = _el('div', 'vn2-drawer-row');
    sessionRow.appendChild(_el('span', 'vn2-drawer-label', 'Session'));
    _sessionEl = _el('span', 'vn2-drawer-value');
    sessionRow.appendChild(_sessionEl);
    _container.appendChild(sessionRow);

    var modelRow = _el('div', 'vn2-drawer-row');
    modelRow.appendChild(_el('span', 'vn2-drawer-label', 'Model'));
    _modelEl = _el('span', 'vn2-drawer-value vn2-model-chip');
    modelRow.appendChild(_modelEl);
    _container.appendChild(modelRow);

    _container.appendChild(_el('div', 'vn2-drawer-label', 'Metering / TPS'));
    _meteringEl = _el('pre', 'vn2-drawer-pre');
    _container.appendChild(_meteringEl);

    _container.appendChild(_el('div', 'vn2-drawer-label', 'Context status'));
    _contextEl = _el('pre', 'vn2-drawer-pre');
    _container.appendChild(_contextEl);

    _container.appendChild(_el('div', 'vn2-drawer-label', 'Tools'));
    _listEl = _el('div', 'vn2-drawer-tools');
    _container.appendChild(_listEl);

    var links = _el('div', 'vn2-drawer-links');
    links.appendChild(_link('Open standard chat', function() {
      var s = ns.session;
      if (s && typeof s.openInStandardChat === 'function') s.openInStandardChat();
    }));
    links.appendChild(_link('Open workspace panel', function() {
      if (typeof root.switchPanel === 'function') root.switchPanel('workspaces');
    }));
    _container.appendChild(links);

    if (_toggleButton) {
      _toggleButton.addEventListener('click', toggle);
      _toggleButton.setAttribute('aria-expanded', 'false');
    }

    var ev = ns.events;
    if (ev) {
      _unsubs.push(ev.subscribe('metering.update', function(e) {
        _lastMetering = e.payload || {};
        if (_open) _renderMetering();
      }));
      _unsubs.push(ev.subscribe('context.status', function(e) {
        _lastContext = e.payload || {};
        if (_open) _renderContext();
      }));
      _unsubs.push(ev.subscribe('tool.*', function() {
        if (_open) _renderTools();
      }));
    }
    var s = ns.session;
    if (s && typeof s.on === 'function') {
      _sessionUnsub = s.on(function() { if (_open) _renderSession(); });
    }
    _renderAll();
    return true;
  }

  function open() {
    if (_disposed || !_container) return;
    _open = true;
    _container.classList.add('vn2-drawer--open');
    if (_toggleButton) _toggleButton.setAttribute('aria-expanded', 'true');
    _renderAll();
  }

  function close() {
    if (!_container) return;
    _open = false;
    _container.classList.remove('vn2-drawer--open');
    if (_toggleButton) _toggleButton.setAttribute('aria-expanded', 'false');
  }

  function toggle() {
    if (_open) close(); else open();
  }

  function isOpen() {
    return _open;
  }

  function dispose() {
    for (var i = 0; i < _unsubs.length; i++) {
      try { _unsubs[i](); } catch (_) {}
    }
    _unsubs = [];
    if (_sessionUnsub) {
      try { _sessionUnsub(); } catch (_) {}
      _sessionUnsub = null;
    }
    if (_container) {
      try { _container.replaceChildren(); } catch (_) {}
      _container.classList.remove('vn2-drawer--open');
      _container.classList.remove('vn2-drawer');
    }
    _container = null;
    _toggleButton = null;
    _listEl = null;
    _meteringEl = null;
    _contextEl = null;
    _sessionEl = null;
    _modelEl = null;
    _lastMetering = null;
    _lastContext = null;
    _open = false;
    _disposed = true;
  }

  ns.techDrawer = {
    init: init,
    open: open,
    close: close,
    toggle: toggle,
    isOpen: isOpen,
    dispose: dispose,
  };
})();
