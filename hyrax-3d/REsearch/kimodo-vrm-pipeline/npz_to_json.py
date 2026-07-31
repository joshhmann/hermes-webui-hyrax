# npz_to_json.py — convert Kimodo/ARDY NPZ output to compact JSON for the JS retargeter.
# Handles somaskel30, lossless SOMA77, and ARDY cskel27.
#
# ARDY cskel27 schema (validated 2026-07-28 against real captures, see
# PIPELINE_VALIDATION_2026-07-28.md): the NPZ carries NO rotation matrices.
#   local_rots    [T,27,4] float32 quaternions, wxyz, parent-relative
#   root_quat     [T,4]     wxyz — identical to local_rots[:,0]
#   root_pos      [T,3]     world, meters
#   posed_joints  [T,27,3]  world, meters (ground truth for FK validation)
#   contacts      [T]       uint8 bitmask: bit0=L-heel, bit1=L-toe, bit2=R-heel,
#                           bit3=R-toe (ARDY_OUTPUT_CONTRACT.md §3.2 ContactIndex)
#   timestamps    [T]       float64 seconds
#   fps           NOT in the NPZ — sidecar chunk_*.json ("fps": 20.0)
# Joint order is RIGHT-side-first (RightShoulder=7 … LeftShoulder=13,
# RightUpLeg=19 … LeftUpLeg=23) per skeleton_contract.json in each capture dir.
# Global rotations are derived by FK: R_j = R_parent @ L_j, root = root_quat.
# FK convention proven to 0.0005 mm against posed_joints.
import json
import hashlib
import os
import re
import subprocess
import sys

import numpy as np

# Verified against kimodo.skeleton.SOMASkeleton30 / ardy/skeleton/definitions.py
SOMA30 = [
    ("Hips", None), ("Spine1", "Hips"), ("Spine2", "Spine1"), ("Chest", "Spine2"),
    ("Neck1", "Chest"), ("Neck2", "Neck1"), ("Head", "Neck2"), ("Jaw", "Head"),
    ("LeftEye", "Head"), ("RightEye", "Head"),
    ("LeftShoulder", "Chest"), ("LeftArm", "LeftShoulder"), ("LeftForeArm", "LeftArm"),
    ("LeftHand", "LeftForeArm"), ("LeftHandThumbEnd", "LeftHand"), ("LeftHandMiddleEnd", "LeftHand"),
    ("RightShoulder", "Chest"), ("RightArm", "RightShoulder"), ("RightForeArm", "RightArm"),
    ("RightHand", "RightForeArm"), ("RightHandThumbEnd", "RightHand"), ("RightHandMiddleEnd", "RightHand"),
    ("LeftLeg", "Hips"), ("LeftShin", "LeftLeg"), ("LeftFoot", "LeftShin"), ("LeftToeBase", "LeftFoot"),
    ("RightLeg", "Hips"), ("RightShin", "RightLeg"), ("RightFoot", "RightShin"), ("RightToeBase", "RightFoot"),
]


def _finger_joints(side: str) -> list[str]:
    joints = []
    for finger, segment_count in (
        ("Thumb", 3),
        ("Index", 4),
        ("Middle", 4),
        ("Ring", 4),
        ("Pinky", 4),
    ):
        joints.extend(
            f"{side}Hand{finger}{segment}"
            for segment in range(1, segment_count + 1)
        )
        joints.append(f"{side}Hand{finger}End")
    return joints


# Canonical adapter order from Kimodo's 77-joint BVH export. Keep this
# independent of avatar profiles: source identity is an ingress contract.
SOMA77_JOINTS = [
    "Hips", "Spine1", "Spine2", "Chest", "Neck1", "Neck2", "Head",
    "HeadEnd", "Jaw", "LeftEye", "RightEye",
    "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
    *_finger_joints("Left"),
    "RightShoulder", "RightArm", "RightForeArm", "RightHand",
    *_finger_joints("Right"),
    "LeftLeg", "LeftShin", "LeftFoot", "LeftToeBase", "LeftToeEnd",
    "RightLeg", "RightShin", "RightFoot", "RightToeBase", "RightToeEnd",
]

