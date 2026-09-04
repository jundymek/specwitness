/**
 * Story 5.6 — the adaptation pass inside the probes stage.
 *
 * The dispatcher double here keys its outcome on the probe's SCENARIO rather than on the
 * attempt number, which is the whole difference between this story and 5.4's: a retry
 * repeats an unchanged probe, so attempt number is the right axis there; an adaptation
 * changes the probe, so the scenario is the right axis here. A probe looking for
 * `#create-company` finds nothing; one looking for `#add-organization` finds it.
 *
 * ⚠️ THE MOST IMPORTANT TEST IN THIS FILE is `does not report an adapted pass as flaky`.
 * It was raised by the epic-5 supervisor from the merged code before any run had shown it,
 * and it was VERIFIED RED first by appending the adapted attempt to the original probe's
 * array — the naive wiring, which produces `[fail, pass]` and therefore `flaky: true`, a
 * per-attempt record, and a run-level flakiness entry. See `probes.ts`'s adaptation section
 * and DECISIONS.md D11.
 */

import { describe, expect, it } from 'vitest';

import type {
  AdaptationCandidate,
  AdaptationDecision,
} from '../../../../src/domain/adaptation-port.js';
import type {
  ContractCriterionRef,
  ProbeAttempt,
  SurfaceExecutor,
} from '../../../../src/domain/criterion-result.js';
import type { BrowserProbe, PlanCriterion } from '../../../../src/domain/plan.js';
import { resolvePlanData } from '../../../../src/domain/plan-data.js';
import { summarizeFlakiness } from '../../../../src/domain/result-counts.js';
import { createProbesStage } from '../../../../src/pipeline/stages/probes.js';
import type { ProbeDispatch, ProbesStageDeps } from '../../../../src/pipeline/stages/probes.js';
import { stageContext } from './services.helpers.js';

const CRITERION: ContractCriterionRef = {
  criterionId: 'E7-01',
  statement: 'a user can create an organization',
  severity: 'critical',
  verifiability: 'automated',
};

const NO_DATA = resolvePlanData({ seed: 'seed0000', bindings: [] });

/** The locator the fixture page actually has. Only a probe looking for THIS one passes. */
const WORKING = 'click "#add-organization"';
const BROKEN = 'click "#create-company"';

function browserProbe(id: string, scenario = BROKEN): BrowserProbe {
  return {
    id,
    surface: 'browser',
    mechanics: { serviceId: 'backend', path: '/orders', scenario },
    assertions: [
      {
        description: 'the organization page appears',
        target: { source: 'title' },
        comparison: 'equals',
        expected: 'Organizations',
      },
    ],
  };
}

function automated(probes: readonly BrowserProbe[]): PlanCriterion {
  return { criterionId: 'E7-01', disposition: 'automated', probes };
}

interface Dispatched {
  readonly probeId: string;
  readonly scenario: string;
}

/**
 * A stage whose probes pass iff their scenario is `WORKING`.
 *
 * `execErrorFor` names probe ids whose browser could not look at all — the case that must
 * NEVER be adapted, because guessing at a locator while the browser is on fire is exactly
 * what AC1's "failing on element-not-found" scopes out.
 */
function scripted(
  criteria: readonly PlanCriterion[],
  adapt: ProbesStageDeps['adapt'],
  /**
   * Probe id -> the structured `reason` its `execError` carries, or `'none'` for an
   * execError that establishes nothing.
   *
   * Story 5.6 closes D12 by owner decision: a step-target miss IS adaptable, a dead browser
   * is not, and an executor that did not say is not. Those are three different inputs and
   * this map is what lets each be tested rather than argued about.
   */
  execErrorFor: Readonly<Record<string, 'step-target-missing' | 'unreachable' | 'other' | 'none'>> = {},
): { deps: ProbesStageDeps; dispatched: Dispatched[] } {
  const dispatched: Dispatched[] = [];

  const deps: ProbesStageDeps = {
    criteria,
    data: NO_DATA,
    dispatch: ({ probe, attempt }): ProbeDispatch => {
      const scenario = (probe as BrowserProbe).mechanics.scenario;
      dispatched.push({ probeId: probe.id, scenario });

      const executor: SurfaceExecutor = {
        surface: probe.surface,
        execute: async (): Promise<ProbeAttempt> => {
          // A STALE SCENARIO IS A STEP-TARGET MISS, which is what it is in production and
          // what the (now narrowed) candidate rule keys on: the probe was told to click a
          // control that is not there. `execErrorFor` overrides it per probe so the
          // NON-adaptable reasons can be tested too.
          //
          // An adapted probe looking for the right thing finds it, so it does not error —
          // which is what makes the case adaptable end to end rather than in principle.
          const reason =
            scenario === WORKING ? undefined : (execErrorFor[probe.id] ?? 'step-target-missing');
          if (reason !== undefined) {
            return {
              attempt,
              observations: [],
              assertionEvaluations: [],
              evidence: [],
              execError: {
                message: 'the browser probe could not complete',
                ...(reason === 'none' ? {} : { reason }),
              },
              durationMs: 1,
            };
          }
          const satisfied = scenario === WORKING;
          return {
            attempt,
            observations: [{ name: 'title', value: satisfied ? 'Organizations' : 'Orders' }],
            assertionEvaluations: [
              {
                description: 'the organization page appears',
                satisfied,
                expected: 'Organizations',
                actual: satisfied ? 'Organizations' : 'Orders',
              },
            ],
            evidence: [],
            durationMs: 1,
          };
        },
      };
      return { executor, params: { probe } };
    },
    ...(adapt === undefined ? {} : { adapt }),
  };

  return { deps, dispatched };
}

