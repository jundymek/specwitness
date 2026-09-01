/**
 * The `services` stage — start the project's application, prove it is healthy,
 * and guarantee nothing survives the run (FR-21, Q23–Q29).
 *
 * ============================================================================
 * THIS IS THE FIRST MODULE IN THE PRODUCT THAT RUNS THE TARGET PROJECT'S
 * APPLICATION, rather than its build.
 * ============================================================================
 *
 * Everything before this stage ran commands that start, do a thing and exit —
 * `pnpm lint`, `pnpm build`. A service is the opposite: it starts and STAYS
 * running while other code talks to it. That inversion is the whole reason this
 * file is shaped the way it is, and it changes two things structurally.
 *
 * FIRST: `ProcessRunner.run()` RESOLVES ONLY WHEN THE CHILD EXITS. A healthy
 * service never exits, so awaiting `run()` the way `gates.ts` does would hang
 * the HAPPY path until the timeout and then report a "readiness failure" for a
 * service that was healthy the entire time. So the promise is HELD, never
 * awaited to drive the timeline: readiness polling drives it, and the settled
 * promise is read only on the failure path, where the process has exited or
 * been killed. Two consequences worth stating because they are not obvious:
 *
 *   - The port is NOT widened. Its OWNERSHIP block says "EXACTLY ONE METHOD,
 *     still", and 3.2 deliberately exported `terminateProcessGroup` as a free
 *     function rather than adding a second required method, because a required
 *     method breaks every `ProcessRunner` fake under `tests/`. This story needed
 *     nothing more: `tests/integration/process-runner-groups.test.ts` already
 *     proves the exact shape used here — its "kills the grandchild of an
 *     explicitly torn-down long-running child" case is labelled "the Epic 4
 *     shape" and asserts `run` still settles and never rejects when its group is
 *     torn down underneath it. Nothing in `src/domain/process-runner.ts` or
 *     `src/infra/process-runner.ts` was changed by this story.
 *   - A service that EXITS before becoming ready is diagnosed IMMEDIATELY rather
 *     than at the deadline. That is the case an operator hits most (a port
 *     clash, a missing migration, a bad env var), and burning the full
 *     `timeoutSec` before saying so reports the wrong cause slowly.
 *
 * SECOND: teardown is not optional bookkeeping here, it is the product. A leaked
 * service is silent, cumulative, and makes the NEXT run fail on an occupied
 * port — so the symptom appears one run away from its cause. Epic 2 leaked nine
 * `sleep 3600` processes this way. Every spawn therefore publishes its process
 * group through `onProcessGroup`, which the runner AWAITS before the run
 * proceeds, so the pgid is fsynced into the run manifest before this stage waits
 * for readiness. `specwitness clean` replays that manifest after a `kill -9`.
 *
 * ============================================================================
 * THE CLASSIFICATION TABLE — the spine of this story
 * ============================================================================
 *
 *   every service ready before its deadline  -> stageOk
 *   readiness deadline elapsed               -> InfraError THROWN (exit 3)
 *   service exited before becoming ready     -> InfraError THROWN (exit 3)
 *   declared port already occupied           -> InfraError THROWN (exit 3)
 *   readiness probe binary not found         -> InfraError THROWN (exit 3)
 *   no worktree, but services declared       -> InfraError THROWN (exit 3)
 *
 * There is no product-negative row, and its absence is the point. **A service
 * that would not start says NOTHING about whether the branch satisfies its
 * contract.** Exit 1 asserts "this branch has defects" and routes a developer at
 * a bug that may not exist, or blocks a mergeable branch. Exit 3 says
 * "SpecWitness could not reach a conclusion", which is what actually happened.
 * This stage therefore never returns `stageProductNegative`, never pushes a
 * `GateResult`, and never writes `context.run.outcome` — the aggregate stage is
 * AD-6's only converter.
 *
 * ============================================================================
 * DECISIONS THIS FILE OWNS, stated here so nobody re-litigates them from prose
 * ============================================================================
 *
 * **STARTUP ORDER RELIES ON OBJECT INSERTION ORDER, AND IS PINNED BY A TEST.**
 * `config.services` is `z.record(nonEmptyString, serviceSchema)` — a MAP, not an
 * array. `gates` is `z.array(...)` and is therefore ordered by construction;
 * services are not. In practice `yaml` + zod preserve JS object insertion order
 * for string keys, so `Object.keys(config.services)` does yield declaration
 * order — but that is an emergent property of two libraries, not a guarantee the
 * schema makes. Rather than change a schema this story does not own (that is
 * story 1.3's file), the reliance is made explicit here and pinned by a test
 * that loads a REAL multi-service YAML through `loadConfig` and asserts the
 * observed start order equals the file order. A bare `Object.keys` with no such
 * test would be unacceptable: the day it silently reorders, services start in
 * the wrong order and the failure looks like a flaky application.
 *
 * **AN UNWIRED SERVICES STAGE IS A NO-OP, NOT A REFUSAL — and it is deliberately
 * NOT `createUnwiredGatesStage`'s reasoning.** That stage must throw because
 * `aggregate()` over an empty gate set returns PASS, so an unwired gates run
 * produced a green verdict for a branch on which nothing was checked. Services
 * adjudicate nothing: no verdict is derived from them, so an unwired services
 * stage cannot manufacture a false green on its own. It says plainly in its
 * timeline detail that nothing was started. (The CLI edge binds this in story
 * 4.7; until then `verify` must keep working, and a throw here would break every
 * run on `master` for a stage nobody has wired yet.) A WIRED stage with services
 * declared is where the fail-closed behaviour lives, and it is total: every
 * declared service either becomes ready or the run ends inconclusive.
 *
 * **REDACTION IS FAIL-CLOSED, AND THIS IS A SECURITY CLAUSE.** Service stdout and
 * stderr are CAPTURE OUTPUT — untrusted text the service emitted — and are
 * redacted UNDECLARED, i.e. without `{shellCommand: true}`, which is
 * `redactText`'s fail-closed default. That option is reserved for DECLARED
 * commands, text the project owner wrote. Shell context is declared by the
 * caller and never inferred from the text, because an apostrophe in prose is
 * indistinguishable from a shell delimiter (Epic 3 retro §2 observation 7, §6).
 * Where captured output enters an error MESSAGE it is redacted here, at the
 * point it enters, because an error travels further than evidence does: the same
 * error reaches `printError` at the CLI edge, which writes it to stderr
 * verbatim — so the persisted copy would be clean while the terminal showed the
 * secret. `gates.ts` closes the identical hole in its `spawn-failed` arm.
 *
 * ============================================================================
 * AD-3 — THE COMMAND BOUNDARY
 * ============================================================================
 *
 * Service commands and readiness commands are `DeclaredCommand`s, minted only
 * inside `src/config/` while validating the project's own config file. Nothing
 * here mints one, casts to one, or imports the brand; the only operation
 * performed is `commandText()`, the sanctioned READ direction. They reach
 * `ProcessRunner` as a binary plus an argument array — there is no shell on this
 * path — so `&&`, `$(…)` and `;` arrive at the child as literal argv elements.
 * The split and its malformed-form refusals are story 3.4's `gate-command.ts`,
 * imported rather than reimplemented: a second splitter would eventually
 * disagree with doctor about which token is the executable.
 *
 * AD-1: this stage constructs NO adapter. The runner, the port probe, the HTTP
 * readiness probe and the process-group registry all arrive by injection, which
 * is what keeps the whole file unit-testable with zero I/O.
 *
 * AD-9: durations and deadlines come from the injected `Clock`. There is no
 * `Date.now()` and no `new Date()` anywhere below.
 */

