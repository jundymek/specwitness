import { describe, expect, it } from 'vitest';

import {
  KINDS,
  SEVERITIES,
  VERIFIABILITIES,
  type Contract,
  type ContractHistoryEntry,
  type ContractMeta,
  type ContractProvenance,
  type ContractSpec,
  type Criterion,
  type Kind,
  type Severity,
  type Verifiability,
} from '../../../src/domain/contract.js';

/**
 * The three vocabularies are a frozen public contract: the provider response
 * schema (2.6), the plan compiler (Epic 4) and the Golden Corpus (Epic 6) all
 * assert on these literals. Pinning them here means widening one is a
 * deliberate ADR rather than an edit that happens to keep the suite green.
 */
describe('domain/contract — the closed vocabularies', () => {
  it('pins the kinds exactly, in PRD Glossary order', () => {
    expect([...KINDS]).toEqual([
      'behavioral',
      'integration',
      'invariant',
      'security',
      'structural',
      'performance',
      'human',
    ]);
  });

  it('pins the severities exactly', () => {
    expect([...SEVERITIES]).toEqual(['critical', 'normal']);
  });

  it('pins the verifiabilities exactly', () => {
    expect([...VERIFIABILITIES]).toEqual(['automated', 'human']);
  });

  it.each([
    ['KINDS', KINDS],
    ['SEVERITIES', SEVERITIES],
    ['VERIFIABILITIES', VERIFIABILITIES],
  ])('%s contains no duplicates', (_name, values) => {
    expect(new Set(values).size).toBe(values.length);
  });

  it.each([
    ['KINDS', KINDS],
    ['SEVERITIES', SEVERITIES],
    ['VERIFIABILITIES', VERIFIABILITIES],
  ])('%s is frozen at runtime', (_name, values) => {
    expect(Object.isFrozen(values)).toBe(true);
  });

  it('keeps `human` a member of both Kind and Verifiability without conflating them', () => {
    // A `human` KIND is a requirement class ("the onboarding copy reads well");
    // `human` VERIFIABILITY is how it gets adjudicated. They coincide often and
    // are still different axes — a `security` criterion can be human-verified.
    expect(KINDS).toContain('human');
    expect(VERIFIABILITIES).toContain('human');
    expect(KINDS).not.toEqual(VERIFIABILITIES);
  });
});

describe('domain/contract — the model compiles as intended', () => {
  it('types every vocabulary member into its union', () => {
    const kinds: Kind[] = [...KINDS];
    const severities: Severity[] = [...SEVERITIES];
    const verifiabilities: Verifiability[] = [...VERIFIABILITIES];

    expect(kinds).toHaveLength(KINDS.length);
    expect(severities).toHaveLength(SEVERITIES.length);
    expect(verifiabilities).toHaveLength(VERIFIABILITIES.length);
  });

  it('assembles a whole contract from the exported interfaces', () => {
    const criterion: Criterion = {
      id: 'E7-01',
      statement: 'A new company appears in the companies list after onboarding completes.',
      kind: 'behavioral',
      severity: 'critical',
      verifiability: 'automated',
    };

    const spec: ContractSpec = { epic: 'epic-7', version: 1, criteria: [criterion] };

    const provenance: ContractProvenance = {
      provider: 'codex',
      // Null, not omitted: the codex path cannot report a model identifier at
      // all (2.5 uses --output-last-message). Recording the absence is data.
      model: null,
      providerCliVersion: '0.144.4',
      generatedAt: '2026-08-31T09:00:00.000Z',
    };

    const history: ContractHistoryEntry = {
      version: 1,
      fingerprint: 'a'.repeat(64),
      timestamp: '2026-08-31T09:00:00.000Z',
      reason: 'requirement changed: onboarding now emails the owner',
    };

    const meta: ContractMeta = {
      schemaVersion: 1,
      frozen: true,
      fingerprint: 'b'.repeat(64),
      createdAt: '2026-08-31T09:00:00.000Z',
      frozenAt: '2026-08-31T09:05:00.000Z',
      provenance,
      history: [history],
    };

    const contract: Contract = { spec, meta };

    // Exactly two top-level keys (AD-5). A third would be fingerprinted or
    // silently unfingerprinted, and neither answer is one anybody chose.
    expect(Object.keys(contract).sort()).toEqual(['meta', 'spec']);
    expect(contract.spec.criteria[0]?.id).toBe('E7-01');
    expect(contract.meta.provenance.model).toBeNull();
  });
});
