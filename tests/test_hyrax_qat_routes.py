"""Tests for the Hyrax QAT routes (api/hyrax_routes.py /api/hyrax/qat/*).

Covers:
  - GET /api/hyrax/qat/packet  — serves the committed packet JSON
  - GET /api/hyrax/qat/verdicts — reads verdicts.jsonl (append-only log)
  - POST /api/hyrax/qat/verdicts — validates strictly (test_id against the
    ACTIVE packet milestones, verdict enum, bounded why) and appends one
    durable JSONL row; gated milestones (M5.3) reject verdicts

Evidence integrity posture: the JSONL is append-only; a submitted verdict
must survive a read-back and the row must carry test_id/milestone/verdict/
why/source/at. No rewrite path exists.
"""

from __future__ import annotations

import io
import json
from types import SimpleNamespace

import pytest

import api.auth as auth
import api.hyrax_routes as hyrax


# ── Mock HTTP handler (same shape as the other hyrax route tests) ─────────
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

    def header_values(self, name):
        return [v for k, v in self.sent_headers if k == name]


@pytest.fixture(autouse=True)
def isolate_auth(monkeypatch):
    monkeypatch.setattr(auth, "STATE_DIR", "/tmp/__test_hyrax_qat_auth")
    monkeypatch.setattr(auth, "_SESSIONS_FILE", "/tmp/__test_hyrax_qat_auth/.sessions.json")
    monkeypatch.setattr(auth, "is_password_auth_enabled", lambda: False)
    monkeypatch.setattr(auth, "are_passkeys_enabled", lambda: False)
    monkeypatch.setattr(auth, "is_oidc_auth_enabled", lambda: False)
    monkeypatch.setattr(auth, "is_trusted_auth_enabled", lambda: False)
    auth._sessions.clear()
    auth._TRUSTED_AUTH_WARNINGS_EMITTED.clear()
    yield
    auth._sessions.clear()
    auth._TRUSTED_AUTH_WARNINGS_EMITTED.clear()


@pytest.fixture(autouse=True)
def isolated_verdicts_file(tmp_path, monkeypatch):
    """Point verdicts.jsonl at a temp file for every test."""
    dest = tmp_path / "aaemu_qat" / "verdicts.jsonl"
    monkeypatch.setenv("HERMES_QAT_VERDICTS_FILE", str(dest))
    yield dest


def _call_get(handler, path: str):
    parsed = SimpleNamespace(path=path, query="")
    return hyrax.handle_hyrax_get(handler, parsed)


def _call_post(body):
    """Direct POST to the QAT verdict handler (dispatch reads the body via
    routes.read_body, which the unit tests bypass by calling the inner
    handler with an explicit body — same pattern as the essence tests)."""
    handler = _Handler(command="POST")
    handled = hyrax._submit_qat_verdict(handler, body)
    assert handled is True
    return handler


# ══════════════════════════════════════════════════════════════════════════
# GET /api/hyrax/qat/packet
# ══════════════════════════════════════════════════════════════════════════

class TestQatPacketGet:
    def test_packet_served(self):
        """Known packet returns 200 with a packet dict containing milestones."""
        handler = _Handler()
        handled = _call_get(handler, "/api/hyrax/qat/packet")
        assert handled is True
        assert handler.status == 200
        body = handler.json_body()
        assert "packet" in body
        ms = body["packet"]["milestones"]
        ids = [m["id"] for m in ms]
        assert "M4" in ids and "M5.1" in ids and "M5.2" in ids and "M5.3" in ids

    def test_packet_milestone_structure(self):
        """Active milestones carry requirements, setup, tests, verdict_format."""
        handler = _Handler()
        _call_get(handler, "/api/hyrax/qat/packet")
        packet = handler.json_body()["packet"]
        m4 = next(m for m in packet["milestones"] if m["id"] == "M4")
        assert m4["status"] == "active"
        assert m4["requirements"] and m4["requirements"][0]["req"].startswith("REQ-M4")
        assert m4["tests"] and m4["tests"][0]["id"] == "S1"
        assert m4["verdict_format"]
        assert m4["overall"]["id"] == "OVERALL"
        # Gated milestone M5.3 present but not runnable
        m53 = next(m for m in packet["milestones"] if m["id"] == "M5.3")
        assert m53["status"] == "gated"

    def test_packet_404_when_missing(self, monkeypatch):
        """Missing packet file fails closed with 404, never a traceback."""
        monkeypatch.setattr(hyrax, "QAT_PACKET_PATH", __import__("pathlib").Path("/nonexistent/qat/packet.json"))
        handler = _Handler()
        handled = _call_get(handler, "/api/hyrax/qat/packet")
        assert handled is True
        assert handler.status == 404
        assert handler.json_body() == {"error": "not found"}


# ══════════════════════════════════════════════════════════════════════════
# POST /api/hyrax/qat/verdicts — validation
# ══════════════════════════════════════════════════════════════════════════

