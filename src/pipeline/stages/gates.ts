/**
 * The `gates` stage — deterministic gates, in order, with early stop (FR-20).
 *
 * ============================================================================
 * THIS IS THE FIRST MODULE IN THE PRODUCT THAT EXECUTES A PROJECT-DECLARED
 * COMMAND. The AD-3 boundary has been theoretical until here; from this file on
 * it is load-bearing at run time.
 * ============================================================================
 *
 * What makes that safe, stated plainly because it is the security core:
 *
 *  - A gate's command is a `DeclaredCommand`, which can only be minted inside
 *    `src/config/` while validating the project's own `.specwitness/config.yaml`.
 *    Nothing here mints one, casts to one, or imports the brand; the only
 *    operation performed is `commandText()`, the sanctioned READ direction.
 *    `tests/unit/config/boundary-scan.test.ts` walks every file under `src/`
 *    outside `src/config/` and rejects all three mechanically — verified red
 *    against a planted probe in this very directory, not assumed.
 *  - The command reaches `ProcessRunner` as a **binary plus an argument array**.
 *    There is no `shell` option anywhere in the port and no `sh -c` on this
 *    path, so `&&`, `$(…)`, `;` and `*` arrive at the child as literal argv
 *    elements. That is what makes it impossible for anything a contract, a
 *    provider or a plan authored to become an executable command.
 *
 * ============================================================================
 * THE CLASSIFICATION TABLE — the whole story, and the whole exit contract
 * ============================================================================
 *
 *   completed + exitCode 0    -> GateResult 'pass'
 *   completed + exitCode != 0 -> GateResult 'fail'  -> product-negative RESULT
 *   not-found                 -> InfraError THROWN  (exit 3)
 *   spawn-failed              -> InfraError THROWN  (exit 3)
 *   timed-out                 -> InfraError THROWN  (exit 3)
 *
 * Two directions, and confusing them is the defect this project treats as
 * first-order:
 *
 *  - A gate that RAN and said no is a PRODUCT failure. It is returned as a
 *    stage result, never thrown (AD-6). A thrown gate failure classifies as
 *    infrastructure and exits 3 — which tells a harness "the environment is
 *    broken, retry", and the retry merges a branch that does not compile.
 *  - A gate that COULD NOT START has not judged the branch at all. It is an
 *    `InfraError` (AD-7) and produces NO `GateResult`. Reporting it as FAIL
 *    would block a mergeable branch, or send a developer hunting a defect that
 *    does not exist. Exit 3 says "fix your environment and rerun"; exit 1 says
 *    "your code is broken". They are not interchangeable.
 *
 * The `switch` below is exhaustive over `ProcessOutcome` with a `never` check.
 * That is not a style preference: a `switch` handling only `completed` would
 * treat a `not-found` gate as "no failure seen", i.e. as a PASS. A fifth arm
 * added to the union upstream must break this file's compilation rather than
 * fall through to silence.
 *
 * **A TIMEOUT IS INFRASTRUCTURE, NOT FAIL — a decision, recorded here because
 * story 3.4's spec required it to be stated and pinned.** A gate that hung
 * tells you nothing about whether the branch is mergeable. Exit 1 would assert
 * "this branch has defects" on no evidence whatever, and would route repair
 * automation at a build that may be perfectly fine. Exit 3 says "SpecWitness
 * could not reach a conclusion", which is exactly what happened. Story 3.2's
 * port deliberately classifies `timed-out` without verdicting it, and says so
 * in its own header, precisely so this call site owns the decision.
 *
 * ============================================================================
 * WHAT THIS STAGE DOES NOT DO
 * ============================================================================
 *
 * It never calls `aggregate()`, never constructs a `RunOutcome`, and never
 * touches an exit code. It records `GateResult`s and `Evidence` on the
 * accumulator; the aggregate stage is AD-6's only converter. It prints nothing —
 * story 3.6 renders. It builds no path beneath the run directory: the full
 * output goes through an injected writer bound to `RunStore.writeEvidenceFile`,
 * which is the sole writer there (AD-8). The run id is bound at composition
 * rather than passed in, so this stage cannot address another run's directory
 * even by mistake.
 *
 * Gates run in the verification worktree, which leaves the operator's workspace
 * and the source repo untouched. That is all "isolated" means here — ADR-004
 * records that the worktree is not sandboxed and not network- or
 * filesystem-restricted, and shares global package caches.
 */

