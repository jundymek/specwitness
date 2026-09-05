/**
 * Story 6.6 — the arithmetic that answers the product hypothesis.
 *
 * ============================================================================
 * ⚠️ EVERY EXPECTATION IN THIS FILE WAS COMPUTED BY HAND, ON PAPER, FROM RECORDS
 *    WRITTEN DELIBERATELY — NEVER BY RUNNING THE CODE UNDER TEST.
 * ============================================================================
 *
 * This is the same discipline the Golden Verification Corpus enforces one level up
 * (AD-12 / NFR-10), and it applies here for the same reason: **a metric verified by its
 * own implementation is verified by nothing.** The full derivation, including why each
 * fixture value was chosen, is in this story's PR body and Dev Agent Record.
 *
 * The property that makes this suite unusual: there is no downstream gate on this
 * story's correctness. A wrong verdict gets caught by a fixture; a wrong metric gets
 * BELIEVED. Epic 7 reads this summary to decide whether independent verification finds
 * real defects, and by then the number IS the evidence.
 *
 * So the fixture set below is built so that each plausible way of being wrong changes a
 * number visibly:
 *
 *  - unattributed findings counted as `unique`  → uniqueDefects becomes 2, not 1
 *  - re-attribution resolved FIRST-wins         → uniqueDefects becomes 2, fpRate 1/4
 *  - infra-errored runs excluded                → infraErrorRate becomes 0
 *  - mean substituted for median                → caught by the SKEWED even-count case,
 *    deliberately separate, because in the five-record set the mean and the median are
 *    both 5000 and a mix-up would slip through unnoticed. Found while checking the
 *    derivation by hand, which is the entire argument for doing it by hand.
 */

import { describe, expect, it } from 'vitest';

import {
  renderScorecardSummaryJson,
  renderScorecardSummaryTerminal,
  summarizeScorecard,
  type ScorecardSummaryInput,
} from '../../../src/report/scorecard-summary.js';
import {
  ATTRIBUTION_RECORD_VERSION,
  type AttributionRecord,
  type AttributionValue,
} from '../../../src/schemas/scorecard-attribution.js';
import {
  SCORECARD_RECORD_VERSION,
  type ScorecardRecord,
} from '../../../src/schemas/scorecard.js';

/* ── fixture builders ─────────────────────────────────────────────────────────────── */

interface RunSpec {
  readonly id: string;
  readonly outcome: ScorecardRecord['outcome'];
  readonly durationMs: number;
  readonly providerInvocations: number;
  readonly flaky?: number;
  readonly retried?: number;
  readonly fail?: readonly string[];
  readonly needsHuman?: readonly string[];
  readonly error?: readonly string[];
  readonly pass?: number;
  readonly truncated?: boolean;
}

function run(spec: RunSpec): ScorecardRecord {
  const fail = spec.fail ?? [];
  const needsHuman = spec.needsHuman ?? [];
  const error = spec.error ?? [];
  const pass = spec.pass ?? 0;

  return {
    schemaVersion: SCORECARD_RECORD_VERSION,
    runId: spec.id,
    epic: 'epic-6',
    startedAt: '2026-09-04T12:00:00.000Z',
    finishedAt: '2026-09-04T12:00:10.000Z',
    durationMs: spec.durationMs,
    outcome: spec.outcome,
    criteria: {
      total: pass + fail.length + needsHuman.length + error.length,
      pass,
      fail: fail.length,
      needs_human: needsHuman.length,
      skipped: 0,
      error: error.length,
    },
    gates: { total: 1, pass: 1, fail: 0, skipped: 0 },
    flakiness: {
      flakyCriteria: spec.flaky ?? 0,
      retriedCriteria: spec.retried ?? 0,
      extraAttempts: 0,
    },
    providerInvocations: spec.providerInvocations,
    providerRoles: spec.providerInvocations === 0 ? [] : ['plan-author'],
    stageDurationsMs: {},
    findingCriterionIds: { fail, needs_human: needsHuman, error },
    findingCriterionIdsTruncated: spec.truncated ?? false,
    adapted: false,
    environment: {
      specwitnessVersion: '0.1.0',
      nodeVersion: 'v22.13.0',
      platform: 'linux',
      arch: 'x64',
    },
  };
}

function attribution(
  runId: string,
  criterionId: string,
  value: AttributionValue,
  recordedAt = '2026-09-05T10:00:00.000Z',
): AttributionRecord {
  return {
    schemaVersion: ATTRIBUTION_RECORD_VERSION,
    runId,
    criterionId,
    attribution: value,
    recordedAt,
  };
}

function input(overrides: Partial<ScorecardSummaryInput> = {}): ScorecardSummaryInput {
  return {
    scorecard: { records: [], skipped: [] },
    attributions: { records: [], skipped: [] },
    ...overrides,
  };
}

/* ── the hand-computed fixture set ────────────────────────────────────────────────── */

