import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { createProcessRunner, terminateProcessGroup } from '../../src/infra/process-runner.js';
import { FixedClock } from '../fakes/ports.js';

/**
 * AD-8's lifecycle half, against REAL forking children — story 3.2.
 *
 * This file exists because of a specific, documented, still-open defect rather
 * than for symmetry: story 2.3 fixed timeout DETECTION and deliberately left
 * REAPING to this story, and Epic 2's own forking-timeout test left nine
 * orphaned `sleep 3600` processes on the development machine, all reparented to
 * PID 1 and reaped by hand after somebody noticed.
 *
 * So the load-bearing test here — "a spawned shell's GRANDCHILD is gone after
 * teardown" — was written and watched FAIL against the merged runner before a
 * line of the implementation existed. A test that has never been red proves
 * nothing, and this is the one whose passing closes a real debt.
 *
 * SAFETY DISCIPLINE FOR THIS FILE, since it is the file most able to leak the
 * thing it is about:
 *
 *  - Every pid a test causes to exist is registered with `trackPid` and killed
 *    in `afterEach`, whatever the assertions did.
 *  - `tests/integration/no-orphans.test.ts` then asserts, suite-wide, that
 *    nothing survived. Asserted rather than assumed — that is the whole point.
 *  - Every scratch file lives in its own `mkdtemp` directory (H-8), so two
 *    concurrent runs of this suite cannot share a pid file.
 *
 * `sh` appears here as a fixed binary with a fixed argv, to produce a child
 * that forks. That is a test fixture, not a shell escape: AD-3 constrains
 * `src/**`, where there is no `shell` option, no command string and no `sh -c`.
 */

const NODE = process.execPath;
const execFileAsync = promisify(execFile);

const runner = () => createProcessRunner(new FixedClock('2026-08-31T00:00:00.000Z'));

const base = { cwd: process.cwd(), timeoutMs: 15_000, env: { inherit: true } as const };

/** Pids this file caused to exist, killed in `afterEach` no matter what. */
const tracked = new Set<number>();

function trackPid(pid: number): number {
  tracked.add(pid);
  return pid;
}

/** `kill(pid, 0)` is the portable liveness probe: it signals nothing. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Waits until `pid` is gone, up to `timeoutMs`. Returns whether it went.
 *
 * A bounded poll rather than a fixed sleep: a passing run finishes in a few
 * milliseconds, and a failing one still fails within a bounded time instead of
 * hanging the suite.
 */
async function waitForExit(pid: number, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isAlive(pid);
}

/** Waits for a file to appear and returns its trimmed contents. */
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

/** The process-group id of a live pid, via `ps`. Undefined once it is gone. */
async function pgidOf(pid: number): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)]);
    const value = Number(stdout.trim());
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A shell script that forks a long-lived grandchild and records its pid.
 *
 * `sleep 3600 &` + `wait` rather than `exec sleep`: the shell must stay alive
 * as the PARENT of a `sleep`, because a direct child is the case that already
 * worked. The grandchild is the case Epic 2 leaked nine of.
 */
async function forkingScript(dir: string): Promise<{ script: string; pidFile: string }> {
  const script = join(dir, 'forks.sh');
  const pidFile = join(dir, 'grandchild.pid');
  await writeFile(script, '#!/bin/sh\nsleep 3600 &\necho $! > "$1"\nwait\n', { mode: 0o755 });
  return { script, pidFile };
}

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'specwitness-groups-'));
}

/**
 * THE SUITE MUST LEAVE NO ORPHANS, and it is asserted rather than assumed.
 *
 * This is the story about not leaking processes; a leaking test suite here
 * would be self-refuting. Epic 2's forking-timeout test left nine `sleep 3600`
 * processes on the development machine, reparented to PID 1, reaped by hand
 * after somebody noticed — so `afterEach` first RECORDS anything still alive
 * and only then force-kills it. `afterAll` asserts the recording is empty. The
 * force-kill is a safety net for the machine, never the thing that makes the
 * assertion pass.
 *
 * Scoped to pids THIS FILE created rather than to a machine-wide `ps` sweep:
 * several agents run this suite concurrently on one machine, and a global
 * orphan count would fail on a peer's healthy children (H-8).
 */
const leaked: number[] = [];

afterEach(() => {
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
});

afterAll(() => {
  expect(leaked, `these pids survived the code that was supposed to reap them: ${leaked.join(', ')}`).toEqual([]);
});

