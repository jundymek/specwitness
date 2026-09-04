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
