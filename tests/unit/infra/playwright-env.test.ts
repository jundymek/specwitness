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
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { InfraError } from '../../../src/domain/errors.js';
import type { ProcessResult, ProcessRunOptions } from '../../../src/domain/process-runner.js';
import {
  PLAYWRIGHT_PACKAGE,
  PROVISIONED_PLAYWRIGHT_VERSION,
  provisionPlaywright,
  resolvePlaywrightEnvironment,
  specwitnessPlaywrightCacheDir,
  type PlaywrightEnvironmentInputs,
} from '../../../src/infra/playwright-env.js';

/* ── fixtures ──────────────────────────────────────────────────────────────── */

async function tempRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'specwitness-pw-'));
}

/** The chromium revision every fixture Playwright below requires. */
const FIXTURE_REVISION = '1234';

/**
 * Writes a fake `@playwright/test` into `<dir>/node_modules`, beside the
 * `playwright-core` that carries the browser revision table.
 *
 * A real package layout, not a stub the resolver is taught to accept: the
 * production code uses Node's own `require.resolve` and reads
 * `playwright-core/browsers.json` exactly as `playwright install` does, so
 * anything less than a resolvable pair would prove nothing.
 */
async function installFakePlaywright(
  dir: string,
  version: string,
  revision: string = FIXTURE_REVISION,
  /**
   * `'modern'` declares `chromium` + `chromium-headless-shell`, as current
   * releases do. `'legacy'` declares `chromium` alone, as releases predating
   * the headless-shell bundle legitimately do — the shape that made a
   * hard-coded requirement list reject a correctly provisioned project.
   */
  manifest: 'modern' | 'legacy' = 'modern',
): Promise<string> {
  const modules = join(dir, 'node_modules');
  const packageDir = join(modules, PLAYWRIGHT_PACKAGE);
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: PLAYWRIGHT_PACKAGE,
      version,
      main: 'index.js',
      // The real shape: npm's map form, which is what `@playwright/test` uses.
      bin: { playwright: 'cli.js' },
    }),
    'utf8',
  );
  await writeFile(join(packageDir, 'index.js'), 'module.exports = {};\n', 'utf8');

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
        { name: 'chromium', revision, installByDefault: true },
        ...(manifest === 'modern'
          ? [{ name: 'chromium-headless-shell', revision, installByDefault: true }]
          : []),
        // Never installed by `playwright install chromium`, so requiring it
        // would refuse every ordinary machine.
        { name: 'chromium-tip-of-tree', revision: '9998', installByDefault: false },
        { name: 'firefox', revision: '9999', installByDefault: true },
      ],
    }),
    'utf8',
  );
  return packageDir;
}

/**
 * A browser registry holding a COMPLETE chromium install at one revision.
 *
 * Complete means both bundles a chromium launch needs — `chromium-<rev>` and
 * the separate `chromium_headless_shell-<rev>` used for default headless
 * launches — each carrying Playwright's own `INSTALLATION_COMPLETE` marker. A
 * fixture that only made directories would have proved that the code reads
 * directory names, which is precisely the bug the codex reviews found twice.
 */
async function installFakeChromium(
  browsersPath: string,
  revision: string = FIXTURE_REVISION,
): Promise<void> {
  for (const bundle of [`chromium-${revision}`, `chromium_headless_shell-${revision}`]) {
    await installFakeBundle(join(browsersPath, bundle));
  }
}

async function installFakeBundle(bundleDir: string): Promise<void> {
  await mkdir(bundleDir, { recursive: true });
  await writeFile(join(bundleDir, 'INSTALLATION_COMPLETE'), '', 'utf8');
}

/** A complete install for a Playwright that has no headless-shell bundle. */
async function installFakeLegacyChromium(
  browsersPath: string,
  revision: string = FIXTURE_REVISION,
): Promise<void> {
  await installFakeBundle(join(browsersPath, `chromium-${revision}`));
}

