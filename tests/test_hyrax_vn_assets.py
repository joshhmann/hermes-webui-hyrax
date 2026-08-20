"""Tests for Hyrax VN 2D asset serving (/api/hyrax/assets/{logical_id}).

TDD driver: tests must fail before implementation (RED phase).
These tests validate that the VN 2D asset manifest is loaded, validated,
and served through the existing /api/hyrax/assets/<name> route with correct
security, content type, headers, and fail-closed behavior.

==============================================================================
RED phase — all 2D asset tests should fail until VN manifest is loaded into
ASSET_ALLOWLIST and _serve_asset detects PNG content type.
==============================================================================
"""

from __future__ import annotations

import io
import json
import os
import re
import stat
from pathlib import Path
from types import SimpleNamespace

import pytest

import api.auth as auth

# ── Repo root ──────────────────────────────────────────────────────────────
REPO_ROOT = Path(__file__).resolve().parents[1]
HYRAX_ASSETS = REPO_ROOT / "hyrax-assets"
VN_MANIFEST_PATH = HYRAX_ASSETS / "vn" / "ASSET_MANIFEST.json"

# ── Logical IDs from the reviewed manifest ────────────────────────────────
# Extracted from the 29-entry SFW manifest at hyrax-assets/vn/ASSET_MANIFEST.json
EXPECTED_LOGICAL_IDS = frozenset({
    # Tai (5 logical IDs, 5 files)
    "tai.portrait.neutral",
    "tai.portrait.focused",
    "tai.portrait.smile",
    "tai.portrait.sarcastic",
    "tai.portrait.happy-emote",
    "tai.background.control-room",
    "tai.chibi.stand",
    # Rei (3 logical IDs, 3 files)
    "rei.portrait.neutral",
    "rei.portrait.alert",
    "rei.portrait.calm",
    "rei.background.security",
    "rei.chibi.stand",
    # Nei (3 logical IDs, 3 files)
    "nei.portrait.neutral",
    "nei.portrait.observant",
    "nei.portrait.thinking",
    "nei.background.lab",
    "nei.chibi.stand",
    # Mai (12 logical IDs, 9 files)
    "mai.portrait.neutral",
    "mai.portrait.smile",
    "mai.portrait.laughing",
    "mai.portrait.light-smile",
    "mai.portrait.observant",
    "mai.portrait.composed",
    "mai.portrait.ohhoai",
    "mai.portrait.shy-smile",
    "mai.portrait.scream-of-fury",
    "mai.portrait.yandere-smile",
    "mai.background.supply-hub",
    "mai.chibi.stand",
    # Aya (7 logical IDs, 7 files)
    "aya.portrait.neutral",
    "aya.portrait.calm",
    "aya.portrait.joy",
    "aya.portrait.thinking",
    "aya.portrait.focus",
    "aya.background.ops-room",
    "aya.chibi.stand",
})


# ── Mock HTTP handler ──────────────────────────────────────────────────────
class _Handler:
    """Minimal mock HTTP request handler that captures status/headers/body."""

    def __init__(self, *, headers=None, path="/"):
        self.headers = dict(headers or {})
        self.command = "GET"
        self.path = path
        self.wfile = io.BytesIO()
        self.status = None
        self.sent_headers: list[tuple[str, str]] = []
        self._pending_set_cookies = None

    def send_response(self, status):
        self.status = status

    def send_header(self, name, value):
        self.sent_headers.append((name, value))

    def end_headers(self):
        pass

    def body_bytes(self):
        return self.wfile.getvalue()

    def body_text(self):
        return self.body_bytes().decode("utf-8")

    def json_body(self):
        return json.loads(self.body_text())

    def header_values(self, name):
        return [v for k, v in self.sent_headers if k == name]

    def header(self, name):
        vals = self.header_values(name)
        return vals[0] if vals else None


# ── Fixtures ───────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def isolate_auth(monkeypatch):
    """Disable all auth by default so tests can focus on route behavior."""
    monkeypatch.setattr(auth, "STATE_DIR", REPO_ROOT / "tests" / "__tmp_auth_vn_assets")
    monkeypatch.setattr(auth, "_SESSIONS_FILE", REPO_ROOT / "tests" / "__tmp_auth_vn_assets" / ".sessions.json")
    monkeypatch.setattr(auth, "is_password_auth_enabled", lambda: False)
    monkeypatch.setattr(auth, "are_passkeys_enabled", lambda: False)
    monkeypatch.setattr(auth, "is_oidc_auth_enabled", lambda: False)
    monkeypatch.setattr(auth, "is_trusted_auth_enabled", lambda: False)
    auth._sessions.clear()
    auth._TRUSTED_AUTH_WARNINGS_EMITTED.clear()
    yield
    auth._sessions.clear()
    auth._TRUSTED_AUTH_WARNINGS_EMITTED.clear()