/** An adapter that always proposes the working locator for every candidate it is offered. */
function proposeWorking(): {
  adapt: NonNullable<ProbesStageDeps['adapt']>;
  offered: string[][];
  /** Every candidate object, so a test can assert what was actually SENT. */
  seen: AdaptationCandidate[];
} {
  const offered: string[][] = [];
  const seen: AdaptationCandidate[] = [];
  return {
    offered,
    seen,
    adapt: async (candidates): Promise<AdaptationDecision> => {
      seen.push(...candidates);
      offered.push(candidates.map((candidate) => candidate.probeId));
      return {
        outcome: 'proposed',
        patches: candidates.map((candidate) => ({ probeId: candidate.probeId, scenario: WORKING })),
        usage: {
          role: 'mechanics-adapter',
          provider: 'scripted',
          durationMs: 5,
          attempts: 1,
          model: null,
          providerCliVersion: null,
        },
      };
    },
  };
}

async function run(deps: ProbesStageDeps) {
  const context = stageContext();
  context.run.contractCriteria.push(CRITERION);
  const result = await createProbesStage(deps).run(context);
  return { context, result };
}

describe('AC3 — nothing happens without an adapter', () => {
  it('never calls a provider on a default run, even with a failing browser probe', async () => {
    // The strongest form available: an adapter that would THROW if reached. A default run
    // is not merely expected to skip adaptation — there is no adapter in scope to reach.
    const exploding: NonNullable<ProbesStageDeps['adapt']> = async () => {
      throw new Error('a default verify run must never invoke a provider (FR-18, Q66)');
    };
    const { deps } = scripted([automated([browserProbe('p1')])], undefined);

    const { context } = await run(deps);

    // A stale scenario is a step-target miss, so the criterion errors rather than fails.
    expect(context.run.criteria[0]?.status).toBe('error');
    // No key at all, so "an unadapted run carries no marker and no record" is structural.
    expect(context.run.adaptation).toBeUndefined();
    expect(context.run.providerUsage).toEqual([]);
    // And the exploding adapter is genuinely never reached when it IS wired but nothing is
    // adaptable — asserted separately below, so this one stays about the absent case.
    expect(exploding).toBeTypeOf('function');
  });

  it('does not call the adapter when every criterion passed', async () => {
    let called = 0;
    const { deps } = scripted([automated([browserProbe('p1', WORKING)])], async () => {
      called += 1;
      return { outcome: 'refused', reason: 'unreachable' };
    });

    const { context } = await run(deps);

    expect(context.run.criteria[0]?.status).toBe('pass');
    expect(called).toBe(0);
    expect(context.run.adaptation).toBeUndefined();
  });
});

describe('AC1 — an accepted proposal is applied, re-executed and recorded', () => {
  it('turns the failing criterion into a pass and marks the run adapted', async () => {
    const { adapt, offered } = proposeWorking();
    const { deps, dispatched } = scripted([automated([browserProbe('p1')])], adapt);

    const { context } = await run(deps);

    expect(offered).toEqual([['p1']]);
    expect(context.run.criteria[0]?.status).toBe('pass');
    expect(context.run.adaptation?.adapted).toBe(true);
    expect(context.run.adaptation?.applied).toEqual([
      {
        criterionId: 'E7-01',
        probeId: 'p1',
        field: 'scenario',
        from: { text: BROKEN, truncated: false, totalBytes: BROKEN.length },
        to: { text: WORKING, truncated: false, totalBytes: WORKING.length },
      },
    ]);
    // The adapted probe really was re-executed, with the new scenario.
    expect(dispatched).toEqual([
      { probeId: 'p1', scenario: BROKEN },
      { probeId: 'p1', scenario: WORKING },
    ]);
  });

  it('records the provider invocation (FR-15, Q65)', async () => {
    const { adapt } = proposeWorking();
    const { deps } = scripted([automated([browserProbe('p1')])], adapt);

    const { context } = await run(deps);

    expect(context.run.providerUsage).toEqual([
      {
        role: 'mechanics-adapter',
        provider: 'scripted',
        durationMs: 5,
        attempts: 1,
        model: null,
        providerCliVersion: null,
      },
    ]);
  });

  it('⚠️ does not report an adapted pass as FLAKY, and records no attempt list', async () => {
    // THE SUPERVISOR'S FINDING. A retry repeats the SAME probe; an adaptation CHANGES it.
    // The naive wiring appends the adapted attempt to the original probe's array, producing
    // [fail, pass] — precisely the input `criterion-result.ts:441-443` turns into
    // `flaky: true`. That would tell a human the UI is intermittent when the probe was
    // rewritten. Verified red against exactly that wiring before this passed.
    const { adapt } = proposeWorking();
    const { deps } = scripted([automated([browserProbe('p1')])], adapt);

    const { context } = await run(deps);

    const criterion = context.run.criteria[0];
    expect(criterion?.status).toBe('pass');
    expect(criterion?.flaky).toBeUndefined();
    expect(criterion?.attempts).toBeUndefined();
    // And the run-level summary 5.4 derives is untouched too.
    expect(summarizeFlakiness(context.run.criteria)).toMatchObject({ flakyCriteria: 0 });
  });
});

