/**
 * AD-13 / FR-24 / FR-28 — the browser surface executor. Story 5.2.
 *
 * The fourth and last surface. `src/surfaces/http.ts:11` says "the shape here is the shape
 * stories 4.5, 4.6 and Epic 5's browser executor follow", and this file follows it: the
 * paragraphs marked COHORT RULE there record decisions all four surfaces now implement
 * identically. Nothing here is a fourth dialect invented by accident.
 *
 * It is also the FIRST producer of the `browser` evidence kind, which `domain/evidence.ts`
 * declared at line 61 and left unused on purpose, and the story that replaces the
 * deliberate refusal Epic 4 left at `src/cli/verify/probe-dispatch.ts` — *"browser probes
 * arrive in Epic 5"*. **It replaces a refusal with an executor, and it must not replace it
 * with a skip.**
 *
 * ============================================================================
 * THE TWO THINGS THIS FILE DOES NOT DO
 * ============================================================================
 *
 * 1. IT NEVER PRODUCES A `CriterionStatus`. It evaluates assertions mechanically and
 *    reports what it saw; `deriveCriterionResult` alone decides what that means, including
 *    retry orchestration and `flaky`. Four surfaces each adjudicating status their own way
 *    would give four subtly different answers to "did a retry that eventually passed count
 *    as flaky", and the differences would only ever surface as a verdict nobody could
 *    reproduce. `tests/unit/surfaces/browser-shape.type.test.ts` makes that a COMPILE error
 *    rather than a convention.
 *
 * 2. IT NEVER RETRIES. One attempt per `execute()` call, stamped with the 1-based `attempt`
 *    the caller passes. Whoever orchestrates retries calls this N times (AD-9, Q43/Q44);
 *    story 5.4 owns the config field that turns them on. Looping here would make `flaky`
 *    wrong and hide the attempts.
 *
 * ============================================================================
 * THE SECURITY PROPERTY OF THIS EPIC: UNTRUSTED PROSE BECOMES EXECUTABLE CODE
 * ============================================================================
 *
 * No other executor turns provider-authored text into something that runs.
 * `BrowserProbeMechanics.scenario` says so in the merged model: *"It is untrusted provider
 * text, and Epic 5 must treat it as such: it may become a generated spec run by Playwright,
 * and it may never become a shell string or reach `ProcessRunner` as a command."*
 *
 * THE DECISION, which is the one a reviewer should look for first:
 *
 *   **THE SCENARIO IS DATA THE GENERATED SPEC READS. IT IS NEVER CODE THE GENERATED SPEC
 *   BECOMES.**
 *
 * Both generated code files — `GENERATED_SPEC` and `GENERATED_CONFIG` below — are
 * byte-for-byte CONSTANTS of SpecWitness. They contain no interpolation of any kind:
 * not the scenario, not a selector, not a URL, not even their own file paths, which reach
 * the child through `ChildEnvironment.set` instead. The scenario is compiled into a
 * separate JSON **payload** whose steps are structured values over a closed verb set, and
 * the constant driver dispatches over that set.
 *
 * A hostile scenario therefore has NO SYNTACTIC POSITION from which to escape. There is no
 * template into which a backtick, a `${`, a quote or a `;` could be placed, because there
 * is no template — the alternative design, templating text into TypeScript, would own an
 * injection surface that has to be argued closed, and an argument is weaker than an
 * absence. `tests/integration/surfaces/browser-security.test.ts` asserts the generated
 * files are equal to these constants even when the scenario is hostile.
 *
 * The remaining links in the chain, each closed structurally rather than by care:
 *
 *  - **No shell, ever.** Playwright's own CLI is invoked as ARGV through `ProcessRunner`
 *    (`binary`, `args[]`), which has no `shell` option and no way to add one. The
 *    invocation is SpecWitness's own hard-coded argv, on exactly the footing 5.1's `npm`
 *    spawn is on — so NO `DeclaredCommand` is minted and none may be: that brand constrains
 *    project-declared SHELL STRINGS, and there is no shell here to constrain.
 *    `tests/unit/config/boundary-scan.test.ts` covers this file automatically.
 *  - **No URL from the plan.** `BrowserProbeMechanics` has a `serviceId` and a
 *    service-relative `path` and NO url field — that absence is AD-3's "no production URL
 *    defaults" expressed structurally, and it must never gain one (5.6 also depends on the
 *    mechanics/assertions split staying exactly as it is). The origin is resolved by the
 *    CALLER from the project's own config (4.1's `resolveServiceBaseUrl`);
 *    `adapters-core-only` forbids this file from reaching `src/config/**`, which is the
 *    rule's point rather than a workaround for it. A `goto` step inside a scenario is held
 *    to the same rule: it is a service-relative path or it is refused.
 *  - **The generated files are EPHEMERAL and live in the RUN DIRECTORY** (Q30/Q31), never
 *    in the project tree and never in the verification worktree's sources. Nothing here
 *    constructs a path there: `RunStore` is the sole writer beneath `.specwitness/runs/`
 *    (AD-8) and reaches this file as injected callbacks.
 *
 * ============================================================================
 * WHAT THE SCENARIO GRAMMAR IS, AND WHY AN UNPARSEABLE LINE IS A REFUSAL
 * ============================================================================
 *
 * One directive per line, arguments quoted, `#` comments and blank lines ignored:
 *
 *     goto     "/orders"
 *     click    "#submit"
 *     fill     "#email" "alice@example.com"
 *     waitFor  "#confirmation"
 *
 * **A line that is not a recognised directive is `InfraError` BEFORE any I/O.** It is NOT
 * ignored, and that is the load-bearing choice in this section. A scenario reading "log in
 * as alice, then click Submit" cannot be executed mechanically — there is no AI at
 * execution time and there must never be one (AD-2, and the product's first non-negotiable
 * rule) — so ignoring it and navigating-then-asserting anyway would report a UI criterion
 * as verified WITHOUT the interaction that makes the assertion mean anything. That is the
 * standing green-for-nothing hazard (Epic 4 retro section 2 observation 2) wearing a new
 * dress, and this story exists to make it impossible.
 *
 * Refusing is the same move `http.ts` makes for a JSON path outside its implemented subset,
 * for the reason it states there: an executor limitation is not evidence about the branch
 * under verification, and reporting "SpecWitness cannot do this" as a product failure would
 * manufacture exactly the evidence this module refuses to manufacture everywhere else.
 *
 * HONEST CONSEQUENCE, reported rather than hidden: `schemas/plan.ts` types `scenario` as
 * free `Prose`, so a plan CAN express more than is implemented here. Closing that gap
 * properly is an additive follow-up — a structured `steps` field on
 * `BrowserProbeMechanics` — which is a schema widening and therefore an ADR, not something
 * smuggled into a story branch.
 *
 * ============================================================================
 * COULD NOT LOOK vs LOOKED AND SAW WRONG — and EVERY route to no attempts
 * ============================================================================
 *
 * The probe LOOKED and saw the wrong value  => an unsatisfied `AssertionEvaluation`
 *                                           => criterion `fail`   => exit 1 (product).
 * The probe COULD NOT LOOK at all           => `execError`
 *                                           => criterion `error`  => exit 3 (infra).
 *
 * `outcomeOf` in the merged derivation makes `execError` outrank any assertion the probe
 * managed to evaluate, and its comment says why: *"those assertions ran against a broken
 * observation, so reporting `fail` from them would manufacture product evidence out of an
 * infrastructure failure."* So on that path this file emits ZERO `AssertionEvaluation`s.
 *
 * THE FULL TABLE, and the REASON for each row rather than only the rule — because the
 * reason is what stops the next person adding a seventh row that skips:
 *
 *   Playwright not ready            InfraError, before any I/O. The run cannot proceed. A
 *   (5.1's `absent`, or no          skip here is green-for-nothing: a criterion the plan
 *   downloaded browsers)            mapped to a browser check would report PASS having
 *                                   checked nothing. 5.1 owns the shape and its `reason`
 *                                   is quoted verbatim rather than paraphrased.
 *
 *   malformed params, an            InfraError, before any I/O. A WIRING OR TOOLING DEFECT
 *   unparseable scenario, a         — SpecWitness being wrong. Not the environment being
 *   path a plan may not express,    broken, and not the branch being broken. Both routes
 *   an assertion target this        end at exit 3; only one is honest about whose fault it
 *   executor cannot read            is, and disguising a bug of ours as an `execError`
 *                                   would make it read as an environment flake. All three
 *                                   merged surfaces do this (`http.ts:52-59`).
 *
 *   the browser failed to launch    execError => criterion `error`. Could not look.
 *   the browser crashed mid-run     execError => criterion `error`. Could not finish looking.
 *   a timeout before the first      execError => criterion `error`. Nothing was adjudicated,
 *   assertion                       so nothing may be reported as adjudicated.
 *
 *   an assertion evaluated false    an unsatisfied `AssertionEvaluation` => `fail`. The
 *                                   probe looked and saw wrong: a fact about the branch.
 *
 * **NEVER `skipped`. NEVER `pass`. NEVER a silently absent probe.** There is no skip path
 * anywhere in this file, and Q39 forecloses the tempting third option: execution-time
 * uncertainty is `error`, never `needs_human`. There are exactly two NEEDS_HUMAN triggers
 * and both are compile-time; nothing observed here can create a third, and nothing here
 * special-cases `verifiability: human` — the merged derivation answers that before it looks
 * at attempts at all.
 *
 * ============================================================================
 * ASSERTIONS ARE DATA
 * ============================================================================
 *
 * The four merged `BrowserAssertionTarget` sources (`url`, `title`, `text`+selector,
 * `visible`+selector) are read over the six merged `ASSERTION_COMPARISONS`. Nothing is
 * interpreted, nothing is inferred, and NO AI IS CONSULTED — "never ask an LLM whether it
 * passes" is the product's first non-negotiable rule, and this is the surface where
 * breaking it would be easiest to rationalise.
 *
 * EVERY assertion produces an `AssertionEvaluation`, the satisfied ones included: FR-28
 * needs expected/actual on non-pass results and `deriveCriterionResult` reads
 * `find(e => !e.satisfied)`, so a satisfied assertion that went unreported would make the
 * record of what was checked incomplete without changing any verdict.
 *
 * A VALUE THAT IS NOT THERE IS AN UNSATISFIED ASSERTION, for every comparison including the
 * negative ones. A selector matching no element does not satisfy `notEquals`, and it does
 * not satisfy `notContains` either. Both are expectations ABOUT a value, and a value that
 * does not exist cannot meet one; the alternative mints a PASS out of an absence, which is
 * the one direction this product must never fail in (`http.ts:180-186`, same rule).
 *
 * THE COST OF THAT, STATED because it is a real case and not a hypothetical: a plan wanting
 * "the error banner is NOT visible" gets an UNSATISFIED assertion when the banner element
 * does not exist at all, even though a human would call that the desired state. Playwright's
 * own `not.toBeVisible()` would pass there. The merged rule wins anyway, because
 * consistency across four surfaces is what `conformance.test.ts` exists to protect and
 * because the failure direction is the safe one. A plan that needs the other reading asserts
 * on a container that does exist — `text` of the page region, say — rather than on the
 * absence of an element.
 *
 * A MISSING SELECTOR IS NEVER AN `execError`. The page answered; the answer was that
 * nothing matched. That is a fact about the product.
 *
 * ⚠️ BUT A FAILURE TO READ AT ALL IS ALWAYS AN `execError`, AND THE TWO ARE EASY TO
 * CONFLATE. A page that crashes, closes or times out WHILE a value is being read throws
 * rather than answering, and an earlier version of the generated driver caught that and
 * reported it as an absent value — which made a dead browser look like an unsatisfied
 * assertion and turned infrastructure into product FAIL. Found by the codex review of this
 * branch. The driver now catches nothing inside a read: an ABSENCE is reported as a fact
 * about the page, an EXCEPTION escapes and becomes `execError`. A missing element and a
 * dead browser are not the same observation, and the whole story is about not conflating
 * them.
 *
 * ============================================================================
 * EVIDENCE (AD-10, FR-28, Q32) — the COHORT RULE, and the one thing it cannot do
 * ============================================================================
 *
 * TWO CHANNELS, because they do two different jobs, and the second is the one that fails
 * SILENTLY. `writeEvidence(relativeName, contents)` returns a run-relative path for
 * `ProbeAttempt.evidence` refs; `recordEvidence(member)` hands the typed, bounded, redacted
 * MEMBER to the run accumulator. `RunResult.evidence` is the closed union and
 * `report/terminal.ts` renders from the member inline because AD-11 forbids a renderer to
 * open a file — so an executor with a stubbed or forgotten `recordEvidence` ships an epic
 * whose reports carry gate evidence and NO probe evidence at all, silently, with every
 * surface suite green (no surface test drives a renderer). All three cohort-2 PR bodies
 * carry that warning in identical words. Both callbacks are taken here under the same names
 * with the same signatures.
 *
 * A THIRD WRITER, and it is new: a trace is a `.zip` and a screenshot is a `.png`.
 * `RunStore.writeEvidenceFile` writes with `'utf8'`, which corrupts either, so an additive
 * `writeEvidenceBytes` carries them. AD-8 is why the bytes are copied at all rather than
 * pointed at where Playwright wrote them: `RunStore` is the sole writer beneath
 * `.specwitness/runs/`, so the Playwright subprocess writes into a TEMPORARY directory
 * outside the run and this file copies the bytes in through the injected writer. Base64 was
 * the alternative and was rejected: a "trace" no trace viewer can open is not evidence.
 *
 * WHEN A `browser` MEMBER IS RECORDED — the per-attempt rule 4.7's conformance test needs
 * spelled out in its own terms, since it compares this against the other three:
 *
 *   EVERY ATTEMPT. Including one where the browser never launched and no artifact exists.
 *
 * THE ARTIFACTS THEMSELVES FOLLOW HOW FAR THE ATTEMPT GOT, which is a finer thing than
 * "present on success, absent on failure" and was measured rather than assumed: a refused
 * connection still yields a TRACE and a SCREENSHOT, because chromium really launched and
 * only the navigation failed, so the driver's `finally` block really ran. That is the more
 * useful outcome — the evidence is a picture of the browser sitting on an error page, which
 * is exactly what an operator wants — and only a browser that never STARTED produces a
 * member with neither field. The first version of the conformance assertion for this
 * expected both absent and was wrong; it is corrected there in the same terms.
 *
 * That places this surface on SHELL's side of the divergence that file documents, and the
 * reason is the same reason: what the union GIVES each surface, not preference.
 * `BrowserEvidence.url` is always honestly known — the CALLER resolved the origin before
 * anything was spawned, so it is a fact about what was attempted rather than an observation
 * that has to have happened — and `trace` and `screenshot` are BOTH optional, so an attempt
 * that produced no artifacts is representable without inventing anything. Contrast
 * `HttpResponseRecord.status`, a bare `number`, which is why http records nothing when no
 * response arrived: there, recording would mean writing `status: 0`. Here there is nothing
 * to invent, so FR-28's "at least one evidence reference on every non-pass result" is
 * satisfied by construction on every route, which is strictly better than http's documented
 * gap.
 *
 * REDACTION HAPPENS AT CAPTURE, through the merged constructors, which are the only
 * non-hand-written path into the union. `browserEvidence()` runs the URL through
 * `redactText` — `?api_key=...` in a captured URL is a leak sitting beside properly
 * redacted output — and every message this file builds goes the same way.
 * `{shellCommand: true}` is passed NOWHERE: it is for DECLARED command text only, and
 * everything captured here (a URL, page text, a title, a Playwright stderr line) is
 * UNDECLARED, which is the fail-closed default (Epic 3 retro section 6).
 *
 * ⚠️ **AND THE ONE THING REDACTION CANNOT DO, STATED PLAINLY RATHER THAN PAPERED OVER.**
 *
 *   > screenshots and traces are NOT redacted — image content cannot be scrubbed by a text
 *   > redactor
 *
 * That sentence is story 5.3's, agreed with its author at wave-2 intent-sync so that the
 * product says one thing about this and not two; 5.3 renders it to the human in the
 * reviewer-guidance block, and it names the TRACE deliberately, because a trace archive
 * carries page snapshots, network payloads and console text — the same hazard in a much
 * bigger container than a `.png`.
 *
 * `redactText` cannot read pixels and cannot read a zip. A redactor that CLAIMED to scrub
 * images and did not would be worse than one that says it cannot, because a reviewer would
 * open the artifact with their guard down. So this module makes no such claim. What it does
 * promise is exact: every TEXT channel is redacted at capture — the URL, the page text,
 * titles, error messages, and the `expected` / `actual` the derivation builds from them.
 * The image and archive channels are out of reach, and that is a property of the medium.
 *
 * ⚠️ AND THE TRACE IS THE STRONGER EXPOSURE OF THE TWO, WHICH IS WORTH SEPARATING OUT
 * RATHER THAN LEAVING BUNDLED WITH THE SCREENSHOT. Raised by the codex re-review of this
 * branch, and it is right about the facts:
 *
 *   A screenshot is PIXELS. Reading a secret out of it takes a human eye or an OCR pass.
 *   A trace is a ZIP OF STRUCTURED DATA — DOM snapshots, network requests and responses,
 *   console output, and every URL visited. A secret in it is MACHINE-READABLE and greppable,
 *   which makes it a materially larger exposure than the screenshot beside it.
 *
 * WHY IT IS STORED ANYWAY, stated as a decision rather than an oversight. AC1 requires "a
 * Playwright trace + failure screenshot are stored as evidence" (Q32), and the product exists
 * to produce REPRODUCIBLE EVIDENCE — a verification gate whose passing runs carry no record
 * of what was exercised is the thing this product was built to replace. The two ways to close
 * the hole both cost more than they buy:
 *
 *   - DROP OR CONDITION THE TRACE. Contradicts AC1, and removes the artifact 5.6 needs most
 *     when it proposes a new locator for a probe that failed.
 *   - SANITISE THE ARCHIVE. Rewriting a zip of DOM snapshots and network resources with a
 *     text redactor is a large, error-prone piece of work whose PARTIAL success is worse than
 *     nothing — by this module's own rule, three paragraphs up.
 *
 * SO THE EXPOSURE IS REPORTED TO THE OWNER RATHER THAN SILENTLY ACCEPTED OR SILENTLY CLOSED.
 * It is a genuine tension between AC1 (store a trace), AD-10/Q49 (sanitise at capture) and
 * 5.6's needs, and choosing between those three is a product decision, not a story branch's.
 * What is done here meanwhile: `sources: false` keeps the project's own source files out of
 * the archive, the limitation is stated in the evidence member's own `explanation` where a
 * reader meets the artifact, and 5.3 renders it to the reviewer. A project that knows the
 * shape of its own secrets should keep them off the pages a browser probe drives.
 *
 * A SECOND, SMALLER LIMIT, named for the same reason: a secret sitting in page text with no
 * assignment shape around it (`sw-secret-...` on its own, rather than `api_key=sw-secret-...`)
 * is not something `redactText` can recognise. `http.ts` closes the equivalent hole for
 * NAMED targets by routing an extracted value through `redactHeaders` under its own name;
 * three of the four targets here are anonymous — a URL, a title and an element's text have
 * no key whose name could make them sensitive — so they take the ordinary text redaction,
 * exactly as http's `status` and `body` targets do. A project that knows the shape of its
 * own secrets declares `extraPatterns` (AD-10), and those are threaded into every
 * constructor call here.
 *
 * ============================================================================
 * THE PARAMS SHAPE, AND THE DEBT IT CONFORMS TO
 * ============================================================================
 *
 * Epic 4 retro section 5 item 5 records that the `params` contract DIVERGES across surfaces:
 * http nests the probe under `params.probe` and adds a resolved base URL, while observation
 * and shell take the probe's fields flat. This is a fourth surface landing in exactly that
 * mess, and the choice made here is **CONFORM, DO NOT CONSOLIDATE** — following HTTP's
 * shape, `{probe, baseUrl, attempt?}`, for one reason that is about the problem rather than
 * about tidiness: **this surface has http's problem.** It needs an ORIGIN the caller must
 * resolve, because `adapters-core-only` forbids reaching `src/config/**`, and the flat
 * shape has nowhere to put one. Adopting the flat shape and bolting a sibling key beside it
 * would be a fifth dialect, not a reduction to two.
 *
 * Consolidating properly would mean editing three merged modules and breaking three merged
 * suites to buy a tidiness nobody can observe. **e4-E** (export the per-surface probe
 * schemas, which is the reason all four surfaces hand-validate their params instead of
 * re-parsing them) and **e4-F** (consolidate the near-identical evidence-callback types and
 * the now-FOUR private `slugify` helpers) are the named follow-ups that own that work. This
 * story feels the cost of both and leaves the code alone.
 *
 * AD-1: an adapter. Imports `src/domain/**`, its own siblings and npm/node only — never
 * `src/config/**`, never `src/infra/**`, never an application layer, never the edge. The
 * consequence that shapes every field of `BrowserExecutorDeps`: an executor cannot look a
 * value up, so the CALLER resolves and passes values in. That is the rule's point.
 *
 * AD-12: hermetic. Localhost only, headless, fixture apps built by the tests, no real
 * providers — and this story makes ZERO provider calls of any kind.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  browserEvidence,
  evidenceRef,
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
import { ASSERTION_COMPARISONS } from '../domain/plan.js';
import type {
  Assertion,
  AssertionComparison,
  BrowserAssertionTarget,
  BrowserProbe,
} from '../domain/plan.js';
import type { Clock } from '../domain/ports.js';
import type { ProcessResult, ProcessRunner } from '../domain/process-runner.js';

/**
 * How long ONE browser probe attempt may take, end to end, before it is abandoned as
 * inconclusive.
 *
 * Ninety seconds, chosen rather than guessed. A browser probe is the most expensive thing
 * this product runs: a browser process tree has to start, a page has to load with whatever
 * assets it pulls, and a scenario may click through several screens. `HTTP_PROBE_TIMEOUT_MS`
 * is thirty for a single request, and the same argument scaled — a cap that fires on a
 * healthy-but-slow page converts honest work into a spurious exit 3, which is the exact
 * misclassification this story exists to prevent.
 *
 * This is the OUTERMOST of three nested bounds — see `#bounds` for the ordering and why it
 * is load-bearing. Injectable via `BrowserExecutorDeps` so a test asserts the timeout path
 * in milliseconds instead of waiting it out.
 */
