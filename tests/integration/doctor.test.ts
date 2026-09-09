import { createServer } from 'node:net';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

import {
  hermeticHome,
  hermeticHomeEnv,
  specwitnessPlaywrightCache,
} from './helpers/hermetic-home.js';

/**
 * `specwitness doctor` end to end, against the BUILT binary.
 *
 * Every fixture is a fresh temp directory — never the repository root. Doctor
 * reads `.specwitness/config.yaml`, so a test run at REPO_ROOT would find (or
 * not find) whatever another test happened to leave behind, and its result would
 * depend on suite ordering. Temp dirs make these assertions order-independent.
 */

const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * Runs git in `cwd` with a hermetic identity AND NO USER CONFIG.
 *
 * ⚠️ STORY 7.7, AC4 — the second thing in this file that read state outside the
 * tree under test. The identity was already pinned; the CONFIG was not, so a
 * developer with `commit.gpgsign = true` in `~/.gitconfig` had every fixture
 * here fail at `git commit` with `gpg failed to sign the data` — 16 of 17 tests
 * red, for a reason that is a fact about their machine rather than about
 * `doctor`. `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` are the same guard
 * `tests/integration/helpers/{probe,verify}-fixture.ts` already carry; this file
 * simply did not have it.
 */
function git(cwd: string, ...args: string[]) {
  return execa('git', args, {
    cwd,
    env: {
      GIT_AUTHOR_NAME: 'Doctor Fixture',
      GIT_AUTHOR_EMAIL: 'doctor@example.test',
      GIT_COMMITTER_NAME: 'Doctor Fixture',
      GIT_COMMITTER_EMAIL: 'doctor@example.test',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
    extendEnv: true,
  });
}

async function project(config?: string, options: { git?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'specwitness-doctor-it-'));
  created.push(root);

  if (options.git !== false) {
    await git(root, 'init', '-b', 'master');
    await git(root, 'commit', '--allow-empty', '-m', 'root commit');
  }

  if (config !== undefined) {
    await mkdir(join(root, '.specwitness'), { recursive: true });
    await writeFile(join(root, '.specwitness', 'config.yaml'), config, 'utf8');
  }

  return root;
}

