/**
 * FR-20 / FR-22 / AD-6 / AD-7 — the staged verification state machine.
 *
 * `specwitness verify` is an explicit sequence of named stages with early-stop semantics,
 * not ad-hoc sequential code. This module is that machine, and it is where the product's
 * central promise is kept or broken: **an infrastructure failure is never reported as a
 * product FAIL, and a product FAIL is never reported as an infrastructure failure.**
 *
 * Three guarantees, each with a reason a production incident depends on:
 *
 *  1. **Two kinds of "not ok", kept apart by the type system.** A stage returning
 *     `product-negative` (a gate said no) stops the pipeline early but the run continues
 *     through aggregate → persist → teardown and ends in a `Verdict` (exit 1). A stage
 *     THROWING an AD-7 error ends the run with an `{infraError}` outcome (exit 3). Both
 *     skip the intervening stages; both still run teardown. Conflate them and a branch
 *     that does not compile is reported as "environment broken, retry" — after which the
 *     retry merges it.
 *
 *  2. **Teardown always runs.** After an early stop, after a thrown error, and after an
 *     error thrown by teardown ITSELF. And a teardown failure never replaces an outcome
 *     that was already decided: a run that FAILed on a gate and then failed to remove a
 *     worktree is still a FAIL; a run that PASSed and leaked a worktree is a PASS with a
 *     recorded teardown problem, and `specwitness clean` is the remedy. The alternative
 *     turns a legitimate FAIL into something that looks rerunnable.
 *
 *  3. **Fail closed, everywhere.** An unrecognised throw classifies as `infra`. An
 *     aggregate stage that produced no outcome yields `infra`, never a silent PASS. A
 *     stage list that is not the eleven names in order is refused before anything runs.
 *
 * `UsageError` is the one exception that is deliberately NOT classified. It is absent
 * from `InfraErrorClassification` because it is raised at the CLI edge before a run
 * exists (it exits 64, outside the 0–3 band). One reaching this depth is a programming
 * error, so it propagates rather than being laundered into a run outcome — but teardown
 * still runs first, because the always-teardown guarantee outranks the rethrow.
 *
 * AD-9: no `Date.now()`, no `Math.random()`. Every instant comes from the injected
 * `Clock`, which is what lets the tests assert exact integer durations instead of
 * "greater than zero" — an assertion that also passes when the clock is read once and
 * reused.
 */

import { redactText } from '../domain/evidence.js';
import {
  ConfigError,
  InfraError,
  IngestError,
  IntegrityError,
  ProviderError,
  UsageError,
} from '../domain/errors.js';
import type { Clock } from '../domain/ports.js';
import type { InfraErrorClassification, RunOutcome } from '../domain/run-outcome.js';
import type { RunEnvironment, RunResult } from '../domain/run-result.js';
import { STAGE_NAMES } from '../domain/stage.js';
import type { StageName, StageStatus, StageTimelineEntry } from '../domain/stage.js';
import type { RunAccumulator, Stage, StageContext } from './stage.js';

const AGGREGATE_INDEX = STAGE_NAMES.indexOf('aggregate');
const TEARDOWN_INDEX = STAGE_NAMES.indexOf('teardown');

export interface RunPipelineInput {
  /**
   * Minted at the CLI edge via `domain/run-id.ts` with the `Clock` and `Ids` ports. The
   * pipeline never mints one — it has no `Ids` port, deliberately, so a run id can only
   * come from the caller that also owns the run directory it names.
   */
  readonly runId: string;
  /** Raw; the resolve stage normalises it to the canonical `epic-7`. */
  readonly epic: string;
  /** Already resolved to a SHA by the `Vcs` port at the edge. The pipeline spawns no git. */
  readonly baseSha: string;
  readonly headSha: string;
  readonly environment: RunEnvironment;
  readonly clock: Clock;
  /** Exactly the eleven `STAGE_NAMES`, in order. Anything else is refused. */
  readonly stages: readonly Stage[];
  /**
   * Awaited AFTER teardown, with the FINISHED `RunResult`.
   *
   * The persist stage sits at position 10 of 11, so the document it writes cannot contain
   * teardown's timeline entry or `finishedAt` — and that gap is worst in exactly the case
   * that matters most, a PASS that then leaked a worktree, where the stored run is the
   * only place anyone would ever learn about the leak. So persistence happens twice: the
   * persist stage writes a crash-durable snapshot that survives a kill during teardown,
   * and this callback writes the complete document. One writer, one serializer, two
   * moments.
   *
   * If it throws, the outcome is NOT rewritten — a failed durability write must not turn
   * a legitimate FAIL into a retryable-looking infra error. The failure is recorded on the
   * `persist` timeline entry instead, which is the honest place for it.
   */
  readonly onComplete?: (result: RunResult) => Promise<void>;
}

