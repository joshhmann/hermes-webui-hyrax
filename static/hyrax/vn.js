/**
 * Hyraxknot Division — VN Controller (ES module)
 *
 * The visual-novel surface is a presentation adapter over Hermes WebUI's
 * native session/run model (docs/rfcs/hyrax-vn-native-session-adapter.md).
 * This module is the panel-lifecycle controller: it lazily loads the classic
 * Gestalt VN modules (static/hyrax/vn/*, static/hyrax/essence/* — the working
 * presentation surface, which owns the native-adapter calls, the single SSE
 * subscriber, dedupe, and terminal re-arm), then delegates mount/unmount/
 * reopen to GestaltVN.shell.
 *
 * Controller-owned lifecycle (all tracked and released on unmount):
 *   - Escape key returns to the HQ map (capture-phase listener registered
 *     BEFORE the shell's own bubble listener, so navigation happens exactly
 *     once; focus returns to the sister's chibi)
 *   - fallback toast removal timer is tracked and cleared on unmount
 *   - aria-busy on the HQ host while the VN is loading/processing
 *
 * Contracts:
 *   - nothing loads at import time; the classic modules load lazily on the
 *     first VN mount (no startup/HQ cost)
 *   - mount/unmount are idempotent; unmount closes the EventSource but does
 *     NOT cancel an active native run
 *   - closeStream() disposes only the SSE connection (used when entering the
 *     Tai Loft) so the same conversation can be reopened with replay
 *   - reopen() returns to the SAME conversation (vnShell stores the last props)
 *
 * No donor routes, no donor URLs, no second state model — the classic modules
 * use only the native /api/hyrax/vn/* adapter.
 */

'use strict';

// Classic modules in the same load order the previous index.html used.
// These are production files owned by the pre-existing fork work; the
// controller never duplicates their logic.
var CLASSIC_MODULES = [
  './vn/vnEvents.js',
  './vn/vnSession.js',
  './essence/essenceState.js',
  './essence/essenceFrames.js',
  './essence/essenceIntents.js',
  './vn/vnStage.js',
  './vn/vnActions.js',
  './vn/vnSidebar.js',
  './vn/vnDialogue.js',
  './vn/vnComposer.js',
  './vn/vnApprovals.js',
  './vn/vnTechDrawer.js',
  './vn/vnShell.js',
];

var _loadPromise = null;
var _mounted = false;
var _gen = 0;
var _currentSisterId = null;
var _hostEl = null;          // #mainHq host (aria-busy / toast / focus target)
var _toastTimer = null;      // tracked fallback-toast removal timer
var _escapeHandler = null;   // controller-owned Escape → HQ listener

function _root() {
  return typeof window !== 'undefined' ? window : globalThis;
}

function _shell() {
  var ns = _root().GestaltVN;
  return (ns && ns.shell) || null;
}

function _events() {
  var ns = _root().GestaltVN;
  return (ns && ns.events) || null;
}

function _host() {
  try {
    var doc = _root().document;
    return doc ? doc.getElementById('mainHq') : null;
  } catch (_) {
    return null;
  }
}

/**
 * Load the classic modules exactly once. A failed load resets the promise so
 * a later mount can retry; the failure is rethrown for the caller to surface.
 */
function ensureLoaded() {
  if (!_loadPromise) {
    _loadPromise = Promise.all(
      CLASSIC_MODULES.map(function(spec) { return import(spec); })
    ).then(function() {
      _mounted = false;
      return true;
    }).catch(function(err) {
      _loadPromise = null;
      throw err;
    });
  }
  return _loadPromise;
}

// ── Controller-owned toast (tracked) ──
// Uses the native toast when available; otherwise renders a scoped fallback
// in the HQ host whose removal timer is tracked so unmount can clear it.
function _toast(msg) {
  var root = _root();
  if (typeof root.showToast === 'function') {
    try { root.showToast(msg); return; } catch (_) { /* fall through */ }
  }
  var host = _hostEl || _host();
  if (!host || !root.document) return;
  var t;
  try {
    t = root.document.createElement('div');
    t.className = 'hyrax-toast';
    t.textContent = String(msg);
    host.appendChild(t);
  } catch (_) { return; }
  if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
  _toastTimer = setTimeout(function() {
    _toastTimer = null;
    try { if (t && t.remove) t.remove(); } catch (_) { /* isolated */ }
  }, 5000);
}

function _clearToastTimer() {
  if (_toastTimer) {
    clearTimeout(_toastTimer);
    _toastTimer = null;
  }
}

// ── Escape → HQ (controller-owned, capture phase) ──
// Registered before the shell's bubble-phase handler so navigation happens
// exactly once; focus returns to the sister's chibi on the re-rendered map.
function _armEscapeHandler() {
  var root = _root();
  if (_escapeHandler || !root.document || !root.document.addEventListener) return;
  _escapeHandler = function(event) {
    if (!event || event.key !== 'Escape') return;
    if (typeof event.stopImmediatePropagation === 'function') {
      event.stopImmediatePropagation();
    }
    if (typeof event.preventDefault === 'function') event.preventDefault();
    _backToHq();
  };
  try {
    root.document.addEventListener('keydown', _escapeHandler, true);
  } catch (_) {
    _escapeHandler = null;
  }
}

