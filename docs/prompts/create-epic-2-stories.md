# Prompt: Create Epic 2 story files (paste into a fresh Claude Code session in this repo)

---

You are working in the SpecWitness repo (`/Users/jundymek/dev/specwitness`, default branch `master`). **Epic 1 is implemented and merged** (merge commit `b5377b0`, 6 stories, 540 tests); its retrospective is at `docs/findings/epic-1-retro-2026-08-31.md`. Your ONLY task in this session: produce implementation-ready story files for **Epic 2 — Verification Contracts from BMAD Epics** (stories 2.1–2.7), ready to be executed by the terminal-agents harness as one supervised cohort. Do NOT implement any production code, and do NOT modify the finalized planning artifacts (PRD, spine, ADRs, epics.md, roadmap.md).

## Step 0 — Ground truth first (this is what Epic 1's story session did not have)

Production code now exists. Every story you write must reference the **real, merged** modules by path and exported name — never re-specify something that already exists, never invent a signature. Read, in full:

1. `CLAUDE.md` (note: its "Current phase" line is stale — see Step 4).
2. `docs/findings/epic-1-retro-2026-08-31.md` — especially §5 (debt), §6 (Epic 2 readiness: which seams exist and are test-pinned), §7 action items (A2 kebab-case role keys → assume **keep** unless the owner says otherwise; A3 ADR-003 wording `gateFailed?: string`; A7 owner-confirmed judgement calls), and the lesson "reproduce, do not trust".
3. The six Epic 1 story files under `docs/implementation-artifacts/epic-1-install-configure-diagnose/` — their **Dev Agent Record / Completion Notes** carry decisions the code embodies (e.g. fakes live in `tests/fakes/`, not `src/`).
4. The merged code — these are the seams Epic 2 builds on; quote them, don't paraphrase:
   - `src/domain/errors.ts` (UsageError, ConfigError, IngestError, IntegrityError, ProviderError, InfraError — already exist; Epic 2 MUST NOT redefine them), `src/domain/ids.ts` (`normalizeEpicId`, criterion-id `E<n>-<NN>` helpers — frozen format), `src/domain/ports.ts`, `src/domain/result.ts`, `src/domain/run-outcome.ts`, `src/domain/verdict.ts`
   - `src/schemas/versions.ts` (`SCHEMA_VERSIONS`, `schemaVersionFor()`), `src/schemas/enums.ts`, `src/schemas/manifest.ts`
   - `src/config/schema.ts`, `src/config/types.ts`, `src/config/declared-command.ts` (`DeclaredCommand`, `commandText()`), `src/config/index.ts` — the `ai.providers` / `ai.roles` shape Epic 2 extends
   - `src/cli/main.ts`, `src/cli/exit.ts`, `src/cli/print-error.ts`, `src/cli/commands/*.ts` (command-module registration pattern), `src/cli/doctor/registry.ts`, `context.ts`, `effects.ts`, `checks/index.ts` (the extension seam story 2.7 plugs provider checks into)
   - `src/infra/run-store.ts`, `src/infra/clock.ts`, `src/infra/ids.ts`, `tests/fakes/ports.ts`
   - `.dependency-cruiser.cjs` + `tests/unit/dependency-rules.test.ts` (AD-1 rules the new `ingest/`, `authoring/`, `providers/` layers must satisfy), `tests/unit/doctor/credential-boundary.test.ts` (the NFR-1 AST guard — Epic 2 must extend its scope to `src/providers/**`), `tests/unit/exit-location.test.ts`, `tests/integration/cli.test.ts`, `tests/setup/build-cli.ts`, `package.json`, `.github/workflows/ci.yml` (triggers disabled — retro §2.1; agents run the steps locally)
5. Run `claude --version` and `codex --version` locally and record the versions; compare against `docs/planning-artifacts/prds/prd-specwitness-2026-08-30/addendum.md` §B (verified 2026-08-30: claude 2.1.251 `-p --output-format json`; codex 0.144.4 `exec --output-schema -o -C --skip-git-repo-check`, `codex doctor`). Stories 2.4/2.5 must say "probe at runtime, hardcode only this tested minimum".

## Step 1 — Load planning context (in this order)