import { commandText, type GateConfig } from '../../config/index.js';
import { InfraError } from '../../domain/errors.js';
import {
  commandEvidence,
  gateEvidence,
  redactText,
  type Evidence,
} from '../../domain/evidence.js';
import type {
  ProcessResult,
  ProcessRunner,
  ProcessRunOptions,
} from '../../domain/process-runner.js';
import type { GateResult, GateStatus } from '../../domain/result.js';
import type { Stage, StageContext, StageResult } from '../stage.js';
import { stageOk, stageProductNegative } from '../stage.js';

import { splitCommandLine, usesUnsupportedEscaping } from './gate-command.js';
import { gateEvidenceRelativePath, type GateOutputStream } from './gate-evidence-path.js';

/**
 * How long a single gate may run before the run is abandoned as inconclusive.
 *
 * Fifteen minutes, chosen rather than guessed. Real gates are `pnpm install` on
 * a cold store, a full type-check and a production build, any of which can take
 * minutes on a large repository or a loaded CI box — and a cap that fires on a
 * healthy build would convert honest work into a spurious exit 3, which is the
 * same wrong answer as any other misclassification.
 *
 * A module constant rather than a config field on purpose: `gateSchema` is
 * `{id, run}` and has no timeout key. Adding one is a change to a schema this
 * story does not own, and a per-gate declared timeout is a sensible follow-up
 * rather than something to smuggle in here. Injectable via `GatesStageDeps` so
 * a test asserts the timeout path in milliseconds instead of waiting it out.
 */
export const GATE_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Writes one evidence file into the run directory and returns its RELATIVE path.
 *
 * Bound by the composition root to `RunStore.writeEvidenceFile` with the run id
 * already applied. The run id is deliberately NOT a parameter: `RunStore` keeps
 * it because it serves every run, this stage drops it because it serves exactly
 * one — so the stage cannot address another run's directory even by mistake.
 */
export interface GateEvidenceWriter {
  (relativeName: string, contents: string): Promise<string>;
}

export interface GatesStageDeps {
  /** The declared gates, in config order. Ids are unique by schema; not re-validated. */
  readonly gates: readonly GateConfig[];
  readonly runner: ProcessRunner;
  readonly writeEvidence: GateEvidenceWriter;
  /** Defaults to `GATE_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** Passed straight to the runner so a gate's process group is recorded durably. */
  readonly onProcessGroup?: (pgid: number) => void | Promise<void>;
}

/** A gate result without the `durationMs` key when the gate never ran. */
function gateResult(gateId: string, status: GateStatus, durationMs?: number): GateResult {
  return durationMs === undefined ? { gateId, status } : { gateId, status, durationMs };
}

/**
 * Persist one stream's FULL output, redacted, and return its relative path.
 *
 * `redactText` rather than the raw string, and this is not belt-and-braces: a
 * file in the run directory IS persistence, and AD-10 requires redaction before
 * any of it. `boundedText` (inside the evidence constructors) redacts the
 * INLINE copy only, so a stage that handed raw bytes to the writer would leave
 * the inline evidence spotless and the file beside it holding the credential
 * verbatim — with the obvious seeded-secret test, which inspects only the
 * evidence, passing green over exactly that hole.
 *
 * Nothing is written for an empty stream: an empty file is an artifact implying
 * output that never existed.
 */
async function persistStream(
  deps: GatesStageDeps,
  gateId: string,
  index: number,
  stream: GateOutputStream,
  raw: string,
): Promise<string | undefined> {
  if (raw === '') {
    return undefined;
  }
  return deps.writeEvidence(gateEvidenceRelativePath(gateId, index, stream), redactText(raw));
}

