/**
 * The report's shared vocabulary — story 3.6.
 *
 * Every status and every verdict the terminal report prints is turned into
 * text here, once. Two properties are load-bearing and both are asserted in
 * `tests/unit/report/format.test.ts` rather than left to review:
 *
 *  - **No colour, anywhere.** The caller is far more often a pipe or an
 *    agent's capture buffer than a terminal, so a distinction carried by an
 *    ANSI code is a distinction that vanishes exactly when the report is being
 *    read by the thing that will act on it. Every mark is glyph AND word, so
 *    it survives a pipe, a font that renders `!` and `✗` alike, and a reader
 *    who has never seen this report before.
 *
 *  - **`error` never reads as `fail`.** `src/domain/result.ts` explains the
 *    distinction the closed taxonomy exists to protect: `fail` is product
 *    evidence — the branch is wrong — while `error` is infrastructure: we
 *    could not observe. This module is the last place that distinction can be
 *    lost, and losing it means telling an operator to fix a branch that may be
 *    perfectly healthy. It is the same invariant as the exit table's "3 is not
 *    1", one layer further out.
 *
 * AD-1: `src/report/**` may import `domain`, `schemas`, its own siblings and
 * npm — nothing else, and no side-effectful Node built-in. The `report-layer`
 * rule in `.dependency-cruiser.cjs` enforces it.
 */

import type { CriterionStatus, GateStatus } from '../domain/result.js';
import { type RunOutcome, isVerdictOutcome } from '../domain/run-outcome.js';

/**
 * Column width of a status mark, so a marks column aligns without any renderer
 * measuring its own output.
 *
 * A constant rather than a `max()` over the current marks: measuring at render
 * time would silently re-flow every existing report the day a status is added,
 * and a renderer that reads its own output back is one more way two runs can
 * differ. `? needs_human` is the longest at 13 characters.
 */
export const MARK_WIDTH = 13;

/**
 * How one criterion came out, as glyph + word.
 *
 * The `never` check is the point of the switch: adding a `CriterionStatus`
 * without deciding how it reads is a type error here, not a criterion that
 * silently renders as `undefined` in a report someone is about to act on.
 */
export function criterionMark(status: CriterionStatus): string {
  switch (status) {
    case 'pass':
      return '✓ pass';
    case 'fail':
      return '✗ fail';
    case 'needs_human':
      return '? needs_human';
    case 'skipped':
      return '– skipped';
    case 'error':
      // Deliberately NOT `✗`. See the module header: this is infrastructure
      // uncertainty, not a defect in the branch under verification.
      return '! error';
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

/**
 * How one Deterministic Gate came out.
 *
 * Narrower than `criterionMark` because `GateStatus` is narrower: a gate that
 * could not run at all is an `InfraError` raised by the gates stage, so it
 * never reaches a report as a gate row (there is nothing truthful to say about
 * a command that never started).
 */
export function gateMark(status: GateStatus): string {
  switch (status) {
    case 'pass':
      return '✓ pass';
    case 'fail':
      return '✗ fail';
    case 'skipped':
      return '– skipped';
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

/**
 * The report's last line: what this run concluded.
 *
 * The infrastructure arm has **no verdict**, and says so, rather than
 * borrowing `FAIL`. That is the product's central promise at the last place it
 * can be broken — a run that could not reach a conclusion must not read as one
 * that concluded the branch is defective.
 *
 * `gateFailed` carries the failing gate's **id** (`src/domain/run-outcome.ts`;
 * ADR-003's prose is the stale half), so the line names it: repair automation
 * routes to "fix the build" rather than to "something failed".
 */
export function verdictLine(outcome: RunOutcome): string {
  if (!isVerdictOutcome(outcome)) {
    return `VERDICT: (none) — infra error: ${outcome.infraError}`;
  }
  if (outcome.gateFailed !== undefined) {
    return `VERDICT: ${outcome.verdict} — gate '${outcome.gateFailed}' failed`;
  }
  return `VERDICT: ${outcome.verdict}`;
}
