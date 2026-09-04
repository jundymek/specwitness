/**
 * Story 5.4 — the per-attempt record, and the four sequences that pin AC2.
 *
 * THE DEFECT THIS SUITE EXISTS TO CATCH: a retry that launders a real failure into a
 * flaky pass. It reads as green, it is wrong, and nothing downstream can tell — Epic 4
 * retro §2 observation 5's shape, which that epic's own author did not find and review
 * did. So the two assertions here that must never stop discriminating are
 * `pass → fail is NOT flaky` and `error → error stays error`: both would go quiet
 * without any other alarm, and both are the direction in which a wrong answer is worse
 * than no answer.
 *
 * The derivation rule itself is Epic 4's and is not re-decided here — this suite asserts
 * that the rule survives the addition of the record, and that the record says what
 * happened on the attempts the rule threw away.
 */
import { describe, expect, it } from 'vitest';

import { ATTEMPT_OUTCOMES, deriveCriterionResult } from '../../../src/domain/criterion-result.js';
import { CRITERION_STATUSES } from '../../../src/domain/result.js';
import type {
  ContractCriterionRef,
  ProbeAttempt,
} from '../../../src/domain/criterion-result.js';
import { evidenceRef } from '../../../src/domain/evidence.js';

const CRITERION: ContractCriterionRef = {
  criterionId: 'E5-04',
  statement: 'the health endpoint answers 200',
  severity: 'critical',
  verifiability: 'automated',
};

function passing(n: number): ProbeAttempt {
  return {
    attempt: n,
    observations: [],
    assertionEvaluations: [{ description: 'status is 200', satisfied: true }],
    evidence: [evidenceRef('http', `probes/http-attempt-0${n}.response.txt`)],
    durationMs: 10 * n,
  };
}

function failing(n: number): ProbeAttempt {
  return {
    attempt: n,
    observations: [],
    assertionEvaluations: [
      { description: 'status is 200', satisfied: false, expected: '200', actual: '500' },
    ],
    evidence: [evidenceRef('http', `probes/http-attempt-0${n}.response.txt`)],
    durationMs: 10 * n,
  };
}

function erroring(n: number): ProbeAttempt {
  return {
    attempt: n,
    observations: [],
    assertionEvaluations: [],
    evidence: [],
    execError: { message: 'connect ECONNREFUSED 127.0.0.1:1' },
    durationMs: 5,
  };
}

describe('ATTEMPT_OUTCOMES', () => {
  it('is the criterion taxonomy minus `skipped`, so the two cannot drift', () => {
    // `satisfies` in the source stops a non-outcome being listed; this stops a status
    // being ADDED to CRITERION_STATUSES and silently never reaching an attempt record.
    expect([...ATTEMPT_OUTCOMES].sort()).toEqual(
      CRITERION_STATUSES.filter((status) => status !== 'skipped').sort(),
    );
  });
});

describe('AC2 — retries never change classification, only repetition', () => {
  it('fail → pass is a PASS marked flaky, with both attempts recorded', () => {
    const result = deriveCriterionResult(CRITERION, [failing(1), passing(2)]);

    expect(result.status).toBe('pass');
    expect(result.flaky).toBe(true);
    expect(result.attempts?.map((a) => a.outcome)).toEqual(['fail', 'pass']);
  });

  it('fail → fail → fail is a FAIL, NOT flaky, with all three attempts recorded', () => {
    const result = deriveCriterionResult(CRITERION, [failing(1), failing(2), failing(3)]);

    expect(result.status).toBe('fail');
    expect(result.flaky).toBeUndefined();
    expect(result.attempts).toHaveLength(3);
    expect(result.attempts?.map((a) => a.outcome)).toEqual(['fail', 'fail', 'fail']);
  });

  it('pass → fail is a FAIL and is NOT flaky — a real defect is never softened into noise', () => {
    const result = deriveCriterionResult(CRITERION, [passing(1), failing(2)]);

    expect(result.status).toBe('fail');
    expect(result.flaky).toBeUndefined();
    expect(result.attempts?.map((a) => a.outcome)).toEqual(['pass', 'fail']);
  });

  it('error → error stays ERROR — a retry never converts infrastructure into product', () => {
    const result = deriveCriterionResult(CRITERION, [erroring(1), erroring(2)]);

    expect(result.status).toBe('error');
    expect(result.flaky).toBeUndefined();
    expect(result.attempts?.map((a) => a.outcome)).toEqual(['error', 'error']);
  });

  it('error → pass is a flaky PASS whose record still says the environment failed', () => {
    // The environment failing and then working is a flake like any other; what must not
    // happen is the failed attempt disappearing, because a flake marker a reader cannot
    // investigate is a marker they learn to ignore.
    const result = deriveCriterionResult(CRITERION, [erroring(1), passing(2)]);

    expect(result.status).toBe('pass');
    expect(result.flaky).toBe(true);
    expect(result.attempts?.[0]?.outcome).toBe('error');
    expect(result.attempts?.[0]?.actual).toContain('ECONNREFUSED');
  });
});

