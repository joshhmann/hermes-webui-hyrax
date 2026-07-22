# Hermes WebUI Hyrax Fork — Migration Criteria

## Architecture (Three Systems)

```
┌─────────────────────────────────────────────────────┐
│ ① Hermes Native Dashboard (:9119)                   │
│   Built into `hermes agent` — official Hermes UI    │
│   Status: NOT USED — community WebUI replaces this  │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ ② Community WebUI (nesquena/hermes-webui)            │
│   Forked → joshhmann/hermes-webui-hyrax             │
│   Community-built Hermes client — our new frontend   │
│   Gives us: kanban, chat, auth, panels, settings     │
│   We add: Hyrax panels + hyrax_routes backend        │
└────────────────────────────────────────────────────────┘
         │ talks to profile gateways + kanban.db
         ▼
┌─────────────────────────────────────────────────────┐
│ ③ Our Division Gateway (hyrax-division-control-plane)│
│   FastAPI server — our custom backend                │
│   Port: :8770 (stays alongside WebUI)               │
│   Some endpoints → absorbed into WebUI backend       │
│   Some endpoints → stay as separate gateway          │
└─────────────────────────────────────────────────────┘
```

## Migration Decision Matrix

Every component of our control plane is classified into one of four categories.

### DROP — WebUI has it better / equivalent

| Our Component | File(s) | Replaced By | Rationale |
|---|---|---|---|
| Kanban board render | `frontend/src/main.ts` → `renderTaskBoard()` | WebUI kanban panel (`panels.js`) | WebUI kanban has SSE streaming, multi-board, drag-drop, filtering, profile lanes — all more mature |
| Auth / login flow | `division_gateway/app.py` → `/api/v1/auth/*` | WebUI auth (`api/auth.py`) | WebUI has password, passkeys, cookie sessions — no need for our custom auth gate |
| View system / tab nav | `frontend/src/main.ts` → `showView()` | WebUI `switchPanel()` + `MAIN_VIEW_PANELS` | WebUI panel system is more flexible (lazy-loading, SSE cleanup, sidebar collapse, mobile responsive) |
| CSS layout | `frontend/src/style.css` | WebUI `static/style.css` | WebUI already has responsive layout, dark theme, sidebar. Our CSS additions → `static/hyrax/hyrax.css` |
| Task creation (basic) | `frontend/src/main.ts` → "+ New Task" form | WebUI kanban create task (`POST /api/kanban/tasks`) | WebUI has full task creation with assignee, tenant, priority, skills |
| Comment system | `frontend/src/main.ts` → Post comment | WebUI kanban comments (`/api/kanban/tasks/<id>/comments`) | WebUI has full comment CRUD |
| Snapshot endpoint | `division_gateway/adapters.py` → `snapshot()` | WebUI `/api/kanban/board` + `/api/kanban/stats` | WebUI has granular endpoints for board, stats, events — more efficient than one 1.7MB snapshot |

### KEEP — still needed as gateway endpoints

| Our Component | File(s) | Endpoint | Why It Stays |
|---|---|---|---|
| Live agent SSE watch | `division_gateway/app.py` | `GET /api/v1/kanban/{id}/watch` | WebUI has no equivalent. Requires Hermes `stream_run()` which the WebUI backend doesn't expose |
| Live agent steer | `division_gateway/app.py` | `POST /api/v1/kanban/{id}/steer` | WebUI has no equivalent. Injects into companion's run session |
| Kanban PATCH (status transitions) | `division_gateway/app.py` | `PATCH /api/v1/kanban/{id}` | WebUI kanban uses `/api/kanban/tasks/bulk` — different interface. Keep for our custom transitions |
| Resolution system | `division_gateway/app.py` | `PATCH` with `result` field | WebUI kanban complete doesn't support resolution labels |
| Summon sister | `division_gateway/app.py` | `POST /api/v1/kanban/{id}/summon` | WebUI has no round-robin sister dispatch |
| Work proposal CRUD | `division_gateway/proposals.py` | `/api/v1/proposals/*` | WebUI has no proposal/approval/intake system |

### PORT — move into WebUI as hyrax_routes + hyrax panels

