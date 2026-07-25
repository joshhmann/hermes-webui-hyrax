/* vnActions.js — Gestalt VN deterministic action registry.
 *
 * Spec: docs/gestalt-vn/GESTALT_INTERACTABLES_SPEC.md §2–§5. The registry is
 * static, versioned, code-owned; a model may reorder or annotate but never
 * synthesize ids. Each entry:
 *   {id, label, category, icon, action, when(ctx), run(ctx),
 *    confirmation?, presentationHints?}
 * SidebarContext = {operatorId, sessionId, busy, approvalPending, activity,
 *                   essenceState, roomManifest, surface, sendText, ...}.
 *
 * Also owns the room-manifest loader + schema validation (fail closed).
 *
 * Classic-script IIFE. Namespace: window.GestaltVN.vn.actions / .rooms
 */
(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : globalThis;
  var GestaltVN = root.GestaltVN = root.GestaltVN || {};
  var vn = GestaltVN.vn = GestaltVN.vn || {};
  var essence = GestaltVN.essence = GestaltVN.essence || {};

  var OPERATORS = ['tai', 'rei', 'nei', 'mai'];
  var ROOMS_BASE_URL = '/static/hyrax/vn/rooms';

  var _registry = {};    // id -> entry
  var _inFlight = {};    // id -> true (duplicate-execution lock)
  var _warned = {};      // id -> true (one-time unregistered log)
  var _issues = [];

  // ── Helpers ──────────────────────────────────────────────────────────────

  function _api(url, opts) {
    if (typeof root.api === 'function') return root.api(url, opts);
    if (typeof fetch === 'function') {
      return fetch(url, opts).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
    }
    return Promise.reject(new Error('no api transport'));
  }

  function _toast(message) {
    if (typeof root.showToast === 'function') root.showToast(message);
  }

  function _logIssue(msg) {
    _issues.push(msg);
    if (typeof console !== 'undefined' && console.warn) console.warn(msg);
  }

  function _shell() {
    return GestaltVN.shell || null;
  }

  function _shellState(patch) {
    var shell = _shell();
    if (shell && typeof shell.setState === 'function') {
      shell.setState(patch);
      return true;
    }
    return false;
  }

  function _notBusy(ctx) {
    return {
      visible: true,
      enabled: !(ctx && ctx.busy),
      reasonDisabled: ctx && ctx.busy ? 'Operator is busy' : undefined,
    };
  }

  function _activityType(ctx) {
    return (ctx && ctx.activity && ctx.activity.type) ||
      (ctx && ctx.essenceState && ctx.essenceState.activity &&
       ctx.essenceState.activity.type) || 'idle';
  }

  function _sendIntent(ctx, message) {
    if (!ctx || typeof ctx.sendText !== 'function') {
      throw new Error('no sendText in sidebar context');
    }
    return ctx.sendText(message);
  }

  // Stage beat for world-state / client actions (guarded — works standalone).
  function _stageIntent(ctx, partial) {
    var intent = {
      operatorId: ctx && ctx.operatorId,
      location: ctx && ctx.roomManifest && ctx.roomManifest.roomId,
      trigger: 'world-state',
    };
    if (partial) {
      for (var k in partial) intent[k] = partial[k];
    }
    if (vn.stage && typeof vn.stage.applyIntent === 'function') {
      try { vn.stage.applyIntent(intent); } catch (e) { /* presentational */ }
    }
    return intent;
  }

  function _navigate(target, params) {
    params = params || {};
    try {
      if (target === 'chat') {
        if (typeof root.loadSession === 'function' && params.sessionId) {
          root.loadSession(params.sessionId);
          return true;
        }
        return false;
      }
      if (typeof root.switchPanel === 'function') {
        root.switchPanel(target);
        return true;
      }
      if (typeof history !== 'undefined' && history.pushState) {
        history.pushState({}, '', params.url || ('#' + target));
        return true;
      }
    } catch (e) { /* guarded no-op */ }
    return false;
  }

  // ── Registry core ────────────────────────────────────────────────────────

  function register(entry) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) {
      throw new Error('registry entry needs a stable id');
    }
    if (typeof entry.when !== 'function' || typeof entry.run !== 'function') {
      throw new Error('registry entry ' + entry.id + ' needs when() and run()');
    }
    _registry[entry.id] = entry;
    return entry;
  }

  function get(id) { return _registry[id] || null; }

  function list() {
    var out = [];
    for (var id in _registry) out.push(_registry[id]);
    return out;
  }

  // Guarded availability evaluation — a throwing when() fails closed.
  function evaluate(id, ctx) {
    var entry = _registry[id];
    if (!entry) return { visible: false, enabled: false,
      reasonDisabled: 'unregistered action' };
    try {
      var avail = entry.when(ctx || {}) || {};
      return {
        visible: avail.visible !== false,
        enabled: avail.enabled !== false,
        reasonDisabled: avail.reasonDisabled,
      };
    } catch (e) {
      return { visible: false, enabled: false,
        reasonDisabled: 'availability error' };
    }
  }

  // Guarded execution: unregistered-id guard (one-time log), duplicate
  // execution lock, error → toast + issues entry, never throws.
  function run(id, ctx) {
    var entry = _registry[id];
    if (!entry) {
      if (!_warned[id]) {
        _warned[id] = true;
        _logIssue('vnActions: unregistered action id "' + id + '" dropped');
      }
      return Promise.resolve({ ok: false, reason: 'unregistered' });
    }
    if (_inFlight[id]) {
      return Promise.resolve({ ok: false, reason: 'in-flight' });
    }
    _inFlight[id] = true;
    return Promise.resolve()
      .then(function () { return entry.run(ctx || {}); })
      .then(function (result) {
        return { ok: true, result: result };
      })
      .catch(function (err) {
        var msg = 'action ' + id + ' failed: ' + (err && err.message || err);
        _issues.push(msg);
        _toast(msg);
        return { ok: false, reason: 'error', error: String(err && err.message || err) };
      })
      .then(function (outcome) {
        delete _inFlight[id];
        return outcome;
      });
  }

  // ── Static registry: Operator section (spec §3) ─────────────────────────

  register({
    id: 'op.talk',
    label: 'Talk',
    category: 'operator',
    icon: 'chat',
    action: { kind: 'hermes-intent', message: null }, // freeform focus
    when: function () { return { visible: true, enabled: true }; },
    run: function (ctx) {
      // Freeform: focus the composer when the host offers one; otherwise
      // open the conversation with a plain greeting message.
      if (ctx && typeof ctx.focusComposer === 'function') {
        ctx.focusComposer();
        return;
      }
      return _sendIntent(ctx, 'Hi — got a moment to talk?');
    },
  });

  register({
    id: 'op.ask-feeling',
    label: 'Ask how they’re feeling',
    category: 'operator',
    icon: 'heart',
    action: { kind: 'hermes-intent', message: 'How are you feeling right now?' },
    presentationHints: { preferredExpression: 'smile' },
    when: _notBusy,
    run: function (ctx) { return _sendIntent(ctx, this.action.message); },
  });

  register({
    id: 'op.ask-doing',
    label: 'Ask what they’re doing',
    category: 'operator',
    icon: 'wrench',
    action: { kind: 'hermes-intent', message: 'What are you working on?' },
    when: _notBusy,
    run: function (ctx) { return _sendIntent(ctx, this.action.message); },
  });

  register({
    id: 'op.offer-help',
    label: 'Offer help',
    category: 'operator',
    icon: 'hand',
    action: { kind: 'hermes-intent', message: 'Can I help with anything?' },
    when: function (ctx) {
      var type = _activityType(ctx);
      var relevant = type === 'tool-working' || type === 'background-working';
      return {
        visible: relevant,
        enabled: relevant && !(ctx && ctx.busy),
        reasonDisabled: ctx && ctx.busy ? 'Operator is busy' : undefined,
      };
    },
    run: function (ctx) { return _sendIntent(ctx, this.action.message); },
  });

  register({
    id: 'op.observe',
    label: 'Observe a moment',
    category: 'operator',
    icon: 'eye',
    action: { kind: 'client', fn: 'observe' },
    presentationHints: { preferredAction: 'ambient-beat' },
    when: function () { return { visible: true, enabled: true }; },
    run: function (ctx) {
      // Focus camera + ambient beat: explicit user request bypasses cooldown.
      if (essence.intents && typeof essence.intents.requestBeat === 'function') {
        essence.intents.requestBeat('observe');
      }
      _stageIntent(ctx, { framing: 'close', gazeIntent: 'user' });
    },
  });

  register({
    id: 'op.invite-elsewhere',
    label: 'Invite elsewhere',
    category: 'operator',
    icon: 'map',
    action: { kind: 'navigation', target: 'room-picker' },
    when: function (ctx) {
      var rooms = (ctx && ctx.rooms) || [];
      var visible = rooms.length >= 2;
      return { visible: visible, enabled: visible,
        reasonDisabled: visible ? undefined : 'Only one room available' };
    },
    run: function (ctx) {
      if (ctx && typeof ctx.showRoomPicker === 'function') {
        ctx.showRoomPicker();
        return;
      }
      if (!_shellState({ roomPicker: true })) {
        _toast('Room picker is not available on this surface');
      }
    },
  });

  register({
    id: 'op.fresh-conversation',
    label: 'Start fresh conversation',
    category: 'operator',
    icon: 'plus',
    action: { kind: 'tool', tool: 'hyrax.vn.new-session', args: {} },
    confirmation: { required: true,
      message: 'Start a fresh conversation? The current one stays in history.' },
    when: _notBusy,
    run: function (ctx) {
      // Existing VN conversation endpoint (server track); read path returns
      // the new session which the host may then load.
      return _api('/api/hyrax/vn/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile_id: ctx.operatorId, fresh: true }),
      }).then(function (payload) {
        var sid = payload && payload.conversation && payload.conversation.id;
        if (sid && typeof root.loadSession === 'function') root.loadSession(sid);
        return payload;
      });
    },
  });

  // ── Static registry: Work section (spec §3) ─────────────────────────────

  register({
    id: 'work.current-task',
    label: 'View current task',
    category: 'work',
    icon: 'kanban',
    action: { kind: 'tool', tool: 'kanban.read', args: {} },
    when: function (ctx) {
      var has = !!(ctx && ((ctx.tasks && ctx.tasks.length) ||
        (ctx.kanban && (ctx.kanban.running || ctx.kanban.blocked))));
      return { visible: has, enabled: true,
        reasonDisabled: has ? undefined : 'No tasks on the board' };
    },
    run: function (ctx) {
      // Read-only tool: kanban read through the existing endpoints.
      var url = '/api/kanban/tasks';
      if (ctx && ctx.operatorId) {
        url += '?assignee=' + encodeURIComponent(ctx.operatorId);
      }
      return _api(url).then(function (payload) {
        if (ctx && typeof ctx.showTaskCard === 'function') {
          ctx.showTaskCard(payload);
        }
        return payload;
      });
    },
  });

  register({
    id: 'work.open-issue',
    label: 'Open linked issue',
    category: 'work',
    icon: 'link',
    action: { kind: 'navigation', target: 'external' },
    when: function (ctx) {
      var ref = ctx && ctx.currentTask &&
        (ctx.currentTask.externalRef || ctx.currentTask.external_ref);
      return { visible: !!ref, enabled: !!ref,
        reasonDisabled: ref ? undefined : 'Task has no external ref' };
    },
    run: function (ctx) {
      var ref = ctx.currentTask.externalRef || ctx.currentTask.external_ref;
      if (typeof root.open === 'function') root.open(ref, '_blank');
      else _toast('Issue link: ' + ref);
    },
  });

  register({
    id: 'work.artifacts',
    label: 'Open artifacts',
    category: 'work',
    icon: 'folder',
    action: { kind: 'navigation', target: 'workspace',
      params: { panel: 'workspace' } },
    when: function (ctx) {
      var has = !!(ctx && ((ctx.artifacts && ctx.artifacts.length) ||
        ctx.artifactCount > 0));
      return { visible: has, enabled: true,
        reasonDisabled: has ? undefined : 'No artifacts yet' };
    },
    run: function () {
      if (!_navigate('workspace')) _toast('Workspace panel unavailable');
    },
  });

  register({
    id: 'work.approvals',
    label: 'Review approval',
    category: 'work',
    icon: 'shield',
    action: { kind: 'client', fn: 'openApprovals' },
    when: function (ctx) {
      var pending = !!(ctx && ctx.approvalPending);
      return { visible: pending, enabled: pending,
        reasonDisabled: pending ? undefined : 'No pending approvals' };
    },
    run: function (ctx) {
      if (ctx && typeof ctx.openApprovals === 'function') {
        ctx.openApprovals();
        return;
      }
      if (!_shellState({ approvals: true })) {
        _toast('Approval card unavailable');
      }
    },
  });

  register({
    id: 'work.delegate',
    label: 'Delegate follow-up',
    category: 'work',
    icon: 'delegate',
    action: { kind: 'hermes-intent',
      message: 'Delegate follow-up on the current task.' },
    when: function (ctx) {
      var active = !!(ctx && ctx.currentTask);
      var visible = active && !(ctx && ctx.busy);
      return { visible: visible, enabled: visible,
        reasonDisabled: !active ? 'No active task'
          : (ctx && ctx.busy ? 'Operator is busy' : undefined) };
    },
    run: function (ctx) {
      var title = ctx.currentTask && (ctx.currentTask.title || ctx.currentTask.id);
      var message = title
        ? 'Delegate follow-up on ' + title + '.'
        : this.action.message;
      return _sendIntent(ctx, message);
    },
  });

  // ── Static registry: System section (spec §3) ───────────────────────────

  register({
    id: 'sys.standard-chat',
    label: 'Open standard chat',
    category: 'system',
    icon: 'chat',
    action: { kind: 'navigation', target: 'chat' },
    when: function () { return { visible: true, enabled: true }; },
    run: function (ctx) {
      if (!_navigate('chat', { sessionId: ctx && ctx.sessionId })) {
        _toast('Standard chat unavailable for this session');
      }
    },
  });

  register({
    id: 'sys.tool-details',
    label: 'Tool details',
    category: 'system',
    icon: 'terminal',
    action: { kind: 'client', fn: 'openTechDrawer' },
    when: function () { return { visible: true, enabled: true }; },
    run: function (ctx) {
      if (ctx && typeof ctx.openTechDrawer === 'function') {
        ctx.openTechDrawer();
        return;
      }
      if (!_shellState({ techDrawer: true })) _toast('Tech drawer unavailable');
    },
  });

  register({
    id: 'sys.workspace',
    label: 'Workspace',
    category: 'system',
    icon: 'folder',
    action: { kind: 'navigation', target: 'workspace' },
    when: function () { return { visible: true, enabled: true }; },
    run: function () {
      if (!_navigate('workspace')) _toast('Workspace panel unavailable');
    },
  });

  register({
    id: 'sys.session-switch',
    label: 'Switch VN session',
    category: 'system',
    icon: 'sessions',
    action: { kind: 'client', fn: 'openSessionPicker' },
    when: function () { return { visible: true, enabled: true }; },
    run: function (ctx) {
      if (ctx && typeof ctx.showSessionPicker === 'function') {
        ctx.showSessionPicker();
        return;
      }
      if (!_shellState({ sessionPicker: true })) {
        _toast('Session picker unavailable');
      }
    },
  });

  register({
    id: 'sys.model-info',
    label: 'Model info',
    category: 'system',
    icon: 'chip',
    action: { kind: 'client', fn: 'showModelInfo' },
    when: function () { return { visible: true, enabled: true }; },
    run: function (ctx) {
      if (ctx && typeof ctx.showModelInfo === 'function') {
        ctx.showModelInfo();
        return;
      }
      if (!_shellState({ modelInfo: true })) _toast('Model info unavailable');
    },
  });

  register({
    id: 'sys.profile-settings',
    label: 'Profile settings',
    category: 'system',
    icon: 'settings',
    action: { kind: 'navigation', target: 'settings' },
    when: function () { return { visible: true, enabled: true }; },
    run: function () {
      if (!_navigate('settings')) _toast('Settings panel unavailable');
    },
  });

  // ── Room manifests (spec §6): loader + schema validation ─────────────────

  var _rooms = {}; // roomId -> validated manifest

  var ROOM_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
  var ROOM_ACTION_RE = /^room\.([a-z0-9][a-z0-9-]*)\.(inspect|ask|use)$/;

  // Fail closed: unknown fields tolerated, missing/invalid required fields
  // reject the manifest.
  function validateManifest(m) {
    var errors = [];
    if (!m || typeof m !== 'object') {
      return { ok: false, errors: ['manifest is not an object'] };
    }
    if (typeof m.roomId !== 'string' || !ROOM_ID_RE.test(m.roomId)) {
      errors.push('roomId must be a stable slug');
    }
    if (OPERATORS.indexOf(m.operatorId) === -1) {
      errors.push('operatorId must be one of ' + OPERATORS.join('/'));
    }
    if (typeof m.displayName !== 'string' || !m.displayName) {
      errors.push('displayName required');
    }
    if (!Array.isArray(m.backgroundFrameIds) ||
        !m.backgroundFrameIds.every(function (x) { return typeof x === 'string'; })) {
      errors.push('backgroundFrameIds must be a string array');
    }
    if (!Array.isArray(m.visibleObjectIds) ||
        !m.visibleObjectIds.every(function (x) { return typeof x === 'string'; })) {
      errors.push('visibleObjectIds must be a string array');
    }
    if (!Array.isArray(m.interactables) ||
        !m.interactables.every(function (x) { return typeof x === 'string'; })) {
      errors.push('interactables must be an array of registry id references');
    } else {
      m.interactables.forEach(function (id) {
        if (id === 'room.enter' || id === 'room.hq') return;
        if (!ROOM_ACTION_RE.test(id)) {
          errors.push('interactable "' + id + '" is not a room.<object>.<verb> id');
        }
      });
    }
    if (m.ambientState != null &&
        (typeof m.ambientState !== 'object' || Array.isArray(m.ambientState))) {
      errors.push('ambientState must be an object when present');
    }
    if (errors.length) return { ok: false, errors: errors };
    return { ok: true, errors: [], manifest: m };
  }

  // World-state mutation (manifest-local, v1) with optimistic revert.
  function _mutateAmbient(manifest, key, value) {
    var prev = manifest.ambientState ? manifest.ambientState[key] : undefined;
    if (!manifest.ambientState) manifest.ambientState = {};
    manifest.ambientState[key] = value;
    return function revert() {
      if (prev === undefined) delete manifest.ambientState[key];
      else manifest.ambientState[key] = prev;
    };
  }

  // Deterministic room interactables, generated from validated manifest ids
  // (code-owned templates; ids come from the manifest, never from a model).
  function registerRoomActions(manifest) {
    manifest.interactables.forEach(function (id) {
      if (id === 'room.enter') {
        register({
          id: 'room.enter',
          label: 'Enter room',
          category: 'environment',
          icon: 'door',
          action: { kind: 'navigation', target: 'vn' },
          when: function () { return { visible: true, enabled: true }; },
          run: function (ctx) {
            if (ctx && typeof ctx.enterRoom === 'function') {
              ctx.enterRoom(manifest.roomId);
              return;
            }
            _stageIntent(ctx, { location: manifest.roomId });
          },
        });
        return;
      }
      if (id === 'room.hq') {
        register({
          id: 'room.hq',
          label: 'Return to HQ',
          category: 'environment',
          icon: 'map',
          action: { kind: 'navigation', target: 'hq' },
          when: function () { return { visible: true, enabled: true }; },
          run: function () {
            if (!_navigate('hq')) _toast('HQ unavailable');
          },
        });
        return;
      }
      var match = id.match(ROOM_ACTION_RE);
      if (!match) return; // validation already rejected; defensive
      var objectId = match[1];
      var verb = match[2];
      var objectLabel = objectId.replace(/-/g, ' ');

      function inThisRoom(ctx) {
        var here = ctx && ctx.roomManifest &&
          ctx.roomManifest.roomId === manifest.roomId;
        return { visible: here, enabled: here,
          reasonDisabled: here ? undefined : 'Not in this room' };
      }

      if (verb === 'inspect') {
        register({
          id: id,
          label: 'Inspect ' + objectLabel,
          category: 'environment',
          icon: 'eye',
          action: { kind: 'world-state', objectId: objectId, op: 'focus' },
          presentationHints: { preferredSceneChange: 'focus' },
          when: inThisRoom,
          run: function (ctx) {
            var revert = _mutateAmbient(manifest, 'focus', objectId);
            try {
              _stageIntent(ctx, {
                framing: 'close',
                actionIntent: 'inspecting ' + objectLabel,
              });
              manifest.lastInspected = {
                objectId: objectId,
                description: manifest.displayName + ' — ' + objectLabel,
              };
            } catch (e) { revert(); throw e; }
          },
        });
      } else if (verb === 'ask') {
        register({
          id: id,
          label: 'Ask about ' + objectLabel,
          category: 'environment',
          icon: 'chat',
          action: { kind: 'hermes-intent',
            message: 'Tell me about ' + objectLabel + '.' },
          when: function (ctx) {
            var base = inThisRoom(ctx);
            if (base.visible && ctx && ctx.busy) {
              return { visible: true, enabled: false,
                reasonDisabled: 'Operator is busy' };
            }
            return base;
          },
          run: function (ctx) {
            return _sendIntent(ctx, this.action.message);
          },
        });
      } else if (verb === 'use') {
        register({
          id: id,
          label: 'Use ' + objectLabel,
          category: 'environment',
          icon: 'switch',
          action: { kind: 'world-state', objectId: objectId, op: 'toggle' },
          when: inThisRoom,
          run: function (ctx) {
            var current = manifest.ambientState &&
              manifest.ambientState[objectId];
            var next = current === 'on' ? 'off' : 'on';
            var revert = _mutateAmbient(manifest, objectId, next);
            var revertLighting = null;
            try {
              // Lamp-style objects drive the lighting field (spec §3).
              if (objectId === 'lamp') {
                revertLighting = _mutateAmbient(manifest, 'lighting',
                  next === 'on' ? 'warm' : 'dim');
              }
              _stageIntent(ctx, {
                actionIntent: 'using ' + objectLabel,
                lighting: manifest.ambientState.lighting,
              });
            } catch (e) {
              revert();
              if (revertLighting) revertLighting();
              throw e;
            }
          },
        });
      }
    });
  }

  function registerRoom(manifest) {
    var check = validateManifest(manifest);
    if (!check.ok) {
      _logIssue('vnRooms: invalid manifest rejected: ' + check.errors.join('; '));
      return check;
    }
    _rooms[manifest.roomId] = manifest;
    registerRoomActions(manifest);
    return check;
  }

  // Load + validate a manifest JSON; fail closed on fetch/parse/schema errors.
  function loadRoom(roomId, opts) {
    opts = opts || {};
    if (!ROOM_ID_RE.test(roomId || '')) {
      return Promise.resolve({ ok: false, errors: ['bad roomId'] });
    }
    var url = (opts.baseUrl || ROOMS_BASE_URL) + '/' + roomId + '.json';
    var fetchJson = typeof opts.fetchJson === 'function'
      ? opts.fetchJson : function (u) {
        if (typeof fetch !== 'function') {
          return Promise.reject(new Error('no fetch'));
        }
        return fetch(u).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        });
      };
    return fetchJson(url)
      .then(function (manifest) { return registerRoom(manifest); })
      .catch(function (err) {
        var msg = 'vnRooms: failed to load ' + roomId + ': ' +
          (err && err.message || err);
        _issues.push(msg);
        return { ok: false, errors: [msg] };
      });
  }

  vn.actions = {
    register: register,
    get: get,
    list: list,
    evaluate: evaluate,
    run: run,
    _issues: _issues,
    _inFlight: _inFlight,
  };

  vn.rooms = {
    validate: validateManifest,
    register: registerRoom,
    load: loadRoom,
    get: function (roomId) { return _rooms[roomId] || null; },
    list: function () {
      var out = [];
      for (var id in _rooms) out.push(_rooms[id]);
      return out;
    },
  };
})();
