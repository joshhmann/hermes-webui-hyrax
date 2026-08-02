# Hermes WebUI — Layout Architecture

> Analyzed from `static/index.html`, `static/style.css`, `static/panels.js`, and `static/boot.js`.
> Fork base: [nesquena/hermes-webui](https://github.com/nesquena/hermes-webui)

---

## 1. Top-Level DOM Structure

```
body (height: 100dvh, flex column)
├── header.app-titlebar              (38px, flex row)
├── div.layout                       (display:flex, flex:1)
│   ├── nav.rail                     (48px narrow left column, desktop ≥768px only)
│   ├── aside.sidebar                (300px left panel, collapsible)
│   │   ├── button.mobile-sidebar-close
│   │   ├── div.sidebar-nav          (mobile nav buttons, hidden on desktop)
│   │   ├── div.panel-view.active    (SIDEBAR PANEL — one visible at a time)
│   │   │   └── session list / menu / etc.
│   │   ├── ... more panel-view divs ...
│   │   └── div.resize-handle#sidebarResize
│   ├── main.main                    (flex:1, main content area)
│   │   ├── #mainChat                (chat conversation, default view)
│   │   ├── #mainSkills, #mainMemory, ... (one per registered panel)
│   │   ├── #mainSettings            (settings sections)
│   │   └── #mainPlugin              (plugin hook)
│   ├── button.workspace-panel-edge-toggle  (toggle button for right panel)
│   └── aside.rightpanel             (300px, file browser / workspace)
└── outline / overlay / dialog / toast (fixed-position overlays)
```

### CSS Selectors for the Three Columns

| Column | Selector | Default Width | Behavior |
|--------|----------|---------------|----------|
| Left rail | `nav.rail` | 48px | Desktop-only, hidden <768px |
| Left sidebar | `aside.sidebar` | 300px | Collapsible, contains `.panel-view` divs |
| Main content | `main.main` | `flex:1` (fills remaining) | Contains `.main-view` divs |
| Right panel | `aside.rightpanel` | 300px | Collapsible (`data-workspace-panel="closed"` hides it) |

---

## 2. Where Panel Contents Render

There are **two separate rendering surfaces** for panels:

### A. Sidebar Panels (`.panel-view` inside `aside.sidebar`)

```css
.panel-view {
  display: none;            /* hidden by default */
  flex: 1;                  /* fills sidebar height */
  overflow: hidden;
  flex-direction: column;
}
.panel-view.active {
  display: flex;            /* only active one shows */
}
```

These are **300px-wide list/menu panels** in the left sidebar. Examples:
- **`#panelChat`** — session list + search
- **`#panelSkills`** — skill list
- **`#panelKanban`** — kanban task list with filters
- **`#panelMemory`** — memory section list
- **`#panelTasks`** — cron job list
- **`#panelTodos`** — todo list
- **`#panelWorkspaces`** — workspace list
- **`#panelProfiles`** — profile list
- **`#panelInsights`** — insights panel (full page in sidebar, no main-view detail)
- **`#panelLogs`** — log controls (actual log content renders in `#mainLogs`)
- **`#panelSettings`** — settings menu (actual panes in `#mainSettings`)

### B. Main-View Panels (`#main<Name>` inside `main.main`)

```css
.main-view { flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; }
main.main > #mainChat,
main.main > #mainSkills,
main.main > #mainMemory,
main.main > #mainTasks,
main.main > #mainKanban,
main.main > #mainWorkspaces,
main.main > #mainProfiles,
main.main > #mainInsights,
main.main > #mainLogs { display: none; }  /* hidden by default */
```

Visibility is controlled by `showing-<name>` classes on `<main.main>`:

```css
main.main.showing-skills > #mainSkills { display: flex; }
main.main.showing-kanban > #mainKanban { display: flex; overflow-y: auto; }
/* ... etc */
```

When **no** `showing-*` class is present, `#mainChat` is the default:

```css
main.main:not(.showing-settings):not(.showing-skills):... > #mainChat { display: flex; }
```

### The Two-Register Pattern

```javascript
// panels.js line 47
const MAIN_VIEW_PANELS = [
  'settings','skills','memory','tasks','kanban','workspaces',
  'profiles','insights','logs','plugin'
];
```

`switchPanel()` does three things:
1. Sets `.panel-view.active` on the sidebar panel `<div class="panel-view" id="panelChat">`
2. Toggles `showing-<name>` class on `<main.main>` to show the corresponding main view
3. Updates nav tab active states

**Panels in MAIN_VIEW_PANELS get BOTH a sidebar panel-view AND a main-view div.**

---

## 3. Chat Panel's Sub-Layout (Session List + Conversation)

The chat panel uses a **sidebar-for-list, main-for-content** split:

### Sidebar: `#panelChat` (`.panel-view` in `aside.sidebar`)
```
div#panelChat.panel-view.active
├── div.panel-head          → "Chat" header + "New Chat" button
├── div.session-search      → search input (.sidebar-search)
└── div.session-list        → scrollable list of conversation items
```

### Main Content: `#mainChat` (`.main-view` in `main.main`)
```
div#mainChat.main-view
├── messages-shell
│   ├── messages.messages
│   │   ├── div.empty-state          → welcome screen (logo, suggestions)
│   │   ├── div.messages-inner#msgInner  → actual conversation messages
│   │   └── ...
│   └── composer-wrap
│       ├── approval-card / clarify-card → input modals
│       ├── composer-box              → textarea, send button, model picker
│       └── ...
```

**Pattern: Sidebar lists sessions → Main area shows the active session's messages + composer.**

This applies to several other panels too — they follow a **list/detail** split:

| Panel | Sidebar (list) | Main (detail) |
|-------|----------------|---------------|
| chat | session list | `#mainChat` — conversation |
| skills | skill list | `#mainSkills` — skill detail |
| memory | memory sections | `#mainMemory` — section content |
| tasks | cron job list | `#mainTasks` — job detail |
| kanban | kanban task list | `#mainKanban` — kanban board |
| workspaces | workspace list | `#mainWorkspaces` — workspace detail |
| profiles | profile list | `#mainProfiles` — profile editor |
| logs | log file controls | `#mainLogs` — log output |
| settings | settings menu | `#mainSettings` — settings panes |

---

## 4. How the Right "Focus Drawer" (Workspace Panel) Fits

The **workspace panel** (`aside.rightpanel`) is a **300px right-side drawer** — the third column.

**CSS:**
```css
.rightpanel {
  width: 300px;
  background: var(--sidebar);
  border-left: 1px solid var(--border);
  display: flex; flex-direction: column;
  flex-shrink: 0;
  transition: width .24s ease, opacity .18s ease, transform .24s ease;
}
html[data-workspace-panel="closed"] .rightpanel { width: 0 !important; opacity: 0; }
.layout.workspace-panel-collapsed .rightpanel { width: 0 !important; opacity: 0; }
```

**Toggle:** The `.workspace-panel-edge-toggle` button on the right edge of main content opens/closes it.

**Contents:**
```
aside.rightpanel
├── div.panel-header               → "Workspace" title, actions (new file, upload, etc.)
├── div.workspace-panel-tabs        → Files | Artifacts | Todos
├── div.breadcrumb-bar              → directory navigation
├── div.file-tree#fileTree          → file browser
├── div.workspace-artifacts         → artifacts tab content
├── div.workspace-todos             → todos panel
├── div.wsEmptyState                → empty state
└── div.preview-area                → file preview (code, image, PDF, markdown, HTML)
```

The **outline panel** (`#outlinePanelWrapper`) is a **floating overlay** (position: fixed), not a layout column. It hovers over the chat area on the right side.

---

## 5. How Hyrax Panels Land — The Bug

### Current Registration (from `bootstrap.js`)

The Hyrax panels are injected **only into the sidebar's `.panel-view` container**:

```javascript
// bootstrap.js
const panelsContainer = document.querySelector('aside.sidebar');
// ... creates div.panel-view inside aside.sidebar
div.className = 'panel-view';
div.innerHTML = '<div class="panel-page"><div class="page-header"><h2>' + p.label + '</h2></div><div class="panel-content" id="hyrax-' + p.id + '-content"></div></div>';
```

And registered into `MAIN_VIEW_PANELS`:
```javascript
if (typeof MAIN_VIEW_PANELS !== 'undefined') {
  HYRAX_PANELS.forEach(p => {
    if (!MAIN_VIEW_PANELS.includes(p.id)) MAIN_VIEW_PANELS.push(p.id);
  });
}
```

### The Problem

1. **`bootstrap.js` pushes `projects`, `warroom`, etc. into `MAIN_VIEW_PANELS`**, which causes `switchPanel()` to add `showing-projects` to `<main>` — but there's **no `#mainProjects` div** inside `<main>` to show.

2. **HQ and VN content renders in the sidebar's `.panel-view` div** (300px wide) — completely wrong for an isometric map or a visual novel. Content that should fill the main area is squeezed into the left column.

3. **No `#main<Name>` containers exist** for Hyrax panels. The CSS has no `main.main.showing-hq > #mainHq { display:flex; }` rule.

4. **Sidebar `.panel-view` containers use `.panel-page` / `.page-header` / `.panel-content` classes** — these are **not defined in `style.css`** and **not in `hyrax.css`** either. They have zero styling, so headers and content appear unstyled.

### The Fix (Applied — t_d92e87b7)

**For content-heavy panels (HQ, VN, War Room, etc.):**
- ✅ `#mainHq` injected into `<main.main>` alongside `#mainChat` (index.html)
- ✅ CSS rules added: `main.main.showing-hq > #mainHq { display: flex; }` (hyrax.css)
- ✅ Sidebar `#panelHq` is minimal — header only, no `.panel-content` (bootstrap.js)
- ✅ `hq.js` + `vn.js` render directly into `#mainHq` (`replaceChildren`)
- Content persists across panel switches (data-rendered guard on `#mainHq`)

**For list-oriented panels (Projects, Verify, Promises):**
- Still using the sidebar `.panel-view` for the list
- No corresponding `#main<Name>` yet — future work when detail views are needed
- This matches the existing pattern (skills, tasks, workspaces, etc.)

---

## 6. Living HQ (hq.js / bootstrap.js behavior layer)

The HQ panel is the fork's home surface, not just another panel:

- **HQ-first landing** — `bootstrap.js` runs `maybeLandOnHq()` after the app
  settles (window `load`, or a deferred `setTimeout`). If the URL carries no
  explicit intent (`?session=`, `/session/<id>`, `?panel=`, `?q=`, `#session=`)
  and `localStorage['hyrax-home'] !== 'chat'`, it calls `switchPanel('hq')`.
  `?panel=hq` opens HQ regardless of the stored pref. Explicit intents are
  never hijacked. A `.hq-home-toggle` text button in the HQ header flips the
  pref between `hq` and `chat`.
- **War-room strip** — a full-width `button.hq-warroom` under the HQ header
  sums kanban `running`/`blocked` across the sisters (from
  `GET /api/hyrax/presence`) and renders one text chip per sister with
  non-zero counts or a current task. When presence carries the sister's
  `currentTask`, the chip shows the task title truncated to 28 chars
  ("Tai · Refactor gateway retry backo…", full title + counts in the chip
  `title` tooltip); otherwise it shows bare counts ("Mai 0 run · 2 blk").
  Zero totals read "War room — all clear". Clicking it calls
  `switchPanel('kanban')` (no per-assignee filtering).
- **Activity-driven placement** — chibis are positioned by a `data-room`
  attribute (CSS attribute selectors per room id) instead of per-sister
  `left/top` rules. The pure `roomFor(sister, presence)` helper implements
  `ACTIVITY_ROOM`: conversing→common, waiting-approval→director,
  resting→coffee, idle→common, tool-working/background-working/offline/
  unavailable→the sister's own room (label→id lookup from `HQ_SISTERS.room`).
  Co-located sisters get `data-slot` 0–3 offsets so they don't overlap.
  `left/top/margin` transitions animate room changes.
- **Presence refresh** — a 30s `setInterval` (armed on mount, cleared in
  `__hqUnmount`) calls `refreshPresence()` only when `<main>` has
  `showing-hq` AND `document.visibilityState === 'visible'`. Refresh updates
  `data-room`/`data-slot`, activity classes, approval dots, the war-room
  strip, and the time-of-day tint. The same fetch (initial render + every
  refresh) feeds fresh `derivedState` presentation intents
  (`poseIntent`/`sceneIntent` from essenced, Phase B) into
  `GestaltVN.essence.state` — `feedEssencePresentation()` maps them to
  `presentation.pose`/`presentation.location`, so the VN intent pipeline
  picks up derived pose/scene changes through this polling path with no
  new polling.
- **Embodiment** — `chibi-active-<type>` classes drive CSS-only animations
  (tool-working bob, conversing speech dots, pulsing approval dot, resting
  "zZ"), all wrapped in `@media (prefers-reduced-motion: no-preference)`.
  The `.iso-floor` gets `hq-time-dawn/day/dusk/night` from the local hour on
  each render/refresh; CSS applies a subtle `::after` tint.
- **Two conversation affordances** — chibi click on the map dispatches
  `hyrax:open-conversation` (VN stage, unchanged); operator sidebar card
  click opens STANDARD chat: `POST /api/hyrax/vn/conversations`
  `{profile_id, fresh:false}` → `loadSession(session_id)` →
  `switchPanel('chat')`. Cards disable while the request is in flight.

---

## 6b. Approvals panel (approvals.js — added 2026-08-02)

The D3 Josh approval-tier panel follows the HQ fix pattern end-to-end:

- Registered in `HYRAX_PANELS` (`bootstrap.js`) as a `mainView` panel with
  `sidebarFallback: 'hq'` — while it's active the sidebar keeps the
  Operators view. Mount/unmount dispatch is per-panel (`MOUNT_HOOKS` /
  `UNMOUNT_HOOKS` → `window.__approvalsMount` / `__approvalsUnmount`).
- `#mainApprovals` is injected into `<main.main>` as an empty container
  (`MAIN_ONLY_PANELS`); `approvals.js` renders into it on mount.
- CSS channel in hyrax.css mirrors HQ:
  `main.main.showing-approvals > #mainChat { display: none !important; }`
  and `main.main.showing-approvals > #mainApprovals { display: flex !important; }`.
- Deep link: `maybeLandOnHq()` honors `?panel=<any hyrax panel id>` (hq,
  approvals) regardless of the stored home pref.
- Data: `GET /api/hyrax/essence/approvals` (30s visibility-gated poll, same
  cadence as HQ presence; the same poll maintains a pending-count
  `.hyrax-nav-badge` on the rail/sidebar nav buttons) and
  `POST /api/hyrax/essence/approvals/respond`. A filed decision renders as
  "… filed — waiting for her next tick…" until a poll confirms the request
  left the pending list — the panel never pretends essenced already acted
  (same covenant as the whims dismiss).

## 7. Summary of Key Selectors

| Purpose | Selector | File (line) |
|---------|----------|-------------|
| Top-level flex layout | `div.layout` | index.html:153 |
| Left rail (desktop icons) | `nav.rail` | index.html:154 |
| Left sidebar container | `aside.sidebar` | index.html:169 |
| Sidebar panel container | `div.panel-view` | style.css:2151 |
| Active sidebar panel | `div.panel-view.active` | style.css:2152 |
| Sidebar resize handle | `div#sidebarResize` | index.html:397 |
| Main content area | `main.main` | index.html:399 |
| Main view containers | `div.main-view` (as `#mainChat`, etc.) | style.css:4876 |
| Main view header | `.main-view-header` | style.css:6354 |
| Main view body | `.main-view-body` | style.css:6361 |
| Right panel (workspace) | `aside.rightpanel` | style.css:2785 |
| Right panel collapsed | `html[data-workspace-panel="closed"] .rightpanel` | style.css:2935 |
| Workspace toggle button | `button.workspace-panel-edge-toggle` | index.html:1672 |
| Outline (floating drawer) | `#outlinePanelWrapper` | style.css:7179 |
| Panel head (sidebar header) | `.panel-head` | style.css:4904 |
| Session list (chat sidebar) | `div#sessionList` | index.html:204 |
| Session search | `.session-search` | index.html:203 |
| Main chat messages | `div#messages` | index.html:440 |
| Channel toggle class | `main.main.showing-<name>` | style.css:4887-4896 |
| Composer box | `div#composerBox` | index.html:583 |
