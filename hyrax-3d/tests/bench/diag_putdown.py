#!/usr/bin/env python3
"""Diagnose the putdown stall: drive cup.pickup then cup.putdown headless,
log planner phase/goal/lastFailure + root XZ + holding each second."""
import sys, tempfile, time, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from playwright.sync_api import sync_playwright
import gevs
from gevs import MOUNT_JS, start_server, wait_for_health

port = 8895
base = f"http://127.0.0.1:{port}"
state_dir = tempfile.mkdtemp(prefix="hermes-gevs-diag-")
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
        }""")

        def probe():
            return page.evaluate("() => window.__ardy.pickupProbe ? window.__ardy.pickupProbe() : 'NO-PROBE'")

        def planner():
            return page.evaluate("() => (window.__ardy.getTelemetry() || {}).planner || {}")

        print("== recenter + idle ==")
        page.evaluate("(s) => window.__ardy.recenterRoot(s[0], s[1])", (0, 0.15))
        page.evaluate("(p) => window.__ardy.setPrompt(p)", "a person stands idle")
        page.wait_for_timeout(4000)

        def drive(goal, timeout=100, expect_holding=None):
            print(f"== setGoal {goal} ==")
            ret = page.evaluate("(g) => window.__ardy.setGoal(g)", goal)
            print("setGoal ret:", ret)
            deadline = time.time() + timeout
            last = ""
            while time.time() < deadline:
                pl = planner()
                p = probe()
                t = page.evaluate("() => (window.__ardy.getTelemetry() || {})")
                root = t.get("rootXZ") or t.get("root") or {}
                line = (f"phase={pl.get('phase')} goal={pl.get('goal')} "
                        f"failure={pl.get('lastFailure')} holding={(p or {}).get('holding') if isinstance(p, dict) else p} "
                        f"root={root} state={t.get('state')}")
                if line != last:
                    print(f"  t={time.time()-deadline+timeout:5.1f} {line}", flush=True)
                    last = line
                if pl.get("goal") is None and pl.get("phase") is None:
                    break
                page.wait_for_timeout(1000)
            return probe()

        p1 = drive("cup.pickup", 100)
        print("== after pickup ==\n", json.dumps(p1, indent=1))
        p2 = drive("cup.putdown", 120)
        print("== after putdown ==\n", json.dumps(p2, indent=1))
        print("== final planner tel ==\n", json.dumps(planner(), indent=1)[:2500])

finally:
    print("\n===== CONSOLE (pickup/planner lines) =====")
    for line in console_lines:
        if any(k in line for k in ("pickup", "planner", "goal", "cup", "loft")):
            print(line[:300])
    proc.terminate()
