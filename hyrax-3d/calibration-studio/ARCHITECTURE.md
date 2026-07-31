# Avatar Calibration Studio Architecture

## Product boundary

```text
Kimodo / Ardy / mocap / future models
                 |
          source adapters
                 |
            SOMA Motion IR
                 |
avatar file -> format importer -> Avatar Rig IR
                 |                  |
                 +------ Studio ----+
                           |
             Avatar Calibration Profile
                           |
          engine-neutral profile consumer
                           |
              Three.js application adapter
```

SOMA Motion IR and Avatar Rig IR are immutable observations. The Studio authors
and validates a profile between them. A runtime consumes a validated profile;
it does not discover mappings, infer rest frames, or repair calibration.

## Components

| Component | Owns | Must not own |
|---|---|---|
| Source adapter | source aliases and conversion into exact SOMA Motion IR | avatar behavior |
| Format importer | VRM/GLB/FBX parsing, basis declaration, immutable rig snapshot | motion calibration |
| Skeleton inspector | hierarchy and local/world rest display | mutation |
| Mapping editor | semantic SOMA-to-target associations | rotation fixes |
| Calibration core | reference rest, root policy, scale, user offsets | renderer state |
| Auto-tune | reversible direction-fit suggestions and confidence | bind-pose mutation or hidden telemetry |
| Preview | reversible application of a draft to the imported model | profile promotion |
| Validator | fixed suite, metrics, signatures, promotion decision | hidden corrections |
| Profile consumer | deterministic frame solve from trusted inputs | avatar/source constants |
| Three adapter | write solved local transforms to Object3D nodes | calibration policy |
| Format pose commit | propagate control-rig changes to the render rig (for example three-vrm humanoid update) | solving or calibration |
| Optional IK | post-retarget target correction | hiding mapping or basis errors |

## Profile model

The normative interchange schema is
`schemas/avatar-calibration.schema.json`. The meaningful sections are:

- `soma_contract`: exact canonical identity and signature;
- `avatar`: format, source asset signature, and extracted rig signature;
- `mapping`: semantic role, canonical SOMA joint, stable target bone ID, and
  mapped target parent;
- `rest_calibration.per_bone`: source rest world quaternion and inverse, target
  rest world quaternion, and explicit user offset;
- `authoring.auto_tuning`: optional solver/version provenance, reference frame,
  original/automatic/final offsets, manual residuals, confidence, and direction
  error measurements;
- `root_calibration`: source/target anchors, enabled axes, and translation mode;
- `scale_calibration`: measurement method, samples, and translation factor;
- `ik`: disabled by default and separate from calibration;
- `runtime_corrections`: optional, explicit reproduction of a named legacy
  scale/root/contact policy, never folded into measured calibration; and
- `validation`: suite/result signatures and deterministic repeat fields.

The MVP rotation equation is explicit:

```text
targetWorld =
  targetRestWorld
  * sourceWorld
  * inverse(sourceRestWorld)
  * userOffset
```

Target local rotation is `inverse(targetParentWorld) * targetWorld`. The
profile records the external target-parent rest transform for mapped roots, so
format-level scene corrections are explicit rather than lost at the rig
boundary. Root translation is source displacement from the calibration frame
multiplied by the recorded scale.

## Offline versus runtime

Studio/offline responsibilities:

- inspect and map skeletons;
- select a reference frame;
- capture source/target rest transforms;
- declare basis/root/scale policies;
- preview, accept, revert, and refine automatic offset suggestions;
- validate several signed fixed clips;
- export and reload profiles.

Runtime responsibilities:

- verify profile, SOMA contract, asset, and rig signatures;
- solve a frame deterministically;
- apply target-local transforms;
- optionally run an explicitly configured post-retarget IK layer.

## MVP vertical slice

The implemented slice is real Tai VRM + real 150-frame Kimodo SOMA77:

```text
Import -> Inspect -> Map -> Calibrate -> Preview -> Validate twice -> Export
```

It proves the domain seams and trust gate without replacing the hardcoded Tai
runtime.

## Phased plan and gates

1. **Canonical inputs — complete.** Freeze lossless SOMA77 and signed converter
   evidence.
