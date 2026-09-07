/**
 * Story 7.0 — `verify` provisions Playwright when, and only when, the plan needs a browser.
 *
 * ⚠️ **NOTHING HERE DOWNLOADS ANYTHING.** `provisionPlaywright` spawns `npm` and Playwright's
 * own `cli.js` through `ProcessRunner`, and every test below injects a fake runner exactly as
 * `tests/unit/infra/playwright-env.test.ts` does. The auto-review runs `pnpm test`
 * concurrently in a second copy of this worktree (harness defect H-8), so a real browser
 * download in this path would be the most expensive thing in the suite.
 *
 * ⚠️ **THE POINT OF THIS FILE IS THAT A CALL SITE EXISTS.** Defect D-5 of the first
 * dogfooding run: `provisionPlaywright` was exported, unit-tested and called from nowhere in
 * `src/`, so a browser probe on a project without its own `@playwright/test` could only ever
 * exit 3. Its unit tests were green throughout, because they called the function themselves.
 * These tests therefore assert the DECISION — provision or resolve — rather than the
 * provisioning, and the corpus fixture `browser-probe-provisions` pins the same decision
 * through the real binary.
 *
 * ⚠️ **THERE IS NO SKIP PATH, HERE OR IN THE CODE UNDER TEST.** An unavailable browser
 * environment is `InfraError` (exit 3), never `skipped` and never `pass` — Epic 4 retro §2
 * observation 2. Nothing in this file is a licence to add one.
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  PROVISION_TIMEOUT_MS,
  planRequiresBrowser,
  resolveBrowserEnvironment,
  shouldReportUnavailableBrowser,
} from '../../../src/cli/verify/playwright-provisioning.js';
import { InfraError } from '../../../src/domain/errors.js';
import type { Plan, PlanCriterion, ProbeSpec } from '../../../src/domain/plan.js';
import type { ProcessResult, ProcessRunOptions } from '../../../src/domain/process-runner.js';
import { PLAYWRIGHT_PACKAGE } from '../../../src/infra/playwright-env.js';

/* ── fixtures ──────────────────────────────────────────────────────────────────────── */

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'specwitness-7-0-'));
  scratch.push(dir);
  return dir;
}

const FIXTURE_REVISION = '1234';

/**
 * A resolvable `@playwright/test` beside the `playwright-core` that carries the browser
 * revision table — the same shape `tests/unit/infra/playwright-env.test.ts` builds, because
 * the production resolver uses Node's own `require.resolve` and reads
 * `playwright-core/browsers.json`. A stub the resolver had to be taught to accept would
 * prove nothing.
 */
async function installFakePlaywright(dir: string, version: string): Promise<void> {
  const modules = join(dir, 'node_modules');
  const packageDir = join(modules, PLAYWRIGHT_PACKAGE);
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: PLAYWRIGHT_PACKAGE, version, main: 'index.js', bin: { playwright: 'cli.js' } }),
    'utf8',
  );
  await writeFile(join(packageDir, 'index.js'), 'module.exports = {};\n', 'utf8');
  await writeFile(join(packageDir, 'cli.js'), '#!/usr/bin/env node\n', 'utf8');

  const coreDir = join(modules, 'playwright-core');
  await mkdir(coreDir, { recursive: true });
  await writeFile(
    join(coreDir, 'package.json'),
    JSON.stringify({ name: 'playwright-core', version, main: 'index.js' }),
    'utf8',
  );
  await writeFile(join(coreDir, 'index.js'), 'module.exports = {};\n', 'utf8');
  await writeFile(
    join(coreDir, 'browsers.json'),
    JSON.stringify({
      browsers: [
        { name: 'chromium', revision: FIXTURE_REVISION, installByDefault: true },
        { name: 'chromium-headless-shell', revision: FIXTURE_REVISION, installByDefault: true },
      ],
    }),
    'utf8',
  );
}

