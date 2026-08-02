"""Shared test helpers for static source assertions and hermetic boot probes."""


def source_between(src: str, start_marker: str, end_marker: str) -> str:
    start = src.find(start_marker)
    assert start >= 0, f"{start_marker} not found"
    end = src.find(end_marker, start)
    assert end > start, f"{end_marker} not found after {start_marker}"
    return src[start:end]


# ── Hermetic registry-driven allowlist boot helpers ─────────────────────────
# The VN allowlist (api.hyrax_routes.VN_PROFILES, consumed by
# api.hyrax_essence) is bound at import time from governance/operators.yaml
# via the shared operators_loader. Testing the registry contract means
# booting a FRESH interpreter against a hermetic governance dir (the loader
# module copied in, registry + journal isolated under tmp) so module-level
# state in the pytest process is never disturbed.

import json as _json
import os as _os
import shutil as _shutil
import subprocess as _subprocess
import sys as _sys
from pathlib import Path as _Path

# Mirror the loader's own resolution rule (operators_loader._governance_dir):
# ESSENCED_GOVERNANCE_DIR, else the fleet default. The copy source must be
# the same loader the production readers import.
_GOVERNANCE_DEFAULT = _Path(_os.environ.get("ESSENCED_GOVERNANCE_DIR")
                            or "/root/.hermes/governance")

_OPERATOR_ENTRY_TEMPLATE = """\
  {oid}:
    name: {name}
    role: Builder
    available: true
    assets:
      portrait: /api/hyrax/assets/{oid}.portrait.neutral
      background: /api/hyrax/assets/{oid}.background.control-room
      chibi: /api/hyrax/assets/{oid}.chibi.stand
"""


def operators_registry_yaml(oids: list[str]) -> str:
    """A minimal schema-valid operators.yaml body for the given operator ids."""
    entries = "".join(
        _OPERATOR_ENTRY_TEMPLATE.format(oid=oid, name=oid.title())
        for oid in oids)
    return (
        "schema_version: 1\n"
        "allowed_fields:\n"
        "  operator: [name, role, available, assets]\n"
        "  assets: [portrait, background, chibi, model]\n"
        "operators:\n" + entries)


def make_governance_dir(tmp_path) -> _Path:
    """Hermetic governance dir: operators_loader.py copied in, registry and
    journal land under tmp_path. Returns the governance dir."""
    gov = tmp_path / "governance"
    gov.mkdir(parents=True)
    source_loader = _GOVERNANCE_DEFAULT / "operators_loader.py"
    if not source_loader.exists():
        raise AssertionError(
            f"fleet operators_loader.py not found at {source_loader}")
    _shutil.copy2(source_loader, gov / "operators_loader.py")
    return gov


def boot_python(gov: _Path, script: str, *, timeout: int = 60):
    """Run a python snippet in a fresh interpreter against a hermetic
    governance dir. Returns (returncode, stdout, stderr)."""
    repo = _Path(__file__).resolve().parent.parent
    env = dict(_os.environ)
    env.update({
        "ESSENCED_GOVERNANCE_DIR": str(gov),
        "HERMES_HOME": str(gov / "home"),
        "HERMES_BASE_HOME": str(gov / "home"),
        "HERMES_WEBUI_STATE_DIR": str(gov / "home" / "webui"),
        "HERMES_WEBUI_DEFAULT_WORKSPACE": str(gov / "home" / "workspace"),
        "HERMES_CONFIG_PATH": str(gov / "home" / "config.yaml"),
        "PYTHONPATH": str(repo),
    })
    env.pop("OPERATORS_YAML", None)  # the registry file must resolve to gov
    proc = _subprocess.run(
        [_sys.executable, "-c", script], capture_output=True, text=True,
        cwd=repo, env=env, timeout=timeout)
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def read_operators_journal(gov: _Path) -> list[dict]:
    """Append-only loader journal lines (JSONL) as dicts; [] if absent."""
    path = gov / "operators_load_journal.jsonl"
    if not path.exists():
        return []
    return [_json.loads(line) for line in path.read_text().splitlines()
            if line.strip()]

