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

import type { Severity, Verifiability } from './contract.js';
import { redactText } from './evidence.js';
import type { EvidenceRef, RedactionOptions } from './evidence.js';
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
  /**
   * `automated` or `human`, from the contract.
   *
   * Load-bearing, not decorative: a `human` criterion may never auto-PASS (Q39), and this
   * is the field that makes that enforceable. It was missing from this type at first, so
   * `verifiability` was dropped at the integrity stage and a contract that correctly used
   * the feature verified PASS at exit 0 - the machine answering the one question its
   * author had written down that no machine may answer. Found by story 3.7's agent, whose
   * exit-2 acceptance criterion it made unsatisfiable.
   */
  readonly verifiability: Verifiability;
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
  /**
   * What every attempt did, when there was more than one (story 5.4, AD-9, FR-32).
   *
   * PRESENT ONLY WHEN A CRITERION TOOK MORE THAN ONE ATTEMPT, and that is a decision
   * rather than an omission. Retries default to 0 for every surface, so in the shipped
   * default configuration every criterion has exactly one attempt whose outcome,
   * `expected`/`actual` and evidence ARE the fields above — repeating them here would
   * double every stored run to say nothing a reader could not already see. The record
   * exists exactly where it carries information the result cannot: on the attempts the
   * derivation threw away.
   *
   * IT IS THE ONLY PLACE A FLAKY PASS'S FAILED ATTEMPT SURVIVES on the criterion. The
   * pass branch below returns early with no `expected`, no `actual` and no `evidence`,
   * because a pass has nothing to put there — so without this, `flaky: true` would be a
   * marker pointing at nothing, and a flake nobody can investigate is a flake everybody
   * learns to skim past. That is the failure FR-32 exists to prevent, arriving one step
   * later than expected.
   */
  readonly attempts?: readonly CriterionAttemptRecord[];
}

/**
 * One attempt, as the persisted run and the terminal report record it.
 *
 * Deliberately NOT `ProbeAttempt`. That type carries raw observations and every assertion
 * evaluation, redacted by nobody, and is an execution input rather than a report; this is
 * the auditable summary — what the attempt came out as, how long it took, what it was
 * compared against, and where its artifact is. Everything textual here has been through
 * `redactText` at the same boundary as the criterion's own diagnostics, because an
 * attempt whose text took a different route is a leak the other attempts' clean output
 * would disguise.
 */
export interface CriterionAttemptRecord {
  /** 1-based, copied from the attempt rather than from the array index. */
  readonly attempt: number;
  /** What this attempt alone came out as, before retry orchestration is considered. */
  readonly outcome: AttemptOutcome;
  /** Whole milliseconds, from the injected `Clock` (AD-9). */
  readonly durationMs: number;
  /** What this attempt required, when it evaluated something and was unsatisfied. */
  readonly expected?: string;
  /** What this attempt observed — or, for an `error`, why it could not observe. */
  readonly actual?: string;
  /** This attempt's own artifacts. Attempt 2 never overwrites attempt 1's files. */
  readonly evidence?: readonly EvidenceRef[];
}

/**
 * What one derivation needs to know beyond the contract and the attempts.
 *
 * Extends `RedactionOptions` rather than sitting beside it so that every existing call
 * site — two or three arguments, `RedactionOptions` in the third — keeps compiling
 * unchanged, and so there is still exactly ONE options bag reaching the single producer.
 */
export interface DerivationOptions extends RedactionOptions {
  /**
   * The executed PLAN carried this criterion as `needs-human` rather than mapping it to
   * probes — Q38's `not-safely-automatable`, the second of Q39's two triggers.
   *
   * THIS IS A SEAM DEFECT'S FIX, and the defect is worth stating because the shape of it
   * recurs. `domain/plan.ts` is explicit that `not-safely-automatable` is one of "Q39's
   * TWO — and only two — NEEDS_HUMAN triggers", and that such a criterion is "recorded,
   * surfaced in the report, and never silently dropped". But the disposition lives in the
   * PLAN, and until story 4.7 nothing executed a plan, so this function had never been
   * given it: the criterion simply produced no attempts, derived to `skipped`, and
   * `aggregate` treats `skipped` as inert. A plan-author that explicitly refused to
   * automate a criterion therefore yielded **PASS, exit 0, merge-eligible** — the
   * green-for-nothing this product exists to make impossible, reached by a route no unit
   * suite could see because it only exists where the plan meets the derivation.
   *
   * It is checked BEFORE attempts, unconditionally, for the same reason human
   * verifiability is: a plan's refusal to automate is a compile-time fact, and a run-time
   * observation may not overturn it. (In practice no attempt exists for such a criterion —
   * the probes stage executes nothing for it — so the unconditional form guards a wiring
   * mistake rather than a legitimate case.)
   */
  readonly plannedNeedsHuman?: boolean;
}

/** How one attempt came out, before retry orchestration is considered. */
export type AttemptOutcome = Exclude<CriterionStatus, 'skipped'>;

/**
 * The same union as a value, so `src/schemas/` can mirror it without re-listing literals.
 *
 * `satisfies` pins it to the type, so a member that is not an attempt outcome fails to
 * compile; `tests/unit/domain/criterion-attempts.test.ts` covers the other direction — a
 * status added to `CRITERION_STATUSES` and forgotten here. `skipped` is excluded because
 * an attempt that ran is by definition not skipped: the criterion may be, the attempt
 * cannot.
 */
