/**
 * The one place the verify pipeline is assembled.
 *
 * `runPipeline` refuses a stage list that is not the eleven frozen names in order, so
 * this function is what every caller should build with — the CLI edge included. Hand
 * assembly would work right up until somebody omitted a stage, at which point the refusal
 * would fire at run time instead of never being possible.
 *
 * `StageDependencies` grows ADDITIVELY as later stories fill their placeholders: 3.1 adds
 * the `Vcs` seam, 3.4 the gate runner, 3.5 the run store. Every dependency is INJECTED —
 * no stage in this directory constructs an adapter, which is what keeps the whole
 * pipeline unit-testable with zero I/O.
 */

import type { Stage } from '../stage.js';
import { createAggregateStage } from './aggregate.js';
import { createDataStage } from './data.js';
import { createGatesStage } from './gates.js';
import { createIntegrityStage } from './integrity.js';
import type { VerifiableContractGuard } from './integrity.js';
import { createPersistStage } from './persist.js';
import { createProbesStage } from './probes.js';
import { createResolveStage } from './resolve.js';
import { createServicesStage } from './services.js';
import { createSetupStage } from './setup.js';
import { createTeardownStage } from './teardown.js';
import type { TeardownDeps } from './teardown.js';
import { createWorktreeStage } from './worktree.js';

export interface StageDependencies {
  /**
   * Returns the verified contract or throws (story 2.6's `assertVerifiableContract`,
   * bound by the CLI edge).
   *
   * Passed IN rather than imported: `src/pipeline/**` may not import `src/authoring/**`
   * (AD-1), and the spine's answer is that the caller loads and verifies, exactly as
   * config is loaded once, validated and passed down.
   */
  readonly assertVerifiableContract: VerifiableContractGuard;
  /** Releases the worktree and the process group. Stories 3.1 and 3.2 bind it. */
  readonly teardown?: TeardownDeps;
}

/** The eleven stages, in the frozen spine order. */
export function createStages(deps: StageDependencies): Stage[] {
  return [
    createResolveStage(),
    createIntegrityStage(deps.assertVerifiableContract),
    createWorktreeStage(),
    createSetupStage(),
    createGatesStage(),
    createServicesStage(),
    createDataStage(),
    createProbesStage(),
    createAggregateStage(),
    createPersistStage(),
    createTeardownStage(deps.teardown ?? {}),
  ];
}
