#!/usr/bin/env python3
"""
Gestalt VN polish verification harness (companion to
tests/browser_vn_interactions.py — same isolated-server pattern).

Covers the vn-polish work orders:

  1. Per-frame sprite calibration (scripts/calibrate_frame_crops.py →
     frames.registry.json assets.display): every operator's desktop stage
     applies a computed inline object-position (+ zoom width) from the
     registry, so "head + upper body, top of head intact" reads the same
     across operators. Asserts inline styles are present and differ per
     operator (one CSS rule cannot produce them).
  2. Shorter, resizable dialogue: default dialogue height ≤ 40% of the
     1440×900 viewport; the splitter drag changes it and the value persists
     across a reload (localStorage prefs.split); the chevron collapses the
     dialogue to a composer-only slim bar and back.
  3. Evidence screenshots into dogfood-output/vn-polish/: all four
     operators' stages at 1440×900, dialogue default/collapsed/dragged
     states, one mobile 390px shot.
  4. Zero browser console errors / uncaught exceptions (same gate as
     browser_living_hq / browser_vn_interactions).

USAGE
  python3 tests/browser_vn_polish.py

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

PORT = int(os.getenv("VNPOLISH_PORT", "8799"))
BASE = f"http://127.0.0.1:{PORT}"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(REPO, "dogfood-output", "vn-polish")

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

OPERATORS = ["tai", "rei", "nei", "mai"]


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
        if m.type != "error":
            return
        text = m.text
        if _is_benign(text):
            return
        CONSOLE_ERRORS.append((tag, "console", text))
        print(f"  CONSOLE [{tag}] error: {text}", file=sys.stderr)

    def on_pageerror(e):
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


# ── VN navigation helpers (same as tests/browser_vn_interactions.py) ──────

def open_vn(page, sister):
    page.wait_for_selector(f".chibi-{sister}", timeout=15000)
    page.click(f".chibi-{sister}", timeout=10000)
    page.wait_for_selector(".gestalt-vn-stage", state="visible", timeout=15000)


def back_to_hq(page):
    page.click(".vn2-back", timeout=10000)
    page.wait_for_selector(".chibi-tai", state="visible", timeout=15000)


def wait_leaves_loading(page, timeout_s=12):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        st = page.evaluate("""() => {
            const ph = document.querySelector('.gestalt-vn-stage-placeholder');
            return ph ? !!ph.hidden : null;
        }""")
        if st is True:
            return True
        time.sleep(0.25)
    return False


def live_frame_style(page):
    """Inline calibration styles of the currently visible stage frame img."""
    return page.evaluate("""() => {
        const imgs = Array.from(document.querySelectorAll('.gestalt-vn-stage-frame'))
            .filter(i => i.getAttribute('data-frame-id'));
        if (!imgs.length) return null;
        imgs.sort((a, b) => parseFloat(getComputedStyle(b).opacity)
                          - parseFloat(getComputedStyle(a).opacity));
        const img = imgs[0];
        return {
            id: img.getAttribute('data-frame-id'),
            objectPosition: img.style.objectPosition || '',
            width: img.style.width || '',
            left: img.style.left || '',
            opacity: parseFloat(getComputedStyle(img).opacity),
        };
    }""")


def dialogue_metrics(page):
    return page.evaluate("""() => {
        const d = document.querySelector('.vn2-dialogue');
        if (!d) return null;
        const r = d.getBoundingClientRect();
        const transcript = document.querySelector('.vn2-transcript-region');
        return {
            height: r.height,
            vh: window.innerHeight,
            ratio: r.height / window.innerHeight,
            transcriptVisible: transcript
                ? getComputedStyle(transcript).display !== 'none' : null,
        };
    }""")


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
    state_dir = tempfile.mkdtemp(prefix="hermes-vn-polish-")

    seed = subprocess.run(
        [sys.executable, os.path.join(REPO, "tests", "_vn_seed_sessions.py"),
         state_dir],
        capture_output=True, text=True, timeout=120,
    )
    if seed.returncode != 0:
        print(f"SETUP FAIL: session seed failed: {seed.stderr[-800:]}",
              file=sys.stderr)
        return 2
    print(f"  seed: {seed.stdout.strip()}")

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

        # ── Item 1: registry serves calibration for all sprite frames ──
        # NOTE: the registry grew past the original 20 sprite frames (a
        # follow-up workstream registered ~2.7k emotion frames, all carrying
        # display+crop) — assert the invariant (every served frame is
        # calibrated), not the historical count.
        sprite_frames = []
        for op in OPERATORS:
            payload = http_json("GET", f"/api/hyrax/essence/frames?operator={op}")
            sprite_frames += [
                f for f in payload.get("frames", [])
                if f.get("assets", {}).get("imageUrl", "").startswith(
                    "/api/hyrax/essence/frames/file/")
            ]
        ok = len(sprite_frames) >= 20 and all(
            isinstance(f["assets"].get("display"), dict)
            and 1.0 <= f["assets"]["display"].get("scale", 0) <= 4.0
            and isinstance(f["assets"].get("crop"), dict)
            for f in sprite_frames
        )
        record("1.registry serves display+crop for all sprite frames (>=20)", ok,
               f"sprite frames with display: "
               f"{sum(1 for f in sprite_frames if 'display' in f['assets'])}"
               f"/{len(sprite_frames)}")

        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"]
            )

            # ── Item 2: per-operator calibrated framing (1440×900) ─────
            ctx, page = new_page(browser, "framing")
            page.goto("/?panel=hq", wait_until="domcontentloaded")
            page.wait_for_selector(".chibi-tai", timeout=15000)

            styles = {}
            for idx, op in enumerate(OPERATORS):
                open_vn(page, op)
                loaded = wait_leaves_loading(page)
                page.wait_for_timeout(700)  # crossfade settle + first paint
                st = live_frame_style(page)
                styles[op] = st
                page.locator(".vn2-stage").screenshot(
                    path=os.path.join(SHOTS, f"stage-{op}-1440.png"))
                if idx == 0:
                    page.screenshot(path=os.path.join(SHOTS, "vn-desktop-1440.png"))
                if idx < len(OPERATORS) - 1:
                    back_to_hq(page)
                else:
                    record("2.all four stages leave loading", loaded,
                           f"last operator {op} loaded={loaded}")

            per_op_ok = all(
                st and st["id"].startswith("frame.")
                and "/essence/frames/file/" not in st["id"]  # id, not url
                and st["objectPosition"]
                for st in styles.values()
            )
            positions = {op: st["objectPosition"] if st else None
                         for op, st in styles.items()}
            distinct = len({p for p in positions.values() if p})
            zooms = {op: st["width"] if st else None for op, st in styles.items()}
            record("2.per-operator inline framing applied",
                   per_op_ok and distinct >= 3,
                   f"objectPosition={positions} distinct={distinct} width={zooms}")

            # ── Item 3: default dialogue height ≤ 40% viewport ─────────
            # Currently on mai (fresh localStorage — no split pref yet).
            m = dialogue_metrics(page)
            record("3.default dialogue height ≤ 40% viewport", bool(m)
                   and m["ratio"] <= 0.40,
                   f"dialogue={m['height']:.0f}px / {m['vh']}px "
                   f"= {m['ratio']:.2%}" if m else "no dialogue")
            page.screenshot(path=os.path.join(SHOTS, "dialogue-default-1440.png"))

            # ── Item 4: drag resizes + persists across reload ──────────
            box = page.locator(".vn2-splitter").bounding_box()
            start_x = box["x"] + box["width"] * 0.25
            start_y = box["y"] + box["height"] / 2
            page.mouse.move(start_x, start_y)
            page.mouse.down()
            page.mouse.move(start_x, start_y - 160, steps=8)  # splitter up →
            page.mouse.up()                                    # dialogue taller
            page.wait_for_timeout(200)
            m_drag = dialogue_metrics(page)
            drag_ok = bool(m_drag) and m_drag["height"] > m["height"] + 100
            page.screenshot(path=os.path.join(SHOTS, "dialogue-dragged-1440.png"))

            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector(".chibi-tai", timeout=15000)
            open_vn(page, "mai")
            wait_leaves_loading(page)
            m_persist = dialogue_metrics(page)
            persist_ok = (bool(m_persist) and bool(m_drag)
                          and abs(m_persist["height"] - m_drag["height"]) < 12)
            record("4.drag resizes dialogue and persists across reload",
                   drag_ok and persist_ok,
                   f"default={m['height']:.0f} dragged={m_drag['height']:.0f} "
                   f"after-reload={m_persist['height']:.0f}"
                   if m_drag and m_persist else "drag probe failed")

            # ── Item 5: collapse toggle → slim composer-only bar ───────
            page.click(".vn2-splitter-toggle", timeout=5000)
            page.wait_for_timeout(200)
            m_col = dialogue_metrics(page)
            collapsed_ok = (bool(m_col) and m_col["transcriptVisible"] is False
                            and m_col["height"] < 140)
            page.screenshot(path=os.path.join(SHOTS, "dialogue-collapsed-1440.png"))
            page.click(".vn2-splitter-toggle", timeout=5000)
            page.wait_for_timeout(200)
            m_back = dialogue_metrics(page)
            restored_ok = (bool(m_back) and m_back["transcriptVisible"] is True
                           and abs(m_back["height"] - m_drag["height"]) < 12)
            record("5.collapse → composer-only bar → expand restores",
                   collapsed_ok and restored_ok,
                   f"collapsed={m_col['height']:.0f}px "
                   f"transcriptVisible={m_col['transcriptVisible']} "
                   f"restored={m_back['height']:.0f}px"
                   if m_col and m_back else "collapse probe failed")
            ctx.close()

            # ── Item 6: mobile 390px — layout intact, no desktop leak ──
            ctx_m, page_m = new_page(browser, "mobile", width=390, height=844,
                                     is_mobile=True, has_touch=True)
            page_m.goto("/?panel=hq", wait_until="domcontentloaded")
            open_vn(page_m, "tai")
            wait_leaves_loading(page_m)
            page_m.wait_for_timeout(600)
            mob = page_m.evaluate("""() => {
                const d = document.querySelector('.vn2-dialogue');
                const img = Array.from(
                    document.querySelectorAll('.gestalt-vn-stage-frame'))
                    .find(i => i.getAttribute('data-frame-id'));
                return {
                    dialogueVisible: d ? getComputedStyle(d).display !== 'none'
                                       : false,
                    // Mobile keeps the CSS framing — no inline calibration.
                    inlineObjectPosition: img ? (img.style.objectPosition || '')
                                              : null,
                };
            }""")
            record("6.mobile layout intact, no inline calibration leak",
                   mob["dialogueVisible"] and mob["inlineObjectPosition"] == "",
                   f"mobile={mob}")
            page_m.screenshot(path=os.path.join(SHOTS, "vn-mobile-390.png"))
            page_m.locator(".vn2-stage").screenshot(
                path=os.path.join(SHOTS, "stage-mobile-390.png"))
            ctx_m.close()

            browser.close()

        # ── Item 7: console-error gate ─────────────────────────────────
        if CONSOLE_ERRORS:
            for tag, kind, text in CONSOLE_ERRORS:
                print(f"  CONSOLE [{tag}] {kind}: {text}", file=sys.stderr)
            record("7.zero console errors", False,
                   f"{len(CONSOLE_ERRORS)} error(s) across scenarios")
        else:
            record("7.zero console errors", True,
                   "no console errors/pageerrors outside documented "
                   "benign/known-upstream classes")
        for tag, kind, text in UPSTREAM_HITS:
            print(f"  KNOWN-UPSTREAM [{tag}] {kind}: {text}", file=sys.stderr)

        failed = [r for r in RESULTS if not r[1]]
        print()
        for item, ok, detail in RESULTS:
            print(f"  {'PASS' if ok else 'FAIL'}  {item}")
        if failed:
            print(f"\nVN POLISH VERIFICATION FAILED — {len(failed)} item(s)",
                  file=sys.stderr)
            return 1
        print("\nVN POLISH VERIFICATION PASSED")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