describe('AC2 — teardown reaps the whole process group, grandchildren included', () => {
  it('kills a forking child GRANDCHILD when the timeout fires', async () => {
    // THE test of this story. Run against the merged (pre-3.2) runner it fails:
    // the direct shell is killed, the `sleep 3600` grandchild is reparented to
    // PID 1 and survives indefinitely. That is the documented Epic 2 debt.
    const dir = await scratch();
    try {
      const { script, pidFile } = await forkingScript(dir);

      const result = await runner().run({
        ...base,
        binary: '/bin/sh',
        args: [script, pidFile],
        timeoutMs: 500,
      });

      const grandchild = trackPid(Number(await waitForFile(pidFile)));
      expect(Number.isInteger(grandchild)).toBe(true);

      expect(result.outcome).toBe('timed-out');
      // Asserted BY PID, after teardown returned — not "no error was thrown".
      expect(await waitForExit(grandchild)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('kills the grandchild of an explicitly torn-down long-running child', async () => {
    // The Epic 4 shape: a service that is still healthy when the run ends.
    // Nothing times out here; teardown is called deliberately.
    const dir = await scratch();
    try {
      const { script, pidFile } = await forkingScript(dir);

      let pgid: number | undefined;
      const pending = runner().run({
        ...base,
        binary: '/bin/sh',
        args: [script, pidFile],
        timeoutMs: 20_000,
        onProcessGroup: (value) => {
          pgid = trackPid(value);
        },
      });

      const grandchild = trackPid(Number(await waitForFile(pidFile)));
      expect(pgid).toBeGreaterThan(0);

      await terminateProcessGroup(pgid as number, { graceMs: 100 });

      expect(await waitForExit(grandchild)).toBe(true);
      // `run` still settles and still classifies — it never hangs and never
      // rejects because somebody tore its group down underneath it.
      await expect(pending).resolves.toMatchObject({ exitCode: null });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('escalates SIGTERM to SIGKILL for a child that ignores SIGTERM', async () => {
    // The grace period is injectable precisely so this is milliseconds rather
    // than a real wait. A child that traps SIGTERM proves the escalation
    // happened rather than that the first signal happened to be enough.
    const dir = await scratch();
    try {
      const marker = join(dir, 'ready');
      const script = join(dir, 'ignores-term.sh');
      await writeFile(
        script,
        '#!/bin/sh\ntrap "" TERM\nsleep 3600 &\necho $! > "$1"\ntouch "$2"\nwait\n',
        { mode: 0o755 },
      );

      let pgid = 0;
      const pending = runner().run({
        ...base,
        binary: '/bin/sh',
        args: [script, join(dir, 'grandchild.pid'), marker],
        timeoutMs: 20_000,
        onProcessGroup: (value) => {
          pgid = trackPid(value);
        },
      });

      await waitForFile(marker).catch(() => undefined);
      const grandchild = trackPid(Number(await waitForFile(join(dir, 'grandchild.pid'))));

      const startedAt = Date.now();
      await terminateProcessGroup(pgid, { graceMs: 150 });
      const elapsed = Date.now() - startedAt;

      expect(await waitForExit(pgid)).toBe(true);
      expect(await waitForExit(grandchild)).toBe(true);
      // It waited out the grace period before escalating, and did not wait the
      // default (which would make this test take seconds).
      expect(elapsed).toBeGreaterThanOrEqual(140);
      expect(elapsed).toBeLessThan(2_000);

      await pending;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('AC1 — every child gets its OWN process group, and it is reported', () => {
  it('reports a pgid equal to the child pid and distinct from this process group', async () => {
    // `detached: true` makes the child a group leader, so its pgid IS its pid.
    // Distinctness from the parent's group is the property that makes
    // `kill(-pgid)` safe: signalling our own group would kill vitest.
    const dir = await scratch();
    try {
      const pidFile = join(dir, 'child.pid');
      const observed: number[] = [];

      const result = await runner().run({
        ...base,
        binary: NODE,
        args: [
          '-e',
          'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); process.stdout.write(String(process.pid))',
          pidFile,
        ],
        onProcessGroup: (pgid) => {
          observed.push(pgid);
        },
      });

      expect(result.outcome).toBe('completed');
      expect(result.pgid).toBe(Number(result.stdout));
      expect(observed).toEqual([result.pgid]);

      const ownPgid = await pgidOf(process.pid);
      expect(ownPgid).toBeGreaterThan(0);
      expect(result.pgid).not.toBe(ownPgid);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('puts the child in a group whose pgid the OS agrees with', async () => {
    // Not a tautology: it proves `detached` actually took effect rather than
    // that we echoed back a pid we already had.
    const dir = await scratch();
    try {
      const marker = join(dir, 'ready');
      let pgid = 0;

      const pending = runner().run({
        ...base,
        binary: NODE,
        args: [
          '-e',
          'require("node:fs").writeFileSync(process.argv[1], "x"); setTimeout(() => {}, 10_000)',
          marker,
        ],
        timeoutMs: 20_000,
        onProcessGroup: (value) => {
          pgid = trackPid(value);
        },
      });

      await waitForFile(marker);
      expect(await pgidOf(pgid)).toBe(pgid);

      await terminateProcessGroup(pgid, { graceMs: 50 });
      await pending;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports pgid null when the child never started', async () => {
    const result = await runner().run({
      ...base,
      binary: 'specwitness-no-such-binary-3f2a',
      args: ['--version'],
    });

    expect(result.outcome).toBe('not-found');
    expect(result.pgid).toBeNull();
  });

  it('never signals this process group, even when asked to', async () => {
    // The nightmare case, made unreachable rather than merely unlikely: a bug
    // that computed a pgid of 0 (or of our own group) would kill the test
    // runner, and a test suite cannot report its own death.
    const ownPgid = (await pgidOf(process.pid)) as number;

    // Node has no `getpgid`, so under a test runner SpecWitness is usually NOT
    // its own group leader and `pgid === process.pid` misses this entirely.
    // Written first against a guard that checked only pid/ppid, this test KILLED
    // the whole vitest run rather than failing — which is the most direct
    // possible demonstration of why the guard reads the real pgid.
    await expect(terminateProcessGroup(ownPgid, { graceMs: 10 })).rejects.toThrow(
      /refusing to signal process group .*SpecWitness process group/i,
    );
    // 0 means "this process group" to kill(2); -1 means every process the user
    // may signal. Both must be structurally unreachable.
    await expect(terminateProcessGroup(0, { graceMs: 10 })).rejects.toThrow(/refusing to signal/i);
    await expect(terminateProcessGroup(1, { graceMs: 10 })).rejects.toThrow(/refusing to signal/i);
    await expect(terminateProcessGroup(-5, { graceMs: 10 })).rejects.toThrow(/refusing to signal/i);
    await expect(terminateProcessGroup(2.5, { graceMs: 10 })).rejects.toThrow(/refusing to signal/i);

    expect(isAlive(process.pid)).toBe(true);
  });

  it('is a no-op for a process group that is already gone', async () => {
    // `clean` replays manifests, so "already dead" is the common case, not the
    // exception. It must not raise.
    const result = await runner().run({ ...base, binary: NODE, args: ['-e', ''] });
    const pgid = result.pgid as number;

    expect(await waitForExit(pgid)).toBe(true);
    await expect(terminateProcessGroup(pgid, { graceMs: 10 })).resolves.toBeUndefined();
  });
});

describe('AC1 — the pgid reaches the caller BEFORE the child is awaited', () => {
  it('awaits onProcessGroup before the run resolves', async () => {
    const order: string[] = [];

    const result = await runner().run({
      ...base,
      binary: NODE,
      args: ['-e', 'process.stdout.write("done")'],
      onProcessGroup: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push('recorded');
      },
    });

    order.push('resolved');
    expect(result.outcome).toBe('completed');
    // The durability ordering AC1 is actually about: the record is made before
    // anything downstream can observe the run.
    expect(order).toEqual(['recorded', 'resolved']);
  });

  it('kills the group and propagates when the pgid cannot be recorded', async () => {
    // If the manifest write fails, the child must not be left running: a live
    // process group nothing can find is precisely the state `clean` cannot fix.
    const dir = await scratch();
    try {
      const { script, pidFile } = await forkingScript(dir);
      let pgid = 0;
      let grandchild = 0;

      const failure = runner().run({
        ...base,
        binary: '/bin/sh',
        args: [script, pidFile],
        timeoutMs: 20_000,
        onProcessGroup: async (value) => {
          pgid = trackPid(value);
          // Let the child actually fork before failing, so this proves the
          // GRANDCHILD is reaped rather than that the shell died before it
          // managed to create one.
          grandchild = trackPid(Number(await waitForFile(pidFile)));
          throw new Error('durability failure');
        },
      });

      await expect(failure).rejects.toThrow(/durability failure/);

      expect(grandchild).toBeGreaterThan(0);
      expect(await waitForExit(pgid)).toBe(true);
      expect(await waitForExit(grandchild)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('AC4 / regression — classification is unchanged by the lifecycle work', () => {
  it('still classifies a hanging single-process child as timed-out', async () => {
    const result = await runner().run({
      ...base,
      binary: NODE,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 300,
    });

    expect(result.outcome).toBe('timed-out');
    expect(result.exitCode).toBeNull();
  });

  it('still classifies a missing binary as not-found', async () => {
    const result = await runner().run({
      ...base,
      binary: 'specwitness-no-such-binary-3f2a',
      args: ['--version'],
    });

    expect(result.outcome).toBe('not-found');
  });

  it('still classifies an invalid cwd as spawn-failed, not not-found', async () => {
    // The Epic 2 bug, kept as a regression: execa reports BOTH as ENOENT, and a
    // classifier that trusts ENOENT alone tells an operator to install a CLI
    // they already have.
    const result = await runner().run({
      ...base,
      binary: NODE,
      args: ['-e', ''],
      cwd: '/definitely/not/a/directory/specwitness-3f2a',
    });

    expect(result.outcome).toBe('spawn-failed');
  });

  it('still captures stdout and stderr from a grouped child', async () => {
    // Detaching a child changes how its stdio is wired. If capture regressed,
    // every gate in Epic 3 would report empty evidence.
    const result = await runner().run({
      ...base,
      binary: NODE,
      args: ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(2)'],
    });

    expect(result).toMatchObject({ outcome: 'completed', exitCode: 2, stdout: 'out', stderr: 'err' });
  });

  it('still writes stdin to a grouped child', async () => {
    const result = await runner().run({
      ...base,
      binary: NODE,
      args: [
        '-e',
        'let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>process.stdout.write(d))',
      ],
      input: 'a long prompt',
    });

    expect(result.stdout).toBe('a long prompt');
  });
});
