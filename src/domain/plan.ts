/**
 * AD-5 / FR-16 — the Verification Plan model: the bridge from WHAT to HOW.
 *
 * A Contract says what must be true. A Plan says how each of those statements will be
 * checked, mechanically, with no LLM in the loop ever again (FR-18). It is compiled once
 * from a FROZEN contract by the `plan-author` provider, persisted as reviewable YAML at
 * `.specwitness/plans/<epic>.yaml`, committed to the target project's git (Q11), and from
 * then on it is the executable artifact.
 *
 * ── WHO READS THIS FILE ────────────────────────────────────────────────────────────────
 *
 * Four stories execute from this model and none of their authors can ask its author a
 * question: 4.3 (deterministic data), 4.4 (http executor), 4.5 (observation executor),
 * 4.6 (shell executor), plus Epic 5 for `browser`. Every field below therefore says what
 * it is for, who produces it and who consumes it. That density is the point, not decoration
 * — it is the only channel this story has to those stories.
 *
 * ── THE THREE PROPERTIES THAT MAKE A PLAN SAFE ─────────────────────────────────────────
 *
 * 1. **CRITERIA BY ID ONLY (AD-5).** A `PlanCriterion` carries a `criterionId` and there is
 *    NO field anywhere in this model that can hold a criterion's statement text. Two
 *    load-bearing reasons: the statement is fingerprinted contract content, so a second
 *    copy is a copy that can drift from its authority; and a renderer reading statements
 *    from the plan would report what the PLAN thinks a criterion says rather than what the
 *    CONTRACT says. `deriveCriterionResult` already receives `statement` from
 *    `ContractCriterionRef`, recorded by the integrity stage from the verified contract.
 *
 * 2. **NOTHING HERE CAN HOLD A COMMAND STRING (AD-3).** Executables are referenced by
 *    config id (`ShellProbeMechanics.commandId`, `ObservationProbeMechanics.commandId`),
 *    never by command line, and there is no host or absolute-URL field on the http probe
 *    either — an http probe names a declared SERVICE and a service-relative path, so a plan
 *    cannot be pointed at production (AD-3, "no production URL defaults").
 *    `src/config/declared-command.ts` states the same property from the other end:
 *    "nothing a provider CLI authored can become an executable command. Provider-drafted
 *    plans reference executables by config id, never by command string." This model is the
 *    half of that sentence AD-3 was waiting for.
 *
 * 3. **EVERY PROBE ADJUDICATES SOMETHING.** `ProbeSpec.assertions` is non-empty — enforced
 *    by the zod mirror, since a readonly array type cannot express it. An assertion-free
 *    probe executes, observes nothing, and reaches the branch in `outcomeOf`
 *    (`domain/criterion-result.ts`) whose comment says "a compiled plan always gives a
 *    probe at least one assertion, so in practice this is unreachable; it is here so that
 *    the unreachable case is safe rather than merely lucky". This model is what makes that
 *    sentence true.
 *
 * ── MECHANICS vs ASSERTIONS, for Epic 5 ────────────────────────────────────────────────
 *
 * Every probe splits into `mechanics` (HOW to look: which service, which path, which
 * command id, which locator) and `assertions` (WHAT must be true). The split is structural
 * so that Epic 5's mechanics-adaptation flow (FR-18, story 5.6) can be written to touch one
 * sub-object and not the other: **a mechanics adaptation may alter mechanics fields only;
 * assertion and expected-value fields are structurally read-only in that flow.** AI may
 * adapt HOW, never WHAT.
 *
 * ── AD-1 ───────────────────────────────────────────────────────────────────────────────
 *
 * Pure. This module imports one sibling domain module (`criterion-result.js`, for the
 * merged `PROBE_SURFACES`) and nothing else — no zod, no node builtin, no other layer.
 * The zod mirror is `src/schemas/plan.ts` and it DERIVES its enums from the arrays here,
 * so the two cannot drift.
 *
 * ── AD-9 ───────────────────────────────────────────────────────────────────────────────
 *
 * No timestamp helper and no default that reads a clock. Every instant in this model
 * arrives as a string an edge computed from the injected `Clock`.
 */

import type { ProbeSurface } from './criterion-result.js';
import type { NeedsHumanReason } from './result.js';

