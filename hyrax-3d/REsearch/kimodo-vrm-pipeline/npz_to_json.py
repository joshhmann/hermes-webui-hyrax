# npz_to_json.py — convert Kimodo/ARDY NPZ output to compact JSON for the JS retargeter.
# Handles somaskel30, somaskel77 (truncated to body joints), and ARDY cskel27.
import json
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

# ARDY Core27: Hips→Spine→Spine1→Spine2→Spine3→Neck→Head; Spine3 parents both
# shoulders (verified ardy/skeleton/definitions.py:358,365); legs Hips→UpLeg→Leg→Foot→ToeBase.
# NOTE: Core27 "LeftLeg" = KNEE.
CORE27 = [
    ("Hips", None), ("Spine", "Hips"), ("Spine1", "Spine"), ("Spine2", "Spine1"),
    ("Spine3", "Spine2"), ("Neck", "Spine3"), ("Head", "Neck"),
    ("LeftShoulder", "Spine3"), ("LeftArm", "LeftShoulder"), ("LeftForeArm", "LeftArm"),
    ("LeftHand", "LeftForeArm"), ("LeftHandEnd", "LeftHand"), ("LeftHandThumb1", "LeftHand"),
    ("RightShoulder", "Spine3"), ("RightArm", "RightShoulder"), ("RightForeArm", "RightArm"),
    ("RightHand", "RightForeArm"), ("RightHandEnd", "RightHand"), ("RightHandThumb1", "RightHand"),
    ("LeftUpLeg", "Hips"), ("LeftLeg", "LeftUpLeg"), ("LeftFoot", "LeftLeg"), ("LeftToeBase", "LeftFoot"),
    ("RightUpLeg", "Hips"), ("RightLeg", "RightUpLeg"), ("RightFoot", "RightLeg"), ("RightToeBase", "RightFoot"),
]

def detect_skeleton(d):
    """Pick the joint list by column count; verify by name order if NPZ carries names."""
    j = d["global_rot_mats"].shape[1]
    if j == 27:
        return "cskel27", CORE27
    if j == 30:
        return "somaskel30", SOMA30
    if j == 77:
        # somaskel77: first 30 entries follow somaskel30 order; keep body subset.
        return "somaskel77", SOMA30
    raise ValueError(f"Unsupported joint count {j} — inspect the NPZ and add its layout.")

def convert(npz_path: str, out_path: str):
    d = np.load(npz_path)
    skeleton, layout = detect_skeleton(d)
    n = len(layout)
    rot = d["global_rot_mats"][:, :n]          # [T, J, 3, 3]
    out = {
        "skeleton": skeleton,
        "fps": int(d["fps"]) if "fps" in d else 30,
        "joints": [name for name, _ in layout],
        "parents": [p for _, p in layout],
        "global_rot_mats": rot.reshape(rot.shape[0], n, 9).tolist(),  # row-major
        "root_positions": d["root_positions"].tolist(),   # true pelvis — drives hips
        "foot_contacts": d["foot_contacts"].tolist(),     # [T, 4] L-heel, L-toe, R-heel, R-toe
    }
    # Kimodo only: keep the smoothed root for path logic (ARDY aliases it — do not rely on it).
    if "smooth_root_pos" in d and not np.array_equal(d["smooth_root_pos"], d["root_positions"]):
        out["smooth_root_pos"] = d["smooth_root_pos"].tolist()
    with open(out_path, "w") as f:
        json.dump(out, f)
    print(f"wrote {out_path}: skeleton={skeleton}, T={len(out['root_positions'])} frames")

if __name__ == "__main__":
    import sys
    convert(sys.argv[1], sys.argv[2])