describe('AC1 — every attempt is recorded, with its outcome and its evidence', () => {
  it("carries the FAILED first attempt's evidence, which the pass result itself drops", () => {
    // This is the gap the record closes. `deriveCriterionResult` returns early on a pass
    // with no `evidence` at all, so after a flaky pass the ONLY place the failed
    // attempt's artifact is named on the criterion is here.
    const result = deriveCriterionResult(CRITERION, [failing(1), passing(2)]);

    expect(result.evidence).toBeUndefined();
    expect(result.attempts?.[0]?.evidence?.[0]?.path).toBe(
      'probes/http-attempt-01.response.txt',
    );
  });

  it('records expected and actual for the failed attempt of a flaky pass', () => {
    const result = deriveCriterionResult(CRITERION, [failing(1), passing(2)]);

    expect(result.attempts?.[0]?.expected).toBe('200');
    expect(result.attempts?.[0]?.actual).toBe('500');
  });

  it('numbers attempts 1-based and monotonically, from the attempt itself', () => {
    const result = deriveCriterionResult(CRITERION, [failing(1), failing(2), passing(3)]);

    expect(result.attempts?.map((a) => a.attempt)).toEqual([1, 2, 3]);
  });

  it('carries each attempt duration, so a reader can see a timeout from a refusal', () => {
    const result = deriveCriterionResult(CRITERION, [failing(1), passing(2)]);

    expect(result.attempts?.map((a) => a.durationMs)).toEqual([10, 20]);
  });

  it('redacts expected and actual in the record, at the same boundary as the final one', () => {
    // A second attempt written by a path that skipped redaction would be a leak the first
    // attempt's clean output disguises (Epic 3 retro §7). Assert the secret is ABSENT.
    const leaky: ProbeAttempt = {
      ...failing(1),
      assertionEvaluations: [
        {
          description: 'body has no token',
          satisfied: false,
          expected: 'no token',
          actual: 'Authorization: Bearer hunter2-the-secret',
        },
      ],
    };

    const builtIn = deriveCriterionResult(CRITERION, [leaky, passing(2)]);
    expect(builtIn.attempts?.[0]?.actual).not.toContain('hunter2-the-secret');

    // And the config-declared extra patterns reach the record by the same route.
    const extra = deriveCriterionResult(
      CRITERION,
      [
        { ...leaky, assertionEvaluations: [{ ...leaky.assertionEvaluations[0]!, actual: 'sk-live-abc123' }] },
        passing(2),
      ],
      { extraPatterns: [/sk-live-[a-z0-9]+/] },
    );
    expect(extra.attempts?.[0]?.actual).not.toContain('sk-live-abc123');
  });
});

describe('the record exists exactly where it carries information', () => {
  it('is ABSENT for the ordinary single-attempt criterion', () => {
    // With the shipped default of zero retries every criterion has exactly one attempt,
    // whose outcome, expected/actual and evidence ARE the criterion result. Repeating
    // them under `attempts` would double every result.json to say nothing new.
    expect(deriveCriterionResult(CRITERION, [passing(1)]).attempts).toBeUndefined();
    expect(deriveCriterionResult(CRITERION, [failing(1)]).attempts).toBeUndefined();
  });

  it('is absent for a criterion that never ran', () => {
    expect(deriveCriterionResult(CRITERION, []).attempts).toBeUndefined();
  });

  it('is absent for a human criterion, which is decided before attempts are looked at', () => {
    const human: ContractCriterionRef = { ...CRITERION, verifiability: 'human' };

    expect(deriveCriterionResult(human, [failing(1), passing(2)]).attempts).toBeUndefined();
  });
});
