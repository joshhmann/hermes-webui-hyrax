"""
Tests for Hyrax VN native session adapter (api/hyrax_routes.py VN namespace).

TDD driver: tests must fail before implementation (RED phase).
==============================================================================
GREEN phase — all tests should pass after VN handler is implemented.
==============================================================================

RULES:
- Use fake handlers/mocks; do not start a real agent turn in unit tests.
- No import-time mutation.
- Tests must be independent of actual profile state on disk.
"""

from __future__ import annotations

import io
import json
from types import SimpleNamespace
from typing import Any
from urllib.parse import urlparse

import pytest

import api.auth as auth


# ── Mock HTTP handler ──────────────────────────────────────────────────────
class _Handler:
    """Minimal mock HTTP request handler that captures status/headers/body."""

    def __init__(self, *, headers=None, path="/", command="GET"):
        self.headers = dict(headers or {})
        self.command = command
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


# ── Fixtures ───────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def isolate_auth(monkeypatch):
    """Disable all auth by default so tests can focus on route behavior."""
    monkeypatch.setattr(auth, "STATE_DIR", "/tmp/__test_hyrax_vn_auth")
    monkeypatch.setattr(auth, "_SESSIONS_FILE", "/tmp/__test_hyrax_vn_auth/.sessions.json")
    monkeypatch.setattr(auth, "is_password_auth_enabled", lambda: False)
    monkeypatch.setattr(auth, "are_passkeys_enabled", lambda: False)
    monkeypatch.setattr(auth, "is_oidc_auth_enabled", lambda: False)
    monkeypatch.setattr(auth, "is_trusted_auth_enabled", lambda: False)
    auth._sessions.clear()
    auth._TRUSTED_AUTH_WARNINGS_EMITTED.clear()
    yield
    auth._sessions.clear()
    auth._TRUSTED_AUTH_WARNINGS_EMITTED.clear()


# ── Mock session objects ───────────────────────────────────────────────────

def _make_mock_session(
    session_id: str,
    profile: str = "tai",
    project_id: str | None = "hyrax-vn",
    archived: bool = False,
    title: str = "Tai VN",
    messages: list | None = None,
    active_stream_id: str | None = None,
    created_at: float = 1000.0,
    updated_at: float = 1000.0,
):
    """Create a minimal session-like object for testing."""
    return SimpleNamespace(
        session_id=session_id,
        profile=profile,
        project_id=project_id,
        archived=archived,
        title=title,
        messages=messages or [],
        active_stream_id=active_stream_id,
        created_at=created_at,
        updated_at=updated_at,
        save=lambda: None,
    )


# ══════════════════════════════════════════════════════════════════════════
# Test: VN allowlist
# ══════════════════════════════════════════════════════════════════════════

class TestVnAllowlist:
    """Tests for the fixed immutable sister allowlist."""

    def test_all_four_sisters_present(self):
        """The allowlist must contain tai, rei, nei, mai."""
        from api.hyrax_routes import VN_PROFILES
        expected = {"tai", "rei", "nei", "mai"}
        assert set(VN_PROFILES.keys()) == expected

    def test_each_profile_has_name_and_role(self):
        """Each sister must have name, role, available, and assets."""
        from collections.abc import Mapping
        from api.hyrax_routes import VN_PROFILES
        for pid, meta in VN_PROFILES.items():
            assert isinstance(meta, Mapping)
            assert "name" in meta
            assert "role" in meta
            assert "available" in meta
            assert "assets" in meta
            assert isinstance(meta["assets"], Mapping)
            assert len(meta["assets"]) >= 3  # portrait, background, chibi minimum

    def test_allowlist_is_mappingproxy(self):
        """The allowlist must be a MappingProxyType, not a mutable dict."""
        from types import MappingProxyType
        from api.hyrax_routes import VN_PROFILES
        # NON-MUTATING assertion first so RED fails before mutating module state
        assert isinstance(VN_PROFILES, MappingProxyType), "VN_PROFILES must be MappingProxyType"
        assert len(VN_PROFILES) >= 4
        # Top-level assignment must raise TypeError
        import pytest
        with pytest.raises(TypeError):
            VN_PROFILES["new_sister"] = {"name": "Eve"}  # type: ignore[misc]

    def test_allowlist_nested_desc_immutable(self):
        """Nested metadata dicts within VN_PROFILES must be immutable."""
        from types import MappingProxyType
        from api.hyrax_routes import VN_PROFILES
        import pytest
        # First assert structure is immutable at all levels — ONLY non-mutating checks
        assert isinstance(VN_PROFILES, MappingProxyType)
        for pid, meta in VN_PROFILES.items():
            assert isinstance(meta, MappingProxyType), f"{pid} meta must be MappingProxyType"
            assets = meta["assets"]
            assert isinstance(assets, MappingProxyType), f"{pid} assets must be MappingProxyType"
        # Then verify mutation rejection (these won't be reached in RED so no pollution)
        for pid, meta in VN_PROFILES.items():
            with pytest.raises(TypeError):
                meta["available"] = False  # type: ignore[misc]
            with pytest.raises(TypeError):
                meta["name"] = "Nope"  # type: ignore[misc]
            assets = meta["assets"]
            with pytest.raises(TypeError):
                assets["neutral"] = "/evil/path"  # type: ignore[misc]
            with pytest.raises(TypeError):
                assets["new_asset"] = "/bad"  # type: ignore[misc]

    def test_allowlist_api_response_is_plain_dict(self):
        """The API response at /api/hyrax/vn/profiles must return plain JSON-safe dicts."""
        from api.hyrax_routes import _vn_serve_profiles
        handler = _Handler()
        _vn_serve_profiles(handler)
        body = handler.json_body()
        assert "items" in body
        for item in body["items"]:
            assert isinstance(item, dict)
            assert isinstance(item["assets"], dict)
            # Verify JSON-serializable
            assert json.dumps(item)

    def test_allowlist_nested_mutation_via_copy_rejected(self):
        """Assignment to VN_PROFILES must always raise TypeError (no monkeypatch bypass)."""
        from types import MappingProxyType
        from api.hyrax_routes import VN_PROFILES
        import pytest
        assert isinstance(VN_PROFILES, MappingProxyType)
        # Nested dict mutation via top-level item must also be rejected
        with pytest.raises(TypeError):
            VN_PROFILES["tai"]["available"] = False  # type: ignore[misc]


# ══════════════════════════════════════════════════════════════════════════
# Test: GET /api/hyrax/vn/profiles
# ══════════════════════════════════════════════════════════════════════════

class TestVnProfilesEndpoint:
    """Tests for GET /api/hyrax/vn/profiles."""

    def _call(self):
        """Call GET /api/hyrax/vn/profiles and return the handler."""
        from api.hyrax_routes import handle_hyrax_vn_get
        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/profiles", query="")
        handle_hyrax_vn_get(handler, parsed)
        return handler

    def test_returns_200(self):
        """Known VN route returns 200."""
        from api.hyrax_routes import handle_hyrax_vn_get
        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/profiles", query="")
        handled = handle_hyrax_vn_get(handler, parsed)
        assert handled is True
        assert handler.status == 200

    def test_returns_items_array(self):
        """Returns {items: [...]} with bounded metadata."""
        from api.hyrax_routes import handle_hyrax_vn_get
        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/profiles", query="")
        handle_hyrax_vn_get(handler, parsed)
        body = handler.json_body()
        assert "items" in body
        items = body["items"]
        assert isinstance(items, list)
        assert len(items) == 4
        ids = {item["id"] for item in items}
        assert ids == {"tai", "rei", "nei", "mai"}

    def test_no_raw_profile_leak(self):
        """Response must never expose filesystem paths or raw config."""
        from api.hyrax_routes import handle_hyrax_vn_get
        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/profiles", query="")
        handle_hyrax_vn_get(handler, parsed)
        body_text = handler.body_text().lower()
        # Check for filesystem paths and internal config leaks
        for leak in ["\\", "hermes_home", "filesystem", ".hermes"]:
            assert leak not in body_text, f"Response leaked: {leak}"
        # '/' is expected in JSON output (JSON syntax), so we only check
        # for path-like patterns that shouldn't appear
        assert "hyrax-assets" not in body_text


# ══════════════════════════════════════════════════════════════════════════
# Test: POST /api/hyrax/vn/conversations
# ══════════════════════════════════════════════════════════════════════════

class TestVnConversationsPost:
    """Tests for POST /api/hyrax/vn/conversations."""

    def _call_vn_post(self, handler, path, body_dict):
        """Call handle_hyrax_vn_post with a dict body."""
        from api.hyrax_routes import handle_hyrax_vn_post
        parsed = SimpleNamespace(path=path, query="")
        return handle_hyrax_vn_post(handler, parsed, body_dict)

    # ── Body validation ────────────────────────────────────────────────

    def test_rejects_empty_body(self):
        """Empty dict body must be rejected (no profile_id)."""
        from api.hyrax_routes import handle_hyrax_vn_post
        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations", query="")
        handled = handle_hyrax_vn_post(handler, parsed, {})
        assert handled is True
        assert handler.status == 400

    def test_rejects_unknown_keys(self):
        """Body with unknown keys must be rejected."""
        from api.hyrax_routes import handle_hyrax_vn_post
        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations", query="")
        handled = handle_hyrax_vn_post(
            handler, parsed, {"profile_id": "tai", "evil": "yes"}
        )
        assert handled is True
        assert handler.status == 400

    def test_rejects_non_allowlisted_profile(self):
        """Unknown profile_id must be rejected."""
        from api.hyrax_routes import handle_hyrax_vn_post
        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations", query="")
        handled = handle_hyrax_vn_post(
            handler, parsed, {"profile_id": "unknown"}
        )
        assert handled is True
        assert handler.status == 400

    def test_rejects_traversal_profile_id(self):
        """Traversal-shaped profile_id must be rejected."""
        from api.hyrax_routes import handle_hyrax_vn_post
        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations", query="")
        handled = handle_hyrax_vn_post(
            handler, parsed, {"profile_id": "../../etc/passwd"}
        )
        assert handled is True
        assert handler.status == 400

    def test_rejects_non_string_profile_id(self):
        """Non-string profile_id must be rejected."""
        from api.hyrax_routes import handle_hyrax_vn_post
        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations", query="")
        handled = handle_hyrax_vn_post(
            handler, parsed, {"profile_id": 42}
        )
        assert handled is True
        assert handler.status == 400

    def test_rejects_non_bool_fresh(self):
        """Non-boolean fresh must be rejected."""
        from api.hyrax_routes import handle_hyrax_vn_post
        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations", query="")
        handled = handle_hyrax_vn_post(
            handler, parsed, {"profile_id": "tai", "fresh": "yes"}
        )
        assert handled is True
        assert handler.status == 400

    def test_rejects_null_fresh(self):
        """fresh=null must be rejected (not coerced to false)."""
        from api.hyrax_routes import handle_hyrax_vn_post
        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations", query="")
        handled = handle_hyrax_vn_post(
            handler, parsed, {"profile_id": "tai", "fresh": None}
        )
        assert handled is True
        assert handler.status == 400

    # ── Session selection ───────────────────────────────────────────────

    def test_creates_new_session_when_none_exists(self, monkeypatch):
        """When no active VN session exists, creates one via new_session."""
        from api.hyrax_routes import handle_hyrax_vn_post
        created_sessions = []

        # Patch the module-level references in hyrax_routes
        monkeypatch.setattr("api.hyrax_routes._all_sessions", lambda: [])
        monkeypatch.setattr("api.hyrax_routes._get_session",
                            lambda sid, **kw: (_ for _ in ()).throw(KeyError(sid)))

        def _fake_new_session(*, profile=None, project_id=None, **kw):
            import api.models as models
            s = models.Session(
                workspace="/tmp",
                model="test",
                model_provider="test",
                profile=profile,
                project_id=project_id,
            )
            s.title = f"{profile.title()} VN"
            created_sessions.append(s)
            return s

        monkeypatch.setattr("api.hyrax_routes._new_session", _fake_new_session)

        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations", query="")
        handled = handle_hyrax_vn_post(
            handler, parsed, {"profile_id": "tai"}
        )
        assert handled is True
        assert handler.status == 200
        body = handler.json_body()
        assert "conversation" in body
        assert len(created_sessions) == 1
        assert created_sessions[0].profile == "tai"
        assert created_sessions[0].project_id == "hyrax-vn"

    def test_selects_newest_active_vn_session(self, monkeypatch):
        """Selects the newest active VN session by updated_at."""
        from api.hyrax_routes import handle_hyrax_vn_post

        def _make_compact(sid, profile="tai", updated_at=0, archived=False):
            return {
                "session_id": sid,
                "profile": profile,
                "project_id": "hyrax-vn",
                "archived": archived,
                "title": f"{profile.title()} VN",
                "message_count": 0,
                "active_stream_id": None,
                "created_at": 100.0,
                "updated_at": updated_at,
            }

        old = _make_compact("session_old", updated_at=100.0)
        new = _make_compact("session_new", updated_at=200.0)

        monkeypatch.setattr("api.hyrax_routes._all_sessions", lambda: [old, new])

        # Return the session matching the requested session_id
        def _fake_get_session(sid, **kw):
            if sid == "session_old":
                return _make_mock_session("session_old", updated_at=100.0)
            elif sid == "session_new":
                return _make_mock_session("session_new", updated_at=200.0)
            raise KeyError(sid)

        monkeypatch.setattr("api.hyrax_routes._get_session", _fake_get_session)

        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations", query="")
        handled = handle_hyrax_vn_post(
            handler, parsed, {"profile_id": "tai"}
        )
        assert handled is True
        assert handler.status == 200

    def test_fresh_archives_and_creates_new(self, monkeypatch):
        """fresh=true archives current and creates new session."""
        from api.hyrax_routes import handle_hyrax_vn_post

        # Mock that there's an existing session
        monkeypatch.setattr("api.hyrax_routes._all_sessions", lambda: [
            {
                "session_id": "session_existing",
                "profile": "tai",
                "project_id": "hyrax-vn",
                "archived": False,
                "title": "Tai VN",
                "message_count": 2,
                "active_stream_id": None,
                "created_at": 100.0,
                "updated_at": 300.0,
            }
        ])

        created_sessions = []
        existing = _make_mock_session("session_existing")

        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: existing)

        def _fake_new_session(*, profile=None, project_id=None, **kw):
            import api.models as models
            s = models.Session(
                workspace="/tmp",
                model="test",
                model_provider="test",
                profile=profile,
                project_id=project_id,
            )
            s.title = f"{profile.title()} VN"
            created_sessions.append(s)
            return s

        monkeypatch.setattr("api.hyrax_routes._new_session", _fake_new_session)

        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations", query="")
        handled = handle_hyrax_vn_post(
            handler, parsed, {"profile_id": "tai", "fresh": True}
        )
        assert handled is True
        assert handler.status == 200
        assert len(created_sessions) == 1

    def test_serializes_per_sister(self):
        """Create/archive per sister uses bounded lock registry."""
        from api.hyrax_routes import _VN_CONVERSATION_LOCKS
        assert isinstance(_VN_CONVERSATION_LOCKS, dict)
        for pid in ("tai", "rei", "nei", "mai"):
            assert pid in _VN_CONVERSATION_LOCKS


