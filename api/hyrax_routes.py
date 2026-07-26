"""
Hyraxknot Division — Hermes WebUI Route Extensions

Provides explicit handler functions for /api/hyrax/* endpoints.
No monkey-patching. No import-time side effects.

All canonical endpoints live under /api/hyrax/:
  - /api/hyrax/projects     — Kanban project aggregation
  - /api/hyrax/stats        — Control-plane stats snapshot
  - /api/hyrax/agents       — Active agent/task summary
  - /api/hyrax/assets/<name> — Allowlisted asset serving (VRM, etc.)
"""

import json
import logging as _logging
import os
import re as _re
import stat
import time
import sqlite3
from pathlib import Path

from api.helpers import j, _security_headers, flush_pending_auth_cookies

_logger = _logging.getLogger(__name__)

# ── DB paths ──
# Derived from HERMES_HOME (default ~/.hermes) — never hardcode a
# machine-specific absolute path in a tracked file.
def _fleet_kanban_db() -> Path:
    """kanban.db is a FLEET-level store at the fleet root.

    api/config's init_profile_state() rewrites HERMES_HOME to the active
    profile home (.../profiles/<name>) before this module is imported, so a
    naive HERMES_HOME/kanban.db resolves to a nonexistent per-profile path
    and every kanban read fails closed to zeros (silent in production).
    """
    home = Path(os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes"))
    if home.parent.name == "profiles":
        home = home.parent.parent
    return home / "kanban.db"


KANBAN_DB = _fleet_kanban_db()

# ── Asset serving ─────────────────────────────────────────────────────────
ASSET_BASE = Path(__file__).resolve().parent.parent / "hyrax-assets"
"""Root directory for Hyrax-owned assets (not under public /static)."""

CHUNK_SIZE = 64 * 1024  # 64KB — stream in bounded chunks

# ── 2D VN asset manifest ─────────────────────────────────────────────────────
# Loaded from hyrax-assets/vn/ASSET_MANIFEST.json at module init time.
# Fail-closed: if the manifest is missing, malformed, or invalid, zero 2D assets
# are served and a single generic operator warning is logged.

_VN_2D_ALLOWLIST: dict[str, str] = {}
"""Internal 2D allowlist built from ASSET_MANIFEST.json (logical_id → vn/rel_path).
Updated at module load by _load_vn_2d_manifest()."""

# Valid logical ID pattern: profile.kind.state
#   profile ∈ {tai, rei, nei, mai}
#   kind     ∈ {portrait, background, chibi}
#   state    ∈ lowercase alphanumeric + hyphens
_VN_2D_ID_RE = _re.compile(r"^(tai|rei|nei|mai)\.(portrait|background|chibi)\.[a-z0-9-]+$")
_VN_2D_HASH_RE = _re.compile(r"^[a-f0-9]{64}$")


def _load_vn_2d_manifest() -> dict[str, str]:
    """Load and validate the VN 2D asset manifest.

    Reads ASSET_MANIFEST.json from ASSET_BASE/vn/, validates every entry,
    and returns a dict of logical_id → relative_path (e.g. ``vn/portraits/tai-neutral.png``).

    Fail-closed: returns empty dict on any error (missing manifest, malformed JSON,
    invalid version/policy, bad entries). Logs one generic operator warning.
    """
    manifest_path = ASSET_BASE / "vn" / "ASSET_MANIFEST.json"

    if not manifest_path.is_file():
        _logger.warning("VN 2D manifest not found — zero 2D assets served")
        return {}

    try:
        with open(manifest_path, "r") as _f:
            data = json.load(_f)
    except (json.JSONDecodeError, IOError, OSError):
        _logger.warning("VN 2D manifest unreadable — zero 2D assets served")
        return {}

    if not isinstance(data, dict):
        _logger.warning("VN 2D manifest structure invalid — zero 2D assets served")
        return {}

    if data.get("version") != 1:
        _logger.warning("VN 2D manifest has unrecognised version — zero 2D assets served")
        return {}

    if data.get("policy") != "fixed-sfw-allowlist":
        _logger.warning("VN 2D manifest has unrecognised policy — zero 2D assets served")
        return {}

    raw_assets = data.get("assets", [])
    if not isinstance(raw_assets, list):
        _logger.warning("VN 2D manifest assets field is not a list — zero 2D assets served")
        return {}

    allowlist: dict[str, str] = {}
    seen_ids: set[str] = set()

    for entry in raw_assets:
        if not isinstance(entry, dict):
            continue

        # Logical ID: required, must match pattern
        logical_id = entry.get("id", "")
        if not isinstance(logical_id, str) or not _VN_2D_ID_RE.match(logical_id):
            continue

        # No duplicate IDs
        if logical_id in seen_ids:
            continue

        # Profile ID must match one of the four sisters
        profile_id = entry.get("profile_id")
        if profile_id not in ("tai", "rei", "nei", "mai"):
            continue

        # Kind must be an allowlisted type
        kind = entry.get("kind")
        if kind not in ("portrait", "background", "chibi"):
            continue

        # Sensitivity must be "safe"
        if entry.get("sensitivity") != "safe":
            continue

        # Relative path must be a .png inside the vn/ subtree
        rel_path = entry.get("relative_path", "")
        if not isinstance(rel_path, str) or not rel_path.endswith(".png"):
            continue
        # Reject traversal in relative path
        if rel_path.startswith("/") or ".." in rel_path:
            continue
        # Must be a simple path under vn/
        parts = Path(rel_path).parts
        if len(parts) != 2:
            continue

        # Size must be a sane positive number
        size = entry.get("size")
        if not isinstance(size, (int, float)) or size <= 0:
            continue

        # SHA-256 must be a 64-char hex string
        sha256 = entry.get("sha256", "")
        if not isinstance(sha256, str) or not _VN_2D_HASH_RE.match(sha256):
            continue

        # All checks passed — accept this entry
        allowlist[logical_id] = f"vn/{rel_path}"
        seen_ids.add(logical_id)

    return allowlist


# Load 2D manifest at module init time (fail-closed — empty on error)
_VN_2D_ALLOWLIST = _load_vn_2d_manifest()

# ── Main asset allowlist (VRM + merged 2D) ─────────────────────────────────┈
ASSET_ALLOWLIST: dict[str, str] = {
    "tai.embodiment.vrm": "embodiment/tai.embodiment.vrm",
}
ASSET_ALLOWLIST.update(_VN_2D_ALLOWLIST)
"""Allowlist: logical name → relative path under ASSET_BASE.
Contains the hardcoded VRM entry plus all validated VN 2D entries from the
manifest. Never accept arbitrary filesystem paths, percent-decoded traversal,
or unknown names. The relative target is resolved within ASSET_BASE and
checked for symlink/directory safety at request time."""

_DISCONNECT_ERRORS = (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)


# ── Public entry point ─────────────────────────────────────────────────────

def handle_hyrax_get(handler, parsed) -> bool:
    """Dispatch /api/hyrax/* GET requests. Returns True if handled, False to pass through.

    Called explicitly from api.routes.handle_get when the path starts with
    /api/hyrax/. Unknown sub-paths return sanitised JSON 404.
    """
    path = parsed.path

    # Only handle /api/hyrax/* paths; everything else returns False
    # so the caller (api.routes.handle_get) can try core dispatch.
    if not path.startswith("/api/hyrax/"):
        return False

    # /api/hyrax/assets/<logical_name> — authenticated allowlist asset serving
    if path.startswith("/api/hyrax/assets"):
        return _handle_asset_request(handler, path)

    # /api/hyrax/projects — Kanban project aggregation
    if path == "/api/hyrax/projects":
        return _serve_projects(handler)

    # /api/hyrax/stats — control-plane stats snapshot
    if path == "/api/hyrax/stats":
        return _serve_stats(handler)

    # /api/hyrax/agents — active agent/task summary
    if path == "/api/hyrax/agents":
        return _serve_agents(handler)

    # /api/hyrax/presence + /api/hyrax/essence/* — Essence runtime (read side)
    if path == "/api/hyrax/presence" or path.startswith("/api/hyrax/essence"):
        from api import hyrax_essence as _hyrax_essence
        return _hyrax_essence.handle_essence_get(handler, parsed)

    # /api/hyrax/vn/* — VN native session adapter
    if path.startswith("/api/hyrax/vn/"):
        from api.hyrax_routes import handle_hyrax_vn_get
        return handle_hyrax_vn_get(handler, parsed)

    # Unknown /api/hyrax/* -> sanitised 404
    j(handler, {"error": "not found"}, status=404)
    return True


def handle_hyrax_post(handler, parsed) -> bool:
    """Dispatch /api/hyrax/* POST requests. Returns True if handled, False to pass through.

    Called explicitly from api.routes.handle_post when the path starts with
    /api/hyrax/. CSRF has already been validated by the caller.
    Unknown sub-paths return sanitised JSON 404.
    """
    path = parsed.path

    # Only handle /api/hyrax/* paths; everything else returns False
    if not path.startswith("/api/hyrax/"):
        return False

    # /api/hyrax/essence/frames/register — Essence frame registry writes
    if path == "/api/hyrax/essence/frames/register":
        from api import routes as _routes
        try:
            body = _routes.read_body(handler)
        except Exception:
            body = {}
        from api import hyrax_essence as _hyrax_essence
        return _hyrax_essence.handle_essence_post(handler, parsed, body)

    # /api/hyrax/vn/* — VN POST routes (need body read)
    if path.startswith("/api/hyrax/vn/"):
        from api import routes as _routes
        try:
            body = _routes.read_body(handler)
        except Exception:
            body = {}
        return handle_hyrax_vn_post(handler, parsed, body)

    # Unknown /api/hyrax/* POST -> sanitised 404
    j(handler, {"error": "not found"}, status=404)
    return True


# ── Asset serving ──────────────────────────────────────────────────────────

def _serve_asset(handler, asset_name: str) -> bool:
    """Attempt to stream the allowlisted asset. Returns True if handled.

    Security model:
      - Only names in ASSET_ALLOWLIST are accepted.
      - The target path is resolved within ASSET_BASE and verified to be a
        regular, non-symlink file inside ASSET_BASE.
      - Missing or disallowed assets return sanitised JSON 404 (no path leak).
    """
    rel = ASSET_ALLOWLIST.get(asset_name)
    if rel is None:
        j(handler, {"error": "not found"}, status=404)
        return True

    candidate = ASSET_BASE / rel

    try:
        base = ASSET_BASE.resolve(strict=True)

        # Reject symlinks in every asset-relative component before resolving.
        current = candidate
        while current != ASSET_BASE:
            if current.is_symlink():
                raise OSError("symlinked asset path")
            current = current.parent
        if ASSET_BASE.is_symlink():
            raise OSError("symlinked asset root")

        resolved = candidate.resolve(strict=True)
        resolved.relative_to(base)
        expected = resolved.stat()

        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
        flags |= getattr(os, "O_CLOEXEC", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(candidate, flags)
        try:
            stream = os.fdopen(fd, "rb")
        except Exception:
            os.close(fd)
            raise
        opened = os.fstat(stream.fileno())
        if (
            not stat.S_ISREG(opened.st_mode)
            or (opened.st_dev, opened.st_ino) != (expected.st_dev, expected.st_ino)
        ):
            stream.close()
            raise OSError("asset identity changed")
    except (OSError, RuntimeError, ValueError):
        j(handler, {"error": "not found"}, status=404)
        return True

    size = opened.st_size

    # Determine Content-Type from file extension
    if rel.endswith(".png"):
        content_type = "image/png"
    elif rel.endswith(".vrm"):
        content_type = "model/gltf-binary"
    else:
        content_type = "application/octet-stream"

    handler.send_response(200)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(size))
    handler.send_header("Content-Disposition", "inline")
    handler.send_header("Cache-Control", "private, max-age=3600")
    handler.send_header("X-Content-Type-Options", "nosniff")
    _security_headers(handler)
    flush_pending_auth_cookies(handler)
    handler.end_headers()

    try:
        with stream:
            while True:
                chunk = stream.read(CHUNK_SIZE)
                if not chunk:
                    break
                try:
                    handler.wfile.write(chunk)
                except _DISCONNECT_ERRORS:
                    break
    except OSError:
        pass

    return True


def _handle_asset_request(handler, path: str) -> bool:
    """Parse and validate /api/hyrax/assets/<name>, then serve."""
    # Handle both /api/hyrax/assets and /api/hyrax/assets/ as missing name
    if path == "/api/hyrax/assets" or path == "/api/hyrax/assets/":
        j(handler, {"error": "not found"}, status=404)
        return True
    raw = path[len("/api/hyrax/assets/"):]
    # Reject empty/trivial names, path traversal, encoded traversal,
    # backslash alternates, and anything with path separators.
    if (
        not raw
        or raw == "/"
        or "/" in raw
        or "\\" in raw
        or ".." in raw
        or "%2e" in raw.lower()
        or "%2f" in raw.lower()
        or "%5c" in raw.lower()
    ):
        j(handler, {"error": "not found"}, status=404)
        return True
    return _serve_asset(handler, raw)


# ── Query helper ───────────────────────────────────────────────────────────

def _query(db_path: Path, sql: str, params: tuple = ()) -> list[dict]:
    """Execute a read-only SQL query and return rows as dicts."""
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=1)
        conn.row_factory = sqlite3.Row
        rows = [dict(row) for row in conn.execute(sql, params).fetchall()]
        conn.close()
        return rows
    except Exception:
        return []


