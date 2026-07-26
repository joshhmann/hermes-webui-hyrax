# Gestalt Interactables Spec

**Status:** design · follows architecture doc
**Prime rule:** deterministic action registry. A model (Hermes or Essence) may
*recommend* ordering or additions, but only registered, permitted actions are ever
shown as executable. Nothing the sidebar renders can create arbitrary tool calls or
arbitrary client code.

## 1. VNInteractable (contract recap — full TS in API doc)

```ts
interface VNInteractable {
  id: string;                     // stable, namespaced: "op.talk", "room.desk.inspect"
  label: string;
  description?: string;
  category: 'operator'|'environment'|'conversation'|'work'|'system';
  icon?: string;                  // existing icons.js id
  source: 'static'|'hermes'|'essence'|'world-state'|'tool'|'plugin';
  availability: { visible: boolean; enabled: boolean; reasonDisabled?: string };
  requirements?: InteractionRequirement[];
  action: RegisteredClientAction | HermesIntentAction | ToolAction
        | NavigationAction | WorldStateAction;
  confirmation?: { required: boolean; message?: string };
  presentationHints?: { preferredExpression?: string; preferredAction?: string;
                        preferredSceneChange?: string };
}
```

## 2. Action kinds (what executes where)

| Kind | Executes | Examples | Failure surface |
|---|---|---|---|
| `RegisteredClientAction` | local UI only | toggle tech drawer, collapse sidebar, switch frame, copy transcript | inline toast; never blocks chat |
| `HermesIntentAction` | becomes a **normal Hermes message** in the shared session | "Ask what you're working on", "Ask how they're feeling", "Offer help" | appears in transcript as user message; stream errors surface like any send failure |
| `ToolAction` | calls an existing Hermes tool through the normal run path (same as the agent calling it) — never a side channel | "View current task" (kanban read), "Open Linear issue" | tool card in dialogue + toast on dispatch failure |
| `NavigationAction` | surface switch | "Open standard chat", "Return to HQ", "Enter 3D Loft" | n/a (guarded no-op with toast if target missing) |
| `WorldStateAction` | room presentation state (v1: manifest-local) | "Turn lamp on", "Sit on couch" (scene/lighting change) | revert optimistic change + toast |

Rules:
- Every action has an owner and exactly one effect path. No action both navigates and
  sends. No action mutates Hermes state except through a normal Hermes message/run.
- `confirmation.required` for anything destructive, irreversible, or approval-adjacent
  (e.g. "Start fresh conversation").
- Duplicate-execution prevention: actions are disabled while their own effect is
  in-flight (send locks HermesIntentAction; navigation locks during mount; world
  actions lock until the scene confirms).

## 3. The registry

Static, versioned, code-owned (`static/hyrax/vn/vnActions.js`), each entry:

```ts
{
  id, label, category, icon,
  when: (ctx: SidebarContext) => { visible: boolean; enabled: boolean; reasonDisabled? },
  run: (ctx: SidebarContext) => Promise<void>,
  presentationHints?
}
```

`SidebarContext` = {operatorId, sessionId, busy, approvalPending, activity,
essenceState, roomManifest, surface}. The sidebar re-evaluates `when` on:
runtime events (busy/approval/activity), essence intent changes, room changes —
never on a timer.

Sections and default ordering (≤5 visible each, "More…" overflow):

### Operator
| id | action kind | availability |
|---|---|---|
| `op.talk` | HermesIntent ("freeform focus") | always |
| `op.ask-feeling` | HermesIntent ("How are you feeling right now?") | not busy |
| `op.ask-doing` | HermesIntent ("What are you working on?") | not busy |
| `op.offer-help` | HermesIntent ("Can I help with anything?") | activity ∈ {tool-working, background-working} |
| `op.observe` | ClientAction (focus camera, ambient beat) | always |
| `op.sit-together` | ClientAction (pose intent → sitting frame) | not already sitting; sitting frames registered |
| `op.stand-up` | ClientAction (pose intent → standing frame) | not already standing; standing frames registered |
| `op.invite-elsewhere` | NavigationAction (room picker) | manifest has ≥2 rooms |
| `op.fresh-conversation` | ToolAction (new VN session) | confirmation required |

