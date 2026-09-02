/**
 * The `probes` stage (story 4.7) — where a criterion stops being `skipped`.
 *
 * Every criterion of every run in Epics 1–3 was `skipped`, because nothing executed a
 * plan. This stage executes one: for each planned criterion it resolves the probe's
 * mechanics against the plan's data bindings, hands the probe to the surface executor the
 * caller supplies, collects `ProbeAttempt`s, and calls `deriveCriterionResult` — the ONE
 * producer of a `CriterionStatus` (AD-13).
 *
 * ============================================================================
 * WHAT THIS STAGE DELIBERATELY DOES NOT DO
 * ============================================================================
 *
 * **It never calls `aggregate()` and never writes `context.run.outcome`.** AD-6 gives
 * that job to exactly one converter, and the aggregate stage is it.
 *
 * **It never materialises the `skipped` results of a gate-failed run**, even though this
 * looks like the obvious place. ADR-003: a gate failure stops the pipeline early and
 * jumps PAST this stage, so results produced here would be missing from exactly the run
 * whose report is supposed to show every criterion as `skipped`. `aggregate.ts` records
 * that this was a real defect once and explains the fix; re-deciding it here would
 * reintroduce it. This stage only pushes results for criteria a plan actually planned.
 *
 * **It never resolves a service id, a config command or a URL.** `src/pipeline/**` may
 * not import `src/authoring/**` (AD-1), and the three surface executors may import
 * neither `src/config/**` nor `src/pipeline/**` (`adapters-core-only`). So resolution
 * lives at the CLI edge, and reaches this stage as the injected `dispatch` callback: the
 * edge decides which executor a probe goes to and what `params` it is handed. That is the
 * same seam the contract already uses, one layer down.
 *
 * ============================================================================
 * RETRIES LIVE HERE, NOT IN THE EXECUTORS (AD-9, Q43/Q44)
 * ============================================================================
 *
 * All three merged executors run exactly one attempt per call and never loop; each stamps
 * the 1-based `attempt` its caller supplied. This stage calls an executor N+1 times and
 * hands every attempt to `deriveCriterionResult`, which decides `flaky`. Nothing here
 * decides a status.
 *
 * **Retries are opt-in per probe class and default to 0**, so a run is deterministic
 * unless a project asked otherwise. There is today no field anywhere — not in the Project
 * Config, not in 4.2's frozen Plan schema — in which a project CAN ask, so `retries`
 * resolves to zero for every surface and is injected only by tests. Adding a field is a
 * schema widening and therefore an ADR, not this story's edit; the mechanism is built and
 * proven so that the ADR has nothing left to design.
 *
 * ============================================================================
 * A CRITERION MAY HAVE SEVERAL PROBES, AND ONLY ONE RESULT
 * ============================================================================
 *
 * `PlanCriterionSchema` admits `probes: [...].min(1)`, and `RunResult.criteria` carries
 * one entry per criterion. So several derived results must become one, and the choice of
 * WHICH is a precedence question that `domain/verdict.ts` already answers for the run as
 * a whole: `fail` outranks `error` ("fail evidence outranks infra uncertainty", PRD §9),
 * which outranks `needs_human`, which outranks `pass`. `PROBE_PRECEDENCE` below states
 * the same order for the criterion, and `tests/unit/pipeline/stages/probes.test.ts` pins
 * the two against each other so they cannot drift — a second, quietly different
 * precedence is exactly the "two producers disagree once, in production" this codebase
 * refuses everywhere else.
 *
 * Every probe still RUNS. Stopping at the first non-pass would be cheaper and is what the
 * gates stage does, but a gate's output is one signal whereas a criterion's probes are
 * the evidence a repair agent reads (FR-28, AR-4): withholding probe 2's evidence because
 * probe 1 failed hides half of what the operator needs to fix it.
 *
 * `flaky` is carried up: a criterion whose selected result is a pass is marked flaky if
 * ANY of its probes only passed on retry. FR-32's point is visibility, and a flake that
 * happened in the second of two probes is exactly as worth seeing as one in the first.
 *
 * ============================================================================
 * AN OBSERVATION'S `around` RUNS THE WRAPPED PROBE, AND NOTHING ELSE DOES
 * ============================================================================
 *
 * 4.5's merged model: one `ProbeAttempt` covers both snapshots, and the executor calls an
 * injected `runAction` between them. The wrapped probe is therefore executed INSIDE its
 * wrapper — and so it is skipped in the ordinary loop, because executing it twice would
 * perform its side effect twice and measure a delta the second one caused. Its attempts
 * are still recorded under its own id, so its own assertions are derived exactly as any
 * other probe's are.
 *
 * AD-1: application layer. Imports `domain`, `schemas` and siblings; never `cli`,
 * `authoring`, `ingest` or `report`.
 */

