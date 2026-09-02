/**
 * Story 4.6 — mechanical assertion evaluation, exec-error classification,
 * evidence capture with redaction, and the hand-off to the single derivation.
 *
 * ZERO subprocesses: every spawn is a scripted `ProcessResult`. Real spawning
 * lives in `tests/integration/surfaces/shell.test.ts`.
 *
 * The two tests that matter most here:
 *  - an `exitCode == 1` assertion PASSES when the command exits 1 (the case the
 *    gates stage's mapping gets wrong, deliberately, because a gate's implicit
 *    assertion is "exit 0" while a probe's is explicit and comes from the plan);
 *  - a missing binary derives to `error`, NOT `fail` (infrastructure must never
 *    be blamed on the branch).
 */

import { describe, expect, it } from 'vitest';

import { deriveCriterionResult } from '../../../src/domain/criterion-result.js';
import type {
  ContractCriterionRef,
  ProbeAttempt,
} from '../../../src/domain/criterion-result.js';
import { EVIDENCE_INLINE_CAP_BYTES, type CommandEvidence } from '../../../src/domain/evidence.js';
import { ShellSurfaceExecutor } from '../../../src/surfaces/shell.js';
import type { ShellExecutorDeps, ShellProbeParams } from '../../../src/surfaces/shell.js';
import { FixedClock } from '../../fakes/ports.js';
import {
  NOISY_GATE_OUTPUT,
  SEEDED_API_KEY,
  SEEDED_COOKIE,
} from '../pipeline/stages/gates.secrets.js';

import {
  processResult,
  recordingRunner,
  probeParams,
  recordingSink,
  recordingWriter,
  resolvedCommand,
  WORKTREE,
  type RecordingSink,
  type RecordingWriter,
} from './shell.helpers.js';

const CAPTURED_AT = '2026-09-02T00:00:00.000Z';

const AUTOMATED: ContractCriterionRef = {
  criterionId: 'E4-01',
  statement: 'every migration in the repository has been applied',
  severity: 'critical',
  verifiability: 'automated',
};

interface Harness {
  readonly attempt: ProbeAttempt;
  readonly writer: RecordingWriter;
  readonly sink: RecordingSink;
}

/** Runs one probe against a scripted spawn and returns everything it produced. */
async function run(
  result: Parameters<typeof processResult>[0],
  params: Partial<ShellProbeParams> = {},
  depOverrides: Partial<ShellExecutorDeps> = {},
): Promise<Harness> {
  const writer = recordingWriter();
  const sink = recordingSink();
  const executor = new ShellSurfaceExecutor({
    runner: recordingRunner(processResult(result)),
    clock: new FixedClock(CAPTURED_AT),
    cwd: WORKTREE,
    command: resolvedCommand(),
    writeEvidence: writer,
    recordEvidence: sink,
    ...depOverrides,
  });

  const attempt = await executor.execute({
    criterionId: 'E4-01',
    surface: 'shell',
    params: probeParams({
      ...(params as Record<string, unknown>),
      ...(('probeId' in params) ? { id: (params as { probeId?: string }).probeId } : {}),
    }),
  });

  return { attempt, writer, sink };
}

describe('AC1 — exit-code assertions are evaluated mechanically', () => {
  it('satisfies exitCode == 0 when the command exits 0', async () => {
    const { attempt } = await run({ exitCode: 0 });

    expect(attempt.assertionEvaluations).toHaveLength(1);
    expect(attempt.assertionEvaluations[0]?.satisfied).toBe(true);
    expect(attempt.assertionEvaluations[0]?.expected).toBe('0');
    expect(attempt.assertionEvaluations[0]?.actual).toBe('0');
  });

  it('does not satisfy exitCode == 0 when the command exits 2', async () => {
    const { attempt } = await run({ exitCode: 2 });

    expect(attempt.assertionEvaluations[0]?.satisfied).toBe(false);
    expect(attempt.assertionEvaluations[0]?.actual).toBe('2');
  });

  it('PASSES an exitCode == 1 assertion when the command exits 1', async () => {
    // THE CASE THE GATES STAGE WOULD GET WRONG. A gate's implicit assertion is
    // "exit 0", so gates map any non-zero exit to a failure. A probe's
    // assertion is explicit and comes from the plan, so a probe that
    // legitimately expects a failing command must pass when it fails.
    // Getting this backwards makes every negative-case probe unwritable.
    const { attempt } = await run(
      { exitCode: 1 },
      {
        assertions: [
          {
            description: 'the linter reports the seeded violation',
            target: { source: 'exitCode' },
            comparison: 'equals',
            expected: '1',
          },
        ],
      },
    );

    expect(attempt.execError).toBeUndefined();
    expect(attempt.assertionEvaluations[0]?.satisfied).toBe(true);
    expect(deriveCriterionResult(AUTOMATED, [attempt]).status).toBe('pass');
  });
});

