/**
 * Every tracked source file must be TEXT, not `data`.
 *
 * ============================================================================
 * ⚠️ WHY THIS EXISTS, AND WHY IT IS WORTH A TEST OF ITS OWN
 * ============================================================================
 *
 * Story 6.6 shipped `src/report/scorecard-summary.ts` with **two literal NUL bytes** in
 * it — one in a doc comment, one as the separator inside a template literal, where the
 * intent was a NUL join key. The runtime behaviour was correct and identical to the
 * escaped form. The consequence was not:
 *
 *   $ grep -c "scorecard" src/report/scorecard-summary.ts
 *   $ echo $?
 *   1                          # no matches, in a file whose header says it 28 times
 *   $ file src/report/scorecard-summary.ts
 *   src/report/scorecard-summary.ts: data
 *
 * **A single NUL makes the whole file invisible to every text tool**, and a text tool that
 * skips a file returns no matches — which looks exactly like a scan that passed. `grep -r`
 * over `src/`, a secret scan, any future guard built on text search: each one silently
 * excluded the module that computes this product's north-star metric.
 *
 * It survived eleven review rounds and two independent clean reviews, because there is
 * nothing to see: `git diff` renders the file as ordinary text and `--numstat` counts it as
 * ordinary lines. The supervisor found it by accident, when `grep -n "unattributed"`
 * returned nothing and he assumed his own typo.
 *
 * That is precisely the failure class this story kept producing in its own tests — **a
 * guard that fails to apply is indistinguishable from a guard that passed** — arriving one
 * level up, where it disables not one guard but every text-based guard at once.
 *
 * SCOPED TO `src/**` deliberately. That is the product code, and the tree a secret scan or
 * an architecture grep would sweep. `docs/` is knowingly excluded: one Epic 4 spec
 * (`4.3-deterministic-test-data.md`) already carries a NUL, it is not this story's file,
 * and a defect that is not my story gets reported rather than fixed from here.
 * `fixtures/` is excluded because a corpus fixture may legitimately need to be binary.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';
import { beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

let trackedSources: string[] = [];

beforeAll(async () => {
  const { stdout } = await execa('git', ['ls-files', 'src'], { cwd: REPO_ROOT });
  trackedSources = stdout.split('\n').filter(Boolean);
  // A scan that found nothing to scan would pass vacuously — the exact shape this file
  // exists to prevent. Assert the sweep is non-trivial before trusting its verdict.
  expect(trackedSources.length).toBeGreaterThan(50);
});

describe('src/** contains no control bytes that make a file unreadable to text tools', () => {
  it('has no NUL byte in any tracked source file', async () => {
    const offenders: string[] = [];

    for (const relative of trackedSources) {
      const bytes = await readFile(join(REPO_ROOT, relative));
      if (bytes.includes(0x00)) {
        offenders.push(relative);
      }
    }

    expect(
      offenders,
      'a NUL byte makes the whole file invisible to grep, `file` and every text-based ' +
        'scan — and a scan that silently skips a file looks exactly like a scan that ' +
        'passed. Write the byte as an escape (\\u0000) instead; it is byte-identical at ' +
        'runtime and leaves the file readable.',
    ).toEqual([]);
  });

  it('detects a planted NUL, so this guard is not vacuous', () => {
    // The guard on the guard. If the detector were wrong — and my FIRST attempt at this
    // scan was wrong, because `grep -qU $'\\000'` in bash passes an EMPTY pattern that
    // matches every file, so it "found" hundreds of offenders — this suite would pass over
    // a tree full of NULs, or fail over a clean one. Both directions are pinned here.
    const clean = Buffer.from('export const answer = 42;\n', 'utf8');
    const planted = Buffer.concat([clean, Buffer.from([0x00])]);

    expect(clean.includes(0x00)).toBe(false);
    expect(planted.includes(0x00)).toBe(true);
  });
});
