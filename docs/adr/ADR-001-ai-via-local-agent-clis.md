# ADR-001: Delegate all AI reasoning to local agent CLIs (no direct LLM APIs)

- **Status:** Accepted (founder decision, brief §21–25)
- **Date:** 2026-08-30

## Decision

SpecWitness V0 performs all LLM work by spawning the locally installed official `claude` (Claude Code) and `codex` CLIs as subprocesses, behind an `AgentProvider` port. No `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` is required; SpecWitness never reads, copies, or persists any credential store (`~/.claude/`, `~/.codex/`, …). Verified capabilities at planning time: claude 2.1.251 `-p/--print --output-format json`; codex 0.144.4 `exec --output-schema <file>` (JSON-Schema-constrained final response) `--json -C <dir>`.

## Rationale

Reuses the author's existing subscriptions (Claude Max, ChatGPT OAuth); removes per-token billing risk; keeps authentication entirely the official tools' responsibility (same trust model as invoking `git`/`gh`); provides model diversity (Codex authoring verification for Claude-authored code).

## Recorded concerns (not blockers)

1. **Interface stability:** agent CLIs evolve fast; flags may change under SpecWitness. Mitigation: runtime capability probing (AD-4), adapter-isolated invocation, doctor checks, pinned minimum versions.
2. **Reliability/latency:** a full agent session per drafting call is heavier than an API call and can rate-limit under subscription plans. Mitigation: AI is only needed at contract/plan authoring time; verify runs are AI-free (FR-18).
3. **Terms of service:** programmatic subscription use is at the CLI vendors' discretion; both CLIs officially document non-interactive modes today, so this is sanctioned usage, but it should be re-checked before any public release.
4. **Output conformance:** claude has no schema-constrained output flag → SpecWitness-side zod validation with bounded retries (FR-14) is mandatory, not optional.

## Alternative considered

Direct Anthropic/OpenAI SDK integration — cleaner interface, but violates the cost/auth constraint and adds a credential surface. Deferred; the `AgentProvider` port keeps it addable without domain changes.
