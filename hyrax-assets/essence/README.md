# Essence Frames — Sprite Setup

How to add new operator imagery (sprites / portraits / backgrounds) to the
Gestalt VN layer. Everything here is SFW-only by policy.

## Layout

```
hyrax-assets/essence/
  frames.registry.json     # the frame registry (validated, sha256-pinned)
  frames/                  # drop directory for new images (png/jpg/webp, ≤8 MB)
hyrax-assets/vn/           # authored manifest assets (29 originals, LFS)
  Sprites/<Operator>/<Pose>/sprite_pose_*.png   # source trees (provenance)
```

## Adding images (drop-in flow)

1. **Drop the file(s)** into `hyrax-assets/essence/frames/`.
   Use unique, prefixed names — e.g. `nei-sprite_pose_0001.png`
   (operator files collide if you copy folders verbatim).

2. **Register each image** so the registry knows about it:

```bash
curl -X POST http://hyrax:8787/api/hyrax/essence/frames/register \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "frame.nei.sprite.neutral.0001",
    "operatorId": "nei",
    "state": {"expression": "neutral", "pose": "standing", "camera": "close"},
    "image": "nei-sprite_pose_0001.png"
  }'
```

Field rules:

| Field | Notes |
|---|---|
| `id` | `frame.<dotted.lowercase>` unique; duplicate → 409 |
| `operatorId` | `tai` \| `rei` \| `nei` \| `mai` |
| `state.expression` | canonical per-sister enum (unknown → neutral + issues) |
| `state.pose` | `standing` / `sitting` / `working` / `gesturing` (family-mapped) |
| `state.camera` | `close` (cover, head+shoulders) / `medium` (cover, 28% anchor) / `wide` (contain) |
| `state.location` | optional room id (`lab`, `ops`, `security`, `logistics`) |
| `state.wardrobe` | optional — only set when it changes (continuity field) |
| `image` | bare filename inside `frames/` (validated, sha256'd) |

3. Done — the frame is immediately:
   - servable at `GET /api/hyrax/essence/frames/file/<filename>`,
   - selectable by the scene-signature ranking in the VN stage.

## How selection works (so your registration lands as intended)

- Stage asks for a frame by **scene signature**: operator · location · wardrobe ·
  expression-family · pose-family · timeOfDayBand (when set) · framing · ≤3 props.
- Expression families are curated in `expression-families.json` (v2):
  `neutral` / `positive` / `wry` / `focused` / `intense` / `sad`. Unknown
  expression names fall back to `neutral`, so register sprites with a name
  the table (or the canonical enum) actually knows.
- Ranking: exact > same-location > expression-family > operator-default >
  generic portrait. Non-exact needs ≥0.6 confidence.
- Ties break by continuity scoring (prior link > wardrobe > **pose match** >
  location). Giving your sprite the right `pose` is what makes it win.
- Only `kind: portrait` frames can occupy the operator frame layer;
  `background`/`chibi` kinds are for other layers.

## Making a set the default

Approval is the selector: only `quality.approved: true` frames compete.
To replace a default (e.g. the original neutral portraits were superseded by
the sprite set on 2026-07-24), demote the old frame by editing
`frames.registry.json`:

```json
"quality": {"approved": false, "issues": ["superseded by <new set> <date>"]}
```

Do not delete old frames — demotion keeps them referenceable and reversible.

## Registry maintenance

- `python3 scripts/build_frame_registry.py` rebuilds the 29 manifest-derived
  frames from `hyrax-assets/vn/ASSET_MANIFEST.json` and **merges** (never
  clobbers) registered drops. `--check` verifies freshness.
- Signatures are computed identically on server and client (FNV-1a); if you
  hand-edit a frame's `state`, recompute its `sceneSignature` with
  `api.hyrax_essence.compute_scene_signature` or re-register.

## LFS caveat (2026-07-24)

`*.vrm` and `hyrax-assets/vn/**/*.png` are Git LFS–tracked. Public forks can't
accept new LFS objects, so pushes use `GIT_LFS_SKIP_PUSH=1` — the local repo
is the source of truth for those binaries. Files under
`hyrax-assets/essence/` are plain git objects and push normally.
