/**
 * The `shell` surface executor (story 4.6, FR-26, AD-3, AD-13).
 *
 * ============================================================================
 * THE NAME OF THIS STORY LIES: THERE IS NO SHELL HERE, AND THERE MUST NEVER BE.
 * ============================================================================
 *
 * A "shell probe" runs a project-declared command and asserts on its exit code
 * and output. It does NOT run a shell. The command reaches the child through
 * `ProcessRunner.run({binary, args})`, whose own header is explicit: "There is
 * no `shell` option and no way to add one without changing this file. That is
 * what makes it impossible for provider output — text a model wrote — to become
 * an executable command."
 *
 * So `&&`, `;`, `$(…)`, `|` and `*` inside an argument arrive at the child as
 * LITERAL argv elements. They are not filtered here, not escaped here and not
 * refused here, and that is deliberate rather than an omission: filtering them
 * would imply a shell exists somewhere, which is exactly the belief AD-3 is
 * designed to make unnecessary. `tests/integration/surfaces/shell.test.ts`
 * proves this rather than asserting it, by having the fixture command echo its
 * own `process.argv` back and comparing element for element.
 *
 * If you are reading this because you want to support a pipe, a redirect, a
 * `cd`, or an `&&` — STOP. `sh -c`, `shell: true` and string concatenation into
 * a command line are the single change that would undo this epic's security
 * property, and adding one is not a story-level decision. The supported way to
 * express a pipeline is a script committed to the project and declared in
 * `.specwitness/config.yaml`.
 *
 * ============================================================================
 * AC2 — THE ALLOWLIST, AND WHY IT IS CHECKED TWICE
 * ============================================================================
 *
 * A shell probe is the one place in the product where a provider-authored
 * artifact chooses ARGUMENTS to a real command. Two independent gates stand in
 * front of that, and the acceptance criterion calls them "schema + runtime
 * double enforcement":
 *
 *  1. SCHEMA (story 4.2, merged, not this file). A plan cannot express a
 *     command string at all — a shell probe carries a config `commandId` plus
 *     an `argumentAllowlist`, on a `z.strictObject`, and `ShellProbeSchema`'s
 *     own `superRefine` already enforces `args ⊆ argumentAllowlist`.
 *  2. RUNTIME (this file). Every argument is checked against the allowlist
 *     again, immediately before spawning.
 *
 * The second is not belt-and-braces. Plans are committed YAML in the target
 * project (Q11), so a human or another tool can edit one between compilation
 * and execution, and such a file never passes through the schema gate at all.
 * A schema gate protects a DRAFTED plan; a runtime gate protects an EXECUTED
 * one. Neither alone is sufficient.
 *
 * THE ENFORCEMENT SEMANTICS, stated precisely because this is a security
 * boundary a reader must be able to audit without running it:
 *
 *  - MATCHING IS EXACT STRING EQUALITY. Not prefix, not substring, not glob,
 *    not regex. `--dry-run` in the allowlist does not permit `--dry-runner`,
 *    and does not permit `--dry`. A pattern language would be a second parser
 *    and a second attack surface, and `domain/plan.ts` already refuses regex
 *    comparison for the same reason (an untrusted pattern over untrusted text
 *    is ReDoS with a hostile author and no timeout in sight).
 *  - AN EMPTY ALLOWLIST PERMITS NO ARGUMENTS. It does not mean "unconstrained".
 *    Fail closed. The opposite reading is fail-open and reads like a reasonable
 *    default, which is precisely why it is named here.
 *  - REPEATS ARE PERMITTED. Membership is a set test, so an allowed argument
 *    may be passed more than once: the allowlist states WHICH VALUES may be
 *    passed, not how many times. This matches the merged schema's own `Set`
 *    membership test rather than inventing a stricter rule the schema would
 *    then disagree with.
 *  - AN ARGUMENT MATCHING NO ENTRY REJECTS THE WHOLE PROBE. Nothing is dropped,
 *    nothing is sanitised, nothing runs.
 *  - AN UNUSED ALLOWLIST ENTRY IS NOT AN ERROR. The allowlist is a ceiling.
 *
 * REJECTION IS A `ConfigError`, NEVER A PRODUCT FAIL (AD-6/AD-7). An undeclared
 * id or an out-of-allowlist argument means THE PLAN IS WRONG, which says
 * nothing about whether the branch satisfies its contract. Exit 1 would tell a
 * harness the branch has defects and route repair automation at code that may
 * be perfectly fine; exit 3 says SpecWitness could not reach a conclusion,
 * which is what actually happened. The merged `getObservationCommand` in
 * `src/config/types.ts` is the precedent for the id case — it throws naming the
 * declared ids rather than returning a fallback, because "quietly substituting
 * anything would be a hole in the AD-3 boundary".
 *
 * ============================================================================
 * EXIT CODES: THIS MAPPING DELIBERATELY DIFFERS FROM THE GATES STAGE
 * ============================================================================
 *
 * `pipeline/stages/gates.ts` maps `completed` + non-zero to a GATE FAILURE.
 * That is right THERE and wrong HERE, and copying it would make every
 * negative-case probe unwritable.
 *
 * The difference is WHO DECLARED THE EXPECTATION. A gate's assertion is
 * implicit and fixed — "exit 0" — so a non-zero exit violates it by
 * definition. A probe's assertion is EXPLICIT and comes from the plan, so a
 * probe legitimately asserting `exitCode == 1` MUST PASS when the command exits
 * 1. For a shell probe a non-zero exit code is an OBSERVATION, not a verdict.
 *
 *   completed (any exit code)    -> evaluate the plan's assertions. Product.
 *   not-found / spawn-failed /
 *   timed-out                    -> `execError` -> criterion `error`. Infra.
 *
 * "The command said no" and "the command could not run" are the two things this
 * product exists to keep apart. A missing binary reported as `fail` is
 * infrastructure blamed on the branch.
 *
 * The same principle produces three different rules across the three Epic 4
 * surfaces, which is one pattern rather than three inconsistencies (settled
 * with bob/4.4 and pamela/4.5 at cohort intent-sync, 2026-09-01):
 *   - shell (here):      a non-zero exit is a normal evaluation — the PLAN
 *                        declared what the exit code must be.
 *   - observation (4.5): a non-zero exit is `execError` — Q35 makes "exit 0 and
 *                        emit JSON" the observation command's DECLARED contract.
 *   - http (4.4):        a non-JSON body under a jsonPath assertion is an
 *                        unsatisfied assertion — the PLAN asserted it.
 * Each follows whoever declared the expectation.
 *
 * Q39 forecloses a third option: execution-time uncertainty is `error`, NEVER
 * `needs_human`. There are exactly two NEEDS_HUMAN triggers and both are
 * compile-time. Nothing observed here creates a third.
 *
 * ============================================================================
 * WHAT THIS FILE DOES NOT DO
 * ============================================================================
 *
 * It never returns a `CriterionStatus` — AD-13 puts the single producer in
 * `domain/criterion-result.ts` and there is nowhere in `ProbeAttempt` to put
 * one. It evaluates assertions mechanically and reports what it saw; whether
 * that means pass, fail, error or flaky is `deriveCriterionResult`'s call, and
 * so is retry orchestration: this executes exactly ONE attempt per call and
 * stamps the 1-based `attempt` the caller supplied. It never loops.
 *
 * It also never resolves anything. `adapters-core-only` forbids `src/surfaces/**`
 * from importing `src/config/**` or `src/pipeline/**`, so the CALLER resolves
 * the config id to a command, splits it into a binary and argv with the merged
 * `splitCommandLine`, applies that module's three malformed-command refusals,
 * and injects the result. This file never mints a `DeclaredCommand`, never
 * casts to one, and never imports the brand.
 *
 * AD-1: imports `src/domain/**` and npm only.
 */

