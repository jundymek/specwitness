/**
 * The `aggregate` stage — AD-6's ONE converter from stage results to a `RunOutcome`.
 *
 * It calls the merged `aggregate()` in `src/domain/verdict.ts` and does nothing else. That
 * function is the product's trust anchor: pure, total, tested, with its own property
 * suite. Re-implementing any part of the precedence here would give the product two
 * answers to "did this branch pass", and the two would disagree exactly once, in
 * production, on the run somebody cared about.
 *
 * This stage is also the reason a gate failure is a stage RESULT rather than an
 * exception. The gates stage records its `GateResult`s on the accumulator and returns
 * `product-negative`; the pipeline skips ahead to here; and the conversion to
 * FAIL + `gateFailed` happens in one place, once.
 */

import { aggregate } from '../../domain/verdict.js';
import type { Stage } from '../stage.js';
import { stageOk } from '../stage.js';

export function createAggregateStage(): Stage {
  return {
    name: 'aggregate',
    run: async (context) => {
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
