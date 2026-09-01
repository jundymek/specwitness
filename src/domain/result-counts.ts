/**
 * AD-11 applied to counts — the shared derivation both views call.
 *
 * FR-29 makes the terminal report print counts of criteria by status; FR-30 lets a JSON
 * consumer want the same numbers. If each summed its own array, the two would be one
 * `switch` away from disagreeing — most likely the day someone adds a status and updates
 * one renderer.
 *
 * This is deliberately a DERIVATION rather than a field on `RunResult`. A count stored
 * beside the array it counts is a second source of truth, and second sources of truth
 * drift: a persisted `{pass: 3}` next to four passing criteria is a document that
 * contradicts itself and no reader can tell which half is right. A derived count cannot
 * be wrong about the array it was derived from. AD-11 forbids a renderer INVENTING a
 * fact; counting a list it was handed, through one shared implementation, is not that.
 *
 * Every key is always present and zero-valued when unseen, so no caller writes `?? 0` —
 * a caller who has to remember that will eventually forget, and print nothing where they
 * meant to print zero.
 *
 * AD-1: pure. Imports only sibling domain modules.
 */

import type { DerivedCriterionResult } from './criterion-result.js';
import { CRITERION_STATUSES, GATE_STATUSES } from './result.js';
import type { CriterionStatus, GateResult, GateStatus } from './result.js';

export type CriterionStatusCounts = Readonly<Record<CriterionStatus, number>>;
export type GateStatusCounts = Readonly<Record<GateStatus, number>>;

/**
 * Counts criteria by status.
 *
 * A `flaky` pass counts as a pass, because it is one (FR-32): aggregation treats it as a
 * pass and the flake is reported separately by `countFlaky`. Folding flakes out of the
 * pass count would be the silent conversion FR-32 exists to prevent, in the other
 * direction.
 */
export function countCriterionStatuses(
  criteria: readonly DerivedCriterionResult[],
): CriterionStatusCounts {
  // Seeded from the closed enum rather than from the data, which is what guarantees
  // every key exists even when nothing has that status.
  const counts: Record<CriterionStatus, number> = Object.fromEntries(
    CRITERION_STATUSES.map((status) => [status, 0]),
  ) as Record<CriterionStatus, number>;

  for (const criterion of criteria) {
    counts[criterion.status] += 1;
  }

  return counts;
}

/** Counts gates by status. `skipped` is first-class: an early stop must not look like an omission. */
export function countGateStatuses(gates: readonly GateResult[]): GateStatusCounts {
  const counts: Record<GateStatus, number> = Object.fromEntries(
    GATE_STATUSES.map((status) => [status, 0]),
  ) as Record<GateStatus, number>;

  for (const gate of gates) {
    counts[gate.status] += 1;
  }

  return counts;
}

/**
 * How many criteria passed only on retry (FR-32).
 *
 * Separate from the status counts because a flaky pass is a pass AND a flake, and
 * collapsing the two would force a report to choose which fact to lose.
 */
export function countFlaky(criteria: readonly DerivedCriterionResult[]): number {
  return criteria.filter((criterion) => criterion.flaky === true).length;
}
