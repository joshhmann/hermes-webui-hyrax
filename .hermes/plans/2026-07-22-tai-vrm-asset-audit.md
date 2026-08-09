# Tai VRM Asset Route & Provenance Audit — tai.embodiment.vrm

- Task: t_629b36a1 (hx-researcher, run 1188)
- Date: 2026-08-05
- Mode: READ-ONLY. No assets copied, modified, moved, renamed, or re-served. One report file written; nothing else touched.
- Donor (read-only): `/root/workspace/gestalt-control-plane` — Git and filesystem state verified unchanged before/after (see Evidence Log).

---

## 1. Control-plane resolver / control flow (how the asset is served today)

Serving chain for `GET /api/v1/assets/tai.embodiment.vrm` on the live control-plane gateway (uvicorn `division_gateway.app:app`, PID 3335194, `127.0.0.1:8770`, started 2026-08-01):

1. Route registration — `division_gateway/app.py:355-359`
   `@app.get("/api/v1/assets/{asset_id}")` → `resolve(settings.asset_root, settings.chibi_root, settings.embodiment_root, asset_id)`; on hit returns `FileResponse(path)`; on miss `HTTPException(404)`.
2. Allowlist lookup — `division_gateway/assets.py:57` (`ASSETS` tuple):
   `Asset("tai.embodiment.vrm", "tai", "model", "tai_vroid.vrm", "neutral", "Tai VRM embodiment model", "embodiment")`
   — hardcoded allowlist (`assets.py:18-19`: "Deliberate allowlist. Generated/unreviewed assets are never discovered dynamically"). No dynamic discovery.
3. Root selection — `assets.py:61-66` (`_root_for`): `root == "embodiment"` → `embodiment_root` (others: `chibi_root`; default `asset_root`).
4. Default root — `division_gateway/config.py:40`: `embodiment_root = env DIVISION_EMBODIMENT_ROOT or ROOT/assets/embodiment` where `ROOT = Path(__file__).resolve().parents[1]` (`config.py:9`).
   Live process env (PID 3335194) sets NO `DIVISION_EMBODIMENT_ROOT` (verified via /proc environ name list) → **resolved root = `/root/workspace/gestalt-control-plane/assets/embodiment`**.
5. Path resolution + jail — `assets.py:77-85` (`resolve`): resolves `(selected_root / "tai_vroid.vrm")`, then requires `selected_root.resolve() in path.parents` and `path.is_file()`, else returns None → 404. Symlink escape is structurally impossible.
6. Auth dependency — `app.py:356` `Depends(get_principal)`; `division_gateway/security.py:53-61`: requires valid `division_session` cookie (any authenticated actor); 401 otherwise (observed live: anonymous GET → `401`, body 36 bytes; HEAD → 405, GET-only).
7. Response headers — `app.py:302-311` middleware: `/api/v1/assets/*` exempted from `no-store`, served with `Cache-Control: public, max-age=86400` + security headers (CSP `default-src 'self'`, nosniff, DENY framing, no-referrer).

Frontend consumer (same origin, no absolute URL, no cross-origin request):
- `frontend/src/embodiment/TaiRoomScene.ts:127` — `const model = await loadModel('/api/v1/assets/tai.embodiment.vrm')` (hardcoded same-origin path).
- `frontend/src/embodiment/loaders/loadModel.ts:11-23` — `GLTFLoader` + `VRMLoaderPlugin`, `loader.loadAsync(url)`; VRM path applies `rotateVRM0`, `removeUnnecessaryVertices`, `combineSkeletons`.

## 2. Resolved local asset — donor (control plane)

