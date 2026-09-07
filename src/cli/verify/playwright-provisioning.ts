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

import { InfraError } from '../../domain/errors.js';
import { redactText, type RedactionOptions } from '../../domain/evidence.js';
import type { Plan } from '../../domain/plan.js';
import type { ProcessRunner } from '../../domain/process-runner.js';
import type { ParentEnvironment } from '../../infra/process-runner.js';
import {
  provisionPlaywright,
  resolvePlaywrightEnvironment,
  type PlaywrightEnvironment,
  type PlaywrightEnvironmentInputs,
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
 *
 * `declaredServiceIds` NARROWS IT, and only when the caller passes one. A browser probe
 * names a declared service (`BrowserProbeMechanics.serviceId`) and there is deliberately no
 * `url` field, so a probe whose service the config no longer declares cannot execute
 * whatever this function answers: `resolveServiceBaseUrl` refuses it at dispatch. A
 * PERSISTED plan is never re-checked against the declared ids — `planDraftSchemaFor` applies
 * that check to a DRAFT during compilation only (`src/schemas/plan.ts`) — so this state is
 * reachable by editing `config.yaml` after a plan was compiled, and provisioning for it
 * would download hundreds of megabytes to then reject the plan. On an offline machine it is
 * worse than wasteful: the operator is shown a provisioning failure for what is really a
 * configuration error. Raised by the codex auto-review of this branch.
 *
 * OMITTING the list means "I am not telling you which services exist" and changes nothing.
 * Reading absence as "none exist" would silently stop every caller that does not pass it.
 */
export function planRequiresBrowser(
  plan: Plan | undefined,
  declaredServiceIds?: readonly string[],
): boolean {
  if (plan === undefined) {
    return false;
  }
  const declared = declaredServiceIds === undefined ? undefined : new Set(declaredServiceIds);
  return plan.plan.criteria.some(
    (criterion) =>
      criterion.disposition === 'automated' &&
      criterion.probes.some(
        (probe) =>
          probe.surface === 'browser' &&
          (declared === undefined || declared.has(probe.mechanics.serviceId)),
      ),
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
  /**
   * The service ids the project declares, when the caller knows them. See
   * `planRequiresBrowser`: a browser probe naming a service the config no longer declares
   * cannot run whatever this returns, so it is not worth a download.
   */
  readonly declaredServiceIds?: readonly string[];
  /**
   * AD-10's config-declared extra patterns, when the caller has them.
   *
   * The refusal this module carries quotes paths the operator chose, so it is redacted at
   * capture — and a project's OWN secret shapes are the half no built-in rule can know. The
   * browser executor takes the same options (`surfaces/browser.ts`), and the more durable
   * sink must not be the less protected one: the reason reaches the aggregate stage's
   * timeline detail, which is persisted inside `result.json`.
   *
   * NOTHING IN PRODUCTION SUPPLIES THIS YET, and that is not this story's to change: the
   * Project Config schema has no key for extra patterns and `verify.ts` binds `redaction`
   * nowhere, so the executor receives `undefined` too (`domain/evidence.ts:134-141`: *"Epic 3
   * wires none"*, still true three epics later). Threaded here so the wiring is correct by
   * construction the day that surface lands, rather than needing a second look then.
   */
  readonly redaction?: RedactionOptions;
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
 * ============================================================================
 * A FAILED PROVISIONING IS RETURNED, NOT THROWN — AND WHY THAT IS NOT A SKIP
 * ============================================================================
 *
 * An environment that could not be provisioned comes back `absent`, carrying the failure and
 * its hint as its `reason`. The refusal then happens where an unusable browser environment
 * has ALWAYS been refused: `BrowserSurfaceExecutor.#requireRuntime`, which throws `InfraError`
 * before any I/O and quotes this `reason` verbatim. Exit 3, classification `infra`, no
 * criterion adjudicated — identical to what the operator saw before `verify` provisioned
 * anything, and identical to what an `absent` resolution has always produced.
 *
 * THROWING HERE COST THE RUN ITS OWN RECORD. This function is called at the CLI edge, before
 * `runPipeline`, so an exception ends the command before the pipeline's persist stage and
 * `onComplete` ever run — no `result.json`, nothing on stdout under `--json`. On the one path
 * where `verify` may spend provider quota (no plan on disk, so one is compiled first) that
 * run had already printed *"its provider usage is recorded in the run document"*, and a
 * provisioning failure — a missing network, the likeliest failure on a fresh machine — made
 * that sentence false: quota spent, `providerUsage` recorded nowhere a harness can read.
 * FR-18's auditability is the whole reason that recording exists. Raised as a P1 by the codex
 * auto-review of this branch; the fix is to defer the refusal by one stage boundary, not to
 * add a second writer of run documents.
 *
 * ⚠️ **IT CANNOT BECOME A GREEN-FOR-NOTHING.** The rule from `playwright-env.ts`'s header
 * still holds in full: there is no `skipped`, no `pass`, and no silently absent probe on this
 * path. What makes that structural rather than hopeful is that this branch is only reached
 * when the plan HAS a browser probe — that is why provisioning was attempted — so a probe
 * that must refuse always exists, the probes stage dispatches every criterion, and the
 * executor's refusal aborts the run. `tests/unit/cli/verify-playwright-provisioning.test.ts`
 * and the corpus fixture `browser-probe-provisions` pin both halves.
 *
 * Only an `InfraError` is downgraded this way: any other exception is a defect in THIS
 * product and propagates untouched, rather than being buried inside a message about the
 * operator's machine.
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

  if (!planRequiresBrowser(inputs.plan, inputs.declaredServiceIds)) {
    // The merged behaviour, unchanged: read-only, offline, no spawn — so a run with no
    // browser probes costs what it always did.
    return await resolvePlaywrightEnvironment(environment);
  }

  // ⚠️ A RECORDING FAILURE IS NOT A PROVISIONING DIAGNOSIS, and it arrives as the same TYPE.
  // AD-8 wires `RunStore.recordProcessGroup` into every spawn, and `ProcessRunner`
  // deliberately kills the child and RETHROWS a failure from that hook unchanged rather than
  // flattening it into a subprocess outcome (`infra/process-runner.ts:719-723`). What comes
  // out is an `InfraError` about the run losing its ability to record a process group — the
  // thing `specwitness clean` needs to reap a killed download — and deferring THAT would let
  // the pipeline carry on and, behind a failing gate, exit 1 with a durability failure nobody
  // ever hears about. So it is remembered here and rethrown below: only a failure this module
  // asked for and can explain may be downgraded. Raised as a P2 by the codex review.
  //
  // ⚠️ AND IT NEED NOT REJECT TO HAVE FAILED. If the hook never SETTLES, `ProcessRunner` does
  // not throw at all: its per-command timeout fires, it terminates the group, and it returns a
  // `timed-out` result, which `provisionPlaywright` classifies as an ordinary `InfraError` —
  // indistinguishable from "the registry was unreachable". So a hook that started and has not
  // finished is tracked as well as one that threw, and both are fatal. Raised as a P2 by the
  // codex review, one notch finer than the rejected-hook case.
  let recordingFailure: unknown;
  let recordingInFlight = false;
  const onProcessGroup =
    inputs.onProcessGroup === undefined
      ? undefined
      : async (pgid: number): Promise<void> => {
          recordingInFlight = true;
          try {
            await inputs.onProcessGroup?.(pgid);
            recordingInFlight = false;
          } catch (failure) {
            recordingInFlight = false;
            recordingFailure = failure;
            throw failure;
          }
        };

  try {
    return await provisionPlaywright({
      ...environment,
      runner: inputs.runner,
      timeoutMs: inputs.timeoutMs ?? PROVISION_TIMEOUT_MS,
      ...(onProcessGroup === undefined ? {} : { onProcessGroup }),
    });
  } catch (failure) {
    if (recordingFailure !== undefined || recordingInFlight) {
      // The run's own bookkeeping failed, and this module is not entitled to translate that
      // into a statement about the operator's browser. `recordingFailure` when the hook threw
      // — the object the guard actually tested, which `ProcessRunner` rethrows unchanged —
      // and `failure` when it merely hung, because then the only error that exists is the
      // timeout `provisionPlaywright` raised.
      throw recordingFailure ?? failure;
    }
    if (!(failure instanceof InfraError)) {
      throw failure;
    }
    return await unusableAfterProvisioning(environment, failure, inputs.redaction);
  }
}

/**
 * The environment a run refuses on after provisioning could not produce one.
 *
 * `absent` is FORCED rather than re-read, and that is the fail-closed direction. Re-resolution
 * could report a usable environment — a concurrent run finishing the install a moment later,
 * or a package that landed while the browser download failed — and returning "ready" after
 * this product could not establish the environment would run browser probes against something
 * nobody verified. The paths come from resolution because they are the ones every message
 * about this cache already names.
 *
 * BOTH HALVES OF THE FAILURE TRAVEL. `reason` carries the message AND the hint, because the
 * executor's own refusal appends advice about `doctor` and has no way to reproduce "check
 * connectivity, proxy and registry settings" or "PLAYWRIGHT_BROWSERS_PATH points inside the
 * project" — which is the only actionable half of most of these failures.
 *
 * ⚠️ AND IT IS REDACTED HERE, AT CAPTURE, NOT AT EACH SINK. These messages quote paths the
 * operator chose — `PLAYWRIGHT_BROWSERS_PATH` and `XDG_CACHE_HOME` are untrusted input and
 * can carry credential-shaped material. `BrowserSurfaceExecutor` redacts before building its
 * refusal, but story 7.0 added two sinks that bypass it: the aggregate stage's timeline
 * detail, which is PERSISTED inside `result.json`, and the edge's `WARNING:`. Redacting once,
 * where the text enters this product's own data, covers every sink that exists now and every
 * one added later; `redactText` is idempotent, so the executor redacting again costs nothing.
 * Raised as a P1 by the codex auto-review of this branch.
 */
async function unusableAfterProvisioning(
  environment: PlaywrightEnvironmentInputs,
  failure: InfraError,
  redaction: RedactionOptions | undefined,
): Promise<PlaywrightEnvironment> {
  const paths = await resolvePlaywrightEnvironment(environment);
  return {
    source: 'absent',
    version: null,
    browsersPresent: false,
    ready: false,
    cacheDir: paths.cacheDir,
    browsersPath: paths.browsersPath,
    browsersPathFromEnv: paths.browsersPathFromEnv,
    reason: redactText(
      failure.hint === undefined || failure.hint === ''
        ? failure.message
        : `${failure.message} — ${failure.hint}`,
      redaction,
    ),
  };
}

/**
 * Must the edge SAY OUT LOUD that this run could not get the browser its plan required?
 *
 * Yes, unless the failure the run already reported is the browser refusal itself, which quotes
 * this same reason verbatim — repeating it there would be noise on the one path that is already
 * loud.
 *
 * ⚠️ IT IS NOT "did the run reach a verdict", WHICH IS WHAT THIS FIRST ASKED. Provisioning can
 * fail and then a stage BEFORE `probes` can throw — the worktree, `setup.install`, a service
 * that never becomes ready. `runPipeline` then skips both `probes` and `aggregate`, so the
 * timeline detail that carries this diagnosis never happens either, and a warning gated on a
 * verdict is suppressed as well: the provisioning failure disappears from BOTH channels, on a
 * run that had already discovered it. Raised as a P2 by the codex review of this branch.
 *
 * So the question is about the REPORTED TEXT rather than the outcome shape, and it fails open:
 * when in doubt the operator hears it twice, which is the harmless direction.
 *
 * @param reason        why the browser environment could not be established, when it could not
 * @param reportedFailure the detail `reportInfraFailure` is about to print, if any
 */
export function shouldReportUnavailableBrowser(
  reason: string | undefined,
  reportedFailure: string | undefined,
): reason is string {
  if (reason === undefined) {
    return false;
  }
  return reportedFailure === undefined || !reportedFailure.includes(reason);
}

/**
 * What the edge SAYS when this run could not get the browser its plan required.
 *
 * ⚠️ THE LAST SENTENCE DEPENDS ON WHETHER THERE IS A VERDICT AT ALL, and getting that wrong
 * was a review finding rather than a nicety. On the gate-failure path the run really did
 * conclude — the branch does not build, whatever the browser could have shown — and saying so
 * is what stops this warning reading like a retraction of the verdict printed above it. But
 * the same warning is now reached when ANOTHER infrastructure stage ended the run, where the
 * report reads `VERDICT: (none) — infra error`; claiming "the verdict above" there contradicts
 * the line next to it and implies the gates and criteria concluded something they did not.
 *
 * @param reason  why the browser environment could not be established
 * @param verdict the run's verdict, or `undefined` when it reached none
 */
export function unavailableBrowserWarning(reason: string, verdict: string | undefined): string {
  const preamble =
    'this run could not provision the browser its plan requires, so every criterion only a ' +
    `browser can adjudicate went unchecked: ${reason}`;

  return verdict === undefined
    ? `${preamble}. This run reached no conclusion about the branch for another reason, ` +
        'reported above'
    : `${preamble}. The verdict above is what the gates and the remaining criteria decided, ` +
        'and is unaffected';
}
