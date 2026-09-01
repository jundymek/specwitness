/**
 * AD-13 / FR-23 / FR-28 — the http surface executor. Story 4.4.
 *
 * This is the workhorse surface, and that is an architectural preference rather than an
 * accident of ordering: the lowest-adequate-surface rule (brief §32, FR-16, Q37) says an
 * HTTP-checkable criterion yields an HTTP probe and NOT a browser probe, because most
 * epic-level behavioural claims about a web application are claims about its API.
 *
 * It is also the FIRST producer of the `http` evidence kind, which `domain/evidence.ts`
 * declared and left unused on purpose, and the first executor of any surface — so the shape
 * here is the shape stories 4.5, 4.6 and Epic 5's browser executor follow. It was settled
 * with 4.5 and 4.6 at cohort intent-sync rather than invented here; the paragraphs marked
 * COHORT RULE record decisions all three surfaces implement identically, so that 4.7's
 * surface-conformance test has one shape to compare rather than three.
 *
 * ============================================================================
 * THE TWO THINGS THIS FILE DOES NOT DO
 * ============================================================================
 *
 * 1. IT NEVER PRODUCES A `CriterionStatus`. It evaluates assertions mechanically and
 *    reports what it saw; `deriveCriterionResult` alone decides what that means, including
 *    retry orchestration and `flaky`. `criterion-result.ts` explains why one producer:
 *    four surfaces each adjudicating status their own way would give four subtly different
 *    answers to "did a retry that eventually passed count as flaky", and the differences
 *    would only ever surface as a verdict nobody could reproduce.
 *    `tests/unit/surfaces/http-shape.type.test.ts` makes that a COMPILE error rather than a
 *    convention.
 *
 * 2. IT NEVER RETRIES. One attempt per `execute()` call, stamped with the 1-based `attempt`
 *    the caller passes. Whoever orchestrates retries calls this N times (AD-9, Q43/Q44).
 *
 * ============================================================================
 * COULD NOT LOOK vs LOOKED AND SAW WRONG — the distinction the story exists for
 * ============================================================================
 *
 * The probe LOOKED and saw the wrong value  => an unsatisfied `AssertionEvaluation`
 *                                           => criterion `fail`   => exit 1 (product).
 * The probe COULD NOT LOOK at all           => `execError`
 *                                           => criterion `error`  => exit 3 (infra).
 *
 * A probe that could not look is not the same as a probe that looked and saw a violation,
 * and the day those two are conflated is the day a flaky environment starts blocking
 * mergeable branches. `outcomeOf` in the merged derivation makes `execError` outrank any
 * assertion, so on that path this file emits NO `AssertionEvaluation` at all — reporting
 * one would manufacture product evidence out of an infrastructure failure.
 *
 * Q39 forecloses the tempting third option: execution-time uncertainty is `error`, NEVER
 * `needs_human`. There are exactly two NEEDS_HUMAN triggers and both are compile-time.
 * Nothing observed here can create a third, and nothing here special-cases
 * `verifiability: human` — the derivation answers that before it looks at attempts at all.
 *
 * A THIRD CLASS, kept deliberately distinct from both: a MALFORMED REQUEST. Params that do
 * not match, a path a plan may not express, a JSON-path syntax this executor does not
 * implement. Those are wiring or tooling defects — SpecWitness being wrong, not the
 * environment being broken and not the branch being broken — so they throw `InfraError`
 * BEFORE any I/O. Both routes end at exit 3; only one is honest about whose fault it is,
 * and disguising a bug of ours as an `execError` would make it read as an environment
 * flake. (COHORT RULE: 4.5 and 4.6 do the same, arnold's `ConfigError` for a rejected
 * argument being the same reasoning applied to a bad plan.)
 *
 * ============================================================================
 * WHY THE CALLER RESOLVES THE URL (AD-3, AD-1)
 * ============================================================================
 *
 * `HttpProbeMechanics` has no `url` field and must never have one: a plan names a declared
 * SERVICE plus a service-relative path, so a plan a hostile provider drafted cannot be
 * pointed at a host, because there is nowhere to write one. 4.1's `resolveServiceBaseUrl`
 * turns `serviceId` into an origin from the project's own config.
 *
 * This executor does NOT call it. `adapters-core-only` forbids `src/surfaces/**` from
 * importing `src/config/**`, so the caller resolves and passes the base URL in — exactly
 * as `ProviderDescriptor` describes for the same problem one adapter over. That is not a
 * workaround for the rule; it is the rule's point. Values arrive resolved, and the
 * executor's own reach is limited to what it was handed.
 *
 * REDIRECTS ARE NOT FOLLOWED (`redirect: 'manual'`). Two reasons, both load-bearing. A
 * followed redirect leaves the declared service's origin, which is the one thing AD-3
 * exists to prevent, and it replays the plan's request headers — an `Authorization` header
 * among them — to whatever host the response named. A 3xx is therefore an observation like
 * any other: a plan that expects one asserts `status equals 302`.
 *
 * ============================================================================
 * EVIDENCE (AD-10, FR-28) — the COHORT RULE, verbatim
 * ============================================================================
 *
 * Evidence follows whether an OBSERVATION exists — not whether output was non-empty, not
 * whether it was truncated, and not whether the attempt errored. An attempt that observed
 * anything calls `recordEvidence(member)` with the member built through the merged
 * constructor, writes the serialized member to `evidence/<surface>-<slug>-<attempt>.json`
 * and refs it, and additionally writes and refs a full redacted copy of each captured
 * stream that is non-empty after redaction, passing that path as that stream's `fullPath`.
 * An attempt that observed nothing calls `recordEvidence` not at all, writes no file, and
 * refs nothing.
 *
 * WHAT "OBSERVED SOMETHING" RESOLVES TO ON THIS SURFACE (the per-surface table 4.7 needs;
 * 4.6 publishes the same table over `ProcessOutcome`):
 *
 *   a response was received  => OBSERVED, always. Any status, an empty body included: a
 *                               204 carries a real status, which is a real observation even
 *                               though no byte of body exists.
 *   no response at all       => OBSERVED NOTHING. Connection refused, DNS failure, TLS
 *                               failure, or a timeout that fired before any headers.
 *   timeout AFTER headers    => OBSERVED. A real status, real headers and real bytes
 *                               arrived; the body simply never finished. `execError` is set
 *                               and ZERO assertions are evaluated — the observation is
 *                               incomplete, so nothing may be adjudicated from it — but the
 *                               partial response IS the diagnostic and it is captured, with
 *                               `explanation` naming the truncation.
 *
 * TWO CHANNELS, because they do two different jobs. `recordEvidence` carries the typed,
 * bounded, redacted MEMBER to `RunResult.evidence`, whose merged comment is explicit that
 * refs alone "would discard the redacted, bounded content at the moment it was constructed,
 * and a renderer whose signature is `(result: RunResult) => string` could then only show
 * that content by reading the file — which AD-11 forbids and its signature makes
 * impossible". `ProbeAttempt.evidence` carries REFS to the files on disk. A design with
 * only the refs would have shipped an epic whose reports contain gate evidence and no probe
 * evidence, green the whole way, because no surface test drives a renderer. Found by 4.6 at
 * intent-sync and verified against merged source by all three of us before it was adopted.
 *
 * The member file is written even though `recordEvidence` already carries the same content
 * into `result.json`. That duplication is deliberate: FR-28 requires at least one evidence
 * reference on EVERY non-pass result, and refs pointing only at full-copy files would make
 * that true whenever a payload happened to be large and false when it was small — a
 * guarantee by coincidence. The member file makes it true by construction, and it is also
 * the artifact a human opens, the run directory being the browsable per-attempt record next
 * to `result.json`'s one aggregate document.
 *
 * REDACTION HAPPENS AT CAPTURE, through the merged constructors, which is the only
 * non-hand-written path into the union. Three specifics worth stating because each is a
 * hole somebody has actually fallen into:
 *
 *   - THE FULL COPY GOES THROUGH `redactText` FIRST. `boundedText` redacts the INLINE copy
 *     only, so writing raw bytes to the file would leave the inline evidence spotless and
 *     the file beside it holding the credential verbatim — with the obvious seeded-secret
 *     test, which inspects the evidence, passing green over exactly that hole.
 *   - THE URL IS EVIDENCE TOO. `?api_key=…` in a captured URL is a leak sitting next to a
 *     properly redacted header. `httpEvidence` runs the URL through `redactText`; so does
 *     every error message this file builds.
 *   - A SINGLE EXTRACTED VALUE HAS NO ASSIGNMENT SHAPE. `redactText` finds `api_key=…` in a
 *     body, but the string `sw-secret-…` on its own — which is what a jsonPath or header
 *     assertion's `actual` holds — looks like any other text. `namedValue()` below closes
 *     that by redacting the value through `redactHeaders` under its own name, so the
 *     sensitivity rule is literally the same function the constructors use and cannot drift
 *     from it.
 *
 * `{shellCommand: true}` is never passed here, and there is nothing it could apply to: an
 * http probe involves no shell at all, so every byte captured is UNDECLARED — the
 * fail-closed default (Epic 3 retro §6).
 *
 * ============================================================================
 * ASSERTIONS ARE DATA
 * ============================================================================
 *
 * Status, header and JSON-path comparisons are all driven by the plan's declarations, over
 * the six merged `ASSERTION_COMPARISONS`. Nothing is interpreted, nothing is inferred, and
 * no AI is consulted — "never ask an LLM whether it passes" is the product's first
 * non-negotiable rule. There is deliberately no regular-expression comparison; `plan.ts`
 * records why (ReDoS with a hostile author and no timeout in sight).
 *
 * A VALUE THAT IS NOT THERE IS AN UNSATISFIED ASSERTION, for every comparison including the
 * negative ones. A missing header does not satisfy `notEquals`, and an unresolved JSON path
 * does not satisfy `notContains`. Both are expectations ABOUT a value, and a value that
 * does not exist cannot meet one; the alternative mints a PASS out of an absence, which is
 * the one direction this product must never fail in — the same reasoning `outcomeOf` gives
 * for refusing to pass a probe that adjudicated nothing.
 *
 * A RESPONSE BODY THAT IS NOT JSON, under a jsonPath assertion, is an UNSATISFIED ASSERTION
 * naming the content type and the first bytes — not an `execError`. The server answered and
 * the answer was wrong, which is a fact about the product.
 *
 * This is deliberately DIFFERENT from 4.5's rule, where an observation command's non-JSON
 * output is criterion `error` (Q35), and the asymmetry is a decision rather than an
 * inconsistency: WHO DECLARED THE EXPECTATION decides which kind of failure it is. For an
 * observation command, JSON is a contract the project OWNER declared in config, so breaking
 * it means the environment is broken. Here, JSON is an expectation the PLAN asserted about
 * a response, so breaking it means the product is wrong. The same principle covers 4.6: a
 * non-zero exit is a normal evaluation there, because its assertion is explicit and comes
 * from the plan, while the gates stage treats non-zero as failure because a gate's implicit
 * assertion is "exit 0". Three surfaces, three rules, one principle.
 *
 * AD-1: an adapter. Imports `src/domain/**` and npm only — never `src/config/**`, never an
 * application layer, never the edge.
 */

