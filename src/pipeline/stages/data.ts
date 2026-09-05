/**
 * The `data` stage — establish the preconditions for verification, deterministically
 * (FR-17, AD-9, AD-8, Q14, Q15, Q36). Story 4.3.
 *
 * ============================================================================
 * TWO JOBS, AND BOTH OF THEM ARE NEGATIVES.
 * ============================================================================
 *
 * **1. NOTHING HERE INVENTS A VALUE.** The scenario inputs a probe uses were resolved at plan
 * COMPILE time and stored in the plan; `src/domain/plan-data.ts` reads them back and this stage
 * constructs none of them. That module is the story's centre of gravity and this file is its
 * other half: it runs the project's declared `data.*` commands so that the fixed values the plan
 * carries mean the same thing on every run. Determinism is not only "the same inputs" — it is the
 * same inputs against the same starting state, which is what a `reset` command is for.
 *
 * **2. A DATA FAILURE IS INFRASTRUCTURE, NEVER A PRODUCT FAIL.** This is the third of the epic's
 * three "infra, never FAIL" stages and its classification table has no product-negative row:
 *
 *     every declared command completed with exit 0   -> stageOk
 *     a data command exited non-zero                 -> InfraError THROWN (exit 3)
 *     a data command's binary was not found          -> InfraError THROWN (exit 3)
 *     a data command timed out                       -> InfraError THROWN (exit 3)
 *     a data command could not be spawned            -> InfraError THROWN (exit 3)
 *     a malformed declared command line              -> InfraError THROWN (exit 3)
 *     no worktree, but data commands are declared    -> InfraError THROWN (exit 3)
 *
 * A `data.reset` that fails has told you NOTHING about the branch — the application may be
 * perfect. Exit 1 would assert "this branch has defects" on no evidence at all: it blocks a
 * mergeable branch, or sends a developer hunting a bug that does not exist, or tells repair
 * automation to go and fix code that is fine. Exit 3 says "SpecWitness could not reach a
 * conclusion", which is exactly what happened. So this stage never returns
 * `stageProductNegative`, never pushes a `GateResult`, and never writes `context.run.outcome` —
 * `aggregate()` is AD-6's only converter. The gates and services stages state the identical rule
 * for their own cases; this file follows them deliberately rather than inventing a third shape.
 *
 * ============================================================================
 * DECISIONS THIS FILE OWNS, stated here so nobody re-litigates them from prose
 * ============================================================================
 *
 * **EXECUTION ORDER RELIES ON OBJECT INSERTION ORDER, AND IS PINNED BY A TEST.** `config.data` is
 * `z.record(nonEmptyString, declaredCommand())` — a MAP, not an array. `gates` is `z.array(...)`
 * and is ordered by construction; data commands are not. In practice `yaml` + zod preserve JS
 * object insertion order for string keys, so `Object.keys(deps.data)` does yield declaration
 * order — but that is an emergent property of two libraries, not a guarantee the schema makes.
 * Rather than change a schema this story does not own (story 1.3's file), the reliance is made
 * explicit here and pinned by an integration test that loads a REAL multi-command YAML through
 * `loadConfig` and asserts the observed execution order equals the file order. **This is 4.1's
 * merged answer for `config.services`, matched deliberately** — the same problem deserves one
 * convention, not two.
 *
 * **EXECUTION STOPS AT THE FIRST FAILURE**, unlike gates, which continue so a report can show
 * every failing gate at once. The difference is causal: gates are independent observations, but
 * data commands are a SEQUENCE that establishes a state — running `seed` after `reset` failed
 * would seed a tree in an unknown condition, and the second failure's diagnosis would describe a
 * situation the first failure created. The first failure is the one worth reporting.
 *
 * **AN UNWIRED DATA STAGE IS A NO-OP THAT SAYS SO, NOT A REFUSAL** — 4.1's services reasoning,
 * deliberately NOT 3.4's gates reasoning. `createUnwiredGatesStage` must throw because
 * `aggregate()` over an empty gate set returns PASS, so an unwired gates run produced a green
 * verdict for a branch on which nothing was checked. Data commands adjudicate nothing: no verdict
 * is derived from them, so an unwired data stage cannot manufacture a false green on its own. The
 * CLI edge binds this in story 4.7; until then `verify` must keep working, and a throw here would
 * break every run on the epic branch for a stage nobody has wired yet.
 *
 * **THE `cwd === null` REFUSAL MATTERS MORE HERE THAN ANYWHERE ELSE IN THE EPIC.** Gates and
 * services refuse to fall back to the project root because it would verify the wrong tree. A
 * `data.reset` command plausibly DROPS A SCHEMA. Getting the working directory wrong on this path
 * is not a wrong answer, it is damage to the operator's own working directory (AD-8, FR-19). The
 * refusal is therefore unconditional whenever a data command is declared — and absent when none
 * is, because the refusal is about running commands in the wrong tree, not about the stage
 * existing.
 *
 * **REDACTION IS FAIL-CLOSED, AND THIS IS A SECURITY CLAUSE.** Data-command stdout and stderr are
 * CAPTURE OUTPUT — untrusted text a command emitted — and are redacted UNDECLARED, i.e. WITHOUT
 * `{shellCommand: true}`, which is `redactText`'s fail-closed default. That option is reserved for
 * DECLARED commands, text the project owner wrote, and `commandEvidence` already applies it to
 * `displayCommand` internally — which is the only declared text in this file. Shell context is
 * declared by the caller and never inferred from the text, because an apostrophe in prose is
 * indistinguishable from a shell delimiter (Epic 3 retro §2 observation 7, §6). Where captured
 * output enters an error MESSAGE it is redacted here, at the point it enters, because an error
 * travels further than evidence does: the same error reaches `printError` at the CLI edge, which
 * writes it to stderr verbatim, so the persisted copy would be clean while the terminal showed
 * the secret. `gates.ts` closes the identical hole in its `spawn-failed` arm.
 *
 * ============================================================================
 * AD-3 — THE COMMAND BOUNDARY
 * ============================================================================
 *
 * Data commands are `DeclaredCommand`s, minted only inside `src/config/` while validating the
 * project's own config file. Nothing here mints one, casts to one, or imports the brand; the only
 * operation performed is `commandText()`, the sanctioned READ direction. They reach
 * `ProcessRunner` as a binary plus an argument array — there is no shell on this path — so `&&`,
 * `$(...)` and `;` arrive at the child as literal argv elements. The split and its three
 * malformed-form refusals are story 3.4's `gate-command.ts`, imported rather than reimplemented:
 * a second splitter would eventually disagree with doctor about which token is the executable.
 *
 * AD-1: this stage constructs NO adapter. The runner and the evidence writer arrive by injection,
 * which is what keeps the whole file unit-testable with zero I/O.
 *
 * AD-9: the only instant read here comes from the injected `Clock`, and durations come from the
 * runner's own measurement. There is no direct clock read below — the determinism scan in
 * `tests/unit/domain/plan-data-determinism.test.ts` covers this file to keep it that way.
 */

