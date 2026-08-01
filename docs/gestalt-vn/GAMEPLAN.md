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

### 3. Phase D3 — kanban class + approval tier — IN FLIGHT
- Gate: t_b1e9fad0 (rei F2 counter-replay FAIL) must close + rei re-verify
- Spec current: specs/D3_KANBAN_APPROVAL_TIER_SPEC.md (F3/F5/live-proof folded in)
- `kanban_create` lease (self-assigned tasks only)
- Approval tier: anything bigger (code, deletes, config) routes to Josh via the approval UI
- G8 (josh gate) implemented as the human-approval path

### 4. Phase D4 — graduation — SPEC READY
- Spec: specs/D4_GRADUATION_SPEC.md (journal-based checklist, scorecard
  section, widening protocol, rollback drills)
- Enable per operator after a week of clean journals each
- Widen lease classes deliberately, one at a time

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
- B0 confirm profile-driven loft in browser, commit (embryo already landed)
- B1 live transport: specs/EMB_LIVE_TRANSPORT_SPEC.md READY
- B2 canonical semantics: specs/EMB_CANONICAL_SEMANTICS_SPEC.md READY
- B3 studio MVP (graduate debug tooling) → B4 world ownership → B5 parity
  harness → B6 essence → loft motion slice
- Parked: advanced IK, animation studio, motion library, scene studio,
  creator SDK (trigger: B1–B6 stable)

### 8. Graph layer (someday)
- Operational knowledge graph: kanban + contracts + essence as traversable
  nodes ("why is Rei stressed" = a graph walk)
- mnemosyne↔cognee alignment; record-ontology patterns for memory hygiene

## Housekeeping (fill gaps)
- VN conflict bubble: surface real reason (stale-runtime vs active-stream)
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
