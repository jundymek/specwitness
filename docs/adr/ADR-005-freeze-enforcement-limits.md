# ADR-005: Contract freeze is tamper-evident, not tamper-proof, in V0

- **Status:** Accepted with documented limitation (brief §11 explicitly scoped this)
- **Date:** 2026-08-30

## Decision

Freeze = SHA-256 fingerprint over the canonical serialized contract content, stored with the contract; validated before every run; any mismatch stops the run with a contract-integrity error (exit 3, neither PASS nor FAIL). Amendment is the only legitimate change path: a new contract version referencing the superseded one, requiring explicit confirmation (`--amend` with confirmation step), fully audited.

## The honest limitation

A sufficiently capable local agent could re-run the freeze itself (edit contract → `specwitness contract --freeze`) or recompute the fingerprint, because V0 has no secret and no trusted third party. V0's protection is **tamper-evidence + friction + audit trail**, which converts silent redefinition into an explicit, reviewable, git-visible act — sufficient for the dogfooding threat model where the operator reviews contract changes.

## Hardening path (deferred, design-compatible)

- Harness-level: deny `specwitness contract` (freeze/amend) in coding/supervisor agent permission allowlists (client #1 already has exactly this mechanism for `gh pr merge`).
- Git-level: contract files owned by a protected path / CODEOWNERS on public repos.
- Tool-level: optional signing key held outside agent reach (v2+).

## Recorded concern

The PRD's open question 3: an interactive TTY confirmation for amendments would be strong, but the first client invokes tools from a no-TTY REPL context. Current position: amendments are an *operator* action performed in a human terminal — no-TTY contexts get refusal-with-hint, which is arguably correct behavior, since agents should never amend contracts.
