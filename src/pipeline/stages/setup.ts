/**
 * The `setup` stage — run the Project Config's `setup.install` command inside the verification
 * worktree, so that gates and probes execute against installed dependencies (story 6.11).
 *
 * ============================================================================
 * WHAT THIS FILE REPLACED, AND WHY THAT MATTERED
 * ============================================================================
 *
 * Until this story the body of this file was
 * `createPlaceholderStage('setup', 'Epic 4 runs the configured install command')` — created by
 * story 3.3 as one of seven deliberate placeholders, excluded from story 3.4's scope, named as
 * Epic 4's to fill, and not filled by Epic 4's seven stories. The result was not a silent green
 * stage: the placeholder recorded `not implemented yet — …` in a timeline that is rendered and
 * persisted, exactly as it was designed to.
 *
 * The defect was one level up. `src/config/schema.ts` ACCEPTS `setup.install`, and
 * `src/cli/doctor/checks/commands-resolvable.ts` RESOLVES it and reports it as fine — so the
 * command whose entire job is pre-flight validation told an operator the key was live while the
 * pipeline never read it. A user who trusted `doctor` got gates run against a worktree in which
 * nothing was installed, and on a typical project `pnpm test` without `node_modules` exits
 * non-zero — which the gates stage correctly classifies as a PRODUCT failure, exit 1.
 *
 * **A missing install reported as the branch being wrong is the exact inversion this product
 * exists to prevent** (CLAUDE.md: *"Infra failures are never reported as product FAIL"*). Hence
 * the shape of this stage: it has no product-negative arm at all.
 *
 * ============================================================================
 * THE CLASSIFICATION TABLE — no product-negative row, deliberately
 * ============================================================================
 *
 *   no deps bound                       -> stageOk  ("nothing was installed", and it says so)
 *   deps bound, no install declared     -> stageOk  (nothing declared, nothing expected)
 *   completed + exitCode 0              -> stageOk
 *   completed + exitCode != 0           -> InfraError THROWN (exit 3)
 *   not-found                           -> InfraError THROWN (exit 3)
 *   timed-out                           -> InfraError THROWN (exit 3)
 *   spawn-failed                        -> InfraError THROWN (exit 3)
 *   a malformed declared command line   -> InfraError THROWN (exit 3)
 *   no worktree, but an install declared-> InfraError THROWN (exit 3)
 *
 * `stageProductNegative` is not imported. That is the mechanism rather than the convention: an
 * install that failed cannot be expressed as a product failure by this file even by mistake, so
 * **there is no path from here to exit 1**. `src/domain/stage.ts` states why the two must not
 * collapse — *"a branch that simply does not build starts reporting as 'the environment is
 * broken, retry', after which a retry merges it"* — and this stage is the mirror image of that
 * sentence: an install that did not happen must never surface as the branch being wrong.
 *
 * ============================================================================
 * AD-3 — THE COMMAND BOUNDARY
 * ============================================================================
 *
 * `setup.install` is a `DeclaredCommand`, mintable only inside `src/config/` while validating the
 * project's own `.specwitness/config.yaml`. Nothing here mints one, casts to one, or imports the
 * brand; the only operation performed is `commandText()`, the sanctioned READ direction
 * (`tests/unit/config/boundary-scan.test.ts` walks every file under `src/` outside `src/config/`
 * and rejects all three mechanically).
 *
 * The command reaches `ProcessRunner` as a **binary plus an argument array**. There is no `shell`
 * option in the port and no `sh -c` on this path, so `&&`, `$(…)`, `;` and `*` arrive at the
 * child as literal argv elements. The split and its three malformed-form refusals are story
 * 3.4's `gate-command.ts`, IMPORTED rather than reimplemented: a second splitter would eventually
 * disagree with `doctor` about which token is the executable, and a second, subtly different
 * command path in this product is a security finding rather than a convenience.
 *
 * ============================================================================
 * WHAT THIS STAGE DOES NOT DO
 * ============================================================================
 *
 * It has no opinion about WHICH install command is right. It does not inspect a lockfile, cache
 * anything, decide whether an install is needed, or vary by ecosystem — the operator declared a
 * command and this runs it. `sh scripts/install.sh` on a project with no `package.json` anywhere
 * is as first-class here as `pnpm install --frozen-lockfile`, and the two corpus fixtures this
 * story ships are deliberately the former.
 *
 * It constructs no adapter (AD-1): the runner and the evidence writer arrive by injection, which
 * is what keeps this file unit-testable with zero I/O. It builds no path beneath the run
 * directory — the evidence name is derived by `gate-evidence-path.ts` and written by an injected
 * writer bound to `RunStore.writeEvidenceFile` (AD-8). The only instant read is the injected
 * `Clock` (AD-9); the duration comes from the runner's own measurement.
 */

