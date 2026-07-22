/**
 * Hyraxknot Division — VN Conversation Interface
 *
 * Visual novel conversation panel: portrait display, dialogue box,
 * backlog, composer, SSE event handling, expression updates.
 *
 * Called by bootstrap.js via the lazy-load hook (loadVn).
 * Listens for 'hyrax:open-conversation' custom events dispatched
 * by hq.js when a sister chibi is clicked.
 */

/* ── State ── */
let activeConversation = null;
let eventSource = null;
let streamed = '';
let streamBubble = null;
let lastExpression = { current: 'neutral', intensity: 0.5 };
let nsfwEnabled = false;
let blinkTimer = null;
let currentSisterId = null;
let currentSisterName = '';
let hqViewShown = false; // tracks whether we're on the HQ map or VN view

/* ── VN Asset definitions ── */
const VN_ASSETS = {
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
      _nsfw: ['ahegao'],
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

/* ── Panel lifecycle ── */

/**
 * Called by bootstrap.js lazy-load hook when the HQ panel is activated.
 * Sets up the event listener for chibi clicks.
 */
function loadVn() {
  document.addEventListener('hyrax:open-conversation', onOpenConversation);
}

/* ── Helpers ── */

function el(tag, attrs, ...children) {
  const elem = document.createElement(tag);
  if (attrs) {
    Object.entries(attrs).forEach(([k, v]) => {
      if (k === 'className') { elem.className = v; }
      else if (k.startsWith('data-')) { elem.setAttribute(k, v); }
      else if (typeof v === 'boolean') { if (v) elem.setAttribute(k, ''); }
      else { elem.setAttribute(k, v); }
    });
  }
  children.forEach(c => { if (c != null) elem.append(typeof c === 'string' ? document.createTextNode(c) : c); });
  return elem;
}

function $(id) { return document.getElementById(id); }

/* ── Conversation handling ── */

async function onOpenConversation(event) {
  const { sisterId, sisterName } = event.detail;
  await openConversation(sisterId, sisterName);
}

async function openConversation(profileId, name) {
  currentSisterId = profileId;
  currentSisterName = name;

  // Fetch profiles to check availability
  let profiles = [];
  try {
    const data = await api('/api/v1/profiles');
    profiles = data?.items || [];
  } catch { /* proceed */ }

  const profile = profiles.find(p => p.id === profileId);
  if (profile && !profile.enabled) {
    showToast(`${name}'s VN gateway is staged and disabled.`);
    return;
  }
  if (profile && !profile.runtime_safe) {
    showToast(`${name}'s runtime has not passed the zero-tool safety gate.`);
    return;
  }

  // Create conversation
  try {
    activeConversation = await api('/api/v1/conversations', {
      method: 'POST',
      body: JSON.stringify({ profile_id: profileId }),
    });
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Conversation unavailable');
    return;
  }

  renderVN(profileId, name);
}

async function renderVN(profileId, name) {
  // Cleanup previous
  eventSource?.close();
  if (blinkTimer) { clearTimeout(blinkTimer); blinkTimer = null; }
  nsfwEnabled = false;

  if (!activeConversation) return;
  const conversationId = activeConversation.id;
  const assets = VN_ASSETS[profileId];
  if (!assets) {
    showToast('No VN presentation contract for ' + profileId);
    return;
  }

  // Get the HQ panel container
  const content = document.getElementById('hyrax-hq-content');
  if (!content) return;

  hqViewShown = false;
  content.innerHTML = '';
  content.dataset.vnActive = 'true';

  // VN stage
  const stage = el('section', { className: 'vn-stage', style: 'background-image:linear-gradient(180deg,rgba(8,12,18,.1),rgba(8,12,18,.92)),url(\'/api/v1/assets/' + assets.background + '\')' });

  // Back button → HQ map
  const back = el('button', { className: 'vn-back' }, '← HQ');
  back.addEventListener('click', () => {
    eventSource?.close();
    showHqView(content);
  });

  // Portrait
  const exprToAsset = (expr) => {
    const clean = expr.replace(/-/g, '_');
    return safeLookup(assets, clean);
  };

  const expression = activeConversation.expression || {};
  const portrait = el('img', {
    id: 'vn-portrait',
    className: 'vn-portrait',
    src: '/api/v1/assets/' + exprToAsset(expression.current || 'neutral'),
    alt: name + ', ' + (expression.current || 'neutral'),
  });

  // Dialogue box
  const dialogue = el('div', { className: 'dialogue', 'aria-live': 'polite' });
  const header = el('div', { className: 'dialogue-name' });
  header.append(
    el('span', {}, name),
    el('span', { className: 'expression-badge', title: 'Mood: ' + (expression.current || 'neutral') + ' · Energy: ' + (expression.intensity ?? '?') },
      (expression.current || 'neutral') + (expression.auto ? '' : ' ✎'))
  );

  const backlog = el('div', { id: 'vn-backlog', className: 'backlog' });

  // Composer
  const form = el('form', { className: 'composer' });
  const input = el('textarea', { placeholder: 'Talk with ' + name + '…', rows: '2', maxlength: '20000', 'aria-label': 'Message ' + name });
  const send = el('button', { type: 'submit' }, 'Send');
  const newConv = el('button', { type: 'button', className: 'secondary' }, 'New Conversation');

  // NSFW toggle
  const nsfwToggle = el('button', { type: 'button', className: 'secondary', 'aria-label': 'Toggle intimate expressions' }, '🌶️ SFW');
  nsfwToggle.addEventListener('click', () => {
    if (!nsfwEnabled) {
      if (!window.confirm(name + ' can show more intimate expressions. These are gated behind your bond level and reset when you start a new conversation. Continue?')) return;
    }
    nsfwEnabled = !nsfwEnabled;
    nsfwToggle.textContent = nsfwEnabled ? '🌶️ NSFW' : '🌶️ SFW';
    nsfwToggle.classList.toggle('active', nsfwEnabled);
  });

  // Enter to send
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  });

  form.append(input, nsfwToggle, newConv, send);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    appendLine('Josh', text);
    input.value = '';
    send.setAttribute('disabled', 'true');
    try {
      await api('/api/v1/conversations/' + conversationId + '/turns', {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
    } catch (err) {
      appendLine('Infrastructure', err instanceof Error ? err.message : 'Run failed');
    } finally {
      send.removeAttribute('disabled');
      input.focus();
    }
  });

  newConv.addEventListener('click', async () => {
    if (!window.confirm('Start a fresh conversation? This session will be archived and available in history.')) return;
    await api('/api/v1/conversations/' + conversationId + '/archive', { method: 'POST' });
    const next = await api('/api/v1/conversations', { method: 'POST', body: JSON.stringify({ profile_id: profileId }) });
    activeConversation = next;
    backlog.replaceChildren();
    connectEvents(profileId);
  });

  dialogue.append(header, backlog, form);
  stage.append(back, portrait, dialogue);
  content.replaceChildren(stage);

  // Load existing turns
  try {
    const conv = activeConversation.turns?.length
      ? activeConversation
      : await api('/api/v1/conversations/' + conversationId);
    (conv.turns || []).forEach(turn => {
      if (turn.text) appendLine(turn.role === 'user' ? 'Josh' : name, turn.text);
    });
  } catch { /* no turns */ }

  connectEvents(profileId);
  input.focus();

  // Blink timer
  scheduleBlink();
}

