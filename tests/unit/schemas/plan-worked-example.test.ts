import { describe, expect, it } from 'vitest';

import type { Plan } from '../../../src/domain/plan.js';
import { PlanSchema, parsePlan, serializePlan } from '../../../src/schemas/plan.js';
import { criterion, frozenContract } from '../../helpers/plan.js';

const CONTRACT = frozenContract([
  criterion('E7-01'),
  criterion('E7-02'),
  criterion('E7-03'),
  criterion('E7-04', { verifiability: 'human', kind: 'human' }),
  criterion('E7-05'),
]);

const PLAN: Plan = {
  plan: {
    epic: 'epic-7',
    contract: { version: 1, fingerprint: CONTRACT.meta.fingerprint as string },
    data: {
      seed: 'k3n8v2qz7m4d1p6b',
      bindings: [
        { kind: 'fixed', name: 'companyName', value: 'Acme Test Ltd' },
        {
          kind: 'volatile',
          name: 'signupEmail',
          reason: 'the signup endpoint rejects an address it has already seen',
        },
      ],
    },
    criteria: [
      {
        criterionId: 'E7-01',
        disposition: 'automated',
        probes: [
          {
            id: 'health',
            surface: 'http',
            mechanics: {
              serviceId: 'backend',
              method: 'GET',
              path: '/health',
              headers: { Accept: 'application/json' },
            },
            assertions: [
              {
                description: 'the health endpoint answers 200',
                target: { source: 'status' },
                comparison: 'equals',
                expected: '200',
              },
              {
                description: 'it reports itself healthy',
                target: { source: 'jsonPath', path: '$.status' },
                comparison: 'equals',
                expected: 'ok',
              },
            ],
          },
        ],
      },
      {
        criterionId: 'E7-02',
        disposition: 'automated',
        probes: [
          {
            id: 'submit-signup',
            surface: 'http',
            mechanics: {
              serviceId: 'backend',
              method: 'POST',
              path: '/companies',
              headers: { 'Content-Type': 'application/json' },
              body: '{"name": "{{companyName}}", "email": "{{signupEmail}}"}',
            },
            assertions: [
              {
                description: 'the company is created',
                target: { source: 'status' },
                comparison: 'equals',
                expected: '201',
              },
            ],
          },
          {
            id: 'company-rows',
            surface: 'observation',
            mechanics: { commandId: 'company-count', args: [], around: 'submit-signup' },
            assertions: [
              {
                description: 'exactly one company row was created',
                target: { source: 'jsonPath', path: '$.count', phase: 'delta' },
                comparison: 'equals',
                expected: '1',
              },
            ],
          },
        ],
      },
      {
        criterionId: 'E7-03',
        disposition: 'automated',
        probes: [
          {
            id: 'typecheck-clean',
            surface: 'shell',
            mechanics: {
              commandId: 'typecheck',
              args: ['--strict'],
              argumentAllowlist: ['--strict', '--pretty'],
            },
            assertions: [
              {
                description: 'the typecheck command exits zero',
                target: { source: 'exitCode' },
                comparison: 'equals',
                expected: '0',
              },
              {
                description: 'it reports no errors',
                target: { source: 'stdout' },
                comparison: 'notContains',
                expected: 'error TS',
              },
            ],
          },
        ],
      },
      {
        criterionId: 'E7-04',
        disposition: 'needs-human',
        reason: 'human-verifiability',
        guidance:
          'Open the dashboard as a first-time visitor and judge whether the page reads coherently.',
      },
      {
        criterionId: 'E7-05',
        disposition: 'needs-human',
        reason: 'not-safely-automatable',
        guidance:
          'The criterion asks for graceful degradation under partial network loss. Reproducing that safely needs a fault-injection surface this project does not declare; verify by hand, or narrow the criterion.',
      },
    ],
  },
  meta: {
    schemaVersion: 1,
    compiledAt: '2026-09-01T10:20:30.000Z',
    provenance: {
      provider: 'planner',
      model: null,
      providerCliVersion: null,
      generatedAt: '2026-09-01T10:20:30.000Z',
    },
  },
};

/**
 * THE WORKED EXAMPLE PUBLISHED TO COHORT 2, pinned against the real schema.
 *
 * Story 4.2's PR body hands 4.3, 4.4, 4.5 and 4.6 a complete example plan. Those agents
 * launch after this story has merged and cannot ask a question, so they will build against
 * that example — and a hand-typed example in a PR body is an example nobody validated.
 *
 * This file IS that example. It was serialized through `serializePlan` to produce the YAML
 * in the PR body, and it round-trips here on every run, so a later change that would
 * invalidate the published handoff fails a test rather than misleading four agents.
 *
 * It covers the three surfaces Epic 4 actually executes (http, observation, shell), a
 * before/after observation wrapping another probe, both needs-human reasons, and both kinds
 * of data binding. `browser` is deliberately absent: the schema accepts it and
 * `plan-surfaces.test.ts` proves so, but nothing executes it until Epic 5, and an example
 * showing a probe no executor exists for would read as an invitation to write one.
 */
describe('the published worked example is a valid plan', () => {
  it('round-trips and covers every executed surface and both needs-human reasons', () => {
    const text = serializePlan(PLAN);

    // The surfaces and dispositions the published example is advertised as covering. Asserted
    // rather than assumed: an example that quietly lost its shell probe would still round-trip
    // and would still be published.
    expect(text).toContain('surface: http');
    expect(text).toContain('surface: observation');
    expect(text).toContain('surface: shell');
    expect(text).toContain('around: submit-signup');
    expect(text).toContain('reason: human-verifiability');
    expect(text).toContain('reason: not-safely-automatable');
    expect(text).toContain('kind: volatile');

    expect(PlanSchema.safeParse(JSON.parse(JSON.stringify(PLAN))).success).toBe(true);
    expect(parsePlan(text, 'example.yaml')).toEqual(PLAN);
  });
});
