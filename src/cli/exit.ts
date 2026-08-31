/**
 * ADR-002 / AD-6 — the single exit-code table.
 *
 * This is the ONLY module in the repository permitted to define or write a
 * process exit code. `tests/unit/exit-location.test.ts` enforces that
 * mechanically by scanning `src/**` for `process.exit(` and `process.exitCode`.
 * Everywhere else: throw an AD-7 error and let the CLI edge classify it.
 *
 * Story 1.2 appends `exitCodeForOutcome(outcome: RunOutcome)` below — the
 * run-outcome half of the same table. Nothing here moves when it does.
 */

import { UsageError, isSpecWitnessError } from '../domain/errors.js';
import type { RunOutcome } from '../domain/run-outcome.js';

/**
 * The frozen contract automations script against:
 *   0 merge-eligible · 1 defects found · 2 human review required ·
 *   3 rerun/fix environment · 64 fix the invocation.
 *
 * 64 is BSD `EX_USAGE`. Usage errors deliberately live outside 0–3 so a typo
 * in a flag can never be mistaken for NEEDS_HUMAN (ADR-002).
 */
export const EXIT = Object.freeze({
  PASS: 0,
  FAIL: 1,
  NEEDS_HUMAN: 2,
  INFRA: 3,
  USAGE: 64,
});

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * Maps a thrown value to its exit code.
 *
 * Accepts `unknown` on purpose: a `catch` binding is `unknown`, and the whole
 * point of this function is to be safe on values nobody anticipated.
 *
 * AD-7 fail-closed: anything that is not a recognised error class is treated
 * as infrastructure (3). An unclassified exception must never surface as a
 * product verdict — reporting an infra failure as FAIL is a defect of the
 * first order.
 */
export function exitCodeForError(err: unknown): ExitCode {
  if (err instanceof UsageError) {
    return EXIT.USAGE;
  }
  if (isSpecWitnessError(err)) {
    // ConfigError, IngestError, IntegrityError, ProviderError, InfraError.
    return EXIT.INFRA;
  }
  return EXIT.INFRA;
}

/**
 * The one place the process exit code is written.
 *
 * Sets `process.exitCode` rather than calling `process.exit()`: when stdout or
 * stderr is a pipe (which is how the harness, and our own integration tests,
 * invoke the CLI) writes are asynchronous, and `process.exit()` truncates
 * whatever is still buffered. Letting Node exit naturally with a set code
 * flushes the report and the ERROR/HINT pair first.
 */
export function applyExitCode(code: ExitCode): void {
  process.exitCode = code;
}

/**
 * Maps a completed run's outcome to its exit code — the run-outcome half of
 * the ADR-002 table, alongside `exitCodeForError` above.
 *
 * PASS 0 · FAIL 1 · NEEDS_HUMAN 2 · infra 3.
 *
 * A gate failure is FAIL and exits 1 like any other FAIL (ADR-003): a branch
 * that does not build is demonstrably not mergeable, which is a product
 * problem in the branch, not a SpecWitness malfunction. Exit 3 would wrongly
 * suggest that rerunning might help. The `gateFailed` marker keeps the
 * distinction visible to repair automation without adding a sixth code.
 *
 * The infra arm never returns 1. Reporting an infrastructure failure as a
 * product FAIL is a defect of the first order.
 */
export function exitCodeForOutcome(outcome: RunOutcome): ExitCode {
  if (outcome.infraError !== undefined) {
    return EXIT.INFRA;
  }

  // Bound to a local rather than switched on in place: `outcome` is a
  // discriminated union, so exhausting the cases narrows `outcome` itself to
  // `never` and the default branch could no longer read the property off it.
  const { verdict } = outcome;
  switch (verdict) {
    case 'PASS':
      return EXIT.PASS;
    case 'FAIL':
      return EXIT.FAIL;
    case 'NEEDS_HUMAN':
      return EXIT.NEEDS_HUMAN;
    default: {
      // Compile-time exhaustiveness: adding a Verdict without giving it an
      // exit code is a type error, not a silent fallthrough.
      const unreachable: never = verdict;
      return unreachable;
    }
  }
}
