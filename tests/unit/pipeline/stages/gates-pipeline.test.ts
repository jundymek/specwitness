import { describe, expect, it } from 'vitest';

import type { Contract } from '../../../../src/domain/contract.js';
import type { RunEnvironment, RunResult } from '../../../../src/domain/run-result.js';
import { STAGE_NAMES, type StageName } from '../../../../src/domain/stage.js';
import { runPipeline } from '../../../../src/pipeline/run-pipeline.js';
import { createStages } from '../../../../src/pipeline/stages/index.js';
import type { GatesStageDeps } from '../../../../src/pipeline/stages/gates.js';
import { FixedClock } from '../../../fakes/ports.js';
import {
  declaredGates,
  processResult,
  recordingRunner,
  recordingWriter,
  WORKTREE,
  type RecordingRunner,
} from './gates.helpers.js';

/**
 * The REAL gates stage driven through the REAL pipeline.
 *
 * This file exists because of one sentence from story 3.3's author, sent to the
 * whole cohort after her third review round: *"if any of you are relying on a
 * property of my code that you have not asserted yourself, this is the moment
 * to write that assertion."*
 *
 * Story 3.4 relies on exactly two, and neither is asserted by 3.3's own suite —
 * its gate-failure test substitutes a HAND-WRITTEN fake gates stage, so the
 * real one had never been run through the real state machine at all:
 *
 *  1. A `product-negative` return stops the pipeline early and still reaches
 *     aggregate, so a gate failure becomes **FAIL + `gateFailed`, exit 1**.
 *  2. A thrown `InfraError` produces an infra outcome with **no verdict at
 *     all**, exit 3.
 *
 * Getting these two backwards is the defect this whole story exists to prevent,
 * and the seam where it would happen is between two agents' code — which is
 * precisely the seam neither agent's unit tests cover.
 *
 * Unit-level: no filesystem, no git, no real subprocess. The gate runner is a
 * recording fake; the contract guard is a fixture.
 */

const ENVIRONMENT: RunEnvironment = {
  nodeVersion: 'v22.12.0',
  platform: 'darwin',
  arch: 'arm64',
  specwitnessVersion: '0.1.0',
  worktreePath: WORKTREE,
  runDirectory: '.specwitness/runs/run-20260901T000000Z-ab12',
};

function frozenContract(): Contract {
  return {
    spec: {
      epic: 'epic-3',
      version: 1,
      criteria: [
        {
          id: 'E3-01',
          statement: 'the health endpoint answers 200',
          kind: 'behavioral',
          severity: 'critical',
          verifiability: 'automated',
        },
        {
          id: 'E3-02',
          statement: 'the pipeline classifies infra failures as exit 3',
          kind: 'structural',
          severity: 'normal',
          verifiability: 'automated',
        },
      ],
    },
    meta: {
      schemaVersion: 1,
      frozen: true,
      fingerprint: 'f'.repeat(64),
      createdAt: '2026-08-31T18:00:00.000Z',
      frozenAt: '2026-08-31T19:00:00.000Z',
      provenance: {
        provider: null,
        model: null,
        providerCliVersion: null,
        generatedAt: '2026-08-31T18:00:00.000Z',
      },
      history: [],
    },
  };
}

const THREE = [
  { id: 'install', run: 'pnpm install' },
  { id: 'lint', run: 'pnpm lint' },
  { id: 'build', run: 'pnpm build' },
];

async function verify(gatesDeps: GatesStageDeps): Promise<RunResult> {
  return runPipeline({
    runId: 'run-20260901T000000Z-ab12',
    epic: 'epic-3',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    environment: ENVIRONMENT,
    clock: new FixedClock('2026-09-01T00:00:00.000Z'),
    stages: createStages({
      assertVerifiableContract: () => frozenContract(),
      gates: gatesDeps,
    }),
  });
}

function gatesWith(runner: RecordingRunner, gates = THREE): GatesStageDeps {
  return { gates: declaredGates(gates), runner, writeEvidence: recordingWriter() };
}

const statusOf = (result: RunResult, stage: StageName): string | undefined =>
  result.stages.find((entry) => entry.stage === stage)?.status;

