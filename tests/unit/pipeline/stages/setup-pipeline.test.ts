import { describe, expect, it } from 'vitest';

import type { Contract } from '../../../../src/domain/contract.js';
import type { RunEnvironment, RunResult } from '../../../../src/domain/run-result.js';
import { STAGE_NAMES, type StageName } from '../../../../src/domain/stage.js';
import { runPipeline } from '../../../../src/pipeline/run-pipeline.js';
import { createStages } from '../../../../src/pipeline/stages/index.js';
import type { SetupStageDeps } from '../../../../src/pipeline/stages/setup.js';
import { FixedClock } from '../../../fakes/ports.js';
import {
  declaredGates,
  processResult as gateProcessResult,
  recordingRunner as gateRunner,
} from './gates.helpers.js';
import {
  declaredInstall,
  processResult,
  recordingRunner,
  recordingWriter,
  refusingRunner,
  WORKTREE,
} from './setup.helpers.js';

/**
 * The REAL setup stage driven through the REAL pipeline (story 6.11, AC3).
 *
 * The unit tests beside this file assert that a failed install THROWS. That is only half of the
 * claim, and it is the half that does not matter on its own: the claim this story actually makes
 * is about what the run then reports, and that is decided by `runPipeline` and `aggregate`, in
 * two other files, written by other people.
 *
 * So this file pins the whole sentence mechanically:
 *
 *   a failed install  ->  outcome `{infraError}`, NO verdict, exit 3
 *                     ->  `setup` recorded `error`
 *                     ->  `gates` recorded **`skipped`**, never `failed`
 *                     ->  teardown still runs
 *
 * `gates: skipped` is the assertion with teeth. A missing install that surfaced as a failing gate
 * would be an environment problem reported as the branch being wrong — the inversion CLAUDE.md
 * names as its first non-negotiable rule and the reason this story exists. The gate runner below
 * is a REFUSING runner, so "the gates stage never ran" is proved by construction rather than by
 * reading a status field: had the pipeline reached it, the test would fail with the runner's own
 * message.
 *
 * Unit-level: no filesystem, no git, no real subprocess.
 */

const ENVIRONMENT: RunEnvironment = {
  nodeVersion: 'v22.13.0',
  platform: 'linux',
  arch: 'x64',
  specwitnessVersion: '0.1.0',
  worktreePath: WORKTREE,
  runDirectory: '.specwitness/runs/run-20260905T000000Z-ab12',
};

function frozenContract(): Contract {
  return {
    spec: {
      epic: 'epic-6',
      version: 1,
      criteria: [
        {
          id: 'E6-01',
          statement: 'the setup stage runs the configured install command',
          kind: 'behavioral',
          severity: 'critical',
          verifiability: 'automated',
        },
      ],
    },
    meta: {
      schemaVersion: 1,
      frozen: true,
      fingerprint: 'f'.repeat(64),
      createdAt: '2026-09-05T09:00:00.000Z',
      frozenAt: '2026-09-05T09:30:00.000Z',
      provenance: {
        provider: null,
        model: null,
        providerCliVersion: null,
        generatedAt: '2026-09-05T09:00:00.000Z',
      },
      history: [],
    },
  };
}

async function verify(setup: SetupStageDeps): Promise<RunResult> {
  return runPipeline({
    runId: 'run-20260905T000000Z-ab12',
    epic: 'epic-6',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    environment: ENVIRONMENT,
    clock: new FixedClock('2026-09-05T00:00:00.000Z'),
    stages: createStages({
      assertVerifiableContract: () => frozenContract(),
      setup,
      // A gate that WOULD pass, behind a runner that must never be called. If the pipeline ever
      // reaches gates after a failed install, this runner throws and names the binary it was
      // asked to spawn.
      gates: {
        gates: declaredGates([{ id: 'tests', run: 'sh gates/tests.sh' }]),
        runner: refusingRunner(),
        writeEvidence: recordingWriter(),
      },
    }),
  });
}

const entryOf = (result: RunResult, stage: StageName) =>
  result.stages.find((candidate) => candidate.stage === stage);

