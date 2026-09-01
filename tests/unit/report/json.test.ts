/**
 * The JSON renderer suite (AC2, AC3).
 *
 * The load-bearing assertion here is byte-equality against the bytes that were
 * actually written to disk — not against a re-serialization. Comparing
 * `renderJson(r)` to `serializeRunResult(r)` would only prove the serializer is
 * deterministic, which is the easy half: it would still pass if the finalize
 * path appended, truncated or re-encoded on the way to the file, and that is
 * precisely the failure a harness that diffs or hashes the document would hit.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RunStore } from '../../../src/infra/run-store.js';
import { renderJson } from '../../../src/report/json.js';
import { FixedClock, SequenceIds } from '../../fakes/ports.js';
import { ENVIRONMENT, RUN_ID, criterion, gate, runResult, truncatedGateEvidence } from './helpers.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'specwitness-report-json-'));
  temporaryRoots.push(root);
  return root;
}

describe('the JSON report', () => {
  it('is parseable and carries a schemaVersion', () => {
    // The version is contributed by the serializer, not by this renderer:
    // `RunResult` is deliberately version-free because the version belongs to
    // the persisted document, not to the in-memory model (AD-5).
    const document: unknown = JSON.parse(renderJson(runResult()));

    expect(document).toMatchObject({ runId: RUN_ID });
    expect((document as { schemaVersion?: number }).schemaVersion).toBeTypeOf('number');
  });

  it('is byte-equal to the persisted result.json', async () => {
    // AC2, asserted against real persisted bytes. `toEqual` on the whole
    // string, never `toContain`: one extra byte anywhere breaks `JSON.parse`
    // for every consumer, and a substring assertion would not notice.
    const root = await projectRoot();
    // `createRun` MINTS the id from the injected clock and ids rather than
    // taking one, so the fixture is built around what it returns. Fakes rather
    // than the real clock: the persisted document must be reproducible, and a
    // run id containing the wall-clock second is not (AD-9).
    const store = new RunStore(root, new FixedClock('2026-08-31T14:25:01Z'), new SequenceIds('a3f9'));
    const created = await store.createRun({ epic: 'epic-3' });

    const result = runResult({
      runId: created.runId,
      environment: { ...ENVIRONMENT, runDirectory: `.specwitness/runs/${created.runId}` },
      outcome: { verdict: 'FAIL', gateFailed: 'test' },
      gates: [gate('test', 'fail')],
      criteria: [criterion('E3-01', 'fail', { expected: 'HTTP 402', actual: 'HTTP 500' })],
      evidence: [truncatedGateEvidence('test')],
    });

    await store.writeResult(created.runId, result);

    const persisted = await readFile(join(created.dir, 'result.json'), 'utf8');

    expect(renderJson(result)).toEqual(persisted);
  });

  it('renders the same RunResult byte-identically twice', () => {
    // No clock, no randomness — so a snapshot or a hash of this document means
    // something. A renderer that read the wall clock would produce a different
    // document every call and quietly defeat every downstream cache.
    const result = runResult();

    expect(renderJson(result)).toBe(renderJson(result));
  });

  it('carries only relative evidence paths', () => {
    // Q48: a run directory stays readable after being copied between machines,
    // so every pointer inside the document is relative to the run root. An
    // absolute path here is a bug, not a preference.
    const result = runResult({ evidence: [truncatedGateEvidence('test')] });
    const document = JSON.parse(renderJson(result)) as Record<string, unknown>;

    const paths = JSON.stringify(document).match(/"(?:fullPath|path)":"([^"]*)"/g) ?? [];
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path).not.toMatch(/":"\//);
    }
  });

  it('adds nothing of its own — not even a newline', () => {
    // The trailing newline belongs to the serializer. If this renderer added
    // one, `--json` output and the persisted file would differ by exactly one
    // byte: the hardest kind of drift to notice and the easiest to introduce.
    const result = runResult();

    expect(renderJson(result).endsWith('\n')).toBe(true);
    expect(renderJson(result).endsWith('\n\n')).toBe(false);
  });
});
