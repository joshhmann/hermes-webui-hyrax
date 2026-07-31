import importlib.util
import json
import re
from pathlib import Path

import numpy as np
import pytest


ROOT = Path(__file__).resolve().parents[1]
CONVERTER_PATH = (
    ROOT / "hyrax-3d" / "REsearch" / "kimodo-vrm-pipeline" / "npz_to_json.py"
)
PROFILE_PATH = (
    ROOT
    / "hyrax-3d"
    / "calibrate"
    / "calibration-profiles"
    / "tai-embodiment-v3.json"
)


def _load_converter():
    spec = importlib.util.spec_from_file_location("hyrax_npz_to_json", CONVERTER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _soma77_joints():
    profile = json.loads(PROFILE_PATH.read_text())
    return profile["soma77_canonical"]["joints"]


def _soma77_parents(joints):
    direct = {
        "Hips": None,
        "Spine1": "Hips",
        "Spine2": "Spine1",
        "Chest": "Spine2",
        "Neck1": "Chest",
        "Neck2": "Neck1",
        "Head": "Neck2",
        "HeadEnd": "Head",
        "Jaw": "Head",
        "LeftEye": "Head",
        "RightEye": "Head",
        "LeftShoulder": "Chest",
        "LeftArm": "LeftShoulder",
        "LeftForeArm": "LeftArm",
        "LeftHand": "LeftForeArm",
        "RightShoulder": "Chest",
        "RightArm": "RightShoulder",
        "RightForeArm": "RightArm",
        "RightHand": "RightForeArm",
        "LeftLeg": "Hips",
        "LeftShin": "LeftLeg",
        "LeftFoot": "LeftShin",
        "LeftToeBase": "LeftFoot",
        "LeftToeEnd": "LeftToeBase",
        "RightLeg": "Hips",
        "RightShin": "RightLeg",
        "RightFoot": "RightShin",
        "RightToeBase": "RightFoot",
        "RightToeEnd": "RightToeBase",
    }
    parents = []
    for name in joints:
        if name in direct:
            parents.append(direct[name])
            continue
        match = re.fullmatch(
            r"(Left|Right)Hand(Thumb|Index|Middle|Ring|Pinky)([1-4]|End)", name
        )
        assert match, f"test hierarchy has no parent rule for {name}"
        side, finger, segment = match.groups()
        if segment == "1":
            parents.append(f"{side}Hand")
        elif segment == "End":
            previous = "3" if finger == "Thumb" else "4"
            parents.append(f"{side}Hand{finger}{previous}")
        else:
            parents.append(f"{side}Hand{finger}{int(segment) - 1}")
    return parents


def _write_bvh(path, joints, parents):
    children = {name: [] for name in joints}
    for name, parent in zip(joints[1:], parents[1:], strict=True):
        children[parent].append(name)

    lines = ["HIERARCHY"]

    def emit(name, depth):
        keyword = "ROOT" if depth == 0 else "JOINT"
        indent = "  " * depth
        lines.extend(
            [
                f"{indent}{keyword} {name}",
                f"{indent}{{",
                f"{indent}  OFFSET 0 0 0",
                f"{indent}  CHANNELS 0",
            ]
        )
        for child in children[name]:
            emit(child, depth + 1)
        lines.append(f"{indent}}}")

    emit(joints[0], 0)
    path.write_text("\n".join(lines) + "\n")


def _rotation_z(radians):
    c = np.cos(radians)
    s = np.sin(radians)
    return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])


