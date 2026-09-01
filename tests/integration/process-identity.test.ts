import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ProcessResult, ProcessRunOptions, ProcessRunner } from '../../src/domain/process-runner.js';
import { SystemClock } from '../../src/infra/clock.js';
import {
  ownerStartedBeforeRecord,
  probeProcessGroups,
  probeProcesses,
  startTimeMatchesRecord,
} from '../../src/infra/process-identity.js';
import { createProcessRunner, terminateProcessGroup } from '../../src/infra/process-runner.js';

/**
 * The identity probe, against REAL process groups and a SCRIPTED `ps`.
 *
 * Both halves matter and neither can prove the other. Real process groups are
 * what make `kill(-pgid, 0)` meaningful; a scripted `ps` is the only way to
 * exercise the outputs a real `ps` will not produce on demand — a truncated
 * listing, an unreadable `lstart`, a line in a format this build has never seen.
 *
 * The property under test is one-sided and is the whole point of the module:
 *
 *     `gone` may only ever be concluded from evidence of ABSENCE,
 *     never from absence of evidence.
 *
 * That distinction was a real defect, found in Codex review (P2): unparseable
 * `ps` rows were silently dropped, so a live group whose member had an
 * unreadable start time vanished from the snapshot, read as `gone`, and the run
 * was marked reaped while the processes kept running.
 */

let projectRoot: string;
const tracked = new Set<number>();
const leaked: number[] = [];

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
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

/** A `ProcessRunner` whose only job is to hand back a scripted `ps` listing. */
function scriptedPs(result: Partial<ProcessResult>): ProcessRunner {
  return {
    run: async (_options: ProcessRunOptions): Promise<ProcessResult> => ({
      outcome: 'completed',
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1,
      pgid: null,
      ...result,
    }),
  };
}

/** Starts a real, long-lived child in its own process group. Returns its pgid. */
async function liveGroup(): Promise<{ pgid: number; stop: () => Promise<void> }> {
  const marker = join(projectRoot, `ready-${Math.random().toString(36).slice(2, 8)}`);
  let pgid = 0;

  const pending = createProcessRunner(new SystemClock()).run({
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
      pgid = value;
      tracked.add(value);
    },
  });

  await waitForFile(marker);

  return {
    pgid,
    stop: async () => {
      await terminateProcessGroup(pgid, { graceMs: 50 });
      await pending;
    },
  };
}

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'specwitness-identity-'));
});

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
  expect(leaked, `these pids survived their own test: ${leaked.join(', ')}`).toEqual([]);
});

describe('absence is never inferred from silence', () => {
  it('reports UNKNOWN, not gone, when ps omits a group that is genuinely alive', async () => {
    // The Codex P2 defect in its purest form: `ps` says nothing about a group
    // that is demonstrably running. Reading that as `gone` marks the run reaped
    // and leaves the processes running forever.
    const group = await liveGroup();
    try {
      const probes = await probeProcessGroups(scriptedPs({ stdout: '' }), [group.pgid], projectRoot);

      expect(probes.get(group.pgid)?.state).toBe('unknown');
      expect(probes.get(group.pgid)?.detail).toMatch(/alive/i);
    } finally {
      await group.stop();
    }
  });

  it('reports UNKNOWN when a live member has an unreadable start time', async () => {
    const group = await liveGroup();
    try {
      const probes = await probeProcessGroups(
        scriptedPs({ stdout: `${group.pgid} ${group.pgid} not-a-date-at-all\n` }),
        [group.pgid],
        projectRoot,
      );

      const probe = probes.get(group.pgid);
      expect(probe?.state).toBe('unknown');
      expect(probe?.startedAt).toBeUndefined();
      expect(probe?.detail).toMatch(/start time/i);
    } finally {
      await group.stop();
    }
  });

  it('reports UNKNOWN for every group when ps itself could not run', async () => {
    const probes = await probeProcessGroups(
      scriptedPs({ outcome: 'not-found', exitCode: null }),
      [4242, 4243],
      projectRoot,
    );

    expect(probes.get(4242)?.state).toBe('unknown');
    expect(probes.get(4243)?.state).toBe('unknown');
    expect(probes.get(4242)?.detail).toMatch(/ps is not on PATH/);
  });

  it('reports UNKNOWN when ps timed out', async () => {
    const probes = await probeProcessGroups(
      scriptedPs({ outcome: 'timed-out', exitCode: null }),
      [4242],
      projectRoot,
    );

    expect(probes.get(4242)?.state).toBe('unknown');
    expect(probes.get(4242)?.detail).toMatch(/did not answer/);
  });
});

