/**
 * The execa implementation of the `ProcessRunner` port.
 *
 * Modelled directly on `runGit` in `src/cli/doctor/effects.ts`, which is the
 * merged, proven spawn shape for this codebase: `reject: false`, an explicit
 * `input`, an explicit `timeout`, and ENOENT detected from the thrown error's
 * `code`. Deviating from it would mean two different subprocess behaviours in
 * one product.
 *
 * SCOPE, stated so nobody has to guess (and so Epic 3's author finds an
 * invitation rather than a surprise): **Epic 3 story 3.2 owns the LIFECYCLE
 * half** of this file — process groups (pgid), the run manifest, teardown
 * discipline, `specwitness clean`. Epic 2 story 2.3 created it MINIMALLY,
 * because stories 2.4 and 2.5 cannot spawn a provider CLI without it and
 * blocking Epic 2 on Epic 3 was not an option. 3.2 EXTENDS what is here; it does
 * not replace it. `ProcessRunOptions` is a single options object precisely so
 * that extension is additive.
 *
 * Note for `roadmap.md` readers: the EPIC 3 wave-A line still says
 * "3.2 (infra/process-runner, run-store manifest side)" without qualification.
 * The split above is recorded in this story's spec and in this header; amending
 * the roadmap line (or writing an ADR) is an epic-closure item for the
 * supervisor, not an edit a story makes to a finalized planning artifact.
 *
 * SECURITY (AD-3): there is no `shell` option anywhere below, no string command,
 * no `sh -c`. `binary` + `args[]` go to `execve` untouched, which is what makes
 * it impossible for text a model wrote to become an executable command. The
 * binaries this spawns (`claude`, `codex`) are SpecWitness's own trusted tools,
 * invoked by fixed name with a fixed argument array — exactly like `git` — and
 * are deliberately NOT `DeclaredCommand`s: that brand constrains
 * project-declared SHELL STRINGS, and there is no shell here to constrain.
 *
 * NFR-1: nothing here reads a credential store, and nothing reads `process.env`
 * BY NAME. The environment is copied wholesale so the caller can subtract from
 * it; `tests/unit/doctor/credential-boundary.test.ts` scans this file.
 *
 * ============================================================================
 * PROCESS GROUPS — MEASURED, NOT ASSUMED (story 3.2, macOS 15 / Node 22.20.0 /
 * execa 10.0.1, 2026-08-31)
 * ============================================================================
 *
 * The spine's Stack table flagged execa 10's process-group semantics on macOS
 * as "verified by Epic 3 story 3.2 tests", i.e. nobody had verified them. So
 * they were measured, with `/bin/sh -c` equivalent scripts that fork
 * (`sleep 3600 &` then `wait`), recording whether the direct child, the
 * grandchild and execa's own promise ended up where the docs imply. Verbatim
 * results, one row per configuration:
 *
 *   A  execa `timeout: 500`, NOT detached
 *      child dead · GRANDCHILD ALIVE · promise UNSETTLED after 6.7s
 *   B  `subprocess.kill('SIGKILL')`, NOT detached
 *      child dead · GRANDCHILD ALIVE · promise UNSETTLED after 6.7s
 *   C  `detached: true` + `process.kill(-pgid, 'SIGKILL')`
 *      child dead · grandchild DEAD · promise settled in 428ms
 *   D  `detached: true` + `process.kill(-pgid, 'SIGTERM')`, then SIGKILL
 *      child dead · grandchild DEAD · promise settled in 426ms; the whole group
 *      was already gone 200ms after the SIGTERM, so the SIGKILL was a no-op
 *   E  `detached: true` + execa `timeout: 500` (no explicit group kill)
 *      child dead · GRANDCHILD ALIVE · promise UNSETTLED after 6.7s
 *   F  `detached: true` + `timeout: 500` + `forceKillAfterDelay: 200`
 *      child dead · GRANDCHILD ALIVE · promise UNSETTLED after 6.7s
 *
 * THE CONCLUSIONS, because the rows matter more than the prose:
 *
 *  1. execa never signals the process group, even when it created one (E, F).
 *     `cleanup` and `forceKillAfterDelay` do not help. Detaching alone changes
 *     NOTHING about reaping — it only makes reaping possible.
 *  2. `process.kill(-pgid, ...)` does reach grandchildren (C, D). That is AC2's
 *     explicitly permitted fallback, and it is the answer.
 *  3. The unsettled promise in A/B/E/F is the SAME defect from a different
 *     angle: the grandchild inherits the stdio pipes and holds them open, so
 *     execa cannot settle. Kill the GROUP and the pipes close, which is why C
 *     and D settle in ~430ms with no watchdog involvement at all.
 *  4. SIGTERM to the group was sufficient for `sh` + `sleep` (D). The SIGKILL
 *     escalation is still implemented, because a child that traps SIGTERM is
 *     exactly the child that would otherwise leak.
 *
 * So this port owns the timeout itself rather than delegating it to execa:
 * after a group kill execa reports `timedOut: false` and a `signal`, because
 * from its point of view somebody else killed the child. Two mechanisms racing
 * to classify one event is how a timeout ends up reported as `completed`, and
 * that is the single worst thing this file could do.
 *
 * WHAT THIS COSTS, stated honestly: a detached child is no longer in the
 * terminal's foreground process group, so Ctrl+C at an interactive prompt
 * reaches SpecWitness but NOT the child. That is inherent to AD-8 — the whole
 * point is that children outlive an abrupt parent death in a RECORDED way —
 * and the designed remedy is the run manifest plus `specwitness clean`, not a
 * signal handler. A descendant that leaves the group on purpose (`setsid`) is
 * beyond the reach of any pgid kill on any OS; `npm`, `pnpm` and
 * `docker compose` do not do that.
 */

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';

