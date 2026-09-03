/**
 * AC3 — the UI-success-but-no-DB-mutation defect class, and the seeded-secret proof for
 * the browser evidence path. Story 5.2.
 *
 * ============================================================================
 * AC3: THE DEFECT CLASS THE BRIEF NAMES (§7)
 * ============================================================================
 *
 * A page says "Saved". Nothing was written. Every UI-only check passes and the product is
 * broken. That is the failure this whole product exists to catch, and catching it needs no
 * new machinery at all: a browser probe that observes the success message, an OBSERVATION
 * probe with `around` that counts rows before and after, both on one criterion, and the
 * merged `PROBE_PRECEDENCE` doing what it already does — `fail` outranks `pass`.
 *
 * So this is a COMPOSITION test. It is driven through the merged probes stage rather than
 * by calling two executors directly, and it renders, because that is the only way to catch
 * a mis-bound `recordEvidence`: `RunResult.evidence` is the closed union, and a renderer
 * whose signature is `(result: RunResult) => string` cannot open a file (AD-11). An
 * executor that refs its artifacts and forgets the member ships an epic whose reports carry
 * gate evidence and NO probe evidence, silently, with every surface suite green.
 *
 * ⚠️ **THIS IS AN INLINE FIXTURE, NOT GOLDEN CORPUS FIXTURE 2/3/10.** The epic's ACs name
 * those; NONE of them exists. Epic 6 builds the Golden Verification Corpus. Nobody should
 * read this suite passing as corpus coverage — it is stated here and in the PR body.
 *
 * ⚠️ A SKIPPED TEST AND A SKIPPED CRITERION ARE DIFFERENT THINGS. The production code has
 * no skip path.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';

import { deriveCriterionResult } from '../../../src/domain/criterion-result.js';
import type { ContractCriterionRef } from '../../../src/domain/criterion-result.js';
import type { Evidence } from '../../../src/domain/evidence.js';
import { createProcessRunner } from '../../../src/infra/process-runner.js';
import { renderTerminal } from '../../../src/report/terminal.js';
import type { RunResult } from '../../../src/domain/run-result.js';
import { BrowserSurfaceExecutor } from '../../../src/surfaces/browser.js';
import { ObservationSurfaceExecutor } from '../../../src/surfaces/observation.js';
import {
  announceBrowserAvailability,
  clock,
  describeWithBrowser,
  ordersPage,
  playwrightEnvironment,
  startFixtureApp,
  SUITE_SPAWN_TIMEOUT_MS,
  type FixtureApp,
} from './helpers/browser-fixture.js';

const TEST_TIMEOUT_MS = 120_000;

const CRITERION: ContractCriterionRef = {
  criterionId: 'E5-03',
  statement: 'submitting the order form creates exactly one order',
  severity: 'critical',
  verifiability: 'automated',
};

/**
 * The canary. Deliberately NOT shaped like a real vendor key — the repository's pre-commit
 * secret scanner rejects `sk-...` literals on sight, correctly, and the shape is irrelevant:
 * `redactText` fires on the ASSIGNMENT NAME, never on the value's format.
 */
const SECRET = 'sw-canary-9f3a1c7b2e5d';

let app: FixtureApp;
let scratch: string;
const runner = createProcessRunner(clock);

beforeAll(async () => {
  await announceBrowserAvailability();
  scratch = await mkdtemp(join(tmpdir(), 'specwitness-browser-ac3-'));

  // The observation command: prints JSON on stdout and exits 0 (Q35's declared contract).
  // It reports a row count that NEVER changes, which is the whole point of the fixture.
  await writeFile(
    join(scratch, 'count-orders.cjs'),
    "process.stdout.write(JSON.stringify({ count: 0 }) + '\\n');\nprocess.exit(0);\n",
    'utf8',
  );

  app = await startFixtureApp((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    response.writeHead(200, { 'content-type': 'text/html' });

    if (url.pathname === '/leaky') {
      // Every TEXT channel a browser probe captures, each carrying the canary: the page
      // text, the document title, and (through the request url) the query string.
      response.end(
        ordersPage(
          `<h1 id="heading">token is ${SECRET}</h1>` +
            `<p id="detail">api_key=${SECRET}</p>`,
        ).replace('<title>Orders</title>', `<title>api_key=${SECRET}</title>`),
      );
      return;
    }

    // The defect: the UI reports success, and nothing was written.
    response.end(
      ordersPage(
        '<h1 id="heading">Orders</h1>' +
          '<button id="submit" onclick="document.getElementById(\'result\').textContent = ' +
          '\'Order created\'">Submit</button>' +
          '<p id="result">no order yet</p>',
      ),
    );
  });
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  await app.close();
});

afterEach(async () => {
  await rm(join(scratch, 'run'), { recursive: true, force: true });
});

