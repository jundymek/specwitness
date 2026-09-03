/**
 * Story 3.5 AC1/AC3 — the persisted `result.json` schema and THE serializer.
 *
 * Two properties carry this story and both are asserted here rather than described:
 *
 *  - **One serialization.** `serializeRunResult` is the only `RunResult` → bytes function
 *    in the repository. `RunStore` persists with it and `src/report/json.ts` renders
 *    `--json` with it, so the harness contract's promise that the two are the same bytes
 *    (Q53) is structural rather than a coincidence two code paths keep agreeing on.
 *  - **Relative evidence paths (Q48).** An absolute path in a persisted document is a bug,
 *    not a preference: it stops the run directory being portable, silently, and only when
 *    somebody copies it. The schema rejects one on READ as well, because a document can
 *    arrive from a copy or a hand edit and a constructor's guarantees do not travel with
 *    the file.
 */

import { describe, expect, it } from 'vitest';

import { InfraError } from '../../../src/domain/errors.js';
import {
  RUN_RESULT_VERSION,
  parseRunResult,
  serializeRunResult,
  toRunResult,
  toRunResultDocument,
} from '../../../src/schemas/result.js';
import { SCHEMA_VERSIONS } from '../../../src/schemas/versions.js';
import { SEEDED_SECRET, fullyPopulatedRunResult } from '../../fixtures/run-result.js';

const PATH = '/tmp/project/.specwitness/runs/run-20260830T142501Z-a3f9/result.json';

/** The fixture, serialized and parsed back into a plain object. */
function roundTrip(): Record<string, unknown> {
  return JSON.parse(serializeRunResult(fullyPopulatedRunResult())) as Record<string, unknown>;
}

describe('the schema version (AC1)', () => {
  it('is the registered jsonReport version, not a local literal', () => {
    expect(RUN_RESULT_VERSION).toBe(SCHEMA_VERSIONS.jsonReport);
    expect(RUN_RESULT_VERSION).toBe(1);
  });

  it('does not disturb runManifest', () => {
    // A runManifest bump would make every existing manifest unreadable, including the
    // ones a crashed run leaves for `clean` — precisely when readability matters.
    expect(SCHEMA_VERSIONS.runManifest).toBe(1);
  });

  it('is the first key of the document', () => {
    // Before the shape, so a reader that cannot understand the rest can still say why.
    expect(Object.keys(toRunResultDocument(fullyPopulatedRunResult()))[0]).toBe('schemaVersion');
  });
});

