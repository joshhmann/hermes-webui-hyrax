# Division Work Cycles (2026-07-26)

The two canonical workflows, driven by kanban work orders. Every step leaves
paperwork; every handoff has a shape; nobody's work is invisible.

## The Bug Cycle

```
user reports (any channel)
  → MAI triages: reproduces user's world, files [TRIAGE] task → rei
  → REI verifies: reproduces or bounces; files [QA] fix task → tai (acceptance criteria hers)
  → TAI fixes: marks complete with evidence
  → REI attests: re-runs repro, signs or rejects → task closes
  → MAI closes the loop with the user in plain language
```

## The Build Cycle

```
user requests (any channel)
  → NEI specs: problem, shape, acceptance criteria → files [SPEC]/[BUILD] task → tai
  → TAI builds: smallest working slice, marks complete with evidence
  → REI QAs: review protocol, attests → task closes
  → MAI supports adoption: what changed, how to use it, catches issues
  → issues feed the Bug Cycle
```

## Task shapes

- [TRIAGE] Mai → Rei: user report verbatim, environment, repro attempted,
  suspected area (labeled guess), severity guess. (mai-support-protocol)
- [QA] Rei → Tai: verdict, repro steps, expected vs actual, root cause
  (file:line or "not isolated — eliminated X, suspect Y"), class check,
  evidence, acceptance criteria (Rei's verification steps). (rei-qa-protocol)
- [SPEC]/[BUILD] Nei → Tai: problem statement, constraints, shape,
  acceptance criteria, non-goals. (nei-knowledge-protocol — to be written)
- Completion (Tai): what changed, how verified, evidence links.
  Attestation (Rei): repro re-run result, signoff (PASS / NOTES / BLOCKED).

## Rules

- Severity routing: blocking = own task now; moderate = own task; minor =
  batched "QA sweep" per audit.
- Dedup before filing: update the existing task with new evidence.
- Acceptance criteria belong to the reviewer, written at filing time.
- Attestation, not trust: the fixer never closes; the verifier closes.
- Every handoff links the previous task; the chain is auditable end to end.
- The user always hears the ending from Mai (or directly), never silence.
