import { defineConfig } from 'vitest/config';

/**
 * The provisioning entry point — story 6.9, AC3. `pnpm provision:browser`.
 *
 * ⚠️ **A SEPARATE CONFIG, AND THAT IS THE SAFETY PROPERTY.** `vitest.config.ts` collects
 * `tests/** /*.test.ts`. The file this config runs is named `.provision.ts`, so the default
 * glob cannot reach it — `pnpm test` cannot npm-install a package and download ~150MB of
 * browser by accident, on a laptop or in the auto-review's concurrent run in the agent's own
 * worktree (H-8).
 *
 * It is also why the provisioning is its OWN CI step rather than a `globalSetup` on the
 * browser run: the download's wall-clock, cached and uncached, is a number story 6.9's PR body
 * has to report and the owner's promotion decision depends on. A step has a duration; a
 * `globalSetup` hides inside somebody else's.
 *
 * No `globalSetup` here on purpose: `tests/setup/build-cli.ts` builds `dist/cli.js` for the
 * integration suites that drive the real binary, and nothing in this file does.
 */
export default defineConfig({
  test: {
    include: ['tests/provisioning/*.provision.ts'],
    environment: 'node',
    // A cold `npm install` plus a cold chromium download. The per-command bound lives in the
    // provisioning file's own `timeoutMs`; this is only vitest's outer bound on the case.
    testTimeout: 11 * 60_000,
    hookTimeout: 60_000,
    // The two cases share the browser registry and the second reads what the first wrote, so
    // they must not run concurrently.
    fileParallelism: false,
  },
});
