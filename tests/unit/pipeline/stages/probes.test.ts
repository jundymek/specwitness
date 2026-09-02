/**
 * The probes stage (story 4.7) — the stage that makes a criterion result real.
 *
 * Two properties are asserted here that no other suite can reach, because they are about
 * what this stage must NOT do:
 *
 *  - it never calls `aggregate()` and never writes `context.run.outcome` (AD-6);
 *  - it never materialises the `skipped` criteria of a gate-failed run (ADR-003 — the
 *    aggregate stage owns that, and this stage is jumped past entirely when a gate fails).
 *
 * The executors are doubles here on purpose. All three real ones are merged and have their
 * own suites against real sockets and real subprocesses; what is under test in this file is
 * ORCHESTRATION — attempt counting, which probe runs, how several probes become one result
 * — and a double is the only way to make each of those states deterministically.
 * `tests/integration/verify-probes.test.ts` drives the real executors end to end.
 */

import { describe, expect, it } from 'vitest';

import { aggregate } from '../../../../src/domain/verdict.js';
import type {
  ContractCriterionRef,
  ProbeAttempt,
  ProbeRequest,
  SurfaceExecutor,
} from '../../../../src/domain/criterion-result.js';
import { InfraError } from '../../../../src/domain/errors.js';
import type { Evidence } from '../../../../src/domain/evidence.js';
import type { PlanCriterion, ProbeSpec } from '../../../../src/domain/plan.js';
import { resolvePlanData } from '../../../../src/domain/plan-data.js';
import type { CriterionStatus, GateResult } from '../../../../src/domain/result.js';
import { createProbesStage } from '../../../../src/pipeline/stages/probes.js';
import type { ProbeDispatch, ProbesStageDeps } from '../../../../src/pipeline/stages/probes.js';
import { stageContext } from './services.helpers.js';

const AUTOMATED: ContractCriterionRef = {
  criterionId: 'E7-01',
  statement: 'the health endpoint answers 200',
  severity: 'critical',
  verifiability: 'automated',
};

const HUMAN: ContractCriterionRef = {
  criterionId: 'E7-02',
  statement: 'the error copy reads as a person wrote it',
  severity: 'normal',
  verifiability: 'human',
};

const NO_DATA = resolvePlanData({ seed: 'seed0000', bindings: [] });

function shellProbe(id: string, args: readonly string[] = []): ProbeSpec {
  return {
    id,
    surface: 'shell',
    mechanics: { commandId: 'check', args, argumentAllowlist: [...args] },
    assertions: [
      {
        description: 'exits zero',
        target: { source: 'exitCode' },
        comparison: 'equals',
        expected: '0',
      },
    ],
  };
}

function observationProbe(id: string, around?: string): ProbeSpec {
  return {
    id,
    surface: 'observation',
    mechanics: { commandId: 'rows', args: [], ...(around === undefined ? {} : { around }) },
    assertions: [
      {
        description: 'one row appeared',
        target: {
          source: 'jsonPath',
          path: 'count',
          phase: around === undefined ? 'snapshot' : 'delta',
        },
        comparison: 'equals',
        expected: '1',
      },
    ],
  };
}

function automated(criterionId: string, probes: readonly ProbeSpec[]): PlanCriterion {
  return { criterionId, disposition: 'automated', probes };
}

interface AttemptShape {
  readonly satisfied?: boolean;
  readonly execError?: boolean;
}

function attemptFrom(request: ProbeRequest, attempt: number, shape: AttemptShape): ProbeAttempt {
  if (shape.execError === true) {
    return {
      attempt,
      observations: [],
      assertionEvaluations: [],
      evidence: [],
      execError: { message: `${request.criterionId}: the command could not run` },
      durationMs: 1,
    };
  }
  return {
    attempt,
    observations: [{ name: 'exitCode', value: '0' }],
    assertionEvaluations: [
      {
        description: 'exits zero',
        satisfied: shape.satisfied !== false,
        expected: '0',
        actual: shape.satisfied === false ? '7' : '0',
      },
    ],
    evidence: [],
    durationMs: 1,
  };
}

