"""
Hyraxknot Division — Essence runtime server half (Gestalt VN revamp).

Read-only essence-state aggregation, per-sister presence, and the Essence
Frame registry (read + manual authored-frame registration).

Endpoints (dispatched from api.hyrax_routes):
  - GET  /api/hyrax/essence/{operator}   — bounded essence state + normalized
                                           expression + affinity, fail closed
  - GET  /api/hyrax/essence/frames       — validated frame registry JSON
  - GET  /api/hyrax/presence             — per-sister live aggregation
  - POST /api/hyrax/essence/frames/register — register a manually dropped
                                           authored frame image
  - GET  /api/hyrax/essence/approvals    — D3 Josh approval-tier: pending
                                           essenced G8 approval requests
  - POST /api/hyrax/essence/approvals/respond — record Josh's approve/deny
                                           decision (actor josh:webui,
                                           server-stamped)
  - POST /api/hyrax/essence/whims/dismiss — file Josh's whim veto (actor
                                           josh, server-stamped) into the
                                           append-only dismiss store;
                                           essenced's poll closes the whim

Design contract: docs/gestalt-vn/ESSENCE_RUNTIME_SPEC.md (§4 signatures,
§6 expression enum, §7 registry) and GESTALT_VN_API_CONTRACTS.md (§2/§6/§7).

Security principles (match api/hyrax_routes.py):
  - Caller input NEVER becomes a filesystem path. The sister allowlist
    (VN_PROFILES) is fixed and immutable; the register endpoint validates the
    image as a bare filename inside the fixed drop directory only.
  - Everything is bounded: file reads are size-capped, strings are truncated,
    numbers are clamped finite.
  - Fail closed: missing/corrupt state yields neutral defaults with
    ``available: false`` and provenance "unknown" — never an exception.
"""

import hashlib
import json
import logging as _logging
import math as _math
import os
import re as _re
import threading as _threading
from datetime import datetime as _datetime
from datetime import timezone as _timezone
from pathlib import Path
from types import MappingProxyType as _MappingProxyType

from api.helpers import j as _j

# Reuse the fixed sister allowlist, kanban query helper, and native session
# accessors from the VN adapter. Imported at module level so tests can
# monkeypatch the names on THIS module (api.hyrax_essence.*).
from api.hyrax_routes import (
    KANBAN_DB as _KANBAN_DB,
    VN_PROFILES as _VN_PROFILES,
    _all_sessions,
    _get_session,
    _query,
    _vn_derive_expression,
)

_logger = _logging.getLogger(__name__)

# ── Paths (repo-owned; never derived from caller input) ─────────────────────
ESSENCE_ASSET_DIR = Path(__file__).resolve().parent.parent / "hyrax-assets" / "essence"
"""Root for Essence runtime assets (frame registry + manual frame drops)."""

ESSENCE_FRAMES_DIR = ESSENCE_ASSET_DIR / "frames"
"""Drop directory for manually authored frame images (register endpoint)."""

FRAME_REGISTRY_FILE = ESSENCE_ASSET_DIR / "frames.registry.json"
"""Versioned frame registry JSON (script-generated + register-appended)."""

# ── Bounds ───────────────────────────────────────────────────────────────────
MAX_STATE_FILE_BYTES = 256 * 1024        # essence/state.json + affinity.json reads
MAX_REGISTRY_FILE_BYTES = 4 * 1024 * 1024  # frame registry read
MAX_ESSENCE_STRING = 128                 # mood/mode/expression/last_updated
MAX_BOUNDARY_KEYS = 16                   # affinity boundaries dict
MAX_BOUNDARY_STRING = 64
MAX_FRAME_ID_LENGTH = 128
MAX_FRAME_IMAGE_BYTES = 8 * 1024 * 1024  # 8 MB authored frame image cap
MAX_FRAME_STATE_PROPS = 8
MAX_FRAME_PROP_LENGTH = 64
MAX_IMAGE_URL_LENGTH = 512
MAX_AFFINITY_SCORE = 100.0

# ── Canonical per-sister expression enum (ESSENCE_RUNTIME_SPEC §6) ──────────
# Single owner of the enum — unknown names normalize to the sister's neutral
# plus an issues[] entry. Intersection of plugin EXPRESSION_MAP outputs with
# manifest portraits available per sister.
EXPRESSION_ENUM: _MappingProxyType = _MappingProxyType({
    "tai": frozenset({"neutral", "smile", "happy-emote", "sarcastic", "focused"}),
    "rei": frozenset({"neutral", "calm", "alert"}),
    "nei": frozenset({"neutral", "observant", "thinking"}),
    "mai": frozenset({
        "neutral", "smile", "laughing", "light-smile", "ohhoai", "shy-smile",
        "scream-of-fury", "yandere-smile", "sarcastic", "focused",
    }),
})

NEUTRAL_EXPRESSION = "neutral"

# ── Curated expression fallback chains (fail closed, no invented frames) ────
# Every expression the runtime can EMIT must resolve to a member of each
# sister's enum — never silently to neutral when a valid near-equivalent
# exists. Emittable sources: essenced's rules.json expression_by_mood chains
# (smile, happy-emote, light-smile, calm, focused, thinking, observant,
# alert, scream-of-fury, sarcastic) and the keyword stopgap in
# api/hyrax_routes.py _VN_EXPRESSION_SIGNALS (laughing, happy, smile,
# teasing, annoyed, shy, thinking). Each chain lists nearest valid family
# members (hyrax-assets/essence/expression-families.json v2 families) in
# preference order; the first candidate inside the sister's enum wins. No
# chain introduces a name outside the existing enums, so every resolution
# maps to an expression that already has registered frames.
_EXPRESSION_FALLBACKS: dict[str, tuple[str, ...]] = {
    # Keyword-stopgap moods (_VN_EXPRESSION_SIGNALS).
    "laughing": ("laughing", "happy-emote", "smile", "light-smile", "calm"),
    "happy": ("happy-emote", "smile", "light-smile", "calm"),
    "teasing": ("sarcastic", "ohhoai", "smile", "light-smile", "alert", "calm"),
    "annoyed": (
        "scream-of-fury", "yandere-smile", "sarcastic", "alert",
        "focused", "thinking", "calm",
    ),
    "shy": ("shy-smile", "light-smile", "smile", "observant", "calm"),
    # rules.json expression_by_mood members absent from some enums.
    "smile": ("smile", "light-smile", "calm"),
    "happy-emote": ("happy-emote", "smile", "light-smile", "calm"),
    "light-smile": ("light-smile", "smile", "calm"),
    "calm": ("calm", "light-smile", "smile", "observant"),
    "focused": ("focused", "alert", "observant", "thinking"),
    "thinking": ("thinking", "observant", "focused", "alert"),
    "observant": ("observant", "thinking", "focused", "alert"),
    "alert": ("alert", "focused", "observant", "thinking"),
    "scream-of-fury": (
        "scream-of-fury", "yandere-smile", "sarcastic", "alert",
        "focused", "thinking",
    ),
    "sarcastic": ("sarcastic", "ohhoai", "alert", "calm"),
}

# ── Frame registry validation patterns ───────────────────────────────────────
_FRAME_ID_RE = _re.compile(r"^frame\.[a-z0-9-]+(\.[a-z0-9-]+)*$")
_FRAME_IMAGE_NAME_RE = _re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.(png|jpg|jpeg|webp)$", _re.IGNORECASE
)
_FRAME_SOURCES = frozenset({"generated", "authored", "cached", "fallback"})
# Servable frames/file asset URL form (bare name or thumbs/ subpath) — used
# to fail closed on malformed thumbnailUrl values in the registry reader.
_FRAME_FILE_URL_RE = _re.compile(
    r"^/api/hyrax/essence/frames/file/(?:thumbs/)?[A-Za-z0-9._-]+\.(?:png|jpg|jpeg|webp)$",
    _re.IGNORECASE,
)
_FRAME_STATE_KEYS = frozenset({
    "expression", "pose", "action", "wardrobe", "location", "lighting",
    "timeOfDay", "props", "camera",
})
_FRAME_CAMERAS = frozenset({"close", "medium", "wide"})
_TIME_OF_DAY_BANDS = frozenset({"morning", "day", "evening", "night"})

# Serializes registry read-modify-write for the register endpoint.
_REGISTRY_WRITE_LOCK = _threading.Lock()


# ── Expression normalization (ESSENCE_RUNTIME_SPEC §6) ──────────────────────

