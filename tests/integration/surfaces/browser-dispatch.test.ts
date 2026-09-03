/**
 * The composition root's `browser` case — story 5.2, task 6.
 *
 * Epic 4 left `src/cli/verify/probe-dispatch.ts` throwing an `InfraError` reading "browser
 * probes arrive in Epic 5". This file is what proves the refusal was replaced by an
 * EXECUTOR and not by a skip, and that the values the edge has to resolve really arrive:
 * the service origin, both evidence writers, the run-path resolver, the process-group
 * recorder and 5.1's environment.
 *
 * ⚠️ **WHY THIS FILE EXISTS AT ALL.** Every other browser suite constructs the executor
 * itself, so all of them stay green against a dispatcher that binds the wrong writer, omits
 * `writeEvidenceBytes`, or hands over a stubbed `recordEvidence`. That is the exact shape of
 * the failure all three cohort-2 PR bodies warn about — an epic whose reports carry gate
 * evidence and no probe evidence, silently, with every surface suite green. The wiring needs
 * its own test because nothing else can see it.
 *
 * ⚠️ A SKIPPED TEST AND A SKIPPED CRITERION ARE DIFFERENT THINGS. The production code has no
 * skip path.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, expect, it } from 'vitest';

import { createProbeDispatcher } from '../../../src/cli/verify/probe-dispatch.js';
import type { SpecwitnessConfig } from '../../../src/config/index.js';
import { deriveCriterionResult } from '../../../src/domain/criterion-result.js';
import type { ContractCriterionRef } from '../../../src/domain/criterion-result.js';
import { InfraError } from '../../../src/domain/errors.js';
import type { Evidence } from '../../../src/domain/evidence.js';
import type { BrowserProbe } from '../../../src/domain/plan.js';
import { createProcessRunner } from '../../../src/infra/process-runner.js';
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
  criterionId: 'E5-04',
  statement: 'the dispatcher routes a browser probe to a real executor',
  severity: 'critical',
  verifiability: 'automated',
};

let app: FixtureApp;
let scratch: string;
const runner = createProcessRunner(clock);

beforeAll(async () => {
  await announceBrowserAvailability();
  scratch = await mkdtemp(join(tmpdir(), 'specwitness-browser-dispatch-'));
  app = await startFixtureApp((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(ordersPage('<h1 id="heading">Orders</h1>'));
  });
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  await app.close();
  await rm(scratch, { recursive: true, force: true });
});

const PROBE: BrowserProbe = {
  id: 'orders',
  surface: 'browser',
  mechanics: { serviceId: 'web', path: '/orders', scenario: '# just look' },
  assertions: [
    {
      description: 'the heading reads Orders',
      target: { source: 'text', selector: '#heading' },
      comparison: 'equals',
      expected: 'Orders',
    },
  ],
};

/**
 * The narrowest config the dispatcher reads: one declared service.
 *
 * AD-3's point in miniature — the plan names `web`, and the ORIGIN comes from here, from
 * the project's own configuration, never from anything the plan wrote.
 */
function configWithService(port: number): SpecwitnessConfig {
  return { services: { web: { port } } } as unknown as SpecwitnessConfig;
}

describeWithBrowser('the dispatcher routes a browser probe to a real executor', () => {
  it(
    'resolves the origin from config, binds both evidence writers, and produces an attempt',
    async () => {
      const environment = await playwrightEnvironment();
      if (!environment.ready) {
        throw new Error('the suite should have skipped: no usable Playwright');
      }

      const runDir = join(scratch, 'run-ok');
      const members: Evidence[] = [];
      const groups: number[] = [];
      const write = async (name: string, contents: string | Uint8Array): Promise<string> => {
        const absolute = join(runDir, name);
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, contents);
        return name;
      };

      const port = Number(new URL(app.baseUrl).port);
      const dispatch = createProbeDispatcher({
        config: configWithService(port),
        runner,
        clock,
        writeEvidence: write,
        writeEvidenceBytes: write,
        resolveRunPath: (name) => join(runDir, name),
        playwright: environment,
        onProcessGroup: (pgid) => {
          groups.push(pgid);
        },
      });

      const { executor, params } = dispatch({
        criterionId: CRITERION.criterionId,
        probe: PROBE,
        attempt: 1,
        cwd: scratch,
        runAction: async () => undefined,
        recordEvidence: (member) => {
          members.push(member);
        },
      });

      // The params shape is HTTP's, and the base URL was resolved from the project's own
      // config by `resolveServiceBaseUrl` — never taken from the plan (AD-3).
      expect(executor.surface).toBe('browser');
      expect(params['baseUrl']).toBe(`http://127.0.0.1:${port}`);
      expect(params['probe']).toBe(PROBE);
      expect(params['attempt']).toBe(1);

      const attempt = await executor.execute({
        criterionId: CRITERION.criterionId,
        surface: 'browser',
        params,
      });

      expect(attempt.execError).toBeUndefined();
      expect(deriveCriterionResult(CRITERION, [attempt]).status).toBe('pass');

      // ⚠️ THE BINDING THAT FAILS SILENTLY. `recordEvidence` reached the executor from the
      // STAGE, and the typed member came back through it. A dispatcher that stubbed this
      // would leave every other browser suite green.
      expect(members).toHaveLength(1);
      expect(members[0]?.kind).toBe('browser');

      // And the BINARY writer really was the one bound: without it the trace and the
      // screenshot would be absent or corrupt.
      const paths = attempt.evidence.map((ref) => ref.path);
      expect(paths.some((path) => path.endsWith('.trace.zip'))).toBe(true);
      expect(paths.some((path) => path.endsWith('.screenshot.png'))).toBe(true);

      // AD-8: the process group was recorded, so `specwitness clean` can reap a browser
      // tree. Retro §2 observations 3 and 8 — the one executor that forgot this could not
      // be reaped, and a leaked browser is strictly worse than a leaked node script.
      expect(groups.length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );
});

it(
  'refuses with InfraError when Playwright is absent — the refusal moved, it did not vanish',
  async () => {
    // Epic 4's arm threw here. Story 5.2 replaced it with an executor, and the OBLIGATION
    // the throw carried transferred with it: an unprovisioned machine still refuses, in
    // 5.1's own words, rather than contributing nothing. A skip here would be the standing
    // green-for-nothing hazard reaching a third occurrence.
    //
    // Needs no browser, so it runs everywhere — including on the machines where the rest of
    // this file is skipped, which is exactly where the refusal matters most.
    const dispatch = createProbeDispatcher({
      config: configWithService(4000),
      runner,
      clock,
      writeEvidence: async (name) => name,
      writeEvidenceBytes: async (name) => name,
      resolveRunPath: (name) => name,
      playwright: {
        ready: false,
        browsersPath: '/nowhere',
        reason: '@playwright/test could not be resolved from the project',
      },
      onProcessGroup: () => undefined,
    });

    const { executor, params } = dispatch({
      criterionId: CRITERION.criterionId,
      probe: PROBE,
      attempt: 1,
      cwd: process.cwd(),
      runAction: async () => undefined,
      recordEvidence: () => undefined,
    });

    const error = await executor
      .execute({ criterionId: CRITERION.criterionId, surface: 'browser', params })
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

    expect(error).toBeInstanceOf(InfraError);
    expect((error as InfraError).message).toContain('could not be resolved from the project');
    expect((error as InfraError).hint).toContain('never skipped');
  },
  TEST_TIMEOUT_MS,
);
