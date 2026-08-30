# Story 1.6: Run storage foundation & run identifiers

Status: ready-for-dev

## Story

As a harness consuming results,
I want every run persisted under `.specwitness/runs/<run-id>/` with canonical ids and timestamps,
so that later epics write results/evidence into a stable, local-first layout (FR-31 foundation).

## Goal & Context

Foundation for everything Epics 3–6 persist: the canonical run-id format, the `Clock`/`Ids` ports (AD-9 — no real time/randomness in unit tests, ever), and `RunStore` — the SOLE writer under `.specwitness/runs/<run-id>/` (AD-8). The manifest skeleton it writes (fsynced BEFORE any resource use) is what makes crash-safe cleanup possible later (`specwitness clean`, story 3.2 — kill -9 must never lose track of a worktree or process group). Also ships the `report <run-id>` stub proving stored runs are locatable and renderable.

Wave C story: runs in parallel with 1.4 (init) and 1.5 (doctor). **You own `src/domain/ports.ts`, `src/domain/run-id.ts`, `src/infra/{clock,ids,run-store}.ts`, and `src/cli/commands/report.ts` (replacing the 1.1 stub); do not touch `init.ts`, `doctor.ts`, `templates/`, or anything 1.4/1.5 own this wave.**

## Acceptance Criteria

From `docs/planning-artifacts/epics.md` (authoritative — expand, never weaken):

1. **Given** a new run
   **When** the run store creates it
   **Then** the id matches `run-<YYYYMMDDTHHmmssZ>-<4 base36>`, a `manifest.json` skeleton exists before any resource use, and all timestamps are ISO-8601 UTC.
2. **Given** `Clock` and `Ids` ports
   **When** domain/application tests run
   **Then** both are injectable fakes (no real time/randomness in unit tests) per AD-9.
3. **Given** run directories exist
   **When** `specwitness report <run-id>` (stub) is invoked
   **Then** stored run metadata is located and rendered (full rendering arrives in Epic 3).

Clarifications (detail only, no weakening):

- AC1 id format (spine conventions row, normative): `run-<YYYYMMDDTHHmmssZ>-<4 random base36>` — compact UTC timestamp (e.g. `run-20260830T142501Z-a3f9`), 4 lowercase base36 chars from the `Ids` port. Provide parse/validate helpers; ids sort chronologically by construction.
- AC1 manifest skeleton (schemaVersion per AD-5; Epic 3 story 3.2 extends additively): `{schemaVersion: 1, runId, createdAt: <ISO-8601 UTC>, epic: string|null, worktrees: [], processGroups: [], reaped: false}`. "Before any resource use" = `createRun` returns only after the manifest file is written AND fsynced (file + containing directory) — this is the crash-durability discipline AD-8 names; kill -9 immediately after `createRun` must leave a readable manifest.
- AC2: ports are interfaces in `src/domain/ports.ts` (`Clock.now(): Date` or ISO string, `Ids.randomBase36(length): string`); real implementations live in `src/infra/`; fakes (`FixedClock`, `SequenceIds`) live with tests and make run ids fully deterministic in unit tests.
- AC3 stub scope: accepts a run-id argument only (epic-name lookup arrives Epic 3 story 3.5); locates `.specwitness/runs/<run-id>/manifest.json` via RunStore, renders manifest metadata (runId, createdAt, epic, reaped) + whether `result.json` exists ("no result yet — run verification arrives in Epic 3"); unknown/invalid run-id ⇒ `ERROR:` naming what was searched + `HINT:` (exit 3); malformed id string ⇒ `UsageError` (exit 64).

## Tasks / Subtasks

- [ ] Task 1 (TDD): run-id domain (AC: 1, 2)
  - [ ] `src/domain/run-id.ts`: `makeRunId(clock, ids)`, `isRunId(s)`, `parseRunId(s)` (→ timestamp part); pure, ports injected
  - [ ] `src/domain/ports.ts`: `Clock`, `Ids` interfaces (design note: Epic 3 will add more ports; keep this file focused on interfaces only — zero implementations)
  - [ ] Unit tests with fakes: exact expected id strings, round-trip parse, rejection of malformed ids
- [ ] Task 2 (TDD): infra implementations (AC: 2)
  - [ ] `src/infra/clock.ts`: `SystemClock` (UTC ISO-8601 with seconds precision for ids; full precision elsewhere)
  - [ ] `src/infra/ids.ts`: `RandomIds` via `node:crypto` randomness → base36
- [ ] Task 3 (TDD): RunStore (AC: 1)
  - [ ] `src/infra/run-store.ts`: `RunStore` rooted at `<projectRoot>/.specwitness/runs`; `createRun({epic?}) → {runId, dir}` (mkdir, write manifest, fsync file + dir); `readManifest(runId)`; `listRuns()`; `runDir(runId)` (single path-construction point — no other module may build run-directory paths, AD-8)
  - [ ] Manifest read validates `schemaVersion` and shape (zod schema in `src/schemas/manifest.ts` — versioned artifact schema, correct home per spine; register version in `src/schemas/versions.ts` from 1.2)
  - [ ] Integration tests against tmp dirs: created layout, manifest content/fsync path exercised, collision behavior (astronomically unlikely same-second+same-suffix ⇒ `createRun` fails with `InfraError` rather than reusing a dir), missing runs root auto-created
