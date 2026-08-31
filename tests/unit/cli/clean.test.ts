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
    terminateProcessGroup: async (pgid) => {
      recorder.signalled.push(pgid);
    },
    worktreeExists: () => false,
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
  it('removes a worktree that is still on disk', async () => {
    const store = makeStore();
    const { runId } = await store.createRun();
    await store.recordWorktree(runId, '/tmp/specwitness-x/worktree');
    const rec = recorder();

    await cleanRuns(store, { all: false }, effects(rec, { worktreeExists: () => true }));

    expect(rec.removed).toEqual(['/tmp/specwitness-x/worktree']);
  });

  it('does nothing for a worktree path that is already gone', async () => {
    const store = makeStore();
    const { runId } = await store.createRun();
    await store.recordWorktree(runId, '/tmp/specwitness-x/worktree');
    const rec = recorder();

    const report = await cleanRuns(store, { all: false }, effects(rec));

    expect(rec.removed).toEqual([]);
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
        worktreeExists: () => true,
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
        worktreeExists: () => true,
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
        worktreeExists: () => true,
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
        worktreeExists: () => true,
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
