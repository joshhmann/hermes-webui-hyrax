# SOMA77 Converter Contract

## Input hierarchy

Lossless SOMA77 conversion requires:

- `global_rot_mats[T,77,3,3]`;
- a readable sibling BVH with exactly 77 `ROOT`/`JOINT` entries;
- the canonical names in exact depth-first order;
- one root with no parent;
- every non-root parent earlier in the order; and
- no duplicate joint names.

Missing or mismatched BVH metadata is rejected. A compatibility alias never
relaxes hierarchy or shape checks.

## Retained joints and order

All 77 joints are retained in the exact order frozen by
`contracts/soma77.skeleton.json`. Runtime body subsets are metadata selections;
the converter never collapses the source hierarchy.

## Transform conventions

- rotations are source world/global matrices;
- matrices are flattened row-major mat3 values;
- `root_positions` is the authoritative world-space Hips position;
- `rest_offsets_m` is parent-local, reconstructed from frame-zero source world
  positions and parent world rotations;
- child world positions reconstruct as
  `parentWorldPosition + parentWorldRotation * childRestOffset`;
- `smooth_root_pos`, when present and distinct, is retained only for path logic
  and is not the avatar root contract.

No retained joint is reparented. There are no collapsed-parent rotation rules
because ingress collapse is forbidden.

## Compatibility

- canonical output identity: `soma77`;
- accepted source identity: `somaskel77`;
- runtime subset: the named 30-joint body selection;
- the legacy validator command `--validate-77to30` aliases the lossless
  SOMA77 validator but does not produce a collapsed payload.

## Tolerances

The frozen skeleton contract declares:

- matrix component absolute tolerance: `1e-6`;
- maximum retained-joint FK position error: `0.001 m`;
- maximum angular error: `1e-6 rad`.

The checked real 150-frame Kimodo artifact records approximately
`0.000479 mm` maximum and `0.0001 mm` mean retained-joint position error, and
less than `0.0000001 rad` maximum angular error. Exact values and empty
failure fields are in `evidence/kimodo-150.converter-evidence.json`.

The artifact also records the converter version, repository commit, converter
source signature, NPZ/BVH signatures, source skeleton signature, retained
contract signature, frame/joint counts, both tolerances, and failing
frame/joint/metric fields even when they are `null`.
