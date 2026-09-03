/**
 * Story 5.4 — the persisted half of "flakiness is never laundered into clean green".
 *
 * Two obligations meet in `result.json` and this file pins both:
 *
 *  1. AC1's counts must be IN the document, so Epic 7's `scorecard` command — which does
 *     NOT exist yet — can read them without re-running a verification.
 *  2. AD-5's additive evolution: a `result.json` written before this story must still
 *     parse, which is why `SCHEMA_VERSIONS.jsonReport` does not move. The last test in
 *     this file is the one that proves it, and it is the reason the new keys are optional.
 */
import { describe, expect, it } from 'vitest';

import { summarizeFlakiness } from '../../../src/domain/result-counts.js';
import type { DerivedCriterionResult } from '../../../src/domain/criterion-result.js';
import type { RunResult } from '../../../src/domain/run-result.js';
import {
  RUN_RESULT_VERSION,
  parseRunResult,
  serializeRunResult,
  toRunResult,
  toRunResultDocument,
} from '../../../src/schemas/result.js';
import { fullyPopulatedRunResult } from '../../fixtures/run-result.js';

const PATH = '.specwitness/runs/run-x/result.json';

function withCriteria(criteria: readonly DerivedCriterionResult[]): RunResult {
  return { ...fullyPopulatedRunResult(), criteria: [...criteria] };
}

const FLAKY_PASS: DerivedCriterionResult = {
  criterionId: 'E5-01',
  status: 'pass',
  flaky: true,
  statement: 'the health endpoint answers 200',
  severity: 'critical',
  attempts: [
    {
      attempt: 1,
      outcome: 'fail',
      durationMs: 41,
      expected: '200',
      actual: '500',
      evidence: [{ kind: 'http', path: 'probes/http-e5-01-01.response.txt' }],
    },
    {
      attempt: 2,
      outcome: 'pass',
      durationMs: 17,
      evidence: [{ kind: 'http', path: 'probes/http-e5-01-02.response.txt' }],
    },
  ],
};

describe('the per-attempt record survives the round trip', () => {
  it('persists every attempt, with its outcome, duration and evidence', () => {
    const document = JSON.parse(serializeRunResult(withCriteria([FLAKY_PASS]))) as {
      criteria: { attempts: unknown }[];
    };

    expect(document.criteria[0]?.attempts).toEqual(FLAKY_PASS.attempts);
  });

  it("parses back the failed attempt's evidence path, which the pass result itself omits", () => {
    const parsed = parseRunResult(serializeRunResult(withCriteria([FLAKY_PASS])), PATH);
    const criterion = parsed.criteria[0];

    expect(criterion?.evidence).toBeUndefined();
    expect(criterion?.attempts?.[0]?.evidence?.[0]?.path).toBe(
      'probes/http-e5-01-01.response.txt',
    );
  });

  it('rejects an attempt whose evidence path escapes the run directory', () => {
    // The Q48 containment rule reaches the new array too — a document can arrive from a
    // copy or a hand edit, and a constructor's guarantees do not travel with the file.
    const escaping = JSON.parse(serializeRunResult(withCriteria([FLAKY_PASS]))) as Record<
      string,
      unknown
    >;
    const criteria = escaping.criteria as { attempts: { evidence: { path: string }[] }[] }[];
    criteria[0]!.attempts[0]!.evidence[0]!.path = '/etc/passwd';

    expect(() => parseRunResult(JSON.stringify(escaping), PATH)).toThrow();
  });

  it('rejects an attempt numbered zero — the record is 1-based', () => {
    const bad = JSON.parse(serializeRunResult(withCriteria([FLAKY_PASS]))) as Record<
      string,
      unknown
    >;
    (bad.criteria as { attempts: { attempt: number }[] }[])[0]!.attempts[0]!.attempt = 0;

    expect(() => parseRunResult(JSON.stringify(bad), PATH)).toThrow();
  });

  it('rejects `skipped` as an attempt outcome — a criterion can be skipped, an attempt cannot', () => {
    const bad = JSON.parse(serializeRunResult(withCriteria([FLAKY_PASS]))) as Record<
      string,
      unknown
    >;
    (bad.criteria as { attempts: { outcome: string }[] }[])[0]!.attempts[0]!.outcome = 'skipped';

    expect(() => parseRunResult(JSON.stringify(bad), PATH)).toThrow();
  });
});

describe('the run-level flaky counts FR-33 will read (the scorecard COMMAND is Epic 7)', () => {
  it('carries the same three numbers the shared derivation produces', () => {
    const result = withCriteria([FLAKY_PASS]);

    expect(toRunResultDocument(result).flakiness).toEqual(summarizeFlakiness(result.criteria));
  });

  it('reports zeroes rather than omitting the block for a run with no retries', () => {
    // Omitting it would make "no flake" and "this build does not record flake"
    // indistinguishable to a consumer — which is the ambiguity FR-32 exists to remove.
    const clean = withCriteria([
      { criterionId: 'E5-02', status: 'pass', statement: 'clean', severity: 'normal' },
    ]);

    expect(toRunResultDocument(clean).flakiness).toEqual({
      flakyCriteria: 0,
      retriedCriteria: 0,
      extraAttempts: 0,
    });
  });

  it('cannot contradict the criteria array it sits beside', () => {
    const document = JSON.parse(
      serializeRunResult(
        withCriteria([
          FLAKY_PASS,
          { criterionId: 'E5-03', status: 'fail', statement: 'x', severity: 'normal' },
        ]),
      ),
    ) as { criteria: DerivedCriterionResult[]; flakiness: { flakyCriteria: number } };

    expect(document.flakiness.flakyCriteria).toBe(
      document.criteria.filter((criterion) => criterion.flaky === true).length,
    );
  });

  it('is dropped on the way back to the model, not carried onto it', () => {
    const model = toRunResult(toRunResultDocument(withCriteria([FLAKY_PASS])));

    expect('flakiness' in model).toBe(false);
  });
});

describe('AD-5 — the change is additive and last week’s runs stay readable', () => {
  it('does not move the jsonReport schema version', () => {
    // Optional fields are the textbook additive case. `schemas/versions.ts`: "Never
    // renumber and never remove — a stored run from last week must stay readable." The
    // repo's own precedent is commit ec23ce1, which added the optional `hint` key to a
    // .strict() sub-schema of this same document without bumping.
    expect(RUN_RESULT_VERSION).toBe(1);
  });

  it('parses a stored result.json that predates story 5.4', () => {
    // Built by REMOVING the new keys from a current document, so this fixture cannot rot
    // into agreement with the code: it is a genuine pre-5.4 shape every time it runs.
    const document = JSON.parse(serializeRunResult(withCriteria([FLAKY_PASS]))) as Record<
      string,
      unknown
    >;
    delete document.flakiness;
    for (const criterion of document.criteria as Record<string, unknown>[]) {
      delete criterion.attempts;
    }

    const parsed = parseRunResult(JSON.stringify(document), PATH);

    expect(parsed.schemaVersion).toBe(RUN_RESULT_VERSION);
    expect(parsed.flakiness).toBeUndefined();
    expect(parsed.criteria[0]?.attempts).toBeUndefined();
    // And the flaky marker that DID exist before 5.4 still reads, so an old run's flake is
    // not lost by the build that learned to record more about flakes.
    expect(parsed.criteria[0]?.flaky).toBe(true);
  });
});