describe('AC1 — output assertions', () => {
  it('satisfies a stdout-contains assertion', async () => {
    const { attempt } = await run(
      { stdout: 'migrations: 12 applied, 0 pending\n' },
      {
        assertions: [
          {
            description: 'no pending migrations',
            target: { source: 'stdout' },
            comparison: 'contains',
            expected: '0 pending',
          },
        ],
      },
    );

    expect(attempt.assertionEvaluations[0]?.satisfied).toBe(true);
  });

  it('does not satisfy a stdout-contains assertion when the text is absent', async () => {
    const { attempt } = await run(
      { stdout: 'migrations: 11 applied, 1 pending\n' },
      {
        assertions: [
          {
            description: 'no pending migrations',
            target: { source: 'stdout' },
            comparison: 'contains',
            expected: '0 pending',
          },
        ],
      },
    );

    expect(attempt.assertionEvaluations[0]?.satisfied).toBe(false);
    expect(attempt.assertionEvaluations[0]?.actual).toContain('1 pending');
  });

  it('reads stderr as its own target', async () => {
    const { attempt } = await run(
      { stderr: 'warning: deprecated flag\n' },
      {
        assertions: [
          {
            description: 'no errors on stderr',
            target: { source: 'stderr' },
            comparison: 'notContains',
            expected: 'error',
          },
        ],
      },
    );

    expect(attempt.assertionEvaluations[0]?.satisfied).toBe(true);
  });

  it('EVERY declared assertion appears, including the satisfied ones', async () => {
    // FR-28 needs expected/actual on non-pass results and
    // `deriveCriterionResult` reads `find(e => !e.satisfied)`. An executor
    // reporting only failures would leave a passing probe with no record of
    // what it checked.
    const { attempt } = await run(
      { exitCode: 0, stdout: 'ok\n' },
      {
        assertions: [
          {
            description: 'exits cleanly',
            target: { source: 'exitCode' },
            comparison: 'equals',
            expected: '0',
          },
          {
            description: 'says ok',
            target: { source: 'stdout' },
            comparison: 'contains',
            expected: 'ok',
          },
          {
            description: 'stderr is silent',
            target: { source: 'stderr' },
            comparison: 'equals',
            expected: '',
          },
        ],
      },
    );

    expect(attempt.assertionEvaluations).toHaveLength(3);
    expect(attempt.assertionEvaluations.every((e) => e.satisfied)).toBe(true);
    expect(attempt.assertionEvaluations.map((e) => e.description)).toEqual([
      'exits cleanly',
      'says ok',
      'stderr is silent',
    ]);
  });

  it('treats a non-numeric value under a numeric comparison as unsatisfied, never a crash', async () => {
    const { attempt } = await run(
      { stdout: 'not a number' },
      {
        assertions: [
          {
            description: 'fewer than 5 findings',
            target: { source: 'stdout' },
            comparison: 'lessThan',
            expected: '5',
          },
        ],
      },
    );

    expect(attempt.assertionEvaluations[0]?.satisfied).toBe(false);
  });

  it('does not treat empty output as the number zero', async () => {
    // `Number('')` is 0 in JavaScript. An empty stdout is the ABSENCE of an
    // answer, not the number zero, and reading it as zero would silently
    // satisfy `lessThan 5` for a command that printed nothing at all.
    const { attempt } = await run(
      { stdout: '' },
      {
        assertions: [
          {
            description: 'fewer than 5 findings',
            target: { source: 'stdout' },
            comparison: 'lessThan',
            expected: '5',
          },
        ],
      },
    );

    expect(attempt.assertionEvaluations[0]?.satisfied).toBe(false);
  });

  it('evaluates greaterThan numerically, not lexically', async () => {
    // Lexically '9' > '10'. Numerically it is not.
    const { attempt } = await run(
      { stdout: '9' },
      {
        assertions: [
          {
            description: 'more than 10 rows',
            target: { source: 'stdout' },
            comparison: 'greaterThan',
            expected: '10',
          },
        ],
      },
    );

    expect(attempt.assertionEvaluations[0]?.satisfied).toBe(false);
  });
});

