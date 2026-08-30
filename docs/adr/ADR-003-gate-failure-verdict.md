# ADR-003: Deterministic gate failure maps to Verdict FAIL with a gateFailed marker

- **Status:** Accepted (author confirmed option A, 2026-08-30)
- **Date:** 2026-08-30

## Context

The brief (§30–31) requires deterministic gate failures to be reported distinctly and to stop the pipeline early, and requires infra failures never to be labeled product FAIL. It does not say which *top-level verdict* a failing gate produces.

## Decision (accepted)

A failing Deterministic Gate ends the run with **Verdict FAIL**, `gateFailed: true`, the failing gate identified, zero criteria executed (all reported `skipped`), and the gate's output as evidence. Exit code 1.

## Rationale

The question the caller asks is "is this branch safe to merge?" — a branch that doesn't lint/build is demonstrably not, and that is a *product* problem in the branch, not a SpecWitness malfunction. Exit 3 would wrongly suggest rerunning might help; a fourth top-level outcome would complicate every consumer for little gain. The `gateFailed` marker plus per-gate results keep the distinction fully visible to repair automation (route to "fix the build", not to a criterion).

## Alternative

A fourth outcome `GATE_FAILED` (exit 4). Cleaner taxonomically; rejected as consumer-hostile — every automation must then handle a code that FAIL already covers semantically. Revisit if dogfooding shows repair routing needs it at the exit-code level.
