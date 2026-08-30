# Prompt: Create Epic 1 story files (paste into a fresh Claude Code session in this repo)

---

You are working in the SpecWitness repo (`/Users/jundymek/dev/specwitness`). The BMAD planning package is complete and the author has approved implementation. Your ONLY task in this session: produce implementation-ready story files for **Epic 1 — Install, Configure & Diagnose** (stories 1.1–1.6). Do NOT implement any production code, and do NOT modify the finalized planning artifacts (PRD, spine, ADRs, epics.md, roadmap.md).

## Step 1 — Load context (in this order)

1. `CLAUDE.md` — project rules and document map.
2. `docs/planning-artifacts/epics.md` — Epic 1 section: the 6 stories with their Given/When/Then acceptance criteria (authoritative; expand, never weaken).
3. `docs/planning-artifacts/roadmap.md` — EPIC 1 block: wave order (1.1 first → wave B: 1.2+1.3 → wave C: 1.4+1.5+1.6), module ownership, shared contracts, exit criteria.
4. `docs/planning-artifacts/architecture/architecture-specwitness-2026-08-30/ARCHITECTURE-SPINE.md` — binding: paradigm, AD-1..AD-13, Consistency Conventions, Stack table (Node >=22.12, TypeScript 6.0.x, pnpm 11, commander 15, zod 4.5, execa 10, yaml 2.9, vitest 4.1, tsup 8.5, dependency-cruiser 18), Structural Seed (source tree).
5. `docs/adr/ADR-INDEX.md`, plus ADR-002 (exit codes 0/1/2/3/64) and ADR-003 (gate failure ⇒ FAIL + gateFailed) directly — Epic 1 implements the exit table.
6. Use `docs/planning-artifacts/architecture/architecture-specwitness-2026-08-30/architecture-questions.md` as a lookup for any "how exactly?" question before inventing an answer.

## Step 2 — Generate the six story files

Invoke the installed BMAD skill **`bmad-create-story`** explicitly by name (it is marked deprecated in favor of bmad-build, but it is the correct tool here: this project's stories are executed by an external multi-agent harness that consumes story markdown files, not by bmad-build). Run it once per story, in this order:

1.1 CLI package skeleton with exit-code contract
1.2 Domain core — result taxonomy, errors, verdict aggregation
1.3 Project configuration model & validation
1.4 `specwitness init`
1.5 `specwitness doctor` — runtime & project diagnostics
1.6 Run storage foundation & run identifiers

Output location: `docs/implementation-artifacts/` per `_bmad/bmm/config.yaml` (the skill resolves this itself — let it). Story file names/keys must line up with the entries already in `docs/implementation-artifacts/sprint-status.yaml` (e.g. `1-1-cli-package-skeleton-with-exit-code-contract`).

## Step 3 — Quality bar for every story (founder brief §63)

Each story file must give one independent coding agent everything needed WITHOUT redesigning the product: title; goal; business/technical context; exact scope; explicit out-of-scope; acceptance criteria (start from epics.md verbatim, add detail only); likely modules/files (respect the roadmap's module ownership — stories in the same wave must not share files); dependencies + upstream contracts by ID (AD-n, ADR-n, FR-n); tests required (TDD — unit for domain, integration for adapters); integration expectations; security concerns where applicable (NFR-1: never read credential stores; AD-3 trusted-command boundary); failure modes to consider.

Hard constraints to carry into every story:
- Wave order and "each PR leaves the repository coherent" (brief §64) — 1.1 bootstraps the package; wave B/C stories build on merged predecessors only.
- Exit codes ONLY via the single `cli/exit.ts` table (ADR-002); gate failure semantics per ADR-003.
- AD-1: `src/domain/` + `src/schemas/` import no adapter layers or side-effectful Node built-ins; dependency-cruiser enforcement is part of story 1.1/1.6 CI (see epics.md).
- Stack versions exactly as pinned in the spine's Stack table; story 1.1 includes the commander 14→15 / execa 9→10 breaking-change review note.
- All agent-callable commands prompt-free (no TTY assumptions); `ERROR:` + `HINT:` on stderr; ISO-8601 UTC timestamps.

## Step 4 — Close out

1. Update `sprint-status.yaml`: set the six Epic 1 stories to `ready-for-dev` (use the `bmad-sprint-planning` skill or its `sprint_plan.py` script — do not hand-edit beyond what the tooling supports).
2. Commit everything with a clear message.
3. Report: list of created story files, any ambiguities you hit (as questions at the end, per the skill's SAVE QUESTIONS rule), and confirmation that no planning artifacts were modified and no production code was written.