# ══════════════════════════════════════════════════════════════════════════
# Test: Transcript bounds hardening
# ══════════════════════════════════════════════════════════════════════════

class TestVnTranscriptBounds:
    """Tests for bounded transcript fields."""

    def test_has_max_content_length_constant(self):
        """Module must define MAX_TRANSCRIPT_CONTENT_LENGTH."""
        from api.hyrax_routes import MAX_TRANSCRIPT_CONTENT_LENGTH
        assert isinstance(MAX_TRANSCRIPT_CONTENT_LENGTH, int)
        assert MAX_TRANSCRIPT_CONTENT_LENGTH > 0

    def test_has_max_name_length_constant(self):
        """Module must define MAX_TRANSCRIPT_NAME_LENGTH."""
        from api.hyrax_routes import MAX_TRANSCRIPT_NAME_LENGTH
        assert isinstance(MAX_TRANSCRIPT_NAME_LENGTH, int)
        assert MAX_TRANSCRIPT_NAME_LENGTH > 0

    def test_bounded_message_truncates_overlong_content(self):
        """Messages with content exceeding MAX_TRANSCRIPT_CONTENT_LENGTH are truncated."""
        from api.hyrax_routes import MAX_TRANSCRIPT_CONTENT_LENGTH, _vn_bounded_message
        overlong = "x" * (MAX_TRANSCRIPT_CONTENT_LENGTH + 10000)
        result = _vn_bounded_message({"role": "user", "content": overlong})
        assert len(result["content"]) <= MAX_TRANSCRIPT_CONTENT_LENGTH

    def test_bounded_message_truncates_overlong_name(self):
        """Messages with name exceeding MAX_TRANSCRIPT_NAME_LENGTH are truncated."""
        from api.hyrax_routes import MAX_TRANSCRIPT_NAME_LENGTH, _vn_bounded_message
        overlong = "n" * (MAX_TRANSCRIPT_NAME_LENGTH + 100)
        result = _vn_bounded_message({"role": "assistant", "content": "hi", "name": overlong})
        assert len(result["name"]) <= MAX_TRANSCRIPT_NAME_LENGTH

    def test_short_content_passes_through_unchanged(self):
        """Content under the cap is not truncated."""
        from api.hyrax_routes import _vn_bounded_message
        short = "Hello, World!"
        result = _vn_bounded_message({"role": "user", "content": short})
        assert result["content"] == short

    def test_transcript_endpoint_respects_content_bound(self, monkeypatch):
        """GET conversation returns bounded content even when session has long messages."""
        from api.hyrax_routes import MAX_TRANSCRIPT_CONTENT_LENGTH, handle_hyrax_vn_get
        long_msg = "a" * (MAX_TRANSCRIPT_CONTENT_LENGTH + 5000)
        session = _make_mock_session("vn_session_1", messages=[
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": long_msg},
        ])
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations/vn_session_1", query="")
        handle_hyrax_vn_get(handler, parsed)
        body = handler.json_body()
        conv = body.get("conversation", body)
        transcript = conv.get("messages", [])
        for m in transcript:
            assert len(m.get("content", "")) <= MAX_TRANSCRIPT_CONTENT_LENGTH

    def test_transcript_endpoint_respects_name_bound(self, monkeypatch):
        """GET conversation returns bounded name even when session has long names."""
        from api.hyrax_routes import MAX_TRANSCRIPT_NAME_LENGTH, handle_hyrax_vn_get
        long_name = "n" * (MAX_TRANSCRIPT_NAME_LENGTH + 50)
        session = _make_mock_session("vn_session_1", messages=[
            {"role": "assistant", "content": "hi", "name": long_name},
        ])
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations/vn_session_1", query="")
        handle_hyrax_vn_get(handler, parsed)
        body = handler.json_body()
        conv = body.get("conversation", body)
        transcript = conv.get("messages", [])
        for m in transcript:
            if "name" in m:
                assert len(m["name"]) <= MAX_TRANSCRIPT_NAME_LENGTH


# ══════════════════════════════════════════════════════════════════════════
# Test: GET /api/hyrax/vn/conversations/{session_id}
# ══════════════════════════════════════════════════════════════════════════

class TestVnConversationsGet:
    """Tests for GET /api/hyrax/vn/conversations/{session_id}."""

    def test_returns_transcript_for_valid_vn_session(self, monkeypatch):
        """Valid VN session returns bounded transcript."""
        from api.hyrax_routes import handle_hyrax_vn_get

        session = _make_mock_session("vn_session_1")
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations/vn_session_1", query="")
        handled = handle_hyrax_vn_get(handler, parsed)
        assert handled is True
        assert handler.status == 200

    def test_non_vn_session_returns_404(self, monkeypatch):
        """Non-VN session returns 404."""
        from api.hyrax_routes import handle_hyrax_vn_get

        session = _make_mock_session("session_1", project_id=None)
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations/session_1", query="")
        handled = handle_hyrax_vn_get(handler, parsed)
        assert handled is True
        assert handler.status == 404

    def test_cross_profile_session_returns_404(self, monkeypatch):
        """VN session owned by non-sister profile returns 404."""
        from api.hyrax_routes import handle_hyrax_vn_get

        session = _make_mock_session("vn_session_1", profile="default")
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations/vn_session_1", query="")
        handled = handle_hyrax_vn_get(handler, parsed)
        assert handled is True
        assert handler.status == 404

    def test_missing_session_returns_404(self, monkeypatch):
        """Missing session returns 404."""
        from api.hyrax_routes import handle_hyrax_vn_get

        monkeypatch.setattr("api.hyrax_routes._get_session",
                            lambda sid, **kw: (_ for _ in ()).throw(KeyError(sid)))

        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations/nonexistent", query="")
        handled = handle_hyrax_vn_get(handler, parsed)
        assert handled is True
        assert handler.status == 404

    def test_transcript_filters_system_rows(self, monkeypatch):
        """Transcript filters internal/system rows."""
        from api.hyrax_routes import handle_hyrax_vn_get

        session = _make_mock_session("vn_session_1", messages=[
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi"},
            {"role": "system", "content": "internal"},
            {"role": "context", "content": "tool call details"},
        ])
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations/vn_session_1", query="")
        handle_hyrax_vn_get(handler, parsed)
        body = handler.json_body()
        conversation = body.get("conversation", body)
        transcript = conversation.get("messages", [])
        roles = [m["role"] for m in transcript]
        assert "system" not in roles
        assert "context" not in roles

    def test_transcript_never_exposes_raw_tool_args(self, monkeypatch):
        """Transcript must not expose raw tool arguments or filesystem paths."""
        from api.hyrax_routes import handle_hyrax_vn_get

        session = _make_mock_session("vn_session_1", messages=[
            {"role": "user", "content": "list files"},
            {"role": "assistant", "content": None,
             "tool_calls": [
                 {"function": {"name": "read_file", "arguments": '{"path": "/etc/passwd"}'}}
             ]},
        ])
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations/vn_session_1", query="")
        handle_hyrax_vn_get(handler, parsed)
        body_text = handler.body_text().lower()
        # No filesystem paths in output
        assert "/etc/passwd" not in body_text


# ══════════════════════════════════════════════════════════════════════════
# Test: POST /api/hyrax/vn/conversations/{session_id}/turns
# ══════════════════════════════════════════════════════════════════════════

