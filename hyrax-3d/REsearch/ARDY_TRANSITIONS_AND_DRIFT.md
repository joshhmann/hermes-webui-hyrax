# ARDY drift and smooth prompt transitions — research report

**Date:** 2026-08-01 · **Status:** research only, no code changes
**Scope:** why the live ARDY stream drifts on long rollouts, what upstream
(NVIDIA nv-tlabs/ardy) actually does differently, and our ranked options for
smooth prompt transitions. Builds on `REsearch/deep-research-report.md`
(retargeting audit) and `REsearch/Kimodo_ARDY_MotionBricks_with_VRM_Guide.md`;
does not re-derive them.

Local code cited:
- service: `/root/workspace/ardy-bridge/gestalt-ardy-service/` (`ardy_runner.py`, `main.py`, `session.py`)
- upstream: `/root/workspace/ardy-bridge/ardy/` (nv-tlabs/ardy clone, 2026-07-24)
- client: `/root/workspace/ardy-bridge/gestalt-motion/src/`
- loft consumer: `hyrax-3d/src/embodiment/motion/ArdyMotionSource.ts`

---

## TL;DR

1. The drift is best explained by **self-conditioning feedback**: our service
   retains up to **9.6 s of the model's own generated output** as conditioning
   history (`ardy_runner.py:27,131-137,236`), while NVIDIA's interactive demo
   defaults to **4 frames (0.2 s)** of history (`loading.py:188-192`, README:
   "History Crop Length … default: min"). Every chunk also round-trips that
   entire history through the FSQ motion tokenizer (encode → denoise → decode),
   so each 0.4 s step re-quantizes ~9.6 s of already-degraded features and
   conditions the next step on the result. Training clips were ≤10 s
   ([paper §5.1](https://arxiv.org/html/2607.08741v1)); a 200 s rollout with a
   history window full of self-generated content is far outside the training
   distribution. Nothing in the loop measures plausibility, so a small lean
   bias compounds monotonically — exactly the measured 3°→12°→27°→40-55° curve.
2. Upstream's answer to prompt changes is **replanning, not appending**: on new
   input the demo *discards generated-but-unplayed frames* and regenerates from
   the current playhead + a tiny replan buffer (~1 frame)
   (`generation.py:157-178,364-398`; paper §4.1, Fig. 5). Our service never
   discards — it appends chunk-by-chunk up to 3.2 s ahead and keeps all of it
   in history. `set_prompt` retaining drifted history
   (`ardy_runner.py:166-177`) is therefore doubly wrong vs. upstream practice.
3. Highest-leverage fixes are cheap: **shorten the history budget**, **reset
   (or shrink) history on prompt change**, and **crossfade across the reset
   boundary client-side** using the existing 0.3 s ramp instead of hard-cutting.
   The fully smooth option — service-side **warm-start via ARDY's native
   keyframe-constraint channel** (`motion_mask`/`observed_motion`, currently
   passed as `None` at `ardy_runner.py:224-225`) — is real but a larger build.
4. Kimodo is **not** a live-session replacement (2–5 s per ≤10 s clip); it is
   viable only as an offline/asynchronous clip-queue generator with
   keyframe-stitched transitions, and needs a different retarget profile
   (somaskel77 vs Core27).

---

## 1. How ARDY conditions new output on history

### 1.1 The mechanism (upstream source)

ARDY denoises **hybrid tokens** = explicit root features (global pelvis
position + cos/sin heading) + latent body tokens from a causal FSQ
autoencoder, patch size P=4 frames (paper §3.1–3.2, §3.5). One
`Ardy.autoregressive_step()` call:

- takes `init_history_sequence` — the **normalized explicit feature tensor**
  of previously generated frames, length a multiple of `num_frames_per_token`
  (`ardy/model/ardy_model.py:606-613`; contract `ARDY_OUTPUT_CONTRACT.md` §2.14);
- encodes it into hybrid form and **recenters the root so the last history
  frame sits at the origin** (`_encode_init_history`, `ardy_model.py:367-396`;
  `_recenter_history`, `:334-365`) — this is the built-in re-canonicalization
  of root translation, and the paper credits it for "high-quality motion with
  smooth temporal transitions" (§4.1);
- denoises `gen_horizon_len` new frames (8 for core8 = 0.4 s at 20 fps) from
  pure noise, conditioned on the history tokens + text embedding
  (`_generate_window`, `ardy_model.py:398-529`; new tokens are *appended* to
  the history sequence at `:518-529`);
- requantizes the latent body tokens (`requantize=True`, `:655-660`) and
  converts everything back to explicit features for the caller.

The caller keeps the tail of the returned explicit features as the next
call's history. Attention/window budget: 10 s of frames
(`scripts/interactive_demo/loading.py:180-186`; paper §4.1 says "up to a
maximum of 8 seconds — a limit established by the longest context observed
during training" — the 8 s/10 s discrepancy is noted, unverified which bound
the checkpoint was actually trained with).

### 1.2 What our service does

`ArdyRunner` (`gestalt-ardy-service/ardy_runner.py`):

- `HISTORY_BUDGET_S = 10.0` (`:27`); capacity = 10 s·fps − horizon, rounded to
  a token multiple (`:131-137`) = **192 frames ≈ 9.6 s** for core8 (nfpt=4 per
  paper §3.5; not read from a local checkpoint config — see Unverified).
- After every chunk: `self._history = samples[:, -capacity:]` (`:234-236`) —
  i.e. history is **the model's own decoded-and-re-encoded output**, always at
  maximum length.
- `set_prompt` re-encodes the text embedding and sets a reset flag but
  **keeps `_history`** (`:166-177`) — the new prompt chains off whatever the
  rollout has become.
- `request_reset` drops history and re-anchors at the last emitted root x/z +
  heading (`:179-184`, anchors maintained at `:258-270`) — this is the only
  escape, and it works (~30 s of sanity) because it breaks the feedback loop.
- The producer generates continuously, up to `send_queue` depth = 8 chunks
  ≈ **3.2 s ahead of playback** (`main.py:89-98`, `session.py:21`); those
  ahead-of-play frames are already baked into history when a prompt changes.
- No constraint channel used (`motion_mask=None, observed_motion=None`,
  `:224-225`), no MotionCorrection post-process.

### 1.3 What upstream's interactive demo does differently

| Aspect | nv-tlabs/ardy interactive demo | gestalt-ardy-service |
|---|---|---|
| History length | **default = 1 patch (4 frames, 0.2 s)**, slider up to 10 s−horizon (`loading.py:188-192`) | always ~9.6 s (`ardy_runner.py:131-137`) |
| On prompt change | **replan**: discard all generated-unplayed frames beyond `frame_idx + replan_buffer`, regenerate from playhead (`generation.py:157-178`, splice at `:364-398`) | keep everything; append-only; new prompt chains off up to 3.2 s of unplayed, possibly drifted future |
| Replan buffer | 0 frames (4-step) / 1 frame (10-step) (paper §4.1) | up to 8 chunks ≈ 3.2 s queued (`session.py:21`) |
| History content at step N | mostly *played back* motion (≤ buffer of unplayed) | 100% self-generated content, max length |
| Post-process | optional MotionCorrection foot-skate/root-margin pass (`generation.py:292-341`, `ardy/postprocess.py`) | none |

Upstream's own README guidance for the demo
([nv-tlabs/ardy README](https://github.com/nv-tlabs/ardy), GUI Reference):
*"Smaller history crop length facilitates faster adaptation to new prompts and
kinematic constraints, while larger history crop length allows for longer
context which helps complex semantic motion generation and smoother
transitions."* — i.e. for prompt transitions they explicitly trade context for
responsiveness, and the interactive default is the minimum.

---

## 2. Why the generator drifts

Ranked hypotheses (mechanism-level; only H1/H2 are directly evidenced by code
divergence — attribution percentages would need an experiment, see §6):

- **H1 — exposure bias with maximal self-history.** Training conditions each
  window on ≤10 s clips of *ground-truth* mocap (paper §5.1); at inference we
  condition on 9.6 s of the model's *own* output. Any systematic bias (a small
  forward-lean tendency) is fed back as "this is what standing looks like" and
  amplified next window. This is the classic autoregressive train/inference
  mismatch and it scales with history length — our history is ~48× the
  upstream interactive default.
- **H2 — repeated FSQ transcode of the whole history.** Every chunk, all 192
  history frames go explicit→hybrid-encode→denoise→decode→explicit
  (`ardy_model.py:367-396,655-690`), including an FSQ requantization step
  (`:655-660`). Like re-JPEGing an image 2.5×/second, each round-trip can
  inject small perturbations that then become conditioning. The demo's 4-frame
  history transcodes almost nothing per step.
- **H3 — root recentering handles translation but not orientation/body.**
  `_recenter_history` re-anchors root x/z each window, and heading is
  re-derived — but nothing corrects *pitch/roll* (the measured hips lean) or
  body-latent degradation. Root *wander* (±25 m by t≥200 s) is consistent with
  velocity-bias accumulation between recenters; the lean is pure body/root-
  orientation drift with no corrective term anywhere in the loop.
- **H4 — contributing, not causal:** fixed `cfg_weight=(2.0,2.0)`
  (`ardy_runner.py:55`) and the checkpoint default denoising steps; no
  MotionCorrection. Upstream issue
  [#9](https://github.com/nv-tlabs/ardy/issues/9) shows *body-denoiser* INT8
  quantization "failed 13/24 long-horizon comparisons" — if the deployed
  container ever quantizes the denoiser (our service only quantizes the text
  encoder, `encoder.py`), that would independently worsen long rollouts.
  Unverified for the live deployment.
- **Not supported as primary cause:** text-encoder quantization (INT8 encoder
  motion error in issue #9 is small for "rest"); the retarget/client path
  (drift is measured on the raw stream before retarget).

The ~30 s of sanity after a hard reset fits H1/H2: after `request_reset`
(`ardy_runner.py:179-184`) history regrows from 0, so self-conditioning
feedback needs ~75 chunks (30 s × 2.5 chunks/s) to re-accumulate a visible
bias.

**Is it a known upstream issue?** No public drift report exists: a GitHub
issue search (`repo:nv-tlabs/ardy drift`) returns 0 hits, and the first 50
issues contain nothing on long-rollout degradation. Upstream mitigations are
implicit in their defaults (short history, replan-not-append) rather than
documented as a "drift fix".

---

## 3. What upstream recommends for prompt changes mid-session

There is no explicit "prompt transition" doc. The de-facto practice, from the
demo and paper §4.1 ("Latency-Aware Replanning", Fig. 5):

1. Trigger a replan **immediately** on new input (`generation.py:135-155`).
2. Keep history only up to `frame_idx + replan_buffer` (buffer ≈ 0–1 frames);
   **discard all further generated frames** (`generation.py:364-398` —
   `motion_tensor = cat(motion[:, :history_end+1], new[:, history_len:])`).
3. Use a **short history crop** when fast adaptation matters (README GUI ref).
4. The transition stays smooth because the new window's first frames continue
   from the *currently displayed* pose — the model itself does the
   "inbetweening" since its history is the on-screen motion.

Our service violates (2) and (3): it appends and keeps max history. Note the
`reset` flag we send on prompt change (`ardy_runner.py:166-177`) tells the
*client* not to interpolate — but the *model* is still chaining off the old
history, so the discontinuity is real, not just presentational.

---

## 4. Options for smooth transitions, ranked by effort

### Tier 1 — config-level, hours. Do first.

**T1a. Shorten the history budget.** Make `_history_capacity()` return e.g.
0.5–2 s (20–40 frames) instead of 9.6 s, or expose `ARDY_HISTORY_S`.
Directly attacks H1/H2; matches upstream's interactive default ethos. Cost:
per the README trade-off, less context for complex multi-action prompts
("walk, then pick up, then walk" needs history to know where it is). For an
idle/gesture avatar this is nearly free. *Expected: drift onset moves from
~80 s to many minutes or disappears; prompt adaptation gets faster.*

**T1b. Reset (or shrink) history on `set_prompt`.** Change `set_prompt` to
drop `_history` (or slice it to ≤1 s) so a new prompt never chains off drifted
conditioning — this is the service-side half of what the client's
prompt-triggered `sendReset()` (`ArdyMotionSource.ts:439-456`) already
approximates. Pair with T2a so it doesn't read as a cut.

**T1c. More denoising steps.** `ARDY_DENOISING_STEPS=10` (paper: 63 ms vs
33 ms per window, "slightly improved control accuracy"). Still real-time at
2.5 chunks/s. Cheap to A/B; may reduce per-step noise feeding H1.

**T1d. Try the Horizon40 checkpoint (`ARDY_MODEL=core`).** 5× fewer
autoregressive steps per second ⇒ 5× fewer feedback/transcode round-trips and
2 s coherent chunks. Cost: prompt latency up to ~2 s worse and 2 s chunk
latency to hide — the client buffer already tolerates depth. A/B against T1a.

### Tier 2 — client-side smoothing, ~a day. Hides all remaining discontinuity.

**T2a. Crossfade across reset chunks instead of hard-cutting.** Today a reset
chunk clears `ChunkBuffer` (`ChunkBuffer.ts:101-111`), `PoseSampler` hard-cuts
(`PoseSampler.ts:57-72`), and ownership changes ramp the fixed 0.3 s
crossfade (`ArdyMotionSource.ts:107,574-575`). Change: on reset, keep the last
sampled pose as a held "outgoing" pose and ramp `blendWeight` 0→1 over
0.4–0.8 s into the new stream (the ramp machinery and the `lastSample` hold
already exist — this is policy, not new machinery). Use a longer ramp for
prompt transitions than for stale recovery. This alone converts every
reset/transition — including T1b's history reset and drift-gate releases —
from a cut into a blend. Game-animation equivalent: a one-transition blend
tree; we do not need the full tree.

**T2b. Hold-last-pose + blend-in on drift release** already effectively exists
via the stale crossfade to ProceduralLocomotion; with T2a's longer,
direction-aware ramp it will feel intentional instead of abrupt.

### Tier 3 — service-side true continuity, days. The "real" fix.

**T3a. Warm-start prompt transitions with native keyframe constraints.** ARDY
natively accepts `motion_mask`/`observed_motion` — full-body keyframes, root
waypoints — including *inside* the generation horizon
(`ardy_model.py:447-466`, demo `constraints.py`, paper §3.4). On prompt change:
inject the last K emitted frames (or a decaying blend of them) as observed
constraints at the start of the new window, with a fresh/short history. The
model then *generates the transition itself* — this is inbetweening through
the model, the same mechanism Kimodo uses for multi-prompt stitching. Effort:
constraint-mask plumbing in `ArdyRunner` (mirroring demo
`compute_constraint_mask`), a canonical-features encode of the held pose, and
protocol work if the client should supply the held pose. Risk: constraints
from a *drifted* pose must be sanity-clamped first (we have the gate metrics
to do that).

**T3b. Scheduled soft resets.** Proactively `request_reset()` every N seconds
(30–60) during stable idle, hidden by T2a's crossfade — bounds worst-case
drift instead of waiting for the gate. Trivial once T2a exists; keeps long
history affordable if T1a's context loss matters.

**T3c. MotionCorrection post-process** (`ardy/postprocess.py`, foot-skate +
root margin) — quality polish, not drift; include if foot skate becomes the
next visible artifact.

### Tier 4 — architecture change, week+. Only if Tier 1–3 underdeliver.

**T4. Kimodo clip-queue.** Generate 5–10 s clips asynchronously (2–5 s each on
a 3090-class GPU), sequence them with Kimodo's native multi-prompt transition
support and full-body keyframe stitching ([kimodo README](https://github.com/nv-tlabs/kimodo)
— "parameters related to transitions in multi-prompt sequences"; guide §6).
No drift by construction (no autoregressive chaining), highest motion quality.
Cost: no frame-level reactivity (a prompt takes ~one clip-length to engage),
a second model + text encoder in VRAM, and a new retarget profile — Kimodo
ships **somaskel77**, whose joint semantics collide with Core27
(`LeftLeg` = thigh in SOMA, knee in Core27; guide §3.2).

---

## 5. Does Kimodo suit interactive long-running sessions?

Not as the live driver. It is explicitly positioned by NVIDIA as the
**offline** authoring counterpart to ARDY
([ARDY README "Related work"](https://github.com/nv-tlabs/ardy), and
[project page](https://research.nvidia.com/labs/sil/projects/ardy/)):
whole-clip parallel diffusion, ~100 DDIM steps default, 2–5 s per ≤10 s clip
(RTX 3090-class; [guide §1.1], [Pebblous summary](https://blog.pebblous.ai/blog/kimodo-text-to-motion/en/)).
At 20 fps that is 40–100× slower than frame time with no streaming mode.
Where it *does* fit: a background clip synthesizer whose output is queued,
retargeted offline, and blended — i.e. T4, trading reactivity for quality and
zero drift. Its keyframe-constraint channel is also the design reference for
T3a's warm-start.

---

## 6. Recommendation — what to build next

In order:

1. **T1a + T1b together** (one service change): history budget ~1 s
   (configurable), and `set_prompt` drops/truncates history. Verify against
   the live drift metric: lean EMA should stay < 5° for ≥ 10 min on "a person
   stands idle". Also confirm `TEXT_ENCODER_QUANT`/`ARDY_DENOISING_STEPS` on
   the deployment, and A/B T1c (`=10`).
2. **T2a** (client): crossfade-over-reset with a ~0.5 s ramp. This makes (1)
   invisible and also fixes the abrupt drift-gate releases the user is
   complaining about — highest perceived-quality-per-effort item in the list.
3. If drift still appears on multi-minute horizons: **T3b** (scheduled soft
   resets, invisible after T2a) — cheap insurance that caps worst case.
4. If prompt transitions still feel model-awkward rather than cut-awkward:
   **T3a** warm-start constraints — the principled fix, reusing ARDY's native
   inbetweening.
5. Keep **T4 (Kimodo)** as the quality-ceiling escape hatch for non-reactive
   content (emotes, pre-authored idles), not for the live loop.

**Suggested drift-attribution experiment** (if we want proof of H1 vs H2
before tuning): capture `_history` features + lean angle per chunk at history
budgets {4, 40, 192} frames on a fixed prompt/seed. If drift rate scales with
budget → H1/H2 confirmed and T1a is the fix; if flat → look at H4
(quantization/steps) instead. `next_chunk_debug()` (`ardy_runner.py:196-202`)
already exposes the raw tensors for this.

---

## 7. Sources

Web:
- ARDY paper: [arXiv:2607.08741](https://arxiv.org/html/2607.08741v1) — §3 method, §4.1 test-time operation/replanning, §5.1 training data (≤10 s clips).
- [nv-tlabs/ardy README](https://github.com/nv-tlabs/ardy) — History Crop Length guidance; Kimodo/MotionBricks positioning.
- [nv-tlabs/ardy issue #9](https://github.com/nv-tlabs/ardy/issues/9) — quantization field report (body-denoiser INT8 fails long-horizon).
- [nv-tlabs/kimodo](https://github.com/nv-tlabs/kimodo) — multi-prompt transition parameters; offline CLI.
- [NVIDIA ARDY project page](https://research.nvidia.com/labs/sil/projects/ardy/).
- [Pebblous Kimodo summary](https://blog.pebblous.ai/blog/kimodo-text-to-motion/en/) — 2–5 s/clip latency figure.

Local:
- `gestalt-ardy-service/ardy_runner.py:27,55,131-137,166-184,221-236,258-270` — history budget, set_prompt/reset, chunk loop.
- `gestalt-ardy-service/main.py:89-98`, `session.py:21` — producer runs ≤8 chunks (3.2 s) ahead.
- `ardy/scripts/interactive_demo/generation.py:157-178,263-289,364-398` — upstream history crop + replan/discard + splice.
- `ardy/scripts/interactive_demo/loading.py:180-198` — 10 s window budget; history default = min (1 patch).
- `ardy/ardy/model/ardy_model.py:334-396,518-529,606-690` — recentering, history append, autoregressive loop.
- `gestalt-motion/src/ChunkBuffer.ts:101-111,218-224`, `PoseSampler.ts:53-72` — reset clears buffer; hard cut on discontinuity.
- `hyrax-3d/src/embodiment/motion/ArdyMotionSource.ts:107-137,439-456,493-545,574-575` — 0.3 s crossfade, sanity gate, prompt-triggered reset.
- `ARDY_OUTPUT_CONTRACT.md` §2.13-2.15, §4 — chunk/history contract.
- `REsearch/Kimodo_ARDY_MotionBricks_with_VRM_Guide.md` §1.1-1.4, §3.2, §6 — Kimodo latency/positioning, skeleton collision, clip-transition recipe.

## 8. Could not verify

- `num_frames_per_token = 4` (paper §3.5 patch size P=4; no checkpoint
  `config.yaml` available locally). All history-second figures assume it.
- Whether the *deployed* service (LXC at 192.168.0.17:8791) runs
  `TEXT_ENCODER_QUANT=int8/int4` or a quantized denoiser — affects H4.
- Paper says max training context 8 s (§4.1) vs. 10 s window in code — which
  bound the released core8 checkpoint was actually trained with.
- The drift-cause attribution (H1/H2 vs H4) is mechanistic inference from code
  divergence, not an ablation — run the §6 experiment to confirm.
- GitHub issue sweep covered a `drift` keyword search + the 50 newest issues;
  older/closed issues with different wording could have been missed.
- Kimodo's 2–5 s latency is from secondary sources on an RTX 3090; not
  measured on our GPU.

---

## Motion Bricks addendum (2026-08-01)

Follow-up: how NVIDIA **MotionBricks** composes and transitions motion, and
what it changes about the T1–T4 ranking above. Builds on the summary already
in `REsearch/Kimodo_ARDY_MotionBricks_with_VRM_Guide.md` §1.3.

### A. What MotionBricks is

[MotionBricks](https://nvlabs.github.io/motionbricks/) (SIGGRAPH 2026,
[arXiv:2604.24833](https://arxiv.org/html/2604.24833v1), same NVIDIA SIL team
as ARDY/Kimodo — Rempe, Zhao, Petrovich are co-authors of all three) is a
**real-time motion in-betweening framework**, positioned explicitly as the
answer to animation-graph scalability (the paper's motivating stat: an
Assassin's Creed state machine manages ~15,000 clips / 5,000 states /
12 nested levels). Two layers:

1. **Neural backbone** — a conditional multi-head **VQ-VAE tokenizer**
   (T frames → T/4 discrete tokens, K codebooks along the feature dim), a
   **root module** that first predicts *timing* (how many frames the
   transition needs, 4-frame resolution, up to 64) then an initial root
   trajectory, a **pose module** (masked-token transformer; one forward pass
   usually suffices at inference), and a **decoder** that emits
   `{root, positions, rotations, velocities, contacts}` and further refines
   the root (paper §4–5). Segments are 12–64 frames at 30 fps.
   Throughput **~15,000 fps, ~2 ms per in-between** — ~30× faster inference
   than ARDY's 33–63 ms/window.
2. **Smart primitives** — a high-level behavior layer that converts user
   commands/game events into **target keyframes**: *smart locomotion*
   (velocity/heading/style → proxy keyframes on a progressively refined root
   trajectory) and *smart objects* (interactions → intent keyframes anchored
   to object pivots). All primitives speak one **unified keyframe interface**
   to the backbone; new behaviors are zero-shot, no fine-tuning or tagging
   (paper §6).

### B. How it composes and transitions — the parts that matter to us

- **Every segment is an in-between.** Context keyframes (the character's
  *actual current state*, first ~4 frames) + 1–4 target keyframes from the
  primitives; the backbone generates the segment between them (paper §3,
  Algorithm 1). There is no free-running autoregressive history at all —
  **each replan re-anchors on the real played state**, so error cannot
  compound across segments. This is the structural opposite of ARDY's
  self-conditioning history loop diagnosed in §2 above, and the strongest
  external validation that our drift is an architecture-level property of
  unbounded self-history, not "diffusion models drift."
- **Transitions are generated, not blended.** Style changes (idle→walk→run,
  zombie→stealth) are done by *placing style keyframes sampled from short
  reference clips* onto the trajectory and letting the backbone adapt them to
  context. The authors explicitly credit two things for smooth style
  transitions: a backbone trained on diverse skills, and **periodic replanning
  so output never locks rigidly to arbitrarily placed keyframes** (paper
  §6.1). The UE5 demo claims "no foot-locking, no blending, no hand-authored
  transitions."
- **Soft vs hard keyframes.** Each keyframe set carries a **drop-frame
  attribute τ**: τ=0 = hard constraint (must reach the pose — used for
  contacts), τ>0 = soft guidance (may depart up to τ frames early — used for
  preparation/exit poses) (paper §6.2). This is exactly the knob our T3a
  warm-start needs: a sanity-clamped held pose should be a *soft* constraint,
  not a hard one.
- **The model picks transition duration.** The root module predicts the
  in-between frame count (with bit-masking for valid counts), so transition
  length is content-aware rather than a fixed crossfade window (paper §5.1).
- **Progressive root refinement** (paper §6.1, Table 1): naive velocity
  extrapolation → **critically damped spring** smoothing
  (`r(t)=e^{-γt}((r0-r1)+(v0+γ(r0-r1))t)+r1`, Eq. 6) → root-module refinement
  → decoder refinement. The spring stage is cheap, model-independent, and
  directly transplantable into our client root path.
- **Replan discipline** (Algorithm 1): replan when commands change *or* the
  future buffer runs low — the same latency-aware replanning pattern ARDY's
  demo uses (§3 above), confirming that "replan-from-playhead, discard stale
  future" is NVIDIA's standard runtime pattern across both models.

### C. Availability and fit vs. ARDY (verified 2026-08-01)

- **Release state:** preview inside
  [GR00T-WholeBodyControl/motionbricks](https://github.com/NVlabs/GR00T-WholeBodyControl/tree/main/motionbricks)
  (initial release 2026-04-27). Ships **G1-robot checkpoints only**
  (`out/G1-clip.ckpt`, VQVAE/pose/root ckpts), a MuJoCo keyboard demo
  (WASD velocity + style hotkeys), and a **synthetic-data** training
  pipeline; the full training pipeline "fully embedded in GR00T" is still an
  unchecked roadmap item ("approximately one month out"). **No human-skeleton
  checkpoint is shipped**, though the paper's 350k dataset is the same
  700 h / 27-joint Bones Rigplay corpus ARDY-Core trains on (paper Table 2),
  so a Core27-compatible backbone exists internally.
- **No text channel.** Control is keyframes/velocity/style only — text is not
  a conditioning modality anywhere in the paper. Our essence layer currently
  speaks *prompts* ("wave at the door", "look embarrassed"); driving
  MotionBricks would require a text→keyframe/style mapping (they mention
  "neurally generated keyframes on the fly" as supported but ship no such
  model).
- **No streaming server / web path.** The demo is local MuJoCo; the output
  contract (`{r,p,q,v,c}` runtime buffer) would need a GCP1-style adapter
  like the one we built for ARDY. The authors themselves rate runtime
  retargeting "fast but low-quality" (guide §1.3).
- **Latency/interactivity:** strictly better than ARDY on paper (2 ms vs
  33–63 ms per segment; 30 fps vs 20 fps; richer control via keyframes), and
  structurally drift-immune (context = actual state, never model history).

### D. Impact on the T1–T4 ranking

**Ranking unchanged at the top; T3a strengthened; one new T5 added; T4
narrowed but not obsoleted.**

- **T1 (short history / reset-on-prompt) and T2 (client crossfade-over-reset):
  unchanged, still do first.** MotionBricks does not run our loft today; the
  ARDY fixes remain the cheapest path to a stable stream.
- **T3a (warm-start via ARDY constraint channel): upgraded from "principled
  fix" to "validated pattern."** MotionBricks industrializes precisely our
  T3a — context keyframes from the current pose + target intent + model
  fills the transition. It also hands us three design refinements to copy:
  (1) make the held pose a **soft** constraint (their τ>0 drop-frame) since it
  may be mid-drift; (2) let the model choose transition duration where the
  API allows rather than fixing a window; (3) keep periodic replanning so
  constraints never ossify.
- **T2 gains a cheap add-on: critically damped spring root smoothing**
  (paper Eq. 6) inside `RootMotionAdapter`/navigation for transition and
  drift-release moments — model-independent, a few lines, standard
  motion-matching practice.
- **T4 (Kimodo clip-queue): narrowed, not obsoleted.** Conceptually
  MotionBricks is the better composition engine for the live loop; practically
  it cannot replace Kimodo for the *non-reactive pre-authored* niche, because
  Kimodo today ships a text-to-motion CLI, a human skeleton (somaskel77), and
  native multi-prompt transitions, while MotionBricks ships no text channel
  and no human checkpoint. T4 stays as "offline clip synthesis for
  emotes/idles," now with a note that its transitions should follow
  MotionBricks' keyframe-stitching recipe.
- **New T5 — adopt the MotionBricks split as our behavior architecture
  (and track the full release).** Two parts:
  - *T5a (design, near-term):* treat our essence/behavior layer as a **smart
    primitive**: its job is to emit *intent* (style, held poses, gesture
    targets, navigation goals) that a motion layer turns into
    constraints — not to micromanage transitions. Transitions belong to the
    generator (T3a) or the crossfade machinery (T2), never to hand-authored
    state changes. This matches the paper's core claim that behavior systems
    should be "fully connected motion graphs with neural transitions."
  - *T5b (watch-and-evaluate, months):* if the full GR00T release ships a
    human (27-joint) MotionBricks checkpoint, evaluate it as an **ARDY
    successor for the live loop**: same Bones Rigplay data foundation, ~30×
    faster inference, drift-immune anchoring, native in-betweening. The
    blockers to re-check at that time: no text conditioning (our prompts
    would need a text→keyframe adapter, or we keep ARDY for text gestures and
    use MotionBricks for locomotion/interaction), a GCP1/websocket serving
    wrapper to write, and a new retarget profile (their skeletons: G1-34 /
    27-joint Rigplay — the latter may reuse our Core27 contract nearly
    as-is). For a mostly idle/gesture loft, note the modality mismatch cuts
    both ways: ARDY's text channel is genuinely the better fit for
    prompt-driven gestures; MotionBricks' keyframe channel is the better fit
    for navigation and object interaction.

**Bottom line:** MotionBricks does not change what we build next (T1→T2→T3
stands). It confirms the diagnosis (anchor every transition to the real
current state; never condition unboundedly on model output), upgrades T3a
from hypothesis to industry-validated pattern with concrete knobs (soft τ,
predicted timing, periodic replan), adds a cheap spring-smoothing tweak to
T2, and becomes the leading candidate to succeed ARDY in the live loop once a
human-skeleton release exists — it does not replace Kimodo's offline niche
today.

### E. Sources (addendum)

- [MotionBricks project page](https://nvlabs.github.io/motionbricks/) — claims, release status, demo scope.
- [MotionBricks paper, arXiv:2604.24833](https://arxiv.org/html/2604.24833v1) — §3 Algorithm 1 (replan loop, in-betweening constraints), §4 (multi-head VQ-VAE tokenizer), §5 (root module timing prediction), §6.1 (spring root smoothing Eq. 6, style keyframes, replan-driven transitions), §6.2 (drop-frame τ soft/hard keyframes), Table 2 (350k/70k Bones Rigplay datasets, 27 joints).
- [GR00T-WholeBodyControl/motionbricks README](https://github.com/NVlabs/GR00T-WholeBodyControl/tree/main/motionbricks) — preview contents (G1 checkpoints, MuJoCo demo, synthetic training data, roadmap checkbox still open as of 2026-08-01).
- `REsearch/Kimodo_ARDY_MotionBricks_with_VRM_Guide.md` §1.3 — prior local summary incl. the authors' runtime-retargeting quality caveat.

### F. Could not verify (addendum)

- Whether the unreleased 350k/27-joint MotionBricks backbone matches ARDY's
  Core27 skeleton exactly (joint count and dataset match; joint *layout* not
  confirmed against a shipped asset).
- MotionBricks' 2 ms/15,000 fps figures are the authors' claims on their
  hardware; not benchmarked by us.
- Whether a text-conditioning layer for MotionBricks exists internally
  ("neurally generated keyframes" is mentioned without detail).
- The "~1 month" full-release timeline is from the April/May roadmap; no
  update was found confirming or slipping it.
