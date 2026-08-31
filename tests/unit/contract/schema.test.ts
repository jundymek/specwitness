import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ConfigError, IntegrityError } from '../../../src/domain/errors.js';
import type { ContractSpec } from '../../../src/domain/contract.js';
import { canonicalize, fingerprint } from '../../../src/schemas/canonical.js';
import {
  CONTRACT_SCHEMA_VERSION,
  ContractSchema,
  contractState,
  freeze,
  isFrozen,
  parseContract,
  serializeContract,
} from '../../../src/schemas/contract.js';
import { SCHEMA_VERSIONS } from '../../../src/schemas/versions.js';

const FIXTURES = new URL('../../fixtures/contracts/', import.meta.url);

/**
 * Reading a fixture is the ONLY filesystem access in this story's tests, and it
 * is the test doing it — never the code under test. `parseContract` and
 * `serializeContract` take and return strings; `.specwitness/contracts/` is
 * story 2.6's territory.
 */
function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, FIXTURES)), 'utf8');
}

const FROZEN_FINGERPRINT = '4f7f9292551ac1cf01d2b77d4e845561b6e6f4331d34ae5c07e7730312d1f184';

describe('CONTRACT_SCHEMA_VERSION', () => {
  it('comes from the AD-5 registry rather than a literal', () => {
    expect(CONTRACT_SCHEMA_VERSION).toBe(SCHEMA_VERSIONS.contract);
    expect(CONTRACT_SCHEMA_VERSION).toBe(1);
  });
});

describe('parseContract — the happy path', () => {
  it('reads the canonical frozen fixture into the model', () => {
    const contract = parseContract(fixture('epic-7-frozen.yaml'), 'contracts/epic-7.yaml');

    expect(Object.keys(contract).sort()).toEqual(['meta', 'spec']);
    expect(contract.spec.epic).toBe('epic-7');
    expect(contract.spec.version).toBe(1);
    expect(contract.spec.criteria).toHaveLength(3);
    expect(contract.meta.frozen).toBe(true);
    expect(contract.meta.fingerprint).toBe(FROZEN_FINGERPRINT);
    expect(contract.meta.history).toEqual([]);
  });

  it('preserves a multi-line statement exactly, newline included', () => {
    const contract = parseContract(fixture('epic-7-frozen.yaml'), 'p');

    expect(contract.spec.criteria[1]?.statement).toBe(
      'Only an owner may invite a member.\nA member who tries receives 403 and no invitation is created.',
    );
  });

  it('reads an unfrozen draft without complaint', () => {
    const contract = parseContract(fixture('epic-7-draft.yaml'), 'p');

    expect(contract.meta.frozen).toBe(false);
    expect(contract.meta.fingerprint).toBeNull();
    expect(contract.meta.frozenAt).toBeNull();
  });

  it('records an absent provenance value as an explicit null', () => {
    const contract = parseContract(fixture('epic-7-frozen.yaml'), 'p');

    // The codex path cannot report a model at all. `null` is the recorded
    // absence; the key is never simply missing.
    expect(contract.meta.provenance.model).toBeNull();
    expect(contract.meta.provenance.provider).toBe('codex');
    expect(contract.meta.provenance.providerCliVersion).toBe('0.144.4');
  });

  it('does NOT throw on a tampered file — a mismatch is reportable, not fatal', () => {
    // Story 2.6 renders `integrity: mismatch` as a field in `--status --json`.
    // If parsing threw here, the only answer the command could give would be a
    // crash.
    const contract = parseContract(fixture('epic-7-tampered.yaml'), 'p');

    expect(contract.meta.frozen).toBe(true);
    expect(fingerprint(contract.spec)).not.toBe(contract.meta.fingerprint);
  });
});