describe('AC2 — a refused or unhelpful proposal changes nothing', () => {
  it('keeps the original failure when the adapter refuses', async () => {
    const { deps } = scripted([automated([browserProbe('p1')])], async () => ({
      outcome: 'refused',
      reason: 'the payload proposed an assertion edit',
    }));

    const { context } = await run(deps);

    expect(context.run.criteria[0]?.status).toBe('error');
    // Recorded, so a hostile provider is distinguishable from an absent one — but NOT
    // marked adapted, because nothing was.
    expect(context.run.adaptation?.adapted).toBe(false);
    expect(context.run.adaptation?.applied).toEqual([]);
    expect(context.run.adaptation?.refusal?.text).toContain('assertion edit');
  });

  it('keeps the original failure when the proposal names a probe nobody offered', async () => {
    const { deps } = scripted([automated([browserProbe('p1')])], async () => ({
      outcome: 'proposed',
      patches: [{ probeId: 'invented-probe', scenario: WORKING }],
      usage: {
        role: 'mechanics-adapter',
        provider: 'scripted',
        durationMs: 1,
        attempts: 1,
        model: null,
        providerCliVersion: null,
      },
    }));

    const { context } = await run(deps);

    expect(context.run.criteria[0]?.status).toBe('error');
    expect(context.run.adaptation?.adapted).toBe(false);
    expect(context.run.adaptation?.refusal?.text).toMatch(/not offered for adaptation/);
  });

  it('refuses a patch aimed at a probe that PASSED and was never offered', async () => {
    // THE CODEX P1. `adaptCriteria` validates a patch against every probe in the PLAN, which
    // is the right question for the applier and the wrong one for the stage. Without the
    // candidate check a hostile response could name any browser probe it can guess —
    // including one that passed — and the stage would execute provider-chosen mechanics
    // against it. The verdict could not get worse, but a provider would have decided what a
    // browser navigated to on a probe nobody offered it.
    const plan: PlanCriterion[] = [
      {
        criterionId: 'E7-01',
        disposition: 'automated',
        probes: [browserProbe('failing'), browserProbe('already-passing', WORKING)],
      },
    ];
    const { deps, dispatched } = scripted(plan, async () => ({
      outcome: 'proposed',
      // Aimed at the probe that PASSED, so it was never a candidate.
      patches: [{ probeId: 'already-passing', scenario: 'click "#somewhere-else"' }],
      usage: {
        role: 'mechanics-adapter',
        provider: 'scripted',
        durationMs: 1,
        attempts: 1,
        model: null,
        providerCliVersion: null,
      },
    }));

    const { context } = await run(deps);

    expect(context.run.adaptation?.adapted).toBe(false);
    expect(context.run.adaptation?.refusal?.text).toMatch(/not offered for adaptation/);
    // And crucially: the passing probe was executed ONCE, in the first pass only. No
    // provider-chosen mechanics ever reached a browser.
    expect(dispatched.filter((entry) => entry.probeId === 'already-passing')).toHaveLength(1);
    expect(dispatched.every((entry) => entry.scenario !== 'click "#somewhere-else"')).toBe(true);
  });

  it('keeps the original failure when the adapted probe still fails', async () => {
    const { deps, dispatched } = scripted([automated([browserProbe('p1')])], async (candidates) => ({
      outcome: 'proposed',
      patches: candidates.map((c) => ({ probeId: c.probeId, scenario: 'click "#still-wrong"' })),
      usage: {
        role: 'mechanics-adapter',
        provider: 'scripted',
        durationMs: 1,
        attempts: 1,
        model: null,
        providerCliVersion: null,
      },
    }));

    const { context } = await run(deps);

    // It WAS re-executed — and it still did not pass, so the original result stands.
    expect(dispatched).toHaveLength(2);
    expect(context.run.criteria[0]?.status).toBe('error');
    expect(context.run.adaptation?.adapted).toBe(false);
    expect(context.run.adaptation?.applied).toEqual([]);
  });
});

