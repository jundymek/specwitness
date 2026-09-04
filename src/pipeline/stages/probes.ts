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
 * unless a project asked otherwise. Story 5.4 added the field a project asks in: a
 * `retries:` block in the PROJECT CONFIG — not in 4.2's frozen Plan schema, because a plan
 * is fingerprinted alongside its contract and a retry count baked into it would make "the
 * same verification" change on a flaky machine. `src/cli/verify/probe-dispatch.ts`'s
 * `createRetryPolicy` turns that block into the `RetryPolicy` below, at the edge, because
 * `src/config/**` may not import this layer. Absent the block every surface is 0, and
 * `deps.retries` being undefined still means exactly one attempt per probe.
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
 * **AND SO ARE THE ATTEMPT RECORDS** (story 5.4), for the same reason and after a defect
 * that proved the reason: carrying `flaky` up without the records left a criterion marked
 * flaky beside the CHOSEN probe's records, which — if the chosen probe passed cleanly —
 * were absent. The stored run then said "this flaked" and "nothing was retried" at once.
 * Each record carries its `probeId`, so `attempt` stays unambiguous when two probes' arrays
 * become one. See `select` at the bottom of this file.
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
 * **SEVERAL OBSERVATIONS MAY WRAP ONE ACTION, AND IT STILL RUNS ONCE.** 4.2's schema permits
 * that deliberately and calls it "the case that actually occurs"; `shareAction` below is how
 * one execution ends up surrounded by all of their snapshots.
 *
 * AD-1: application layer. Imports `domain`, `schemas` and siblings; never `cli`,
 * `authoring`, `ingest` or `report`.
 */

import { deriveCriterionResult } from '../../domain/criterion-result.js';
import type { AppliedMechanicsChange } from '../../domain/adaptation.js';
import type { AdaptationCandidate, MechanicsAdapter } from '../../domain/adaptation-port.js';
import { adaptCriteria, AdaptationRefused } from '../../domain/adaptation-apply.js';
import type {
  ContractCriterionRef,
  DerivationOptions,
  DerivedCriterionResult,
  ProbeAttempt,
  ProbeSurface,
  SurfaceExecutor,
} from '../../domain/criterion-result.js';
import { InfraError } from '../../domain/errors.js';
import type { Evidence, RedactionOptions } from '../../domain/evidence.js';
import { boundedText } from '../../domain/evidence.js';
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
  /**
   * FR-18 / story 5.6 — the mechanics adapter, when `--adapt` was passed.
   *
   * ABSENT BY DEFAULT, and the absence is the FR-18/Q66 guarantee rather than a
   * convenience: with no adapter wired there is no provider in scope on this path at all,
   * so a default `verify` run cannot spend quota even by mistake. Injected from the edge
   * for the same AD-1 reason `dispatch` is — `src/pipeline/**` may not import
   * `src/authoring/**`, so the caller composes and passes a port in.
   */
  readonly adapt?: MechanicsAdapter;
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
  const executed: ExecutedCriterion[] | undefined = deps.adapt === undefined ? undefined : [];

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
      //
      // `reason` and `guidance` are passed on as well (story 5.3), and the reason they had
      // to be is this exact line: the plan schema REQUIRES both on every needs-human arm
      // and the plan-author is instructed to write them, but this stage held them and sent
      // only the flag. So a criterion arrived at a human carrying the contract's statement
      // and nothing else — no guidance, no reason, no pointer to evidence — even though
      // NEEDS_HUMAN is exit 2 and exit 2 is a STOP. Redaction and bounding happen inside
      // the derivation, beside `expected`/`actual`, not here.
      context.run.criteria.push(
        deriveCriterionResult(criterion, [], {
          ...deps.redaction,
          plannedNeedsHuman: true,
          needsHumanReason: entry.reason,
          reviewerGuidance: entry.guidance,
        }),
      );
      continue;
    }

    const attempts = await executeCriterion(deps, context, cwd, entry.criterionId, entry.probes);
    probesRun += attempts.size;

    const options: DerivationOptions = { ...deps.redaction };
    const perProbe = entry.probes.map((probe) =>
      // `probeId` so every attempt record says which probe it describes — load-bearing
      // once `select` below merges the records of several probes into one criterion.
      deriveCriterionResult(criterion, attempts.get(probe.id) ?? [], {
        ...options,
        probeId: probe.id,
      }),
    );

    // Story 5.6: remembered ONLY when an adapter is wired, so a default run allocates
    // nothing and the adaptation path is provably inert rather than merely unused.
    executed?.push({ index: context.run.criteria.length, entry, criterion, attempts });

    context.run.criteria.push(select(perProbe));
  }

  if (deps.adapt !== undefined && executed !== undefined) {
    probesRun += await adaptAndReExecute(deps, context, cwd, executed, deps.adapt);
  }

  return stageOk(
    `${probesRun} ${probesRun === 1 ? 'probe' : 'probes'} executed across ` +
      `${deps.criteria.length} planned ${deps.criteria.length === 1 ? 'criterion' : 'criteria'}`,
  );
}


/* == story 5.6: the mechanics adaptation pass ========================================== */

