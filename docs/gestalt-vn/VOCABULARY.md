# Gestalt/Essence Controlled Vocabulary

The contract for every term that crosses a layer boundary in the Gestalt VN /
Essence stack. It exists because the "crying default" bug happened when
`neutral` meant different things in different layers — every term below has
exactly one owner, and every consumer maps to the owner's meaning.

**Rule for all sections:** new terms enter this vocabulary first, code second.
A term that appears in code but not here is drift; the lockstep tests in
`tests/test_hyrax_vocabulary.py` fail on it.

Enforcement: `tests/test_hyrax_vocabulary.py` (server↔client mirror equality,
family/jolt/pose/activity coverage, canonical-expression never-blank).

## 1. Operators

| id | name | role (VN profile) | HQ role | HQ room (label → id) | VN room |
|---|---|---|---|---|---|
| `tai` | Tai | Builder | implementation | Operations Hub → `ops` | `ops` |
| `rei` | Rei | QA | verification | Security Alcove → `security` | `security` |
| `nei` | Nei | Quartermaster | contracts | Research Lab → `lab` | `lab` |
| `mai` | Mai | Support | blocked triage | Logistics Annex → `logistics` | `logistics` |

- Owner (identity/role/availability): `api/hyrax_routes.py` `VN_PROFILES`
  (immutable allowlist, lines ~464–527).
- Consumers: `static/hyrax/hq.js` `HQ_SISTERS` (room by HQ label),
  `static/hyrax/vn/vnShell.js` `OPERATOR_ROOM` (room by VN room id).
- Mapping note: HQ_SISTERS.room is a display **label** resolved through
  `ROOM_ID_BY_LABEL`; vnShell `OPERATOR_ROOM` is a room **id**. Both resolve
  to the same 4 HQ room ids.
- Adding new terms: add the operator to `VN_PROFILES` first, then mirror in
  `HQ_SISTERS`, `OPERATOR_ROOM`, a room manifest (§7), and `EXPRESSION_ENUM`
  (§4). A fifth operator without all five rows is incomplete.

## 2. Expression families (6)

| family | meaning | jolt class | jolt animation |
|---|---|---|---|
| `neutral` | calm/flat baselines only | `gestalt-vn-jolt-neutral` | settle |
| `positive` | smiles, laughter | `gestalt-vn-jolt-positive` | bounce |
| `wry` | sarcasm, smugness | `gestalt-vn-jolt-wry` | tilt |
| `focused` | attention, alertness, thought | `gestalt-vn-jolt-focused` | lean |
| `intense` | anger, mania, extremes | `gestalt-vn-jolt-intense` | shake |
| `sad` | grief, disappointment, exhaustion-sad | `gestalt-vn-jolt-sad` | sag |

- Owner: `hyrax-assets/essence/expression-families.json` (`families` array,
  v2 curated 2026-07-26).
- Mirrored maps (must be byte-identical as key→family dicts):
  server `api/hyrax_essence.py` `_EXPRESSION_FAMILY`;
  client `static/hyrax/essence/essenceFrames.js` `EXPRESSION_FAMILY`.
- Jolt consumers: `static/hyrax/vn/vnStage.js` `JOLT_CLASSES` (6 classes,
  one per family); `static/hyrax/hyrax.css` `.gestalt-vn-jolt-*` selectors +
  `@keyframes gestalt-vn-jolt-{bounce,shake,tilt,lean,settle,sag}` behind
  `@media (prefers-reduced-motion: no-preference)`.
- The v2 curation moved the sad cluster out of `neutral` — this is the fix
  for the crying-default bug. `neutral` must never regain negative-valence
  emotions.
- Adding new terms: a 7th family enters `expression-families.json`
  `families[]` first, then both mirror maps, then a jolt class in vnStage.js
  AND hyrax.css (a family without a jolt class silently never reacts).

## 3. Emotions (157 VNCCS names)