interface HeldPort {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Occupies an ephemeral localhost port, or resolves `undefined` where the
 * sandbox forbids listening. Both the success and the failure path settle:
 * a `listen` that rejects with no error handler surfaces as an unhandled
 * exception and a 30s test timeout, which is how this was found.
 */
async function tryListen(): Promise<HeldPort | undefined> {
  const server = createServer();

  return await new Promise<HeldPort | undefined>((resolve) => {
    server.once('error', () => {
      server.close();
      resolve(undefined);
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address !== 'object' || address === null) {
        server.close();
        resolve(undefined);
        return;
      }
      resolve({
        port: address.port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/**
 * A PATH containing git and nothing else.
 *
 * Emptying PATH outright would also hide `git`, which is a REQUIRED check — the
 * run would exit 3 for a reason that has nothing to do with providers. Linking
 * the real git into an otherwise-empty directory makes "codex is absent" true
 * regardless of what the developer running this has installed, without breaking
 * everything else doctor needs.
 */
async function gitOnlyPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'specwitness-git-only-'));
  created.push(dir);
  const { stdout } = await execa('sh', ['-c', 'command -v git']);
  await symlink(stdout.trim(), join(dir, 'git'));
  return dir;
}

/**
 * A constructed, empty home directory, cleaned up with the rest of the fixtures.
 *
 * Story 7.7: every child below gets one by default. See `doctor` for why.
 */
async function emptyHome(): Promise<string> {
  const home = await hermeticHome();
  created.push(home);
  return home;
}

/**
 * Runs the built CLI. `input: ''` means the child gets no TTY, which is how the
 * harness invokes it.
 *
 * Story 2.7 note on `env`: the billing-risk variables are UNSET by default, so a
 * developer who happens to export `OPENAI_API_KEY` gets the same results as CI.
 * Without this the `billing-risk-env` check would report differently on
 * different machines and the failure would look like a flake rather than an
 * inherited environment.
 *
 * ⚠️ STORY 7.7 — `HOME` IS THE SAME KIND OF INHERITANCE, and it was the one that
 * got through. `playwright-capability` resolves `@playwright/test` from the
 * project *or from SpecWitness's own cache under the home directory*
 * (`src/infra/playwright-env.ts`), and story 7.0 made `verify` fill that cache.
 * So from Epic 7 onward this suite reported `⚠ playwright-capability` on a
 * machine that had never run the product and `✓ ... from the SpecWitness cache`
 * on one that had — and the second is every machine this dogfooding epic is
 * carried out on. Each child therefore gets its OWN empty home (and the
 * `XDG_CACHE_HOME` / `LOCALAPPDATA` / `USERPROFILE` spellings of it), so the
 * capability the check reports is one this file put there or deliberately left
 * out. A caller that wants a populated one passes `hermeticHomeEnv(home)` in
 * `env`, which overrides this.
 */
async function doctor(
  cwd: string,
  args: string[] = [],
  env: Record<string, string | undefined> = {},
) {
  const result = await execa(process.execPath, [CLI, 'doctor', ...args], {
    cwd,
    reject: false,
    input: '',
    env: {
      ANTHROPIC_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
      ...hermeticHomeEnv(await emptyHome()),
      ...env,
    },
    extendEnv: true,
  });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

/** The version the cache fixture below declares. Asserted on, so it is named. */
const FIXTURE_PLAYWRIGHT_VERSION = '1.62.1';

/** The chromium revision that fixture requires and provides. */
const FIXTURE_CHROMIUM_REVISION = '1234';

/**
 * Writes a COMPLETE SpecWitness Playwright cache at `cacheDir`: the layout
 * `provisionPlaywright` leaves behind on a machine that has run a browser probe.
 *
 * A REAL PACKAGE LAYOUT, not a stub the resolver is taught to accept. The check
 * runs in a child process against the built binary, which uses Node's own
 * `require.resolve` for `@playwright/test` and reads `playwright-core`'s
 * `browsers.json` for the revision table exactly as `playwright install` does —
 * so anything less than a resolvable pair, plus Playwright's own
 * `INSTALLATION_COMPLETE` marker in every bundle that table requires, would
 * report `absent` or `browsers: absent` and prove nothing.
 *
 * `tests/unit/infra/playwright-env.test.ts` builds the same shape for the
 * resolver's own unit tests; this is the end-to-end half, through the binary.
 */
async function installCachedPlaywright(cacheDir: string): Promise<void> {
  const modules = join(cacheDir, 'node_modules');

  const packageDir = join(modules, '@playwright', 'test');
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: '@playwright/test',
      version: FIXTURE_PLAYWRIGHT_VERSION,
      main: 'index.js',
      // npm's map form, which is the shape `@playwright/test` actually uses.
      bin: { playwright: 'cli.js' },
    }),
    'utf8',
  );
  await writeFile(join(packageDir, 'index.js'), 'module.exports = {};\n', 'utf8');

  const coreDir = join(modules, 'playwright-core');
  await mkdir(coreDir, { recursive: true });
  await writeFile(
    join(coreDir, 'package.json'),
    JSON.stringify({
      name: 'playwright-core',
      version: FIXTURE_PLAYWRIGHT_VERSION,
      main: 'index.js',
    }),
    'utf8',
  );
  await writeFile(join(coreDir, 'index.js'), 'module.exports = {};\n', 'utf8');
  await writeFile(
    join(coreDir, 'browsers.json'),
    JSON.stringify({
      browsers: [
        { name: 'chromium', revision: FIXTURE_CHROMIUM_REVISION, installByDefault: true },
        {
          name: 'chromium-headless-shell',
          revision: FIXTURE_CHROMIUM_REVISION,
          installByDefault: true,
        },
      ],
    }),
    'utf8',
  );

  // Both bundles a default headless launch needs, each carrying the marker
  // Playwright writes only when a download finished. A fixture that made
  // directories alone would assert that the check reads names, which is a bug
  // the resolver already had and fixed.
  for (const bundle of [
    `chromium-${FIXTURE_CHROMIUM_REVISION}`,
    `chromium_headless_shell-${FIXTURE_CHROMIUM_REVISION}`,
  ]) {
    const bundleDir = join(cacheDir, 'browsers', bundle);
    await mkdir(bundleDir, { recursive: true });
    await writeFile(join(bundleDir, 'INSTALLATION_COMPLETE'), '', 'utf8');
  }
}

const HEALTHY = ['version: 1', 'project:', '  baseBranch: master', ''].join('\n');

describe('doctor on a healthy project', () => {
  it('exits 0 and reports every check', async () => {
    const root = await project(HEALTHY);

    const { exitCode, stdout } = await doctor(root);

    expect(exitCode).toBe(0);
    for (const id of [
      'node-version',
      'git-present',
      'config-valid',
      'base-branch-exists',
      'commands-resolvable',
      'playwright-capability',
      'ports-free',
    ]) {
      expect(stdout).toContain(id);
    }
  });

  it('stays at 0 when an optional check warns', async () => {
    // THE WARNING IS CONSTRUCTED, not assumed (story 7.7). It takes BOTH halves:
    // the fixture has no `@playwright/test`, AND `doctor` runs against an empty
    // home, so SpecWitness's own cache — the check's second source — is empty
    // too. The comment this replaces named only the first half and was wrong
    // from the moment story 7.0 taught `verify` to fill that cache: on a machine
    // that had dogfooded, the check PASSED and this test failed.
    //
    // An optional check must never move the exit code — that rule is what keeps
    // a missing agent CLI (story 2.7) or an unprovisioned browser non-fatal, and
    // it is the half of this test worth keeping.
    const root = await project(HEALTHY);

    const { exitCode, stdout } = await doctor(root);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/⚠ playwright-capability/);
  });

  it('passes playwright-capability, from the cache, when SpecWitness provisioned one', async () => {
    // THE OTHER BRANCH, and the state of every machine that has actually run
    // this product (story 7.7 / AC3). Nothing covered it, which is how the
    // sibling test above could depend on the absence of a cache without anyone
    // noticing that the presence of one was a real and unpinned state.
    //
    // The cache is BUILT HERE — under a constructed home, never the developer's
    // — so this assertion is a fact about a layout this test wrote rather than
    // about whether whoever ran `vitest` happens to have dogfooded.
    const root = await project(HEALTHY);
    const home = await emptyHome();
    await installCachedPlaywright(specwitnessPlaywrightCache(home));

    const { exitCode, stdout } = await doctor(root, [], hermeticHomeEnv(home));

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/✓ playwright-capability/);
    // The SOURCE, not merely a pass: a project-local resolution and a cached one
    // are different facts, and only one of them is what this fixture built.
    expect(stdout).toContain('from the SpecWitness cache');
    expect(stdout).toContain(FIXTURE_PLAYWRIGHT_VERSION);
  });

  it('warns, and still exits 0, when a declared port is occupied', async (context) => {
    // Binding a listener is not permitted in every sandbox (a Codex review run
    // returned EPERM on 127.0.0.1). Skip rather than fail there: the product
    // path is covered regardless, because `probePort` reports any bind failure
    // — EPERM included — as an occupied port, which is a warn.
    const held = await tryListen();
    if (held === undefined) {
      context.skip();
      return;
    }

    try {
      const root = await project(
        [
          'version: 1',
          'project:',
          '  baseBranch: master',
          'services:',
          '  web:',
          '    run: /bin/sh',
          `    port: ${held.port}`,
          '    ready:',
          `      url: http://127.0.0.1:${held.port}/health`,
          '',
        ].join('\n'),
      );

      const { exitCode, stdout } = await doctor(root);

      expect(exitCode).toBe(0);
      expect(stdout).toContain(String(held.port));
      expect(stdout).toMatch(/⚠ ports-free/);
    } finally {
      await held.close();
    }
  });
});

