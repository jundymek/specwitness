/**
 * Story 3.1 AC1/AC2 — creating and removing the detached verification worktree.
 *
 * The properties asserted here are the ones AD-8 actually promises: the
 * worktree is at the resolved revision, it is DETACHED, it lives under the OS
 * temp dir and NOT inside the source repository, the manifest record happens
 * BEFORE any git write, and removal leaves no registration behind.
 *
 * "No registration behind" is the one that bites in practice. `rm -rf` on a
 * checkout leaves `.git/worktrees/<name>` in place, and the next `worktree add`
 * at that path then fails with a confusing error — so removal goes through
 * `git worktree remove --force` and the registration is re-read afterwards
 * rather than assumed gone.
 */

import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { InfraError } from '../../../src/domain/errors.js';
import { SystemClock } from '../../../src/infra/clock.js';
import { createProcessRunner } from '../../../src/infra/process-runner.js';
import { createGitVcs, isInside, removeWorktreeAtPath } from '../../../src/infra/vcs.js';
import type { RepoRoot } from '../../../src/domain/vcs.js';
import { git, makeRepo, recordNothing, type FixtureRepo } from './fixture-repo.js';

const scratches: string[] = [];
const containers: string[] = [];

/**
 * Remembers a container so `afterEach` removes it.
 *
 * Needed because `removeWorktreeAt` deliberately does NOT delete the container:
 * a path alone does not identify one, and `clean` (3.2) must not guess at
 * deleting temp directories. That is correct for the product, and it makes the
 * tests exercising the path-only form responsible for their own leftovers.
 *
 * The bookkeeping is not politeness. An earlier revision of this file left nine
 * empty containers under `os.tmpdir()` after one run, for exactly the reason
 * Epic 2 left nine orphaned `sleep 3600` processes on this machine
 * (retrospective §5, debt 1): nobody owned the cleanup. A suite that leaks is a
 * suite nobody runs twice, and `tests/integration/worktree.test.ts` asserts the
 * no-leak property rather than trusting this comment.
 */
function trackContainer<T extends { container: string }>(created: T): T {
  containers.push(created.container);
  return created;
}

afterEach(async () => {
  // Belt and braces: anything a failing test left behind goes here too, so one
  // failure cannot leave worktrees or temp directories for the next run.
  await Promise.all([
    ...scratches.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    ...containers.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  ]);
});

function runnerOptions(): { runner: ReturnType<typeof createProcessRunner> } {
  return { runner: createProcessRunner(new SystemClock()) };
}

function vcs(): ReturnType<typeof createGitVcs> {
  return createGitVcs(runnerOptions());
}

async function repoWithRoot(label: string): Promise<{ repo: FixtureRepo; root: RepoRoot }> {
  const repo = await makeRepo(label);
  scratches.push(repo.scratch);
  const resolved = await vcs().resolveRoot({ explicitRoot: repo.path, cwd: repo.path });
  if (resolved.outcome !== 'resolved') {
    throw new Error(`fixture root did not resolve: ${resolved.outcome}`);
  }
  return { repo, root: resolved.root };
}

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    () => false,
  );
}

