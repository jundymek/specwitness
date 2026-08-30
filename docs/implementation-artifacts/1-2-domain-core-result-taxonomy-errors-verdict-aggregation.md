# Story 1.2: Domain core — result taxonomy, errors, verdict aggregation

Status: ready-for-dev

## Story

As a harness automating merges,
I want the closed result taxonomy and a pure mechanical verdict function,
so that outcomes are classified identically everywhere and no AI or I/O can influence a verdict.

## Goal & Context

This story ships the product's non-negotiable core rule: **verdicts are always mechanical** — a pure function, no LLM, no I/O. It defines the closed enums every later epic consumes (criterion statuses, gate results, run outcome), the verdict aggregation function, epic-id normalization, and the tests that pin the exit-code mapping from story 1.1's table. Seven parallel agents in later epics will all import these types; ambiguity here multiplies into cross-story inconsistency later, which is exactly what AD-6/AD-7 exist to prevent.

Wave B story: runs in parallel with 1.3 (`src/config`) on top of merged 1.1. **You own `src/domain` and `src/schemas` (plus extending `src/cli/exit.ts`); do not touch `src/config` or any file story 1.3 owns.**

## Acceptance Criteria

From `docs/planning-artifacts/epics.md` (authoritative — expand, never weaken):

1. **Given** the enums `CriterionStatus {pass|fail|needs_human|skipped|error}`, gate results, and the run outcome union
   **When** aggregation runs over any combination of criterion results
   **Then** it returns FAIL if any `fail`; else infra error if any `error`; else NEEDS_HUMAN if any `needs_human`; else PASS — as a pure function with property-based unit tests (AD-6).
2. **Given** the typed error hierarchy (UsageError, ConfigError, IngestError, IntegrityError, ProviderError, InfraError — gate failure is a stage result, not an exception, per AD-6/AD-7)
   **When** each error type and run outcome maps through the exit table
   **Then** the mapping matches ADR-002 (0/1/2/3/64), a gates-only green run aggregates to PASS, a failed gate aggregates to FAIL+gateFailed, and all of it is covered by tests.
3. **Given** `src/domain/` and `src/schemas/`
   **When** the dependency-direction check runs
   **Then** no import from adapter layers or side-effectful Node built-ins exists (AD-1 enforced by lint/dependency-cruiser in CI).

Clarifications (detail only, no weakening):

- AC1 full aggregation contract (AD-6, ADR-003, questions doc Q45/Q46): the function takes **gate results + criterion results**. Precedence: any gate failed ⇒ `{verdict: FAIL, gateFailed: <gateId>}` (remaining gates and all criteria are reported `skipped` by the caller — the aggregation itself just needs the failed gate); else any criterion `fail` ⇒ FAIL (fail outranks `error` — "fail evidence outranks infra uncertainty", PRD §9); else any `error` ⇒ `{infraError}`; else any `needs_human` ⇒ NEEDS_HUMAN; else PASS. A run with zero criteria and green gates is PASS (gates-only Epic 3 mode). `skipped` criteria never affect the verdict. Severity is recorded but does NOT alter aggregation in V0 (FR-27 assumption).
- AC1 run outcome union is mutually exclusive: `{verdict: 'PASS'|'FAIL'|'NEEDS_HUMAN', gateFailed?: string}` **or** `{infraError: <classification>}` — never both (AD-6).
- AC2: the error classes already exist in `src/domain/errors.ts` (seeded by story 1.1) — do NOT redefine them; extend only if a field is genuinely missing. Your job is the run-outcome→exit mapping added to `src/cli/exit.ts` (`exitCodeForOutcome`) plus exhaustive tests for both mappings.
- AC1 "property-based": use `fast-check` (add as devDependency — justified by this AC; dev-only, not a stack-table change). Properties to pin at minimum: precedence order invariance under permutation of results; monotonicity (adding a `fail` to any input never yields PASS/NEEDS_HUMAN); PASS only when no fail/error/needs_human exists; gateFailed forces FAIL regardless of criteria.

## Tasks / Subtasks

- [ ] Task 1 (TDD): closed enums + result types (AC: 1)
  - [ ] `src/domain/result.ts`: `CriterionStatus` union exactly `'pass'|'fail'|'needs_human'|'skipped'|'error'`; `CriterionResult` minimal V0 shape `{criterionId, status, flaky?: boolean}` (Epic 3+ extends additively); `GateResult` `{gateId, status: 'pass'|'fail'|'skipped', durationMs?}` — gate results are their OWN type, never criteria (AD-6)
  - [ ] `src/domain/run-outcome.ts`: the mutually exclusive union above + `Verdict` type
- [ ] Task 2 (TDD): verdict aggregation (AC: 1, 2)
  - [ ] `src/domain/verdict.ts`: `aggregate(gates: GateResult[], criteria: CriterionResult[]): RunOutcome` — pure, total, no throw on any input combination
  - [ ] Example-based tests: every precedence rule, gates-only green run ⇒ PASS, failed gate ⇒ FAIL + gateFailed id, fail beats error beats needs_human, empty everything ⇒ PASS
  - [ ] Property-based tests (fast-check) per clarifications
- [ ] Task 3 (TDD): epic-id normalization (Consistency Conventions)
  - [ ] `src/domain/ids.ts`: `normalizeEpicId(input: string): string` — `7` ≡ `epic-7` ≡ `epic-07` → canonical `epic-7`; invalid input throws `UsageError` with hint. THE only implementation, used by cli and ingest alike (spine conventions row). Also export the canonical criterion-id helpers: format `E<n>-<NN>` (epic number unpadded, sequence zero-padded two digits, e.g. `E7-01`) — builder + validator (Epic 2 consumes them)
