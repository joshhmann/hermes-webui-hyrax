# Phase 3 — Runtime Retarget Refactor

## Goal

Replace the hardcoded `SomaVrmRetargeter.js` with a **generic, profile-driven retargeter** that reads from a calibration profile JSON. The profile is no longer a validation artifact — it is the runtime configuration that drives every avatar.

## Motivation

Currently, retargeting knowledge is split across two places:

| Knowledge | Where it lives |
|---|---|
| Bone maps (soma30, cskel27) | `SomaVrmRetargeter.js` hardcoded |
| Solve order | `SomaVrmRetargeter.js` hardcoded |
| VRM parent hierarchy | `SomaVrmRetargeter.js` hardcoded |
| Rest offsets | computed per-frame in `SomaVrmRetargeter.js` |
| Ground contact params | hardcoded in `SomaVrmRetargeter.js` |
| SOMA77 canonical | nowhere — lost |
| Avatar calibration | `calibration-profiles/tai-embodiment-v3.json` |
| Profile-driven retarget logic | duplicated in `calibrate.js` (Phase 2) |

**Phase 3 consolidates**: one `AvatarRetargeter` class, one calibration profile per avatar, zero hardcoded skeleton knowledge.

## Architecture

```
AvatarRetargeter.js            ← NEW: canonical retargeter, reads profile
SomaVrmRetargeter.js           ← DEPRECATED (thin wrapper for backward compat)
calibrate.js                   ← imports AvatarRetargeter, removes internal duplicate
ardy.html / ardy.js            ← optionally imports AvatarRetargeter with profile
calibration-profiles/*.json    ← unchanged — already the source of truth
```

### Data flow

```
calibration profile JSON
  ↓  (loaded once)
AvatarRetargeter instance
  ↓  (per-frame)
motion data (SOMA77)
  ↓
AvatarRetargeter.applyFrame(frame)
  ↓
VRM bone transforms + hips position
```

### AvatarRetargeter API

```js
import { AvatarRetargeter } from '../calibrate/AvatarRetargeter.js'

// Constructor — loads profile configuration into runtime state
const retargeter = new AvatarRetargeter(avatarVrm, calibrationProfile)

// Load or swap motion data
retargeter.setMotion(motionData)

// Retarget one frame to the avatar
retargeter.applyFrame(frame, {
  groundY: 0,               // ground plane Y for foot lock
  contactSmoothing: 0.4,    // lowpass for ground correction
})

// Batch: iterate frames without per-frame overhead
retargeter.applyBatch(frameStart, frameCount)

// Streaming: signal chunk boundary (resets ground correction)
retargeter.onReset()

// Inspection: read back the retargeted state
retargeter.getBoneQuaternion(boneName)  // world-space quaternion
retargeter.getHipsPosition()            // world-space Vector3
retargeter.getBoneErrors()              // per-bone error metrics if validation mode
```

### AvatarRetargeter internals

The class maintains:

```
constructor(vrm, profile):
  - Store VRM reference
  - Extract solveOrder, boneMap, vrmParent from profile
  - Build jointName → index lookup from the motion's joint list
  - Initialize rest offset cache
  - Compute hips scale from VRM world Y / profile.hipsHeight

setMotion(motion):
  - Store motion.joints, motion.rot, motion.root, motion.parentIdx, motion.offsets
  - Cache jointIndex lookup table
  - Reset per-chunk state (groundCorrection)

applyFrame(frame):
  1. For each bone in solveOrder (parents before children):
     a. Compute source world quat W = srcWorldQuat(joint, frame)
     b. Apply rest offset: W × offset[bone]  (offset stored at init time)
     c. For non-hips: convert to local under VRM parent:
        localQ = parentW.inv() × W
     d. Write localQ to VRM bone node
  2. Hips position:
     a. Delta from frame 0: (root[frame] - root[0]) × hipsScale
     b. Write to VRM hips node position
  3. Ground contact: (same as current — contact-smoothing per foot)
  4. vrm.humanoid.update()
```

This is **identical** to the current profile-driven path in `calibrate.js` — just extracted into its own module.

## Migration path

### Step 1 — Extract AvatarRetargeter.js

- Move `buildProfileRetargeter()`, `applyProfileFrame()`, `srcWorldQuat()` and their helpers from `calibrate.js` into `AvatarRetargeter.js`
- Export the `AvatarRetargeter` class
- `calibrate.js` imports `AvatarRetargeter` instead of defining its own

### Step 2 — Replace calibrate.js internal retargeter

- `calibrate.js` uses `AvatarRetargeter` for the profile-driven path
- `SomaVrmRetargeter` stays as the reference path for comparison validation
- No behavior change — just import swap

### Step 3 — Update debug page (optional)

- `ardy.html` gets an option to load a calibration profile instead of using hardcoded maps
- When a profile is loaded, `ardy.js` uses `AvatarRetargeter` instead of `SomaVrmRetargeter`
- When no profile is loaded, `ardy.js` falls back to the hardcoded path (unchanged)

### Step 4 — Deprecate SomaVrmRetargeter.js

- Add deprecation notice to `SomaVrmRetargeter.js` header
- Reference `AvatarRetargeter` as the replacement
- No removal — hardcoded path still works for legacy

## Dead code / no longer needed

Once the migration is complete:

| Code | Status |
|---|---|
| `BONE_MAPS` in `SomaVrmRetargeter.js` | No longer read — profile is source |
| `SOLVE_ORDER` in `SomaVrmRetargeter.js` | No longer read — profile is source |
| `VRM_PARENT` in `SomaVrmRetargeter.js` | No longer read — profile is source |
| `buildProfileRetargeter()` in `calibrate.js` | Replaced by `AvatarRetargeter` |
| `applyProfileFrame()` in `calibrate.js` | Replaced by `AvatarRetargeter.applyFrame()` |
| `profileCtx` state object | Replaced by `AvatarRetargeter` instance |

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Debug page breaks during transition | Keep `SomaVrmRetargeter` as fallback until profile path is verified |
| Profile format changes | Profile schema is versioned (`"profile_version": "1.0"`); `AvatarRetargeter` validates on load |
| Performance regression | `AvatarRetargeter` is the same math as the current path — no new allocations per frame beyond what exists |
| Extracting code introduces bugs | `calibrate.js` keeps the reference retargeter path; validate against it after every change |

## Validation gate

Before considering Phase 3 complete:

1. `calibrate.js` Validate button shows **PASS** with profile-driven path using `AvatarRetargeter` vs reference path using `SomaVrmRetargeter`
2. `ardy.html` with profile shows same bone positions as without profile
3. No console errors in any page
4. `ardy.html` backward compat: cskel27 + somaskel captures work without a profile

## File map

```
NEW  hyrax-3d/calibrate/AvatarRetargeter.js   — 150-200 lines, the core
MOD  hyrax-3d/calibrate/calibrate.js           — imports AvatarRetargeter, drops duplicate
MOD  hyrax-3d/calibrate/calibrate.html         — unchanged (might add profile-based ardy link)
DEP  hyrax-3d/REsearch/kimodo-vrm-pipeline/SomaVrmRetargeter.js  — deprecation notice
OPT  hyrax-3d/debug/ardy.js                    — optional profile support
```

## What this enables

After Phase 3:

- **New avatar** → create a calibration profile → it works in the runtime. No code changes.
- **New motion source** → outputs SOMA77 → already works. No code changes.
- **Calibration Studio** → export a profile → it's immediately a runtime profile. No conversion step.
- **`SomaVrmRetargeter.js`** → can be removed when no code references it anymore.
