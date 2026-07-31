# SOMA Avatar Calibration Studio — Final Handoff (2026-07-30)

## Outcome

Phase 6 has a complete Studio-first vertical slice and a thin, verified normal
viewer consumer.

- SOMA77 is frozen as the canonical 77-joint motion contract.
- The real 150-frame Kimodo conversion is lossless within the recorded
  tolerances.
- VRM, GLB, and explicitly normalized FBX rigs can be inspected and calibrated.
- Tai has a signed 54-control profile with automatic rest fitting, editable
  offsets, deterministic validation, Core27 turn qualification, grounded-foot
  correction, and temporal foot IK.
- The normal Ardy viewer can now import and execute a validated Studio profile.

The foundational Studio commit is `f6d39d60`
(`feat(calibration): add SOMA avatar studio and qualified Tai profile`).

## Entry points

- Studio: `/api/hyrax/3d/calibration-studio/studio.html?sample=tai`
- Normal viewer:
  `/api/hyrax/3d/debug/ardy.html?capture=capture-turn&mode=compare&profile=studio`
- Studio architecture: `hyrax-3d/calibration-studio/ARCHITECTURE.md`
- Studio usage/evidence: `hyrax-3d/calibration-studio/README.md`

In the normal viewer, select `Tai 54 · grounded Studio ✓` or import a Studio export
with the new `config` picker. If the automatic Tai asset URL is unavailable,
load `hyrax-assets/embodiment/tai.embodiment.vrm` with the `VRM` picker.

## Trust and runtime boundary

The normal viewer does not reinterpret an export.

1. It accepts only `schema: "soma.avatar-calibration"` through the config
   picker.
2. Runtime solving requires `status: "validated"`.
3. It hashes the original avatar bytes and requires the signed asset identity.
4. It re-extracts the normalized 22- and 54-control VRM rig variants and
   requires an exact signed rig match. The viewer deliberately uses the same
   humanoid-only three-vrm import boundary as the evidence generator; changing
   loader normalization changes the signed rig and is rejected.
5. It adapts Core27 through the explicit SOMA77 qualification adapter or
   consumes lossless SOMA77 converter output directly.
6. It uses the generic profile consumer and commits the resulting local
   transforms through Three.js/three-vrm.
7. Stateful ground and IK correction is deterministically replayed from frame
   zero after arbitrary seeks.

The old `AvatarRetargeter` profiles and hardcoded `SomaVrmRetargeter` path remain
intact as reference paths. The normal viewer does not silently fall back when a
Studio profile fails verification.

## Qualified Tai artifacts

- `hyrax-3d/calibration-studio/evidence/tai.humanoid54.foot-ik.validated.json`
- `hyrax-3d/calibration-studio/evidence/tai.humanoid54.foot-ik.validation-evidence.json`
- `hyrax-3d/calibration-studio/evidence/tai.humanoid54.avatar-rig-ir.json`
- `hyrax-3d/calibration-studio/evidence/kimodo-150.soma77.json`
- `hyrax-3d/calibration-studio/evidence/kimodo-150.converter-evidence.json`

The profile contains 54 mappings. Its independent `.96` Core27 turn
qualification records 8 left-foot and 9 right-foot planted/released
transitions. Maximum pelvis lowering is `0.023397199 m`, below the documented
`0.08 m` reach-compensation bound. Position residual is approximately
`1e-9 m`; orientation residual is at most approximately `1.7e-6°`.

## Verification

At the Studio foundation commit:

- `npm run build`: pass
- `npm test`: 51/51 pass
- `./scripts/test.sh tests/test_hyrax_soma_converter.py -q --timeout=60`:
  3/3 pass

The normal-viewer integration adds a deterministic profile-consumer test,
including non-sequential seek replay, plus a fail-closed draft-profile test.
It also resolves the real Tai VRM to the exact signed 54-control rig:
`sha256:6f372fe75c809b9384ea7b50e2f358b5de00804a5e8ff42a98d940ada7b43fe8`.

The aggregate typecheck still encounters the pre-existing, intentionally
out-of-scope `VRMUtils.combineSkeletons` three-vrm API mismatch in
`src/embodiment/loaders/loadModel.ts`. Do not fold that unrelated migration
into calibration work.

## Remaining product work

- Run broader cross-avatar visual acceptance, especially detailed hands.
- Add GLB/FBX runtime consumers to the normal viewer; the current consumer is
  VRM-first even though Studio authoring supports all three formats.
- Decide whether a future contract version should exclude source filename from
  signed rig identity. Today users should keep the avatar filename used during
  calibration.
- Expand qualification clips only when they represent a named behavior and
  have explicit pass criteria; do not tune against an unbounded animation pile.
- Keep IK a correction layer. Mapping, rest, basis, scale, and root failures
  must continue to fail validation rather than being hidden by IK.

## Working tree note

The Studio foundation is committed locally. The normal-viewer consumer,
documentation, and its tests are the follow-up logical change at handoff time.
Check `git status` and commit that follow-up separately after review.
