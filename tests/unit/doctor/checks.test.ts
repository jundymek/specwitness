import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createDoctorContext } from '../../../src/cli/doctor/context.js';
import { baseBranchCheck } from '../../../src/cli/doctor/checks/base-branch.js';
import { commandsResolvableCheck } from '../../../src/cli/doctor/checks/commands-resolvable.js';
import { configValidCheck } from '../../../src/cli/doctor/checks/config-valid.js';
import { gitPresentCheck } from '../../../src/cli/doctor/checks/git-present.js';
import { nodeVersionCheck } from '../../../src/cli/doctor/checks/node-version.js';
import { playwrightCapabilityCheck } from '../../../src/cli/doctor/checks/playwright-capability.js';
import { portsFreeCheck } from '../../../src/cli/doctor/checks/ports-free.js';
import { BUILTIN_CHECKS } from '../../../src/cli/doctor/checks/index.js';
import {
  GIT_MISSING,
  GIT_TIMED_OUT,
  MINIMAL_CONFIG,
  fakeEffects,
  gitFails,
  gitOk,
  makeProject,
  testContext,
} from './helpers.js';

const LOCAL_REF = 'rev-parse --verify --quiet refs/heads/master';
const REMOTE_REF = 'rev-parse --verify --quiet refs/remotes/origin/master';
const GIT_DIR = 'rev-parse --git-dir';

describe('node-version (required)', () => {
  it('passes on the pinned floor and above', async () => {
    for (const version of ['v22.12.0', 'v22.20.0', 'v24.0.1']) {
      const { ctx } = await testContext({ nodeVersion: version });
      expect((await nodeVersionCheck.run(ctx)).status).toBe('pass');
    }
  });

  it('fails below the floor, naming both versions', async () => {
    const { ctx } = await testContext({ nodeVersion: 'v22.11.0' });

    const result = await nodeVersionCheck.run(ctx);

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('22.11.0');
    expect(result.detail).toContain('22.12');
  });

  it('compares numerically, not as strings', async () => {
    // 'v22.9.0' > 'v22.12.0' lexicographically; the check must not be fooled.
    const { ctx } = await testContext({ nodeVersion: 'v22.9.0' });

    expect((await nodeVersionCheck.run(ctx)).status).toBe('fail');
  });

  it('is required', () => {
    expect(nodeVersionCheck.required).toBe(true);
  });
});

describe('git-present (required)', () => {
  it('passes when git answers, reporting the version it found', async () => {
    const { ctx } = await testContext({ gitDefault: gitOk('git version 2.43.0') });

    const result = await gitPresentCheck.run(ctx);

    expect(result.status).toBe('pass');
    expect(result.detail).toContain('2.43.0');
  });

  it('fails with a distinct detail when git is not on PATH', async () => {
    const { ctx } = await testContext({ gitDefault: GIT_MISSING });

    const result = await gitPresentCheck.run(ctx);

    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/not found|not installed/i);
  });

  it('fails with a timeout detail rather than hanging', async () => {
    const { ctx } = await testContext({ gitDefault: GIT_TIMED_OUT });

    const result = await gitPresentCheck.run(ctx);

    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/timed out/i);
  });
});

describe('config-valid (required)', () => {
  it('passes on a minimal valid config', async () => {
    const { ctx } = await testContext({ config: MINIMAL_CONFIG });

    expect((await configValidCheck.run(ctx)).status).toBe('pass');
  });

  it('fails naming the offending YAML path, verbatim from ConfigError', async () => {
    const { ctx } = await testContext({
      config: ['version: 1', 'project:', '  baseBranch: master', 'setupp:', '  install: x'].join(
        '\n',
      ),
    });

    const result = await configValidCheck.run(ctx);

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('setupp');
  });

  it('fails with the init hint when there is no config file at all', async () => {
    const { ctx } = await testContext();

    const result = await configValidCheck.run(ctx);

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('specwitness init');
  });

  it('distinguishes a missing file from an invalid one', async () => {
    const { ctx: missing } = await testContext();
    const { ctx: invalid } = await testContext({ config: 'version: 2\n' });

    const missingDetail = (await configValidCheck.run(missing)).detail;
    const invalidDetail = (await configValidCheck.run(invalid)).detail;

    expect(missingDetail).not.toEqual(invalidDetail);
    expect(invalidDetail).not.toContain('specwitness init');
  });
});