# ARDY Core27 embedded contract — copy of the skeleton_contract.json shipped
# with every capture (RIGHT-side-first order; used only when no contract file
# is found next to the NPZ). Hierarchy: Spine3 parents both shoulders,
# legs chain Hips→UpLeg→Leg→Foot→ToeBase. NOTE: Core27 "LeftLeg" = KNEE.
CORE27_CONTRACT = {
    "skeleton_id": "ardy-cskel27",
    "joint_names": [
        "Hips", "Spine", "Spine1", "Spine2", "Spine3", "Neck", "Head",
        "RightShoulder", "RightArm", "RightForeArm", "RightHand", "RightHandEnd", "RightHandThumb1",
        "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand", "LeftHandEnd", "LeftHandThumb1",
        "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase",
        "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase",
    ],
    "parent_indices": [
        -1, 0, 1, 2, 3, 4, 5, 4, 7, 8, 9, 10, 10, 4, 13, 14, 15, 16, 16,
        0, 19, 20, 21, 0, 23, 24, 25,
    ],
    "rest_offsets_m": [
        [0.0, 0.0, 0.0],
        [0.0, 0.07098910212516785, -0.04732609912753105],
        [0.0, 0.09321421384811401, -0.016436193138360977],
        [0.0, 0.09429201483726501, -0.008249528706073761],
        [0.0, 0.0946522057056427, -9.685754776000977e-08],
        [0.0, 0.2484619915485382, 0.035494349896907806],
        [0.0, 0.12816983461380005, 0.02259967103600502],
        [-0.03199490159749985, 0.17277202010154724, 0.0533246248960495],
        [-0.15890800207853317, -5.960464477539063e-08, 0.0],
        [-0.2954360097646713, -5.960464477539063e-08, 0.0],
        [-0.23265200853347778, -1.1920928955078125e-07, 0.0],
        [-0.06961148977279663, 0.0, 0.0],
        [-0.027844548225402832, -0.018563032150268555, 0.04640771634876728],
        [0.03199490159749985, 0.17277202010154724, 0.0533246248960495],
        [0.15890800207853317, 0.0, 0.0],
        [0.2954360097646713, 0.0, 0.0],
        [0.23265200853347778, 0.0, 0.0],
        [0.06961148977279663, 0.0, 0.0],
        [0.027844548225402832, -0.018563032150268555, 0.04640771634876728],
        [-0.09491819888353348, -0.02772890031337738, 0.0],
        [0.0, -0.41211800277233124, 0.0],
        [0.0, -0.4560910165309906, 1.0127254295803483e-16],
        [0.0, -0.05847489833831787, 0.16065827012062062],
        [0.09491819888353348, -0.02772890031337738, 0.0],
        [0.0, -0.41211800277233124, 0.0],
        [0.0, -0.4560910165309906, 1.0127254295803483e-16],
        [0.0, -0.05847489833831787, 0.16065827012062062],
    ],
}


def load_contract(npz_path: str, contract_path: str | None = None) -> dict:
    """Skeleton contract for cskel27: explicit path, else sibling
    skeleton_contract.json, else the embedded copy. Fail closed on a
    malformed or non-27-joint contract."""
    candidates = [c for c in (contract_path,
                              os.path.join(os.path.dirname(os.path.abspath(npz_path)),
                                           "skeleton_contract.json")) if c]
    for path in candidates:
        if os.path.exists(path):
            with open(path) as f:
                contract = json.load(f)
            _check_contract(contract, path)
            return contract
    _check_contract(CORE27_CONTRACT, "<embedded>")
    return CORE27_CONTRACT


