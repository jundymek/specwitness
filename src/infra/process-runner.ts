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
 */

import { statSync } from 'node:fs';

import { execa } from 'execa';

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

function createRunner(clock: Clock): ProcessRunner {
  const run = async (options: ProcessRunOptions): Promise<ProcessResult> => {
    // Copied wholesale rather than read by name: the caller subtracts from this,
    // and naming variables here would put credential-shaped names into a file
    // that has no business knowing any.
    const env = resolveChildEnvironment(options.env, process.env);
    const startedAt = clock.now().getTime();

    // `durationMs` is computed for every exit path, including the throwing one,
    // so a failed spawn is as measurable as a successful call.
    const elapsed = (): number => Math.round(clock.now().getTime() - startedAt);

    try {
      const spawned = execa(options.binary, [...options.args], {
        cwd: options.cwd,
        timeout: options.timeoutMs,
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
      });

      /**
       * SETTLEMENT — why `execa`'s own timeout is not sufficient on its own.
       *
       * Verified against execa 10 / Node 22 (reported by story 2.5 with a
       * reproduction, confirmed here): when the child FORKS, execa's timeout
       * kills the direct child but the grandchild inherits the stdout/stderr
       * pipes and keeps them open. execa does not settle until those streams
       * close, so the promise never resolves and `timed-out` never happens.
       *
       *   sh -c 'while true; do sleep 3600; done'  → still unsettled after 8s
       *   sh -c 'exec sleep 3600'                  → timed-out in 759ms
       *
       * One process: fine. A process with children: hangs forever. That matters
       * far beyond provider adapters (both of which spawn a single binary):
       * Epic 3 runs project-declared gates through this port, and those are
       * overwhelmingly `npm test` / `pnpm build` / `docker compose up` — whose
       * entire job is to spawn children. A hung gate would hang `specwitness
       * verify` indefinitely instead of failing cleanly, which is precisely the
       * failure the exit-code contract exists to prevent: an infra hang is not
       * a product FAIL, but only if it can be DETECTED.
       *
       * So this port keeps its own promise — it always settles, and it always
       * classifies — by giving execa a grace period past `timeoutMs` and then
       * deciding for itself.
       *
       * WHAT THIS DELIBERATELY DOES NOT DO: reap the orphaned descendants. That
       * needs the child in its own process group and a `kill(-pgid)`, which is
       * AD-8's mechanism and **Epic 3 story 3.2's scope** — the same story that
       * owns the run manifest those orphans get recorded in. Detection here,
       * teardown there. Until 3.2 lands, a forking child that ignores its
       * timeout leaves descendants behind; leaking a process while reporting
       * accurately beats leaking one while hanging forever.
       */
      const settlement = await Promise.race([
        spawned.then((value) => ({ settled: true as const, value })),
        new Promise<{ settled: false }>((resolve) => {
          const timer = setTimeout(
            () => resolve({ settled: false }),
            options.timeoutMs + SETTLEMENT_GRACE_MS,
          );
          // Never hold the event loop open on account of this watchdog.
          timer.unref?.();
        }),
      ]);

      if (!settlement.settled) {
        // The losing promise must not become an unhandled rejection later.
        spawned.catch(() => undefined);
        return {
          outcome: 'timed-out',
          exitCode: null,
          stdout: '',
          stderr:
            `timed out after ${options.timeoutMs}ms and did not exit within ` +
            `${SETTLEMENT_GRACE_MS}ms of being killed; a descendant process is ` +
            'likely still holding its output streams open',
          durationMs: elapsed(),
        };
      }

      const result = settlement.value;
      const fields = result as FailureFields;
      // `?? ''` is not defensive noise: on a spawn failure (ENOENT, ENOTDIR)
      // execa leaves BOTH streams undefined, because there was never a process
      // to produce them. Reading `.length` off them is a TypeError.
      const stdout = result.stdout ?? '';
      const stderr = result.stderr ?? '';

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
      };
    } catch (error) {
      // `reject: false` suppresses both non-zero exits and spawn failures, so
      // this branch should be unreachable in practice. It is kept because
      // "should be unreachable" is not a guarantee across an execa minor, and
      // the alternative is an unclassified crash escaping a port whose whole
      // contract is that it never throws for a subprocess outcome.
      const failure = error as SpawnFailure;

      return {
        outcome: classify({ ...failure, failed: true }, options.cwd, true),
        exitCode: failure.exitCode ?? null,
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? failure.message,
        durationMs: elapsed(),
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