describe('base-branch-exists (required)', () => {
  const config = MINIMAL_CONFIG;

  it('passes when the branch exists locally', async () => {
    const { ctx } = await testContext({
      config,
      git: { [GIT_DIR]: gitOk('.git'), [LOCAL_REF]: gitOk('abc123') },
    });

    const result = await baseBranchCheck.run(ctx);

    expect(result.status).toBe('pass');
    expect(result.detail).toContain('master');
  });

  it('passes when only the remote-tracking ref exists', async () => {
    const { ctx } = await testContext({
      config,
      git: {
        [GIT_DIR]: gitOk('.git'),
        [LOCAL_REF]: gitFails(),
        [REMOTE_REF]: gitOk('abc123'),
      },
    });

    const result = await baseBranchCheck.run(ctx);

    expect(result.status).toBe('pass');
    expect(result.detail).toContain('origin/master');
  });

  it('fails when neither ref resolves, naming the branch', async () => {
    const { ctx } = await testContext({
      config,
      git: { [GIT_DIR]: gitOk('.git') },
      gitDefault: gitFails(),
    });

    const result = await baseBranchCheck.run(ctx);

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('master');
  });

  it('reports "not a git repository" distinctly from git being absent', async () => {
    const { ctx: notRepo } = await testContext({
      config,
      git: { [GIT_DIR]: gitFails(128, 'fatal: not a git repository') },
      gitDefault: gitFails(),
    });
    const { ctx: noGit } = await testContext({ config, gitDefault: GIT_MISSING });

    const notRepoDetail = (await baseBranchCheck.run(notRepo)).detail;
    const noGitDetail = (await baseBranchCheck.run(noGit)).detail;

    expect(notRepoDetail).toMatch(/not a git repository/i);
    expect(noGitDetail).toMatch(/not found|not installed/i);
    expect(notRepoDetail).not.toEqual(noGitDetail);
  });

  it('degrades to a fail with an informative detail when the config is invalid', async () => {
    const { ctx } = await testContext({ gitDefault: gitOk() });

    const result = await baseBranchCheck.run(ctx);

    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/config/i);
  });
});

describe('commands-resolvable (required)', () => {
  const gitReady = { gitDefault: gitOk() };

  it('passes and says so when the project declares no commands', async () => {
    const { ctx } = await testContext({ config: MINIMAL_CONFIG, ...gitReady });

    const result = await commandsResolvableCheck.run(ctx);

    expect(result.status).toBe('pass');
    expect(result.detail).toMatch(/no commands declared/i);
  });

  it('resolves a bare token through a PATH scan, never through a shell', async () => {
    const { ctx } = await testContext({
      config: [MINIMAL_CONFIG, 'setup:', '  install: pnpm install --frozen-lockfile'].join('\n'),
      pathVar: '/usr/local/bin:/usr/bin',
      executableFiles: ['/usr/local/bin/pnpm'],
    });

    expect((await commandsResolvableCheck.run(ctx)).status).toBe('pass');
  });

  const relativeGate = [
    MINIMAL_CONFIG,
    'gates:',
    '  - id: smoke',
    '    run: ./scripts/smoke.sh',
  ].join('\n');

  it('resolves a relative path against the project root', async () => {
    const projectRoot = await makeProject(relativeGate);
    const ctx = createDoctorContext({
      projectRoot,
      nodeVersion: 'v22.20.0',
      pathVar: '',
      effects: fakeEffects({ executableFiles: [join(projectRoot, 'scripts', 'smoke.sh')] }),
    });

    expect((await commandsResolvableCheck.run(ctx)).status).toBe('pass');
  });

  it('names the config id and the offending token when a path does not resolve', async () => {
    const { ctx } = await testContext({ config: relativeGate });

    const result = await commandsResolvableCheck.run(ctx);

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('gates[smoke]');
    expect(result.detail).toContain('./scripts/smoke.sh');
  });

  it('lists every unresolvable command, not just the first', async () => {
    const { ctx } = await testContext({
      config: [
        MINIMAL_CONFIG,
        'gates:',
        '  - id: lint',
        '    run: nosuchlinter',
        '  - id: test',
        '    run: nosuchrunner',
        'observations:',
        '  company-count:',
        '    run: nosuchprobe',
      ].join('\n'),
      pathVar: '/usr/bin',
    });

    const result = await commandsResolvableCheck.run(ctx);

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('nosuchlinter');
    expect(result.detail).toContain('nosuchrunner');
    expect(result.detail).toContain('nosuchprobe');
  });

  it('scans a readiness command but never a readiness url', async () => {
    const { ctx } = await testContext({
      config: [
        MINIMAL_CONFIG,
        'services:',
        '  web:',
        '    run: /usr/bin/serve',
        '    ready:',
        '      url: http://127.0.0.1:3000/health',
      ].join('\n'),
      executableFiles: ['/usr/bin/serve'],
    });

    const result = await commandsResolvableCheck.run(ctx);

    expect(result.status).toBe('pass');
    expect(result.detail).not.toContain('http');
  });

  it('reports a file that exists but is not executable, distinctly', async () => {
    const { ctx } = await testContext({
      config: [MINIMAL_CONFIG, 'data:', '  reset: /opt/reset.sh'].join('\n'),
      existingPaths: ['/opt/reset.sh'],
    });

    const result = await commandsResolvableCheck.run(ctx);

    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/not executable/i);
  });

  it('degrades to a fail with an informative detail when the config is invalid', async () => {
    const { ctx } = await testContext();

    const result = await commandsResolvableCheck.run(ctx);

    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/config/i);
  });
});

