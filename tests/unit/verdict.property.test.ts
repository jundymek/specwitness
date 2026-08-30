import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { CRITERION_STATUSES, GATE_STATUSES } from '../../src/domain/result.js';
import type { CriterionResult, GateResult } from '../../src/domain/result.js';
import type { RunOutcome } from '../../src/domain/run-outcome.js';
import { aggregate } from '../../src/domain/verdict.js';

const gateArb: fc.Arbitrary<GateResult> = fc.record({
  gateId: fc.string({ minLength: 1, maxLength: 8 }),
  status: fc.constantFrom(...GATE_STATUSES),
});

const criterionArb: fc.Arbitrary<CriterionResult> = fc.record(
  {
    criterionId: fc.string({ minLength: 1, maxLength: 8 }),
    status: fc.constantFrom(...CRITERION_STATUSES),
    flaky: fc.boolean(),
  },
  { requiredKeys: ['criterionId', 'status'] },
);

const gatesArb = fc.array(gateArb, { maxLength: 8 });
const criteriaArb = fc.array(criterionArb, { maxLength: 12 });

/** An array paired with a permutation of itself. */
const withPermutation = <T,>(arb: fc.Arbitrary<T[]>): fc.Arbitrary<[T[], T[]]> =>
  arb.chain((items) =>
    fc.tuple(
      fc.constant(items),
      fc.shuffledSubarray(items, { minLength: items.length, maxLength: items.length }),
    ),
  );

const hasFailedGate = (gates: readonly GateResult[]): boolean => gates.some((g) => g.status === 'fail');
const hasStatus = (criteria: readonly CriterionResult[], status: CriterionResult['status']): boolean =>
  criteria.some((c) => c.status === status);
const verdictOf = (outcome: RunOutcome): string | undefined =>
  'verdict' in outcome ? outcome.verdict : undefined;
const infraOf = (outcome: RunOutcome): string | undefined =>
  'infraError' in outcome ? outcome.infraError : undefined;

describe('aggregate — properties (AD-6)', () => {
  it('is total: never throws for any combination of typed inputs', () => {
    fc.assert(
      fc.property(gatesArb, criteriaArb, (gates, criteria) => {
        expect(() => aggregate(gates, criteria)).not.toThrow();
      }),
    );
  });

  it('always returns exactly one arm of the union', () => {
    fc.assert(
      fc.property(gatesArb, criteriaArb, (gates, criteria) => {
        const outcome = aggregate(gates, criteria);
        expect(verdictOf(outcome) !== undefined).not.toBe(infraOf(outcome) !== undefined);
      }),
    );
  });

  it('is invariant under permutation of both inputs', () => {
    fc.assert(
      fc.property(withPermutation(gatesArb), withPermutation(criteriaArb), ([gates, gates2], [crits, crits2]) => {
        const base = aggregate(gates, crits);
        const permuted = aggregate(gates2, crits2);

        // The chosen arm is fully order-independent.
        expect(verdictOf(permuted)).toEqual(verdictOf(base));
        expect(infraOf(permuted)).toEqual(infraOf(base));

        // With several failing gates, WHICH id is reported depends on order —
        // but it is always one of the genuinely failing gates, in both orderings.
        const failedIds = gates.filter((g) => g.status === 'fail').map((g) => g.gateId);
        for (const outcome of [base, permuted]) {
          if ('gateFailed' in outcome && outcome.gateFailed !== undefined) {
            expect(failedIds).toContain(outcome.gateFailed);
          }
        }
        // gateFailed is present in both orderings or neither.
        expect('gateFailed' in base && base.gateFailed !== undefined).toBe(
          'gateFailed' in permuted && permuted.gateFailed !== undefined,
        );
      }),
    );
  });

  it('is monotone in fail: adding a failing criterion anywhere never yields PASS or NEEDS_HUMAN', () => {
    fc.assert(
      fc.property(gatesArb, criteriaArb, fc.nat(), (gates, criteria, rawIndex) => {
        const index = rawIndex % (criteria.length + 1);
        const withFail: CriterionResult[] = [
          ...criteria.slice(0, index),
          { criterionId: 'injected-fail', status: 'fail' },
          ...criteria.slice(index),
        ];
        const outcome = aggregate(gates, withFail);
        expect(verdictOf(outcome)).toBe('FAIL');
        expect(infraOf(outcome)).toBeUndefined();
      }),
    );
  });

  it('returns PASS exactly when nothing failed, errored or needs a human', () => {
    fc.assert(
      fc.property(gatesArb, criteriaArb, (gates, criteria) => {
        const shouldPass =
          !hasFailedGate(gates) &&
          !hasStatus(criteria, 'fail') &&
          !hasStatus(criteria, 'error') &&
          !hasStatus(criteria, 'needs_human');
        expect(verdictOf(aggregate(gates, criteria)) === 'PASS').toBe(shouldPass);
      }),
    );
  });

  it('lets a failing gate dominate every criterion input', () => {
    fc.assert(
      fc.property(gatesArb, criteriaArb, (gates, criteria) => {
        fc.pre(hasFailedGate(gates));
        const outcome = aggregate(gates, criteria);
        expect(verdictOf(outcome)).toBe('FAIL');
        expect(outcome).toHaveProperty('gateFailed');
        const failedIds = gates.filter((g) => g.status === 'fail').map((g) => g.gateId);
        expect(failedIds).toContain((outcome as { gateFailed: string }).gateFailed);
      }),
    );
  });

  it('applies fail > error > needs_human > pass precedence when no gate failed', () => {
    fc.assert(
      fc.property(criteriaArb, (criteria) => {
        const outcome = aggregate([], criteria);
        if (hasStatus(criteria, 'fail')) {
          expect(outcome).toEqual({ verdict: 'FAIL' });
        } else if (hasStatus(criteria, 'error')) {
          expect(outcome).toEqual({ infraError: 'infra' });
        } else if (hasStatus(criteria, 'needs_human')) {
          expect(outcome).toEqual({ verdict: 'NEEDS_HUMAN' });
        } else {
          expect(outcome).toEqual({ verdict: 'PASS' });
        }
      }),
    );
  });

  it('is unaffected by skipped criteria: dropping them never changes the outcome', () => {
    fc.assert(
      fc.property(gatesArb, criteriaArb, (gates, criteria) => {
        const withoutSkipped = criteria.filter((c) => c.status !== 'skipped');
        expect(aggregate(gates, criteria)).toEqual(aggregate(gates, withoutSkipped));
      }),
    );
  });

  it('is unaffected by the flaky marker', () => {
    fc.assert(
      fc.property(gatesArb, criteriaArb, (gates, criteria) => {
        const unflagged = criteria.map(({ criterionId, status }) => ({ criterionId, status }));
        expect(aggregate(gates, criteria)).toEqual(aggregate(gates, unflagged));
      }),
    );
  });

  it('never mutates its inputs', () => {
    fc.assert(
      fc.property(gatesArb, criteriaArb, (gates, criteria) => {
        const gatesBefore = structuredClone(gates);
        const criteriaBefore = structuredClone(criteria);
        aggregate(gates, criteria);
        expect(gates).toEqual(gatesBefore);
        expect(criteria).toEqual(criteriaBefore);
      }),
    );
  });
});
