/**
 * AD-6 — the stage interface, and the two-armed stage result.
 *
 * **The whole story is in the shape of `StageResult`.** A stage either ran clean, or it
 * produced a PRODUCT-relevant negative outcome. There is deliberately no third arm: an
 * INFRASTRUCTURE problem is a THROWN AD-7 error, never a return value.
 *
 * That asymmetry is the mechanism, not a convention. AD-6 says a `GateFailure` is a stage
 * RESULT and the aggregate stage is the only converter from stage results to a
 * `RunOutcome`. If the gates stage could signal "the build is broken" by throwing, that
 * failure would classify as infrastructure and exit 3 — and a harness reading exit 3 is
 * told "the environment is broken, retry", so a branch that simply does not compile gets
 * retried and then merged. Making the negative arm a return value and the infra arm an
 * exception is what makes that specific production accident unrepresentable rather than
 * merely discouraged.
 *
 * Note what the negative arm does NOT carry: results. A stage records its `GateResult`s
 * and evidence on the accumulator and returns only a `detail` string. A stage result
 * carrying a `GateResult[]` would be a second path into the outcome, competing with the
 * aggregate stage for the one job AD-6 gives it.
 *
 * AD-1: application layer. `domain`, `schemas`, siblings, `config`, `infra`, `providers`,
 * `surfaces` and npm — never `cli`, never `authoring` / `ingest` / `report`. Enforced by
 * the `pipeline-layer` rule in `.dependency-cruiser.cjs`.
 */

import type { ContractCriterionRef, DerivedCriterionResult } from '../domain/criterion-result.js';
import type { Evidence } from '../domain/evidence.js';
import type { Clock } from '../domain/ports.js';
import type { GateResult } from '../domain/result.js';
import type { RunAdaptation } from '../domain/adaptation.js';
import type { RunOutcome } from '../domain/run-outcome.js';
import type {
  ContractSummary,
  ProviderUsage,
  RunEnvironment,
  RunResult,
} from '../domain/run-result.js';
import type { StageName } from '../domain/stage.js';

/**
 * What a stage returns.
 *
 * `ok` — nothing negative happened; the pipeline advances.
 *
 * `product-negative` — the stage observed something that makes the branch non-mergeable
 * (today: a gate said no). The pipeline stops early, skips ahead to `aggregate`, and the
 * run still reaches aggregate → persist → teardown and ends in a `Verdict`. The stage
 * does not decide the outcome; it records its results on the accumulator and `aggregate`
 * converts them.
 */
export type StageResult =
  | { readonly status: 'ok'; readonly detail?: string }
  | { readonly status: 'product-negative'; readonly detail: string };

/** Convenience constructors, so a stage body reads as its intent. */
export const stageOk = (detail?: string): StageResult =>
  detail === undefined ? { status: 'ok' } : { status: 'ok', detail };

export const stageProductNegative = (detail: string): StageResult => ({
  status: 'product-negative',
  detail,
});

/**
 * The mutable run state stages fill in, frozen into a `RunResult` by `runPipeline`.
 *
 * Mutable ONLY inside `src/pipeline/**`. Nothing outside this directory sees this type:
 * consumers get the immutable `RunResult`.
 */
export interface RunAccumulator {
  /** Raw on entry; the resolve stage replaces it with the canonical `epic-7`. */
  epic: string;
  baseSha: string;
  headSha: string;
  gates: GateResult[];
  criteria: DerivedCriterionResult[];
  evidence: Evidence[];
  providerUsage: ProviderUsage[];
  environment: RunEnvironment;
  /** Set by the integrity stage once the merged guard has returned. */
  contract?: ContractSummary;
  /**
   * The verified contract's criteria, recorded by the integrity stage so that no later
   * stage and no renderer re-reads the contract file (AD-11).
   */
  contractCriteria: ContractCriterionRef[];
  /** Written by the AGGREGATE stage and by nothing else (AD-6). */
  outcome?: RunOutcome;
  /**
   * Written by the PROBES stage and by nothing else (story 5.6).
   *
   * Absent unless an adaptation was attempted. The probes stage is the only place that can
   * fill it: adaptation needs the verification worktree, the resolved services and the
   * bound evidence sink, all of which exist only while that stage is running.
   */
  adaptation?: RunAdaptation;
}

/** What every stage is handed. Ports arrive here; a stage constructs no adapter. */
export interface StageContext {
  readonly runId: string;
  /** AD-9. A stage never reads the wall clock directly. */
  readonly clock: Clock;
  readonly run: RunAccumulator;
  /**
   * The run so far, as the immutable `RunResult` every consumer outside the pipeline
   * sees. Built by the runner on demand.
   *
   * This exists for the `persist` stage (story 3.5), which has to write a `RunResult` and
   * cannot assemble one: `startedAt`, `finishedAt` and the stage timeline live in the
   * runner, not in the accumulator. Without it that story would have to duplicate the
   * runner's state or reopen this interface in wave B.
   *
   * WHAT IT DOES NOT CONTAIN, because it cannot: the stages that have not run yet. Called
   * from `persist` (position 10 of 11) the snapshot shows `teardown` as `skipped` and a
   * `finishedAt` of "now" — which is exactly the crash-durable snapshot that stage is
   * for. The complete document, with teardown's entry and the real `finishedAt`, reaches
   * the caller through `RunPipelineInput.onComplete` after teardown.
   *
   * @throws {InfraError} before the aggregate stage has decided an outcome. A "result"
   * with no verdict and no infra error is not a result, and inventing one here would put
   * a fabricated outcome into a persisted document.
   */
  snapshot(): RunResult;
}

/** One named step of the verification state machine. */
export interface Stage {
  readonly name: StageName;
  run(context: StageContext): Promise<StageResult>;
}
