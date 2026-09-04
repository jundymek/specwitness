/**
 * Story 5.6, AC2 — **the headline test: a hostile provider gets nothing.**
 *
 * The whole chain, assembled from real parts and driven by the SHIPPED `fake` adapter:
 *
 *   `src/providers/fake.ts`   the config-selectable product feature, reading raw responses
 *                             from a fixture directory. Its own header says its fixtures are
 *                             "deliberately allowed to be invalid; rejecting them is the
 *                             gate's job" — which is exactly what is under test here.
 *   `src/providers/invoke.ts` the ONE merged gate. Not stubbed, not bypassed.
 *   `src/schemas/adaptation.ts` the payload schema. The boundary itself.
 *   `src/authoring/adaptation.ts` the flow.
 *   `src/pipeline/stages/probes.ts` the real stage, with the real applier.
 *
 * Only the SURFACE is a double, because a browser is not what this file is about:
 * `tests/integration/surfaces/browser-adaptation.test.ts` drives a real chromium.
 *
 * WHAT EACH FIXTURE PROVES is named in the table below, and every one of them must end the
 * same way: **the criterion keeps its original failure, the exit-code-bearing status is
 * unchanged, the run is NOT marked `adapted`, and nothing partially applies.**
 *
 * ⚠️ Each fixture is a ONE-ENTRY script, so the fake repeats the same hostile payload on
 * every one of the gate's three attempts. That is deliberate: a provider that gives up and
 * complies on attempt two would prove much less than one that never does.
 *
 * AD-12: no real `claude` or `codex` is invoked; the fake spawns nothing at all.
 */

import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createMechanicsAdapter } from '../../src/authoring/adaptation.js';
import type {
  ContractCriterionRef,
  ProbeAttempt,
  SurfaceExecutor,
} from '../../src/domain/criterion-result.js';
import type { BrowserProbe, PlanCriterion } from '../../src/domain/plan.js';
import { resolvePlanData } from '../../src/domain/plan-data.js';
import type { ProviderDeps } from '../../src/domain/agent-provider.js';
import { createFakeProvider } from '../../src/providers/fake.js';
import { createProbesStage } from '../../src/pipeline/stages/probes.js';
import type { ProbeDispatch, ProbesStageDeps } from '../../src/pipeline/stages/probes.js';
import { SystemClock } from '../../src/infra/clock.js';
import { stageContext } from '../unit/pipeline/stages/services.helpers.js';

const CRITERION: ContractCriterionRef = {
  criterionId: 'E7-01',
  statement: 'a user can create an organization',
  severity: 'critical',
  verifiability: 'automated',
};

const NO_DATA = resolvePlanData({ seed: 'seed0000', bindings: [] });

/** The only scenario the doubled surface accepts. Nothing a fixture proposes reaches it. */
const WORKING = 'click "#add-organization"';
const BROKEN = 'click "#create-company"';

const PROBE: BrowserProbe = {
  id: 'submit-order',
  surface: 'browser',
  mechanics: { serviceId: 'backend', path: '/orders', scenario: BROKEN },
  assertions: [
    {
      description: 'the organizations page is reached',
      target: { source: 'title' },
      comparison: 'equals',
      expected: 'Organizations',
    },
  ],
};

/**
 * A SECOND probe, so `adapt-mixed` can name two probes the plan really carries.
 *
 * Its presence is load-bearing rather than decorative. With the illegal half of the mixed
 * payload naming a probe the plan LACKED, the applier's unknown-probe refusal did the work
 * and the test passed even against a neutered schema — found by planting a deliberately
 * broken validator and noticing which tests did NOT go red. Now the only thing that can stop
 * the legal half being applied is wholesale rejection, which is what AC2 actually asks for.
 * The planting table in the Dev Agent Record records both dead ends.
 */
const CONFIRM_PROBE: BrowserProbe = {
  id: 'confirm-order',
  surface: 'browser',
  // It PASSES from the start, so the criterion's status tracks `submit-order` alone and a
  // second failing probe cannot mask the adaptation under `PROBE_PRECEDENCE`.
  mechanics: { serviceId: 'backend', path: '/orders', scenario: WORKING },
  assertions: [
    {
      description: 'the confirmation appears',
      target: { source: 'title' },
      comparison: 'equals',
      expected: 'Organizations',
    },
  ],
};

const CRITERIA: readonly PlanCriterion[] = [
  {
    criterionId: CRITERION.criterionId,
    disposition: 'automated',
    probes: [PROBE, CONFIRM_PROBE],
  },
];

/**
 * The shipped fake, pointed at one adversarial fixture directory.
 *
 * `mode` IS the fixture directory — the fake's documented configuration, reused rather than
 * given a schema of its own. An absolute path so the suite does not depend on the process
 * working directory.
 */
function adapterFor(fixture: string) {
  const provider = createFakeProvider(
    { name: 'hostile', adapter: 'fake', mode: resolve('tests/fixtures/providers', fixture) },
    // The fake spawns nothing and warns about nothing — its own header calls that "precisely
    // the property AC3's no-subprocess guard asserts". These are the real shapes rather than
    // casts, so a change to `ProviderDeps` breaks this file loudly instead of silently.
    {
      processRunner: {
        run: async () => {
          throw new Error('the fake provider must never spawn a subprocess (AD-12)');
        },
      } as unknown as ProviderDeps['processRunner'],
      clock: new SystemClock(),
      warn: () => undefined,
    },
  );
  return createMechanicsAdapter({ provider, clock: new SystemClock() });
}