def _check_contract(contract: dict, source: str) -> None:
    for key in ("joint_names", "parent_indices", "rest_offsets_m"):
        if key not in contract:
            raise ValueError(f"contract {source}: missing '{key}'")
    n = len(contract["joint_names"])
    if n != 27:
        raise ValueError(f"contract {source}: {n} joints, expected 27 (ardy-cskel27)")
    if len(contract["parent_indices"]) != n or len(contract["rest_offsets_m"]) != n:
        raise ValueError(f"contract {source}: ragged joint/parent/offset lists")
    names = contract["joint_names"]
    parents = contract["parent_indices"]
    for j, p in enumerate(parents):
        if p >= j:
            raise ValueError(f"contract {source}: parent of joint {j} ({names[j]}) is not earlier in the list")
        if j > 0 and p < 0:
            raise ValueError(f"contract {source}: non-root joint {j} ({names[j]}) has no parent")


def _q2m_wxyz(q) -> np.ndarray:
    """Quaternion (w, x, y, z) → 3×3 rotation matrix."""
    w, x, y, z = q
    n = w * w + x * x + y * y + z * z
    s = 2.0 / n
    return np.array([
        [1 - s * (y * y + z * z), s * (x * y - w * z), s * (x * z + w * y)],
        [s * (x * y + w * z), 1 - s * (x * x + z * z), s * (y * z - w * x)],
        [s * (x * z - w * y), s * (y * z + w * x), 1 - s * (x * x + y * y)],
    ])


def fk_global_rots(local_rots: np.ndarray, parents) -> np.ndarray:
    """local_rots [T,J,4] wxyz → global rotation matrices [T,J,3,3].
    R_root = L_0 (root_quat is identical to local_rots[:,0] in real captures),
    R_j = R_parent @ L_j. Convention proven to 0.0005 mm vs posed_joints."""
    T, J, _ = local_rots.shape
    rot = np.zeros((T, J, 3, 3), dtype=np.float64)
    for t in range(T):
        mats = [_q2m_wxyz(local_rots[t, j]) for j in range(J)]
        rot[t, 0] = mats[0]
        for j in range(1, J):
            rot[t, j] = rot[t, parents[j]] @ mats[j]
    return rot


def decode_contacts(d, T: int) -> np.ndarray:
    """→ [T,4] float, channels [L-heel, L-toe, R-heel, R-toe].
    ARDY writes a uint8 bitmask; bit meaning per ARDY_OUTPUT_CONTRACT.md §3.2
    (ContactIndex: LEFT_HEEL=0, LEFT_TOE=1, RIGHT_HEEL=2, RIGHT_TOE=3;
    bitmask = sum(1<<k for set channel k)) — documented, not inferred."""
    if "foot_contacts" in d:  # Kimodo-style NPZ
        return np.asarray(d["foot_contacts"], dtype=np.float64)[:, :4]
    if "contacts" in d:
        c = np.asarray(d["contacts"]).astype(np.uint8).reshape(-1)
        out = np.zeros((T, 4), dtype=np.float64)
        for k in range(4):
            out[:, k] = (c >> k) & 1
        return out
    return np.zeros((T, 4), dtype=np.float64)


def resolve_fps(d, npz_path: str) -> float:
    """fps lives in the sidecar chunk JSON for ARDY captures; Kimodo NPZs
    carry it inline. Fall back to timestamp spacing, then 30."""
    sidecar = os.path.splitext(npz_path)[0] + ".json"
    if os.path.exists(sidecar):
        with open(sidecar) as f:
            meta = json.load(f)
        if "fps" in meta:
            return float(meta["fps"])
    if "fps" in d:
        return float(d["fps"])
    if "timestamps" in d:
        ts = np.asarray(d["timestamps"], dtype=np.float64).reshape(-1)
        if ts.size > 1:
            dt = float(np.median(np.diff(ts)))
            if dt > 0:
                return 1.0 / dt
    print(f"warning: no fps found for {npz_path}; defaulting to 30", file=sys.stderr)
    return 30.0


def detect_skeleton(d) -> str:
    """ARDY cskel27 NPZs have no rotation-matrix keys — detect them by the
    quaternion schema. Kimodo somaskel NPZs carry global_rot_mats."""
    if "local_rots" in d and "root_pos" in d:
        j = d["local_rots"].shape[1]
        if j == 27:
            return "cskel27"
        raise ValueError(f"local_rots has {j} joints — unsupported ARDY layout")
    j = d["global_rot_mats"].shape[1]
    if j == 27:
        return "cskel27"
    if j == 30:
        return "somaskel30"
    if j == 77:
        # somaskel77: first 30 entries follow somaskel30 order; keep body subset.
        return "somaskel77"
    raise ValueError(f"Unsupported joint count {j} — inspect the NPZ and add its layout.")


