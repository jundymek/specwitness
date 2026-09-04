/**
 * Story 5.6, AC1 + AC2 — applying a proposal to a plan COPY.
 *
 * The two properties this file exists to prove:
 *
 *  1. **The original is untouched.** Asserted on the SERIALIZED BYTES of the plan, before
 *     and after — not on the absence of an exception. An applier that mutated its input
 *     in place would throw nothing at all, so "it did not throw" proves nothing about the
 *     thing that matters. Verified red by making the applier mutate the input; see the
 *     planting table in the Dev Agent Record.
 *  2. **Assertions do not move.** Not merely "are equal to" — the adapted probe's
 *     `assertions` is the SAME ARRAY OBJECT as the original's. Value equality would still
 *     pass if a future refactor rebuilt the array from a provider-supplied source that
 *     happened to match; identity would not.
 */

import { describe, expect, it } from 'vitest';

import {
  AdaptationRefused,
  applyAdaptation,
  type MechanicsPatch,
} from '../../../src/domain/adaptation-apply.js';
import type { BrowserProbe, Plan, PlanCriterion } from '../../../src/domain/plan.js';
import { serializePlan } from '../../../src/schemas/plan.js';

function browserProbe(id: string, path = '/orders', scenario = 'click "#create-company"'): BrowserProbe {
  return {
    id,
    surface: 'browser',
    mechanics: { serviceId: 'backend', path, scenario },
    assertions: [
      { description: 'the title', target: { source: 'title' }, comparison: 'equals', expected: 'Orders' },
    ],
  };
}

function planWith(criteria: readonly PlanCriterion[]): Plan {
  return {
    plan: {
      epic: 'epic-7',
      contract: { version: 1, fingerprint: 'sha256:abc' },
      data: { seed: 'seed-epic-7-aaaa', bindings: [] },
      criteria,
    },
    meta: {
      schemaVersion: 1,
      provenance: { provider: null, adapter: null, model: null, generatedAt: null },
    },
  } as unknown as Plan;
}

const basePlan = planWith([
  { criterionId: 'E7-01', disposition: 'automated', probes: [browserProbe('submit-order')] },
]);

/** The probes of an automated criterion, or `undefined` for a human arm. */
function probesOf(plan: Plan, index: number): readonly BrowserProbe[] | undefined {
  const criterion = plan.plan.criteria[index];
  return criterion?.disposition === 'automated'
    ? (criterion.probes as readonly BrowserProbe[])
    : undefined;
}

describe('AC1 — the proposal is applied to a COPY', () => {
  it('leaves the original plan BYTE-IDENTICAL', () => {
    const before = serializePlan(basePlan);

    applyAdaptation(basePlan, [{ probeId: 'submit-order', scenario: 'click "#add-organization"' }]);

    expect(serializePlan(basePlan)).toBe(before);
  });

  it('returns a new plan carrying only the proposed change', () => {
    const { plan, changes } = applyAdaptation(basePlan, [
      { probeId: 'submit-order', scenario: 'click "#add-organization"' },
    ]);

    expect(probesOf(plan, 0)?.[0]?.mechanics).toEqual({
      serviceId: 'backend',
      path: '/orders',
      scenario: 'click "#add-organization"',
    });
    expect(changes).toEqual([
      {
        criterionId: 'E7-01',
        probeId: 'submit-order',
        field: 'scenario',
        from: 'click "#create-company"',
        to: 'click "#add-organization"',
      },
    ]);
  });

  it('adapts a path, and reports both fields when both move', () => {
    const { changes } = applyAdaptation(basePlan, [
      { probeId: 'submit-order', path: '/organizations', scenario: 'click "#add-organization"' },
    ]);

    expect(changes.map((change) => change.field).sort()).toEqual(['path', 'scenario']);
  });

  it('leaves an unproposed probe untouched, by reference', () => {
    const plan = planWith([
      {
        criterionId: 'E7-01',
        disposition: 'automated',
        probes: [browserProbe('adapted-probe'), browserProbe('other-probe')],
      },
    ]);
    const untouchedBefore = probesOf(plan, 0)?.[1];

    const { plan: adapted } = applyAdaptation(plan, [
      { probeId: 'adapted-probe', scenario: 'click "#x"' },
    ]);

    expect(probesOf(adapted, 0)?.[1]).toBe(untouchedBefore);
  });

  it('leaves a needs-human criterion untouched, by reference', () => {
    const humanArm: PlanCriterion = {
      criterionId: 'E7-02',
      disposition: 'needs-human',
      reason: 'not-safely-automatable',
      guidance: 'a human checks the receipt looks right',
    };
    const plan = planWith([
      { criterionId: 'E7-01', disposition: 'automated', probes: [browserProbe('submit-order')] },
      humanArm,
    ]);

    const { plan: adapted } = applyAdaptation(plan, [
      { probeId: 'submit-order', scenario: 'click "#x"' },
    ]);

    expect(adapted.plan.criteria[1]).toBe(humanArm);
  });
});