/**
 * How an assertion compares what it observed with what the plan expected.
 *
 * CLOSED, and deliberately small. Each entry is something a `SurfaceExecutor` can evaluate
 * with no ambiguity and no interpreter, because assertions are DATA and never code
 * (AD-13). Widening this list is an ADR in `docs/adr/`, not an edit — every executor
 * switches on it exhaustively.
 *
 * - `equals` / `notEquals`     — exact string comparison of the rendered actual value.
 * - `contains` / `notContains` — substring of the rendered actual value.
 * - `greaterThan` / `lessThan` — numeric; both sides must parse as finite numbers, and an
 *   actual value that does not is an unsatisfied assertion, never a crash.
 *
 * THERE IS DELIBERATELY NO REGULAR-EXPRESSION COMPARISON, and this is a security decision
 * rather than an omission. The expected value is text a provider CLI wrote; a pattern
 * comparison would hand every surface executor an untrusted regular expression to run
 * against untrusted output, which is catastrophic backtracking (ReDoS) with a hostile
 * author and no timeout in sight. The comparisons above cover every assertion the epic's
 * acceptance criteria name — status codes, header values, JSON-path values, exit codes and
 * command output. If a later story genuinely needs pattern matching, it arrives with a
 * mitigation and an ADR, not as a quiet seventh entry here.
 */
export const ASSERTION_COMPARISONS = Object.freeze([
  'equals',
  'notEquals',
  'contains',
  'notContains',
  'greaterThan',
  'lessThan',
] as const);

export type AssertionComparison = (typeof ASSERTION_COMPARISONS)[number];

/**
 * Why a criterion is carried as needs-human rather than compiled into probes.
 *
 * DEFINED IN `domain/result.ts` and re-exported here, where the plan's own consumers have
 * always found it. It moved when story 5.3 carried the reason onto `DerivedCriterionResult`
 * so a report could tell a reviewer WHY a criterion is theirs to answer: this module
 * already imports `ProbeSurface` from `criterion-result.ts`, so a `criterion-result.ts`
 * import of the reason the other way would be a cycle — and a cycle means the layer
 * boundary is already gone. The result taxonomy is a true leaf that imports nothing at
 * all, which makes it the one home both directions can reach.
 *
 * The vocabulary itself is unchanged, and so is its meaning: Q39's TWO — and only two —
 * NEEDS_HUMAN triggers, both seen from compile time. Execution-time uncertainty is
 * NEITHER; it is criterion `error`.
 */
export { NEEDS_HUMAN_REASONS } from './result.js';
export type { NeedsHumanReason } from './result.js';

/**
 * HTTP methods an http probe may use.
 *
 * Closed rather than free text so that a draft cannot name a method the executor has never
 * seen. `TRACE` and `CONNECT` are deliberately absent: neither has a use in verifying an
 * application's behaviour, and `TRACE` in particular is a request type most deployments
 * disable on purpose.
 */
export const HTTP_METHODS = Object.freeze([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
] as const);

export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * One mechanically evaluable expectation, as DATA.
 *
 * Shaped so a `SurfaceExecutor` can fill `AssertionEvaluation {description, satisfied,
 * expected?, actual?}` (AD-13) without inventing anything:
 *
 *   - `description` is copied verbatim into `AssertionEvaluation.description`. It is what
 *     a human reads in the report, so it is a sentence, not a field name.
 *   - `expected` is copied verbatim into `AssertionEvaluation.expected`. Always a STRING,
 *     even for a status code or a count, for the same reason `Observation.value` is: this
 *     is persisted to `result.json`, and a model admitting non-serialisable values is a
 *     model whose serializer eventually throws on real data.
 *   - `satisfied` and `actual` are the executor's to fill; there is nowhere here to put
 *     them, which is the point — a plan states expectations and never outcomes.
 *
 * `target` says WHAT to read and is surface-specific, so each executor knows exactly what
 * it is being asked for and can switch exhaustively.
 */
export interface Assertion<TTarget> {
  /** A sentence a human reads in the report. Copied into `AssertionEvaluation`. */
  readonly description: string;
  /** What to read. Closed, per-surface union. */
  readonly target: TTarget;
  readonly comparison: AssertionComparison;
  /** What it must be. Copied into `AssertionEvaluation.expected`. Always a string. */
  readonly expected: string;
}

