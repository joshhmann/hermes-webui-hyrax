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

# Run-history store: every run appends a per-check verdict row (capped),
# so flaky checks show their pattern (time-of-day, load) instead of one
# verdict. Gitignored — it is evidence, not a deliverable.
RUN_HISTORY_PATH = BENCH_DIR / "run_history.json"
RUN_HISTORY_CAP = 50


def host_snapshot():
    """Best-effort load snapshot of the motion-service host at run START.
    Wall-clock time is the report's own `startedAt`; this adds the host's
    loadavg/GPU/uptime so time-of-day dependence is visible in the data
    (measured: planner checks pass/fail with the same code at different
    hours — host load shifts ARDY stream latency). Fail-soft: any ssh/
    parse failure returns the fields it could read plus `snapshotOk: False`
    and an error note — a missing stamp never fails the run.

    Host comes from the upstream URL (env override or DEFAULT_UPSTREAM).
    Override the ssh user with GEVS_SNAPSHOT_USER (default root).
    """
    upstream = os.environ.get("HYRAX_ARDY_WS_UPSTREAM") or DEFAULT_UPSTREAM
    ctx = {
        "capturedAt": datetime.datetime.now().isoformat(timespec="seconds"),
        "host": None, "loadavg": None, "gpu": None, "uptime": None,
        "snapshotOk": False, "note": "",
    }
    try:
        from urllib.parse import urlparse
        host = urlparse(upstream).hostname
    except Exception as e:  # noqa: BLE001 — snapshot is never fatal
        ctx["note"] = f"could not parse upstream {upstream!r}: {e}"
        return ctx
    ctx["host"] = host
    user = os.environ.get("GEVS_SNAPSHOT_USER", "root")
    cmd = (
        f"cat /proc/loadavg; echo ---; "
        f"nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader "
        f"2>/dev/null || echo no-gpu; echo ---; uptime"
    )
    try:
        out = subprocess.run(
            ["ssh", "-o", "ConnectTimeout=5", "-o", "BatchMode=yes",
             "-o", "StrictHostKeyChecking=accept-new", f"{user}@{host}", cmd],
            capture_output=True, text=True, timeout=15,
        ).stdout
    except Exception as e:  # noqa: BLE001
        ctx["note"] = f"ssh snapshot failed: {e}"
        return ctx
    parts = out.split("---")
    if len(parts) == 3:
        try:
            la = parts[0].split()
            ctx["loadavg"] = [float(la[0]), float(la[1]), float(la[2])]
        except Exception as e:  # noqa: BLE001
            ctx["note"] = f"loadavg parse: {e} ({parts[0].strip()!r})"
        gpu = []
        for line in parts[1].strip().splitlines():
            if not line.strip() or line.strip() == "no-gpu":
                continue
            try:
                util, mem = [x.strip() for x in line.split(",")]
                gpu.append({"util": util, "memMiB": mem})
            except Exception:  # noqa: BLE001
                gpu.append({"raw": line.strip()})
        ctx["gpu"] = gpu or None
        ctx["uptime"] = parts[2].strip()
        ctx["snapshotOk"] = True
    else:
        ctx["note"] = f"unexpected snapshot output: {out[:200]!r}"
    return ctx


def record_run(report, results):
    """Append this run's per-check verdicts to the history store (capped).
    Called after every run so the flake pattern accumulates automatically."""
    row = {
        "startedAt": report["startedAt"],
        "label": report.get("label", ""),
        "gitSha": report.get("gitSha"),
        "runContext": report.get("runContext", {}),
        "checks": [{"id": c["id"], "category": c.get("category"),
                    "level": c.get("level"), "verdict": c.get("verdict"),
                    "score": c.get("score")} for c in results],
    }
    hist = []
    if RUN_HISTORY_PATH.exists():
        try:
            hist = json.loads(RUN_HISTORY_PATH.read_text())
        except Exception:  # noqa: BLE001 — corrupted history is not fatal
            hist = []
        if not isinstance(hist, list):
            hist = []
    hist.append(row)
    RUN_HISTORY_PATH.write_text(json.dumps(hist[-RUN_HISTORY_CAP:], indent=1))