describe('parseContract — rejections', () => {
  it.each([
    ['not valid YAML', 'invalid-not-yaml.yaml', /yaml/i],
    ['an unknown key inside a criterion', 'invalid-unknown-key.yaml', /owner/],
    ['a missing meta block', 'invalid-missing-meta.yaml', /meta/],
    ['a third top-level key', 'invalid-third-top-level-key.yaml', /notes/],
    ['a malformed criterion id', 'invalid-criterion-id.yaml', /E07-1|criterion id/],
  ])('rejects %s with a ConfigError naming it', (_name, file, pattern) => {
    try {
      parseContract(fixture(file), 'contracts/epic-7.yaml');
      expect.unreachable('expected a ConfigError');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toMatch(pattern);
      // Every rejection names the file, because the operator is looking at a
      // path, not at an in-memory value.
      expect((err as Error).message).toContain('contracts/epic-7.yaml');
      expect((err as ConfigError).hint).toBeDefined();
    }
  });

  it('names the failing path, not just the fact of failure', () => {
    try {
      parseContract(fixture('invalid-unknown-key.yaml'), 'p');
      expect.unreachable('expected a ConfigError');
    } catch (err) {
      // `spec.criteria.0.owner`, so a reviewer can go straight to the line.
      expect((err as Error).message).toMatch(/spec\.criteria\.0/);
    }
  });

  it('tells the operator to upgrade when a newer specwitness wrote the file', () => {
    try {
      parseContract(fixture('invalid-future-schema-version.yaml'), 'contracts/epic-7.yaml');
      expect.unreachable('expected a ConfigError');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      // The ERROR line itself says it — that is the *what*, not the remedy, so
      // it does not belong in the HINT alone.
      expect((err as Error).message).toMatch(/newer specwitness/i);
      expect((err as Error).message).toContain('99');
      expect((err as ConfigError).hint).toMatch(/upgrade/i);
      // And it must NOT be a pile of shape errors about `rationale`.
      expect((err as Error).message).not.toMatch(/rationale/);
    }
  });

  it.each([
    ['frozen with no fingerprint', 'invalid-frozen-without-fingerprint.yaml'],
    ['unfrozen with a fingerprint', 'invalid-unfrozen-with-fingerprint.yaml'],
  ])('raises an IntegrityError for a contract that is %s', (_name, file) => {
    // Not a ConfigError: the document is structurally fine and claims a state
    // it cannot substantiate. Treating it as a plain draft would launder a
    // tamper into a legitimate-looking redraft.
    expect(() => parseContract(fixture(file), 'p')).toThrow(IntegrityError);
  });

  it('rejects a non-integer contract version', () => {
    const text = fixture('epic-7-draft.yaml').replace('version: 1', 'version: 1.5');

    expect(() => parseContract(text, 'p')).toThrow(ConfigError);
  });

  it('rejects a zero or negative contract version', () => {
    for (const bad of ['version: 0', 'version: -1']) {
      const text = fixture('epic-7-draft.yaml').replace('version: 1', bad);
      expect(() => parseContract(text, 'p')).toThrow(ConfigError);
    }
  });

  it('rejects an empty document and a comments-only document', () => {
    for (const text of ['', '\n\n', '# just a comment\n']) {
      expect(() => parseContract(text, 'p')).toThrow(ConfigError);
    }
  });

  it('rejects a fingerprint that is not 64 lowercase hex characters', () => {
    for (const bad of ['ABCDEF', 'a'.repeat(63), 'A'.repeat(64), 'not-a-hash']) {
      const text = fixture('epic-7-frozen.yaml').replace(FROZEN_FINGERPRINT, bad);
      expect(() => parseContract(text, 'p')).toThrow();
    }
  });

  it('rejects a timestamp that names a date which does not exist', () => {
    const text = fixture('epic-7-frozen.yaml').replace(
      'createdAt: 2026-08-31T09:00:00.000Z',
      'createdAt: 2026-02-31T09:00:00.000Z',
    );

    expect(() => parseContract(text, 'p')).toThrow(ConfigError);
  });

  it('rejects a duplicate YAML key rather than silently taking the last one', () => {
    // Two `version:` keys is what a bad merge produces. Silently taking one
    // would mean the file a human reviewed is not the file that was hashed.
    const text = fixture('epic-7-draft.yaml').replace('version: 1', 'version: 1\n  version: 2');

    expect(() => parseContract(text, 'p')).toThrow(ConfigError);
  });
});

