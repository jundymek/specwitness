import { describe, expect, it } from 'vitest';

import type { Contract } from '../../../src/domain/contract.js';
import { IntegrityError, UsageError } from '../../../src/domain/errors.js';
import type { ProcessRunner } from '../../../src/domain/process-runner.js';
import type { RunEnvironment, RunResult } from '../../../src/domain/run-result.js';
import { STAGE_NAMES } from '../../../src/domain/stage.js';
import type { StageName } from '../../../src/domain/stage.js';
import { ContractNotFrozenError } from '../../../src/schemas/contract.js';
import { assertVerifiableContract } from '../../../src/authoring/verifiable.js';
import type { LoadedContract } from '../../../src/authoring/verifiable.js';
import { runPipeline } from '../../../src/pipeline/run-pipeline.js';
import { createStages } from '../../../src/pipeline/stages/index.js';
import { createTeardownStage } from '../../../src/pipeline/stages/teardown.js';
import type { RunAccumulator, StageContext } from '../../../src/pipeline/stage.js';
import { forbiddenProcessRunner } from '../../fakes/agent-provider.js';
import { FixedClock } from '../../fakes/ports.js';

/**
 * AC2 and AC3 in one file: the integrity guard runs BEFORE anything is spawned or
 * created, and the whole pipeline is exercisable with zero I/O.
 *
 * The no-spawn property is asserted MECHANICALLY, not in prose. Every test here injects a
 * `ProcessRunner` that throws on any call — the one story 2.3 shipped so later stories
 * would not each write their own — into the same context the stages receive. Nothing in
 * this file imports `node:fs` either.
 */

const ENVIRONMENT: RunEnvironment = {
  nodeVersion: 'v22.12.0',
  platform: 'darwin',
  arch: 'arm64',
  specwitnessVersion: '0.1.0',
  worktreePath: null,
  runDirectory: '.specwitness/runs/run-20260831T200000Z-a3f9',
};

