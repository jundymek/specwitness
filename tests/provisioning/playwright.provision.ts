/**
 * Story 5.1's provisioning path, RUN FOR REAL — story 6.9, AC3.
 *
 * ============================================================================
 * ⚠️ WHY THIS FILE EXISTS AT ALL
 * ============================================================================
 *
 * `provisionPlaywright` (`src/infra/playwright-env.ts:931`) has **no production call site**.
 * `src/cli/doctor/effects.ts:82` records the reason deliberately — *"lives behind
 * `provisionPlaywright`, which `doctor` does not call"* — and
 * `src/cli/doctor/checks/playwright-capability.ts:23` says the same from the other side:
 * *"Nothing is downloaded."* Every other reference in the repository is a unit test driving
 * an INJECTED `ProcessRunner` (`tests/unit/infra/playwright-env.test.ts`).
 *
 * So the code that npm-installs Playwright and downloads a browser has, across two epics,
 * never installed anything or downloaded anything. Epic 5's retro §9 names it exactly: *"a
 * real browser download — performed by no gate on any platform in this epic; provisioning is
 * proven against an injected `ProcessRunner`."* This file is the entry point that closes
 * that, and the CI job runs it before the browser suites.
 *
 * ============================================================================
 * ⚠️ WHY IT IS NOT A `*.test.ts`
 * ============================================================================
 *
 * `vitest.config.ts` collects `tests/** /*.test.ts`. A file named `.provision.ts` is invisible
 * to that glob and therefore to `pnpm test`, which is the point: this file installs a package
 * over the network and downloads ~150MB of browser. A developer running `pnpm test` — or the
 * auto-review running it concurrently in the agent's own worktree (H-8) — must never trigger
 * that by accident. It runs only through `pnpm provision:browser`, which names
 * `vitest.provision.config.ts` explicitly.
 *
 * It is a vitest file rather than a plain script because the module under test is TypeScript
 * that imports its siblings with `.js` specifiers; vitest is the project's own tool for
 * running exactly that, and it needs no new dependency to do it.
 *
 * ============================================================================
 * ⚠️ WHAT IS DELIBERATELY NOT SET
 * ============================================================================
 *
 * **No `PLAYWRIGHT_BROWSERS_PATH` and no `XDG_CACHE_HOME` in `process.env`.** 5.1's header
 * states that both are *input, not authority* and that a value under the project root is
 * refused outright; setting either carelessly silently changes WHICH of the three resolution
 * branches runs, and the job would then be proving a path no user takes. Case 2 below does
 * pass a synthetic `env`/`homeDir` — but as explicit ARGUMENTS to the resolver, which is what
 * `PlaywrightEnvironmentInputs` exists for, leaving the real process environment untouched.
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { SystemClock } from '../../src/infra/clock.js';
import {
  PROVISIONED_BROWSER,
  PROVISIONED_PLAYWRIGHT_VERSION,
  provisionPlaywright,
  resolvePlaywrightEnvironment,
  specwitnessPlaywrightCacheDir,
} from '../../src/infra/playwright-env.js';
import { createProcessRunner } from '../../src/infra/process-runner.js';

/**
 * A browser download is minutes, not seconds, and 5.1's `ProvisionOptions.timeoutMs` is a
 * PER-COMMAND budget. Ten minutes bounds a cold `npm install` plus a cold chromium fetch on a
 * slow runner while still guaranteeing termination.
 */
const PROVISION_TIMEOUT_MS = 10 * 60_000;

const clock = new SystemClock();

/**
 * AD-8. Every process group 5.1 spawns is recorded here and printed, because this story's AC4
 * is about what survives — and a group id nobody wrote down is a group nobody can reap.
 * `RunStore.recordProcessGroup` is the intended production use; there is no run here, so the
 * groups go to stdout as evidence instead.
 */
const processGroups: number[] = [];

function report(title: string, lines: readonly string[]): void {
  process.stdout.write(`\n[specwitness] ${title}\n${lines.map((l) => `  ${l}`).join('\n')}\n`);
}

