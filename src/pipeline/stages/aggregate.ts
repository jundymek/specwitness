/**
 * The `aggregate` stage — AD-6's ONE converter from stage results to a `RunOutcome`, and
 * the point at which the run's answer is made complete.
 *
 * It does exactly two things:
 *
 *  1. **Completes the criterion set.** Every criterion the frozen contract declares must
 *     appear exactly once in the result; any that no probe resolved is `skipped`.
 *  2. **Calls the merged `aggregate()`** in `src/domain/verdict.ts` — the product's trust
 *     anchor: pure, total, tested, with its own property suite. Re-implementing any part
 *     of its precedence here would give the product two answers to "did this branch
 *     pass", and the two would disagree exactly once, in production, on the run somebody
 *     cared about.
 *
 * Step 1 lives HERE, and not in the probes stage, because of ADR-003. When a gate fails,
 * the pipeline stops early and jumps straight to this stage — `probes` is `skipped`, by
 * design, so that a branch which does not build costs no AI or browser spend. If the
 * skipped criterion results were materialised in the probes stage, they would exist on
 * the happy path and be **missing in exactly the case ADR-003 is about**: a gate-failed
 * run, whose report is supposed to show every criterion as `skipped`, would show none at
 * all.
 *
 * That was a real defect in the first version of this file. It survived my own tests
 * because they asserted the criterion set only on the path where it happened to work —
 * the same shape of mistake as asserting a guard is green without ever watching it fail.
 * Putting the completion in the one stage every completed run passes through means there
 * is one code path rather than two.
 *
 * The status still comes from `deriveCriterionResult`, so AD-13's "exactly one producer
 * of a CriterionResult" holds: this stage decides WHICH criteria still need deriving,
 * never what their status is.
 */

import { deriveCriterionResult } from '../../domain/criterion-result.js';
import type { DerivationOptions, DerivedCriterionResult } from '../../domain/criterion-result.js';
import type { RedactionOptions } from '../../domain/evidence.js';
import type { PlanCriterion } from '../../domain/plan.js';
import { aggregate } from '../../domain/verdict.js';
import type { Stage } from '../stage.js';
import { stageOk } from '../stage.js';

/**
 * What this stage needs in order to materialise a criterion the probes stage never reached.
 *
 * OPTIONAL, and the stage is correct without it — every field below only enriches a result
 * whose STATUS is decided elsewhere. A pipeline assembled without a plan still completes
 * its criterion set exactly as before.
 *
 * Story 5.3 added it, and the defect it closes is worth stating because the shape recurs.
 * The probes stage forwards the plan's reviewer `reason` and `guidance` into the
 * derivation — but ADR-003 means a gate failure skips that stage ENTIRELY and jumps here.
 * A `verifiability: human` criterion then materialised through `deriveCriterionResult(c, [])`
 * with no options: still `needs_human`, because the clause is unconditional, but stripped of
 * the guidance a reviewer needs. So exactly the runs where a person is told "you must decide
 * this" alongside a failing gate were the runs that told them nothing about how — the very
 * failure 5.3 exists to remove, surviving on the one path 5.3 did not cover.
 *
 * Found by review rather than by the story's own tests, which asserted the channel only on
 * the path where it happened to work — the same shape of mistake this file's header already
 * records about the criterion set itself.
 */
export interface AggregateStageDeps {
  /**
   * The compiled plan's criteria, so a criterion materialised here carries the same
   * reviewer guidance the probes stage would have given it. Same value the probes stage
   * receives; the edge binds both from one plan.
   */
  readonly criteria?: readonly PlanCriterion[];
  /** Config-declared extra redaction patterns (AD-10), as the probes stage threads them. */
  readonly redaction?: RedactionOptions;
}

export function createAggregateStage(deps: AggregateStageDeps = {}): Stage {
  const planned = new Map((deps.criteria ?? []).map((entry) => [entry.criterionId, entry]));

  /**
   * The derivation options for a criterion nothing resolved.
   *
   * It NEVER passes `plannedNeedsHuman`, and that omission is deliberate rather than an
   * oversight. Passing it would turn a plan-deferred criterion from `skipped` into
   * `needs_human` on the gate-failure path — a change to what the derivation DECIDES on a
   * path ADR-003 governs, which is 4.7 territory and not story 5.3's to take quietly. This
   * function only carries reviewer text onto results whose status is already `needs_human`;
   * a criterion that derives to `skipped` reaches neither needs-human branch and so carries
   * neither field, which is asserted.
   */
  const optionsFor = (criterionId: string): DerivationOptions => {
    const entry = planned.get(criterionId);
    if (entry === undefined || entry.disposition !== 'needs-human') {
      return { ...deps.redaction };
    }
    return {
      ...deps.redaction,
      needsHumanReason: entry.reason,
      reviewerGuidance: entry.guidance,
    };
  };

  return {
    name: 'aggregate',
    run: async (context) => {
      const resolved = new Map<string, DerivedCriterionResult>(
        context.run.criteria.map((criterion) => [criterion.criterionId, criterion]),
      );

      // Contract order, because that is the order a human reviewed and the order a report
      // should read in. A criterion some probe resolved keeps its result; one nothing
      // reached derives from zero attempts, which is `skipped`.
      const complete = context.run.contractCriteria.map(
        (criterion) =>
          resolved.get(criterion.criterionId) ??
          deriveCriterionResult(criterion, [], optionsFor(criterion.criterionId)),
      );

      // A result for a criterion the contract does not declare is kept rather than
      // dropped. It should not happen — and silently discarding it would hide the bug
      // that produced it, while keeping it makes that bug visible in the report.
      const declared = new Set(
        context.run.contractCriteria.map((criterion) => criterion.criterionId),
      );
      const undeclared = context.run.criteria.filter(
        (criterion) => !declared.has(criterion.criterionId),
      );

      context.run.criteria = [...complete, ...undeclared];

      const outcome = aggregate(context.run.gates, context.run.criteria);
      // The only write to `outcome` anywhere in the pipeline (AD-6).
      context.run.outcome = outcome;

      return stageOk(
        outcome.verdict === undefined
          ? `infra error: ${outcome.infraError}`
          : `verdict: ${outcome.verdict}`,
      );
    },
  };
}
