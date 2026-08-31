/**
 * Base branch resolvability (FR-3, required).
 *
 * Verification is always relative to a base branch, so a base branch that does
 * not resolve means every later stage would be comparing against nothing. This
 * check stays REQUIRED even though it is the one most likely to be red on a
 * fresh repository: on a `git init` with no commits, `refs/heads/<name>` does
 * not exist yet, and reporting that honestly is better than a green check that
 * means nothing. `init` writes the repo's real branch into the config (story
 * 1.4 reads `.git/HEAD`), which handles the common `main`-vs-`master` case.
 *
 * Fully-qualified refs are used deliberately: `git rev-parse --verify master`
 * would also match a FILE named `master` in the working tree, and a check that
 * can be satisfied by an unrelated file is not a check.
 */

import type { DoctorCheck } from '../registry.js';
import { GIT_TIMEOUT_MS, describeGitFailure } from './git.js';

export const baseBranchCheck: DoctorCheck = {
  id: 'base-branch-exists',
  required: true,
  async run(ctx) {
    if (!ctx.config.ok) {
      return {
        status: 'fail',
        detail: 'cannot determine the base branch: the project config did not load (see config-valid)',
      };
    }

    const branch = ctx.config.value.project.baseBranch;
    const options = { cwd: ctx.projectRoot, timeoutMs: GIT_TIMEOUT_MS };

    // Ask whether this is a repository first, so "git is missing", "you are not
    // in a repository" and "that branch does not exist" stay three different
    // answers rather than one opaque failure.
    const repo = await ctx.effects.runGit(['rev-parse', '--git-dir'], options);
    const gitFailure = describeGitFailure(repo);
    if (gitFailure !== undefined) {
      return { status: 'fail', detail: gitFailure };
    }
    if (repo.exitCode !== 0) {
      return {
        status: 'fail',
        detail: `${ctx.projectRoot} is not a git repository; run doctor from the repository root`,
      };
    }

    for (const [ref, label] of [
      [`refs/heads/${branch}`, branch],
      [`refs/remotes/origin/${branch}`, `origin/${branch}`],
    ] as const) {
      const resolved = await ctx.effects.runGit(
        ['rev-parse', '--verify', '--quiet', ref],
        options,
      );
      const failure = describeGitFailure(resolved);
      if (failure !== undefined) {
        return { status: 'fail', detail: failure };
      }
      if (resolved.exitCode === 0) {
        return { status: 'pass', detail: `base branch ${label} resolves` };
      }
    }

    return {
      status: 'fail',
      detail: `base branch "${branch}" not found (no local ref, no origin/${branch}); set project.baseBranch in .specwitness/config.yaml, or push the branch`,
    };
  },
};
