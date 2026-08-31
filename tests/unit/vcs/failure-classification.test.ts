/**
 * Story 3.1 — what happens when git itself misbehaves.
 *
 * Every case here was raised by the story's Codex review pass, and every one is
 * a way for this adapter to report SUCCESS or the WRONG DIAGNOSIS while the
 * environment is broken. That is the single failure class this project treats as
 * first-order: an infra problem surfacing as a product answer.
 *
 * The `ProcessRunner` is faked rather than the filesystem sabotaged, because
 * "git timed out" and "git could not be spawned" are not states a test can
 * produce reliably against a real binary — and the merged port already gives
 * them to us as ordinary values.
 */

import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { InfraError } from '../../../src/domain/errors.js';
import type {
  ProcessResult,
  ProcessRunOptions,
  ProcessRunner,
} from '../../../src/domain/process-runner.js';
import type { RepoRoot } from '../../../src/domain/vcs.js';
import { SystemClock } from '../../../src/infra/clock.js';
import { createProcessRunner } from '../../../src/infra/process-runner.js';
import { createGitVcs } from '../../../src/infra/vcs.js';
import { git, makeRepo, scratchDir, type FixtureRepo } from './fixture-repo.js';

const scratches: string[] = [];
const containers: string[] = [];

afterEach(async () => {
  await Promise.all([
    ...scratches.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    ...containers.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  ]);
});

const real = createProcessRunner(new SystemClock());

/**
 * A runner that delegates to the real one, but rewrites the OUTCOME of calls
 * matching `match` — so a command that genuinely succeeded can be presented to
 * the adapter as having timed out.
 *
 * Rewriting the outcome rather than skipping the call is what makes the
 * `worktree add` test meaningful: the worktree really does get registered, and
 * then the adapter is told the command failed. That is exactly the shape of a
 * timeout arriving after registration, which is the leak being tested for.
 */
function runnerFailing(
  match: (options: ProcessRunOptions) => boolean,
  outcome: ProcessResult['outcome'],
): ProcessRunner {
  return {
    async run(options: ProcessRunOptions): Promise<ProcessResult> {
      const result = await real.run(options);
      if (!match(options)) {
        return result;
      }
      return { ...result, outcome, exitCode: null, stderr: `simulated ${outcome}` };
    },
  };
}

const isSubcommand = (options: ProcessRunOptions, ...words: string[]): boolean =>
  words.every((word, index) => options.args[index] === word);

async function repoWithRoot(label: string): Promise<{ repo: FixtureRepo; root: RepoRoot }> {
  const repo = await makeRepo(label);
  scratches.push(repo.scratch);
  const resolved = await createGitVcs({ runner: real }).resolveRoot({
    explicitRoot: repo.path,
    cwd: repo.path,
  });
  if (resolved.outcome !== 'resolved') {
    throw new Error(`fixture root did not resolve: ${resolved.outcome}`);
  }
  return { repo, root: resolved.root };
}

describe('a failing `worktree list` must never read as "nothing is registered"', () => {
  it('makes removeWorktreeAt throw instead of silently reporting success', async () => {
    const { repo, root } = await repoWithRoot('fail-list-remove');
    const created = await createGitVcs({ runner: real }).addWorktree(root, repo.headSha);
    containers.push(created.container);

    const blind = createGitVcs({
      runner: runnerFailing((o) => isSubcommand(o, 'worktree', 'list'), 'timed-out'),
    });

    // The bug this guards: an empty list makes every recorded worktree look
    // already-absent, so `clean` would report a clean sweep while the checkout
    // and its registration are still there. Leaking loudly beats leaking
    // silently — a reaper that cannot see is a reaper that must say so.
    await expect(blind.removeWorktreeAt(root, created.path)).rejects.toThrow(InfraError);

    // And the worktree really is still registered, so the refusal was correct.
    const entries = await createGitVcs({ runner: real }).listWorktrees(root);
    expect(entries.map((entry) => entry.path)).toContain(created.path);

    await createGitVcs({ runner: real }).removeWorktree(root, created);
  });

  it('makes listWorktrees throw rather than return an empty list', async () => {
    const { root } = await repoWithRoot('fail-list-plain');

    const blind = createGitVcs({
      runner: runnerFailing((o) => isSubcommand(o, 'worktree', 'list'), 'spawn-failed'),
    });

    await expect(blind.listWorktrees(root)).rejects.toThrow(InfraError);
  });
});

