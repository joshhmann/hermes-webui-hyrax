"""Tests for api/hyrax_ardy_ws.py — the /api/hyrax/ardy/ws WebSocket proxy.

Covers frame codec invariants (masking rules, size caps, control-frame
rules), upgrade-request validation, and an end-to-end pump over socketpairs
with a fake upstream.
"""

from __future__ import annotations

import io
import socket
import threading
from urllib.parse import urlparse

import pytest

import api.hyrax_ardy_ws as proxy


# ── Mock HTTP handler (upgrade request already parsed) ─────────────────────
class _Headers(dict):
    """dict with the email.message.Message.get_all() API the handler uses."""

    def get_all(self, name, default=None):
        if name in self:
            return [self[name]]
        return default if default is not None else []


class _Handler:
    def __init__(self, *, headers=None, connection=None, rfile=None):
        self.headers = _Headers(headers or {})
        self.path = "/api/hyrax/ardy/ws"
        self.connection = connection
        self.rfile = rfile
        self.wfile = io.BytesIO()
        self.status = None
        self.sent_headers: list[tuple[str, str]] = []
        self.close_connection = False

    def send_response(self, status):
        self.status = status

    def send_header(self, name, value):
        self.sent_headers.append((name, value))

    def end_headers(self):
        pass

    def json_status(self):
        return self.status


def _upgrade_headers(**overrides):
    headers = {
        "Upgrade": "websocket",
        "Connection": "keep-alive, Upgrade",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
    }
    headers.update(overrides)
    return headers


# ── Frame codec ────────────────────────────────────────────────────────────

def _reader_for(data: bytes):
    buf = io.BytesIO(data)
    return lambda n: proxy._read_exact_file(buf, n)


def test_frame_roundtrip_unmasked_text():
    wire = proxy._build_frame(proxy.OP_TEXT, b"hello", fin=True, mask=False)
    fin, opcode, payload = proxy._read_frame(_reader_for(wire), expect_masked=False)
    assert (fin, opcode, payload) == (True, proxy.OP_TEXT, b"hello")


def test_frame_roundtrip_masked_binary():
    wire = proxy._build_frame(proxy.OP_BINARY, b"\x00" * 300, fin=True, mask=True)
    fin, opcode, payload = proxy._read_frame(_reader_for(wire), expect_masked=True)
    assert (fin, opcode, payload) == (True, proxy.OP_BINARY, b"\x00" * 300)


def test_frame_continuation_preserved():
    wire = proxy._build_frame(proxy.OP_CONT, b"part", fin=False, mask=True)
    fin, opcode, payload = proxy._read_frame(_reader_for(wire), expect_masked=True)
    assert (fin, opcode, payload) == (False, proxy.OP_CONT, b"part")


def test_frame_rejects_unmasked_client_frame():
    wire = proxy._build_frame(proxy.OP_TEXT, b"hello", mask=False)
    with pytest.raises(proxy._FrameError):
        proxy._read_frame(_reader_for(wire), expect_masked=True)


def test_frame_rejects_masked_server_frame():
    wire = proxy._build_frame(proxy.OP_TEXT, b"hello", mask=True)
    with pytest.raises(proxy._FrameError):
        proxy._read_frame(_reader_for(wire), expect_masked=False)


def test_frame_rejects_oversized_payload():
    head = bytes([0x82, 127]) + (proxy.MAX_PAYLOAD + 1).to_bytes(8, "big")
    with pytest.raises(proxy._FrameError):
        proxy._read_frame(_reader_for(head), expect_masked=False)


def test_frame_rejects_fragmented_control():
    wire = proxy._build_frame(proxy.OP_PING, b"x", fin=False, mask=True)
    with pytest.raises(proxy._FrameError):
        proxy._read_frame(_reader_for(wire), expect_masked=True)


def test_frame_rejects_rsv_bits():
    wire = bytes([0xC1, 0x80]) + b"\x00" * 4  # RSV1 set, masked, empty text
    with pytest.raises(proxy._FrameError):
        proxy._read_frame(_reader_for(wire), expect_masked=True)