def _write_soma77_capture(tmp_path):
    joints = _soma77_joints()
    parents = _soma77_parents(joints)
    parent_indices = [-1] + [joints.index(parent) for parent in parents[1:]]
    frame_count = 2

    local = np.broadcast_to(
        np.eye(3), (frame_count, len(joints), 3, 3)
    ).copy()
    local[0, joints.index("Neck2")] = _rotation_z(0.35)
    local[1, joints.index("Neck2")] = _rotation_z(-0.2)
    local[0, joints.index("LeftHandIndex2")] = _rotation_z(0.5)
    local[1, joints.index("LeftHandIndex2")] = _rotation_z(-0.4)

    world = np.zeros_like(local)
    for frame in range(frame_count):
        world[frame, 0] = local[frame, 0]
        for joint in range(1, len(joints)):
            parent = parent_indices[joint]
            world[frame, joint] = world[frame, parent] @ local[frame, joint]

    offsets = np.zeros((len(joints), 3), dtype=np.float64)
    for joint in range(1, len(joints)):
        offsets[joint] = [0.01 * ((joint % 3) + 1), 0.02, 0.005]

    roots = np.array([[0.1, 0.9, -0.2], [0.15, 0.9, -0.1]])
    posed = np.zeros((frame_count, len(joints), 3), dtype=np.float64)
    for frame in range(frame_count):
        posed[frame, 0] = roots[frame]
        for joint in range(1, len(joints)):
            parent = parent_indices[joint]
            posed[frame, joint] = (
                posed[frame, parent] + world[frame, parent] @ offsets[joint]
            )

    npz_path = tmp_path / "kimodo_soma77.npz"
    np.savez(
        npz_path,
        global_rot_mats=world,
        local_rot_mats=local,
        posed_joints=posed,
        root_positions=roots,
        smooth_root_pos=roots,
        foot_contacts=np.zeros((frame_count, 6), dtype=np.bool_),
        fps=np.array(30),
    )
    _write_bvh(npz_path.with_suffix(".bvh"), joints, parents)
    return npz_path, joints, parents, world, posed


def test_soma77_conversion_preserves_full_world_space_contract(tmp_path):
    converter = _load_converter()
    npz_path, joints, parents, source_world, source_positions = (
        _write_soma77_capture(tmp_path)
    )
    out_path = tmp_path / "motion.json"

    converter.convert(str(npz_path), str(out_path))

    motion = json.loads(out_path.read_text())
    assert motion["skeleton"] == "soma77"
    assert motion["rotation_space"] == "global"
    assert motion["joints"] == joints
    assert motion["parents"] == parents
    assert motion["runtime_subset"] == [name for name, _ in converter.SOMA30]

    rotations = np.asarray(motion["global_rot_mats"]).reshape(2, 77, 3, 3)
    np.testing.assert_allclose(rotations, source_world, atol=1e-6)

    offsets = np.asarray(motion["rest_offsets_m"])
    rebuilt = np.zeros_like(source_positions)
    rebuilt[:, 0] = np.asarray(motion["root_positions"])
    for joint in range(1, len(joints)):
        parent = joints.index(parents[joint])
        rebuilt[:, joint] = (
            rebuilt[:, parent]
            + rotations[:, parent] @ offsets[joint]
        )
    np.testing.assert_allclose(rebuilt, source_positions, atol=1e-6)


def test_soma77_conversion_fails_closed_without_matching_bvh(tmp_path):
    converter = _load_converter()
    npz_path, *_ = _write_soma77_capture(tmp_path)
    npz_path.with_suffix(".bvh").unlink()

    with pytest.raises(ValueError, match="SOMA77.*BVH"):
        converter.convert(str(npz_path), str(tmp_path / "motion.json"))


def test_soma77_evidence_records_stable_metrics_and_empty_failure_fields(tmp_path):
    converter = _load_converter()
    npz_path, *_ = _write_soma77_capture(tmp_path)
    motion_path = tmp_path / "motion.json"
    evidence_path = tmp_path / "evidence.json"
    converter.convert(str(npz_path), str(motion_path))

    assert converter.write_soma77_evidence(
        str(motion_path),
        str(npz_path),
        str(evidence_path),
    )

    evidence = json.loads(evidence_path.read_text())
    assert evidence["schema"] == "soma77.converter-evidence"
    assert evidence["passed"] is True
    assert evidence["source"]["frame_count"] == 2
    assert evidence["source"]["joint_count"] == 77
    assert evidence["metrics"]["retained_joint_position_error_mm"]["max"] < 1e-6
    assert evidence["metrics"]["retained_joint_angular_error_rad"]["max"] < 1e-6
    assert evidence["failure"] == {
        "frame": None,
        "joint": None,
        "metric": None,
    }
    assert evidence["converter"]["source_signature"].startswith("sha256:")
    assert evidence["source"]["skeleton_signature"].startswith("sha256:")
    assert evidence["retained_contract_signature"].startswith("sha256:")
