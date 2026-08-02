# GEVS — Gestalt Embodiment Validation Suite (v1)

Implementation of `docs/gestalt-vn/specs/GEVS_SPEC.md`. GEVS turns
embodiment wrongness (sliding feet, twisted hips, timing drift) into
measured per-category scores per avatar, comparable over time.

- Harness: `hyrax-3d/tests/bench/` (runner + scoring + check data; see its
  README for invocation details).
- Baseline (first subject): [`baseline-2026-08-02-tai-embodiment-v3/`](baseline-2026-08-02-tai-embodiment-v3/)
  — full report JSON + markdown + key stills.
- Break-guard proof: [`break-guard-2026-08-02/`](break-guard-2026-08-02/).

## Harness layout

| piece | path | role |
|---|---|---|
| runner | `hyrax-3d/tests/bench/gevs.py` | isolated WebUI (throwaway state, no API keys) + headless Chromium loft mount; plays each check's prompt schedule, samples telemetry (2 Hz) and a per-rAF probe, scores, writes `gevs-report.json` + `gevs-report.md` + per-check stills |
| scoring | `hyrax-3d/tests/bench/gevs_checks.py` | pure metric computation + assertion scoring (pass / partial / fail / UNMEASURED) |
| Level 1 data | `hyrax-3d/tests/bench/sequences/level1.json` | idle, walk fwd/back, strafe L/R, turn 90°, sit→stand, wall-absorb |
| Level 2 data | `hyrax-3d/tests/bench/sequences/level2.json` | shuffle, wave, reach L/R, squat, one-foot balance |
| shuffle data | `hyrax-3d/tests/bench/sequences/shuffle.json` | step R×2, step L×2, heel R, heel L, quarter turn — ×2; prompt list + timing only |

The suite is **not** part of `npm test` (the npm script lists its unit
files explicitly): it needs the live gestalt-motion service and streams
real motion for ~8 minutes.

Loft seams the harness uses (all in the uncommitted embodiment work this
lands on, plus two additions made for GEVS):

- `__ardy.getTelemetry()` — `residualResetCount`, `navAbsorbCount`,
  `gate.{leanEmaDeg,rootYEma,hold}`, `groundCorrectionM` (agent-75)
- `__ardy.footWorldY()` — per-bone foot/toe world Y (agent-75)
- `__ardy.poseProbe(bones)` — root XZ/yaw + bone quats, **extended by GEVS
  with per-bone world positions** (hand amplitude, foot slide)
- `__ardy.recenterRoot(x, z)` — **added by GEVS**: re-anchors the stream
  origin at a clear floor spot (`ArdyMotionSource.recenterRoot`, same
  anchor machinery as session start — no stream reset), giving every
  displacement check a deterministic start position

## Checks and thresholds (v1)

Thresholds were **measured first** (5 full runs on 2026-08-02), then set
with headroom; every assertion in the sequence JSONs carries a `basis`
string recording the measured values. Two calibration findings shaped the
metrics:

1. **Net travel is not a deterministic property at T1.** The stream's
   heading is stochastic (a 12 s walk measured 0.25–3.40 m net across
   runs, 1.7–9.2 m path) and the room bounds absorb motion. Locomotion is
   therefore scored on **walked path length** (catches "no locomotion"),
   with net travel / straightness recorded as evidence.
2. **Turn magnitude and sign vary run to run** (a requested 90° measured
   +169.9°, +155.1°, −79.0°). Turn checks score |yaw| inside wide honest
   brackets that still catch "never turned" and "spun".

Checks: `idle` (lean/sway), `walk-forward`, `walk-backward`,
`strafe-left`, `strafe-right` (path, resets, live%), `turn-90` (|yaw|),
`sit-stand` (hips drop + recovery), `wall-absorb` (break-guard: 25 s
sustained slide into the room bound must produce **0 stream resets** and
≥1 nav absorbs), `shuffle` (phrase completion %, quarter-turn yaw),
`wave`, `reach` (hand amplitude, symmetry), `squat` (hips range, foot
slide), `balance-one-foot` (foot lift, lean), and a run-wide
`foot-contact` aggregate (lowest foot-bone Y p5/min vs the floor).

## Tai's baseline — tai-embodiment-v3, 2026-08-02

Full report: `baseline-2026-08-02-tai-embodiment-v3/gevs-report.md`
(git `4b6dd1df` + uncommitted embodiment work, service
`ws://192.168.0.17:8791/ws`, contract `1.0.0`).

| category | score |
|---|---|
| locomotion | 100 |
| turning | 100 |
| hands | 100 |
| foot-contact | 100 |
| dance | 100 |
| balance | 95.8 |
| **overall** | **99.3** |

13/14 checks pass; `balance-one-foot` is an honest **partial** (0.83):
the T1 model often barely lifts the free foot (peak 0.057 / 0.036 /
0.038 / 0.012 m across 4 runs — unreliable behavior, measured and
documented, not hidden).

Known wrongness the baseline makes visible (follow-ups, not v1 gates):

- feet penetrate the floor: run-wide lowest-foot p5 −0.074 m, min −0.21 m;
- feet skate during ground contact in squats (1.94 m of contact slide);
- the model's quarter turn is unreliable (25.9°–127.9° for 90°).

## Break-guard proof

`wall-absorb` guards the treadmill-absorb subsystem
(`ArdyMotionSource.TELEPORT_RESIDUAL_M` fold). Proof
(`break-guard-2026-08-02/`):

1. Scratch edit `TELEPORT_RESIDUAL_M` 1.0 → 0.0 (absorb disabled),
   rebuild the bundle, run `--checks wall-absorb`.
2. **FAIL** (score 0.33): 9 stream resets in 25 s — matching the
   pre-fix prediction of a reset every ~2 s — and 0 nav absorbs; runner
   exit code 1 (`absorb-disabled.gevs-report.json`).
3. Restore, rebuild, re-run: **PASS** (1.0), 0 resets
   (`absorb-restored.gevs-report.json`).

## Invocation

Manual/nightly (CI hook is future work):

```bash
cd hyrax-3d && npm run build           # bundle must match the sources under test
python3 tests/bench/gevs.py            # full L1+L2, ~8 min, exit 1 on any FAIL
python3 tests/bench/gevs.py --checks level1
python3 tests/bench/gevs.py --checks wall-absorb
```

Requirements: system `python3` with Playwright + Chromium headless shell;
the gestalt-motion service reachable (`HYRAX_ARDY_WS_UPSTREAM` overrides
the default `ws://192.168.0.17:8791/ws`). The harness only sends prompts
through the proxied WebSocket — it never changes service configuration —
and runs the WebUI against a throwaway state dir.

## Follow-ups

- **Level 3** needs scene objects the loft doesn't have yet (pick up cube,
  push button, open door) plus probe seams for object contact — blocked
  on `GESTALT_INTERACTABLES_SPEC.md`.
- **CI hook**: the suite is CI-shaped (exit codes, JSON report) but needs
  a reachable motion service in CI (service stub or a LAN runner) and a
  Playwright image; until then it runs manually/nightly.
- **Model/service identity**: the report records the upstream URL and
  contract version; the service model + history budget are not exposed
  through loft telemetry (recorded as `unknown`) — worth a service
  `/meta` field for reproducibility.
- Turn-precision and foot-lift reliability are model-quality findings for
  the motion team (see baseline report), not harness bugs.
- Cha-cha embryo scripts promoted from `/tmp` into the harness; the
  originals (`/tmp/chacha_*`, `/tmp/contacts_sniff.mjs`) can be deleted.