class TestVnTurnsPost:
    """Tests for POST /api/hyrax/vn/conversations/{session_id}/turns."""

    def test_delegates_to_start_session_turn(self, monkeypatch):
        """Turn submission delegates exactly once to start_session_turn."""
        from api.hyrax_routes import handle_hyrax_vn_post

        call_count = [0]

        def _fake_start_turn(session_id, message, *, source=None):
            call_count[0] += 1
            assert source == "hyrax_vn"
            return {"stream_id": "stream_1", "pending": True, "_status": 200}

        monkeypatch.setattr("api.routes.start_session_turn", _fake_start_turn)

        session = _make_mock_session("vn_session_1")
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        handler = _Handler()
        parsed = SimpleNamespace(
            path="/api/hyrax/vn/conversations/vn_session_1/turns", query=""
        )
        handled = handle_hyrax_vn_post(handler, parsed, {"text": "Hello"})
        assert handled is True
        assert call_count[0] == 1

    def test_returns_stream_pending_status(self, monkeypatch):
        """Returns only stream_id, pending, and status fields."""
        from api.hyrax_routes import handle_hyrax_vn_post

        def _fake_start_turn(session_id, message, *, source=None):
            return {"stream_id": "stream_1", "pending": True, "_status": 200}

        monkeypatch.setattr("api.routes.start_session_turn", _fake_start_turn)

        session = _make_mock_session("vn_session_1")
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        handler = _Handler()
        parsed = SimpleNamespace(
            path="/api/hyrax/vn/conversations/vn_session_1/turns", query=""
        )
        handle_hyrax_vn_post(handler, parsed, {"text": "Hello"})
        result = handler.json_body()
        assert "stream_id" in result
        assert "pending" in result

    def test_rejects_empty_text(self, monkeypatch):
        """Empty or whitespace-only text is rejected with 400."""
        from api.hyrax_routes import handle_hyrax_vn_post

        session = _make_mock_session("vn_session_1")
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        handler = _Handler()
        parsed = SimpleNamespace(
            path="/api/hyrax/vn/conversations/vn_session_1/turns", query=""
        )
        handled = handle_hyrax_vn_post(handler, parsed, {"text": "   "})
        assert handled is True
        assert handler.status == 400

    def test_preserves_native_409(self, monkeypatch):
        """Native 409 (active stream) is preserved."""
        from api.hyrax_routes import handle_hyrax_vn_post

        def _fake_start_turn(session_id, message, *, source=None):
            return {"error": "Session already has an active turn", "_status": 409}

        monkeypatch.setattr("api.routes.start_session_turn", _fake_start_turn)

        session = _make_mock_session("vn_session_1")
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        handler = _Handler()
        parsed = SimpleNamespace(
            path="/api/hyrax/vn/conversations/vn_session_1/turns", query=""
        )
        handle_hyrax_vn_post(handler, parsed, {"text": "Hello"})
        assert handler.status == 409

    def test_has_max_turn_text_length_constant(self):
        """Module must define MAX_TURN_TEXT_LENGTH."""
        from api.hyrax_routes import MAX_TURN_TEXT_LENGTH
        assert isinstance(MAX_TURN_TEXT_LENGTH, int)
        assert MAX_TURN_TEXT_LENGTH > 0

    def test_rejects_text_over_max_length(self, monkeypatch):
        """Text exceeding MAX_TURN_TEXT_LENGTH returns 400."""
        from api.hyrax_routes import MAX_TURN_TEXT_LENGTH, handle_hyrax_vn_post

        session = _make_mock_session("vn_session_1")
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        overlong = "x" * (MAX_TURN_TEXT_LENGTH + 1)
        handler = _Handler()
        parsed = SimpleNamespace(
            path="/api/hyrax/vn/conversations/vn_session_1/turns", query=""
        )
        handled = handle_hyrax_vn_post(handler, parsed, {"text": overlong})
        assert handled is True
        assert handler.status == 400

    def test_accepts_text_at_max_length(self, monkeypatch):
        """Text at exactly MAX_TURN_TEXT_LENGTH is accepted."""
        from api.hyrax_routes import MAX_TURN_TEXT_LENGTH, handle_hyrax_vn_post

        def _fake_start_turn(session_id, message, *, source=None):
            assert len(message) <= MAX_TURN_TEXT_LENGTH
            return {"stream_id": "stream_1", "pending": True, "_status": 200}

        monkeypatch.setattr("api.routes.start_session_turn", _fake_start_turn)

        session = _make_mock_session("vn_session_1")
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        boundary = "a" * MAX_TURN_TEXT_LENGTH
        handler = _Handler()
        parsed = SimpleNamespace(
            path="/api/hyrax/vn/conversations/vn_session_1/turns", query=""
        )
        handled = handle_hyrax_vn_post(handler, parsed, {"text": boundary})
        assert handled is True
        assert handler.status == 200

    def test_preserves_native_404(self, monkeypatch):
        """Native 404 (session not found) is preserved."""
        from api.hyrax_routes import handle_hyrax_vn_post

        monkeypatch.setattr("api.hyrax_routes._get_session",
                            lambda sid, **kw: (_ for _ in ()).throw(KeyError(sid)))

        handler = _Handler()
        parsed = SimpleNamespace(
            path="/api/hyrax/vn/conversations/nonexistent/turns", query=""
        )
        handled = handle_hyrax_vn_post(handler, parsed, {"text": "Hello"})
        assert handled is True
        assert handler.status == 404

    def test_non_vn_session_turn_returns_404(self, monkeypatch):
        """Non-VN session turn returns 404."""
        from api.hyrax_routes import handle_hyrax_vn_post

        session = _make_mock_session("session_1", project_id=None)
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        handler = _Handler()
        parsed = SimpleNamespace(
            path="/api/hyrax/vn/conversations/session_1/turns", query=""
        )
        handled = handle_hyrax_vn_post(handler, parsed, {"text": "Hello"})
        assert handled is True
        assert handler.status == 404

    # ── Finding 3: Turn body must reject unknown keys ────────────────

    def test_turn_rejects_extra_keys(self, monkeypatch):
        """Turn body with extra keys beyond 'text' must be rejected."""
        from api.hyrax_routes import handle_hyrax_vn_post

        session = _make_mock_session("vn_session_1")
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        handler = _Handler()
        parsed = SimpleNamespace(
            path="/api/hyrax/vn/conversations/vn_session_1/turns", query=""
        )
        handled = handle_hyrax_vn_post(handler, parsed, {"text": "Hello", "extra": 1})
        assert handled is True
        assert handler.status == 400

    def test_turn_rejects_no_text_key(self, monkeypatch):
        """Turn body without 'text' key must be rejected."""
        from api.hyrax_routes import handle_hyrax_vn_post

        session = _make_mock_session("vn_session_1")
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        handler = _Handler()
        parsed = SimpleNamespace(
            path="/api/hyrax/vn/conversations/vn_session_1/turns", query=""
        )
        handled = handle_hyrax_vn_post(handler, parsed, {"other": "Hello"})
        assert handled is True
        assert handler.status == 400

    # ── Finding 4: Turn error sanitization ──────────────────────────

    def test_turn_native_400_returns_fixed_message(self, monkeypatch):
        """Native 400 errors must return a fixed sanitized message."""
        from api.hyrax_routes import handle_hyrax_vn_post

        def _fake_start_turn(session_id, message, *, source=None):
            return {"error": "Session is in an invalid state with a very long reason", "_status": 400}

        monkeypatch.setattr("api.routes.start_session_turn", _fake_start_turn)

        session = _make_mock_session("vn_session_1")
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        handler = _Handler()
        parsed = SimpleNamespace(
            path="/api/hyrax/vn/conversations/vn_session_1/turns", query=""
        )
        handle_hyrax_vn_post(handler, parsed, {"text": "Hello"})
        assert handler.status == 400
        body = handler.json_body()
        assert body["error"] == "bad request"

    def test_turn_native_404_returns_fixed_message(self, monkeypatch):
        """Native 404 errors must return a fixed sanitized message."""
        from api.hyrax_routes import handle_hyrax_vn_post

        def _fake_start_turn(session_id, message, *, source=None):
            return {"error": "Session some-uuid-v4 not found", "_status": 404}

        monkeypatch.setattr("api.routes.start_session_turn", _fake_start_turn)

        session = _make_mock_session("vn_session_1")
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        handler = _Handler()
        parsed = SimpleNamespace(
            path="/api/hyrax/vn/conversations/vn_session_1/turns", query=""
        )
        handle_hyrax_vn_post(handler, parsed, {"text": "Hello"})
        assert handler.status == 404
        body = handler.json_body()
        assert body["error"] == "not found"

    def test_turn_native_409_returns_fixed_message(self, monkeypatch):
        """Native 409 errors must return a fixed sanitized message."""
        from api.hyrax_routes import handle_hyrax_vn_post

        def _fake_start_turn(session_id, message, *, source=None):
            return {"error": "Session already has an active turn: stream_xyz", "_status": 409}

        monkeypatch.setattr("api.routes.start_session_turn", _fake_start_turn)

        session = _make_mock_session("vn_session_1")
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        handler = _Handler()
        parsed = SimpleNamespace(
            path="/api/hyrax/vn/conversations/vn_session_1/turns", query=""
        )
        handle_hyrax_vn_post(handler, parsed, {"text": "Hello"})
        assert handler.status == 409
        body = handler.json_body()
        assert body["error"] == "conflict"

    def test_turn_unknown_status_returns_fixed_500(self, monkeypatch):
        """Native unexpected status codes must be returned as fixed 500."""
        from api.hyrax_routes import handle_hyrax_vn_post

        def _fake_start_turn(session_id, message, *, source=None):
            return {"error": "something weird happened", "_status": 503}

        monkeypatch.setattr("api.routes.start_session_turn", _fake_start_turn)

        session = _make_mock_session("vn_session_1")
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        handler = _Handler()
        parsed = SimpleNamespace(
            path="/api/hyrax/vn/conversations/vn_session_1/turns", query=""
        )
        handle_hyrax_vn_post(handler, parsed, {"text": "Hello"})
        assert handler.status == 500
        body = handler.json_body()
        assert body["error"] == "internal error"

    def test_turn_exception_from_native_returns_fixed_500(self, monkeypatch):
        """Unexpected exception from start_session_turn returns fixed 500."""
        from api.hyrax_routes import handle_hyrax_vn_post

        def _fake_start_turn(session_id, message, *, source=None):
            raise RuntimeError("catastrophic database failure")

        monkeypatch.setattr("api.routes.start_session_turn", _fake_start_turn)

        session = _make_mock_session("vn_session_1")
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        handler = _Handler()
        parsed = SimpleNamespace(
            path="/api/hyrax/vn/conversations/vn_session_1/turns", query=""
        )
        handle_hyrax_vn_post(handler, parsed, {"text": "Hello"})
        assert handler.status == 500
        body = handler.json_body()
        assert body["error"] == "internal error"

    def test_turn_success_excludes_client_status(self, monkeypatch):
        """Success response must expose stream_id, pending, status (not _status)."""
        from api.hyrax_routes import handle_hyrax_vn_post

        def _fake_start_turn(session_id, message, *, source=None):
            return {"stream_id": "stream_1", "pending": True, "_status": 200, "extra": "leak"}

        monkeypatch.setattr("api.routes.start_session_turn", _fake_start_turn)

        session = _make_mock_session("vn_session_1")
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        handler = _Handler()
        parsed = SimpleNamespace(
            path="/api/hyrax/vn/conversations/vn_session_1/turns", query=""
        )
        handle_hyrax_vn_post(handler, parsed, {"text": "Hello"})
        assert handler.status == 200
        body = handler.json_body()
        assert "stream_id" in body
        assert "pending" in body
        assert "status" in body
        # MUST NOT have _status or extra leak
        assert "_status" not in body, "Must not expose native _status"
        assert "extra" not in body, "Must not expose extra fields"


# ══════════════════════════════════════════════════════════════════════════
# Test: Persistence hardening — archive ordering
# ══════════════════════════════════════════════════════════════════════════

