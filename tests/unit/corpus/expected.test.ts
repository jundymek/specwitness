/**
 * The corpus expectation format (story 6.1, Task 1).
 *
 * PURE. This file spawns nothing, builds nothing and reads no fixture from disk: the
 * corpus suite proper is an integration suite by nature and lives in `tests/corpus/`.
 *
 * The property under test is narrower than "the schema works". It is: **a malformed
 * expectation is REFUSED, never treated as "no expectation"**. The difference decides
 * whether a fixture with a typo in it fails loudly or quietly stops asserting anything —
 * and the second of those is the green-for-nothing shape one level up from a criterion
 * (Epic 4 retro §2 observation 2).
 */

import { describe, expect, it } from 'vitest';

import {
  EXPECTED_VERSION,
  ExpectedOutcomeError,
  loadExpectedOutcome,
  parseExpectedOutcome,
} from '../../corpus/expected.js';

/** A minimal valid expectation, cloned and broken one field at a time below. */
function valid(): Record<string, unknown> {
  return {
    expectedVersion: EXPECTED_VERSION,
    fixture: 'demo',
    why: 'A long enough sentence naming the defect class and the requirement it proves.',
    proves: ['AC1'],
    command: ['verify', 'epic-1', '--json'],
    exitCode: 0,
    outcome: { verdict: 'PASS' },
    criteria: { assertion: 'exact', statuses: { 'E1-01': 'pass' } },
  };
}

const PATH = '/corpus/demo/expected.json';

describe('a well-formed expectation', () => {
  it('parses, keeping every field the runner compares against', () => {
    const parsed = parseExpectedOutcome(JSON.stringify(valid()), PATH);

    expect(parsed.exitCode).toBe(0);
    expect(parsed.outcome).toEqual({ verdict: 'PASS' });
    expect(parsed.criteria).toEqual({ assertion: 'exact', statuses: { 'E1-01': 'pass' } });
  });

  it('accepts the infrastructure arm of the outcome', () => {
    const parsed = parseExpectedOutcome(
      JSON.stringify({ ...valid(), exitCode: 3, outcome: { infraError: 'integrity' } }),
      PATH,
    );

    expect(parsed.outcome).toEqual({ infraError: 'integrity' });
  });
});

describe('a malformed expectation is refused, and the message names the file and the field', () => {
  it('refuses text that is not JSON at all', () => {
    expect(() => parseExpectedOutcome('{ not json', PATH)).toThrow(ExpectedOutcomeError);
    expect(() => parseExpectedOutcome('{ not json', PATH)).toThrow(PATH);
  });

  it('refuses an unknown key rather than ignoring it', () => {
    // The failure this closes: `exitcode` (lower case `c`) parsed as "no exit-code
    // expectation" would leave a fixture asserting less than its author believes, forever,
    // and the suite would stay green while doing it.
    const broken = { ...valid(), exitcode: 1 };

    expect(() => parseExpectedOutcome(JSON.stringify(broken), PATH)).toThrow(/exitcode/);
  });

  it('refuses an outcome naming BOTH a verdict and an infraError', () => {
    // AD-6's exclusivity. An expectation carrying both is not redundant, it is an author
    // who did not decide which half of the product's central promise they were pinning.
    const broken = { ...valid(), outcome: { verdict: 'FAIL', infraError: 'infra' } };

    expect(() => parseExpectedOutcome(JSON.stringify(broken), PATH)).toThrow(
      ExpectedOutcomeError,
    );
  });

  it('refuses a criteria block with no assertion mode', () => {
    // REQUIRED with no default, deliberately: silence must never read as "these are all of
    // them". `subset` and `exact` are different claims and a fixture has to make one.
    const { criteria, ...rest } = valid();
    void criteria;
    const broken = { ...rest, criteria: { statuses: { 'E1-01': 'pass' } } };

    expect(() => parseExpectedOutcome(JSON.stringify(broken), PATH)).toThrow(
      /criteria\.assertion/,
    );
  });

  it('refuses an unknown criterion status', () => {
    const broken = {
      ...valid(),
      criteria: { assertion: 'exact', statuses: { 'E1-01': 'passed' } },
    };

    expect(() => parseExpectedOutcome(JSON.stringify(broken), PATH)).toThrow(
      /criteria\.statuses\.E1-01/,
    );
  });

  it('refuses a one-word `why`', () => {
    // The field exists so a reader six months from now can tell whether the fixture or the
    // product is wrong. `"regression"` cannot do that, so the schema asks for a sentence.
    const broken = { ...valid(), why: 'regression' };

    expect(() => parseExpectedOutcome(JSON.stringify(broken), PATH)).toThrow(/why/);
  });

  it('refuses a future expectedVersion rather than coercing it', () => {
    const broken = { ...valid(), expectedVersion: EXPECTED_VERSION + 1 };

    expect(() => parseExpectedOutcome(JSON.stringify(broken), PATH)).toThrow(
      /expectedVersion/,
    );
  });
});

