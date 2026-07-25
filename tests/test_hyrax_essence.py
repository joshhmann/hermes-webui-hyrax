"""
Tests for the Essence runtime server half (api/hyrax_essence.py) and the
Gestalt VN revamp additions to api/hyrax_routes.py (transcript paging,
turn attachments, turn text-cap payload).

RULES (match tests/test_hyrax_vn_routes.py):
- Use fake handlers/mocks; do not start a real agent turn in unit tests.
- No import-time mutation.
- Hermetic: all file reads are fixtured (tmp_path profile dirs, tmp registry);
  no dependency on real profile state on disk.
"""

from __future__ import annotations

import hashlib
import io
import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

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
    monkeypatch.setattr(auth, "STATE_DIR", "/tmp/__test_hyrax_essence_auth")
    monkeypatch.setattr(auth, "_SESSIONS_FILE", "/tmp/__test_hyrax_essence_auth/.sessions.json")
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
def profile_home(tmp_path, monkeypatch):
    """Fixture a sister profile home and point _profile_home at it."""
    import api.hyrax_essence as essence

    def _make(operator: str, state: dict | None, affinity: dict | None = None):
        home = tmp_path / operator
        (home / "essence").mkdir(parents=True, exist_ok=True)
        if state is not None:
            (home / "essence" / "state.json").write_text(json.dumps(state))
        if affinity is not None:
            (home / "affinity.json").write_text(json.dumps(affinity))
        return home

    homes: dict[str, object] = {}

    def _resolve(operator: str):
        return homes.get(operator) or (tmp_path / operator)

    monkeypatch.setattr(essence, "_profile_home", _resolve)

    def _register(operator: str, state: dict | None, affinity: dict | None = None):
        home = _make(operator, state, affinity)
        homes[operator] = home
        return home

    return _register


@pytest.fixture
def frames_drop_dir(tmp_path, monkeypatch):
    """Fixture the frame drop dir + registry path into tmp_path."""
    import api.hyrax_essence as essence

    frames_dir = tmp_path / "essence" / "frames"
    frames_dir.mkdir(parents=True)
    registry = tmp_path / "essence" / "frames.registry.json"
    monkeypatch.setattr(essence, "ESSENCE_FRAMES_DIR", frames_dir)
    monkeypatch.setattr(essence, "FRAME_REGISTRY_FILE", registry)
    return frames_dir, registry


def _make_mock_session(
    session_id: str,
    profile: str = "tai",
    project_id: str | None = "hyrax-vn",
    messages: list | None = None,
    active_stream_id: str | None = None,
):
    return SimpleNamespace(
        session_id=session_id,
        profile=profile,
        project_id=project_id,
        archived=False,
        title=f"{profile.title()} VN",
        messages=messages or [],
        active_stream_id=active_stream_id,
        created_at=1000.0,
        updated_at=1000.0,
        save=lambda: None,
    )


def _call_essence_get(path: str, query: str = ""):
    import api.hyrax_essence as essence

    handler = _Handler()
    parsed = SimpleNamespace(path=path, query=query)
    handled = essence.handle_essence_get(handler, parsed)
    return handled, handler


# ══════════════════════════════════════════════════════════════════════════
# Test: expression enum normalization (ESSENCE_RUNTIME_SPEC §6)
# ══════════════════════════════════════════════════════════════════════════

class TestExpressionEnum:
    """The canonical per-sister enum and unknown-name normalization."""

    def test_enum_matches_spec(self):
        from api.hyrax_essence import EXPRESSION_ENUM
        assert set(EXPRESSION_ENUM["tai"]) == {
            "neutral", "smile", "happy-emote", "sarcastic", "focused",
        }
        assert set(EXPRESSION_ENUM["rei"]) == {"neutral", "calm", "alert"}
        assert set(EXPRESSION_ENUM["nei"]) == {"neutral", "observant", "thinking"}
        assert set(EXPRESSION_ENUM["mai"]) == {
            "neutral", "smile", "laughing", "light-smile", "ohhoai", "shy-smile",
            "scream-of-fury", "yandere-smile", "sarcastic", "focused",
        }

    def test_known_names_pass_through(self):
        from api.hyrax_essence import normalize_expression
        for operator, names in (
            ("tai", ("neutral", "smile", "happy-emote", "sarcastic", "focused")),
            ("rei", ("neutral", "calm", "alert")),
            ("nei", ("neutral", "observant", "thinking")),
            ("mai", ("smile", "laughing", "ohhoai", "yandere-smile")),
        ):
            for name in names:
                current, issues = normalize_expression(operator, name)
                assert current == name
                assert issues == []

    def test_unknown_name_falls_back_to_neutral_with_issue(self):
        from api.hyrax_essence import normalize_expression
        current, issues = normalize_expression("rei", "laughing")  # mai-only name
        assert current == "neutral"
        assert len(issues) == 1
        assert "laughing" in issues[0]

    def test_absent_name_is_neutral_without_issue(self):
        from api.hyrax_essence import normalize_expression
        for raw in (None, "", "   ", 42):
            current, issues = normalize_expression("tai", raw)
            assert current == "neutral"
            assert issues == []


