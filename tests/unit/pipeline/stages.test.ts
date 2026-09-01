import { describe, expect, it } from 'vitest';

import type { Contract } from '../../../src/domain/contract.js';
import { IntegrityError, UsageError } from '../../../src/domain/errors.js';
import type { ProcessRunner } from '../../../src/domain/process-runner.js';
import type { RunEnvironment, RunResult } from '../../../src/domain/run-result.js';
import { STAGE_NAMES } from '../../../src/domain/stage.js';
import type { StageName } from '../../../src/domain/stage.js';
import { EXIT, exitCodeForOutcome } from '../../../src/cli/exit.js';
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
      // A project that declares NO gates — which is what these tests have always
      // exercised, and why they assert PASS with every stage `ok`. Story 3.4's
      // stage distinguishes that (legitimate) case from an unwired composition,
      // which is inconclusive; supplying an empty list says which one this is.
      // `forbiddenProcessRunner` makes the no-spawn assertion STRONGER: with no
      // gates declared nothing should spawn, and now nothing can without failing
      // loudly. (Edit carried by story 3.4 with 3.3's written review and
      // consent — it references `deps.gates`, which does not exist until 3.4
      // lands, so it cannot travel in any earlier commit.)
      gates: { gates: [], runner: forbiddenProcessRunner(), writeEvidence: async (name) => name },
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
      // No gates declared — see the note in `verify()` above.
      gates: { gates: [], runner: forbidden, writeEvidence: async (name) => name },
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

  it('records every criterion as skipped on the GATE-FAILED path too (ADR-003)', async () => {
    // The case my first version got wrong, and the one ADR-003 is actually about. A gate
    // failure jumps the pipeline straight to aggregate, so `probes` is skipped by design
    // — which meant the criterion set was materialised only on the path where it did not
    // matter, and a gate-failed report listed no criteria at all. Asserting the happy
    // path alone is what hid it.
    const stages = createStages({ assertVerifiableContract: () => frozenContract() });
    stages[STAGE_NAMES.indexOf('gates')] = {
      name: 'gates',
      run: async (context) => {
        context.run.gates.push({ gateId: 'lint', status: 'fail', durationMs: 12 });
        context.run.gates.push({ gateId: 'build', status: 'skipped' });
        return { status: 'product-negative', detail: "gate 'lint' failed" };
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

    expect(result.outcome).toEqual({ verdict: 'FAIL', gateFailed: 'lint' });
    expect(statusOf(result, 'probes')).toBe('skipped');
    // Every criterion the contract declares is present and skipped — not an empty array.
    expect(result.criteria.map((criterion) => criterion.criterionId)).toEqual([
      'E3-01',
      'E3-02',
    ]);
    expect(result.criteria.every((criterion) => criterion.status === 'skipped')).toBe(true);
    expect(result.criteria[0]?.statement).toBe('the health endpoint answers 200');
  });

  it('keeps criteria in contract order and never drops an undeclared result', async () => {
    // No gates declared — see the note in `verify()` above. Needed here even
    // though this test substitutes the PROBES stage: without it the unwired
    // gates stage ends the run before probes is ever reached.
    const stages = createStages({
      assertVerifiableContract: () => frozenContract(),
      gates: { gates: [], runner: forbiddenProcessRunner(), writeEvidence: async (name) => name },
    });
    stages[STAGE_NAMES.indexOf('probes')] = {
      name: 'probes',
      run: async (context) => {
        // Resolved out of contract order, plus one the contract does not declare — which
        // should be kept rather than silently dropped, so the bug that produced it shows
        // up in the report instead of vanishing.
        context.run.criteria = [
          { criterionId: 'E3-02', status: 'pass', statement: 'second', severity: 'normal' },
          { criterionId: 'E3-99', status: 'pass', statement: 'stray', severity: 'normal' },
        ];
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

    expect(result.criteria.map((criterion) => criterion.criterionId)).toEqual([
      'E3-01',
      'E3-02',
      'E3-99',
    ]);
    expect(result.criteria[0]?.status).toBe('skipped');
    expect(result.criteria[1]?.status).toBe('pass');
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
    // `gates` was here and is deliberately gone, for the same reason `persist`
    // is (see below): the assertion existed to prove a PLACEHOLDER announces
    // which story fills it, and story 3.4 filling it is that assertion coming
    // true. Re-adding a gates row to check the new stage's wording would test
    // 3.4's strings from 3.3's file, which is worse than not testing them.
    expect(detailOf('setup')).toContain('Epic 4');
    // `persist` was on this list until story 3.5 filled it. A stage that is implemented
    // no longer names a story to come — it reports what it actually did — so the shrinking
    // of this list is how a placeholder being replaced becomes visible. 3.1 and 3.4 remove
    // their own lines the same way.
    expect(detailOf('persist')).not.toContain('story 3.5');
  });

  it('ends a run assembled WITHOUT a gate runner at exit 3, never at PASS', async () => {
    // Named directly rather than left implicit. Everything above proves the fix
    // by the ABSENCE of a green run, and an absence is what somebody restores an
    // `ok` return over in six months because "it was harmless". This is the
    // property itself: `aggregate()` over an empty gate set returns PASS, so a
    // gates stage that returned `ok` when no runner was wired produced a green
    // verdict for a branch on which nothing had been checked — and a harness
    // reads the verdict, not the timeline detail beside it.
    //
    // Note what this does NOT say: a project that declares no gates is still a
    // legitimate PASS, which every other test in this describe relies on. Only
    // an absent RUNNER is inconclusive.
    const result = await runPipeline({
      runId: 'run-20260831T200000Z-a3f9',
      epic: 'epic-3',
      baseSha: 'b'.repeat(40),
      headSha: 'c'.repeat(40),
      environment: ENVIRONMENT,
      clock: new FixedClock('2026-08-31T20:00:00.000Z'),
      stages: createStages({ assertVerifiableContract: () => frozenContract() }),
    });

    expect(result.outcome).toEqual({ infraError: 'infra' });
    expect(result.outcome.verdict).toBeUndefined();
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
    const context: StageContext = {
      runId: 'run-20260831T200000Z-a3f9',
      clock: new FixedClock('2026-08-31T20:00:00.000Z'),
      run: {} as RunAccumulator,
      snapshot: () => {
        throw new Error('the teardown stage must not need a snapshot');
      },
    };

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

describe('a contract with a human criterion reaches NEEDS_HUMAN (Q39, exit 2)', () => {
  // The arm of the exit table Epic 3 could not otherwise reach, and story 3.7 proves it
  // live through the built binary. Before this fix the same contract verified PASS at
  // exit 0: `verifiability` was dropped at the integrity stage, so a human criterion
  // derived as `skipped`, and `skipped` is inert in aggregation.

  function contractWithHumanCriterion(): Contract {
    const base = frozenContract();
    return {
      ...base,
      spec: {
        ...base.spec,
        criteria: [
          ...base.spec.criteria,
          {
            id: 'E3-09',
            statement: 'the error copy reads as a human wrote it',
            kind: 'human',
            severity: 'normal',
            verifiability: 'human',
          },
        ],
      },
    };
  }

  it('ends NEEDS_HUMAN, which maps to exit 2', async () => {
    const { result } = await verify(() => contractWithHumanCriterion());

    expect(result.outcome).toEqual({ verdict: 'NEEDS_HUMAN' });
    expect(exitCodeForOutcome(result.outcome)).toBe(EXIT.NEEDS_HUMAN);
  });

  it('reports the human criterion as needs_human and the rest as skipped', async () => {
    const { result } = await verify(() => contractWithHumanCriterion());

    const statuses = Object.fromEntries(
      result.criteria.map((criterion) => [criterion.criterionId, criterion.status]),
    );

    expect(statuses).toEqual({ 'E3-01': 'skipped', 'E3-02': 'skipped', 'E3-09': 'needs_human' });
  });

  it('still PASSes at exit 0 when every criterion is automated', async () => {
    // The other half, so the fix cannot be "everything is needs_human now".
    const { result } = await verify(() => frozenContract());

    expect(result.outcome).toEqual({ verdict: 'PASS' });
    expect(exitCodeForOutcome(result.outcome)).toBe(EXIT.PASS);
  });

  it('spawns nothing to decide it — it is a fact about the contract', async () => {
    const { result, spawns } = await verify(() => contractWithHumanCriterion());

    expect(result.outcome.verdict).toBe('NEEDS_HUMAN');
    expect(spawns).toBe(0);
  });
});

describe('the tampered-contract remedy reaches the run (story 3.7 finding)', () => {
  it('carries story 2.6 hint, and it does not say --freeze', async () => {
    // Why this is not cosmetic. Told only that content "no longer matches", the obvious
    // next move for an operator is `--freeze` — which launders the tamper and destroys
    // the only evidence it happened. ADR-005 exists to prevent exactly that, and 2.6's
    // hint is how it is prevented in practice: inspect the diff, `--amend` if the change
    // is legitimate, otherwise restore from Git. Before this fix it never left the stage.
    const tampered: LoadedContract = {
      present: true,
      epic: 'epic-3',
      path: '.specwitness/contracts/epic-3.yaml',
      contract: { ...frozenContract(), spec: { ...frozenContract().spec, version: 99 } },
    };

    const { result } = await verify(() => assertVerifiableContract(tampered));
    const entry = result.stages.find((candidate) => candidate.stage === 'integrity');

    expect(result.outcome).toEqual({ infraError: 'integrity' });
    expect(entry?.hint).toContain('--amend');
    expect(entry?.hint).not.toContain('--freeze');
  });

  it('gives the never-frozen contract its OWN hint, which DOES say --freeze', async () => {
    // The distinction 2.6 built three refusals for: a draft should be frozen, a tamper
    // must not be. Both classify `integrity`; only the hints tell them apart, so the
    // hints have to survive.
    const draft: LoadedContract = {
      present: true,
      epic: 'epic-3',
      path: '.specwitness/contracts/epic-3.yaml',
      contract: {
        ...frozenContract(),
        meta: { ...frozenContract().meta, frozen: false, fingerprint: null, frozenAt: null },
      },
    };

    const { result } = await verify(() => assertVerifiableContract(draft));
    const entry = result.stages.find((candidate) => candidate.stage === 'integrity');

    expect(entry?.hint).toContain('--freeze');
  });

  it('gives the absent contract its own hint too', async () => {
    const absent: LoadedContract = {
      present: false,
      epic: 'epic-3',
      path: '.specwitness/contracts/epic-3.yaml',
    };

    const { result } = await verify(() => assertVerifiableContract(absent));
    const entry = result.stages.find((candidate) => candidate.stage === 'integrity');

    expect(entry?.hint).toContain('specwitness contract');
  });
});
