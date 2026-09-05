/**
 * How many suites are gated behind a browser, and which (story 6.1, the skipped-suite rider).
 *
 * PURE — a static read of the test tree. It spawns nothing and it MODIFIES NOTHING: story
 * 6.9, in wave 2, owns `describeWithBrowser` and the five suites below, and this file
 * deliberately touches neither. Making the skipping legible is 6.1's job; making it stop is
 * 6.9's.
 *
 * ⚠️ **WHY A COUNT IS ASSERTED AT ALL.** `describeWithBrowser`
 * (`tests/integration/surfaces/helpers/browser-fixture.ts:114`) calls `describe.skip` when
 * no usable Playwright environment is present. `@playwright/test` is an optional peer and
 * nothing downloads a browser on a CI runner, so on every CI run today these five files
 * self-skip and the job still goes green — *green for nothing* (Epic 4 retro §2 observation
 * 2) one level up from a criterion.
 *
 * `scripts/report-skipped-suites.mjs` makes that visible in the CI job summary. This test
 * makes a CHANGE to it visible: a sixth browser-gated file appearing, or one of these five
 * quietly losing its gate, is a fact about how much CI actually proves — and a fact nobody
 * would otherwise notice, because both directions leave the suite green. The list is
 * checked in so the diff that changes it is the diff a reviewer reads.
 *
 * That file's own header records this guard failing once already: its first version
 * resolved the environment in `beforeAll`, always read `undefined`, always chose `describe`,
 * and passed only because the author's machine had a browser — "exactly how a guard stops
 * guarding without anybody noticing".
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SURFACES = fileURLToPath(
  new URL('../integration/surfaces/', import.meta.url),
);

/**
 * The five browser-gated suites, as of story 6.1 (Epic 5 merged all five).
 *
 * Story 6.9 provisions chromium in a non-blocking CI job; it does not remove the gate, so
 * this list is expected to survive it. If you are changing this list, say in your PR body
 * how many suites now run in CI and how many still do not.
 */
const EXPECTED_BROWSER_GATED_FILES = [
  'browser-adaptation.test.ts',
  'browser-combined-evidence.test.ts',
  'browser-dispatch.test.ts',
  'browser-security.test.ts',
  'browser.test.ts',
];

describe('the browser-gated integration suites', () => {
  it('are exactly the five this repository knows about', async () => {
    const entries = await readdir(SURFACES, { withFileTypes: true });

    const gated: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.test.ts')) {
        continue;
      }
      const text = await readFile(join(SURFACES, entry.name), 'utf8');
      if (text.includes('describeWithBrowser(')) {
        gated.push(entry.name);
      }
    }

    expect(
      gated.sort(),
      'The set of browser-gated suites changed. On every CI runner today these suites do ' +
        'not run, so this number is exactly how much of the browser surface a green check ' +
        'does NOT cover. Update the list here and say so in your PR body — story 6.9 owns ' +
        'making them run.',
    ).toEqual(EXPECTED_BROWSER_GATED_FILES);
  });
});
