/**
 * Story 3.5 AC1 — the `persist` stage.
 *
 * The stage itself is small on purpose: take the run so far, hand it to the writer,
 * record a timeline entry. No rendering, no printing, no exit codes, and above all no
 * opinion about the outcome — `aggregate` is the only stage that decides one (AD-6).
 *
 * TWO PROPERTIES ARE ASSERTED HERE FROM THE CONSUMER SIDE, deliberately duplicating what
 * story 3.3's own suite asserts about its runner. Both are properties this story depends
 * on and would be broken BY a regression elsewhere, and story 3.3's author asked every
 * consumer to assert what it relies on rather than trust it — three review rounds found
 * six real defects in that module, and not one was caught by the obvious test.
 *
 *  1. **A persist failure never rewrites a decided verdict.** A run that FAILed on a gate
 *     and then could not write `result.json` must still exit 1. Exit 3 would tell a
 *     harness "the environment is broken, retry", and the retry merges a branch that does
 *     not build. That is a verdict-correctness bug wearing an infrastructure costume, and
 *     it was real in the pipeline two hours before this was written.
 *  2. **The crash-durable snapshot never predicts a teardown that has not happened.**
 *     The stage runs at position 10 of 11, so what it writes must report `teardown` as
 *     `skipped`. If anyone ever "helpfully" made `snapshot()` anticipate teardown, the
 *     crash-durable snapshot would become a crash-durable falsehood.
 */

import { describe, expect, it } from 'vitest';

import type { Contract } from '../../../src/domain/contract.js';
import {
  ConfigError,
  InfraError,
  IngestError,
  IntegrityError,
  ProviderError,
} from '../../../src/domain/errors.js';
import type { RunEnvironment, RunResult } from '../../../src/domain/run-result.js';
import { exitCodeForOutcome } from '../../../src/cli/exit.js';
import { runPipeline } from '../../../src/pipeline/run-pipeline.js';
import { createStages } from '../../../src/pipeline/stages/index.js';
import { stageOk, stageProductNegative } from '../../../src/pipeline/stage.js';
import { FixedClock } from '../../fakes/ports.js';

const ENVIRONMENT: RunEnvironment = {
  nodeVersion: 'v22.12.0',
  platform: 'darwin',
  arch: 'arm64',
  specwitnessVersion: '0.1.0',
  worktreePath: null,
  runDirectory: '.specwitness/runs/run-20260831T200000Z-a3f9',
};

/** A frozen, verifiable contract with no criteria — the gates-only shape of Epic 3. */
function frozenContract(): Contract {
  return {
    spec: { epic: 'epic-3', version: 1, criteria: [] },
    meta: {
      schemaVersion: 1,
      frozen: true,
      fingerprint: 'a'.repeat(64),
      createdAt: '2026-08-30T00:00:00.000Z',
      frozenAt: '2026-08-30T12:00:00.000Z',
      provenance: {
        provider: 'codex',
        model: null,
        providerCliVersion: null,
        generatedAt: '2026-08-30T00:00:00.000Z',
      },
      history: [],
    },
  };
}

interface RunOptions {
  /** Replaces the writer, so a durability failure can be simulated. */
  readonly writeResult?: (runId: string, result: RunResult) => Promise<void>;
  readonly onComplete?: (result: RunResult) => Promise<void>;
  readonly guard?: () => Contract;
}

/** Records what the persist stage handed the writer. */
interface Recorder {
  readonly calls: { runId: string; result: RunResult }[];
}

