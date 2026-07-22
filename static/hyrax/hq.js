/**
 * Hyraxknot Division — HQ Isometric Map Panel
 *
 * Renders the Division HQ as an isometric map with 9 rooms and
 * sister chibis. Integrates with the VN panel by dispatching
 * custom events that vn.js listens for.
 *
 * Called by bootstrap.js via the lazy-load hook (loadHq).
 */

/* ── Room definitions ── */
const HQ_ROOMS = [
  { id: 'security',  label: 'Security Alcove' },
  { id: 'common',    label: 'Common Area' },
  { id: 'coffee',    label: 'Coffee Station' },
  { id: 'corridor',  label: 'Main Corridor' },
  { id: 'director',  label: "Director's Office" },
  { id: 'ops',       label: 'Operations Hub' },
  { id: 'lab',       label: 'Research Lab' },
  { id: 'logistics', label: 'Logistics Annex' },
  { id: 'entrance',  label: 'Entrance' },
];

/* ── Sister chibi definitions ── */
const HQ_SISTERS = [
  { id: 'tai', name: 'Tai',  room: 'Operations Hub',   role: 'implementation' },
  { id: 'rei', name: 'Rei',  room: 'Security Alcove',   role: 'verification'  },
  { id: 'nei', name: 'Nei',  room: 'Research Lab',      role: 'contracts'     },
  { id: 'mai', name: 'Mai',  room: 'Logistics Annex',   role: 'blocked triage'},
];

/* ── Expression aliases (mirrors server-side mapping) ── */
const EXPRESSION_ALIASES = {
  amused: 'smile', happy: 'smile', grinning: 'laughing',
  calm: 'light-smile', annoyed: 'scream-of-fury', shy: 'shy-smile',
  mischievous: 'yandere-smile', playful: 'ohhoai', deadpan: 'neutral',
  thinking: 'focused', surprised: 'ohhoai', concerned: 'focused',
};

/**
 * Load the HQ panel — sets up the isometric map if not already built.
 * Called automatically by bootstrap.js when the HQ nav tab is clicked.
 */
async function loadHq() {
  const content = document.getElementById('mainHq');
  if (!content) return;

  // Already rendered? Just refresh presence.
  if (content.dataset.rendered) {
    refreshPresence();
    return;
  }

  content.innerHTML = '<p class="muted">Loading Division HQ…</p>';

  try {
    renderHQLayout(content);
    content.dataset.rendered = 'true';
  } catch (err) {
    content.innerHTML = '<div class="empty"><p>Failed to load HQ.</p><p class="muted">' + esc(err.message || 'Unknown error') + '</p></div>';
  }
}

/* ── Layout renderer ── */

function renderHQLayout(container) {
  // Page wrapper
  const page = document.createElement('div');
  page.className = 'hq-page';

  // Header
  const head = document.createElement('div');
  head.className = 'page-head';
  head.innerHTML = '<p class="eyebrow">SPATIAL OVERVIEW</p>'
    + '<h1>Division Headquarters</h1>'
    + '<p class="muted">Click a sister\'s chibi to open a conversation.</p>';
  page.appendChild(head);

  // Map stage
  const stage = document.createElement('div');
  stage.className = 'map-stage';

  // Iso floor
  const floor = document.createElement('div');
  floor.className = 'iso-floor';
  floor.setAttribute('aria-label', 'Isometric Division HQ map');

  // Render rooms
  HQ_ROOMS.forEach(r => {
    const room = document.createElement('div');
    room.className = 'room room-' + r.id;
    room.textContent = r.label;
    floor.appendChild(room);
  });
  stage.appendChild(floor);

  // Fetch profiles for presence data, then add chibis
  fetchProfiles().then(profiles => {
    HQ_SISTERS.forEach(s => {
      const chibi = createChibi(s, profiles);
      stage.appendChild(chibi);
    });
  }).catch(() => {
    // Profiles unavailable — render chibis without presence data
    HQ_SISTERS.forEach(s => {
      const chibi = createChibi(s, []);
      stage.appendChild(chibi);
    });
  });

  page.appendChild(stage);
  container.replaceChildren(page);
}

/* ── Chibi element factory ── */

function createChibi(sister, profiles) {
  const chibi = document.createElement('button');
  chibi.className = 'chibi chibi-' + sister.id;
  chibi.setAttribute('aria-label', 'Talk with ' + sister.name);

  const img = document.createElement('img');
  img.src = '/api/v1/assets/' + sister.id + '.chibi.stand';
  img.alt = '';
  img.loading = 'lazy';

  const name = document.createElement('strong');
  name.textContent = sister.name;

  const role = document.createElement('span');
  role.textContent = sister.role;

  chibi.appendChild(img);
  chibi.appendChild(name);
  chibi.appendChild(role);

  // Presence gating
  const profile = profiles.find(p => p.id === sister.id);
  if (!profile || !profile.enabled || !profile.runtime_safe) {
    chibi.classList.add('staged');
  }

  // Click → dispatch custom event that vn.js catches
  chibi.addEventListener('click', function onClick() {
    const event = new CustomEvent('hyrax:open-conversation', {
      detail: { sisterId: sister.id, sisterName: sister.name, role: sister.role },
      bubbles: true,
    });
    document.dispatchEvent(event);
  });

  return chibi;
}

/* ── Presence data ── */

/**
 * Fetch sister profiles/presence from the API.
 * Returns an empty array if the endpoint isn't available yet,
 * so chibis render unconditionally in the shell.
 */
async function fetchProfiles() {
  try {
    const data = await api('/api/v1/profiles');
    return data?.items || [];
  } catch {
    return [];
  }
}

/**
 * Refresh chibi staged state — called on revisit without rebuilding the DOM.
 */
async function refreshPresence() {
  const profiles = await fetchProfiles();
  HQ_SISTERS.forEach(s => {
    const chibiEl = document.querySelector('.chibi-' + s.id);
    if (!chibiEl) return;
    const profile = profiles.find(p => p.id === s.id);
    if (!profile || !profile.enabled || !profile.runtime_safe) {
      chibiEl.classList.add('staged');
    } else {
      chibiEl.classList.remove('staged');
    }
  });
}
