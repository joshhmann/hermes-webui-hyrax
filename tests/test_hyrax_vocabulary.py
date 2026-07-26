"""Lockstep tests for the Gestalt/Essence controlled vocabulary.

Contract: docs/gestalt-vn/VOCABULARY.md. These tests are the immune system
against the "crying default" class of bug — the same term meaning different
things in different layers. They FAIL on drift between:

  - server mirror maps (api/hyrax_essence.py) and client mirror maps
    (static/hyrax/essence/essenceFrames.js),
  - the curated family table (hyrax-assets/essence/expression-families.json)
    and the jolt classes (static/hyrax/vn/vnStage.js + static/hyrax/hyrax.css),
  - the frame registry (hyrax-assets/essence/frames.registry.json) and the
    pose/expression vocabulary,
  - presence activity emission (server) and the HQ client activity maps,
  - per-operator canonical expression enums and actual frame coverage
    (no canonical expression may blank).

Hermetic: reads only repo-owned files; no profile state, no network, no
import-time mutation. The client is JS, so client maps are extracted with
small regex parsers (same read-the-source pattern as tests/run_hyrax_*.js).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import api.hyrax_essence as essence
from api.hyrax_routes import VN_PROFILES

REPO = Path(__file__).resolve().parents[1]
ESSENCE_FRAMES_JS = REPO / "static" / "hyrax" / "essence" / "essenceFrames.js"
VN_STAGE_JS = REPO / "static" / "hyrax" / "vn" / "vnStage.js"
VN_SHELL_JS = REPO / "static" / "hyrax" / "vn" / "vnShell.js"
HQ_JS = REPO / "static" / "hyrax" / "hq.js"
HYRAX_CSS = REPO / "static" / "hyrax" / "hyrax.css"
FAMILY_TABLE_JSON = REPO / "hyrax-assets" / "essence" / "expression-families.json"
FRAME_REGISTRY_JSON = REPO / "hyrax-assets" / "essence" / "frames.registry.json"
VN_ROOMS_DIR = REPO / "static" / "hyrax" / "vn" / "rooms"

# ── The vocabulary (docs/gestalt-vn/VOCABULARY.md) ─────────────────────────

OPERATORS = {"tai", "rei", "nei", "mai"}

EXPRESSION_FAMILIES = {"neutral", "positive", "wry", "focused", "intense", "sad"}

# Registry state.pose vocabulary, per frame kind (VOCABULARY.md §5).
PORTRAIT_POSES = {"standing", "sitting", "thinking", "casual", "confident"}
CHIBI_POSES = {"stand"}

# Presence activity vocabulary (VOCABULARY.md §6).
ACTIVITY_TYPES = {
    "idle", "conversing", "tool-working", "waiting-approval",
    "background-working", "resting", "offline",
}


# ── Minimal JS source extraction (client is classic-script JS) ─────────────

def _js_object_body(src: str, name: str) -> str:
    m = re.search(r"var %s = \{(.*?)\};" % re.escape(name), src, re.S)
    assert m, f"{name} object not found in JS source"
    return m.group(1)


def _js_array_body(src: str, name: str) -> str:
    m = re.search(r"var %s = \[(.*?)\];" % re.escape(name), src, re.S)
    assert m, f"{name} array not found in JS source"
    return m.group(1)


def _js_string_map(src: str, name: str) -> dict:
    """Parse a JS object literal of 'key': 'value' string pairs (quoted keys)."""
    body = re.sub(r"//[^\n]*", "", _js_object_body(src, name))
    pairs = re.findall(r"'([^']+)':\s*'([^']+)'", body)
    # Every non-comment line with a key must have been parsed — guards
    # against silently dropping an entry with an unexpected value shape.
    keys = re.findall(r"'([^']+)':", body)
    assert len(keys) == len(pairs), f"{name}: unparsed entries in JS map"
    return dict(pairs)


def _js_keys(src: str, name: str) -> set:
    """Keys of a JS object literal (quoted keys, any value incl. null)."""
    body = re.sub(r"//[^\n]*", "", _js_object_body(src, name))
    return set(re.findall(r"'([^']+)':", body))


def _js_string_list(src: str, name: str) -> list:
    body = _js_array_body(src, name)
    return re.findall(r"'([^']+)'", body)


# ── Family table / registry loaders ──────────────────────────────────────────

def _family_table() -> dict:
    return json.loads(FAMILY_TABLE_JSON.read_text())


def _registry_frames() -> list:
    return json.loads(FRAME_REGISTRY_JSON.read_text())["frames"]


# ══════════════════════════════════════════════════════════════════════════
# Operators (VOCABULARY.md §1)
# ══════════════════════════════════════════════════════════════════════════

class TestOperators:
    def test_server_profiles_match_vocabulary(self):
        assert set(VN_PROFILES.keys()) == OPERATORS

    def test_hq_sisters_match_vocabulary(self):
        hq = HQ_JS.read_text()
        block = _js_array_body(hq, "HQ_SISTERS")
        ids = set(re.findall(r"id: '([^']+)'", block))
        assert ids == OPERATORS

    def test_vn_shell_operator_rooms_match_vocabulary(self):
        shell = VN_SHELL_JS.read_text()
        body = _js_object_body(shell, "OPERATOR_ROOM")
        rooms = dict(re.findall(r"(\w+): '([^']+)'", body))
        assert set(rooms.keys()) == OPERATORS

    def test_hq_and_vn_room_assignments_agree(self):
        """HQ_SISTERS.room (label) and OPERATOR_ROOM (id) resolve to the
        same room id for every operator."""
        hq = HQ_JS.read_text()
        rooms_block = _js_array_body(hq, "HQ_ROOMS")
        id_by_label = dict(
            (label, rid) for rid, label in re.findall(
                r"id: '([^']+)',\s+label: '([^']+)'", rooms_block)
        )
        sisters_block = _js_array_body(hq, "HQ_SISTERS")
        hq_room_by_op = {
            op: id_by_label[label]
            for op, label in re.findall(
                r"id: '([^']+)', name: '[^']+',\s+room: '([^']+)'", sisters_block)
        }
        shell = VN_SHELL_JS.read_text()
        vn_room_by_op = dict(
            re.findall(r"(\w+): '([^']+)'", _js_object_body(shell, "OPERATOR_ROOM"))
        )
        assert hq_room_by_op == vn_room_by_op

    def test_vn_room_manifests_cover_operators(self):
        manifests = {}
        for path in sorted(VN_ROOMS_DIR.glob("*.json")):
            data = json.loads(path.read_text())
            manifests[data["operatorId"]] = data["roomId"]
        assert set(manifests.keys()) == OPERATORS
        # Manifest roomIds are a subset of HQ room ids.
        hq = HQ_JS.read_text()
        hq_ids = set(re.findall(r"id: '([^']+)'", _js_array_body(hq, "HQ_ROOMS")))
        assert set(manifests.values()) <= hq_ids
        # And agree with vnShell OPERATOR_ROOM.
        shell = VN_SHELL_JS.read_text()
        vn_room_by_op = dict(
            re.findall(r"(\w+): '([^']+)'", _js_object_body(shell, "OPERATOR_ROOM"))
        )
        assert manifests == vn_room_by_op


# ══════════════════════════════════════════════════════════════════════════
# Expression families (VOCABULARY.md §2) — server/client mirror lockstep
# ══════════════════════════════════════════════════════════════════════════

class TestExpressionFamilyMirror:
    def test_family_table_declares_exactly_the_six_families(self):
        assert set(_family_table()["families"]) == EXPRESSION_FAMILIES

    def test_expression_family_map_server_client_identical(self):
        """_EXPRESSION_FAMILY (api/hyrax_essence.py) and EXPRESSION_FAMILY
        (essenceFrames.js) must be the same dict — a drifted entry is how
        'neutral' came to mean 'crying' in one layer."""
        client = _js_string_map(ESSENCE_FRAMES_JS.read_text(), "EXPRESSION_FAMILY")
        server = dict(essence._EXPRESSION_FAMILY)
        assert server == client

    def test_mirror_map_values_are_allowed_families(self):
        for name, family in essence._EXPRESSION_FAMILY.items():
            assert family in EXPRESSION_FAMILIES, (name, family)


# ══════════════════════════════════════════════════════════════════════════
# Emotions (VOCABULARY.md §3)
# ══════════════════════════════════════════════════════════════════════════

class TestEmotions:
    def test_every_emotion_has_exactly_one_allowed_family(self):
        table = _family_table()
        allowed = set(table["families"])
        assert allowed == EXPRESSION_FAMILIES
        bad = [
            (name, entry.get("family"))
            for name, entry in table["emotions"].items()
            if entry.get("family") not in allowed
        ]
        assert not bad, f"emotions with out-of-vocabulary family: {bad}"

    def test_jolt_classes_cover_exactly_the_families(self):
        """vnStage.js JOLT_CLASSES: one jolt class per family, no extras."""
        stage = VN_STAGE_JS.read_text()
        jolt_families = {
            cls.removeprefix("gestalt-vn-jolt-")
            for cls in _js_string_list(stage, "JOLT_CLASSES")
        }
        assert jolt_families == EXPRESSION_FAMILIES

    def test_css_jolt_classes_cover_exactly_the_families(self):
        """hyrax.css must define .gestalt-vn-jolt-<family> for each family —
        a family without a CSS class silently never reacts."""
        css = HYRAX_CSS.read_text()
        css_families = set(re.findall(r"\.gestalt-vn-jolt-([a-z]+)\s*\{", css))
        assert css_families == EXPRESSION_FAMILIES


# ══════════════════════════════════════════════════════════════════════════
# Poses (VOCABULARY.md §5)
# ══════════════════════════════════════════════════════════════════════════

class TestPoses:
    def test_pose_family_map_server_client_identical(self):
        client = _js_string_map(ESSENCE_FRAMES_JS.read_text(), "POSE_FAMILY")
        server = dict(essence._POSE_FAMILY)
        assert server == client

    def test_registry_pose_values_in_vocabulary(self):
        """Every non-null state.pose in frames.registry.json is in the
        per-kind pose vocabulary."""
        violations = {}
        for frame in _registry_frames():
            state = frame.get("state") or {}
            pose = state.get("pose")
            if not pose:
                continue
            kind = frame.get("kind")
            vocab = CHIBI_POSES if kind == "chibi" else PORTRAIT_POSES
            if pose not in vocab:
                violations[frame.get("id")] = pose
        assert not violations, (
            "registry pose values outside the vocabulary "
            "(docs/gestalt-vn/VOCABULARY.md §5): "
            f"{violations}"
        )

    def test_registry_poses_map_through_pose_family_consistently(self):
        """pose → poseFamily resolution must agree server vs client for every
        pose value present in the registry plus the map keys themselves."""
        client_map = _js_string_map(ESSENCE_FRAMES_JS.read_text(), "POSE_FAMILY")
        server_map = dict(essence._POSE_FAMILY)

        def server_family(pose):
            return server_map.get(pose.lower().strip(), "standing")

        def client_family(pose):
            return client_map.get(pose.lower().strip(), "standing")

        poses = set(server_map) | set(client_map)
        for frame in _registry_frames():
            pose = (frame.get("state") or {}).get("pose")
            if pose:
                poses.add(pose)
        for pose in poses:
            assert server_family(pose) == client_family(pose), pose


# ══════════════════════════════════════════════════════════════════════════
# Activity types (VOCABULARY.md §6)
# ══════════════════════════════════════════════════════════════════════════

class TestActivityTypes:
    def test_server_emitted_types_subset_of_vocabulary(self):
        """_ACTIVITY_INTERRUPTIBILITY keys are exactly the activity types the
        presence endpoint can emit (_presence_item indexes it with the chosen
        activity_type, so its key set IS the emitted set)."""
        emitted = set(essence._ACTIVITY_INTERRUPTIBILITY.keys())
        assert emitted <= ACTIVITY_TYPES

    def test_hq_activity_maps_cover_the_same_set(self):
        """ACTIVITY_TYPES, ACTIVITY_LABELS and ACTIVITY_ROOM in hq.js must
        cover the vocabulary exactly — a missing label renders as 'idle',
        a missing room strands placement."""
        hq = HQ_JS.read_text()
        types = set(_js_string_list(hq, "ACTIVITY_TYPES"))
        labels = _js_keys(hq, "ACTIVITY_LABELS")
        rooms = _js_keys(hq, "ACTIVITY_ROOM")
        assert types == ACTIVITY_TYPES
        assert labels == ACTIVITY_TYPES
        assert rooms == ACTIVITY_TYPES


# ══════════════════════════════════════════════════════════════════════════
# Canonical expression coverage (VOCABULARY.md §4) — never blank
# ══════════════════════════════════════════════════════════════════════════

def _generic_portrait_expressions() -> dict:
    """operator -> set of expression suffixes in GENERIC_PORTRAIT_IDS."""
    src = ESSENCE_FRAMES_JS.read_text()
    body = re.search(
        r"var GENERIC_PORTRAIT_IDS = \{(.*?)\n  \};", src, re.S
    ).group(1)
    result = {}
    for op, arr in re.findall(r"(\w+): \[(.*?)\]", body, re.S):
        ids = re.findall(r"'([^']+)'", arr)
        result[op] = {pid.split(".")[-1] for pid in ids}
    return result


def _approved_portrait_expressions() -> dict:
    """operator -> set of state.expression over approved portrait frames."""
    result = {op: set() for op in OPERATORS}
    for frame in _registry_frames():
        if (frame.get("quality") or {}).get("approved") is not True:
            continue
        if frame.get("kind") not in (None, "portrait"):
            continue
        expr = (frame.get("state") or {}).get("expression")
        op = frame.get("operatorId")
        if expr and op in result:
            result[op].add(expr)
    return result


class TestCanonicalExpressionCoverage:
    def test_expression_enum_covers_exactly_the_operators(self):
        assert set(essence.EXPRESSION_ENUM.keys()) == OPERATORS

    def test_neutral_is_canonical_for_every_operator(self):
        for op, enum in essence.EXPRESSION_ENUM.items():
            assert essence.NEUTRAL_EXPRESSION in enum, op

    def test_canonical_expressions_never_blank(self):
        """Every EXPRESSION_ENUM value must be renderable for its operator:
        an approved registry portrait frame with that exact expression, OR
        an approved portrait frame in the same expression family (mirroring
        the client tier-3 pool, which only admits map-known expressions), OR
        a generic portrait asset (client fallback ladder)."""
        approved = _approved_portrait_expressions()
        generic = _generic_portrait_expressions()
        family_map = dict(essence._EXPRESSION_FAMILY)
        blanks = []
        for op, enum in essence.EXPRESSION_ENUM.items():
            for expr in sorted(enum):
                if expr in approved[op]:
                    continue
                family = family_map.get(expr)
                if family is not None and any(
                    family_map.get(other) == family for other in approved[op]
                ):
                    continue
                if expr in generic.get(op, set()):
                    continue
                blanks.append((op, expr))
        assert not blanks, (
            "canonical expressions with no approved frame, no same-family "
            f"frame, and no generic portrait: {blanks}"
        )

    def test_operator_default_neutral_frame_exists(self):
        """Client tier 4 (operator default) requires an approved neutral
        portrait per operator — without it the ladder falls through to
        generic for every unmatched scene."""
        approved = _approved_portrait_expressions()
        missing = [op for op in OPERATORS if "neutral" not in approved[op]]
        assert not missing, f"operators without approved neutral frame: {missing}"