/** The relative paths of whichever full-output files were written. */
export interface StreamPaths {
  stdoutFullPath?: string;
  stderrFullPath?: string;
}

/** A short, printable reason from an unknown thrown value. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What persisting the two streams produced: whatever landed, and whatever did not. */
interface PersistOutcome {
  readonly paths: StreamPaths;
  /** One reason per stream that could not be written. Empty when all writes landed. */
  readonly failures: readonly string[];
}

/**
 * Persist both streams INDEPENDENTLY, and never throw.
 *
 * `Promise.allSettled` rather than `Promise.all`, and the difference is not
 * academic: with `all`, one stream failing discards the OTHER stream's returned
 * path even though its file was written successfully. On the path where the
 * caller deliberately continues — a gate that failed, whose conclusion must
 * survive a durability problem — that left a real file in the run directory
 * that nothing in the evidence could reach, precisely when the inline copy was
 * truncated and the pointer mattered most.
 *
 * Returning failures instead of throwing keeps the decision with the caller,
 * which is the only place that knows whether a conclusion has already been
 * reached and therefore whether a write failure may be tolerated.
 */
async function persistStreams(
  deps: GatesStageDeps,
  gateId: string,
  index: number,
  result: ProcessResult,
): Promise<PersistOutcome> {
  const settled = await Promise.allSettled([
    persistStream(deps, gateId, index, 'stdout', result.stdout),
    persistStream(deps, gateId, index, 'stderr', result.stderr),
  ]);

  const paths: { stdoutFullPath?: string; stderrFullPath?: string } = {};
  const failures: string[] = [];
  const keys = ['stdoutFullPath', 'stderrFullPath'] as const;

  settled.forEach((outcome, position) => {
    const key = keys[position] as (typeof keys)[number];
    if (outcome.status === 'rejected') {
      failures.push(reasonOf(outcome.reason));
      return;
    }
    if (outcome.value !== undefined) {
      paths[key] = outcome.value;
    }
  });

  return { paths, failures };
}

/**
 * Record what an unstartable gate managed to print, then let the caller throw.
 *
 * `command` evidence, not `gate` evidence, and the distinction is load-bearing:
 * `GateEvidence` carries a `GateStatus`, and a gate that could not be judged has
 * none of `pass` / `fail` / `skipped` truthfully available. Inventing one would
 * put a wrong value in a field aggregation reads. A command was attempted and
 * produced output — `CommandEvidence` says exactly that and no more.
 *
 * Worth keeping at all because story 3.2's runner returns the child's captured
 * output on a timeout rather than an empty string, so a hung gate leaves real
 * diagnostic material. The accumulator survives a thrown stage, so this reaches
 * the report.
 */
async function recordAttempt(
  deps: GatesStageDeps,
  context: StageContext,
  gate: GateConfig,
  index: number,
  result: ProcessResult,
): Promise<void> {
  if (result.stdout === '' && result.stderr === '') {
    return;
  }

  // Write failures are IGNORED here on purpose. This runs on the paths that are
  // about to throw a precise `InfraError` — "gate 'lint' timed out after 400ms",
  // "'pnpm' is not on PATH". Letting a write failure escape would replace that
  // diagnosis with "ENOSPC", which is the same durability-rewrites-a-conclusion
  // mistake the gate path just fixed, one classification over: the outcome would
  // still be exit 3, but the operator would be told the wrong thing about why.
  // The inline evidence still lands, because the constructor performs no I/O.
  const { paths } = await persistStreams(deps, gate.id, index, result);
  const evidence: Evidence = commandEvidence({
    capturedAt: context.clock.now().toISOString(),
    commandId: gate.id,
    displayCommand: commandText(gate.run),
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    ...paths,
  });

  context.run.evidence.push(evidence);
}

