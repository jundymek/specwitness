/**
 * Story 3.1 AC3 — resolving the repository, and refusing rather than guessing.
 *
 * The single most consequential test in this file is the linked-worktree one.
 * A naive walk upward from a linked worktree finds that worktree's `.git`
 * FILE, and a verify that proceeds from there reports a verdict about a
 * repository nobody asked about — while looking completely normal. This
 * project is itself such a case: nine linked worktrees under
 * `/Users/jundymek/dev/specwitness-agents/`, one per agent in this cohort.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createGitVcs } from '../../../src/infra/vcs.js';
import { createProcessRunner } from '../../../src/infra/process-runner.js';
import { SystemClock } from '../../../src/infra/clock.js';
import { addLinkedWorktree, git, makeRepo, scratchDir } from './fixture-repo.js';

const scratches: string[] = [];

/** Every test's temp tree, removed afterwards — no leftovers, ever. */
function track<T extends { scratch: string }>(value: T): T {
  scratches.push(value.scratch);
  return value;
}

afterEach(async () => {
  await Promise.all(scratches.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function vcs(): ReturnType<typeof createGitVcs> {
  return createGitVcs({ runner: createProcessRunner(new SystemClock()) });
}

describe('resolveRoot — the happy paths', () => {
  it('resolves an explicit --root that is a repository', async () => {
    const repo = track(await makeRepo('root-explicit'));

    const result = await vcs().resolveRoot({ explicitRoot: repo.path, cwd: '/' });

    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    expect(result.root.mainWorktreeRoot).toBe(repo.path);
    expect(result.root.worktreeRoot).toBe(repo.path);
    expect(result.root.linkedWorktree).toBe(false);
  });

  it('walks up to the repository from a directory nested inside it', async () => {
    const repo = track(await makeRepo('root-walkup'));
    const nested = join(repo.path, 'src', 'deeply', 'nested');
    await mkdir(nested, { recursive: true });

    const result = await vcs().resolveRoot({ cwd: nested });

    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    // The repository root, not the directory we started in.
    expect(result.root.mainWorktreeRoot).toBe(repo.path);
    expect(result.root.worktreeRoot).toBe(repo.path);
  });
});

describe('resolveRoot — invoked from a LINKED worktree (the harness case)', () => {
  it('reports the MAIN worktree as the source repo, not the linked one', async () => {
    const repo = track(await makeRepo('root-linked'));
    const linked = await addLinkedWorktree(repo, 'linked-checkout');

    const result = await vcs().resolveRoot({ cwd: linked });

    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    // The bug this asserts against: answering `linked` here would verify a
    // different tree than the one the operator's repository is.
    expect(result.root.mainWorktreeRoot).toBe(repo.path);
    expect(result.root.worktreeRoot).toBe(linked);
    expect(result.root.linkedWorktree).toBe(true);
  });

  it('shares one common git dir between the linked worktree and the repo', async () => {
    const repo = track(await makeRepo('root-common'));
    const linked = await addLinkedWorktree(repo, 'linked-common');

    const fromLinked = await vcs().resolveRoot({ cwd: linked });
    const fromMain = await vcs().resolveRoot({ cwd: repo.path });

    expect(fromLinked.outcome).toBe('resolved');
    expect(fromMain.outcome).toBe('resolved');
    if (fromLinked.outcome !== 'resolved' || fromMain.outcome !== 'resolved') return;
    // Same repository, reached two ways — so refs and worktree registrations
    // are the same set whichever checkout you started from.
    expect(fromLinked.root.gitCommonDir).toBe(fromMain.root.gitCommonDir);
    expect(fromLinked.root.mainWorktreeRoot).toBe(fromMain.root.mainWorktreeRoot);
  });
});

describe('resolveRoot — the AC3 refusal matrix', () => {
  it('refuses a --root that does not exist', async () => {
    const scratch = await scratchDir('root-missing');
    scratches.push(scratch);

    const result = await vcs().resolveRoot({
      explicitRoot: join(scratch, 'no-such-directory'),
      cwd: scratch,
    });

    expect(result.outcome).toBe('not-found');
    if (result.outcome === 'resolved') return;
    expect(result.path).toContain('no-such-directory');
  });

  it('refuses a --root that is not a git repository', async () => {
    const scratch = await scratchDir('root-nonrepo');
    scratches.push(scratch);
    await writeFile(join(scratch, 'a-file.txt'), 'not a repo\n', 'utf8');

    const result = await vcs().resolveRoot({ explicitRoot: scratch, cwd: scratch });

    expect(result.outcome).toBe('not-a-repo');
    if (result.outcome === 'resolved') return;
    expect(result.path).toBe(scratch);
  });

  it('refuses a --root that is a FILE rather than a directory', async () => {
    const scratch = await scratchDir('root-file');
    scratches.push(scratch);
    const file = join(scratch, 'a-file.txt');
    await writeFile(file, 'not a directory\n', 'utf8');

    const result = await vcs().resolveRoot({ explicitRoot: file, cwd: scratch });

    // Not `resolved`, and not a crash. Which refusal it is matters less than
    // that a file can never be mistaken for a repository.
    expect(result.outcome).not.toBe('resolved');
  });

  it('refuses when there is no repository at or above the cwd', async () => {
    const scratch = await scratchDir('root-none-above');
    scratches.push(scratch);

    const result = await vcs().resolveRoot({ cwd: scratch });

    expect(result.outcome).toBe('not-a-repo');
    if (result.outcome === 'resolved') return;
    expect(result.detail).not.toBe('');
  });

  it('refuses a bare repository, which has no working tree to verify', async () => {
    const scratch = await scratchDir('root-bare');
    scratches.push(scratch);
    await git(scratch, 'init', '--quiet', '--bare', 'bare.git');
    const bare = join(scratch, 'bare.git');

    const result = await vcs().resolveRoot({ explicitRoot: bare, cwd: scratch });

    // Every guarantee in this story is phrased about a working tree. Refusing
    // is honest; half-supporting a bare repo would not be.
    expect(result.outcome).toBe('not-a-repo');
    if (result.outcome === 'resolved') return;
    expect(result.detail).toMatch(/bare/i);
  });

  it('prefers an explicit --root over the cwd, even when the cwd is a repo', async () => {
    const outer = track(await makeRepo('root-outer'));
    const inner = track(await makeRepo('root-inner'));

    const result = await vcs().resolveRoot({ explicitRoot: inner.path, cwd: outer.path });

    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    // --root always wins. Silently preferring the cwd would verify the wrong
    // repository for an operator who was explicit about which one they meant.
    expect(result.root.mainWorktreeRoot).toBe(inner.path);
  });
});
