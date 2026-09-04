# ADR-003: Deterministic gate failure maps to Verdict FAIL with a gateFailed marker

- **Status:** Accepted (author confirmed option A, 2026-08-30)
- **Date:** 2026-08-30

## Context

The brief (§30–31) requires deterministic gate failures to be reported distinctly and to stop the pipeline early, and requires infra failures never to be labeled product FAIL. It does not say which *top-level verdict* a failing gate produces.

## Decision (accepted)

A failing Deterministic Gate ends the run with **Verdict FAIL**, `gateFailed` carrying the failing gate's id, zero criteria executed (all reported `skipped`), and the gate's output as evidence. Exit code 1.

> **Prose correction, 2026-09-04 (Epic 3 action item e3-D; story 6.3).** This sentence
> previously read `gateFailed: true`, *"the failing gate identified"* — describing a boolean
> flag beside a separate identifier. The implemented type is `gateFailed?: string`
> (`src/domain/run-outcome.ts`), a single optional field holding the gate's id: **its
> presence is the boolean signal, and it identifies the gate in the same field.** One field
> rather than two, so a marker cannot disagree with an id.
>
> **The decision is unchanged** — FAIL, exit 1, a visible gate-failure marker, criteria
> `skipped` — and only the description of its shape is corrected. A consumer reading the old
> wording would have tested `gateFailed === true`, which is never true of a string, and
> concluded no gate had failed on precisely the runs where one had.
>
> The end-to-end evidence for the corrected shape is the Golden Corpus fixture
> `fixtures/corpus/07-broken-build/`, whose hand-written expectation pins
> `{"verdict": "FAIL", "gateFailed": "build"}` at exit 1 — and pins, in the same comparison,
> that this outcome is never an infrastructure error.

## Rationale

The question the caller asks is "is this branch safe to merge?" — a branch that doesn't lint/build is demonstrably not, and that is a *product* problem in the branch, not a SpecWitness malfunction. Exit 3 would wrongly suggest rerunning might help; a fourth top-level outcome would complicate every consumer for little gain. The `gateFailed` marker plus per-gate results keep the distinction fully visible to repair automation (route to "fix the build", not to a criterion).

## Alternative

A fourth outcome `GATE_FAILED` (exit 4). Cleaner taxonomically; rejected as consumer-hostile — every automation must then handle a code that FAIL already covers semantically. Revisit if dogfooding shows repair routing needs it at the exit-code level.