@pytest.fixture
def tmp_vn_assets(tmp_path):
    """Create a temporary directory with a minimal valid VN manifest and files."""
    vn_dir = tmp_path / "vn"
    vn_dir.mkdir(parents=True)

    # Create subdirectories
    (vn_dir / "backgrounds").mkdir()
    (vn_dir / "chibis").mkdir()
    (vn_dir / "portraits").mkdir()

    # Create minimal PNG files
    tai_bg = vn_dir / "backgrounds" / "tai-control-room.png"
    tai_bg.write_bytes(b"FAKE_PNG_TAI_BG_" + b"X" * 100)

    tai_chibi = vn_dir / "chibis" / "tai-stand.png"
    tai_chibi.write_bytes(b"FAKE_PNG_TAI_CHIBI_" + b"Y" * 50)

    tai_portrait = vn_dir / "portraits" / "tai-neutral.png"
    tai_portrait.write_bytes(b"FAKE_PNG_TAI_PORTRAIT_" + b"Z" * 80)

    # Create a valid minimal manifest
    manifest = {
        "version": 1,
        "policy": "fixed-sfw-allowlist",
        "assets": [
            {
                "id": "tai.portrait.neutral",
                "profile_id": "tai",
                "kind": "portrait",
                "state": "neutral",
                "alt": "Tai, attentive",
                "relative_path": "portraits/tai-neutral.png",
                "size": tai_portrait.stat().st_size,
                "sha256": "50b989ba5a042a7d980cdbbcf2d2a85a15480e39699edfa990a45263754eedfe",
                "sensitivity": "safe",
            },
            {
                "id": "tai.background.control-room",
                "profile_id": "tai",
                "kind": "background",
                "state": "neutral",
                "alt": "Tai's Gestalt control room",
                "relative_path": "backgrounds/tai-control-room.png",
                "size": tai_bg.stat().st_size,
                "sha256": "2f7cf030f1e7069a15994c85ba365c876218bf72b240cd219b2fb4b520764df2",
                "sensitivity": "safe",
            },
            {
                "id": "tai.chibi.stand",
                "profile_id": "tai",
                "kind": "chibi",
                "state": "neutral",
                "alt": "Tai chibi",
                "relative_path": "chibis/tai-stand.png",
                "size": tai_chibi.stat().st_size,
                "sha256": "dd3ad4e83f39588697be6d30783d946356ea6f4f08548541585bd813f3cec5b5",
                "sensitivity": "safe",
            },
        ],
    }
    (vn_dir / "ASSET_MANIFEST.json").write_text(json.dumps(manifest))
    return tmp_path


# ── Helper: call handle_hyrax_get with a path string ───────────────────────

def _call_hyrax_get(handler, path: str):
    """Call hyrax.handle_hyrax_get with a URL path string."""
    parsed = SimpleNamespace(path=path, query="")
    import api.hyrax_routes as hyrax
    return hyrax.handle_hyrax_get(handler, parsed)


# ══════════════════════════════════════════════════════════════════════════
# RED phase — all VN 2D tests should fail until manifest loading implemented
# ══════════════════════════════════════════════════════════════════════════

class TestVn2DManifestLoading:
    """Tests for manifest-based 2D allowlist construction."""

    def test_manifest_loads_expected_ids(self):
        """MANIFEST: All 36 logical IDs must be present after loading."""
        import api.hyrax_routes as hyrax
        from api.hyrax_routes import ASSET_ALLOWLIST

        # All expected logical IDs must be in the allowlist
        for lid in EXPECTED_LOGICAL_IDS:
            assert lid in ASSET_ALLOWLIST, f"Missing 2D asset: {lid}"

    def test_manifest_entry_has_vn_png_path(self):
        """MANIFEST: Each 2D entry must point under vn/ and end with .png."""
        import api.hyrax_routes as hyrax
        from api.hyrax_routes import ASSET_ALLOWLIST

        vrm_entry = "embodiment/tai.embodiment.vrm"
        for logical_id, rel_path in ASSET_ALLOWLIST.items():
            if rel_path == vrm_entry:
                continue  # skip VRM
            assert rel_path.startswith("vn/"), f"Non-VN path for {logical_id}: {rel_path}"
            assert rel_path.endswith(".png"), f"Non-PNG path for {logical_id}: {rel_path}"

    def test_manifest_count_36_logical_ids(self):
        """MANIFEST: Exactly 36 VN logical IDs are loaded (not counting VRM)."""
        import api.hyrax_routes as hyrax
        from api.hyrax_routes import ASSET_ALLOWLIST

        vn_ids = {k: v for k, v in ASSET_ALLOWLIST.items()
                  if v.endswith(".png") and v.startswith("vn/")}
        assert len(vn_ids) == 36, f"Expected 36 VN 2D IDs, got {len(vn_ids)}"


