/**
 * Story 5.6, task 6 — the whole flow against a REAL failing browser probe.
 *
 * Every other 5.6 suite uses a double somewhere: the schema suite parses JSON, the flow
 * suite scripts raw provider text, the stage suite scripts probe outcomes. This one closes
 * the loop with a real chromium, a real fixture app on an ephemeral port and the real
 * dispatcher, so the chain AC1 describes is proved end to end:
 *
 *   a probe fails on element-not-found  ⇒  a proposal  ⇒  validation  ⇒  a plan COPY
 *   ⇒  re-execution through 5.2's OWN path  ⇒  a recorded, marked outcome
 *
 * ============================================================================
 * ⚠️ WHICH FAILURES ARE ACTUALLY ADAPTABLE — MEASURED HERE, NOT ASSUMED
 * ============================================================================
 *
 * AC1 says "a browser probe failing on element-not-found", and the clarifications say
 * **never adapt an `execError`** because that means the probe could not observe. Those two
 * sentences do not partition the space as cleanly as they look, and this file is where the
 * seam was found — by running it, not by reading it.
 *
 * In 5.2's merged classification, a MISSING ELEMENT produces two different outcomes
 * depending on WHERE it is missing:
 *
 *   an ASSERTION reads a selector that matches nothing  =>  unsatisfied assertion  =>  `fail`
 *   a SCENARIO STEP cannot find its target              =>  `execError`            =>  `error`
 *
 * The second is the one that surprises. `click "#create-company"` against a page that
 * renamed the control times out as a STEP failure, and `browser.ts` builds one `execError`
 * for it that is shaped identically to the one a mid-run browser CRASH produces — the only
 * difference is a `phase` word inside a prose message.
 *
 * So "the button was relabelled and the probe CLICKS it" is `error`, and this story is
 * forbidden from adapting an `error`. That prohibition is right: the alternative is
 * distinguishing the two by matching Playwright's message text, which is precisely the
 * technique this codebase rejects elsewhere ("classified on the OUTCOME, never by matching
 * the adapter's prose").
 *
 * WHAT IS THEREFORE ADAPTABLE, and what these tests exercise:
 *
 *   - **path drift** — the route was renamed. Steps succeed, the page is wrong, the
 *     assertion is unsatisfied. `fail`. Adaptable, and fixed by a new `path`.
 *   - **scenario drift where the stale control still exists** — a deprecated link is still
 *     on the page and still clickable, but now leads somewhere else. Steps succeed, the
 *     assertion is unsatisfied. `fail`. Adaptable, and fixed by a new `scenario`.
 *
 * The gap is reported in the PR body and the Dev Agent Record rather than worked around
 * here. Closing it properly means a structured reason on `ProbeExecError` so a step-target
 * miss can be told from a crash without reading prose — an ADDITIVE change to a merged
 * type, which is a message to the owner or a follow-up PR, not something a story branch
 * smuggles in.
 *
 * ⚠️ **AN ADAPTED SCENARIO TRAVELS 5.2'S VALIDATION PATH WITH NO SHORTCUT.** The adapted
 * probe goes through the SAME `createProbeDispatcher` the original did, so its scenario is
 * parsed by the same parser and driven by the same byte-identical generated spec. The last
 * two tests prove it: both refusals come from 5.2's own code, not from anything 5.6 wrote.
 *
 * ⚠️ THE CODEX REVIEW SANDBOX CANNOT BIND 127.0.0.1 (EPERM), so this file — like the four
 * `buildProbeFixture` suites and 5.2's own browser suites — structurally cannot run there.
 * A failure of this file in a review log is that sandbox limitation, not a regression.
 * Check whether a failing file binds a socket before debugging it.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, expect, it } from 'vitest';

import { createProbeDispatcher } from '../../../src/cli/verify/probe-dispatch.js';
import type { SpecwitnessConfig } from '../../../src/config/index.js';
import { applyAdaptation } from '../../../src/domain/adaptation-apply.js';
import { deriveCriterionResult } from '../../../src/domain/criterion-result.js';
import type { ContractCriterionRef } from '../../../src/domain/criterion-result.js';
import type { Evidence } from '../../../src/domain/evidence.js';
import type { BrowserProbe, Plan } from '../../../src/domain/plan.js';
import { createProcessRunner } from '../../../src/infra/process-runner.js';
import { MechanicsAdaptationSchema } from '../../../src/schemas/adaptation.js';
import { serializePlan } from '../../../src/schemas/plan.js';
import {
  announceBrowserAvailability,
  clock,
  describeWithBrowser,
  ordersPage,
  playwrightEnvironment,
  startFixtureApp,
  type FixtureApp,
} from './helpers/browser-fixture.js';

const TEST_TIMEOUT_MS = 120_000;

const CRITERION: ContractCriterionRef = {
  criterionId: 'E5-06',
  statement: 'a user reaches the organizations page from the orders page',
  severity: 'critical',
  verifiability: 'automated',
};

let app: FixtureApp;
let scratch: string;
const runner = createProcessRunner(clock);

/**
 * The system under verification, AFTER a cosmetic change.
 *
 * `/organizations` is the page the criterion is about. `/companies` is where it used to
 * live and now serves a deprecation notice. The orders page still carries the OLD link
 * (`#create-company`, pointing at the stale route) beside the NEW one — which is what makes
 * the stale scenario fail on an assertion rather than on a missing element.
 */