1. `docs/planning-artifacts/epics.md` — Epic 2 section: 7 stories with Given/When/Then (authoritative; expand, never weaken).
2. `docs/planning-artifacts/roadmap.md` — EPIC 2 block: waves (A: 2.1 `src/ingest` + 2.2 `domain/contract` + `schemas/canonical` + 2.3 providers port + `invoke.ts` + fake → B: 2.4 + 2.5 adapters + 2.6 `src/authoring` + contract command → 2.7 touches contract command + doctor + adapters), shared contracts, exit criteria.
3. `docs/planning-artifacts/architecture/architecture-specwitness-2026-08-30/ARCHITECTURE-SPINE.md` — AD-1, **AD-2** (envelope `{role, prompt, responseSchema, contextFiles?}` → `{ok, parsed?, raw, attempts[], durationMs}`; schema gate + bounded retries implemented ONCE in `providers/invoke.ts`), **AD-4** (subprocess contract, capability probing, env withholding, no credential reads), **AD-5** (spec/meta partition, canonical serializer, fingerprint over `spec` only, provenance in meta), AD-12 (FakeAgentProvider, tagged real-CLI suite), conventions (amend is the only other TTY-allowed command; `contract --status` prompt-free), Stack table.
4. `docs/adr/ADR-001-ai-via-local-agent-clis.md`, `docs/adr/ADR-005-freeze-enforcement-limits.md` (amend = operator-only, TTY required, no-TTY refusal, no flag escape hatch), `docs/adr/ADR-INDEX.md`.
5. `docs/planning-artifacts/prds/prd-specwitness-2026-08-30/prd.md` — FR-3 (provider half), FR-5..FR-15, Glossary (Kind/Severity/Verifiability sets), UJ-1, UJ-5; `addendum.md` §A (BMAD layout of client #1: per-story files `## Story` / `## Acceptance Criteria`, roots override), §B, §D.
6. `docs/planning-artifacts/architecture/architecture-specwitness-2026-08-30/architecture-questions.md` — Q1–Q10 (ingest/contract), Q38–Q39, Q56–Q65 (providers, auth probing, provenance) — lookup before inventing any "how exactly".

## Step 2 — Generate the seven story files

Invoke the BMAD skill **`bmad-create-story`** explicitly by name (deprecated in favor of bmad-build, but correct here: stories are executed by the external harness, not bmad-build). The skill's default output path is `docs/implementation-artifacts/<dashed-key>.md` — **override it**: the harness reads specs by dot-style task id from an epic directory. Write each file to:

```
docs/implementation-artifacts/epic-2-verification-contracts/<task-id>.md
```

with these exact task ids (they map to the existing `sprint-status.yaml` keys via the harness's `first-dot-dash` rule, satisfy `TASK_ID_REGEX='^[0-9]+\.[0-9]+-[a-z0-9-]+$'`, and are ≤ 64 chars):

```
2.1-bmad-v6-ingestion-to-epicspec
2.2-contract-model-canonical-serialization-fingerprint
2.3-agentprovider-port-roles-structured-output-gate
2.4-claude-code-cli-adapter
2.5-codex-cli-adapter
2.6-specwitness-contract-epic-generate-review-freeze-status
2.7-amendment-flow-runtime-integrity-provider-doctor-checks
```

Run the skill workflow once per story, in that order. Epic integration branch for this cohort: **`epic/2-verification-contracts`** (story PRs target it, never `master`).

## Step 3 — Quality bar for every story (founder brief §63 + Epic 1 lessons)

Each file, in the shape the Epic 1 specs established (Status → Cohort & Dependencies → Story → Acceptance Criteria verbatim + "Clarifications (detail only, no weakening)" → Tasks/Subtasks (TDD order) → Dev Notes: Goal & Context / Exact scope / Out of scope / Dependencies & upstream contracts by ID / Architecture compliance / Testing requirements / Integration expectations / Failure modes / Security / Project Structure Notes / References → empty Dev Agent Record), must give one agent everything WITHOUT redesigning the product. Stories in the same wave must not share files; wave B/2.7 build on merged predecessors only; every PR leaves the repo coherent (§64).

Hard constraints to carry into every Epic 2 story:

- **AD-2 authority boundary:** providers author drafts only; the schema gate + retry loop (default 2, validation errors fed back, every attempt recorded with rejected payload, then `ProviderError`) lives ONCE in `src/providers/invoke.ts` (story 2.3); adapters (2.4, 2.5) translate envelope ↔ CLI invocation and return raw text — nothing else. `parsed` exists only after the shared gate.
- **AD-4 / NFR-1 (security — tested, not asserted):** adapters spawn only `claude` / `codex` via the process seam; capabilities probed per session and cached; never read `~/.claude/`, `~/.codex/`, or any credential store — extend the existing AST guard (`tests/unit/doctor/credential-boundary.test.ts`) to cover `src/providers/**` and `src/authoring/**`; subscription/chatgpt modes build the child env by **withholding** `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (+ configured equivalents), parent env never mutated, warning names the variable. Auth readiness probed only via the CLIs' public behavior (`codex doctor`, exit codes of a trivial invocation).
- **AD-5 artifact contract:** contract YAML has exactly two top-level keys `spec` + `meta`; SHA-256 over canonical JSON of `spec` only via the single `src/schemas/canonical.ts`; `schemaVersion` registered in `SCHEMA_VERSIONS`; criterion ids via the existing `domain/ids.ts` helpers (`E7-01` — frozen); Kind/Severity/Verifiability defined once in `domain/contract.ts`; provenance (provider, model as reported, CLI version, timestamp) in `meta`; contract versions integer monotonic.
- **Process seam decision (must be explicit, not silent):** `ProcessRunner` (`infra/process-runner.ts`, process groups, manifests) is roadmap-owned by Epic 3 story 3.2, but 2.4/2.5 need to spawn CLIs with timeout, captured output and a constructed env. Assign story 2.3 (wave A) a **minimal `ProcessRunner` port + execa 10 implementation** (spawn declared binary, timeout, captured stdout/stderr, env passthrough/withhold, no shell) that 3.2 later extends with pgid/manifest discipline; record this in 2.3's Project Structure Notes and 2.4/2.5's dependencies. Provider binaries are NOT `DeclaredCommand`s (they are SpecWitness's own trusted tools, like git) — say so, and keep AD-3 intact: no config or provider string is ever interpolated into a shell.
- **FakeAgentProvider placement (decide explicitly in 2.3):** spine seed lists fake adapters under `src/providers/`; Epic 1 put test fakes in `tests/fakes/`. Recommended: a **runtime-selectable** `src/providers/fake.ts` adapter (config `adapter: fake`, deterministic canned responses from a fixture dir) because Epic 6's hermetic corpus e2e drives the real CLI without real providers; pure unit-test doubles stay in `tests/fakes/`. Whatever is chosen, 2.4/2.5/2.6/2.7 must reference the same location.
- **Integration testing without subscriptions:** adapter integration tests use **mocked binaries** (PATH-shim scripts named `claude`/`codex` under a tmp dir) asserting exact argv, cwd, env withholding, timeout behavior; one explicitly tagged, skipped-by-default real-CLI smoke test per adapter (AD-12). Domain/application suites spawn zero subprocesses (assert via the fake).
- **CLI conventions already in code:** commands register via the `src/cli/commands/<name>.ts` pattern; exit codes only via `src/cli/exit.ts`; `ERROR:`/`HINT:` via `print-error.ts`; `contract --status [--json]` prompt-free (stdout = JSON only in `--json`); `contract --amend` refuses in no-TTY with ADR-005 wording; `verify` does not exist yet (Epic 3) — 2.6's "verify refuses unfrozen contract" AC is delivered as a reusable guard function in `authoring/` plus its unit test, and noted as wired by Epic 3.
- **Doctor extension (2.7):** provider checks plug into `src/cli/doctor/registry.ts` via new check modules only — existing checks untouched (the seam is already proven by test); billing-risk env-var warnings; UJ-4 edge case (no agent CLI → generation unavailable, execution of existing plans still works) must not turn a missing provider into a required-check failure.
- **Ingestion (2.1):** configurable roots from config `planning.*`; both layouts (epics file + per-story files, per addendum §A), fixtures for both; BMAD types confined to `src/ingest/` (AD-1 boundary test via depcruise rule + unit test); `IngestError` names what was searched and where.
- Stack pinned exactly per the spine (Node ≥22.12, TS 6.0.x, pnpm 11, commander 15, zod 4.5, execa 10, yaml 2.9, vitest 4.1, tsup 8.5, dependency-cruiser 18). TDD per story; Conventional Commits; ISO-8601 UTC everywhere.

### Cohort & Dependencies section (harness self-configuration) — required in every story

The whole cohort launches at once and serializes via the harness's `--depends-on` mechanism. Facts to design around:

- Agents self-configure after reading the spec: `~/.terminal-agents/scripts/set-cohort.sh <peers>` and `~/.terminal-agents/scripts/set-depends-on.sh <agent>:done` (`done` = PR **merged**, detected by the poller; never use `pr-opened`).
- **One `waiting_for` marker per agent** — successive `set-depends-on.sh` calls REPLACE, they do not accumulate (this bit gitnebula's Epic 2). Multi-predecessor stories must therefore wait **sequentially**: set the first marker; when unblocked, set the next; and **before setting any marker, check whether that predecessor's PR is already merged** (`gh pr list --base epic/2-verification-contracts --state merged --search "<task-id>"`, or the peer's `status.json` `phase: done`) and skip already-satisfied ones — otherwise an agent can wait forever on an event that already fired.
- Worktrees are created at spawn, before any predecessor merges: **immediately after each unblock** run `git fetch origin && git rebase origin/epic/2-verification-contracts`.
- Seven stories exceed the harness's six default names, so the launch will pass `--names`; assume this mapping and tell agents to depend on the *story-id holder* if `tmux-overview.sh` shows otherwise:
  `alice=2.1, bob=2.2, pamela=2.3, arnold=2.4, rambo=2.5, chuck=2.6, dolph=2.7`.
- Dependency graph to encode (derive from the actual imports you specify; adjust if your file ownership changes it):
  - 2.1, 2.2, 2.3 — no depends-on (wave A; all three are on the critical path — keep scope tight, PR early).
  - 2.4 → `pamela:done` (2.3: port, envelope, invoke gate, process seam).
  - 2.5 → `pamela:done` (same).
  - 2.6 → sequentially `pamela:done`, then `bob:done` (2.2 contract model/fingerprint), then `alice:done` (2.1 EpicSpec).
  - 2.7 → sequentially `chuck:done` (2.6 contract command), then `arnold:done` (2.4), then `rambo:done` (2.5).

## Step 4 — Close out

1. Update `docs/implementation-artifacts/sprint-status.yaml`: the seven Epic 2 stories → `ready-for-dev`, `epic-2` → `in-progress` (the create-story workflow's own status step); then run `uv run .claude/skills/bmad-sprint-planning/scripts/sprint_plan.py validate --status-file docs/implementation-artifacts/sprint-status.yaml` and require `"valid": true`.
2. Update the stale "Current phase" paragraph in `CLAUDE.md` to state: Epic 1 merged 2026-08-31 (`b5377b0`), production code exists under `src/`, Epic 2 stories authored, retrospectives live in `docs/findings/`. Keep everything else in CLAUDE.md as is.
3. Commit with a Conventional Commits message (e.g. `docs: add Epic 2 implementation-ready story files`) and **push to `origin/master`** — the harness's spec-on-origin guard refuses to launch a cohort whose specs are not on origin.
4. Report: created files; the exact launch command the operator should run, which is expected to be
   ```
   ~/.terminal-agents/scripts/launch-task.sh --project specwitness \
     --supervised --supervisor-stage 3 \
     --base epic/2-verification-contracts --max 7 \
     --names alice,bob,pamela,arnold,rambo,chuck,dolph \
     2.1-bmad-v6-ingestion-to-epicspec \
     2.2-contract-model-canonical-serialization-fingerprint \
     2.3-agentprovider-port-roles-structured-output-gate \
     2.4-claude-code-cli-adapter \
     2.5-codex-cli-adapter \
     2.6-specwitness-contract-epic-generate-review-freeze-status \
     2.7-amendment-flow-runtime-integrity-provider-doctor-checks
   ```
   (flag anything in your stories that would change it); any ambiguities as questions at the end (SAVE QUESTIONS rule) — at minimum confirm the owner's answer to retro action item A2 (kebab-case role keys) and the two explicit decisions above (process seam in 2.3; FakeAgentProvider placement); and confirmation that no planning artifacts were modified and no production code was written.