class TestVn2DAssetServing:
    """Tests for streaming 2D assets through /api/hyrax/assets/<id>."""

    def test_serve_known_2d_asset_png(self, monkeypatch, tmp_vn_assets):
        """2D: Known PNG asset returns 200 with correct bytes and PNG content type."""
        import api.hyrax_routes as hyrax
        monkeypatch.setattr(hyrax, "ASSET_BASE", tmp_vn_assets)

        handler = _Handler()
        handled = _call_hyrax_get(handler, "/api/hyrax/assets/tai.portrait.neutral")

        assert handled is True
        assert handler.status == 200
        # Verify correct bytes
        expected_path = tmp_vn_assets / "vn" / "portraits" / "tai-neutral.png"
        expected_bytes = expected_path.read_bytes()
        assert handler.body_bytes() == expected_bytes
        # Content-Type: image/png
        assert handler.header("Content-Type") == "image/png"

    def test_content_type_is_image_png(self, monkeypatch, tmp_vn_assets):
        """2D: Content-Type must be image/png for all PNG entries."""
        import api.hyrax_routes as hyrax
        monkeypatch.setattr(hyrax, "ASSET_BASE", tmp_vn_assets)

        handler = _Handler()
        handled = _call_hyrax_get(handler, "/api/hyrax/assets/tai.background.control-room")
        assert handled is True
        assert handler.status == 200
        assert handler.header("Content-Type") == "image/png"

    def test_content_length_header(self, monkeypatch, tmp_vn_assets):
        """2D: Content-Length must match served file size."""
        import api.hyrax_routes as hyrax
        monkeypatch.setattr(hyrax, "ASSET_BASE", tmp_vn_assets)

        expected_path = tmp_vn_assets / "vn" / "chibis" / "tai-stand.png"
        expected_size = expected_path.stat().st_size

        handler = _Handler()
        handled = _call_hyrax_get(handler, "/api/hyrax/assets/tai.chibi.stand")
        assert handled is True
        assert handler.status == 200
        cl = handler.header("Content-Length")
        assert cl is not None, "Content-Length header must be present"
        assert int(cl) == expected_size
        assert len(handler.body_bytes()) == expected_size

    def test_x_content_type_options(self, monkeypatch, tmp_vn_assets):
        """2D: X-Content-Type-Options: nosniff must be set."""
        import api.hyrax_routes as hyrax
        monkeypatch.setattr(hyrax, "ASSET_BASE", tmp_vn_assets)

        handler = _Handler()
        handled = _call_hyrax_get(handler, "/api/hyrax/assets/tai.chibi.stand")
        assert handled is True
        assert handler.status == 200
        assert handler.header("X-Content-Type-Options") == "nosniff"

    def test_content_disposition_inline(self, monkeypatch, tmp_vn_assets):
        """2D: Content-Disposition must be inline."""
        import api.hyrax_routes as hyrax
        monkeypatch.setattr(hyrax, "ASSET_BASE", tmp_vn_assets)

        handler = _Handler()
        handled = _call_hyrax_get(handler, "/api/hyrax/assets/tai.chibi.stand")
        assert handled is True
        assert handler.status == 200
        cds = " ".join(handler.header_values("Content-Disposition"))
        assert "inline" in cds

    def test_cache_headers_present(self, monkeypatch, tmp_vn_assets):
        """2D: Cache-Control with bounded max-age must be set."""
        import api.hyrax_routes as hyrax
        monkeypatch.setattr(hyrax, "ASSET_BASE", tmp_vn_assets)

        handler = _Handler()
        handled = _call_hyrax_get(handler, "/api/hyrax/assets/tai.portrait.neutral")
        assert handled is True
        cc = handler.header("Cache-Control") or ""
        assert "max-age=" in cc
        # Extract max-age value — must be positive and bounded
        import re
        m = re.search(r"max-age=(\d+)", cc)
        assert m is not None, "Cache-Control missing max-age"
        max_age = int(m.group(1))
        assert max_age > 0, "max-age must be positive"
        assert max_age <= 86400 * 7, "max-age must be bounded (<= 7 days)"

    def test_chunked_streaming(self, monkeypatch, tmp_path_factory):
        """2D: Asset is emitted as bounded CHUNK_SIZE writes."""
        import api.hyrax_routes as hyrax
        chunk_size = hyrax.CHUNK_SIZE

        tmp_dir = Path(tmp_path_factory.mktemp("chunked_vn"))
        vn_dir = tmp_dir / "vn"
        vn_dir.mkdir()
        (vn_dir / "portraits").mkdir()

        large_body = b"PNG" + b"X" * (chunk_size * 2 + 7)
        large_file = vn_dir / "portraits" / "tai-large.png"
        large_file.write_bytes(large_body)

        manifest = {
            "version": 1,
            "policy": "fixed-sfw-allowlist",
            "assets": [{
                "id": "tai.portrait.large",
                "profile_id": "tai",
                "kind": "portrait",
                "state": "neutral",
                "alt": "Large test",
                "relative_path": "portraits/tai-large.png",
                "size": large_file.stat().st_size,
                "sha256": "00" * 32,
                "sensitivity": "safe",
            }],
        }
        (vn_dir / "ASSET_MANIFEST.json").write_text(json.dumps(manifest))

        # Load manifest and build allowlist
        monkeypatch.setattr(hyrax, "ASSET_BASE", tmp_dir)
        vn_entries = hyrax._load_vn_2d_manifest()
        monkeypatch.setattr(
            hyrax, "ASSET_ALLOWLIST",
            {"tai.embodiment.vrm": "embodiment/tai.embodiment.vrm", **vn_entries},
        )

        class CountingWriter(io.BytesIO):
            def __init__(self):
                super().__init__()
                self.write_sizes = []

            def write(self, data):
                self.write_sizes.append(len(data))
                return super().write(data)

        handler = _Handler()
        handler.wfile = CountingWriter()
        handled = _call_hyrax_get(handler, "/api/hyrax/assets/tai.portrait.large")
        assert handled is True
        assert handler.body_bytes() == large_body
        # Expect chunk_size, chunk_size, remainder
        remaining = len(large_body) - chunk_size * 2
        assert handler.wfile.write_sizes == [chunk_size, chunk_size, remaining]

    def test_all_three_profiles_sampled(self, monkeypatch, tmp_vn_assets):
        """2D: Sample at least one asset from each sister profile — all serve correctly."""
        import api.hyrax_routes as hyrax
        monkeypatch.setattr(hyrax, "ASSET_BASE", tmp_vn_assets)
        # Load 2D entries from the tmp manifest and build combined allowlist
        vn_entries = hyrax._load_vn_2d_manifest()
        monkeypatch.setattr(
            hyrax, "ASSET_ALLOWLIST",
            {"tai.embodiment.vrm": "embodiment/tai.embodiment.vrm", **vn_entries},
        )

        for lid in ("tai.portrait.neutral", "tai.background.control-room", "tai.chibi.stand"):
            parsed_path = f"/api/hyrax/assets/{lid}"
            handler = _Handler()
            handled = _call_hyrax_get(handler, parsed_path)
            assert handled is True
            assert handler.status == 200
            assert handler.header("Content-Type") == "image/png"