import { commandText, type DeclaredCommand } from '../../config/index.js';
import { InfraError } from '../../domain/errors.js';
import { commandEvidence, redactText } from '../../domain/evidence.js';
import type {
  ProcessResult,
  ProcessRunner,
  ProcessRunOptions,
} from '../../domain/process-runner.js';
import type { Stage, StageContext, StageResult } from '../stage.js';
import { stageOk } from '../stage.js';

import {
  hasGluedExecutableSuffix,
  hasUnterminatedQuote,
  splitCommandLine,
  usesUnsupportedEscaping,
} from './gate-command.js';
import { setupEvidenceRelativePath, type GateOutputStream } from './gate-evidence-path.js';

/**
 * The config key this stage executes, spelled once.
 *
 * Used as the evidence `commandId` and in every error message, because it is the identity an
 * operator can search for in their own `.specwitness/config.yaml`. An error naming "the install
 * command" and a run directory naming something else would make the two impossible to line up.
 */
export const SETUP_INSTALL_ID = 'setup.install';

/**
 * The upper bound handed to `ProcessRunner.run()` for the install command.
 *
 * **Ten minutes, chosen rather than guessed, and deliberately between its two neighbours** —
 * `DATA_COMMAND_TIMEOUT_MS` is five (`data.ts`) and `GATE_TIMEOUT_MS` is fifteen (`gates.ts`),
 * because an install sits between the two kinds of work those numbers cap.
 *
 *  - **Longer than a data command's five minutes.** A `data.reset` is local: a schema drop, a
 *    fixture load, no network. An install is network- and disk-bound — resolve, fetch, extract,
 *    then run lifecycle scripts that may compile native addons. A cold, uncached
 *    `pnpm install --frozen-lockfile` on a large monorepo is minutes rather than seconds, and a
 *    cap that fires on a HEALTHY install converts honest work into a spurious exit 3, which is
 *    the same wrong answer as any other misclassification.
 *  - **Shorter than a gate's fifteen.** `gates.ts` chose fifteen *because a real gate is an
 *    install plus a full test run*. An install is the smaller half of that and is one phase
 *    rather than two, so borrowing fifteen would be borrowing a budget sized for work this stage
 *    does not do.
 *  - **And the argument that actually decides it: what an install hang looks like.** The two
 *    common ones — a registry that accepts the connection and never answers, and a package
 *    manager prompting on a TTY that will never arrive (agent-callable commands are prompt-free,
 *    but the operator's own install command need not be) — NEVER resolve. Waiting a quarter of an
 *    hour to say so buys nothing; ten minutes reports it while somebody is still watching.
 *
 * A module constant rather than a config field, for the reason `gates.ts` gives about its own:
 * `setupSchema` is `{install}` and has no timeout key, and adding one is a change to a schema
 * this story does not own. Injectable via `SetupStageDeps.timeoutMs` so a test asserts the
 * timeout path in milliseconds instead of waiting it out.
 */