describe('serializeRunResult — the one byte sequence (AC1)', () => {
  it('is stable across calls', () => {
    const once = serializeRunResult(fullyPopulatedRunResult());
    const twice = serializeRunResult(fullyPopulatedRunResult());

    expect(once).toBe(twice);
  });

  it('uses two-space indentation and exactly one trailing newline', () => {
    const text = serializeRunResult(fullyPopulatedRunResult());

    expect(text.endsWith('}\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(text).toContain('\n  "runId"');
  });

  it('emits keys in construction order, not alphabetically', () => {
    // The order IS the byte sequence: chuck's byte-equality test and every stored document
    // depend on it, so it is pinned rather than left to whatever the engine does.
    expect(Object.keys(roundTrip())).toEqual([
      'schemaVersion',
      'runId',
      'epic',
      'baseSha',
      'headSha',
      'startedAt',
      'finishedAt',
      'outcome',
      'stages',
      'gates',
      'criteria',
      // Story 5.4's run-level retry/flake counts, placed immediately after the array they
      // are derived from so a reader meets the summary where the data is.
      'flakiness',
      'evidence',
      'providerUsage',
      'environment',
      'contract',
    ]);
  });

  it('omits an absent optional rather than writing null', () => {
    const { contract: _dropped, ...withoutContract } = fullyPopulatedRunResult();

    const text = serializeRunResult(withoutContract);

    // "this run had no contract" and "the contract was null" must stay distinguishable,
    // so the key is absent rather than present-and-null.
    expect(Object.keys(JSON.parse(text) as object)).not.toContain('contract');
    expect(text).not.toContain('"contract"');
  });

  it('preserves every value through a parse round trip', () => {
    const text = serializeRunResult(fullyPopulatedRunResult());

    const parsed = parseRunResult(text, PATH);

    expect(parsed).toEqual(JSON.parse(text));
  });

  it('does NOT reproduce the file when a PARSED document is re-serialized', () => {
    // Recorded as a test rather than a comment, because it constrains `report --json`.
    //
    // zod rebuilds a validated object in SCHEMA DECLARATION order, which is not the order
    // the domain's evidence constructors build their members in. Values survive intact —
    // the round-trip test above proves that — but the BYTES do not.
    //
    // Hence `report --json` validates the stored document and then writes the file's own
    // bytes, rather than re-serializing what it parsed. That makes byte-equality true by
    // construction instead of true only while two independent key orderings happen to
    // agree. If someone later "simplifies" report to re-serialize, this test explains
    // what breaks and why it was not done that way.
    const text = serializeRunResult(fullyPopulatedRunResult());
    const parsed = parseRunResult(text, PATH);

    const reSerialized = `${JSON.stringify(parsed, null, 2)}\n`;

    expect(reSerialized).not.toBe(text);
    expect(JSON.parse(reSerialized)).toEqual(JSON.parse(text));
  });
});

describe('toRunResult is the exact inverse of toRunResultDocument (AC1)', () => {
  it('round-trips the model unchanged', () => {
    const original = fullyPopulatedRunResult();

    expect(toRunResult(toRunResultDocument(original))).toEqual(original);
  });

  it('drops the document-only keys and nothing else', () => {
    // The keys the document adds. If it ever dropped one MORE than these, a renderer would
    // be handed a model missing a fact and AD-11 would be violated silently.
    //
    // `flakiness` joined `schemaVersion` in story 5.4 and is dropped for the opposite
    // reason to being carried: it is DERIVED from `criteria`, and a model that stored it
    // would be the second source of truth `domain/result-counts.ts` refuses. A renderer
    // handed the recovered model recomputes the same three numbers.
    const documentOnly = ['schemaVersion', 'flakiness'];
    const document = toRunResultDocument(fullyPopulatedRunResult());

    const model = toRunResult(document) as unknown as Record<string, unknown>;

    expect(Object.keys(model)).toEqual(
      Object.keys(document).filter((key) => !documentOnly.includes(key)),
    );
  });

  it('recovers the model faithfully from a document read back off the wire', () => {
    // The realistic path: `report` parses a stored file and hands the model to a renderer.
    // Every VALUE survives, which is all a renderer needs.
    const original = fullyPopulatedRunResult();
    const parsed = parseRunResult(serializeRunResult(original), PATH);

    expect(toRunResult(parsed)).toEqual(original);
  });

  it('but re-serializing the recovered model does NOT reproduce the file bytes', () => {
    // The same zod key-order property, reached through `toRunResult` — recorded here
    // because this is the path someone would take if they "simplified" `report --json`
    // into parse → toRunResult → serialize. It yields a document with identical values
    // and a different byte sequence, and story 3.7's end-to-end byte-equality assertion
    // is what would fail. Echoing the stored bytes is what avoids it.
    const original = fullyPopulatedRunResult();
    const text = serializeRunResult(original);
    const recovered = serializeRunResult(toRunResult(parseRunResult(text, PATH)));

    expect(recovered).not.toBe(text);
    expect(JSON.parse(recovered)).toEqual(JSON.parse(text));
  });
});

describe('the persisted document carries no credential (AC1, AD-10)', () => {
  it('does not contain the seeded secret anywhere', () => {
    // Redaction happens at capture, in pamela's constructors. This asserts the property
    // THIS story owns: nothing between the model and the bytes puts it back.
    const text = serializeRunResult(fullyPopulatedRunResult());

    expect(text).not.toContain(SEEDED_SECRET);
    expect(text).toContain('[REDACTED]');
  });
});

describe('evidence paths are relative (AC1, Q48)', () => {
  it('rejects an absolute path in an evidence ref', () => {
    const document = roundTrip();
    const criteria = document['criteria'] as { evidence?: { path: string }[] }[];
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    criteria[2]!.evidence![0]!.path = '/etc/passwd';

    expect(() => parseRunResult(JSON.stringify(document), PATH)).toThrow(InfraError);
  });

  it('rejects an absolute path in a bounded-text pointer', () => {
    const document = roundTrip();
    const evidence = document['evidence'] as Record<string, unknown>[];
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    evidence[0]!['stdout'] = {
      text: 'x',
      truncated: true,
      totalBytes: 9,
      fullPath: '/var/log/out',
    };

    expect(() => parseRunResult(JSON.stringify(document), PATH)).toThrow(InfraError);
  });

  it('rejects a Windows absolute path, which a leading-slash check would allow', () => {
    const document = roundTrip();
    const criteria = document['criteria'] as { evidence?: { path: string }[] }[];
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    criteria[2]!.evidence![0]!.path = 'C:\\Users\\me\\out.txt';

    expect(() => parseRunResult(JSON.stringify(document), PATH)).toThrow(InfraError);
  });

  it('rejects a path that escapes the run directory with ..', () => {
    const document = roundTrip();
    const criteria = document['criteria'] as { evidence?: { path: string }[] }[];
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    criteria[2]!.evidence![0]!.path = '../../../etc/passwd';

    expect(() => parseRunResult(JSON.stringify(document), PATH)).toThrow(InfraError);
  });

  it('ACCEPTS the absolute worktreePath — it is provenance, not a pointer', () => {
    // The exception that proves the rule. worktreePath records where the run happened, on
    // that machine, at that time; the directory is normally gone by the time anyone reads
    // the result. Making it relative would not make the document portable, it would make
    // it wrong. Asserted so nobody "fixes" it in either direction.
    const document = roundTrip();
    const environment = document['environment'] as { worktreePath: string };

    expect(environment.worktreePath.startsWith('/')).toBe(true);
    expect(() => parseRunResult(JSON.stringify(document), PATH)).not.toThrow();
  });
});

describe('parseRunResult always throws a classified error naming the path (AC1)', () => {
  it('classifies malformed JSON rather than throwing bare', () => {
    let thrown: unknown;
    try {
      parseRunResult('{ not json', PATH);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(InfraError);
    expect((thrown as InfraError).message).toContain(PATH);
    expect((thrown as InfraError).hint).toBeDefined();
  });

  it('tells the operator to upgrade when the document is from a newer specwitness', () => {
    // Read the version BEFORE the shape, or a document from the future produces a
    // confusing list of shape errors about fields this build has never heard of.
    const document = { ...roundTrip(), schemaVersion: RUN_RESULT_VERSION + 1, somethingNew: true };

    let thrown: unknown;
    try {
      parseRunResult(JSON.stringify(document), PATH);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(InfraError);
    expect((thrown as InfraError).message).toMatch(/newer specwitness/i);
    expect((thrown as InfraError).hint).toMatch(/upgrade/i);
    // It must NOT read as a shape complaint about the unknown key.
    expect((thrown as InfraError).message).not.toMatch(/somethingNew/);
  });

  it('rejects an unknown key (.strict)', () => {
    // An unknown key means a newer writer added something. Dropping it silently would let
    // a reader act on a partial view of a run it believes it has read completely.
    const document = { ...roundTrip(), unexpected: 'value' };

    expect(() => parseRunResult(JSON.stringify(document), PATH)).toThrow(InfraError);
  });

  it('rejects an outcome carrying both a verdict and an infraError', () => {
    // AD-6's central exclusivity: an infra failure is never reported as a product FAIL.
    // The domain type makes this a compile error; the schema must make it a read error.
    const document = { ...roundTrip(), outcome: { verdict: 'FAIL', infraError: 'infra' } };

    expect(() => parseRunResult(JSON.stringify(document), PATH)).toThrow(InfraError);
  });

  it('rejects a gateFailed that is a boolean rather than a gate id', () => {
    // ADR-003's prose says boolean; the merged run-outcome.ts says string. The code wins,
    // and this is what makes a regression to the prose visible.
    const document = { ...roundTrip(), outcome: { verdict: 'FAIL', gateFailed: true } };

    expect(() => parseRunResult(JSON.stringify(document), PATH)).toThrow(InfraError);
  });

  it('rejects a stage name outside the frozen eleven', () => {
    const document = roundTrip();
    const stages = document['stages'] as { stage: string }[];
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    stages[0]!.stage = 'deploy';

    expect(() => parseRunResult(JSON.stringify(document), PATH)).toThrow(InfraError);
  });

  it('rejects a bounded-text pointer on content that was not truncated', () => {
    // A pointer on untruncated content sends a reader to a file that was never written.
    const document = roundTrip();
    const evidence = document['evidence'] as Record<string, unknown>[];
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    evidence[0]!['stdout'] = {
      text: 'x',
      truncated: false,
      totalBytes: 1,
      fullPath: 'evidence/gate-lint.stdout.txt',
    };

    expect(() => parseRunResult(JSON.stringify(document), PATH)).toThrow(InfraError);
  });

  it('names the offending field so the error is actionable', () => {
    const document = roundTrip();
    const environment = document['environment'] as Record<string, unknown>;
    delete environment['nodeVersion'];

    let thrown: unknown;
    try {
      parseRunResult(JSON.stringify(document), PATH);
    } catch (err) {
      thrown = err;
    }

    expect((thrown as InfraError).message).toContain('environment.nodeVersion');
  });
});

describe('every evidence kind and every status arm survives the round trip (AC3)', () => {
  it('keeps all six evidence kinds', () => {
    const evidence = roundTrip()['evidence'] as { kind: string }[];

    expect(evidence.map((entry) => entry.kind)).toEqual([
      'gate',
      'command',
      'provider',
      'http',
      'observation',
      'browser',
    ]);
  });

  it('keeps all eleven stages, including the skipped ones', () => {
    const stages = roundTrip()['stages'] as { stage: string; status: string }[];

    expect(stages).toHaveLength(11);
    expect(new Set(stages.map((s) => s.status))).toEqual(
      new Set(['ok', 'failed', 'error', 'skipped']),
    );
  });

  it('keeps a flaky pass visibly flaky (FR-32)', () => {
    const criteria = roundTrip()['criteria'] as { status: string; flaky?: boolean }[];
    const flaky = criteria.filter((c) => c.flaky === true);

    expect(flaky).toHaveLength(1);
    expect(flaky[0]?.status).toBe('pass');
  });

  it('keeps one criterion of every status', () => {
    const criteria = roundTrip()['criteria'] as { status: string }[];

    expect(new Set(criteria.map((c) => c.status))).toEqual(
      new Set(['pass', 'fail', 'needs_human', 'skipped', 'error']),
    );
  });
});