import { deriveCriterionResult } from '../../domain/criterion-result.js';
import type {
  DerivationOptions,
  DerivedCriterionResult,
  ProbeAttempt,
  ProbeSurface,
  SurfaceExecutor,
} from '../../domain/criterion-result.js';
import { InfraError } from '../../domain/errors.js';
import type { Evidence, RedactionOptions } from '../../domain/evidence.js';
import type { PlanCriterion, ProbeSpec } from '../../domain/plan.js';
import { resolveMechanics, type ResolvedData } from '../../domain/plan-data.js';
import type { CriterionStatus } from '../../domain/result.js';
import type { Stage, StageContext, StageResult } from '../stage.js';
import { stageOk } from '../stage.js';

/**
 * Runs the probe an observation wraps, between its two snapshots.
 *
 * Structurally identical to 4.5's `ObservationActionRunner`, declared here rather than
 * imported so that this stage's dependency shape is readable without opening a surface —
 * and so a future surface with the same need does not have to import another one's type.
 */
export type ProbeActionRunner = (aroundProbeId: string) => Promise<void>;

/** What one probe needs in order to run: an executor, and the params it understands. */
export interface ProbeDispatch {
  readonly executor: SurfaceExecutor;
  /** Surface-specific, hand-validated by the executor. See each surface's `readParams`. */
  readonly params: Readonly<Record<string, unknown>>;
}

/**
 * Builds one probe's execution. **The caller owns every resolution** (AD-1): the service
 * base URL, the declared command, the evidence callbacks and the executor itself.
 *
 * Called once per ATTEMPT rather than once per probe, because `attempt` rides in `params`
 * on all three surfaces and because an observation's `runAction` must close over the
 * attempt it belongs to.
 *
 * @throws {InfraError} or {ConfigError} for a probe the project cannot support — an
 * undeclared service, an undeclared command, an argument outside the allowlist. Those are
 * exit 3, never a product FAIL: the plan is wrong, which says nothing about the branch.
 */
export interface ProbeDispatcher {
  (input: {
    readonly criterionId: string;
    /** Mechanics ALREADY substituted with the plan's resolved data (4.3). */
    readonly probe: ProbeSpec;
    /** 1-based. */
    readonly attempt: number;
    /**
     * The verification worktree. Every command-spawning probe runs against the revision
     * under test (AD-8, FR-19), and the path is only known once the worktree stage has run
     * — which is why it travels with the dispatch rather than being captured at wiring time.
     */
    readonly cwd: string;
    readonly runAction: ProbeActionRunner;
    /**
     * The evidence sink every executor requires, ALREADY BOUND to this run's accumulator.
     *
     * Handed DOWN from the stage rather than up from the edge, and that direction is the
     * point. `RunResult.evidence` is the closed evidence UNION, and `report/terminal.ts`
     * renders probe evidence from the typed member inline because AD-11 forbids a renderer
     * to open a file — so an executor constructed with a stubbed or forgotten
     * `recordEvidence` produces reports carrying gate evidence and no probe evidence at
     * all, silently, with every surface suite green (no surface test drives a renderer).
     * All three cohort-2 PR bodies name that failure. Binding it here means the composition
     * root cannot get it wrong: the only sink it can pass on is the real one.
     *
     * `adapters-core-only` forbids `src/surfaces/**` the accumulator by design and
     * prescribes this exact remedy — "if a story needs an adapter-to-adapter call, that is
     * a port in src/domain/, injected by the caller".
     */
    readonly recordEvidence: (evidence: Evidence) => void;
  }): ProbeDispatch;
}

/** How many EXTRA attempts a surface may take. Opt-in; 0 for every surface today. */
export type RetryPolicy = (surface: ProbeSurface) => number;