/** One criterion as the first pass left it, kept only when an adapter is wired. */
interface ExecutedCriterion {
  /** Position in `context.run.criteria`, so a replacement lands where the original was. */
  readonly index: number;
  readonly entry: PlanCriterion;
  readonly criterion: ContractCriterionRef;
  readonly attempts: Map<string, ProbeAttempt[]>;
}

/*
 * ⚠️ THERE IS NO `result` FIELD HERE, AND THE ABSENCE IS LOAD-BEARING.
 *
 * It used to carry the criterion's aggregate `DerivedCriterionResult`, and THREE separate
 * review findings came from reading it: eligibility, acceptance and the candidate's own
 * diagnostics were all answered from a criterion-level value where the question was about
 * ONE PROBE. `select` resolves a criterion by `PROBE_PRECEDENCE`, so the aggregate routinely
 * belongs to a different probe than the one being asked about.
 *
 * Every one of those is now derived per probe from `attempts`, which makes the aggregate
 * unused — so it is removed rather than left in place. A field that is present, plausible
 * and wrong for this flow's questions is how the same mistake gets made a fourth time.
 */


/**
 * Which failing browser probes are worth adapting.
 *
 * ⚠️ **EXACTLY ONE SIGNAL IS ADAPTABLE: A SCENARIO STEP THAT COULD NOT FIND ITS TARGET.**
 *
 * AC1 scopes adaptation to a probe *failing on element-not-found* — a COSMETIC DRIFT signal.
 * Getting that predicate right turned out to be the hardest judgement in this story, and it
 * was narrowed twice by review. The rule now is one line, and everything else falls out:
 *
 *     last.execError?.reason === 'step-target-missing'
 *
 * WHY NOT "ANY UNSATISFIED ASSERTION ON A BROWSER PROBE", which is what this used to say.
 * ⚠️ **That was a hole big enough to defeat the whole story, and it was found by review
 * rather than by me.** An assertion that READ AN EXISTING VALUE which merely differs — the
 * title says `Orders` where the contract requires `Organizations` — is an ordinary PRODUCT
 * FAILURE. The system under verification is wrong. Offering that to an adapter invites a
 * provider to rewrite where the probe looks until the assertion passes SOMEWHERE ELSE, on a
 * genuine behavioural regression.
 *
 * The payload schema stops a provider changing WHAT MUST BE TRUE. It cannot stop a provider
 * being asked to find a page where an unchanged assertion happens to hold. **That is the
 * same laundering by a different door**, and the candidate rule is the only thing standing
 * in it.
 *
 * AND AN ABSENT ASSERTION TARGET IS NOT THE EXCEPTION IT LOOKS LIKE. A selector that matches
 * nothing is also an unsatisfied assertion, and it is genuinely "element not found" — but
 * the assertion's target is part of `assertions`, which adaptation may NEVER change. So the
 * only way mechanics could "fix" it is by navigating somewhere the selector does exist,
 * which is precisely the laundering above. It is excluded for the same reason, not by
 * oversight. (It is also not separable in the data: `browser.ts` renders an absent read as
 * PROSE in `actual`, so telling it from a wrong value would mean matching an adapter's
 * message — the technique this codebase rejects.)
 *
 * WHY A STEP TARGET IS DIFFERENT, and it is a difference in kind rather than degree. A step
 * is the probe's own INSTRUCTIONS for getting somewhere — HOW to look. When
 * `click "#create-company"` finds nothing, what is stale is the probe's script, not the
 * product: the control was renamed, and FR-18's worked example is exactly this. Nothing
 * about WHAT MUST BE TRUE has been observed yet, so nothing about it can be laundered.
 *
 * That signal is structured rather than inferred (`ProbeExecErrorReason`, DECISIONS.md D12),
 * established by 5.2's driver asking the page before it acts. Everything else is excluded:
 *
 *   - `unreachable` — the page could not answer. A dead browser, not drift.
 *   - `other` — it could not look, for a reason nobody established as a target miss.
 *   - **`reason` ABSENT** — an executor that did not say. Absence is never adaptable, which
 *     keeps every other surface and any future one excluded by default.
 *   - **every `fail`**, including one whose assertion target was missing. See above.
 *   - `needs_human`, `skipped`, `pass`.
 *
 * ============================================================================
 * THE INVARIANT
 * ============================================================================
 *
 * **AN ADAPTED RUN'S VERDICT CAN ONLY EVER IMPROVE, NEVER DEGRADE**, and it holds PER PROBE
 * rather than per criterion. A probe's adapted result is taken only when it is `pass`;
 * otherwise that probe keeps its original result with its original evidence, exactly as AC2
 * requires. Since no probe's contribution is ever replaced by a worse one, `select` over
 * them can never resolve worse than it did before.
 *
 * So the blast radius is: *a criterion whose probe could not find a control it was told to
 * click may come to pass — and the run says loudly that it was adapted, and what changed.*
 * Nothing else moves.
 */
