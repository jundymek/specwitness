/**
 * Story 4.5 — the OBSERVATION surface executor (AD-13, FR-25, brief §34/§35, Q34/Q35).
 *
 * ============================================================================
 * THIS IS THE SURFACE THAT ANSWERS THE QUESTION A TEST SUITE CANNOT.
 * ============================================================================
 *
 * An http probe asks "did the endpoint answer correctly?". An observation probe asks
 * "and what did that do to the world?" — and the gap between those two is where the
 * defects SpecWitness exists to find actually live. The brief's §35 example is exactly
 * it: a duplicate submission returns 200 twice, so every response-level check is green,
 * and two rows exist where one should. That defect passes coding-agent tests, passes
 * review, and reaches production.
 *
 * The design constraint is STACK NEUTRALITY (FR-4, Q34): SpecWitness names no database,
 * no ORM and no query language. The project owner declares an observation command in
 * their config; it emits JSON to stdout; SpecWitness asserts over the JSON. That is the
 * entire abstraction.
 *
 * ============================================================================
 * THE CLASSIFICATION TABLE — the story's spine, not an edge case
 * ============================================================================
 *
 *   completed + exit 0 + parseable JSON object  -> assertions evaluated
 *   completed + exit 0 + NON-JSON stdout        -> execError -> criterion `error`
 *   completed + non-zero exit                   -> execError -> criterion `error`
 *   not-found / spawn-failed / timed-out        -> execError -> criterion `error`
 *
 * Q35 is explicit that observation commands MUST emit JSON and that non-JSON output
 * makes the criterion `error`. The reason is worth stating rather than merely obeying:
 *
 *  - A `try { JSON.parse } catch { return notSatisfied }` would report a **product FAIL**
 *    for a broken observation command — infrastructure blamed on the branch. Exit 1 says
 *    "your code is broken"; here the branch has not been judged at all.
 *  - Equally, defaulting a missing count to `0` and finding `0 - 0 == 0` would report a
 *    **PASS** for a command that produced nothing. Both are green-or-red for nothing.
 *
 * `execError` is the only honest answer, and it is set ALONE. No `AssertionEvaluation`
 * accompanies it: those assertions would have run against a broken observation, and
 * `outcomeOf` in `domain/criterion-result.ts` says why it outranks them anyway — doing so
 * "would manufacture product evidence out of an infrastructure failure".
 *
 * A NOTE ON EXIT CODES, because this file's rule differs from two of its neighbours' and
 * a reader deserves to see three decisions rather than three inconsistencies. Settled
 * with bob (4.4) and arnold (4.6) at cohort intent-sync:
 *
 *   - The GATES stage maps a non-zero exit to a gate failure: a gate's implicit assertion
 *     is "exit 0".
 *   - The SHELL surface (4.6) treats a non-zero exit as a NORMAL EVALUATION: a shell probe
 *     may legitimately assert `exitCode == 1`, and that expectation came from the plan.
 *   - THIS surface treats it as `execError`: Q35 makes "exit 0 and emit JSON on stdout"
 *     the observation command's DECLARED CONTRACT, written by the project owner in their
 *     config — so violating it is the environment being broken, not the product.
 *
 * Each rule follows WHO DECLARED the expectation. The plan asserted it => product. The
 * project owner declared it in config => infrastructure.
 *
 * THE SAME ASYMMETRY WITH 4.4, stated because the two look identical and are not. For an
 * HTTP probe, a non-JSON body under a JSON-path assertion is a PRODUCT observation: the
 * server answered, and the answer was wrong. For an observation command, non-JSON is
 * criterion `error`. Same-looking input, different classification, both correct.
 *
 * ============================================================================
 * WHAT THIS FILE DOES NOT DO
 * ============================================================================
 *
 * IT NEVER PRODUCES A `CriterionStatus` (AD-13). It returns a `ProbeAttempt`, and there is
 * nowhere in `SurfaceExecutor` to put a status. The single producer is
 * `deriveCriterionResult`. Four surfaces each adjudicating status their own way would give
 * four different answers to "did a retry that eventually passed count as flaky", and the
 * differences would surface only as a verdict nobody could reproduce.
 *
 * IT NEVER RETRIES. One attempt per `execute()` call, stamped from `params.attempt`
 * (AD-9, Q43/Q44). `flaky` is the derivation's call: the final attempt decides, a pass
 * only on retry is flaky, and a pass then a failure is a failure.
 *
 * IT NEVER SPECIAL-CASES HUMAN VERIFIABILITY. `deriveCriterionResult` returns
 * `needs_human` for `verifiability: human` before it looks at attempts, unconditionally.
 * A probe that wanted to adjudicate one would need an ADR, not a branch (Epic 3 retro §6).
 *
 * IT NEVER SEES A `DeclaredCommand`, AND IT NEVER SPLITS ONE. `adapters-core-only` forbids
 * `src/surfaces/**` both `src/config/**` (where `getObservationCommand` lives) and
 * `src/pipeline/**` (where the merged `splitCommandLine` and its three malformed-command
 * refusals live). So THE CALLER resolves the config id, applies those refusals, splits,
 * and injects the result — the same shape `ProviderDescriptor` uses for the same problem
 * one adapter over. Settled with 4.6 at intent-sync so that exactly one splitter exists in
 * the product. Nothing here mints, casts or imports the brand.
 *
 * AD-1: an adapter. Imports `src/domain/**` and nothing else — no config, no pipeline, no
 * application layer, no edge, no npm package.
 */

