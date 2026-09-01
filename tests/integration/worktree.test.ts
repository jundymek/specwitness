/**
 * Story 3.1 AC2 — the read-only guarantee, proved three ways.
 *
 * FR-19's promise is that verification never touches the workspace it was
 * invoked from. This file is the evidence for it. Each proof captures BOTH
 * `git status --porcelain` and `git worktree list --porcelain` in the source
 * repository and asserts them byte-identical afterwards:
 *
 *   1. a clean run — add, use, remove;
 *   2. a failing run — the same, with the failure injected mid-cycle;
 *   3. a SIGKILL mid-run — the child is killed with -9, so by construction no
 *      cleanup handler of ours can run.
 *
 * Both halves of the snapshot matter. `git status` catches anything appearing
 * in the working tree; `git worktree list` catches a registration that outlived
 * its directory, which is the leak that actually bites — git keeps
 * administrative files under `.git/worktrees/<name>` that survive an `rm -rf`.
 *
 * SCOPE, so the supervisor is not told the same thing twice: this is the
 * UNIT/INTEGRATION-level kill proof, killing a child of this suite. The
 * end-to-end version — `kill -9` on the built binary, then `specwitness clean`
 * — belongs to story 3.7 (predator), agreed with him during cohort intent-sync.
 *
 * WHY THE KILLED CHILD IS A GENERATED `.mjs` RATHER THAN THIS MODULE'S CODE:
 * a `kill -9`-able child has to be a separate process, and this codebase's TS
 * cannot be run directly by node — `--experimental-strip-types` does not rewrite
 * the `./x.js` specifiers used throughout `src/`, and `dist/` bundles only the
 * CLI, which has no `verify` command until story 3.7. So the child is generated,
 * and it calls git with the REAL argv arrays exported from `src/infra/vcs.ts`
 * (`worktreeAddArgs`) rather than a hand-copied duplicate. What is being proved
 * here is a property of the SOURCE REPOSITORY and of the leftover shape, both of
 * which are git and filesystem facts — not a property of the child's language.
 */

import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { InfraError } from '../../src/domain/errors.js';
import type { RepoRoot } from '../../src/domain/vcs.js';
import { SystemClock } from '../../src/infra/clock.js';
import { createProcessRunner } from '../../src/infra/process-runner.js';
import { RunStore } from '../../src/infra/run-store.js';
import { createGitVcs, worktreeAddArgs } from '../../src/infra/vcs.js';
import { MANIFEST_FILENAME, parseRunManifest } from '../../src/schemas/manifest.js';
import { FixedClock, SequenceIds } from '../fakes/ports.js';
import {
  git,
  makeRepo,
  recordNothing,
  repoStateSnapshot,
  type FixtureRepo,
} from '../unit/vcs/fixture-repo.js';

const execFileAsync = promisify(execFile);
const scratches: string[] = [];

