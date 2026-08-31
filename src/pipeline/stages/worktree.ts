/**
 * The `worktree` stage — PLACEHOLDER.
 *
 * **Filled by story 3.1 (alice), this wave.** She owns `src/domain/vcs.ts`, the git
 * adapter in `src/infra/vcs.ts` and the detached-worktree lifecycle; her
 * `createWorktreeStage(deps)` replaces the body of this file. The path exists here so
 * that we do not both create it — settled in cohort intent-sync.
 *
 * When she fills it, the stage must set `context.run.environment.worktreePath` to the
 * created worktree, not merely hand it to the run manifest: story 3.4 reads it for the
 * gate spawn's cwd and story 3.6 prints it in the environment summary, and a renderer may
 * not look it up (AD-11).
 *
 * Until then a run creates no worktree and `worktreePath` stays `null` — a visible,
 * honest "no isolation yet" rather than a run that silently executed in the source repo.
 */

import type { Stage } from '../stage.js';
import { createPlaceholderStage } from './placeholder.js';

export function createWorktreeStage(): Stage {
  return createPlaceholderStage('worktree', 'story 3.1 creates the isolated worktree');
}