function statusOf(shape: AttemptShape): CriterionStatus {
  if (shape.execError === true) {
    return 'error';
  }
  return shape.satisfied === false ? 'fail' : 'pass';
}

interface Scripted {
  readonly deps: ProbesStageDeps;
  /** Every `{probeId, attempt}` the stage dispatched, in order. */
  readonly dispatched: { probeId: string; attempt: number; surface: string }[];
}

/**
 * A stage wired to a dispatcher whose executors return scripted outcomes per probe id.
 *
 * `recordEvidence` is deliberately NOT modelled here: it is a dependency of the real
 * executors, bound at the CLI edge, and its wiring is asserted end to end in
 * `tests/integration/verify-probes.test.ts` where a renderer actually reads it.
 */
function scripted(
  criteria: readonly PlanCriterion[],
  script: Readonly<Record<string, readonly AttemptShape[]>>,
  options: Partial<ProbesStageDeps> = {},
): Scripted {
  const dispatched: { probeId: string; attempt: number; surface: string }[] = [];

  const deps: ProbesStageDeps = {
    criteria,
    data: NO_DATA,
    dispatch: ({ probe, attempt }): ProbeDispatch => {
      dispatched.push({ probeId: probe.id, attempt, surface: probe.surface });
      const shapes = script[probe.id] ?? [{}];
      const shape = shapes[Math.min(attempt - 1, shapes.length - 1)] as AttemptShape;

      const executor: SurfaceExecutor = {
        surface: probe.surface,
        execute: async (request) => attemptFrom(request, attempt, shape),
      };
      return { executor, params: { probe } };
    },
    ...options,
  };

  return { deps, dispatched };
}

describe('the probes stage — orchestration', () => {
  it('is a no-op that says so when no plan is wired', async () => {
    const context = stageContext();

    const result = await createProbesStage().run(context);

    expect(result.status).toBe('ok');
    expect(result.detail).toContain('no plan');
    expect(context.run.criteria).toEqual([]);
  });

  it('derives one result per planned criterion, through the single producer', async () => {
    const context = stageContext();
    context.run.contractCriteria.push(AUTOMATED);
    const { deps } = scripted([automated('E7-01', [shellProbe('p1')])], { p1: [{}] });

    const result = await createProbesStage(deps).run(context);

    expect(result.status).toBe('ok');
    expect(context.run.criteria).toHaveLength(1);
    expect(context.run.criteria[0]?.criterionId).toBe('E7-01');
    expect(context.run.criteria[0]?.status).toBe('pass');
    // Copied verbatim from the frozen contract, never synthesised (FR-29).
    expect(context.run.criteria[0]?.statement).toBe(AUTOMATED.statement);
  });

  it('NEVER writes context.run.outcome — AD-6 gives that to the aggregate stage alone', async () => {
    const context = stageContext();
    context.run.contractCriteria.push(AUTOMATED);
    const { deps } = scripted([automated('E7-01', [shellProbe('p1')])], {
      p1: [{ satisfied: false }],
    });

    await createProbesStage(deps).run(context);

    expect(context.run.criteria[0]?.status).toBe('fail');
    expect(context.run.outcome).toBeUndefined();
  });

  it('reports a failing probe as a stage `ok` — a criterion fail is not a stage failure', async () => {
    // Only the GATES stage returns `product-negative`; a failing criterion is data the
    // aggregate stage converts. A `product-negative` here would stop the pipeline early
    // and skip the remaining criteria, which is exactly the report FR-29 must not produce.
    const context = stageContext();
    context.run.contractCriteria.push(AUTOMATED, { ...AUTOMATED, criterionId: 'E7-03' });
    const { deps } = scripted(
      [automated('E7-01', [shellProbe('a')]), automated('E7-03', [shellProbe('b')])],
      { a: [{ satisfied: false }], b: [{}] },
    );

    const result = await createProbesStage(deps).run(context);

    expect(result.status).toBe('ok');
    expect(context.run.criteria.map((criterion) => criterion.status)).toEqual(['fail', 'pass']);
  });

  it('does NOT materialise skipped criteria the plan did not plan (ADR-003)', async () => {
    // The aggregate stage completes the criterion set, and it does so because a gate
    // failure jumps past this stage entirely. Producing them here would leave them
    // missing from exactly the run whose report must show every criterion as `skipped`.
    const context = stageContext();
    context.run.contractCriteria.push(AUTOMATED, { ...AUTOMATED, criterionId: 'E7-09' });
    const { deps } = scripted([automated('E7-01', [shellProbe('p1')])], { p1: [{}] });

    await createProbesStage(deps).run(context);

    expect(context.run.criteria.map((criterion) => criterion.criterionId)).toEqual(['E7-01']);
  });
});