import {
  evidenceRef,
  httpEvidence,
  redactHeaders,
  redactText,
  type Evidence,
  type EvidenceRef,
  type RedactionOptions,
} from '../domain/evidence.js';
import { InfraError } from '../domain/errors.js';
import type {
  AssertionEvaluation,
  Observation,
  ProbeAttempt,
  ProbeExecError,
  ProbeRequest,
  SurfaceExecutor,
} from '../domain/criterion-result.js';
import { HTTP_METHODS } from '../domain/plan.js';
import type {
  Assertion,
  AssertionComparison,
  HttpAssertionTarget,
  HttpProbe,
} from '../domain/plan.js';
import type { Clock } from '../domain/ports.js';

/**
 * How long one HTTP probe may take before the attempt is abandoned as inconclusive.
 *
 * Thirty seconds, chosen rather than guessed, and deliberately far above 4.1's
 * `READINESS_REQUEST_TIMEOUT_MS` of five. Readiness is a liveness ping against an endpoint
 * whose only job is to answer instantly; a probe exercises real application behaviour that
 * may do real work — a query, a write, a cold code path on a loaded machine. A cap that
 * fires on a healthy-but-slow endpoint converts honest work into a spurious exit 3, which
 * is the same wrong answer as any other misclassification and the exact failure this story
 * exists to prevent. `GATE_TIMEOUT_MS`'s fifteen minutes is the same reasoning at gate
 * scale.
 *
 * Injectable via `HttpExecutorDeps` so a test asserts the timeout path in milliseconds
 * instead of waiting it out.
 */