function adaptationCandidates(
  executed: readonly ExecutedCriterion[],
  redaction: RedactionOptions | undefined,
): AdaptationCandidate[] {
  const candidates: AdaptationCandidate[] = [];

  for (const record of executed) {
    if (record.entry.disposition !== 'automated') {
      continue;
    }

    // ⚠️ NO CHECK ON THE CRITERION'S AGGREGATE STATUS, and its absence is deliberate.
    //
    // An earlier version required `record.result.status === 'error'` before looking at any
    // probe. `select` resolves a criterion by `PROBE_PRECEDENCE`, where `fail` outranks
    // `error` — so a criterion with a step-target-missing browser probe AND a sibling that
    // merely failed resolves to `fail`, and the aggregate guard skipped the eligible probe
    // because of a result that was not about it. Raised as a P2 by the codex review.
    //
    // Eligibility is a fact about ONE PROBE'S OWN ATTEMPT, so it is asked of that attempt.
    // The aggregate check was also redundant: the per-probe signal below already excludes
    // everything it excluded, which is why planting the aggregate check alone changed no
    // test.

    for (const probe of record.entry.probes) {
      if (probe.surface !== 'browser') {
        continue;
      }
      const last = (record.attempts.get(probe.id) ?? []).at(-1);

      // THE ONE ADAPTABLE SIGNAL. Structured, established before the action by 5.2's driver,
      // and about the probe's own instructions rather than about what it observed.
      if (last?.execError?.reason !== 'step-target-missing') {
        continue;
      }

      // ⚠️ THIS PROBE'S OWN DIAGNOSTICS, NOT THE CRITERION'S.
      //
      // `record.result` is the AGGREGATE, chosen by `PROBE_PRECEDENCE` — so on a criterion
      // where this probe missed its step target and a SIBLING merely failed, the aggregate
      // carries the sibling's `expected`/`actual`. Sending those would describe a different
      // probe's product failure to the adapter, and would leak one probe's observed values
      // into a prompt about another. Found by re-reading this function after the round-5
      // review, which was about the same aggregate-for-a-per-probe-question mistake in two
      // other places.
      //
      // Derived rather than hand-built so the values are redacted and bounded by the SAME
      // function that redacts everything else (AD-10). Nothing here re-reads an evidence
      // file, and no trace or screenshot is opened — see `AdaptationCandidate` for why that
      // absence is the point.
      const diagnostics = deriveCriterionResult(record.criterion, record.attempts.get(probe.id) ?? [], {
        ...redaction,
        probeId: probe.id,
      });

      candidates.push({
        criterionId: record.criterion.criterionId,
        statement: record.criterion.statement,
        probeId: probe.id,
        // ⚠️ REDACTED AND BOUNDED, THOUGH THEY COME FROM THE PROJECT'S OWN PLAN.
        //
        // It is tempting to treat plan content as safe because a human wrote it and
        // committed it. It is not: a scenario can carry a literal a `fill` step types into a
        // form — `fill "#password" "hunter2"` is a perfectly ordinary plan line — and a path
        // can carry a query value. Copying those raw into a prompt sends them to a provider
        // CLI, which is precisely the disclosure this flow claims not to make.
        //
        // This story already redacted the SAME two strings in the audit record
        // (`AppliedMechanicsChange.from`, whose own doc says why) and did not redact the copy
        // it sent to the provider. Raised as a P1 by the codex review, and it is the more
        // dangerous half of the two: an audit record stays on the operator's disk, a prompt
        // leaves the machine.
        //
        // Bounded as well as redacted: a scenario has no length limit in the plan schema, and
        // an unbounded one would be a prompt nobody budgeted for.
        path: boundedText(probe.mechanics.path, redaction).text,
        scenario: boundedText(probe.mechanics.scenario, redaction).text,
        ...(diagnostics.expected === undefined ? {} : { expected: diagnostics.expected }),
        ...(diagnostics.actual === undefined ? {} : { actual: diagnostics.actual }),
      });
    }
  }

  // ⚠️ AN ID THAT IS AMBIGUOUS AMONG THE CANDIDATES THEMSELVES IS NOT OFFERED.
  //
  // Probe ids are unique only WITHIN a criterion, so two criteria may both declare
  // `check-title`. The applier is told which criterion each offered id belongs to (its
  // `scope`), which resolves the ordinary case — but if BOTH namesakes are candidates in the
  // same run, no scope can say which one a proposal meant, because a proposal names an id and
  // nothing else.
  //
  // Dropped rather than guessed at. Adaptation is opt-in and bounded; adapting the wrong
  // probe because two share a name is worse than adapting neither, and the alternative —
  // adding a criterion id to the payload — would put a key in the schema whose absence is
  // part of this story's claim.
  const perId = new Map<string, number>();
  for (const candidate of candidates) {
    perId.set(candidate.probeId, (perId.get(candidate.probeId) ?? 0) + 1);
  }
  return candidates.filter((candidate) => perId.get(candidate.probeId) === 1);
}