describe('the probes stage — retries (AD-9, Q43/Q44)', () => {
  it('runs exactly one attempt per probe by default', async () => {
    const context = stageContext();
    context.run.contractCriteria.push(AUTOMATED);
    const { deps, dispatched } = scripted([automated('E7-01', [shellProbe('p1')])], { p1: [{}] });

    await createProbesStage(deps).run(context);

    expect(dispatched).toEqual([{ probeId: 'p1', attempt: 1, surface: 'shell' }]);
  });

  it('is opt-in per probe class: a surface with no policy still runs once', async () => {
    const context = stageContext();
    context.run.contractCriteria.push(AUTOMATED);
    const { deps, dispatched } = scripted(
      [automated('E7-01', [shellProbe('p1'), observationProbe('p2')])],
      { p1: [{}], p2: [{}] },
      { retries: (surface) => (surface === 'shell' ? 2 : 0) },
    );

    await createProbesStage(deps).run(context);

    expect(dispatched.filter((d) => d.probeId === 'p1').map((d) => d.attempt)).toEqual([1, 2, 3]);
    expect(dispatched.filter((d) => d.probeId === 'p2').map((d) => d.attempt)).toEqual([1]);
  });

  it('marks a pass that only happened on retry as flaky — never the reverse (FR-32)', async () => {
    const context = stageContext();
    context.run.contractCriteria.push(AUTOMATED);
    const { deps } = scripted(
      [automated('E7-01', [shellProbe('p1')])],
      { p1: [{ satisfied: false }, {}] },
      { retries: () => 1 },
    );

    await createProbesStage(deps).run(context);

    expect(context.run.criteria[0]?.status).toBe('pass');
    expect(context.run.criteria[0]?.flaky).toBe(true);
  });

  it('a pass then a fail is a FAILURE, not flake', async () => {
    const context = stageContext();
    context.run.contractCriteria.push(AUTOMATED);
    const { deps } = scripted(
      [automated('E7-01', [shellProbe('p1')])],
      { p1: [{}, { satisfied: false }] },
      { retries: () => 1 },
    );

    await createProbesStage(deps).run(context);

    expect(context.run.criteria[0]?.status).toBe('fail');
    expect(context.run.criteria[0]?.flaky).toBeUndefined();
  });
});