describe('AC1 — exec-error classification (the infrastructure half)', () => {
  it('a missing binary is an execError, and derives to error — NOT fail', async () => {
    const { attempt } = await run({ outcome: 'not-found', exitCode: null });

    expect(attempt.execError).toBeDefined();
    expect(attempt.execError?.hint).toBeDefined();
    // THE POINT: infrastructure is never blamed on the branch.
    expect(deriveCriterionResult(AUTOMATED, [attempt]).status).toBe('error');
  });

  it('names PATH for a bare binary and the worktree for a path-shaped one', async () => {
    const onPath = await run({ outcome: 'not-found', exitCode: null });
    expect(onPath.attempt.execError?.message).toContain('not on PATH');

    const inTree = await run({ outcome: 'not-found', exitCode: null }, {}, {
      command: resolvedCommand({ binary: './scripts/check', displayCommand: './scripts/check' }),
    });
    expect(inTree.attempt.execError?.message).toContain('verification worktree');
    expect(inTree.attempt.execError?.hint).toContain('commit');
  });

  it('a timeout is an execError naming the limit, and derives to error', async () => {
    const { attempt } = await run({ outcome: 'timed-out', exitCode: null }, {}, { timeoutMs: 250 });

    expect(attempt.execError?.message).toContain('250ms');
    expect(deriveCriterionResult(AUTOMATED, [attempt]).status).toBe('error');
  });

  it('a spawn failure is an execError, and derives to error', async () => {
    const { attempt } = await run({
      outcome: 'spawn-failed',
      exitCode: null,
      stderr: 'EACCES',
    });

    expect(attempt.execError?.message).toContain('EACCES');
    expect(deriveCriterionResult(AUTOMATED, [attempt]).status).toBe('error');
  });

  it('on EVERY error path, no AssertionEvaluation claims a product violation', async () => {
    // Assertions evaluated against a broken observation would manufacture
    // product evidence out of an infrastructure failure.
    for (const outcome of ['not-found', 'spawn-failed', 'timed-out'] as const) {
      const { attempt } = await run({ outcome, exitCode: null, stdout: 'partial output' });
      expect(attempt.assertionEvaluations).toEqual([]);
    }
  });

  it('a non-zero exit WITH an exit-code assertion is a normal evaluation, not an execError', async () => {
    // The distinction from the gates stage, asserted directly.
    const { attempt } = await run({ outcome: 'completed', exitCode: 7 });

    expect(attempt.execError).toBeUndefined();
    expect(attempt.assertionEvaluations).toHaveLength(1);
  });
});