async function verifyWith(
  options: RunOptions = {},
): Promise<{ result: RunResult; recorder: Recorder }> {
  const recorder: Recorder = { calls: [] };

  // The wrapper is the ONLY recorder, so a call is counted exactly once whether or not
  // the test supplied a failing writer.
  const write = options.writeResult ?? (async () => undefined);

  const result = await runPipeline({
    runId: 'run-20260831T200000Z-a3f9',
    epic: 'epic-3',
    baseSha: 'b'.repeat(40),
    headSha: 'c'.repeat(40),
    environment: ENVIRONMENT,
    clock: new FixedClock('2026-08-31T20:00:00.000Z'),
    stages: createStages({
      assertVerifiableContract: options.guard ?? frozenContract,
      persist: {
        writeResult: async (runId, snapshot) => {
          recorder.calls.push({ runId, result: snapshot });
          await write(runId, snapshot);
        },
      },
    }),
    ...(options.onComplete === undefined ? {} : { onComplete: options.onComplete }),
  });

  return { result, recorder };
}

describe('the persist stage writes the run so far (AC1)', () => {
  it('hands the writer the run id and a complete-through-aggregate result', async () => {
    const { recorder } = await verifyWith();

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]?.runId).toBe('run-20260831T200000Z-a3f9');
    expect(recorder.calls[0]?.result.outcome).toEqual({ verdict: 'PASS' });
  });

  it('writes a snapshot whose outcome is already decided', async () => {
    // Position 10 is after aggregate, so an outcome always exists by the time this stage
    // runs. Pinned rather than assumed: the stage order is frozen by the spine, and if a
    // future change moved persist above aggregate this test says so immediately.
    const { recorder } = await verifyWith();

    const snapshot = recorder.calls[0]?.result;
    expect(snapshot?.outcome).toBeDefined();
    expect(snapshot?.outcome.verdict ?? snapshot?.outcome.infraError).toBeDefined();
  });

  it('NEVER predicts a teardown that has not happened', async () => {
    // The crash-durable snapshot must be honest about what has run. Anticipating teardown
    // here would make the document that survives a kill say a teardown completed when the
    // process died before it started.
    const { recorder } = await verifyWith();

    const teardown = recorder.calls[0]?.result.stages.find((s) => s.stage === 'teardown');
    expect(teardown?.status).toBe('skipped');
  });

  it('records a persist timeline entry in the finished result', async () => {
    const { result } = await verifyWith();

    const persist = result.stages.find((s) => s.stage === 'persist');
    expect(persist?.status).toBe('ok');
  });

  it('says plainly when no writer is configured rather than silently storing nothing', async () => {
    // A run that stored nothing must not look like a run that stored something. The
    // detail is persisted and rendered, so the gap is visible where a reader will see it.
    const result = await runPipeline({
      runId: 'run-20260831T200000Z-a3f9',
      epic: 'epic-3',
      baseSha: 'b'.repeat(40),
      headSha: 'c'.repeat(40),
      environment: ENVIRONMENT,
      clock: new FixedClock('2026-08-31T20:00:00.000Z'),
      stages: createStages({ assertVerifiableContract: frozenContract }),
    });

    const persist = result.stages.find((s) => s.stage === 'persist');
    expect(persist?.detail).toMatch(/not.*persist|no.*writer/i);
  });
});

