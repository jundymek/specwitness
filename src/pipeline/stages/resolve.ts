/**
 * The `resolve` stage — the PURE half of resolution.
 *
 * Everything that touches git is story 3.1's: ref resolution runs at the CLI edge through
 * the `Vcs` port, and this stage receives SHAs that are already resolved. It spawns no
 * `git`, not even to check that a ref exists. That split is what keeps the pipeline
 * unit-testable with zero subprocesses (AC3) — and it is why the first stage of a
 * verification run is one of the two that cannot fail for environmental reasons.
 *
 * What is left here is real, though: the canonical epic id. `7`, `07`, `epic-7` and
 * `EPIC-07` all name the same epic, and `domain/ids.ts` is the ONE implementation of that
 * normalisation. Running it here means every later stage, the run directory, the contract
 * lookup and the report all spell the epic the same way.
 */

import { InfraError } from '../../domain/errors.js';
import { normalizeEpicId } from '../../domain/ids.js';
import type { Stage } from '../stage.js';
import { stageOk } from '../stage.js';

/** Short SHA for a one-line timeline detail. Display only; the full SHA stays in the result. */
const short = (sha: string): string => sha.slice(0, 7);

export function createResolveStage(): Stage {
  return {
    name: 'resolve',
    run: async (context) => {
      // `normalizeEpicId` throws a UsageError on a malformed id. By this depth the CLI
      // edge has already normalised, so one thrown here is a PROGRAMMING error, not user
      // input — `runPipeline` lets it propagate rather than inventing a classification
      // for it, and teardown still runs first.
      context.run.epic = normalizeEpicId(context.run.epic);

      for (const [label, sha] of [
        ['base', context.run.baseSha],
        ['head', context.run.headSha],
      ] as const) {
        if (sha.trim() === '') {
          // Fail closed. An empty SHA would produce a worktree at an unknown revision and
          // a report that names one — a run whose evidence describes the wrong code is
          // worse than no run.
          throw new InfraError(
            `the ${label} revision reached the pipeline unresolved`,
            'resolve refs at the CLI edge through the Vcs port before building the stage list',
          );
        }
      }

      return stageOk(
        `${context.run.epic}: ${short(context.run.headSha)} against ${short(context.run.baseSha)}`,
      );
    },
  };
}