/* ── case 1: this repository's own Playwright ────────────────────────────────────────── */

/**
 * Route 2 of 5.1's three — *"the project has it → download only the browsers, into the
 * PROJECT's own Playwright registry"*.
 *
 * ⚠️ **AND IT IS THE ROUTE CI ACTUALLY TAKES, WHICH IS NOT WHAT THIS STORY'S SPEC PREDICTED.**
 * The spec says `@playwright/test` being an optional peer means *"`pnpm install
 * --frozen-lockfile` does not bring it"*. That is half right and the half that is wrong
 * changes which branch runs: pnpm resolves the optional peer into the root importer's
 * dependencies in `pnpm-lock.yaml` (line 11), so `pnpm install --frozen-lockfile` DOES install
 * the package — what is missing on a fresh runner is the BROWSER BINARIES. The proof is the
 * baseline CI log itself: `browser-fixture.ts`'s `announce()` prints its reason from
 * `source === 'absent' ? reason : 'no browsers are downloaded'`, and run 33881286844 printed
 * `no browsers are downloaded` on both platforms — the `absent` branch was not taken.
 */
it(
  'provisions this repository through the project route, for real',
  async () => {
    const projectRoot = process.cwd();

    const before = await resolvePlaywrightEnvironment({ projectRoot });
    report('BEFORE (this repository)', [
      `source:          ${before.source}`,
      `version:         ${before.version ?? '(unreadable)'}`,
      `browsersPath:    ${before.browsersPath}`,
      `browsersFromEnv: ${before.browsersPathFromEnv}`,
      `browsersPresent: ${before.browsersPresent}`,
      `ready:           ${before.ready}`,
      ...(before.source === 'absent' ? [`reason:          ${before.reason}`] : []),
    ]);

    const after = await provisionPlaywright({
      projectRoot,
      runner: createProcessRunner(clock),
      timeoutMs: PROVISION_TIMEOUT_MS,
      onProcessGroup: (pgid) => {
        processGroups.push(pgid);
      },
    });

    report('AFTER (this repository)', [
      `source:          ${after.source}`,
      `version:         ${after.version ?? '(unreadable)'}`,
      `packageDir:      ${after.packageDir}`,
      `cliPath:         ${after.cliPath}`,
      `browsersPath:    ${after.browsersPath}`,
      `browsersPresent: ${after.browsersPresent}`,
      `ready:           ${after.ready}`,
      `process groups:  ${processGroups.length === 0 ? '(none spawned - already provisioned)' : processGroups.join(', ')}`,
    ]);

    // The single "can 5.2 run?" bit. If this is false the browser suites would skip, and the
    // whole job would report green having proved nothing — the exact defect 6.9 exists to fix.
    expect(after.ready, 'the browser suites will skip unless this environment is ready').toBe(true);
    expect(after.browsersPresent).toBe(true);
    expect(after.source).toBe('project');
  },
  PROVISION_TIMEOUT_MS + 60_000,
);

/* ── case 2: the route an END USER takes ─────────────────────────────────────────────── */

/**
 * Route 3 — *"nothing usable → `npm install` into SpecWitness's cache, then download chromium
 * into `<cacheDir>/browsers`"*.
 *
 * This is the branch a CONSUMER of the published CLI hits: they install `specwitness`, they
 * have no Playwright of their own, and `installPackageIntoCache` runs. Case 1 never reaches
 * it, because this repository declares the package. Proving only case 1 would leave
 * `prepareCacheDirectory` and `installPackageIntoCache` exactly as unproven as they were
 * before this story.
 *
 * ⚠️ **THE COST IS DELIBERATELY BOUNDED.** A second real chromium download would be another
 * ~150MB for a path that differs from case 1 only in where the PACKAGE lands. So the synthetic
 * environment points `PLAYWRIGHT_BROWSERS_PATH` at the registry case 1 already populated:
 * `installBrowsers` still runs, through the same `ProcessRunner`, with the same argv — and
 * Playwright finds the bundle present and returns in seconds. What this case proves is the npm
 * install into an owned cache, the resolution of that cache as `specwitness-cache`, and
 * `requireReady`. What it does NOT prove is a browser download into `<cacheDir>/browsers`; case
 * 1 proves the download itself.
 *
 * `env` and `homeDir` are passed as ARGUMENTS. `process.env` is not touched, so nothing here
 * can change which branch case 1 or the suites themselves resolve.
 */
