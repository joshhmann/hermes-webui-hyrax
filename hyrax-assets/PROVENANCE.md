# Hyrax Asset Provenance

This directory contains assets owned and served by the Hyraxknot Division
route handler (`api/hyrax_routes.py`). Assets are stored outside the
public `/static` tree and served only via the authenticated allowlist
endpoint `/api/hyrax/assets/<logical_name>`.

## Registered Assets

| Logical key | Source repo | Source path | Size (bytes) | SHA-256 |
|---|---|---|---|---|
| `tai.embodiment.vrm` | `gestalt-control-plane` (read-only donor) | `assets/embodiment/tai_vroid.vrm` | 16,500,300 | `c94075ebc079fd5f010277f213d4ec4a299df46c9c44290562bb2189e4a16b46` |

### SFW VN/HQ image package

The fixed serving manifest is `vn/ASSET_MANIFEST.json`. It contains 29 logical
keys backed by 26 unique PNG files (71,277,910 bytes). The byte-for-byte source
inventory, destination paths, sizes, and SHA-256 values are frozen in
`vn/SOURCE_SNAPSHOT.json`.

Source roots:

- `/root/workspace/Profile_Photos` — profile portraits and room backgrounds.
- `/root/.hermes/profiles/rei/audio_cache/chibis/sprites` — standing chibi sprites.

The imported set was visually checked on 2026-07-22 for corruption and SFW
suitability. It contains the four room backgrounds, reviewed work/emotion
portraits, and four standing chibis. Explicit/generated material and assets that
require the future consent/bond presentation gate were deliberately excluded;
in particular no generation-dump paths, `tongue-out-sexual`, or `ahegao` asset
is present in the manifest or destination tree.

Some portraits are transparent full-body PNGs while others are intentionally
opaque square crops. Consumers must use stable containment/anchoring and must
not assume every portrait has alpha.

- **Date acquired**: 2026-07-22
- **Git LFS**: The target `.gitattributes` tracks the VRM and only the reviewed
  `hyrax-assets/vn/**/*.png` subtree through LFS.
- **License/provenance metadata**: not documented in the donor/source roots; do
  not invent it. Source locations and content hashes are retained for audit.