class TestVn2DSecurity:
    """Security tests — unknown, traversal, and leak rejection."""

    def test_unknown_logical_id_404(self, monkeypatch):
        """SEC: Unknown logical ID returns sanitized 404."""
        handler = _Handler()
        handled = _call_hyrax_get(handler, "/api/hyrax/assets/unknown.portrait.evil")
        assert handled is True
        assert handler.status == 404

    def test_explicit_key_rejected_404(self, monkeypatch):
        """SEC: Explicit/sensitive key not in manifest returns 404."""
        handler = _Handler()
        handled = _call_hyrax_get(handler, "/api/hyrax/assets/mai.portrait.explicit")
        assert handled is True
        assert handler.status == 404

    def test_path_traversal_rejected(self, monkeypatch):
        """SEC: Path traversal via .. in asset name returns 404."""
        for bad_path in [
            "/api/hyrax/assets/../etc/passwd",
            "/api/hyrax/assets/..%2F..%2Fetc%2Fpasswd",
            "/api/hyrax/assets/%2e%2e/%2e%2e/etc/passwd",
            "/api/hyrax/assets/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
        ]:
            handler = _Handler()
            handled = _call_hyrax_get(handler, bad_path)
            assert handled is True, f"Expected handled for {bad_path}"
            assert handler.status == 404, f"Expected 404 for {bad_path}"

    def test_encoded_separators_rejected(self, monkeypatch):
        """SEC: Encoded path separators in asset name return 404."""
        for bad_path in [
            "/api/hyrax/assets/tai%2fportrait%2fneutral",
            "/api/hyrax/assets/tai%5cportrait",
            "/api/hyrax/assets/tai.portrait.neutral%00",
        ]:
            handler = _Handler()
            handled = _call_hyrax_get(handler, bad_path)
            assert handled is True
            assert handler.status == 404

    def test_slash_in_asset_name_rejected(self, monkeypatch):
        """SEC: Literal slash in asset name returns 404."""
        handler = _Handler()
        handled = _call_hyrax_get(handler, "/api/hyrax/assets/tai/portrait/neutral")
        assert handled is True
        assert handler.status == 404

    def test_404_no_path_leak(self, monkeypatch):
        """SEC: 404 response must not leak filesystem paths."""
        handler = _Handler()
        handled = _call_hyrax_get(handler, "/api/hyrax/assets/unknown.asset")
        assert handled is True
        assert handler.status == 404
        body_text = handler.body_text().lower()
        for leak in ["/", "hyrax-assets", "vn", "assets"]:
            assert leak not in body_text, f"Response leaked path token: {leak}"

    def test_no_listing_endpoint(self, monkeypatch):
        """SEC: Bare /api/hyrax/assets or /api/hyrax/assets/ must not list files."""
        for bare_path in ["/api/hyrax/assets", "/api/hyrax/assets/"]:
            handler = _Handler()
            handled = _call_hyrax_get(handler, bare_path)
            assert handled is True
            assert handler.status == 404
            body = handler.json_body()
            assert "error" in body

    def test_source_filenames_rejected(self, monkeypatch):
        """SEC: SOURCE_SNAPSHOT and donor paths must not be servable."""
        handler = _Handler()
        handled = _call_hyrax_get(handler, "/api/hyrax/assets/SOURCE_SNAPSHOT.json")
        assert handled is True
        assert handler.status == 404

    def test_extension_guessing_rejected(self, monkeypatch):
        """SEC: Adding .png to unknown ID must not bypass allowlist."""
        handler = _Handler()
        handled = _call_hyrax_get(handler, "/api/hyrax/assets/nonexistent.png")
        assert handled is True
        assert handler.status == 404