/** An interrupted download: the directory is there, the marker is not. */
async function installPartialChromium(
  browsersPath: string,
  revision: string = FIXTURE_REVISION,
): Promise<void> {
  await mkdir(join(browsersPath, `chromium-${revision}`), { recursive: true });
  await installFakeBundle(join(browsersPath, `chromium_headless_shell-${revision}`));
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

  it('reports browsers as absent — never present — when the revision table is unreadable', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      await installFakePlaywright(project, '1.44.0');
      // A registry populated at a revision this Playwright does not require.
      // Fail-closed means "not present", which costs one extra hint and can
      // never make doctor green over a machine that cannot open a browser.
      await installFakeChromium(join(home, '.cache', 'ms-playwright'), '1');

      const env = await resolvePlaywrightEnvironment(inputs(project, { homeDir: home }));

      expect(env.browsersPresent).toBe(false);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  /**
   * REGRESSION — codex review of this branch, P1.
   *
   * Playwright's registry accumulates one directory per revision, so a
   * developer machine routinely carries several at once (this one carried
   * chromium-1208, -1217, -1228 and -1234 while the pinned Playwright required
   * exactly 1234). A prefix match would call that registry ready, provisioning
   * would skip the download it needed, and the failure would arrive later as
   * Playwright's own missing-executable error — from a machine doctor had
   * already reported green.
   */
  it('does not accept a chromium from a DIFFERENT Playwright revision', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      await installFakePlaywright(project, '1.62.1', '1234');
      // Three neighbours, none of them the one this Playwright needs.
      await installFakeChromium(join(home, '.cache', 'ms-playwright'), '1208');
      await installFakeChromium(join(home, '.cache', 'ms-playwright'), '1217');
      await installFakeBundle(
        join(home, '.cache', 'ms-playwright', 'chromium_headless_shell-1234'),
      );

      const env = await resolvePlaywrightEnvironment(inputs(project, { homeDir: home }));

      expect(env.source).toBe('project');
      expect(env.browsersPresent).toBe(false);
      expect(env.ready).toBe(false);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it('accepts the registry once the required revision is there alongside the others', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      await installFakePlaywright(project, '1.62.1', '1234');
      await installFakeChromium(join(home, '.cache', 'ms-playwright'), '1208');
      await installFakeChromium(join(home, '.cache', 'ms-playwright'), '1234');

      const env = await resolvePlaywrightEnvironment(inputs(project, { homeDir: home }));

      expect(env.browsersPresent).toBe(true);
      expect(env.ready).toBe(true);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it('fails closed when the required revision cannot be read at all', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      // A `@playwright/test` with no resolvable `playwright-core` beside it:
      // an installation `playwright install` could not drive either. The honest
      // answer is "not ready", never a prefix-matched guess that looks green.
      const packageDir = join(project, 'node_modules', PLAYWRIGHT_PACKAGE);
      await mkdir(packageDir, { recursive: true });
      await writeFile(
        join(packageDir, 'package.json'),
        JSON.stringify({ name: PLAYWRIGHT_PACKAGE, version: '1.62.1', main: 'index.js' }),
        'utf8',
      );
      await writeFile(join(packageDir, 'index.js'), 'module.exports = {};\n', 'utf8');
      await installFakeChromium(join(home, '.cache', 'ms-playwright'));

      const env = await resolvePlaywrightEnvironment(inputs(project, { homeDir: home }));

      expect(env.source).toBe('project');
      expect(env.version).toBe('1.62.1');
      expect(env.browsersPresent).toBe(false);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  /**
   * REGRESSION — codex review of this branch, P2.
   *
   * A relative `PLAYWRIGHT_BROWSERS_PATH` stored verbatim is read against THIS
   * process's cwd during resolution and against the child's cwd inside
   * `playwright install`, so a download can succeed into one directory while
   * readiness is checked in another. It is absolutised once, at the parent's
   * cwd, and the absolute value is what every child is given.
   */
  /**
   * REGRESSION — codex re-review of this branch, P1(b).
   *
   * An interrupted download leaves the revision directory behind with nothing
   * usable in it. Matching the directory NAME would call that ready,
   * provisioning would skip the download it needed, and the probe would fail
   * against a machine doctor had already reported green.
   */
  it('does not accept a chromium directory left behind by an interrupted download', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      await installFakePlaywright(project, '1.62.1');
      await installPartialChromium(join(home, '.cache', 'ms-playwright'));

      const env = await resolvePlaywrightEnvironment(inputs(project, { homeDir: home }));

      expect(env.source).toBe('project');
      expect(env.browsersPresent).toBe(false);
      expect(env.ready).toBe(false);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  /**
   * REGRESSION — codex re-review of this branch, P1(b), second half.
   *
   * Current Playwright launches headless through a SEPARATE
   * `chromium_headless_shell-<revision>` bundle, which every browser probe
   * uses by default. A registry with only `chromium-<revision>` cannot serve
   * that launch.
   */
  it('requires the headless-shell bundle, not only chromium', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      await installFakePlaywright(project, '1.62.1');
      await installFakeBundle(join(home, '.cache', 'ms-playwright', 'chromium-1234'));

      const env = await resolvePlaywrightEnvironment(inputs(project, { homeDir: home }));

      expect(env.browsersPresent).toBe(false);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  /**
   * Found by self-audit after three review rounds, all of the same class:
   * hard-coding an answer Playwright's own metadata gives.
   *
   * The CLI path came from a literal `cli.js`. It comes from the manifest's
   * `bin` field now, so a package that names its entry point differently is
   * driven correctly instead of being spawned at a path that does not exist.
   */
  it('takes the CLI path from the package’s own bin field, not a literal', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      const packageDir = await installFakePlaywright(project, '1.62.1');
      // Rewrite the manifest to declare a differently named entry point.
      await writeFile(
        join(packageDir, 'package.json'),
        JSON.stringify({
          name: PLAYWRIGHT_PACKAGE,
          version: '1.62.1',
          main: 'index.js',
          bin: { playwright: 'lib/entry.js' },
        }),
        'utf8',
      );

      const env = await resolvePlaywrightEnvironment(inputs(project, { homeDir: home }));

      if (env.source === 'absent') {
        throw new Error('unreachable');
      }
      expect(env.cliPath).toBe(join(env.packageDir, 'lib', 'entry.js'));
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  /**
   * REGRESSION — codex review of this branch, round 5.
   *
   * The primary `@playwright/test` lookup has always been bounded to the
   * project tree; the secondary `playwright-core` lookup was not. So a
   * project-local `@playwright/test` with a missing or malformed
   * `playwright-core` let the walk climb OUT of the project and pick up an
   * ancestor's — including SpecWitness's own. The revision table and the
   * package-local browser path would then describe a different Playwright than
   * the one about to be driven, and readiness would be reported against the
   * wrong installation. Same scope error as the `=0` refusal: a rule written
   * for one path and not applied to the next one over.
   */
  it('never borrows a playwright-core from ABOVE the project it resolved in', async () => {
    const outer = await tempRoot();
    const home = await tempRoot();
    try {
      // The ancestor carries a complete, consistent Playwright at revision 7777.
      await installFakePlaywright(outer, '9.9.9', '7777');
      await installFakeChromium(join(home, '.cache', 'ms-playwright'), '7777');

      // The project has its own `@playwright/test` and NO `playwright-core`.
      const project = join(outer, 'packages', 'app');
      const packageDir = join(project, 'node_modules', PLAYWRIGHT_PACKAGE);
      await mkdir(packageDir, { recursive: true });
      await writeFile(
        join(packageDir, 'package.json'),
        JSON.stringify({ name: PLAYWRIGHT_PACKAGE, version: '1.62.1', main: 'index.js' }),
        'utf8',
      );
      await writeFile(join(packageDir, 'index.js'), 'module.exports = {};\n', 'utf8');

      const env = await resolvePlaywrightEnvironment(inputs(project, { homeDir: home }));

      // The project's own installation is what resolved…
      expect(env.source).toBe('project');
      expect(env.version).toBe('1.62.1');
      // …and its readiness is NOT decided by the ancestor's revision table.
      expect(env.browsersPresent).toBe(false);
    } finally {
      await rm(outer, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  /**
   * REGRESSION — codex review of this branch, round 3.
   *
   * A project pinning a Playwright that predates the separate headless-shell
   * bundle declares `chromium` alone in its `browsers.json`. A hard-coded
   * requirement list made that manifest unreadable, so the project could run
   * its own `playwright install chromium` successfully and still be told the
   * environment was unusable — which contradicts the story's second
   * load-bearing property, that the project's pinned version wins.
   */
  it('honours an older Playwright whose manifest declares chromium alone', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      await installFakePlaywright(project, '1.30.0', '1045', 'legacy');
      await installFakeLegacyChromium(join(home, '.cache', 'ms-playwright'), '1045');

      const env = await resolvePlaywrightEnvironment(inputs(project, { homeDir: home }));

      expect(env.source).toBe('project');
      expect(env.version).toBe('1.30.0');
      expect(env.browsersPresent).toBe(true);
      expect(env.ready).toBe(true);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it('still demands the headless shell from a version that declares one', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      await installFakePlaywright(project, '1.62.1', '1234', 'modern');
      // Exactly what satisfies the legacy manifest above, and must not satisfy
      // this one: the requirement follows the manifest, not the code.
      await installFakeLegacyChromium(join(home, '.cache', 'ms-playwright'), '1234');

      const env = await resolvePlaywrightEnvironment(inputs(project, { homeDir: home }));

      expect(env.browsersPresent).toBe(false);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it('never requires a bundle the manifest marks installByDefault false', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      // The fixture manifest declares `chromium-tip-of-tree` at revision 9998,
      // which `playwright install chromium` never fetches. A registry with the
      // default bundles only must still be ready.
      await installFakePlaywright(project, '1.62.1');
      await installFakeChromium(join(home, '.cache', 'ms-playwright'));

      const env = await resolvePlaywrightEnvironment(inputs(project, { homeDir: home }));

      expect(env.ready).toBe(true);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  /**
   * REGRESSION — codex re-review of this branch, P1(a).
   *
   * `PLAYWRIGHT_BROWSERS_PATH=0` is a SUPPORTED Playwright configuration that
   * keeps browsers under `playwright-core/.local-browsers`. Reporting it
   * unusable meant a project deliberately using package-local browsers could
   * never run a browser probe despite having a complete installation.
   */
  it('honours a COMPLETE package-local installation when PLAYWRIGHT_BROWSERS_PATH is 0', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      await installFakePlaywright(project, '1.62.1');
      const local = join(project, 'node_modules', 'playwright-core', '.local-browsers');
      await installFakeChromium(local);

      const env = await resolvePlaywrightEnvironment(
        inputs(project, { env: { PLAYWRIGHT_BROWSERS_PATH: '0' }, homeDir: home }),
      );

      // Realpath-compared: the path is derived from the RESOLVED package
      // directory, and Node's resolution answers `/private/var/...` on macOS.
      expect(env.browsersPath).toBe(await realpath(local));
      expect(env.browsersPresent).toBe(true);
      expect(env.ready).toBe(true);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it('still reports not-ready for an EMPTY package-local registry', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      await installFakePlaywright(project, '1.62.1');

      const env = await resolvePlaywrightEnvironment(
        inputs(project, { env: { PLAYWRIGHT_BROWSERS_PATH: '0' }, homeDir: home }),
      );

      expect(env.browsersPresent).toBe(false);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it('absolutises a relative PLAYWRIGHT_BROWSERS_PATH so parent and child cannot disagree', async () => {
    const dir = specwitnessPlaywrightCacheDir({
      env: { PLAYWRIGHT_BROWSERS_PATH: 'tmp/browsers' },
      platform: 'linux',
      homeDir: '/home/dev',
    });

    expect(isAbsolute(dir.browsersPath)).toBe(true);
    expect(dir.browsersPath).toBe(resolve('tmp/browsers'));
    expect(dir.browsersPathFromEnv).toBe(true);
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

  it('spawns npm.cmd on Windows, because ProcessRunner uses no shell', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      const cacheDir = join(home, 'AppData', 'Local', 'specwitness', 'playwright');
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
        platform: 'win32',
        homeDir: home,
        timeoutMs: 1_000,
      });

      // A bare `npm` is a shell script on POSIX and a `.cmd` on Windows; with
      // no shell, the bare name resolves to nothing executable there.
      expect(runs[0]?.options.binary).toBe('npm.cmd');
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it('does not refuse a COMPLETE package-local installation, and spawns nothing for it', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      const { runner, runs } = fakeRunner([ok()]);
      await installFakePlaywright(project, '1.62.1');
      await installFakeChromium(
        join(project, 'node_modules', 'playwright-core', '.local-browsers'),
      );

      const env = await provisionPlaywright({
        projectRoot: project,
        runner,
        env: { PLAYWRIGHT_BROWSERS_PATH: '0' },
        platform: 'linux',
        homeDir: home,
        timeoutMs: 1_000,
      });

      expect(env.source).toBe('project');
      expect(env.ready).toBe(true);
      expect(runs).toHaveLength(0);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it('refuses to provision INTO a PROJECT\u2019s package-local registry, explaining why', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      const { runner, runs } = fakeRunner([ok(), ok()]);
      // A project installation with nothing downloaded. Honouring `=0` here
      // would write a browser bundle inside the project's own node_modules,
      // which AC1 forbids outright.
      await installFakePlaywright(project, '1.62.1');

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

      expect(error.message).toContain('PLAYWRIGHT_BROWSERS_PATH');
      expect(error.message).toMatch(/project/i);
      expect(runs).toHaveLength(0);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  /**
   * REGRESSION — codex review of this branch, round 4.
   *
   * With no project Playwright, the fallback package AND its `.local-browsers`
   * both live inside SpecWitness's own cache, so there is no project tree to
   * damage and nothing to refuse. The earlier refusal was written for the
   * project route and applied to both by accident.
   */
  it('honours PLAYWRIGHT_BROWSERS_PATH=0 on the owned-cache route instead of refusing', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      const cacheDir = join(home, '.cache', 'specwitness', 'playwright');
      const { runner, runs } = fakeRunner([ok(), ok()], async (call) => {
        if (call === 0) {
          await installFakePlaywright(cacheDir, '1.62.1');
        } else {
          await installFakeChromium(
            join(cacheDir, 'node_modules', 'playwright-core', '.local-browsers'),
          );
        }
      });

      const env = await provisionPlaywright({
        projectRoot: project,
        runner,
        env: { PLAYWRIGHT_BROWSERS_PATH: '0' },
        platform: 'linux',
        homeDir: home,
        timeoutMs: 1_000,
      });

      expect(env.source).toBe('specwitness-cache');
      expect(env.ready).toBe(true);
      expect(runs).toHaveLength(2);
      // `0` is passed through verbatim, so Playwright puts the bundle where the
      // operator asked — inside the cache's own package, still SpecWitness-owned.
      expect(runs[1]?.options.env.set?.['PLAYWRIGHT_BROWSERS_PATH']).toBe('0');
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  /**
   * REGRESSION — codex review of this branch, round 4.
   *
   * A ready owned cache from an older SpecWitness would otherwise be reused
   * indefinitely, so bumping the pin would change nothing on any machine that
   * already had one: browser probes running an untested fallback while
   * `package.json` said otherwise.
   */
  it('reinstalls an owned cache that is ready but pinned to an older version', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      const cacheDir = join(home, '.cache', 'specwitness', 'playwright');
      // Ready, and stale: an older SpecWitness left this behind.
      await installFakePlaywright(cacheDir, '1.40.0');
      await installFakeChromium(join(cacheDir, 'browsers'));

      const { runner, runs } = fakeRunner([ok(), ok()], async (call) => {
        if (call === 0) {
          await installFakePlaywright(cacheDir, PROVISIONED_PLAYWRIGHT_VERSION);
        } else {
          await installFakeChromium(join(cacheDir, 'browsers'));
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

      expect(env.version).toBe(PROVISIONED_PLAYWRIGHT_VERSION);
      expect(runs[0]?.options.args.join(' ')).toContain(
        `${PLAYWRIGHT_PACKAGE}@${PROVISIONED_PLAYWRIGHT_VERSION}`,
      );
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it('leaves an owned cache alone when it is ready AT the pinned version', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      const cacheDir = join(home, '.cache', 'specwitness', 'playwright');
      await installFakePlaywright(cacheDir, PROVISIONED_PLAYWRIGHT_VERSION);
      await installFakeChromium(join(cacheDir, 'browsers'));
      const { runner, runs } = fakeRunner([ok()]);

      const env = await provisionPlaywright({
        projectRoot: project,
        runner,
        env: {},
        platform: 'linux',
        homeDir: home,
        timeoutMs: 1_000,
      });

      expect(env.source).toBe('specwitness-cache');
      expect(runs).toHaveLength(0);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  /**
   * The pin bounds only what SPECWITNESS installs. A project's version is the
   * project's decision, and honouring it is the whole reason the project's
   * installation is preferred (FR-24).
   */
  it('never second-guesses a PROJECT installation’s version', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      await installFakePlaywright(project, '1.30.0', '1045', 'legacy');
      await installFakeLegacyChromium(join(home, '.cache', 'ms-playwright'), '1045');
      const { runner, runs } = fakeRunner([ok()]);

      const env = await provisionPlaywright({
        projectRoot: project,
        runner,
        env: {},
        platform: 'linux',
        homeDir: home,
        timeoutMs: 1_000,
      });

      expect(env.version).toBe('1.30.0');
      expect(runs).toHaveLength(0);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  /**
   * REGRESSION — codex review of this branch, round 6. THE MOST DAMAGING BUG
   * FOUND ON THIS BRANCH, and the only one that would have modified somebody
   * else's repository.
   *
   * `PLAYWRIGHT_BROWSERS_PATH` is operator input, not authority. A value under
   * `projectRoot` — `<project>/.browsers` — was accepted and handed to
   * `playwright install`, which would have written hundreds of megabytes into
   * the repository under verification. AC1 and FR-24 forbid that outright: a
   * target repository that gained a browser bundle because it was verified has
   * been damaged by its verifier.
   */
  it('refuses to write a browser bundle inside the target project, even when asked to', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      const { runner, runs } = fakeRunner([ok(), ok()]);
      await installFakePlaywright(project, '1.62.1');

      const error = await expectInfraError(
        provisionPlaywright({
          projectRoot: project,
          runner,
          env: { PLAYWRIGHT_BROWSERS_PATH: join(project, '.browsers') },
          platform: 'linux',
          homeDir: home,
          timeoutMs: 1_000,
        }),
      );

      expect(error.message).toContain('inside the target project');
      expect(error.hint).toContain('PLAYWRIGHT_BROWSERS_PATH');
      // NOTHING was spawned: the refusal lands before any byte is written.
      expect(runs).toHaveLength(0);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it('refuses an env-derived CACHE root inside the target project too', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      const { runner, runs } = fakeRunner([ok(), ok()]);
      // No project Playwright, so the owned-cache route runs — into a cache the
      // operator pointed at the project via XDG_CACHE_HOME.
      const error = await expectInfraError(
        provisionPlaywright({
          projectRoot: project,
          runner,
          env: { XDG_CACHE_HOME: join(project, 'cache') },
          platform: 'linux',
          homeDir: home,
          timeoutMs: 1_000,
        }),
      );

      expect(error.message).toContain('inside the target project');
      expect(runs).toHaveLength(0);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  /**
   * The refusal lands after the readiness check, deliberately. Resolution is
   * read-only and an already-ready environment writes nothing, so refusing it
   * would break a working setup for no benefit — which is exactly the mistake
   * the `=0` refusal made before it was narrowed (finding 9).
   */
  it('does not refuse an in-project browsers path that is already populated', async () => {
    const project = await tempRoot();
    const home = await tempRoot();
    try {
      const browsers = join(project, '.browsers');
      await installFakePlaywright(project, '1.62.1');
      await installFakeChromium(browsers);
      const { runner, runs } = fakeRunner([ok()]);

      const env = await provisionPlaywright({
        projectRoot: project,
        runner,
        env: { PLAYWRIGHT_BROWSERS_PATH: browsers },
        platform: 'linux',
        homeDir: home,
        timeoutMs: 1_000,
      });

      expect(env.ready).toBe(true);
      expect(runs).toHaveLength(0);
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