import type {
  AssertionEvaluation,
  Observation,
  ProbeAttempt,
  ProbeRequest,
  SurfaceExecutor,
} from '../domain/criterion-result.js';
import { ConfigError, InfraError } from '../domain/errors.js';
import {
  commandEvidence,
  evidenceRef,
  redactText,
  type Evidence,
  type EvidenceRef,
  type RedactionOptions,
} from '../domain/evidence.js';
import { ASSERTION_COMPARISONS, type AssertionComparison } from '../domain/plan.js';
import type { Clock } from '../domain/ports.js';
import type { ProcessResult, ProcessRunner } from '../domain/process-runner.js';

/**
 * How long one shell probe may run before it is abandoned as inconclusive.
 *
 * Two minutes, chosen rather than guessed: a probe is a targeted check (has
 * this migration been applied, does this binary report the expected version,
 * does this generated file have the right shape), not a build. The gates
 * stage's fifteen minutes is sized for `pnpm install` on a cold store and would
 * be an eternity here. Injectable so a test asserts the timeout path in
 * milliseconds instead of waiting it out.
 */
export const SHELL_PROBE_TIMEOUT_MS = 2 * 60 * 1000;

/** The run-directory subfolder every evidence file lives in (Q50). */
const EVIDENCE_DIR = 'evidence';

