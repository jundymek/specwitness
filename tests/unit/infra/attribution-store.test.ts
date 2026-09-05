/**
 * Story 6.6 — the attribution log's reader and writer.
 *
 * THE DELIBERATE ASYMMETRY WITH STORY 6.5 IS THE SUBJECT OF THE FIRST DESCRIBE.
 * `ScorecardStore.appendRecord` may never reject, because it is instrumentation hanging
 * off a verdict and instrumentation that can fail a verification is worse than none.
 * **This store is the opposite and must be**: it IS the user's command. A `scorecard add`
 * that silently failed to record would tell a developer their judgement was saved when it
 * was not — and the north-star metric would quietly lose the one input no machine can
 * reconstruct.
 *
 * Hermetic (H-8): every case runs in its own `mkdtemp` directory, so a concurrent
 * `pnpm test` in this same worktree cannot collide with it.
 */

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AttributionStore } from '../../../src/infra/attribution-store.js';
import {
  ATTRIBUTION_RECORD_VERSION,
  ATTRIBUTIONS_FILENAME,
  serializeAttributionRecord,
  type AttributionRecord,
} from '../../../src/schemas/scorecard-attribution.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      // Restore any permission this file removed, or the removal fails too.
      await chmod(join(root, '.specwitness'), 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'specwitness-attribution-'));
  roots.push(root);
  await mkdir(join(root, '.specwitness'), { recursive: true });
  return root;
}

function record(overrides: Partial<AttributionRecord> = {}): AttributionRecord {
  return {
    schemaVersion: ATTRIBUTION_RECORD_VERSION,
    runId: 'run-20260904T120000Z-ab12',
    criterionId: 'E6-01',
    attribution: 'unique',
    recordedAt: '2026-09-05T10:00:00.000Z',
    ...overrides,
  };
}

function fileOf(root: string): string {
  return join(root, '.specwitness', ATTRIBUTIONS_FILENAME);
}

describe('a failed write is REPORTED, not swallowed', () => {
  it('rejects when the directory is not writable', async () => {
    const root = await project();
    await chmod(join(root, '.specwitness'), 0o500);

    // The whole point. Story 6.5's writer resolves on every path; this one must not,
    // because a human's judgement silently not being recorded is a lost measurement
    // nobody can reconstruct later.
    await expect(new AttributionStore(root).append(record())).rejects.toThrow();
  });

  it('rejects rather than writing when the path is not a regular file', async () => {
    const root = await project();
    await mkdir(fileOf(root), { recursive: true });

    await expect(new AttributionStore(root).append(record())).rejects.toThrow();
  });
});

describe('appending accumulates', () => {
  it('creates the file on the first append', async () => {
    const root = await project();
    await new AttributionStore(root).append(record());

    const text = await readFile(fileOf(root), 'utf8');
    expect(text.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(text.trim())).toEqual(record());
  });

  it('adds a line rather than replacing the file', async () => {
    const root = await project();
    const store = new AttributionStore(root);

    await store.append(record({ criterionId: 'E6-01' }));
    await store.append(record({ criterionId: 'E6-02', attribution: 'false-positive' }));

    const { records, skipped } = await store.read();
    expect(records.map((entry) => entry.criterionId)).toEqual(['E6-01', 'E6-02']);
    expect(skipped).toEqual([]);
  });

  it('keeps a torn final line from swallowing the next good record', async () => {
    // Story 6.5 learned this as a P2: a crash leaves the file with no trailing newline,
    // and appending then glues the next COMPLETE record onto the fragment. The reader
    // skips the pair as one malformed line — one casualty becomes two, and the second was
    // healthy.
    const root = await project();
    await writeFile(fileOf(root), '{"schemaVersion":1,"runId":"run-2026', 'utf8');

    await new AttributionStore(root).append(record());

    const { records, skipped } = await new AttributionStore(root).read();
    expect(records).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toBe('malformed');
  });

  it('survives concurrent appends without interleaving within a line', async () => {
    const root = await project();
    const stores = Array.from({ length: 12 }, () => new AttributionStore(root));

    await Promise.all(
      stores.map(async (store, index) =>
        store.append(record({ criterionId: `E6-${String(index + 1).padStart(2, '0')}` })),
      ),
    );

    const { records, skipped } = await new AttributionStore(root).read();
    expect(records).toHaveLength(12);
    expect(skipped).toEqual([]);
    expect(new Set(records.map((entry) => entry.criterionId)).size).toBe(12);
  });
});

