# Current Hardcoded Tai/Avatar Retarget Pipeline

This is the golden reference path in
`REsearch/kimodo-vrm-pipeline/SomaVrmRetargeter.js`. It remains intact while
the Studio is proven.

## Data flow

1. Select one of the hardcoded `somaskel30`, `soma77`/`somaskel77` alias, or
   `cskel27` source-to-VRM bone maps.
2. Build a source joint index from motion order.
3. For every target in hardcoded topological order, read the configured source
   rest-frame global row-major mat3 and store its inverse quaternion.
4. Assume the three-vrm normalized target rig has identity rest rotations.
5. For a frame, compute source world rotation multiplied by the stored inverse
   source rest.
6. If a scene root is supplied, strip its Y yaw from hips.
7. Convert each driven world quaternion to target local using the hardcoded
   semantic parent map.
8. Scale `root_positions[frame] - root_positions[0]` by target hips world Y
   divided by source hips height.
9. Add the scaled trajectory to normalized hips, preserving stored rest Y.
10. For contacted toe channels, measure the lower foot and apply a smoothed
    vertical hips correction.
11. Call `vrm.humanoid.update()`.

## Hardcoded values and assumptions

- 22 body bone mappings for each source skeleton;
- SOMA77 and `somaskel77` reuse the 30-body-joint selection;
- the explicit 22-entry solve order;
- the explicit target semantic parent table;
- default source rest frame `0`;
- default source hips height `0.954 m`;
- normalized target rest rotations are identity;
- matrices are global, row-major mat3;
- root translation always uses `root_positions`, never `smooth_root_pos`;
- root baseline is always frame `0`, independent of rest-frame option;
- optional scene root owns yaw and hips strips that yaw;
- target scale is the ratio of target hips world Y to source hips height;
- ground plane defaults to `0`;
- contact threshold is strictly greater than `0.5`;
- left foot uses channel `1`, right foot channel `3`;
- contact smoothing defaults to `0.4`;
- ground correction is persistent temporal state and resets to `0` on chunk
  reset;
- Three.js quaternions use xyzw and `Matrix4.set` supplies row-major elements;
- the target is specifically a three-vrm normalized humanoid.

`calibrate/AvatarRetargeter.js` moves several tables into the legacy profile
shape but preserves the same assumptions. Its FABRIK method is not part of the
golden FK path and must not be used to establish calibration equivalence.

## Migration gate

The generic Studio consumer may replace this path only after a baseline harness
proves frame-by-frame equivalence for all driven local/world transforms across
rest, known-good cskel27, corrected Kimodo SOMA77, locomotion, torso/arm-heavy,
contact transition, and reset samples. Any intentional behavior change must be
separated from profile extraction.

The extraction is now represented explicitly by
`evidence/tai.legacy-compatibility.validated.json`. It keeps the canonical
measured calibration unchanged while placing the legacy `0.954 m` scale
reference, XZ root replacement, contact channels, threshold, smoothing, and
temporal correction in `runtime_corrections`.
`evidence/tai-legacy-compat-vs-hardcoded.json` passes with maximum
`5.057692232712207e-8 m` world-position error. This proves the optional
consumer path; it does not authorize deleting or silently replacing the golden
runtime.