def normalize_expression(operator: str, raw) -> tuple[str, list[str]]:
    """Normalize a raw expression name against the sister's canonical enum.

    Returns (current, issues). Names outside the enum first walk the curated
    fallback chain (_EXPRESSION_FALLBACKS) to the nearest valid family member
    inside the enum — a known emittable expression must never collapse to
    neutral when a valid near-equivalent exists. Truly unknown names fall
    back to the sister's neutral expression and record an issues[] entry.
    Absent/empty input is not an error — it yields neutral with no issue.
    """
    enum = EXPRESSION_ENUM.get(operator) or frozenset({NEUTRAL_EXPRESSION})
    if not isinstance(raw, str) or not raw.strip():
        return NEUTRAL_EXPRESSION, []
    name = raw.strip()[:MAX_ESSENCE_STRING]
    if name in enum:
        return name, []
    for candidate in _EXPRESSION_FALLBACKS.get(name, ()):  # curated chain
        if candidate in enum:
            return candidate, []
    return NEUTRAL_EXPRESSION, [
        f"unknown expression '{name}' normalized to '{NEUTRAL_EXPRESSION}'"
    ]


# ── Scene signatures (ESSENCE_RUNTIME_SPEC §4) ───────────────────────────────

# Client-mirrored signature algorithm (static/hyrax/essence/essenceFrames.js).
# The registry and the browser MUST produce identical signatures for
# identical scenes or the exact-match tier is dead — keep these maps and the
# field order in lockstep with the client.
# Family assignments mirror the client (essenceFrames.js) and the curated
# table (hyrax-assets/essence/expression-families.json v2): the neutral and
# sad clusters keep the generated emotion sprites out of the 'neutral'
# fallback bucket — before this, every unmapped emotion resolved to 'neutral'
# and the resting face could select a crying frame.
_EXPRESSION_FAMILY = {
    "neutral": "neutral", "calm": "neutral",
    "smile": "positive", "happy-emote": "positive", "laughing": "positive",
    "light-smile": "positive", "shy-smile": "positive",
    "sarcastic": "wry", "ohhoai": "wry",
    "focused": "focused", "alert": "focused", "observant": "focused",
    "thinking": "focused",
    "scream-of-fury": "intense", "yandere-smile": "intense",
    # Curated neutral cluster (calm/flat baselines).
    "blank-stare": "neutral", "expressionless": "neutral",
    "deadpan": "neutral", "deadpan-face": "neutral",
    "tired-face": "neutral", "neutral-emote": "neutral",
    "indifferent": "neutral", "x-mouth": "neutral",
    "circle-eyes": "neutral", "bored": "neutral", "exhausted": "neutral",
    # Curated sad cluster.
    "sad": "sad", "crying": "sad", "depressed": "sad", "despair": "sad",
    "sobbing": "sad", "nostalgic-sadness": "sad", "bittersweet": "sad",
    "emotional-vulnerability": "sad", "silent-tears": "sad",
    "aching-heart": "sad", "silent-scream-anguish": "sad",
    "downtrodden": "sad", "exhausted-sigh": "sad",
    "crying-emote": "sad", "sad-emote": "sad", "disappointed": "sad",
    "traumatized": "sad",
}
_POSE_FAMILY = {
    "standing": "standing", "idle": "standing", "sitting": "sitting",
    "working": "working", "gesturing": "gesture",
}
_TIME_BANDS = ("morning", "day", "evening", "night")


def _fnv1a32_hex(text: str) -> str:
    """FNV-1a 32-bit, 8 hex chars — mirrors the client's _hash()."""
    h = 0x811C9DC5
    for ch in text:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"


def compute_scene_signature(operator_id: str, state) -> str:
    """Stable hash of COARSE frame-state fields only.

    operatorId · location · wardrobe · expressionFamily · poseFamily
    · timeOfDayBand · framing · majorProps[≤3]

    Conversational content, timestamps, and minor mood drift are explicitly
    excluded. Mirrors essenceFrames.computeSceneSignature EXACTLY (fields,
    family maps, defaults, FNV-1a) — shared by the registry build script and
    the register endpoint.
    """
    state = state if isinstance(state, dict) else {}

    def _norm(value) -> str:
        if not isinstance(value, str):
            return ""
        return value.lower().strip()

    def _family(value, table, default):
        return table.get(_norm(value), default)

    props = state.get("props")
    major_props: list[str] = []
    if isinstance(props, list):
        major_props = sorted({
            _norm(p) for p in props if isinstance(p, str) and p.strip()
        })[:3]

    time_of_day = _norm(state.get("timeOfDay"))
    if time_of_day not in _TIME_BANDS:
        # Band-less scenes stay band-less (empty field): frames without an
        # explicit timeOfDay must not bake in the generation hour, or the
        # registry goes stale every time the band rolls over.
        time_of_day = ""

    fields = [
        _norm(operator_id),
        _norm(state.get("location")),
        _norm(state.get("wardrobe")),
        _family(state.get("expression"), _EXPRESSION_FAMILY, "neutral"),
        _family(state.get("pose"), _POSE_FAMILY, "standing"),
        time_of_day,
        _norm(state.get("camera")) or "medium",
        ",".join(major_props),
    ]
    return _fnv1a32_hex("|".join(fields))


# ── Bounded JSON file reads (fail closed) ────────────────────────────────────

