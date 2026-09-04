/**
 * Story 5.6, AC2 — the adaptation flow, driven through the REAL merged gate.
 *
 * The schema suite (`tests/unit/schemas/adaptation.test.ts`) proves the payload has nowhere
 * to put an assertion. This file proves the rest of the chain behaves when a provider tries
 * anyway: the gate rejects, the budget is spent, the flow REFUSES rather than throwing, and
 * nothing partial escapes.
 *
 * **NOTHING HERE THROWS INTO THE CALLER, AND THAT IS THE POINT.** Every hostile route ends
 * in `{outcome: 'refused'}`. If any of them raised instead, `ProviderError` (AD-7's exit-3
 * class) would escape the probes stage and turn a product FAIL into an infrastructure error
 * — moving the exit code, which AC2 forbids in terms.
 *
 * Zero subprocesses (AD-12): the gate is driven from the outside with scripted raw text.
 */

import { describe, expect, it } from 'vitest';

import { createMechanicsAdapter } from '../../../src/authoring/adaptation.js';
import type { AdaptationCandidate } from '../../../src/domain/adaptation-port.js';
import { FixedClock } from '../../fakes/ports.js';
import { scriptedProvider, throwingProvider } from '../../fakes/agent-provider.js';

const candidates: AdaptationCandidate[] = [
  {
    criterionId: 'E7-01',
    statement: 'A user can create an organization from the orders page.',
    probeId: 'submit-order',
    path: '/orders',
    scenario: 'click "#create-company"',
    expected: 'Organizations',
    actual: '(no element matched "#create-company")',
  },
];

function adapterFor(...responses: readonly string[]) {
  const provider = scriptedProvider(...responses);
  return { provider, adapt: createMechanicsAdapter({ provider, clock: new FixedClock('2026-09-04T00:00:00.000Z') }) };
}

const legal = JSON.stringify({
  proposals: [{ probeId: 'submit-order', mechanics: { scenario: 'click "#add-organization"' } }],
});

describe('a legal proposal', () => {
  it('is accepted and reshaped into patches', async () => {
    const { adapt } = adapterFor(legal);

    const decision = await adapt(candidates);

    expect(decision.outcome).toBe('proposed');
    expect(decision.outcome === 'proposed' ? decision.patches : undefined).toEqual([
      { probeId: 'submit-order', scenario: 'click "#add-organization"' },
    ]);
  });

  it('records the invocation in provider usage (FR-15, Q65)', async () => {
    const { adapt } = adapterFor(legal);

    const decision = await adapt(candidates);

    expect(decision.usage).toMatchObject({
      role: 'mechanics-adapter',
      provider: 'scripted',
      attempts: 1,
      // Honest nulls: the AD-2 envelope carries no provider metadata.
      model: null,
      providerCliVersion: null,
    });
  });
});

