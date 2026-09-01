/**
 * The PRE-REGISTRATION WINDOW in `createWorktree` — Epic 3 retrospective §5,
 * debt 1, assigned to story 4.1 because that story owns resource lifecycle.
 *
 * ============================================================================
 * WHAT THE WINDOW IS
 * ============================================================================
 *
 * `addWorktree` calls `mkdtemp(join(tempRoot, CONTAINER_PREFIX))` before the
 * manifest-recording hook. A `kill -9` in between leaves one EMPTY temp
 * container with no git registration. predator measured it at roughly 1-in-3.
 *
 * The merged source and the retrospective DISAGREE about whether that matters.
 * The comment at the site argues it is benign — "it holds no resource, `clean`
 * correctly treats an unregistered path as a no-op, and the OS temp policy
 * removes it"; the retrospective's debt-1 entry frames the same window as
 * something `clean` "cannot reap".
 *
 * ============================================================================
 * WHAT REPRODUCTION FOUND — the resolution
 * ============================================================================
 *
 * **Both readings are right about the case they describe, and both miss the one
 * that actually bites.** The residual empty container really is inert (pinned by
 * the second test below). But the window is not only a crash window: `mkdtemp`
 * runs BEFORE the check that refuses to create a worktree inside the tree being
 * verified, so when `TMPDIR` resolves inside the repository, SpecWitness
 * CREATES A DIRECTORY INSIDE THE OPERATOR'S WORKING TREE and only then refuses.
 * That is the precise thing FR-19 forbids and the comment above the check claims
 * to prevent — and a `kill -9` in that window leaves the leftover not under
 * `/tmp` but in the operator's checkout, where it shows up in `git status` and
 * where no OS temp policy will ever reclaim it.
 *
 * It is also observable without any crash, which is what makes it testable: if
 * that in-repo `TMPDIR` is not writable, `mkdtemp` fails FIRST, and the operator
 * is told to "check free space and permissions on the OS temp directory" — a
 * remedy for a problem they do not have — instead of being told their `TMPDIR`
 * resolves inside the tree under verification, which is the actual fault and a
 * one-line fix. The first test below pins that, and it was RED before the check
 * was moved ahead of `mkdtemp`.
 *
 * The fix is deliberately narrow: the ordering changes, `mkdtemp` itself stays.
 * Replacing it with a hand-rolled random `mkdir` to close the final syscall of
 * the window would trade a documented, resource-free leftover for a predictable
 * temp-directory name, which is a security regression in the one place that must
 * not have one.
 */

import { chmod, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { InfraError } from '../../../src/domain/errors.js';
import { SystemClock } from '../../../src/infra/clock.js';
import { createProcessRunner } from '../../../src/infra/process-runner.js';
import { createGitVcs } from '../../../src/infra/vcs.js';
import type { RepoRoot } from '../../../src/domain/vcs.js';
import { makeRepo, recordNothing, type FixtureRepo } from './fixture-repo.js';

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const undo of cleanup.splice(0)) {
    await undo();
  }
});

const vcs = () => createGitVcs({ runner: createProcessRunner(new SystemClock()) });

async function repoWithRoot(label: string): Promise<{ repo: FixtureRepo; root: RepoRoot }> {
  const repo = await makeRepo(label);
  cleanup.push(() => rm(repo.scratch, { recursive: true, force: true }));
  const resolved = await vcs().resolveRoot({ explicitRoot: repo.path, cwd: repo.path });
  if (resolved.outcome !== 'resolved') {
    throw new Error(`fixture root did not resolve: ${resolved.outcome}`);
  }
  return { repo, root: resolved.root };
}

/** Runs `body` with `TMPDIR` set, restoring whatever was there before. */
async function withTmpdir(value: string, body: () => Promise<void>): Promise<void> {
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = value;
  try {
    await body();
  } finally {
    if (previous === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = previous;
    }
  }
}

