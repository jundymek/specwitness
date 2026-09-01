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

import { splitCommandLine } from './gate-command.js';
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

/** `{stdoutFullPath, stderrFullPath}`, each key present only when a file was written. */
async function persistStreams(
  deps: GatesStageDeps,
  gateId: string,
  index: number,
  result: ProcessResult,
): Promise<{ stdoutFullPath?: string; stderrFullPath?: string }> {
  const [stdoutFullPath, stderrFullPath] = await Promise.all([
    persistStream(deps, gateId, index, 'stdout', result.stdout),
    persistStream(deps, gateId, index, 'stderr', result.stderr),
  ]);

  return {
    ...(stdoutFullPath === undefined ? {} : { stdoutFullPath }),
    ...(stderrFullPath === undefined ? {} : { stderrFullPath }),
  };
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

  const paths = await persistStreams(deps, gate.id, index, result);
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
      throw new InfraError(
        `gate '${gate.id}' could not start: '${binary}' is not on PATH`,
        `install '${binary}', or correct gates[${gate.id}].run in .specwitness/config.yaml — ` +
          'this is an environment problem, not a failure of the branch under verification',
      );

    case 'spawn-failed':
      await recordAttempt(deps, context, gate, index, result);
      throw new InfraError(
        `gate '${gate.id}' could not be spawned: ${result.stderr.trim() || 'the process did not start'}`,
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
 * The `gates` stage for a run that was assembled without a gate runner.
 *
 * Deliberately NOT `createPlaceholderStage`: that renders "not implemented yet",
 * which stopped being true when this file was written. An unwired run must say
 * what actually happened — no gates ran, and not because none are declared —
 * because the one thing a gates stage must never do is let a run in which
 * nothing was checked read like a green build.
 *
 * Reachable only until the CLI edge (story 3.7) binds the runner. Kept here
 * rather than in `stages/index.ts` so that assembling a pipeline stays a matter
 * of choosing between two stages this story owns.
 */
export function createUnwiredGatesStage(): Stage {
  return {
    name: 'gates',
    run: async () =>
      stageOk('no gate runner was wired into this run, so story 3.4 executed no gates'),
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

      for (const [index, gate] of deps.gates.entries()) {
        if (failedAt !== undefined) {
          // Every gate after the failure is reported, in declaration order. A
          // missing gate and a skipped gate look identical in a report, and
          // only one of them is true.
          context.run.gates.push(gateResult(gate.id, 'skipped'));
          continue;
        }

        const { binary, args } = splitCommandLine(commandText(gate.run));
        if (binary === '') {
          throw new InfraError(
            `gate '${gate.id}' declares a command with no executable: '${commandText(gate.run)}'`,
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

        const paths = await persistStreams(deps, gate.id, index, result);
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

        // `durationMs` from the runner's own measurement, which uses the
        // injected Clock (AD-9) — never a second clock read here.
        context.run.gates.push(gateResult(gate.id, status, result.durationMs));

        if (status === 'fail') {
          failedAt = index;
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
        `gate '${failed.id}' failed; ${deps.gates.length - failedAt - 1} later gate(s) skipped`,
      );
    },
  };
}