/**
 * The diagnosis for a binary the OS could not find — which has two causes, and
 * conflating them is the confidently-wrong answer this project treats as
 * first-order.
 *
 * A bare name (`pnpm`) is looked up on PATH: "it is not installed" is right.
 * A token carrying a separator (`./scripts/check`, `bin/gate`) is not a PATH
 * lookup at all — it names a FILE, resolved relative to the process's working
 * directory, which here is the verification worktree. Telling an operator to
 * install `./scripts/check` would be nonsense, and telling them it is missing
 * from PATH would send them to edit their shell profile over a file that is
 * simply not in the commit under verification.
 *
 * That second case is a real and reachable operator experience, and it is worth
 * naming rather than hiding: `doctor` resolves a relative command against the
 * PROJECT ROOT, because it runs before any worktree exists and structurally
 * cannot do otherwise. Gates run in the worktree, at the head SHA (AD-8) — and
 * must, since spawning in the source repo would verify the wrong tree. So a
 * script that is present but UNTRACKED, or not committed to the revision under
 * verification, passes doctor and then legitimately cannot be executed here.
 * The hint says exactly that, because the useful instruction is "commit it",
 * not "install it".
 */
function notFoundError(gate: GateConfig, binary: string): InfraError {
  // The same test doctor's resolver applies, and for the same reason.
  const namesAFile = binary.includes('/') || binary.includes('\\');

  if (namesAFile) {
    return new InfraError(
      `gate '${gate.id}' could not start: '${binary}' does not exist in the verification worktree`,
      `gates run against the revision under verification, not your working copy — commit ` +
        `'${binary}' (an untracked or uncommitted file will not be there), or correct ` +
        `gates[${gate.id}].run in .specwitness/config.yaml`,
    );
  }

  return new InfraError(
    `gate '${gate.id}' could not start: '${binary}' is not on PATH`,
    `install '${binary}', or correct gates[${gate.id}].run in .specwitness/config.yaml — ` +
      'this is an environment problem, not a failure of the branch under verification',
  );
}

/**
 * Turn one settled spawn into a gate status, or throw.
 *
 * Exhaustive over `ProcessOutcome`. The `never` binding in the default branch is
 * the guard that a fifth outcome cannot silently become "gate passed".
 */
async function classify(
  deps: GatesStageDeps,
  context: StageContext,
  gate: GateConfig,
  index: number,
  result: ProcessResult,
  binary: string,
): Promise<GateStatus> {
  switch (result.outcome) {
    case 'completed':
      return result.exitCode === 0 ? 'pass' : 'fail';

    case 'not-found':
      await recordAttempt(deps, context, gate, index, result);
      throw notFoundError(gate, binary);

    case 'spawn-failed':
      await recordAttempt(deps, context, gate, index, result);
      throw new InfraError(
        // REDACTED before it goes into the message, and this is not belt-and-
        // braces. This is the only error here that embeds CAPTURED OUTPUT, and
        // an error travels further than evidence does: the pipeline redacts
        // timeline details in its recorder, but the same error also reaches
        // `printError` at the CLI edge, which writes ERROR:/HINT: to stderr
        // verbatim. So the persisted copy would be clean while the terminal
        // showed the secret — the same split that made the full-file write a
        // hole, arriving through the error path instead of the evidence path.
        // Redacting at the point untrusted text enters the message closes it
        // wherever the message is later printed.
        `gate '${gate.id}' could not be spawned: ${redactText(result.stderr).trim() || 'the process did not start'}`,
        'check that the verification worktree exists and is readable, then rerun',
      );

    case 'timed-out':
      await recordAttempt(deps, context, gate, index, result);
      throw new InfraError(
        `gate '${gate.id}' timed out after ${deps.timeoutMs ?? GATE_TIMEOUT_MS}ms and was killed`,
        'a gate that hung says nothing about whether the branch is mergeable, so this is ' +
          'reported as an environment problem rather than as a failing build — rerun, or ' +
          'make the gate faster',
      );

    default: {
      // Compile-time exhaustiveness. Adding a `ProcessOutcome` without deciding
      // its classification here is a type error, not a silent pass.
      const unreachable: never = result.outcome;
      throw new InfraError(
        `gate '${gate.id}' returned an unrecognised process outcome: ${String(unreachable)}`,
        'this is a defect in SpecWitness; please report it with the run directory',
      );
    }
  }
}

