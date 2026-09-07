/**
 * Story 7.0 — the decision `verify` makes about Playwright, and the call site D-5 was missing.
 *
 * ============================================================================
 * THE DEFECT THIS FILE EXISTS TO CLOSE
 * ============================================================================
 *
 * `provisionPlaywright` was written in story 5.1, unit-tested, and **called from nowhere in
 * `src/`** for the whole of Epics 5 and 6 (`docs/findings/dogfooding-defects-2026-09-05.md`,
 * D-5). `verify` resolved the environment, found `absent`, and the browser executor refused —
 * so a browser probe on any project that does not resolve `@playwright/test` from its own
 * root could only ever exit 3, while `doctor` promised provisioning "on the first browser
 * probe" and the refusal pointed the operator at `doctor`, which by AD-12 never downloads.
 * The first real dogfooding run met exactly that, and stopped with five criteria unadjudicated.
 *
 * It is the same shape story 6.11 closed for `setup.install`: a capability the config surface
 * advertises, the diagnostics validate, and the pipeline never invokes. Both survived because
 * the only tests that exercised the capability CALLED IT THEMSELVES.
 *
 * ============================================================================
 * EAGER, AND CONDITIONAL ON THE PLAN — WHICH IS THE WHOLE DESIGN
 * ============================================================================
 *
 * The question "does this run need a browser?" is answered from the COMPILED PLAN, before the
 * pipeline starts:
 *
 *   plan carries a `surface: 'browser'` probe  →  `provisionPlaywright` (may spawn, may download)
 *   anything else                              →  `resolvePlaywrightEnvironment` (read-only, offline)
 *
 * The second arm is the one to protect. Provisioning unconditionally would make **every**
 * gates-only run pay for a browser it never opens — hundreds of megabytes and minutes, on a
 * run whose plan has no browser in it. That is the failure this file is shaped against, and
 * `tests/unit/cli/verify-playwright-provisioning.test.ts` asserts zero spawns for it.
 *
 * WHY NOT LAZILY, FROM THE EXECUTOR, which is what D-5's own "suggested fix" proposes and
 * what `doctor`'s old wording described. Three reasons, in order of weight:
 *
 *   1. `src/surfaces/**` may not import `src/infra/**` (`adapters-core-only`), so the
 *      executor cannot provision; it would take a thunk threaded through the dispatcher.
 *   2. That thunk would have to be memoised against the retry policy, or a flaky browser
 *      criterion could start the same install several times.
 *   3. It would begin a multi-minute download AFTER the worktree exists and the declared
 *      services are live — holding a process group and a checked-out tree open for the
 *      duration, and failing late what can be failed early.
 *
 * Resolving eagerly was already the merged design (`verify.ts`, story 5.1: "read-only,
 * offline, no spawn"). This file keeps that shape and adds the one branch that was missing.
 *
 * ============================================================================
 * WHAT THIS FILE MAY NOT BECOME
 * ============================================================================
 *
 * **There is no skip path here and there must never be one.** An unavailable browser
 * environment is `InfraError` (exit 3) — the run could not proceed — never `skipped`, never
 * `pass`, never a silently absent probe. Epic 4 retro §2 observation 2 recorded twice that a
 * criterion nobody could adjudicate reported PASS; "provisioning failed, so we carried on
 * without a browser" would be the third. Every failure below is `provisionPlaywright`'s own
 * `InfraError`, propagated unchanged: that module computed why the environment is unusable
 * and its words name the path it rejected.
 *
 * AD-3: provisioning spawns `npm` and Playwright's `cli.js` as SpecWitness's OWN hard-coded
 * argv invocations through `ProcessRunner`. Nothing here mints a `DeclaredCommand`, because
 * that brand constrains project-declared SHELL STRINGS and there is no shell here. The plan
 * is READ for one discriminant and never for a command.
 */

