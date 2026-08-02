# Operator Onboarding Checklist

How to add a new operator (profile) to the division stack — every touchpoint,
in dependency order. Status 2026-08-01: each layer is data-driven where noted;
two registries are still code constants (marked CODE). Budget: ~1 hour + assets.

## 0. Hermes profile (base)

- [ ] Create profile: `hermes profile create <name>` (or clone an existing
      profile dir and adjust). Profile dir: `/root/.hermes/profiles/<name>/`
- [ ] `config.yaml`: model block (`default: deepseek-v4-flash`,
      `provider: opencode-go`, `reasoning_effort: max` under `agent:`),
      credential_pool_strategies
- [ ] `auth.json`: opencode-go credential pool entries — every entry needs
      `base_url: https://opencode.ai/zen/go/v1` (the 2026-08-01 hx-worker
      crash loop was a missing base_url on the priority-0 entry; verify with
      a kanban-path probe, plain chat alone won't catch it)
- [ ] `SOUL.md`: persona + boundaries (see mai's for the current shape:
      personality, hard boundaries incl. quiet hours + register rule)
- [ ] Backup before any of this: `hermes backup`

## 1. Voice (operator-tts)

- [ ] Reference audio: 3–10s clean sample → `/opt/sister-robot/voices/<name>-ref.wav`
- [ ] `OPERATORS` entry in `/root/.hermes/scripts/operator-tts.py`:
      voice blend (e.g. `af_nicole(2)+af_heart(1)`), ref, description
- [ ] `PROFILE_NAME` map entry if the profile dir name differs from the
      voice key (e.g. dagoth → dagoth-ur)
- [ ] `config.yaml` tts block: `provider: <name>-voice` + provider entry
      calling operator-tts.py (copy mai's block, change two names)
- [ ] Tone layer comes free once §3 exists (derived_state.json) — before
      that, optional curated `essence/tone.json` `{"tone": "<token>"}`
- [ ] Test: `operator-tts.py --voice <name> --output /tmp/t.wav "test line"`

## 2. VN + HQ presence

- [ ] Assets in `/root/hermes-webui-hyrax/hyrax-assets/`: `Sprites/<name>/`
      (pose dirs × emotion PNGs — VNCCS/ComfyUI pipeline, see PROVENANCE.md),
      `chibis/<name>.*`, `portraits/<name>.*`; regenerate ASSET_MANIFEST.json
- [ ] CODE: add to `VN_PROFILES` allowlist — `api/hyrax_routes.py:562`
      (immutable mapping proxy; follow the existing entry shape)
- [ ] HQ: operator card/room — cards render from `/api/hyrax/presence`
      (dynamic); room/chibi placement may need the hq.js room map — verify
      on first mount

## 3. Essence runtime (essenced)

- [ ] CODE: add to `OPERATORS` — `/root/.hermes/essenced/essenced.py:120`
      (currently `["tai", "rei", "nei", "mai"]`), restart essenced.service
- [ ] `rules.json`: outreach lanes for the operator (webui/discord flags),
      whims deck (≥3 templates; strings must not trip the risk-content
      scan), personality weights. Decks validate fail-closed on load.
- [ ] Execution stays OFF by default (`autonomy.execution.enabled.<name>`
      absent = off) — graduation is the D4 checklist
      (docs/gestalt-vn/specs/D4_GRADUATION_SPEC.md), never skip the
      shadow period
- [ ] Plugin: sister-essence enabled in config (context hook gives clock/
      hours/register injection; tone feeds voice once state exists)

## 4. Memory + skills

- [ ] Cognee MCP block in config.yaml (copy from any sister:
      `mcp_servers.cognee` → 127.0.0.1:8001)
- [ ] Mnemosyne consolidation entry (see existing profiles' setup)
- [ ] Role skill: reasoning-protocol + a role protocol under
      `skills/` (copy the closest sibling, adapt)

## 5. Work surfaces

- [ ] Kanban assignee: assign a triage task and confirm claim works
      (`hermes kanban create ... --assignee <name>`)
- [ ] Discord (optional): gateway runs under division-gateway.service;
      channel directory + SOUL.md boundary lines for public channels
      (dagoth's are the template: who may command vs who may ask)
- [ ] WebUI password env for live delivery lanes (the D2 run-1 failure:
      missing HERMES_WEBUI_PASSWORD surfaces only at delivery time;
      essenced checks at startup now — watch the log)

## 6. Verification sweep (run all)

- [ ] `operator-tts.py --voice <name>` renders
- [ ] VN loads with sprites; sprite/emotion switching on a test message
- [ ] HQ card + whim chip appear (after first deck draw)
- [ ] essenced log shows the operator in `operators=` after restart
- [ ] Derived state exists: `profiles/<name>/essence/derived_state.json`
- [ ] First outreach message obeys the register rule (work-hours test)
- [ ] Kanban task round-trip completes

## Known debt (make these data-driven someday)

- `VN_PROFILES` (api/hyrax_routes.py:562) and `OPERATORS`
  (essenced.py:120) are code constants — a new operator currently means
  two small code edits + service restarts. Candidates for a registry file
  under governance/ read at startup.
- Whim decks live in rules.json (fine) but there's no deck template
  generator — copy mai's and rewrite in the new operator's voice.
