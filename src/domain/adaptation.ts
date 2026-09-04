/**
 * FR-18 / AC1 — what a run says about a mechanics adaptation. Story 5.6.
 *
 * AC1 asks for the run to be "marked `adapted: true` in report and JSON". The marker alone
 * is not enough for a human to trust the run, and shipping only the marker would produce
 * exactly the artifact this product exists to replace: an announcement with no evidence
 * behind it. So this module carries the marker AND the audit record — **what was proposed,
 * what was applied, and to which probe** — and the renderers show both.
 *
 * ============================================================================
 * THE TWO LIES THIS SHAPE IS BUILT TO MAKE IMPOSSIBLE
 * ============================================================================
 *
 * 1. **A REJECTED PROPOSAL MARKED `adapted`.** `adapted` is `true` only when at least one
 *    proposal was validated AND applied AND re-executed. A payload that the schema refused
 *    changed nothing about what ran, so a run carrying it is not an adapted run. Marking it
 *    would be a lie in the direction that matters — it would tell a reader that a result
 *    depended on a change that never happened.
 *
 * 2. **AN ACCEPTED PROPOSAL THAT IS NOT RECORDED.** The inverse, and equally bad. If a
 *    probe was changed, `applied` says which probe, which field, and **from what to what**.
 *    A reader can see that a pass required changing how the probe looked; an adapted pass
 *    is therefore never presented as an ordinary pass.
 *
 * A REFUSAL IS RECORDED TOO, in `refusal`, and that is deliberate rather than incidental.
 * "The provider proposed something illegal and was refused" is a fact about the run that a
 * reviewer should be able to see — silently discarding it would make a hostile provider
 * indistinguishable from an absent one. `adapted` stays `false` on that path.
 *
 * ============================================================================
 * ADAPTATION IS NOT A RETRY, AND THIS FILE IS WHERE THAT IS KEPT TRUE
 * ============================================================================
 *
 * Story 5.4 owns repetition: `attempts`, `flaky` and `flakiness.*` mean **the same probe
 * run more than once** and change only how often something was tried. An adaptation
 * **changes the probe's mechanics** and is a different fact about a run. The two vocabularies
 * are disjoint on purpose and were agreed at wave-3 intent-sync — one word for two different
 * things in one report is how a reader stops being able to trust either.
 *
 * So `adapted` lives HERE, at the run, and appears in none of 5.4's structures. Nothing in
 * this file counts attempts and nothing in 5.4's counts adaptations.
 *
 * AD-1: pure. Imports one sibling domain module for `BoundedText`.
 * AD-10: every free-text value here is a `BoundedText` — redacted and capped at the moment
 * it was built, never re-processed by a renderer.
 */

import type { BoundedText } from './evidence.js';

/** Which mechanics field a proposal changed. The closed set the payload schema permits. */
export type AdaptedMechanicsField = 'path' | 'scenario';

/**
 * One applied change: which probe, which field, from what to what.
 *
 * `from` and `to` are both `BoundedText` because both are shown to a human and persisted to
 * `result.json`. `to` is **provider-authored text** and is the more obvious hazard, but
 * `from` is the project's own compiled plan content and is redacted for the same reason
 * everything else is: a scenario can carry a literal value a `fill` step types into a form,
 * and the fail-closed default treats undeclared text as potentially sensitive (Epic 3 retro
 * section 6).
 */
export interface AppliedMechanicsChange {
  /** The criterion whose probe was adapted. Contract ids only, never a statement (AD-5). */
  readonly criterionId: string;
  /** The probe that was adapted. A SELECTOR: no adaptation can rename a probe. */
  readonly probeId: string;
  readonly field: AdaptedMechanicsField;
  /** The compiled plan's value, before adaptation. */
  readonly from: BoundedText;
  /** The provider's proposed value, as applied to the plan COPY. */
  readonly to: BoundedText;
}

/**
 * AC1's run-level marker, plus the record that makes it auditable.
 *
 * ABSENT ENTIRELY when adaptation was never attempted — a default `verify` run carries no
 * key at all, which is what makes "an unadapted run carries no marker and no record"
 * assertable rather than a matter of reading a `false`.
 */
export interface RunAdaptation {
  /**
   * TRUE only when at least one proposal was validated, applied to the plan copy and
   * re-executed. Never true for a refused payload; never true for an empty `applied`.
   */
  readonly adapted: boolean;
  /** Every change that was applied. Empty when a proposal arrived and was refused. */
  readonly applied: readonly AppliedMechanicsChange[];
  /**
   * Why nothing was applied, when a proposal arrived and was not accepted.
   *
   * Bounded and redacted like everything else: the text summarises the gate's refusal, and
   * a refusal message quotes what was wrong with a payload a hostile provider wrote.
   */
  readonly refusal?: BoundedText;
}