describe('parseContract — accepts what it must not reject', () => {
  it('accepts a criterion statement that names a function or a file', () => {
    // FR-7 offers "rejected by schema-level lint OR flagged for review", and
    // epics.md story 2.6 AC1 settles on flagging. A schema that rejected this
    // would make a legitimate `structural` criterion unwritable.
    const text = fixture('epic-7-draft.yaml').replace(
      'statement: A new company appears in the companies list after onboarding completes.',
      'statement: "src/cli/exit.ts maps IntegrityError() to exit code 3."',
    );

    const contract = parseContract(text, 'p');
    expect(contract.spec.criteria[0]?.statement).toContain('IntegrityError()');
  });

  it('accepts a sequence number past 99', () => {
    const text = fixture('epic-7-draft.yaml').replace('id: E7-01', 'id: E7-100');

    expect(parseContract(text, 'p').spec.criteria[0]?.id).toBe('E7-100');
  });
});

describe('parseContract — criterion ids are identities, so they must be unique', () => {
  it('rejects two criteria sharing an id, naming the id and the position', () => {
    // AD-5: plans reference criteria BY ID ONLY and never embed statements. Two
    // criteria answering to `E7-01` make a plan reference ambiguous — a probe
    // could be compiled against one expectation and its result reported against
    // the other — and the ambiguity would be frozen and fingerprinted, i.e.
    // authoritative. The PRD Glossary calls an id "stable", which is only
    // meaningful if it identifies exactly one criterion.
    const text = fixture('epic-7-frozen.yaml').replace('id: E7-03', 'id: E7-01');

    try {
      parseContract(text, 'contracts/epic-7.yaml');
      expect.unreachable('expected a ConfigError');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain('E7-01');
      // The path points at the DUPLICATE, not at the first occurrence: the
      // second one is the line the operator has to change.
      expect((err as Error).message).toMatch(/spec\.criteria\.2/);
      expect((err as ConfigError).hint).toBeDefined();
    }
  });

  it('reports every duplicate, not just the first', () => {
    const text = fixture('epic-7-frozen.yaml')
      .replace('id: E7-02', 'id: E7-01')
      .replace('id: E7-03', 'id: E7-01');

    try {
      parseContract(text, 'p');
      expect.unreachable('expected a ConfigError');
    } catch (err) {
      expect((err as Error).message).toMatch(/spec\.criteria\.1/);
      expect((err as Error).message).toMatch(/spec\.criteria\.2/);
    }
  });

  it('still accepts distinct ids that merely look similar', () => {
    const text = fixture('epic-7-frozen.yaml').replace('id: E7-03', 'id: E7-030');

    expect(parseContract(text, 'p').spec.criteria).toHaveLength(3);
  });
});

describe("parseContract — story 2.7's amend output is a legitimate draft", () => {
  // Confirmed for chuck (2.6) rather than assumed, after dolph (2.7) reversed
  // his amend flow to stop at an unfrozen draft instead of re-freezing in-call.
  // This is the one shape where "is a draft" and "has been frozen before" are
  // both true: frozen false, fingerprint null, frozenAt null, history NON-empty,
  // version >= 2. Rejecting it would break the only sanctioned way a contract
  // legitimately changes.
  const amended = (): string => fixture('epic-7-amended-draft.yaml');

  it('parses without complaint', () => {
    const contract = parseContract(amended(), 'contracts/epic-7.yaml');

    expect(contract.meta.frozen).toBe(false);
    expect(contract.meta.fingerprint).toBeNull();
    expect(contract.meta.frozenAt).toBeNull();
    expect(contract.meta.history).toHaveLength(1);
    expect(contract.spec.version).toBe(2);
  });

  it('records the superseded version and ITS fingerprint, not the new one', () => {
    const entry = parseContract(amended(), 'p').meta.history[0];

    expect(entry?.version).toBe(1);
    expect(entry?.fingerprint).toBe(FROZEN_FINGERPRINT);
    expect(entry?.reason).toContain('onboarding now emails the owner');
  });

  it('reports as a draft, not as tampered', () => {
    // A history entry is `meta`, so it is outside the hash entirely. An amended
    // draft has no fingerprint to mismatch against.
    expect(contractState(parseContract(amended(), 'p'))).toBe('draft');
    expect(isFrozen(parseContract(amended(), 'p'))).toBe(false);
  });

  it('round-trips with its history intact and readable', () => {
    const contract = parseContract(amended(), 'p');
    const text = serializeContract(contract);

    expect(parseContract(text, 'p')).toEqual(contract);
    expect(text).toContain('history:');
    expect(text).toContain('reason: onboarding now emails the owner');
  });

  it('freezes by the ordinary path, leaving history untouched', () => {
    const contract = parseContract(amended(), 'p');
    const result = freeze(contract, new Date('2026-09-14T12:30:00.000Z'));

    expect(result.meta.frozen).toBe(true);
    expect(result.meta.history).toEqual(contract.meta.history);
    expect(result.spec.version).toBe(2);
    expect(contractState(result)).toBe('frozen');
  });
});