def _round(a: np.ndarray, ndigits: int = 6) -> np.ndarray:
    return np.round(np.asarray(a, dtype=np.float64), ndigits)


def convert_cskel27(d, npz_path: str, out_path: str, contract_path: str | None = None):
    contract = load_contract(npz_path, contract_path)
    names = contract["joint_names"]
    parents_idx = contract["parent_indices"]
    offsets = np.asarray(contract["rest_offsets_m"], dtype=np.float64)

    local_rots = np.asarray(d["local_rots"], dtype=np.float64)
    T = local_rots.shape[0]
    rot = fk_global_rots(local_rots, parents_idx)          # [T,27,3,3]
    root_pos = np.asarray(d["root_pos"], dtype=np.float64)
    contacts = decode_contacts(d, T)
    fps = resolve_fps(d, npz_path)

    out = {
        "skeleton": "cskel27",
        "rotation_space": "global",
        "fps": int(fps) if float(fps).is_integer() else fps,
        "joints": list(names),
        "parents": [None if p < 0 else names[p] for p in parents_idx],
        "global_rot_mats": _round(rot.reshape(T, len(names), 9)).tolist(),  # row-major
        "root_positions": _round(root_pos).tolist(),     # true pelvis — drives hips
        "foot_contacts": contacts.tolist(),              # [T,4] L-heel, L-toe, R-heel, R-toe
        # Additive fields (the JS retargeter ignores unknown keys):
        "rest_offsets_m": offsets.tolist(),              # FK ground truth for debug FK
        "meta": {
            "source": os.path.basename(npz_path),
            "npz_keys": sorted(d.files),
            "quat_convention": "wxyz",
            "contact_encoding": "uint8 bitmask bit0=L-heel bit1=L-toe bit2=R-heel bit3=R-toe",
            "coord_frame": contract.get("coord_frame", "rh-yup-zforward-m"),
        },
    }
    if "timestamps" in d:
        out["timestamps"] = _round(np.asarray(d["timestamps"], dtype=np.float64)).tolist()
    with open(out_path, "w") as f:
        json.dump(out, f)
    print(f"wrote {out_path}: skeleton=cskel27, T={T} frames, fps={out['fps']}")


def _parse_bvh_hierarchy(bvh_path: str) -> tuple[list[str] | None, list[int] | None]:
    """Parse BVH file for joint names in depth-first order and parent indices.

    Returns (joint_names, parent_indices) matching the channel layout in the
    corresponding NPZ's global_rot_mats.  Parent index is -1 for the root
    (Hips).  The depth-first hierarchy is reconstructed by tracking brace
    nesting depth: each JOINT/ROOT declaration records the current depth, then
    the parent of joint[i] is the most recent joint[j<i] at depth[i]-1.
    """
    if not os.path.isfile(bvh_path):
        return None, None
    try:
        depth = 0
        names = []
        depths = []
        with open(bvh_path) as f:
            for line in f:
                stripped = line.strip()
                if "{" in stripped:
                    depth += stripped.count("{")
                if "}" in stripped:
                    depth -= stripped.count("}")
                m = _BVH_JOINT_RE.match(line)
                if m:
                    name = m.group(1)
                    if name == "Root":
                        continue  # skip the BVH root node
                    names.append(name)
                    depths.append(depth)
        if not names:
            return None, None
        parents = [-1] * len(names)
        for i in range(1, len(names)):
            for j in range(i - 1, -1, -1):
                if depths[j] == depths[i] - 1:
                    parents[i] = j
                    break
        return names, parents
    except (OSError, UnicodeDecodeError):
        return None, None


_BVH_JOINT_RE = re.compile(r"^\s*(?:ROOT|JOINT)\s+(\S+)")


