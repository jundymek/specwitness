import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cleanRuns, renderCleanReport, type CleanEffects } from '../../../src/cli/commands/clean.js';
import { InfraError } from '../../../src/domain/errors.js';
import { RunStore } from '../../../src/infra/run-store.js';
import { MANIFEST_FILENAME } from '../../../src/schemas/manifest.js';
import { FixedClock, SequenceIds } from '../../fakes/ports.js';

/**
 * `specwitness clean` — the AC3 liveness matrix, and the Q51 keep-all proof.
 *
 * Every case here exists because getting it wrong has a specific, named
 * consequence:
 *
 *  - a LIVE verified pgid must be killed, or a crashed run leaks services;
 *  - a DEAD pgid must be signalled with NOTHING, because a pgid recorded last
 *    week may be the operator's editor today, and killing the wrong process
 *    tree is the worst outcome available in this story;
 *  - an UNVERIFIABLE live pgid must be reported and NOT signalled — leaking is
 *    visible and recoverable, a wrongly-killed tree is neither;
 *  - a CORRUPT manifest must be named and must NOT be silently skipped, because
 *    the run it describes may still own live resources;
 *  - and after every path, run directories, `result.json` and evidence must all
 *    still be there. `clean` reaps resources, never results (Q51). Deleting them
 *    would destroy the dogfooding data Epic 7 exists to collect.
 *
 * The effects are injected so the matrix is exercised without spawning
 * anything: the real `ps` probe and the real group kill have their own
 * integration coverage in `tests/integration/process-runner-groups.test.ts`.
 */

const CLOCK = '2026-08-31T14:25:01.123Z';

let root: string;

function makeStore(): RunStore {
  return new RunStore(root, new FixedClock(CLOCK), new SequenceIds('a3f9', 'b4c1', 'c5d2'));
}

interface Recorder {
  readonly signalled: number[];
  readonly removed: string[];
}

function effects(
  recorder: Recorder,
  overrides: Partial<CleanEffects> = {},
): CleanEffects {
  return {
    probeProcessGroups: async () => new Map(),
    // Default: no owner is alive, i.e. every run under test is a CRASHED run.
    // Tests that mean "still running" say so explicitly, so the dangerous case
    // is never the accidental default.
    probeProcesses: async (pids) =>
      new Map(pids.map((pid) => [pid, { pid, state: 'gone' as const }])),
    terminateProcessGroup: async (pgid) => {
      recorder.signalled.push(pgid);
    },
    removeWorktree: async (path) => {
      recorder.removed.push(path);
    },
    ...overrides,
  };
}

