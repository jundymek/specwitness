/**
 * Story 4.6 — AD-13 made a COMPILE error rather than a review convention.
 *
 * The rule: a `SurfaceExecutor` returns a `ProbeAttempt` and NEVER a
 * `CriterionStatus`. `domain/criterion-result.ts` states it as a property of
 * the interface — "It does NOT return a `CriterionStatus`, and there is nowhere
 * in this interface to put one" — and the reason is not tidiness: four surfaces
 * each adjudicating status their own way would give four subtly different
 * answers to "did a retry that eventually passed count as flaky", and the
 * differences would only ever surface as a verdict nobody could reproduce.
 *
 * WHY THIS FILE EXISTS AT ALL. A runtime test cannot check the rule. It can
 * only observe that the objects one particular call happened to produce carry
 * no status field — which is a proxy for the question, and passes just as green
 * on the day someone adds `status` to `ProbeAttempt` and every executor starts
 * filling it in. The fact itself is structural, so it is asserted structurally.
 *
 * HOW A FAILURE READS. Each pair below is one property typed `Exact<…>` or
 * `false`. When the structure drifts the literal stops being assignable and
 * `tsc` names the property, so the error says WHICH rule broke rather than
 * printing one enormous structural diff. Pattern borrowed from the merged
 * `tests/unit/schemas/result-mirror.type.test.ts`, which records why comparing
 * shapes beats comparing `keyof` unions: `keyof` discards value types and
 * optional modifiers, so a guard reading it is wrong precisely on the cases
 * where the proxy and the fact diverge.
 */

import { describe, expect, it } from 'vitest';

import type {
  ProbeAttempt,
  SurfaceExecutor,
} from '../../../src/domain/criterion-result.js';
import type { CriterionStatus } from '../../../src/domain/result.js';
import { ShellSurfaceExecutor } from '../../../src/surfaces/shell.js';

/** Recursively normalises readonly-ness so it cannot cause a spurious mismatch. */
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

/** What `execute()` resolves to. */
type Returned = Awaited<ReturnType<ShellSurfaceExecutor['execute']>>;

/**
 * Does any property of `T`, at any depth, hold a `CriterionStatus`?
 *
 * Deliberately structural rather than a search for a property NAMED `status`:
 * the hazard is a status VALUE reaching the caller, whatever it is called.
 * `CriterionStatus` is a union of string literals, so the test is whether any
 * leaf is assignable to it while not being the whole `string` type — an
 * ordinary `string` field (a description, an observation value) must not trip
 * it, or the guard would be unsatisfiable.
 */
type HoldsStatus<T> = T extends readonly (infer E)[]
  ? HoldsStatus<E>
  : T extends object
    ? { [K in keyof T]-?: HoldsStatus<T[K]> }[keyof T] extends false
      ? false
      : true
    : string extends T
      ? false
      : [T] extends [CriterionStatus]
        ? true
        : false;

const rules: {
  /**
   * THE load-bearing check: what the executor returns is EXACTLY a
   * `ProbeAttempt` — not a supertype, not an extension with an extra field.
   * A widened return type is how a status would get somewhere to live.
   */
  returnsExactlyAProbeAttempt: Exact<Returned, ProbeAttempt>;
  /** No `CriterionStatus` is reachable anywhere in the returned structure. */
  noCriterionStatusAnywhereInTheReturn: HoldsStatus<Returned>;
  /** The class really implements the merged interface, checked at the declaration. */
  implementsTheMergedInterface: ShellSurfaceExecutor extends SurfaceExecutor ? true : false;
  /**
   * The surface discriminant is the literal `'shell'`, not the whole
   * `ProbeSurface` union — so a copy-paste from another surface is a type error
   * here rather than a probe silently claiming to be an http executor.
   */
  surfaceIsTheShellLiteral: Exact<ShellSurfaceExecutor['surface'], 'shell'>;
} = {
  returnsExactlyAProbeAttempt: true,
  noCriterionStatusAnywhereInTheReturn: false,
  implementsTheMergedInterface: true,
  surfaceIsTheShellLiteral: true,
};

describe('AD-13 is a compile-time property of this executor', () => {
  it('holds — the assertions above are checked by tsc, not by this assertion', () => {
    // The real check is `pnpm typecheck`. This body exists so the file is a
    // test rather than a lint-only artifact, and so a reader running the suite
    // sees the rule named.
    expect(Object.values(rules)).toEqual([true, false, true, true]);
  });
});