/** A COMPLETE chromium registry: both bundles a launch needs, each with its marker file. */
async function installFakeChromium(browsersPath: string): Promise<void> {
  for (const bundle of [
    `chromium-${FIXTURE_REVISION}`,
    `chromium_headless_shell-${FIXTURE_REVISION}`,
  ]) {
    await mkdir(join(browsersPath, bundle), { recursive: true });
    await writeFile(join(browsersPath, bundle, 'INSTALLATION_COMPLETE'), '', 'utf8');
  }
}

function ok(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return { outcome: 'completed', exitCode: 0, stdout: '', stderr: '', durationMs: 1, pgid: 4242, ...overrides };
}

function fakeRunner(
  results: readonly ProcessResult[],
  effect?: (call: number, options: ProcessRunOptions) => Promise<void>,
): { readonly runner: { run(options: ProcessRunOptions): Promise<ProcessResult> }; readonly runs: ProcessRunOptions[] } {
  const runs: ProcessRunOptions[] = [];
  let next = 0;
  return {
    runs,
    runner: {
      async run(options: ProcessRunOptions): Promise<ProcessResult> {
        const call = next;
        runs.push(options);
        const result = results[next] ?? results.at(-1);
        next += 1;
        if (result === undefined) {
          throw new Error('fake runner has no result configured');
        }
        await effect?.(call, options);
        // The real runner always reports a pgid and awaits the hook before the run proceeds
        // (AD-8), so the fake does too — otherwise a test passes against a call site that
        // never wired `onProcessGroup` and `specwitness clean` cannot reap the download.
        if (result.pgid != null) {
          await options.onProcessGroup?.(result.pgid);
        }
        return result;
      },
    },
  };
}

const BROWSER_PROBE: ProbeSpec = {
  id: 'P1',
  surface: 'browser',
  mechanics: { serviceId: 'app', path: '/', scenario: 'open the page' },
  assertions: [{ description: 'the title', target: { source: 'title' }, comparison: 'equals', expected: 'Home' }],
};

const HTTP_PROBE: ProbeSpec = {
  id: 'P2',
  surface: 'http',
  mechanics: { serviceId: 'app', method: 'GET', path: '/health' },
  assertions: [{ description: 'ok', target: { source: 'status' }, comparison: 'equals', expected: '200' }],
};

function planWith(criteria: readonly PlanCriterion[]): Plan {
  return {
    plan: {
      epic: 'epic-1',
      contract: { version: 1, fingerprint: 'f'.repeat(64) },
      data: { seed: 'seed-7-0', bindings: [] },
      criteria,
    },
    meta: {
      schemaVersion: 1,
      compiledAt: '2026-09-07T00:00:00Z',
      provenance: { provider: null, model: null, providerCliVersion: null, generatedAt: null },
    },
  };
}

/** Everything under `projectRoot`, so a test can prove nothing was written into it (AC3). */
async function treeOf(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      found.push(relative(root, full));
      if (entry.isDirectory()) {
        await walk(full);
      }
    }
  };
  await walk(root);
  return found.sort();
}

/* ── planRequiresBrowser ───────────────────────────────────────────────────────────── */

describe('planRequiresBrowser', () => {
  it('is false for no plan at all', () => {
    expect(planRequiresBrowser(undefined)).toBe(false);
  });

  it('is false for a plan whose probes are all non-browser', () => {
    expect(
      planRequiresBrowser(
        planWith([{ criterionId: 'E1-01', disposition: 'automated', probes: [HTTP_PROBE] }]),
      ),
    ).toBe(false);
  });

  it('is false for a needs-human criterion, which carries no probes at all', () => {
    expect(
      planRequiresBrowser(
        planWith([
          {
            criterionId: 'E1-01',
            disposition: 'needs-human',
            reason: 'human-verifiability',
            guidance: 'look at it',
          },
        ]),
      ),
    ).toBe(false);
  });

  it('is true as soon as ONE criterion carries ONE browser probe', () => {
    expect(
      planRequiresBrowser(
        planWith([
          { criterionId: 'E1-01', disposition: 'automated', probes: [HTTP_PROBE] },
          { criterionId: 'E1-02', disposition: 'automated', probes: [HTTP_PROBE, BROWSER_PROBE] },
        ]),
      ),
    ).toBe(true);
  });
});

