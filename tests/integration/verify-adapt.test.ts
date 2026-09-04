/**
 * Story 5.6, AC3 — `--adapt` is OPT-IN, and determinism is the default.
 *
 * Driven through the BUILT BINARY, because these are flag behaviours and a flag is only
 * real at the edge. Four properties:
 *
 *  1. `--no-ai --adapt` is REFUSED with exit 64. Not silently no-oped.
 *  2. A default run makes ZERO provider calls — proved by pointing the `mechanics-adapter`
 *     role at a provider that would BLOW UP if it were ever reached, and observing an
 *     ordinary verdict instead of exit 3.
 *  3. `--adapt` with no role assigned is refused rather than quietly doing nothing.
 *  4. `tests/integration/verify-no-ai.test.ts` is NOT edited by this story. Its four cells
 *     of `plan present × --no-ai` are 4.7's contract, 5.5's Task 2 depends on them being
 *     untouched, and both agents confirmed that at wave-3 intent-sync.
 *
 * ⚠️ THE CODEX REVIEW SANDBOX CANNOT BIND 127.0.0.1 (EPERM), so `buildProbeFixture` suites —
 * this one included — structurally cannot run there. A failure here in a review log is that
 * sandbox limitation, not a regression. Check whether a failing file binds a socket first.
 */

import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildProbeFixture, type ProbeFixture } from './helpers/probe-fixture.js';
import { runCli } from './helpers/verify-fixture.js';

const fixtures: ProbeFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => await fixture.cleanup()));
});

async function fixture(...args: Parameters<typeof buildProbeFixture>): Promise<ProbeFixture> {
  const built = await buildProbeFixture(...args);
  fixtures.push(built);
  return built;
}

/**
 * Points the project's `mechanics-adapter` role at a fake whose fixture directory does not
 * exist.
 *
 * That is the strongest available form of "prove nothing called it": the shipped fake raises
 * `ProviderError` the moment it is asked for a script it cannot find, and a `ProviderError`
 * on the verify path is exit 3. So a run that exits 0 or 1 is a run that never reached the
 * provider — an assertion about behaviour rather than about a call count.
 */
async function withExplodingAdapter(root: string): Promise<void> {
  const path = join(root, '.specwitness', 'config.yaml');
  const config = await readFile(path, 'utf8');
  await writeFile(
    path,
    `${config}\nai:\n  providers:\n    boom: { adapter: fake, mode: no-such-directory }\n  roles:\n    mechanics-adapter: boom\n`,
    'utf8',
  );
}

describe('AC3 — the flag pair', () => {
  it('refuses --no-ai --adapt with exit 64 and an ERROR/HINT pair', async () => {
    const project = await fixture({});

    const { exitCode, stderr } = await runCli(
      ['verify', project.epic, '--no-ai', '--adapt'],
      { cwd: project.root },
    );

    // 64 sits outside 0-3 so a flag mistake can never be read as a verdict (ADR-002).
    expect(exitCode).toBe(64);
    expect(stderr).toContain('ERROR:');
    expect(stderr).toContain('HINT:');
    expect(stderr).toMatch(/--no-ai and --adapt cannot be combined/);
  });

  it('refuses --adapt when no provider is assigned to the mechanics-adapter role', async () => {
    const project = await fixture({});

    const { exitCode, stderr } = await runCli(['verify', project.epic, '--adapt'], {
      cwd: project.root,
    });

    expect(stderr).toContain('ERROR:');
    expect(stderr).toMatch(/mechanics-adapter/);
    // A config problem, never a product FAIL.
    expect(exitCode).toBe(3);
  });
});

describe('the adapter is validated BEFORE any provider is spent', () => {
  it('refuses --adapt with an unassigned role without compiling a plan first', async () => {
    // THE ROUND-6 CODEX P2, and it is the invariant `verify.ts` states in its own words:
    // "A NEW PRECONDITION THAT NEEDS NO PROVIDER GOES ABOVE HERE". Resolving the adapter is
    // pure config work, and doing it after `resolvePlan` meant that `--adapt` with an
    // unassigned role AND no plan on disk would compile a plan first — spending subscription
    // quota and writing a file — before refusing with a configuration error.
    //
    // The fixture has a `plan-author` configured and NO plan on disk, which is exactly the
    // path that would spend.
    const project = await fixture({ fakePlanAuthor: true, plan: false });
    const planPath = join(project.root, '.specwitness', 'plans', `${project.epic}.yaml`);
    await expect(stat(planPath)).rejects.toThrow();

    const { exitCode, stderr } = await runCli(['verify', project.epic, '--adapt'], {
      cwd: project.root,
    });

    expect(exitCode).toBe(3);
    expect(stderr).toMatch(/mechanics-adapter/);
    // The load-bearing assertion: no plan was compiled, so no quota was spent and no file
    // was written for a command that was always going to fail on configuration.
    await expect(stat(planPath)).rejects.toThrow();
  });
});

describe('AC3 — a default run attempts nothing', () => {
  it('never reaches the provider, even with one configured that would explode', async () => {
    const project = await fixture({});
    await withExplodingAdapter(project.root);

    const { exitCode, stdout } = await runCli(['verify', project.epic, '--json'], {
      cwd: project.root,
    });

    // If the adapter had been reached, the fake would have raised ProviderError => exit 3.
    expect(exitCode).not.toBe(3);
    const document = JSON.parse(stdout) as {
      providerUsage: readonly unknown[];
      adaptation?: unknown;
    };
    expect(document.providerUsage).toEqual([]);
    // No key at all: an unadapted run carries no marker and no record.
    expect(document.adaptation).toBeUndefined();
  });

  it('is byte-identical with and without --no-ai, exactly as 4.7 promised', async () => {
    // 5.6 adds a provider call to the verify path, so this is re-asserted here rather than
    // assumed: the guarantee must survive the story that most threatens it.
    const project = await fixture({});
    await withExplodingAdapter(project.root);

    const withAi = await runCli(['verify', project.epic, '--json'], { cwd: project.root });
    const withoutAi = await runCli(['verify', project.epic, '--json', '--no-ai'], {
      cwd: project.root,
    });

    expect(withAi.exitCode).toBe(withoutAi.exitCode);
    expect(JSON.parse(withAi.stdout)).toMatchObject({ providerUsage: [] });
    expect(JSON.parse(withoutAi.stdout)).toMatchObject({ providerUsage: [] });
  });
});

describe('the four cells of plan × --no-ai are not this story to edit', () => {
  it('leaves tests/integration/verify-no-ai.test.ts untouched', async () => {
    // A guard against my own future self, and against a reviewer assuming otherwise. 5.5's
    // Task 2 asserts the same file is untouched from its side; we agreed it at intent-sync.
    // If this story ever needs to change that file, this test is where the conversation
    // starts rather than where it is quietly lost.
    const source = await readFile(
      new URL('./verify-no-ai.test.ts', import.meta.url),
      'utf8',
    );

    expect(source).toContain('All four cells of `plan present × --no-ai`');
    expect(source).not.toContain('--adapt');
  });
});
