/* essenceIntents.js — Gestalt VN Essence runtime (browser half): presentation
 * intent production.
 *
 * Subscribes to vnEvents (GestaltVN.events, when present — hooked lazily on
 * init, never polled), evaluates meaningful changes per
 * docs/gestalt-vn/ESSENCE_RUNTIME_SPEC.md §5 (valid/invalid triggers, 400 ms
 * debounce, 4 s cooldown, reset/explicit-request bypass) and produces
 * OperatorPresentationIntent objects (GESTALT_VN_API_CONTRACTS §2).
 *
 * Personality tables per sister are inline (tai: bright/playful; rei: dry,
 * evidence-first; nei: quiet; mai: composed chaos). Expressions are mapped to
 * the per-sister canonical enum (§6); unknown names fall back to the sister's
 * neutral with an issues[] entry.
 *
 * Classic-script IIFE. Namespace: window.GestaltVN.essence.intents
 */
(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : globalThis;
  var GestaltVN = root.GestaltVN = root.GestaltVN || {};
  var essence = GestaltVN.essence = GestaltVN.essence || {};

  var DEBOUNCE_MS = 400;      // §5 debounce
  var COOLDOWN_MS = 4000;     // §5 cooldown between frame transitions
  var MOOD_TRIGGER_FLOOR = 0.5; // §5: low-confidence mood fluctuation invalid

  // §6 per-sister canonical expression enum + personality beat tables.
  var SISTERS = {
    tai: {
      // bright, playful
      enum: ['neutral', 'smile', 'happy-emote', 'sarcastic', 'focused'],
      idle: 'neutral', conversing: 'smile', working: 'focused',
      approval: 'focused', completion: 'happy-emote', failure: 'sarcastic',
      tone: 'bright',
    },
    rei: {
      // dry, evidence-first
      enum: ['neutral', 'calm', 'alert'],
      idle: 'neutral', conversing: 'calm', working: 'alert',
      approval: 'alert', completion: 'calm', failure: 'alert',
      tone: 'dry',
    },
    nei: {
      // quiet
      enum: ['neutral', 'observant', 'thinking'],
      idle: 'neutral', conversing: 'observant', working: 'thinking',
      approval: 'observant', completion: 'observant', failure: 'thinking',
      tone: 'quiet',
    },
    mai: {
      // composed chaos
      enum: ['neutral', 'smile', 'laughing', 'light-smile', 'ohhoai',
        'shy-smile', 'scream-of-fury', 'yandere-smile', 'sarcastic', 'focused'],
      idle: 'neutral', conversing: 'smile', working: 'focused',
      approval: 'light-smile', completion: 'laughing', failure: 'ohhoai',
      tone: 'composed-chaos',
    },
  };

  // §5 invalid trigger event kinds — never produce an intent on their own.
  var INVALID_EVENT_KINDS = {
    'response.token': true,
    'reasoning.delta': true,
    'tool.progress': true,       // progress within same activity type
    'metering.update': true,
    'context.status': true,
  };

  var _operatorId = null;
  var _subscribers = [];
  var _issues = [];
  var _eventsUnsub = null;
  var _stateUnsub = null;
  var _debounceTimer = null;
  var _cooldownTimer = null;
  var _lastEmitAt = 0;
  var _pendingBeat = null;      // trailing intent held by cooldown
  var _lastTriggers = null;     // last emitted trigger snapshot
  var _lastIntentKey = null;    // duplicate-intent suppression
  var _beatSeq = 0;
  var _continuityToken = null;

  function _now() { return Date.now(); }

  function _table(operatorId) {
    return SISTERS[operatorId] || SISTERS.tai;
  }

  // §6 enum normalization: unknown mapped names → sister neutral + issue.
  function normalizeExpression(operatorId, raw) {
    var table = _table(operatorId);
    var expr = typeof raw === 'string' ? raw.toLowerCase().trim() : '';
    if (table.enum.indexOf(expr) !== -1) return { expression: expr, issue: null };
    var issue = 'unknown expression "' + (raw || '') + '" mapped to neutral';
    _issues.push(issue);
    return { expression: 'neutral', issue: issue };
  }

  function _poseForActivity(type) {
    switch (type) {
      case 'tool-working':
      case 'background-working': return 'working';
      case 'conversing': return 'standing';
      case 'waiting-approval': return 'standing';
      case 'resting': return 'sitting';
      default: return 'idle';
    }
  }

  function _gazeForActivity(type) {
    switch (type) {
      case 'conversing':
      case 'waiting-approval': return 'user';
      case 'tool-working':
      case 'background-working': return 'workstation';
      default: return 'away';
    }
  }

  function _triggerSnapshot(state) {
    var presentation = state.presentation || {};
    var framesApi = essence.frames;
    return {
      expressionFamily: framesApi
        ? framesApi.expressionFamily(presentation.expression) : 'neutral',
      poseFamily: framesApi
        ? framesApi.poseFamily(presentation.pose) : 'standing',
      location: presentation.location || '',
      wardrobe: presentation.wardrobe || '',
      framing: presentation.framing || 'medium',
      activityType: (state.activity && state.activity.type) || 'idle',
    };
  }

  function _triggersEqual(a, b) {
    if (!a || !b) return false;
    return a.expressionFamily === b.expressionFamily &&
      a.poseFamily === b.poseFamily &&
      a.location === b.location &&
      a.wardrobe === b.wardrobe &&
      a.framing === b.framing &&
      a.activityType === b.activityType;
  }

  // Build the OperatorPresentationIntent for a beat. Beats scale intensity by
  // mood.confidence (§3: no rigid 1:1 rules; failure beats stay small).
  function _buildIntent(state, beat, issues) {
    var table = _table(state.operatorId);
    var mood = state.mood || { primary: 'neutral', confidence: 0.3, intensity: 0 };
    var activity = state.activity || { type: 'idle' };
    var confidence = typeof mood.confidence === 'number' ? mood.confidence : 0.3;

    var exprKey;
    var intensity;
    switch (beat) {
      case 'failure':
        exprKey = table.failure;
        // small, confidence-scaled — never a full emotional swing on a
        // transient tool error
        intensity = 0.2 + 0.3 * confidence;
        break;
      case 'approval':
        exprKey = table.approval;
        intensity = 0.4 + 0.3 * confidence;
        break;
      case 'completion':
        exprKey = table.completion;
        intensity = 0.35 + 0.35 * confidence;
        break;
      default:
        // Prefer the state's own presentation expression (mood-driven,
        // §6-normalized below); activity table is the fallback.
        if (state.presentation && state.presentation.expression) {
          exprKey = state.presentation.expression;
        } else if (activity.type === 'tool-working' ||
            activity.type === 'background-working') exprKey = table.working;
        else if (activity.type === 'conversing' ||
                 activity.type === 'waiting-approval') exprKey = table.conversing;
        else exprKey = table.idle;
        intensity = Math.max(0.2, Math.min(1, mood.intensity || 0.3));
    }

    var normalized = normalizeExpression(state.operatorId, exprKey);
    if (normalized.issue && issues) issues.push(normalized.issue);

    return {
      operatorId: state.operatorId,
      emotionalTone: mood.primary || table.tone,
      expressionIntent: normalized.expression,
      actionIntent: activity.description || null,
      // Explicit presentation pose (user action / server) wins over the
      // activity-derived pose, so a chosen pose survives expression beats —
      // pose and expression stay independent dimensions.
      poseIntent: (state.presentation && state.presentation.pose) ||
        _poseForActivity(activity.type),
      gazeIntent: _gazeForActivity(activity.type),
      intensity: Math.round(intensity * 100) / 100,
      location: (state.presentation && state.presentation.location) || null,
      wardrobe: (state.presentation && state.presentation.wardrobe) || null,
      framing: (state.presentation && state.presentation.framing) || 'medium',
      continuityToken: _continuityToken,
      trigger: beat || 'state',
      issues: issues && issues.length ? issues.slice() : undefined,
    };
  }

  function _intentKey(intent) {
    return [intent.expressionIntent, intent.poseIntent, intent.location,
      intent.framing, intent.gazeIntent].join('|');
  }

  function _emit(intent, triggers) {
    _lastEmitAt = _now();
    _lastTriggers = triggers;
    _lastIntentKey = _intentKey(intent);
    for (var i = 0; i < _subscribers.length; i++) {
      try { _subscribers[i](intent); } catch (e) { /* isolated */ }
    }
  }

  // Cooldown gate. Returns true when the intent may leave now; otherwise the
  // intent is held as a trailing emission at cooldown expiry (unless bypass).
  function _gateEmit(intent, triggers, bypass) {
    if (bypass) {
      if (_cooldownTimer) { clearTimeout(_cooldownTimer); _cooldownTimer = null; }
      _pendingBeat = null;
      _emit(intent, triggers);
      return true;
    }
    var elapsed = _now() - _lastEmitAt;
    if (elapsed >= COOLDOWN_MS) {
      _emit(intent, triggers);
      return true;
    }
    // Cooldown active: coalesce to one trailing emission.
    _pendingBeat = { intent: intent, triggers: triggers };
    if (!_cooldownTimer) {
      _cooldownTimer = setTimeout(function () {
        _cooldownTimer = null;
        var held = _pendingBeat;
        _pendingBeat = null;
        if (held) _emit(held.intent, held.triggers);
      }, COOLDOWN_MS - elapsed);
    }
    return false;
  }

  // Core evaluation: given the current essence state and an optional beat,
  // decide whether a presentation intent is meaningful (§5) and emit it.
  function evaluate(state, opts) {
    opts = opts || {};
    if (!state || !state.operatorId) return null;
    var triggers = _triggerSnapshot(state);
    var beat = opts.beat || null;
    var explicit = !!opts.explicit;

    // §5 valid triggers: expression-family / location / wardrobe /
    // activity-type / framing change, scene entry, explicit user request.
    var changed = !_triggersEqual(triggers, _lastTriggers);
    var sceneEntry = !!opts.sceneEntry;

    // §5 invalid: low-confidence mood fluctuation alone never triggers.
    if (!beat && !sceneEntry && !explicit) {
      if (!changed) return null; // duplicate / conversational noise
      var moodOnly = _lastTriggers &&
        triggers.activityType === _lastTriggers.activityType &&
        triggers.location === _lastTriggers.location &&
        triggers.wardrobe === _lastTriggers.wardrobe &&
        triggers.framing === _lastTriggers.framing &&
        triggers.expressionFamily !== _lastTriggers.expressionFamily;
      if (moodOnly) {
        var confidence = state.mood && typeof state.mood.confidence === 'number'
          ? state.mood.confidence : 0;
        if (confidence < MOOD_TRIGGER_FLOOR) return null;
      }
    }

    // A beat that does not move any trigger field and duplicates the last
    // intent is still meaningful (it carries a new expression), but a repeated
    // identical beat is a duplicate intent — drop it.
    var issues = [];
    var intent = _buildIntent(state, beat, issues);
    if (_lastIntentKey && _intentKey(intent) === _lastIntentKey &&
        !explicit && !sceneEntry) {
      _lastTriggers = triggers; // still advance the snapshot
      return null;
    }

    var bypass = explicit || sceneEntry;
    _gateEmit(intent, triggers, bypass);
    return intent;
  }

  // Debounced entry point for event-driven evaluation (§5: 400 ms coalescing).
  function _scheduleEvaluation(beat) {
    if (_debounceTimer) clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(function () {
      _debounceTimer = null;
      var state = essence.state && _operatorId
        ? essence.state.get(_operatorId) : null;
      if (state) evaluate(state, { beat: beat });
    }, DEBOUNCE_MS);
  }

  // ── vnEvents wiring (lazy, poll-less) ────────────────────────────────────

  function _onEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (_operatorId && event.operatorId && event.operatorId !== _operatorId) {
      return;
    }
    // §5 invalid triggers never reach evaluation.
    if (INVALID_EVENT_KINDS[event.kind]) return;

    // Feed the activity track first; intents read the assembled state.
    if (essence.state) essence.state.handleEvent(event);

    switch (event.kind) {
      case 'tool.failed':
        _scheduleEvaluation('failure');
        break;
      case 'approval.requested':
        _scheduleEvaluation('approval');
        break;
      case 'tool.completed':
      case 'response.completed':
        _scheduleEvaluation('completion');
        break;
      default:
        // activity-type changes (tool.started, user.message, approval.resolved,
        // reconnect, …) land here and are judged against the trigger snapshot.
        _scheduleEvaluation(null);
    }
  }

  function _tryHookEvents() {
    if (_eventsUnsub) return true;
    var events = GestaltVN.events;
    if (events && typeof events.subscribe === 'function') {
      try {
        _eventsUnsub = events.subscribe('*', _onEvent);
        return true;
      } catch (e) { /* degrade: run without the bus */ }
    }
    return false;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  function init(opts) {
    opts = opts || {};
    _operatorId = opts.operatorId || _operatorId;
    _lastTriggers = null;
    _lastIntentKey = null;
    _beatSeq = 0;
    _continuityToken = (_operatorId || 'op') + '-beat-0';
    _tryHookEvents();
    if (!_stateUnsub && essence.state && typeof essence.state.subscribe === 'function') {
      _stateUnsub = essence.state.subscribe(function (state) {
        if (!_operatorId || state.operatorId !== _operatorId) return;
        // Refresh-driven changes (mood/location/wardrobe from the server)
        // are judged by the same trigger snapshot.
        evaluate(state, {});
      });
    }
    // Scene entry is a valid trigger and bypasses cooldown.
    var state = essence.state && _operatorId
      ? essence.state.get(_operatorId) : null;
    if (state) {
      _beatSeq += 1;
      _continuityToken = _operatorId + '-beat-' + _beatSeq;
      evaluate(state, { sceneEntry: true });
    }
  }

  // Explicit user request (e.g. sidebar op.observe) — bypasses cooldown.
  function requestBeat(beat) {
    _tryHookEvents();
    var state = essence.state && _operatorId
      ? essence.state.get(_operatorId) : null;
    if (!state) return null;
    return evaluate(state, { beat: beat || null, explicit: true });
  }

  // Reset bypass (§5): clears debounce/cooldown and forces a fresh scene beat.
  function reset() {
    if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
    if (_cooldownTimer) { clearTimeout(_cooldownTimer); _cooldownTimer = null; }
    _pendingBeat = null;
    _lastEmitAt = 0;
    _lastTriggers = null;
    _lastIntentKey = null;
    _beatSeq += 1;
    _continuityToken = (_operatorId || 'op') + '-beat-' + _beatSeq;
    var state = essence.state && _operatorId
      ? essence.state.get(_operatorId) : null;
    if (state) evaluate(state, { sceneEntry: true });
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return function () {};
    _subscribers.push(fn);
    return function unsubscribe() {
      var idx = _subscribers.indexOf(fn);
      if (idx !== -1) _subscribers.splice(idx, 1);
    };
  }

  // Test/tuning hook — thresholds are spec constants at runtime.
  function configure(opts) {
    opts = opts || {};
    if (typeof opts.debounceMs === 'number') DEBOUNCE_MS = opts.debounceMs;
    if (typeof opts.cooldownMs === 'number') COOLDOWN_MS = opts.cooldownMs;
  }

  function dispose() {
    if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
    if (_cooldownTimer) { clearTimeout(_cooldownTimer); _cooldownTimer = null; }
    if (_eventsUnsub) { try { _eventsUnsub(); } catch (e) {} _eventsUnsub = null; }
    if (_stateUnsub) { try { _stateUnsub(); } catch (e) {} _stateUnsub = null; }
    _pendingBeat = null;
    _lastTriggers = null;
    _lastIntentKey = null;
    _subscribers = [];
    _operatorId = null;
  }

  essence.intents = {
    init: init,
    evaluate: evaluate,
    requestBeat: requestBeat,
    reset: reset,
    subscribe: subscribe,
    configure: configure,
    dispose: dispose,
    normalizeExpression: normalizeExpression,
    SISTERS: SISTERS,
    DEBOUNCE_MS: DEBOUNCE_MS,
    COOLDOWN_MS: COOLDOWN_MS,
    _issues: _issues,
    // Direct event injection for hosts without a bus (and tests).
    handleEvent: _onEvent,
  };
})();