function _disarmEscapeHandler() {
  var root = _root();
  if (!_escapeHandler) return;
  try {
    if (root.document && root.document.removeEventListener) {
      root.document.removeEventListener('keydown', _escapeHandler, true);
    }
  } catch (_) { /* isolated */ }
  _escapeHandler = null;
}

// Return to the HQ map: tear down the VN (closes its stream, does NOT cancel
// an active native run), re-render the 2D map, and restore focus to the
// sister's chibi. Mirrors the classic shell's _backToHq path.
function _backToHq() {
  var sisterId = _currentSisterId;
  var content = _hostEl;
  unmount();
  if (!content) return;
  try { content.dataset.vnActive = ''; } catch (_) { /* isolated */ }
  var root = _root();
  if (typeof root.__hqShow2d === 'function') {
    try { root.__hqShow2d(content); } catch (_) { /* isolated */ }
  } else {
    try {
      if (content.replaceChildren) content.replaceChildren();
      else content.innerHTML = '';
      if (typeof root.__hqMount === 'function') root.__hqMount('hq');
    } catch (_) { /* isolated */ }
  }
  if (sisterId) {
    try {
      var chibi = root.document
        ? root.document.querySelector('.chibi-' + sisterId) : null;
      if (chibi && typeof chibi.focus === 'function') chibi.focus();
    } catch (_) { /* isolated */ }
  }
}

function _setBusy(on) {
  var host = _hostEl || _host();
  if (!host) return;
  try {
    if (on) host.setAttribute('aria-busy', 'true');
    else host.removeAttribute('aria-busy');
  } catch (_) { /* isolated */ }
}

/**
 * Mount the VN for a sister inside the HQ host (#mainHq — owned by vnShell).
 * Idempotent: mounting the same sister again is a no-op; mounting a different
 * sister while mounted switches conversations (vnShell teardown + remount).
 * Resolves true on success, false when the surface is unavailable (a tracked
 * toast reports the failure — never silent).
 */
function mount(props) {
  if (!props || typeof props.sisterId !== 'string' || !props.sisterId) {
    return Promise.resolve(false);
  }
  var gen = ++_gen;
  _hostEl = _host();
  _setBusy(true);
  var settle = function() {
    if (gen === _gen) _setBusy(false);
  };
  return ensureLoaded().then(function() {
    var shell = _shell();
    if (!shell || typeof shell.mount !== 'function') {
      settle();
      if (gen === _gen) {
        _toast((props.sisterName || props.sisterId) + ' is unavailable right now — try again.');
      }
      return false;
    }
    if (gen !== _gen) { settle(); return false; } // superseded while loading
    if (_mounted && _currentSisterId === props.sisterId) {
      settle(); return true; // idempotent
    }
    _armEscapeHandler();
    var result = shell.mount(props);
    if (result && typeof result.then === 'function') {
      return result.then(function() {
        if (gen !== _gen) { settle(); return false; }
        _mounted = true;
        _currentSisterId = props.sisterId;
        settle();
        return true;
      }).catch(function() {
        if (gen === _gen) {
          _toast((props.sisterName || props.sisterId) + ' is unavailable right now — try again.');
        }
        settle();
        return false;
      });
    }
    _mounted = true;
    _currentSisterId = props.sisterId;
    settle();
    return true;
  }).catch(function() {
    if (gen === _gen) {
      _toast((props.sisterName || props.sisterId) + ' is unavailable right now — try again.');
    }
    settle();
    return false;
  });
}

/**
 * Unmount the VN: closes the EventSource, removes listeners and DOM. Does NOT
 * cancel an active native run (the backend keeps streaming into the journal).
 * Idempotent.
 */
function unmount() {
  _gen++; // invalidate any in-flight mount
  _mounted = false;
  _currentSisterId = null;
  _disarmEscapeHandler();
  _clearToastTimer();
  _setBusy(false);
  _hostEl = null;
  var shell = _shell();
  if (shell && typeof shell.unmount === 'function') {
    try { shell.unmount(); } catch (_) { /* isolated */ }
  }
}

/**
 * Reopen the SAME conversation after the Tai Loft exits (or any transient
 * takeover). vnShell retains the last mount props; its mount() reconnects the
 * SSE with replay (after_event_id) so nothing is double-rendered.
 */
function reopen() {
  var shell = _shell();
  if (shell && typeof shell.reopen === 'function') {
    try { shell.reopen(); } catch (_) { /* isolated */ }
  }
}

/**
 * Dispose only the SSE connection for the active conversation. The VN DOM and
 * session state stay mounted; the next reopen() reconnects with replay. Used
 * when entering the Tai Loft so no stale stream keeps draining in the
 * background. Never cancels a native run.
 */
function closeStream() {
  var ev = _events();
  if (ev && typeof ev.dispose === 'function') {
    try { ev.dispose(); } catch (_) { /* isolated */ }
  }
}

function isMounted() {
  var shell = _shell();
  if (shell && typeof shell.isMounted === 'function') {
    try { return !!shell.isMounted(); } catch (_) { return _mounted; }
  }
  return _mounted;
}

export { mount, unmount, reopen, closeStream, isMounted, ensureLoaded };
