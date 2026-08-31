import { describe, expect, it } from 'vitest';

import {
  ConfigError,
  InfraError,
  IngestError,
  IntegrityError,
  ProviderError,
  UsageError,
} from '../../../src/domain/errors.js';
import { STAGE_NAMES } from '../../../src/domain/stage.js';
import type { StageName } from '../../../src/domain/stage.js';
import type { RunEnvironment, RunResult } from '../../../src/domain/run-result.js';
import { classifyInfraError, runPipeline } from '../../../src/pipeline/run-pipeline.js';
import { createAggregateStage } from '../../../src/pipeline/stages/aggregate.js';
import { stageOk, stageProductNegative } from '../../../src/pipeline/stage.js';
import type { Stage, StageResult } from '../../../src/pipeline/stage.js';
import { FixedClock } from '../../fakes/ports.js';

/**
 * Every test here drives the state machine with FAKE stages: zero subprocesses, zero
 * filesystem access, no wall clock and no randomness (AC3). Nothing in this file imports
 * `node:fs`, and the only clock is `FixedClock`, which makes durations exact integers
 * rather than "greater than zero" — the assertion that still passes when a clock is read
 * once and reused.
 */

const ENVIRONMENT: RunEnvironment = {
  nodeVersion: 'v22.12.0',
  platform: 'darwin',
  arch: 'arm64',
  specwitnessVersion: '0.1.0',
  worktreePath: null,
  runDirectory: '.specwitness/runs/run-20260831T200000Z-a3f9',
};

/** A stage that records that it ran and returns whatever it was told to. */
function fakeStage(
  name: StageName,
  ran: StageName[],
  behaviour: () => Promise<StageResult> = async () => stageOk(),
): Stage {
  return {
    name,
    run: async () => {
      ran.push(name);
      return behaviour();
    },
  };
}

/** The eleven, in order, all inert — with named overrides swapped in. */
function stagesWith(
  ran: StageName[],
  overrides: Partial<Record<StageName, Stage>> = {},
): readonly Stage[] {
  return STAGE_NAMES.map((name) => overrides[name] ?? fakeStage(name, ran));
}

/** Wraps a REAL stage so it still shows up in the execution-order recorder. */
function instrumented(stage: Stage, ran: StageName[]): Stage {
  return {
    name: stage.name,
    run: async (context) => {
      ran.push(stage.name);
      return stage.run(context);
    },
  };
}

/** An aggregate fake that decides PASS, standing in for the real one where it is not under test. */
function passingAggregate(ran: StageName[]): Stage {
  return {
    name: 'aggregate',
    run: async (context) => {
      ran.push('aggregate');
      context.run.outcome = { verdict: 'PASS' };
      return stageOk();
    },
  };
}

function run(
  stages: readonly Stage[],
  overrides: Partial<Parameters<typeof runPipeline>[0]> = {},
): Promise<RunResult> {
  return runPipeline({
    runId: 'run-20260831T200000Z-a3f9',
    epic: 'epic-3',
    baseSha: 'b'.repeat(40),
    headSha: 'c'.repeat(40),
    environment: ENVIRONMENT,
    clock: new FixedClock('2026-08-31T20:00:00.000Z'),
    stages,
    ...overrides,
  });
}

const statusOf = (result: RunResult, stage: StageName): string | undefined =>
  result.stages.find((entry) => entry.stage === stage)?.status;

