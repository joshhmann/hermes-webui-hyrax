#!/usr/bin/env python3
"""
Gestalt VN pose/scene wiring verification harness (companion to
tests/browser_vn_interactions.py — same isolated-server pattern).

Boots the real server.py on an ephemeral port with an isolated temp state
dir and drives headless Chromium through the pose/scene verification items:

  1. "Sit together" sidebar action swaps the stage frame to a sitting
     variant — the applied frame's registry state.pose is "sitting"
     (cross-checked against GET /api/hyrax/essence/frames server-side).
  2. Expression is preserved across the pose change (same expression FAMILY
     before/after — pose and expression are independent dimensions).
  3. "Stand up" swaps back to a standing variant; availability flips
     (Sit disabled-with-reason while sitting, Stand enabled, and vice
     versa).
  4. Fallback discipline: a pose with no registered frames (poseIntent
     'working') still applies a frame — never blank.
  5. Room scene: stage.setBackground swaps the background layer; the "Enter
     room" sidebar action restores the room manifest's registered
     background (fail-closed URL resolution).
  6. Reduced motion: a pose change produces no transition animation
     (transition: none) and no jolt class.
  7. Screenshots into dogfood-output/vn-poses/ (standing→sitting, room
     background change, mobile 390px).
  8. Zero browser console errors / uncaught exceptions across all of the
     above (same gate as browser_living_hq).

USAGE
  python3 tests/browser_vn_poses.py

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

PORT = int(os.getenv("VNPOSE_PORT", "8801"))
BASE = f"http://127.0.0.1:{PORT}"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(REPO, "dogfood-output", "vn-poses")

# Same known-benign noise filter as tests/browser_living_hq.py.
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


# ── VN navigation helpers ────────────────────────────────────────────────

def open_vn(page, sister):
    page.wait_for_selector(f".chibi-{sister}", timeout=15000)
    page.click(f".chibi-{sister}", timeout=10000)
    page.wait_for_selector(".gestalt-vn-stage", state="visible", timeout=15000)


def stage_snapshot(page):
    """Current stage state: frame id/pose/expression-family + background."""
    return page.evaluate("""() => {
        const st = GestaltVN.vn.stage.getState();
        const fr = st.currentFrame || null;
        const frState = fr && fr.state || {};
        const fam = frState.expression && GestaltVN.essence.frames
            ? GestaltVN.essence.frames.expressionFamily(frState.expression) : null;
        return {
            frameId: fr ? fr.id : null,
            frameSource: fr ? fr.source : null,
            pose: frState.pose || null,
            expression: frState.expression || null,
            family: fam,
            imageUrl: fr && fr.assets ? fr.assets.imageUrl : null,
            background: st.background,
        };
    }""")


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


def wait_pose_change(page, old_frame_id, want_pose, timeout_s=12):
    deadline = time.time() + timeout_s
    snap = stage_snapshot(page)
    while time.time() < deadline:
        if snap["frameId"] and snap["frameId"] != old_frame_id \
                and snap["pose"] == want_pose:
            return snap
        time.sleep(0.25)
        snap = stage_snapshot(page)
    return snap


def registry_pose_map(operator):
    payload = http_json("GET", f"/api/hyrax/essence/frames?operator={operator}")
    out = {}
    for f in payload.get("frames", []):
        out[f.get("id")] = (f.get("state") or {}).get("pose")
    return out


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
    state_dir = tempfile.mkdtemp(prefix="hermes-vn-poses-")

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

        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"]
            )

            # ── Items 1–5: pose + room wiring (rei) ────────────────────
            ctx, page = new_page(browser, "poses")
            page.goto("/?panel=hq", wait_until="domcontentloaded")
            open_vn(page, "rei")
            loaded = wait_leaves_loading(page)
            record("0.vn mount leaves loading state", loaded,
                   "placeholder hidden" if loaded else "placeholder stuck")

            poses = registry_pose_map("rei")
            before = stage_snapshot(page)
            page.locator(".vn2-stage").screenshot(
                path=os.path.join(SHOTS, "pose-standing.png"))

            # Item 1: Sit together → sitting variant.
            page.wait_for_selector('[data-action-id="op.sit-together"]',
                                   state="visible", timeout=10000)
            page.click('[data-action-id="op.sit-together"]', timeout=10000)
            sat = wait_pose_change(page, before["frameId"], "sitting")
            registry_pose = poses.get(sat["frameId"])
            ok1 = (sat["pose"] == "sitting"
                   and sat["frameId"] != before["frameId"]
                   and (registry_pose == "sitting"
                        or sat["frameSource"] in ("fallback", None)))
            record("1.Sit together swaps stage to sitting variant", ok1,
                   f"frame {before['frameId']} → {sat['frameId']} "
                   f"(stage pose={sat['pose']}, registry pose={registry_pose})")
            page.wait_for_timeout(500)  # crossfade settle
            # The sprite must actually PAINT: exactly one buffer visible,
            # pointing at the applied frame, image data loaded. (Regression
            # guard: stale xfade classes once left both buffers at
            # opacity 0 on the second crossfade.)
            vis = page.evaluate("""() => {
                const cur = GestaltVN.vn.stage.getState().currentFrame;
                const imgs = [...document.querySelectorAll('.gestalt-vn-stage-frame')];
                return imgs.map(i => ({
                    frameId: i.getAttribute('data-frame-id'),
                    opacity: getComputedStyle(i).opacity,
                    loaded: i.complete && i.naturalWidth > 0,
                    current: cur && i.getAttribute('data-frame-id') === cur.id,
                }));
            }""")
            visible = [i for i in vis if i["opacity"] == "1"]
            ok1b = (len(visible) == 1 and visible[0]["current"]
                    and visible[0]["loaded"])
            record("1b.sitting sprite paints (one visible buffer, loaded)",
                   ok1b, f"buffers={vis}")
            page.locator(".vn2-stage").screenshot(
                path=os.path.join(SHOTS, "pose-sitting.png"))

            # Item 2: expression preserved across the pose change.
            ok2 = bool(before["family"] and sat["family"]
                       and before["family"] == sat["family"])
            record("2.expression family preserved across pose change", ok2,
                   f"family {before['family']} → {sat['family']} "
                   f"(expr {before['expression']} → {sat['expression']})")

            # Item 3a: availability flips while sitting.
            avail = page.evaluate("""() => {
                const ctx = { operatorId: 'rei' };
                return {
                    sit: GestaltVN.vn.actions.evaluate('op.sit-together', ctx),
                    stand: GestaltVN.vn.actions.evaluate('op.stand-up', ctx),
                };
            }""")
            ok3a = (avail["sit"]["enabled"] is False
                    and "Already sitting" in (avail["sit"].get("reasonDisabled") or "")
                    and avail["stand"]["enabled"] is True)
            record("3.availability flips while sitting (disabled-with-reason)",
                   ok3a, f"avail={avail}")

            # Item 3a-dom: the SIDEBAR DOM reflects the flip without a manual
            # re-render (regression: the action list rendered once and kept
            # "Sit together" enabled while sitting — the stage commit now
            # notifies the sidebar to re-evaluate).
            dom_flip = page.evaluate("""() => {
                const sit = document.querySelector(
                    '[data-action-id="op.sit-together"]');
                const stand = document.querySelector(
                    '[data-action-id="op.stand-up"]');
                return {
                    sitInDom: !!sit,
                    sitDisabled: sit ? !!sit.disabled : null,
                    sitReason: sit ? (sit.getAttribute('title') || '') : null,
                    standInDom: !!stand,
                    standDisabled: stand ? !!stand.disabled : null,
                };
            }""")
            ok3dom = bool(dom_flip["sitInDom"]
                          and dom_flip["sitDisabled"] is True
                          and "Already sitting" in dom_flip["sitReason"]
                          and (not dom_flip["standInDom"]
                               or dom_flip["standDisabled"] is False))
            record("3a-dom.sidebar buttons reflect pose flip", ok3dom,
                   f"dom_flip={dom_flip}")

            # Item 3b: Stand up → standing variant, family still preserved.
            # stand-up sits in the operator section overflow.
            more = page.locator('.gestalt-vn-sidebar-section[data-section="operator"]'
                                ' .gestalt-vn-sidebar-more')
            if more.count() and not page.locator(
                    '[data-action-id="op.stand-up"]').is_visible():
                more.first.click()
            page.wait_for_selector('[data-action-id="op.stand-up"]',
                                   state="visible", timeout=10000)
            page.click('[data-action-id="op.stand-up"]', timeout=10000)
            stood = wait_pose_change(page, sat["frameId"], "standing")
            ok3 = (stood["pose"] == "standing"
                   and stood["frameId"] != sat["frameId"]
                   and stood["family"] == sat["family"])
            record("3.Stand up swaps back, expression still preserved", ok3,
                   f"frame {sat['frameId']} → {stood['frameId']} "
                   f"(pose={stood['pose']}, family {sat['family']} → "
                   f"{stood['family']})")

            # Item 4: pose with no registered frames → fallback, never blank.
            fb = page.evaluate("""async () => {
                const res = await GestaltVN.vn.stage.applyIntent({
                    operatorId: 'rei', expressionIntent: 'neutral',
                    poseIntent: 'working', trigger: 'test-no-pose-frames' });
                const st = GestaltVN.vn.stage.getState();
                return { applied: res.applied, match: res.frame ? null : null,
                         reason: res.reason,
                         frameId: st.currentFrame && st.currentFrame.id,
                         imageUrl: st.currentFrame && st.currentFrame.assets
                             && st.currentFrame.assets.imageUrl };
            }""")
            ok4 = bool(fb["applied"] and fb["frameId"] and fb["imageUrl"])
            record("4.absent pose variant falls back within ladder (never blank)",
                   ok4, f"applied={fb['applied']} frame={fb['frameId']} "
                   f"reason={fb['reason']!r}")

            # Item 5: room background swap + Enter room restores the room's
            # registered background.
            page.wait_for_selector('[data-action-id="room.enter"]',
                                   state="visible", timeout=10000)
            bg_before = stage_snapshot(page)["background"]
            swapped = page.evaluate("""() => {
                const ok = GestaltVN.vn.stage.setBackground(
                    '/api/hyrax/assets/nei.background.lab');
                return { ok: ok, bg: GestaltVN.vn.stage.getState().background };
            }""")
            page.wait_for_timeout(400)
            page.locator(".vn2-stage").screenshot(
                path=os.path.join(SHOTS, "room-background-changed.png"))
            page.click('[data-action-id="room.enter"]', timeout=10000)
            page.wait_for_timeout(600)
            bg_after = stage_snapshot(page)["background"]
            ok5 = (swapped["ok"] is True
                   and swapped["bg"].endswith("nei.background.lab")
                   and bg_after.endswith("rei.background.security"))
            record("5.room action swaps background per room manifest", ok5,
                   f"bg {bg_before} → {swapped['bg']} → (Enter room) → {bg_after}")
            page.wait_for_timeout(300)
            page.locator(".vn2-stage").screenshot(
                path=os.path.join(SHOTS, "room-enter-restored.png"))
            ctx.close()

            # ── Item 6: reduced motion — no transition, no jolt ────────
            ctx_r, page_r = new_page(browser, "reduced-motion",
                                     reduced_motion="reduce")
            page_r.goto("/?panel=hq", wait_until="domcontentloaded")
            open_vn(page_r, "rei")
            wait_leaves_loading(page_r)
            rm = page_r.evaluate("""async () => {
                const before = GestaltVN.vn.stage.getState().currentFrame;
                await GestaltVN.vn.actions.run('op.sit-together',
                    { operatorId: 'rei' });
                await new Promise(r => setTimeout(r, 800));
                const img = document.querySelector('.gestalt-vn-stage-frame');
                const wrap = document.querySelector('.gestalt-vn-stage-frame-wrap');
                const cs = getComputedStyle(img);
                const st = GestaltVN.vn.stage.getState();
                return {
                    pose: st.currentFrame && st.currentFrame.state
                        && st.currentFrame.state.pose,
                    frameChanged: !!(st.currentFrame && before
                        && st.currentFrame.id !== before.id),
                    transition: cs.transitionProperty + '/' + cs.transitionDuration,
                    wrapClasses: wrap.className,
                };
            }""")
            # transition-property: none (Chromium reports a nominal 1e-05s
            # duration for it) or an explicit 0s duration both mean no
            # transition animation.
            no_transition = (rm["transition"].startswith("none")
                             or rm["transition"].endswith("/0s"))
            ok6 = (rm["frameChanged"] and rm["pose"] == "sitting"
                   and no_transition
                   and "gestalt-vn-jolt" not in rm["wrapClasses"])
            record("6.reduced motion: pose swap with no transition/jolt", ok6,
                   f"pose={rm['pose']} changed={rm['frameChanged']} "
                   f"transition={rm['transition']} wrap={rm['wrapClasses']!r}")
            ctx_r.close()

            # ── Item 7: mobile 390px — sit via sidebar, screenshot ─────
            ctx_m, page_m = new_page(browser, "mobile", width=390, height=844,
                                     is_mobile=True, has_touch=True)
            page_m.goto("/?panel=hq", wait_until="domcontentloaded")
            open_vn(page_m, "tai")
            wait_leaves_loading(page_m)
            # Mobile collapses the actions sidebar behind a toggle.
            toggle = page_m.locator(".vn2-actions-toggle")
            if toggle.count():
                toggle.first.click()
            page_m.wait_for_selector('[data-action-id="op.sit-together"]',
                                     state="visible", timeout=10000)
            mob_before_id = page_m.evaluate(
                "() => GestaltVN.vn.stage.getState().currentFrame "
                "&& GestaltVN.vn.stage.getState().currentFrame.id")
            page_m.click('[data-action-id="op.sit-together"]', timeout=10000)
            mob = wait_pose_change(page_m, mob_before_id, "sitting")
            record("7.mobile 390px: Sit together works", mob["pose"] == "sitting",
                   f"pose={mob['pose']} frame={mob['frameId']}")
            page_m.wait_for_timeout(500)
            page_m.screenshot(path=os.path.join(SHOTS, "vn-mobile-390.png"))
            page_m.locator(".vn2-stage").screenshot(
                path=os.path.join(SHOTS, "vn-mobile-stage-sitting.png"))
            ctx_m.close()

            browser.close()

        # ── Item 8: console-error gate ─────────────────────────────────
        if CONSOLE_ERRORS:
            for tag, kind, text in CONSOLE_ERRORS:
                print(f"  CONSOLE [{tag}] {kind}: {text}", file=sys.stderr)
            record("8.zero console errors", False,
                   f"{len(CONSOLE_ERRORS)} error(s) across scenarios")
        else:
            record("8.zero console errors", True,
                   "no console errors/pageerrors outside documented "
                   "benign/known-upstream classes")
        for tag, kind, text in UPSTREAM_HITS:
            print(f"  KNOWN-UPSTREAM [{tag}] {kind}: {text}", file=sys.stderr)

        failed = [r for r in RESULTS if not r[1]]
        print()
        for item, ok, detail in RESULTS:
            print(f"  {'PASS' if ok else 'FAIL'}  {item}")
        if failed:
            print(f"\nVN POSE/SCENE VERIFICATION FAILED — {len(failed)} item(s)",
                  file=sys.stderr)
            return 1
        print("\nVN POSE/SCENE VERIFICATION PASSED")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