/* ── AC2: a run that needs no browser provisions nothing ───────────────────────────── */

describe('resolveBrowserEnvironment, when the plan has no browser probe', () => {
  it('spawns nothing at all and passes resolution through unchanged', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    const { runner, runs } = fakeRunner([ok()]);

    const environment = await resolveBrowserEnvironment({
      projectRoot: project,
      plan: planWith([{ criterionId: 'E1-01', disposition: 'automated', probes: [HTTP_PROBE] }]),
      runner,
      env: {},
      platform: 'linux',
      homeDir: home,
    });

    // The unprovisioned machine is left exactly as unprovisioned as it was: no npm, no
    // download, and no cache directory brought into existence as a side effect.
    expect(runs).toHaveLength(0);
    expect(environment.source).toBe('absent');
    expect(environment.ready).toBe(false);
    expect(await readdir(home)).toEqual([]);
  });

  it('spawns nothing when there is no plan at all (`--no-ai` with nothing compiled)', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    const { runner, runs } = fakeRunner([ok()]);

    const environment = await resolveBrowserEnvironment({
      projectRoot: project,
      plan: undefined,
      runner,
      env: {},
      platform: 'linux',
      homeDir: home,
    });

    expect(runs).toHaveLength(0);
    expect(environment.source).toBe('absent');
  });
});

/* ── AC1: a run that needs a browser provisions one ────────────────────────────────── */

describe('resolveBrowserEnvironment, when the plan has a browser probe', () => {
  it('provisions into the SpecWitness cache and returns a ready environment', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    const cacheDir = join(home, '.cache', 'specwitness', 'playwright');
    const groups: number[] = [];

    const { runner, runs } = fakeRunner([ok({ pgid: 11 }), ok({ pgid: 22 })], async (call, run) => {
      if (call === 0) {
        await installFakePlaywright(cacheDir, '1.62.1');
      } else {
        await installFakeChromium(String(run.env.set?.['PLAYWRIGHT_BROWSERS_PATH']));
      }
    });

    const environment = await resolveBrowserEnvironment({
      projectRoot: project,
      plan: planWith([{ criterionId: 'E1-01', disposition: 'automated', probes: [BROWSER_PROBE] }]),
      runner,
      env: {},
      platform: 'linux',
      homeDir: home,
      onProcessGroup: (pgid) => {
        groups.push(pgid);
      },
    });

    expect(environment.ready).toBe(true);
    expect(environment.source).toBe('specwitness-cache');
    // `npm install @playwright/test@<pin>` then the chromium download. AD-3: a fixed binary
    // and a fixed argument array, never a shell string.
    expect(runs).toHaveLength(2);
    expect(runs[0]?.args.join(' ')).toContain(`${PLAYWRIGHT_PACKAGE}@`);
    expect(runs[1]?.args).toContain('chromium');
    // AD-8: every spawned group is recorded, or `specwitness clean` cannot reap a run killed
    // mid-download — which is minutes long and the likeliest moment for an operator to.
    expect(groups).toEqual([11, 22]);
    // The per-command budget the provisioning suite already uses. A default that timed out a
    // cold chromium fetch would report an InfraError for a download that was working.
    expect(runs[0]?.timeoutMs).toBe(PROVISION_TIMEOUT_MS);
  });

  it('spawns nothing when the environment is already ready (route 1)', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    await installFakePlaywright(project, '1.55.0');
    await installFakeChromium(join(home, '.cache', 'ms-playwright'));
    const { runner, runs } = fakeRunner([ok()]);

    const environment = await resolveBrowserEnvironment({
      projectRoot: project,
      plan: planWith([{ criterionId: 'E1-01', disposition: 'automated', probes: [BROWSER_PROBE] }]),
      runner,
      env: {},
      platform: 'linux',
      homeDir: home,
    });

    expect(environment.ready).toBe(true);
    expect(environment.source).toBe('project');
    expect(runs).toHaveLength(0);
  });
});