describe('runPipeline — the happy path', () => {
  it('runs all eleven stages in order and records one timeline entry each', async () => {
    const ran: StageName[] = [];

    const result = await run(stagesWith(ran, { aggregate: passingAggregate(ran) }));

    expect(ran).toEqual([...STAGE_NAMES]);
    expect(result.stages.map((entry) => entry.stage)).toEqual([...STAGE_NAMES]);
    expect(result.stages.every((entry) => entry.status === 'ok')).toBe(true);
    expect(result.outcome).toEqual({ verdict: 'PASS' });
  });

  it('carries the input through to the result', async () => {
    const ran: StageName[] = [];

    const result = await run(stagesWith(ran, { aggregate: passingAggregate(ran) }));

    expect(result.runId).toBe('run-20260831T200000Z-a3f9');
    expect(result.baseSha).toBe('b'.repeat(40));
    expect(result.environment).toEqual(ENVIRONMENT);
    expect(result.startedAt).toBe('2026-08-31T20:00:00.000Z');
    expect(result.finishedAt).toBe('2026-08-31T20:00:00.000Z');
  });

  it('measures durations with the injected Clock, never the wall clock (AD-9)', async () => {
    const ran: StageName[] = [];
    // One instant for startedAt, then two per stage; the last repeats forever. Scripting
    // a 7ms gap for the first stage makes the assertion an exact integer.
    const clock = new FixedClock(
      '2026-08-31T20:00:00.000Z',
      '2026-08-31T20:00:00.000Z',
      '2026-08-31T20:00:00.007Z',
      '2026-08-31T20:00:00.100Z',
    );

    const result = await run(stagesWith(ran, { aggregate: passingAggregate(ran) }), { clock });

    expect(statusOf(result, 'resolve')).toBe('ok');
    expect(result.stages[0]?.durationMs).toBe(7);
    // Every later stage reads the repeating final instant, so its duration is exactly 0 —
    // not "some small number", which is what a real clock would force.
    expect(result.stages[1]?.durationMs).toBe(0);
  });
});

describe('runPipeline — a stage that throws (infrastructure)', () => {
  it.each(STAGE_NAMES.filter((name) => name !== 'teardown'))(
    'stops at %s, skips every later stage, and still runs teardown',
    async (failing) => {
      const ran: StageName[] = [];
      const stages = stagesWith(ran, {
        aggregate: passingAggregate(ran),
        [failing]: fakeStage(failing, ran, async () => {
          throw new InfraError('boom');
        }),
      });

      const result = await run(stages);

      const failedIndex = STAGE_NAMES.indexOf(failing);
      const shouldHaveRun = [...STAGE_NAMES.slice(0, failedIndex + 1), 'teardown'];
      expect(ran).toEqual(shouldHaveRun);

      expect(statusOf(result, failing)).toBe('error');
      for (const skipped of STAGE_NAMES.slice(failedIndex + 1, STAGE_NAMES.length - 1)) {
        expect(statusOf(result, skipped)).toBe('skipped');
      }
      // Teardown always runs — including after an early stop. The worktree and the
      // process group have to be released whatever else happened.
      expect(statusOf(result, 'teardown')).toBe('ok');
      expect(result.outcome).toEqual({ infraError: 'infra' });
      // An infrastructure failure is NEVER a product verdict.
      expect(result.outcome.verdict).toBeUndefined();
    },
  );

  it.each([
    [new ConfigError('bad config'), 'config'],
    [new IngestError('bad artifacts'), 'ingest'],
    [new IntegrityError('tampered'), 'integrity'],
    [new ProviderError('cli died'), 'provider'],
    [new InfraError('worktree gone'), 'infra'],
  ])('classifies %s through the AD-7 hierarchy', async (thrown, expected) => {
    const ran: StageName[] = [];
    const stages = stagesWith(ran, {
      gates: fakeStage('gates', ran, async () => {
        throw thrown;
      }),
    });

    const result = await run(stages);

    expect(result.outcome).toEqual({ infraError: expected });
  });

  it('fails closed: an unrecognised throw classifies as infra, never as a verdict', async () => {
    const ran: StageName[] = [];
    const stages = stagesWith(ran, {
      gates: fakeStage('gates', ran, async () => {
        // The assertion that catches a `switch` a later story extends without a default.
        throw new Error('boom');
      }),
    });

    const result = await run(stages);

    expect(result.outcome).toEqual({ infraError: 'infra' });
  });

  it('redacts a secret that a stage put in its error message', async () => {
    // Timeline details are persisted to result.json and rendered to a terminal, so they
    // are capture in AD-10's sense. A gate that fails while echoing the environment can
    // easily end up with a key in its InfraError message; without redaction here, the
    // error path would quietly bypass the protection that covers evidence beside it.
    const seeded = `ANTHROPIC_API_KEY=${['sk', 'ant', 'api03'].join('-')}-timelineleak`;
    const ran: StageName[] = [];
    const stages = stagesWith(ran, {
      gates: fakeStage('gates', ran, async () => {
        throw new InfraError(`the gate command failed with ${seeded} in its environment`);
      }),
    });

    const result = await run(stages);

    expect(JSON.stringify(result.stages)).not.toContain('timelineleak');
    expect(result.stages.find((entry) => entry.stage === 'gates')?.detail).toContain(
      '[REDACTED]',
    );
  });

  it('records the failure reason in the timeline without leaking a stack trace', async () => {
    const ran: StageName[] = [];
    const stages = stagesWith(ran, {
      integrity: fakeStage('integrity', ran, async () => {
        throw new IntegrityError('the contract was edited after it was frozen');
      }),
    });

    const result = await run(stages);
    const entry = result.stages.find((candidate) => candidate.stage === 'integrity');

    expect(entry?.detail).toContain('the contract was edited after it was frozen');
    expect(entry?.detail).not.toContain('at Object');
  });
});

