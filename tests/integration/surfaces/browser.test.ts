/**
 * The browser surface executor, driven against a REAL headless browser — story 5.2.
 *
 * Nothing here is mocked. A real fixture app on a real ephemeral socket, a real Playwright
 * runner spawned through the real `ProcessRunner`, a real chromium. Every classification
 * test PRODUCES the state it asserts on rather than asserting over a mocked outcome value:
 * the launch failure points the runner at a browser registry that contains no browser, and
 * the timeout uses a server that accepts the socket and never answers.
 *
 * ⚠️ **A SKIPPED TEST AND A SKIPPED CRITERION ARE DIFFERENT THINGS.** This file skips
 * loudly, with a counted reason, on a machine with no usable Playwright. The PRODUCTION
 * code has NO skip path: every route by which a browser probe could produce no attempts is
 * an `InfraError` or an `execError`. Conflating the two is Epic 4 retro §2 observation 2
 * arriving a third time, and this story exists to make it impossible.
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';

import { deriveCriterionResult } from '../../../src/domain/criterion-result.js';
import type { ContractCriterionRef, ProbeAttempt } from '../../../src/domain/criterion-result.js';
import type { ProcessOutcome } from '../../../src/domain/process-runner.js';
import type { BrowserEvidence } from '../../../src/domain/evidence.js';
import { BrowserSurfaceExecutor } from '../../../src/surfaces/browser.js';
import {
  announceBrowserAvailability,
  clock,
  createEvidenceSink,
  createRecordingRunner,
  describeWithBrowser,
  ordersPage,
  playwrightEnvironment,
  readSinkFile,
  startFixtureApp,
  SUITE_SPAWN_TIMEOUT_MS,
  type EvidenceSink,
  type FixtureApp,
} from './helpers/browser-fixture.js';

const CRITERION: ContractCriterionRef = {
  criterionId: 'E5-02',
  statement: 'the orders page shows the customer their orders',
  severity: 'critical',
  verifiability: 'automated',
};

/** Generous: a browser launch on a loaded machine is slow, and a false timeout is a lie. */
const TEST_TIMEOUT_MS = 120_000;

let app: FixtureApp;
const sinks: EvidenceSink[] = [];

beforeAll(async () => {
  await announceBrowserAvailability();

  app = await startFixtureApp((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === '/orders') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(
        ordersPage(
          '<h1 id="heading">Orders</h1>' +
            '<p id="count">3</p>' +
            '<div id="banner" style="display:none">hidden banner</div>' +
            '<input id="search" />' +
            '<button id="apply" onclick="document.getElementById(\'heading\').textContent = ' +
            "'Filtered: ' + document.getElementById('search').value\">Apply</button>",
        ),
      );
      return;
    }

    if (url.pathname === '/second') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(ordersPage('<h1 id="heading">Second page</h1>'));
      return;
    }

    response.writeHead(404, { 'content-type': 'text/html' });
    response.end(ordersPage('<h1 id="heading">Not found</h1>'));
  });
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  await app.close();
});

afterEach(async () => {
  await Promise.all(sinks.splice(0).map(async (sink) => await sink.cleanup()));
});

interface RunInput {
  readonly scenario?: string;
  readonly path?: string;
  readonly assertions: readonly {
    description: string;
    target: unknown;
    comparison: string;
    expected: string;
  }[];
  readonly baseUrl?: string;
  readonly browsersPath?: string;
  readonly stepTimeoutMs?: number;
  readonly timeoutMs?: number;
  readonly attempt?: number;
  /**
   * Forces ONLY the process-outcome fields of an otherwise completely real run.
   *
   * Used by exactly one test, and the reason it exists is worth stating rather than hiding:
   * the state under test is "the driver wrote its result file, and THEN the process died" —
   * a race whose window is the few milliseconds between the `finally` block's last write and
   * the process exiting. Producing that deterministically would mean timing a kill into that
   * window, which is precisely the kind of flaky test this suite must not contain.
   *
   * Everything else stays real: a real browser launches, a real page is read, real artifacts
   * are written, and the driver really does report `ok: true`. Only the runner's verdict on
   * its own child is overridden — which IS the state, not a simulation of the outcome the
   * assertion checks.
   */
  readonly forceProcessOutcome?: { outcome: ProcessOutcome; exitCode: number | null };
}

