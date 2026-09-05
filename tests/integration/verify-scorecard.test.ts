/**
 * Story 6.5, AC1 — the scorecard, through the built binary.
 *
 * Everything else about this story is testable in a unit. **Which runs record is not**,
 * because "any completed run" is a fact about a code path through `verify`, not about a
 * function — and the case that matters most is the one where the run FAILED to complete
 * normally. So these drive the real CLI to each of the four outcomes and read the file
 * afterwards.
 *
 * The two properties worth stating plainly, because a green suite here is what makes
 * Epic 7's measurement trustworthy:
 *
 *  1. **Recording is automatic.** No flag is passed in any case below. If recording were
 *     opt-in, every one of these would still pass with a flag added — and the dogfooding
 *     sample would be biased in a way nobody could detect afterwards.
 *  2. **An infra-errored run records.** Infra-error rate is one of the metrics story 6.6
 *     must report; a run that dies of infrastructure and leaves no line makes that rate
 *     structurally zero, which is a wrong number that reads as good news.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildFixture, runCli, type Fixture } from './helpers/verify-fixture.js';
import { buildProbeFixture, type ProbeFixture } from './helpers/probe-fixture.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => await cleanup()));
});

async function fixture(...args: Parameters<typeof buildFixture>): Promise<Fixture> {
  const built = await buildFixture(...args);
  cleanups.push(built.cleanup);
  return built;
}

async function probeFixture(
  ...args: Parameters<typeof buildProbeFixture>
): Promise<ProbeFixture> {
  const built = await buildProbeFixture(...args);
  cleanups.push(built.cleanup);
  return built;
}

const scorecardPath = (root: string): string => join(root, '.specwitness', 'scorecard.jsonl');

interface Record_ {
  readonly schemaVersion: number;
  readonly runId: string;
  readonly epic: string;
  readonly outcome: { readonly verdict?: string; readonly infraError?: string };
  readonly criteria: Readonly<Record<string, number>>;
  readonly gates: Readonly<Record<string, number>>;
  readonly providerInvocations: number;
  readonly durationMs: number;
}

/** Every record in a project's scorecard, in file order. */
async function records(root: string): Promise<readonly Record_[]> {
  const text = await readFile(scorecardPath(root), 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record_);
}

describe('every completed run records, with no flag to remember (AC1, NFR-4)', () => {
  it('records a PASS', async () => {
    const project = await fixture();

    const { exitCode } = await runCli(['verify', project.epic], { cwd: project.root });
    const written = await records(project.root);

    expect(exitCode).toBe(0);
    expect(written).toHaveLength(1);
    expect(written[0]?.outcome).toEqual({ verdict: 'PASS' });
    expect(written[0]?.runId).toMatch(/^run-/);
    expect(written[0]?.epic).toBe(project.epic);
    // AI-free by construction: a gates-only project invokes no provider (FR-18, Q66), and
    // this is the number 6.6 reports the AI-free-run share from.
    expect(written[0]?.providerInvocations).toBe(0);
  });

  it('records a FAIL, carrying the failing gate id', async () => {
    const project = await fixture({
      gates: [
        { id: 'lint', behaviour: 'pass' },
        { id: 'build', behaviour: 'fail' },
      ],
    });

    const { exitCode } = await runCli(['verify', project.epic], { cwd: project.root });
    const written = await records(project.root);

    expect(exitCode).toBe(1);
    expect(written[0]?.outcome).toEqual({ verdict: 'FAIL', gateFailed: 'build' });
    expect(written[0]?.gates).toMatchObject({ fail: 1 });
  });

  it('records a NEEDS_HUMAN', async () => {
    const project = await fixture({ contract: 'frozen-with-human' });

    const { exitCode } = await runCli(['verify', project.epic], { cwd: project.root });
    const written = await records(project.root);

    expect(exitCode).toBe(2);
    expect(written[0]?.outcome).toEqual({ verdict: 'NEEDS_HUMAN' });
  });

  it('⚠️ RECORDS AN INFRA-ERRORED RUN — the metric that would otherwise be structurally zero', async () => {
    // A tampered contract in a project with no compiled plan. The refusal is the
    // integrity STAGE's, inside the pipeline, so the run directory already exists and the
    // run reaches a classified outcome — unlike the plan-present shape, where
    // `resolvePlan` refuses at the edge before `createRun` (see the boundary describe
    // below). This is the run 6.6's infra-error rate is computed from.
    const project = await fixture({ contract: 'tampered' });

    const { exitCode } = await runCli(['verify', project.epic], { cwd: project.root });
    const written = await records(project.root);

    expect(exitCode).toBe(3);
    expect(written).toHaveLength(1);
    expect(written[0]?.outcome).toEqual({ infraError: 'integrity' });
    // AD-6: a run has a verdict OR an infra error, never both. A record that carried a
    // verdict beside an infra error would let 6.6 count the same run twice.
    expect(written[0]?.outcome).not.toHaveProperty('verdict');
  });

  it('appends rather than replacing, so the log accumulates across runs', async () => {
    const project = await fixture();

    await runCli(['verify', project.epic], { cwd: project.root });
    await runCli(['verify', project.epic], { cwd: project.root });
    const written = await records(project.root);

    expect(written).toHaveLength(2);
    // Two runs, two distinct ids. A file with two identical ids would mean one run was
    // recorded twice, which is as damaging to a rate as a run recorded zero times.
    expect(new Set(written.map((entry) => entry.runId)).size).toBe(2);
  });

  it('records a --no-ai run exactly as it records any other', async () => {
    const project = await probeFixture({ fakePlanAuthor: true });

    const { exitCode } = await runCli(['verify', project.epic, '--no-ai'], {
      cwd: project.root,
    });
    const written = await records(project.root);

    expect(exitCode).toBe(0);
    expect(written).toHaveLength(1);
    // `--no-ai` constrains COMPILATION, not recording. A run that verified something is a
    // run that belongs in the measurement, whatever flags reached it.
    expect(written[0]?.providerInvocations).toBe(0);
  });
});