/* ── AC4: a project's own pinned Playwright still wins ─────────────────────────────── */

describe('resolveBrowserEnvironment, when the project has its own Playwright', () => {
  it('downloads only the browsers, at the project version, never into SpecWitness cache', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    await installFakePlaywright(project, '1.55.0');

    const { runner, runs } = fakeRunner([ok()], async (_call, run) => {
      await installFakeChromium(String(run.env.set?.['PLAYWRIGHT_BROWSERS_PATH']));
    });

    const environment = await resolveBrowserEnvironment({
      projectRoot: project,
      plan: planWith([{ criterionId: 'E1-01', disposition: 'automated', probes: [BROWSER_PROBE] }]),
      runner,
      env: {},
      platform: 'linux',
      homeDir: home,
    });

    expect(environment.source).toBe('project');
    expect(environment.version).toBe('1.55.0');
    // ONE spawn: the browser download. The package is the project's own and is not replaced
    // by SpecWitness's pin — honouring it is the whole reason the project route is preferred
    // (FR-24).
    expect(runs).toHaveLength(1);
    expect(runs[0]?.args).toContain('chromium');
    expect(runs.some((run) => run.args.some((arg) => arg.includes(`${PLAYWRIGHT_PACKAGE}@`)))).toBe(
      false,
    );
    // Never SpecWitness's cache, and never the project tree.
    const browsers = String(runs[0]?.env.set?.['PLAYWRIGHT_BROWSERS_PATH']);
    expect(browsers.startsWith(join(home, '.cache', 'specwitness'))).toBe(false);
    expect(relative(project, browsers).startsWith('..')).toBe(true);
  });
});

/* ── AC3: nothing is written into the target project ───────────────────────────────── */

/**
 * Every case below asserts the SAME two things, and the second is the one review changed.
 *
 * A failed provisioning does not throw out of this module: it returns an environment that is
 * NOT READY and carries the failure as its `reason`, so the run reaches the pipeline and the
 * refusal comes from the browser executor — exactly where an unusable environment was always
 * refused, and exactly as it was before `verify` provisioned anything. The auto-review's P1
 * is why: throwing here ends the command BEFORE `runPipeline`, so a run that had just
 * compiled a plan (a paid provider call, recorded in `planning.providerUsage`) wrote no
 * `result.json` at all — while `verify` had already printed "its provider usage is recorded
 * in the run document". Deferring the refusal by one stage boundary keeps that promise true.
 *
 * ⚠️ IT IS NOT A SKIP AND CANNOT BECOME ONE. `ready: false` reaches `#requireRuntime`, which
 * throws `InfraError` before any I/O (exit 3) — see `tests/unit/surfaces/browser-params.test.ts`
 * — and this environment is only ever built when the plan HAS a browser probe, so a probe
 * that must refuse always exists. The corpus fixture `browser-probe-provisions` pins the
 * whole chain through the real binary: exit 3, `infraError: infra`, no criterion reported.
 */
async function unusable(
  inputs: Parameters<typeof resolveBrowserEnvironment>[0],
): Promise<{ readonly reason: string }> {
  const environment = await resolveBrowserEnvironment(inputs);
  expect(
    environment.ready,
    'a failed provisioning must never hand back a usable environment',
  ).toBe(false);
  return { reason: environment.source === 'absent' ? environment.reason : '(not absent)' };
}