# ── Endpoint handlers ──────────────────────────────────────────────────────

_PROJECTS_SQL = (
    "SELECT project_id AS name, COUNT(*) AS total, "
    "SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done_count, "
    "SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running_count, "
    "SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END) AS blocked_count, "
    "MAX(created_at) AS last_updated "
    "FROM tasks WHERE project_id IS NOT NULL AND project_id != '' "
    "GROUP BY project_id ORDER BY last_updated DESC"
)


def _serve_projects(handler) -> bool:
    """GET /api/hyrax/projects — Kanban project aggregation."""
    rows = _query(KANBAN_DB, _PROJECTS_SQL)
    j(handler, {"items": rows, "meta": {"total": len(rows)}})
    return True


_STATS_SQL = (
    "SELECT status, COUNT(*) AS cnt "
    "FROM tasks GROUP BY status"
)


def _serve_stats(handler) -> bool:
    """GET /api/hyrax/stats — control-plane stats snapshot."""
    task_stats = _query(KANBAN_DB, _STATS_SQL)
    total = sum(r.get("cnt", 0) for r in task_stats)
    status_map = {r["status"]: r["cnt"] for r in task_stats if "status" in r}
    j(handler, {
        "tasks": {
            "total": total,
            "by_status": status_map,
        },
        "observed_at": time.time(),
    })
    return True