export const SETUP_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Writes one evidence file into the run directory and returns its RELATIVE path.
 *
 * The same shape as the merged `GateEvidenceWriter` and `DataEvidenceWriter`, deliberately, so
 * the composition root binds one function rather than three. The run id is not a parameter:
 * `RunStore` keeps it because it serves every run, this stage drops it because it serves exactly
 * one — so the stage cannot address another run's directory even by mistake.
 */
export interface SetupEvidenceWriter {
  (relativeName: string, contents: string): Promise<string>;
}

export interface SetupStageDeps {
  /**
   * `config.setup.install`, ABSENT when the project declared none.
   *
   * Optional inside a bound `deps` rather than a separate composition, because "the runner is
   * wired and the project declared no install" and "nothing is wired at all" are different
   * states and a run report must be able to tell an operator which one it was in.
   */
  readonly install?: DeclaredCommand;
  readonly runner: ProcessRunner;
  /**
   * Persists the FULL redacted output of the install. **Optional**, like the data stage's and
   * unlike the gates stage's: an install's captured output corroborates a step that produces no
   * verdict at all, so without a writer the stage still records bounded inline `command`
   * evidence — the evidence constructors perform no I/O — and only the pointer to a full copy is
   * lost, which is already expressible (`stdoutFullPath` is optional).
   */
  readonly writeEvidence?: SetupEvidenceWriter;
  /** Defaults to `SETUP_INSTALL_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /**
   * Passed straight to the runner so the install's process group is recorded durably before the
   * run proceeds. The CLI edge binds `RunStore.recordProcessGroup`, which is what lets
   * `specwitness clean` reap a run killed mid-install — and an install is the single most likely
   * stage to be interrupted, because it is the longest-running thing that happens before anything
   * interesting is on screen.
   */
  readonly onProcessGroup?: (pgid: number) => void | Promise<void>;
}

/**
 * Split the declared install line, refusing the three malformed forms BEFORE spawning.
 *
 * The reasoning is `gates.ts`'s and `data.ts`'s verbatim, because the hazard is identical: a
 * mis-grouped argument makes the child fail for a reason that has nothing to do with the branch.
 * Here it is worse than for a gate — a mis-grouped install fails, the gates then run against an
 * uninstalled tree, and the operator is shown a failing test suite rather than a broken config
 * line.
 *
 * The declared command is REDACTED in every message: an install command can legitimately carry a
 * credential (a private registry token in `--registry https://user:pass@…` is ordinary), and
 * these messages reach `printError`, which writes them to stderr verbatim. Redacted with
 * `{shellCommand: true}` — and only here — because this string IS a declared command line, which
 * is precisely the context that option is reserved for.
 */
function splitDeclared(command: DeclaredCommand): { binary: string; args: string[] } {
  const declared = commandText(command);
  const shown = (): string => redactText(declared, { shellCommand: true });

  if (usesUnsupportedEscaping(declared)) {
    throw new InfraError(
      `the install command uses backslash-escaped quotes, which are not supported: '${shown()}'`,
      `declared commands are executed without a shell, so a backslash before a quote is ` +
        `ambiguous and is refused rather than guessed at. Use the other quote style in ` +
        `${SETUP_INSTALL_ID} in .specwitness/config.yaml`,
    );
  }

  if (hasUnterminatedQuote(declared)) {
    throw new InfraError(
      `the install command has an unterminated quote: '${shown()}'`,
      `close the quote in ${SETUP_INSTALL_ID} in .specwitness/config.yaml — declared commands ` +
        'are split into a binary and arguments without a shell, so an unclosed quote would ' +
        'silently become several arguments rather than one',
    );
  }

  if (hasGluedExecutableSuffix(declared)) {
    throw new InfraError(
      `the install command has text attached to its quoted executable: '${shown()}'`,
      `separate them with a space in ${SETUP_INSTALL_ID}, or quote the whole path — as written ` +
        'this would run the quoted binary and pass the rest as an argument, which may not be ' +
        'the command you intended',
    );
  }

  const { binary, args } = splitCommandLine(declared);
  if (binary === '') {
    throw new InfraError(
      `the install command declares no executable: '${shown()}'`,
      `set ${SETUP_INSTALL_ID} in .specwitness/config.yaml to a command starting with a binary`,
    );
  }

  return { binary, args: [...args] };
}

