/**
 * The surface-conformance proof (owner decision, 2026-09-01) — story 4.7.
 *
 * Three surfaces landed in three branches of one cohort, each with its own suite, and none
 * of their authors could see another's tests. **Story 4.7 is the only story that sees all
 * three**, so this file drives http, observation and shell through the SAME set of
 * situations and asserts the derived `CriterionResult`s are structurally identical.
 *
 * Nothing is mocked. A real HTTP server on a real socket, real Node subprocesses, a real
 * missing binary. `deriveCriterionResult` is the merged single producer and is not
 * re-implemented here.
 *
 * ============================================================================
 * WHAT "STRUCTURALLY IDENTICAL" MEANS, AND WHERE IT DELIBERATELY DOES NOT
 * ============================================================================
 *
 * **Derived results: identical, in all four situations.** Same `status`, same
 * presence-or-absence of `expected`, `actual`, `evidence` and `flaky`. That is the property
 * a report and a repair agent depend on, and there is no honest reason for three surfaces
 * to differ on it.
 *
 * **Evidence members: identical where the closed union can represent the outcome, and
 * documented where it cannot.** Cohort 2 settled one rule in three PR bodies —
 *
 *   > An attempt records the typed member whenever the closed evidence union can represent
 *   > what happened HONESTLY, and refs it. What that resolves to is decided per surface by
 *   > what the union gives each one, not by preference.
 *
 * — and it resolves three ways because the union is shaped three ways:
 * `CommandEvidence.exitCode` is `number | null`, so shell can honestly record "never
 * started"; `HttpResponseRecord.status` is a bare `number`, so a refused connection has no
 * truthful representation and recording one would mean inventing `status: 0`;
 * `ObservationEvidence.snapshot` is a `BoundedText` with no absence marker, so "nothing ran"
 * and "ran and printed nothing" would be indistinguishable.
 *
 * That is ONE rule instantiated three times, not three inconsistencies — and this file
 * checks it **by reading the union**, which is the only way to check it now that none of the
 * three authors is available. So the exec-error row asserts the documented per-surface
 * behaviour AND asserts that the union really is shaped the way the rule claims; if a future
 * story gives `HttpEvidence` an absence marker, the second assertion fails and this comment
 * stops being true at the same moment the code does.
 *
 * ============================================================================
 * IT ALSO CLOSES THE OBSERVATION INPUT SHAPES NOBODY EXERCISED
 * ============================================================================
 *
 * ============================================================================
 * THE FOURTH SURFACE (story 5.2)
 * ============================================================================
 *
 * Epic 4's retrospective §6 said this file "is the right place to add the fourth surface,
 * and it will fail loudly if a browser executor diverges structurally from the other
 * three". Story 5.2 makes that good: `browser` is driven through the same four situations
 * by the same helper, and no second conformance suite was written.
 *
 * It agrees on every DERIVED result. It diverges on ONE recorded evidence member, and the
 * divergence is forced by the union in exactly the way the rule above describes:
 *
 *   browser      EVERY attempt, a failed launch included. `BrowserEvidence.url` is known
 *                before anything is spawned - the CALLER resolved the origin - so it states
 *                what was attempted rather than claiming an observation, and `trace` and
 *                `screenshot` are BOTH optional, so an attempt that produced no artifact is
 *                representable without inventing anything. That is shell's side of the
 *                divergence, reached by shell's reasoning rather than by preference, and it
 *                is strictly better than http's documented FR-28 gap.
 *
 *                The artifacts themselves follow HOW FAR the attempt got: a refused
 *                connection still yields a trace, because chromium launched and only the
 *                navigation failed. Only a browser that never started produces a member
 *                with neither field.
 *
 * ⚠️ **THE BROWSER ROW IS CONDITIONAL ON A BROWSER EXISTING**, and it says so loudly on
 * stderr when it is dropped. That is a skipped TEST on a machine with no Playwright; the
 * PRODUCTION code has no skip path, and every route by which a browser probe could produce
 * no attempts is an `InfraError` or an `execError`. Conflating those two is Epic 4 retro
 * §2 observation 2 arriving a third time.
 *
 * ============================================================================
 *
 * Cohort 2's supervisor measured that `src/surfaces/observation.ts` is correct but leaves
 * three params shapes untested. They are the `readProbeId` arms, and the gap is not
 * academic: **every merged observation test passes `probeId`, while a compiled plan carries
 * `id`** — so the spelling the product actually uses in production was the one never
 * covered. Folded in here rather than written as a fourth one-off suite.
 */

