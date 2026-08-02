"""Tests for the D3 Josh approval-tier WebUI surface
(api/hyrax_essence.py: GET /api/hyrax/essence/approvals,
POST /api/hyrax/essence/approvals/respond).

RULES (match tests/test_hyrax_essence.py):
- Fake handlers only; no real HTTP, no real governance state.
- Hermetic: the store module is the REAL governance/josh_approval.py
  loaded against a tmp JSONL store (event shape stays owned by the
  store's module); no dependency on live /root/.hermes state.
"""

from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

GOVERNANCE_STORE_SRC = Path("/root/.hermes/governance/josh_approval.py")


class _Handler:
    """Minimal mock HTTP request handler that captures status/body."""

    def __init__(self):
        self.headers = {}
        self.wfile = io.BytesIO()
        self.status = None
        self.sent_headers: list[tuple[str, str]] = []

    def send_response(self, status):
        self.status = status

    def send_header(self, name, value):
        self.sent_headers.append((name, value))

    def end_headers(self):
        pass

    def json_body(self):
        return json.loads(self.wfile.getvalue().decode("utf-8"))


@pytest.fixture()
def store_module(tmp_path, monkeypatch):
    """The REAL josh_approval.py loaded against a tmp store, injected into
    api.hyrax_essence (fail-closed loader is monkeypatched, never the FS)."""
    import api.hyrax_essence as essence

    spec = importlib.util.spec_from_file_location(
        "test_josh_approval_store", GOVERNANCE_STORE_SRC)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.STORE_PATH = tmp_path / "josh_approvals.jsonl"
    monkeypatch.setattr(essence, "_josh_store_module", lambda: module)
    return module


def _get(path):
    import api.hyrax_essence as essence

    handler = _Handler()
    parsed = SimpleNamespace(path=path, query="")
    handled = essence.handle_essence_get(handler, parsed)
    return handled, handler


def _post(path, body):
    import api.hyrax_essence as essence

    handler = _Handler()
    parsed = SimpleNamespace(path=path, query="")
    handled = essence.handle_essence_post(handler, parsed, body)
    return handled, handler


def _file_request(module, proposal_id="prop-1", operator="mai"):
    return module.request_approval(
        proposal_id=proposal_id, operator=operator,
        proposal_type="config_write", risk="config_write",
        summary="edit config.yaml", subject="config:d3")


class TestApprovalsList:
    def test_pending_request_listed_sanitized(self, store_module):
        req = _file_request(store_module)
        handled, handler = _get("/api/hyrax/essence/approvals")
        assert handled is True
        assert handler.status == 200
        body = handler.json_body()
        assert body["pending_count"] == 1
        entry = body["pending"][0]
        assert entry["request_id"] == req["request_id"]
        assert entry["operator"] == "mai"
        assert entry["proposal_type"] == "config_write"
        assert body["respond_to"] == "/api/hyrax/essence/approvals/respond"

    def test_decided_request_leaves_pending(self, store_module):
        req = _file_request(store_module)
        store_module.respond(req["request_id"], "deny")
        handled, handler = _get("/api/hyrax/essence/approvals")
        body = handler.json_body()
        assert body["pending_count"] == 0
        assert body["recent_decisions"][0]["decision"] == "deny"
        assert body["recent_decisions"][0]["actor"] == "josh:webui"

    def test_store_unavailable_is_503_not_exception(self, monkeypatch):
        import api.hyrax_essence as essence

        monkeypatch.setattr(essence, "_josh_store_module", lambda: None)
        handled, handler = _get("/api/hyrax/essence/approvals")
        assert handled is True
        assert handler.status == 503

    def test_operator_route_still_shadowed_correctly(self, store_module):
        """The approvals path must not be swallowed by the
        /api/hyrax/essence/{operator} branch, and vice versa."""
        handled, handler = _get("/api/hyrax/essence/approvals")
        assert handled is True and handler.status == 200
        handled, handler = _get("/api/hyrax/essence/notasister")
        assert handled is True and handler.status == 404


class TestApprovalsRespond:
    def test_approve_records_josh_actor(self, store_module):
        req = _file_request(store_module)
        handled, handler = _post("/api/hyrax/essence/approvals/respond", {
            "request_id": req["request_id"], "decision": "approve"})
        assert handled is True
        assert handler.status == 200
        body = handler.json_body()
        assert body["recorded"] is True
        assert body["actor"] == "josh:webui"
        # The store holds the decision the essenced poller will act on.
        decisions = store_module.decisions()
        assert decisions[-1]["request_id"] == req["request_id"]
        assert decisions[-1]["decision"] == "approve"
        assert decisions[-1]["actor"] == "josh:webui"

    def test_deny_records(self, store_module):
        req = _file_request(store_module)
        handled, handler = _post("/api/hyrax/essence/approvals/respond", {
            "request_id": req["request_id"], "decision": "deny"})
        assert handler.status == 200
        assert store_module.decisions()[-1]["decision"] == "deny"

    def test_unknown_request_id_404(self, store_module):
        handled, handler = _post("/api/hyrax/essence/approvals/respond", {
            "request_id": "japr-000000000000", "decision": "approve"})
        assert handler.status == 404
        assert store_module.decisions() == []

    def test_already_decided_request_cannot_be_re_decided(self, store_module):
        req = _file_request(store_module)
        store_module.respond(req["request_id"], "deny")
        handled, handler = _post("/api/hyrax/essence/approvals/respond", {
            "request_id": req["request_id"], "decision": "approve"})
        assert handler.status == 404
        # The original deny stands — no second decision was appended.
        assert [d["decision"] for d in store_module.decisions()] == ["deny"]

    @pytest.mark.parametrize("body", [
        {},
        {"request_id": "japr-abcdef012345"},  # missing decision
        {"request_id": "japr-abcdef012345", "decision": "maybe"},
        {"request_id": "not-a-request-id", "decision": "approve"},
        {"request_id": "japr-abcdef012345; rm -rf /", "decision": "approve"},
        {"request_id": 123, "decision": "approve"},
        "not-a-dict",
    ])
    def test_invalid_bodies_400(self, store_module, body):
        _file_request(store_module, proposal_id="prop-x")
        handled, handler = _post(
            "/api/hyrax/essence/approvals/respond", body)
        assert handled is True
        assert handler.status == 400
        assert store_module.decisions() == []

    def test_store_unavailable_is_503(self, monkeypatch):
        import api.hyrax_essence as essence

        monkeypatch.setattr(essence, "_josh_store_module", lambda: None)
        handled, handler = _post("/api/hyrax/essence/approvals/respond", {
            "request_id": "japr-abcdef012345", "decision": "approve"})
        assert handler.status == 503
