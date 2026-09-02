# SpecWitness (repo: specwitness)

SpecWitness is an independent verification gate for agentic software development: after coding agents and a supervisor believe an epic is complete, SpecWitness independently proves — with reproducible evidence — whether the assembled epic satisfies the frozen specification, before the epic branch merges to the base branch. V0 = standalone TypeScript/Node npm CLI. The product name is SpecWitness (author decision 2026-08-30, superseding the brief's working name "Proofgate"); npm package/CLI: `specwitness`, project dir: `.specwitness/`.

## Current phase

**Epic 1 merged 2026-08-31 (`b5377b0`); Epic 2 merged 2026-08-31 (`fbdd359`, 8 stories including follow-up 2.8); Epic 3 merged 2026-09-01 (`26a6335`, 8 stories including owner-added 3.8 and two 3.1 follow-ups); Epic 4 complete on `epic/4-behavioral-verification` 2026-09-02 (7 stories, PRs #41-#46 and #52, plus five follow-ups #47-#51) and awaiting its integration merge to `master`.** Production code under `src/` now covers the CLI edge (skeleton, single exit-code table, `init`, `doctor`, `contract`, `report`, `verify`, `clean`), the domain core, the config model, BMAD ingestion, contract authoring (generate/freeze/amend/integrity), the provider adapters, the staged verify pipeline, worktree isolation, process groups, deterministic gates, run persistence and the terminal/JSON renderers — and, from Epic 4, service lifecycle and readiness, plan compilation, deterministic test data, the http/observation/shell probe surfaces, the probes stage and an AI-free `verify` that derives every criterion result from observed evidence (`--no-ai`, zero provider calls) — with its tests under `tests/` (2973 passing at Epic 4 head). Implementation is executed by multi-agent cohorts (one agent per story, plus a supervisor) reading the artifacts below; Epic 4 ran as **three sequential cohorts** against one long-lived epic branch (owner decision 2026-09-01, after subscription-limit freezes cost Epic 3 ~7.5h); the split eliminated the freezes, and the epic's wall clock was instead dominated by merge-click latency — see `docs/findings/epic-4-retro-2026-09-02.md` §2 observation 1, whose action item e4-A is the decision on how to schedule Epic 5. Per-epic retrospectives and the harness-defect record live in `docs/findings/`. Epic 4 story specs are in `docs/implementation-artifacts/epic-4-behavioral-verification/`; **Epic 5 (browser & human judgment) is next**.

## Authoritative documents (read in this order)

1. `docs/specwitness-input-brief.md` + `docs/specwitness-input-brief-part2.md` — founder brief, verbatim (part 2 = §59–75, re-supplied after truncation). The product source of truth.
2. `docs/planning-artifacts/prds/prd-specwitness-2026-08-30/prd.md` — PRD: glossary, FR-1..FR-34, NFRs, MVP scope. `addendum.md` beside it holds integration facts (first-client harness survey, verified CLI capabilities, config/CLI sketches).
3. `docs/planning-artifacts/architecture/architecture-specwitness-2026-08-30/ARCHITECTURE-SPINE.md` — binding architecture: paradigm, AD-1..AD-13 invariants, conventions, stack, structural seed. `architecture-questions.md` beside it answers the brief's 70 architectural questions explicitly; reviews live there too.
4. `docs/adr/` — ADR-001..006 + `ADR-INDEX.md` (decision log mapping every required topic to its home).
5. `docs/planning-artifacts/epics.md` — 7 epics / 43 stories with acceptance criteria.
6. `docs/planning-artifacts/roadmap.md` — cohort execution order, per-epic parallelization waves, exit criteria, MVP-ready checklist, first dogfooding procedure.
7. `docs/implementation-artifacts/sprint-status.yaml` — story tracking.

## Non-negotiable product rules (from the brief — do not silently overturn)

- AI authors verification artifacts; **verdicts are always mechanical** (pure aggregation). Never "ask an LLM whether it passes".
- **No direct LLM API usage** in V0; AI is delegated to local `claude` / `codex` CLIs as subprocesses. Never read/copy/persist `~/.claude/` or `~/.codex/` credential stores.
- Contract freeze/fingerprint: implementation must never silently change expected behavior; amendments are explicit and audited.
- Infra failures are never reported as product FAIL (exit codes: 0 PASS, 1 FAIL, 2 NEEDS_HUMAN, 3 infra, 64 usage).
- Only Project-Config-declared commands reach a shell; provider output cannot introduce shell strings (AD-3).
- Local-first: no SaaS, no web UI, no cloud telemetry.
- Disagreement with a recorded decision → write an ADR in `docs/adr/`, don't redesign silently.

## Repo conventions

- Default branch: **`master`** (not main). Epic branches: `epic/<n>-<slug>`; story branches: `story/<task-id>` (harness convention).
- **Conventional Commits** required for every commit: `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `style:`, `refactor:`, `perf:`, `ci:`, `build:` — with optional scope, e.g. `feat(pipeline): add readiness stage`. Imperative mood, no trailing period in the subject.

## Conventions

- BMAD v6.11 is installed (`_bmad/`, skills in `.claude/skills/bmad-*`). Planning changes go through BMAD skills (e.g. `bmad-prd` Update intent, `bmad-correct-course`), which log to the run's `.memlog.md` — not by hand-editing finalized artifacts.
- Implementation stack (pinned in the spine): Node >=22.12, TypeScript 6.0.x, pnpm 11, commander 15, zod 4, execa 10, yaml, vitest 4, tsup, dependency-cruiser; Playwright via `@playwright/test`.
- TDD per story; Golden Verification Corpus fixtures in `fixtures/corpus/` carry hand-written `expected.json` — never generated by the code under test.
- Timestamps ISO-8601 UTC; errors print `ERROR:` + `HINT:` to stderr; agent-callable commands must be prompt-free (no TTY assumptions).
