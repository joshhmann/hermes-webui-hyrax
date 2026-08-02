"""GEVS check metrics + scoring.

A check run produces `segments` (one per prompt sent): each segment has the
probe frames captured while it played plus the 2 Hz telemetry samples. This
module turns those into named metrics and scores them against the
assertions declared in the sequence JSON.

Honest scoring rules:
- a metric that could not be measured (missing probe seam, no frames) is
  reported as UNMEASURED — never guessed, never silently zero;
- an assertion without a calibrated threshold scores UNMEASURED too (this is
  how a first baseline run reports);
- check verdict: pass (all scored assertions pass) / partial / fail;
  check score = mean of assertion scores (pass 1.0, partial 0.5, fail 0),
  unmeasured assertions excluded from the mean but listed.
"""
import math

# Frames whose lowest foot bone sits below this height count as ground
# contact for the slide metric (VRM normalized space, meters).
CONTACT_EPS_M = 0.06


def _wrap_deg(deg):
    while deg > 180:
        deg -= 360
    while deg < -180:
        deg += 360
    return deg


def _dist_xz(a, b):
    return math.hypot(b[0] - a[0], b[2] - a[2])


def quat_angle_deg(a, b):
    dot = abs(sum(x * y for x, y in zip(a, b, strict=True)))
    return 2 * math.degrees(math.acos(min(1.0, dot)))