export const BROWSER_PROBE_TIMEOUT_MS = 90_000;

/**
 * How long ONE navigation or ONE action inside the scenario may take.
 *
 * Strictly smaller than the probe timeout, and that ordering is load-bearing rather than
 * tidy: the INNER timeout firing produces a classified `execError` with a message naming
 * what timed out, because the generated driver's `finally` block still runs and still
 * writes its result and its artifacts. The OUTER one firing kills the process group and
 * leaves this file to classify a corpse. Both are honest exit 3, but only the inner one
 * tells an operator which step hung — so the inner one must fire first in every ordinary
 * case, and the outer exists as the backstop that guarantees termination.
 */
export const BROWSER_STEP_TIMEOUT_MS = 30_000;

/**
 * Head-room added to the inner timeout when the SPAWN is bounded.
 *
 * The Playwright runner has to boot, resolve a config, start a worker and launch a browser
 * before the first navigation begins, and it has to write a trace archive afterwards. None
 * of that is covered by the per-action timeout, so bounding the spawn at the inner timeout
 * exactly would kill the process during startup on a cold machine and report it as a
 * step timeout it was not.
 */
export const BROWSER_RUNNER_OVERHEAD_MS = 30_000;

/** Bound on any subprocess text echoed into an error message, following 5.1's. */
const MAX_ECHOED_OUTPUT = 400;

