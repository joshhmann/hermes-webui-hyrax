#!/usr/bin/env python3
"""
Essence active runtime Phase B verification harness (companion to
tests/browser_vn_poses.py — same isolated-server pattern).

Boots the real server.py on an ephemeral port with an isolated temp state
dir, seeds a fresh essenced-style derived_state.json for rei (schema v2:
presentation.expression=calm, poseIntent=sitting, sceneIntent=lab) plus VN
sessions whose latest assistant rows carry a keyword signal ("haha" →
laughing), and drives headless Chromium through the Phase B wiring:

  0. Presence endpoint carries the derived presentation intents in the
     compact derivedState block (server-side check).
  1. Opening rei's VN stages a SITTING pose variant from the derived
     poseIntent (through the HQ presence poll → essence state → intents →
     vnStage.applyIntent path — no new polling).
  2. The stage background swaps to the sceneIntent room's manifest
     background (lab → nei.background.lab; rei's own room is security).
  3. The conversation GET expression comes from the derived
     presentation.expression (calm), NOT the keyword stopgap (laughing).
  4. Keyword fallback intact: tai has NO derived_state.json, so her
     conversation GET expression is the keyword-derived "laughing".
  5. Screenshots into dogfood-output/vn-phaseb/ (pose-from-derived,
     scene-from-derived).
  6. Zero browser console errors / uncaught exceptions (same gate as
     browser_vn_poses).

USAGE
  python3 tests/browser_vn_phaseb.py

EXIT CODES
  0 — all items PASS, zero console errors
  1 — one or more items FAIL or console errors detected
  2 — environment/setup failure
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

PORT = int(os.getenv("VNPHASEB_PORT", "8802"))
BASE = f"http://127.0.0.1:{PORT}"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(REPO, "dogfood-output", "vn-phaseb")

# Same known-benign noise filter as tests/browser_vn_poses.py.
BENIGN = [
    "favicon",
    "manifest.json",
    "serviceworker",
    "sw.js",
    "the server responded with a status of 404",
    "the server responded with a status of 409",
    "the server responded with a status of 503",
]

# Same documented upstream core race as tests/browser_living_hq.py.
KNOWN_UPSTREAM = [
    "_autoScrollFollow is not defined",
]
UPSTREAM_HITS = []

RESULTS = []          # (item, ok, detail)
CONSOLE_ERRORS = []   # (tag, kind, text)


def record(item, ok, detail):
    RESULTS.append((item, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {item} — {detail}")


def _is_benign(text):
    t = text.lower()
    return any(p.lower() in t for p in BENIGN)


def _is_known_upstream(text):
    return any(p in text for p in KNOWN_UPSTREAM)


def attach_listeners(page, tag):
    def on_console(m):
        if m.type != "error" or _is_benign(m.text):
            return
        if _is_known_upstream(m.text):
            UPSTREAM_HITS.append((tag, "console", m.text))
            return
        CONSOLE_ERRORS.append((tag, "console", m.text))
        print(f"  CONSOLE [{tag}] error: {m.text}", file=sys.stderr)
    def on_pageerror(e):
        if _is_benign(str(e)):
            return
        if _is_known_upstream(str(e)):
            UPSTREAM_HITS.append((tag, "pageerror", str(e)))
            print(f"  KNOWN-UPSTREAM [{tag}] pageerror: {e}", file=sys.stderr)
            return
        CONSOLE_ERRORS.append((tag, "pageerror", str(e)))
        print(f"  CONSOLE [{tag}] pageerror: {e}", file=sys.stderr)
    page.on("console", on_console)
    page.on("pageerror", on_pageerror)


def http_json(method, path, body=None):
    req = urllib.request.Request(
        BASE + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode())


def wait_for_health(timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(BASE + "/health", timeout=2) as r:
                if r.status == 200:
                    return True
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(0.5)
    return False


def new_page(browser, tag, width=1440, height=900, **ctx_kwargs):
    ctx = browser.new_context(
        base_url=BASE, viewport={"width": width, "height": height}, **ctx_kwargs
    )
    page = ctx.new_page()
    attach_listeners(page, tag)
    return ctx, page


# ── VN navigation helpers (mirror tests/browser_vn_poses.py) ─────────────

def open_vn(page, sister):
    page.wait_for_selector(f".chibi-{sister}", timeout=15000)
    page.click(f".chibi-{sister}", timeout=10000)
    page.wait_for_selector(".gestalt-vn-stage", state="visible", timeout=15000)


def stage_snapshot(page):
    """Current stage state: frame id/pose/expression + background."""
    return page.evaluate("""() => {
        const st = GestaltVN.vn.stage.getState();
        const fr = st.currentFrame || null;
        const frState = fr && fr.state || {};
        return {
            frameId: fr ? fr.id : null,
            pose: frState.pose || null,
            expression: frState.expression || null,
            background: st.background,
        };
    }""")


def wait_stage(page, predicate_js, timeout_s=15):
    """Poll the stage snapshot until predicate_js(snapshot) is truthy."""
    deadline = time.time() + timeout_s
    snap = stage_snapshot(page)
    while time.time() < deadline:
        ok = page.evaluate(
            f"(snap) => !!({predicate_js})({json.dumps(snap)})")
        if ok:
            return snap
        time.sleep(0.25)
        snap = stage_snapshot(page)
    return snap


def wait_leaves_loading(page, timeout_s=12):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        st = page.evaluate("""() => {
            const ph = document.querySelector('.gestalt-vn-stage-placeholder');
            return { present: !!ph, hidden: ph ? !!ph.hidden : null };
        }""")
        if st["present"] and st["hidden"]:
            return True
        time.sleep(0.25)
    return False


# ── Seeding (pre-boot, isolated state dir only) ──────────────────────────

def seed_sessions(state_dir):
    """Seed VN sessions whose latest assistant rows carry a keyword signal
    ('haha' → laughing) via the repo's own api.models writer — mirrors
    tests/_vn_seed_sessions.py with Phase B message content."""
    program = """