_AGENTS_SQL = (
    "SELECT assignee AS name, COUNT(*) AS active_tasks, "
    "SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running_count, "
    "MAX(created_at) AS last_active "
    "FROM tasks WHERE assignee IS NOT NULL AND assignee != '' "
    "GROUP BY assignee ORDER BY last_active DESC"
)


def _serve_agents(handler) -> bool:
    """GET /api/hyrax/agents — active agent/task summary."""
    rows = _query(KANBAN_DB, _AGENTS_SQL)
    j(handler, {"items": rows, "meta": {"total": len(rows)}})
    return True


# ══════════════════════════════════════════════════════════════════════════
# VN (Visual Novel) native session adapter — /api/hyrax/vn/*
#
# These routes are an ownership-validating presentation adapter over Hermes
# WebUI's native session and run model. They replace the old control-plane
# gateway's conversation database and run coordinator.
#
# Security principle: caller input NEVER becomes a filesystem path. The
# sister allowlist is fixed and immutable.
# ══════════════════════════════════════════════════════════════════════════

import threading as _threading

from types import MappingProxyType as _MappingProxyType

from api.helpers import j as _j
from api.models import (
    all_sessions as _all_sessions,
    get_session as _get_session,
    is_safe_session_id as _is_safe_session_id,
    new_session as _new_session,
)

# ── Fixed immutable sister allowlist ────────────────────────────────────────
# Caller input never becomes a path. Display metadata only.
# Both top-level and all nested dicts are wrapped in MappingProxyType.
_VN_PROFILES_SOURCE: dict[str, dict[str, object]] = {
    "tai": {
        "name": "Tai",
        "role": "Builder",
        "available": True,
        "assets": {
            "portrait": "/api/hyrax/assets/tai.portrait.neutral",
            "background": "/api/hyrax/assets/tai.background.control-room",
            "chibi": "/api/hyrax/assets/tai.chibi.stand",
            "model": "/api/hyrax/assets/tai.embodiment.vrm",
        },
    },
    "rei": {
        "name": "Rei",
        "role": "QA",
        "available": True,
        "assets": {
            "portrait": "/api/hyrax/assets/rei.portrait.neutral",
            "background": "/api/hyrax/assets/rei.background.security",
            "chibi": "/api/hyrax/assets/rei.chibi.stand",
        },
    },
    "nei": {
        "name": "Nei",
        "role": "Quartermaster",
        "available": True,
        "assets": {
            "portrait": "/api/hyrax/assets/nei.portrait.neutral",
            "background": "/api/hyrax/assets/nei.background.lab",
            "chibi": "/api/hyrax/assets/nei.chibi.stand",
        },
    },
    "mai": {
        "name": "Mai",
        "role": "Support",
        "available": True,
        "assets": {
            "portrait": "/api/hyrax/assets/mai.portrait.neutral",
            "background": "/api/hyrax/assets/mai.background.supply-hub",
            "chibi": "/api/hyrax/assets/mai.chibi.stand",
        },
    },
}
# Wrap all nested dicts recursively
_VN_PROFILES_WRAPPED: dict[str, dict[str, object]] = {}
for _pid, _meta in _VN_PROFILES_SOURCE.items():
    _wrapped_meta: dict[str, object] = {}
    for _k, _v in _meta.items():
        if isinstance(_v, dict):
            _wrapped_meta[_k] = _MappingProxyType(dict(_v))  # fresh copy for proxy
        else:
            _wrapped_meta[_k] = _v
    _VN_PROFILES_WRAPPED[_pid] = _MappingProxyType(_wrapped_meta)
VN_PROFILES: _MappingProxyType = _MappingProxyType(_VN_PROFILES_WRAPPED)
# Delete mutable backing references — they must not be accessible at module scope
# because mutating them changes the supposedly immutable VN_PROFILES.
del _VN_PROFILES_SOURCE, _VN_PROFILES_WRAPPED
del _pid, _meta, _wrapped_meta, _k, _v
"""Fixed immutable allowlist for VN sister profiles.

Caller input is validated against this dict and never used as a filesystem path,
cookie value, or database query parameter beyond the WebUI session filter.

Top-level assignment and nested mutation both raise TypeError."""

