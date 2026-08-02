# GEVS run — tai-embodiment-v3 — 2026-08-02T08:03:20

- profile: `tai-embodiment-v3` (vrm `/api/hyrax/assets/tai.embodiment.vrm`)
- git: `4b6dd1df` (dirty tree)
- service: `ws://192.168.0.17:8791/ws` (contract `1.0.0`; model/history budget: unknown (not exposed through the loft telemetry))
- overall score: **99.3**

| category | score |
|---|---|
| balance | 95.8 |
| dance | 100 |
| foot-contact | 100 |
| hands | 100 |
| locomotion | 100 |
| turning | 100 |

| check | level | category | verdict | score | key metrics |
|---|---|---|---|---|---|
| idle | 1 | balance | pass | 1 | travelM=0.034, yawDeltaDeg=-1.7, livePct=100, streamResets=0, navAbsorbs=0, maxLeanEmaDeg=3.8, footP5Y=-0.024 |
| walk-forward | 1 | locomotion | pass | 1 | travelM=0.309, yawDeltaDeg=24.5, livePct=100, streamResets=0, navAbsorbs=17, maxLeanEmaDeg=4.2, footP5Y=-0.026 |
| walk-backward | 1 | locomotion | pass | 1 | travelM=2.182, yawDeltaDeg=58.7, livePct=100, streamResets=0, navAbsorbs=28, maxLeanEmaDeg=7.8, footP5Y=-0.041 |
| strafe-left | 1 | locomotion | pass | 1 | travelM=1.633, yawDeltaDeg=12.8, livePct=100, streamResets=0, navAbsorbs=28, maxLeanEmaDeg=5.9, footP5Y=-0.082 |
| strafe-right | 1 | locomotion | pass | 1 | travelM=0.644, yawDeltaDeg=-58.9, livePct=100, streamResets=0, navAbsorbs=25, maxLeanEmaDeg=5.2, footP5Y=-0.073 |
| turn-90 | 1 | turning | pass | 1 | travelM=0.293, yawDeltaDeg=147.8, livePct=100, streamResets=0, navAbsorbs=4, maxLeanEmaDeg=4.9, footP5Y=-0.023 |
| sit-stand | 1 | balance | pass | 1 | travelM=0.404, yawDeltaDeg=71.3, livePct=86.7, streamResets=0, navAbsorbs=11, maxLeanEmaDeg=16.2, footP5Y=-0.17, phraseCompletionPct=100 |
| wall-absorb | 1 | locomotion | pass | 1 | travelM=0.593, yawDeltaDeg=44.1, livePct=100, streamResets=0, navAbsorbs=52, maxLeanEmaDeg=10, footP5Y=-0.081 |
| shuffle | 2 | dance | pass | 1 | travelM=0.408, yawDeltaDeg=63.6, livePct=100, streamResets=0, navAbsorbs=96, maxLeanEmaDeg=5.9, footP5Y=-0.038, phraseCompletionPct=100 |
| wave | 2 | hands | pass | 1 | travelM=0.144, yawDeltaDeg=-32.8, livePct=100, streamResets=0, navAbsorbs=0, maxLeanEmaDeg=4, footP5Y=-0.013 |
| reach | 2 | hands | pass | 1 | travelM=0.002, yawDeltaDeg=-76.9, livePct=100, streamResets=0, navAbsorbs=0, maxLeanEmaDeg=3.1, footP5Y=-0.021, phraseCompletionPct=100 |
| squat | 2 | balance | pass | 1 | travelM=0.024, yawDeltaDeg=104.9, livePct=100, streamResets=0, navAbsorbs=0, maxLeanEmaDeg=12.1, footP5Y=-0.175 |
| balance-one-foot | 2 | balance | partial | 0.83 | travelM=0.197, yawDeltaDeg=37.6, livePct=100, streamResets=0, navAbsorbs=0, maxLeanEmaDeg=7.8, footP5Y=-0.024 |
| foot-contact | 1 | foot-contact | pass | 1 | travelM=0.176, yawDeltaDeg=52.7, footP5Y=-0.073 |