class TestVnPersistenceOrdering:
    """Tests that session archival happens only after confirming the session loads."""

    def test_confirm_candidate_exists_before_archiving(self, monkeypatch):
        """When _get_session fails on the candidate, archive_older_sessions should NOT run.

        Regression: _vn_handle_create_conversation previously archived first then
        confirmed the candidate loaded. If the candidate vanished between
        _all_sessions and _get_session, older sessions were needlessly archived.
        """
        from api.hyrax_routes import handle_hyrax_vn_post

        archived_called = [False]

        # Mock _all_sessions to return a candidate
        monkeypatch.setattr("api.hyrax_routes._all_sessions", lambda: [
            {
                "session_id": "vanished_session",
                "profile": "tai",
                "project_id": "hyrax-vn",
                "archived": False,
                "title": "Tai VN",
                "message_count": 1,
                "active_stream_id": None,
                "created_at": 100.0,
                "updated_at": 200.0,
            }
        ])

        # Mock _get_session to raise KeyError (session vanished)
        monkeypatch.setattr("api.hyrax_routes._get_session",
                            lambda sid, **kw: (_ for _ in ()).throw(KeyError(sid)))

        # Track if _vn_archive_older_sessions is called
        original_archive = __import__("api.hyrax_routes", fromlist=["_vn_archive_older_sessions"])._vn_archive_older_sessions

        def tracking_archive(profile, keep_sid):
            archived_called[0] = True
            return original_archive(profile, keep_sid)

        monkeypatch.setattr("api.hyrax_routes._vn_archive_older_sessions", tracking_archive)

        # Mock _new_session to succeed
        monkeypatch.setattr("api.hyrax_routes._new_session",
                            lambda *, profile="tai", project_id=None, **kw: _make_mock_session("new_session", profile=profile, project_id=project_id))

        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations", query="")
        handled = handle_hyrax_vn_post(handler, parsed, {"profile_id": "tai"})
        assert handled is True
        # Should have created a NEW session because the candidate vanished
        assert handler.status == 200
        assert not archived_called[0], (
            "_vn_archive_older_sessions must NOT be called when the candidate "
            "session cannot be loaded — archival should only happen after "
            "confirming the candidate exists."
        )

    # ── Finding 5: all_sessions failure must abort, not create new session ──

    def test_all_sessions_failure_during_select_aborts_with_500(self, monkeypatch):
        """When all_sessions() fails in _vn_select_active_vn_session, request aborts with 500."""
        from api.hyrax_routes import handle_hyrax_vn_post

        new_session_count = [0]

        monkeypatch.setattr("api.hyrax_routes._all_sessions",
                            lambda: (_ for _ in ()).throw(RuntimeError("db failure")))

        monkeypatch.setattr("api.hyrax_routes._new_session",
                            lambda *, profile=None, project_id=None, **kw: (
                                new_session_count.__setitem__(0, new_session_count[0] + 1) or
                                _make_mock_session("evil_new", profile=profile, project_id=project_id)
                            ))

        monkeypatch.setattr("api.hyrax_routes._get_session",
                            lambda sid, **kw: (_ for _ in ()).throw(KeyError(sid)))

        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations", query="")
        handled = handle_hyrax_vn_post(handler, parsed, {"profile_id": "tai"})
        assert handled is True
        assert handler.status == 500
        assert new_session_count[0] == 0, "Must NOT create new session when all_sessions fails"

    def test_all_sessions_failure_during_archive_aborts_with_500(self, monkeypatch):
        """When all_sessions() fails during archive_older_sessions, request aborts with 500."""
        from api.hyrax_routes import handle_hyrax_vn_post

        new_session_count = [0]

        sessions_call_count = [0]
        def _sessions_with_fail():
            sessions_call_count[0] += 1
            if sessions_call_count[0] == 1:
                # First call (select): return a session
                return [{
                    "session_id": "existing_sid",
                    "profile": "tai",
                    "project_id": "hyrax-vn",
                    "archived": False,
                    "title": "Tai VN",
                    "message_count": 1,
                    "active_stream_id": None,
                    "created_at": 100.0,
                    "updated_at": 200.0,
                }]
            # Second call (archive_older_sessions): return more sessions, including one to archive
            return [
                {"session_id": "existing_sid", "profile": "tai", "project_id": "hyrax-vn",
                 "archived": False, "title": "Tai VN", "message_count": 1,
                 "active_stream_id": None, "created_at": 100.0, "updated_at": 200.0},
                {"session_id": "stale_sid", "profile": "tai", "project_id": "hyrax-vn",
                 "archived": False, "title": "Tai VN", "message_count": 1,
                 "active_stream_id": None, "created_at": 50.0, "updated_at": 100.0},
            ]

        monkeypatch.setattr("api.hyrax_routes._all_sessions", _sessions_with_fail)

        # Make _get_session work for the candidate but fail for stale
        def _get_session_lookup(sid, **kw):
            if sid == "existing_sid":
                return _make_mock_session("existing_sid")
            raise RuntimeError("get_session failed for stale")

        monkeypatch.setattr("api.hyrax_routes._get_session", _get_session_lookup)

        monkeypatch.setattr("api.hyrax_routes._new_session",
                            lambda *, profile=None, project_id=None, **kw: (
                                new_session_count.__setitem__(0, new_session_count[0] + 1) or
                                _make_mock_session("evil_new", profile=profile, project_id=project_id)
                            ))

        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations", query="")
        handled = handle_hyrax_vn_post(handler, parsed, {"profile_id": "tai"})
        assert handled is True
        assert handler.status == 500
        assert new_session_count[0] == 0, (
            "Must NOT create new session when _get_session fails during archive"
        )

    def test_archive_save_failure_aborts_with_500(self, monkeypatch):
        """When save() fails during archive, request aborts with 500 (no new session)."""
        from api.hyrax_routes import handle_hyrax_vn_post

        new_session_count = [0]

        # First _all_sessions for select: return an existing session
        select_sessions = [{
            "session_id": "existing_sid", "profile": "tai", "project_id": "hyrax-vn",
            "archived": False, "title": "Tai VN", "message_count": 1,
            "active_stream_id": None, "created_at": 100.0, "updated_at": 200.0,
        }]

        sessions_call_count = [0]
        def _sessions_with_stale():
            sessions_call_count[0] += 1
            if sessions_call_count[0] == 1:
                return select_sessions
            # Second call: candidate + stale session to archive
            return select_sessions + [{
                "session_id": "stale_sid", "profile": "tai", "project_id": "hyrax-vn",
                "archived": False, "title": "Tai VN", "message_count": 1,
                "active_stream_id": None, "created_at": 50.0, "updated_at": 100.0,
            }]

        monkeypatch.setattr("api.hyrax_routes._all_sessions", _sessions_with_stale)

        # _get_session: existing returns normal, stale returns one whose save fails
        stale_session = _make_mock_session("stale_sid")

        def _fail_save():
            raise RuntimeError("save failed")

        stale_session.save = _fail_save

        def _get_session_lookup(sid, **kw):
            if sid == "existing_sid":
                return _make_mock_session("existing_sid")
            return stale_session

        monkeypatch.setattr("api.hyrax_routes._get_session", _get_session_lookup)

        monkeypatch.setattr("api.hyrax_routes._new_session",
                            lambda *, profile=None, project_id=None, **kw: (
                                new_session_count.__setitem__(0, new_session_count[0] + 1) or
                                _make_mock_session("evil_new", profile=profile, project_id=project_id)
                            ))

        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations", query="")
        handled = handle_hyrax_vn_post(handler, parsed, {"profile_id": "tai"})
        assert handled is True
        assert handler.status == 500
        assert new_session_count[0] == 0, (
            "Must NOT create new session when save() fails during archive"
        )

    # ── Finding 5: fresh=true with select failure ──────────────────────

    def test_fresh_all_sessions_failure_aborts_with_500(self, monkeypatch):
        """When fresh=true and all_sessions() fails, must abort with 500."""
        from api.hyrax_routes import handle_hyrax_vn_post

        new_session_count = [0]

        def _fail_all_sessions():
            raise RuntimeError("db failure")

        monkeypatch.setattr("api.hyrax_routes._all_sessions", _fail_all_sessions)
        monkeypatch.setattr("api.hyrax_routes._get_session",
                            lambda sid, **kw: (_ for _ in ()).throw(KeyError(sid)))

        monkeypatch.setattr("api.hyrax_routes._new_session",
                            lambda *, profile=None, project_id=None, **kw: (
                                new_session_count.__setitem__(0, new_session_count[0] + 1) or
                                _make_mock_session("evil_new", profile=profile, project_id=project_id)
                            ))

        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations", query="")
        handled = handle_hyrax_vn_post(handler, parsed, {"profile_id": "tai", "fresh": True})
        assert handled is True
        assert handler.status == 500
        assert new_session_count[0] == 0, "Must NOT create session when all_sessions fails for fresh"

    def test_fresh_archive_get_session_failure_aborts_with_500(self, monkeypatch):
        """When fresh=true and _get_session for current archive fails, abort with 500."""
        from api.hyrax_routes import handle_hyrax_vn_post

        new_session_count = [0]

        # _all_sessions returns a current active session for this sister
        monkeypatch.setattr("api.hyrax_routes._all_sessions", lambda: [{
            "session_id": "current_sid", "profile": "tai", "project_id": "hyrax-vn",
            "archived": False, "title": "Tai VN", "message_count": 1,
            "active_stream_id": None, "created_at": 100.0, "updated_at": 200.0,
        }])

        def _get_session_refuse(sid, **kw):
            raise RuntimeError("get_session exploded")

        monkeypatch.setattr("api.hyrax_routes._get_session", _get_session_refuse)

        monkeypatch.setattr("api.hyrax_routes._new_session",
                            lambda *, profile=None, project_id=None, **kw: (
                                new_session_count.__setitem__(0, new_session_count[0] + 1) or
                                _make_mock_session("evil_new", profile=profile, project_id=project_id)
                            ))

        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations", query="")
        handled = handle_hyrax_vn_post(handler, parsed, {"profile_id": "tai", "fresh": True})
        assert handled is True
        assert handler.status == 500
        assert new_session_count[0] == 0, (
            "Must NOT create session when _get_session fails during fresh"
        )

    def test_fresh_archive_save_failure_aborts_with_500(self, monkeypatch):
        """When fresh=true and save() of current session archive fails, abort with 500."""
        from api.hyrax_routes import handle_hyrax_vn_post

        new_session_count = [0]

        monkeypatch.setattr("api.hyrax_routes._all_sessions", lambda: [{
            "session_id": "current_sid", "profile": "tai", "project_id": "hyrax-vn",
            "archived": False, "title": "Tai VN", "message_count": 1,
            "active_stream_id": None, "created_at": 100.0, "updated_at": 200.0,
        }])

        current_session = _make_mock_session("current_sid")
        def _fail_save():
            raise RuntimeError("save failed")
        current_session.save = _fail_save
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: current_session)

        monkeypatch.setattr("api.hyrax_routes._new_session",
                            lambda *, profile=None, project_id=None, **kw: (
                                new_session_count.__setitem__(0, new_session_count[0] + 1) or
                                _make_mock_session("evil_new", profile=profile, project_id=project_id)
                            ))

        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations", query="")
        handled = handle_hyrax_vn_post(handler, parsed, {"profile_id": "tai", "fresh": True})
        assert handled is True
        assert handler.status == 500
        assert new_session_count[0] == 0, (
            "Must NOT create new session when save() fails during archive"
        )

    # ── Finding 1: archive save failure restores in-memory flag ─────

    def test_archive_save_failure_restores_in_memory_flag(self, monkeypatch):
        """When save() fails in _vn_archive_older_sessions, the in-memory object's
        archived flag must be restored to its prior value (False)."""
        from api.hyrax_routes import _vn_archive_older_sessions

        # Create a session object to archive
        session_to_archive = _make_mock_session("stale_sid", archived=False)
        prior_archived = session_to_archive.archived

        def _fail_save():
            raise RuntimeError("save failed")
        session_to_archive.save = _fail_save

        # _all_sessions returns one stale + one keep session
        monkeypatch.setattr("api.hyrax_routes._all_sessions", lambda: [
            {"session_id": "stale_sid", "profile": "tai", "project_id": "hyrax-vn",
             "archived": False, "title": "Tai VN", "message_count": 1,
             "active_stream_id": None, "created_at": 50.0, "updated_at": 100.0},
            {"session_id": "keep_sid", "profile": "tai", "project_id": "hyrax-vn",
             "archived": False, "title": "Tai VN", "message_count": 2,
             "active_stream_id": None, "created_at": 100.0, "updated_at": 200.0},
        ])

        def _get_session_lookup(sid, **kw):
            if sid == "keep_sid":
                return _make_mock_session("keep_sid")
            return session_to_archive

        monkeypatch.setattr("api.hyrax_routes._get_session", _get_session_lookup)

        with pytest.raises(RuntimeError, match="save failed"):
            _vn_archive_older_sessions("tai", keep_sid="keep_sid")

        # The in-memory flag must be restored to its prior value
        assert session_to_archive.archived == prior_archived, (
            f"Expected archived={prior_archived} after save failure, "
            f"got {session_to_archive.archived}"
        )