/**
 * A declared command the CALLER has already resolved and split.
 *
 * Every field is a plain string. There is no `DeclaredCommand` here and no way
 * to get one: minting happens only inside `src/config/`, which this module may
 * not import at all. What arrives is the OUTPUT of the sanctioned read
 * direction — `commandText(declared)` for display, `splitCommandLine(...)` for
 * execution — performed by the probes stage (4.7).
 *
 * Field names agreed verbatim with story 4.5 at cohort intent-sync so the two
 * command-spawning surfaces present one shape to their common caller.
 */
export interface ResolvedShellCommand {
  /** The config id this command was declared under. For evidence and diagnostics. */
  readonly commandId: string;
  /** `commandText(declared)`. DISPLAY ONLY — never parsed back, never executed from here. */
  readonly displayCommand: string;
  /** The executable token. The caller refuses an empty one before we are constructed. */
  readonly binary: string;
  /** argv from the DECLARED command line. The plan's arguments are appended after these. */
  readonly baseArgs: readonly string[];
}

/**
 * Writes one evidence file into the run directory and returns its RELATIVE path.
 *
 * Bound by the composition root to `RunStore.writeEvidenceFile` with the run id
 * already applied — `RunStore` is the sole writer under `.specwitness/runs/`
 * (AD-8), and this module constructs no path beneath it. The run id is
 * deliberately not a parameter, so the executor cannot address another run's
 * directory even by mistake. Structurally identical to the merged
 * `GateEvidenceWriter`, and to 4.4's and 4.5's, so 4.7 binds one thing three
 * times.
 */
export interface ShellEvidenceWriter {
  (relativeName: string, contents: string): Promise<string>;
}

/**
 * Hands the typed evidence member to whoever owns the run accumulator.
 *
 * WHY THIS EXISTS, since it is the one dep that is not obvious. `ProbeAttempt`
 * carries `readonly EvidenceRef[]` — REFERENCES — and there is nowhere in it to
 * put an `Evidence` member. But `RunResult.evidence` is `readonly Evidence[]`,
 * "the closed evidence UNION, not bare references", and its own doc explains
 * why: "Refs alone would discard the redacted, bounded content at the moment it
 * was constructed, and a renderer whose signature is `(result: RunResult) =>
 * string` could then only show that content by reading the file — which AD-11
 * forbids and its signature makes impossible."
 *
 * `gates.ts` solves this by pushing members onto `context.run.evidence`
 * directly. No executor can: `adapters-core-only` keeps `src/surfaces/**` away
 * from the pipeline by design. That same rule prescribes the remedy — "if a
 * story needs an adapter-to-adapter call, that is a port in src/domain/,
 * injected by the caller" — and this callback is that port in its smallest
 * form. 4.7 binds it to `context.run.evidence.push`.
 *
 * Without it a run's report would carry gate evidence and NO probe evidence at
 * all, silently, with every surface's test suite green — because no executor
 * test drives a renderer. Found at cohort intent-sync by 4.5 and settled there.
 */
export interface ShellEvidenceSink {
  (evidence: Evidence): void;
}

export interface ShellExecutorDeps {
  readonly runner: ProcessRunner;
  /** AD-9. Never `Date.now()`. */
  readonly clock: Clock;
  /** `run.environment.worktreePath` — commands run in the worktree (AD-8, FR-19). */
  readonly cwd: string;
  /** Resolved and split by the caller; see `ResolvedShellCommand`. */
  readonly command: ResolvedShellCommand;
  readonly writeEvidence: ShellEvidenceWriter;
  readonly recordEvidence: ShellEvidenceSink;
  /** Defaults to `SHELL_PROBE_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** AD-10 config-declared extra patterns, passed through to every redaction. */
  readonly redaction?: RedactionOptions;
}

/** What a shell assertion reads. Mirrors the merged `ShellAssertionTarget`. */
type ShellTargetSource = 'exitCode' | 'stdout' | 'stderr';

const TARGET_SOURCES: readonly ShellTargetSource[] = ['exitCode', 'stdout', 'stderr'];

/**
 * The narrow shape this executor reads out of `ProbeRequest.params`.
 *
 * `params` is `Readonly<Record<string, unknown>>` and the per-surface zod
 * schemas in `src/schemas/plan.ts` are MODULE-PRIVATE (`ShellProbeSchema` is
 * not exported), so this shape is hand-validated below rather than re-parsed.
 * Confirmed independently by all three Epic 4 surface stories at intent-sync
 * and reported to the owner as an additive follow-up; nobody adds an export to
 * a merged file they do not own.
 *
 * Hand-validation is still real runtime enforcement, which is what AC2 needs:
 * the plan on disk may have been edited after it was compiled.
 */
