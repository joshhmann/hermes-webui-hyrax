/* essenceFrames.js — Gestalt VN Essence runtime (browser half): frame registry,
 * scene signatures, ranking, L2 cache, fallback ladder.
 *
 * Spec: docs/gestalt-vn/ESSENCE_RUNTIME_SPEC.md §4 (signatures + selection),
 * §7 (registry), GESTALT_VN_ARCHITECTURE.md §6 (two-layer cache).
 *
 * Classic-script IIFE. Namespace: window.GestaltVN.essence.frames
 */
(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : globalThis;
  var GestaltVN = root.GestaltVN = root.GestaltVN || {};
  var essence = GestaltVN.essence = GestaltVN.essence || {};

  var CONFIDENCE_FLOOR = 0.6;       // §4 step 3: non-exact reuse floor
  var L2_CACHE_MAX = 8;             // architecture §6: ≤8 frames per operator
  var OPERATORS = ['tai', 'rei', 'nei', 'mai'];

  // §6 sister enums (canonical enum lives server-side; mirrored here for
  // family mapping only — never used to invent expressions).
  var EXPRESSION_FAMILY = {
    'neutral': 'neutral',
    'calm': 'neutral',
    'smile': 'positive',
    'happy-emote': 'positive',
    'laughing': 'positive',
    'light-smile': 'positive',
    'shy-smile': 'positive',
    'sarcastic': 'wry',
    'ohhoai': 'wry',
    'focused': 'focused',
    'alert': 'focused',
    'observant': 'focused',
    'thinking': 'focused',
    'scream-of-fury': 'intense',
    'yandere-smile': 'intense',
  };

  var POSE_FAMILY = {
    'standing': 'standing',
    'idle': 'standing',
    'sitting': 'sitting',
    'working': 'working',
    'gesturing': 'gesture',
  };

  // Known authored asset ids (hyrax-assets/vn/ASSET_MANIFEST.json, 29 assets).
  // Generic fallback ladder rung: plain portraits served through the existing
  // /api/hyrax/assets/ allowlist machinery.
  var GENERIC_PORTRAIT_IDS = {
    tai: ['tai.portrait.neutral', 'tai.portrait.smile', 'tai.portrait.focused',
      'tai.portrait.happy-emote', 'tai.portrait.sarcastic'],
    rei: ['rei.portrait.neutral', 'rei.portrait.calm', 'rei.portrait.alert'],
    nei: ['nei.portrait.neutral', 'nei.portrait.observant', 'nei.portrait.thinking'],
    mai: ['mai.portrait.neutral', 'mai.portrait.smile', 'mai.portrait.light-smile',
      'mai.portrait.laughing', 'mai.portrait.ohhoai', 'mai.portrait.shy-smile',
      'mai.portrait.sarcastic', 'mai.portrait.focused',
      'mai.portrait.scream-of-fury', 'mai.portrait.yandere-smile',
      'mai.portrait.observant'],
  };

  var OPERATOR_BACKGROUND_IDS = {
    tai: 'tai.background.control-room',
    rei: 'rei.background.security',
    nei: 'nei.background.lab',
    mai: 'mai.background.supply-hub',
  };

  // L2 browser memory cache (architecture §6): per operator, registry frames
  // plus the ≤8 most-recently-used set.
  var _registry = {};        // operatorId -> {loaded, loading, frames[]}
  var _lru = {};             // operatorId -> [frameId, ...] (most recent last)
  var _currentSignature = {}; // operatorId -> last applied signature
  var _currentFrame = {};    // operatorId -> last applied frame

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

  function _norm(v) {
    if (v == null) return '';
    return String(v).toLowerCase().trim();
  }

  // FNV-1a 32-bit — small, deterministic, stable across sessions.
  function _hash(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  function expressionFamily(expression) {
    return EXPRESSION_FAMILY[_norm(expression)] || 'neutral';
  }

  function poseFamily(pose) {
    return POSE_FAMILY[_norm(pose)] || 'standing';
  }

  function timeOfDayBand(input) {
    if (input === 'morning' || input === 'day' ||
        input === 'evening' || input === 'night') return input;
    var hour = typeof input === 'number' ? input : new Date().getHours();
    if (hour >= 5 && hour < 11) return 'morning';
    if (hour >= 11 && hour < 17) return 'day';
    if (hour >= 17 && hour < 22) return 'evening';
    return 'night';
  }

  // ── §4 scene signature — coarse fields ONLY ──────────────────────────────
  // operatorId · location · wardrobe · expressionFamily · poseFamily
  // · timeOfDayBand(morning/day/evening/night) · framing · majorProps[≤3]
  //
  // Explicitly excluded: conversational content, exact timestamps, minor mood
  // drift (same-family expression swaps), tool names, streamed progress.
  function computeSceneSignature(coarse) {
    coarse = coarse || {};
    var props = Array.isArray(coarse.props) ? coarse.props.slice(0, 3) : [];
    props = props.map(_norm).sort();
    var fields = [
      _norm(coarse.operatorId),
      _norm(coarse.location),
      _norm(coarse.wardrobe),
      _norm(coarse.expressionFamily || expressionFamily(coarse.expression)),
      _norm(coarse.poseFamily || poseFamily(coarse.pose)),
      // Band used only when explicitly set — band-less scenes stay band-less
      // so the registry is stable across hours (matches the server side).
      _norm(coarse.timeOfDay),
      _norm(coarse.framing || 'medium'),
      props.join(','),
    ];
    return _hash(fields.join('|'));
  }

  function _coarseFromIntent(intent, essenceState) {
    intent = intent || {};
    var presentation = (essenceState && essenceState.presentation) || {};
    return {
      operatorId: intent.operatorId || (essenceState && essenceState.operatorId),
      location: intent.location || presentation.location,
      wardrobe: intent.wardrobe || presentation.wardrobe,
      expression: intent.expressionIntent || presentation.expression,
      pose: intent.poseIntent || presentation.pose,
      timeOfDay: presentation.timeOfDay,
      framing: intent.framing || presentation.framing,
      props: intent.props || presentation.props,
    };
  }

  // ── Registry loading (L1) ────────────────────────────────────────────────

  // Fail closed: a registry fetch failure yields an empty frame list, which
  // pushes selection straight down the fallback ladder.
  function load(operatorId, force) {
    if (!operatorId) return Promise.resolve([]);
    var entry = _registry[operatorId];
    if (entry && entry.loaded && !force) return Promise.resolve(entry.frames);
    if (entry && entry.loading && !force) return entry.loading;
    var url = '/api/hyrax/essence/frames?operator=' + encodeURIComponent(operatorId);
    var loading = _api(url).then(function (payload) {
      var frames = [];
      if (payload) {
        if (Array.isArray(payload.frames)) frames = payload.frames;
        else if (Array.isArray(payload.items)) frames = payload.items;
        else if (Array.isArray(payload)) frames = payload;
      }
      // Defensive scoping: the frame layer is per-operator. The server may
      // return the whole registry — selection must never cross sisters
      // (QA: nei's stage picked mai's frame when unfiltered).
      frames = frames.filter(function (f) {
        return f && f.operatorId === operatorId;
      });
      _registry[operatorId] = { loaded: true, loading: null, frames: frames };
      return frames;
    }).catch(function () {
      _registry[operatorId] = { loaded: true, loading: null, frames: [] };
      return [];
    });
    _registry[operatorId] = { loaded: false, loading: loading, frames: [] };
    return loading;
  }

  function _noteUsed(operatorId, frame) {
    if (!frame || !frame.id) return;
    var list = _lru[operatorId] = _lru[operatorId] || [];
    var idx = list.indexOf(frame.id);
    if (idx !== -1) list.splice(idx, 1);
    list.push(frame.id);
    while (list.length > L2_CACHE_MAX) list.shift();
  }

  // Record an applied frame so the next identical signature is a no-op
  // (§4 step 1).
  function noteApplied(operatorId, frame, signature) {
    if (!operatorId) return;
    _currentFrame[operatorId] = frame || null;
    _currentSignature[operatorId] = signature ||
      (frame && frame.sceneSignature) || null;
    if (frame) _noteUsed(operatorId, frame);
  }

  // ── Generic fallback portraits ───────────────────────────────────────────

  function genericPortraitUrls(operatorId) {
    var ids = GENERIC_PORTRAIT_IDS[operatorId] || [];
    return ids.map(function (id) { return '/api/hyrax/assets/' + id; });
  }

  function genericFrameFor(operatorId, expression) {
    var ids = GENERIC_PORTRAIT_IDS[operatorId] || [];
    if (!ids.length) return null;
    var wanted = _norm(expression);
    var pick = ids[0];
    for (var i = 0; i < ids.length; i++) {
      if (ids[i].split('.').pop() === wanted) { pick = ids[i]; break; }
    }
    return {
      id: 'generic.' + pick,
      operatorId: operatorId,
      version: 'generic',
      source: 'fallback',
      sceneSignature: '',
      state: { expression: pick.split('.').pop() },
      assets: { imageUrl: '/api/hyrax/assets/' + pick },
      quality: { approved: true },
      continuity: {},
    };
  }

  // ── §4 selection ─────────────────────────────────────────────────────────

  function _approved(frame) {
    return !!(frame && frame.quality && frame.quality.approved === true);
  }

  function _qualityScore(frame) {
    var s = frame && frame.quality && frame.quality.score;
    return typeof s === 'number' ? s : 1.0;
  }

  // Continuity preference inside a tier (§4 step 2, §10): same wardrobe /
  // location held constant, explicit prior-frame link first.
  function _preferContinuity(candidates, coarse, currentFrame) {
    if (!candidates.length) return null;
    var scored = candidates.map(function (frame) {
      var score = 0;
      var st = frame.state || {};
      if (currentFrame && frame.continuity &&
          frame.continuity.priorFrameId === currentFrame.id) score += 4;
      if (coarse.wardrobe && _norm(st.wardrobe) === _norm(coarse.wardrobe)) score += 2;
      if (coarse.pose && _norm(st.pose) === _norm(coarse.pose)) score += 2;
      if (coarse.location && _norm(st.location) === _norm(coarse.location)) score += 1;
      return { frame: frame, score: score };
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored[0].frame;
  }

  function _result(frame, match, confidence, reason, signature, noOp) {
    return {
      frame: frame || null,
      match: match,
      confidence: confidence,
      reason: reason,
      sceneSignature: signature,
      noOp: !!noOp,
    };
  }

  // Ranking: exact > same-location > expression-family > operator-default >
  // generic, with the 0.6 confidence floor on non-exact registry reuse.
  function selectFrame(intent, opts) {
    opts = opts || {};
    var operatorId = intent && intent.operatorId;
    if (!operatorId) {
      return _result(null, 'none', 0, 'no operatorId on intent', '', false);
    }
    var coarse = _coarseFromIntent(intent, opts.essenceState);
    var signature = computeSceneSignature(coarse);
    var current = _currentFrame[operatorId] || opts.currentFrame || null;

    // §4 step 1: same signature as current frame → no-op.
    if (current && _currentSignature[operatorId] &&
        _currentSignature[operatorId] === signature) {
      return _result(current, 'exact', 1.0,
        'no-op: scene signature unchanged', signature, true);
    }

    var frames = (_registry[operatorId] && _registry[operatorId].frames) || [];
    var approved = [];
    var i;
    for (i = 0; i < frames.length; i++) {
      // Layer filter: the operator frame layer only ever shows portraits.
      // Backgrounds/chibis are valid registry entries for OTHER layers
      // (stage bg, HQ chibis) — they must never win the frame slot
      // (QA: sparse intent rendered the room background as the portrait).
      if (frames[i].kind && frames[i].kind !== 'portrait') continue;
      if (_approved(frames[i])) approved.push(frames[i]);
    }

    // Tier 1 — exact signature match.
    var tier = [];
    for (i = 0; i < approved.length; i++) {
      if (approved[i].sceneSignature === signature) tier.push(approved[i]);
    }
    var frame = _preferContinuity(tier, coarse, current);
    if (frame) {
      return _result(frame, 'exact', 1.0, 'exact scene signature match', signature, false);
    }

    // Tier 2 — same location (same expression family preferred inside tier).
    tier = [];
    for (i = 0; i < approved.length; i++) {
      var st = approved[i].state || {};
      if (coarse.location && _norm(st.location) === _norm(coarse.location)) {
        tier.push(approved[i]);
      }
    }
    frame = _preferContinuity(tier, coarse, current);
    if (frame) {
      var conf = 0.85 * _qualityScore(frame);
      if (conf >= CONFIDENCE_FLOOR) {
        return _result(frame, 'location', conf,
          'same-location reuse (confidence ' + conf.toFixed(2) + ')', signature, false);
      }
    }

    // Tier 3 — same expression family.
    var family = expressionFamily(coarse.expression);
    tier = [];
    for (i = 0; i < approved.length; i++) {
      var est = approved[i].state || {};
      if (expressionFamily(est.expression) === family) tier.push(approved[i]);
    }
    frame = _preferContinuity(tier, coarse, current);
    if (frame) {
      var famConf = 0.75 * _qualityScore(frame);
      if (famConf >= CONFIDENCE_FLOOR) {
        return _result(frame, 'expression-family', famConf,
          'expression-family reuse (' + family + ', confidence ' +
          famConf.toFixed(2) + ')', signature, false);
      }
    }

    // Tier 4 — operator default: approved neutral frame for this operator.
    tier = [];
    for (i = 0; i < approved.length; i++) {
      var dst = approved[i].state || {};
      if (_norm(dst.expression) === 'neutral' &&
          (!dst.location || !coarse.location ||
           _norm(dst.location) === _norm(coarse.location))) {
        tier.push(approved[i]);
      }
    }
    frame = _preferContinuity(tier, coarse, current);
    if (frame) {
      var defConf = 0.65 * _qualityScore(frame);
      if (defConf >= CONFIDENCE_FLOOR) {
        return _result(frame, 'operator-default', defConf,
          'operator default frame', signature, false);
      }
    }

    // Tier 5 — generic portrait ladder rung (authored manifest assets).
    var generic = genericFrameFor(operatorId, coarse.expression);
    if (generic) {
      return _result(generic, 'generic', 0.4,
        'registry below confidence floor; generic portrait fallback', signature, false);
    }

    // Bottom of the ladder: caller degrades to text-first.
    return _result(null, 'none', 0,
      'no frame available; degrade to text-first', signature, false);
  }

  // POST frames/register — available for tooling; unused by the UI in v1.
  function registerDrop(frame) {
    return _api('/api/hyrax/essence/frames/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(frame || {}),
    });
  }

  function _reset(operatorId) {
    delete _registry[operatorId];
    delete _lru[operatorId];
    delete _currentFrame[operatorId];
    delete _currentSignature[operatorId];
  }

  essence.frames = {
    load: load,
    selectFrame: selectFrame,
    noteApplied: noteApplied,
    computeSceneSignature: computeSceneSignature,
    expressionFamily: expressionFamily,
    poseFamily: poseFamily,
    timeOfDayBand: timeOfDayBand,
    genericFrameFor: genericFrameFor,
    genericPortraitUrls: genericPortraitUrls,
    registerDrop: registerDrop,
    CONFIDENCE_FLOOR: CONFIDENCE_FLOOR,
    L2_CACHE_MAX: L2_CACHE_MAX,
    OPERATOR_BACKGROUND_IDS: OPERATOR_BACKGROUND_IDS,
    GENERIC_PORTRAIT_IDS: GENERIC_PORTRAIT_IDS,
    _reset: _reset,
  };
})();
