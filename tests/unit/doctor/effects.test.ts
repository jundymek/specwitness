import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDoctorEffects } from '../../../src/cli/doctor/effects.js';

/**
 * The real effects, at the one boundary where getting it wrong is invisible.
 *
 * `RunOutcome.notFound` is what lets doctor say "git is not installed" instead
 * of "git exited without a code", and telling those apart is most of doctor's
 * value on a broken machine. It is also exactly the kind of flag that can be
 * wrong forever without any test noticing, because the happy path never
 * exercises it — which is what happened: under the pinned execa 10, a binary
 * that is not on PATH does not throw, it RESOLVES with `code: 'ENOENT'` and
 * `exitCode: undefined`. Classifying ENOENT only inside the `catch` therefore
 * never ran, and `notFound` was false for every input. Reported by story 2.3
 * (pamela) after her own runner test went red against the same pattern, and
 * reproduced here before fixing.
 *
 * PATH is manipulated for the child only, and restored in `afterEach`. The
 * product never mutates the parent environment (AD-4); a test that left PATH
 * empty would take the rest of the suite down with it.
 */

const REAL_PATH = process.env['PATH'];

afterEach(() => {
  if (REAL_PATH === undefined) {
    delete process.env['PATH'];
  } else {
    process.env['PATH'] = REAL_PATH;
  }
});

describe('runGit', () => {
  it('reports a missing binary as notFound, not as a mysterious exit', async () => {
    // An empty directory as the entire PATH: git cannot be found, and nothing
    // else can either.
    const emptyDir = await mkdtemp(join(tmpdir(), 'specwitness-no-path-'));
    process.env['PATH'] = emptyDir;

    const outcome = await createDoctorEffects().runGit(['--version'], {
      cwd: process.cwd(),
      timeoutMs: 5_000,
    });

    expect(outcome.notFound).toBe(true);
    expect(outcome.exitCode).toBeNull();
  });

  it('reports a working git as found, with its version on stdout', async () => {
    const outcome = await createDoctorEffects().runGit(['--version'], {
      cwd: process.cwd(),
      timeoutMs: 5_000,
    });

    expect(outcome.notFound).toBe(false);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain('git version');
  });

  it('does not call an invalid cwd a missing binary', async () => {
    // execa raises the SAME `code: 'ENOENT'` for a working directory that does
    // not exist as it does for a binary that is not on PATH. Classifying on
    // ENOENT alone would make doctor tell an operator to install the git they
    // already have — a confidently wrong diagnosis, which is worse than a vague
    // one from the tool whose whole job is to be right about this.
    //
    // Reported by story 2.3 (pamela) against her ProcessRunner after she hit it
    // there; reproduced against the installed execa here before fixing, since
    // the same trap sits one layer over in doctor's own spawn path.
    const outcome = await createDoctorEffects().runGit(['--version'], {
      cwd: join(tmpdir(), 'specwitness-definitely-no-such-dir-9f3c'),
      timeoutMs: 5_000,
    });

    expect(outcome.notFound).toBe(false);
    // And it says something useful: execa puts its explanation on the error's
    // message, not on stderr, so a naive passthrough would report nothing at all.
    expect(outcome.stderr).toContain('cwd');
  });

  it('reports a non-zero exit as "said no", not as missing', async () => {
    // The third member of the missing / hung / said-no vocabulary. A git that
    // ran and refused is a result to interpret, not a broken machine.
    const outcome = await createDoctorEffects().runGit(
      ['rev-parse', '--verify', 'refs/heads/definitely-no-such-branch-9f3c'],
      { cwd: process.cwd(), timeoutMs: 5_000 },
    );

    expect(outcome.notFound).toBe(false);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.exitCode).not.toBe(0);
  });
});