describe('the probes stage — several probes, one criterion', () => {
  it('runs every probe: probe 2 still executes after probe 1 fails', async () => {
    // A repair agent reads evidence (FR-28, AR-4). Withholding probe 2's because probe 1
    // failed hides half of what the operator needs.
    const context = stageContext();
    context.run.contractCriteria.push(AUTOMATED);
    const { deps, dispatched } = scripted(
      [automated('E7-01', [shellProbe('a'), shellProbe('b')])],
      { a: [{ satisfied: false }], b: [{}] },
    );

    await createProbesStage(deps).run(context);

    expect(dispatched.map((d) => d.probeId)).toEqual(['a', 'b']);
  });

  it.each([
    {
      name: 'a fail outranks a pass',
      script: { a: [{ satisfied: false }], b: [{}] },
      expected: 'fail',
    },
    {
      name: 'an error outranks a pass',
      script: { a: [{ execError: true }], b: [{}] },
      expected: 'error',
    },
    {
      name: 'a fail outranks an error — fail evidence outranks infra uncertainty (PRD §9)',
      script: { a: [{ execError: true }], b: [{ satisfied: false }] },
      expected: 'fail',
    },
    { name: 'all passing is a pass', script: { a: [{}], b: [{}] }, expected: 'pass' },
  ])('$name', async ({ script, expected }) => {
    const context = stageContext();
    context.run.contractCriteria.push(AUTOMATED);
    const { deps } = scripted([automated('E7-01', [shellProbe('a'), shellProbe('b')])], script);

    await createProbesStage(deps).run(context);

    expect(context.run.criteria).toHaveLength(1);
    expect(context.run.criteria[0]?.status).toBe(expected);
  });

  it('agrees with domain/verdict.ts, which is where that precedence is decided', async () => {
    // PINNING TEST. `PROBE_PRECEDENCE` restates `aggregate()`'s order for one criterion.
    // Two precedence tables that disagree would disagree exactly once, in production, on
    // the run somebody cared about — so this asserts they cannot.
    const combinations: readonly (readonly [AttemptShape, AttemptShape])[] = [
      [{ satisfied: false }, {}],
      [{ execError: true }, {}],
      [{ execError: true }, { satisfied: false }],
      [{}, {}],
    ];

    for (const [first, second] of combinations) {
      const context = stageContext();
      context.run.contractCriteria.push(AUTOMATED);
      const { deps } = scripted([automated('E7-01', [shellProbe('a'), shellProbe('b')])], {
        a: [first],
        b: [second],
      });

      await createProbesStage(deps).run(context);

      const selected = context.run.criteria[0]?.status as CriterionStatus;
      // Two criteria carrying the two probe statuses aggregate to the same answer the one
      // selected status does. Same precedence, expressed two ways.
      const asCriteria = aggregate([] as GateResult[], [
        { criterionId: 'x', status: statusOf(first) },
        { criterionId: 'y', status: statusOf(second) },
      ]);
      const asSelected = aggregate([] as GateResult[], [{ criterionId: 'z', status: selected }]);

      expect(asSelected).toEqual(asCriteria);
    }
  });

  it('carries a flake from any probe up to the criterion (FR-32 is about visibility)', async () => {
    const context = stageContext();
    context.run.contractCriteria.push(AUTOMATED);
    const { deps } = scripted(
      [automated('E7-01', [shellProbe('a'), shellProbe('b')])],
      { a: [{}, {}], b: [{ satisfied: false }, {}] },
      { retries: () => 1 },
    );

    await createProbesStage(deps).run(context);

    expect(context.run.criteria[0]?.status).toBe('pass');
    expect(context.run.criteria[0]?.flaky).toBe(true);
  });
});