import {
  commandText,
  type DeclaredCommand,
  type ServiceConfig,
  type SpecwitnessConfig,
} from '../../config/index.js';
import { ConfigError, InfraError } from '../../domain/errors.js';
import { commandEvidence, redactText } from '../../domain/evidence.js';
import type { ProcessResult, ProcessRunner } from '../../domain/process-runner.js';
import type { Stage, StageContext, StageResult } from '../stage.js';
import { stageOk } from '../stage.js';

import {
  hasGluedExecutableSuffix,
  hasUnterminatedQuote,
  splitCommandLine,
  usesUnsupportedEscaping,
} from './gate-command.js';

/**
 * Milliseconds between readiness polls.
 *
 * 250ms, chosen rather than guessed: a local service usually answers within a
 * second or two, so a poll interval an order of magnitude below that makes the
 * common case feel immediate, while being long enough that polling a booting
 * process costs nothing measurable. The same shape as `GATE_TIMEOUT_MS` in the
 * gates stage — a module constant with a stated value, injectable through
 * `ServicesStageDeps` so a test can assert the timeout path in milliseconds
 * rather than waiting out a `timeoutSec: 60`.
 */
export const READINESS_POLL_INTERVAL_MS = 250;

/**
 * The upper bound handed to `ProcessRunner.run()` for a SERVICE spawn.
 *
 * Not a readiness deadline — readiness has its own, per service, from
 * `ready.timeoutSec`. This is the runner's required `timeoutMs`, which exists so
 * that an unbounded spawn is not expressible by the port at all. For a service
 * it is a BACKSTOP: if teardown never runs (a crash between here and the
 * teardown stage), the runner eventually kills the group itself rather than
 * leaving a process behind forever. One hour, because it must comfortably exceed
 * any plausible verification run — a backstop that fired mid-run would kill a
 * healthy service and make every probe after it fail for a reason nothing in the
 * report would explain.
 */
export const SERVICE_LIFETIME_MS = 60 * 60 * 1000;

/**
 * How long the readiness-failure path waits for a torn-down service's `run()`
 * promise to settle before giving up on its captured output.
 *
 * A HANG GUARD, and deliberately NOT routed through the injected `sleep`. Every
 * other wait here is injectable so tests never spend real time; this one must
 * not be, because a test's instant `sleep` would disable exactly the protection
 * it exists to provide. `registry.release` resolving means the group is GONE and
 * the child's promise therefore settles promptly, so in every healthy case this
 * timer is never reached — it is here for the one case where that assumption is
 * wrong, and the alternative to a bounded wait is an unresponsive `verify` with
 * no error at all. Losing the captured output is a much smaller harm than
 * hanging the run; the diagnosis is thrown either way.
 *
 * Injectable through `ServicesStageDeps.settleGraceMs` for tests that want the
 * guard itself to fire quickly, which is a different thing from disabling it.
 */
export const SETTLE_GRACE_MS = 500;

/** Where a declared port is probed, and where a derived base URL points (AD-3). */
const LOCALHOST = '127.0.0.1';

