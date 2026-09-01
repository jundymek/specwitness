/**
 * The `worktree` stage — story 3.1.
 *
 * Creates the detached worktree the rest of the run executes in, records its path in the
 * run manifest first, and publishes it on the accumulator. That is all it does: the git
 * behaviour lives behind the `Vcs` port (`src/domain/vcs.ts`, implemented by
 * `src/infra/vcs.ts`), and this stage constructs no adapter — the CLI edge injects both.
 *
 * WHY THE ORDER IS RECORD-THEN-CREATE (AD-8). The manifest is a crash-recovery record: a
 * run killed with -9 must leave behind a readable list of what needs reaping. A worktree
 * registered before its path was persisted is one `specwitness clean` (story 3.2) has no
 * way to discover, so it leaks permanently. The ordering is not a convention this file
 * remembers — `Vcs.addWorktree` REQUIRES the recording callback and awaits it before any
 * git write, so a worktree cannot come into existence unrecorded.
 *
 * WHY THIS STAGE THROWS RATHER THAN RETURNING product-negative. A worktree that cannot be
 * created says nothing about whether the branch under verification is any good — it says
 * the environment is broken. Returning the negative arm would send that to the exit table
 * as 1 ("this branch has defects") instead of 3 ("SpecWitness could not reach a
 * conclusion"), which is the misclassification this project treats as a first-order
 * defect. The two-armed `StageResult` has no infrastructure arm precisely so that this is
 * unrepresentable rather than merely discouraged.
 *
 * `environment.worktreePath` is set here and not merely handed to the manifest: story 3.4
 * reads it as the cwd for every gate spawn and story 3.6 prints it in the environment
 * summary, and a renderer may never look a fact up for itself (AD-11). Leaving it `null`
 * would break both of those quietly.
 *
 * Teardown is deliberately NOT here. `createTeardownStage`'s injected `release` callback
 * is where the worktree is removed, bound by the CLI edge to `Vcs.removeWorktree` — so
 * that removal still happens after an early stop, after a thrown error, and after a
 * failure in teardown itself, which is a guarantee the state machine owns rather than
 * this file.
 */

import { InfraError } from '../../domain/errors.js';
import type { RepoRoot, Vcs, WorktreeRecorder } from '../../domain/vcs.js';
import type { Stage, StageContext } from '../stage.js';
import { stageOk } from '../stage.js';
import { createPlaceholderStage } from './placeholder.js';

export interface WorktreeStageDeps {
  /** The git seam. Injected — this stage never builds an adapter. */
  readonly vcs: Vcs;
  /**
   * Persists the worktree path into the run manifest.
   *
   * Story 3.2's `RunStore.recordWorktree` satisfies this structurally; `RunStore` remains
   * the sole writer under `.specwitness/runs/` (AD-8) and this stage never constructs a
   * path there.
   */
  readonly recorder: WorktreeRecorder;
  /** The repository, resolved at the CLI edge before the pipeline starts. */
  readonly root: RepoRoot;
}

/**
 * @param deps the git seam, or `undefined` for a pipeline with no isolation configured.
 *
 * Optional because most of `runPipeline`'s own tests — and any future dry-run mode — have
 * nothing to isolate, and forcing them to fabricate a `Vcs` would make the stage list
 * special-cased rather than real. When it is absent this stays the placeholder that story
 * 3.3 shipped: it records "no isolation configured" in the timeline and leaves
 * `worktreePath` as `null`, so a run says plainly that it created no worktree instead of
 * implying it verified in one. The CLI edge always binds it for a real `verify`.
 */
export function createWorktreeStage(deps?: WorktreeStageDeps): Stage {
  if (deps === undefined) {
    // The wording keeps "story 3.1" in the detail deliberately: story 3.3's
    // stages test asserts every placeholder names the story that owns it, so a
    // report can never imply a stage passed when it did not run. That property
    // still holds now the stage is implemented — this arm means the seam was
    // not bound, and 3.1 is still who owns it.
    return createPlaceholderStage(
      'worktree',
      'story 3.1 owns this stage; no Vcs seam was bound, so this run created no worktree',
    );
  }

  return {
    name: 'worktree',
    run: async (context: StageContext) => {
      const headSha = context.run.headSha;
      if (headSha === '') {
        // The resolve stage owns turning refs into shas, and `Vcs.resolveRef` runs at
        // the edge. Reaching here with nothing means one of those did not happen —
        // worth naming, because `git worktree add` at an empty revision fails
        // obscurely and the real problem is two stages upstream.
        throw new InfraError(
          'cannot create a worktree: the head revision was never resolved',
          'this is a pipeline wiring error — the resolve stage must set headSha before the worktree stage runs',
        );
      }

      const created = await deps.vcs.addWorktree(deps.root, headSha, (worktreePath) =>
        deps.recorder.recordWorktree(context.runId, worktreePath),
      );

      // Replaced rather than mutated in place: `RunEnvironment` is a readonly shape, and
      // rebuilding it keeps every field explicit at the one point that changes it.
      context.run.environment = { ...context.run.environment, worktreePath: created.path };

      return stageOk(`detached worktree at ${created.sha.slice(0, 7)}`);
    },
  };
}