describe('resolveBrowserEnvironment, when the operator points the cache inside the project', () => {
  it('refuses, says why, and leaves the project tree byte-for-byte as it was', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    await writeFile(join(project, 'README.md'), '# target\n', 'utf8');
    const before = await treeOf(project);
    const { runner, runs } = fakeRunner([ok()]);

    const refusal = await unusable({
      projectRoot: project,
      plan: planWith([{ criterionId: 'E1-01', disposition: 'automated', probes: [BROWSER_PROBE] }]),
      runner,
      // Operator input, not authority: a browser bundle inside the repository under
      // verification would be damage done by the verifier.
      env: { PLAYWRIGHT_BROWSERS_PATH: join(project, '.browsers') },
      platform: 'linux',
      homeDir: home,
    });

    expect(refusal.reason).toContain('inside the target project');
    // The HINT survives into the reason. It names the variable that chose the path, which is
    // the only actionable half of this failure, and the executor's own refusal has no way to
    // reproduce it.
    expect(refusal.reason).toContain('PLAYWRIGHT_BROWSERS_PATH');
    // Refused BEFORE anything was spawned, and nothing landed under the project.
    expect(runs).toHaveLength(0);
    expect(await treeOf(project)).toEqual(before);
  });

  it('redacts the carried reason, because the paths in it are operator input', async () => {
    // ⚠️ THE REFUSAL QUOTES A PATH THE OPERATOR CHOSE, and an environment variable is
    // untrusted text: `PLAYWRIGHT_BROWSERS_PATH` can carry anything, including
    // credential-shaped material. The browser executor redacts before putting a reason in a
    // message, but story 7.0 added two NEW sinks that bypass it — the aggregate stage's
    // timeline detail, which is persisted inside `result.json`, and the edge's WARNING. So
    // the redaction happens where the text is captured rather than at each sink. Raised as a
    // P1 by the codex auto-review of this branch.
    //
    // Asserting the SECRET IS ABSENT rather than that a marker is present: Epic 3 retro §7.
    const project = await tempRoot();
    const home = await tempRoot();
    const { runner } = fakeRunner([ok()]);

    const refusal = await unusable({
      projectRoot: project,
      plan: planWith([{ criterionId: 'E1-01', disposition: 'automated', probes: [BROWSER_PROBE] }]),
      runner,
      env: { PLAYWRIGHT_BROWSERS_PATH: join(project, 'API_TOKEN=hunter2andsomemore') },
      platform: 'linux',
      homeDir: home,
    });

    expect(refusal.reason).not.toContain('hunter2andsomemore');
    // The refusal still SAYS what went wrong; redaction removes the value, not the sentence.
    expect(refusal.reason).toContain('inside the target project');
  });

  it('honours a project-declared redaction pattern, not only the built-in rules', async () => {
    // ⚠️ AD-10's EXTRA PATTERNS ARE THE HALF A BUILT-IN RULE CANNOT COVER: a project knows
    // the shape of its own secrets and the redactor does not. `redactText`'s second argument
    // is where they live (`domain/evidence.ts:134`), and the browser executor passes it
    // (`browser.ts:1148`). Capture-time redaction here has to take the same options, or the
    // MORE durable sink — the aggregate timeline detail, persisted inside `result.json` —
    // would be the less protected one.
    //
    // NOTE, and it is why this test supplies the pattern itself: nothing in production
    // produces `extraPatterns` today. There is no key for them in the Project Config schema
    // and `verify.ts` binds `redaction` nowhere, so the executor receives `undefined` as well.
    // This pins that the parameter is HONOURED when it exists, which is what makes the wiring
    // correct by construction the day that surface lands.
    const project = await tempRoot();
    const home = await tempRoot();
    const { runner } = fakeRunner([ok()]);

    const refusal = await unusable({
      projectRoot: project,
      plan: planWith([{ criterionId: 'E1-01', disposition: 'automated', probes: [BROWSER_PROBE] }]),
      runner,
      // A shape only this project could know about, matching nothing the built-ins look for.
      redaction: { extraPatterns: [/wombat-[a-z0-9]+/g] },
      env: { PLAYWRIGHT_BROWSERS_PATH: join(project, 'wombat-9fk2zz') },
      platform: 'linux',
      homeDir: home,
    });

    expect(refusal.reason).not.toContain('wombat-9fk2zz');
    expect(refusal.reason).toContain('inside the target project');
  });

  it('refuses when XDG_CACHE_HOME points into the project, for the same reason', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    const before = await treeOf(project);
    const { runner, runs } = fakeRunner([ok()]);

    const refusal = await unusable({
      projectRoot: project,
      plan: planWith([{ criterionId: 'E1-01', disposition: 'automated', probes: [BROWSER_PROBE] }]),
      runner,
      env: { XDG_CACHE_HOME: join(project, '.cache') },
      platform: 'linux',
      homeDir: home,
    });

    expect(refusal.reason).toContain('inside the target project');
    expect(runs).toHaveLength(0);
    expect(await treeOf(project)).toEqual(before);
  });
});

