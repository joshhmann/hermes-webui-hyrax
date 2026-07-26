#!/usr/bin/env python3
"""Build compressed WebP thumbnails for the Essence frame sprite suite.

The VN sprites in hyrax-assets/essence/frames/ are 1610x3840 PNGs of ~6.5 MB
each — far too heavy for mobile stage loads. For every PNG this writes a
WebP variant to frames/thumbs/<same-basename>.webp:

  - alpha preserved (RGBA/LA/P-with-transparency stay transparent)
  - resized to width 1000 px, aspect kept (never upscaled)
  - quality 82, method 6 (best compression)

Every output is re-opened with PIL and its aspect ratio checked against the
source (±1 px) before it is counted. Idempotent: an up-to-date .webp (mtime
>= source png mtime) is skipped.

--registry / --check-registry: add assets.thumbnailUrl
("/api/hyrax/essence/frames/file/thumbs/<name>.webp") to every registry
frame whose imageUrl PNG has a generated thumb, inserted directly after
imageUrl. Stale thumbnailUrl entries whose thumb no longer exists are
removed. Rendering is byte-stable (indent=2, trailing newline — the same
form scripts/build_frame_registry.py and api.hyrax_essence._atomic_write_json
produce), and the file is replaced atomically.

Usage (Pillow is required — use the isolated calibration venv, never the
system python):

  /tmp/vn-calibrate-venv/bin/python scripts/build_frame_thumbnails.py \
      [--jobs N] [--registry | --check-registry]
"""

import argparse
import json
import os
import sys
from multiprocessing import Pool
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
FRAMES_DIR = REPO_ROOT / "hyrax-assets" / "essence" / "frames"
THUMBS_DIR = FRAMES_DIR / "thumbs"
REGISTRY_PATH = REPO_ROOT / "hyrax-assets" / "essence" / "frames.registry.json"

THUMB_WIDTH = 1000
THUMB_QUALITY = 82
THUMB_METHOD = 6

_FILE_URL_PREFIX = "/api/hyrax/essence/frames/file/"


def _normalized_mode(im):
    """Return the image in a WebP-safe mode, preserving alpha when present."""
    if im.mode in ("RGB", "RGBA"):
        return im
    bands = im.getbands()
    if "A" in bands or "transparency" in im.info or im.mode in ("LA", "PA"):
        return im.convert("RGBA")
    return im.convert("RGB")


def build_one(src_name: str) -> dict:
    """Build (or skip) one thumbnail. Never raises — errors come back in-band."""
    src = FRAMES_DIR / src_name
    THUMBS_DIR.mkdir(exist_ok=True)
    out = THUMBS_DIR / (src.stem + ".webp")
    before = src.stat().st_size
    result = {"name": src_name, "before": before, "after": 0, "status": "error"}
    try:
        if out.exists() and out.stat().st_mtime >= src.stat().st_mtime:
            result["status"] = "skipped"
            result["after"] = out.stat().st_size
            return result

        from PIL import Image

        with Image.open(src) as im:
            im.load()
            im = _normalized_mode(im)
            w, h = im.size
            if w > THUMB_WIDTH:
                new_w = THUMB_WIDTH
                new_h = max(1, round(h * new_w / w))
                im = im.resize((new_w, new_h), Image.LANCZOS)
            else:
                # Never upscale — small sources are only re-encoded.
                new_w, new_h = w, h
            im.save(out, "WEBP", quality=THUMB_QUALITY, method=THUMB_METHOD)

        # Sanity: the output must open in PIL and keep the source aspect
        # ratio (±1 px of rounding on the resized height).
        with Image.open(out) as check:
            check.load()
            cw, ch = check.size
        if cw != new_w or abs(ch - new_h) > 1:
            result["status"] = "error"
            result["detail"] = f"aspect drift: got {cw}x{ch}, want {new_w}x{new_h}"
            try:
                out.unlink()
            except OSError:
                pass
            return result

        result["status"] = "written"
        result["after"] = out.stat().st_size
    except Exception as exc:  # Pillow decode errors, OSError, …
        result["status"] = "error"
        result["detail"] = f"{type(exc).__name__}: {exc}"
    return result


def thumb_name_for(image_url) -> str | None:
    """Map a frames/file imageUrl to its thumb basename (x.png → x.webp)."""
    if not isinstance(image_url, str) or not image_url.startswith(_FILE_URL_PREFIX):
        return None
    base = image_url[len(_FILE_URL_PREFIX):]
    if "/" in base or not base.lower().endswith(".png"):
        return None
    return base[:-4] + ".webp"


