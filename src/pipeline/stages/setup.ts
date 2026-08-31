/**
 * The `setup` stage — PLACEHOLDER.
 *
 * **Filled by Epic 4.** It runs the Project Config's `setup.install` command inside the
 * worktree, so that gates and probes execute against installed dependencies.
 *
 * Not story 3.4's, despite sitting next to the gates stage: the config carries
 * `setup.install` and this stage is named for it, but it is outside 3.4's acceptance
 * criteria and nobody has been assigned it. Left empty deliberately rather than absorbed
 * into the gates stage, where installation would become an undeclared side effect of gate
 * execution and a failed install would be reported as a failing gate.
 */

import type { Stage } from '../stage.js';
import { createPlaceholderStage } from './placeholder.js';

export function createSetupStage(): Stage {
  return createPlaceholderStage('setup', 'Epic 4 runs the configured install command');
}