/* ── http (story 4.4) ────────────────────────────────────────────────────────────────── */

/**
 * What an http assertion reads from the response (Q33: status / headers / JSON-path
 * values).
 *
 * - `status`   — the numeric status code, rendered as a decimal string (`"200"`).
 * - `header`   — one response header by name; matching is case-insensitive, as HTTP headers
 *   are. An absent header is an unsatisfied assertion, never a crash.
 * - `body`     — the response body as text, after AD-10 redaction and the size cap 4.4 sets.
 * - `jsonPath` — one value out of a JSON body.
 */
export type HttpAssertionTarget =
  | { readonly source: 'status' }
  | { readonly source: 'header'; readonly name: string }
  | { readonly source: 'body' }
  | { readonly source: 'jsonPath'; readonly path: string };

/**
 * How to issue one HTTP request (story 4.4 executes this).
 *
 * **THERE IS NO `url` FIELD AND THERE MUST NEVER BE ONE.** A probe names a declared
 * SERVICE and a service-relative path; story 4.1's base-URL resolution turns `serviceId`
 * into an origin from the project's own config at execution time. That is AD-3's "no
 * production URL defaults" expressed structurally: a plan a hostile provider drafted cannot
 * be pointed at a host, because there is nowhere to write one.
 */
export interface HttpProbeMechanics {
  /**
   * A key under `services:` in `.specwitness/config.yaml`, verbatim.
   *
   * Confirmed with story 4.1 at cohort intent-sync: a service id is exactly its config key
   * — never renamed, normalised, prefixed or derived — and 4.1's base-URL resolver takes
   * this value as-is.
   */
  readonly serviceId: string;
  readonly method: HttpMethod;
  /** Service-relative, leading `/`, no scheme and no authority. Never absolute. */
  readonly path: string;
  /** Request headers, verbatim. Redacted at capture when they reach evidence (AD-10). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Request body as text. `undefined` means no body, which is not the same as `""`. */
  readonly body?: string;
}

export interface HttpProbe {
  readonly id: string;
  readonly surface: 'http';
  readonly mechanics: HttpProbeMechanics;
  readonly assertions: readonly Assertion<HttpAssertionTarget>[];
}

/* ── browser (Epic 5) ────────────────────────────────────────────────────────────────── */

/**
 * What a browser assertion reads from the page.
 *
 * Epic 5 owns the executor; this is the minimum that lets a plan express a UI expectation
 * today. Extending it is Epic 5's additive follow-up, not a widening anyone in Epic 4 does.
 */
export type BrowserAssertionTarget =
  | { readonly source: 'url' }
  | { readonly source: 'title' }
  | { readonly source: 'text'; readonly selector: string }
  | { readonly source: 'visible'; readonly selector: string };

/**
 * How to drive a browser (Epic 5 story 5.2 executes this; NOTHING executes it in Epic 4).
 *
 * `scenario` is prose describing the interaction, from which Epic 5 generates an ephemeral
 * Playwright spec in the run directory (Q30/Q31). **It is untrusted provider text**, and
 * Epic 5 must treat it as such: it may become a generated spec run by Playwright, and it
 * may never become a shell string or reach `ProcessRunner` as a command. The same origin
 * rule as http applies — a service id plus a relative path, never a URL.
 */
export interface BrowserProbeMechanics {
  readonly serviceId: string;
  /** Service-relative starting path, leading `/`. */
  readonly path: string;
  /** Prose the Epic 5 executor turns into an ephemeral spec. Untrusted text. */
  readonly scenario: string;
}

export interface BrowserProbe {
  readonly id: string;
  readonly surface: 'browser';
  readonly mechanics: BrowserProbeMechanics;
  readonly assertions: readonly Assertion<BrowserAssertionTarget>[];
}

/* ── observation (story 4.5) ─────────────────────────────────────────────────────────── */

/**
 * Which snapshot of an observation an assertion reads (Q34, brief §34).
 *
 * `snapshot` is the standalone case. `before`, `after` and `delta` exist only when the
 * probe's `around` names another probe: `delta` is the numeric difference `after - before`
 * of the value at `path`, which is how "exactly one row was created" becomes
 * `{path: '$.count', phase: 'delta', comparison: 'equals', expected: '1'}` — brief §35's
 * worked example, expressed as data.
 */