/**
 * Persist one stream's FULL output, redacted, and return its relative path.
 *
 * `redactText` rather than the raw string, and this is not belt-and-braces: a file in the run
 * directory IS persistence, and AD-10 requires redaction before any of it. `boundedText` (inside
 * the evidence constructor) redacts the INLINE copy only, so a stage that handed raw bytes to the
 * writer would leave the inline evidence spotless and the file beside it holding the credential
 * verbatim — with the obvious seeded-secret test, which inspects only the evidence, passing green
 * over exactly that hole. An install log is a plausible place for one: package managers echo
 * registry URLs, and a private registry URL is where a token lives.
 *
 * Redacted UNDECLARED — without `{shellCommand: true}` — because this is CAPTURE OUTPUT, text a
 * command emitted rather than text the project owner wrote. That option is `redactText`'s
 * fail-open direction and is reserved for declared command lines.
 *
 * Nothing is written for an empty stream: an empty file is an artifact implying output that never
 * existed.
 */
async function persistStream(
  deps: SetupStageDeps,
  stream: GateOutputStream,
  raw: string,
): Promise<string | undefined> {
  if (raw === '' || deps.writeEvidence === undefined) {
    return undefined;
  }
  return await deps.writeEvidence(setupEvidenceRelativePath(stream), redactText(raw));
}

/** The relative paths of whichever full-output files were written. */
interface StreamPaths {
  stdoutFullPath?: string;
  stderrFullPath?: string;
}

/**
 * Persist both streams INDEPENDENTLY, and never throw.
 *
 * `Promise.allSettled` rather than `Promise.all`, for the reason `gates.ts` records: with `all`,
 * one stream failing discards the OTHER stream's returned path even though its file was written
 * successfully, leaving a real file in the run directory that nothing in the evidence can reach.
 *
 * Swallowing write failures is correct HERE specifically, and it is narrower than it looks. Every
 * path in this stage either succeeds — in which case a lost full-output pointer costs an operator
 * one file, and the bounded inline copy still lands — or is about to throw a precise `InfraError`
 * naming the real cause ("the install command failed with exit code 1"). Letting an ENOSPC escape
 * would REPLACE that diagnosis with a storage error: the outcome would still be exit 3, but the
 * operator would be told the wrong thing about why. Unlike gates, this stage has no verdict to
 * protect, so it never needs to escalate a write failure into an error of its own.
 */
async function persistStreams(deps: SetupStageDeps, result: ProcessResult): Promise<StreamPaths> {
  const settled = await Promise.allSettled([
    persistStream(deps, 'stdout', result.stdout),
    persistStream(deps, 'stderr', result.stderr),
  ]);

  const paths: StreamPaths = {};
  const keys = ['stdoutFullPath', 'stderrFullPath'] as const;

  settled.forEach((outcome, position) => {
    if (outcome.status === 'fulfilled' && outcome.value !== undefined) {
      paths[keys[position] as (typeof keys)[number]] = outcome.value;
    }
  });

  return paths;
}

/**
 * Record what the install produced, whatever its outcome.
 *
 * `command` evidence via the merged constructor — never hand-built, and never a new evidence
 * kind: `EVIDENCE_KINDS` is closed and widening it is an ADR. `commandId` is `setup.install`, the
 * config key verbatim, which is the identity an operator reads in their own file.
 *
 * Called on the success path AND before every throw, because a failing install is exactly the
 * command whose output an operator needs. The accumulator survives a thrown stage, so it reaches
 * the report — and story 3.2's runner returns the child's captured output on a TIMEOUT rather
 * than an empty string, so even a hung install leaves real diagnostic material.
 */