# ══════════════════════════════════════════════════════════════════════════
# Test: GET /api/hyrax/essence/{operator}
# ══════════════════════════════════════════════════════════════════════════

class TestEssenceEndpoint:
    """Bounded essence state read with provenance markers; fail closed."""

    def test_happy_path_reads_state_and_affinity(self, profile_home):
        profile_home("mai", {
            "mood": "calm",
            "energy": 0.5,
            "mode": "after_hours",
            "last_updated": datetime.now(timezone.utc).isoformat(),
            "expression": {"current": "light-smile", "intensity": 0.5},
        }, {
            "bond": 66,
            "dimensions": {"rapport": 75, "trust": 86},
            "global": {"boundaries": {"effective": {"max_spice": 3, "flirt": True}}},
        })
        handled, handler = _call_essence_get("/api/hyrax/essence/mai")
        assert handled is True
        assert handler.status == 200
        body = handler.json_body()
        assert body["available"] is True
        assert body["mood"] == "calm"
        assert body["energy"] == 0.5
        assert body["mode"] == "after_hours"
        assert body["expression"]["current"] == "light-smile"
        assert body["expression"]["intensity"] == 0.5
        assert body["expression"]["issues"] == []
        assert body["affinity"]["rapport"] == 75.0
        assert body["affinity"]["trust"] == 86.0
        assert body["affinity"]["composite"] == 66.0
        assert body["affinity"]["boundaries"] == {"max_spice": 3, "flirt": True}
        assert body["staleness_days"] is not None
        assert body["staleness_days"] < 0.01
        prov = body["provenance"]
        assert prov["mood"] == "read"
        assert prov["expression"] == "read"
        assert prov["staleness_days"] == "derived"
        assert prov["rapport"] == "read"

    def test_stale_state_reports_staleness_days(self, profile_home):
        stale = (datetime.now(timezone.utc) - timedelta(days=12)).isoformat()
        profile_home("rei", {"mood": "energetic_and_focused", "energy": 0.3,
                             "mode": "after_hours", "last_updated": stale})
        import api.hyrax_essence as essence
        payload = essence.build_essence_payload("rei")
        assert payload["available"] is True
        assert 11.9 <= payload["staleness_days"] <= 12.1

    def test_missing_state_fails_closed(self, profile_home):
        profile_home("nei", None)  # no state.json written
        handled, handler = _call_essence_get("/api/hyrax/essence/nei")
        assert handled is True
        assert handler.status == 200
        body = handler.json_body()
        assert body["available"] is False
        assert body["mood"] == "neutral"
        assert body["energy"] is None
        assert body["mode"] is None
        assert body["staleness_days"] is None
        assert body["expression"]["current"] == "neutral"
        assert body["expression"]["issues"], "expected an availability issue entry"
        assert body["provenance"]["mood"] == "unknown"

    def test_malformed_state_fails_closed(self, profile_home, tmp_path):
        home = profile_home("tai", None)
        (home / "essence" / "state.json").write_text("{not json")
        handled, handler = _call_essence_get("/api/hyrax/essence/tai")
        assert handler.status == 200
        assert handler.json_body()["available"] is False

    def test_unknown_expression_normalized_with_issue(self, profile_home):
        profile_home("rei", {
            "mood": "calm",
            "last_updated": datetime.now(timezone.utc).isoformat(),
            "expression": {"current": "scream-of-fury", "intensity": 0.9},
        })
        handled, handler = _call_essence_get("/api/hyrax/essence/rei")
        body = handler.json_body()
        assert body["expression"]["current"] == "neutral"
        assert any("scream-of-fury" in i for i in body["expression"]["issues"])
        assert body["provenance"]["expression"] == "derived"

    def test_unparseable_last_updated_yields_null_staleness(self, profile_home):
        profile_home("tai", {"mood": "bright", "last_updated": "not-a-date"})
        import api.hyrax_essence as essence
        payload = essence.build_essence_payload("tai")
        assert payload["available"] is True
        assert payload["staleness_days"] is None
        assert payload["provenance"]["staleness_days"] == "unknown"

    def test_missing_affinity_yields_null_fields(self, profile_home):
        profile_home("nei", {"mood": "neutral",
                             "last_updated": datetime.now(timezone.utc).isoformat()})
        handled, handler = _call_essence_get("/api/hyrax/essence/nei")
        body = handler.json_body()
        assert body["available"] is True
        assert body["affinity"]["rapport"] is None
        assert body["affinity"]["trust"] is None
        assert body["affinity"]["composite"] is None
        assert body["affinity"]["boundaries"] is None
        assert body["provenance"]["rapport"] == "unknown"

    def test_unknown_operator_404(self):
        handled, handler = _call_essence_get("/api/hyrax/essence/eve")
        assert handled is True
        assert handler.status == 404

    def test_traversal_operator_404(self):
        handled, handler = _call_essence_get("/api/hyrax/essence/..%2f..%2fetc")
        assert handled is True
        assert handler.status == 404