/**
 * Maps a thrown value to its AD-7 classification.
 *
 * `unknown` on purpose: a `catch` binding is `unknown`, and the entire value of this
 * function is being safe on values nobody anticipated. Anything unrecognised — a bare
 * `Error`, a thrown string, `undefined` — is `infra`. Fail closed: an unclassified
 * exception must never surface as a product verdict.
 *
 * `ContractNotFrozenError` is a refinement of `IntegrityError` and classifies as
 * `integrity` through it, which is why the checks are `instanceof` rather than a lookup
 * on a name.
 */
export function classifyInfraError(error: unknown): InfraErrorClassification {
  if (error instanceof ConfigError) {
    return 'config';
  }
  if (error instanceof IngestError) {
    return 'ingest';
  }
  if (error instanceof IntegrityError) {
    return 'integrity';
  }
  if (error instanceof ProviderError) {
    return 'provider';
  }
  if (error instanceof InfraError) {
    return 'infra';
  }
  return 'infra';
}

/** A one-line reason for the timeline. Never a stack trace: timeline details are persisted and rendered. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Refuses a stage list that is not the eleven names in the frozen order.
 *
 * A silently reordered pipeline would still produce a plausible-looking run whose skip
 * semantics are nonsense — worktrees created after gates, teardown running first — and
 * the report would not say anything was wrong.
 */
function assertStageSequence(stages: readonly Stage[]): void {
  const names = stages.map((stage) => stage.name);
  const expected = STAGE_NAMES.join(' → ');
  if (names.length !== STAGE_NAMES.length || names.some((name, i) => name !== STAGE_NAMES[i])) {
    throw new InfraError(
      `the verify pipeline was assembled with the wrong stages: ${names.join(' → ') || '(none)'}`,
      `build the stage list with createStages() — it must be exactly: ${expected}`,
    );
  }
}

