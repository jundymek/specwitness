/**
 * Story 6.5 — the record shape, and the projection that produces it.
 *
 * This suite is where story 6.6's contract is pinned. 6.6 launches in wave 3, reads these
 * records, and cannot ask what any field meant — so every metric it is expected to compute
 * has a test here asserting the field it computes from means what the schema says it does.
 *
 * The failure this guards against is not a crash. It is a north-star metric that is
 * confidently wrong: a `skipped` folded into `pass`, an infra-error rate of zero because
 * the wrong runs recorded, a provider count that misses the call that was actually made.
 * None of those throw, and none of them are visible until the measurement they destroyed
 * is the only evidence left.
 */

import { describe, expect, it } from 'vitest';

import type { DerivedCriterionResult } from '../../../src/domain/criterion-result.js';
import type { RunResult } from '../../../src/domain/run-result.js';
import type { CriterionStatus, GateStatus } from '../../../src/domain/result.js';
import { STAGE_NAMES } from '../../../src/domain/stage.js';
import {
  parseScorecardLine,
  ScorecardRecordSchema,
  type ScorecardRecord,
  SCORECARD_FILENAME,
  SCORECARD_RECORD_VERSION,
  serializeScorecardRecord,
  toScorecardRecord,
} from '../../../src/schemas/scorecard.js';
import { SCHEMA_VERSIONS } from '../../../src/schemas/versions.js';
import { criterion, gate, runResult, stages } from '../report/helpers.js';

/**
 * A run whose instants carry milliseconds.
 *
 * `IsoUtcTimestamp` — the same validator `result.json` uses for these two fields — requires
 * `.SSS`, and every real run satisfies it because both instants come from
 * `clock.now().toISOString()` (AD-9). The shared report helper predates that constraint and
 * writes second-precision literals, which is fine for a renderer test and not for a schema
 * one. Overriding here rather than changing the shared helper: four other suites depend on
 * its exact strings.
 */
function run(overrides: Partial<RunResult> = {}): RunResult {
  return runResult({
    startedAt: '2026-08-31T14:25:01.000Z',
    finishedAt: '2026-08-31T14:26:11.000Z',
    ...overrides,
  });
}