describe('the probes stage — human and needs-human criteria', () => {
  it('a `verifiability: human` criterion is NEEDS_HUMAN even where its probes passed', async () => {
    // The Epic 3 defect one epic later. A plan cannot legally carry probes for a human
    // criterion, but a hand-edited plan on disk can — and the answer must not change.
    const context = stageContext();
    context.run.contractCriteria.push(HUMAN);
    const { deps } = scripted([automated('E7-02', [shellProbe('p1')])], { p1: [{}] });

    await createProbesStage(deps).run(context);

    expect(context.run.criteria[0]?.status).toBe('needs_human');
  });

  it('a plan that refused to automate a criterion yields NEEDS_HUMAN, never skipped', async () => {
    // Q38's `not-safely-automatable`, Q39's second trigger. `skipped` is inert, so
    // reporting it that way turns a recorded refusal into a silent PASS.
    const context = stageContext();
    context.run.contractCriteria.push(AUTOMATED);
    const { deps } = scripted(
      [
        {
          criterionId: 'E7-01',
          disposition: 'needs-human',
          reason: 'not-safely-automatable',
          guidance: 'check the invoice totals by hand against the ledger',
        },
      ],
      {},
    );

    await createProbesStage(deps).run(context);

    expect(context.run.criteria[0]?.status).toBe('needs_human');
  });

  it('executes nothing at all for a needs-human criterion', async () => {
    const context = stageContext();
    context.run.contractCriteria.push(AUTOMATED);
    const { deps, dispatched } = scripted(
      [
        {
          criterionId: 'E7-01',
          disposition: 'needs-human',
          reason: 'not-safely-automatable',
          guidance: 'check by hand',
        },
      ],
      {},
    );

    await createProbesStage(deps).run(context);

    expect(dispatched).toEqual([]);
  });
});