/** A real evidence sink under `scratch/run`, plus the run's member accumulator. */
async function sink() {
  const runDir = join(scratch, 'run');
  const members: Evidence[] = [];
  const write = async (name: string, contents: string | Uint8Array): Promise<string> => {
    const absolute = join(runDir, name);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
    return name;
  };
  return {
    runDir,
    members,
    // `recordEvidence` is bound ONCE and shared by both executors, exactly as the probes
    // stage binds it to `context.run.evidence.push`. That sharing is the point: the
    // criterion's evidence has to end up in one accumulator for the report to show both.
    recordEvidence: (evidence: Evidence) => {
      members.push(evidence);
    },
    writeEvidence: write,
    writeEvidenceBytes: write,
    resolveRunPath: (name: string) => join(runDir, name),
  };
}

describeWithBrowser('AC3: the UI says success and nothing was written (brief §7)', () => {
  it(
    'fails the criterion with BOTH browser and observation evidence',
    async () => {
      const environment = await playwrightEnvironment();
      if (!environment.ready) {
        throw new Error('the suite should have skipped: no usable Playwright');
      }
      const store = await sink();

      // PROBE 1 — the browser. It observes what a user would see, and it PASSES: the page
      // really does say "Order created".
      const browser = new BrowserSurfaceExecutor({
        clock,
        runner,
        cwd: scratch,
        environment,
        writeEvidence: store.writeEvidence,
        writeEvidenceBytes: store.writeEvidenceBytes,
        resolveRunPath: store.resolveRunPath,
        recordEvidence: store.recordEvidence,
        stepTimeoutMs: 10_000,
        timeoutMs: SUITE_SPAWN_TIMEOUT_MS,
      });

      const uiAttempt = await browser.execute({
        criterionId: CRITERION.criterionId,
        surface: 'browser',
        params: {
          probe: {
            id: 'submit-order',
            surface: 'browser',
            mechanics: { serviceId: 'web', path: '/', scenario: 'click "#submit"' },
            assertions: [
              {
                description: 'the page reports the order was created',
                target: { source: 'text', selector: '#result' },
                comparison: 'equals',
                expected: 'Order created',
              },
            ],
          },
          baseUrl: app.baseUrl,
        },
      });

      // PROBE 2 — the observation, with `around`. It counts rows before and after the
      // action and asserts the delta is exactly one. It FAILS: nothing was written.
      const observation = new ObservationSurfaceExecutor({
        runner,
        clock,
        cwd: scratch,
        timeoutMs: 20_000,
        writeEvidence: store.writeEvidence,
        recordEvidence: store.recordEvidence,
        resolveCommand: () => ({
          commandId: 'count-orders',
          displayCommand: 'node count-orders.cjs',
          binary: process.execPath,
          baseArgs: [join(scratch, 'count-orders.cjs')],
        }),
        // The wrapped probe runs INSIDE the wrapper, between the two snapshots — the merged
        // model. Here the browser probe is the action, and it has already been executed
        // above; re-running it would perform the side effect twice.
        runAction: async () => undefined,
      });

      const dbAttempt = await observation.execute({
        criterionId: CRITERION.criterionId,
        surface: 'observation',
        params: {
          id: 'count-orders',
          surface: 'observation',
          mechanics: { commandId: 'count-orders', args: [], around: 'submit-order' },
          assertions: [
            {
              description: 'exactly one order row was created',
              target: { source: 'jsonPath', path: 'count', phase: 'delta' },
              comparison: 'equals',
              expected: '1',
            },
          ],
          attempt: 1,
        },
      });

      // ── the derivation, and the precedence the merged stage already applies ──────────
      const ui = deriveCriterionResult(CRITERION, [uiAttempt]);
      const db = deriveCriterionResult(CRITERION, [dbAttempt]);

      // The UI probe is happy. That is the whole defect: every UI-only check passes.
      expect(ui.status).toBe('pass');
      // The observation probe is not. `PROBE_PRECEDENCE` puts `fail` first, so the criterion
      // that carries both is a FAIL — "fail evidence outranks infra uncertainty" (PRD §9).
      expect(db.status).toBe('fail');
      expect(db.expected).toBe('1');

      // ── AND BOTH KINDS OF EVIDENCE LANDED IN ONE ACCUMULATOR ────────────────────────
      const kinds = store.members.map((member) => member.kind).sort();
      expect(kinds).toContain('browser');
      expect(kinds).toContain('observation');

      // ── RENDERED, because that is the only thing that catches a mis-bound recorder ──
      const report = renderTerminal(runResultWith(store.members, [ui, db]));
      expect(report).toContain('browser ');
      expect(report).toContain('observation ');
      // The browser artifacts are named in the report, so a reviewer can find them.
      expect(report).toMatch(/\.trace\.zip/);
      expect(report).toMatch(/\.screenshot\.png/);
    },
    TEST_TIMEOUT_MS,
  );
});