import { execa } from 'execa';

import { InfraError } from '../domain/errors.js';
import type { Clock } from '../domain/ports.js';
import type {
  ChildEnvironment,
  ProcessResult,
  ProcessRunOptions,
  ProcessRunner,
} from '../domain/process-runner.js';

/** The shape of `process.env`, as a parameter so the resolver stays pure. */
export type ParentEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * How long to wait past `timeoutMs` for execa to actually settle before this
 * port gives up and classifies the run itself. See `SETTLEMENT` below.
 */
const SETTLEMENT_GRACE_MS = 1_000;

/**
 * Milliseconds between SIGTERM and SIGKILL when a process group is torn down.
 *
 * Two seconds, chosen rather than guessed. It is long enough for the things
 * SpecWitness actually spawns to run a signal handler and flush — a test runner
 * printing a summary, a dev server closing sockets, `docker compose` stopping
 * containers — and short enough that tearing down several groups at the end of
 * a verify run stays inside the time an operator will sit and watch. Overriding
 * it per call (`teardownGraceMs`) is how tests assert the escalation in
 * milliseconds instead of waiting this out.
 */
export const TEARDOWN_GRACE_MS = 2_000;

/** How often liveness is re-probed while waiting out the grace period. */
const GROUP_POLL_INTERVAL_MS = 20;

/**
 * How long to wait for a process group to actually disappear after SIGKILL.
 *
 * Delivering a signal is not the same as the processes having exited, and this
 * port's callers rely on the difference: `specwitness clean` removes a worktree
 * immediately after teardown, and a process still holding files inside it turns
 * a successful kill into a spurious removal failure. So teardown does not
 * resolve until the group is gone.
 *
 * Two seconds is generous — SIGKILL is normally reaped in single-digit
 * milliseconds — and bounded, because a task wedged in uninterruptible sleep is
 * a real condition that must be REPORTED rather than waited on forever.
 */
const SIGKILL_REAP_TIMEOUT_MS = 2_000;