Pose actions pin `presentation.pose` (and the on-stage expression) in
essence state, then fire an explicit beat through essenceIntents →
vnStage.applyIntent → pose-aware reselection. Pose and expression are
independent dimensions: a pose swap reuses the current expression, and
later expression beats reuse the chosen pose. A target pose with no
registered frames disables the action with a reason; a pose that exists
but has no variant for the current expression falls back within the
selection ladder — the stage never goes blank.

### Room (from room manifest, §6)
Navigation actions (`room.enter`, `room.hq`) register before object verbs so
they stay inside the ≤5 visible entries regardless of manifest ordering.

| id pattern | action kind | effect |
|---|---|---|
| `room.<object>.inspect` | WorldStateAction + Essence intent | frame focuses object; sidebar description |
| `room.<object>.ask` | HermesIntent ("Tell me about <object>") | message |
| `room.<object>.use` | WorldStateAction | e.g. lamp on/off → lighting field |
| `room.enter` | NavigationAction | switches scene location + swaps the stage background per the room's `backgroundFrameIds` (disabled with reason when the room has none) |
| `room.hq` | NavigationAction | return to HQ |

### Work
| id | action kind | availability |
|---|---|---|
| `work.current-task` | ToolAction (kanban read) | operator has tasks |
| `work.open-issue` | NavigationAction (Linear/GitHub link from task) | task has external ref |
| `work.artifacts` | NavigationAction (workspace panel, same session) | artifacts exist |
| `work.approvals` | ClientAction (open approval card) | approvalPending |
| `work.delegate` | HermesIntent ("Delegate follow-up on <task>") | not busy, task active |

### System
| id | action kind | effect |
|---|---|---|
| `sys.standard-chat` | NavigationAction | `loadSession(sid)` |
| `sys.tool-details` | ClientAction | open tech drawer |
| `sys.workspace` | NavigationAction | workspace panel |
| `sys.session-switch` | ClientAction | VN session picker (sister's sessions) |
| `sys.model-info` | ClientAction | model/profile chip popover (read-only in v1) |
| `sys.profile-settings` | NavigationAction | settings panel |

## 4. Availability and permissions

- `visible` = category relevance (e.g. Work section hidden if operator has zero
  tasks); `enabled` = moment safety (busy, approvals, offline), with `reasonDisabled`
  shown as tooltip and to screen readers.
- Approval-gated actions (none in v1 beyond `op.fresh-conversation`'s confirmation)
  never bypass the native approval flow — sensitive runs surface the standard
  approval card regardless of origin.
- Essence may add `presentationHints` to existing entries and may *reorder* by
  relevance, but cannot synthesize ids. A recommendation referencing an unregistered
  id is dropped and logged once.

## 5. Failure behavior

- Every `run` is wrapped: errors → toast + `issues` entry on the sidebar chip; the
  sidebar never throws into the dialogue stream.
- HermesIntentAction failures = normal send failures (existing composer error path).
- WorldStateAction failures revert optimistic presentation.
- ToolAction dispatch failures show as a failed tool card with the real error.

## 6. Room manifests (v1 shape)

```ts
interface VNRoomManifest {
  roomId: string;                 // stable: "nei.research-lab" (matches HQ room ids)
  operatorId: string;
  displayName: string;
  backgroundFrameIds: string[];   // registry ids used for scene location
  visibleObjectIds: string[];     // stable object ids (future 3D-compatible)
  interactables: VNInteractable[];// registered ids resolved through the registry
  ambientState?: Record<string, unknown>;  // e.g. { lamp: 'on' }
}
```

v1 rooms = the four sister rooms from the HQ map (stable ids already in hq.js:
security/common/coffee/corridor/director/ops/lab/logistics/entrance mapped to
sister rooms). Manifest objects must use ids that survive into the 3D room era —
no VN-only room model.

## 7. Accessibility & honesty

- All interactables are real buttons with labels, focus states, and disabled reasons.
- Immersive one-liners for ToolActions mirror the same event as the tool card —
  never fabricated success before confirmation (audit §tool-presentation rule).