/** The run-directory subfolder every evidence file lives in (Q50), shared with gates. */
const EVIDENCE_DIR = 'evidence';

/**
 * `RelativePath` from `src/schemas/plan.ts`, MIRRORED — one leading slash, no second slash
 * or backslash after it, and no whitespace, control character or backslash anywhere.
 *
 * Copied deliberately rather than imported, exactly as `http.ts` copies it and for the same
 * reason: the schema keeps its patterns module-private, which is the missing-export gap
 * e4-E names. Duplicated with its source stated so a reviewer can diff them and so a
 * divergence is a VISIBLE copy rather than an invisible approximation.
 *
 * This is the pattern that makes `https://evil.example.com/x` and the protocol-relative
 * `//evil.example.com/x` unrepresentable as a probe path AND as a `goto` step target.
 */
const RELATIVE_PATH = /^\/(?![/\\])[^\s\u0000-\u001f\\]*$/;

/**
 * The `source` discriminants `BrowserAssertionTarget` admits.
 *
 * Listed here because the union is a TYPE and params arrive untyped, so the discriminant
 * has to be checkable at run time before anything is read from a target.
 */
const BROWSER_ASSERTION_SOURCES: readonly string[] = ['url', 'title', 'text', 'visible'];

/** The scenario grammar's closed verb set. Nothing outside it parses. */
const SCENARIO_VERBS = ['goto', 'click', 'fill', 'waitFor'] as const;

type ScenarioVerb = (typeof SCENARIO_VERBS)[number];

/**
 * The environment variables the generated files read.
 *
 * Every path the child needs travels this way rather than through interpolation, which is
 * what lets `GENERATED_SPEC` and `GENERATED_CONFIG` be literal constants with nothing
 * caller-derived in them at all. See the module header.
 */
const ENV = {
  runner: 'SPECWITNESS_BROWSER_RUNNER',
  payload: 'SPECWITNESS_BROWSER_PAYLOAD',
  result: 'SPECWITNESS_BROWSER_RESULT',
  trace: 'SPECWITNESS_BROWSER_TRACE',
  screenshot: 'SPECWITNESS_BROWSER_SCREENSHOT',
  testDir: 'SPECWITNESS_BROWSER_TESTDIR',
  spec: 'SPECWITNESS_BROWSER_SPEC',
  output: 'SPECWITNESS_BROWSER_OUTPUT',
  timeout: 'SPECWITNESS_BROWSER_TIMEOUT',
} as const;

/**
 * The generated Playwright config. A CONSTANT — read the module header before changing it.
 *
 * `testMatch` is scoped to ONE spec basename rather than left at Playwright's default,
 * because a run with several browser probes leaves several `.spec.cjs` files in the same
 * evidence directory and the default glob would collect all of them into every probe's run.
 *
 * `retries: 0` is not a preference: retry orchestration belongs to the probes stage
 * (AD-9), and a runner that quietly retried would make `flaky` wrong and hide the attempts.
 */
const GENERATED_CONFIG = `'use strict';
// GENERATED BY SPECWITNESS - EPHEMERAL, DO NOT EDIT.
// A constant: nothing from the plan is interpolated here. Every value arrives by env.
module.exports = {
  testDir: process.env.SPECWITNESS_BROWSER_TESTDIR,
  testMatch: [process.env.SPECWITNESS_BROWSER_SPEC],
  outputDir: process.env.SPECWITNESS_BROWSER_OUTPUT,
  timeout: Number(process.env.SPECWITNESS_BROWSER_TIMEOUT),
  workers: 1,
  retries: 0,
  fullyParallel: false,
  forbidOnly: true,
  reporter: [['line']],
  use: { headless: true, browserName: 'chromium' },
};
`;

/**
 * The generated driver spec. A CONSTANT — read the module header before changing it.
 *
 * It observes and reports; it NEVER adjudicates. The test body succeeds whether or not the
 * page said what the plan expected, because deciding that is `deriveCriterionResult`'s job
 * two layers up and a spec that failed on an unsatisfied expectation would be a second
 * producer of a verdict. What it writes is raw observed values.
 *
 * The `finally` block is the reason a timeout is classifiable: it still writes the result
 * file, the screenshot and the trace when a step threw, so an operator gets the artifact
 * for the moment things went wrong rather than nothing at all.
 *
 * `.cjs`, not `.mjs`: the module is `require`d from a path in an environment variable, and
 * `require` is synchronous, so `test()` is registered during collection the way Playwright's
 * runner expects. The equivalent ESM form needs top-level await. The extension also settles
 * the module system regardless of the enclosing project's `"type"`, and the enclosing
 * project here is whichever repository is being verified.
 */
const GENERATED_SPEC = `'use strict';
// GENERATED BY SPECWITNESS - EPHEMERAL, DO NOT EDIT.
// A constant: the scenario is DATA in the payload file, never code in this file.
const { readFileSync, writeFileSync } = require('node:fs');

const { test } = require(process.env.SPECWITNESS_BROWSER_RUNNER);
const payload = JSON.parse(readFileSync(process.env.SPECWITNESS_BROWSER_PAYLOAD, 'utf8'));

// ⚠️ THIS FUNCTION DELIBERATELY DOES NOT CATCH. An earlier version wrapped the whole body
// in a try/catch that turned every Playwright exception into an ABSENT VALUE - so a page
// that crashed, closed, or timed out WHILE BEING READ produced an unsatisfied assertion and
// the criterion reported product FAIL instead of infrastructure error. That is precisely
// the headline defect this story exists to prevent, arriving through the one door nobody was
// watching, and it was found by the codex review of this branch.
//
// The rule, stated so it is not re-broken: an ABSENCE is a fact about the page and is
// reported as one; an EXCEPTION means the page could not be read at all, and must escape to
// the caller's handler, where it becomes ok:false and therefore an execError. A missing
// element and a dead browser are not the same observation.
//
// An unparseable selector escapes here too, and that is correct rather than merely
// tolerable: SpecWitness could not perform the read, so nothing was adjudicated. Exit 3 is
// honest and can never mint a pass.
async function readOne(page, read) {
  if (read.source === 'url') {
    return { present: true, value: page.url() };
  }
  if (read.source === 'title') {
    return { present: true, value: await page.title() };
  }
  const locator = page.locator(read.selector).first();
  if (await locator.count() === 0) {
    return { present: false, why: 'no element matches the selector' };
  }
  if (read.source === 'visible') {
    return { present: true, value: (await locator.isVisible()) ? 'true' : 'false' };
  }
  if (read.source === 'text') {
    const text = await locator.textContent();
    return text === null
      ? { present: false, why: 'the element has no text content' }
      : { present: true, value: text };
  }
  return { present: false, why: 'this executor cannot read that assertion target' };
}

function describe(error) {
  return error && typeof error.message === 'string' ? error.message : String(error);
}

// ⚠️ AD-3, AT THE ONE PLACE A PATH RULE CANNOT REACH. 'goto' is held to a service-relative
// path before any I/O, but a CLICK is not a path: it follows whatever the page put in an
// href, and the page is written by the system under verification. A step like
// click "a[href='https://production.example']" - or a plain server-side redirect to another
// host - would otherwise drive the verifier at an undeclared origin and then read the
// resulting page as evidence. Found by the codex review of this branch.
//
// So the origin is re-checked after EVERY navigation and before ANY value is read. Leaving
// the declared service is an infrastructure failure, not a product observation: nothing was
// adjudicated, and nothing from an undeclared host may become evidence.
function assertOrigin(page, payload) {
  let current;
  try {
    current = new URL(page.url()).origin;
  } catch (error) {
    current = page.url();
  }
  if (current !== payload.origin) {
    throw new Error(
      'the page left the declared service origin: now at ' + current +
        ', expected ' + payload.origin +
        '. A browser probe may only ever be driven at the service the project declared',
    );
  }
}

test('specwitness browser probe', async ({ page, context }) => {
  const outcome = { ok: false, phase: 'start', message: 'the driver did not run', reads: {} };

  // NOT WRAPPED, and that is the fix for a defect the codex review found: the failure used
  // to be stored in a field nothing read, so a probe whose tracing never started could still
  // report PASS - with none of the trace evidence AC1 requires (Q32). Required evidence that
  // cannot be produced is an infrastructure failure, exactly as a persistence failure is.
  // Throwing here leaves 'ok: false', which the executor classifies as an execError.
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });

  try {
    page.setDefaultTimeout(payload.stepTimeoutMs);
    page.setDefaultNavigationTimeout(payload.stepTimeoutMs);

    outcome.phase = 'navigate';
    await page.goto(payload.url, { waitUntil: 'load' });
    assertOrigin(page, payload);

    for (let index = 0; index < payload.steps.length; index += 1) {
      const step = payload.steps[index];
      outcome.phase = 'step ' + (index + 1) + ' (' + step.verb + ')';
      const locator = step.selector === undefined ? null : page.locator(step.selector).first();
      if (step.verb === 'goto') {
        await page.goto(step.url, { waitUntil: 'load' });
      } else if (step.verb === 'click') {
        await locator.click();
      } else if (step.verb === 'fill') {
        await locator.fill(step.value);
      } else if (step.verb === 'waitFor') {
        await locator.waitFor({ state: 'visible' });
      } else {
        throw new Error('the payload carried a verb this driver does not implement');
      }
      // After EVERY step, not only after a goto: a click is the one that can leave.
      assertOrigin(page, payload);
    }

    outcome.phase = 'read';
    // And once more immediately before anything is read, so no value from an undeclared
    // host can ever become an observation.
    assertOrigin(page, payload);
    for (const read of payload.reads) {
      outcome.reads[read.key] = await readOne(page, read);
    }

    outcome.ok = true;
    delete outcome.message;
    delete outcome.phase;
  } catch (error) {
    outcome.ok = false;
    outcome.message = describe(error);
  } finally {
    try {
      outcome.finalUrl = page.url();
    } catch (error) {
      outcome.finalUrl = null;
    }
    try {
      await page.screenshot({ path: process.env.SPECWITNESS_BROWSER_SCREENSHOT });
      outcome.screenshot = true;
    } catch (error) {
      outcome.screenshot = false;
    }
    try {
      await context.tracing.stop({ path: process.env.SPECWITNESS_BROWSER_TRACE });
      outcome.trace = true;
    } catch (error) {
      outcome.trace = false;
    }
    writeFileSync(process.env.SPECWITNESS_BROWSER_RESULT, JSON.stringify(outcome), 'utf8');
  }
});
`;

