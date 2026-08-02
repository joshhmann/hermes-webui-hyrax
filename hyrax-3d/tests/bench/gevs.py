#!/usr/bin/env python3
"""GEVS — Gestalt Embodiment Validation Suite runner (v1).

Runs the Level 1 + Level 2 check sequences (sequences/*.json — prompt lists
+ timing as DATA) against the live ARDY service through an isolated WebUI +
headless Chromium loft mount, measures probe metrics per check, scores them
against calibrated thresholds, and writes a JSON + markdown report.

NOT part of `npm test`: needs the live gestalt-motion service
(ws://192.168.0.17:8791/ws by default) and a Playwright Chromium. See
README.md in this directory for invocation.

The harness only sends prompts through the normal proxied WebSocket — it
never touches service configuration.
"""
import argparse
import datetime
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gevs_checks  # noqa: E402

REPO = Path(__file__).resolve().parents[3]
BENCH_DIR = Path(__file__).resolve().parent
SEQUENCES_DIR = BENCH_DIR / "sequences"
DEFAULT_UPSTREAM = "ws://192.168.0.17:8791/ws"

# Probe bone superset (quats + world positions) sampled every rAF frame.
PROBE_BONES = ["hips", "spine", "head", "leftHand", "rightHand",
               "leftFoot", "rightFoot", "leftToes", "rightToes"]

PROBE_JS = """(bones) => {
  window.__gevs = { frames: [] };
  const loop = () => {
    const p = window.__ardy && window.__ardy.poseProbe
      ? window.__ardy.poseProbe(bones) : null;
    const f = window.__ardy && window.__ardy.footWorldY
      ? window.__ardy.footWorldY() : null;
    if (p) window.__gevs.frames.push({
      t: performance.now(), x: p.x, z: p.z, yaw: p.yaw,
      bones: p.bones, world: p.world || {}, foot: f,
    });
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}"""

MOUNT_JS = """async (vrmUrl) => {
  const content = document.getElementById('mainHq') || document.body;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = '/static/hyrax/3d/embodiment-bundle.css';
  document.head.appendChild(link);
  const mod = await import('/static/hyrax/3d/embodiment-bundle.js');
  window.__unmount = await mod.mountTaiLoft(
    content, () => {}, { vrmUrl, development: true });
  return 'mounted';
}"""


def load_checks(selected):
    """Load check definitions from the sequence JSONs; expand sequence_file."""
    checks = []
    for seq_file in sorted(SEQUENCES_DIR.glob("level*.json")):
        for c in json.loads(seq_file.read_text())["checks"]:
            if "sequence_file" in c:
                data = json.loads((SEQUENCES_DIR / c["sequence_file"]).read_text())
                prompts = []
                for _ in range(data["repeats"]):
                    for ph in data["phrases"]:
                        prompts.append([ph["prompt"], data["phraseSeconds"], ph["label"]])
                c["prompts"] = prompts
            c["prompts"] = [p if len(p) == 3 else [p[0], p[1], f"{c['id']}-{i}"]
                            for i, p in enumerate(c["prompts"])]
            checks.append(c)
    if selected:
        wanted = set(selected.split(","))
        checks = [c for c in checks if c["id"] in wanted or f"level{c['level']}" in wanted]
    return checks