def flake_stats():
    """Per-check flake pattern from the run history: verdict counts, last
    pass/fail, and the wall-clock hour windows in which it passed (the
    time-of-day axis). Empty dict when no history yet."""
    if not RUN_HISTORY_PATH.exists():
        return {}
    try:
        hist = json.loads(RUN_HISTORY_PATH.read_text())
    except Exception:  # noqa: BLE001
        return {}
    if not isinstance(hist, list):
        return {}
    stats = {}
    for run in hist:
        try:
            hour = int(run["startedAt"][11:13])
        except Exception:  # noqa: BLE001
            hour = None
        for c in run.get("checks", []):
            d = stats.setdefault(c["id"], {
                "passes": 0, "partials": 0, "fails": 0,
                "lastPassAt": None, "lastFailAt": None, "passHours": [],
            })
            if c.get("verdict") == "pass":
                d["passes"] += 1
                d["lastPassAt"] = run["startedAt"]
                if hour is not None:
                    d["passHours"].append(hour)
            elif c.get("verdict") == "partial":
                d["partials"] += 1
            else:
                d["fails"] += 1
                d["lastFailAt"] = run["startedAt"]
    for d in stats.values():
        hours = sorted(set(d.pop("passHours")))
        d["passWindowHours"] = [hours[0], hours[-1]] if hours else None
        d["passRate"] = round(
            d["passes"] / (d["passes"] + d["partials"] + d["fails"]), 2)
    return stats

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

# Stateful-interactable probe (spatial layer 5 — door-open check): live
# object state, mesh rotation (deg), nav obstacle enabled-state, doorway
# route-clear, and the transition journal — sampled alongside telemetry.
DOOR_PROBE_JS = """(payload) => {
  const a = window.__ardy;
  const id = payload.id;
  const route = payload.route;
  return {
    state: a.getObjectState ? a.getObjectState(id) : null,
    rotDeg: a.getObjectRotationDeg ? a.getObjectRotationDeg(id) : null,
    nav: a.getNavObstacle ? a.getNavObstacle(id) : null,
    doorwayRouteClear: a.navRouteClear && route
      ? a.navRouteClear(route[0], route[1], route[2], route[3]) : null,
    journal: a.getStateJournal ? a.getStateJournal() : null,
  };
}"""


