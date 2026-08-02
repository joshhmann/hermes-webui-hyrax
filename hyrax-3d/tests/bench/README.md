# GEVS — Gestalt Embodiment Validation Suite (bench harness)

GEVS measures embodiment correctness (locomotion, turning, hands, foot
contact, dance, balance) as probe metrics against thresholds — pass /
partial / fail with numbers, never "looks about right."
Spec: `docs/gestalt-vn/specs/GEVS_SPEC.md`.

**This harness is NOT part of `npm test`.** It needs the live
gestalt-motion service and a headless browser; it streams real motion for
several minutes. `npm test` lists its unit-test files explicitly, so
nothing here runs in unit runs.

## Layout

- `gevs.py` — runner: starts an isolated WebUI (throwaway
  `HERMES_HOME`/state dir, no API keys), mounts the loft in headless
  Chromium via Playwright, plays each check's prompt schedule through
  `window.__ardy.setPrompt`, samples telemetry (2 Hz) + per-frame probe
  (root XZ/yaw, bone quats + world positions, foot heights), scores, and
  writes `gevs-report.json` + `gevs-report.md` + per-check stills.
- `gevs_checks.py` — metric computation + assertion scoring (pure
  functions, no I/O).
- `sequences/level1.json`, `sequences/level2.json` — Level 1/2 checks as
  DATA: prompt schedule + assertions/thresholds. Each threshold carries a
  `basis` note recording the measured baseline value it was derived from.
- `sequences/shuffle.json` — the shortened shuffle sequence (step R×2,
  step L×2, heel R, heel L, quarter turn, ×2) as prompt list + timing.
- `out/` — run output (gitignored; promote reports into `docs/gestalt-vn/gevs/`).

## Requirements

- System `python3` with Playwright (`playwright` package + Chromium
  headless shell). The repo `.venv` does not carry Playwright; use the
  interpreter that does.
- The embodiment bundle built from current sources:
  `npm run build` in `hyrax-3d/` (output goes to `static/hyrax/3d/`).
- The gestalt-motion service reachable (default upstream
  `ws://192.168.0.17:8791/ws`; override with `HYRAX_ARDY_WS_UPSTREAM`).

## Invocation

```bash
cd hyrax-3d
python3 tests/bench/gevs.py                       # full Level 1 + Level 2 (~8 min)
python3 tests/bench/gevs.py --checks level1       # Level 1 only
python3 tests/bench/gevs.py --checks wall-absorb  # single check
python3 tests/bench/gevs.py --out /tmp/gevs-run --label "scratch"
```

Exit code: 0 = no failing checks, 1 = at least one FAIL, 2 = setup failure.
Reports land in `tests/bench/out/<timestamp>/` unless `--out` is given.

## Safety

- The WebUI runs with a throwaway state dir in `/tmp` and all `*_API_KEY`
  vars stripped; nothing touches real `~/.hermes` state.
- The harness only sends prompt strings through the normal proxied
  WebSocket — no service configuration is read or changed on the upstream.
- Threshold calibration: run once with uncalibrated thresholds (assertions
  report UNMEASURED with the measured values), then set pass/partial from
  those numbers with headroom and record the basis. Never invent thresholds.

## Break-guard

`wall-absorb` guards the treadmill-absorb subsystem
(`ArdyMotionSource.TELEPORT_RESIDUAL_M` fold): disabling the absorb makes
the sustained slide reset the stream every ~2 s and the check FAILs.
Proof run: `docs/gestalt-vn/gevs/break-guard-2026-08-02/`.