import { commandText, type DeclaredCommand } from '../../config/index.js';
import { InfraError } from '../../domain/errors.js';
import { commandEvidence, redactText, type Evidence } from '../../domain/evidence.js';
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
import { dataEvidenceRelativePath, type GateOutputStream } from './gate-evidence-path.js';

/**
 * The upper bound handed to `ProcessRunner.run()` for one data command.
 *
 * Five minutes. A data command is setup, not a build: a schema reset, a fixture load, a
 * migration. `GATE_TIMEOUT_MS` is fifteen minutes because a gate may be a full test suite, and
 * borrowing that here would mean a hung `reset` — which is what lock contention looks like — held
 * the run for a quarter of an hour before saying anything. Five minutes is comfortably beyond any
 * realistic reset and short enough that a deadlock is reported while an operator is still
 * watching. Injectable through `DataStageDeps.timeoutMs` so a test can assert the timeout path in
 * milliseconds rather than waiting it out.
 */
export const DATA_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Writes one evidence file into the run directory and returns its RELATIVE path.
 *
 * Bound by the composition root to `RunStore.writeEvidenceFile` with the run id already applied —
 * the same shape as the merged `GateEvidenceWriter`, deliberately, so story 4.7 binds one thing
 * rather than two. The run id is not a parameter: `RunStore` keeps it because it serves every
 * run, this stage drops it because it serves exactly one, so the stage cannot address another
 * run's directory even by mistake.
 */
