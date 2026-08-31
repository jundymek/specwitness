import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultCleanEffects, cleanRuns } from '../../src/cli/commands/clean.js';
import { SystemClock } from '../../src/infra/clock.js';
import { createProcessRunner } from '../../src/infra/process-runner.js';
import { RunStore } from '../../src/infra/run-store.js';
import { RandomIds } from '../../src/infra/ids.js';

/**
 * `specwitness clean` against REAL processes, a REAL `ps` and a REAL git
 * worktree — story 3.2, AC3.
 *
 * The unit tests in `tests/unit/cli/clean.test.ts` prove the decision matrix
 * with injected effects. This file proves the effects themselves: that the
 * `ps`-based identity probe actually recognises a group SpecWitness started,
 * that the group kill actually reaps a grandchild through the command, and that
 * a real `git worktree` really goes away. Those are the parts that can only be
 * wrong against a real operating system.
 *
 * Story 3.7 (predator) owns the equivalent proof through the BUILT BINARY after
 * a `kill -9` mid-`verify`; this is the unit-and-integration half. Said in both
 * PR bodies so the two are not mistaken for one test written twice.
 *
 * Everything happens in a per-test temp directory (H-8). Nothing here touches
 * this repository, its worktrees, or the network.
 */

const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

let projectRoot: string;
const tracked = new Set<number>();