describe('D12, closed by owner decision — which execErrors are adaptable', () => {
  /** Runs one criterion whose only probe errored with the given structured reason. */
  async function runWithReason(reason: 'step-target-missing' | 'unreachable' | 'other' | 'none') {
    const { adapt, offered } = proposeWorking();
    const { deps, dispatched } = scripted([automated([browserProbe('p1')])], adapt, { p1: reason });
    const { context } = await run(deps);
    return { context, dispatched, offered };
  }

  it('ADAPTS a step-target miss — the page answered, and nothing matched', async () => {
    // The motivating case FR-18 exists for, and the one D12 originally could not reach: a
    // relabelled control that a scenario step clicks. 5.2's driver now records WHY it could
    // not look, established by asking the page rather than by reading Playwright's prose.
    const { context, offered, dispatched } = await runWithReason('step-target-missing');

    expect(offered).toEqual([['p1']]);
    expect(context.run.criteria[0]?.status).toBe('pass');
    expect(context.run.adaptation?.adapted).toBe(true);
    expect(dispatched).toHaveLength(2);
  });

  it('REFUSES a dead browser — a page that could not answer is not cosmetic drift', async () => {
    const { context, offered, dispatched } = await runWithReason('unreachable');

    expect(offered).toEqual([]);
    expect(context.run.criteria[0]?.status).toBe('error');
    expect(context.run.adaptation).toBeUndefined();
    // No second dispatch: no quota, and no browser driven at provider-chosen mechanics.
    expect(dispatched).toHaveLength(1);
  });

  it('REFUSES an execError for some other reason', async () => {
    const { context, offered } = await runWithReason('other');

    expect(offered).toEqual([]);
    expect(context.run.criteria[0]?.status).toBe('error');
    expect(context.run.adaptation).toBeUndefined();
  });

  it('⚠️ REFUSES an execError that established NO reason — absence is never adaptable', async () => {
    // The default-deny half, and the one that keeps every other surface (and any future
    // one) excluded without naming them. An executor that did not say is not an executor
    // that said "target missing".
    const { context, offered } = await runWithReason('none');

    expect(offered).toEqual([]);
    expect(context.run.criteria[0]?.status).toBe('error');
    expect(context.run.adaptation).toBeUndefined();
  });
});

describe('⚠️ an ordinary product failure is NEVER adapted', () => {
  it('does not offer a probe whose assertion read an existing but WRONG value', async () => {
    // THE ROUND-4 CODEX P1, and the most important negative case in the story.
    //
    // The probe LOOKED and saw `Orders` where the contract requires `Organizations`. The
    // system under verification is wrong. Offering that to an adapter would invite a
    // provider to rewrite where the probe looks until the unchanged assertion passes
    // somewhere else — the payload schema cannot stop that, because nothing about WHAT MUST
    // BE TRUE is being changed. Only the candidate rule can.
    let called = 0;
    const deps: ProbesStageDeps = {
      criteria: [automated([browserProbe('p1')])],
      data: NO_DATA,
      dispatch: ({ probe, attempt }): ProbeDispatch => ({
        executor: {
          surface: probe.surface,
          execute: async (): Promise<ProbeAttempt> => ({
            attempt,
            observations: [{ name: 'title', value: 'Orders' }],
            // Present, read successfully, and simply not what the contract requires.
            assertionEvaluations: [
              {
                description: 'the organization page appears',
                satisfied: false,
                expected: 'Organizations',
                actual: 'Orders',
              },
            ],
            evidence: [],
            durationMs: 1,
          }),
        },
        params: { probe },
      }),
      adapt: async () => {
        called += 1;
        return { outcome: 'refused', reason: 'unreachable' };
      },
    };

    const { context } = await run(deps);

    expect(context.run.criteria[0]?.status).toBe('fail');
    // Never offered: no provider call, no quota, no marker.
    expect(called).toBe(0);
    expect(context.run.adaptation).toBeUndefined();
    expect(context.run.providerUsage).toEqual([]);
  });
});

describe('the invariant, re-stated after the D12 widening', () => {
  it('never lets an adaptation make a verdict WORSE', async () => {
    // An adapted probe whose re-execution errors must leave the original result standing.
    // The property that survives the widening is "a verdict can only improve".
    let secondPass = false;
    const { deps } = scripted([automated([browserProbe('p1')])], async (candidates) => {
      secondPass = true;
      return {
        outcome: 'proposed',
        patches: candidates.map((c) => ({ probeId: c.probeId, scenario: 'click "#still-wrong"' })),
        usage: {
          role: 'mechanics-adapter',
          provider: 'scripted',
          durationMs: 1,
          attempts: 1,
          model: null,
          providerCliVersion: null,
        },
      };
    });

    const { context } = await run(deps);

    expect(secondPass).toBe(true);
    expect(context.run.criteria[0]?.status).toBe('error');
    expect(context.run.adaptation?.adapted).toBe(false);
  });
});