describe('reading — ADR-008 §5, and an absent file is not an error', () => {
  it('reads an absent file as an empty log', async () => {
    // A project that has attributed nothing has attributed nothing. That is a fact, not a
    // fault, and `scorecard summary` must still answer.
    const root = await project();
    await expect(new AttributionStore(root).read()).resolves.toEqual({ records: [], skipped: [] });
  });

  it('reads an empty file as an empty log', async () => {
    const root = await project();
    await writeFile(fileOf(root), '', 'utf8');
    await expect(new AttributionStore(root).read()).resolves.toEqual({ records: [], skipped: [] });
  });

  it('does not count blank lines as skipped records', async () => {
    // An alarm that always fires is one nobody reads: every healthy file ends with a
    // newline, so counting the empty tail would make the skip count alarm on every file.
    const root = await project();
    await writeFile(fileOf(root), `${serializeAttributionRecord(record())}\n\n`, 'utf8');

    const { records, skipped } = await new AttributionStore(root).read();
    expect(records).toHaveLength(1);
    expect(skipped).toEqual([]);
  });

  it('skips a version-skewed line with a warning and keeps reading', async () => {
    const root = await project();
    await writeFile(
      fileOf(root),
      [
        serializeAttributionRecord(record({ criterionId: 'E6-01' })),
        `${JSON.stringify({ ...record(), schemaVersion: ATTRIBUTION_RECORD_VERSION + 1 })}\n`,
        serializeAttributionRecord(record({ criterionId: 'E6-03' })),
      ].join(''),
      'utf8',
    );

    const { records, skipped } = await new AttributionStore(root).read();
    expect(records.map((entry) => entry.criterionId)).toEqual(['E6-01', 'E6-03']);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.line).toBe(2);
    expect(skipped[0]?.reason).toBe('version-skew');
  });

  it('distinguishes a malformed line from a version-skewed one', async () => {
    // Both directions, in one file. A suite covering only the skew direction would let
    // real corruption hide behind a friendly upgrade hint.
    const root = await project();
    await writeFile(
      fileOf(root),
      [
        `${JSON.stringify({ ...record(), reviewer: 'ada' })}\n`,
        'not json at all\n',
        serializeAttributionRecord(record({ criterionId: 'E6-09' })),
      ].join(''),
      'utf8',
    );

    const { records, skipped } = await new AttributionStore(root).read();
    expect(records).toHaveLength(1);
    expect(skipped.map((entry) => entry.reason)).toEqual(['version-skew', 'malformed']);
    expect(skipped.map((entry) => entry.line)).toEqual([1, 2]);
  });

  it('reads a file whose every line is unusable, without throwing', async () => {
    const root = await project();
    await writeFile(fileOf(root), 'garbage\nmore garbage\n', 'utf8');

    const { records, skipped } = await new AttributionStore(root).read();
    expect(records).toEqual([]);
    expect(skipped).toHaveLength(2);
  });

  it('throws when the file exists but cannot be read', async () => {
    // Unlike the WRITE path in story 6.5, a failed READ is reported: this is 6.6's own
    // command, and a caller that asked for the data deserves to hear it could not be
    // delivered rather than receive a silently empty summary.
    const root = await project();
    await writeFile(fileOf(root), serializeAttributionRecord(record()), 'utf8');
    await chmod(fileOf(root), 0o000);

    await expect(new AttributionStore(root).read()).rejects.toThrow();
    await chmod(fileOf(root), 0o600);
  });
});
