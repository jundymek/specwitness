/**
 * `compareOutcome` — the function that decides whether a corpus fixture held (story 6.1).
 *
 * PURE. Observations are hand-built here rather than produced by a run, so every branch is
 * reachable without spawning anything, including the branches no checked-in fixture
 * currently exercises. The corpus suite proper drives the real binary in `tests/corpus/`.
 *
 * **This file is the runner's own guard, and it matters as much as any fixture.** A runner
 * that reports green when a fixture drifted is the worst outcome available in story 6.1: it
 * makes every other proof in this epic worthless while looking exactly like success.
 */

import { describe, expect, it } from 'vitest';

import type { RunResultDocument } from '../../../src/schemas/result.js';
import type { ExpectedOutcomeFile } from '../../corpus/expected.js';
import { createNormalizer } from '../../corpus/normalize.js';
import { compareOutcome, type ObservedOutcome } from '../../corpus/runner.js';

const normalizer = createNormalizer({ paths: {}, ports: {} });

function expectation(overrides: Partial<ExpectedOutcomeFile> = {}): ExpectedOutcomeFile {
  return {
    expectedVersion: 1,
    fixture: 'demo',
    why: 'A long enough sentence naming the defect class and the requirement it proves.',
    proves: ['AC1'],
    command: ['verify', 'epic-1', '--json'],
    exitCode: 1,
    outcome: { verdict: 'FAIL' },
    criteria: { assertion: 'exact', statuses: { 'E1-01': 'pass', 'E1-02': 'fail' } },
    ...overrides,
  } as ExpectedOutcomeFile;
}

function observation(overrides: Partial<ObservedOutcome> = {}): ObservedOutcome {
  const document = {
    outcome: { verdict: 'FAIL' },
    criteria: [
      { criterionId: 'E1-01', status: 'pass' },
      { criterionId: 'E1-02', status: 'fail' },
    ],
  } as unknown as RunResultDocument;

  return {
    exitCode: 1,
    stdout: '',
    stderr: '',
    document,
    documentSource: 'stdout',
    runDirectory: '/tmp/ws/project/.specwitness/runs/run-20260904T134152Z-2of4',
    ...overrides,
  };
}

describe('an observation matching its expectation', () => {
  it('reports no problems', () => {
    expect(compareOutcome(expectation(), observation(), normalizer)).toEqual([]);
  });
});

describe('drift is detected', () => {
  it('catches a changed exit code', () => {
    const problems = compareOutcome(expectation(), observation({ exitCode: 0 }), normalizer);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('exit code');
  });

  it('catches a changed verdict', () => {
    const document = {
      outcome: { verdict: 'PASS' },
      criteria: [
        { criterionId: 'E1-01', status: 'pass' },
        { criterionId: 'E1-02', status: 'fail' },
      ],
    } as unknown as RunResultDocument;

    const problems = compareOutcome(expectation(), observation({ document }), normalizer);

    expect(problems.join('\n')).toContain('outcome');
  });

  it('catches an UNEXPECTED gateFailed marker', () => {
    // ADR-003: `gateFailed` present means the product attributed the failure to the build.
    // A fixture with no gates that suddenly reports one is a real classification defect, and
    // the comparison must not treat an extra key as "close enough".
    const document = {
      outcome: { verdict: 'FAIL', gateFailed: 'lint' },
      criteria: [
        { criterionId: 'E1-01', status: 'pass' },
        { criterionId: 'E1-02', status: 'fail' },
      ],
    } as unknown as RunResultDocument;

    const problems = compareOutcome(expectation(), observation({ document }), normalizer);

    expect(problems.join('\n')).toContain('gateFailed');
  });

  it('catches a changed criterion status', () => {
    const document = {
      outcome: { verdict: 'FAIL' },
      criteria: [
        { criterionId: 'E1-01', status: 'pass' },
        { criterionId: 'E1-02', status: 'error' },
      ],
    } as unknown as RunResultDocument;

    const problems = compareOutcome(expectation(), observation({ document }), normalizer);

    expect(problems.join('\n')).toContain("criterion E1-02: expected 'fail', observed 'error'");
  });

  it('catches a criterion that vanished from the report entirely', () => {
    // The green-for-nothing shape at criterion level: a criterion nobody adjudicated is not
    // a criterion that passed. If the product stops reporting E1-02, the fixture must go
    // red rather than quietly assert less than it did yesterday.
    const document = {
      outcome: { verdict: 'FAIL' },
      criteria: [{ criterionId: 'E1-01', status: 'pass' }],
    } as unknown as RunResultDocument;

    const problems = compareOutcome(expectation(), observation({ document }), normalizer);

    expect(problems.join('\n')).toContain('no result for that criterion at all');
  });
});

