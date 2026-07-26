#!/usr/bin/env python3
"""Calibrate per-frame sprite display data for the Gestalt VN stage.

The Essence sprites (hyrax-assets/essence/frames/*.png) are tall full-body
PNGs on a transparent canvas; each operator's figure occupies a DIFFERENT
region and scale of the canvas, so one CSS framing rule crops them
inconsistently (some too zoomed, some off-center). This script measures the
content bounding box from the alpha channel and derives per-frame display
parameters so every sprite reads "head + upper body, top of head intact" in
the desktop stage column (a centered 4/5 aspect box — see hyrax.css
.gestalt-vn-stage-frame-wrap @media min-width:721px).

Display model (applied by static/hyrax/vn/vnStage.js, desktop only):
  - the frame <img> keeps object-fit:cover inside the 4/5 wrap; cover is
    width-limited for these tall sprites, so the base visible source window
    is V0 = sourceW / 0.8 px tall, anchored by object-position.
  - assets.display.scale (>= 1) widens the <img> to zoom in on a small
    figure; assets.display.focusX (0-1, content center) horizontally centers
    the figure via the element's `left`; assets.display.objectPositionY
    (0-1) anchors the window so the head top sits ~3% below the stage top.
  - target visible window: top BODY_FRACTION of the content bbox (head
    through roughly waist), clamped so scale stays within [1, MAX_SCALE].

Writes into hyrax-assets/essence/frames.registry.json, per matching frame:
  assets.crop       {x, y, w, h}   content bbox, source pixels
  assets.sourceSize {w, h}         canvas size, source pixels
  assets.display    {scale, focusX, objectPositionY}
Frames without a matching PNG (portraits/backgrounds/chibis from the VN
manifest) are untouched — the stage falls back to the CSS defaults for them.
Re-runnable when new sprites land; output is deterministic (sorted frames,
fixed key order, same JSON rendering as scripts/build_frame_registry.py, so
`build_frame_registry.py --check` keeps passing afterwards).

Requires Pillow — install it into an ISOLATED venv only, never the repo
.venv or system python, e.g.:
  python3 -m venv /tmp/vn-calibrate-venv
  /tmp/vn-calibrate-venv/bin/pip install Pillow
  /tmp/vn-calibrate-venv/bin/python scripts/calibrate_frame_crops.py

Usage: calibrate_frame_crops.py [--check]
  --check   verify the on-disk registry matches a fresh pass (exit 1 if not)
"""

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
FRAMES_DIR = REPO_ROOT / "hyrax-assets" / "essence" / "frames"
REGISTRY_PATH = REPO_ROOT / "hyrax-assets" / "essence" / "frames.registry.json"

FILE_URL_PREFIX = "/api/hyrax/essence/frames/file/"

# Desktop stage column aspect (hyrax.css: aspect-ratio 4 / 5).
STAGE_ASPECT = 4 / 5
# Fraction of the figure (from the head top) the stage window should show:
# head + upper body, legs cut — the VN half-cut norm.
BODY_FRACTION = 0.58
# Headroom: head top sits this fraction of the window below the stage top.
TOP_MARGIN = 0.03
# Zoom bounds: never zoom out (scale < 1 would letterbox the wrap), never
# zoom so far in that the face fills the whole stage.
MIN_SCALE = 1.0
MAX_SCALE = 1.8
# Alpha threshold for "content" — ignores faint compression noise in the
# transparent margin.
ALPHA_THRESHOLD = 8


def content_bbox(path: Path) -> tuple[int, int, int, int] | None:
    """Alpha-channel content bbox of one sprite. None → fully transparent."""
    from PIL import Image

    with Image.open(path) as img:
        if img.mode != "RGBA":
            img = img.convert("RGBA")
        alpha = img.getchannel("A")
        mask = alpha.point(lambda a: 255 if a > ALPHA_THRESHOLD else 0)
        box = mask.getbbox()
        if box is None:
            return None
        left, top, right, bottom = box
        return left, top, right - left, bottom - top


