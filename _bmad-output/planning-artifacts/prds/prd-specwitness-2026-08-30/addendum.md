# PRD Addendum — SpecWitness

Depth preserved for downstream documents (architecture, epics, implementation). Not part of the PRD contract.

## A. First-client integration facts (terminal-agents harness survey, 2026-08-30)

Surveyed read-only at `/Users/jundymek/dev/terminal-agents`. These are facts about client #1, **not** product dependencies — SpecWitness must work without any of them, but should not *conflict* with them.

- **Invocation context:** the supervisor is an interactive Claude Code REPL in tmux; SpecWitness will be invoked as a Bash subprocess from inside a REPL turn. Consequences: no TTY (no interactive prompts on the verify path), bounded stdout (harness convention truncates ~12 KB and points at a log file), and the harness must allowlist `Bash(specwitness *)` in its Claude settings or every call prompts.
- **BMAD layout:** harness projects run BMAD v6 with `planning_artifacts: docs/planning-artifacts`, `implementation_artifacts: docs/implementation-artifacts` (deliberate override of the `_bmad-output/` default). Story files: `docs/implementation-artifacts/epic-<n>-<slug>/<task-id>.md` with `Status:`, `## Story`, `## Acceptance Criteria` (numbered, referenced as AC-1), `## Tasks / Subtasks`, `## Dev Notes`. Sprint file: `sprint-status.yaml` with two key styles (`verbatim` vs dashed).
- **Git conventions:** epic branch `epic/<n>-<slug>` (unpadded numbers); story branches `story/{task}`; supervisor branch `supervisor/epic-<n>-<slug>`; base branch varies per project (`master`, others). Epic branch may exist only as `origin/epic/...` from the supervisor's worktree (fetch required).
- **House CLI style worth matching:** rc=2 for named argument errors with a `HINT:` line on stderr; rc=64 used for usage errors in the codex-review script; "fail closed, then explain" (`BLOCK:` + `HINT:`); state passed via files not stdout parsing; JSON status files with `*_at` ISO-8601 UTC timestamps used for freshness comparison against last commit; project resolution refuses to guess (named error, never a default).
- **Precedent for SpecWitness:** `codex-auto-review.sh` (foreground `codex exec review` subprocess) is the closest existing pattern; supervisor prompt §8a "AC sweep across every story" is exactly the slot `specwitness verify` occupies.

## B. Verified local tool capabilities (2026-08-30, this machine)

- Claude Code CLI 2.1.251: `-p/--print` non-interactive; `--output-format text|json|stream-json`; `--allowed-tools`/`--disallowed-tools`; `--append-system-prompt`; permission-mode flags. No first-class JSON-Schema-constrained output flag observed → SpecWitness-side schema validation + bounded retry is the mechanism (FR-14).
- Codex CLI 0.144.4: `codex exec` non-interactive; `--output-schema <FILE>` (JSON Schema for final response — use it); `--json` (JSONL events); `-o/--output-last-message <FILE>`; `-s/--sandbox <mode>`; `-C/--cd <dir>`; `--skip-git-repo-check`; `codex doctor` exists (useful for our doctor's auth probe).
- Runtime: Node v22.20.0, npm 10.9.3, pnpm 9.15.0, git 2.50.1, Playwright 1.62.1 via npx, uv 0.12.1.
- Current library versions (npm, 2026-08-30): commander 15.0.0, zod 4.5.4, execa 10.0.1, vitest 4.1.11, yaml 2.9.0, @playwright/test 1.62.1, typescript 7.0.2, tsup 8.5.1. (Note TS 7.x is current — the Go-based compiler line; evaluate 5.9.x LTS vs 7.x at implementation start.)

## C. CLI surface sketch (product intent, not final)

```
specwitness init                      # scaffold .specwitness/ + config skeleton
specwitness doctor [--json]           # diagnostics; rc!=0 on required-check failure
specwitness contract <epic>           # ingest -> draft (provider) -> review file written
specwitness contract <epic> --freeze  # compute fingerprint, mark frozen
specwitness contract <epic> --amend   # explicit supersede flow (human confirmation)
specwitness contract <epic> --status [--json]
specwitness plan <epic>               # compile frozen contract -> executable plan
specwitness verify <epic> [--json] [--root <dir>] [--base <ref>] [--head <ref>] [--no-ai]
specwitness report <epic|run-id> [--json]
specwitness clean [--all]             # remove leftover worktrees/processes from run manifests
specwitness scorecard [add|summary]
```

Exit codes: 0 PASS · 1 FAIL · 2 NEEDS_HUMAN · 3 infrastructure/SpecWitness error · 64 usage error (EX_USAGE; keeps 2 unambiguous — see ADR-002).

## D. Project config sketch (illustrative for architecture, not a contract)

```yaml
# .specwitness/config.yaml
version: 1
project:
  baseBranch: master              # never assumed
  epicBranchPattern: "epic/{n}-{slug}"   # optional helper; --head always wins
planning:
  format: bmad-v6
  planningArtifacts: docs/planning-artifacts
  implementationArtifacts: docs/implementation-artifacts
setup:
  install: pnpm install
gates:                            # ordered; early stop
  - { id: lint,      run: pnpm lint }
  - { id: typecheck, run: pnpm typecheck }
  - { id: unit,      run: pnpm test }
  - { id: build,     run: pnpm build }
services:
  backend:
    run: python manage.py runserver 8000
    ready: { url: "http://localhost:8000/health", timeoutSec: 60 }
    env: { DJANGO_SETTINGS_MODULE: config.settings.test }
  frontend:
    run: pnpm dev
    ready: { url: "http://localhost:3000" }
data:
  reset: ./scripts/reset-test-db.sh
observations:
  company-count: { run: ./scripts/specwitness/company-count.sh }   # emits JSON to stdout
ai:
  providers:
    claude: { adapter: claude-code-cli, mode: subscription }
    codex:  { adapter: codex-cli,       mode: chatgpt }
  roles:
    contract-author: codex        # model diversity vs Claude-based coding agents
    plan-author: codex
    explainer: claude
```

## E. Rejected alternatives (rationale record)

- **Direct Anthropic/OpenAI API integration** — rejected for V0 by explicit founder decision (§21): cost model, auth complexity; CLI delegation reuses existing subscriptions and keeps credentials out of scope entirely.
- **LLM-as-judge for verdicts** — rejected as core mechanism (§20); allowed only as non-authoritative `explainer` role.
- **Containers for isolation** — deferred; git worktree + process-group management is sufficient for V0 and stack-independent (§17).
- **Universal DB adapter layer** — rejected for V0 (§34); project-owned observation commands emitting JSON are stack-neutral and keep destructive-operation responsibility inside the trusted project config.
- **Proprietary browser test format** — rejected (§33); standard Playwright, ephemeral generated scenarios.
- **Cloud telemetry for hypothesis validation** — rejected (§54); local scorecard only.
- **`feature/epic-X` branch assumption** — dropped after harness survey; branch/base/root always explicit or configured.

## F. Notes for architecture

- Model revisions as first-class run inputs (base + head recorded per run) so differential verification (§40) and challenge mode (§41) bolt on without domain rework.
- Contract/plan/run JSON all carry `schemaVersion` from day one.
- The EpicSpec boundary is the future ingestion-plugin seam (Cursor/other harnesses/CI).
- Redaction must sit at the evidence-capture boundary, not at render time (§47.6–7).
- The supervisor must not be able to amend contracts (open question 3): consider `contract --amend` refusing when a marker like `SPECWITNESS_ROLE=agent` is set by harnesses, while keeping V0 enforcement honest about its limits.
