/**
 * Story 5.1, AC2 — `doctor` reports Playwright capability.
 *
 * AC2 names THREE DISTINCT FACTS and the check must report all three: which
 * Playwright would be used (project / SpecWitness cache / absent), its version,
 * and whether the browsers it needs are actually installed. A resolvable
 * `@playwright/test` with no downloaded chromium is a real and common state,
 * and reporting it as "present" would make `doctor` green immediately before a
 * run fails.
 *
 * NOTHING HERE DOWNLOADS ANYTHING, and nor does the check: the merged module
 * header forbids it in terms — *"a diagnostic command that silently pulls
 * hundreds of megabytes would be a bad citizen"*. The environment is injected
 * through `DoctorEffects`, exactly as story 2.7's provider probes are, so the
 * check stays pure logic over an injected surface.
 */

import { describe, expect, it } from 'vitest';

import { playwrightCapabilityCheck } from '../../../src/cli/doctor/checks/playwright-capability.js';
import { BUILTIN_CHECKS } from '../../../src/cli/doctor/checks/index.js';
import { hasRequiredFailure, renderHuman, renderJson } from '../../../src/cli/doctor/render.js';
import { createRegistry } from '../../../src/cli/doctor/registry.js';
import type { PlaywrightEnvironment } from '../../../src/infra/playwright-env.js';

import { MINIMAL_CONFIG, testContext } from './helpers.js';

const CACHE = '/home/dev/.cache/specwitness/playwright';

function projectReady(overrides: Partial<PlaywrightEnvironment> = {}): PlaywrightEnvironment {
  return {
    source: 'project',
    packageDir: '/work/app/node_modules/@playwright/test',
    cliPath: '/work/app/node_modules/@playwright/test/cli.js',
    version: '1.44.0',
    browsersPath: '/home/dev/.cache/ms-playwright',
    browsersPathFromEnv: false,
    browsersPresent: true,
    ready: true,
    cacheDir: CACHE,
    ...overrides,
  } as PlaywrightEnvironment;
}

const ABSENT: PlaywrightEnvironment = {
  source: 'absent',
  version: null,
  browsersPresent: false,
  ready: false,
  cacheDir: CACHE,
  browsersPath: `${CACHE}/browsers`,
  browsersPathFromEnv: false,
  reason: '@playwright/test does not resolve from /work/app and is not in the SpecWitness cache',
};

async function run(playwright: PlaywrightEnvironment): Promise<{ status: string; detail: string }> {
  const { ctx } = await testContext({ config: MINIMAL_CONFIG, playwright });
  return await playwrightCapabilityCheck.run(ctx);
}

describe('playwright-capability (optional)', () => {
  it('stays optional, so a missing browser stack never fails doctor', () => {
    expect(playwrightCapabilityCheck.required).toBe(false);
  });

  it('keeps its registered position, because the --json check order is a contract', () => {
    // `checks/index.ts` says appended, never interleaved. Anything that moved
    // this entry would change a shape the harness already parses.
    expect(BUILTIN_CHECKS.map((check) => check.id)).toEqual([
      'node-version',
      'git-present',
      'config-valid',
      'base-branch-exists',
      'commands-resolvable',
      'playwright-capability',
      'ports-free',
      'billing-risk-env',
      'ai-providers',
    ]);
  });

  it('passes and names source, version and browsers when the project is ready', async () => {
    const result = await run(projectReady());

    expect(result.status).toBe('pass');
    expect(result.detail).toMatch(/project/i);
    expect(result.detail).toContain('1.44.0');
    expect(result.detail).toMatch(/browsers.*(present|installed)/i);
  });

  it('names the SpecWitness cache — and where it is — when that is the source', async () => {
    const result = await run(
      projectReady({
        source: 'specwitness-cache',
        packageDir: `${CACHE}/node_modules/@playwright/test`,
        version: '1.62.1',
        browsersPath: `${CACHE}/browsers`,
      }),
    );

    expect(result.status).toBe('pass');
    expect(result.detail).toMatch(/specwitness cache/i);
    expect(result.detail).toContain(CACHE);
  });

  /**
   * THE THIRD FACT, on its own. This is the state that would otherwise make
   * doctor green over a machine that cannot open a browser.
   */
  it('warns — never passes — when the package resolves but no browser is downloaded', async () => {
    const result = await run(projectReady({ browsersPresent: false, ready: false }));

    expect(result.status).toBe('warn');
    expect(result.detail).toMatch(/1\.44\.0/);
    expect(result.detail).toMatch(/no .*browser|not downloaded|browsers: no/i);
    expect(result.detail).toContain('HINT:');
  });

  it('warns and hints at provisioning when Playwright is absent', async () => {
    const result = await run(ABSENT);

    expect(result.status).toBe('warn');
    // ALL THREE OF AC2's FACTS, on the path where they matter most: an operator
    // reading this is trying to find out what is missing. Reporting only the
    // source made the output incomplete on exactly an unprovisioned machine.
    expect(result.detail).toMatch(/source:\s*absent/i);
    expect(result.detail).toMatch(/version:\s*unknown/i);
    expect(result.detail).toMatch(/browsers:\s*absent/i);
    expect(result.detail).toContain('HINT:');
    // The hint must name the cache the operator's bytes would land in — this is
    // the only work in five epics that writes outside the repository.
    expect(result.detail).toContain(CACHE);
  });

  it('reports an unknown version rather than pretending it read one', async () => {
    const result = await run(projectReady({ version: null }));

    expect(result.detail).toMatch(/unknown/i);
  });

  it('never downloads: a probe failure is reported, not retried or provisioned', async () => {
    const { ctx } = await testContext({
      config: MINIMAL_CONFIG,
      playwrightError: new Error('EACCES: permission denied, scandir'),
    });

    const result = await playwrightCapabilityCheck.run(ctx);

    expect(result.status).toBe('warn');
    expect(result.detail).toMatch(/EACCES/);
  });
});

describe('an optional playwright warning and the exit code', () => {
  it('leaves doctor’s exit code alone and renders on both channels', async () => {
    const { ctx } = await testContext({ config: MINIMAL_CONFIG, playwright: ABSENT });
    const reports = await createRegistry([playwrightCapabilityCheck]).runAll(ctx);

    // A `warn` never affects the exit code (`render.ts#hasRequiredFailure`),
    // which is what keeps an unprovisioned Playwright from failing a diagnostic
    // command on a project that will never open a browser.
    expect(hasRequiredFailure(reports)).toBe(false);

    // `HINT:` travels ON THE DETAIL rather than through a second output
    // channel, so it reaches stderr wherever the detail does — which in
    // `--json` mode is the human rendering the command writes to stderr.
    expect(renderHuman(reports)).toContain('HINT:');

    const json: unknown = JSON.parse(renderJson(reports, '2026-09-03T00:00:00.000Z'));
    const checks = (json as { checks: { id: string; status: string; detail: string }[] }).checks;
    expect(checks).toHaveLength(1);
    expect(checks[0]?.id).toBe('playwright-capability');
    expect(checks[0]?.status).toBe('warn');
    expect(checks[0]?.detail).toContain('HINT:');
  });
});