- [ ] Task 4 (TDD): exit-table completion (AC: 2)
  - [ ] Extend `src/cli/exit.ts` with `exitCodeForOutcome(outcome: RunOutcome): number` — PASS→0, FAIL→1 (gateFailed still 1, ADR-003), NEEDS_HUMAN→2, infraError→3
  - [ ] Tests covering the FULL ADR-002 matrix: all five codes, every AD-7 error class, every run outcome variant
- [ ] Task 5: schemas seed (AC: 3)
  - [ ] `src/schemas/enums.ts`: zod schemas mirroring the domain enums (CriterionStatus, Verdict, gate status) — later artifact schemas (Epic 2+) compose these; keep zod out of `src/domain` (domain stays dependency-free plain TS)
  - [ ] `src/schemas/versions.ts`: `SCHEMA_VERSIONS` constant registry seed (integers, additive evolution — AD-5); starts empty or with a placeholder entry, Epics 2/3 add real entries
- [ ] Task 6: AD-1 verification (AC: 3)
  - [ ] Confirm dependency-cruiser (configured in 1.1) passes with the new modules; add a rule/test if `src/schemas` wasn't covered; `src/domain/**` imports nothing but sibling domain files; `src/schemas/**` imports only zod + domain

## Dev Notes

### Exact scope

- `src/domain/`: `result.ts`, `run-outcome.ts`, `verdict.ts`, `ids.ts` (+ reading, not rewriting, `errors.ts`).
- `src/schemas/`: `enums.ts`, `versions.ts`.
- `src/cli/exit.ts`: add outcome mapping (sequential extension of 1.1's merged file — allowed, 1.3 does not touch it).
- Tests for all of the above.

### Out of scope (do NOT build)

- Contract/Plan/Run/Evidence domain models (Epics 2–4). `domain/criterion-result.ts` derivation logic (Epic 3 story 3.3/Epic 4 — deriving CriterionResult from probe attempts is AD-13, not this story; here CriterionResult is just the data type).
- Canonical serializer/fingerprint (`schemas/canonical.ts` — story 2.2).
- Anything in `src/config` (story 1.3 owns it, same wave — zero file overlap allowed).
- Clock/Ids ports and run-id format (story 1.6).
- Any I/O, any CLI command behavior.

### Dependencies & upstream contracts

- Requires story 1.1 merged (errors seed, exit table, depcruise, test rig).
- Binding: AD-6 (taxonomy + aggregation — the rule text is normative), AD-7 (hierarchy; gate failure deliberately NOT an error class — do not add a GateFailure error), ADR-002 (exit matrix), ADR-003 (gate failure ⇒ FAIL + gateFailed marker, exit 1), FR-22/FR-27, questions doc Q40–Q46, Consistency Conventions (id formats).

### Architecture compliance

- AD-1 is absolute here: `src/domain/**` must have ZERO imports of `fs`/`child_process`/`net`/etc. and zero imports from `cli|config|infra|providers|surfaces|pipeline|authoring|ingest|report`. zod lives only in `src/schemas`.
- Purity: `aggregate` and `normalizeEpicId` are deterministic, side-effect-free, no Date/Math.random.

### Testing requirements

- Unit only (pure domain — no integration tests needed). Property-based via fast-check for aggregation. Exit-mapping tests may import `cli/exit.ts` directly (unit-level, no process spawn needed beyond what 1.1 already covers).
- Coverage expectation: aggregation and exit mapping are the product's trust anchor — exhaustive branch coverage, not samples.

### Integration expectations

- Epic 3's pipeline aggregate stage calls `aggregate` verbatim; Epic 3's renderers and Epic 6's corpus assert on these exact enum strings — treat every exported name/string literal as a frozen public contract after merge.
- `normalizeEpicId` gets wired into CLI arg handling by the first command that takes an epic argument (Epic 2) — export it cleanly.

### Failure modes to consider

- Silent widening of the unions (e.g. adding a status "for convenience") — the taxonomy is CLOSED; changes require an ADR.
- Aggregation throwing on weird-but-typed input (empty arrays, all-skipped) — it must be total.
- Divergence between zod enum schemas and domain unions — derive one from the other (e.g. zod enum built from the domain const array) so they cannot drift.

### Security

- None specific; domain is pure. The blanket NFR-1 rule (never read agent-CLI credential stores) applies to the codebase at all times.

### Project Structure Notes

- Structural seed places all files as named above; kebab-case files, PascalCase types, camelCase values.
- Story branch `story/1-2-domain-core-result-taxonomy-errors-verdict-aggregation`; Conventional Commits (e.g. `feat(domain): add verdict aggregation`).

### References

- [Source: docs/planning-artifacts/epics.md#Story 1.2] — acceptance criteria (verbatim above)
- [Source: docs/planning-artifacts/architecture/architecture-specwitness-2026-08-30/ARCHITECTURE-SPINE.md#AD-6] — taxonomy + aggregation rule (normative)
- [Source: docs/planning-artifacts/architecture/architecture-specwitness-2026-08-30/ARCHITECTURE-SPINE.md#AD-7] — error hierarchy
- [Source: docs/adr/ADR-002-exit-codes.md], [Source: docs/adr/ADR-003-gate-failure-verdict.md]
- [Source: docs/planning-artifacts/architecture/architecture-specwitness-2026-08-30/architecture-questions.md#Q40-Q46] — result semantics
- [Source: docs/planning-artifacts/prds/prd-specwitness-2026-08-30/prd.md#FR-27] — incl. §9 assumption "fail outranks infra uncertainty"
- [Source: docs/planning-artifacts/roadmap.md#EPIC 1] — wave B ownership

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