class TestVn2DSymlinkRace:
    """Symlink and replacement-race rejection for 2D assets."""

    def test_symlink_rejected(self, monkeypatch, tmp_vn_assets):
        """RACE: Symlink at the target path must be rejected with 404."""
        import api.hyrax_routes as hyrax
        monkeypatch.setattr(hyrax, "ASSET_BASE", tmp_vn_assets)

        # Replace the portrait with a symlink to /etc/hostname
        target = tmp_vn_assets / "vn" / "portraits" / "tai-neutral.png"
        target.unlink()
        target.symlink_to("/etc/hostname")

        handler = _Handler()
        handled = _call_hyrax_get(handler, "/api/hyrax/assets/tai.portrait.neutral")
        assert handled is True
        assert handler.status == 404, "Symlink must be rejected"

    def test_symlink_in_path_component_rejected(self, monkeypatch, tmp_vn_assets):
        """RACE: Symlink in a directory component must be rejected."""
        import api.hyrax_routes as hyrax
        monkeypatch.setattr(hyrax, "ASSET_BASE", tmp_vn_assets)

        # Replace a directory with a symlink
        portraits_dir = tmp_vn_assets / "vn" / "portraits"
        portraits_dir.rename(tmp_vn_assets / "vn" / "portraits_real")
        portraits_dir.symlink_to(tmp_vn_assets / "vn" / "portraits_real")

        handler = _Handler()
        handled = _call_hyrax_get(handler, "/api/hyrax/assets/tai.portrait.neutral")
        assert handled is True
        assert handler.status == 404, "Symlinked directory must be rejected"

    def test_missing_file_returns_404(self, monkeypatch, tmp_vn_assets):
        """RACE: Manifest entry whose file is missing returns 404."""
        import api.hyrax_routes as hyrax
        monkeypatch.setattr(hyrax, "ASSET_BASE", tmp_vn_assets)

        # Remove the file but keep manifest pointing at it
        target = tmp_vn_assets / "vn" / "portraits" / "tai-neutral.png"
        target.unlink()

        handler = _Handler()
        handled = _call_hyrax_get(handler, "/api/hyrax/assets/tai.portrait.neutral")
        assert handled is True
        assert handler.status == 404
        body_text = handler.body_text().lower()
        for leak in ["/", str(tmp_vn_assets).lower()]:
            assert leak not in body_text, f"Response leaked path: {leak}"