export interface ShellProbeParams {
  /** The probe's own id, from the plan. Used to name evidence files. */
  readonly probeId: string;
  /** The config id the plan referenced. Must match the resolved command. */
  readonly commandId: string;
  /** argv the plan supplies, appended after the declared command's own. */
  readonly args: readonly string[];
  /** Every argument this probe may pass. Reviewed by a human in the committed plan. */
  readonly argumentAllowlist: readonly string[];
  readonly assertions: readonly ShellAssertionSpec[];
  /** 1-based. Optional so a single-shot caller need not think about it; defaults to 1. */
  readonly attempt?: number;
}

/** One mechanically evaluable expectation, as DATA. Mirrors `Assertion<ShellAssertionTarget>`. */
export interface ShellAssertionSpec {
  readonly description: string;
  readonly target: { readonly source: ShellTargetSource };
  readonly comparison: AssertionComparison;
  readonly expected: string;
}

/* ── params validation ───────────────────────────────────────────────────── */

function wiringDefect(what: string): InfraError {
  return new InfraError(
    `the shell probe was invoked with malformed params: ${what}`,
    'this is a SpecWitness defect rather than a problem with the branch under ' +
      'verification — the probes stage must pass a compiled shell probe’s mechanics ' +
      'and assertions through unchanged',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw wiringDefect(`'${field}' is not an array`);
  }
  for (const [index, element] of value.entries()) {
    if (typeof element !== 'string') {
      throw wiringDefect(`'${field}[${index}]' is not a string`);
    }
  }
  return value as readonly string[];
}

function assertionSpec(value: unknown, index: number): ShellAssertionSpec {
  if (!isRecord(value)) {
    throw wiringDefect(`'assertions[${index}]' is not an object`);
  }
  if (typeof value['description'] !== 'string') {
    throw wiringDefect(`'assertions[${index}].description' is not a string`);
  }
  if (typeof value['expected'] !== 'string') {
    throw wiringDefect(`'assertions[${index}].expected' is not a string`);
  }

  const comparison = value['comparison'];
  if (
    typeof comparison !== 'string' ||
    !(ASSERTION_COMPARISONS as readonly string[]).includes(comparison)
  ) {
    // Refused rather than defaulted. A comparison nobody implements must not
    // silently become `equals`, and a plan naming one is a plan this build
    // cannot execute faithfully.
    throw wiringDefect(
      `'assertions[${index}].comparison' is ${JSON.stringify(comparison)}, which is not one of ` +
        ASSERTION_COMPARISONS.join(', '),
    );
  }

  const target = value['target'];
  if (!isRecord(target)) {
    throw wiringDefect(`'assertions[${index}].target' is not an object`);
  }
  const source = target['source'];
  if (typeof source !== 'string' || !(TARGET_SOURCES as readonly string[]).includes(source)) {
    throw wiringDefect(
      `'assertions[${index}].target.source' is ${JSON.stringify(source)}, which is not one of ` +
        TARGET_SOURCES.join(', '),
    );
  }

  return {
    description: value['description'],
    target: { source: source as ShellTargetSource },
    comparison: comparison as AssertionComparison,
    expected: value['expected'],
  };
}

/**
 * Reads and validates the params, or throws an `InfraError`.
 *
 * Every absent or wrong-typed field is REFUSED rather than defaulted, and the
 * allowlist is the field where that matters most: defaulting an absent
 * `argumentAllowlist` to "everything permitted" is fail-open, and defaulting it
 * to "nothing permitted" would silently disable a probe an operator believes is
 * running. Neither is honest, so neither happens.
 */