interface Executed {
  readonly attempt: ProbeAttempt;
  readonly sink: EvidenceSink;
  readonly spawns: readonly { binary: string; args: readonly string[] }[];
}

async function execute(input: RunInput): Promise<Executed> {
  const environment = await playwrightEnvironment();
  if (!environment.ready) {
    throw new Error('the suite should have skipped: no usable Playwright');
  }

  const sink = await createEvidenceSink();
  sinks.push(sink);
  const recording = createRecordingRunner();
  const forced = input.forceProcessOutcome;
  const runner =
    forced === undefined
      ? recording
      : {
          run: async (options: Parameters<typeof recording.run>[0]) => ({
            ...(await recording.run(options)),
            ...forced,
          }),
        };

  const executor = new BrowserSurfaceExecutor({
    clock,
    runner,
    cwd: process.cwd(),
    environment: {
      ...environment,
      ...(input.browsersPath === undefined ? {} : { browsersPath: input.browsersPath }),
    },
    writeEvidence: sink.writeEvidence,
    writeEvidenceBytes: sink.writeEvidenceBytes,
    resolveRunPath: sink.resolveRunPath,
    recordEvidence: sink.recordEvidence,
    stepTimeoutMs: input.stepTimeoutMs ?? 15_000,
    timeoutMs: input.timeoutMs ?? SUITE_SPAWN_TIMEOUT_MS,
  });

  const attempt = await executor.execute({
    criterionId: CRITERION.criterionId,
    surface: 'browser',
    params: {
      probe: {
        id: 'orders',
        surface: 'browser',
        mechanics: {
          serviceId: 'web',
          path: input.path ?? '/orders',
          scenario: input.scenario ?? '# nothing to interact with',
        },
        assertions: input.assertions,
      },
      baseUrl: input.baseUrl ?? app.baseUrl,
      ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
    },
  });

  return { attempt, sink, spawns: recording.spawns };
}

const HEADING_IS_ORDERS = {
  description: 'the heading reads Orders',
  target: { source: 'text', selector: '#heading' },
  comparison: 'equals',
  expected: 'Orders',
};