2. **Studio foundation — complete.** Rig IR, adapters, inspection, semi-manual
   dropdown and direct-on-avatar bone-point mapping, collision-safe role swaps,
   and draft export.
3. **Calibration slice — complete for the Tai/Kimodo reference.** Explicit
   rest/root/scale capture, normalized per-bone rotation-offset authoring, and
   live fixed-frame preview. Any offset edit invalidates validation and returns
   the profile to draft.
4. **Validation and profile lifecycle — complete for one fixed clip.** Two
   byte-identical solves, signed evidence, promotion, and export.
5. **Golden-runtime equivalence — complete as an optional compatibility
   profile.** Five legacy clip classes reproduce exactly across two baseline
   runs. A signed profile section explicitly owns the legacy scale override,
   root mode, contact channels, threshold, smoothing, and temporal state.
   Comparison against the frozen runtime passes at `5.057692232712207e-8 m`
   maximum world-position delta. Production is not switched automatically.
6. **Format breadth — implemented, evidence depth varies.** The same Kimodo
   clip validates a second non-Tai VRM with a distinct rig signature and scale.
   GLB imports in its declared glTF basis. FBX supports unresolved inspection
   followed by mandatory user-declared unit/facing normalization; deterministic
   synthetic tests cover fail-closed behavior. Real multi-exporter FBX evidence
   remains an adoption gate.
7. **Optional IK — complete and isolated.** Profile-declared FABRIK foot targets
   run after profile FK, remain disabled by default, and must pass their own
   residual tolerance during signed validation.
8. **Detailed humanoid authoring — complete as deterministic evidence.** A
   separately signed 54-role catalog expands Tai from the preserved 22-body
   compatibility rig to body, fingers, and eyes. Local rotation rings, sliders,
   undo/redo, paired mirroring, SOMA77 visualization, and the frozen Legacy Tai
   22-body oracle are integrated in the Studio. Capability coverage requires
   the 17-role core and reports optional detail independently.
9. **Reference-pose auto-fit — implemented for Studio authoring.** The solver
   fits mapped child directions without changing bind data, leaves one-vector
   twist explicitly unresolved, previews before acceptance, and records later
   manual corrections as residuals. Broader perceptual acceptance across
   distinct rig families remains an evidence gate.
10. **Temporal foot-lock calibration — implemented for the Tai qualification
    slice.** Studio profiles can hold planted X/Z targets, level and retain
    each foot's acquired heading, blend contact acquisition and release,
    preserve measured ankle height, apply bounded pelvis lowering when the
    calibrated leg cannot reach the ground, and constrain knee bend with
    rest-pose poles. The qualification tier requires contact
    release coverage. The original 120-frame `.96` Core27 turn capture now
    supplies 8 left and 9 right contact transitions through an explicit,
    signed SOMA77 qualification adapter. With the explicit 8 cm pelvis-lowering
    bound enabled, the Tai slice reaches both planted targets within numerical
    epsilon while retaining the 1 cm acceptance gate. Broader avatars still
    require independent evidence.

## Risks and open questions

- Is the reference frame guaranteed to be a true calibration pose, or should
  the Studio accept a separate rest asset?
- Direction fitting cannot infer twist from one collinear child. A future pose
  suite may combine bent-elbow, knee, hand, and torso frames, but must retain
  uncertainty rather than inventing roll.
- The current scale estimate averages hips-to-foot distances. Should profiles
  additionally record arm-span and torso residuals and require agreement?
- Generic GLB/FBX rigs lack normalized humanoid semantics. The semi-manual UI
  exists, but hierarchy validation and duplicate-role UX need broader assets.
- A source and avatar can use different forward-axis conventions even after
  format normalization. Basis correction needs explicit gizmo authoring,
  never heuristic silent repair.
- Legacy contact correction is explicitly stateful, so consumers must use a
  session and solve frames sequentially. Random frame seeking requires replay
  from a reset or a future signed state checkpoint.
- The 54-control profile proves deterministic hand solving, not perceptual hand
  quality. A separate manually accepted hand suite and thresholds are still
  required before calling it a golden detailed calibration.
- Profile signatures bind stable structural node paths. Re-exporting an
  otherwise identical asset with a changed hierarchy correctly invalidates the
  profile, but the recovery UX is not implemented.
