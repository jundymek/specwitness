/**
 * The `probes` stage — PLACEHOLDER.
 *
 * **Filled by Epic 4, stories 4.4–4.6** (and Epic 5 for the browser surface): it executes
 * each criterion's probes through a `SurfaceExecutor` and derives a `CriterionResult` from
 * the attempts, via the single producer in `domain/criterion-result.ts` (AD-13).
 *
 * It does NOT materialise the `skipped` results of a gates-only run, even though that was
 * the obvious place to put them. The aggregate stage does, and the reason is ADR-003: a
 * gate failure stops the pipeline early and jumps past this stage, so anything produced
 * here would be missing from exactly the run whose report is supposed to show every
 * criterion as `skipped`. See `aggregate.ts`.
 */

import type { Stage } from '../stage.js';
import { createPlaceholderStage } from './placeholder.js';

export function createProbesStage(): Stage {
  return createPlaceholderStage('probes', 'Epic 4 stories 4.4–4.6 execute the probes');
}