describe('AC2 — WHAT MUST BE TRUE does not move', () => {
  it('carries the assertions array through BY IDENTITY, not by value', () => {
    const originalAssertions = probesOf(basePlan, 0)?.[0]?.assertions;

    const { plan } = applyAdaptation(basePlan, [
      { probeId: 'submit-order', scenario: 'click "#add-organization"' },
    ]);

    // Identity, deliberately. Value equality would still hold if a refactor rebuilt this
    // array from provider-supplied content that happened to match.
    expect(probesOf(plan, 0)?.[0]?.assertions).toBe(originalAssertions);
  });

  it('leaves the probe id, surface and serviceId exactly as compiled', () => {
    const { plan } = applyAdaptation(basePlan, [
      { probeId: 'submit-order', path: '/organizations', scenario: 'click "#x"' },
    ]);
    const probe = probesOf(plan, 0)?.[0];

    expect(probe?.id).toBe('submit-order');
    expect(probe?.surface).toBe('browser');
    expect(probe?.mechanics.serviceId).toBe('backend');
  });

  it('leaves the contract reference and its fingerprint untouched', () => {
    const { plan } = applyAdaptation(basePlan, [{ probeId: 'submit-order', scenario: 'click "#x"' }]);

    expect(plan.plan.contract).toEqual(basePlan.plan.contract);
  });
});

describe('refusals — nothing partially applies', () => {
  it('refuses a probe id the plan does not carry', () => {
    expect(() =>
      applyAdaptation(basePlan, [{ probeId: 'no-such-probe', scenario: 'click "#x"' }]),
    ).toThrow(AdaptationRefused);
  });

  it('refuses the WHOLE payload when one patch names an unknown probe', () => {
    const patches: MechanicsPatch[] = [
      { probeId: 'submit-order', scenario: 'click "#legal"' },
      { probeId: 'no-such-probe', scenario: 'click "#hostile"' },
    ];
    const before = serializePlan(basePlan);

    expect(() => applyAdaptation(basePlan, patches)).toThrow(AdaptationRefused);
    // The legal half is NOT salvaged, and the original is still the original.
    expect(serializePlan(basePlan)).toBe(before);
  });

  it('patches ONLY the scoped criterion when an id is reused across criteria', () => {
    // ⚠️ THE ROUND-9 CODEX P2. Probe ids are unique only WITHIN a criterion — 4.2's schema
    // checks exactly that and nothing more — so a valid plan may declare `shared-id` under
    // several criteria. Refusing every such payload made `--adapt` unusable on a whole class
    // of legal plans.
    //
    // The caller says which one it meant (its `scope`), which resolves the ambiguity WITHOUT
    // adding anything to the payload: a proposal still names a probe id and nothing else.
    const plan = planWith([
      { criterionId: 'E7-01', disposition: 'automated', probes: [browserProbe('shared-id')] },
      { criterionId: 'E7-02', disposition: 'automated', probes: [browserProbe('shared-id')] },
    ]);

    const { plan: adapted, changes } = applyAdaptation(
      plan,
      [{ probeId: 'shared-id', scenario: 'click "#x"' }],
      new Map([['shared-id', 'E7-02']]),
    );

    expect(changes).toEqual([
      {
        criterionId: 'E7-02',
        probeId: 'shared-id',
        field: 'scenario',
        from: 'click "#create-company"',
        to: 'click "#x"',
      },
    ]);
    // ⚠️ The NAMESAKE under the other criterion is untouched, by reference. Patching every
    // probe that happens to share a name would silently change probes nobody proposed
    // anything for.
    expect(probesOf(adapted, 0)?.[0]).toBe(probesOf(plan, 0)?.[0]);
    expect(probesOf(adapted, 1)?.[0]?.mechanics.scenario).toBe('click "#x"');
  });

  it('refuses an ambiguous probe id when the caller gave no scope', () => {
    const plan = planWith([
      { criterionId: 'E7-01', disposition: 'automated', probes: [browserProbe('shared-id')] },
      { criterionId: 'E7-02', disposition: 'automated', probes: [browserProbe('shared-id')] },
    ]);

    expect(() => applyAdaptation(plan, [{ probeId: 'shared-id', scenario: 'click "#x"' }])).toThrow(
      /more than one criterion/,
    );
  });

  it('refuses a proposal that changes nothing', () => {
    expect(() =>
      applyAdaptation(basePlan, [{ probeId: 'submit-order', scenario: 'click "#create-company"' }]),
    ).toThrow(/changed nothing/);
  });

  it('refuses a non-browser probe', () => {
    const plan = planWith([
      {
        criterionId: 'E7-01',
        disposition: 'automated',
        probes: [
          {
            id: 'shell-probe',
            surface: 'shell',
            mechanics: { commandId: 'lint', args: [], argumentAllowlist: [] },
            assertions: [
              {
                description: 'ok',
                target: { source: 'exitCode' },
                comparison: 'equals',
                expected: '0',
              },
            ],
          },
        ],
      } as unknown as PlanCriterion,
    ]);

    expect(() => applyAdaptation(plan, [{ probeId: 'shell-probe', scenario: 'click "#x"' }])).toThrow(
      /browser probes only/,
    );
  });
});