describe('a live group is described, and dated, from the ps snapshot', () => {
  it('reports live with the EARLIEST member start time', async () => {
    // Earliest rather than the leader's, so the common orphan shape — the
    // leader exits, the server it spawned does not — is still reapable.
    const group = await liveGroup();
    try {
      const listing = [
        `${group.pgid} ${group.pgid} Mon Aug 31 22:10:45 2026`,
        `999999 ${group.pgid} Mon Aug 31 22:11:30 2026`,
        `12345 777777 Mon Aug 31 09:00:00 2026`,
        '',
      ].join('\n');

      const probe = (await probeProcessGroups(scriptedPs({ stdout: listing }), [group.pgid], projectRoot)).get(
        group.pgid,
      );

      expect(probe?.state).toBe('live');
      expect(probe?.startedAt?.toISOString()).toBe(new Date('Mon Aug 31 22:10:45 2026').toISOString());
    } finally {
      await group.stop();
    }
  });

  it('flags the SpecWitness process group as its own', async () => {
    const group = await liveGroup();
    try {
      const listing = [
        `${group.pgid} ${group.pgid} Mon Aug 31 22:10:45 2026`,
        `${process.pid} ${group.pgid} Mon Aug 31 22:10:46 2026`,
        '',
      ].join('\n');

      const probe = (await probeProcessGroups(scriptedPs({ stdout: listing }), [group.pgid], projectRoot)).get(
        group.pgid,
      );

      expect(probe?.ownProcessGroup).toBe(true);
    } finally {
      await group.stop();
    }
  });
});

describe('gone is concluded only from evidence of absence', () => {
  it('reports GONE for a pgid whose process really has exited', async () => {
    const finished = await createProcessRunner(new SystemClock()).run({
      binary: process.execPath,
      args: ['-e', ''],
      cwd: projectRoot,
      timeoutMs: 30_000,
      env: { inherit: true },
    });
    const pgid = finished.pgid as number;

    // Even handed a `ps` listing that mentions nothing at all — the kill(0)
    // probe is what concludes absence, and it is the same question the eventual
    // signal would ask.
    const probes = await probeProcessGroups(scriptedPs({ stdout: '' }), [pgid], projectRoot);

    expect(probes.get(pgid)?.state).toBe('gone');
  });

  it('returns nothing at all when asked about nothing', async () => {
    const probes = await probeProcessGroups(scriptedPs({ stdout: '' }), [], projectRoot);

    expect(probes.size).toBe(0);
  });
});

describe('probeProcesses: an owner is never wrongly declared gone', () => {
  /**
   * `clean` refuses to touch a run whose owner is still alive. Every way of
   * getting that wrong ends with a verification being killed, so `gone` is
   * concluded ONLY from a definite absence — never from a row this build could
   * not read, and never from a listing that omitted a process `kill(pid, 0)`
   * says exists.
   */
  it('reports UNKNOWN when ps lists the owner but its start time is unreadable', async () => {
    // The row IS there — we are looking at proof the process exists — so
    // dropping it and answering `gone` would reap a live run.
    const probe = (
      await probeProcesses(
        scriptedPs({ stdout: `${process.pid} ${process.pid} not-a-date-at-all\n` }),
        [process.pid],
        projectRoot,
      )
    ).get(process.pid);

    expect(probe?.state).toBe('unknown');
    expect(probe?.startedAt).toBeUndefined();
    expect(probe?.detail).toMatch(/start time/i);
  });

  it('reports UNKNOWN when ps omits an owner that is genuinely alive', async () => {
    const probe = (await probeProcesses(scriptedPs({ stdout: '' }), [process.pid], projectRoot)).get(
      process.pid,
    );

    expect(probe?.state).toBe('unknown');
    expect(probe?.detail).toMatch(/alive/i);
  });

  it('reports UNKNOWN for every pid when ps itself could not run', async () => {
    const probes = await probeProcesses(
      scriptedPs({ outcome: 'not-found', exitCode: null }),
      [process.pid],
      projectRoot,
    );

    expect(probes.get(process.pid)?.state).toBe('unknown');
  });

  it('reports LIVE with the start time when ps describes the owner properly', async () => {
    const probe = (
      await probeProcesses(
        scriptedPs({ stdout: `${process.pid} ${process.pid} Mon Aug 31 22:10:45 2026\n` }),
        [process.pid],
        projectRoot,
      )
    ).get(process.pid);

    expect(probe?.state).toBe('live');
    expect(probe?.startedAt?.toISOString()).toBe(new Date('Mon Aug 31 22:10:45 2026').toISOString());
  });

  it('reports GONE only for a pid whose process really has exited', async () => {
    const finished = await createProcessRunner(new SystemClock()).run({
      binary: process.execPath,
      args: ['-e', ''],
      cwd: projectRoot,
      timeoutMs: 30_000,
      env: { inherit: true },
    });
    const deadPid = finished.pgid as number;

    const probe = (await probeProcesses(scriptedPs({ stdout: '' }), [deadPid], projectRoot)).get(
      deadPid,
    );

    expect(probe?.state).toBe('gone');
  });
});