beforeAll(async () => {
  await announceBrowserAvailability();
  scratch = await mkdtemp(join(tmpdir(), 'specwitness-adapt-'));
  app = await startFixtureApp((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    response.writeHead(200, { 'content-type': 'text/html' });

    if (path.startsWith('/organizations')) {
      response.end(ordersPage('<h1 id="heading">Organizations</h1>'));
      return;
    }
    if (path.startsWith('/companies')) {
      response.end(ordersPage('<h1 id="heading">This page has moved</h1>'));
      return;
    }
    response.end(
      ordersPage(
        '<h1 id="heading">Orders</h1>' +
          '<a id="create-company" href="/companies">Create company</a>' +
          '<a id="add-organization" href="/organizations">Add organization</a>',
      ),
    );
  });
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  await app.close();
  await rm(scratch, { recursive: true, force: true });
});

function browserProbe(path: string, scenario: string): BrowserProbe {
  return {
    id: 'reach-organizations',
    surface: 'browser',
    mechanics: { serviceId: 'web', path, scenario },
    assertions: [
      {
        description: 'the organizations page is reached',
        target: { source: 'text', selector: '#heading' },
        comparison: 'equals',
        expected: 'Organizations',
      },
    ],
  };
}

function planWith(probe: BrowserProbe): Plan {
  return {
    plan: {
      epic: 'epic-5',
      contract: { version: 1, fingerprint: 'sha256:abc' },
      data: { seed: 'seed-epic-5-aaaa', bindings: [] },
      criteria: [{ criterionId: CRITERION.criterionId, disposition: 'automated', probes: [probe] }],
    },
    meta: {
      schemaVersion: 1,
      provenance: { provider: null, adapter: null, model: null, generatedAt: null },
    },
  } as unknown as Plan;
}

function configWithService(port: number): SpecwitnessConfig {
  return { services: { web: { port } } } as unknown as SpecwitnessConfig;
}

/** The single browser probe of a plan, typed. */
function probeOf(plan: Plan): BrowserProbe {
  const criterion = plan.plan.criteria[0];
  if (criterion?.disposition !== 'automated') {
    throw new Error('the fixture plan lost its automated criterion');
  }
  return criterion.probes[0] as BrowserProbe;
}

/** Runs one probe through the REAL dispatcher and returns its attempt. */
async function execute(probe: BrowserProbe, label: string) {
  const environment = await playwrightEnvironment();
  if (!environment.ready) {
    throw new Error('the suite should have skipped: no usable Playwright');
  }

  const runDir = join(scratch, label);
  const members: Evidence[] = [];
  const write = async (name: string, contents: string | Uint8Array): Promise<string> => {
    const absolute = join(runDir, name);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
    return name;
  };

  const dispatch = createProbeDispatcher({
    config: configWithService(Number(new URL(app.baseUrl).port)),
    runner,
    clock,
    writeEvidence: write,
    writeEvidenceBytes: write,
    resolveRunPath: (name) => join(runDir, name),
    playwright: environment,
    onProcessGroup: () => undefined,
  });

  const { executor, params } = dispatch({
    criterionId: CRITERION.criterionId,
    probe,
    attempt: 1,
    cwd: scratch,
    runAction: async () => undefined,
    recordEvidence: (member) => {
      members.push(member);
    },
  });

  const attempt = await executor.execute({
    criterionId: CRITERION.criterionId,
    surface: 'browser',
    params,
  });

  return { attempt, members };
}