async function record(
  deps: SetupStageDeps,
  context: StageContext,
  command: DeclaredCommand,
  result: ProcessResult,
): Promise<void> {
  const paths = await persistStreams(deps, result);

  context.run.evidence.push(
    commandEvidence({
      capturedAt: context.clock.now().toISOString(),
      commandId: SETUP_INSTALL_ID,
      displayCommand: commandText(command),
      exitCode: result.exitCode,
      // Passed RAW and UNDECLARED: `boundedText` inside the constructor redacts capture output
      // with the fail-closed default AND caps it at a byte budget, which is what keeps an install
      // log — the largest output any stage in this pipeline produces — out of `result.json`. The
      // full copy is a separate file, pointed at by `stdoutFullPath` / `stderrFullPath`.
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      ...paths,
    }),
  );
}

/**
 * The diagnosis for a binary the OS could not find.
 *
 * Two causes, and conflating them is the confidently-wrong answer this project treats as
 * first-order — the same split `gates.ts` and `data.ts` make. A bare name (`pnpm`) is a PATH
 * lookup, so "it is not installed" is right. A token carrying a separator
 * (`./scripts/install.sh`) names a FILE resolved relative to the verification worktree, so
 * telling an operator to install it would be nonsense, and telling them to fix their PATH would
 * send them to edit a shell profile over a file that is simply not in the commit under
 * verification.
 *
 * That second case is genuinely reachable and worth naming: `doctor` resolves a relative command
 * against the PROJECT ROOT, because it runs before any worktree exists. The install runs in the
 * worktree at the head SHA (AD-8). So a script that is present but UNTRACKED passes `doctor` and
 * legitimately cannot be executed here, and the useful instruction is "commit it".
 *
 * ⚠️ **THE BINARY IS REDACTED, AND THIS ARM IS THE ONE THAT NEEDS IT MOST.** Found by review, and
 * the route is not obvious: the executable token is not always a program name. Under AD-3 there
 * is no shell, so a plausible-but-unsupported declaration like
 * `NPM_TOKEN=s3cr3t pnpm install` — the shape a developer reaches for when a private registry
 * needs a token — tokenizes with `NPM_TOKEN=s3cr3t` AS THE EXECUTABLE. Nothing on PATH is called
 * that, so it lands here, and an unredacted message would print the credential to the terminal
 * and into the timeline detail. The failure is a config mistake, so it is exactly the message an
 * operator will paste into an issue.
 *
 * Redacted with `{shellCommand: true}` because this token is DECLARED text the project owner
 * wrote, which is the context that option is reserved for. Verified: `redactText` reduces the
 * example above to `NPM_TOKEN=[REDACTED]`.
 *
 * **The same latent hole exists in the merged `gates.ts` and `data.ts`**, whose `notFoundError`
 * functions interpolate their binary unredacted. Neither is this story's file to change, and it
 * is reported to the owner in this story's PR body instead — the precedent `data.ts` set when it
 * found the identical ordering defect in `services.ts`.
 */
function notFoundError(binary: string): InfraError {
  const namesAFile = binary.includes('/') || binary.includes('\\');
  const shown = redactText(binary, { shellCommand: true });

  return namesAFile
    ? new InfraError(
        `the install command could not run: '${shown}' does not exist in the verification worktree`,
        `the install runs against the revision under verification, not your working copy — ` +
          `commit '${shown}' (an untracked or uncommitted file will not be there), or correct ` +
          `${SETUP_INSTALL_ID} in .specwitness/config.yaml`,
      )
    : new InfraError(
        `the install command could not run: '${shown}' is not on PATH`,
        `install '${shown}', or correct ${SETUP_INSTALL_ID} in .specwitness/config.yaml — this ` +
          'is an environment problem, not a failure of the branch under verification',
      );
}

