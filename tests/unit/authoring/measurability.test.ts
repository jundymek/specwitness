import { describe, expect, it } from 'vitest';

import {
  findMeasurabilityFindings,
  findUnmeasurableCriteria,
} from '../../../src/authoring/measurability.js';

/**
 * Every "must refuse" case below is a REAL criterion from the tenstandard
 * dogfooding project, quoted from the frozen contracts of epics 4 and 5, and
 * every one of them cost something: three epic-5 reds on a correct product, a
 * red that no implementation could ever clear, and — worst — an epic-4 green
 * that would have passed against a build whose validator did nothing.
 *
 * The "must accept" cases matter just as much. This module REFUSES rather than
 * flags, so a false positive blocks a freeze. Each accepted case is a
 * well-formed criterion that contains the surface features the detector looks
 * for, and must survive anyway.
 */

describe('findMeasurabilityFindings — test idioms', () => {
  it('refuses a criterion naming assertNumQueries (E5-24, E5-27, E5-41)', () => {
    const findings = findMeasurabilityFindings(
      'Every list endpoint has an assertNumQueries ceiling that does not grow with row count.',
    );

    expect(findings.map((finding) => finding.kind)).toContain('test-idiom');
    expect(findings[0]?.match).toBe('assertNumQueries');
  });

  it("refuses the other project's spelling of the same idiom, so neither wins", () => {
    const findings = findMeasurabilityFindings(
      'The endpoint is covered by django_assert_num_queries in its test module.',
    );

    expect(findings.map((finding) => finding.kind)).toContain('test-idiom');
  });

  it('accepts the same requirement stated as behaviour', () => {
    const findings = findMeasurabilityFindings(
      'The case list endpoint issues a constant number of database queries regardless of how many cases the page returns.',
    );

    expect(findings).toEqual([]);
  });
});

describe('findMeasurabilityFindings — unpartnered negatives', () => {
  it('refuses "writes nothing at all", which passed against a do-nothing validator (E4-51)', () => {
    const findings = findMeasurabilityFindings('A malformed candidate file writes nothing at all.');

    expect(findings.map((finding) => finding.kind)).toContain('unpartnered-negative');
  });

  it('accepts the same claim once it carries its positive partner', () => {
    const findings = findMeasurabilityFindings(
      'A well-formed candidate file creates its cases, while a malformed one writes nothing at all and the command exits non-zero.',
    );

    expect(findings).toEqual([]);
  });

  it('accepts a negative paired with a concrete expected status', () => {
    const findings = findMeasurabilityFindings(
      'An anonymous caller never reaches a non-published case by any route and receives 404, not 403.',
    );

    expect(findings).toEqual([]);
  });

  it('accepts the epic-6 pairing that contrasts a rendered page with a hidden one', () => {
    const findings = findMeasurabilityFindings(
      'While a published case at /sprawy/:id renders its own title, a case in any of the five non-published states renders the not-found page in place, with no case title and no sign-in disclosure.',
    );

    expect(findings).toEqual([]);
  });
});

describe('findMeasurabilityFindings — self-contradiction', () => {
  it('refuses a criterion demanding both a 400 and a count for one parameter (E5-37)', () => {
    const findings = findMeasurabilityFindings(
      'The list endpoint returns a count under ?ordering=state and returns 400 for any ordering value outside the allowlist.',
    );

    expect(findings.map((finding) => finding.kind)).toContain('self-contradiction');
  });

  it('accepts a criterion that refuses one input and accepts a different one', () => {
    const findings = findMeasurabilityFindings(
      'An ordering value from the allowlist orders the page, and a value outside it returns 400.',
    );

    expect(findings.map((finding) => finding.kind)).not.toContain('self-contradiction');
  });
});

describe('findMeasurabilityFindings — shape of the advice', () => {
  it('reports at most one finding per kind, however many idioms a statement carries', () => {
    const findings = findMeasurabilityFindings(
      'The suite calls assertNumQueries twice and asserts with assertContains as well.',
    );

    expect(findings.filter((finding) => finding.kind === 'test-idiom')).toHaveLength(1);
  });

  it('always names what to write instead, because a refusal without a remedy is a wall', () => {
    const findings = findMeasurabilityFindings('A malformed file writes nothing at all.');

    expect(findings[0]?.remedy.length).toBeGreaterThan(20);
  });

  it('returns nothing for an empty statement rather than throwing', () => {
    expect(findMeasurabilityFindings('')).toEqual([]);
  });
});

describe('findUnmeasurableCriteria', () => {
  it('returns only the criteria carrying findings, in input order', () => {
    const flagged = findUnmeasurableCriteria([
      {
        id: 'E-01',
        statement:
          'A published case renders its title, while an unpublished one renders the not-found page and returns 404.',
      },
      { id: 'E-02', statement: 'Every list endpoint has an assertNumQueries ceiling.' },
      { id: 'E-03', statement: 'A malformed file writes nothing at all.' },
    ]);

    expect(flagged.map((criterion) => criterion.id)).toEqual(['E-02', 'E-03']);
  });

  it('returns an empty array for a contract with nothing to refuse', () => {
    expect(
      findUnmeasurableCriteria([
        { id: 'E-01', statement: 'The funnel endpoint returns six counters in one query.' },
      ]),
    ).toEqual([]);
  });
});