export const HTTP_PROBE_TIMEOUT_MS = 30_000;

/**
 * How many bytes of a response body are read before the executor stops reading.
 *
 * A cap is REQUIRED and it is a security control, not a tuning knob. A response body is
 * written by the service under verification, which is untrusted by definition, and
 * `response.text()` will happily buffer a body of any size — so an endpoint that streams
 * forever, or simply returns something enormous, takes the verifier's process down with it.
 * A denial of service triggerable by anything the verified application serves is exactly
 * the shape of the bound `MAX_NESTED_ASSIGNMENT_DEPTH` exists for one module over.
 *
 * One mebibyte: two orders of magnitude above the 8 KiB inline evidence cap, so the full
 * copy on disk stays genuinely more informative than the inline one, and far above any API
 * response an assertion would sensibly read. A body larger than this is truncated at read
 * time, and the evidence's `explanation` says so — over-reporting a bounded observation
 * rather than pretending the whole body was seen.
 */
export const HTTP_BODY_READ_CAP_BYTES = 1_048_576;

/** The run-directory subfolder every evidence file lives in (Q50), shared with gates. */
const EVIDENCE_DIR = 'evidence';

/**
 * Writes one evidence file into the run directory and returns its RELATIVE path.
 *
 * COHORT RULE: all three Epic 4 surfaces take this callback, under this name, with this
 * signature — the merged `GateEvidenceWriter` shape verbatim — so 4.7 binds one thing three
 * times rather than three things once. Structurally identical types are declared per file
 * rather than imported across branches, so each surface compiles whether or not its
 * siblings have merged.
 *
 * The run id is deliberately NOT a parameter: `RunStore` keeps it because it serves every
 * run, an executor drops it because it serves exactly one, so this file cannot address
 * another run's directory even by mistake. AD-8: `RunStore` is the sole writer beneath
 * `.specwitness/runs/`, and nothing here constructs a path there — only a relative name.
 */
export interface SurfaceEvidenceWriter {
  (relativeName: string, contents: string): Promise<string>;
}

/**
 * Hands the typed evidence member to whoever owns the run accumulator.
 *
 * 4.7 binds this to `context.run.evidence.push`, which is literally what `gates.ts` does
 * with its own members. `adapters-core-only` keeps `src/surfaces/**` away from the
 * accumulator by design and prescribes the remedy in its own comment: "If a story needs an
 * adapter-to-adapter call, that is a port in `src/domain/`, injected by the caller." This
 * is that port in its smallest form. It needs no widening of `ProbeAttempt`, which stays
 * AD-13-closed — a dependency is not the interface.
 */
export interface SurfaceEvidenceRecorder {
  (evidence: Evidence): void;
}

/**
 * The HTTP client seam.
 *
 * Node's global `fetch` (>=22.12) by default — the Stack table pins the dependency list and
 * an HTTP library would be a new one for no gain. The seam exists so a caller can supply an
 * instrumented client; the tests do NOT use it, because a mocked client would assert over a
 * mocked outcome value rather than produce the state, and the classification behaviour this
 * story is about is only meaningful when a real socket really refuses.
 */
export interface FetchLike {
  (url: string, init: RequestInit): Promise<Response>;
}

export interface HttpExecutorDeps {
  /** AD-9. The source of `capturedAt` and `durationMs`; `Date.now()` appears nowhere. */
  readonly clock: Clock;
  readonly writeEvidence: SurfaceEvidenceWriter;
  readonly recordEvidence: SurfaceEvidenceRecorder;
  /** Defaults to `HTTP_PROBE_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** Defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
  /** Extra redaction patterns, threaded into every constructor call. */
  readonly redaction?: RedactionOptions;
}

/**
 * What the caller puts in `ProbeRequest.params` for an http probe.
 *
 * `params` is `Readonly<Record<string, unknown>>` on the merged interface, so every surface
 * narrows it itself. This one is hand-validated rather than re-parsed with 4.2's zod schema
 * because `HttpProbeSchema` is module-private in `src/schemas/plan.ts` — verified against
 * merged source, and recorded as an additive follow-up for the owner rather than fixed by
 * editing a merged file. 4.5 and 4.6 hand-validate for the identical reason.
 */
export interface HttpProbeParams {
  /**
   * The compiled probe, with 4.3's deterministic-data bindings ALREADY substituted into
   * `path`, `headers` and `body`. Substitution happens before any executor is invoked: a
   * value substituted after a check is a value that was never checked.
   */
  readonly probe: HttpProbe;
  /** Resolved by the caller from 4.1's `resolveServiceBaseUrl`. Never looked up here. */
  readonly baseUrl: string;
  /** 1-based. Defaults to 1. The executor never increments it — it does not retry. */
  readonly attempt?: number;
}

/* ── the small, boring JSON path ────────────────────────────────────────────────────── */

