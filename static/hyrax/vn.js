/**
 * Hyraxknot Division — VN Conversation Interface
 *
 * Visual novel conversation panel: portrait display, dialogue box,
 * backlog, composer, SSE event handling.
 *
 * Exposes window.__vnMount(props) and window.__vnUnmount() for lifecycle
 * management. Uses only native /api/hyrax/vn/ contracts.
 *
 * No switchPanel wrapper, no direct panel-list mutation, no donor patterns.
 */
(function() {
  'use strict';

  // ── State ──
  var _activeConversation = null;
  var _eventSource = null;
  var _streamed = '';
  var _streamBubble = null;
  var _lastExpression = { current: 'neutral', intensity: 0.5 };
  var _blinkTimer = null;
  var _currentSisterId = null;
  var _currentSisterName = '';
  var _mounted = false;
  var _toastTimer = null;
  var _keyHandler = null;

  // Race token: increments on each new conversation.  SSE callbacks
  // capture the token at subscription time and discard events whose
  // token doesn't match the current one (stale-response suppression).
  var _raceToken = 0;

  // ── VN Asset definitions ──
  var VN_ASSETS = {
    tai: {
      background: 'tai.background.control-room',
      speaking: 'tai.portrait.smile',
      focused: 'tai.portrait.focused',
      expressions: {
        neutral: 'tai.portrait.neutral', smile: 'tai.portrait.smile',
        happy: 'tai.portrait.happy-emote', sarcastic: 'tai.portrait.sarcastic',
        teasing: 'tai.portrait.tongue-tease', shy: 'tai.portrait.submissive-blush',
        focused: 'tai.portrait.focused',
      },
    },
    rei: {
      background: 'rei.background.security',
      speaking: 'rei.portrait.calm',
      focused: 'rei.portrait.alert',
      expressions: { neutral: 'rei.portrait.neutral' },
    },
    nei: {
      background: 'nei.background.lab',
      speaking: 'nei.portrait.observant',
      focused: 'nei.portrait.thinking',
      expressions: { neutral: 'nei.portrait.neutral' },
    },
    mai: {
      background: 'mai.background.supply-hub',
      speaking: 'mai.portrait.composed',
      focused: 'mai.portrait.observant',
      expressions: {
        neutral: 'mai.portrait.neutral', smile: 'mai.portrait.smile',
        laughing: 'mai.portrait.laughing', light_smile: 'mai.portrait.light-smile',
        ohhoai: 'mai.portrait.ohhoai', scream_of_fury: 'mai.portrait.scream-of-fury',
        shy_smile: 'mai.portrait.shy-smile', yandere_smile: 'mai.portrait.yandere-smile',
        ahegao: 'mai.portrait.ahegao', focused: 'mai.portrait.observant',
        amused: 'mai.portrait.smile', happy: 'mai.portrait.smile',
        grinning: 'mai.portrait.laughing', calm: 'mai.portrait.light-smile',
        composed: 'mai.portrait.light-smile', angry: 'mai.portrait.scream-of-fury',
        soft_smile: 'mai.portrait.shy-smile', silly: 'mai.portrait.laughing',
        flirtatious: 'mai.portrait.ohhoai', smug: 'mai.portrait.smile',
        teasing: 'mai.portrait.ohhoai', annoyed: 'mai.portrait.scream-of-fury',
        frustrated: 'mai.portrait.scream-of-fury', shy: 'mai.portrait.shy-smile',
        bashful: 'mai.portrait.shy-smile', mischievous: 'mai.portrait.yandere-smile',
        playful: 'mai.portrait.ohhoai', sarcastic: 'mai.portrait.composed',
        submissive_blush: 'mai.portrait.shy-smile',
        happy_emote: 'mai.portrait.smile', tongue_tease: 'mai.portrait.shy-smile',
        deadpan: 'mai.portrait.neutral', thinking: 'mai.portrait.observant',
        surprised: 'mai.portrait.ohhoai', concerned: 'mai.portrait.observant',
      },
    },
  };

  // ── Helpers ──

  function _el(tag, attrs) {
    var elem = document.createElement(tag);
    if (attrs) {
      var keys = Object.keys(attrs);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var v = attrs[k];
        if (k === 'className') { elem.className = v; }
        else if (typeof v === 'boolean') { if (v) elem.setAttribute(k, ''); }
        else { elem.setAttribute(k, v); }
      }
    }
    // Append children passed after attrs
    for (var j = 2; j < arguments.length; j++) {
      var c = arguments[j];
      if (c != null) {
        elem.append(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return elem;
  }

  // ── Main API ──

  /**
   * Mount the VN conversation interface for a given sister.
   * Called from hq.js when a chibi is clicked.
   * @param {Object} props - { sisterId, sisterName }
   */
  async function __vnMount(props) {
    if (!props || !props.sisterId) return;
    var profileId = props.sisterId;
    var name = props.sisterName || profileId;

    // Increment race token — any stale SSE handler will discard
    _raceToken = (_raceToken + 1) % 1000000;
    var token = _raceToken;

    // Unmount previous session gracefully
    _cleanup();

    _currentSisterId = profileId;
    _currentSisterName = name;
    _mounted = true;

    // Show loading state
    var content = document.getElementById('mainHq');
    if (!content) return;
    content.innerHTML = '<div class="vn-loading" role="status" aria-live="polite" aria-busy="true">Connecting to ' + _esc(name) + '\u2026</div>';

    // Fetch profiles to check availability
    try {
      var profileData = await _api('/api/hyrax/vn/profiles', { method: 'GET' });
      if (_raceToken !== token) return; // stale

      var items = (profileData && profileData.items) || [];
      var profile = null;
      for (var i = 0; i < items.length; i++) {
        if (items[i].id === profileId) { profile = items[i]; break; }
      }

      if (profile && !profile.available) {
        _showToast(name + '\'s VN gateway is staged and disabled.');
        content.innerHTML = '<div class="vn-error"><p>' + _esc(name) + ' is not available.</p></div>';
        return;
      }
    } catch (_) {
      if (_raceToken !== token) return;
      // Continue without profile check
    }

    // Create or resume conversation
    try {
      var resp = await _api('/api/hyrax/vn/conversations', {
        method: 'POST',
        body: JSON.stringify({ profile_id: profileId, fresh: false }),
      });
      if (_raceToken !== token) return; // stale
      _activeConversation = (resp && resp.conversation) || resp;
    } catch (err) {
      if (_raceToken !== token) return;
      _showToast('Conversation could not be created.');
      content.innerHTML = '<div class="vn-error" role="alert"><p>Failed to start conversation.</p></div>';
      return;
    }

    // Render the VN stage
    _renderVN(content, profileId, name, token);
  }

  /**
   * Unmount the VN interface and clean up.
   */
  function __vnUnmount() {
    _cleanup();
    _mounted = false;
  }

  // ── Cleanup ──

  function _cleanup() {
    // Close SSE
    if (_eventSource) {
      try { _eventSource.close(); } catch (_) {}
      _eventSource = null;
    }
    // Clear blink timer
    if (_blinkTimer) {
      clearTimeout(_blinkTimer);
      _blinkTimer = null;
    }
    // Clear toast timer
    if (_toastTimer) {
      clearTimeout(_toastTimer);
      _toastTimer = null;
    }
    // Remove global keyboard handler
    if (_keyHandler) {
      document.removeEventListener('keydown', _keyHandler);
      _keyHandler = null;
    }
    // Reset streaming state
    _streamed = '';
    _streamBubble = null;
    _activeConversation = null;
    _currentSisterId = null;
    _currentSisterName = '';
    _lastExpression = { current: 'neutral', intensity: 0.5 };
  }

  // ── Render VN ──

  function _renderVN(content, profileId, name, token) {
    var conversationId = _activeConversation && (_activeConversation.id || _activeConversation.session_id);
    if (!conversationId) return;

    var assets = VN_ASSETS[profileId];
    if (!assets) {
      _showToast('No VN presentation contract for ' + profileId);
      content.innerHTML = '<div class="vn-error" role="alert"><p>Character presentation unavailable.</p></div>';
      return;
    }

    // Build VN stage
    var stage = _el('section', { className: 'vn-stage' });
    stage.style.background = 'linear-gradient(180deg,rgba(8,12,18,.1),rgba(8,12,18,.92)),url(/api/hyrax/assets/' + assets.background + ')';

    // Back button → HQ map
    var back = _el('button', { className: 'vn-back' }, '\u2190 HQ');
    back.addEventListener('click', function() {
      _cleanup();
      _showHqView(content);
    });

    // Enter 3D Loft button → launches Tai's room
    var loft = _el('button', { className: 'vn-back', style: 'left:auto;right:20px;' }, '3D Loft \u2192');
    loft.addEventListener('click', function() {
      if (typeof window.__hqLaunch3d === 'function') {
        window.__hqLaunch3d();
      }
    });

    // Escape key → HQ map
    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        _cleanup();
        _showHqView(content);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    _keyHandler = onKeyDown;

    // Portrait
    var exprToAsset = function(expr) {
      var clean = expr.replace(/-/g, '_');
      return _safeLookup(assets, profileId, clean);
    };

    var expr = (_activeConversation.expression) || {};
    var portrait = _el('img', {
      id: 'vn-portrait',
      className: 'vn-portrait',
      src: '/api/hyrax/assets/' + exprToAsset(expr.current || 'neutral'),
      alt: name + ', ' + (expr.current || 'neutral'),
    });
    portrait.dataset._fallback = '/api/hyrax/assets/' + profileId + '.portrait.neutral';
    portrait.addEventListener('error', function() {
      // Broken asset fallback — replace with neutral
      if (this.src.indexOf('portrait.neutral') === -1) {
        this.src = this.dataset._fallback;
      }
    });

    // Dialogue box
    var dialogue = _el('div', { className: 'dialogue', 'aria-live': 'polite' });
    var header = _el('div', { className: 'dialogue-name' });
    header.append(
      _el('span', {}, name),
      _el('span', { className: 'expression-badge', title: 'Mood: ' + (expr.current || 'neutral') },
        (expr.current || 'neutral'))
    );

    var backlog = _el('div', { id: 'vn-backlog', className: 'backlog', role: 'log', 'aria-label': 'Conversation history' });

    // Composer
    var form = _el('form', { className: 'composer' });
    var input = _el('textarea', {
      placeholder: 'Talk with ' + name + '\u2026',
      rows: '2',
      maxlength: '20000',
      'aria-label': 'Message ' + name,
    });
    var send = _el('button', { type: 'submit' }, 'Send');
    var newConv = _el('button', { type: 'button', className: 'secondary' }, 'New Conversation');

    // Enter to send
    input.addEventListener('keydown', function(event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        form.dispatchEvent(new Event('submit', { cancelable: true }));
      }
    });

    form.append(input, newConv, send);

    form.addEventListener('submit', function(event) {
      event.preventDefault();
      var text = input.value.trim();
      if (!text) return;
      _appendLine('Josh', text);
      input.value = '';
      send.setAttribute('disabled', 'true');
      _api('/api/hyrax/vn/conversations/' + conversationId + '/turns', {
        method: 'POST',
        body: JSON.stringify({ text: text }),
      }).then(function() {
        send.removeAttribute('disabled');
        input.focus();
      }).catch(function() {
        _appendLine('Infrastructure', 'Run failed');
        send.removeAttribute('disabled');
        input.focus();
      });
    });

    newConv.addEventListener('click', function() {
      if (!window.confirm('Start a fresh conversation? The current session will be archived.')) return;
      _api('/api/hyrax/vn/conversations', {
        method: 'POST',
        body: JSON.stringify({ profile_id: profileId, fresh: true }),
      }).then(function(resp) {
        if (_raceToken !== token) return;
        _activeConversation = (resp && resp.conversation) || resp;
        backlog.replaceChildren();
        // Reconnect SSE for the new conversation
        if (_eventSource) { _eventSource.close(); _eventSource = null; }
        _connectEvents(profileId, token);
      }).catch(function() {
        _showToast('Failed to create fresh conversation.');
      });
    });

    dialogue.append(header, backlog, form);
    stage.append(back, loft, portrait, dialogue);

    // Show empty/loading state
    content.replaceChildren(stage);

    // Load existing turns
    _showInitialTurns(conversationId, backlog, name, token).then(function() {
      // Ownership check: stale sister/session/unmounted must not connect events
      if (_raceToken !== token) return;
      if (!_mounted) return;
      _connectEvents(profileId, token);
      input.focus();
      _scheduleBlink();
    }).catch(function() {
      // Handled: no unhandled promise rejection from stale completions
    });
  }

  // ── Load initial turns ──

  async function _showInitialTurns(conversationId, backlog, name, token) {
    try {
      var conv = _activeConversation;
      if (!conv.turns || !conv.turns.length) {
        conv = await _api('/api/hyrax/vn/conversations/' + conversationId, { method: 'GET' });
        conv = (conv && conv.conversation) || conv;
        if (_raceToken !== token) return;
      }
      var turns = conv.turns || [];
      if (turns.length === 0) {
        // Empty state
        var emptyMsg = _el('div', { className: 'vn-empty', 'aria-label': 'No messages yet' }, 'Start the conversation\u2026');
        backlog.append(emptyMsg);
        return;
      }
      for (var i = 0; i < turns.length; i++) {
        var turn = turns[i];
        if (turn.text) {
          _appendLine(turn.role === 'user' ? 'Josh' : name, turn.text);
        }
      }
    } catch (_) {
      // Gracefully show empty state on load failure
      var errMsg = _el('div', { className: 'vn-empty' }, 'No messages yet.');
      backlog.append(errMsg);
    }
  }

  // ── SSE ──

  function _connectEvents(profileId, token) {
    if (!_activeConversation) return;
    var cid = _activeConversation.id || _activeConversation.session_id;

    // If we already have an EventSource for the same conversation, reuse
    if (_eventSource) {
      try { _eventSource.close(); } catch (_) {}
    }

    var es = new EventSource('/api/hyrax/vn/conversations/' + cid + '/events');
    _eventSource = es;

    // Generic handler (unnamed events, if any)
    es.onmessage = function(event) {
      if (_raceToken !== token) { es.close(); return; }
      try {
        _handleRunEvent(JSON.parse(event.data), profileId, token);
      } catch (_) {}
    };

    // Typed handlers — match server-side SSE event type names
    var serverEvents = ['token', 'tool', 'tool_complete', 'done', 'cancel', 'apperror', 'reasoning', 'stream_end'];
    for (var i = 0; i < serverEvents.length; i++) {
      (function(type) {
        es.addEventListener(type, function(event) {
          if (_raceToken !== token) { es.close(); return; }
          try {
            _handleRunEvent(JSON.parse(event.data), profileId, token);
          } catch (_) {}
        });
      })(serverEvents[i]);
    }
  }

  // ── Event handler ──

  function _handleRunEvent(event, profileId, token) {
    if (_raceToken !== token) return;

    // ── Normalize server-side payload shapes to client-side event_type+payload contract ──
    if (event.event_type === undefined) {
      // token event: text delta
      if (event.text !== undefined) {
        _streamed += event.text;
        event = { event_type: 'message.delta', payload: { delta: event.text } };
      }
      // done event: run completed
      else if (event.session !== undefined) {
        var finalOut = _streamed || '';
        event = { event_type: 'run.completed', payload: { output: finalOut } };
      }
      // cancel event
      else if (event.message !== undefined && event.session_id === undefined) {
        event = { event_type: 'run.cancelled', payload: { message: event.message } };
      }
      // apperror event
      else if (event.label !== undefined) {
        event = { event_type: 'run.failed', payload: { error: event.message || event.label } };
      }
      // tool event — already has event_type, just needs payload normalization
      else if (event.name !== undefined) {
        event = { event_type: 'tool.started', payload: { name: event.name, preview: event.preview, args: event.args } };
      }
      // stream_end — ignore
      else if (event.session_id !== undefined) {
        return;
      }
    }

    var payload = event.payload || {};
    var assets = VN_ASSETS[profileId];
    var name = _currentSisterName;

    if (event.event_type === 'expression') {
      _lastExpression = { current: payload.current || 'neutral', intensity: payload.intensity || 0.5 };
      var badge = document.querySelector('.expression-badge');
      if (badge) badge.textContent = payload.current || 'neutral';
      var portrait = document.getElementById('vn-portrait');
      if (portrait && assets) {
        var clean = (payload.current || 'neutral').replace(/-/g, '_');
        var assetKey = assets.expressions[clean] || profileId + '.portrait.neutral';
        portrait.src = '/api/hyrax/assets/' + assetKey;
        portrait.alt = name + ', ' + (payload.current || 'neutral');
      }
    }

    if (event.event_type === 'run.started') {
      _streamed = '';
      _streamBubble = _appendLine(name, '\u2026');
    }

    if (event.event_type === 'message.delta') {
      _streamed += payload.delta || '';
      if (_streamBubble) {
        var p = _streamBubble.querySelector('p');
        if (p) p.textContent = _streamed;
        var backlog = document.getElementById('vn-backlog');
        if (backlog) backlog.scrollTop = backlog.scrollHeight;
      }
    }

    if (event.event_type === 'tool.started') {
      var portrait2 = document.getElementById('vn-portrait');
      if (portrait2 && assets) portrait2.src = '/api/hyrax/assets/' + assets.focused;
    }

    if (event.event_type === 'run.completed') {
      var finalText = payload.output || _streamed;
      if (_streamBubble) {
        var p2 = _streamBubble.querySelector('p');
        if (p2) p2.textContent = finalText;
        _streamBubble = null;
      } else {
        _appendLine(name, finalText);
      }
      _streamed = '';
      var portrait3 = document.getElementById('vn-portrait');
      if (portrait3 && assets) {
        var clean2 = _lastExpression.current.replace(/-/g, '_');
        var assetKey2 = assets.expressions[clean2] || profileId + '.portrait.neutral';
        portrait3.src = '/api/hyrax/assets/' + assetKey2;
      }
    }

    if (event.event_type === 'run.cancelled') {
      if (_streamBubble) { _streamBubble.remove(); _streamBubble = null; }
      _appendLine('System', 'Cancelled');
      _streamed = '';
    }

    if (event.event_type === 'run.failed') {
      if (_streamBubble) { _streamBubble.remove(); _streamBubble = null; }
      _appendLine('Infrastructure', payload.error || 'Response failed');
      _streamed = '';
    }

    // Placeholder for native reconnect/replay: EventSource auto-reconnects
    // and our race-token guard ensures stale sessions don't bleed in.
  }

  // ── Backlog helpers (textContent only) ──

  function _appendLine(speaker, text) {
    var backlog = document.getElementById('vn-backlog');
    if (!backlog) return null;
    var line = _el('div', { className: 'line' });
    var strong = document.createElement('strong');
    strong.textContent = speaker;
    var p = document.createElement('p');
    p.textContent = text;
    line.append(strong, p);
    backlog.append(line);
    backlog.scrollTop = backlog.scrollHeight;
    return line;
  }

  // ── Lookup ──

  function _safeLookup(assets, profileId, clean) {
    return assets.expressions[clean] || profileId + '.portrait.neutral';
  }

  // ── Blink timer ──

  function _scheduleBlink() {
    _blinkTimer = setTimeout(function() {
      var p = document.getElementById('vn-portrait');
      if (p) {
        p.style.animation = 'vn-blink .3s ease';
        setTimeout(function() { p.style.animation = ''; }, 300);
      }
      _scheduleBlink();
    }, 4000 + Math.random() * 8000);
  }

  // ── Back to HQ map ──

  function _showHqView(content) {
    content.dataset.vnActive = '';
    // Force full 2D re-render regardless of _mounted state
    if (typeof window.__hqShow2d === 'function') {
      window.__hqShow2d(content);
    } else {
      content.innerHTML = '';
      if (typeof window.__hqMount === 'function') {
        window.__hqMount('hq');
      }
    }
  }

  // ── Helpers ──

  function _api(url, opts) {
    if (typeof window.api === 'function') return window.api(url, opts);
    return fetch(url, opts).then(function(r) { return r.json(); });
  }

  function _showToast(message) {
    var existing = document.querySelector('.hyrax-toast');
    if (existing) existing.remove();
    if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
    var toast = _el('div', { className: 'hyrax-toast', role: 'status' }, message);
    document.body.append(toast);
    _toastTimer = setTimeout(function() { toast.remove(); _toastTimer = null; }, 5000);
  }

  function _esc(str) {
    if (typeof str !== 'string') return '';
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Expose for hq.js / bootstrap ──
  window.__vnMount = __vnMount;
  window.__vnUnmount = __vnUnmount;
  // Re-render current VN (used by 3D "Return to VN" button)
  window.__vnReopen = function() {
    if (!_mounted || !_currentSisterId) return;
    __vnMount({ sisterId: _currentSisterId, sisterName: _currentSisterName });
  };

  // ── Listen for chibi clicks from HQ 2D map ──
  document.addEventListener('hyrax:open-conversation', function(e) {
    if (!e.detail || !e.detail.sisterId) return;
    __vnMount(e.detail);
  });

})();
