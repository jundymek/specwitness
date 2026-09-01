/**
 * Story 4.5 — the observation surface executor, unit level.
 *
 * SPAWNS ZERO SUBPROCESSES. Every `ProcessResult` here is scripted, so this file covers the
 * MAPPING from an outcome to a `ProbeAttempt`. Whether a genuinely missing binary actually
 * arrives as `'not-found'` is a question only a real spawn can answer, and
 * `tests/integration/surfaces/observation.test.ts` answers it — the same division story 3.4
 * drew between its unit and integration suites, and for the same reason: a scripted
 * `'not-found'` proves the `switch` handles a string, not that the string ever occurs.
 *
 * THE SEEDED CANARY is deliberately not shaped like a real vendor key. The repository's
 * pre-commit secret scanner rejects `sk-…` literals on sight, which is correct of it — and
 * the shape is irrelevant to what is being proved. `redactText` fires on the ASSIGNMENT NAME
 * (`AWS_SECRET_ACCESS_KEY=`, `Authorization:`), not on the value's format, so any distinctive
 * string exercises exactly the same code path.
 */

import { describe, expect, it } from 'vitest';

import { deriveCriterionResult } from '../../../src/domain/criterion-result.js';
import type { ContractCriterionRef } from '../../../src/domain/criterion-result.js';
import { InfraError } from '../../../src/domain/errors.js';
import { EVIDENCE_INLINE_CAP_BYTES } from '../../../src/domain/evidence.js';
import { ObservationSurfaceExecutor } from '../../../src/surfaces/observation.js';
import type { ObservationExecutorDeps } from '../../../src/surfaces/observation.js';
import { FixedClock } from '../../fakes/ports.js';

import {
  processResult,
  RecordingEvidence,
  resolvedCommand,
  ScriptedRunner,
} from './observation.helpers.js';

const AUTOMATED: ContractCriterionRef = {
  criterionId: 'E4-01',
  statement: 'Submitting the form twice creates exactly one company row.',
  severity: 'critical',
  verifiability: 'automated',
};

/** Builds an executor over scripted results, returning the recorder for assertions. */
function executor(
  runner: ScriptedRunner,
  overrides: Partial<ObservationExecutorDeps> = {},
): { executor: ObservationSurfaceExecutor; evidence: RecordingEvidence } {
  const evidence = new RecordingEvidence();
  return {
    evidence,
    executor: new ObservationSurfaceExecutor({
      runner,
      clock: new FixedClock('2026-09-01T12:00:00.000Z'),
      cwd: '/tmp/worktree',
      writeEvidence: evidence.write,
      recordEvidence: evidence.record,
      resolveCommand: () => resolvedCommand(),
      ...overrides,
    }),
  };
}

/** A probe's params, in the shape the caller builds from a compiled plan. */
function params(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    probeId: 'count-companies',
    mechanics: { commandId: 'company-count', args: [] },
    assertions: [
      {
        description: 'exactly one company row exists',
        target: { source: 'jsonPath', path: '$.count', phase: 'snapshot' },
        comparison: 'equals',
        expected: '1',
      },
    ],
    ...overrides,
  };
}

function request(paramOverrides: Record<string, unknown> = {}) {
  return {
    criterionId: 'E4-01',
    surface: 'observation' as const,
    params: params(paramOverrides),
  };
}