function readParams(raw: Readonly<Record<string, unknown>>): ShellProbeParams {
  if (!isRecord(raw)) {
    throw wiringDefect('they are not an object');
  }
  for (const field of ['probeId', 'commandId'] as const) {
    if (typeof raw[field] !== 'string' || raw[field] === '') {
      throw wiringDefect(`'${field}' is not a non-empty string`);
    }
  }
  if (!Array.isArray(raw['args'])) {
    throw wiringDefect("'args' is not an array");
  }
  if (!Array.isArray(raw['argumentAllowlist'])) {
    throw wiringDefect("'argumentAllowlist' is not an array");
  }
  if (!Array.isArray(raw['assertions']) || raw['assertions'].length === 0) {
    // A probe that adjudicates nothing reaches `outcomeOf`'s "nothing was
    // adjudicated mechanically" branch, which returns `needs_human` rather than
    // minting a PASS out of nothing. The merged schema's `.min(1)` makes that
    // unreachable from a COMPILED plan; a hand-edited one can still get here.
    throw wiringDefect("'assertions' is not a non-empty array");
  }

  const attempt = raw['attempt'];
  if (attempt !== undefined && (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1)) {
    throw wiringDefect("'attempt' is not a positive integer");
  }

  return {
    probeId: raw['probeId'] as string,
    commandId: raw['commandId'] as string,
    args: stringArray(raw['args'], 'args'),
    argumentAllowlist: stringArray(raw['argumentAllowlist'], 'argumentAllowlist'),
    assertions: raw['assertions'].map((entry, index) => assertionSpec(entry, index)),
    ...(attempt === undefined ? {} : { attempt: attempt as number }),
  };
}

/* ── the AC2 runtime gate ────────────────────────────────────────────────── */

/** Looks like a template placeholder the caller forgot to substitute. */
function looksUnsubstituted(value: string): boolean {
  // DIAGNOSTIC ONLY. Nothing here interprets `{{…}}` — inventing a template
  // language in the executor would be the second-parser mistake this file
  // refuses everywhere else. It only improves the HINT on a rejection.
  return value.includes('{{');
}

/**
 * Refuses the probe unless every argument is permitted. Runs BEFORE any spawn.
 *
 * The half-substitution hint exists because of a cohort agreement with story
 * 4.3: `resolveMechanics` substitutes `args` AND `argumentAllowlist` with the
 * same resolved data, so both sides of this equality see the same
 * substitution. Without that, every probe using a data binding would reject
 * forever — and a `volatile` binding could never be passed at all, since its
 * value is a token the plan author cannot know at compile time. If a caller
 * ever substitutes one array and not the other, the failure looks exactly like
 * a genuine allowlist violation, so the hint names the real cause.
 */
function enforceAllowlist(params: ShellProbeParams, command: ResolvedShellCommand): void {
  if (params.commandId !== command.commandId) {
    throw new ConfigError(
      `shell probe '${params.probeId}' references command id '${params.commandId}', but the ` +
        `command resolved for it was '${command.commandId}'`,
      'a plan may only run commands declared under `observations:` in .specwitness/config.yaml, ' +
        'and the id it names must be the one that was resolved — quietly running a different ' +
        'command would be a hole in the AD-3 boundary',
    );
  }

  const permitted = new Set(params.argumentAllowlist);
  const rejected = params.args.filter((argument) => !permitted.has(argument));
  if (rejected.length === 0) {
    return;
  }

  // REDACTED UNDECLARED, both sides. These are PLAN-supplied strings —
  // provider-authored text, not a project owner's declared command — so they
  // get the fail-closed treatment, not `{shellCommand: true}`. And this message
  // reaches `printError`, which writes ERROR:/HINT: to stderr verbatim, so an
  // unredacted argument here would leak in the terminal while the persisted
  // copy stayed clean.
  const show = (value: string): string => redactText(value);
  const halfSubstituted =
    rejected.some(looksUnsubstituted) || params.argumentAllowlist.some(looksUnsubstituted);

  throw new ConfigError(
    `shell probe '${params.probeId}' passes ${rejected.length} argument(s) outside its ` +
      `argumentAllowlist: ${rejected.map((value) => `'${show(value)}'`).join(', ')}`,
    (params.argumentAllowlist.length === 0
      ? `this probe's argumentAllowlist is empty, which permits NO arguments — add each ` +
        `argument it must pass to argumentAllowlist in the plan, or remove it from args`
      : `permitted arguments are: ${params.argumentAllowlist
          .map((value) => `'${show(value)}'`)
          .join(', ')} — matching is exact, so a prefix or a longer form of a permitted ` +
        `argument is refused`) +
      (halfSubstituted
        ? '. A `{{…}}` placeholder survived here, which usually means args and ' +
          'argumentAllowlist were not substituted with the same resolved data — both must be, ' +
          'or neither'
        : ''),
  );
}

/* ── mechanical assertion evaluation ─────────────────────────────────────── */

/** Reads one target out of the settled spawn. Exhaustive with a `never` check. */
function actualFor(source: ShellTargetSource, result: ProcessResult): string {
  switch (source) {
    case 'exitCode':
      // `String(null)` is "null", which is honest for a process that produced
      // no code and makes any exit-code assertion legitimately unsatisfied
      // rather than throwing.
      return String(result.exitCode);
    case 'stdout':
      return result.stdout;
    case 'stderr':
      return result.stderr;
    default: {
      const unreachable: never = source;
      throw wiringDefect(`unrecognised assertion target '${String(unreachable)}'`);
    }
  }
}