describe('runPipeline — a stage that returns a product-negative result', () => {
  it('reaches aggregate, persist and teardown, and ends in a FAIL verdict', async () => {
    const ran: StageName[] = [];
    const stages = stagesWith(ran, {
      gates: {
        name: 'gates',
        run: async (context) => {
          ran.push('gates');
          context.run.gates.push({ gateId: 'lint', status: 'fail', durationMs: 40 });
          context.run.gates.push({ gateId: 'build', status: 'skipped' });
          return stageProductNegative("gate 'lint' failed");
        },
      },
      // The REAL aggregate stage: the conversion from stage results to a RunOutcome is
      // the thing under test here, and faking it would prove nothing.
      aggregate: instrumented(createAggregateStage(), ran),
    });

    const result = await run(stages);

    // Not short-circuited past aggregate/persist: a gate failure is a product answer and
    // the run has to produce, persist and report one.
    expect(ran).toEqual(['resolve', 'integrity', 'worktree', 'setup', 'gates', 'aggregate', 'persist', 'teardown']);
    expect(statusOf(result, 'gates')).toBe('failed');
    expect(statusOf(result, 'services')).toBe('skipped');
    expect(statusOf(result, 'probes')).toBe('skipped');
    expect(statusOf(result, 'aggregate')).toBe('ok');
    expect(statusOf(result, 'persist')).toBe('ok');
    expect(statusOf(result, 'teardown')).toBe('ok');

    // Exit 1, not exit 3: the branch does not build, which is a product problem in the
    // branch, not a SpecWitness malfunction.
    expect(result.outcome).toEqual({ verdict: 'FAIL', gateFailed: 'lint' });
    expect(result.outcome.infraError).toBeUndefined();
  });

  it('records the stage as `failed`, which is not the same as `error`', async () => {
    const ran: StageName[] = [];
    const stages = stagesWith(ran, {
      gates: fakeStage('gates', ran, async () => stageProductNegative("gate 'lint' failed")),
      aggregate: passingAggregate(ran),
    });

    const result = await run(stages);

    expect(statusOf(result, 'gates')).toBe('failed');
    expect(result.stages.some((entry) => entry.status === 'error')).toBe(false);
  });
});

describe('runPipeline — teardown', () => {
  it('never lets its own failure overwrite a decided outcome', async () => {
    const ran: StageName[] = [];
    const stages = stagesWith(ran, {
      gates: {
        name: 'gates',
        run: async (context) => {
          ran.push('gates');
          context.run.gates.push({ gateId: 'lint', status: 'fail', durationMs: 40 });
          return stageProductNegative("gate 'lint' failed");
        },
      },
      aggregate: createAggregateStage(),
      teardown: fakeStage('teardown', ran, async () => {
        throw new InfraError('could not remove the worktree');
      }),
    });

    const result = await run(stages);

    // A run that FAILed on a gate and then failed to remove a worktree is still a FAIL.
    // Letting teardown rewrite it to an infra error would make a broken branch look
    // retryable — and a retry is how a broken branch merges.
    expect(result.outcome).toEqual({ verdict: 'FAIL', gateFailed: 'lint' });
    expect(statusOf(result, 'teardown')).toBe('error');
    expect(result.stages.find((entry) => entry.stage === 'teardown')?.detail).toContain(
      'could not remove the worktree',
    );
  });

  it('keeps a PASS a PASS when teardown leaks a worktree, and records the problem', async () => {
    const ran: StageName[] = [];
    const stages = stagesWith(ran, {
      aggregate: passingAggregate(ran),
      teardown: fakeStage('teardown', ran, async () => {
        throw new InfraError('worktree left behind');
      }),
    });

    const result = await run(stages);

    expect(result.outcome).toEqual({ verdict: 'PASS' });
    expect(statusOf(result, 'teardown')).toBe('error');
  });

  it('runs after a thrown error even when every other stage was skipped', async () => {
    const ran: StageName[] = [];
    const stages = stagesWith(ran, {
      resolve: fakeStage('resolve', ran, async () => {
        throw new ConfigError('no config');
      }),
    });

    await run(stages);

    expect(ran).toEqual(['resolve', 'teardown']);
  });
});

