/**
 * AD-3 / AD-4 — the subprocess seam.
 *
 * SpecWitness spawns two kinds of thing, and this port is for exactly one of
 * them: its own trusted tooling, by fixed binary name and fixed argument array
 * (`claude`, `codex` — the same footing as `git` in
 * `src/cli/doctor/effects.ts`). Project-declared commands are the other kind;
 * they carry the `DeclaredCommand` brand, are minted only inside
 * `src/config/`, and are not what this port is for. Provider binaries are
 * deliberately NOT `DeclaredCommand`s: that brand exists to constrain
 * project-declared SHELL STRINGS, and there is no shell here to constrain.
 * Do not mint one, do not import the brand, and do not add an escape hatch to
 * `src/config/` — `tests/unit/config/boundary-scan.test.ts` rejects both
 * mechanically.
 *
 * The AD-3 property that matters: `run` takes `(binary, args[])`, never a
 * command line. There is no `shell` option and no way to add one without
 * changing this file. That is what makes it impossible for provider output —
 * text a model wrote — to become an executable command.
 *
 * OWNERSHIP, so the next reader finds an invitation rather than a surprise:
 * Epic 3 story 3.2 owns the LIFECYCLE half of the process runner — process
 * groups (pgid), the run manifest, teardown discipline and `specwitness clean`.
 * This story (Epic 2 story 2.3) creates the port and its execa implementation
 * MINIMALLY, because stories 2.4 and 2.5 cannot ship without a way to spawn a
 * binary and blocking Epic 2 on Epic 3 was not an option. 3.2 extends what is
 * here; it does not replace it. `ProcessRunOptions` is a single options object
 * precisely so that extension is additive — the same lesson `DoctorContext`
 * records. Every method added now is a method 3.2 must preserve, so there is
 * exactly one.
 *
 * INTERFACES ONLY. This module imports nothing (AD-1); the execa implementation
 * is `src/infra/process-runner.ts`.
 */

/**
 * The child's environment, CONSTRUCTED BY THE CALLER AND PASSED WHOLE.
 *
 * The implementation resolves this object and hands the result to execa with
 * `extendEnv: false`, always. What this resolves to IS the child's entire
 * environment; nothing is merged on top of it afterwards. That distinction is
 * load-bearing rather than pedantic — execa's `extendEnv` defaults to TRUE, so
 * a runner that forgot to disable it would silently merge `process.env` back
 * over a caller's careful omissions and defeat the billing guarantee entirely.
 *
 * Resolution order:
 *   1. base = `inherit ? {...process.env} : {}`
 *   2. delete every name in `withhold`
 *   3. apply `set`
 *
 * `withhold` is applied BEFORE `set`, so a name that is both withheld and set
 * ends up SET — the caller asked for that value explicitly. Withholding a name
 * that is absent is a no-op, not an error.
 *
 * AD-4 / FR-15: this is how a `subscription` or `chatgpt` mode invocation keeps
 * a billing-risk variable away from the child —
 * `{inherit: true, withhold: ['ANTHROPIC_API_KEY']}`. The parent environment is
 * NEVER mutated, and neither is the object the caller passed.
 */
export interface ChildEnvironment {
  /** `true` = start from the parent environment; `false` = start from nothing. */
  readonly inherit: boolean;
  /** Names removed from the resolved base. Case-sensitive. Applied before `set`. */
  readonly withhold?: readonly string[];
  /** Names set explicitly. Applied last, so these win. */
  readonly set?: Readonly<Record<string, string>>;
}

/**
 * How the subprocess ended.
 *
 * These four are kept distinct because doctor renders them differently and a
 * diagnostic that cannot tell "you have not installed it" from "it said no" is
 * worse than none. They map onto the vocabulary `src/cli/doctor/checks/git.ts`
 * already uses: missing / hung / said no.
 */
export type ProcessOutcome =
  /** Ran to completion. `exitCode` may still be non-zero — "it said no". */
  | 'completed'
  /** Killed after `timeoutMs` — "it hung". */
  | 'timed-out'
  /** ENOENT: the binary is not on PATH — "it is missing". */
  | 'not-found'
  /** The process could not be started for some other reason. */
  | 'spawn-failed';

/**
 * The outcome of one spawn.
 *
 * `run` NEVER rejects for any of these — not ENOENT, not a timeout, not a
 * non-zero exit. A missing agent CLI is a normal project state (UJ-4: contract
 * generation is unavailable, execution of existing plans still works), so it
 * must be expressible as a value that a doctor check can warn about while
 * leaving the exit code at 0. Had ENOENT been an exception, every caller would
 * need a `catch` merely to avoid turning a normal state into a diagnosis.
 */