/* ── the injected seams ─────────────────────────────────────────────────────────────── */

/**
 * Writes one TEXT evidence file into the run directory and returns its RELATIVE path.
 *
 * COHORT RULE: all four surfaces take this callback, under this name, with this signature —
 * the merged `GateEvidenceWriter` shape verbatim. Structurally identical types are declared
 * per file rather than imported across branches, so each surface compiles whether or not
 * its siblings have merged; e4-F names the consolidation.
 *
 * The run id is deliberately NOT a parameter: `RunStore` keeps it because it serves every
 * run, an executor drops it because it serves exactly one, so this file cannot address
 * another run's directory even by mistake (AD-8).
 */
export interface BrowserEvidenceWriter {
  (relativeName: string, contents: string): Promise<string>;
}

/**
 * Writes one BINARY evidence file into the run directory and returns its RELATIVE path.
 *
 * NEW WITH THIS STORY, and it exists because a trace is a `.zip` and a screenshot is a
 * `.png`. The text writer encodes as UTF-8, which corrupts both. AD-8 keeps `RunStore` the
 * sole writer beneath `.specwitness/runs/`, so this is a second injected callback rather
 * than a licence for the Playwright subprocess to write there itself.
 */
export interface BrowserEvidenceBinaryWriter {
  (relativeName: string, contents: Uint8Array): Promise<string>;
}

/**
 * Hands the typed evidence member to whoever owns the run accumulator.
 *
 * Bound by the probes stage to `context.run.evidence.push`. `adapters-core-only` keeps
 * `src/surfaces/**` away from the accumulator by design and prescribes the remedy in its own
 * comment: "If a story needs an adapter-to-adapter call, that is a port in `src/domain/`,
 * injected by the caller." This is that port in its smallest form, and it needs no widening
 * of `ProbeAttempt`, which stays AD-13-closed.
 */
export interface BrowserEvidenceRecorder {
  (evidence: Evidence): void;
}

/**
 * Turns a run-RELATIVE evidence path into an ABSOLUTE one.
 *
 * Needed for exactly one reason: Playwright's own CLI is a separate process and has to
 * OPEN the generated spec and config, so it needs absolute paths — while Q30/Q31 require
 * those files to live in the run directory. This file still constructs no path beneath
 * `.specwitness/runs/`; it asks the caller, which is the only thing that knows where the
 * run directory is, to resolve one it was already handed.
 */
export interface RunPathResolver {
  (runRelativePath: string): string;
}

/**
 * The Playwright environment 5.1 resolved, declared STRUCTURALLY rather than imported.
 *
 * `adapters-core-only` forbids `src/surfaces/**` from importing `src/infra/**` — they are
 * two adapters, and an adapter-to-adapter import is exactly what the rule refuses. So the
 * shape is restated here and 5.1's `PlaywrightEnvironment` satisfies it structurally, which
 * is the same convention the four surfaces already use for their callback types.
 *
 * **`ready` is the single bit to branch on**, and 5.1 says so: it is
 * `source !== 'absent' && browsersPresent`. `browsersPresent` is deliberately separate from
 * `source` because a resolvable package with no downloaded chromium is a real, common state
 * and is NOT ready. Nothing here re-derives that judgement.
 */
export interface BrowserRuntimeEnvironment {
  /** 5.1's single "can 5.2 run?" bit. */
  readonly ready: boolean;
  /** Absolute, realpath-resolved directory of the resolved Playwright package. */
  readonly packageDir?: string;
  /** Absolute path to Playwright's own CLI entry point. */
  readonly cliPath?: string;
  /** The directory browser bundles are looked for in. */
  readonly browsersPath: string;
  /** 5.1's operator-facing explanation when `ready` is false. Quoted, never paraphrased. */
  readonly reason?: string;
}

export interface BrowserExecutorDeps {
  /** AD-9. The source of `capturedAt` and `durationMs`; `Date.now()` appears nowhere. */
  readonly clock: Clock;
  /** AD-3: `(binary, args[])`, no shell, no way to add one. */
  readonly runner: ProcessRunner;
  /** The verification worktree — the revision under test (AD-8, FR-19). */
  readonly cwd: string;
  /** 5.1's answer. Resolved by the caller; never resolved here. */
  readonly environment: BrowserRuntimeEnvironment;
  readonly writeEvidence: BrowserEvidenceWriter;
  readonly writeEvidenceBytes: BrowserEvidenceBinaryWriter;
  readonly resolveRunPath: RunPathResolver;
  readonly recordEvidence: BrowserEvidenceRecorder;
  /** `RunStore.recordProcessGroup` — AD-8, so `specwitness clean` can reap a browser tree. */
  readonly onProcessGroup?: (pgid: number) => void | Promise<void>;
  /**
   * Bounds the WHOLE spawn — the outermost backstop. Defaults to `BROWSER_PROBE_TIMEOUT_MS`,
   * raised if necessary so it always exceeds the inner test timeout (see `#bounds`).
   */
  readonly timeoutMs?: number;
  /** Bounds one navigation or action. Defaults to `BROWSER_STEP_TIMEOUT_MS`. */
  readonly stepTimeoutMs?: number;
  /** Extra redaction patterns, threaded into every constructor call. */
  readonly redaction?: RedactionOptions;
}

/**
 * What the caller puts in `ProbeRequest.params` for a browser probe.
 *
 * HTTP's shape — see the module header's params section for why this conforms rather than
 * consolidates. Hand-validated rather than re-parsed with the merged zod schema because
 * `BrowserProbeSchema` is module-private in `src/schemas/plan.ts`; that is e4-E, and all
 * four surfaces hand-validate for the identical reason.
 */
export interface BrowserProbeParams {
  /** The compiled probe, with 4.3's deterministic-data bindings ALREADY substituted. */
  readonly probe: BrowserProbe;
  /** Resolved by the caller from 4.1's `resolveServiceBaseUrl`. Never looked up here. */
  readonly baseUrl: string;
  /** 1-based. Defaults to 1. The executor never increments it — it does not retry. */
  readonly attempt?: number;
}

/* ── the scenario, compiled to data ─────────────────────────────────────────────────── */

/**
 * One step of a parsed scenario. A CLOSED union of structured values.
 *
 * This type is the security boundary made concrete: whatever a provider wrote, what reaches
 * the generated driver is one of these four shapes and nothing else. There is no shape here
 * that can carry code, a command, a host or a scheme.
 */
type ScenarioStep =
  | { readonly verb: 'goto'; readonly url: string }
  | { readonly verb: 'click'; readonly selector: string }
  | { readonly verb: 'fill'; readonly selector: string; readonly value: string }
  | { readonly verb: 'waitFor'; readonly selector: string };

/** What one assertion asks the driver to read, keyed back to the assertion's index. */
interface ScenarioRead {
  readonly key: string;
  readonly source: BrowserAssertionTarget['source'];
  readonly selector?: string;
}

interface ScenarioPayload {
  readonly url: string;
  /**
   * The declared service's origin, which the page may never leave (AD-3).
   *
   * `goto` is held to a service-relative path, but a CLICK is not a path — it follows
   * whatever the page put in an `href`, and the page is written by the system under
   * verification. So the origin is carried as data and re-checked after every navigation.
   */
  readonly origin: string;
  readonly steps: readonly ScenarioStep[];
  readonly reads: readonly ScenarioRead[];
  readonly stepTimeoutMs: number;
}

/** What the generated driver reports back. Parsed defensively: it is a file on disk. */
interface DriverOutcome {
  readonly ok: boolean;
  readonly phase?: string;
  readonly message?: string;
  readonly finalUrl?: string | null;
  readonly reads?: Readonly<Record<string, { present: boolean; value?: string; why?: string }>>;
  readonly trace?: boolean;
  readonly screenshot?: boolean;
}

/* ── the executor ───────────────────────────────────────────────────────────────────── */

export class BrowserSurfaceExecutor implements SurfaceExecutor {
  readonly surface = 'browser' as const;

  readonly #deps: BrowserExecutorDeps;

  constructor(deps: BrowserExecutorDeps) {
    this.#deps = deps;
  }