def _rest_offsets_from_positions(d, n, layout, rot):
    """Estimate parent-local rest offsets from frame-0 world positions."""
    rest = np.zeros((n, 3), dtype=np.float64)
    if "posed_joints" not in d:
        return rest
    name_idx = {name: i for i, (name, _) in enumerate(layout)}
    parent_idx = [None if p is None else name_idx[p] for _, p in layout]
    posed = np.asarray(d["posed_joints"][0], dtype=np.float64)
    if posed.ndim == 1:
        posed = posed.reshape(-1, 3)
    for j in range(1, n):
        pi = parent_idx[j]
        if pi is None:
            continue
        delta = posed[j] - posed[pi]
        R_p = rot[0, pi]
        rest[j] = R_p.T @ delta
    return rest


def _require_soma77_hierarchy(bvh_path: str, src_count: int):
    bvh_joints, bvh_parents = _parse_bvh_hierarchy(bvh_path)
    if bvh_joints is None or bvh_parents is None:
        raise ValueError(
            "SOMA77 conversion requires a readable sibling BVH hierarchy"
        )
    if len(bvh_joints) != src_count:
        raise ValueError(
            "SOMA77 BVH joint count does not match global_rot_mats: "
            f"{len(bvh_joints)} != {src_count}"
        )
    if bvh_joints != SOMA77_JOINTS:
        mismatch = next(
            (
                index
                for index, (actual, expected) in enumerate(
                    zip(bvh_joints, SOMA77_JOINTS, strict=True)
                )
                if actual != expected
            ),
            min(len(bvh_joints), len(SOMA77_JOINTS)),
        )
        actual = bvh_joints[mismatch] if mismatch < len(bvh_joints) else "<missing>"
        expected = (
            SOMA77_JOINTS[mismatch]
            if mismatch < len(SOMA77_JOINTS)
            else "<none>"
        )
        raise ValueError(
            "SOMA77 BVH does not match the canonical joint order at "
            f"{mismatch}: {actual!r} != {expected!r}"
        )
    if len(set(bvh_joints)) != len(bvh_joints):
        raise ValueError("SOMA77 BVH contains duplicate joint names")
    for joint, parent in enumerate(bvh_parents):
        if joint == 0 and parent != -1:
            raise ValueError("SOMA77 BVH root must not have a parent")
        if joint > 0 and not 0 <= parent < joint:
            raise ValueError(
                f"SOMA77 BVH parent for joint {joint} is not earlier in the hierarchy"
            )
    return bvh_joints, bvh_parents


def convert(npz_path: str, out_path: str, contract_path: str | None = None):
    d = np.load(npz_path)
    skeleton = detect_skeleton(d)
    if skeleton == "cskel27" and "local_rots" in d:
        convert_cskel27(d, npz_path, out_path, contract_path)
        return

    # Kimodo path (somaskel30/77, or a cskel27 export that carries matrices).
    # The source arrays are already world rotations. Preserve that space and,
    # for SOMA77, preserve every joint; consumers select their runtime subset.
    bvh_path = os.path.splitext(npz_path)[0] + ".bvh"
    full_world = np.asarray(d["global_rot_mats"], dtype=np.float64)
    src_count = full_world.shape[1]

    if skeleton == "somaskel77":
        bvh_joints, bvh_parents = _require_soma77_hierarchy(
            bvh_path, src_count
        )
        layout = [
            (
                name,
                None if parent < 0 else bvh_joints[parent],
            )
            for name, parent in zip(bvh_joints, bvh_parents, strict=True)
        ]
        n = len(layout)
        rot = full_world
        skeleton_label = "soma77"
        source_skeleton = "somaskel77"
        runtime_subset = [name for name, _ in SOMA30]
    else:
        layout = CORE27_LAYOUT if skeleton == "cskel27" else SOMA30
        n = len(layout)
        if src_count != n:
            raise ValueError(
                f"{skeleton} has {src_count} joints, expected {n}"
            )
        rot = full_world[:, :n]
        skeleton_label = skeleton
        source_skeleton = skeleton
        runtime_subset = None

    rest_offsets = _rest_offsets_from_positions(d, n, layout, rot)
    T = rot.shape[0]

    out = {
        "skeleton": skeleton_label,
        "source_skeleton": source_skeleton,
        "rotation_space": "global",
        "fps": int(d["fps"]) if "fps" in d else 30,
        "joints": [name for name, _ in layout],
        "parents": [p for _, p in layout],
        "global_rot_mats": rot.reshape(T, n, 9).tolist(),  # row-major
        "root_positions": d["root_positions"].tolist(),   # true pelvis — drives hips
        "rest_offsets_m": rest_offsets.tolist(),           # FK ground truth
        "foot_contacts": decode_contacts(d, T).tolist(),  # [T, 4] L-heel, L-toe, R-heel, R-toe
    }
    if runtime_subset is not None:
        out["runtime_subset"] = runtime_subset
    # Kimodo only: keep the smoothed root for path logic (ARDY aliases it — do not rely on it).
    if "smooth_root_pos" in d and not np.array_equal(d["smooth_root_pos"], d["root_positions"]):
        out["smooth_root_pos"] = d["smooth_root_pos"].tolist()
    with open(out_path, "w") as f:
        json.dump(out, f)
    print(f"wrote {out_path}: skeleton={skeleton_label}, T={T} frames")