/**
 * Proposes, validates, applies to a COPY, re-executes, and records.
 *
 * ============================================================================
 * ⚠️ AN ADAPTED RE-EXECUTION NEVER ENTERS 5.4's ATTEMPT LIST. READ THIS BEFORE EDITING.
 * ============================================================================
 *
 * "The flake rule is untouched" is TRUE and it is NOT SUFFICIENT, and a later reader will
 * otherwise believe the first half covers this case. The merged rule computes its answer
 * from whatever attempt list it is handed:
 *
 *   `criterion-result.ts:441-443` — flaky = status is pass AND some EARLIER attempt was not
 *   `criterion-result.ts:445-452` — the per-attempt record exists when attempts.length > 1
 *
 * and `executePlan` above keys attempts by probe id. Since `probeId` is a pure SELECTOR
 * that changes no identity, a re-execution of probe P would land in P's own array by
 * construction, producing `[fail with ORIGINAL mechanics, pass with ADAPTED mechanics]` —
 * exactly the input that yields `flaky: true`, a per-attempt record, and an entry in the
 * run-level flakiness summary.
 *
 * That would be a lie. A retry repeats the SAME probe and changes only how often something
 * was tried; an adaptation CHANGES the probe and is a different fact about a run. Reporting
 * it as flake would tell a human the UI is intermittent when what actually happened is that
 * the probe was rewritten — the one way this story could launder a real failure into noise.
 *
 * **SO THE RE-EXECUTION COLLECTS INTO A FRESH MAP** (`executeCriterion` builds its own) and
 * the replacement result is derived from THAT list alone. The mixed pair is therefore never
 * constructed, rather than constructed and filtered out. Do not "simplify" this by merging
 * the two maps.
 *
 * Raised by the epic-5 supervisor from the merged code before any run had shown it.
 *
 * ⚠️ **AND A PRECISION THAT AN EARLIER VERSION OF THIS COMMENT GOT WRONG.** It used to say
 * the fresh list "has exactly one attempt, so `flaky` is structurally false". That is true
 * only with `retries.browser` at its default of 0. A project that configures browser retries
 * (5.4's feature) gives the adapted execution its cycles too, so the fresh list CAN hold
 * several attempts and `flaky` CAN be true. Raised by the codex review of this branch, which
 * was right about the claim.
 *
 * **The behaviour is deliberate and is not the defect; the overclaim was.** Flake WITHIN the
 * adapted execution is genuine 5.4 flake: those attempts ran the SAME (adapted) probe, so
 * repetition is exactly what they are, and reporting it is honest. What must never happen is
 * the CROSS-MECHANICS comparison — the original failure combining with the adapted pass —
 * and that is what the fresh map prevents, at any retry setting.
 *
 * The suggested fix was to force a single attempt on this path. It is declined, and stated
 * rather than silently not done: a project that configured retries did so because its
 * browser is intermittent, and that is precisely the environment where adaptation matters
 * most. Silently withholding the operator's own tolerance here would make one unlucky
 * adapted attempt discard a proposal that works, on the runs most likely to need it. Both
 * semantics are pinned by test.
 *
 * ============================================================================
 * AN ADAPTATION MAY ONLY EVER TURN A `fail` INTO A `pass`
 * ============================================================================
 *
 * The replacement is taken ONLY when the re-derived criterion is `pass`. Anything else —
 * still failing, newly erroring, a browser that died on the second look — leaves the
 * ORIGINAL result standing with its ORIGINAL evidence, exactly as AC2 requires, and the run
 * is not marked `adapted`.
 *
 * That gives a property worth stating on its own: **an adapted run's verdict can only ever
 * improve, never degrade.** A hostile or merely incompetent proposal cannot introduce a new
 * failure, cannot turn a `fail` into an `error`, cannot reach `needs_human`, and cannot move
 * the exit code in the bad direction. The blast radius of the whole feature is bounded to
 * "one criterion that was already failing now passes, and the run says loudly that it was
 * adapted".
 */