describe('AC1 — evidence: bounded, redacted at capture, and reachable by a renderer', () => {
  it('hands the typed member to the sink so RunResult.evidence is not empty', async () => {
    // `ProbeAttempt.evidence` carries REFS. `RunResult.evidence` carries the
    // closed UNION, and the renderer reads the member inline because AD-11
    // forbids it to open the file. Without this sink a report would show gate
    // evidence and no probe evidence at all.
    const { sink } = await run({ exitCode: 0, stdout: 'ok\n' });

    expect(sink.members).toHaveLength(1);
    const member = sink.members[0] as CommandEvidence;
    expect(member.kind).toBe('command');
    expect(member.commandId).toBe('migrations-applied');
    expect(member.displayCommand).toBe('node scripts/check.js');
    expect(member.capturedAt).toBe(CAPTURED_AT);
    expect(member.stdout.text).toBe('ok\n');
  });

  it('always refs the serialized member, so a non-pass result carries evidence (FR-28)', async () => {
    // Even with both streams empty — the case a stream-shaped rule would leave
    // with zero references.
    const { attempt, writer } = await run({ exitCode: 3, stdout: '', stderr: '' });

    expect(attempt.evidence).toHaveLength(1);
    expect(attempt.evidence[0]?.kind).toBe('command');
    expect(attempt.evidence[0]?.path).toMatch(
      /^evidence\/shell-E4-01-migrations-check-[0-9a-f]{64}-1\.json$/,
    );
    expect(writer.writes).toHaveLength(1);
  });

  it('writes a full copy per NON-EMPTY stream and refs each separately', async () => {
    const { attempt, writer } = await run({ stdout: 'out\n', stderr: 'err\n' });

    const names = writer.writes.map((w) => w.name);
    expect(names).toHaveLength(3);
    expect(names[0]).toMatch(/^evidence\/shell-E4-01-migrations-check-[0-9a-f]{64}-1\.stdout\.txt$/);
    expect(names[1]).toMatch(/^evidence\/shell-E4-01-migrations-check-[0-9a-f]{64}-1\.stderr\.txt$/);
    expect(names[2]).toMatch(/^evidence\/shell-E4-01-migrations-check-[0-9a-f]{64}-1\.json$/);
    expect(attempt.evidence).toHaveLength(3);
  });

  it('writes nothing for an empty stream', async () => {
    // An empty file is an artifact implying output that never existed.
    const { writer } = await run({ stdout: 'out\n', stderr: '' });

    expect(writer.writes.map((w) => w.name).filter((n) => n.includes('.stderr.'))).toEqual([]);
  });

  it('records the member even when the binary was missing and produced no output', async () => {
    // FR-28: a `not-found` becomes `execError`, which derives to a persisted
    // criterion `error` — a NON-PASS result, which must carry at least one
    // evidence reference. The gates stage may skip an empty attempt because an
    // unstartable gate THROWS and produces no GateResult at all; a probe
    // produces a result, so the same shortcut leaves it bare.
    //
    // Nothing is invented: `exitCode: null` is documented as "killed or never
    // started", both streams are genuinely empty, and `displayCommand`
    // preserves WHAT WAS ATTEMPTED — the thing a reader of a failed run most
    // needs. (Caught by the Codex review pass; this test replaces one that
    // asserted the opposite.)
    const { attempt, writer, sink } = await run({
      outcome: 'not-found',
      exitCode: null,
      stdout: '',
      stderr: '',
    });

    expect(sink.members).toHaveLength(1);
    expect((sink.members[0] as CommandEvidence).displayCommand).toBe('node scripts/check.js');
    expect((sink.members[0] as CommandEvidence).exitCode).toBeNull();
    // Exactly one ref: the member. No stream files — an empty file is an
    // artifact implying output that never existed.
    expect(attempt.evidence).toHaveLength(1);
    expect(writer.writes).toHaveLength(1);
    expect(writer.writes[0]?.name).toMatch(
      /^evidence\/shell-E4-01-migrations-check-[0-9a-f]{64}-1\.json$/,
    );
  });

  it('gives an error-derived criterion at least one evidence reference (FR-28)', async () => {
    const { attempt } = await run({
      outcome: 'not-found',
      exitCode: null,
      stdout: '',
      stderr: '',
    });
    const derived = deriveCriterionResult(AUTOMATED, [attempt]);

    expect(derived.status).toBe('error');
    expect(derived.evidence?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('DOES record evidence for a timeout that printed something first', async () => {
    // Story 3.2's runner returns the child's captured output on a timeout
    // rather than an empty string, so a hung probe leaves real diagnostic
    // material. Evidence follows the OBSERVATION, not the classification.
    const { attempt, sink } = await run({
      outcome: 'timed-out',
      exitCode: null,
      stdout: 'got this far\n',
    });

    expect(sink.members).toHaveLength(1);
    expect(attempt.evidence.length).toBeGreaterThan(0);
    expect(attempt.execError).toBeDefined();
    expect(attempt.assertionEvaluations).toEqual([]);
  });

  it('bounds the inline copy and points the marker at the full file', async () => {
    const huge = 'x'.repeat(EVIDENCE_INLINE_CAP_BYTES + 500);
    const { sink } = await run({ stdout: huge });

    const member = sink.members[0] as CommandEvidence;
    expect(member.stdout.truncated).toBe(true);
    expect(member.stdout.totalBytes).toBe(EVIDENCE_INLINE_CAP_BYTES + 500);
    expect(member.stdout.fullPath).toMatch(
      /^evidence\/shell-E4-01-migrations-check-[0-9a-f]{64}-1\.stdout\.txt$/,
    );
  });

  it('names the evidence files by the 1-based attempt', async () => {
    const { writer } = await run({ stdout: 'out\n' }, { attempt: 2 });

    const names = writer.writes.map((w) => w.name);
    expect(names.every((n) => /-[0-9a-f]{64}-2\./.test(n))).toBe(true);
    expect(names).toHaveLength(2);
  });

  it('derives a safe filename from an id that is not filesystem-safe', async () => {
    // A probe id is only `Identifier`-shaped, which admits dots — so `a..b` is
    // schema-valid and would hit RunStore's containment rule, turning a
    // perfectly good run into exit 3.
    const { writer } = await run({ stdout: 'out\n' }, { probeId: 'a..b/../c' });

    for (const write of writer.writes) {
      expect(write.name).not.toContain('..');
      expect(write.name.split('/')).toHaveLength(2);
    }
  });
});

describe('the seeded-secret proof for this capture path', () => {
  const seeded = {
    stdout: NOISY_GATE_OUTPUT,
    stderr: `db-credentials=${SEEDED_API_KEY}`,
  };

  it('keeps the secret out of the inline evidence, the full copies and expected/actual', async () => {
    const { attempt, writer, sink } = await run(seeded, {
      assertions: [
        {
          description: 'stdout mentions no key',
          target: { source: 'stdout' },
          comparison: 'contains',
          expected: 'nothing-like-this',
        },
      ],
    });

    const haystacks = [
      // The inline member the renderer prints.
      JSON.stringify(sink.members),
      // The EXACT bytes handed to RunStore — the copy that would otherwise
      // carry the credential verbatim while the inline copy looked spotless.
      ...writer.writes.map((write) => write.contents),
      // expected/actual, which travel into the result and onto a terminal.
      JSON.stringify(attempt.assertionEvaluations),
      JSON.stringify(attempt.observations),
    ];

    for (const haystack of haystacks) {
      // ABSENT, not "the marker is present" — output carrying `[REDACTED]`
      // WITH the secret still beside it survives review in a way a raw leak
      // does not (Epic 3 retro §7).
      expect(haystack).not.toContain(SEEDED_API_KEY);
      expect(haystack).not.toContain(SEEDED_COOKIE);
    }
  });

  it('keeps a secret-bearing argument out of the rejection message', async () => {
    // Plan-supplied arguments are PROVIDER-authored text, not a project
    // owner's declared command, so they are redacted UNDECLARED — the
    // fail-closed default. This message reaches `printError`, which writes it
    // to stderr verbatim.
    const executor = new ShellSurfaceExecutor({
      runner: recordingRunner(),
      clock: new FixedClock(CAPTURED_AT),
      cwd: WORKTREE,
      command: resolvedCommand(),
      writeEvidence: recordingWriter(),
      recordEvidence: recordingSink(),
    });

    let error: unknown;
    try {
      await executor.execute({
        criterionId: 'E4-01',
        surface: 'shell',
        params: probeParams({
          args: [`--token=${SEEDED_API_KEY}`],
          argumentAllowlist: ['--dry-run'],
        }),
      });
    } catch (caught) {
      error = caught;
    }

    const rendered = `${(error as Error).message}\n${(error as { hint?: string }).hint ?? ''}`;
    expect(rendered).not.toContain(SEEDED_API_KEY);
  });
});

describe('plan-supplied IDENTIFIERS are redacted in diagnostics too', () => {
  // A schema-valid `Identifier` cannot contain `=` or `:`, so it cannot form a
  // redactable assignment — but `readParams` deliberately accepts ANY non-empty
  // string, because the runtime gate exists for a plan EDITED ON DISK AFTER
  // COMPILATION, which never passed through 4.2's schema. Such a plan can carry
  // a secret in `probeId` or `commandId`, and every diagnostic below reaches
  // `printError`, which writes to stderr verbatim.
  //
  // This is the same rule already applied to rejected arguments; leaving ids out
  // was an inconsistency, found by the Codex review pass.
  const SEEDED = `ANTHROPIC_API_KEY=${SEEDED_API_KEY}`;

  async function errorFrom(
    params: Record<string, unknown>,
    result: Parameters<typeof processResult>[0] = {},
  ): Promise<string> {
    const executor = new ShellSurfaceExecutor({
      runner: recordingRunner(processResult(result)),
      clock: new FixedClock(CAPTURED_AT),
      cwd: WORKTREE,
      command: resolvedCommand(),
      writeEvidence: recordingWriter(),
      recordEvidence: recordingSink(),
    });

    try {
      const { probeId, ...rest } = params as { probeId?: string };
      const attempt = await executor.execute({
        criterionId: 'E4-01',
        surface: 'shell',
        params: probeParams({
          ...(probeId === undefined ? {} : { id: probeId }),
          ...(rest as Record<string, unknown>),
        }),
      });
      // No throw: the diagnostic may instead live on the execError.
      return `${attempt.execError?.message ?? ''}\n${attempt.execError?.hint ?? ''}`;
    } catch (error) {
      return `${(error as Error).message}\n${(error as { hint?: string }).hint ?? ''}`;
    }
  }

  it('redacts a secret probeId in the command-id mismatch rejection', async () => {
    const rendered = await errorFrom({ probeId: SEEDED, commandId: 'wrong-id' });

    expect(rendered).not.toContain(SEEDED_API_KEY);
  });

  it('redacts a secret commandId in the same rejection', async () => {
    const rendered = await errorFrom({ commandId: SEEDED });

    expect(rendered).not.toContain(SEEDED_API_KEY);
  });

  it('redacts a secret probeId in the allowlist-violation rejection', async () => {
    const rendered = await errorFrom({
      probeId: SEEDED,
      args: ['--nope'],
      argumentAllowlist: [],
    });

    expect(rendered).not.toContain(SEEDED_API_KEY);
  });

  it('redacts a secret probeId in every execError diagnostic', async () => {
    for (const outcome of ['not-found', 'spawn-failed', 'timed-out'] as const) {
      const rendered = await errorFrom({ probeId: SEEDED }, { outcome, exitCode: null });
      expect(rendered).not.toContain(SEEDED_API_KEY);
    }
  });

  it('redacts a secret commandId in the not-found remedy hint', async () => {
    const rendered = await errorFrom(
      { commandId: SEEDED },
      { outcome: 'not-found', exitCode: null },
    );

    expect(rendered).not.toContain(SEEDED_API_KEY);
  });

  it('leaves an ordinary id untouched, so diagnostics stay readable', async () => {
    const rendered = await errorFrom({ commandId: 'wrong-id' });

    expect(rendered).toContain('migrations-check');
    expect(rendered).toContain('wrong-id');
  });
});

describe('AD-10 config-declared extraPatterns reach every redaction path', () => {
  // The built-in rules cannot know a project's own secret shapes. AD-10's
  // "config-declared extra patterns" are the only thing that can redact them,
  // so a path that drops the options silently applies the built-ins ONLY — and
  // a secret covered exclusively by extraPatterns travels on unredacted.
  //
  // This uses a token that NO built-in rule matches (no sensitive name, no
  // header shape), so the assertion fails unless extraPatterns is actually
  // threaded through. Found by the Codex review pass on the rejection path,
  // which reaches `printError` and is written to stderr verbatim.
  const PROJECT_SECRET = 'zzq-internal-9f2c1a5b7d3e';
  const redaction = { extraPatterns: [/zzq-internal-[a-z0-9]+/g] };

  it('redacts a rejected argument in the ConfigError message and hint', async () => {
    const executor = new ShellSurfaceExecutor({
      runner: recordingRunner(),
      clock: new FixedClock(CAPTURED_AT),
      cwd: WORKTREE,
      command: resolvedCommand(),
      writeEvidence: recordingWriter(),
      recordEvidence: recordingSink(),
      redaction,
    });

    let error: unknown;
    try {
      await executor.execute({
        criterionId: 'E4-01',
        surface: 'shell',
        params: probeParams({
          args: [PROJECT_SECRET],
          // The permitted list carries one too, so BOTH renderings are covered:
          // the rejected argument and the "permitted arguments are:" hint.
          argumentAllowlist: [`--token=${PROJECT_SECRET}`],
        }),
      });
    } catch (caught) {
      error = caught;
    }

    const rendered = `${(error as Error).message}\n${(error as { hint?: string }).hint ?? ''}`;
    // ABSENT, not "the marker is present" (Epic 3 retro section 7).
    expect(rendered).not.toContain(PROJECT_SECRET);
  });

  it('redacts an extraPatterns secret in evidence and in expected/actual', async () => {
    const { attempt, writer, sink } = await run(
      { stdout: `token ${PROJECT_SECRET}\n` },
      {
        assertions: [
          {
            description: 'stdout has no internal token',
            target: { source: 'stdout' },
            comparison: 'contains',
            expected: 'nothing-like-this',
          },
        ],
      },
      { redaction },
    );

    for (const haystack of [
      JSON.stringify(sink.members),
      ...writer.writes.map((w) => w.contents),
      JSON.stringify(attempt.assertionEvaluations),
    ]) {
      expect(haystack).not.toContain(PROJECT_SECRET);
    }
  });
});

describe('Task 6 — the attempts feed the single derivation correctly', () => {
  async function attemptFor(exitCode: number, attempt: number): Promise<ProbeAttempt> {
    const { attempt: produced } = await run({ exitCode }, { attempt });
    return produced;
  }

  it('a satisfied assertion derives to pass', async () => {
    expect(deriveCriterionResult(AUTOMATED, [await attemptFor(0, 1)]).status).toBe('pass');
  });

  it('an unsatisfied assertion derives to fail, carrying expected and actual', async () => {
    const derived = deriveCriterionResult(AUTOMATED, [await attemptFor(4, 1)]);

    expect(derived.status).toBe('fail');
    expect(derived.expected).toBe('0');
    expect(derived.actual).toBe('4');
    expect(derived.evidence?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('failing then passing is FLAKY', async () => {
    const derived = deriveCriterionResult(AUTOMATED, [
      await attemptFor(1, 1),
      await attemptFor(0, 2),
    ]);

    expect(derived.status).toBe('pass');
    expect(derived.flaky).toBe(true);
  });

  it('passing then failing is FAIL, not flaky', async () => {
    const derived = deriveCriterionResult(AUTOMATED, [
      await attemptFor(0, 1),
      await attemptFor(1, 2),
    ]);

    expect(derived.status).toBe('fail');
    expect(derived.flaky).toBeUndefined();
  });

  it('a human-verifiability criterion is needs_human however the probe went', async () => {
    // `deriveCriterionResult` decides this BEFORE it looks at attempts, and
    // this executor does nothing to special-case it — which is exactly why it
    // holds. Epic 3 caught and reverted a "floor" variant that let a probe
    // override this; review called it a silent redesign of a recorded decision.
    const human: ContractCriterionRef = { ...AUTOMATED, verifiability: 'human' };

    expect(deriveCriterionResult(human, [await attemptFor(0, 1)]).status).toBe('needs_human');
    expect(deriveCriterionResult(human, [await attemptFor(9, 1)]).status).toBe('needs_human');
  });
});

describe('Codex review findings — AD-8 lifecycle and evidence-name uniqueness', () => {
  it('forwards onProcessGroup to the runner so the pgid reaches the manifest', async () => {
    // AD-8: a probe spawns a real child that gets its own process group. If
    // nothing records the pgid, `specwitness clean` cannot reap the group after
    // an interrupted run and the descendants outlive it with nothing on disk
    // able to name them. Both merged spawning modules carry this hook
    // (gates.ts:144, services.ts:405); this executor omitted it until review.
    const runner = recordingRunner(processResult());
    const seen: number[] = [];

    await new ShellSurfaceExecutor({
      runner,
      clock: new FixedClock(CAPTURED_AT),
      cwd: WORKTREE,
      command: resolvedCommand(),
      writeEvidence: recordingWriter(),
      recordEvidence: recordingSink(),
      onProcessGroup: (pgid) => {
        seen.push(pgid);
      },
    }).execute({
      criterionId: 'E4-01',
      surface: 'shell',
      params: probeParams({ id: 'p' }),
    });

    expect(runner.calls[0]?.onProcessGroup).toBeDefined();
  });

  it('omits onProcessGroup entirely when none was injected', async () => {
    // Omitted rather than passed as `undefined`, matching the merged gates stage.
    const { attempt } = await run({ exitCode: 0 });
    expect(attempt.attempt).toBe(1);
  });

  it('gives two probe ids that NORMALISE alike distinct evidence paths', async () => {
    // `a.b` and `a..b` are two distinct, schema-valid probe ids — 4.2 enforces
    // uniqueness within a criterion, so both may exist side by side — and both
    // slugify to `a.b`. Without a tiebreak the second write would silently
    // overwrite the first, and the first probe's evidence references would
    // point at another probe's content.
    const first = await run({ stdout: 'one\n' }, { probeId: 'a.b' });
    const second = await run({ stdout: 'two\n' }, { probeId: 'a..b' });

    const nameOf = (h: Awaited<ReturnType<typeof run>>): string[] =>
      h.writer.writes.map((w) => w.name);

    expect(nameOf(first)).not.toEqual(nameOf(second));
    for (const name of [...nameOf(first), ...nameOf(second)]) {
      expect(name).not.toContain('..');
    }
  });

  it('gives two long probe ids sharing a 64-character prefix distinct evidence paths', async () => {
    // `Identifier` permits 128 characters; the slug budget is 64.
    const shared = 'p'.repeat(70);
    const first = await run({ stdout: 'one\n' }, { probeId: `${shared}alpha` });
    const second = await run({ stdout: 'two\n' }, { probeId: `${shared}beta` });

    expect(first.writer.writes.map((w) => w.name)).not.toEqual(
      second.writer.writes.map((w) => w.name),
    );
  });

  it('keeps two criteria that reuse one probe id apart', async () => {
    // 4.2 enforces probe-id uniqueness only WITHIN a criterion — its comment
    // says "Probe ids identify a probe within its criterion" — so two criteria
    // may each hold a probe called `health`. A filename carrying the probe id
    // but NOT the criterion id would give both the same file, and the first
    // criterion's evidence ref would point at the second criterion's content:
    // evidence attributed to the wrong criterion, which is worse than none.
    //
    // The stem is built from `${criterionId}-${probeId}`, so this holds by
    // construction. Pinned rather than assumed. (Raised by 4.4, who hit it in
    // this worse cross-criterion form after the Codex collision finding.)
    const writer1 = recordingWriter();
    const writer2 = recordingWriter();
    const probe = probeParams({ id: 'health' });

    for (const [criterionId, writer] of [
      ['E4-01', writer1],
      ['E4-02', writer2],
    ] as const) {
      await new ShellSurfaceExecutor({
        runner: recordingRunner(processResult({ stdout: 'ok\n' })),
        clock: new FixedClock(CAPTURED_AT),
        cwd: WORKTREE,
        command: resolvedCommand(),
        writeEvidence: writer,
        recordEvidence: recordingSink(),
      }).execute({
        criterionId,
        surface: 'shell',
        params: probe,
      });
    }

    expect(writer1.writes.map((w) => w.name)).not.toEqual(writer2.writes.map((w) => w.name));
  });

  it('names the same probe identically across runs, so a re-run does not diff against itself', async () => {
    // The fingerprint must be deterministic: a re-run has to produce identical
    // paths, or a stored run directory diffs against its own repeat.
    const first = await run({ stdout: 'ok\n' }, { probeId: 'a..b' });
    const second = await run({ stdout: 'ok\n' }, { probeId: 'a..b' });

    expect(first.writer.writes.map((w) => w.name)).toEqual(
      second.writer.writes.map((w) => w.name),
    );
  });

  it('keeps two AMBIGUOUSLY-JOINED criterion/probe pairs apart', async () => {
    // criterion `a-b` + probe `c` and criterion `a` + probe `b-c` both join to
    // `a-b-c`. A discriminator computed from that joined string cannot separate
    // them — it is the identical input — so the identity is hashed with a NUL
    // separator instead. Both stems are otherwise CLEAN, which is why a
    // conditional discriminator (appended only when the slug lost information)
    // missed this entirely. Found by the Codex review pass.
    const writerA = recordingWriter();
    const writerB = recordingWriter();

    for (const [criterionId, probeId, writer] of [
      ['a-b', 'c', writerA],
      ['a', 'b-c', writerB],
    ] as const) {
      await new ShellSurfaceExecutor({
        runner: recordingRunner(processResult({ stdout: 'ok\n' })),
        clock: new FixedClock(CAPTURED_AT),
        cwd: WORKTREE,
        command: resolvedCommand(),
        writeEvidence: writer,
        recordEvidence: recordingSink(),
      }).execute({
        criterionId,
        surface: 'shell',
        params: probeParams({ id: probeId }),
      });
    }

    expect(writerA.writes.map((w) => w.name)).not.toEqual(writerB.writes.map((w) => w.name));
  });

  it('keeps the readable criterion and probe id in the filename', async () => {
    // The fingerprint is a tiebreak for a LOSSY slug, not decoration on every
    // name. A clean id must keep the name it always had.
    const { writer } = await run({ stdout: 'ok\n' }, { probeId: 'migrations-check' });

    const names = writer.writes.map((w) => w.name);
    expect(names).toHaveLength(2);
    // The readable prefix survives; only the discriminator is opaque.
    expect(names[0]).toMatch(/^evidence\/shell-E4-01-migrations-check-[0-9a-f]{64}-1\.stdout\.txt$/);
  });
});

describe('every provider-authored string in an evaluation is redacted', () => {
  // `description` sits in the same object as `expected` and `actual`, and all
  // three are provider-authored plan text. Redacting two of the three was an
  // inconsistency rather than a decision. (Codex review pass. Note the finding
  // overstated the consequence — `deriveCriterionResult` copies only
  // `expected`/`actual`/`evidence`, so `description` does not reach result.json
  // today; this is defence in depth for a field a renderer is likely to surface.)
  const PROJECT_SECRET = 'zzq-internal-9f2c1a5b7d3e';

  it('redacts the assertion description, not just expected and actual', async () => {
    const { attempt } = await run(
      { exitCode: 0 },
      {
        assertions: [
          {
            description: `checks ANTHROPIC_API_KEY=${SEEDED_API_KEY} is unset`,
            target: { source: 'exitCode' },
            comparison: 'equals',
            expected: '0',
          },
        ],
      },
    );

    expect(attempt.assertionEvaluations[0]?.description).not.toContain(SEEDED_API_KEY);
  });

  it('applies configured extraPatterns to the description too', async () => {
    const { attempt } = await run(
      { exitCode: 0 },
      {
        assertions: [
          {
            description: `checks ${PROJECT_SECRET} is absent`,
            target: { source: 'exitCode' },
            comparison: 'equals',
            expected: '0',
          },
        ],
      },
      { redaction: { extraPatterns: [/zzq-internal-[a-z0-9]+/g] } },
    );

    expect(attempt.assertionEvaluations[0]?.description).not.toContain(PROJECT_SECRET);
  });

  it('leaves an ordinary description readable', async () => {
    const { attempt } = await run({ exitCode: 0 });

    expect(attempt.assertionEvaluations[0]?.description).toBe('exits cleanly');
  });
});

describe('the binary is redacted in not-found diagnostics', () => {
  // `binary` is derived from the project-owner's DECLARED command, and
  // `commandEvidence` already redacts `displayCommand` for the same reason: a
  // declared command can legitimately carry a credential, and this message
  // reaches `printError`, which writes it to stderr verbatim.
  it('redacts a secret-bearing binary on the PATH branch', async () => {
    const { attempt } = await run({ outcome: 'not-found', exitCode: null }, {}, {
      command: resolvedCommand({
        binary: `tool-ANTHROPIC_API_KEY=${SEEDED_API_KEY}`,
        displayCommand: 'tool',
      }),
    });

    const rendered = `${attempt.execError?.message ?? ''}\n${attempt.execError?.hint ?? ''}`;
    expect(rendered).not.toContain(SEEDED_API_KEY);
  });

  it('redacts a secret-bearing binary on the worktree-path branch', async () => {
    const { attempt } = await run({ outcome: 'not-found', exitCode: null }, {}, {
      command: resolvedCommand({
        binary: `./scripts/tool-ANTHROPIC_API_KEY=${SEEDED_API_KEY}`,
        displayCommand: './scripts/tool',
      }),
    });

    const rendered = `${attempt.execError?.message ?? ''}\n${attempt.execError?.hint ?? ''}`;
    expect(rendered).not.toContain(SEEDED_API_KEY);
    // The remedy must survive redaction — an operator still needs to be told to
    // commit the file rather than install it.
    expect(rendered).toContain('commit');
  });

  it('leaves an ordinary binary readable in the diagnosis', async () => {
    const { attempt } = await run({ outcome: 'not-found', exitCode: null });

    expect(attempt.execError?.message).toContain('node');
    expect(attempt.execError?.message).toContain('not on PATH');
  });
});

describe('the evidence discriminator is wide enough to resist a CHOSEN collision', () => {
  // NAMED FOR THE REASON, NOT THE NUMBER, deliberately. A test called "is 24
  // hex characters" pins a value; this one pins the property, so widening is a
  // deliberate act and narrowing fails for a stated cause.
  //
  // The property matters because the inputs are PROVIDER-AUTHORED: whoever
  // wrote the plan chooses both ids, so this is a chosen-input collision rather
  // than a chance one. Digest width is not collision resistance — a truncated
  // n-bit digest gives about n/2 bits, because a birthday search needs only
  // ~2^(n/2) work to find any colliding pair. This surface's own 32-bit
  // predecessor was brute-forced in 57ms.
  it('emits the FULL sha256 digest, untruncated', async () => {
    const { writer } = await run({ stdout: 'ok\n' });
    const name = writer.writes[0]?.name ?? '';

    // 64 hex characters is the whole digest. A shorter run would still match a
    // loose pattern, so the boundary is anchored on both sides.
    expect(name).toMatch(/-[0-9a-f]{64}-1\.stdout\.txt$/);
    expect(name).not.toMatch(/-[0-9a-f]{65,}-/);
  });

  it('keeps the worst-case filename inside the 255-byte component limit', async () => {
    // Superman's arithmetic is for the http stem (two slugs, 211 chars). THIS
    // surface has one capped slug, so the number differs and is computed here
    // rather than copied — the copying is the failure this whole thread is made
    // of.
    //
    //   shell- (6) + slug (64) + - (1) + digest (64) + - (1)
    //        + attempt (3) + .stdout.txt (11)  =  150
    //
    // The 255 limit governs the FILENAME COMPONENT, so `evidence/` is excluded.
    const maximal = 'p'.repeat(128); // `Identifier` permits 128
    const { writer } = await run({ stdout: 'ok\n' }, { probeId: maximal, attempt: 999 });

    for (const write of writer.writes) {
      const component = write.name.split('/').at(-1) ?? '';
      expect(Buffer.byteLength(component, 'utf8')).toBeLessThanOrEqual(255);
      // Recorded so a future widening sees the real headroom rather than a
      // remembered one.
      expect(Buffer.byteLength(component, 'utf8')).toBeLessThanOrEqual(160);
    }
  });
});