def _read_json_bounded(path: Path, max_bytes: int) -> dict | None:
    """Read a JSON object from path with a hard size cap. None on any failure."""
    try:
        st = os.lstat(path)
        if not os.path.isfile(path) or os.path.islink(path):
            return None
        if st.st_size <= 0 or st.st_size > max_bytes:
            return None
        with open(path, "rb") as fh:
            raw = fh.read(max_bytes + 1)
        if len(raw) > max_bytes:
            return None
        data = json.loads(raw.decode("utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _profile_home(operator: str) -> Path:
    """Resolve a sister's HERMES_HOME without mutating any process state.

    Derived via api.profiles (HERMES_HOME resolution) — never a hardcoded
    machine-specific literal.
    """
    from api.profiles import get_hermes_home_for_profile

    return get_hermes_home_for_profile(operator)


# ── Bounded scalar coercion helpers ──────────────────────────────────────────

def _bounded_str(value, max_len: int = MAX_ESSENCE_STRING) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip()[:max_len]


def _bounded_score(value, lo: float, hi: float) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    val = float(value)
    if not _math.isfinite(val):
        return None
    return min(hi, max(lo, val))


def _parse_iso_timestamp(raw) -> _datetime | None:
    text = _bounded_str(raw, 64)
    if text is None:
        return None
    try:
        ts = _datetime.fromisoformat(text)
    except ValueError:
        return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=_timezone.utc)
    return ts


def _now_utc() -> _datetime:
    return _datetime.now(_timezone.utc)


# ── GET /api/hyrax/essence/{operator} ────────────────────────────────────────

def build_essence_payload(operator: str, *, now: _datetime | None = None) -> dict:
    """Assemble the bounded essence payload for one sister. Never raises."""
    now = now or _now_utc()
    home = _profile_home(operator)
    state = _read_json_bounded(home / "essence" / "state.json", MAX_STATE_FILE_BYTES)
    affinity = _read_json_bounded(home / "affinity.json", MAX_STATE_FILE_BYTES)

    available = state is not None
    provenance: dict[str, str] = {}
    issues: list[str] = []
    if not available:
        state = {}
        issues.append("essence state unavailable — neutral defaults")

    # mood / energy / mode / last_updated — read from state.json
    mood = _bounded_str(state.get("mood"))
    provenance["mood"] = "read" if mood is not None else "unknown"
    mood = mood or NEUTRAL_EXPRESSION

    energy = _bounded_score(state.get("energy"), 0.0, 1.0)
    provenance["energy"] = "read" if energy is not None else "unknown"

    mode = _bounded_str(state.get("mode"))
    provenance["mode"] = "read" if mode is not None else "unknown"

    last_updated = _bounded_str(state.get("last_updated"), 64)
    provenance["last_updated"] = "read" if last_updated is not None else "unknown"

    # staleness_days — derived from last_updated
    staleness_days = None
    ts = _parse_iso_timestamp(last_updated)
    if ts is not None:
        staleness_days = round(max(0.0, (now - ts).total_seconds()) / 86400.0, 2)
    provenance["staleness_days"] = "derived" if staleness_days is not None else "unknown"

    # expression — read raw from state.json, normalized via the canonical enum
    raw_expression = None
    raw_intensity = None
    raw_expr_obj = state.get("expression")
    if isinstance(raw_expr_obj, dict):
        raw_expression = raw_expr_obj.get("current")
        raw_intensity = raw_expr_obj.get("intensity")
    current, expr_issues = normalize_expression(operator, raw_expression)
    issues.extend(expr_issues)
    remapped = (
        isinstance(raw_expression, str)
        and current != raw_expression.strip()[:MAX_ESSENCE_STRING]
    )
    if raw_expression is None:
        provenance["expression"] = "unknown"
        intensity = 0.0
    elif expr_issues or remapped:
        # Server-side normalization over a read value (issue fallback or a
        # curated enum mapping) → derived
        provenance["expression"] = "derived"
        intensity = _bounded_score(raw_intensity, 0.0, 1.0)
        intensity = intensity if intensity is not None else 0.0
    else:
        provenance["expression"] = "read"
        intensity = _bounded_score(raw_intensity, 0.0, 1.0)
        intensity = intensity if intensity is not None else 0.5

    # affinity — read (affinity.json v4), all fields optional
    rapport = trust = composite = None
    boundaries = None
    if affinity is not None:
        dimensions = affinity.get("dimensions")
        if isinstance(dimensions, dict):
            rapport = _bounded_score(dimensions.get("rapport"), 0.0, MAX_AFFINITY_SCORE)
            trust = _bounded_score(dimensions.get("trust"), 0.0, MAX_AFFINITY_SCORE)
        composite = _bounded_score(affinity.get("bond"), 0.0, MAX_AFFINITY_SCORE)
        global_blk = affinity.get("global")
        if isinstance(global_blk, dict):
            raw_boundaries = global_blk.get("boundaries")
            if isinstance(raw_boundaries, dict):
                effective = raw_boundaries.get("effective")
                if isinstance(effective, dict):
                    boundaries = _sanitize_boundaries(effective)
    provenance["rapport"] = "read" if rapport is not None else "unknown"
    provenance["trust"] = "read" if trust is not None else "unknown"
    provenance["composite"] = "read" if composite is not None else "unknown"
    provenance["boundaries"] = "read" if boundaries is not None else "unknown"

    return {
        "operator": operator,
        "available": available,
        "mood": mood,
        "energy": energy,
        "mode": mode,
        "last_updated": last_updated,
        "staleness_days": staleness_days,
        "expression": {
            "current": current,
            "intensity": intensity,
            "issues": issues,
        },
        "affinity": {
            "rapport": rapport,
            "trust": trust,
            "composite": composite,
            "boundaries": boundaries,
        },
        "provenance": provenance,
        "generated_at": now.isoformat(),
    }


def _sanitize_boundaries(raw: dict) -> dict | None:
    """Bounded primitive-only copy of an affinity boundaries dict."""
    out: dict = {}
    for key, value in raw.items():
        if len(out) >= MAX_BOUNDARY_KEYS:
            break
        if not isinstance(key, str) or not key:
            continue
        safe_key = key[:MAX_BOUNDARY_STRING]
        if isinstance(value, bool):
            out[safe_key] = value
        elif isinstance(value, (int, float)) and _math.isfinite(float(value)):
            out[safe_key] = value
        elif isinstance(value, str):
            out[safe_key] = value[:MAX_BOUNDARY_STRING]
    return out or None


def _serve_operator_essence(handler, operator: str) -> bool:
    """GET /api/hyrax/essence/{operator} — bounded essence state."""
    try:
        payload = build_essence_payload(operator)
    except Exception:
        # Fail closed — never surface an exception as a 500 with internals.
        _logger.warning("essence payload build failed for one operator", exc_info=True)
        payload = {
            "operator": operator,
            "available": False,
            "mood": NEUTRAL_EXPRESSION,
            "energy": None,
            "mode": None,
            "last_updated": None,
            "staleness_days": None,
            "expression": {
                "current": NEUTRAL_EXPRESSION,
                "intensity": 0.0,
                "issues": ["essence state unavailable — neutral defaults"],
            },
            "affinity": {
                "rapport": None,
                "trust": None,
                "composite": None,
                "boundaries": None,
            },
            "provenance": {},
            "generated_at": _now_utc().isoformat(),
        }
    _j(handler, payload)
    return True


# ── Frame registry: shared validation ────────────────────────────────────────

def _sanitize_frame_state_lenient(raw) -> dict:
    """Reader-side tolerant state cleanup: keep known keys with valid values."""
    if not isinstance(raw, dict):
        return {}
    state: dict = {}
    for key, value in raw.items():
        if key not in _FRAME_STATE_KEYS:
            continue
        if key == "props":
            if isinstance(value, list):
                props = [
                    p.strip()[:MAX_FRAME_PROP_LENGTH]
                    for p in value
                    if isinstance(p, str) and p.strip()
                ][:MAX_FRAME_STATE_PROPS]
                if props:
                    state["props"] = props
        elif key == "camera":
            if value in _FRAME_CAMERAS:
                state["camera"] = value
        else:
            text = _bounded_str(value)
            if text is not None:
                state[key] = text
    return state


def _validate_frame_state_strict(raw):
    """Writer-side strict state validation → (state, None) or (None, error)."""
    if raw is None:
        return {}, None
    if not isinstance(raw, dict):
        return None, "state must be an object"
    extra = set(raw.keys()) - _FRAME_STATE_KEYS
    if extra:
        return None, "state has unknown keys"
    state: dict = {}
    for key, value in raw.items():
        if key == "props":
            if not isinstance(value, list) or len(value) > MAX_FRAME_STATE_PROPS:
                return None, "props must be a list of at most 8 strings"
            props = []
            for item in value:
                if not isinstance(item, str) or not item.strip():
                    return None, "props must be non-empty strings"
                if len(item) > MAX_FRAME_PROP_LENGTH:
                    return None, "prop string too long"
                props.append(item.strip())
            state["props"] = props
        elif key == "camera":
            if value not in _FRAME_CAMERAS:
                return None, "camera must be close|medium|wide"
            state["camera"] = value
        else:
            if not isinstance(value, str) or not value.strip():
                return None, f"state.{key} must be a non-empty string"
            if len(value) > MAX_ESSENCE_STRING:
                return None, f"state.{key} too long"
            state[key] = value.strip()
    return state, None


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_positive_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _sanitize_sprite_crop(raw) -> dict | None:
    """Validate assets.crop {x, y, w, h} (content bbox, source pixels)."""
    if not isinstance(raw, dict):
        return None
    x, y, w, h = raw.get("x"), raw.get("y"), raw.get("w"), raw.get("h")
    if (
        isinstance(x, int) and not isinstance(x, bool) and x >= 0
        and isinstance(y, int) and not isinstance(y, bool) and y >= 0
        and _is_positive_int(w) and _is_positive_int(h)
    ):
        return {"x": x, "y": y, "w": w, "h": h}
    return None


def _sanitize_registry_frame(raw) -> dict | None:
    """Validate one registry frame for the GET reader. None → drop entry."""
    if not isinstance(raw, dict):
        return None
    frame_id = raw.get("id")
    if not isinstance(frame_id, str) or len(frame_id) > MAX_FRAME_ID_LENGTH:
        return None
    if not _FRAME_ID_RE.match(frame_id):
        return None
    operator = raw.get("operatorId")
    if operator not in _VN_PROFILES:
        return None
    source = raw.get("source")
    if source not in _FRAME_SOURCES:
        return None
    signature = raw.get("sceneSignature")
    if not isinstance(signature, str) or not signature or len(signature) > 64:
        return None
    assets = raw.get("assets")
    if not isinstance(assets, dict):
        return None
    image_url = assets.get("imageUrl")
    if not isinstance(image_url, str) or not image_url:
        return None
    quality = raw.get("quality")
    if not isinstance(quality, dict) or not isinstance(quality.get("approved"), bool):
        return None
    frame = {
        "id": frame_id,
        "operatorId": operator,
        "version": _bounded_str(raw.get("version"), 16) or "1",
        "source": source,
        "sceneSignature": signature[:64],
        "state": _sanitize_frame_state_lenient(raw.get("state")),
        "assets": {"imageUrl": image_url[:MAX_IMAGE_URL_LENGTH]},
        "quality": {
            "approved": quality["approved"],
            "issues": [
                i[:MAX_ESSENCE_STRING] for i in quality.get("issues", [])
                if isinstance(i, str)
            ][:8] if isinstance(quality.get("issues"), list) else [],
        },
        "continuity": raw.get("continuity") if isinstance(raw.get("continuity"), dict) else {},
    }
    # Layer kind (portrait/background/chibi) — the frame layer filters on it.
    kind = raw.get("kind")
    if isinstance(kind, str) and kind in ("portrait", "background", "chibi"):
        frame["kind"] = kind
    sha256 = assets.get("sha256")
    if isinstance(sha256, str) and _re.match(r"^[a-f0-9]{64}$", sha256):
        frame["assets"]["sha256"] = sha256
    size = assets.get("size")
    if isinstance(size, int) and not isinstance(size, bool) and size > 0:
        frame["assets"]["size"] = size
    for optional in ("thumbnailUrl", "maskUrl", "depthUrl"):
        value = assets.get(optional)
        if not isinstance(value, str) or not value:
            continue
        if optional == "thumbnailUrl" and not _FRAME_FILE_URL_RE.match(value):
            # Fail closed, same bar as imageUrl: a malformed thumb URL is
            # dropped from the payload, never passed to clients.
            continue
        frame["assets"][optional] = value[:MAX_IMAGE_URL_LENGTH]
    # Sprite calibration (scripts/calibrate_frame_crops.py): content bbox +
    # ready display params for the VN stage. Fail closed per field — unknown
    # types are dropped, never fatal.
    crop = _sanitize_sprite_crop(assets.get("crop"))
    if crop is not None:
        frame["assets"]["crop"] = crop
    source_size = assets.get("sourceSize")
    if (
        isinstance(source_size, dict)
        and _is_positive_int(source_size.get("w"))
        and _is_positive_int(source_size.get("h"))
    ):
        frame["assets"]["sourceSize"] = {"w": source_size["w"], "h": source_size["h"]}
    display = assets.get("display")
    if isinstance(display, dict):
        scale = display.get("scale")
        focus_x = display.get("focusX")
        obj_pos_y = display.get("objectPositionY")
        if (
            _is_number(scale) and 1.0 <= scale <= 4.0
            and _is_number(focus_x) and 0.0 <= focus_x <= 1.0
            and _is_number(obj_pos_y) and 0.0 <= obj_pos_y <= 1.0
        ):
            frame["assets"]["display"] = {
                "scale": scale,
                "focusX": focus_x,
                "objectPositionY": obj_pos_y,
            }
    registered_at = raw.get("registeredAt")
    if isinstance(registered_at, str) and registered_at:
        frame["registeredAt"] = registered_at[:64]
    return frame


# ── GET /api/hyrax/essence/frames ────────────────────────────────────────────

def _load_registry_payload() -> dict:
    """Read + validate the frame registry. Fail closed to an empty registry."""
    raw = _read_json_bounded(FRAME_REGISTRY_FILE, MAX_REGISTRY_FILE_BYTES)
    if raw is None or raw.get("version") != 1 or not isinstance(raw.get("frames"), list):
        return {
            "version": 1,
            "frames": [],
            "meta": {"total": 0, "dropped": 0, "available": False},
        }
    frames = []
    dropped = 0
    for entry in raw["frames"]:
        frame = _sanitize_registry_frame(entry)
        if frame is None:
            dropped += 1
        else:
            frames.append(frame)
    return {
        "version": 1,
        "frames": frames,
        "meta": {"total": len(frames), "dropped": dropped, "available": True},
    }


def _serve_frames_registry(handler, parsed=None) -> bool:
    """GET /api/hyrax/essence/frames[?operator=<id>] — validated registry JSON."""
    payload = _load_registry_payload()
    if parsed is not None:
        from urllib.parse import parse_qs

        operator = (parse_qs(getattr(parsed, "query", "") or "").get("operator") or [""])[0]
        if operator:
            payload = dict(payload)
            payload["frames"] = [
                f for f in payload.get("frames", [])
                if isinstance(f, dict) and f.get("operatorId") == operator
            ]
            meta = dict(payload.get("meta") or {})
            meta["total"] = len(payload["frames"])
            payload["meta"] = meta
    _j(handler, payload)
    return True


# ── POST /api/hyrax/essence/frames/register ──────────────────────────────────

def _load_registry_raw() -> dict | None:
    """Load the raw registry for read-modify-write.

    Missing file → fresh skeleton. Corrupt/unreadable → None (fail closed;
    appending to a corrupt registry would silently destroy entries).
    """
    if not FRAME_REGISTRY_FILE.is_file():
        return {"version": 1, "policy": "fixed-sfw-allowlist", "frames": []}
    raw = _read_json_bounded(FRAME_REGISTRY_FILE, MAX_REGISTRY_FILE_BYTES)
    if raw is None or raw.get("version") != 1 or not isinstance(raw.get("frames"), list):
        return None
    return raw


def _atomic_write_json(path: Path, payload: dict) -> None:
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w") as fh:
        json.dump(payload, fh, indent=2)
        fh.write("\n")
    os.replace(tmp, path)


def _validate_dropped_image(filename):
    """Validate a dropped frame image. → (digest, size, None) or (None, None, error).

    The filename must be a bare basename inside the fixed drop directory —
    never a caller-supplied path.
    """
    if not isinstance(filename, str) or not filename:
        return None, None, "image filename required"
    if len(filename) > MAX_FRAME_ID_LENGTH:
        return None, None, "image filename too long"
    if (
        "/" in filename
        or "\\" in filename
        or ".." in filename
        or "%" in filename
        or not _FRAME_IMAGE_NAME_RE.match(filename)
    ):
        return None, None, "invalid image filename"
    candidate = ESSENCE_FRAMES_DIR / filename
    try:
        base = ESSENCE_FRAMES_DIR.resolve(strict=True)
        if candidate.is_symlink():
            return None, None, "image not found"
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(base)
        st = os.lstat(candidate)
    except (OSError, ValueError):
        return None, None, "image not found"
    if not os.path.isfile(candidate):
        return None, None, "image not found"
    if st.st_size <= 0 or st.st_size > MAX_FRAME_IMAGE_BYTES:
        return None, None, "image size out of bounds"
    digest = hashlib.sha256()
    try:
        with open(candidate, "rb") as fh:
            while True:
                chunk = fh.read(64 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
    except OSError:
        return None, None, "image unreadable"
    return digest.hexdigest(), st.st_size, None


def _handle_frame_register(handler, body) -> bool:
    """POST /api/hyrax/essence/frames/register — register an authored frame."""
    if not isinstance(body, dict):
        _j(handler, {"error": "bad request"}, status=400)
        return True
    extra = set(body.keys()) - {"id", "operatorId", "state", "image"}
    if extra:
        _j(handler, {"error": "bad request"}, status=400)
        return True

    frame_id = body.get("id")
    if (
        not isinstance(frame_id, str)
        or len(frame_id) > MAX_FRAME_ID_LENGTH
        or not _FRAME_ID_RE.match(frame_id)
    ):
        _j(handler, {"error": "invalid frame id"}, status=400)
        return True

    operator = body.get("operatorId")
    if operator not in _VN_PROFILES:
        _j(handler, {"error": "unknown operator"}, status=400)
        return True

    state, state_err = _validate_frame_state_strict(body.get("state"))
    if state_err is not None:
        _j(handler, {"error": state_err}, status=400)
        return True

    digest, size, img_err = _validate_dropped_image(body.get("image"))
    if img_err is not None:
        _j(handler, {"error": img_err}, status=400)
        return True

    with _REGISTRY_WRITE_LOCK:
        registry = _load_registry_raw()
        if registry is None:
            _j(handler, {"error": "registry unavailable"}, status=500)
            return True
        for entry in registry["frames"]:
            if isinstance(entry, dict) and entry.get("id") == frame_id:
                _j(handler, {"error": "conflict"}, status=409)
                return True

        frame = {
            "id": frame_id,
            "operatorId": operator,
            "version": "1",
            "source": "authored",
            "sceneSignature": compute_scene_signature(operator, state),
            "state": state,
            "assets": {
                # Servable URL — GET /api/hyrax/essence/frames/file/<image>
                # (hardened serving, registry-membership enforced).
                "imageUrl": f"/api/hyrax/essence/frames/file/{body['image']}",
                "sha256": digest,
                "size": size,
            },
            "quality": {"approved": True, "issues": []},
            "continuity": {},
            "registeredAt": _now_utc().isoformat(),
        }
        registry["frames"].append(frame)
        try:
            _atomic_write_json(FRAME_REGISTRY_FILE, registry)
        except OSError:
            _j(handler, {"error": "registry unavailable"}, status=500)
            return True

    _j(handler, {"frame": frame, "status": 200})
    return True


# ── GET /api/hyrax/presence ──────────────────────────────────────────────────

_PRESENCE_KANBAN_SQL = (
    "SELECT assignee AS name, "
    "SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running_count, "
    "SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END) AS blocked_count "
    "FROM tasks WHERE assignee IS NOT NULL AND assignee != '' GROUP BY assignee"
)

# Most relevant current task per assignee: a running task (active claim or
# in-flight run first, then most recent activity), else the most recently
# filed ready work order — freshly filed work must not be invisible while it
# waits for a worker claim. Ranking happens in Python so the SQL stays a
# plain read over the hermes kanban tasks schema; any missing table/column
# makes _query fail closed to [] (→ currentTask null, never 500).
_PRESENCE_CURRENT_TASK_SQL = (
    "SELECT assignee AS name, id AS task_id, title, status, "
    "claim_lock, current_run_id, "
    "COALESCE(last_heartbeat_at, started_at, created_at) AS activity_ts "
    "FROM tasks "
    "WHERE assignee IS NOT NULL AND assignee != '' "
    "AND status IN ('running', 'ready')"
)

_ACTIVITY_INTERRUPTIBILITY = {
    "idle": "free",
    "conversing": "soft-busy",
    "tool-working": "busy",
    "waiting-approval": "busy",
}

# essenced (Essence active runtime) publishes a per-sister
# essence/derived_state.json (schema v2). Presence merges it only while it is
# fresher than this many seconds; anything older/missing/corrupt falls back
# to exactly the live-sources-only behavior.
DERIVED_STATE_FRESH_SECONDS = 120.0

_DERIVED_STATE_UNAVAILABLE = {
    "fresh": False,
    "mood": None,
    "energy": None,
    "focus": None,
    "stress": None,
    "staleness_days": None,
    "poseIntent": None,
    "sceneIntent": None,
    "tone": None,
    "whims": [],
    "whimHistory": [],
    "whimFulfilledTotal": 0,
}

MAX_WHIM_ID_LENGTH = 64
MAX_WHIM_HISTORY = 5
_WHIM_HISTORY_KINDS = frozenset({
    "whim_fulfilled", "whim_expired", "whim_dismissed",
})
# Journal tail read for the whim history (bounded; the file is append-only
# and can grow unbounded, so only the tail window is ever read).
_MAX_JOURNAL_TAIL_BYTES = 64 * 1024


def _bounded_epoch(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    val = float(value)
    return val if _math.isfinite(val) and val > 0 else None


def _derived_whims(state: dict) -> list:
    """Active whims out of essenced's meta.whims (read-only, bounded).

    Each entry carries {id, text, firedAt, source}: the resolved "verb
    object" text for the HQ chip plus the fields the whims panel needs —
    id for the dismiss action, firedAt (epoch seconds, null until the fire
    message delivers), and source (the concrete object the whim is about).
    Capped at 2 entries / 80-char text. Anything malformed fails closed
    to [].
    """
    meta = state.get("meta")
    if not isinstance(meta, dict):
        return []
    whims = meta.get("whims")
    if not isinstance(whims, dict):
        return []
    active = whims.get("active")
    if not isinstance(active, list):
        return []
    out = []
    for whim in active[:2]:
        if not isinstance(whim, dict):
            continue
        text = _bounded_str(whim.get("text"), 80)
        whim_id = _bounded_str(whim.get("whim_id"), MAX_WHIM_ID_LENGTH)
        if not text or not whim_id:
            continue
        out.append({
            "id": whim_id,
            "text": text,
            "firedAt": _bounded_epoch(whim.get("fired_at")),
            "source": _bounded_str(whim.get("object"), MAX_ESSENCE_STRING),
        })
    return out


def _derived_whim_fulfilled_total(state: dict) -> int:
    """meta.whims.fulfilled_total (lifetime fulfillment count). 0 on miss."""
    try:
        return max(0, int(
            ((state.get("meta") or {}).get("whims") or {})
            .get("fulfilled_total") or 0))
    except (TypeError, ValueError):
        return 0


def _whim_history(profile: str) -> list:
    """Recent whim lifecycle events from the operator's outreach journal
    tail (read-only, bounded): fulfilled (with moodlet), expired, dismissed.

    Newest first, capped at MAX_WHIM_HISTORY. Any read/parse problem fails
    closed to []. Journal lines essenced writes carry ts (ISO), kind,
    whim_id, text, and (for fulfilled/dismissed) moodlet.
    """
    path = _profile_home(profile) / "essence" / "outreach_journal.jsonl"
    try:
        if not os.path.isfile(path) or os.path.islink(path):
            return []
        size = os.lstat(path).st_size
        with open(path, "rb") as fh:
            if size > _MAX_JOURNAL_TAIL_BYTES:
                fh.seek(-_MAX_JOURNAL_TAIL_BYTES, os.SEEK_END)
            raw = fh.read(_MAX_JOURNAL_TAIL_BYTES + 1)
        lines = raw.decode("utf-8", errors="replace").splitlines()
        if size > _MAX_JOURNAL_TAIL_BYTES and lines:
            lines = lines[1:]  # drop the partial first line of the window
    except OSError:
        return []
    out = []
    for line in reversed(lines):
        if len(out) >= MAX_WHIM_HISTORY:
            break
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict):
            continue
        kind = entry.get("kind")
        if kind not in _WHIM_HISTORY_KINDS:
            continue
        item = {
            "kind": kind,
            "whimId": _bounded_str(entry.get("whim_id"), MAX_WHIM_ID_LENGTH),
            "text": _bounded_str(entry.get("text"), 80),
            "ts": _bounded_str(entry.get("ts"), 64),
        }
        moodlet = _bounded_str(entry.get("moodlet"), MAX_ESSENCE_STRING)
        if moodlet is not None:
            item["moodlet"] = moodlet
        actor = _bounded_str(entry.get("actor"), 64)
        if actor is not None:
            item["actor"] = actor
        out.append(item)
    return out


def _derived_leaf(state: dict, *parts: str):
    """Dotted-path leaf value out of a schema-v2 derived_state. None on miss."""
    node = state
    for part in parts:
        if not isinstance(node, dict):
            return None
        node = node.get(part)
    if not isinstance(node, dict):
        return None
    return node.get("value")


def _presence_derived_state(profile: str) -> tuple[dict, dict | None]:
    """Read essenced's derived_state.json for one sister (read-only, bounded).

    Returns (block, expression):
      - block: the compact derivedState payload for the presence item. When
        the file is missing/stale/corrupt this is _DERIVED_STATE_UNAVAILABLE
        (fresh: false, all nulls) — never an exception, never a 500. The
        presentation intents (poseIntent/sceneIntent/tone) are non-null only
        while fresh: they drive the VN stage and voice, so a stale file must
        never move pose, scene, or tone.
      - expression: {"current", "intensity"} to REPLACE the session-derived
        expression, or None. Only non-None when the file is fresh: essenced's
        presentation.expression is the runtime-owned mood→expression mapping,
        but only while it reflects recent activity. Presence's own activity /
        pendingApprovals / kanban are always kept — they are live and richer
        (the sessions watcher cannot see pending approvals or tool outcomes).

    Freshness is file mtime (same signal essenced --check-staleness uses).
    """
    try:
        path = _profile_home(profile) / "essence" / "derived_state.json"
        st = os.lstat(path)
        if not os.path.isfile(path) or os.path.islink(path):
            return dict(_DERIVED_STATE_UNAVAILABLE), None
        state = _read_json_bounded(path, MAX_STATE_FILE_BYTES)
        if state is None or state.get("version") != 2:
            return dict(_DERIVED_STATE_UNAVAILABLE), None
        age = max(0.0, _now_utc().timestamp() - st.st_mtime)
        fresh = age < DERIVED_STATE_FRESH_SECONDS
        block = {
            "fresh": fresh,
            "mood": _bounded_str(_derived_leaf(state, "mood", "primary")),
            "energy": _bounded_score(_derived_leaf(state, "condition", "energy"), 0.0, 1.0),
            "focus": _bounded_score(_derived_leaf(state, "condition", "focus"), 0.0, 1.0),
            "stress": _bounded_score(_derived_leaf(state, "condition", "stress"), 0.0, 1.0),
            # Fresh state is by definition <120s old → staleness_days 0.
            "staleness_days": 0 if fresh else round(age / 86400.0, 2),
            # Presentation intents (poseIntent/sceneIntent) drive the VN
            # stage, so they are exposed ONLY while fresh — a stale file
            # must never move the sprite or the room (fail closed → null,
            # the client keeps its current presentation).
            "poseIntent": (
                _bounded_str(_derived_leaf(state, "presentation", "poseIntent"))
                if fresh else None
            ),
            "sceneIntent": (
                _bounded_str(_derived_leaf(state, "presentation", "sceneIntent"))
                if fresh else None
            ),
            # Voice tone token (mood-to-voice): fresh-only like the other
            # presentation intents — a stale file must never color speech.
            "tone": (
                _bounded_str(_derived_leaf(state, "presentation", "tone"))
                if fresh else None
            ),
            # Whims layer (WHIMS_LAYER_SPEC.md): active per-operator whims
            # from meta.whims. Fresh-only like the other derived fields —
            # a stale file must never show a dead want.
            "whims": _derived_whims(state) if fresh else [],
            # Whim history (fulfilled/expired/dismissed, from the outreach
            # journal tail) and the lifetime fulfillment count are a
            # historical record, not a live intent — served whenever the
            # derived state file parses, fresh or stale.
            "whimHistory": _whim_history(profile),
            "whimFulfilledTotal": _derived_whim_fulfilled_total(state),
        }
        expression = None
        if fresh:
            current, _issues = normalize_expression(
                profile, _derived_leaf(state, "presentation", "expression")
            )
            intensity = _bounded_score(
                _derived_leaf(state, "presentation", "intensity"), 0.0, 1.0
            )
            expression = {
                "current": current,
                "intensity": intensity if intensity is not None else 0.5,
            }
        return block, expression
    except Exception:
        _logger.warning("derived_state read failed for one sister", exc_info=True)
        return dict(_DERIVED_STATE_UNAVAILABLE), None


def derived_presentation_expression(operator: str) -> dict | None:
    """Fresh essenced presentation.expression for one sister, else None.

    Shared consumer entry point (presence + the VN conversation payload):
    when essenced's derived_state.json is fresh, its runtime-owned
    mood→expression mapping wins; anything else (missing/stale/corrupt
    file, unknown operator) fails closed to None so the caller keeps its
    own fallback (the keyword stopgap in api.hyrax_routes).
    """
    if operator not in _VN_PROFILES:
        return None
    _block, expression = _presence_derived_state(operator)
    return expression


def _bounded_count(value) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _presence_kanban_counts() -> dict:
    """Kanban running/blocked counts grouped by assignee (lowercased)."""
    counts: dict = {}
    for row in _query(_KANBAN_DB, _PRESENCE_KANBAN_SQL):
        name = row.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        counts[name.strip().lower()] = {
            "running": _bounded_count(row.get("running_count")),
            "blocked": _bounded_count(row.get("blocked_count")),
        }
    return counts


def _presence_current_tasks() -> dict:
    """Most relevant current kanban task per assignee → {id, title}.

    Deterministic ranking tiers: a running task with an active claim lock
    or in-flight run outranks a plain running task, which outranks a ready
    (filed, not yet claimed) work order; ties break on most recent activity
    (heartbeat, else start, else creation), then on task id. Ready tasks
    are included so work an operator just filed is visible before any
    worker claims it. Fail closed: any missing table/column makes _query
    return [] → empty dict → currentTask null on every item. Never raises.
    """
    best: dict = {}
    for row in _query(_KANBAN_DB, _PRESENCE_CURRENT_TASK_SQL):
        name = row.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        title = _bounded_str(row.get("title"), MAX_ESSENCE_STRING)
        task_id = row.get("task_id")
        if title is None or task_id is None:
            continue
        if row.get("claim_lock") or row.get("current_run_id") is not None:
            tier = 2
        elif row.get("status") == "running":
            tier = 1
        else:
            tier = 0
        try:
            activity_ts = float(row.get("activity_ts") or 0)
        except (TypeError, ValueError):
            activity_ts = 0.0
        task_id = str(task_id)[:64]
        rank = (tier, activity_ts, task_id)
        key = name.strip().lower()
        current = best.get(key)
        if current is None or rank > current[0]:
            best[key] = (rank, {"id": task_id, "title": title})
    return {key: task for key, (_, task) in best.items()}


def _pending_approval_count(session_id: str) -> int:
    """Best-effort pending-approval count for one session.

    Reads the in-memory approval queue under its lock. Returns 0 whenever the
    approval subsystem is unavailable — presence must never block on it.
    """
    try:
        from api.route_approvals import _lock as _approval_lock
        from api.route_approvals import _pending as _approval_pending

        with _approval_lock:
            entries = _approval_pending.get(session_id)
            if isinstance(entries, list):
                return len(entries)
            return 1 if entries else 0
    except Exception:
        return 0


def _select_newest_vn_session(sessions: list, profile: str) -> dict | None:
    """Newest unarchived hyrax-vn compact session dict for one sister."""
    candidates = [
        s for s in sessions
        if isinstance(s, dict)
        and not s.get("archived", False)
        and s.get("profile") == profile
        and s.get("project_id") == "hyrax-vn"
    ]
    if not candidates:
        return None
    candidates.sort(
        key=lambda s: (
            s.get("updated_at", 0) or 0,
            s.get("created_at", 0) or 0,
            s.get("session_id", "") or "",
        ),
        reverse=True,
    )
    return candidates[0]


def _session_has_active_tool(session) -> bool:
    """Heuristic: the latest message is an assistant row with tool_calls.

    Presentational only — during a streaming run, a trailing assistant
    message with unresolved tool_calls means a tool is (likely) in flight;
    a trailing tool/user row means the agent is composing (conversing).
    """
    messages = getattr(session, "messages", None) or []
    for msg in reversed(messages[-8:]):
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        if role == "assistant":
            tool_calls = msg.get("tool_calls")
            return isinstance(tool_calls, list) and len(tool_calls) > 0
        if role in ("tool", "user"):
            return False
    return False


def _presence_expression(session) -> dict:
    """Latest expression for presence: session-carried, else derived, else neutral."""
    expr = getattr(session, "expression", None)
    if isinstance(expr, dict):
        current = _bounded_str(expr.get("current"))
        if current is not None:
            intensity = _bounded_score(expr.get("intensity"), 0.0, 1.0)
            return {
                "current": current,
                "intensity": intensity if intensity is not None else 0.5,
            }
    messages = getattr(session, "messages", None) or []
    tail = [
        {"role": m.get("role"), "content": m.get("content") if isinstance(m.get("content"), str) else ""}
        for m in messages[-20:]
        if isinstance(m, dict) and m.get("role") in ("user", "assistant")
    ]
    derived = _vn_derive_expression(tail)
    if derived:
        return {"current": derived[:MAX_ESSENCE_STRING], "intensity": 0.5}
    return {"current": NEUTRAL_EXPRESSION, "intensity": 0.0}


def _presence_item(profile: str, sessions: list, kanban: dict,
                   current_tasks: dict | None = None) -> dict:
    meta = _VN_PROFILES[profile]
    candidate = _select_newest_vn_session(sessions, profile)
    sid = ""
    session = None
    if candidate is not None:
        raw_sid = candidate.get("session_id")
        if isinstance(raw_sid, str):
            sid = raw_sid[:64]
    pending = _pending_approval_count(sid) if sid else 0
    streaming = bool(candidate.get("active_stream_id")) if candidate else False

    if sid:
        try:
            session = _get_session(sid)
        except Exception:
            session = None

    activity_type = "idle"
    if sid:
        if pending > 0:
            activity_type = "waiting-approval"
        elif streaming:
            if session is not None and _session_has_active_tool(session):
                activity_type = "tool-working"
            else:
                activity_type = "conversing"

    expression = (
        _presence_expression(session)
        if session is not None
        else {"current": NEUTRAL_EXPRESSION, "intensity": 0.0}
    )

    # essenced derived state (fresh <120s): expression + the compact
    # derivedState block come from it; activity/pendingApprovals/kanban stay
    # live (presence's sources are richer — derived activity cannot see
    # pending approvals or tool outcomes).
    derived_block, derived_expression = _presence_derived_state(profile)
    if derived_expression is not None:
        expression = derived_expression

    # essenceStateUpdatedAt — read-only, cheap, fail closed to omitted
    essence_updated_at = None
    try:
        state = _read_json_bounded(
            _profile_home(profile) / "essence" / "state.json", MAX_STATE_FILE_BYTES
        )
        if state is not None:
            essence_updated_at = _bounded_str(state.get("last_updated"), 64)
    except Exception:
        essence_updated_at = None

    item = {
        "operatorId": profile,
        "available": bool(meta["available"]),
        "activity": {
            "type": activity_type,
            "interruptibility": _ACTIVITY_INTERRUPTIBILITY[activity_type],
        },
        "expression": expression,
        "pendingApprovals": pending,
        "kanban": dict(kanban.get(profile) or {"running": 0, "blocked": 0}),
        "currentTask": (current_tasks or {}).get(profile),
        "derivedState": derived_block,
    }
    if essence_updated_at is not None:
        item["essenceStateUpdatedAt"] = essence_updated_at
    return item


def _presence_fallback_item(profile: str) -> dict:
    """Neutral per-sister fallback when aggregation fails for that sister."""
    return {
        "operatorId": profile,
        "available": bool(_VN_PROFILES[profile]["available"]),
        "activity": {"type": "idle", "interruptibility": "free"},
        "expression": {"current": NEUTRAL_EXPRESSION, "intensity": 0.0},
        "pendingApprovals": 0,
        "kanban": {"running": 0, "blocked": 0},
        "currentTask": None,
        "derivedState": dict(_DERIVED_STATE_UNAVAILABLE),
    }


def _serve_presence(handler) -> bool:
    """GET /api/hyrax/presence — per-sister live aggregation (bounded)."""
    try:
        sessions = _all_sessions()
    except Exception:
        sessions = []
    kanban = _presence_kanban_counts()
    current_tasks = _presence_current_tasks()
    items = []
    for profile in _VN_PROFILES:
        try:
            items.append(_presence_item(profile, sessions, kanban, current_tasks))
        except Exception:
            _logger.warning("presence aggregation failed for one sister", exc_info=True)
            items.append(_presence_fallback_item(profile))
    _j(handler, {"items": items, "meta": {"generatedAt": _now_utc().isoformat()}})
    return True


# ── GET /api/hyrax/essence/frames/file/<filename> ─────────────────────────────
# <filename> is a bare basename or thumbs/<name> (compressed WebP variants
# built by scripts/build_frame_thumbnails.py); both are registry-allowlisted.

_FRAME_FILENAME_RE = _re.compile(r"^[A-Za-z0-9._-]+\.(?:png|jpg|jpeg|webp)$")
_FRAME_THUMBS_SUBDIR = "thumbs/"
_FRAME_CONTENT_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}
MAX_FRAME_FILE_BYTES = 8 * 1024 * 1024
_FRAME_CHUNK = 64 * 1024


def _frame_file_path_ok(filename: str) -> bool:
    """True for a bare frame filename or one inside the thumbs/ subdir.

    Thumbnails live in frames/thumbs/<name>.webp; everything else with a
    path separator (including ``thumbs/../../x`` traversal) is rejected
    here, before any filesystem touch.
    """
    name = filename
    if name.startswith(_FRAME_THUMBS_SUBDIR):
        name = name[len(_FRAME_THUMBS_SUBDIR):]
    elif "/" in name:
        return False
    if not name or "/" in name:
        return False
    return bool(_FRAME_FILENAME_RE.match(name))


def _frame_file_registered(filename: str) -> bool:
    """True only when a registered frame references this exact filename.

    The registry is the allowlist: an arbitrary file dropped into the frames
    directory is NOT servable until registered. Thumbnails are gated the same
    way — a thumbs/ file is served only when some frame's thumbnailUrl
    references it.
    """
    registry = _load_registry_raw()
    if registry is None:
        return False
    suffix_new = f"/api/hyrax/essence/frames/file/{filename}"
    suffix_old = f"essence/frames/{filename}"
    for entry in registry.get("frames", []):
        if not isinstance(entry, dict):
            continue
        assets = entry.get("assets")
        if not isinstance(assets, dict):
            continue
        for key in ("imageUrl", "thumbnailUrl"):
            url = assets.get(key)
            if isinstance(url, str) and (url.endswith(suffix_new) or url == suffix_old or url.endswith("/" + suffix_old)):
                return True
    return False


def _serve_frame_file(handler, filename: str) -> bool:
    """Stream a registered frame image with the same hardening as the VN
    asset allowlist (symlink rejection, dev/ino identity check, size cap).

    ``filename`` is a bare basename or a thumbs/<name> subpath — validated
    by _frame_file_path_ok before any path is built, and gated on registry
    membership by _frame_file_registered."""
    if not _frame_file_path_ok(filename):
        _j(handler, {"error": "not found"}, status=404)
        return True
    if not _frame_file_registered(filename):
        _j(handler, {"error": "not found"}, status=404)
        return True

    candidate = ESSENCE_FRAMES_DIR / filename
    try:
        base = ESSENCE_FRAMES_DIR.resolve(strict=True)
        if ESSENCE_FRAMES_DIR.is_symlink() or candidate.is_symlink():
            raise OSError("symlinked frame path")
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
        import stat as _stat

        if (
            not _stat.S_ISREG(opened.st_mode)
            or (opened.st_dev, opened.st_ino) != (expected.st_dev, expected.st_ino)
        ):
            stream.close()
            raise OSError("frame identity changed")
    except (OSError, RuntimeError, ValueError):
        _j(handler, {"error": "not found"}, status=404)
        return True

    if opened.st_size > MAX_FRAME_FILE_BYTES:
        stream.close()
        _j(handler, {"error": "not found"}, status=404)
        return True

    ext = "." + filename.rsplit(".", 1)[-1].lower()
    content_type = _FRAME_CONTENT_TYPES.get(ext, "application/octet-stream")
    handler.send_response(200)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(opened.st_size))
    handler.send_header("Content-Disposition", "inline")
    handler.send_header("Cache-Control", "private, max-age=3600")
    handler.send_header("X-Content-Type-Options", "nosniff")
    from api.helpers import _security_headers, flush_pending_auth_cookies

    _security_headers(handler)
    flush_pending_auth_cookies(handler)
    handler.end_headers()
    try:
        with stream:
            while True:
                chunk = stream.read(_FRAME_CHUNK)
                if not chunk:
                    break
                try:
                    handler.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    break
    except OSError:
        pass
    return True