describe('retries and adaptation, which are different things that can both be true', () => {
  /**
   * A stage whose adapted probe is INTERMITTENT: it fails its first adapted attempt and
   * passes its second. Retries are configured, as a project may.
   */
  function flakyAfterAdaptation(): ProbesStageDeps {
    const { adapt } = proposeWorking();
    let adaptedAttempts = 0;
    return {
      criteria: [automated([browserProbe('p1')])],
      data: NO_DATA,
      // 5.4's feature, on. One extra attempt for a browser probe.
      retries: (surface) => (surface === 'browser' ? 1 : 0),
      dispatch: ({ probe, attempt }): ProbeDispatch => {
        const scenario = (probe as BrowserProbe).mechanics.scenario;
        return {
          executor: {
            surface: probe.surface,
            execute: async (): Promise<ProbeAttempt> => {
              // The ORIGINAL probe cannot find its step target every time — the signal
              // that makes it a candidate at all.
              if (scenario !== WORKING) {
                return {
                  attempt,
                  observations: [],
                  assertionEvaluations: [],
                  evidence: [],
                  execError: {
                    message: 'the step could not find its target',
                    reason: 'step-target-missing',
                  },
                  durationMs: 1,
                };
              }
              // The ADAPTED probe is INTERMITTENT: its first attempt fails, its second
              // passes. Same mechanics across both, so this really is 5.4 flake.
              adaptedAttempts += 1;
              const satisfied = adaptedAttempts > 1;
              return {
                attempt,
                observations: [],
                assertionEvaluations: [
                  {
                    description: 'the organization page appears',
                    satisfied,
                    expected: 'Organizations',
                    actual: satisfied ? 'Organizations' : 'Orders',
                  },
                ],
                evidence: [],
                durationMs: 1,
              };
            },
          },
          params: { probe },
        };
      },
      adapt,
    };
  }

  it('reports flake WITHIN an adapted execution, because that really is flake', async () => {
    // Those attempts ran the SAME (adapted) probe, so repetition is exactly what they are.
    // 5.4's vocabulary means repetition of an unchanged probe, and here the probe did not
    // change between them. Reporting it is honest; suppressing it would hide a genuinely
    // intermittent adapted probe.
    const { context } = await run(flakyAfterAdaptation());

    expect(context.run.criteria[0]?.status).toBe('pass');
    expect(context.run.adaptation?.adapted).toBe(true);
    expect(context.run.criteria[0]?.flaky).toBe(true);
  });

  it('never builds the CROSS-MECHANICS pair, at any retry setting', async () => {
    // The property the supervisor's finding is actually about, and the one that must hold
    // whatever `retries` says: the ORIGINAL failure never joins the adapted attempt list.
    // Every attempt recorded on the criterion comes from the adapted execution, so the
    // earliest of them is numbered past the first pass rather than being attempt 1.
    const { context } = await run(flakyAfterAdaptation());

    const attempts = context.run.criteria[0]?.attempts ?? [];
    expect(attempts.length).toBeGreaterThan(0);
    // The first pass took one attempt (numbered 1); every attempt here is later than that.
    expect(Math.min(...attempts.map((record) => record.attempt))).toBeGreaterThan(1);
  });

  it('with retries OFF, an adapted pass carries no flake at all', async () => {
    // The default, and the case the supervisor's instruction named.
    const { adapt } = proposeWorking();
    const { deps } = scripted([automated([browserProbe('p1')])], adapt);

    const { context } = await run(deps);

    expect(context.run.criteria[0]?.status).toBe('pass');
    expect(context.run.criteria[0]?.flaky).toBeUndefined();
    expect(context.run.criteria[0]?.attempts).toBeUndefined();
    expect(summarizeFlakiness(context.run.criteria)).toMatchObject({ flakyCriteria: 0 });
  });
});