/** What a port probe answers. Structurally the merged `DoctorEffects.probePort`. */
export interface PortProbeResult {
  readonly free: boolean;
  /** Populated only when the bind failed, e.g. `EADDRINUSE`. */
  readonly reason?: string;
}

/**
 * Binds and immediately releases a localhost port to see whether it is free.
 *
 * Declared as a FUNCTION TYPE and injected rather than implemented here, so the
 * merged probe is reused rather than duplicated. The implementation lives in
 * `src/cli/doctor/effects.ts`, which `src/pipeline/**` may not import (AD-1) —
 * injection is therefore the only way to have one probe rather than two, and two
 * would eventually disagree about what "occupied" means. The CLI edge binds
 * `DoctorEffects.probePort`, which satisfies this structurally.
 *
 * Doctor pre-checks declared ports and so does this stage, deliberately (spine
 * Conventions, Ports row). They classify DIFFERENTLY and must: doctor WARNs,
 * because the port a developer is using in the dev server they are about to stop
 * is not a broken environment; here a bound port really does stop the run.
 */
export interface PortProbe {
  (port: number, host: string): Promise<PortProbeResult>;
}

/** What an HTTP readiness poll observed. */
export interface HttpProbeResult {
  /** The response status, or `null` when the request could not be made at all. */
  readonly status: number | null;
}

/**
 * The longest a single readiness request may take before it is abandoned as
 * "not ready yet".
 *
 * REQUIRED, not a nicety, and the reason is a real defect this story shipped
 * once (Codex review, P1): a server that ACCEPTS the connection and then never
 * responds leaves `fetch` pending forever. The readiness deadline is only
 * consulted after a probe resolves, so an unbounded request means
 * `ready.timeoutSec` is never enforced at all — verification hangs instead of
 * producing the `InfraError` AC2 requires. A half-open connection is an ordinary
 * failure of a booting server, not an exotic one.
 *
 * Five seconds: long enough that a slow-but-alive endpoint is not cut off and
 * mistaken for dead, short enough that a hung one is noticed several times
 * within any realistic `timeoutSec`. Each request is additionally clamped to the
 * time actually remaining, so a single hung request can never outlive the
 * deadline it is being measured against.
 */
export const READINESS_REQUEST_TIMEOUT_MS = 5_000;

/**
 * One HTTP GET against a readiness URL.
 *
 * Injected for the same reason as everything else here, and OPTIONAL because a
 * sensible default exists (`fetchReadiness` below) — this keeps the surface 4.7
 * has to bind down to the things only the CLI edge can supply. Story 4.4 builds
 * the real HTTP PROBE EXECUTOR, which is a different job: it records evidence,
 * evaluates assertions and carries a plan's mechanics. This is a liveness poll
 * that answers one question, so 4.4 is free to inject its own client here if it
 * would rather have one HTTP path, and free to leave this alone.
 *
 * It must NEVER reject: a connection refusal is the NORMAL state of a service
 * that has not finished booting, and a rejection here would turn "not ready yet"
 * into a thrown error on the happy path.
 */
export interface HttpReadinessProbe {
  (url: string, options: { readonly timeoutMs: number }): Promise<HttpProbeResult>;
}

/**
 * The live service process groups, and the handle teardown uses to reap them.
 *
 * WHY THIS EXISTS AS A SEPARATE SEAM. `createTeardownStage({release})` takes one
 * injected callback, bound at the CLI edge, and `run-pipeline.ts` calls it after
 * any early stop, after any thrown error, and after an error thrown by teardown
 * itself. That guarantee belongs to the state machine and this stage must not
 * add a second teardown path. But teardown needs the pgids, and a stage cannot
 * hand state to a later stage. So the registry is created at the CLI edge and
 * passed to BOTH: this stage registers into it, `release` drains it.
 *
 * REQUIRED rather than optional, and that is a deliberate fail-closed choice: a
 * composition that bound the services stage but forgot teardown registration
 * would leak every service it started, silently. Making it a type error means
 * that composition cannot be written. (The whole `services` field on
 * `StageDependencies` stays optional — it is binding services WITHOUT teardown
 * that is unrepresentable, not omitting services.)
 *
 * `register` is synchronous on purpose: it is called from inside the runner's
 * `onProcessGroup` hook, which is awaited before the run proceeds, and anything
 * slow there widens the window in which a live group exists that nothing has
 * recorded.
 */
export interface ServiceGroupRegistry {
  /** Records a live service group. Called before readiness polling begins. */
  register(serviceId: string, pgid: number): void;
  /**
   * Terminates ONE registered group and forgets it.
   *
   * Used by the readiness-failure path, which must stop the offending service to
   * collect its captured output as AC2's evidence — a service that started but
   * never answered is exactly the process most likely to be left running.
   * Resolving means the group is GONE, not that a signal was sent (that is
   * `terminateProcessGroup`'s contract, which the CLI edge binds this to).
   */
  release(serviceId: string): Promise<void>;
  /** Terminates every remaining group and forgets them. Idempotent. */
  releaseAll(): Promise<void>;
}

/**
 * Terminates one process group, resolving only once it is GONE.
 *
 * Injected rather than imported so this module constructs no adapter (AD-1). The
 * CLI edge binds `terminateProcessGroup` from `src/infra/process-runner.ts`,
 * which implements SIGTERM → poll → SIGKILL → reap-verify and whose contract is
 * exactly "resolves only when the group is actually gone".
 */
export interface TerminateProcessGroup {
  (pgid: number, options?: { readonly graceMs?: number }): Promise<void>;
}