/**
 * The `gates` stage for a run assembled without a gate runner. IT FAILS CLOSED,
 * and that is the whole reason it exists.
 *
 * An earlier version returned `ok` with an explanatory timeline detail. That is
 * not sufficient, and a review was right to call it a P1: `aggregate()` over an
 * empty gate set returns PASS, so an unwired run produced a **green verdict for
 * a branch on which nothing was checked**. A detail string does not stop a
 * consumer treating the verdict as green — the verdict IS the machine contract,
 * and a harness reads that, not the prose beside it.
 *
 * "Nothing was checked" and "everything passed" are the two states this product
 * exists to keep apart. So this throws: the run is INCONCLUSIVE (exit 3), which
 * is what actually happened, rather than successful.
 *
 * NOT the same as a project that declares no gates. That case belongs to the
 * wired stage, which sees an empty `gates` array and legitimately returns `ok` —
 * nothing was declared, so nothing was expected. This stage cannot tell the two
 * apart, because a composition that omitted the runner also omitted the config,
 * so failing closed is the only safe reading available to it.
 *
 * Reachable only from a composition root that forgot to bind the runner.
 */
export function createUnwiredGatesStage(): Stage {
  return {
    name: 'gates',
    run: async () => {
      throw new InfraError(
        'gates could not run: no gate runner was wired into this verification',
        'this is a SpecWitness defect — bind `gates` when assembling the pipeline. ' +
          'The run is reported as inconclusive rather than passing, because a run in ' +
          'which nothing was checked must never read as a green build',
      );
    },
  };
}

