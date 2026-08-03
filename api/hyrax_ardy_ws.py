"""
/api/hyrax/ardy/ws — same-origin WebSocket proxy for the ARDY motion stream.

The loft's ArdyMotionSource used to dial the upstream service directly at a
LAN address (ws://192.168.0.17:8791/ws), which is unreachable for browsers
viewing the WebUI over Tailscale/cellular. This endpoint upgrades the
browser's connection and pumps RFC 6455 frames to/from the upstream, so the
stream works on any route that can reach the WebUI itself.

Auth: identical to every other /api/hyrax/* endpoint — server.py's do_GET
runs check_auth() (session cookie; admits everyone when auth is disabled)
before dispatch reaches this module.

Stdlib-only framing (no websocket-client / websockets in the venv):
  - browser leg: frames MUST be masked (fail closed otherwise); forwarded
    upstream re-masked with a fresh key, since the proxy is itself a client
    on the upstream leg.
  - upstream leg: frames MUST be unmasked (fail closed otherwise); forwarded
    to the browser unmasked.
  - 16 MiB max payload; RSV bits, control-frame rules, and unknown opcodes
    are validated; malformed frames close the session (fail closed).
  - text/binary/continuation frames are forwarded 1:1 preserving FIN/opcode;
    ping/pong/close are forwarded to the far side.

Threading: the WebUI runs ThreadingHTTPServer (one OS thread per request,
daemon threads). The request thread runs the upstream→browser pump and
spawns one helper thread for browser→upstream. A proxied connection
therefore costs one request thread + one helper thread, both released when
either side closes or errors. The browser socket is left blocking (a
timed-out socket makefile is unusable afterwards); dead tabs are reaped by
TCP keepalive and by upstream→browser write failures. The upstream socket
has a recv timeout that drives keepalive pings and eventually closes an
idle-dead session.

Policies (EMB-1 spec, hardening gaps 4+5):
  - multi-consumer: one concurrent proxied session per upstream URL; a second
    browser is upgraded then immediately closed with 1013 + reason.
  - prompt channel: {"type": "prompt"} text frames are length-capped
    (PROMPT_MAX_CHARS), rate-capped (PROMPT_RATE_MAX per
    PROMPT_RATE_WINDOW_S), and control-character-free; a rejected prompt
    closes the session with 1008 + reason on both legs.
"""

import base64
import hashlib
import json
import logging
import os
import secrets
import socket
import ssl
import struct
import threading
import time
import unicodedata
from collections import deque

from api.helpers import j

_logger = logging.getLogger(__name__)

_DEFAULT_UPSTREAM = "ws://192.168.0.17:8791/ws"
_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

MAX_PAYLOAD = 16 * 1024 * 1024  # 16 MiB — far above any GCP1 chunk
CONNECT_TIMEOUT_S = 10
UPSTREAM_RECV_TIMEOUT_S = 60   # drives keepalive pings to the upstream
UPSTREAM_IDLE_STRIKES = 5      # 5 consecutive idle timeouts (~5 min) -> close
_MAX_HANDSHAKE_BYTES = 64 * 1024

# Multi-consumer policy (EMB-1 spec, hardening gap 4 — fail-closed default):
# exactly one concurrent proxied session per upstream URL. The gestalt-ardy
# service does not multiplex consumers over one session, and two independent
# upstream sessions would race the GPU producer. A second browser is refused
# with 409 semantics expressed over WebSocket: the proxy completes the
# upgrade, then immediately closes with 1013 (Try Again Later) + reason, so
# the client's backoff retries attach once the first session ends.
BUSY_CLOSE_CODE = 1013  # Try Again Later (RFC 6455 §7.4.1)
BUSY_CLOSE_REASON = "ardy upstream busy: another session is active"
_active_upstreams: set[str] = set()
_active_upstreams_lock = threading.Lock()