import type { Plan } from '../../domain/plan.js';
import type { ProcessRunner } from '../../domain/process-runner.js';
import type { ParentEnvironment } from '../../infra/process-runner.js';
import {
  provisionPlaywright,
  resolvePlaywrightEnvironment,
  type PlaywrightEnvironment,
} from '../../infra/playwright-env.js';

/**
 * The PER-COMMAND budget for a provisioning spawn.
 *
 * Ten minutes, the same value `tests/provisioning/playwright.provision.ts` uses against the
 * real registry and the real browser CDN: a cold `npm install` plus a cold chromium fetch on
 * a slow runner, with termination still guaranteed. A budget tight enough to expire on a
 * working download would report an `InfraError` for a machine that was doing exactly what it
 * was asked to.
 */
export const PROVISION_TIMEOUT_MS = 10 * 60_000;

/**
 * Does this run need a browser at all?
 *
 * Answered from the plan, which is the only artifact that knows. A `needs-human` criterion
 * has no `probes` key at all (see `PlanCriterion`), so the discrimination below is total
 * rather than a filter someone has to remember.
 */
export function planRequiresBrowser(plan: Plan | undefined): boolean {
  if (plan === undefined) {
    return false;
  }
  return plan.plan.criteria.some(
    (criterion) =>
      criterion.disposition === 'automated' &&
      criterion.probes.some((probe) => probe.surface === 'browser'),
  );
}

export interface BrowserEnvironmentInputs {
  readonly projectRoot: string;
  /** The compiled plan, or `undefined` when the run has none (`--no-ai`, nothing compiled). */
  readonly plan: Plan | undefined;
  /** AD-8: every spawn goes through the merged runner. No `execa` here. */
  readonly runner: ProcessRunner;
  /**
   * AD-8. `RunStore.recordProcessGroup` is the intended production value: a browser download
   * is minutes long and is therefore the likeliest moment for an operator to `kill -9` a run,
   * and a process group nobody wrote down is a process group `specwitness clean` cannot reap.
   */
  readonly onProcessGroup?: (pgid: number) => void | Promise<void>;
  /** Overridable for tests. Defaults to `PROVISION_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** Defaults to `process.env`, as `playwright-env.ts` does. Injected so a test is not at its mercy. */
  readonly env?: ParentEnvironment;
  /** Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Defaults to `os.homedir()`. */
  readonly homeDir?: string;
}

/**
 * Which Playwright this run's browser probes will drive — provisioning one when the plan
 * needs a browser and the machine has none.
 *
 * THROWS `InfraError` (exit 3) when a needed environment cannot be provisioned, and returns
 * a possibly-`absent` environment when the plan needs no browser at all. Those two are not
 * inconsistent: an `absent` answer only ever reaches an executor that will refuse it, and a
 * run with no browser probe has no executor to reach.
 */
export async function resolveBrowserEnvironment(
  inputs: BrowserEnvironmentInputs,
): Promise<PlaywrightEnvironment> {
  // Spread rather than assigned, so an absent optional stays ABSENT rather than becoming an
  // explicit `undefined` (`exactOptionalPropertyTypes`) — and so the resolve-only arm below
  // is handed the identical inputs the provisioning arm would have been.
  const environment = {
    projectRoot: inputs.projectRoot,
    ...(inputs.env === undefined ? {} : { env: inputs.env }),
    ...(inputs.platform === undefined ? {} : { platform: inputs.platform }),
    ...(inputs.homeDir === undefined ? {} : { homeDir: inputs.homeDir }),
  };

  if (!planRequiresBrowser(inputs.plan)) {
    // The merged behaviour, unchanged: read-only, offline, no spawn — so a run with no
    // browser probes costs what it always did.
    return await resolvePlaywrightEnvironment(environment);
  }

  return await provisionPlaywright({
    ...environment,
    runner: inputs.runner,
    timeoutMs: inputs.timeoutMs ?? PROVISION_TIMEOUT_MS,
    ...(inputs.onProcessGroup === undefined ? {} : { onProcessGroup: inputs.onProcessGroup }),
  });
}
