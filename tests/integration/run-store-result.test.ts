/**
 * Story 3.5 AC1 — the atomic `result.json` finalize, AD-8's second write discipline.
 *
 * Integration rather than unit: the whole point of this code is its filesystem behaviour.
 * Time and randomness still come from fakes, so every run id below is exact.
 *
 * A SEPARATE FILE FROM `run-store.test.ts` AND `run-store-lifecycle.test.ts` ON PURPOSE.
 * Three stories now write into `src/infra/run-store.ts` (1.6, 3.2, 3.5) and Epic 2's
 * pattern for that is to **share zero `expect()`**: story 3.2's suite asserts manifest
 * appends, this one asserts the finalize, and neither has to be rebased through the
 * other's assertions. Agreed with 3.2 in intent-sync.
 *
 * WHAT "ATOMIC" IS ACTUALLY PROVED HERE. Real crash durability is OS- and
 * filesystem-dependent and cannot be asserted portably — that honesty is already in the
 * module. What IS assertable, and what a refactor actually breaks:
 *
 *  - the target holds the PREVIOUS complete document right up until the rename, so a
 *    concurrent reader can never see a partial one;
 *  - a failure before the rename leaves the previous document untouched;
 *  - the staging file does not survive either path;
 *  - the fsync path is taken for the file AND for its directory.
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InfraError } from '../../src/domain/errors.js';
import type { RunResult } from '../../src/domain/run-result.js';
import { RunStore, type RunStoreHooks } from '../../src/infra/run-store.js';
import { serializeRunResult } from '../../src/schemas/result.js';
import { FixedClock, SequenceIds } from '../fakes/ports.js';
import { fullyPopulatedRunResult } from '../fixtures/run-result.js';

/** `#writeDurably` stages under this name; nothing else may write it. */
const STAGING = '.result.json.writing';

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'specwitness-finalize-'));
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

function storeAt(hooks: RunStoreHooks = {}): RunStore {
  return new RunStore(
    projectRoot,
    new FixedClock('2026-08-30T14:25:01.123Z'),
    new SequenceIds('a3f9'),
    hooks,
  );
}