describe('runPipeline — the fail-closed guarantees', () => {
  it('refuses a stage list that is not the eleven names in order', async () => {
    const ran: StageName[] = [];
    const reordered = [...stagesWith(ran)].reverse();

    // A silently reordered pipeline would produce a plausible-looking run whose skip
    // semantics are nonsense — worktrees created after gates, teardown first.
    await expect(run(reordered)).rejects.toThrow(InfraError);
  });

  it('refuses a stage list of the wrong length', async () => {
    const ran: StageName[] = [];
    const short = stagesWith(ran).slice(0, 5);

    await expect(run(short)).rejects.toThrow(InfraError);
  });

  it('never returns PASS when the aggregate stage produced no outcome', async () => {
    const ran: StageName[] = [];
    // A broken aggregate must not read as a green run. This is the assertion that
    // catches a future edit dropping the outcome assignment.
    const stages = stagesWith(ran, { aggregate: fakeStage('aggregate', ran, async () => stageOk()) });

    const result = await run(stages);

    expect(result.outcome).toEqual({ infraError: 'infra' });
    expect(statusOf(result, 'aggregate')).toBe('error');
  });

  it('lets a UsageError propagate rather than inventing a classification — after teardown ran', async () => {
    const ran: StageName[] = [];
    const stages = stagesWith(ran, {
      resolve: fakeStage('resolve', ran, async () => {
        throw new UsageError('invalid epic id');
      }),
    });

    // `usage` is deliberately absent from InfraErrorClassification: a UsageError is
    // raised at the CLI edge before a run exists, so one reaching here is a programming
    // error. Teardown still runs — the always-teardown guarantee outranks the rethrow.
    await expect(run(stages)).rejects.toThrow(UsageError);
    expect(ran).toEqual(['resolve', 'teardown']);
  });
});

describe('runPipeline — onComplete, the post-teardown write', () => {
  it('is awaited after teardown with the finished result', async () => {
    const ran: StageName[] = [];
    const seen: RunResult[] = [];

    const result = await run(stagesWith(ran, { aggregate: passingAggregate(ran) }), {
      onComplete: async (finished) => {
        seen.push(finished);
      },
    });

    expect(seen).toHaveLength(1);
    // The point of the callback: the document it receives contains teardown's entry and
    // `finishedAt`, neither of which exists when the persist stage runs at position 10.
    expect(seen[0]?.stages).toHaveLength(11);
    expect(statusOf(seen[0] as RunResult, 'teardown')).toBe('ok');
    expect(seen[0]?.finishedAt).toBe(result.finishedAt);
  });

  it('records its own failure on the persist entry without rewriting the outcome', async () => {
    const ran: StageName[] = [];

    const result = await run(stagesWith(ran, { aggregate: passingAggregate(ran) }), {
      onComplete: async () => {
        throw new InfraError('disk full');
      },
    });

    // Same rule as a teardown failure: a durability write that failed must not turn a
    // decided verdict into a retryable-looking infra error.
    expect(result.outcome).toEqual({ verdict: 'PASS' });
    expect(statusOf(result, 'persist')).toBe('error');
    expect(result.stages.find((entry) => entry.stage === 'persist')?.detail).toContain('disk full');
  });
});

describe('classifyInfraError', () => {
  it('maps every AD-7 class and falls closed to infra', () => {
    expect(classifyInfraError(new ConfigError('x'))).toBe('config');
    expect(classifyInfraError(new IngestError('x'))).toBe('ingest');
    expect(classifyInfraError(new IntegrityError('x'))).toBe('integrity');
    expect(classifyInfraError(new ProviderError('x'))).toBe('provider');
    expect(classifyInfraError(new InfraError('x'))).toBe('infra');
    expect(classifyInfraError(new Error('x'))).toBe('infra');
    expect(classifyInfraError('a thrown string')).toBe('infra');
    expect(classifyInfraError(undefined)).toBe('infra');
  });
});