# (name, parent) pairs for a Kimodo-style cskel27 matrix export — same
# right-first order as the real ARDY contract.
CORE27_LAYOUT = [(name, None if p < 0 else CORE27_CONTRACT["joint_names"][p])
                 for name, p in zip(CORE27_CONTRACT["joint_names"],
                                    CORE27_CONTRACT["parent_indices"],
                                    strict=True)]


def validate_cskel27(json_path: str, npz_path: str, contract_path: str | None = None,
                     tolerance_mm: float = 1.0) -> bool:
    """FK-validate a converted JSON against the source NPZ's posed_joints:
    recompute world positions as p_j = p_parent + R_parent @ rest_offset_j
    (R from the JSON's global_rot_mats) and compare. Prints PASS/FAIL."""
    with open(json_path) as f:
        m = json.load(f)
    d = np.load(npz_path)
    if "posed_joints" not in d:
        print(f"SKIP {json_path}: NPZ has no posed_joints to validate against")
        return True
    contract = load_contract(npz_path, contract_path)
    parents = contract["parent_indices"]
    offsets = np.asarray(contract["rest_offsets_m"], dtype=np.float64)
    ref = np.asarray(d["posed_joints"], dtype=np.float64)

    rot = np.asarray(m["global_rot_mats"], dtype=np.float64).reshape(-1, len(parents), 3, 3)
    root = np.asarray(m["root_positions"], dtype=np.float64)
    T = rot.shape[0]
    pos = np.zeros((T, len(parents), 3), dtype=np.float64)
    for t in range(T):
        pos[t, 0] = root[t]
        for j in range(1, len(parents)):
            p = parents[j]
            pos[t, j] = pos[t, p] + rot[t, p] @ offsets[j]
    err_mm = np.linalg.norm(pos - ref[:T], axis=2) * 1000.0
    ok = bool(err_mm.max() < tolerance_mm)
    verdict = "PASS" if ok else "FAIL"
    print(f"{verdict} {os.path.basename(json_path)}: max={err_mm.max():.4f} mm "
          f"mean={err_mm.mean():.4f} mm (T={T}, tol={tolerance_mm} mm)")
    return ok