/** Five runs. See the derivation table in the PR body. */
const RECORDS: readonly ScorecardRecord[] = [
  run({ id: 'run-20260904T120001Z-r001', outcome: { verdict: 'PASS' }, durationMs: 1000, providerInvocations: 0, pass: 3 }),
  run({ id: 'run-20260904T120002Z-r002', outcome: { verdict: 'FAIL' }, durationMs: 3000, providerInvocations: 0, pass: 2, flaky: 1, retried: 2, fail: ['E6-01', 'E6-02'] }),
  run({ id: 'run-20260904T120003Z-r003', outcome: { verdict: 'NEEDS_HUMAN' }, durationMs: 5000, providerInvocations: 1, pass: 1, retried: 1, needsHuman: ['E6-03'] }),
  run({ id: 'run-20260904T120004Z-r004', outcome: { infraError: 'provider' }, durationMs: 7000, providerInvocations: 2 }),
  run({ id: 'run-20260904T120005Z-r005', outcome: { verdict: 'FAIL' }, durationMs: 9000, providerInvocations: 0, pass: 3, flaky: 2, retried: 3, fail: ['E6-04'], error: ['E6-05'] }),
];

/**
 * Five attributions, IN FILE ORDER. The fourth supersedes the first.
 *
 * `E6-05` is deliberately left unjudged — it is the finding that proves an unattributed
 * finding never counts as `unique`.
 */
const ATTRIBUTIONS: readonly AttributionRecord[] = [
  attribution('run-20260904T120002Z-r002', 'E6-01', 'unique'),
  attribution('run-20260904T120002Z-r002', 'E6-02', 'false-positive'),
  attribution('run-20260904T120003Z-r003', 'E6-03', 'duplicate'),
  attribution('run-20260904T120002Z-r002', 'E6-01', 'false-positive', '2026-09-05T11:00:00.000Z'),
  attribution('run-20260904T120005Z-r005', 'E6-04', 'unique'),
];

const FULL = input({
  scorecard: { records: RECORDS, skipped: [] },
  attributions: { records: ATTRIBUTIONS, skipped: [] },
});

/* ── the metrics ──────────────────────────────────────────────────────────────────── */

describe('the north-star metric (SM-1) — hand-computed', () => {
  it('counts exactly the findings a human judged `unique`', () => {
    // BY HAND: winning map is E6-01 false-positive (superseded), E6-02 false-positive,
    // E6-03 duplicate, E6-04 unique, E6-05 unattributed. Exactly one `unique`.
    expect(summarizeScorecard(FULL).metrics.uniqueDefects.count).toBe(1);
  });

  it('shows BOTH denominators beside the count, never a bare number', () => {
    // At n=30 a bare "1 defect" is unreadable. "1 of 4 judged, of 5 found" is actionable.
    const { uniqueDefects } = summarizeScorecard(FULL).metrics;
    expect(uniqueDefects.ofAttributed).toBe(4);
    expect(uniqueDefects.ofAllFindings).toBe(5);
  });

  it('NEVER counts an unattributed finding as unique', () => {
    // ⚠️ THE MOST IMPORTANT ASSERTION IN THIS STORY. A summary that counted the two
    // unjudged findings here as `unique` would report 3 and would be the most flattering
    // possible lie about this product.
    const noJudgements = input({ scorecard: { records: RECORDS, skipped: [] } });
    const summary = summarizeScorecard(noJudgements);

    expect(summary.metrics.uniqueDefects.count).toBe(0);
    expect(summary.findings.attributed).toBe(0);
    expect(summary.findings.unattributed).toBe(5);
  });

  it('honours a re-attribution: the LAST record in file order wins', () => {
    // E6-01 was called `unique`, then corrected to `false-positive`. An append-only log
    // expresses a change of mind as a later record; the correction must win.
    const summary = summarizeScorecard(FULL);
    expect(summary.attributionCounts.unique).toBe(1);
    expect(summary.attributionCounts['false-positive']).toBe(2);
    expect(summary.attributionCounts.duplicate).toBe(1);
  });
});

describe('the six other AC2 metrics — hand-computed', () => {
  it('false-positive rate is 2 of 4 ATTRIBUTED findings', () => {
    expect(summarizeScorecard(FULL).metrics.falsePositiveRate).toEqual({
      numerator: 2,
      denominator: 4,
      value: 0.5,
    });
  });

  it('NEEDS_HUMAN rate is 1 of 5 records', () => {
    expect(summarizeScorecard(FULL).metrics.needsHumanRate).toEqual({
      numerator: 1,
      denominator: 5,
      value: 0.2,
    });
  });

  it('infra-error rate is 1 of 5 records — an infra-errored run IS recorded', () => {
    // Story 6.5 §2 records infra-errored runs deliberately: excluding them would make
    // this rate structurally zero, which looks exactly like good news.
    expect(summarizeScorecard(FULL).metrics.infraErrorRate).toEqual({
      numerator: 1,
      denominator: 5,
      value: 0.2,
    });
  });

  it('AI-free run share is 3 of 5 records (providerInvocations === 0)', () => {
    expect(summarizeScorecard(FULL).metrics.aiFreeRunShare).toEqual({
      numerator: 3,
      denominator: 5,
      value: 0.6,
    });
  });

  it('flaky rate is 3 flaky over 6 retried criteria (SM-C3 retry-to-green)', () => {
    expect(summarizeScorecard(FULL).metrics.flakyRate).toEqual({
      numerator: 3,
      denominator: 6,
      value: 0.5,
    });
  });

  it('median duration is the MIDDLE of five, not the mean', () => {
    expect(summarizeScorecard(FULL).metrics.duration).toEqual({ medianMs: 5000, count: 5 });
  });
});