def segment_frames_metrics(frames):
    """Metrics that are meaningful per prompt segment (shuffle phrases)."""
    out = {"frames": len(frames)}
    if len(frames) < 2:
        return out
    pts = [(f["x"], 0.0, f["z"]) for f in frames]
    out["pathM"] = sum(_dist_xz(a, b) for a, b in zip(pts, pts[1:], strict=False))
    out["travelM"] = _dist_xz(pts[0], pts[-1])
    out["yawDeltaDeg"] = _wrap_deg(math.degrees(frames[-1]["yaw"] - frames[0]["yaw"]))
    rates = []
    for a, b in zip(frames, frames[1:], strict=False):
        qa, qb = a.get("bones", {}).get("hips"), b.get("bones", {}).get("hips")
        if qa and qb:
            dt = max(1e-3, (b["t"] - a["t"]) / 1000)
            rates.append(quat_angle_deg(qa, qb) / dt)
    rates.sort()
    out["hipsRateMedianDegS"] = rates[len(rates) // 2] if rates else None
    return out


def compute_metrics(check, segments, idle_floor_rate):
    """Whole-check metrics. `segments`: list of dicts with frames/tels/tel_before."""
    m = {}
    frames = [f for s in segments for f in s["frames"]]
    tels = [t for s in segments for t in s["tels"]]

    # ── stream health ─────────────────────────────────────────────
    if tels:
        m["livePct"] = round(100 * sum(1 for t in tels if t.get("state") == "live") / len(tels), 1)
        m["gateHoldSamples"] = sum(1 for t in tels if (t.get("gate") or {}).get("hold"))
        leans = [(t.get("gate") or {}).get("leanEmaDeg") for t in tels]
        leans = [l for l in leans if l is not None]
        m["maxLeanEmaDeg"] = round(max(leans), 1) if leans else None
        first = segments[0]["tel_before"] or {}
        last = tels[-1]
        if "residualResetCount" in last and "residualResetCount" in first:
            m["streamResets"] = last["residualResetCount"] - first["residualResetCount"]
        else:
            m["streamResets"] = None  # probe seam missing → UNMEASURED
        if "navAbsorbCount" in last and "navAbsorbCount" in first:
            m["navAbsorbs"] = last["navAbsorbCount"] - first["navAbsorbCount"]
        else:
            m["navAbsorbs"] = None
    else:
        m.update(livePct=None, gateHoldSamples=None, maxLeanEmaDeg=None,
                 streamResets=None, navAbsorbs=None)

    # ── root kinematics ───────────────────────────────────────────
    if len(frames) >= 2:
        pts = [(f["x"], 0.0, f["z"]) for f in frames]
        m["travelM"] = round(_dist_xz(pts[0], pts[-1]), 3)
        m["pathM"] = round(sum(_dist_xz(a, b) for a, b in zip(pts, pts[1:], strict=False)), 3)
        m["straightness"] = round(m["travelM"] / m["pathM"], 3) if m["pathM"] > 1e-6 else None
        m["netX"] = round(frames[-1]["x"] - frames[0]["x"], 3)
        m["netZ"] = round(frames[-1]["z"] - frames[0]["z"], 3)
        m["yawDeltaDeg"] = round(_wrap_deg(math.degrees(frames[-1]["yaw"] - frames[0]["yaw"])), 1)
        m["yawAbsDeg"] = round(abs(m["yawDeltaDeg"]), 1)
        mx = sum(f["x"] for f in frames) / len(frames)
        mz = sum(f["z"] for f in frames) / len(frames)
        m["swayRangeM"] = round(max(math.hypot(f["x"] - mx, f["z"] - mz) for f in frames), 3)
    else:
        m.update(travelM=None, pathM=None, straightness=None, netX=None, netZ=None,
                 yawDeltaDeg=None, yawAbsDeg=None, swayRangeM=None)

    # ── hips height (sit/stand, squat) ────────────────────────────
    hips_y = [f["world"]["hips"][1] for f in frames
              if f.get("world") and f["world"].get("hips")]
    if hips_y:
        m["hipsYMin"] = round(min(hips_y), 3)
        m["hipsYMax"] = round(max(hips_y), 3)
        m["hipsYRangeM"] = round(max(hips_y) - min(hips_y), 3)
    else:
        m.update(hipsYMin=None, hipsYMax=None, hipsYRangeM=None)
    if check["id"] == "sit-stand" and len(segments) == 2:
        stand0 = [f["world"]["hips"][1] for f in segments[0]["frames"][:30]
                  if f.get("world") and f["world"].get("hips")]
        sit = [f["world"]["hips"][1] for f in segments[0]["frames"][-45:]
               if f.get("world") and f["world"].get("hips")]
        stand1 = [f["world"]["hips"][1] for f in segments[1]["frames"][-30:]
                  if f.get("world") and f["world"].get("hips")]
        if stand0 and sit:
            m["sitDropM"] = round(sum(stand0) / len(stand0) - min(sit), 3)
        else:
            m["sitDropM"] = None
        if stand0 and stand1:
            m["standRecoveryM"] = round(abs(sum(stand1) / len(stand1) - sum(stand0) / len(stand0)), 3)
        else:
            m["standRecoveryM"] = None

    # ── hands (wave, reach) ───────────────────────────────────────
    def hand_amp(name, seg_list):
        ps = [f["world"][name] for s in seg_list for f in s["frames"]
              if f.get("world") and f["world"].get(name)]
        if len(ps) < 2:
            return None
        xs, ys, zs = zip(*ps, strict=True)
        return round(math.sqrt((max(xs) - min(xs)) ** 2 + (max(ys) - min(ys)) ** 2
                               + (max(zs) - min(zs)) ** 2), 3)

    m["leftHandAmpM"] = hand_amp("leftHand", segments)
    m["rightHandAmpM"] = hand_amp("rightHand", segments)
    if check["id"] == "reach" and len(segments) == 2:
        # amplitude of the hand on the side being reached toward, per segment
        a = hand_amp("leftHand", [segments[0]])
        b = hand_amp("rightHand", [segments[1]])
        m["leftHandAmpM"] = a
        m["rightHandAmpM"] = b
        m["handSymmetry"] = round(min(a, b) / max(a, b), 3) if a and b and max(a, b) > 1e-6 else None
    else:
        m["handSymmetry"] = None

    # ── feet (contact, slide, lift) ───────────────────────────────
    lowest = [f["foot"]["lowest"] for f in frames
              if f.get("foot") and f["foot"].get("lowest") is not None]
    if lowest:
        lowest.sort()
        m["footMinY"] = round(lowest[0], 3)
        m["footP5Y"] = round(lowest[max(0, len(lowest) // 20)], 3)
    else:
        m.update(footMinY=None, footP5Y=None)

    slide = 0.0
    for a, b in zip(frames, frames[1:], strict=False):
        for side in ("leftFoot", "rightFoot"):
            ya = a.get("foot", {}).get(side) if a.get("foot") else None
            pa = a.get("world", {}).get(side) if a.get("world") else None
            pb = b.get("world", {}).get(side) if b.get("world") else None
            if ya is not None and ya < CONTACT_EPS_M and pa and pb:
                slide += _dist_xz(pa, pb)
    m["footSlideM"] = round(slide, 3) if frames else None

    lifts = []
    for f in frames:
        if f.get("foot"):
            lf, rf = f["foot"].get("leftFoot"), f["foot"].get("rightFoot")
            if lf is not None and rf is not None:
                lifts.append(abs(lf - rf))
    m["footLiftM"] = round(max(lifts), 3) if lifts else None

    # ── dance (per-phrase segments) ───────────────────────────────
    if len(segments) > 1 or check.get("sequence_file"):
        seg_metrics = [segment_frames_metrics(s["frames"]) for s in segments]
        m["segments"] = seg_metrics
        moved = 0
        counted = 0
        for sm in seg_metrics:
            if sm.get("frames", 0) < 2 or idle_floor_rate is None:
                continue
            counted += 1
            rate = sm.get("hipsRateMedianDegS") or 0
            if (sm.get("pathM", 0) >= 0.15 or abs(sm.get("yawDeltaDeg", 0)) >= 15
                    or rate >= max(2 * idle_floor_rate, idle_floor_rate + 10)):
                moved += 1
        m["phraseCompletionPct"] = round(100 * moved / counted, 1) if counted else None
        qt = [abs(sm.get("yawDeltaDeg", 0)) for s, sm in zip(segments, seg_metrics, strict=True)
              if "quarter-turn" in s.get("label", "")]
        m["quarterTurnYawDeg"] = round(sum(qt) / len(qt), 1) if qt else None

    return m


def eval_assertion(a, metrics):
    """Score one assertion against the metrics. Returns a result dict."""
    r = {"metric": a["metric"], "op": a["op"], "pass": a.get("pass"),
         "partial": a.get("partial"), "basis": a.get("basis", "")}
    value = metrics.get(a["metric"])
    r["value"] = value
    if value is None or a.get("pass") is None:
        r["verdict"] = "unmeasured"
        r["score"] = None
        return r
    op, p = a["op"], a["pass"]
    part = a.get("partial")
    if op == ">=":
        ok, mid = value >= p, part is not None and value >= part
    elif op == "<=":
        ok, mid = value <= p, part is not None and value <= part
    elif op == "between":
        ok = p[0] <= value <= p[1]
        mid = part is not None and part[0] <= value <= part[1]
    elif op == "==":
        ok, mid = value == p, False
    else:
        raise ValueError(f"unknown op {op!r}")
    r["verdict"] = "pass" if ok else ("partial" if mid else "fail")
    r["score"] = {"pass": 1.0, "partial": 0.5, "fail": 0.0}[r["verdict"]]
    return r


def score_check(check, metrics):
    results = [eval_assertion(a, metrics) for a in check.get("assertions", [])]
    scored = [r["score"] for r in results if r["score"] is not None]
    if not scored:
        verdict, score = "unmeasured", None
    else:
        score = sum(scored) / len(scored)
        verdict = "pass" if score >= 0.999 else ("partial" if score >= 0.5 else "fail")
    return {"id": check["id"], "category": check["category"], "level": check["level"],
            "verdict": verdict, "score": score, "assertions": results, "metrics": metrics}


def score_run(check_results):
    """Category + overall rollup per GEVS_SPEC §Score model."""
    cats = {}
    for c in check_results:
        cats.setdefault(c["category"], []).append(c)
    categories = {}
    for name, checks in sorted(cats.items()):
        scored = [c["score"] for c in checks if c["score"] is not None]
        categories[name] = {
            "score": round(100 * sum(scored) / len(scored), 1) if scored else None,
            "checks": [c["id"] for c in checks],
            "unmeasured": [c["id"] for c in checks if c["score"] is None],
        }
    cat_scores = [v["score"] for v in categories.values() if v["score"] is not None]
    overall = round(sum(cat_scores) / len(cat_scores), 1) if cat_scores else None
    return {"categories": categories, "overall": overall}
