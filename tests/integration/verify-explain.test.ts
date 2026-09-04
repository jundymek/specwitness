/**
 * Story 5.5 — `verify --explain` through the BUILT BINARY.
 *
 * `tests/unit/authoring/explain-inert.test.ts` is the primary inertness proof, because it
 * compares one `RunResult` explained and not explained, where nothing else can vary. This
 * file is the corroboration: the same claim end to end, plus the flag semantics that only
 * exist at the CLI edge.
 *
 * ── HOW TWO SEPARATE RUNS CAN BE COMPARED AT ALL ────────────────────────────────────────
 *
 * They cannot be, byte for byte, and pretending otherwise would be the dishonest version of
 * this test: two invocations differ in their run id, both timestamps, every duration and the
 * worktree path whether or not `--explain` was passed. So the comparison NORMALISES those,
 * and then does the one thing that makes the normalisation trustworthy:
 *
 *   **it validates the normaliser against a CONTROL PAIR.** Two runs with the SAME flags are
 *   normalised and compared first. If that control does not come out identical, the
 *   normaliser is not describing run-to-run variation and the whole comparison is void — so
 *   the test says so instead of quietly passing. Only then is the explained-vs-unexplained
 *   pair compared, using exactly the same normaliser plus the two stated exclusions.
 *
 * Without the control, a normaliser that erased too much would make this file pass on any
 * implementation at all.
 *
 * ── WHAT THIS SUITE BINDS ───────────────────────────────────────────────────────────────
 *
 * `buildProbeFixture` starts a service on `127.0.0.1`. **The Codex review sandbox cannot
 * bind a loopback socket (EPERM), so this file cannot run there** — like the four merged
 * `buildProbeFixture` suites, which fail in every review log for the same reason and are not
 * regressions. Every claim in this file that does NOT need a socket is also asserted in the
 * unit suites, which bind nothing.
 *
 * **These are NOT Golden Verification Corpus fixtures.** `fixtures/corpus/` is Epic 6.
 * Everything here is inline, per-test, in a temp directory, torn down afterwards.
 *
 * AD-12: no real `claude` or `codex` is invoked. The explainer is the SHIPPED `fake`
 * adapter, config-selected, replaying a scripted response — so what is proven is the wiring
 * and the inertness, never the behaviour of a live subscription.
 *
 * ── VERIFIED RED ────────────────────────────────────────────────────────────────────────
 *   P14  the `--no-ai --explain` refusal deleted  →  "refuses --no-ai --explain" FAILED
 *        (exit 1 instead of 64, no ERROR/HINT pair).
 *   P15  `explainVerifiedRun` called unconditionally instead of behind `options.explain`  →
 *        "a default run never reaches the explainer" FAILED, because the fixture's fake has
 *        no `explainer.json` and the resulting WARNING is proof the provider was reached.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildProbeFixture, runCli, type ProbeFixture } from './helpers/probe-fixture.js';

interface RunDocument {
  readonly runId: string;
  readonly outcome: { readonly verdict?: string; readonly infraError?: string };
  readonly criteria: readonly { readonly criterionId: string; readonly status: string }[];
  readonly providerUsage: readonly { readonly role: string; readonly attempts: number }[];
  readonly explanations?: readonly { readonly criterionId: string; readonly explanation: string }[];
  readonly environment: { readonly runDirectory: string };
}

/** The fixture's http criterion, which fails when the service answers 500. */
const HYPOTHESIS = 'the service returns 500 for every request after the data reset';

const EXPLAINER_SCRIPT = [
  JSON.stringify({ explanations: [{ criterionId: 'E1-01', hypothesis: HYPOTHESIS }] }),
];

const fixtures: ProbeFixture[] = [];

afterEach(async () => {
  // Every fixture removed even if an earlier one refuses. A test run KILLED outright runs no
  // hook at all, which is why every fixture here is also self-limiting.
  await Promise.all(fixtures.splice(0).map(async (fixture) => await fixture.cleanup()));
});

async function fixture(...args: Parameters<typeof buildProbeFixture>): Promise<ProbeFixture> {
  const built = await buildProbeFixture(...args);
  fixtures.push(built);
  return built;
}

/**
 * Erase what differs between ANY two runs of the same project.
 *
 * Deliberately blunt: a regex over the serialized document rather than a structured walk,
 * so a field this list forgot shows up as a difference rather than being silently skipped.
 * The control pair below is what proves the list is neither too short nor too long.
 */