describe('the median — the edge cases that make a summary throw at the worst moment', () => {
  it('is null over an empty set, never NaN and never 0', () => {
    // 0 would read as "these runs were instant". null reads as "there were no runs".
    expect(summarizeScorecard(input()).metrics.duration).toEqual({ medianMs: null, count: 0 });
  });

  it('is the single value over one record', () => {
    const one = input({
      scorecard: {
        records: [run({ id: 'run-20260904T120001Z-r001', outcome: { verdict: 'PASS' }, durationMs: 4200, providerInvocations: 0 })],
        skipped: [],
      },
    });
    expect(summarizeScorecard(one).metrics.duration).toEqual({ medianMs: 4200, count: 1 });
  });

  it('averages the two middle values over an even count — and is NOT the mean', () => {
    // ⚠️ Deliberately SKEWED so a mean/median mix-up is visible. BY HAND:
    // sorted 1000, 3000, 5000, 91000 → median (3000+5000)/2 = 4000; mean = 25000.
    // The AC says median because durations are skewed by infra retries, and a mean would
    // be dominated by them — this fixture is that sentence made executable.
    const even = input({
      scorecard: {
        records: [1000, 3000, 5000, 91_000].map((durationMs, index) =>
          run({
            id: `run-20260904T12000${index}Z-e00${index}`,
            outcome: { verdict: 'PASS' },
            durationMs,
            providerInvocations: 0,
          }),
        ),
        skipped: [],
      },
    });

    expect(summarizeScorecard(even).metrics.duration.medianMs).toBe(4000);
    expect(summarizeScorecard(even).metrics.duration.medianMs).not.toBe(25_000);
  });

  it('does not depend on the order records were read in', () => {
    const forwards = input({ scorecard: { records: RECORDS, skipped: [] } });
    const backwards = input({ scorecard: { records: [...RECORDS].reverse(), skipped: [] } });
    expect(summarizeScorecard(backwards).metrics.duration).toEqual(
      summarizeScorecard(forwards).metrics.duration,
    );
  });
});

describe('a rate with no denominator is null, never a percentage of nothing', () => {
  it('reports null rather than NaN or 0 across every rate', () => {
    // "false-positive rate: 100%" from one record is technically true and practically a
    // lie; "0%" from NO records is simply false. null is the only honest answer.
    const empty = summarizeScorecard(input());

    expect(empty.metrics.falsePositiveRate).toEqual({ numerator: 0, denominator: 0, value: null });
    expect(empty.metrics.needsHumanRate.value).toBeNull();
    expect(empty.metrics.infraErrorRate.value).toBeNull();
    expect(empty.metrics.aiFreeRunShare.value).toBeNull();
    expect(empty.metrics.flakyRate.value).toBeNull();
    expect(empty.metrics.uniqueDefects.count).toBe(0);
  });

  it('a run that retried nothing yields a null flaky rate, not a perfect score', () => {
    const noRetries = input({
      scorecard: {
        records: [run({ id: 'run-20260904T120001Z-r001', outcome: { verdict: 'PASS' }, durationMs: 10, providerInvocations: 0 })],
        skipped: [],
      },
    });
    expect(summarizeScorecard(noRetries).metrics.flakyRate.value).toBeNull();
  });
});

describe('skippedRecords — required by name in ADR-008 §5', () => {
  it('reports the count from BOTH logs, and breaks it down by source', () => {
    // "so a silently shrinking denominator is impossible" — ADR-008 §5.
    const withSkips = input({
      scorecard: {
        records: RECORDS,
        skipped: [
          { line: 3, reason: 'malformed', message: 'a' },
          { line: 8, reason: 'version-skew', message: 'b' },
        ],
      },
      attributions: {
        records: ATTRIBUTIONS,
        skipped: [{ line: 2, reason: 'malformed', message: 'c' }],
      },
    });

    const summary = summarizeScorecard(withSkips);
    expect(summary.skippedRecords.total).toBe(3);
    expect(summary.skippedRecords.scorecard).toBe(2);
    expect(summary.skippedRecords.attributions).toBe(1);
  });

  it('keeps the per-line detail so a skipped record can actually be found', () => {
    const withSkips = input({
      scorecard: { records: [], skipped: [{ line: 47, reason: 'version-skew', message: 'newer' }] },
    });
    const { detail } = summarizeScorecard(withSkips).skippedRecords;
    expect(detail).toHaveLength(1);
    expect(detail[0]).toMatchObject({ source: 'scorecard', line: 47, reason: 'version-skew' });
  });

  it('is zero — not absent — when nothing was skipped', () => {
    expect(summarizeScorecard(FULL).skippedRecords.total).toBe(0);
  });
});