# ── Per-sister conversation lock registry ───────────────────────────────────
# Serializes create/archive per sister to prevent duplicate active VN sessions.
# The dict is fully populated at import time, so it needs no guard lock.
_VN_CONVERSATION_LOCKS: dict[str, _threading.Lock] = {
    pid: _threading.Lock() for pid in VN_PROFILES
}

# ── VN path patterns ────────────────────────────────────────────────────────
_VN_PROFILES_PATH = "/api/hyrax/vn/profiles"
_VN_CONVERSATIONS_PREFIX = "/api/hyrax/vn/conversations"

# ── Bounds for VN output ─────────────────────────────────────────────────────
# Content and metadata fields in VN transcript responses must be capped to
# prevent unbounded data leakage through the presentation layer.
MAX_TRANSCRIPT_CONTENT_LENGTH = 100_000  # characters — assistant responses
MAX_TRANSCRIPT_NAME_LENGTH = 128         # characters — message author names
DEFAULT_TRANSCRIPT_ROWS = 200            # default transcript page size (?limit=)
MAX_TRANSCRIPT_ROWS = 400                # hard cap for ?limit= (was: fixed 50-row cap)
MAX_ID_LENGTH = 64                       # max length for string IDs
MAX_TITLE_LENGTH = 256                   # max length for session titles

# Max text length for a VN turn POST body before trimming/rejection.
# The RFC requires "bounded trimmed non-empty UTF-8 text with a conservative
# bounded length." We reject over-length input rather than silently truncating.
MAX_TURN_TEXT_LENGTH = 4000

# Bounds for VN turn attachments (mirrors the /api/chat/start attachment
# shape {name, path, mime, size}, strictly validated — any other shape is
# rejected rather than coerced).
MAX_TURN_ATTACHMENTS = 8                 # max attachment items per turn
MAX_ATTACHMENT_STRING = 256              # max chars for name/path/mime
MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024   # 25 MB per attachment


# ── Handlers called from handle_hyrax_get/handle_hyrax_post ──────────────────


def handle_hyrax_vn_get(handler, parsed) -> bool:
    """Dispatch GET /api/hyrax/vn/* requests. Returns True if handled."""
    path = parsed.path

    # GET /api/hyrax/vn/profiles
    if path == _VN_PROFILES_PATH:
        return _vn_serve_profiles(handler)

    # GET /api/hyrax/vn/conversations/{session_id}[/events]
    if path.startswith(_VN_CONVERSATIONS_PREFIX):
        # Strip prefix to get the session ID + suffix
        remainder = path[len(_VN_CONVERSATIONS_PREFIX):]

        # /conversations/{session_id}/events
        if remainder.endswith("/events"):
            sid = remainder[1:-len("/events")]  # strip leading / and trailing /events
            if _is_safe_session_id(sid):
                return _vn_serve_events(handler, parsed, sid)
            _j(handler, {"error": "not found"}, status=404)
            return True

        # /conversations/{session_id}/approvals/pending — approval state alias.
        # The native /api/approval/pending 404s cross-profile (sister sessions
        # are invisible to the caller's active profile); this alias validates VN
        # ownership and delegates under the sister's profile context.
        if remainder.endswith("/approvals/pending"):
            sid = remainder[1:-len("/approvals/pending")]
            if _is_safe_session_id(sid):
                return _vn_serve_approval_alias(handler, parsed, sid, kind="approval")
            _j(handler, {"error": "not found"}, status=404)
            return True

        # /conversations/{session_id}/clarify/pending — same alias for clarify.
        if remainder.endswith("/clarify/pending"):
            sid = remainder[1:-len("/clarify/pending")]
            if _is_safe_session_id(sid):
                return _vn_serve_approval_alias(handler, parsed, sid, kind="clarify")
            _j(handler, {"error": "not found"}, status=404)
            return True

        # /conversations/{session_id}  — bounded, paged transcript
        # Strip leading slash, reject sub-paths
        if "/" not in remainder[1:] if len(remainder) > 1 else True:
            sid = remainder[1:] if len(remainder) > 1 else ""
            if _is_safe_session_id(sid):
                return _vn_serve_conversation(handler, parsed, sid)
            _j(handler, {"error": "not found"}, status=404)
            return True

        # Unknown sub-paths under conversations/
        _j(handler, {"error": "not found"}, status=404)
        return True

    # Unknown /api/hyrax/vn/* path
    _j(handler, {"error": "not found"}, status=404)
    return True


def handle_hyrax_vn_post(handler, parsed, body: dict) -> bool:
    """Dispatch POST /api/hyrax/vn/* requests. Returns True if handled."""
    path = parsed.path

    # POST /api/hyrax/vn/conversations  — select or create VN session
    if path == _VN_CONVERSATIONS_PREFIX:
        return _vn_handle_create_conversation(handler, body)

    # POST /api/hyrax/vn/conversations/{session_id}/turns
    if path.startswith(_VN_CONVERSATIONS_PREFIX) and path.endswith("/turns"):
        remainder = path[len(_VN_CONVERSATIONS_PREFIX):]
        sid = remainder[1:-len("/turns")]  # strip leading / and trailing /turns
        if _is_safe_session_id(sid):
            return _vn_handle_turn(handler, sid, body)
        _j(handler, {"error": "not found"}, status=404)
        return True

    # Unknown /api/hyrax/vn/* POST path
    _j(handler, {"error": "not found"}, status=404)
    return True


# ── VN handler helpers ──────────────────────────────────────────────────────


def _vn_session_visible(session) -> bool:
    """Return True if session is a valid VN session owned by an allowlisted sister.

    Checks:
      - `project_id == "hyrax-vn"`
      - `session.profile` is in the allowlist
    """
    pid = getattr(session, "project_id", None) or ""
    if pid != "hyrax-vn":
        return False
    sp = getattr(session, "profile", None) or ""
    return sp in VN_PROFILES


