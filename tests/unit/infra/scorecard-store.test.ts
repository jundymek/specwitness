/**
 * Story 6.5 — the scorecard writer.
 *
 * THE FIRST DESCRIBE IS THE MOST IMPORTANT TEST IN THIS STORY and it is first on purpose.
 * Recording is instrumentation, and instrumentation that can fail a verification is worse
 * than no instrumentation at all. Every failure a filesystem can produce — unwritable
 * path, missing directory, a directory sitting where the file should be — must become a
 * WARNING and nothing else: never a throw, never an `InfraError`, never anything a caller
 * could turn into an exit code.
 *
 * The temptation this guards against is real: everywhere else in this product a failed
 * write IS an error, and `RunStore` is one file away doing exactly that.
 *
 * Hermetic (H-8): every case runs in its own `mkdtemp` directory, so the auto-review's
 * concurrent `pnpm test` in this same worktree cannot collide with it — which matters
 * more here than usual, since one of these describes is about concurrent appends.
 */

import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ScorecardStore } from '../../../src/infra/scorecard-store.js';
import {
  SCORECARD_FILENAME,
  SCORECARD_RECORD_VERSION,
  serializeScorecardRecord,
  type ScorecardRecord,
} from '../../../src/schemas/scorecard.js';

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

/** A project root with an initialised `.specwitness/`, in its own temp directory. */
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'specwitness-scorecard-'));
  roots.push(root);
  await mkdir(join(root, '.specwitness'), { recursive: true });
  return root;
}

/** A minimal, valid record. Fields the individual test does not care about. */
function record(overrides: Partial<ScorecardRecord> = {}): ScorecardRecord {
  return {
    schemaVersion: SCORECARD_RECORD_VERSION,
    runId: 'run-20260904T120000Z-ab12',
    epic: 'epic-6',
    startedAt: '2026-09-04T12:00:00.000Z',
    finishedAt: '2026-09-04T12:00:07.000Z',
    durationMs: 7000,
    outcome: { verdict: 'PASS' },
    criteria: { total: 0, pass: 0, fail: 0, needs_human: 0, skipped: 0, error: 0 },
    gates: { total: 0, pass: 0, fail: 0, skipped: 0 },
    flakiness: { flakyCriteria: 0, retriedCriteria: 0, extraAttempts: 0 },
    providerInvocations: 0,
    providerRoles: [],
    stageDurationsMs: {},
    findingCriterionIds: { fail: [], needs_human: [], error: [] },
    findingCriterionIdsTruncated: false,
    adapted: false,
    environment: {
      specwitnessVersion: '0.1.0',
      nodeVersion: 'v22.13.0',
      platform: 'linux',
      arch: 'x64',
    },
    ...overrides,
  };
}

/** Collects `warn` calls so a test can assert the failure was SURFACED, not swallowed. */
function collector(): { readonly messages: string[]; readonly warn: (message: string) => void } {
  const messages: string[] = [];
  return { messages, warn: (message: string) => void messages.push(message) };
}