export interface ProcessResult {
  readonly outcome: ProcessOutcome;
  /** `null` when the process was killed or never started. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Integer milliseconds, from the injected `Clock` (AD-9). */
  readonly durationMs: number;
  /**
   * The child's process-group id, or `null` when no child ever started
   * (`not-found`, `spawn-failed`).
   *
   * Equal to the child's pid: the implementation spawns detached, which makes
   * the child the LEADER of a new group, and a group leader's pgid is its own
   * pid. Reported so a caller can record it durably (see `onProcessGroup`) and
   * so `specwitness clean` has something to replay after a crash.
   *
   * Added by story 3.2. The real runner ALWAYS sets it — every child it spawns
   * is in its own process group, with no flag for a caller to remember, because
   * a gate that silently missed one leaks descendants and nothing fails until
   * somebody finds stray processes weeks later.
   *
   * OPTIONAL for one reason only, and it is not stylistic: the merged provider
   * tests build `ProcessResult` literals by hand, and a REQUIRED field here
   * would stop them compiling — i.e. it would force edits to exactly the tests
   * the additive contract exists to protect. `undefined` therefore means "this
   * result was constructed by a fake", never "the runner forgot".
   */
  readonly pgid?: number | null;
}

/**
 * ONE options object, never positional arguments — so Epic 3 story 3.2 can add
 * its lifecycle fields without breaking any call site written this epic.
 */
export interface ProcessRunOptions {
  /** A fixed binary name (`codex`) or absolute path. NEVER a command line. */
  readonly binary: string;
  /**
   * Passed verbatim to the child. No shell, so no element is ever word-split,
   * glob-expanded or command-substituted: `$(rm -rf /)` is one literal argument.
   */
  readonly args: readonly string[];
  readonly cwd: string;
  /**
   * Required, with no default and no ambient fallback, so an unbounded spawn is
   * not expressible. Doctor runs on machines that are already unwell; a
   * diagnostic that hangs is worse than one that reports a hang.
   */
  readonly timeoutMs: number;
  readonly env: ChildEnvironment;
  /**
   * Written to the child's stdin. Defaults to `''` — prompt-free by contract, so
   * a child waiting on input fails fast rather than hanging until the timeout.
   */
  readonly input?: string;
  /**
   * Called with the child's process-group id as soon as it is known, and
   * AWAITED before the child's outcome is observed (story 3.2, AD-8).
   *
   * This is where AC1's durability ordering lives: `RunStore.recordProcessGroup`
   * writes and fsyncs the pgid, and only once that has resolved does the run
   * proceed. Batching the record to the end would leave a `kill -9` window in
   * which a live process group exists that nothing on disk can find — the one
   * state `specwitness clean` cannot recover from.
   *
   * If it REJECTS, the implementation kills the group and then propagates the
   * error. That is deliberate and is not a violation of "run never rejects":
   * that contract is about SUBPROCESS outcomes (ENOENT, a timeout, a non-zero
   * exit), all of which remain values. A failure to record durably is a
   * SpecWitness infrastructure failure — exit 3 — and swallowing it would leave
   * behind exactly the untrackable process group the record exists to prevent.
   *
   * Optional. A caller that omits it still gets a process group and still gets
   * group teardown on timeout; it simply keeps no record of the pgid.
   */
  readonly onProcessGroup?: (pgid: number) => void | Promise<void>;
  /**
   * Milliseconds between SIGTERM and SIGKILL when this port tears a process
   * group down. Defaults to the implementation's `TEARDOWN_GRACE_MS`.
   *
   * Injectable so a test can prove the escalation in milliseconds instead of
   * waiting out a production-sized grace period — an escalation nobody can
   * afford to assert is an escalation nobody has asserted.
   */
  readonly teardownGraceMs?: number;
}

/**
 * EXACTLY ONE METHOD, still — story 3.2 preserved it deliberately.
 *
 * The OWNERSHIP block above says every method added is a method 3.2 must
 * preserve, "so there is exactly one". 3.2 needed a teardown entry point for
 * long-lived services (Epic 4) and did NOT put it here: a second required
 * method would break every `ProcessRunner` fake in `tests/`, i.e. it would
 * force edits to the very tests the additive contract exists to protect.
 * Teardown is exported as a free function, `terminateProcessGroup`, from
 * `src/infra/process-runner.ts`. `run` tears its own group down on timeout, so
 * an ordinary caller needs nothing extra.
 *
 * AD-6/AD-7, stated here so no later story misreads it: this port CLASSIFIES,
 * it never verdicts. `timed-out` is a `ProcessOutcome`, not a product FAIL.
 * What a timeout MEANS is the caller's decision and differs by context — a
 * provider adapter's timeout is a `ProviderError`, a gate command's timeout is
 * story 3.4's call, a service readiness timeout is Epic 4's. The only promise
 * made here is that the outcome is always classified and never a hang.
 */
export interface ProcessRunner {
  run(options: ProcessRunOptions): Promise<ProcessResult>;
}