/**
 * One step of a resolved JSON path.
 *
 * Deliberately two cases and no more. The supported grammar is a dotted path with array
 * indices and bracketed quoted keys — `data.items[0].id`, `$.items[1]`, `a['odd.key']` —
 * with an optional leading `$`.
 *
 * WHAT IS NOT SUPPORTED, AND WHY THAT IS NOT A GAP TO PAPER OVER: recursive descent
 * (`$..id`), wildcards (`[*]`), filter expressions (`[?(@.x)]`) and slices (`[0:2]`). A
 * full JSONPath implementation is an expression evaluator running over untrusted input, and
 * the acceptance criteria need none of it — Q33 names status, headers and JSON-path values.
 *
 * A path using one of those constructs is refused with `InfraError` BEFORE the request is
 * issued, rather than reported as an unsatisfied assertion. The distinction matters: an
 * unsatisfied assertion is evidence about the branch under verification, and an executor
 * limitation is not. Reporting "SpecWitness cannot parse this path" as a product failure
 * would be manufacturing exactly the kind of evidence this module refuses to manufacture
 * everywhere else. Refusing before any I/O also means the refusal is deterministic and the
 * plan author sees it on the first run rather than the first failing one.
 *
 * The plan schema types this field as free `Prose`, so it CAN express more than is
 * implemented here; that gap is reported in the story's PR body rather than silently
 * narrowed or silently over-implemented.
 */
type PathStep = { readonly kind: 'key'; readonly name: string } | { readonly kind: 'index'; readonly at: number };

/** Parses the supported subset, or returns `undefined` for anything outside it. */
function parseJsonPath(path: string): readonly PathStep[] | undefined {
  const steps: PathStep[] = [];
  let index = 0;

  // An optional leading `$`, with or without the dot that usually follows it.
  if (path.startsWith('$')) {
    index = 1;
  }
  if (path.length === index) {
    // `$` alone addresses the whole document, which no comparison here can render usefully.
    return undefined;
  }

  let expectSeparator = false;
  while (index < path.length) {
    const char = path[index];

    if (char === '.') {
      // `..` is recursive descent, which is outside the subset. Catching it here rather
      // than letting it parse as an empty key is what keeps the refusal honest.
      if (path[index + 1] === '.') {
        return undefined;
      }
      index += 1;
      expectSeparator = false;
      continue;
    }

    if (char === '[') {
      const close = path.indexOf(']', index);
      if (close === -1) {
        return undefined;
      }
      const inner = path.slice(index + 1, close);
      const step = parseBracket(inner);
      if (step === undefined) {
        return undefined;
      }
      steps.push(step);
      index = close + 1;
      expectSeparator = true;
      continue;
    }

    if (expectSeparator) {
      // `a[0]b` — a bare name glued to a bracket. Refuse rather than guess.
      return undefined;
    }

    // A bare key runs to the next separator.
    let end = index;
    while (end < path.length && path[end] !== '.' && path[end] !== '[') {
      end += 1;
    }
    const name = path.slice(index, end);
    if (name === '' || /[*?@:]/.test(name)) {
      return undefined;
    }
    steps.push({ kind: 'key', name });
    index = end;
  }

  return steps.length === 0 ? undefined : steps;
}

/** `0` -> an index; `'a'` / `"a"` -> a key; anything else is outside the subset. */
function parseBracket(inner: string): PathStep | undefined {
  if (/^\d+$/.test(inner)) {
    return { kind: 'index', at: Number.parseInt(inner, 10) };
  }
  const quoted = /^(['"])(.*)\1$/s.exec(inner);
  if (quoted !== null) {
    const name = quoted[2];
    return name === undefined ? undefined : { kind: 'key', name };
  }
  return undefined;
}

/** Walks the parsed path. `undefined` means the path did not resolve — never a crash. */
function resolveJsonPath(document: unknown, steps: readonly PathStep[]): unknown {
  let cursor = document;
  for (const step of steps) {
    if (cursor === null || cursor === undefined) {
      return undefined;
    }
    if (step.kind === 'index') {
      if (!Array.isArray(cursor)) {
        return undefined;
      }
      cursor = (cursor as readonly unknown[])[step.at];
      continue;
    }
    if (typeof cursor !== 'object' || Array.isArray(cursor)) {
      return undefined;
    }
    // Own-property only: a prototype walk would resolve `constructor` or `toString` into
    // something the response never contained, which is a value invented rather than read.
    if (!Object.hasOwn(cursor, step.name)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[step.name];
  }
  return cursor;
}

/**
 * Renders a resolved JSON value as the string an assertion compares.
 *
 * Strings pass through unquoted, so `equals: "widget"` in a plan means what its author
 * meant. Everything else is rendered the way JSON writes it, so a number, a boolean and
 * `null` each have exactly one spelling.
 */
function renderJsonValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value) ?? '';
}

/* ── comparisons ────────────────────────────────────────────────────────────────────── */

/** The six merged comparisons, evaluated mechanically. Exhaustive, with a `never` check. */
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
    case 'greaterThan':
    case 'lessThan': {
      const left = Number(actual);
      const right = Number(expected);
      // A side that is not a finite number leaves the assertion UNSATISFIED rather than
      // throwing: `plan.ts` says so explicitly, and a crash here would turn a product
      // observation into an infrastructure error.
      if (!Number.isFinite(left) || !Number.isFinite(right)) {
        return false;
      }
      return comparison === 'greaterThan' ? left > right : left < right;
    }
    default: {
      const exhaustive: never = comparison;
      throw new InfraError(
        `unknown assertion comparison '${String(exhaustive)}'`,
        'ASSERTION_COMPARISONS is closed; widening it is an ADR in docs/adr/, and every executor switches on it exhaustively',
      );
    }
  }
}

/* ── what an assertion read ─────────────────────────────────────────────────────────── */

/**
 * Either a value that was observed, or a statement that it was not there.
 *
 * `absent` carries its own prose because the reason differs — a header that was not sent,
 * a path that did not resolve, a body that was not JSON — and FR-28 puts that prose in
 * front of a human as the `actual` of a failing criterion.
 */
type ReadValue =
  | { readonly present: true; readonly value: string; readonly name?: string }
  | { readonly present: false; readonly why: string };

interface ObservedResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly bodyText: string;
}

