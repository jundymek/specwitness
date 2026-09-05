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
import type { ProbesStageDeps } from './probes.js';
import { createResolveStage } from './resolve.js';
import { createServicesStage } from './services.js';
import type { ServicesStageDeps } from './services.js';
import { createSetupStage } from './setup.js';
import type { SetupStageDeps } from './setup.js';
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
   * The project's `setup.install` command plus the runner it needs (story 6.11).
   *
   * Optional, and the asymmetry with `gates` is the one `services` and `data` already have: an
   * unwired setup stage installs nothing and SAYS SO in its timeline, and because it produces no
   * `GateResult` and no criterion it cannot manufacture a verdict on its own, whereas an empty
   * gate set aggregates to PASS and an unwired gates run would read as a green build.
   *
   * `install` is optional INSIDE this object rather than being expressed by omitting the object,
   * because "the runner is wired and this project declared no install" and "nothing was wired at
   * all" are different states and the timeline must be able to say which one a run was in.
   *
   * Note the interaction with `worktree` above, which is the same one gates, services and data
   * have and is at its sharpest here: the install runs in the worktree, so a run that binds setup
   * without binding the worktree seam raises an `InfraError` rather than falling back to the
   * project root. `pnpm install` in the operator's own directory would not merely verify the
   * wrong tree — it would rewrite that tree's dependencies (AD-8, FR-19).
   *
   * ⚠️ **The CLI edge must bind this whenever it binds gates.** Until story 6.11 there was no key
   * to bind and `verify` never executed `setup.install` at all, while `doctor` validated it and
   * reported it resolvable — so gates ran against an uninstalled worktree and a missing install
   * surfaced as a product FAIL. That is the defect this key closes.
   */
  readonly setup?: SetupStageDeps;
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
  /**
   * The compiled plan's criteria plus the means to execute one probe (story 4.7).
   *
   * Optional, and the asymmetry with `gates` is the same one `services` and `data` have,
   * for the same reason: an unwired probes stage executes nothing and SAYS SO in its
   * timeline, leaving every criterion `skipped`, which cannot manufacture a verdict.
   *
   * The green-for-nothing case — a project with neither gates nor probes, whose run would
   * aggregate to PASS having observed nothing — is refused at the CLI EDGE before the run
   * starts (`assertSomethingToAdjudicate`), not here. Refusing here would persist a
   * `result.json` beside a CLI exiting 3, and whoever opens that run directory later has
   * no exit code to compare it against.
   *
   * `dispatch` carries every resolution the pipeline may not perform itself: AD-1 keeps
   * `src/pipeline/**` out of `src/authoring/**`, and `adapters-core-only` keeps
   * `src/surfaces/**` out of both `src/config/**` and `src/pipeline/**`, so the edge is
   * the only place that can turn a plan's `serviceId` or `commandId` into something
   * runnable.
   */
  readonly probes?: ProbesStageDeps;
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
    createSetupStage(deps.setup),
    deps.gates === undefined ? createUnwiredGatesStage() : createGatesStage(deps.gates),
    createServicesStage(deps.services),
    createDataStage(deps.data),
    createProbesStage(deps.probes),
    // Handed the SAME plan the probes stage receives, so a criterion this stage has to
    // materialise carries the reviewer guidance the probes stage would have given it.
    // ADR-003 makes that necessary rather than tidy: a gate failure skips `probes`
    // entirely, and without this a human criterion in a gate-failed run reaches its
    // reviewer with no guidance at all (story 5.3).
    createAggregateStage({
      criteria: deps.probes?.criteria,
      redaction: deps.probes?.redaction,
    }),
    createPersistStage(deps.persist ?? {}),
    createTeardownStage(deps.teardown ?? {}),
  ];
}
