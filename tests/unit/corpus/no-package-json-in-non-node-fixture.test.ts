/**
 * The non-Node corpus fixture contains no `package.json`, and it never may (story 6.4).
 *
 * ============================================================================
 * THIS IS THE SHARPEST TESTABLE FORM OF FR-4, AND THE ONE A FUTURE
 * CONTRIBUTOR WILL BREAK WHILE TRYING TO MAKE SOMETHING WORK.
 * ============================================================================
 *
 * FR-4 says all stack specifics enter ONLY through Project Config, and the epic's
 * acceptance criterion for story 6.4 states the consequence in a parenthesis: **no
 * `package.json` required in the target**. That parenthesis is the whole claim in its
 * most falsifiable form, so it is asserted structurally here rather than left to review.
 *
 * WHY THIS TEST EXISTS AT ALL, given that the fixture passes today. For five epics every
 * fixture, test project and integration test in this repository was a Node project, which
 * means a Node assumption anywhere in gate resolution, service startup or observation
 * would have run green in every execution the product has ever done. A claim that cannot
 * fail has not been tested. `fixtures/corpus/stack-independence-python/` is the first
 * thing here capable of falsifying it — and it only keeps that property for as long as it
 * stays a non-Node project.
 *
 * THE FAILURE MODE THIS GUARDS IS NOT MALICE, IT IS HELPFULNESS. Somebody will meet a red
 * fixture, or a tool that wants a manifest, and add a `package.json` here. It will look
 * like a two-line unblock, it will make something work, and it will convert a falsifiable
 * claim back into an unfalsifiable one — permanently and invisibly, because from then on
 * the corpus would contain no non-Node target at all while the suite stayed green. The
 * failure message below is the argument, put where that person will actually meet it.
 *
 * SEEN RED BEFORE IT WAS TRUSTED. A structural guard nobody has watched fail is the guard
 * most likely to be vacuous — Epic 4 retro section 2 observation 7 records exactly that
 * happening. A `package.json` was planted at the fixture root and again nested under
 * `project/app/`, this suite was run and failed with the message below both times, and the
 * plants were then removed. The verification log in the story's Dev Agent Record has the
 * transcript.
 *
 * SCOPE. This checks the non-Node fixture only. The other corpus fixtures are Node
 * projects by design and a `package.json` in one of them would be unremarkable, so a
 * repository-wide ban would be wrong as well as unenforceable.
 */

import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The fixture this rule protects.
 *
 * A CONSTANT, not a scan for "fixtures that look non-Node". A scan would silently protect
 * nothing the day the naming changed, and this rule is worth exactly one hard-coded path.
 */
const FIXTURE = 'stack-independence-python';

const FIXTURE_ROOT = fileURLToPath(
  new URL(`../../../fixtures/corpus/${FIXTURE}`, import.meta.url),
);

/**
 * Node-project markers. A manifest, either lockfile, and an installed dependency tree.
 *
 * `package-lock.json`, `pnpm-lock.yaml` and `yarn.lock` are listed beside `package.json`
 * because the AC's parenthesis is about the TARGET not being a Node project, and a
 * lockfile without a manifest would be a stranger way to break that than a manifest.
 */
const NODE_PROJECT_MARKERS = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'node_modules',
]);

const RULE =
  `fixtures/corpus/${FIXTURE}/ is the repository's ONLY non-Node verification target, ` +
  'and it is the only evidence that FR-4 ("all stack specifics enter only through ' +
  'Project Config") is true rather than merely believed. Every other fixture, test ' +
  'project and integration test here is a Node project, so a Node assumption in the ' +
  'product would run green everywhere else. Adding a Node marker to this fixture does ' +
  'not fix whatever sent you here — it deletes the only test that could have found it, ' +
  'and it does so silently, because the suite stays green afterwards. If this fixture ' +
  'needs a Node marker to work, THAT IS THE FINDING: report it with evidence (story ' +
  "6.4's Dev Agent Record is the place) rather than accommodating it here.";

/** Every path under `directory`, repo-relative, including directories. */
async function walk(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    found.push(relative(FIXTURE_ROOT, full).split(sep).join('/'));
    // `node_modules` is itself a marker, so it is recorded and NOT descended into: walking
    // an installed tree would be slow and would report thousands of nested findings for
    // one mistake.
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      found.push(...(await walk(full)));
    }
  }
  return found;
}

describe(`the non-Node corpus fixture (${FIXTURE})`, () => {
  it('contains no package.json, no lockfile and no node_modules, at any depth', async () => {
    const paths = await walk(FIXTURE_ROOT);

    const markers = paths
      .filter((path) => {
        const name = path.split('/').at(-1);
        return name !== undefined && NODE_PROJECT_MARKERS.has(name);
      })
      .sort();

    expect(
      markers,
      markers.length === 0
        ? ''
        : `Node-project markers found in the non-Node fixture:\n` +
          markers.map((path) => `  fixtures/corpus/${FIXTURE}/${path}`).join('\n') +
          `\n\n${RULE}`,
    ).toEqual([]);
  });

  it('actually walked the fixture, so an empty result cannot be a vacuous pass', async () => {
    // THE STANDING HAZARD, in the same shape story 6.1's runner guards against: a walk
    // that found nothing and a fixture with no markers produce the identical assertion
    // above. If this directory were renamed or deleted, `walk` would throw — but if it
    // were merely EMPTIED, the rule above would pass while protecting nothing.
    const paths = await walk(FIXTURE_ROOT);

    expect(paths).toContain('expected.json');
    expect(paths).toContain('project/.specwitness/config.yaml');
    // The Python application is the reason the fixture is not a Node project. If this
    // assertion ever fails, the fixture stopped being what its name claims.
    expect(paths).toContain('project/app/inventory_service.py');
  });
});
