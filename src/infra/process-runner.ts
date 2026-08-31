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
}

/**
 * Classify one spawn from the failure-shaped fields, wherever they arrive.
 *
 * Verified against the pinned execa 10 rather than assumed: with
 * `reject: false`, a binary that is not on PATH does NOT throw — it RESOLVES to
 * a result carrying `failed: true`, `code: 'ENOENT'` and an undefined
 * `exitCode`. Classifying ENOENT only inside a `catch` therefore never fires,
 * and every missing binary would be reported as a clean `completed` run. That
 * would be a silent, total failure of the "missing vs said no" distinction that
 * UJ-4 and doctor both depend on, so both paths funnel through here.
 */
function classify(fields: FailureFields): ProcessResult['outcome'] {
  if (fields.timedOut === true) {
    return 'timed-out';
  }
  if (fields.code === 'ENOENT') {
    return 'not-found';
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
      const result = await execa(options.binary, [...options.args], {
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

      return {
        outcome: classify(result as FailureFields),
        // `undefined` on a failed spawn; `null` is this port's "never started".
        exitCode: result.exitCode ?? null,
        stdout: result.stdout,
        stderr: result.stderr,
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
        outcome: classify({ ...failure, failed: true }),
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