function readTarget(target: HttpAssertionTarget, response: ObservedResponse): ReadValue {
  switch (target.source) {
    case 'status':
      return { present: true, value: String(response.status) };

    case 'header': {
      // `Headers.get` is case-insensitive, as HTTP headers are.
      const value = response.headers.get(target.name);
      return value === null
        ? { present: false, why: `<no such header: ${target.name}>` }
        : { present: true, value, name: target.name };
    }

    case 'body':
      return { present: true, value: response.bodyText };

    case 'jsonPath': {
      // Parsed at validation time, so an unsupported path never reaches here.
      const steps = parseJsonPath(target.path);
      if (steps === undefined) {
        throw new InfraError(
          `json path '${target.path}' is outside the supported subset`,
          'this should have been refused at params validation — report it as a defect in src/surfaces/http.ts',
        );
      }

      let document: unknown;
      try {
        document = JSON.parse(response.bodyText);
      } catch {
        // The server answered and the answer was wrong. See the module header: who declared
        // the expectation decides whether this is product or infrastructure, and here the
        // PLAN asserted JSON, so it is product.
        const contentType = response.headers.get('content-type') ?? 'none';
        const head = response.bodyText.slice(0, 120);
        return {
          present: false,
          why: `<response body is not JSON (content-type: ${contentType}): ${head}>`,
        };
      }

      const resolved = resolveJsonPath(document, steps);
      if (resolved === undefined) {
        return {
          present: false,
          why: `<json path '${target.path}' did not resolve in the response body>`,
        };
      }
      return {
        present: true,
        value: renderJsonValue(resolved),
        name: steps.at(-1)?.kind === 'key' ? (steps.at(-1) as { name: string }).name : undefined,
      };
    }

    default: {
      const exhaustive: never = target;
      throw new InfraError(
        `unknown http assertion target '${JSON.stringify(exhaustive)}'`,
        'HttpAssertionTarget is a closed union in src/domain/plan.ts; widening it is an ADR',
      );
    }
  }
}

/* ── the executor ───────────────────────────────────────────────────────────────────── */

export class HttpSurfaceExecutor implements SurfaceExecutor {
  readonly surface = 'http' as const;

  readonly #deps: HttpExecutorDeps;

  constructor(deps: HttpExecutorDeps) {
    this.#deps = deps;
  }

  async execute(request: ProbeRequest): Promise<ProbeAttempt> {
    // Everything structural is settled BEFORE any I/O, so a malformed plan or a mis-wired
    // caller can never be mistaken for a broken environment.
    const params = validateParams(request);
    const { probe, baseUrl, attempt } = params;
    const url = buildUrl(baseUrl, probe.mechanics.path);

    const redaction = this.#deps.redaction;
    const timeoutMs = this.#deps.timeoutMs ?? HTTP_PROBE_TIMEOUT_MS;
    const doFetch = this.#deps.fetch ?? ((target, init) => fetch(target, init));

    const startedAt = this.#deps.clock.now();

    let response: Response;
    try {
      response = await doFetch(url, {
        method: probe.mechanics.method,
        headers: { ...probe.mechanics.headers },
        ...(probe.mechanics.body === undefined ? {} : { body: probe.mechanics.body }),
        // See the module header: a followed redirect leaves the declared origin and replays
        // the request's headers to whatever host the response named.
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // NOTHING was observed. No status, no headers, no bytes: no member of the closed
      // evidence union can represent this, and synthesising one — a status of 0, an empty
      // body — would manufacture an observation out of an infrastructure failure.
      return this.#finish(startedAt, {
        attempt,
        observations: [requestObservations(probe, url, redaction)].flat(),
        assertionEvaluations: [],
        evidence: [],
        execError: classifyFailure(error, url, timeoutMs, redaction),
      });
    }

    const body = await readBoundedBody(response, HTTP_BODY_READ_CAP_BYTES);
    const observed: ObservedResponse = {
      status: response.status,
      headers: response.headers,
      bodyText: body.text,
    };

    // A body that never finished means the observation is INCOMPLETE, so nothing may be
    // adjudicated from it — but a real status, real headers and real bytes did arrive, and
    // they are the diagnostic. Evidence follows the observation; classification does not.
    const truncatedByRead = body.capped
      ? `the response body exceeded the ${HTTP_BODY_READ_CAP_BYTES}-byte read cap and was truncated at capture`
      : undefined;
    const explanation =
      body.failure === undefined
        ? truncatedByRead
        : 'the response body was not fully received; the captured bytes are partial';

    const evaluations =
      body.failure === undefined
        ? probe.assertions.map((assertion) => evaluate(assertion, observed, redaction))
        : [];

    const { refs, member } = await this.#captureEvidence({
      criterionId: request.criterionId,
      probe,
      url,
      attempt,
      startedAt,
      observed,
      explanation,
      redaction,
    });
    this.#deps.recordEvidence(member);

    return this.#finish(startedAt, {
      attempt,
      observations: responseObservations(probe, url, observed, redaction),
      assertionEvaluations: evaluations,
      evidence: refs,
      ...(body.failure === undefined
        ? {}
        : { execError: classifyFailure(body.failure, url, timeoutMs, redaction) }),
    });
  }

  /**
   * Stamps `durationMs` from the injected clock and returns the attempt.
   *
   * The clock is read exactly twice per `execute()` — once before the request, once here —
   * so a test can inject a stepping clock and assert an exact number rather than a shape.
   */
  #finish(startedAt: Date, attempt: Omit<ProbeAttempt, 'durationMs'>): ProbeAttempt {
    const elapsed = this.#deps.clock.now().getTime() - startedAt.getTime();
    return { ...attempt, durationMs: Math.max(0, Math.round(elapsed)) };
  }

  /**
   * Builds the typed member and persists what belongs on disk. See the COHORT RULE in the
   * module header.
   *
   * The full copy is written FIRST and unconditionally when the redacted body is non-empty,
   * because its path has to exist before the member is constructed — `boundedText` keeps
   * `fullPath` only when it actually truncated, so truncation cannot be learned from the
   * built member. This is also the step that closes `evidence.ts`'s rule-2 hole: the bytes
   * handed to the writer go through `redactText`, so the file beside the spotless inline
   * copy does not hold the credential verbatim.
   */
  async #captureEvidence(input: {
    criterionId: string;
    probe: HttpProbe;
    url: string;
    attempt: number;
    startedAt: Date;
    observed: ObservedResponse;
    explanation: string | undefined;
    redaction: RedactionOptions | undefined;
  }): Promise<{ refs: readonly EvidenceRef[]; member: Evidence }> {
    const { criterionId, probe, url, attempt, startedAt, observed, explanation, redaction } = input;
    const stem = evidenceStem(criterionId, probe.id, attempt);

    const redactedBody = redactText(observed.bodyText, redaction);
    const refs: EvidenceRef[] = [];

    let fullPath: string | undefined;
    if (redactedBody !== '') {
      // An empty file is an artifact implying output that never existed (gates.ts's rule),
      // so a body-less response gets no body file — the member file still carries the ref
      // FR-28 requires, because a status was observed even though no byte of body was.
      fullPath = await this.#deps.writeEvidence(`${stem}.body.txt`, redactedBody);
    }

    const member = httpEvidence(
      {
        capturedAt: startedAt.toISOString(),
        method: probe.mechanics.method,
        url,
        requestHeaders: { ...probe.mechanics.headers },
        status: observed.status,
        responseHeaders: headerRecord(observed.headers),
        body: observed.bodyText,
        durationMs: 0,
        ...(explanation === undefined ? {} : { explanation }),
      },
      { ...redaction, ...(fullPath === undefined ? {} : { fullPath }) },
    );

    // No second `redactText` pass over the serialized member. Every field the constructor
    // touches — url, both header maps, the body, the explanation — is already redacted at
    // capture, and the rest (method, status, timestamps) is not secret-bearing. A second
    // pass would be harmless, `redactText` being idempotent, but it would also imply the
    // constructor's output is not trusted, and the whole design of evidence.ts is that it
    // is: there is deliberately no non-redacting path into the union.
    const memberPath = await this.#deps.writeEvidence(
      `${stem}.json`,
      `${JSON.stringify(member, null, 2)}\n`,
    );

    refs.push(evidenceRef('http', memberPath));
    if (fullPath !== undefined) {
      refs.push(evidenceRef('http', fullPath));
    }

    return { refs, member };
  }
}

