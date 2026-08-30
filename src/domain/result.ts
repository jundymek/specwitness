/**
 * AD-6 — the closed result taxonomy.
 *
 * These enums are defined ONCE, here, and consumed by every later epic: the
 * pipeline's aggregate stage, the terminal and JSON renderers, and the Golden
 * Verification Corpus all assert on these exact string literals. Treat every
 * value below as a frozen public contract.
 *
 * The taxonomy is CLOSED. Adding a status "for convenience" is the failure
 * mode this file exists to prevent — widening it is an ADR in `docs/adr/`,
 * not an edit.
 *
 * AD-1: pure. This module imports nothing at all.
 */

/**
 * How a single acceptance criterion came out.
 *
 * - `pass`        — observed and satisfied.
 * - `fail`        — observed and violated. This is product evidence.
 * - `needs_human` — could not be adjudicated mechanically; a person must look.
 * - `skipped`     — never executed (e.g. a gate failed first). Inert.
 * - `error`       — the probe could not observe at all. Infrastructure, not
 *                   product: it must never surface as a product FAIL.
 */
export const CRITERION_STATUSES = ['pass', 'fail', 'needs_human', 'skipped', 'error'] as const;

export type CriterionStatus = (typeof CRITERION_STATUSES)[number];

/**
 * How a Deterministic Gate came out.
 *
 * Deliberately narrower than `CriterionStatus`: a gate is a mechanical command
 * that either succeeded, failed, or never ran. A gate can never be
 * `needs_human` (there is nothing to adjudicate) nor `error` (a gate that
 * cannot run is an InfraError raised by the stage, not a gate result).
 */
export const GATE_STATUSES = ['pass', 'fail', 'skipped'] as const;

export type GateStatus = (typeof GATE_STATUSES)[number];

/**
 * The V0 result of one acceptance criterion.
 *
 * Minimal on purpose. Epic 3 derives this from probe attempts in
 * `domain/criterion-result.ts` (AD-13) and extends this shape ADDITIVELY with
 * expected/actual, evidence references and severity. Here it is just the data.
 */
export interface CriterionResult {
  /** Canonical criterion id, `E<n>-<NN>` — see `domain/ids.ts`. */
  readonly criterionId: string;
  readonly status: CriterionStatus;
  /**
   * True when the criterion passed only on retry (FR-32). Recorded and
   * reported; it never changes a verdict — a flaky pass is still a pass, and
   * is never silently converted into a clean one.
   */
  readonly flaky?: boolean;
}

/**
 * The result of one Deterministic Gate.
 *
 * A gate result is its OWN type and is never modelled as a criterion (AD-6).
 * Conflating them is what lets a build failure masquerade as a criterion
 * failure in a report.
 */
export interface GateResult {
  /** Gate id as declared in the Project Config, e.g. `lint`, `build`. */
  readonly gateId: string;
  readonly status: GateStatus;
  /** Wall-clock duration in whole milliseconds (Consistency Conventions). */
  readonly durationMs?: number;
}