export interface DataEvidenceWriter {
  (relativeName: string, contents: string): Promise<string>;
}

export interface DataStageDeps {
  /**
   * The declared data commands, keyed by id. **Iteration order is execution order** — see the
   * header. Ids are the config keys verbatim; nothing here renames, prefixes or derives one.
   */
  readonly data: Readonly<Record<string, DeclaredCommand>>;
  readonly runner: ProcessRunner;
  /**
   * Persists the FULL redacted output of each command. **Optional**, unlike the gates stage's,
   * and the asymmetry is deliberate: a gate's captured output is the evidence behind a VERDICT,
   * whereas a data command's corroborates a step that produces no verdict at all. Without a
   * writer the stage still records bounded inline `command` evidence — the evidence constructors
   * perform no I/O — so only the pointer to a full copy is lost, and its absence is already
   * expressible (`stdoutFullPath` is optional).
   */
  readonly writeEvidence?: DataEvidenceWriter;
  /** Defaults to `DATA_COMMAND_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /**
   * Passed straight to the runner so each command's process group is recorded durably before the
   * run proceeds. The CLI edge binds `RunStore.recordProcessGroup`, which is what lets
   * `specwitness clean` reap a run killed mid-reset.
   */
  readonly onProcessGroup?: (pgid: number) => void | Promise<void>;
}

/**
 * The largest value an ECMA-262 array index may take, exclusive: `2^32 - 1`.
 *
 * Keys at or above it are ordinary string properties and keep insertion order.
 */
const ARRAY_INDEX_LIMIT = 2 ** 32 - 1;

/**
 * Is this key one that JavaScript enumerates OUT of insertion order?
 *
 * ECMA-262's `OrdinaryOwnPropertyKeys` lists **array-index keys first, in ascending numeric
 * order**, and only then string keys in insertion order. So an object built as
 * `{"2": …, "1": …}` enumerates as `1, 2` — the reverse of how it was written — while
 * `{"reset": …, "seed": …}` enumerates as written.
 *
 * The set is precise and this predicate matches it exactly: a canonical decimal for an integer
 * in `[0, 2^32 - 2]`. `"01"`, `"1.5"`, `"-1"` and `"1e3"` are NOT array indices — they round-trip
 * to a different string — so they keep insertion order and must not be refused. A wider guard
 * would reject ordinary ids for a hazard they do not have.
 */
function isArrayIndexKey(key: string): boolean {
  const asNumber = Number(key);

  return (
    Number.isInteger(asNumber) &&
    asNumber >= 0 &&
    asNumber < ARRAY_INDEX_LIMIT &&
    // The round-trip is what makes this canonical: `Number('01')` is 1, but `String(1)` is '01'
    // -> false, and `'01'` genuinely does keep its insertion position.
    String(asNumber) === key
  );
}

