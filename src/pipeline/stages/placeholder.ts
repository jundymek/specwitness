/**
 * The shared body of a not-yet-implemented stage.
 *
 * The eleven-stage sequence ships COMPLETE in wave A even though seven of the stages have
 * no behaviour yet. That is deliberate and it buys three things:
 *
 *  - `runPipeline` can assert its stage list is the eleven frozen names in order from day
 *    one, so a later story cannot quietly assemble a pipeline that skips a step;
 *  - the state machine's early-stop and always-teardown tests exercise every skip
 *    position, not the four that happen to be implemented;
 *  - each later story REPLACES a file that already exists at a path everyone agreed on,
 *    rather than two agents creating `src/pipeline/gates.ts` and
 *    `src/pipeline/stages/gates.ts` in parallel branches — which is exactly what
 *    intent-sync surfaced as a real risk this cohort.
 *
 * A placeholder records a timeline entry naming the story that fills it, and does nothing
 * else. It never fails, so it never affects an outcome; and because its detail is
 * rendered and persisted, a run of today's pipeline says plainly which parts of
 * verification are not built yet instead of implying they passed.
 */

import type { StageName } from '../../domain/stage.js';
import type { Stage } from '../stage.js';
import { stageOk } from '../stage.js';

/**
 * @param name the frozen stage name this placeholder occupies
 * @param filledBy the story that replaces it, e.g. `story 3.4 (deterministic gates)`
 */
export function createPlaceholderStage(name: StageName, filledBy: string): Stage {
  return {
    name,
    run: async () => stageOk(`not implemented yet — ${filledBy}`),
  };
}