def validate_soma77(json_path: str, npz_path: str,
                    tolerance_mm: float = 1.0) -> bool:
    """FK-validate lossless SOMA77 world rotations against source positions."""
    with open(json_path) as f:
        m = json.load(f)
    d = np.load(npz_path)
    if "posed_joints" not in d:
        print(f"SKIP {json_path}: NPZ has no posed_joints to validate against")
        return True
    bvh_path = os.path.splitext(npz_path)[0] + ".bvh"
    bvh_joints, _ = _parse_bvh_hierarchy(bvh_path)
    if not bvh_joints or len(bvh_joints) != d["global_rot_mats"].shape[1]:
        print(f"SKIP {json_path}: BVH unavailable or mismatched joint count")
        return True

    src_idx = {name: i for i, name in enumerate(bvh_joints)}
    idx_map = [src_idx.get(name) for name in m["joints"]]
    if None in idx_map:
        print(f"SKIP {json_path}: declared motion joints missing from BVH")
        return True

    if m.get("rotation_space") != "global":
        print(f"FAIL {json_path}: rotation_space is not global")
        return False

    # Source world positions in the JSON's declared joint order.
    posed = np.asarray(d["posed_joints"], dtype=np.float64)
    ref_world = posed[:, idx_map]

    # FK using the declared world rotations and parent-local rest offsets.
    J = len(m["joints"])
    rot = np.asarray(m["global_rot_mats"], dtype=np.float64).reshape(-1, J, 3, 3)
    offsets = np.asarray(m["rest_offsets_m"], dtype=np.float64)
    root = np.asarray(m["root_positions"], dtype=np.float64)
    T = rot.shape[0]
    parents = [None if p is None else m["joints"].index(p) for p in m["parents"]]

    pos = np.zeros((T, J, 3), dtype=np.float64)
    for t in range(T):
        pos[t, 0] = root[t]
        for j in range(1, J):
            p = parents[j]
            pos[t, j] = pos[t, p] + rot[t, p] @ offsets[j]

    err_mm = np.linalg.norm(pos - ref_world[:T], axis=2) * 1000.0
    ok = bool(err_mm.max() < tolerance_mm)
    verdict = "PASS" if ok else "FAIL"
    print(f"{verdict} {os.path.basename(json_path)}: "
          f"max={err_mm.max():.4f} mm  mean={err_mm.mean():.4f} mm "
          f"(T={T}, n={J}, tol={tolerance_mm} mm)")
    return ok