class TestVn2DFailClosed:
    """Fail-closed behavior when manifest is missing or malformed.

    These tests exercise the _load_vn_2d_manifest() function directly
    (white-box unit tests) and test route behavior via monkeypatched
    ASSET_ALLOWLIST.
    """

    def test_load_manifest_returns_empty_when_no_vn_dir(self, monkeypatch, tmp_path):
        """_load_vn_2d_manifest: No vn/ directory → empty dict."""
        import api.hyrax_routes as hyrax

        # ASSET_BASE pointing at tmp_path with no vn/ subdir
        monkeypatch.setattr(hyrax, "ASSET_BASE", tmp_path)
        result = hyrax._load_vn_2d_manifest()
        assert result == {}, "Expected empty dict when no vn/ directory"

    def test_load_manifest_returns_empty_when_no_manifest_file(self, monkeypatch, tmp_path):
        """_load_vn_2d_manifest: No manifest file in vn/ → empty dict."""
        import api.hyrax_routes as hyrax

        vn_dir = tmp_path / "vn"
        vn_dir.mkdir()
        monkeypatch.setattr(hyrax, "ASSET_BASE", tmp_path)
        result = hyrax._load_vn_2d_manifest()
        assert result == {}, "Expected empty dict when no manifest file"

    def test_load_manifest_returns_empty_when_malformed_json(self, monkeypatch, tmp_path):
        """_load_vn_2d_manifest: Malformed JSON → empty dict."""
        import api.hyrax_routes as hyrax

        vn_dir = tmp_path / "vn"
        vn_dir.mkdir()
        (vn_dir / "ASSET_MANIFEST.json").write_text("{not valid json")
        monkeypatch.setattr(hyrax, "ASSET_BASE", tmp_path)
        result = hyrax._load_vn_2d_manifest()
        assert result == {}

    def test_load_manifest_returns_empty_when_wrong_version(self, monkeypatch, tmp_path):
        """_load_vn_2d_manifest: Wrong version → empty dict."""
        import json
        import api.hyrax_routes as hyrax

        vn_dir = tmp_path / "vn"
        vn_dir.mkdir()
        (vn_dir / "ASSET_MANIFEST.json").write_text(json.dumps({
            "version": 999,
            "policy": "fixed-sfw-allowlist",
            "assets": [],
        }))
        monkeypatch.setattr(hyrax, "ASSET_BASE", tmp_path)
        result = hyrax._load_vn_2d_manifest()
        assert result == {}

    def test_load_manifest_returns_empty_when_wrong_policy(self, monkeypatch, tmp_path):
        """_load_vn_2d_manifest: Wrong policy → empty dict."""
        import json
        import api.hyrax_routes as hyrax

        vn_dir = tmp_path / "vn"
        vn_dir.mkdir()
        (vn_dir / "ASSET_MANIFEST.json").write_text(json.dumps({
            "version": 1,
            "policy": "nsfw-allowlist",
            "assets": [],
        }))
        monkeypatch.setattr(hyrax, "ASSET_BASE", tmp_path)
        result = hyrax._load_vn_2d_manifest()
        assert result == {}

    def test_load_manifest_returns_empty_when_not_list(self, monkeypatch, tmp_path):
        """_load_vn_2d_manifest: assets not a list → empty dict."""
        import json
        import api.hyrax_routes as hyrax

        vn_dir = tmp_path / "vn"
        vn_dir.mkdir()
        (vn_dir / "ASSET_MANIFEST.json").write_text(json.dumps({
            "version": 1,
            "policy": "fixed-sfw-allowlist",
            "assets": "not a list",
        }))
        monkeypatch.setattr(hyrax, "ASSET_BASE", tmp_path)
        result = hyrax._load_vn_2d_manifest()
        assert result == {}

    def test_load_manifest_rejects_non_safe_entry(self, monkeypatch, tmp_path):
        """_load_vn_2d_manifest: Non-safe entry is skipped."""
        import json
        import api.hyrax_routes as hyrax

        vn_dir = tmp_path / "vn"
        vn_dir.mkdir()
        (vn_dir / "portraits").mkdir()
        png = vn_dir / "portraits" / "tai-neutral.png"
        png.write_bytes(b"PNG")
        manifest = {
            "version": 1,
            "policy": "fixed-sfw-allowlist",
            "assets": [{
                "id": "tai.portrait.neutral",
                "profile_id": "tai",
                "kind": "portrait",
                "state": "neutral",
                "alt": "test",
                "relative_path": "portraits/tai-neutral.png",
                "size": png.stat().st_size,
                "sha256": "a" * 64,
                "sensitivity": "explicit",
            }],
        }
        (vn_dir / "ASSET_MANIFEST.json").write_text(json.dumps(manifest))
        monkeypatch.setattr(hyrax, "ASSET_BASE", tmp_path)
        result = hyrax._load_vn_2d_manifest()
        assert result == {}, "Non-safe entry must be rejected"

    def test_vrm_works_when_2d_unavailable(self, monkeypatch, tmp_path):
        """FAIL-CLOSED: When 2D entries absent from ASSET_ALLOWLIST, VRM still serves."""
        import api.hyrax_routes as hyrax

        # Create ASSET_BASE with VRM file
        emb_dir = tmp_path / "embodiment"
        emb_dir.mkdir(parents=True)
        vrm_body = b"FAKE_VRM_FOR_VRM_TEST"
        (emb_dir / "tai.embodiment.vrm").write_bytes(vrm_body)

        # Set ASSET_BASE and VRM-only ASSET_ALLOWLIST
        monkeypatch.setattr(hyrax, "ASSET_BASE", tmp_path)
        monkeypatch.setattr(
            hyrax, "ASSET_ALLOWLIST",
            {"tai.embodiment.vrm": "embodiment/tai.embodiment.vrm"},
        )

        handler = _Handler()
        handled = _call_hyrax_get(handler, "/api/hyrax/assets/tai.embodiment.vrm")
        assert handled is True
        assert handler.status == 200
        assert handler.body_bytes() == vrm_body

    def test_vrm_works_when_manifest_missing(self, monkeypatch, tmp_path):
        """FAIL-CLOSED: After _load_vn_2d_manifest returns empty, VRM still serves.

        Simulates: ASSET_BASE with no vn/ directory → empty _VN_2D_ALLOWLIST
        → VRM entry remains in ASSET_ALLOWLIST.
        """
        import api.hyrax_routes as hyrax

        # Create ASSET_BASE with only VRM (no vn/)
        emb_dir = tmp_path / "embodiment"
        emb_dir.mkdir(parents=True)
        vrm_body = b"FAKE_VRM_FOR_TEST"
        (emb_dir / "tai.embodiment.vrm").write_bytes(vrm_body)

        # Override ASSET_ALLOWLIST to VRM-only
        monkeypatch.setattr(
            hyrax, "ASSET_ALLOWLIST",
            {"tai.embodiment.vrm": "embodiment/tai.embodiment.vrm"},
        )
        monkeypatch.setattr(hyrax, "ASSET_BASE", tmp_path)

        handler = _Handler()
        handled = _call_hyrax_get(handler, "/api/hyrax/assets/tai.embodiment.vrm")
        assert handled is True
        assert handler.status == 200
        assert handler.body_bytes() == vrm_body

        # 2D asset must 404
        handler2 = _Handler()
        handled2 = _call_hyrax_get(handler2, "/api/hyrax/assets/tai.portrait.neutral")
        assert handled2 is True
        assert handler2.status == 404

