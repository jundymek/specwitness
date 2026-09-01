/**
 * Builders for plan and contract values used across the story 4.2 test suites.
 *
 * Not a fake and not a fixture file: these are hand-written values with obvious defaults
 * and a shallow override hook, so each test states only the field it is about. The
 * alternative — a literal plan object repeated in thirty tests — hides which field a test
 * actually exercises.
 *
 * `.ts` without `.test.` in the name on purpose: `vitest.config.ts` includes
 * `tests/**\/*.test.ts`, so this file is imported, never run as a suite.
 */

import type { Contract, Criterion } from '../../src/domain/contract.js';
import type {
  DataBinding,
  Plan,
  PlanCriterion,
  PlanProvenance,
  ProbeSpec,
} from '../../src/domain/plan.js';
import { fingerprint } from '../../src/schemas/canonical.js';
import { CONTRACT_SCHEMA_VERSION } from '../../src/schemas/contract.js';

export const COMPILED_AT = '2026-09-01T10:20:30.000Z';
export const CONTRACT_CREATED_AT = '2026-08-31T06:12:41.000Z';
export const CONTRACT_FROZEN_AT = '2026-08-31T07:00:00.000Z';

/** An `automated` criterion, unless a test overrides `verifiability`. */
export function criterion(id: string, overrides: Partial<Criterion> = {}): Criterion {
  return {
    id,
    statement: `The system satisfies ${id}.`,
    kind: 'behavioral',
    severity: 'normal',
    verifiability: 'automated',
    ...overrides,
  };
}

/**
 * A FROZEN contract whose fingerprint really is the hash of its own spec.
 *
 * Computed through `schemas/canonical.ts` rather than pasted, because a hard-coded hash in
 * a fixture is a hash that silently stops matching the day canonicalization changes — and
 * every staleness test here would then pass for the wrong reason.
 */
export function frozenContract(criteria: readonly Criterion[], version = 1): Contract {
  const spec = { epic: 'epic-7', version, criteria } as const;
  return {
    spec,
    meta: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      frozen: true,
      fingerprint: fingerprint(spec),
      createdAt: CONTRACT_CREATED_AT,
      frozenAt: CONTRACT_FROZEN_AT,
      provenance: {
        provider: 'hermetic',
        model: null,
        providerCliVersion: null,
        generatedAt: CONTRACT_CREATED_AT,
      },
      history: [],
    },
  };
}

/** The same contract, never frozen. */
export function draftContract(criteria: readonly Criterion[]): Contract {
  const frozen = frozenContract(criteria);
  return {
    spec: frozen.spec,
    meta: { ...frozen.meta, frozen: false, fingerprint: null, frozenAt: null },
  };
}

export const HTTP_PROBE = {
  id: 'health-endpoint',
  surface: 'http',
  mechanics: { serviceId: 'backend', method: 'GET', path: '/health' },
  assertions: [
    {
      description: 'the health endpoint answers 200',
      target: { source: 'status' },
      comparison: 'equals',
      expected: '200',
    },
  ],
} satisfies ProbeSpec;

export const OBSERVATION_PROBE = {
  id: 'company-count',
  surface: 'observation',
  mechanics: { commandId: 'company-count', args: [] },
  assertions: [
    {
      description: 'exactly three companies exist',
      target: { source: 'jsonPath', path: '$.count', phase: 'snapshot' },
      comparison: 'equals',
      expected: '3',
    },
  ],
} satisfies ProbeSpec;

export const SHELL_PROBE = {
  id: 'typecheck-clean',
  surface: 'shell',
  mechanics: { commandId: 'typecheck', args: ['--strict'], argumentAllowlist: ['--strict'] },
  assertions: [
    {
      description: 'the typecheck command exits zero',
      target: { source: 'exitCode' },
      comparison: 'equals',
      expected: '0',
    },
  ],
} satisfies ProbeSpec;

export const BROWSER_PROBE = {
  id: 'signup-flow',
  surface: 'browser',
  mechanics: {
    serviceId: 'frontend',
    path: '/signup',
    scenario: 'Fill the signup form with the bound values and submit it.',
  },
  assertions: [
    {
      description: 'the confirmation heading is visible',
      target: { source: 'visible', selector: 'h1.confirmation' },
      comparison: 'equals',
      expected: 'true',
    },
  ],
} satisfies ProbeSpec;

export function automated(criterionId: string, ...probes: readonly ProbeSpec[]): PlanCriterion {
  return {
    criterionId,
    disposition: 'automated',
    probes: probes.length > 0 ? probes : [HTTP_PROBE],
  };
}

export function needsHuman(
  criterionId: string,
  reason: 'human-verifiability' | 'not-safely-automatable' = 'human-verifiability',
): PlanCriterion {
  return {
    criterionId,
    disposition: 'needs-human',
    reason,
    guidance: 'Open the rendered page and judge whether the layout reads as intended.',
  };
}

export const PROVENANCE: PlanProvenance = {
  provider: 'hermetic',
  model: null,
  providerCliVersion: null,
  generatedAt: COMPILED_AT,
};

export const FIXED_BINDING: DataBinding = {
  kind: 'fixed',
  name: 'companyName',
  value: 'Acme Test Ltd',
};

export const VOLATILE_BINDING: DataBinding = {
  kind: 'volatile',
  name: 'signupEmail',
  reason: 'the signup endpoint rejects an address it has already seen',
};

export interface PlanOverrides {
  readonly criteria?: readonly PlanCriterion[];
  readonly bindings?: readonly DataBinding[];
  readonly seed?: string;
  readonly contractVersion?: number;
  readonly fingerprint?: string;
  readonly epic?: string;
  readonly schemaVersion?: number;
}

/** A valid plan for `contract`, with every field overridable one at a time. */
export function planFor(contract: Contract, overrides: PlanOverrides = {}): Plan {
  return {
    plan: {
      epic: overrides.epic ?? contract.spec.epic,
      contract: {
        version: overrides.contractVersion ?? contract.spec.version,
        fingerprint: overrides.fingerprint ?? (contract.meta.fingerprint as string),
      },
      data: {
        seed: overrides.seed ?? 'k3n8v2qz7m4d1p6b',
        bindings: overrides.bindings ?? [FIXED_BINDING, VOLATILE_BINDING],
      },
      criteria:
        overrides.criteria ?? contract.spec.criteria.map((c) => automated(c.id, HTTP_PROBE)),
    },
    meta: {
      schemaVersion: overrides.schemaVersion ?? 1,
      compiledAt: COMPILED_AT,
      provenance: PROVENANCE,
    },
  };
}

/**
 * A plan rendered to the plain-object shape a hostile provider would send, so a test can
 * inject an unknown key at any depth without fighting the TypeScript types that exist
 * precisely to stop that.
 */
export function asDocument(plan: Plan): Record<string, unknown> {
  return JSON.parse(JSON.stringify(plan)) as Record<string, unknown>;
}