/**
 * The registry story 4.7 builds and passes to BOTH the services stage and
 * `TeardownDeps.release`.
 *
 * Shipped as a factory rather than as an interface alone, deliberately: 4.7 runs
 * in cohort 3 and cannot ask this story anything, and the drain logic has two
 * subtleties that are easy to get wrong on a first reading and invisible when
 * wrong. `releaseAll` must NOT stop at the first failure — one unkillable group
 * would otherwise leave every remaining service running — and it must forget each
 * group as it goes, so that a second call (the teardown stage runs after an early
 * stop, after a thrown error, and after an error thrown by teardown itself) is a
 * no-op rather than a second round of signals at pids that may have been reused.
 *
 * Failures are collected and raised together at the end. `run-pipeline.ts`
 * records a throwing `release` as a teardown failure and keeps the run's already
 * decided outcome, which is the right shape: a run that PASSed and then leaked a
 * process group is still a PASS with a recorded problem that `specwitness clean`
 * resolves.
 */
export function createServiceGroupRegistry(deps: {
  readonly terminate: TerminateProcessGroup;
  /** Milliseconds between SIGTERM and SIGKILL. Defaults to the adapter's own. */
  readonly graceMs?: number;
}): ServiceGroupRegistry {
  const live = new Map<string, number>();
  const options = deps.graceMs === undefined ? undefined : { graceMs: deps.graceMs };

  const drain = async (entries: readonly [string, number][]): Promise<void> => {
    const failures: string[] = [];
    for (const [serviceId, pgid] of entries) {
      try {
        await deps.terminate(pgid, options);
      } catch (error) {
        failures.push(`${serviceId} (pgid ${pgid}): ${reasonOf(error)}`);
      }
    }
    if (failures.length > 0) {
      throw new InfraError(
        `some service process groups could not be torn down: ${failures.join('; ')}`,
        "inspect them with 'ps -g <pgid>' and run 'specwitness clean' — a surviving service " +
          'will make the next run fail on an occupied port',
      );
    }
  };

  return {
    register(serviceId, pgid) {
      live.set(serviceId, pgid);
    },
    async release(serviceId) {
      const pgid = live.get(serviceId);
      if (pgid === undefined) {
        return;
      }
      // Forgotten BEFORE the signal, so a failure cannot leave an entry that a
      // later `releaseAll` would signal a second time.
      live.delete(serviceId);
      await drain([[serviceId, pgid]]);
    },
    async releaseAll() {
      const entries = [...live.entries()];
      live.clear();
      await drain(entries);
    },
  };
}

export interface ServicesStageDeps {
  /**
   * The declared services, keyed by id. **Iteration order is start order** — see
   * the header. Ids are the config keys verbatim; nothing here renames, prefixes
   * or derives one, which is the identity story 4.2's Plan schema freezes and
   * story 4.4's probes resolve against.
   */
  readonly services: Readonly<Record<string, ServiceConfig>>;
  readonly runner: ProcessRunner;
  readonly registry: ServiceGroupRegistry;
  readonly probePort: PortProbe;
  /**
   * Passed on to the runner so each service's pgid is recorded durably before
   * the run proceeds. The CLI edge binds `RunStore.recordProcessGroup`, which is
   * what lets `specwitness clean` reap a run killed mid-readiness.
   */
  readonly onProcessGroup?: (pgid: number) => void | Promise<void>;
  /** Defaults to `fetchReadiness`. */
  readonly httpProbe?: HttpReadinessProbe;
  /** Defaults to `READINESS_POLL_INTERVAL_MS`. */
  readonly pollIntervalMs?: number;
  /**
   * Per-request ceiling for one readiness probe. Defaults to
   * `READINESS_REQUEST_TIMEOUT_MS`, and is clamped to the time remaining before
   * the readiness deadline whatever it is set to.
   */
  readonly requestTimeoutMs?: number;
  /** Defaults to a real timer. Injected so tests never wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Defaults to `SERVICE_LIFETIME_MS`. */
  readonly lifetimeMs?: number;
  /**
   * Defaults to `SETTLE_GRACE_MS`. A real timer even in tests — see that
   * constant for why this one is not the injected `sleep`.
   */
  readonly settleGraceMs?: number;
}

/**
 * The default HTTP readiness poll: one GET, reporting only the status.
 *
 * Uses the global `fetch` (Node >= 22.12 ships it), so nothing is imported and
 * no adapter is constructed. It NEVER rejects — every network-level failure
 * becomes `{status: null}`, i.e. "not ready yet", because a service that is
 * still binding its socket legitimately refuses connections for a while.
 *
 * `redirect: 'manual'` so a 3xx is observed as a 3xx rather than followed: the
 * readiness contract is "this URL answers 2xx", and silently following a
 * redirect to somewhere that does would report a service ready on the strength
 * of a different endpoint's health.
 */
export const fetchReadiness: HttpReadinessProbe = async (url, options) => {
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      // BOUNDED. Without this a server that accepts the connection and never
      // answers leaves the promise pending forever, and because the deadline is
      // only checked after a probe resolves, `ready.timeoutSec` would never be
      // enforced. The abort surfaces below as `{status: null}` — "not ready
      // yet" — which is exactly right: a half-open connection says nothing
      // except that the service is not serving.
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    return { status: response.status };
  } catch {
    return { status: null };
  }
};

