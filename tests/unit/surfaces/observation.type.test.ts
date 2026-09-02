/**
 * Story 4.5 — AD-13 made a COMPILE ERROR, not a convention.
 *
 * The runtime test next door asserts that `execute()` returns no status-shaped key. That is
 * necessary but not sufficient: it inspects one call's result, so it can only catch a status
 * on the paths a test happens to exercise. What must actually hold is stronger and static —
 * **there is nowhere in the return type to put a `CriterionStatus`** — and only the compiler
 * can check that over every path at once.
 *
 * This matters because the failure it prevents is invisible at run time. Four surfaces each
 * adjudicating status their own way would give four subtly different answers to "did a retry
 * that eventually passed count as flaky", and `criterion-result.ts` says exactly where that
 * shows up: "the differences would only ever surface as a verdict nobody could reproduce".
 * A verdict nobody can reproduce is not a test failure; it is a support ticket a year later.
 *
 * The pattern is `tests/unit/schemas/result-mirror.type.test.ts`'s: each rule is a property
 * typed `true`, so when it breaks `tsc` names the property that broke rather than printing
 * one enormous structural diff. `pnpm typecheck` is what enforces this file; the `it` block
 * exists so the suite reports it as covered rather than silently type-only.
 */

import { describe, expect, it } from 'vitest';

import type {
  ProbeAttempt,
  SurfaceExecutor,
} from '../../../src/domain/criterion-result.js';
import type { CriterionStatus } from '../../../src/domain/result.js';
import { ObservationSurfaceExecutor } from '../../../src/surfaces/observation.js';

/** `true` when `T` has no property whose type could hold a `CriterionStatus`. */
type HasNoStatusValued<T> = {
  [K in keyof T]-?: CriterionStatus extends NonNullable<T[K]> ? K : never;
}[keyof T] extends never
  ? true
  : false;

/** `true` when `T` declares none of the names a status would plausibly be smuggled under. */
type HasNoStatusNamed<T> = Extract<keyof T, 'status' | 'criterionStatus' | 'verdict' | 'outcome'> extends never
  ? true
  : false;

/** What `execute()` actually resolves to, read off the class rather than off an annotation. */
type Resolved = Awaited<ReturnType<ObservationSurfaceExecutor['execute']>>;

const rules = {
  /**
   * THE RULE THIS FILE EXISTS FOR. `ProbeAttempt` cannot carry a status by NAME.
   *
   * Read off the merged interface, so it fails if a later story widens `ProbeAttempt`
   * itself — which is the direction the damage would actually come from. Nobody adds
   * `status` to one executor; somebody adds it to the shared contract and four surfaces
   * quietly start filling it in.
   */
  probeAttemptDeclaresNoStatusName: true as HasNoStatusNamed<ProbeAttempt>,

  /**
   * And not by TYPE either, under any name. `HasNoStatusNamed` is a proxy — it guards the
   * four spellings someone would reach for — while this guards the fact: no property of a
   * `ProbeAttempt` can hold the value at all. A guard that reads only a proxy is wrong
   * exactly on the cases where the proxy and the fact diverge, which are the interesting ones.
   */
  probeAttemptHasNoStatusValuedField: true as HasNoStatusValued<ProbeAttempt>,

  /** This executor returns exactly that, so both rules above bind to it too. */
  executorResolvesToProbeAttempt: true as Resolved extends ProbeAttempt ? true : false,
  probeAttemptIsWhatItResolves: true as ProbeAttempt extends Resolved ? true : false,

  /** It really implements the merged interface — checked at the declaration, not the call site. */
  implementsSurfaceExecutor: true as ObservationSurfaceExecutor extends SurfaceExecutor
    ? true
    : false,

  /**
   * The surface is the LITERAL, not the widened union. `readonly surface = 'observation'`
   * without `as const` would type as `ProbeSurface`, and a caller dispatching on it would
   * compile while dispatching on nothing.
   */
  surfaceIsTheLiteral: true as ObservationSurfaceExecutor['surface'] extends 'observation'
    ? true
    : false,
} as const;

describe('AD-13 — a CriterionStatus is unrepresentable in what this executor returns', () => {
  it('holds every structural rule (enforced by tsc; this asserts the file ran)', () => {
    expect(Object.values(rules).every((rule) => rule === true)).toBe(true);
  });
});