/**
 * Refuse a declaration whose execution order this stage cannot honour.
 *
 * FOUND BY REVIEW, and it is the one hole in the "insertion order is declaration order"
 * reliance this file's header states. That reliance holds for every ordinary id and fails
 * silently for integer-like ones, because the JS engine — not `yaml`, not zod — reorders them
 * during enumeration. A project writing
 *
 *     data:
 *       "2": ./scripts/seed.sh
 *       "1": ./scripts/reset.sh
 *
 * would have its seed run before its reset, with nothing anywhere saying so.
 *
 * WHY REFUSE RATHER THAN FIX. The ordering information is already gone by the time this stage
 * sees the object: it was destroyed when the YAML mapping became a JS object, upstream in
 * `src/config/schema.ts` — story 1.3's file, which this story does not own and must not change.
 * Preserving it properly means the schema keeping an ordered structure, which is a change for
 * the owner to direct rather than one to make in a story branch. Until then the honest options
 * are "run them in an order the operator did not write" or "refuse and say why", and for a path
 * whose commands plausibly drop schemas, the second is the only defensible one. Fail closed,
 * then explain.
 *
 * The blast radius is small by construction: `reset`, `seed` and `migrate` are what real data
 * commands are called, and an operator who did write `"1"` gets an exit-3 message telling them
 * to rename the key.
 *
 * **The identical latent defect exists in the merged services stage** (4.1) for
 * `config.services`, which relies on the same property. It is not this story's file to change;
 * it is reported to the owner in this story's PR body instead.
 */
function assertDeclarationOrderIsHonoured(ids: readonly string[]): void {
  const reordering = ids.filter((id) => isArrayIndexKey(id));
  if (reordering.length === 0) {
    return;
  }

  throw new InfraError(
    `data command id(s) ${reordering.map((id) => `'${id}'`).join(', ')} are integer-like, and ` +
      'their execution order cannot be guaranteed to match the order they are declared in',
    'JavaScript enumerates integer-like object keys first and in ascending numeric order, ' +
      'whatever order they appear in the file, so data commands named this way could run in an ' +
      'order you did not write — a seed before its reset, for example. Rename them to ' +
      "non-numeric ids such as 'reset' or 'seed' in .specwitness/config.yaml",
  );
}

/**
 * Split one declared command line, refusing the three malformed forms.
 *
 * Refused BEFORE spawning, and the reasoning is `gates.ts`'s verbatim because the hazard is
 * identical: a mis-grouped argument makes the child fail for a reason that has nothing to do with
 * the branch. The declared command is REDACTED in every message — a declared command can
 * legitimately carry a credential (a reset naming a database URL with a password in it is
 * ordinary), and these messages reach `printError`, which writes to stderr verbatim. Redacted
 * with `{shellCommand: true}` — and ONLY here — because this string IS a declared command line,
 * which is precisely the context that option is reserved for.
 */
function splitDeclared(
  dataId: string,
  command: DeclaredCommand,
): { binary: string; args: string[] } {
  const declared = commandText(command);
  const shown = (): string => redactText(declared, { shellCommand: true });

  if (usesUnsupportedEscaping(declared)) {
    throw new InfraError(
      `data command '${dataId}' uses backslash-escaped quotes, which are not supported: '${shown()}'`,
      'declared commands are executed without a shell, so a backslash before a quote is ' +
        'ambiguous and is refused rather than guessed at. Use the other quote style instead',
    );
  }

  if (hasUnterminatedQuote(declared)) {
    throw new InfraError(
      `data command '${dataId}' has an unterminated quote: '${shown()}'`,
      `close the quote in data.${dataId} in .specwitness/config.yaml — declared commands are ` +
        'split into a binary and arguments without a shell, so an unclosed quote would silently ' +
        'become several arguments rather than one',
    );
  }

  if (hasGluedExecutableSuffix(declared)) {
    throw new InfraError(
      `data command '${dataId}' has text attached to its quoted executable: '${shown()}'`,
      `separate them with a space in data.${dataId}, or quote the whole path — as written this ` +
        'would run the quoted binary and pass the rest as an argument, which may not be the ' +
        'command you intended',
    );
  }

  const { binary, args } = splitCommandLine(declared);
  if (binary === '') {
    throw new InfraError(
      `data command '${dataId}' declares a command with no executable: '${shown()}'`,
      `set data.${dataId} in .specwitness/config.yaml to a command starting with a binary`,
    );
  }

  return { binary, args: [...args] };
}

