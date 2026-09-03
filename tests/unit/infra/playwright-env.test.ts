/**
 * Story 5.1 — Playwright environment resolution and provisioning.
 *
 * ⚠️ THIS SUITE NEVER DOWNLOADS A BROWSER, and it never spawns anything at all.
 * The auto-review runs `pnpm test` concurrently in a second copy of this
 * worktree (harness defect H-8), and a Playwright download is the most
 * expensive thing anyone could put in that path. Provisioning is exercised
 * against an injected `ProcessRunner` fake and fixture directories; the real
 * `npm install` / `playwright install` invocations are asserted as ARGUMENTS,
 * never executed. If a later story genuinely needs a real browser, that test is
 * opt-in behind an env flag and says so loudly — it does not get added here.
 *
 * ⚠️ A SKIPPED TEST AND A SKIPPED CRITERION ARE DIFFERENT THINGS. Epic 4 retro
 * §2 observation 2: twice now a criterion nobody could adjudicate reported PASS,
 * because every new way for a criterion to produce no attempts is a new way to
 * reach green-for-nothing. "Playwright is absent or refuses to provision" is
 * exactly such a way, and the production code under test HAS NO SKIP PATH AT
 * ALL: an unavailable browser environment is `InfraError` (exit 3), never a
 * skip, never a pass, never a silently absent probe. Nothing in this file is
 * a licence to make the executor skip to match a test that skipped.
 *
 * Every fixture is a real directory under `os.tmpdir()`, removed in `finally`.
 * Nothing is written inside the repository and no port is bound, so a
 * concurrent copy of this suite cannot collide with it.
 */

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { InfraError } from '../../../src/domain/errors.js';
import type { ProcessResult, ProcessRunOptions } from '../../../src/domain/process-runner.js';
import {
  PLAYWRIGHT_PACKAGE,
  provisionPlaywright,
  resolvePlaywrightEnvironment,
  specwitnessPlaywrightCacheDir,
  type PlaywrightEnvironmentInputs,
} from '../../../src/infra/playwright-env.js';

/* ── fixtures ──────────────────────────────────────────────────────────────── */

async function tempRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'specwitness-pw-'));
}

/**
 * Writes a fake `@playwright/test` into `<dir>/node_modules`.
 *
 * A real package layout, not a stub the resolver is taught to accept: the
 * production code uses Node's own `require.resolve`, so anything less than a
 * resolvable `package.json` + entry point would prove nothing.
 */
async function installFakePlaywright(dir: string, version: string): Promise<string> {
  const packageDir = join(dir, 'node_modules', PLAYWRIGHT_PACKAGE);
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: PLAYWRIGHT_PACKAGE, version, main: 'index.js' }),
    'utf8',
  );
  await writeFile(join(packageDir, 'index.js'), 'module.exports = {};\n', 'utf8');
  return packageDir;
}

/** A browser registry directory with one downloaded chromium bundle in it. */
async function installFakeChromium(browsersPath: string): Promise<void> {
  await mkdir(join(browsersPath, 'chromium-1200'), { recursive: true });
}

const LINUX: Pick<PlaywrightEnvironmentInputs, 'platform' | 'homeDir'> = {
  platform: 'linux',
  homeDir: '/home/dev',
};

/** Inputs with a deliberately EMPTY environment, so no developer's real
 *  `PLAYWRIGHT_BROWSERS_PATH` can change a test result. */
function inputs(
  projectRoot: string,
  overrides: Partial<PlaywrightEnvironmentInputs> = {},
): PlaywrightEnvironmentInputs {
  return { projectRoot, env: {}, ...LINUX, ...overrides };
}

/* ── the cache directory ───────────────────────────────────────────────────── */