describe('⚠️ the scorecard never changes a run outcome (AC1, the hardest rule)', () => {
  it('a PASS stays a PASS and exits 0 when the record cannot be written', async () => {
    const project = await fixture();
    // A directory where the file belongs: EISDIR on every append, no privileges needed,
    // and identical in effect to a full disk or a read-only mount from this code's point
    // of view.
    await mkdir(scorecardPath(project.root), { recursive: true });

    const { exitCode, stderr } = await runCli(['verify', project.epic], {
      cwd: project.root,
    });

    // THE ASSERTION THIS STORY EXISTS TO MAKE SAFE. Instrumentation that can fail a
    // verification is worse than no instrumentation, and exit 3 here would tell a harness
    // "the environment is broken, retry" about a run that verified perfectly.
    expect(exitCode).toBe(0);
    // Surfaced, not swallowed: a scorecard that silently stops recording is a metric that
    // silently becomes wrong.
    expect(stderr).toContain('WARNING:');
    expect(stderr).toContain('scorecard');
    // ...and NOT dressed up as a product failure or an infrastructure one.
    expect(stderr).not.toContain('ERROR:');
  });

  it('a FAIL stays a FAIL and exits 1 when the record cannot be written', async () => {
    const project = await fixture({ gates: [{ id: 'build', behaviour: 'fail' }] });
    await mkdir(scorecardPath(project.root), { recursive: true });

    const { exitCode } = await runCli(['verify', project.epic], { cwd: project.root });

    // The direction that matters most in the other sense: a FAIL laundered into an infra
    // error would look retryable, and the retry merges a branch that does not build.
    expect(exitCode).toBe(1);
  });

  it('leaves result.json and the --json document untouched (AD-11)', async () => {
    const project = await fixture();

    const { stdout } = await runCli(['verify', project.epic, '--json'], {
      cwd: project.root,
    });
    const document = JSON.parse(stdout) as { readonly environment: { readonly runDirectory: string } };
    const stored = await readFile(
      join(project.root, document.environment.runDirectory, 'result.json'),
      'utf8',
    );

    // The scorecard is a PROJECTION, not a second write of the result. Byte-equality
    // between stdout and the stored document (Q53) is exactly what a hook in the wrong
    // place would break.
    expect(stdout).toBe(stored);
    expect(stored).not.toContain('scorecard');
  });
});