describe('⚠️ multi-probe criteria — eligibility and acceptance are PER PROBE', () => {
  /** The candidate objects the most recent `mixedCriterion()` adapter was handed. */
  let capturedCandidates: AdaptationCandidate[] = [];

  /**
   * A criterion with TWO browser probes: one that could not find its step target (eligible),
   * and one that merely failed an assertion (an ordinary product failure, never eligible).
   *
   * `select` resolves this criterion to `fail`, because `PROBE_PRECEDENCE` puts `fail` above
   * `error` — which is exactly the shape that used to hide the eligible probe.
   */
  function mixedCriterion(): { deps: ProbesStageDeps; offered: string[][] } {
    const { adapt, offered, seen } = proposeWorking();
    capturedCandidates = seen;
    return {
      offered,
      deps: {
        criteria: [
          {
            criterionId: 'E7-01',
            disposition: 'automated',
            probes: [browserProbe('missing-target'), browserProbe('plain-failure')],
          },
        ],
        data: NO_DATA,
        dispatch: ({ probe, attempt }): ProbeDispatch => {
          const scenario = (probe as BrowserProbe).mechanics.scenario;
          return {
            executor: {
              surface: probe.surface,
              execute: async (): Promise<ProbeAttempt> => {
                if (probe.id === 'plain-failure') {
                  // Reads a real value that is simply wrong. Never adaptable.
                  return {
                    attempt,
                    observations: [{ name: 'title', value: 'Orders' }],
                    assertionEvaluations: [
                      {
                        description: 'the organization page appears',
                        satisfied: false,
                        expected: 'Organizations',
                        actual: 'Orders',
                      },
                    ],
                    evidence: [],
                    durationMs: 1,
                  };
                }
                if (scenario !== WORKING) {
                  return {
                    attempt,
                    observations: [],
                    assertionEvaluations: [],
                    evidence: [],
                    execError: {
                      message: 'the step could not find its target',
                      reason: 'step-target-missing',
                    },
                    durationMs: 1,
                  };
                }
                return {
                  attempt,
                  observations: [],
                  assertionEvaluations: [
                    {
                      description: 'the organization page appears',
                      satisfied: true,
                      expected: 'Organizations',
                      actual: 'Organizations',
                    },
                  ],
                  evidence: [],
                  durationMs: 1,
                };
              },
            },
            params: { probe },
          };
        },
        adapt,
      },
    };
  }

  it('offers the eligible probe even though the CRITERION resolved to fail', async () => {
    // THE ROUND-5 P2. `select` gives this criterion `fail` because a fail outranks an error,
    // and an aggregate guard skipped the eligible probe because of a sibling result that was
    // not about it. Eligibility is a fact about one probe's own attempt.
    const { deps, offered } = mixedCriterion();

    const { context } = await run(deps);

    expect(offered).toEqual([['missing-target']]);
    // The plain failure was never offered, so the product failure stays a product failure.
    expect(offered[0]).not.toContain('plain-failure');
    expect(context.run.criteria[0]?.status).toBe('fail');
  });

  it('sends the candidate its OWN diagnostics, never a sibling probe result', async () => {
    // Found by re-reading `adaptationCandidates` after the round-5 review rather than by a
    // reviewer, and it is the same mistake in a third place: `record.result` is the
    // AGGREGATE, chosen by PROBE_PRECEDENCE. Here the aggregate is the PLAIN FAILURE's
    // (`actual: 'Orders'`), because a fail outranks an error — so the candidate for
    // `missing-target` would have described a different probe's product failure to the
    // adapter, and leaked one probe's observed values into a prompt about another.
    const { deps, offered } = mixedCriterion();

    const { context } = await run(deps);

    expect(offered).toEqual([['missing-target']]);
    const candidate = capturedCandidates.at(-1);
    expect(candidate?.probeId).toBe('missing-target');
    // Its own execError, not the sibling's observed value.
    expect(candidate?.actual).toContain('could not find its target');
    expect(candidate?.actual).not.toContain('Orders');
    expect(context.run.adaptation?.adapted).toBe(true);
  });

  it('keeps the adaptation that WORKED even though a sibling keeps the criterion failing', async () => {
    // The second round-5 P2. Comparing the recomputed CRITERION against `pass` discarded a
    // proposal that genuinely fixed one probe, and then recorded that nothing had been
    // applied — false, because a browser really ran it and that probe really passed.
    const { deps } = mixedCriterion();

    const { context } = await run(deps);

    expect(context.run.adaptation?.adapted).toBe(true);
    expect(context.run.adaptation?.applied.map((change) => change.probeId)).toEqual([
      'missing-target',
    ]);
    // And the criterion still fails, honestly, because of the sibling.
    expect(context.run.criteria[0]?.status).toBe('fail');
  });
});

describe('⚠️ nothing unredacted reaches the provider', () => {
  it('scrubs a secret out of the scenario before it becomes a candidate', async () => {
    // THE ROUND-7 CODEX P1, and the most dangerous finding in the branch after the
    // candidate-rule one, because it leaves the machine.
    //
    // Plan content is not automatically safe to send just because a human wrote it:
    // `fill "#password" "..."` is an ordinary plan line. This story already redacted the
    // SAME two strings in the audit record and did not redact the copy it sent to a
    // provider — an audit record stays on the operator's disk, a prompt does not.
    //
    // ⚠️ Asserted as the secret being ABSENT, never as `[REDACTED]` being present (Epic 3
    // retro section 7): a test that looks for the marker passes just as happily when the
    // marker was added beside the secret rather than instead of it.
    const secret = 'NOTAREALKEY-0123456789abcdefghij';
    const probe: BrowserProbe = {
      id: 'p1',
      surface: 'browser',
      mechanics: {
        serviceId: 'backend',
        path: `/login?token=${secret}`,
        scenario: `fill "#password" "${secret}"\nclick "#create-company"`,
      },
      assertions: [
        {
          description: 'the organization page appears',
          target: { source: 'title' },
          comparison: 'equals',
          expected: 'Organizations',
        },
      ],
    };

    const { adapt, seen } = proposeWorking();
    const deps: ProbesStageDeps = {
      criteria: [{ criterionId: 'E7-01', disposition: 'automated', probes: [probe] }],
      data: NO_DATA,
      // A config-declared extra pattern, which is how AD-10 lets a project name the shape
      // of its own secrets (`RedactionOptions.extraPatterns`).
      redaction: { extraPatterns: [new RegExp(secret, 'g')] },
      dispatch: ({ probe: dispatched, attempt }): ProbeDispatch => ({
        executor: {
          surface: dispatched.surface,
          execute: async (): Promise<ProbeAttempt> => ({
            attempt,
            observations: [],
            assertionEvaluations: [],
            evidence: [],
            execError: {
              message: 'the step could not find its target',
              reason: 'step-target-missing',
            },
            durationMs: 1,
          }),
        },
        params: { probe: dispatched },
      }),
      adapt,
    };

    await run(deps);

    const candidate = seen.at(-1);
    expect(candidate).toBeDefined();
    // The secret is GONE from everything that leaves the machine.
    expect(candidate?.scenario).not.toContain(secret);
    expect(candidate?.path).not.toContain(secret);
    expect(JSON.stringify(candidate)).not.toContain(secret);
    // And the mechanics are still recognisable enough to adapt against.
    expect(candidate?.scenario).toContain('#create-company');
  });
});