describe('addWorktree — where and what', () => {
  it('creates the worktree at the requested sha', async () => {
    const { repo, root } = await repoWithRoot('wt-sha');

    const created = trackContainer(await vcs().addWorktree(root, repo.firstSha, recordNothing));

    expect(created.sha).toBe(repo.firstSha);
    expect((await git(created.path, 'rev-parse', 'HEAD')).trim()).toBe(repo.firstSha);

    await vcs().removeWorktree(root, created);
  });

  it('creates it DETACHED, on no branch at all', async () => {
    const { repo, root } = await repoWithRoot('wt-detached');

    const created = trackContainer(await vcs().addWorktree(root, repo.headSha, recordNothing));

    // `symbolic-ref HEAD` succeeds on a branch and fails on a detached HEAD.
    // A worktree on a branch would let a later git write move that branch in
    // the SOURCE repository — precisely the mutation AC2 forbids.
    await expect(git(created.path, 'symbolic-ref', 'HEAD')).rejects.toThrow();

    const entries = await vcs().listWorktrees(root);
    const entry = entries.find((candidate) => candidate.path === created.path);
    expect(entry?.detached).toBe(true);
    expect(entry?.branch).toBeNull();

    await vcs().removeWorktree(root, created);
  });

  it('creates it under the OS temp dir and NOT inside the source repository', async () => {
    const { repo, root } = await repoWithRoot('wt-location');

    const created = trackContainer(await vcs().addWorktree(root, repo.headSha, recordNothing));

    // Both sides realpath-resolved: on macOS `tmpdir()` is a symlink into
    // `/private/var/…`, so comparing raw strings answers the wrong question.
    const tempRoot = await realpath(tmpdir());
    expect(isInside(tempRoot, created.path)).toBe(true);
    // AD-8: SpecWitness files never appear in the project working tree. A
    // worktree inside the repo would show up in the operator's `git status`.
    expect(isInside(repo.path, created.path)).toBe(false);

    await vcs().removeWorktree(root, created);
  });

  it('does not disturb the source repository working tree', async () => {
    const { repo, root } = await repoWithRoot('wt-clean-status');

    const created = trackContainer(await vcs().addWorktree(root, repo.headSha, recordNothing));

    expect((await git(repo.path, 'status', '--porcelain')).trim()).toBe('');

    await vcs().removeWorktree(root, created);
  });

  it('gives each worktree its own container, so two runs cannot collide', async () => {
    const { repo, root } = await repoWithRoot('wt-unique');

    const first = trackContainer(await vcs().addWorktree(root, repo.headSha, recordNothing));
    const second = trackContainer(await vcs().addWorktree(root, repo.firstSha, recordNothing));

    expect(first.path).not.toBe(second.path);
    expect(first.container).not.toBe(second.container);

    await vcs().removeWorktree(root, first);
    await vcs().removeWorktree(root, second);
  });
});

describe('addWorktree — the AD-8 record-before-use ordering', () => {
  it('calls the hook with the path BEFORE the worktree is registered', async () => {
    const { repo, root } = await repoWithRoot('wt-hook-order');
    let registeredWhenHookRan: boolean | null = null;
    let hookPath: string | null = null;

    const created = trackContainer(
      await vcs().addWorktree(root, repo.headSha, async (path) => {
        hookPath = path;
        const entries = await vcs().listWorktrees(root);
        registeredWhenHookRan = entries.some((entry) => entry.path === path);
      }),
    );

    // The manifest write happens at this hook. If the worktree were already
    // registered by now, a kill -9 in between would leave a resource the
    // manifest does not mention — the exact leak `clean` cannot recover from.
    expect(registeredWhenHookRan).toBe(false);
    expect(hookPath).toBe(created.path);

    await vcs().removeWorktree(root, created);
  });

  it('creates NO worktree when the hook rejects', async () => {
    const { repo, root } = await repoWithRoot('wt-hook-reject');
    const before = await vcs().listWorktrees(root);

    await expect(
      vcs().addWorktree(root, repo.headSha, async () => {
        throw new InfraError('could not durably write the manifest', 'check free space');
      }),
    ).rejects.toThrow(InfraError);

    // A failed manifest write must abort creation, not proceed unrecorded.
    const after = await vcs().listWorktrees(root);
    expect(after).toHaveLength(before.length);
  });

  it('leaves no container directory behind when the hook rejects', async () => {
    const { repo, root } = await repoWithRoot('wt-hook-cleanup');
    let reserved: string | null = null;

    await expect(
      vcs().addWorktree(root, repo.headSha, async (path) => {
        reserved = path;
        throw new InfraError('nope', 'hint');
      }),
    ).rejects.toThrow(InfraError);

    expect(reserved).not.toBeNull();
    expect(await exists(reserved as unknown as string)).toBe(false);
  });
});