describe('parseContract — a whitespace-only statement is not a requirement', () => {
  it.each([
    ['spaces', '"   "'],
    ['a tab', '"\t"'],
    ['newlines', '"\n\n"'],
    ['mixed whitespace', '" \t \n "'],
  ])('rejects a statement made only of %s', (_name, literal) => {
    const text = fixture('epic-7-draft.yaml').replace(
      'statement: A new company appears in the companies list after onboarding completes.',
      `statement: ${literal}`,
    );

    expect(() => parseContract(text, 'p')).toThrow(ConfigError);
  });

  it('is refused BEFORE it can be canonicalized — the reason the rule exists', () => {
    // This is the consequence, not merely the rejection. `min(1)` accepts
    // "   ", but `canonicalize` trims it, so the criterion would be
    // FINGERPRINTED as `"statement":""` — byte-identical to the empty statement
    // the schema already rejects, and frozen as authoritative. A criterion that
    // asserts nothing can never fail: a green result that means nothing, which
    // is the one outcome this product exists to make impossible.
    const whitespaceOnly: ContractSpec = {
      epic: 'epic-7',
      version: 1,
      criteria: [
        {
          id: 'E7-01',
          statement: '   ',
          kind: 'behavioral',
          severity: 'critical',
          verifiability: 'automated',
        },
      ],
    };
    const empty: ContractSpec = {
      ...whitespaceOnly,
      criteria: [{ ...whitespaceOnly.criteria[0]!, statement: '' }],
    };

    // The two are indistinguishable once hashed — which is exactly why the
    // schema must not let the first one through when it rejects the second.
    expect(canonicalize(whitespaceOnly)).toContain('"statement":""');
    expect(fingerprint(whitespaceOnly)).toBe(fingerprint(empty));

    // And so the document carrying it never parses.
    const text = fixture('epic-7-draft.yaml').replace(
      'statement: A new company appears in the companies list after onboarding completes.',
      'statement: "   "',
    );
    expect(() => parseContract(text, 'p')).toThrow(ConfigError);
  });

  it('still accepts a statement that merely has padding around real text', () => {
    // Trimming stays a canonicalization concern (DECISIONS D-5): the parser is
    // faithful, so padded text survives into the model unchanged and
    // serialization stays lossless.
    const text = fixture('epic-7-draft.yaml').replace(
      'statement: A new company appears in the companies list after onboarding completes.',
      'statement: "  a real expectation  "',
    );

    expect(parseContract(text, 'p').spec.criteria[0]?.statement).toBe('  a real expectation  ');
  });
});

