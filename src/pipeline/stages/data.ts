/**
 * The `data` stage — PLACEHOLDER.
 *
 * **Filled by Epic 4, story 4.3.** It applies the deterministic test data the plan
 * resolved at COMPILE time — fixed values plus a recorded seed, never values a model
 * invented per run (AD-9, FR-17). Fields that legitimately vary are declared `volatile`
 * in the plan and excluded from reproducibility comparison.
 */

import type { Stage } from '../stage.js';
import { createPlaceholderStage } from './placeholder.js';

export function createDataStage(): Stage {
  return createPlaceholderStage('data', 'Epic 4 story 4.3 applies deterministic test data');
}
