# Hyrax Division Gameplan (2026-07-28)

Where we are, what's next, and what gates what. Update as phases land.

## Done (as of today)

- **Essence Phase A** — essenced: deterministic mood/activity derivation (no LLM), derived_state.json per operator, supervised daemon
- **Phase B** — derived state drives VN presentation (sprites, poses, scenes)
- **Phase C** — proactive outreach: wants → policy gate → in-character messages on WebUI + Discord DM. Live for all four operators
- **Phase D1** — shadow autonomy: irritation accumulators → wants → real proposals → delivered as messages asking permission. Zero execution
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

### 2. Phase D2 — live execution, free tier
Gate: ~1 week of clean D1 proposals.
- Lease class: `docs_wiki_notes` (whitelisted roots, backup-first, rollback marker before action)
- essenced approves free-tier proposals (first real caller of approve_proposal)
- Every action journaled + report-back message ("i fixed the thing, here's why it annoyed me")
- Rate limit 2/operator/day; revocation = lease suspension

### 3. Phase D3 — kanban class + approval tier
- `kanban_create` lease (self-assigned tasks only)
- Approval tier: anything bigger (code, deletes, config) routes to Josh via the approval UI
- G8 (josh gate) implemented as the human-approval path

### 4. Phase D4 — graduation
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

### 7. ARDY / embodiment (Phase 6+)
- Parked, docs ready (output contract, reconciliation, corrections)
- P6 streaming architecture → P7 blending → P8 proof-of-concept
- GPU fleet idle; unpark on demand

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