describe('parseContract — the amendment history must be a coherent audit chain', () => {
  // FR-10 makes `meta.history` the auditable record of which version superseded
  // which. Story 2.7's amend flow writes it and a future reader trusts it, so a
  // chain contradicting `spec.version` misrepresents the audit trail inside a
  // document that reads as authoritative. An incoherent trail is worse than an
  // absent one, precisely because it looks like evidence.
  const FP_A = 'a'.repeat(64);
  const FP_B = 'b'.repeat(64);

  const withHistory = (version: number, entries: ReadonlyArray<readonly [number, string]>): string => {
    const rendered = entries
      .map(
        ([v, fp]) =>
          `    - version: ${v}\n` +
          `      fingerprint: ${fp}\n` +
          `      timestamp: 2026-09-14T12:00:00.000Z\n` +
          `      reason: an amendment\n`,
      )
      .join('');

    return fixture('epic-7-amended-draft.yaml')
      .replace('  version: 2', `  version: ${version}`)
      .replace(/  history:\n(?:.*\n?)*$/, `  history:\n${rendered}`);
  };

  it('rejects a superseded version at or above the current one', () => {
    expect(() => parseContract(withHistory(2, [[9, FP_A]]), 'p')).toThrow(ConfigError);
    expect(() => parseContract(withHistory(2, [[2, FP_A]]), 'p')).toThrow(ConfigError);
  });

  it('rejects duplicate versions in the history', () => {
    expect(() =>
      parseContract(withHistory(3, [[1, FP_A], [1, FP_B]]), 'p'),
    ).toThrow(ConfigError);
  });

  it('rejects history entries that are out of order', () => {
    expect(() =>
      parseContract(withHistory(4, [[2, FP_A], [1, FP_B]]), 'p'),
    ).toThrow(ConfigError);
  });

  it('names the offending entry by path', () => {
    try {
      parseContract(withHistory(2, [[9, FP_A]]), 'contracts/epic-7.yaml');
      expect.unreachable('expected a ConfigError');
    } catch (err) {
      expect((err as Error).message).toMatch(/meta\.history\.0/);
    }
  });

  it('accepts an ascending history below the current version', () => {
    const contract = parseContract(withHistory(3, [[1, FP_A], [2, FP_B]]), 'p');

    expect(contract.meta.history.map((h) => h.version)).toEqual([1, 2]);
    expect(contract.spec.version).toBe(3);
  });

  it('accepts a gap — a chain need not be contiguous', () => {
    // Deliberately NOT requiring [1..V-1]. Story 2.7 appends exactly one entry
    // per amendment, so its output is contiguous anyway; demanding contiguity
    // would reject a legitimate contract whose earlier versions predate this
    // file, and would add nothing the ordering rule does not already assert.
    expect(() => parseContract(withHistory(5, [[1, FP_A], [3, FP_B]]), 'p')).not.toThrow();
  });

  it('still accepts an empty history on a fresh draft', () => {
    expect(parseContract(fixture('epic-7-draft.yaml'), 'p').meta.history).toEqual([]);
  });

  it('still accepts the amend-output fixture unchanged', () => {
    // The shape 2.6 asked me to pin: version 2, one entry for version 1.
    expect(parseContract(fixture('epic-7-amended-draft.yaml'), 'p').meta.history).toHaveLength(1);
  });
});

describe('parseContract — spec.epic must be the canonical epic id', () => {
  it.each([
    ['a padded id', 'epic-07'],
    ['a bare number', '7'],
    ['an uppercase prefix', 'EPIC-7'],
    ['something else entirely', 'onboarding'],
  ])('rejects %s', (_name, epic) => {
    // `domain/ids.ts` is the only normalizer and `epic-7` is its canonical
    // output (spine Identifiers row). A contract persisted with `epic-07` would
    // disagree with the CLI's normalized id and with its own file path — and,
    // being inside `spec`, the discrepancy would be frozen and fingerprinted.
    const text = fixture('epic-7-draft.yaml').replace('epic: epic-7', `epic: "${epic}"`);

    expect(() => parseContract(text, 'p')).toThrow(ConfigError);
  });

  it('accepts the canonical form', () => {
    expect(parseContract(fixture('epic-7-draft.yaml'), 'p').spec.epic).toBe('epic-7');
  });
});