describe('a failing scorecard write never changes anything (AC1, the hardest rule)', () => {
  it('does not throw when a DIRECTORY sits where the record file should be', async () => {
    const root = await project();
    // EISDIR on every platform this product supports, and it needs no privileges — a
    // chmod-based test silently passes as root, which CI containers routinely are.
    await mkdir(join(root, '.specwitness', SCORECARD_FILENAME), { recursive: true });

    const store = new ScorecardStore(root);
    const warnings = collector();

    await expect(store.appendRecord(record(), warnings.warn)).resolves.toBeUndefined();
    expect(warnings.messages).toHaveLength(1);
    // Surfaced, not silent: a scorecard that quietly stops recording is a metric that
    // quietly becomes wrong, which is worse than one that visibly breaks.
    expect(warnings.messages[0]).toContain(SCORECARD_FILENAME);
  });

  it('refuses a path that is not a regular file, instead of opening it', async () => {
    // Raised as a P2 by the codex review of this branch. Opening a FIFO for append BLOCKS
    // until a reader arrives, and `verify` awaits this call before rendering and before
    // returning its exit code — so a named pipe at this path would hang a completed
    // verification forever. A run that never produces its verdict is the most total way
    // instrumentation can affect an outcome.
    //
    // A DIRECTORY stands in for the FIFO here: Node cannot create a named pipe without a
    // subprocess, and unit tests in this project spawn none. Both take the same branch —
    // `stat().isFile()` is false — and `stat` answers immediately for either, which is the
    // property that turns a hang into a warning.
    const root = await project();
    await mkdir(join(root, '.specwitness', SCORECARD_FILENAME), { recursive: true });

    const store = new ScorecardStore(root);
    const warnings = collector();

    await expect(store.appendRecord(record(), warnings.warn)).resolves.toBeUndefined();
    expect(warnings.messages).toHaveLength(1);
    expect(warnings.messages[0]).toContain('not a regular file');
  });

  it('still appends through a SYMLINK that points at a regular file', async () => {
    // The permit half. Redirecting a scorecard onto another disk is a reasonable thing to
    // do, and a guard that broke it would be a guard someone deletes. `stat` follows
    // symlinks, so this passes while the FIFO case above does not.
    const root = await project();
    const elsewhere = join(root, 'scorecard-elsewhere.jsonl');
    await writeFile(elsewhere, '', 'utf8');
    await symlink(elsewhere, join(root, '.specwitness', SCORECARD_FILENAME));

    const store = new ScorecardStore(root);
    const warnings = collector();

    await store.appendRecord(record({ runId: 'run-20260904T120000Z-link' }), warnings.warn);

    expect(warnings.messages).toEqual([]);
    expect(await readFile(elsewhere, 'utf8')).toContain('run-20260904T120000Z-link');
  });

  it('does not throw when the .specwitness directory does not exist at all', async () => {
    const root = await mkdtemp(join(tmpdir(), 'specwitness-scorecard-'));
    roots.push(root);

    const store = new ScorecardStore(root);
    const warnings = collector();

    await expect(store.appendRecord(record(), warnings.warn)).resolves.toBeUndefined();
    expect(warnings.messages).toHaveLength(1);
  });

  it('does not throw when the containing directory is not writable', async () => {
    const root = await project();
    await chmod(join(root, '.specwitness'), 0o500);

    const store = new ScorecardStore(root);
    const warnings = collector();

    let threw: unknown;
    try {
      await store.appendRecord(record(), warnings.warn);
    } catch (error) {
      threw = error;
    }

    // Restored before any assertion, so a failed expectation cannot leave an
    // unremovable directory behind for the next run (Epic 4 retro §2 observation 8:
    // a killed run executes no afterEach at all, so the fixture must self-limit).
    await chmod(join(root, '.specwitness'), 0o700);

    expect(threw).toBeUndefined();
    // Running as root defeats the permission bits entirely; the write then SUCCEEDS and
    // warns about nothing, which is a correct outcome for this store and a vacuous one
    // for this test. Assert the property that holds either way, and let the two
    // privilege-independent cases above carry the real weight.
    expect(warnings.messages.length).toBeLessThanOrEqual(1);
  });

  it('does not throw even when the WARN CALLBACK itself throws', async () => {
    // Raised as a P2 by the codex review of this branch, and it is the sharpest one in the
    // story: it breaks the method's headline guarantee from the one line that exists to
    // uphold it. `warn` is invoked inside the catch, so if `warn` throws, the exception
    // escapes `appendRecord` — and the call site in `verify.ts` deliberately has no
    // try/catch, so it would reach `main.ts` and become exit 3. A completed verification
    // turned into "the environment is broken, retry" BY ITS OWN INSTRUMENTATION.
    //
    // Entirely reachable: `printWarning` writes to `process.stderr`, and
    // `specwitness verify | head -1` destroys that stream. EPIPE on a broken pipe is the
    // ordinary case, not an exotic one.
    const root = await project();
    await mkdir(join(root, '.specwitness', SCORECARD_FILENAME), { recursive: true });

    const store = new ScorecardStore(root);
    const exploding = (): never => {
      throw new Error('EPIPE: broken pipe, write');
    };

    await expect(store.appendRecord(record(), exploding)).resolves.toBeUndefined();
  });

  it('does not throw when the warn callback throws on an otherwise successful append', async () => {
    // The happy path never calls `warn`, so this asserts the shape rather than the
    // recovery: a store that only survived a throwing `warn` on the failure path would
    // still be one throw away from the defect above if the success path ever gained a
    // notice.
    const store = new ScorecardStore(await project());
    const exploding = (): never => {
      throw new Error('EPIPE: broken pipe, write');
    };

    await expect(store.appendRecord(record(), exploding)).resolves.toBeUndefined();
  });

  it('warns exactly once per failed append, never accumulating silence', async () => {
    const root = await project();
    await mkdir(join(root, '.specwitness', SCORECARD_FILENAME), { recursive: true });

    const store = new ScorecardStore(root);
    const warnings = collector();

    await store.appendRecord(record(), warnings.warn);
    await store.appendRecord(record(), warnings.warn);

    expect(warnings.messages).toHaveLength(2);
  });
});