/** A result whose runId matches the run the test created. */
function resultFor(runId: string): RunResult {
  return { ...fullyPopulatedRunResult(), runId };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('writeResult publishes the document (AC1)', () => {
  it('writes exactly the bytes the one serializer produces', async () => {
    // The harness contract's central promise (Q53): `--json` stdout and this file are the
    // same bytes. That only holds if the finalize writes the serializer's output verbatim
    // — no re-encoding, no added newline, no pretty-printing of its own.
    const store = storeAt();
    const run = await store.createRun({ epic: 'epic-7' });
    const result = resultFor(run.runId);

    await store.writeResult(run.runId, result);

    const onDisk = await readFile(join(run.dir, 'result.json'), 'utf8');
    expect(onDisk).toBe(serializeRunResult(result));
  });

  it('makes hasResult() true afterwards', async () => {
    const store = storeAt();
    const run = await store.createRun({ epic: 'epic-7' });

    expect(await store.hasResult(run.runId)).toBe(false);
    await store.writeResult(run.runId, resultFor(run.runId));
    expect(await store.hasResult(run.runId)).toBe(true);
  });

  it('leaves no staging file behind', async () => {
    const store = storeAt();
    const run = await store.createRun({ epic: 'epic-7' });

    await store.writeResult(run.runId, resultFor(run.runId));

    expect(existsSync(join(run.dir, STAGING))).toBe(false);
  });

  it('takes the fsync path for the file AND for its directory', async () => {
    // Not a durability proof — that is not portably assertable and the module says so.
    // This is the part a refactor breaks: dropping the directory fsync makes the CONTENTS
    // durable while the name that finds them may not be.
    const seen: string[] = [];
    const store = storeAt({ onFsync: (target) => seen.push(target) });
    const run = await store.createRun({ epic: 'epic-7' });
    seen.length = 0;

    await store.writeResult(run.runId, resultFor(run.runId));

    expect(seen).toContain('file');
    expect(seen).toContain('directory');
  });

  it('rejects a malformed run id before touching the filesystem', async () => {
    // A typo is a UsageError (exit 64), and `runDir` validates before joining — which is
    // what stops a traversal reaching the filesystem through any store method.
    const store = storeAt();

    await expect(store.writeResult('../../etc', resultFor('x'))).rejects.toThrow();
  });
});

describe('the target is never observable half-written (AC1)', () => {
  it('still holds the PREVIOUS complete document at the moment the new one is fsynced', async () => {
    // The rename is what publishes. Until it runs, a reader sees the old document in
    // full — which is the entire reason stage-and-rename exists rather than open(w).
    const store0 = storeAt();
    const run = await store0.createRun({ epic: 'epic-7' });
    const first = resultFor(run.runId);
    await store0.writeResult(run.runId, first);

    let observedDuringWrite: string | undefined;
    const store = storeAt({
      onFsync: (target) => {
        if (target === 'file' && observedDuringWrite === undefined) {
          // Synchronous read at the moment the staged file is durable, before the rename.
          observedDuringWrite = readFileSync(join(run.dir, 'result.json'), 'utf8');
        }
      },
    });

    const second: RunResult = { ...first, epic: 'epic-9' };
    await store.writeResult(run.runId, second);

    expect(observedDuringWrite).toBe(serializeRunResult(first));
    expect(await readFile(join(run.dir, 'result.json'), 'utf8')).toBe(serializeRunResult(second));
  });

  it('leaves the previous document intact when the write fails before the rename', async () => {
    const store0 = storeAt();
    const run = await store0.createRun({ epic: 'epic-7' });
    const first = resultFor(run.runId);
    await store0.writeResult(run.runId, first);

    // Aborts inside the try, after the staged file is durable and before the rename.
    const failing = storeAt({
      onFsync: (target) => {
        if (target === 'file') {
          throw new Error('simulated failure before the rename');
        }
      },
    });

    await expect(
      failing.writeResult(run.runId, { ...first, epic: 'epic-9' }),
    ).rejects.toBeInstanceOf(InfraError);

    // The previous document survives, complete, and the debris is gone.
    expect(await readFile(join(run.dir, 'result.json'), 'utf8')).toBe(serializeRunResult(first));
    expect(existsSync(join(run.dir, STAGING))).toBe(false);
  });

  it('overwrites atomically on a second finalize', async () => {
    // Write 1 is the persist stage's crash-durable snapshot; write 2 carries teardown's
    // entry and the real finishedAt. Both go through this method.
    const store = storeAt();
    const run = await store.createRun({ epic: 'epic-7' });
    const snapshot = resultFor(run.runId);
    const complete: RunResult = { ...snapshot, finishedAt: '2026-08-30T14:27:00.000Z' };

    await store.writeResult(run.runId, snapshot);
    await store.writeResult(run.runId, complete);

    expect(await readFile(join(run.dir, 'result.json'), 'utf8')).toBe(
      serializeRunResult(complete),
    );
    expect(existsSync(join(run.dir, STAGING))).toBe(false);
  });
});

describe('readResult returns the document AND the file own bytes (AC2)', () => {
  it('round-trips what writeResult wrote', async () => {
    const store = storeAt();
    const run = await store.createRun({ epic: 'epic-7' });
    const result = resultFor(run.runId);
    await store.writeResult(run.runId, result);

    const stored = await store.readResult(run.runId);

    // The bytes are returned verbatim, NOT re-serialized from the parsed document: zod
    // rebuilds an object in schema declaration order, so a re-serialization would carry
    // the same values with a different byte sequence. `report --json` echoes these.
    expect(stored.text).toBe(serializeRunResult(result));
    expect(stored.document.runId).toBe(run.runId);
    expect(stored.document.schemaVersion).toBe(1);
    expect(stored.path).toBe(join(run.dir, 'result.json'));
  });

  it('raises a classified error naming the path when there is no result', async () => {
    const store = storeAt();
    const run = await store.createRun({ epic: 'epic-7' });

    const error = await store.readResult(run.runId).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(InfraError);
    expect((error as InfraError).message).toContain(run.runId);
  });

  it('raises a classified error for a corrupt document rather than throwing bare', async () => {
    const store = storeAt();
    const run = await store.createRun({ epic: 'epic-7' });
    await writeFile(join(run.dir, 'result.json'), '{ not json', 'utf8');

    const error = await store.readResult(run.runId).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(InfraError);
    expect((error as InfraError).hint).toBeDefined();
  });
});

describe('the finalize does not disturb story 3.2 manifest discipline (AC1)', () => {
  it('leaves the manifest readable and its appends working', async () => {
    // Read 3.2's merged diff before writing this one, and assert nothing broke. Different
    // assertions from that story's own suite — this checks the two disciplines coexist in
    // one run directory, which is a claim neither story makes alone.
    const store = storeAt();
    const run = await store.createRun({ epic: 'epic-7' });

    await store.writeResult(run.runId, resultFor(run.runId));
    await store.recordWorktree(run.runId, '/tmp/specwitness-worktree-abc/head');

    const manifest = await store.readManifest(run.runId);
    expect(manifest.worktrees).toContain('/tmp/specwitness-worktree-abc/head');
    expect(await store.hasResult(run.runId)).toBe(true);
    expect(await exists(join(run.dir, 'manifest.json'))).toBe(true);
  });
});
