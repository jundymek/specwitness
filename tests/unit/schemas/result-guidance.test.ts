/**
 * Story 5.3, AC1 — the reviewer guidance survives PERSISTENCE, both ways.
 *
 * `CriterionResultSchema` is `.strict()`, so a field the domain carries but the schema
 * does not declare makes exactly the runs that used the feature unreadable from storage —
 * the same shape as the story 3.3 follow-up, where a run that recorded a stage `hint`
 * serialized fine and then refused to parse back.
 *
 * The other half is the one that is easy to skip and is the real regression risk: **a
 * `result.json` written BEFORE this change must still parse.** That is the whole point of
 * additive evolution (AD-5), and it is why `SCHEMA_VERSIONS.jsonReport` is not bumped —
 * see DECISIONS.md D1, and the repo's own precedent in commit `ec23ce1`, which added the
 * optional `hint` key to a strict sub-schema of this same document without a bump.
 */

import { describe, expect, it } from 'vitest';

import { boundedText } from '../../../src/domain/evidence.js';
import {
  RUN_RESULT_VERSION,
  parseRunResult,
  serializeRunResult,
} from '../../../src/schemas/result.js';
import { renderJson } from '../../../src/report/json.js';
import { CONTRACT, criterion, runResult } from '../report/helpers.js';

const GUIDANCE = 'open the checkout page and read the three error states aloud';

/** Only ever used in an error message here; no file is read. */
const RESULT_PATH = '.specwitness/runs/run-2026-08-31T14-25-30Z-a1b2c3/result.json';

/**
 * `IsoUtcTimestamp` requires milliseconds (`schemas/manifest.ts:34`), and the shared
 * report helper's constants omit them — harmless there, because those tests only ever
 * SERIALIZE. Every test in this file parses the document back, so it supplies its own.
 */
const INSTANTS = {
  startedAt: '2026-08-31T14:25:30.000Z',
  finishedAt: '2026-08-31T14:26:00.000Z',
  contract: { ...CONTRACT, frozenAt: '2026-08-31T14:00:00.000Z' },
} as const;

function needsHumanRun(): ReturnType<typeof runResult> {
  return runResult({
    ...INSTANTS,
    outcome: { verdict: 'NEEDS_HUMAN' },
    criteria: [
      criterion('E5-09', 'needs_human', {
        needsHumanReason: 'human-verifiability',
        reviewerGuidance: boundedText(GUIDANCE),
      }),
    ],
  });
}

describe('AC1 — the guidance round-trips through the persisted document', () => {
  it('survives serialize then parse, with both fields intact', () => {
    const parsed = parseRunResult(serializeRunResult(needsHumanRun()), RESULT_PATH);

    expect(parsed.criteria[0]?.needsHumanReason).toBe('human-verifiability');
    expect(parsed.criteria[0]?.reviewerGuidance?.text).toBe(GUIDANCE);
  });

  it('carries the truncation bookkeeping through storage as well', () => {
    // Not decoration: `truncated` and `totalBytes` are what let the report tell a reader
    // that guidance was withheld. A round-trip that dropped them would render a truncated
    // sentence as if it were the whole of it.
    const long = 'g'.repeat(9000);
    const run = runResult({
      ...INSTANTS,
      outcome: { verdict: 'NEEDS_HUMAN' },
      criteria: [
        criterion('E5-09', 'needs_human', {
          needsHumanReason: 'not-safely-automatable',
          reviewerGuidance: boundedText(long),
        }),
      ],
    });

    const parsed = parseRunResult(serializeRunResult(run), RESULT_PATH);

    expect(parsed.criteria[0]?.reviewerGuidance?.truncated).toBe(true);
    expect(parsed.criteria[0]?.reviewerGuidance?.totalBytes).toBe(9000);
  });

  it('accepts both recorded reasons and refuses anything else', () => {
    // The enum is closed for the same reason `NEEDS_HUMAN_REASONS` is: Q39 fixes exactly
    // two triggers, and a third value arriving through storage would be a third trigger
    // entering by the back door.
    for (const reason of ['human-verifiability', 'not-safely-automatable'] as const) {
      const run = runResult({
        ...INSTANTS,
        criteria: [criterion('E5-09', 'needs_human', { needsHumanReason: reason })],
      });
      expect(parseRunResult(serializeRunResult(run), RESULT_PATH).criteria[0]?.needsHumanReason).toBe(
        reason,
      );
    }

    const document = JSON.parse(serializeRunResult(needsHumanRun())) as {
      criteria: { needsHumanReason: string }[];
    };
    document.criteria[0]!.needsHumanReason = 'someone-was-unsure';

    expect(() => parseRunResult(JSON.stringify(document), RESULT_PATH)).toThrow();
  });
});