export const ATTEMPT_OUTCOMES = [
  'pass',
  'fail',
  'needs_human',
  'error',
] as const satisfies readonly AttemptOutcome[];

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
  options?: DerivationOptions,
): DerivedCriterionResult {
  // `statement` and `severity` come from the frozen contract — text a human wrote and
  // reviewed, not text a probe captured — so they are carried verbatim. Redacting them
  // would mangle the contract's own words in the report.
  const base = {
    criterionId: criterion.criterionId,
    statement: criterion.statement,
    severity: criterion.severity,
  };

  // HUMAN VERIFIABILITY DECIDES FIRST, before attempts are even looked at.
  //
  // `domain/contract.ts` is unconditional about this: human criteria "always resolve to
  // NEEDS_HUMAN and never auto-PASS - that is one of only two NEEDS_HUMAN triggers in the
  // whole product (Q39), which is why this is a PROPERTY OF THE CONTRACT rather than a
  // judgement made later at run time". Attempts are a run-time judgement, so they cannot
  // override it; that last clause is the whole point of the sentence.
  //
  // Dropping `verifiability` at the integrity stage is what made a contract whose author
  // had written "no machine may answer this" verify PASS at exit 0. A first fix carried
  // the field but applied it only when there were no attempts, reasoning that a future
  // human-input surface should be able to report a recorded judgement. That was a silent
  // redesign of a recorded decision, and review caught it: if Epic 4/5 wants a probe to
  // adjudicate a human criterion, the way to get that is an ADR, not a branch here.
  if (criterion.verifiability === 'human') {
    return { ...base, status: 'needs_human' };
  }

  // THE PLAN'S OWN REFUSAL DECIDES SECOND, and also before attempts. See
  // `DerivationOptions.plannedNeedsHuman`: this is Q39's other trigger, and without it a
  // criterion the plan-author declined to automate reported PASS at exit 0.
  if (options?.plannedNeedsHuman === true) {
    return { ...base, status: 'needs_human' };
  }

  const final = attempts.at(-1);
  if (final === undefined) {
    // Nothing ran. Inert by definition, and the case every automated criterion of a
    // gates-only run reaches.
    return { ...base, status: 'skipped' };
  }

  const status = outcomeOf(final);
  const flaky =
    status === 'pass' && attempts.slice(0, -1).some((earlier) => outcomeOf(earlier) !== 'pass');

  // Story 5.4. Built for EVERY status including `pass`, and spread into both returns below
  // rather than into one, because the flaky case is precisely the one that returns early:
  // a pass carries no expected, no actual and no evidence, so this is the only place the
  // attempt it was flaky ABOUT is recorded at all. See `DerivedCriterionResult.attempts`
  // for why a single attempt gets no record.
  const record =
    attempts.length > 1
      ? { attempts: attempts.map((each) => attemptRecord(each, options)) }
      : {};

  if (status === 'pass') {
    return flaky ? { ...base, status, flaky: true, ...record } : { ...base, status, ...record };
  }

  // FR-28: every non-pass result carries expected vs actual plus at least one evidence
  // reference — when the attempt produced them. The fields are optional rather than
  // required because a probe that crashed before observing anything has nothing honest to
  // put there, and inventing a value would be worse than omitting one.
  //
  // REDACTED HERE, at the same boundary as evidence. `expected` and `actual` are copied
  // from what a surface observed — an HTTP response body, a shell command's output, an
  // exec error's message — and they are persisted to result.json and printed to a
  // terminal exactly like evidence is. Without this they would be the one path by which
  // a captured credential reaches a stored run unredacted, sitting right beside the
  // evidence fields that are protected. AD-10 says redaction happens at capture; this is
  // capture.
  const { expected, actual } = diagnostics(final, status, options);

  return {
    ...base,
    status,
    ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual }),
    ...(final.evidence.length === 0 ? {} : { evidence: final.evidence }),
    ...record,
  };
}

/**
 * What one attempt was required to see and what it saw, redacted.
 *
 * Extracted so the criterion's own diagnostics and every per-attempt record are produced
 * by ONE function. Two copies of this would be two redaction boundaries, and the second
 * one is the one that eventually forgets — a leak the first attempt's clean output would
 * disguise, which is exactly the shape Epic 3's retrospective §7 warns about.
 */
function diagnostics(
  attempt: ProbeAttempt,
  outcome: AttemptOutcome,
  options: DerivationOptions | undefined,
): { expected?: string; actual?: string } {
  const firstUnsatisfied = attempt.assertionEvaluations.find(
    (evaluation) => !evaluation.satisfied,
  );
  const redact = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : redactText(value, options);

  return {
    expected: redact(firstUnsatisfied?.expected),
    actual: redact(
      outcome === 'error' ? attempt.execError?.message : firstUnsatisfied?.actual,
    ),
  };
}

/**
 * One attempt as the report and the persisted run record it (story 5.4).
 *
 * Notice what this does NOT do: it never looks at any other attempt, and it never
 * produces a `CriterionStatus`. `outcome` is what THIS attempt alone came out as —
 * `deriveCriterionResult` above is still the single producer of the criterion's status
 * (AD-13), and the flake rule is still the one Epic 4 wrote and proved. Recording an
 * attempt is bookkeeping; deciding what a criterion is remains one function's job.
 */
function attemptRecord(
  attempt: ProbeAttempt,
  options: DerivationOptions | undefined,
): CriterionAttemptRecord {
  const outcome = outcomeOf(attempt);
  const { expected, actual } = diagnostics(attempt, outcome, options);

  return {
    attempt: attempt.attempt,
    outcome,
    durationMs: attempt.durationMs,
    ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual }),
    ...(attempt.evidence.length === 0 ? {} : { evidence: attempt.evidence }),
  };
}