import {
  type AssertionEvaluation,
  type Observation,
  type ProbeAttempt,
  type ProbeExecError,
  type ProbeRequest,
  type SurfaceExecutor,
} from '../domain/criterion-result.js';
import { InfraError } from '../domain/errors.js';
import {
  evidenceRef,
  observationEvidence,
  redactText,
  type Evidence,
  type EvidenceRef,
  type RedactionOptions,
} from '../domain/evidence.js';
import {
  ASSERTION_COMPARISONS,
  type AssertionComparison,
  type ObservationPhase,
} from '../domain/plan.js';
import type { ProcessResult, ProcessRunner } from '../domain/process-runner.js';
import type { Clock } from '../domain/ports.js';

/**
 * How long one observation command may run before the attempt is abandoned.
 *
 * Two minutes rather than the gates stage's fifteen, chosen rather than guessed: an
 * observation command is a COUNT QUERY — "how many rows are there" — not a build. A cap
 * generous enough for a cold database connection and a slow query, and short enough that a
 * hung observation does not hold a run open for a quarter of an hour. Injectable so a test
 * asserts the timeout path in milliseconds instead of waiting it out.
 */
export const OBSERVATION_PROBE_TIMEOUT_MS = 2 * 60 * 1000;

/** The run-directory subfolder every evidence file lives in (Q50), as gates uses. */
const EVIDENCE_DIR = 'evidence';

/**
 * A declared observation command ALREADY RESOLVED to what `ProcessRunner` needs.
 *
 * Built by the caller, never here. Field names are arnold's (4.6), adopted verbatim at
 * cohort intent-sync so the two command-spawning surfaces read identically for 4.7.
 */
export interface ResolvedObservationCommand {
  /** The `observations:` config key, for evidence and error messages. */
  readonly commandId: string;
  /**
   * `commandText(declared)` — the command as the project owner WROTE it, for display only.
   *
   * DECLARED text, so it is redacted with `{shellCommand: true}`. Its OUTPUT is not: see
   * `captureRedaction` below.
   */
  readonly displayCommand: string;
  /** Never `''` — the caller refuses an empty binary before it gets here. */
  readonly binary: string;
  /** argv from the declared command line. The plan's `args` are appended after these. */
  readonly baseArgs: readonly string[];
}

/** Resolves an `observations:` config id to a runnable command. Bound by the caller. */
export type ObservationCommandResolver = (commandId: string) => ResolvedObservationCommand;

/**
 * Writes one evidence file into the run directory and returns its RELATIVE path.
 *
 * The merged `GateEvidenceWriter` shape verbatim (`pipeline/stages/gates.ts`), bound by the
 * composition root to `RunStore.writeEvidenceFile` with the run id already applied. AD-8:
 * `RunStore` is the sole writer under `.specwitness/runs/`, so nothing here constructs a
 * path beneath it — this module derives a relative NAME and hands it over.
 */
export type SurfaceEvidenceWriter = (relativeName: string, contents: string) => Promise<string>;

/**
 * Records a typed evidence member on the run.
 *
 * REQUIRED, and it exists because `ProbeAttempt.evidence` is `readonly EvidenceRef[]` —
 * refs only — while `RunResult.evidence` is the closed UNION. `domain/run-result.ts` is
 * explicit about why: refs alone "would discard the redacted, bounded content at the moment
 * it was constructed, and a renderer whose signature is `(result: RunResult) => string`
 * could then only show that content by reading the file — which AD-11 forbids". A
 * refs-only executor therefore renders probe evidence blank while every test passes, since
 * no surface's suite drives a renderer. Found by arnold (4.6) during cohort intent-sync,
 * verified against merged source, adopted by all three surfaces.
 *
 * `adapters-core-only` both forbids this module the run accumulator and prescribes the
 * remedy: "If a story needs an adapter-to-adapter call, that is a port in src/domain/,
 * injected by the caller." The caller binds it to `context.run.evidence.push`, exactly as
 * the gates stage does with its own members.
 */
export type EvidenceSink = (evidence: Evidence) => void;

/**
 * Performs the ACTION an observation wraps, between the before and after snapshots.
 *
 * The plan expresses the wrap as `mechanics.around`, naming another probe in the same
 * criterion (4.2's merged schema, which also guarantees the target is an http, browser or
 * shell probe — never another observation, because "wrapping a snapshot measures nothing").
 * This executor cannot run an http probe, so the caller injects the means: given the
 * wrapped probe's id, run it.
 *
 * Optional, because a standalone observation needs none. An `around` with no `runAction`
 * injected is a WIRING DEFECT and throws — see `execute`.
 */
export type ObservationActionRunner = (aroundProbeId: string) => Promise<void>;

