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
    // `run-directory` by default, so cases that are NOT about AD-11 do not trip its rule.
    // A real run that prints a `--json` document always persists one too; a synthetic
    // observation claiming `stdout` with nothing stored is the regression shape, and the
    // two tests that mean it say so explicitly.
    documentSource: 'run-directory',
    runDirectory: '/tmp/ws/project/.specwitness/runs/run-20260904T134152Z-2of4',
    storedResult: null,
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

describe('AD-11: --json stdout and the stored result.json are the same bytes', () => {
  const stored = '{\n  "schemaVersion": 1\n}\n';

  it('passes when they are identical', () => {
    const problems = compareOutcome(
      expectation({ criteria: { assertion: 'subset', statuses: {} } }),
      observation({ stdout: stored, storedResult: stored }),
      normalizer,
    );

    expect(problems).toEqual([]);
  });

  it('FAILS when they differ, even by a byte', () => {
    // Q53's promise is that a harness reading stdout and a human reading the run directory
    // cannot see different runs. A value comparison would pass here; only a byte comparison
    // tests what the invariant actually says.
    const problems = compareOutcome(
      expectation({ criteria: { assertion: 'subset', statuses: {} } }),
      observation({ stdout: '{"schemaVersion":1}\n', storedResult: stored }),
      normalizer,
    );

    expect(problems.join('\n')).toContain('NOT the same bytes');
  });

  it('FAILS when the run printed a document and persisted nothing', () => {
    // The other half of the invariant, and the one a naive "compare when both exist" check
    // skips: a regression that stopped writing `result.json` would sail through, because the
    // outcome still comes off stdout. FR-30/FR-31 make the run directory the evidence that
    // outlives the terminal.
    const problems = compareOutcome(
      expectation({ criteria: { assertion: 'subset', statuses: {} } }),
      observation({ stdout: stored, storedResult: null, documentSource: 'stdout' }),
      normalizer,
    );

    expect(problems.join('\n')).toContain('persisted NO result.json');
  });

  it('says nothing when the run persisted nothing AND printed nothing', () => {
    // An edge refusal: empty stdout beside no file is consistent, and is how an infra
    // refusal legitimately looks.
    const problems = compareOutcome(
      expectation({
        exitCode: 3,
        outcome: { infraError: 'integrity' },
        criteria: { assertion: 'subset', statuses: {} },
        stderrContains: ['the contract for epic-1 was edited after it was frozen'],
      }),
      observation({
        exitCode: 3,
        stdout: '',
        stderr: 'ERROR: the contract for epic-1 was edited after it was frozen\n',
        document: null,
        documentSource: 'none',
        runDirectory: null,
        storedResult: null,
      }),
      normalizer,
    );

    expect(problems).toEqual([]);
  });

  it('says nothing when the fixture did not ask for --json', () => {
    // A fixture that does not request the document on stdout asserts nothing about it.
    const problems = compareOutcome(
      expectation({
        command: ['verify', 'epic-1'],
        criteria: { assertion: 'subset', statuses: {} },
      }),
      observation({ stdout: '', storedResult: stored }),
      normalizer,
    );

    expect(problems).toEqual([]);
  });
});

