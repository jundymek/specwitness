/**
 * What a verification run releases on the way out, and in what order (story 4.7).
 *
 * Extracted from `commands/verify.ts` so the ORDER and the failure handling are testable
 * without a git repository, a service and a run directory. Both are easy to get wrong in
 * ways nothing notices until an operator's next run fails on an occupied port.
 *
 * ============================================================================
 * SERVICES FIRST, WORKTREE SECOND
 * ============================================================================
 *
 * A live service holds an open file handle — and its working directory — inside the
 * worktree. Removing the tree out from under it fails or half-succeeds on some platforms,
 * and a half-removed worktree that `git worktree list` still knows about is worse than an
 * intact one. Draining first also means that if the removal then throws, every service is
 * already gone.
 *
 * ============================================================================
 * BUT NEITHER FAILURE MAY CANCEL THE OTHER ATTEMPT
 * ============================================================================
 *
 * The first version of this ran the two steps in sequence with a bare `await`, so a service
 * group that could not be terminated meant `removeWorktreeAt` was never even attempted —
 * **one unkillable process leaked the worktree as well**, for no reason. Found by the Codex
 * review pass on this story.
 *
 * Teardown is best-effort by design: `run-pipeline.ts` records a throwing release as a
 * teardown failure and KEEPS the run's already-decided outcome, precisely so that "a run
 * that PASSed and then leaked a process group is still a PASS with a recorded problem that
 * `specwitness clean` resolves". Best-effort means every step is attempted; a step that is
 * skipped because an earlier one failed is not best-effort, it is first-effort.
 *
 * So both run, and BOTH failures are reported together. Reporting only the first would hide
 * the second from the timeline entry an operator reads, and the whole point of recording a
 * teardown failure is that it names what is still on the machine.
 */

import { InfraError } from '../../domain/errors.js';

export interface RunTeardown {
  /** Terminates every registered service group. Resolves only once they are GONE. */
  readonly releaseServices: () => Promise<void>;
  /** Removes the detached worktree, or does nothing when the run never made one. */
  readonly removeWorktree: () => Promise<void>;
}

/**
 * Releases everything the run acquired, attempting every step whatever any other one does.
 *
 * @throws {InfraError} naming EVERY step that failed, when any did.
 */
export async function releaseRun(teardown: RunTeardown): Promise<void> {
  const failures: string[] = [];

  // Sequential, not `Promise.all`: the ordering above is the point, and running them
  // concurrently would reintroduce exactly the "remove the tree under a live process" race
  // that ordering them avoids.
  for (const [what, step] of [
    ['services', teardown.releaseServices],
    ['worktree', teardown.removeWorktree],
  ] as const) {
    try {
      await step();
    } catch (failure) {
      failures.push(`${what}: ${reasonOf(failure)}`);
    }
  }

  if (failures.length === 0) {
    return;
  }

  throw new InfraError(
    `the run could not be fully torn down — ${failures.join('; ')}`,
    "run 'specwitness clean' to remove what survived: the run's manifest records every " +
      'worktree and process group it acquired, so nothing is lost. A surviving service will ' +
      'otherwise make the next run fail on an occupied port',
  );
}

/** The message of a thrown value, for anything that might be thrown. */
function reasonOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