  async execute(request: ProbeRequest): Promise<ProbeAttempt> {
    // EVERYTHING STRUCTURAL IS SETTLED BEFORE ANY I/O, so a malformed plan, a mis-wired
    // caller or an unprovisioned machine can never be mistaken for a broken environment —
    // and, more importantly, can never quietly contribute nothing.
    const redaction = this.#deps.redaction;
    const { probe, baseUrl, attempt } = validateParams(request, redaction);
    const runtime = this.#requireRuntime(request.criterionId, redaction);
    const stepTimeoutMs = this.#deps.stepTimeoutMs ?? BROWSER_STEP_TIMEOUT_MS;

    const url = buildUrl(baseUrl, probe.mechanics.path);
    const steps = parseScenario(probe.mechanics.scenario, request.criterionId, baseUrl, redaction);
    const reads = probe.assertions.map((assertion, index) => readFor(assertion.target, index));
    const payload: ScenarioPayload = {
      url,
      origin: new URL(baseUrl).origin,
      steps,
      reads,
      stepTimeoutMs,
    };

    const stem = evidenceStem(request.criterionId, probe.id, attempt);
    const startedAt = this.#deps.clock.now();

    // Playwright's own artifacts land OUTSIDE the run directory, in a temporary directory
    // this file owns and removes. AD-8 makes `RunStore` the sole writer beneath
    // `.specwitness/runs/`, and a subprocess writing there is exactly what that forbids —
    // so the bytes are copied in afterwards through the injected binary writer.
    const workspace = await mkdtemp(join(tmpdir(), 'specwitness-browser-'));
    try {
      return await this.#runAttempt({
        probe,
        attempt,
        url,
        payload,
        stem,
        startedAt,
        workspace,
        runtime,
        stepTimeoutMs,
        redaction,
      });
    } finally {
      // BEST EFFORT, and never allowed to mask the attempt's own outcome: a temp directory
      // left behind is untidy, while a swallowed classification is a wrong verdict.
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * 5.1's environment, or a refusal. NEVER a skip.
   *
   * `InfraError` before any I/O, quoting 5.1's own `reason` verbatim rather than
   * paraphrasing it: that module computed why the environment is unusable and its words
   * name the path it rejected. This is the row of the classification table that the
   * standing green-for-nothing hazard would otherwise reach — a criterion the plan mapped
   * to a browser check reporting PASS because no probe ran.
   */
  #requireRuntime(
    criterionId: string,
    redaction: RedactionOptions | undefined,
  ): Required<Pick<BrowserRuntimeEnvironment, 'packageDir' | 'cliPath' | 'browsersPath'>> {
    const environment = this.#deps.environment;
    const refuse = (why: string): never => {
      throw new InfraError(
        `browser probe for ${criterionId} cannot run: ${redactText(why, redaction)}`,
        'run `specwitness doctor` to resolve or provision Playwright — a browser probe is ' +
          'never skipped, because a criterion that checked nothing must not report PASS',
      );
    };

    if (!environment.ready) {
      return refuse(environment.reason ?? 'the Playwright environment is not ready');
    }
    // `ready` is 5.1's single bit and these two follow from it, but `params` and injected
    // values both arrive from outside this file, so the promise is checked rather than
    // trusted — the same reasoning `http.ts` gives for re-validating a path at the point of
    // use.
    if (typeof environment.packageDir !== 'string' || environment.packageDir === '') {
      return refuse('the resolved Playwright environment carries no package directory');
    }
    if (typeof environment.cliPath !== 'string' || environment.cliPath === '') {
      return refuse('the resolved Playwright environment carries no CLI entry point');
    }

    return {
      packageDir: environment.packageDir,
      cliPath: environment.cliPath,
      browsersPath: environment.browsersPath,
    };
  }

  async #runAttempt(input: {
    probe: BrowserProbe;
    attempt: number;
    url: string;
    payload: ScenarioPayload;
    stem: string;
    startedAt: Date;
    workspace: string;
    runtime: { packageDir: string; cliPath: string; browsersPath: string };
    stepTimeoutMs: number;
    redaction: RedactionOptions | undefined;
  }): Promise<ProbeAttempt> {
    const { probe, attempt, url, payload, stem, startedAt, workspace, runtime, stepTimeoutMs, redaction } =
      input;

    // THE GENERATED FILES GO IN THE RUN DIRECTORY (Q30/Q31): ephemeral, never in the project
    // tree, never in the verification worktree's sources. The two CODE files are constants;
    // only the payload carries anything a provider wrote, and it carries it as JSON DATA.
    const specRelative = await this.#deps.writeEvidence(`${stem}.spec.cjs`, GENERATED_SPEC);
    const configRelative = await this.#deps.writeEvidence(`${stem}.config.cjs`, GENERATED_CONFIG);

    const specPath = this.#deps.resolveRunPath(specRelative);
    const configPath = this.#deps.resolveRunPath(configRelative);

    // ⚠️ THE PAYLOAD EXISTS TWICE, AND THE SPLIT IS A REDACTION BOUNDARY.
    //
    // The EXECUTION copy carries the real URL — a probe navigated at
    // `?api_key=[REDACTED]` would be navigating somewhere the plan did not name — so it
    // lives in the ephemeral workspace and is destroyed with it, never stored.
    //
    // The EVIDENCE copy is redacted and is the one written into the run directory. Found by
    // this story's own seeded-secret test, which caught the single-copy version writing
    // `?api_key=<canary>` verbatim into a stored artifact: the URL is EVIDENCE TOO, and a
    // token in a query string is a leak sitting right beside properly redacted output.
    //
    // This is exactly the split `http.ts` already makes — it fetches the raw url and puts
    // `redactText(url)` in evidence — applied to a file rather than a field. AD-10 says
    // redaction happens at capture; writing the artifact IS capture.
    //
    // HONEST LIMIT, the same one the module header states for page text: a `fill` value
    // with no assignment shape around it (a bare password, rather than `password=...`) is
    // not something `redactText` can recognise. A project that knows the shape of its own
    // secrets declares `extraPatterns`, which is threaded through here like everywhere else.
    const payloadJson = `${JSON.stringify(payload, null, 2)}\n`;
    const payloadPath = join(workspace, 'payload.json');
    await writeFile(payloadPath, payloadJson, 'utf8');
    const payloadRelative = await this.#deps.writeEvidence(
      `${stem}.payload.json`,
      redactText(payloadJson, redaction),
    );

    const resultPath = join(workspace, 'result.json');
    const tracePath = join(workspace, 'trace.zip');
    const screenshotPath = join(workspace, 'screenshot.png');

    // The aggregate bound has to know HOW MANY independently-bounded operations there are:
    // one initial navigation, one per scenario step, and one per assertion read.
    const { timeoutMs, testTimeoutMs } = this.#bounds(
      stepTimeoutMs,
      1 + payload.steps.length + payload.reads.length,
    );

    // AD-3: ARGV, never a command line. `process.execPath` running Playwright's own CLI is
    // SpecWitness's own hard-coded invocation, on the same footing as 5.1's `npm` spawn and
    // the provider adapters' `claude` / `codex`. No `DeclaredCommand` is minted and none may
    // be: that brand constrains project-declared shell strings, and there is no shell here.
    const result = await this.#deps.runner.run({
      binary: process.execPath,
      args: [runtime.cliPath, 'test', '--config', configPath],
      cwd: this.#deps.cwd,
      timeoutMs,
      env: {
        // Inherited so the child keeps PATH, HOME and the operator's own settings; the
        // values that decide WHERE things are read from are then set explicitly, so a stale
        // variable in the parent cannot silently redirect the run. 5.1's `installBrowsers`
        // makes the same choice for the same reason.
        inherit: true,
        set: {
          PLAYWRIGHT_BROWSERS_PATH: runtime.browsersPath,
          [ENV.runner]: runtime.packageDir,
          [ENV.payload]: payloadPath,
          [ENV.result]: resultPath,
          [ENV.trace]: tracePath,
          [ENV.screenshot]: screenshotPath,
          [ENV.testDir]: dirOf(specPath),
          [ENV.spec]: baseOf(specPath),
          [ENV.output]: join(workspace, 'output'),
          [ENV.timeout]: String(testTimeoutMs),
        },
      },
      ...(this.#deps.onProcessGroup === undefined
        ? {}
        : { onProcessGroup: this.#deps.onProcessGroup }),
    });

    const outcome = await readOutcome(resultPath);
    const durationMs = this.#elapsed(startedAt);
    const finalUrl = typeof outcome?.finalUrl === 'string' ? outcome.finalUrl : url;

    const artifacts = await this.#storeArtifacts({
      stem,
      tracePath: outcome?.trace === true ? tracePath : undefined,
      screenshotPath: outcome?.screenshot === true ? screenshotPath : undefined,
    });

    // COULD NOT LOOK. The browser never launched, crashed, or timed out before the first
    // assertion — `outcome` is absent, or present and reporting a failure. Either way NOTHING
    // was adjudicated, so ZERO assertion evaluations are emitted: `outcomeOf` makes the exec
    // error outrank them anyway, so emitting them would be recorded evidence no verdict is
    // derived from, manufactured out of an infrastructure failure.
    //
    // ⚠️ THE RUNNER'S OWN OUTCOME IS PART OF THIS CONDITION, and leaving it out was a defect
    // found by the codex re-review of this branch. The driver writes its result file inside a
    // `finally`, so `ok: true` can be on disk while the PROCESS is subsequently timed out,
    // killed during teardown, or exits non-zero for a reason the driver never saw. Reading
    // only the file would then adjudicate assertions from a terminated run and could report
    // PASS for a browser that was killed — minting a verdict out of a process that did not
    // finish, which is the same sin as passing a probe that adjudicated nothing.
    //
    // So a verdict requires BOTH: the driver said it observed the page, AND the process that
    // ran it completed with exit 0. Anything else is `execError`.
    const runnerFailed = result.outcome !== 'completed' || result.exitCode !== 0;
    // ⚠️ AND THE TRACE MUST ACTUALLY HAVE LANDED. AC1 requires a trace stored as evidence
    // (Q32), so an attempt that observed the page but produced no trace has not met the
    // story's own evidence bar. Tracing that cannot START now throws inside the driver; this
    // covers the other half - tracing that started and could not be WRITTEN. Reporting PASS
    // there would be the evidence-less green the persistence fix one method below refuses.
    const traceMissing = outcome !== undefined && outcome.ok && outcome.trace !== true;
    const execError =
      outcome === undefined || !outcome.ok || runnerFailed || traceMissing
        ? classifyFailure(result, outcome, url, timeoutMs, redaction, traceMissing)
        : undefined;

    const evaluations =
      execError === undefined
        ? probe.assertions.map((assertion, index) =>
            evaluate(assertion, outcome?.reads?.[readKey(index)], redaction),
          )
        : [];

    const { refs, member } = await this.#captureEvidence({
      stem,
      startedAt,
      durationMs,
      url: finalUrl,
      artifacts,
      execError,
      redaction,
      generated: [specRelative, configRelative, payloadRelative],
    });

    // BOTH CHANNELS. See the module header: an executor that refs its files and forgets this
    // ships reports carrying gate evidence and no probe evidence at all, silently.
    this.#deps.recordEvidence(member);

    return {
      attempt,
      observations: observationsFor(probe, url, finalUrl, redaction),
      assertionEvaluations: evaluations,
      evidence: refs,
      ...(execError === undefined ? {} : { execError }),
      durationMs,
    };
  }

  /**
   * Copies Playwright's binary artifacts into the run directory through the injected writer.
   *
   * ⚠️ TWO FAILURES LIVE HERE AND THEY ARE NOT THE SAME FAILURE. An earlier version wrapped
   * both in one `catch` that returned `undefined`, and the codex auto-review of this branch
   * caught what that collapses: a probe could return a clean PASS while the evidence it is
   * required to carry was silently never written. That is this module's own recurring defect
   * shape — two situations flattened into one code path, so testing one of them proves
   * nothing about the other — arriving for the fourth time in this story, in the tidy-up.
   *
   *   READING THE ARTIFACT FAILS  =>  TOLERATED. Playwright simply did not produce it: the
   *                                   browser never launched, or tracing was unavailable.
   *                                   `trace` and `screenshot` are optional precisely so
   *                                   that this is representable, and the member's
   *                                   `explanation` says which artifacts exist.
   *
   *   WRITING THE ARTIFACT FAILS  =>  PROPAGATES. This is the injected PERSISTENCE
   *                                   BOUNDARY refusing — a full disk, changed permissions,
   *                                   `RunStore`'s containment check. SpecWitness could not
   *                                   record what it observed, and a verdict whose required
   *                                   evidence was silently dropped is exactly the
   *                                   green-for-nothing this product exists to prevent.
   *                                   `RunStore` already raises `InfraError` there, so it
   *                                   surfaces as exit 3 with a message naming the path.
   *
   * That also makes the byte channel behave like the TEXT channel beside it, which has
   * always propagated: `#captureEvidence` does not wrap its `writeEvidence` calls either.
   * The anomaly was the swallow, not the propagation.
   */
  async #storeArtifacts(input: {
    stem: string;
    tracePath: string | undefined;
    screenshotPath: string | undefined;
  }): Promise<{ trace?: string; screenshot?: string }> {
    const copy = async (from: string | undefined, name: string): Promise<string | undefined> => {
      if (from === undefined) {
        return undefined;
      }

      let bytes: Uint8Array;
      try {
        bytes = await readFile(from);
      } catch {
        // The artifact was never produced. Tolerated, and visible in the member's
        // `explanation` rather than inferred from an absent field.
        return undefined;
      }

      // NOT wrapped. See above: a persistence failure is SpecWitness failing to record what
      // it observed, and it must not be turned into a quietly incomplete PASS.
      return await this.#deps.writeEvidenceBytes(name, bytes);
    };

    const trace = await copy(input.tracePath, `${input.stem}.trace.zip`);
    const screenshot = await copy(input.screenshotPath, `${input.stem}.screenshot.png`);

    return {
      ...(trace === undefined ? {} : { trace }),
      ...(screenshot === undefined ? {} : { screenshot }),
    };
  }

  /**
   * Builds the typed member and persists it. See the COHORT RULE in the module header.
   *
   * The member is recorded on EVERY attempt — the per-attempt rule this surface answers
   * differently from http, and the module header says why the union permits it here.
   */
  async #captureEvidence(input: {
    stem: string;
    startedAt: Date;
    durationMs: number;
    url: string;
    artifacts: { trace?: string; screenshot?: string };
    execError: ProbeExecError | undefined;
    redaction: RedactionOptions | undefined;
    generated: readonly string[];
  }): Promise<{ refs: readonly EvidenceRef[]; member: Evidence }> {
    const { stem, startedAt, durationMs, url, artifacts, execError, redaction, generated } = input;

    const member = browserEvidence(
      {
        capturedAt: startedAt.toISOString(),
        url,
        ...(artifacts.trace === undefined ? {} : { trace: artifacts.trace }),
        ...(artifacts.screenshot === undefined ? {} : { screenshot: artifacts.screenshot }),
        durationMs,
        // The explanation is where a MISSING artifact is stated rather than left to be
        // inferred from an absent field, and where the redaction limit is repeated at the
        // point a reviewer meets the artifact. Story 5.3 renders the same sentence in the
        // reviewer-guidance block; it is agreed wording, not a coincidence.
        explanation: [
          execError === undefined
            ? 'the page was observed'
            : `the probe could not complete: ${execError.message}`,
          artifacts.trace === undefined ? 'no trace was captured' : 'a trace was captured',
          artifacts.screenshot === undefined
            ? 'no screenshot was captured'
            : 'a screenshot was captured',
          'screenshots and traces are NOT redacted - image content cannot be scrubbed by a text redactor',
        ].join('; '),
      },
      redaction,
    );

    // No second `redactText` pass over the serialized member: every field the constructor
    // touches is already redacted at capture, and the design of `evidence.ts` is that there
    // is deliberately no non-redacting path into the union.
    const memberPath = await this.#deps.writeEvidence(
      `${stem}.json`,
      `${JSON.stringify(member, null, 2)}\n`,
    );

    const refs: EvidenceRef[] = [evidenceRef('browser', memberPath)];
    // The GENERATED files are evidence too, and this is not padding: they are the complete,
    // reproducible record of what was executed against the page — the payload in particular
    // is the scenario as SpecWitness actually understood it, which is the first thing anyone
    // debugging a surprising browser verdict needs to read.
    for (const path of generated) {
      refs.push(evidenceRef('browser', path));
    }
    if (artifacts.trace !== undefined) {
      refs.push(evidenceRef('browser', artifacts.trace));
    }
    if (artifacts.screenshot !== undefined) {
      refs.push(evidenceRef('browser', artifacts.screenshot));
    }

    return { refs, member };
  }

  /**
   * The THREE nested bounds, and the ordering between them, which is load-bearing.
   *
   *   step   <  test   <  spawn
   *
   * `step` bounds one navigation or one action. `test` bounds the generated driver, and is
   * enforced by Playwright's own runner. `spawn` bounds the whole child process and is
   * enforced by `ProcessRunner`, which tears the process GROUP down when it fires.
   *
   * WHY THE ORDER MATTERS, rather than being tidy: only the INNER two produce a classified
   * `execError` naming what timed out, because the driver's `finally` block still runs and
   * still writes its result, its screenshot and its trace. The OUTER one kills a corpse and
   * leaves this file to say only "it was still running". Both are honest exit 3, but one
   * tells an operator which step hung — so the inner bounds must fire first in every
   * ordinary case, and the spawn bound exists purely to guarantee termination.
   *
   * A caller that injects a small `timeoutMs` (the suites do) still gets a spawn bound that
   * exceeds the test bound, because a spawn killed before its own runner could time out
   * would report every slow machine as an unclassifiable hang.
   */
  #bounds(
    stepTimeoutMs: number,
    operations: number,
  ): { timeoutMs: number; testTimeoutMs: number } {
    // ⚠️ THE AGGREGATE MUST BE AT LEAST THE SUM OF THE PARTS, and the first version was not.
    // It fixed the test bound at `stepTimeoutMs + overhead`, so a scenario whose every
    // operation finished well inside its own documented 30-second bound could still be killed
    // by the aggregate — a 20-second navigation and two 25-second actions add to 70 against a
    // 60-second ceiling. That converts honest work into a spurious exit 3, which is the exact
    // misclassification this module exists to prevent, arriving from the timeout arithmetic
    // rather than from the classification code. Found by the codex review of this branch.
    //
    // So the bound scales with the number of independently-bounded operations. It can get
    // large for a long scenario, and that is correct: it is a BOUND, not a wait. Nothing is
    // slower because the ceiling is higher — only a genuinely hung probe ever reaches it, and
    // capping it lower would reintroduce the false timeout.
    //
    // The runner also has to boot, resolve a config, start a worker and launch a browser
    // before the first navigation, and write a trace archive afterwards; none of that is
    // covered by a per-action timeout, so the head-room is added rather than assumed away.
    const testTimeoutMs = Math.max(1, operations) * stepTimeoutMs + BROWSER_RUNNER_OVERHEAD_MS;
    const requested = this.#deps.timeoutMs ?? BROWSER_PROBE_TIMEOUT_MS;

    return {
      testTimeoutMs,
      timeoutMs: Math.max(requested, testTimeoutMs + BROWSER_RUNNER_OVERHEAD_MS),
    };
  }

  /**
   * Whole milliseconds since `startedAt`, from the injected `Clock` (AD-9) — never
   * `Date.now()`.
   *
   * Called EXACTLY ONCE per `execute()`, so the clock is read exactly twice in total and a
   * test can inject a stepping clock and assert an exact number. Calling it twice would give
   * the evidence member and the attempt two different durations for one probe.
   */
  #elapsed(startedAt: Date): number {
    const elapsed = this.#deps.clock.now().getTime() - startedAt.getTime();
    return Math.max(0, Math.round(elapsed));
  }
}

