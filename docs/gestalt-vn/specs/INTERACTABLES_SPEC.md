# [SPEC] Stateful Interactables — the world responds (spatial layer 5)

## Problem

Interactions today are theater: she plays "sits at desk" at a spot, but
the couch doesn't know she's on it, doors don't move, nothing is held.
Real interaction = object state + the world responding. Hand-precision IK
(knuckle-on-handle) is a LATER phase (roadmap Phase 5); this spec is the
believable loop achievable without it.

## Design

### Object state machines (manifest extension)

```json
{ "id": "door_01", "label": "the door", "position": [x,y,z],
  "state": "closed",
  "states": {
    "closed": { "obstacle": true,  "mesh_rotation": [0,0,0] },
    "open":   { "obstacle": false, "mesh_rotation": [0,1.57,0] }
  },
  "interactions": [
    { "id": "open",  "kind": "use", "spot": [x,z], "facingDeg": 90,
      "prompt": "a person opens a door", "requires": "closed",
      "sets": "open", "duration_s": 3 },
    { "id": "close", "kind": "use", "spot": [x,z], "facingDeg": 90,
      "prompt": "a person closes a door", "requires": "open",
      "sets": "closed", "duration_s": 3 }
  ] }
```

- `requires` gates availability (an open door can't be opened); `sets`
  transitions state on interaction COMPLETION (arrival + prompt
  finished), journaled.
- `states.<s>.obstacle` feeds RoomNavigation: opening a door removes its
  collision so paths can route through (nav rebuild from manifest state —
  cheap: room-scale).
- `states.<s>.mesh_rotation` (or simple property animation) makes the
  world visibly respond.
- State persists per room session (v1: in-memory; v2: to a small state
  file so the VN/HQ could agree later).

### Pick-up (bounded v1)

`{ id: "cup", kind: "pickup", prompt: "a person picks up a cup",
  attach: { "bone": "rightHand", "offset": [0,0.05,0] } }` — on
completion the object mesh parents to the hand bone with the offset
(object stops being an obstacle); `putdown` reverses at a target spot.
No IK — the prompt supplies the motion, the attach supplies the truth.

## Acceptance criteria

- [ ] Manifest schema v1.1 (states/requires/sets/attach) + validator
      (fail-closed; unknown transitions, missing states)
- [ ] door_01 in tai-loft.json: open → door visibly rotates, collision
      removed (path through doorway routes), close reverses; state
      journaled in telemetry
- [ ] `requires` enforced: interacting with wrong state refused with
      reason (and the goal picker only shows valid interactions)
- [x] cup pickup: she takes it, it follows her hand on walk; putdown
      places it at the target spot and it stays there
- [ ] GEVS Level 3 grows its first checks: door-open (state + collision
      + visible rotation), pickup-cup (attach + carry + place)
- [ ] Suites green; wall-absorb 1.0 holds; no IK, no physics engine

## Non-goals

- No hand-target IK, no fingertip precision (roadmap Phase 5)
- No shared/multi-room state sync
- No operator-initiated interactions from essence (that comes after
  essence-goals lands and this proves out)

## Links

GOAL_PLANNER_SPEC.md, SCENE_MANIFEST_SPEC.md, GEVS_SPEC.md (Level 3)
Assignee: tai | Reviewer: rei | Queue: after ESSENCE_GOALS_SPEC.md
