# Hyrax Division Gameplan (2026-07-28)

Where we are, what's next, and what gates what. Update as phases land.

## Done (as of today)

- **Essence Phase A** — essenced: deterministic mood/activity derivation (no LLM), derived_state.json per operator, supervised daemon
- **Phase B** — derived state drives VN presentation (sprites, poses, scenes)
- **Phase C** — proactive outreach: wants → policy gate → in-character messages on WebUI + Discord DM. Live for all four operators
- **Phase D1** — shadow autonomy: irritation accumulators → wants → real proposals → delivered as messages asking permission. Zero execution
- **Phase D2** — live execution, free tier: docs_wiki_notes lease, essenced governor-pilot approval, rollback-first executor, dual-lane report-backs. rei QA PASS + hyrax-os governance endorse (2026-07-31)
- **D3-prep** — D2 review findings fixed: lease lifecycle (lease_used/expire_leases/executed_count), state continuity + password fail-fast, canonical marker hash, F3 attempt-counting + F5 wiki root. 264 tests green (2026-08-01)
- **Embodiment P3 embryo** — loft retarget unified on tai-embodiment-v3 profile (same AvatarRetargeter as debug page; parity 0.116° max); ARDY WS proxy through WebUI (works over Tailscale/cellular); three-vrm v3 combineSkeletons fix (2026-08-01)
- **Mood-to-voice** — tone descriptors + pre_llm_call injection: state colors how they speak, not just how they look
- **Memory** — cognee fleet-wide (remember/recall tools), mnemosyne consolidation for all four, usage rules in every skill
- **Role skills** — reasoning-protocol (shared) + tai/nei/rei/mai role protocols; division work cycles documented
- **Infra** — upstream merged (v0.52.152), hermes v0.19, ds4-flash optimized with fallbacks

## The arc ahead (in order)

### 1. Watch week (now → ~1 week)
Let D1 + outreach run. Track:
- Proposal quality (are Mai's wants sensible? too many? too few?)
- Outreach cadence (quiet hours holding? caps right? double-texting?)
- Cognee invocation (do they actually call remember/recall?)
- Voice feel (tone matching state?)
Tune thresholds from the journals, not from vibes.

### 2. ~~Phase D2 — live execution, free tier~~ DONE
(rei QA PASS + hyrax-os endorse 2026-07-31; findings fixed in D3-prep)

### 3. ~~Phase D3 — kanban class + approval tier~~ DONE
(rei QA PASS t_df2cea32 + hyrax-os ENDORSE WITH CONDITIONS t_ca56b34d,
2026-08-01; kanban_create live for mai, G8 josh tier live via WebUI
approvals API, 290 essenced tests; 5 conditions filed as t_8fc662dc,
gate D4)

### 4. Phase D4 — graduation — MAI GRADUATED (2026-08-03)
- Josh signed off: mai is the division's first graduated operator
  (8d clean streak, 16 proposals, 12/12 executions, 8/12 report-backs,
  zero anomalies — scorecard `eligible`)
- tai/rei/nei enabled for SHADOW proposals 2026-08-03 (autonomy.enabled;
  execution remains mai-only) — their evidence clocks are running;
  each graduates after their checklist passes (≥3 proposals, clean week)

### 5. Whims layer + Mai's playground
- Sims-style object-wants: per-operator decks from personality + events
  ("Nei wants to reorganize the index", "Tai wants to show off the thing")
- **Mai's LXC playground** as the first true autonomy lease: she tinks
  because she wants to, not because a cron says so. Sandboxed, hers,
  zero blast radius, journal says what she was feeling when she made it

### 6. Voice (TTS)
- Emotional TTS provider; tone descriptors already feed it
  (derived state → tone → VN expression + voice inflection + TTS emotion)
- Speech-to-text after that (full voice loop)

### 7. Embodiment platform (formerly "ARDY Phase 6+") — UNPARKED
- Roadmap: specs/EMBODIMENT_PLATFORM_ARCHITECTURE.md (codex proposal + kimi
  amendments: semantic canonical layer, explicit transport phase, world
  ownership, validation-as-you-go, behavior slice pulled forward)
- Done: B0 profile-driven runtime ✓ B1 transport ✓ B2 semantic layer ✓
  T1 drift fix ✓ T2 crossfades ✓ sanity gate ✓ treadmill absorb ✓
  GEVS v1 (Tai 99.3) ✓ reflex layer ✓ scene manifest ✓
- Spatial stack order (josh 2026-08-02: polish before expansion):
  goal planner (t_0ae02818, in flight) → essence-driven goals →
  THEN expand the 3D space (multi-room, minimap/war-room view)
- Parked: advanced IK, animation studio, motion library, scene studio,
  creator SDK, minimap overlay (trigger: layers proven on GEVS)

### 8. Graph layer (someday)
- Operational knowledge graph: kanban + contracts + essence as traversable
  nodes ("why is Rei stressed" = a graph walk)
- mnemosyne↔cognee alignment; record-ontology patterns for memory hygiene

## Housekeeping (fill gaps)
- ~~VN conflict bubble: surface real reason~~ DONE (8f483f69 — bounded reason + composer recovery)
- rei's Discord 403 scope
- Matrix homeserver 502 storm
- WebUI password rotation (plaintext in unit, 0.0.0.0 bind)
- Hermex mobile app check (native iOS cockpit exists now)

## Hard rules (all phases)
- Hermes stays stock; extension points only (plugins, config, services)
- essenced writes only its covenant files
- essenced never authors message content
- Shadow before live, always; a week of clean journals before any widening
- Backup before touching Hermes state