# ══════════════════════════════════════════════════════════════════════════
# Test: fresh=true archives ALL duplicate active sessions (Finding 2)
# ══════════════════════════════════════════════════════════════════════════

class TestVnFreshArchivesAllDuplicates:
    """Tests that fresh=true archives every active same-profile VN session."""

    def test_fresh_archives_all_duplicate_active_sessions(self, monkeypatch):
        """When fresh=true and 3 duplicate active VN sessions exist, all must be archived."""
        from api.hyrax_routes import handle_hyrax_vn_post

        archived_sessions = []

        # 3 active sessions for tai + 1 unrelated
        monkeypatch.setattr("api.hyrax_routes._all_sessions", lambda: [
            {"session_id": "active_1", "profile": "tai", "project_id": "hyrax-vn",
             "archived": False, "title": "Tai VN", "message_count": 1,
             "active_stream_id": None, "created_at": 100.0, "updated_at": 100.0},
            {"session_id": "active_2", "profile": "tai", "project_id": "hyrax-vn",
             "archived": False, "title": "Tai VN", "message_count": 2,
             "active_stream_id": None, "created_at": 200.0, "updated_at": 200.0},
            {"session_id": "active_3", "profile": "tai", "project_id": "hyrax-vn",
             "archived": False, "title": "Tai VN", "message_count": 3,
             "active_stream_id": None, "created_at": 300.0, "updated_at": 300.0},
            {"session_id": "other_pid", "profile": "rei", "project_id": "hyrax-vn",
             "archived": False, "title": "Rei VN", "message_count": 1,
             "active_stream_id": None, "created_at": 50.0, "updated_at": 50.0},
        ])

        # Track which sessions get their .archived set to True
        def _make_tracked_session(sid):
            s = _make_mock_session(sid, profile="tai", project_id="hyrax-vn")
            orig_save = s.save
            def _tracking_save():
                if s.archived:
                    archived_sessions.append(s.session_id)
                return orig_save()
            s.save = _tracking_save
            return s

        sessions_map = {
            "active_1": _make_tracked_session("active_1"),
            "active_2": _make_tracked_session("active_2"),
            "active_3": _make_tracked_session("active_3"),
            "other_pid": _make_mock_session("other_pid", profile="rei"),
        }

        monkeypatch.setattr("api.hyrax_routes._get_session",
                            lambda sid, **kw: sessions_map[sid])

        created_sessions = []
        def _fake_new_session(*, profile=None, project_id=None, **kw):
            import api.models as models
            s = models.Session(
                workspace="/tmp", model="test", model_provider="test",
                profile=profile, project_id=project_id,
            )
            s.title = f"{profile.title()} VN"
            created_sessions.append(s)
            return s

        monkeypatch.setattr("api.hyrax_routes._new_session", _fake_new_session)

        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations", query="")
        handled = handle_hyrax_vn_post(
            handler, parsed, {"profile_id": "tai", "fresh": True}
        )
        assert handled is True
        assert handler.status == 200
        # All 3 active sessions must be archived
        assert sorted(archived_sessions) == ["active_1", "active_2", "active_3"], (
            f"Expected 3 archived sessions, got {sorted(archived_sessions)}"
        )
        # Only 1 new session created
        assert len(created_sessions) == 1

    def test_fresh_duplicate_archive_save_failure_restores_flag(self, monkeypatch):
        """When fresh=true and archive save fails on a duplicate, the failing
        object's in-memory flag is restored and no new session is created."""
        from api.hyrax_routes import handle_hyrax_vn_post

        new_session_count = [0]

        # 3 active sessions — second one will fail on save
        monkeypatch.setattr("api.hyrax_routes._all_sessions", lambda: [
            {"session_id": "active_1", "profile": "tai", "project_id": "hyrax-vn",
             "archived": False, "title": "Tai VN", "message_count": 1,
             "active_stream_id": None, "created_at": 100.0, "updated_at": 100.0},
            {"session_id": "active_2", "profile": "tai", "project_id": "hyrax-vn",
             "archived": False, "title": "Tai VN", "message_count": 2,
             "active_stream_id": None, "created_at": 200.0, "updated_at": 200.0},
            {"session_id": "active_3", "profile": "tai", "project_id": "hyrax-vn",
             "archived": False, "title": "Tai VN", "message_count": 3,
             "active_stream_id": None, "created_at": 300.0, "updated_at": 300.0},
        ])

        sessions = {
            "active_1": _make_mock_session("active_1"),
            "active_2": _make_mock_session("active_2"),
            "active_3": _make_mock_session("active_3"),
        }

        # active_2 save will fail
        def _fail_save_active2():
            raise RuntimeError("save failed on active_2")
        sessions["active_2"].save = _fail_save_active2

        monkeypatch.setattr("api.hyrax_routes._get_session",
                            lambda sid, **kw: sessions[sid])

        monkeypatch.setattr("api.hyrax_routes._new_session",
                            lambda *, profile=None, project_id=None, **kw: (
                                new_session_count.__setitem__(0, new_session_count[0] + 1) or
                                _make_mock_session("evil_new", profile=profile, project_id=project_id)
                            ))

        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations", query="")
        handled = handle_hyrax_vn_post(
            handler, parsed, {"profile_id": "tai", "fresh": True}
        )
        assert handled is True
        assert handler.status == 500
        # active_1 and active_3 may have been archived (durable) but no new session
        assert new_session_count[0] == 0, "Must NOT create new session on archive failure"
        # active_2's in-memory flag must NOT be True
        assert sessions["active_2"].archived is False, (
            "active_2's in-memory archived flag must be restored after save failure"
        )


# ══════════════════════════════════════════════════════════════════════════
# Test: No mutable backing for VN_PROFILES (Finding 3)
# ══════════════════════════════════════════════════════════════════════════

class TestVnNoMutableBacking:
    """Tests that VN_PROFILES has no mutable module-level backing reference.

    The MappingProxyType allows VN_PROFILES to be immutable at the top level
    and at every nested level. However, the mutable structs _VN_PROFILES_WRAPPED
    and _VN_PROFILES_SOURCE that were used to BUILD the proxies must not be
    exposed at module scope, because mutating them changes the proxy.
    """

    def test_no_mutable_backing_globals_exposed(self):
        """Module must not expose _VN_PROFILES_WRAPPED or _VN_PROFILES_SOURCE."""
        import api.hyrax_routes as mod
        assert not hasattr(mod, "_VN_PROFILES_WRAPPED"), (
            "_VN_PROFILES_WRAPPED must not be a module-level global"
        )
        assert not hasattr(mod, "_VN_PROFILES_SOURCE"), (
            "_VN_PROFILES_SOURCE must not be a module-level global"
        )

    def test_no_mutable_backing_cannot_inject_profile(self, monkeypatch):
        """No module-level dict can be used to inject a new profile into VN_PROFILES."""
        from api.hyrax_routes import VN_PROFILES
        import api.hyrax_routes as mod
        # Scan module-level dicts for profile-shaped data — a dict whose values
        # are themselves dicts containing 'name' and 'assets' keys (sister metadata).
        # This should NOT match the lock dict which has threading.Lock values.
        found_profile_dict = False
        for attr_name in dir(mod):
            attr = getattr(mod, attr_name, None)
            if not isinstance(attr, dict):
                continue
            for val in attr.values():
                if isinstance(val, dict) and "name" in val and "assets" in val:
                    found_profile_dict = True
                    break
            if found_profile_dict:
                break
        assert not found_profile_dict, (
            "A mutable dict with sister profile metadata ('name' + 'assets') "
            "is still exposed at module level"
        )

    def test_no_mutable_backing_cannot_mutate_nested_assets(self):
        """Nested asset dicts inside VN_PROFILES cannot be mutated via any module-level ref."""
        from api.hyrax_routes import VN_PROFILES
        # The only authoritative source is VN_PROFILES itself
        assert "tai" in VN_PROFILES
        tai_assets = VN_PROFILES["tai"]["assets"]
        assert "/api/hyrax/assets/tai.portrait.neutral" in tai_assets.values()
        # Confirming the proxy is indeed immutable
        import pytest
        with pytest.raises(TypeError):
            VN_PROFILES["tai"]["assets"]["portrait"] = "/evil/path"


# ══════════════════════════════════════════════════════════════════════════
# Test: Bounded conversation archived is bool (Finding 4)
# ══════════════════════════════════════════════════════════════════════════

class TestVnBoundedConversationTypes:
    """Tests that _vn_bounded_conversation returns typed/correctly-bounded fields."""

    def test_archived_is_bool(self, monkeypatch):
        """The archived field in bounded conversation must be a bool, not raw value."""
        from api.hyrax_routes import _vn_bounded_conversation
        # Create a session with int archived value
        session = _make_mock_session("test_sid", archived=1)  # int, not bool
        result = _vn_bounded_conversation(session)
        assert isinstance(result.get("archived"), bool), (
            f"archived should be bool, got {type(result.get('archived'))}: {result.get('archived')!r}"
        )
        # With truthy non-bool values
        session2 = _make_mock_session("test_sid2", archived="stringy_true")
        result2 = _vn_bounded_conversation(session2)
        assert isinstance(result2.get("archived"), bool)

    def test_archived_is_bool_false_values(self, monkeypatch):
        """Even with falsy non-bool values, archived must be a bool."""
        from api.hyrax_routes import _vn_bounded_conversation
        session = _make_mock_session("test_sid", archived=None)
        result = _vn_bounded_conversation(session)
        assert isinstance(result.get("archived"), bool), (
            f"archived should be bool when None, got {type(result.get('archived'))}"
        )
        assert result["archived"] is False


# ══════════════════════════════════════════════════════════════════════════
# Test: Turn response type safety (Finding 4)
# ══════════════════════════════════════════════════════════════════════════

class TestVnTurnResponseTypes:
    """Tests that turn success response fields are properly typed and bounded."""

    def test_turn_response_bounded_stream_id(self, monkeypatch):
        """stream_id in turn response must be a string or None, never unbounded."""
        from api.hyrax_routes import handle_hyrax_vn_post

        def _fake_start_turn(sid, msg, *, source=None):
            return {"stream_id": "x" * 500, "pending": True, "_status": 200}

        monkeypatch.setattr("api.routes.start_session_turn", _fake_start_turn)

        session = _make_mock_session("vn_session_1")
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations/vn_session_1/turns", query="")
        handle_hyrax_vn_post(handler, parsed, {"text": "Hello"})
        assert handler.status == 200
        body = handler.json_body()
        sid = body.get("stream_id")
        assert sid is None or isinstance(sid, str)
        if isinstance(sid, str):
            assert len(sid) <= 64, f"stream_id too long: {len(sid)} chars"

    def test_turn_response_pending_is_bool(self, monkeypatch):
        """pending in turn success response must be a bool."""
        from api.hyrax_routes import handle_hyrax_vn_post

        def _fake_start_turn(sid, msg, *, source=None):
            return {"stream_id": None, "pending": 42, "_status": 200}

        monkeypatch.setattr("api.routes.start_session_turn", _fake_start_turn)

        session = _make_mock_session("vn_session_1")
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations/vn_session_1/turns", query="")
        handle_hyrax_vn_post(handler, parsed, {"text": "Hello"})
        assert handler.status == 200
        body = handler.json_body()
        assert isinstance(body.get("pending"), bool), (
            f"pending should be bool, got {type(body.get('pending'))}: {body.get('pending')!r}"
        )

    def test_turn_response_status_is_fixed_int(self, monkeypatch):
        """status in turn success response must be integer 200."""
        from api.hyrax_routes import handle_hyrax_vn_post

        def _fake_start_turn(sid, msg, *, source=None):
            return {"stream_id": None, "pending": False, "_status": 200}

        monkeypatch.setattr("api.routes.start_session_turn", _fake_start_turn)

        session = _make_mock_session("vn_session_1")
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations/vn_session_1/turns", query="")
        handle_hyrax_vn_post(handler, parsed, {"text": "Hello"})
        assert handler.status == 200
        body = handler.json_body()
        assert body.get("status") == 200
        assert isinstance(body["status"], int)

    def test_turn_non_dict_result_safe_500(self, monkeypatch):
        """Non-dict result from start_session_turn must return fixed 500."""
        from api.hyrax_routes import handle_hyrax_vn_post

        def _fake_start_turn(sid, msg, *, source=None):
            return "not a dict"

        monkeypatch.setattr("api.routes.start_session_turn", _fake_start_turn)

        session = _make_mock_session("vn_session_1")
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations/vn_session_1/turns", query="")
        handled = handle_hyrax_vn_post(handler, parsed, {"text": "Hello"})
        assert handled is True
        assert handler.status == 500
        body = handler.json_body()
        assert body["error"] == "internal error"