it(
  "provisions an end user's empty project through the SpecWitness-cache route, for real",
  async () => {
    // A project with no `node_modules` at all: resolution must answer `absent`.
    const projectRoot = await mkdtemp(join(tmpdir(), 'specwitness-empty-project-'));
    await writeFile(
      join(projectRoot, 'package.json'),
      `${JSON.stringify({ name: 'a-project-without-playwright', version: '0.0.0', private: true }, null, 2)}\n`,
      'utf8',
    );

    // A cache root of our own, outside the project and outside the real one, so this case
    // cannot disturb the environment the browser suites will resolve a moment later.
    const homeDir = await mkdtemp(join(tmpdir(), 'specwitness-empty-home-'));
    const realEnvironment = await resolvePlaywrightEnvironment({ projectRoot: process.cwd() });
    const env = {
      ...process.env,
      // Bounded cost, explained above: the browsers case 1 downloaded, reused verbatim.
      PLAYWRIGHT_BROWSERS_PATH: realEnvironment.browsersPath,
    };

    const before = await resolvePlaywrightEnvironment({ projectRoot, env, homeDir });
    const paths = specwitnessPlaywrightCacheDir({ env, homeDir, platform: process.platform });
    report("BEFORE (an end user's empty project)", [
      `projectRoot:     ${projectRoot}`,
      `source:          ${before.source}`,
      `cacheDir:        ${paths.cacheDir}`,
      `browsersPath:    ${paths.browsersPath}`,
      ...(before.source === 'absent' ? [`reason:          ${before.reason}`] : []),
    ]);

    expect(
      before.source,
      'this case is only meaningful if the empty project really resolves nothing',
    ).toBe('absent');

    const after = await provisionPlaywright({
      projectRoot,
      env,
      homeDir,
      runner: createProcessRunner(clock),
      timeoutMs: PROVISION_TIMEOUT_MS,
      onProcessGroup: (pgid) => {
        processGroups.push(pgid);
      },
    });

    report("AFTER (an end user's empty project)", [
      `source:          ${after.source}`,
      `version:         ${after.version ?? '(unreadable)'}`,
      `packageDir:      ${after.packageDir}`,
      `browsersPath:    ${after.browsersPath}`,
      `browsersPresent: ${after.browsersPresent}`,
      `ready:           ${after.ready}`,
      `process groups:  ${processGroups.join(', ')}`,
    ]);

    expect(after.source, 'the fallback must install into SpecWitness\'s OWN cache').toBe(
      'specwitness-cache',
    );
    expect(after.ready).toBe(true);
    expect(after.version).toBe(PROVISIONED_PLAYWRIGHT_VERSION);

    // The package landed in the cache and NOT in the project — 5.1's AC1, which until now was
    // asserted only against an injected runner. `packageDir` is realpath'd, so compare against
    // the project root by prefix rather than by equality.
    expect(
      after.packageDir.startsWith(projectRoot),
      `a verifier must never write into the project it verifies; packageDir was ${after.packageDir}`,
    ).toBe(false);

    report('PROVISIONING SUMMARY', [
      `browser:         ${PROVISIONED_BROWSER}`,
      `pinned version:  ${PROVISIONED_PLAYWRIGHT_VERSION}`,
      `process groups:  ${processGroups.length} recorded (${processGroups.join(', ') || 'none'})`,
    ]);
  },
  PROVISION_TIMEOUT_MS + 60_000,
);