describe('findings are counted from the EXACT counts, not from the capped id arrays', () => {
  it('reports a truncated run so a cut list is never read as a complete one', () => {
    // Story 6.5 caps `findingCriterionIds` at 200 across the record and sets a flag. The
    // per-status COUNTS stay exact, so the denominator comes from those — otherwise it
    // would silently shrink for exactly the runs with the most findings.
    const truncated = run({
      id: 'run-20260904T120009Z-r009',
      outcome: { verdict: 'FAIL' },
      durationMs: 1000,
      providerInvocations: 0,
      fail: ['E6-01'],
      truncated: true,
    });
    // Hand-forced: the record claims 3 failures but enumerates only 1.
    const withMore: ScorecardRecord = {
      ...truncated,
      criteria: { ...truncated.criteria, total: 3, fail: 3 },
    };

    const summary = summarizeScorecard(
      input({ scorecard: { records: [withMore], skipped: [] } }),
    );

    expect(summary.findings.total).toBe(3);
    expect(summary.findings.enumerated).toBe(1);
    expect(summary.findings.unattributed).toBe(3);
    expect(summary.findings.runsWithTruncatedFindingIds).toBe(1);
  });
});

describe('a truncated run grants NO amnesty — the round-2 P1', () => {
  it('orphans an attribution the truncated record does not name, and never counts it', () => {
    // ⚠️ THIS REVERSES AN EARLIER VERSION OF THIS STORY. Round 1 of the codex review
    // pointed out that `add` accepted such an attribution while the summary orphaned it;
    // I first resolved that by granting truncated runs an amnesty here. Round 2 showed
    // the amnesty let ANY syntactically valid id count, so `attributed` and
    // `uniqueDefects.count` could exceed `findings.total` — a north-star count larger
    // than the number of findings that exist.
    //
    // Resolved at the WRITE end instead: `scorecard add` refuses an unlisted criterion
    // even on a truncated record. Here, the id list is the whole membership test.
    const truncated = run({
      id: 'run-20260904T120009Z-r009',
      outcome: { verdict: 'FAIL' },
      durationMs: 1000,
      providerInvocations: 0,
      fail: ['E6-01'],
      truncated: true,
    });
    const withMore: ScorecardRecord = {
      ...truncated,
      criteria: { ...truncated.criteria, total: 300, fail: 300 },
    };

    const summary = summarizeScorecard(
      input({
        scorecard: { records: [withMore], skipped: [] },
        attributions: {
          records: [attribution('run-20260904T120009Z-r009', 'E6-250', 'unique')],
          skipped: [],
        },
      }),
    );

    expect(summary.metrics.uniqueDefects.count).toBe(0);
    expect(summary.findings.attributed).toBe(0);
    expect(summary.findings.orphanedAttributions).toBe(1);
    expect(summary.findings.runsWithTruncatedFindingIds).toBe(1);
  });

  it('holds the invariant attributed <= total, whatever the log contains', () => {
    // The property the amnesty broke, asserted directly: a log full of invented ids for a
    // truncated run must not inflate the north star past the findings that exist.
    const truncated = run({
      id: 'run-20260904T120009Z-r009',
      outcome: { verdict: 'FAIL' },
      durationMs: 1000,
      providerInvocations: 0,
      fail: ['E6-01'],
      truncated: true,
    });
    const withMore: ScorecardRecord = {
      ...truncated,
      criteria: { ...truncated.criteria, total: 2, fail: 2 },
    };

    const invented = Array.from({ length: 50 }, (_unused, index) =>
      attribution('run-20260904T120009Z-r009', `E6-${index + 100}`, 'unique'),
    );

    const summary = summarizeScorecard(
      input({
        scorecard: { records: [withMore], skipped: [] },
        attributions: { records: invented, skipped: [] },
      }),
    );

    expect(summary.findings.attributed).toBeLessThanOrEqual(summary.findings.total);
    expect(summary.metrics.uniqueDefects.count).toBeLessThanOrEqual(summary.findings.total);
    expect(summary.findings.orphanedAttributions).toBe(50);
  });

  it('still counts a judgement the truncated record DOES name', () => {
    // The permit half: truncation does not disqualify the ids that ARE listed.
    const truncated = run({
      id: 'run-20260904T120009Z-r009',
      outcome: { verdict: 'FAIL' },
      durationMs: 1000,
      providerInvocations: 0,
      fail: ['E6-01'],
      truncated: true,
    });

    const summary = summarizeScorecard(
      input({
        scorecard: { records: [truncated], skipped: [] },
        attributions: {
          records: [attribution('run-20260904T120009Z-r009', 'E6-01', 'unique')],
          skipped: [],
        },
      }),
    );

    expect(summary.metrics.uniqueDefects.count).toBe(1);
    expect(summary.findings.orphanedAttributions).toBe(0);
  });
});