describe('addWorktree — failure', () => {
  it('raises a named InfraError when the sha does not exist', async () => {
    const { root } = await repoWithRoot('wt-bad-sha');

    const attempt = vcs().addWorktree(root, '0'.repeat(40), recordNothing);

    await expect(attempt).rejects.toThrow(InfraError);
    await expect(attempt).rejects.toThrow(/could not create the verification worktree/);
  });

  it('leaves no container behind after a failed creation', async () => {
    const { root } = await repoWithRoot('wt-fail-cleanup');
    let container: string | null = null;

    // The hook is the only way to learn the container of an attempt that is
    // about to fail, since `addWorktree` throws rather than returning it. Using
    // it here keeps the assertion specific to THIS attempt rather than
    // sweeping tmpdir and hoping — a concurrent suite (H-8) has containers of
    // its own under the same directory.
    await expect(
      vcs().addWorktree(root, '0'.repeat(40), async (path) => {
        container = dirname(path);
      }),
    ).rejects.toThrow(InfraError);

    expect(container).not.toBeNull();
    // A suite that leaks temp directories is a suite nobody runs twice.
    expect(await exists(container as unknown as string)).toBe(false);
  });
});

describe('removeWorktree — the registration is what matters', () => {
  it('removes the checkout, the registration and the container', async () => {
    const { repo, root } = await repoWithRoot('wt-remove');
    const created = trackContainer(await vcs().addWorktree(root, repo.headSha, recordNothing));

    await vcs().removeWorktree(root, created);

    const entries = await vcs().listWorktrees(root);
    expect(entries.map((entry) => entry.path)).not.toContain(created.path);
    expect(await exists(created.path)).toBe(false);
    expect(await exists(created.container)).toBe(false);
  });

  it('leaves no administrative directory under .git/worktrees', async () => {
    const { repo, root } = await repoWithRoot('wt-admin');
    const created = trackContainer(await vcs().addWorktree(root, repo.headSha, recordNothing));
    const adminRoot = join(repo.path, '.git', 'worktrees');
    expect(await exists(adminRoot)).toBe(true);

    await vcs().removeWorktree(root, created);

    // The leak that actually matters: git keeps admin files here that survive
    // an `rm -rf` of the checkout, and a registration outliving its directory
    // makes the next `worktree add` at that path fail confusingly.
    const { readdir } = await import('node:fs/promises');
    const remaining = await readdir(adminRoot).catch(() => [] as string[]);
    expect(remaining).toHaveLength(0);
  });

  it('restores the repository to byte-identical worktree listing', async () => {
    const { repo, root } = await repoWithRoot('wt-roundtrip');
    const before = await git(repo.path, 'worktree', 'list', '--porcelain');

    const created = trackContainer(await vcs().addWorktree(root, repo.headSha, recordNothing));
    await vcs().removeWorktree(root, created);

    expect(await git(repo.path, 'worktree', 'list', '--porcelain')).toBe(before);
  });
});

describe('removeWorktreeAt — the path-only form clean (3.2) uses', () => {
  it('removes a worktree addressed by path alone', async () => {
    const { repo, root } = await repoWithRoot('wt-at-path');
    const created = trackContainer(await vcs().addWorktree(root, repo.headSha, recordNothing));

    await vcs().removeWorktreeAt(root, created.path);

    const entries = await vcs().listWorktrees(root);
    expect(entries.map((entry) => entry.path)).not.toContain(created.path);
  });

  it('is a NO-OP for a path that is not registered', async () => {
    const { repo, root } = await repoWithRoot('wt-at-absent');

    // `clean` replays manifests and hits already-reaped entries constantly. A
    // reaper that threw here would stop reaping the entries that are still
    // live — so this must not throw, even though `git worktree remove` on an
    // unregistered path exits 128.
    await expect(
      vcs().removeWorktreeAt(root, join(repo.scratch, 'never-was-a-worktree')),
    ).resolves.toBeUndefined();
  });

  it('is idempotent — removing twice is not an error', async () => {
    const { repo, root } = await repoWithRoot('wt-at-twice');
    const created = trackContainer(await vcs().addWorktree(root, repo.headSha, recordNothing));

    await vcs().removeWorktreeAt(root, created.path);
    await expect(vcs().removeWorktreeAt(root, created.path)).resolves.toBeUndefined();
  });

  it('does NOT delete a container it was not told about', async () => {
    const { repo, root } = await repoWithRoot('wt-at-container');
    const created = trackContainer(await vcs().addWorktree(root, repo.headSha, recordNothing));

    await vcs().removeWorktreeAt(root, created.path);

    // A path alone does not identify a container, and guessing at deleting a
    // temp directory nobody claimed is not something a reaper should do.
    expect(await exists(created.container)).toBe(true);
    await rm(created.container, { recursive: true, force: true });
  });
});

