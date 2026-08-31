import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { Contract, ContractProvenance } from '../../../src/domain/contract.js';
import { fingerprint } from '../../../src/schemas/canonical.js';
import { contractState, parseContract, serializeContract } from '../../../src/schemas/contract.js';

/**
 * AC4 of story 3.8, and the only way this story could do real damage.
 *
 * Story 3.8 starts writing real values into `meta.provenance.model` and
 * `meta.provenance.providerCliVersion`, which were `null` in every contract
 * SpecWitness had written before it. AD-5 says `meta` is NEVER fingerprinted and
 * that freeze and integrity validation hash only `spec` — so populating those
 * fields must not move a single frozen contract in existence to `tampered`. If
 * that were wrong, the day this merged every frozen contract would start
 * reporting an integrity failure, and the product's central promise with it.
 *
 * `tests/unit/contract/freeze.test.ts` already asserts the general property
 * over synthetic `ContractMeta` mutations. This file is deliberately narrower
 * and more concrete: it works from the merged, HAND-WRITTEN frozen fixture
 * (AD-12 — a generated fixture would be checking the code against itself),
 * writes provenance the way this story writes it, and asks the question through
 * `contractState`, which is what `--status`, `--amend` and Epic 3's `verify` all
 * actually call.
 *
 * WHY THE NEGATIVE CONTROL IS PERMANENT RATHER THAN A ONE-OFF. The story asked
 * for this test to be watched failing by temporarily moving a provenance field
 * into `spec`. That is not expressible: `fingerprint()` takes a `ContractSpec`,
 * so `meta` is not representable in its input and the mistake cannot be made
 * without changing the domain type. The honest equivalent is to prove the
 * instrument works — a change to `spec` DOES move the fingerprint and DOES flip
 * the state — and to keep that control in the suite, where it will still be true
 * for the next reader. A green test that could never have failed proves nothing.
 */

const FIXTURES = new URL('../../fixtures/contracts/', import.meta.url);

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, FIXTURES)), 'utf8');
}

/** The fingerprint recorded in the hand-written frozen fixture. */
const FROZEN_FINGERPRINT = '4f7f9292551ac1cf01d2b77d4e845561b6e6f4331d34ae5c07e7730312d1f184';

function frozen(): Contract {
  return parseContract(fixture('epic-7-frozen.yaml'), 'contracts/epic-7.yaml');
}

/** What story 3.8 writes on a claude path where the CLI reported a version. */
const POPULATED: ContractProvenance = {
  provider: 'claude',
  model: null,
  providerCliVersion: '2.1.251 (Claude Code)',
  generatedAt: '2026-08-31T09:00:00.000Z',
};

function withProvenance(contract: Contract, provenance: ContractProvenance): Contract {
  return { ...contract, meta: { ...contract.meta, provenance } };
}