describe('specwitnessPlaywrightCacheDir', () => {
  it('honours PLAYWRIGHT_BROWSERS_PATH when the operator sets one', () => {
    const dir = specwitnessPlaywrightCacheDir({
      env: { PLAYWRIGHT_BROWSERS_PATH: '/opt/browsers' },
      platform: 'linux',
      homeDir: '/home/dev',
    });

    expect(dir.browsersPath).toBe('/opt/browsers');
    expect(dir.browsersPathFromEnv).toBe(true);
  });

  it('uses XDG_CACHE_HOME on Linux when it is set', () => {
    const dir = specwitnessPlaywrightCacheDir({
      env: { XDG_CACHE_HOME: '/var/cache/me' },
      platform: 'linux',
      homeDir: '/home/dev',
    });

    expect(dir.cacheDir).toBe('/var/cache/me/specwitness/playwright');
  });

  it('falls back to ~/.cache on Linux and ~/Library/Caches on macOS', () => {
    expect(specwitnessPlaywrightCacheDir({ env: {}, platform: 'linux', homeDir: '/home/dev' }).cacheDir).toBe(
      '/home/dev/.cache/specwitness/playwright',
    );
    expect(specwitnessPlaywrightCacheDir({ env: {}, platform: 'darwin', homeDir: '/Users/dev' }).cacheDir).toBe(
      '/Users/dev/Library/Caches/specwitness/playwright',
    );
  });

  it('puts browsers under the cache, not beside it, when no override is set', () => {
    const dir = specwitnessPlaywrightCacheDir({ env: {}, platform: 'linux', homeDir: '/home/dev' });

    expect(dir.browsersPath).toBe(join(dir.cacheDir, 'browsers'));
    expect(dir.browsersPathFromEnv).toBe(false);
  });

  /**
   * ASSERTED AS A PATH RELATIONSHIP, not eyeballed. AC1 forbids provisioning
   * into the target tree outright: a repository that gained a `node_modules`
   * because it was verified has been damaged by its verifier.
   */
  it('never lands inside the target project, the worktree or .specwitness, at any depth', () => {
    const projects = [
      '/home/dev/app',
      '/home/dev/.cache/specwitness/playwright/pretend-project',
      '/home/dev/a/b/c/d/e/f/deeply/nested/project',
      '/',
    ];

    for (const projectRoot of projects) {
      const { cacheDir, browsersPath } = specwitnessPlaywrightCacheDir({
        env: {},
        platform: 'linux',
        homeDir: '/home/dev',
      });

      for (const owned of [cacheDir, browsersPath]) {
        const insideProject = relative(resolve(projectRoot), resolve(owned));
        const escapes = insideProject.startsWith('..') || insideProject === '';
        // `/` contains everything, so it is asserted the other way round: the
        // cache must at least never be under a `.specwitness` run directory.
        if (projectRoot !== '/') {
          expect(escapes, `${owned} must not be under ${projectRoot}`).toBe(true);
        }
        expect(owned.split(sep)).not.toContain('.specwitness');
      }
    }
  });
});

/* ── resolution ────────────────────────────────────────────────────────────── */