| Property | Value |
|---|---|
| Resolved path | `/root/workspace/gestalt-control-plane/assets/embodiment/tai_vroid.vrm` |
| File type | regular file (NOT a symlink) |
| Byte size | 16,500,300 (15.7 MiB) |
| SHA-256 | `c94075ebc079fd5f010277f213d4ec4a299df46c9c44290562bb2189e4a16b46` |
| Ownership / mode | root:root, `-rw-r--r--` (0644) — world-readable |
| mtime | 2026-07-18 09:41:45 -0700 |
| WebUI service user readability | WebUI runs as root (PID 3523659 on 0.0.0.0:8787) → readable. Also world-readable (0644) for any service user. |
| Git tracking | tracked (branch `agent/standardize-work-packet`), clean (no local diff) |
| Git LFS | LFS-tracked via `.gitattributes`: `*.vrm filter=lfs diff=lfs merge=lfs -text`; LFS OID `c94075ebc0…` matches on-disk SHA-256 → local LFS object present at `.git/lfs/objects/c9/40/c94075ebc0…` (16,500,300 bytes) |
| First commit | `223f08d` "Initialize Hyrax Division Control Plane" |

## 3. Provenance / license metadata

### 3a. Embedded VRM metadata (extracted read-only from the GLB JSON chunk, no bytes embedded here)
- `asset.generator`: `UniGLTF-2.64.1` (UniVRM exporter; VRM 0.x) — VRoid Studio pipeline export, meshes "Face/Body/Hair001 (merged).baked", 28 embedded textures, 0 animations, standard VRoid `Fcl_*` blendshape set.
- `meta.title`: `Aasuka Vexx - Casual Outfit 2`
- `meta.version`: `v1.1b`
- `meta.author`: `NorthrnPoakr` (third-party VRoid Hub model — NOT an original in-house model)
- `meta.allowedUserName`: `Everyone`
- `meta.licenseName`: `Other`
- `meta.otherPermissionUrl`: `https://hub.vroid.com/license?allowed_to_use_user=everyone&characterization_allowed_user=everyone&corporate_commercial_use=allow&credit=necessary&modification=allow&personal_commercial_use=profit&redistribution=allow&sexual_expression=allow&version=1&violent_expression=allow`
  → Per the license URL parameters: use by anyone, characterization allowed, corporate & personal commercial use allowed, **credit necessary**, modification allowed, redistribution allowed, sexual/violent expression allowed.

### 3b. Local docs/manifests
- Control plane: NO asset-specific license/provenance document exists (grep for `vroid|tai_vroid|licenseName|provenance` across docs/manifests only surfaces generic governance prose in `dashboard-spec.md` / `implementation-plan.md:61`). Donor-side provenance doc: **absent**.
- WebUI fork: `hyrax-assets/PROVENANCE.md` (tracked) records source repo, source path, size and SHA-256 for `tai.embodiment.vrm` (all match §2/§4), and states "License/provenance metadata: not documented in the donor/source roots; do not invent it." That statement predates extraction of the embedded VRM meta in §3a; the embedded license is now available evidence and should be appended to PROVENANCE.md by the follow-up card.

### 3c. Approval gate (provenance)
- PASS condition for the later card: (1) record in `hyrax-assets/PROVENANCE.md` the embedded license: title/author (`Aasuka Vexx - Casual Outfit 2` by `NorthrnPoakr`), `licenseName=Other`, `otherPermissionUrl` (exact URL in §3a), generator/version; (2) satisfy the license's `credit=necessary` clause (attribution visible in the 3D UI or asset credits); (3) Josh sign-off that the VRoid Hub "Other" license terms (commercial + redistribution allowed with credit) are acceptable for the Hyraxknot fork. Until (1)-(3) are done, the copy must be treated as **provisionally licensed, not approved**.

## 4. Copy / route status inside the WebUI fork (already present — verified, NOT re-copied)

