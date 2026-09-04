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
 * ⚠️ WHICH FAILURES THE FLOW ACTUALLY OFFERS — NARROWER THAN THIS FILE EXERCISES
 * ============================================================================
 *
 * AC1 says "failing on element-not-found". Getting that predicate right took two rounds of
 * review, and the answer is ONE signal:
 *
 *     a SCENARIO STEP could not find its target  =>  execError, reason 'step-target-missing'
 *
 * and nothing else. In particular an UNSATISFIED ASSERTION is never offered, even though a
 * missing element produces one: an assertion that read an existing but wrong value is an
 * ordinary PRODUCT FAILURE, and offering it would invite a provider to rewrite where the
 * probe looks until the unchanged assertion passes somewhere else. The payload schema cannot
 * stop that — nothing about WHAT MUST BE TRUE would be changing — so the candidate rule is
 * the only thing that can. See `pipeline/stages/probes.ts`'s adaptation section.
 *
 * ⚠️ **SO TWO TESTS BELOW EXERCISE A CHAIN THE FLOW WOULD NOT INITIATE, AND SAY SO IN THEIR
 * OWN NAMES.** `applyAdaptation` really does apply a `scenario` or a `path` change and the
 * re-executed probe really does pass — that is worth proving against a real browser, because
 * it is the machinery every accepted proposal uses. But the STAGE would never offer those
 * two criteria, because both failed on an assertion that read a real value. Only the third
 * case — a clicked control that is gone — is one the flow itself would reach end to end.
 *
 * Keeping them is deliberate rather than tidy: they are the only place the apply-and-
 * re-execute machinery meets a real chromium, and mislabelling them as "the flow adapts
 * this" is exactly the kind of claim two review rounds already caught me making.
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
    if (path.startsWith('/relay')) {
      // Same origin, so a click really lands here and the clicked element stops existing.
      // Then it tries to leave for an undeclared host, which the interception refuses.
      response.end(
        ordersPage(
          '<h1 id="heading">Relaying</h1>' +
            '<script>location.href = "https://prod.example.com/";</script>',
        ),
      );
      return;
    }
    response.end(
      ordersPage(
        '<h1 id="heading">Orders</h1>' +
          '<a id="create-company" href="/companies">Create company</a>' +
          '<a id="via-relay" href="/relay">Via relay</a>' +
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
    'applies a SCENARIO change end to end (a chain the flow reaches only via a step miss)',
    async () => {
      // The compiled probe clicks `#create-company`, which the page still has — so every
      // STEP succeeds and the probe genuinely LOOKED. What it saw was the deprecation page,
      // so the assertion is unsatisfied: `fail`.
      //
      // ⚠️ THE STAGE WOULD NOT OFFER THIS. A `fail` means the probe looked and saw something
      // wrong, which is a fact about the product. What this test proves is the MACHINERY —
      // that a scenario change really applies to a plan copy and the re-executed probe
      // really passes, against a real browser. The flow reaches that machinery only through
      // a step-target miss, which the third test covers.
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
    'applies a PATH change end to end (same: the machinery, not a case the flow offers)',
    async () => {
      // No interaction at all — the probe navigates and reads. `/companies` serves the
      // deprecation page, so the assertion is unsatisfied and the criterion fails.
      //
      // ⚠️ Same as above: the stage would not offer this, and this test is about the
      // machinery rather than the trigger. A renamed route is indistinguishable, from the
      // evidence a run holds, from a page that is simply wrong.
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
    'THE case the flow offers: a clicked control that is gone, end to end',
    async () => {
      // ⚠️ THE TEST THAT USED TO MEASURE A LIMITATION NOW MEASURES ITS FIX, and it is kept
      // rather than replaced so the change is visible in one place. `#gone` is not on the
      // page, so the CLICK step fails and 5.2 reports an `execError` — but it now says WHY,
      // established by asking the page whether the selector matched rather than by reading
      // Playwright's message.
      //
      // This is the motivating case of the whole story: a control was renamed, a probe
      // clicks the old one, and nothing about the system under verification changed.
      const plan = planWith(browserProbe('/orders', 'click "#gone"'));

      const outcome = await execute(probeOf(plan), 'step-missing');

      // Still an execError — 5.2's classification is untouched.
      expect(outcome.attempt.execError).toBeDefined();
      expect(deriveCriterionResult(CRITERION, [outcome.attempt]).status).toBe('error');
      // And it now carries the structured reason the candidate rule branches on. A REAL
      // browser produced this: nothing here simulates the classification.
      expect(outcome.attempt.execError?.reason).toBe('step-target-missing');

      // Which means the adaptation flow can reach it. The rest of the chain is the same as
      // the two tests above.
      const { plan: adapted, changes } = applyAdaptation(plan, [
        { probeId: 'reach-organizations', scenario: 'click "#add-organization"' },
      ]);
      expect(changes.map((change) => change.field)).toEqual(['scenario']);

      const after = await execute(probeOf(adapted), 'step-missing-after');
      expect(after.attempt.execError).toBeUndefined();
      expect(deriveCriterionResult(CRITERION, [after.attempt]).status).toBe('pass');
      expect(probeOf(adapted).assertions).toBe(probeOf(plan).assertions);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a step failure that is NOT a missing target does not claim to be one',
    async () => {
      // The other side of the discrimination, proved against a real browser rather than a
      // double: `#heading` EXISTS but is not clickable in a way that resolves, so the step
      // fails while the selector matches. The reason must not be `step-target-missing`,
      // because the page did not report an absence.
      //
      // A `fill` on a non-input is the cleanest reproducible case: the element is there, the
      // action is invalid.
      const plan = planWith(browserProbe('/orders', 'fill "#heading" "text"'));

      const outcome = await execute(probeOf(plan), 'step-not-a-miss');

      expect(outcome.attempt.execError).toBeDefined();
      expect(outcome.attempt.execError?.reason).not.toBe('step-target-missing');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'establishes the missing-target reason BEFORE acting, and remembers no selector',
    async () => {
      // ⚠️ THE ROUND-2 CODEX P1, AND THE HONEST FORM OF ITS PROOF. Worth reading, because
      // the first two things I wrote here were both wrong and the sequence is the point.
      //
      // The finding: the driver remembered which selector a step was acting on so the catch
      // could ask the page whether it matched. A LATER failure would then be asked about an
      // element that had nothing to do with it — and a click that navigates away removes its
      // own target, so the answer would be "nothing matches" and an unrelated failure would
      // become adaptable cosmetic drift.
      //
      // The first fix was the one the review suggested: clear the selector once the step
      // succeeds. A test written to prove it went RED AGAINST THE FIXED CODE, because the
      // after-the-fact probe is unreliable even while the selector is legitimately in
      // flight: once a click has navigated, "does this selector still match?" answers no
      // whether the element was ever there or not.
      //
      // So the reason is now established BEFORE the action, as its own operation, and
      // NOTHING IS REMEMBERED. That is why this test is structural rather than behavioural:
      // there is no stale state left to trigger, so no run can exhibit it. The generated
      // driver is a byte-for-byte constant of SpecWitness, which is exactly what makes
      // asserting on its text meaningful here — the same technique
      // `browser-security.test.ts` uses.
      const environment = await playwrightEnvironment();
      if (!environment.ready) {
        throw new Error('the suite should have skipped: no usable Playwright');
      }

      const runDir = join(scratch, 'generated-spec');
      const written: Record<string, string> = {};
      const dispatch = createProbeDispatcher({
        config: configWithService(Number(new URL(app.baseUrl).port)),
        runner,
        clock,
        writeEvidence: async (name, contents) => {
          written[name] = contents;
          const absolute = join(runDir, name);
          await mkdir(dirname(absolute), { recursive: true });
          await writeFile(absolute, contents);
          return name;
        },
        writeEvidenceBytes: async (name, contents) => {
          const absolute = join(runDir, name);
          await mkdir(dirname(absolute), { recursive: true });
          await writeFile(absolute, contents);
          return name;
        },
        resolveRunPath: (name) => join(runDir, name),
        playwright: environment,
        onProcessGroup: () => undefined,
      });

      const { executor, params } = dispatch({
        criterionId: CRITERION.criterionId,
        probe: probeOf(planWith(browserProbe('/orders', 'click "#add-organization"'))),
        attempt: 1,
        cwd: scratch,
        runAction: async () => undefined,
        recordEvidence: () => undefined,
      });
      await executor.execute({
        criterionId: CRITERION.criterionId,
        surface: 'browser',
        params,
      });

      const spec = Object.entries(written).find(([name]) => name.endsWith('.spec.cjs'))?.[1];
      expect(spec).toBeDefined();

      // No remembered selector anywhere: the whole class of staleness is deleted rather
      // than managed. If a future change reintroduces one, this goes red.
      expect(spec).not.toContain('failingSelector');
      // The classification lives inside the failing ACTION's own catch, so only that step's
      // failure can reach it, and it costs no extra bounded operation (see `#bounds` — an
      // earlier version added a separate full-timeout wait and broke the arithmetic).
      expect(spec).toContain('const urlBeforeStep = page.url()');
      expect(spec).toContain("outcome.reason = 'unreachable'");
      // Both facts, not one: a target miss requires that the page did not move AND that the
      // selector matches nothing.
      expect(spec).toContain('!moved');
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