interface SpawnFailure extends Error {
  code?: string;
  timedOut?: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

/** The failure-shaped fields execa 10 puts on a `reject: false` RESULT. */
interface FailureFields {
  readonly failed?: boolean;
  readonly timedOut?: boolean;
  /** `'ENOENT'` when the binary could not be spawned at all. */
  readonly code?: string;
  /** execa's own explanation, e.g. `The "cwd" option is invalid: /no/such/dir`. */
  readonly shortMessage?: string;
  readonly message?: string;
}

/**
 * What to show the operator when a spawn failed before the child could speak.
 *
 * A process that never started has empty stdout AND empty stderr, so a caller
 * handed `spawn-failed` with nothing else has nothing to render — and the one
 * sentence that says *why* (`The "cwd" option is invalid: …`) lives on execa's
 * own message rather than on the stream. Only used when the child produced no
 * stderr of its own, so a real child's output is never overwritten.
 */
function explain(fields: FailureFields): string {
  return fields.shortMessage ?? fields.message ?? '';
}

/**
 * Is `cwd` an existing directory?
 *
 * Only ever consulted on the ENOENT path, so the happy path pays nothing. Sync
 * because it runs once, after a spawn has already failed, and an async stat
 * would buy nothing but a more tangled classifier.
 */
function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Classify one spawn from the failure-shaped fields, wherever they arrive.
 *
 * TWO THINGS HERE ARE VERIFIED AGAINST THE PINNED EXECA 10 RATHER THAN ASSUMED,
 * and both are traps:
 *
 * 1. With `reject: false`, a binary that is not on PATH does NOT throw — it
 *    RESOLVES to a result carrying `failed: true`, `code: 'ENOENT'` and an
 *    undefined `exitCode`. Classifying ENOENT only inside a `catch` therefore
 *    never fires, and every missing binary reads as a clean `completed` run.
 *    So both paths funnel through here.
 *
 * 2. ENOENT alone does not mean "the binary is missing". An invalid `cwd`
 *    produces the SAME `code: 'ENOENT'`, with the difference visible only in a
 *    message string:
 *
 *      missing binary → 'spawn specwitness-no-such-binary ENOENT'
 *      invalid cwd    → 'The "cwd" option is invalid: /no/such/dir'
 *
 *    Trusting ENOENT alone would tell an operator to install a CLI that is
 *    already installed — and `not-found` is the input to doctor's "install it
 *    and reopen your shell" diagnosis, which is among the most consequential
 *    things doctor says. Rather than sniffing that message, which is execa's to
 *    change, we ask the filesystem directly: a `cwd` that is not an existing
 *    directory makes this `spawn-failed`, whatever the binary's state.
 */
function classify(fields: FailureFields, cwd: string, threw: boolean): ProcessResult['outcome'] {
  if (fields.timedOut === true) {
    return 'timed-out';
  }
  if (fields.code === 'ENOENT') {
    return isExistingDirectory(cwd) ? 'not-found' : 'spawn-failed';
  }
  // FAIL CLOSED on the thrown path. Anything reaching a `catch` is by definition
  // unanticipated, and the one outcome it must never be handed is `completed` —
  // that is the single claim which would let a failure pass as a success
  // everywhere downstream. (Learned the hard way: an earlier revision let a
  // TypeError in this module's own result-building code surface as a clean
  // completed run.)
  if (threw) {
    return 'spawn-failed';
  }
  return fields.failed === true && fields.code !== undefined ? 'spawn-failed' : 'completed';
}

/**
 * Resolve a `ChildEnvironment` into the child's COMPLETE environment.
 *
 *   base = inherit ? {...parent} : {}  →  delete `withhold`  →  apply `set`
 *
 * Exported for its own unit tests: this is where FR-15's billing guarantee
 * actually lives, and a rule this consequential should be provable without
 * spawning anything.
 *
 * Neither argument is mutated. Names whose parent value is `undefined` are
 * dropped rather than stringified — `process.env` is typed
 * `Record<string, string | undefined>`, and "undefined" is not a value any child
 * should receive.
 */
export function resolveChildEnvironment(
  spec: ChildEnvironment,
  parent: ParentEnvironment,
): Record<string, string> {
  const child: Record<string, string> = {};

  if (spec.inherit) {
    for (const [name, value] of Object.entries(parent)) {
      if (value !== undefined) {
        child[name] = value;
      }
    }
  }

  // Before `set`, so that a name which is both withheld and set ends up SET:
  // the caller asked for that value explicitly, and this is the only ordering
  // that lets a caller REPLACE a variable rather than only remove it.
  for (const name of spec.withhold ?? []) {
    delete child[name];
  }

  for (const [name, value] of Object.entries(spec.set ?? {})) {
    child[name] = value;
  }

  return child;
}

/**
 * This process's OWN process-group id, or `null` when it cannot be determined.
 *
 * Node exposes `process.pid` and `process.ppid` but no `getpgid`, and the
 * difference matters enormously here: under a test runner, a shell job or the
 * agent harness, SpecWitness is frequently NOT its own group leader, so
 * comparing a candidate pgid against `process.pid` alone leaves the one signal
 * that would kill us undetected. That is not hypothetical — the first draft of
 * this guard checked only `pid`/`ppid`, and the test asserting "never signal our
 * own group" killed the entire vitest run instead of passing.
 *
 * So it is read once from `ps`, synchronously, and cached for the life of the
 * process: one ~5ms spawn, ever, against a failure mode that takes down the
 * caller. AD-3 holds — fixed binary, fixed argument array, no shell, no
 * interpolation of anything but this process's own pid.
 *
 * Returns `null` rather than throwing if `ps` is unavailable or unparseable. A
 * missing guard must not make teardown impossible; the structural refusals
 * below still apply, and `specwitness clean` — the only caller that signals a
 * pgid it did not create — verifies identity separately before it gets here.
 */
let cachedOwnProcessGroup: number | null | undefined;

function ownProcessGroup(): number | null {
  if (cachedOwnProcessGroup === undefined) {
    try {
      const reported = execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], {
        encoding: 'utf8',
        timeout: 2_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const value = Number(reported.trim());
      cachedOwnProcessGroup = Number.isInteger(value) && value > 0 ? value : null;
    } catch {
      cachedOwnProcessGroup = null;
    }
  }
  return cachedOwnProcessGroup;
}

/**
 * Resolves after `ms`.
 *
 * REF'D, deliberately. Every timer whose expiry a run's settlement depends on
 * must hold the event loop open, or Node can empty the loop while the CLI's
 * top-level `await` is still pending and exit 13 (ERR_UNFINISHED_TOP_LEVEL_AWAIT)
 * with no output at all. That is not hypothetical: it is what happened when this
 * file first dropped execa's own (ref'd) `timeout` timer and left every
 * replacement timer unref'd — `specwitness doctor` exited 13 instead of 0 under
 * load. Timers are cleared or awaited on every path, so nothing here outlives
 * the run it belongs to.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Refuses to signal anything that is not a process group we could have created.
 *
 * `process.kill(-pgid, ...)` is one negation away from being the most
 * destructive call in this codebase, so the refusals are structural rather than
 * advisory:
 *
 *   pgid <= 1     `kill(-0, ...)` signals the CALLER's own process group, which
 *                 would take down SpecWitness and, under a test runner, the very
 *                 suite trying to prove this is safe. `-1` means "every process
 *                 this user may signal" — the worst syscall available here.
 *   process.pid   a group led by this very process.
 *   process.ppid  the parent's group: the shell, or the harness that launched us.
 *   our own pgid  read from `ps` once and cached, because under a test runner or
 *                 a shell job SpecWitness is usually NOT its own group leader and
 *                 the three checks above would all miss it.
 *
 * WHAT THIS DOES NOT GUARANTEE: that `pgid` is still the group WE created. Pid
 * reuse is real, and a pgid read back from a manifest written last week may
 * belong to the operator's editor today. Nothing inside this function can know
 * that. Establishing identity before signalling is the CALLER's job, and
 * `specwitness clean` — the only caller that ever signals a pgid it did not
 * spawn itself — does it with a recorded-time check before reaching here.
 */
function assertSignallableProcessGroup(pgid: number): void {
  if (!Number.isInteger(pgid) || pgid <= 1) {
    throw new InfraError(
      `refusing to signal process group ${pgid}`,
      'a process group id must be an integer greater than 1: 0 would signal the SpecWitness process group itself and -1 every process on the machine',
    );
  }
  if (pgid === process.pid || pgid === process.ppid || pgid === ownProcessGroup()) {
    throw new InfraError(
      `refusing to signal process group ${pgid}: it is the SpecWitness process group or its parent`,
      'this is a SpecWitness bug — please report it with the command you ran',
    );
  }
}

/**
 * Sends one signal to a whole process group.
 *
 * Returns `false` when the group is already gone (ESRCH), which is the ordinary
 * case for `clean` replaying an old manifest and must never be an error.
 *
 * EPERM is NOT tolerated. A group that exists but cannot be signalled is strong
 * evidence that it is not ours, and continuing quietly would either leak it or,
 * far worse, invite a retry against somebody else's process tree.
 */
function signalProcessGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      return false;
    }
    if (code === 'EPERM') {
      throw new InfraError(
        `not permitted to signal process group ${pgid}`,
        `the process group exists but belongs to another user, so nothing was signalled; inspect it with 'ps -g ${pgid}' before acting by hand`,
      );
    }
    throw new InfraError(
      `could not signal process group ${pgid}: ${describeCause(cause)}`,
      'this is a SpecWitness bug — please report it with the command you ran',
    );
  }
}