describe('parseContract — criterion ids must belong to this contract epic', () => {
  it("rejects a criterion whose id names another epic", () => {
    // The epic number is embedded in the stable identifier that plans and
    // reports key on, so `E8-01` inside an epic-7 contract is a criterion
    // belonging to a different contract — a copy-paste between two epics,
    // frozen and made authoritative.
    const text = fixture('epic-7-frozen.yaml').replace('id: E7-02', 'id: E8-02');

    try {
      parseContract(text, 'contracts/epic-7.yaml');
      expect.unreachable('expected a ConfigError');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain('E8-02');
      expect((err as Error).message).toMatch(/epic-7/);
      expect((err as Error).message).toMatch(/spec\.criteria\.1/);
    }
  });

  it('accepts every criterion whose epic component matches', () => {
    expect(parseContract(fixture('epic-7-frozen.yaml'), 'p').spec.criteria).toHaveLength(3);
  });

  it('is not fooled by a padded epic component', () => {
    // `E07-01` is already rejected by the id format itself; this pins that the
    // epic-match refinement does not accidentally accept it by normalising.
    const text = fixture('epic-7-frozen.yaml').replace('id: E7-01', 'id: E07-01');

    expect(() => parseContract(text, 'p')).toThrow(ConfigError);
  });
});

describe('parseContract — frozenAt must agree with the frozen state', () => {
  it('rejects a frozen contract with no frozenAt', () => {
    const text = fixture('epic-7-frozen.yaml').replace(
      'frozenAt: 2026-08-31T09:05:00.000Z',
      'frozenAt: null',
    );

    expect(() => parseContract(text, 'p')).toThrow(IntegrityError);
  });

  it('rejects a draft carrying a freeze timestamp', () => {
    const text = fixture('epic-7-draft.yaml').replace(
      'frozenAt: null',
      'frozenAt: 2026-08-31T09:05:00.000Z',
    );

    expect(() => parseContract(text, 'p')).toThrow(IntegrityError);
  });

  it('accepts the two consistent combinations', () => {
    expect(parseContract(fixture('epic-7-frozen.yaml'), 'p').meta.frozenAt).toBe(
      '2026-08-31T09:05:00.000Z',
    );
    expect(parseContract(fixture('epic-7-draft.yaml'), 'p').meta.frozenAt).toBeNull();
  });
});

describe('serializeContract — human-readable and lossless', () => {
  it('round-trips a parsed contract back to identical bytes', () => {
    const text = fixture('epic-7-frozen.yaml');

    // Direction 1: serialize(parse(canonicalText)) is byte-identical.
    expect(serializeContract(parseContract(text, 'p'))).toBe(text);
  });

  it('round-trips a contract value through text and back', () => {
    const contract = parseContract(fixture('epic-7-frozen.yaml'), 'p');

    // Direction 2: parse(serialize(contract)) deep-equals the contract.
    expect(parseContract(serializeContract(contract), 'p')).toEqual(contract);
  });

  it('normalises a cosmetically reformatted file to the canonical bytes', () => {
    const canonical = fixture('epic-7-frozen.yaml');

    for (const variant of [
      'epic-7-reformatted-key-order.yaml',
      'epic-7-reformatted-quoting.yaml',
      'epic-7-reformatted-flow.yaml',
      'epic-7-reformatted-comments.yaml',
      'epic-7-reformatted-indentation.yaml',
    ]) {
      expect(serializeContract(parseContract(fixture(variant), variant)), variant).toBe(canonical);
    }
  });

  it('ends with exactly one newline and uses LF throughout', () => {
    const text = serializeContract(parseContract(fixture('epic-7-frozen.yaml'), 'p'));

    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(text).not.toContain('\r');
  });

  it('keeps `spec` above `meta` so a reviewer reads the content first', () => {
    const text = serializeContract(parseContract(fixture('epic-7-draft.yaml'), 'p'));

    expect(text.startsWith('spec:')).toBe(true);
    expect(text.indexOf('\nmeta:')).toBeGreaterThan(0);
  });

  it('writes a null rather than omitting an unknown provenance value', () => {
    const text = serializeContract(parseContract(fixture('epic-7-frozen.yaml'), 'p'));

    expect(text).toContain('model: null');
  });

  it('round-trips a version string that YAML would otherwise read as a number', () => {
    // `providerCliVersion: 1.0` unquoted loads as the number 1. The serializer
    // must quote it, or a re-read fails a type check that has nothing to do
    // with the user.
    const contract = parseContract(fixture('epic-7-draft.yaml'), 'p');
    const withNumericVersion = {
      ...contract,
      meta: {
        ...contract.meta,
        provenance: { ...contract.meta.provenance, providerCliVersion: '1.0' },
      },
    };

    const reparsed = parseContract(serializeContract(withNumericVersion), 'p');
    expect(reparsed.meta.provenance.providerCliVersion).toBe('1.0');
  });

  it('round-trips unusual unicode and a very long statement', () => {
    const contract = parseContract(fixture('epic-7-draft.yaml'), 'p');
    const statement = `${'a very long statement that keeps going and going '.repeat(20)}— café ☕ 家 🇵🇱`;
    const long = {
      ...contract,
      spec: {
        ...contract.spec,
        criteria: [{ ...contract.spec.criteria[0]!, statement }],
      },
    };

    const reparsed = parseContract(serializeContract(long), 'p');
    expect(reparsed.spec.criteria[0]?.statement).toBe(statement);
    expect(fingerprint(reparsed.spec)).toBe(fingerprint(long.spec));
  });
});