## Assertions and thresholds

### idle (pass)

| metric | value | op | pass | partial | verdict | basis |
|---|---|---|---|---|---|---|
| livePct | 100 | >= | 95 | 80 | pass | baseline 100% |
| maxLeanEmaDeg | 3.8 | <= | 6 | 10 | pass | baseline 3.3° |
| swayRangeM | 0.026 | <= | 0.1 | 0.2 | pass | baseline 0.055 m |
| streamResets | 0 | <= | 0 | — | pass | idle must never reset the stream |

### walk-forward (pass)

| metric | value | op | pass | partial | verdict | basis |
|---|---|---|---|---|---|---|
| pathM | 4.543 | >= | 1.5 | 0.8 | pass | baseline walked path in 12 s: 4.14 / 1.68 / 9.23 m over 3 runs (net travel 0.25–3.40 m — stochastic heading + wall absorb, evidence only) |
| streamResets | 0 | <= | 0 | 1 | pass | walk inside the room must not reset the stream (a single stochastic stream teleport, observed 1 in ~50 check-windows, recovers via the T2 crossfade → partial) |
| livePct | 100 | >= | 95 | 80 | pass | baseline 100% |

### walk-backward (pass)

| metric | value | op | pass | partial | verdict | basis |
|---|---|---|---|---|---|---|
| pathM | 12.178 | >= | 2 | 1 | pass | baseline walked path in 12 s: 3.11 / 5.27 m |
| streamResets | 0 | <= | 0 | 1 | pass | walk inside the room must not reset the stream (a single stochastic stream teleport, observed 1 in ~50 check-windows, recovers via the T2 crossfade → partial) |
| livePct | 100 | >= | 95 | 80 | pass | baseline 100% |

### strafe-left (pass)

| metric | value | op | pass | partial | verdict | basis |
|---|---|---|---|---|---|---|
| pathM | 6.759 | >= | 2 | 0.8 | pass | baseline walked path in 12 s: 7.61 / 0.83 (started at the wall) / 9.28 m |
| streamResets | 0 | <= | 0 | 1 | pass | 12 s at ≈0.55 m/s may touch the room bound; treadmill absorb must keep resets at 0 (a single stochastic stream teleport, observed 1 in ~50 check-windows, recovers via the T2 crossfade → partial) |
| livePct | 100 | >= | 95 | 80 | pass | baseline 100% |

### strafe-right (pass)

| metric | value | op | pass | partial | verdict | basis |
|---|---|---|---|---|---|---|
| pathM | 5.204 | >= | 2.5 | 1 | pass | baseline walked path in 12 s: 4.48 / 7.82 / 8.96 m |
| streamResets | 0 | <= | 0 | 1 | pass | treadmill absorb must keep resets at 0 (a single stochastic stream teleport, observed 1 in ~50 check-windows, recovers via the T2 crossfade → partial) |
| livePct | 100 | >= | 95 | 80 | pass | baseline 100% |

### turn-90 (pass)

| metric | value | op | pass | partial | verdict | basis |
|---|---|---|---|---|---|---|
| yawAbsDeg | 147.8 | between | [45, 240] | [20, 300] | pass | baseline |yaw delta| 169.9° / 155.1° / 79.0° over 3 runs — magnitude AND sign vary (model turned right once); brackets bound 'turned a meaningful fraction of a turn, did not spin, did not freeze' |
| streamResets | 0 | <= | 0 | — | pass | turn in place must not reset the stream |

### sit-stand (pass)

| metric | value | op | pass | partial | verdict | basis |
|---|---|---|---|---|---|---|
| sitDropM | 0.25 | >= | 0.1 | 0.05 | pass | baseline 0.157 m hips drop (shallow sit at T1) |
| standRecoveryM | 0.006 | <= | 0.25 | 0.4 | pass | baseline 0.159 m |final − initial| hips Y |
| streamResets | 0 | <= | 0 | — | pass | sit/stand must not reset the stream |

### wall-absorb (pass)