export type ObservationPhase = 'snapshot' | 'before' | 'after' | 'delta';

/**
 * What an observation assertion reads.
 *
 * Observation commands MUST emit JSON to stdout (Q35); output that is not JSON makes the
 * criterion `error`, never a silent pass or fail. So there is exactly one target source
 * here, and it is a JSON path.
 */
export interface ObservationAssertionTarget {
  readonly source: 'jsonPath';
  readonly path: string;
  readonly phase: ObservationPhase;
}

/**
 * Which declared observation command to run, and around what (story 4.5 executes this).
 *
 * `commandId` is a key under `observations:` in `.specwitness/config.yaml`, resolved by the
 * merged `getObservationCommand` in `src/config/types.ts` — whose own doc says an unknown
 * id "means a plan referenced an observation the project never declared, and quietly
 * substituting anything would be a hole in the AD-3 boundary". This model is that doc's
 * "a plan".
 */
export interface ObservationProbeMechanics {
  /** A key under `observations:`. NEVER a command line — see the module header. */
  readonly commandId: string;
  /** argv appended to the declared command. Never shell-interpreted (see `ShellProbeMechanics`). */
  readonly args: readonly string[];
  /**
   * The `id` of ANOTHER probe in the same criterion, which this observation wraps: the
   * command runs once before that probe and once after, producing the `before`/`after`
   * snapshots the `delta` phase compares (Q34). `undefined` means a standalone snapshot.
   */
  readonly around?: string;
}

export interface ObservationProbe {
  readonly id: string;
  readonly surface: 'observation';
  readonly mechanics: ObservationProbeMechanics;
  readonly assertions: readonly Assertion<ObservationAssertionTarget>[];
}

/* ── shell (story 4.6) ───────────────────────────────────────────────────────────────── */

/** What a shell assertion reads: the exit code, or one of the two output streams. */
export type ShellAssertionTarget =
  | { readonly source: 'exitCode' }
  | { readonly source: 'stdout' }
  | { readonly source: 'stderr' };

/**
 * Which declared command to run and with which arguments (story 4.6 executes this).
 *
 * `commandId` is a key under `observations:` — the project's one map of declared commands a
 * plan may reference. It is NEVER a command line; the schema constrains it to an id-shaped
 * token so a command cannot be smuggled through the field.
 *
 * THE ARGUMENT ALLOWLIST. `argumentAllowlist` is the reviewed statement of every argument
 * this probe is permitted to pass, and the schema enforces that `args` is a subset of it.
 * Story 4.6's acceptance criterion asks for the same rule again at run time ("schema +
 * runtime double enforcement"), which is deliberate: the schema stops a hostile draft from
 * being written, and the runtime check stops a hand-edited plan file from being executed.
 *
 * `args` are argv elements, not a command line. The merged path from a `DeclaredCommand` to
 * a child process (`pipeline/stages/gate-command.ts` -> `ProcessRunner.run(binary, args)`)
 * has no shell in it and no way to add one, so `;`, `&&` and `$(...)` inside an argument
 * arrive at the child as literal text. That is what makes an allowlist a review surface
 * rather than the only thing standing between a draft and a shell.
 */
export interface ShellProbeMechanics {
  /** A key under `observations:`. NEVER a command line — see the module header. */
  readonly commandId: string;
  /** argv appended to the declared command. Every entry must appear in `argumentAllowlist`. */
  readonly args: readonly string[];
  /** Every argument this probe may ever pass. Reviewed by a human in the committed plan. */
  readonly argumentAllowlist: readonly string[];
}

export interface ShellProbe {
  readonly id: string;
  readonly surface: 'shell';
  readonly mechanics: ShellProbeMechanics;
  readonly assertions: readonly Assertion<ShellAssertionTarget>[];
}

/**
 * The CLOSED probe union (AD-3, AD-13), discriminated by `surface`.
 *
 * It matches the merged `PROBE_SURFACES` in `domain/criterion-result.ts` EXACTLY — the type
 * aliases at the bottom of this file prove it at compile time in both directions, and
 * `tests/unit/schemas/plan-surfaces.test.ts` proves the same of the zod mirror at run time.
 * Widening it is an ADR, not an edit.
 *
 * `browser` is in the union and the schema accepts it; Epic 5 implements the executor.
 * A plan may name it this epic; nothing executes it.
 */