describe('the comparison is about behaviour, not about serialisation', () => {
  it('does not care about the KEY ORDER of the outcome object', () => {
    // Key order in a run document is an artefact of how `domain/verdict.ts` built the
    // object, not a fact about the run. Comparing serialised strings would make a harmless
    // refactor there turn every fixture red — "a fixture that fails on Tuesday", which is
    // the failure mode this whole format is shaped against.
    const expected = expectation({
      outcome: { verdict: 'FAIL', gateFailed: 'lint' },
      criteria: { assertion: 'subset', statuses: {} },
    });
    const document = {
      // The same two keys, the other way round.
      outcome: { gateFailed: 'lint', verdict: 'FAIL' },
      criteria: [],
    } as unknown as RunResultDocument;

    expect(compareOutcome(expected, observation({ document }), normalizer)).toEqual([]);
  });

  it('catches a DUPLICATE criterion result instead of silently keeping the last one', () => {
    // The green-for-nothing failure arriving through the comparator itself. Nothing in
    // `src/schemas/result.ts` requires criterion ids to be unique, and a naive
    // `new Map(...)` keeps the LAST entry — so a document carrying two contradictory
    // results for one criterion would collapse to whichever came second, and an `exact`
    // expectation could pass while the product emitted a contradiction.
    const document = {
      outcome: { verdict: 'FAIL' },
      criteria: [
        { criterionId: 'E1-01', status: 'pass' },
        { criterionId: 'E1-02', status: 'fail' },
        { criterionId: 'E1-02', status: 'pass' },
      ],
    } as unknown as RunResultDocument;

    const problems = compareOutcome(expectation(), observation({ document }), normalizer);

    expect(problems.join('\n')).toContain('the run reported it 2 times');
    expect(problems.join('\n')).toContain('fail, pass');
  });
});

describe('exact and subset are different claims', () => {
  const document = {
    outcome: { verdict: 'FAIL' },
    criteria: [
      { criterionId: 'E1-01', status: 'pass' },
      { criterionId: 'E1-02', status: 'fail' },
      { criterionId: 'E1-03', status: 'needs_human' },
    ],
  } as unknown as RunResultDocument;

  it('an `exact` fixture fails when the run reports a criterion it does not list', () => {
    const problems = compareOutcome(expectation(), observation({ document }), normalizer);

    expect(problems.join('\n')).toContain('criterion E1-03');
  });

  it('a `subset` fixture asserts only what it names, and says so explicitly', () => {
    const subset = expectation({
      criteria: { assertion: 'subset', statuses: { 'E1-02': 'fail' } },
    });

    expect(compareOutcome(subset, observation({ document }), normalizer)).toEqual([]);
  });
});

describe('a run that produced no document', () => {
  it('cannot satisfy a fixture expecting a product verdict', () => {
    // A verdict that was never written down is not a verdict. Exit code alone must not be
    // allowed to stand in for one, or a fixture goes green on a run that persisted nothing.
    const problems = compareOutcome(
      expectation(),
      observation({ document: null, documentSource: 'none', runDirectory: null }),
      normalizer,
    );

    expect(problems.join('\n')).toContain('no result document');
  });

  it('refuses an infraError expectation that pins nothing else', () => {
    // The legitimate no-document case is an infrastructure refusal raised at the CLI edge.
    // It is legitimate ONLY when the fixture also pins the ERROR text, because otherwise it
    // asserts a single small integer and calls that a classification.
    const infra = expectation({ exitCode: 3, outcome: { infraError: 'integrity' } });

    const problems = compareOutcome(
      infra,
      observation({ exitCode: 3, document: null, documentSource: 'none', runDirectory: null }),
      normalizer,
    );

    expect(problems.join('\n')).toContain('stderrContains');
  });

  it('accepts an infraError expectation that pins the ERROR text', () => {
    const infra = expectation({
      exitCode: 3,
      outcome: { infraError: 'integrity' },
      stderrContains: ['ERROR: the contract for epic-1 does not match its fingerprint'],
    });

    const problems = compareOutcome(
      infra,
      observation({
        exitCode: 3,
        document: null,
        documentSource: 'none',
        runDirectory: null,
        stderr: 'ERROR: the contract for epic-1 does not match its fingerprint\nHINT: ...\n',
      }),
      normalizer,
    );

    expect(problems).toEqual([]);
  });
});

describe('stderr assertions run against NORMALISED text', () => {
  const withRunId = createNormalizer({ paths: { '<PROJECT>': '/tmp/ws/project' }, ports: {} });

  it('lets a fixture name a placeholder instead of a value that changes every run', () => {
    const expected = expectation({
      stderrContains: ['Run dir:     <PROJECT>/.specwitness/runs/<RUN-ID>'],
    });

    const problems = compareOutcome(
      expected,
      observation({
        stderr: 'Run dir:     /tmp/ws/project/.specwitness/runs/run-20260904T134152Z-2of4\n',
      }),
      withRunId,
    );

    expect(problems).toEqual([]);
  });

  it('fails when a string that must be absent is present', () => {
    // Epic 3 retro §7: assert a secret is ABSENT, never that `[REDACTED]` is PRESENT.
    const expected = expectation({ stderrAbsent: ['zzTOPSECRETzz'] });

    const problems = compareOutcome(
      expected,
      observation({ stderr: 'AWS_SECRET_ACCESS_KEY=zzTOPSECRETzz-4f2a9c1b\n' }),
      normalizer,
    );

    expect(problems.join('\n')).toContain('NOT to contain');
  });
});