| metric | value | op | pass | partial | verdict | basis |
|---|---|---|---|---|---|---|
| streamResets | 0 | <= | 0 | 1 | pass | BREAK-GUARD: sustained slide hits the room bound ≈7 s in; without treadmill absorb the residual clamp resets the stream every ~2 s (14 in 65 s measured pre-fix) (a single stochastic stream teleport, observed 1 in ~50 check-windows, recovers via the T2 crossfade → partial) |
| navAbsorbs | 52 | >= | 1 | — | pass | baseline 78 / 42 / 50 absorb events at the boundary |
| livePct | 100 | >= | 95 | 80 | pass | baseline 100% — stream stays live dancing at the wall |

### shuffle (pass)

| metric | value | op | pass | partial | verdict | basis |
|---|---|---|---|---|---|---|
| phraseCompletionPct | 100 | >= | 90 | 60 | pass | baseline 100% of 10 phrases in both runs showed measurable motion (path ≥0.15 m or |yaw| ≥15° or hips rate ≥2× idle floor) |
| quarterTurnYawDeg | 99.6 | between | [20, 220] | [10, 300] | pass | baseline mean |yaw| of the quarter-turn phrases: 127.9° / 25.9° across runs — the model's quarter turn is unreliable at T1 (finding, documented); brackets still catch 'never turned' (<10°) and 'spun' (>300°) |
| streamResets | 0 | <= | 0 | — | pass | no phrase may reset the stream |
| livePct | 100 | >= | 95 | 80 | pass | baseline 100% |

### wave (pass)

| metric | value | op | pass | partial | verdict | basis |
|---|---|---|---|---|---|---|
| rightHandAmpM | 0.95 | >= | 0.6 | 0.3 | pass | baseline 1.07 m right-hand world range |
| maxLeanEmaDeg | 4 | <= | 8 | 12 | pass | no explosion: baseline 3.6° |
| streamResets | 0 | <= | 0 | — | pass | wave must not reset the stream |

### reach (pass)

| metric | value | op | pass | partial | verdict | basis |
|---|---|---|---|---|---|---|
| leftHandAmpM | 0.899 | >= | 0.4 | 0.2 | pass | baseline 0.74 m left-hand range on reach-left |
| handSymmetry | 0.623 | >= | 0.5 | 0.3 | pass | baseline 0.73 min/max hand amplitude across the two reach segments |
| streamResets | 0 | <= | 0 | — | pass | reach must not reset the stream |

### squat (pass)

| metric | value | op | pass | partial | verdict | basis |
|---|---|---|---|---|---|---|
| hipsYRangeM | 0.729 | >= | 0.5 | 0.25 | pass | baseline 0.81 m hips range squat→stand |
| footSlideM | 2.603 | <= | 3 | 5 | pass | baseline 1.94 m foot XZ slide while in ground contact (feet skate at T1 — known wrongness, measured not hidden) |
| streamResets | 0 | <= | 0 | — | pass | squat must not reset the stream |

### balance-one-foot (partial)

| metric | value | op | pass | partial | verdict | basis |
|---|---|---|---|---|---|---|
| footLiftM | 0.017 | >= | 0.03 | 0.01 | partial | baseline raised-foot peak 0.057 / 0.036 / 0.038 / 0.012 m over 4 runs — the T1 model often barely lifts (unreliable behavior, documented); brackets catch 'no lift at all' (0.007 m measured with the rejected prompt phrasing) |
| maxLeanEmaDeg | 7.8 | <= | 11 | 16 | pass | baseline 6.4–8.9°; sanity-gate drift EMA trips at 12° |
| streamResets | 0 | <= | 0 | — | pass | balance must not reset the stream |

### foot-contact (pass)

| metric | value | op | pass | partial | verdict | basis |
|---|---|---|---|---|---|---|
| footP5Y | -0.073 | >= | -0.12 | -0.2 | pass | baseline p5 of lowest foot-bone Y across the whole run: -0.074 m (mild floor penetration at T1 — measured, not hidden) |
| footMinY | -0.24 | >= | -0.3 | -0.45 | pass | baseline min lowest foot-bone Y: -0.21 m (worst-frame penetration during sit/squat) |