export interface ProbesStageDeps {
  /**
   * The compiled plan's criteria, in the plan's own order (which `compilePlan` fixes to
   * contract order). Ids are the plan's verbatim.
   */
  readonly criteria: readonly PlanCriterion[];
  /** The plan's data bindings, resolved by 4.3's `resolvePlanData` at the edge (AD-9). */
  readonly data: ResolvedData;
  readonly dispatch: ProbeDispatcher;
  /** Defaults to zero retries for every surface. */
  readonly retries?: RetryPolicy;
  /** Config-declared extra redaction patterns (AD-10), threaded into every derivation. */
  readonly redaction?: RedactionOptions;
}

/**
 * Which of a criterion's probe results represents the criterion.
 *
 * The same order `domain/verdict.ts` applies to a whole run, restated for one criterion
 * and pinned against it by test. `skipped` is last because it is inert by definition: a
 * criterion with one passing probe and one that never ran passed as far as anything
 * observed, and reporting it as `skipped` would hide the observation that was made.
 */
const PROBE_PRECEDENCE: readonly CriterionStatus[] = [
  'fail',
  'error',
  'needs_human',
  'pass',
  'skipped',
];

export function createProbesStage(deps?: ProbesStageDeps): Stage {
  return {
    name: 'probes',
    run: async (context): Promise<StageResult> => {
      if (deps === undefined) {
        // NOT a refusal, deliberately, and for the reason `services.ts` and `data.ts`
        // give: probes adjudicate criteria, so an unwired probes stage cannot manufacture
        // a verdict — every criterion stays `skipped` and the aggregate stage says so.
        // The green-for-nothing case is caught at the EDGE instead, before the run, by
        // `assertSomethingToAdjudicate`.
        return stageOk('no plan was wired into this verification; no probes were executed');
      }

      const cwd = context.run.environment.worktreePath;
      if (cwd === null) {
        // Never fall back to the project root. Gates, services and data all refuse here,
        // and a probe is the same case with a sharper edge: a shell probe runs the
        // project's own tooling and an observation command may touch its database, so a
        // fallback would not merely verify the wrong tree — it would act on the operator's
        // working directory (AD-8, FR-19).
        throw new InfraError(
          'probes cannot run: no verification worktree was created',
          'this is a SpecWitness defect — the worktree stage must run before probes. ' +
            'Running them in the project root could modify your working tree, so nothing ' +
            'was executed',
        );
      }

      return await executePlan(deps, context, cwd);
    },
  };
}

async function executePlan(
  deps: ProbesStageDeps,
  context: StageContext,
  cwd: string,
): Promise<StageResult> {
  const contractCriteria = new Map(
    context.run.contractCriteria.map((criterion) => [criterion.criterionId, criterion]),
  );

  let probesRun = 0;

  for (const entry of deps.criteria) {
    const criterion = contractCriteria.get(entry.criterionId);
    if (criterion === undefined) {
      // Unreachable through the shipped path: `assertPlanMatchesContract` compares the
      // plan's fingerprint to the frozen contract's at the edge, and the draft gate
      // refuses a criterion the contract does not declare. Refused rather than skipped
      // because deriving a result needs the contract's `statement`, `severity` and
      // `verifiability`, and the only alternatives are inventing them or dropping the
      // criterion silently — and a criterion that disappears from a report is the failure
      // `not-safely-automatable` exists to prevent, arriving by another door.
      throw new InfraError(
        `the plan carries criterion '${entry.criterionId}', which the frozen contract does not declare`,
        "recompile the plan with 'specwitness plan <epic>' — a plan and its contract must " +
          'describe the same criteria, and a probe for a criterion nobody wrote cannot be ' +
          'reported against anything',
      );
    }

    if (entry.disposition === 'needs-human') {
      // Q38/Q39's second trigger. NOT `skipped`: the plan-author explicitly refused to
      // automate this, and `skipped` is inert, so reporting it that way would turn a
      // recorded refusal into a silent PASS. See `DerivationOptions.plannedNeedsHuman`.
      context.run.criteria.push(
        deriveCriterionResult(criterion, [], {
          ...deps.redaction,
          plannedNeedsHuman: true,
        }),
      );
      continue;
    }

    const attempts = await executeCriterion(deps, context, cwd, entry.criterionId, entry.probes);
    probesRun += attempts.size;

    const options: DerivationOptions = { ...deps.redaction };
    const perProbe = entry.probes.map((probe) =>
      deriveCriterionResult(criterion, attempts.get(probe.id) ?? [], options),
    );

    context.run.criteria.push(select(perProbe));
  }

  return stageOk(
    `${probesRun} ${probesRun === 1 ? 'probe' : 'probes'} executed across ` +
      `${deps.criteria.length} planned ${deps.criteria.length === 1 ? 'criterion' : 'criteria'}`,
  );
}

