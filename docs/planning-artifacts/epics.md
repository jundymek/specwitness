---
stepsCompleted: [step-01-validate-prerequisites, step-02-design-epics, step-03-create-stories, step-04-final-validation]
inputDocuments:
  - docs/specwitness-input-brief.md
  - docs/specwitness-input-brief-part2.md
  - docs/planning-artifacts/prds/prd-specwitness-2026-08-30/prd.md
  - docs/planning-artifacts/prds/prd-specwitness-2026-08-30/addendum.md
  - docs/planning-artifacts/architecture/architecture-specwitness-2026-08-30/ARCHITECTURE-SPINE.md
  - docs/adr/ADR-001..006 + ADR-INDEX
generatedBy: headless autonomous planning session 2026-08-30 (approval gates recorded as pending author review)
---

# specwitness (SpecWitness) - Epic Breakdown

## Overview

Complete epic and story breakdown for SpecWitness V0, decomposing the PRD (FR-1..FR-34), the Architecture Spine (AD-1..AD-13), and ADR-001..006 into implementable stories. Sized for the author's harness: max 7 stories per epic, one story per coding agent, epics standalone with backward-only dependencies.

## Requirements Inventory

### Functional Requirements

FR-1: Initialize SpecWitness in a project (`init`)
FR-2: Trusted project configuration (validated; sole source of executable commands)
FR-3: Doctor diagnostics (runtime, providers, billing-risk, project)
FR-4: Stack independence (config-driven; non-Node targets work)
FR-5: BMAD epic/story ingestion (v6 layout, configurable roots)
FR-6: Normalized EpicSpec (source-format-independent seam)
FR-7: Contract generation (provider-drafted criteria)
FR-8: Human review & freeze (fingerprint; only frozen contracts gate)
FR-9: Integrity validation (fingerprint checked before every run)
FR-10: Explicit amendment (versioned supersede, human-confirmed)
FR-11: AgentProvider abstraction with roles (contract-author / plan-author / explainer)
FR-12: Claude Code CLI adapter
FR-13: Codex CLI adapter
FR-14: Structured output validation (versioned schemas, bounded recorded retries)
FR-15: Billing safety (no API keys required; env withholding; warnings)
FR-16: Plan compilation (probes + assertions per criterion; human criteria carried)
FR-17: Deterministic test data (fixed at compile time)
FR-18: AI-free re-execution (verify with zero provider calls)
FR-19: Isolated worktree execution (root/base/head explicit; epic-id normalization)
FR-20: Deterministic gates with early stop
FR-21: Service lifecycle & readiness
FR-22: Failure classification (gate / criterion / infrastructure — exactly one)
FR-23: HTTP probes
FR-24: Browser probes (Playwright)
FR-25: Observation probes (before/after JSON commands)
FR-26: Shell probes (config-id constrained)
FR-27: Mechanical verdict aggregation & exit codes (0/1/2/3/64)
FR-28: Typed evidence with redaction
FR-29: Terminal report (bounded, ISO-8601 UTC)
FR-30: Stable JSON output (schemaVersion, snapshot-tested)
FR-31: Run storage (`.specwitness/runs/<run-id>/`; `report` re-renders)
FR-32: Flakiness semantics (retries recorded, flaky surfaced, never silent)
FR-33: Run scorecard (local metrics per run)
FR-34: Defect attribution (unique/duplicate/false-positive; summary)

### NonFunctional Requirements

NFR-1: Never read/copy/persist agent-CLI credentials; auth stays with official CLIs (brief §22–23)
NFR-2: Trusted-command boundary — only Project-Config-declared commands reach a shell (AD-3)
NFR-3: Secrets redacted at evidence capture (AD-10)
NFR-4: Local-first — no cloud, no accounts, no telemetry (brief §43, §54)
NFR-5: Determinism & reproducibility — no silent retry-to-green (brief §48–49)
NFR-6: Target-project stack independence (brief §28)
NFR-7: Stable machine contract — versioned JSON schema, predictable exit codes (brief §37–38)
NFR-8: Agent-callable — no TTY on verify path, bounded terminal output (harness survey)
NFR-9: Reliable cleanup — no orphaned processes/worktrees, crash-safe manifests (brief §17)
NFR-10: SpecWitness self-testing bar — Golden Corpus with hand-written expected outcomes (brief §50–51)

### Additional Requirements

- AR-1: Architecture guardrails enforced in CI (AD-1 dependency direction).
- AR-2: TDD per story; unit (domain), integration (adapters), e2e (corpus) layers per brief §51.
- AR-3: Revisions (base+head) recorded per run so differential verification bolts on later (brief §40).
- AR-4: Repair-friendly failure output — per-criterion expected/actual/evidence pointers (brief §39).
- AR-5: House CLI style — `ERROR:`/`HINT:` on stderr, rc=64 usage errors, ISO-8601 UTC timestamps.

### UX Design Requirements

None — terminal-native CLI only (PRD non-goal: no web UI). Terminal report shape is defined in FR-29/brief §36.

### FR Coverage Map

FR-1: Epic 1 — init scaffolding
FR-2: Epic 1 — config model & validation
FR-3: Epic 1 — runtime/project doctor; Epic 2 — provider checks
FR-4: Epic 1 — config-driven design; Epic 6 — non-Node fixture proof
FR-5: Epic 2 — BMAD ingestion
FR-6: Epic 2 — EpicSpec model
FR-7: Epic 2 — contract generation
FR-8: Epic 2 — freeze & fingerprint
FR-9: Epic 2 — integrity model; Epic 3 — runtime enforcement
FR-10: Epic 2 — amendment flow
FR-11: Epic 2 — provider port & roles; Epic 5 — explainer role
FR-12: Epic 2 — Claude adapter
FR-13: Epic 2 — Codex adapter
FR-14: Epic 2 — structured output validation
FR-15: Epic 2 — billing safety
FR-16: Epic 4 — plan compilation; Epic 5 — human criteria
FR-17: Epic 4 — deterministic data
FR-18: Epic 4 — AI-free verify; Epic 5 — mechanics adaptation boundary
FR-19: Epic 3 — worktree isolation
FR-20: Epic 3 — gates & early stop
FR-21: Epic 3 — process lifecycle/cleanup; Epic 4 — services & readiness
FR-22: Epic 1 — taxonomy; Epic 3 — pipeline classification
FR-23: Epic 4 — HTTP probes
FR-24: Epic 5 — browser probes
FR-25: Epic 4 — observation probes
FR-26: Epic 4 — shell probes
FR-27: Epic 1 — exit table & aggregation fn; Epic 4 — end-to-end wiring
FR-28: Epic 3 — gate evidence; Epic 4 — probe evidence & redaction
FR-29: Epic 3 — terminal report
FR-30: Epic 3 — JSON output
FR-31: Epic 3 — run storage & report command
FR-32: Epic 5 — flakiness semantics
FR-33: Epic 6 — scorecard recording; Epic 7 — real-usage data
FR-34: Epic 6 — attribution & summary; Epic 7 — hypothesis verdict