def _vn_bounded_conversation(session, limit: int | None = None, before: str | None = None):
    """Return a bounded, sanitized conversation dict from a VN session.

    Exposes only: session_id, title, message_count, active_stream_id,
    archived, created_at, updated_at, profile (from allowlist), optional
    expression state (session-carried, or derived from the latest assistant
    reply), and filtered transcript.

    Transcript paging: the transcript is the filtered user/assistant rows,
    optionally cut at the ``before`` cursor (message id or zero-based index
    into the filtered rows), then windowed to the last ``limit`` rows
    (default DEFAULT_TRANSCRIPT_ROWS, hard cap MAX_TRANSCRIPT_ROWS). The
    response adds ``total`` (filtered row count, same as message_count) and
    ``has_more`` (earlier rows exist beyond the window).

    Never exposes workspace, model, provider config, raw tool args, or env data.

    All string fields are bounded. All numeric timestamps are finite-safe.
    Raises ValueError when the ``before`` cursor resolves to nothing.
    """
    # Bounded and type-sanitized top-level fields
    raw_sid = getattr(session, "session_id", "")
    if not isinstance(raw_sid, str):
        raw_sid = ""
    bounded_sid = raw_sid[:MAX_ID_LENGTH]

    raw_title = getattr(session, "title", "Untitled")
    if not isinstance(raw_title, str):
        raw_title = "Untitled"
    bounded_title = raw_title[:MAX_TITLE_LENGTH]

    raw_active_stream = getattr(session, "active_stream_id", None)
    if not isinstance(raw_active_stream, str):
        bounded_active_stream = None
    else:
        bounded_active_stream = raw_active_stream[:MAX_ID_LENGTH]

    # Finite-safe timestamps
    raw_created = getattr(session, "created_at", 0)
    try:
        created_val = float(raw_created)
    except (TypeError, ValueError):
        created_val = 0.0
    import math as _math
    bounded_created = created_val if (_math.isfinite(created_val)) else 0.0

    raw_updated = getattr(session, "updated_at", 0)
    try:
        updated_val = float(raw_updated)
    except (TypeError, ValueError):
        updated_val = 0.0
    bounded_updated = updated_val if (_math.isfinite(updated_val)) else 0.0

    compact = {
        "session_id": bounded_sid,
        "title": bounded_title,
        "profile": getattr(session, "profile", ""),
        "active_stream_id": bounded_active_stream,
        "archived": bool(getattr(session, "archived", False)),
        "created_at": bounded_created,
        "updated_at": bounded_updated,
    }
    # Optional expression state — included only when the session carries a
    # well-formed one. The VN client reads this for the portrait/mood badge.
    expr = getattr(session, "expression", None)
    if isinstance(expr, dict):
        expr_current = expr.get("current")
        if isinstance(expr_current, str) and expr_current:
            bounded_expr = {"current": expr_current[:MAX_TRANSCRIPT_NAME_LENGTH]}
            expr_intensity = expr.get("intensity")
            if isinstance(expr_intensity, (int, float)) and not isinstance(expr_intensity, bool):
                intensity_val = float(expr_intensity)
                if _math.isfinite(intensity_val):
                    bounded_expr["intensity"] = min(1.0, max(0.0, intensity_val))
            compact["expression"] = bounded_expr
    # Filtered transcript: only user and assistant messages
    raw_messages = getattr(session, "messages", None) or []
    transcript = [
        _vn_bounded_message(m)
        for m in raw_messages
        if isinstance(m, dict) and m.get("role") in ("user", "assistant")
    ]
    # Count the displayable rows — consistent with the filtered transcript,
    # not the raw message list (which includes tool/system messages)
    compact["message_count"] = len(transcript)
    compact["total"] = len(transcript)
    # When the session carries no explicit expression, resolve one for the
    # VN portrait/mood badge. Precedence (Phase B, ESSENCE_ACTIVE_RUNTIME):
    #   1. essenced's fresh derived presentation.expression — the runtime-
    #      owned mood→expression mapping (read-only, fail closed to None);
    #   2. the keyword stopgap over the latest assistant reply
    #      (_vn_derive_expression), kept as the fallback for missing/stale
    #      derived state.
    # Resolved over the full filtered transcript (latest row wins) before
    # paging cuts the window.
    if "expression" not in compact:
        derived_expr = _vn_derived_presentation_expression(
            getattr(session, "profile", ""))
        if derived_expr is not None:
            compact["expression"] = derived_expr
        else:
            derived = _vn_derive_expression(transcript)
            if derived:
                compact["expression"] = {"current": derived}
    # Paging: cut at the `before` cursor, then window to the last `limit` rows
    if before is not None:
        cut = _vn_resolve_before_cursor(transcript, before)
        if cut is None:
            raise ValueError("invalid before cursor")
        transcript = transcript[:cut]
    page_size = limit if limit is not None else DEFAULT_TRANSCRIPT_ROWS
    page = transcript[-page_size:] if len(transcript) > page_size else transcript
    compact["has_more"] = len(transcript) > len(page)
    compact["messages"] = page
    return compact


def _vn_resolve_before_cursor(transcript: list, before: str) -> int | None:
    """Resolve a `before` cursor to a cut index into the filtered transcript.

    Accepts a zero-based row index or a bounded message id. Returns the index
    of the first EXCLUDED row (transcript[:cut] is the window), or None when
    the cursor resolves to nothing (caller fails closed with 400).
    """
    if before.isdigit():
        idx = int(before)
        return idx if 0 <= idx <= len(transcript) else None
    for i, msg in enumerate(transcript):
        if msg.get("id") == before:
            return i
    return None


# ── VN expression derivation ─────────────────────────────────────────────
# Keyword mood derivation over the latest assistant reply — DEMOTED (Phase
# B) to the fallback behind essenced's fresh derived presentation.expression
# (see _vn_derived_presentation_expression below). Conservative keyword
# signals; no match → None → client keeps its current pose.
_VN_EXPRESSION_SIGNALS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("laughing", ("haha", "lol", "😂", "🤣")),
    ("happy", ("great news", "awesome", "glad", "yay", "🎉", "😄", "love it", "well done")),
    ("smile", ("thank you", "thanks", "nice work", "good job", "you're welcome")),
    ("teasing", ("hehe", "miss me", "took you long enough")),
    ("annoyed", ("ugh", "not again", "this again")),
    ("shy", ("if that's okay", "if that is okay", "um,", "uh,")),
    ("thinking", ("let me think", "hmm", "let me check", "considering")),
)


def _vn_derive_expression(transcript) -> str | None:
    """Derive a VN mood from the latest assistant transcript row.

    `transcript` is the bounded message list already filtered to
    user/assistant roles. Returns a mood string or None (no signal).
    """
    text = ""
    for msg in reversed(transcript):
        if isinstance(msg, dict) and msg.get("role") == "assistant":
            candidate = msg.get("content")
            if isinstance(candidate, str):
                text = candidate[:2000].lower()
            break
    if not text:
        return None
    for mood, signals in _VN_EXPRESSION_SIGNALS:
        for signal in signals:
            if signal in text:
                return mood
    return None