/**
 * Runs every probe of one criterion and returns its attempts, keyed by probe id.
 *
 * A probe named by another probe's `mechanics.around` is NOT run here: its wrapper runs
 * it, exactly once, between the wrapper's two snapshots.
 */
async function executeCriterion(
  deps: ProbesStageDeps,
  context: StageContext,
  cwd: string,
  criterionId: string,
  probes: readonly ProbeSpec[],
): Promise<Map<string, ProbeAttempt[]>> {
  // Bound once per criterion and passed to every executor this stage builds. `gates.ts`
  // pushes its own members onto the same array; an executor cannot, so this is the port.
  const recordEvidence = (evidence: Evidence): void => {
    context.run.evidence.push(evidence);
  };

  const byId = new Map(probes.map((probe) => [probe.id, probe]));
  const wrapped = new Set(
    probes.flatMap((probe) =>
      probe.surface === 'observation' && probe.mechanics.around !== undefined
        ? [probe.mechanics.around]
        : [],
    ),
  );

  const attempts = new Map<string, ProbeAttempt[]>();

  const record = (probeId: string, attempt: ProbeAttempt): void => {
    const existing = attempts.get(probeId);
    if (existing === undefined) {
      attempts.set(probeId, [attempt]);
      return;
    }
    existing.push(attempt);
  };

  const runProbe = async (probe: ProbeSpec): Promise<void> => {
    // Substituted ONCE, before the executor sees anything (4.3). A value substituted
    // after a check is a value that was never checked — and `argumentAllowlist` is
    // substituted along with `args`, so a data-bound argument is compared against a
    // resolved ceiling rather than against a literal `{{name}}` it can never match.
    const resolved: ProbeSpec = {
      ...probe,
      mechanics: resolveMechanics(probe.mechanics, deps.data),
    } as ProbeSpec;

    const extra = deps.retries?.(probe.surface) ?? 0;

    for (let attempt = 1; attempt <= extra + 1; attempt += 1) {
      const runAction: ProbeActionRunner = async (aroundProbeId) => {
        const target = byId.get(aroundProbeId);
        if (target === undefined) {
          // 4.2's schema refuses a dangling `around` at compile time, so reaching here
          // means a plan edited on disk. A wiring-shaped failure, not a product one.
          throw new InfraError(
            `probe '${probe.id}' wraps '${aroundProbeId}', which criterion ${criterionId} does not declare`,
            "recompile the plan with 'specwitness plan <epic>' — an observation's " +
              "'around' must name another probe of the same criterion",
          );
        }
        await runProbe(target);
      };

      const dispatch = deps.dispatch({
        criterionId,
        probe: resolved,
        attempt,
        cwd,
        runAction,
        recordEvidence,
      });

      record(probe.id, await dispatch.executor.execute({
        criterionId,
        surface: probe.surface,
        params: dispatch.params,
      }));
    }
  };

  for (const probe of probes) {
    if (wrapped.has(probe.id)) {
      continue;
    }
    await runProbe(probe);
  }

  return attempts;
}

/**
 * Picks the one result that represents a criterion, from one result per probe.
 *
 * Selection only — every status it chooses between was produced by `deriveCriterionResult`
 * (AD-13). Nothing here decides what a status means; it decides which probe's answer the
 * criterion reports, and `PROBE_PRECEDENCE` is where that order is stated and reasoned.
 */
function select(results: readonly DerivedCriterionResult[]): DerivedCriterionResult {
  if (results.length === 1) {
    // The overwhelmingly common shape, and taking it verbatim keeps a single-probe
    // criterion's result byte-identical to what the derivation produced.
    return results[0] as DerivedCriterionResult;
  }

  const chosen =
    PROBE_PRECEDENCE.flatMap((status) =>
      results.filter((result) => result.status === status),
    ).at(0) ?? (results[0] as DerivedCriterionResult);

  // FR-32 is about VISIBILITY, so a flake in any probe of a passing criterion survives
  // into the criterion's result rather than being lost to selection.
  if (chosen.status === 'pass' && chosen.flaky !== true && results.some((r) => r.flaky === true)) {
    return { ...chosen, flaky: true };
  }

  return chosen;
}