describe('authoritative finding ids close the add/summary gap', () => {
  /**
   * A P1 from round 8 of the codex review, and the fourth round to visit this one point.
   * `scorecard add` learned to confirm an unlisted criterion against the run's stored
   * result; this summary had not, so the judgement it accepted was reported as an ORPHAN
   * and never counted. The same accept-then-discard contradiction as round 1, one layer
   * along.
   *
   * Fixed by reading the authoritative list ONCE at the CLI edge and handing it to both.
   * This module stays pure: it is told the facts rather than fetching them.
   */
  const truncated = (): ScorecardRecord => {
    const base = run({
      id: 'run-20260904T120009Z-r009',
      outcome: { verdict: 'FAIL' },
      durationMs: 1000,
      providerInvocations: 0,
      fail: ['E6-01'],
      truncated: true,
    });
    return { ...base, criteria: { ...base.criteria, total: 300, fail: 300 } };
  };

  it('counts an attribution the authoritative list confirms', () => {
    const summary = summarizeScorecard({
      scorecard: { records: [truncated()], skipped: [] },
      attributions: {
        records: [attribution('run-20260904T120009Z-r009', 'E6-250', 'unique')],
        skipped: [],
      },
      authoritativeFindingIds: new Map([
        ['run-20260904T120009Z-r009', new Set(['E6-01', 'E6-250'])],
      ]),
    });

    expect(summary.metrics.uniqueDefects.count).toBe(1);
    expect(summary.findings.attributed).toBe(1);
    expect(summary.findings.orphanedAttributions).toBe(0);
    // The enumerated count now reflects what the run really named, not the capped list.
    expect(summary.findings.enumerated).toBe(2);
  });

  it('still orphans an id the authoritative list does NOT contain', () => {
    // Widening must not become an amnesty.
    const summary = summarizeScorecard({
      scorecard: { records: [truncated()], skipped: [] },
      attributions: {
        records: [attribution('run-20260904T120009Z-r009', 'E6-777', 'unique')],
        skipped: [],
      },
      authoritativeFindingIds: new Map([
        ['run-20260904T120009Z-r009', new Set(['E6-01', 'E6-250'])],
      ]),
    });

    expect(summary.findings.orphanedAttributions).toBe(1);
    expect(summary.metrics.uniqueDefects.count).toBe(0);
  });

  it('falls back to the capped list when no authoritative list is supplied', () => {
    // Narrower, never wider: an unreadable stored result must not widen anything.
    const summary = summarizeScorecard({
      scorecard: { records: [truncated()], skipped: [] },
      attributions: {
        records: [attribution('run-20260904T120009Z-r009', 'E6-250', 'unique')],
        skipped: [],
      },
    });

    expect(summary.findings.orphanedAttributions).toBe(1);
    expect(summary.metrics.uniqueDefects.count).toBe(0);
  });

  it('never lets attributed exceed total, even with an authoritative list', () => {
    const summary = summarizeScorecard({
      scorecard: { records: [truncated()], skipped: [] },
      attributions: {
        records: Array.from({ length: 50 }, (_unused, index) =>
          attribution('run-20260904T120009Z-r009', `E6-${index + 100}`, 'unique'),
        ),
        skipped: [],
      },
      authoritativeFindingIds: new Map([
        ['run-20260904T120009Z-r009', new Set(['E6-01', 'E6-100'])],
      ]),
    });

    expect(summary.findings.attributed).toBeLessThanOrEqual(summary.findings.total);
    expect(summary.findings.attributed).toBe(1);
    expect(summary.findings.orphanedAttributions).toBe(49);
  });
});