/* ── params validation: everything structural, before any I/O ───────────────────────── */

function validateParams(request: ProbeRequest): {
  probe: HttpProbe;
  baseUrl: string;
  attempt: number;
} {
  const fail = (why: string, hint: string): never => {
    throw new InfraError(`http probe params for ${request.criterionId}: ${why}`, hint);
  };

  const params = request.params as Partial<HttpProbeParams>;
  const probe = params.probe;

  if (probe === undefined || typeof probe !== 'object') {
    return fail(
      "no 'probe' was passed",
      "the caller puts {probe, baseUrl, attempt?} in ProbeRequest.params — see HttpProbeParams in src/surfaces/http.ts",
    );
  }
  if (probe.surface !== 'http') {
    return fail(
      `the probe declares surface '${String(probe.surface)}', not 'http'`,
      'route each probe to the executor whose surface matches; this is a wiring defect, not a plan error',
    );
  }

  const mechanics = probe.mechanics;
  if (mechanics === undefined || typeof mechanics !== 'object') {
    return fail("the probe carries no 'mechanics'", 'compile the plan with the merged plan schema');
  }
  if (!HTTP_METHODS.includes(mechanics.method)) {
    return fail(
      `method '${String(mechanics.method)}' is not one of the declared HTTP methods`,
      `HTTP_METHODS is closed: ${HTTP_METHODS.join(', ')}`,
    );
  }

  const path = mechanics.path;
  // AD-3, enforced again at the point of use. The plan schema already refuses anything but
  // a service-relative path; re-checking here costs nothing and means the executor's own
  // guarantee does not depend on which validator ran upstream. A plan that reached this
  // point with an absolute URL would be pointing a probe at a host nobody declared.
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    return fail(
      `path '${redactText(String(path))}' is not service-relative`,
      "a plan names a declared service and a path beginning with a single '/' — never a scheme, a host, or a protocol-relative '//'",
    );
  }
  if (path.includes('\\')) {
    return fail(
      'the path contains a backslash',
      'a backslash has no legitimate place in a request path, and WHATWG URL parsing treats it as a separator for special schemes',
    );
  }

  if (!Array.isArray(probe.assertions) || probe.assertions.length === 0) {
    return fail(
      'the probe declares no assertions',
      'a probe that adjudicates nothing cannot mint a PASS — the plan schema enforces at least one',
    );
  }

  // Every JSON path is parsed NOW, so an unsupported one is refused before a request is
  // issued rather than surfacing as an unsatisfied assertion about the branch.
  for (const assertion of probe.assertions) {
    if (assertion.target.source === 'jsonPath' && parseJsonPath(assertion.target.path) === undefined) {
      return fail(
        `json path '${assertion.target.path}' uses syntax this executor does not implement`,
        "supported: a dotted path with array indices and bracketed quoted keys, e.g. '$.data.items[0].id'. Recursive descent, wildcards, filters and slices are not implemented — rewrite the path, or raise an additive follow-up",
      );
    }
  }

  const baseUrl = params.baseUrl;
  if (typeof baseUrl !== 'string' || baseUrl === '') {
    return fail(
      "no 'baseUrl' was passed",
      "src/surfaces/** may not import src/config/**, so the CALLER resolves the service base URL (4.1's resolveServiceBaseUrl) and passes it in",
    );
  }
  try {
    void new URL(baseUrl);
  } catch {
    return fail(
      `baseUrl '${redactText(baseUrl)}' is not a valid absolute URL`,
      'pass the origin resolved from the project config, e.g. http://127.0.0.1:3000',
    );
  }

  const attempt = params.attempt ?? 1;
  if (!Number.isInteger(attempt) || attempt < 1) {
    return fail(
      `attempt '${String(params.attempt)}' is not a positive integer`,
      'attempt numbers are 1-based; the executor runs exactly one attempt per call and never increments it',
    );
  }

  return { probe: probe as HttpProbe, baseUrl, attempt };
}