# ══════════════════════════════════════════════════════════════════════════
# Test: GET /api/hyrax/essence/frames (registry)
# ══════════════════════════════════════════════════════════════════════════

class TestFramesRegistryGet:
    """Registry GET: validated frames, fail closed when missing/corrupt."""

    def test_real_registry_serves_29_imported_frames(self):
        handled, handler = _call_essence_get("/api/hyrax/essence/frames")
        assert handled is True
        assert handler.status == 200
        body = handler.json_body()
        assert body["meta"]["available"] is True
        assert body["meta"]["total"] == 29
        import re
        id_re = re.compile(r"^frame\.[a-z0-9-]+(\.[a-z0-9-]+)*$")
        for frame in body["frames"]:
            assert id_re.match(frame["id"]), frame["id"]
            assert frame["operatorId"] in ("tai", "rei", "nei", "mai")
            assert frame["source"] == "authored"
            assert frame["quality"]["approved"] is True
            assert frame["sceneSignature"]
            assert frame["assets"]["imageUrl"].startswith("/api/hyrax/assets/")

    def test_missing_registry_fails_closed(self, frames_drop_dir):
        _, registry = frames_drop_dir
        assert not registry.exists()
        handled, handler = _call_essence_get("/api/hyrax/essence/frames")
        assert handler.status == 200
        body = handler.json_body()
        assert body["frames"] == []
        assert body["meta"]["available"] is False
        assert body["meta"]["total"] == 0

    def test_corrupt_registry_fails_closed(self, frames_drop_dir):
        _, registry = frames_drop_dir
        registry.write_text("{corrupt")
        handled, handler = _call_essence_get("/api/hyrax/essence/frames")
        body = handler.json_body()
        assert body["meta"]["available"] is False

    def test_invalid_entries_dropped(self, frames_drop_dir):
        _, registry = frames_drop_dir
        registry.write_text(json.dumps({
            "version": 1,
            "frames": [
                {"id": "frame.mai.portrait.smile", "operatorId": "mai",
                 "source": "authored", "sceneSignature": "abc123",
                 "state": {"expression": "smile"},
                 "assets": {"imageUrl": "/api/hyrax/assets/mai.portrait.smile"},
                 "quality": {"approved": True}},
                {"id": "evil", "operatorId": "mai"},  # bad id
                {"id": "frame.eve.x", "operatorId": "eve"},  # unknown operator
                "not-a-dict",
            ],
        }))
        handled, handler = _call_essence_get("/api/hyrax/essence/frames")
        body = handler.json_body()
        assert body["meta"]["total"] == 1
        assert body["meta"]["dropped"] == 3
        assert body["frames"][0]["id"] == "frame.mai.portrait.smile"


# ══════════════════════════════════════════════════════════════════════════
# Test: POST /api/hyrax/essence/frames/register
# ══════════════════════════════════════════════════════════════════════════