describe('probe ids reused across criteria', () => {
  /** Two criteria, both declaring `shared-id`. Legal: ids are unique per criterion only. */
  function reusedId(bothFail: boolean): { deps: ProbesStageDeps; offered: string[][] } {
    const { adapt, offered } = proposeWorking();
    return {
      offered,
      deps: {
        criteria: [
          { criterionId: 'E7-01', disposition: 'automated', probes: [browserProbe('shared-id')] },
          {
            criterionId: 'E7-02',
            disposition: 'automated',
            // When only ONE is meant to be a candidate, the other already works.
            probes: [browserProbe('shared-id', bothFail ? BROKEN : WORKING)],
          },
        ],
        data: NO_DATA,
        dispatch: ({ probe, attempt }): ProbeDispatch => {
          const scenario = (probe as BrowserProbe).mechanics.scenario;
          return {
            executor: {
              surface: probe.surface,
              execute: async (): Promise<ProbeAttempt> => {
                if (scenario !== WORKING) {
                  return {
                    attempt,
                    observations: [],
                    assertionEvaluations: [],
                    evidence: [],
                    execError: {
                      message: 'the step could not find its target',
                      reason: 'step-target-missing',
                    },
                    durationMs: 1,
                  };
                }
                return {
                  attempt,
                  observations: [],
                  assertionEvaluations: [
                    {
                      description: 'the organization page appears',
                      satisfied: true,
                      expected: 'Organizations',
                      actual: 'Organizations',
                    },
                  ],
                  evidence: [],
                  durationMs: 1,
                };
              },
            },
            params: { probe },
          };
        },
        adapt,
      },
    };
  }

  it('adapts the one eligible namesake, and leaves the other criterion alone', async () => {
    const { deps, offered } = reusedId(false);
    const context = await (async () => {
      const ctx = stageContext();
      ctx.run.contractCriteria.push(CRITERION, { ...CRITERION, criterionId: 'E7-02' });
      await createProbesStage(deps).run(ctx);
      return ctx;
    })();

    expect(offered).toEqual([['shared-id']]);
    expect(context.run.adaptation?.adapted).toBe(true);
    // Applied to E7-01, the criterion that actually failed.
    expect(context.run.adaptation?.applied[0]?.criterionId).toBe('E7-01');
    expect(context.run.criteria[0]?.status).toBe('pass');
    expect(context.run.criteria[1]?.status).toBe('pass');
  });

  it('⚠️ never re-executes or replaces an unchanged NAMESAKE in another criterion', async () => {
    // THE ROUND-10 CODEX P1, and a green-for-nothing route through the audit's blind spot.
    //
    // `adaptCriteria` patches only the SCOPED criterion's probe, but the stage tracked
    // changed probes by BARE ID — so every namesake was re-executed, in criteria nothing was
    // proposed for. An unchanged namesake that failed an assertion and then passed on that
    // extra execution would have its result replaced, turning an UNRELATED criterion into a
    // pass with NO recorded mechanics change.
    //
    // Here E7-02's `shared-id` is a flaky product failure: it fails first and would pass if
    // run again. It must never be run again.
    let e2Runs = 0;
    const { adapt } = proposeWorking();
    const deps: ProbesStageDeps = {
      criteria: [
        { criterionId: 'E7-01', disposition: 'automated', probes: [browserProbe('shared-id')] },
        { criterionId: 'E7-02', disposition: 'automated', probes: [browserProbe('shared-id')] },
      ],
      data: NO_DATA,
      dispatch: ({ criterionId, probe, attempt }): ProbeDispatch => {
        const scenario = (probe as BrowserProbe).mechanics.scenario;
        return {
          executor: {
            surface: probe.surface,
            execute: async (): Promise<ProbeAttempt> => {
              if (criterionId === 'E7-02') {
                e2Runs += 1;
                // Fails the first time, would pass the second. Never adapted, so never rerun.
                const satisfied = e2Runs > 1;
                return {
                  attempt,
                  observations: [],
                  assertionEvaluations: [
                    {
                      description: 'the organization page appears',
                      satisfied,
                      expected: 'Organizations',
                      actual: satisfied ? 'Organizations' : 'Orders',
                    },
                  ],
                  evidence: [],
                  durationMs: 1,
                };
              }
              if (scenario !== WORKING) {
                return {
                  attempt,
                  observations: [],
                  assertionEvaluations: [],
                  evidence: [],
                  execError: {
                    message: 'the step could not find its target',
                    reason: 'step-target-missing',
                  },
                  durationMs: 1,
                };
              }
              return {
                attempt,
                observations: [],
                assertionEvaluations: [
                  {
                    description: 'the organization page appears',
                    satisfied: true,
                    expected: 'Organizations',
                    actual: 'Organizations',
                  },
                ],
                evidence: [],
                durationMs: 1,
              };
            },
          },
          params: { probe },
        };
      },
      adapt,
    };

    const context = await (async () => {
      const ctx = stageContext();
      ctx.run.contractCriteria.push(CRITERION, { ...CRITERION, criterionId: 'E7-02' });
      await createProbesStage(deps).run(ctx);
      return ctx;
    })();

    // E7-01 was adapted and passes.
    expect(context.run.criteria[0]?.status).toBe('pass');
    expect(context.run.adaptation?.applied.map((change) => change.criterionId)).toEqual(['E7-01']);
    // ⚠️ E7-02 ran EXACTLY ONCE and kept its failure. If the namesake had been re-executed it
    // would have passed on the second run and this criterion would have flipped to `pass`
    // with nothing in the audit to explain it.
    expect(e2Runs).toBe(1);
    expect(context.run.criteria[1]?.status).toBe('fail');
  });

  it('offers NEITHER when both namesakes are eligible — a proposal could not say which', async () => {
    // A proposal names an id and nothing else, so no scope can disambiguate this case.
    // Dropped rather than guessed at: adapting the wrong probe because two share a name is
    // worse than adapting neither, and the alternative would put a criterion id in the
    // payload whose absence is part of this story's claim.
    const { deps, offered } = reusedId(true);
    const context = await (async () => {
      const ctx = stageContext();
      ctx.run.contractCriteria.push(CRITERION, { ...CRITERION, criterionId: 'E7-02' });
      await createProbesStage(deps).run(ctx);
      return ctx;
    })();

    expect(offered).toEqual([]);
    expect(context.run.adaptation).toBeUndefined();
    expect(context.run.providerUsage).toEqual([]);
    expect(context.run.criteria[0]?.status).toBe('error');
    expect(context.run.criteria[1]?.status).toBe('error');
  });
});

