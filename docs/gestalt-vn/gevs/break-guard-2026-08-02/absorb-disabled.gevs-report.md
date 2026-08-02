# GEVS run — tai-embodiment-v3 — 2026-08-02T08:07:04

- profile: `tai-embodiment-v3` (vrm `/api/hyrax/assets/tai.embodiment.vrm`)
- git: `4b6dd1df` (dirty tree)
- service: `ws://192.168.0.17:8791/ws` (contract `1.0.0`; model/history budget: unknown (not exposed through the loft telemetry))
- overall score: **66.7**

| category | score |
|---|---|
| foot-contact | 100 |
| locomotion | 33.3 |

| check | level | category | verdict | score | key metrics |
|---|---|---|---|---|---|
| wall-absorb | 1 | locomotion | fail | 0.33 | travelM=4.31, yawDeltaDeg=-100.2, livePct=100, streamResets=9, navAbsorbs=0, maxLeanEmaDeg=5.7, footP5Y=-0.081 |
| foot-contact | 1 | foot-contact | pass | 1 | travelM=4.313, yawDeltaDeg=-91.1, footP5Y=-0.081 |

## Assertions and thresholds

### wall-absorb (fail)

| metric | value | op | pass | partial | verdict | basis |
|---|---|---|---|---|---|---|
| streamResets | 9 | <= | 0 | 1 | fail | BREAK-GUARD: sustained slide hits the room bound ≈7 s in; without treadmill absorb the residual clamp resets the stream every ~2 s (14 in 65 s measured pre-fix) (a single stochastic stream teleport, observed 1 in ~50 check-windows, recovers via the T2 crossfade → partial) |
| navAbsorbs | 0 | >= | 1 | — | fail | baseline 78 / 42 / 50 absorb events at the boundary |
| livePct | 100 | >= | 95 | 80 | pass | baseline 100% — stream stays live dancing at the wall |

### foot-contact (pass)

| metric | value | op | pass | partial | verdict | basis |
|---|---|---|---|---|---|---|
| footP5Y | -0.081 | >= | -0.12 | -0.2 | pass | baseline p5 of lowest foot-bone Y across the whole run: -0.074 m (mild floor penetration at T1 — measured, not hidden) |
| footMinY | -0.109 | >= | -0.3 | -0.45 | pass | baseline min lowest foot-bone Y: -0.21 m (worst-frame penetration during sit/squat) |