function normalise(text: string): string {
  return text
    .replace(/run-\d{8}T\d{6}Z-[a-z0-9]{4}/g, '<run-id>')
    .replace(/"(startedAt|finishedAt|capturedAt|frozenAt)": "[^"]*"/g, '"$1": "<ts>"')
    .replace(/"durationMs": \d+/g, '"durationMs": 0')
    .replace(/"worktreePath": "[^"]*"/g, '"worktreePath": "<path>"')
    // Ports are allocated per fixture, so any URL carrying one differs between projects.
    .replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>')
    // The fixture service's HTTP `Date` RESPONSE HEADER, captured into http evidence and
    // resolved to the second. FOUND BY THIS FILE'S OWN CONTROL PAIR, which is the point of
    // having one: the two control runs happened to land inside the same second and passed,
    // and the explained run a second later did not. Two runs of anything that talks to a
    // server differ here, `--explain` or not — it is run-to-run variation like every other
    // entry in this list, not something the explainer touched.
    .replace(/"date": "[^"]*"/g, '"date": "<http-date>"');
}

/** The two stated exclusions, removed from a normalised document. */
function withoutExplainerFields(text: string): string {
  const document = JSON.parse(text) as Record<string, unknown>;
  delete document['explanations'];
  delete document['providerUsage'];
  return normalise(JSON.stringify(document, null, 2));
}

async function storedResult(project: ProbeFixture, document: RunDocument): Promise<string> {
  return await readFile(join(project.root, document.environment.runDirectory, 'result.json'), 'utf8');
}

describe('AC1 — the run is byte-identical with and without --explain, end to end', () => {
  it('differs only in the explanations array and the recorded provider usage', async () => {
    const project = await fixture({ statusCode: 500, fakeExplainer: EXPLAINER_SCRIPT });

    // THE CONTROL PAIR FIRST. Two runs with the SAME flags, so anything the normaliser
    // fails to erase shows up here — where it is a broken test rather than a passing one.
    const controlA = await runCli(['verify', project.epic, '--json'], { cwd: project.root });
    const controlB = await runCli(['verify', project.epic, '--json'], { cwd: project.root });
    expect(
      normalise(controlB.stdout),
      'the normaliser does not describe run-to-run variation, so the comparison below would prove nothing',
    ).toBe(normalise(controlA.stdout));

    const explained = await runCli(['verify', project.epic, '--json', '--explain'], {
      cwd: project.root,
    });

    // Same verdict, same exit code — the weaker claim, checked first so a failure below is
    // unambiguously about the bytes rather than about the outcome.
    expect(explained.exitCode).toBe(controlA.exitCode);

    // And the bytes, with exactly the two exclusions. Anything else that differed would be
    // a leak of the explainer into results.
    expect(withoutExplainerFields(explained.stdout)).toBe(
      withoutExplainerFields(controlA.stdout),
    );

    // The explanation really was produced, so the comparison is not passing vacuously.
    const document = JSON.parse(explained.stdout) as RunDocument;
    expect(document.explanations).toEqual([{ criterionId: 'E1-01', explanation: HYPOTHESIS }]);
    expect(document.providerUsage.map((usage) => usage.role)).toEqual(['explainer']);
  });

  it('persists the same bytes it printed (Q53, AD-11)', async () => {
    const project = await fixture({ statusCode: 500, fakeExplainer: EXPLAINER_SCRIPT });

    const explained = await runCli(['verify', project.epic, '--json', '--explain'], {
      cwd: project.root,
    });
    const document = JSON.parse(explained.stdout) as RunDocument;

    // The third write goes through `RunStore` and the one serializer, so `--json` stdout and
    // the stored `result.json` stay the same document — including the hypotheses.
    expect(await storedResult(project, document)).toBe(explained.stdout);
  });

  it('renders the hypothesis, clearly labelled, on the human report', async () => {
    const project = await fixture({ statusCode: 500, fakeExplainer: EXPLAINER_SCRIPT });

    const explained = await runCli(['verify', project.epic, '--explain'], { cwd: project.root });

    expect(explained.stdout).toContain('NON-AUTHORITATIVE');
    expect(explained.stdout).toContain('(hypothesis)');
    expect(explained.stdout).toContain(HYPOTHESIS);
    expect(explained.stdout).toMatch(/did not affect the verdict/);
  });
});