describe('a `worktree add` that fails AFTER registering must not leave the registration', () => {
  it('removes the registration as well as the container', async () => {
    const { repo, root } = await repoWithRoot('fail-add-registered');

    // The add genuinely runs and registers; the adapter is then told it timed
    // out. Without cleanup this leaves a prunable `.git/worktrees/<name>` entry
    // that survives deleting the checkout, and the NEXT add at that path fails
    // with a confusing error.
    const flaky = createGitVcs({
      runner: runnerFailing((o) => isSubcommand(o, 'worktree', 'add'), 'timed-out'),
    });

    await expect(flaky.addWorktree(root, repo.headSha)).rejects.toThrow(InfraError);

    const entries = await createGitVcs({ runner: real }).listWorktrees(root);
    // Only the main worktree should remain.
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe(repo.path);

    const admin = await git(repo.path, 'worktree', 'list', '--porcelain');
    expect(admin).not.toContain('specwitness-worktree-');
  });
});

describe('a repository that breaks after root resolution is not a missing ref', () => {
  it('reports not-a-repo rather than not-found with a "git fetch" hint', async () => {
    const { repo, root } = await repoWithRoot('fail-corrupt-repo');

    // Root resolution succeeded a moment ago; now the repository is gone.
    // Classifying this as `not-found` would tell the operator to run
    // `git fetch` to fix a repository that no longer exists — a confidently
    // wrong diagnosis, which is worse than a vague one.
    await rm(join(repo.path, '.git'), { recursive: true, force: true });

    const result = await createGitVcs({ runner: real }).resolveRef(root, 'head', 'main');

    expect(result.outcome).toBe('not-a-repo');
  });

  it('still reports a genuinely missing ref as not-found', async () => {
    const { root } = await repoWithRoot('fail-still-not-found');

    // The other half: the re-probe must not turn every missing ref into a
    // repository error, or the `git fetch` hint would never be shown.
    const result = await createGitVcs({ runner: real }).resolveRef(root, 'head', 'no-such-ref');

    expect(result.outcome).toBe('not-found');
  });
});

describe('an operational git failure is not "this is not a repository"', () => {
  it('reports git-unavailable when rev-parse times out during root resolution', async () => {
    const repo = await makeRepo('fail-root-timeout');
    scratches.push(repo.scratch);

    // `git --version` succeeds, so git is installed; the probe that inspects the
    // repository then hangs. Reporting `not-a-repo` here would tell an operator
    // that their perfectly good repository is not one — a false, actionable
    // diagnosis, and the fourth instance in this story of one helper
    // collapsing "git could not run" into "git said no".
    const hanging = createGitVcs({
      runner: runnerFailing((o) => isSubcommand(o, 'rev-parse'), 'timed-out'),
    });

    const result = await hanging.resolveRoot({ explicitRoot: repo.path, cwd: repo.path });

    expect(result.outcome).toBe('git-unavailable');
  });

  it('reports git-unavailable when the worktree listing fails during root resolution', async () => {
    const repo = await makeRepo('fail-root-list');
    scratches.push(repo.scratch);

    // The last probe in `resolveRoot`, and the last place this rule was still
    // wrong. `worktree list` is how the MAIN worktree is found; a git that
    // cannot answer it has told us nothing about whether the directory is a
    // repository.
    const hanging = createGitVcs({
      runner: runnerFailing((o) => isSubcommand(o, 'worktree', 'list'), 'timed-out'),
    });

    const result = await hanging.resolveRoot({ explicitRoot: repo.path, cwd: repo.path });

    expect(result.outcome).toBe('git-unavailable');
  });

  it('still reports a genuine non-repository as not-a-repo', async () => {
    const scratch = await scratchDir('fail-root-genuine');
    scratches.push(scratch);

    // The other half: only a COMPLETED non-zero git response means "no
    // repository here". Without this the fix above would swallow the real case.
    const result = await createGitVcs({ runner: real }).resolveRoot({
      explicitRoot: scratch,
      cwd: scratch,
    });

    expect(result.outcome).toBe('not-a-repo');
  });
});

