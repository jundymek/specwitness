/**
 * AD-13 — the probe execution contract, and THE single producer of a `CriterionStatus`.
 *
 * A `SurfaceExecutor` executes ONE probe attempt and returns what it observed. It
 * evaluates assertions mechanically — assertions are data — but it never decides whether
 * a criterion passed. That decision, including retry orchestration, `flaky` marking and
 * the pass/fail/error/needs_human split, happens in exactly one pure function:
 * `deriveCriterionResult` below.
 *
 * The reason for one producer is not tidiness. Four surfaces (http, browser, observation,
 * shell) each adjudicating status their own way would give four subtly different answers
 * to "did a retry that eventually passed count as flaky", and the differences would only
 * ever surface as a verdict nobody could reproduce.
 *
 * `src/domain/result.ts`'s header names this file as the place its `CriterionResult` is
 * extended ADDITIVELY — with expected/actual, evidence references and severity. That is
 * `DerivedCriterionResult`; the merged type itself is untouched.
 *
 * Epic 3 only ever reaches the trivial case: a gates-only run executes no probes, so
 * every criterion derives from zero attempts and is `skipped`. The function is
 * nevertheless written and tested for the full semantics, because the alternative is
 * Epic 4 inheriting a stub and re-deciding all of it.
 *
 * AD-1: pure. Imports only sibling domain modules.
 */

import type { Severity } from './contract.js';
import type { EvidenceRef } from './evidence.js';
import type { CriterionResult, CriterionStatus } from './result.js';

/** The four probe surfaces (AD-13). All implement the same executor interface. */
export const PROBE_SURFACES = ['http', 'browser', 'observation', 'shell'] as const;

export type ProbeSurface = (typeof PROBE_SURFACES)[number];

/**
 * One thing a probe saw. Deliberately a string value rather than `unknown`: everything
 * here is persisted to `result.json`, and a model that admits non-serialisable values is
 * a model whose serializer eventually throws on real data.
 */
export interface Observation {
  readonly name: string;
  readonly value: string;
}

/**
 * One mechanically evaluated assertion.
 *
 * `expected` / `actual` are what FR-28 requires every non-pass criterion to carry; they
 * are filled by the executor, because only it knows what it compared.
 */
export interface AssertionEvaluation {
  readonly description: string;
  readonly satisfied: boolean;
  readonly expected?: string;
  readonly actual?: string;
}

/**
 * The probe could not OBSERVE at all — the port was closed, the browser crashed, the
 * command could not start.
 *
 * This is infrastructure, not product: it becomes criterion `error`, which aggregation
 * turns into an `{infraError}` outcome (exit 3), never a FAIL. A probe that could not
 * look is not the same as a probe that looked and saw a violation, and the day those two
 * are conflated is the day a flaky environment starts blocking mergeable branches.
 */
export interface ProbeExecError {
  readonly message: string;
  readonly hint?: string;
}

/** What one probe attempt produced (AD-13's `ProbeAttempt`). */
export interface ProbeAttempt {
  /** 1-based. Attempt 2+ exists only where retries are opt-in for the probe class. */
  readonly attempt: number;
  readonly observations: readonly Observation[];
  readonly assertionEvaluations: readonly AssertionEvaluation[];
  readonly evidence: readonly EvidenceRef[];
  readonly execError?: ProbeExecError;
  /** Whole milliseconds, from the injected `Clock` (AD-9). */
  readonly durationMs: number;
}

/** What the pipeline asks a surface to do. Epics 4/5 narrow `params` per surface. */
export interface ProbeRequest {
  readonly criterionId: string;
  readonly surface: ProbeSurface;
  /** Surface-specific parameters, resolved at plan compile time (AD-9). */
  readonly params: Readonly<Record<string, unknown>>;
}

/**
 * Executes one probe attempt. Implemented by all four surfaces, identically shaped.
 *
 * It returns observations and assertion evaluations. It does NOT return a
 * `CriterionStatus`, and there is nowhere in this interface to put one.
 */
export interface SurfaceExecutor {
  readonly surface: ProbeSurface;
  execute(request: ProbeRequest): Promise<ProbeAttempt>;
}

