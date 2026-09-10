/**
 * The corpus runner's own guards, proven against deliberately-broken fixtures (story 6.1).
 *
 * **A runner that reports green when a fixture drifted is the worst outcome available in
 * this story.** Every proof the rest of Epic 6 produces rests on this file: if the
 * comparison does not actually compare, the corpus is decoration. So each case here builds
 * a BROKEN fixture in a temp corpus root and asserts the runner goes red for the right
 * reason — the "a guard is only a guard once you have seen it fail" rule (Epic 4 retro §2
 * observation 7) applied to the guard that guards everything else.
 *
 * ⚠️ **NOTHING HERE TOUCHES THE CHECKED-IN CORPUS.** Every fixture is copied into a fresh
 * `mkdtemp` corpus root and broken there. A test that mutated `fixtures/corpus/` in order to
 * prove the corpus cannot be mutated would be its own counter-example — and would leave the
 * repository dirty for whoever ran it.
 *
 * This is an integration suite: it spawns the real binary. The pure halves of the runner
 * are unit-tested in `tests/unit/corpus/`.
 */

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CORPUS_ROOT,
  discoverFixtures,
  executeFixture,
  materializeFixture,
  providerTripwireMarkers,
  type FixtureRun,
} from './runner.js';

const roots: string[] = [];
const runs: FixtureRun[] = [];