async function adaptAndReExecute(
  deps: ProbesStageDeps,
  context: StageContext,
  cwd: string,
  executed: readonly ExecutedCriterion[],
  adapt: MechanicsAdapter,
): Promise<number> {
  const candidates = adaptationCandidates(executed, deps.redaction);
  if (candidates.length === 0) {
    // Nothing was adaptable, so no provider is called and the run carries NO adaptation key
    // at all. "A run that did not adapt has no marker and no record" is assertable because
    // of this early return.
    return 0;
  }

  const decision = await adapt(candidates);

  // FR-15 / Q65 / AD-4: EVERY provider invocation is recorded, including one whose payload
  // was thrown away. A run that spent subscription quota while `providerUsage` stayed empty
  // would make FR-18's whole guarantee unauditable — which is the reason `verify.ts` gives
  // for recording plan compilation, and it applies identically here.
  if (decision.usage !== undefined) {
    context.run.providerUsage.push(decision.usage);
  }

  const refuse = (reason: string): number => {
    // RECORDED, not swallowed. A reader must be able to tell a hostile provider from an
    // absent one. `adapted` stays false and every criterion keeps its original result.
    context.run.adaptation = {
      adapted: false,
      applied: [],
      refusal: boundedText(reason, deps.redaction),
    };
    return 0;
  };

  if (decision.outcome === 'refused') {
    return refuse(decision.reason);
  }

  // ⚠️ **A PATCH MAY ONLY NAME A PROBE THAT WAS OFFERED.** Raised as a P1 by the codex
  // review of this branch, and it is the sharpest hole this story could have shipped.
  //
  // `adaptCriteria` validates a patch against every probe in the PLAN, which is the right
  // question for the applier and the wrong question here. Without this check a hostile
  // response could name any browser probe it can guess — one that PASSED, or one excluded
  // because its browser could not look at all — and the stage would execute
  // provider-modified mechanics against it. The verdict could not get worse (only an
  // improvement is ever taken), but a provider would still have chosen what a browser
  // navigated to, on a probe nobody offered it. That is exactly the authority this story
  // exists to withhold, reached by a door the payload schema does not guard.
  //
  // Refused WHOLESALE rather than per-patch, consistent with everything else here: a payload
  // that reaches outside its remit is not partially honoured.
  const offered = new Set(candidates.map((candidate) => candidate.probeId));
  const trespassing = decision.patches.find((patch) => !offered.has(patch.probeId));
  if (trespassing !== undefined) {
    return refuse(
      `the proposal names probe '${trespassing.probeId}', which was not offered for ` +
        'adaptation — only a probe that failed on an observation it actually made is adaptable',
    );
  }

  // The patches are applied to a COPY of the criteria. `adaptCriteria` is pure and has no
  // file system in scope, so the project's `.specwitness/plans/<epic>.yaml` and the frozen
  // contract cannot be written from here — the guarantee is a property of the module rather
  // than a discipline (see `domain/adaptation-apply.ts`).
  const byCriterionId = new Map<string, ExecutedCriterion>(
    executed.map((record) => [record.criterion.criterionId, record]),
  );
  // WHICH CRITERION EACH OFFERED PROBE BELONGS TO. Built from the candidates rather than
  // from the payload, so it is the CALLER's knowledge and never the provider's — a proposal
  // still names a probe id and nothing else.
  const scope = new Map(candidates.map((candidate) => [candidate.probeId, candidate.criterionId]));

  let adapted;
  try {
    adapted = adaptCriteria(
      executed.map((record) => record.entry),
      decision.patches,
      scope,
    );
  } catch (error) {
    if (error instanceof AdaptationRefused) {
      return refuse(error.message);
    }
    throw error;
  }

  // ⚠️ KEYED BY (CRITERION, PROBE), NOT BY PROBE ID ALONE.
  //
  // Probe ids are unique only within a criterion, and `adaptCriteria` patches only the
  // SCOPED criterion's probe — so a set of bare ids would re-execute every NAMESAKE, in
  // criteria nothing was proposed for. An unchanged namesake that failed an assertion and
  // then passed on that extra execution would have its result replaced, turning an unrelated
  // criterion into a pass **with no recorded mechanics change**: a green-for-nothing route
  // through the audit's blind spot.
  //
  // Raised as a P1 by the codex review, and it is a second-order consequence of the previous
  // round's scoping fix — the applier learned about criteria and this loop had not.
  const changedKey = (criterionId: string, probeId: string): string =>
    `${criterionId}\u0000${probeId}`;
  const changedKeys = new Set(
    adapted.changes.map((change) => changedKey(change.criterionId, change.probeId)),
  );
  const applied: AppliedMechanicsChange[] = [];
  // Executed, then thrown away because the criterion did not improve. Recorded rather than
  // dropped — see `RunAdaptation.discarded` for why omitting it was a lie about the run.
  const discarded: AppliedMechanicsChange[] = [];
  let probesRun = 0;

  for (const entry of adapted.criteria) {
    if (entry.disposition !== 'automated') {
      continue;
    }
    const adaptedProbes = entry.probes.filter((probe) =>
      changedKeys.has(changedKey(entry.criterionId, probe.id)),
    );
    if (adaptedProbes.length === 0) {
      continue;
    }
    const record = byCriterionId.get(entry.criterionId);
    if (record === undefined) {
      continue;
    }

    // A FRESH map, per the section above. Only the adapted probes are re-run: a probe whose
    // mechanics did not move has already been observed and re-running it would duplicate its
    // evidence for no new information.
    //
    // ⚠️ **THE ATTEMPT NUMBER IS OFFSET PAST THE FIRST PASS, AND THAT IS NOT COSMETIC.**
    // Raised as a P1 by the codex review of this branch. `src/surfaces/browser.ts` derives
    // its evidence filenames from criterion id, probe id AND attempt number, and its own
    // comment says why: *"THE ATTEMPT NUMBER IS NOT DECORATION"*. A re-execution that
    // restarted at attempt 1 would write its trace and screenshot over the FIRST pass's — so
    // an adaptation that failed would leave the retained original failure pointing at
    // evidence captured from the ADAPTED run. The criterion result would be untouched and
    // its evidence would quietly be somebody else's, which is a worse lie than a changed
    // verdict because nothing in the report would look wrong.
    //
    // The wave-2 pattern once more: *the criterion was preserved* and *its evidence was
    // preserved* are two different claims, and only the first had a test.
    const fresh = await executeCriterion(
      deps,
      context,
      cwd,
      entry.criterionId,
      adaptedProbes,
      (probeId) => record.attempts.get(probeId)?.length ?? 0,
    );
    probesRun += fresh.size;

    const options: DerivationOptions = { ...deps.redaction };

    // ⚠️ ACCEPTANCE IS DECIDED PER PROBE, BEFORE THE CRITERION IS RECOMPUTED.
    //
    // An earlier version compared the recomputed CRITERION against `pass`. With several
    // adaptable probes under one criterion, a proposal that genuinely fixed one of them was
    // discarded whenever a sibling still failed — and the run then recorded that nothing had
    // been applied, which was false: a browser really had run the adapted mechanics and that
    // probe really had passed. Raised as a P2 by the codex review.
    //
    // A probe's fresh result is taken ONLY when it is `pass`; otherwise that probe keeps its
    // original result, with its original evidence. The criterion is then recomputed from the
    // mix. **The invariant survives per probe**: no probe's contribution is ever replaced by
    // a worse one, so `select` over them can never resolve worse than before — a criterion
    // that still fails because of an unrelated sibling is reported honestly as failing, with
    // the adaptation that did work recorded as applied.
    const keptProbeIds = new Set<string>();
    const perProbe = entry.probes.map((probe) => {
      const original = deriveCriterionResult(record.criterion, record.attempts.get(probe.id) ?? [], {
        ...options,
        probeId: probe.id,
      });
      if (!changedKeys.has(changedKey(entry.criterionId, probe.id))) {
        return original;
      }
      // The adapted probe's OWN fresh list — never merged with the first pass's, which is
      // what keeps 5.4's flake vocabulary intact (see the section above).
      const adaptedResult = deriveCriterionResult(record.criterion, fresh.get(probe.id) ?? [], {
        ...options,
        probeId: probe.id,
      });
      if (adaptedResult.status !== 'pass') {
        return original;
      }
      keptProbeIds.add(probe.id);
      return adaptedResult;
    });

    if (keptProbeIds.size > 0) {
      context.run.criteria[record.index] = select(perProbe);
    }

    // RECORDED EITHER WAY. The change was applied to the plan copy and a browser really
    // executed it, so the audit says so whether or not its result was kept; `adapted`
    // describes what was kept, and these two lists describe what was done.
    for (const change of adapted.changes) {
      if (change.criterionId !== entry.criterionId) {
        continue;
      }
      (keptProbeIds.has(change.probeId) ? applied : discarded).push({
        criterionId: change.criterionId,
        probeId: change.probeId,
        field: change.field,
        // Both sides redacted and bounded at the moment the record is built (AD-10). `to`
        // is provider-authored text that was applied to an executable artifact.
        from: boundedText(change.from, deps.redaction),
        to: boundedText(change.to, deps.redaction),
      });
    }
  }

  const discardedRecord = discarded.length === 0 ? {} : { discarded };

  context.run.adaptation =
    applied.length === 0
      ? {
          adapted: false,
          applied: [],
          ...discardedRecord,
          refusal: boundedText(
            'the proposal was valid and was applied to a plan copy, but no re-executed probe passed — every criterion kept its original outcome and its original evidence',
            deps.redaction,
          ),
        }
      : { adapted: true, applied, ...discardedRecord };

  return probesRun;
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
  /**
   * How many attempts this probe has ALREADY had in this run (story 5.6).
   *
   * Absent for every caller but one. The adaptation pass passes the first pass's count so a
   * re-executed probe numbers its attempts 2, 3, ... rather than restarting at 1 — see the
   * call site for why overwriting attempt 1's evidence would quietly corrupt the record of
   * the original failure.
   */
  attemptOffsetFor?: (probeId: string) => number,
): Promise<Map<string, ProbeAttempt[]>> {
  // Bound once per criterion and passed to every executor this stage builds. `gates.ts`
  // pushes its own members onto the same array; an executor cannot, so this is the port.
  const recordEvidence = (evidence: Evidence): void => {
    context.run.evidence.push(evidence);
  };

  const byId = new Map(probes.map((probe) => [probe.id, probe]));
  const attempts = new Map<string, ProbeAttempt[]>();

  const record = (probeId: string, attempt: ProbeAttempt): void => {
    const existing = attempts.get(probeId);
    if (existing === undefined) {
      attempts.set(probeId, [attempt]);
      return;
    }
    existing.push(attempt);
  };

  /**
   * Executes ONE attempt of one probe, with the `runAction` its wrapper needs.
   *
   * The attempt LOOP lives in the callers, not here, and that is what makes a retried
   * wrapper work: a retry means "do the whole measured interaction again", so each attempt
   * is its own cycle with its own single action. See `shareAction`.
   *
   * `runAction` is injected rather than built here, because a probe wrapped by SEVERAL
   * observations must run exactly once for all of them.
   */
  const runAttempt = async (
    probe: ProbeSpec,
    attempt: number,
    runAction: ProbeActionRunner,
  ): Promise<void> => {
    // Substituted ONCE, before the executor sees anything (4.3). A value substituted
    // after a check is a value that was never checked — and `argumentAllowlist` is
    // substituted along with `args`, so a data-bound argument is compared against a
    // resolved ceiling rather than against a literal `{{name}}` it can never match.
    const resolved: ProbeSpec = {
      ...probe,
      mechanics: resolveMechanics(probe.mechanics, deps.data),
    } as ProbeSpec;

    const dispatch = deps.dispatch({
      criterionId,
      probe: resolved,
      attempt,
      cwd,
      runAction,
      recordEvidence,
    });

    record(
      probe.id,
      await dispatch.executor.execute({
        criterionId,
        surface: probe.surface,
        params: dispatch.params,
      }),
    );
  };

  /** How many attempts a probe class takes. Opt-in; 0 extra for every surface today. */
  const cyclesFor = (probe: ProbeSpec): number => (deps.retries?.(probe.surface) ?? 0) + 1;

  /** Resolves an `around` id to the probe it names, or refuses. */
  const targetOf = (wrapperId: string, aroundProbeId: string): ProbeSpec => {
    const target = byId.get(aroundProbeId);
    if (target === undefined) {
      // 4.2's schema refuses a dangling `around` at compile time, so reaching here means a
      // plan edited on disk. A wiring-shaped failure, not a product one.
      throw new InfraError(
        `probe '${wrapperId}' wraps '${aroundProbeId}', which criterion ${criterionId} does not declare`,
        "recompile the plan with 'specwitness plan <epic>' — an observation's 'around' must " +
          'name another probe of the same criterion',
      );
    }
    return target;
  };

  /**
   * The ordinary runner: this wrapper is the only one around its action.
   *
   * ONE attempt of the action per wrapper cycle. The action is subordinate to the
   * measurement — its own retry policy does not apply inside somebody else's before/after
   * window, because a second execution there would be an unmeasured side effect.
   */
  const soleAction = (wrapperId: string, attempt: number): ProbeActionRunner => {
    return async (aroundProbeId) => {
      await runAttempt(targetOf(wrapperId, aroundProbeId), attempt, rejectNestedAction);
    };
  };

  // Probes executed inside a wrapper, and wrapper groups already handled together.
  const wrapped = new Set(
    probes.flatMap((probe) =>
      probe.surface === 'observation' && probe.mechanics.around !== undefined
        ? [probe.mechanics.around]
        : [],
    ),
  );
  const handled = new Set<string>();

  for (const probe of probes) {
    if (wrapped.has(probe.id) || handled.has(probe.id)) {
      continue;
    }

    const group = wrappersSharing(probes, probe);
    if (group.length <= 1) {
      // The ordinary case: a plain probe, or the only observation around its action.
      const offset = attemptOffsetFor?.(probe.id) ?? 0;
      for (let cycle = 1; cycle <= cyclesFor(probe); cycle += 1) {
        const attempt = cycle + offset;
        await runAttempt(probe, attempt, soleAction(probe.id, attempt));
      }
      continue;
    }

    // Several observations share one action, so the group is executed together and the
    // action runs once per CYCLE for all of them. Marked handled so the loop does not
    // revisit them. Every member is an observation, so they share a retry policy and
    // therefore a cycle count.
    for (const member of group) {
      handled.add(member.id);
    }
    const target = targetOf(probe.id, aroundOf(probe));
    for (let attempt = 1; attempt <= cyclesFor(probe); attempt += 1) {
      await shareAction(group, target, attempt, runAttempt);
    }
  }

  return attempts;
}

