import { describe, expect, it } from 'vitest';

import { PROBE_SURFACES, type ProbeSurface } from '../../../src/domain/criterion-result.js';
import {
  ASSERTION_COMPARISONS,
  NEEDS_HUMAN_REASONS,
  PROBE_UNION_AGREES,
  type ProbeSpec,
  type ProbeSpecSurface,
} from '../../../src/domain/plan.js';
import { PlanSchema } from '../../../src/schemas/plan.js';
import {
  BROWSER_PROBE,
  HTTP_PROBE,
  OBSERVATION_PROBE,
  SHELL_PROBE,
  asDocument,
  automated,
  criterion,
  frozenContract,
  planFor,
} from '../../helpers/plan.js';

/**
 * The plan's probe union and AD-13's `PROBE_SURFACES` are THE SAME LIST, and this file is
 * what stops them becoming two lists.
 *
 * Both halves are asserted, because each catches a different drift. A surface added to
 * `PROBE_SURFACES` with no probe shape in the plan schema means a criterion-result the
 * plan can never produce; a probe shape for a surface the execution contract does not know
 * about means a plan that compiles and then has no executor. A one-directional check
 * silently passes one of the two.
 *
 * The compile-time half follows `tests/unit/providers/types.test.ts`'s established pattern
 * for exactly this problem: `pnpm typecheck` is what runs it, and a `@ts-expect-error` that
 * stops erroring fails the build as loudly as a wrong `expect()`.
 */

/** Compile-time assertion that `A` and `B` are mutually assignable. */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const assertType = <T extends true>(): T => true as T;

describe('the probe union agrees with AD-13’s PROBE_SURFACES (compile time)', () => {
  it('is mutually assignable with ProbeSurface', () => {
    expect(assertType<MutuallyAssignable<ProbeSpecSurface, ProbeSurface>>()).toBe(true);
    // The same property asserted inside `domain/plan.ts` itself, so a widening there stops
    // compiling at its source rather than only here.
    expect(PROBE_UNION_AGREES).toBe(true);
  });

  it('rejects a surface the execution contract does not know', () => {
    // @ts-expect-error 'database' is not a ProbeSurface — widening the union is an ADR.
    const surface: ProbeSurface = 'database';
    expect(surface).toBe('database');
  });
});

describe('the probe union agrees with AD-13’s PROBE_SURFACES (run time)', () => {
  const PROBES: Readonly<Record<ProbeSurface, ProbeSpec>> = {
    http: HTTP_PROBE,
    browser: BROWSER_PROBE,
    observation: OBSERVATION_PROBE,
    shell: SHELL_PROBE,
  };

  const CONTRACT = frozenContract([criterion('E7-01')]);

  it.each(PROBE_SURFACES)('accepts a %s probe', (surface) => {
    const probe = PROBES[surface];

    expect(probe.surface).toBe(surface);
    expect(
      PlanSchema.safeParse(asDocument(planFor(CONTRACT, { criteria: [automated('E7-01', probe)] })))
        .success,
    ).toBe(true);
  });

  it('has exactly one representative probe per declared surface', () => {
    // Guards against this file passing because it looked at nothing: if a fifth surface is
    // added and no probe is written for it, `PROBES` stops compiling — and if a probe is
    // added for a surface that is not declared, this count disagrees.
    expect(Object.keys(PROBES).sort()).toEqual([...PROBE_SURFACES].sort());
    expect(PROBE_SURFACES).toHaveLength(4);
  });

  it('rejects a probe naming a surface outside the closed union', () => {
    const document = asDocument(planFor(CONTRACT, { criteria: [automated('E7-01', HTTP_PROBE)] }));
    const probe = (document.plan as { criteria: { probes: Record<string, unknown>[] }[] }).criteria[0]
      ?.probes[0] as Record<string, unknown>;
    probe.surface = 'database';

    expect(PlanSchema.safeParse(document).success).toBe(false);
  });
});

describe('the plan’s own closed vocabularies', () => {
  it('offers no pattern/regex comparison', () => {
    // A deliberate omission, not an oversight: an untrusted regular expression evaluated
    // against untrusted output by every surface executor is a ReDoS with a hostile author.
    // See the rationale on ASSERTION_COMPARISONS. Adding one is an ADR plus a mitigation.
    expect(ASSERTION_COMPARISONS).not.toContain('matches');
    expect(ASSERTION_COMPARISONS).not.toContain('regex');
  });

  it('carries exactly Q39’s two NEEDS_HUMAN triggers', () => {
    expect([...NEEDS_HUMAN_REASONS]).toEqual(['human-verifiability', 'not-safely-automatable']);
  });
});