/* ── AC5: a provisioning failure is exit 3, never a skip and never a product FAIL ───── */

describe('resolveBrowserEnvironment, when provisioning fails', () => {
  it('carries what could not be done, and its hint, into the environment the run refuses on', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    const { runner } = fakeRunner([ok({ exitCode: 1, stderr: 'ENOTFOUND registry.npmjs.org' })]);

    const refusal = await unusable({
      projectRoot: project,
      plan: planWith([{ criterionId: 'E1-01', disposition: 'automated', probes: [BROWSER_PROBE] }]),
      runner,
      env: {},
      platform: 'linux',
      homeDir: home,
    });

    expect(refusal.reason).toContain(`installing ${PLAYWRIGHT_PACKAGE} into`);
    // The most actionable sentence in the whole failure, and it would be lost if only the
    // message survived: the executor's refusal quotes the reason and adds its own hint about
    // `doctor`, which says nothing about a proxy or a registry.
    expect(refusal.reason).toContain('network');
  });

  it('carries an absent npm the same way, never a silently browser-free run', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    const { runner } = fakeRunner([ok({ outcome: 'not-found', exitCode: null, pgid: null })]);

    const refusal = await unusable({
      projectRoot: project,
      plan: planWith([{ criterionId: 'E1-01', disposition: 'automated', probes: [BROWSER_PROBE] }]),
      runner,
      env: {},
      platform: 'linux',
      homeDir: home,
    });

    expect(refusal.reason).toContain('not on PATH');
  });

  it('lets an onProcessGroup failure stay fatal, because that is durability and not diagnosis', async () => {
    // ⚠️ NOT EVERY `InfraError` OUT OF PROVISIONING IS A PROVISIONING DIAGNOSIS. AD-8 wires
    // `RunStore.recordProcessGroup` into every spawn, and `ProcessRunner` deliberately kills
    // the child and RETHROWS a recording failure unchanged rather than flattening it into a
    // subprocess outcome (`src/infra/process-runner.ts:719-723`). That error is the run
    // losing its ability to record a process group — the thing `specwitness clean` needs to
    // reap a killed download — and downgrading it to "the browser is unavailable" would let
    // the pipeline carry on and, behind a failing gate, exit 1 with a durability failure
    // nobody ever hears about. Raised as a P2 by the codex review of this branch.
    const project = await tempRoot();
    const home = await tempRoot();
    const { runner } = fakeRunner([ok({ pgid: 4242 })]);

    const failure = await resolveBrowserEnvironment({
      projectRoot: project,
      plan: planWith([{ criterionId: 'E1-01', disposition: 'automated', probes: [BROWSER_PROBE] }]),
      runner,
      onProcessGroup: () => {
        // Exactly what `RunStore.recordProcessGroup` raises when the manifest cannot be
        // written: an InfraError, indistinguishable by TYPE from a provisioning refusal.
        throw new InfraError('could not record process group 4242', 'check the run directory');
      },
      env: {},
      platform: 'linux',
      homeDir: home,
    }).then(
      () => 'RESOLVED',
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(InfraError);
    expect((failure as InfraError).message).toContain('could not record process group');
  });

  it('treats a STALLED recording hook as fatal too, not only a rejected one', async () => {
    // ⚠️ THE HOOK NEED NOT REJECT TO HAVE FAILED. If `onProcessGroup` never settles,
    // `ProcessRunner` does not throw — its per-command timeout fires, it terminates the group,
    // and it RETURNS a `timed-out` result. `provisionPlaywright` then classifies that as an
    // ordinary `InfraError`, indistinguishable from "the registry was unreachable", and the
    // catch below would downgrade it to an absent browser: behind a failing gate the run would
    // exit 1 while the durability hook that `specwitness clean` depends on had hung. Raised as
    // a P2 by the codex review of this branch, one notch finer than the rejected-hook case.
    const project = await tempRoot();
    const home = await tempRoot();
    const runner = {
      async run(options: ProcessRunOptions): Promise<ProcessResult> {
        // Started and never settled — exactly what a wedged `RunStore` write looks like from
        // here — and then the command times out, as the real runner would report it.
        void options.onProcessGroup?.(4242);
        await Promise.resolve();
        return ok({ outcome: 'timed-out', exitCode: null });
      },
    };

    const failure = await resolveBrowserEnvironment({
      projectRoot: project,
      plan: planWith([{ criterionId: 'E1-01', disposition: 'automated', probes: [BROWSER_PROBE] }]),
      runner,
      onProcessGroup: () => new Promise<void>(() => {}),
      env: {},
      platform: 'linux',
      homeDir: home,
    }).then(
      () => 'RESOLVED',
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(InfraError);
  });

  it('lets a non-InfraError through untouched, because only a diagnosed failure may be downgraded', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    const runner = {
      run(): Promise<ProcessResult> {
        // A programming error, not an environment one. Turning THIS into "the browser
        // environment is unusable" would bury a defect in this product inside a message
        // about the operator's machine.
        return Promise.reject(new TypeError('runner exploded'));
      },
    };

    await expect(
      resolveBrowserEnvironment({
        projectRoot: project,
        plan: planWith([
          { criterionId: 'E1-01', disposition: 'automated', probes: [BROWSER_PROBE] },
        ]),
        runner,
        env: {},
        platform: 'linux',
        homeDir: home,
      }),
    ).rejects.toThrow(TypeError);
  });
});

