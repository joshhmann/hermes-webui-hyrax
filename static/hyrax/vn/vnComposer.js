/**
 * Gestalt VN revamp (vn2) — vnComposer.js
 *
 * Composer: text/attach/send/cancel/edit-last/regenerate, slash-command
 * passthrough (SPEC §4). Send path is shared with the native endpoints —
 * nothing re-implemented per mode (SPEC §3 duplicate-send prevention).
 *
 * Classic script, IIFE. Registers onto window.GestaltVN.composer.
 *
 * API:
 *   init({container})      build + wire the composer
 *   send()                 programmatic send (same path as the button)
 *   stageFiles(files)      stage File-like objects into the tray
 *   cancel()               cancel the in-flight stream
 *   editLast()             truncate + resend flow (native truncate endpoint)
 *   regenerate()           retry last turn (native retry endpoint)
 *   dispose()
 */
(function() {
  'use strict';

  var root = typeof window !== 'undefined' ? window : globalThis;
  var ns = root.GestaltVN = root.GestaltVN || {};

  var SERVER_TEXT_LIMIT = 4000; // mirrors MAX_TURN_TEXT_LENGTH server-side

  // ── State ──
  var _container = null;
  var _textarea = null;
  var _sendBtn = null;
  var _cancelBtn = null;
  var _attachBtn = null;
  var _fileInput = null;
  var _tray = null;
  var _indicator = null;
  var _staged = [];        // staged File-like objects
  var _textLimit = SERVER_TEXT_LIMIT;
  var _inFlight = false;
  var _activeStreamId = null;
  var _unsubs = [];
  var _sessionUnsub = null;
  var _disposed = true;

  function _el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = String(text);
    return e;
  }

  function _session() { return ns.session; }
  function _dialogue() { return ns.dialogue; }

  function _toast(msg) {
    if (typeof root.showToast === 'function') {
      try { root.showToast(msg); return; } catch (_) {}
    }
  }

  function _api(url, opts) {
    if (typeof root.api === 'function') return root.api(url, opts);
    return fetch(url, opts).then(function(r) { return r.json(); });
  }

  function _cur() {
    var s = _session();
    return s && typeof s.current === 'function' ? s.current() : null;
  }

  function _busy() {
    var s = _session();
    return _inFlight || !!(s && typeof s.busy === 'function' && s.busy());
  }

  function _syncBusy() {
    var busy = _busy();
    if (_sendBtn) _sendBtn.disabled = busy;
    if (_textarea) _textarea.disabled = false; // typing stays possible; send is gated
    if (_cancelBtn) _cancelBtn.hidden = !busy;
    if (_indicator) _indicator.hidden = !busy;
    if (_container) {
      if (busy) _container.classList.add('vn2-composer--busy');
      else _container.classList.remove('vn2-composer--busy');
    }
  }

  // Read the server text limit out of a turn error payload when present
  // (4000-char cap today; keeps client maxlength synced if it ever moves).
  function _adoptLimitFromError(err) {
    if (!err) return;
    var candidates = [];
    if (typeof err === 'object') {
      candidates.push(err.max_length, err.maxLength, err.limit, err.max);
      if (typeof err.message === 'string') candidates.push(err.message);
      if (typeof err.error === 'string') candidates.push(err.error);
    } else if (typeof err === 'string') {
      candidates.push(err);
    }
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (typeof c === 'number' && isFinite(c) && c > 0 && c < 1000000) {
        _applyLimit(Math.floor(c));
        return;
      }
      if (typeof c === 'string') {
        var m = c.match(/(?:max(?:imum)?(?:_length)?|limit)[^0-9]{0,20}(\d{2,6})/i);
        if (m) { _applyLimit(parseInt(m[1], 10)); return; }
      }
    }
  }

  function _applyLimit(n) {
    if (!(n > 0)) return;
    _textLimit = n;
    if (_textarea) _textarea.setAttribute('maxlength', String(n));
  }

  // ── Attachments (mirror ui.js uploadPendingFiles, single session) ──

  function _renderTray() {
    if (!_tray) return;
    _tray.replaceChildren();
    for (var i = 0; i < _staged.length; i++) {
      (function(idx) {
        var f = _staged[idx];
        var chip = _el('span', 'vn2-attach-chip');
        chip.appendChild(_el('span', 'vn2-attach-name', (f && f.name) || 'file'));
        var rm = _el('button', 'vn2-attach-remove', '×');
        rm.setAttribute('type', 'button');
        rm.setAttribute('aria-label', 'Remove attachment');
        rm.addEventListener('click', function() {
          _staged.splice(idx, 1);
          _renderTray();
        });
        chip.appendChild(rm);
        _tray.appendChild(chip);
      })(i);
    }
    _tray.hidden = _staged.length === 0;
  }

  function stageFiles(files) {
    if (!files) return;
    var list = Array.isArray(files) ? files : [files];
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      if (!f) continue;
      var dupe = false;
      for (var j = 0; j < _staged.length; j++) {
        if (_staged[j] && _staged[j].name === f.name) { dupe = true; break; }
      }
      if (!dupe) _staged.push(f);
    }
    _renderTray();
  }

  function _uploadStaged(sid) {
    if (!_staged.length) return Promise.resolve([]);
    var out = [];
    var chain = Promise.resolve();
    for (var i = 0; i < _staged.length; i++) {
      (function(f) {
        chain = chain.then(function() {
          var fd = new FormData();
          fd.append('session_id', sid);
          fd.append('file', f, f.name);
          return fetch('api/upload', { method: 'POST', credentials: 'include', body: fd })
            .then(function(res) {
              if (!res.ok) throw new Error('upload failed');
              return res.json();
            })
            .then(function(data) {
              if (data && data.error) throw new Error(String(data.error));
              out.push({
                name: String(data.filename || f.name || 'file'),
                path: String(data.path || ''),
                mime: String(data.mime || ''),
                size: Number(data.size) || 0,
              });
            });
        });
      })(_staged[i]);
    }
    return chain.then(function() { return out; });
  }

  // ── Slash commands ──
  // Passthrough to the main-chat handler where applicable; those handlers
  // operate on main-chat DOM/session, so when the entry is missing or throws
  // we degrade to a plain text send with a note (SPEC §4).

  function _trySlashCommand(text) {
    if (text.charAt(0) !== '/') return false;
    var exec = root.executeCommand;
    if (typeof exec !== 'function') return false;
    var result;
    try {
      result = exec(text);
    } catch (_) {
      _toast('That slash command needs the main chat — sent as text.');
      return false;
    }
    if (result) {
      _toast('Command handled by the main chat handler.');
      return true;
    }
    return false;
  }

  // ── Send / cancel / edit / regenerate ──

  function send(textOverride) {
    if (_disposed || !_textarea) return Promise.resolve(false);
    // Sidebar hermes-intent actions pass their message; the button path
    // reads the textarea. One shared send path (SPEC §3 duplicate-send rule).
    var text = (typeof textOverride === 'string' ? textOverride : _textarea.value).trim();
    if (!text && !_staged.length) return Promise.resolve(false);
    if (_busy()) {
      _toast('Still responding — cancel or wait for the reply to finish.');
      return Promise.resolve(false);
    }
    if (text && _trySlashCommand(text)) {
      _textarea.value = '';
      return Promise.resolve(true);
    }
    var cur = _cur();
    if (!cur) {
      _toast('No active conversation.');
      return Promise.resolve(false);
    }
    var sid = cur.sessionId;

    return _uploadStaged(sid).then(function(attachments) {
      var body = { text: text };
      if (attachments.length) body.attachments = attachments;
      return _api('/api/hyrax/vn/conversations/' + encodeURIComponent(sid) + '/turns', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    }).then(function(resp) {
      if (_disposed) return false;
      if (text) {
        var d = _dialogue();
        if (d && typeof d.appendUserMessage === 'function') d.appendUserMessage(text);
      }
      _textarea.value = '';
      _staged = [];
      _renderTray();
      _inFlight = true;
      _activeStreamId = (resp && typeof resp.stream_id === 'string') ? resp.stream_id : null;
      _syncBusy();
      try { _textarea.focus(); } catch (_) {}
      return true;
    }).catch(function(err) {
      if (_disposed) return false;
      _adoptLimitFromError(err);
      var msg = (err && err.message) ? String(err.message) : 'Run failed';
      _toast(msg);
      return false;
    });
  }

  function cancel() {
    var cur = _cur();
    var streamId = _activeStreamId || (cur && cur.activeStreamId) || '';
    if (!streamId) {
      _toast('Nothing in flight to cancel.');
      return Promise.resolve(false);
    }
    return _api('/api/chat/cancel?stream_id=' + encodeURIComponent(streamId), { method: 'GET' })
      .then(function() {
        if (_disposed) return true;
        _inFlight = false;
        _activeStreamId = null;
        _syncBusy();
        return true;
      })
      .catch(function(err) {
        _toast('Cancel failed' + ((err && err.message) ? ': ' + err.message : ''));
        return false;
      });
  }

  // Edit-last: native truncate + resend (SPEC §4). keep_count is computed
  // from the bounded transcript (user/assistant rows only) — tool rows
  // interleaved in the raw message list make this an upper-bound-safe cut:
  // it never keeps the message being edited, and may trim slightly more.
  function editLast() {
    var cur = _cur();
    if (!cur || _busy()) return Promise.resolve(false);
    var messages = cur.messages || [];
    var idx = -1;
    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && messages[i].role === 'user') { idx = i; break; }
    }
    if (idx === -1) {
      _toast('Nothing to edit yet.');
      return Promise.resolve(false);
    }
    var text = typeof messages[idx].content === 'string' ? messages[idx].content : (messages[idx].text || '');
    return _api('/api/session/truncate', {
      method: 'POST',
      body: JSON.stringify({ session_id: cur.sessionId, keep_count: idx }),
    }).then(function() {
      if (_disposed) return false;
      if (_textarea) {
        _textarea.value = text;
        try { _textarea.focus(); } catch (_) {}
      }
      var s = _session();
      if (s && typeof s.refresh === 'function') {
        try { s.refresh().catch(function() {}); } catch (_) {}
      }
      var d = _dialogue();
      if (d && typeof d.resync === 'function') d.resync();
      return true;
    }).catch(function(err) {
      _toast('Edit failed' + ((err && err.message) ? ': ' + err.message : ''));
      return false;
    });
  }

  function regenerate() {
    var cur = _cur();
    if (!cur || _busy()) return Promise.resolve(false);
    return _api('/api/session/retry', {
      method: 'POST',
      body: JSON.stringify({ session_id: cur.sessionId }),
    }).then(function() {
      if (_disposed) return false;
      _inFlight = true;
      _activeStreamId = null;
      _syncBusy();
      return true;
    }).catch(function(err) {
      _toast('Regenerate failed' + ((err && err.message) ? ': ' + err.message : ''));
      return false;
    });
  }

  // ── Lifecycle ──

  function _onStreamSettled() {
    _inFlight = false;
    _activeStreamId = null;
    _syncBusy();
  }

  function init(opts) {
    opts = opts || {};
    dispose();
    if (!opts.container) return false;
    _disposed = false;
    _container = opts.container;
    _container.classList.add('vn2-composer');

    _tray = _el('div', 'vn2-attach-tray');
    _tray.hidden = true;

    var form = _el('form', 'vn2-composer-form');
    _textarea = _el('textarea', 'vn2-input');
    _textarea.setAttribute('rows', '2');
    _textarea.setAttribute('maxlength', String(_textLimit));
    _textarea.setAttribute('placeholder', 'Type a message…');
    _textarea.setAttribute('aria-label', 'Message');

    _attachBtn = _el('button', 'vn2-btn vn2-btn--attach', '📎');
    _attachBtn.setAttribute('type', 'button');
    _attachBtn.setAttribute('aria-label', 'Attach files');
    _sendBtn = _el('button', 'vn2-btn vn2-btn--send', 'Send');
    _sendBtn.setAttribute('type', 'submit');
    _cancelBtn = _el('button', 'vn2-btn vn2-btn--cancel', 'Cancel');
    _cancelBtn.setAttribute('type', 'button');
    _cancelBtn.hidden = true;
    var editBtn = _el('button', 'vn2-btn vn2-btn--edit', 'Edit last');
    editBtn.setAttribute('type', 'button');
    var regenBtn = _el('button', 'vn2-btn vn2-btn--regen', 'Retry');
    regenBtn.setAttribute('type', 'button');

    _fileInput = _el('input', 'vn2-file-input');
    _fileInput.setAttribute('type', 'file');
    _fileInput.setAttribute('multiple', '');
    _fileInput.hidden = true;

    _indicator = _el('span', 'vn2-inflight', '…');
    _indicator.hidden = true;

    form.appendChild(_tray);
    form.appendChild(_textarea);
    var btnRow = _el('div', 'vn2-composer-buttons');
    btnRow.appendChild(_attachBtn);
    btnRow.appendChild(_sendBtn);
    btnRow.appendChild(_cancelBtn);
    btnRow.appendChild(editBtn);
    btnRow.appendChild(regenBtn);
    btnRow.appendChild(_indicator);
    form.appendChild(btnRow);
    form.appendChild(_fileInput);
    _container.appendChild(form);
    _container._form = form;

    // Enter = send, Shift+Enter = newline.
    _textarea.addEventListener('keydown', function(event) {
      if (event && event.key === 'Enter' && !event.shiftKey) {
        if (event.preventDefault) event.preventDefault();
        send();
      }
    });
    form.addEventListener('submit', function(event) {
      if (event && event.preventDefault) event.preventDefault();
      send();
    });
    _sendBtn.addEventListener('click', function(event) {
      if (event && event.preventDefault) event.preventDefault();
      send();
    });
    _cancelBtn.addEventListener('click', function() { cancel(); });
    editBtn.addEventListener('click', function() { editLast(); });
    regenBtn.addEventListener('click', function() { regenerate(); });
    _attachBtn.addEventListener('click', function() {
      try { _fileInput.click(); } catch (_) {}
    });
    _fileInput.addEventListener('change', function() {
      var files = _fileInput.files;
      if (files && files.length) stageFiles(Array.prototype.slice.call(files));
      try { _fileInput.value = ''; } catch (_) {}
    });

    // Busy state follows the event stream + session change notifications.
    var ev = ns.events;
    if (ev) {
      _unsubs.push(ev.subscribe('response.completed', _onStreamSettled));
      _unsubs.push(ev.subscribe('response.failed', _onStreamSettled));
      _unsubs.push(ev.subscribe('interruption', _onStreamSettled));
      _unsubs.push(ev.subscribe('stream.end', _onStreamSettled));
      _unsubs.push(ev.subscribe('response.token', function() {
        if (!_inFlight) { _inFlight = true; _syncBusy(); }
      }));
    }
    var s = _session();
    if (s && typeof s.on === 'function') {
      _sessionUnsub = s.on(function() { _syncBusy(); });
    }
    _syncBusy();
    return true;
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
    if (_container && _container._form) {
      try { _container._form.remove(); } catch (_) {}
      _container._form = null;
    }
    if (_container) _container.classList.remove('vn2-composer--busy');
    _container = null;
    _textarea = null;
    _sendBtn = null;
    _cancelBtn = null;
    _attachBtn = null;
    _fileInput = null;
    _tray = null;
    _indicator = null;
    _staged = [];
    _inFlight = false;
    _activeStreamId = null;
    _disposed = true;
  }

  ns.composer = {
    init: init,
    send: send,
    stageFiles: stageFiles,
    cancel: cancel,
    editLast: editLast,
    regenerate: regenerate,
    dispose: dispose,
  };
})();
