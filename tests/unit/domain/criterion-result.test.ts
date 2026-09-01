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
  verifiability: 'automated',
};

/** The same criterion, but one only a person may adjudicate (Q39). */
const HUMAN_CRITERION: ContractCriterionRef = {
  criterionId: 'E3-09',
  statement: 'the error copy reads as a human wrote it',
  severity: 'normal',
  verifiability: 'human',
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

describe('redaction of criterion diagnostics (Codex review, P1)', () => {
  // `expected` and `actual` are copied from what a surface OBSERVED — a response body, a
  // command's output, an exec error's message — and they are persisted to result.json and
  // printed to a terminal exactly like evidence is. Before this they were the one path by
  // which a captured credential reached a stored run unredacted, sitting right beside the
  // evidence fields that were protected.
  const SEEDED = `API_TOKEN=${['sk', 'live'].join('-')}-criterionleak`;

  it('redacts expected and actual on a failing criterion', () => {
    const result = deriveCriterionResult(CRITERION, [
      attempt({
        assertionEvaluations: [
          {
            description: 'body echoes the configured token',
            satisfied: false,
            expected: `body contains ${SEEDED}`,
            actual: `body contained ${SEEDED} twice`,
          },
        ],
      }),
    ]);

    expect(JSON.stringify(result)).not.toContain('criterionleak');
    expect(result.expected).toContain('[REDACTED]');
    expect(result.actual).toContain('[REDACTED]');
  });

  it('redacts an exec error message', () => {
    const result = deriveCriterionResult(CRITERION, [
      attempt({
        assertionEvaluations: [],
        execError: { message: `curl failed: > Authorization: Bearer ${SEEDED}` },
      }),
    ]);

    expect(result.status).toBe('error');
    expect(JSON.stringify(result)).not.toContain('criterionleak');
  });

  it('applies config-declared extra patterns', () => {
    const result = deriveCriterionResult(
      CRITERION,
      [
        attempt({
          assertionEvaluations: [
            { description: 'x', satisfied: false, actual: 'saw ACME-4242' },
          ],
        }),
      ],
      { extraPatterns: [/ACME-\d+/] },
    );

    expect(result.actual).not.toContain('ACME-4242');
  });

  it('leaves the contract statement verbatim', () => {
    // A human wrote and reviewed it. Redacting the contract's own words would mangle the
    // report without protecting anything a probe captured.
    const result = deriveCriterionResult(CRITERION, []);

    expect(result.statement).toBe(CRITERION.statement);
  });
});

describe('a human-verifiability criterion never auto-passes (Q39)', () => {
  // Q39 fixes human verifiability as one of exactly two NEEDS_HUMAN triggers, and
  // `domain/contract.ts` says human criteria "always resolve to NEEDS_HUMAN and never
  // auto-PASS — that is why this is a property of the contract rather than a judgement
  // made later at run time".
  //
  // Before this, `verifiability` was dropped at the integrity stage, so a human criterion
  // derived from zero attempts as `skipped`; `skipped` is inert in aggregation; and a
  // frozen contract whose author had written "no machine may answer this" verified PASS
  // at exit 0. Found by story 3.7's agent, whose exit-2 acceptance criterion it made
  // unsatisfiable.

  it('is needs_human with zero attempts, where an automated criterion is skipped', () => {
    expect(deriveCriterionResult(HUMAN_CRITERION, []).status).toBe('needs_human');
    expect(deriveCriterionResult(CRITERION, []).status).toBe('skipped');
  });

  it('carries the contract statement, so a report can say what a person must judge', () => {
    const result = deriveCriterionResult(HUMAN_CRITERION, []);

    expect(result.statement).toBe('the error copy reads as a human wrote it');
    expect(result.criterionId).toBe('E3-09');
  });

  it('does not depend on probes existing — a gates-only run has still not had a person look', () => {
    // The property must hold in Epic 3, before any probe exists. That is the whole point:
    // it is a fact about the contract, not about what ran.
    const result = deriveCriterionResult(HUMAN_CRITERION, []);

    expect(result.status).not.toBe('pass');
    expect(result.status).not.toBe('skipped');
  });

  it('stays needs_human even when a probe ran and its assertions held', () => {
    // My first fix applied the rule only when there were NO attempts, reasoning that a
    // future human-input surface should be able to report a recorded judgement. Review
    // caught that as a silent redesign: `domain/contract.ts` says human criteria "always
    // resolve to NEEDS_HUMAN", and that it is "a property of the contract rather than a
    // judgement made later at run time" — attempts ARE a run-time judgement, so they
    // cannot override it. Changing that is an ADR, not a branch in this function.
    const result = deriveCriterionResult(HUMAN_CRITERION, [
      {
        attempt: 1,
        observations: [],
        assertionEvaluations: [{ description: 'a reviewer approved the copy', satisfied: true }],
        evidence: [],
        durationMs: 1,
      },
    ]);

    expect(result.status).toBe('needs_human');
  });

  it('stays needs_human even when a probe ran and its assertions FAILED', () => {
    // The other direction, and the more tempting one to allow: a mechanical `fail` on a
    // criterion nobody may adjudicate mechanically is still not an answer.
    const result = deriveCriterionResult(HUMAN_CRITERION, [
      {
        attempt: 1,
        observations: [],
        assertionEvaluations: [{ description: 'copy matches the spec text', satisfied: false }],
        evidence: [],
        durationMs: 1,
      },
    ]);

    expect(result.status).toBe('needs_human');
  });
});