class TestFrameRegister:
    """Register endpoint validation: allowlist, traversal, duplicate, bounds."""

    def _post(self, body):
        import api.hyrax_essence as essence

        handler = _Handler(command="POST")
        parsed = SimpleNamespace(path="/api/hyrax/essence/frames/register", query="")
        handled = essence.handle_essence_post(handler, parsed, body)
        assert handled is True
        return handler

    def _valid_body(self, **overrides):
        body = {
            "id": "frame.mai.lab.night.working.v3",
            "operatorId": "mai",
            "state": {"expression": "smile", "location": "lab", "camera": "medium"},
            "image": "drop1.png",
        }
        body.update(overrides)
        return body

    def test_register_happy_path(self, frames_drop_dir):
        frames_dir, registry = frames_drop_dir
        content = b"\x89PNG\r\n\x1a\n fake image bytes"
        (frames_dir / "drop1.png").write_bytes(content)
        handler = self._post(self._valid_body())
        assert handler.status == 200
        frame = handler.json_body()["frame"]
        assert frame["source"] == "authored"
        assert frame["quality"]["approved"] is True
        assert frame["assets"]["sha256"] == hashlib.sha256(content).hexdigest()
        assert frame["assets"]["size"] == len(content)
        import api.hyrax_essence as essence
        assert frame["sceneSignature"] == essence.compute_scene_signature(
            "mai", {"expression": "smile", "location": "lab", "camera": "medium"}
        )
        # Persisted to the registry file
        on_disk = json.loads(registry.read_text())
        assert [f["id"] for f in on_disk["frames"]] == ["frame.mai.lab.night.working.v3"]

    def test_register_without_state_defaults_empty(self, frames_drop_dir):
        frames_dir, _ = frames_drop_dir
        (frames_dir / "drop1.png").write_bytes(b"png")
        body = self._valid_body()
        del body["state"]
        handler = self._post(body)
        assert handler.status == 200

    def test_rejects_unknown_operator(self, frames_drop_dir):
        frames_dir, _ = frames_drop_dir
        (frames_dir / "drop1.png").write_bytes(b"png")
        handler = self._post(self._valid_body(operatorId="eve"))
        assert handler.status == 400

    @pytest.mark.parametrize("bad_id", [
        "evil",
        "frame..double",
        "frame.mai.UPPER",
        "frame.mai..x",
        "frame.",
        "frame.mai/" "../etc",
        42,
        None,
    ])
    def test_rejects_bad_id_pattern(self, frames_drop_dir, bad_id):
        frames_dir, _ = frames_drop_dir
        (frames_dir / "drop1.png").write_bytes(b"png")
        handler = self._post(self._valid_body(id=bad_id))
        assert handler.status == 400

    @pytest.mark.parametrize("bad_image", [
        "../drop1.png",
        "sub/drop1.png",
        "..\\drop1.png",
        "drop1.png%2e",
        "drop1.gif",
        ".hidden.png",
        "",
    ])
    def test_rejects_traversal_and_bad_extension(self, frames_drop_dir, bad_image):
        frames_dir, _ = frames_drop_dir
        (frames_dir / "drop1.png").write_bytes(b"png")
        (frames_dir / "drop1.gif").write_bytes(b"gif")
        handler = self._post(self._valid_body(image=bad_image))
        assert handler.status == 400

    def test_rejects_missing_image_file(self, frames_drop_dir):
        handler = self._post(self._valid_body(image="nothere.png"))
        assert handler.status == 400
        assert handler.json_body()["error"] == "image not found"

    def test_rejects_oversize_image(self, frames_drop_dir):
        frames_dir, _ = frames_drop_dir
        big = frames_dir / "big.png"
        with open(big, "wb") as fh:
            fh.truncate(8 * 1024 * 1024 + 1)
        handler = self._post(self._valid_body(image="big.png"))
        assert handler.status == 400
        assert handler.json_body()["error"] == "image size out of bounds"

    def test_rejects_duplicate_id(self, frames_drop_dir):
        frames_dir, _ = frames_drop_dir
        (frames_dir / "drop1.png").write_bytes(b"png")
        assert self._post(self._valid_body()).status == 200
        handler = self._post(self._valid_body())
        assert handler.status == 409

    def test_rejects_extra_body_keys(self, frames_drop_dir):
        frames_dir, _ = frames_drop_dir
        (frames_dir / "drop1.png").write_bytes(b"png")
        handler = self._post(self._valid_body(evil="yes"))
        assert handler.status == 400

    def test_rejects_invalid_state(self, frames_drop_dir):
        frames_dir, _ = frames_drop_dir
        (frames_dir / "drop1.png").write_bytes(b"png")
        assert self._post(self._valid_body(
            state={"camera": "extreme-closeup"})).status == 400
        assert self._post(self._valid_body(
            state={"unknownKey": "x"})).status == 400
        assert self._post(self._valid_body(
            state="not-a-dict")).status == 400

    def test_jpg_and_webp_extensions_accepted(self, frames_drop_dir):
        frames_dir, _ = frames_drop_dir
        (frames_dir / "drop1.jpg").write_bytes(b"jpg")
        (frames_dir / "drop2.webp").write_bytes(b"webp")
        assert self._post(self._valid_body(image="drop1.jpg")).status == 200
        assert self._post(self._valid_body(
            id="frame.mai.lab.day.idle.v1", image="drop2.webp")).status == 200


# ══════════════════════════════════════════════════════════════════════════
# Test: GET /api/hyrax/presence
# ══════════════════════════════════════════════════════════════════════════