describe('an infraError expectation with no document must pin the MESSAGE', () => {
  // The classification is printed nowhere: an edge refusal writes no run directory at all
  // (verified against a tampered contract — exit 3, empty stdout, no `.specwitness/runs`
  // entry), and exit 3 is identical for all five classifications. The message is the only
  // thing that distinguishes them.
  const infra = (stderrContains: string[]) =>
    expectation({
      exitCode: 3,
      outcome: { infraError: 'integrity' },
      criteria: { assertion: 'subset', statuses: {} },
      stderrContains,
    });

  const noDocument = (stderr: string) =>
    observation({
      exitCode: 3,
      document: null,
      documentSource: 'none',
      runDirectory: null,
      stderr,
    });

  it('REFUSES a generic `ERROR:` as the whole of the evidence', () => {
    // The hole named in review: a fixture expecting `provider` with only `ERROR:` pinned
    // stays green when the CLI actually reported `config` — the classification confusion
    // FR-22 exists to prevent, arriving through the corpus meant to pin FR-22.
    const problems = compareOutcome(infra(['ERROR:']), noDocument('ERROR: something\n'), normalizer);

    expect(problems.join('\n')).toContain('cannot be read back');
  });

  it('accepts a specific sentence that names the failure', () => {
    const message = 'the contract for epic-1 was edited after it was frozen';
    const problems = compareOutcome(infra([message]), noDocument(`ERROR: ${message}\n`), normalizer);

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

/* ── story 6.10: evidence-kind comparison ───────────────────────────────────────────── */

/**
 * An observation whose document carries evidence of the given kinds.
 *
 * Only `kind` is populated. The comparison is set arithmetic over kinds and reads no other
 * field, so filling in URLs and command output here would be inventing detail the function
 * never looks at — and would put fixture-shaped payloads into a test that is about kinds.
 */
function withEvidence(kinds: readonly string[], rest: Partial<ObservedOutcome> = {}) {
  const base = observation(rest);
  return {
    ...base,
    document: { ...base.document, evidence: kinds.map((kind) => ({ kind })) } as unknown as RunResultDocument,
  };
}

describe('evidence kinds are compared when, and only when, a fixture pins them', () => {
  it('says nothing about evidence when the fixture omits the key', () => {
    // AC2 at the comparator, the other half of the schema's optionality. Every fixture merged
    // before story 6.10 omits `evidence`, and a run producing any kinds at all must still
    // compare exactly as it did before the key existed.
    const problems = compareOutcome(
      expectation(),
      withEvidence(['gate', 'command', 'provider']),
      normalizer,
    );

    expect(problems).toEqual([]);
  });

  it('passes when an `exact` expectation matches the observed set', () => {
    const problems = compareOutcome(
      expectation({ evidence: { assertion: 'exact', kinds: ['gate', 'command'] } }),
      withEvidence(['command', 'gate']),
      normalizer,
    );

    expect(problems).toEqual([]);
  });

  it('ignores ORDER, because a set is not a list', () => {
    // Two runs differing only in the order their evidence was recorded describe the same run.
    // A comparator that disagreed would produce a fixture that fails on Tuesday, which the
    // format's own README names as the failure that gets a corpus disabled.
    const problems = compareOutcome(
      expectation({
        evidence: { assertion: 'exact', kinds: ['observation', 'gate', 'command'] },
      }),
      withEvidence(['command', 'observation', 'gate']),
      normalizer,
    );

    expect(problems).toEqual([]);
  });

  it('ignores DUPLICATE observed records of the same kind', () => {
    // Three gates produce three `gate` evidence members. The claim is "the run produced gate
    // evidence", not "the run produced exactly one".
    const problems = compareOutcome(
      expectation({ evidence: { assertion: 'exact', kinds: ['gate'] } }),
      withEvidence(['gate', 'gate', 'gate']),
      normalizer,
    );

    expect(problems).toEqual([]);
  });
});

describe('a missing evidence kind is a fixture FAILURE, naming both sides', () => {
  it('catches a kind that stopped being produced, under `exact`', () => {
    // THE DEFECT THIS STORY EXISTS FOR: the verdict is still correct, every criterion status
    // is unchanged, and a verification surface quietly stopped producing evidence. Every
    // fixture merged before this key is blind to it.
    const problems = compareOutcome(
      expectation({
        evidence: { assertion: 'exact', kinds: ['gate', 'command', 'observation'] },
      }),
      withEvidence(['gate', 'command']),
      normalizer,
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/evidence/);
    expect(problems[0]).toMatch(/observation/);
  });

  it('catches it under `subset` too — the weaker claim still requires presence', () => {
    const problems = compareOutcome(
      expectation({ evidence: { assertion: 'subset', kinds: ['gate', 'observation'] } }),
      withEvidence(['gate', 'command']),
      normalizer,
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/observation/);
  });

  it('names the EXPECTED kinds and the OBSERVED kinds, so the reader can see the difference', () => {
    const problems = compareOutcome(
      expectation({ evidence: { assertion: 'exact', kinds: ['gate', 'http'] } }),
      withEvidence(['gate', 'command']),
      normalizer,
    );

    const message = problems.join('\n');
    expect(message).toMatch(/expected/i);
    expect(message).toMatch(/observed/i);
    expect(message).toMatch(/http/);
    expect(message).toMatch(/command/);
  });
});

describe('an EXTRA evidence kind is where exact and subset differ', () => {
  it('`exact` fails when the run produced a kind the fixture does not list', () => {
    // The property `stderrContains` cannot express: story 6.2's merged fixtures pin the
    // rendered Evidence lines as a PRESENCE check, so a run that starts producing an
    // additional kind still passes there. Here it does not.
    const problems = compareOutcome(
      expectation({ evidence: { assertion: 'exact', kinds: ['gate'] } }),
      withEvidence(['gate', 'provider']),
      normalizer,
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/provider/);
  });

  it('`subset` PERMITS it, and that is the whole difference between the two', () => {
    const problems = compareOutcome(
      expectation({ evidence: { assertion: 'subset', kinds: ['gate'] } }),
      withEvidence(['gate', 'provider']),
      normalizer,
    );

    expect(problems).toEqual([]);
  });
});

describe('the degenerate cases, which are where a comparison goes quietly green', () => {
  it('an `exact` empty expectation FAILS when the run produced evidence', () => {
    // `exact` + `[]` is a real claim — "this run produced no evidence at all" — and this is
    // it going red, which is why the schema allows it while refusing `subset` + `[]`.
    const problems = compareOutcome(
      expectation({ evidence: { assertion: 'exact', kinds: [] } }),
      withEvidence(['gate']),
      normalizer,
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/gate/);
  });

  it('an `exact` empty expectation passes when the run produced none', () => {
    const problems = compareOutcome(
      expectation({ evidence: { assertion: 'exact', kinds: [] } }),
      withEvidence([]),
      normalizer,
    );

    expect(problems).toEqual([]);
  });

  it('a run that produced NO EVIDENCE cannot satisfy a fixture that names kinds', () => {
    // The vacuous pass, at the comparator rather than at load. A run whose evidence array is
    // empty is precisely the regression this key was added to catch, so it must be loud.
    const problems = compareOutcome(
      expectation({ evidence: { assertion: 'subset', kinds: ['gate', 'command'] } }),
      withEvidence([]),
      normalizer,
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/gate/);
    expect(problems[0]).toMatch(/command/);
  });

  it('a run that produced NO DOCUMENT cannot silently satisfy an evidence expectation', () => {
    // An edge refusal writes no document at all. Without this arm the evidence branch would
    // simply be skipped and the fixture would assert nothing about evidence while claiming to
    // — the same "green for nothing" one level down.
    const problems = compareOutcome(
      expectation({
        exitCode: 3,
        outcome: { infraError: 'integrity' },
        criteria: { assertion: 'subset', statuses: {} },
        stderrContains: ['ERROR: the frozen contract does not match its fingerprint'],
        evidence: { assertion: 'subset', kinds: ['gate'] },
      }),
      observation({
        exitCode: 3,
        document: null,
        documentSource: 'none',
        runDirectory: null,
        stderr: 'ERROR: the frozen contract does not match its fingerprint',
      }),
      normalizer,
    );

    expect(problems.some((problem) => /evidence/.test(problem))).toBe(true);
  });
});

describe('the failure message quotes kinds and NOTHING else', () => {
  it('does not leak evidence contents into the problem text', () => {
    // Spec Security: kinds are safe to print; request bodies, command output and provider
    // payloads are not. A failure message that started quoting the evidence it compared would
    // put un-redacted run content into CI logs.
    const secret = 'authorization: Bearer sk-live-DEADBEEF';
    const base = observation();
    const observed = {
      ...base,
      document: {
        ...base.document,
        evidence: [
          { kind: 'http', request: { url: 'http://127.0.0.1:1/x', headers: secret } },
        ],
      } as unknown as RunResultDocument,
    };

    const problems = compareOutcome(
      expectation({ evidence: { assertion: 'exact', kinds: ['gate'] } }),
      observed,
      normalizer,
    );

    expect(problems).toHaveLength(1);
    expect(problems.join('\n')).not.toContain('DEADBEEF');
    expect(problems.join('\n')).not.toContain('Bearer');
    expect(problems[0]).toMatch(/http/);
  });
});
