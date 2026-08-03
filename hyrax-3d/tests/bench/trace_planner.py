#!/usr/bin/env python3
"""Live planner trace harness — mount loft, setGoal desk.work, dump full trace.

Not part of npm test: needs the live gestalt-motion service + Playwright.
Usage: python3 trace_planner.py [--seconds 150]
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parents[3]
BENCH_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BENCH_DIR))
from gevs import PROBE_JS, PROBE_BONES, MOUNT_JS, start_server, wait_for_health  # noqa: E402

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=int, default=150)
    ap.add_argument("--goal", default="desk.work")
    ap.add_argument("--port", type=int, default=8893)
    ap.add_argument("--headed", action="store_true")
    args = ap.parse_args()

    port = args.port
    base = f"http://127.0.0.1:{port}"
    state_dir = tempfile.mkdtemp(prefix="hermes-trace-")
    proc = start_server(port, state_dir)
    try:
        if not wait_for_health(base):
            print("SETUP FAIL: WebUI did not come up", file=sys.stderr)
            return 2
        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                headless=not args.headed,
                args=["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"])
            ctx = browser.new_context(viewport={"width": 960, "height": 600})
            page = ctx.new_page()
            console_lines = []
            page.on("console", lambda m: console_lines.append(f"{m.type}: {m.text}"))
            page.on("pageerror", lambda e: console_lines.append(f"pageerror: {e}"))
            page.goto(base + "/?panel=hq", wait_until="domcontentloaded")
            page.wait_for_timeout(2000)
            if page.evaluate(MOUNT_JS, "/api/hyrax/assets/tai.embodiment.vrm") != "mounted":
                print("SETUP FAIL: loft mount failed", file=sys.stderr)
                return 2
            live = False
            for _ in range(90):
                if page.evaluate("() => window.__ardy ? window.__ardy.getState() : 'no-handle'") == "live":
                    live = True
                    break
                page.wait_for_timeout(1000)
            if not live:
                print("SETUP FAIL: never live", file=sys.stderr)
                return 2
            print("[trace] mounted + live", flush=True)
            page.evaluate(PROBE_JS, PROBE_BONES)

            # recenter to spawn + settle
            page.evaluate("(s) => window.__ardy.recenterRoot(s[0], s[1])", [0, 0.15])
            page.evaluate("(p) => window.__ardy.setPrompt(p)", "a person stands idle")
            page.wait_for_timeout(4000)

            page.evaluate("(g) => window.__ardy.setGoal(g)", args.goal)
            print(f"[trace] setGoal {args.goal}", flush=True)

            rows = []
            t0 = time.time()
            deadline = t0 + args.seconds
            last_log_len = 0
            while time.time() < deadline:
                row = page.evaluate("""() => {
                  const t = window.__ardy.getTelemetry();
                  const p = window.__ardy.poseProbe(['hips','leftFoot','rightFoot']);
                  return {
                    t: Math.round(performance.now()),
                    state: window.__ardy.getState(),
                    planner: t.planner || null,
                    navAbsorbs: t.navAbsorbCount,
                    residualResets: t.residualResetCount,
                    gateHold: (t.gate || {}).hold || false,
                    leanEma: (t.gate || {}).leanEmaDeg,
                    reflexActive: (t.reflex || {}).active || false,
                    x: p ? +p.x.toFixed(3) : null,
                    z: p ? +p.z.toFixed(3) : null,
                    yaw: p ? +p.yaw.toFixed(2) : null,
                  };
                }""")
                # print only NEW prompt log entries (compact)
                pl = row["planner"] or {}
                log = pl.get("promptLog") or []
                for e in log[last_log_len:]:
                    print(f"  [{row['t']:7d}] PROMPT {e['kind']:8s} {e['prompt'][:72]}", flush=True)
                last_log_len = len(log)
                rows.append(row)
                if (pl.get("goal") is None and len(rows) >= 2):
                    print("[trace] goal finished/failed — stopping", flush=True)
                    break
                time.sleep(0.5)

            # final state
            final = page.evaluate("() => window.__ardy.getTelemetry().planner || null")
            print("\n[trace] FINAL planner telemetry:", json.dumps(final, indent=1), flush=True)

            # dump the trace
            out = BENCH_DIR / "out" / "planner-trace.json"
            out.write_text(json.dumps({
                "goal": args.goal, "seconds": args.seconds,
                "rows": rows, "console_tail": console_lines[-40:],
            }, indent=1))
            print(f"\n[trace] wrote {out}", flush=True)

            # condensed table
            print("\ntime  phase      dist    facing  x      z      yaw    absorbs resets hold lean")
            for r in rows:
                pl = r["planner"] or {}
                ph = pl.get("phase") or "-"
                d = pl.get("distanceToSpot")
                fe = pl.get("facingErrDeg")
                print(f"{r['t']/1000:5.1f} {ph:10s} {str(d):7s} {str(fe):7s} "
                      f"{str(r['x']):6s} {str(r['z']):6s} {str(r['yaw']):6s} "
                      f"{r['navAbsorbs']:7d} {r['residualResets']:5d} {str(r['gateHold']):5s} "
                      f"{str(r['leanEma']):5s}")

    finally:
        proc.terminate()
        proc.wait(timeout=10)
    return 0

if __name__ == "__main__":
    sys.exit(main())