class TestPresence:
    """Per-sister presence aggregation: activity, expression, kanban, approvals."""

    def _patch(self, monkeypatch, sessions, full_sessions=None, kanban_rows=None,
               pending_counts=None):
        import api.hyrax_essence as essence

        monkeypatch.setattr(essence, "_all_sessions", lambda: sessions)
        full_sessions = full_sessions or {}
        def _fake_get(sid, **kw):
            if sid in full_sessions:
                return full_sessions[sid]
            raise KeyError(sid)
        monkeypatch.setattr(essence, "_get_session", _fake_get)
        monkeypatch.setattr(essence, "_query", lambda db, sql, params=(): kanban_rows or [])
        pending_counts = pending_counts or {}
        monkeypatch.setattr(
            essence, "_pending_approval_count", lambda sid: pending_counts.get(sid, 0)
        )

    def _items_by_operator(self, handler):
        return {item["operatorId"]: item for item in handler.json_body()["items"]}

    def test_idle_when_no_session(self, monkeypatch):
        self._patch(monkeypatch, [])
        handled, handler = _call_essence_get("/api/hyrax/presence")
        assert handled is True
        assert handler.status == 200
        body = handler.json_body()
        assert len(body["items"]) == 4
        assert body["meta"]["generatedAt"]
        items = self._items_by_operator(handler)
        for item in items.values():
            assert item["activity"]["type"] == "idle"
            assert item["activity"]["interruptibility"] == "free"
            assert item["pendingApprovals"] == 0
            assert item["kanban"] == {"running": 0, "blocked": 0}
            assert item["expression"]["current"] == "neutral"

    def test_conversing_when_streaming(self, monkeypatch):
        compact = [{
            "session_id": "vn_tai_1", "profile": "tai", "project_id": "hyrax-vn",
            "archived": False, "active_stream_id": "stream_1",
            "created_at": 1.0, "updated_at": 2.0,
        }]
        full = _make_mock_session("vn_tai_1", messages=[
            {"role": "user", "content": "hi"},
        ])
        self._patch(monkeypatch, compact, {"vn_tai_1": full})
        _, handler = _call_essence_get("/api/hyrax/presence")
        item = self._items_by_operator(handler)["tai"]
        assert item["activity"]["type"] == "conversing"
        assert item["activity"]["interruptibility"] == "soft-busy"

    def test_tool_working_when_tool_in_flight(self, monkeypatch):
        compact = [{
            "session_id": "vn_rei_1", "profile": "rei", "project_id": "hyrax-vn",
            "archived": False, "active_stream_id": "stream_2",
            "created_at": 1.0, "updated_at": 2.0,
        }]
        full = _make_mock_session("vn_rei_1", profile="rei", messages=[
            {"role": "user", "content": "run the tests"},
            {"role": "assistant", "content": None,
             "tool_calls": [{"id": "tc_1", "function": {"name": "exec"}}]},
        ])
        self._patch(monkeypatch, compact, {"vn_rei_1": full})
        _, handler = _call_essence_get("/api/hyrax/presence")
        item = self._items_by_operator(handler)["rei"]
        assert item["activity"]["type"] == "tool-working"
        assert item["activity"]["interruptibility"] == "busy"

    def test_waiting_approval_wins_over_streaming(self, monkeypatch):
        compact = [{
            "session_id": "vn_nei_1", "profile": "nei", "project_id": "hyrax-vn",
            "archived": False, "active_stream_id": "stream_3",
            "created_at": 1.0, "updated_at": 2.0,
        }]
        full = _make_mock_session("vn_nei_1", profile="nei")
        self._patch(monkeypatch, compact, {"vn_nei_1": full},
                    pending_counts={"vn_nei_1": 2})
        _, handler = _call_essence_get("/api/hyrax/presence")
        item = self._items_by_operator(handler)["nei"]
        assert item["activity"]["type"] == "waiting-approval"
        assert item["pendingApprovals"] == 2

    def test_expression_derived_from_last_assistant_message(self, monkeypatch):
        compact = [{
            "session_id": "vn_mai_1", "profile": "mai", "project_id": "hyrax-vn",
            "archived": False, "active_stream_id": None,
            "created_at": 1.0, "updated_at": 2.0,
        }]
        full = _make_mock_session("vn_mai_1", profile="mai", messages=[
            {"role": "user", "content": "tell me a joke"},
            {"role": "assistant", "content": "Haha, good one!"},
        ])
        self._patch(monkeypatch, compact, {"vn_mai_1": full})
        _, handler = _call_essence_get("/api/hyrax/presence")
        item = self._items_by_operator(handler)["mai"]
        assert item["expression"]["current"] == "laughing"
        assert item["expression"]["intensity"] == 0.5

    def test_kanban_counts_grouped_by_assignee(self, monkeypatch):
        self._patch(monkeypatch, [], kanban_rows=[
            {"name": "Tai", "running_count": 2, "blocked_count": 1},
            {"name": "rei", "running_count": 0, "blocked_count": 3},
        ])
        _, handler = _call_essence_get("/api/hyrax/presence")
        items = self._items_by_operator(handler)
        assert items["tai"]["kanban"] == {"running": 2, "blocked": 1}
        assert items["rei"]["kanban"] == {"running": 0, "blocked": 3}
        assert items["nei"]["kanban"] == {"running": 0, "blocked": 0}

    def test_essence_state_updated_at_included(self, monkeypatch, profile_home):
        ts = "2026-07-18T02:09:18.575470+00:00"
        profile_home("tai", {"mood": "bright", "energy": 0.75,
                             "mode": "workmode", "last_updated": ts})
        self._patch(monkeypatch, [])
        _, handler = _call_essence_get("/api/hyrax/presence")
        items = self._items_by_operator(handler)
        assert items["tai"]["essenceStateUpdatedAt"] == ts
        assert "essenceStateUpdatedAt" not in items["rei"]

    def test_resilient_to_session_store_failure(self, monkeypatch):
        import api.hyrax_essence as essence

        def _boom():
            raise RuntimeError("session store down")
        monkeypatch.setattr(essence, "_all_sessions", _boom)
        monkeypatch.setattr(essence, "_query", lambda db, sql, params=(): [])
        _, handler = _call_essence_get("/api/hyrax/presence")
        assert handler.status == 200
        assert len(handler.json_body()["items"]) == 4

    def test_available_comes_from_vn_profiles(self, monkeypatch):
        self._patch(monkeypatch, [])
        _, handler = _call_essence_get("/api/hyrax/presence")
        for item in handler.json_body()["items"]:
            assert item["available"] is True