describe('loadExpectedOutcome', () => {
  it('reports a missing file as an error naming the fixture, never as an empty expectation', async () => {
    await expect(
      loadExpectedOutcome('/corpus/ghost', 'ghost', '/corpus/ghost/expected.json'),
    ).rejects.toThrow(/ghost/);
    await expect(
      loadExpectedOutcome('/corpus/ghost', 'ghost', '/corpus/ghost/expected.json'),
    ).rejects.toThrow(ExpectedOutcomeError);
  });
});

/* ── story 6.10: the optional `evidence` expectation ────────────────────────────────── */

describe('the optional `evidence` key', () => {
  it('is OPTIONAL: an expectation omitting it parses and asserts nothing about evidence', () => {
    // AC2, and the whole reason this key could land at all. Every fixture merged before this
    // story omits `evidence`, and none of them may change meaning by virtue of the key
    // existing. A format change that silently re-reads files nobody re-opened is exactly what
    // `EXPECTED_VERSION` exists to prevent (see its doc comment).
    const parsed = parseExpectedOutcome(JSON.stringify(valid()), PATH);

    expect(parsed.evidence).toBeUndefined();
  });

  it('parses a well-formed expectation, keeping the assertion mode and the kinds', () => {
    const parsed = parseExpectedOutcome(
      JSON.stringify({
        ...valid(),
        evidence: { assertion: 'exact', kinds: ['gate', 'command', 'observation'] },
      }),
      PATH,
    );

    expect(parsed.evidence).toEqual({
      assertion: 'exact',
      kinds: ['gate', 'command', 'observation'],
    });
  });

  it('refuses an `evidence` block with no assertion mode, naming the field', () => {
    // AC3. The same rule `criteria.assertion` follows and for the same reason: a defaulted
    // discriminator lets a fixture be READ as making the stronger claim when its author meant
    // the weaker one. Silence must never be readable as a claim.
    const broken = { ...valid(), evidence: { kinds: ['gate'] } };

    expect(() => parseExpectedOutcome(JSON.stringify(broken), PATH)).toThrow(/assertion/);
  });

  it('refuses a misspelled evidence kind at LOAD, rather than never matching it', () => {
    // The failure mode this closes: `"observaton"` is not a kind the product can ever emit,
    // so a fixture carrying it under `subset` would demand a kind that cannot appear and go
    // red for the wrong reason — or, worse, under a laxer schema, be quietly compared against
    // nothing. The six kinds are a closed union (`src/domain/evidence.ts`), so the typo is
    // caught by the same enum the product uses.
    const broken = { ...valid(), evidence: { assertion: 'subset', kinds: ['observaton'] } };

    expect(() => parseExpectedOutcome(JSON.stringify(broken), PATH)).toThrow(/kinds/);
  });

  it('refuses an unknown key INSIDE the evidence block', () => {
    // `.strict()` holds all the way down. A misspelled `kind` (singular) beside a correct
    // `kinds` would otherwise be silently ignored.
    const broken = {
      ...valid(),
      evidence: { assertion: 'exact', kinds: ['gate'], kind: 'gate' },
    };

    expect(() => parseExpectedOutcome(JSON.stringify(broken), PATH)).toThrow(/kind/);
  });

  it('refuses a `subset` expectation over an EMPTY set, because it can never fail', () => {
    // The vacuous pass, guarded. `subset` means "every listed kind must be present"; over an
    // empty list that is satisfied by every run there has ever been, including one that
    // produced no evidence at all because a verification surface silently stopped emitting
    // any. A fixture whose evidence assertion cannot fail is a fixture asserting nothing while
    // looking like it asserts something — which is the precise shape this whole story exists
    // to close.
    const broken = { ...valid(), evidence: { assertion: 'subset', kinds: [] } };

    expect(() => parseExpectedOutcome(JSON.stringify(broken), PATH)).toThrow(/kinds/);
  });

  it('ACCEPTS an `exact` expectation over an empty set, which is a real claim', () => {
    // The other side of the guard above, and the reason `kinds` is not simply `.min(1)`.
    // `exact` + `[]` says "this run produced NO evidence at all" — a claim that CAN go red,
    // the moment the run starts producing any. Forbidding it would remove an assertion the
    // format should be able to make in order to close a hole it does not have.
    const parsed = parseExpectedOutcome(
      JSON.stringify({ ...valid(), evidence: { assertion: 'exact', kinds: [] } }),
      PATH,
    );

    expect(parsed.evidence).toEqual({ assertion: 'exact', kinds: [] });
  });

  it('refuses a duplicated kind, because the expectation is a SET', () => {
    // `["gate", "gate"]` is not a stronger claim than `["gate"]`; it is an author who thinks
    // the field counts occurrences. It does not, and the comparison is set arithmetic, so the
    // honest response is to refuse the file rather than silently deduplicate it.
    const broken = {
      ...valid(),
      evidence: { assertion: 'exact', kinds: ['gate', 'gate'] },
    };

    expect(() => parseExpectedOutcome(JSON.stringify(broken), PATH)).toThrow(/kinds/);
  });
});