def display_for(crop: tuple[int, int, int, int],
                canvas: tuple[int, int]) -> dict:
    """Derive ready-to-apply display params from a content bbox."""
    x, y, w, h = crop
    sw, sh = canvas
    # Base visible source height when cover is width-limited in the 4/5 wrap.
    v0 = sw / STAGE_ASPECT
    # Zoom so the window covers BODY_FRACTION of the figure.
    scale = v0 / (h * BODY_FRACTION)
    scale = min(max(scale, MIN_SCALE), MAX_SCALE)
    visible = v0 / scale
    # Anchor: head top at TOP_MARGIN of the window, clamped to the canvas.
    top = y - TOP_MARGIN * visible
    top = min(max(top, 0.0), max(sh - visible, 0.0))
    denom = sh - visible
    object_position_y = (top / denom) if denom > 0 else 0.0
    return {
        "scale": round(scale, 4),
        "focusX": round((x + w / 2) / sw, 4),
        "objectPositionY": round(object_position_y, 4),
    }


def calibrate() -> dict:
    """Return {filename: {"crop":..., "sourceSize":..., "display":...}}."""
    out = {}
    for png in sorted(FRAMES_DIR.glob("*.png")):
        from PIL import Image

        box = content_bbox(png)
        if box is None:
            continue
        with Image.open(png) as img:
            sw, sh = img.size
        x, y, w, h = box
        out[png.name] = {
            "crop": {"x": x, "y": y, "w": w, "h": h},
            "sourceSize": {"w": sw, "h": sh},
            "display": display_for(box, (sw, sh)),
        }
    return out


def apply_to_registry(registry: dict, data: dict) -> tuple[dict, int]:
    """Attach calibration to frames whose imageUrl points at a sprite file.

    Returns (registry, matched_count). Unmatched sprite files are reported
    by main(); frames without sprite files keep no calibration (fail closed
    to the CSS defaults).
    """
    matched = 0
    for frame in registry.get("frames", []):
        if not isinstance(frame, dict):
            continue
        assets = frame.get("assets")
        if not isinstance(assets, dict):
            continue
        url = assets.get("imageUrl", "")
        if not isinstance(url, str) or not url.startswith(FILE_URL_PREFIX):
            continue
        name = url[len(FILE_URL_PREFIX):]
        entry = data.get(name)
        if entry is None:
            continue
        assets["crop"] = entry["crop"]
        assets["sourceSize"] = entry["sourceSize"]
        assets["display"] = entry["display"]
        matched += 1
    return registry, matched


def render(registry: dict) -> str:
    # Same rendering as scripts/build_frame_registry.py so its --check and
    # the registry tests stay byte-stable.
    return json.dumps(registry, indent=2) + "\n"


def main() -> int:
    try:
        import PIL  # noqa: F401
    except ImportError:
        print(
            "Pillow is required. Install it into an isolated venv only:\n"
            "  python3 -m venv /tmp/vn-calibrate-venv\n"
            "  /tmp/vn-calibrate-venv/bin/pip install Pillow\n"
            "  /tmp/vn-calibrate-venv/bin/python scripts/calibrate_frame_crops.py",
            file=sys.stderr,
        )
        return 2

    data = calibrate()
    registry = json.loads(REGISTRY_PATH.read_text())
    registry, matched = apply_to_registry(registry, data)
    text = render(registry)

    print(f"{'file':<28} {'crop (x,y,w,h)':<26} {'scale':>6} "
          f"{'focusX':>7} {'objPosY':>8}")
    for name in sorted(data):
        e = data[name]
        c = e["crop"]
        d = e["display"]
        box = "({},{},{},{})".format(c["x"], c["y"], c["w"], c["h"])
        print(f"{name:<28} {box:<26} "
              f"{d['scale']:>6} {d['focusX']:>7} {d['objectPositionY']:>8}")
    unmatched = sorted(set(data) - {
        f["assets"]["imageUrl"][len(FILE_URL_PREFIX):]
        for f in registry.get("frames", [])
        if isinstance(f, dict) and isinstance(f.get("assets"), dict)
        and str(f["assets"].get("imageUrl", "")).startswith(FILE_URL_PREFIX)
    })
    for name in unmatched:
        print(f"WARNING: {name} has no registry frame — skipped", file=sys.stderr)

    if "--check" in sys.argv[1:]:
        existing = REGISTRY_PATH.read_text() if REGISTRY_PATH.is_file() else ""
        if existing != text:
            print("registry calibration stale — rerun "
                  "scripts/calibrate_frame_crops.py", file=sys.stderr)
            return 1
        print(f"calibration up to date ({matched} frames calibrated)")
        return 0
    REGISTRY_PATH.write_text(text)
    print(f"wrote {REGISTRY_PATH} ({matched} frames calibrated)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
