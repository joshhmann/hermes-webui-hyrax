# SOMA Avatar Calibration Studio

This directory contains the engine-neutral Avatar Calibration Studio and its
browser authoring shell. Open `studio.html?sample=tai` to run the reference
vertical slice. It deliberately lives beside the existing `calibrate/`
experiment, which remains the untouched Tai/reference runtime.

The Studio prefers HTTPS and native Web Crypto. Direct LAN and Tailscale-IP
HTTP origins are also supported: contract and avatar signatures fall back to
the same deterministic browser-local SHA-256 implementation when
`crypto.subtle` is unavailable. Imported model bytes remain in the browser and
are never sent to a hashing endpoint.

## Product boundary

```text
motion source → source adapter → SOMA Motion IR
avatar file   → import adapter → Avatar Rig IR

SOMA Motion IR + Avatar Rig IR
        → Studio authoring and validation
        → Avatar Calibration Profile
        → thin engine runtime adapter
```

Kimodo, Core27, VRM, Tai, and Three.js are adapter concerns. None is the
identity of the Studio domain model.

## Contracts

- `contracts/soma77.skeleton.json` freezes the canonical 77-joint identity,
  hierarchy, coordinate system, world-matrix convention, root ownership,
  compatibility alias, non-destructive selection policy, and tolerances.
- `contracts/humanoid54.authoring.json` is a separately signed Studio catalog
  for 17 required body roles plus optional body detail, 30 finger controls, and
  2 eyes. It does not change the frozen SOMA77 signature.
- `schemas/soma-motion-ir.schema.json` describes motion accepted by the Studio.
- `schemas/avatar-rig-ir.schema.json` describes an imported target skeleton and
  its immutable local/world rest snapshot.
- `schemas/avatar-calibration.schema.json` describes draft and validated
  calibration profiles.
- `core/contracts.js` is the executable fail-closed validator used by browser
  code and the headless conformance suite.
- `core/sha256.js` keeps signed authoring available on insecure LAN/Tailscale
  IP origins while producing the same digest as native Web Crypto.
- `core/calibration.js` captures explicit source/target rest evidence, root
  ownership, and measured translation scale.
- `core/auto-tune.js` deterministically proposes editable reference-pose
  offsets from mapped parent-to-child directions. It uses a shortest-arc swing
  for a single direction, a least-squares orientation fit for multiple
  non-collinear directions, and skips unconstrained terminal bones.
- `core/retarget.js` is the thin engine-neutral profile consumer. It emits
  local/world transforms and contains no Tai, VRM, Kimodo, or Three.js imports.
- `core/validation.js` runs fixed frames twice, signs the suite and result, and
  is the only path that promotes a draft to `validated`.

JSON Schema provides interchange documentation. The executable validators add
cross-field invariants JSON Schema cannot express conveniently: parents must
precede children, SOMA joint names and order must match the frozen contract,
frame arrays must agree, stable bone identifiers must be unique, and mappings
cannot reuse semantic or target identities.

## Current adapters

### Lossless converter JSON → SOMA Motion IR

`adapters/soma-motion-json.js` accepts canonical `soma77` and the legacy
identity alias `somaskel77`. An alias only renames the skeleton identity: a
legacy file carrying 30 joints is rejected rather than treated as SOMA77.

The same boundary has an explicit `cskel27` qualification adapter for the
three-part turn capture originally collected from `.96`. It expands that known
27-joint contract into a complete SOMA77 carrier without claiming measured
finger articulation: absent detail inherits the closest measured hand/head
rotation and is labeled as synthesized source data. This path is for
cross-source temporal-IK qualification, not converter evidence or rest
calibration.

### Three.js → Avatar Rig IR

`adapters/three-avatar-rig.js` extracts:

- stable structural bone identifiers;
- nearest imported-bone parent relationships;
- local rest position/quaternion/scale;
- world rest position/quaternion/scale;
- optional semantic assignments;
- source/importer identity; and
- a deterministic SHA-256 rig signature.

The caller must declare the coordinate system. The adapter does not guess
forward axis, asset units, VRM normalization, or VRM-0 facing corrections.
Those decisions belong to the format-specific importer that calls it.

The format wrappers make that boundary concrete:

- VRM declares the three-vrm normalized humanoid basis and records the VRM-0
  scene correction when present;
- GLB declares glTF's right-handed, +Y-up, meter convention; and
- FBX first emits an inspectable `unresolved` rig, then requires an explicit
  `UnitScaleFactor` and +Z/-Z facing declaration before it normalizes to meters
  and permits profile authoring. Re-normalizing the same object is rejected.

`evidence/tai.avatar-rig-ir.json` is the first real import artifact. It is
generated from the tracked Tai VRM by `tools/extract-vrm-rig.mjs` and records:

- the source asset SHA-256;
- VRM 0 identity;
- three-vrm 3.0.0 importer identity;
- normalized-rig selection;
- the applied `rotateVRM0` scene correction;
- the remaining scene-local `-Z` facing convention;
- all 22 currently driven humanoid rest transforms; and
- a deterministic rig signature.

The conformance suite recomputes the asset and rig signatures so the evidence
cannot silently drift away from its source.

The Studio now extracts two VRM rig views from the same loaded avatar:

- the original 22-control view, whose signature remains compatible with all
  existing profiles and legacy evidence; and
- a 54-control standardized view covering Tai's body, fingers, and eyes.

`evidence/tai.humanoid54.avatar-rig-ir.json` records the detailed view.
Non-thumb SOMA finger chains reduce from four joints to three target controls by
mapping joints `1`, `2`, and `4`, preserving distal endpoint orientation.
Thumbs map `1`, `2`, and `3` to VRM
`metacarpal`, `proximal`, and `distal`.

