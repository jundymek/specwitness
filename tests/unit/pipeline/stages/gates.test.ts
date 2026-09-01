import { describe, expect, it } from 'vitest';

import { InfraError } from '../../../../src/domain/errors.js';
import { EVIDENCE_INLINE_CAP_BYTES, type GateEvidence } from '../../../../src/domain/evidence.js';
import { createGatesStage } from '../../../../src/pipeline/stages/gates.js';
import {
  declaredGates,
  processResult,
  recordingRunner,
  recordingWriter,
  infraErrorFrom,
  stageContext,
  WORKTREE,
  type RecordingRunner,
  type RecordingWriter,
} from './gates.helpers.js';
import { NOISY_GATE_OUTPUT, SEEDED_API_KEY, SEEDED_COOKIE } from './gates.secrets.js';

/**
 * Story 3.4 — the deterministic gates stage.
 *
 * The whole story is one classification table, and the reason it is specified
 * so tightly is AC3: every other stage in this epic can be wrong in a way an
 * operator notices; this one can be wrong in a way that looks completely
 * normal. A missing binary reported as FAIL blocks a mergeable branch, or sends
 * a developer hunting a defect that does not exist. So every assertion about a
 * negative outcome also asserts the ABSENCE of the wrong answer.
 */

const PASS = 'node -e process.exit(0)';

function deps(
  runner: RecordingRunner,
  writer: RecordingWriter = recordingWriter(),
  gates = declaredGates([{ id: 'lint', run: PASS }]),
) {
  return { gates, runner, writeEvidence: writer };
}

describe('gates stage: AC1 — ordered execution in the worktree', () => {
  it('runs every declared gate in declaration order and reports pass', async () => {
    const runner = recordingRunner(processResult(), processResult(), processResult());
    const gates = declaredGates([
      { id: 'install', run: 'pnpm install' },
      { id: 'lint', run: 'pnpm lint' },
      { id: 'build', run: 'pnpm build' },
    ]);
    const context = stageContext();

    const result = await createGatesStage({
      gates,
      runner,
      writeEvidence: recordingWriter(),
    }).run(context);

    expect(result.status).toBe('ok');
    expect(context.run.gates.map((gate) => gate.gateId)).toEqual(['install', 'lint', 'build']);
    expect(context.run.gates.every((gate) => gate.status === 'pass')).toBe(true);
    expect(runner.calls.map((call) => call.binary)).toEqual(['pnpm', 'pnpm', 'pnpm']);
    expect(runner.calls.map((call) => call.args)).toEqual([['install'], ['lint'], ['build']]);
  });

  it('records an integer duration taken from the runner, not a second clock read', async () => {
    const runner = recordingRunner(processResult({ durationMs: 1234 }));
    const context = stageContext();

    await createGatesStage(deps(runner)).run(context);

    expect(context.run.gates[0]?.durationMs).toBe(1234);
    expect(Number.isInteger(context.run.gates[0]?.durationMs)).toBe(true);
  });

  it('spawns in the WORKTREE, never in the source repo', async () => {
    // A gate spawned in the source repo silently verifies the wrong tree and
    // may write into the operator's working directory (AD-8).
    const runner = recordingRunner(processResult());

    await createGatesStage(deps(runner)).run(stageContext());

    expect(runner.calls[0]?.cwd).toBe(WORKTREE);
    expect(runner.calls[0]?.cwd).not.toBe(process.cwd());
  });

  it('passes the constructed environment, not process.env merged over it', async () => {
    const runner = recordingRunner(processResult());

    await createGatesStage(deps(runner)).run(stageContext());

    expect(runner.calls[0]?.env).toEqual({ inherit: true });
  });

  it('gives every spawn an explicit, positive timeout', async () => {
    // `timeoutMs` is required with no ambient fallback precisely so an
    // unbounded gate spawn is not expressible.
    const runner = recordingRunner(processResult());

    await createGatesStage(deps(runner)).run(stageContext());

    expect(runner.calls[0]?.timeoutMs).toBeGreaterThan(0);
    expect(Number.isInteger(runner.calls[0]?.timeoutMs)).toBe(true);
  });

  it('honours an injected timeout so a test never waits out the default', async () => {
    const runner = recordingRunner(processResult());

    await createGatesStage({ ...deps(runner), timeoutMs: 25 }).run(stageContext());

    expect(runner.calls[0]?.timeoutMs).toBe(25);
  });

  it('hands onProcessGroup to the runner so the pgid can be recorded durably', async () => {
    const seen: number[] = [];
    const runner = recordingRunner(processResult());

    await createGatesStage({
      ...deps(runner),
      onProcessGroup: (pgid) => {
        seen.push(pgid);
      },
    }).run(stageContext());

    // The stage does not invoke it — the runner does — but it must be passed
    // on, or a gate's process group is never recorded and `clean` cannot reap
    // it after a crash.
    expect(runner.calls[0]?.onProcessGroup).toBeTypeOf('function');
    await runner.calls[0]?.onProcessGroup?.(99);
    expect(seen).toEqual([99]);
  });

  it('does nothing at all when no gates are declared', async () => {
    const runner = recordingRunner();

    const result = await createGatesStage({
      gates: [],
      runner,
      writeEvidence: recordingWriter(),
    }).run(stageContext());

    expect(result.status).toBe('ok');
    expect(runner.calls).toEqual([]);
  });
});