/* ── params validation: everything structural, before any I/O ───────────────────────── */

function validateParams(
  request: ProbeRequest,
  redaction: RedactionOptions | undefined,
): { probe: BrowserProbe; baseUrl: string; attempt: number } {
  // `redaction` is THREADED IN rather than left to the default: these messages quote a PATH,
  // a SELECTOR and a BASE URL — strings the caller supplied — and they reach stderr through
  // `printError` verbatim. A bare `redactText(value)` applies only the BUILT-IN rules, so a
  // secret shaped like nothing the built-ins recognise (precisely the case a project
  // declares `extraPatterns` for) would be printed in full. `http.ts` learned this in review.
  const redact = (value: string): string => redactText(value, redaction);

  const fail = (why: string, hint: string): never => {
    throw new InfraError(`browser probe params for ${request.criterionId}: ${why}`, hint);
  };

  const params = request.params as Partial<BrowserProbeParams>;
  const probe = params.probe;

  if (probe === undefined || typeof probe !== 'object') {
    return fail(
      "no 'probe' was passed",
      'the caller puts {probe, baseUrl, attempt?} in ProbeRequest.params — see ' +
        'BrowserProbeParams in src/surfaces/browser.ts',
    );
  }

  // THE ENVELOPE'S SURFACE, checked before the nested one. A `ProbeRequest` addressed to
  // another surface reaching this executor is a DISPATCHER defect, and executing it anyway
  // because the nested probe happened to say `browser` would mask exactly the wiring bug the
  // routing contract exists to make visible.
  if (request.surface !== 'browser') {
    return fail(
      `the request is routed to surface '${redact(String(request.surface))}', not 'browser'`,
      'each probe goes to the executor whose surface matches its request; this is a ' +
        'dispatcher defect, not a plan error',
    );
  }
  if (probe.surface !== 'browser') {
    return fail(
      `the probe declares surface '${redact(String(probe.surface))}', not 'browser'`,
      'route each probe to the executor whose surface matches; this is a wiring defect, ' +
        'not a plan error',
    );
  }

  // `probe.id` is part of every evidence filename, so an id that is missing or not a string
  // would throw a raw `TypeError` inside `slugify` — past the pre-I/O promise this function
  // makes. Checked where the promise is made.
  if (typeof probe.id !== 'string' || probe.id.trim() === '') {
    return fail(
      "the probe has no string 'id'",
      'a probe id names the probe within its criterion and is part of every evidence filename',
    );
  }

  const mechanics = probe.mechanics;
  if (mechanics === undefined || typeof mechanics !== 'object') {
    return fail("the probe carries no 'mechanics'", 'compile the plan with the merged plan schema');
  }

  // `serviceId` ties this probe to a DECLARED service (AD-3). This executor never reads it —
  // the caller resolved `baseUrl` from it already — but a probe arriving without one is a
  // probe associated with no declared service, and driving a browser at it would mean
  // executing something the AD-3 chain cannot account for.
  if (typeof mechanics.serviceId !== 'string' || mechanics.serviceId.trim() === '') {
    return fail(
      "the probe has no string 'mechanics.serviceId'",
      'a browser probe names a declared service; the caller resolves that id into the base ' +
        'URL it passes in',
    );
  }

  const path = mechanics.path;
  // AD-3, enforced again at the point of use with THE SCHEMA'S OWN PATTERN rather than an
  // approximation of it. `https://evil.example.com/x` has no leading slash and is refused;
  // `//evil.example.com/x` — the protocol-relative form, which is the version of this that
  // LOOKS like a path — is refused by the negative lookahead. Re-validating is not redundant:
  // `params` arrives untyped, so this executor's guarantee must not depend on which
  // validator ran upstream.
  if (typeof path !== 'string' || !RELATIVE_PATH.test(path)) {
    return fail(
      `path '${redact(String(path))}' is not service-relative`,
      "a plan names a declared service and a path beginning with a single '/', with no " +
        "scheme, host, protocol-relative '//', backslash, whitespace or control character",
    );
  }

  if (typeof mechanics.scenario !== 'string' || mechanics.scenario.trim() === '') {
    return fail(
      "the probe has no non-empty 'mechanics.scenario'",
      'a browser probe describes the interaction to perform; see the scenario grammar in ' +
        'src/surfaces/browser.ts',
    );
  }

  if (!Array.isArray(probe.assertions) || probe.assertions.length === 0) {
    return fail(
      'the probe declares no assertions',
      'a probe that adjudicates nothing cannot mint a PASS — the plan schema enforces at ' +
        'least one',
    );
  }

  // EVERY ASSERTION IS SHAPE-CHECKED BEFORE IT IS DEREFERENCED. `ProbeRequest.params` is
  // `Readonly<Record<string, unknown>>`, so nothing has type-checked its interior — and this
  // function's whole promise is that a malformed params object throws `InfraError` BEFORE
  // any I/O. Reading `assertion.target.source` without checking throws a raw `TypeError` for
  // something as ordinary as `{assertions: [{}]}`, which is neither an InfraError nor
  // classified at all.
  probe.assertions.forEach((assertion, index) => {
    const at = `assertions[${index}]`;
    if (assertion === null || typeof assertion !== 'object') {
      fail(`${at} is not an object`, 'compile the plan with the merged plan schema');
      return;
    }
    if (typeof assertion.description !== 'string' || typeof assertion.expected !== 'string') {
      fail(
        `${at} is missing a string 'description' or 'expected'`,
        'both are copied verbatim into the recorded AssertionEvaluation, so both must be strings',
      );
      return;
    }
    if (!ASSERTION_COMPARISONS.includes(assertion.comparison)) {
      fail(
        `${at} declares comparison '${redact(String(assertion.comparison))}'`,
        `ASSERTION_COMPARISONS is closed: ${ASSERTION_COMPARISONS.join(', ')}`,
      );
      return;
    }

    const target: unknown = assertion.target;
    if (target === null || typeof target !== 'object') {
      fail(
        `${at} has no 'target'`,
        'each assertion names what to read: url, title, text or visible',
      );
      return;
    }

    const source = (target as { source?: unknown }).source;
    if (!BROWSER_ASSERTION_SOURCES.includes(source as string)) {
      fail(
        `${at} reads from '${redact(String(source))}', which is not a browser assertion target`,
        `BrowserAssertionTarget is a closed union: ${BROWSER_ASSERTION_SOURCES.join(', ')}`,
      );
      return;
    }

    if (source === 'text' || source === 'visible') {
      const selector = (target as { selector?: unknown }).selector;
      // A selector that is not a non-empty string reaches `page.locator()` in the generated
      // driver, where it throws AFTER a browser has been launched and a page navigated —
      // past the point this validator promised to have caught it, leaving a run that really
      // did open a browser with an unclassified failure. The same defect class `http.ts`
      // found for header names, closed the same way.
      if (typeof selector !== 'string' || selector.trim() === '') {
        fail(
          `${at} reads '${redact(String(source))}' with no selector`,
          "a text or visible assertion names the element to read, e.g. {source: 'text', " +
            "selector: '#total'}",
        );
      }
    }
  });

  const baseUrl = params.baseUrl;
  if (typeof baseUrl !== 'string' || baseUrl === '') {
    return fail(
      "no 'baseUrl' was passed",
      'src/surfaces/** may not import src/config/**, so the CALLER resolves the service ' +
        "base URL (4.1's resolveServiceBaseUrl) and passes it in",
    );
  }
  try {
    void new URL(baseUrl);
  } catch {
    return fail(
      `baseUrl '${redact(baseUrl)}' is not a valid absolute URL`,
      'pass the origin resolved from the project config, e.g. http://127.0.0.1:3000',
    );
  }

  const attempt = params.attempt ?? 1;
  if (!Number.isInteger(attempt) || attempt < 1) {
    return fail(
      `attempt '${redact(String(params.attempt))}' is not a positive integer`,
      'attempt numbers are 1-based; the executor runs exactly one attempt per call and ' +
        'never increments it',
    );
  }

  return { probe: probe as BrowserProbe, baseUrl, attempt };
}