describe('a persist failure never rewrites a decided verdict (AC1)', () => {
  it('keeps a gate FAIL at exit 1, not exit 3 — the case that merges a broken branch', async () => {
    // THE case this rule exists for. A branch that does not lint is not mergeable; that is
    // a FAIL and exits 1. If a failed result.json write turned it into exit 3, a harness
    // would read "the environment is broken, retry" and the retry would merge a branch
    // that does not build. The PASS variant below is the same rule, but this is the one
    // with teeth.
    //
    // The gates stage is swapped for one that fails, since story 3.4's real one has not
    // landed. `runPipeline` requires the eleven frozen names in order, so the replacement
    // keeps the name and only changes the body.
    const stages = createStages({
      assertVerifiableContract: frozenContract,
      persist: {
        writeResult: async () => {
          throw new InfraError('disk full', 'free some space');
        },
      },
    }).map((stage) =>
      stage.name === 'gates'
        ? {
            name: 'gates' as const,
            run: async (context: Parameters<typeof stage.run>[0]) => {
              context.run.gates.push({ gateId: 'lint', status: 'fail' as const, durationMs: 5 });
              return stageProductNegative("gate 'lint' failed");
            },
          }
        : stage,
    );

    const result = await runPipeline({
      runId: 'run-20260831T200000Z-a3f9',
      epic: 'epic-3',
      baseSha: 'b'.repeat(40),
      headSha: 'c'.repeat(40),
      environment: ENVIRONMENT,
      clock: new FixedClock('2026-08-31T20:00:00.000Z'),
      stages,
    });

    expect(result.outcome).toEqual({ verdict: 'FAIL', gateFailed: 'lint' });
    expect(exitCodeForOutcome(result.outcome)).toBe(1);
    // The failing gate's identity survives too — repair automation routes on it.
    expect(result.outcome.gateFailed).toBe('lint');
    // And the durability failure is still recorded rather than swallowed.
    expect(result.stages.find((s) => s.stage === 'persist')?.status).toBe('error');
  });

  it('keeps a PASS a PASS, and exits 0', async () => {
    const { result } = await verifyWith({
      writeResult: async () => {
        throw new InfraError('disk full', 'free some space');
      },
    });

    expect(result.outcome).toEqual({ verdict: 'PASS' });
    expect(exitCodeForOutcome(result.outcome)).toBe(0);
  });

  it('records the durability failure on the persist entry, not on the verdict', async () => {
    // Visible without being fatal to the product answer: the operator learns the write
    // failed, and the verdict still means what it meant.
    const { result } = await verifyWith({
      writeResult: async () => {
        throw new InfraError('disk full', 'free some space');
      },
    });

    const persist = result.stages.find((s) => s.stage === 'persist');
    expect(persist?.status).toBe('error');
    expect(persist?.detail).toMatch(/disk full/);
  });

  it('runs teardown even when persistence threw', async () => {
    const { result } = await verifyWith({
      writeResult: async () => {
        throw new InfraError('disk full', 'free some space');
      },
    });

    const teardown = result.stages.find((s) => s.stage === 'teardown');
    expect(teardown?.status).not.toBe('skipped');
  });
});

