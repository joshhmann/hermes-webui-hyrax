#!/usr/bin/env python3
"""Repro: run the pickup flow headless with console capture — find why the
attach never happens. Reuses gevs.py helpers (same server/mount path)."""
import sys, tempfile, time, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from playwright.sync_api import sync_playwright
import gevs
from gevs import MOUNT_JS, start_server, wait_for_health

port = 8893
base = f"http://127.0.0.1:{port}"
state_dir = tempfile.mkdtemp(prefix="hermes-gevs-repro-")
proc = start_server(port, state_dir)
console_lines = []
try:
    if not wait_for_health(base):
        print("SETUP FAIL"); sys.exit(2)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"])
        ctx = browser.new_context(viewport={"width": 960, "height": 600})
        page = ctx.new_page()
        page.on("console", lambda m: console_lines.append(f"{m.type}: {m.text}"))
        page.on("pageerror", lambda e: console_lines.append(f"pageerror: {e}"))
        page.goto(base + "/?panel=hq", wait_until="domcontentloaded")
        page.wait_for_timeout(2000)
        if page.evaluate(MOUNT_JS, "/api/hyrax/assets/tai.embodiment.vrm") != "mounted":
            print("SETUP FAIL: mount"); sys.exit(2)
        live = False
        for _ in range(90):
            if page.evaluate("() => window.__ardy ? window.__ardy.getState() : 'no-handle'") == "live":
                live = True; break
            page.wait_for_timeout(1000)
        if not live:
            print("SETUP FAIL: never live"); sys.exit(2)
        page.evaluate("""() => {
          for (const b of document.querySelectorAll('button'))
            if (b.textContent === 'Follow') b.click();
          const sel = document.querySelector('select[aria-label="Room lighting"]');
          if (sel) { sel.value = 'noon'; sel.dispatchEvent(new Event('change')); }
        }""")

        def probe():
            return page.evaluate("() => window.__ardy.pickupProbe ? window.__ardy.pickupProbe() : 'NO-PROBE'")

        def planner():
            return page.evaluate("() => (window.__ardy.getTelemetry() || {}).planner || {}")

        print("== recenter + idle ==")
        page.evaluate("(s) => window.__ardy.recenterRoot(s[0], s[1])", (0, 0.15))
        page.evaluate("(p) => window.__ardy.setPrompt(p)", "a person stands idle")
        page.wait_for_timeout(4000)

        print("== setGoal cup.pickup ==")
        ret = page.evaluate("(g) => window.__ardy.setGoal(g)", "cup.pickup")
        print("setGoal ret:", ret)
        deadline = time.time() + 100
        last = ""
        while time.time() < deadline:
            pl = planner()
            phase = pl.get("phase"); goal = pl.get("goal"); pf = pl.get("lastFailure")
            p = probe()
            line = f"phase={phase} goal={goal} failure={pf} holding={p.get('holding') if isinstance(p, dict) else p} attached={p.get('attached') if isinstance(p, dict) else None}"
            if line != last:
                print(f"  t={time.time()-deadline+100:5.1f} {line}", flush=True)
                last = line
            if goal is None and phase is None:
                break
            page.wait_for_timeout(1000)
        print("== final probe ==")
        print(json.dumps(probe(), indent=1))
        print("== final planner tel ==")
        print(json.dumps(planner(), indent=1)[:2000])

finally:
    print("\n===== CONSOLE =====")
    for line in console_lines:
        print(line)
    proc.terminate()
