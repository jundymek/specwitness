import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The PUBLISH SURFACE, as a test rather than a promise (story 6.7, AC2).
 *
 * ⚠️ THIS FILE IS THE MANIFEST HALF ONLY, AND THE DIVISION IS DELIBERATE.
 * `scripts/pack-smoke.sh` asserts what a real `npm pack` actually PRODUCED — it packs,
 * lists the tarball, installs it into a throwaway directory and runs the binary. That is
 * the assertion that matters, because `files` and the tarball disagree in ways only
 * packing reveals (`.npmignore`, npm's always-include rules, a `files` entry matching
 * nothing). It runs in CI on ubuntu-latest AND macos-latest.
 *
 * What it cannot do cheaply is fail FAST and LOCALLY on a manifest edit. Packing costs a
 * build, a registry install and ~20s; the checks below cost a `readFile` and run inside
 * `pnpm test`. So this file guards the declarations a developer actually edits, and the
 * shell script guards the artifact they never look at. Neither replaces the other, and
 * a claim proved only here is a claim about `package.json`, never about the tarball.
 */

const MANIFEST = fileURLToPath(new URL('../../package.json', import.meta.url));

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly bin: Record<string, string>;
  readonly files: readonly string[];
  readonly engines: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

async function manifest(): Promise<Manifest> {
  return JSON.parse(await readFile(MANIFEST, 'utf8')) as Manifest;
}

describe('the published package declares the surface story 6.7 documents', () => {
  it('ships the built CLI and templates and nothing else', async () => {
    // Order-independent: `files` is a set, and a reorder is not a regression.
    expect([...(await manifest()).files].sort()).toEqual(['dist', 'templates']);
  });

  it('maps the specwitness bin to the built entry point', async () => {
    // The README and the integration guide both tell a reader to run `npx specwitness`;
    // that only works because of this mapping. `pack-smoke.sh` proves the mapped file is
    // executable once installed — here we only prove we asked for the right one.
    expect((await manifest()).bin).toEqual({ specwitness: 'dist/cli.js' });
  });

  it('declares the ADR-007 Node floor', async () => {
    // ADR-007 raised this from 22.12 to 22.13 (pnpm 11.24.0 requires it). CI pins
    // `node-version: '22.13'` to this exact floor, and the README documents it, so a
    // change here without a change there would make one of the three a lie.
    expect((await manifest()).engines.node).toBe('>=22.13');
  });

  it('carries a plain semver version, which is what the dist-tag plan assumes', async () => {
    // Deliberately strict: MAJOR.MINOR.PATCH with no prerelease and no build metadata.
    // The `next` dist-tag plan in docs/versioning.md says a prerelease is published under
    // `next` and a plain version under `latest`; a version that is prerelease-shaped on
    // the branch would mean the plan's two cases had silently become one.
    expect((await manifest()).version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('the product rules that are visible in the manifest', () => {
  /**
   * CLAUDE.md, first non-negotiable rule: "No direct LLM API usage. AI is delegated to
   * local `claude` / `codex` CLIs as subprocesses. An `@anthropic-ai/sdk` or `openai`
   * dependency in `package.json` is a defect, not a convenience."
   *
   * The README makes that a promise to a reader, and a promise a reader cannot check is
   * worth nothing — so it is checked here, over EVERY dependency block including
   * `devDependencies`. A model SDK pulled in "just for a test" would ship the same
   * capability and break the same rule.
   */
  const FORBIDDEN = [
    '@anthropic-ai/sdk',
    'openai',
    '@google/generative-ai',
    '@mistralai/mistralai',
    'cohere-ai',
    'langchain',
  ];

  it('depends on no direct model-API SDK, in any dependency block', async () => {
    const pkg = await manifest();
    const declared = Object.keys({
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
    });

    // Asserting the intersection rather than looping gives a failure that NAMES the
    // offending package instead of only the first one it happened to reach.
    expect(declared.filter((name) => FORBIDDEN.includes(name))).toEqual([]);
  });

  it('keeps its runtime dependency set small enough to state in the README', async () => {
    // The README tells a reader exactly what `npm install specwitness` pulls in. That
    // sentence goes stale silently, so it is pinned: adding a runtime dependency is a
    // decision that must also update the documentation.
    expect(Object.keys((await manifest()).dependencies ?? {}).sort()).toEqual([
      'commander',
      'execa',
      'yaml',
      'zod',
    ]);
  });

  it('keeps @playwright/test an OPTIONAL peer, never a runtime dependency', async () => {
    // The README says browser verification needs Playwright and that everything else
    // works without it. That is only true while this stays an optional peer: promoting
    // it to `dependencies` would put a ~150MB browser toolchain in the install path of
    // every user who only ever runs gates and HTTP probes.
    const pkg = await manifest();
    expect(pkg.peerDependencies?.['@playwright/test']).toBe('1.62.1');
    expect(pkg.dependencies?.['@playwright/test']).toBeUndefined();
  });
});
