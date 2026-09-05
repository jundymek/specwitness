/**
 * Story 6.6 — the attribution record and its ADR-008 §5 line parser.
 *
 * THE SUBJECT OF THIS SUITE IS THE ONE INPUT NO MACHINE MAY SUPPLY. FR-34 classifies a
 * finding as `unique` / `duplicate-of-earlier-gate` / `false-positive`, and that call is
 * a human's. Everything here exists to make sure the record can carry that judgement
 * faithfully and can never be fabricated, defaulted or inferred from anything else.
 *
 * The parser mirrors story 6.5's `parseScorecardLine` deliberately, question for question
 * and in the same order (version ceiling → unknown-keys-only → malformed). Two
 * append-only logs read side by side in one summary must not disagree about what a newer
 * writer looks like.
 *
 * ON THE REDACTION FIXTURES BELOW. They are written as `api_key=<value>` because that is
 * the shape `redactText` actually recognises — a sensitive NAME followed by `:` or `=`
 * (`src/domain/evidence.ts`, `SENSITIVE_SEGMENTS`). A first draft of this suite asserted
 * over a bare opaque token, which `redactText` does not touch at all, and the assertion
 * would have passed for the wrong reason while claiming a guarantee the product does not
 * make. The limit is real and is stated in the module header rather than papered over.
 */

import { describe, expect, it } from 'vitest';

import { UsageError } from '../../../src/domain/errors.js';
import {
  ATTRIBUTION_RECORD_VERSION,
  ATTRIBUTION_VALUES,
  AttributionRecordSchema,
  makeAttributionRecord,
  parseAttributionLine,
  parseAttributionValue,
  serializeAttributionRecord,
  type AttributionRecord,
} from '../../../src/schemas/scorecard-attribution.js';

const PATH = '/tmp/project/.specwitness/attributions.jsonl';

/** Synthetic, and never a real credential — its only job is to be absent afterwards. */
const SECRET_VALUE = 'SW-SYNTHETIC-NOT-A-REAL-SECRET-0001';

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

function built(overrides: { note?: string; attribution?: AttributionRecord['attribution'] } = {}) {
  return makeAttributionRecord({
    runId: 'run-20260904T120000Z-ab12',
    criterionId: 'E6-01',
    attribution: overrides.attribution ?? 'unique',
    recordedAt: '2026-09-05T10:00:00.000Z',
    ...(overrides.note === undefined ? {} : { note: overrides.note }),
  });
}

describe('the attribution vocabulary is closed, and nothing is defaulted', () => {
  it('accepts exactly the three FR-34 judgements', () => {
    expect([...ATTRIBUTION_VALUES]).toEqual(['unique', 'duplicate', 'false-positive']);
  });

  it.each(ATTRIBUTION_VALUES)('accepts %s', (value) => {
    expect(parseAttributionValue(value)).toBe(value);
  });

  it("accepts FR-34's own spelling of the duplicate case as an alias", () => {
    // The PRD writes `duplicate-of-earlier-gate`; AC1's flag list writes `duplicate`.
    // Someone reading either document must not be refused.
    expect(parseAttributionValue('duplicate-of-earlier-gate')).toBe('duplicate');
  });

  it('refuses an unknown judgement with a usage error, rather than defaulting one', () => {
    // ⚠️ THE MOST IMPORTANT ASSERTION IN THIS FILE. A defaulted attribution is a machine
    // supplying human judgement, and if the default were `unique` it would be the most
    // flattering possible lie about this product.
    expect(() => parseAttributionValue('probably-real')).toThrow(UsageError);
    expect(() => parseAttributionValue('')).toThrow(UsageError);
    expect(() => parseAttributionValue('UNIQUE')).toThrow(UsageError);
  });
});

describe('the note is bounded and redacted before it is persisted (AD-10)', () => {
  it('keeps an ordinary note verbatim', () => {
    expect(built({ note: 'the readiness probe never waits for the port' }).note).toBe(
      'the readiness probe never waits for the port',
    );
  });

  it('an assignment-shaped secret pasted into --note is ABSENT from the record', () => {
    // Asserting ABSENCE, never that `[REDACTED]` is present (Epic 3 retro §7): output
    // that carries the marker WITH the secret still beside it survives review in a way a
    // raw leak does not.
    const withSecret = built({ note: `saw api_key=${SECRET_VALUE} in the gate log` });

    expect(withSecret.note).not.toContain(SECRET_VALUE);
    expect(serializeAttributionRecord(withSecret)).not.toContain(SECRET_VALUE);
  });

  it('redacts a header-shaped secret too', () => {
    const withHeader = built({ note: `response had authorization: Bearer ${SECRET_VALUE}` });
    expect(withHeader.note).not.toContain(SECRET_VALUE);
  });

  it('caps a very long note rather than letting one line grow unbounded', () => {
    const long = built({ note: 'x'.repeat(10_000) });
    // The bound is what keeps one append inside the size where O_APPEND stays atomic.
    expect(Buffer.byteLength(long.note ?? '', 'utf8')).toBeLessThanOrEqual(512);
  });

  it('omits the note key entirely when none was given, rather than storing an empty one', () => {
    expect('note' in built({ attribution: 'duplicate' })).toBe(false);
  });
});