def wait_for_health(base, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(base + "/health", timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def start_server(port, state_dir):
    env = os.environ.copy()
    for k in list(env):
        if k.endswith("_API_KEY"):
            env.pop(k, None)
    env.update({
        "HERMES_WEBUI_PORT": str(port),
        "HERMES_WEBUI_HOST": "127.0.0.1",
        "HERMES_WEBUI_STATE_DIR": state_dir,
        "HERMES_HOME": state_dir,
        "HERMES_BASE_HOME": state_dir,
        "HERMES_WEBUI_SKIP_ONBOARDING": "1",
        "HERMES_WEBUI_AGENT_DIR": os.path.join(state_dir, "no-agent"),
    })
    log = open(os.path.join(state_dir, "server.log"), "w")
    proc = subprocess.Popen([sys.executable, str(REPO / "server.py")],
                            cwd=REPO, env=env, stdout=log, stderr=subprocess.STDOUT)
    return proc


def git_info():
    def run(*args):
        return subprocess.run(["git", "-C", str(REPO), *args],
                              capture_output=True, text=True).stdout.strip()
    sha = run("rev-parse", "--short", "HEAD")
    dirty = bool(run("status", "--porcelain"))
    return sha, dirty


def fmt(v):
    if v is None:
        return "—"
    if isinstance(v, float):
        return f"{v:g}"
    return str(v)


def write_markdown(path, report):
    L = []
    L.append(f"# GEVS run — {report['profile']} — {report['startedAt']}")
    L.append("")
    L.append(f"- profile: `{report['profile']}` (vrm `{report['vrmUrl']}`)")
    L.append(f"- git: `{report['gitSha']}`{' (dirty tree)' if report['gitDirty'] else ''}")
    L.append(f"- service: `{report['service']['upstream']}` "
             f"(contract `{report['service']['contractVersion']}`; "
             f"model/history budget: {report['service']['model']})")
    L.append(f"- overall score: **{fmt(report['scores']['overall'])}**")
    L.append("")
    L.append("| category | score |")
    L.append("|---|---|")
    for name, cat in report["scores"]["categories"].items():
        L.append(f"| {name} | {fmt(cat['score'])} |")
    L.append("")
    L.append("| check | level | category | verdict | score | key metrics |")
    L.append("|---|---|---|---|---|---|")
    for c in report["checks"]:
        m = c["metrics"]
        key = ", ".join(f"{k}={fmt(m[k])}" for k in
                        ("travelM", "yawDeltaDeg", "livePct", "streamResets", "navAbsorbs",
                         "maxLeanEmaDeg", "footP5Y", "phraseCompletionPct")
                        if m.get(k) is not None)
        score = fmt(round(c["score"], 2) if c["score"] is not None else None)
        L.append(f"| {c['id']} | {c['level']} | {c['category']} | {c['verdict']} | {score} | {key} |")
    L.append("")
    L.append("## Assertions and thresholds")
    L.append("")
    for c in report["checks"]:
        L.append(f"### {c['id']} ({c['verdict']})")
        L.append("")
        L.append("| metric | value | op | pass | partial | verdict | basis |")
        L.append("|---|---|---|---|---|---|---|")
        for a in c["assertions"]:
            L.append(f"| {a['metric']} | {fmt(a['value'])} | {a['op']} | {fmt(a.get('pass'))} "
                     f"| {fmt(a.get('partial'))} | {a['verdict']} | {a.get('basis', '')} |")
        L.append("")
    path.write_text("\n".join(L) + "\n")


def main():
    ap = argparse.ArgumentParser(description="GEVS runner")
    ap.add_argument("--checks", help="comma list of check ids, or level1/level2 (default: all)")
    ap.add_argument("--out", help="output directory (default: out/<timestamp> under tests/bench)")
    ap.add_argument("--port", type=int, default=int(os.getenv("GEVS_PORT", "8891")))
    ap.add_argument("--profile", default="tai-embodiment-v3")
    ap.add_argument("--vrm", default="/api/hyrax/assets/tai.embodiment.vrm")
    ap.add_argument("--label", default="", help="extra label for the report header")
    ap.add_argument("--headed", action="store_true",
                    help="launch a VISIBLE browser (watch the run on this machine's display)")
    args = ap.parse_args()

    checks = load_checks(args.checks)
    if not checks:
        print("no checks selected", file=sys.stderr)
        return 2
    out_dir = Path(args.out) if args.out else (
        BENCH_DIR / "out" / datetime.datetime.now().strftime("%Y%m%d-%H%M%S"))
    shots_dir = out_dir / "shots"
    shots_dir.mkdir(parents=True, exist_ok=True)

    port = args.port
    base = f"http://127.0.0.1:{port}"
    state_dir = tempfile.mkdtemp(prefix="hermes-gevs-")
    proc = start_server(port, state_dir)
    console_lines = []
    t_run0 = time.time()
    try:
        if not wait_for_health(base):
            print(f"SETUP FAIL: WebUI did not come up on :{port} (log {state_dir}/server.log)",
                  file=sys.stderr)
            return 2
        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                headless=not args.headed,
                args=["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"])
            ctx = browser.new_context(viewport={"width": 960, "height": 600})
            page = ctx.new_page()
            page.on("console", lambda m: console_lines.append(f"{m.type}: {m.text}"))
            page.on("pageerror", lambda e: console_lines.append(f"pageerror: {e}"))
            page.goto(base + "/?panel=hq", wait_until="domcontentloaded")
            page.wait_for_timeout(2000)
            if page.evaluate(MOUNT_JS, args.vrm) != "mounted":
                print("SETUP FAIL: loft mount failed", file=sys.stderr)
                return 2
            live = False
            for _ in range(90):
                if page.evaluate("() => window.__ardy ? window.__ardy.getState() : 'no-handle'") == "live":
                    live = True
                    break
                page.wait_for_timeout(1000)
            if not live:
                print("SETUP FAIL: loft never reached live state", file=sys.stderr)
                return 2
            page.evaluate("""() => {
              for (const b of document.querySelectorAll('button'))
                if (b.textContent === 'Follow') b.click();
              const sel = document.querySelector('select[aria-label="Room lighting"]');
              if (sel) { sel.value = 'noon'; sel.dispatchEvent(new Event('change')); }
            }""")
            page.evaluate(PROBE_JS, PROBE_BONES)

            def run_segments(check):
                """Settle, then play each prompt; per-segment frames+tels."""
                spot = check.get("recenter")
                if spot and page.evaluate(
                        "(s) => window.__ardy.recenterRoot ? window.__ardy.recenterRoot(s[0], s[1]) : false",
                        spot):
                    print(f"  [recenter] {check['id']} → ({spot[0]}, {spot[1]})", flush=True)
                page.evaluate("(p) => window.__ardy.setPrompt(p)", "a person stands idle")
                page.wait_for_timeout(int(check.get("settleS", 3)) * 1000)
                segments = []
                for prompt, seconds, label in check["prompts"]:
                    mark = page.evaluate("() => window.__gevs.frames.length")
                    tel_before = page.evaluate("() => ({ ...window.__ardy.getTelemetry() })")
                    page.evaluate("(p) => window.__ardy.setPrompt(p)", prompt)
                    print(f"  [prompt] t={time.time()-t_run0:6.1f} {label}: {prompt!r}", flush=True)
                    end = time.time() + seconds
                    tels = []
                    while time.time() < end:
                        tels.append(page.evaluate(
                            "() => ({ state: window.__ardy.getState(), ...window.__ardy.getTelemetry() })"))
                        page.wait_for_timeout(500)
                    segments.append({"label": label, "prompt": prompt, "seconds": seconds,
                                     "frame_mark": mark, "tel_before": tel_before, "tels": tels})
                page.screenshot(path=str(shots_dir / f"{check['id']}.jpg"), type="jpeg", quality=60)
                return segments

            # Idle motion floor for the dance phrase-completion metric.
            print("[gevs] measuring idle motion floor (6 s)", flush=True)
            idle_seg = run_segments({"id": "idle-floor", "settleS": 2,
                                     "prompts": [["a person stands idle", 6, "idle-floor"]]})
            idle_frames = page.evaluate("() => window.__gevs.frames")
            page.evaluate("() => { window.__gevs.frames = [] }")

            raw = {}
            for check in checks:
                print(f"[gevs] check {check['id']} ({check['category']})", flush=True)
                raw[check["id"]] = run_segments(check)

            frames = page.evaluate("() => window.__gevs.frames")
            tel_final = page.evaluate("() => ({ ...window.__ardy.getTelemetry() })")
            ctx.close()
            browser.close()

        # Slice the flat frame buffer into per-segment windows.
        marks = []
        for check in checks:
            for s in raw[check["id"]]:
                marks.append((s["frame_mark"], check["id"], s))
        marks.sort(key=lambda x: x[0])
        for i, (mark, _cid, seg) in enumerate(marks):
            end_mark = marks[i + 1][0] if i + 1 < len(marks) else len(frames)
            seg["frames"] = frames[mark:end_mark]

        floor_m = gevs_checks.segment_frames_metrics(
            idle_frames[idle_seg[0]["frame_mark"]:])
        idle_floor = floor_m.get("hipsRateMedianDegS")

        results = []
        for check in checks:
            metrics = gevs_checks.compute_metrics(check, raw[check["id"]], idle_floor)
            results.append(gevs_checks.score_check(check, metrics))

        # Foot-contact aggregate: measured across every frame of the run.
        foot_frames = frames
        agg_check = {"id": "foot-contact", "level": 1, "category": "foot-contact",
                     "prompts": [], "assertions": [
                         {"metric": "footP5Y", "op": ">=", "pass": -0.12, "partial": -0.20,
                          "basis": "baseline p5 of lowest foot-bone Y across the whole run: -0.074 m (mild floor penetration at T1 — measured, not hidden)"},
                         {"metric": "footMinY", "op": ">=", "pass": -0.30, "partial": -0.45,
                          "basis": "baseline min lowest foot-bone Y: -0.21 m (worst-frame penetration during sit/squat)"},
                     ]}
        agg_metrics = gevs_checks.compute_metrics(
            {"id": "foot-contact"},
            [{"label": "all", "frames": foot_frames, "tels": [], "tel_before": {}}],
            idle_floor)
        results.append(gevs_checks.score_check(agg_check, agg_metrics))

        scores = gevs_checks.score_run(results)
        sha, dirty = git_info()
        report = {
            "suite": "GEVS v1",
            "profile": args.profile,
            "vrmUrl": args.vrm,
            "label": args.label,
            "startedAt": datetime.datetime.now().isoformat(timespec="seconds"),
            "durationS": round(time.time() - t_run0, 1),
            "gitSha": sha,
            "gitDirty": dirty,
            "service": {
                "upstream": os.environ.get("HYRAX_ARDY_WS_UPSTREAM") or DEFAULT_UPSTREAM,
                "contractVersion": (tel_final or {}).get("contractVersion"),
                "model": "unknown (not exposed through the loft telemetry)",
            },
            "idleFloorRateDegS": idle_floor,
            "scores": scores,
            "checks": results,
            "console": [l for l in console_lines
                        if "ardy" in l.lower() or l.startswith(("error", "pageerror"))][:50],
        }
        (out_dir / "gevs-report.json").write_text(json.dumps(report, indent=1))
        write_markdown(out_dir / "gevs-report.md", report)
        print(f"\n[gevs] wrote {out_dir}/gevs-report.json + .md")
        print(f"{'check':<20}{'category':<14}{'verdict':<12}score")
        for c in results:
            print(f"{c['id']:<20}{c['category']:<14}{c['verdict']:<12}{fmt(c['score'])}")
        for name, cat in scores["categories"].items():
            print(f"  {name:<18}{fmt(cat['score'])}")
        print(f"OVERALL: {fmt(scores['overall'])}")
        fails = [c for c in results if c["verdict"] == "fail"]
        return 1 if fails else 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
