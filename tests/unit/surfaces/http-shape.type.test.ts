/**
 * AD-13, made a COMPILE ERROR rather than a convention: an http probe cannot report a
 * `CriterionStatus`.
 *
 * The rule this file guards is the story's first invariant — "you evaluate assertions and
 * report what you saw; something else decides what it means". Every part of it is
 * enforceable at run time except the one that matters most, because a status that a
 * surface never sets is a status no test can observe being wrong. What CAN be checked is
 * that there is nowhere to put one, which is exactly how `criterion-result.ts` phrases the
 * interface: "It does NOT return a `CriterionStatus`, and there is nowhere in this
 * interface to put one."
 *
 * WHY A TYPE TEST AND NOT A RUNTIME ONE. A runtime assertion (`expect(attempt).not.toHaveProperty('status')`)
 * checks one call with one set of inputs. Four surfaces will exist by the end of Epic 5 and
 * each returns from many branches — an exec-error path, a partial-observation path, four
 * assertion outcomes. A structural check covers every branch of every future edit at once,
 * and it fails on the file that drifted rather than on whichever test happened to exercise
 * the new branch.
 *
 * `tests/unit/schemas/result-mirror.type.test.ts` established this pattern and its header
 * explains the `Exact` construction; the reasoning there ("a guard that reads a proxy is
 * wrong precisely on the cases where the proxy and the fact diverge") is the reason this
 * compares SHAPES rather than key names.
 */

import { describe, expect, it } from 'vitest';

import type { ProbeAttempt, SurfaceExecutor } from '../../../src/domain/criterion-result.js';
import { HttpSurfaceExecutor } from '../../../src/surfaces/http.js';

/** See `result-mirror.type.test.ts` — normalises readonly so only real drift is compared. */
type Normalize<T> = T extends readonly (infer E)[]
  ? readonly Normalize<E>[]
  : T extends object
    ? { readonly [K in keyof T]: Normalize<T[K]> }
    : T;

/** True only when the two shapes are mutually assignable after normalisation. */
type Exact<A, B> = [Normalize<A>] extends [Normalize<B>]
  ? [Normalize<B>] extends [Normalize<A>]
    ? true
    : false
  : false;

type ExecuteReturn = Awaited<ReturnType<HttpSurfaceExecutor['execute']>>;

const guards: {
  /**
   * THE load-bearing check. `execute()` returns EXACTLY `ProbeAttempt` — not a subtype
   * carrying an extra field, which is how a status would arrive in practice. A widened
   * return type turns this `true` into `false` and names this property.
   */
  returnsExactlyProbeAttempt: Exact<ExecuteReturn, ProbeAttempt>;
  /**
   * The executor satisfies the merged interface. Stated separately from the class's own
   * `implements` clause so that REPLACING the interface import with a local look-alike —
   * which would silence `implements` — still fails here.
   */
  implementsTheMergedInterface: HttpSurfaceExecutor extends SurfaceExecutor ? true : false;
  /**
   * No key of the returned attempt is named for a verdict. Weaker than the structural
   * check above and deliberately kept anyway: it is the one that reads as the RULE rather
   * than as a shape comparison, so a reader of this file learns what is forbidden.
   */
  carriesNoVerdictKey: Extract<keyof ExecuteReturn, 'status' | 'flaky' | 'severity'> extends never
    ? true
    : false;
} = {
  returnsExactlyProbeAttempt: true,
  implementsTheMergedInterface: true,
  carriesNoVerdictKey: true,
};

describe('the http executor cannot report a verdict (AD-13)', () => {
  it('compiles only while every structural guard holds', () => {
    expect(Object.values(guards).every((held) => held)).toBe(true);
  });

  it('rejects a ProbeAttempt carrying a status, at compile time', () => {
    const attempt: ProbeAttempt = {
      attempt: 1,
      observations: [],
      assertionEvaluations: [],
      evidence: [],
      durationMs: 0,
    };

    // @ts-expect-error — AD-13: a surface may never report a CriterionStatus. If this line
    // ever stops being an error, `ProbeAttempt` has been widened and the single-producer
    // rule is gone. The `@ts-expect-error` itself then fails the build, which is the point.
    const forbidden: ProbeAttempt = { ...attempt, status: 'pass' };

    expect(forbidden.attempt).toBe(1);
  });
});
