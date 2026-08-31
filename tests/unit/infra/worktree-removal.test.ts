import { describe, expect, it } from 'vitest';

import { InfraError } from '../../../src/domain/errors.js';
import type { ProcessResult, ProcessRunOptions, ProcessRunner } from '../../../src/domain/process-runner.js';
import { removeWorktreeAtPath } from '../../../src/infra/worktree-removal.js';

/**
 * The TEMPORARY worktree-removal default behind `clean`'s one-function seam.
 *
 * Story 3.1 (alice) owns worktree removal and is in the same wave, so her
 * `src/infra/vcs.ts` does not exist on this branch; whichever of us merges
 * second deletes this module and wires `clean` to hers. These tests exist for
 * the window in which the temporary version is what actually runs, and they
 * encode the one property that must not differ between the two
 * implementations:
 *
 *   REMOVAL IS NEVER CLAIMED WITHOUT PROOF.
 *
 * alice hit the opposite of that during her own review: a `git worktree list`
 * that could not answer read as "nothing is registered", so every recorded
 * worktree looked already-gone and `clean` reported a clean sweep while the
 * checkout and its registration were both still there. She fixed hers and told
 * me; this file is that fix, plus the test that keeps it fixed.
 */

const OK = (stdout = ''): ProcessResult => ({
  outcome: 'completed',
  exitCode: 0,
  stdout,
  stderr: '',
  durationMs: 1,
  pgid: 4242,
});

const FAILED = (stderr: string, exitCode = 128): ProcessResult => ({
  outcome: 'completed',
  exitCode,
  stdout: '',
  stderr,
  durationMs: 1,
  pgid: 4242,
});

/** A runner scripted per git subcommand, so each test states only what it means. */
function scripted(handlers: {
  remove: ProcessResult;
  list: ProcessResult;
}): { runner: ProcessRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: ProcessRunner = {
    run: async (options: ProcessRunOptions) => {
      calls.push([...options.args]);
      return options.args[1] === 'remove' ? handlers.remove : handlers.list;
    },
  };
  return { runner, calls };
}

const WORKTREE = '/tmp/specwitness-abc/worktree';
const REPO = '/tmp/specwitness-repo';

describe('removeWorktreeAtPath', () => {
  it('removes the worktree and confirms the registration is gone', async () => {
    const { runner, calls } = scripted({ remove: OK(), list: OK('worktree /tmp/specwitness-repo\n') });

    await expect(removeWorktreeAtPath(runner, REPO, WORKTREE)).resolves.toBeUndefined();

    // `--force`, and the path as ONE argv element (AD-3: no shell, so a path
    // with a space is not word-split).
    expect(calls[0]).toEqual(['worktree', 'remove', '--force', WORKTREE]);
    expect(calls[1]).toEqual(['worktree', 'list', '--porcelain']);
  });

  it('raises when the registration survives the removal', async () => {
    const { runner } = scripted({
      remove: OK(),
      list: OK(`worktree ${REPO}\n\nworktree ${WORKTREE}\n`),
    });

    await expect(removeWorktreeAtPath(runner, REPO, WORKTREE)).rejects.toThrow(
      /left a registration behind/,
    );
  });

  it('treats an unregistered path as a no-op rather than an error', async () => {
    // `clean` replays manifests, so a path already reaped is the common case and
    // must not fail the run.
    const { runner } = scripted({
      remove: FAILED(`fatal: '${WORKTREE}' is not a working tree`),
      list: OK(`worktree ${REPO}\n`),
    });

    await expect(removeWorktreeAtPath(runner, REPO, WORKTREE)).resolves.toBeUndefined();
  });

  it('NEVER reports success when git worktree list could not answer', async () => {
    // The bug alice found and fixed in her own implementation: a git that cannot
    // list makes every recorded worktree look already-absent, so `clean` reports
    // a clean sweep while the checkout is still there. A leak that announces
    // itself is recoverable; one that reports success is not.
    for (const list of [
      FAILED('fatal: not a git repository'),
      { ...OK(), outcome: 'timed-out' as const, exitCode: null },
      { ...OK(), outcome: 'not-found' as const, exitCode: null },
      { ...OK(), outcome: 'spawn-failed' as const, exitCode: null },
    ]) {
      const { runner } = scripted({ remove: FAILED('fatal: could not remove'), list });

      await expect(removeWorktreeAtPath(runner, REPO, WORKTREE)).rejects.toThrow(
        /could not verify/,
      );
    }
  });

  it('does not claim a successful removal it could not verify either', async () => {
    const { runner } = scripted({ remove: OK(), list: FAILED('fatal: not a git repository') });

    await expect(removeWorktreeAtPath(runner, REPO, WORKTREE)).rejects.toThrow(/could not verify/);
  });

  it('reports a missing git as an InfraError naming the remedy', async () => {
    const { runner } = scripted({
      remove: { ...OK(), outcome: 'not-found', exitCode: null },
      list: OK(),
    });

    const error = await removeWorktreeAtPath(runner, REPO, WORKTREE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InfraError);
    expect((error as InfraError).message).toMatch(/git not found on PATH/);
  });
});