# ══════════════════════════════════════════════════════════════════════════
# Test: GET /api/hyrax/vn/conversations/{session_id} (events SSE alias)
# ══════════════════════════════════════════════════════════════════════════

class TestVnEventsSse:
    """Tests for GET /api/hyrax/vn/conversations/{session_id}/events."""

    def test_validates_before_sse_headers(self, monkeypatch):
        """VN ownership validated before SSE headers are sent."""
        from api.hyrax_routes import handle_hyrax_vn_get

        monkeypatch.setattr("api.hyrax_routes._get_session",
                            lambda sid, **kw: (_ for _ in ()).throw(KeyError(sid)))

        handler = _Handler()
        parsed = SimpleNamespace(
            path="/api/hyrax/vn/conversations/nonexistent/events", query=""
        )
        handled = handle_hyrax_vn_get(handler, parsed)
        assert handled is True
        assert handler.status == 404
        # Should NOT have SSE Content-Type header
        content_types = [v for k, v in handler.sent_headers if k.lower() == "content-type"]
        assert all("text/event-stream" not in ct for ct in content_types)

    def test_delegates_to_native_sse_handler(self, monkeypatch):
        """Delegates once to native SSE handler with cursor intact."""
        from api.hyrax_routes import handle_hyrax_vn_get

        call_count = [0]

        def _fake_sse_handler(handler, parsed, session_id):
            call_count[0] += 1
            return True

        monkeypatch.setattr(
            "api.routes._handle_session_sse_stream_for_session",
            _fake_sse_handler,
        )

        session = _make_mock_session("vn_session_1")
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        handler = _Handler()
        parsed = SimpleNamespace(
            path="/api/hyrax/vn/conversations/vn_session_1/events", query=""
        )
        handled = handle_hyrax_vn_get(handler, parsed)
        assert handled is True
        assert call_count[0] == 1

    def test_preserves_query_cursor(self, monkeypatch):
        """Last-Event-ID / query cursor is forwarded to native handler."""
        from api.hyrax_routes import handle_hyrax_vn_get

        forwarded_parsed = [None]

        def _fake_sse_handler(handler, parsed, session_id):
            forwarded_parsed[0] = parsed
            return True

        monkeypatch.setattr(
            "api.routes._handle_session_sse_stream_for_session",
            _fake_sse_handler,
        )

        session = _make_mock_session("vn_session_1")
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        handler = _Handler()
        parsed = SimpleNamespace(
            path="/api/hyrax/vn/conversations/vn_session_1/events",
            query="after_event_id=run_1:5",
        )
        handled = handle_hyrax_vn_get(handler, parsed)
        assert handled is True
        assert forwarded_parsed[0] is parsed


# ══════════════════════════════════════════════════════════════════════════
# Test: Explicit GET/POST dispatch via handle_get / handle_post
# ══════════════════════════════════════════════════════════════════════════

class TestVnExplicitDispatch:
    """Tests for explicit /api/hyrax/vn/* dispatch from routes.handle_get/handle_post."""

    def test_get_dispatch_routes_to_vn_handler(self):
        """routes.handle_get dispatches /api/hyrax/vn/* to VN handler."""
        import api.routes as core_routes

        handler = _Handler()
        result = core_routes.handle_get(
            handler, SimpleNamespace(path="/api/hyrax/vn/profiles", query="")
        )
        assert result is True
        assert handler.status in (200, 404)

    def test_post_dispatch_routes_to_vn_handler(self):
        """routes.handle_post dispatches /api/hyrax/vn/* to VN handler."""
        import api.routes as core_routes

        handler = _Handler(command="POST")
        result = core_routes.handle_post(
            handler, SimpleNamespace(path="/api/hyrax/vn/conversations", query="")
        )
        assert result is True
        assert handler.status in (200, 400, 404)

    def test_unknown_vn_path_returns_404(self):
        """Unknown /api/hyrax/vn/* path returns sanitized 404."""
        import api.routes as core_routes

        handler = _Handler()
        result = core_routes.handle_get(
            handler, SimpleNamespace(path="/api/hyrax/vn/nonexistent", query="")
        )
        assert result is True
        assert handler.status == 404

    def test_ordinary_hyrax_get_still_works(self):
        """Ordinary /api/hyrax/* GET routes are unaffected by VN dispatch."""
        import api.routes as core_routes

        handler = _Handler()
        result = core_routes.handle_get(
            handler, SimpleNamespace(path="/api/hyrax/projects", query="")
        )
        assert result is True
        assert handler.status == 200

    def test_asset_route_still_works(self):
        """The /api/hyrax/assets/* route still works through dispatch."""
        import api.routes as core_routes

        handler = _Handler()
        result = core_routes.handle_get(
            handler, SimpleNamespace(path="/api/hyrax/assets/tai.embodiment.vrm", query="")
        )
        assert result is True

    def test_import_hyrax_routes_no_mutation(self):
        """Importing hyrax_routes does not mutate routes.handle_get or handle_post."""
        import importlib

        from api import routes as core_routes
        import api.hyrax_routes as hyrax_mod

        get_before = core_routes.handle_get
        post_before = core_routes.handle_post
        importlib.reload(hyrax_mod)
        get_after = core_routes.handle_get
        post_after = core_routes.handle_post

        assert get_before is get_after
        assert post_before is post_after


# ══════════════════════════════════════════════════════════════════════════
# Test: Transcript total bounds (Finding 7)
# ══════════════════════════════════════════════════════════════════════════

class TestVnTranscriptTotalBounds:
    """Tests for total transcript row bounds and adversarial fixtures.

    Contract change (Gestalt VN revamp): the fixed 50-row cap was replaced by
    bounded paging — default page DEFAULT_TRANSCRIPT_ROWS (200), hard cap
    MAX_TRANSCRIPT_ROWS (400) via ?limit=, plus has_more/total fields. The
    module-level MAX_TRANSCRIPT_ROWS is now the hard cap, not the page size.
    """

    MAX_TRANSCRIPT_ROWS = 400  # mirrors api.hyrax_routes.MAX_TRANSCRIPT_ROWS (hard cap)

    def test_has_max_transcript_rows_constant(self):
        """Module must define MAX_TRANSCRIPT_ROWS."""
        from api.hyrax_routes import MAX_TRANSCRIPT_ROWS
        assert isinstance(MAX_TRANSCRIPT_ROWS, int)
        assert MAX_TRANSCRIPT_ROWS > 0

    def test_transcript_capped_at_max_rows(self, monkeypatch):
        """Transcript must not exceed MAX_TRANSCRIPT_ROWS rows.

        Updated for paging: request the hard cap explicitly (?limit=400) with
        3x that many rows; the page must be exactly the hard cap.
        """
        from api.hyrax_routes import MAX_TRANSCRIPT_ROWS, handle_hyrax_vn_get
        many_messages = []
        for i in range(MAX_TRANSCRIPT_ROWS * 3):
            many_messages.append({"role": "user" if i % 2 == 0 else "assistant",
                                  "content": f"msg_{i}"})
        session = _make_mock_session("big_session", messages=many_messages)
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        handler = _Handler()
        parsed = SimpleNamespace(
            path="/api/hyrax/vn/conversations/big_session",
            query=f"limit={MAX_TRANSCRIPT_ROWS}",
        )
        handle_hyrax_vn_get(handler, parsed)
        body = handler.json_body()
        conv = body.get("conversation", body)
        transcript = conv.get("messages", [])
        assert len(transcript) <= MAX_TRANSCRIPT_ROWS, (
            f"Transcript has {len(transcript)} rows, expected ≤ {MAX_TRANSCRIPT_ROWS}"
        )
        assert len(transcript) == MAX_TRANSCRIPT_ROWS
        assert conv.get("has_more") is True

    def test_transcript_includes_last_n_rows(self, monkeypatch):
        """Transcript must include the last bounded user/assistant rows.

        Updated for paging: with limit=MAX_TRANSCRIPT_ROWS and MAX+10 rows,
        the window starts at row index 10.
        """
        from api.hyrax_routes import MAX_TRANSCRIPT_ROWS, handle_hyrax_vn_get
        many_messages = []
        for i in range(MAX_TRANSCRIPT_ROWS + 10):
            many_messages.append({"role": "user" if i % 2 == 0 else "assistant",
                                  "content": f"msg_{i}"})
        session = _make_mock_session("big_session", messages=many_messages)
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        handler = _Handler()
        parsed = SimpleNamespace(
            path="/api/hyrax/vn/conversations/big_session",
            query=f"limit={MAX_TRANSCRIPT_ROWS}",
        )
        handle_hyrax_vn_get(handler, parsed)
        body = handler.json_body()
        conv = body.get("conversation", body)
        transcript = conv.get("messages", [])
        # Should contain the last MAX_TRANSCRIPT_ROWS user/assistant messages
        expected_start_idx = (MAX_TRANSCRIPT_ROWS + 10) - MAX_TRANSCRIPT_ROWS
        expected_content_start = f"msg_{expected_start_idx}"
        transcript_contents = [m["content"] for m in transcript]
        assert expected_content_start in transcript_contents, (
            f"Expected content '{expected_content_start}' not in last rows"
        )

    def test_non_string_content_dropped(self, monkeypatch):
        """Non-string content must not be reflected; should be empty text or row dropped."""
        from api.hyrax_routes import handle_hyrax_vn_get
        session = _make_mock_session("bad_content", messages=[
            {"role": "user", "content": {"secret": "leak"}},
            {"role": "assistant", "content": ["tool", "data"]},
        ])
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations/bad_content", query="")
        handle_hyrax_vn_get(handler, parsed)
        body = handler.json_body()
        body_text = handler.body_text()
        # Must not contain the structured object/tool data
        assert "secret" not in body_text
        assert "tool" not in body_text
        conv = body.get("conversation", body)
        transcript = conv.get("messages", [])
        for m in transcript:
            if m.get("role") in ("user", "assistant"):
                assert isinstance(m.get("content"), str)
                # Content should either be empty string or not contain structured data

    def test_bounded_message_id_is_string_bounded(self, monkeypatch):
        """Message IDs must be strings, bounded to safe length."""
        from api.hyrax_routes import handle_hyrax_vn_get
        MAX_ID_LENGTH = 64  # expected conservative constant
        overlong_id = "x" * (MAX_ID_LENGTH + 50)
        session = _make_mock_session("sid1", messages=[
            {"role": "user", "content": "hello", "id": overlong_id},
            {"role": "assistant", "content": "hi", "id": {"bad": "type"}},
        ])
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations/sid1", query="")
        handle_hyrax_vn_get(handler, parsed)
        body = handler.json_body()
        body_text = handler.body_text()
        # Must not have non-string id values in output
        assert "\"bad\"" not in body_text or '"type"' not in body_text
        conv = body.get("conversation", body)
        for m in conv.get("messages", []):
            if "id" in m:
                assert isinstance(m["id"], str)
                assert len(m["id"]) <= MAX_ID_LENGTH

    def test_session_id_and_title_bounded(self, monkeypatch):
        """session_id, title, active_stream_id bounded and type-sanitized."""
        from api.hyrax_routes import handle_hyrax_vn_get
        MAX_ID_LENGTH = 64
        huge_id = "s" * (MAX_ID_LENGTH + 100)
        huge_title = "T" * 500
        session = _make_mock_session(huge_id, title=huge_title,
                                     active_stream_id={"not": "a-string"})
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations/" + huge_id, query="")
        handle_hyrax_vn_get(handler, parsed)
        body = handler.json_body()
        conv = body.get("conversation", body)
        assert isinstance(conv.get("session_id"), str)
        assert len(conv["session_id"]) <= MAX_ID_LENGTH
        assert isinstance(conv.get("title"), str)
        assert len(conv["title"]) <= 256  # max title length
        # active_stream_id should be None if non-string
        assert conv.get("active_stream_id") is None or isinstance(conv["active_stream_id"], str)

    def test_nan_inf_timestamps_sanitized(self, monkeypatch):
        """NaN and Inf timestamps must be sanitized to finite int/float or zero."""
        import math
        from api.hyrax_routes import handle_hyrax_vn_get
        session = _make_mock_session("ts_sid",
                                     created_at=float("nan"),
                                     updated_at=float("inf"))
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations/ts_sid", query="")
        handle_hyrax_vn_get(handler, parsed)
        body = handler.json_body()
        conv = body.get("conversation", body)
        # JSON serialization must not crash on NaN/Inf
        # The values should be finite or zero
        import json as _json
        re_encoded = _json.dumps(conv)
        assert "NaN" not in re_encoded, "NaN timestamp leaked"
        assert "Infinity" not in re_encoded, "Infinity timestamp leaked"
        # created_at and updated_at should be finite (0.0)
        assert conv["created_at"] == 0.0, f"Expected 0.0 for NaN, got {conv['created_at']}"
        assert conv["updated_at"] == 0.0, f"Expected 0.0 for Inf, got {conv['updated_at']}"

    def test_adversarial_transcript_fixture(self, monkeypatch):
        """Adversarial fixture: 1000 rows, huge fields, non-string content, tool-shaped values."""
        from api.hyrax_routes import MAX_TRANSCRIPT_ROWS, handle_hyrax_vn_get
        many = []
        for i in range(1000):
            many.append({
                "role": "user" if i % 2 == 0 else "assistant",
                "content": ("<tool>secret_data</tool>" if i == 500
                            else {"path": "/etc/shadow"} if i == 501
                            else "x" * 200_000 if i == 502
                            else f"msg_{i}"),
                "id": "i" * 200 if i == 300 else f"id_{i}",
                "name": "n" * 500 if i == 400 else None,
            })
        session = _make_mock_session("adv_session",
                                     title="A" * 1000,
                                     messages=many,
                                     created_at=float("nan"),
                                     updated_at=float("inf"))
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations/adv_session", query="")
        handle_hyrax_vn_get(handler, parsed)
        body = handler.json_body()
        conv = body.get("conversation", body)
        transcript = conv.get("messages", [])
        # Bounded row count
        assert len(transcript) <= MAX_TRANSCRIPT_ROWS
        # All content strings are strings
        for m in transcript:
            assert isinstance(m.get("content"), str), f"Non-string content: {m.get('content')!r}"
            if "id" in m:
                assert isinstance(m["id"], str)
        # No tool-shaped values or secret paths leaked
        body_text = handler.body_text()
        assert "secret_data" not in body_text, "Tool data leaked"
        assert "/etc/shadow" not in body_text, "Path leaked"
        # Timestamps are finite
        import json as _json
        re_encoded = _json.dumps(conv)
        assert "NaN" not in re_encoded
        assert "Infinity" not in re_encoded