describe('ObservationSurfaceExecutor — the AD-13 contract', () => {
  it('declares the observation surface', () => {
    const { executor: subject } = executor(new ScriptedRunner(processResult()));
    expect(subject.surface).toBe('observation');
  });

  it('returns a ProbeAttempt carrying no status field of any kind', async () => {
    const { executor: subject } = executor(
      new ScriptedRunner(processResult({ stdout: '{"count":1}' })),
    );

    const attempt = await subject.execute(request());

    // AD-13: "It returns observations and assertion evaluations. It does NOT return a
    // CriterionStatus, and there is nowhere in this interface to put one." The type test
    // proves that at compile time; this proves no such key was smuggled in at run time.
    expect(Object.keys(attempt).sort()).toEqual(
      ['assertionEvaluations', 'attempt', 'durationMs', 'evidence', 'observations'].sort(),
    );
    expect(attempt.attempt).toBe(1);
  });

  it('stamps the attempt number from params and never loops internally (AD-9)', async () => {
    const runner = new ScriptedRunner(processResult({ stdout: '{"count":9}' }));
    const { executor: subject } = executor(runner);

    const attempt = await subject.execute(request({ attempt: 3 }));

    expect(attempt.attempt).toBe(3);
    // One spawn per execute(). Retry orchestration belongs to the caller; a loop here would
    // make `flaky` wrong and every earlier attempt invisible.
    expect(runner.calls).toHaveLength(1);
  });

  it('takes durationMs from the injected Clock as whole milliseconds (AD-9)', async () => {
    const { executor: subject } = executor(
      new ScriptedRunner(processResult({ stdout: '{"count":1}' })),
      { clock: new FixedClock('2026-09-01T12:00:00.000Z', '2026-09-01T12:00:00.250Z') },
    );

    const attempt = await subject.execute(request());

    expect(attempt.durationMs).toBe(250);
    expect(Number.isInteger(attempt.durationMs)).toBe(true);
  });

  it('spawns binary + argv in the given cwd, with no shell anywhere (AD-3)', async () => {
    const runner = new ScriptedRunner(processResult({ stdout: '{"count":1}' }));
    const { executor: subject } = executor(runner, {
      resolveCommand: () => resolvedCommand({ binary: 'node', baseArgs: ['./count.js', '--json'] }),
    });

    await subject.execute(request({ mechanics: { commandId: 'company-count', args: ['--all'] } }));

    const call = runner.calls[0];
    expect(call?.binary).toBe('node');
    // Declared baseArgs first, then the plan's args — the ordering settled with 4.6.
    expect(call?.args).toEqual(['./count.js', '--json', '--all']);
    expect(call?.cwd).toBe('/tmp/worktree');
    expect(call).not.toHaveProperty('shell');
  });
});

