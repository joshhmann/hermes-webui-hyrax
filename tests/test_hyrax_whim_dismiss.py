"""Tests for the HQ whims panel dismiss surface
(api/hyrax_essence.py: POST /api/hyrax/essence/whims/dismiss).

RULES (match tests/test_hyrax_josh_approvals.py):
- Fake handlers only; no real HTTP, no real governance state.
- Hermetic: the store module is the REAL governance/whim_dismissals.py
  loaded against a tmp store dir (ESSENCED_GOVERNANCE_DIR redirect); the
  operator's derived_state.json lives under tmp_path. No dependency on
  live /root/.hermes state.
"""

from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

GOVERNANCE_STORE_SRC = Path("/root/.hermes/governance/whim_dismissals.py")

WHIM_ID = "show-off-build-1785000000"


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
    """The REAL whim_dismissals.py loaded against a tmp governance dir,
    injected into api.hyrax_essence (loader monkeypatched, never the FS)."""
    import api.hyrax_essence as essence

    monkeypatch.setenv("ESSENCED_GOVERNANCE_DIR", str(tmp_path))
    spec = importlib.util.spec_from_file_location(
        "test_whim_dismissals_store", GOVERNANCE_STORE_SRC)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(essence, "_whim_dismiss_store_module", lambda: module)
    return module


@pytest.fixture()
def active_whim(tmp_path, monkeypatch):
    """A sister profile home whose derived_state.json has WHIM_ID active."""
    import api.hyrax_essence as essence

    home = tmp_path / "profiles" / "mai"
    (home / "essence").mkdir(parents=True)
    (home / "essence" / "derived_state.json").write_text(json.dumps({
        "version": 2,
        "meta": {"whims": {"active": [{
            "whim_id": WHIM_ID,
            "text": "show off the gateway map",
            "object": "the waiting task \"review the gateway map\"",
            "drawn_at": 1785000000.0, "fired_at": 1785000060.0,
        }], "fulfilled_total": 3}},
    }))
    monkeypatch.setattr(essence, "_profile_home", lambda op: home)
    return home


def _post(body, path="/api/hyrax/essence/whims/dismiss"):
    import api.hyrax_essence as essence

    handler = _Handler()
    parsed = SimpleNamespace(path=path, query="")
    handled = essence.handle_essence_post(handler, parsed, body)
    return handled, handler


class TestWhimDismiss:
    def test_happy_path_files_request_with_josh_actor(
            self, store_module, active_whim):
        handled, handler = _post({"operator": "mai", "whim_id": WHIM_ID})
        assert handled is True
        assert handler.status == 200
        body = handler.json_body()
        assert body["recorded"] is True
        assert body["actor"] == "josh"
        assert body["operator"] == "mai"
        assert body["whim_id"] == WHIM_ID
        assert body["request_id"].startswith("wdis-")
        assert body["status"] == "pending"
        # The store holds the request the essenced poll will act on.
        pending = store_module.pending_requests(operator="mai")
        assert len(pending) == 1
        assert pending[0]["whim_id"] == WHIM_ID
        assert pending[0]["actor"] == "josh"

    def test_repeat_dismiss_while_pending_is_idempotent(
            self, store_module, active_whim):
        """A double-click files ONE store line; the second POST returns
        the same request id."""
        _, first = _post({"operator": "mai", "whim_id": WHIM_ID})
        _, second = _post({"operator": "mai", "whim_id": WHIM_ID})
        assert first.status == 200 and second.status == 200
        assert first.json_body()["request_id"] \
            == second.json_body()["request_id"]
        assert len(store_module.pending_requests(operator="mai")) == 1

    def test_non_active_whim_404_fail_closed(self, store_module, active_whim):
        """Idempotent veto: an unknown/already-closed whim is a no-op with
        a clear reason — nothing is appended to the store."""
        handled, handler = _post({
            "operator": "mai", "whim_id": "other-whim-1785000000"})
        assert handled is True
        assert handler.status == 404
        assert "not active" in handler.json_body()["error"]
        assert store_module.pending_requests() == []

    def test_missing_derived_state_404(self, store_module, tmp_path,
                                       monkeypatch):
        """No readable state = no verifiable active whim = fail closed."""
        import api.hyrax_essence as essence

        monkeypatch.setattr(
            essence, "_profile_home", lambda op: tmp_path / "nohome")
        handled, handler = _post({"operator": "mai", "whim_id": WHIM_ID})
        assert handler.status == 404
        assert store_module.pending_requests() == []

    def test_unknown_operator_400(self, store_module, active_whim):
        for bad in ("nobody", "../mai", "mai/essence", "MAI"):
            handled, handler = _post({"operator": bad, "whim_id": WHIM_ID})
            assert handled is True
            assert handler.status == 400, bad
        assert store_module.pending_requests() == []

    @pytest.mark.parametrize("whim_id", [
        "no-epoch",
        "show-off-build",                     # template id only
        "show-off-build-abc",                 # non-numeric suffix
        "show-off-build-1785000000; rm -rf /",
        "show-off-build-1785000000/extra",
        "../show-off-build-1785000000",
        "show-off-build-1785000000" + "x" * 40,  # over length cap
        "UPPER-CASE-1785000000",
        1785000000,                           # not a string
        "",
    ])
    def test_invalid_whim_id_400(self, store_module, active_whim, whim_id):
        handled, handler = _post({"operator": "mai", "whim_id": whim_id})
        assert handled is True
        assert handler.status == 400
        assert store_module.pending_requests() == []

    @pytest.mark.parametrize("body", [
        {},
        {"operator": "mai"},                  # missing whim_id
        {"whim_id": WHIM_ID},                 # missing operator
        {"operator": "mai", "whim_id": WHIM_ID, "actor": "mallory"},
        {"operator": "mai", "whim_id": WHIM_ID, "extra": 1},
        "not-a-dict",
        [1, 2, 3],
    ])
    def test_invalid_bodies_400(self, store_module, active_whim, body):
        handled, handler = _post(body)
        assert handled is True
        assert handler.status == 400
        assert store_module.pending_requests() == []

    def test_store_unavailable_503(self, monkeypatch, active_whim):
        import api.hyrax_essence as essence

        monkeypatch.setattr(essence, "_whim_dismiss_store_module",
                            lambda: None)
        handled, handler = _post({"operator": "mai", "whim_id": WHIM_ID})
        assert handled is True
        assert handler.status == 503

    def test_store_raise_503(self, store_module, active_whim, monkeypatch):
        def _boom(*a, **kw):
            raise OSError("disk gone")
        monkeypatch.setattr(store_module, "request", _boom)
        handled, handler = _post({"operator": "mai", "whim_id": WHIM_ID})
        assert handler.status == 503

    def test_dismiss_path_not_shadowed_by_operator_route(
            self, store_module, active_whim):
        """GET /api/hyrax/essence/whims/dismiss must not resolve as the
        {operator} route (single-segment allowlist), and 'whims' is not a
        sister."""
        import api.hyrax_essence as essence

        handler = _Handler()
        parsed = SimpleNamespace(
            path="/api/hyrax/essence/whims/dismiss", query="")
        assert essence.handle_essence_get(handler, parsed) is True
        assert handler.status == 404

    def test_route_registered_in_hyrax_post_dispatch(self):
        """The path must be in api.hyrax_routes' POST dispatch tuple —
        auth + CSRF run in api.routes before this dispatch (same as the
        register/respond routes)."""
        import api.hyrax_routes as routes
        import inspect
        src = inspect.getsource(routes.handle_hyrax_post)
        assert '"/api/hyrax/essence/whims/dismiss"' in src
