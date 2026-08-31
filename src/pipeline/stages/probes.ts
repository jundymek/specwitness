/**
 * The `probes` stage — PLACEHOLDER, but not an empty one.
 *
 * **Filled by Epic 4, stories 4.4–4.6** (and Epic 5 for the browser surface): it executes
 * each criterion's probes through a `SurfaceExecutor` and derives a `CriterionResult` from
 * the attempts.
 *
 * Today it does the one thing a gates-only run genuinely requires, and does it through
 * the real machinery rather than around it: **every criterion in the frozen contract gets
 * a `skipped` result**, derived by `deriveCriterionResult(criterion, [])` — AD-13's single
 * producer, exercised on its trivial case.
 *
 * Why that is not gold-plating a placeholder. ADR-003 says a gate failure leaves criteria
 * `skipped`, and FR-29 makes the report list criteria per-criterion. With an empty array
 * the Criteria section of every Epic 3 report would be blank, an end-to-end assertion that
 * "every criterion is skipped" would be vacuously true, and the first real defect in that
 * area would only show up once probing existed. `skipped` with a statement is the honest
 * description of a run that checked the build and nothing else — and `aggregate()` treats
 * `skipped` as inert, so it changes no verdict.
 *
 * When Epic 4 fills this in, the shape it produces does not change; only the attempts do.
 */

import { deriveCriterionResult } from '../../domain/criterion-result.js';
import type { Stage } from '../stage.js';
import { stageOk } from '../stage.js';

export function createProbesStage(): Stage {
  return {
    name: 'probes',
    run: async (context) => {
      context.run.criteria = context.run.contractCriteria.map((criterion) =>
        // Zero attempts, because nothing probed. The derivation, not a literal
        // `{status: 'skipped'}`, so there stays exactly one producer of a
        // `CriterionStatus` in the codebase (AD-13).
        deriveCriterionResult(criterion, []),
      );

      return stageOk(
        `not implemented yet — Epic 4 stories 4.4–4.6 execute probes; ` +
          `${context.run.criteria.length} criteria recorded as skipped`,
      );
    },
  };
}
