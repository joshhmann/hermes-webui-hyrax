# Avatar Calibration Studio Phase Audit

Date: 2026-07-30

## Outcome

The seven-phase Studio plan has an implemented vertical slice. The existing
hardcoded Tai runtime remains the golden production path; no automatic migration
or behavior replacement is part of this work.

| Phase | Result | Primary evidence |
|---|---|---|
| 1. Canonical SOMA77 | Pass | `SOMA77_CONVERTER_CONTRACT.md`, real 150-frame converter evidence |
| 2. Studio foundation | Pass | Rig/Motion/Profile contracts, inspector, mapping editor, draft lifecycle |
| 3. Calibration | Pass | Rest, root, measured scale, per-bone offset authoring, live preview |
| 4. Validation lifecycle | Pass | Two identical runs, signed evidence, explicit promotion and reload |
| 5. Legacy equivalence | Pass as optional profile | Frozen five-clip baseline and compatibility comparison |
| 6. Format breadth | Pass for VRM/GLB contract; FBX adapter proven | Two real VRMs and deterministic FBXLoader fixture |
| 7. Optional IK | Pass as isolated layer | Signed foot-target profile and residual-bounded evidence |
| 8. Detailed humanoid authoring | Pass as deterministic evidence | 54-control Tai rig/profile, local gizmo, tiered coverage, synchronized references |

## Quantitative gates

- Converter, real Kimodo 150-frame capture:
  maximum retained position error `0.000479 mm`; maximum angular error below
  `7.6e-8 rad`.
- Hardcoded Tai baseline:
  five required clip classes, 17 samples, 22 driven bones, two exact runs.
- Optional legacy compatibility:
  maximum local-position error `6.706724064997616e-11 m`; maximum
  world-position error `5.057692232712207e-8 m`.
- Optional foot IK:
  10 target samples; maximum residual `0.009694 m` against a declared
  `0.01 m` tolerance.
- Generic profile validation:
  Tai and a second real VRM both pass five fixed frames twice with canonical
  repeat delta `0`.
- Detailed Tai validation:
  54 standardized body/finger/eye controls, five fixed frames, two canonical
  runs, repeat delta `0`; the original 22-control rig signature remains valid.

## Verification

- Node conformance suite: 43 passed.
- Converter pytest suite through `scripts/test.sh`: 3 passed.
- Ruff: passed for converter and converter tests.
- JSON Schema: 11 rig/profile artifacts passed.
- Regeneration audit: the 4 original core Tai artifacts and 4 new detailed Tai
  artifacts reproduced byte-for-byte.
- Browser:
  Tai import at 54/54 controls, motion playback, local-ring and slider offset
  editing, single-step undo/redo, sagittal pair mirroring, direct bone-point
  mapping, capability coverage, optional IK, validation, and export passed;
  SOMA77, Legacy Tai 22-body, side-by-side, and overlay references passed;
  the original 22-control compatibility profile and the new 54-control profile
  both reloaded against their exact rig signatures;
  second-avatar validated-profile reload and preview passed; legacy
  compatibility sequential preview passed; FBX unresolved inspection and
  explicit meter/+Z normalization passed.
- Accessibility:
  zero WCAG 2 A/AA violations at desktop and mobile widths. Axe reported only
  incomplete contrast checks where the WebGL canvas prevents background
  inference.
- Graphify:
  542 nodes and 894 raw edges; traversal connects FBX normalization, Rig IR,
  profile validation, stateful retarget sessions, compatibility corrections,
  and IK at the intended adapter/core boundaries.

The repository-wide Python suite is not a green gate in this environment. It
was stopped after 1,925 passes and 27 unrelated failures: root permission tests,
installed Hermes Agent discovery, and tests expecting absent legacy
`static/ui.js` files. The focused converter suite is green.

## Remaining adoption risks

- A single deterministic ASCII FBX fixture proves the parser/adapter contract,
  but representative Blender, Maya, Mixamo, and other exporter fixtures are
  still needed before production format claims.
- Generic GLB/FBX rigs require manual semantic mapping; hierarchy suggestions
  and duplicate-role UX need broader corpus testing.
- The detailed Tai profile is deterministic but has not received a separate
  perceptual hand-calibration acceptance pass. The Legacy Tai oracle remains a
  22-body reference and must not be presented as finger ground truth.
- Stateful contact compatibility requires sequential replay for random seeks;
  signed state checkpoints are not implemented.
- IK currently covers declared foot targets only. Hand, reach, and look targets
  remain future independent correction layers.
- Structural bone paths intentionally invalidate profiles after hierarchy
  re-export. Profile recovery/remapping UX is not implemented.