def test_frame_rejects_unknown_opcode():
    wire = proxy._build_frame(0x3, b"", mask=True)
    with pytest.raises(proxy._FrameError):
        proxy._read_frame(_reader_for(wire), expect_masked=True)


# ── Upgrade validation ─────────────────────────────────────────────────────

def test_non_upgrade_request_gets_400():
    handler = _Handler(headers={})
    assert proxy.handle_ardy_ws(handler, urlparse(handler.path)) is True
    assert handler.status == 400


def test_wrong_version_gets_426():
    handler = _Handler(headers=_upgrade_headers(**{"Sec-WebSocket-Version": "8"}))
    assert proxy.handle_ardy_ws(handler, urlparse(handler.path)) is True
    assert handler.status == 426


def test_upstream_failure_gets_502(monkeypatch):
    def _boom(url, subprotocols):
        raise ConnectionError("refused")

    monkeypatch.setattr(proxy, "_connect_upstream", _boom)
    handler = _Handler(headers=_upgrade_headers())
    assert proxy.handle_ardy_ws(handler, urlparse(handler.path)) is True
    assert handler.status == 502


# ── End-to-end pump over socketpairs ───────────────────────────────────────

def test_proxy_pumps_both_directions(monkeypatch):
    browser_a, browser_b = socket.socketpair()  # browser_b = "browser"
    upstream_a, upstream_b = socket.socketpair()  # upstream_a = "upstream"
    monkeypatch.setattr(proxy, "_connect_upstream", lambda url, subs: upstream_b)

    handler = _Handler(
        headers=_upgrade_headers(),
        connection=browser_a,
        rfile=browser_a.makefile("rb"),
    )
    done = threading.Event()

    def run():
        try:
            proxy.handle_ardy_ws(handler, urlparse(handler.path))
        finally:
            done.set()

    t = threading.Thread(target=run, daemon=True)
    t.start()

    # Browser receives the 101 upgrade response.
    response = b""
    while b"\r\n\r\n" not in response:
        response += browser_b.recv(4096)
    assert response.startswith(b"HTTP/1.1 101")
    assert b"s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" in response  # known RFC 6455 accept

    # Browser -> upstream: masked text frame must arrive upstream (masked per
    # client rules) with the payload intact.
    browser_b.sendall(proxy._build_frame(proxy.OP_TEXT, b'{"type":"hello"}', mask=True))
    fin, opcode, payload = proxy._read_frame(
        lambda n: proxy._recv_exact(upstream_a, n), expect_masked=True
    )
    assert (fin, opcode, payload) == (True, proxy.OP_TEXT, b'{"type":"hello"}')

    # Upstream -> browser: unmasked binary frame must arrive unmasked.
    upstream_a.sendall(proxy._build_frame(proxy.OP_BINARY, b"\x01\x02\x03", mask=False))
    fin, opcode, payload = proxy._read_frame(
        lambda n: proxy._recv_exact(browser_b, n), expect_masked=False
    )
    assert (fin, opcode, payload) == (True, proxy.OP_BINARY, b"\x01\x02\x03")

    # Browser closes -> proxy must forward a close upstream and tear down.
    browser_b.sendall(proxy._build_frame(proxy.OP_CLOSE, b"", mask=True))
    fin, opcode, _ = proxy._read_frame(
        lambda n: proxy._recv_exact(upstream_a, n), expect_masked=True
    )
    assert opcode == proxy.OP_CLOSE
    upstream_a.close()
    assert done.wait(timeout=10)

    browser_b.close()
    upstream_a.close()



# ── EMB-1 hardening: prompt-channel validation (unit) ──────────────────────

def _prompt_frame(text) -> bytes:
    import json as _json

    return _json.dumps({"type": "prompt", "text": text}).encode("utf-8")


def test_validate_prompt_accepts_normal_prompt():
    from collections import deque

    assert proxy._validate_prompt_frame(_prompt_frame("a person walks"), deque()) is None


def test_validate_prompt_rejects_oversized():
    from collections import deque

    reason = proxy._validate_prompt_frame(
        _prompt_frame("x" * (proxy.PROMPT_MAX_CHARS + 1)), deque()
    )
    assert reason is not None and "exceeds" in reason


