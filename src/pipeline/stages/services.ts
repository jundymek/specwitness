/**
 * The `services` stage — PLACEHOLDER.
 *
 * **Filled by Epic 4, story 4.1.** It starts the config-declared services in the worktree
 * and waits for each one's declared readiness signal.
 *
 * The classification it inherits from this epic: a readiness timeout ends the run as an
 * InfraError (exit 3) with the captured service output as evidence (Q29) — never as a
 * product FAIL. A service that would not start says nothing about whether the branch
 * satisfies its contract.
 */

import type { Stage } from '../stage.js';
import { createPlaceholderStage } from './placeholder.js';

export function createServicesStage(): Stage {
  return createPlaceholderStage(
    'services',
    'Epic 4 story 4.1 starts services and awaits readiness',
  );
}