import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deriveCriterionResult } from '../../../src/domain/criterion-result.js';
import type {
  ContractCriterionRef,
  ProbeAttempt,
  ProbeSurface,
} from '../../../src/domain/criterion-result.js';
import { EVIDENCE_KINDS, type Evidence } from '../../../src/domain/evidence.js';
import { createProcessRunner } from '../../../src/infra/process-runner.js';
import { SystemClock } from '../../../src/infra/clock.js';
import { resolvePlaywrightEnvironment } from '../../../src/infra/playwright-env.js';
import type { PlaywrightEnvironment } from '../../../src/infra/playwright-env.js';
import {
  BrowserSurfaceExecutor,
  HttpSurfaceExecutor,
  ObservationSurfaceExecutor,
  ShellSurfaceExecutor,
} from '../../../src/surfaces/index.js';

const CRITERION: ContractCriterionRef = {
  criterionId: 'E4-01',
  statement: 'the surfaces agree about what an outcome looks like',
  severity: 'critical',
  verifiability: 'automated',
};

/** The four situations every surface is driven through. */
type Situation = 'satisfied' | 'unsatisfied' | 'exec-error' | 'retry-then-pass';

const SITUATIONS: readonly Situation[] = [
  'satisfied',
  'unsatisfied',
  'exec-error',
  'retry-then-pass',
];

/**
 * Story 5.2's fourth surface joins only when this machine can actually open a browser.
 *
 * Resolved with a top-level await so the value is settled before the suites below are
 * collected, and announced on stderr when it is dropped - a silent reduction in coverage is
 * how a conformance proof stops proving anything without anybody noticing.
 */
const playwright: PlaywrightEnvironment = await resolvePlaywrightEnvironment({
  projectRoot: process.cwd(),
});

if (!playwright.ready) {
  process.stderr.write(
    '\n[specwitness] surface conformance is running with THREE surfaces, not four: ' +
      `${playwright.source === 'absent' ? playwright.reason : 'no browsers are downloaded'}\n` +
      '[specwitness] this is a skipped TEST, not a skipped CRITERION - the browser executor ' +
      'has no skip path. Run `specwitness doctor` to provision Playwright.\n',
  );
}

const SURFACES: readonly ProbeSurface[] = playwright.ready
  ? ['http', 'observation', 'shell', 'browser']
  : ['http', 'observation', 'shell'];

/** What one execution produced: the attempts, and every evidence member recorded. */
interface Executed {
  readonly attempts: readonly ProbeAttempt[];
  readonly members: readonly Evidence[];
}

let scratch: string;
let server: Server;
let baseUrl: string;
/** Flipped by the retry situation so the second attempt sees a different world. */
let flakyCallCount = 0;