def test_validate_prompt_accepts_exactly_at_cap():
    from collections import deque

    assert proxy._validate_prompt_frame(_prompt_frame("x" * proxy.PROMPT_MAX_CHARS), deque()) is None


def test_validate_prompt_rejects_control_characters():
    from collections import deque

    for bad in ("walk\x07run", "walk\x1brun", "walk\nrun", "walk​run"):
        reason = proxy._validate_prompt_frame(_prompt_frame(bad), deque())
        assert reason is not None and "control" in reason, bad


def test_validate_prompt_rejects_empty_or_nonstring_text():
    from collections import deque

    assert proxy._validate_prompt_frame(_prompt_frame("   "), deque()) is not None
    assert proxy._validate_prompt_frame(_prompt_frame(42), deque()) is not None
    assert proxy._validate_prompt_frame(b'{"type":"prompt"}', deque()) is not None


def test_validate_prompt_ignores_other_control_messages_and_fragments():
    from collections import deque

    assert proxy._validate_prompt_frame(b'{"type":"reset"}', deque()) is None
    assert proxy._validate_prompt_frame(b'{"type":"ping"}', deque()) is None
    assert proxy._validate_prompt_frame(b'{"type":"prompt"', deque()) is None  # fragment
    assert proxy._validate_prompt_frame(b"\x00\x01binary", deque()) is None


def test_validate_prompt_rate_cap(monkeypatch):
    from collections import deque

    times = deque()
    for _ in range(proxy.PROMPT_RATE_MAX):
        assert proxy._validate_prompt_frame(_prompt_frame("walk"), times) is None
    reason = proxy._validate_prompt_frame(_prompt_frame("walk"), times)
    assert reason is not None and "rate" in reason


def test_validate_prompt_rate_window_expires(monkeypatch):
    from collections import deque

    now = 1000.0
    monkeypatch.setattr(proxy.time, "monotonic", lambda: now)
    times = deque()
    for _ in range(proxy.PROMPT_RATE_MAX):
        assert proxy._validate_prompt_frame(_prompt_frame("walk"), times) is None
    # Past the window, the old stamps age out and a new prompt is accepted.
    now += proxy.PROMPT_RATE_WINDOW_S + 1
    assert proxy._validate_prompt_frame(_prompt_frame("walk"), times) is None


# ── EMB-1 hardening: multi-consumer policy + prompt rejection (end-to-end) ──

def _read_http_head(sock_file) -> bytes:
    head = b""
    while b"\r\n\r\n" not in head:
        head += sock_file.readline()
    return head


def _start_session(monkeypatch, upstream_url):
    """Run one proxied session over socketpairs. Returns (browser, upstream, done)."""
    monkeypatch.setenv("HYRAX_ARDY_WS_UPSTREAM", upstream_url)
    browser_a, browser_b = socket.socketpair()
    upstream_a, upstream_b = socket.socketpair()
    monkeypatch.setattr(proxy, "_connect_upstream", lambda url, subs: upstream_b)
    handler = _Handler(
        headers=_upgrade_headers(),
        connection=browser_a,
        rfile=browser_a.makefile("rb"),
    )
    done = threading.Event()

    def run():
        try:
            proxy.handle_ardy_ws(handler, urlparse(handler.path))
        finally:
            done.set()

    threading.Thread(target=run, daemon=True).start()
    head = _read_http_head(browser_b.makefile("rb"))
    assert head.startswith(b"HTTP/1.1 101"), head
    return browser_b, upstream_a, done


def test_second_concurrent_session_gets_1013_close(monkeypatch):
    url = "ws://upstream.invalid/busy"
    browser1, upstream1, done1 = _start_session(monkeypatch, url)
    try:
        # Second session to the same upstream: upgraded, then immediately
        # closed with 1013 + reason (409 semantics over WS).
        browser2 = socket.socketpair()
        handler2 = _Handler(headers=_upgrade_headers(), connection=browser2[0])
        assert proxy.handle_ardy_ws(handler2, urlparse(handler2.path)) is True
        browser2_file = browser2[1].makefile("rb")
        head = _read_http_head(browser2_file)
        assert head.startswith(b"HTTP/1.1 101"), head
        fin, opcode, payload = proxy._read_frame(
            lambda n: proxy._read_exact_file(browser2_file, n), expect_masked=False
        )
        assert (fin, opcode) == (True, proxy.OP_CLOSE)
        code = int.from_bytes(payload[:2], "big")
        assert code == proxy.BUSY_CLOSE_CODE
        assert b"busy" in payload[2:]
        browser2[0].close()
        browser2[1].close()
    finally:
        browser1.sendall(proxy._build_frame(proxy.OP_CLOSE, b"", mask=True))
        assert done1.wait(timeout=10)
        browser1.close()
        upstream1.close()


