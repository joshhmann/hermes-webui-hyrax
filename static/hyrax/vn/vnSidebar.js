/* vnSidebar.js — Gestalt VN interactable sidebar.
 *
 * Sections Operator / Room / Work / System with ≤5 visible entries plus a
 * "More…" overflow. Availability (`when`) is re-evaluated on vnEvents
 * (busy / approval / activity), essence intent changes, and stage frame
 * commits (pose availability tracks the frame the stage actually shows —
 * provider chains are async) — never on timers.
 * Disabled actions carry a reason tooltip + aria. confirmation.required
 * actions route through an inline dialog. Mobile bottom-sheet behavior is
 * CSS-driven off the root class hook only.
 *
 * Classic-script IIFE. Namespace: window.GestaltVN.vn.sidebar
 */
(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : globalThis;
  var GestaltVN = root.GestaltVN = root.GestaltVN || {};
  var vn = GestaltVN.vn = GestaltVN.vn || {};
  var essence = GestaltVN.essence = GestaltVN.essence || {};

  var MAX_VISIBLE = 5;
  var SECTIONS = [
    { id: 'operator', title: 'Operator', category: 'operator' },
    { id: 'room', title: 'Room', category: 'environment' },
    { id: 'work', title: 'Work', category: 'work' },
    { id: 'system', title: 'System', category: 'system' },
  ];

  // Event kinds that can change availability (busy/approval/activity).
  var AVAILABILITY_EVENTS = {
    'tool.started': true, 'tool.completed': true, 'tool.failed': true,
    'approval.requested': true, 'approval.resolved': true,
    'response.started': true, 'response.completed': true,
    'response.failed': true, 'interruption': true,
    'activity.changed': true, 'session.changed': true,
    'reconnect': true, 'disconnect': true,
  };

  var _container = null;
  var _ctx = null;
  var _root = null;
  var _dialog = null;
  var _eventsUnsub = null;
  var _intentUnsub = null;
  var _stageUnsub = null;
  var _overflowOpen = {};   // sectionId -> bool
  var _mounted = false;

  function _el(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }

  // ── Confirmation dialog ──────────────────────────────────────────────────

  function _closeDialog() {
    if (_dialog && _dialog.remove) _dialog.remove();
    _dialog = null;
  }

  function _confirm(entry, message, onConfirm) {
    _closeDialog();
    _dialog = _el('div', 'gestalt-vn-confirm');
    _dialog.setAttribute('role', 'alertdialog');
    _dialog.setAttribute('aria-modal', 'true');
    var text = _el('p', 'gestalt-vn-confirm-message',
      message || 'Are you sure?');
    var row = _el('div', 'gestalt-vn-confirm-buttons');
    var ok = _el('button', 'gestalt-vn-confirm-ok', 'Confirm');
    ok.setAttribute('type', 'button');
    var cancel = _el('button', 'gestalt-vn-confirm-cancel', 'Cancel');
    cancel.setAttribute('type', 'button');
    ok.addEventListener('click', function () {
      _closeDialog();
      onConfirm();
    });
    cancel.addEventListener('click', _closeDialog);
    row.appendChild(ok);
    row.appendChild(cancel);
    _dialog.appendChild(text);
    _dialog.appendChild(row);
    (_root || _container).appendChild(_dialog);
  }

  // ── Action execution ─────────────────────────────────────────────────────

  function _execute(entry) {
    if (!vn.actions) return;
    var runIt = function () {
      vn.actions.run(entry.id, _ctx).then(function (outcome) {
        // Availability may have flipped (e.g. busy after a send).
        render();
        return outcome;
      });
    };
    if (entry.confirmation && entry.confirmation.required) {
      _confirm(entry, entry.confirmation.message, runIt);
      return;
    }
    runIt();
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  function _actionButton(entry) {
    var avail = vn.actions.evaluate(entry.id, _ctx);
    var btn = _el('button', 'gestalt-vn-action', entry.label);
    btn.setAttribute('type', 'button');
    btn.setAttribute('data-action-id', entry.id);
    if (entry.icon) btn.setAttribute('data-icon', entry.icon);
    if (!avail.enabled) {
      btn.disabled = true;
      btn.setAttribute('aria-disabled', 'true');
      if (avail.reasonDisabled) {
        btn.setAttribute('title', avail.reasonDisabled);
        btn.setAttribute('aria-label',
          entry.label + ' — ' + avail.reasonDisabled);
      }
    }
    btn.addEventListener('click', function () {
      if (btn.disabled) return;
      _execute(entry);
    });
    return btn;
  }

  function _renderSection(section) {
    var wrap = _el('section', 'gestalt-vn-sidebar-section');
    wrap.setAttribute('data-section', section.id);
    wrap.appendChild(_el('h3', 'gestalt-vn-sidebar-title', section.title));

    var entries = vn.actions.list().filter(function (entry) {
      return entry.category === section.category;
    });
    var visible = entries.filter(function (entry) {
      return vn.actions.evaluate(entry.id, _ctx).visible;
    });
    if (!visible.length) {
      wrap.hidden = true;
      return wrap;
    }

    var listEl = _el('div', 'gestalt-vn-sidebar-actions');
    var shown = _overflowOpen[section.id] ? visible : visible.slice(0, MAX_VISIBLE);
    shown.forEach(function (entry) {
      listEl.appendChild(_actionButton(entry));
    });
    wrap.appendChild(listEl);

    if (visible.length > MAX_VISIBLE) {
      var more = _el('button', 'gestalt-vn-sidebar-more',
        _overflowOpen[section.id] ? 'Less…' : 'More…');
      more.setAttribute('type', 'button');
      more.setAttribute('aria-expanded', _overflowOpen[section.id] ? 'true' : 'false');
      more.addEventListener('click', function () {
        _overflowOpen[section.id] = !_overflowOpen[section.id];
        render();
      });
      wrap.appendChild(more);
    }
    return wrap;
  }

  function render() {
    if (!_root || !vn.actions) return;
    _closeDialog();
    _root.replaceChildren();
    SECTIONS.forEach(function (section) {
      _root.appendChild(_renderSection(section));
    });
  }

  // ── Event wiring (never timer-driven) ────────────────────────────────────

  function _onEvent(event) {
    if (!event || !AVAILABILITY_EVENTS[event.kind]) return;
    if (_ctx) {
      switch (event.kind) {
        case 'tool.started':
        case 'response.started':
          _ctx.busy = true;
          break;
        case 'tool.completed':
        case 'tool.failed':
        case 'response.completed':
        case 'response.failed':
        case 'interruption':
          _ctx.busy = false;
          break;
        case 'approval.requested':
          _ctx.approvalPending = true;
          break;
        case 'approval.resolved':
          _ctx.approvalPending = false;
          break;
        case 'activity.changed':
          if (event.payload && event.payload.type) {
            _ctx.activity = event.payload;
          }
          break;
      }
    }
    render();
  }

  function _tryHookEvents() {
    if (_eventsUnsub) return;
    var events = GestaltVN.events;
    if (events && typeof events.subscribe === 'function') {
      try { _eventsUnsub = events.subscribe('*', _onEvent); } catch (e) {}
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────

  function init(container, ctx) {
    if (!container) return null;
    dispose();
    _container = container;
    _ctx = ctx || {};
    _overflowOpen = {};

    _root = _el('aside', 'gestalt-vn-sidebar'); // CSS hook: mobile bottom-sheet
    _root.setAttribute('aria-label', 'Interactions');
    container.appendChild(_root);

    _tryHookEvents();
    if (essence.intents && typeof essence.intents.subscribe === 'function') {
      _intentUnsub = essence.intents.subscribe(function () { render(); });
    }
    // Pose/expression availability is computed against the on-stage frame
    // (_poseAvailability), but provider chains commit frames ASYNC — an
    // intent subscriber (above) fires before the new pose lands, so a
    // manual sit/stand click or an essenced-derived pose beat used to leave
    // the action list evaluated against the stale frame. Re-render when the
    // stage actually commits a frame.
    if (vn.stage && typeof vn.stage.subscribe === 'function') {
      _stageUnsub = vn.stage.subscribe(function () { render(); });
    }

    render();
    _mounted = true;
    return api;
  }

  function update(partialCtx) {
    if (!_ctx) _ctx = {};
    if (partialCtx) {
      for (var k in partialCtx) _ctx[k] = partialCtx[k];
    }
    render();
  }

  function setRoom(manifest) {
    update({ roomManifest: manifest });
  }

  function dispose() {
    if (_eventsUnsub) { try { _eventsUnsub(); } catch (e) {} _eventsUnsub = null; }
    if (_intentUnsub) { try { _intentUnsub(); } catch (e) {} _intentUnsub = null; }
    if (_stageUnsub) { try { _stageUnsub(); } catch (e) {} _stageUnsub = null; }
    _closeDialog();
    if (_root && _root.remove) _root.remove();
    _root = null;
    _container = null;
    _ctx = null;
    _mounted = false;
  }

  var api = {
    init: init,
    render: render,
    update: update,
    setRoom: setRoom,
    dispose: dispose,
    MAX_VISIBLE: MAX_VISIBLE,
    SECTIONS: SECTIONS,
  };
  vn.sidebar = api;
})();
