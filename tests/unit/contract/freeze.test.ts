import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { Contract, ContractMeta } from '../../../src/domain/contract.js';
import { IntegrityError } from '../../../src/domain/errors.js';
import { fingerprint } from '../../../src/schemas/canonical.js';
import {
  ContractNotFrozenError,
  contractState,
  freeze,
  isFrozen,
  parseContract,
  serializeContract,
  verifyIntegrity,
} from '../../../src/schemas/contract.js';

const FIXTURES = new URL('../../fixtures/contracts/', import.meta.url);

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, FIXTURES)), 'utf8');
}

const FROZEN_FINGERPRINT = '4f7f9292551ac1cf01d2b77d4e845561b6e6f4331d34ae5c07e7730312d1f184';
const AT = new Date('2026-08-31T09:05:00.000Z');
const LATER = new Date('2026-09-14T12:00:00.000Z');

const draft = (): Contract => parseContract(fixture('epic-7-draft.yaml'), 'p');
const frozen = (): Contract => parseContract(fixture('epic-7-frozen.yaml'), 'p');
const tampered = (): Contract => parseContract(fixture('epic-7-tampered.yaml'), 'p');

describe('freeze', () => {
  it('sets frozen, the fingerprint and frozenAt, and nothing else', () => {
    const before = draft();
    const after = freeze(before, AT);

    expect(after.meta.frozen).toBe(true);
    expect(after.meta.fingerprint).toBe(fingerprint(before.spec));
    expect(after.meta.frozenAt).toBe('2026-08-31T09:05:00.000Z');

    // The content is untouched — freezing records a fact about the spec, it
    // never edits one.
    expect(after.spec).toEqual(before.spec);
    expect(after.meta.createdAt).toBe(before.meta.createdAt);
    expect(after.meta.provenance).toEqual(before.meta.provenance);
    expect(after.meta.history).toEqual(before.meta.history);
  });

  it('does not bump the version — freezing is not amending', () => {
    expect(freeze(draft(), AT).spec.version).toBe(draft().spec.version);
  });

  it('is pure: the input value is not mutated', () => {
    const before = draft();
    const snapshot = structuredClone(before);

    freeze(before, AT);

    expect(before).toEqual(snapshot);
  });

  it('takes the instant as an argument and never reads a clock (AD-9)', () => {
    // Two freezes of the same draft at two different supplied instants differ
    // only in frozenAt. If `freeze` called `new Date()`, this could not hold.
    const one = freeze(draft(), AT);
    const two = freeze(draft(), LATER);

    expect(one.meta.frozenAt).toBe('2026-08-31T09:05:00.000Z');
    expect(two.meta.frozenAt).toBe('2026-09-14T12:00:00.000Z');
    expect(one.meta.fingerprint).toBe(two.meta.fingerprint);
  });

  it('produces the fingerprint the canonical fixture already records', () => {
    // Take the frozen fixture back to a draft, then freeze it again: the hash
    // must land on the value computed independently with `shasum -a 256`, not
    // merely on whatever this code produces twice in a row.
    const base = frozen();
    const asDraft: Contract = {
      spec: base.spec,
      meta: { ...base.meta, frozen: false, fingerprint: null, frozenAt: null },
    };

    expect(freeze(asDraft, AT).meta.fingerprint).toBe(FROZEN_FINGERPRINT);
  });

  it('is idempotent on unchanged content — a second freeze is a no-op', () => {
    const once = freeze(draft(), AT);
    const twice = freeze(once, LATER);

    // Same everything, including frozenAt: re-freezing must not rewrite the
    // file or move the timestamp, or story 2.6's `--freeze` would churn git
    // history every time an operator ran it twice.
    expect(twice).toEqual(once);
    expect(twice.meta.frozenAt).toBe(once.meta.frozenAt);
    expect(twice.spec.version).toBe(once.spec.version);
  });

  it('refuses to re-freeze a frozen contract whose content changed', () => {
    // That is the amend flow's job (story 2.7), and silently re-fingerprinting
    // would be precisely the silent redefinition the product exists to stop.
    expect(() => freeze(tampered(), LATER)).toThrow(IntegrityError);
  });

  it('freezes an amended draft with a non-empty history exactly like a fresh one', () => {
    // Story 2.7's amend output: version bumped, frozen cleared, history carrying
    // the superseded version. `freeze` must have no special case for it and must
    // leave the history untouched and in order — this is the last step of the
    // only sanctioned way a contract legitimately changes.
    const base = draft();
    const amended: Contract = {
      spec: { ...base.spec, version: 2 },
      meta: {
        ...base.meta,
        history: [
          {
            version: 1,
            fingerprint: FROZEN_FINGERPRINT,
            timestamp: '2026-08-31T09:05:00.000Z',
            reason: 'requirement changed: onboarding now emails the owner',
          },
        ],
      },
    };

    const result = freeze(amended, LATER);

    expect(result.meta.frozen).toBe(true);
    expect(result.meta.fingerprint).toBe(fingerprint(amended.spec));
    expect(result.meta.history).toEqual(amended.meta.history);
    expect(result.spec.version).toBe(2);
    expect(contractState(result)).toBe('frozen');
  });

  it('produces a contract that still serializes and parses', () => {
    const result = freeze(draft(), AT);

    expect(parseContract(serializeContract(result), 'p')).toEqual(result);
  });
});