describeWithBrowser('the browser surface reads what the page actually shows', () => {
  it(
    'evaluates all four merged assertion targets, satisfied — and derives PASS',
    async () => {
      const { attempt } = await execute({
        assertions: [
          HEADING_IS_ORDERS,
          {
            description: 'the title is Orders',
            target: { source: 'title' },
            comparison: 'equals',
            expected: 'Orders',
          },
          {
            description: 'the url is the orders page',
            target: { source: 'url' },
            comparison: 'contains',
            expected: '/orders',
          },
          {
            description: 'the banner is hidden',
            target: { source: 'visible', selector: '#banner' },
            comparison: 'equals',
            expected: 'false',
          },
        ],
      });

      expect(attempt.execError).toBeUndefined();
      // EVERY assertion produces an evaluation, including the satisfied ones (FR-28).
      expect(attempt.assertionEvaluations).toHaveLength(4);
      expect(attempt.assertionEvaluations.every((e) => e.satisfied)).toBe(true);
      // Every one carries BOTH sides, so the record of what was checked is complete.
      for (const evaluation of attempt.assertionEvaluations) {
        expect(evaluation.expected).toBeDefined();
        expect(evaluation.actual).toBeDefined();
      }
      expect(deriveCriterionResult(CRITERION, [attempt]).status).toBe('pass');
      expect(attempt.attempt).toBe(1);
      expect(Number.isInteger(attempt.durationMs)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'an assertion that looked and saw wrong is FAIL, not error (AC2, the product side)',
    async () => {
      const { attempt } = await execute({
        assertions: [
          {
            description: 'the heading reads Invoices',
            target: { source: 'text', selector: '#heading' },
            comparison: 'equals',
            expected: 'Invoices',
          },
        ],
      });

      // ⚠️ THE MIRROR IMAGE of the classification headline: a real product defect must not
      // be disguised as an environment problem, which would exit 3 instead of 1.
      expect(attempt.execError).toBeUndefined();
      expect(attempt.assertionEvaluations[0]?.satisfied).toBe(false);
      expect(attempt.assertionEvaluations[0]?.actual).toBe('Orders');

      const derived = deriveCriterionResult(CRITERION, [attempt]);
      expect(derived.status).toBe('fail');
      expect(derived.expected).toBe('Invoices');
      expect(derived.actual).toBe('Orders');
      expect(derived.evidence?.length ?? 0).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    ['equals', 'Orders'],
    ['notEquals', 'Orders'],
    ['contains', 'Ord'],
    ['notContains', 'Ord'],
    ['greaterThan', '1'],
    ['lessThan', '9'],
  ])(
    'a selector matching nothing is UNSATISFIED for %s — never a pass minted from an absence',
    async (comparison, expected) => {
      // ⚠️ Including the NEGATIVE comparisons, which is the whole point: a missing element
      // does not satisfy `notEquals`, and it does not satisfy `notContains` either. Both are
      // expectations ABOUT a value, and a value that does not exist cannot meet one. The
      // alternative mints a PASS out of an absence — the one direction this product must
      // never fail in (`http.ts:180-186`, the same rule on a different surface).
      const { attempt } = await execute({
        assertions: [
          {
            description: `the missing element ${comparison} ${expected}`,
            target: { source: 'text', selector: '#no-such-element' },
            comparison,
            expected,
          },
        ],
      });

      // And it is NOT an execError: the page answered, and the answer was that nothing
      // matched. That is a fact about the product.
      expect(attempt.execError).toBeUndefined();
      expect(attempt.assertionEvaluations[0]?.satisfied).toBe(false);
      expect(attempt.assertionEvaluations[0]?.actual).toContain('no element matches');
      expect(deriveCriterionResult(CRITERION, [attempt]).status).toBe('fail');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'the scenario really drives the page — fill and click change what is asserted on',
    async () => {
      // Without this, every assertion above would pass equally well against an executor that
      // navigated and ignored the scenario entirely. This is the test that proves the
      // interaction happened.
      const { attempt } = await execute({
        scenario: ['fill "#search" "widgets"', 'click "#apply"'].join('\n'),
        assertions: [
          {
            description: 'the heading reflects the filter that was applied',
            target: { source: 'text', selector: '#heading' },
            comparison: 'equals',
            expected: 'Filtered: widgets',
          },
        ],
      });

      expect(attempt.execError).toBeUndefined();
      expect(attempt.assertionEvaluations[0]?.actual).toBe('Filtered: widgets');
      expect(deriveCriterionResult(CRITERION, [attempt]).status).toBe('pass');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a scenario goto navigates within the resolved origin',
    async () => {
      const { attempt, sink } = await execute({
        scenario: 'goto "/second"',
        assertions: [
          {
            description: 'the second page loaded',
            target: { source: 'text', selector: '#heading' },
            comparison: 'equals',
            expected: 'Second page',
          },
        ],
      });

      expect(attempt.execError).toBeUndefined();
      expect(deriveCriterionResult(CRITERION, [attempt]).status).toBe('pass');

      // The step was compiled to an ABSOLUTE url built from the origin the CALLER resolved,
      // never from anything the plan wrote.
      const payloadRef = attempt.evidence.find((ref) => ref.path.endsWith('.payload.json'));
      const payload = JSON.parse(await readSinkFile(sink, payloadRef?.path ?? '')) as {
        steps: { verb: string; url: string }[];
      };
      expect(payload.steps[0]?.url).toBe(`${app.baseUrl}/second`);
    },
    TEST_TIMEOUT_MS,
  );
});

describeWithBrowser('AD-6/AD-7: could not look is ERROR, and never FAIL', () => {
  it(
    'a browser that cannot launch is execError => criterion ERROR, with zero assertions',
    async () => {
      // PRODUCED, not mocked: the runner is pointed at a browser registry that contains no
      // browser at all, so chromium genuinely fails to launch.
      const empty = join(process.cwd(), 'node_modules', '.specwitness-no-browsers-here');
      await rm(empty, { recursive: true, force: true });

      const { attempt } = await execute({
        browsersPath: empty,
        assertions: [HEADING_IS_ORDERS],
      });

      expect(attempt.execError).toBeDefined();
      expect(attempt.execError?.hint).toBeTruthy();
      // ⚠️ ZERO assertion evaluations. `outcomeOf` makes the exec error outrank any
      // assertion anyway, so emitting one here would manufacture product evidence out of an
      // infrastructure failure — the defect this module refuses everywhere.
      expect(attempt.assertionEvaluations).toHaveLength(0);

      const derived = deriveCriterionResult(CRITERION, [attempt]);
      // ⚠️ THE HEADLINE ASSERTION OF THE STORY: error, NOT fail. A flaky environment must
      // never start blocking mergeable branches.
      expect(derived.status).toBe('error');
      expect(derived.status).not.toBe('fail');
      // FR-28: a non-pass result carries at least one reference.
      expect(derived.evidence?.length ?? 0).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a timeout BEFORE the first assertion is execError => criterion ERROR',
    async () => {
      // PRODUCED, not mocked: a server that accepts the socket and never answers, with a
      // millisecond navigation timeout. Nothing was adjudicated, so nothing may be reported
      // as adjudicated.
      const silent = await startFixtureApp(() => {
        /* accept the connection and never respond */
      });
      try {
        const { attempt } = await execute({
          baseUrl: silent.baseUrl,
          stepTimeoutMs: 250,
          assertions: [HEADING_IS_ORDERS],
        });

        expect(attempt.execError).toBeDefined();
        expect(attempt.assertionEvaluations).toHaveLength(0);
        expect(deriveCriterionResult(CRITERION, [attempt]).status).toBe('error');
      } finally {
        await silent.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a read that THROWS is execError, not an unsatisfied assertion (codex P1)',
    async () => {
      // ⚠️ THE DOOR NOBODY WAS WATCHING. An earlier generated driver wrapped every read in a
      // try/catch and turned any Playwright exception into an ABSENT VALUE — so a page that
      // crashed, closed or timed out WHILE BEING READ produced an unsatisfied assertion and
      // the criterion reported product FAIL instead of infrastructure `error`. Found by the
      // codex review of this branch, and it is exactly the misclassification the whole story
      // exists to prevent.
      //
      // PRODUCED, not mocked: an unparseable selector makes `locator.count()` throw a real
      // Playwright exception — the same exception class, through the same code path, as a
      // crashed or closed page. A renderer crash reaches this branch by construction, since
      // there is now no catch anywhere inside a read.
      const { attempt } = await execute({
        assertions: [
          {
            description: 'a selector this executor cannot evaluate',
            target: { source: 'text', selector: 'h1:::not-a-selector[' },
            comparison: 'equals',
            expected: 'anything',
          },
        ],
      });

      expect(attempt.execError).toBeDefined();
      // ZERO assertions: nothing was adjudicated, so nothing may be reported as adjudicated.
      expect(attempt.assertionEvaluations).toHaveLength(0);

      const derived = deriveCriterionResult(CRITERION, [attempt]);
      expect(derived.status).toBe('error');
      expect(derived.status).not.toBe('fail');
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    ['a run killed after writing its result', 'timed-out' as ProcessOutcome, null],
    ['a runner that exited non-zero', 'completed' as ProcessOutcome, 1],
  ])(
    'refuses to adjudicate %s, even though the driver reported success (codex P1)',
    async (_label, outcome, exitCode) => {
      // ⚠️ A VERDICT REQUIRES BOTH HALVES: the driver said it observed the page, AND the
      // process that ran it finished cleanly. The driver writes its result inside a
      // `finally`, so `ok: true` can be on disk while the process is subsequently killed,
      // torn down, or exits non-zero for a reason the driver never saw. Reading only the file
      // would adjudicate assertions from a terminated run and could report PASS for a browser
      // that was killed. Found by the codex re-review of this branch.
      const { attempt } = await execute({
        assertions: [HEADING_IS_ORDERS],
        forceProcessOutcome: { outcome, exitCode },
      });

      // The page really WAS read — the assertion would have been satisfied — and it is still
      // refused, because the run did not complete.
      expect(attempt.execError).toBeDefined();
      expect(attempt.assertionEvaluations).toHaveLength(0);
      expect(deriveCriterionResult(CRITERION, [attempt]).status).toBe('error');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a step whose element never appears is execError, not a product FAIL',
    async () => {
      // The distinction this row of the table exists for: the scenario could not be
      // PERFORMED, which is different from an assertion that was not met. Nothing was
      // adjudicated either way.
      const { attempt } = await execute({
        scenario: 'click "#no-such-button"',
        stepTimeoutMs: 500,
        assertions: [HEADING_IS_ORDERS],
      });

      expect(attempt.execError).toBeDefined();
      expect(attempt.execError?.message).toContain('step 1');
      expect(attempt.assertionEvaluations).toHaveLength(0);
      expect(deriveCriterionResult(CRITERION, [attempt]).status).toBe('error');
    },
    TEST_TIMEOUT_MS,
  );
});

describeWithBrowser('evidence: two channels, both artifacts, and one honest limitation', () => {
  it(
    'stores a real trace and a real screenshot, refs them, and records the typed member',
    async () => {
      const { attempt, sink } = await execute({ assertions: [HEADING_IS_ORDERS] });

      // CHANNEL 1: refs on the attempt, every one run-RELATIVE (Q48).
      const paths = attempt.evidence.map((ref) => ref.path);
      expect(attempt.evidence.every((ref) => ref.kind === 'browser')).toBe(true);
      expect(paths.every((path) => !path.startsWith('/'))).toBe(true);
      expect(paths.some((path) => path.endsWith('.trace.zip'))).toBe(true);
      expect(paths.some((path) => path.endsWith('.screenshot.png'))).toBe(true);
      expect(paths.some((path) => path.endsWith('.payload.json'))).toBe(true);

      // CHANNEL 2: the typed MEMBER. An executor that refs its files and forgets this ships
      // reports carrying gate evidence and NO probe evidence, silently, with every surface
      // suite green — no surface test drives a renderer.
      expect(sink.members).toHaveLength(1);
      const member = sink.members[0] as BrowserEvidence;
      expect(member.kind).toBe('browser');
      expect(member.trace?.path).toMatch(/\.trace\.zip$/);
      expect(member.screenshot?.path).toMatch(/\.screenshot\.png$/);
      expect(member.url).toContain('/orders');

      // The artifacts are REAL FILES with their real magic bytes — the whole reason
      // `writeEvidenceBytes` exists. Routed through the UTF-8 text writer, both would be
      // the right size and the wrong bytes, and no viewer could open either.
      const files = await sink.files();
      const trace = files.find((path) => path.endsWith('.trace.zip'));
      const screenshot = files.find((path) => path.endsWith('.screenshot.png'));
      expect(trace).toBeDefined();
      expect(screenshot).toBeDefined();

      const { readFile } = await import('node:fs/promises');
      expect((await readFile(trace as string)).subarray(0, 2).toString('latin1')).toBe('PK');
      expect([...(await readFile(screenshot as string)).subarray(1, 4)].map((b) => String.fromCharCode(b)).join('')).toBe('PNG');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'records a member even when the browser never launched — the union permits it honestly',
    async () => {
      // The per-attempt rule, and where this surface sits relative to the other three.
      // `BrowserEvidence.url` is known before anything is spawned and both artifact fields
      // are optional, so an attempt that produced nothing is representable without inventing
      // anything — unlike `HttpResponseRecord.status`, a bare `number`, which is why http
      // records nothing on that route.
      const empty = join(process.cwd(), 'node_modules', '.specwitness-no-browsers-here-2');
      await rm(empty, { recursive: true, force: true });

      const { attempt, sink } = await execute({
        browsersPath: empty,
        assertions: [HEADING_IS_ORDERS],
      });

      expect(attempt.execError).toBeDefined();
      expect(sink.members).toHaveLength(1);
      const member = sink.members[0] as BrowserEvidence;
      expect(member.url).toContain('/orders');
      expect(member.trace).toBeUndefined();
      expect(member.screenshot).toBeUndefined();
      // And the limitation is stated where a reader of the evidence meets it.
      expect(member.explanation).toContain('cannot be scrubbed by a text redactor');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'stamps the attempt into every filename, so attempt 2 cannot overwrite attempt 1',
    async () => {
      // `deriveCriterionResult` reads the FINAL attempt, so an overwritten trace would make
      // a flaky pass point at evidence that no longer shows the failure it was flaky about —
      // the single most confusing artifact this epic could produce.
      const first = await execute({ assertions: [HEADING_IS_ORDERS], attempt: 1 });
      const second = await execute({ assertions: [HEADING_IS_ORDERS], attempt: 2 });

      expect(first.attempt.attempt).toBe(1);
      expect(second.attempt.attempt).toBe(2);
      expect(first.attempt.evidence[0]?.path).toMatch(/-01\.json$/);
      expect(second.attempt.evidence[0]?.path).toMatch(/-02\.json$/);
    },
    TEST_TIMEOUT_MS,
  );
});
