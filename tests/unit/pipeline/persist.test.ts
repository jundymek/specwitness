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
import { InfraError } from '../../../src/domain/errors.js';
import type { RunEnvironment, RunResult } from '../../../src/domain/run-result.js';
import { exitCodeForOutcome } from '../../../src/cli/exit.js';
import { runPipeline } from '../../../src/pipeline/run-pipeline.js';
import { createStages } from '../../../src/pipeline/stages/index.js';
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