/** Resolves after `ms`. The default `sleep`; tests inject an instant one. */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Split one declared command line, refusing the three malformed forms.
 *
 * Refused BEFORE spawning, and the reasoning is `gates.ts`'s verbatim because
 * the hazard is identical: a mis-grouped argument makes the child fail for a
 * reason that has nothing to do with the branch. It matters MORE here — a
 * corrupted service command produces a service that never becomes ready, and
 * "backend never became ready" is a far worse diagnosis than "your quote is
 * unterminated", because it sends the operator to debug their application.
 *
 * The declared command is REDACTED in every message: a declared command can
 * legitimately carry a credential (`--api-key …` in a service's argv is
 * ordinary), and these messages reach `printError`, which writes to stderr
 * verbatim. Redacted with `{shellCommand: true}` — and ONLY here — because this
 * IS a declared command, text the project owner wrote. Captured OUTPUT never
 * gets that option.
 */
function splitDeclared(
  serviceId: string,
  declared: DeclaredCommand,
  what: 'run' | 'ready.command',
): { binary: string; args: readonly string[] } {
  const text = commandText(declared);
  const where = `services.${serviceId}.${what}`;
  const safe = (): string => redactText(text, { shellCommand: true });

  if (usesUnsupportedEscaping(text)) {
    throw new InfraError(
      `${where} uses backslash-escaped quotes, which are not supported: '${safe()}'`,
      'declared commands are executed without a shell, so a backslash before a quote is ' +
        'ambiguous and is refused rather than guessed at — use the other quote style',
    );
  }
  if (hasUnterminatedQuote(text)) {
    throw new InfraError(
      `${where} has an unterminated quote: '${safe()}'`,
      `close the quote in ${where} in .specwitness/config.yaml — declared commands are split ` +
        'into a binary and arguments without a shell, so an unclosed quote would silently ' +
        'become several arguments rather than one',
    );
  }
  if (hasGluedExecutableSuffix(text)) {
    throw new InfraError(
      `${where} has text attached to its quoted executable: '${safe()}'`,
      `separate them with a space in ${where}, or quote the whole path — as written this would ` +
        'run the quoted binary and pass the rest as an argument, which may not be the command ' +
        'you intended',
    );
  }

  const { binary, args } = splitCommandLine(text);
  if (binary === '') {
    throw new InfraError(
      `${where} declares a command with no executable: '${safe()}'`,
      `set ${where} in .specwitness/config.yaml to a command starting with a binary`,
    );
  }
  return { binary, args };
}

/**
 * A spawn whose promise is deliberately NOT awaited, plus everything needed to
 * observe it without ever risking an unhandled rejection.
 *
 * `observed` never rejects: a rejection is captured into `error` instead. That
 * matters because the promise is held across the entire readiness loop, and an
 * unobserved rejection would take the process down with `ERR_UNHANDLED_REJECTION`
 * at an arbitrary later moment, in a stage whose whole job is orderly shutdown.
 */
interface HeldSpawn {
  /** Resolves when the child settles; never rejects. */
  readonly observed: Promise<void>;
  /** The settled result, once it exists. */
  readonly state: { result?: ProcessResult; error?: unknown };
  /** Resolves once the pgid has been published AND durably recorded. */
  readonly grouped: Promise<void>;
}

/** What one readiness poll observed. Shared by BOTH probe kinds, deliberately. */
type ReadinessPoll =
  | { readonly ready: true }
  /** Not ready YET — keep polling. `detail` is shown only if the deadline wins. */
  | { readonly ready: false; readonly detail: string };

/**
 * Start one service and hold its promise.
 *
 * The `onProcessGroup` composition is the AD-8 ordering, and the order inside it
 * is load-bearing: the group is registered for teardown FIRST, synchronously, so
 * that even if the caller's durable record then fails, the group is already
 * reapable by the teardown stage. The runner awaits this whole hook before the
 * run proceeds, and kills the group if it rejects.
 */
function startService(
  deps: ServicesStageDeps,
  serviceId: string,
  service: ServiceConfig,
  cwd: string,
): HeldSpawn {
  const { binary, args } = splitDeclared(serviceId, service.run, 'run');
  const state: { result?: ProcessResult; error?: unknown } = {};

  let announce: () => void = () => undefined;
  const grouped = new Promise<void>((resolve) => {
    announce = resolve;
  });

  const pending = deps.runner.run({
    binary,
    args,
    cwd,
    timeoutMs: deps.lifetimeMs ?? SERVICE_LIFETIME_MS,
    // Q16: config-declared `env` merged over a pass-through base. Constructed
    // whole and passed whole — the runner resolves it with `extendEnv: false`,
    // so nothing is merged back over it. NOTHING is withheld: FR-15/AD-4
    // withholding is for PROVIDER invocations, not for a project starting its
    // own services, and withholding here would break any service that needs the
    // operator's PATH or toolchain.
    env: service.env === undefined ? { inherit: true } : { inherit: true, set: service.env },
    onProcessGroup: async (pgid) => {
      deps.registry.register(serviceId, pgid);
      await deps.onProcessGroup?.(pgid);
      announce();
    },
  });

  const observed = pending.then(
    (result) => {
      state.result = result;
      announce();
    },
    (error: unknown) => {
      state.error = error;
      announce();
    },
  );

  return { observed, state, grouped };
}

