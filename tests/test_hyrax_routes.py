"""Tests for Hyraxknot Division route extensions (api/hyrax_routes.py).

TDD driver: tests must fail before implementation (RED phase).
Covers the GET /api/hyrax/assets/<logical_name> asset handler with
authenticated hard-allowlist routing.

RED phase (t_52209fc9): tests proving explicit dispatch is absent
for /api/hyrax/projects, /api/hyrax/stats, /api/hyrax/agents via
the canonical api.routes.handle_get path.
"""

from __future__ import annotations

import io
import json
import os
import stat
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlparse

import pytest

import api.auth as auth
import api.hyrax_routes as hyrax

# ── Repo root ──────────────────────────────────────────────────────────────
REPO_ROOT = Path(__file__).resolve().parents[1]
HYRAX_ASSETS = REPO_ROOT / "hyrax-assets"


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


# ── Fixtures ───────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def isolate_auth(monkeypatch):
    """Disable all auth by default so tests can focus on route behavior."""
    monkeypatch.setattr(auth, "STATE_DIR", REPO_ROOT / "tests" / "__tmp_auth")
    monkeypatch.setattr(auth, "_SESSIONS_FILE", REPO_ROOT / "tests" / "__tmp_auth" / ".sessions.json")
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
def tmp_assets(tmp_path):
    """Create a temporary directory mimicking hyrax-assets with a small test file."""
    dest = tmp_path / "embodiment"
    dest.mkdir(parents=True)
    test_body = b"fake VRM body content for testing"
    asset_path = dest / "tai.embodiment.vrm"
    asset_path.write_bytes(test_body)
    return tmp_path, test_body, asset_path


# ── Helper: call handle_hyrax_get with a path string ───────────────────────

def _call_hyrax_get(handler, path: str):
    """Call hyrax.handle_hyrax_get with a URL path string."""
    parsed = SimpleNamespace(path=path, query="")
    return hyrax.handle_hyrax_get(handler, parsed)


# ══════════════════════════════════════════════════════════════════════════
# RED phase — all tests should fail until handler is implemented
# ══════════════════════════════════════════════════════════════════════════