describe('resolvePlaywrightEnvironment', () => {
  it('reports the project installation when the project has its own', async () => {
    const project = await tempRoot();
    try {
      const packageDir = await installFakePlaywright(project, '1.44.0');

      const env = await resolvePlaywrightEnvironment(inputs(project));

      expect(env.source).toBe('project');
      expect(env.version).toBe('1.44.0');
      if (env.source === 'absent') {
        throw new Error('unreachable');
      }
      // Compared on realpaths: on macOS `os.tmpdir()` is `/var/folders/...`
      // while Node's own resolution answers `/private/var/folders/...`, and the
      // resolver reports what resolution actually found.
      expect(env.packageDir).toBe(await realpath(packageDir));
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it('reports absent for a project that has none, even though THIS repository has one', async () => {
    const project = await tempRoot();
    try {
      const env = await resolvePlaywrightEnvironment(inputs(project));

      expect(env.source).toBe('absent');
      if (env.source !== 'absent') {
        throw new Error('unreachable');
      }
      expect(env.reason).toMatch(/does not resolve/i);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  /**
   * THE HOISTING HAZARD, exercised against the real repository.
   *
   * `tests/` has no `node_modules` of its own, so Node's upward walk finds
   * SpecWitness's own `@playwright/test` — added by THIS story. A resolver that
   * merely asked "does it resolve?" would report this directory as a provisioned
   * project. It is not one, and reporting it as ready is the one way this
   * story's own dependency addition can silently corrupt a merged diagnostic.
   */
  it('does not let SpecWitness’s own dependency make an outside directory look provisioned', async () => {
    const notAProject = join(process.cwd(), 'tests');

    const env = await resolvePlaywrightEnvironment(inputs(notAProject));

    expect(env.source).toBe('absent');
    if (env.source !== 'absent') {
      throw new Error('unreachable');
    }
    expect(env.reason).toMatch(/outside/i);
  });

  it('reports absent when the package resolves only from a directory ABOVE the project root', async () => {
    const outer = await tempRoot();
    try {
      await installFakePlaywright(outer, '1.44.0');
      const project = join(outer, 'packages', 'app');
      await mkdir(project, { recursive: true });

      const env = await resolvePlaywrightEnvironment(inputs(project));

      expect(env.source).toBe('absent');
      if (env.source !== 'absent') {
        throw new Error('unreachable');
      }
      expect(env.reason).toContain(await realpath(outer));
    } finally {
      await rm(outer, { recursive: true, force: true });
    }
  });

  it('falls back to the SpecWitness cache when the project has none', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      const cacheDir = join(home, '.cache', 'specwitness', 'playwright');
      await installFakePlaywright(cacheDir, '1.62.1');

      const env = await resolvePlaywrightEnvironment(inputs(project, { homeDir: home }));

      expect(env.source).toBe('specwitness-cache');
      expect(env.version).toBe('1.62.1');
      expect(env.cacheDir).toBe(cacheDir);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it('prefers the project over the cache when both are installed', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      await installFakePlaywright(project, '1.30.0');
      await installFakePlaywright(join(home, '.cache', 'specwitness', 'playwright'), '1.62.1');

      const env = await resolvePlaywrightEnvironment(inputs(project, { homeDir: home }));

      expect(env.source).toBe('project');
      expect(env.version).toBe('1.30.0');
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  /**
   * A resolvable package with no downloaded browser is a real and common state.
   * Reporting it as ready would make doctor green immediately before a run
   * fails, which is the same green-for-nothing shape as a skipped criterion.
   */
  it('reports a resolvable package with no downloaded browser as present-but-unprovisioned', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      await installFakePlaywright(project, '1.44.0');

      const env = await resolvePlaywrightEnvironment(inputs(project, { homeDir: home }));

      expect(env.source).toBe('project');
      expect(env.browsersPresent).toBe(false);
      expect(env.ready).toBe(false);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it('reports ready when the package resolves and a chromium bundle is downloaded', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      await installFakePlaywright(project, '1.44.0');
      await installFakeChromium(join(home, '.cache', 'ms-playwright'));

      const env = await resolvePlaywrightEnvironment(inputs(project, { homeDir: home }));

      expect(env.browsersPresent).toBe(true);
      expect(env.ready).toBe(true);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it('looks for browsers under PLAYWRIGHT_BROWSERS_PATH when the operator sets it', async () => {
    const project = await tempRoot();
    const browsers = await tempRoot();
    try {
      await installFakePlaywright(project, '1.44.0');
      await installFakeChromium(browsers);

      const env = await resolvePlaywrightEnvironment(
        inputs(project, { env: { PLAYWRIGHT_BROWSERS_PATH: browsers } }),
      );

      expect(env.browsersPath).toBe(browsers);
      expect(env.browsersPresent).toBe(true);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(browsers, { recursive: true, force: true });
    }
  });

  it('reports browsers as absent — never present — when it cannot tell', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      await installFakePlaywright(project, '1.44.0');
      // `0` asks Playwright to keep browsers inside its own package. We do not
      // guess; fail-closed means "not present", which costs one extra hint and
      // can never make doctor green over a machine that cannot open a browser.
      const env = await resolvePlaywrightEnvironment(
        inputs(project, { env: { PLAYWRIGHT_BROWSERS_PATH: '0' }, homeDir: home }),
      );

      expect(env.browsersPresent).toBe(false);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});

/* ── provisioning ──────────────────────────────────────────────────────────── */

interface RecordedRun {
  readonly options: ProcessRunOptions;
}

/**
 * `effect` is what makes these tests honest without downloading anything: the
 * real `playwright install` leaves a browser bundle on disk, so the fake is
 * given the chance to leave one too. Without it, provisioning would be asserted
 * against a runner that reports success and changes nothing — which is exactly
 * the green-for-nothing shape this story exists to keep out of Epic 5.
 */
function fakeRunner(
  results: readonly ProcessResult[],
  effect?: (call: number, options: ProcessRunOptions) => Promise<void>,
): {
  readonly runner: { run(options: ProcessRunOptions): Promise<ProcessResult> };
  readonly runs: RecordedRun[];
} {
  const runs: RecordedRun[] = [];
  let next = 0;
  return {
    runs,
    runner: {
      async run(options: ProcessRunOptions): Promise<ProcessResult> {
        const call = next;
        runs.push({ options });
        const result = results[next] ?? results.at(-1);
        next += 1;
        if (result === undefined) {
          throw new Error('fake runner has no result configured');
        }
        await effect?.(call, options);
        // The real runner ALWAYS reports a pgid and awaits the caller's hook
        // before the run proceeds (AD-8). The fake does the same, or a test
        // could pass against code that never wired `onProcessGroup`.
        if (result.pgid != null) {
          await options.onProcessGroup?.(result.pgid);
        }
        return result;
      },
    },
  };
}

function ok(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    outcome: 'completed',
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 1,
    pgid: 4242,
    ...overrides,
  };
}

/**
 * Await a provisioning call that MUST fail, and hand back the typed error.
 *
 * Written as a helper rather than inline `.catch(x as InfraError)` so that a
 * call which wrongly SUCCEEDS fails the test loudly here, instead of quietly
 * type-asserting a resolved environment into an error shape — the exact way a
 * guard stops being a guard.
 */
async function expectInfraError(promise: Promise<unknown>): Promise<InfraError> {
  let resolved = false;
  try {
    await promise;
    resolved = true;
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(InfraError);
    return thrown as InfraError;
  }
  if (resolved) {
    throw new Error('expected provisioning to fail with an InfraError, but it succeeded');
  }
  throw new Error('unreachable');
}

describe('provisionPlaywright', () => {
  it('installs the package and chromium into the SpecWitness cache, never the project', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      const cacheDir = join(home, '.cache', 'specwitness', 'playwright');
      const { runner, runs } = fakeRunner([ok(), ok()], async (call, run) => {
        // Call 0 is `npm install`; call 1 is the browser download. Each leaves
        // behind what the real command would have left behind.
        if (call === 0) {
          await installFakePlaywright(cacheDir, '1.62.1');
        } else {
          await installFakeChromium(String(run.env.set?.['PLAYWRIGHT_BROWSERS_PATH']));
        }
      });

      const env = await provisionPlaywright({
        projectRoot: project,
        runner,
        env: {},
        platform: 'linux',
        homeDir: home,
        timeoutMs: 1_000,
      });

      expect(env.source).toBe('specwitness-cache');
      expect(runs).toHaveLength(2);
      for (const run of runs) {
        expect(run.options.cwd.startsWith(cacheDir)).toBe(true);
        const insideProject = relative(project, run.options.cwd);
        expect(insideProject.startsWith('..')).toBe(true);
        // AD-3: a fixed binary plus a fixed argument array. Never a shell string.
        expect(typeof run.options.binary).toBe('string');
        expect(Array.isArray(run.options.args)).toBe(true);
      }
      expect(runs[0]?.options.args.join(' ')).toContain(`${PLAYWRIGHT_PACKAGE}@`);
      expect(runs[1]?.options.args).toContain('chromium');
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it('records every spawned process group so `specwitness clean` can reap it', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      const cacheDir = join(home, '.cache', 'specwitness', 'playwright');
      const { runner } = fakeRunner([ok({ pgid: 111 }), ok({ pgid: 222 })], async (call, run) => {
        if (call === 0) {
          await installFakePlaywright(cacheDir, '1.62.1');
        } else {
          await installFakeChromium(String(run.env.set?.['PLAYWRIGHT_BROWSERS_PATH']));
        }
      });
      const groups: number[] = [];

      await provisionPlaywright({
        projectRoot: project,
        runner,
        env: {},
        platform: 'linux',
        homeDir: home,
        timeoutMs: 1_000,
        onProcessGroup: (pgid) => {
          groups.push(pgid);
        },
      });

      expect(groups).toEqual([111, 222]);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it('installs the browsers into the cache by setting PLAYWRIGHT_BROWSERS_PATH for the child', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      const cacheDir = join(home, '.cache', 'specwitness', 'playwright');
      const { runner, runs } = fakeRunner([ok(), ok()], async (call, run) => {
        if (call === 0) {
          await installFakePlaywright(cacheDir, '1.62.1');
        } else {
          await installFakeChromium(String(run.env.set?.['PLAYWRIGHT_BROWSERS_PATH']));
        }
      });

      await provisionPlaywright({
        projectRoot: project,
        runner,
        env: {},
        platform: 'linux',
        homeDir: home,
        timeoutMs: 1_000,
      });

      expect(runs[1]?.options.env.set?.['PLAYWRIGHT_BROWSERS_PATH']).toBe(join(cacheDir, 'browsers'));
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  /**
   * ⚠️ THE STANDING HAZARD. An unavailable browser environment is exit 3, and
   * never "no browser probes ran". This test is the guard on that.
   */
  it('raises InfraError with ERROR/HINT material when the network is unreachable', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      const { runner } = fakeRunner([
        ok({
          exitCode: 1,
          stderr: 'npm error code ENOTFOUND\nnpm error request to https://registry.npmjs.org failed',
        }),
      ]);

      await expect(
        provisionPlaywright({
          projectRoot: project,
          runner,
          env: {},
          platform: 'linux',
          homeDir: home,
          timeoutMs: 1_000,
        }),
      ).rejects.toBeInstanceOf(InfraError);

      const error = await expectInfraError(
        provisionPlaywright({
        projectRoot: project,
        runner: fakeRunner([ok({ exitCode: 1, stderr: 'ENOTFOUND registry.npmjs.org' })]).runner,
        env: {},
        platform: 'linux',
        homeDir: home,
        timeoutMs: 1_000,
        }),
      );

      expect(error.message).toContain(PLAYWRIGHT_PACKAGE);
      expect(error.message).toContain('ENOTFOUND');
      expect(error.hint).toBeDefined();
      expect(error.hint).toMatch(/network|offline|registry/i);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it('raises InfraError naming the missing tool when npm is not on PATH', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      const { runner } = fakeRunner([ok({ outcome: 'not-found', exitCode: null, pgid: null })]);

      const error = await expectInfraError(
        provisionPlaywright({
        projectRoot: project,
        runner,
        env: {},
        platform: 'linux',
        homeDir: home,
        timeoutMs: 1_000,
        }),
      );

      expect(error).toBeInstanceOf(InfraError);
      expect(error.message).toMatch(/npm/);
      expect(error.hint).toMatch(/install/i);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it('raises InfraError on a timeout rather than reporting a usable environment', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      const { runner } = fakeRunner([ok({ outcome: 'timed-out', exitCode: null })]);

      const error = await expectInfraError(
        provisionPlaywright({
        projectRoot: project,
        runner,
        env: {},
        platform: 'linux',
        homeDir: home,
        timeoutMs: 1_000,
        }),
      );

      expect(error).toBeInstanceOf(InfraError);
      expect(error.message).toMatch(/timed out/i);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it('refuses, loudly, when the install appears to succeed but nothing resolves afterwards', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      const { runner } = fakeRunner([ok(), ok()]);

      // No package planted: both commands "succeeded" and the cache is empty.
      const error = await expectInfraError(
        provisionPlaywright({
        projectRoot: project,
        runner,
        env: {},
        platform: 'linux',
        homeDir: home,
        timeoutMs: 1_000,
        }),
      );

      expect(error).toBeInstanceOf(InfraError);
      expect(error.message).toMatch(/did not resolve|not resolve/i);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it('refuses to provision when PLAYWRIGHT_BROWSERS_PATH is 0, explaining why', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      const { runner, runs } = fakeRunner([ok(), ok()]);

      const error = await expectInfraError(
        provisionPlaywright({
        projectRoot: project,
        runner,
        env: { PLAYWRIGHT_BROWSERS_PATH: '0' },
        platform: 'linux',
        homeDir: home,
        timeoutMs: 1_000,
        }),
      );

      expect(error).toBeInstanceOf(InfraError);
      expect(error.message).toContain('PLAYWRIGHT_BROWSERS_PATH');
      expect(runs).toHaveLength(0);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it('downloads only the browsers when the project has its own Playwright, and never into the project tree', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      const cacheDir = join(home, '.cache', 'specwitness', 'playwright');
      await installFakePlaywright(project, '1.30.0');
      const { runner, runs } = fakeRunner([ok()], async (_call, run) => {
        await installFakeChromium(String(run.env.set?.['PLAYWRIGHT_BROWSERS_PATH']));
      });

      const env = await provisionPlaywright({
        projectRoot: project,
        runner,
        env: {},
        platform: 'linux',
        homeDir: home,
        timeoutMs: 1_000,
      });

      // Their pinned version is honoured: nothing installs a second copy.
      expect(env.source).toBe('project');
      expect(env.version).toBe('1.30.0');
      expect(runs).toHaveLength(1);
      expect(runs[0]?.options.args).toContain('chromium');

      // The bundle goes to the project's Playwright's OWN registry — a user
      // cache — and neither into the project tree nor into SpecWitness's cache.
      const browsersPath = String(runs[0]?.options.env.set?.['PLAYWRIGHT_BROWSERS_PATH']);
      expect(browsersPath).toBe(join(home, '.cache', 'ms-playwright'));
      expect(relative(project, browsersPath).startsWith('..')).toBe(true);
      expect(relative(cacheDir, browsersPath).startsWith('..')).toBe(true);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it('does not reinstall when the project already has a ready installation', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      const { runner, runs } = fakeRunner([ok()]);
      await installFakePlaywright(project, '1.44.0');
      await installFakeChromium(join(home, '.cache', 'ms-playwright'));

      const env = await provisionPlaywright({
        projectRoot: project,
        runner,
        env: {},
        platform: 'linux',
        homeDir: home,
        timeoutMs: 1_000,
      });

      expect(env.source).toBe('project');
      expect(runs).toHaveLength(0);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