# ══════════════════════════════════════════════════════════════════════════
# Test: request_profile_context TLS (Finding 8)
# ══════════════════════════════════════════════════════════════════════════

class TestRequestProfileContext:
    """Tests for request_profile_context(name) in api.profiles."""

    def test_context_manager_rejects_invalid_name(self):
        """Rejects invalid profile names."""
        from api.profiles import request_profile_context
        with pytest.raises(ValueError):
            with request_profile_context("../../etc/passwd"):
                pass

    def test_restores_prior_value_on_success(self):
        """Restores the exact prior profile value after the context exits."""
        from api.profiles import (
            get_active_profile_name,
            request_profile_context,
        )

        prior = get_active_profile_name()
        with request_profile_context("tai"):
            inner = get_active_profile_name()
        after = get_active_profile_name()
        assert after == prior

    def test_restores_prior_value_on_exception(self):
        """Restores the exact prior profile value even when an exception occurs."""
        from api.profiles import (
            get_active_profile_name,
            request_profile_context,
        )

        prior = get_active_profile_name()
        try:
            with request_profile_context("tai"):
                raise ValueError("boom")
        except ValueError:
            pass
        after = get_active_profile_name()
        assert after == prior

    def test_never_mutates_process_global(self):
        """Must not mutate _active_profile or os.environ."""
        from api.profiles import (
            _active_profile as _mod_active_profile,
            request_profile_context,
        )
        import os

        prior_profile = _mod_active_profile
        prior_env = os.environ.get("HERMES_HOME")

        with request_profile_context("tai"):
            pass

        assert _mod_active_profile is prior_profile
        assert os.environ.get("HERMES_HOME") == prior_env

    # ── Finding 8: TLS restoration when attribute was absent ─────────

    def test_tls_restores_none_when_was_absent(self):
        """When _tls had no 'profile' attr before entry, restore None on exit."""
        from api.profiles import request_profile_context, _tls
        # Remove the 'profile' attribute if it exists
        if hasattr(_tls, 'profile'):
            delattr(_tls, 'profile')
        assert not hasattr(_tls, 'profile')
        with request_profile_context("tai"):
            assert _tls.profile == "tai"
        # After exit, profile should NOT exist as an attribute
        assert not hasattr(_tls, 'profile'), (
            "Profile attribute should be removed when it didn't exist before"
        )

    def test_tls_restores_none_when_was_absent_on_exception(self):
        """When _tls had no 'profile' attr before entry, still remove on exception."""
        from api.profiles import request_profile_context, _tls
        if hasattr(_tls, 'profile'):
            delattr(_tls, 'profile')
        assert not hasattr(_tls, 'profile')
        try:
            with request_profile_context("tai"):
                raise ValueError("test error")
        except ValueError:
            pass
        assert not hasattr(_tls, 'profile'), (
            "Profile attribute should not exist after exception when it didn't before"
        )

    def test_tls_restores_prior_on_nesting(self):
        """Nested request_profile_context must restore the outer value, not None."""
        from api.profiles import request_profile_context, _tls
        # Set outer context
        _tls.profile = "outer"
        with request_profile_context("inner"):
            assert _tls.profile == "inner"
        assert _tls.profile == "outer", (
            f"Expected 'outer', got {_tls.profile!r}"
        )

    def test_tls_delattr_on_exit_works_when_absent_before(self):
        """If 'profile' was absent before entry, delattr(_tls, 'profile') on exit."""
        from api.profiles import request_profile_context, _tls
        if hasattr(_tls, 'profile'):
            delattr(_tls, 'profile')
        with request_profile_context("tai"):
            pass
        # After clean exit, hasattr should be False
        assert not hasattr(_tls, 'profile'), "delattr must have removed profile attr"


# ── Finding 9: Conversation creation bound to profile context ──────

class TestVnConversationProfileContext:
    """Tests that conversation creation is bound to request_profile_context."""

    def test_creation_enters_profile_context(self, monkeypatch):
        """During conversation creation, the code must enter request_profile_context(pid)."""
        from api.hyrax_routes import handle_hyrax_vn_post
        import api.profiles as profiles_mod

        entered_context = [None]

        original_rpc = profiles_mod.request_profile_context

        def tracking_rpc(name):
            entered_context[0] = name
            return original_rpc(name)

        monkeypatch.setattr(profiles_mod, "request_profile_context", tracking_rpc)

        # Mock all_sessions to return empty (no existing → create path)
        monkeypatch.setattr("api.hyrax_routes._all_sessions", lambda: [])
        monkeypatch.setattr("api.hyrax_routes._get_session",
                            lambda sid, **kw: (_ for _ in ()).throw(KeyError(sid)))
        monkeypatch.setattr("api.hyrax_routes._new_session",
                            lambda *, profile=None, project_id=None, **kw:
                                _make_mock_session("new_sid", profile=profile, project_id=project_id))

        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations", query="")
        handle_hyrax_vn_post(handler, parsed, {"profile_id": "tai"})
        assert entered_context[0] == "tai", (
            f"Expected request_profile_context('tai'), got {entered_context[0]!r}"
        )


# ── Finding 10: Save title persistence ──────────────────────────

class TestVnTitlePersistence:
    """Tests that new conversation title is explicitly persisted."""

    def test_session_saved_after_title_assigned(self, monkeypatch):
        """After setting a friendly title, session.save() must be called."""
        from api.hyrax_routes import handle_hyrax_vn_post

        save_called = [False]
        created_session = _make_mock_session("new_sid", profile="tai", project_id="hyrax-vn")

        def _tracking_save():
            save_called[0] = True
        created_session.save = _tracking_save

        monkeypatch.setattr("api.hyrax_routes._all_sessions", lambda: [])
        monkeypatch.setattr("api.hyrax_routes._get_session",
                            lambda sid, **kw: (_ for _ in ()).throw(KeyError(sid)))

        monkeypatch.setattr("api.hyrax_routes._new_session",
                            lambda *, profile=None, project_id=None, **kw: created_session)

        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations", query="")
        handled = handle_hyrax_vn_post(handler, parsed, {"profile_id": "tai"})
        assert handled is True
        assert handler.status == 200
        assert save_called[0], (
            "session.save() must be called after setting the title"
        )

    def test_title_save_failure_returns_500(self, monkeypatch):
        """When save() fails after title assignment, must return fixed 500."""
        from api.hyrax_routes import handle_hyrax_vn_post

        created_session = _make_mock_session("new_sid", profile="tai", project_id="hyrax-vn")

        def _fail_save():
            raise RuntimeError("Could not persist session")

        created_session.save = _fail_save

        monkeypatch.setattr("api.hyrax_routes._all_sessions", lambda: [])
        monkeypatch.setattr("api.hyrax_routes._get_session",
                            lambda sid, **kw: (_ for _ in ()).throw(KeyError(sid)))
        monkeypatch.setattr("api.hyrax_routes._new_session",
                            lambda *, profile=None, project_id=None, **kw: created_session)

        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations", query="")
        handled = handle_hyrax_vn_post(handler, parsed, {"profile_id": "tai"})
        assert handled is True
        assert handler.status == 500
        body = handler.json_body()
        assert body["error"] == "failed to create session"


# ── Finding 11: Asset URLs ──────────────────────────────────────

