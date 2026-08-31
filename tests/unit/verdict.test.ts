import { describe, expect, it } from 'vitest';

import type { CriterionResult, GateResult } from '../../src/domain/result.js';
import { aggregate } from '../../src/domain/verdict.js';

const gate = (gateId: string, status: GateResult['status']): GateResult => ({ gateId, status });
const crit = (
  criterionId: string,
  status: CriterionResult['status'],
  flaky?: boolean,
): CriterionResult => (flaky === undefined ? { criterionId, status } : { criterionId, status, flaky });

describe('aggregate — precedence rules (AD-6)', () => {
  it('returns PASS for a run with no gates and no criteria', () => {
    expect(aggregate([], [])).toEqual({ verdict: 'PASS' });
  });

  it('returns PASS for a gates-only green run with zero criteria (Epic 3 gates-only mode)', () => {
    expect(aggregate([gate('lint', 'pass'), gate('build', 'pass')], [])).toEqual({ verdict: 'PASS' });
  });

  it('returns PASS when every criterion passes', () => {
    expect(aggregate([gate('lint', 'pass')], [crit('E1-01', 'pass'), crit('E1-02', 'pass')])).toEqual({
      verdict: 'PASS',
    });
  });

  it('returns FAIL with the failing gate id when a gate fails', () => {
    expect(aggregate([gate('lint', 'pass'), gate('build', 'fail')], [])).toEqual({
      verdict: 'FAIL',
      gateFailed: 'build',
    });
  });

  it('lets a failed gate outrank every criterion status, including all-pass criteria', () => {
    const criteria = [crit('E1-01', 'pass'), crit('E1-02', 'needs_human'), crit('E1-03', 'error')];
    expect(aggregate([gate('build', 'fail')], criteria)).toEqual({ verdict: 'FAIL', gateFailed: 'build' });
  });

  it('reports the first failing gate when several gates fail', () => {
    expect(aggregate([gate('lint', 'fail'), gate('build', 'fail')], [])).toEqual({
      verdict: 'FAIL',
      gateFailed: 'lint',
    });
  });

  it('ignores skipped gates', () => {
    expect(aggregate([gate('lint', 'pass'), gate('build', 'skipped')], [crit('E1-01', 'pass')])).toEqual({
      verdict: 'PASS',
    });
  });

  it('returns FAIL when any criterion fails', () => {
    expect(aggregate([gate('lint', 'pass')], [crit('E1-01', 'pass'), crit('E1-02', 'fail')])).toEqual({
      verdict: 'FAIL',
    });
  });

  it('does not attach gateFailed to a criterion-driven FAIL', () => {
    const outcome = aggregate([gate('lint', 'pass')], [crit('E1-01', 'fail')]);
    expect(outcome).not.toHaveProperty('gateFailed');
  });

  it('lets fail outrank error — fail evidence outranks infra uncertainty (PRD §9)', () => {
    expect(aggregate([], [crit('E1-01', 'error'), crit('E1-02', 'fail')])).toEqual({ verdict: 'FAIL' });
  });

  it('lets fail outrank needs_human', () => {
    expect(aggregate([], [crit('E1-01', 'needs_human'), crit('E1-02', 'fail')])).toEqual({ verdict: 'FAIL' });
  });

  it('returns an infra error when any criterion errors and none fail', () => {
    expect(aggregate([], [crit('E1-01', 'pass'), crit('E1-02', 'error')])).toEqual({ infraError: 'infra' });
  });

  it('lets error outrank needs_human', () => {
    expect(aggregate([], [crit('E1-01', 'needs_human'), crit('E1-02', 'error')])).toEqual({
      infraError: 'infra',
    });
  });

  it('returns NEEDS_HUMAN when any criterion needs a human and none fail or error', () => {
    expect(aggregate([], [crit('E1-01', 'pass'), crit('E1-02', 'needs_human')])).toEqual({
      verdict: 'NEEDS_HUMAN',
    });
  });

  it('treats skipped criteria as inert', () => {
    expect(aggregate([gate('lint', 'pass')], [crit('E1-01', 'skipped'), crit('E1-02', 'skipped')])).toEqual({
      verdict: 'PASS',
    });
    expect(aggregate([], [crit('E1-01', 'skipped'), crit('E1-02', 'needs_human')])).toEqual({
      verdict: 'NEEDS_HUMAN',
    });
  });

  it('does not let the flaky marker change the verdict', () => {
    expect(aggregate([], [crit('E1-01', 'pass', true)])).toEqual({ verdict: 'PASS' });
    expect(aggregate([], [crit('E1-01', 'fail', true)])).toEqual({ verdict: 'FAIL' });
  });
});

describe('aggregate — mutual exclusivity of the run-outcome union (AD-6)', () => {
  it('never returns both a verdict and an infraError', () => {
    const outcomes = [
      aggregate([], []),
      aggregate([gate('build', 'fail')], []),
      aggregate([], [crit('E1-01', 'fail')]),
      aggregate([], [crit('E1-01', 'error')]),
      aggregate([], [crit('E1-01', 'needs_human')]),
    ];
    for (const outcome of outcomes) {
      const hasVerdict = 'verdict' in outcome && outcome.verdict !== undefined;
      const hasInfra = 'infraError' in outcome && outcome.infraError !== undefined;
      expect(hasVerdict).not.toBe(hasInfra);
    }
  });
});

describe('aggregate — purity and totality', () => {
  it('does not mutate its inputs', () => {
    const gates = [gate('build', 'fail')];
    const criteria = [crit('E1-01', 'fail')];
    const gatesCopy = structuredClone(gates);
    const criteriaCopy = structuredClone(criteria);
    aggregate(gates, criteria);
    expect(gates).toEqual(gatesCopy);
    expect(criteria).toEqual(criteriaCopy);
  });

  it('is deterministic across repeated calls', () => {
    const gates = [gate('lint', 'pass')];
    const criteria = [crit('E1-01', 'needs_human')];
    expect(aggregate(gates, criteria)).toEqual(aggregate(gates, criteria));
  });
});
