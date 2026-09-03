/**
 * AD-13, made a COMPILE ERROR rather than a convention: a browser probe cannot report a
 * `CriterionStatus`.
 *
 * The fourth instance of the pattern `tests/unit/surfaces/http-shape.type.test.ts`
 * established, and its header gives the argument in full: the rule this guards is the
 * story's first invariant — "you evaluate assertions and report what you saw; something
 * else decides what it means" — and it is the one part of that invariant no runtime
 * assertion can cover, because a status a surface never sets is a status no test can
 * observe being wrong. What CAN be checked is that there is nowhere to put one, which is
 * exactly how `criterion-result.ts` phrases the interface.
 *
 * It matters most on THIS surface. `execute()` here returns from more branches than any
 * other — an unprovisioned environment, a launch failure, a driver failure, four assertion
 * outcomes — and a structural check covers every branch of every future edit at once, on
 * the file that drifted rather than on whichever test happened to exercise the new one.
 */

import { describe, expect, it } from 'vitest';

import type { ProbeAttempt, SurfaceExecutor } from '../../../src/domain/criterion-result.js';
import { BrowserSurfaceExecutor } from '../../../src/surfaces/browser.js';

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

type ExecuteReturn = Awaited<ReturnType<BrowserSurfaceExecutor['execute']>>;

const guards: {
  /**
   * THE load-bearing check. `execute()` returns EXACTLY `ProbeAttempt` — not a subtype
   * carrying an extra field, which is how a status would arrive in practice.
   */
  returnsExactlyProbeAttempt: Exact<ExecuteReturn, ProbeAttempt>;
  /**
   * The executor satisfies the merged interface. Stated separately from the class's own
   * `implements` clause so that REPLACING the interface import with a local look-alike —
   * which would silence `implements` — still fails here.
   */
  implementsTheMergedInterface: BrowserSurfaceExecutor extends SurfaceExecutor ? true : false;
  /**
   * No key of the returned attempt is named for a verdict. Weaker than the structural
   * check above and deliberately kept anyway: it is the one that reads as the RULE rather
   * than as a shape comparison.
   */
  carriesNoVerdictKey: Extract<keyof ExecuteReturn, 'status' | 'flaky' | 'severity'> extends never
    ? true
    : false;
} = {
  returnsExactlyProbeAttempt: true,
  implementsTheMergedInterface: true,
  carriesNoVerdictKey: true,
};

describe('the browser executor cannot report a verdict (AD-13)', () => {
  it('compiles only while every structural guard holds', () => {
    expect(Object.values(guards).every((held) => held)).toBe(true);
  });

  it('declares the browser surface', () => {
    // Constructed with stubs: nothing in the constructor performs I/O, and the point here
    // is the routing key rather than any behaviour.
    const executor = new BrowserSurfaceExecutor({
      clock: { now: () => new Date(0) },
      runner: { run: async () => { throw new Error('the shape test never spawns'); } },
      cwd: '/nowhere',
      environment: { ready: false, browsersPath: '/nowhere', reason: 'the shape test never runs' },
      writeEvidence: async (name) => name,
      writeEvidenceBytes: async (name) => name,
      resolveRunPath: (path) => path,
      recordEvidence: () => undefined,
    });

    expect(executor.surface).toBe('browser');
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