class TestVn2DVrmRegression:
    """VRM must continue to work correctly alongside 2D assets."""

    def test_vrm_still_serves_with_vrm_content_type(self, monkeypatch, tmp_vn_assets):
        """REGRESSION: VRM asset still serves model/gltf-binary when 2D enabled."""
        import api.hyrax_routes as hyrax

        # Add a VRM file to tmp_vn_assets
        emb_dir = tmp_vn_assets / "embodiment"
        emb_dir.mkdir(exist_ok=True)
        vrm_body = b"FAKE_VRM_BODY_v1.0"
        (emb_dir / "tai.embodiment.vrm").write_bytes(vrm_body)

        # Build a combined ASSET_ALLOWLIST: VRM + 2D entries from the tmp manifest
        vrm_entry = {"tai.embodiment.vrm": "embodiment/tai.embodiment.vrm"}
        monkeypatch.setattr(hyrax, "ASSET_BASE", tmp_vn_assets)
        # Load 2D from the tmp manifest
        result = hyrax._load_vn_2d_manifest()
        combined = dict(vrm_entry)
        combined.update(result)
        monkeypatch.setattr(hyrax, "ASSET_ALLOWLIST", combined)

        handler = _Handler()
        handled = _call_hyrax_get(handler, "/api/hyrax/assets/tai.embodiment.vrm")
        assert handled is True
        assert handler.status == 200
        assert handler.body_bytes() == vrm_body
        assert handler.header("Content-Type") == "model/gltf-binary"

    def test_vrm_and_2d_both_servable(self, monkeypatch, tmp_vn_assets):
        """REGRESSION: Both VRM and 2D PNG assets are servable simultaneously."""
        import api.hyrax_routes as hyrax

        # Add a VRM file
        emb_dir = tmp_vn_assets / "embodiment"
        emb_dir.mkdir(exist_ok=True)
        vrm_body = b"FAKE_VRM_BODY_v1.0"
        (emb_dir / "tai.embodiment.vrm").write_bytes(vrm_body)

        # Build combined allowlist
        vrm_entry = {"tai.embodiment.vrm": "embodiment/tai.embodiment.vrm"}
        monkeypatch.setattr(hyrax, "ASSET_BASE", tmp_vn_assets)
        result = hyrax._load_vn_2d_manifest()
        combined = dict(vrm_entry)
        combined.update(result)
        monkeypatch.setattr(hyrax, "ASSET_ALLOWLIST", combined)

        # VRM
        h1 = _Handler()
        _call_hyrax_get(h1, "/api/hyrax/assets/tai.embodiment.vrm")
        assert h1.status == 200
        assert h1.header("Content-Type") == "model/gltf-binary"

        # 2D PNG
        h2 = _Handler()
        _call_hyrax_get(h2, "/api/hyrax/assets/tai.portrait.neutral")
        assert h2.status == 200
        assert h2.header("Content-Type") == "image/png"