`evidence/tai.initial-mapping.json` records the current reference path's 22
body mappings as authoring input. `tools/create-profile-draft.mjs` resolves its
semantic targets against the signed rig and produces
`evidence/tai.avatar-calibration.draft.json`. The result is intentionally
unresolved: it freezes mapping provenance without claiming that rest, basis,
root, or scale calibration is complete.

## Proven reference slice

The checked-in Tai/Kimodo slice now proves:

1. import the real Tai VRM, preserve its 22-control compatibility signature,
   and snapshot 54 normalized humanoid controls for detailed authoring;
2. auto-propose, then permit manual editing of, 54 semantic mappings;
   mapping can be changed from a dropdown or by selecting a semantic row and
   clicking a live bone point on the avatar; occupied targets swap roles rather
   than creating duplicate mappings;
3. load the corrected real 150-frame/77-joint Kimodo motion;
4. capture rest quaternions, a delta-from-reference root policy, and a measured
   `0.8955767654558204` translation scale;
5. preview and accept an automatic reference-pose fit, then author normalized
   per-bone rotation offsets using local 3D rings, sliders, numeric fields,
   undo/redo, exact pair copy, or sagittal-plane mirroring;
6. scrub or play arbitrary frames with the generic profile consumer, then run
   the format-specific pose commit (`vrm.humanoid.update()` for VRM);
7. solve fixed frames `0, 37, 74, 111, 149` twice;
8. record local position/quaternion and world position/quaternion for every
   driven target; and
9. compare synchronized SOMA77 source truth and the optional frozen Legacy Tai
   22-body oracle in side-by-side or calibrated overlay views; and
10. independently sign and replay the 120-frame `.96` Core27 turn capture for
    planted/released foot-contact qualification, including blended world X/Z,
    level-foot orientation, heading locks, and bounded pelvis reach
    compensation; and
11. export a context-bound validated profile with capability coverage.

Evidence lives in:

- `evidence/kimodo-150.converter-evidence.json`;
- `evidence/tai.avatar-calibration.validated.json`; and
- `evidence/tai.validation-evidence.json`;
- `evidence/tai.humanoid54.calibration.validated.json`; and
- `evidence/tai.humanoid54.validation-evidence.json`;
- `evidence/tai.humanoid54.foot-ik.validated.json`; and
- `evidence/tai.humanoid54.foot-ik.validation-evidence.json`.

The 54-control artifact proves deterministic solving and complete mapping
coverage. It is not called a golden hand calibration: the Legacy Tai oracle
only establishes the existing 22-body behavior, and detailed hand quality still
requires separate manual/motion-quality acceptance.

Accepted auto-fit data is explicit profile authoring evidence, not telemetry.
For each constrained bone the profile records the original offset, automatic
suggestion, accepted final offset, manual residual, constraint count, direction
error, and whether twist was constrained. Exported profiles can therefore be
used as opt-in evaluation data for later solver improvements without treating
the automatic suggestion itself as ground truth.

The generated profile and evidence are reproducible with
`tools/build-validated-profile.mjs`.

The same pipeline is also checked against the non-Tai
`9042366629077953442.vrm` asset. Its independently signed rig, draft, validated
profile, and validation evidence demonstrate that the Studio contracts are not
Tai-specific.

## Trust model

`createCalibrationProfileDraft()` can only create a profile with:

- `status: "draft"`;
- unresolved rest, root, and scale calibration;
- IK disabled; and
- no validation evidence.

Runtime consumers must validate with `{ requireComplete: true }`. A draft cannot
be mistaken for a trusted runtime profile. Validation is context-bound to the
SOMA contract, source motion, avatar asset, extracted rig, fixed frames, and
numeric tolerances.

## Remaining gates

The Studio slice is not authorization to replace the golden runtime.
`evidence/tai-hardcoded-baseline.json` proves the legacy path twice across five
clip classes. The canonical measured profile intentionally differs from the
old contact/scale policy. That policy is now isolated in the optional,
signed `runtime_corrections` section instead of changing measured calibration.
`evidence/tai-legacy-compat-vs-hardcoded.json` proves that compatibility profile
against the frozen runtime (maximum world-position delta
`5.057692232712207e-8 m`).

Optional foot IK is similarly separate from FK calibration and disabled by
default. `evidence/tai.foot-ik.validation-evidence.json` proves the declared
targets with a maximum residual below `0.01 m`.

New Studio-authored IK profiles can additionally declare world-X/Z foot locks,
acquire/release blend frames, ankle/sole height, contact hysteresis, and
rest-pose knee-pole directions. Their higher validation tier fails closed
unless the motion exercises both planted and released contact states. The
Kimodo 150-frame evidence currently reports both selected contact channels
active for every frame, so it can preview temporal locking but cannot prove
contact transitions.

A technical validation PASS proves signed inputs, required mapping coverage,
finite normalized transforms, deterministic repeat output, and any configured
IK residual/contact gates. It does not certify aesthetics. Visual acceptance
across idle, arm/torso, crouch, locomotion, and turning clips remains an
explicit human review before a profile is called perceptually golden.

GLB and FBX are importable but lack a semantic auto-mapper. The FBX basis
contract is covered with deterministic synthetic Three.js tests; a redistributable
real FBX fixture and cross-exporter evidence are still required before calling
format breadth production-ready. The golden runtime remains untouched.

See `ARCHITECTURE.md`, `SOMA77_CONVERTER_CONTRACT.md`, and
`CURRENT_TAI_PIPELINE.md`.
