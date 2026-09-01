import { describe, expect, it } from 'vitest';

import {
  countCriterionStatuses,
  countFlaky,
  countGateStatuses,
} from '../../../src/domain/result-counts.js';
import type { DerivedCriterionResult } from '../../../src/domain/criterion-result.js';
import type { GateResult } from '../../../src/domain/result.js';

function criterion(
  criterionId: string,
  status: DerivedCriterionResult['status'],
  flaky?: boolean,
): DerivedCriterionResult {
  return {
    criterionId,
    status,
    statement: `statement for ${criterionId}`,
    severity: 'normal',
    ...(flaky === undefined ? {} : { flaky }),
  };
}

/**
 * These exist so the terminal report and the JSON document cannot disagree about a
 * number. Both views call this; neither sums an array of its own. That is AD-11 applied
 * to counts — and deliberately NOT a stored field on `RunResult`, because a persisted
 * count sitting beside the array it counts is a second source of truth that can drift
 * from it, while a derived one cannot.
 */
describe('countCriterionStatuses', () => {
  it('returns every status key, zero-valued when unseen', () => {
    // No `undefined` in a count: a renderer that has to write `?? 0` will eventually
    // forget to, and print nothing where it meant to print zero.
    expect(countCriterionStatuses([])).toEqual({
      pass: 0,
      fail: 0,
      needs_human: 0,
      skipped: 0,
      error: 0,
    });
  });

  it('counts a mixed run', () => {
    const counts = countCriterionStatuses([
      criterion('E3-01', 'pass'),
      criterion('E3-02', 'pass', true),
      criterion('E3-03', 'fail'),
      criterion('E3-04', 'skipped'),
      criterion('E3-05', 'needs_human'),
      criterion('E3-06', 'error'),
    ]);

    expect(counts).toEqual({ pass: 2, fail: 1, needs_human: 1, skipped: 1, error: 1 });
  });

  it('counts a flaky pass as a pass — it is one (FR-32)', () => {
    expect(countCriterionStatuses([criterion('E3-01', 'pass', true)]).pass).toBe(1);
  });

  it('counts the all-skipped gates-only run', () => {
    const counts = countCriterionStatuses([
      criterion('E3-01', 'skipped'),
      criterion('E3-02', 'skipped'),
    ]);

    expect(counts.skipped).toBe(2);
    expect(counts.pass).toBe(0);
  });
});

describe('countGateStatuses', () => {
  it('returns every gate status key, zero-valued when unseen', () => {
    expect(countGateStatuses([])).toEqual({ pass: 0, fail: 0, skipped: 0 });
  });

  it('counts an early-stopped gate run', () => {
    const gates: readonly GateResult[] = [
      { gateId: 'install', status: 'pass', durationMs: 900 },
      { gateId: 'lint', status: 'fail', durationMs: 120 },
      { gateId: 'build', status: 'skipped' },
    ];

    expect(countGateStatuses(gates)).toEqual({ pass: 1, fail: 1, skipped: 1 });
  });
});

describe('countFlaky', () => {
  it('counts only criteria that passed on retry', () => {
    const count = countFlaky([
      criterion('E3-01', 'pass'),
      criterion('E3-02', 'pass', true),
      criterion('E3-03', 'pass', true),
      criterion('E3-04', 'fail'),
    ]);

    expect(count).toBe(2);
  });

  it('is zero when nothing was flaky', () => {
    expect(countFlaky([criterion('E3-01', 'pass')])).toBe(0);
  });
});
