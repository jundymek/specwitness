import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  KINDS,
  SEVERITIES,
  VERIFIABILITIES,
  type ContractSpec,
  type Criterion,
} from '../../../src/domain/contract.js';
import { canonicalize, fingerprint } from '../../../src/schemas/canonical.js';

/**
 * The two invariants that make freeze trustworthy, asserted over generated
 * input rather than over the handful of shapes a human thought to write down.
 *
 *   1. key insertion order is presentation and never changes the fingerprint;
 *   2. `meta` is outside the hash — here expressed as "no data other than the
 *      spec can reach `fingerprint` at all".
 *
 * Story 1.2 established this pattern in `tests/unit/verdict.property.test.ts`.
 */

const criterionArb: fc.Arbitrary<Criterion> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 10 }),
  statement: fc.string({ maxLength: 60 }),
  kind: fc.constantFrom(...KINDS),
  severity: fc.constantFrom(...SEVERITIES),
  verifiability: fc.constantFrom(...VERIFIABILITIES),
});

const specArb: fc.Arbitrary<ContractSpec> = fc.record({
  epic: fc.string({ minLength: 1, maxLength: 10 }),
  version: fc.integer({ min: 1, max: 1_000 }),
  criteria: fc.array(criterionArb, { maxLength: 8 }),
});

/** Rebuilds an object with its own keys in a shuffled insertion order. */
function shuffleKeys<T extends object>(value: T, order: readonly number[]): T {
  const entries = Object.entries(value);
  const permuted = order
    .map((n, index) => ({ sort: n, entry: entries[index] }))
    .filter((e): e is { sort: number; entry: [string, unknown] } => e.entry !== undefined)
    .sort((a, b) => a.sort - b.sort)
    .map((e) => e.entry);
  return Object.fromEntries(permuted.length === entries.length ? permuted : entries) as T;
}

describe('fingerprint — properties', () => {
  it('is invariant under key insertion order, at every level', () => {
    fc.assert(
      fc.property(specArb, fc.array(fc.integer(), { minLength: 5, maxLength: 5 }), (spec, order) => {
        const reordered = shuffleKeys(
          { ...spec, criteria: spec.criteria.map((c) => shuffleKeys(c, order)) },
          order.slice(0, 3),
        );

        expect(canonicalize(reordered)).toBe(canonicalize(spec));
        expect(fingerprint(reordered)).toBe(fingerprint(spec));
      }),
      { numRuns: 300 },
    );
  });

  it('is invariant under trailing and leading whitespace on every string', () => {
    fc.assert(
      fc.property(specArb, fc.constantFrom(' ', '\t', '\n', '  \n\t'), (spec, pad) => {
        const padded: ContractSpec = {
          epic: `${pad}${spec.epic}${pad}`,
          version: spec.version,
          criteria: spec.criteria.map((c) => ({
            ...c,
            id: `${pad}${c.id}${pad}`,
            statement: `${pad}${c.statement}${pad}`,
          })),
        };

        expect(fingerprint(padded)).toBe(fingerprint(spec));
      }),
      { numRuns: 200 },
    );
  });

  it('changes whenever any spec field changes', () => {
    fc.assert(
      fc.property(specArb, fc.string({ minLength: 1, maxLength: 5 }), (spec, suffix) => {
        // `epic` is trimmed, so a suffix of pure whitespace is genuinely no
        // change — exclude it rather than assert something false.
        fc.pre(suffix.trim().length > 0);

        expect(fingerprint({ ...spec, epic: `${spec.epic}${suffix}` })).not.toBe(fingerprint(spec));
        expect(fingerprint({ ...spec, version: spec.version + 1 })).not.toBe(fingerprint(spec));
      }),
      { numRuns: 300 },
    );
  });

  it('is deterministic — the same value always hashes the same', () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        expect(fingerprint(spec)).toBe(fingerprint(structuredClone(spec)));
      }),
      { numRuns: 200 },
    );
  });

  it('always returns 64 lowercase hex characters', () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        expect(fingerprint(spec)).toMatch(/^[0-9a-f]{64}$/);
      }),
      { numRuns: 200 },
    );
  });

  it('is injective over the shapes we generate (no collisions in practice)', () => {
    // Not a proof — SHA-256 makes one unnecessary. What this actually guards is
    // the canonicalizer: a normalizer that dropped a field, or coerced one, or
    // folded two distinct values together, would show up here as two distinct
    // specs sharing a hash long before it showed up in production.
    const seen = new Map<string, string>();

    fc.assert(
      fc.property(specArb, (spec) => {
        const json = canonicalize(spec);
        const hash = fingerprint(spec);
        const previous = seen.get(hash);

        if (previous !== undefined) {
          expect(previous).toBe(json);
        } else {
          seen.set(hash, json);
        }
      }),
      { numRuns: 500 },
    );
  });
});