| Our Component | File(s) | WebUI Home | Action |
|---|---|---|---|
| Projects tab (aggregation) | `frontend/src/main.ts` → `renderProjects()` | `static/hyrax/projects.js` + `api/hyrax_routes.py` | Panel already built. WebUI needs GET /api/v1/projects endpoint |
| Projects snapshot data | `division_gateway/adapters.py` → `_projects_data()` | `api/hyrax_routes.py` | Query kanban.db directly — no FastAPI dependency |
| War Room / live dashboard | `frontend/src/main.ts` → render funcs | `static/hyrax/warroom.js` | New panel showing sister presence + active runs |
| Dispatch panel | `frontend/src/main.ts` → profileDispatchComposer | `static/hyrax/dispatch.js` | New panel for blocked task triage |
| Verify panel | `frontend/src/main.ts` → kommandComposer | `static/hyrax/verify.js` | New panel for review queue |
| Promises/Ledger panel | `frontend/src/main.ts` → render needed | `static/hyrax/promises.js` | New panel for contract evidence |
| HQ / VN panel | `frontend/src/main.ts` → renderHQ() | `static/hyrax/hq.js` | Division home with sister portraits and conversation |
| Epic drill-in | `frontend/src/main.ts` → showTaskDetail() | `static/hyrax/epics.js` | WebUI task detail already renders — augment with epic data |
| Label badges | `frontend/src/main.ts` → card rendering | `static/hyrax/labels.js` | Post-process WebUI kanban cards to add skill badges |
| Structured intake form | `frontend/src/main.ts` → "+ New Task" | `static/hyrax/intake.js` | Replace simple kanban create with structured work request |

### HYBRID — AP lives in both (WebUI for frontend, gateway for backend)

| Feature | Frontend | Backend |
|---|---|---|
| Projects API | `static/hyrax/projects.js` (WebUI panel) | Both: `api/hyrax_routes.py` (WebUI) AND `division_gateway/adapters.py` (gateway) |
| Task metadata (labels, project) | `static/hyrax/labels.js` (augments WebUI cards) | Both: WebUI kanban CRUD + our gateway endpoints |

## Migration Phases

### Phase 0: Foundation (done)
- [x] Fork `nesquena/hermes-webui` → `joshhmann/hermes-webui-hyrax`
- [x] Create `static/hyrax/` directory structure
- [x] Create `api/hyrax_routes.py` with monkey-patch route registration
- [x] Create `bootstrap.js` for panel/DOM injection
- [x] Add one script tag + one import to core files (the only core changes)

### Phase 1: Core Panels (our frontend → WebUI panels)
- [ ] `static/hyrax/projects.js` — Projects panel (built, needs endpoint)
- [ ] `static/hyrax/warroom.js` — War Room panel (new)
- [ ] `static/hyrax/dispatch.js` — Dispatch panel (new)
- [ ] `static/hyrax/verify.js` — Verify panel (new)
- [ ] `static/hyrax/hq.js` — HQ division home (new)

### Phase 2: Feature Augmentations (bolt-ons to WebUI kanban)
- [ ] `static/hyrax/labels.js` — Label badges on kanban cards
- [ ] `static/hyrax/epics.js` — Epic parent/children in task detail
- [ ] `static/hyrax/intake.js` — Structured intake form

### Phase 3: API Migration
- [ ] Port `_projects_data()` from gateway → `hyrax_routes.py`
- [ ] Port snapshot aggregation as needed
- [ ] Gateway endpoints for live/steer/summon stay as separate service

### Phase 4: Deprecation
- [ ] Remove `frontend/src/main.ts` from control plane repo
- [ ] Remove `frontend/src/style.css` (keep only hyrax.css)
- [ ] Update Caddy/nginx to point root to WebUI fork
- [ ] Archive old division-gateway systemd service

## Verify Checklist (per component)

Before marking a component as ported:

- [ ] WebUI panel renders the same data
- [ ] WebUI panel handles empty state
- [ ] WebUI panel handles error state (API down)
- [ ] WebUI panel is responsive (mobile + desktop)
- [ ] No core Hermes WebUI files were modified (except the two intentional lines)
- [ ] `git pull upstream main` merges cleanly
- [ ] All existing tests pass
