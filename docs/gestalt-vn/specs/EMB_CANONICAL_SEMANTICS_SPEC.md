# [SPEC] EMB-2 — Canonical Motion Semantics: semantic joints, not skeleton names

## Problem

The platform roadmap says "SOMA77 becomes the canonical motion language."
That is the riskiest sentence in the roadmap. "SOMA" is already not one
thing — the v3 profile ships maps for `somaskel30`, `soma77`, and
`somaskel77`, Kimodo switched to `somaskel77` in March 2026, and ARDY-SOMA
does not exist yet. Betting the canonical layer on any concrete joint list
means re-platforming every time a vendor revises a skeleton.

What profiles, retargeting, calibration, and the runtime actually depend on
is the **semantic vocabulary**: hips, spine, chest, upperChest, neck, head,
leftUpperArm… — the names in `skeleton_maps.*` of tai-embodiment-v3.json.
Concrete skeletons are carriers. This spec makes the semantic layer the
canonical contract and demotes every skeleton (cskel27, soma77, future) to a
source adapter. This is the shape `createCanonicalRetargeter` already has;
this spec makes it explicit and finishes the job.

## Definitions

- **Semantic joint vocabulary**: the VRM-humanoid-aligned names used as
  profile keys (22 core bones + optional fingers/extensions). Versioned as
  `semantic_v1`. Any semantic name a profile may use must exist in the
  vocabulary registry — profiles fail validation on unknown keys.
- **Source adapter**: per-skeleton module that maps `skeleton_id` →
  semantic joints + supplies hierarchy, rest offsets, frame decode, and
  FPS. Interface (already approximated in gestalt-motion):

```
interface MotionSkeletonAdapter {
  skeletonId: string                    // 'cskel27' | 'soma77' | ...
  semanticMap: Record<SemanticJoint, string | null>  // joint-name resolution
  hierarchy: SkeletonHierarchy
  restPose: SkeletonRestPose
  decodeFrame(frame: SourceFrame): CanonicalPoseFrame  // semantic-keyed
}
```

- **CanonicalPoseFrame**: semantic-joint-keyed pose (world rotation
  matrices + root) — the ONLY structure the retarget/calibration layers
  consume. Nothing downstream may contain a source joint name
  (`LeftUpLeg`, `Spine3`, …). Today boneMap.ts leaks this; the adapter
  boundary must absorb it.

## Current state (verified)

- `tai-embodiment-v3.json` already speaks semantic keys with per-skeleton
  maps (`skeleton_maps.cskel27`, `.somaskel30`, `.soma77_alias`,
  `.somaskel77_alias`) — the profile format is already semantic-first.
  Profile resolution order (ProfiledLiveRetargeter): exact skeleton_id key
  → `_alias` → first map whose joints all exist in the contract.
- `createCanonicalRetargeter(contract, vrmLike)` builds from the handshake
  contract — source-agnostic by construction.
- Leaks to fix: `gestalt-motion/src/boneMap.ts` (`ARDY_CORE27_TO_VRM`
  hardcoded, including the deprecated upperChest←Spine3 entry now superseded
  by the profile), and any downstream reference to cskel27 joint names
  outside the adapter/profile seam.

## Work items

1. **Semantic vocabulary registry** (`semantic_v1.json` in gestalt-motion or
   hyrax-3d/calibrate): the 22 core + extension slots, with per-joint
   metadata (parent constraints, mirror partner, optional/required).
   Profile validation consumes it.
2. **cskel27 adapter**: extract today's implicit mapping (contract +
   boneMap/profile resolution) into an explicit adapter module. Delete the
   hardcoded `ARDY_CORE27_TO_VRM` table; the profile is the map.
3. **soma77 adapter (preparation, not full build)**: define the adapter from
   the Kimodo SOMA research (hyrax-3d/REsearch/) — humanoid FK joints →
   semantic vocabulary, fingers where available, unsupported detail omitted
   by policy. Validated against recorded Kimodo captures offline (no ARDY
   dependency). This is the "build SOMA→VRM with Kimodo now, swap in
   ARDY-SOMA later" path from the research synthesis.
4. **Contract-version gate**: adapter selection keys off
   `skeleton_id + contract_version` (from EMB-1); unknown → fail closed.
5. **Profile schema bump**: `profile_version` semantics documented; a
   profile declares which semantic vocabulary version it targets; loader
   refuses mismatches fail-closed.

## Acceptance criteria

- [ ] No source-skeleton joint name appears outside adapter modules
      (grep-guard test: `LeftUpLeg|Spine3|cskel27` absent from
      retarget/calibration/runtime paths)
- [ ] `ARDY_CORE27_TO_VRM` deleted; cskel27 path runs through the adapter +
      profile with parity vs current behavior (parity harness: same capture,
      per-bone delta < 0.5°)
- [ ] soma77 adapter decodes a recorded Kimodo capture onto Tai's VRM
      offline; visual QA via debug page; hips-height measured per capture
      (profile note: "SOMA captures will differ")
- [ ] Unknown skeleton_id/contract_version → offline with reason, never
      guess (test)
- [ ] semantic_v1 registry validates tai-embodiment-v3.json clean; a
      profile with an unknown semantic key is rejected (test)
- [ ] Suites green: gestalt-motion 72+, hyrax-3d typecheck/build/tests

## Non-goals

- No full SOMA-X body model in the browser (mesh, skinning, correctives —
  we need skeleton contract + rest + hierarchy + pose + root/contacts only)
- No ARDY-SOMA support (doesn't exist; the adapter seam is the preparation)
- No new avatar formats (VRM remains the target; the VrmLike seam is where
  GLB/FBX would attach later)
- No runtime behavior changes beyond the adapter boundary

## Links

EMBODIMENT_PLATFORM_ARCHITECTURE.md (amendment 1), EMB_LIVE_TRANSPORT_SPEC.md,
hyrax-3d/REsearch/ (SOMA/Kimodo synthesis), tai-embodiment-v3.json,
/root/workspace/ardy-bridge/gestalt-motion/src/{boneMap,CanonicalRetargeter,calibrate}.ts
Assignee: tai or hx-coder | Reviewer: rei | Research input: existing REsearch docs
