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

describe('an attribution accepted for a TRUNCATED run actually reaches the metrics', () => {
  it('counts a judgement whose criterion the truncated record could not name', async () => {
    // ⚠️ THE P1 FROM THE CODEX REVIEW OF THIS BRANCH, as a test.
    //
    // `scorecard add` deliberately ACCEPTS an attribution for a criterion a truncated
    // record does not list — the id list is capped at 200 by story 6.5, so absence proves
    // nothing. Before the fix, this summary decided membership from the id list alone, so
    // that same attribution was classified as an ORPHAN and excluded from every metric:
    // the command said "Recorded", and the north-star count could never reach it.
    //
    // BY HAND: the record claims 300 failures and names one. E6-250 is not named, but the
    // record is truncated, so the judgement counts. uniqueDefects = 1, orphans = 0.
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

    expect(summary.metrics.uniqueDefects.count).toBe(1);
    expect(summary.findings.attributed).toBe(1);
    expect(summary.findings.orphanedAttributions).toBe(0);
    // 300 findings exist, one is judged, so 299 remain unjudged.
    expect(summary.findings.unattributed).toBe(299);
  });

  it('still orphans an attribution whose RUN is unknown, truncated or not', () => {
    // The fix must not become a blanket amnesty: a run that is not in the scorecard at all
    // has no truncation flag to appeal to.
    const summary = summarizeScorecard(
      input({
        scorecard: { records: RECORDS, skipped: [] },
        attributions: {
          records: [attribution('run-20260904T129999Z-zzzz', 'E6-77', 'unique')],
          skipped: [],
        },
      }),
    );

    expect(summary.findings.orphanedAttributions).toBe(1);
    expect(summary.metrics.uniqueDefects.count).toBe(0);
  });

  it('still orphans an unnamed criterion when the run was NOT truncated', () => {
    // The other half of the boundary: an untruncated record's id list IS the set, so an
    // id outside it is a genuine mismatch and must not be counted.
    const summary = summarizeScorecard(
      input({
        scorecard: { records: RECORDS, skipped: [] },
        attributions: {
          records: [attribution('run-20260904T120002Z-r002', 'E6-88', 'unique')],
          skipped: [],
        },
      }),
    );

    expect(summary.findings.orphanedAttributions).toBe(1);
    expect(summary.metrics.uniqueDefects.count).toBe(0);
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
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('undefined');
  });

  it('never prints NaN or undefined for any zero-denominator rate', () => {
    const text = renderScorecardSummaryTerminal(summarizeScorecard(input()));
    expect(text).not.toMatch(/NaN|undefined|Infinity/);
  });

  it('warns in the terminal view when records were skipped', () => {
    const withSkips = input({
      scorecard: { records: RECORDS, skipped: [{ line: 3, reason: 'malformed', message: 'x' }] },
    });
    expect(renderScorecardSummaryTerminal(summarizeScorecard(withSkips))).toMatch(/skipped/i);
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