export interface ObservationExecutorDeps {
  /** AD-3: binary + argv, no shell, no way to add one. */
  readonly runner: ProcessRunner;
  /** AD-9: every instant and every duration. Never `Date.now()`. */
  readonly clock: Clock;
  /** The verification worktree. Observation commands run against the revision under test. */
  readonly cwd: string;
  /** Defaults to `OBSERVATION_PROBE_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** Config-declared extra redaction patterns (AD-10), passed straight through. */
  readonly redaction?: RedactionOptions;
  readonly writeEvidence: SurfaceEvidenceWriter;
  readonly recordEvidence: EvidenceSink;
  /** The caller's config lookup + command split. See `ResolvedObservationCommand`. */
  readonly resolveCommand: ObservationCommandResolver;
  /** Required only for a probe whose `mechanics.around` names an action. */
  readonly runAction?: ObservationActionRunner;
}

/* ── params, hand-validated ──────────────────────────────────────────────────────────── */

/**
 * WHY THESE SHAPES ARE VALIDATED BY HAND rather than with 4.2's zod schema.
 *
 * `ObservationProbeSchema` is MODULE-PRIVATE in `src/schemas/plan.ts` — it is not exported,
 * and adding an export is a change to a merged file this story does not own. (Confirmed
 * independently by 4.4 and by me; both PRs record it as an additive follow-up for the owner.)
 *
 * So the narrow shape is checked structurally here. That is still real runtime enforcement,
 * and it is needed: a plan is committed to the target project's git and can be hand-edited
 * after compilation, so `ProbeRequest.params` — typed `Readonly<Record<string, unknown>>` —
 * is genuinely unknown at this boundary.
 *
 * MALFORMED PARAMS THROW `InfraError`; THEY DO NOT BECOME AN `execError`. A params object
 * that does not match is a WIRING DEFECT in SpecWitness or a hand-edited plan, not a broken
 * environment. Both land on exit 3, but only one names the right culprit — and `execError`
 * is this surface's "the project's observation command is broken" channel, so routing our
 * own bug through it would put SpecWitness's defect in the one field that means "not the
 * branch, and not us either".
 */
interface ObservationAssertionSpec {
  readonly description: string;
  readonly path: string;
  readonly phase: ObservationPhase;
  readonly comparison: AssertionComparison;
  readonly expected: string;
}

interface ObservationParams {
  readonly probeId: string;
  readonly commandId: string;
  readonly args: readonly string[];
  readonly around?: string;
  readonly assertions: readonly ObservationAssertionSpec[];
  readonly attempt: number;
  /** From the REQUEST, not from params — it disambiguates evidence paths. */
  readonly criterionId: string;
}

const PHASES: readonly ObservationPhase[] = ['snapshot', 'before', 'after', 'delta'];

const PARAMS_HINT =
  'this is a wiring defect in SpecWitness or a hand-edited plan file, not a failure of the ' +
  'branch under verification — regenerate the plan with `specwitness plan <epic>` and rerun';

function malformed(what: string): never {
  throw new InfraError(`observation probe params are malformed: ${what}`, PARAMS_HINT);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return malformed(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string') {
    return malformed(`${what} is not a string`);
  }
  return value;
}

function asNonEmptyString(value: unknown, what: string): string {
  const text = asString(value, what);
  if (text.trim() === '') {
    return malformed(`${what} is empty`);
  }
  return text;
}

/** Reads and checks the one attempt number, which rides in params (settled with 4.4). */
function readAttempt(raw: unknown): number {
  if (raw === undefined) {
    // A single-shot caller should not have to think about retries.
    return 1;
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    return malformed('attempt is not a positive integer');
  }
  return raw;
}

function readAssertion(raw: unknown, index: number): ObservationAssertionSpec {
  const at = `assertions[${index}]`;
  const assertion = asRecord(raw, at);
  const target = asRecord(assertion['target'], `${at}.target`);

  // Exactly one source exists for this surface, and Q35 is the reason: observation commands
  // MUST emit JSON, so there is nothing else to read from.
  if (target['source'] !== 'jsonPath') {
    return malformed(`${at}.target.source is '${String(target['source'])}', not 'jsonPath'`);
  }

  const phase = target['phase'];
  if (typeof phase !== 'string' || !PHASES.includes(phase as ObservationPhase)) {
    return malformed(`${at}.target.phase is not one of ${PHASES.join(', ')}`);
  }

  const comparison = assertion['comparison'];
  if (
    typeof comparison !== 'string' ||
    !ASSERTION_COMPARISONS.includes(comparison as AssertionComparison)
  ) {
    // The merged list is CLOSED and there is deliberately no regular-expression comparison:
    // an untrusted pattern run against untrusted output is ReDoS with a hostile author.
    return malformed(`${at}.comparison is '${String(comparison)}', which is not a known comparison`);
  }

  return {
    description: asNonEmptyString(assertion['description'], `${at}.description`),
    path: asNonEmptyString(target['path'], `${at}.target.path`),
    phase: phase as ObservationPhase,
    comparison: comparison as AssertionComparison,
    // NOT non-empty: an expectation of the empty string is a real expectation, exactly as
    // 4.2's schema records ("`expected: ""` is unambiguous in a way a blank statement is not").
    expected: asString(assertion['expected'], `${at}.expected`),
  };
}

