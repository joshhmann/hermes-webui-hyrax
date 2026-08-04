# [SPEC] Division Factory Gaps — importing SSSF's lessons into our stack

Source: review of disler/super-simple-software-factory (2026-08-03). His
line: "code owns the loop, agents own bounded phases." Ours: "the board
owns the loop, operators own work." Same insight, opposite direction.
This spec enumerates OUR holes — with the evidence we paid for — and how
each import lands without violating "Hermes stays stock" (extension
points only; changes to hermes core go through the hermes repo, flagged
below).

## Hole 1 — Cold restart instead of correction (THE token hole)

**Evidence we paid:** tai's planner run died 3×; one kimi subagent run
timed out at 2h; EMB-1 hx-coder died 4× — every failure burns the whole
context window and the next run re-learns everything. Iteration-budget
exhaustion (90/90) is our most common failure mode.

**Current:** a kanban run that fails spawns a FRESH session next claim.
Nothing carries forward except what the agent wrote to the task.

**Import (SSSF's best idea):** correction > restart. When a run fails a
verification (suite red, claim mismatch, protocol violation), the next
attempt RESUMES the prior session (`hermes --resume <id>` — the CLI
prints it) with a correction message naming exactly what failed, instead
of starting cold. A correction costs one message; a cold start re-reads
the world.

**Where it lives:** the kanban dispatcher/worker spawn logic = hermes
core → hermes change (flagged). Config-gated (retry_policy: correct_first
| cold, default correct_first). Workspace persistence already exists
(task workspaces); session-id persistence per task run is the addition.
Acceptance: a run that fails with a red suite resumes with "the suite is
red: <failing test names>" instead of restarting; measured token delta on
a controlled failure.

## Hole 2 — No mechanical gates (rei reads everything)

**Current:** "done" means the worker says so + rei attests by reading.
Rei is better than gates (catches semantic drift) but she is a full model
run per review, and every claim waits on her.

**Import:** gates as functions that verify CLAIMS mechanically, cheaply,
immediately: `diff_matches_claims` (files changed == files claimed),
`tests_pass` (the named suite is green), `artifacts_exist`,
`journal_entries_present`. A gate is one function, run at task
completion, results posted as a comment. Gates don't replace rei — they
pre-filter so rei's reads are pre-verified. Fail-closed: a gate failure
blocks the review-required state and feeds Hole 1's correction message.

**Where it lives:** our layer is fine — a gates module under
governance/ (or the essenced tooling), invoked by the dispatcher on
completion → hermes hook point (post-run callback) or a wrapper the
dispatcher calls. Gates registry in data (which gates run per task type).
Acceptance: a task claiming files it didn't touch gets gate-refused with
the mismatch named; a task claiming green tests with a red suite never
reaches rei.

## Hole 3 — Agents doing arithmetic (code phases)

**Evidence we paid:** workers burn turns discovering and running the test
suite, the build, the typecheck — known commands re-derived per run.

**Import:** kind=code phases. For task classes where the command is known
(suite, typecheck, build, lint), the runner executes it directly as a
subprocess — before the agent (baseline) and after (verification), with
results injected into the worker's context. The agent reads and decides;
code runs the subprocess. This is also Hole 2's substrate: gates need
command results anyway.

**Where it lives:** task metadata (data: `verify: {command, expect}` per
task or per project) + the dispatcher runs it → hermes hook (pre/post
run), our-side module does the subprocess + reporting.
Acceptance: a build task runs the suite as code; the worker's context
contains baseline+final results without spending a turn discovering them;
measured turn-count reduction on a standard task.

## Hole 4 — Workers can edit the machinery that grades them

**Current:** essenced has the covenant (3 writable files, hard-fail).
Kanban workers have contract_gate_mode but no file-level boundary — a
worker CAN edit the test that grades it, the spec, or the reviewer's
inputs.

**Import:** protected_files per task/agent class — paths the worker may
not modify (test files when the task is implementation, specs, review
tooling, governance stores). Enforced by diff inspection post-run (SSSF's
approach: unauthorized changes rolled back, phase fails) — cheap and
sufficient since our board already tracks changed files via git.
Acceptance: a worker that edits the test suite to green gets the change
rolled back + task failed with the violation named.

## Hole 5 — Typed handoffs are prose

**Current:** task handoffs are markdown comments (Latest summary). Rich,
but unstructured — the next worker re-derives machine facts from prose.

**Import:** a thin envelope alongside the prose: `{status, summary,
changed_files, test_counts, claims}` as structured JSON on the completed
run (kanban edit --metadata exists). Prose stays for humans; the envelope
feeds gates (Hole 2) and corrections (Hole 1). Incremental: adopt the
envelope in the worker instructions (skills), consume in gates.
Acceptance: completed runs carry parseable envelopes; gates consume them;
rei stops re-deriving file lists from prose.

## Explicitly NOT importing

- His whole ADW repo/runner — our dispatcher is the control plane; this
  spec imports ideas, not code
- Anything that routes around rei/hyrax-os review (gates pre-filter,
  never replace)
- Branch-per-run/sandboxing — noted by SSSF itself as out of scope;
  our workspaces cover the isolation we need today
- The trace UI — our journals + board + scorecard already answer
  "what happened"

## Ordering

1 (correction) and 2 (gates) first — they compound (the correction
message is gate output). 3 next (feeds 2). 4 and 5 are small. 1 and 3
are hermes-core changes; 2, 4, 5 live in our layer.

## Links

SSSF repo review (2026-08-03 session notes), GAMEPLAN.md hard rules
(Hermes stays stock), D3_GATES (G8 precedent: verification in code)
Assignee: spec only — implementation split: hermes-side (1,3) needs
josh's call on touching hermes core; our-side (2,4,5) → tai