/** The `around` id of a wrapping observation. Narrowing only — never called for others. */
function aroundOf(probe: ProbeSpec): string {
  if (probe.surface !== 'observation' || probe.mechanics.around === undefined) {
    // Unreachable: only called for probes `wrappersSharing` already classified.
    throw new InfraError(
      `probe '${probe.id}' was treated as a wrapping observation but declares no 'around'`,
      'this is a SpecWitness defect in the probes stage',
    );
  }
  return probe.mechanics.around;
}

/** Every observation in this criterion that wraps the same action as `probe` does. */
function wrappersSharing(probes: readonly ProbeSpec[], probe: ProbeSpec): readonly ProbeSpec[] {
  if (probe.surface !== 'observation' || probe.mechanics.around === undefined) {
    return [probe];
  }
  const around = probe.mechanics.around;
  return probes.filter(
    (candidate) =>
      candidate.surface === 'observation' && candidate.mechanics.around === around,
  );
}

/**
 * An observation's action may not itself wrap something.
 *
 * 4.2's schema already refuses an `around` pointing at another observation — one rule
 * closing a cycle, a chain of wraps, and the merely-meaningless case of wrapping a
 * snapshot. This is the runtime half, for a plan edited on disk after compilation.
 */
const rejectNestedAction: ProbeActionRunner = async (aroundProbeId) => {
  throw new InfraError(
    `a wrapped action tried to wrap '${aroundProbeId}' in turn, which is not executable`,
    "recompile the plan with 'specwitness plan <epic>' — an observation wraps an ACTION " +
      '(http, browser or shell), never another observation',
  );
};