function trackPid(pid: number): number {
  tracked.add(pid);
  return pid;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isAlive(pid);
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = (await readFile(path, 'utf8')).trim();
      if (text.length > 0) {
        return text;
      }
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${path}`);
}

function makeStore(): RunStore {
  return new RunStore(projectRoot, new SystemClock(), new RandomIds());
}

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'specwitness-clean-int-'));
  await mkdir(join(projectRoot, '.specwitness'), { recursive: true });
});

/**
 * No orphans, asserted rather than assumed — see the note in
 * `tests/integration/process-runner-groups.test.ts`. Anything still alive is
 * RECORDED first and only then force-killed, so the safety net cannot be what
 * makes the assertion pass.
 *
 * One pid is expected to survive its test and is killed there deliberately: the
 * "refuses to signal a live process group SpecWitness never recorded" case
 * proves that `clean` leaves an unverifiable group RUNNING, so that test tears
 * its own group down and this hook sees nothing.
 */
const leaked: number[] = [];

afterEach(async () => {
  for (const pid of tracked) {
    if (isAlive(pid)) {
      leaked.push(pid);
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // raced us to exit
      }
    }
  }
  tracked.clear();
  await rm(projectRoot, { recursive: true, force: true });
});

afterAll(() => {
  expect(leaked, `these pids survived the code that was supposed to reap them: ${leaked.join(', ')}`).toEqual([]);
});

describe('clean against real processes', () => {
  it('reaps a live process group AND its grandchild, recorded by a real run', async () => {
    // End to end through the mechanism the whole story is about: a run records
    // a pgid durably, SpecWitness "crashes" (we simply never tear down), and
    // `clean` replays the manifest and reaps the group.
    const store = makeStore();
    const { runId } = await store.createRun();

    const scripts = await mkdtemp(join(tmpdir(), 'specwitness-clean-fixture-'));
    const script = join(scripts, 'forks.sh');
    const pidFile = join(scripts, 'grandchild.pid');
    await writeFile(script, '#!/bin/sh\nsleep 3600 &\necho $! > "$1"\nwait\n', { mode: 0o755 });

    const runner = createProcessRunner(new SystemClock());
    let pgid = 0;

    // Deliberately NOT awaited: this stands in for a run that is still going
    // when the process dies.
    const pending = runner.run({
      binary: '/bin/sh',
      args: [script, pidFile],
      cwd: projectRoot,
      timeoutMs: 60_000,
      env: { inherit: true },
      onProcessGroup: async (value) => {
        pgid = trackPid(value);
        await store.recordProcessGroup(runId, value);
      },
    });

    try {
      const grandchild = trackPid(Number(await waitForFile(pidFile)));

      // The manifest is on disk and fsynced BEFORE anything is reaped — that is
      // the ordering that makes crash recovery possible at all.
      expect((await store.readManifest(runId)).processGroups).toEqual([pgid]);

      const report = await cleanRuns(
        makeStore(),
        { all: false },
        defaultCleanEffects(projectRoot, createProcessRunner(new SystemClock())),
      );

      expect(report.failures).toEqual([]);
      expect(report.runs[0]?.killed).toEqual([pgid]);
      expect(await waitForExit(grandchild)).toBe(true);
      expect((await store.readManifest(runId)).reaped).toBe(true);

      await pending;
    } finally {
      await rm(scripts, { recursive: true, force: true });
    }
  });

  it('signals nothing for a pgid whose process is long gone', async () => {
    // The dead-pgid arm with the REAL `ps` probe rather than a fake: a pgid that
    // has exited must produce zero signals, because whatever inherits that
    // number next belongs to somebody else.
    const store = makeStore();
    const { runId } = await store.createRun();

    const runner = createProcessRunner(new SystemClock());
    let pgid = 0;
    const finished = await runner.run({
      binary: process.execPath,
      args: ['-e', ''],
      cwd: projectRoot,
      timeoutMs: 30_000,
      env: { inherit: true },
      onProcessGroup: async (value) => {
        pgid = value;
        await store.recordProcessGroup(runId, value);
      },
    });

    expect(finished.outcome).toBe('completed');
    expect(await waitForExit(pgid)).toBe(true);

    const report = await cleanRuns(
      makeStore(),
      { all: false },
      defaultCleanEffects(projectRoot, createProcessRunner(new SystemClock())),
    );

    expect(report.failures).toEqual([]);
    expect(report.runs[0]?.killed).toEqual([]);
    expect(report.runs[0]?.alreadyGone).toEqual([pgid]);
    expect((await store.readManifest(runId)).reaped).toBe(true);
  });

  it('refuses to signal a live process group SpecWitness never recorded', async () => {
    // Pid reuse, with a real live process: the manifest names a pgid, the group
    // is genuinely alive, but there is no reaping evidence for it. It must be
    // reported and left running.
    const store = makeStore();
    const { runId } = await store.createRun();

    const runner = createProcessRunner(new SystemClock());
    let pgid = 0;
    const marker = join(projectRoot, 'ready');
    const pending = runner.run({
      binary: process.execPath,
      args: [
        '-e',
        'require("node:fs").writeFileSync(process.argv[1], "x"); setTimeout(() => {}, 30_000)',
        marker,
      ],
      cwd: projectRoot,
      timeoutMs: 60_000,
      env: { inherit: true },
      onProcessGroup: (value) => {
        pgid = trackPid(value);
      },
    });
    await waitForFile(marker);

    // Write the pgid into the manifest WITHOUT the evidence, which is exactly
    // what a crash between the two writes leaves behind.
    const manifestPath = join(store.runDir(runId), 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      processGroups: number[];
    };
    manifest.processGroups = [pgid];
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const report = await cleanRuns(
      makeStore(),
      { all: false },
      defaultCleanEffects(projectRoot, createProcessRunner(new SystemClock())),
    );

    expect(report.failures.join(' ')).toMatch(new RegExp(`${pgid}`));
    expect(report.failures.join(' ')).toMatch(/NOT signalled/);
    expect(isAlive(pgid)).toBe(true);
    expect((await store.readManifest(runId)).reaped).toBe(false);

    process.kill(-pgid, 'SIGKILL');
    await pending;
  });
});

describe('clean against a real git worktree', () => {
  it('removes a recorded worktree and leaves no registration behind', async () => {
    const repo = join(projectRoot, 'repo');
    await mkdir(repo, { recursive: true });
    const git = (args: string[]) =>
      execa('git', args, {
        cwd: repo,
        env: {
          GIT_AUTHOR_NAME: 'SpecWitness Test',
          GIT_AUTHOR_EMAIL: 'test@example.invalid',
          GIT_COMMITTER_NAME: 'SpecWitness Test',
          GIT_COMMITTER_EMAIL: 'test@example.invalid',
        },
        extendEnv: true,
      });

    await git(['init', '--quiet', '--initial-branch=main']);
    await writeFile(join(repo, 'file.txt'), 'content\n');
    await git(['add', 'file.txt']);
    await git(['commit', '--quiet', '-m', 'chore: seed']);
    const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();

    const worktree = join(projectRoot, 'wt');
    await git(['worktree', 'add', '--detach', '--quiet', worktree, head]);

    const store = new RunStore(repo, new SystemClock(), new RandomIds());
    await mkdir(join(repo, '.specwitness'), { recursive: true });
    const { runId } = await store.createRun();
    await store.recordWorktree(runId, worktree);

    const report = await cleanRuns(
      store,
      { all: false },
      defaultCleanEffects(repo, createProcessRunner(new SystemClock())),
    );

    expect(report.failures).toEqual([]);
    expect(report.runs[0]?.removedWorktrees).toEqual([worktree]);
    expect((await git(['worktree', 'list', '--porcelain'])).stdout).not.toContain(worktree);
    expect((await store.readManifest(runId)).reaped).toBe(true);
    // The worktree went; the run record and its manifest did not.
    expect(await store.listRuns()).toEqual([runId]);
  });

  it('treats an already-removed worktree as nothing to do', async () => {
    // Manifest replay hits this constantly — `clean` run twice, or a run that
    // tore itself down cleanly before crashing later.
    const store = makeStore();
    const { runId } = await store.createRun();
    await store.recordWorktree(runId, join(projectRoot, 'never-existed'));

    const report = await cleanRuns(
      store,
      { all: false },
      defaultCleanEffects(projectRoot, createProcessRunner(new SystemClock())),
    );

    expect(report.failures).toEqual([]);
    expect(report.runs[0]?.absentWorktrees).toEqual([join(projectRoot, 'never-existed')]);
  });
});

describe('specwitness clean, through the built binary', () => {
  const runCli = async (args: string[], cwd = projectRoot) =>
    execa(process.execPath, [CLI, ...args], { reject: false, cwd, input: '' });

  it('is prompt-free and exits 0 with nothing to reap', async () => {
    const result = await runCli(['clean']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/no runs/i);
  });

  it('is prompt-free with --all too', async () => {
    // `clean` is exactly the command an operator scripts, so a confirmation
    // prompt would hang it in CI. `input: ''` means stdin is closed: a command
    // that asked anything would fail here rather than wait.
    const result = await runCli(['clean', '--all']);

    expect(result.exitCode).toBe(0);
  });

  it('exits 3 with an ERROR/HINT pair when the project is not initialised', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'specwitness-clean-bare-'));
    try {
      const result = await runCli(['clean'], bare);

      expect(result.exitCode).toBe(3);
      expect(result.stderr).toMatch(/^ERROR: /m);
      expect(result.stderr).toMatch(/^HINT: /m);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  it('documents what --all means in its help', async () => {
    const result = await runCli(['clean', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--all');
    expect(result.stdout).toMatch(/already marked reaped/);
  });

  it('reports a corrupt manifest by path and exits 3, keeping the run directory', async () => {
    const store = makeStore();
    const { runId } = await store.createRun();
    const manifestPath = join(store.runDir(runId), 'manifest.json');
    await writeFile(manifestPath, '{ not json');

    const result = await runCli(['clean']);

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain(manifestPath);
    // Reaping resources never means deleting the record of them.
    expect(await readFile(manifestPath, 'utf8')).toBe('{ not json');
  });
});