export type ProbeSpec = HttpProbe | BrowserProbe | ObservationProbe | ShellProbe;

/** The `surface` discriminant of the probe union. */
export type ProbeSpecSurface = ProbeSpec['surface'];

/* ── deterministic data (AD-9 / Q36 — story 4.3 gives these meaning) ─────────────────── */

/**
 * One scenario input, resolved AT COMPILE TIME and stored in the plan (AD-9, FR-17, Q36).
 *
 * The reproducibility rule this exists for: two verify runs of the same plan against the
 * same revision must issue byte-identical probe inputs, "modulo timestamps/ids explicitly
 * declared volatile". So a binding is one of exactly two things, and the union is
 * discriminated so the difference is structural rather than a convention:
 *
 * - `fixed` carries a `value` decided once, at compile time, and used verbatim every run.
 *   It is included in the reproducibility comparison.
 * - `volatile` carries NO value at all. It names an input that legitimately differs run to
 *   run (a unique email, an idempotency key), derived by story 4.3 from the plan's recorded
 *   `seed` plus the run identity. It is EXCLUDED from the reproducibility comparison, and
 *   `reason` is the human-readable justification a reviewer reads before accepting that
 *   exclusion — an undeclared volatile field is how a plan silently stops being
 *   reproducible.
 *
 * **STORY 4.3 OWNS THE SEMANTICS; 4.2 OWNS ONLY THE FIELDS.** How a volatile value is
 * derived from the seed, and how a binding's `name` is substituted into probe mechanics,
 * are 4.3's decisions. 4.3 launches after 4.2 has merged and cannot ask; if it needs a
 * field this shape does not have, the mechanism is a follow-up PR or a message to the
 * owner, never a parallel edit to `src/schemas/plan.ts`.
 */
export type DataBinding =
  | {
      readonly kind: 'fixed';
      /** Referenced by name from probe mechanics. Substitution semantics are 4.3's. */
      readonly name: string;
      /** The compile-time-resolved value, used verbatim on every run. */
      readonly value: string;
    }
  | {
      readonly kind: 'volatile';
      readonly name: string;
      /** Why this input cannot be fixed. Read by a human reviewing the committed plan. */
      readonly reason: string;
    };

/**
 * The plan's deterministic-data block (AD-9, Q36).
 *
 * `seed` is the per-plan recorded seed: one string, decided at compile time and never
 * regenerated, from which story 4.3 derives every volatile value. Recording it in the plan
 * rather than in the run is what makes a volatile input reproducible-by-derivation rather
 * than merely random — two runs of the same plan derive from the same seed.
 */
export interface PlanData {
  readonly seed: string;
  readonly bindings: readonly DataBinding[];
}

/* ── criteria ────────────────────────────────────────────────────────────────────────── */

/**
 * How one criterion is verified. Discriminated on `disposition`, and the discrimination is
 * the enforcement.
 *
 * A `needs-human` entry HAS NO `probes` KEY — not an empty one, none. So "a probe may not
 * adjudicate a human criterion" is a property of the type rather than a check somebody has
 * to remember to run. Epic 3 caught and reverted a well-meaning variant that let a probe
 * decide a human criterion when it had attempts to show; review called it a silent redesign
 * of a recorded decision. If a later epic wants that, the route is an ADR in `docs/adr/`.
 *
 * An `automated` entry has at least one probe (enforced in the zod mirror, since a readonly
 * array type cannot express non-emptiness). Between the two arms there is no third state,
 * so every criterion in a compiled plan is either checked or explicitly deferred to a human
 * — and compilation refuses to write a plan that omits a contract criterion entirely, which
 * is the only remaining way one could disappear.
 */
export type PlanCriterion =
  | {
      /** Canonical criterion id, `E<n>-<NN>`. NEVER accompanied by its statement (AD-5). */
      readonly criterionId: string;
      readonly disposition: 'automated';
      readonly probes: readonly ProbeSpec[];
    }
  | {
      readonly criterionId: string;
      readonly disposition: 'needs-human';
      readonly reason: NeedsHumanReason;
      /** What a reviewer must look at to decide. FR-16 calls this "reviewer guidance". */
      readonly guidance: string;
    };