describe("the probes stage — an observation's `around`", () => {
  it('runs the wrapped probe exactly once, inside its wrapper', async () => {
    // Running it in the ordinary loop AS WELL would perform the action twice, and the
    // second one would be measured by nothing.
    const context = stageContext();
    context.run.contractCriteria.push(AUTOMATED);

    const order: string[] = [];
    const deps: ProbesStageDeps = {
      criteria: [
        automated('E7-01', [shellProbe('action'), observationProbe('watch', 'action')]),
      ],
      data: NO_DATA,
      dispatch: ({ probe, attempt, runAction }) => ({
        params: {},
        executor: {
          surface: probe.surface,
          execute: async (request) => {
            order.push(`${probe.id}:start`);
            if (probe.surface === 'observation' && probe.mechanics.around !== undefined) {
              await runAction(probe.mechanics.around);
            }
            order.push(`${probe.id}:end`);
            return attemptFrom(request, attempt, {});
          },
        },
      }),
    };

    await createProbesStage(deps).run(context);

    expect(order).toEqual(['watch:start', 'action:start', 'action:end', 'watch:end']);
  });

  it("derives the wrapped probe's own assertions from the attempt it produced", async () => {
    const context = stageContext();
    context.run.contractCriteria.push(AUTOMATED);
    const deps: ProbesStageDeps = {
      criteria: [
        automated('E7-01', [shellProbe('action'), observationProbe('watch', 'action')]),
      ],
      data: NO_DATA,
      dispatch: ({ probe, attempt, runAction }) => ({
        params: {},
        executor: {
          surface: probe.surface,
          execute: async (request) => {
            if (probe.surface === 'observation' && probe.mechanics.around !== undefined) {
              await runAction(probe.mechanics.around);
              return attemptFrom(request, attempt, {});
            }
            // The wrapped action FAILS its own assertion. The criterion must see it.
            return attemptFrom(request, attempt, { satisfied: false });
          },
        },
      }),
    };

    await createProbesStage(deps).run(context);

    expect(context.run.criteria[0]?.status).toBe('fail');
  });

  it('runs a SHARED action exactly once, with both wrappers surrounding it', async () => {
    // 4.2's schema explicitly permits two observations around one action and calls it "the
    // case that actually occurs (rows created AND audit rows written, around one request)".
    // Running the action once per wrapper duplicates its writes AND makes the second
    // observation measure a state the FIRST action already changed — so both of its
    // snapshots are wrong, silently, in the direction of a passing delta.
    const context = stageContext();
    context.run.contractCriteria.push(AUTOMATED);

    const order: string[] = [];
    const deps: ProbesStageDeps = {
      criteria: [
        automated('E7-01', [
          shellProbe('action'),
          observationProbe('rows', 'action'),
          observationProbe('audit', 'action'),
        ]),
      ],
      data: NO_DATA,
      dispatch: ({ probe, attempt, runAction }) => ({
        params: {},
        executor: {
          surface: probe.surface,
          execute: async (request) => {
            if (probe.surface === 'observation' && probe.mechanics.around !== undefined) {
              order.push(`${probe.id}:before`);
              await runAction(probe.mechanics.around);
              order.push(`${probe.id}:after`);
              return attemptFrom(request, attempt, {});
            }
            order.push(`${probe.id}:run`);
            return attemptFrom(request, attempt, {});
          },
        },
      }),
    };

    await createProbesStage(deps).run(context);

    // Exactly one execution of the action...
    expect(order.filter((entry) => entry === 'action:run')).toEqual(['action:run']);
    // ...and BOTH observations really surround it: every `before` precedes it and every
    // `after` follows it. Asserted as a property rather than as one literal ordering,
    // because the two wrappers' snapshots may interleave with each other and that is fine.
    const actionAt = order.indexOf('action:run');
    for (const probeId of ['rows', 'audit']) {
      expect(order.indexOf(`${probeId}:before`)).toBeLessThan(actionAt);
      expect(order.indexOf(`${probeId}:after`)).toBeGreaterThan(actionAt);
    }
  }, 5_000);

  it('derives the shared action from the ONE attempt it produced', async () => {
    const context = stageContext();
    context.run.contractCriteria.push(AUTOMATED);

    const deps: ProbesStageDeps = {
      criteria: [
        automated('E7-01', [
          shellProbe('action'),
          observationProbe('rows', 'action'),
          observationProbe('audit', 'action'),
        ]),
      ],
      data: NO_DATA,
      dispatch: ({ probe, attempt, runAction }) => ({
        params: {},
        executor: {
          surface: probe.surface,
          execute: async (request) => {
            if (probe.surface === 'observation' && probe.mechanics.around !== undefined) {
              await runAction(probe.mechanics.around);
              return attemptFrom(request, attempt, {});
            }
            // The shared action FAILS its own assertion. One attempt, one result.
            return attemptFrom(request, attempt, { satisfied: false });
          },
        },
      }),
    };

    await createProbesStage(deps).run(context);

    expect(context.run.criteria[0]?.status).toBe('fail');
  });

  it('never runs the action when EVERY wrapper fails before reaching it', async () => {
    // 4.5 aborts a wrapping observation before the action when its "before" snapshot fails:
    // performing it would mutate the system for a comparison that can no longer be made. So
    // a wrapper can finish WITHOUT arriving, and the shared-action coordination must not
    // wait for an arrival that will never come — a deadlock here would hang the whole run.
    const context = stageContext();
    context.run.contractCriteria.push(AUTOMATED);

    const order: string[] = [];
    const deps: ProbesStageDeps = {
      criteria: [
        automated('E7-01', [
          shellProbe('action'),
          observationProbe('rows', 'action'),
          observationProbe('audit', 'action'),
        ]),
      ],
      data: NO_DATA,
      dispatch: ({ probe, attempt }) => ({
        params: {},
        executor: {
          surface: probe.surface,
          execute: async (request) => {
            order.push(probe.id);
            // Both wrappers fail their "before" and return without calling `runAction`.
            return attemptFrom(request, attempt, { execError: true });
          },
        },
      }),
    };

    await createProbesStage(deps).run(context);

    expect(order).not.toContain('action');
    expect(context.run.criteria[0]?.status).toBe('error');
  }, 5_000);

  it('still runs the action when only SOME wrappers reach it', async () => {
    // One wrapper aborts before the action, the other does not. The action must still run
    // exactly once, for the wrapper that got there.
    const context = stageContext();
    context.run.contractCriteria.push(AUTOMATED);

    const order: string[] = [];
    const deps: ProbesStageDeps = {
      criteria: [
        automated('E7-01', [
          shellProbe('action'),
          observationProbe('rows', 'action'),
          observationProbe('audit', 'action'),
        ]),
      ],
      data: NO_DATA,
      dispatch: ({ probe, attempt, runAction }) => ({
        params: {},
        executor: {
          surface: probe.surface,
          execute: async (request) => {
            if (probe.id === 'audit') {
              return attemptFrom(request, attempt, { execError: true });
            }
            if (probe.surface === 'observation') {
              await runAction('action');
              return attemptFrom(request, attempt, {});
            }
            order.push('action:run');
            return attemptFrom(request, attempt, {});
          },
        },
      }),
    };

    await createProbesStage(deps).run(context);

    expect(order).toEqual(['action:run']);
  }, 5_000);

  it('re-runs the shared action on a RETRY, once per cycle, and never hangs', async () => {
    // Retries are opt-in per probe class and today resolve to zero everywhere, so this is
    // unreachable from a compiled plan — but the API exists, and the failure it had was
    // TOTAL: the second `runAction` of a retried wrapper queued a waiter after the barrier
    // had already fired, so nothing ever woke it and the probes stage hung forever with no
    // timeout anywhere in the product to end it. A retry means "do the whole measured
    // interaction again", so each attempt is its own cycle with its own single action.
    const context = stageContext();
    context.run.contractCriteria.push(AUTOMATED);

    const order: string[] = [];
    const deps: ProbesStageDeps = {
      criteria: [
        automated('E7-01', [
          shellProbe('action'),
          observationProbe('rows', 'action'),
          observationProbe('audit', 'action'),
        ]),
      ],
      data: NO_DATA,
      retries: (surface) => (surface === 'observation' ? 1 : 0),
      dispatch: ({ probe, attempt, runAction }) => ({
        params: {},
        executor: {
          surface: probe.surface,
          execute: async (request) => {
            if (probe.surface === 'observation' && probe.mechanics.around !== undefined) {
              await runAction(probe.mechanics.around);
              return attemptFrom(request, attempt, {});
            }
            order.push(`action:${attempt}`);
            return attemptFrom(request, attempt, {});
          },
        },
      }),
    };

    await createProbesStage(deps).run(context);

    // Two cycles, one action each — not one action, and not four.
    expect(order).toEqual(['action:1', 'action:2']);
  }, 5_000);

  it('keeps a shared retry honest: a flake in the wrappers still reads as flaky', async () => {
    const context = stageContext();
    context.run.contractCriteria.push(AUTOMATED);

    let cycle = 0;
    const deps: ProbesStageDeps = {
      criteria: [
        automated('E7-01', [shellProbe('action'), observationProbe('rows', 'action'), observationProbe('audit', 'action')]),
      ],
      data: NO_DATA,
      retries: (surface) => (surface === 'observation' ? 1 : 0),
      dispatch: ({ probe, attempt, runAction }) => ({
        params: {},
        executor: {
          surface: probe.surface,
          execute: async (request) => {
            if (probe.surface === 'observation' && probe.mechanics.around !== undefined) {
              await runAction(probe.mechanics.around);
              // Both wrappers fail on the first cycle and pass on the second.
              return attemptFrom(request, attempt, { satisfied: attempt !== 1 });
            }
            cycle += 1;
            return attemptFrom(request, attempt, {});
          },
        },
      }),
    };

    await createProbesStage(deps).run(context);

    expect(cycle).toBe(2);
    expect(context.run.criteria[0]?.status).toBe('pass');
    expect(context.run.criteria[0]?.flaky).toBe(true);
  }, 5_000);

  it('refuses a dangling `around` as infrastructure, never as a product fail', async () => {
    const context = stageContext();
    context.run.contractCriteria.push(AUTOMATED);
    const deps: ProbesStageDeps = {
      criteria: [automated('E7-01', [observationProbe('watch', 'missing')])],
      data: NO_DATA,
      dispatch: ({ probe, attempt, runAction }) => ({
        params: {},
        executor: {
          surface: probe.surface,
          execute: async (request) => {
            await runAction('missing');
            return attemptFrom(request, attempt, {});
          },
        },
      }),
    };

    await expect(createProbesStage(deps).run(context)).rejects.toBeInstanceOf(InfraError);
  });
});