def _sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def _canonical_signature(value) -> str:
    encoded = json.dumps(
        value, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode()
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def write_soma77_evidence(
    json_path: str,
    npz_path: str,
    out_path: str,
    position_tolerance_mm: float = 1.0,
    angular_tolerance_rad: float = 1e-6,
) -> bool:
    """Write stable machine-readable evidence for the lossless converter."""
    with open(json_path) as handle:
        motion = json.load(handle)
    source = np.load(npz_path)
    bvh_path = os.path.splitext(npz_path)[0] + ".bvh"
    source_joints, source_parents = _require_soma77_hierarchy(
        bvh_path, source["global_rot_mats"].shape[1]
    )
    source_parent_names = [
        None if parent < 0 else source_joints[parent]
        for parent in source_parents
    ]
    source_index = {name: index for index, name in enumerate(source_joints)}
    index_map = [source_index[name] for name in motion["joints"]]

    source_rot = np.asarray(source["global_rot_mats"], dtype=np.float64)[:, index_map]
    retained_rot = np.asarray(
        motion["global_rot_mats"], dtype=np.float64
    ).reshape(source_rot.shape)
    # Generator matrices are float32 and may be very slightly non-orthogonal.
    # Project both sides to SO(3) before measuring geodesic angular error so
    # identical retained matrices correctly report zero rather than measuring
    # source quantization as converter drift.
    source_u, _, source_vh = np.linalg.svd(source_rot)
    retained_u, _, retained_vh = np.linalg.svd(retained_rot)
    source_orthogonal = np.matmul(source_u, source_vh)
    retained_orthogonal = np.matmul(retained_u, retained_vh)
    relative = np.einsum(
        "...ji,...jk->...ik", retained_orthogonal, source_orthogonal
    )
    cos_angle = np.clip(
        (np.trace(relative, axis1=-2, axis2=-1) - 1.0) / 2.0,
        -1.0,
        1.0,
    )
    angular_error = np.arccos(cos_angle)

    offsets = np.asarray(motion["rest_offsets_m"], dtype=np.float64)
    roots = np.asarray(motion["root_positions"], dtype=np.float64)
    parent_indices = [
        -1 if parent is None else motion["joints"].index(parent)
        for parent in motion["parents"]
    ]
    positions = np.zeros_like(np.asarray(source["posed_joints"])[:, index_map])
    positions[:, 0] = roots
    for joint in range(1, len(parent_indices)):
        parent = parent_indices[joint]
        positions[:, joint] = (
            positions[:, parent]
            + np.einsum("tij,j->ti", retained_rot[:, parent], offsets[joint])
        )
    reference_positions = np.asarray(source["posed_joints"], dtype=np.float64)[:, index_map]
    position_error_mm = np.linalg.norm(
        positions - reference_positions, axis=2
    ) * 1000.0

    position_failure = np.argwhere(position_error_mm >= position_tolerance_mm)
    angular_failure = np.argwhere(angular_error > angular_tolerance_rad)
    first_failure = None
    failure_metric = None
    if position_failure.size:
        first_failure = position_failure[0]
        failure_metric = "position"
    elif angular_failure.size:
        first_failure = angular_failure[0]
        failure_metric = "angular"

    try:
        converter_commit = subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=os.path.dirname(os.path.abspath(__file__)),
            text=True,
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        converter_commit = "unknown"

    evidence = {
        "schema": "soma77.converter-evidence",
        "schema_version": "1.0.0",
        "passed": first_failure is None,
        "converter": {
            "version": "soma77-lossless-v1",
            "commit": converter_commit,
            "source_signature": _sha256_file(__file__),
        },
        "source": {
            "npz_signature": _sha256_file(npz_path),
            "bvh_signature": _sha256_file(bvh_path),
            "skeleton_signature": _canonical_signature({
                "joints": source_joints,
                "parents": source_parent_names,
            }),
            "frame_count": int(source_rot.shape[0]),
            "joint_count": int(source_rot.shape[1]),
        },
        "retained_contract_signature": _canonical_signature({
            "skeleton": motion["skeleton"],
            "rotation_space": motion["rotation_space"],
            "joints": motion["joints"],
            "parents": motion["parents"],
            "root_field": "root_positions",
        }),
        "metrics": {
            "retained_joint_position_error_mm": {
                "max": float(position_error_mm.max()),
                "mean": float(position_error_mm.mean()),
                "tolerance": position_tolerance_mm,
            },
            "retained_joint_angular_error_rad": {
                "max": float(angular_error.max()),
                "mean": float(angular_error.mean()),
                "tolerance": angular_tolerance_rad,
            },
        },
        "failure": {
            "frame": None if first_failure is None else int(first_failure[0]),
            "joint": (
                None
                if first_failure is None
                else motion["joints"][int(first_failure[1])]
            ),
            "metric": failure_metric,
        },
    }
    with open(out_path, "w") as handle:
        json.dump(evidence, handle, indent=2, sort_keys=True)
        handle.write("\n")
    verdict = "PASS" if evidence["passed"] else "FAIL"
    print(
        f"{verdict} wrote {out_path}: "
        f"position_max={position_error_mm.max():.6f} mm "
        f"angular_max={angular_error.max():.9f} rad"
    )
    return bool(evidence["passed"])


def validate_77to30(json_path: str, npz_path: str,
                    tolerance_mm: float = 1.0) -> bool:
    """Backward-compatible CLI alias for the lossless SOMA77 validator."""
    return validate_soma77(json_path, npz_path, tolerance_mm)


if __name__ == "__main__":
    args = sys.argv[1:]
    contract = None
    if "--contract" in args:
        i = args.index("--contract")
        contract = args[i + 1]
        del args[i:i + 2]
    if args and args[0] == "--validate":
        ok = validate_cskel27(args[1], args[2], contract)
        sys.exit(0 if ok else 1)
    if args and args[0] in ("--validate-soma77", "--validate-77to30"):
        ok = validate_soma77(args[1], args[2],
                             float(args[3]) if len(args) > 3 else 1.0)
        sys.exit(0 if ok else 1)
    if args and args[0] == "--evidence-soma77":
        ok = write_soma77_evidence(
            args[1],
            args[2],
            args[3],
            float(args[4]) if len(args) > 4 else 1.0,
            float(args[5]) if len(args) > 5 else 1e-6,
        )
        sys.exit(0 if ok else 1)
    convert(args[0], args[1], contract)