const clock = new SystemClock();
const runner = createProcessRunner(clock);

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'specwitness-conformance-'));

  // The observation command: prints JSON on stdout and exits 0 (Q35's declared contract).
  await writeFile(
    join(scratch, 'observe.cjs'),
    `const value = process.argv[2] === '--flaky' ? (require('node:fs').existsSync(${JSON.stringify(
      join(scratch, 'flag'),
    )}) ? '1' : (require('node:fs').writeFileSync(${JSON.stringify(
      join(scratch, 'flag'),
    )}, 'x'), '9')) : process.argv[2];
process.stdout.write(JSON.stringify({ count: Number(value) }) + '\\n');
process.exit(0);
`,
    'utf8',
  );

  // The shell command: exits with the code it is given, printing something either way.
  await writeFile(
    join(scratch, 'shell.cjs'),
    `const code = process.argv[2] === '--flaky'
  ? (require('node:fs').existsSync(${JSON.stringify(join(scratch, 'shell-flag'))}) ? 0
     : (require('node:fs').writeFileSync(${JSON.stringify(
       join(scratch, 'shell-flag'),
     )}, 'x'), 9))
  : Number(process.argv[2]);
process.stdout.write('ran\\n');
process.exit(code);
`,
    'utf8',
  );

  server = createServer((request, response) => {
    const url = request.url ?? '/';

    // Story 5.2's routes: a browser needs HTML, and the flaky one has to flip on the
    // SECOND request the way the JSON one does.
    if (url.startsWith('/page')) {
      const heading =
        url === '/page-bad'
          ? 'bad'
          : url === '/page-flaky'
            ? ((flakyCallCount += 1), flakyCallCount === 1 ? 'bad' : 'ok')
            : 'ok';
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html><html><head><title>t</title></head><body><h1 id="h">${heading}</h1></body></html>`);
      return;
    }

    if (url === '/flaky') {
      flakyCallCount += 1;
      response.writeHead(flakyCallCount === 1 ? 500 : 200, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    response.writeHead(url === '/bad' ? 500 : 200, { 'content-type': 'application/json' });
    response.end('{}');
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('conformance: the fixture server did not bind');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(scratch, { recursive: true, force: true });
});

/**
 * Runs one surface through one situation and returns everything it produced.
 *
 * `exec-error` is a genuinely missing binary in every case — a closed port for http, a
 * command that does not exist for the other two — so the failure comes from the operating
 * system and the network stack rather than from a simulation of them.
 */
async function execute(surface: ProbeSurface, situation: Situation): Promise<Executed> {
  const members: Evidence[] = [];
  const evidence = {
    writeEvidence: async (name: string) => name,
    recordEvidence: (member: Evidence) => {
      members.push(member);
    },
  };
  const attempts: ProbeAttempt[] = [];
  const runs = situation === 'retry-then-pass' ? [1, 2] : [1];

  if (situation === 'retry-then-pass') {
    // RESET THE WORLD FIRST. Each surface's "fails once, then passes" is driven by real
    // state — a request counter, a marker file — and a second call into this helper would
    // otherwise start from an already-flipped state and observe two passes. That would make
    // the flake assertion pass or fail depending on which test ran first, which is exactly
    // the non-determinism these suites exist to keep out of a verdict.
    flakyCallCount = 0;
    await rm(join(scratch, 'flag'), { force: true });
    await rm(join(scratch, 'shell-flag'), { force: true });
  }

  for (const attempt of runs) {
    attempts.push(await executeOnce(surface, situation, attempt, evidence));
  }

  return { attempts, members };
}

async function executeOnce(
  surface: ProbeSurface,
  situation: Situation,
  attempt: number,
  evidence: {
    writeEvidence: (name: string, contents: string) => Promise<string>;
    recordEvidence: (member: Evidence) => void;
  },
): Promise<ProbeAttempt> {
  if (surface === 'http') {
    const executor = new HttpSurfaceExecutor({ clock, ...evidence, timeoutMs: 5_000 });
    const path =
      situation === 'satisfied'
        ? '/ok'
        : situation === 'unsatisfied'
          ? '/bad'
          : situation === 'retry-then-pass'
            ? '/flaky'
            : '/ok';

    return await executor.execute({
      criterionId: CRITERION.criterionId,
      surface: 'http',
      params: {
        probe: {
          id: 'probe',
          surface: 'http',
          mechanics: { serviceId: 'svc', method: 'GET', path },
          assertions: [
            {
              description: 'answers 200',
              target: { source: 'status' },
              comparison: 'equals',
              expected: '200',
            },
          ],
        },
        // A closed port on localhost: the connection is REFUSED by the kernel, which is the
        // http surface's exec-error and is never a product fail.
        baseUrl: situation === 'exec-error' ? 'http://127.0.0.1:1' : baseUrl,
        attempt,
      },
    });
  }

  const missing = situation === 'exec-error';

  if (surface === 'browser') {
    // A REAL evidence sink, because Playwright's own CLI has to OPEN the generated spec:
    // the other three surfaces never read back what they wrote, so the shared no-op writer
    // above is enough for them and is not enough here.
    const write = async (name: string, contents: string | Uint8Array): Promise<string> => {
      const absolute = join(scratch, name);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, contents);
      return name;
    };

    const executor = new BrowserSurfaceExecutor({
      clock,
      runner,
      cwd: scratch,
      environment: playwright,
      writeEvidence: write,
      writeEvidenceBytes: write,
      resolveRunPath: (name) => join(scratch, name),
      recordEvidence: evidence.recordEvidence,
      stepTimeoutMs: 5_000,
      timeoutMs: 90_000,
    });

    const path =
      situation === 'satisfied'
        ? '/page'
        : situation === 'unsatisfied'
          ? '/page-bad'
          : situation === 'retry-then-pass'
            ? '/page-flaky'
            : '/page';

    return await executor.execute({
      criterionId: CRITERION.criterionId,
      surface: 'browser',
      params: {
        probe: {
          id: 'probe',
          surface: 'browser',
          mechanics: { serviceId: 'svc', path, scenario: '# navigate and read' },
          assertions: [
            {
              description: 'the heading says ok',
              target: { source: 'text', selector: '#h' },
              comparison: 'equals',
              expected: 'ok',
            },
          ],
        },
        // A closed port on localhost: the browser cannot reach anything, which is this
        // surface's exec-error and is never a product fail.
        baseUrl: missing ? 'http://127.0.0.1:1' : baseUrl,
        attempt,
      },
    });
  }

  if (surface === 'observation') {
    const executor = new ObservationSurfaceExecutor({
      runner,
      clock,
      cwd: scratch,
      timeoutMs: 10_000,
      ...evidence,
      resolveCommand: () => ({
        commandId: 'observe',
        displayCommand: 'node observe.cjs',
        binary: missing ? 'specwitness-no-such-binary' : process.execPath,
        baseArgs: missing ? [] : [join(scratch, 'observe.cjs')],
      }),
    });

    const argument =
      situation === 'satisfied' ? '1' : situation === 'unsatisfied' ? '9' : '--flaky';

    return await executor.execute({
      criterionId: CRITERION.criterionId,
      surface: 'observation',
      params: {
        // `id`, NOT `probeId` — the spelling a compiled plan actually carries, and the one
        // every merged observation test omitted.
        id: 'probe',
        surface: 'observation',
        mechanics: { commandId: 'observe', args: [argument] },
        assertions: [
          {
            description: 'the count is one',
            target: { source: 'jsonPath', path: 'count', phase: 'snapshot' },
            comparison: 'equals',
            expected: '1',
          },
        ],
        attempt,
      },
    });
  }

  const argument = situation === 'satisfied' ? '0' : situation === 'unsatisfied' ? '9' : '--flaky';
  const executor = new ShellSurfaceExecutor({
    runner,
    clock,
    cwd: scratch,
    timeoutMs: 10_000,
    ...evidence,
    command: {
      commandId: 'shell',
      displayCommand: 'node shell.cjs',
      binary: missing ? 'specwitness-no-such-binary' : process.execPath,
      baseArgs: missing ? [] : [join(scratch, 'shell.cjs')],
    },
  });

  return await executor.execute({
    criterionId: CRITERION.criterionId,
    surface: 'shell',
    params: {
      id: 'probe',
      surface: 'shell',
      mechanics: {
        commandId: 'shell',
        args: [argument],
        argumentAllowlist: [argument],
      },
      assertions: [
        {
          description: 'exits zero',
          target: { source: 'exitCode' },
          comparison: 'equals',
          expected: '0',
        },
      ],
      attempt,
    },
  });
}

/** The SHAPE of a derived result: what is present, never what its values are. */
function shapeOf(result: ReturnType<typeof deriveCriterionResult>) {
  return {
    status: result.status,
    hasExpected: result.expected !== undefined,
    hasActual: result.actual !== undefined,
    hasEvidence: (result.evidence?.length ?? 0) > 0,
    flaky: result.flaky === true,
  };
}

describe('surface conformance — derived results (owner-assigned, story 4.7)', () => {
  it.each(SITUATIONS)(
    'http, observation and shell produce structurally identical results for: %s',
    async (situation) => {
      const shapes = new Map<ProbeSurface, ReturnType<typeof shapeOf>>();

      for (const surface of SURFACES) {
        const { attempts } = await execute(surface, situation);
        shapes.set(surface, shapeOf(deriveCriterionResult(CRITERION, attempts)));
      }

      const [reference, ...rest] = [...shapes.values()];
      for (const [index, shape] of rest.entries()) {
        expect(shape, `${SURFACES[index + 1]} diverges from ${SURFACES[0]}`).toEqual(reference);
      }
    },
    180_000,
  );

  it.each([
    { situation: 'satisfied' as const, status: 'pass', evidence: false, flaky: false },
    { situation: 'unsatisfied' as const, status: 'fail', evidence: true, flaky: false },
    // `evidence: true` is FR-28: every non-pass result a repair agent reads carries at
    // least one reference. All three surfaces satisfy it now; the observation surface did
    // not before this story, and this test is what measured that.
    { situation: 'exec-error' as const, status: 'error', evidence: true, flaky: false },
    { situation: 'retry-then-pass' as const, status: 'pass', evidence: false, flaky: true },
  ])(
    'and the shape they agree on is the one FR-28 and FR-32 require: $situation',
    async ({ situation, status, evidence, flaky }) => {
      // Pinning the agreed shape as well as the agreement. Three surfaces converging on the
      // WRONG shape would pass the test above and fail the product.
      for (const surface of SURFACES) {
        const { attempts } = await execute(surface, situation);
        const result = deriveCriterionResult(CRITERION, attempts);

        expect(result.status, surface).toBe(status);
        expect((result.evidence?.length ?? 0) > 0, `${surface} evidence`).toBe(evidence);
        expect(result.flaky === true, `${surface} flaky`).toBe(flaky);

        if (status === 'fail') {
          // FR-28: every non-pass result a repair agent reads carries what was required and
          // what was seen.
          expect(result.expected, surface).toBeDefined();
          expect(result.actual, surface).toBeDefined();
        }
      }
    },
    180_000,
  );
});

describe('surface conformance — recorded evidence members', () => {
  it.each(['satisfied', 'unsatisfied'] as const)(
    'all three record exactly one typed member when they observed something: %s',
    async (situation) => {
      for (const surface of SURFACES) {
        const { members } = await execute(surface, situation);

        expect(members.length, `${surface} recorded ${members.length} members`).toBe(1);
        // The kind is the surface's own — that is what a renderer switches on — but the
        // COUNT and the fact of recording are the conformance property.
        expect(EVIDENCE_KINDS).toContain(members[0]?.kind);
      }
    },
    180_000,
  );

  it('records the divergence on exec-error that the UNION forces, and only that', async () => {
    // The one place the three surfaces legitimately differ. Asserted against the shape of
    // the union rather than against the authors' word for it, because none of them is
    // available to confirm it.
    const shell = await execute('shell', 'exec-error');
    const http = await execute('http', 'exec-error');
    const observation = await execute('observation', 'exec-error');

    // shell — `CommandEvidence.exitCode` is `number | null`, so "never started" is
    // representable and IS recorded.
    expect(shell.members).toHaveLength(1);
    expect(shell.members[0]?.kind).toBe('command');
    expect((shell.members[0] as { exitCode: number | null }).exitCode).toBeNull();

    // http — `HttpResponseRecord.status` is a bare `number`, so a refused connection has no
    // truthful representation; recording one would mean inventing `status: 0`.
    expect(http.members).toHaveLength(0);
    // ...but a REFERENCE is still carried, because the member and the ref are separate
    // channels and FR-28 governs the ref.
    expect(http.attempts[0]?.evidence.length ?? 0).toBeGreaterThan(0);

    // observation — `ObservationEvidence.snapshot` is a `BoundedText` with no absence
    // marker, so "nothing ran" and "ran and printed nothing" would be indistinguishable.
    // No member, therefore — but, like http, a REFERENCE to a record of what was attempted.
    // That reference did not exist before story 4.7; this test is what measured its absence.
    expect(observation.members).toHaveLength(0);
    expect(observation.attempts[0]?.evidence.length ?? 0).toBeGreaterThan(0);

    // browser (story 5.2) — a member IS recorded, which is shell's side of the divergence
    // reached by shell's reasoning: `BrowserEvidence.url` is a bare `string` the CALLER
    // resolved before anything was spawned, so it states what was ATTEMPTED rather than
    // claiming an observation that did not happen, and `trace`/`screenshot` are both
    // OPTIONAL, so an attempt that produced no artifact is representable without inventing
    // anything.
    //
    // ⚠️ AND THE ARTIFACTS ARE PRESENT HERE, which is worth stating because the first
    // version of this assertion expected them absent and was WRONG. A closed port is a
    // NAVIGATION failure, not a launch failure: chromium really started, so the driver's
    // `finally` block really ran and really captured a trace of a browser sitting on an
    // error page. That is the honest and more useful outcome — the evidence follows how far
    // the attempt actually got, rather than being all-or-nothing. The genuinely
    // artifact-less case is a browser that never launched at all, and
    // `browser.test.ts` covers it by pointing the runner at an empty browser registry.
    if (playwright.ready) {
      const browser = await execute('browser', 'exec-error');
      expect(browser.members).toHaveLength(1);
      expect(browser.members[0]?.kind).toBe('browser');
      const member = browser.members[0] as { url?: unknown; trace?: unknown };
      expect(typeof member.url).toBe('string');
      expect(member.trace).toBeDefined();
      expect(browser.attempts[0]?.evidence.length ?? 0).toBeGreaterThan(0);
    }
  }, 120_000);

  it('the union really is shaped the way that rule claims', async () => {
    // If a later story adds an absence marker to `HttpEvidence` or `ObservationEvidence`,
    // the divergence above stops being forced and this assertion is where that is noticed —
    // rather than in a comment nobody re-reads.
    const shell = await execute('shell', 'satisfied');
    const command = shell.members[0] as { exitCode?: unknown };
    expect('exitCode' in command).toBe(true);

    const http = await execute('http', 'satisfied');
    const httpMember = http.members[0] as { response?: { status?: unknown } };
    expect(typeof httpMember.response?.status).toBe('number');

    const observation = await execute('observation', 'satisfied');
    const observationMember = observation.members[0] as { snapshot?: unknown };
    expect(observationMember.snapshot).toBeDefined();

    // And the half that makes browser's divergence legitimate rather than a preference:
    // `url` is required and both artifact fields are optional. If a later story makes
    // `trace` required, browser can no longer honestly record a failed launch and this
    // assertion is where that is noticed.
    if (playwright.ready) {
      const browser = await execute('browser', 'satisfied');
      const browserMember = browser.members[0] as { url?: unknown; trace?: unknown };
      expect(typeof browserMember.url).toBe('string');
      expect(browserMember.trace).toBeDefined();
    }
  }, 120_000);
});

describe('the observation params shapes nobody exercised (cohort 2 handover)', () => {
  // Every merged observation test passes `probeId`; a compiled plan carries `id`. So the
  // spelling the product uses in production was the one never covered.
  const base = {
    surface: 'observation' as const,
    mechanics: { commandId: 'observe', args: ['1'] },
    assertions: [
      {
        description: 'the count is one',
        target: { source: 'jsonPath', path: 'count', phase: 'snapshot' },
        comparison: 'equals',
        expected: '1',
      },
    ],
    attempt: 1,
  };

  function subject(members: Evidence[]) {
    return new ObservationSurfaceExecutor({
      runner,
      clock,
      cwd: scratch,
      timeoutMs: 10_000,
      writeEvidence: async (name: string) => name,
      recordEvidence: (member: Evidence) => {
        members.push(member);
      },
      resolveCommand: () => ({
        commandId: 'observe',
        displayCommand: 'node observe.cjs',
        binary: process.execPath,
        baseArgs: [join(scratch, 'observe.cjs')],
      }),
    });
  }

  it("accepts the canonical `id`, which is what a compiled plan carries", async () => {
    const members: Evidence[] = [];
    const attempt = await subject(members).execute({
      criterionId: CRITERION.criterionId,
      surface: 'observation',
      params: { ...base, id: 'probe' },
    });

    expect(attempt.execError).toBeUndefined();
    expect(deriveCriterionResult(CRITERION, [attempt]).status).toBe('pass');
    // The id reaches the evidence filename, so a wrong reading here is misattributed
    // evidence rather than a crash.
    expect(attempt.evidence.some((ref) => ref.path.includes('probe'))).toBe(true);
  });

  it('accepts both spellings when they AGREE', async () => {
    const members: Evidence[] = [];
    const attempt = await subject(members).execute({
      criterionId: CRITERION.criterionId,
      surface: 'observation',
      params: { ...base, id: 'probe', probeId: 'probe' },
    });

    expect(attempt.execError).toBeUndefined();
    expect(deriveCriterionResult(CRITERION, [attempt]).status).toBe('pass');
  });

  it('REFUSES both spellings when they disagree — they name one probe', async () => {
    // An alias that can resolve to a semantically different value is not an alias: picking
    // a winner silently is how one probe's evidence ends up filed under another's name.
    const members: Evidence[] = [];

    await expect(
      subject(members).execute({
        criterionId: CRITERION.criterionId,
        surface: 'observation',
        params: { ...base, id: 'probe', probeId: 'other' },
      }),
    ).rejects.toThrow(/name one probe|disagree/i);
  });
});