export async function runPipeline(input: RunPipelineInput): Promise<RunResult> {
  assertStageSequence(input.stages);

  const { clock } = input;
  const startedAt = clock.now();

  const accumulator: RunAccumulator = {
    epic: input.epic,
    baseSha: input.baseSha,
    headSha: input.headSha,
    gates: [],
    criteria: [],
    evidence: [],
    providerUsage: [],
    environment: input.environment,
    contractCriteria: [],
  };

  const context: StageContext = { runId: input.runId, clock, run: accumulator };

  /** One entry per stage, keyed so an outcome-time correction can amend one in place. */
  const timeline = new Map<StageName, StageTimelineEntry>();
  const record = (
    stage: StageName,
    status: StageStatus,
    durationMs: number,
    detail?: string,
  ): void => {
    // Timeline details are PERSISTED to result.json and RENDERED to a terminal, which
    // makes them capture in AD-10's sense. A stage that fails while running a project
    // command may well put that command's output in its error message — the gates stage
    // is the obvious future case — and without this the redaction that protects evidence
    // would be bypassed by the error path beside it. Redacting here rather than trusting
    // every present and future stage to remember is the difference between a guarantee
    // and a convention.
    const safe = detail === undefined ? undefined : redactText(detail);
    timeline.set(
      stage,
      safe === undefined ? { stage, status, durationMs } : { stage, status, durationMs, detail: safe },
    );
  };

  const skip = (from: number, to: number, detail: string): void => {
    for (const name of STAGE_NAMES.slice(from, to)) {
      record(name, 'skipped', 0, detail);
    }
  };

  let infraError: InfraErrorClassification | undefined;
  /** A UsageError that must propagate — held so teardown runs before it is rethrown. */
  let escaped: unknown;

  let index = 0;
  while (index < TEARDOWN_INDEX) {
    // `assertStageSequence` guarantees the index is populated; the fallback exists only
    // because `noUncheckedIndexedAccess` cannot see that.
    const stage = input.stages[index] as Stage;
    const began = clock.now().getTime();

    let result;
    try {
      result = await stage.run(context);
    } catch (error) {
      const durationMs = clock.now().getTime() - began;

      if (error instanceof UsageError) {
        escaped = error;
        record(stage.name, 'error', durationMs, `usage error escaped into the pipeline: ${reasonOf(error)}`);
        skip(index + 1, TEARDOWN_INDEX, `skipped: the run stopped at '${stage.name}'`);
        break;
      }

      infraError = classifyInfraError(error);
      record(stage.name, 'error', durationMs, `${infraError}: ${reasonOf(error)}`);
      skip(index + 1, TEARDOWN_INDEX, `skipped: the run stopped at '${stage.name}'`);
      break;
    }

    const durationMs = clock.now().getTime() - began;

    if (result.status === 'ok') {
      record(stage.name, 'ok', durationMs, result.detail);
      index += 1;
      continue;
    }

    // Product-negative: stop early, but jump forward to `aggregate` rather than out. The
    // run reached a conclusion about the branch and owes the caller a verdict, a stored
    // result and a report.
    record(stage.name, 'failed', durationMs, result.detail);
    const resumeAt = Math.max(index + 1, AGGREGATE_INDEX);
    skip(index + 1, resumeAt, `skipped: ${result.detail}`);
    index = resumeAt;
  }

  // ---- teardown, unconditionally -------------------------------------------------
  const teardown = input.stages[TEARDOWN_INDEX] as Stage;
  const teardownBegan = clock.now().getTime();
  try {
    const result = await teardown.run(context);
    const durationMs = clock.now().getTime() - teardownBegan;
    record('teardown', result.status === 'ok' ? 'ok' : 'failed', durationMs, result.detail);
  } catch (error) {
    const durationMs = clock.now().getTime() - teardownBegan;
    // Recorded, classified, and pointedly NOT allowed to change `infraError` or the
    // accumulator's outcome. Everything the run concluded, it still concludes.
    record(
      'teardown',
      'error',
      durationMs,
      `${classifyInfraError(error)}: teardown failed after the outcome was decided: ${reasonOf(error)}`,
    );
  }

  if (escaped !== undefined) {
    throw escaped;
  }

  // ---- the outcome ---------------------------------------------------------------
  let outcome: RunOutcome;
  if (infraError !== undefined) {
    outcome = { infraError };
  } else if (accumulator.outcome !== undefined) {
    outcome = accumulator.outcome;
  } else {
    // The aggregate stage ran and decided nothing. Fail closed: a missing outcome is an
    // infrastructure problem, never a PASS. Amending the aggregate entry says WHERE the
    // hole is, so this does not read as a mysterious infra error.
    outcome = { infraError: 'infra' };
    const existing = timeline.get('aggregate');
    record(
      'aggregate',
      'error',
      existing?.durationMs ?? 0,
      'infra: the aggregate stage produced no run outcome',
    );
  }

  // Read ONCE, before the result is built. `build()` runs a second time if `onComplete`
  // fails, and a clock read inside it would stamp the retry with a different instant —
  // so the document already handed to the persister and the one returned to the caller
  // would disagree about when the run ended. A run has one finishing time.
  const finishedAt = clock.now().toISOString();

  const build = (): RunResult => ({
    runId: input.runId,
    epic: accumulator.epic,
    baseSha: accumulator.baseSha,
    headSha: accumulator.headSha,
    startedAt: startedAt.toISOString(),
    finishedAt,
    outcome,
    // Emitted in STAGE_NAMES order regardless of the order stages actually finished, so
    // the timeline always reads as the pipeline is defined.
    stages: STAGE_NAMES.map(
      (name) => timeline.get(name) ?? { stage: name, status: 'skipped' as const, durationMs: 0 },
    ),
    gates: accumulator.gates,
    criteria: accumulator.criteria,
    evidence: accumulator.evidence,
    providerUsage: accumulator.providerUsage,
    environment: accumulator.environment,
    ...(accumulator.contract === undefined ? {} : { contract: accumulator.contract }),
  });

  const finished = build();

  if (input.onComplete !== undefined) {
    try {
      await input.onComplete(finished);
    } catch (error) {
      const existing = timeline.get('persist');
      record(
        'persist',
        'error',
        existing?.durationMs ?? 0,
        `${classifyInfraError(error)}: the run result could not be written after teardown: ${reasonOf(error)}`,
      );
      // Rebuilt so the amended persist entry is visible, with the SAME outcome — the
      // write failed, the conclusion did not change.
      return build();
    }
  }

  return finished;
}