describe('AC2 — a hostile payload is refused, and refusal is a VALUE', () => {
  const hostile: readonly [name: string, payload: string][] = [
    [
      'an assertion edit',
      JSON.stringify({
        proposals: [
          {
            probeId: 'submit-order',
            mechanics: {
              scenario: 'click "#x"',
              assertions: [{ target: { source: 'title' }, comparison: 'equals', expected: 'anything' }],
            },
          },
        ],
      }),
    ],
    [
      'an expected-value edit',
      JSON.stringify({
        proposals: [{ probeId: 'submit-order', mechanics: { scenario: 'click "#x"', expected: 'ok' } }],
      }),
    ],
    [
      'a URL',
      JSON.stringify({
        proposals: [{ probeId: 'submit-order', mechanics: { path: 'https://prod.example.com/x' } }],
      }),
    ],
    [
      'a command string',
      JSON.stringify({
        proposals: [{ probeId: 'submit-order', mechanics: { scenario: 'click "#x"', command: 'rm -rf /' } }],
      }),
    ],
    [
      'a service repoint',
      JSON.stringify({ proposals: [{ probeId: 'submit-order', mechanics: { serviceId: 'prod' } }] }),
    ],
    [
      'a probe rename',
      JSON.stringify({
        proposals: [{ probeId: 'submit-order', mechanics: { scenario: 'click "#x"' }, id: 'other' }],
      }),
    ],
  ];

  it.each(hostile)('refuses %s without throwing', async (_name, payload) => {
    const { adapt } = adapterFor(payload);

    const decision = await adapt(candidates);

    expect(decision.outcome).toBe('refused');
    // No `patches` key exists on the refused arm — the type makes salvage unreachable
    // rather than merely discouraged (AD-2, FR-14).
    expect(decision).not.toHaveProperty('patches');
  });

  it('refuses a MIXED payload entirely — the legal half is not salvaged', async () => {
    const { adapt } = adapterFor(
      JSON.stringify({
        proposals: [
          { probeId: 'submit-order', mechanics: { scenario: 'click "#add-organization"' } },
          { probeId: 'other-probe', mechanics: { scenario: 'click "#x"', expected: 'anything' } },
        ],
      }),
    );

    const decision = await adapt(candidates);

    expect(decision.outcome).toBe('refused');
    expect(decision).not.toHaveProperty('patches');
  });

  it('still records the quota a refused payload cost', async () => {
    const { adapt } = adapterFor(
      JSON.stringify({ proposals: [{ probeId: 'submit-order', mechanics: { expected: 'x' } }] }),
    );

    const decision = await adapt(candidates);

    // Default budget is 2 retries ⇒ 3 attempts, all spent on a payload thrown away. An
    // operator must be able to see that spend (FR-15).
    expect(decision.usage?.attempts).toBe(3);
  });
});

describe('provider failure routes — none of them throws', () => {
  it('refuses when the response is not JSON at all', async () => {
    const { adapt } = adapterFor('I think you should change the assertion instead.');

    await expect(adapt(candidates)).resolves.toMatchObject({ outcome: 'refused' });
  });

  it('refuses when the response is empty', async () => {
    const { adapt } = adapterFor('');

    await expect(adapt(candidates)).resolves.toMatchObject({ outcome: 'refused' });
  });

  it('refuses when the provider CLI throws — never a ProviderError escaping', async () => {
    const adapt = createMechanicsAdapter({
      provider: throwingProvider(new Error('claude: command not found')),
      clock: new FixedClock('2026-09-04T00:00:00.000Z'),
    });

    const decision = await adapt(candidates);

    expect(decision.outcome).toBe('refused');
    expect(decision.outcome === 'refused' ? decision.reason : '').toContain('command not found');
  });

  it('takes a valid payload on a retry after a malformed one', async () => {
    // The gate's own feedback loop, driven from outside. Proves this flow adds no second
    // retry loop of its own: the budget belongs to `providers/invoke.ts`.
    const { adapt, provider } = adapterFor('not json', legal);

    const decision = await adapt(candidates);

    expect(decision.outcome).toBe('proposed');
    expect(provider.prompts).toHaveLength(2);
    expect(provider.prompts[1]?.prompt).toContain('PREVIOUS RESPONSE REJECTED');
  });
});

describe('what reaches the provider', () => {
  it('sends the criterion statement, the compiled mechanics and the redacted observation', async () => {
    const { adapt, provider } = adapterFor(legal);

    await adapt(candidates);
    const prompt = provider.prompts[0]?.prompt ?? '';

    expect(prompt).toContain('A user can create an organization from the orders page.');
    expect(prompt).toContain('click "#create-company"');
    expect(prompt).toContain('(no element matched "#create-company")');
  });

  it('states the prohibition in words as well — steering, never the mechanism', async () => {
    const { adapt, provider } = adapterFor(legal);

    await adapt(candidates);
    const prompt = provider.prompts[0]?.prompt ?? '';

    expect(prompt).toMatch(/may NOT change what must be TRUE/);
    expect(prompt).toMatch(/rejected in full/);
  });

  it('uses the mechanics-adapter role, never the explainer', async () => {
    const { adapt, provider } = adapterFor(legal);

    await adapt(candidates);

    expect(provider.prompts[0]?.role).toBe('mechanics-adapter');
  });
});