The "later safe copy/route card" has already been partially executed (2026-07-22, same day as this task's creation); this audit verifies it:

- Copy: `/root/hermes-webui-hyrax/hyrax-assets/embodiment/tai.embodiment.vrm`
  - regular file, root:root 0644, 16,500,300 bytes, mtime 2026-07-22 20:49 -0700
  - SHA-256 `c94075ebc079fd5f010277f213d4ec4a299df46c9c44290562bb2189e4a16b46` — **byte-identical to donor** (verified this run)
  - Git: **untracked + gitignored by design** — `.gitignore:90` `hyrax-assets/embodiment/*.vrm`; `.gitattributes` documents "Git LFS is intentionally NOT used in this repository" (GitHub refuses LFS batch uploads to public forks). Text metadata (PROVENANCE.md, manifests) remains tracked. This is intentional, not an oversight.
- Route: `GET /api/hyrax/assets/tai.embodiment.vrm`
  - Dispatch: `api/routes.py:11994-11997` (`/api/hyrax/*` → `handle_hyrax_get`) → `api/hyrax_routes.py:206-208` → `_handle_asset_request` (`hyrax_routes.py:443-464`, traversal/encoded-traversal rejection) → `_serve_asset` (`hyrax_routes.py:284-369`): allowlist lookup (`ASSET_ALLOWLIST`, `hyrax_routes.py:171-174` — `"tai.embodiment.vrm": "embodiment/tai.embodiment.vrm"`), symlink rejection on every path component, `O_NOFOLLOW` open, fstat identity check, `Content-Type: model/gltf-binary`, `Cache-Control: private, max-age=3600`, nosniff.
  - Auth: WebUI session required — observed live: anonymous `GET http://127.0.0.1:8787/api/hyrax/assets/tai.embodiment.vrm` → **401** (35-byte JSON). `api/auth.py:1063-1064` exempts only `/static/` and `/session/static/` from auth; `/api/hyrax/*` is not exempt. The 3D page (behind login) carries the session cookie.
- Frontend target URL (same-origin): `hyrax-3d/src/index.ts:14` `vrmUrl: '/api/hyrax/assets/tai.embodiment.vrm'`; built bundle `static/hyrax/3d/embodiment-bundle.js:30280` same. Also loaded via `/api/hyrax/3d/calibrate/calibration-profiles/tai-embodiment-v3.json` (ARDY motion profile, `hyrax-3d/src/embodiment/motion/ArdyMotionSource.ts:145`).
- Tests covering the contract: `tests/test_hyrax_vn_assets.py` — `test_vrm_works_when_2d_unavailable` (658), `test_vrm_works_when_manifest_missing` (681), `test_vrm_still_serves_with_vrm_content_type` (717), `test_vrm_and_2d_both_servable` (743), `test_profile_asset_urls_are_same_origin` (777, asserts `assets["model"] == "/api/hyrax/assets/tai.embodiment.vrm"` at 813), `test_profile_no_filesystem_paths` (792).

### Target recommendation (no copy performed by this audit)
- Target path: `hyrax-assets/embodiment/tai.embodiment.vrm` — **already populated and byte-verified**; nothing further to copy.
- Same-origin URL: `/api/hyrax/assets/tai.embodiment.vrm`.
- Remaining work for the later card (not this audit): (a) append embedded license evidence (§3a) to `hyrax-assets/PROVENANCE.md`; (b) run `./scripts/test.sh tests/test_hyrax_vn_assets.py` on the fork to re-prove the route contract; (c) confirm the 3D page renders from the fork bundle with a logged-in session; (d) Josh approval per §3c.
- Unregistered neighbors (note only, out of scope, NOT in allowlist, NOT served): five additional VRMs in `hyrax-assets/embodiment/` with numeric names (`2305468851983365971.vrm` 17,916,300 B; `410503235925796358.vrm` 17,203,320 B; `4730589876044551329.vrm` 16,907,148 B; `8125460580261213799.vrm` 18,603,796 B; `9042366629077953442.vrm` 16,761,152 B; all mtime 2026-07-24, gitignored). They are absent from `ASSET_ALLOWLIST` and from PROVENANCE.md; their origin is unrecorded — treat as unregistered dev artifacts.

## 5. Other assets actually required by the local embodiment module (no inventions)

Control-plane embodiment module (`frontend/src/embodiment/`, 14 files, 3,380 lines):
- **Runtime network asset: exactly one** — the VRM via `/api/v1/assets/tai.embodiment.vrm` (TaiRoomScene.ts:127 → loadModel.ts:15).
- **Build-time bundled data**: `frontend/src/embodiment/room/roomObjects.json` (6,393 B, imported at TaiRoomScene.ts:34; Vite-bundled, not a runtime HTTP fetch).
- **npm dependencies**: `three`, `@pixiv/three-vrm` (loadModel.ts:1-3).
- **No textures** (all materials are procedural color/emissive hexes in TaiRoomScene), **no animation clips** (procedural locomotion + VRM blendshapes; GLB has 0 animations), **no audio** (VisemeController drives VRM expression manager only; no audio files/clips anywhere in the module).
Fork side (`hyrax-3d/src/`) adds ARDY motion data: WebSocket `/api/hyrax/ardy/ws` + JSON calibration profiles (`/api/hyrax/3d/calibrate/calibration-profiles/tai-embodiment-v3.json`) — config/data, not binary model assets.

## 6. No runtime request to CT 112 — confirmed

- Control plane: full-repo grep for `ct112|CT112|CT 112|ct-112` → only `research.md:90,100` (historical rollout notes: "Synthesis Loft (Tai) — active on CT 112:8000"). Zero operational references in `division_gateway/` or `frontend/`; the asset endpoint is served locally from disk (FileResponse), and the frontend URL is same-origin.
- WebUI fork: grep of `hyrax-3d/src/` and `static/hyrax/3d/` for `ct112|CT112|:8000|192.168.` → zero hits.
- The only external URL in config is `hq_url = http://192.168.0.187:8766` (`config.py:46`) — the Rei/HQ server, unrelated to CT 112 and not on the asset path.

## 7. Copy / route contract — pass/fail criteria (evidence-backed)

| # | Criterion | Verification | Result today |
|---|---|---|---|
| C1 | Copy byte-identical to donor | `sha256sum` both files equal `c94075ebc0…`; sizes equal 16,500,300 | PASS |
| C2 | Donor untouched by the operation | sha256 + stat + `git status` identical before/after run | PASS |
| C3 | Route serves only allowlisted names, no traversal | `_serve_asset` allowlist + `O_NOFOLLOW` + fstat identity + `_handle_asset_request` rejection of `/ \ .. %2e %2f %5c`; tests 658/681/717/743 | PASS (code+test evidence) |
| C4 | Auth required | live anonymous GET → 401 on 8787; auth.py exemptions exclude /api/hyrax | PASS |
| C5 | Correct media type | `.vrm → model/gltf-binary` (hyrax_routes.py:341-342, 381); test 717 | PASS |
| C6 | Same-origin URL wired in frontend | index.ts:14 + bundle:30280 `/api/hyrax/assets/tai.embodiment.vrm` | PASS |
| C7 | No CT 112 runtime reference | greps in §6 | PASS |
| C8 | Provenance documented | PROVENANCE.md has source/hash; **embedded license (§3a) not yet recorded; attribution credit not yet shown in UI** | FAIL (open) — gate §3c |
| C9 | Fork test suite green for asset routes | `test_hyrax_vn_assets.py` not re-run this audit (read-only run; no pytest execution performed) | UNVERIFIED — run in follow-up card |

Open items for the follow-up card: C8 (license record + credit) and C9 (test run), then Josh approval; control plane remains the fallback until then.

## 8. Evidence log (all read-only)

- Read: `division_gateway/assets.py` (85 lines), `config.py` (87), `app.py:280-400`, `security.py` (70), `TaiRoomScene.ts` (445), `loadModel.ts` (38), `research.md:80-100`, `hyrax_routes.py:160-470`, `hyrax-assets/PROVENANCE.md` (41), `.gitattributes`, `.gitignore:85-97`, `tests/test_hyrax_vn_assets.py` (grep context).
- Commands (no writes to any source tree): `sha256sum`, `stat`, `git status/log/ls-files/lfs ls-files/check-ignore/cat-file`, `git lfs ls-files`, `/proc/<pid>/environ` (names only, values redacted), `ss -tlnp`, `curl` HEAD/GET status probes against live gateways (8770 + 8787), GLB JSON-chunk meta extraction via python (read-only, meta fields only).
- Source state unchanged: donor sha256 `c94075ebc0…`, stat `16500300 root:root 0644, mtime 2026-07-18 09:41:45`, branch `agent/standardize-work-packet`, `git status` identical to session-start snapshot (pre-existing: M `division_gateway/app.py`, M `frontend/src/main.ts`, 5 untracked docs) — no new changes introduced by this run.
- No credentials, tokens, hashes of secrets, or file contents disclosed. VRM bytes not embedded.