## Epic List

### Epic 1: Install, Configure & Diagnose
A developer can install SpecWitness in any repository, declare their project's commands, and get a trustworthy `doctor` diagnosis — the CLI foundation every later epic ships inside.
**FRs covered:** FR-1, FR-2, FR-3 (partial), FR-4, FR-22 (taxonomy), FR-27 (exit table, aggregation)

### Epic 2: Verification Contracts from BMAD Epics
A developer can turn a BMAD epic into a reviewed, frozen, tamper-evident Verification Contract using their locally installed agent CLI — no API keys, either provider, or a fake for tests.
**FRs covered:** FR-3 (provider checks), FR-5..FR-15

### Epic 3: Isolated Deterministic Verification
A developer can run `specwitness verify` and get a real merge-gate verdict from deterministic gates executed in an isolated worktree — with terminal report, stable JSON, exit codes, run storage, and reliable cleanup. First end-to-end usable gate.
**FRs covered:** FR-9 (runtime), FR-19, FR-20, FR-21 (partial), FR-22, FR-28 (partial), FR-29, FR-30, FR-31

### Epic 4: Behavioral Verification over HTTP & State
A developer's frozen contract compiles into a persisted executable plan; verify starts services, waits for readiness, executes HTTP/observation/shell probes with deterministic data, and aggregates criterion results into the verdict — rerunnable with zero AI calls.
**FRs covered:** FR-16, FR-17, FR-18, FR-21, FR-23, FR-25, FR-26, FR-27 (full), FR-28

### Epic 5: Browser Verification & Human Judgment
Criteria needing a real browser run through standard Playwright with traces as evidence; subjective criteria flow to NEEDS_HUMAN honestly; flakiness is recorded, never hidden; optional non-authoritative failure explanations.
**FRs covered:** FR-11 (explainer), FR-16 (human), FR-18 (mechanics boundary), FR-24, FR-32

### Epic 6: Trust — Golden Corpus & Dogfooding Scorecard
SpecWitness proves its own classification integrity against hand-written expected outcomes (including a non-Node target) and measures its product hypothesis locally — ready for real dogfooding.
**FRs covered:** FR-4 (proof), FR-33, FR-34; NFR-10

### Epic 7: Real Dogfooding & Value Measurement
SpecWitness gates at least one real epic produced by the author's harness end-to-end (contract before cohort, verify before merge, repair loop if needed) and produces the first evidence-based answer to the product hypothesis. Operator-led epic — brief §66–67: MVP is not complete on synthetic tests alone.
**FRs covered:** exercises FR-1..FR-32 in production conditions; FR-33/FR-34 with real data

**Dependencies:** strictly backward: E2 uses E1's config/CLI; E3 uses E2's contracts; E4 uses E3's pipeline; E5 uses E4's probe framework; E6 exercises everything; E7 uses the shipped tool on real harness work. No epic requires a later epic to function.

---

## Epic 1: Install, Configure & Diagnose