# ── Dispatch entry points (called from api.hyrax_routes) ─────────────────────

_ESSENCE_PREFIX = "/api/hyrax/essence/"
_PRESENCE_PATH = "/api/hyrax/presence"
_FRAMES_PATH = "/api/hyrax/essence/frames"
_FRAME_FILE_PREFIX = "/api/hyrax/essence/frames/file/"
_REGISTER_PATH = "/api/hyrax/essence/frames/register"
_APPROVALS_PATH = "/api/hyrax/essence/approvals"
_APPROVALS_RESPOND_PATH = "/api/hyrax/essence/approvals/respond"

# ── D3 Josh approval-tier surface (essenced G8 approval requests) ────────────
#
# essenced's autonomy runtime files approval requests for approval-tier
# proposals (risk classes external_resource / config_write / code_edit /
# destructive — the G8 gate) into the append-only governance store
# <fleet>/governance/josh_approvals.jsonl. This surface is Josh's decision
# point: GET lists pending requests; POST respond appends his decision.
# The actor is ALWAYS stamped "josh:webui" — the only actor essenced's G8
# gate and the execution lease manager trust for approval-tier leases —
# and only authenticated WebUI sessions reach this handler (api.routes
# auth + CSRF run before dispatch). essenced polls the store on every
# autonomy tick and executes ONLY from a stored approve.
#
# The store module (governance/josh_approval.py) owns the event shape; it
# is loaded from the fleet governance dir so this surface never re-
# implements the append-only format. Fail closed: an unavailable store is
# a 503, never an exception or an empty-looking success.

