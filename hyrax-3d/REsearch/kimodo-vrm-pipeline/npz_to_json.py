# npz_to_json.py — convert Kimodo/ARDY NPZ output to compact JSON for the JS retargeter.
# Handles somaskel30, somaskel77 (truncated to body joints), and ARDY cskel27.
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
import os
import re
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


def _parse_bvh_joints(bvh_path: str) -> list[str] | None:
    """Extract joint names in depth-first order from a BVH file.

    Returns a list of joint names (excluding the ROOT node) or None if the
    file is missing or unparseable. The order matches the channel layout in
    the corresponding NPZ's global_rot_mats.
    """
    if not os.path.isfile(bvh_path):
        return None
    try:
        joints = []
        with open(bvh_path) as f:
            for line in f:
                m = _BVH_JOINT_RE.match(line)
                if m:
                    name = m.group(1)
                    if name != "Root":  # skip the BVH root node
                        joints.append(name)
        return joints if joints else None
    except (OSError, UnicodeDecodeError):
        return None


_BVH_JOINT_RE = re.compile(r"^\s*(?:ROOT|JOINT)\s+(\S+)")


def convert(npz_path: str, out_path: str, contract_path: str | None = None):
    d = np.load(npz_path)
    skeleton = detect_skeleton(d)
    if skeleton == "cskel27" and "local_rots" in d:
        convert_cskel27(d, npz_path, out_path, contract_path)
        return

    # Kimodo path (somaskel30/77, or a cskel27 export that carries matrices):
    # the NPZ already has global rotations and per-channel contacts.
    # For 77-joint captures, parse the sibling BVH to get the true joint
    # order (depth-first), then map SOMA30 names to their actual indices.
    layout = CORE27_LAYOUT if skeleton == "cskel27" else SOMA30
    n = len(layout)

    # Build index map from sibling BVH (or fall back to first-n truncation)
    bvh_path = os.path.splitext(npz_path)[0] + ".bvh"
    src_joints = _parse_bvh_joints(bvh_path)
    src_count = d["global_rot_mats"].shape[1]
    if src_joints and len(src_joints) == src_count:
        # Map each SOMA30 name to its index in the NPZ's global_rot_mats
        src_idx = {name: i for i, name in enumerate(src_joints)}
        idx_map = [src_idx.get(name) for name, _ in layout]
        if None not in idx_map:
            # All SOMA30 joints found — reorder from actual positions
            rot = d["global_rot_mats"][:, idx_map]          # [T, 30, 3, 3]
        else:
            print(f"warning: {os.path.basename(npz_path)}: {sum(1 for i in idx_map if i is None)} SOMA30 joints not in BVH; falling back to first-{n} truncation", file=sys.stderr)
            rot = d["global_rot_mats"][:, :n]
    else:
        rot = d["global_rot_mats"][:, :n]                  # [T, J, 3, 3]
    T = rot.shape[0]

    # Build parent index array and compute rest_offsets from the first frame.
    name_idx = {name: i for i, (name, _) in enumerate(layout)}
    parent_idx = [None if p is None else name_idx[p] for _, p in layout]
    posed = np.asarray(d.get("posed_joints", d["root_positions"])[0], dtype=np.float64)
    if posed.ndim == 1:
        posed = posed.reshape(-1, 3)
    rest_offsets = np.zeros((n, 3), dtype=np.float64)
    if "posed_joints" in d:
        for j in range(1, n):
            pi = parent_idx[j]
            if pi is None:
                continue
            delta = posed[j] - posed[pi]
            R_p = rot[0, pi]  # 3x3 rotation matrix of parent at frame 0
            rest_offsets[j] = R_p.T @ delta

    out = {
        "skeleton": skeleton,
        "fps": int(d["fps"]) if "fps" in d else 30,
        "joints": [name for name, _ in layout],
        "parents": [p for _, p in layout],
        "global_rot_mats": rot.reshape(T, n, 9).tolist(),  # row-major
        "root_positions": d["root_positions"].tolist(),   # true pelvis — drives hips
        "rest_offsets_m": rest_offsets.tolist(),           # FK ground truth
        "foot_contacts": decode_contacts(d, T).tolist(),  # [T, 4] L-heel, L-toe, R-heel, R-toe
    }
    # Kimodo only: keep the smoothed root for path logic (ARDY aliases it — do not rely on it).
    if "smooth_root_pos" in d and not np.array_equal(d["smooth_root_pos"], d["root_positions"]):
        out["smooth_root_pos"] = d["smooth_root_pos"].tolist()
    with open(out_path, "w") as f:
        json.dump(out, f)
    print(f"wrote {out_path}: skeleton={skeleton}, T={T} frames")


# (name, parent) pairs for a Kimodo-style cskel27 matrix export — same
# right-first order as the real ARDY contract.
CORE27_LAYOUT = [(name, None if p < 0 else CORE27_CONTRACT["joint_names"][p])
                 for name, p in zip(CORE27_CONTRACT["joint_names"],
                                    CORE27_CONTRACT["parent_indices"])]


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
    convert(args[0], args[1], contract)