/**
 * A numeric comparison where BOTH sides must parse as finite numbers.
 *
 * A side that does not is an UNSATISFIED assertion, never a crash — the merged
 * `domain/plan.ts` says so in as many words. The empty string is treated as
 * non-numeric rather than as `Number('') === 0`, because an empty stdout is the
 * absence of an answer, not the number zero.
 */
function numeric(actual: string, expected: string, compare: (a: number, b: number) => boolean): boolean {
  const parse = (raw: string): number => (raw.trim() === '' ? Number.NaN : Number(raw));
  const left = parse(actual);
  const right = parse(expected);
  return Number.isFinite(left) && Number.isFinite(right) && compare(left, right);
}

/** Exhaustive over `ASSERTION_COMPARISONS` with a `never` check. */
function satisfies(comparison: AssertionComparison, actual: string, expected: string): boolean {
  switch (comparison) {
    case 'equals':
      return actual === expected;
    case 'notEquals':
      return actual !== expected;
    case 'contains':
      return actual.includes(expected);
    case 'notContains':
      return !actual.includes(expected);
    case 'greaterThan':
      return numeric(actual, expected, (a, b) => a > b);
    case 'lessThan':
      return numeric(actual, expected, (a, b) => a < b);
    default: {
      const unreachable: never = comparison;
      throw wiringDefect(`unrecognised assertion comparison '${String(unreachable)}'`);
    }
  }
}

/**
 * Evaluates every declared assertion, INCLUDING the satisfied ones.
 *
 * All of them, because FR-28 needs `expected`/`actual` on non-pass results and
 * `deriveCriterionResult` reads `find(e => !e.satisfied)` — an executor that
 * reported only failures would leave a passing probe with no record of what it
 * checked, and a report that cannot say what was verified is not evidence.
 *
 * `satisfied` is computed on the RAW values; `expected` and `actual` are
 * redacted for reporting. The two cannot disagree about the outcome, because
 * the outcome was decided before redaction — which is the right order: a
 * credential that happens to appear in output must not change whether a
 * criterion passed.
 */
function evaluate(
  params: ShellProbeParams,
  result: ProcessResult,
  redaction: RedactionOptions | undefined,
): AssertionEvaluation[] {
  return params.assertions.map((assertion) => {
    const actual = actualFor(assertion.target.source, result);
    return {
      description: assertion.description,
      satisfied: satisfies(assertion.comparison, actual, assertion.expected),
      // Redacted UNDECLARED. `actual` is captured output and `expected` is
      // provider-authored plan text; neither is a project owner's declared
      // shell command, so neither gets `{shellCommand: true}`.
      expected: redactText(assertion.expected, redaction),
      actual: redactText(actual, redaction),
    };
  });
}

/* ── classification ──────────────────────────────────────────────────────── */

/**
 * The diagnosis for a binary the OS could not find, which has two causes.
 *
 * A bare name (`node`) is a PATH lookup: "it is not installed" is right. A
 * token carrying a separator (`./scripts/check`) names a FILE resolved against
 * the verification worktree, so the useful instruction is "commit it" — a
 * script present but untracked in the operator's working copy is genuinely
 * absent from the revision under verification. Same reasoning, and the same
 * two remedies, as the merged `notFoundError` in `pipeline/stages/gates.ts`.
 */
function notFoundExecError(params: ShellProbeParams, binary: string): { message: string; hint: string } {
  const namesAFile = binary.includes('/') || binary.includes('\\');
  return namesAFile
    ? {
        message:
          `shell probe '${params.probeId}' could not start: '${binary}' does not exist in the ` +
          'verification worktree',
        hint:
          'probes run against the revision under verification, not your working copy — commit ' +
          `'${binary}' (an untracked or uncommitted file will not be there), or correct ` +
          `observations.${params.commandId} in .specwitness/config.yaml`,
      }
    : {
        message: `shell probe '${params.probeId}' could not start: '${binary}' is not on PATH`,
        hint:
          `install '${binary}', or correct observations.${params.commandId} in ` +
          '.specwitness/config.yaml — this is an environment problem, not a failure of the ' +
          'branch under verification',
      };
}

/**
 * Turns one settled spawn into an exec error, or `undefined` when it ran.
 *
 * Exhaustive over `ProcessOutcome` with a `never` check in the default branch.
 * That is not style: a `switch` handling only `completed` would treat a missing
 * binary as "no failure seen", and a fifth outcome added upstream must break
 * this file's compilation rather than fall through to silence.
 */
