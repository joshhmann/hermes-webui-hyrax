# Gestalt Embodiment Platform — Architecture Proposal (codex, 2026-08-01)

Source: codex, relayed by josh. Status: proposal under review. Kimi's critical
review recorded in this session (see worklog); roadmap phases as stated below.

## Vision

An embodiment platform that allows AI-generated motion to drive any calibrated
humanoid avatar. Motion sources: Kimodo, Ardy, mocap, future models,
video-to-motion, robotics datasets. Avatar formats: VRM (first, because VRoid
makes character creation accessible), GLB, FBX, custom rigs.

## Motion standards

- Today: Ardy = cskel27 (production), Kimodo = SOMA77 (full articulation).
- Long-term: SOMA77 becomes the canonical motion language; Ardy migrates to
  SOMA; cskel27 supported during migration.

## Platform architecture

Motion Sources → Motion Import Layer → Canonical Motion (SOMA77, cskel27 during
migration) → Avatar Calibration Studio → Calibration Profiles → Runtime
(Three.js) → Avatar Formats.

## Avatar Calibration Studio (the core product)

Import avatar, inspect skeleton/bind pose/hierarchy/transforms, map bones,
align rest poses, calibrate axes and scale, preview and validate motion, export
reusable calibration profile. Runtime consumes profiles, not hardcoded
mappings. Robotics teleoperation framing: calibrating one body (SOMA) to
another (avatar).

## Runtime end-state

Load Avatar → Load Calibration Profile → Load Motion → Apply FK Retarget →
Optional IK → Render. Avatar-specific constants disappear from runtime code.

## Phases

1. Stabilize motion import (SOMA77, cskel27, validation, regression tests)
2. Avatar Calibration Studio MVP (viewer, hierarchy, mapping, rest alignment,
   profile export, playback, validation metrics)
3. Profile-driven runtime (replace hardcoded mappings with profiles)
4. Automatic assistance (semantic bone detection, mapping suggestions, rest
   estimation, recommendations; manual override always allowed)
5. Advanced IK (foot locking, hand targets, look-at, pelvis stabilization,
   contact preservation — IK improves correct calibration, never hides bad
   calibration)
6. Animation Studio (inspect/trim/blend/mirror/loop/convert clips, root
   motion, clip compare)
7. Motion Library (Kimodo/Ardy/mocap/recordings, searchable metadata)
8. Behavior Studio (LLM Goal → Behavior Planner → Motion Selection →
   Embodiment Runtime → Avatar — where Hermes/Gestalt agents become embodied)
9. Scene Studio (navigation, interaction points, props, animation events,
   object manipulation, locomotion zones)
10. Creator SDK (third-party avatars, profiles, motion packs, behavior packs)

## Tool suite (eventual)

Avatar Studio, Motion Studio, Behavior Studio, Scene Studio, Validation
Studio, Dataset Studio, Runtime Debugger.

## Open review questions (from codex)

Weaknesses, better architecture, missing tools/phases, simplifications,
future-proof abstractions, commercial analogues, modularity boundaries.