/**
 * The criterion as the frozen contract declares it — the derivation inputs that do not
 * come from a probe.
 *
 * The integrity stage records these from the verified contract so that no later stage,
 * and no renderer, ever re-reads the contract file to find out what a criterion said.
 */
export interface ContractCriterionRef {
  /** Canonical criterion id, `E<n>-<NN>` (see `domain/ids.ts`). */
  readonly criterionId: string;
  readonly statement: string;
  readonly severity: Severity;
}

/**
 * The merged `CriterionResult`, extended ADDITIVELY (AD-13; `domain/result.ts` names this
 * file).
 *
 * `statement` and `severity` are always present — copied verbatim from the frozen
 * contract at derivation time, so FR-29's per-criterion "one-line summary" is a human's
 * own words rather than a sentence a renderer synthesised from a status.
 */
export interface DerivedCriterionResult extends CriterionResult {
  readonly statement: string;
  /** Recorded and reported; it does NOT soften aggregation in V0 (FR-27). */
  readonly severity: Severity;
  /** What was required. Present on every non-pass result (FR-28). */
  readonly expected?: string;
  /** What was observed. Present on every non-pass result (FR-28). */
  readonly actual?: string;
  /** At least one reference on every non-pass result (FR-28). */
  readonly evidence?: readonly EvidenceRef[];
}

/** How one attempt came out, before retry orchestration is considered. */
type AttemptOutcome = Exclude<CriterionStatus, 'skipped'>;

function outcomeOf(attempt: ProbeAttempt): AttemptOutcome {
  if (attempt.execError !== undefined) {
    // The exec error outranks any assertion the probe managed to evaluate: those
    // assertions ran against a broken observation, so reporting `fail` from them would
    // manufacture product evidence out of an infrastructure failure.
    return 'error';
  }
  if (attempt.assertionEvaluations.length === 0) {
    // Nothing was adjudicated mechanically. Calling this `pass` would mint a PASS out of
    // nothing — the one direction this product must never fail in. A compiled plan always
    // gives a probe at least one assertion, so in practice this is unreachable; it is
    // here so that the unreachable case is safe rather than merely lucky.
    return 'needs_human';
  }
  return attempt.assertionEvaluations.every((evaluation) => evaluation.satisfied) ? 'pass' : 'fail';
}

/**
 * Derives a criterion's result from its probe attempts. Pure, total, no I/O.
 *
 * **The FINAL attempt decides.** That is what makes a retry mean anything: a probe class
 * with retries enabled is asserting that a later attempt is more trustworthy than an
 * earlier one. Earlier attempts survive as `flaky` and in evidence, never as a status.
 *
 * `flaky` is set only for FR-32's actual case — a pass that happened *only* on retry. A
 * run that passed and then failed is a failure, not flake; marking it flaky would soften
 * a real defect into noise. A flaky pass never changes a verdict: aggregation treats it
 * as a pass, and visibility is the entire point.
 */
export function deriveCriterionResult(
  criterion: ContractCriterionRef,
  attempts: readonly ProbeAttempt[],
): DerivedCriterionResult {
  const base = {
    criterionId: criterion.criterionId,
    statement: criterion.statement,
    severity: criterion.severity,
  };

  const final = attempts.at(-1);
  if (final === undefined) {
    // Nothing ran. Inert by definition, and the only case a gates-only run reaches.
    return { ...base, status: 'skipped' };
  }

  const status = outcomeOf(final);
  const flaky =
    status === 'pass' && attempts.slice(0, -1).some((earlier) => outcomeOf(earlier) !== 'pass');

  if (status === 'pass') {
    return flaky ? { ...base, status, flaky: true } : { ...base, status };
  }

  // FR-28: every non-pass result carries expected vs actual plus at least one evidence
  // reference — when the attempt produced them. The fields are optional rather than
  // required because a probe that crashed before observing anything has nothing honest to
  // put there, and inventing a value would be worse than omitting one.
  const firstUnsatisfied = final.assertionEvaluations.find((evaluation) => !evaluation.satisfied);
  const expected = firstUnsatisfied?.expected;
  const actual = status === 'error' ? final.execError?.message : firstUnsatisfied?.actual;

  return {
    ...base,
    status,
    ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual }),
    ...(final.evidence.length === 0 ? {} : { evidence: final.evidence }),
  };
}
