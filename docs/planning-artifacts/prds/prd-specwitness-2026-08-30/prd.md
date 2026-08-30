---
title: SpecWitness
status: final
created: 2026-08-30
updated: 2026-08-30
---

# PRD: SpecWitness
*Working title — confirmed temporary by the author; naming must not influence architecture.*

## 0. Document Purpose

This PRD is for the author (product owner and first user), the downstream BMAD workflows (architecture, epics & stories, sprint planning), and the multi-agent coding cohort that will implement SpecWitness. It is derived from the founder input brief at `docs/specwitness-input-brief.md` (authoritative product input; note: the brief was truncated at its §58 — see Open Questions). Vocabulary is anchored in the Glossary; features are grouped with globally numbered FRs nested; inferences made without confirmation carry inline `[ASSUMPTION]` tags indexed in §9. Architecture-level detail (pipeline internals, schema drafts, CLI surface sketches) lives in `addendum.md` and in the Architecture Spine — this document defines WHAT must be true, not HOW it is built.

## 1. Vision

SpecWitness is an independent verification gate for agentic software development: after a cohort of coding agents and a supervisor agent believe an epic is complete and merged into its feature branch, SpecWitness independently proves — with reproducible, structured evidence — whether the assembled epic actually satisfies the original specification, before the branch reaches `main`.

The problem it attacks is **correlated misunderstanding**: an agent that misreads a requirement will implement the wrong behavior, write tests for exactly that wrong behavior, achieve green CI, and report success — and reviewing agents focused on implementation correctness will not catch that the requirement itself was misunderstood. Green tests ≠ correct product behavior. SpecWitness creates a hard boundary between *implementation* and *definition of done* by capturing expected behavior in a frozen Verification Contract **before** implementation begins, and verifying the assembled system against that contract **after** implementation — using AI to author verification, but never as the authority that decides pass or fail. Deterministic execution and mechanical verdicts produce evidence a human (or a future repair automation) can trust.

The V0 product is local-first CLI infrastructure — an npm package invoked from any repository, with the author's own multi-agent harness as its first client. The north-star question every MVP feature must serve: *"After several coding agents and a supervisor believe an epic is complete, can SpecWitness independently provide reproducible evidence showing whether the assembled epic is actually safe to merge?"*

## 2. Target User

### 2.1 Jobs To Be Done

- **Functional:** As the operator of a multi-agent coding cohort, decide with evidence — not agent self-reports — whether `feature/epic-X` is safe to merge to `main`.
- **Functional:** Catch cross-story and cross-layer integration defects (mismatched API contracts, missing side effects, permission holes, duplicate mutations) that story-level tests and reviews structurally cannot see.
- **Functional:** Prevent coding agents from silently redefining expected behavior to make their own work pass.
- **Emotional:** Merge to main without the nagging "did the agents actually build what I asked for?" doubt.
- **Contextual (builder):** Validate the product hypothesis by dogfooding on real harness output — measure whether SpecWitness finds unique real defects after earlier quality gates passed.

### 2.2 Non-Users (v1)

- Teams wanting a SaaS/dashboard/CI-hosted verification service — V0 is local CLI only.
- Developers without an agentic workflow who want "AI writes my tests" — explicitly not the product.
- Users requiring direct Anthropic/OpenAI API integration — V0 delegates AI to locally installed agent CLIs.

### 2.3 Key User Journeys

- **UJ-1. Marek freezes the definition of done before the cohort starts.**
  Marek, a solo builder orchestrating a 7-agent cohort, has finished BMAD planning for epic 7 (company onboarding). Before launching the cohort, he runs `specwitness contract epic-07` in the project repo. SpecWitness ingests the BMAD epic and stories, delegates drafting to his configured agent CLI, and presents a draft Verification Contract: behavioral criteria with classification and severity. He edits one criterion, marks a subjective one as human-only, and freezes the contract. **Climax:** the CLI confirms the contract is frozen with a fingerprint — the expected behavior is now captured independently of any future implementation. **Resolution:** he launches the coding cohort; the contract file is committed alongside the plan.

- **UJ-2. Marek gates the assembled epic and catches an integration defect.**
  Days later, all seven story PRs are supervisor-approved and merged into `feature/epic-07`. From his supervisor terminal Marek runs `specwitness verify epic-07`. SpecWitness creates an isolated worktree of the branch (his supervisor workspace untouched), runs deterministic gates (install, lint, typecheck, unit, build), starts the configured services, waits for readiness, then executes the verification plan: HTTP probes, browser scenarios, before/after database observations. **Climax:** the terminal report shows `E07-04 FAIL — expected exactly 1 company row created, observed 2` with a Playwright trace and DB observation evidence under `.specwitness/runs/<id>/`. Verdict: FAIL, exit code 1. **Resolution:** the branch does not merge; Marek hands the failed criterion's structured result to a repair task. **Edge case:** if the backend never becomes healthy, the run ends as INFRASTRUCTURE ERROR (exit 3), explicitly *not* a product FAIL.

