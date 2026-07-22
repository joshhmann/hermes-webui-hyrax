# Hyraxknot WebUI Fork — What Stays, What Goes

## What the Community WebUI Already Covers (we drop these)

| Our Feature | WebUI Replacement | Verdict |
|---|---|---|
| Kanban board render | `panels.js` kanban panel — full SSE, multi-board, drag-drop | **DROP** — theirs is better |
| Auth / login | `api/auth.py` — password, passkeys, cookie sessions | **DROP** — use theirs |
| View system / tabs | `switchPanel()` + `MAIN_VIEW_PANELS` | **DROP** — use theirs |
| CSS layout | `static/style.css` — responsive, themed | **DROP** — use theirs |
| Basic task creation | `POST /api/kanban/tasks` — title, body, assignee, tenant | **DROP** — use theirs |
| Comments | `POST /api/kanban/tasks/{id}/comments` | **DROP** — use theirs |
| Settings | Settings panel — providers, models, theme | **DROP** — use theirs |
| File management | Workspace panel + file preview | **DROP** — use theirs |
| Skills management | Skills panel | **DROP** — use theirs |
| Memory management | Memory panel | **DROP** — use theirs |
| Profiles | Profiles panel | **DROP** — use theirs |
| Logs | Logs panel | **DROP** — use theirs |

## What We Keep — This Is Us

These are the features that give the division its identity. No WebUI equivalent exists.

### 1. HQ / VN — The Heart of Hyraxknot ⭐

| Component | What it does | Why it's us |
|---|---|---|
| Isometric division map | Interactive map with rooms, sister positions | Our physical identity |
| Sister portraits | Full-body chibis with expressions | Our characters — Tai, Rei, Nei, Mai |
| VN expressions | `[expr: smile]` — real-time portrait changes | Our emotional language |
| Essence integration | Mood, energy, mode drives expression | Our internal state |
| VN conversation | The chat interface with portrait + expressions | Our way of talking |
| Mood evolution | Conversation tone → expression changes | Our dynamic presence |

**This is non-negotiable.** The VN is what makes Hyraxknot *Hyraxknot*.

### 2. Projects Tab — Our View of Work

| Component | What it does |
|---|---|
| Project cards | Progress bars, status breakdown, last updated |
| Filter by project | Click a project → see its tasks |
| Per-project stats | Done/running/blocked counts |

### 3. War Room — Live Operations

| Component | What it does |
|---|---|
| Active runs | Shows what each sister is working on right now |
| Running-too-long detection | Flags tasks past expected duration |
| Sister presence | Who's online, idle, or working |
| Quick actions | Start, Complete, Archive from the ops view |

### 4. Dispatch + Intake — How Work Gets Done

| Component | What it does |
|---|---|
| Structured intake form | Type→assignee auto-routing (bug→Rei, feature→Tai, ops→Mai) |
| Blocked task triage | One-click sister launch from blocked tasks |
| Resolution system | Fixed/wontfix/obsolete on completion |

## What's Borderline (keep for now, revisit later)

| Feature | Keep? | Rationale |
|---|---|---|
| Epic drill-in | ✅ Light | Small augmentation to WebUI task detail — shows parent/children |
| Label badges | ✅ Light | Small CSS + post-process to show skill badges on kanban cards |
| Live agent watch/steer | ✅ Medium | SSE stream into running companions — high ops value |
| Verify panel | 🔄 Merge into Dispatch | Review queue could be a dispatch sub-view instead of a separate tab |
| Promises/Ledger | ❌ Drop | Contract governance is overkill for daily ops |
| Operations Board | ❌ Drop | 5-stage pipeline view was Plane-specific — Plane is gone |

## Final Panel List (what goes in the sidebar)

Ordered by importance:

| Panel | What | Priority |
|---|---|---|
| **Chat** | WebUI's existing chat (replaces our VN for text) | Core |
| **HQ** | Our VN with portraits, expressions, map | ⭐ Identity |
| **Projects** | Our project grouping with progress | Must |
| **War Room** | Our live ops dashboard | Must |
| **Dispatch** | Our intake + triage | Must |
| Kanban | WebUI's existing kanban board | Core |
| Settings | WebUI's existing settings | Core |

Everything else (Skills, Memory, Workspaces, Profiles, Logs, Insights) — WebUI ships them, we keep them as-is.

## Implementation Strategy

```
Phase A: HQ + VN (this is us — ship first)
  ├─ Port renderHQ() + isometric map → static/hyrax/hq.js
  ├─ Port VN conversation with chibis → static/hyrax/hq.js
  ├─ Wire Essence expressions through portrait rendering
  └─ Sister chibis + backgrounds served from existing /api/v1/assets/

Phase B: Projects + War Room (ops layer)
  ├─ Projects panel (already scaffolded)
  ├─ War Room with active runs + sister presence
  └─ Structured intake form

Phase C: Dispatch + Polish
  ├─ Blocked task triage
  ├─ Resolution labels on kanban cards
  └─ Label badges + epic hint in task detail
```

## What We're NOT Building

- ✗ Kanban board — WebUI has it
- ✗ Auth system — WebUI has it  
- ✗ Comment system — WebUI has it
- ✗ Task creation (basic) — WebUI has it
- ✗ Promises/Ledger — overkill
- ✗ Operations Board — Plane is gone
- ✗ Settings/Skills/Memory/Profiles/Lists — WebUI has them all