/**
 * Persist one stream's FULL output, redacted, and return its relative path.
 *
 * `redactText` rather than the raw string, and this is not belt-and-braces: a file in the run
 * directory IS persistence, and AD-10 requires redaction before any of it. `boundedText` (inside
 * the evidence constructors) redacts the INLINE copy only, so a stage that handed raw bytes to
 * the writer would leave the inline evidence spotless and the file beside it holding the
 * credential verbatim — with the obvious seeded-secret test, which inspects only the evidence,
 * passing green over exactly that hole. Redacted UNDECLARED: this is capture output.
 *
 * Nothing is written for an empty stream: an empty file is an artifact implying output that never
 * existed.
 */
async function persistStream(
  deps: DataStageDeps,
  dataId: string,
  index: number,
  stream: GateOutputStream,
  raw: string,
): Promise<string | undefined> {
  if (raw === '' || deps.writeEvidence === undefined) {
    return undefined;
  }
  return await deps.writeEvidence(dataEvidenceRelativePath(dataId, index, stream), redactText(raw));
}

/** The relative paths of whichever full-output files were written. */
interface StreamPaths {
  stdoutFullPath?: string;
  stderrFullPath?: string;
}

/**
 * Persist both streams independently, and NEVER throw.
 *
 * `Promise.allSettled` rather than `Promise.all`, for the reason `gates.ts` records: with `all`,
 * one stream failing discards the OTHER stream's returned path even though its file was written
 * successfully, leaving a real file in the run directory that nothing in the evidence can reach.
 *
 * Swallowing write failures is correct HERE specifically, and it is a narrower choice than it
 * looks. Every path in this stage either succeeds — in which case a lost full-output pointer
 * costs an operator one file, and the bounded inline copy still lands — or is about to throw a
 * precise `InfraError` naming the real cause ("data command 'reset' failed with exit code 1").
 * Letting an ENOSPC escape would REPLACE that diagnosis with a storage error: the outcome would
 * still be exit 3, but the operator would be told the wrong thing about why. That is the
 * durability-rewrites-a-conclusion mistake the gates stage fixed, arriving one classification
 * over. Unlike gates, this stage has no verdict to protect, so it never needs to escalate a write
 * failure into an error of its own.
 */