describe('doctor on a broken project', () => {
  it('exits 3 — never 1 or 2 — and names the offending YAML path', async () => {
    const root = await project(
      ['version: 1', 'project:', '  baseBranch: master', 'setupp:', '  install: pnpm i', ''].join(
        '\n',
      ),
    );

    const { exitCode, stdout, stderr } = await doctor(root);

    expect(exitCode).toBe(3);
    expect(stdout).toContain('setupp');
    expect(stderr).toContain('ERROR:');
    expect(stderr).toContain('HINT:');
  });

  it('exits 3 when the declared base branch does not exist', async () => {
    const root = await project(
      ['version: 1', 'project:', '  baseBranch: no-such-branch', ''].join('\n'),
    );

    const { exitCode, stdout } = await doctor(root);

    expect(exitCode).toBe(3);
    expect(stdout).toContain('no-such-branch');
  });

  it('exits 3 and names the gate when a declared command does not resolve', async () => {
    const root = await project(
      [
        'version: 1',
        'project:',
        '  baseBranch: master',
        'gates:',
        '  - id: lint',
        '    run: definitely-not-installed-binary --check',
        '',
      ].join('\n'),
    );

    const { exitCode, stdout } = await doctor(root);

    expect(exitCode).toBe(3);
    expect(stdout).toContain('gates[lint]');
    expect(stdout).toContain('definitely-not-installed-binary');
  });

  it('exits 3 with the init hint when there is no config file', async () => {
    const root = await project();

    const { exitCode, stdout } = await doctor(root);

    expect(exitCode).toBe(3);
    expect(stdout).toContain('specwitness init');
  });

  it('reports "not a git repository" rather than a git failure', async () => {
    const root = await project(HEALTHY, { git: false });

    const { exitCode, stdout } = await doctor(root);

    expect(exitCode).toBe(3);
    expect(stdout).toMatch(/not a git repository/i);
  });

  it('runs every check even when an early one fails', async () => {
    const root = await project(undefined, { git: true });

    const { stdout } = await doctor(root);

    // config-valid failed, yet the downstream checks still report rather than
    // the command stopping at the first problem.
    expect(stdout).toContain('base-branch-exists');
    expect(stdout).toContain('ports-free');
  });
});

