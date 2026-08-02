/* essenceState.js — Gestalt VN Essence runtime (browser half): state assembly.
 *
 * Assembles OperatorEssenceState per docs/gestalt-vn/ESSENCE_RUNTIME_SPEC.md §1
 * from:
 *   - GET /api/hyrax/essence/{operator} (mood / energy / social / provenance / staleness)
 *   - vnEvents-derived activity (tool.started → tool-working,
 *     approval.requested → waiting-approval, done → conversing → idle decay)
 *   - deterministic time-of-day band
 * Confidence per §2. Fails closed: any endpoint failure degrades to static
 * defaults with provenance 'unknown' — never throws into consumers.
 *
 * Classic-script IIFE. Namespace: window.GestaltVN.essence.state
 */
(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : globalThis;
  var GestaltVN = root.GestaltVN = root.GestaltVN || {};
  var essence = GestaltVN.essence = GestaltVN.essence || {};

  // §2 source weights. `read` is scaled by staleness (0.9 → 0.4 over 7 days).
  var SOURCE_WEIGHT = {
    reported: 1.0,
    overridden: 1.0,
    read: 0.9,
    derived: 0.7,
    inferred: 0.4,
    unknown: 0.3,
  };
  var READ_STALENESS_FLOOR = 0.4;
  var READ_STALENESS_WINDOW_DAYS = 7;
  var IDLE_DECAY_MS = 60000;

  var ACTIVITY_TYPES = [
    'idle', 'conversing', 'tool-working', 'waiting-approval',
    'background-working', 'resting', 'offline',
  ];

  var DAY_MS = 24 * 60 * 60 * 1000;

  var _cache = {};        // operatorId -> OperatorEssenceState
  var _subscribers = [];  // fn(state)
  var _decayTimers = {};  // operatorId -> timer handle

  // ── Helpers ──────────────────────────────────────────────────────────────

  // Shared transport lives in vnEvents.js (GestaltVN.api) — it rejects with
  // an Error carrying .status + the parsed body payload on non-2xx. The
  // inline fallback only fires when that script was never loaded, and still
  // rejects on non-2xx so error bodies never land in success handlers.
  function _api(url, opts) {
    if (typeof GestaltVN.api === 'function') return GestaltVN.api(url, opts);
    if (typeof root.api === 'function') return root.api(url, opts);
    return fetch(url, opts).then(function(r) {
      if (!r.ok) {
        var err = new Error('HTTP ' + r.status);
        err.status = r.status;
        throw err;
      }
      return r.json();
    });
  }

  function _clamp(v, lo, hi) {
    v = Number(v);
    if (isNaN(v)) return lo;
    return Math.max(lo, Math.min(hi, v));
  }

  function _nowIso() {
    try { return new Date().toISOString(); } catch (e) { return ''; }
  }

  // Deterministic time-of-day band (spec §4): morning/day/evening/night.
  function timeOfDayBand(hour) {
    if (typeof hour !== 'number' || isNaN(hour)) {
      hour = new Date().getHours();
    }
    if (hour >= 5 && hour < 11) return 'morning';
    if (hour >= 11 && hour < 17) return 'day';
    if (hour >= 17 && hour < 22) return 'evening';
    return 'night';
  }

  function _stalenessDays(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (typeof payload.stalenessDays === 'number') return Math.max(0, payload.stalenessDays);
    if (payload.staleness && typeof payload.staleness.days === 'number') {
      return Math.max(0, payload.staleness.days);
    }
    var stamp = payload.updatedAt || payload.updated_at;
    if (typeof stamp === 'string' && stamp) {
      var t = Date.parse(stamp);
      if (!isNaN(t)) return Math.max(0, (Date.now() - t) / DAY_MS);
    }
    return null;
  }

  function _sourceWeight(source, stalenessDays) {
    var w = SOURCE_WEIGHT[source];
    if (typeof w !== 'number') w = SOURCE_WEIGHT.unknown;
    if (source === 'read' && typeof stalenessDays === 'number') {
      var decay = (stalenessDays / READ_STALENESS_WINDOW_DAYS) *
        (SOURCE_WEIGHT.read - READ_STALENESS_FLOOR);
      w = Math.max(READ_STALENESS_FLOOR, SOURCE_WEIGHT.read - decay);
    }
    return w;
  }

  // §2: mood.confidence is the weighted minimum of its inputs.
  function _moodConfidence(inputs, stalenessDays) {
    var min = null;
    for (var i = 0; i < inputs.length; i++) {
      var w = _sourceWeight(inputs[i], stalenessDays);
      if (min === null || w < min) min = w;
    }
    return min === null ? SOURCE_WEIGHT.unknown : min;
  }

  function _defaultState(operatorId) {
    return {
      operatorId: operatorId,
      mood: {
        primary: 'neutral',
        intensity: 0,
        confidence: SOURCE_WEIGHT.unknown,
      },
      condition: {},
      activity: {
        type: 'idle',
        interruptibility: 'free',
      },
      social: {},
      presentation: {
        expression: 'neutral',
        timeOfDay: timeOfDayBand(),
      },
      provenance: {
        'mood.primary': 'unknown',
        'condition': 'unknown',
        'activity': 'unknown',
        'social': 'unknown',
        'presentation.expression': 'unknown',
      },
      stalenessDays: null,
      stale: false,
      degraded: true,
      updatedAt: _nowIso(),
    };
  }

  // ── Assembly ─────────────────────────────────────────────────────────────

  function _assemble(operatorId, payload, prev) {
    var base = prev || _defaultState(operatorId);
    var stalenessDays = _stalenessDays(payload);
    var provenance = {};
    var key;
    var payloadProv = (payload && payload.provenance) || {};
    for (key in payloadProv) provenance[key] = payloadProv[key];

    var moodSrc = provenance['mood.primary'] || 'read';
    var moodInputs = [moodSrc];
    var mood = {
      primary: (payload.mood && payload.mood.primary) || (base.mood && base.mood.primary) || 'neutral',
      intensity: 0,
      confidence: 0,
    };
    if (payload.mood && typeof payload.mood.secondary === 'string') {
      mood.secondary = payload.mood.secondary;
      moodInputs.push(provenance['mood.secondary'] || 'derived');
    }
    if (payload.mood && typeof payload.mood.valence === 'number') {
      mood.valence = _clamp(payload.mood.valence, -1, 1);
      moodInputs.push(provenance['mood.valence'] || 'derived');
    }
    if (payload.mood && typeof payload.mood.arousal === 'number') {
      mood.arousal = _clamp(payload.mood.arousal, 0, 1);
      moodInputs.push(provenance['mood.arousal'] || 'derived');
    }
    mood.intensity = Math.max(
      Math.abs(typeof mood.valence === 'number' ? mood.valence : 0),
      typeof mood.arousal === 'number' ? mood.arousal : 0
    );
    mood.confidence = _moodConfidence(moodInputs, stalenessDays);
    if (!provenance['mood.primary']) provenance['mood.primary'] = moodSrc;

    var condition = {};
    if (payload.condition && typeof payload.condition === 'object') {
      for (key in payload.condition) condition[key] = payload.condition[key];
    } else {
      if (typeof payload.energy === 'number') condition.energy = _clamp(payload.energy, 0, 1);
    }
    if (typeof condition.energy === 'number') condition.energy = _clamp(condition.energy, 0, 1);
    if (!provenance['condition']) provenance['condition'] = condition.energy != null ? 'read' : 'unknown';

    var social = {};
    if (payload.social && typeof payload.social === 'object') {
      for (key in payload.social) social[key] = payload.social[key];
    }
    if (!provenance['social']) {
      provenance['social'] = Object.keys(social).length ? 'read' : 'unknown';
    }

    var presentation = (base && base.presentation) || {};
    var nextPresentation = {};
    for (key in presentation) nextPresentation[key] = presentation[key];
    if (payload.presentation && typeof payload.presentation === 'object') {
      for (key in payload.presentation) nextPresentation[key] = payload.presentation[key];
    }
    if (typeof payload.expression === 'string') nextPresentation.expression = payload.expression;
    if (typeof nextPresentation.expression !== 'string') nextPresentation.expression = 'neutral';
    nextPresentation.timeOfDay = timeOfDayBand();
    if (!provenance['presentation.expression']) {
      provenance['presentation.expression'] = 'read';
    }

    // Activity carries over from the event-driven track unless the payload
    // reports one explicitly.
    var activity = {};
    var prevActivity = (base && base.activity) || {};
    for (key in prevActivity) activity[key] = prevActivity[key];
    if (payload.activity && ACTIVITY_TYPES.indexOf(payload.activity.type) !== -1) {
      for (key in payload.activity) activity[key] = payload.activity[key];
      provenance['activity'] = 'reported';
    } else if (!provenance['activity']) {
      provenance['activity'] = 'derived';
    }
    if (ACTIVITY_TYPES.indexOf(activity.type) === -1) activity.type = 'idle';
    if (!activity.interruptibility) activity.interruptibility = 'free';

    return {
      operatorId: operatorId,
      sessionId: payload.sessionId || (base && base.sessionId),
      mood: mood,
      condition: condition,
      activity: activity,
      social: social,
      presentation: nextPresentation,
      provenance: provenance,
      stalenessDays: stalenessDays,
      stale: typeof stalenessDays === 'number' ? stalenessDays > 3 : false,
      degraded: false,
      updatedAt: _nowIso(),
    };
  }

  function _emit(state) {
    for (var i = 0; i < _subscribers.length; i++) {
      try { _subscribers[i](state); } catch (e) { /* subscriber errors isolated */ }
    }
  }

  function _derivedCondition(state) {
    // §1 condition.focus: derived from streaming/tool activity now.
    var type = state.activity.type;
    state.condition.focus = (type === 'tool-working' || type === 'conversing' ||
      type === 'background-working') ? 0.8 : 0.3;
    state.provenance['condition.focus'] = 'derived';
  }

  function _setActivity(operatorId, type, description, interruptibility) {
    var state = _cache[operatorId] || _defaultState(operatorId);
    state.activity = {
      type: type,
      interruptibility: interruptibility || 'free',
    };
    if (description) state.activity.description = description;
    state.provenance['activity'] = 'reported';
    _derivedCondition(state);
    state.updatedAt = _nowIso();
    _cache[operatorId] = state;
    _emit(state);
    return state;
  }

  function _scheduleIdleDecay(operatorId) {
    if (_decayTimers[operatorId]) {
      clearTimeout(_decayTimers[operatorId]);
      _decayTimers[operatorId] = null;
    }
    _decayTimers[operatorId] = setTimeout(function () {
      _decayTimers[operatorId] = null;
      var state = _cache[operatorId];
      if (!state) return;
      if (state.activity.type === 'conversing') {
        _setActivity(operatorId, 'idle', null, 'free');
      }
    }, IDLE_DECAY_MS);
  }

  // vnEvents → activity mapping (task contract).
  function handleEvent(event) {
    if (!event || !event.operatorId) return null;
    var operatorId = event.operatorId;
    var payload = event.payload || {};
    switch (event.kind) {
      case 'tool.started':
        return _setActivity(operatorId, 'tool-working',
          payload.tool || payload.name || payload.title, 'busy');
      case 'tool.failed': {
        var st = _setActivity(operatorId, 'conversing', null, 'soft-busy');
        st.condition.stress = _clamp((st.condition.stress || 0) + 0.2, 0, 1);
        st.provenance['condition.stress'] = 'derived';
        _scheduleIdleDecay(operatorId);
        return st;
      }
      case 'tool.completed':
        _scheduleIdleDecay(operatorId);
        return _setActivity(operatorId, 'conversing', null, 'soft-busy');
      case 'approval.requested':
        return _setActivity(operatorId, 'waiting-approval',
          payload.tool || payload.name, 'free');
      case 'approval.resolved':
      case 'clarify.resolved':
        _scheduleIdleDecay(operatorId);
        return _setActivity(operatorId, 'conversing', null, 'soft-busy');
      case 'user.message':
      case 'response.started':
        return _setActivity(operatorId, 'conversing', null, 'soft-busy');
      case 'response.completed':
        _scheduleIdleDecay(operatorId);
        return _setActivity(operatorId, 'conversing', null, 'soft-busy');
      case 'response.failed':
      case 'interruption':
        return _setActivity(operatorId, 'idle', null, 'free');
      case 'disconnect':
        return _setActivity(operatorId, 'offline', null, 'unavailable');
      case 'reconnect':
        refresh(operatorId);
        return _cache[operatorId] || null;
      case 'activity.changed':
        if (payload && ACTIVITY_TYPES.indexOf(payload.type) !== -1) {
          return _setActivity(operatorId, payload.type,
            payload.description, payload.interruptibility);
        }
        return null;
      default:
        return null;
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────

  function get(operatorId) {
    if (!operatorId) return null;
    if (!_cache[operatorId]) _cache[operatorId] = _defaultState(operatorId);
    return _cache[operatorId];
  }

  // Fail closed: endpoint failure keeps cached state or static defaults.
  function refresh(operatorId) {
    if (!operatorId) return Promise.resolve(null);
    return _api('/api/hyrax/essence/' + encodeURIComponent(operatorId))
      .then(function (payload) {
        var state = _assemble(operatorId, payload || {}, _cache[operatorId]);
        _derivedCondition(state);
        _cache[operatorId] = state;
        _emit(state);
        return state;
      })
      .catch(function () {
        var state = _cache[operatorId] || _defaultState(operatorId);
        state.degraded = true;
        _cache[operatorId] = state;
        _emit(state);
        return state;
      });
  }

  // Local presentation override (client-owned, e.g. sidebar pose actions).
  // Only non-empty string fields patch through; every other key is ignored.
  // Emits like any other mutation so intents/sidebar re-evaluate against the
  // new presentation; server refreshes merge OVER it only when the payload
  // carries the same keys (the override is sticky otherwise).
  function setPresentation(operatorId, patch) {
    if (!operatorId || !patch || typeof patch !== 'object') return null;
    var state = _cache[operatorId] || _defaultState(operatorId);
    var presentation = {};
    var key;
    for (key in state.presentation) presentation[key] = state.presentation[key];
    for (key in patch) {
      if (typeof patch[key] === 'string' && patch[key]) {
        presentation[key] = patch[key];
      }
    }
    state.presentation = presentation;
    state.updatedAt = _nowIso();
    _cache[operatorId] = state;
    _emit(state);
    return state;
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return function () {};
    _subscribers.push(fn);
    return function unsubscribe() {
      var idx = _subscribers.indexOf(fn);
      if (idx !== -1) _subscribers.splice(idx, 1);
    };
  }

  function dispose(operatorId) {
    if (_decayTimers[operatorId]) {
      clearTimeout(_decayTimers[operatorId]);
      delete _decayTimers[operatorId];
    }
    delete _cache[operatorId];
  }

  essence.state = {
    get: get,
    refresh: refresh,
    setPresentation: setPresentation,
    subscribe: subscribe,
    handleEvent: handleEvent,
    dispose: dispose,
    timeOfDayBand: timeOfDayBand,
    SOURCE_WEIGHT: SOURCE_WEIGHT,
    ACTIVITY_TYPES: ACTIVITY_TYPES,
  };
})();