/**
 * Runs several observations that wrap the SAME action, so the action happens ONCE and every
 * wrapper's before/after really surrounds it.
 *
 * `PlanCriterionSchema` permits this deliberately and names it "the case that actually
 * occurs (rows created AND audit rows written, around one request)". The naive shape — each
 * wrapper calling `runAction` for itself — runs the action once per wrapper, which
 * duplicates its writes AND makes the second wrapper's "before" snapshot see the state the
 * FIRST action already changed. Both of that wrapper's snapshots are then wrong, silently,
 * in the direction of a delta that looks correct. Found by this story's Codex review pass.
 *
 * The wrappers therefore run CONCURRENTLY and meet at a barrier inside `runAction`. That is
 * not a stylistic choice: 4.5's executor owns the before → action → after sequence
 * internally, so the only way for two wrappers to surround one action is for both to be
 * suspended inside their own `execute` at the moment it runs. Concurrency is confined to
 * this function and bounded by the size of the group.
 *
 * **ONE CALL IS ONE CYCLE — ONE ATTEMPT OF EVERY WRAPPER AND ONE OF THE ACTION.** A retry
 * calls this again with a fresh barrier, because a retry means "do the whole measured
 * interaction again". An earlier version kept one barrier across attempts, so a retried
 * wrapper's second `runAction` queued a waiter after the barrier had already fired and
 * nothing ever woke it — the stage hung forever, with no timeout anywhere in the product to
 * end it. Found by the third Codex review pass on this story. Retries resolve to zero for
 * every surface today, so it was unreachable from a compiled plan and total when reached.
 *
 * **THE DEADLOCK THIS AVOIDS IS THE WHOLE DIFFICULTY.** A wrapper whose "before" snapshot
 * fails returns WITHOUT calling `runAction` — 4.5 aborts there deliberately, because
 * performing the action would mutate the system for a comparison that can no longer be
 * made. So a wrapper may finish without ever arriving, and a barrier waiting for all N
 * arrivals would hang the entire run with no timeout anywhere to end it. Instead the
 * barrier fires as soon as no wrapper can still arrive: every one is either waiting at it or
 * has already settled. If none arrived, the action never runs — which is correct, because
 * nothing is left to measure it.
 */