function classify(
  params: ShellProbeParams,
  result: ProcessResult,
  binary: string,
  timeoutMs: number,
  redaction: RedactionOptions | undefined,
): { message: string; hint: string } | undefined {
  switch (result.outcome) {
    case 'completed':
      // IT RAN. Whatever the exit code, the plan's assertions decide — see the
      // header on why this differs from the gates stage.
      return undefined;

    case 'not-found':
      return notFoundExecError(params, binary);

    case 'spawn-failed':
      return {
        // The only message here embedding CAPTURED OUTPUT, so redacted at the
        // point untrusted text enters it: an error reaches `printError`, which
        // writes to stderr verbatim, and the persisted copy would be clean
        // while the terminal showed the secret.
        message:
          `shell probe '${params.probeId}' could not be spawned: ` +
          (redactText(result.stderr, redaction).trim() || 'the process did not start'),
        hint: 'check that the verification worktree exists and is readable, then rerun',
      };

    case 'timed-out':
      return {
        message: `shell probe '${params.probeId}' timed out after ${timeoutMs}ms and was killed`,
        hint:
          'a probe that hung observed nothing, so this is reported as an environment problem ' +
          'rather than as a failing criterion — rerun, or make the command faster',
      };

    default: {
      const unreachable: never = result.outcome;
      return {
        message:
          `shell probe '${params.probeId}' returned an unrecognised process outcome: ` +
          String(unreachable),
        hint: 'this is a defect in SpecWitness; please report it with the run directory',
      };
    }
  }
}

/* ── evidence ────────────────────────────────────────────────────────────── */

/**
 * Normalise an id into at most one safe path component.
 *
 * The merged `pipeline/stages/gate-evidence-path.ts` solves this problem for
 * gates and is NOT importable here — `adapters-core-only` forbids
 * `src/surfaces/**` from reaching into `src/pipeline/**`. Its reasoning applies
 * unchanged: an id containing `..` hits `RunStore`'s containment rule and an
 * over-long one raises `ENAMETOOLONG`, and both would mean EXIT 3 FOR A
 * PERFECTLY GOOD RUN — infrastructure blamed for something that is not
 * infrastructure. So this is total: every string maps to one safe component.
 */
function slugify(value: string): string {
  const substituted = value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    // Collapsed so the literal sequence `..` can never appear anywhere in the
    // result, not merely at the edges.
    .replace(/\.{2,}/g, '.');
  const trimmed = substituted.replace(/^[-.]+/, '').replace(/[-.]+$/, '');
  return trimmed.length <= 64 ? trimmed : trimmed.slice(0, 64).replace(/[-.]+$/, '');
}

/** `evidence/shell-E4-01-migrations-check-1` — the stem all three files share. */
function evidenceStem(criterionId: string, params: ShellProbeParams, attempt: number): string {
  const slug = slugify(`${criterionId}-${params.probeId}`);
  return slug === '' ? `shell-${attempt}` : `shell-${slug}-${attempt}`;
}

export class ShellSurfaceExecutor implements SurfaceExecutor {
  readonly surface = 'shell' as const;

  readonly #deps: ShellExecutorDeps;

  constructor(deps: ShellExecutorDeps) {
    this.#deps = deps;
  }

