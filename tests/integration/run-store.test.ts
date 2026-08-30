/**
 * Story 1.6 AC1 — `RunStore`, the sole writer under `.specwitness/runs/` (AD-8).
 *
 * Integration rather than unit: the point of this module IS its filesystem
 * behaviour, so these run against real temp directories. Time and randomness
 * still come from fakes, so every id below is exact.
 *
 * On fsync: verifying real crash durability is OS- and filesystem-dependent
 * and cannot be asserted portably from a test. What IS assertable — and what
 * actually goes wrong in practice — is whether the code takes the fsync path
 * at all, and whether it does so before returning. That is what the injected
 * fs-wrapper spy below checks. The genuine kill -9 test belongs to the Epic 3
 * golden corpus, and this file does not pretend to cover it.
 */

import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InfraError, UsageError } from '../../src/domain/errors.js';
import { RunStore } from '../../src/infra/run-store.js';
import { ConstantIds, FixedClock, SequenceIds } from '../fakes/ports.js';

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'specwitness-run-store-'));
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

/** A store whose ids are fully determined by the test. */
function storeAt(root: string, instants: string[], suffixes: string[]): RunStore {
  return new RunStore(root, new FixedClock(...instants), new SequenceIds(...suffixes));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('createRun (AC1)', () => {
  it('creates the documented layout and returns the id and directory', async () => {
    const store = storeAt(projectRoot, ['2026-08-30T14:25:01.123Z'], ['a3f9']);

    const run = await store.createRun();

    expect(run.runId).toBe('run-20260830T142501Z-a3f9');
    expect(run.dir).toBe(join(projectRoot, '.specwitness', 'runs', 'run-20260830T142501Z-a3f9'));
    expect(await exists(join(run.dir, 'manifest.json'))).toBe(true);
  });

  it('writes the AC1 manifest skeleton', async () => {
    const store = storeAt(projectRoot, ['2026-08-30T14:25:01.123Z'], ['a3f9']);

    const run = await store.createRun({ epic: 'epic-7' });
    const written = JSON.parse(await readFile(join(run.dir, 'manifest.json'), 'utf8'));

    expect(written).toStrictEqual({
      schemaVersion: 1,
      runId: 'run-20260830T142501Z-a3f9',
      createdAt: '2026-08-30T14:25:01.123Z',
      epic: 'epic-7',
      worktrees: [],
      processGroups: [],
      reaped: false,
    });
  });

  it('records a null epic when none is given', async () => {
    const store = storeAt(projectRoot, ['2026-08-30T14:25:01.000Z'], ['a3f9']);

    const run = await store.createRun();

    expect((await store.readManifest(run.runId)).epic).toBeNull();
  });

  it('creates the runs root when it does not exist', async () => {
    const store = storeAt(projectRoot, ['2026-08-30T14:25:01.000Z'], ['a3f9']);

    await store.createRun();

    expect(await exists(join(projectRoot, '.specwitness', 'runs'))).toBe(true);
  });

  it('is a no-op over a runs root that init already created', async () => {
    // arnold's `specwitness init` (story 1.4) scaffolds an empty
    // .specwitness/runs/. Creating it again must not fail.
    await mkdir(join(projectRoot, '.specwitness', 'runs'), { recursive: true });
    const store = storeAt(projectRoot, ['2026-08-30T14:25:01.000Z'], ['a3f9']);

    await expect(store.createRun()).resolves.toMatchObject({
      runId: 'run-20260830T142501Z-a3f9',
    });
  });

  it('gives concurrent runs distinct directories', async () => {
    const store = storeAt(
      projectRoot,
      ['2026-08-30T14:25:01.000Z', '2026-08-30T14:25:01.000Z'],
      ['aaaa', 'bbbb'],
    );

    const [first, second] = await Promise.all([store.createRun(), store.createRun()]);

    expect(first.runId).not.toBe(second.runId);
    expect(await exists(join(first.dir, 'manifest.json'))).toBe(true);
    expect(await exists(join(second.dir, 'manifest.json'))).toBe(true);
  });

  it('fails closed on an id collision rather than reusing a directory', async () => {
    // Astronomically unlikely (same second AND same 4-char suffix), but the
    // consequence of getting it wrong is two runs writing over each other's
    // evidence — so it must be an error, never a silent reuse.
    const store = new RunStore(
      projectRoot,
      new FixedClock('2026-08-30T14:25:01.000Z'),
      new ConstantIds('a3f9'),
    );

    await store.createRun();

    await expect(store.createRun()).rejects.toThrow(InfraError);
    await expect(store.createRun()).rejects.toThrow(/run-20260830T142501Z-a3f9/);
  });

  it('does not clobber the first run when a collision is refused', async () => {
    const store = new RunStore(
      projectRoot,
      new FixedClock('2026-08-30T14:25:01.000Z'),
      new ConstantIds('a3f9'),
    );

    const first = await store.createRun({ epic: 'epic-7' });
    await store.createRun().catch(() => undefined);

    expect((await store.readManifest(first.runId)).epic).toBe('epic-7');
  });
});

describe('createRun durability (AD-8)', () => {
  it('fsyncs the manifest file AND its directory before returning', async () => {
    // The directory fsync is the one people forget: without it the directory
    // ENTRY may not survive a crash, so a fully-written file can still
    // vanish. Both are asserted, and both must happen before the promise
    // resolves — a durability guarantee established after the caller has
    // moved on is no guarantee at all.
    const syncedFds: string[] = [];
    let resolved = false;

    const store = new RunStore(
      projectRoot,
      new FixedClock('2026-08-30T14:25:01.000Z'),
      new SequenceIds('a3f9'),
      {
        onFsync: (target) => {
          expect(resolved).toBe(false);
          syncedFds.push(target);
        },
      },
    );

    await store.createRun();
    resolved = true;

    expect(syncedFds).toContain('file');
    expect(syncedFds).toContain('directory');
  });

  it('surfaces an fsync failure as InfraError instead of reporting success', async () => {
    const store = new RunStore(
      projectRoot,
      new FixedClock('2026-08-30T14:25:01.000Z'),
      new SequenceIds('a3f9'),
      {
        onFsync: () => {
          throw new Error('ENOSPC');
        },
      },
    );

    await expect(store.createRun()).rejects.toThrow(InfraError);
  });
});

describe('readManifest', () => {
  it('reads back what createRun wrote', async () => {
    const store = storeAt(projectRoot, ['2026-08-30T14:25:01.123Z'], ['a3f9']);
    const run = await store.createRun({ epic: 'epic-7' });

    const manifest = await store.readManifest(run.runId);

    expect(manifest.runId).toBe(run.runId);
    expect(manifest.createdAt).toBe('2026-08-30T14:25:01.123Z');
    expect(manifest.epic).toBe('epic-7');
    expect(manifest.reaped).toBe(false);
  });

  it('throws UsageError for a malformed id, so the CLI exits 64', async () => {
    const store = storeAt(projectRoot, ['2026-08-30T14:25:01.000Z'], ['a3f9']);

    await expect(store.readManifest('../../etc/passwd')).rejects.toThrow(UsageError);
  });

  it('throws InfraError naming what was searched for an unknown run', async () => {
    const store = storeAt(projectRoot, ['2026-08-30T14:25:01.000Z'], ['a3f9']);

    await expect(store.readManifest('run-20260830T142501Z-zzzz')).rejects.toThrow(InfraError);
    await expect(store.readManifest('run-20260830T142501Z-zzzz')).rejects.toThrow(
      /run-20260830T142501Z-zzzz/,
    );
  });

  it('throws InfraError naming the file for a corrupt manifest', async () => {
    const store = storeAt(projectRoot, ['2026-08-30T14:25:01.000Z'], ['a3f9']);
    const run = await store.createRun();
    await writeFile(join(run.dir, 'manifest.json'), '{ truncated', 'utf8');

    await expect(store.readManifest(run.runId)).rejects.toThrow(InfraError);
    await expect(store.readManifest(run.runId)).rejects.toThrow(/manifest\.json/);
  });
});

describe('listRuns', () => {
  it('returns an empty list when the project has no runs root, creating nothing', async () => {
    // A read path must never mkdir. `report` runs in the user's cwd, and a
    // command that silently scaffolds storage just by looking is a defect.
    const store = storeAt(projectRoot, ['2026-08-30T14:25:01.000Z'], ['a3f9']);

    expect(await store.listRuns()).toStrictEqual([]);
    expect(await exists(join(projectRoot, '.specwitness'))).toBe(false);
  });

  it('lists run ids newest first', async () => {
    const store = storeAt(
      projectRoot,
      ['2026-01-02T03:04:05.000Z', '2026-06-02T03:04:05.000Z', '2027-01-02T03:04:05.000Z'],
      ['aaaa', 'bbbb', 'cccc'],
    );
    await store.createRun();
    await store.createRun();
    await store.createRun();

    expect(await store.listRuns()).toStrictEqual([
      'run-20270102T030405Z-cccc',
      'run-20260602T030405Z-bbbb',
      'run-20260102T030405Z-aaaa',
    ]);
  });

  it('ignores directories that are not run ids', async () => {
    // Not an error: a stray directory is somebody else's business, and
    // refusing to list anything because of it would be worse than skipping it.
    const store = storeAt(projectRoot, ['2026-08-30T14:25:01.000Z'], ['a3f9']);
    const run = await store.createRun();
    await mkdir(join(projectRoot, '.specwitness', 'runs', 'scratch'), { recursive: true });

    expect(await store.listRuns()).toStrictEqual([run.runId]);
  });
});

describe('runDir (AD-8 single path-construction point)', () => {
  it('builds the canonical path', async () => {
    const store = storeAt(projectRoot, ['2026-08-30T14:25:01.000Z'], ['a3f9']);

    expect(store.runDir('run-20260830T142501Z-a3f9')).toBe(
      join(projectRoot, '.specwitness', 'runs', 'run-20260830T142501Z-a3f9'),
    );
  });

  it('refuses an id that is not canonical, so no traversal can escape', async () => {
    // runDir is the ONE place a run path is constructed. Validating here means
    // no caller can smuggle a traversal through any other method either.
    const store = storeAt(projectRoot, ['2026-08-30T14:25:01.000Z'], ['a3f9']);

    expect(() => store.runDir('../../etc')).toThrow(UsageError);
    expect(() => store.runDir('run-20260830T142501Z-a3f9/../..')).toThrow(UsageError);
  });

  it('does not touch the filesystem', async () => {
    const store = storeAt(projectRoot, ['2026-08-30T14:25:01.000Z'], ['a3f9']);

    store.runDir('run-20260830T142501Z-a3f9');

    expect(await exists(join(projectRoot, '.specwitness'))).toBe(false);
  });
});

describe('hasResult (story 3.5 seam)', () => {
  it('is false for a run that has only a manifest', async () => {
    const store = storeAt(projectRoot, ['2026-08-30T14:25:01.000Z'], ['a3f9']);
    const run = await store.createRun();

    expect(await store.hasResult(run.runId)).toBe(false);
  });

  it('is true once a result.json exists', async () => {
    const store = storeAt(projectRoot, ['2026-08-30T14:25:01.000Z'], ['a3f9']);
    const run = await store.createRun();
    await writeFile(join(run.dir, 'result.json'), '{}', 'utf8');

    expect(await store.hasResult(run.runId)).toBe(true);
  });
});
