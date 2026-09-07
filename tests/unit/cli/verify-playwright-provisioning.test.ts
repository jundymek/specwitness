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

describe('resolveBrowserEnvironment, when the operator points the cache inside the project', () => {
  it('refuses with an InfraError and leaves the project tree byte-for-byte as it was', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    await writeFile(join(project, 'README.md'), '# target\n', 'utf8');
    const before = await treeOf(project);
    const { runner, runs } = fakeRunner([ok()]);

    const failure = await resolveBrowserEnvironment({
      projectRoot: project,
      plan: planWith([{ criterionId: 'E1-01', disposition: 'automated', probes: [BROWSER_PROBE] }]),
      runner,
      // Operator input, not authority: a browser bundle inside the repository under
      // verification would be damage done by the verifier.
      env: { PLAYWRIGHT_BROWSERS_PATH: join(project, '.browsers') },
      platform: 'linux',
      homeDir: home,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(InfraError);
    expect((failure as InfraError).message).toContain('inside the target project');
    // Refused BEFORE anything was spawned, and nothing landed under the project.
    expect(runs).toHaveLength(0);
    expect(await treeOf(project)).toEqual(before);
  });

  it('refuses when XDG_CACHE_HOME points into the project, for the same reason', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    const before = await treeOf(project);
    const { runner, runs } = fakeRunner([ok()]);

    const failure = await resolveBrowserEnvironment({
      projectRoot: project,
      plan: planWith([{ criterionId: 'E1-01', disposition: 'automated', probes: [BROWSER_PROBE] }]),
      runner,
      env: { XDG_CACHE_HOME: join(project, '.cache') },
      platform: 'linux',
      homeDir: home,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(InfraError);
    expect(runs).toHaveLength(0);
    expect(await treeOf(project)).toEqual(before);
  });
});

/* ── AC5: provisioning failure is InfraError, never a skip and never a product FAIL ─── */

describe('resolveBrowserEnvironment, when provisioning fails', () => {
  it('raises an InfraError naming what could not be done, rather than an unusable environment', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    const { runner } = fakeRunner([ok({ exitCode: 1, stderr: 'ENOTFOUND registry.npmjs.org' })]);

    const failure = await resolveBrowserEnvironment({
      projectRoot: project,
      plan: planWith([{ criterionId: 'E1-01', disposition: 'automated', probes: [BROWSER_PROBE] }]),
      runner,
      env: {},
      platform: 'linux',
      homeDir: home,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(InfraError);
    expect((failure as InfraError).message).toContain(`installing ${PLAYWRIGHT_PACKAGE} into`);
    expect((failure as InfraError).hint).toContain('network');
  });

  it('raises an InfraError when npm is not on PATH, never a silently browser-free run', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    const { runner } = fakeRunner([ok({ outcome: 'not-found', exitCode: null, pgid: null })]);

    const failure = await resolveBrowserEnvironment({
      projectRoot: project,
      plan: planWith([{ criterionId: 'E1-01', disposition: 'automated', probes: [BROWSER_PROBE] }]),
      runner,
      env: {},
      platform: 'linux',
      homeDir: home,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(InfraError);
    expect((failure as InfraError).message).toContain('not on PATH');
  });
});