describe('the real gates stage, through the real pipeline: all gates pass', () => {
  it('reaches PASS with no gateFailed marker', async () => {
    const runner = recordingRunner(processResult(), processResult(), processResult());

    const result = await verify(gatesWith(runner));

    expect(result.outcome).toEqual({ verdict: 'PASS' });
    expect(result.stages).toHaveLength(STAGE_NAMES.length);
    expect(runner.calls).toHaveLength(3);
  });
});

describe('the real gates stage, through the real pipeline: AC2 — a failing gate', () => {
  it('produces FAIL carrying the failing gate id — exit 1, not exit 3', async () => {
    // `gateFailed` is the gate id STRING, following the merged
    // `src/domain/run-outcome.ts`. ADR-003's prose says `gateFailed: true`; the
    // code is the contract and the ADR wording is the stale half (action A3).
    const runner = recordingRunner(processResult(), processResult({ exitCode: 1 }));

    const result = await verify(gatesWith(runner));

    expect(result.outcome).toEqual({ verdict: 'FAIL', gateFailed: 'lint' });
    expect(result.outcome.infraError).toBeUndefined();
  });

  it('marks the gates stage `failed`, not `error`', async () => {
    // `error` would mean the stage threw, which classifies as infrastructure.
    const runner = recordingRunner(processResult(), processResult({ exitCode: 1 }));

    const result = await verify(gatesWith(runner));

    expect(statusOf(result, 'gates')).toBe('failed');
  });

  it('still reaches aggregate, persist and teardown', async () => {
    // ADR-003: the run owes the caller a verdict, a stored result and a report
    // even though it stopped early.
    const runner = recordingRunner(processResult(), processResult({ exitCode: 1 }));

    const result = await verify(gatesWith(runner));

    expect(statusOf(result, 'aggregate')).toBe('ok');
    expect(statusOf(result, 'persist')).toBe('ok');
    expect(statusOf(result, 'teardown')).toBe('ok');
  });

  it('skips the stages between gates and aggregate — no provider, no browser (FR-20)', async () => {
    const runner = recordingRunner(processResult(), processResult({ exitCode: 1 }));

    const result = await verify(gatesWith(runner));

    expect(statusOf(result, 'services')).toBe('skipped');
    expect(statusOf(result, 'data')).toBe('skipped');
    expect(statusOf(result, 'probes')).toBe('skipped');
  });

  it('spawns nothing after the failing gate', async () => {
    // The economic argument for the pipeline order, asserted at the level where
    // it actually matters rather than only inside the stage.
    const runner = recordingRunner(processResult(), processResult({ exitCode: 1 }));

    await verify(gatesWith(runner));

    expect(runner.calls).toHaveLength(2);
  });

  it('reports the remaining gates as skipped and every criterion as skipped', async () => {
    const runner = recordingRunner(processResult(), processResult({ exitCode: 1 }));

    const result = await verify(gatesWith(runner));

    expect(result.gates).toEqual([
      { gateId: 'install', status: 'pass', durationMs: 7 },
      { gateId: 'lint', status: 'fail', durationMs: 7 },
      { gateId: 'build', status: 'skipped' },
    ]);
    expect(result.criteria.map((criterion) => criterion.status)).toEqual(['skipped', 'skipped']);
  });

  it('carries the failing gate evidence into the result', async () => {
    const runner = recordingRunner(
      processResult(),
      processResult({ exitCode: 1, stderr: 'type error in src/x.ts' }),
    );

    const result = await verify(gatesWith(runner));

    const failing = result.evidence.find(
      (entry) => entry.kind === 'gate' && entry.gateId === 'lint',
    );
    expect(failing).toMatchObject({ kind: 'gate', status: 'fail', exitCode: 1 });
  });
});