class TestQatVerdictValidation:
    def test_rejects_non_dict_body(self):
        handler = _call_post(["not", "a", "dict"])
        assert handler.status == 400

    def test_rejects_extra_keys(self):
        handler = _call_post(
            {"test_id": "M4-S1", "verdict": "PASS", "why": "ok", "evil": 1})
        assert handler.status == 400

    def test_rejects_missing_test_id(self):
        handler = _call_post({"verdict": "PASS", "why": "ok"})
        assert handler.status == 400

    def test_rejects_unknown_test_id(self):
        """Unknown test ids are rejected — cannot mint H evidence on a phantom test."""
        handler = _call_post({"test_id": "M4-Z9", "verdict": "PASS", "why": "nope"})
        assert handler.status == 400

    def test_rejects_gated_milestone(self):
        """M5.3 verdicts rejected until the section activates (fail-closed)."""
        handler = _call_post({"test_id": "M5.3-C1", "verdict": "PASS", "why": "too early"})
        assert handler.status == 400

    def test_rejects_invalid_verdict_value(self):
        handler = _call_post({"test_id": "M4-S1", "verdict": "MAYBE", "why": "ok"})
        assert handler.status == 400

    def test_rejects_empty_why(self):
        handler = _call_post({"test_id": "M4-S1", "verdict": "PASS", "why": "   "})
        assert handler.status == 400

    def test_rejects_overlong_why(self):
        handler = _call_post(
            {"test_id": "M4-S1", "verdict": "PASS", "why": "x" * (hyrax._QAT_MAX_WHY_LENGTH + 1)})
        assert handler.status == 400

    def test_packet_unavailable_fails_closed(self, monkeypatch):
        monkeypatch.setattr(hyrax, "QAT_PACKET_PATH", __import__("pathlib").Path("/nonexistent/qat/packet.json"))
        handler = _call_post({"test_id": "M4-S1", "verdict": "PASS", "why": "ok"})
        assert handler.status == 503
        assert handler.json_body() == {"error": "packet unavailable"}


# ══════════════════════════════════════════════════════════════════════════
# POST + GET round trip — durable evidence
# ══════════════════════════════════════════════════════════════════════════

class TestQatVerdictPersistence:
    def test_submit_appends_and_reads_back(self, isolated_verdicts_file):
        handler = _call_post({"test_id": "M4-S1", "verdict": "PASS", "why": "crops animate cleanly"})
        assert handler.status == 201
        record = handler.json_body()["record"]
        assert record["test_id"] == "M4-S1"
        assert record["milestone"] == "M4"
        assert record["verdict"] == "PASS"
        assert record["source"] == "hyrax-qat"
        assert isinstance(record["at"], float) and record["at"] > 0

        # File contains exactly one durable line
        lines = isolated_verdicts_file.read_text(encoding="utf-8").strip().splitlines()
        assert len(lines) == 1
        stored = json.loads(lines[0])
        assert stored["test_id"] == "M4-S1" and stored["verdict"] == "PASS"

        # GET reads it back — visible on reload
        handler2 = _Handler()
        _call_get(handler2, "/api/hyrax/qat/verdicts")
        assert handler2.status == 200
        body = handler2.json_body()
        assert body["total"] == 1
        assert body["items"][0]["test_id"] == "M4-S1"

    def test_multiple_verdicts_accumulate(self, isolated_verdicts_file):
        for spec in [("M4-S2", "FAIL", "pack clips through hull"),
                     ("M5.1-E5", "CAVEAT", "snapped but slow"),
                     ("M5.2-OVERALL", "PASS", "homestead feels right")]:
            h = _call_post({"test_id": spec[0], "verdict": spec[1], "why": spec[2]})
            assert h.status == 201
        h = _Handler()
        _call_get(h, "/api/hyrax/qat/verdicts")
        body = h.json_body()
        assert body["total"] == 3
        assert [r["test_id"] for r in body["items"]] == ["M4-S2", "M5.1-E5", "M5.2-OVERALL"]

    def test_overall_verdict_accepted(self, isolated_verdicts_file):
        h = _call_post({"test_id": "M4-OVERALL", "verdict": "CAVEAT", "why": "fun but janky"})
        assert h.status == 201
        assert h.json_body()["record"]["test_id"] == "M4-OVERALL"

    def test_malformed_line_skipped_on_read(self, isolated_verdicts_file):
        """A corrupt JSONL line never blocks the read of valid rows."""
        isolated_verdicts_file.parent.mkdir(parents=True, exist_ok=True)
        isolated_verdicts_file.write_text(
            '{"test_id": "M4-S1", "verdict": "PASS", "why": "ok"}\nNOT JSON\n'
            '{"test_id": "M4-S2", "verdict": "FAIL", "why": "nope"}\n',
            encoding="utf-8",
        )
        h = _Handler()
        _call_get(h, "/api/hyrax/qat/verdicts")
        assert h.status == 200
        body = h.json_body()
        assert body["total"] == 2
        assert [r["test_id"] for r in body["items"]] == ["M4-S1", "M4-S2"]

    def test_missing_verdicts_file_returns_empty(self, isolated_verdicts_file):
        h = _Handler()
        _call_get(h, "/api/hyrax/qat/verdicts")
        assert h.status == 200
        assert h.json_body() == {"items": [], "total": 0}