def _vn_derived_presentation_expression(profile) -> dict | None:
    """essenced's fresh derived presentation.expression, bounded; else None.

    Lazy import: api.hyrax_essence imports from THIS module at load time, so
    a module-level import would be circular. Fail closed on any error —
    the caller falls back to the keyword stopgap.
    """
    if not isinstance(profile, str) or not profile:
        return None
    try:
        from api.hyrax_essence import derived_presentation_expression

        expr = derived_presentation_expression(profile)
    except Exception:
        return None
    if not isinstance(expr, dict):
        return None
    current = expr.get("current")
    if not isinstance(current, str) or not current:
        return None
    bounded = {"current": current[:MAX_TRANSCRIPT_NAME_LENGTH]}
    intensity = expr.get("intensity")
    if isinstance(intensity, (int, float)) and not isinstance(intensity, bool):
        import math as _math

        val = float(intensity)
        if _math.isfinite(val):
            bounded["intensity"] = min(1.0, max(0.0, val))
    return bounded


def _vn_bounded_message(msg: dict) -> dict:
    """Return a sanitized message dict for VN display.

    Includes only role, content, and a limited subset of metadata.
    Strips tool_calls, tool_call_id, function calls, args, system fields.
    Content and name are capped to prevent unbounded response sizes.
    Non-string content is replaced with empty string (never reflected as dict/list).
    """
    content = msg.get("content", "")
    if not isinstance(content, str):
        content = ""
    if len(content) > MAX_TRANSCRIPT_CONTENT_LENGTH:
        content = content[:MAX_TRANSCRIPT_CONTENT_LENGTH]
    bounded = {
        "role": msg.get("role", ""),
        "content": content,
    }
    # Include message-level metadata useful for display but never raw tool args
    # ID: only if present as a string, bounded
    raw_id = msg.get("id")
    if isinstance(raw_id, str):
        bounded["id"] = raw_id[:MAX_ID_LENGTH]
    # Name: only if present as a string, bounded
    if "name" in msg and isinstance(msg.get("name"), str):
        bounded["name"] = msg["name"][:MAX_TRANSCRIPT_NAME_LENGTH]
    return bounded


# ── GET /api/hyrax/vn/profiles ──────────────────────────────────────────────


def _vn_serve_profiles(handler) -> bool:
    """Return bounded allowlisted sister metadata only."""
    items = []
    for pid, meta in VN_PROFILES.items():
        items.append({
            "id": pid,
            "name": meta["name"],
            "role": meta["role"],
            "available": meta["available"],
            "assets": dict(meta["assets"]),
        })
    _j(handler, {"items": items})
    return True


# ── POST /api/hyrax/vn/conversations ────────────────────────────────────────


def _vn_parse_conversation_body(data: dict) -> tuple[dict | None, int | None]:
    """Parse and validate a conversation creation body.

    Returns (body_dict, None) on success or (None, status_code) on error.
    """
    if not isinstance(data, dict):
        return None, 400

    # Validate keys — allow only profile_id, fresh, and current_session_id
    allowed_keys = {"profile_id", "fresh", "current_session_id"}
    extra = set(data.keys()) - allowed_keys
    if extra:
        return None, 400

    # Validate profile_id
    pid = data.get("profile_id")
    if not isinstance(pid, str) or pid not in VN_PROFILES:
        return None, 400

    # Validate fresh — must be bool exactly, reject None
    fresh = data.get("fresh", False)
    if fresh is not None and not isinstance(fresh, bool):
        return None, 400
    if fresh is None:
        return None, 400

    return {"profile_id": pid, "fresh": bool(fresh), "current_session_id": data.get("current_session_id")}, None


def _vn_select_active_vn_session(profile: str):
    """Select the newest active VN session for a given sister profile.

    Uses native all_sessions() to list all sessions, filters to:
      - unarchived sessions
      - matching profile
      - project_id == "hyrax-vn"

    Returns the session_id or None if none exists.
    Raises on all_sessions() failure to abort the request with 500.
    """
    sessions = _all_sessions()

    # Filter to active VN sessions for this profile
    candidates = []
    for s in sessions:
        if not isinstance(s, dict):
            continue
        if s.get("archived", False):
            continue
        if s.get("profile") != profile:
            continue
        if s.get("project_id") != "hyrax-vn":
            continue
        candidates.append(s)

    if not candidates:
        return None

    # Sort by updated_at desc, then created_at desc, then session_id desc
    candidates.sort(
        key=lambda s: (s.get("updated_at", 0) or 0, s.get("created_at", 0) or 0, s.get("session_id", "") or ""),
        reverse=True,
    )
    return candidates[0]


def _vn_archive_older_sessions(profile: str, keep_sid: str) -> None:
    """Archive duplicate active VN sessions, keeping only keep_sid.

    Loads full sessions for the other candidates and archives them.
    On save failure, the in-memory archived flag is restored to its prior value.
    Raises on any failure to abort the request — must NOT silently swallow
    errors that would cause a replacement session to be created.
    """
    sessions = _all_sessions()

    for s in sessions:
        if not isinstance(s, dict):
            continue
        sid = s.get("session_id", "")
        if not sid or sid == keep_sid:
            continue
        if s.get("archived", False):
            continue
        if s.get("profile") != profile:
            continue
        if s.get("project_id") != "hyrax-vn":
            continue
        # Load full session, archive it
        full = _get_session(sid)
        prior_archived = getattr(full, "archived", False)
        full.archived = True
        try:
            full.save()
        except Exception:
            # Restore in-memory flag to prior value before propagating
            full.archived = prior_archived
            raise


def _vn_archive_all_active_sessions(profile: str) -> None:
    """Archive every active VN session for a profile.

    Used by the fresh=true path to ensure ALL duplicate active sessions
    are archived before creating a new one.

    On save failure of any individual session, that object's in-memory
    archived flag is restored to its prior value before the exception
    propagates. Sessions already archived before the failing one remain
    durably archived (that's acceptable per spec).
    """
    sessions = _all_sessions()

    for s in sessions:
        if not isinstance(s, dict):
            continue
        sid = s.get("session_id", "")
        if not sid:
            continue
        if s.get("archived", False):
            continue
        if s.get("profile") != profile:
            continue
        if s.get("project_id") != "hyrax-vn":
            continue
        # Load full session, archive it
        full = _get_session(sid)
        prior_archived = getattr(full, "archived", False)
        full.archived = True
        try:
            full.save()
        except Exception:
            # Restore in-memory flag to prior value before propagating
            full.archived = prior_archived
            raise