function readParams(request: ProbeRequest): ObservationParams {
  const raw = request.params;
  const mechanics = asRecord(raw['mechanics'], 'mechanics');

  const rawArgs = mechanics['args'];
  if (!Array.isArray(rawArgs)) {
    return malformed('mechanics.args is not an array');
  }
  const args = rawArgs.map((arg, index) => asString(arg, `mechanics.args[${index}]`));

  const rawAround = mechanics['around'];
  const around = rawAround === undefined ? undefined : asNonEmptyString(rawAround, 'mechanics.around');

  const rawAssertions = raw['assertions'];
  if (!Array.isArray(rawAssertions) || rawAssertions.length === 0) {
    // 4.2's `.min(1)`: "a probe that adjudicates nothing cannot mint a PASS". Without it,
    // `outcomeOf` reaches its `needs_human` safety branch — reachable only via this door.
    return malformed('assertions is not a non-empty array');
  }
  const assertions = rawAssertions.map(readAssertion);

  // THE PHASE AND THE WRAP ARE ONE FACT, so they must agree — 4.2's `superRefine` enforces
  // this at compile time and it is re-checked here, because a plan file can be hand-edited
  // after compilation. `before`/`after`/`delta` without an `around` describe a comparison
  // against a snapshot that was never captured; `snapshot` WITH an `around` does not say
  // which of the two it means. Both are well-formed text describing a schedule no executor
  // can run, which is precisely why refusing beats guessing.
  for (const assertion of assertions) {
    const paired = assertion.phase !== 'snapshot';
    if (paired && around === undefined) {
      return malformed(
        `an assertion uses phase '${assertion.phase}' but mechanics.around names no action to wrap`,
      );
    }
    if (!paired && around !== undefined) {
      return malformed(
        `this observation wraps '${around}', so phase 'snapshot' does not say which of the two snapshots it means`,
      );
    }
  }

  return {
    probeId: asNonEmptyString(raw['probeId'] ?? mechanics['commandId'], 'probeId'),
    commandId: asNonEmptyString(mechanics['commandId'], 'mechanics.commandId'),
    args,
    ...(around === undefined ? {} : { around }),
    assertions,
    attempt: readAttempt(raw['attempt']),
    criterionId: request.criterionId,
  };
}

/* ── JSON reading ────────────────────────────────────────────────────────────────────── */

/** A value read out of a snapshot: present with a rendered string, or absent. */
type Read = { readonly found: true; readonly value: string } | { readonly found: false };

const ABSENT = 'absent';

/**
 * Renders one JSON value as the string everything downstream stores.
 *
 * `Observation.value` and `AssertionEvaluation.expected`/`actual` are all strings, and
 * deliberately so: everything here is persisted to `result.json`, and "a model that admits
 * non-serialisable values is a model whose serializer eventually throws on real data".
 */
function render(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value) ?? ABSENT;
}

/**
 * Reads one value out of a parsed snapshot by JSON path.
 *
 * A DELIBERATELY TINY ACCESSOR, not a JSONPath engine: a leading `$`, dot-separated keys,
 * and bracketed indices or quoted keys. `$.count`, `$.rows[1].id`, `$['odd key']`.
 *
 * Why not the full grammar: the path is text a provider CLI wrote, and every expressive
 * addition — filters, wildcards, recursive descent — is another interpreter running
 * untrusted input over untrusted data. `ASSERTION_COMPARISONS` refuses regular expressions
 * for exactly this reason ("catastrophic backtracking with a hostile author and no timeout
 * in sight"); the same argument applies to a path language. If a later story needs more, it
 * arrives with a mitigation and an ADR, not as a quiet extension here.
 *
 * A path that does not resolve returns `{found: false}` — NEVER `0`, never `''`, never a
 * throw. That absence is the single most important behaviour in this function: defaulting a
 * missing count to `0` makes `0 - 0 == 0` satisfy a delta assertion, reporting a green
 * criterion for a command that produced nothing.
 */