# Prompt-channel abuse bounds (EMB-1 spec, hardening gap 5): motion prompts
# are operator input crossing into a GPU service that trusts its LAN clients.
# Text frames carrying {"type": "prompt"} are validated at the proxy; a
# rejected prompt closes the session with 1008 (policy violation) + reason.
PROMPT_MAX_CHARS = 512
# Rate cap calibration (2026-08-02, live evidence): the cap was 5/10s, sized
# for human/shuffle input before the goal planner (spatial layer 3b) existed.
# The SYSTEM is now a first-party prompt source: planner turn/walk steering
# bursts ~4/10s, plus reflex reaction+restore (2), reconnect re-kicks (1),
# and user prompts (1-2) — legitimate combined traffic reaches ~9/10s, and
# the 5/10s cap was killing healthy sessions mid-goal (1008 → offline →
# reconnect re-kick storm, measured live). 12/10s covers first-party traffic
# with margin while still binding abuse (each prompt costs a GPU re-encode).
PROMPT_RATE_MAX = 12         # prompts per window per connection
PROMPT_RATE_WINDOW_S = 10.0
PROMPT_REJECT_CLOSE_CODE = 1008  # policy violation (RFC 6455 §7.4.1)
_MAX_CLOSE_REASON_BYTES = 123    # close payload cap is 125; 2 bytes are the code

# Opcodes
OP_CONT, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA
_DATA_OPCODES = {OP_CONT, OP_TEXT, OP_BINARY}
_CONTROL_OPCODES = {OP_CLOSE, OP_PING, OP_PONG}
_ALL_OPCODES = _DATA_OPCODES | _CONTROL_OPCODES


class _FrameError(Exception):
    """Malformed frame / protocol violation. Always fails closed."""