describe('ContractSchema — strictness at every level', () => {
  const valid = {
    spec: { epic: 'epic-7', version: 1, criteria: [] },
    meta: {
      schemaVersion: 1,
      frozen: false,
      fingerprint: null,
      createdAt: '2026-08-31T09:00:00.000Z',
      frozenAt: null,
      provenance: { provider: null, model: null, providerCliVersion: null, generatedAt: null },
      history: [],
    },
  };

  it('accepts the minimal valid document', () => {
    expect(ContractSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects an unknown key at every level', () => {
    const cases: Array<[string, unknown]> = [
      ['<root>', { ...valid, extra: 1 }],
      ['spec', { ...valid, spec: { ...valid.spec, extra: 1 } }],
      ['meta', { ...valid, meta: { ...valid.meta, extra: 1 } }],
      [
        'meta.provenance',
        { ...valid, meta: { ...valid.meta, provenance: { ...valid.meta.provenance, extra: 1 } } },
      ],
      [
        'a criterion',
        {
          ...valid,
          spec: {
            ...valid.spec,
            criteria: [
              {
                id: 'E7-01',
                statement: 'x',
                kind: 'behavioral',
                severity: 'normal',
                verifiability: 'automated',
                extra: 1,
              },
            ],
          },
        },
      ],
    ];

    for (const [where, value] of cases) {
      const result = ContractSchema.safeParse(value);
      expect(result.success, `expected an unknown key at ${where} to be rejected`).toBe(false);
    }
  });

  it('accepts a populated history entry with exactly the four fields', () => {
    const result = ContractSchema.safeParse({
      ...valid,
      spec: { ...valid.spec, version: 2 },
      meta: {
        ...valid.meta,
        history: [
          {
            version: 1,
            fingerprint: FROZEN_FINGERPRINT,
            timestamp: '2026-08-31T09:05:00.000Z',
            reason: 'requirement changed: onboarding now emails the owner',
          },
        ],
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects an author field on a history entry', () => {
    // V0 has no identity system. A self-reported name would be an attestation
    // with no attester behind it, and a later reader would trust it. Authorship
    // is attested by git history; story 2.7 agreed this explicitly.
    const result = ContractSchema.safeParse({
      ...valid,
      meta: {
        ...valid.meta,
        history: [
          {
            version: 1,
            fingerprint: FROZEN_FINGERPRINT,
            timestamp: '2026-08-31T09:05:00.000Z',
            reason: 'because',
            author: 'marek',
          },
        ],
      },
    });

    expect(result.success).toBe(false);
  });
});
