import { describe, expect, it } from 'vitest';

import { evidenceRef } from '../../../src/domain/evidence.js';
import { PROBE_SURFACES, deriveCriterionResult } from '../../../src/domain/criterion-result.js';
import type {
  ContractCriterionRef,
  ProbeAttempt,
} from '../../../src/domain/criterion-result.js';

const CRITERION: ContractCriterionRef = {
  criterionId: 'E3-01',
  statement: 'the health endpoint answers 200 within one second',
  severity: 'critical',
};

function attempt(overrides: Partial<ProbeAttempt> = {}): ProbeAttempt {
  return {
    attempt: 1,
    observations: [],
    assertionEvaluations: [{ description: 'status is 200', satisfied: true }],
    evidence: [],
    durationMs: 10,
    ...overrides,
  };
}

describe('PROBE_SURFACES', () => {
  it('is the four AD-13 surfaces', () => {
    expect([...PROBE_SURFACES]).toEqual(['http', 'browser', 'observation', 'shell']);
  });
});

describe('deriveCriterionResult — AD-13, the single producer of a CriterionStatus', () => {
  it('is `skipped` with zero attempts — the gates-only run every criterion takes', () => {
    const result = deriveCriterionResult(CRITERION, []);

    expect(result.status).toBe('skipped');
    expect(result.criterionId).toBe('E3-01');
    // Carried through so a renderer can print the criterion without re-reading the
    // contract (AD-11). This is FR-29's "one-line summary".
    expect(result.statement).toBe(CRITERION.statement);
    expect(result.severity).toBe('critical');
    expect(result.flaky).toBeUndefined();
    expect(result.expected).toBeUndefined();
    expect(result.actual).toBeUndefined();
  });

  it('is `pass` when every assertion on the final attempt held', () => {
    const result = deriveCriterionResult(CRITERION, [attempt()]);

    expect(result.status).toBe('pass');
    expect(result.flaky).toBeUndefined();
  });

  it('is `fail` when any assertion on the final attempt did not hold', () => {
    const result = deriveCriterionResult(CRITERION, [
      attempt({
        assertionEvaluations: [
          { description: 'status is 200', satisfied: true },
          { description: 'body contains ok', satisfied: false, expected: 'ok', actual: 'ERR' },
        ],
        evidence: [evidenceRef('http', 'evidence/E3-01.json')],
      }),
    ]);

    expect(result.status).toBe('fail');
    // FR-28: every non-pass result carries expected vs actual plus >= 1 evidence ref.
    expect(result.expected).toBe('ok');
    expect(result.actual).toBe('ERR');
    expect(result.evidence).toHaveLength(1);
  });

  it('is `error` when the final attempt could not observe at all — infra, never a product FAIL', () => {
    const result = deriveCriterionResult(CRITERION, [
      attempt({
        assertionEvaluations: [],
        execError: { message: 'connection refused' },
        evidence: [evidenceRef('http', 'evidence/E3-01.json')],
      }),
    ]);

    // `error` is the status aggregation turns into `{infraError}` (exit 3), which is the
    // whole reason a probe that could not look is not the same as one that looked and
    // saw a violation.
    expect(result.status).toBe('error');
    expect(result.actual).toBe('connection refused');
  });

  it('prefers the exec error over assertions on the same attempt', () => {
    // If the probe blew up, whatever assertions it managed to evaluate were evaluated
    // against a broken observation. Reporting `fail` from them would be product evidence
    // manufactured from an infrastructure failure.
    const result = deriveCriterionResult(CRITERION, [
      attempt({
        assertionEvaluations: [{ description: 'status is 200', satisfied: false }],
        execError: { message: 'browser crashed' },
      }),
    ]);

    expect(result.status).toBe('error');
  });

  it('is `needs_human` when nothing was adjudicated mechanically', () => {
    // Zero assertions and no error means nothing was actually checked. Calling that
    // `pass` would mint a PASS out of nothing, which is the one direction this product
    // must never fail in.
    const result = deriveCriterionResult(CRITERION, [
      attempt({ assertionEvaluations: [], evidence: [] }),
    ]);

    expect(result.status).toBe('needs_human');
  });

  it('marks a pass that only happened on retry as flaky (FR-32)', () => {
    const result = deriveCriterionResult(CRITERION, [
      attempt({
        attempt: 1,
        assertionEvaluations: [{ description: 'status is 200', satisfied: false }],
      }),
      attempt({ attempt: 2 }),
    ]);

    // Recorded, never silently converted into a clean pass — and it does not change the
    // verdict: aggregation treats a flaky pass as a pass.
    expect(result.status).toBe('pass');
    expect(result.flaky).toBe(true);
  });

  it('marks a pass after an errored attempt as flaky too', () => {
    const result = deriveCriterionResult(CRITERION, [
      attempt({ attempt: 1, execError: { message: 'timeout' } }),
      attempt({ attempt: 2 }),
    ]);

    expect(result.status).toBe('pass');
    expect(result.flaky).toBe(true);
  });

  it('does not mark a fail after a passing attempt as flaky', () => {
    // `flaky` means FR-32's "passed only on retry". A run that passed and then failed is
    // simply a failure; calling it flaky would soften a real defect into noise.
    const result = deriveCriterionResult(CRITERION, [
      attempt({ attempt: 1 }),
      attempt({
        attempt: 2,
        assertionEvaluations: [{ description: 'status is 200', satisfied: false }],
      }),
    ]);

    expect(result.status).toBe('fail');
    expect(result.flaky).toBeUndefined();
  });

  it('lets the FINAL attempt decide, which is what makes a retry mean anything', () => {
    const result = deriveCriterionResult(CRITERION, [
      attempt({ attempt: 1 }),
      attempt({ attempt: 2 }),
      attempt({
        attempt: 3,
        assertionEvaluations: [{ description: 'status is 200', satisfied: false }],
      }),
    ]);

    expect(result.status).toBe('fail');
  });

  it('never returns a status outside the merged closed taxonomy', () => {
    const cases: readonly ProbeAttempt[][] = [
      [],
      [attempt()],
      [attempt({ assertionEvaluations: [{ description: 'x', satisfied: false }] })],
      [attempt({ execError: { message: 'boom' } })],
      [attempt({ assertionEvaluations: [] })],
    ];

    for (const attempts of cases) {
      expect(['pass', 'fail', 'needs_human', 'skipped', 'error']).toContain(
        deriveCriterionResult(CRITERION, attempts).status,
      );
    }
  });
});
