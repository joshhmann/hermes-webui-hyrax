#!/usr/bin/env python3
"""
Gestalt VN interaction verification harness (companion to
tests/browser_living_hq.py — same isolated-server pattern).

Boots the real server.py on an ephemeral port with an isolated temp state
dir, seeds two VN sessions with transcript history via
tests/_vn_seed_sessions.py (repo's own api.models writer, pre-boot), and
drives headless Chromium through the vn-fixes verification items:

  1. Loading-loop regression: HQ → VN tai → HQ → VN rei → HQ → VN tai →
     HQ → VN rei — EVERY mount must leave the "loading scene…" placeholder.
     The 3rd/4th mounts are cross-operator re-entries: the essenceFrames
     per-operator signature cache still matches while the fresh stage DOM
     sits on the placeholder (static provider no-op must re-show the frame
     instead of trusting the cache). Deterministic in the isolated server:
     neutral-default essence → rei hits the registry's static tier (calm
     frame), tai falls to the generic-portrait rung.
  2. Initial scroll: opening a VN with long history starts scrolled to the
     BOTTOM (latest message), not the top.
  3. Sprite framing evidence: desktop 1440×900 + mobile 390×844 screenshots
     into dogfood-output/vn-fixes/ (head + upper body visible on desktop;
     top of head not cropped).
  4. Emotion jolt: applyIntent with an expression change adds the matching
     gestalt-vn-jolt-<family> class (and keyframe animation) on the stage
     frame wrap; with prefers-reduced-motion emulated the class is absent.
  5. Zero browser console errors / uncaught exceptions across all of the
     above (same gate as browser_living_hq).

USAGE
  python3 tests/browser_vn_interactions.py

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

PORT = int(os.getenv("VNIX_PORT", "8798"))
BASE = f"http://127.0.0.1:{PORT}"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(REPO, "dogfood-output", "vn-fixes")
SHOTS2 = os.path.join(REPO, "dogfood-output", "vn-fixes2")

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
    """HQ → click the sister's chibi → VN stage mounted."""
    page.wait_for_selector(f".chibi-{sister}", timeout=15000)
    page.click(f".chibi-{sister}", timeout=10000)
    page.wait_for_selector(".gestalt-vn-stage", state="visible", timeout=15000)


def back_to_hq(page):
    page.click(".vn2-back", timeout=10000)
    page.wait_for_selector(".chibi-tai", state="visible", timeout=15000)


def placeholder_state(page):
    return page.evaluate("""() => {
        const ph = document.querySelector('.gestalt-vn-stage-placeholder');
        const frame = document.querySelector('.gestalt-vn-stage-frame');
        return {
            present: !!ph,
            hidden: ph ? !!ph.hidden : null,
            frameSrc: frame ? (frame.getAttribute('src') || '') : '',
            stage: (window.GestaltVN && GestaltVN.vn && GestaltVN.vn.stage)
                   ? GestaltVN.vn.stage.getState() : null,
        };
    }""")