describe('isFrozen — the cheap read that never throws', () => {
  it.each([
    ['a draft', draft, false],
    ['a frozen contract', frozen, true],
    ['a tampered contract', tampered, true],
  ])('answers %s without throwing', (_name, build, expected) => {
    expect(isFrozen(build())).toBe(expected);
  });

  it('reports the flag, not the integrity — a tampered file IS frozen', () => {
    // Story 2.6 needs "has this been frozen at all?" separately from "does it
    // still match". Conflating them would make `--status` unable to tell an
    // operator which of the two problems they have.
    expect(isFrozen(tampered())).toBe(true);
    expect(contractState(tampered())).toBe('tampered');
  });
});

describe('contractState — the three answers 2.6 and 2.7 render', () => {
  it.each([
    ['draft', draft, 'draft'],
    ['frozen', frozen, 'frozen'],
    ['tampered', tampered, 'tampered'],
  ])('reports %s', (_name, build, expected) => {
    expect(contractState(build())).toBe(expected);
  });

  it('never throws, for any of the three', () => {
    for (const build of [draft, frozen, tampered]) {
      expect(() => contractState(build())).not.toThrow();
    }
  });

  it('turns frozen into tampered after a one-character edit', () => {
    const before = frozen();
    const after: Contract = {
      ...before,
      spec: {
        ...before.spec,
        criteria: [
          { ...before.spec.criteria[0]!, statement: `${before.spec.criteria[0]!.statement} ` },
          ...before.spec.criteria.slice(1),
        ],
      },
    };

    // Trailing whitespace is trimmed by canonicalization, so THAT edit is not
    // a content change...
    expect(contractState(after)).toBe('frozen');

    const real: Contract = {
      ...before,
      spec: {
        ...before.spec,
        criteria: [
          { ...before.spec.criteria[0]!, statement: 'A new company appears in the list.' },
          ...before.spec.criteria.slice(1),
        ],
      },
    };

    // ...but a word removed from the statement is.
    expect(contractState(real)).toBe('tampered');
  });
});

describe('verifyIntegrity — the throwing form', () => {
  it('passes silently on an intact frozen contract', () => {
    expect(() => verifyIntegrity(frozen())).not.toThrow();
  });

  it('throws IntegrityError on a tampered contract, with a usable message', () => {
    try {
      verifyIntegrity(tampered());
      expect.unreachable('expected an IntegrityError');
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrityError);
      // Golden Corpus fixture 9 semantics: neither PASS nor FAIL. The message
      // says what happened; the HINT says how to look at it.
      expect((err as Error).message).toMatch(/does not match .*frozen fingerprint/i);
      expect((err as Error).message).toContain('epic-7');
      expect((err as IntegrityError).hint).toMatch(/git diff/);
      expect((err as IntegrityError).hint).toMatch(/amend/);
    }
  });

  it('names both fingerprints so the operator can compare them', () => {
    try {
      verifyIntegrity(tampered());
      expect.unreachable('expected an IntegrityError');
    } catch (err) {
      expect((err as Error).message).toContain(FROZEN_FINGERPRINT);
      expect((err as Error).message).toContain(fingerprint(tampered().spec));
    }
  });

  it('throws a distinct, separately named error when the contract was never frozen', () => {
    // 2.6's verify guard must tell "never frozen" from "tampered": one is
    // "run --freeze", the other is "someone edited this".
    try {
      verifyIntegrity(draft());
      expect.unreachable('expected a ContractNotFrozenError');
    } catch (err) {
      expect(err).toBeInstanceOf(ContractNotFrozenError);
      expect((err as Error).message).toMatch(/not frozen/i);
      expect((err as ContractNotFrozenError).hint).toMatch(/--freeze/);
    }
  });

  it('keeps ContractNotFrozenError inside the AD-7 taxonomy', () => {
    // A refinement of IntegrityError, NOT a seventh class: it still classifies
    // to exit 3 through `cli/exit.ts` with no new branch there.
    const err = new ContractNotFrozenError('x');

    expect(err).toBeInstanceOf(IntegrityError);
    expect(err.name).toBe('ContractNotFrozenError');
  });

  it('offers no override — freeze is tamper-evident, not tamper-proof', () => {
    // ADR-005. If a `force` argument existed, the first agent to hit an
    // integrity error would find it. `verifyIntegrity` takes exactly one
    // parameter and there is nothing to pass.
    expect(verifyIntegrity.length).toBe(1);
  });
});