/** One readiness poll of whichever kind this service declared. */
async function pollReadiness(
  deps: ServicesStageDeps,
  serviceId: string,
  service: ServiceConfig,
  cwd: string,
  /**
   * How long THIS request may take. Clamped by the caller to the time actually
   * remaining before the readiness deadline, so one hung request can never
   * outlive the deadline it is being measured against.
   */
  requestBudgetMs: number,
): Promise<ReadinessPoll> {
  const ready = service.ready;

  // The schema's `superRefine` rejects both-or-neither, so EXACTLY ONE of these
  // is present at run time. Not re-validated here: a second check would be a
  // second opinion about a rule the schema already owns.
  if (ready.url !== undefined) {
    const probe = deps.httpProbe ?? fetchReadiness;
    const { status } = await probe(ready.url, { timeoutMs: requestBudgetMs });
    if (status !== null && status >= 200 && status < 300) {
      return { ready: true };
    }
    // A 500 is NOT an error that ends the run: a service that is still booting
    // legitimately answers 500 for a while, and so does one whose dependency has
    // not come up yet. Only the deadline ends the wait.
    return {
      ready: false,
      detail: status === null ? 'the URL could not be reached' : `the URL answered ${status}`,
    };
  }

  const declared = ready.command;
  if (declared === undefined) {
    // UNREACHABLE, and handled rather than asserted away. `readinessSchema`'s
    // `superRefine` rejects both-or-neither, so exactly one of `url` / `command`
    // is present at run time and this branch cannot be entered by any config the
    // loader accepts.
    //
    // It is written as a check and not as `ready.command as DeclaredCommand`
    // deliberately: `tests/unit/config/boundary-scan.test.ts` walks every file
    // under `src/` outside `src/config/` and rejects EVERY assertion form into
    // that brand, whether or not the author believed it safe. It caught this
    // exact line during development — the guard is real, not decorative, and the
    // right answer to "the type is wider than the value" is to handle the width,
    // never to assert it away.
    throw new InfraError(
      `service '${serviceId}' declares no readiness probe`,
      `declare exactly one of 'url' or 'command' under services.${serviceId}.ready in ` +
        '.specwitness/config.yaml — this is a SpecWitness defect if the config loaded cleanly',
    );
  }
  const { binary, args } = splitDeclared(serviceId, declared, 'ready.command');
  const result = await deps.runner.run({
    binary,
    args,
    cwd,
    // Bounded by the same budget as the URL probe, for the same reason: a
    // readiness command that hangs must not outlive the deadline it is being
    // measured against. `timed-out` is classified as "not ready yet" below.
    timeoutMs: requestBudgetMs,
    env: { inherit: true },
  });

  switch (result.outcome) {
    case 'completed':
      return result.exitCode === 0
        ? { ready: true }
        : { ready: false, detail: `the readiness command exited ${String(result.exitCode)}` };

    case 'not-found':
      // Categorically different from a slow service: the probe's own binary is
      // missing, which is an ENVIRONMENT defect. Polling it until the deadline
      // would waste the whole `timeoutSec` and then report the wrong cause.
      throw new InfraError(
        `service '${serviceId}' cannot be checked: its readiness command '${binary}' could not be found`,
        `install '${binary}', or correct services.${serviceId}.ready.command in ` +
          '.specwitness/config.yaml — this is an environment problem, not a failure of the ' +
          'branch under verification',
      );

    case 'timed-out':
      return { ready: false, detail: 'the readiness command did not finish within one poll' };

    case 'spawn-failed':
      throw new InfraError(
        // Redacted at the point captured output enters the message: this reaches
        // `printError`, which writes to stderr verbatim.
        `service '${serviceId}' cannot be checked: its readiness command could not be spawned: ` +
          (redactText(result.stderr).trim() || 'the process did not start'),
        'check that the verification worktree exists and is readable, then rerun',
      );

    default: {
      // Compile-time exhaustiveness. A fifth `ProcessOutcome` added upstream must
      // break this file rather than fall through to "not ready yet" forever.
      const unreachable: never = result.outcome;
      throw new InfraError(
        `service '${serviceId}' readiness returned an unrecognised process outcome: ${String(unreachable)}`,
        'this is a defect in SpecWitness; please report it with the run directory',
      );
    }
  }
}

/**
 * Record what a service printed, as `command` evidence, before the caller throws.
 *
 * `command` evidence and NOT a new evidence kind: `EVIDENCE_KINDS` is a closed
 * union, widening it is an ADR rather than a branch, and `command` says exactly
 * what happened — a declared command was run and produced output. The
 * constructor redacts and bounds what it is handed, and it is handed RAW text
 * (double-redacting is not the contract, and a pre-built `BoundedText` is not
 * expressible by design).
 *
 * The accumulator survives a thrown stage — `gates.ts` relies on the same
 * property — so this is what reaches the report. An operator reading "backend
 * never became ready" with nothing the service printed has been told nothing.
 */
function recordServiceOutput(
  context: StageContext,
  serviceId: string,
  service: ServiceConfig,
  result: ProcessResult | undefined,
): void {
  if (result === undefined || (result.stdout === '' && result.stderr === '')) {
    return;
  }

  context.run.evidence.push(
    commandEvidence({
      capturedAt: context.clock.now().toISOString(),
      commandId: serviceId,
      displayCommand: commandText(service.run),
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
    }),
  );
}

/** A short, printable reason from an unknown thrown value. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wait for one service to become ready, or end the run inconclusive.
 *
 * The loop probes FIRST and checks the deadline afterwards, so a service that is
 * already healthy is never made to wait, and every service gets at least one
 * poll however small its `timeoutSec`.
 */
