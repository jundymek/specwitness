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
import type { DataStageDeps } from './data.js';
import { createGatesStage, createUnwiredGatesStage } from './gates.js';
import type { GatesStageDeps } from './gates.js';
import { createIntegrityStage } from './integrity.js';
import type { VerifiableContractGuard } from './integrity.js';
import { createPersistStage } from './persist.js';
import type { PersistDeps } from './persist.js';
import { createProbesStage } from './probes.js';
import { createResolveStage } from './resolve.js';
import { createServicesStage } from './services.js';
import type { ServicesStageDeps } from './services.js';
import { createSetupStage } from './setup.js';
import { createTeardownStage } from './teardown.js';
import type { TeardownDeps } from './teardown.js';
import { createWorktreeStage } from './worktree.js';
import type { WorktreeStageDeps } from './worktree.js';

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
  /**
   * The git/worktree seam (story 3.1): the `Vcs` port, the manifest recorder and the
   * repository resolved at the edge.
   *
   * Optional so that the many pipeline tests with nothing to isolate — and a future
   * dry-run mode — keep a real stage list rather than a special-cased one. When it is
   * absent the stage stays the placeholder and `worktreePath` remains `null`, which is
   * the honest "no isolation yet" this directory's placeholders are designed to report.
   * The CLI edge always binds it for a real `verify`.
   */
  readonly worktree?: WorktreeStageDeps;
  /**
   * The declared gates plus the runner and evidence writer they need (story 3.4).
   *
   * Optional only because the CLI edge that binds it arrives in story 3.7. A run
   * assembled without it executes no gates and SAYS SO in its timeline — it must
   * never read as a green build (see `createUnwiredGatesStage`).
   *
   * Note the interaction with `worktree` above: gates run in the worktree, so a run
   * that binds gates without binding the worktree seam raises an `InfraError` rather
   * than falling back to the source repo, which would verify the wrong tree.
   */
  readonly gates?: GatesStageDeps;
  /**
   * The declared services plus the runner, port probe and process-group registry
   * they need (story 4.1).
   *
   * Optional only because the CLI edge that binds it arrives in story 4.7. A run
   * assembled without it starts no services and SAYS SO in its timeline. That is
   * deliberately NOT the fail-closed refusal `gates` uses: an empty gate set
   * aggregates to PASS, so an unwired gates run would read as a green build,
   * whereas services adjudicate nothing and cannot manufacture a verdict on
   * their own. See the header of `services.ts`.
   *
   * Note the interaction with `worktree` above, which is the same one gates has:
   * services run in the worktree, so a run that binds services without binding
   * the worktree seam raises an `InfraError` rather than starting the operator's
   * application against the wrong tree.
   *
   * `registry` is REQUIRED inside this object on purpose — binding services
   * without a way to reap them is the one composition that must be
   * unrepresentable, because a leaked service is silent and makes the NEXT run
   * fail. The CLI edge must also drain that same registry from
   * `TeardownDeps.release` below, BEFORE removing the worktree.
   */
  readonly services?: ServicesStageDeps;
  /**
   * The declared `data.*` commands plus the runner and evidence writer they need (story 4.3).
   *
   * Optional only because the CLI edge that binds it arrives in story 4.7. A run assembled
   * without it runs no data commands and SAYS SO in its timeline — the same choice `services`
   * makes above, and deliberately NOT the fail-closed refusal `gates` uses: an empty gate set
   * aggregates to PASS, so an unwired gates run would read as a green build, whereas data
   * commands adjudicate nothing and cannot manufacture a verdict on their own.
   *
   * Note the interaction with `worktree`, which is the same one gates and services have, and
   * sharper: data commands run in the worktree, so a run that binds data without binding the
   * worktree seam raises an `InfraError` rather than falling back to the source repo. A
   * `data.reset` command plausibly drops a schema, so that fallback would not merely verify the
   * wrong tree — it would modify the operator's working directory.
   *
   * Unlike `gates`, `writeEvidence` is OPTIONAL inside this object: a data command's output
   * corroborates a step that produces no verdict, so without a writer the stage still records
   * bounded inline evidence and only the pointer to a full copy is lost.
   */
  readonly data?: DataStageDeps;
  /** Releases the worktree and the process group. Stories 3.1 and 3.2 bind it. */
  readonly teardown?: TeardownDeps;
  /**
   * Durably stores `result.json` (story 3.5). The CLI edge binds it to
   * `RunStore.writeResult`, and binds `RunPipelineInput.onComplete` to the same function
   * so the crash-durable snapshot and the finished document share one writer.
   *
   * Optional so a pipeline can be assembled without storage — but the stage then records
   * plainly that nothing was persisted, rather than reporting a clean `ok`.
   */
  readonly persist?: PersistDeps;
}

/** The eleven stages, in the frozen spine order. */
export function createStages(deps: StageDependencies): Stage[] {
  return [
    createResolveStage(),
    createIntegrityStage(deps.assertVerifiableContract),
    createWorktreeStage(deps.worktree),
    createSetupStage(),
    deps.gates === undefined ? createUnwiredGatesStage() : createGatesStage(deps.gates),
    createServicesStage(deps.services),
    createDataStage(deps.data),
    createProbesStage(),
    createAggregateStage(),
    createPersistStage(deps.persist ?? {}),
    createTeardownStage(deps.teardown ?? {}),
  ];
}