class TestVnAssetUrls:
    """Tests that profile asset metadata uses /api/hyrax/assets/<dotted-id> URLs."""

    _EXPECTED: dict[str, dict[str, str]] = {
        "tai": {
            "portrait": "/api/hyrax/assets/tai.portrait.neutral",
            "background": "/api/hyrax/assets/tai.background.control-room",
            "chibi": "/api/hyrax/assets/tai.chibi.stand",
            "model": "/api/hyrax/assets/tai.embodiment.vrm",
        },
        "rei": {
            "portrait": "/api/hyrax/assets/rei.portrait.neutral",
            "background": "/api/hyrax/assets/rei.background.security",
            "chibi": "/api/hyrax/assets/rei.chibi.stand",
        },
        "nei": {
            "portrait": "/api/hyrax/assets/nei.portrait.neutral",
            "background": "/api/hyrax/assets/nei.background.lab",
            "chibi": "/api/hyrax/assets/nei.chibi.stand",
        },
        "mai": {
            "portrait": "/api/hyrax/assets/mai.portrait.neutral",
            "background": "/api/hyrax/assets/mai.background.supply-hub",
            "chibi": "/api/hyrax/assets/mai.chibi.stand",
        },
    }

    def test_asset_urls_use_api_path_no_vn_segment(self):
        """Asset URLs use /api/hyrax/assets/<dotted-id>, not /static/ or /vn/."""
        from api.hyrax_routes import VN_PROFILES
        for pid, meta in VN_PROFILES.items():
            assets = meta["assets"]
            expected = self._EXPECTED[pid]
            assert set(assets.keys()) == set(expected.keys()), (
                f"{pid} asset keys mismatch: {set(assets.keys())} vs {set(expected.keys())}"
            )
            for asset_key, expected_url in expected.items():
                actual_url = assets[asset_key]
                assert actual_url == expected_url, (
                    f"{pid}.assets.{asset_key} expected {expected_url!r}, got {actual_url!r}"
                )
                assert not actual_url.startswith("/api/hyrax/assets/vn/"), (
                    f"{pid}.assets.{asset_key} should NOT use /vn/ segment"
                )
                assert not actual_url.startswith("/static/"), (
                    f"{pid}.assets.{asset_key} should NOT use /static/ path"
                )

    def test_asset_ids_have_no_path_separators(self):
        """Every logical asset ID is a single path segment (no / in the ID)."""
        from api.hyrax_routes import VN_PROFILES
        for pid, meta in VN_PROFILES.items():
            for asset_key, url in meta["assets"].items():
                logical_id = url.rsplit("/", 1)[-1]
                assert "/" not in logical_id, (
                    f"{pid}.assets.{asset_key} logical ID {logical_id!r} must not contain /"
                )

    def test_all_sisters_have_minimum_assets(self):
        """Every sister has at least portrait, background, and chibi (model is tai-only)."""
        from api.hyrax_routes import VN_PROFILES
        for pid, meta in VN_PROFILES.items():
            assets = meta["assets"]
            for required in ("portrait", "background", "chibi"):
                assert required in assets, (
                    f"{pid} missing required asset key {required!r}"
                )
            # Only tai has a model asset
            if pid == "tai":
                assert "model" in assets, "tai should have a model asset"
            else:
                assert "model" not in assets, (
                    f"{pid} should not have a model asset"
                )


# ══════════════════════════════════════════════════════════════════════════
# Test: Anti-confused-deputy check
# ══════════════════════════════════════════════════════════════════════════

class TestAntiConfusedDeputy:
    """Tests for cross-profile VN alias protection."""

    def test_non_sister_profile_cannot_use_vn_alias(self, monkeypatch):
        """Only fixed sister VN sessions may use cross-profile VN alias."""
        from api.hyrax_routes import handle_hyrax_vn_get

        session = _make_mock_session("session_1", profile="default")
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)

        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations/session_1", query="")
        handled = handle_hyrax_vn_get(handler, parsed)
        assert handled is True
        assert handler.status == 404


# ══════════════════════════════════════════════════════════════════════════
# Test: Ordinary native visibility unchanged
# ══════════════════════════════════════════════════════════════════════════

class TestNativeVisibility:
    """Tests that ordinary native session visibility is unchanged by VN routes."""

    def test_native_get_session_path_still_dispatched(self):
        """A native session path is still dispatched (not False = handled)."""
        import api.routes as core_routes

        handler = _Handler()
        # /manifest.json is a known core route — if it's missing, the test
        # still checks that dispatch doesn't return False for Hyrax paths
        result = core_routes.handle_get(
            handler, SimpleNamespace(path="/api/hyrax/projects", query="")
        )
        assert result is True
        assert handler.status == 200

    def test_native_non_hyrax_path_not_falsely_handled(self):
        """A non-hyrax path is NOT handled by hyrax dispatch (passes through)."""
        import api.routes as core_routes

        handler = _Handler()
        # This is an unknown path — handle_get returns False or handles it
        # The key is that hyrax dispatch doesn't interfere
        handler2 = _Handler()
        result = core_routes.handle_get(
            handler2, SimpleNamespace(path="/api/v1/nonexistent", query="")
        )
        # Should be False (pass-through from hyrax dispatch)
        assert result is False or handler2.status in (200, 404)


# ══════════════════════════════════════════════════════════════════════════
# Test: auth/CSRF rejection before VN mutation
# ══════════════════════════════════════════════════════════════════════════

class TestAuthAndCsrf:
    """Tests that auth and CSRF apply before VN route processing."""

    def test_noauth_vn_post_rejected(self, monkeypatch):
        """Unauthenticated POST to VN routes is rejected by outer auth."""
        import api.auth as auth_mod
        monkeypatch.setattr(auth_mod, "is_password_auth_enabled", lambda: True)
        monkeypatch.setattr(auth_mod, "are_passkeys_enabled", lambda: False)
        monkeypatch.setattr(auth_mod, "is_oidc_auth_enabled", lambda: False)
        monkeypatch.setattr(auth_mod, "is_trusted_auth_enabled", lambda: False)

        handler = _Handler(path="/api/hyrax/vn/conversations", command="POST")
        parsed = SimpleNamespace(path="/api/hyrax/vn/conversations", query="")
        result = auth_mod.check_auth(handler, parsed)
        assert result is False
        assert handler.status == 401


# ══════════════════════════════════════════════════════════════════════════
# Test: server-side expression derivation (stopgap until Essence pipeline)
# ══════════════════════════════════════════════════════════════════════════

class TestVnDeriveExpression:
    """_vn_derive_expression maps the latest assistant reply to a mood."""

    def test_no_assistant_row_returns_none(self):
        from api.hyrax_routes import _vn_derive_expression
        assert _vn_derive_expression([]) is None
        assert _vn_derive_expression([{"role": "user", "content": "haha lol"}]) is None

    def test_latest_assistant_row_wins(self):
        from api.hyrax_routes import _vn_derive_expression
        transcript = [
            {"role": "assistant", "content": "haha that is funny"},
            {"role": "user", "content": "right?"},
            {"role": "assistant", "content": "thank you, glad to help"},
        ]
        # Only the LATEST assistant row is read: "glad" → happy. The older
        # "haha" row must not leak through as laughing.
        assert _vn_derive_expression(transcript) == "happy"

    def test_laughing_signal(self):
        from api.hyrax_routes import _vn_derive_expression
        assert _vn_derive_expression([{"role": "assistant", "content": "Haha, good one!"}]) == "laughing"

    def test_no_signal_returns_none(self):
        from api.hyrax_routes import _vn_derive_expression
        assert _vn_derive_expression([{"role": "assistant", "content": "pong"}]) is None

    def test_non_string_content_ignored(self):
        from api.hyrax_routes import _vn_derive_expression
        assert _vn_derive_expression([{"role": "assistant", "content": ["haha"]}]) is None


# ══════════════════════════════════════════════════════════════════════════
# Test: expression demotion (Phase B) — derived presentation beats keywords
# ══════════════════════════════════════════════════════════════════════════

class TestVnExpressionDemotion:
    """_vn_bounded_conversation expression precedence (ESSENCE_ACTIVE_RUNTIME
    Phase B): fresh essenced derived presentation.expression wins; the keyword
    stopgap (_vn_derive_expression) is the fallback for missing/stale derived
    state; a session-carried expression still outranks both."""

    def _write_derived(self, home, expression="smile", intensity=0.7,
                       age_seconds: float = 0.0):
        import json as _json
        import os as _os
        import time as _time

        def leaf(value):
            return {"value": value, "provenance": "derived",
                    "updatedAt": "2026-07-26T00:00:00+00:00"}

        payload = {
            "version": 2,
            "operatorId": "tai",
            "mood": {"primary": leaf("happy")},
            "condition": {"energy": leaf(0.6)},
            "activity": {"type": leaf("idle")},
            "presentation": {"expression": leaf(expression),
                             "intensity": leaf(intensity),
                             "poseIntent": leaf("standing"),
                             "sceneIntent": leaf("ops")},
        }
        path = home / "essence" / "derived_state.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(_json.dumps(payload))
        if age_seconds:
            old = _time.time() - age_seconds
            _os.utime(path, (old, old))
        return path

    def _fixture_home(self, tmp_path, monkeypatch, *, age_seconds: float = 0.0):
        """Point api.hyrax_essence._profile_home at a tmp home with derived
        state (fresh unless age_seconds given). Hermetic: never reads the
        real on-disk derived_state.json."""
        import api.hyrax_essence as essence

        home = tmp_path / "tai"
        self._write_derived(home, age_seconds=age_seconds)
        monkeypatch.setattr(essence, "_profile_home", lambda op: tmp_path / op)
        return home

    _KEYWORD_TRANSCRIPT = [
        {"role": "user", "content": "tell me a joke"},
        {"role": "assistant", "content": "Haha, good one!"},
    ]

    def test_fresh_derived_beats_keyword(self, tmp_path, monkeypatch):
        from api.hyrax_routes import _vn_bounded_conversation

        self._fixture_home(tmp_path, monkeypatch)
        session = _make_mock_session("vn_demote_1",
                                     messages=self._KEYWORD_TRANSCRIPT)
        result = _vn_bounded_conversation(session)
        # Derived "smile" wins over the keyword "laughing".
        assert result["expression"] == {"current": "smile", "intensity": 0.7}

    def test_stale_derived_falls_back_to_keyword(self, tmp_path, monkeypatch):
        from api.hyrax_routes import _vn_bounded_conversation

        self._fixture_home(tmp_path, monkeypatch, age_seconds=90000)
        session = _make_mock_session("vn_demote_2",
                                     messages=self._KEYWORD_TRANSCRIPT)
        result = _vn_bounded_conversation(session)
        assert result["expression"] == {"current": "laughing"}

    def test_missing_derived_falls_back_to_keyword(self, tmp_path, monkeypatch):
        import api.hyrax_essence as essence
        from api.hyrax_routes import _vn_bounded_conversation

        # Home exists but no derived_state.json.
        (tmp_path / "tai" / "essence").mkdir(parents=True)
        monkeypatch.setattr(essence, "_profile_home", lambda op: tmp_path / op)
        session = _make_mock_session("vn_demote_3",
                                     messages=self._KEYWORD_TRANSCRIPT)
        result = _vn_bounded_conversation(session)
        assert result["expression"] == {"current": "laughing"}

    def test_session_carried_expression_outranks_derived(
            self, tmp_path, monkeypatch):
        from api.hyrax_routes import _vn_bounded_conversation

        self._fixture_home(tmp_path, monkeypatch)
        session = _make_mock_session("vn_demote_4",
                                     messages=self._KEYWORD_TRANSCRIPT)
        session.expression = {"current": "focused", "intensity": 0.9}
        result = _vn_bounded_conversation(session)
        assert result["expression"] == {"current": "focused", "intensity": 0.9}

    def test_derived_read_failure_fails_closed_to_keyword(
            self, tmp_path, monkeypatch):
        import api.hyrax_essence as essence
        from api.hyrax_routes import _vn_bounded_conversation

        def _boom(op):
            raise RuntimeError("profile resolution exploded")

        monkeypatch.setattr(essence, "_profile_home", _boom)
        session = _make_mock_session("vn_demote_5",
                                     messages=self._KEYWORD_TRANSCRIPT)
        result = _vn_bounded_conversation(session)
        assert result["expression"] == {"current": "laughing"}