/* ── NSFW-safe expression lookup ── */

function safeLookup(assets, clean) {
  if (!nsfwEnabled) {
    const blocked = (assets._nsfw || []);
    if (blocked.includes(clean)) return profileId + '.portrait.neutral';
  }
  return assets.expressions[clean] || profileId + '.portrait.neutral';
}

/* ── SSE event handling ── */

function connectEvents(profileId) {
  eventSource?.close();
  if (!activeConversation) return;
  eventSource = new EventSource('/api/v1/conversations/' + activeConversation.id + '/events');
  eventSource.onmessage = (event) => handleRunEvent(JSON.parse(event.data), profileId);
  ['message.delta', 'run.completed', 'run.failed', 'run.cancelled', 'tool.started', 'expression'].forEach(type => {
    eventSource.addEventListener(type, (event) => handleRunEvent(JSON.parse(event.data), profileId));
  });
}

function handleRunEvent(event, profileId) {
  const payload = event.payload || {};
  const assets = VN_ASSETS[profileId];
  const name = currentSisterName;

  if (event.event_type === 'expression') {
    lastExpression = { current: payload.current || 'neutral', intensity: payload.intensity ?? 0.5 };
    const badge = document.querySelector('.expression-badge');
    if (badge) badge.textContent = payload.current || 'neutral';
    const portrait = document.getElementById('vn-portrait');
    if (portrait && assets) {
      const clean = (payload.current || 'neutral').replace(/-/g, '_');
      const blocked = (assets._nsfw || []);
      const isNsfw = blocked.includes(clean);
      const assetKey = isNsfw && !nsfwEnabled
        ? profileId + '.portrait.neutral'
        : assets.expressions[clean] || profileId + '.portrait.neutral';
      portrait.src = '/api/v1/assets/' + assetKey;
      portrait.alt = name + ', ' + (payload.current || 'neutral');
    }
  }

  if (event.event_type === 'run.started') {
    streamed = '';
    streamBubble = appendLine(name, '…');
  }

  if (event.event_type === 'message.delta') {
    streamed += payload.delta || '';
    if (streamBubble) {
      const p = streamBubble.querySelector('p');
      if (p) p.textContent = streamed;
      const backlog = document.getElementById('vn-backlog');
      if (backlog) backlog.scrollTop = backlog.scrollHeight;
    }
  }

  if (event.event_type === 'tool.started') {
    const portrait = document.getElementById('vn-portrait');
    if (portrait && assets) portrait.src = '/api/v1/assets/' + assets.focused;
  }

  if (event.event_type === 'run.completed') {
    const final = payload.output || streamed;
    if (streamBubble) {
      const p = streamBubble.querySelector('p');
      if (p) p.textContent = final;
      streamBubble = null;
    } else {
      appendLine(name, final);
    }
    streamed = '';
    const portrait = document.getElementById('vn-portrait');
    if (portrait && assets) {
      const clean = lastExpression.current.replace(/-/g, '_');
      const blocked = (assets._nsfw || []);
      const isNsfw = blocked.includes(clean);
      const assetKey = isNsfw && !nsfwEnabled
        ? profileId + '.portrait.neutral'
        : assets.expressions[clean] || profileId + '.portrait.neutral';
      portrait.src = '/api/v1/assets/' + assetKey;
    }
  }

  if (event.event_type === 'run.failed') {
    if (streamBubble) { streamBubble.remove(); streamBubble = null; }
    appendLine('Infrastructure', payload.error || 'Hermes run failed');
    streamed = '';
  }
}