describe('ownerStartedBeforeRecord', () => {
  const recorded = new Date('2026-08-31T22:10:45.000Z');

  it('accepts an owner that started before the run recorded it', () => {
    // Which every real owner did: a process cannot record a run it started
    // after.
    expect(ownerStartedBeforeRecord(new Date('2026-08-31T20:00:00.000Z'), recorded)).toBe(true);
    expect(ownerStartedBeforeRecord(recorded, recorded)).toBe(true);
  });

  it('accepts the truncated start time ps actually reports for a real owner', () => {
    // `ps lstart` reports whole seconds, so the value is TRUNCATED — earlier
    // than the truth, never later. A genuine owner that started at 22:10:45.900
    // and recorded the run at 22:10:45.000... is impossible; the realistic shape
    // is a start time truncated to a second at or before the record.
    expect(ownerStartedBeforeRecord(new Date('2026-08-31T22:10:45.000Z'), recorded)).toBe(true);
  });

  it('rejects a pid that started after the record — the reuse case', () => {
    // If the owner died, its pid can only have been reused by a process that
    // started after the death, which is after the record. So this is somebody
    // else and the run really is crashed.
    expect(ownerStartedBeforeRecord(new Date('2026-09-01T09:00:00.000Z'), recorded)).toBe(false);
  });

  it('rejects a pid reused within the SAME SECOND as the record', () => {
    // The first version allowed a second of forward slack, meaning to absorb
    // `lstart`'s granularity. Truncation only moves a start time EARLIER, so
    // the slack protected no real owner and instead let a same-second
    // replacement impersonate one. Because the guard errs toward "still
    // running", a long-lived impostor would make every future `clean` skip that
    // crashed run permanently — a leak with no end.
    expect(ownerStartedBeforeRecord(new Date('2026-08-31T22:10:45.001Z'), recorded)).toBe(false);
    expect(ownerStartedBeforeRecord(new Date('2026-08-31T22:10:45.999Z'), recorded)).toBe(false);
  });
});

describe('startTimeMatchesRecord', () => {
  const recorded = new Date('2026-08-31T22:10:45.000Z');

  it('accepts a start time within the window in either direction', () => {
    // The early half absorbs `lstart`'s one-second granularity and the moment
    // between spawning and recording; the late half absorbs a slow fsync.
    expect(startTimeMatchesRecord(new Date('2026-08-31T22:10:40.000Z'), recorded)).toBe(true);
    expect(startTimeMatchesRecord(new Date('2026-08-31T22:10:50.000Z'), recorded)).toBe(true);
    expect(startTimeMatchesRecord(recorded, recorded)).toBe(true);
  });

  it('rejects a start time outside it — the pid-reuse case', () => {
    // A pgid recorded last week whose current occupant started today. This is
    // the comparison standing between `clean` and somebody else's process tree.
    expect(startTimeMatchesRecord(new Date('2026-09-03T09:00:00.000Z'), recorded)).toBe(false);
    expect(startTimeMatchesRecord(new Date('2026-08-31T22:11:00.000Z'), recorded)).toBe(false);
  });
});