describe('the happy path appends one complete line per run', () => {
  it('creates the file on the first record and appends to it afterwards', async () => {
    const root = await project();
    const store = new ScorecardStore(root);
    const warnings = collector();

    await store.appendRecord(record({ runId: 'run-20260904T120000Z-aaaa' }), warnings.warn);
    await store.appendRecord(record({ runId: 'run-20260904T120100Z-bbbb' }), warnings.warn);

    const text = await readFile(join(root, '.specwitness', SCORECARD_FILENAME), 'utf8');

    expect(warnings.messages).toEqual([]);
    // Exactly two lines, each terminated. A record without its newline is a record the
    // next append concatenates itself onto.
    expect(text.split('\n').filter(Boolean)).toHaveLength(2);
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('run-20260904T120000Z-aaaa');
    expect(text).toContain('run-20260904T120100Z-bbbb');
  });

  it('does not concatenate onto a torn final line, losing BOTH records', async () => {
    // Raised as a P2 by the codex review of this branch, and it is the failure this story
    // exists to prevent: a completed run vanishing from the measurement with no symptom.
    //
    // ADR-008 §5 makes ONE torn line survivable. But a crash or a short write leaves the
    // file with NO trailing newline, and appending then glues the next complete record
    // onto the fragment — so the reader skips them as a single malformed line and the
    // GOOD run is lost along with the damaged one. One casualty becomes two, and the
    // second one was healthy.
    //
    // Every earlier test in this file wrote its torn line WITH a trailing newline, which
    // is why none of them caught this. That is the more useful half of the finding.
    const root = await project();
    const store = new ScorecardStore(root);
    const warnings = collector();
    await writeFile(
      join(root, '.specwitness', SCORECARD_FILENAME),
      '{"schemaVersion":1,"runId":"run-2026090',
      'utf8',
    );

    await store.appendRecord(record({ runId: 'run-20260904T120100Z-good' }), warnings.warn);
    const file = await store.read();

    // The completed run survives — that is the whole point.
    expect(file.records).toHaveLength(1);
    expect(file.records[0]?.runId).toBe('run-20260904T120100Z-good');
    // And the damaged fragment is still counted, so `skippedRecords` stays honest.
    expect(file.skipped).toHaveLength(1);
    expect(file.skipped[0]?.reason).toBe('malformed');
  });

  it('adds no separator when the file already ends cleanly', async () => {
    // The other direction: a repair that fired unconditionally would put a blank line
    // between every pair of records. Harmless to the reader, but it would mean the file
    // grows at twice the rate the concurrency argument assumes, and it would look like
    // damage to anyone opening it.
    const root = await project();
    const store = new ScorecardStore(root);
    const warnings = collector();

    await store.appendRecord(record({ runId: 'run-20260904T120000Z-aaaa' }), warnings.warn);
    await store.appendRecord(record({ runId: 'run-20260904T120100Z-bbbb' }), warnings.warn);

    const text = await readFile(join(root, '.specwitness', SCORECARD_FILENAME), 'utf8');

    expect(text).not.toContain('\n\n');
  });

  it('never writes outside .specwitness/, and never inside .specwitness/runs/', async () => {
    const root = await project();
    const store = new ScorecardStore(root);

    // The whole path, asserted rather than described. AD-8 keeps `RunStore` the sole
    // writer beneath `runs/`, and this store must not become a second one.
    expect(store.path).toBe(join(root, '.specwitness', SCORECARD_FILENAME));
  });
});

