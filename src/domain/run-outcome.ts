/**
 * AD-6 — how a whole verification run came out.
 *
 * The outcome is one of exactly two things, never both:
 *   - a product verdict (the run reached a conclusion about the branch), or
 *   - an infrastructure error (SpecWitness could not reach a conclusion).
 *
 * That exclusivity is the invariant protecting the product's central promise:
 * an infra failure is never reported as a product FAIL. It is enforced here by
 * the type system rather than by convention — see `RunOutcome`.
 *
 * AD-1: pure. This module imports nothing at all.
 */

/**
 * The three product verdicts. Uppercase on purpose: these are user-facing
 * report values and the JSON contract (FR-30), distinct at a glance from the
 * lowercase per-criterion statuses.
 *
 * There is no fourth verdict. ADR-003 considered and rejected `GATE_FAILED`:
 * a branch that does not build is demonstrably not mergeable, which is FAIL,
 * and the `gateFailed` marker below keeps the distinction visible without
 * making every consumer handle another case.
 */
export const VERDICTS = ['PASS', 'FAIL', 'NEEDS_HUMAN'] as const;

export type Verdict = (typeof VERDICTS)[number];

/**
 * Which kind of infrastructure problem stopped the run, mirroring the AD-7
 * hierarchy (Q42: the run-level `{infraError}` outcome is typed via AD-7).
 *
 * `usage` is deliberately absent. A `UsageError` exits 64 (ADR-002) and is
 * raised at the CLI edge before a run exists, so it can never be the outcome
 * of an aggregation. Including it would create a value whose only correct
 * handling is "impossible" — either a contradiction in the exit table or a
 * branch that can never be reached. Every classification here maps to exit 3.
 */
export const INFRA_ERROR_CLASSIFICATIONS = [
  'config',
  'ingest',
  'integrity',
  'provider',
  'infra',
] as const;

export type InfraErrorClassification = (typeof INFRA_ERROR_CLASSIFICATIONS)[number];

/**
 * A run that reached a product conclusion.
 *
 * `gateFailed` carries the id of the Deterministic Gate that failed, when one
 * did (ADR-003). Its presence IS the boolean signal, and it identifies the
 * gate in the same field — repair automation routes to "fix the build" rather
 * than to a criterion. When a gate fails, the remaining gates and all criteria
 * are reported `skipped` by the caller; aggregation itself only needs the id.
 *
 * `infraError?: never` makes `{verdict, infraError}` a compile error.
 */
export interface VerdictOutcome {
  readonly verdict: Verdict;
  readonly gateFailed?: string;
  readonly infraError?: never;
}

/**
 * A run that could not reach a product conclusion. Exit 3, never exit 1.
 *
 * `verdict?: never` makes `{infraError, verdict}` a compile error.
 */
export interface InfraErrorOutcome {
  readonly infraError: InfraErrorClassification;
  readonly verdict?: never;
  readonly gateFailed?: never;
}

/**
 * The mutually exclusive run outcome (AD-6). Produced only by
 * `domain/verdict.ts`; consumed by `cli/exit.ts` and the reporters.
 */
export type RunOutcome = VerdictOutcome | InfraErrorOutcome;

/** Narrows to the product-verdict arm. Use this rather than hand-rolling `'verdict' in o`. */
export function isVerdictOutcome(outcome: RunOutcome): outcome is VerdictOutcome {
  return outcome.verdict !== undefined;
}

/** Narrows to the infrastructure arm. */
export function isInfraErrorOutcome(outcome: RunOutcome): outcome is InfraErrorOutcome {
  return outcome.infraError !== undefined;
}