describe('EVERY outcome is persisted, including the infra ones (AC1)', () => {
  /**
   * Runs a pipeline with a stage swapped, capturing both writes.
   *
   * `persisted` records the crash-durable snapshot from the persist stage; `completed`
   * records the finished document from `onComplete`. Which of the two fires is the whole
   * point of this describe.
   */
  async function runCapturing(
    swap: (stages: ReturnType<typeof createStages>) => ReturnType<typeof createStages>,
    guard: () => Contract = frozenContract,
  ): Promise<{ result: RunResult; persisted: RunResult[]; completed: RunResult[] }> {
    const persisted: RunResult[] = [];
    const completed: RunResult[] = [];

    const result = await runPipeline({
      runId: 'run-20260831T200000Z-a3f9',
      epic: 'epic-3',
      baseSha: 'b'.repeat(40),
      headSha: 'c'.repeat(40),
      environment: ENVIRONMENT,
      clock: new FixedClock('2026-08-31T20:00:00.000Z'),
      stages: swap(
        createStages({
          assertVerifiableContract: guard,
          persist: {
            writeResult: async (_runId, snapshot) => {
              persisted.push(snapshot);
            },
          },
        }),
      ),
      onComplete: async (finished) => {
        completed.push(finished);
      },
    });

    return { result, persisted, completed };
  }

  it('persists a PASS through both writes', async () => {
    const { persisted, completed } = await runCapturing((s) => s);

    expect(persisted[0]?.outcome).toEqual({ verdict: 'PASS' });
    expect(completed[0]?.outcome).toEqual({ verdict: 'PASS' });
  });

  it('persists a NEEDS_HUMAN run', async () => {
    const { result, persisted, completed } = await runCapturing((stages) =>
      stages.map((stage) =>
        stage.name === 'probes'
          ? {
              name: 'probes' as const,
              run: async (context: Parameters<typeof stage.run>[0]) => {
                context.run.criteria.push({
                  criterionId: 'E3-01',
                  status: 'needs_human' as const,
                  statement: 'A person must read the error message.',
                  severity: 'normal' as const,
                });
                return stageOk();
              },
            }
          : stage,
      ),
    );

    expect(result.outcome).toEqual({ verdict: 'NEEDS_HUMAN' });
    expect(persisted[0]?.outcome).toEqual({ verdict: 'NEEDS_HUMAN' });
    expect(completed[0]?.outcome).toEqual({ verdict: 'NEEDS_HUMAN' });
  });

  it('persists an INFRA run even though the persist stage never ran', async () => {
    // THE case AC1 calls out by name: a run that ended `{infraError: 'integrity'}` before
    // a worktree existed still leaves a result.json, because that is what makes a failed
    // run diagnosable later.
    //
    // The mechanism is not obvious and is worth pinning: an early throw stops the
    // pipeline, so the persist stage at position 10 is SKIPPED and write 1 never happens.
    // `onComplete` runs after teardown regardless of outcome, so write 2 is what stores
    // the run. Remove that callback and infra-failed runs would silently persist nothing —
    // the failures most worth reading about would be the only ones with no record.
    const { result, persisted, completed } = await runCapturing(
      (s) => s,
      () => {
        throw new IntegrityError('contract fingerprint does not match', 'regenerate it');
      },
    );

    expect(result.outcome).toEqual({ infraError: 'integrity' });
    expect(result.stages.find((s) => s.stage === 'persist')?.status).toBe('skipped');
    expect(persisted).toHaveLength(0);
    expect(completed[0]?.outcome).toEqual({ infraError: 'integrity' });
  });

  it('persists each infra classification, not just the one the guard raises', async () => {
    // The taxonomy is closed and every arm reaches storage. A classification that could
    // not be persisted would be one nobody could diagnose after the fact.
    const cases: { error: Error; classification: string }[] = [
      { error: new IntegrityError('tampered', 'regenerate'), classification: 'integrity' },
      { error: new ConfigError('bad config', 'fix it'), classification: 'config' },
      { error: new IngestError('cannot read epics', 'check the path'), classification: 'ingest' },
      { error: new ProviderError('cli failed', 'check the provider'), classification: 'provider' },
      { error: new InfraError('disk full', 'free space'), classification: 'infra' },
      // Fail closed: anything unrecognised is infrastructure, never a product verdict.
      { error: new Error('something nobody classified'), classification: 'infra' },
    ];

    for (const { error, classification } of cases) {
      const { result, completed } = await runCapturing(
        (s) => s,
        () => {
          throw error;
        },
      );

      expect(result.outcome).toEqual({ infraError: classification });
      expect(completed[0]?.outcome).toEqual({ infraError: classification });
    }
  });
});

describe('the second write closes the teardown gap (AC1)', () => {
  it('hands onComplete a result whose teardown entry is no longer skipped', async () => {
    // Write 1 is the crash-durable snapshot; write 2 is the complete document. Without
    // the second, a run that PASSed and then leaked a worktree would be stored as a clean
    // PASS, and the stored run is the only place anyone would ever learn about the leak.
    const completed: RunResult[] = [];

    await verifyWith({
      onComplete: async (result) => {
        completed.push(result);
      },
    });

    expect(completed).toHaveLength(1);
    const teardown = completed[0]?.stages.find((s) => s.stage === 'teardown');
    expect(teardown?.status).not.toBe('skipped');
  });

  it('gives the two writes the same run id, so they target one file', async () => {
    const completed: RunResult[] = [];

    const { recorder } = await verifyWith({
      onComplete: async (result) => {
        completed.push(result);
      },
    });

    expect(completed[0]?.runId).toBe(recorder.calls[0]?.runId);
  });
});