describe('gates stage: AC2 — a gate that RAN and said no is a product FAIL', () => {
  it('returns a product-negative stage result, never a thrown exception', async () => {
    // AD-6. A thrown gate failure classifies as infrastructure and exits 3,
    // which tells a harness "the environment is broken, retry" — and the retry
    // merges a branch that does not compile.
    const runner = recordingRunner(processResult({ exitCode: 1 }));

    const result = await createGatesStage(deps(runner)).run(stageContext());

    expect(result.status).toBe('product-negative');
    expect(result.detail).toContain('lint');
  });

  it('marks the failing gate `fail`, never `skipped` or `pass`', async () => {
    const runner = recordingRunner(processResult({ exitCode: 2 }));
    const context = stageContext();

    await createGatesStage(deps(runner)).run(context);

    expect(context.run.gates).toEqual([{ gateId: 'lint', status: 'fail', durationMs: 7 }]);
  });

  it('does not construct a RunOutcome or touch an exit code', async () => {
    // The aggregate stage is the ONLY converter from stage results to an
    // outcome (AD-6). A gates stage that wrote one would be a second, competing
    // path into the verdict.
    const runner = recordingRunner(processResult({ exitCode: 1 }));
    const context = stageContext();

    await createGatesStage(deps(runner)).run(context);

    expect(context.run.outcome).toBeUndefined();
  });
});

describe('gates stage: AC2 — early stop and skipped remainder (FR-20)', () => {
  const FIVE = [
    { id: 'install', run: 'pnpm install' },
    { id: 'lint', run: 'pnpm lint' },
    { id: 'typecheck', run: 'pnpm typecheck' },
    { id: 'unit', run: 'pnpm test' },
    { id: 'build', run: 'pnpm build' },
  ];

  it('stops after the failing gate and spawns NOTHING further', async () => {
    // The economic argument for the whole pipeline order: a branch that does
    // not build must cost no AI call and no browser session. The runner throws
    // if asked for an unscripted spawn, so a stage that kept going fails loudly
    // rather than silently passing this assertion.
    const runner = recordingRunner(processResult(), processResult({ exitCode: 1 }));

    await createGatesStage({
      gates: declaredGates(FIVE),
      runner,
      writeEvidence: recordingWriter(),
    }).run(stageContext());

    expect(runner.calls).toHaveLength(2);
    expect(runner.calls.map((call) => call.args[0])).toEqual(['install', 'lint']);
  });

  it('reports every remaining gate as skipped, in declaration order', async () => {
    // A missing gate and a skipped gate look identical in a report, and only
    // one of them is true.
    const runner = recordingRunner(processResult(), processResult({ exitCode: 1 }));
    const context = stageContext();

    await createGatesStage({
      gates: declaredGates(FIVE),
      runner,
      writeEvidence: recordingWriter(),
    }).run(context);

    expect(context.run.gates).toEqual([
      { gateId: 'install', status: 'pass', durationMs: 7 },
      { gateId: 'lint', status: 'fail', durationMs: 7 },
      { gateId: 'typecheck', status: 'skipped' },
      { gateId: 'unit', status: 'skipped' },
      { gateId: 'build', status: 'skipped' },
    ]);
  });

  it('gives a skipped gate no duration — it did not run, so it took no time', async () => {
    const runner = recordingRunner(processResult({ exitCode: 1 }));
    const context = stageContext();

    await createGatesStage({
      gates: declaredGates(FIVE),
      runner,
      writeEvidence: recordingWriter(),
    }).run(context);

    for (const gate of context.run.gates.slice(1)) {
      expect(gate.durationMs).toBeUndefined();
    }
  });

  it('produces no evidence for a gate that never ran', async () => {
    const runner = recordingRunner(processResult({ exitCode: 1, stdout: 'boom' }));
    const context = stageContext();

    await createGatesStage({
      gates: declaredGates(FIVE),
      runner,
      writeEvidence: recordingWriter(),
    }).run(context);

    // Exactly one executed gate, so exactly one evidence entry — an entry for a
    // command that did not run would be a claim about something that did not
    // happen.
    expect(context.run.evidence).toHaveLength(1);
  });
});