afterEach(async () => {
  await Promise.all(runs.splice(0).map(async (run) => await run.materialized.cleanup()));
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

/**
 * Copies one checked-in fixture into a private corpus root under the temp directory.
 *
 * The copy keeps the fixture's name, so its `expected.json`'s `fixture` field still matches
 * the directory it lands in and the loader's cross-check stays satisfied until a test breaks
 * it on purpose.
 */
async function cloneFixture(name: string): Promise<{ root: string; directory: string }> {
  const root = await mkdtemp(join(tmpdir(), 'specwitness-corpus-selfcheck-'));
  roots.push(root);
  const directory = join(root, name);
  await cp(join(CORPUS_ROOT, name), directory, { recursive: true });
  return { root, directory };
}

/** Rewrites one file inside a cloned fixture. */
async function patch(
  path: string,
  edit: (text: string) => string,
): Promise<void> {
  const text = await readFile(path, 'utf8');
  const next = edit(text);
  if (next === text) {
    throw new Error(`self-check: the patch matched nothing in ${path} — the fixture moved`);
  }
  await writeFile(path, next, 'utf8');
}

/** Runs the single fixture in a private corpus root. */
async function runOnly(root: string): Promise<FixtureRun> {
  const [fixture] = await discoverFixtures(root);
  if (fixture === undefined) {
    throw new Error('self-check: the private corpus root discovered no fixture');
  }
  const run = await executeFixture(fixture);
  runs.push(run);
  return run;
}

describe('the runner detects drift between the product and a hand-written expectation', () => {
  it('goes red when the EXPECTATION says something the product did not do', async () => {
    // The expectation is edited, not the product. This is the direction a wave-2 agent will
    // meet first — a fixture whose author pinned the wrong verdict — and a runner that let
    // it pass would let every subsequent fixture be wrong too.
    const { root, directory } = await cloneFixture('runner-pass');
    await patch(join(directory, 'expected.json'), (text) =>
      text.replace('"verdict": "PASS"', '"verdict": "FAIL"'),
    );

    const run = await runOnly(root);

    expect(run.problems.join('\n')).toContain('outcome');
    expect(run.problems.join('\n')).toContain('FAIL');
  }, 180_000);

  it('goes red when the PRODUCT stops doing what a correct expectation pins', async () => {
    // The direction that matters in six months: the expectation is untouched and correct,
    // the application under verification changed. Here the fixture app reports the order
    // state as `pending` where its frozen contract requires `approved`, so criterion E1-01
    // must move from `pass` to `fail` and the corpus must notice.
    const { root, directory } = await cloneFixture('runner-pass');
    await patch(join(directory, 'project', 'app', 'server.cjs'), (text) =>
      text.replace("status: 'approved'", "status: 'pending'"),
    );

    const run = await runOnly(root);

    expect(run.problems.join('\n')).toContain('criterion E1-01');
    expect(run.problems.join('\n')).toContain("expected 'pass', observed 'fail'");
  }, 180_000);

  it('goes red when a criterion disappears from the report entirely', async () => {
    // A criterion nobody adjudicated is not a criterion that passed — the standing hazard,
    // reaching the corpus. Removing E1-02 from the PLAN leaves the contract still requiring
    // it, and the fixture must fail rather than quietly assert one criterion less.
    const { root, directory } = await cloneFixture('runner-criterion-fail');
    await patch(join(directory, 'project', '.specwitness', 'plans', 'epic-1.yaml'), (text) =>
      text.slice(0, text.indexOf('    - criterionId: E1-02')) +
      text.slice(text.indexOf('meta:\n  schemaVersion: 1\n  compiledAt')),
    );

    const run = await runOnly(root);

    expect(run.problems.length).toBeGreaterThan(0);
  }, 180_000);
});

describe('the expectation loader refuses what it cannot trust', () => {
  it('refuses a fixture whose expected.json is missing', async () => {
    const { root, directory } = await cloneFixture('runner-pass');
    await rm(join(directory, 'expected.json'));

    await expect(runOnly(root)).rejects.toThrow(/no readable expected\.json/);
  });

  it('refuses a fixture whose expected.json is malformed', async () => {
    const { root, directory } = await cloneFixture('runner-pass');
    await writeFile(join(directory, 'expected.json'), '{ "expectedVersion": ', 'utf8');

    await expect(runOnly(root)).rejects.toThrow(/not valid JSON/);
  });

  it('refuses an expectation that names a different fixture', async () => {
    const { root, directory } = await cloneFixture('runner-pass');
    await patch(join(directory, 'expected.json'), (text) =>
      text.replace('"fixture": "runner-pass"', '"fixture": "runner-criterion-fail"'),
    );

    await expect(runOnly(root)).rejects.toThrow(/was copied/);
  });
});

describe('the provider tripwires are real', () => {
  it('records an invocation when a fixture declares a command that runs `claude`', async () => {
    // AC1 forbids a real provider invocation anywhere in this suite, and the way to know a
    // thing did not happen is to make it leave a mark if it does. This fixture is
    // deliberately illegal — it declares `claude --version` as an observation command — and
    // exists only here, in a temp corpus root, to prove the tripwire fires. The checked-in
    // corpus contains nothing like it, and the corpus suite asserts the marker directory is
    // empty for every fixture in it.
    const { root, directory } = await cloneFixture('runner-criterion-fail');
    await patch(join(directory, 'project', '.specwitness', 'config.yaml'), (text) =>
      text.replace('run: node commands/release.cjs', 'run: claude --version'),
    );

    const run = await runOnly(root);

    expect(await providerTripwireMarkers(run.materialized)).toEqual(['claude.invoked']);
  }, 180_000);
});

describe('the package-registry tripwires are real (story 7.0)', () => {
  it.each(['npm', 'npx'])(
    'shadows `%s` on the fixture PATH with something that fetches nothing and fails',
    async (binary) => {
      // ⚠️ THE GUARD THAT KEEPS THE CORPUS OFFLINE NOW THAT THE PRODUCT CAN FETCH. `verify`
      // provisions Playwright when the compiled plan carries a browser probe, so the fixture
      // `browser-probe-provisions` would download a package and a ~150MB browser on every CI
      // run if this shadow were removed — and it would still be GREEN, because the fixture's
      // own expectation would then be the only thing that noticed. Asserted here rather than
      // read from the runner, because a guard is only a guard once you have seen it fire.
      const { root } = await cloneFixture('runner-pass');
      const [fixture] = await discoverFixtures(root);
      if (fixture === undefined) {
        throw new Error('self-check: the private corpus root discovered no fixture');
      }
      const materialized = await materializeFixture(fixture);
      try {
        const shadow = join(materialized.workspace, 'bin', binary);
        // `install` is what provisioning actually asks for, and it must fetch nothing.
        const result = await execa(shadow, ['install', '@playwright/test@1.62.1'], {
          reject: false,
        });

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(`corpus tripwire: ${binary} was invoked`);
        // The provider tripwires leave a marker and this one must NOT: that directory means
        // "a provider CLI ran", and a deliberate registry refusal is not that.
        expect(await providerTripwireMarkers(materialized)).toEqual([]);
      } finally {
        await materialized.cleanup();
      }
    },
    60_000,
  );
});

describe('persistedAbsent is real (story 7.4)', () => {
  it('goes red, naming the persisted files, when the fixture stops declaring its pattern', async () => {
    // The config edit stands in for every way a declared pattern can stop reaching its sinks —
    // an edge binding reverted, a stage that stops threading it. The expectation is untouched
    // and correct, the run still PASSES, and only what it persisted differs: which is exactly
    // the regression `persistedAbsent` exists to see and `stderrAbsent` alone could not.
    const { root, directory } = await cloneFixture('redaction-extra-patterns');
    await patch(join(directory, 'project', '.specwitness', 'config.yaml'), (text) =>
      text.slice(0, text.indexOf('redaction:\n')),
    );

    const run = await runOnly(root);
    const problems = run.problems.join('\n');

    expect(problems).toMatch(/persistedAbsent: \.specwitness\/runs\/\S+\/result\.json contains/);
    expect(problems).toMatch(/persistedAbsent: \.specwitness\/runs\/\S+\/evidence\/gate-/);
    // A leak, not a behavioural regression: the verdict is untouched.
    expect(problems).not.toContain('outcome');
  }, 180_000);
});