describe('the boundary — `createRun` is the line, and it is a POSITION not a condition', () => {
  it('DOES record an absent or unfrozen contract in a gates-only project, because that IS a run', async () => {
    // ⚠️ MEASURED, NOT ASSUMED — and it corrected this suite's first draft, which asserted
    // the opposite. Where a compiled plan exists, `resolvePlan` verifies the contract at
    // the edge (`src/cli/commands/verify.ts:792`) and refuses ABOVE `store.createRun`
    // (`:334`), so nothing is recorded. Where no plan exists — the gates-only mode Epic 3
    // shipped — `resolvePlan` returns early without asserting, the run directory is
    // created, and the refusal is the integrity STAGE's instead. The run therefore reaches
    // a classified outcome and belongs in the measurement.
    //
    // Both halves are correct and they are not in tension: the boundary is `createRun`,
    // and which side of it a contract refusal lands on depends on whether a plan was there
    // to compare against. Story 6.6 should read the infra-error rate as "runs that got far
    // enough to be classified", never as "everything that went wrong".
    for (const contract of ['absent', 'draft'] as const) {
      const project = await fixture({ contract });

      const { exitCode } = await runCli(['verify', project.epic], { cwd: project.root });
      const written = await records(project.root);

      expect(exitCode).toBe(3);
      expect(written).toHaveLength(1);
      expect(written[0]?.outcome).toEqual({ infraError: 'integrity' });
    }
  });

  it('records nothing when the config cannot be loaded, above every run there is', async () => {
    // `loadConfig` throws at `src/cli/commands/verify.ts:221` — before the store exists,
    // before a run id is minted, before anything is spawned. There is no outcome to
    // classify and no evidence directory, and a line here would put something in the
    // measurement that never verified anything.
    const project = await fixture();
    await writeFile(
      join(project.root, '.specwitness', 'config.yaml'),
      'this: [is not\n  valid: yaml\n',
      'utf8',
    );

    const { exitCode } = await runCli(['verify', project.epic], { cwd: project.root });

    expect(exitCode).toBe(3);
    await expect(readFile(scorecardPath(project.root), 'utf8')).rejects.toThrow();
  });

  it('records nothing when --no-ai refuses a missing plan', async () => {
    // The refusal happens while there is still no run directory, deliberately (story 4.7):
    // a refusal afterwards would leave a `result.json` describing a run that adjudicated
    // nothing. The scorecard inherits that reasoning rather than restating it.
    const project = await probeFixture({ plan: false, fakePlanAuthor: true });

    const { exitCode } = await runCli(['verify', project.epic, '--no-ai'], {
      cwd: project.root,
    });

    expect(exitCode).toBe(3);
    await expect(readFile(scorecardPath(project.root), 'utf8')).rejects.toThrow();
  });

  it('records nothing for a usage error, which is not a run at all', async () => {
    const project = await fixture();

    const { exitCode } = await runCli(['verify'], { cwd: project.root });

    // Exit 64 sits OUTSIDE the 0-3 band precisely so a flag mistake is never mistaken for
    // a verdict (ADR-002). It is not a measurement of anything.
    expect(exitCode).toBe(64);
    await expect(readFile(scorecardPath(project.root), 'utf8')).rejects.toThrow();
  });

  it('records nothing in a project that was never initialised', async () => {
    const project = await fixture();
    await rm(join(project.root, '.specwitness'), { recursive: true, force: true });

    const { exitCode } = await runCli(['verify', project.epic], { cwd: project.root });

    expect(exitCode).toBe(3);
    await expect(readFile(scorecardPath(project.root), 'utf8')).rejects.toThrow();
  });
});

describe('nothing untrusted or unredacted reaches the file (AD-10)', () => {
  it('does not carry a secret that a verified project printed', async () => {
    // `seedSecret` puts a token into every capture path the run touches — service output,
    // observation output, gate output. It reaches `result.json`'s evidence redacted; the
    // scorecard carries no evidence at all, which is the stronger property.
    const project = await probeFixture({ seedSecret: true });

    await runCli(['verify', project.epic], { cwd: project.root });
    const text = await readFile(scorecardPath(project.root), 'utf8');

    // Asserting the secret is ABSENT rather than that a marker is present (Epic 3 retro
    // §7): output carrying `[REDACTED]` with the secret still beside it survives review
    // in a way a raw leak does not.
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('s3cr3t');
  });

  it('carries no absolute path, so a record can be pasted into an issue', async () => {
    const project = await probeFixture({});

    await runCli(['verify', project.epic], { cwd: project.root });
    const text = await readFile(scorecardPath(project.root), 'utf8');

    // The worktree path and the run directory are both deliberately absent from the
    // record. A scorecard is the file most likely to leave this machine.
    expect(text).not.toContain(project.root);
    expect(text).not.toContain('specwitness-worktree');
  });
});

describe('ADR-008 §5 — the log survives a line it cannot read', () => {
  it('keeps appending after a corrupt line, rather than refusing or rewriting the file', async () => {
    const project = await fixture();
    await writeFile(scorecardPath(project.root), '{"schemaVersion":1,"runId":"run-tru\n', 'utf8');

    const { exitCode } = await runCli(['verify', project.epic], { cwd: project.root });
    const text = await readFile(scorecardPath(project.root), 'utf8');

    expect(exitCode).toBe(0);
    // The damaged line is STILL THERE. An append-only log does not repair itself, and a
    // writer that rewrote the file to "fix" it would destroy whatever else was in it —
    // the reader is where ADR-008 §5 puts the tolerance, and it counts what it skipped.
    expect(text).toContain('run-tru');
    expect(text.split('\n').filter(Boolean)).toHaveLength(2);
  });
});