describe('the codex findings', () => {
  it('offsets the adapted attempt past the first pass, so evidence cannot be overwritten', async () => {
    // P1. `src/surfaces/browser.ts` derives evidence filenames from criterion id, probe id
    // AND attempt number. A re-execution restarting at attempt 1 would overwrite the first
    // pass's trace and screenshot — so a FAILED adaptation would leave the retained original
    // failure pointing at evidence captured from the adapted run.
    //
    // Asserted on the attempt NUMBER the executor was handed, which is the value the
    // filename is built from.
    const seen: number[] = [];
    const { adapt } = proposeWorking();
    const deps: ProbesStageDeps = {
      criteria: [automated([browserProbe('p1')])],
      data: NO_DATA,
      dispatch: ({ probe, attempt }): ProbeDispatch => {
        seen.push(attempt);
        const scenario = (probe as BrowserProbe).mechanics.scenario;
        return {
          executor: {
            surface: probe.surface,
            execute: async (): Promise<ProbeAttempt> => {
              if (scenario !== WORKING) {
                return {
                  attempt,
                  observations: [],
                  assertionEvaluations: [],
                  evidence: [],
                  execError: {
                    message: 'the step could not find its target',
                    reason: 'step-target-missing',
                  },
                  durationMs: 1,
                };
              }
              return {
                attempt,
                observations: [],
                assertionEvaluations: [
                  {
                    description: 'the organization page appears',
                    satisfied: true,
                    expected: 'Organizations',
                    actual: 'Organizations',
                  },
                ],
                evidence: [],
                durationMs: 1,
              };
            },
          },
          params: { probe },
        };
      },
      adapt,
    };

    await run(deps);

    // First pass attempt 1; the adapted re-execution is attempt 2, not attempt 1 again.
    expect(seen).toEqual([1, 2]);
  });

  it('records a change that was executed and then DISCARDED', async () => {
    // P2. One payload, two criteria, only one improving. The changes that were executed but
    // not kept must still appear in the audit — omitting them left the run marked adapted
    // while a browser had genuinely run provider-chosen mechanics that vanished from the
    // record.
    const criteria: PlanCriterion[] = [
      { criterionId: 'E7-01', disposition: 'automated', probes: [browserProbe('fixable')] },
      { criterionId: 'E7-02', disposition: 'automated', probes: [browserProbe('unfixable')] },
    ];
    const { deps } = scripted(criteria, async (candidates) => ({
      outcome: 'proposed',
      patches: candidates.map((candidate) => ({
        probeId: candidate.probeId,
        // Only the first proposal actually works.
        scenario: candidate.probeId === 'fixable' ? WORKING : 'click "#no-better"',
      })),
      usage: {
        role: 'mechanics-adapter',
        provider: 'scripted',
        durationMs: 1,
        attempts: 1,
        model: null,
        providerCliVersion: null,
      },
    }));

    const context = await (async () => {
      const ctx = stageContext();
      ctx.run.contractCriteria.push(CRITERION, { ...CRITERION, criterionId: 'E7-02' });
      await createProbesStage(deps).run(ctx);
      return ctx;
    })();

    expect(context.run.adaptation?.adapted).toBe(true);
    expect(context.run.adaptation?.applied.map((change) => change.probeId)).toEqual(['fixable']);
    // The executed-and-thrown-away half is recorded rather than silently dropped.
    expect(context.run.adaptation?.discarded?.map((change) => change.probeId)).toEqual([
      'unfixable',
    ]);
    // And the criterion it belonged to kept its original failure.
    expect(context.run.criteria[1]?.status).toBe('error');
  });
});