- **UJ-3. Repair loop re-verifies deterministically, without AI.**
  A repair PR lands on the feature branch. Marek reruns `specwitness verify epic-07`. Because the frozen contract and compiled Verification Plan already exist, the run needs no LLM call: same probes, same deterministic test data, same assertions. **Climax:** all criteria pass except the one marked human-only; report shows `PASS 6 · NEEDS_HUMAN 1`, verdict NEEDS_HUMAN, exit 2. Marek reviews the subjective criterion himself, accepts it, and merges. **Resolution:** the run history preserves both runs with evidence for the scorecard.

- **UJ-4. First-time setup diagnosed by doctor.**
  Marek installs SpecWitness in a new project (`npm i -D specwitness`, `npx specwitness init`), answers nothing he doesn't have to, and runs `npx specwitness doctor`. It reports: Node/Git/Playwright capability OK; Claude Code CLI found, non-interactive mode available, auth appears usable; Codex CLI found; **⚠ OPENAI_API_KEY present in environment — provider calls could bill your API account; see provider modes**. He sets the provider mode explicitly and doctor goes green. **Edge case:** no agent CLI installed at all → doctor explains contract *generation* is unavailable but plan *execution* of existing plans still works.

- **UJ-5. Tampering is caught, correction stays possible.**
  A coding agent, failing a criterion, edits the contract file to weaken the expectation. On the next verify, the fingerprint check fails: `contract integrity error — content does not match frozen fingerprint` (exit 3, not FAIL, not PASS). Marek inspects the diff; the change was illegitimate and he restores the file. Weeks later a requirement genuinely changes: he runs the explicit amend flow, which records a new contract version superseding the old, requiring his confirmation. **Resolution:** silent redefinition is impossible; legitimate evolution is explicit and auditable.

## 3. Glossary

*Downstream workflows must use these terms exactly; no synonyms.*

