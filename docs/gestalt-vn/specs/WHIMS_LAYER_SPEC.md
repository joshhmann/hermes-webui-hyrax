# [SPEC] Whims Layer + Mai's Playground Lease

## Problem

D1/D2 wants are three generic templates (social/purpose/stimulation). Real
personality shows in *specific* desires: "Nei wants to reorganize the
contract index," "Tai wants to show off the thing she built," "Mai wants to
tinker in her LXC." The division needs object-wants with personality, and
Mai's existing playground container is the perfect first sandbox for them.

## Constraints

- Whims are generated, not hardcoded per instance — decks are data
  (per-operator templates with slots filled from live state)
- Fulfilled whims produce moodlets (existing §12 mechanism)
- The playground lease is sandboxed to Mai's LXC only; nothing the lease
  can do touches fleet state (fixed append-only shape, no remote command
  execution, payload scans refuse fleet paths/credentials). The sandbox
  HOST itself sits on the LAN with normal egress — the lease is
  credential-safe; the host is not loopback-isolated (QA 2026-08-02:
  observed default route via 192.168.0.1, iptables OUTPUT ACCEPT, egress
  to 192.168.0.1:22 / 192.168.0.175:22 open, operator shell state present)
- Mai's existing cron playground keeps working during migration; no big-bang

## Shape

1. **Whim deck schema** (rules.json per operator): whim templates with slots,
   e.g. `{verb: "reorganize", object_source: "stale_kanban_area"}`,
   `{verb: "show off", object_source: "recent_completion"}`,
   `{verb: "tinker", object_source: "playground"}`. Slot resolution reads
   kanban/journal/state to fill concrete objects.
2. **Whim evaluation** (essenced): deck draws on a cadence (config, default
   1-2 active whims/operator), whim wants fire like §19 wants through the
   existing policy gate. Personality weighting per operator.
3. **Fulfillment detection**: each whim type has a check (reorganized? shared?
   built?) — fulfilled → moodlet reward (existing moodlet table + new entries).
4. **Playground lease class `playground_tinker`** (D2 machinery): scoped to
   Mai's LXC container at 192.168.0.17, append-only project area
   (`/root/playground/`), one bounded SSH append per lease (no remote
   command execution). The host itself is a normal LAN container — the
   lease cannot touch fleet state; the host is not loopback-isolated.
   Rate limit 1 tinker/day. Report-back: "look what I made" with the
   artifact path.
5. **Presentation**: active whims visible in HQ sidebar (per-operator chip:
   "wants to: reorganize the index") — read from derived_state.json meta.

## Acceptance criteria

- [ ] Whim deck for all 4 operators in rules.json with ≥3 templates each;
      slot resolution fills real objects from live state
- [ ] A whim fires → message on both lanes in her voice naming the specific
      object ("I want to reorganize the contract index")
- [ ] Fulfillment detected → moodlet journaled → mood visibly bumps
- [ ] Mai's playground lease: she produces one artifact in /root/playground/
      on .17, fleet state untouched, report-back arrives
- [ ] HQ shows active whims per operator
- [ ] Adversarial QA: playground lease cannot reach fleet credentials/state
      (pointer audit), whims can't exceed caps, decks validated on load

## Non-goals

- No arbitrary free-form autonomy (playground is the only open-ended lease)
- No shared-server Discord posting of whims
- No whims for dagoth-ur (his chaos is curated separately)

## Links

Spec: gameplan §5, ESSENCE_ACTIVE_RUNTIME.md §12 (wants/moodlets)
Assignee: tai | Reviewer: rei | Pilot operator: mai