/**
 * Turn one settled spawn into "continue", or throw.
 *
 * Exhaustive over `ProcessOutcome`, with a `never` binding in the default branch. That is not a
 * style preference: a `switch` handling only `completed` would treat a missing binary as "no
 * failure seen", i.e. as a successful install — after which the gates run against an uninstalled
 * tree and the operator is shown a failing test suite. A fifth arm added to the union upstream
 * must break this file's compilation rather than fall through to silence.
 *
 * Note the shape of the `completed` arm: unlike the gates stage there is no `fail` result here,
 * because there is no product-negative row in this table at all.
 *
 * **EVERY ARM NAMES BOTH THE COMMAND AND THE CONFIG KEY** (AC3). That is not decoration and it
 * was a review finding: the timeout and spawn-failure arms originally said only "the install
 * command", which leaves an operator holding an exit 3 and no pointer to the line they have to
 * change. Unlike a gate, there is exactly one install per run and it is identified by a key
 * rather than by an id the operator chose, so if the diagnostic does not spell out
 * `setup.install` nothing else in the message does.
 */
async function classify(
  deps: SetupStageDeps,
  context: StageContext,
  command: DeclaredCommand,
  result: ProcessResult,
  binary: string,
): Promise<void> {
  // Recorded FIRST, on every path: a failing install is exactly the command whose output an
  // operator needs, and every arm below except one throws.
  await record(deps, context, command, result);

  // The declared command line, safe to print. Redacted with `{shellCommand: true}` because this
  // IS declared text — the project owner wrote it — and it can legitimately carry a
  // private-registry credential. Every message below reaches `printError`, which writes
  // ERROR:/HINT: to stderr verbatim, so redacting where the text enters the message closes the
  // leak wherever the message is later printed.
  const shown = redactText(commandText(command), { shellCommand: true });
  /** The remedy every arm ends with: the one line an operator has to look at. */
  const inspect = `check ${SETUP_INSTALL_ID} in .specwitness/config.yaml`;

  switch (result.outcome) {
    case 'completed':
      if (result.exitCode === 0) {
        return;
      }
      throw new InfraError(
        `the install command '${shown}' failed with exit code ${String(result.exitCode)}`,
        `SpecWitness could not install the project's dependencies, which says nothing about ` +
          'whether the branch satisfies its contract — so this is reported as an environment ' +
          'problem rather than as a failing build. Check the command output in the run ' +
          `directory, then fix ${SETUP_INSTALL_ID} in .specwitness/config.yaml or the ` +
          'environment, and rerun',
      );

    case 'not-found':
      throw notFoundError(binary);

    case 'timed-out':
      throw new InfraError(
        `the install command '${shown}' timed out after ` +
          `${String(deps.timeoutMs ?? SETUP_INSTALL_TIMEOUT_MS)}ms and was killed`,
        'an install that hung says nothing about whether the branch is mergeable, so this is ' +
          'reported as an environment problem rather than as a failing build — an unreachable ' +
          `registry, or a package manager waiting on a prompt, are the usual causes. ${inspect}, ` +
          'then rerun',
      );

    case 'spawn-failed':
      throw new InfraError(
        // The captured stderr is REDACTED before it goes into the message, undeclared. This is
        // the only error here that embeds CAPTURED OUTPUT, and an error travels further than
        // evidence does: the pipeline redacts timeline details in its recorder, but the same
        // error also reaches `printError` at the CLI edge, which writes ERROR:/HINT: to stderr
        // verbatim. So the persisted copy would be clean while the terminal showed the secret.
        `the install command '${shown}' could not be spawned: ` +
          `${redactText(result.stderr).trim() || 'the process did not start'}`,
        `check that the verification worktree exists and is readable, and ${inspect}, then rerun`,
      );

    default: {
      // Compile-time exhaustiveness. Adding a `ProcessOutcome` without deciding its
      // classification here is a type error, not a silent success.
      const unreachable: never = result.outcome;
      throw new InfraError(
        `the install command '${shown}' returned an unrecognised process outcome: ${String(unreachable)}`,
        'this is a defect in SpecWitness; please report it with the run directory',
      );
    }
  }
}