describe('the probes stage — data substitution happens before the executor sees anything', () => {
  it('substitutes args AND argumentAllowlist together (4.3), never one without the other', async () => {
    // Substituting only `args` compares a resolved value against a literal `{{name}}`, so
    // every data-bound probe rejects forever. 4.3 caught this; the seam is here.
    const context = stageContext();
    context.run.contractCriteria.push(AUTOMATED);
    const data = resolvePlanData({
      seed: 'seed0000',
      bindings: [{ kind: 'fixed', name: 'tenant', value: 'acme-42' }],
    });

    let seen: ProbeSpec | undefined;
    const deps: ProbesStageDeps = {
      criteria: [automated('E7-01', [shellProbe('p1', ['--tenant={{tenant}}'])])],
      data,
      dispatch: ({ probe, attempt }) => {
        seen = probe;
        return {
          params: {},
          executor: {
            surface: probe.surface,
            execute: async (request) => attemptFrom(request, attempt, {}),
          },
        };
      },
    };

    await createProbesStage(deps).run(context);

    expect(seen?.surface).toBe('shell');
    const mechanics = (
      seen as {
        mechanics: { args: readonly string[]; argumentAllowlist: readonly string[] };
      }
    ).mechanics;
    expect(mechanics.args).toEqual(['--tenant=acme-42']);
    expect(mechanics.argumentAllowlist).toEqual(['--tenant=acme-42']);
  });
});

