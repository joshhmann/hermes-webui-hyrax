#!/usr/bin/env python3
"""Build hyrax-assets/essence/frames.registry.json from the VN asset manifest.

Imports the 29 existing manifest assets (hyrax-assets/vn/ASSET_MANIFEST.json)
as Essence Frames with source "authored" and quality.approved=true, computing
sceneSignatures per ESSENCE_RUNTIME_SPEC §4 (coarse fields only, via
api.hyrax_essence.compute_scene_signature — the single owner).

Deterministic and re-runnable: same manifest → byte-identical registry
(frames sorted by id, fixed key order, no timestamps).

Usage: python3 scripts/build_frame_registry.py [--check]
  --check   verify the on-disk registry matches a fresh build (exit 1 if not)
"""

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from api.hyrax_essence import compute_scene_signature  # noqa: E402

MANIFEST_PATH = REPO_ROOT / "hyrax-assets" / "vn" / "ASSET_MANIFEST.json"
REGISTRY_PATH = REPO_ROOT / "hyrax-assets" / "essence" / "frames.registry.json"

_MANIFEST_KINDS = ("portrait", "background", "chibi")


def frame_from_manifest_asset(asset: dict) -> dict | None:
    """Map one manifest asset to an EssenceFrame. None → skip invalid entry."""
    logical_id = asset.get("id", "")
    profile = asset.get("profile_id")
    kind = asset.get("kind")
    rel_path = asset.get("relative_path", "")
    sha256 = asset.get("sha256", "")
    size = asset.get("size")
    if (
        not isinstance(logical_id, str)
        or profile not in ("tai", "rei", "nei", "mai")
        or kind not in _MANIFEST_KINDS
        or not isinstance(rel_path, str)
        or not isinstance(sha256, str)
        or not isinstance(size, int)
    ):
        return None
    parts = logical_id.split(".")
    if len(parts) != 3 or parts[0] != profile or parts[1] != kind:
        return None
    segment = parts[2]

    # Coarse state from the logical id (deterministic):
    #   portrait   → expression + medium framing
    #   background → location + wide framing
    #   chibi      → pose + wide framing
    if kind == "portrait":
        state = {"expression": segment, "camera": "medium"}
    elif kind == "background":
        state = {"location": segment, "camera": "wide"}
    else:
        state = {"pose": segment, "camera": "wide"}

    return {
        "id": f"frame.{logical_id}",
        "operatorId": profile,
        "version": "1",
        "source": "authored",
        "sceneSignature": compute_scene_signature(profile, state),
        "state": state,
        "assets": {
            # Servable today through the manifest allowlist machinery.
            "imageUrl": f"/api/hyrax/assets/{logical_id}",
            "sha256": sha256,
            "size": size,
        },
        "quality": {"approved": True, "issues": []},
        "continuity": {},
    }


def build_registry() -> dict:
    with open(MANIFEST_PATH, "r") as fh:
        manifest = json.load(fh)
    frames = []
    for asset in manifest.get("assets", []):
        frame = frame_from_manifest_asset(asset)
        if frame is not None:
            frames.append(frame)
    frames.sort(key=lambda f: f["id"])
    return {
        "version": 1,
        "policy": "fixed-sfw-allowlist",
        "generated_by": "scripts/build_frame_registry.py",
        "frames": frames,
    }


def render(registry: dict) -> str:
    return json.dumps(registry, indent=2) + "\n"


def main() -> int:
    registry = build_registry()
    text = render(registry)
    if "--check" in sys.argv[1:]:
        existing = REGISTRY_PATH.read_text() if REGISTRY_PATH.is_file() else ""
        if existing != text:
            print("registry is stale — rerun scripts/build_frame_registry.py", file=sys.stderr)
            return 1
        print(f"registry up to date ({len(registry['frames'])} frames)")
        return 0
    REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
    REGISTRY_PATH.write_text(text)
    print(f"wrote {REGISTRY_PATH} ({len(registry['frames'])} frames)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
