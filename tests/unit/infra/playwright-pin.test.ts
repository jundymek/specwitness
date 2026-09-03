/**
 * Story 5.1 — the `@playwright/test` pin, asserted rather than remembered.
 *
 * Two facts have to agree and live in different files: the version this
 * repository depends on (`package.json`), and the version SpecWitness installs
 * into its OWN cache for a project that has none
 * (`PROVISIONED_PLAYWRIGHT_VERSION`). Nothing but this test connects them, and
 * a cache pinned to a version the build was never exercised against is a silent
 * change to expected behaviour — the class of thing the contract-freeze rule
 * exists to forbid.
 *
 * The pin is EXACT on purpose. A range would let `pnpm install` move the
 * browser stack under a frozen contract without anybody deciding to.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PLAYWRIGHT_PACKAGE,
  PROVISIONED_PLAYWRIGHT_VERSION,
} from '../../../src/infra/playwright-env.js';

interface Manifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

function manifest(): Manifest {
  return JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as Manifest;
}

describe('the @playwright/test pin', () => {
  it('is a runtime dependency, not a devDependency', () => {
    // `files` ships `dist` alone, so a published `specwitness` that had
    // Playwright only in devDependencies could not drive a browser probe on a
    // machine that installed the CLI. Story 5.1 owns this line; no other story
    // in Epic 5 touches the dependency.
    expect(manifest().dependencies?.[PLAYWRIGHT_PACKAGE]).toBeDefined();
    expect(manifest().devDependencies?.[PLAYWRIGHT_PACKAGE]).toBeUndefined();
  });

  it('is pinned exactly — no caret, no tilde, no range', () => {
    const declared = manifest().dependencies?.[PLAYWRIGHT_PACKAGE];

    expect(declared).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is the same version SpecWitness provisions into its own cache', () => {
    expect(manifest().dependencies?.[PLAYWRIGHT_PACKAGE]).toBe(PROVISIONED_PLAYWRIGHT_VERSION);
  });
});