def _vn_handle_create_conversation(handler, body: dict) -> bool:
    """POST /api/hyrax/vn/conversations — select or create VN session."""
    data, err_status = _vn_parse_conversation_body(body)
    if data is None:
        _j(handler, {"error": "bad request"}, status=err_status or 400)
        return True

    pid = data["profile_id"]
    fresh = data.get("fresh", False)
    current_session_id = data.get("current_session_id")
    lock = _VN_CONVERSATION_LOCKS.get(pid, _threading.Lock())

    from api.profiles import request_profile_context

    with lock, request_profile_context(pid):
        # If not fresh, try to select the existing active VN session
        if not fresh:
            try:
                candidate = _vn_select_active_vn_session(pid)
            except Exception:
                _j(handler, {"error": "internal error"}, status=500)
                return True
        else:
            candidate = None

        if candidate is not None:
            sid = candidate.get("session_id", "")
            # Load the full session FIRST — before archiving — so a vanished
            # session does not trigger needless archival of older sessions.
            try:
                session_obj = _get_session(sid)
            except KeyError:
                candidate = None  # fall through to create
            except Exception:
                _j(handler, {"error": "internal error"}, status=500)
                return True
            else:
                # Reconcile duplicates: archive older sessions
                try:
                    _vn_archive_older_sessions(pid, keep_sid=sid)
                except Exception:
                    _j(handler, {"error": "internal error"}, status=500)
                    return True
                _j(handler, {"conversation": _vn_bounded_conversation(session_obj)})
                return True

        # Archive ALL active VN sessions if fresh=true
        if fresh:
            try:
                _vn_archive_all_active_sessions(pid)
            except Exception:
                _j(handler, {"error": "internal error"}, status=500)
                return True

        # Create a new VN session
        try:
            session_obj = _new_session(profile=pid, project_id="hyrax-vn")
        except Exception:
            _j(handler, {"error": "failed to create session"}, status=500)
            return True

        # Set a friendly title and persist
        display_name = VN_PROFILES.get(pid, {}).get("name", pid)
        session_obj.title = f"{display_name} VN"

        # Inherit context from the current Hermes session if provided.
        # Only user/assistant messages with non-empty string content are
        # seeded — an unfiltered tail slice can start mid tool-call sequence
        # (orphaned tool messages), which providers reject with a 400 on the
        # first VN turn.
        if current_session_id:
            try:
                parent = _get_session(current_session_id)
                if parent and parent.messages:
                    seed = [
                        m for m in list(parent.messages)
                        if isinstance(m, dict)
                        and m.get("role") in ("user", "assistant")
                        and isinstance(m.get("content"), str)
                        and m.get("content")
                    ][-6:]
                    if seed:
                        # Deep copy — never share mutable dicts with the
                        # parent session's in-memory message list.
                        session_obj.messages = json.loads(json.dumps(seed))
            except Exception:
                pass  # Non-critical — VN works without context injection

        try:
            session_obj.save()
        except Exception:
            _j(handler, {"error": "failed to create session"}, status=500)
            return True

        _j(handler, {"conversation": _vn_bounded_conversation(session_obj)})
        return True


# ── GET /api/hyrax/vn/conversations/{session_id} ────────────────────────────


def _vn_parse_transcript_paging(query: str):
    """Parse ?limit=/&before= transcript paging params.

    Returns (limit, before, error). limit defaults to DEFAULT_TRANSCRIPT_ROWS
    and is hard-capped at MAX_TRANSCRIPT_ROWS; before is a bounded cursor
    string (message id or zero-based row index). Invalid input → error=True
    (fail closed with 400, never silently clamped).
    """
    from urllib.parse import parse_qs

    limit = DEFAULT_TRANSCRIPT_ROWS
    before = None
    try:
        # keep_blank_values: a bare "limit="/"before=" is invalid input,
        # not an absent parameter (fail closed with 400).
        qs = parse_qs(query or "", max_num_fields=8, keep_blank_values=True)
    except ValueError:
        return None, None, True
    raw_limit = qs.get("limit", [None])[0]
    if raw_limit is not None:
        if not raw_limit.isdigit():
            return None, None, True
        limit = int(raw_limit)
        if limit < 1 or limit > MAX_TRANSCRIPT_ROWS:
            return None, None, True
    raw_before = qs.get("before", [None])[0]
    if raw_before is not None:
        if not raw_before or len(raw_before) > MAX_ID_LENGTH:
            return None, None, True
        before = raw_before
    return limit, before, False


def _vn_serve_conversation(handler, parsed, sid: str) -> bool:
    """GET /api/hyrax/vn/conversations/{session_id} — bounded, paged transcript."""
    limit, before, paging_error = _vn_parse_transcript_paging(
        getattr(parsed, "query", "") or ""
    )
    if paging_error:
        _j(handler, {"error": "bad request"}, status=400)
        return True

    try:
        session = _get_session(sid)
    except KeyError:
        _j(handler, {"error": "not found"}, status=404)
        return True

    if not _vn_session_visible(session):
        _j(handler, {"error": "not found"}, status=404)
        return True

    try:
        conversation = _vn_bounded_conversation(session, limit=limit, before=before)
    except ValueError:
        _j(handler, {"error": "bad request"}, status=400)
        return True
    _j(handler, {"conversation": conversation})
    return True


# ── POST /api/hyrax/vn/conversations/{session_id}/turns ─────────────────────


def _vn_validate_turn_attachments(raw):
    """Strictly validate a VN turn attachments list.

    Mirrors the /api/chat/start attachment shape ({name, path, mime, size})
    but rejects any other shape rather than coercing: every item must be a
    dict with exactly the four keys, strings bounded, size a non-bool int
    within the 25 MB cap, at most MAX_TURN_ATTACHMENTS items.

    Returns the normalized list, or None when invalid.
    """
    if not isinstance(raw, list) or len(raw) > MAX_TURN_ATTACHMENTS:
        return None
    normalized = []
    for item in raw:
        if not isinstance(item, dict):
            return None
        if set(item.keys()) != {"name", "path", "mime", "size"}:
            return None
        name, path, mime, size = item["name"], item["path"], item["mime"], item["size"]
        if not all(
            isinstance(v, str) and len(v) <= MAX_ATTACHMENT_STRING
            for v in (name, path, mime)
        ):
            return None
        if not name or not path:
            return None
        if (
            isinstance(size, bool)
            or not isinstance(size, int)
            or size < 0
            or size > MAX_ATTACHMENT_SIZE
        ):
            return None
        normalized.append({"name": name, "path": path, "mime": mime, "size": size})
    return normalized