/**
 * Joins the resolved base URL with the declared path.
 *
 * Concatenation rather than `new URL(path, base)`, and the difference is not cosmetic:
 * relative-URL resolution treats a leading `/` as ROOT-relative, so a service declared at
 * `http://host/api/v2` with a probe path of `/orders` would silently be probed at
 * `http://host/orders` — a different endpoint, quietly, with a green or red result that
 * describes the wrong thing.
 */
function buildUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

/* ── observations and evaluations ───────────────────────────────────────────────────── */

/** What was attempted, recorded even when nothing came back. Redacted like everything else. */
function requestObservations(
  probe: HttpProbe,
  url: string,
  redaction: RedactionOptions | undefined,
): readonly Observation[] {
  return [
    { name: 'http.method', value: probe.mechanics.method },
    { name: 'http.url', value: redactText(url, redaction) },
  ];
}

function responseObservations(
  probe: HttpProbe,
  url: string,
  observed: ObservedResponse,
  redaction: RedactionOptions | undefined,
): readonly Observation[] {
  return [
    ...requestObservations(probe, url, redaction),
    { name: 'http.status', value: String(observed.status) },
    {
      name: 'http.contentType',
      value: redactText(observed.headers.get('content-type') ?? 'none', redaction),
    },
  ];
}

/**
 * Evaluates one declared assertion, satisfied or not.
 *
 * EVERY assertion produces an evaluation, including the satisfied ones: FR-28 requires
 * expected-vs-actual on non-pass results, and `deriveCriterionResult` reads
 * `find(e => !e.satisfied)` to build them — so a satisfied assertion that went unreported
 * would make the record of what was checked incomplete without changing any verdict, which
 * is the kind of gap nobody notices until they are reading a report and cannot tell whether
 * a check ran.
 */
function evaluate(
  assertion: Assertion<HttpAssertionTarget>,
  observed: ObservedResponse,
  redaction: RedactionOptions | undefined,
): AssertionEvaluation {
  const read = readTarget(assertion.target, observed);
  const description = redactText(assertion.description, redaction);
  const expected = redactText(assertion.expected, redaction);

  if (!read.present) {
    // A value that does not exist cannot satisfy an expectation about that value — for
    // every comparison, the negative ones included. See the module header.
    return { description, satisfied: false, expected, actual: redactText(read.why, redaction) };
  }

  return {
    description,
    satisfied: compare(assertion.comparison, read.value, assertion.expected),
    expected,
    actual: namedValue(read.name, read.value, redaction),
  };
}

/**
 * Redacts one extracted value, using its own name to decide sensitivity.
 *
 * `redactText` finds `api_key=…` inside a body, but a value pulled OUT of that body arrives
 * as a bare string with no assignment shape left to recognise — so an `actual` holding a
 * secret would sail straight through, right next to the header that was properly redacted.
 * Routing it through `redactHeaders` under its own key applies literally the same
 * sensitive-name rule the evidence constructors use, so the two can never drift apart. A
 * value with no name (a status code, a whole body) has nothing to test and gets the
 * ordinary text redaction.
 */
function namedValue(
  name: string | undefined,
  value: string,
  redaction: RedactionOptions | undefined,
): string {
  if (name === undefined) {
    return redactText(value, redaction);
  }
  return redactHeaders({ [name]: value }, redaction)[name] ?? redactText(value, redaction);
}

/** `Headers` as the plain record the evidence constructor takes. */
function headerRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, name) => {
    record[name] = value;
  });
  return record;
}

/* ── reading a bounded body ─────────────────────────────────────────────────────────── */

interface BoundedBody {
  readonly text: string;
  /** True when the read stopped at the cap rather than at the end of the body. */
  readonly capped: boolean;
  /** Set when the body never finished arriving. The bytes read so far are still in `text`. */
  readonly failure?: unknown;
}

/**
 * Reads at most `capBytes` of the response body, keeping whatever arrived if it fails.
 *
 * `response.text()` would be one line, and it is the wrong one twice over: it buffers an
 * unbounded amount of attacker-influenced data, and on an abort it rejects with NOTHING —
 * discarding the bytes that did arrive, which are exactly the diagnostic when a service
 * answers and then hangs.
 */
async function readBoundedBody(response: Response, capBytes: number): Promise<BoundedBody> {
  const stream = response.body;
  if (stream === null) {
    return { text: '', capped: false };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let capped = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value !== undefined) {
        chunks.push(value);
        total += value.byteLength;
        if (total >= capBytes) {
          capped = true;
          await reader.cancel();
          break;
        }
      }
    }
  } catch (failure) {
    return { text: decodeChunks(chunks, capBytes), capped, failure };
  }

  return { text: decodeChunks(chunks, capBytes), capped };
}

/** Concatenates and decodes, trimming to the cap. Lone surrogates decode, never throw. */
function decodeChunks(chunks: readonly Uint8Array[], capBytes: number): string {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const joined = new Uint8Array(Math.min(total, capBytes));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= joined.length) {
      break;
    }
    const take = Math.min(chunk.byteLength, joined.length - offset);
    joined.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return new TextDecoder().decode(joined);
}

/* ── classifying a failure to observe ───────────────────────────────────────────────── */

/**
 * Turns a thrown fetch failure into a `ProbeExecError` with a message and a useful hint.
 *
 * Every string here goes through `redactText`, because the URL it names may carry a token
 * in its query string and an error message is persisted and printed exactly like evidence
 * is. The hints are written for the person who has to fix the environment, since this is
 * the channel that becomes exit 3 — "fix your environment", not "your code is broken".
 */
