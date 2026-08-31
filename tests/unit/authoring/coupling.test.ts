import { describe, expect, it } from 'vitest';

import { findCouplingHints, flagCoupledCriteria } from '../../../src/authoring/coupling.js';

/**
 * The coupling flagger is ADVICE, never a gate (FR-7 takes the "flagged for
 * review" branch). These tests pin both halves of that: it must notice the
 * statements a reviewer would want to look at, and it must never be treated as
 * a rejection — including in the one case where it is deliberately wrong.
 */

describe('findCouplingHints', () => {
  it('flags a bare function call', () => {
    const hints = findCouplingHints('The verify() function returns a PASS verdict.');

    expect(hints.map((hint) => hint.kind)).toContain('function-call');
    expect(hints[0]?.match).toBe('verify()');
  });

  it('flags a class reference', () => {
    const hints = findCouplingHints('A new class RunStore is constructed for every run.');

    expect(hints.map((hint) => hint.kind)).toContain('class-reference');
    expect(hints[0]?.match).toBe('class RunStore');
  });

  it('flags a method call on a receiver', () => {
    const hints = findCouplingHints('The pipeline calls store.createRun(epic) before starting.');

    expect(hints.map((hint) => hint.kind)).toContain('method-call');
    expect(hints[0]?.match).toBe('store.createRun(');
  });

  it('flags a source file path', () => {
    const hints = findCouplingHints('Exit codes are defined in src/cli/exit.ts and nowhere else.');

    expect(hints.map((hint) => hint.kind)).toContain('file-path');
    expect(hints[0]?.match).toBe('src/cli/exit.ts');
  });

  it('reports every distinct hint in one statement', () => {
    const hints = findCouplingHints('parseContract() in src/schemas/contract.ts rejects unknown keys.');

    expect(hints.map((hint) => hint.kind).sort()).toEqual(['file-path', 'function-call']);
  });

  it('does not flag a plainly behavioral statement', () => {
    const hints = findCouplingHints(
      'Running the command against an epic with no frozen contract refuses and explains how to freeze one.',
    );

    expect(hints).toEqual([]);
  });

  it('does not flag ordinary prose containing a period between words', () => {
    // 'behaviour.  The' and 'e.g.' must not read as method calls: the pattern
    // requires an opening parenthesis, which prose does not supply.
    const hints = findCouplingHints('The exit code is 0. The report names every criterion.');

    expect(hints).toEqual([]);
  });

  it('never mutates the statement it inspects', () => {
    const statement = 'The verify() function returns a PASS verdict.';

    findCouplingHints(statement);

    expect(statement).toBe('The verify() function returns a PASS verdict.');
  });

  it('returns nothing for an empty statement rather than throwing', () => {
    expect(findCouplingHints('')).toEqual([]);
  });

  /**
   * DELIBERATE, DOCUMENTED FALSE POSITIVE — and the reason this is a flag and
   * not a gate.
   *
   * "Users can export their data as report.csv" is a legitimate behavioral
   * statement about a user-visible artifact, and the file-path heuristic cannot
   * tell it apart from a statement naming an internal module. Rejecting it
   * would block a correct contract; flagging it costs the reviewer one glance.
   *
   * The same latitude is what lets a `structural` criterion legitimately name a
   * module. The human decides — which is exactly FR-7's flag branch.
   */
  it('accepts a documented false positive rather than risk rejecting a correct statement', () => {
    const hints = findCouplingHints('Users can export their results as report.csv from the summary screen.');

    expect(hints.map((hint) => hint.kind)).toContain('file-path');
    // The point of the assertion: it is a HINT, carrying no verdict of any kind.
    expect(Object.keys(hints[0] ?? {}).sort()).toEqual(['kind', 'match']);
  });
});

describe('flagCoupledCriteria', () => {
  const criteria = [
    { id: 'E7-01', statement: 'The command refuses a frozen contract and explains why.' },
    { id: 'E7-02', statement: 'The freeze() function stores the fingerprint.' },
    { id: 'E7-03', statement: 'Ids are built by src/domain/ids.ts.' },
  ];

  it('reports only the criteria that carry hints, in order', () => {
    const flagged = flagCoupledCriteria(criteria);

    expect(flagged.map((entry) => entry.id)).toEqual(['E7-02', 'E7-03']);
  });

  it('carries the hints through so the operator sees what was matched', () => {
    const flagged = flagCoupledCriteria(criteria);

    expect(flagged[0]?.hints.map((hint) => hint.match)).toEqual(['freeze()']);
  });

  it('returns an empty list when nothing is coupled — never a failure', () => {
    expect(flagCoupledCriteria([criteria[0] as (typeof criteria)[number]])).toEqual([]);
  });

  it('handles an empty criteria list', () => {
    expect(flagCoupledCriteria([])).toEqual([]);
  });
});