describe('a TMPDIR inside the repository is refused BEFORE anything is created there', () => {
  it('names the real fault even when the in-repo TMPDIR cannot be written to', async () => {
    // THE RED TEST. Before the ordering fix this reported
    // "could not create the verification worktree container … check free space
    // and permissions", because `mkdtemp` ran before the containment check and
    // failed on the permissions. The operator was handed a remedy for a problem
    // they did not have, while the real fault — a TMPDIR resolving inside the
    // tree under verification — went unmentioned.
    //
    // The unwritable directory is what makes the ORDERING observable at all: it
    // forces `mkdtemp` to fail, so only an implementation that checks first can
    // still produce the right diagnosis.
    const { repo, root } = await repoWithRoot('wt-tmpdir-in-repo-unwritable');

    const inside = join(repo.path, 'tmp-inside-repo');
    await mkdir(inside, { recursive: true });
    await chmod(inside, 0o500); // r-x: readable, not writable
    cleanup.push(async () => {
      await chmod(inside, 0o700).catch(() => undefined);
      await rm(inside, { recursive: true, force: true });
    });

    await withTmpdir(inside, async () => {
      const attempt = vcs().addWorktree(root, repo.headSha, recordNothing);

      await expect(attempt).rejects.toThrow(InfraError);
      await attempt.catch((error: unknown) => {
        expect(error).toBeInstanceOf(InfraError);
        expect((error as InfraError).message).toMatch(/refusing to create a worktree inside/);
        expect((error as InfraError).hint).toMatch(/TMPDIR/);
      });
    });
  });

  it('creates NOTHING inside the working tree when TMPDIR resolves into it', async () => {
    // FR-19's promise, stated as an assertion about the operator's checkout
    // rather than about SpecWitness's intentions: after the refusal there is no
    // `specwitness-worktree-*` leftover in the repository — and, because the
    // check now precedes `mkdtemp`, there never was one even transiently, so a
    // `kill -9` during the refusal cannot leave one either.
    const { repo, root } = await repoWithRoot('wt-tmpdir-in-repo-writable');

    const inside = join(repo.path, 'tmp-inside-repo');
    await mkdir(inside, { recursive: true });
    cleanup.push(() => rm(inside, { recursive: true, force: true }));

    await withTmpdir(inside, async () => {
      await expect(vcs().addWorktree(root, repo.headSha, recordNothing)).rejects.toThrow(
        /refusing to create a worktree inside/,
      );
    });

    // Asserted on `specwitness-worktree-*` SPECIFICALLY rather than on the
    // directory being empty (Codex review, P2). `inside` is this test's TMPDIR
    // for the duration of the call, and macOS system tooling legitimately writes
    // bookkeeping files such as `xcrun_db` into whatever TMPDIR points at — so
    // an emptiness assertion is red on some machines and green on others while
    // saying nothing about SpecWitness either way. The claim being made is that
    // SpecWitness created no worktree container, and that is what is checked.
    const leftovers = (await readdir(inside)).filter((entry) =>
      entry.startsWith('specwitness-worktree-'),
    );
    expect(leftovers).toEqual([]);
  });
});

describe('the residual crash window: what a kill -9 between mkdtemp and the record leaves', () => {
  it('leaves an EMPTY, UNREGISTERED container that holds no resource', async () => {
    // The window made observable without killing anything: the recording hook is
    // called at exactly the instant a `kill -9` would freeze the filesystem, so
    // what the hook can see IS what such a crash leaves behind. A SIGKILL does
    // not roll back completed syscalls, so this is the real post-crash state and
    // not a model of it.
    //
    // This pins the merged comment's claim rather than the retrospective's
    // framing: the leftover is an empty directory. It holds no checkout, no git
    // registration and no process — so there is nothing for `clean` to reap, and
    // "cannot be reaped" describes a directory the OS temp policy removes on its
    // own schedule. Documented as closed-by-argument, with this test so the next
    // reader does not have to re-derive it from prose.
    const { repo, root } = await repoWithRoot('wt-window-state');

    let observed: { entries: string[]; isDirectory: boolean; path: string } | undefined;

    const created = await vcs().addWorktree(root, repo.headSha, async (worktreePath) => {
      // `worktreePath` is `<container>/worktree`; the container is its parent and
      // is the only thing that exists at this instant.
      const container = join(worktreePath, '..');
      observed = {
        entries: await readdir(container),
        isDirectory: (await stat(container)).isDirectory(),
        path: container,
      };
    });
    cleanup.push(async () => {
      await vcs()
        .removeWorktreeAt(root, created.path)
        .catch(() => undefined);
      await rm(created.container, { recursive: true, force: true });
    });

    expect(observed).toBeDefined();
    expect(observed?.isDirectory).toBe(true);
    // EMPTY: the checkout does not exist yet, because `git worktree add` runs
    // strictly after the record.
    expect(observed?.entries).toEqual([]);

    // And it is under the OS temp root, never inside the repository — which is
    // what makes "the OS temp policy reclaims it" true rather than hopeful.
    expect(observed?.path.startsWith(repo.path)).toBe(false);
  });

  it('removes the container when the recording hook itself fails', async () => {
    // The other half of the same ordering, already merged and pinned here so a
    // future edit to the window cannot quietly drop it: a rejected record must
    // not leave the container behind, because that path is reached on a real
    // durability failure rather than on a crash.
    const { repo, root } = await repoWithRoot('wt-record-rejects');

    let containerPath = '';
    const attempt = vcs().addWorktree(root, repo.headSha, async (worktreePath) => {
      containerPath = join(worktreePath, '..');
      throw new InfraError('the manifest could not be written', 'check the run directory');
    });

    await expect(attempt).rejects.toThrow(/manifest could not be written/);
    expect(containerPath).not.toBe('');
    await expect(stat(containerPath)).rejects.toThrow();
  });
});
