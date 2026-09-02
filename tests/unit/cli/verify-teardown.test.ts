/**
 * `releaseRun` — the order teardown releases things in, and what happens when a step fails.
 *
 * Both are easy to get wrong in ways nothing notices until an operator's next run fails on
 * an occupied port, and neither is reachable from an integration test without an unkillable
 * process — which is not a thing a test may create.
 *
 * The defect this file was written for: the first version awaited the two steps in sequence,
 * so a service group that could not be terminated meant the worktree removal was never
 * attempted. One unkillable process leaked the worktree as well. Found by this story's Codex
 * review pass.
 */

import { describe, expect, it } from 'vitest';

import { InfraError } from '../../../src/domain/errors.js';
import { releaseRun } from '../../../src/cli/verify/teardown.js';

function steps(options: {
  readonly servicesFail?: string;
  readonly worktreeFail?: string;
}): { readonly ran: string[]; readonly teardown: Parameters<typeof releaseRun>[0] } {
  const ran: string[] = [];
  return {
    ran,
    teardown: {
      releaseServices: async () => {
        ran.push('services');
        if (options.servicesFail !== undefined) {
          throw new InfraError(options.servicesFail, 'hint');
        }
      },
      removeWorktree: async () => {
        ran.push('worktree');
        if (options.worktreeFail !== undefined) {
          throw new Error(options.worktreeFail);
        }
      },
    },
  };
}

describe('releaseRun — order', () => {
  it('drains services BEFORE removing the worktree', async () => {
    // A live service holds a file handle and its cwd inside the worktree; removing the tree
    // out from under it fails or half-succeeds, and a half-removed worktree that
    // `git worktree list` still knows about is worse than an intact one.
    const { ran, teardown } = steps({});

    await releaseRun(teardown);

    expect(ran).toEqual(['services', 'worktree']);
  });
});

describe('releaseRun — a failing step never cancels the other attempt', () => {
  it('STILL removes the worktree when service teardown fails', async () => {
    // The defect. Best-effort means every step is attempted; a step skipped because an
    // earlier one failed is not best-effort, it is first-effort — and it leaks a worktree
    // for no reason at all.
    const { ran, teardown } = steps({ servicesFail: 'pgid 4242 would not die' });

    await expect(releaseRun(teardown)).rejects.toBeInstanceOf(InfraError);

    expect(ran).toEqual(['services', 'worktree']);
  });

  it('reports BOTH failures, not just the first', async () => {
    // The timeline entry an operator reads is the only place either of these is recorded.
    // Reporting one would leave the other on the machine and unmentioned.
    const { teardown } = steps({
      servicesFail: 'pgid 4242 would not die',
      worktreeFail: 'EBUSY: resource busy',
    });

    const failure = await releaseRun(teardown).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(InfraError);
    expect((failure as InfraError).message).toContain('pgid 4242 would not die');
    expect((failure as InfraError).message).toContain('EBUSY: resource busy');
    expect((failure as InfraError).message).toContain('services');
    expect((failure as InfraError).message).toContain('worktree');
  });

  it('names `specwitness clean`, because that is what resolves either leak', async () => {
    const { teardown } = steps({ worktreeFail: 'EBUSY' });

    const failure = (await releaseRun(teardown).catch((error: unknown) => error)) as InfraError;

    expect(failure.hint).toContain('specwitness clean');
  });

  it('resolves silently when both steps succeed', async () => {
    const { teardown } = steps({});

    await expect(releaseRun(teardown)).resolves.toBeUndefined();
  });

  it('survives a thrown non-Error, because teardown must never fail to report', async () => {
    const ran: string[] = [];

    const failure = (await releaseRun({
      releaseServices: async () => {
        ran.push('services');
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'a string, from somewhere nobody anticipated';
      },
      removeWorktree: async () => {
        ran.push('worktree');
      },
    }).catch((error: unknown) => error)) as InfraError;

    expect(ran).toEqual(['services', 'worktree']);
    expect(failure.message).toContain('a string, from somewhere nobody anticipated');
  });
});
