import { describe, expect, it } from 'vitest';

import {
  collectLiteralClaims,
  findUnmetLiteralClaims,
  type PlanLike,
} from '../../../src/authoring/literal-claims.js';

/**
 * The incident these tests are about is real and is quoted in
 * `docs/findings/plan-author-invents-literals.md`: epic 5 of the tenstandard
 * project compiled "a pinned database-query ceiling that does not grow" into a
 * probe asserting that a test module contains `assertNumQueries` — an
 * identifier that occurs nowhere in that repository.
 *
 * A detector for that must be shown to work in BOTH directions, which is the
 * rule the same project's observations are held to: it has to name the
 * invented literal, and it has to stay quiet about the one that is really
 * there. A checker that could only ever say "clean" would measure nothing
 * while looking like a guarantee.
 */

function planWith(
  probe: NonNullable<PlanLike['criteria'][number]['probes']>[number],
): PlanLike {
  return { criteria: [{ criterionId: 'E5-41', probes: [probe] }] };
}

const fileProbe = {
  id: 'pinned-counts',
  surface: 'file',
  mechanics: { path: 'backend/tests/cases/test_editorial_api.py' },
  assertions: [
    {
      comparison: 'contains',
      expected: 'assertNumQueries',
      target: { source: 'content' },
    },
  ],
};

describe('collectLiteralClaims', () => {
  it('collects a file/content/contains claim, with the criterion it came from', () => {
    const claims = collectLiteralClaims(planWith(fileProbe));

    expect(claims).toEqual([
      {
        probeId: 'pinned-counts',
        criterionId: 'E5-41',
        path: 'backend/tests/cases/test_editorial_api.py',
        literal: 'assertNumQueries',
      },
    ]);
  });

  it('ignores surfaces whose truth is not decidable from the tree', () => {
    const claims = collectLiteralClaims(
      planWith({
        id: 'http-body',
        surface: 'http',
        mechanics: { path: '/api/public/cases/' },
        assertions: [
          { comparison: 'contains', expected: 'Sprawa', target: { source: 'body' } },
        ],
      }),
    );

    expect(claims).toEqual([]);
  });

  it('ignores comparisons that are not a substring claim', () => {
    const claims = collectLiteralClaims(
      planWith({
        ...fileProbe,
        assertions: [
          { comparison: 'equals', expected: 'whole file', target: { source: 'content' } },
        ],
      }),
    );

    expect(claims).toEqual([]);
  });

  it('ignores a glob read, whose members are a filesystem question', () => {
    const claims = collectLiteralClaims(
      planWith({
        ...fileProbe,
        mechanics: { path: 'backend/tests/**/*.py' },
        assertions: [
          {
            comparison: 'contains',
            expected: 'assertNumQueries',
            target: { source: 'filesContaining' },
          },
        ],
      }),
    );

    expect(claims).toEqual([]);
  });

  it('ignores literals too short or too numeric to mean anything', () => {
    const claims = collectLiteralClaims(
      planWith({
        ...fileProbe,
        assertions: [
          { comparison: 'contains', expected: '200', target: { source: 'content' } },
          { comparison: 'contains', expected: '{', target: { source: 'content' } },
        ],
      }),
    );

    expect(claims).toEqual([]);
  });
});

describe('findUnmetLiteralClaims', () => {
  const claims = collectLiteralClaims(planWith(fileProbe));

  it('names the invented literal — the epic-5 incident', () => {
    const unmet = findUnmetLiteralClaims(
      claims,
      () => 'def test_ceiling(django_assert_num_queries):\n    ...\n',
    );

    expect(unmet).toHaveLength(1);
    expect(unmet[0]?.literal).toBe('assertNumQueries');
    expect(unmet[0]?.fileExists).toBe(true);
  });

  it('stays quiet when the literal is really there', () => {
    const unmet = findUnmetLiteralClaims(
      claims,
      () => 'with self.assertNumQueries(3):\n    ...\n',
    );

    expect(unmet).toEqual([]);
  });

  it('separates a missing file from a file that says something else', () => {
    const unmet = findUnmetLiteralClaims(claims, () => undefined);

    expect(unmet[0]?.fileExists).toBe(false);
  });

  it('reads each path once however many claims are made about it', () => {
    const paths: string[] = [];
    const twoClaims = collectLiteralClaims({
      criteria: [
        {
          criterionId: 'E5-24',
          probes: [
            {
              ...fileProbe,
              assertions: [
                { comparison: 'contains', expected: 'select_related', target: { source: 'content' } },
                { comparison: 'contains', expected: 'assertNumQueries', target: { source: 'content' } },
              ],
            },
          ],
        },
      ],
    });

    findUnmetLiteralClaims(twoClaims, (path) => {
      paths.push(path);
      return 'select_related';
    });

    expect(paths).toHaveLength(1);
  });
});