function frozenContract(overrides: Partial<Contract['spec']> = {}): Contract {
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
      ...overrides,
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

/**
 * Drives the real eleven-stage pipeline with a guard the test controls, and a
 * `ProcessRunner` that makes any spawn a loud failure.
 */
async function verify(
  guard: () => Contract,
  options: { readonly epic?: string } = {},
): Promise<{ result: RunResult; spawns: number; released: number }> {
  let spawns = 0;
  let released = 0;

  // The runner story 2.3 shipped for exactly this: it throws on ANY call. Wrapped only to
  // count, so a spawn shows up as a number in an assertion rather than as an exception
  // some stage might catch and turn into a stage result.
  const forbidden = forbiddenProcessRunner();
  const counting: ProcessRunner = {
    run: async (opts) => {
      spawns += 1;
      return forbidden.run(opts);
    },
  };

  const result = await runPipeline({
    runId: 'run-20260831T200000Z-a3f9',
    epic: options.epic ?? 'epic-3',
    baseSha: 'b'.repeat(40),
    headSha: 'c'.repeat(40),
    environment: ENVIRONMENT,
    clock: new FixedClock('2026-08-31T20:00:00.000Z'),
    stages: createStages({
      assertVerifiableContract: guard,
      // Modelled on what stories 3.1 and 3.2 will actually do: release the worktree only
      // if one was created. That makes `spawns` a statement ABOUT THE RUN rather than a
      // constant — the last test in this describe proves the counter can reach 1.
      teardown: {
        release: async (context) => {
          released += 1;
          const worktreePath = context.run.environment.worktreePath;
          if (worktreePath !== null) {
            await counting.run({
              binary: 'git',
              args: ['worktree', 'remove', worktreePath],
              cwd: '.',
              timeoutMs: 1000,
              env: { inherit: false },
            });
          }
        },
      },
    }),
  });

  return { result, spawns, released };
}

const statusOf = (result: RunResult, stage: StageName): string | undefined =>
  result.stages.find((entry) => entry.stage === stage)?.status;

describe('the integrity stage — AC2', () => {
  it('ends the run as an integrity error with ZERO commands executed in the worktree', async () => {
    // The tampered contract, expressed the way a caller actually gets it: the merged
    // guard refuses it, and the refusal is what has to cost nothing.
    const tampered: LoadedContract = {
      present: true,
      epic: 'epic-3',
      path: '.specwitness/contracts/epic-3.yaml',
      contract: { ...frozenContract(), spec: { ...frozenContract().spec, version: 99 } },
    };

    const { result, spawns } = await verify(() => assertVerifiableContract(tampered));

    expect(result.outcome).toEqual({ infraError: 'integrity' });
    // The assertion AC2 is actually about: not a worktree, not a spawn. `integrity`
    // precedes `worktree` in the frozen sequence precisely so this holds.
    expect(spawns).toBe(0);
    expect(statusOf(result, 'worktree')).toBe('skipped');
    expect(statusOf(result, 'gates')).toBe('skipped');
    expect(result.environment.worktreePath).toBeNull();
  });

  it('never reports a product verdict for an integrity failure', async () => {
    const { result } = await verify(() => {
      throw new IntegrityError('the contract was edited after it was frozen');
    });

    // Exit 3, never exit 1. A tampered contract says nothing about whether the branch is
    // mergeable, and reporting it as FAIL would be a defect of the first order.
    expect(result.outcome.verdict).toBeUndefined();
    expect(result.outcome.infraError).toBe('integrity');
  });

  it('keeps a never-frozen contract distinguishable from a tampered one', async () => {
    const draft: LoadedContract = {
      present: true,
      epic: 'epic-3',
      path: '.specwitness/contracts/epic-3.yaml',
      contract: {
        ...frozenContract(),
        meta: { ...frozenContract().meta, frozen: false, fingerprint: null, frozenAt: null },
      },
    };

    // Both classify as `integrity`, and they must: both mean "SpecWitness cannot gate on
    // this contract". What must stay distinct is the HINT — telling someone to `--freeze`
    // over a tamper launders it and destroys the only evidence it happened.
    await expect(async () => assertVerifiableContract(draft)).rejects.toThrow(
      ContractNotFrozenError,
    );
    const { result } = await verify(() => assertVerifiableContract(draft));
    expect(result.outcome).toEqual({ infraError: 'integrity' });
  });

  it('refuses an absent contract before anything is created', async () => {
    const absent: LoadedContract = {
      present: false,
      epic: 'epic-3',
      path: '.specwitness/contracts/epic-3.yaml',
    };

    const { result, spawns } = await verify(() => assertVerifiableContract(absent));

    expect(result.outcome).toEqual({ infraError: 'integrity' });
    expect(spawns).toBe(0);
  });

  it('refuses a contract that belongs to a different epic', async () => {
    // A plausible report about the wrong expectations is the most expensive wrong answer
    // available here, because nothing about it looks broken.
    const { result } = await verify(() => frozenContract({ epic: 'epic-4' }));

    expect(result.outcome).toEqual({ infraError: 'integrity' });
    expect(result.stages.find((entry) => entry.stage === 'integrity')?.detail).toContain(
      'epic-4',
    );
  });

  it('proves the no-spawn counter is real: a run that DOES create a worktree reaches the spawn', async () => {
    // Without this, `expect(spawns).toBe(0)` above would be true because nothing was ever
    // wired to the counter — a guard nobody has watched fire is not a guard. Here the
    // worktree stage is swapped for one that sets a path, exactly as story 3.1's will, and
    // the teardown release then reaches the forbidden runner.
    let spawns = 0;
    const forbidden = forbiddenProcessRunner();
    const stages = createStages({
      assertVerifiableContract: () => frozenContract(),
      teardown: {
        release: async (context) => {
          const worktreePath = context.run.environment.worktreePath;
          if (worktreePath !== null) {
            spawns += 1;
            await forbidden.run({
              binary: 'git',
              args: ['worktree', 'remove', worktreePath],
              cwd: '.',
              timeoutMs: 1000,
              env: { inherit: false },
            });
          }
        },
      },
    });
    stages[STAGE_NAMES.indexOf('worktree')] = {
      name: 'worktree',
      run: async (context) => {
        context.run.environment = { ...context.run.environment, worktreePath: '/tmp/wt' };
        return { status: 'ok' };
      },
    };

    const result = await runPipeline({
      runId: 'run-20260831T200000Z-a3f9',
      epic: 'epic-3',
      baseSha: 'b'.repeat(40),
      headSha: 'c'.repeat(40),
      environment: ENVIRONMENT,
      clock: new FixedClock('2026-08-31T20:00:00.000Z'),
      stages,
    });

    expect(spawns).toBe(1);
    // And the forbidden runner threw inside teardown, which the pipeline records without
    // touching the decided outcome — the always-teardown rule, observed end to end.
    expect(result.outcome).toEqual({ verdict: 'PASS' });
    expect(statusOf(result, 'teardown')).toBe('error');
  });

  it('records the contract summary, whose PRESENCE is fingerprint validity', async () => {
    const { result } = await verify(() => frozenContract());

    expect(result.contract).toEqual({
      epic: 'epic-3',
      version: 1,
      fingerprint: 'f'.repeat(64),
      frozenAt: '2026-08-31T19:00:00.000Z',
      amendments: 0,
      criterionCount: 2,
    });
  });
});

describe('a full gates-only run through the real stages', () => {
  it('passes, runs all eleven stages, and spawns nothing', async () => {
    const { result, spawns, released } = await verify(() => frozenContract());

    expect(result.outcome).toEqual({ verdict: 'PASS' });
    expect(result.stages).toHaveLength(STAGE_NAMES.length);
    expect(result.stages.every((entry) => entry.status === 'ok')).toBe(true);
    expect(spawns).toBe(0);
    // The teardown seam was actually reached, rather than quietly skipped — which is what
    // would make "spawns nothing" true for the wrong reason.
    expect(released).toBe(1);
  });

  it('records every contract criterion as skipped, with its statement (ADR-003, FR-29)', async () => {
    const { result } = await verify(() => frozenContract());

    expect(result.criteria).toEqual([
      {
        criterionId: 'E3-01',
        status: 'skipped',
        statement: 'the health endpoint answers 200',
        severity: 'critical',
      },
      {
        criterionId: 'E3-02',
        status: 'skipped',
        statement: 'the pipeline classifies infra failures as exit 3',
        severity: 'normal',
      },
    ]);
  });

  it('produces an empty providerUsage — verify is AI-free (FR-18, Q66)', async () => {
    const { result } = await verify(() => frozenContract());

    expect(result.providerUsage).toEqual([]);
  });

  it('names the story that fills each placeholder, so a report never implies it passed', async () => {
    const { result } = await verify(() => frozenContract());

    const detailOf = (stage: StageName): string | undefined =>
      result.stages.find((entry) => entry.stage === stage)?.detail;

    expect(detailOf('worktree')).toContain('story 3.1');
    expect(detailOf('gates')).toContain('story 3.4');
    expect(detailOf('persist')).toContain('story 3.5');
    expect(detailOf('setup')).toContain('Epic 4');
  });
});

describe('the resolve stage', () => {
  it('normalises the epic id through the one implementation', async () => {
    const { result } = await verify(() => frozenContract(), { epic: 'EPIC-03' });

    // `3`, `03`, `epic-3` and `EPIC-03` all name one epic, and the run directory, the
    // contract lookup and the report must all spell it the same way.
    expect(result.epic).toBe('epic-3');
  });

  it('lets a malformed epic id propagate as a UsageError — teardown still runs first', async () => {
    // At this depth the edge has already normalised, so this is a programming error, not
    // user input: `usage` is deliberately absent from InfraErrorClassification.
    await expect(verify(() => frozenContract(), { epic: 'not-an-epic' })).rejects.toThrow(
      UsageError,
    );
  });
});

describe('the teardown stage', () => {
  it('is a no-op with nothing to release, rather than a stub that proves nothing', async () => {
    const stage = createTeardownStage();
    const context = {
      runId: 'run-20260831T200000Z-a3f9',
      clock: new FixedClock('2026-08-31T20:00:00.000Z'),
      run: {} as RunAccumulator,
    } as StageContext;

    await expect(stage.run(context)).resolves.toEqual({
      status: 'ok',
      detail: 'nothing to release',
    });
  });

  it('lets a release failure throw, so the pipeline can record it', async () => {
    // Swallowing it here would hide a leaked worktree; the pipeline is what guarantees it
    // does not change the outcome.
    const stage = createTeardownStage({
      release: async () => {
        throw new Error('worktree busy');
      },
    });

    await expect(stage.run({} as StageContext)).rejects.toThrow('worktree busy');
  });
});