describe('AD-5 — additive evolution: a run stored before this change still parses', () => {
  it('parses a document whose criteria carry neither field', () => {
    // THE regression this story could plausibly cause. `parseRunResult` is strict, so the
    // failure mode of getting this wrong is not a warning — it is last week's run
    // becoming unreadable.
    const before = {
      schemaVersion: RUN_RESULT_VERSION,
      runId: 'run-2026-08-31T14-25-30Z-a1b2c3',
      epic: 'epic-3',
      baseSha: '1111111111111111111111111111111111111111',
      headSha: '2222222222222222222222222222222222222222',
      startedAt: INSTANTS.startedAt,
      finishedAt: INSTANTS.finishedAt,
      outcome: { verdict: 'NEEDS_HUMAN' },
      stages: [],
      gates: [],
      criteria: [
        {
          criterionId: 'E5-09',
          status: 'needs_human',
          statement: 'the error copy reads as a human wrote it',
          severity: 'normal',
        },
      ],
      evidence: [],
      providerUsage: [],
      environment: {
        nodeVersion: 'v22.20.0',
        platform: 'darwin',
        arch: 'arm64',
        specwitnessVersion: '0.1.0',
        worktreePath: null,
        runDirectory: '.specwitness/runs/run-2026-08-31T14-25-30Z-a1b2c3',
      },
    };

    const parsed = parseRunResult(JSON.stringify(before), RESULT_PATH);

    expect(parsed.criteria[0]?.status).toBe('needs_human');
    expect(parsed.criteria[0]?.reviewerGuidance).toBeUndefined();
    expect(parsed.criteria[0]?.needsHumanReason).toBeUndefined();
  });

  it('does not bump the document version to read the new fields', () => {
    // DECISIONS.md D1. Stated as an assertion so that a later bump is a deliberate edit
    // to a test that explains itself, rather than a silent renumbering.
    const document = JSON.parse(serializeRunResult(needsHumanRun())) as { schemaVersion: number };

    expect(document.schemaVersion).toBe(1);
  });
});

describe('AD-11 — the JSON renderer carries the guidance without transforming it', () => {
  it('produces exactly the bytes the serializer produces', () => {
    // `src/report/json.ts` is one line, deliberately: `--json` stdout and the persisted
    // `result.json` must be the same bytes (Q53/Q55), and that is reachable only while
    // exactly one function turns a `RunResult` into bytes. A transformation added there for
    // the new fields — a reshape, a re-indent, a "tidier" guidance string — would make a
    // second byte sequence that drifts from the stored file the first time either changed.
    const run = needsHumanRun();

    expect(renderJson(run)).toBe(serializeRunResult(run));
  });

  it('puts the guidance in the machine view, not only the human one', () => {
    // AC1 requires the guidance in the report AND the JSON. A harness triaging runs reads
    // this document, and a needs_human criterion it cannot explain is one a human gets
    // handed with no context.
    const document = JSON.parse(renderJson(needsHumanRun())) as {
      criteria: { reviewerGuidance?: { text: string }; needsHumanReason?: string }[];
    };

    expect(document.criteria[0]?.reviewerGuidance?.text).toBe(GUIDANCE);
    expect(document.criteria[0]?.needsHumanReason).toBe('human-verifiability');
  });
});