  async execute(request: ProbeRequest): Promise<ProbeAttempt> {
    const { command, redaction } = this.#deps;
    const timeoutMs = this.#deps.timeoutMs ?? SHELL_PROBE_TIMEOUT_MS;

    const params = readParams(request.params);
    const attempt = params.attempt ?? 1;

    // ── AC2: BEFORE ANY EXECUTION ────────────────────────────────────────
    // Nothing above this line has spawned anything, and nothing below it runs
    // if this throws. That ordering is the acceptance criterion, and the unit
    // suite proves it with a runner that fails the test if it is ever called.
    enforceAllowlist(params, command);

    const result = await this.#deps.runner.run({
      binary: command.binary,
      // argv, never a command line. The declared command's own arguments
      // first, then the plan's — the ordering agreed with story 4.5.
      args: [...command.baseArgs, ...params.args],
      cwd: this.#deps.cwd,
      timeoutMs,
      // Probes are the project's own commands and need the operator's PATH and
      // toolchain, exactly as gates do. FR-15's withholding is for provider
      // invocations (AD-4), not for a project inspecting itself.
      env: { inherit: true },
    });

    const execError = classify(params, result, command.binary, timeoutMs, redaction);
    const evidence = await this.#captureEvidence(request.criterionId, params, attempt, result);

    const observations: Observation[] = [
      { name: 'outcome', value: result.outcome },
      { name: 'exitCode', value: String(result.exitCode) },
    ];

    return {
      attempt,
      observations,
      // ZERO assertion evaluations on an error path. Assertions evaluated
      // against a broken observation would manufacture product evidence out of
      // an infrastructure failure — `outcomeOf` says the same from the other
      // side, where an exec error outranks any assertion a probe managed to
      // evaluate.
      assertionEvaluations: execError === undefined ? evaluate(params, result, redaction) : [],
      evidence,
      ...(execError === undefined ? {} : { execError }),
      // The runner's OWN measurement, which already uses the injected clock
      // (AD-9). Never a second clock read here.
      durationMs: result.durationMs,
    };
  }

  /**
   * Captures `command` evidence for this attempt, and returns its references.
   *
   * THE RULE (settled across all three Epic 4 surfaces at cohort intent-sync,
   * 2026-09-01, so 4.7's conformance test sees one shape three times):
   *
   *   Observed something -> `recordEvidence(member)`; write the serialized
   *     member and ref it; and for EACH stream non-empty after redaction, write
   *     the full redacted copy, ref it, and pass its path as that stream's
   *     `fullPath`.
   *   Observed nothing   -> no member, no file, no ref, no sink call.
   *
   * "No OBSERVATION, no ref" — not "no output", and not "execError". On THIS
   * surface the primary observable is a NUMBER: a probe asserting
   * `exitCode == 1` against a silent command observed something real, and would
   * carry no evidence at all under a stream-shaped reading. So a `completed`
   * spawn always counts; a timeout or a spawn failure counts when it printed
   * something (story 3.2's runner returns captured output on a timeout rather
   * than an empty string); a `not-found` never does, because nothing ran.
   *
   * WHY THE FULL COPIES GO THROUGH `redactText` FIRST. A file in the run
   * directory IS persistence, and `boundedText` inside the constructor redacts
   * only the INLINE copy. Handing raw bytes to the writer would leave the
   * inline evidence spotless and the file beside it holding a credential
   * verbatim — with the obvious seeded-secret test, which inspects the
   * evidence, passing green over exactly that hole. `evidence.ts`'s header
   * calls this out as the reason `redactText` exists as its own export.
   */
  async #captureEvidence(
    criterionId: string,
    params: ShellProbeParams,
    attempt: number,
    result: ProcessResult,
  ): Promise<EvidenceRef[]> {
    const { redaction } = this.#deps;
    const observed = result.outcome === 'completed' || result.stdout !== '' || result.stderr !== '';
    if (!observed) {
      return [];
    }

    const stem = evidenceStem(criterionId, params, attempt);
    const refs: EvidenceRef[] = [];
    const paths: { stdoutFullPath?: string; stderrFullPath?: string } = {};

    for (const stream of ['stdout', 'stderr'] as const) {
      const redacted = redactText(result[stream], redaction);
      if (redacted === '') {
        // An empty file is an artifact implying output that never existed.
        continue;
      }
      const path = await this.#deps.writeEvidence(
        `${EVIDENCE_DIR}/${stem}.${stream}.txt`,
        redacted,
      );
      paths[stream === 'stdout' ? 'stdoutFullPath' : 'stderrFullPath'] = path;
      refs.push(evidenceRef('command', path));
    }

    const member = commandEvidence(
      {
        capturedAt: this.#deps.clock.now().toISOString(),
        commandId: this.#deps.command.commandId,
        // The DECLARED command text. This is the one string here that is a
        // project owner's shell command, so the constructor redacts it with
        // `{shellCommand: true}` — which bounds a sensitive header value at its
        // closing quote instead of running to end of line. Captured output and
        // plan arguments are NOT declared and never get that treatment.
        displayCommand: this.#deps.command.displayCommand,
        exitCode: result.exitCode,
        // RAW on purpose: the constructor redacts and bounds the inline copy.
        // Pre-redacting would double-redact, and a pre-built BoundedText is not
        // accepted by design.
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        ...paths,
      },
      redaction,
    );

    this.#deps.recordEvidence(member);

    const memberPath = await this.#deps.writeEvidence(
      `${EVIDENCE_DIR}/${stem}.json`,
      `${JSON.stringify(member, null, 2)}\n`,
    );
    // FIRST, so a non-pass result always carries at least one reference (FR-28)
    // whether or not either stream produced a file.
    refs.unshift(evidenceRef('command', memberPath));

    return refs;
  }
}
