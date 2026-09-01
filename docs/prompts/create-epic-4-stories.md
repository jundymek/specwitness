# Prompt: Create Epic 4 story files (paste into a fresh Claude Code session in this repo)

---

You are working in the SpecWitness repo (`/Users/jundymek/dev/specwitness`, default branch `master`). **Epics 1, 2 and 3 are implemented and merged** — Epic 1 at `b5377b0` (6 stories), Epic 2 at `fbdd359` (8 stories incl. follow-up 2.8), Epic 3 at `26a6335` (PR #40; 8 stories incl. owner-added 3.8, plus two 3.1 follow-ups). Retrospectives are `docs/findings/epic-1-retro-2026-08-31.md`, `epic-2-retro-2026-08-31.md`, `epic-3-retro-2026-09-01.md`, and the harness-defect record is `epic-2-harness-defects-2026-08-31.md`. Your ONLY task in this session: produce implementation-ready story files for **Epic 4 — Behavioral Verification over HTTP & State** (stories 4.1–4.7), ready to be executed by the terminal-agents harness **as three sequential cohorts** (see Step 5 — this is new and it changes what you write). Do NOT implement any production code, and do NOT modify the finalized planning artifacts (PRD, spine, ADRs, epics.md, roadmap.md).

Epic 4 is where SpecWitness stops proving that a branch *builds* and starts proving that it *behaves*. Epic 3 made `verify` a real gate over deterministic gates; this epic makes it a real gate over acceptance criteria. Three consequences for how you write these stories:

- **This is the first epic where AI output becomes an executable artifact.** The plan-author provider drafts a Plan, and that Plan drives probes. AD-2 and AD-3 stop being invariants about authoring and become invariants about *execution*. A plan draft containing an inline shell string must fail the schema gate — the exit criterion says so explicitly, and it is the security property of the whole epic.
- **This is the first epic that runs the target project's services.** Epic 3's process-group discipline exists precisely for this, and 4.1 is its first real consumer.
- **Criterion results become real.** Until now every criterion was `skipped`. From here the product's central promise — a mechanical verdict from observed evidence — is actually exercised.

## Step 0 — Ground truth first (three epics of merged code now exist)

Every story you write must reference the **real, merged** modules by path and exported name — never re-specify something that already exists, never invent a signature. Epic 2's lesson 5, re-confirmed in Epic 3: *verify shapes against merged source, not against a summary* — **including the summaries in this prompt**. Read, in full:

1. `CLAUDE.md` (its "Current phase" line is stale again — see Step 6).
2. `docs/findings/epic-3-retro-2026-09-01.md` — all of it, but especially:
   - **§6 "Next-epic readiness"** — written for you. It names the placeholders waiting (`setup`, `services`, `data`, `probes`), the exported `terminateProcessGroup` for 4.1, the pre-declared `http`/`browser`/`observation` evidence kinds, and `SurfaceExecutor`/`ProbeAttempt`/`deriveCriterionResult` in place with the gates-only cases proven.
   - **§6's one hard rule:** *human-verifiability criteria are unconditionally NEEDS_HUMAN — attempts do not override.* A well-meaning "floor" variant was caught and reverted in Epic 3. **A probe adjudicating a human criterion requires an ADR, not a branch.** Put this in writing in 4.7 and in whichever probe story could be tempted.
   - **§6 on redaction:** `redactText`'s `{shellCommand: true}` option is reserved for **declared commands only**; Epic 4 callers must pass capture output undeclared (fail-closed default). This is a security clause, not a style note.
   - **§6 on the green-for-nothing refusal:** its condition is written to be *amended, not deleted*, when probes make gate-less projects legitimately verifiable (`verify.ts`, decision 3.7-D4). Say which story amends it — recommend 4.7.
   - **§5 debt items 1 and 2** — the owner has assigned both into this epic as riders (see Step 3).
   - **§7 action items** and **§9 gates no agent could run** — CI has never executed a step in three epics, Linux and Node exactly 22.12 remain unverified, and no test has ever invoked a real `claude`/`codex`. Say so in the stories rather than letting an agent claim CI green.
3. `docs/findings/epic-2-harness-defects-2026-08-31.md` — H-1..H-16, still the operative record. **H-10** (set-depends-on only after intent-sync), **H-3/H-4** (rebase nudge reaches merged agents; use `git rebase --onto`), **H-8** (auto-review runs `pnpm test` concurrently in the agent's worktree — new test files must stay concurrency-safe), **H-13** (do not name a file `*.env.test.ts`).
4. The Epic 3 story files under `docs/implementation-artifacts/epic-3-isolated-deterministic-verification/` — their **Dev Agent Record / Completion Notes** carry decisions the code embodies. Match their shape and depth (each ~200–250 lines of dense prose). Note especially how they handle: verbatim ACs + "Clarifications (detail only, no weakening)", exact scope, out-of-scope-by-owner, failure modes, and the Cohort block.
5. The merged code — quote it, don't paraphrase. At minimum:
   - **The pipeline and its waiting placeholders:** `src/pipeline/` — `run-pipeline.ts`, `stage.ts`, and `stages/{setup,services,data,probes,aggregate,persist,teardown,gates,integrity,resolve,worktree}.ts` plus `placeholder.ts`. Read what a placeholder actually is before telling a story to replace one.
   - **AD-13's seam:** `src/domain/criterion-result.ts` — `PROBE_SURFACES` (`http`/`browser`/`observation`/`shell`), `Observation`, `AssertionEvaluation`, `ProbeExecError`, `ProbeAttempt`, `ProbeRequest`, `SurfaceExecutor`, and the single `deriveCriterionResult` producer. **Epic 4 fills this; it does not redesign it.**
   - **Evidence:** `src/domain/evidence.ts` — `EVIDENCE_KINDS`, `evidenceRef`, the per-kind interfaces (`http`, `browser`, `observation`, `command`, `gate`, `provider`), the redacting constructors and `redactText`. The `http` and `observation` kinds are **declared and unused** — Epic 4 is their first producer.
   - **The run model:** `src/domain/run-result.ts` (`RunResult`, `ProviderUsage`, `RunEnvironment`), `src/domain/stage.ts`, `src/domain/result.ts`, `src/domain/run-outcome.ts`, `src/domain/verdict.ts` (`aggregate` — call it, never re-implement it).
   - **Process lifecycle, which 4.1 consumes:** `src/domain/process-runner.ts`, `src/infra/process-runner.ts` (process groups, the exported `terminateProcessGroup`, SIGTERM→grace→SIGKILL), `src/cli/commands/clean.ts`, `src/schemas/manifest.ts` (the manifest fields `clean` replays), `src/infra/run-store.ts`.
   - **Config, which is where every command and every service comes from:** `src/config/schema.ts` + `src/config/types.ts` — `ServiceConfig` and its `ready` block (URL **or** command probe, `timeoutSec`, default 60), `getObservationCommand`, `data.*`, `setup.install`, and `src/config/declared-command.ts` (`DeclaredCommand`, `commandText()`).
   - **The AD-2 provider boundary, which 4.2 uses:** `src/providers/invoke.ts` (the ONE schema gate + bounded retry loop), `src/domain/agent-provider.ts`, `src/providers/index.ts`, `src/providers/fake.ts` (the shipped, config-selectable fake — Epic 4's hermetic tests need it).
   - **Contract + schemas:** `src/domain/contract.ts` (`Criterion`, `Kind`, `Severity`, `Verifiability` — and the **unconditional human⇒NEEDS_HUMAN clause**), `src/schemas/contract.ts`, `src/schemas/canonical.ts`, `src/schemas/versions.ts` (**4.2 registers `plan` here — the registry's comment already reserves it**).
   - **The CLI edge and renderers:** `src/cli/commands/verify.ts`, `src/cli/exit.ts`, `src/report/**`.
   - **Guards Epic 4 must extend rather than duplicate:** `.dependency-cruiser.cjs` (**there is no rule for `src/surfaces/**` yet — say which story adds it**), `tests/unit/dependency-rules.test.ts` (hermetic since 2.8 — keep it that way), `tests/unit/config/boundary-scan.test.ts` (already scans every source file outside `src/config/`, so `src/surfaces/**` is covered automatically the moment it exists — **verify red, do not author a second scan**), `tests/unit/doctor/credential-boundary.test.ts`, `tests/unit/exit-location.test.ts`, `tests/setup/build-cli.ts`, `tests/fakes/**`.
6. Run `git log --oneline origin/master -15` and skim the Epic 3 PR subjects; several encode decisions (e.g. #36 worktree-container remedy, #35 rendered hint, #27's variance table for post-rename failures).

## Step 1 — Load planning context (in this order)

1. `docs/planning-artifacts/epics.md` — Epic 4 section: 7 stories with Given/When/Then (authoritative; expand, never weaken).
2. `docs/planning-artifacts/roadmap.md` — EPIC 4 block: waves (A: 4.1 + 4.2 → B: 4.3 + 4.4 + 4.5 + 4.6 → 4.7), shared contracts ("Plan schema incl. closed probe union + criteria-by-id (4.2's merge gates wave B), AD-13 ProbeAttempt/SurfaceExecutor, AD-3 config-id command referencing, AD-10 evidence union + redaction constructors"), exit criteria.
3. `docs/planning-artifacts/architecture/architecture-specwitness-2026-08-30/ARCHITECTURE-SPINE.md` — **AD-2** (LLM authority boundary; the shared gate in `providers/invoke.ts`; drafts only; **runtime mechanics adaptation may alter probe mechanics only — assertion and expected-value fields are structurally read-only**), **AD-3** (closed probe union `http`/`browser`/`observation`/`shell`; plans reference executables **by config id**, never by command string; a draft containing an inline command string fails schema validation; services bind to localhost unless config says otherwise; no production URL defaults), **AD-9** (deterministic data resolved at compile time and stored in the Plan; `volatile` fields excluded from reproducibility; retries opt-in, every attempt recorded, retry-pass ⇒ `flaky: true`), **AD-10** (evidence union + redaction at capture), **AD-13** (`SurfaceExecutor` returns a `ProbeAttempt` and **never** a `CriterionStatus`; exactly one `deriveCriterionResult`), AD-1 layer map, AD-5, AD-6, AD-7, AD-8, AD-12, and the Stack table.
4. `docs/adr/ADR-001..006` + `ADR-INDEX.md`.
5. `docs/planning-artifacts/prds/prd-specwitness-2026-08-30/prd.md` — FR-16, FR-17, FR-18, FR-21 (service lifecycle & readiness — **the readiness half is 4.1's; the process-lifecycle half shipped in Epic 3**), FR-23, FR-24 (browser is Epic 5 — do not build it), FR-25, FR-26, FR-27, FR-28, FR-32, NFR-7..NFR-9; UJ-2, UJ-3; `addendum.md` §A and §D.
6. `docs/planning-artifacts/architecture/architecture-specwitness-2026-08-30/architecture-questions.md` — **Q23/Q24** (service start/stop), **Q26/Q27** (config-declared ports, no auto-allocation; occupied port ⇒ InfraError naming the port, never FAIL), **Q28/Q29** (readiness probe + timeout ⇒ InfraError with captured service output as evidence), **Q33** (typed http probe shape), **Q34/Q35** (observation commands MUST emit JSON; non-JSON ⇒ criterion `error`), **Q36** (deterministic data: fixed values + recorded seed, stored in the Plan at compile time), **Q37/Q38** (lowest adequate surface; a criterion the plan-author cannot map is compiled `needs_human` with reason `not-safely-automatable` — never dropped, never guessed), **Q39** (NEEDS_HUMAN has exactly two triggers; execution-time uncertainty is `error`, not needs_human), **Q40–Q46**, **Q43/Q44** (retries opt-in, flake visible), **Q47–Q49**, **Q66** (`--no-ai` guarantees a zero-provider-call rerun). Look these up before inventing any "how exactly".

## Step 2 — Generate the seven story files

Invoke the BMAD skill **`bmad-create-story`** explicitly by name. Override its default output path — the harness reads specs by dot-style task id from an epic directory. Write each file to:

```
docs/implementation-artifacts/epic-4-behavioral-verification/<task-id>.md
```

with these exact task ids (they map to the existing `sprint-status.yaml` keys via the harness's `first-dot-dash` rule, satisfy `TASK_ID_REGEX='^[0-9]+\.[0-9]+-[a-z0-9-]+$'`, and are ≤ 64 chars):

```
4.1-service-lifecycle-readiness
4.2-plan-model-compilation-via-plan-author-provider
4.3-deterministic-test-data
4.4-http-probe-executor
4.5-observation-probes-before-after-invariants
4.6-shell-probes
4.7-ai-free-behavioral-verify-end-to-end
```

Run the skill workflow once per story, in that order. Epic integration branch: **`epic/4-behavioral-verification`** (story PRs target it, never `master`).

## Step 3 — Quality bar for every story (founder brief §63 + Epic 1–3 lessons)

Each file, in the shape the Epic 3 specs established (Status → Cohort & Dependencies → Story → Acceptance Criteria verbatim + "Clarifications (detail only, no weakening)" → Tasks/Subtasks (TDD order) → Dev Notes: Goal & Context / Exact scope / Out of scope / Dependencies & upstream contracts by ID / Architecture compliance / Testing requirements / Integration expectations / Failure modes / Security / Project Structure Notes / References → empty Dev Agent Record), must give one agent everything WITHOUT redesigning the product.

Hard constraints to carry into every Epic 4 story:

- **The Plan schema is this epic's keystone, and 4.2 owns it.** Four stories (4.3, 4.4, 4.5, 4.6) compile into or execute from it, and 4.7 runs it end to end. 4.2 must publish the complete shape — the closed probe union, criteria-by-id references, assertions-as-data, deterministic data binding, `needs_human`/`not-safely-automatable` compilation, `volatile` field declarations, `schemaVersion` — **in writing during intent-sync, before wave B writes any code**, and register `plan` in `src/schemas/versions.ts` (already reserved by comment). **No consumer may widen the Plan schema in its own branch**: an additive field is a message to 4.2's owner or a follow-up. Wave B consumers must re-check the shape against merged source before building on it.
- **AD-3 is the security property of this epic and it is testable.** Plans reference executables **by config id** (`observation: company-count`), never by command string. A provider-drafted plan containing an inline shell string **must fail schema validation** — that is a roadmap exit criterion, and the story that owns the Plan schema (4.2) owns the test. The shell probe (4.6) is a config-id reference **plus an argument allowlist**, not a command. `tests/unit/config/boundary-scan.test.ts` already covers `src/surfaces/**` the moment it exists — **verify it red with a planted probe; do not write a second scan.**
- **AD-2 stays intact under execution.** Every provider response passes the ONE gate in `src/providers/invoke.ts` — 4.2 calls it, never re-implements validation or retry. A plan draft is a **draft**: it may not weaken an expectation, and assertion/expected-value fields are structurally read-only in any later mechanics-adaptation flow (Epic 5). Say so in 4.2.
- **AD-13: exactly one producer of `CriterionResult`.** Every surface executor returns a `ProbeAttempt` and **never** a `CriterionStatus`. `deriveCriterionResult` is merged and proven for the gates-only cases; Epic 4 exercises its real paths (pass / fail / error / flaky). Four stories implement the same executor interface — 4.4, 4.5, 4.6 now, browser in Epic 5. **All three surface stories must produce structurally identical results for structurally identical outcomes**; say which story owns the shared conformance test (recommend 4.7, or a shared `tests/` helper published by 4.4 and reused — decide and state it).
- **Human criteria are unconditionally NEEDS_HUMAN.** Attempts never override. Epic 3 caught and reverted a "floor" variant; a probe adjudicating a human criterion requires an ADR, not a branch. Put this in 4.2 (compilation) and 4.7 (execution).
- **`--no-ai` and the zero-provider-call rerun are a testable exit criterion** (FR-18, Q66). A compiled Plan executes with **zero** provider calls. Assert it mechanically — inject a provider that throws and prove nothing called it. 4.7 owns the end-to-end version; say so.
- **Services: readiness is 4.1's, process lifecycle already shipped.** 4.1 consumes Epic 3's process groups and the exported `terminateProcessGroup`; it adds start-in-declared-order, readiness (URL 2xx **or** command probe, poll interval, `timeoutSec`), and teardown-always. **A service that never becomes ready is an InfraError (exit 3) with captured service output as evidence — never FAIL** (Q29). **An occupied declared port is an InfraError naming the port — never FAIL** (Q27). Both need a test that can produce the state.
- **Observation commands MUST emit JSON; non-JSON output ⇒ criterion `error`, not FAIL** (Q35). That is the classification test 4.5 owns.
- **Deterministic data is resolved at compile time and stored in the Plan** (4.3, AD-9, Q36) — fixed values plus a recorded seed. Nothing generates fresh data per run; `volatile` fields are declared and excluded from reproducibility comparison. A rerun of the same Plan must produce the same inputs, and that is a test.
- **Evidence: capture-time redaction, and the fail-closed default.** `redactText`'s `{shellCommand: true}` is for **declared commands only**; Epic 4 callers pass capture output **undeclared**. A seeded-secret test proving no stored evidence contains a configured secret is a roadmap exit criterion (FR-28) — name its owner (recommend 4.7 end-to-end, with each surface story proving its own capture path).
- **Layering:** `src/surfaces/**` is a new **adapter** directory (spine layer map: `surfaces` sits with `providers`/`infra`/`config`), so the merged `adapters-core-only` rule may already cover it — **verify that against the merged config before telling a story to author a rule.** If a new rule is genuinely needed, exactly one story owns it (recommend 4.4, the first surface to exist) and pins it in `tests/unit/dependency-rules.test.ts` with both a forbid and a permit case, hermetically (2.8's design), verified red.
- **Testing without a real project:** probes execute against **fixture apps built by the test** — a local HTTP server on an ephemeral port for 4.4, a fixture command emitting JSON for 4.5, a declared command for 4.6. Never against this repository, never against the network beyond localhost. Domain/pipeline suites spawn zero subprocesses. **The Golden Verification Corpus proper is Epic 6** — Epic 4 uses inline fixtures and says so, so nobody reads a passing suite as corpus coverage.
- **Owner-assigned riders (decided 2026-09-01), and they are not optional:**
  - **4.1 takes Epic 3 retro debt 1** — the pre-registration kill window in `src/infra/vcs.ts` (`CONTAINER_PREFIX = 'specwitness-worktree-'`) leaves one empty temp container that `clean` cannot reap, measured 1-in-3, never a checkout or a registration. 4.1 is the story that owns resource lifecycle this epic. Close it with a red-first regression test.
  - **4.7 takes Epic 3 retro debt 2** — Ctrl+C on the verify path tells the operator nothing about the surviving detached gate, the worktree, or `specwitness clean`. There is currently **no SIGINT handling in `src/cli/` or `src/pipeline/`** (verified). Exit 130 itself is not an exit-table breach (shell-reported signal death, distinguishable via `WIFSIGNALED`) — the defect is the silence. If the agent concludes the fix needs an ADR rather than a story, it must say so in its PR body rather than inventing signal semantics.
- **Inherited defects, stated so they do not become folklore:** `fenceMask` in `src/ingest/bmad-v6/markdown.ts` (Epic 2 §5a defect i) remains a named follow-up — **no Epic 4 story ingests markdown, so it stays out of scope**. The stale comment in `tests/integration/verify.test.ts` (~line 879, Epic 3 debt 3) is a two-line cleanup for whoever next touches that file — recommend 4.7, which will.
- Stack pinned exactly per the spine (Node ≥22.12, TS 6.0.x, pnpm 11, commander 15, zod 4.5, execa 10, yaml 2.9, vitest 4.1, tsup 8.5, dependency-cruiser 18; `@playwright/test` is **Epic 5**, do not add it). TDD per story; Conventional Commits; ISO-8601 UTC; `ERROR:` + `HINT:` on stderr; agent-callable commands prompt-free.

### Cohort & Dependencies section — required in every story, and DIFFERENT this epic

**Read Step 5 before writing this section.** Epic 4 launches as **three sequential cohorts**, not one. That changes the block's content: an agent's peers are only the agents in *its own* cohort, and its predecessors are already merged rather than concurrently running.

Facts to design around:

- Agents self-configure after reading the spec: `~/.terminal-agents/scripts/set-cohort.sh <peers>` and `~/.terminal-agents/scripts/set-depends-on.sh <agent>:done` (`done` = PR **merged**; never `pr-opened`).
- **Put `set-depends-on.sh` AFTER the intent-sync step** (H-10). Word it: complete intent-sync first, then set the marker.
- **One `waiting_for` marker per agent** — successive calls REPLACE. Multi-predecessor stories wait sequentially, and **check whether the predecessor already merged before setting a marker** (`gh pr list --base epic/4-behavioral-verification --state merged --search "<task-id>"`, or the peer's `status.json` `phase: done`).
- **Rebase after an unblock, with the right command:** `git fetch origin`, then `git rebase --onto origin/epic/4-behavioral-verification <sha-of-your-last-merged-commit>` (H-4). **If your own PR is already merged, ignore a rebase nudge** (H-3).
- **Within a cohort, file ownership must be disjoint.** Across cohorts, sequencing does the work — but say in both stories when two touch one file.
- Agent names come from the harness pool (`alice bob pamela arnold rambo chuck predator`, in that order). Assume positional assignment per cohort and tell agents to depend on the *story-id holder* if `tmux-overview.sh` shows otherwise.

## Step 4 — Dependency graph (derive from the imports you actually specify)

- **4.1, 4.2** — no depends-on. **4.2 is the critical path**: every wave-B story compiles into or reads its Plan schema. Keep its scope tight and tell its agent to PR early.
- **4.3, 4.4, 4.5, 4.6** — each depends on 4.2 (Plan schema). 4.3 additionally publishes the data-binding shape the three surface stories consume — **decide explicitly whether 4.4/4.5/4.6 depend on 4.3's merge or only on 4.2's**, and say which in every affected story. (Recommendation: 4.3 in cohort 2 alongside them, with the binding shape published at intent-sync, so the three surfaces are not serialized behind it.)
- **4.7** — depends on all of wave B plus 4.1.

## Step 5 — Three sequential cohorts (NEW — this is the launch model)

Epic 3 ran eight agents in one cohort and paid for it: **three subscription-limit freezes cost ~7.5 hours**, which the Epic 3 retrospective raised as owner action item C. The owner's decision (2026-09-01) is to run Epic 4 as **three sequential cohorts against one long-lived feature branch**.

```
master
  └── epic/4-behavioral-verification          ← created once, before cohort 1
        ├── cohort 1 (wave A):  4.1, 4.2                     → PRs → epic branch
        ├── cohort 2 (wave B):  4.3, 4.4, 4.5, 4.6           → PRs → epic branch
        └── cohort 3:           4.7 + retrospective          → PRs → epic branch
                                                                    │
        epic branch ──────── one PR ────────────────────────────────┴──→ master
```

What this means for the stories you write:

- **The epic branch is created once and survives all three cohorts.** Every story PR targets `epic/4-behavioral-verification`. Only the final PR merges to `master`, after cohort 3.
- **Each story's `set-cohort.sh` lists only its OWN cohort's peers** — not all six others. Cohort 1: `4.1, 4.2` are each other's only peer. Cohort 2: `4.3, 4.4, 4.5, 4.6`. Cohort 3: `4.7` alone (no peers; say so explicitly rather than leaving the line out).
- **Cross-cohort dependencies are already merged when a later cohort starts**, so wave-B stories should NOT set a `depends-on` marker for 4.2 — it merged before they launched. **Say this in each story**: "your predecessors merged before you started; verify with `gh pr list ... --state merged` and do not set a marker for them." Getting this wrong costs an agent a pointless block loop.
- **Intent-sync happens per cohort.** Wave-B agents cannot negotiate with 4.2's author — that agent is gone. So **everything a wave-B story needs from 4.2 must be in 4.2's merged code and in the spec you write**, not deferred to a live conversation. This is the single biggest difference from Epic 3 and the thing most likely to go wrong. Where Epic 3 said "settle it in intent-sync with X", Epic 4 must instead say "X's merged source is the contract; read it".
- **Cohort 3 runs the retrospective.** 4.7's agent (or a supervisor) writes `docs/findings/epic-4-retro-<date>.md` following the shape of the three existing retros, and the final PR to `master` carries the epic. Say in 4.7 that closure bookkeeping and the retro are part of its cohort.
- Tell each story **which cohort it is in and why**, so an agent reading only its own spec understands why some peers are absent and some predecessors are already history.

## Step 6 — Close out

1. Update `docs/implementation-artifacts/sprint-status.yaml`: the seven Epic 4 stories → `ready-for-dev`, `epic-4` → `in-progress`; then run `uv run .claude/skills/bmad-sprint-planning/scripts/sprint_plan.py validate --status-file docs/implementation-artifacts/sprint-status.yaml` and require `"valid": true`.
2. Update the "Current phase" paragraph in `CLAUDE.md`: Epic 3 merged 2026-09-01 (`26a6335`, 8 stories incl. 3.8 and two 3.1 follow-ups); production code under `src/` now covers CLI, domain core, config, ingest, contract authoring, providers, the staged pipeline, worktree isolation, process groups, gates, run persistence and renderers; Epic 4 stories authored; retrospectives and the harness-defect record in `docs/findings/`. Keep everything else as is.
3. **Do not modify roadmap.md, epics.md, the PRD, the spine or the ADRs.** If you believe one is wrong, say so in your final report as a question.
4. Commit with a Conventional Commits message (e.g. `docs: add Epic 4 implementation-ready story files`) and **push to `origin/master`** — the harness's spec-on-origin guard refuses to launch a cohort whose specs are not on origin.
5. Report: created files; **three launch commands, one per cohort**, in the expected shape:
   ```
   # cohort 1 (wave A) — creates the epic branch
   ~/.terminal-agents/scripts/launch-task.sh --project specwitness \
     --supervised --supervisor-stage 3 \
     --base epic/4-behavioral-verification --max 2 \
     4.1-service-lifecycle-readiness \
     4.2-plan-model-compilation-via-plan-author-provider

   # cohort 2 (wave B) — after cohort 1's PRs are merged into the epic branch
   ~/.terminal-agents/scripts/launch-task.sh --project specwitness \
     --supervised --supervisor-stage 3 \
     --base epic/4-behavioral-verification --max 4 \
     4.3-deterministic-test-data \
     4.4-http-probe-executor \
     4.5-observation-probes-before-after-invariants \
     4.6-shell-probes

   # cohort 3 — integration + retrospective
   ~/.terminal-agents/scripts/launch-task.sh --project specwitness \
     --supervised --supervisor-stage 3 \
     --base epic/4-behavioral-verification --max 1 \
     4.7-ai-free-behavioral-verify-end-to-end
   ```
   **These three commands were verified against `~/.terminal-agents/scripts/launch-task.sh` on 2026-09-01** — do not re-derive them, but do re-check if the harness has changed since:
   - **Cohort 1 creates the branch.** `launch-task.sh:570-590`: when `origin/<base>` does not exist and `--supervised` is set, it creates the branch from `origin/master` and pushes it **without prompting**. Cohorts 2 and 3 then find it existing and simply use it — `spawn-agent.sh:184` only *requires* the base to exist on origin, it never recreates it.
   - **A supervisor is spawned per cohort**, named from the epic branch (`SUPERVISOR_TASK="supervisor-epic-${EPIC_BRANCH#epic/}"`, `launch-task.sh:353`). Each cohort therefore gets a fresh supervisor on the same epic branch; the previous one must be cleaned up between cohorts (`cleanup-agent.sh superman --force --archive`).
   - **`--names` is unnecessary** at these sizes: the default pool (`alice bob pamela arnold rambo chuck predator`) covers 2, 4 and 1 tasks positionally. Agent↔task mapping is by position within each cohort, so cohort 2's `alice` is 4.3, not 4.1 — **say this in the stories**, because an agent that assumes Epic 3's mapping will depend on the wrong peer.

   Then: any ambiguities as questions at the end (SAVE QUESTIONS rule) — at minimum:
   - confirm whether **4.4/4.5/4.6 depend on 4.3's merge** or only on 4.2's (Step 4);
   - confirm **who owns the surface-conformance test** proving all executors behave identically;
   - confirm the **`src/surfaces/**` dependency-cruiser question** (already covered by `adapters-core-only`, or a new rule with one owner);
   - confirm the two **owner-assigned riders** (debt 1 → 4.1, debt 2 → 4.7) survived contact with the actual scope;
   - state plainly which Epic 4 exit criteria **no agent can satisfy** (any CI-executed step, Linux, Node exactly 22.12, real-CLI provider invocations) so they are reported pending-owner rather than passed;
   - and confirmation that no planning artifacts were modified and no production code was written.