- Owner: `hyrax-assets/essence/expression-families.json` `emotions{}`
  (157 entries, source: AHEKOT/ComfyUI_VNCCS emotions-config).
- Rule: every emotion belongs to **exactly one** family from §2 (`family`
  field, enforced by test).
- Fields per emotion: `category`, `family`, `canonical`, `description`,
  `sfw`.
- Canonical links (`canonical` = self, the curated anchor expressions):
  `smile`, `laughing`, `light-smile`, `shy-smile`, `yandere-smile`,
  `ohhoai`, `ahegao`, `happy-emote`, `sarcastic`, `scream-of-fury`.
  Note: `ahegao` is canonical in the table but is in **no** operator's
  EXPRESSION_ENUM (§4) — canonical-in-table ≠ canonical-per-operator.
- Registry usage: `hyrax-assets/essence/frames.registry.json` frame
  `state.expression` values are drawn from these 157 names plus the §4
  per-operator enum names (`calm`, `alert`, `observant`, `thinking`,
  `focused`, `neutral` — which are also emotion names where applicable).
- Adding new terms: add to `expression-families.json` with a valid `family`
  first; frames and enum entries reference it afterwards.

## 4. Per-operator canonical expression enums

Owner: `api/hyrax_essence.py` `EXPRESSION_ENUM` (immutable;
`normalize_expression()` fails closed to `neutral` + issues[] for anything
outside the operator's enum).

| operator | canonical expressions |
|---|---|
| `tai` | `neutral`, `smile`, `happy-emote`, `sarcastic`, `focused` |
| `rei` | `neutral`, `calm`, `alert` |
| `nei` | `neutral`, `observant`, `thinking` |
| `mai` | `neutral`, `smile`, `laughing`, `light-smile`, `ohhoai`, `shy-smile`, `scream-of-fury`, `yandere-smile`, `sarcastic`, `focused` |

- `NEUTRAL_EXPRESSION = "neutral"` is the universal fallback for every
  operator.
- Client mirror for the fallback ladder only (never to invent expressions):
  `static/hyrax/essence/essenceFrames.js` `GENERIC_PORTRAIT_IDS` — note
  `mai.portrait.observant` exists there as an asset id although `observant`
  is not in mai's enum (generic-ladder asset, not a canonical expression).
- Never-blank guarantee: every enum value must be renderable via an approved
  registry portrait frame (direct expression or same-family match per
  `_EXPRESSION_FAMILY`) or a generic portrait asset. Enforced by test.
- Adding new terms: add to `EXPRESSION_ENUM` first; the enum value must map
  to a family in `_EXPRESSION_FAMILY` and have frame coverage before it
  ships.

## 5. Poses

Portrait pose vocabulary (registry `state.pose`, owner:
`hyrax-assets/essence/frames.registry.json` as produced by
`scripts/build_frame_registry.py`):

| pose | notes |
|---|---|
| `standing` | default |
| `sitting` | |
| `thinking` | |
| `clasped` | **pending rename** — the token `clasped` is scheduled to be renamed; treat it as canonical until the rename lands, then update this row, the registry, and any intents in one pass |
| `confident` | |

Chibi pose vocabulary: `stand` only (chibi frames, e.g. `frame.tai.chibi.stand`).

**pose vs poseFamily** — distinct layers, do not conflate:

- `state.pose` is a concrete pose (this section).
- `poseFamily` is the coarse signature bucket from `_POSE_FAMILY`
  (server `api/hyrax_essence.py`, client `essenceFrames.js` `POSE_FAMILY`,
  mirrored identically): `standing→standing`, `idle→standing`,
  `sitting→sitting`, `working→working`, `gesturing→gesture`;
  default for unmapped poses: `standing`. Family **values** are
  `{standing, sitting, working, gesture}` — note the value is `gesture`,
  not `gesturing` (the key is `gesturing`).
- The 5 registry portrait poses above are **not** keys of `_POSE_FAMILY`
  (except `standing`/`sitting`), so `thinking`/`clasped`/`confident` all
  bucket to `standing` — intentional: pose-family only separates
  stand/sit/work/gesture granularity in scene signatures.

Known drift (reported 2026-07-26, NOT fixed here — documentation + tests
only): 4 legacy sprite frames `frame.{tai,rei,nei,mai}.sprite.neutral.0004`
(authored, `kind` field absent) carry `state.pose: "hands-on-hips"`, which
is not in the vocabulary. Quarantined in
`tests/test_hyrax_vocabulary.py::test_registry_pose_values_in_vocabulary`;
remove the quarantine when the registry is rebuilt.

Adding new terms: add the pose to this table first, then generate frames;
new chibi poses extend the chibi row, not the portrait set.

## 6. Activity types (presence)

Vocabulary (7): `idle`, `conversing`, `tool-working`, `waiting-approval`,
`background-working`, `resting`, `offline`.

| layer | owner | values |
|---|---|---|
| Server emission | `api/hyrax_essence.py` `_presence_item()` + `_ACTIVITY_INTERRUPTIBILITY` | emits `idle`, `conversing`, `tool-working`, `waiting-approval` (interruptibility: free / soft-busy / busy / busy) |
| Client display | `static/hyrax/hq.js` `ACTIVITY_TYPES`, `ACTIVITY_LABELS`, `ACTIVITY_ROOM` | all 7; labels: idle/chatting/working/needs approval/background/resting/offline; rooms: conversing→`common`, waiting-approval→`director`, resting→`coffee`, idle→`common`, tool-working/background-working/offline→own room |

- Rule: server-emitted types ⊆ the 7-term vocabulary (enforced by test);
  `ACTIVITY_LABELS`, `ACTIVITY_ROOM`, `ACTIVITY_TYPES` must cover the same
  set exactly (enforced by test).
- Mapping note: `background-working`, `resting`, `offline` are declared
  client-side vocabulary but are **not currently emitted** by
  `_presence_item()` — they exist for future presence derivation
  (Essence active runtime phases) and for client-side placement. Not drift;
  a server that starts emitting them needs no vocabulary change.
- Adding new terms: add to the client triple (types/labels/rooms) and this
  table first, then to server emission with an interruptibility value.

## 7. Rooms / locations

HQ rooms (9), owner `static/hyrax/hq.js` `HQ_ROOMS`:

| id | label |
|---|---|
| `security` | Security Alcove |
| `common` | Common Area |
| `coffee` | Coffee Station |
| `corridor` | Main Corridor |
| `director` | Director's Office |
| `ops` | Operations Hub |
| `lab` | Research Lab |
| `logistics` | Logistics Annex |
| `entrance` | Entrance |

VN room manifests (4), owner `static/hyrax/vn/rooms/`:

| file | roomId | operatorId | displayName |
|---|---|---|---|
| `ops.json` | `ops` | `tai` | Operations Hub |
| `security.json` | `security` | `rei` | Security Alcove |
| `lab.json` | `lab` | `nei` | Research Lab |
| `logistics.json` | `logistics` | `mai` | Logistics Annex |

- Mapping: VN room ids ⊆ HQ room ids; registry `state.location` values are
  VN **background asset** locations (`control-room`, `security`, `lab`,
  `supply-hub`) — a different, asset-level namespace owned by
  `hyrax-assets/vn/ASSET_MANIFEST.json`; do not mix with room ids.
- Adding new terms: HQ room → `HQ_ROOMS` first; VN room → manifest file in
  `static/hyrax/vn/rooms/` + `OPERATOR_ROOM` entry; keep ids aligned.

## 8. Essence traits (state model)

Owner (design): `docs/gestalt-vn/ESSENCE_ACTIVE_RUNTIME.md` §3. Every field
is `{value, provenance, updatedAt}`.

| group | fields | range/type |
|---|---|---|
| `mood` | `valence`, `arousal`, `intensity`, `primary`, `secondary` | valence −1..1; arousal/intensity 0..1; primary/secondary: emotion/family name or null |
| `condition` | `energy`, `focus`, `stress`, `comfort`, `sociability` | 0..1 |
| `activity` | `type`, `description`, `since`, `interruptibility` | type from §6; interruptibility `free`/`soft-busy`/`busy` |
| `social` | `warmth`, `trust`, `familiarity`, `lastInteractionAt` | 0..1; timestamp |
| `presentation` | `expression`, `poseIntent`, `sceneIntent`, `intensity` | expression from §4; poseIntent from §5; intensity 0..1 |

Provenance values (closed set, §1 invariant 2): `event-derived`, `decayed`,
`model-interpreted`, `user-set`, `unknown`.
(The §3 example block also shows `"derived"` on `presentation.*` — shorthand
for the recomputed presentation layer; the closed set above is normative.)

Adding new terms: new trait → §3 of ESSENCE_ACTIVE_RUNTIME.md first with
range + default + decay rule; new provenance value → this table and the
invariant list, never ad hoc.

## 9. Wants & moodlets

Owner (design): `docs/gestalt-vn/ESSENCE_ACTIVE_RUNTIME.md` §12 (Sims
layer). Deterministic; no LLM in the core loop.

| term | vocabulary |
|---|---|
| want types | `social`, `purpose`, `stimulation` |
| needs (pressure traits) | `energy`, `social`, `stimulation`, `purpose` |
| moodlet | freeform named timed modifier: `{name, deltas, ttl, source event}` — name is free text (e.g. "shipped something hard"), `deltas` are trait adjustments (e.g. +valence), `ttl` expires via the decay ticker, `source event` is the journal link |

- Moodlets stack and expire; wants have a satisfaction condition and pay a
  moodlet reward. Both appear in the journal ("why is she in a mood?").
- Adding new terms: new want type → this table + §12 first; moodlet names
  stay freeform but the schema keys (`name`, `deltas`, `ttl`, `source`) are
  fixed.

## 10. Motion semantic tokens (design-stage)

Owner (design): `/root/workspace/ardy-bridge/ARDY_VRM_ARCHITECTURE.md` —
§2.1 joint→bone table + Addendum 2026-07-25 ("Source-adapter strategy").
**Design-stage**: no shipping code in this repo consumes these yet; the
canonical layer is a contract for source adapters (Core27 first, SOMA77
next).

Rule (addendum): the canonical layer uses **semantic tokens, never source
names** — nothing downstream of an adapter may contain `LeftUpLeg`,
`Spine3`, `LeftShin`, etc.

Canonical joint tokens (VRM humanoid bone names, §2.1):
`hips`, `spine`, `chest`, `upperChest`, `neck`, `head`,
`leftShoulder`, `rightShoulder`, `leftUpperArm`, `rightUpperArm`,
`leftLowerArm`, `rightLowerArm`, `leftHand`, `rightHand`,
`leftThumbProximal`, `rightThumbProximal`,
`leftUpperLeg`, `rightUpperLeg`, `leftLowerLeg`, `rightLowerLeg`,
`leftFoot`, `rightFoot`, `leftToes`, `rightToes`.

(Adapter skeleton ids: `core27`, `soma77`. Note: there is no `spineMid`
token — the chain is `spine`/`chest`/`upperChest`, with ARDY `Spine2`
chain-compressed into `upperChest`'s world-space delta.)

Adding new terms: new token → the ARDY architecture doc addendum first,
then the adapters; a token that only one adapter emits is a source name,
not a canonical token.

---

## Change procedure (all sections)

1. Add/rename the term in this file and in the owner file/table.
2. Mirror to every consumer listed in the section (server ↔ client mirrors
   must be identical, not similar).
3. Run `./scripts/test.sh tests/test_hyrax_vocabulary.py` — it must stay
   green without editing the tests. Editing the tests to absorb drift is
   only allowed as a documented quarantine with frame-level precision
   (see §5).