/* ── the auto-review's P2: provisioning for a probe the config cannot serve ─────────── */

describe('resolveBrowserEnvironment, when a browser probe names a service the config lost', () => {
  it('does not provision for it — the run will fail on the config, and a download cannot help', async () => {
    // A PERSISTED plan is checked against its contract but NOT against the declared config
    // ids: `planDraftSchemaFor` applies that check to a DRAFT during compilation only
    // (`src/schemas/plan.ts`), so a plan that was valid when compiled and whose service was
    // later removed from `config.yaml` reaches execution intact. Provisioning for it would
    // download hundreds of megabytes only to reject the plan at dispatch — and on an offline
    // machine it would report a provisioning failure for what is really a config error.
    // Raised by the codex auto-review of this branch.
    const project = await tempRoot();
    const home = await tempRoot();
    const { runner, runs } = fakeRunner([ok()]);

    const environment = await resolveBrowserEnvironment({
      projectRoot: project,
      plan: planWith([{ criterionId: 'E1-01', disposition: 'automated', probes: [BROWSER_PROBE] }]),
      // `BROWSER_PROBE` names service `app`; this project declares none.
      declaredServiceIds: [],
      runner,
      env: {},
      platform: 'linux',
      homeDir: home,
    });

    expect(runs).toHaveLength(0);
    expect(environment.source).toBe('absent');
    expect(await readdir(home)).toEqual([]);
  });

  it('still provisions when at least ONE browser probe names a declared service', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    const cacheDir = join(home, '.cache', 'specwitness', 'playwright');
    const { runner, runs } = fakeRunner([ok(), ok()], async (call, run) => {
      if (call === 0) {
        await installFakePlaywright(cacheDir, '1.62.1');
      } else {
        await installFakeChromium(String(run.env.set?.['PLAYWRIGHT_BROWSERS_PATH']));
      }
    });

    const environment = await resolveBrowserEnvironment({
      projectRoot: project,
      plan: planWith([
        {
          criterionId: 'E1-01',
          disposition: 'automated',
          probes: [
            {
              ...BROWSER_PROBE,
              id: 'P0',
              mechanics: { ...BROWSER_PROBE.mechanics, serviceId: 'gone' },
            },
            BROWSER_PROBE,
          ],
        },
      ]),
      declaredServiceIds: ['app'],
      runner,
      env: {},
      platform: 'linux',
      homeDir: home,
    });

    expect(environment.ready).toBe(true);
    expect(runs).toHaveLength(2);
  });

  it('provisions when the caller declares nothing about services, because absence is not a claim', async () => {
    // `declaredServiceIds` is OPTIONAL. Omitting it means "I am not telling you which services
    // exist", which must behave exactly as it did before rather than as "none exist" —
    // otherwise every caller that does not pass it silently stops provisioning.
    const project = await tempRoot();
    const home = await tempRoot();
    const { runner, runs } = fakeRunner([ok({ outcome: 'not-found', exitCode: null, pgid: null })]);

    await unusable({
      projectRoot: project,
      plan: planWith([{ criterionId: 'E1-01', disposition: 'automated', probes: [BROWSER_PROBE] }]),
      runner,
      env: {},
      platform: 'linux',
      homeDir: home,
    });

    expect(runs).toHaveLength(1);
  });
});