describe('a stored result that cannot be read is REPORTED, not silently narrowed', () => {
  /**
   * A finding of the auto-review over this branch's final head, and the last shape of the
   * truncation problem. When an authoritative list is unavailable the summary falls back
   * to the capped one — and an attribution `scorecard add` legitimately accepted earlier,
   * while the result WAS readable, silently becomes an orphan. That undercounts the north
   * star with nothing on screen to say so: the silently-shrinking-denominator failure
   * ADR-008 section 5 exists to prevent, arriving by a different route.
   */
  const truncatedRun = (): ScorecardRecord => {
    const base = run({
      id: 'run-20260904T120009Z-r009',
      outcome: { verdict: 'FAIL' },
      durationMs: 1000,
      providerInvocations: 0,
      fail: ['E6-01'],
      truncated: true,
    });
    return { ...base, criteria: { ...base.criteria, total: 300, fail: 300 } };
  };

  it('counts a truncated run whose authoritative list is missing', () => {
    const summary = summarizeScorecard(
      input({ scorecard: { records: [truncatedRun()], skipped: [] } }),
    );

    expect(summary.findings.runsWithTruncatedFindingIds).toBe(1);
    expect(summary.findings.runsWithUnreadableStoredResult).toBe(1);
  });

  it('counts zero unrecoverable when the authoritative list WAS supplied', () => {
    const summary = summarizeScorecard({
      scorecard: { records: [truncatedRun()], skipped: [] },
      attributions: { records: [], skipped: [] },
      authoritativeFindingIds: new Map([
        ['run-20260904T120009Z-r009', new Set(['E6-01', 'E6-250'])],
      ]),
    });

    expect(summary.findings.runsWithTruncatedFindingIds).toBe(1);
    expect(summary.findings.runsWithUnreadableStoredResult).toBe(0);
  });

  it('does not claim findings are unattributable when the list WAS recovered', () => {
    // The warning became false the moment the recovery path worked — false guidance in
    // exactly the case where the feature had just succeeded.
    const text = renderScorecardSummaryTerminal(
      summarizeScorecard({
        scorecard: { records: [truncatedRun()], skipped: [] },
        attributions: { records: [], skipped: [] },
        authoritativeFindingIds: new Map([
          ['run-20260904T120009Z-r009', new Set(['E6-01', 'E6-250'])],
        ]),
      }),
    );

    expect(text).toMatch(/recovered from the run/i);
    expect(text).not.toMatch(/cannot be attributed by id/i);
  });

  it('DOES say so when the list could not be recovered', () => {
    const text = renderScorecardSummaryTerminal(
      summarizeScorecard(input({ scorecard: { records: [truncatedRun()], skipped: [] } })),
    );

    expect(text).toMatch(/cannot be attributed by id/i);
    expect(text).not.toMatch(/recovered from the run/i);
  });
});

describe('an attribution that joins to no finding is reported, never counted', () => {
  it('excludes an orphan from the metrics and surfaces it as its own number', () => {
    // An attribution whose run is missing from the scorecard (its line was skipped, or
    // the file was hand-edited) must not inflate a numerator against a denominator it is
    // not part of.
    const orphaned = input({
      scorecard: { records: RECORDS, skipped: [] },
      attributions: {
        records: [...ATTRIBUTIONS, attribution('run-20260904T129999Z-zzzz', 'E6-77', 'unique')],
        skipped: [],
      },
    });

    const summary = summarizeScorecard(orphaned);
    expect(summary.findings.orphanedAttributions).toBe(1);
    expect(summary.metrics.uniqueDefects.count).toBe(1);
    expect(summary.findings.attributed).toBe(4);
  });
});

/* ── AD-11: one model, two renderers, the same facts ──────────────────────────────── */