describe('mechanical assertions (AC1)', () => {
  it('evaluates a satisfied equals assertion and names both values', async () => {
    const { executor: subject } = executor(
      new ScriptedRunner(processResult({ stdout: '{"count":1}' })),
    );

    const attempt = await subject.execute(request());

    expect(attempt.assertionEvaluations).toHaveLength(1);
    const [evaluation] = attempt.assertionEvaluations;
    expect(evaluation?.satisfied).toBe(true);
    expect(evaluation?.description).toBe('exactly one company row exists');
    expect(evaluation?.expected).toBe('1');
    expect(evaluation?.actual).toBe('1');
  });

  it('evaluates an unsatisfied equals assertion', async () => {
    const { executor: subject } = executor(
      new ScriptedRunner(processResult({ stdout: '{"count":4}' })),
    );

    const attempt = await subject.execute(request());

    expect(attempt.assertionEvaluations[0]?.satisfied).toBe(false);
    expect(attempt.assertionEvaluations[0]?.expected).toBe('1');
    expect(attempt.assertionEvaluations[0]?.actual).toBe('4');
  });

  it('emits one evaluation per declared assertion INCLUDING the satisfied ones', async () => {
    // FR-28 needs expected/actual on non-pass results, and `deriveCriterionResult` reads
    // `find(e => !e.satisfied)` — an executor that dropped satisfied evaluations would make
    // a passing criterion indistinguishable from one that adjudicated nothing at all.
    const { executor: subject } = executor(
      new ScriptedRunner(processResult({ stdout: '{"count":1,"name":"acme"}' })),
    );

    const attempt = await subject.execute(
      request({
        assertions: [
          {
            description: 'one row',
            target: { source: 'jsonPath', path: '$.count', phase: 'snapshot' },
            comparison: 'equals',
            expected: '1',
          },
          {
            description: 'named acme',
            target: { source: 'jsonPath', path: '$.name', phase: 'snapshot' },
            comparison: 'equals',
            expected: 'zzz',
          },
        ],
      }),
    );

    expect(attempt.assertionEvaluations).toHaveLength(2);
    expect(attempt.assertionEvaluations.map((e) => e.satisfied)).toEqual([true, false]);
  });

  it('supports every merged comparison', async () => {
    const { executor: subject } = executor(
      new ScriptedRunner(processResult({ stdout: '{"count":5,"name":"acme-corp"}' })),
    );
    const at = (path: string) => ({ source: 'jsonPath', path, phase: 'snapshot' });

    const attempt = await subject.execute(
      request({
        assertions: [
          { description: 'a', target: at('$.count'), comparison: 'equals', expected: '5' },
          { description: 'b', target: at('$.count'), comparison: 'notEquals', expected: '6' },
          { description: 'c', target: at('$.name'), comparison: 'contains', expected: 'acme' },
          { description: 'd', target: at('$.name'), comparison: 'notContains', expected: 'zzz' },
          { description: 'e', target: at('$.count'), comparison: 'greaterThan', expected: '4' },
          { description: 'f', target: at('$.count'), comparison: 'lessThan', expected: '6' },
        ],
      }),
    );

    expect(attempt.assertionEvaluations.map((e) => e.satisfied)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it('treats a non-numeric value under a numeric comparison as unsatisfied, not a crash', async () => {
    // The merged `ASSERTION_COMPARISONS` doc: "both sides must parse as finite numbers, and
    // an actual value that does not is an unsatisfied assertion, never a crash."
    const { executor: subject } = executor(
      new ScriptedRunner(processResult({ stdout: '{"count":"many"}' })),
    );

    const attempt = await subject.execute(
      request({
        assertions: [
          {
            description: 'more than three',
            target: { source: 'jsonPath', path: '$.count', phase: 'snapshot' },
            comparison: 'greaterThan',
            expected: '3',
          },
        ],
      }),
    );

    expect(attempt.execError).toBeUndefined();
    expect(attempt.assertionEvaluations[0]?.satisfied).toBe(false);
  });

  it('reports an absent JSON path as unsatisfied — never as 0 and never as a crash', async () => {
    // THE FAILURE MODE THIS TEST EXISTS FOR: defaulting a missing count to 0 makes
    // `0 - 0 == 0` pass, i.e. a green criterion for a command that produced nothing.
    const { executor: subject } = executor(
      new ScriptedRunner(processResult({ stdout: '{"total":1}' })),
    );

    const attempt = await subject.execute(request());

    const [evaluation] = attempt.assertionEvaluations;
    expect(evaluation?.satisfied).toBe(false);
    expect(evaluation?.actual).not.toBe('0');
    expect(evaluation?.actual).toMatch(/absent/i);
  });

  it('reads nested paths and array indices', async () => {
    const { executor: subject } = executor(
      new ScriptedRunner(processResult({ stdout: '{"rows":[{"id":"a"},{"id":"b"}]}' })),
    );

    const attempt = await subject.execute(
      request({
        assertions: [
          {
            description: 'second row is b',
            target: { source: 'jsonPath', path: '$.rows[1].id', phase: 'snapshot' },
            comparison: 'equals',
            expected: 'b',
          },
        ],
      }),
    );

    expect(attempt.assertionEvaluations[0]?.satisfied).toBe(true);
  });

  it('records the snapshot as a string-valued Observation', async () => {
    const { executor: subject } = executor(
      new ScriptedRunner(processResult({ stdout: '{"count":7}' })),
    );

    const attempt = await subject.execute(request());

    expect(attempt.observations.length).toBeGreaterThan(0);
    for (const observation of attempt.observations) {
      expect(typeof observation.value).toBe('string');
      expect(typeof observation.name).toBe('string');
    }
  });
});

describe('before/after (AC1)', () => {
  const beforeAfter = (overrides: Record<string, unknown> = {}) =>
    request({
      mechanics: { commandId: 'company-count', args: [], around: 'submit-form' },
      assertions: [
        {
          description: 'exactly one company row is created',
          target: { source: 'jsonPath', path: '$.count', phase: 'delta' },
          comparison: 'equals',
          expected: '1',
        },
      ],
      ...overrides,
    });

  it('snapshots twice around the action and satisfies a correct delta', async () => {
    const runner = new ScriptedRunner(
      processResult({ stdout: '{"count":3}' }),
      processResult({ stdout: '{"count":4}' }),
    );
    let actionRuns = 0;
    const { executor: subject } = executor(runner, {
      runAction: () => {
        actionRuns += 1;
        return Promise.resolve();
      },
    });

    const attempt = await subject.execute(beforeAfter());

    expect(runner.calls).toHaveLength(2);
    expect(actionRuns).toBe(1);
    expect(attempt.assertionEvaluations[0]?.satisfied).toBe(true);
    expect(attempt.assertionEvaluations[0]?.actual).toBe('1');
  });

  it('fails the duplicate-submission delta with expected 1 and actual 2 (brief §35)', async () => {
    const runner = new ScriptedRunner(
      processResult({ stdout: '{"count":3}' }),
      processResult({ stdout: '{"count":5}' }),
    );
    const { executor: subject } = executor(runner, { runAction: () => Promise.resolve() });

    const attempt = await subject.execute(beforeAfter());

    expect(attempt.execError).toBeUndefined();
    expect(attempt.assertionEvaluations[0]?.satisfied).toBe(false);
    expect(attempt.assertionEvaluations[0]?.expected).toBe('1');
    expect(attempt.assertionEvaluations[0]?.actual).toBe('2');
  });

  it('evaluates before and after phases independently of the delta', async () => {
    const runner = new ScriptedRunner(
      processResult({ stdout: '{"count":3}' }),
      processResult({ stdout: '{"count":4}' }),
    );
    const { executor: subject } = executor(runner, { runAction: () => Promise.resolve() });

    const attempt = await subject.execute(
      beforeAfter({
        assertions: [
          {
            description: 'started at three',
            target: { source: 'jsonPath', path: '$.count', phase: 'before' },
            comparison: 'equals',
            expected: '3',
          },
          {
            description: 'ended at four',
            target: { source: 'jsonPath', path: '$.count', phase: 'after' },
            comparison: 'equals',
            expected: '4',
          },
          {
            description: 'one created',
            target: { source: 'jsonPath', path: '$.count', phase: 'delta' },
            comparison: 'equals',
            expected: '1',
          },
        ],
      }),
    );

    expect(attempt.assertionEvaluations.map((e) => e.satisfied)).toEqual([true, true, true]);
  });

  it('carries BOTH snapshots as observations and as evidence', async () => {
    const runner = new ScriptedRunner(
      processResult({ stdout: '{"count":3}' }),
      processResult({ stdout: '{"count":4}' }),
    );
    const { executor: subject, evidence } = executor(runner, {
      runAction: () => Promise.resolve(),
    });

    const attempt = await subject.execute(beforeAfter());

    // A before/after pair is naturally TWO observation evidence entries (AC1).
    expect(evidence.members).toHaveLength(2);
    expect(attempt.evidence.length).toBeGreaterThanOrEqual(2);
    for (const ref of attempt.evidence) {
      // Q48: relative to the run-directory root, always.
      expect(ref.path.startsWith('/')).toBe(false);
    }
    const persisted = evidence.everythingPersisted();
    expect(persisted).toContain('"count":3');
    expect(persisted).toContain('"count":4');
  });

  it('does NOT assert a delta over garbage when the BEFORE snapshot fails', async () => {
    const runner = new ScriptedRunner(
      processResult({ stdout: 'not json' }),
      processResult({ stdout: '{"count":4}' }),
    );
    let actionRuns = 0;
    const { executor: subject } = executor(runner, {
      runAction: () => {
        actionRuns += 1;
        return Promise.resolve();
      },
    });

    const attempt = await subject.execute(beforeAfter());

    expect(attempt.execError).toBeDefined();
    expect(attempt.assertionEvaluations).toEqual([]);
    // The action never ran: performing it after a failed "before" would mutate the system
    // for a comparison that can no longer be made.
    expect(actionRuns).toBe(0);
    expect(runner.calls).toHaveLength(1);
  });

  it('does NOT satisfy a zero delta when the path is absent from both snapshots', async () => {
    // THE SHARPEST FORM OF THE DEFAULTING TRAP, and the one a "missing => 0" implementation
    // passes while looking correct: both snapshots parse as JSON, neither carries the path,
    // and `0 - 0 == 0` satisfies an `expected: '0'` delta. That is a GREEN criterion for an
    // observation that measured nothing at all. Absence must stay absence.
    const runner = new ScriptedRunner(
      processResult({ stdout: '{"other":1}' }),
      processResult({ stdout: '{"other":1}' }),
    );
    const { executor: subject } = executor(runner, { runAction: () => Promise.resolve() });

    const attempt = await subject.execute(
      beforeAfter({
        assertions: [
          {
            description: 'nothing was created',
            target: { source: 'jsonPath', path: '$.count', phase: 'delta' },
            comparison: 'equals',
            expected: '0',
          },
        ],
      }),
    );

    expect(attempt.assertionEvaluations[0]?.satisfied).toBe(false);
    expect(attempt.assertionEvaluations[0]?.actual).toMatch(/absent/i);
  });

  it('does NOT satisfy a delta when one side is present but non-numeric', async () => {
    const runner = new ScriptedRunner(
      processResult({ stdout: '{"count":3}' }),
      processResult({ stdout: '{"count":"four"}' }),
    );
    const { executor: subject } = executor(runner, { runAction: () => Promise.resolve() });

    const attempt = await subject.execute(beforeAfter());

    expect(attempt.execError).toBeUndefined();
    expect(attempt.assertionEvaluations[0]?.satisfied).toBe(false);
    expect(attempt.assertionEvaluations[0]?.actual).toMatch(/absent/i);
  });

  it('errors without asserting when the AFTER snapshot fails', async () => {
    const runner = new ScriptedRunner(
      processResult({ stdout: '{"count":3}' }),
      processResult({ stdout: 'not json' }),
    );
    const { executor: subject } = executor(runner, { runAction: () => Promise.resolve() });

    const attempt = await subject.execute(beforeAfter());

    expect(attempt.execError).toBeDefined();
    expect(attempt.assertionEvaluations).toEqual([]);
  });

  it('refuses an around with no runAction injected — a wiring defect, not an execError', async () => {
    const { executor: subject } = executor(
      new ScriptedRunner(processResult({ stdout: '{"count":1}' })),
      { runAction: undefined },
    );

    await expect(subject.execute(beforeAfter())).rejects.toThrow(InfraError);
  });
});

describe('AC2 — the classification that matters most', () => {
  const cases = [
    { name: 'invalid JSON on stdout', result: processResult({ stdout: 'not json' }) },
    {
      name: 'a non-zero exit even with valid JSON',
      result: processResult({ exitCode: 1, stdout: '{"count":1}' }),
    },
    { name: 'a missing binary', result: processResult({ outcome: 'not-found', exitCode: null }) },
    { name: 'a spawn failure', result: processResult({ outcome: 'spawn-failed', exitCode: null }) },
    { name: 'a timeout', result: processResult({ outcome: 'timed-out', exitCode: null }) },
    { name: 'empty stdout', result: processResult({ stdout: '' }) },
    { name: 'JSON that is not an object', result: processResult({ stdout: '42' }) },
    { name: 'JSON that is null', result: processResult({ stdout: 'null' }) },
  ] as const;

  for (const { name, result } of cases) {
    it(`sets execError and NOTHING else for ${name}`, async () => {
      const { executor: subject } = executor(new ScriptedRunner(result));

      const attempt = await subject.execute(request());

      expect(attempt.execError).toBeDefined();
      // "Set execError and nothing else on that path." Emitting unsatisfied assertions
      // beside it would manufacture product evidence out of an infrastructure failure.
      expect(attempt.assertionEvaluations).toEqual([]);

      const derived = deriveCriterionResult(AUTOMATED, [attempt]);
      expect(derived.status).toBe('error');
      expect(derived.status).not.toBe('fail');
    });
  }

  it('parses STDOUT and ignores noise on stderr (Q34/Q35)', async () => {
    // A command that logs to stderr and then prints JSON must keep working; parsing the two
    // streams concatenated would break it, and the failure would look like the project's fault.
    const { executor: subject } = executor(
      new ScriptedRunner(
        processResult({ stdout: '{"count":1}', stderr: 'warning: deprecated flag\n' }),
      ),
    );

    const attempt = await subject.execute(request());

    expect(attempt.execError).toBeUndefined();
    expect(attempt.assertionEvaluations[0]?.satisfied).toBe(true);
  });

  it('captures the raw broken output as evidence even while erroring out (AC2)', async () => {
    const { executor: subject, evidence } = executor(
      new ScriptedRunner(processResult({ stdout: 'this is not json at all' })),
    );

    const attempt = await subject.execute(request());

    expect(attempt.execError).toBeDefined();
    expect(attempt.evidence.length).toBeGreaterThan(0);
    expect(evidence.everythingPersisted()).toContain('this is not json at all');
  });

  it('writes no evidence at all when NOTHING was observed', async () => {
    // The cohort's shared rule (bob's final wording): "no OBSERVATION, no ref". Never invent
    // a ref for a file that was not written — `deriveCriterionResult` tolerates zero
    // deliberately, because "inventing a value would be worse than omitting one".
    const { executor: subject, evidence } = executor(
      new ScriptedRunner(processResult({ outcome: 'not-found', exitCode: null })),
    );

    const attempt = await subject.execute(request());

    expect(attempt.evidence).toEqual([]);
    expect(evidence.files).toEqual([]);
    expect(evidence.members).toEqual([]);
  });

  it('still records evidence for a command that COMPLETED but printed nothing', async () => {
    // `completed` means an exit code WAS observed, so the attempt has something honest to
    // record even though stdout was empty — and FR-28 gets its reference.
    const { executor: subject, evidence } = executor(new ScriptedRunner(processResult()));

    const attempt = await subject.execute(request());

    expect(attempt.execError).toBeDefined();
    expect(attempt.evidence.length).toBeGreaterThan(0);
    expect(evidence.members).toHaveLength(1);
  });

  it('never lets a probe adjudicate a human-verifiability criterion', async () => {
    const { executor: subject } = executor(
      new ScriptedRunner(processResult({ stdout: '{"count":1}' })),
    );

    const attempt = await subject.execute(request());

    // Unconditional, before attempts are even looked at. The executor does not special-case
    // it and must not — that is the whole point of there being one derivation.
    expect(deriveCriterionResult({ ...AUTOMATED, verifiability: 'human' }, [attempt]).status).toBe(
      'needs_human',
    );
  });
});

describe('evidence paths cannot collide across probes', () => {
  /**
   * FOUND BY THE CODEX REVIEW PASS, and it was right.
   *
   * A collision does not lose evidence loudly — `RunStore.writeEvidenceFile` OVERWRITES, and
   * the earlier probe's evidence reference still resolves, now pointing at a different
   * probe's output. Silent corruption of the audit record, which is worse than a missing
   * file because nothing about the run looks wrong.
   */
  const pathsFor = async (criterionId: string, probeId: string): Promise<string[]> => {
    const { executor: subject, evidence } = executor(
      new ScriptedRunner(processResult({ stdout: '{"count":1}' })),
    );
    await subject.execute({
      criterionId,
      surface: 'observation',
      params: params({ probeId }),
    });
    return evidence.files.map((file) => file.name);
  };

  it('separates two criteria that legitimately reuse one probe id', async () => {
    // The merged schema scopes probe-id uniqueness to WITHIN a criterion — "probe ids
    // identify a probe within its criterion" — so this is an ordinary plan, not a bad one.
    const first = await pathsFor('E4-01', 'count-companies');
    const second = await pathsFor('E4-02', 'count-companies');

    expect(first.length).toBeGreaterThan(0);
    expect(first).not.toEqual(second);
    for (const path of first) {
      expect(second).not.toContain(path);
    }
  });

  it('separates two probe ids that differ only past the filename budget', async () => {
    // `Identifier` permits 128 characters and the slug is truncated well below that.
    const stem = 'p'.repeat(80);
    const first = await pathsFor('E4-01', `${stem}alpha`);
    const second = await pathsFor('E4-01', `${stem}omega`);

    expect(first).not.toEqual(second);
  });

  it('produces byte-identical paths for the same identity on every run', async () => {
    // Determinism is load-bearing, not incidental: two runs of the same plan must yield the
    // same evidence paths or a run directory stops being comparable across runs.
    expect(await pathsFor('E4-01', 'count-companies')).toEqual(
      await pathsFor('E4-01', 'count-companies'),
    );
  });

  it('keeps attempt 2 from clobbering attempt 1', async () => {
    const attemptPaths = async (attempt: number): Promise<string[]> => {
      const { executor: subject, evidence } = executor(
        new ScriptedRunner(processResult({ stdout: '{"count":1}' })),
      );
      await subject.execute(request({ attempt }));
      return evidence.files.map((file) => file.name);
    };

    // `deriveCriterionResult` reads the FINAL attempt, so a clobbered file would make a
    // flaky pass point at evidence that no longer shows the failure it was flaky about.
    expect(await attemptPaths(1)).not.toEqual(await attemptPaths(2));
  });

  it('keeps every path relative and free of traversal segments (Q48)', async () => {
    const paths = await pathsFor('E4-01', '../../etc/passwd');

    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path.startsWith('/')).toBe(false);
      expect(path.split('/')).not.toContain('..');
    }
  });
});

describe('malformed params are a wiring defect, not an execError', () => {
  const assertion = (overrides: Record<string, unknown> = {}) => ({
    description: 'd',
    target: { source: 'jsonPath', path: '$.a', phase: 'snapshot' },
    comparison: 'equals',
    expected: '1',
    ...overrides,
  });

  const bad: { name: string; params: Record<string, unknown> }[] = [
    { name: 'no mechanics', params: { probeId: 'x', assertions: [assertion()] } },
    {
      name: 'no assertions',
      params: { probeId: 'x', mechanics: { commandId: 'c', args: [] }, assertions: [] },
    },
    {
      name: 'a non-string arg',
      params: {
        probeId: 'x',
        mechanics: { commandId: 'c', args: [7] },
        assertions: [assertion()],
      },
    },
    {
      name: 'an unknown comparison',
      params: {
        probeId: 'x',
        mechanics: { commandId: 'c', args: [] },
        assertions: [assertion({ comparison: 'matchesRegex' })],
      },
    },
    {
      name: 'an unknown assertion source',
      params: {
        probeId: 'x',
        mechanics: { commandId: 'c', args: [] },
        assertions: [assertion({ target: { source: 'stdout', phase: 'snapshot' } })],
      },
    },
    {
      name: 'a snapshot phase on a wrapping observation',
      params: {
        probeId: 'x',
        mechanics: { commandId: 'c', args: [], around: 'submit' },
        assertions: [assertion()],
      },
    },
    {
      name: 'a delta phase with no around',
      params: {
        probeId: 'x',
        mechanics: { commandId: 'c', args: [] },
        assertions: [
          assertion({ target: { source: 'jsonPath', path: '$.a', phase: 'delta' } }),
        ],
      },
    },
  ];

  for (const { name, params: bogus } of bad) {
    it(`throws InfraError for ${name}`, async () => {
      const { executor: subject } = executor(new ScriptedRunner(processResult()));

      await expect(
        subject.execute({ criterionId: 'E4-01', surface: 'observation', params: bogus }),
      ).rejects.toThrow(InfraError);
    });
  }
});

describe('redaction at capture (AD-10)', () => {
  const CANARY = 'PAMELA-4-5-CANARY-MUST-NOT-LEAK';

  it('keeps a seeded secret out of every artifact the executor produces', async () => {
    const { executor: subject, evidence } = executor(
      new ScriptedRunner(
        processResult({
          stdout: `AWS_SECRET_ACCESS_KEY=${CANARY}\nnot json`,
          stderr: `Authorization: Bearer ${CANARY}`,
        }),
      ),
    );

    const attempt = await subject.execute(request());

    // ASSERT THE SECRET IS ABSENT, never that [REDACTED] is present: output carrying the
    // marker with the secret still beside it passes a marker-presence test green.
    const everywhere = [
      evidence.everythingPersisted(),
      JSON.stringify(attempt),
      attempt.execError?.message ?? '',
      attempt.execError?.hint ?? '',
    ].join('\n');
    expect(everywhere).not.toContain(CANARY);
  });

  it('redacts the FULL copy handed to the writer, not only the inline evidence', async () => {
    // evidence.ts rule 2: `boundedText` redacts the INLINE copy; a caller writing a full copy
    // MUST pass it through `redactText` first, or the file beside the clean inline evidence
    // carries the credential verbatim while the obvious seeded-secret test passes green over
    // exactly that hole.
    const bulk = ' '.repeat(EVIDENCE_INLINE_CAP_BYTES + 500);
    const { executor: subject, evidence } = executor(
      new ScriptedRunner(processResult({ stdout: `{"count":1,"note":"TOKEN=${CANARY}"}${bulk}` })),
    );

    await subject.execute(request());

    expect(evidence.files.length).toBeGreaterThan(0);
    for (const file of evidence.files) {
      expect(file.contents).not.toContain(CANARY);
    }
  });

  it('keeps a seeded secret out of expected/actual on the derived result', async () => {
    const { executor: subject } = executor(
      new ScriptedRunner(processResult({ stdout: `{"count":"TOKEN=${CANARY}"}` })),
    );

    const derived = deriveCriterionResult(AUTOMATED, [await subject.execute(request())]);

    expect(JSON.stringify(derived)).not.toContain(CANARY);
  });
});

describe('integration with the single derivation (AC1, AC2, AC3)', () => {
  const attemptFor = async (stdout: string, exitCode = 0) => {
    const { executor: subject } = executor(new ScriptedRunner(processResult({ stdout, exitCode })));
    return subject.execute(request());
  };

  it('passes, fails and errors through deriveCriterionResult', async () => {
    expect(deriveCriterionResult(AUTOMATED, [await attemptFor('{"count":1}')]).status).toBe('pass');
    expect(deriveCriterionResult(AUTOMATED, [await attemptFor('{"count":2}')]).status).toBe('fail');
    expect(deriveCriterionResult(AUTOMATED, [await attemptFor('nope')]).status).toBe('error');
  });

  it('marks a pass that only happened on retry as flaky, and a pass-then-fail as fail', async () => {
    const failed = await attemptFor('{"count":2}');
    const passed = await attemptFor('{"count":1}');

    expect(deriveCriterionResult(AUTOMATED, [failed, passed]).flaky).toBe(true);
    const regressed = deriveCriterionResult(AUTOMATED, [passed, failed]);
    expect(regressed.status).toBe('fail');
    expect(regressed.flaky).toBeUndefined();
  });

  it('gives a non-pass result expected, actual and at least one evidence ref (FR-28)', async () => {
    const derived = deriveCriterionResult(AUTOMATED, [await attemptFor('{"count":2}')]);

    expect(derived.status).toBe('fail');
    expect(derived.expected).toBe('1');
    expect(derived.actual).toBe('2');
    expect(derived.evidence?.length).toBeGreaterThan(0);
  });
});