/* ── which failures the edge still has to SAY out loud ─────────────────────────────── */

describe('shouldReportUnavailableBrowser', () => {
  const reason = 'installing @playwright/test into /cache failed (exit 1): no network';

  it('is false when no browser was needed, or one was obtained', () => {
    expect(shouldReportUnavailableBrowser(undefined, undefined)).toBe(false);
    expect(shouldReportUnavailableBrowser(undefined, 'infra: services stage failed')).toBe(false);
  });

  it('is true when the run reached a verdict, because nothing else mentions the browser', () => {
    // The gate-failure path: `aggregate` ran, the verdict is the gate's, and the operator has
    // to be told that this machine cannot run browser probes at all.
    expect(shouldReportUnavailableBrowser(reason, undefined)).toBe(true);
  });

  it('is true when ANOTHER infra stage ended the run first', () => {
    // ⚠️ THE CASE THE FIRST VERSION MISSED. Provisioning fails, then the worktree, setup or
    // services stage throws — `runPipeline` skips both `probes` and `aggregate`, so the
    // timeline detail that carries the diagnosis never happens, and gating the warning on
    // "the run reached a verdict" suppressed it as well. The provisioning failure then
    // disappeared from BOTH channels. Raised as a P2 by the codex review of this branch.
    expect(
      shouldReportUnavailableBrowser(reason, "infra: service 'app' exited before it became ready"),
    ).toBe(true);
  });

  it('is false when the reported failure IS the browser refusal, which already quotes it', () => {
    // The executor's own `InfraError` names the reason verbatim, and `reportInfraFailure`
    // prints it. Saying it again would be noise on the one path that is already loud.
    expect(
      shouldReportUnavailableBrowser(reason, `infra: browser probe for E7-01 cannot run: ${reason}`),
    ).toBe(false);
  });
});