/** A stage whose probe passes iff its scenario is `WORKING`. */
function stageWith(adapt: ProbesStageDeps['adapt']): ProbesStageDeps {
  return {
    criteria: CRITERIA,
    data: NO_DATA,
    dispatch: ({ probe, attempt }): ProbeDispatch => {
      const scenario = (probe as BrowserProbe).mechanics.scenario;
      const executor: SurfaceExecutor = {
        surface: probe.surface,
        execute: async (): Promise<ProbeAttempt> => {
          const satisfied = scenario === WORKING;
          return {
            attempt,
            observations: [{ name: 'title', value: satisfied ? 'Organizations' : 'Orders' }],
            assertionEvaluations: [
              {
                description: 'the organizations page is reached',
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
}

async function runWith(fixture: string) {
  const context = stageContext();
  context.run.contractCriteria.push(CRITERION);
  await createProbesStage(stageWith(adapterFor(fixture))).run(context);
  return context;
}

/** Every hostile fixture, and the single sentence each one exists to prove. */
const HOSTILE: readonly [fixture: string, proves: string][] = [
  ['adapt-assertion-edit', 'an assertion edit is rejected wholesale'],
  ['adapt-expected-edit', 'an expected-value edit is rejected'],
  ['adapt-assertion-added', 'an ADDED assertion is rejected'],
  ['adapt-assertion-removed', 'a REMOVED assertion is rejected — deletion is an edit too'],
  ['adapt-identity', 'a probe id, surface or criterionId change is rejected'],
  ['adapt-url', 'a URL cannot be introduced (AD-3)'],
  ['adapt-host', 'the backslash host escape is rejected by the imported path rule'],
  ['adapt-command', 'a command string cannot be introduced (AD-3)'],
  ['adapt-service-repoint', 'the origin binding cannot be repointed (D2)'],
  ['adapt-not-json', 'prose instead of a payload is refused'],
];

describe('AC2 — a hostile provider gets nothing', () => {
  it.each(HOSTILE)('%s: %s', async (fixture) => {
    const context = await runWith(fixture);

    // 1. The criterion keeps its ORIGINAL failure.
    expect(context.run.criteria).toHaveLength(1);
    expect(context.run.criteria[0]?.status).toBe('fail');
    // Its original evidence, too — expected/actual are the first pass's.
    expect(context.run.criteria[0]?.actual).toBe('Orders');

    // 2. The run is NOT marked adapted. Marking a refused proposal would be a lie in the
    //    one direction that matters.
    expect(context.run.adaptation?.adapted).toBe(false);

    // 3. Nothing partially applied.
    expect(context.run.adaptation?.applied).toEqual([]);

    // 4. The refusal IS recorded, so a hostile provider is distinguishable from an absent
    //    one — and it is redacted and bounded like everything else.
    expect(context.run.adaptation?.refusal?.text).toBeTruthy();

    // 5. The quota it cost is visible (FR-15). Three attempts, all refused.
    expect(context.run.providerUsage).toHaveLength(1);
    expect(context.run.providerUsage[0]?.attempts).toBe(3);
    expect(context.run.providerUsage[0]?.role).toBe('mechanics-adapter');
  });

  it('adapt-mixed: one legal proposal beside one illegal one is rejected ENTIRELY', async () => {
    // The single most important negative case. `adapt-mixed` proposes a PERFECTLY LEGAL
    // scenario change for `submit-order` alongside an expected-value edit for another
    // probe. If anything salvaged the legal half, this criterion would PASS.
    const context = await runWith('adapt-mixed');

    expect(context.run.criteria[0]?.status).toBe('fail');
    expect(context.run.adaptation?.adapted).toBe(false);
    expect(context.run.adaptation?.applied).toEqual([]);
  });

  it('adapt-unknown-probe: a schema-legal payload naming a probe nobody offered is refused', async () => {
    // Past the schema, refused by the STAGE's candidate check — which fires before the
    // applier's own "the plan does not carry this" refusal and is the stronger of the two.
    // The applier's check is still there and still tested (`adaptation-apply.test.ts`); it
    // is the second lock, and this is the first.
    const context = await runWith('adapt-unknown-probe');

    expect(context.run.criteria[0]?.status).toBe('fail');
    expect(context.run.adaptation?.adapted).toBe(false);
    expect(context.run.adaptation?.refusal?.text).toMatch(/not offered for adaptation/);
  });
});

describe('over-refusal — the feature actually works', () => {
  it('adapt-legal: a mechanics-only proposal IS accepted, applied and recorded', async () => {
    // A suite that only ever rejects proves nothing: `z.never()` would pass every test
    // above. This is the one that says the boundary is a boundary and not a wall.
    const context = await runWith('adapt-legal');

    expect(context.run.criteria[0]?.status).toBe('pass');
    expect(context.run.adaptation?.adapted).toBe(true);
    expect(context.run.adaptation?.applied).toEqual([
      {
        criterionId: 'E7-01',
        probeId: 'submit-order',
        field: 'scenario',
        from: { text: BROKEN, truncated: false, totalBytes: BROKEN.length },
        to: { text: WORKING, truncated: false, totalBytes: WORKING.length },
      },
    ]);
    // One attempt, because the payload was valid first time.
    expect(context.run.providerUsage[0]?.attempts).toBe(1);

    // ⚠️ And it is NOT reported as flake: a retry repeats an unchanged probe, an adaptation
    // changes it. 5.4's vocabulary is untouched.
    expect(context.run.criteria[0]?.flaky).toBeUndefined();
    expect(context.run.criteria[0]?.attempts).toBeUndefined();
  });
});