/**
 * Joins the resolved base URL with the declared path.
 *
 * Concatenation rather than `new URL(path, base)`, following `http.ts` and for its reason:
 * relative-URL resolution treats a leading `/` as ROOT-relative, so a service declared at
 * `http://host/app` with a probe path of `/orders` would silently be driven at
 * `http://host/orders` — a different page, quietly, with a green or red result describing
 * something the plan did not ask about.
 */
function buildUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

/* ── the scenario grammar ───────────────────────────────────────────────────────────── */

/**
 * Compiles the untrusted scenario into structured steps, or REFUSES.
 *
 * Refusal is `InfraError` before any I/O — never a silent skip and never an `execError`.
 * See the module header for why an unparseable line cannot simply be ignored: a scenario
 * describing an interaction SpecWitness cannot perform, executed as navigate-then-assert,
 * would report a UI criterion as verified without the interaction that makes the assertion
 * mean anything.
 *
 * Nothing in here can produce a value that is not one of `ScenarioStep`'s four shapes, and
 * none of those shapes can carry a scheme, a host, a command or code.
 */
function parseScenario(
  scenario: string,
  criterionId: string,
  baseUrl: string,
  redaction: RedactionOptions | undefined,
): readonly ScenarioStep[] {
  const steps: ScenarioStep[] = [];

  const refuse = (lineNumber: number, why: string, hint: string): never => {
    throw new InfraError(
      `browser probe scenario for ${criterionId}, line ${lineNumber}: ${redactText(why, redaction)}`,
      hint,
    );
  };

  const lines = scenario.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const lineNumber = index + 1;
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }

    const match = /^([A-Za-z]+)\s*(.*)$/.exec(line);
    const verb = match?.[1];
    if (match === null || verb === undefined || !isScenarioVerb(verb)) {
      return refuse(
        lineNumber,
        `'${line}' is not a directive this executor can perform`,
        `a scenario is a sequence of directives, one per line, with quoted arguments: ` +
          `${SCENARIO_VERBS.join(', ')}. Lines beginning with '#' are comments. Free prose ` +
          'is refused rather than ignored, because executing a browser probe WITHOUT the ' +
          'interaction it describes would report a criterion as verified having checked ' +
          'nothing. Rewrite the scenario as directives, or raise an additive follow-up for ' +
          'a structured steps field on BrowserProbeMechanics',
      );
    }

    const args = parseArguments(match[2] ?? '');
    if (args === undefined) {
      return refuse(
        lineNumber,
        `the arguments of '${line}' are not a sequence of quoted strings`,
        `quote every argument, e.g. fill "#email" "alice@example.com" — unquoted arguments ` +
          'are refused rather than split on whitespace, because a selector may legitimately ' +
          'contain spaces and guessing would run a directive nobody wrote',
      );
    }

    steps.push(buildStep(verb, args, lineNumber, baseUrl, refuse));
  }

  return steps;
}

function isScenarioVerb(value: string): value is ScenarioVerb {
  return (SCENARIO_VERBS as readonly string[]).includes(value);
}

/**
 * Reads a whitespace-separated sequence of quoted strings, or `undefined` for anything else.
 *
 * Single or double quotes, with a backslash escaping the next character so a selector may
 * contain a quote. Deliberately tiny: this is the only parser standing between untrusted
 * prose and a structured step, and every feature it grows is a place for two readings of one
 * line to diverge.
 */
function parseArguments(text: string): readonly string[] | undefined {
  const args: string[] = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    if (char === ' ' || char === '\t') {
      index += 1;
      continue;
    }
    if (char !== '"' && char !== "'") {
      return undefined;
    }

    const quote = char;
    let value = '';
    index += 1;
    let closed = false;

    while (index < text.length) {
      const current = text[index];
      if (current === '\\') {
        const escaped = text[index + 1];
        if (escaped === undefined) {
          return undefined;
        }
        value += escaped;
        index += 2;
        continue;
      }
      if (current === quote) {
        closed = true;
        index += 1;
        break;
      }
      value += current;
      index += 1;
    }

    if (!closed) {
      return undefined;
    }
    args.push(value);
  }

  return args;
}

/** One parsed directive, or a refusal. Arity and argument shape are both checked here. */
function buildStep(
  verb: ScenarioVerb,
  args: readonly string[],
  lineNumber: number,
  baseUrl: string,
  refuse: (lineNumber: number, why: string, hint: string) => never,
): ScenarioStep {
  const requireSelector = (): string => {
    const selector = args[0];
    if (args.length !== 1 || selector === undefined || selector.trim() === '') {
      return refuse(
        lineNumber,
        `${verb} takes exactly one non-empty selector`,
        `e.g. ${verb} "#submit"`,
      );
    }
    return selector;
  };

  switch (verb) {
    case 'goto': {
      const path = args[0];
      if (args.length !== 1 || path === undefined) {
        return refuse(lineNumber, 'goto takes exactly one path', 'e.g. goto "/orders"');
      }
      // AD-3 AGAIN, AND THIS IS THE ONE A HOSTILE SCENARIO REACHES FOR. `BrowserProbeMechanics`
      // has no URL field, so the only place a plan could try to name a host is inside the
      // scenario prose — and that is refused here with the schema's own path rule. An absolute
      // URL has no leading slash; a protocol-relative `//evil.example.com` is caught by the
      // negative lookahead. A browser probe can only ever be driven at the origin the CALLER
      // resolved from the project's own config.
      if (!RELATIVE_PATH.test(path)) {
        return refuse(
          lineNumber,
          `goto target '${path}' is not service-relative`,
          'a browser probe is driven only at the declared service the caller resolved; a ' +
            'scenario may name a path beginning with a single "/", never a scheme, a host ' +
            'or a protocol-relative "//" — AD-3 has no production URL defaults',
        );
      }
      return { verb: 'goto', url: buildUrl(baseUrl, path) };
    }
    case 'fill': {
      const selector = args[0];
      const value = args[1];
      if (args.length !== 2 || selector === undefined || value === undefined || selector.trim() === '') {
        return refuse(
          lineNumber,
          'fill takes exactly a selector and a value',
          'e.g. fill "#email" "alice@example.com"',
        );
      }
      return { verb: 'fill', selector, value };
    }
    case 'click':
      return { verb: 'click', selector: requireSelector() };
    case 'waitFor':
      return { verb: 'waitFor', selector: requireSelector() };
    default: {
      const exhaustive: never = verb;
      return refuse(
        lineNumber,
        `unknown directive '${String(exhaustive)}'`,
        'SCENARIO_VERBS is closed; widening it is a change to this executor',
      );
    }
  }
}

/* ── assertions ─────────────────────────────────────────────────────────────────────── */

/** The key an assertion's read travels under, so a read maps back to its assertion. */
function readKey(index: number): string {
  return `a${index}`;
}