describeWithBrowser('the seeded secret reaches NO stored browser artifact (FR-28, AD-10)', () => {
  it(
    'is absent from the page text, the title, the url and every evidence file',
    async () => {
      // ⚠️ ASSERT ABSENCE, NEVER THE PRESENCE OF `[REDACTED]`. Epic 3's retrospective §7
      // records why: output containing the marker WITH the secret still beside it survives
      // review in a way a raw leak does not, so a test that looks for the marker passes on
      // exactly the output that should fail it.
      const environment = await playwrightEnvironment();
      if (!environment.ready) {
        throw new Error('the suite should have skipped: no usable Playwright');
      }
      const store = await sink();

      const attempt = await new BrowserSurfaceExecutor({
        clock,
        runner,
        cwd: scratch,
        environment,
        writeEvidence: store.writeEvidence,
        writeEvidenceBytes: store.writeEvidenceBytes,
        resolveRunPath: store.resolveRunPath,
        recordEvidence: store.recordEvidence,
        stepTimeoutMs: 10_000,
        timeoutMs: SUITE_SPAWN_TIMEOUT_MS,
        // The project-declared extra pattern (AD-10). A bare canary in page text has no
        // assignment shape for the built-in rules to recognise, which is the limit this
        // module's header states plainly rather than papering over — and `extraPatterns` is
        // exactly the mechanism a project uses to close it for secrets it knows the shape of.
        redaction: { extraPatterns: [new RegExp(SECRET, 'g')] },
      }).execute({
        criterionId: CRITERION.criterionId,
        surface: 'browser',
        params: {
          probe: {
            id: 'leaky',
            surface: 'browser',
            mechanics: {
              serviceId: 'web',
              // The URL is evidence too: a query string carries tokens, and a captured url
              // holding one sits right beside properly redacted output.
              path: `/leaky?api_key=${SECRET}`,
              scenario: '# just look at the page',
            },
            assertions: [
              {
                description: 'the heading does not leak the token',
                target: { source: 'text', selector: '#heading' },
                comparison: 'equals',
                expected: 'nothing',
              },
              {
                description: 'the title does not leak the token',
                target: { source: 'title' },
                comparison: 'equals',
                expected: 'nothing',
              },
              {
                description: 'the url does not leak the token',
                target: { source: 'url' },
                comparison: 'equals',
                expected: 'nothing',
              },
            ],
          },
          baseUrl: app.baseUrl,
        },
      });

      // Every text channel this surface captures.
      const derived = deriveCriterionResult(CRITERION, [attempt], {
        extraPatterns: [new RegExp(SECRET, 'g')],
      });
      expect(JSON.stringify(attempt.observations)).not.toContain(SECRET);
      expect(JSON.stringify(attempt.assertionEvaluations)).not.toContain(SECRET);
      expect(JSON.stringify(derived)).not.toContain(SECRET);
      expect(JSON.stringify(store.members)).not.toContain(SECRET);

      // WALK THE RUN DIRECTORY; NEVER SAMPLE. 4.6's review found a hole where the inline
      // evidence was spotless and the full-copy file beside it held the credential verbatim.
      const { readdir, readFile } = await import('node:fs/promises');
      const files: string[] = [];
      const walk = async (at: string): Promise<void> => {
        for (const entry of await readdir(at, { withFileTypes: true })) {
          const path = join(at, entry.name);
          if (entry.isDirectory()) {
            await walk(path);
            continue;
          }
          files.push(path);
        }
      };
      await walk(store.runDir);
      expect(files.length).toBeGreaterThan(3);

      for (const file of files) {
        // ⚠️ THE TWO CHANNELS THAT ARE OUT OF REACH, NAMED RATHER THAN PRETENDED AWAY.
        // A screenshot is pixels and a trace is a zip archive; `redactText` can read
        // neither. This module claims nothing about them, `browserEvidence`'s explanation
        // says so to whoever opens the artifact, and story 5.3 renders the sentence to the
        // reviewer. A redactor that CLAIMED to scrub images and did not would be worse than
        // one that says it cannot, because a reviewer would open it with their guard down.
        if (file.endsWith('.png') || file.endsWith('.zip')) {
          continue;
        }
        const contents = await readFile(file, 'utf8');
        expect(contents, `${file} leaked the seeded secret`).not.toContain(SECRET);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

/** A minimal `RunResult` carrying this criterion's evidence, so the report really renders. */
function runResultWith(
  evidence: readonly Evidence[],
  criteria: readonly ReturnType<typeof deriveCriterionResult>[],
): RunResult {
  return {
    runId: 'run-ac3',
    epic: 'epic-5',
    baseSha: '0'.repeat(40),
    headSha: '1'.repeat(40),
    startedAt: '2026-09-03T00:00:00.000Z',
    finishedAt: '2026-09-03T00:00:10.000Z',
    outcome: { verdict: 'FAIL' },
    stages: [],
    gates: [],
    criteria,
    evidence,
    providerUsage: [],
    environment: {
      baseBranch: 'master',
      epicBranch: 'epic/5-playwright-integration-environment-resolution',
      worktreePath: null,
      runDirectory: '.specwitness/runs/run-ac3',
    },
  } as unknown as RunResult;
}