describe('the probes stage — the plan and the contract must describe the same criteria', () => {
  it('refuses a planned criterion the contract does not declare (exit 3, not a silent drop)', async () => {
    const context = stageContext();
    context.run.contractCriteria.push(AUTOMATED);
    const { deps } = scripted([automated('E7-99', [shellProbe('p1')])], { p1: [{}] });

    await expect(createProbesStage(deps).run(context)).rejects.toBeInstanceOf(InfraError);
  });
});

describe('the probes stage — evidence', () => {
  it("carries the attempt's evidence refs into the derived result (FR-28)", async () => {
    const context = stageContext();
    context.run.contractCriteria.push(AUTOMATED);

    const deps: ProbesStageDeps = {
      criteria: [automated('E7-01', [shellProbe('p1')])],
      data: NO_DATA,
      dispatch: ({ probe, attempt }) => ({
        params: {},
        executor: {
          surface: probe.surface,
          execute: async () => ({
            attempt,
            observations: [],
            assertionEvaluations: [
              { description: 'exits zero', satisfied: false, expected: '0', actual: '7' },
            ],
            evidence: [{ kind: 'command', path: 'evidence/shell-p1-1.json' }],
            durationMs: 3,
          }),
        },
      }),
    };

    await createProbesStage(deps).run(context);

    const criterion = context.run.criteria[0];
    expect(criterion?.status).toBe('fail');
    expect(criterion?.expected).toBe('0');
    expect(criterion?.actual).toBe('7');
    expect(criterion?.evidence).toEqual([{ kind: 'command', path: 'evidence/shell-p1-1.json' }]);
  });

  it('leaves `context.run.evidence` to the executors — this stage pushes none itself', async () => {
    // The typed member reaches the accumulator through each executor's injected
    // `recordEvidence`, bound at the CLI edge. Asserting it here would test the double.
    const context = stageContext();
    context.run.contractCriteria.push(AUTOMATED);
    const before: Evidence[] = [...context.run.evidence];
    const { deps } = scripted([automated('E7-01', [shellProbe('p1')])], { p1: [{}] });

    await createProbesStage(deps).run(context);

    expect(context.run.evidence).toEqual(before);
  });
});
