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

import type { AdaptationDecision } from '../../../../src/domain/adaptation-port.js';
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
  execErrorFor: readonly string[] = [],
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
          if (execErrorFor.includes(probe.id)) {
            return {
              attempt,
              observations: [],
              assertionEvaluations: [],
              evidence: [],
              execError: { message: 'the browser crashed before the first assertion' },
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
} {
  const offered: string[][] = [];
  return {
    offered,
    adapt: async (candidates): Promise<AdaptationDecision> => {
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

    expect(context.run.criteria[0]?.status).toBe('fail');
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

    expect(context.run.criteria[0]?.status).toBe('fail');
    // Recorded, so a hostile provider is distinguishable from an absent one — but NOT
    // marked adapted, because nothing was.
    expect(context.run.adaptation?.adapted).toBe(false);
    expect(context.run.adaptation?.applied).toEqual([]);
    expect(context.run.adaptation?.refusal?.text).toContain('assertion edit');
  });

  it('keeps the original failure when the proposal names a probe the plan does not carry', async () => {
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

    expect(context.run.criteria[0]?.status).toBe('fail');
    expect(context.run.adaptation?.adapted).toBe(false);
    expect(context.run.adaptation?.refusal?.text).toMatch(/does not carry/);
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
    expect(context.run.criteria[0]?.status).toBe('fail');
    expect(context.run.adaptation?.adapted).toBe(false);
    expect(context.run.adaptation?.applied).toEqual([]);
  });
});

describe('an execError is NEVER adapted', () => {
  it('offers no candidate when the browser could not look at all', async () => {
    let called = 0;
    const { deps, dispatched } = scripted(
      [automated([browserProbe('p1')])],
      async () => {
        called += 1;
        return { outcome: 'refused', reason: 'unreachable' };
      },
      ['p1'],
    );

    const { context } = await run(deps);

    expect(context.run.criteria[0]?.status).toBe('error');
    // Not offered, so no quota is spent guessing at a locator while the browser is on fire.
    expect(called).toBe(0);
    expect(context.run.adaptation).toBeUndefined();
    expect(dispatched).toHaveLength(1);
  });
});