async function shareAction(
  wrappers: readonly ProbeSpec[],
  target: ProbeSpec,
  attempt: number,
  runAttempt: (probe: ProbeSpec, attempt: number, runAction: ProbeActionRunner) => Promise<void>,
): Promise<void> {
  /** Wrappers that can still reach the barrier. */
  let outstanding = wrappers.length;
  const waiting: (() => void)[] = [];
  const arrived = new Set<string>();

  let actionRan = false;
  let actionFailure: unknown;

  const fireIfNobodyElseCanArrive = async (): Promise<void> => {
    if (outstanding > 0 || waiting.length === 0 || actionRan) {
      return;
    }
    actionRan = true;
    try {
      await runAttempt(target, attempt, rejectNestedAction);
    } catch (failure) {
      // Captured rather than thrown: it must reach every waiting wrapper, and letting it
      // escape here would be an unhandled rejection with nobody to observe it.
      actionFailure = failure;
    }
    for (const wake of waiting.splice(0)) {
      wake();
    }
  };

  const runAction = (wrapperId: string): ProbeActionRunner => {
    return async (aroundProbeId) => {
      if (aroundProbeId !== target.id) {
        throw new InfraError(
          `probe '${wrapperId}' wraps '${aroundProbeId}', which is not the action its group shares`,
          'this is a SpecWitness defect in the probes stage',
        );
      }

      const wait = new Promise<void>((resolve) => waiting.push(resolve));
      if (!arrived.has(wrapperId)) {
        arrived.add(wrapperId);
        outstanding -= 1;
      }
      void fireIfNobodyElseCanArrive();
      await wait;

      if (actionFailure !== undefined) {
        throw actionFailure;
      }
    };
  };

  await Promise.all(
    wrappers.map(async (wrapper) => {
      try {
        await runAttempt(wrapper, attempt, runAction(wrapper.id));
      } finally {
        if (!arrived.has(wrapper.id)) {
          // Finished without reaching the barrier — its "before" failed, so 4.5 aborted it.
          outstanding -= 1;
          await fireIfNobodyElseCanArrive();
        }
      }
    }),
  );
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
  const flaky =
    chosen.status === 'pass' && (chosen.flaky === true || results.some((r) => r.flaky === true));

  // AND SO DO THE ATTEMPT RECORDS, for exactly the same reason (story 5.4).
  //
  // This was a real defect, found by codex review rather than by the author. Carrying
  // `flaky` up but not the records produced a criterion marked `flaky: true` beside the
  // CHOSEN probe's records — which, if the chosen probe passed cleanly, are absent. The
  // stored document then said "this criterion flaked" and "nothing was retried" at once,
  // the run-level counts derived from it reported `retriedCriteria: 0`, and the failed
  // attempt's detail was gone from the criterion entirely. A document that contradicts
  // itself is worse than one that omits: no reader can tell which half is right.
  //
  // Every probe's records, in probe order, each stamped with its `probeId` so `attempt`
  // stays unambiguous once two probes' arrays sit side by side.
  const attempts = results.flatMap((result) => result.attempts ?? []);

  return {
    ...chosen,
    ...(flaky ? { flaky: true } : {}),
    ...(attempts.length === 0 ? {} : { attempts }),
  };
}