/* ── Backlog helpers ── */

function appendLine(speaker, text) {
  const backlog = document.getElementById('vn-backlog');
  if (!backlog) return null;
  const line = el('div', { className: 'line' });
  line.append(el('strong', {}, speaker), el('p', {}, text));
  backlog.append(line);
  backlog.scrollTop = backlog.scrollHeight;
  return line;
}

/* ── Blink timer ── */

function scheduleBlink() {
  blinkTimer = setTimeout(() => {
    const p = document.getElementById('vn-portrait');
    if (p) {
      p.style.animation = 'vn-blink .3s ease';
      setTimeout(() => { p.style.animation = ''; }, 300);
    }
    scheduleBlink();
  }, 4000 + Math.random() * 8000);
}

/* ── Back to HQ map ── */

function showHqView(content) {
  content.dataset.vnActive = '';
  // Re-trigger the HQ load
  content.innerHTML = '';
  if (typeof loadHq === 'function') {
    loadHq();
  }
}

/* ── Toast notification ── */

function showToast(message) {
  const existing = document.querySelector('.hyrax-toast');
  if (existing) existing.remove();
  const toast = el('div', { className: 'hyrax-toast', role: 'status' }, message);
  document.body.append(toast);
  setTimeout(() => toast.remove(), 5000);
}