describe('FR-18 / Q66 — --explain is opt-in, and the default reaches no provider', () => {
  it('a default run never reaches the explainer, even with the role configured', async () => {
    // The role IS assigned and NO script exists, so any invocation would make the fake
    // refuse with "has no fixture for role" and print a WARNING. Silence is the assertion.
    const project = await fixture({ statusCode: 500, fakeExplainer: [] });

    const { exitCode, stdout } = await runCli(['verify', project.epic, '--json'], {
      cwd: project.root,
    });

    expect(exitCode).toBe(1);
    const document = JSON.parse(stdout) as RunDocument;
    expect(document.providerUsage).toEqual([]);
    expect(document.explanations).toBeUndefined();
    expect(stdout).not.toContain('NON-AUTHORITATIVE');
  });

  it('refuses --no-ai --explain with exit 64 and an ERROR/HINT pair', async () => {
    const project = await fixture({ statusCode: 500, fakeExplainer: EXPLAINER_SCRIPT });

    const { exitCode, stdout, stderr } = await runCli(
      ['verify', project.epic, '--no-ai', '--explain'],
      { cwd: project.root },
    );

    // 64 sits OUTSIDE 0-3, so a contradictory flag pair can never be mistaken for a verdict
    // (ADR-002). Silently dropping either flag was the alternative, and both readings are
    // ones a person could hold — which is the argument for refusing rather than choosing.
    expect(exitCode).toBe(64);
    expect(stderr).toContain('ERROR:');
    expect(stderr).toContain('HINT:');
    expect(stderr).toContain('--explain');
    expect(stderr).toContain('--no-ai');
    // Refused BEFORE anything is created: no run document, nothing on stdout.
    expect(stdout).toBe('');
  });

  it('leaves --no-ai alone on its own', async () => {
    // The neighbouring cell, so the refusal above cannot be over-broad: `--no-ai` with a
    // plan present still succeeds and still makes zero provider calls.
    const project = await fixture({ statusCode: 500, fakeExplainer: EXPLAINER_SCRIPT });

    const { exitCode, stdout } = await runCli(['verify', project.epic, '--json', '--no-ai'], {
      cwd: project.root,
    });

    expect(exitCode).toBe(1);
    expect((JSON.parse(stdout) as RunDocument).providerUsage).toEqual([]);
  });
});

describe('AC2 — an explainer failure never changes an exit code', () => {
  it('exits the same as an unexplained run when the provider has no fixture', async () => {
    const project = await fixture({ statusCode: 500, fakeExplainer: [] });

    const plain = await runCli(['verify', project.epic, '--json'], { cwd: project.root });
    const explained = await runCli(['verify', project.epic, '--json', '--explain'], {
      cwd: project.root,
    });

    // The whole asymmetry, end to end: a `plan-author` failure legitimately stops a run and
    // exits 3; an explainer failure must leave the product verdict exactly where it was.
    expect(explained.exitCode).toBe(plain.exitCode);
    expect(explained.exitCode).toBe(1);
    expect(explained.stderr).toContain('WARNING:');
    // A WARNING, never an ERROR — the verification answered the question it was asked.
    expect(explained.stderr).not.toContain('ERROR:');

    const document = JSON.parse(explained.stdout) as RunDocument;
    expect(document.explanations).toBeUndefined();
    expect(withoutExplainerFields(explained.stdout)).toBe(withoutExplainerFields(plain.stdout));
  });

  it('exits the same when the provider answers with unusable text', async () => {
    const project = await fixture({
      statusCode: 500,
      fakeExplainer: ['this is not json and never will be'],
    });

    const explained = await runCli(['verify', project.epic, '--json', '--explain'], {
      cwd: project.root,
    });

    expect(explained.exitCode).toBe(1);
    expect((JSON.parse(explained.stdout) as RunDocument).explanations).toBeUndefined();
    // The invocation is still RECORDED: three attempts of the merged gate's budget were
    // spent, and a run that quietly spent quota with an empty `providerUsage` would make
    // FR-18's guarantee unauditable.
    expect((JSON.parse(explained.stdout) as RunDocument).providerUsage).toHaveLength(1);
  });

  it('says so, and passes, when a run has nothing to explain', async () => {
    // A green run: `--explain` costs nothing and produces a note rather than an empty block.
    const project = await fixture({ fakeExplainer: [] });

    const { exitCode, stdout, stderr } = await runCli(
      ['verify', project.epic, '--json', '--explain'],
      { cwd: project.root },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toContain('nothing to explain');
    expect((JSON.parse(stdout) as RunDocument).providerUsage).toEqual([]);
  });

  it('says so when --explain is passed with no explainer role assigned', async () => {
    const project = await fixture({ statusCode: 500 });

    const { exitCode, stderr } = await runCli(['verify', project.epic, '--explain'], {
      cwd: project.root,
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain('ai.roles.explainer');
    expect(stderr).toContain('WARNING:');
  });
});