/**
 * COMPILE-TIME, not runtime — this is the pin `src/schemas/scorecard.ts` refers to.
 *
 * The count blocks are written out longhand there so the record's interface and its zod
 * schema cannot drift apart. That leaves one hazard: a status ADDED to the closed
 * taxonomy in `src/domain/result.ts` and not added here, which would silently stop being
 * counted — and a criterion nobody counts is a metric that is quietly wrong rather than
 * visibly broken, which is this story's whole failure mode.
 *
 * `Exact` compares in BOTH directions, so a removed status fails too. If this line stops
 * compiling, the taxonomy changed and this record has to change with it.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const criterionCountsCoverTheTaxonomy: Exact<
  Exclude<keyof ScorecardRecord['criteria'], 'total'>,
  CriterionStatus
> = true;

const gateCountsCoverTheTaxonomy: Exact<
  Exclude<keyof ScorecardRecord['gates'], 'total'>,
  GateStatus
> = true;

describe('registration (AD-5)', () => {
  it('counts every status the closed taxonomy declares, and no invented one', () => {
    // The assertion is the two type aliases above; this case exists so a reader of the
    // suite sees the guarantee named, and so the constants are not dead code.
    expect(criterionCountsCoverTheTaxonomy && gateCountsCoverTheTaxonomy).toBe(true);
  });

  it('is a registered artifact, so the version has one home', () => {
    expect(SCHEMA_VERSIONS.scorecard).toBe(1);
    expect(SCORECARD_RECORD_VERSION).toBe(SCHEMA_VERSIONS.scorecard);
  });

  it('did not move any other artifact version', () => {
    // The scorecard is a PROJECTION of the same `RunResult` that becomes `result.json`
    // (AD-11). It adds no field to that document, so `jsonReport` must not move — and a
    // story that bumped it would make every stored run report a skew it does not have.
    expect(SCHEMA_VERSIONS.jsonReport).toBe(1);
    expect(SCHEMA_VERSIONS.runManifest).toBe(1);
    expect(SCHEMA_VERSIONS.contract).toBe(1);
    expect(SCHEMA_VERSIONS.plan).toBe(1);
  });

  it('lives beside runs/, contracts/ and plans/ — project-local, one file', () => {
    expect(SCORECARD_FILENAME).toBe('scorecard.jsonl');
  });
});

describe('the outcome is READ, never re-decided (AD-6, AD-11)', () => {
  it('carries a verdict verbatim, with the failing gate id when a gate ended the run', () => {
    const record = toScorecardRecord(
      run({ outcome: { verdict: 'FAIL', gateFailed: 'build' } }),
    );

    expect(record.outcome).toEqual({ verdict: 'FAIL', gateFailed: 'build' });
  });

  it('carries an infra classification verbatim, never a verdict beside it (AD-6)', () => {
    const record = toScorecardRecord(run({ outcome: { infraError: 'integrity' } }));

    expect(record.outcome).toEqual({ infraError: 'integrity' });
    expect(record.outcome).not.toHaveProperty('verdict');
  });

  it('records NEEDS_HUMAN as its own outcome, not as a fail and not as a pass', () => {
    const record = toScorecardRecord(run({ outcome: { verdict: 'NEEDS_HUMAN' } }));

    expect(record.outcome).toEqual({ verdict: 'NEEDS_HUMAN' });
  });

  it('carries NO exit code — the scorecard adds none and changes none (ADR-002)', () => {
    const record = toScorecardRecord(run());

    // Structural, not stylistic: `src/schemas/**` may not import `src/cli/**`, so this
    // field cannot exist here even if somebody wanted it. 6.6 derives the code from
    // `outcome` through `src/cli/exit.ts`, the only module that knows what a code means.
    expect(record).not.toHaveProperty('exitCode');
  });
});

describe('per-status criterion counts — the denominators 6.6 divides by', () => {
  const mixed: readonly DerivedCriterionResult[] = [
    criterion('c-1', 'pass'),
    criterion('c-2', 'pass'),
    criterion('c-3', 'fail'),
    criterion('c-4', 'needs_human'),
    criterion('c-5', 'skipped'),
    criterion('c-6', 'error'),
  ];

  it('counts every status, with total equal to the array it counted', () => {
    const record = toScorecardRecord(run({ criteria: mixed }));

    expect(record.criteria).toEqual({
      total: 6,
      pass: 2,
      fail: 1,
      needs_human: 1,
      skipped: 1,
      error: 1,
    });
  });

  it('records `skipped` FAITHFULLY and never folds it into pass (action item e4-D)', () => {
    // e4-D is open and is NOT this story's to answer. A run whose criteria were all
    // skipped currently aggregates to PASS; recording that honestly is what lets 6.6
    // report the hazard. Folding `skipped` into `pass` here would hide it forever, in the
    // one file that outlives the runs.
    const record = toScorecardRecord(run({ criteria: [criterion('c-1', 'skipped')] }));

    expect(record.criteria.skipped).toBe(1);
    expect(record.criteria.pass).toBe(0);
    expect(record.criteria.total).toBe(1);
  });

  it('reports zero criteria for a gates-only run rather than omitting the block', () => {
    // A legitimate Epic 3 configuration, not a broken run. Every key present and zero
    // means 6.6 never writes `?? 0`, and never prints nothing where it meant to print 0.
    const record = toScorecardRecord(run({ criteria: [] }));

    expect(record.criteria).toEqual({
      total: 0,
      pass: 0,
      fail: 0,
      needs_human: 0,
      skipped: 0,
      error: 0,
    });
  });

  it('counts gates by status too, including the skips an early stop produces', () => {
    const record = toScorecardRecord(
      run({ gates: [gate('lint', 'pass'), gate('build', 'fail'), gate('test', 'skipped')] }),
    );

    expect(record.gates).toEqual({ total: 3, pass: 1, fail: 1, skipped: 1 });
  });
});

describe('the FR-34 hook — linkable to a future attribution, without implementing one', () => {
  it('enumerates exactly the criterion ids a FINDING could be about', () => {
    const record = toScorecardRecord(
      run({
        criteria: [
          criterion('c-pass', 'pass'),
          criterion('c-fail', 'fail'),
          criterion('c-human', 'needs_human'),
          criterion('c-error', 'error'),
          criterion('c-skipped', 'skipped'),
        ],
      }),
    );

    // `(runId, criterionId)` is the key an attribution hangs on. Passing and skipped
    // criteria produced no finding, so they are absent — which is also what keeps the
    // line small enough for the append to stay atomic.
    expect(record.findingCriterionIds).toEqual({
      fail: ['c-fail'],
      needs_human: ['c-human'],
      error: ['c-error'],
    });
    expect(record.findingCriterionIdsTruncated).toBe(false);
  });

  it('flags a truncated list rather than reporting a partial one as complete', () => {
    const many = Array.from({ length: 250 }, (_unused, index) => criterion(`c-${index}`, 'fail'));

    const record = toScorecardRecord(run({ criteria: many }));

    expect(record.findingCriterionIds.fail).toHaveLength(200);
    expect(record.findingCriterionIdsTruncated).toBe(true);
    // The COUNT stays honest even when the list is cut. 6.6 divides by this, not by the
    // array length — a truncated list must never shrink a denominator.
    expect(record.criteria.fail).toBe(250);
  });

  it('does not carry an attribution of its own — that is FR-34 and story 6.6s', () => {
    const record = toScorecardRecord(run());

    expect(record).not.toHaveProperty('attribution');
    expect(record).not.toHaveProperty('defectClass');
  });
});

describe('provider invocations — the number that proves the AI-free-run share (FR-18)', () => {
  it('is zero for a run that executed a committed plan', () => {
    const record = toScorecardRecord(run({ providerUsage: [] }));

    expect(record.providerInvocations).toBe(0);
    expect(record.providerRoles).toEqual([]);
  });

  it('counts every invocation and names the distinct roles, sorted', () => {
    const record = toScorecardRecord(
      run({
        providerUsage: [
          { role: 'plan-author', provider: 'claude-code', durationMs: 900, attempts: 1, model: null, providerCliVersion: null },
          { role: 'explainer', provider: 'claude-code', durationMs: 400, attempts: 2, model: null, providerCliVersion: null },
          { role: 'explainer', provider: 'claude-code', durationMs: 300, attempts: 1, model: null, providerCliVersion: null },
        ],
      }),
    );

    // The COUNT is invocations, not roles: a role invoked twice cost twice.
    expect(record.providerInvocations).toBe(3);
    // The ROLES are distinct and sorted, so two runs that spent on the same roles group
    // together whatever order the calls happened in.
    expect(record.providerRoles).toEqual(['explainer', 'plan-author']);
  });
});

describe('flakiness — story 5.4s three numbers, carried not recomputed (SM-C3)', () => {
  it('carries the numerator and the denominator of retry-to-green', () => {
    const record = toScorecardRecord(
      run({
        criteria: [
          criterion('c-1', 'pass', {
            flaky: true,
            attempts: [
              { attempt: 1, probeId: 'p-1', outcome: 'fail', durationMs: 10 },
              { attempt: 2, probeId: 'p-1', outcome: 'pass', durationMs: 10 },
            ],
          }),
          criterion('c-2', 'pass'),
        ],
      }),
    );

    expect(record.flakiness).toEqual({
      flakyCriteria: 1,
      retriedCriteria: 1,
      extraAttempts: 1,
    });
    // A flaky pass is a pass AND a flake (FR-32). Folding it out of the pass count would
    // be the silent conversion FR-32 exists to prevent, in the other direction.
    expect(record.criteria.pass).toBe(2);
  });
});

describe('durations', () => {
  it('records the wall clock as whole milliseconds derived from the runs own instants', () => {
    const record = toScorecardRecord(
      run({ startedAt: '2026-08-31T14:25:01.000Z', finishedAt: '2026-08-31T14:26:11.000Z' }),
    );

    expect(record.durationMs).toBe(70_000);
  });

  it('never records a negative duration, whatever the document claims', () => {
    // Timestamps come from the run's injected clock (AD-9), so this cannot arise from a
    // real run — but a hand-edited or fixture-authored result must not be able to put a
    // negative number into a metric 6.6 averages.
    const record = toScorecardRecord(
      run({ startedAt: '2026-08-31T14:26:11.000Z', finishedAt: '2026-08-31T14:25:01.000Z' }),
    );

    expect(record.durationMs).toBe(0);
  });

  it('records one duration per stage, keyed by the eleven closed stage names', () => {
    const record = toScorecardRecord(run({ stages: stages() }));

    expect(Object.keys(record.stageDurationsMs).sort()).toEqual([...STAGE_NAMES].sort());
    // A skipped stage contributes 0 and is PRESENT: an absent key and a zero mean
    // different things, and 6.6 sums these to say where verification time goes.
    expect(record.stageDurationsMs.resolve).toBe(0);
    expect(record.stageDurationsMs.teardown).toBeGreaterThan(0);
  });
});

describe('the contract link', () => {
  it('carries the fingerprint, so 6.6 can tell two runs of the same spec apart from two specs', () => {
    const record = toScorecardRecord(run());

    expect(record.contract?.fingerprint).toHaveLength(64);
    expect(record.contract?.version).toBe(2);
    expect(record.contract?.amendments).toBe(1);
    expect(record.contract?.criterionCount).toBe(3);
  });

  it('OMITS the contract entirely when the run never verified one', () => {
    // Its presence IS fingerprint validity (see `ContractSummary`). Absent means the run
    // ended before or at integrity — so a reader never has to ask whether the fingerprint
    // was valid, and `null` would blur the two answers into one.
    const withoutContract: RunResult = { ...run(), contract: undefined };

    const record = toScorecardRecord(withoutContract);

    expect(record).not.toHaveProperty('contract');
  });
});

describe('nothing untrusted or unredacted enters the file (AD-10)', () => {
  it('carries no criterion STATEMENT, no evidence, no stage detail and no hint', () => {
    const record = toScorecardRecord(
      run({
        criteria: [criterion('c-1', 'fail')],
        stages: stages('gates', {
          stage: 'gates',
          status: 'failed',
          detail: 'the build printed a token',
          hint: 'rotate it',
        }),
      }),
    );
    const line = serializeScorecardRecord(record);

    // Counts and enums, not prose. A criterion's statement is contract text, a stage
    // detail can quote command output, and a hint can quote a path — none of the three
    // has any business in the file most likely to be pasted into an issue.
    expect(line).not.toContain('behaviour holds');
    expect(line).not.toContain('printed a token');
    expect(line).not.toContain('rotate it');
  });

  it('does not carry the base or head SHA, the worktree path, or the run directory', () => {
    const line = serializeScorecardRecord(toScorecardRecord(run()));

    expect(line).not.toContain('1111111111111111');
    expect(line).not.toContain('specwitness-worktree');
    expect(line).not.toContain('.specwitness/runs/');
  });

  it('redacts a secret that reached a string field, and the secret is ABSENT from the line', () => {
    const record = toScorecardRecord(
      run({ outcome: { verdict: 'FAIL', gateFailed: 'deploy AWS_SECRET_ACCESS_KEY=DEADBEEFCAFEBABE' } }),
    );
    const line = serializeScorecardRecord(record);

    // Asserting ABSENCE, never that a marker is present (Epic 3 retro §7): output
    // carrying `[REDACTED]` with the secret still beside it survives review in a way a
    // raw leak does not.
    expect(line).not.toContain('DEADBEEFCAFEBABE');
  });

  it('bounds every string, so no field can grow the line without limit', () => {
    const enormous = 'x'.repeat(50_000);
    const record = toScorecardRecord(
      run({
        epic: enormous,
        criteria: [criterion(enormous, 'fail')],
        providerUsage: [
          { role: enormous, provider: 'claude-code', durationMs: 1, attempts: 1, model: null, providerCliVersion: null },
        ],
      }),
    );

    // The bound is what makes the single-`write(2)` append safe (see
    // `src/infra/scorecard-store.ts`), so it is asserted on the SERIALIZED line rather
    // than field by field.
    expect(serializeScorecardRecord(record).length).toBeLessThan(4096);
  });
});

describe('the line is one independently-parseable record (ADR-008 §5)', () => {
  it('serializes to exactly one newline-terminated line', () => {
    const line = serializeScorecardRecord(toScorecardRecord(run()));

    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd()).not.toContain('\n');
  });

  it('round-trips through its own schema', () => {
    const record = toScorecardRecord(run({ criteria: [criterion('c-1', 'fail')] }));

    const parsed = ScorecardRecordSchema.safeParse(
      JSON.parse(serializeScorecardRecord(record)) as unknown,
    );

    expect(parsed.success).toBe(true);
  });

  it('carries its own schemaVersion on the line, not on a document envelope', () => {
    const parsed = JSON.parse(serializeScorecardRecord(toScorecardRecord(run()))) as {
      schemaVersion: number;
    };

    expect(parsed.schemaVersion).toBe(SCORECARD_RECORD_VERSION);
  });

  it('diagnoses a line from a NEWER build as a version skew, naming the fields', () => {
    const future = {
      ...JSON.parse(serializeScorecardRecord(toScorecardRecord(run()))),
      attributionVerdict: 'unique',
    };

    const parsed = parseScorecardLine(JSON.stringify(future), 7, '/tmp/scorecard.jsonl');

    expect(parsed.ok).toBe(false);
    expect(parsed).toMatchObject({ reason: 'version-skew' });
    if (!parsed.ok) {
      expect(parsed.message).toContain('line 7');
      expect(parsed.message).toContain('attributionVerdict');
      // ADR-008 §1's own wording, so an operator meeting this and story 6.3's exit-3
      // refusal recognises them as one decision taken deliberately.
      expect(parsed.message).toContain('newer SpecWitness');
    }
  });

  it('diagnoses a WRONG TYPE as malformed, and never as a skew', () => {
    const broken = {
      ...JSON.parse(serializeScorecardRecord(toScorecardRecord(run()))),
      providerInvocations: 'several',
    };

    const parsed = parseScorecardLine(JSON.stringify(broken), 7, '/tmp/scorecard.jsonl');

    expect(parsed).toMatchObject({ ok: false, reason: 'malformed' });
    if (!parsed.ok) {
      // The half that has teeth. If this said "newer SpecWitness", real corruption would
      // hide behind a friendly upgrade hint (ADR-008 "Consequences", last bullet).
      expect(parsed.message).not.toContain('newer SpecWitness');
      expect(parsed.message).toContain('providerInvocations');
    }
  });

  it('names paths and codes in a malformed diagnosis, never the offending VALUE', () => {
    const broken = {
      ...JSON.parse(serializeScorecardRecord(toScorecardRecord(run()))),
      providerInvocations: 'GITHUB_TOKEN=DEADBEEFCAFEBABE',
    };

    const parsed = parseScorecardLine(JSON.stringify(broken), 1, '/tmp/scorecard.jsonl');

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      // Some zod messages echo the value they rejected, and the line came out of an
      // untrusted file. Absence, again, rather than a marker.
      expect(parsed.message).not.toContain('DEADBEEFCAFEBABE');
    }
  });

  it('never throws on any input, however hostile', () => {
    for (const line of ['', '{', 'null', '[]', '"a string"', '{"schemaVersion":"one"}']) {
      expect(() => parseScorecardLine(line, 1, '/tmp/scorecard.jsonl')).not.toThrow();
    }
  });
});

describe('story 5.6 adaptation', () => {
  it('is false on a default run, which is almost every run', () => {
    expect(toScorecardRecord(run()).adapted).toBe(false);
  });

  it('is true only when an adaptation was applied AND KEPT', () => {
    const kept = toScorecardRecord(
      run({ adaptation: { adapted: true, applied: [], discarded: [] } }),
    );
    const refused = toScorecardRecord(
      run({ adaptation: { adapted: false, applied: [], discarded: [] } }),
    );

    expect(kept.adapted).toBe(true);
    // A refused proposal is RECORDED with `adapted: false` rather than not recorded at
    // all (story 5.6), and the scorecard must not upgrade it to a real adaptation.
    expect(refused.adapted).toBe(false);
  });
});