export function createGatesStage(deps: GatesStageDeps): Stage {
  const timeoutMs = deps.timeoutMs ?? GATE_TIMEOUT_MS;

  return {
    name: 'gates',
    run: async (context): Promise<StageResult> => {
      if (deps.gates.length === 0) {
        return stageOk('no gates declared');
      }

      const cwd = context.run.environment.worktreePath;
      if (cwd === null) {
        // Never fall back to the project root: that would verify the wrong tree
        // and could write into the operator's working directory (AD-8).
        throw new InfraError(
          'gates cannot run: no verification worktree was created',
          'this is a SpecWitness defect — the worktree stage must run before gates',
        );
      }

      let failedAt: number | undefined;
      /** Appended to the failure detail when the full output could not be written. */
      let failureNote = '';

      for (const [index, gate] of deps.gates.entries()) {
        if (failedAt !== undefined) {
          // Every gate after the failure is reported, in declaration order. A
          // missing gate and a skipped gate look identical in a report, and
          // only one of them is true.
          context.run.gates.push(gateResult(gate.id, 'skipped'));
          continue;
        }

        const declared = commandText(gate.run);

        // Refused BEFORE spawning, because the alternative is worse than a
        // refusal: a backslash-escaped quote mis-groups, the child gets a
        // corrupted argument, it exits non-zero, and the run reports a product
        // FAIL — a configuration problem blamed on the branch. Exit 3 naming
        // the actual cause is the honest answer, and the fix is one character.
        if (usesUnsupportedEscaping(declared)) {
          throw new InfraError(
            // REDACTED: a declared command can legitimately carry a credential
            // (`curl -H "Authorization: Bearer ..."` is a plausible smoke gate),
            // and this message reaches `printError`, which writes it to stderr
            // verbatim. Same leak the spawn-failed diagnosis already closes.
            `gate '${gate.id}' uses backslash-escaped quotes, which are not supported: ` +
              `'${redactText(declared)}'`,
            'declared commands are executed without a shell, so a backslash is not an escape — ' +
              'use the other quote style instead, as in: -e \'console.log("ok")\'',
          );
        }

        const { binary, args } = splitCommandLine(declared);
        if (binary === '') {
          throw new InfraError(
            `gate '${gate.id}' declares a command with no executable: '${redactText(declared)}'`,
            `set gates[${gate.id}].run in .specwitness/config.yaml to a command starting with a binary`,
          );
        }

        const options: ProcessRunOptions = {
          binary,
          args,
          cwd,
          timeoutMs,
          // Gates are the project's own build commands and need the operator's
          // PATH and toolchain. Constructed whole and passed whole: the runner
          // resolves this with `extendEnv: false`, so nothing is merged back
          // over it. FR-15's withholding is for provider invocations (AD-4),
          // not for a project building itself.
          env: { inherit: true },
          ...(deps.onProcessGroup === undefined ? {} : { onProcessGroup: deps.onProcessGroup }),
        };

        const result = await deps.runner.run(options);
        const status = await classify(deps, context, gate, index, result, binary);

        // THE VERDICT-RELEVANT FACT IS RECORDED FIRST, before anything that can
        // fail. Evidence is corroboration; this is the conclusion.
        //
        // `durationMs` from the runner's own measurement, which uses the
        // injected Clock (AD-9) — never a second clock read here.
        context.run.gates.push(gateResult(gate.id, status, result.durationMs));
        if (status === 'fail') {
          failedAt = index;
        }

        // Once a gate has FAILED the conclusion is established, and a
        // durability failure must not rewrite it — the same rule the pipeline
        // applies to a decided outcome, one level down. Writing evidence before
        // recording the result meant a full disk turned a demonstrable product
        // FAIL into exit 3, which tells a harness "the environment is broken,
        // retry" and the retry merges a branch that will never build. That is
        // the precise accident this story exists to prevent, and it was here.
        //
        // A gate that PASSED is different and deliberately still throws: no
        // conclusion has been reached yet, the run is not owed a verdict, and
        // "we could not record what we observed" is an honest infrastructure
        // failure rather than a green light.
        const persisted = await persistStreams(deps, gate.id, index, result);
        let evidenceNote = '';
        if (persisted.failures.length > 0) {
          if (status !== 'fail') {
            throw new InfraError(
              `gate '${gate.id}' passed but its output could not be written: ` +
                persisted.failures.join('; '),
              'check that the run directory is writable and rerun',
            );
          }
          evidenceNote =
            `; the gate's full output could not be written (${persisted.failures.join('; ')})`;
        }
        const paths = persisted.paths;

        // Pushed even when the file write failed: `gateEvidence` performs no
        // I/O, so the bounded inline output — the part a report actually shows —
        // survives. Only the pointer to the full copy is lost, and its absence
        // is already expressible (`fullPath` is optional).
        context.run.evidence.push(
          gateEvidence({
            capturedAt: context.clock.now().toISOString(),
            gateId: gate.id,
            status,
            exitCode: result.exitCode,
            // RAW on purpose: the constructor redacts and bounds it. Handing it
            // pre-redacted text would double-redact, and handing it a
            // pre-built BoundedText is not possible by design.
            stdout: result.stdout,
            stderr: result.stderr,
            durationMs: result.durationMs,
            ...paths,
          }),
        );

        if (status === 'fail') {
          failureNote = evidenceNote;
        }
      }

      if (failedAt === undefined) {
        return stageOk(`${deps.gates.length} gate(s) passed`);
      }

      // A product-negative RESULT, never a throw (AD-6). The results travel on
      // the accumulator; this arm carries only a human-readable detail, because
      // a stage result carrying a GateResult[] would be a second path into the
      // outcome competing with the aggregate stage.
      const failed = deps.gates[failedAt] as GateConfig;
      return stageProductNegative(
        `gate '${failed.id}' failed; ${deps.gates.length - failedAt - 1} later gate(s) skipped` +
          failureNote,
      );
    },
  };
}