describeWithBrowser('5.6 — adapting a real failing browser probe', () => {
  it(
    'adapts a SCENARIO: the stale control still exists but now leads to the wrong page',
    async () => {
      // The compiled probe clicks `#create-company`, which the page still has — so every
      // STEP succeeds and the probe genuinely LOOKED. What it saw was the deprecation page,
      // so the assertion is unsatisfied: `fail`, not `error`. Cosmetic drift, adaptable.
      const plan = planWith(browserProbe('/orders', 'click "#create-company"'));
      const planBytes = serializePlan(plan);

      const before = await execute(probeOf(plan), 'scenario-before');

      // The distinction 5.2's table draws, and the one AC1 depends on: the probe looked.
      expect(before.attempt.execError).toBeUndefined();
      expect(deriveCriterionResult(CRITERION, [before.attempt]).status).toBe('fail');

      // A proposal arrives and goes through the REAL payload schema.
      expect(
        MechanicsAdaptationSchema.safeParse({
          proposals: [
            { probeId: 'reach-organizations', mechanics: { scenario: 'click "#add-organization"' } },
          ],
        }).success,
      ).toBe(true);

      const { plan: adapted, changes } = applyAdaptation(plan, [
        { probeId: 'reach-organizations', scenario: 'click "#add-organization"' },
      ]);

      // AC1's hard requirement, asserted on BYTES rather than on the absence of an error.
      expect(serializePlan(plan)).toBe(planBytes);
      expect(changes).toEqual([
        {
          criterionId: CRITERION.criterionId,
          probeId: 'reach-organizations',
          field: 'scenario',
          from: 'click "#create-company"',
          to: 'click "#add-organization"',
        },
      ]);

      const after = await execute(probeOf(adapted), 'scenario-after');
      expect(after.attempt.execError).toBeUndefined();
      expect(deriveCriterionResult(CRITERION, [after.attempt]).status).toBe('pass');

      // The adapted run produced browser evidence through the same two channels.
      expect(after.members).toHaveLength(1);
      expect(after.members[0]?.kind).toBe('browser');

      // ⚠️ WHAT MUST BE TRUE DID NOT MOVE. Identity, not value: the adapted probe's
      // assertions are the SAME ARRAY the compiled plan carried.
      expect(probeOf(adapted).assertions).toBe(probeOf(plan).assertions);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'adapts a PATH: the route was renamed and the probe still starts at the old one',
    async () => {
      // No interaction at all — the probe navigates and reads. `/companies` serves the
      // deprecation page, so the assertion is unsatisfied and the criterion fails.
      const plan = planWith(browserProbe('/companies', '# navigate and look'));
      const planBytes = serializePlan(plan);

      const before = await execute(probeOf(plan), 'path-before');
      expect(before.attempt.execError).toBeUndefined();
      expect(deriveCriterionResult(CRITERION, [before.attempt]).status).toBe('fail');

      const { plan: adapted, changes } = applyAdaptation(plan, [
        { probeId: 'reach-organizations', path: '/organizations' },
      ]);

      expect(serializePlan(plan)).toBe(planBytes);
      expect(changes.map((change) => change.field)).toEqual(['path']);

      const after = await execute(probeOf(adapted), 'path-after');
      expect(deriveCriterionResult(CRITERION, [after.attempt]).status).toBe('pass');
      expect(probeOf(adapted).assertions).toBe(probeOf(plan).assertions);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'measures the seam: a step whose target is missing is an execError, NOT an adaptable fail',
    async () => {
      // ⚠️ THIS TEST DOCUMENTS A LIMITATION RATHER THAN A FEATURE, and it exists so the
      // limitation is measured and cannot drift silently. `#gone` is not on the page, so the
      // CLICK step fails and 5.2 reports an `execError` — indistinguishable in shape from a
      // mid-run browser crash. The candidate rule therefore excludes it, and the module
      // header says why. If 5.2's classification ever gains a structured reason, this test
      // is the one that should change.
      const plan = planWith(browserProbe('/orders', 'click "#gone"'));

      const outcome = await execute(probeOf(plan), 'step-missing');

      expect(outcome.attempt.execError).toBeDefined();
      expect(deriveCriterionResult(CRITERION, [outcome.attempt]).status).toBe('error');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses an adapted scenario that 5.2 cannot parse — no shortcut past its validation',
    async () => {
      // The payload schema types `scenario` as free prose, exactly as the merged plan schema
      // does, so a proposal CAN carry something the executor will not accept. It is refused
      // by 5.2's own parser rather than by anything this story wrote — which is the proof
      // that an adapted scenario travels the same path as an original one.
      const { plan } = applyAdaptation(planWith(browserProbe('/orders', 'click "#create-company"')), [
        { probeId: 'reach-organizations', scenario: 'log in as alice, then click Submit' },
      ]);

      await expect(execute(probeOf(plan), 'unparseable')).rejects.toThrow(/directive|scenario/i);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses an adapted scenario that tries to leave the declared origin (AD-3)',
    async () => {
      // A `goto` inside a scenario is held to the same service-relative rule the plan's own
      // `path` is. 5.2 owns this refusal; 5.6 relies on it and does not reimplement it.
      const { plan } = applyAdaptation(planWith(browserProbe('/orders', 'click "#create-company"')), [
        { probeId: 'reach-organizations', scenario: 'goto "https://prod.example.com/orders"' },
      ]);

      await expect(execute(probeOf(plan), 'off-origin')).rejects.toThrow();
    },
    TEST_TIMEOUT_MS,
  );
});