def door_probe(page, check):
    """Sample the stateful-interactable probes for a check's stateObject
    (None when the check has none). Route-clear uses the check's authored
    doorwayRoute so the doorway corridor is asserted, not hardcoded here."""
    if not check.get("stateObject"):
        return None
    return page.evaluate(
        DOOR_PROBE_JS, {"id": check["stateObject"], "route": check.get("doorwayRoute")})


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
            # Goal-driven checks (spatial layer 3b) carry `goal` instead of a
            # prompt schedule — the runner drives __ardy.setGoal.
            c["prompts"] = c.get("prompts") or []
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
    rc = report.get("runContext") or {}
    if rc.get("snapshotOk"):
        gpu = ", ".join(
            f"{g.get('util', '?')} @ {g.get('memMiB', '?')}" for g in (rc.get("gpu") or [])) or "no-gpu"
        L.append(f"- host `{rc['host']}` @ {rc['capturedAt']}: loadavg "
                 f"{rc['loadavg'][0]}/{rc['loadavg'][1]}/{rc['loadavg'][2]} · "
                 f"GPU {gpu} · uptime `{rc['uptime']}`")
    elif rc.get("note"):
        L.append(f"- host snapshot: {rc['note']}")
    L.append(f"- overall score: **{fmt(report['scores']['overall'])}**")
    L.append("")
    flake = report.get("flake")
    if flake:
        L.append("## Flake pattern (history)")
        L.append("")
        L.append("| check | pass rate | passes | partials | fails | last pass | last fail | pass window (runner-local h) |")
        L.append("|---|---|---|---|---|---|---|---|")
        for cid, d in sorted(flake.items()):
            win = "-".join(str(h) for h in d["passWindowHours"]) if d.get("passWindowHours") else "—"
            L.append(f"| {cid} | {d['passRate']} | {d['passes']} | {d['partials']} | "
                     f"{d['fails']} | {d['lastPassAt'] or '—'} | {d['lastFailAt'] or '—'} | {win} |")
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
                         "maxLeanEmaDeg", "footP5Y", "phraseCompletionPct",
                         "arrivalM", "facingErrDegAtInteract", "goalCompleted",
                         "interactionSeen", "replans",
                         "pickupSeen", "attachErrorM", "carryTravelM", "carryHeldPct",
                         "putdownSeen", "placeErrorM", "staysM",
                         "doorStateOpen", "doorRotationDeltaDeg", "doorNavEnabledAfter",
                         "doorwayRouteClearBefore", "doorwayRouteClearAfter", "stateJournalSeen")
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
    ap.add_argument("--promote", action="store_true",
                    help="after the run, write tests/bench/scoreboard.json = newest report "
                         "+ per-check flake stats (history-derived; tree becomes dirty — kimi commits)")
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
    # Run-context stamp (time-of-day visibility): host load at run START —
    # takes ~1s, ssh is fail-soft, never blocks the run.
    run_ctx = host_snapshot()
    if run_ctx.get("snapshotOk"):
        print(f"[gevs] host snapshot {run_ctx['host']}: "
              f"load {run_ctx['loadavg']}, gpu {run_ctx['gpu']}")
    else:
        print(f"[gevs] host snapshot unavailable ({run_ctx['host']}): {run_ctx['note']}")
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

            def run_goal_check(check):
                """Goal-driven check (spatial layer 3b): __ardy.setGoal → sample
                telemetry + probe until the planner finishes (or times out)."""
                spot = check.get("recenter")
                if spot and page.evaluate(
                        "(s) => window.__ardy.recenterRoot ? window.__ardy.recenterRoot(s[0], s[1]) : false",
                        spot):
                    print(f"  [recenter] {check['id']} → ({spot[0]}, {spot[1]})", flush=True)
                page.evaluate("(p) => window.__ardy.setPrompt(p)", "a person stands idle")
                page.wait_for_timeout(int(check.get("settleS", 3)) * 1000)
                mark = page.evaluate("() => window.__gevs.frames.length")
                tel_before = page.evaluate("() => ({ ...window.__ardy.getTelemetry() })")
                # Stateful-interactable pre-sample (spatial layer 5): the
                # object's state/rotation/nav + doorway route BEFORE the goal
                # — the fail-before half of the door-open evidence.
                door_before = door_probe(page, check)
                if door_before is not None:
                    tel_before["door"] = door_before
                page.evaluate("(g) => window.__ardy.setGoal(g)", check["goal"])
                print(f"  [goal] t={time.time()-t_run0:6.1f} {check['goal']}", flush=True)
                deadline = time.time() + int(check.get("goalTimeoutS", 90))
                tels = []
                while time.time() < deadline:
                    tels.append(page.evaluate(
                        "() => ({ state: window.__ardy.getState(), ...window.__ardy.getTelemetry() })"))
                    # Stateful-interactable sample alongside each telemetry
                    # sample (state after completion, rotation, nav toggle,
                    # route flip, journal entries).
                    door = door_probe(page, check)
                    if door is not None:
                        tels[-1]["door"] = door
                    planner = (tels[-1].get("planner") or {})
                    if planner.get("goal") is None and len(tels) >= 2:
                        break  # goal completed / failed / cancelled — journaled in tel
                    page.wait_for_timeout(500)
                segments = [{"label": check["id"], "prompt": f"goal:{check['goal']}",
                             "seconds": round(time.time() - deadline + int(check.get("goalTimeoutS", 90)), 1),
                             "frame_mark": mark, "tel_before": tel_before, "tels": tels}]
                page.screenshot(path=str(shots_dir / f"{check['id']}.jpg"), type="jpeg", quality=60)
                # DEBUG: dump raw tels for diagnosis (temporary)
                import json as _json
                frames = page.evaluate("() => window.__gevs.frames || []")
                Path("/tmp/gevs-door-debug-tels.json").write_text(
                    _json.dumps({"goal": check["goal"], "tel_before": tel_before,
                                 "tels": tels, "console": console_lines,
                                 "frames": frames[::6]}, indent=1))
                return segments

            def run_essence_check(check):
                """Essence-driven check (spatial layer 4): seed the operator's
                derived state via the test-only presence override
                (__ardy.setEssenceState) → the essence driver fires the matching
                goal on its poll cadence; sample telemetry + probe until the
                driver-fired goal runs and completes (or times out). No settle
                prompt here: a user prompt would start the driver's 30 s quiet
                window and double the check wall time. The override is cleared
                afterwards so the real presence path is never affected.

                Isolation (Mai RCA t_af24521d): the check clears any goal left
                by a previous check FIRST — a stale goal would occupy the
                single goal slot and starve the essence driver (the RCA's
                essenceGoalSeen=0 run opened its window with the door goal
                still active). The seed is then set and verified via the
                getEssenceState echo — a silently dropped seed would make an
                essenceGoalSeen=0 result uninterpretable. `started` is keyed
                on goalSource.kind == 'essence' SPECIFICALLY, so a stray
                non-essence goal can never satisfy the completion break."""
                spot = check.get("recenter")
                if spot and page.evaluate(
                        "(s) => window.__ardy.recenterRoot ? window.__ardy.recenterRoot(s[0], s[1]) : false",
                        spot):
                    print(f"  [recenter] {check['id']} → ({spot[0]}, {spot[1]})", flush=True)
                # Fresh-planner isolation: cancel any goal left over from a
                # previous check before the seed lands.
                page.evaluate("() => window.__ardy.clearGoal ? window.__ardy.clearGoal() : false")
                page.wait_for_timeout(int(check.get("settleS", 3)) * 1000)
                mark = page.evaluate("() => window.__gevs.frames.length")
                tel_before = page.evaluate("() => ({ ...window.__ardy.getTelemetry() })")
                page.evaluate(
                    "(s) => window.__ardy.setEssenceState ? window.__ardy.setEssenceState(s) : false",
                    check["essenceSeed"])
                seed_echo = page.evaluate(
                    "() => window.__ardy.getEssenceState ? window.__ardy.getEssenceState() : null")
                print(f"  [essence-seed] t={time.time()-t_run0:6.1f} {json.dumps(check['essenceSeed'])[:100]} "
                      f"→ echo {json.dumps(seed_echo)[:60]}", flush=True)
                seed_ok = bool(seed_echo) and seed_echo.get("fresh") is True
                if not seed_ok:
                    print(f"  [essence-seed] WARNING: seed echo did not land: "
                          f"{json.dumps(seed_echo)[:120]}", flush=True)
                deadline = time.time() + int(check.get("goalTimeoutS", 90))
                tels = []
                started = False
                while time.time() < deadline:
                    tels.append(page.evaluate(
                        "() => ({ state: window.__ardy.getState(), ...window.__ardy.getTelemetry() })"))
                    planner = (tels[-1].get("planner") or {})
                    src = planner.get("goalSource") or {}
                    if src.get("kind") == "essence":
                        started = True
                    if started and planner.get("goal") is None and len(tels) >= 4:
                        break  # the driver-fired goal ran and completed
                    page.wait_for_timeout(500)
                page.evaluate("() => window.__ardy.setEssenceState ? window.__ardy.setEssenceState(null) : false")
                segments = [{"label": check["id"], "prompt": f"essence:{check['essenceSeed']}",
                             "seconds": round(time.time() - deadline + int(check.get("goalTimeoutS", 90)), 1),
                             "frame_mark": mark, "tel_before": tel_before, "tels": tels,
                             "seedEchoOk": seed_ok}]
                page.screenshot(path=str(shots_dir / f"{check['id']}.jpg"), type="jpeg", quality=60)
                return segments

            def run_pickup_check(check):
                """Bounded-pickup check (spatial layer 5): drives the
                pickupFlow phases (cup.pickup → carry goal → cup.putdown)
                through __ardy.setGoal, sampling the pickup probe
                (__ardy.pickupProbe) alongside telemetry at 2 Hz. Phase
                expectations: pickup attaches (holding='cup'), the carry
                goal completes while still holding, putdown releases
                (holding=null) and places the cup at its home. A
                post-release settle window proves 'stays there' from the
                real mesh position. Fail-closed: a phase that never meets
                its expectation runs to its timeout and the metrics report
                the miss with evidence."""
                spot = check.get("recenter")
                if spot and page.evaluate(
                        "(s) => window.__ardy.recenterRoot ? window.__ardy.recenterRoot(s[0], s[1]) : false",
                        spot):
                    print(f"  [recenter] {check['id']} → ({spot[0]}, {spot[1]})", flush=True)
                page.evaluate("(p) => window.__ardy.setPrompt(p)", "a person stands idle")
                page.wait_for_timeout(int(check.get("settleS", 3)) * 1000)
                segments = []
                for phase in check["pickupFlow"]:
                    # Per-phase recenter (2026-08-08): teleport her to a
                    # standing spawn before a phase goal when the phase asks
                    # (putdown). Isolates the phase's evidence (release +
                    # placement) from the planner's long-walk flake class —
                    # a multi-meter re-approach under host load can fire a
                    # capped-turn walk with a residual heading and die
                    # "blocked" (measured live, pickup-cup bench). The carry
                    # phase already proves follow-through-locomotion; the
                    # putdown phase proves release + place + stays.
                    if phase.get("recenter") and page.evaluate(
                            "(s) => window.__ardy.recenterRoot ? window.__ardy.recenterRoot(s[0], s[1]) : false",
                            phase["recenter"]):
                        print(f"  [pickup:{phase['phase']}] recenter → ({phase['recenter'][0]}, {phase['recenter'][1]})", flush=True)
                    mark = page.evaluate("() => window.__gevs.frames.length")
                    tel_before = page.evaluate("() => ({ ...window.__ardy.getTelemetry() })")
                    page.evaluate("(g) => window.__ardy.setGoal(g)", phase["goal"])
                    print(f"  [pickup:{phase['phase']}] t={time.time()-t_run0:6.1f} goal {phase['goal']} "
                          f"(expect {phase['expect']})", flush=True)
                    deadline = time.time() + int(phase.get("timeoutS", check.get("goalTimeoutS", 90)))
                    tels, probes = [], []
                    started = False
                    while time.time() < deadline:
                        tels.append(page.evaluate(
                            "() => ({ state: window.__ardy.getState(), ...window.__ardy.getTelemetry() })"))
                        probes.append(page.evaluate(
                            "() => window.__ardy.pickupProbe ? window.__ardy.pickupProbe() : null"))
                        planner = (tels[-1].get("planner") or {})
                        if planner.get("goal") is not None:
                            started = True
                        done = started and planner.get("goal") is None and len(tels) >= 2
                        if done:
                            holding = (probes[-1] or {}).get("holding")
                            if (phase["expect"] == "holding" and holding == "cup") or \
                               (phase["expect"] == "released" and holding is None):
                                break  # goal completed AND the probe confirms the expected state
                        page.wait_for_timeout(500)
                    segments.append({"label": f"{check['id']}-{phase['phase']}",
                                     "prompt": f"goal:{phase['goal']}",
                                     "seconds": round(time.time() - deadline + int(phase.get("timeoutS", 90)), 1),
                                     "frame_mark": mark, "tel_before": tel_before,
                                     "tels": tels, "probes": probes})
                # Post-release settle: the placed cup must STAY at its home
                # (measured from the real mesh position, 2 Hz).
                mark = page.evaluate("() => window.__gevs.frames.length")
                tel_before = page.evaluate("() => ({ ...window.__ardy.getTelemetry() })")
                print(f"  [pickup:settle] t={time.time()-t_run0:6.1f} release settle "
                      f"({check.get('releaseSettleS', 6)} s)", flush=True)
                settle_tels, settle_probes = [], []
                for _ in range(int(check.get("releaseSettleS", 6)) * 2):
                    settle_tels.append(page.evaluate(
                        "() => ({ state: window.__ardy.getState(), ...window.__ardy.getTelemetry() })"))
                    settle_probes.append(page.evaluate(
                        "() => window.__ardy.pickupProbe ? window.__ardy.pickupProbe() : null"))
                    page.wait_for_timeout(500)
                segments.append({"label": f"{check['id']}-settle", "prompt": "release-settle",
                                 "seconds": int(check.get("releaseSettleS", 6)),
                                 "frame_mark": mark, "tel_before": tel_before,
                                 "tels": settle_tels, "probes": settle_probes})
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
                if check.get("pickupFlow"):
                    raw[check["id"]] = run_pickup_check(check)
                elif check.get("essenceSeed"):
                    raw[check["id"]] = run_essence_check(check)
                elif check.get("goal"):
                    raw[check["id"]] = run_goal_check(check)
                else:
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
                          "basis": "baseline p5 of lowest foot-bone Y across the whole run: -0.074 m pre ground-fix; -0.017 m post-fix 2026-08-03 (threshold kept from the pre-fix calibration)"},
                         {"metric": "footMinY", "op": ">=", "pass": -0.30, "partial": -0.45,
                          "basis": "baseline min lowest foot-bone Y: -0.21 m pre-fix (worst-frame penetration during sit/squat); -0.101 m post-fix"},
                         {"metric": "toeP5Y", "op": ">=", "pass": -0.05, "partial": -0.09,
                          "basis": "toe-floor clearance p5: -0.055 m pre-fix (cha-cha benchmark), -0.017 m post-fix 2026-08-03; residual dips are transient lowpass-lag beats in fast moves"},
                         {"metric": "footMedianY", "op": ">=", "pass": 0.01, "partial": -0.01,
                          "basis": "median lowest foot-bone Y: -0.010 m pre-fix (systematic clip), +0.041 m post-fix (feet at normalized-rest silhouette ≈ planted)"},
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
            # Time-of-day visibility: wall-clock + the motion host's load
            # at run start (loadavg/GPU/uptime), so a check that passes at
            # 20:29 and fails at 00:40 shows WHY (host load shifts ARDY
            # stream latency — measured 2026-08-02/03). Fail-soft snapshot:
            # a missing stamp records the note, never fails the run.
            "runContext": run_ctx,
            "service": {
                "upstream": os.environ.get("HYRAX_ARDY_WS_UPSTREAM") or DEFAULT_UPSTREAM,
                "contractVersion": (tel_final or {}).get("contractVersion"),
                "model": "unknown (not exposed through the loft telemetry)",
            },
            "idleFloorRateDegS": idle_floor,
            "scores": scores,
            "checks": results,
            "console": [l for l in console_lines
                        if "ardy" in l.lower() or "[planner]" in l or l.startswith(("error", "pageerror"))][:50],
        }
        (out_dir / "gevs-report.json").write_text(json.dumps(report, indent=1))
        write_markdown(out_dir / "gevs-report.md", report)
        record_run(report, results)
        print(f"\n[gevs] wrote {out_dir}/gevs-report.json + .md")
        if args.promote:
            report["flake"] = flake_stats()
            (BENCH_DIR / "scoreboard.json").write_text(json.dumps(report, indent=1))
            print(f"[gevs] promoted tests/bench/scoreboard.json (+ flake stats, {len(report['flake'])} checks)")
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