def _start_turn_supports_attachments(fn) -> bool:
    """True when the given start_session_turn accepts an attachments kwarg.

    The native start_session_turn in api/routes.py currently hardcodes
    attachments=[] (no parameter) — api/routes.py is outside this change's
    scope, so attachment passthrough is gated on the runtime's signature and
    the turn handler fails closed with a fixed 400 when unsupported (never
    silently drops the user's files).
    """
    import inspect as _inspect

    try:
        params = _inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return False
    if "attachments" in params:
        return True
    return any(p.kind is _inspect.Parameter.VAR_KEYWORD for p in params.values())


def _vn_handle_turn(handler, sid: str, body: dict) -> bool:
    """POST .../{session_id}/turns — submit a user turn.

    Validates VN ownership, then delegates exactly once to
    api.routes.start_session_turn(sid, text, source="hyrax_vn").
    """
    # Validate VN session ownership
    try:
        session = _get_session(sid)
    except KeyError:
        _j(handler, {"error": "not found"}, status=404)
        return True

    if not _vn_session_visible(session):
        _j(handler, {"error": "not found"}, status=404)
        return True

    # Validate body — only 'text' and optional 'attachments' keys
    if not isinstance(body, dict):
        _j(handler, {"error": "bad request"}, status=400)
        return True
    allowed_turn_keys = {"text", "attachments"}
    extra_turn_keys = set(body.keys()) - allowed_turn_keys
    if extra_turn_keys:
        _j(handler, {"error": "bad request"}, status=400)
        return True
    if "text" not in body:
        _j(handler, {"error": "bad request"}, status=400)
        return True

    text = body.get("text", "")
    if not isinstance(text, str) or not text.strip():
        _j(handler, {"error": "bad request"}, status=400)
        return True
    text = text.strip()
    if len(text) > MAX_TURN_TEXT_LENGTH:
        # Include the limit so the client can display/match it
        _j(handler, {
            "error": "text exceeds maximum length",
            "limit": MAX_TURN_TEXT_LENGTH,
        }, status=400)
        return True

    # Optional attachments — strict shape, bounded
    attachments = None
    if "attachments" in body:
        attachments = _vn_validate_turn_attachments(body.get("attachments"))
        if attachments is None:
            _j(handler, {"error": "bad request"}, status=400)
            return True

    # Delegate to native start_session_turn
    from api.routes import start_session_turn

    turn_kwargs = {}
    if attachments:
        if not _start_turn_supports_attachments(start_session_turn):
            _j(handler, {"error": "attachments not supported"}, status=400)
            return True
        turn_kwargs["attachments"] = attachments

    try:
        result = start_session_turn(sid, text, source="hyrax_vn", **turn_kwargs)
    except Exception:
        _j(handler, {"error": "internal error"}, status=500)
        return True

    # Non-dict result must not be processed — fixed 500
    if not isinstance(result, dict):
        _j(handler, {"error": "internal error"}, status=500)
        return True

    status = result.get("_status", 200)
    if status == 400:
        _j(handler, {"error": "bad request"}, status=400)
        return True
    if status == 404:
        _j(handler, {"error": "not found"}, status=404)
        return True
    if status == 409:
        _j(handler, {"error": "conflict"}, status=409)
        return True
    if status != 200:
        _j(handler, {"error": "internal error"}, status=500)
        return True

    # Type-shape success response: bounded string-or-None stream_id,
    # bool pending, fixed integer status. Never reflect raw values.
    raw_stream = result.get("stream_id")
    bounded_stream = raw_stream if isinstance(raw_stream, str) else None
    if isinstance(bounded_stream, str) and len(bounded_stream) > MAX_ID_LENGTH:
        bounded_stream = bounded_stream[:MAX_ID_LENGTH]

    _j(handler, {
        "stream_id": bounded_stream,
        "pending": bool(result.get("pending", False)),
        "status": 200,
    })
    return True


# ── GET /api/hyrax/vn/conversations/{session_id}/events ─────────────────────


def _vn_serve_events(handler, parsed, sid: str) -> bool:
    """GET .../{session_id}/events — SSE alias for native session events.

    Validates VN ownership BEFORE SSE headers, then delegates exactly once
    to the native _handle_session_sse_stream_for_session handler.
    """
    # Validate VN ownership before sending any headers
    try:
        session = _get_session(sid, metadata_only=True)
    except KeyError:
        _j(handler, {"error": "not found"}, status=404)
        return True

    if not _vn_session_visible(session):
        _j(handler, {"error": "not found"}, status=404)
        return True

    # Bind the session's profile via thread-local request context
    owner_profile = getattr(session, "profile", None) or ""
    from api.profiles import request_profile_context

    with request_profile_context(owner_profile):
        # Delegate exactly once to the native SSE handler
        from api.routes import _handle_session_sse_stream_for_session

        result = _handle_session_sse_stream_for_session(handler, parsed, sid)
        return True if result is None else result


def _vn_serve_approval_alias(handler, parsed, sid: str, kind: str) -> bool:
    """GET .../{sid}/approvals/pending and .../{sid}/clarify/pending.

    The native /api/approval/pending and /api/clarify/pending endpoints 404
    for sister-profile sessions because the caller's active profile can't see
    them. This alias validates VN ownership, then delegates to the native
    handlers under the owning sister's profile context (same pattern as the
    events alias). kind is "approval" or "clarify".
    """
    try:
        session = _get_session(sid, metadata_only=True)
    except KeyError:
        _j(handler, {"error": "not found"}, status=404)
        return True

    if not _vn_session_visible(session):
        _j(handler, {"error": "not found"}, status=404)
        return True

    owner_profile = getattr(session, "profile", None) or ""
    from api.profiles import request_profile_context

    with request_profile_context(owner_profile):
        if kind == "clarify":
            from api.routes import _handle_clarify_pending

            return _handle_clarify_pending(handler, parsed)
        from api.routes import _handle_approval_pending

        return _handle_approval_pending(handler, parsed)