- **Epic Source** — the planning artifacts describing one epic: the BMAD epic definition, its Stories, and their acceptance criteria, as found in the target project's planning output.
- **EpicSpec** — SpecWitness's normalized, source-format-independent internal representation of one Epic Source. The only thing contract generation reads.
- **Verification Contract** (Contract) — a versioned, human-approved, frozen set of Criteria for one epic. Defines WHAT must be true. Lives in the target project at `.specwitness/contracts/`.
- **Criterion** — one independently evaluable expectation inside a Contract: stable ID, behavioral statement, Kind, Severity, Verifiability. Written as externally observable behavior, never implementation detail.
- **Kind** — Criterion classification guiding verification strategy: `behavioral`, `integration`, `invariant`, `security`, `structural`, `performance`, `human`. [ASSUMPTION: this seven-value set; the brief listed candidates and asked for a designed minimal model — `deterministic` was dropped as it describes a verification property, not a requirement class.]
- **Severity** — Criterion weight in verdict aggregation: `critical` or `normal`. [ASSUMPTION: two levels suffice for V0.]
- **Verifiability** — whether a Criterion is machine-checkable (`automated`) or requires human judgment (`human`). Human criteria always resolve to NEEDS_HUMAN, never auto-PASS.
- **Freeze** — the explicit act that makes a Contract authoritative: computes its Fingerprint and marks it frozen. Only a frozen Contract can gate a verify run.
- **Fingerprint** — content hash of the canonical serialized Contract, stored with it and validated before every run. Mismatch is a Contract integrity error.
- **Amendment** — the explicit, human-confirmed flow that produces a new Contract version superseding a frozen one. The only legitimate way expected behavior changes.
- **Verification Plan** (Plan) — the persisted, executable strategy compiled from a frozen Contract: for each automated Criterion, one or more Probes plus the assertions that decide its result. Defines HOW to verify. Re-executable without AI.
- **Probe** — one deterministic interaction or observation executed during a run: an HTTP Probe, Browser Probe, Observation Probe, or Shell Probe. Probes carry fixed inputs (Deterministic Test Data) and produce Evidence.
- **Surface** — the mechanism a Probe uses: `http`, `browser` (Playwright), `observation` (project-configured command emitting JSON), `shell`. Rule: lowest-level deterministic surface appropriate for the Criterion.
- **Observation Command** — a project-configured, trusted command that emits structured JSON about system state (e.g. row counts), used for before/after state comparison.
- **Deterministic Gate** — a project-configured pass/fail command run before behavioral verification (install, lint, typecheck, unit, build, migrations…). A gate failure stops the pipeline as a gate failure, distinct from Criterion results.
- **Deterministic Test Data** — fixed scenario inputs (seeds, fixtures, values) bound into the Plan at compile time so repeated runs use identical inputs.
- **Run** — one execution of verification for one epic at one revision: isolated environment, gates, probes, results, Evidence, Verdict — stored under `.specwitness/runs/<run-id>/`.
- **Evidence** — typed, structured records attached to a CriterionResult (request/response metadata, before/after observations, traces, screenshots, command output, durations), redacted of secrets.
- **CriterionResult** — outcome of one Criterion in a Run: `pass`, `fail`, `needs_human`, `skipped`, or `error`.
- **Verdict** — the mechanically aggregated Run outcome: `PASS`, `FAIL`, or `NEEDS_HUMAN`. A Run that could not verify at all ends in an **Infrastructure Error** instead of a Verdict.
- **Infrastructure Error** — SpecWitness or environment failure (service won't start, worktree failure, missing dependency) preventing verification. Never reported as product FAIL.
- **Agent Provider** (Provider) — an adapter delegating AI reasoning to a locally installed agent CLI (`claude-code`, `codex`) or a test fake. Providers author drafts; they never decide Verdicts.
- **Provider Role** — a function a Provider is assigned to: `contract-author`, `plan-author`, `explainer`. Each role independently configurable.
- **Project Config** — the target project's trusted SpecWitness configuration (`.specwitness/config.yaml`): setup, gates, services, observation commands, provider assignment. The only source of executable project commands.
- **Doctor** — the diagnostic command validating runtime, providers, auth readiness, billing-safety, and Project Config.
- **Golden Corpus** — SpecWitness's own fixture suite: small apps with known expected Verdicts, used to test SpecWitness itself.
- **Scorecard** — local instrumentation recording per-Run metrics and defect attribution for hypothesis validation.

## 4. Features

### 4.1 Project Onboarding & Configuration

**Description:** A developer adds SpecWitness to any repository regardless of stack (`npm i -D specwitness` / `npx specwitness`), scaffolds it with `init`, and diagnoses readiness with `doctor` (realizes UJ-4). All executable project knowledge — how to install, what gates to run, how to start services, how to observe state — lives in the trusted Project Config; SpecWitness hardcodes no framework, package manager, or database.

#### FR-1: Initialize SpecWitness in a project
Developer can scaffold `.specwitness/` (config skeleton, directory layout for contracts/plans/runs) in any Git repository with one command.
**Consequences (testable):**
- Running init in a repo without SpecWitness creates a valid commented config skeleton and `.specwitness/` layout; running it again does not overwrite existing config without explicit confirmation.
- Init works in a repo whose stack SpecWitness has never seen (no Node project required in the target).

#### FR-2: Trusted project configuration
Developer can declare setup commands, Deterministic Gates, services (command + readiness URL/check), Observation Commands, and Provider assignments in Project Config; SpecWitness validates it and reports actionable errors.
**Consequences (testable):**
- An invalid config (unknown key, missing required field, non-executable declaration) fails fast with the offending path and reason, before any execution.
- No project command is ever executed unless it originates from Project Config or from a Plan constrained to config-declared operations (see FR-31, NFR-S1).

#### FR-3: Doctor diagnostics
Developer can run `doctor` to verify: runtime prerequisites (Node, Git, Playwright capability), each configured Provider (binary found, non-interactive mode available, auth appears usable — without reading credential stores), billing-risk environment variables, and Project Config validity (base branch exists, declared commands resolvable).
**Consequences (testable):**
- Doctor never reads `~/.claude/`, `~/.codex/` or equivalent credential storage; auth readiness is probed only via the official CLI's own commands/exit behavior.
- With `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` (or provider equivalents) present in the environment, doctor emits an explicit billing warning naming the variable.
- Doctor exits non-zero when a check required for the requested operation fails, and reports each check as pass/warn/fail.

#### FR-4: Stack independence
SpecWitness operates on projects of any language/framework; all stack specifics enter only through Project Config.
**Consequences (testable):**
- The Golden Corpus includes at least one non-Node fixture app verified successfully end-to-end. [ASSUMPTION: a simple static/Python fixture is sufficient proof for V0.]

### 4.2 Epic Ingestion

**Description:** SpecWitness reads the target project's BMAD planning artifacts for a named epic and normalizes them into an EpicSpec (realizes UJ-1). The EpicSpec isolates every downstream stage from planning-format details, so other harnesses/formats can be added later without touching contract logic.

#### FR-5: BMAD epic/story ingestion
Developer can point SpecWitness at an epic identifier; SpecWitness locates the epic, its stories, and their acceptance criteria in BMAD planning artifacts and produces an EpicSpec. Supports the BMAD v6 artifact layout with **configurable artifact roots** — the epics file plus per-story markdown files (`## Story`, `## Acceptance Criteria` numbered lists). The first client redirects BMAD output to `docs/planning-artifacts` / `docs/implementation-artifacts` (verified by harness survey), while default installs use `_bmad-output/…`; both must work via config, neither hardcoded. [ASSUMPTION: BMAD v6 conventions are the primary target; v4-style layouts are best-effort.]
**Consequences (testable):**
- Given a BMAD v6 epics file containing epic N with M stories, ingestion yields an EpicSpec with M stories, each carrying its acceptance criteria verbatim.
- A missing or unparseable epic produces a clear ingestion error naming what was searched, never an empty Contract.

#### FR-6: Normalized EpicSpec
EpicSpec is a versioned internal model (epic id/title/goal, stories, acceptance criteria, source references) with no BMAD-specific types leaking downstream.
**Consequences (testable):**
- Contract generation consumes only EpicSpec; a second ingestion source can be added without modifying contract-generation code (architecture test / demonstrated by a fixture-source used in tests).

### 4.3 Verification Contract Lifecycle

**Description:** The heart of the product boundary (realizes UJ-1, UJ-5). A Provider drafts behavioral Criteria from the EpicSpec; a human reviews, optionally edits, and freezes. The frozen Contract with its Fingerprint is the sole authority on WHAT must be true. Tampering is detected; legitimate change is explicit.

#### FR-7: Contract generation
Developer can generate a draft Contract for an epic; the assigned `contract-author` Provider transforms the EpicSpec into Criteria with behavioral statements, Kind, Severity, and Verifiability.
**Consequences (testable):**
- Every generated Criterion statement describes externally observable behavior or a system invariant; statements referencing internal functions/classes are rejected by schema-level lint (see FR-15) or flagged for review.
- Criteria carry stable IDs derived from the epic (e.g. `E07-01` pattern) that survive amendment.

#### FR-8: Human review & freeze
Developer can review/edit the draft and explicitly freeze it; freezing computes and stores the Fingerprint and marks the Contract version frozen. Only frozen Contracts gate verification.
**Consequences (testable):**
- Verify against a never-frozen Contract is refused with guidance to freeze first.
- Freeze is idempotent and reports the Fingerprint; the frozen file is human-readable (reviewable in a PR).

#### FR-9: Integrity validation
Every verify run validates the Contract's content against its stored Fingerprint before executing anything.
**Consequences (testable):**
- Any post-freeze content change (however small) causes the run to stop with a Contract integrity error — a distinct outcome that is neither PASS nor FAIL (realizes UJ-5; Golden Corpus fixture 9).

#### FR-10: Explicit amendment
Developer can amend a frozen Contract through an explicit flow that creates a new version referencing the superseded one, requires human confirmation, and re-freezes.
**Consequences (testable):**
- Amendment history is preserved and auditable (which version superseded which, when).
- No SpecWitness code path mutates a frozen Contract in place; automated callers cannot complete an amendment without the explicit confirmation step. [ASSUMPTION: V0 confirmation = interactive TTY prompt or an explicit `--confirm` flag documented as human-only policy; process-level enforcement against a determined agent is out of scope for V0 — recorded as a known limitation.]

### 4.4 Agent Provider Layer

**Description:** All AI reasoning is delegated to locally installed official agent CLIs as subprocesses — like a tool invoking `git` or `gh`. No direct API access, no API keys required, no credential reading, ever. Providers author structured drafts (contracts, plans, optional failure explanations); they are never the authority on verification outcomes.

#### FR-11: AgentProvider abstraction with roles
SpecWitness defines a Provider interface with per-role assignment (`contract-author`, `plan-author`, `explainer`) in Project Config; any role can use any configured Provider; one Provider can serve all roles.
**Consequences (testable):**
- A project configured with only Claude Code, or only Codex, completes every AI-assisted flow; neither provider is required by any hardcoded path.
- Domain logic is testable with a `FakeAgentProvider` without spawning real CLIs.

#### FR-12: Claude Code CLI adapter
Adapter invokes the local official `claude` binary in its supported non-interactive mode (verified at planning: v2.1.251 `-p/--print` with `--output-format json`), detecting capabilities at runtime rather than assuming flags.
**Consequences (testable):**
- Adapter functions with the user's existing subscription auth; it never reads/copies/persists Claude credentials.
- If the binary is missing or non-interactive mode unsupported, the adapter reports a capability error consumable by doctor.

#### FR-13: Codex CLI adapter
Adapter invokes the local official `codex` binary non-interactively (verified at planning: v0.144.4 `codex exec` with `--output-schema`, `--json`, `-C`), detecting capabilities at runtime.
**Consequences (testable):**
- Same auth/credential guarantees as FR-12; ChatGPT OAuth remains fully owned by the Codex CLI.

#### FR-14: Structured output validation
Every Provider response feeding a domain model passes schema validation (versioned schemas); invalid output triggers a bounded, recorded retry, then a controlled provider error. The core never parses free-form Markdown into state.
**Consequences (testable):**
- A Provider returning malformed output N times yields a provider error (infrastructure classification), never a partially ingested Contract/Plan.
- Retry count and raw rejected payloads are recorded in the run/generation log.

#### FR-15: Billing safety
SpecWitness never requires `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`; when API-billing environment variables are present, SpecWitness warns (doctor + at provider invocation) and supports an explicit provider mode controlling whether such variables are passed to the subprocess environment.
**Consequences (testable):**
- In subscription mode, SpecWitness launches provider subprocesses with billing-risk variables withheld from the child environment (documented; never mutates the parent environment). [ASSUMPTION: withholding env vars from a child process is the safe, side-effect-free safeguard; current CLI behavior researched and re-validated during implementation of this story.]

### 4.5 Verification Planning

**Description:** A frozen Contract is compiled — with `plan-author` Provider assistance — into a persisted, executable Verification Plan: per-criterion Probes with fixed assertions and Deterministic Test Data, choosing the lowest-level adequate Surface (realizes UJ-2, UJ-3). Once compiled, the Plan runs without any LLM. AI may later adapt HOW (mechanics like locators/navigation), never WHAT (expectations).

#### FR-16: Plan compilation
Developer can compile a Plan from a frozen Contract; each `automated` Criterion maps to ≥1 Probe with explicit assertions; each `human` Criterion is carried as needs-human with reviewer guidance.
**Consequences (testable):**
- Plan references its Contract version + Fingerprint; a Plan for a stale Contract is refused at verify time.
- Surface choice follows the lowest-level rule: an HTTP-checkable criterion yields an HTTP Probe, not a browser Probe (spot-checked in Golden Corpus).

#### FR-17: Deterministic test data
Scenario inputs are fixed at compile time and stored in the Plan; repeated runs use identical inputs, and inputs appear in Evidence.
**Consequences (testable):**
- Two runs of the same Plan against the same revision issue byte-identical probe inputs (modulo timestamps/ids explicitly declared volatile).

#### FR-18: AI-free re-execution
When Contract and Plan exist and are valid, verify executes with zero Provider invocations (realizes UJ-3; Golden Corpus fixture 11).
**Consequences (testable):**
- With provider binaries absent/disabled, verify of a precompiled Plan completes normally.
- Any optional AI assistance during a run (failure explanation, mechanics adaptation) is opt-in, recorded, and cannot alter assertions or expected values.

### 4.6 Isolated Execution Pipeline

**Description:** Verification executes in a SpecWitness-owned isolated Git worktree of the target revision — never in the invoking workspace (realizes UJ-2). The pipeline is staged: environment → deterministic gates (early stop) → services with readiness → probes → results. Every failure is classified: gate failure, criterion outcome, or Infrastructure Error. Cleanup is reliable even on crashes.

#### FR-19: Isolated worktree execution
Verify resolves the target revision (default: the epic's feature branch head; base/head both recorded) and creates a temporary Git worktree; the source repository and invoking workspace are never modified. Branch naming, base branch, and repository root are never assumed: they come from Project Config and/or explicit flags (`--root`, `--base`, `--head`), because real harnesses vary (survey of the first client found `epic/<n>-<slug>` branches, per-project base branches including `master`, and invocation from worktrees where CWD-guessing fails). Epic identifiers are normalized (`7` ≡ `epic-7` ≡ `epic-07`).
**Consequences (testable):**
- After any run (success, failure, or kill -9 during run), `git status` in the source repo is unchanged and no SpecWitness process holds the supervisor workspace.
- Run/base/head revisions are recorded in run metadata (differential BASE/HEAD verification addable later without domain rework — architecture requirement, not V0 feature).

#### FR-20: Deterministic gates with early stop
Configured gates run first, in declared order; a failing gate stops the pipeline before any Provider/browser cost, reported as a gate failure with the failing command's output as Evidence.
**Consequences (testable):**
- Broken-build fixture (Golden Corpus 7) produces a gate-failure outcome, zero probes executed, and exit code distinct from criterion FAIL semantics per FR-27. [ASSUMPTION: gate failure maps to Verdict FAIL with a `gate_failed` marker — the branch demonstrably isn't mergeable — while infra errors stay exit 3; flagged for review.]

#### FR-21: Service lifecycle & readiness
Configured services start in the isolated environment with explicit readiness checks (URL/health/command) and bounded startup timeout; all services stop at run end.
**Consequences (testable):**
- A service that never reaches readiness yields Infrastructure Error (Golden Corpus 8), not FAIL.
- No orphaned service processes survive run termination, including on crash (process-group tracking; `specwitness clean` removes any leftovers recorded in the run manifest).

#### FR-22: Failure classification
Every negative outcome is classified as exactly one of: Deterministic Gate failure, CriterionResult (`fail`/`needs_human`/`skipped`/`error`), or run-level Infrastructure Error.
**Consequences (testable):**
- Each Golden Corpus fixture reaches its designed classification; no fixture designed as infra error ever reports FAIL, and vice versa.

### 4.7 Verification Surfaces

**Description:** Probes execute over four surfaces (realizes UJ-2). Standard tooling only — Playwright for browser, plain HTTP, project-supplied observation commands for state; no proprietary browser framework, no universal DB abstraction.

#### FR-23: HTTP probes
Plans can express HTTP requests with assertions on status, headers, and body content (JSON path/shape); requests/responses are captured as Evidence with sanitized bodies.

#### FR-24: Browser probes (Playwright)
Plans can express browser scenarios executed via standard Playwright (project's installation preferred; SpecWitness-provisioned fallback), producing traces/screenshots as Evidence; generated scenario code is ephemeral, SpecWitness-owned, and never written into the project working tree. [ASSUMPTION: ephemeral generated tests, standard Playwright APIs, traces stored under the run directory; persisting accepted tests into the project is deferred.]
**Consequences (testable):**
- Browser failures are classified: assertion failure → criterion `fail`; browser/env crash → criterion `error`/Infrastructure Error per FR-22.

#### FR-25: Observation probes
Plans can invoke project-configured Observation Commands (JSON to stdout) and assert on values, including before/after comparison around an action (e.g. `after - before == 1`).
**Consequences (testable):**
- Duplicate-submission fixture (Golden Corpus 5) fails via before/after observation evidence showing 2 rows created.

#### FR-26: Shell probes
Plans can run assertion commands constrained to Project Config-declared operations (exit code / output assertions), for structural criteria and stack-specific checks.

### 4.8 Results, Evidence & Reporting

**Description:** Every criterion outcome is backed by typed Evidence; the Verdict is a pure mechanical aggregation; results are delivered as a terminal-native report, stable JSON, and predictable exit codes (realizes UJ-2, UJ-3). Output is designed so a future repair automation can consume per-criterion failures without re-running anything.

#### FR-27: Mechanical verdict aggregation & exit codes
Verdict derives from CriterionResults by fixed rules — no AI involvement: any `fail` ⇒ FAIL; else any `needs_human` ⇒ NEEDS_HUMAN; else PASS. Exit codes: 0 PASS · 1 FAIL · 2 NEEDS_HUMAN · 3 Infrastructure/SpecWitness error; CLI usage errors use a separate conventional code so automations never confuse "bad arguments" with NEEDS_HUMAN (see ADR-002). [ASSUMPTION: `skipped` doesn't exist in a completed run without an accompanying `error`/human decision; a run with criterion-level `error`s ends exit 3 unless a `fail` already occurred — fail evidence outranks infra uncertainty. Severity (critical/normal) is recorded and reported but does not soften aggregation in V0: any fail is FAIL.]

#### FR-28: Typed evidence with redaction
Each executed Probe attaches structured Evidence (inputs, assertion outcomes, HTTP metadata, sanitized bodies, traces, screenshots, observation snapshots, command output, durations); Authorization headers, cookies, tokens, and password-like values are redacted at capture time.
**Consequences (testable):**
- No stored Evidence file contains a configured secret pattern (tested with seeded secrets in fixtures).
- Every non-pass CriterionResult carries expected vs. actual plus ≥1 Evidence reference.

#### FR-29: Terminal report
Verify prints a sectioned, terminal-native report: contract status, revisions, environment, gates, per-criterion ✓/✗/? with one-line summaries, counts, Verdict, and the run evidence path. No web UI. Output is bounded (long logs truncate with a pointer to the full file under the run directory) so the report stays consumable when the caller is itself an agent context; all timestamps are ISO-8601 UTC so callers can do freshness comparisons.

#### FR-30: Stable JSON output
`--json` emits a versioned (`schemaVersion`), documented, additively-evolving JSON report: epic, runId, revisions, verdict, per-criterion status/expected/actual/evidence references, gate results, timing, provider usage, retry/flake records.
**Consequences (testable):**
- Schema is snapshot-tested; breaking changes require a version bump; the harness can parse results with a stable contract.

#### FR-31: Run storage
Every run persists metadata, results JSON, and Evidence under `.specwitness/runs/<run-id>/` (locally; no cloud); `report` re-renders a stored run without re-executing.

#### FR-32: Flakiness semantics
Retries, if configured for a probe class, are recorded per attempt and surfaced in report/JSON; a probe that passed only on retry is marked flaky — never silently converted to a clean pass.

### 4.9 Dogfooding Instrumentation (Scorecard)

**Description:** Local-only measurement for the product hypothesis: "independent epic-level verification detects real defects that passed coding-agent tests and supervisor/Codex review" (realizes §54 of the brief). No cloud telemetry, ever.

#### FR-33: Run scorecard
Every run appends a local scorecard record: duration, verdict, per-criterion outcomes, NEEDS_HUMAN rate, infra errors, provider invocations, retry/flake counts.

#### FR-34: Defect attribution
Developer can annotate a run's findings (`specwitness scorecard` or equivalent): unique-real-defect / duplicate-of-earlier-gate / false-positive, producing a summarizable local dataset for the ~30–50-task validation window.
**Consequences (testable):**
- A summary view answers: unique real defects found by SpecWitness after earlier gates passed (the north-star metric), false-positive rate, NEEDS_HUMAN rate, mean verification duration.

## 5. Non-Goals (Explicit)

- Not a replacement for the author's harness, its supervisor, or story-level review — SpecWitness is system/epic-level only. Supervisor asks "are the pieces good?"; SpecWitness asks "does the assembled system work?".
- Not "AI generates tests" and not "ask an LLM whether it passes" — AI authors verification artifacts; verdicts are mechanical.
- No SaaS, cloud, accounts, billing, dashboards, web UI, hosted execution, browser farms, Chrome extension.
- No GitHub App, MCP server, CI integrations, Slack/Jira/Linear in V0 (architecture must not preclude them).
- No automated repair agents (outputs must enable them later).
- No mutation/challenge verification, no full differential BASE/HEAD execution, no persistent historical-contract regression runs in V0 (revisions/runs modeled so these bolt on).
- No native adapters per database technology; no direct Anthropic/OpenAI API integrations; no credential scraping of any kind.
- No containers required for V0.

## 6. MVP Scope

### 6.1 In Scope

- Standalone npm package `specwitness` (TypeScript/Node CLI), usable via `npx`/local install in any repo; the author's harness is client #1 via plain CLI invocation.
- Commands (names indicative): `init`, `doctor`, `contract <epic>` (generate/review/freeze/amend), `plan <epic>`, `verify <epic>` (`--json`), `report <epic|run>`, `clean`, `scorecard`. [ASSUMPTION: `plan` as a separate explicit step, auto-invoked by `verify` when missing — keeps freeze→plan→execute stages inspectable.]
- BMAD v6 epic ingestion → EpicSpec; Contract generation, freeze, fingerprint, amendment.
- Claude Code + Codex CLI Provider adapters, roles, fake provider, structured-output validation, billing safety.
- Isolated worktree pipeline, deterministic gates, service lifecycle/readiness, cleanup + `clean`.
- HTTP, browser (Playwright), observation, and shell probes; deterministic test data; typed redacted evidence.
- Mechanical verdict, terminal report, stable JSON, exit codes 0/1/2/3, local run storage, flakiness recording.
- Golden Corpus (the brief's 11 V0-relevant fixture classes) as SpecWitness's own E2E suite; local scorecard.

### 6.2 Out of Scope for MVP

- Everything under §5 Non-Goals. Deferred with intent to revisit: differential BASE/HEAD execution (v2 — run/revision model already supports it), challenge/mutation verification (v2+ — potential key differentiator `[NOTE FOR PM]`), living historical-contract regression suite (v2 `[NOTE FOR PM]` — flagged in the brief as possibly SpecWitness's strongest long-term property), MCP server & CI modes (v2), non-BMAD ingestion sources (v1.x — EpicSpec boundary already isolates them), persisting accepted browser tests into projects (v1.x).

## 7. Success Metrics

**Primary**
- **SM-1 (north star):** Unique real defects found by SpecWitness after coding-agent tests, Codex review, and supervisor review all passed — target: >0 meaningful defects across the first ~30–50 agentic tasks; measured via FR-34 attribution. Validates FR-16–FR-27.
- **SM-2:** Trustworthiness of verdicts — false-positive rate (runs where FAIL was wrong) low enough that the author keeps the gate mandatory; target <10% of FAIL verdicts. [ASSUMPTION: threshold to be tuned during dogfooding.] Validates FR-22, FR-27, FR-32.

**Secondary**
- **SM-3:** AI-free repeatability — share of verify runs (after first plan compile) requiring zero provider calls; target >80%. Validates FR-18.
- **SM-4:** Verification duration — median wall-time per epic verify within the author's tolerance for a pre-merge gate; target ≤15 min. [ASSUMPTION.] Validates FR-20.
- **SM-5:** Classification integrity — zero Golden Corpus fixtures misclassified (infra error reported as FAIL or vice versa) in CI. Validates FR-22.
- **SM-6:** NEEDS_HUMAN rate stays informative, not lazy — human-verdict criteria <30% of criteria per contract. [ASSUMPTION.] Validates FR-7, FR-16.

**Counter-metrics (do not optimize)**
- **SM-C1:** Criteria count per contract — more criteria ≠ better verification; padding dilutes trust and inflates duration. Counterbalances SM-1.
- **SM-C2:** PASS rate — SpecWitness exists to find real failures; optimizing toward green defeats the product. Counterbalances SM-2.
- **SM-C3:** Retry-to-green rate — must stay visible (FR-32), never optimized away by hidden retries. Counterbalances SM-4.

## 8. Open Questions

1. ~~The founder brief was truncated at its §58 — were there sections beyond 58?~~ **Resolved 2026-08-30:** the author re-supplied §59–75 (`docs/specwitness-input-brief-part2.md`); reconciled via the 70-question answers doc, ADR-006 + ADR-INDEX, Epic 7 (dogfooding in MVP), and `roadmap.md`.
2. ~~FR-20 gate-failure verdict mapping~~ **Resolved 2026-08-30:** author accepted ADR-003 option A — Verdict FAIL, exit 1, `gateFailed` marker, criteria `skipped`.
3. ~~Amendment confirmation strength (FR-10)~~ **Resolved 2026-08-30:** amend is operator-only — TTY + interactive confirmation required, refusal in no-TTY contexts, no non-interactive escape hatch; harness allowlists deny `specwitness contract*` for agents as a second layer (ADR-005).
4. Should `verify` auto-generate a missing Contract (convenience) or hard-require the pre-implementation freeze workflow (discipline)? Current position: hard-require, to protect the product's core boundary.
5. Scorecard attribution UX (FR-34): CLI-prompt-based annotation vs. editing a records file — pick during implementation with real dogfooding friction data.
6. For the harness integration, is a machine-readable "contract frozen" signal needed at cohort start (e.g. `contract status --json`), or is file presence enough?

## 9. Assumptions Index

- §3 Kind — seven-value classification; `deterministic` dropped as a non-class.
- §3 Severity — two levels (critical/normal) suffice for V0.
- §4.2 FR-5 — BMAD v6 layout is the primary ingestion target; v4-style best-effort.
- §4.3 FR-10 — V0 amendment confirmation is procedural (prompt/flag), not cryptographic; recorded limitation.
- §4.4 FR-15 — billing safeguard = withholding env vars from child processes in subscription mode; CLI behavior re-verified during implementation.
- §4.5 FR-24 — ephemeral generated Playwright scenarios; project's Playwright preferred; persistence of accepted tests deferred.
- §4.6 FR-20 — gate failure ⇒ Verdict FAIL with `gate_failed` marker (open question 2).
- §4.8 FR-27 — severity does not soften aggregation in V0; criterion `error` ⇒ run exit 3 unless a `fail` already occurred.
- §6.1 — `plan` is an explicit stage auto-invoked by `verify` when absent.
- §7 SM-2/SM-4/SM-6 — numeric targets are initial calibrations, tunable during dogfooding.
- §4.1 FR-4 — one non-Node Golden Corpus fixture is sufficient stack-independence proof for V0.