# ══════════════════════════════════════════════════════════════════════════
# Test: transcript paging (?limit= / ?before= / has_more / total)
# ══════════════════════════════════════════════════════════════════════════

class TestTranscriptPaging:
    """VN transcript paging contract (replaces the fixed 50-row cap)."""

    def _get(self, monkeypatch, messages, query=""):
        session = _make_mock_session("vn_page_1", messages=messages)
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)
        from api.hyrax_routes import handle_hyrax_vn_get
        handler = _Handler()
        parsed = SimpleNamespace(
            path="/api/hyrax/vn/conversations/vn_page_1", query=query,
        )
        handled = handle_hyrax_vn_get(handler, parsed)
        assert handled is True
        return handler

    def _messages(self, n, with_ids=False):
        out = []
        for i in range(n):
            msg = {"role": "user" if i % 2 == 0 else "assistant", "content": f"msg_{i}"}
            if with_ids:
                msg["id"] = f"id_{i}"
            out.append(msg)
        return out

    def test_default_page_is_200_with_has_more_and_total(self, monkeypatch):
        handler = self._get(monkeypatch, self._messages(250))
        assert handler.status == 200
        conv = handler.json_body()["conversation"]
        assert len(conv["messages"]) == 200
        assert conv["has_more"] is True
        assert conv["total"] == 250
        assert conv["message_count"] == 250
        # Window is the LAST 200 rows
        assert conv["messages"][0]["content"] == "msg_50"
        assert conv["messages"][-1]["content"] == "msg_249"

    def test_limit_window(self, monkeypatch):
        handler = self._get(monkeypatch, self._messages(30), query="limit=10")
        conv = handler.json_body()["conversation"]
        assert len(conv["messages"]) == 10
        assert conv["messages"][0]["content"] == "msg_20"
        assert conv["has_more"] is True
        assert conv["total"] == 30

    def test_limit_hard_capped_at_400(self, monkeypatch):
        handler = self._get(monkeypatch, self._messages(30), query="limit=401")
        assert handler.status == 400

    @pytest.mark.parametrize("query", ["limit=0", "limit=abc", "limit=-5", "limit="])
    def test_invalid_limit_400(self, monkeypatch, query):
        handler = self._get(monkeypatch, self._messages(5), query=query)
        assert handler.status == 400

    def test_before_index_cursor(self, monkeypatch):
        handler = self._get(monkeypatch, self._messages(30), query="before=10")
        conv = handler.json_body()["conversation"]
        assert len(conv["messages"]) == 10
        assert conv["messages"][0]["content"] == "msg_0"
        assert conv["messages"][-1]["content"] == "msg_9"
        assert conv["has_more"] is False
        assert conv["total"] == 30

    def test_before_index_and_limit_paging_chain(self, monkeypatch):
        handler = self._get(
            monkeypatch, self._messages(30), query="limit=10&before=25",
        )
        conv = handler.json_body()["conversation"]
        assert [m["content"] for m in conv["messages"]] == [
            f"msg_{i}" for i in range(15, 25)
        ]
        assert conv["has_more"] is True

    def test_before_message_id_cursor(self, monkeypatch):
        handler = self._get(
            monkeypatch, self._messages(30, with_ids=True), query="before=id_15",
        )
        conv = handler.json_body()["conversation"]
        assert len(conv["messages"]) == 15
        assert conv["messages"][-1]["content"] == "msg_14"

    def test_before_unresolvable_cursor_400(self, monkeypatch):
        handler = self._get(
            monkeypatch, self._messages(30, with_ids=True), query="before=nope",
        )
        assert handler.status == 400

    def test_before_index_out_of_range_400(self, monkeypatch):
        handler = self._get(monkeypatch, self._messages(30), query="before=999")
        assert handler.status == 400

    def test_no_paging_small_transcript(self, monkeypatch):
        handler = self._get(monkeypatch, self._messages(3))
        conv = handler.json_body()["conversation"]
        assert len(conv["messages"]) == 3
        assert conv["has_more"] is False
        assert conv["total"] == 3