async function awaitReadiness(
  deps: ServicesStageDeps,
  context: StageContext,
  serviceId: string,
  service: ServiceConfig,
  cwd: string,
  spawn: HeldSpawn,
): Promise<void> {
  const timeoutMs = service.ready.timeoutSec * 1000;
  const pollIntervalMs = deps.pollIntervalMs ?? READINESS_POLL_INTERVAL_MS;
  const sleep = deps.sleep ?? realSleep;
  const deadline = context.clock.now().getTime() + timeoutMs;

  let lastDetail = 'it was never probed';

  for (;;) {
    // A spawn that FAILED — the runner rejected, which happens only when the
    // durable pgid record failed. Propagated rather than retried: leaving a
    // process group nothing on disk can find is the one state `clean` cannot
    // recover from, and the runner has already killed the group.
    if (spawn.state.error !== undefined) {
      throw new InfraError(
        `service '${serviceId}' could not be started: ${reasonOf(spawn.state.error)}`,
        'the run is reported as inconclusive because SpecWitness could not bring the ' +
          'environment up, not because the branch under verification is faulty',
      );
    }

    // A service that EXITED before answering. Diagnosed immediately rather than
    // at the deadline: this is the common real failure (a port clash, a missing
    // migration, a bad env var) and the exit code plus the output IS the answer.
    if (spawn.state.result !== undefined) {
      const result = spawn.state.result;
      recordServiceOutput(context, serviceId, service, result);
      throw new InfraError(
        `service '${serviceId}' exited before it became ready (${describeExit(result)})`,
        `check the captured output for services.${serviceId} in the run directory, then fix ` +
          'the service or its configuration — SpecWitness reached no conclusion about the ' +
          'branch under verification',
      );
    }

    // Clamped to whatever is left of the readiness window, and floored at 1ms so
    // a budget can never be zero or negative (which `AbortSignal.timeout` would
    // treat as "abort immediately", turning every probe into a false negative).
    const remainingMs = Math.max(1, deadline - context.clock.now().getTime());
    const requestBudgetMs = Math.min(
      remainingMs,
      deps.requestTimeoutMs ?? READINESS_REQUEST_TIMEOUT_MS,
    );

    const poll = await pollReadiness(deps, serviceId, service, cwd, requestBudgetMs);
    if (poll.ready) {
      return;
    }
    lastDetail = poll.detail;

    if (context.clock.now().getTime() >= deadline) {
      await failReadinessTimeout(deps, context, serviceId, service, spawn, timeoutMs, lastDetail);
    }

    await sleep(pollIntervalMs);
  }
}

/** How a settled service process ended, in one printable clause. */
function describeExit(result: ProcessResult): string {
  switch (result.outcome) {
    case 'completed':
      return `exit code ${String(result.exitCode)}`;
    case 'not-found':
      return 'its command was not found';
    case 'spawn-failed':
      return 'it could not be spawned';
    case 'timed-out':
      return 'it was killed after exceeding the service lifetime backstop';
    default:
      return 'for an unrecognised reason';
  }
}

/**
 * The AC2 path: the readiness deadline elapsed. Always throws.
 *
 * The service is torn down FIRST, and that ordering is what makes the evidence
 * real rather than empty. `ProcessRunner.run()` settles only when the child
 * exits, so a service that is still running has published nothing yet; killing
 * its group is what causes the promise to settle with the bytes it actually
 * printed. `registry.release` resolves only when the group is GONE, so awaiting
 * the settled promise afterwards cannot hang.
 *
 * If the teardown itself fails the settled promise is NOT awaited — a group that
 * survived SIGKILL will never settle it, and hanging here would replace a
 * precise diagnosis with an unresponsive process.
 */
async function failReadinessTimeout(
  deps: ServicesStageDeps,
  context: StageContext,
  serviceId: string,
  service: ServiceConfig,
  spawn: HeldSpawn,
  timeoutMs: number,
  lastDetail: string,
): Promise<never> {
  let teardownNote = '';
  try {
    await deps.registry.release(serviceId);
    // Bounded: see `SETTLE_GRACE_MS`. A settled promise wins this race in a
    // microtask, long before the timer, so the healthy path pays nothing.
    await Promise.race([spawn.observed, realSleep(deps.settleGraceMs ?? SETTLE_GRACE_MS)]);
  } catch (error) {
    teardownNote = `; its process group could not be torn down (${reasonOf(error)})`;
  }

  recordServiceOutput(context, serviceId, service, spawn.state.result);

  throw new InfraError(
    `service '${serviceId}' did not become ready within ${timeoutMs}ms (${lastDetail})` +
      teardownNote,
    `check the captured output for services.${serviceId} in the run directory; then either ` +
      `fix the service or raise services.${serviceId}.ready.timeoutSec in ` +
      '.specwitness/config.yaml — a service that would not start says nothing about whether ' +
      'the branch under verification is mergeable, so this is reported as an environment ' +
      'problem rather than as a failing build',
  );
}

/**
 * Verify a declared port is free before anything is spawned (Q26/Q27).
 *
 * BEFORE, not after: starting a service that then fails to bind produces a
 * readiness timeout naming the wrong cause, and leaves a process to reap. A
 * service declaring no `port` skips this — V0 never auto-allocates (Q26), so
 * "no declared port" means "SpecWitness has not been told which port to check",
 * not "any port".
 */