def _accept_key(sec_key: str) -> str:
    digest = hashlib.sha1((sec_key + _WS_GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


def _build_frame(opcode: int, payload: bytes, *, fin: bool = True, mask: bool = False) -> bytes:
    head = bytes([(0x80 if fin else 0) | opcode])
    mask_bit = 0x80 if mask else 0
    n = len(payload)
    if n < 126:
        head += bytes([mask_bit | n])
    elif n <= 0xFFFF:
        head += bytes([mask_bit | 126]) + struct.pack(">H", n)
    else:
        head += bytes([mask_bit | 127]) + struct.pack(">Q", n)
    if not mask:
        return head + payload
    key = secrets.token_bytes(4)
    masked = bytes(b ^ key[i % 4] for i, b in enumerate(payload))
    return head + key + masked


def _read_frame(read_exact, *, expect_masked: bool):
    """Parse one frame. read_exact(n) -> bytes (exactly n, or raises).

    Returns (fin, opcode, payload). Raises _FrameError on any violation.
    """
    header = read_exact(2)
    b0, b1 = header[0], header[1]
    fin = bool(b0 & 0x80)
    if b0 & 0x70:
        raise _FrameError("RSV bits set (no extensions negotiated)")
    opcode = b0 & 0x0F
    if opcode not in _ALL_OPCODES:
        raise _FrameError(f"unknown opcode {opcode:#x}")
    masked = bool(b1 & 0x80)
    if masked != expect_masked:
        raise _FrameError("mask bit mismatch")
    length = b1 & 0x7F
    if length == 126:
        length = struct.unpack(">H", read_exact(2))[0]
    elif length == 127:
        length = struct.unpack(">Q", read_exact(8))[0]
        if length & (1 << 63):
            raise _FrameError("64-bit length with MSB set")
    if opcode in _CONTROL_OPCODES:
        if not fin:
            raise _FrameError("fragmented control frame")
        if length > 125:
            raise _FrameError("oversized control frame")
    if length > MAX_PAYLOAD:
        raise _FrameError(f"payload {length} exceeds {MAX_PAYLOAD}")
    mask_key = read_exact(4) if masked else b""
    payload = read_exact(length) if length else b""
    if masked:
        payload = bytes(b ^ mask_key[i % 4] for i, b in enumerate(payload))
    return fin, opcode, payload


def _recv_exact(sock: socket.socket, n: int) -> bytes:
    """Exactly n bytes from a raw socket (or raises). EOF -> ConnectionError."""
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("upstream closed")
        buf += chunk
    return bytes(buf)


def _read_exact_file(rfile, n: int) -> bytes:
    """Exactly n bytes from a buffered reader. EOF -> ConnectionError."""
    data = rfile.read(n)
    if data is None or len(data) < n:
        raise ConnectionError("browser closed")
    return data


def _connect_upstream(url: str, subprotocols: str | None):
    """Client-side RFC 6455 handshake against the upstream. Returns the socket."""
    from urllib.parse import urlsplit

    parts = urlsplit(url)
    if parts.scheme not in ("ws", "wss"):
        raise ValueError(f"unsupported upstream scheme {parts.scheme!r}")
    host = parts.hostname
    if not host:
        raise ValueError("upstream URL has no host")
    port = parts.port or (443 if parts.scheme == "wss" else 80)
    resource = parts.path or "/"
    if parts.query:
        resource += "?" + parts.query

    sock = socket.create_connection((host, port), timeout=CONNECT_TIMEOUT_S)
    if parts.scheme == "wss":
        sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host)

    key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
    lines = [
        f"GET {resource} HTTP/1.1",
        f"Host: {host}:{port}",
        "Upgrade: websocket",
        "Connection: Upgrade",
        f"Sec-WebSocket-Key: {key}",
        "Sec-WebSocket-Version: 13",
    ]
    if subprotocols:
        lines.append(f"Sec-WebSocket-Protocol: {subprotocols}")
    request = "\r\n".join(lines) + "\r\n\r\n"
    sock.sendall(request.encode("ascii"))

    response = bytearray()
    while b"\r\n\r\n" not in response:
        chunk = sock.recv(4096)
        if not chunk:
            raise ConnectionError("upstream closed during handshake")
        response += chunk
        if len(response) > _MAX_HANDSHAKE_BYTES:
            raise _FrameError("upstream handshake response too large")
    head, _, leftover = bytes(response).partition(b"\r\n\r\n")
    lines = head.decode("iso-8859-1").split("\r\n")
    if " 101 " not in lines[0]:
        raise ConnectionError(f"upstream refused upgrade: {lines[0]}")
    headers = {}
    for line in lines[1:]:
        name, _, value = line.partition(":")
        headers[name.strip().lower()] = value.strip()
    if headers.get("sec-websocket-accept") != _accept_key(key):
        raise ConnectionError("upstream Sec-WebSocket-Accept mismatch")
    # The upstream must not pre-buffer frames inside the handshake read —
    # ARDY sends nothing before our hello, but fail closed if one ever does.
    if leftover:
        raise _FrameError("upstream sent data before handshake completed")
    return sock


def _send_locked(lock: threading.Lock, sock: socket.socket, data: bytes) -> None:
    with lock:
        sock.sendall(data)


def _try_acquire_upstream(url: str) -> bool:
    """Take the single-session slot for this upstream (multi-consumer policy)."""
    with _active_upstreams_lock:
        if url in _active_upstreams:
            return False
        _active_upstreams.add(url)
        return True


def _release_upstream(url: str) -> None:
    with _active_upstreams_lock:
        _active_upstreams.discard(url)


def _close_payload(code: int, reason: str) -> bytes:
    return struct.pack(">H", code) + reason.encode("utf-8")[: _MAX_CLOSE_REASON_BYTES]


def _validate_prompt_frame(payload: bytes, prompt_times: deque) -> str | None:
    """Prompt-channel abuse bounds. Returns a rejection reason, or None.

    Only complete JSON control messages with "type": "prompt" are judged —
    anything that does not parse as JSON (a binary frame's bytes, a fragment
    of a split message) is not a prompt and passes through untouched.
    """
    try:
        message = json.loads(payload)
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(message, dict) or message.get("type") != "prompt":
        return None
    text = message.get("text")
    if not isinstance(text, str) or not text.strip():
        return "prompt text must be a non-empty string"
    if len(text) > PROMPT_MAX_CHARS:
        return f"prompt exceeds {PROMPT_MAX_CHARS} characters"
    if any(unicodedata.category(ch) in ("Cc", "Cf", "Cs") for ch in text):
        return "prompt contains control characters"
    now = time.monotonic()
    while prompt_times and now - prompt_times[0] > PROMPT_RATE_WINDOW_S:
        prompt_times.popleft()
    if len(prompt_times) >= PROMPT_RATE_MAX:
        return f"prompt rate limit exceeded ({PROMPT_RATE_MAX} per {PROMPT_RATE_WINDOW_S:.0f}s)"
    prompt_times.append(now)
    return None


def _enable_keepalive(sock: socket.socket) -> None:
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        if hasattr(socket, "TCP_KEEPIDLE"):
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, 60)
        if hasattr(socket, "TCP_KEEPINTVL"):
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, 15)
        if hasattr(socket, "TCP_KEEPCNT"):
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPCNT, 4)
    except OSError:
        pass  # keepalive is best-effort dead-peer detection