describe('doctor --json', () => {
  it('puts JSON and nothing else on stdout, with an ISO-8601 UTC timestamp', async () => {
    const root = await project(HEALTHY);

    const { exitCode, stdout, stderr } = await doctor(root, ['--json']);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as {
      schemaVersion: number;
      timestamp: string;
      status: string;
      checks: { id: string; status: string; required: boolean; detail: string }[];
    };

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
    expect(parsed.checks.map((check) => check.id)).toEqual([
      'node-version',
      'git-present',
      'config-valid',
      'base-branch-exists',
      'commands-resolvable',
      'playwright-capability',
      'ports-free',
      // ── appended by story 2.7 ──
      // Extended in registration order, and deliberately still an EXACT list:
      // loosening this to `toContain` would delete the only guarantee that the
      // `--json` check order is stable for the consumers that parse it.
      'billing-risk-env',
      'ai-providers',
    ]);
    // The human rendering is still available, on the other stream.
    expect(stderr).toContain('node-version');
  });

  it('still parses as JSON on the failure path, and still exits 3', async () => {
    const root = await project();

    const { exitCode, stdout } = await doctor(root, ['--json']);

    expect(exitCode).toBe(3);
    const parsed = JSON.parse(stdout) as { status: string };
    expect(parsed.status).toBe('fail');
  });
});

/**
 * FR-15 / UJ-4 through the built binary (story 2.7).
 *
 * The variable is set in the CHILD's environment only. `process.env` in this
 * test process is never mutated: AD-4 forbids the product from touching the
 * parent environment, and a suite that did it would leak into every file that
 * ran after it.
 */
describe('doctor and billing-risk environment variables', () => {
  const WITH_PROVIDER = [
    'version: 1',
    'project:',
    '  baseBranch: master',
    'ai:',
    '  providers:',
    '    codex:',
    '      adapter: codex-cli',
    '      mode: chatgpt',
    '  roles:',
    '    contract-author: codex',
    '',
  ].join('\n');

  it('names the variable and still exits 0', async () => {
    const root = await project(WITH_PROVIDER);

    const { exitCode, stdout } = await doctor(root, [], {
      OPENAI_API_KEY: 'sk-not-a-real-key-000',
    });

    // The warning is a thing to know, not a broken environment. Exiting
    // non-zero here would train an operator to stop reading doctor's output.
    expect(exitCode).toBe(0);
    expect(stdout).toContain('OPENAI_API_KEY present in environment');
    expect(stdout).toContain('could bill your API account');
  });

  it('prints the name and never the value', async () => {
    const root = await project(WITH_PROVIDER);
    const secret = 'sk-not-a-real-key-000';

    const { stdout, stderr } = await doctor(root, [], { OPENAI_API_KEY: secret });

    // The whole point of the check: a warning that echoed the key would leak a
    // credential into terminal scrollback, CI logs and PR bodies.
    expect(stdout).not.toContain(secret);
    expect(stderr).not.toContain(secret);
  });

  it('keeps the value out of --json too', async () => {
    const root = await project(WITH_PROVIDER);
    const secret = 'sk-not-a-real-key-000';

    const { exitCode, stdout } = await doctor(root, ['--json'], { OPENAI_API_KEY: secret });

    expect(exitCode).toBe(0);
    expect(stdout).not.toContain(secret);

    // stdout still carries the JSON document and nothing else.
    const parsed = JSON.parse(stdout) as {
      checks: { id: string; status: string; required: boolean; detail: string }[];
    };
    const billing = parsed.checks.find((check) => check.id === 'billing-risk-env');
    expect(billing?.status).toBe('warn');
    expect(billing?.required).toBe(false);
    expect(billing?.detail).toContain('OPENAI_API_KEY');
  });

  it('reports a configured provider whose binary is absent, and still exits 0', async () => {
    // UJ-4's edge case, end to end: with no agent CLI installed, contract
    // GENERATION is unavailable but execution of existing plans still works.
    // PATH is emptied for the CHILD only, so the result does not depend on
    // whether the developer running this happens to have codex installed.
    const root = await project(WITH_PROVIDER);
    const binDir = await gitOnlyPath();

    const { exitCode, stdout } = await doctor(root, [], { PATH: binDir });

    expect(exitCode).toBe(0);
    expect(stdout).toContain('ai-providers');
    expect(stdout).toMatch(/⚠ ai-providers/);
    expect(stdout).toContain('codex');
  });

  it('says nothing when no provider is configured, even with a key exported', async () => {
    // A normal project state, not a diagnosis: SpecWitness will spawn no
    // provider here, so no provider call can bill anything (UJ-4 edge case).
    const root = await project(HEALTHY);

    const { exitCode, stdout } = await doctor(root, [], { OPENAI_API_KEY: 'sk-not-a-real-key-000' });

    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('could bill your API account');
  });
});