def test_session_slot_released_after_teardown(monkeypatch):
    url = "ws://upstream.invalid/reuse"
    browser1, upstream1, done1 = _start_session(monkeypatch, url)
    browser1.sendall(proxy._build_frame(proxy.OP_CLOSE, b"", mask=True))
    assert done1.wait(timeout=10)
    browser1.close()
    upstream1.close()

    # The slot is free again: a fresh session is proxied, not refused.
    browser2, upstream2, done2 = _start_session(monkeypatch, url)
    browser2.sendall(proxy._build_frame(proxy.OP_TEXT, b'{"type":"ping"}', mask=True))
    fin, opcode, payload = proxy._read_frame(
        lambda n: proxy._recv_exact(upstream2, n), expect_masked=True
    )
    assert (fin, opcode, payload) == (True, proxy.OP_TEXT, b'{"type":"ping"}')
    browser2.sendall(proxy._build_frame(proxy.OP_CLOSE, b"", mask=True))
    assert done2.wait(timeout=10)
    browser2.close()
    upstream2.close()


def test_session_slot_released_on_upstream_connect_failure(monkeypatch):
    url = "ws://upstream.invalid/down"
    monkeypatch.setenv("HYRAX_ARDY_WS_UPSTREAM", url)

    def _boom(u, subs):
        raise ConnectionError("refused")

    monkeypatch.setattr(proxy, "_connect_upstream", _boom)
    for _ in range(2):
        handler = _Handler(headers=_upgrade_headers())
        assert proxy.handle_ardy_ws(handler, urlparse(handler.path)) is True
        assert handler.status == 502  # not mistaken for a busy slot on retry


def test_valid_prompt_forwarded_upstream(monkeypatch):
    url = "ws://upstream.invalid/prompt-ok"
    browser, upstream, done = _start_session(monkeypatch, url)
    frame = _prompt_frame("a person waves")
    browser.sendall(proxy._build_frame(proxy.OP_TEXT, frame, mask=True))
    fin, opcode, payload = proxy._read_frame(
        lambda n: proxy._recv_exact(upstream, n), expect_masked=True
    )
    assert (fin, opcode, payload) == (True, proxy.OP_TEXT, frame)
    browser.sendall(proxy._build_frame(proxy.OP_CLOSE, b"", mask=True))
    assert done.wait(timeout=10)
    browser.close()
    upstream.close()


def test_rejected_prompt_closes_both_legs_with_1008(monkeypatch):
    url = "ws://upstream.invalid/prompt-bad"
    browser, upstream, done = _start_session(monkeypatch, url)
    oversized = _prompt_frame("x" * (proxy.PROMPT_MAX_CHARS + 1))
    browser.sendall(proxy._build_frame(proxy.OP_TEXT, oversized, mask=True))

    browser_file = browser.makefile("rb")
    fin, opcode, payload = proxy._read_frame(
        lambda n: proxy._read_exact_file(browser_file, n), expect_masked=False
    )
    assert (fin, opcode) == (True, proxy.OP_CLOSE)
    assert int.from_bytes(payload[:2], "big") == proxy.PROMPT_REJECT_CLOSE_CODE
    assert b"exceeds" in payload[2:]

    fin, opcode, payload = proxy._read_frame(
        lambda n: proxy._recv_exact(upstream, n), expect_masked=True
    )
    assert opcode == proxy.OP_CLOSE
    assert int.from_bytes(payload[:2], "big") == proxy.PROMPT_REJECT_CLOSE_CODE

    assert done.wait(timeout=10)
    browser.close()
    upstream.close()
