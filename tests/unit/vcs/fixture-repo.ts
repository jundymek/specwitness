/**
 * Real git repositories, built by the test, in the test's own temp directory.
 *
 * WHY NOT THIS REPOSITORY: it carries nine live linked worktrees from the agent
 * harness (one per agent in this cohort), so any assertion over
 * `git worktree list` here would be asserting on peers' state — and would flap
 * as they come and go. Never this repo, and never the network: every ref these
 * tests resolve is one they created themselves.
 *
 * WHY PER-TEST DIRECTORIES (H-8): the harness runs `pnpm test` in this worktree
 * while the agent runs it too. Two concurrent suites sharing a fixed-name
 * scratch path would delete each other's repositories mid-run. Every helper
 * here mints a fresh `mkdtemp`, and there is no fixed-name path anywhere.
 *
 * WHY `realpath`: on macOS `os.tmpdir()` is `/var/folders/…`, a symlink into
 * `/private/var/…`, and git reports the RESOLVED form. Measured — a
 * `mktemp -d /tmp/x` came back from `git worktree list` as `/private/tmp/x`.
 * Comparing an unresolved path against git's output silently fails, so these
 * helpers hand back resolved paths and the tests compare like with like.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Runs git with a fixed argument array and no shell (AD-3 applies to fixtures
 * too — a test that shells out is a test that can be surprised by a branch name).
 *
 * The environment is pinned so results do not depend on the developer's global
 * git config: no signing (a machine with `commit.gpgsign=true` would otherwise
 * hang or fail), no prompts, and a fixed identity.
 */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'SpecWitness Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@specwitness.invalid',
      GIT_COMMITTER_NAME: 'SpecWitness Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@specwitness.invalid',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  return stdout;
}

/** A scratch directory under the OS temp dir, realpath-resolved. */
export async function scratchDir(label: string): Promise<string> {
  const base = await realpath(tmpdir());
  return await realpath(await mkdtemp(join(base, `sw-${label}-`)));
}

export interface FixtureRepo {
  /** The repository's working tree, realpath-resolved. */
  readonly path: string;
  /** The scratch directory containing it — remove this to clean up. */
  readonly scratch: string;
  /** SHA of the first commit. */
  readonly firstSha: string;
  /** SHA of the second commit, which `main` points at. */
  readonly headSha: string;
  /** An ANNOTATED tag on the FIRST commit — the `^{commit}` peel case. */
  readonly tagName: string;
  /** The tag OBJECT's sha, which is NOT the commit's. */
  readonly tagObjectSha: string;
}

/**
 * A repository with two commits, a branch, and an annotated tag.
 *
 * The annotated tag is the point rather than decoration: `git rev-parse v1`
 * yields the tag object's sha while `git rev-parse v1^{commit}` yields the
 * commit's, and a worktree created at the former sits at a revision the run
 * record does not name.
 */
export async function makeRepo(label = 'repo'): Promise<FixtureRepo> {
  const scratch = await scratchDir(label);
  const path = join(scratch, 'repo');

  await git(scratch, 'init', '--quiet', '--initial-branch=main', 'repo');
  // Repo-local, so a developer's global config cannot change what these assert.
  await git(path, 'config', 'commit.gpgsign', 'false');
  await git(path, 'config', 'user.name', 'SpecWitness Fixture');
  await git(path, 'config', 'user.email', 'fixture@specwitness.invalid');

  await writeFile(join(path, 'first.txt'), 'first\n', 'utf8');
  await git(path, 'add', 'first.txt');
  await git(path, 'commit', '--quiet', '-m', 'first');
  const firstSha = (await git(path, 'rev-parse', 'HEAD')).trim();

  const tagName = 'v1';
  await git(path, 'tag', '--annotate', tagName, '-m', 'annotated release');
  const tagObjectSha = (await git(path, 'rev-parse', tagName)).trim();

  await writeFile(join(path, 'second.txt'), 'second\n', 'utf8');
  await git(path, 'add', 'second.txt');
  await git(path, 'commit', '--quiet', '-m', 'second');
  const headSha = (await git(path, 'rev-parse', 'HEAD')).trim();

  return { path, scratch, firstSha, headSha, tagName, tagObjectSha };
}

/**
 * Adds a linked worktree to `repo`, returning its realpath.
 *
 * This is how the tests reproduce the case the harness actually produces — and
 * the one the highest-consequence bug in this story hides in.
 */
export async function addLinkedWorktree(repo: FixtureRepo, name: string): Promise<string> {
  const path = join(repo.scratch, name);
  await git(repo.path, 'worktree', 'add', '--quiet', '--detach', path, repo.headSha);
  return await realpath(path);
}

/**
 * The two facts AC2 is asserted against, as one string.
 *
 * `git status --porcelain` catches anything appearing in (or vanishing from)
 * the working tree; `git worktree list --porcelain` catches a registration that
 * outlived its directory — the leak that actually matters, because git keeps
 * administrative files under `.git/worktrees/<name>` that survive an `rm -rf`
 * of the checkout.
 */
export async function repoStateSnapshot(repoPath: string): Promise<string> {
  const status = await git(repoPath, 'status', '--porcelain');
  const worktrees = await git(repoPath, 'worktree', 'list', '--porcelain');
  return `## status\n${status}## worktrees\n${worktrees}`;
}

/**
 * Every ref in the repository with the object it points at.
 *
 * This is the "no implicit fetch" proof: if a failed head resolution had
 * quietly fetched, the remote-tracking refs would differ afterwards. Byte
 * comparison, so a new ref, a moved ref or a deleted one all show up.
 */
export async function refsSnapshot(repoPath: string): Promise<string> {
  return await git(repoPath, 'for-each-ref', '--format=%(refname) %(objectname)');
}
