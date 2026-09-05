/**
 * Story 6.6 — `scorecard add` / `scorecard summary` through the BUILT BINARY.
 *
 * These spawn `dist/cli.js`, so they exercise the real argument parsing, the real exit
 * table and the real stream discipline. Three things can only be proved here:
 *
 *  - **the exit codes** — 0 / 64 / 3, and never 1 or 2. `src/cli/exit.ts` is the single
 *    table and this story adds nothing to it, so the assertion is that the existing codes
 *    come out of the existing classifier;
 *  - **no-TTY safety (AC1)** — stdin is closed and not a terminal, and the command must
 *    still complete without prompting. A unit test cannot prove the absence of a hang;
 *  - **`--json` stream discipline** — stdout must parse on its own, with every human line
 *    on stderr, because a harness pipes this.
 *
 * H-8/H-13: every case runs in its own `mkdtemp` project and spawns only the CLI itself —
 * no `claude`, no `codex`, no network.
 */

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SCORECARD_FILENAME,
  SCORECARD_RECORD_VERSION,
  serializeScorecardRecord,
  type ScorecardRecord,
} from '../../src/schemas/scorecard.js';
import { ATTRIBUTIONS_FILENAME } from '../../src/schemas/scorecard-attribution.js';

const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

/** The frozen table (ADR-002). This story adds none of these and changes none. */
const EXIT_OK = 0;
const EXIT_INFRA = 3;
const EXIT_USAGE = 64;

const RUN_A = 'run-20260904T120000Z-aa11';
const RUN_B = 'run-20260904T130000Z-bb22';

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'specwitness-scorecard-e2e-'));
});

afterEach(async () => {
  // Restore any permission a case removed, or the cleanup fails too.
  await chmod(join(projectRoot, '.specwitness'), 0o700).catch(() => undefined);
  await rm(projectRoot, { recursive: true, force: true });
});

/**
 * Runs the built CLI in the temp project.
 *
 * `input: ''` closes stdin — so stdin is NOT a terminal, which is the condition AC1's
 * "no-TTY safe" is about. A command that prompted would hang here rather than pass.
 */
