#!/usr/bin/env python3
"""Repro 2: pickup → carry (couch.sit) → watch the planner through the
carry phase. Why doesn't couch.sit complete within 120 s?"""
import sys, tempfile, time, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from playwright.sync_api import sync_playwright
from gevs import MOUNT_JS, start_server, wait_for_health

port = 8894
base = f"http://127.0.0.1:{port}"
state_dir = tempfile.mkdtemp(prefix="hermes-gevs-repro2-")
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

        print("== cup.pickup ==")
        page.evaluate("(g) => window.__ardy.setGoal(g)", "cup.pickup")
        deadline = time.time() + 100
        while time.time() < deadline:
            pl = planner()
            if pl.get("goal") is None and pl.get("phase") is None:
                break
            page.wait_for_timeout(500)
        p = probe()
        print("after pickup: holding =", p.get("holding"), "attached =", p.get("attached"))

        print("== couch.sit (carry) ==")
        ret = page.evaluate("(g) => window.__ardy.setGoal(g)", "couch.sit")
        print("setGoal ret:", ret)
        deadline = time.time() + 150
        last = ""
        while time.time() < deadline:
            pl = planner()
            line = f"phase={pl.get('phase')} goal={pl.get('goal')} failure={pl.get('lastFailure')} replans={pl.get('replans')}"
            if line != last:
                print(f"  t={time.time()-deadline+150:5.1f} {line}", flush=True)
                last = line
            if pl.get("goal") is None and pl.get("phase") is None:
                break
            page.wait_for_timeout(1000)
        p = probe()
        print("after carry: holding =", p.get("holding"))
        print("probe:", json.dumps({k: p.get(k) for k in ('holding', 'attached', 'bone', 'followErrorM', 'cupWorld')}))

finally:
    print("\n===== CONSOLE (pickup/couch/planner lines) =====")
    for line in console_lines:
        if 'planner' in line or 'pickup' in line or 'reflex' in line:
            print(line)
    proc.terminate()