describe('serialization is one record, one line', () => {
  it('emits a single newline-terminated line with no indentation', () => {
    const line = serializeAttributionRecord(record());
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd()).not.toContain('\n');
    expect(JSON.parse(line)).toEqual(record());
  });
});

describe('the schema is strict, like every other persisted envelope (ADR-008 §1)', () => {
  it('accepts a well-formed record', () => {
    expect(AttributionRecordSchema.safeParse(record()).success).toBe(true);
  });

  it('rejects an unknown key', () => {
    expect(AttributionRecordSchema.safeParse({ ...record(), extra: 1 }).success).toBe(false);
  });

  it('rejects a missing attribution — there is no default', () => {
    const { attribution: _dropped, ...withoutAttribution } = record();
    expect(AttributionRecordSchema.safeParse(withoutAttribution).success).toBe(false);
  });

  it('rejects an attribution outside the closed vocabulary', () => {
    expect(AttributionRecordSchema.safeParse({ ...record(), attribution: 'unknown' }).success).toBe(
      false,
    );
  });

  it('rejects a non-UTC timestamp', () => {
    expect(
      AttributionRecordSchema.safeParse({ ...record(), recordedAt: '2026-09-05 10:00:00' }).success,
    ).toBe(false);
  });
});

describe('parseAttributionLine — ADR-008 §5, and BOTH directions are distinguishable', () => {
  it('reads a valid line', () => {
    const parsed = parseAttributionLine(JSON.stringify(record()), 1, PATH);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.record.attribution).toBe('unique');
  });

  it('classifies a NEWER schemaVersion as version skew, before it looks at the shape', () => {
    // The ordering is load-bearing, and story 6.5 learned it as a P2: ADR-008 §3 defines
    // a bump as an EXISTING field changing meaning, so a version-2 record can carry
    // exactly the version-1 key set and mean something different by it. No unknown keys,
    // every type valid, and every number computed from it wrong.
    const parsed = parseAttributionLine(
      JSON.stringify({ ...record(), schemaVersion: ATTRIBUTION_RECORD_VERSION + 1 }),
      7,
      PATH,
    );
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.reason).toBe('version-skew');
    expect(!parsed.ok && parsed.message).toContain('line 7');
  });

  it('classifies an unknown-key-only failure as version skew, naming the line and the fields', () => {
    const parsed = parseAttributionLine(JSON.stringify({ ...record(), reviewer: 'ada' }), 4, PATH);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.reason).toBe('version-skew');
    expect(!parsed.ok && parsed.message).toContain('line 4');
    expect(!parsed.ok && parsed.message).toContain('reviewer');
  });

  it('classifies bad JSON as malformed, NOT as an upgrade hint', () => {
    // ⚠️ The half with teeth. A suite covering only the skew direction would let real
    // corruption hide behind a friendly upgrade hint (ADR-008 "Consequences", last
    // bullet).
    const parsed = parseAttributionLine('{"runId": "run-2026', 2, PATH);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.reason).toBe('malformed');
  });

  it('classifies a wrong type as malformed, not as version skew', () => {
    const parsed = parseAttributionLine(JSON.stringify({ ...record(), runId: 42 }), 3, PATH);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.reason).toBe('malformed');
  });

  it('classifies an out-of-vocabulary attribution as malformed', () => {
    const parsed = parseAttributionLine(
      JSON.stringify({ ...record(), attribution: 'maybe' }),
      5,
      PATH,
    );
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.reason).toBe('malformed');
  });

  it('never throws, whatever the line contains', () => {
    for (const line of ['', 'null', '[]', '"text"', '{', ' ', '0']) {
      expect(() => parseAttributionLine(line, 1, PATH)).not.toThrow();
    }
  });

  it('never echoes a rejected value from the file into its warning', () => {
    // The attributions file is pasted into issues just as the scorecard is. A warning
    // about it must not become the leak. Paths and codes only — never `issue.message`,
    // which some zod messages render with the offending value inside them.
    const bad = parseAttributionLine(
      JSON.stringify({ ...record(), recordedAt: `api_key=${SECRET_VALUE}` }),
      1,
      PATH,
    );
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.message).not.toContain(SECRET_VALUE);
  });
});
