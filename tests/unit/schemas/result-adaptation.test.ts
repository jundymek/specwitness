/**
 * Story 5.6, AC1 — the `adapted` marker and its record, persisted and rendered.
 *
 * Two halves, and the second is the one that ages badly if nobody writes it:
 *
 *  - the record round-trips through `serializeRunResult` / `parseRunResult` unchanged;
 *  - **a `result.json` written BEFORE this story still parses.** `SCHEMA_VERSIONS.jsonReport`
 *    is deliberately NOT bumped, following 5.4's `flakiness` and 5.3's reviewer-guidance
 *    fields, because `schemas/versions.ts` states the rule this test enforces: *"a stored run
 *    from last week must stay readable"*. `RunResultDocumentSchema` is `.strict()`, so an
 *    optional key is the only additive shape that keeps that true in both directions.
 */

import { describe, expect, it } from 'vitest';

import type { RunAdaptation } from '../../../src/domain/adaptation.js';
import type { RunResult } from '../../../src/domain/run-result.js';
import { renderJson } from '../../../src/report/json.js';
import {
  parseRunResult,
  serializeRunResult,
  toRunResult,
} from '../../../src/schemas/result.js';
import { SCHEMA_VERSIONS } from '../../../src/schemas/versions.js';
import { fullyPopulatedRunResult } from '../../fixtures/run-result.js';

const ADAPTATION: RunAdaptation = {
  adapted: true,
  applied: [
    {
      criterionId: 'E7-01',
      probeId: 'submit-order',
      field: 'scenario',
      from: { text: 'click "#create-company"', truncated: false, totalBytes: 23 },
      to: { text: 'click "#add-organization"', truncated: false, totalBytes: 25 },
    },
  ],
};

function adaptedRun(adaptation: RunAdaptation): RunResult {
  return { ...fullyPopulatedRunResult(), adaptation };
}

describe('persistence', () => {
  it('round-trips the marker and the record unchanged', () => {
    const result = adaptedRun(ADAPTATION);

    const recovered = toRunResult(parseRunResult(serializeRunResult(result), 'result.json'));

    expect(recovered.adaptation).toEqual(ADAPTATION);
  });

  it('round-trips a REFUSAL, with adapted false and an empty applied list', () => {
    const refused: RunAdaptation = {
      adapted: false,
      applied: [],
      refusal: { text: 'the payload proposed an assertion edit', truncated: false, totalBytes: 37 },
    };

    const recovered = toRunResult(
      parseRunResult(serializeRunResult(adaptedRun(refused)), 'result.json'),
    );

    expect(recovered.adaptation).toEqual(refused);
  });

  it('round-trips an executed-then-DISCARDED change alongside an applied one', () => {
    // `discarded` arrived after this suite was written, so it gets its own round trip rather
    // than being assumed to ride along — the record has four fields and the mirror must
    // carry all four.
    const mixed: RunAdaptation = {
      adapted: true,
      applied: ADAPTATION.applied,
      discarded: [
        {
          criterionId: 'E7-02',
          probeId: 'confirm-order',
          field: 'scenario',
          from: { text: 'click "#confirm"', truncated: false, totalBytes: 16 },
          to: { text: 'click "#no-better"', truncated: false, totalBytes: 18 },
        },
      ],
      refusal: {
        text: "some proposals could not be executed and were not applied: probe 'other'",
        truncated: false,
        totalBytes: 71,
      },
    };

    const recovered = toRunResult(parseRunResult(serializeRunResult(adaptedRun(mixed)), 'r.json'));

    expect(recovered.adaptation).toEqual(mixed);
  });

  it('omits the key entirely on an unadapted run', () => {
    const text = serializeRunResult(fullyPopulatedRunResult());

    // Not `"adaptation": null`, and not an empty object: ABSENT. A reader can tell "this run
    // did not adapt" from "this run adapted nothing" without interpreting a value.
    expect(JSON.parse(text)).not.toHaveProperty('adaptation');
    expect(text).not.toContain('adaptation');
  });

  it('refuses a run marked adapted that records nothing', () => {
    // An announced adaptation with no record is not auditable, and AC1 asks for a record
    // rather than a flag. The schema refuses the combination rather than trusting callers.
    const lying = serializeRunResult(adaptedRun({ adapted: true, applied: [] }));

    expect(() => parseRunResult(lying, 'result.json')).toThrow();
  });

  it('does NOT move jsonReport, and an older result.json still parses', () => {
    expect(SCHEMA_VERSIONS.jsonReport).toBe(1);

    // A stored document from before this story: every key it had, and no `adaptation`.
    const older = JSON.parse(serializeRunResult(fullyPopulatedRunResult())) as Record<
      string,
      unknown
    >;
    delete older['flakiness'];

    expect(() => parseRunResult(`${JSON.stringify(older, null, 2)}\n`, 'old.json')).not.toThrow();
  });

  it('registers its own payload schema without disturbing any other', () => {
    expect(SCHEMA_VERSIONS.adaptation).toBe(1);
    expect(SCHEMA_VERSIONS.plan).toBe(1);
    expect(SCHEMA_VERSIONS.contract).toBe(1);
    expect(SCHEMA_VERSIONS.runManifest).toBe(1);
  });
});

describe('AD-11 — --json and result.json are the same bytes', () => {
  it('renders the adaptation through the one serializer', () => {
    const result = adaptedRun(ADAPTATION);

    // `report/json.ts` is one line and must stay one line: it delegates, so there is exactly
    // one RunResult-to-bytes function in the repository (Q53, Q55).
    expect(renderJson(result)).toBe(serializeRunResult(result));
    expect(renderJson(result)).toContain('"adapted": true');
  });
});