describe('gates stage: AC3 — a gate that could NOT START is infrastructure', () => {
  /**
   * The single most damaging bug available in this story. Exit 3 says "fix your
   * environment and rerun"; exit 1 says "your code is broken". They are not
   * interchangeable, so each case asserts the absence of the wrong answer too.
   */
  const CANNOT_START = ['not-found', 'spawn-failed', 'timed-out'] as const;

  it.each(CANNOT_START)('throws InfraError for %s', async (outcome) => {
    const runner = recordingRunner(processResult({ outcome, exitCode: null }));

    await expect(createGatesStage(deps(runner)).run(stageContext())).rejects.toThrow(InfraError);
  });

  it.each(CANNOT_START)('records NO GateResult claiming pass or fail for %s', async (outcome) => {
    // A gate that could not start has not judged the branch. A `fail` here
    // would reach `aggregate()` and become a product FAIL carrying `gateFailed`.
    const runner = recordingRunner(processResult({ outcome, exitCode: null }));
    const context = stageContext();

    await expect(createGatesStage(deps(runner)).run(context)).rejects.toThrow(InfraError);

    expect(context.run.gates.some((gate) => gate.status === 'fail')).toBe(false);
    expect(context.run.gates.some((gate) => gate.status === 'pass')).toBe(false);
  });

  it('names the gate and the binary in the error, and gives an actionable hint', async () => {
    const runner = recordingRunner(processResult({ outcome: 'not-found', exitCode: null }));

    const error = await infraErrorFrom(createGatesStage(deps(runner)).run(stageContext()));

    expect(error).toBeInstanceOf(InfraError);
    expect(error.message).toContain('lint');
    expect(error.message).toContain('node');
    expect(error.hint).toBeDefined();
  });

  it('distinguishes a missing binary from an unusable working directory', async () => {
    // The merged runner already separates these by asking the filesystem
    // whether `cwd` is a directory. Telling an operator to install a binary
    // they already have is the confidently-wrong answer Epic 2's retro records.
    const missing = await infraErrorFrom(
      createGatesStage(
        deps(recordingRunner(processResult({ outcome: 'not-found', exitCode: null }))),
      ).run(stageContext()),
    );
    const badCwd = await infraErrorFrom(
      createGatesStage(
        deps(recordingRunner(processResult({ outcome: 'spawn-failed', exitCode: null }))),
      ).run(stageContext()),
    );

    expect(missing.message).not.toBe(badCwd.message);
    expect(missing.hint).not.toBe(badCwd.hint);
  });

  it('treats a timeout as infrastructure, not as a product FAIL', async () => {
    // A gate that hung tells you nothing about whether the branch is mergeable.
    // Exit 1 would tell a harness "this branch has defects" on no evidence.
    const runner = recordingRunner(processResult({ outcome: 'timed-out', exitCode: null }));
    const context = stageContext();

    const error = await infraErrorFrom(createGatesStage(deps(runner)).run(context));

    expect(error).toBeInstanceOf(InfraError);
    expect(error.message).toMatch(/timed out|timeout/i);
    expect(context.run.gates.some((gate) => gate.status === 'fail')).toBe(false);
  });

  it('keeps a hung gate OUTPUT as evidence, because it did produce some', async () => {
    // 3.2's runner returns the child's captured output on a timeout rather than
    // an empty string, so there is something worth persisting. It is `command`
    // evidence, not `gate` evidence: a gate that could not be judged has no
    // GateStatus, and inventing one would put a wrong value in a field that
    // aggregation reads.
    const runner = recordingRunner(
      processResult({ outcome: 'timed-out', exitCode: null, stdout: 'still compiling…' }),
    );
    const context = stageContext();

    await createGatesStage(deps(runner))
      .run(context)
      .catch(() => undefined);

    expect(context.run.evidence).toHaveLength(1);
    expect(context.run.evidence[0]?.kind).toBe('command');
    expect(context.run.gates).toEqual([]);
  });

  it('does not swallow a runner that REJECTS, and claims nothing about the gate', async () => {
    // `ProcessRunner.run` never rejects for a subprocess OUTCOME — that is its
    // contract. But story 3.2 added a path where it can reject for an
    // infrastructure failure: if the durability hook that records the process
    // group fails, the runner kills the group and rethrows, because swallowing
    // it would leave a live process group nothing on disk can find.
    //
    // What matters here is what this stage does NOT do. It does not catch, it
    // does not convert the rejection into a gate result, and it does not
    // re-wrap it — the runner's message names the actual durability failure and
    // wrapping it would replace a precise diagnosis with a vague one. The
    // pipeline classifies any escaping throw as infra (AD-7, fail closed), so
    // the run reaches exit 3 with no verdict rather than a FAIL nobody observed.
    const durabilityFailure = new InfraError(
      'could not durably record the process group',
      'check that the run directory is writable',
    );
    const rejecting = {
      calls: [],
      run: async () => {
        throw durabilityFailure;
      },
    } as unknown as ReturnType<typeof recordingRunner>;
    const context = stageContext();

    await expect(createGatesStage(deps(rejecting)).run(context)).rejects.toBe(durabilityFailure);

    expect(context.run.gates).toEqual([]);
    expect(context.run.evidence).toEqual([]);
  });

  it('lets an UNCLASSIFIED throw escape rather than reporting a gate outcome', async () => {
    // A bare TypeError from anywhere below is not something this stage can
    // interpret. Converting it into a gate result would be the worst available
    // response: it would turn an unknown failure into a claim about the branch.
    const bug = new TypeError('cannot read properties of undefined');
    const exploding = {
      calls: [],
      run: async () => {
        throw bug;
      },
    } as unknown as ReturnType<typeof recordingRunner>;
    const context = stageContext();

    await expect(createGatesStage(deps(exploding)).run(context)).rejects.toBe(bug);

    expect(context.run.gates).toEqual([]);
  });

  it('refuses to run gates at all when there is no worktree', async () => {
    // Falling back to the source repo would silently verify the wrong tree.
    const runner = recordingRunner();

    await expect(
      createGatesStage(deps(runner)).run(stageContext({ worktreePath: null })),
    ).rejects.toThrow(InfraError);
    expect(runner.calls).toEqual([]);
  });

  it('refuses a declared command with no executable token', async () => {
    // `nonEmptyString` is `min(1)`, which "   " satisfies. Spawning '' would be
    // an unhelpful failure from deep inside execa.
    const runner = recordingRunner();
    const gates = declaredGates([{ id: 'blank', run: '   ' }]);

    await expect(
      createGatesStage({ gates, runner, writeEvidence: recordingWriter() }).run(stageContext()),
    ).rejects.toThrow(InfraError);
    expect(runner.calls).toEqual([]);
  });
});