def wait_leaves_loading(page, timeout_s=12):
    """Poll (interval-based, not rAF — headless timer freeze) until the
    stage placeholder is hidden. Returns the final placeholder_state."""
    deadline = time.time() + timeout_s
    st = placeholder_state(page)
    while time.time() < deadline:
        if st["present"] and st["hidden"]:
            return st
        time.sleep(0.25)
        st = placeholder_state(page)
    return st


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
    state_dir = tempfile.mkdtemp(prefix="hermes-vn-fixes-")

    # Seed VN sessions with history (tai: 60 rows — scrollable; rei: 2).
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

        # Seeded history sanity (real endpoint, pre-browser).
        conv = http_json("POST", "/api/hyrax/vn/conversations",
                         {"profile_id": "tai", "fresh": False})["conversation"]
        record("0.seeded transcript served",
               conv.get("message_count") == 60
               and conv["messages"][-1]["id"] == "seed-a-29",
               f"count={conv.get('message_count')} "
               f"last={conv['messages'][-1].get('id') if conv.get('messages') else None}")

        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"]
            )

            # ── Items 1 + 2: multi-open loading loop + initial scroll ──
            ctx, page = new_page(browser, "multi-open")
            page.goto("/?panel=hq", wait_until="domcontentloaded")
            page.wait_for_selector(".chibi-tai", timeout=15000)

            sequence = ["tai", "rei", "tai", "rei"]
            for idx, sister in enumerate(sequence, start=1):
                open_vn(page, sister)
                st = wait_leaves_loading(page)
                ok = bool(st["present"] and st["hidden"])
                detail = (f"mount {idx} ({sister}): placeholder hidden={st['hidden']} "
                          f"frame={st['frameSrc'].rsplit('/', 1)[-1]}")
                if not ok and st["stage"]:
                    detail += f" stage={st['stage']}"
                record(f"1.mount {idx} ({sister}) leaves loading state", ok, detail)

                if idx == 1:
                    # Item 2: long-history VN opens scrolled to the bottom.
                    page.wait_for_timeout(600)  # deferred scroll passes
                    scroll = page.evaluate("""() => {
                        const s = document.querySelector('.vn2-scroller');
                        if (!s) return null;
                        return { top: s.scrollTop, height: s.scrollHeight,
                                 client: s.clientHeight,
                                 gap: s.scrollHeight - s.scrollTop - s.clientHeight };
                    }""")
                    ok2 = bool(scroll) and scroll["height"] > scroll["client"] \
                        and scroll["gap"] <= 4
                    record("2.dialogue opens scrolled to bottom", ok2,
                           f"scroll={scroll}")
                    # Item 3 desktop evidence (first tai mount, sprite shown).
                    page.screenshot(path=os.path.join(SHOTS, "vn-desktop-1440.png"))
                    page.locator(".vn2-stage").screenshot(
                        path=os.path.join(SHOTS, "vn-desktop-stage.png"))

                if idx < len(sequence):
                    back_to_hq(page)

            # ── Item 4: emotion jolt (no-preference) ──────────────────
            # Currently on the 4th mount (rei). Expression family changes:
            # neutral → positive (smile) → intense (scream-of-fury is not in
            # rei's enum but applyIntent takes the intent as given).
            jolt = page.evaluate("""async () => {
                const stage = GestaltVN.vn.stage;
                const wrap = () => document.querySelector('.gestalt-vn-stage-frame-wrap');
                const out = {};
                await stage.applyIntent({ operatorId: 'rei', location: 'security',
                    expressionIntent: 'calm', trigger: 'test-baseline' });
                out.baselineClasses = wrap().className;
                await stage.applyIntent({ operatorId: 'rei', location: 'security',
                    expressionIntent: 'smile', trigger: 'test-positive' });
                out.positiveClasses = wrap().className;
                out.positiveAnim = getComputedStyle(wrap()).animationName;
                await stage.applyIntent({ operatorId: 'rei', location: 'security',
                    expressionIntent: 'scream-of-fury', trigger: 'test-intense' });
                out.intenseClasses = wrap().className;
                out.intenseAnim = getComputedStyle(wrap()).animationName;
                return out;
            }""")
            pos_ok = ("gestalt-vn-jolt-positive" in jolt["positiveClasses"]
                      and jolt["positiveAnim"] == "gestalt-vn-jolt-bounce")
            int_ok = ("gestalt-vn-jolt-intense" in jolt["intenseClasses"]
                      and jolt["intenseAnim"] == "gestalt-vn-jolt-shake")
            base_ok = "gestalt-vn-jolt" not in jolt["baselineClasses"]
            record("4.jolt class + animation on expression change",
                   pos_ok and int_ok and base_ok,
                   f"baseline={jolt['baselineClasses']!r} "
                   f"positive=({jolt['positiveClasses']!r},{jolt['positiveAnim']}) "
                   f"intense=({jolt['intenseClasses']!r},{jolt['intenseAnim']})")

            # ── Item 6: markdown renders in the VN dialogue ───────────
            # Rei's seeded history ends with an assistant row carrying a
            # fenced code block, bold, and a list — the transcript must
            # render them as HTML, not raw text.
            md = page.evaluate("""() => {
                const rows = [...document.querySelectorAll(
                    '.vn2-history .msg-row[data-role="assistant"]')];
                const row = rows.find(r =>
                    (r.textContent || '').includes('all green'));
                if (!row) return { found: false };
                return {
                    found: true,
                    hasPre: !!row.querySelector('pre code'),
                    hasStrong: !!row.querySelector('strong'),
                    hasList: !!row.querySelector('ul li'),
                    rawFence: (row.textContent || '').includes('```'),
                    rawStars: (row.textContent || '').includes('**all green**'),
                };
            }""")
            ok6 = bool(md.get("found") and md.get("hasPre")
                       and md.get("hasStrong") and md.get("hasList")
                       and not md.get("rawFence") and not md.get("rawStars"))
            record("6.dialogue renders markdown (code block, bold, list)",
                   ok6, f"md={md}")
            os.makedirs(SHOTS2, exist_ok=True)
            md_row = page.locator(
                '.vn2-history .msg-row[data-role="assistant"]',
                has_text="all green")
            if md_row.count():
                md_row.first.screenshot(
                    path=os.path.join(SHOTS2, "dialogue-markdown.png"))
            else:
                page.locator(".vn2-dialogue").screenshot(
                    path=os.path.join(SHOTS2, "dialogue-markdown.png"))

            # ── Item 7: tech drawer renders content on open ───────────
            page.click(".vn2-tech-toggle", timeout=10000)
            page.wait_for_timeout(500)
            drawer = page.evaluate("""() => {
                const btn = document.querySelector('.vn2-tech-toggle');
                const d = document.querySelector('.vn2-drawer-region');
                if (!d) return { present: false };
                const err = d.querySelector('.vn2-drawer-error');
                return {
                    present: true,
                    ariaExpanded: btn && btn.getAttribute('aria-expanded'),
                    open: d.classList.contains('vn2-drawer--open'),
                    children: d.children.length,
                    hasSessionRow: !!d.querySelector('.vn2-drawer-row'),
                    hasTools: !!d.querySelector('.vn2-drawer-tools'),
                    toolsEmptyState: (() => {
                        const t = d.querySelector('.vn2-drawer-tools');
                        return t ? (t.textContent || '') : null;
                    })(),
                    explicitError: err ? (err.textContent || '') : null,
                };
            }""")
            # Pass: content rows, or the explicit failure state — never a
            # silently empty panel.
            ok7 = bool(drawer.get("present")
                       and drawer.get("ariaExpanded") == "true"
                       and drawer.get("open")
                       and drawer.get("children", 0) > 0
                       and (drawer.get("hasSessionRow")
                            or drawer.get("explicitError")))
            record("7.tech drawer renders content (or explicit error state)",
                   ok7, f"drawer={drawer}")
            os.makedirs(SHOTS2, exist_ok=True)
            page.screenshot(path=os.path.join(SHOTS2, "tech-panel-open.png"))
            page.locator(".vn2-drawer-region").screenshot(
                path=os.path.join(SHOTS2, "tech-panel-drawer.png"))
            # Close via the drawer close affordance (the open drawer
            # overlays the topbar toggle).
            page.click(".vn2-drawer-close", timeout=10000)
            page.wait_for_timeout(400)

            # ── Item 8: sidebar pose availability flips in the DOM ────
            # After Sit together applies, the SIDEBAR (not just evaluate())
            # must re-evaluate: sit disabled with reason, stand enabled.
            page.wait_for_selector('[data-action-id="op.sit-together"]',
                                   state="visible", timeout=10000)
            stand_visible_before = page.locator(
                '[data-action-id="op.stand-up"]').count()
            more = page.locator(
                '.gestalt-vn-sidebar-section[data-section="operator"]'
                ' .gestalt-vn-sidebar-more')
            if more.count() and not page.locator(
                    '[data-action-id="op.stand-up"]').is_visible():
                more.first.click()
            page.click('[data-action-id="op.sit-together"]', timeout=10000)
            flip = None
            deadline = time.time() + 12
            while time.time() < deadline:
                flip = page.evaluate("""() => {
                    const sit = document.querySelector(
                        '[data-action-id="op.sit-together"]');
                    const stand = document.querySelector(
                        '[data-action-id="op.stand-up"]');
                    const pose = (() => {
                        const st = GestaltVN.vn.stage.getState();
                        return st.currentFrame && st.currentFrame.state
                            && st.currentFrame.state.pose;
                    })();
                    return {
                        pose: pose,
                        sitDisabled: sit ? !!sit.disabled : null,
                        sitReason: sit ? (sit.getAttribute('title') || '') : null,
                        standDisabled: stand ? !!stand.disabled : null,
                    };
                }""")
                if (flip.get("pose") == "sitting"
                        and flip.get("sitDisabled") is True
                        and flip.get("standDisabled") is False):
                    break
                time.sleep(0.25)
            ok8 = bool(flip and flip.get("pose") == "sitting"
                       and flip.get("sitDisabled") is True
                       and "Already sitting" in (flip.get("sitReason") or "")
                       and flip.get("standDisabled") is False)
            record("8.sidebar flips sit→stand after pose applies", ok8,
                   f"flip={flip} standInDomBefore={stand_visible_before}")
            # Reverse: Stand up → sit re-enabled, stand disabled.
            page.click('[data-action-id="op.stand-up"]', timeout=10000)
            flip_back = None
            deadline = time.time() + 12
            while time.time() < deadline:
                flip_back = page.evaluate("""() => {
                    const sit = document.querySelector(
                        '[data-action-id="op.sit-together"]');
                    const stand = document.querySelector(
                        '[data-action-id="op.stand-up"]');
                    const st = GestaltVN.vn.stage.getState();
                    return {
                        pose: st.currentFrame && st.currentFrame.state
                            && st.currentFrame.state.pose,
                        sitDisabled: sit ? !!sit.disabled : null,
                        standDisabled: stand ? !!stand.disabled : null,
                        standReason: stand
                            ? (stand.getAttribute('title') || '') : null,
                    };
                }""")
                if (flip_back.get("pose") == "standing"
                        and flip_back.get("sitDisabled") is False
                        and flip_back.get("standDisabled") is True):
                    break
                time.sleep(0.25)
            ok8b = bool(flip_back and flip_back.get("pose") == "standing"
                        and flip_back.get("sitDisabled") is False
                        and flip_back.get("standDisabled") is True
                        and "Already standing" in
                            (flip_back.get("standReason") or ""))
            record("8b.sidebar flips stand→sit after pose applies", ok8b,
                   f"flip_back={flip_back}")
            ctx.close()

            # ── Item 4 (reduce): no jolt class under reduced motion ───
            ctx_r, page_r = new_page(browser, "reduced-motion",
                                     reduced_motion="reduce")
            page_r.goto("/?panel=hq", wait_until="domcontentloaded")
            open_vn(page_r, "rei")
            wait_leaves_loading(page_r)
            jolt_r = page_r.evaluate("""async () => {
                const stage = GestaltVN.vn.stage;
                await stage.applyIntent({ operatorId: 'rei', location: 'security',
                    expressionIntent: 'smile', trigger: 'test-positive' });
                const wrap = document.querySelector('.gestalt-vn-stage-frame-wrap');
                return { classes: wrap.className,
                         anim: getComputedStyle(wrap).animationName };
            }""")
            record("4.no jolt class under reduced motion",
                   "gestalt-vn-jolt" not in jolt_r["classes"]
                   and jolt_r["anim"] in ("none", ""),
                   f"classes={jolt_r['classes']!r} anim={jolt_r['anim']!r}")
            ctx_r.close()

            # ── Item 3: mobile framing evidence ───────────────────────
            ctx_m, page_m = new_page(browser, "mobile", width=390, height=844,
                                     is_mobile=True, has_touch=True)
            page_m.goto("/?panel=hq", wait_until="domcontentloaded")
            open_vn(page_m, "tai")
            wait_leaves_loading(page_m)
            page_m.wait_for_timeout(600)
            page_m.screenshot(path=os.path.join(SHOTS, "vn-mobile-390.png"))
            page_m.locator(".vn2-stage").screenshot(
                path=os.path.join(SHOTS, "vn-mobile-stage.png"))
            ctx_m.close()

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
            print(f"\nVN INTERACTION VERIFICATION FAILED — {len(failed)} item(s)",
                  file=sys.stderr)
            return 1
        print("\nVN INTERACTION VERIFICATION PASSED")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
