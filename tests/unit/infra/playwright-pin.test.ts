/**
 * Story 5.1 — the `@playwright/test` declaration, asserted rather than remembered.
 *
 * Two facts have to agree and live in different files: the version this
 * repository declares (`package.json`), and the version SpecWitness installs
 * into its OWN cache for a project that has none
 * (`PROVISIONED_PLAYWRIGHT_VERSION`). Nothing but this test connects them, and
 * a cache pinned to a version the build was never exercised against is a silent
 * change to expected behaviour — the class of thing the contract-freeze rule
 * exists to forbid.
 *
 * The pin is EXACT on purpose. A range would let `pnpm install` move the
 * browser stack under a frozen contract without anybody deciding to.
 *
 * OPTIONAL PEER, NOT A RUNTIME DEPENDENCY, and that is a recorded architecture
 * decision rather than a packaging preference. The spine's Stack table has said
 * so since 2026-08-30: *"@playwright/test (optional peer; consumed as test
 * runner over generated spec files) | 1.62.x"*, and its own review (F-5) calls
 * the pattern out by name — `peerDependencies` plus
 * `peerDependenciesMeta.optional: true`.
 *
 * WHAT MAKES IT VIABLE IS THIS STORY'S OWN FALLBACK. An optional peer means a
 * consumer who never opens a browser installs nothing, and a consumer who does
 * either brings their own — which is FR-24's "the project's installation wins"
 * expressed in packaging — or gets one provisioned into SpecWitness's cache by
 * `provisionPlaywright`. A plain `dependency` would force every install of the
 * CLI to carry a browser runner that most verification runs never touch.
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
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>;
}

function manifest(): Manifest {
  return JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as Manifest;
}

describe('the @playwright/test declaration', () => {
  it('is an OPTIONAL PEER — the spine Stack table records this, not a preference', () => {
    const declared = manifest();

    expect(declared.peerDependencies?.[PLAYWRIGHT_PACKAGE]).toBeDefined();
    expect(declared.peerDependenciesMeta?.[PLAYWRIGHT_PACKAGE]?.optional).toBe(true);
  });

  it('is neither a runtime dependency nor a devDependency', () => {
    // Both would be a second answer to a question the spine already answered.
    // A runtime `dependency` in particular would make every install of the CLI
    // carry a browser runner that most verification runs never open.
    const declared = manifest();

    expect(declared.dependencies?.[PLAYWRIGHT_PACKAGE]).toBeUndefined();
    expect(declared.devDependencies?.[PLAYWRIGHT_PACKAGE]).toBeUndefined();
  });

  it('is pinned exactly — no caret, no tilde, no range', () => {
    expect(manifest().peerDependencies?.[PLAYWRIGHT_PACKAGE]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is the same version SpecWitness provisions into its own cache', () => {
    expect(manifest().peerDependencies?.[PLAYWRIGHT_PACKAGE]).toBe(PROVISIONED_PLAYWRIGHT_VERSION);
  });

  /**
   * The declaration is only half the story: several things in this suite need
   * the package to be PRESENT in this worktree — the hoisting-hazard test's
   * whole premise is that this repository has it while a fixture project does
   * not, and `doctor` here reports it from the project.
   *
   * pnpm's `auto-install-peers` is what puts it in dev `node_modules`. If that
   * ever stops being true, this test says so directly instead of letting the
   * hoisting-hazard test quietly become vacuous — a guard whose premise has
   * evaporated passes for the wrong reason, which is the failure mode this
   * story has already met once.
   */
  it('is nevertheless installed in this worktree, which other tests depend on', async () => {
    await expect(import(PLAYWRIGHT_PACKAGE)).resolves.toBeDefined();
  });
});
