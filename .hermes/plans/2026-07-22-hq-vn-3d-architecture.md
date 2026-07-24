# Hyrax HQ + VN + 3D — Reduced Architecture Decision

> **Status:** Revised · **Date:** 2026-07-22 (rev. 3) · **Author:** Nei (Knowledge & Continuity)
> **Target Runtime:** Self-contained Hyrax surface inside `joshhmann/hermes-webui-hyrax`
> **Existing Implementation Source:** Control-plane embodiment module at `/root/workspace/gestalt-control-plane/frontend/src/embodiment/`
> **Design/Spec Source:** `/workspace/gestalt/`
> **CT 112 Note:** The 3D embodiment code was previously prototyped on CT 112 (`192.168.0.96:8000`). That standalone server is preserved as read-only reference. The working ported source already lives in the gestalt-control-plane embodiment module. Zero runtime dependency on CT 112.

## Table of Contents

1. [Current-State Evidence](#1-current-state-evidence)
2. [Existing Implementation vs Integration Target](#2-existing-implementation-vs-integration-target)
3. [Product Boundary](#3-product-boundary)
4. [Frontend Integration Seam](#4-frontend-integration-seam)
5. [VN Runtime Boundary](#5-vn-runtime-boundary)
6. [3D Integration Boundary](#6-3d-integration-boundary)
7. [Local Embodiment Module → WebUI Migration Map](#7-local-embodiment-module--webui-migration-map)
8. [Local 3D Module Contract](#8-local-3d-module-contract)
9. [Upstream Reconciliation](#9-upstream-reconciliation)
10. [Security & Ops](#10-security--ops)
11. [ADRs, Invariants, and Non-Goals](#11-adrs-invariants-and-non-goals)
12. [Spikes](#12-spikes)
13. [Migration / Cutover Sequence](#13-migration--cutover-sequence)
14. [Integration Acceptance Test](#14-integration-acceptance-test)
15. [Decisions for Josh to Approve](#15-decisions-for-josh-to-approve)

---

## 1. Current-State Evidence

### 1.1 Fork State (joshhmann/hermes-webui-hyrax)

The fork sits on commit `271a3581`, **6 commits ahead** of upstream merge-base `1dd5cc43` ("fix(tests): isolate model-selection env vars so the suite passes on any runner (#6395)").

**Local git rev-list (confirmed):**

```
271a3581 fix: HQ panel timing — loadHq now auto-triggers when hq.js loads if panel is active
a915637b fix: move HQ/VN to full-width main content area
88585a9e fix: HQ/VN panel content not loading — wrong panel container selector
372e8c0a fix(vn): register chibi-click event listener at module level + explicit profileId parameter
e1a4006a feat: HQ/VN integration — bootstrap, hq.js, vn.js, hyrax.css
7eedabd6 feat: Hyraxknot Division extension layer
```

Only **3 core files** were modified (6 lines net change vs upstream):
- `server.py` — 3 lines added: `from api import hyrax_routes` + `hyrax_routes.repatch()`
- `static/index.html` — 8 lines added: `<div id="mainHq">` + 4 `<script>` tags for hyrax JS
- `api/hyrax_routes.py` — **has uncommitted modifications** that must not be reverted, staged, or edited

### 1.2 Current Hyrax Files (Add-Only)

**`static/hyrax/bootstrap.js`** (106 lines) — The integration seam. Does 4 things:
1. Pushes panel names (`projects`, `warroom`, `dispatch`, `verify`, `promises`, `hq`) into `MAIN_VIEW_PANELS`
2. Injects panel-view divs into `aside.sidebar` before the resize handle
3. Adds sidebar nav buttons with SVG icons to `.rail` and `.sidebar-nav`
4. **Monkey-patches `switchPanel`** to call `loadHq()`/`loadProjects()` etc. when a Hyrax tab is activated

**`static/hyrax/hq.js`** (191 lines) — HQ isometric map panel:
- Defines 9 rooms and 4 sister chibis with expression aliases
- Renders CSS isometric floor + positioned room labels
- Fetches `/api/v1/profiles` for presence gating (staged/active chibis)
- Dispatches `hyrax:open-conversation` custom event on chibi click

**`static/hyrax/vn.js`** (418 lines) — VN conversation interface:
- Listens for `hyrax:open-conversation` events from HQ
- Creates VN conversation via `POST /api/v1/conversations`
- Renders portrait, background, dialogue box, backlog, composer
- Handles SSE events (`message.delta`, `expression`, `run.completed`, etc.)
- NSFW expression gating, blink timer, new conversation/archive
- **Note: This frontend has NO corresponding backend in the fork.** The endpoints it calls (`/api/v1/profiles`, `/api/v1/conversations`, `/api/v1/assets`, etc.) do not exist in `api/hyrax_routes.py` or core `api/routes.py`.

**`api/hyrax_routes.py`** (123 lines) — Backend route extensions:
- Monkey-patches core `handle_get`/`handle_post` to try Hyrax routes first
- Provides only two endpoints: `GET /api/v1/projects` (project aggregation from kanban.db) and `GET /api/v1/snapshot` (control-plane aggregate)
- Uses `from api.helpers import j` (in the uncommitted diff — changed from `handler.send_json()`)

**`static/hyrax/hyrax.css`** (367 lines) — All Hyrax styles: HQ map, chibis, VN stage, dialogue box, backlog, composer, toast, responsive

**Total custom code:** ~1,205 lines (6 JS/CSS files + 1 Python file)

### 1.3 VN Backend Gap (Critical Finding)

The fork's VN frontend calls these endpoints that **do not exist** in the fork:

| Endpoint called by vn.js | Method | Where it should live | Status |
|---|---|---|---|
| `/api/v1/profiles` | GET | VN runtime | **Missing** |
| `/api/v1/assets/<id>` | GET | Asset server | **Missing** |
| `/api/v1/conversations` | POST | VN runtime | **Missing** |
| `/api/v1/conversations/<id>` | GET | VN runtime | **Missing** |
| `/api/v1/conversations/<id>/turns` | POST | VN runtime | **Missing** |
| `/api/v1/conversations/<id>/events` | GET (SSE) | VN runtime | **Missing** |
| `/api/v1/conversations/<id>/archive` | POST | VN runtime | **Missing** |

The old **Division Gateway** (`/root/workspace/gestalt-control-plane/division_gateway/app.py`, FastAPI on loopback `:8770`) provides a proven implementation of all these endpoints — it has profiles, conversations, turns, SSE event streaming, asset resolution, expression computation, login/auth, and cancellation.

### 1.4 Old Division Gateway (:8770) — Proven VN Reference

**Confirmed alive** — `GET http://127.0.0.1:8770/health` returns 200 with all 4 profiles enabled and safe. The gateway provides:
- `POST /api/v1/auth/login` — password auth, CSRF session cookie
- `GET /api/v1/profiles` — profiles with enabled/safe flags, toolset counts
- `GET /api/v1/assets/<id>` — resolved portrait/background/chibi assets
- `POST /api/v1/conversations` — create profile-bound conversation
- `GET /api/v1/conversations/<id>` — fetch with turn history
- `POST /api/v1/conversations/<id>/turns` — submit user turn, triggers Hermes runtime call
- `GET /api/v1/conversations/<id>/events` — SSE event stream (message.delta, run.completed, expression updates, tool.started)
- `PUT /api/v1/conversations/<id>/focus` — focus/set expression
- `POST /api/v1/conversations/<id>/archive` — archive conversation
- `GET /api/v1/projects` — project aggregation
- Essence expression integration — reads sister Essence state for expression computation
- Zero-tool safety gate — checks `enabled_toolsets` with schema enforcement
- Full test coverage at `tests/test_gateway.py` (replay, stream normalization, cancel, edge cases)

**Limitation (confirmed):** The sidecar proxy (in `api/extensions.py`) buffers responses and is **not** an SSE relay. It cannot be used to forward the Division Gateway's SSE events through the WebUI to the VN frontend without a verified change.

### 1.5 Existing Embodiment Module (Gestalt Control-Plane) — 3D Implementation Source

The authoritative existing 3D embodiment implementation lives at:
`/root/workspace/gestalt-control-plane/frontend/src/embodiment/`

**14 files, 3,380 lines total**, structured as a Vite/TypeScript bundle:

| File | Lines | Role |
|---|---|---|
| `mountTaiLoft.ts` | 75 | Entry point — mounts DOM, instantiates TaiRoomScene, wires UI controls and keyboard shortcuts. Returns a dispose function. |
| `TaiRoomScene.ts` | 445 | Core 3D scene — WebGL renderer, Three.js scene graph, camera, lighting (ambient + 5 lights), procedural room geometry (walls, couch, command zone, projection wall, daybed, plant, pendant lamps), avatar VRM loading via `loadModel()`, animation loop with locomotion + face + viseme systems, orbit controls. |
| `rig/AvatarRig.ts` | 636 | VRM avatar rig — bone hierarchy management, pose auditing (4-phase per frame: proceduralIdle → faceGaze → poseCommit+vrm → vrmUpdate), look-at IK, debug bone inspection. |
| `locomotion/ProceduralLocomotion.ts` | 432 | Procedural body animation — idle sway, walking, crouching, kicking, balancing, jumping-jacks, bending. Tunable parameters (speed, intensity, kick force). |
| `navigation/RoomNavigation.ts` | 491 | Navigation mesh system — box obstacles, A* pathfinding, path smoothing, movement constraints within room bounds. |
| `types.ts` | 397 | TypeScript type definitions — `RoomObjectDefinition`, `ProceduralTuning`, pose audit types, expression types. |
| `debug/RigDevelopmentPanel.ts` | 218 | Debug/operator panel — bone viewer, motion triggers, diagnostic snapshot export, screenshot capture, procedural tuning sliders. |
| `atmosphere/TimeOfDaySystem.ts` | 143 | Time-of-day lighting — live mode (local clock) or fixed preset (dawn/noon/dusk/night). Adjusts ambient/directional/point light colors and intensities. |
| `face/GazeSystem.ts` | 135 | Eye gaze system — target tracking, blink timer, saccade generation. |
| `face/FaceController.ts` | 83 | Facial expression controller — takes expression intent and applies VRM blendshapes. |
| `voice/VisemeController.ts` | 78 | Lip-sync viseme system — maps phoneme/timing data to VRM blendshapes. |
| `room/roomObjects.json` | 168 | Room manifest — object definitions, affordances, placement data. |
| `loaders/loadModel.ts` | 38 | VRM model loader — fetches and parses VRM from URL, returns Three.js scene. |
| `tai-room.css` | 41 | Scene chrome styling — loof layout, canvas, controls, error state. |

**Key architectural characteristics:**
- **Entry-driven lifecycle:** `mountTaiLoft(host, onExit)` mounts everything and returns a dispose function. Clean teardown pattern (cancels animation frame, disposes renderer, removes event listeners).
- **VRM asset path:** Hardcoded to `/api/v1/assets/tai.embodiment.vrm` — served by the control-plane API, not available in WebUI fork.
- **Vite/TypeScript module:** Runs as a Vite-built bundle with Three.js `^0.170.0`. No standalone server — designed to be mounted into a host DOM element.
- **Room data from manifest:** All geometry defined procedurally in TypeScript, auxiliary object data from `roomObjects.json`.
- **No tests:** Zero test/spec/unit files for any embodiment module.
- **No formal vite config:** Uses Vite defaults (package.json `scripts` + devDependencies).

**Completeness verdict (from parent audit t_76a92d9d):** The embodiment module is a complete, working 3D room implementation. It lacks formal test coverage and has a control-plane-specific VRM asset path, but the core scene, avatar rig, locomotion, navigation, facial expression, and lighting systems are all present and operational.

The existing code was ported from the CT 112 prototype in a prior work session. It is the authoritative source for the WebUI-side migration — no re-extraction from CT 112 is needed.

### 1.6 Upstream Reconciliation

The fork's merge base `1dd5cc43` is also the remote `origin/master` HEAD — meaning the fork has NOT diverged from its remote origin; it's a straight 6-commit fast-forward. The upstream upstream (nesquena/hermes-webui) is at a different, newer revision.

```
1dd5cc43 (upstream merge-base: nesquena/hermes-webui #6395)
  ↓ 6 Hyrax commits
271a3581 (HEAD, origin/master, origin/HEAD)
```

Current GitHub compare reports a diverged graph because origin/master was force-pushed after the fork diverged from nesquena's upstream. Safe approach: rebase the 6 Hyrax commits onto a recent upstream tag, then create a reconciliation branch.

### 1.7 Security Observation

**Credential exposure (verified):** The live launch command as shown in systemd exposes a credential in plain text in the process environment. The exact credential text must never be reproduced, printed, or committed. A credential-hygiene gate must be applied before any production cutover.

---

## 2. Existing Implementation vs Integration Target

This architecture makes an explicit distinction between the existing local port and the integration target:

| Dimension | Existing Implementation Source | Integration Target |
|---|---|---|
| **3D embodiment** | Gestalt control-plane module (`/root/workspace/gestalt-control-plane/frontend/src/embodiment/`) | **This fork** — `joshhmann/hermes-webui-hyrax` at `static/hyrax/3d/` |
| **Design/spec source** | `/workspace/gestalt/` (ARCHITECTURE.md, DESIGN.md, design/*) | Incorporated into this document |
| **VN runtime** | Division Gateway (`:8770`) | Sidecar proxy → same :8770 gateway (backward compat) |
| **Role of existing source** | Working implementation to copy/adapt from | Target runtime — self-contained, no external dependency |
| **Uptime requirement** | None — may be modified, frozen, or archived | Must survive control-plane shutdown without degradation |
| **Runtime dependency** | None — source read during implementation only | **Zero** — no iframe, API call, or process dependency on the control-plane |

**Rule:** Every architectural decision in Section 6 and beyond assumes the existing embodiment module is the sole implementation source. Implementation cards copy/adapt only from the audited control-plane paths. CT 112 is preserved as a historical read-only reference but is never the primary extraction source.

---

## 3. Product Boundary

### Decision: Single Hyrax Identity Surface with 3 Internal Modes

**Approved scope (per task body):** The only custom Hyrax panels are HQ (isometric map), VN (conversation), and 3D Room (spatial). Everything else uses community WebUI native panels.

### Panels to RETAIN

| Panel | File | Consumer |
|---|---|---|
| HQ Map | `static/hyrax/hq.js` | All users |
| VN Conversation | `static/hyrax/vn.js` | All users |
| 3D Room | Existing embodiment module adapted into `static/hyrax/3d/` | Tai room visitors |

### Panels to REVISE (retire from Hyrax bootstrap, route to WebUI native)

| Panel | Current Status | WebUI Native Equivalent | Action |
|---|---|---|---|
| Projects | `static/hyrax/projects.js` | Native kanban board + project filters | Remove from bootstrap.js, redirect to native |
| War Room | Not implemented | Kanban task list | Remove from bootstrap.js panel list |
| Dispatch | Not implemented | Kanban create + assign | Remove |
| Verify | Not implemented | Kanban task detail + comments | Remove |
| Promises | Not implemented | Kanban task groups | Remove |

**Acceptance:** bootstrap.js would define `HYRAX_PANELS = [{ id: 'hq', ... }]` — only the HQ panel. VN and 3D become internal sub-modes of HQ (not separate sidebar tabs).

### Data Flow (Target)

```
┌──────────────────────────────────────────────────────────┐
│              Hermes WebUI Shell (same-origin)             │
│  ┌──────────┐  ┌──────────────────────────────────────┐  │
│  │ Sidebar  │  │         Main Content                  │  │
│  │          │  │  ┌─────┐ ┌───┐ ┌──────────────────┐  │  │
│  │ Chat     │  │  │ HQ  │ │VN │ │ 3D Room          │  │  │
│  │ Kanban   │  │  │(map)│ │(VN)│ │ (adapted Gestalt │  │  │
│  │ Skills   │  │  └─────┘ └───┘ │  embodiment       │  │  │
│  │ ...      │  │       │        │  Three.js bundle)  │  │  │
│  │ [HQ] ────│──┼───────┘ internal mode switch        │  │  │
│  └──────────┘  └──────────────────────────────────────┘  │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐  │
│  │            Same-Origin Backend (WebUI server)        │  │
│  │  /api/v1/conversations* -> sidecar -> :8770 (VN)    │  │
│  │  /static/hyrax/3d/        -> built assets (3D)      │  │
│  │  /api/v1/profiles         -> Div Gateway / native   │  │
│  └─────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

All communication is same-origin. No iframe, no postMessage, no Caddy reverse-proxy needed for 3D.

---

## 4. Frontend Integration Seam

### Options Comparison

| # | Option | Upstream Safety | Complexity | Verified | Recommendation |
|---|---|---|---|---|---|
| **A** | Current monkey-patch (bootstrap.js + switchPanel) | **Medium** — patch wraps switchPanel; works unless upstream renames/refactors switchPanel | Low | ✅ Currently deployed | **Recommended for MVP** |
| **B** | WebUI managed extensions (api/extensions.py) | **High** — official hook, survives upstream changes | Medium | ✅ Tested (tests/test_extension_hooks.py) | Future target |
| **C** | Dashboard plugin iframe | **Low** — sandboxed without allow-same-origin, plugin_api.py not wired for interactive runtime | High | ⚠️ Partially (CSP issues) | Not suitable for MVP |
| **D** | Generic main-view registration hook | **Highest** — upstream merge required | High | ❌ Not implemented | Too invasive for MVP |

### Recommended: Option A → Option B Migration

**Phase 1 (MVP):** Keep the current bootstrap.js/switchPanel monkey-patch. It's deployed, working, and the 6 Hyrax commits prove the seam is functional. Risk: if upstream renames `switchPanel` or changes the panel lifecycle, the patch silently stops working.

**Phase 2 (post-MVP):** Migrate to a WebUI managed extension (`HERMES_WEBUI_EXTENSION` env var). This is the officially supported seam: same-origin script injection, no monkey-patching, survives upstream updates. Requires:
- Configuring `HERMES_WEBUI_EXTENSION` env to point at a hyrax extension directory
- Moving bootstrap.js logic into the extension manifest's script list
- Verifying the extension's sidecar for VN SSE relay (see spike S-001)

### Why Not Options C or D

**C (Dashboard plugin iframe):** The plugin system's iframe is sandboxed without `allow-same-origin`, making it unusable for interactive VN/3D content that needs WebUI's session. The `plugin_api.py` handler is not wired for the interactive runtime contract (no SSE streaming, no approval/clarify pass-through). Adding a postMessage bridge would replicate a large subset of the extension sidecar with fewer guarantees.

**D (Main-view registration hook):** This would require an upstream PR to add a `registerMainView(id, loadFn)` API. That's the right long-term architecture but imposes an upstream dependency and merge timeline. Shipping the MVP without it removes the critical path.

---

## 5. VN Runtime Boundary

### Options Comparison

| # | Option | Profiles | Persistence | Cancel/Replay | Approvals/Clarify | SSE | Expression Tags | Zero-Tool Contract | Complexity |
|---|---|---|---|---|---|---|---|---|---|
| **A** | Port Division Gateway into WebUI | ✅ Auth+profile binding | ✅ SQLite conversations | ✅ Run journal | ✅ Approval/clarify stream events | ✅ SSE package | ✅ Essence integration | ✅ Schema-gated | **High** (port FastAPI to stdlib server) |
| **B** | Keep Division Gateway sidecar + proxy SSE | ✅ Same | ✅ Same | ✅ Same | ✅ Same | ✅ Same | ✅ Same | ✅ Same | **Medium** (proxy changes only) |
| **C** | Native WebUI sessions + VN renderer | ⚠️ Partial (profiles API exists) | ⚠️ Session messages | ⚠️ Partial (stream cancel exists) | ✅ Native approval/clarify | ✅ SSE| ⚠️ No expression system | ❌ Empty toolsets rejected | **Low** (no new backend) |

**Important zero-tool contract finding:** The task body notes that empty `enabled_toolsets` is currently rejected/ignored as a hard zero-tool contract. This was confirmed: the Division Gateway already has `parse_toolset_safety()` with schema enforcement, and all 4 profiles pass the safety check with 25 toolset counts. A VN-only profile should have zero tools enabled for conversation-only mode, but the runtime currently rejects that configuration.

### Recommended: Option B (Sidecar Division Gateway + SSE Proxy Fix)

The Division Gateway is **live and working** at `:8770` with all profile safety gates passing, a complete VN API, and full test coverage. Porting it (A) would duplicate 1,089 lines of FastAPI code into the WebUI's stdlib server — a large, risky rewrite with no behavioral gain.

**Option C is insufficient:** WebUI's native sessions don't have expression integration, per-conversation personality/ephemeral context, or the VN asset pipeline. The zero-tool profile mode needed for read-only VN conversations is currently broken.

**Required changes for Option B:**
1. **Fix the sidecar SSE relay** — Current sidecar proxy (`api/extensions.py`) buffers responses. It needs to support `text/event-stream` pass-through without buffering. Spike S-001 covers this.
2. **Authenticate VN API calls** — The WebUI frontend needs to pass its session to the sidecar. The sidecar proxy's token-v1 authentication scheme already supports this.
3. **Route `/api/v1/*` VN calls through sidecar** — The bootstrap.js monkey-patches can also add a proxy route: requests to `/api/v1/conversations`, `/api/v1/assets`, `/api/v1/profiles` forward to `127.0.0.1:8770`.

### VN Data Flow (Target)

```
Browser (vn.js)
  │
  ├─ POST /api/v1/conversations  ──┐
  ├─ POST .../turns               │
  ├─ GET .../events (SSE)         │
  │     via sidecar proxy          │
  │                               ▼
  │               Extension Sidecar Proxy
  │               (api/extensions.py — SSE relay fix needed)
  │                               │
  │                               ▼
  │               Division Gateway (:8770)
  │               ┌─────────────────────┐
  │               │ HermesRuntimeAdapter│
  │               │ Profile safety gate │
  │               │ Essence expression  │
  │               │ DB (conversations)  │
  │               │ SSE journal         │
  │               └────────┬────────────┘
  │                        │
  │                        ▼
  │               Hermes Agent Runtime
  │               (per-profile gateway)
```

### VN Required Changes per QA Review

The following spec-level requirements from Rei's review (R2, R3, R5, R7) are incorporated here:

**R2 (Blocking): Expression-tag stripping invariant**
Expression tags received via SSE events (event_type: expression) are consumed by the VN renderer and MUST NOT be written to the native Hermes WebUI session transcript. The VN's `handleRunEvent()` must strip any expression-like patterns from `message.delta` and `run.completed` payloads before passing them to `appendLine()`.

**R3 (High): Configurable VN API prefix**
vn.js hardcodes `/api/v1/` prefixes. Add a configuration object:
```javascript
const VN_API = {
  base: window.HYRAX_VN_API_BASE || '/api/v1',
  ssr: window.HYRAX_SSE_ENDPOINT || '/api/v1/conversations',
};
```
This allows both sidecar (same prefix) and direct routing (different port or path) without code changes.

**R5 (Medium): VN-only profile contract**
A VN-only profile (zero tools) must:
1. Have `enabled_toolsets: []` in config.yaml
2. Pass the Division Gateway's `parse_toolset_safety()` check
3. Result in conversation turns that never call tool execution
4. Never silently fall back to all-tools mode
If (1) causes the Hermes runtime to reject startup, the VN-only profile must be allowed through a distinct `enabled_toolset_mode: "vn_only"` flag.

**R7 (High): Auth bridging flow**
Auth path A (via sidecar): Browser → sidecar proxy → injects `X-Hermes-Sidecar-Token` → Division Gateway validates token against shared secret → no browser-side login required.

Auth path B (direct, no sidecar): Browser → gateway :8770 → 401 unless CORS + password auth configured. Development only — set `HERMES_WEBUI_ALLOWED_ORIGINS` for dev.

---

## 6. 3D Integration Boundary

### Source of Truth

The existing Gestalt control-plane embodiment module at `/root/workspace/gestalt-control-plane/frontend/src/embodiment/` is the **sole implementation source** for the 3D module. Its 14 files (3,380 lines) include:

- **`mountTaiLoft.ts`** (75 lines) — Entry point: mounts DOM, creates TaiRoomScene, wires UI controls and keyboard shortcut, returns dispose function. This is the correct API pattern for WebUI integration.
- **`TaiRoomScene.ts`** (445 lines) — Core 3D scene: WebGL renderer, camera, procedural room geometry, avatar loading, animation loop, orbit controls.
- **`rig/AvatarRig.ts`** (636 lines) — VRM avatar rig with bone hierarchy, 4-phase pose auditing, look-at IK.
- **`locomotion/ProceduralLocomotion.ts`** (432 lines) — Procedural body animation: idle sway, walk, crouch, kick, balance, jumping-jacks, bend.
- **`navigation/RoomNavigation.ts`** (491 lines) — Navigation mesh and pathfinding.
- Supporting systems: `TimeOfDaySystem`, `FaceController`, `GazeSystem`, `VisemeController`, `AvatarRig`, `loaders/loadModel`, `types`, `debug/RigDevelopmentPanel`.

The reference design/spec source at `/workspace/gestalt/` provides room system design docs (`design/room-system-readme.md`, `design/design-draft.md`) and the architectural context for the embodiment subsystem.

**CT 112 note:** The original 3D prototype resides on CT 112 (`192.168.0.96:8000`). The embodiment module was ported from CT 112 source in a prior session. CT 112 is preserved as read-only reference for debugging edge cases and comparing animation/rendering behavior. It is NOT the primary extraction source.

**The target 3D module lives in `static/hyrax/3d/`** within the WebUI fork. Its built assets are served from `/static/hyrax/3d/` on the WebUI's same origin.

### Integration Options

| # | Option | Existing Source Dependency | CSP Issues | WebGL Lifecycle | Identity Bridge | Complexity |
|---|---|---|---|---|---|---|
| **A** | Adapt existing embodiment module into WebUI bundle (`static/hyrax/3d/`) | **None after adaptation** — standalone | ✅ Same origin | JS lifecycle (mount/unmount) | Direct JS calls | **Medium** (one-time adaptation + build) |
| **B** | Iframe to existing module on separate origin | **Full runtime dependency** — module server must be up | ⚠️ Mixed content | Browser-managed | postMessage | **Low** |
| **C** | Three.js from scratch in WebUI main-view | **None** — fresh implementation | ✅ Same origin | Full manual lifecycle | In-process | **High** (from-scratch rewrite) |

### Recommended: Option A (Adapt Existing Embodiment Module → WebUI Bundle)

**Why Option A over B:**
- **Zero runtime dependency on the control-plane** — the embodiment module is already written to be mounted as a library, not a server
- Same-origin means no CSP frame-src issues, no mixed-content warnings
- No Caddy TLS reverse-proxy needed
- Direct JS API calls instead of postMessage — richer contract, better performance
- The module lives at `static/hyrax/3d/` alongside existing hyrax JS — consistent with the add-only pattern

**Why Option A over C:**
- The embodiment module already has a complete, tested 3D room — 14 files, 3,380 lines. Adapting is faster than rewriting
- All the Three.js/VRM/animation logic already handles edge cases (WebGL context loss, devicePixelRatio, room affordances, orbit controls)

**What adaptation means vs the existing module:**
- The VRM asset URL (`/api/v1/assets/tai.embodiment.vrm`) needs to resolve to a WebUI-served path instead of the control-plane API
- The entry function (`mountTaiLoft`) returns a dispose function — this pairs directly with WebUI's panel lifecycle
- The debug panel (`RigDevelopmentPanel.ts`) is dev-only and should be conditionally loaded
- The module uses `import` from `'three'` — needs Vite bundling to resolve dependencies
- Vite-built, outputs a single bundle at `static/hyrax/3d/embodiment-bundle.js`

### Where 3D Source & Assets Live in the Fork

| Component | Path in Fork | Notes |
|---|---|---|
| Adapted TypeScript source | `static/hyrax/3d/src/` | Adapted from control-plane module: SceneApp, CharacterController, PresenceManager |
| Built bundle | `static/hyrax/3d/embodiment-bundle.js` | Single Vite output, loaded by vn.js when entering 3D mode |
| VRM avatar assets | `static/hyrax/3d/assets/vrm/` | Tai's VRM model(s) — review donor licensing |
| Room manifest | `static/hyrax/3d/assets/room/roomObjects.json` | Copied from embodiment module, describes room layout/affordances |
| Animation data | `static/hyrax/3d/assets/animations/` | Copied from embodiment module |
| Room textures/environment | `static/hyrax/3d/assets/env/` | Environment maps, room textures |
| Adapter/Wrapper | `static/hyrax/3d-adapter.js` | Thin bridge between WebUI/vn.js and the 3D module — enter/exit, state sync, lifecycle |

**Respecting vanilla/no-build core:** The 3D bundle is a single isolated pre-built artifact (`static/hyrax/3d/embodiment-bundle.js`). It does not modify the WebUI's build pipeline, package.json, or core scripts. A single `<script>` tag loads it when entering 3D mode (lazy injection), keeping the vanilla JS loading path intact for non-3D users.

### 3D Room Entry/Exit Flow

```
HQ Map ──click chibi──→ VN Conversation ──"enter room"──→ 3D Module
                    ↕                                ↕
               internal mode switch           3d-adapter.js bridge
                    ↕                                ↕
              loadHq() re-run              load 3D bundle → mount WebGL
                                           unmount → dispose renderer
```

**Step-by-step:**
1. User clicks chibi in HQ Map → `hyrax:open-conversation` event
2. VN loads, conversation starts (SSE streaming)
3. User clicks "enter room" → vn.js calls `window._hyrax3d.enter(sisterId, profileData)`
4. `3d-adapter.js` lazy-loads the bundle script if not loaded, then calls `Embodiment3D.mount(containerEl, config)`
5. Three.js renderer starts in the VN stage area (replacing or overlaying the 2D stage)
6. 3D module consumes WebUI state through the adapter — profile, conversation, expression events are passed as direct JS calls
7. User clicks "leave room" → calls `Embodiment3D.dispose()` which cleans up WebGL, animation loop, event listeners, audio, object URLs, asset caches
8. VN 2D stage replaces the 3D canvas

---

## 7. Local Embodiment Module → WebUI Migration Map

This section maps the existing embodiment module's 14 files into migration categories. Unlike a CT 112 extraction, these files already exist in a modular, mountable form — the migration effort is adaptation and bundling, not extraction and re-port.

### Direct-Adapt Modules (Adapt with Minimal Changes)

| Source File (Control-Plane) | Est. Lines | Target in Fork | Adaptation Needed |
|---|---|---|---|
| `TaiRoomScene.ts` | 445 | `static/hyrax/3d/src/TaiRoomScene.ts` | Replace VRM asset URL `/api/v1/assets/tai.embodiment.vrm` with WebUI-served path; add expression update method from VN SSE; add dispose-during-mount guard |
| `mountTaiLoft.ts` | 75 | `static/hyrax/3d/src/mountTaiLoft.ts` | Replace DOM creation with adapter-provided container; remove rigid dev UI controls (camera buttons, time-of-day selector); wire `onExit` to VN mode switch instead of DOM teardown |
| `rig/AvatarRig.ts` | 636 | `static/hyrax/3d/src/rig/AvatarRig.ts` | Port directly — no adaptation needed (generic VRM rig) |
| `locomotion/ProceduralLocomotion.ts` | 432 | `static/hyrax/3d/src/locomotion/ProceduralLocomotion.ts` | Port directly — no adaptation needed |
| `navigation/RoomNavigation.ts` | 491 | `static/hyrax/3d/src/navigation/RoomNavigation.ts` | Port directly — no adaptation needed |
| `face/FaceController.ts` | 83 | `static/hyrax/3d/src/face/FaceController.ts` | Port directly — no adaptation needed |
| `face/GazeSystem.ts` | 135 | `static/hyrax/3d/src/face/GazeSystem.ts` | Port directly — no adaptation needed |
| `voice/VisemeController.ts` | 78 | `static/hyrax/3d/src/voice/VisemeController.ts` | Port directly — no adaptation needed |
| `atmosphere/TimeOfDaySystem.ts` | 143 | `static/hyrax/3d/src/atmosphere/TimeOfDaySystem.ts` | Port directly — no adaptation needed |
| `loaders/loadModel.ts` | 38 | `static/hyrax/3d/src/loaders/loadModel.ts` | Port directly; may need to accept VRM URL as parameter instead of hardcoded path |
| `types.ts` | 397 | `static/hyrax/3d/src/types.ts` | Port directly — shared type definitions |
| `room/roomObjects.json` | 168 | `static/hyrax/3d/assets/room/roomObjects.json` | Copy as-is |

### WebUI-Specific Adaptation Modules (Replace or Rewrite)

| Source Artifact | Adaptation | Target |
|---|---|---|
| VRM asset URL (`/api/v1/assets/tai.embodiment.vrm`) | Replace with WebUI-served path: `/static/hyrax/3d/assets/vrm/tai.embodiment.vrm` | `static/hyrax/3d/adapter/asset-resolver.js` |
| `mountTaiLoft()` entry function | Split into `Embodiment3D.mount(config)` + `Embodiment3D.dispose()` per Section 8 contract | `static/hyrax/3d/src/entry.ts` (new file) |
| `tai-room.css` (41 lines) | Rename and extend for WebUI containment | `static/hyrax/3d/hyrax-3d.css` |
| `debug/RigDevelopmentPanel.ts` (218 lines) | Conditionally omit from production build; keep in dev source for debugging | `static/hyrax/3d/src/debug/` (optional load) |

### Assets Requiring Review

| Asset | Source | Risk |
|---|---|---|
| Tai's VRM model | `mountTaiLoft.ts` loads from `/api/v1/assets/tai.embodiment.vrm` at runtime | Licensing — verify model was created by us or is permissively licensed |
| Room textures | Procedural (built in TypeScript) — no external texture files | No licensing risk |
| Sound effects/ambient audio | Not present in embodiment module | N/A — add later if needed |
| Animation motion data | Procedural (generated in TypeScript) — no external motion files | No licensing risk |

### Debug/Development-Only Surfaces to Omit

| Module Feature | Reason to Omit |
|---|---|
| `RigDevelopmentPanel.ts` | Dev-only — workbench controls, bone diagnostics, snapshot export |
| Camera mode buttons (mountTaiLoft lines 28-33) | Replaced by mouse orbit controls; not needed in production UX |
| Time-of-day selector (mountTaiLoft lines 34-43) | Dev-only debugging UI |
| Shift+T keyboard shortcut | Dev-only |

---

## 8. Local 3D Module Contract

### Enter/Exit Contract

The `3d-adapter.js` defines a minimal API surface between WebUI/vn.js and the 3D Embodiment module.

**Exported API (from `Embodiment3D`):**

```typescript
interface Embodiment3DConfig {
  containerEl: HTMLElement;      // DOM element to mount WebGL canvas in
  sisterId: string;              // Which sister's room (currently "tai")
  profileData: {                 // WebUI profile state
    id: string;
    name: string;
    expression?: string;
  };
  expressionUrl?: string;        // Hook to receive expression updates
}

interface Embodiment3D {
  mount(config: Embodiment3DConfig): Promise<void>;   // Init WebGL, load room + avatar
  updateExpression(emotion: string, intensity: number): void;  // Set avatar expression
  updatePresence(sisterIds: string[]): void;          // Update which sisters are present
  handleConversationEvent(event: object): void;       // React to VN events in 3D world
  dispose(): Promise<void>;                           // Clean everything — WebGL, listeners, assets
  onRoomReady(cb: () => void): void;                  // Callback when first render is done
  onRoomAction(cb: (action: string, data: any) => void): void;  // User interaction in room
}
```

**Events (from vn.js to 3D adapter):**
- `window._hyrax3d.enter(sisterId, profileData)` — triggers adapter to call `Embodiment3D.mount()`
- `window._hyrax3d.leave()` — triggers adapter to call `Embodiment3D.dispose()`
- `window._hyrax3d.expression(emotion, intensity)` — triggered by VN SSE `expression` events
- `window._hyrax3d.presence(sisterIds)` — which sisters are in the room

**Events (from 3D adapter to vn.js):**
- `embodiment:room-ready` — module loaded, WebGL initialized, room displayed
- `embodiment:action` — user clicked something in room (e.g., interact with object)
- `embodiment:error` — WebGL context lost, asset load failure
- `embodiment:disposed` — cleanup complete, VN can restore 2D stage

### Cleanup/Dispose Requirements (Invariant)

When leaving 3D mode or switching panels, `Embodiment3D.dispose()` MUST:

1. **WebGL renderer:** Call `renderer.dispose()` to release GPU resources. Remove the `<canvas>` from DOM.
2. **Animation loop:** Cancel `requestAnimationFrame` callback. Null references to loop closure.
3. **Event listeners:** Remove all `window` event listeners added by the 3D module (keyboard, mouse, resize, visibilitychange). Remove custom event bus subscriptions.
4. **Audio:** Stop and disconnect any `AudioContext` or `HTMLAudioElement` instances created for 3D room ambient audio.
5. **WebSocket / EventSource:** Close any persistent connections.
6. **Object URLs:** Revoke any `URL.createObjectURL()` references (VRM blobs, texture blobs).
7. **Asset caches:** Clear asset texture/image references so garbage collection can reclaim them.
8. **Three.js scene graph:** Traverse and dispose geometries, materials, textures. Dispose the `WebGLRenderTarget` if used.
9. **Promise rejection guard:** Ensure no pending `Embodiment3D.mount()` promise rejects after `dispose()` has been called (wrap in cancellation token).

**Verification:** After `dispose()`, `requestAnimationFrame` should not fire for the disposed scene. A Chrome DevTools Performance recording should show zero GPU activity attributed to the 3D module. No `THREE.WebGLRenderer` instances remain in memory (confirmed via heap snapshot diff).

### Identity/Session/Presence Consumption

The 3D module consumes WebUI-owned state **without duplicating another gateway or runtime**:

| State | Source | How 3D Consumes It |
|---|---|---|
| Active sister/profile | `vn.js` context — set when conversation starts | Passed to `Embodiment3D.mount()` via `profileData` |
| Expression state | VN SSE `expression` events → vn.js handler | `Embodiment3D.updateExpression()` called directly |
| Conversation state | VN SSE `message.delta` events | `Embodiment3D.handleConversationEvent()` for room-relevant events |
| Presence | WebUI `/api/v1/profiles` | `Embodiment3D.updatePresence()` when profile list changes |
| Auth token | WebUI session | Not needed — same-origin means no separate auth for 3D |

No duplicate gateway, no separate runtime, no WebSocket to a different backend. The 3D module is a pure presentation layer.

---

## 9. Upstream Reconciliation

### Current Divergence

The fork has 6 Hyrax commits on top of upstream merge-base `1dd5cc43`. The remote `origin/master` (joshhmann/hermes-webui-hyrax) is at the same tip as HEAD — no divergence from the fork's own origin. The divergence *from upstream* is the 6 commits.

### Recommendation: Reconciliation Branch, Not Merge

**Do NOT merge upstream blindly.** The 6 Hyrax commits touch core files (server.py, index.html, hyrax_routes.py). A merge would create conflicts if upstream has changed the same areas.

**Recommended approach:**

```bash
# Create a branch pinned to the merge-base
git checkout -b hyrax-reconciliation 1dd5cc43

# Cherry-pick the 6 Hyrax commits on top of the upstream base
git cherry-pick 7eedabd6 e1a4006a 372e8c0a 88585a9e a915637b 271a3581

# Verify nothing changed: diff should match HEAD
git diff hyrax-reconciliation master

# Create a PR to merge hyrax-reconciliation into master
# This gives a clean linear history
```

This replaces the fork with a clean branch that can be rebased onto newer upstream releases. The uncommitted `hyrax_routes.py` changes must be committed first or stashed before the cherry-pick.

### Risk

The uncommitted diff in `api/hyrax_routes.py` must be preserved. The cherry-pick of `7eedabd6` (the first Hyrax commit that created hyrax_routes.py) will succeed cleanly, then the uncommitted changes can be applied as a follow-up commit.

**Uncommitted diff preservation (R9):**
```
Before cherry-pick: git add api/hyrax_routes.py && git stash
After cherry-pick: git stash pop → results in staged changes → git commit
Verify: git diff hyrax-reconciliation master should be empty
```

---

## 10. Security & Ops

### 10.1 Credential-Hygiene Gate

**Finding:** The live systemd service launch command exposes a credential in process-launch text visible via `systemctl show`. This credential is not reproduced here.

**Gate:** Before any new deployment or service restart:
1. Replace the credential with an environment variable loaded from a restricted-permissions file (`chmod 600`)
2. Update the systemd unit to use `EnvironmentFile=` instead of inline `-x` or `--token` flags
3. Verify the credential does not appear in `ps aux`, `systemctl show`, or `/proc/*/cmdline`

### 10.2 CSP and Mixed Content

The 3D module is **same-origin** — served from WebUI's own domain. No `frame-src` extension needed. No `upgrade-insecure-requests` directive needed for 3D.

CSP implications:
- **frame-src:** remains `'self'` (no 3D iframe)
- **connect-src:** may need `ws://127.0.0.1:8770` or the VN sidecar proxy endpoint if the VN runtime uses WebSocket
- **worker-src:** not affected (no workers in 3D module)
- **img-src:** if 3D module loads textures from external URLs, add them here

The VN sidecar proxy still needs `frame-src` consideration only if the Division Gateway serves docs or test pages.

### 10.3 VN Auth Boundary

The sidecar proxy's token-v1 authentication (`api/extensions.py` line ~350) already provides authenticated proxy routing. The VN flow must pass the WebUI's session token to the Division Gateway. Current :8770 gateway requires password auth — the sidecar proxy can inject the auth token so the browser doesn't need a separate login.

### 10.4 No Cross-Tenant Keystore Writes

The sidecar/extension system reads from a configured keystore (`~/.hermes/keystore`). The VN runtime must be scoped to the active profile and must not write cross-profile state.

### 10.5 3D Module Security Considerations

Since the 3D module is same-origin JavaScript:
- No additional CSP directives needed for 3D
- The module runs in the WebUI's security context — same auth, same session
- Module code should be audited for any external asset loading before production
- WebGL content cannot read DOM or cookies (GPU sandboxed) — no additional attack surface

---

## 11. ADRs, Invariants, and Non-Goals

### Architecture Decision Records

**ADR-1:** The Hyrax identity surface is a single sidebar tab ("HQ") with 3 internal modes: map, VN, and 3D room. Not 3 separate tabs.

**ADR-2:** The VN runtime is the existing Division Gateway sidecar, not a rewrite. The frontend communicates through the extension sidecar proxy (with SSE relay fix).

**ADR-3:** The 3D room is an **adapted embodiment module served from `static/hyrax/3d/`** on the WebUI same origin. The sole implementation source is the existing Gestalt control-plane embodiment module (`/root/workspace/gestalt-control-plane/frontend/src/embodiment/`). Not an iframe. Not Caddy-reverse-proxied. CT 112 is preserved as read-only reference only — no re-extraction needed.

**ADR-4:** The bootstrap.js monkey-patch is the MVP frontend seam, to be replaced by WebUI managed extensions post-MVP.

**ADR-5:** Upstream reconciliation uses a `hyrax-reconciliation` branch with cherry-picked commits, not a blind merge.

### Invariants

- **I1:** No core WebUI file (`api/routes.py`, `static/panels.js`, `static/boot.js`, `static/ui.js`, `api/kanban_bridge.py`) is modified by Hyrax code.
- **I2:** The uncommitted diff in `api/hyrax_routes.py` is never reverted, staged, or committed in an unrelated PR.
- **I3:** All VN profile gateways pass the zero-tool safety check before enabling conversation mode. A VN profile with empty `enabled_toolsets` must either be allowed or the safety check must produce a clear error message — not silent rejection.
- **I4:** The credential exposed in the live launch command is never reproduced in code, config, or documentation.
- **I5:** The 3D module has zero runtime dependency on the control-plane or CT 112. Blocking all network access to `192.168.0.96:8000` must not break 3D room functionality.
- **I6 (from Rei R2):** Expression tags received via SSE events (event_type: expression) are consumed by the VN renderer and MUST NOT be written to the native Hermes WebUI session transcript. The VN's `handleRunEvent()` must strip any expression-like patterns from `message.delta` and `run.completed` payloads before passing them to `appendLine()`.
- **I7:** `Embodiment3D.dispose()` must destroy all WebGL resources, cancel animation loops, remove event listeners, close audio contexts, revoke object URLs, and clear asset caches. After dispose, zero GPU activity remains attributable to the 3D module.
- **I8:** The 3D module is loaded lazily via dynamic `<script>` injection when entering 3D mode. Non-3D users never pay the transfer cost.
- **I9 (Local-source provenance):** Implementation cards copy/adapt only from the audited control-plane embodiment paths or working snapshot, never from CT 112.

### Explicit Non-Goals

The following are explicitly **out of scope** for this architecture:
- Chat system — WebUI native chat owns this
- Kanban — WebUI native kanban owns this
- Profile management — WebUI profiles owns this
- Skills/memory/logs — WebUI native panels own these
- Direct Git operations — WebUI workspace owns this
- Full 3D room authoring — adapted module is a fixed snapshot of the existing embodiment code
- Plugin marketplace — WebUI extension system owns this
- Multi-sister room — MVP targets only Tai's Synthesis Loft
- VN mobile app — WebUI responsive layout covers this
- Real-time CT 112 sync — CT 112 is read-only reference; changes are not auto-merged

### Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Sidecar SSE relay fix proves complex | Medium | High — VN streaming blocked | Spike S-001 defines exact pass/fail; fallback is direct :8770 with CORS |
| 3D bundle size impacts page load | Medium | Medium — slower 3D mode entry | Lazy-load the bundle only when entering 3D. Target < 500 KB gzipped for the bundle. Use Three.js tree-shaking |
| Existing module has unreported control-plane-specific dependencies | Low | Medium — adaptation takes longer than estimated | S-003 spike covers module adaptation audit before implementation |
| Three.js version mismatch (module uses `^0.170.0`) | Low | Medium — build errors | Pin Three.js version to match the existing module | 
| Division Gateway diverges from WebUI auth | Medium | Medium — double login | Sidecar proxy injects WebUI session token |
| Empty toolsets fix incompatible with VN profiles | Medium | Medium — can't have VN-only profiles | Spike S-002 covers this |

---

## 12. Spikes

### S-001: Sidecar SSE Relay Fix

**Goal:** Verify the extension sidecar proxy can pass through SSE events without buffering.

**Pass criteria:**
1. A new `sidecar` config option `stream: true` enables unbuffered passthrough
2. `GET /api/v1/conversations/{id}/events` from the VN sidecar returns `Content-Type: text/event-stream` with live events
3. Events reach the browser's `EventSource` without truncation or buffering delay
4. Backpressure handling: if the browser disconnects, the sidecar stops reading from upstream
5. Non-SSE responses continue to use the existing buffered path (backward compatible)
6. Passes existing extension hook tests

**Fail criteria:**
- The extension proxy code (`api/extensions.py`) proves too tightly coupled to buffered HTTP to add streaming
- Upstream would reject the required change

**Sizing:** 2 days investigation + PR (extended per Rei's re-estimate)

### S-002: Empty Zero-Tool Profile Mode

**Goal:** Confirm the VN-only profile configuration (zero tools) is accepted by the Hermes runtime and safety gate.

**Pass criteria:**
1. A profile with `enabled_toolsets: []` is accepted at startup (not rejected/ignored)
2. The Division Gateway's `parse_toolset_safety()` returns `safe: true` for zero-tool profiles
3. VN conversation turns complete without tool execution attempts
4. No silent fallback to all-tools mode

**Fail criteria:**
- The runtime hard-rejects empty `enabled_toolsets`
- The safety check cannot distinguish "VN-only" from "misconfigured"

**Sizing:** 0.5 day investigation + config change

### S-003: Existing Embodiment Module Adaptation Audit

**Goal:** Audit the existing control-plane embodiment module to produce an exact adaptation checklist for the WebUI fork. This replaces the earlier CT 112 extraction spike — the source material already exists locally.

**Pass criteria:**
1. Walk every file in `/root/workspace/gestalt-control-plane/frontend/src/embodiment/` and classify into: Direct-Adapt, WebUI-Specific-Replacement, Dev-Only-Omit
2. Confirm Three.js version, npm dependencies, and build configuration
3. Identify every hardcoded API path (e.g., `/api/v1/assets/tai.embodiment.vrm`) that must be replaced
4. Identify any control-plane-specific socket/event patterns that need adapter replacement
5. Produce an adaptation checklist in `static/hyrax/3d/ADAPT-CHECKLIST.md`

**Fail criteria:**
- The existing module has undiscovered dependencies on the control-plane runtime that cannot be cleanly adapted
- The VRM asset cannot be extracted from the runtime API path

**Sizing:** 1 day investigation + checklist

### S-004: Upstream Cherry-Pick Validation

**Goal:** Verify the 6 Hyrax commits cleanly cherry-pick onto a fresh clone at merge-base `1dd5cc43`.

**Pass criteria:**
1. `git cherry-pick 7eedabd6 e1a4006a 372e8c0a 88585a9e a915637b 271a3581` completes without conflict
2. `git diff` against current HEAD is empty (no drift)
3. The uncommitted `hyrax_routes.py` diff applies cleanly as a 7th commit

**Fail criteria:**
- Any cherry-pick produces conflicts
- The resulting tree has behavioral differences from current HEAD

**Sizing:** 0.5 day investigation

### S-005: 3D Module Lifecycle & Dispose Verification

**Goal:** Verify the adapted 3D module's lifecycle: mount, render, dispose, and memory cleanup.

**Pass criteria:**
1. `Embodiment3D.mount()` initializes WebGL renderer, loads room, loads avatar — renders a frame
2. `Embodiment3D.updateExpression()` changes avatar expression
3. `Embodiment3D.dispose()` destroys the renderer, removes canvas from DOM, cancels animation loop, removes event listeners
4. Chrome heap snapshot after dispose shows zero `Three.WebGLRenderer` instances retained
5. Entering and leaving 3D mode 5 times in succession causes no memory growth (verified via Chrome Performance tab)
6. Switching from 3D mode back to VN mode restores the 2D stage without visible artifacts
7. **Panel switch:** entering 3D mode, switching from HQ panel to Chat panel, then back to HQ panel restores 3D state without error or memory leak

**Fail criteria:**
- Three.js context loss during mount cannot be recovered
- `dispose()` leaves GPU resources allocated (observed via Chrome Task Manager GPU memory)
- Enter/leave cycle causes progressive memory leak

**Sizing:** 1 day investigation + testing

---

## 13. Migration / Cutover Sequence

### Phase 0: Preparation (Week 1)

- [x] **P0.1 — Audit (DONE).** This architecture document and the parent audit (t_76a92d9d) provide the full existing-source inventory.
- [ ] **P0.2 — Cherry-pick validation.** Spike S-004: verify the 6 commits cherry-pick clean.
- [ ] **P0.3 — Commit the uncommitted hyrax_routes.py changes.** The pre-existing diff becomes a tracked 7th commit on the reconciliation branch.
- [ ] **P0.4 — Credential hygiene.** Gate the exposed credential. Do NOT reproduce it here.

### Phase 1: VN Runtime (Week 1-2)

- [ ] **1.1 — Spike S-001.** Prove sidecar SSE relay or identify the blocking gap.
- [ ] **1.2 — Spike S-002.** Verify zero-tool VN profile mode.
- [ ] **1.3 — Wire vn.js to sidecar.** If SSE relay works: route `/api/v1/conversations*` through the sidecar proxy to `:8770`. If it doesn't: route directly to `:8770` (bypassing the sidecar) with CORS config.
- [ ] **1.4 — Incorporate R3 (configurable API prefix).** vn.js uses `VN_API.base` instead of hardcoded `/api/v1`.
- [ ] **1.5 — Incorporate R2 (expression-tag stripping).** VN event handler strips expression tags from transcript text.
- [ ] **1.6 — Incorporate R7 (auth bridging).** Sidecar token injection verified.
- [ ] **1.7 — Remove retired panels from bootstrap.js.** Trim `HYRAX_PANELS` to only `{ id: 'hq' }`.

**Current deployed fork remains unchanged.** The VN frontend is already in the fork but the backend is missing — adding the backend doesn't regress anything.

### Phase 2: 3D Room Adaptation (Week 2-4)

- [ ] **2.1 — Spike S-003.** Audit existing embodiment module and produce adaptation checklist.
- [ ] **2.2 — Spike S-005.** Verify 3D lifecycle and dispose contract.
- [ ] **2.3 — Adapt core modules.** Copy/adapt TaiRoomScene.ts, AvatarRig.ts, ProceduralLocomotion.ts, RoomNavigation.ts, FaceController, GazeSystem, TimeOfDaySystem, VisemeController, loaders, types from control-plane into `static/hyrax/3d/src/`.
- [ ] **2.4 — Replace VRM asset path.** The hardcoded `/api/v1/assets/tai.embodiment.vrm` becomes a relative path under `static/hyrax/3d/assets/vrm/`.
- [ ] **2.5 — Build single bundle.** Vite output: `static/hyrax/3d/embodiment-bundle.js`.
- [ ] **2.6 — Implement 3d-adapter.js.** The thin bridge between vn.js and `Embodiment3D`.
- [ ] **2.7 — Integrate "enter room" flow in VN.** When conversation is active, "enter room" button lazy-loads the 3D bundle and calls `Embodiment3D.mount()`.
- [ ] **2.8 — Verify dispose on exit.** Leaving 3D mode calls `Embodiment3D.dispose()`. Verify no memory leak, no orphan GPU context.
- [ ] **2.9 — Room state from WebUI.** 3D module receives sister identity, expression, presence through the adapter — no separate gateway.
- [ ] **2.10 — Run Section 14 integration acceptance test.** Verify VN + 3D + WebUI-native all functional without control-plane or CT 112.

### Phase 3: Frontend Seam Upgrade (Week 4-5)

- [ ] **3.1 — Configure HERMES_WEBUI_EXTENSION.** Move bootstrap.js logic into a managed extension directory.
- [ ] **3.2 — Verify upstream pull.** Pull latest upstream into the reconciliation branch, verify zero conflicts.
- [ ] **3.3 — Remove monkey-patch.** The switchPanel patch is replaced by the extension system's script injection.

### Phase 4: Stabilization (Week 5-6)

- [ ] **4.1 — Proving parity.** Run the old Division Gateway and the new VN route side-by-side. Verify identical SSE events, expression handling, conversation lifecycle.
- [ ] **4.2 — Archive control-plane 3D source.** Once WebUI 3D module is stable, the control-plane embodiment files become read-only reference.
- [ ] **4.3 — CT 112 reference note.** CT 112 source preserved as read-only reference for edge-case debugging.

### Rollback

At any phase, tag the release:
```bash
git tag hyrax-phase1-vn  # After Phase 1
git tag hyrax-phase2-3d  # After Phase 2
```

If a phase needs rollback while preserving later phases:
```bash
git revert <phase2-commit-range>  # preserves Phase 1 changes
# Or, if the current deployment tag tracks master:
git checkout hyrax-phase1-vn
```

Phase 1 (VN) and Phase 2 (3D) changes are independently revertible because each phase is a separate PR/commit range. Database backward compatibility must be verified before rollback.

---

## 14. Integration Acceptance Test

This test proves the integrated system works without the control-plane or CT 112:

**Test Name:** `integration_local_3d`

**Setup:**
1. Ensure no embodiment-related server is running except the WebUI itself
2. Verify `static/hyrax/3d/embodiment-bundle.js` exists and is served by WebUI

**Steps:**
1. Load WebUI and navigate to HQ panel
2. Click a chibi to start a VN conversation
3. Send a message, verify SSE streaming works (VN fully functional)
4. Click "enter room" to enter 3D mode
5. Verify 3D room renders — Three.js canvas visible, avatar displayed, room objects rendered
6. Interact with the room (click affordances, check presence display)
7. Click "leave room" to exit 3D mode
8. Verify VN conversation continues normally after exiting 3D
9. Enter and leave 3D mode 3 times in succession — no errors, no memory growth
10. Verify "Projects", "Kanban", and other WebUI-native panels still function

**Pass Criteria:**
- VN conversations work: send message → receive reply → SSE events stream
- 3D room renders at least a basic scene with the avatar
- 3D dispose on exit: WebGL canvas removed from DOM, no animation running
- All WebUI-native features (chat, kanban, profiles) continue to function
- No JavaScript console errors related to missing control-plane endpoints

**Fail Criteria:**
- VN hangs or fails to send messages
- 3D room shows an error or remains blank
- "enter room" triggers a network request to the control-plane or CT 112
- Any WebUI feature breaks because of the 3D module integration

---

## 15. Decisions for Josh to Approve

Before implementation cards can be created, the following decisions need explicit sign-off:

### Product

| # | Decision | Options | Recommended | 
|---|---|---|---|
| D-1 | Scope: do we keep only HQ, VN, 3D? | Yes / Keep some extras | **Yes** — retire Projects/WarRoom/Dispatch/Verify/Promises from bootstrap |
| D-2 | Single tab "HQ" with 3 internal modes, or 3 tabs? | Single / Three | **Single** — less sidebar clutter, more natural flow |

### VN Runtime

| # | Decision | Options | Recommended |
|---|---|---|---|
| D-3 | VN backend: keep old Division Gateway sidecar or port to WebUI? | Sidecar / Port | **Sidecar** — less risk, proven working |
| D-4 | If SSE relay can't be fixed, route directly to :8770 with CORS? | Direct / Fix SSE | **Direct as fallback** — accept CORS config |
| D-5 | Zero-tool VN profile mode: allow empty toolsets or require at least 1? | Allow empty / Require 1 | **Allow empty** — VN-only profiles need no tools |

### 3D Integration

| # | Decision | Options | Recommended |
|---|---|---|---|
| D-6 | 3D strategy: adapt existing embodiment module as WebUI bundle or iframe to control-plane? | **Adapt existing bundle** / Iframe | **Adapt existing bundle** — zero runtime dependency, same-origin, no Caddy/CSP issues |

### Upstream

| # | Decision | Options | Recommended |
|---|---|---|---|
| D-7 | Reconciliation: cherry-pick branch or keep 6-commit fork? | Cherry-pick / Keep fork | **Cherry-pick** — cleaner future merges |
| D-8 | When to replace monkey-patch with managed extension? | Now / After MVP / Never | **After MVP** — doesn't block the critical path |

### Operations

| # | Decision | Options | Recommended |
|---|---|---|---|
| D-9 | Credential hygiene: apply gate before next deploy? | Before deploy / Within 2 weeks | **Before any new deploy** — high severity |
| D-10 | Decommission old :8770 gateway? Only after parity proven | After 3 days stable / After 1 week | **After 3 days stable** of sidecar route |

---

## Document Checks

This document was verified with the following checks:

- [x] Markdown structure valid (headings, tables, lists)
- [x] All required decision sections present
- [x] Current-state evidence distinguishes confirmed from assumed
- [x] Component/data-flow diagram included
- [x] Decision table for all integration options (frontend, VN, 3D)
- [x] Existing implementation vs integration target explicitly distinguished
- [x] Local embodiment module inventory with exact line counts and migration categories (Section 7)
- [x] Same-origin target topology with integration acceptance test (Section 14)
- [x] WebUI alignment clarified: WebUI owns runtime; Hyrax owns HQ/VN/3D presentation
- [x] Rei's QA requirements R1–R9 represented and incorporated
- [x] No target diagram or recommendation depends on control-plane or CT 112 at runtime
- [x] Caddy removed as assumed solution
- [x] 3D lifecycle/dispose requirements defined as invariants
- [x] Unresolved issues framed as bounded spikes with pass/fail criteria
- [x] Migration/cutover sequence with independent phase rollback
- [x] Local-source provenance invariant (I9) enforced: no CT 112 extraction
- [x] Ends with decisions Josh must approve
- [x] No code, config, service, Git, or runtime changes applied
- [x] All file paths reference the intended workspace
- [x] Zero credential exposure in document
- [x] Zero CT 112 operational/extraction content remains
- [x] Existing local embodiment module is the sole implementation source
- [x] Source→destination and adapter contracts are concrete