describe('the ambiguity check must never degrade into "resolved"', () => {
  it('refuses when the candidate enumeration itself could not run', async () => {
    const { root } = await repoWithRoot('fail-candidates');

    // `rev-parse` succeeds, then `for-each-ref` times out. Treating that as
    // "no candidates" would return `resolved` carrying git's precedence pick —
    // accepting a possibly-ambiguous answer BECAUSE the ambiguity check failed.
    // Exactly backwards: a check that cannot run must fail closed.
    const blind = createGitVcs({
      runner: runnerFailing((o) => isSubcommand(o, 'for-each-ref'), 'timed-out'),
    });

    const result = await blind.resolveRef(root, 'head', 'main');

    expect(result.outcome).not.toBe('resolved');
    expect(result.outcome).toBe('git-unavailable');
  });

  it('refuses a pseudoref that collides with a real ref', async () => {
    const { repo, root } = await repoWithRoot('fail-pseudoref');

    // git's documented lookup order starts at `$GIT_DIR/<refname>`, one step
    // BEFORE `refs/`. So a branch named FETCH_HEAD and a real `.git/FETCH_HEAD`
    // at a different commit are two different answers to one name — git warns
    // and returns the pseudoref, while an enumeration that only walks `refs/**`
    // sees a single candidate and calls it unambiguous.
    await git(repo.path, 'branch', 'FETCH_HEAD', repo.firstSha);
    await writeFile(
      join(repo.path, '.git', 'FETCH_HEAD'),
      `${repo.headSha}\t\tbranch 'x' of somewhere\n`,
      'utf8',
    );

    const result = await createGitVcs({ runner: real }).resolveRef(root, 'head', 'FETCH_HEAD');

    // Which commit it would have picked matters less than that it refuses to
    // pick one at all.
    expect(result.outcome).toBe('ambiguous');
  });
});

describe('SHA-256 repositories', () => {
  it('resolves a ref whose object id is 64 hex characters', async () => {
    const repo = await makeRepo('fail-sha256-base');
    scratches.push(repo.scratch);

    // git supports `--object-format=sha256`, where every object id is 64 hex
    // chars. A 40-character validator reports an existing ref as not-found —
    // an infra misclassification on a repository that is entirely valid.
    const sha256Path = join(repo.scratch, 'sha256-repo');
    await git(repo.scratch, 'init', '--quiet', '--object-format=sha256', '-b', 'main', 'sha256-repo');
    await git(sha256Path, 'config', 'user.name', 'SpecWitness Fixture');
    await git(sha256Path, 'config', 'user.email', 'fixture@specwitness.invalid');
    await git(sha256Path, 'config', 'commit.gpgsign', 'false');
    await git(sha256Path, 'commit', '--quiet', '--allow-empty', '-m', 'sha256 root');
    const expected = (await git(sha256Path, 'rev-parse', 'HEAD')).trim();
    expect(expected).toHaveLength(64);

    const vcs = createGitVcs({ runner: real });
    const resolved = await vcs.resolveRoot({ explicitRoot: sha256Path, cwd: sha256Path });
    expect(resolved.outcome).toBe('resolved');
    if (resolved.outcome !== 'resolved') return;

    const result = await vcs.resolveRef(resolved.root, 'head', 'main');

    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    expect(result.sha).toBe(expected);
  });
});