class TestVn2DProfileURLs:
    """Profile endpoint must reference only reviewed same-origin URLs."""

    def test_profile_asset_urls_are_same_origin(self):
        """PROFILES: All sister asset URLs must start with /api/hyrax/assets/."""
        import api.hyrax_routes as hyrax

        profiles = hyrax._vn_serve_profiles(_Handler())
        handler = _Handler()
        hyrax._vn_serve_profiles(handler)
        body = handler.json_body()
        for item in body["items"]:
            assert "assets" in item
            for asset_key, url in item["assets"].items():
                assert isinstance(url, str), f"{item['id']}/{asset_key} not a string"
                assert url.startswith("/api/hyrax/assets/"), \
                    f"{item['id']}/{asset_key} URL not same-origin: {url}"

    def test_profile_no_filesystem_paths(self):
        """PROFILES: Profile endpoint must not expose filesystem paths or hashes."""
        import api.hyrax_routes as hyrax

        handler = _Handler()
        hyrax._vn_serve_profiles(handler)
        body_text = handler.body_text().lower()
        for leak in ["hyrax-assets", ".png", "sha256", "sha-256", "filesystem", "relative_path"]:
            assert leak not in body_text, f"Profile response leaked: {leak}"

    def test_profile_tai_has_vrm_url(self):
        """PROFILES: Tai must include model URL as existing logical URL."""
        import api.hyrax_routes as hyrax

        handler = _Handler()
        hyrax._vn_serve_profiles(handler)
        body = handler.json_body()
        items = {item["id"]: item for item in body["items"]}
        assert "tai" in items
        assets = items["tai"]["assets"]
        assert "model" in assets
        assert assets["model"] == "/api/hyrax/assets/tai.embodiment.vrm"

    def test_profile_neutral_asset_ids_are_valid(self):
        """PROFILES: All neutral portrait/background/chibi IDs must be valid logical IDs."""
        import api.hyrax_routes as hyrax
        from api.hyrax_routes import ASSET_ALLOWLIST

        handler = _Handler()
        hyrax._vn_serve_profiles(handler)
        body = handler.json_body()

        for item in body["items"]:
            for asset_key, url in item["assets"].items():
                if asset_key == "model":
                    continue  # VRM, checked separately
                # Extract the logical ID from the URL
                assert url.startswith("/api/hyrax/assets/")
                logical_id = url[len("/api/hyrax/assets/"):]
                assert logical_id in ASSET_ALLOWLIST, \
                    f"Profile {item['id']} references missing asset: {logical_id}"
