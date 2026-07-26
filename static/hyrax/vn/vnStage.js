/* vnStage.js — Gestalt VN scene stage: layered Essence Frame rendering.
 *
 * Layers: background img, operator frame img (double-buffered crossfade),
 * overlay div (mood-tinted vignette, stale badge, loading placeholder).
 * 300 ms crossfade (instant cut when reducedMotion), continuity handling via
 * the frames registry ladder, alt text from frame state, stale-image
 * indicator when essence state staleness > 3 days, text-first mode toggle
 * (class hook), subtle pointer parallax (off when reducedMotion), emotion
 * jolt on expression-family change (class hook; keyframes in hyrax.css,
 * only under prefers-reduced-motion: no-preference).
 *
 * Ships the v1 presentation providers (ESSENCE_RUNTIME_SPEC §9):
 * StaticEssenceFrameProvider + FallbackPortraitProvider, registered in
 * GestaltVN.vn.providers so an ARDY provider can be added later without
 * edits here.
 *
 * Classic-script IIFE. Namespace: window.GestaltVN.vn.stage
 */
(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : globalThis;
  var GestaltVN = root.GestaltVN = root.GestaltVN || {};
  var vn = GestaltVN.vn = GestaltVN.vn || {};
  var essence = GestaltVN.essence = GestaltVN.essence || {};

  var CROSSFADE_MS = 300;        // §4 step 5
  var STALE_DAYS = 3;            // stale-image indicator threshold
  var PARALLAX_PX = 6;

  // ── Provider registry (spec §9 boundary) ─────────────────────────────────
  // Entries: {id, capabilities, create(stageCtx) -> PresentationProvider}.
  // ARDY providers register here later; stage walks entries in order.
  var providers = vn.providers = vn.providers || (function () {
    var entries = [];
    return {
      register: function (entry) {
        if (!entry || !entry.id || typeof entry.create !== 'function') {
          throw new Error('provider entry needs id + create()');
        }
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].id === entry.id) { entries[i] = entry; return entry; }
        }
        entries.push(entry);
        return entry;
      },
      list: function () { return entries.slice(); },
      get: function (id) {
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].id === id) return entries[i];
        }
        return null;
      },
      remove: function (id) {
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].id === id) { entries.splice(i, 1); return true; }
        }
        return false;
      },
    };
  })();

  // ── Stage singleton ──────────────────────────────────────────────────────

  var _root = null;          // .gestalt-vn-stage
  var _bgImg = null;
  var _frameImgs = [];       // double buffer [front, back]
  var _frameWrap = null;
  var _overlay = null;
  var _staleBadge = null;
  var _placeholder = null;
  var _operatorId = null;
  var _reducedMotion = false;
  var _textFirst = false;
  var _currentFrame = null;
  var _providerInstances = [];
  var _parallaxHandler = null;
  var _parallaxLeave = null;
  var _stateUnsub = null;
  var _mounted = false;
  var _expressionFamily = null;  // last expression family shown (jolt diff)
  var _joltTimer = null;
  var _desktopMq = null;         // matchMedia('(min-width: 721px)') listener
  var _desktopMqHandler = null;

  // Canonical expression families (hyrax-assets/essence/expression-families
  // .json v2): neutral / positive / wry / focused / intense / sad — each maps
  // to a jolt keyframe class in hyrax.css.
  var JOLT_CLASSES = [
    'gestalt-vn-jolt-neutral',
    'gestalt-vn-jolt-positive',
    'gestalt-vn-jolt-wry',
    'gestalt-vn-jolt-focused',
    'gestalt-vn-jolt-intense',
    'gestalt-vn-jolt-sad',
  ];

  function _el(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }

  function _altForFrame(frame) {
    if (!frame) return '';
    var st = frame.state || {};
    var name = (_operatorId || 'operator');
    name = name.charAt(0).toUpperCase() + name.slice(1);
    var alt = name + ' — ' + (st.expression || 'neutral');
    if (st.location) alt += ' in ' + st.location;
    if (st.action) alt += ', ' + st.action;
    return alt;
  }

  // Mood-tinted vignette from essence mood valence (presentational only).
  function _applyVignette() {
    if (!_overlay || !essence.state || !_operatorId) return;
    var state = essence.state.get(_operatorId);
    var mood = (state && state.mood) || {};
    var valence = typeof mood.valence === 'number' ? mood.valence : 0;
    var band = valence > 0.2 ? 'warm' : (valence < -0.2 ? 'cold' : 'neutral');
    var intensity = typeof mood.intensity === 'number' ? mood.intensity : 0;
    _overlay.className = 'gestalt-vn-stage-overlay vignette-' + band;
    _overlay.style.opacity = String(Math.min(0.6, 0.2 + intensity * 0.4));
  }

  function _updateStaleBadge() {
    if (!_staleBadge || !essence.state || !_operatorId) return;
    var state = essence.state.get(_operatorId);
    var days = state && typeof state.stalenessDays === 'number'
      ? state.stalenessDays : null;
    var stale = days !== null && days > STALE_DAYS;
    _staleBadge.hidden = !stale;
    if (stale) {
      _staleBadge.textContent = 'imagery stale (~' + Math.floor(days) + 'd)';
      _root.classList.add('gestalt-vn-stage-stale');
    } else {
      _root.classList.remove('gestalt-vn-stage-stale');
    }
  }

  // Live reduced-motion check: init opts are the explicit override, but the
  // shell doesn't pass one — matchMedia is the honest source at jolt time.
  function _liveReducedMotion() {
    if (_reducedMotion) return true;
    try {
      return typeof root.matchMedia === 'function' &&
        root.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (_) { return false; }
  }

  // Emotion jolt: a small physical reaction on the sprite when the
  // expression FAMILY changes (positive = bounce, intense = shake, wry =
  // tilt, focused = lean, neutral = settle, sad = sag). Class swap on the
  // frame wrap;
  // the animations themselves live in hyrax.css behind
  // @media (prefers-reduced-motion: no-preference) — and the class is never
  // applied under reduce, so reduced-motion runs carry no jolt markup.
  function _maybeJolt(intent) {
    var expr = intent && intent.expressionIntent;
    if (!expr) return;
    var family = essence.frames && typeof essence.frames.expressionFamily === 'function'
      ? essence.frames.expressionFamily(expr) : 'neutral';
    if (family === _expressionFamily) return; // no change → no reaction
    _expressionFamily = family;
    if (_liveReducedMotion() || !_frameWrap || !_frameWrap.classList) return;
    var cls = 'gestalt-vn-jolt-' + family;
    if (JOLT_CLASSES.indexOf(cls) === -1) return;
    for (var i = 0; i < JOLT_CLASSES.length; i++) {
      _frameWrap.classList.remove(JOLT_CLASSES[i]);
    }
    // Force reflow so a same-family retrigger restarts the animation.
    try { void _frameWrap.offsetWidth; } catch (_) {}
    _frameWrap.classList.add(cls);
    if (_joltTimer) { clearTimeout(_joltTimer); _joltTimer = null; }
    _joltTimer = setTimeout(function () {
      _joltTimer = null;
      if (_frameWrap && _frameWrap.classList) _frameWrap.classList.remove(cls);
    }, 600);
  }

  // ── Per-frame sprite calibration ────────────────────────────────────────
  // Desktop-only: the stage column is a centered 4/5 box (hyrax.css
  // min-width:721px). Sprites sit on different regions/scales of their
  // transparent canvases, so the registry carries per-frame display data
  // (scripts/calibrate_frame_crops.py → assets.display {scale, focusX,
  // objectPositionY}):
  //   scale           img width as a multiple of the wrap width (≥1: zoom).
  //                   Cover stays width-limited, so the visible source
  //                   window shrinks uniformly to V0/scale.
  //   focusX          content center as a fraction of the canvas width —
  //                   the element's `left` shifts so the FIGURE (not the
  //                   canvas) centers in the stage column.
  //   objectPositionY anchors the window so the head top sits ~3% below
  //                   the stage top instead of the canvas top.
  // All values are percentages of the wrap, so viewport resizes need no
  // recompute — only the desktop↔mobile media crossing does (inline
  // styles must not leak into the mobile full-bleed layout).
  function _isDesktopFraming() {
    try {
      if (_desktopMq) return !!_desktopMq.matches;
      return typeof root.matchMedia !== 'function' ||
        root.matchMedia('(min-width: 721px)').matches;
    } catch (_) { return true; }
  }

  function _clearFrameCalibration(img) {
    if (!img || !img.style) return;
    img.style.width = '';
    img.style.left = '';
    img.style.right = '';
    img.style.objectPosition = '';
  }

  function _applyFrameCalibration(img, frame) {
    if (!img || !img.style) return;
    var d = frame && frame.assets && frame.assets.display;
    var ok = _isDesktopFraming() && d &&
      typeof d.scale === 'number' && d.scale >= 1 &&
      typeof d.focusX === 'number' && d.focusX >= 0 && d.focusX <= 1 &&
      typeof d.objectPositionY === 'number' &&
      d.objectPositionY >= 0 && d.objectPositionY <= 1;
    if (!ok) { _clearFrameCalibration(img); return; }
    img.style.width = (d.scale * 100).toFixed(1) + '%';
    img.style.left = (50 - d.focusX * d.scale * 100).toFixed(2) + '%';
    img.style.right = 'auto';
    img.style.objectPosition =
      'center ' + (d.objectPositionY * 100).toFixed(1) + '%';
  }

  // Re-apply on desktop↔mobile crossings: each img remembers the frame it
  // currently shows (both crossfade buffers), so the media flip restores or
  // strips the inline calibration without touching the frame selection.
  function _reapplyCalibration() {
    for (var i = 0; i < _frameImgs.length; i++) {
      _applyFrameCalibration(_frameImgs[i], _frameImgs[i].__vnFrame || null);
    }
  }

  // Crossfade (or cut under reducedMotion) with continuity hints.
  function _showFrame(frame, transition) {
    if (!frame || !frame.assets || !frame.assets.imageUrl) return false;
    var front = _frameImgs[0];
    var back = _frameImgs[1];
    back.src = frame.assets.imageUrl;
    back.alt = _altForFrame(frame);
    back.setAttribute('data-frame-id', frame.id || '');
    back.setAttribute('data-frame-source', frame.source || '');
    back.__vnFrame = frame;
    _applyFrameCalibration(back, frame);
    // Camera-aware framing (close|medium|wide from the frame state; CSS
    // handles cover/contain + anchor — the mai-style half-cut look without
    // editing images).
    var camera = (frame.state && frame.state.camera) || 'medium';
    back.setAttribute('data-framing', camera);
    front.setAttribute('data-framing', camera);
    if (transition === 'crossfade') {
      // Clear the stale counterpart class on BOTH buffers: without this a
      // second crossfade leaves each img carrying xfade-in AND xfade-out,
      // and the later xfade-out rule (opacity: 0) hides the sprite entirely
      // (found via pose swaps: second transition → invisible stage).
      back.classList.add('xfade-in');
      back.classList.remove('xfade-out');
      front.classList.add('xfade-out');
      front.classList.remove('xfade-in');
    } else {
      back.classList.remove('xfade-in');
      back.classList.remove('xfade-out');
      front.classList.remove('xfade-out');
      front.classList.remove('xfade-in');
    }
    // Swap buffers; CSS animates opacity when xfade classes are present.
    _frameImgs = [back, front];
    _currentFrame = frame;
    if (_placeholder) _placeholder.hidden = true;
    return true;
  }

  // Stage context handed to provider factories.
  function _stageCtx() {
    return {
      operatorId: _operatorId,
      reducedMotion: _reducedMotion,
      getCurrentFrame: function () { return _currentFrame; },
      showFrame: _showFrame,
      applyVignette: _applyVignette,
      updateStaleBadge: _updateStaleBadge,
      layers: {
        root: _root, bg: _bgImg, frameWrap: _frameWrap,
        overlay: _overlay, staleBadge: _staleBadge, placeholder: _placeholder,
      },
      essenceState: function () {
        return essence.state && _operatorId
          ? essence.state.get(_operatorId) : null;
      },
    };
  }

  // ── PresentationContext (API contracts §5) ───────────────────────────────
  function _presentationContext() {
    return {
      currentFrame: _currentFrame,
      surface: 'vn',
      reducedMotion: _reducedMotion,
      textFirst: _textFirst,
      essenceState: essence.state && _operatorId
        ? essence.state.get(_operatorId) : null,
    };
  }

  function init(container, opts) {
    opts = opts || {};
    if (!container) return null;
    dispose();

    _operatorId = opts.operatorId || null;
    _reducedMotion = !!opts.reducedMotion;
    _textFirst = !!opts.textFirst;

    _root = _el('div', 'gestalt-vn-stage');
    if (_textFirst) _root.classList.add('text-first');
    if (_reducedMotion) _root.classList.add('reduced-motion');

    _bgImg = _el('img', 'gestalt-vn-stage-bg');
    var bgId = essence.frames && _operatorId
      ? essence.frames.OPERATOR_BACKGROUND_IDS[_operatorId] : null;
    if (bgId) _bgImg.src = '/api/hyrax/assets/' + bgId;
    _bgImg.alt = '';

    _frameWrap = _el('div', 'gestalt-vn-stage-frame-wrap');
    _frameImgs = [_el('img', 'gestalt-vn-stage-frame front'),
      _el('img', 'gestalt-vn-stage-frame back')];
    _frameImgs[0].alt = '';
    _frameImgs[1].alt = '';
    _frameWrap.appendChild(_frameImgs[0]);
    _frameWrap.appendChild(_frameImgs[1]);

    _overlay = _el('div', 'gestalt-vn-stage-overlay vignette-neutral');
    _staleBadge = _el('div', 'gestalt-vn-stage-stale-badge');
    _staleBadge.hidden = true;
    _placeholder = _el('div', 'gestalt-vn-stage-placeholder', 'loading scene…');

    _root.appendChild(_bgImg);
    _root.appendChild(_frameWrap);
    _root.appendChild(_overlay);
    _root.appendChild(_staleBadge);
    _root.appendChild(_placeholder);
    container.appendChild(_root);

    // Instantiate registered providers in registration order.
    _providerInstances = [];
    var entries = providers.list();
    for (var i = 0; i < entries.length; i++) {
      try {
        _providerInstances.push(entries[i].create(_stageCtx()));
      } catch (e) { /* a broken provider must not break the stage */ }
    }

    // Staleness + vignette follow essence state changes (never polled).
    if (essence.state && typeof essence.state.subscribe === 'function') {
      _stateUnsub = essence.state.subscribe(function (state) {
        if (!_operatorId || state.operatorId !== _operatorId) return;
        _applyVignette();
        _updateStaleBadge();
      });
    }
    _applyVignette();
    _updateStaleBadge();

    // Seed the jolt baseline from persisted essence state — the first
    // intent after mount reacts only to an actual family change, never to
    // re-entry itself.
    _expressionFamily = null;
    if (essence.state && _operatorId && essence.frames &&
        typeof essence.frames.expressionFamily === 'function') {
      var seedState = essence.state.get(_operatorId);
      var seedExpr = seedState && seedState.presentation &&
        seedState.presentation.expression;
      if (seedExpr) {
        _expressionFamily = essence.frames.expressionFamily(seedExpr);
      }
    }

    // Re-init replay: the persisted current frame outlives the DOM on
    // re-mount — put it straight back into the fresh layers (cut, no
    // crossfade) so the "loading scene…" placeholder never lingers and
    // follow-up no-op intents stay honest. Guarded by operator match.
    if (_currentFrame && _currentFrame.operatorId === _operatorId) {
      _showFrame(_currentFrame, 'cut');
    }

    // Desktop ↔ mobile crossings re-apply/strip the per-frame calibration
    // (inline styles are desktop-only; mobile keeps the full-bleed CSS).
    _desktopMq = null;
    _desktopMqHandler = null;
    try {
      if (typeof root.matchMedia === 'function') {
        _desktopMq = root.matchMedia('(min-width: 721px)');
        _desktopMqHandler = function () { _reapplyCalibration(); };
        if (typeof _desktopMq.addEventListener === 'function') {
          _desktopMq.addEventListener('change', _desktopMqHandler);
        } else if (typeof _desktopMq.addListener === 'function') {
          _desktopMq.addListener(_desktopMqHandler);
        }
      }
    } catch (_) { _desktopMq = null; _desktopMqHandler = null; }

    // Subtle pointer parallax — off under reducedMotion.
    if (!_reducedMotion && _root.addEventListener) {      _parallaxHandler = function (ev) {
        if (!_root || !_frameWrap) return;
        var rect = _root.getBoundingClientRect
          ? _root.getBoundingClientRect() : { width: 1, height: 1, left: 0, top: 0 };
        var dx = ((ev.clientX - rect.left) / (rect.width || 1)) - 0.5;
        var dy = ((ev.clientY - rect.top) / (rect.height || 1)) - 0.5;
        _frameWrap.style.transform = 'translate(' +
          (dx * PARALLAX_PX).toFixed(1) + 'px,' +
          (dy * PARALLAX_PX).toFixed(1) + 'px)';
      };
      _parallaxLeave = function () {
        if (_frameWrap) _frameWrap.style.transform = '';
      };
      _root.addEventListener('pointermove', _parallaxHandler);
      _root.addEventListener('pointerleave', _parallaxLeave);
    }

    // Warm the registry cache; selection degrades gracefully without it.
    if (essence.frames && _operatorId) {
      essence.frames.load(_operatorId);
    }
    if (essence.state && _operatorId) {
      essence.state.refresh(_operatorId);
    }

    _mounted = true;
    return api;
  }

  // applyIntent: walk providers in registration order; first applied wins.
  // None applied → text-first fallback rung (§4 step 4 bottom).
  function applyIntent(intent) {
    if (!_mounted || !intent) {
      return Promise.resolve({ applied: false, transition: 'none',
        reason: 'stage not mounted' });
    }
    var ctx = _presentationContext();
    var chain = Promise.resolve(null);
    _providerInstances.forEach(function (provider) {
      chain = chain.then(function (prev) {
        if (prev && prev.applied) return prev;
        return Promise.resolve()
          .then(function () { return provider.apply(intent, ctx); })
          .catch(function (err) {
            return { applied: false, transition: 'none',
              reason: 'provider ' + provider.id + ' error: ' +
                (err && err.message) };
          });
      });
    });
    return chain.then(function (result) {
      if (result && result.applied) {
        _root.classList.remove('text-first-fallback');
        _maybeJolt(intent);
        return result;
      }
      // Bottom of the ladder: text-first.
      _root.classList.add('text-first-fallback');
      return result || { applied: false, transition: 'none',
        reason: 'no provider applied' };
    });
  }

  function setTextFirst(on) {
    _textFirst = !!on;
    if (!_root) return;
    if (_textFirst) _root.classList.add('text-first');
    else _root.classList.remove('text-first');
  }

  // Room-scene background swap. Fail closed: only a non-empty string swaps,
  // and a load error restores the previous background — the stage never
  // shows a broken image behind the sprite.
  function setBackground(url) {
    if (!_bgImg || typeof url !== 'string' || !url) return false;
    var prev = _bgImg.getAttribute('src') || '';
    if (prev === url) return true;
    if (typeof _bgImg.addEventListener === 'function') {
      var onError = function () {
        _bgImg.removeEventListener('error', onError);
        if (prev) _bgImg.src = prev;
      };
      _bgImg.addEventListener('error', onError);
    }
    _bgImg.src = url;
    return true;
  }

  function getState() {
    return {
      operatorId: _operatorId,
      mounted: _mounted,
      reducedMotion: _reducedMotion,
      textFirst: _textFirst,
      currentFrame: _currentFrame,
      background: _bgImg
        ? (typeof _bgImg.getAttribute === 'function'
          ? _bgImg.getAttribute('src') : _bgImg.src)
        : null,
      providerIds: _providerInstances.map(function (p) { return p.id; }),
    };
  }

  function dispose() {
    if (_stateUnsub) { try { _stateUnsub(); } catch (e) {} _stateUnsub = null; }
    for (var i = 0; i < _providerInstances.length; i++) {
      try { _providerInstances[i].dispose(); } catch (e) {}
    }
    _providerInstances = [];
    if (_root && _parallaxHandler && _root.removeEventListener) {
      _root.removeEventListener('pointermove', _parallaxHandler);
      _root.removeEventListener('pointerleave', _parallaxLeave);
    }
    _parallaxHandler = null;
    _parallaxLeave = null;
    if (_joltTimer) { clearTimeout(_joltTimer); _joltTimer = null; }
    _expressionFamily = null;
    if (_desktopMq && _desktopMqHandler) {
      try {
        if (typeof _desktopMq.removeEventListener === 'function') {
          _desktopMq.removeEventListener('change', _desktopMqHandler);
        } else if (typeof _desktopMq.removeListener === 'function') {
          _desktopMq.removeListener(_desktopMqHandler);
        }
      } catch (_) {}
    }
    _desktopMq = null;
    _desktopMqHandler = null;
    if (_root && _root.remove) _root.remove();
    _root = _bgImg = _frameWrap = _overlay = _staleBadge = _placeholder = null;
    _frameImgs = [];
    // _currentFrame intentionally persists across re-mounts: init() replays
    // it into the fresh DOM (guarded by operator match), which keeps the
    // loading placeholder from lingering and no-op selections honest.
    _operatorId = null;
    _mounted = false;
  }

  var api = {
    init: init,
    applyIntent: applyIntent,
    setTextFirst: setTextFirst,
    setBackground: setBackground,
    getState: getState,
    dispose: dispose,
    CROSSFADE_MS: CROSSFADE_MS,
  };
  vn.stage = api;

  // ── v1 providers (spec §9) ───────────────────────────────────────────────

  // StaticEssenceFrameProvider: registry-backed still frames with crossfade.
  providers.register({
    id: 'static-essence-frames',
    capabilities: ['still-frames', 'transitions'],
    create: function (stageCtx) {
      return {
        id: 'static-essence-frames',
        capabilities: ['still-frames', 'transitions'],
        apply: function (intent, ctx) {
          return Promise.resolve()
            .then(function () {
              return essence.frames.load(stageCtx.operatorId);
            })
            .then(function () {
              var sel = essence.frames.selectFrame(intent, {
                essenceState: ctx.essenceState,
                currentFrame: ctx.currentFrame,
              });
              if (sel.noOp) {
                // No-op is a SUCCESS state (the right frame is already
                // displayed) — not a decline. Returning applied:true stops
                // the provider chain; otherwise the fallback provider would
                // swap the correct frame for a generic portrait on re-entry
                // (found in dogfood: sprite replaced by the old portrait).
                //
                // …but only when the stage DOM actually shows the frame.
                // After HQ → operator B → HQ → operator A, the per-operator
                // signature cache in essenceFrames still matches A's scene
                // while the fresh stage DOM (rebuilt on remount; the init
                // replay is skipped on operator mismatch) still sits on the
                // "loading scene…" placeholder. Trust the DOM, not the
                // cache: re-show (cut) when they disagree.
                var onStage = typeof stageCtx.getCurrentFrame === 'function'
                  ? stageCtx.getCurrentFrame() : null;
                if (sel.frame && (!onStage || onStage.id !== sel.frame.id)) {
                  stageCtx.showFrame(sel.frame, 'cut');
                }
                return { applied: true, frame: sel.frame, transition: 'none',
                  reason: sel.reason };
              }
              // Below the static tiers the ladder belongs to the fallback
              // provider — decline so the stage walks on.
              if (!sel.frame || sel.match === 'generic' || sel.match === 'none') {
                return { applied: false, transition: 'none',
                  reason: 'below static tiers: ' + sel.match };
              }
              var transition = stageCtx.reducedMotion ? 'cut' : 'crossfade';
              var shown = stageCtx.showFrame(sel.frame, transition);
              if (shown) {
                // Note with the *intent* signature so an identical follow-up
                // intent is a no-op (§4 step 1).
                essence.frames.noteApplied(
                  stageCtx.operatorId, sel.frame, sel.sceneSignature);
              }
              return { applied: shown, frame: sel.frame,
                transition: shown ? transition : 'none', reason: sel.reason };
            });
        },
        dispose: function () {},
      };
    },
  });

  // FallbackPortraitProvider: generic authored portraits from the asset
  // allowlist when the registry yields nothing above the confidence floor.
  providers.register({
    id: 'fallback-portrait',
    capabilities: ['still-frames'],
    create: function (stageCtx) {
      return {
        id: 'fallback-portrait',
        capabilities: ['still-frames'],
        apply: function (intent, ctx) {
          var frame = essence.frames.genericFrameFor(
            stageCtx.operatorId, intent && intent.expressionIntent);
          if (!frame) {
            return Promise.resolve({ applied: false, transition: 'none',
              reason: 'no generic portrait for operator' });
          }
          var current = stageCtx.getCurrentFrame();
          if (current && current.id === frame.id) {
            // Already displayed — success with no transition (declining
            // would leave the loading placeholder up forever).
            return Promise.resolve({ applied: true, frame: frame,
              transition: 'none', reason: 'generic portrait already shown' });
          }
          var transition = stageCtx.reducedMotion ? 'cut' : 'crossfade';
          var shown = stageCtx.showFrame(frame, transition);
          return Promise.resolve({ applied: shown, frame: frame,
            transition: shown ? transition : 'none',
            reason: 'generic portrait fallback' });
        },
        dispose: function () {},
      };
    },
  });
})();