function classifyFailure(
  error: unknown,
  url: string,
  timeoutMs: number,
  redaction: RedactionOptions | undefined,
): ProbeExecError {
  const safeUrl = redactText(url, redaction);
  const redact = (text: string): string => redactText(text, redaction);
  const codes = errorCodes(error);

  if (isTimeout(error)) {
    return {
      message: redact(`the request to ${safeUrl} timed out after ${timeoutMs}ms`),
      hint: 'the service accepted the connection but did not answer in time — check whether it is hung, or raise the probe timeout',
    };
  }
  if (codes.has('ECONNREFUSED')) {
    return {
      message: redact(`the connection to ${safeUrl} was refused`),
      hint: 'the service passed readiness but is not accepting connections now — check whether it exited mid-run, and whether the declared port is the one it listens on',
    };
  }
  if (codes.has('ENOTFOUND') || codes.has('EAI_AGAIN')) {
    return {
      message: redact(`the host in ${safeUrl} could not be resolved`),
      hint: "services bind to localhost unless the project config says otherwise — check services.<id> in .specwitness/config.yaml",
    };
  }
  if (codes.has('ECONNRESET') || codes.has('EPIPE')) {
    return {
      message: redact(`the connection to ${safeUrl} was reset before a response arrived`),
      hint: 'the service closed the socket mid-request — check its logs for a crash or a restart during the run',
    };
  }
  if ([...codes].some((code) => code.startsWith('CERT_') || code.startsWith('ERR_TLS') || code === 'EPROTO')) {
    return {
      message: redact(`the TLS handshake with ${safeUrl} failed`),
      hint: 'a local service usually speaks plain http — check the scheme of the declared port or readiness URL',
    };
  }

  return {
    message: redact(`the request to ${safeUrl} could not be completed: ${messageOf(error)}`),
    hint: 'the probe never observed a response, so this is an infrastructure failure rather than a product one — check that the service is running and reachable',
  };
}

/** Node reports a timeout abort as a `TimeoutError`; an explicit abort as an `AbortError`. */
function isTimeout(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/**
 * Collects every `code` on the error's `cause` chain.
 *
 * `fetch` wraps the real reason: the thrown value is a `TypeError` reading "fetch failed"
 * and the `ECONNREFUSED` lives one or two `cause` links down. Walking the chain rather than
 * reading one level is what keeps connection-refused from falling through to the generic
 * arm and losing its hint. Bounded, because a cause chain is data from a library and a
 * cycle would hang the classifier.
 */
function errorCodes(error: unknown): ReadonlySet<string> {
  const codes = new Set<string>();
  let cursor: unknown = error;
  for (let depth = 0; depth < 8 && cursor !== null && cursor !== undefined; depth += 1) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === 'string') {
      codes.add(code);
    }
    const errors = (cursor as { errors?: unknown }).errors;
    if (Array.isArray(errors)) {
      // `AggregateError`, which is what a happy-eyeballs dual-stack connect failure throws.
      for (const nested of errors as readonly unknown[]) {
        const nestedCode = (nested as { code?: unknown } | null)?.code;
        if (typeof nestedCode === 'string') {
          codes.add(nestedCode);
        }
      }
    }
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return codes;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ── evidence file names ────────────────────────────────────────────────────────────── */

const UNSAFE = /[^A-Za-z0-9._-]+/g;
const SLUG_MAX_CHARS = 64;

/**
 * Derives at most one safe path component from a probe id, and includes the attempt.
 *
 * The derivation follows `gate-evidence-path.ts` and exists for the same reason, which is
 * worth restating because the argument is not obvious: a schema-VALID id containing `..`
 * hits `RunStore`'s containment rule, and an over-long one raises `ENAMETOOLONG`. Both
 * arrive as `InfraError` — exit 3 for a perfectly good verification run, telling an operator
 * their environment is broken when in fact their probe id merely contains a dot. That is
 * infrastructure being blamed for something that is not infrastructure, arriving from the
 * side nobody was watching, in the one story whose whole subject is not making that mistake.
 *
 * THE ATTEMPT NUMBER IS NOT DECORATION. `deriveCriterionResult` reads the FINAL attempt, so
 * if attempt 2's evidence overwrote attempt 1's, a flaky pass would point at evidence that
 * no longer shows the failure it was flaky about — the single most confusing artifact this
 * epic could produce.
 *
 * NEITHER IS THE FINGERPRINT. See `fingerprint()` below: probe ids are unique only WITHIN a
 * criterion, so the probe id alone does not name a file uniquely across a run.
 */
function evidenceStem(criterionId: string, probeId: string, attempt: number): string {
  const ordinal = String(attempt).padStart(2, '0');
  const parts = [slugify(criterionId), slugify(probeId), fingerprint(`${criterionId}\u0000${probeId}`)]
    .filter((part) => part !== '');

  return `${EVIDENCE_DIR}/http-${parts.join('-')}-${ordinal}`;
}

/** Normalises one id into at most one safe path component. Total: every string maps. */
function slugify(id: string): string {
  return id
    .replace(UNSAFE, '-')
    .replace(/-{2,}/g, '-')
    // Collapse dot runs so the literal `..` cannot appear anywhere in the result, not
    // merely at the edges.
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '')
    .slice(0, SLUG_MAX_CHARS)
    .replace(/[-.]+$/, '');
}

/**
 * A short, deterministic fingerprint of the criterion+probe pair. FNV-1a, base36.
 *
 * THIS IS WHAT MAKES THE FILENAME UNIQUE, and the slugs beside it are for a human reading
 * the directory. Two collisions are real rather than theoretical here, and neither is solved
 * by slugifying:
 *
 *  1. `plan.ts` enforces probe-id uniqueness **only within a criterion** — its comment says
 *     so: "Probe ids identify a probe within its criterion". So two criteria may each hold a
 *     probe called `health`, and a name built from the probe id alone would give both the
 *     same file. The first criterion's evidence ref would then point at the second
 *     criterion's content — evidence attributed to the wrong criterion, which is worse than
 *     no evidence.
 *  2. Two distinct ids can share a 64-character prefix and become identical after truncation
 *     (`Identifier` allows 128 characters).
 *
 * `gate-evidence-path.ts` closes both with a declaration index, and says so; an executor has
 * no index, because it is handed one probe at a time and never sees the list. A deterministic
 * fingerprint is the index-free equivalent — and it must be deterministic, so that re-running
 * the same plan produces the same paths rather than a directory that diffs against itself.
 *
 * Not a security control, so a non-cryptographic hash is the right tool: it distinguishes
 * accidental collisions, which is all that is being asked of it.
 */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    // FNV prime, via shifts because the 32-bit multiply overflows a JS number.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(36).padStart(7, '0');
}