# ══════════════════════════════════════════════════════════════════════════
# Test: VN turn attachments + text-cap payload
# ══════════════════════════════════════════════════════════════════════════

def _att(**overrides):
    att = {"name": "shot.png", "path": "/tmp/upload/shot.png",
           "mime": "image/png", "size": 1024}
    att.update(overrides)
    return att


class TestTurnAttachments:
    """Attachments accepted in the strict bounded shape, everything else 400."""

    def _post_turn(self, monkeypatch, body, start_turn):
        monkeypatch.setattr("api.routes.start_session_turn", start_turn)
        session = _make_mock_session("vn_att_1")
        monkeypatch.setattr("api.hyrax_routes._get_session", lambda sid, **kw: session)
        from api.hyrax_routes import handle_hyrax_vn_post
        handler = _Handler(command="POST")
        parsed = SimpleNamespace(
            path="/api/hyrax/vn/conversations/vn_att_1/turns", query="",
        )
        handled = handle_hyrax_vn_post(handler, parsed, body)
        assert handled is True
        return handler

    def _ok_turn(self, captured):
        def _fake(session_id, message, *, source=None, attachments=None):
            captured["source"] = source
            captured["attachments"] = attachments
            return {"stream_id": "s1", "pending": True, "_status": 200}
        return _fake

    def test_attachments_passed_through(self, monkeypatch):
        captured = {}
        handler = self._post_turn(monkeypatch, {
            "text": "look at this",
            "attachments": [_att()],
        }, self._ok_turn(captured))
        assert handler.status == 200
        assert captured["source"] == "hyrax_vn"
        assert captured["attachments"] == [_att()]

    def test_no_attachments_calls_without_kwarg(self, monkeypatch):
        def _fake(session_id, message, *, source=None):
            return {"stream_id": "s1", "pending": True, "_status": 200}
        handler = self._post_turn(monkeypatch, {"text": "plain"}, _fake)
        assert handler.status == 200

    def test_empty_attachments_list_calls_without_kwarg(self, monkeypatch):
        def _fake(session_id, message, *, source=None):
            return {"stream_id": "s1", "pending": True, "_status": 200}
        handler = self._post_turn(
            monkeypatch, {"text": "plain", "attachments": []}, _fake,
        )
        assert handler.status == 200

    def test_attachments_unsupported_runtime_fails_closed(self, monkeypatch):
        """When start_session_turn lacks an attachments param (current native
        signature), the turn must fail closed — never silently drop files."""
        def _fake(session_id, message, *, source=None):
            return {"stream_id": "s1", "pending": True, "_status": 200}
        handler = self._post_turn(monkeypatch, {
            "text": "look",
            "attachments": [_att()],
        }, _fake)
        assert handler.status == 400
        assert handler.json_body()["error"] == "attachments not supported"

    @pytest.mark.parametrize("attachments", [
        [_att()] * 9,                       # too many items
        [_att(name="n" * 257)],             # string too long
        [_att(size=25 * 1024 * 1024 + 1)],  # oversize
        [_att(size=True)],                  # bool size
        [_att(size=-1)],                    # negative size
        [_att(size="1024")],                # non-int size
        [{"name": "a", "path": "/p", "mime": "m"}],     # missing size
        [dict(_att(), extra=1)],            # extra key
        ["shot.png"],                                   # non-dict item
        "shot.png",                                     # non-list
        [_att(name="")],                    # empty name
        [_att(path="")],                    # empty path
    ])
    def test_rejected_attachment_shapes(self, monkeypatch, attachments):
        def _fake(session_id, message, *, source=None, attachments=None):
            return {"stream_id": "s1", "pending": True, "_status": 200}
        handler = self._post_turn(
            monkeypatch, {"text": "hi", "attachments": attachments}, _fake,
        )
        assert handler.status == 400

    def test_max_attachments_boundary_accepted(self, monkeypatch):
        captured = {}
        atts = [_att(name=f"f{i}.png") for i in range(8)]
        handler = self._post_turn(
            monkeypatch, {"text": "hi", "attachments": atts}, self._ok_turn(captured),
        )
        assert handler.status == 200
        assert len(captured["attachments"]) == 8

    def test_text_cap_error_includes_limit(self, monkeypatch):
        from api.hyrax_routes import MAX_TURN_TEXT_LENGTH
        def _fake(session_id, message, *, source=None):
            raise AssertionError("must not be called")
        handler = self._post_turn(
            monkeypatch, {"text": "x" * (MAX_TURN_TEXT_LENGTH + 1)}, _fake,
        )
        assert handler.status == 400
        body = handler.json_body()
        assert body["error"] == "text exceeds maximum length"
        assert body["limit"] == MAX_TURN_TEXT_LENGTH