describe('--json and the terminal view carry the same facts (AD-11)', () => {
  it('emits a versioned, parseable JSON document and nothing else', () => {
    const text = renderScorecardSummaryJson(summarizeScorecard(FULL));
    const parsed: unknown = JSON.parse(text);
    expect((parsed as { schemaVersion: number }).schemaVersion).toBeGreaterThan(0);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('the JSON document IS the model — a renderer invents no fact', () => {
    const summary = summarizeScorecard(FULL);
    expect(JSON.parse(renderScorecardSummaryJson(summary))).toEqual(summary);
  });

  it('every headline number in the model appears in the terminal view too', () => {
    // A number in one view and not the other is a renderer inventing a fact, which is
    // exactly the drift AD-11 forbids.
    const summary = summarizeScorecard(FULL);
    const text = renderScorecardSummaryTerminal(summary);

    for (const needle of [
      '1', // unique defects
      '4', // attributed findings
      '5', // total findings / records read
      '5000', // median ms
    ]) {
      expect(text).toContain(needle);
    }

    // And the labelled facts, so the assertion above cannot pass on a coincidence.
    expect(text).toMatch(/unique/i);
    expect(text).toMatch(/false.positive/i);
    expect(text).toMatch(/needs.human/i);
    expect(text).toMatch(/infra/i);
    expect(text).toMatch(/median/i);
    expect(text).toMatch(/ai-free/i);
    expect(text).toMatch(/flak/i);
    expect(text).toMatch(/skipped/i);
    expect(text).toMatch(/unattributed/i);
  });

  it('renders EVERY numeric fact of the model, including zeroes', () => {
    // ⚠️ A P2 from round 3 of the codex review. `findings.enumerated` was in `--json` and
    // absent from the terminal, and two counters printed only when non-zero — so a reader
    // could not tell a complete finding list from a truncated one, nor "zero orphans"
    // from "orphans not reported".
    //
    // ⚠️ THE FIRST VERSION OF THIS TEST WAS VACUOUS, and it is worth saying how. It
    // matched each value against `/:\s+<value>/` anywhere in the output — but in this
    // fixture `findings.enumerated` and `findings.total` are BOTH 5, so deleting the
    // enumerated line still matched the total line and the test passed over the exact
    // defect it was written for. Planting the deletion is what exposed it.
    //
    // So each fact is now pinned to its own LABEL, and a fixture with deliberately
    // distinct values is used where the FULL set collides.
    const summary = summarizeScorecard(FULL);
    const text = renderScorecardSummaryTerminal(summary);

    const labelled: readonly (readonly [string, number])[] = [
      ['Records read', summary.records.read],
      ['Attributions read', summary.attributionsRead],
      ['Records skipped', summary.skippedRecords.total],
      ['Findings total', summary.findings.total],
      ['Findings named by id', summary.findings.enumerated],
      ['Findings attributed', summary.findings.attributed],
      ['Unattributed', summary.findings.unattributed],
      ['Runs with a cut list', summary.findings.runsWithTruncatedFindingIds],
      ['...list unrecoverable', summary.findings.runsWithUnreadableStoredResult],
      ['Orphaned attributions', summary.findings.orphanedAttributions],
      ['unique', summary.attributionCounts.unique],
      ['duplicate', summary.attributionCounts.duplicate],
      ['false-positive', summary.attributionCounts['false-positive']],
    ];

    for (const [label, value] of labelled) {
      expect(text, `"${label}" (${value}) is missing from the terminal view`).toMatch(
        new RegExp(`${label.replace(/[-[\]{}()*+?.,\\^$|#]/g, '\\$&')}:\\s+${value}(\\s|$)`, 'm'),
      );
    }

    // The north star carries both its denominators on one line.
    expect(text).toMatch(
      new RegExp(
        `Unique real defects:\\s+${summary.metrics.uniqueDefects.count} of ` +
          `${summary.metrics.uniqueDefects.ofAttributed} judged, of ` +
          `${summary.metrics.uniqueDefects.ofAllFindings} findings`,
      ),
    );
  });

  it('has a terminal label for every numeric fact the model carries', () => {
    // The other half of parity, and the half a value-matching test cannot give: if a
    // future field is ADDED to the model and forgotten in the renderer, the test above
    // still passes because it only checks the labels it already knows. This walks the
    // model's own numeric leaves and fails when one has no label here — which then forces
    // the renderer to grow a line for it.
    const summary = summarizeScorecard(FULL);

    const KNOWN_NUMERIC_FIELDS = new Set([
      'schemaVersion',
      'records.read',
      'attributionsRead',
      'skippedRecords.total',
      'skippedRecords.scorecard',
      'skippedRecords.attributions',
      'findings.total',
      'findings.enumerated',
      'findings.attributed',
      'findings.unattributed',
      'findings.runsWithTruncatedFindingIds',
      'findings.runsWithUnreadableStoredResult',
      'findings.orphanedAttributions',
      'attributionCounts.unique',
      'attributionCounts.duplicate',
      'attributionCounts.false-positive',
      'metrics.uniqueDefects.count',
      'metrics.uniqueDefects.ofAttributed',
      'metrics.uniqueDefects.ofAllFindings',
      'metrics.falsePositiveRate.numerator',
      'metrics.falsePositiveRate.denominator',
      'metrics.falsePositiveRate.value',
      'metrics.needsHumanRate.numerator',
      'metrics.needsHumanRate.denominator',
      'metrics.needsHumanRate.value',
      'metrics.infraErrorRate.numerator',
      'metrics.infraErrorRate.denominator',
      'metrics.infraErrorRate.value',
      'metrics.aiFreeRunShare.numerator',
      'metrics.aiFreeRunShare.denominator',
      'metrics.aiFreeRunShare.value',
      'metrics.flakyRate.numerator',
      'metrics.flakyRate.denominator',
      'metrics.flakyRate.value',
      'metrics.duration.medianMs',
      'metrics.duration.count',
    ]);

    const seen: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'number' || value === null) {
        seen.push(path);
        return;
      }
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        for (const [k, v] of Object.entries(value)) {
          walk(v, path === '' ? k : `${path}.${k}`);
        }
      }
    };
    walk(summary, '');

    const unaccounted = seen.filter((path) => !KNOWN_NUMERIC_FIELDS.has(path));
    expect(
      unaccounted,
      'a numeric field was added to the summary model without being accounted for in the ' +
        'terminal view — add it to the renderer and to the labelled list above',
    ).toEqual([]);
  });

  it('shows denominators in the terminal view, not bare percentages', () => {
    // SM-2: the author decides whether to keep the gate mandatory from this text. At n=1
    // a bare "100%" is technically true and practically a lie.
    const text = renderScorecardSummaryTerminal(summarizeScorecard(FULL));
    expect(text).toMatch(/2\s*(of|\/)\s*4/);
    expect(text).toMatch(/1\s*(of|\/)\s*5/);
  });

  it('renders an empty scorecard without throwing, and says so plainly', () => {
    // The moment a person is deciding whether to keep the gate is exactly when this must
    // not blow up.
    const text = renderScorecardSummaryTerminal(summarizeScorecard(input()));
    expect(text).toMatch(/no runs|0 runs|nothing recorded|no records/i);
    // ...and the full structure is still rendered beneath that note (AD-11 parity).
    expect(text).toMatch(/median/i);
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('undefined');
  });

  it('never prints NaN or undefined for any zero-denominator rate', () => {
    const text = renderScorecardSummaryTerminal(summarizeScorecard(input()));
    expect(text).not.toMatch(/NaN|undefined|Infinity/);
  });

  it('escapes control characters in a skip message — no terminal injection', () => {
    // ⚠️ A P2 from round 4 of the codex review, INTRODUCED BY MY OWN ROUND-3 FIX.
    // Printing the parser's full message (so ADR-008 §5's unknown field names reach the
    // operator) put untrusted text on the terminal for the first time: an unknown key's
    // NAME comes from the file, and a JSON key may legally contain an ESC or a newline.
    //
    // Reproduced against the built binary before the fix — a key named
    // `<ESC>[31mINJECTED<ESC>[0m\nFAKE LINE: pwned` coloured the output and FORGED A LINE
    // OF ITS OWN inside a metrics report. Redaction and byte-bounding do not remove
    // control characters; that is a separate treatment from a separate hazard.
    const esc = String.fromCharCode(27);
    const withInjection = input({
      scorecard: {
        records: [],
        skipped: [
          {
            line: 2,
            reason: 'version-skew',
            message: `Unknown field(s): ${esc}[31mINJECTED${esc}[0m\nFAKE LINE: pwned.`,
          },
        ],
      },
    });

    const text = renderScorecardSummaryTerminal(summarizeScorecard(withInjection));

    // No raw ESC, and no forged line: the newline is escaped, so "FAKE LINE" cannot start
    // one of its own.
    expect(text).not.toContain(esc);
    expect(text).not.toMatch(/^FAKE LINE/m);
    // The content is still legible, so an operator can see what was actually in the file.
    expect(text).toContain('INJECTED');
    expect(text).toContain('\\x1b');
  });

  it('warns in the terminal view when records were skipped', () => {
    const withSkips = input({
      scorecard: { records: RECORDS, skipped: [{ line: 3, reason: 'malformed', message: 'x' }] },
    });
    expect(renderScorecardSummaryTerminal(summarizeScorecard(withSkips))).toMatch(/skipped/i);
  });

  it('NAMES the unknown fields in the terminal view, as ADR-008 §5 requires', () => {
    // ⚠️ A P2 from round 2 of the codex review. ADR-008 §5 requires a skipped record to be
    // reported with "the line number and the unknown fields"; the terminal renderer
    // printed only the reason word, discarding the field names the parser had carefully
    // preserved — so an operator could not tell WHICH unsupported field dropped the
    // record. The `--json` view carried them all along, which made it an AD-11 gap too.
    const withSkips = input({
      scorecard: {
        records: RECORDS,
        skipped: [
          {
            line: 12,
            reason: 'version-skew',
            message: 'scorecard.jsonl line 12 was written by a newer SpecWitness — record skipped. Unknown field(s): telemetryId.',
          },
        ],
      },
    });

    const text = renderScorecardSummaryTerminal(summarizeScorecard(withSkips));
    expect(text).toContain('telemetryId');
    expect(text).toContain('line 12');
    expect(text).toMatch(/version-skew/);
  });

  it('renders every metric even when NO record is readable (AD-11 parity)', () => {
    // ⚠️ A P2 from round 2. An earlier version returned early on an empty scorecard and
    // printed a short note, so the terminal omitted all seven metrics, the orphan count
    // and the skip detail while `--json` still carried them. Both edge cases that reach it
    // — a fresh project, and a scorecard whose every line was skipped — are exactly when
    // somebody is deciding whether this gate is worth keeping.
    const allSkipped = input({
      scorecard: {
        records: [],
        skipped: [
          { line: 1, reason: 'malformed', message: 'a' },
          { line: 2, reason: 'malformed', message: 'b' },
        ],
      },
    });

    const text = renderScorecardSummaryTerminal(summarizeScorecard(allSkipped));

    for (const label of [
      /unique real defects/i,
      /false.positive rate/i,
      /needs.human rate/i,
      /infra-error rate/i,
      /ai-free run share/i,
      /flak/i,
      /median/i,
      /unattributed/i,
      /records skipped/i,
    ]) {
      expect(text).toMatch(label);
    }

    expect(text).not.toMatch(/NaN|undefined|Infinity/);
  });
});

describe('the summariser is pure', () => {
  it('does not mutate its input', () => {
    const records = [...RECORDS];
    const attributions = [...ATTRIBUTIONS];
    summarizeScorecard(
      input({
        scorecard: { records, skipped: [] },
        attributions: { records: attributions, skipped: [] },
      }),
    );
    expect(records).toEqual([...RECORDS]);
    expect(attributions).toEqual([...ATTRIBUTIONS]);
  });

  it('is deterministic', () => {
    expect(summarizeScorecard(FULL)).toEqual(summarizeScorecard(FULL));
  });
});