JOSH_APPROVAL_ACTOR = "josh:webui"
"""The only decision actor essenced's G8 gate honors (hyrax-governor.yaml
proposal_governor.trusted_approval_actors). Stamped here, never taken
from the request body."""

MAX_APPROVALS_LISTED = 50
MAX_APPROVAL_DECISIONS_LISTED = 20
_APPROVAL_REQUEST_ID_RE = _re.compile(r"^japr-[0-9a-f]{12}$")
_JOSH_STORE_MODULE_CACHE: dict[str, object] = {}


def _fleet_governance_dir() -> Path:
    """The fleet-level governance dir (sibling of kanban.db).

    api/config's init_profile_state() rewrites HERMES_HOME to the active
    profile home (.../profiles/<name>) before import, so mirror
    api.hyrax_routes._fleet_kanban_db and climb back to the fleet root.
    """
    home = Path(os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes"))
    if home.parent.name == "profiles":
        home = home.parent.parent
    return home / "governance"


def _josh_store_module():
    """Load governance/josh_approval.py (the store's owner). Cached.

    Returns None on any failure (fail closed). Tests monkeypatch this
    function to inject a tmp-store instance — never the filesystem.
    """
    cached = _JOSH_STORE_MODULE_CACHE.get("module")
    if cached is not None:
        return cached
    import importlib.util

    path = _fleet_governance_dir() / "josh_approval.py"
    try:
        spec = importlib.util.spec_from_file_location(
            "hyrax_josh_approval_store", path)
        if spec is None or spec.loader is None:
            return None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    except (OSError, ValueError, ImportError):
        return None
    _JOSH_STORE_MODULE_CACHE["module"] = module
    return module


def _bounded_approval_str(value, max_len: int = 512) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip()[:max_len]


def _sanitize_approval_request(request: dict) -> dict:
    """Bounded, allowlisted view of one pending approval request."""
    return {
        "request_id": _bounded_approval_str(request.get("request_id"), 64),
        "proposal_id": _bounded_approval_str(request.get("proposal_id"), 64),
        "operator": _bounded_approval_str(request.get("operator"), 32),
        "proposal_type": _bounded_approval_str(
            request.get("proposal_type"), 64),
        "risk": _bounded_approval_str(request.get("risk"), 64),
        "summary": _bounded_approval_str(request.get("summary"), 280),
        "subject": _bounded_approval_str(request.get("subject"), 160),
        "created_at": _bounded_approval_str(request.get("created_at"), 64),
        "expires_at": _bounded_approval_str(request.get("expires_at"), 64),
    }


def _sanitize_approval_decision(event: dict) -> dict:
    return {
        "request_id": _bounded_approval_str(event.get("request_id"), 64),
        "decision": _bounded_approval_str(event.get("decision"), 16),
        "actor": _bounded_approval_str(event.get("actor"), 64),
        "decided_at": _bounded_approval_str(event.get("decided_at"), 64),
    }


def _serve_josh_approvals(handler, parsed) -> bool:
    """GET /api/hyrax/essence/approvals — pending Josh approval requests
    plus the most recent decisions (bounded, sanitized)."""
    module = _josh_store_module()
    if module is None:
        _j(handler, {"error": "approval store unavailable"}, status=503)
        return True
    try:
        pending = [
            _sanitize_approval_request(r)
            for r in (module.pending_requests() or [])
        ][:MAX_APPROVALS_LISTED]
        decisions = [
            _sanitize_approval_decision(d)
            for d in (module.decisions() or [])
        ][-MAX_APPROVAL_DECISIONS_LISTED:]
    except Exception:  # never leak store internals; fail closed
        _j(handler, {"error": "approval store unavailable"}, status=503)
        return True
    _j(handler, {
        "pending": pending,
        "pending_count": len(pending),
        "recent_decisions": decisions,
        "respond_to": _APPROVALS_RESPOND_PATH,
    })
    return True


def _handle_josh_approval_respond(handler, body) -> bool:
    """POST /api/hyrax/essence/approvals/respond — record Josh's decision.

    Body: {"request_id": "japr-xxxxxxxxxxxx", "decision": "approve"|"deny"}.
    The decision is appended to the store ONLY when the request is still
    pending (unknown/decided/expired ids fail closed with 404 — a replayed
    or crafted respond cannot rewrite a decision). The actor is stamped
    server-side as josh:webui; essenced's poller takes it from there.
    """
    if not isinstance(body, dict):
        _j(handler, {"error": "invalid body"}, status=400)
        return True
    request_id = body.get("request_id")
    decision = body.get("decision")
    if not isinstance(request_id, str) \
            or not _APPROVAL_REQUEST_ID_RE.match(request_id):
        _j(handler, {"error": "invalid request_id"}, status=400)
        return True
    if decision not in ("approve", "deny"):
        _j(handler, {"error": "decision must be 'approve' or 'deny'"},
           status=400)
        return True
    module = _josh_store_module()
    if module is None:
        _j(handler, {"error": "approval store unavailable"}, status=503)
        return True
    try:
        pending_ids = {
            str(r.get("request_id"))
            for r in (module.pending_requests() or [])
        }
        if request_id not in pending_ids:
            _j(handler, {"error": "not found"}, status=404)
            return True
        result = module.respond(request_id, decision,
                                actor=JOSH_APPROVAL_ACTOR)
    except Exception:
        _j(handler, {"error": "approval store unavailable"}, status=503)
        return True
    if not isinstance(result, dict) or result.get("ok") is not True:
        _j(handler, {"error": "decision refused"}, status=400)
        return True
    _j(handler, {
        "recorded": True,
        "request_id": request_id,
        "decision": decision,
        "actor": JOSH_APPROVAL_ACTOR,
        "decided_at": _bounded_approval_str(result.get("decided_at"), 64),
    })
    return True


# ── Whims dismiss surface (HQ whims panel — Josh's gentle veto) ─────────────
#
# essenced's whims layer draws object-wants into meta.whims active; the HQ
# whims panel is READ-ONLY plus ONE action: dismiss. The WebUI never writes
# essenced-owned state (derived_state.json is rewritten by the daemon every
# pass — a direct write would be clobbered or interleave). Instead this
# endpoint files a request in the append-only governance store
# (whim_dismissals.jsonl, same channel shape as the josh_approvals tier)
# and essenced's whims tick polls it one pass later: the whim closes with
# the "whim-dismissed" moodlet, journaled whim_dismissed — never counted
# as fulfilled, breaker-neutral.
#
# The actor is ALWAYS stamped "josh" server-side (the panel is Josh's
# veto); the body cannot set it. Fail closed: an unavailable store is a
# 503, a non-active whim is a 404 (idempotent — a repeat dismiss of an
# already-closed whim changes nothing and says why).

WHIM_DISMISS_ACTOR = "josh"
"""The only dismiss actor — Josh's gentle veto. Stamped here, never taken
from the request body."""

_WHIMS_DISMISS_PATH = "/api/hyrax/essence/whims/dismiss"
# whim_id shape: "<template-slug>-<epoch seconds>" (whims.py draw).
_WHIM_ID_RE = _re.compile(r"^[a-z0-9][a-z0-9-]{0,46}-\d{6,14}$")
_WHIM_DISMISS_STORE_MODULE_CACHE: dict[str, object] = {}


def _whim_dismiss_store_module():
    """Load governance/whim_dismissals.py (the store's owner). Cached.

    Returns None on any failure (fail closed). Tests monkeypatch this
    function to inject a tmp-store instance — never the filesystem.
    """
    cached = _WHIM_DISMISS_STORE_MODULE_CACHE.get("module")
    if cached is not None:
        return cached
    import importlib.util

    path = _fleet_governance_dir() / "whim_dismissals.py"
    try:
        spec = importlib.util.spec_from_file_location(
            "hyrax_whim_dismissals_store", path)
        if spec is None or spec.loader is None:
            return None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    except (OSError, ValueError, ImportError):
        return None
    _WHIM_DISMISS_STORE_MODULE_CACHE["module"] = module
    return module


def _whim_is_active(operator: str, whim_id: str) -> bool:
    """True only when whim_id is in the operator's meta.whims active list
    (read-only bounded read of derived_state.json). Fail closed: a
    missing/corrupt state file means NOT active — never file a veto we
    cannot verify against current state."""
    state = _read_json_bounded(
        _profile_home(operator) / "essence" / "derived_state.json",
        MAX_STATE_FILE_BYTES)
    if not isinstance(state, dict):
        return False
    active = (((state.get("meta") or {}).get("whims") or {}).get("active"))
    if not isinstance(active, list):
        return False
    return any(
        isinstance(w, dict) and w.get("whim_id") == whim_id for w in active)


def _handle_whim_dismiss(handler, body) -> bool:
    """POST /api/hyrax/essence/whims/dismiss — file Josh's whim veto.

    Body: {"operator": "<sister>", "whim_id": "<template>-<epoch>"}. The
    request is appended to the store ONLY when the whim is currently
    active (unknown/inactive ids fail closed with 404 — a replayed or
    crafted dismiss cannot re-close history). essenced's poll takes it
    from there; presence reflects the close on the next pass.
    """
    if not isinstance(body, dict):
        _j(handler, {"error": "invalid body"}, status=400)
        return True
    extra = set(body.keys()) - {"operator", "whim_id"}
    if extra:
        _j(handler, {"error": "invalid body"}, status=400)
        return True
    operator = body.get("operator")
    if operator not in _VN_PROFILES:
        _j(handler, {"error": "unknown operator"}, status=400)
        return True
    whim_id = body.get("whim_id")
    if (
        not isinstance(whim_id, str)
        or len(whim_id) > MAX_WHIM_ID_LENGTH
        or not _WHIM_ID_RE.match(whim_id)
    ):
        _j(handler, {"error": "invalid whim_id"}, status=400)
        return True
    module = _whim_dismiss_store_module()
    if module is None:
        _j(handler, {"error": "dismiss store unavailable"}, status=503)
        return True
    if not _whim_is_active(operator, whim_id):
        _j(handler, {
            "error": "whim not active",
            "detail": "unknown or already closed (fulfilled/expired/"
                      "dismissed) — nothing to dismiss",
        }, status=404)
        return True
    try:
        request = module.request(operator, whim_id,
                                 actor=WHIM_DISMISS_ACTOR)
    except Exception:
        _j(handler, {"error": "dismiss store unavailable"}, status=503)
        return True
    if not isinstance(request, dict) or not request.get("request_id"):
        _j(handler, {"error": "dismiss store unavailable"}, status=503)
        return True
    _j(handler, {
        "recorded": True,
        "request_id": str(request.get("request_id"))[:32],
        "operator": operator,
        "whim_id": whim_id,
        "actor": WHIM_DISMISS_ACTOR,
        # essenced's whims tick polls the store each pass (~15s) and
        # closes the whim; the panel refreshes from presence.
        "status": "pending",
    })
    return True


def handle_essence_get(handler, parsed) -> bool:
    """Dispatch GET /api/hyrax/presence and /api/hyrax/essence/* requests."""
    path = parsed.path

    if path == _PRESENCE_PATH:
        return _serve_presence(handler)

    if path == _APPROVALS_PATH:
        return _serve_josh_approvals(handler, parsed)

    if path == _FRAMES_PATH:
        return _serve_frames_registry(handler, parsed)

    if path.startswith(_FRAME_FILE_PREFIX):
        filename = path[len(_FRAME_FILE_PREFIX):]
        if _frame_file_path_ok(filename):
            return _serve_frame_file(handler, filename)
        _j(handler, {"error": "not found"}, status=404)
        return True

    if path.startswith(_ESSENCE_PREFIX):
        operator = path[len(_ESSENCE_PREFIX):]
        # Single path segment only; unknown operators fail closed with 404.
        if operator and "/" not in operator and operator in _VN_PROFILES:
            return _serve_operator_essence(handler, operator)
        _j(handler, {"error": "not found"}, status=404)
        return True

    _j(handler, {"error": "not found"}, status=404)
    return True


def handle_essence_post(handler, parsed, body) -> bool:
    """Dispatch POST /api/hyrax/essence/* requests (body pre-read by caller)."""
    if parsed.path == _REGISTER_PATH:
        return _handle_frame_register(handler, body)
    if parsed.path == _APPROVALS_RESPOND_PATH:
        return _handle_josh_approval_respond(handler, body)
    if parsed.path == _WHIMS_DISMISS_PATH:
        return _handle_whim_dismiss(handler, body)
    _j(handler, {"error": "not found"}, status=404)
    return True