class TestAssetAllowlist:
    """Tests for the authenticated asset allowlist route."""

    # ── Success ────────────────────────────────────────────────────────

    def test_serve_known_asset(self, monkeypatch, tmp_assets):
        """Known allowlisted asset returns 200 with correct bytes and headers."""
        tmp_root, test_body, asset_path = tmp_assets
        # Patch hyrax's ASSET_BASE to point at our temp directory
        monkeypatch.setattr(hyrax, "ASSET_BASE", tmp_root)

        handler = _Handler()
        handled = _call_hyrax_get(handler, "/api/hyrax/assets/tai.embodiment.vrm")

        assert handled is True
        assert handler.status == 200
        assert handler.body_bytes() == test_body
        # Content-Type header
        assert "model/gltf-binary" in handler.header_values("Content-Type")
        # Content-Length
        assert str(len(test_body)) in handler.header_values("Content-Length")
        # Content-Disposition: inline
        assert "inline" in " ".join(handler.header_values("Content-Disposition"))
        # Cache-Control: private, max-age=3600
        ccs = " ".join(handler.header_values("Cache-Control"))
        assert "private" in ccs
        assert "max-age=3600" in ccs
        # X-Content-Type-Options: nosniff
        assert "nosniff" in handler.header_values("X-Content-Type-Options")

    def test_serve_asset_returns_true(self, monkeypatch, tmp_assets):
        """Handler returns True to signal it handled the route."""
        tmp_root, test_body, asset_path = tmp_assets
        monkeypatch.setattr(hyrax, "ASSET_BASE", tmp_root)

        handler = _Handler()
        handled = _call_hyrax_get(handler, "/api/hyrax/assets/tai.embodiment.vrm")
        assert handled is True

    def test_serve_asset_chunked_write(self, monkeypatch, tmp_assets):
        """The allowlisted asset is emitted as bounded CHUNK_SIZE writes."""
        tmp_root, _test_body, asset_path = tmp_assets
        monkeypatch.setattr(hyrax, "ASSET_BASE", tmp_root)
        large_body = b"X" * (hyrax.CHUNK_SIZE * 2 + 7)
        asset_path.write_bytes(large_body)

        class CountingWriter(io.BytesIO):
            def __init__(self):
                super().__init__()
                self.write_sizes = []

            def write(self, data):
                self.write_sizes.append(len(data))
                return super().write(data)

        handler = _Handler()
        handler.wfile = CountingWriter()
        handled = _call_hyrax_get(handler, "/api/hyrax/assets/tai.embodiment.vrm")

        assert handled is True
        assert handler.body_bytes() == large_body
        assert handler.wfile.write_sizes == [hyrax.CHUNK_SIZE, hyrax.CHUNK_SIZE, 7]
        assert str(len(large_body)) in handler.header_values("Content-Length")

    # ── Allowlist miss ─────────────────────────────────────────────────

    def test_unknown_asset_returns_404(self, monkeypatch):
        """Unknown logical name returns sanitized JSON 404."""
        handler = _Handler()
        handled = _call_hyrax_get(handler, "/api/hyrax/assets/unknown.vrm")

        assert handled is True
        assert handler.status == 404
        body = handler.json_body()
        assert "error" in body

    def test_unknown_404_no_path_leak(self, monkeypatch):
        """404 response must not leak filesystem paths."""
        handler = _Handler()
        handled = _call_hyrax_get(handler, "/api/hyrax/assets/unknown.vrm")
        assert handled is True
        assert handler.status == 404
        body_text = handler.body_text().lower()
        # No filesystem paths in the response
        for leak in ["/", "\\", "hyrax-assets", "assets", "embodiment"]:
            assert leak not in body_text, f"Response leaked path token: {leak}"

    # ── Path traversal rejection ───────────────────────────────────────

    @pytest.mark.parametrize("malicious_path", [
        "/api/hyrax/assets/../etc/passwd",
        "/api/hyrax/assets/..%2F..%2Fetc%2Fpasswd",
        "/api/hyrax/assets/%2e%2e/%2e%2e/etc/passwd",
        "/api/hyrax/assets/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
        "/api/hyrax/assets/tai.embodiment.vrm/../../../etc/passwd",
        "/api/hyrax/assets/%2e%2e/tai.embodiment.vrm",
    ])
    def test_path_traversal_rejected(self, monkeypatch, malicious_path):
        """Path traversal attempts return 404, not the file outside the scope."""
        handler = _Handler()
        handled = _call_hyrax_get(handler, malicious_path)
        assert handled is True
        assert handler.status == 404

    def test_backslash_rejected(self, monkeypatch):
        """Backslash in asset name returns 404."""
        handler = _Handler()
        handled = _call_hyrax_get(handler, "/api/hyrax/assets/..\\..\\etc\\passwd")
        assert handled is True
        assert handler.status == 404

    @pytest.mark.parametrize("weird_path", [
        "/api/hyrax/assets/",
        "/api/hyrax/assets",
        "/api/hyrax/assets/",
    ])
    def test_missing_asset_name_returns_404(self, monkeypatch, weird_path):
        """Missing or empty asset name returns 404."""
        handler = _Handler()
        handled = _call_hyrax_get(handler, weird_path)
        assert handled is True
        assert handler.status == 404

    # ── Missing allowlisted file ───────────────────────────────────────

    def test_missing_allowlisted_file_404(self, monkeypatch, tmp_assets):
        """Allowlisted logical name whose target file doesn't exist returns 404.

        No filesystem path should leak into the error response.
        """
        tmp_root, test_body, asset_path = tmp_assets
        monkeypatch.setattr(hyrax, "ASSET_BASE", tmp_root)
        # Remove the file but keep the directory
        asset_path.unlink()

        handler = _Handler()
        handled = _call_hyrax_get(handler, "/api/hyrax/assets/tai.embodiment.vrm")

        assert handled is True
        assert handler.status == 404
        body_text = handler.body_text().lower()
        for leak in ["/", "hyrax-assets", str(tmp_root).lower()]:
            assert leak not in body_text, f"Response leaked path token: {leak}"

    # ── Symlink rejection ──────────────────────────────────────────────

    def test_symlink_rejected(self, monkeypatch, tmp_assets):
        """A symlink at the target path must be rejected with 404."""
        tmp_root, test_body, asset_path = tmp_assets
        monkeypatch.setattr(hyrax, "ASSET_BASE", tmp_root)

        # A broken link must not be treated as an asset.
        asset_path.unlink()
        fake_target = tmp_root / "nope"
        asset_path.symlink_to(fake_target)

        handler = _Handler()
        handled = _call_hyrax_get(handler, "/api/hyrax/assets/tai.embodiment.vrm")

        assert handled is True
        assert handler.status == 404, "Symlink should be rejected"

    def test_symlink_to_existing_in_root_file_rejected(self, monkeypatch, tmp_assets):
        """Resolving a valid in-root symlink must not bypass the symlink ban."""
        tmp_root, test_body, asset_path = tmp_assets
        monkeypatch.setattr(hyrax, "ASSET_BASE", tmp_root)
        real_target = tmp_root / "embodiment" / "real.vrm"
        real_target.write_bytes(test_body)
        asset_path.unlink()
        asset_path.symlink_to(real_target)

        handler = _Handler()
        handled = _call_hyrax_get(handler, "/api/hyrax/assets/tai.embodiment.vrm")

        assert handled is True
        assert handler.status == 404
        assert handler.json_body() == {"error": "not found"}

    # ── Canonical routes ─────────────────────────────────────────────

    def test_existing_projects_route_still_works(self):
        """The /api/hyrax/projects route must be reachable."""
        handler = _Handler()
        handled = _call_hyrax_get(handler, "/api/hyrax/projects")
        assert handled is True
        assert handler.status == 200

    def test_existing_stats_route_still_works(self):
        """The /api/hyrax/stats route must be reachable."""
        handler = _Handler()
        handled = _call_hyrax_get(handler, "/api/hyrax/stats")
        assert handled is True
        assert handler.status == 200

    def test_unhandled_path_returns_false(self):
        """Non-hyrax paths must return False so core routes can handle them.

        handle_hyrax_get only handles /api/hyrax/* paths. Unknown paths
        outside that prefix must return False to pass through.
        """
        handler = _Handler()
        handled = _call_hyrax_get(handler, "/api/v1/nonexistent")
        assert handled is False

    # ── Auth rejection ─────────────────────────────────────────────────

    def test_noauth_rejected_when_auth_enabled(self, monkeypatch):
        """When auth is enabled, an unauthenticated request returns 401.

        The /api/hyrax/assets/... prefix is NOT in PUBLIC_PATHS, so check_auth
        should reject it. We use the actual check_auth to verify.
        """
        monkeypatch.setattr(auth, "is_password_auth_enabled", lambda: True)
        monkeypatch.setattr(auth, "are_passkeys_enabled", lambda: False)
        monkeypatch.setattr(auth, "is_oidc_auth_enabled", lambda: False)
        monkeypatch.setattr(auth, "is_trusted_auth_enabled", lambda: False)

        handler = _Handler(path="/api/hyrax/assets/tai.embodiment.vrm")
        parsed = SimpleNamespace(path="/api/hyrax/assets/tai.embodiment.vrm", query="")

        result = auth.check_auth(handler, parsed)
        assert result is False
        assert handler.status == 401