describe('a failed install, through the real pipeline (AC3)', () => {
  it('ends as an infra error with the gates stage skipped, never failed', async () => {
    const result = await verify({
      install: declaredInstall('sh scripts/install.sh'),
      runner: recordingRunner(processResult({ exitCode: 7, stderr: 'no such lockfile\n' })),
    });

    // Exit 3, not exit 1. `{infraError}` and a verdict are mutually exclusive by construction
    // (`src/domain/run-outcome.ts`), so this single assertion also proves no verdict was reached.
    expect(result.outcome).toEqual({ infraError: 'infra' });

    expect(entryOf(result, 'setup')?.status).toBe('error');
    expect(entryOf(result, 'setup')?.detail).toContain('failed with exit code 7');
    // The remedy survives the run: `runPipeline` turns a throw into an outcome, so the CLI edge's
    // ERROR/HINT printer never runs and the hint has to travel on the timeline entry.
    expect(entryOf(result, 'setup')?.hint).toContain('setup.install');

    // ⚠️ THE ASSERTION THIS FILE EXISTS FOR.
    expect(entryOf(result, 'gates')?.status).toBe('skipped');
    expect(entryOf(result, 'gates')?.status).not.toBe('failed');

    // No gate result was manufactured for a gate that never ran.
    expect(result.gates).toEqual([]);
    // Teardown always runs, after an early stop as much as after a clean run.
    expect(entryOf(result, 'teardown')?.status).toBe('ok');
    expect(result.stages).toHaveLength(STAGE_NAMES.length);
  });

  it('records the failed install as evidence, so the run directory can explain it', async () => {
    const result = await verify({
      install: declaredInstall('sh scripts/install.sh'),
      runner: recordingRunner(processResult({ exitCode: 1, stderr: 'ERR_PNPM_NO_LOCKFILE\n' })),
      writeEvidence: recordingWriter(),
    });

    const evidence = result.evidence.filter((entry) => entry.kind === 'command');
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ commandId: 'setup.install' });
  });

  it('reports an unresolvable install binary as infra, not as a failing branch', async () => {
    const result = await verify({
      install: declaredInstall('pnpm install --frozen-lockfile'),
      runner: recordingRunner(processResult({ outcome: 'not-found', exitCode: null })),
    });

    expect(result.outcome).toEqual({ infraError: 'infra' });
    expect(entryOf(result, 'gates')?.status).toBe('skipped');
  });

  it('reports a hung install as infra, not as a failing branch', async () => {
    const result = await verify({
      install: declaredInstall('pnpm install'),
      runner: recordingRunner(processResult({ outcome: 'timed-out', exitCode: null })),
      timeoutMs: 250,
    });

    expect(result.outcome).toEqual({ infraError: 'infra' });
    expect(entryOf(result, 'setup')?.detail).toContain('timed out after 250ms');
    expect(entryOf(result, 'gates')?.status).toBe('skipped');
  });
});

describe('a successful install, through the real pipeline (AC1)', () => {
  it('runs before the gates stage and lets the run continue', async () => {
    const order: string[] = [];
    const installRunner = recordingRunner(processResult({ exitCode: 0, durationMs: 1200 }));
    const gatesRunner = gateRunner(gateProcessResult());

    const result = await runPipeline({
      runId: 'run-20260905T000000Z-ab12',
      epic: 'epic-6',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      environment: ENVIRONMENT,
      clock: new FixedClock('2026-09-05T00:00:00.000Z'),
      stages: createStages({
        assertVerifiableContract: () => frozenContract(),
        setup: {
          install: declaredInstall('sh scripts/install.sh'),
          runner: {
            run: async (options) => {
              order.push(`setup:${options.binary}`);
              return installRunner.run(options);
            },
          },
        },
        gates: {
          gates: declaredGates([{ id: 'tests', run: 'sh gates/tests.sh' }]),
          runner: {
            run: async (options) => {
              order.push(`gate:${options.binary}`);
              return gatesRunner.run(options);
            },
          },
          writeEvidence: recordingWriter(),
        },
      }),
    });

    // The ORDER is the point, not merely that both ran: gates and probes must execute against a
    // tree the install has already prepared. `setup` is stage 4 of 11 and `gates` is stage 5.
    expect(order).toEqual(['setup:sh', 'gate:sh']);
    expect(entryOf(result, 'setup')?.status).toBe('ok');
    expect(entryOf(result, 'setup')?.detail).toContain('exit code 0');
    expect(entryOf(result, 'gates')?.status).toBe('ok');
  });
});

describe('a run that declares no install (AC2)', () => {
  it('is unchanged: setup is ok, nothing is spawned, the outcome is a verdict', async () => {
    const runner = refusingRunner();

    const result = await runPipeline({
      runId: 'run-20260905T000000Z-ab12',
      epic: 'epic-6',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      environment: ENVIRONMENT,
      clock: new FixedClock('2026-09-05T00:00:00.000Z'),
      stages: createStages({
        assertVerifiableContract: () => frozenContract(),
        setup: { runner },
        gates: {
          gates: declaredGates([{ id: 'tests', run: 'sh gates/tests.sh' }]),
          runner: gateRunner(gateProcessResult()),
          writeEvidence: recordingWriter(),
        },
      }),
    });

    expect(entryOf(result, 'setup')?.status).toBe('ok');
    expect(entryOf(result, 'setup')?.detail).toBe('no install command declared');
    expect(runner.calls).toEqual([]);
    // The run still reaches a product verdict, exactly as it did before this story.
    expect(result.outcome).toEqual({ verdict: 'PASS' });
  });
});