function recorder(): Recorder {
  return { signalled: [], removed: [] };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'specwitness-clean-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('clean: process groups', () => {
  it('kills a live pgid whose identity it can verify, and marks the run reaped', async () => {
    const store = makeStore();
    const { runId } = await store.createRun();
    await store.recordProcessGroup(runId, 4242);
    const rec = recorder();

    const report = await cleanRuns(
      store,
      { all: false },
      effects(rec, {
        probeProcessGroups: async () =>
          new Map([[4242, { pgid: 4242, state: 'live' as const, startedAt: new Date(CLOCK) }]]),
      }),
    );

    expect(rec.signalled).toEqual([4242]);
    expect(report.failures).toEqual([]);
    expect((await store.readManifest(runId)).reaped).toBe(true);
  });

  it('signals NOTHING for a pgid that is already gone, and still marks it reaped', async () => {
    const store = makeStore();
    const { runId } = await store.createRun();
    await store.recordProcessGroup(runId, 4242);
    const rec = recorder();

    const report = await cleanRuns(
      store,
      { all: false },
      effects(rec, {
        probeProcessGroups: async () => new Map([[4242, { pgid: 4242, state: 'gone' as const }]]),
      }),
    );

    // The load-bearing assertion of this whole story: nothing was signalled.
    expect(rec.signalled).toEqual([]);
    expect(report.failures).toEqual([]);
    expect((await store.readManifest(runId)).reaped).toBe(true);
  });

  it('refuses to signal a live pgid whose start time does not match what was recorded', async () => {
    // Pid reuse, made concrete: the group is alive, but it started three days
    // after we recorded this pgid, so it is somebody else's.
    const store = makeStore();
    const { runId } = await store.createRun();
    await store.recordProcessGroup(runId, 4242);
    const rec = recorder();

    const report = await cleanRuns(
      store,
      { all: false },
      effects(rec, {
        probeProcessGroups: async () =>
          new Map([
            [4242, { pgid: 4242, state: 'live' as const, startedAt: new Date('2026-09-03T09:00:00.000Z') }],
          ]),
      }),
    );

    expect(rec.signalled).toEqual([]);
    expect(report.failures.join(' ')).toMatch(/4242/);
    // NOT reaped: the resource is still out there, and a later `clean` must retry.
    expect((await store.readManifest(runId)).reaped).toBe(false);
  });

  it('refuses to signal a live pgid it has no recorded evidence for', async () => {
    // A manifest can carry a pgid whose evidence never made it to disk (a crash
    // between the two writes). Fail closed: report it, do not guess.
    const store = makeStore();
    const { runId } = await store.createRun();
    const dir = store.runDir(runId);
    const manifest = JSON.parse(await readFile(join(dir, MANIFEST_FILENAME), 'utf8')) as {
      processGroups: number[];
    };
    manifest.processGroups = [9999];
    await writeFile(join(dir, MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`);
    const rec = recorder();

    const report = await cleanRuns(
      store,
      { all: false },
      effects(rec, {
        probeProcessGroups: async () =>
          new Map([[9999, { pgid: 9999, state: 'live' as const, startedAt: new Date(CLOCK) }]]),
      }),
    );

    expect(rec.signalled).toEqual([]);
    expect(report.failures.join(' ')).toMatch(/9999/);
  });

  it('refuses to signal a process group it cannot probe at all', async () => {
    const store = makeStore();
    const { runId } = await store.createRun();
    await store.recordProcessGroup(runId, 4242);
    const rec = recorder();

    const report = await cleanRuns(
      store,
      { all: false },
      effects(rec, {
        probeProcessGroups: async () =>
          new Map([[4242, { pgid: 4242, state: 'unknown' as const, detail: 'ps is not on PATH' }]]),
      }),
    );

    expect(rec.signalled).toEqual([]);
    expect(report.failures.join(' ')).toMatch(/ps is not on PATH/);
  });

  it('refuses to signal the SpecWitness process group itself', async () => {
    const store = makeStore();
    const { runId } = await store.createRun();
    await store.recordProcessGroup(runId, 4242);
    const rec = recorder();

    const report = await cleanRuns(
      store,
      { all: false },
      effects(rec, {
        probeProcessGroups: async () =>
          new Map([
            [
              4242,
              {
                pgid: 4242,
                state: 'live' as const,
                startedAt: new Date(CLOCK),
                ownProcessGroup: true,
              },
            ],
          ]),
      }),
    );

    expect(rec.signalled).toEqual([]);
    expect(report.failures.join(' ')).toMatch(/own process group/i);
  });
});

describe('clean: worktrees', () => {
  it('removes a recorded worktree', async () => {
    const store = makeStore();
    const { runId } = await store.createRun();
    await store.recordWorktree(runId, '/tmp/specwitness-x/worktree');
    const rec = recorder();

    await cleanRuns(store, { all: false }, effects(rec));

    expect(rec.removed).toEqual(['/tmp/specwitness-x/worktree']);
  });

  it('asks the removal effect even when the DIRECTORY is already gone', async () => {
    // A missing directory does not mean a missing git REGISTRATION — that is
    // precisely what `git worktree prune` exists for. An earlier version
    // short-circuited on an `existsSync` check, so a deleted directory whose
    // registration survived was reported as reaped while the stale
    // registration stayed behind forever. Only the removal effect can see the
    // registration, so only it may decide there is nothing to do.
    const store = makeStore();
    const { runId } = await store.createRun();
    await store.recordWorktree(runId, '/tmp/specwitness-x/definitely-not-on-disk');
    const rec = recorder();

    const report = await cleanRuns(store, { all: false }, effects(rec));

    expect(rec.removed).toEqual(['/tmp/specwitness-x/definitely-not-on-disk']);
    expect(report.failures).toEqual([]);
    expect((await store.readManifest(runId)).reaped).toBe(true);
  });

  it('reports a worktree it could not remove, and does not mark the run reaped', async () => {
    const store = makeStore();
    const { runId } = await store.createRun();
    await store.recordWorktree(runId, '/tmp/specwitness-x/worktree');
    const rec = recorder();

    const report = await cleanRuns(
      store,
      { all: false },
      effects(rec, {
        removeWorktree: async () => {
          throw new InfraError('worktree removal left a registration behind', 'run git worktree prune');
        },
      }),
    );

    expect(report.failures.join(' ')).toMatch(/registration behind/);
    expect((await store.readManifest(runId)).reaped).toBe(false);
  });
});

describe('clean: which runs are visited', () => {
  it('skips an already-reaped run without --all', async () => {
    const store = makeStore();
    const { runId } = await store.createRun();
    await store.recordProcessGroup(runId, 4242);
    await store.markReaped(runId);
    const rec = recorder();

    const report = await cleanRuns(
      store,
      { all: false },
      effects(rec, {
        probeProcessGroups: async () => {
          throw new Error('must not probe an already-reaped run');
        },
      }),
    );

    expect(rec.signalled).toEqual([]);
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0]?.skipped).toBe('already-reaped');
  });

  it('re-verifies an already-reaped run WITH --all', async () => {
    // The documented reading: bare `clean` = this project's unreaped runs;
    // `--all` = every run, including reaped ones, re-verified and reported.
    const store = makeStore();
    const { runId } = await store.createRun();
    await store.recordProcessGroup(runId, 4242);
    await store.markReaped(runId);
    const rec = recorder();

    const report = await cleanRuns(
      store,
      { all: true },
      effects(rec, {
        probeProcessGroups: async () =>
          new Map([[4242, { pgid: 4242, state: 'live' as const, startedAt: new Date(CLOCK) }]]),
      }),
    );

    expect(rec.signalled).toEqual([4242]);
    expect(report.runs[0]?.skipped).toBeUndefined();
  });

  it('reports an empty run store without failing', async () => {
    const store = makeStore();
    const report = await cleanRuns(store, { all: false }, effects(recorder()));

    expect(report.runs).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(renderCleanReport(report)).toMatch(/no runs/i);
  });

  it('visits every run, not just the first', async () => {
    const store = makeStore();
    const a = await store.createRun();
    const b = await store.createRun();
    await store.recordProcessGroup(a.runId, 11);
    await store.recordProcessGroup(b.runId, 22);
    const rec = recorder();

    await cleanRuns(
      store,
      { all: false },
      effects(rec, {
        probeProcessGroups: async (pgids) =>
          new Map(pgids.map((p) => [p, { pgid: p, state: 'live' as const, startedAt: new Date(CLOCK) }])),
      }),
    );

    expect([...rec.signalled].sort()).toEqual([11, 22]);
  });
});

describe('clean: a run that is still running is left completely alone', () => {
  /**
   * A manifest cannot say whether its run has finished, and an ACTIVE run's
   * process groups pass every liveness and identity check `clean` makes — they
   * genuinely are groups SpecWitness recorded moments ago. So without this
   * guard, `clean` in one terminal SIGTERMs a `verify` in another, then marks
   * the run reaped; the still-running verify appends more resources to a reaped
   * manifest that later `clean` runs skip, and they leak permanently. The
   * command whose job is to prevent leaks would be creating one.
   */
  const liveOwner = (pid: number, startedAt: string) => ({
    probeProcesses: async () =>
      new Map([[pid, { pid, state: 'live' as const, startedAt: new Date(startedAt) }]]),
  });

  it('does not signal the process groups of a running verification', async () => {
    const store = makeStore();
    const { runId } = await store.createRun();
    await store.recordProcessGroup(runId, 4242);
    const owner = await store.readOwner(runId);
    const rec = recorder();

    const report = await cleanRuns(
      store,
      { all: false },
      effects(rec, {
        ...liveOwner(owner?.pid as number, '2026-08-31T14:00:00.000Z'),
        probeProcessGroups: async () => {
          throw new Error('must not probe the groups of a run that is still going');
        },
      }),
    );

    expect(rec.signalled).toEqual([]);
    expect(report.runs[0]?.skipped).toBe('active');
    // Skipped, not FAILED: leaving a running verification alone is correct
    // behaviour, so it must not colour the exit code.
    expect(report.failures).toEqual([]);
    expect((await store.readManifest(runId)).reaped).toBe(false);
  });

  it('does not remove the worktree of a running verification', async () => {
    const store = makeStore();
    const { runId } = await store.createRun();
    await store.recordWorktree(runId, '/tmp/specwitness-x/worktree');
    const owner = await store.readOwner(runId);
    const rec = recorder();

    await cleanRuns(
      store,
      { all: false },
      effects(rec, liveOwner(owner?.pid as number, '2026-08-31T14:00:00.000Z')),
    );

    expect(rec.removed).toEqual([]);
  });

  it('is NOT overridden by --all', async () => {
    // `--all` means "re-verify reaped runs", not "kill things that are still
    // working". Getting that wrong would make the safer-looking flag the
    // dangerous one.
    const store = makeStore();
    const { runId } = await store.createRun();
    await store.recordProcessGroup(runId, 4242);
    const owner = await store.readOwner(runId);
    const rec = recorder();

    const report = await cleanRuns(
      store,
      { all: true },
      effects(rec, liveOwner(owner?.pid as number, '2026-08-31T14:00:00.000Z')),
    );

    expect(rec.signalled).toEqual([]);
    expect(report.runs[0]?.skipped).toBe('active');
  });

  it('DOES reap when the owner pid is alive but started after the record — pid reuse', async () => {
    // The other direction of the same check. A run's owner must have STARTED
    // BEFORE the run recorded it; if the owner died, its pid can only have been
    // reused by a process that started after that death, which is after the
    // record. So a "live" owner that started later is somebody else, and the
    // run really is crashed.
    const store = makeStore();
    const { runId } = await store.createRun();
    await store.recordProcessGroup(runId, 4242);
    const owner = await store.readOwner(runId);
    const rec = recorder();

    const report = await cleanRuns(
      store,
      { all: false },
      effects(rec, {
        ...liveOwner(owner?.pid as number, '2026-09-05T10:00:00.000Z'),
        probeProcessGroups: async () =>
          new Map([[4242, { pgid: 4242, state: 'live' as const, startedAt: new Date(CLOCK) }]]),
      }),
    );

    expect(rec.signalled).toEqual([4242]);
    expect(report.runs[0]?.skipped).toBeUndefined();
  });

  it('leaves the run alone when the owner cannot be probed at all', async () => {
    // Fail closed in the direction that costs a visible leak rather than a
    // killed verification.
    const store = makeStore();
    const { runId } = await store.createRun();
    await store.recordProcessGroup(runId, 4242);
    const owner = await store.readOwner(runId);
    const rec = recorder();

    const report = await cleanRuns(
      store,
      { all: false },
      effects(rec, {
        probeProcesses: async () =>
          new Map([
            [
              owner?.pid as number,
              { pid: owner?.pid as number, state: 'unknown' as const, detail: 'ps unavailable' },
            ],
          ]),
      }),
    );

    expect(rec.signalled).toEqual([]);
    expect(report.runs[0]?.skipped).toBe('active');
  });

  it('leaves the run alone when the probe does not mention the owner at all', async () => {
    // Fails OPEN if the condition is written as "alive when the probe says so"
    // rather than "reapable only when the probe proves otherwise": a missing
    // entry is not evidence of anything, and treating it as evidence of death
    // is how an active run gets reaped.
    const store = makeStore();
    const { runId } = await store.createRun();
    await store.recordProcessGroup(runId, 4242);
    const rec = recorder();

    const report = await cleanRuns(
      store,
      { all: false },
      effects(rec, { probeProcesses: async () => new Map() }),
    );

    expect(rec.signalled).toEqual([]);
    expect(report.runs[0]?.skipped).toBe('active');
    expect((await store.readManifest(runId)).reaped).toBe(false);
  });

  it('leaves the run alone when the owner is live but its start time is unreadable', async () => {
    // The other missing-evidence shape. Without a start time the pid-reuse
    // question cannot be answered, so the run may still be going.
    const store = makeStore();
    const { runId } = await store.createRun();
    await store.recordProcessGroup(runId, 4242);
    const owner = await store.readOwner(runId);
    const rec = recorder();

    const report = await cleanRuns(
      store,
      { all: false },
      effects(rec, {
        probeProcesses: async () =>
          new Map([[owner?.pid as number, { pid: owner?.pid as number, state: 'live' as const }]]),
      }),
    );

    expect(rec.signalled).toEqual([]);
    expect(report.runs[0]?.skipped).toBe('active');
  });

  it('reaps normally when the run has no owner record at all', async () => {
    // Run directories created before this build carry no owner record, and they
    // must not be unreapable forever. Simulated by removing the record a
    // current `createRun` now writes.
    const store = makeStore();
    const { runId } = await store.createRun();
    await rm(join(store.runDir(runId), 'owner.json'));
    const rec = recorder();

    const report = await cleanRuns(store, { all: false }, effects(rec));

    expect(report.runs[0]?.skipped).toBeUndefined();
    expect((await store.readManifest(runId)).reaped).toBe(true);
  });

  it('protects a run from the moment it is created, before it owns anything', async () => {
    // The window the owner record used to leave open: a run that has been
    // created but has not yet acquired its first resource is still ACTIVE, and
    // reaping it would let the verifier append that first resource to a
    // manifest already marked reaped — invisible to every ordinary `clean`
    // afterwards.
    const store = makeStore();
    const { runId } = await store.createRun();
    const owner = await store.readOwner(runId);
    const rec = recorder();

    const report = await cleanRuns(
      store,
      { all: false },
      effects(rec, {
        probeProcesses: async () =>
          new Map([
            [
              owner?.pid as number,
              {
                pid: owner?.pid as number,
                state: 'live' as const,
                startedAt: new Date('2026-08-31T14:00:00.000Z'),
              },
            ],
          ]),
      }),
    );

    expect(report.runs[0]?.skipped).toBe('active');
    expect((await store.readManifest(runId)).reaped).toBe(false);
  });
});

describe('clean: a corrupt manifest is named, never silently skipped', () => {
  it('reports the path and keeps going with the other runs', async () => {
    // The run a corrupt manifest describes may still own a live process group,
    // so swallowing it would leak silently — and `clean` refusing to look at any
    // other run because of one bad file would be worse still.
    const store = makeStore();
    const broken = await store.createRun();
    const healthy = await store.createRun();
    await store.recordProcessGroup(healthy.runId, 4242);
    const brokenPath = join(store.runDir(broken.runId), MANIFEST_FILENAME);
    await writeFile(brokenPath, '{ not json');
    const rec = recorder();

    const report = await cleanRuns(
      store,
      { all: false },
      effects(rec, {
        probeProcessGroups: async (pgids) =>
          new Map(pgids.map((p) => [p, { pgid: p, state: 'live' as const, startedAt: new Date(CLOCK) }])),
      }),
    );

    expect(report.failures.join(' ')).toContain(brokenPath);
    // The healthy run was still reaped: one bad file does not stop the reaper.
    expect(rec.signalled).toEqual([4242]);
    expect(renderCleanReport(report)).toContain(broken.runId);
  });
});

describe('clean: Q51 — it reaps resources, never results', () => {
  it('leaves the run directory, result.json, the manifest and evidence in place', async () => {
    const store = makeStore();
    const { runId } = await store.createRun();
    await store.recordProcessGroup(runId, 4242);
    await store.recordWorktree(runId, '/tmp/specwitness-x/worktree');
    const dir = store.runDir(runId);
    await writeFile(join(dir, 'result.json'), '{"schemaVersion":1}\n');
    await store.writeEvidenceFile(runId, 'evidence/gate-01-lint.txt', 'lint output');
    const rec = recorder();

    await cleanRuns(
      store,
      { all: true },
      effects(rec, {
        probeProcessGroups: async () =>
          new Map([[4242, { pgid: 4242, state: 'live' as const, startedAt: new Date(CLOCK) }]]),
      }),
    );

    // Every byte still there. V0 keeps all runs; a `--prune` retention flag is
    // deferred, and destroying these would destroy Epic 7's dogfooding data.
    expect(await readFile(join(dir, 'result.json'), 'utf8')).toBe('{"schemaVersion":1}\n');
    expect(await readFile(join(dir, 'evidence/gate-01-lint.txt'), 'utf8')).toBe('lint output');
    expect((await store.readManifest(runId)).runId).toBe(runId);
    // and the manifest still records WHAT was reaped, rather than forgetting it
    expect((await store.readManifest(runId)).processGroups).toEqual([4242]);
    expect((await store.readManifest(runId)).worktrees).toEqual(['/tmp/specwitness-x/worktree']);
    expect(await store.listRuns()).toEqual([runId]);
  });

  it('keeps everything even on the failure path', async () => {
    const store = makeStore();
    const { runId } = await store.createRun();
    await store.recordWorktree(runId, '/tmp/specwitness-x/worktree');
    const dir = store.runDir(runId);
    await writeFile(join(dir, 'result.json'), '{}\n');

    await cleanRuns(
      store,
      { all: false },
      effects(recorder(), {
        removeWorktree: async () => {
          throw new InfraError('nope', 'hint');
        },
      }),
    );

    expect(await readFile(join(dir, 'result.json'), 'utf8')).toBe('{}\n');
    expect(await store.listRuns()).toEqual([runId]);
  });
});

describe('clean: the report an operator reads', () => {
  it('names each run and what was done to it', async () => {
    const store = makeStore();
    const { runId } = await store.createRun();
    await store.recordProcessGroup(runId, 4242);
    await store.recordWorktree(runId, '/tmp/specwitness-x/worktree');

    const report = await cleanRuns(
      store,
      { all: false },
      effects(recorder(), {
        probeProcessGroups: async () =>
          new Map([[4242, { pgid: 4242, state: 'live' as const, startedAt: new Date(CLOCK) }]]),
      }),
    );

    const text = renderCleanReport(report);
    expect(text).toContain(runId);
    expect(text).toContain('4242');
    expect(text).toContain('/tmp/specwitness-x/worktree');
    expect(text.endsWith('\n')).toBe(true);
  });
});
