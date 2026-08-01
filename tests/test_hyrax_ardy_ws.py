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