describe('removeWorktreeAtPath — the plain-string wrapper for clean (3.2)', () => {
  it('removes a worktree given only the repository path and the worktree path', async () => {
    const { repo, root } = await repoWithRoot('wt-wrapper');
    const created = trackContainer(await vcs().addWorktree(root, repo.headSha, recordNothing));

    // bob's shape: `clean` holds a project root and recorded paths, nothing
    // else, and must not have to resolve a root it might be refused.
    await removeWorktreeAtPath(repo.path, created.path);

    const entries = await vcs().listWorktrees(root);
    expect(entries.map((entry) => entry.path)).not.toContain(created.path);
    await rm(created.container, { recursive: true, force: true });
  });

  it('is a no-op for an unregistered path', async () => {
    const { repo } = await repoWithRoot('wt-wrapper-absent');

    await expect(
      removeWorktreeAtPath(repo.path, join(repo.scratch, 'nope')),
    ).resolves.toBeUndefined();
  });
});

describe('listWorktrees', () => {
  it('lists the main worktree first, then the ones we created', async () => {
    const { repo, root } = await repoWithRoot('wt-list');
    const created = trackContainer(await vcs().addWorktree(root, repo.headSha, recordNothing));

    const entries = await vcs().listWorktrees(root);

    expect(entries[0]?.path).toBe(repo.path);
    expect(entries.map((entry) => entry.path)).toContain(created.path);

    await vcs().removeWorktree(root, created);
  });

  it('reports a registration whose directory has been deleted as prunable', async () => {
    const { repo, root } = await repoWithRoot('wt-prunable');
    const created = trackContainer(await vcs().addWorktree(root, repo.headSha, recordNothing));

    // The failure mode `git worktree remove --force` exists to avoid: deleting
    // the checkout directly leaves the registration behind.
    await rm(created.path, { recursive: true, force: true });

    const entries = await vcs().listWorktrees(root);
    const orphan = entries.find((entry) => entry.path === created.path);
    expect(orphan).toBeDefined();
    expect(orphan?.prunable).toBe(true);

    // And the path-only remover still clears it, which is what `clean` needs.
    await vcs().removeWorktreeAt(root, created.path);
    const after = await vcs().listWorktrees(root);
    expect(after.map((entry) => entry.path)).not.toContain(created.path);
  });
});

describe('the worktree directory is a real checkout', () => {
  it('contains the tree at that revision', async () => {
    const { repo, root } = await repoWithRoot('wt-content');

    const atFirst = trackContainer(await vcs().addWorktree(root, repo.firstSha, recordNothing));
    // `second.txt` only exists in the second commit, so its absence proves the
    // checkout is at the revision asked for rather than at the repo's HEAD.
    expect(await exists(join(atFirst.path, 'first.txt'))).toBe(true);
    expect(await exists(join(atFirst.path, 'second.txt'))).toBe(false);

    await vcs().removeWorktree(root, atFirst);
  });

  it('is writable without touching the source repository', async () => {
    const { repo, root } = await repoWithRoot('wt-writable');
    const created = trackContainer(await vcs().addWorktree(root, repo.headSha, recordNothing));
    await mkdir(join(created.path, 'build'), { recursive: true });
    await writeFile(join(created.path, 'build', 'out.txt'), 'gate output\n', 'utf8');

    // Gates (3.4) write build output into the worktree; the source repository
    // must not notice. `--force` on removal is what copes with the dirt.
    expect((await git(repo.path, 'status', '--porcelain')).trim()).toBe('');

    await vcs().removeWorktree(root, created);
    const entries = await vcs().listWorktrees(root);
    expect(entries.map((entry) => entry.path)).not.toContain(created.path);
  });
});
