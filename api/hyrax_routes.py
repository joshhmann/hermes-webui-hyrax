"""
Hyraxknot Division — Hermes WebUI Route Extensions

Registers additional API endpoints for the Hyraxknot control plane
without modifying core Hermes route dispatch.

All endpoints under /api/v1/ are handled here.
"""

import json
import time
import sqlite3
from pathlib import Path

# ── DB paths ──
KANBAN_DB = Path("/root/.hermes/kanban.db")

def _query(db_path: Path, sql: str, params: tuple = ()) -> list[dict]:
    """Execute a read-only SQL query and return rows as dicts."""
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=1)
        conn.row_factory = sqlite3.Row
        rows = [dict(row) for row in conn.execute(sql, params).fetchall()]
        conn.close()
        return rows
    except Exception as exc:
        return []

def handle_get(handler, parsed) -> bool:
    """Handle GET /api/v1/* routes. Returns True if handled, False to pass through."""
    path = parsed.path
    
    # GET /api/v1/projects — project aggregation
    if path == "/api/v1/projects":
        rows = _query(
            KANBAN_DB,
            "SELECT project_id AS name, COUNT(*) AS total, "
            "SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done_count, "
            "SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running_count, "
            "SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END) AS blocked_count, "
            "MAX(created_at) AS last_updated "
            "FROM tasks WHERE project_id IS NOT NULL AND project_id != '' "
            "GROUP BY project_id ORDER BY last_updated DESC"
        )
        handler.send_json({"items": rows, "meta": {"total": len(rows)}})
        return True
    
    # GET /api/v1/snapshot — full control plane snapshot
    if path == "/api/v1/snapshot":
        tasks = _query(KANBAN_DB, "SELECT * FROM tasks ORDER BY created_at DESC LIMIT 300")
        comments = _query(KANBAN_DB, "SELECT * FROM task_comments ORDER BY id DESC LIMIT 300")
        links = _query(KANBAN_DB, "SELECT * FROM task_links LIMIT 500")
        projects = handle_get.__globals__.get('_projects_data', lambda: {"items": []})()
        handler.send_json({
            "war_room": {"tasks": tasks, "comments": comments, "links": links, "authority": "Hermes Kanban"},
            "projects": projects,
            "observed_at": time.time(),
        })
        return True
    
    return False

def handle_post(handler, parsed) -> bool:
    """Handle POST /api/v1/* routes."""
    path = parsed.path
    # Future: POST /api/v1/tasks, POST /api/v1/proposals, etc.
    return False


# ── Monkey-patch: register routes by patching handle_get/handle_post ──
# This runs at import time. It wraps the core handle functions so our
# routes are tried first, then fall through to Hermes' core routes.

def _patch():
    """Patch core route handlers to try hyrax routes first."""
    from api import routes as core_routes
    
    orig_get = core_routes.handle_get
    def patched_get(handler, parsed):
        if handle_get(handler, parsed):
            return True
        return orig_get(handler, parsed)
    core_routes.handle_get = patched_get
    
    orig_post = core_routes.handle_post
    def patched_post(handler, parsed):
        if handle_post(handler, parsed):
            return True
        return orig_post(handler, parsed)
    core_routes.handle_post = patched_post

# Apply patch on import
_patch()