function readPath(root: unknown, path: string): Read {
  const trimmed = path.trim();
  const body = trimmed.startsWith('$') ? trimmed.slice(1) : trimmed;

  const segments: string[] = [];
  let index = 0;
  while (index < body.length) {
    const char = body[index];
    if (char === '.') {
      index += 1;
      continue;
    }
    if (char === '[') {
      const close = body.indexOf(']', index);
      if (close === -1) {
        return { found: false };
      }
      const inner = body.slice(index + 1, close).trim();
      const unquoted =
        (inner.startsWith("'") && inner.endsWith("'")) ||
        (inner.startsWith('"') && inner.endsWith('"'))
          ? inner.slice(1, -1)
          : inner;
      segments.push(unquoted);
      index = close + 1;
      continue;
    }
    let end = index;
    while (end < body.length && body[end] !== '.' && body[end] !== '[') {
      end += 1;
    }
    segments.push(body.slice(index, end));
    index = end;
  }

  let current: unknown = root;
  for (const segment of segments) {
    if (segment === '') {
      continue;
    }
    if (Array.isArray(current)) {
      const position = Number(segment);
      if (!Number.isInteger(position) || position < 0 || position >= current.length) {
        return { found: false };
      }
      current = current[position];
      continue;
    }
    if (typeof current !== 'object' || current === null) {
      return { found: false };
    }
    // Own-property only: a prototype walk would resolve `constructor` or `toString` into
    // something the observation command never printed — the same reason
    // `getObservationCommand` uses `Object.hasOwn`.
    if (!Object.hasOwn(current, segment)) {
      return { found: false };
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current === undefined ? { found: false } : { found: true, value: render(current) };
}

/* ── comparisons ─────────────────────────────────────────────────────────────────────── */

/** A finite number, or `undefined`. Blank text is not zero. */
function numeric(text: string): number | undefined {
  if (text.trim() === '') {
    return undefined;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Evaluates one comparison. Exhaustive over the merged closed list, with a `never` check.
 *
 * A numeric comparison whose operands do not both parse is UNSATISFIED, never a crash —
 * `ASSERTION_COMPARISONS` states exactly that: "both sides must parse as finite numbers,
 * and an actual value that does not is an unsatisfied assertion, never a crash."
 */
function compare(comparison: AssertionComparison, actual: string, expected: string): boolean {
  switch (comparison) {
    case 'equals':
      return actual === expected;
    case 'notEquals':
      return actual !== expected;
    case 'contains':
      return actual.includes(expected);
    case 'notContains':
      return !actual.includes(expected);
    case 'greaterThan': {
      const left = numeric(actual);
      const right = numeric(expected);
      return left !== undefined && right !== undefined && left > right;
    }
    case 'lessThan': {
      const left = numeric(actual);
      const right = numeric(expected);
      return left !== undefined && right !== undefined && left < right;
    }
    default: {
      // Compile-time exhaustiveness. A seventh comparison added upstream must break this
      // file rather than silently evaluate to `false`, which would read as a product FAIL.
      const unreachable: never = comparison;
      return malformed(`unknown comparison '${String(unreachable)}'`);
    }
  }
}

/* ── snapshots ───────────────────────────────────────────────────────────────────────── */

/** One successfully parsed snapshot, with the raw text kept for evidence. */
interface Snapshot {
  readonly phase: 'snapshot' | 'before' | 'after';
  readonly parsed: unknown;
  readonly raw: string;
}

/** What one spawn produced: a usable snapshot, or the reason it was not usable. */
type SnapshotOutcome =
  | { readonly ok: true; readonly snapshot: Snapshot; readonly result: ProcessResult }
  | { readonly ok: false; readonly error: ProbeExecError; readonly result: ProcessResult };

/**
 * Was anything OBSERVED at all?
 *
 * The cohort's shared rule, settled with 4.4 and 4.6 and worded by 4.4: "no OBSERVATION, no
 * ref" — not "no output" and not "execError". `completed` always counts, because an exit
 * code was genuinely observed even from a silent command. A timeout or a spawn failure
 * counts only if it left captured text (story 3.2's runner returns the child's output on a
 * timeout rather than an empty string, which is why the gates stage keeps `recordAttempt`).
 * `not-found` never counts: nothing ran.
 *
 * The alternative — writing evidence only when the inline copy overflowed — leaves a SHORT
 * failing snapshot with no evidence ref at all, and FR-28 requires at least one on every
 * non-pass result. That would make FR-28 true whenever a payload happened to be large,
 * which is a coincidence rather than a guarantee.
 */
function observedAnything(result: ProcessResult): boolean {
  switch (result.outcome) {
    case 'completed':
      return true;
    case 'timed-out':
    case 'spawn-failed':
      return result.stdout !== '' || result.stderr !== '';
    case 'not-found':
      return false;
    default: {
      const unreachable: never = result.outcome;
      return malformed(`unknown process outcome '${String(unreachable)}'`);
    }
  }
}

/* ── the executor ────────────────────────────────────────────────────────────────────── */

/**
 * Normalises an id into at most one safe path component.
 *
 * The same treatment, and the same reasoning, as the merged `gate-evidence-path.ts`: an id
 * that reaches the filesystem unchanged can hit `RunStore`'s containment rule or
 * `ENAMETOOLONG`, and both arrive as `InfraError` — exit 3 for a perfectly good run,
 * infrastructure blamed for something that is not infrastructure.
 *
 * Kept PRIVATE to this file rather than shared with the other two surfaces: a fourth module
 * that three branches all want to edit is how a trivial conflict becomes a bad one. All
 * three PRs flag it as a 4.7 consolidation candidate (agreed with 4.4).
 */
/** Budget for each id-derived portion, in characters. Generous next to a real id. */
const SLUG_MAX_CHARS = 48;

function slugify(id: string): string {
  const substituted = id
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/\.{2,}/g, '.');
  const trimmed = substituted.replace(/^[-.]+/, '').replace(/[-.]+$/, '');
  return trimmed.slice(0, SLUG_MAX_CHARS).replace(/[-.]+$/, '');
}

/**
 * A short, stable discriminator for a probe's FULL identity.
 *
 * WHY A HASH AND NOT THE SLUGS ALONE. `slugify` is lossy twice over — it substitutes unsafe
 * characters and it truncates — so two DISTINCT, schema-valid identities can normalise to
 * one filename. Two ways that happens, and the second is the one that matters:
 *
 *  1. `Identifier` in 4.2's schema permits 128 characters, so two probe ids differing only
 *     after the budget above collide.
 *  2. **Probe ids are unique only WITHIN A CRITERION.** The merged `superRefine` says so in
 *     as many words — "probe ids identify a probe within its criterion" — so two criteria
 *     reusing one id is an ordinary plan, not a malformed one.
 *
 * On a collision `RunStore.writeEvidenceFile` overwrites, and the earlier probe's evidence
 * REFERENCE still resolves — now pointing at a different probe's output. That is silent
 * corruption of the audit record, which is worse than a missing file because nothing looks
 * wrong. (Raised by the Codex review pass, and it was right: I carried across
 * `gate-evidence-path.ts`'s slug treatment without its declaration INDEX, and the index is
 * precisely the part that "keeps two ids that become identical AFTER truncation apart".
 * This executor sees one probe per call and has no index, so the discriminator is derived
 * from the identity itself.)
 *
 * FNV-1a, inline over `criterionId` + probe id: deterministic, and dependency-free so this
 * module still imports nothing but `src/domain` (AD-1). Determinism is load-bearing rather
 * than incidental — two runs of the same plan must produce byte-identical evidence paths,
 * which is what makes a run directory comparable across runs.
 *
 * NOT a security control. Nothing here defends against an attacker choosing a colliding id;
 * it separates honest ids, so a short non-cryptographic digest is the right tool.
 */
function discriminator(criterionId: string, probeId: string): string {
  // The separator keeps ('ab','c') and ('a','bc') apart. It is a character `Identifier`
  // forbids, so neither side can contain one and the concatenation stays unambiguous.
  const identity = `${criterionId}/${probeId}`;
  let hash = 0x811c_9dc5;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    // The FNV prime. `Math.imul` keeps the multiply in 32 bits without a BigInt.
    hash = Math.imul(hash, 0x0100_0193) >>> 0;
  }
  return hash.toString(36).padStart(7, '0');
}

export class ObservationSurfaceExecutor implements SurfaceExecutor {
  readonly surface = 'observation' as const;

  readonly #deps: ObservationExecutorDeps;

  constructor(deps: ObservationExecutorDeps) {
    this.#deps = deps;
  }

  async execute(request: ProbeRequest): Promise<ProbeAttempt> {
    const params = readParams(request);
    const started = this.#deps.clock.now().getTime();

    const finish = (
      observations: readonly Observation[],
      assertionEvaluations: readonly AssertionEvaluation[],
      evidence: readonly EvidenceRef[],
      execError?: ProbeExecError,
    ): ProbeAttempt => {
      const durationMs = Math.max(0, Math.round(this.#deps.clock.now().getTime() - started));
      return {
        attempt: params.attempt,
        observations,
        assertionEvaluations,
        evidence,
        durationMs,
        ...(execError === undefined ? {} : { execError }),
      };
    };

    const observations: Observation[] = [];
    const refs: EvidenceRef[] = [];

    const take = async (phase: Snapshot['phase']): Promise<SnapshotOutcome> => {
      const outcome = await this.#snapshot(params, phase);
      refs.push(...(await this.#persist(params, phase, outcome.result)));
      if (outcome.ok) {
        observations.push({
          name: `${params.commandId}.${phase}`,
          value: outcome.snapshot.raw.trim(),
        });
      }
      return outcome;
    };

    const before = await take(params.around === undefined ? 'snapshot' : 'before');
    if (!before.ok) {
      // NOTHING ELSE IS SET. In the wrapping case the action is also not performed: running
      // it after a failed "before" would mutate the system under verification for a
      // comparison that can no longer be made, and would leave the next run's baseline wrong.
      return finish(observations, [], refs, before.error);
    }

    if (params.around === undefined) {
      return finish(
        observations,
        this.#evaluate(params, before.snapshot, undefined),
        refs,
      );
    }

    const runAction = this.#deps.runAction;
    if (runAction === undefined) {
      throw new InfraError(
        `observation probe '${params.probeId}' wraps '${params.around}' but no action runner was injected`,
        PARAMS_HINT,
      );
    }
    await runAction(params.around);

    const after = await take('after');
    if (!after.ok) {
      return finish(observations, [], refs, after.error);
    }

    return finish(observations, this.#evaluate(params, before.snapshot, after.snapshot), refs);
  }

  /**
   * Spawns the resolved command once and classifies what came back.
   *
   * Exhaustive over `ProcessOutcome` with a `never` check. That is not a style preference:
   * a `switch` handling only `completed` would treat a missing binary as "no failure seen",
   * and a fifth outcome added upstream must break this file's compilation rather than fall
   * through to silence — the same guard, for the same reason, as the gates stage's `classify`.
   */
  async #snapshot(params: ObservationParams, phase: Snapshot['phase']): Promise<SnapshotOutcome> {
    const command = this.#deps.resolveCommand(params.commandId);

    const result = await this.#deps.runner.run({
      binary: command.binary,
      // AD-3: an ARRAY. No shell exists on this path and none can be added, so `;` and
      // `$(...)` inside an argument reach the child as literal text.
      args: [...command.baseArgs, ...params.args],
      cwd: this.#deps.cwd,
      timeoutMs: this.#deps.timeoutMs ?? OBSERVATION_PROBE_TIMEOUT_MS,
      // The observation command is the project's own tooling and legitimately needs the
      // environment (a DATABASE_URL, a PATH). Nothing is withheld and nothing is added.
      env: { inherit: true },
    });

    const fail = (message: string, hint: string): SnapshotOutcome => ({
      ok: false,
      // REDACTED AT THE POINT UNTRUSTED TEXT ENTERS THE MESSAGE. An error travels further
      // than evidence does — `deriveCriterionResult` copies `execError.message` into
      // `actual`, and the same text can reach a terminal — so an unredacted message would be
      // the one path by which a captured credential escapes a clean evidence record.
      error: { message: redactText(message, this.#captureRedaction()), hint },
      result,
    });

    const where = `observation '${params.commandId}'`;

    switch (result.outcome) {
      case 'not-found':
        return fail(
          `${where} could not start: '${command.binary}' was not found`,
          `install it, or correct observations[${params.commandId}] in .specwitness/config.yaml — ` +
            'this is an environment problem, not a failure of the branch under verification',
        );

      case 'spawn-failed':
        return fail(
          `${where} could not be spawned: ${result.stderr.trim() || 'the process did not start'}`,
          'check that the verification worktree exists and is readable, then rerun',
        );

      case 'timed-out':
        return fail(
          `${where} timed out after ${this.#deps.timeoutMs ?? OBSERVATION_PROBE_TIMEOUT_MS}ms and was killed`,
          'an observation that hung says nothing about whether the branch is mergeable, so ' +
            'this is reported as an environment problem rather than as a failing build',
        );

      case 'completed':
        break;

      default: {
        // Compile-time exhaustiveness: adding a `ProcessOutcome` without classifying it here
        // is a type error, not a silent pass.
        const unreachable: never = result.outcome;
        return fail(
          `${where} returned an unrecognised process outcome: ${String(unreachable)}`,
          'this is a defect in SpecWitness; please report it with the run directory',
        );
      }
    }

    if (result.exitCode !== 0) {
      // Q35: exit 0 AND JSON is the declared contract. A non-zero exit means the command
      // could not observe, whatever it printed — so its output says nothing trustworthy
      // about the branch. Contrast 4.6, where a plan may legitimately assert `exitCode == 1`.
      return fail(
        `${where} exited ${String(result.exitCode)}: an observation command must exit 0 and emit JSON to stdout`,
        `fix observations[${params.commandId}] in .specwitness/config.yaml — a broken observation ` +
          'command cannot judge the branch either way',
      );
    }

    // STDOUT, and only stdout (Q34/Q35). Parsing the streams concatenated would break every
    // command that logs a warning before printing its JSON, and the failure would look like
    // the project's fault.
    const raw = result.stdout;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return fail(
        `${where} did not emit JSON to stdout`,
        `an observation command must print a JSON object to stdout — fix ` +
          `observations[${params.commandId}] in .specwitness/config.yaml; the raw output is ` +
          'stored in this run\'s evidence',
      );
    }

    if (typeof parsed !== 'object' || parsed === null) {
      // A bare scalar has no JSON path to read, so every assertion would be `absent` and the
      // criterion would report a product FAIL for a command that never met its contract.
      return fail(
        `${where} emitted JSON that is not an object`,
        'an observation command must print a JSON OBJECT to stdout, so assertions have a path to read',
      );
    }

    return { ok: true, snapshot: { phase, parsed, raw }, result };
  }

  /**
   * Redaction options for CAPTURE OUTPUT.
   *
   * `shellCommand` is deliberately absent, i.e. `false` — the FAIL-CLOSED default — even
   * though this text came out of a command the project owner declared. Epic 3's retro states
   * it for every Epic 4 caller: shell context is DECLARED BY THE CALLER, never inferred from
   * text, "because an apostrophe in prose is indistinguishable from a shell delimiter". The
   * command's own TEXT (`displayCommand`) is the declared string; its output never is.
   */
  #captureRedaction(): RedactionOptions {
    return { ...this.#deps.redaction, shellCommand: false };
  }

  /**
   * Persists one snapshot's evidence, and returns the refs.
   *
   * Two artifacts when there is output, mirroring the gates stage:
   *
   *  1. the FULL captured stdout, `redactText`-ed but NOT truncated. `boundedText` inside
   *     the constructor redacts the INLINE copy only, so handing raw bytes to the writer
   *     would leave the inline evidence spotless and the file beside it holding the
   *     credential verbatim — with the obvious seeded-secret test passing green over exactly
   *     that hole (`evidence.ts`, rule 2).
   *  2. the typed `ObservationEvidence` member, built through the MERGED constructor and
   *     never hand-written, serialized beside it and referenced from the attempt.
   *
   * The member is NOT re-redacted on the way out: every field the constructor touches is
   * already redacted at capture, and a second pass would imply its output is untrusted —
   * which the whole design of `evidence.ts` denies. (Agreed with 4.4.)
   */
  async #persist(
    params: ObservationParams,
    phase: Snapshot['phase'],
    result: ProcessResult,
  ): Promise<EvidenceRef[]> {
    if (!observedAnything(result)) {
      // Nothing was observed, so nothing is written and NO REF IS INVENTED.
      // `deriveCriterionResult` tolerates zero refs deliberately: "a probe that crashed
      // before observing anything has nothing honest to put there, and inventing a value
      // would be worse than omitting one."
      return [];
    }

    const options = this.#captureRedaction();
    // criterion + probe + a discriminator over the FULL identity: probe ids are unique only
    // within a criterion, and both slugs are truncated. See `discriminator`.
    const stem =
      `${EVIDENCE_DIR}/observation-${slugify(params.criterionId)}-${slugify(params.probeId)}` +
      `-${discriminator(params.criterionId, params.probeId)}-${phase}-${params.attempt}`;
    const refs: EvidenceRef[] = [];

    let fullPath: string | undefined;
    if (result.stdout !== '') {
      fullPath = await this.#deps.writeEvidence(
        `${stem}.stdout.txt`,
        redactText(result.stdout, options),
      );
      refs.push(evidenceRef('observation', fullPath));
    }
    if (result.stderr !== '') {
      // Kept even though stderr is never parsed: a command that failed to emit JSON usually
      // explains why on stderr, and that explanation is the diagnostic an operator needs.
      refs.push(
        evidenceRef(
          'observation',
          await this.#deps.writeEvidence(
            `${stem}.stderr.txt`,
            redactText(result.stderr, options),
          ),
        ),
      );
    }

    const member = observationEvidence(
      {
        capturedAt: this.#deps.clock.now().toISOString(),
        observationId: params.commandId,
        // AC2's "with the raw output as evidence": the BROKEN output is the diagnostic, so
        // it is captured even on the path that is erroring out. Redacted and bounded.
        snapshot: result.stdout,
        durationMs: result.durationMs,
        explanation: `${phase} snapshot of '${params.commandId}' for probe '${params.probeId}'`,
      },
      { ...options, ...(fullPath === undefined ? {} : { fullPath }) },
    );
    this.#deps.recordEvidence(member);

    refs.push(
      evidenceRef(
        'observation',
        await this.#deps.writeEvidence(`${stem}.json`, `${JSON.stringify(member, null, 2)}\n`),
      ),
    );

    return refs;
  }

  /**
   * Evaluates every declared assertion. ONE `AssertionEvaluation` PER ASSERTION, including
   * the satisfied ones.
   *
   * FR-28 requires expected/actual on non-pass results and `deriveCriterionResult` reads
   * `find(e => !e.satisfied)`; dropping satisfied evaluations would also make a passing
   * criterion indistinguishable from one that adjudicated nothing at all — which
   * `outcomeOf` treats as `needs_human`.
   *
   * NOTHING IS INTERPRETED AND NOTHING IS INFERRED. Assertions are DATA, evaluated
   * mechanically. No AI is consulted, here or anywhere on this path: "never ask an LLM
   * whether it passes" is the product's first non-negotiable rule.
   */
  #evaluate(
    params: ObservationParams,
    before: Snapshot,
    after: Snapshot | undefined,
  ): AssertionEvaluation[] {
    const options = this.#captureRedaction();

    return params.assertions.map((assertion) => {
      const read = this.#actualFor(assertion, before, after);
      const satisfied = read.found && compare(assertion.comparison, read.value, assertion.expected);

      return {
        description: assertion.description,
        satisfied,
        // Redacted here as well as in `deriveCriterionResult`: these two fields are copied
        // from what the observation command printed, and they are persisted to `result.json`
        // and printed to a terminal exactly like evidence is. `redactText` is idempotent.
        expected: redactText(assertion.expected, options),
        actual: read.found
          ? redactText(read.value, options)
          : redactText(this.#absence(assertion), options),
      };
    });
  }

  /**
   * What to report when a path did not resolve. Never `0`, never `''`.
   *
   * Redacted by the caller like every other value that reaches `actual`, even though the
   * only untrusted text here is a JSON path from the plan rather than captured output.
   * That is the fail-closed direction and it costs nothing: `redactText` is idempotent, a
   * plan is provider-authored, and a rule of "redact everything that lands in this field"
   * is one a reviewer can check by eye — whereas "redact this field except on the branch
   * where the value came from somewhere we currently believe is safe" is one that quietly
   * stops being true the first time somebody widens what a path may contain.
   */
  #absence(assertion: ObservationAssertionSpec): string {
    return assertion.phase === 'delta'
      ? `absent: '${assertion.path}' is missing or non-numeric in one of the two snapshots`
      : `absent: '${assertion.path}' is not present in the snapshot`;
  }

  /** Reads the value one assertion compares, for its declared phase. */
  #actualFor(
    assertion: ObservationAssertionSpec,
    before: Snapshot,
    after: Snapshot | undefined,
  ): Read {
    switch (assertion.phase) {
      case 'snapshot':
      case 'before':
        return readPath(before.parsed, assertion.path);

      case 'after':
        return after === undefined ? { found: false } : readPath(after.parsed, assertion.path);

      case 'delta': {
        if (after === undefined) {
          return { found: false };
        }
        const start = readPath(before.parsed, assertion.path);
        const end = readPath(after.parsed, assertion.path);
        if (!start.found || !end.found) {
          return { found: false };
        }
        const from = numeric(start.value);
        const to = numeric(end.value);
        // A non-numeric side is ABSENT, not zero. This is the exact spot where defaulting
        // would make `0 - 0 == 0` report green for a command that produced nothing.
        if (from === undefined || to === undefined) {
          return { found: false };
        }
        return { found: true, value: String(to - from) };
      }

      default: {
        const unreachable: never = assertion.phase;
        return malformed(`unknown phase '${String(unreachable)}'`);
      }
    }
  }
}
