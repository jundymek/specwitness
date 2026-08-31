/**
 * Git availability (FR-3, required).
 *
 * Git is trusted tooling, not a project-declared command, so invoking it is
 * allowed under AD-3 — with a fixed argument array and no shell. Every later
 * epic depends on it (worktree isolation, base/head runs), so its absence is an
 * environment failure, not a product verdict.
 */

import type { DoctorCheck } from '../registry.js';
import { GIT_TIMEOUT_MS, describeGitFailure } from './git.js';

export const gitPresentCheck: DoctorCheck = {
  id: 'git-present',
  required: true,
  async run(ctx) {
    const outcome = await ctx.effects.runGit(['--version'], {
      cwd: ctx.projectRoot,
      timeoutMs: GIT_TIMEOUT_MS,
    });

    const failure = describeGitFailure(outcome);
    if (failure !== undefined) {
      return { status: 'fail', detail: failure };
    }

    // A git that starts and then fails — a broken install, a missing shared
    // library, a wrapper script that errors — is not a working git. Spawning
    // successfully is not the same as working, and reporting `pass` here would
    // send the user looking at their project instead of their machine.
    if (outcome.exitCode !== 0) {
      const reason = outcome.stderr.trim() || outcome.stdout.trim() || 'no output';
      return {
        status: 'fail',
        detail: `git --version exited ${outcome.exitCode ?? 'without a code'}: ${reason}`,
      };
    }

    const version = outcome.stdout.trim();
    return { status: 'pass', detail: version === '' ? 'git is available' : version };
  },
};