def _assets_with_thumbnail(assets: dict, thumb_url: str | None) -> dict:
    """assets copy with thumbnailUrl inserted right after imageUrl (or dropped)."""
    out: dict = {}
    inserted = False
    for key, value in assets.items():
        if key == "thumbnailUrl":
            continue  # re-inserted after imageUrl, or dropped when stale
        out[key] = value
        if key == "imageUrl" and thumb_url is not None:
            out["thumbnailUrl"] = thumb_url
            inserted = True
    if thumb_url is not None and not inserted:
        out["thumbnailUrl"] = thumb_url
    return out


def update_registry() -> tuple[dict, int, int]:
    """Return (registry, added, removed) with thumbnailUrl synced to disk."""
    with open(REGISTRY_PATH) as fh:
        registry = json.load(fh)
    added = removed = 0
    for frame in registry.get("frames", []):
        if not isinstance(frame, dict):
            continue
        assets = frame.get("assets")
        if not isinstance(assets, dict):
            continue
        thumb_name = thumb_name_for(assets.get("imageUrl"))
        thumb_url = None
        if thumb_name is not None and (THUMBS_DIR / thumb_name).is_file():
            thumb_url = f"{_FILE_URL_PREFIX}thumbs/{thumb_name}"
        had = "thumbnailUrl" in assets
        new_assets = _assets_with_thumbnail(assets, thumb_url)
        if thumb_url is not None and assets.get("thumbnailUrl") != thumb_url:
            added += 1
        elif thumb_url is None and had:
            removed += 1
        if new_assets != assets:
            frame["assets"] = new_assets
    return registry, added, removed


def render(registry: dict) -> str:
    return json.dumps(registry, indent=2) + "\n"


def write_registry(registry: dict) -> None:
    tmp = REGISTRY_PATH.with_name(REGISTRY_PATH.name + ".tmp")
    with open(tmp, "w") as fh:
        fh.write(render(registry))
    os.replace(tmp, REGISTRY_PATH)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--jobs", type=int, default=min(4, os.cpu_count() or 1))
    parser.add_argument("--registry", action="store_true",
                        help="sync assets.thumbnailUrl in the frame registry")
    parser.add_argument("--check-registry", action="store_true",
                        help="verify the registry matches a fresh sync (exit 1 if not)")
    args = parser.parse_args()

    if args.registry or args.check_registry:
        registry, added, removed = update_registry()
        if args.check_registry:
            existing = REGISTRY_PATH.read_text() if REGISTRY_PATH.is_file() else ""
            if existing != render(registry):
                print("registry thumbnails stale — rerun with --registry", file=sys.stderr)
                return 1
            print(f"registry thumbnails up to date ({added} referenced, {removed} stale removed)")
            return 0
        write_registry(registry)
        print(f"registry: {added} thumbnailUrl entries set, {removed} stale removed")
        return 0

    sources = sorted(
        p.name for p in FRAMES_DIR.iterdir()
        if p.is_file() and p.suffix.lower() == ".png"
    )
    if not sources:
        print(f"no PNGs found in {FRAMES_DIR}", file=sys.stderr)
        return 1
    THUMBS_DIR.mkdir(exist_ok=True)

    results = []
    with Pool(processes=args.jobs) as pool:
        for i, result in enumerate(pool.imap_unordered(build_one, sources, chunksize=8), 1):
            results.append(result)
            if i % 200 == 0 or i == len(sources):
                print(f"  … {i}/{len(sources)}", flush=True)

    total_before = total_after = 0
    written = skipped = errors = 0
    for r in sorted(results, key=lambda r: r["name"]):
        total_before += r["before"]
        total_after += r["after"]
        if r["status"] == "written":
            written += 1
        elif r["status"] == "skipped":
            skipped += 1
        else:
            errors += 1
        detail = f" [{r['status']}{': ' + r['detail'] if r.get('detail') else ''}]"
        print(f"{r['name']}: {r['before']} -> {r['after']} bytes{detail}")

    gib = 1024 ** 3
    mib = 1024 ** 2
    print("\n── totals ──")
    print(f"files: {len(results)} (written {written}, skipped {skipped}, errors {errors})")
    print(f"before: {total_before} bytes ({total_before / gib:.2f} GiB)")
    print(f"after:  {total_after} bytes ({total_after / mib:.1f} MiB)")
    if total_before:
        print(f"ratio:  {total_after / total_before:.3%}")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
