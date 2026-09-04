/**
 * Does the browser CI job actually cover every browser-dependent suite? (story 6.9, AC1.)
 *
 * PURE — a static read of `package.json` and the test tree. It spawns nothing and downloads
 * nothing.
 *
 * ⚠️ **WHY THIS EXISTS.** Story 6.9's job runs a FILTERED vitest invocation, not the whole
 * suite, because a browser run is expensive and the point is the browser surface. A filter is
 * a list somebody has to keep in step with reality — and the failure mode of a stale filter is
 * that a browser-dependent suite silently stops being covered by the one job that can run it,
 * while every check stays green. That is the same shape as the defect this whole story exists
 * to fix (Epic 4 retro §2 observation 2), one level further out, so it gets a test rather than
 * a comment.
 *
 * ⚠️ **AND IT IS A SUPERSET OF `browser-gated-suites.test.ts` ON PURPOSE.** Story 6.1's test
 * pins the five files that call `describeWithBrowser(` and *skip*. There is a SIXTH
 * browser-dependent file: `tests/integration/surfaces/conformance.test.ts` resolves 5.1's
 * environment itself (line 136) and, when no browser is available, narrows its surface list
 * from four to three and says so on stderr (lines 142-150) — it does not skip, so it appears
 * in no skip report and in 6.1's list. A suite that quietly asserts less is not visible to a
 * skip counter, which is exactly why the rule here is "imports the Playwright environment",
 * not "calls describe.skip".
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const INTEGRATION = join(REPO, 'tests', 'integration');

/**
 * A file is browser-dependent when its behaviour changes with the presence of a browser —
 * either through 5.2's shared fixture or by resolving 5.1's environment directly.
 *
 * Matched on the IMPORT SPECIFIER rather than anywhere in the text. The first version matched
 * the bare names and flagged this story's own `browser-leak-check.test.ts`, which only quotes
 * `browser-fixture.ts`'s header in a comment — a guard that fires on prose is a guard that
 * gets its rule loosened for the wrong reason.
 */
const BROWSER_DEPENDENT = [/from\s+'[^']*browser-fixture/, /from\s+'[^']*playwright-env/];

/** Every `*.test.ts` under `tests/integration/`, repo-relative, with POSIX separators. */
async function integrationTestFiles(): Promise<string[]> {
  const found: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (entry.name.endsWith('.test.ts')) {
        found.push(path.slice(REPO.length).replaceAll('\\', '/'));
      }
    }
  };

  await walk(INTEGRATION);
  return found.sort();
}

/**
 * The positional path filters of `pnpm test:browser`.
 *
 * Everything after `run` that is not a flag. The script deliberately uses only `--flag=value`
 * form, so no token can be a flag's separated value and this stays a two-line parse.
 */
async function browserJobFilters(): Promise<string[]> {
  const manifest = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const command = manifest.scripts?.['test:browser'];
  expect(command, '`test:browser` is the browser CI job\'s entry point and must exist').toBeTypeOf(
    'string',
  );

  const tokens = String(command).split(/\s+/);
  const afterRun = tokens.indexOf('run') + 1;
  return tokens.slice(afterRun).filter((token) => !token.startsWith('-'));
}

describe('the browser CI job', () => {
  it('covers every browser-dependent integration suite', async () => {
    const filters = await browserJobFilters();
    expect(filters.length, '`test:browser` must carry at least one path filter').toBeGreaterThan(0);

    const uncovered: string[] = [];
    for (const file of await integrationTestFiles()) {
      const text = await readFile(join(REPO, file), 'utf8');
      if (!BROWSER_DEPENDENT.some((pattern) => pattern.test(text))) {
        continue;
      }
      if (!filters.some((filter) => file.startsWith(filter))) {
        uncovered.push(file);
      }
    }

    expect(
      uncovered,
      'A browser-dependent suite is outside `pnpm test:browser`\'s filters, so the only CI job ' +
        'that can give it a browser will not run it. Either add a filter in package.json or ' +
        'say in the PR body why this suite does not need one.',
    ).toEqual([]);
  });

  /**
   * The filters must not be so wide that the job becomes "run everything". The browser job is
   * the expensive one and it is non-blocking; widening it to the whole suite would duplicate
   * the required `verify` job at browser prices.
   */
  it('does not filter so widely that it runs the whole suite', async () => {
    for (const filter of await browserJobFilters()) {
      expect(filter.startsWith('tests/integration/'), `${filter} is wider than tests/integration/`)
        .toBe(true);
    }
  });
});