/**
 * AD-8 teardown: SIGTERM to the GROUP, a grace period, then SIGKILL to the
 * GROUP. Both signals go to `-pgid`; neither ever goes to a bare pid, because a
 * bare pid reaches the direct child only and leaves its descendants running —
 * measured, rows A and B in this file's header.
 *
 * A FREE FUNCTION rather than a second method on `ProcessRunner`, deliberately.
 * The port's OWNERSHIP block says there is exactly one method precisely so this
 * story preserves exactly one, and a required second method would break every
 * `ProcessRunner` fake under `tests/` — i.e. it would force edits to the tests
 * the additive contract exists to protect. `run` tears its own group down on
 * timeout, so ordinary callers never need this; it is here for long-lived
 * services (Epic 4 story 4.1) and for `specwitness clean`.
 *
 * Idempotent and safe on a group that has already exited — the COMMON case when
 * replaying a manifest, not an exceptional one.
 *
 * RESOLVES ONLY WHEN THE GROUP IS ACTUALLY GONE, never merely when a signal was
 * delivered. `clean` removes a worktree the instant this resolves, and a member
 * still holding files inside it would turn a successful kill into a spurious
 * removal failure. A group that survives SIGKILL raises rather than resolving.
 */
export async function terminateProcessGroup(
  pgid: number,
  options: { readonly graceMs?: number } = {},
): Promise<void> {
  assertSignallableProcessGroup(pgid);

  const graceMs = options.graceMs ?? TEARDOWN_GRACE_MS;

  if (!signalProcessGroup(pgid, 'SIGTERM')) {
    return; // already gone
  }

  // Polled rather than slept through: a well-behaved group usually dies in
  // milliseconds, and paying the full grace every time would add seconds per
  // service to the end of every run.
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await delay(Math.min(GROUP_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    if (!signalProcessGroup(pgid, 0)) {
      return;
    }
  }

  if (!signalProcessGroup(pgid, 'SIGKILL')) {
    return; // exited between the last poll and the escalation
  }

  // SIGKILL cannot be caught, but delivery is not exit: the kernel still has to
  // schedule and reap each member. Callers remove worktrees the moment this
  // resolves, so resolving early makes a successful kill look like a failed
  // removal.
  const killDeadline = Date.now() + SIGKILL_REAP_TIMEOUT_MS;
  while (Date.now() < killDeadline) {
    await delay(Math.min(GROUP_POLL_INTERVAL_MS, Math.max(1, killDeadline - Date.now())));
    if (!signalProcessGroup(pgid, 0)) {
      return;
    }
  }

  // Surviving SIGKILL means uninterruptible sleep, or a zombie whose parent has
  // not reaped it. Neither is something to wait on, and neither may be reported
  // as a successful teardown: `clean` turns this into "could not reap", which is
  // the honest answer.
  throw new InfraError(
    `process group ${pgid} did not exit within ${SIGKILL_REAP_TIMEOUT_MS}ms of SIGKILL`,
    `inspect it with 'ps -g ${pgid}'; a process in uninterruptible sleep cannot be killed and may be waiting on a stalled filesystem or device`,
  );
}

function createRunner(clock: Clock): ProcessRunner {
  const run = async (options: ProcessRunOptions): Promise<ProcessResult> => {
    // Copied wholesale rather than read by name: the caller subtracts from this,
    // and naming variables here would put credential-shaped names into a file
    // that has no business knowing any.
    const env = resolveChildEnvironment(options.env, process.env);
    const startedAt = clock.now().getTime();
    const graceMs = options.teardownGraceMs ?? TEARDOWN_GRACE_MS;

    // `durationMs` is computed for every exit path, including the throwing one,
    // so a failed spawn is as measurable as a successful call. Called EXACTLY
    // once per return, because the injected Clock may be a scripted sequence.
    const elapsed = (): number => Math.round(clock.now().getTime() - startedAt);

    // Set only when the CALLER's `onProcessGroup` threw. Such an error must
    // reach the caller unchanged: turning it into a `spawn-failed` value would
    // report a SpecWitness durability failure (exit 3) as something the child
    // did, and quietly downgrade it to an outcome nothing treats as urgent.
    let recordingFailed = false;

    try {
      const spawned = execa(options.binary, [...options.args], {
        cwd: options.cwd,
        // Non-zero exit is a RESULT, not an exception: "it said no" is
        // information every caller needs, and an exception would flatten it
        // together with "it is not installed".
        reject: false,
        // Prompt-free by contract: a child left waiting on stdin would hang
        // until the timeout instead of failing immediately.
        input: options.input ?? '',
        env,
        // THE load-bearing line. execa defaults `extendEnv` to TRUE, which would
        // merge `process.env` back over the environment the caller carefully
        // constructed — silently defeating every `withhold` and with it FR-15's
        // billing guarantee. `doctor/effects.ts` sets it explicitly for the same
        // reason.
        extendEnv: false,
        // AD-8: the child leads its OWN process group, so a later
        // `kill(-pgid, ...)` reaches its whole descendant tree. This flag alone
        // reaps nothing (measured — header rows E and F); it only makes reaping
        // possible.
        detached: true,
        // NOTE the absence of `timeout`. This port owns the timeout itself: see
        // the header. After a group kill execa reports `timedOut: false` and a
        // signal, because from its point of view somebody else did the killing,
        // so leaving execa's own timer armed would mean two mechanisms racing to
        // classify one event — which is how a timeout ends up reported as a
        // clean `completed` run.
      });

      // A detached child is its group's LEADER, so its pgid IS its pid.
      // `undefined` when the spawn failed outright (ENOENT, bad cwd): there is
      // no process, and therefore no group.
      const pgid = typeof spawned.pid === 'number' ? spawned.pid : null;

      let timedOut = false;
      let teardown: Promise<Error | undefined> = Promise.resolve(undefined);

      /**
       * ARMED IMMEDIATELY AFTER SPAWN, before the durability hook is awaited.
       *
       * The obvious ordering — record the pgid, then start the clock — makes
       * `timeoutMs` conditional on the hook: an fsync that stalls leaves the
       * child running with no timer at all, so it can outlive its deadline
       * indefinitely and still be classified `completed`. The deadline belongs
       * to the CHILD's lifetime, and that starts here.
       *
       * REF'D (see `delay`): this timer is what keeps the process alive long
       * enough to notice a hang and reap it. Cleared the moment the run settles.
       */
      const timer = setTimeout(() => {
        timedOut = true;
        if (pgid !== null) {
          teardown = terminateProcessGroup(pgid, { graceMs }).then(
            () => undefined,
            (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))),
          );
        }
      }, options.timeoutMs);

      // Armed here too, and for the same reason: a watchdog that only starts
      // after the hook is a watchdog the hook can disable by hanging.
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<{ settled: false }>((resolve) => {
        watchdog = setTimeout(
          () => resolve({ settled: false }),
          options.timeoutMs + graceMs + SETTLEMENT_GRACE_MS,
        );
      });
      const clearTimers = (): void => {
        clearTimeout(timer);
        if (watchdog !== undefined) {
          clearTimeout(watchdog);
        }
      };

      if (pgid !== null && options.onProcessGroup !== undefined) {
        const hook = Promise.resolve()
          .then(() => options.onProcessGroup?.(pgid))
          .then(
            () => ({ kind: 'recorded' }) as const,
            (error: unknown) => ({ kind: 'failed', error }) as const,
          );

        // Raced against the watchdog, so a hook that never settles cannot make
        // `run` never settle. This port's contract is that it ALWAYS settles.
        const outcome = await Promise.race([
          hook,
          expired.then(() => ({ kind: 'stalled' }) as const),
        ]);

        if (outcome.kind === 'failed') {
          // The record failed, so nothing on disk knows this group exists. A
          // live process group that nothing can find is the one state `clean`
          // cannot recover from, so kill it before the error propagates.
          // Swallowing the error would trade a reported infra failure for a
          // silent leak.
          recordingFailed = true;
          clearTimers();
          spawned.catch(() => undefined);
          await terminateProcessGroup(pgid, { graceMs }).catch(() => undefined);
          throw outcome.error;
        }

        if (outcome.kind === 'stalled') {
          clearTimers();
          spawned.catch(() => undefined);
          // The timeout above already tore the group down; this makes sure of it
          // and explains why the run is being abandoned. Not a `completed` run
          // under any reading.
          await terminateProcessGroup(pgid, { graceMs }).catch(() => undefined);
          return {
            outcome: 'timed-out',
            exitCode: null,
            stdout: '',
            stderr:
              `timed out after ${options.timeoutMs}ms; the caller's onProcessGroup hook ` +
              'never settled, so the process group was terminated without being recorded',
            durationMs: elapsed(),
            pgid,
          };
        }
      }

      /**
       * SETTLEMENT — why a watchdog survives even now that teardown reaps.
       *
       * Story 2.3 introduced this because a forking child's grandchild inherits
       * the stdout/stderr pipes and holds them open, so execa never settles and
       * the promise hangs forever (header rows A, B, E, F). Killing the process
       * GROUP closes those pipes, which is why the measured teardown settles in
       * ~430ms with the watchdog never firing at all.
       *
       * It is kept anyway, because "the group kill worked" is an assumption and
       * this port's contract is that it ALWAYS settles and ALWAYS classifies. If
       * a descendant escaped the group (`setsid`), or the kill was refused, the
       * watchdog is what stops `specwitness verify` wedging: an infra hang is
       * not a product FAIL, but only if it can be DETECTED.
       *
       * The deadline now allows for the teardown itself — the timeout, then the
       * SIGTERM-to-SIGKILL grace, then a moment for execa to notice. It is armed
       * at SPAWN rather than here, so a durability hook that stalls cannot
       * postpone it.
       */
      const settlement = await Promise.race([
        spawned.then((value) => ({ settled: true as const, value })),
        expired,
      ]);

      // CLEARED rather than unref'd. Story 2.3 unref'd its watchdog so a fast
      // run would not be held open by the losing side of the race; clearing
      // achieves the same thing without the failure mode unref'ing everything
      // introduced — an event loop that empties while the run is still pending,
      // which Node reports as exit 13 with no output at all.
      clearTimers();
      // Never return while a SIGKILL is still in flight: a caller that removes a
      // worktree next must not race processes still holding files inside it.
      const teardownFailure = await teardown;

      if (!settlement.settled) {
        // The losing promise must not become an unhandled rejection later.
        spawned.catch(() => undefined);
        return {
          outcome: 'timed-out',
          exitCode: null,
          stdout: '',
          stderr: joinLines([
            `timed out after ${options.timeoutMs}ms and did not exit within ` +
              `${graceMs + SETTLEMENT_GRACE_MS}ms of its process group being terminated; ` +
              'a descendant process is likely still holding its output streams open',
            teardownFailure?.message,
          ]),
          durationMs: elapsed(),
          pgid,
        };
      }

      const result = settlement.value;
      const fields = result as FailureFields;
      // `?? ''` is not defensive noise: on a spawn failure (ENOENT, ENOTDIR)
      // execa leaves BOTH streams undefined, because there was never a process
      // to produce them. Reading `.length` off them is a TypeError.
      const stdout = result.stdout ?? '';
      const stderr = result.stderr ?? '';

      if (timedOut) {
        // Classified HERE rather than from execa's `timedOut`, which is FALSE
        // after our own group kill. The captured output is kept: a gate that
        // timed out still produced evidence worth reading, and discarding it
        // would leave an operator with a verdict and no explanation.
        return {
          outcome: 'timed-out',
          exitCode: null,
          stdout,
          stderr: joinLines([
            stderr,
            `timed out after ${options.timeoutMs}ms; SpecWitness terminated its process group` +
              (pgid === null ? '' : ` (pgid ${pgid})`),
            teardownFailure?.message,
          ]),
          durationMs: elapsed(),
          pgid,
        };
      }

      return {
        outcome: classify(fields, options.cwd, false),
        // `undefined` on a failed spawn; `null` is this port's "never started".
        exitCode: result.exitCode ?? null,
        stdout,
        // A child that never started has no stderr of its own, and the sentence
        // saying why lives on execa's message. Fall back to it ONLY then, so a
        // real child's output is never overwritten by a wrapper's prose.
        stderr: stderr.length > 0 || fields.failed !== true ? stderr : explain(fields),
        durationMs: elapsed(),
        pgid,
      };
    } catch (error) {
      // An `onProcessGroup` failure is NOT a subprocess outcome and must not be
      // flattened into one. See `recordingFailed` above.
      if (recordingFailed) {
        throw error;
      }

      // `reject: false` suppresses both non-zero exits and spawn failures, so
      // the rest of this branch should be unreachable in practice. It is kept
      // because "should be unreachable" is not a guarantee across an execa
      // minor, and the alternative is an unclassified crash escaping a port
      // whose whole contract is that it never throws for a subprocess outcome.
      const failure = error as SpawnFailure;

      return {
        outcome: classify({ ...failure, failed: true }, options.cwd, true),
        exitCode: failure.exitCode ?? null,
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? failure.message,
        durationMs: elapsed(),
        pgid: null,
      };
    }
  };

  return { run };
}

/**
 * Build the runner every provider adapter and doctor probe spawns through.
 *
 * The `Clock` is injected (AD-9) so `durationMs` is deterministic under test —
 * a duration read from the wall clock can only be asserted as "greater than
 * zero", which passes even when the clock is read once and reused.
 */
export function createProcessRunner(clock: Clock): ProcessRunner {
  return createRunner(clock);
}

/** Best-effort message from an unknown thrown value, for error text. */
function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Joins the non-empty parts of an explanation, so no blank line ever leads. */
function joinLines(parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part.length > 0).join('\n');
}