def handle_ardy_ws(handler, parsed) -> bool:
    """Handle GET /api/hyrax/ardy/ws as a WebSocket upgrade. Always returns True."""
    headers = handler.headers

    # ── Validate the browser's upgrade request (fail closed) ──
    connection_tokens = {
        token.strip().lower()
        for value in headers.get_all("Connection", [])
        for token in value.split(",")
    }
    upgrade = headers.get("Upgrade", "").lower()
    sec_key = headers.get("Sec-WebSocket-Key", "")
    version = headers.get("Sec-WebSocket-Version", "")
    if upgrade != "websocket" or "upgrade" not in connection_tokens or not sec_key:
        j(handler, {"error": "expected a WebSocket upgrade request"}, status=400)
        return True
    if version != "13":
        j(handler, {"error": "unsupported WebSocket version"}, status=426)
        return True

    # ── Connect + handshake with the upstream ──
    upstream_url = os.environ.get("HYRAX_ARDY_WS_UPSTREAM") or _DEFAULT_UPSTREAM

    def send_upgrade_response() -> bool:
        response_lines = [
            "HTTP/1.1 101 Switching Protocols",
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Accept: {_accept_key(sec_key)}",
        ]
        # No Sec-WebSocket-Protocol: ArdyClient opens a bare WebSocket (no
        # subprotocols), so there is nothing to negotiate or echo back.
        response = ("\r\n".join(response_lines) + "\r\n\r\n").encode("ascii")
        try:
            handler.connection.sendall(response)
            return True
        except OSError:
            return False

    # Multi-consumer policy: one concurrent session per upstream (fail closed).
    if not _try_acquire_upstream(upstream_url):
        _logger.warning(
            "ardy ws proxy: refusing second concurrent session for %s", upstream_url
        )
        # 409 semantics over WS: complete the upgrade, then immediately close
        # with 1013 + reason so the client's backoff retries can attach later.
        if send_upgrade_response():
            handler.close_connection = True
            try:
                handler.connection.sendall(
                    _build_frame(OP_CLOSE, _close_payload(BUSY_CLOSE_CODE, BUSY_CLOSE_REASON))
                )
            except OSError:
                pass
        return True

    try:
        upstream = _connect_upstream(upstream_url, headers.get("Sec-WebSocket-Protocol"))
    except Exception as exc:
        _release_upstream(upstream_url)
        _logger.warning("ardy ws proxy: upstream connect failed: %s", exc)
        j(handler, {"error": "ARDY upstream unavailable"}, status=502)
        return True

    # ── Answer the browser's upgrade. From here on we own the socket. ──
    if not send_upgrade_response():
        upstream.close()
        _release_upstream(upstream_url)
        return True
    handler.close_connection = True  # base handler must not reuse this socket

    browser = handler.connection
    _enable_keepalive(browser)
    _enable_keepalive(upstream)
    upstream.settimeout(UPSTREAM_RECV_TIMEOUT_S)

    stop = threading.Event()
    browser_send_lock = threading.Lock()
    upstream_send_lock = threading.Lock()
    prompt_times: deque = deque()  # prompt rate-cap window (this connection)

    def pump_browser_to_upstream() -> None:
        # Reads via handler.rfile: the HTTP parser's buffered reader may
        # already hold read-ahead frame bytes; bypassing it would lose them.
        try:
            while not stop.is_set():
                fin, opcode, payload = _read_frame(
                    lambda n: _read_exact_file(handler.rfile, n), expect_masked=True
                )
                if opcode == OP_CLOSE:
                    _send_locked(
                        upstream_send_lock, upstream,
                        _build_frame(OP_CLOSE, payload, mask=True),
                    )
                    break
                if opcode == OP_TEXT:
                    # Prompt-channel abuse bounds: a rejected prompt kills the
                    # session with 1008 + reason on both legs (fail closed).
                    rejection = _validate_prompt_frame(payload, prompt_times)
                    if rejection is not None:
                        _logger.warning("ardy ws proxy: prompt rejected: %s", rejection)
                        close = _close_payload(PROMPT_REJECT_CLOSE_CODE, f"prompt rejected: {rejection}")
                        try:
                            _send_locked(browser_send_lock, browser, _build_frame(OP_CLOSE, close))
                            _send_locked(upstream_send_lock, upstream, _build_frame(OP_CLOSE, close, mask=True))
                        except OSError:
                            pass
                        break
                _send_locked(
                    upstream_send_lock, upstream,
                    _build_frame(opcode, payload, fin=fin, mask=True),
                )
        except (OSError, ConnectionError, _FrameError):
            pass
        finally:
            stop.set()
            # Wake the main pump's blocking upstream recv so a browser-side
            # disconnect tears the session down immediately instead of after
            # an idle-timeout strike.
            try:
                upstream.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def pump_upstream_to_browser() -> None:
        idle_strikes = 0
        try:
            while not stop.is_set():
                try:
                    fin, opcode, payload = _read_frame(
                        lambda n: _recv_exact(upstream, n), expect_masked=False
                    )
                except socket.timeout:
                    idle_strikes += 1
                    if idle_strikes >= UPSTREAM_IDLE_STRIKES:
                        _logger.info("ardy ws proxy: upstream idle timeout; closing")
                        break
                    _send_locked(
                        upstream_send_lock, upstream,
                        _build_frame(OP_PING, b"", mask=True),
                    )
                    continue
                idle_strikes = 0
                if opcode == OP_CLOSE:
                    _send_locked(
                        browser_send_lock, browser,
                        _build_frame(OP_CLOSE, payload),
                    )
                    break
                _send_locked(
                    browser_send_lock, browser,
                    _build_frame(opcode, payload, fin=fin),
                )
        except (OSError, ConnectionError, _FrameError):
            pass
        finally:
            stop.set()

    relay = threading.Thread(
        target=pump_browser_to_upstream, name="ardy-ws-browser-to-upstream", daemon=True
    )
    relay.start()
    try:
        pump_upstream_to_browser()
    finally:
        stop.set()
        # Unblock the relay thread's rfile.read and the upstream recv.
        for sock in (browser, upstream):
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        relay.join(timeout=5)
        try:
            upstream.close()
        except OSError:
            pass
        _release_upstream(upstream_url)
        # handler.connection is closed by the base handler's finish().
    return True
