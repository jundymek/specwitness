/**
 * What a `verify` says on the way out when an operator presses Ctrl+C (story 4.7, Epic 3
 * retro debt 2).
 *
 * ============================================================================
 * THE DEFECT IS THE SILENCE, NOT THE LEAK
 * ============================================================================
 *
 * Measured before anything was written here, by interrupting a real run against a gate that
 * never ends (`tests/integration/verify-sigint.test.ts` records the reproduction):
 *
 *   exit:      no chosen exit code; the process died by signal
 *   stderr:    ZERO bytes about the interruption
 *   on disk:   the detached worktree survived, still registered with git
 *   processes: the gate's process group survived
 *   manifest:  present, `reaped: false`, carrying the worktree and the pgid
 *   git:       `git status --porcelain` empty — the source repository untouched (FR-19)
 *
 * The recovery path therefore ALREADY EXISTED. AD-8's crash-durable manifest is written
 * before any resource is acquired precisely so that a `kill -9` still leaves something
 * `specwitness clean` can reap, and it did its job. What was missing is that the operator
 * was never told the run directory's name, that a process group was still running, or that
 * `clean` is the remedy.
 *
 * ============================================================================
 * A MESSAGE, NOT A TEARDOWN — AND WHY THAT IS THE WHOLE FIX
 * ============================================================================
 *
 * The obvious-looking version of this attempts best-effort async teardown from the handler:
 * kill the process groups, remove the worktree, then exit. It is the wrong shape here, for a
 * reason that is easy to talk oneself out of. A handler doing async work can be interrupted
 * AGAIN — the operator presses Ctrl+C twice when the first one appears to do nothing — and a
 * half-finished teardown leaves a worse state than an untouched one: a partially removed
 * worktree that `git worktree list` still knows about, or a process group signalled but not
 * reaped. A reliable message plus a manifest `clean` can act on beats an unreliable cleanup.
 *
 * So this handler is **synchronous, self-removing, and re-raising**:
 *
 *  1. it removes itself FIRST, so a second Ctrl+C hits Node's default disposition and kills
 *     the process immediately — the operator is never trapped by a handler that keeps
 *     catching signals;
 *  2. it writes one `ERROR:`/`HINT:` pair to stderr, synchronously, in the house style;
 *  3. it re-raises SIGINT at its own pid, so the process dies BY SIGNAL exactly as it did
 *     before.
 *
 * There is no re-entrancy to reason about, no teardown-during-teardown, and no new signal
 * semantics — which is the fork Epic 3's action item F named. **This needed no ADR**,
 * because it decides nothing the project had not already decided.
 *
 * ============================================================================
 * EXIT 130 IS NOT ADDED TO `cli/exit.ts`, AND THIS IS WHY
 * ============================================================================
 *
 * Re-raising means the OPERATING SYSTEM ends the process; the shell then reports the signal
 * death through `WIFSIGNALED` and displays 130 itself. Nothing here chooses an exit code,
 * and ADR-002's table governs CHOSEN codes. Exiting with 130 explicitly would be SpecWitness
 * claiming it decided this outcome, would make a signal death indistinguishable from a
 * deliberate one, and would put a second exit code outside `cli/exit.ts`.
 *
 * `tests/unit/exit-location.test.ts` scans every source under `src/` for a process exit
 * write and stays green here, because `process.kill` is not one — a fact worth checking
 * rather than assuming, since it looks close enough to one. That scan reads SOURCE TEXT, so
 * this paragraph deliberately describes the forbidden call rather than spelling it: a
 * comment quoting it verbatim trips the guard, which is the guard being correct and not a
 * reason to loosen its pattern.
 *
 * ============================================================================
 * WHY IT IS ARMED ONLY ONCE A RUN DIRECTORY EXISTS
 * ============================================================================
 *
 * Before `RunStore.createRun` there is no worktree, no process group and no manifest — an
 * interruption leaves nothing behind, so there is nothing to say and saying it anyway would
 * train an operator to ignore the one message that matters. `SIGTERM` is handled alongside
 * `SIGINT` because a harness that times a verification out sends it, and that operator has
 * exactly the same question.
 */

import { printError } from '../print-error.js';

/** Signals that mean "an operator or a harness stopped this run". */
const INTERRUPTS = ['SIGINT', 'SIGTERM'] as const;

export interface InterruptNotice {
  /** Run directory, RELATIVE to the project root — what `RunEnvironment` carries. */
  readonly runDirectory: string;
}

/**
 * Arms the notice and returns the function that disarms it.
 *
 * The caller MUST disarm in a `finally`: a listener outliving its run would report a stale
 * run directory on the next interruption, and the whole value of the message is that the
 * path it names is the one holding the wreckage.
 */
export function armInterruptNotice(notice: InterruptNotice): () => void {
  const handlers = INTERRUPTS.map((signal) => {
    const handler = (): void => {
      // REMOVED FIRST, ALWAYS. A second Ctrl+C then reaches Node's default disposition and
      // ends the process at once, so an operator who presses it twice is never held by a
      // handler that keeps swallowing signals.
      disarm();

      printError(
        `verification was interrupted; a worktree and one or more process groups may still exist (${notice.runDirectory})`,
        `run 'specwitness clean' to remove the worktree and terminate any surviving process ` +
          `group — the run's manifest records both, so nothing is lost. Your repository was ` +
          `not modified`,
      );

      // Re-raise, so the process still dies BY SIGNAL. Nothing here chooses an exit code.
      process.kill(process.pid, signal);
    };

    process.on(signal, handler);
    return [signal, handler] as const;
  });

  let disarmed = false;
  function disarm(): void {
    if (disarmed) {
      return;
    }
    disarmed = true;
    for (const [signal, handler] of handlers) {
      process.removeListener(signal, handler);
    }
  }

  return disarm;
}