async function persistStreams(
  deps: DataStageDeps,
  dataId: string,
  index: number,
  result: ProcessResult,
): Promise<StreamPaths> {
  const settled = await Promise.allSettled([
    persistStream(deps, dataId, index, 'stdout', result.stdout),
    persistStream(deps, dataId, index, 'stderr', result.stderr),
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
 * Record what one data command produced, whatever its outcome.
 *
 * `command` evidence via the merged constructor — never hand-built, and never a new evidence
 * kind: `EVIDENCE_KINDS` is closed and widening it is an ADR. `commandId` is the config key
 * verbatim, which is the identity an operator reads in their own config file, and
 * `displayCommand` is `commandText(...)`, which the constructor redacts as declared text.
 *
 * Called on the success path AND before every throw, because a failing `reset` is exactly the
 * command whose output an operator needs. The accumulator survives a thrown stage, so it reaches
 * the report.
 */
async function record(
  deps: DataStageDeps,
  context: StageContext,
  dataId: string,
  index: number,
  command: DeclaredCommand,
  result: ProcessResult,
): Promise<void> {
  const paths = await persistStreams(deps, dataId, index, result);

  const evidence: Evidence = commandEvidence({
    capturedAt: context.clock.now().toISOString(),
    commandId: dataId,
    displayCommand: commandText(command),
    exitCode: result.exitCode,
    // Passed RAW and UNDECLARED: `boundedText` inside the constructor redacts capture output with
    // the fail-closed default. Handing it `{shellCommand: true}` here would be the fail-open
    // direction — see the header.
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    ...paths,
  });

  context.run.evidence.push(evidence);
}

/**
 * The diagnosis for a binary the OS could not find.
 *
 * Two causes, and conflating them is the confidently-wrong answer this project treats as
 * first-order — the same split `gates.ts` makes. A bare name is a PATH lookup, so "it is not
 * installed" is right. A token carrying a separator (`./scripts/reset.sh`) names a FILE resolved
 * relative to the verification worktree, so telling an operator to install it would be nonsense,
 * and telling them to fix their PATH would send them to edit a shell profile over a file that is
 * simply not in the commit under verification.
 */
function notFoundError(dataId: string, binary: string): InfraError {
  const isPath = binary.includes('/') || binary.includes('\\');

  // REDACTED, for the reason `gates.ts` records at its own `notFoundError`: under AD-3 there is
  // no shell, so a declaration shaped `NPM_TOKEN=… ./scripts/reset.sh` tokenizes with the
  // assignment AS THE EXECUTABLE, nothing on PATH is called that, and it lands here — in a
  // message an operator pastes into an issue, because the failure is a configuration mistake.
  // `{shellCommand: true}` because this token is DECLARED text the project owner wrote.
  //
  // Found during story 6.11 and fixed here as owner-authorised follow-up work rather than
  // silently, because this file belongs to story 4.3.
  const shown = redactText(binary, { shellCommand: true });

  return isPath
    ? new InfraError(
        `data command '${dataId}' could not run: '${shown}' does not exist in the verification worktree`,
        `'${shown}' names a file rather than a PATH lookup — check that it is committed on the ` +
          'branch under verification and is executable',
      )
    : new InfraError(
        `data command '${dataId}' could not run: '${shown}' is not on PATH`,
        `install '${shown}', or correct data.${dataId} in .specwitness/config.yaml`,
      );
}

/**
 * Turn one settled spawn into "continue", or throw.
 *
 * Exhaustive over `ProcessOutcome`. The `never` binding in the default branch is the guard that a
 * fifth outcome cannot silently become "the data command succeeded" — a `switch` handling only
 * `completed` would treat a missing binary as "no failure seen", which is precisely how an
 * unprepared tree reaches the probes stage and every probe fails for a reason nothing in the
 * report explains.
 *
 * Note the shape of the `completed` arm: unlike the gates stage there is no `fail` result here,
 * because there is no product-negative row in this table at all.
 */
async function classify(
  deps: DataStageDeps,
  context: StageContext,
  dataId: string,
  index: number,
  command: DeclaredCommand,
  result: ProcessResult,
  binary: string,
): Promise<void> {
  // Recorded FIRST, on every path: a failing reset is exactly the command whose output an
  // operator needs, and every arm below except one throws.
  await record(deps, context, dataId, index, command, result);

  switch (result.outcome) {
    case 'completed':
      if (result.exitCode === 0) {
        return;
      }
      throw new InfraError(
        `data command '${dataId}' failed with exit code ${String(result.exitCode)}`,
        'SpecWitness could not establish the preconditions for verification, which says nothing ' +
          'about whether the branch satisfies its contract — so this is reported as an ' +
          'environment problem rather than as a failing build. Check the command output in the ' +
          'run directory, fix the command or the environment, then rerun',
      );

    case 'not-found':
      throw notFoundError(dataId, binary);

    case 'timed-out':
      throw new InfraError(
        `data command '${dataId}' timed out after ` +
          `${String(deps.timeoutMs ?? DATA_COMMAND_TIMEOUT_MS)}ms and was killed`,
        'a data command that hung says nothing about whether the branch is mergeable, so this is ' +
          'reported as an environment problem rather than as a failing build — a reset waiting ' +
          'on a database lock is the usual cause',
      );

    case 'spawn-failed':
      throw new InfraError(
        // REDACTED before it goes into the message. This is the only error here that embeds
        // CAPTURED OUTPUT, and an error travels further than evidence does: the pipeline redacts
        // timeline details in its recorder, but the same error also reaches `printError` at the
        // CLI edge, which writes ERROR:/HINT: to stderr verbatim. So the persisted copy would be
        // clean while the terminal showed the secret. Redacting where the untrusted text ENTERS
        // the message closes that wherever the message is later printed.
        `data command '${dataId}' could not be spawned: ` +
          `${redactText(result.stderr).trim() || 'the process did not start'}`,
        'check that the verification worktree exists and is readable, then rerun',
      );

    default: {
      // Compile-time exhaustiveness. Adding a `ProcessOutcome` without deciding its
      // classification here is a type error, not a silent success.
      const unreachable: never = result.outcome;
      throw new InfraError(
        `data command '${dataId}' returned an unrecognised process outcome: ${String(unreachable)}`,
        'this is a defect in SpecWitness; please report it with the run directory',
      );
    }
  }
}

/**
 * The `data` stage: run the project's declared data commands in the verification worktree.
 *
 * @param deps omitted while no CLI edge binds it (story 4.7). See the header for why that is a
 * no-op rather than the fail-closed refusal `gates` uses.
 */
export function createDataStage(deps?: DataStageDeps): Stage {
  return {
    name: 'data',
    run: async (context): Promise<StageResult> => {
      if (deps === undefined) {
        return stageOk('no data runner was wired into this verification; nothing was run');
      }

      // Object insertion order IS declaration order — an explicit reliance, pinned by an
      // integration test that travels the real `loadConfig` path. See the header.
      //
      // `Object.entries` rather than `Object.keys` plus an index lookup, and the difference is
      // not stylistic: indexing a `Record` yields `DeclaredCommand | undefined` under
      // `noUncheckedIndexedAccess`, and the obvious way to silence that is
      // `deps.data[id] as DeclaredCommand` — an assertion INTO the branded type, which
      // `tests/unit/config/boundary-scan.test.ts` rejects by name and should. `entries` is
      // already typed as the pairs it yields, so the cast is not needed rather than suppressed.
      const entries = Object.entries(deps.data);
      if (entries.length === 0) {
        return stageOk('no data commands declared');
      }

      // Refused BEFORE the worktree check and before anything is spawned: an id whose order
      // cannot be honoured is a declaration this stage must not execute at all.
      assertDeclarationOrderIsHonoured(entries.map(([dataId]) => dataId));

      const cwd = context.run.environment.worktreePath;
      if (cwd === null) {
        // Never fall back to the project root. Gates and services refuse here because it would
        // verify the wrong tree; a `data.reset` command plausibly DROPS A SCHEMA, so on this path
        // the fallback is not a wrong answer but damage to the operator's own working directory
        // (AD-8, FR-19).
        throw new InfraError(
          'data commands cannot run: no verification worktree was created',
          'this is a SpecWitness defect — the worktree stage must run before data commands. ' +
            'Running them in the project root could modify your working tree, so nothing was run',
        );
      }

      for (const [index, [dataId, command]] of entries.entries()) {
        const { binary, args } = splitDeclared(dataId, command);

        const options: ProcessRunOptions = {
          binary,
          args,
          cwd,
          timeoutMs: deps.timeoutMs ?? DATA_COMMAND_TIMEOUT_MS,
          // Data commands are the project's own setup commands and need the operator's PATH and
          // toolchain. Constructed whole and passed whole: the runner resolves this with
          // `extendEnv: false`, so nothing is merged back over it. FR-15's withholding is for
          // provider invocations (AD-4), not for a project preparing its own tree.
          env: { inherit: true },
          ...(deps.onProcessGroup === undefined ? {} : { onProcessGroup: deps.onProcessGroup }),
        };

        const result = await deps.runner.run(options);
        // Throws on every outcome but a clean exit, so the loop stops at the first failure —
        // running `seed` after `reset` failed would seed a tree in an unknown condition.
        await classify(deps, context, dataId, index, command, result, binary);
      }

      return stageOk(`${String(entries.length)} data command(s) completed`);
    },
  };
}