- [ ] Task 4 (TDD): report stub (AC: 3)
  - [ ] Replace stub `src/cli/commands/report.ts` per AC3 clarification; human output only (no `--json` yet — Epic 3 adds it from RunResult; adding a partial JSON shape now would create a schema we'd break)
  - [ ] Integration tests: create a run via RunStore in a tmp project, `specwitness report <run-id>` renders metadata (exit 0); unknown id (exit 3, ERROR+HINT); garbage id (exit 64)

## Dev Notes

### Exact scope

- `src/domain/ports.ts`, `src/domain/run-id.ts`, `src/schemas/manifest.ts`, `src/infra/clock.ts`, `src/infra/ids.ts`, `src/infra/run-store.ts`, `src/cli/commands/report.ts` (stub replacement), tests. One-line version registration in `src/schemas/versions.ts` (1.2's merged file; safe — 1.4/1.5 don't touch it this wave).

### Out of scope (do NOT build)

- `verify` and any pipeline stage; worktree/process-group manifest fields' population, teardown, `clean` (story 3.2 — you only reserve the empty arrays); `result.json` persistence + full report rendering + `report <epic>` + `--json` (story 3.5/3.6); evidence files; scorecard (Epic 6); retention/pruning (V0 keeps all runs, Q51).
- Atomic-finalize (stage-and-rename) write discipline for `result.json` — AD-8 names it, Epic 3 needs it; do NOT implement ahead of its consumer, just leave a doc comment noting RunStore will grow it in 3.2/3.5.

### Dependencies & upstream contracts

- Requires merged: 1.1 (CLI skeleton, stub, exit table, `InfraError`/`UsageError`), 1.2 (`src/schemas/versions.ts`, error/exit completion).
- Binding: AD-8 (RunStore sole writer; manifest fsync-before-resource-use; two write disciplines), AD-9 (Clock/Ids ports), AD-5 (schemaVersion on every artifact, additive evolution), FR-31 (foundation), Q50–Q52 (run storage layout, keep-all retention, report re-renders), Consistency Conventions (run-id format row — normative; ISO-8601 UTC).

### Architecture compliance

- AD-1: `domain/ports.ts` + `domain/run-id.ts` are pure (no Node built-ins); `schemas/manifest.ts` imports zod only; all `fs`/`crypto`/time code in `src/infra/`. `cli` imports infra — never the reverse.
- AD-8 discipline starts here: grep-level rule for reviewers — outside `src/infra/run-store.ts`, no code constructs a path under `.specwitness/runs`.
- Exit codes only via `cli/exit.ts`.

### Testing requirements

- Unit (fakes only — AC2 is explicit: NO real time/randomness): run-id construction/parsing, manifest schema.
- Integration: RunStore filesystem behavior + report-stub CLI spawns (tmp dirs, hermetic). Verifying actual fsync durability is OS-dependent — test the code path (fsync called; e.g. injected fs wrapper or spy) rather than attempting a real crash test; the kill -9 corpus test arrives in Epic 3.

### Integration expectations

- Story 3.2 extends the manifest (pgids, worktree paths) and adds append+fsync updates + `clean` replay; story 3.5 adds `result.json` atomic finalize; story 6.5 appends scorecard records NEXT TO runs (scorecard.jsonl is not under RunStore). Your manifest shape and `RunStore` API become shared contract at merge — keep methods narrow and documented.
- The harness will eventually `report <run-id>` from no-TTY contexts — stub is already prompt-free with bounded output.

### Failure modes to consider

- Corrupt/unparseable manifest.json ⇒ `InfraError` naming the file (never a crash or a silent skip); unknown `schemaVersion` (> known) ⇒ clear error mentioning a newer specwitness wrote it.
- `.specwitness/` missing entirely (project not initialized) ⇒ report says so with `HINT: run specwitness init` (exit 3).
- Clock skew/non-UTC local timezones — ids must be UTC regardless of TZ env (test with TZ set to a non-UTC zone).
- Concurrent `createRun` calls (two verifies) — distinct ids ⇒ distinct dirs; the improbable collision fails closed.

### Security

- No secrets handled; manifests contain paths/ids only. No network. Blanket NFR-1 applies. Writes confined to `.specwitness/runs/` (AD-8).

### Project Structure Notes

- Structural seed: `infra/ # process-runner, git/worktree, run-store, clock, ids, logger` — you create the run-store/clock/ids slice; process-runner/git arrive in Epic 3.
- Story branch `story/1-6-run-storage-foundation-run-identifiers`; Conventional Commits (e.g. `feat(infra): add run store with crash-durable manifest skeleton`).

### References

- [Source: docs/planning-artifacts/epics.md#Story 1.6] — acceptance criteria (verbatim above)
- [Source: docs/planning-artifacts/architecture/architecture-specwitness-2026-08-30/ARCHITECTURE-SPINE.md#AD-8] — RunStore sole-writer + write disciplines (normative)
- [Source: docs/planning-artifacts/architecture/architecture-specwitness-2026-08-30/ARCHITECTURE-SPINE.md#AD-9] — Clock/Ids ports
- [Source: docs/planning-artifacts/architecture/architecture-specwitness-2026-08-30/ARCHITECTURE-SPINE.md#Consistency Conventions] — run-id format (normative row)
- [Source: docs/planning-artifacts/architecture/architecture-specwitness-2026-08-30/architecture-questions.md#Q50-Q52] — storage/retention/report decisions
- [Source: docs/planning-artifacts/prds/prd-specwitness-2026-08-30/prd.md#FR-31] — run storage requirement
- [Source: docs/planning-artifacts/roadmap.md#EPIC 1] — wave C ownership; Epic 3 dependencies on the manifest

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