Developers (and the author's harness) can install the `specwitness` npm package into any repository, scaffold `.specwitness/`, declare project commands in validated config, and run `doctor` for a trustworthy readiness diagnosis. Ships the domain taxonomy, exit-code table, and architecture guardrails all later epics build on.

### Story 1.1: CLI package skeleton with exit-code contract

As a developer,
I want an installable `specwitness` CLI with command routing, house-style errors, and the single exit-code table,
So that every later feature ships inside a consistent, scriptable binary.

**Acceptance Criteria:**

**Given** the package is built and linked
**When** I run `specwitness --help` or an unknown command/flag
**Then** help renders, and the unknown invocation prints `ERROR: <what>` plus `HINT: <how to fix>` on stderr and exits 64
**And** no code path outside `cli/exit.ts` defines a process exit code (verified by test).

**Given** any command throws an unclassified exception
**When** the CLI terminates
**Then** it exits 3 (infrastructure), never 0/1/2 (fail closed per AD-7).

**Given** the repo's CI
**When** the build runs
**Then** tsup produces an executable `bin` entry, vitest runs green, and the `engines` field enforces Node >=22.12 (Node 20 is EOL and commander 15/execa 10/dependency-cruiser 18 all require >=22.12 — spine review finding).

**Given** the pinned dependency majors (commander 15, execa 10, zod 4)
**When** this story's dev notes are written
**Then** a short breaking-change review against the previous majors (commander 14→15, execa 9→10) is recorded, per the spine version-reality review.

### Story 1.2: Domain core — result taxonomy, errors, verdict aggregation

As a harness automating merges,
I want the closed result taxonomy and a pure mechanical verdict function,
So that outcomes are classified identically everywhere and no AI or I/O can influence a verdict.

**Acceptance Criteria:**

**Given** the enums `CriterionStatus {pass|fail|needs_human|skipped|error}`, gate results, and the run outcome union
**When** aggregation runs over any combination of criterion results
**Then** it returns FAIL if any `fail`; else infra error if any `error`; else NEEDS_HUMAN if any `needs_human`; else PASS — as a pure function with property-based unit tests (AD-6).

**Given** the typed error hierarchy (UsageError, ConfigError, IngestError, IntegrityError, ProviderError, InfraError — gate failure is a stage result, not an exception, per AD-6/AD-7)
**When** each error type and run outcome maps through the exit table
**Then** the mapping matches ADR-002 (0/1/2/3/64), a gates-only green run aggregates to PASS, a failed gate aggregates to FAIL+gateFailed, and all of it is covered by tests.

**Given** `src/domain/` and `src/schemas/`
**When** the dependency-direction check runs
**Then** no import from adapter layers or side-effectful Node built-ins exists (AD-1 enforced by lint/dependency-cruiser in CI).

### Story 1.3: Project configuration model & validation

As a developer on any stack,
I want to declare setup, gates, services, data, observations, and AI roles in `.specwitness/config.yaml` and get actionable validation errors,
So that SpecWitness learns my project only through trusted configuration (AD-3).

**Acceptance Criteria:**

**Given** a valid config file
**When** it loads
**Then** a typed, zod-validated config object is produced carrying declared gates (ordered), services (command + readiness), observation commands by id, and provider role assignments.

**Given** an invalid config (unknown key, missing field, wrong type)
**When** any command loads it
**Then** the command exits 3 with `ERROR:` naming the YAML path and reason plus a `HINT:`, before executing anything.

**Given** config values that are command strings
**When** any component wants to execute a command
**Then** the only API available requires a config-declared entry (no arbitrary string execution path exists in the codebase).

### Story 1.4: `specwitness init`

As a developer adopting SpecWitness,
I want `specwitness init` to scaffold `.specwitness/` with a commented config skeleton,
So that onboarding is one command in any Git repository (FR-1).

**Acceptance Criteria:**

**Given** a Git repository without SpecWitness (any stack, no Node project required)
**When** I run `specwitness init`
**Then** `.specwitness/` is created with `config.yaml` skeleton (commented examples for gates/services/observations/ai) and `contracts/`, `plans/`, `runs/` directories, and the command reports what was created.

**Given** an existing `.specwitness/config.yaml`
**When** I run `specwitness init` again
**Then** nothing is overwritten without explicit `--force`, and the command says so with exit 0.

**Given** a directory that is not a Git repository
**When** I run `specwitness init`
**Then** it refuses with a named error and `HINT:` (exit 3).

### Story 1.5: `specwitness doctor` — runtime & project diagnostics

As a developer,
I want `doctor` to check my runtime and project configuration,
So that I trust failures are diagnosed before they masquerade as verification errors (FR-3).

**Acceptance Criteria:**

**Given** a project with config
**When** I run `specwitness doctor`
**Then** it reports pass/warn/fail per check: Node version, Git present, Playwright capability, config validity, base branch exists, declared gate/service/observation commands resolvable — and exits non-zero iff a required check fails.

**Given** `--json`
**When** doctor runs
**Then** a stable JSON checks array (id, status, detail) is emitted with an ISO-8601 UTC timestamp.

**Given** doctor's check registry
**When** Epic 2 adds provider checks
**Then** they plug into the same registry without modifying existing checks (extension seam demonstrated by test).

### Story 1.6: Run storage foundation & run identifiers

As a harness consuming results,
I want every run persisted under `.specwitness/runs/<run-id>/` with canonical ids and timestamps,
So that later epics write results/evidence into a stable, local-first layout (FR-31 foundation).

**Acceptance Criteria:**

**Given** a new run
**When** the run store creates it
**Then** the id matches `run-<YYYYMMDDTHHmmssZ>-<4 base36>`, a `manifest.json` skeleton exists before any resource use, and all timestamps are ISO-8601 UTC.

**Given** `Clock` and `Ids` ports
**When** domain/application tests run
**Then** both are injectable fakes (no real time/randomness in unit tests) per AD-9.

**Given** run directories exist
**When** `specwitness report <run-id>` (stub) is invoked
**Then** stored run metadata is located and rendered (full rendering arrives in Epic 3).

---

## Epic 2: Verification Contracts from BMAD Epics

A developer can point SpecWitness at a BMAD epic and get a provider-drafted, human-reviewed, frozen, tamper-evident Verification Contract. Works with Claude Code alone, Codex alone, or both; never touches credentials; validated structured output only.

### Story 2.1: BMAD v6 ingestion to EpicSpec

As a BMAD user,
I want SpecWitness to read my epic, stories, and acceptance criteria into a normalized EpicSpec,
So that contract generation is isolated from planning-artifact formats (FR-5, FR-6).

**Acceptance Criteria:**

**Given** configurable artifact roots (defaults `docs/planning-artifacts`; first-client override `docs/planning-artifacts` + `docs/implementation-artifacts`)
**When** I ingest `epic-7` (input accepted as `7`, `epic-7`, or `epic-07`)
**Then** the EpicSpec contains the epic id/title/goal and every story with its numbered acceptance criteria verbatim, with source file references.

**Given** per-story markdown files (`## Story`, `## Acceptance Criteria` numbered lists) and/or the epics file
**When** either layout variant is present
**Then** ingestion succeeds from both (fixtures for both variants).

**Given** an epic that cannot be found or parsed
**When** ingestion runs
**Then** an IngestError names what was searched and where (exit 3), and no empty EpicSpec is produced.

**Given** the EpicSpec type
**When** downstream code is compiled
**Then** no BMAD-specific types are imported outside `ingest/` (AD-1 boundary test).

### Story 2.2: Contract model, canonical serialization & fingerprint

As the product's trust anchor,
I want the Contract domain model with canonical serialization and SHA-256 fingerprinting,
So that freeze is verifiable and silent tampering is detectable (FR-8, FR-9, AD-5).

**Acceptance Criteria:**

**Given** a Contract (top-level `spec` — epic ref, version, criteria with id/statement/kind/severity/verifiability — and top-level `meta` — fingerprint, frozen flag, timestamps, version history; AD-5 partition)
**When** it is serialized
**Then** the YAML is human-readable/PR-reviewable, round-trips losslessly through the versioned zod schema (`schemaVersion` present), and criterion ids follow the canonical `E<n>-<NN>` format (`E7-01`).

**Given** the canonical serializer (sorted keys, LF, trimmed strings, hashing `spec` only — `meta` never fingerprinted)
**When** the same content is fingerprinted twice — including after cosmetic YAML reformatting
**Then** fingerprints are identical; any semantic change (one character in a statement) changes the fingerprint.

**Given** a frozen contract whose content was modified post-freeze
**When** integrity validation runs
**Then** an IntegrityError is raised (distinct from FAIL/PASS), matching Golden Corpus fixture 9 semantics.

### Story 2.3: AgentProvider port, roles & structured-output gate

As an architect of the AI boundary,
I want the provider port with role assignment, a FakeAgentProvider, and schema-gated responses with bounded recorded retries,
So that no free-form model output ever becomes state and domain tests never spawn real CLIs (FR-11, FR-14, AD-2).

**Acceptance Criteria:**

**Given** roles `contract-author`, `plan-author`, `explainer` in config
**When** a role is invoked
**Then** the assigned provider is used; any role can map to any single configured provider; unassigned optional roles degrade gracefully.

**Given** a provider response
**When** it fails schema validation
**Then** a retry with the validation errors appended is attempted at most N times (default 2), each attempt recorded (count + rejected payload stored), then a ProviderError (exit-3 class) is raised — never a partial artifact.

**Given** FakeAgentProvider
**When** the domain/application test suite runs
**Then** zero real subprocesses are spawned and all contract-generation logic is covered through the fake.

### Story 2.4: Claude Code CLI adapter

As a Claude Max subscriber,
I want SpecWitness to delegate drafting to my local `claude` CLI non-interactively,
So that I need no API key and my auth stays with the official tool (FR-12, FR-15, NFR-1, ADR-001).

**Acceptance Criteria:**

**Given** the adapter
**When** it invokes claude
**Then** it uses the probed non-interactive form (baseline `-p --output-format json`), runs via ProcessRunner with timeout, and parses only the structured envelope.

**Given** capability probing
**When** the local claude lacks required capabilities or is absent
**Then** a capability error is reported and surfaced through doctor — no hardcoded assumption beyond the tested minimum.

**Given** subscription mode
**When** the subprocess environment is constructed
**Then** `ANTHROPIC_API_KEY` (and configured equivalents) are withheld from the child env; the parent env is never mutated; a warning names the variable when present.

**Given** the entire adapter codebase
**When** reviewed/tested
**Then** no path reads `~/.claude/` or any credential store (NFR-1; static check + review checklist).

### Story 2.5: Codex CLI adapter

As a ChatGPT-OAuth Codex user,
I want the same delegation through `codex exec` with schema-constrained output,
So that either provider alone fully powers SpecWitness (FR-13, FR-15, brief §25).

**Acceptance Criteria:**

**Given** the adapter
**When** it invokes codex
**Then** it uses `codex exec` with `--output-schema <generated schema file>` and `-C <dir>`, capturing the final message deterministically (`--output-last-message`).

**Given** OPENAI_API_KEY present in chatgpt mode
**When** the subprocess env is built
**Then** the variable is withheld and a billing warning emitted (same contract as 2.4).

**Given** only Codex configured (no Claude)
**When** contract generation runs end-to-end (mocked binary in integration tests)
**Then** it succeeds — no hardcoded dependency on any specific provider (verified symmetrically for Claude-only in 2.4's tests).

### Story 2.6: `specwitness contract <epic>` — generate, review, freeze, status

As an epic owner,
I want to generate a draft contract, review/edit it, and explicitly freeze it before the cohort starts,
So that the definition of done is captured independent of future implementation (FR-7, FR-8; UJ-1).

**Acceptance Criteria:**

**Given** an EpicSpec and a configured contract-author provider
**When** I run `specwitness contract epic-7`
**Then** a draft `.specwitness/contracts/epic-7.yaml` is written whose criteria have stable ids (`E7-01`…), behavioral statements, kind, severity, verifiability — and statements containing implementation coupling (function/class/method references) are flagged in command output for review.

**Given** a reviewed draft
**When** I run `specwitness contract epic-7 --freeze`
**Then** the fingerprint is computed and stored, status becomes frozen, and the command prints the fingerprint; re-freezing an unchanged frozen contract is idempotent (exit 0, same fingerprint).

**Given** `specwitness contract epic-7 --status [--json]`
**When** invoked (including from a no-TTY agent context)
**Then** it reports existence, frozen/draft state, version, fingerprint, and criteria counts without prompting (NFR-8; PRD open question 6 satisfied via --json).

**Given** verify semantics
**When** a contract is absent or never frozen
**Then** `verify` refuses with `HINT:` to run the contract workflow (discipline stance from PRD open question 4).

### Story 2.7: Amendment flow, runtime integrity & provider doctor checks

As the human authority over expected behavior,
I want contract changes to be possible only through an explicit, versioned, confirmed amendment — and provider readiness visible in doctor,
So that agents cannot silently redefine done (FR-9, FR-10, FR-3 completion; UJ-5; ADR-005).

**Acceptance Criteria:**

**Given** a frozen contract
**When** I run `specwitness contract epic-7 --amend` in an interactive terminal and confirm
**Then** a new version is created referencing the superseded version, re-reviewed and re-frozen; the audit trail (who/when/what changed) is preserved in the contract file's version history.

**Given** a no-TTY context (agent invocation)
**When** `--amend` is invoked
**Then** it refuses with `ERROR:`/`HINT:` explaining amendments are an operator action (ADR-005 stance) — it does not fall back to a flag-only path.

**Given** doctor
**When** run with providers configured
**Then** per provider it reports: binary found, version, non-interactive capability, auth-appears-usable (probed only via the CLI's own public behavior — e.g. `codex doctor` / exit codes), configured mode, and ⚠ billing-risk env vars — without reading credential files (NFR-1).

---

## Epic 3: Isolated Deterministic Verification

`specwitness verify epic-7` becomes a real merge gate: frozen-contract integrity check, isolated worktree, deterministic gates with early stop, classified outcomes, terminal + JSON reports, stable exit codes, persisted runs, and crash-safe cleanup. Delivers standalone value before behavioral probes exist (gates-only verification).

### Story 3.1: Revision resolution & isolated worktree

As a supervisor invoking verify from my own worktree,
I want SpecWitness to resolve root/base/head explicitly and execute in a detached temp worktree,
So that my workspace and the source repo are never touched (FR-19, AD-8; UJ-2).

**Acceptance Criteria:**

**Given** `--root <dir>` (or CWD containing the repo), `--base <ref>`, `--head <ref>` (head may be a remote-only ref like `origin/epic/7-slug`; defaults from config; epic-id normalization applied)
**When** verify starts
**Then** head is resolved to a SHA (fetching if needed is NOT done implicitly — a missing ref yields a named error with `HINT: git fetch`), and a detached worktree is created under the OS temp dir.

**Given** any run end — success, failure, or SIGKILL mid-run
**When** the source repo is inspected afterward
**Then** `git status` is unchanged and no worktree remains registered after cleanup/`clean` (integration test kills the process mid-run).

**Given** an ambiguous or unresolvable root
**When** verify starts
**Then** it refuses with a named error rather than guessing (house rule from harness survey).

### Story 3.2: Process groups, run manifest & `specwitness clean`

As an operator whose machine must stay clean,
I want every spawned process tracked in process groups recorded in the run manifest, with teardown and a reaper command,
So that crashes never leak services or worktrees (FR-21 partial, NFR-9, AD-8).

**Acceptance Criteria:**

**Given** ProcessRunner
**When** it spawns any command
**Then** the child gets its own process group; the pgid and worktree path land in `manifest.json` (schema-versioned, fsynced before resource use — RunStore is the sole runs-directory writer per AD-8) before use; teardown kills the group (SIGTERM then SIGKILL after grace).

**Given** execa 10's process-group/detach semantics on macOS (flagged unverified by spine review)
**When** integration tests run on macOS and Linux
**Then** a spawned service's grandchildren are demonstrably killed at teardown (test with a shell that forks a child), or ProcessRunner falls back to explicit `process.kill(-pgid)` handling.

**Given** a previous crashed run left resources
**When** I run `specwitness clean` (or `--all`)
**Then** manifests are replayed: live pgids killed, stale worktrees removed, results reported; already-clean manifests are marked reaped.

**Given** a long-running command exceeding its timeout
**When** the timeout fires
**Then** the process group is terminated and the outcome classified InfraError or GateFailure per context — never a hang.

### Story 3.3: Staged pipeline state machine

As the architecture's backbone,
I want verify to run as named stages with typed stage results and early-stop semantics,
So that classification, timing, and reporting are uniform and 7 agents share one execution model (FR-20, FR-22, AD-6/7/11).

**Acceptance Criteria:**

**Given** the stage sequence (resolve → integrity → worktree → setup → gates → services → data → probes → aggregate → persist → teardown)
**When** any stage fails
**Then** later stages are skipped (teardown always runs), the failure is classified through the AD-7 hierarchy, and the stage timeline (per-stage status + duration) appears in the RunResult.

**Given** the integrity stage
**When** the contract fingerprint mismatches
**Then** the run ends as IntegrityError (exit 3) with zero commands executed in the worktree (FR-9 runtime).

**Given** stage results
**When** unit tests exercise the state machine with faked stages
**Then** every early-stop path and the always-teardown guarantee are covered without real I/O.

### Story 3.4: Deterministic gates execution

As a cost-conscious operator,
I want configured gates to run in order with captured evidence and early stop,
So that a broken branch fails fast before any AI/browser spend (FR-20, FR-28 partial; ADR-003).

**Acceptance Criteria:**

**Given** ordered gates in config (e.g. install, lint, typecheck, unit, build)
**When** all pass
**Then** each gate's duration and truncated output land as gate evidence and the pipeline proceeds.

**Given** a failing gate
**When** it exits non-zero
**Then** the run ends with Verdict FAIL + `gateFailed: <id>`, remaining gates and all criteria reported `skipped`, the gate's stdout/stderr stored as evidence (bounded inline, full in run dir), exit code 1 (ADR-003 semantics; Golden Corpus fixture 7).

**Given** a gate command that cannot start (missing binary)
**When** execution is attempted
**Then** the outcome is InfraError (exit 3), not FAIL (classification test).

### Story 3.5: RunResult persistence & `specwitness report`

As a harness and a human revisiting results,
I want the complete RunResult persisted per run and re-renderable,
So that evidence outlives the terminal session (FR-31, FR-30 partial; AR-4).

**Acceptance Criteria:**

**Given** a completed run (any outcome)
**When** persistence executes
**Then** `.specwitness/runs/<run-id>/result.json` (schemaVersion, epic, base/head SHAs, verdict/infra outcome, stage timeline, gate results, criterion results with expected/actual and evidence refs, provider usage, timestamps) plus evidence files exist locally.

**Given** `specwitness report epic-7` or `specwitness report <run-id>` (`--json`)
**When** invoked later
**Then** the stored run renders (latest for the epic by default) without re-executing anything.

**Given** the schemaVersion contract
**When** the JSON snapshot test runs
**Then** unintended shape changes fail CI (NFR-7).

### Story 3.6: Terminal & JSON renderers

As a supervisor reading results inside an agent context,
I want the sectioned terminal report and `--json` derived from one RunResult,
So that human and machine views never drift and output stays bounded (FR-29, FR-30, AD-11, NFR-8; brief §36–37).

**Acceptance Criteria:**

**Given** a RunResult
**When** the terminal renderer runs
**Then** it prints: contract status + fingerprint validity, base/head, environment summary, per-gate ✓/✗, per-criterion ✓/✗/? with one-line summaries, counts (PASS/FAIL/NEEDS_HUMAN), VERDICT, and the run evidence path — with any long output truncated to a cap plus a pointer to the full file.

**Given** `--json`
**When** verify or report runs
**Then** stdout carries only the JSON document (parseable by `JSON.parse`), everything human goes to stderr, and content equals the persisted `result.json`.

**Given** both renderers
**When** tested
**Then** neither computes facts absent from RunResult (renderers are pure over the model).

### Story 3.7: End-to-end gates-only verify

As the epic's integration proof,
I want `specwitness verify` wired end-to-end for a contract-bearing project with gates only,
So that SpecWitness is a usable (if behavioral-probe-less) merge gate at epic end (UJ-2 partial).

**Acceptance Criteria:**

**Given** a fixture project with a frozen contract and passing gates
**When** `specwitness verify epic-1 --json` runs
**Then** exit 0 with verdict PASS, criteria reported `skipped`/`needs_human` as appropriate (no probes yet), and a persisted run.

**Given** the same fixture with a broken build
**When** verify runs
**Then** exit 1, `gateFailed`, matching ADR-003 exactly.

**Given** a fixture where the worktree cannot be created (corrupt ref)
**When** verify runs
**Then** exit 3 InfraError with `HINT:` — demonstrating the three-way classification live (FR-22).

---

## Epic 4: Behavioral Verification over HTTP & State

The frozen contract compiles into a persisted executable plan; verify boots services with readiness, executes HTTP/observation/shell probes with deterministic data, attaches redacted evidence, and derives criterion results and the final verdict mechanically — repeatably, with zero AI calls after compilation.

### Story 4.1: Service lifecycle & readiness

As a verifier of real applications,
I want configured services started in the worktree environment with explicit readiness and guaranteed teardown,
So that probes run against a live, healthy system (FR-21; Golden Corpus fixture 8).

**Acceptance Criteria:**

**Given** services in config (command, readiness URL/command, timeout, env, port)
**When** the services stage runs
**Then** each service starts in the worktree with its declared env, readiness is polled until healthy or timeout, and startup order follows declaration order.

**Given** a service that never becomes ready
**When** the timeout elapses
**Then** the run ends InfraError (exit 3, never FAIL), with the service's captured output as evidence.

**Given** run end (including SIGKILL of SpecWitness)
**When** cleanup/`clean` completes
**Then** no service process survives (extends 3.2's manifest coverage to services; integration-tested).

### Story 4.2: Plan model & compilation via plan-author provider

As the bridge from WHAT to HOW,
I want frozen contracts compiled into persisted plans — typed probes + assertions per criterion, lowest adequate surface,
So that execution is deterministic and AI-free thereafter (FR-16, AD-2/3; UJ-1).

**Acceptance Criteria:**

**Given** a frozen contract and the plan-author role
**When** `specwitness plan epic-7` runs
**Then** `.specwitness/plans/epic-7.yaml` is written referencing the contract version + fingerprint, with every automated criterion mapped (by criterion id only — plans never embed criterion statements, per AD-5) to ≥1 probe from the closed union (http | browser | observation | shell-by-config-id) with explicit assertions and expected values; human criteria carried as needs-human with reviewer guidance.

**Given** a provider draft containing an inline shell command string or an assertion-free probe
**When** schema validation runs
**Then** the draft is rejected (retry per FR-14) — the AD-3 boundary is enforced at schema level (test with a malicious fake provider).

**Given** a plan whose contract fingerprint is stale
**When** verify loads it
**Then** the run refuses with `HINT: re-run specwitness plan` (IntegrityError class).

**Given** surface choice
**When** a criterion is HTTP-checkable per the contract statement
**Then** the compiled probe is http, not browser (spot-check fixtures; brief §32 rule).

### Story 4.3: Deterministic test data

As a reproducibility guarantee,
I want scenario inputs fixed at compile time, stored in the plan, and surfaced in evidence,
So that identical plans produce identical probe inputs run after run (FR-17, AD-9, NFR-5).

**Acceptance Criteria:**

**Given** a compiled plan
**When** two verify runs execute against the same revision
**Then** probe inputs are byte-identical except fields the plan explicitly declares `volatile` (uniqueness-requiring values derive from a recorded per-plan seed).

**Given** any executed probe
**When** evidence is stored
**Then** the exact inputs used appear in the criterion's evidence (brief §48).

**Given** data setup/reset commands in config
**When** the data stage runs before probes
**Then** they execute in declared order and their failure classifies as InfraError.

### Story 4.4: HTTP probe executor

As the workhorse surface,
I want HTTP probes with status/header/body assertions and redacted request/response evidence,
So that API-level criteria verify without a browser (FR-23, FR-28, AD-10).

**Acceptance Criteria:**

**Given** an http probe (method, url against a declared service, headers, body, assertions on status/headers/JSON-path values)
**When** it executes
**Then** each assertion yields a recorded outcome with expected vs actual, and the criterion result derives mechanically from its assertions.

**Given** captured evidence
**When** persisted
**Then** Authorization/Cookie/Set-Cookie headers and secret-pattern values are redacted at capture (seeded-secret test proves nothing leaks; NFR-3), bodies sanitized and size-capped.

**Given** a connection-refused/timeout against a service that had passed readiness
**When** the probe runs
**Then** the criterion is classified `error` (not `fail`), feeding AD-6 aggregation (infra vs product distinction at criterion level).

### Story 4.5: Observation probes & before/after invariants

As the state-verification mechanism,
I want config-declared observation commands with JSON output and before/after comparison around actions,
So that invariants like "exactly one row created" verify stack-neutrally (FR-25; brief §34; Golden Corpus fixture 5).

**Acceptance Criteria:**

**Given** an observation probe referencing a config observation id with assertions (equals/delta comparisons)
**When** it executes standalone or as before/after wrapping another probe's action
**Then** JSON stdout is parsed, asserted (e.g. `after.count - before.count == 1`), and both snapshots stored as evidence.

**Given** an observation command emitting invalid JSON or exiting non-zero
**When** the probe runs
**Then** the criterion classifies `error` with the raw output as evidence (never a silent pass/fail).

**Given** the duplicate-submission scenario fixture
**When** verified
**Then** the criterion fails with evidence showing requests=2 and rows-created=2 (brief §35 example realized).

### Story 4.6: Shell probes

As coverage for structural/stack-specific criteria,
I want shell probes constrained to config-declared commands with exit-code/output assertions,
So that white-box checks are possible without opening arbitrary execution (FR-26, AD-3).

**Acceptance Criteria:**

**Given** a shell probe referencing a config-declared command id with an argument allowlist
**When** it executes in the worktree
**Then** exit code and output assertions produce the criterion result, output stored as evidence (bounded).

**Given** a plan attempting a shell probe with an undeclared id or out-of-allowlist arguments
**When** validation or execution runs
**Then** it is rejected before any execution (schema + runtime double enforcement).

### Story 4.7: AI-free behavioral verify end-to-end

As the epic's integration proof and UJ-3 realized,
I want full verify (gates → services → data → probes → aggregate → report) executing a precompiled plan with zero provider calls,
So that repeat verification is deterministic, fast, and subscription-independent (FR-18, FR-27 full; Golden Corpus fixture 11).

**Acceptance Criteria:**

**Given** a fixture app with frozen contract and compiled plan, provider binaries absent/disabled
**When** `specwitness verify` runs
**Then** it completes normally, provider-invocation count is 0 in the run metadata, and the verdict derives purely from criterion results.

**Given** a fixture with one failing criterion (e.g. wrong status code)
**When** verify runs
**Then** exit 1, the criterion carries expected/actual and evidence refs sufficient for a future repair agent (AR-4), and the terminal report matches brief §36's shape.

**Given** `verify` without an existing plan but with providers configured
**When** invoked
**Then** plan compilation is auto-invoked first (recorded in run metadata), then execution proceeds — while `--no-ai` in the same situation refuses with `HINT: run specwitness plan`.

---

## Epic 5: Browser Verification & Human Judgment

Criteria that genuinely need a browser execute through standard Playwright with traces and screenshots as evidence; subjective criteria surface honestly as NEEDS_HUMAN; flakiness is recorded rather than hidden; failure explanations are available but never authoritative.

### Story 5.1: Playwright integration & environment resolution

As a browser-verification foundation,
I want SpecWitness to use the project's Playwright when present or provision its own, with capability detection in doctor,
So that standard tooling is reused, never rebuilt (FR-24 foundation; brief §33).

**Acceptance Criteria:**

**Given** a target project with its own Playwright installation
**When** browser probes prepare
**Then** the project's Playwright and browsers are used; otherwise SpecWitness provisions `@playwright/test` + chromium in a SpecWitness-owned cache (never inside the project tree).

**Given** doctor
**When** run
**Then** it reports Playwright capability (source, version, browsers present) and a `HINT:` when provisioning would be needed.

### Story 5.2: Browser probe executor with trace evidence

As verification of real user-facing behavior,
I want browser probes (navigate/interact/assert) generated ephemerally and executed via Playwright, with traces/screenshots as evidence and correct failure classification,
So that UI-level criteria verify against the assembled system (FR-24; UJ-2; Golden Corpus fixtures 2/3/10 class).

**Acceptance Criteria:**

**Given** a browser probe in the plan (steps: goto/fill/click/expect over locators; assertions on visible text/URL/element state)
**When** it executes
**Then** the scenario file is generated in the run directory (ephemeral, never in the project tree), executed headless against declared service URLs, and a Playwright trace + failure screenshot are stored as evidence.

**Given** an assertion failure vs a browser/environment crash
**When** classification runs
**Then** assertion failure → criterion `fail`; browser launch/crash/timeout-before-first-assertion → criterion `error` (AD-6/7 distinction, tested for both).

**Given** the UI-success-but-no-DB-mutation scenario (browser probe + observation before/after)
**When** verified against the corresponding fixture
**Then** the criterion fails with combined browser + observation evidence (brief §7 defect class demonstrated).

### Story 5.3: Human-judgment criteria flow

As an honest verdict system,
I want `human` criteria to surface as NEEDS_HUMAN with reviewer guidance and drive the verdict correctly,
So that SpecWitness never pretends to automate judgment (FR-16 human path, FR-27; UJ-3; Golden Corpus fixture 6).

**Acceptance Criteria:**

**Given** a contract with a human-verifiability criterion
**When** verify completes with all automated criteria passing
**Then** the criterion reports `needs_human` with its reviewer guidance in report and JSON, verdict is NEEDS_HUMAN, exit 2.

**Given** report output
**When** a human reviews
**Then** the report tells them exactly what to check and where the relevant evidence (e.g. screenshots) lives.

### Story 5.4: Flakiness & retry semantics

As a trust-preserving mechanism,
I want opt-in bounded retries recorded per attempt with flaky-pass surfacing,
So that flakiness is visible, never laundered into clean green (FR-32, NFR-5, AD-9; brief §49).

**Acceptance Criteria:**

**Given** retry config per probe class (default: 0)
**When** a probe fails then passes on retry
**Then** the criterion result is pass with `flaky: true`, every attempt's outcome and evidence recorded, and flaky counts surfaced in terminal report, JSON, and scorecard fields.

**Given** retries exhausted
**When** the probe still fails
**Then** the result is the final failure with all attempts recorded — retries never change classification, only repetition.

### Story 5.5: Failure explanation (explainer role) — optional

As a repair-loop accelerator,
I want an optional, clearly non-authoritative root-cause hypothesis for failed criteria from the explainer provider,
So that repair agents get a head start without AI touching verdicts (FR-11 explainer; brief §19.3; AD-2).

**Acceptance Criteria:**

**Given** a run with failures and an explainer role configured
**When** `verify --explain` (or `report --explain`) runs
**Then** the provider receives criterion statement, expected/actual, and evidence summaries, and its hypothesis is stored/rendered in a clearly labeled non-authoritative `explanation` field — verdict and results are byte-identical with or without it.

**Given** no explainer configured or provider failure
**When** --explain is requested
**Then** verification results are unaffected; the explanation is simply absent with a note.

### Story 5.6: Mechanics adaptation boundary — optional

As resilience against cosmetic UI drift,
I want an explicit, recorded flow where a provider may propose updated probe mechanics (locators/navigation) — never expectations,
So that "Create company" → "Add organization" relabels don't produce false FAILs (FR-18 boundary; brief §27).

**Acceptance Criteria:**

**Given** a browser probe failing on element-not-found
**When** `verify --adapt` is explicitly passed
**Then** the provider may propose changes only to mechanics fields (schema-enforced: assertions/expected values structurally immutable in the adaptation payload), the proposal is applied to a plan copy, recorded in run metadata, and the run is marked `adapted: true` in report and JSON.

**Given** an adaptation proposal touching an assertion or expected value
**When** validated
**Then** it is rejected wholesale (test with adversarial fake provider), and the criterion keeps its original failure.

**Given** default invocation (no `--adapt`)
**When** verify runs
**Then** no adaptation is attempted (opt-in only; determinism default).

---

## Epic 6: Trust — Golden Corpus & Dogfooding Scorecard

SpecWitness proves its own classification integrity against intentionally designed fixture apps with hand-written expected outcomes, including a non-Node stack — and ships the local scorecard that will answer the product hypothesis during dogfooding.

### Story 6.1: Corpus infrastructure & hermetic e2e runner

As SpecWitness's own quality gate,
I want a fixture-app harness executing real `specwitness` binaries against corpus apps and comparing to hand-written `expected.json`,
So that known outcomes are never defined by the implementation under test (NFR-10, AD-12; brief §50).

**Acceptance Criteria:**

**Given** `fixtures/corpus/<name>/` (app + `.specwitness/` config + precompiled contract/plan + hand-written `expected.json`: verdict, exit code, classification, key criterion statuses)
**When** the e2e suite runs
**Then** each fixture executes through the real CLI hermetically (localhost only, no real providers, FakeAgentProvider or checked-in artifacts) and asserts against `expected.json`.

**Given** CI
**When** the suite runs
**Then** corpus e2e is a required check; a fixture whose outcome drifts fails the build (SM-5).

### Story 6.2: Behavioral corpus fixtures (PASS/FAIL classes)

As proof SpecWitness catches its target defect classes,
I want fixtures: all-correct (PASS), API-contract mismatch (FAIL), UI-success-without-DB-mutation (FAIL), duplicate-submission (FAIL), individually-correct-stories-integrated-broken (FAIL),
So that the brief's §7 defect classes are demonstrably caught (fixtures 1, 2, 3, 5, 10).

**Acceptance Criteria:**

**Given** each fixture
**When** verified
**Then** the expected verdict, failing criterion ids, and evidence kinds match `expected.json` exactly — including the cross-story fixture where two modules are individually consistent but integrate incorrectly (`"approved"` vs `"approve"` class).

### Story 6.3: Classification corpus fixtures

As proof the outcome taxonomy holds,
I want fixtures: subjective criterion (NEEDS_HUMAN), broken build (gate failure), unstartable service (InfraError), tampered fingerprint (IntegrityError), plan-exists-no-AI (verifies offline),
So that infra/product/human distinctions are pinned by tests (fixtures 6, 7, 8, 9, 11; FR-22).

**Acceptance Criteria:**

**Given** each fixture
**When** verified
**Then** exit codes are respectively 2, 1 (+gateFailed), 3, 3 (integrity), 0 — and the infra-error fixture never reports FAIL nor the gate-failure fixture InfraError.

### Story 6.4: Non-Node target fixture

As proof of stack independence,
I want one corpus fixture whose app is not a Node project (e.g. Python HTTP service + shell observation script),
So that config-driven neutrality is demonstrated, not asserted (FR-4, NFR-6).

**Acceptance Criteria:**

**Given** the non-Node fixture with its own gates/services/observations in config
**When** verified end-to-end
**Then** it produces its expected verdict with zero Node-specific assumptions leaking (no package.json required in the target).

### Story 6.5: Scorecard recording

As hypothesis instrumentation,
I want every run appending a local scorecard record automatically,
So that dogfooding data accumulates without ceremony (FR-33, NFR-4; brief §54).

**Acceptance Criteria:**

**Given** any completed run
**When** it persists
**Then** a record (run id, epic, verdict/outcome, per-status criterion counts, durations, provider invocations, retry/flaky counts, infra errors) is appended to `.specwitness/scorecard.jsonl` — locally only, no network I/O anywhere in the scorecard path.

### Story 6.6: Defect attribution & summary

As the product-hypothesis judge,
I want to annotate findings (unique / duplicate-of-earlier-gate / false-positive) and see the summary,
So that after ~30–50 tasks the north-star metric is answerable (FR-34; brief §54).

**Acceptance Criteria:**

**Given** `specwitness scorecard add <run-id> --criterion E7-04 --attribution unique|duplicate|false-positive [--note ...]`
**When** invoked (no-TTY safe)
**Then** the attribution is appended and linked to the run/criterion.

**Given** `specwitness scorecard summary [--json]`
**When** invoked
**Then** it reports: unique real defects found by SpecWitness (north star), false-positive rate, NEEDS_HUMAN rate, infra-error rate, median duration, AI-free run share, flaky rate — computed from local records only.

### Story 6.7: Dogfooding readiness — docs & packaging

As the first real user,
I want a README, a harness integration guide, and a verified publishable package,
So that SpecWitness can gate a real epic in the author's harness next (UJ-4; addendum §A).

**Acceptance Criteria:**

**Given** the repo
**When** this story completes
**Then** README covers install/quickstart/командs/exit codes/config reference; an integration guide documents harness usage (absolute-path invocation, `--root`, `--json`, allowlisting `Bash(specwitness *)` in agent settings, supervisor §8a slot, no-TTY guarantees, timestamp freshness).

**Given** `npm pack` / `npm publish --dry-run`
**When** run in CI
**Then** the tarball contains the built CLI and templates only (no fixtures/tests), `npx specwitness --help` works from the packed tarball, and the version is semver with a `next` dist-tag plan documented.

### Story 6.8: Shared prompt-assembly helper

As the layer that composes every provider call,
I want one helper that redacts, bounds and preserves the instruction tail of every provider-facing prompt,
So that two modules cannot independently derive the same prompt defect twice (retires action item **e5-A**; AD-10, FR-29).

**Acceptance Criteria:**

**Given** the provider-facing modules under `src/authoring/**` (plan authoring, explanation, mechanics adaptation)
**When** any of them assembles a prompt
**Then** it does so through one shared helper that redacts untrusted text with the run's `RedactionOptions`, bounds the payload, and **keeps the instruction tail intact when bounding truncates** — so the response-shape and valid-ids rules can never be the part that is cut.

**Given** the contract `statement`, which travels verbatim from the frozen contract
**When** it enters any prompt
**Then** it passes the same redaction boundary as every other untrusted field, with the behaviour identical across all call sites.

**Given** the helper
**When** a new provider-facing module is added
**Then** the `src/authoring/**` dependency-cruiser rule (added in 6.1) keeps it inside the layer, and assembling a prompt without the helper is visible in review.

### Story 6.9: Browser verification in CI

As the surface with the widest gap between what is tested and what is verified,
I want the merged browser suites to run in CI against a real chromium on Linux,
So that Epic 5's browser executor, its security guards and story 5.1's provisioning path are proven somewhere other than one laptop (FR-24; Epic 5 retro §9).

*Added by owner decision 2026-09-04 during Epic 6 preparation, after finding that five merged browser suites self-skip on every CI runner because `@playwright/test` is an optional peer and nothing downloads chromium.*

**Acceptance Criteria:**

**Given** a CI job that installs a real chromium
**When** the suite runs on `ubuntu-latest`
**Then** the five merged browser suites execute rather than skip, demonstrated by comparison against story 6.1's skipped-suite report.

**Given** that job
**When** it fails
**Then** it does not block the required checks — non-blocking on introduction — with a written promotion criterion proposed for making it required.

**Given** story 5.1's provisioning path
**When** the job prepares its environment
**Then** either it exercises SpecWitness's own provisioning (its first real run) or the PR body states plainly that it does not, naming what remains unproven.

**Given** a browser process tree on Linux
**When** the job completes or is killed
**Then** no browser process survives the run, with evidence stated rather than assumed.

---

## Epic 7: Real Dogfooding & Value Measurement

SpecWitness leaves the lab: the author runs it as the actual merge gate for at least one real epic produced by the terminal-agents harness, completes a full contract → cohort → verify → (repair →) merge cycle, and records whether SpecWitness found defects the earlier gates missed. Operator-led: these stories are executed by the author with SpecWitness, not by coding agents writing SpecWitness code (small docs/fix PRs may fall out of them).

### Story 7.1: Harness integration & first real contract

As the author,
I want SpecWitness installed and configured in a real harness-managed project, with a frozen contract created before the cohort starts,
So that the first production use follows the intended contract-before-implementation flow (UJ-1; brief §66).

**Acceptance Criteria:**

**Given** a real target project managed by terminal-agents
**When** I run `specwitness init`, edit `.specwitness/config.yaml` (gates, services, observations, provider roles), and `specwitness doctor`
**Then** doctor is green (or every warning consciously accepted and noted), and `Bash(specwitness *)` is allowlisted in the harness's agent settings.

**Given** the next planned BMAD epic in that project
**When** I run `specwitness contract <epic>`, review the draft, and `--freeze` it **before launching the cohort**
**Then** the frozen contract + fingerprint are committed to the project alongside the plan (`specwitness plan <epic>`), and the cohort starts only after freeze.

### Story 7.2: First real epic verification & repair loop

As the author,
I want to gate the assembled epic branch with `specwitness verify`, inspect the evidence, and drive any repair loop to completion,
So that the full production workflow (verify → repair → re-verify → merge) is exercised on real work (UJ-2/UJ-3; brief §67.17).

**Acceptance Criteria:**

**Given** all story PRs supervisor-approved and merged into the epic branch
**When** I run `specwitness verify <epic> --json` from the supervisor terminal
**Then** a complete run with evidence exists under `.specwitness/runs/`, the exit code drives the merge decision, and any FAIL criteria are handed to repair tasks with their expected/actual/evidence.

**Given** repairs merged (if any)
**When** I re-run verify (AI-free — plan already compiled)
**Then** the epic reaches PASS or an explicitly accepted NEEDS_HUMAN state before merging to base — and every friction point encountered is captured as a GitHub issue on specwitness.

### Story 7.3: Hypothesis verdict report

As the product owner,
I want attributions recorded for every finding and a written value-measurement summary,
So that the product hypothesis gets an evidence-based first answer (brief §54, §67.18).

**Acceptance Criteria:**

**Given** the completed real-epic run(s)
**When** I record `specwitness scorecard add` attributions for each finding and run `specwitness scorecard summary`
**Then** the summary answers: unique real defects found after earlier gates passed, duplicates, false positives, NEEDS_HUMAN rate, durations, AI-free share.

**Given** the summary
**When** I write `docs/dogfooding-report-001.md`
**Then** it states what SpecWitness caught/missed, verification cost, and a continue/adjust/stop recommendation against the hypothesis — the input for deciding V0.x priorities and repeat dogfooding toward the ~30–50-task window.
