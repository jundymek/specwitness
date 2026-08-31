/**
 * TEMPORARY — removing a worktree by path, for `specwitness clean`.
 *
 * ============================================================================
 * THIS FILE IS SCHEDULED FOR DELETION. Story 3.1 (alice) owns worktree removal
 * and publishes `Vcs.removeWorktreeAt(root, worktreePath)` in
 * `src/infra/vcs.ts`. Stories 3.1 and 3.2 are BOTH wave A, so her module does
 * not exist on this branch and `clean` could not import it. Rather than block
 * the reaper on a peer branch, `clean` takes removal as a one-function seam and
 * defaults it to this.
 *
 * Agreed with alice during cohort intent-sync: whichever of us merges SECOND
 * deletes this file and wires `clean` to hers, so the epic branch ends with
 * exactly one definition of "removed". Two definitions would eventually
 * disagree about what removal means, which is why the seam is one function
 * wide and this file has no other caller.
 * ============================================================================
 *
 * The semantics are hers, restated so the temporary version cannot drift:
 * `git worktree remove --force`, then re-read the registration and fail if it
 * survived; removing an already-absent worktree is a NO-OP rather than an
 * error, because `clean` replays manifests and a path already reaped must not
 * fail the run.
 *
 * AD-3: `git` is spawned as a fixed binary with a fixed argument array through
 * the `ProcessRunner` port. No shell, no command string. The worktree path is
 * one argv element and is never word-split.
 */

import { existsSync } from 'node:fs';

import { InfraError } from '../domain/errors.js';
import type { ProcessRunner } from '../domain/process-runner.js';

/** Git operations here are local and should never take this long. */
const GIT_TIMEOUT_MS = 60_000;

/**
 * Removes the worktree registered at `worktreePath`, verifying it is gone.
 *
 * `repoRoot` is a plain path rather than story 3.1's richer `RepoRoot`, and
 * that is deliberate for the reaper: `clean` runs after a crash, when the
 * repository may be in a state that a full root resolution would legitimately
 * refuse — and refusing to reap is the one moment reaping matters most. It has
 * a project root and a recorded path, and that is all this needs.
 *
 * NEVER SUCCEEDS WITHOUT PROOF. An unanswerable `git worktree list` is reported
 * as an error, not read as "nothing is registered". alice (3.1) hit exactly this
 * in her own implementation during review: a git that could not list worktrees
 * made every recorded worktree look already-absent, so `clean` reported a clean
 * sweep while the checkout and its registration were both still there. A leak
 * that announces itself is recoverable; one that reports success is not.
 */
export async function removeWorktreeAtPath(
  runner: ProcessRunner,
  repoRoot: string,
  worktreePath: string,
): Promise<void> {
  const remove = await runner.run({
    binary: 'git',
    args: ['worktree', 'remove', '--force', worktreePath],
    cwd: repoRoot,
    timeoutMs: GIT_TIMEOUT_MS,
    env: { inherit: true },
  });

  if (remove.outcome === 'not-found') {
    throw new InfraError(
      `could not remove the worktree at ${worktreePath}: git not found on PATH`,
      "install git and reopen your shell, then run 'specwitness clean' again",
    );
  }

  const after = await registrationOf(runner, repoRoot, worktreePath);

  if (after === 'unknown') {
    throw new InfraError(
      `could not verify that the worktree at ${worktreePath} was removed: git worktree list did not answer`,
      `check the repository at ${repoRoot} by hand; the worktree may still be registered`,
    );
  }

  if (remove.outcome !== 'completed' || remove.exitCode !== 0) {
    // `git worktree remove` fails when the path was never registered — the
    // ordinary case for a manifest replayed twice, which must not be an error.
    // Decided by what is actually TRUE afterwards rather than by matching git's
    // failure prose, which is git's to change.
    if (after === 'absent' && !existsSync(worktreePath)) {
      return;
    }
    throw new InfraError(
      `could not remove the worktree at ${worktreePath}: ${firstLine(remove.stderr)}`,
      `run 'git worktree prune' in ${repoRoot}, then remove the directory by hand if it survives`,
    );
  }

  if (after === 'present') {
    throw new InfraError(
      `worktree removal left a registration behind for ${worktreePath}`,
      `run 'git worktree prune' in ${repoRoot}`,
    );
  }
}

/**
 * Is `worktreePath` still in `git worktree list --porcelain`?
 *
 * THREE-VALUED on purpose. Collapsing "git could not tell me" into "not
 * registered" is the bug described above: it turns a broken repository into a
 * confident report of success. `unknown` is the caller's cue to refuse to claim
 * anything.
 */
async function registrationOf(
  runner: ProcessRunner,
  repoRoot: string,
  worktreePath: string,
): Promise<'present' | 'absent' | 'unknown'> {
  const list = await runner.run({
    binary: 'git',
    args: ['worktree', 'list', '--porcelain'],
    cwd: repoRoot,
    timeoutMs: GIT_TIMEOUT_MS,
    env: { inherit: true },
  });

  if (list.outcome !== 'completed' || list.exitCode !== 0) {
    return 'unknown';
  }

  const registered = list.stdout
    .split('\n')
    .some((line) => line.startsWith('worktree ') && line.slice('worktree '.length) === worktreePath);

  return registered ? 'present' : 'absent';
}

/** The first line of a stderr blob, for a single-line error message. */
function firstLine(stderr: string): string {
  return stderr.trim().split('\n')[0] ?? 'git reported no reason';
}