# ══════════════════════════════════════════════════════════════════════════
# Test: dispatch wiring through handle_hyrax_get / handle_hyrax_post
# ══════════════════════════════════════════════════════════════════════════

class TestEssenceDispatch:
    """The three GETs + register POST are reachable via hyrax dispatch."""

    def test_get_essence_dispatch(self, profile_home):
        profile_home("tai", {"mood": "bright",
                             "last_updated": datetime.now(timezone.utc).isoformat()})
        from api.hyrax_routes import handle_hyrax_get
        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/essence/tai", query="")
        assert handle_hyrax_get(handler, parsed) is True
        assert handler.status == 200
        assert handler.json_body()["operator"] == "tai"

    def test_get_frames_dispatch(self):
        from api.hyrax_routes import handle_hyrax_get
        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/essence/frames", query="")
        assert handle_hyrax_get(handler, parsed) is True
        assert handler.status == 200

    def test_get_presence_dispatch(self, monkeypatch):
        import api.hyrax_essence as essence
        monkeypatch.setattr(essence, "_all_sessions", lambda: [])
        monkeypatch.setattr(essence, "_query", lambda db, sql, params=(): [])
        from api.hyrax_routes import handle_hyrax_get
        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/presence", query="")
        assert handle_hyrax_get(handler, parsed) is True
        assert handler.status == 200

    def test_unknown_essence_path_404(self):
        from api.hyrax_routes import handle_hyrax_get
        handler = _Handler()
        parsed = SimpleNamespace(path="/api/hyrax/essence/", query="")
        assert handle_hyrax_get(handler, parsed) is True
        assert handler.status == 404

    def test_post_register_dispatch(self, frames_drop_dir):
        frames_dir, _ = frames_drop_dir
        (frames_dir / "drop1.png").write_bytes(b"png")
        import api.hyrax_essence as essence
        handler = _Handler(command="POST")
        parsed = SimpleNamespace(path="/api/hyrax/essence/frames/register", query="")
        assert essence.handle_essence_post(handler, parsed, {
            "id": "frame.tai.room.day.idle.v1",
            "operatorId": "tai",
            "image": "drop1.png",
        }) is True
        assert handler.status == 200

    def test_post_unknown_essence_path_404(self):
        import api.hyrax_essence as essence
        handler = _Handler(command="POST")
        parsed = SimpleNamespace(path="/api/hyrax/essence/nope", query="")
        assert essence.handle_essence_post(handler, parsed, {}) is True
        assert handler.status == 404


# ══════════════════════════════════════════════════════════════════════════
# Test: scene signatures (ESSENCE_RUNTIME_SPEC §4)
# ══════════════════════════════════════════════════════════════════════════

class TestSceneSignature:
    """Coarse-fields-only signature stability."""

    def test_deterministic(self):
        from api.hyrax_essence import compute_scene_signature
        state = {"expression": "smile", "location": "lab", "camera": "medium"}
        assert compute_scene_signature("mai", state) == compute_scene_signature("mai", state)

    def test_coarse_fields_change_signature(self):
        from api.hyrax_essence import compute_scene_signature
        base = {"expression": "smile", "location": "lab"}
        assert compute_scene_signature("mai", base) != compute_scene_signature("rei", base)
        assert compute_scene_signature("mai", base) != compute_scene_signature(
            "mai", {**base, "expression": "neutral"})
        assert compute_scene_signature("mai", base) != compute_scene_signature(
            "mai", {**base, "location": "supply-hub"})

    def test_props_capped_at_three_and_order_stable(self):
        from api.hyrax_essence import compute_scene_signature
        # majorProps[≤3]: sorted, deduped, capped — the 4th prop (sorted last)
        # must not change the signature, and prop order must not either.
        a = {"props": ["desk", "lamp", "terminal", "zzz-extra"]}
        b = {"props": ["terminal", "lamp", "desk"]}
        assert compute_scene_signature("nei", a) == compute_scene_signature("nei", b)

    def test_registry_frames_have_valid_signatures(self):
        import api.hyrax_essence as essence
        payload = essence._load_registry_payload()
        assert payload["meta"]["total"] == 29
        for frame in payload["frames"]:
            assert essence.compute_scene_signature(
                frame["operatorId"], frame["state"]
            ) == frame["sceneSignature"]