/**
 * Which contract this plan was compiled from (AC1, AC3).
 *
 * Both fields are stored and they answer different questions. `fingerprint` is what the
 * staleness check compares — the mechanical identity of the contract's content. `version`
 * is what a human reads in a diff, and is meaningless to the comparison. Storing only one
 * would either make the refusal impossible or make the file unreadable.
 *
 * Neither is recomputed here: `schemas/canonical.ts` is the single hasher, and
 * `.dependency-cruiser.cjs`'s `schemas-canonical-is-the-only-hasher` rule keeps it that way.
 */
export interface PlanContractRef {
  /** The contract's integer `spec.version` at compile time. */
  readonly version: number;
  /** The contract's `meta.fingerprint` at compile time. Lowercase hex SHA-256. */
  readonly fingerprint: string;
}

/**
 * The content half of a plan: what will be executed.
 *
 * NOT fingerprinted, and nothing in this product hashes it. Plans are regenerable from
 * their contract, which is the artifact that carries authority; a plan's integrity question
 * is "was it compiled from THIS contract", answered by `contract.fingerprint`, and not "has
 * anyone edited it". Splitting `plan` from `meta` here is symmetry with `Contract` plus
 * readability — a reviewer reads the content before the bookkeeping — and deliberately not
 * a hashing boundary. Do not infer one.
 */
export interface PlanSpec {
  /** Canonical epic id (`epic-7`), normalised by `domain/ids.ts`. */
  readonly epic: string;
  readonly contract: PlanContractRef;
  readonly data: PlanData;
  /**
   * One entry per contract criterion. Order follows the contract, so a plan diff reads
   * alongside the contract it came from.
   */
  readonly criteria: readonly PlanCriterion[];
}

/**
 * How a plan came to exist (AD-5, Q65).
 *
 * The SAME shape as `ContractProvenance`, deliberately: story 3.8 established it, and a
 * second provenance shape would be a second thing an auditor has to learn. Every field is
 * `| null` and an unknown value is written as an explicit `null`, never omitted — an absent
 * key is indistinguishable from a key an older writer never knew about.
 *
 * `model` is null on every path today and that is honest rather than lazy:
 * `src/cli/contract/provenance.ts` records at length why no adapter can report one through
 * the fixed AD-2 envelope. `ProviderUsage` in `domain/run-result.ts` puts the rule
 * plainly — "a guessed model string in an audit field is worse than an honest null".
 */
export interface PlanProvenance {
  readonly provider: string | null;
  readonly model: string | null;
  /** The AGENT CLI's version (`claude --version`), never SpecWitness's own. */
  readonly providerCliVersion: string | null;
  /** ISO-8601 UTC. */
  readonly generatedAt: string | null;
}

/** The bookkeeping half. */
export interface PlanMeta {
  /** From the AD-5 registry, `SCHEMA_VERSIONS.plan`. */
  readonly schemaVersion: number;
  /** ISO-8601 UTC, from the injected `Clock` at the edge. */
  readonly compiledAt: string;
  readonly provenance: PlanProvenance;
}

/**
 * A whole plan: exactly two top-level keys, `plan` and `meta`.
 *
 * A third would have to be content or bookkeeping, and the zod mirror is strict at every
 * level so an unknown key is an error naming its path rather than a silent drop. In an
 * artifact that drives processes and issues requests, a key nobody understands is not
 * something to shrug at.
 */
export interface Plan {
  readonly plan: PlanSpec;
  readonly meta: PlanMeta;
}

/**
 * Compile-time proof that the probe union covers exactly the merged `PROBE_SURFACES`.
 *
 * Both directions are asserted because each catches a different failure: a surface added to
 * `PROBE_SURFACES` with no probe shape here, and a probe shape here for a surface the AD-13
 * execution contract does not know about. A one-directional check silently passes one of
 * them. Widening the union without widening the other side stops compiling here rather than
 * failing later in an executor's exhaustive switch.
 */
export type ProbeUnionAgreesWithExecutionContract = ProbeSpecSurface extends ProbeSurface
  ? ProbeSurface extends ProbeSpecSurface
    ? true
    : never
  : never;

/** `true` only when the two directions above both hold. Referenced by the schema tests. */
export const PROBE_UNION_AGREES: ProbeUnionAgreesWithExecutionContract = true;
