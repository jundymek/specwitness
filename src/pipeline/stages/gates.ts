/**
 * The `gates` stage — PLACEHOLDER.
 *
 * **Filled by story 3.4 (arnold), wave B.** He replaces the body of this file with
 * `createGatesStage(deps)`, which runs the Project Config's deterministic gates in
 * declaration order inside the worktree, with early stop (FR-20).
 *
 * The contract he builds to, restated here because it is the most load-bearing seam in
 * the epic:
 *
 *  - a failing gate is a PRODUCT-negative STAGE RESULT — `stageProductNegative(...)` —
 *    and NEVER a thrown exception. A thrown gate failure classifies as infrastructure and
 *    exits 3, which tells a harness "the environment is broken, retry"; the retry then
 *    merges a branch that simply does not compile (AD-6);
 *  - a gate that cannot be spawned at all — binary missing, invalid cwd, timeout — IS an
 *    `InfraError` and IS thrown, because a gate that never ran is evidence about the
 *    environment, not about the branch;
 *  - `GateResult`s and `Evidence` go on the accumulator, not in the return value: the
 *    aggregate stage is the only converter from stage results to a `RunOutcome`.
 *
 * Until then a run executes no gates, so `gates` stays empty and `aggregate` returns PASS
 * over an empty set — the correct reading of "nothing was checked", and one the report
 * shows as a stage that is not implemented yet rather than as a green build.
 */

import type { Stage } from '../stage.js';
import { createPlaceholderStage } from './placeholder.js';

export function createGatesStage(): Stage {
  return createPlaceholderStage('gates', 'story 3.4 executes the deterministic gates');
}