/**
 * The `setup` stage: run the project's declared install command in the verification worktree.
 *
 * @param deps omitted by a composition that binds no runner. The stage then installs nothing and
 * SAYS SO in its timeline, rather than the fail-closed refusal `gates` uses. The asymmetry is the
 * one `services` and `data` already have and it is stated in `stages/index.ts`: an empty gate set
 * aggregates to PASS, so an unwired gates run reads as a green build, whereas this stage
 * adjudicates nothing and produces no `GateResult` and no criterion, so it cannot manufacture a
 * verdict on its own. `src/cli/commands/verify.ts` binds this unconditionally for a real run.
 */
export function createSetupStage(deps?: SetupStageDeps): Stage {
  return {
    name: 'setup',
    run: async (context): Promise<StageResult> => {
      if (deps === undefined) {
        return stageOk('no install runner was wired into this verification; nothing was installed');
      }

      const command = deps.install;
      if (command === undefined) {
        // AC2. Nothing is spawned, no evidence is pushed, and the run's outcome is exactly what
        // it would have been before this story existed. The detail changes — the placeholder used
        // to say "not implemented yet", and a stage that IS implemented must not keep claiming
        // otherwise.
        return stageOk('no install command declared');
      }

      // Refused BEFORE the worktree check and before anything is spawned: a malformed declaration
      // is a config problem this stage must not attempt to execute at all.
      const { binary, args } = splitDeclared(command);

      const cwd = context.run.environment.worktreePath;
      if (cwd === null) {
        // NEVER fall back to the project root, and the stakes here are the data stage's rather
        // than the gates stage's. `pnpm install` in the operator's own working directory does not
        // merely verify the wrong tree — it REWRITES that tree's `node_modules` and can rewrite
        // its lockfile (AD-8, FR-19). Fail closed, then explain.
        throw new InfraError(
          'the install command cannot run: no verification worktree was created',
          'this is a SpecWitness defect — the worktree stage must run before setup. Running an ' +
            "install in the project root could modify your working tree's dependencies, so " +
            'nothing was run',
        );
      }

      const options: ProcessRunOptions = {
        binary,
        args,
        cwd,
        timeoutMs: deps.timeoutMs ?? SETUP_INSTALL_TIMEOUT_MS,
        // The install is the project's own setup command and needs the operator's PATH and
        // toolchain — a package manager that cannot find its own node is not a test of anything.
        // Constructed whole and passed whole: the runner resolves this with `extendEnv: false`,
        // so nothing is merged back over it. FR-15's withholding is for provider invocations
        // (AD-4), not for a project installing its own dependencies.
        env: { inherit: true },
        ...(deps.onProcessGroup === undefined ? {} : { onProcessGroup: deps.onProcessGroup }),
      };

      const result = await deps.runner.run(options);
      // Throws on every outcome but a clean exit.
      await classify(deps, context, command, result, binary);

      // AC1: the command, its exit code and its duration, on the timeline entry that is both
      // rendered and persisted (AD-11). The declared text is redacted as declared text before it
      // goes in; `runPipeline` redacts the detail again as capture, which is the fail-closed
      // direction and costs nothing.
      //
      // `result.durationMs` is the RUNNER's own measurement of the child, taken with the injected
      // Clock (AD-9) — deliberately not the stage's own duration, which the timeline column
      // already carries and which includes writing the evidence files.
      return stageOk(
        `installed with '${redactText(commandText(command), { shellCommand: true })}' ` +
          `(exit code ${String(result.exitCode)} in ${String(result.durationMs)}ms)`,
      );
    },
  };
}