async function cli(args: string[]) {
  const result = await execa(process.execPath, [CLI, ...args], {
    reject: false,
    cwd: projectRoot,
    input: '',
  });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

function record(overrides: Partial<ScorecardRecord> = {}): ScorecardRecord {
  return {
    schemaVersion: SCORECARD_RECORD_VERSION,
    runId: RUN_A,
    epic: 'epic-6',
    startedAt: '2026-09-04T12:00:00.000Z',
    finishedAt: '2026-09-04T12:00:04.000Z',
    durationMs: 4000,
    outcome: { verdict: 'FAIL' },
    criteria: { total: 3, pass: 1, fail: 1, needs_human: 1, skipped: 0, error: 0 },
    gates: { total: 1, pass: 1, fail: 0, skipped: 0 },
    flakiness: { flakyCriteria: 0, retriedCriteria: 0, extraAttempts: 0 },
    providerInvocations: 0,
    providerRoles: [],
    stageDurationsMs: {},
    findingCriterionIds: { fail: ['E6-01'], needs_human: ['E6-02'], error: [] },
    findingCriterionIdsTruncated: false,
    adapted: false,
    environment: {
      specwitnessVersion: '0.1.0',
      nodeVersion: 'v22.13.0',
      platform: 'linux',
      arch: 'x64',
    },
    ...overrides,
  };
}

/** Seeds `.specwitness/scorecard.jsonl` directly — story 6.5's writer is not mine to call. */
async function seedScorecard(records: readonly ScorecardRecord[]): Promise<void> {
  await mkdir(join(projectRoot, '.specwitness'), { recursive: true });
  await writeFile(
    join(projectRoot, '.specwitness', SCORECARD_FILENAME),
    records.map(serializeScorecardRecord).join(''),
    'utf8',
  );
}

describe('scorecard add — through the built binary', () => {
  it('records an attribution and exits 0', async () => {
    await seedScorecard([record()]);

    const result = await cli([
      'scorecard',
      'add',
      RUN_A,
      '--criterion',
      'E6-01',
      '--attribution',
      'unique',
    ]);

    expect(result.exitCode).toBe(EXIT_OK);
    const text = await readFile(join(projectRoot, '.specwitness', ATTRIBUTIONS_FILENAME), 'utf8');
    expect(JSON.parse(text.trim())).toMatchObject({
      runId: RUN_A,
      criterionId: 'E6-01',
      attribution: 'unique',
    });
  });

  it('exits 64 with an ERROR/HINT pair when the attribution is omitted', async () => {
    // ⚠️ There is no default. FR-34 is human judgment.
    await seedScorecard([record()]);

    const result = await cli(['scorecard', 'add', RUN_A, '--criterion', 'E6-01']);

    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('ERROR:');
    expect(result.stderr).toContain('HINT:');
  });

  it('exits 64 for a criterion that produced no finding', async () => {
    await seedScorecard([record()]);

    const result = await cli([
      'scorecard',
      'add',
      RUN_A,
      '--criterion',
      'E6-40',
      '--attribution',
      'unique',
    ]);

    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toMatch(/no finding/i);
  });

  it('exits 64 for an unknown run id', async () => {
    await seedScorecard([record()]);

    const result = await cli([
      'scorecard',
      'add',
      RUN_B,
      '--criterion',
      'E6-01',
      '--attribution',
      'unique',
    ]);

    expect(result.exitCode).toBe(EXIT_USAGE);
  });

  it('exits 64 for an invalid attribution value', async () => {
    await seedScorecard([record()]);

    const result = await cli([
      'scorecard',
      'add',
      RUN_A,
      '--criterion',
      'E6-01',
      '--attribution',
      'looks-real-to-me',
    ]);

    expect(result.exitCode).toBe(EXIT_USAGE);
  });

  it('exits 3, not 64, in an uninitialised project', async () => {
    // The invocation was fine; the environment is not. Reporting this as 64 would tell a
    // caller to fix a command line that is already correct.
    const result = await cli([
      'scorecard',
      'add',
      RUN_A,
      '--criterion',
      'E6-01',
      '--attribution',
      'unique',
    ]);

    expect(result.exitCode).toBe(EXIT_INFRA);
    expect(result.stderr).toMatch(/not initialised/i);
  });

  it('NEVER exits 1 or 2 — the scorecard adjudicates nothing (AD-6)', async () => {
    await seedScorecard([record()]);

    for (const args of [
      ['scorecard', 'add', RUN_A, '--criterion', 'E6-01', '--attribution', 'unique'],
      ['scorecard', 'add', RUN_A, '--criterion', 'E6-40', '--attribution', 'unique'],
      ['scorecard', 'add', 'nope', '--criterion', 'E6-01', '--attribution', 'unique'],
      ['scorecard', 'summary'],
      ['scorecard', 'summary', '--json'],
    ]) {
      const result = await cli(args);
      expect([EXIT_OK, EXIT_INFRA, EXIT_USAGE]).toContain(result.exitCode);
    }
  });
});

describe('scorecard summary — through the built binary', () => {
  it('reports the north star with its denominators, exit 0', async () => {
    await seedScorecard([record()]);
    await cli(['scorecard', 'add', RUN_A, '--criterion', 'E6-01', '--attribution', 'unique']);

    const result = await cli(['scorecard', 'summary']);

    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toMatch(/1 of 1 judged, of 2 findings/);
    expect(result.stdout).toMatch(/Unattributed:\s+1/);
  });

  it('emits a parseable document on stdout under --json, human text on stderr', async () => {
    await seedScorecard([record()]);

    const result = await cli(['scorecard', 'summary', '--json']);

    expect(result.exitCode).toBe(EXIT_OK);
    // The whole of stdout must parse. One stray human line breaks every consumer.
    const parsed = JSON.parse(result.stdout) as { schemaVersion: number };
    expect(parsed.schemaVersion).toBeGreaterThan(0);
    expect(result.stderr).toMatch(/Summarised/);
  });

  it('answers over a project with no scorecard at all, exit 0', async () => {
    await mkdir(join(projectRoot, '.specwitness'), { recursive: true });

    const result = await cli(['scorecard', 'summary']);

    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toMatch(/no runs recorded/i);
    expect(result.stdout).not.toMatch(/NaN|undefined|Infinity/);
  });

  it('reports skipped records rather than shrinking the denominator (ADR-008 §5)', async () => {
    await seedScorecard([record()]);
    await writeFile(
      join(projectRoot, '.specwitness', SCORECARD_FILENAME),
      `${serializeScorecardRecord(record())}{"schemaVersion":99,"runId":"run-x"}\ntorn line\n`,
      'utf8',
    );

    const result = await cli(['scorecard', 'summary']);

    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toMatch(/Records skipped:\s+2/);
    // Both diagnoses present and distinguishable — never one hiding behind the other.
    expect(result.stdout).toMatch(/version-skew/);
    expect(result.stdout).toMatch(/malformed/);
    // And the message itself, which is what ADR-008 §5 requires be named.
    expect(result.stdout).toMatch(/newer SpecWitness/);
  });

  it('honours a re-attribution end to end: the later record wins', async () => {
    await seedScorecard([record()]);
    await cli(['scorecard', 'add', RUN_A, '--criterion', 'E6-01', '--attribution', 'unique']);
    await cli([
      'scorecard',
      'add',
      RUN_A,
      '--criterion',
      'E6-01',
      '--attribution',
      'false-positive',
    ]);

    const result = await cli(['scorecard', 'summary', '--json']);
    const parsed = JSON.parse(result.stdout) as {
      metrics: { uniqueDefects: { count: number } };
      attributionCounts: Record<string, number>;
    };

    // Two lines in the log, one winning judgement, and it is the correction.
    expect(parsed.metrics.uniqueDefects.count).toBe(0);
    expect(parsed.attributionCounts['false-positive']).toBe(1);
  });

  it('an unattributed finding is never counted as unique, end to end', async () => {
    // ⚠️ The claim this whole story exists to make safe.
    await seedScorecard([record()]);

    const result = await cli(['scorecard', 'summary', '--json']);
    const parsed = JSON.parse(result.stdout) as {
      metrics: { uniqueDefects: { count: number } };
      findings: { unattributed: number };
    };

    expect(parsed.metrics.uniqueDefects.count).toBe(0);
    expect(parsed.findings.unattributed).toBe(2);
  });
});

describe('add and summary agree about a truncated run — the P1 regressions', () => {
  it('refuses an unverifiable criterion rather than recording an uncountable judgement', async () => {
    // ⚠️ Two rounds of codex review converged here. Round 1: `add` accepted while
    // `summary` orphaned, so the operator was told "Recorded" for a judgement the metric
    // could never count. Round 2: closing that by counting them let ANY valid id through,
    // so the north star could exceed the number of findings that exist.
    //
    // Resolved by refusing at the write end. `add` and `summary` now agree because there
    // is no accepted-but-uncountable state to disagree about.
    await seedScorecard([
      record({
        criteria: { total: 300, pass: 0, fail: 300, needs_human: 0, skipped: 0, error: 0 },
        findingCriterionIds: { fail: ['E6-01'], needs_human: [], error: [] },
        findingCriterionIdsTruncated: true,
      }),
    ]);

    const added = await cli([
      'scorecard',
      'add',
      RUN_A,
      '--criterion',
      'E6-250',
      '--attribution',
      'unique',
    ]);

    expect(added.exitCode).toBe(EXIT_USAGE);
    expect(added.stderr).toMatch(/cannot confirm it produced one/);
    expect(added.stderr).toMatch(/specwitness report/);

    const summary = await cli(['scorecard', 'summary', '--json']);
    const parsed = JSON.parse(summary.stdout) as {
      findings: { attributed: number; orphanedAttributions: number; total: number };
      metrics: { uniqueDefects: { count: number } };
    };

    // Nothing was recorded, so nothing is orphaned and the north star stays honest.
    expect(parsed.findings.attributed).toBe(0);
    expect(parsed.findings.orphanedAttributions).toBe(0);
    expect(parsed.metrics.uniqueDefects.count).toBeLessThanOrEqual(parsed.findings.total);
  });

  it('still records a criterion the truncated record DOES name', async () => {
    await seedScorecard([
      record({
        criteria: { total: 300, pass: 0, fail: 300, needs_human: 0, skipped: 0, error: 0 },
        findingCriterionIds: { fail: ['E6-01'], needs_human: [], error: [] },
        findingCriterionIdsTruncated: true,
      }),
    ]);

    const added = await cli([
      'scorecard',
      'add',
      RUN_A,
      '--criterion',
      'E6-01',
      '--attribution',
      'unique',
    ]);

    expect(added.exitCode).toBe(EXIT_OK);
  });
});

describe('a filesystem failure is actionable, not "report a SpecWitness bug" — the P2 regression', () => {
  it('names the path and a remedy when the log cannot be written', async () => {
    // Reproduced against this binary before the fix: exit 3 with
    // `ERROR: unexpected internal failure: Error: EACCES ...` and
    // `HINT: this is a SpecWitness bug — please report it`. The exit code was right and
    // the message sent an operator with a permissions problem to the issue tracker.
    await seedScorecard([record()]);
    await chmod(join(projectRoot, '.specwitness'), 0o500);

    const result = await cli([
      'scorecard',
      'add',
      RUN_A,
      '--criterion',
      'E6-01',
      '--attribution',
      'unique',
    ]);

    await chmod(join(projectRoot, '.specwitness'), 0o700);

    expect(result.exitCode).toBe(EXIT_INFRA);
    expect(result.stderr).not.toMatch(/unexpected internal failure/);
    expect(result.stderr).not.toMatch(/SpecWitness bug/);
    expect(result.stderr).toMatch(/could not be recorded/);
    expect(result.stderr).toMatch(/writable/);
  });
});

describe('no-TTY safety, proven against the real process (AC1)', () => {
  it('completes with stdin closed and not a terminal', async () => {
    // `input: ''` means stdin is a closed pipe. A command that prompted would hang here;
    // vitest would kill the suite rather than report a failure, which is itself the
    // signal. This is the condition every harness invocation runs under.
    await seedScorecard([record()]);

    const result = await cli([
      'scorecard',
      'add',
      RUN_A,
      '--criterion',
      'E6-02',
      '--attribution',
      'duplicate',
      '--note',
      'same root cause as the gate failure',
    ]);

    expect(result.exitCode).toBe(EXIT_OK);
  });

  it('emits no ANSI escape sequence on either stream', async () => {
    await seedScorecard([record()]);
    await cli(['scorecard', 'add', RUN_A, '--criterion', 'E6-01', '--attribution', 'unique']);

    const summary = await cli(['scorecard', 'summary']);
    const json = await cli(['scorecard', 'summary', '--json']);

    // eslint-disable-next-line no-control-regex
    const ansi = /\[/;
    for (const text of [summary.stdout, summary.stderr, json.stdout, json.stderr]) {
      expect(text).not.toMatch(ansi);
    }
  });

  it('--help works for both subcommands and exits 0', async () => {
    for (const args of [
      ['scorecard', '--help'],
      ['scorecard', 'add', '--help'],
      ['scorecard', 'summary', '--help'],
    ]) {
      const result = await cli(args);
      expect(result.exitCode).toBe(EXIT_OK);
    }
  });
});

describe('a --note never carries a secret into the file', () => {
  it('an assignment-shaped secret is ABSENT from the written record', async () => {
    // ABSENCE, never the presence of a marker (Epic 3 retro §7).
    const secret = 'SW-SYNTHETIC-NOT-A-REAL-SECRET-0003';
    await seedScorecard([record()]);

    await cli([
      'scorecard',
      'add',
      RUN_A,
      '--criterion',
      'E6-01',
      '--attribution',
      'unique',
      '--note',
      `reproduced with api_key=${secret}`,
    ]);

    const text = await readFile(join(projectRoot, '.specwitness', ATTRIBUTIONS_FILENAME), 'utf8');
    expect(text).not.toContain(secret);

    // And the summary, which is the thing most likely to be pasted into an issue.
    const summary = await cli(['scorecard', 'summary', '--json']);
    expect(summary.stdout).not.toContain(secret);
  });
});