async function assertPortFree(
  deps: ServicesStageDeps,
  serviceId: string,
  port: number,
): Promise<void> {
  const probe = await deps.probePort(port, LOCALHOST);
  if (probe.free) {
    return;
  }

  throw new InfraError(
    `service '${serviceId}' declares port ${port}, which is already in use ` +
      `(${probe.reason ?? 'bind failed'})`,
    `stop whatever is holding port ${port} — find it with 'lsof -i :${port}' — or change ` +
      `services.${serviceId}.port in .specwitness/config.yaml. SpecWitness does not ` +
      'auto-allocate ports, so this is an environment problem rather than a failure of the ' +
      'branch under verification',
  );
}

/**
 * Resolve a declared service id to its base URL. **THIS IS THE SEAM STORY 4.4
 * CONSUMES** to turn a plan's `service: backend` into somewhere to send a probe.
 *
 * Published as a named export precisely because 4.4 runs in a later cohort and
 * cannot ask this story anything: it must be able to learn the resolution from
 * merged source alone.
 *
 * NO PRODUCTION DEFAULTS, EVER (AD-3). Nothing is synthesised: the base URL is
 * derived from values the project DECLARED and from nothing else.
 *
 *   - a declared `port`         -> `http://127.0.0.1:<port>` (localhost unless
 *                                  the config says otherwise, which today it can
 *                                  only do through the readiness URL below)
 *   - else a readiness `url`    -> that URL's ORIGIN, verbatim, so a project that
 *                                  health-checks `http://localhost:8080/healthz`
 *                                  gets `http://localhost:8080`
 *   - else                      -> `ConfigError`
 *
 * The last arm is the important one. A service whose readiness is a COMMAND and
 * which declares no port has told SpecWitness nothing about where it listens,
 * and guessing `http://127.0.0.1:3000` would be exactly the invented URL AD-3
 * forbids — it would silently send a probe somewhere nobody declared, and a
 * green result from the wrong process is worse than an error.
 *
 * Throws rather than returning a fallback for an unknown id, mirroring
 * `getObservationCommand` and for the identical reason: quietly substituting
 * anything would be a hole in the AD-3 boundary. The hint names the declared
 * ids, because "no such service" without the list of real ones is a riddle.
 */
export function resolveServiceBaseUrl(config: SpecwitnessConfig, serviceId: string): string {
  // Own-property check on purpose: a prototype walk would resolve `constructor`
  // or `toString` into something that is not a declared service at all.
  const service = Object.hasOwn(config.services, serviceId)
    ? config.services[serviceId]
    : undefined;

  if (service === undefined) {
    const declared = Object.keys(config.services);
    throw new ConfigError(
      `services.${serviceId}: no service with id "${serviceId}" is declared in .specwitness/config.yaml`,
      declared.length > 0
        ? `declare it under 'services:' or use one of: ${declared.join(', ')}`
        : "declare it under 'services:' in .specwitness/config.yaml",
    );
  }

  if (service.port !== undefined) {
    return `http://${LOCALHOST}:${service.port}`;
  }

  const readinessUrl = service.ready.url;
  if (readinessUrl !== undefined) {
    try {
      return new URL(readinessUrl).origin;
    } catch {
      throw new ConfigError(
        `services.${serviceId}.ready.url is not a valid URL: '${redactText(readinessUrl)}'`,
        `write an absolute URL such as http://127.0.0.1:3000/health in services.${serviceId}.ready.url`,
      );
    }
  }

  throw new ConfigError(
    `services.${serviceId}: cannot determine a base URL — it declares no 'port' and its readiness probe is a command, not a URL`,
    `add 'port:' under services.${serviceId} in .specwitness/config.yaml. SpecWitness never ` +
      'invents a URL for a service: a probe sent to a guessed address would report on ' +
      'whatever happened to be listening there',
  );
}

/**
 * @param deps the services seam, or `undefined` for a pipeline with no services
 * wired. See the header for why an unwired stage is a no-op rather than a
 * refusal.
 */
export function createServicesStage(deps?: ServicesStageDeps): Stage {
  return {
    name: 'services',
    run: async (context): Promise<StageResult> => {
      if (deps === undefined) {
        return stageOk('no service runner was wired into this verification; nothing was started');
      }

      const ids = Object.keys(deps.services);
      if (ids.length === 0) {
        return stageOk('no services declared');
      }

      const cwd = context.run.environment.worktreePath;
      if (cwd === null) {
        // Never fall back to the project root: that would start the operator's
        // services against the wrong tree and could write into their working
        // directory (AD-8, FR-19). Identical refusal, identical reason, as
        // `createGatesStage` at the same point.
        throw new InfraError(
          'services cannot start: no verification worktree was created',
          'this is a SpecWitness defect — the worktree stage must run before services',
        );
      }

      for (const serviceId of ids) {
        const service = deps.services[serviceId] as ServiceConfig;

        if (service.port !== undefined) {
          await assertPortFree(deps, serviceId, service.port);
        }

        const spawn = startService(deps, serviceId, service, cwd);
        // The pgid is durable — or the spawn has already failed — BEFORE anything
        // waits. Batching the record to the end would leave a `kill -9` window in
        // which a live process group exists that nothing on disk can find.
        await spawn.grouped;
        await awaitReadiness(deps, context, serviceId, service, cwd, spawn);
      }

      return stageOk(`${ids.length} service(s) started and ready`);
    },
  };
}