describe('meta is never fingerprinted', () => {
  const metaMutations: Array<[string, (m: ContractMeta) => ContractMeta]> = [
    ['frozenAt', (m) => ({ ...m, frozenAt: '2030-01-01T00:00:00.000Z' })],
    ['createdAt', (m) => ({ ...m, createdAt: '2030-01-01T00:00:00.000Z' })],
    ['schemaVersion', (m) => ({ ...m, schemaVersion: 2 })],
    [
      'provenance',
      (m) => ({
        ...m,
        provenance: {
          provider: 'claude-code',
          model: 'claude-opus-5',
          providerCliVersion: '9.9.9',
          generatedAt: '2030-01-01T00:00:00.000Z',
        },
      }),
    ],
    [
      'history',
      (m) => ({
        ...m,
        history: [
          {
            version: 1,
            fingerprint: 'c'.repeat(64),
            timestamp: '2030-01-01T00:00:00.000Z',
            reason: 'an amendment recorded later',
          },
        ],
      }),
    ],
  ];

  it.each(metaMutations)('mutating meta.%s leaves the contract intact', (_name, mutate) => {
    const before = frozen();
    const after: Contract = { ...before, meta: mutate(before.meta) };

    expect(fingerprint(after.spec)).toBe(before.meta.fingerprint);
    expect(contractState(after)).toBe('frozen');
    expect(() => verifyIntegrity(after)).not.toThrow();
  });

  it('mutating any spec field invalidates it', () => {
    const before = frozen();

    const mutations: Array<[string, Contract]> = [
      ['epic', { ...before, spec: { ...before.spec, epic: 'epic-8' } }],
      ['version', { ...before, spec: { ...before.spec, version: 2 } }],
      [
        'a statement',
        {
          ...before,
          spec: {
            ...before.spec,
            criteria: [{ ...before.spec.criteria[0]!, statement: 'weaker' }, ...before.spec.criteria.slice(1)],
          },
        },
      ],
      [
        'a severity',
        {
          ...before,
          spec: {
            ...before.spec,
            criteria: [{ ...before.spec.criteria[0]!, severity: 'normal' }, ...before.spec.criteria.slice(1)],
          },
        },
      ],
      [
        'a verifiability',
        {
          ...before,
          spec: {
            ...before.spec,
            criteria: [{ ...before.spec.criteria[0]!, verifiability: 'human' }, ...before.spec.criteria.slice(1)],
          },
        },
      ],
      ['criterion order', { ...before, spec: { ...before.spec, criteria: [...before.spec.criteria].reverse() } }],
      ['a dropped criterion', { ...before, spec: { ...before.spec, criteria: before.spec.criteria.slice(1) } }],
    ];

    for (const [what, contract] of mutations) {
      expect(contractState(contract), `expected changing ${what} to be detected`).toBe('tampered');
    }
  });
});

describe('the cosmetic-reformatting battery (AC2)', () => {
  it.each([
    ['key order', 'epic-7-reformatted-key-order.yaml'],
    ['quoting style', 'epic-7-reformatted-quoting.yaml'],
    ['block vs flow scalars', 'epic-7-reformatted-flow.yaml'],
    ['comments added', 'epic-7-reformatted-comments.yaml'],
    ['indentation', 'epic-7-reformatted-indentation.yaml'],
    ['CRLF line endings', 'epic-7-reformatted-crlf.yaml'],
  ])('%s does not change the fingerprint', (_name, file) => {
    const contract = parseContract(fixture(file), file);

    // Each fixture is HAND-WRITTEN — not a re-dump of the canonical file
    // through our own serializer, which would only prove the serializer is
    // deterministic. The expected hash is the one computed independently for
    // the canonical fixture.
    expect(fingerprint(contract.spec)).toBe(FROZEN_FINGERPRINT);
    expect(contractState(contract)).toBe('frozen');
    expect(() => verifyIntegrity(contract)).not.toThrow();
  });

  it('really does read a CRLF file, rather than one git normalised', () => {
    // Without this guard the CRLF case could pass for the wrong reason on a
    // checkout that rewrote line endings. `.gitattributes` marks the fixture
    // `-text` to stop that; this asserts the protection actually held.
    expect(fixture('epic-7-reformatted-crlf.yaml')).toContain('\r\n');
  });
});