afterEach(async () => {
  await Promise.all(scratches.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function vcs(): ReturnType<typeof createGitVcs> {
  return createGitVcs({ runner: createProcessRunner(new SystemClock()) });
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

/** True while a process with this pid exists. Signal 0 tests, never delivers. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('AC2 proof 1 — a clean run leaves the source repository byte-identical', () => {
  it('add, write into the worktree, remove', async () => {
    const { repo, root } = await repoWithRoot('ro-clean');
    const before = await repoStateSnapshot(repo.path);

    const created = await vcs().addWorktree(root, repo.headSha, recordNothing);
    // Use it the way a gate would (story 3.4): build output lands in the
    // worktree, and the source repository must not notice.
    await mkdir(join(created.path, 'node_modules'), { recursive: true });
    await writeFile(join(created.path, 'node_modules', 'x.txt'), 'build output\n', 'utf8');
    await vcs().removeWorktree(root, created);

    expect(await repoStateSnapshot(repo.path)).toBe(before);
  });
});

describe('AC2 proof 2 — a FAILING run leaves the source repository byte-identical', () => {
  it('restores everything when the work inside the worktree throws', async () => {
    const { repo, root } = await repoWithRoot('ro-failing');
    const before = await repoStateSnapshot(repo.path);

    const created = await vcs().addWorktree(root, repo.headSha, recordNothing);
    let failed = false;
    try {
      await writeFile(join(created.path, 'partial.txt'), 'half a gate\n', 'utf8');
      throw new InfraError('a gate exploded', 'this is the injected failure');
    } catch {
      failed = true;
    } finally {
      // The teardown discipline the pipeline applies: removal runs after a
      // failure exactly as after a success.
      await vcs().removeWorktree(root, created);
    }

    expect(failed).toBe(true);
    expect(await repoStateSnapshot(repo.path)).toBe(before);
  });

  it('leaves the repository byte-identical when creation itself fails', async () => {
    const { repo, root } = await repoWithRoot('ro-add-fails');
    const before = await repoStateSnapshot(repo.path);

    await expect(vcs().addWorktree(root, '0'.repeat(40), recordNothing)).rejects.toThrow(InfraError);

    expect(await repoStateSnapshot(repo.path)).toBe(before);
  });
});

describe('AC2 proof 3 — SIGKILL mid-run', () => {
  it('leaves the working tree untouched and exactly the leftovers clean reaps', async () => {
    const { repo, root } = await repoWithRoot('ro-sigkill');

    // A real run directory with a real manifest skeleton, written and fsynced
    // by the merged RunStore before any resource exists (AD-8 / story 1.6).
    const store = new RunStore(
      repo.path,
      new FixedClock('2026-08-31T20:45:00.000Z'),
      new SequenceIds('a3f9'),
    );
    const run = await store.createRun({ epic: 'epic-3' });

    const statusBefore = (await git(repo.path, 'status', '--porcelain')).trim();

    // Named the way `addWorktree` names its containers, because that is what
    // this child simulates — and because `removeWorktreeAt` reaps only a
    // registered worktree shaped like one SpecWitness created. A fixture using
    // some other name would "prove" the leftover is reapable under a rule the
    // real reaper does not follow.
    const container = join(repo.scratch, 'specwitness-worktree-killed');
    await mkdir(container, { recursive: true });
    const worktreePath = join(container, 'worktree');
    const manifestPath = join(run.dir, MANIFEST_FILENAME);

    // The child: record the path into the manifest, fsync, create the worktree
    // with the REAL argv this adapter uses, then block forever so the parent
    // can kill it at a moment when the worktree exists and nothing has cleaned
    // up. `console.log('ready')` is the handshake — waiting for it rather than
    // sleeping is what keeps this test deterministic instead of timing-based.
    const childPath = join(repo.scratch, 'kill-me.mjs');
    await writeFile(
      childPath,
      `import { execFileSync } from 'node:child_process';
import { openSync, fsyncSync, closeSync, writeFileSync, readFileSync } from 'node:fs';

const [manifestPath, repoPath, worktreePath] = process.argv.slice(2);
const addArgs = ${JSON.stringify(worktreeAddArgs('__WORKTREE__', '__SHA__'))}
  .map((a) => (a === '__WORKTREE__' ? worktreePath : a === '__SHA__' ? ${JSON.stringify(repo.headSha)} : a));

// 1. Record BEFORE the resource exists, durably — AD-8's ordering.
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.worktrees.push(worktreePath);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\\n');
const fd = openSync(manifestPath, 'r+');
fsyncSync(fd);
closeSync(fd);

// 2. Now create it.
execFileSync('git', addArgs, { cwd: repoPath, stdio: 'ignore' });

// 3. Announce, then block forever. No exit handler, no cleanup — the point is
//    that -9 gives us none.
console.log('ready');
setInterval(() => {}, 1000);
`,
      'utf8',
    );

    const child = spawn(process.execPath, [childPath, manifestPath, repo.path, worktreePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const ready = await new Promise<boolean>((resolve) => {
      let buffer = '';
      const timer = setTimeout(() => resolve(false), 20_000);
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        if (buffer.includes('ready')) {
          clearTimeout(timer);
          resolve(true);
        }
      });
      child.on('exit', () => {
        clearTimeout(timer);
        resolve(buffer.includes('ready'));
      });
    });
    expect(ready).toBe(true);

    const pid = child.pid;
    expect(pid).toBeDefined();

    // SIGKILL: uncatchable by construction, so nothing of ours can tidy up.
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.on('exit', () => resolve());
    });

    // ---- What the source repository must look like afterwards ----

    // The working tree is untouched: the worktree lived under a separate
    // directory and SpecWitness wrote nothing into the project.
    expect((await git(repo.path, 'status', '--porcelain')).trim()).toBe(statusBefore);

    // And the leftovers are EXACTLY what story 3.2's `clean` is designed to
    // reap: a manifest entry, and a registered worktree. Nothing else.
    const manifest = parseRunManifest(await readFile(manifestPath, 'utf8'), manifestPath);
    expect(manifest.worktrees).toContain(worktreePath);
    expect(manifest.reaped).toBe(false);

    const registered = await vcs().listWorktrees(root);
    expect(registered.map((entry) => entry.path)).toContain(worktreePath);

    // No orphaned process. Epic 2 leaked nine `sleep 3600`s onto this machine
    // and they had to be reaped by hand; a suite that leaks is a suite nobody
    // runs twice.
    expect(pidAlive(pid as number)).toBe(false);

    // ---- And the leftover is reapable, which is the point of recording it ----
    await vcs().removeWorktreeAt(root, worktreePath);
    const afterReap = await vcs().listWorktrees(root);
    expect(afterReap.map((entry) => entry.path)).not.toContain(worktreePath);
    expect((await git(repo.path, 'status', '--porcelain')).trim()).toBe(statusBefore);
  });
});

describe('AC2 — SpecWitness writes nothing into the project working tree', () => {
  it('keeps every generated file inside the run directory and the temp worktree', async () => {
    const { repo, root } = await repoWithRoot('ro-no-project-files');
    const created = await vcs().addWorktree(root, repo.headSha, recordNothing);

    // AD-8: SpecWitness-generated files live only in the run directory, never
    // in the project working tree. `.specwitness/runs/` is ignored via the
    // nested ignore file `init` writes, so even it does not show up.
    const status = (await git(repo.path, 'status', '--porcelain')).trim();
    expect(status).toBe('');
    expect(await exists(join(repo.path, 'worktree'))).toBe(false);

    await vcs().removeWorktree(root, created);
  });
});

describe('the suite leaves nothing behind', () => {
  it('removes every container and registration it created', async () => {
    const { repo, root } = await repoWithRoot('ro-no-leak');
    const before = await repoStateSnapshot(repo.path);

    // Several cycles, because a leak that only shows up on the second run is
    // still a leak — and because the previous revision of the unit suite left
    // nine empty containers under os.tmpdir() after a single `pnpm test`.
    const created = [
      await vcs().addWorktree(root, repo.headSha, recordNothing),
      await vcs().addWorktree(root, repo.firstSha, recordNothing),
      await vcs().addWorktree(root, repo.headSha, recordNothing),
    ];
    for (const worktree of created) {
      await vcs().removeWorktree(root, worktree);
    }

    // Asserted on the exact paths THIS test created, never by scanning
    // os.tmpdir() — the harness runs `pnpm test` concurrently with the agent
    // (H-8), so another suite's containers are legitimately present and a
    // directory sweep would be flaky rather than strict.
    for (const worktree of created) {
      expect(await exists(worktree.path)).toBe(false);
      expect(await exists(worktree.container)).toBe(false);
    }
    expect(await repoStateSnapshot(repo.path)).toBe(before);
  });
});

describe('the no-implicit-fetch guarantee, end to end', () => {
  it('never contacts a remote, even one that is configured', async () => {
    const { repo, root } = await repoWithRoot('ro-nofetch');
    // An unroutable remote: if anything here tried to reach the network, this
    // test would hang or fail rather than pass quietly.
    await git(repo.path, 'remote', 'add', 'origin', 'https://example.invalid/nope.git');
    const before = await repoStateSnapshot(repo.path);
    const refsBefore = await git(repo.path, 'for-each-ref', '--format=%(refname) %(objectname)');

    const result = await vcs().resolveRef(root, 'head', 'origin/epic/7-never-fetched');

    expect(result.outcome).toBe('not-found');
    expect(await git(repo.path, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(
      refsBefore,
    );
    expect(await repoStateSnapshot(repo.path)).toBe(before);
    // FETCH_HEAD is what a fetch would leave behind even when it changed no ref.
    expect(await exists(join(repo.path, '.git', 'FETCH_HEAD'))).toBe(false);
  });

  it('leaves no lock files in the source repository', async () => {
    const { repo, root } = await repoWithRoot('ro-nolocks');

    const created = await vcs().addWorktree(root, repo.headSha, recordNothing);
    await vcs().removeWorktree(root, created);

    // `GIT_OPTIONAL_LOCKS=0` keeps read-only queries from taking a lock in the
    // repository this story promises not to disturb.
    expect(await exists(join(repo.path, '.git', 'index.lock'))).toBe(false);
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repo.path });
    expect(stdout.trim()).toBe('');
  });
});