import os, sys
state_dir = sys.argv[1]
os.environ["HERMES_HOME"] = state_dir
os.environ["HERMES_BASE_HOME"] = state_dir
os.environ["HERMES_WEBUI_STATE_DIR"] = state_dir
os.environ["HERMES_WEBUI_SKIP_ONBOARDING"] = "1"
os.environ["HERMES_WEBUI_AGENT_DIR"] = os.path.join(state_dir, "no-agent")
for k in list(os.environ):
    if k.endswith("_API_KEY"):
        os.environ.pop(k, None)
sys.path.insert(0, sys.argv[2])
os.makedirs(os.path.join(state_dir, "sessions"), exist_ok=True)
from api import models
rei = models.new_session(profile="rei", project_id="hyrax-vn")
rei.title = "Rei VN"
rei.messages = [
    {"id": "pb-rei-u-0", "role": "user", "content": "evening check"},
    {"id": "pb-rei-a-0", "role": "assistant",
     "content": "haha — all quiet on the perimeter."},
]
rei.save()
tai = models.new_session(profile="tai", project_id="hyrax-vn")
tai.title = "Tai VN"
tai.messages = [
    {"id": "pb-tai-u-0", "role": "user", "content": "status?"},
    {"id": "pb-tai-a-0", "role": "assistant",
     "content": "haha, good one!"},
]
tai.save()
print(f"seeded rei={rei.session_id} tai={tai.session_id}")
"""
    proc = subprocess.run(
        [sys.executable, "-c", program, state_dir, REPO],
        capture_output=True, text=True, timeout=60,
    )
    if proc.returncode != 0:
        print(f"SETUP FAIL: session seed failed: {proc.stderr[-800:]}",
              file=sys.stderr)
        return False
    print(f"  seed: {proc.stdout.strip()}")
    return True


def seed_derived_state(state_dir):
    """Write a fresh essenced-style derived_state.json (schema v2) for rei
    into her isolated profile home. Returns the file path."""
    def leaf(value):
        return {"value": value, "provenance": "derived",
                "updatedAt": "2026-07-26T00:00:00+00:00"}
    payload = {
        "version": 2,
        "operatorId": "rei",
        "mood": {"primary": leaf("calm"), "valence": leaf(0.2)},
        "condition": {"energy": leaf(0.6), "focus": leaf(0.7),
                      "stress": leaf(0.1)},
        "activity": {"type": leaf("resting")},
        "presentation": {
            "expression": leaf("calm"),
            "intensity": leaf(0.65),
            "poseIntent": leaf("sitting"),
            "sceneIntent": leaf("lab"),
        },
    }
    path = os.path.join(state_dir, "profiles", "rei", "essence",
                        "derived_state.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        json.dump(payload, fh, indent=2)
    return path


def main():
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("SKIP: playwright not installed", file=sys.stderr)
        return 2

    server_py = os.path.join(REPO, "server.py")
    if not os.path.exists(server_py):
        print(f"SETUP FAIL: server.py not found at {server_py}", file=sys.stderr)
        return 2

    os.makedirs(SHOTS, exist_ok=True)
    state_dir = tempfile.mkdtemp(prefix="hermes-vn-phaseb-")

    if not seed_sessions(state_dir):
        return 2
    derived_path = seed_derived_state(state_dir)

    env = os.environ.copy()
    for k in list(env):
        if k.endswith("_API_KEY"):
            env.pop(k, None)
    env.update({
        "HERMES_WEBUI_PORT": str(PORT),
        "HERMES_WEBUI_HOST": "127.0.0.1",
        "HERMES_WEBUI_STATE_DIR": state_dir,
        "HERMES_HOME": state_dir,
        "HERMES_BASE_HOME": state_dir,
        "HERMES_WEBUI_SKIP_ONBOARDING": "1",
        "HERMES_WEBUI_AGENT_DIR": os.path.join(state_dir, "no-agent"),
    })

    log = open(os.path.join(state_dir, "server.log"), "w")
    proc = subprocess.Popen(
        [sys.executable, server_py], cwd=REPO, env=env,
        stdout=log, stderr=subprocess.STDOUT,
    )
    try:
        if not wait_for_health(timeout=30):
            print("SETUP FAIL: server did not become healthy in 30s", file=sys.stderr)
            log.flush()
            with open(os.path.join(state_dir, "server.log")) as f:
                print(f.read()[-2000:], file=sys.stderr)
            return 2

        # Maximize the freshness window (<120s mtime) for the browser phase.
        os.utime(derived_path, None)

        # ── Item 0: presence carries the derived presentation intents ──
        presence = http_json("GET", "/api/hyrax/presence")
        items = {i.get("operatorId"): i for i in presence.get("items", [])}
        rei_ds = (items.get("rei") or {}).get("derivedState") or {}
        tai_ds = (items.get("tai") or {}).get("derivedState") or {}
        ok0 = (rei_ds.get("fresh") is True
               and rei_ds.get("poseIntent") == "sitting"
               and rei_ds.get("sceneIntent") == "lab"
               and tai_ds.get("fresh") is False
               and tai_ds.get("poseIntent") is None
               and tai_ds.get("sceneIntent") is None)
        record("0.presence derivedState carries pose/scene intents", ok0,
               f"rei={rei_ds} tai={tai_ds}")

        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"]
            )

            # ── Items 1–3: rei VN from derived presentation ────────────
            ctx, page = new_page(browser, "phaseb-rei")
            page.goto("/?panel=hq", wait_until="domcontentloaded")
            open_vn(page, "rei")
            loaded = wait_leaves_loading(page)
            record("0b.rei VN mount leaves loading state", loaded,
                   "placeholder hidden" if loaded else "placeholder stuck")

            # Item 1: pose variant from derived poseIntent=sitting.
            sat = wait_stage(
                page, "(s) => s.pose === 'sitting' && !!s.frameId")
            ok1 = sat["pose"] == "sitting" and bool(sat["frameId"])
            record("1.derived poseIntent stages a sitting pose variant", ok1,
                   f"frame={sat['frameId']} pose={sat['pose']} "
                   f"expr={sat['expression']}")
            page.wait_for_timeout(500)  # crossfade settle
            page.locator(".vn2-stage").screenshot(
                path=os.path.join(SHOTS, "pose-from-derived.png"))

            # Item 2: background from derived sceneIntent=lab (rei's own
            # room is security — the swap proves the scene intent path).
            scene = wait_stage(
                page, "(s) => (s.background || '').endsWith('nei.background.lab')")
            ok2 = (scene["background"] or "").endswith("nei.background.lab")
            record("2.derived sceneIntent swaps the stage background", ok2,
                   f"background={scene['background']}")
            page.screenshot(path=os.path.join(SHOTS, "scene-from-derived.png"))

            # Item 3: conversation GET expression comes from the derived
            # presentation.expression (calm), not the keyword (laughing).
            rei_sid = page.evaluate(
                "() => GestaltVN.session.current() "
                "&& GestaltVN.session.current().sessionId")
            conv = http_json("GET", f"/api/hyrax/vn/conversations/{rei_sid}")
            conv = conv.get("conversation") or conv
            expr = (conv.get("expression") or {}).get("current")
            ok3 = expr == "calm"
            record("3.conversation GET expression from derived (beats keyword)",
                   ok3, f"expression={expr!r} (keyword would be 'laughing')")
            ctx.close()

            # ── Item 4: keyword fallback without derived state ─────────
            ctx_t, page_t = new_page(browser, "phaseb-tai")
            page_t.goto("/?panel=hq", wait_until="domcontentloaded")
            open_vn(page_t, "tai")
            wait_leaves_loading(page_t)
            tai_sid = page_t.evaluate(
                "() => GestaltVN.session.current() "
                "&& GestaltVN.session.current().sessionId")
            conv_t = http_json("GET", f"/api/hyrax/vn/conversations/{tai_sid}")
            conv_t = conv_t.get("conversation") or conv_t
            expr_t = (conv_t.get("expression") or {}).get("current")
            ok4 = expr_t == "laughing"
            record("4.keyword fallback when derived state absent", ok4,
                   f"expression={expr_t!r} (keyword-derived)")
            ctx_t.close()

            browser.close()

        # ── Item 5: console-error gate ─────────────────────────────────
        if CONSOLE_ERRORS:
            for tag, kind, text in CONSOLE_ERRORS:
                print(f"  CONSOLE [{tag}] {kind}: {text}", file=sys.stderr)
            record("5.zero console errors", False,
                   f"{len(CONSOLE_ERRORS)} error(s) across scenarios")
        else:
            record("5.zero console errors", True,
                   "no console errors/pageerrors outside documented "
                   "benign/known-upstream classes")
        for tag, kind, text in UPSTREAM_HITS:
            print(f"  KNOWN-UPSTREAM [{tag}] {kind}: {text}", file=sys.stderr)

        failed = [r for r in RESULTS if not r[1]]
        print()
        for item, ok, detail in RESULTS:
            print(f"  {'PASS' if ok else 'FAIL'}  {item}")
        if failed:
            print(f"\nVN PHASE B VERIFICATION FAILED — {len(failed)} item(s)",
                  file=sys.stderr)
            return 1
        print("\nVN PHASE B VERIFICATION PASSED")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
