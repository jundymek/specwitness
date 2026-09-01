/**
 * The `teardown` stage — the always-runs guarantee.
 *
 * The guarantee itself lives in `run-pipeline.ts`, which calls this stage after any early
 * stop, after any thrown error, and after an error thrown by teardown itself, and which
 * refuses to let a teardown failure replace an outcome that was already decided. That is
 * AC1's promise and it belongs in the state machine, not in a stage anybody could swap
 * out.
 *
 * What lives HERE is only the seam: an injected `release` callback that stories 3.1 and
 * 3.2 bind to the resources they own — removing the detached worktree, killing the
 * process group, closing the run manifest. This stage constructs no adapter and knows
 * nothing about worktrees or processes; it is the point at which the pipeline says
 * "whatever you allocated, release it now".
 *
 * A `release` that throws is left to throw. `run-pipeline.ts` records it as
 * `{stage: 'teardown', status: 'error', detail}`, classifies it, and keeps the outcome:
 * a run that FAILed on a gate and then leaked a worktree is still a FAIL, and a PASS that
 * leaked one is still a PASS with a recorded problem that `specwitness clean` resolves.
 * Swallowing the error here would hide the leak; letting it change the verdict would make
 * a broken branch look retryable.
 */

import type { Stage, StageContext } from '../stage.js';
import { stageOk } from '../stage.js';

export interface TeardownDeps {
  /**
   * Releases everything the run allocated. Bound by the CLI edge to story 3.1's worktree
   * removal and story 3.2's process-group teardown.
   *
   * Optional so that a gates-only run with nothing to release — and every unit test — has
   * a real teardown stage rather than a stub that proves nothing.
   */
  readonly release?: (context: StageContext) => Promise<void>;
}

export function createTeardownStage(deps: TeardownDeps = {}): Stage {
  return {
    name: 'teardown',
    run: async (context) => {
      if (deps.release === undefined) {
        return stageOk('nothing to release');
      }

      await deps.release(context);
      return stageOk('released');
    },
  };
}
