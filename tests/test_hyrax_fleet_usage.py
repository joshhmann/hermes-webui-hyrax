"""Tests for GET /api/hyrax/fleet-usage (api/hyrax_routes.py).

Covers the router-ledger aggregation:
  - totals: requests, errors (upstream_status != 200), null-safe token sums
  - fallback pricing for deepseek-v4-flash rows with null estimated_cost_usd
    (off-peak vs peak UTC windows 01:00-04:00 / 06:00-10:00)
  - local/local_reasoning priced $0, codex/luna (gpt-5.6-luna) subscription
    rows unpriced but token-counted
  - per-day series is zero-filled across the window; rows older than the
    window are excluded; malformed rows/lines counted as skipped
  - the HTTP handler serves the env-overridden ledger and fails closed to an
    empty aggregation when the ledger is missing
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


@pytest.fixture(autouse=True)
def isolate_auth(monkeypatch):
    monkeypatch.setattr(auth, "STATE_DIR", "/tmp/__test_hyrax_fleet_usage_auth")
    monkeypatch.setattr(auth, "_SESSIONS_FILE", "/tmp/__test_hyrax_fleet_usage_auth/.sessions.json")
    monkeypatch.setattr(auth, "is_password_auth_enabled", lambda: False)
    monkeypatch.setattr(auth, "are_passkeys_enabled", lambda: False)
    monkeypatch.setattr(auth, "is_oidc_auth_enabled", lambda: False)
    monkeypatch.setattr(auth, "is_trusted_auth_enabled", lambda: False)
    auth._sessions.clear()
    auth._TRUSTED_AUTH_WARNINGS_EMITTED.clear()
    yield
    auth._sessions.clear()
    auth._TRUSTED_AUTH_WARNINGS_EMITTED.clear()


NOW = hyrax.datetime(2026, 8, 19, 12, 0, 0, tzinfo=hyrax.timezone.utc)


def _row(ts, provider, model, status=200, inp=None, cached=None, out=None, cost=None):
    return {
        "timestamp": ts,
        "selected_provider": provider,
        "selected_model": model,
        "upstream_status": status,
        "input_tokens": inp,
        "cached_input_tokens": cached,
        "output_tokens": out,
        "estimated_cost_usd": cost,
        "latency_ms": 100.0,
    }


FIXTURE_ROWS = [
    # priced by ledger estimate (off-peak)
    _row("2026-08-19T11:00:00Z", "deepseek", "deepseek-v4-flash",
         inp=1000, cached=200, out=100, cost=0.001),
    # null estimate → fallback, off-peak (11:00 UTC):
    #   cached 1M * 0.007 + miss 1M * 0.22 + out 1M * 0.66 = $0.887
    _row("2026-08-19T11:30:00Z", "deepseek", "deepseek-v4-flash",
         inp=2_000_000, cached=1_000_000, out=1_000_000),
    # null estimate → fallback, peak (02:00 UTC):
    #   miss 1M * 0.44 + out 1M * 1.32 = $1.76
    _row("2026-08-19T02:00:00Z", "deepseek", "deepseek-v4-flash",
         inp=1_000_000, cached=0, out=1_000_000),
    # upstream error, all token/cost fields null — counted, no tokens
    _row("2026-08-19T10:00:00Z", "deepseek", "deepseek-v4-flash", status=400),
    # local: free, tokens counted
    _row("2026-08-19T09:00:00Z", "local", "gemma4-qat-12b:latest",
         inp=500, out=50),
    # codex: subscription — unpriced, tokens counted
    _row("2026-08-19T08:00:00Z", "codex", "gpt-5.6-luna",
         inp=700, out=70),
    # outside the 7-day window — excluded
    _row("2026-08-01T00:00:00Z", "deepseek", "deepseek-v4-flash",
         inp=9_000_000, out=9_000_000, cost=9.0),
]


class TestAggregateFleetUsage:
    def test_totals_null_safe(self):
        out = hyrax.aggregate_fleet_usage(FIXTURE_ROWS, 7, now=NOW)
        t = out["totals"]
        assert t["requests"] == 6  # the 08-01 row is outside the window
        assert t["errors"] == 1
        assert t["input_tokens"] == 1000 + 2_000_000 + 1_000_000 + 500 + 700
        assert t["cached_input_tokens"] == 200 + 1_000_000
        assert t["output_tokens"] == 100 + 1_000_000 + 1_000_000 + 50 + 70

    def test_fallback_pricing_peak_and_off_peak(self):
        out = hyrax.aggregate_fleet_usage(FIXTURE_ROWS, 7, now=NOW)
        expected = 0.001 + 0.887 + 1.76
        assert out["totals"]["cost_usd"] == pytest.approx(expected, abs=1e-6)

    def test_unpriced_rows_counted(self):
        out = hyrax.aggregate_fleet_usage(FIXTURE_ROWS, 7, now=NOW)
        # codex subscription row has no price; the deepseek error row has no
        # tokens and prices to $0 via the fallback (priced, not unpriced).
        assert out["totals"]["cost_unpriced"] == 1

    def test_per_provider_pricing_classes(self):
        out = hyrax.aggregate_fleet_usage(FIXTURE_ROWS, 7, now=NOW)
        by_name = {p["provider"]: p for p in out["per_provider"]}
        assert by_name["deepseek"]["pricing"] == "metered"
        assert by_name["local"]["pricing"] == "free"
        assert by_name["local"]["cost_usd"] == 0.0
        assert by_name["codex"]["pricing"] == "subscription"
        assert by_name["codex"]["cost_unpriced"] == 1
        assert by_name["codex"]["input_tokens"] == 700

    def test_per_model_breakdown(self):
        out = hyrax.aggregate_fleet_usage(FIXTURE_ROWS, 7, now=NOW)
        keys = {m["key"] for m in out["per_model"]}
        assert "deepseek/deepseek-v4-flash" in keys
        assert "codex/gpt-5.6-luna" in keys
        assert "local/gemma4-qat-12b:latest" in keys

    def test_per_day_zero_filled_and_filtered(self):
        out = hyrax.aggregate_fleet_usage(FIXTURE_ROWS, 7, now=NOW)
        days = [d["date"] for d in out["per_day"]]
        assert days[0] == "2026-08-12"  # cutoff date
        assert days[-1] == "2026-08-19"
        assert len(days) == 8
        by_date = {d["date"]: d for d in out["per_day"]}
        assert by_date["2026-08-19"]["requests"] == 6
        assert by_date["2026-08-12"]["requests"] == 0
        assert "2026-08-01" not in by_date  # outside window entirely

    def test_malformed_rows_skipped(self):
        rows = FIXTURE_ROWS + [None, {"no_timestamp": True}, "garbage"]
        out = hyrax.aggregate_fleet_usage(rows, 7, now=NOW)
        assert out["skipped_rows"] == 3
        assert out["totals"]["requests"] == 6

    def test_days_clamped(self):
        out = hyrax.aggregate_fleet_usage(FIXTURE_ROWS, 9999, now=NOW)
        assert out["window"]["days"] == hyrax._FLEET_USAGE_DAYS_MAX
        out = hyrax.aggregate_fleet_usage(FIXTURE_ROWS, 0, now=NOW)
        assert out["window"]["days"] == 1

    def test_note_present(self):
        out = hyrax.aggregate_fleet_usage(FIXTURE_ROWS, 7, now=NOW)
        assert out["note"] == hyrax.FLEET_USAGE_NOTE


# ══════════════════════════════════════════════════════════════════════════
# HTTP handler — env-overridden ledger path
# ══════════════════════════════════════════════════════════════════════════

def _write_ledger(path, rows, extra_lines=()):
    lines = [json.dumps(r) for r in rows] + list(extra_lines)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _call_get(handler, path, query=""):
    parsed = SimpleNamespace(path=path, query=query)
    return hyrax.handle_hyrax_get(handler, parsed)


class TestFleetUsageEndpoint:
    def test_serves_ledger(self, tmp_path, monkeypatch):
        ledger = tmp_path / "requests.jsonl"
        _write_ledger(ledger, FIXTURE_ROWS, extra_lines=["{not json"])
        monkeypatch.setenv("HERMES_ROUTER_LEDGER", str(ledger))
        handler = _Handler()
        handled = _call_get(handler, "/api/hyrax/fleet-usage", "days=30")
        assert handled is True
        assert handler.status == 200
        body = handler.json_body()
        # days=30 against real now: all fixture rows are inside the window,
        # including the 08-01 row the 7-day aggregation tests exclude.
        assert body["totals"]["requests"] == 7
        assert body["totals"]["errors"] == 1
        assert body["skipped_rows"] == 1
        assert body["window"]["days"] == 30
        assert body["note"] == hyrax.FLEET_USAGE_NOTE

    def test_missing_ledger_fails_closed_empty(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HERMES_ROUTER_LEDGER", str(tmp_path / "absent.jsonl"))
        handler = _Handler()
        handled = _call_get(handler, "/api/hyrax/fleet-usage", "days=7")
        assert handled is True
        assert handler.status == 200
        body = handler.json_body()
        assert body["totals"]["requests"] == 0
        assert body["totals"]["cost_usd"] == 0.0
        assert len(body["per_day"]) >= 1  # zero-filled series still present

    def test_bad_days_param_defaults(self, tmp_path, monkeypatch):
        ledger = tmp_path / "requests.jsonl"
        _write_ledger(ledger, FIXTURE_ROWS)
        monkeypatch.setenv("HERMES_ROUTER_LEDGER", str(ledger))
        handler = _Handler()
        _call_get(handler, "/api/hyrax/fleet-usage", "days=banana")
        assert handler.status == 200
        assert handler.json_body()["window"]["days"] == hyrax._FLEET_USAGE_DAYS_DEFAULT