# ══════════════════════════════════════════════════════════════════════════
# RED phase (t_52209fc9) — explicit dispatch must be absent before change
# These tests define the DESIRED behavior after refactoring to explicit
# dispatch. They will FAIL with the current monkey-patch code and PASS
# after the explicit /api/hyrax/* dispatch is added to api.routes.
# ══════════════════════════════════════════════════════════════════════════


class TestExplicitDispatch:
    """RED: proves explicit dispatch for canonical Hyrax paths does not exist yet.

    After GREEN these tests verify that api.routes.handle_get dispatches
    /api/hyrax/* paths to hyrax handlers without monkey-patching.
    """

    # ── Canonical paths must be handled via explicit dispatch ──────────

    def test_explicit_dispatch_projects(self):
        """RED: /api/hyrax/projects must be handled by routes.handle_get.

        Before change this will fail (no explicit dispatch exists — only
        the monkey-patched /api/v1/projects is intercepted).
        """
        from api import routes as core_routes

        handler = _Handler()
        result = core_routes.handle_get(
            handler, SimpleNamespace(path="/api/hyrax/projects", query="")
        )
        assert result is True, "Expected /api/hyrax/projects to be handled"
        assert handler.status == 200

    def test_explicit_dispatch_stats(self):
        """RED: /api/hyrax/stats must be handled by routes.handle_get."""
        from api import routes as core_routes

        handler = _Handler()
        result = core_routes.handle_get(
            handler, SimpleNamespace(path="/api/hyrax/stats", query="")
        )
        assert result is True, "Expected /api/hyrax/stats to be handled"
        assert handler.status == 200

    def test_explicit_dispatch_agents(self):
        """RED: /api/hyrax/agents must be handled by routes.handle_get."""
        from api import routes as core_routes

        handler = _Handler()
        result = core_routes.handle_get(
            handler, SimpleNamespace(path="/api/hyrax/agents", query="")
        )
        assert result is True, "Expected /api/hyrax/agents to be handled"
        assert handler.status == 200

    # ── Importing hyrax_routes must NOT mutate routes.handle_get ───────

    def test_import_hyrax_routes_no_mutation(self):
        """RED: importing hyrax_routes must NOT mutate routes.handle_get.

        Current monkey-patch reassigns core_routes.handle_get at import.
        After refactoring, importing hyrax_routes is a no-op for dispatch.
        """
        import importlib

        from api import routes as core_routes
        import api.hyrax_routes as hyrax_mod

        get_before = core_routes.handle_get
        importlib.reload(hyrax_mod)
        get_after = core_routes.handle_get

        # With monkey-patch, reload re-wraps → get_before is not get_after.
        # With explicit dispatch, importing hyrax_routes is inert.
        assert get_before is get_after, (
            "Importing hyrax_routes must not mutate routes.handle_get"
        )

    # ── Assets must still work through dispatch ────────────────────────

    def test_asset_dispatch_preserved(self, monkeypatch, tmp_assets):
        """RED: /api/hyrax/assets/<name> must still be handled through dispatch."""
        from api import routes as core_routes

        tmp_root, test_body, _asset_path = tmp_assets
        monkeypatch.setattr(hyrax, "ASSET_BASE", tmp_root)

        handler = _Handler()
        result = core_routes.handle_get(
            handler,
            SimpleNamespace(
                path="/api/hyrax/assets/tai.embodiment.vrm", query=""
            ),
        )
        # Currently True (monkey-patch intercepts). After refactor, must
        # still be True through explicit dispatch.
        assert result is True
        assert handler.status == 200
        assert handler.body_bytes() == test_body

    # ── Ordinary WebUI routes must still work ──────────────────────────

    def test_ordinary_routes_still_work(self):
        """RED: a core route like /api/sessions must still work normally."""
        # This is a smoke-test — it only checks that the call doesn't
        # error and returns something consistent. The full suite in
        # test_static_asset_resolver.py covers all static/core routes.
        import api.routes as core_routes

        handler = _Handler()
        # manifest.json is a known core route
        from pathlib import Path
        from api.config import get_static_root

        manifest = get_static_root() / "manifest.json"
        if not manifest.exists():
            pytest.skip("manifest.json not present — can't test ordinary route")
        # Monkey-patch the static root if needed
        result = core_routes.handle_get(
            handler, SimpleNamespace(path="/manifest.json", query="")
        )
        assert result is True
        assert handler.status == 200