describe('the real gates stage, through the real pipeline: AC3 — a gate that cannot start', () => {
  it('produces an infra outcome with NO verdict — exit 3, not exit 1', async () => {
    // The single most damaging confusion available in this story. A verdict here
    // would tell a harness the branch has defects on no evidence at all.
    const runner = recordingRunner(processResult({ outcome: 'not-found', exitCode: null }));

    const result = await verify(gatesWith(runner));

    expect(result.outcome).toEqual({ infraError: 'infra' });
    expect(result.outcome.verdict).toBeUndefined();
    expect(result.outcome.gateFailed).toBeUndefined();
  });

  it('marks the gates stage `error`, and records no gate result at all', async () => {
    const runner = recordingRunner(processResult({ outcome: 'not-found', exitCode: null }));

    const result = await verify(gatesWith(runner));

    expect(statusOf(result, 'gates')).toBe('error');
    expect(result.gates).toEqual([]);
  });

  it('still runs teardown, so a failed run releases what it acquired', async () => {
    const runner = recordingRunner(processResult({ outcome: 'spawn-failed', exitCode: null }));

    const result = await verify(gatesWith(runner));

    expect(statusOf(result, 'teardown')).toBe('ok');
  });

  it('classifies a TIMEOUT as infra too, never as a product FAIL', async () => {
    const runner = recordingRunner(processResult({ outcome: 'timed-out', exitCode: null }));

    const result = await verify(gatesWith(runner));

    expect(result.outcome).toEqual({ infraError: 'infra' });
    expect(result.gates.some((gate) => gate.status === 'fail')).toBe(false);
  });

  it('names the gate in the timeline detail, so a report says WHICH gate', async () => {
    const runner = recordingRunner(processResult({ outcome: 'not-found', exitCode: null }));

    const result = await verify(gatesWith(runner));

    expect(result.stages.find((entry) => entry.stage === 'gates')?.detail).toContain('install');
  });
});

describe('the real gates stage, through the real pipeline: a rejecting runner', () => {
  it('reaches an infra outcome with no verdict, never a FAIL nobody observed', async () => {
    // Story 3.2's runner rejects when the durability hook that records a
    // process group fails — swallowing it would leave a live group nothing on
    // disk can find. The stage lets it escape; the pipeline classifies any
    // escaping throw as infra (AD-7, fail closed).
    //
    // The property worth pinning is the one this epic exists to protect: an
    // infrastructure failure must never be reported as a product FAIL. A gate
    // whose group could not be recorded has said nothing about the branch.
    const rejecting = {
      run: async () => {
        throw new Error('could not durably record the process group');
      },
    };

    const result = await verify({
      gates: declaredGates(THREE),
      runner: rejecting as never,
      writeEvidence: recordingWriter(),
    });

    expect(result.outcome).toEqual({ infraError: 'infra' });
    expect(result.outcome.verdict).toBeUndefined();
    expect(result.gates).toEqual([]);
    expect(statusOf(result, 'gates')).toBe('error');
    // Still released what it acquired.
    expect(statusOf(result, 'teardown')).toBe('ok');
  });
});

describe('the real gates stage, through the real pipeline: an unwired run FAILS CLOSED', () => {
  const unwired = async (): Promise<RunResult> =>
    runPipeline({
      runId: 'run-20260901T000000Z-ab12',
      epic: 'epic-3',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      environment: ENVIRONMENT,
      clock: new FixedClock('2026-09-01T00:00:00.000Z'),
      stages: createStages({ assertVerifiableContract: () => frozenContract() }),
    });

  it('is INCONCLUSIVE, never a green verdict, when no gate runner was bound', async () => {
    // The finding this replaced an earlier, weaker version of. `aggregate()`
    // over an empty gate set returns PASS, so an unwired run used to produce a
    // green verdict for a branch on which nothing had been checked — and a
    // timeline detail does not stop a consumer treating the verdict as green,
    // because the verdict IS the machine contract.
    const result = await unwired();

    expect(result.outcome).toEqual({ infraError: 'infra' });
    expect(result.outcome.verdict).toBeUndefined();
    expect(result.gates).toEqual([]);
  });

  it('says which stage and why, so the defect is diagnosable', async () => {
    const result = await unwired();

    expect(statusOf(result, 'gates')).toBe('error');
    expect(result.stages.find((entry) => entry.stage === 'gates')?.detail).toContain(
      'no gate runner',
    );
  });

  it('still runs teardown', async () => {
    expect(statusOf(await unwired(), 'teardown')).toBe('ok');
  });

  it('does NOT fail closed when the project simply declares no gates', async () => {
    // The distinction that makes the rule above safe rather than blunt. A
    // project with an empty `gates:` block has declared nothing, so nothing was
    // expected, and PASS is the correct reading. Only an absent RUNNER is
    // inconclusive.
    const result = await verify({
      gates: [],
      runner: recordingRunner(),
      writeEvidence: recordingWriter(),
    });

    expect(result.outcome).toEqual({ verdict: 'PASS' });
    expect(statusOf(result, 'gates')).toBe('ok');
  });
});
