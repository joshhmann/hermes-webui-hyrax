# [SPEC] EMB-1 — Live Motion Transport: consolidation + hardening

## Problem

The embodiment platform roadmap (EMBODIMENT_PLATFORM_ARCHITECTURE.md) treats
motion as offline clips until the behavior phase — but the loft already runs
on LIVE streamed motion, and live transport is its own hard problem:
handshake, binary framing, buffering, clock sync, reconnect, latency, and
ingress that works off-LAN. Today these pieces exist but are scattered across
gestalt-motion, ArdyMotionSource, and the WebUI proxy, with no single
contract. This spec consolidates what exists, names the invariants, and lists
the hardening gaps. It is deliberately 80% documentation of proven behavior,
20% new work.

## Current architecture (verified, keep)

```
ARDY service (192.168.0.17:8791/ws, gestalt-ardy.service)
  → WS upgrade → skeleton_contract JSON {skeleton_id, joint_names, ...}
  → GCP1 binary chunks (local_rots wxyz, contacts, root) @ 20fps, horizon 40
        ↓
WebUI WS proxy /api/hyrax/ardy/ws (api/hyrax_ardy_ws.py)
  same-origin ingress; auth = WebUI session cookie; upstream override via
  HYRAX_ARDY_WS_UPSTREAM; RFC6455 full-duplex, 16 MiB cap, fail-closed
        ↓
ArdyClient → ChunkBuffer → PlaybackClock → PoseSampler (gestalt-motion)
        ↓
retarget (profile-driven, tai-embodiment-v3) → RootMotionAdapter → VRM
```

Client URL resolution: `?ardyWs=` override → same-origin
`ws(s)://<host>/api/hyrax/ardy/ws` (no more hardcoded LAN IP — works over
Tailscale/cellular).

## Invariants (the contract this spec pins)

1. **The session contract is the single source of truth for the skeleton.**
   GCP1 packets carry no skeleton_id; decode uses the handshake contract.
   A service advertising an unknown/changed contract must fail closed
   (state `offline`), never guess.
2. **Health states are exactly** `connecting | live | stale | offline`
   (ArdyMotionSource.resolveState). `stale` = connected but no fresh frames
   within the window; `offline` = disconnected after having opened. The loft
   status dot + hover text surface these verbatim.
3. **ProceduralLocomotion owns the rig until the retargeter is calibrated**
   (settled frame 20 per profile), then a 0.3s crossfade hands over. Motion
   never hard-cuts — reset chunks (new prompt / drift-watchdog hard reset)
   crossfade from the current rendered pose into the new stream over ~0.45s,
   with the root re-anchored at the avatar's current position and the
   heading difference eased over via a critically damped spring (T2).
4. **Reconnect forgets nothing important**: on reconnect the client re-sends
   the last prompt (the service idles until prompted and forgets sessions),
   re-fetches/re-uses the cached calibration profile, and re-anchors root
   motion so a fresh session never teleports the avatar.
5. **The proxy is the only browser ingress.** Direct LAN websockets from
   browsers are legacy; new consumers use the same-origin proxy.
6. **One proxied connection = bounded resources**: sockets closed and pump
   threads exited on either side disconnecting; upstream idle-strike close
   (~5 min) reaps dead tabs. Verified: no thread leak on abrupt disconnect.

## Hardening gaps (the new work)

1. **Contract versioning**: skeleton_contract gains a `contract_version`
   field; the client refuses unknown major versions fail-closed. Server
   sends it; client checks it; today neither exists.
2. **Latency budget + telemetry**: define acceptable glass-to-bone latency
   (target: < 250ms p50 from service frame timestamp to rendered pose) and
   surface actuals in the debug overlay (buffer depth, staleness, reconnect
   count, frames dropped). The `__ardy` debug handle already exposes state;
   extend it with counters.
3. **Backoff policy**: reconnect uses exponential backoff
   (INITIAL_BACKOFF_MS 1000) — pin max backoff, jitter, and a
   give-up-and-report threshold (after N failed attempts, state `offline`
   with a journaled client-side reason; do not spin forever).
4. **Multi-consumer policy**: define what happens when two browser tabs open
   the loft — currently each opens its own upstream session and the service
   may not multiplex. Decide: last-wins, first-wins, or proxy-side fan-out.
   Fail-closed default: proxy refuses a second concurrent upstream session
   per upstream with 409 semantics (WS close code + reason).
   **Resolution (shipped)**: fail-closed first-wins — one concurrent proxied
   session per upstream URL; a second browser is upgraded then immediately
   closed with 1013 (Try Again Later) + reason, so its backoff retries
   attach once the first session ends (api/hyrax_ardy_ws.py).
5. **Prompt-channel abuse bounds**: motion prompts are operator/user input
   crossing into a GPU service — length cap, rate cap, and character
   validation at the proxy (the service trusts its LAN clients today).

## Acceptance criteria

- [x] contract_version sent + checked; mismatched major → offline with
      reason logged (tested both sides — client ArdyMotionSource gate +
      gestalt-motion registry, service serializer tests. CAVEAT: the
      DEPLOYED gestalt-ardy.service on 192.168.0.17 still runs pre-version
      code; the client tolerates absence with a one-time warning until the
      service is redeployed from /root/workspace/ardy-bridge)
- [x] Latency/buffer/reconnect telemetry visible in the loft debug overlay
      and via `window.__ardy` (status-dot hover text + `__ardy.getTelemetry()`)
- [x] Backoff policy constants in one config block; give-up path tested
      (kill service → state offline with reason, no infinite reconnect)
- [x] Multi-consumer policy implemented per decision + tested (1013 + reason;
      verified live through 127.0.0.1:8787)
- [x] Prompt validation at proxy: oversized/overspeed prompts rejected with
      a close reason (tests exist alongside test_hyrax_ardy_ws.py; verified
      live: 1008 + reason)
- [x] Existing suites stay green: hyrax-3d typecheck/build/tests,
      tests/test_hyrax_ardy_ws.py, gestalt-motion 72 tests

## Non-goals

- No new motion sources (that's EMB-2 canonical semantics)
- No retarget changes (profile-driven runtime already landed)
- No multi-viewer/shared-scene presence (world-ownership spec EMB-4 first)
- No service-side generation changes (ARDY service stays as-is except
  contract_version)

## Links

EMBODIMENT_PLATFORM_ARCHITECTURE.md (amendment: explicit live-transport
phase), hyrax-3d/src/embodiment/motion/ArdyMotionSource.ts,
api/hyrax_ardy_ws.py, /root/workspace/ardy-bridge/gestalt-motion/
Assignee: hx-coder or kimi | Reviewer: rei | Pilot: tai's loft