function readFor(target: BrowserAssertionTarget, index: number): ScenarioRead {
  return {
    key: readKey(index),
    source: target.source,
    ...(target.source === 'text' || target.source === 'visible'
      ? { selector: target.selector }
      : {}),
  };
}

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
        'ASSERTION_COMPARISONS is closed; widening it is an ADR in docs/adr/, and every ' +
          'executor switches on it exhaustively',
      );
    }
  }
}

/**
 * Evaluates one declared assertion against what the driver read, satisfied or not.
 *
 * EVERY assertion produces an evaluation, including the satisfied ones — see the module
 * header. A read the driver could not perform is UNSATISFIED, for every comparison including
 * the negative ones, and never an `execError`: the page answered, and the answer was that
 * nothing matched.
 */
function evaluate(
  assertion: Assertion<BrowserAssertionTarget>,
  read: { present: boolean; value?: string; why?: string } | undefined,
  redaction: RedactionOptions | undefined,
): AssertionEvaluation {
  const description = redactText(assertion.description, redaction);
  // `expected` is as capable of holding a credential as `actual` is — a plan asserting that
  // a page shows a token puts it here — and it is persisted to result.json and printed
  // exactly the same way. `http.ts` learned in review that protecting only `actual` leaves
  // the two sides of one comparison under different rules.
  const expected = redactText(assertion.expected, redaction);
  const describeTarget = targetDescription(assertion.target);

  if (read === undefined) {
    // The driver reported success but returned no read for this assertion. That is a defect
    // in this file's own wiring, not an observation — so it fails CLOSED, as an unsatisfied
    // assertion naming what happened, rather than being dropped (which would shrink the set
    // of things the criterion was adjudicated on without anybody noticing).
    return {
      description,
      satisfied: false,
      expected,
      actual: `<no value was read for ${describeTarget}>`,
    };
  }

  if (!read.present) {
    return {
      description,
      satisfied: false,
      expected,
      actual: redactText(`<${read.why ?? 'the value was not there'}: ${describeTarget}>`, redaction),
    };
  }

  const actual = read.value ?? '';
  return {
    description,
    satisfied: compare(assertion.comparison, actual, assertion.expected),
    expected,
    // Anonymous targets take the ordinary text redaction, exactly as http's `status` and
    // `body` do; see the module header for the named-value limit this shares with them.
    actual: redactText(actual, redaction),
  };
}

/** Human-readable identification of what an assertion read, for an `actual` that has none. */
function targetDescription(target: BrowserAssertionTarget): string {
  switch (target.source) {
    case 'url':
      return 'the page url';
    case 'title':
      return 'the page title';
    case 'text':
      return `the text of ${target.selector}`;
    case 'visible':
      return `the visibility of ${target.selector}`;
    default: {
      const exhaustive: never = target;
      throw new InfraError(
        `unknown browser assertion target '${JSON.stringify(exhaustive)}'`,
        'BrowserAssertionTarget is a closed union in src/domain/plan.ts; widening it is an ADR',
      );
    }
  }
}

/** What was attempted and where it ended up. Redacted like everything else. */
function observationsFor(
  probe: BrowserProbe,
  url: string,
  finalUrl: string,
  redaction: RedactionOptions | undefined,
): readonly Observation[] {
  return [
    { name: 'browser.url', value: redactText(url, redaction) },
    { name: 'browser.finalUrl', value: redactText(finalUrl, redaction) },
    { name: 'browser.serviceId', value: redactText(probe.mechanics.serviceId, redaction) },
  ];
}

/* ── reading the driver's report ────────────────────────────────────────────────────── */

/**
 * Reads the driver's result file, or `undefined` when there is none to read.
 *
 * `undefined` is the LAUNCH-FAILURE signal and is deliberately not distinguished from a
 * malformed file: both mean the driver did not get far enough to say anything, which is the
 * same fact about the observation. Never throws — a failure to read a diagnostic must not
 * become the diagnosis.
 */
async function readOutcome(resultPath: string): Promise<DriverOutcome | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(resultPath, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') {
      return undefined;
    }
    return parsed as DriverOutcome;
  } catch {
    return undefined;
  }
}

/**
 * Turns a failure to observe into a `ProbeExecError` with a message and a useful hint.
 *
 * Every string goes through `redactText`: the URL may carry a token in its query string,
 * and Playwright's own stderr echoes whatever the page and the runner printed. The hints are
 * written for the person who has to fix the ENVIRONMENT, because this channel becomes exit
 * 3 — "fix your environment", not "your code is broken".
 */
function classifyFailure(
  result: ProcessResult,
  outcome: DriverOutcome | undefined,
  url: string,
  timeoutMs: number,
  redaction: RedactionOptions | undefined,
  traceMissing = false,
): ProbeExecError {
  const redact = (text: string): string => redactText(text, redaction);
  const safeUrl = redact(url);

  if (traceMissing) {
    return {
      message: redact(
        `the browser probe against ${safeUrl} observed the page, but no Playwright trace was ` +
          'captured, so the evidence this story requires does not exist',
      ),
      hint: 'a trace is required evidence (AC1/Q32), not a convenience — check that the ' +
        'run directory is writable and that this Playwright build supports tracing',
    };
  }

  if (result.outcome === 'not-found') {
    return {
      message: redact(`the Playwright runner could not be started for ${safeUrl}`),
      hint: 'the resolved Playwright CLI is not executable — run `specwitness doctor` to ' +
        're-resolve or provision it',
    };
  }

  if (result.outcome === 'timed-out') {
    return {
      message: redact(
        `the browser probe against ${safeUrl} was still running after ${timeoutMs}ms and its ` +
          'process group was terminated',
      ),
      hint: 'the whole attempt outlived its bound, so no assertion was adjudicated — raise ' +
        'the probe timeout, or narrow the scenario. The process group was reaped, so no ' +
        'browser was left behind',
    };
  }

  if (outcome === undefined) {
    return {
      message: redact(
        `the browser never reported on ${safeUrl}: ${echo(result.stderr) || echo(result.stdout) || 'the runner produced no output'}`,
      ),
      hint: 'the browser did not launch, or the runner exited before the page was opened — ' +
        'check that a browser is downloaded (`specwitness doctor`) and that the machine has ' +
        'the shared libraries a headless chromium needs',
    };
  }

  // THE DRIVER SAID IT OBSERVED THE PAGE, BUT THE PROCESS DID NOT FINISH CLEANLY. The result
  // file was written in a `finally`, so it can predate a kill, a teardown failure or a
  // non-zero exit. Nothing may be adjudicated from it: the run did not complete, and a
  // verdict drawn from a terminated process is a verdict drawn from an unknown state.
  if (outcome.ok) {
    return {
      message: redact(
        `the browser probe against ${safeUrl} reported success, but the Playwright runner ` +
          `exited ${result.outcome} with code ${result.exitCode ?? 'none'}: ` +
          `${echo(result.stderr) || echo(result.stdout) || 'no output'}`,
      ),
      hint: 'the driver wrote its result before the process ended, so the observation cannot ' +
        'be trusted and no assertion was adjudicated from it — check whether the run was ' +
        'killed, or whether the Playwright runner failed after the page was read',
    };
  }

  // The driver ran and reported a failure of its own: a navigation that never completed, a
  // step whose element never appeared, or a crash mid-run. `phase` names which.
  return {
    message: redact(
      `the browser probe against ${safeUrl} failed during ${outcome.phase ?? 'execution'}: ` +
        `${outcome.message ?? 'no reason was reported'}`,
    ),
    hint: 'nothing was adjudicated, so this is an infrastructure failure rather than a ' +
      'product one — check that the service is serving the page, and that the scenario ' +
      "names elements the page actually has. A step that cannot run is not the same as an " +
      'assertion that was not met',
  };
}

/** Bounded, single-line echo of subprocess output. Following 5.1's `MAX_ECHOED_OUTPUT`. */
function echo(text: string): string {
  const trimmed = text.trim();
  return trimmed === '' ? '' : trimmed.slice(0, MAX_ECHOED_OUTPUT).replace(/\s+/g, ' ');
}

/* ── evidence file names ────────────────────────────────────────────────────────────── */

const UNSAFE = /[^A-Za-z0-9._-]+/g;
const SLUG_MAX_CHARS = 64;

/**
 * Derives at most one safe path component from the criterion and probe ids, and includes the
 * attempt.
 *
 * The FOURTH copy of this derivation — e4-F names the consolidation, and this story conforms
 * rather than fixing it. The argument, restated because it is not obvious: a schema-VALID id
 * containing `..` hits `RunStore`'s containment rule and an over-long one raises
 * `ENAMETOOLONG`, both arriving as `InfraError` — exit 3 for a perfectly good verification
 * run, blaming infrastructure for a probe id that merely contains a dot.
 *
 * THE ATTEMPT NUMBER IS NOT DECORATION. `deriveCriterionResult` reads the FINAL attempt, so
 * if attempt 2's trace overwrote attempt 1's, a flaky pass would point at a trace that no
 * longer shows the failure it was flaky about.
 *
 * NEITHER IS THE FINGERPRINT: `plan.ts` makes probe ids unique only WITHIN a criterion, so
 * two criteria may each hold a probe called `checkout` and a name built from the probe id
 * alone would give both the same files — one criterion's trace pointed at by the other's
 * reference, which is worse than no evidence. The digest is SHA-256 and is NOT truncated,
 * for the reason `http.ts` records at length: digest WIDTH and collision RESISTANCE are not
 * the same quantity, and a truncated 96-bit digest carries only ~48 bits of the latter.
 */
function evidenceStem(criterionId: string, probeId: string, attempt: number): string {
  const ordinal = String(attempt).padStart(2, '0');
  const parts = [
    slugify(criterionId),
    slugify(probeId),
    createHash('sha256').update(`${criterionId}\u0000${probeId}`, 'utf8').digest('hex'),
  ].filter((part) => part !== '');

  return `${EVIDENCE_DIR}/browser-${parts.join('-')}-${ordinal}`;
}

/** Normalises one id into at most one safe path component. Total: every string maps. */
function slugify(id: string): string {
  return id
    .replace(UNSAFE, '-')
    .replace(/-{2,}/g, '-')
    // Collapse dot runs so the literal `..` cannot appear anywhere in the result, not merely
    // at the edges.
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '')
    .slice(0, SLUG_MAX_CHARS)
    .replace(/[-.]+$/, '');
}

/* ── the two path helpers, kept local so no `node:path` habit spreads ───────────────── */

/**
 * The directory part of an absolute path, and the basename.
 *
 * Written against `/` and `\` rather than imported from `node:path` for one reason: these
 * two values are handed to PLAYWRIGHT as `testDir` and `testMatch`, and `testMatch` is a
 * GLOB. `path.basename` would happily return a name containing glob metacharacters; these
 * helpers do the same, so the real protection is that the name is derived from `evidenceStem`
 * above, which admits only `[A-Za-z0-9._-]`. Stated here so the coupling is visible.
 */
function dirOf(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return at <= 0 ? path : path.slice(0, at);
}

function baseOf(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return at === -1 ? path : path.slice(at + 1);
}