describe('playwright-capability (optional)', () => {
  it('is optional, so a missing browser stack never fails doctor', () => {
    expect(playwrightCapabilityCheck.required).toBe(false);
  });

  it('passes when @playwright/test resolves from the project root', async () => {
    const { ctx } = await testContext({
      config: MINIMAL_CONFIG,
      resolvableModules: ['@playwright/test'],
    });

    expect((await playwrightCapabilityCheck.run(ctx)).status).toBe('pass');
  });

  it('warns — never fails — when it does not, pointing at Epic 5 provisioning', async () => {
    const { ctx } = await testContext({ config: MINIMAL_CONFIG });

    const result = await playwrightCapabilityCheck.run(ctx);

    expect(result.status).toBe('warn');
    expect(result.detail).toMatch(/browser/i);
  });
});

describe('ports-free (optional)', () => {
  const withPorts = [
    MINIMAL_CONFIG,
    'services:',
    '  web:',
    '    run: /usr/bin/serve',
    '    port: 3000',
    '    ready:',
    '      url: http://127.0.0.1:3000/health',
  ].join('\n');

  it('is optional: an occupied port warns and leaves the exit code alone', () => {
    expect(portsFreeCheck.required).toBe(false);
  });

  it('passes when every declared port binds', async () => {
    const { ctx } = await testContext({ config: withPorts });

    expect((await portsFreeCheck.run(ctx)).status).toBe('pass');
  });

  it('warns naming the port and how to find the holder', async () => {
    const { ctx } = await testContext({
      config: withPorts,
      occupiedPorts: { 3000: 'EADDRINUSE' },
    });

    const result = await portsFreeCheck.run(ctx);

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('3000');
    expect(result.detail).toContain('lsof');
  });

  it('passes when no service declares a port', async () => {
    const { ctx } = await testContext({ config: MINIMAL_CONFIG });

    const result = await portsFreeCheck.run(ctx);

    expect(result.status).toBe('pass');
    expect(result.detail).toMatch(/no .*ports/i);
  });

  it('warns rather than fails when the config is invalid', async () => {
    const { ctx } = await testContext();

    const result = await portsFreeCheck.run(ctx);

    expect(result.status).toBe('warn');
    expect(result.detail).toMatch(/config/i);
  });
});

describe('BUILTIN_CHECKS', () => {
  it('is ordered deterministically, cheap runtime checks first', () => {
    expect(BUILTIN_CHECKS.map((check) => check.id)).toEqual([
      'node-version',
      'git-present',
      'config-valid',
      'base-branch-exists',
      'commands-resolvable',
      'playwright-capability',
      'ports-free',
    ]);
  });

  it('marks exactly the environment/config checks as required', () => {
    const required = BUILTIN_CHECKS.filter((check) => check.required).map((check) => check.id);

    expect(required).toEqual([
      'node-version',
      'git-present',
      'config-valid',
      'base-branch-exists',
      'commands-resolvable',
    ]);
  });

  it('contains no provider check: those are story 2.7, via the registry', () => {
    const ids = BUILTIN_CHECKS.map((check) => check.id).join(' ');

    expect(ids).not.toMatch(/claude|codex|provider|auth|billing/i);
  });
});