describe('gates stage: AC1/AC2 — evidence', () => {
  const gateEvidenceOf = (evidence: readonly { kind: string }[]): GateEvidence =>
    evidence.find((entry) => entry.kind === 'gate') as GateEvidence;

  it('produces gate evidence for a passing gate', async () => {
    const runner = recordingRunner(processResult({ stdout: 'all good', durationMs: 11 }));
    const context = stageContext();

    await createGatesStage(deps(runner)).run(context);

    expect(gateEvidenceOf(context.run.evidence)).toMatchObject({
      kind: 'gate',
      gateId: 'lint',
      status: 'pass',
      exitCode: 0,
      durationMs: 11,
    });
  });

  it('produces gate evidence for a failing gate, carrying its exit code', async () => {
    const runner = recordingRunner(processResult({ exitCode: 3, stderr: 'nope' }));
    const context = stageContext();

    await createGatesStage(deps(runner)).run(context);

    expect(gateEvidenceOf(context.run.evidence)).toMatchObject({
      kind: 'gate',
      status: 'fail',
      exitCode: 3,
    });
  });

  it('stamps capturedAt from the injected clock, in ISO-8601 UTC', async () => {
    const runner = recordingRunner(processResult());
    const context = stageContext();

    await createGatesStage(deps(runner)).run(context);

    expect(gateEvidenceOf(context.run.evidence).capturedAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('bounds the inline output at the cap and points at the full file', async () => {
    const huge = 'x'.repeat(EVIDENCE_INLINE_CAP_BYTES * 2);
    const runner = recordingRunner(processResult({ stdout: huge }));
    const context = stageContext();

    await createGatesStage(deps(runner)).run(context);

    const evidence = gateEvidenceOf(context.run.evidence);
    expect(evidence.stdout.truncated).toBe(true);
    expect(Buffer.byteLength(evidence.stdout.text, 'utf8')).toBeLessThanOrEqual(
      EVIDENCE_INLINE_CAP_BYTES,
    );
    expect(evidence.stdout.fullPath).toBeDefined();
  });

  it('uses a RELATIVE evidence path, never an absolute one (Q48)', async () => {
    const huge = 'y'.repeat(EVIDENCE_INLINE_CAP_BYTES * 2);
    const runner = recordingRunner(processResult({ stdout: huge }));
    const context = stageContext();

    await createGatesStage(deps(runner)).run(context);

    const path = gateEvidenceOf(context.run.evidence).stdout.fullPath as string;
    expect(path.startsWith('/')).toBe(false);
    expect(path.startsWith('evidence/')).toBe(true);
  });

  it('gives stdout and stderr DIFFERENT full-output files', async () => {
    // One pointer shared by two streams has each truncation marker claiming its
    // own content lives in the same file — a reader opens it and takes stderr
    // for stdout.
    const huge = 'z'.repeat(EVIDENCE_INLINE_CAP_BYTES * 2);
    const runner = recordingRunner(processResult({ stdout: huge, stderr: huge }));
    const context = stageContext();

    await createGatesStage(deps(runner)).run(context);

    const evidence = gateEvidenceOf(context.run.evidence);
    expect(evidence.stdout.fullPath).not.toBe(evidence.stderr.fullPath);
  });

  it('writes no file for an empty stream', async () => {
    const writer = recordingWriter();
    const runner = recordingRunner(processResult({ stdout: 'out', stderr: '' }));

    await createGatesStage(deps(runner, writer)).run(stageContext());

    expect(writer.writes.map((write) => write.name)).toEqual(['evidence/gate-00-lint.stdout.txt']);
  });
});

describe('gates stage: FR-28 — a seeded secret never reaches evidence OR disk', () => {
  /**
   * The proof that this path goes THROUGH redaction rather than around it.
   *
   * Both halves matter, and the second is the one that was nearly missed: an
   * evidence constructor can redact the inline copy perfectly while the full
   * file written beside it keeps the secret verbatim — and the obvious test,
   * which inspects only the inline evidence, passes green over exactly that
   * hole. So this asserts on the EXACT bytes handed to the writer too.
   *
   * The fixture (`gates.secrets.ts`) prints the shapes a real gate prints, not
   * only the assignment form. See that file for why the tokens are assembled
   * rather than written literally.
   */
  it('keeps the secret out of the inline evidence', async () => {
    const runner = recordingRunner(
      processResult({ stdout: NOISY_GATE_OUTPUT, stderr: NOISY_GATE_OUTPUT }),
    );
    const context = stageContext();

    await createGatesStage(deps(runner)).run(context);

    const serialised = JSON.stringify(context.run.evidence);
    expect(serialised).not.toContain(SEEDED_API_KEY);
    expect(serialised).not.toContain(SEEDED_COOKIE);
  });

  it('keeps the secret out of the bytes written to the run directory', async () => {
    const writer = recordingWriter();
    const runner = recordingRunner(
      processResult({ stdout: NOISY_GATE_OUTPUT, stderr: NOISY_GATE_OUTPUT }),
    );

    await createGatesStage(deps(runner, writer)).run(stageContext());

    expect(writer.writes.length).toBeGreaterThan(0);
    for (const write of writer.writes) {
      expect(write.contents).not.toContain(SEEDED_API_KEY);
      expect(write.contents).not.toContain(SEEDED_COOKIE);
    }
  });

  it('writes the FULL redacted output, not a truncated copy', async () => {
    // The inline copy is capped; the file is not. A file that were merely the
    // bounded text would make the truncation marker point at the same content
    // it is apologising for.
    const huge = `${'q'.repeat(EVIDENCE_INLINE_CAP_BYTES * 2)}\n${NOISY_GATE_OUTPUT}`;
    const writer = recordingWriter();
    const runner = recordingRunner(processResult({ stdout: huge }));

    await createGatesStage(deps(runner, writer)).run(stageContext());

    const written = writer.writes[0]?.contents ?? '';
    expect(Buffer.byteLength(written, 'utf8')).toBeGreaterThan(EVIDENCE_INLINE_CAP_BYTES);
    expect(written).not.toContain(SEEDED_API_KEY);
  });
});