describe('concurrency — parallel runs append parallel lines (AC1)', () => {
  it('keeps every record on its own intact line under concurrent appends', async () => {
    const root = await project();
    const warnings = collector();

    // Twenty independent stores, exactly as twenty `specwitness verify` processes would
    // be: each opens the file itself. The harness this product is built for runs agents
    // in parallel waves, so this is the normal condition rather than an exotic one.
    const appends = Array.from({ length: 20 }, async (_unused, index) => {
      const store = new ScorecardStore(root);
      await store.appendRecord(
        record({ runId: `run-20260904T1200${String(index).padStart(2, '0')}Z-cccc` }),
        warnings.warn,
      );
    });

    await Promise.all(appends);

    const text = await readFile(join(root, '.specwitness', SCORECARD_FILENAME), 'utf8');
    const lines = text.split('\n').filter(Boolean);

    expect(warnings.messages).toEqual([]);
    expect(lines).toHaveLength(20);
    // Every line independently parseable — the property an interleaved write destroys.
    for (const line of lines) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
    // And every run present exactly once: a lost append is as bad as a torn one.
    const ids = new Set(lines.map((line) => (JSON.parse(line) as ScorecardRecord).runId));
    expect(ids.size).toBe(20);
  });
});

describe('reading back — ADR-008 §5, skip with a warning and keep counting', () => {
  it('returns every valid record and no skips for a clean file', async () => {
    const root = await project();
    const store = new ScorecardStore(root);
    const warnings = collector();

    await store.appendRecord(record({ runId: 'run-20260904T120000Z-aaaa' }), warnings.warn);
    await store.appendRecord(record({ runId: 'run-20260904T120100Z-bbbb' }), warnings.warn);

    const file = await store.read();

    expect(file.records).toHaveLength(2);
    expect(file.skipped).toEqual([]);
  });

  it('returns an empty file rather than failing when nothing has been recorded yet', async () => {
    const store = new ScorecardStore(await project());

    const file = await store.read();

    expect(file.records).toEqual([]);
    expect(file.skipped).toEqual([]);
  });

  it('skips an UNKNOWN-KEY line, names the line number and the field, and continues', async () => {
    const root = await project();
    const store = new ScorecardStore(root);
    const warnings = collector();
    await store.appendRecord(record({ runId: 'run-20260904T120000Z-aaaa' }), warnings.warn);

    // A record from a NEWER SpecWitness: the shape this build knows, plus one field it
    // does not. ADR-008 §5 says skip it with a warning and keep summarising.
    const fromTheFuture = JSON.parse(
      serializeScorecardRecord(record({ runId: 'run-20260904T120100Z-bbbb' })),
    ) as Record<string, unknown>;
    fromTheFuture['defectAttribution'] = 'unique';
    const existing = await readFile(join(root, '.specwitness', SCORECARD_FILENAME), 'utf8');
    await writeFile(
      join(root, '.specwitness', SCORECARD_FILENAME),
      `${existing}${JSON.stringify(fromTheFuture)}\n`,
      'utf8',
    );

    const file = await store.read();

    expect(file.records).toHaveLength(1);
    expect(file.skipped).toHaveLength(1);
    expect(file.skipped[0]?.line).toBe(2);
    expect(file.skipped[0]?.reason).toBe('version-skew');
    expect(file.skipped[0]?.message).toContain('defectAttribution');
    expect(file.skipped[0]?.message).toContain('newer SpecWitness');
  });

  it('skips a line from a NEWER SCHEMA VERSION and counts it, rather than aggregating it', async () => {
    // The read-level half of the P2 the codex review of this branch raised. A version-2
    // record can carry exactly this build's key set and mean something different by it
    // (ADR-008 §3), so the unknown-key branch cannot see it. It must land in `skipped`,
    // which is what 6.6 surfaces as `skippedRecords` — a record silently aggregated by a
    // build that misunderstands it is a wrong metric with no symptom.
    const root = await project();
    const store = new ScorecardStore(root);
    const warnings = collector();
    await store.appendRecord(record({ runId: 'run-20260904T120000Z-aaaa' }), warnings.warn);

    const future = JSON.parse(
      serializeScorecardRecord(record({ runId: 'run-20260904T120100Z-bbbb' })),
    ) as Record<string, unknown>;
    future['schemaVersion'] = SCORECARD_RECORD_VERSION + 1;
    const existing = await readFile(join(root, '.specwitness', SCORECARD_FILENAME), 'utf8');
    await writeFile(
      join(root, '.specwitness', SCORECARD_FILENAME),
      `${existing}${JSON.stringify(future)}\n`,
      'utf8',
    );

    const file = await store.read();

    expect(file.records).toHaveLength(1);
    expect(file.records[0]?.runId).toBe('run-20260904T120000Z-aaaa');
    expect(file.skipped).toHaveLength(1);
    expect(file.skipped[0]).toMatchObject({ line: 2, reason: 'version-skew' });
  });

  it('skips a MALFORMED line with a DIFFERENT diagnosis, so corruption cannot hide behind an upgrade hint', async () => {
    const root = await project();
    const store = new ScorecardStore(root);
    const warnings = collector();
    await store.appendRecord(record({ runId: 'run-20260904T120000Z-aaaa' }), warnings.warn);

    const wrongShape = JSON.parse(serializeScorecardRecord(record())) as Record<string, unknown>;
    wrongShape['durationMs'] = 'seven seconds';
    const torn = '{"schemaVersion":1,"runId":"run-2026';
    const existing = await readFile(join(root, '.specwitness', SCORECARD_FILENAME), 'utf8');
    await writeFile(
      join(root, '.specwitness', SCORECARD_FILENAME),
      `${existing}${JSON.stringify(wrongShape)}\n${torn}\n`,
      'utf8',
    );

    const file = await store.read();

    expect(file.records).toHaveLength(1);
    expect(file.skipped).toHaveLength(2);
    // THE ASSERTION THAT MATTERS: a wrong TYPE is not a version skew. A test that only
    // covered the unknown-key direction would let real corruption become a friendly
    // upgrade hint (ADR-008 "Consequences", last bullet).
    expect(file.skipped[0]).toMatchObject({ line: 2, reason: 'malformed' });
    expect(file.skipped[0]?.message).not.toContain('newer SpecWitness');
    expect(file.skipped[1]).toMatchObject({ line: 3, reason: 'malformed' });
  });

  it('never echoes a VALUE from the file into a skip message, only paths and codes', async () => {
    const root = await project();
    const store = new ScorecardStore(root);

    const poisoned = JSON.parse(serializeScorecardRecord(record())) as Record<string, unknown>;
    poisoned['epic'] = { leaked: 'ghp-DEADBEEFCAFEBABE' };
    await writeFile(
      join(root, '.specwitness', SCORECARD_FILENAME),
      `${JSON.stringify(poisoned)}\n`,
      'utf8',
    );

    const file = await store.read();

    expect(file.skipped).toHaveLength(1);
    // Asserting the SECRET IS ABSENT, never that a marker is present (Epic 3 retro §7):
    // output carrying `[REDACTED]` with the secret still beside it survives review in a
    // way a raw leak does not.
    expect(file.skipped[0]?.message).not.toContain('DEADBEEF');
  });

  it('skips a blank line without counting it as corruption', async () => {
    const root = await project();
    const store = new ScorecardStore(root);
    const warnings = collector();
    await store.appendRecord(record(), warnings.warn);
    const existing = await readFile(join(root, '.specwitness', SCORECARD_FILENAME), 'utf8');
    await writeFile(join(root, '.specwitness', SCORECARD_FILENAME), `${existing}\n`, 'utf8');

    const file = await store.read();

    // A trailing blank line is not damage, and reporting one as a skipped record would
    // make `skippedRecords` alarm on every well-formed file.
    expect(file.records).toHaveLength(1);
    expect(file.skipped).toEqual([]);
  });
});