describe('populating meta.provenance cannot change a contract fingerprint (AD-5)', () => {
  it('leaves a frozen contract frozen, with a byte-identical fingerprint', () => {
    const before = frozen();
    expect(contractState(before)).toBe('frozen');

    const after = withProvenance(before, POPULATED);

    // The state a real caller asks for — `--status`, `--amend` and `verify` all
    // route through this one function deliberately.
    expect(contractState(after)).toBe('frozen');
    // And the hash itself, byte for byte, against the value the fixture records.
    expect(fingerprint(after.spec)).toBe(FROZEN_FINGERPRINT);
    expect(fingerprint(after.spec)).toBe(fingerprint(before.spec));
    expect(after.meta.fingerprint).toBe(before.meta.fingerprint);
  });

  it('holds for every provenance field independently, including the two this story wires', () => {
    const before = frozen();

    const mutations: Array<[string, ContractProvenance]> = [
      ['providerCliVersion', { ...before.meta.provenance, providerCliVersion: '2.1.251' }],
      ['model', { ...before.meta.provenance, model: 'some-model-name' }],
      ['provider', { ...before.meta.provenance, provider: 'claude' }],
      ['generatedAt', { ...before.meta.provenance, generatedAt: '2030-01-01T00:00:00.000Z' }],
      ['all four at once', POPULATED],
    ];

    for (const [field, provenance] of mutations) {
      const after = withProvenance(before, provenance);
      expect(contractState(after), `${field} must not affect integrity`).toBe('frozen');
      expect(fingerprint(after.spec), `${field} must not affect the fingerprint`).toBe(
        FROZEN_FINGERPRINT,
      );
    }
  });

  it('NEGATIVE CONTROL: a change to `spec` DOES move the fingerprint and flip the state', () => {
    // The instrument has to be able to detect the thing it claims to rule out.
    // Without this, the assertions above would pass just as happily if
    // `contractState` always answered 'frozen'.
    const before = frozen();
    const firstCriterion = before.spec.criteria[0];
    expect(firstCriterion).toBeDefined();

    const tampered: Contract = {
      ...before,
      spec: {
        ...before.spec,
        criteria: [
          { ...firstCriterion!, statement: 'A weaker statement nobody approved.' },
          ...before.spec.criteria.slice(1),
        ],
      },
    };

    expect(fingerprint(tampered.spec)).not.toBe(FROZEN_FINGERPRINT);
    expect(contractState(tampered)).toBe('tampered');
  });

  it('round-trips real provenance values through serialize and parse unchanged', () => {
    const populated = withProvenance(frozen(), POPULATED);

    const reparsed = parseContract(serializeContract(populated), 'contracts/epic-7.yaml');

    expect(reparsed.meta.provenance).toEqual(POPULATED);
    // A version string is untrusted text that ends up in a YAML document. The
    // merged serializer is what makes that safe; nothing in this story builds
    // YAML by hand. Round-tripping the parenthesised claude version proves the
    // scalar survives quoting intact.
    expect(reparsed.meta.provenance.providerCliVersion).toBe('2.1.251 (Claude Code)');
    // Still frozen after a full write/read cycle: serialization does not disturb
    // `spec` either.
    expect(contractState(reparsed)).toBe('frozen');
    expect(reparsed.meta.fingerprint).toBe(FROZEN_FINGERPRINT);
  });

  it('records an unknown provenance value as an explicit null through a round trip', () => {
    // The policy `ContractProvenance` states: an unknown value is written as an
    // explicit `null`, never omitted, because an absent key is
    // indistinguishable from a key an older writer never knew about. This story
    // produces nulls on the `fake` path and whenever a `--version` probe fails,
    // so the policy has to survive serialization.
    const unknown: ContractProvenance = {
      provider: 'hermetic',
      model: null,
      providerCliVersion: null,
      generatedAt: '2026-08-31T09:00:00.000Z',
    };

    const text = serializeContract(withProvenance(frozen(), unknown));

    expect(text).toContain('model: null');
    expect(text).toContain('providerCliVersion: null');

    const reparsed = parseContract(text, 'contracts/epic-7.yaml');
    expect(reparsed.meta.provenance.model).toBeNull();
    expect(reparsed.meta.provenance.providerCliVersion).toBeNull();
    expect(contractState(reparsed)).toBe('frozen');
  });
});

/**
 * A version string is UNTRUSTED TEXT that this story newly writes into a YAML
 * document (story 3.8's Security section).
 *
 * The threat is small but real and cheap to close: `providerCliVersion` is
 * whatever a binary named `claude` or `codex` on the operator's PATH printed for
 * `--version`, recorded verbatim. Both adapters already reason about a homonym
 * binary — a shell alias, an unrelated program — so a hostile or merely broken
 * one printing YAML-shaped text is exactly the case worth pinning. If the
 * serializer emitted that as raw structure rather than as a quoted scalar, a
 * `--version` string could inject keys into the contract document, which is the
 * artifact the entire product treats as authoritative.
 *
 * It cannot, because nothing in this story builds YAML by hand — the merged
 * serializer does it. This test is what stops that staying true only by accident.
 */
describe('an untrusted version string cannot inject YAML structure', () => {
  const HOSTILE = [
    ['newlines and a fake key', 'x\ncriteria: []\nmeta:\n  frozen: false\n'],
    ['a document separator', '1.0\n---\nspec:\n  epic: evil\n'],
    ['a leading anchor and a comment', '&anchor 1.0 # trailing'],
    ['flow-mapping syntax', '{epic: pwned, version: 99}'],
    ['a leading indicator character', '*not-an-alias'],
    ['a colon-space pair, which YAML reads as a mapping', 'version: 1.0'],
  ] as const;

  for (const [label, version] of HOSTILE) {
    it(`records ${label} as an inert scalar`, () => {
      const contract = withProvenance(frozen(), {
        ...POPULATED,
        providerCliVersion: version,
      });

      const reparsed = parseContract(serializeContract(contract), 'contracts/epic-7.yaml');

      // Survives verbatim — the adapters promise "verbatim, never parsed", and
      // sanitising it here would be this layer editing what the CLI said.
      expect(reparsed.meta.provenance.providerCliVersion).toBe(version);
      // And changed nothing else. `spec` is untouched, so the contract is still
      // frozen against its original fingerprint: no injected key reached it.
      expect(reparsed.spec.epic).toBe('epic-7');
      expect(reparsed.spec.criteria).toHaveLength(3);
      expect(contractState(reparsed)).toBe('frozen');
      expect(fingerprint(reparsed.spec)).toBe(FROZEN_FINGERPRINT);
    });
  }
});
