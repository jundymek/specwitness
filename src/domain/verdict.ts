/**
 * AD-6 — mechanical verdict aggregation. The product's trust anchor.
 *
 * This is the ONE place a run outcome is decided. It is a pure, total function
 * of its two arguments: no AI, no I/O, no clock, no randomness, no mutation.
 * "Never ask an LLM whether it passes" is enforced here by there being nothing
 * to ask — the answer is arithmetic over closed enums.
 *
 * AD-1: pure. Imports only sibling domain modules.
 */

import type { CriterionResult, GateResult } from './result.js';
import type { RunOutcome } from './run-outcome.js';

/**
 * Decides the outcome of a run from its gate results and criterion results.
 *
 * Precedence (AD-6, ADR-003, PRD §9), applied in this exact order:
 *
 *   1. Any gate failed        -> FAIL, carrying the failing gate's id.
 *   2. Any criterion `fail`   -> FAIL.
 *   3. Any criterion `error`  -> infrastructure error (exit 3, never 1).
 *   4. Any `needs_human`      -> NEEDS_HUMAN.
 *   5. Otherwise              -> PASS.
 *
 * Two orderings deserve their reasons stated:
 *
 * - A failing gate outranks everything. A branch that does not lint or build
 *   is not mergeable regardless of what any criterion observed, and the
 *   pipeline stops early (ADR-003).
 *
 * - `fail` outranks `error`: "fail evidence outranks infra uncertainty"
 *   (PRD §9). Once we have observed a real violation, the fact that some other
 *   probe could not run does not soften the answer. The reverse ordering would
 *   let a flaky probe upgrade a genuinely failing branch to "rerun me".
 *
 * Severity is recorded elsewhere but does NOT soften aggregation in V0: any
 * fail is FAIL (FR-27).
 *
 * Total by construction: every input reaches exactly one of the five branches,
 * so empty arrays and all-`skipped` runs return PASS rather than throwing. A
 * gates-only green run with zero criteria is PASS — the Epic 3 gates-only mode.
 */
export function aggregate(
  gates: readonly GateResult[],
  criteria: readonly CriterionResult[],
): RunOutcome {
  const failedGate = gates.find((gate) => gate.status === 'fail');
  if (failedGate !== undefined) {
    return { verdict: 'FAIL', gateFailed: failedGate.gateId };
  }

  let sawError = false;
  let sawNeedsHuman = false;

  for (const criterion of criteria) {
    switch (criterion.status) {
      case 'fail':
        // Highest-precedence criterion status: return immediately, and do not
        // let a later `error` or `needs_human` change the answer.
        return { verdict: 'FAIL' };
      case 'error':
        sawError = true;
        break;
      case 'needs_human':
        sawNeedsHuman = true;
        break;
      case 'pass':
      case 'skipped':
        // `skipped` is inert by definition; `pass` contributes nothing to
        // reject. Listed explicitly so the switch stays exhaustive.
        break;
      default: {
        // Compile-time exhaustiveness: adding a CriterionStatus without
        // deciding its precedence here is a type error, not a silent PASS.
        const unreachable: never = criterion.status;
        return unreachable;
      }
    }
  }

  if (sawError) {
    return { infraError: 'infra' };
  }
  if (sawNeedsHuman) {
    return { verdict: 'NEEDS_HUMAN' };
  }
  return { verdict: 'PASS' };
}
