/**
 * Story 6.6 — `specwitness scorecard add` / `scorecard summary` at the CLI edge.
 *
 * TWO PROPERTIES ARE LOAD-BEARING AND BOTH ARE ASSERTED HERE.
 *
 * **No-TTY safety (AC1).** This command is invoked by agents inside a harness. It must
 * prompt for nothing, assume no terminal, and emit no colour or cursor control — every
 * input arrives as a flag. A prompt here does not degrade gracefully; it hangs a script
 * forever.
 *
 * **Refusals are usage errors, not infrastructure ones.** An unknown run id or a
 * criterion that did not fail is a fix-your-invocation problem (exit 64). Reporting one
 * as exit 3 would tell a harness the environment is broken and that retrying might help.
 * This story adds NO exit code — `src/cli/exit.ts` stays the single table.
 *
 * Hermetic (H-8): every case runs in its own `mkdtemp` project. No subprocess is spawned.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runScorecardAdd, runScorecardSummary } from '../../../src/cli/commands/scorecard.js';
import { InfraError, UsageError } from '../../../src/domain/errors.js';
import type { Clock } from '../../../src/domain/ports.js';
import {
  ATTRIBUTIONS_FILENAME,
  ATTRIBUTION_RECORD_VERSION,
} from '../../../src/schemas/scorecard-attribution.js';
import {
  SCORECARD_FILENAME,
  SCORECARD_RECORD_VERSION,
  serializeScorecardRecord,
  type ScorecardRecord,
} from '../../../src/schemas/scorecard.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

const clock: Clock = { now: () => new Date('2026-09-05T10:00:00.000Z') };

const RUN_ID = 'run-20260904T120000Z-ab12';

function scorecardRecord(overrides: Partial<ScorecardRecord> = {}): ScorecardRecord {
  return {
    schemaVersion: SCORECARD_RECORD_VERSION,
    runId: RUN_ID,
    epic: 'epic-6',
    startedAt: '2026-09-04T12:00:00.000Z',
    finishedAt: '2026-09-04T12:00:03.000Z',
    durationMs: 3000,
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

/** An initialised project whose scorecard holds `records`. */
async function project(records: readonly ScorecardRecord[] = [scorecardRecord()]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'specwitness-scorecard-cli-'));
  roots.push(root);
  await mkdir(join(root, '.specwitness'), { recursive: true });
  if (records.length > 0) {
    await writeFile(
      join(root, '.specwitness', SCORECARD_FILENAME),
      records.map(serializeScorecardRecord).join(''),
      'utf8',
    );
  }
  return root;
}

/** A directory with no `.specwitness/` at all. */
async function uninitialised(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'specwitness-bare-'));
  roots.push(root);
  return root;
}

async function attributionsOf(root: string): Promise<readonly unknown[]> {
  const text = await readFile(join(root, '.specwitness', ATTRIBUTIONS_FILENAME), 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as unknown);
}

/* ── scorecard add ────────────────────────────────────────────────────────────────── */

describe('scorecard add — the happy path', () => {
  it('appends an attribution linked to the run and criterion (AC1)', async () => {
    const root = await project();

    const output = await runScorecardAdd(root, RUN_ID, {
      criterion: 'E6-01',
      attribution: 'unique',
    }, clock);

    expect(await attributionsOf(root)).toEqual([
      {
        schemaVersion: ATTRIBUTION_RECORD_VERSION,
        runId: RUN_ID,
        criterionId: 'E6-01',
        attribution: 'unique',
        recordedAt: '2026-09-05T10:00:00.000Z',
      },
    ]);
    expect(output.stdout).toContain('E6-01');
  });

  it('accepts a needs_human finding, not only a failure', async () => {
    const root = await project();
    await runScorecardAdd(root, RUN_ID, { criterion: 'E6-02', attribution: 'duplicate' }, clock);
    expect(await attributionsOf(root)).toHaveLength(1);
  });

  it("accepts FR-34's longer spelling of the duplicate judgement", async () => {
    const root = await project();
    await runScorecardAdd(
      root,
      RUN_ID,
      { criterion: 'E6-01', attribution: 'duplicate-of-earlier-gate' },
      clock,
    );
    const [record] = await attributionsOf(root);
    expect((record as { attribution: string }).attribution).toBe('duplicate');
  });

  it('records a note, redacted and bounded', async () => {
    const root = await project();
    const secret = 'SW-SYNTHETIC-NOT-A-REAL-SECRET-0002';

    await runScorecardAdd(
      root,
      RUN_ID,
      { criterion: 'E6-01', attribution: 'unique', note: `leaked api_key=${secret} here` },
      clock,
    );

    const text = await readFile(join(root, '.specwitness', ATTRIBUTIONS_FILENAME), 'utf8');
    // ABSENCE, never the presence of a marker (Epic 3 retro §7).
    expect(text).not.toContain(secret);
  });

  it('allows a re-attribution — people change their minds', async () => {
    const root = await project();
    await runScorecardAdd(root, RUN_ID, { criterion: 'E6-01', attribution: 'unique' }, clock);
    await runScorecardAdd(
      root,
      RUN_ID,
      { criterion: 'E6-01', attribution: 'false-positive' },
      clock,
    );

    // BOTH records are kept: an append-only log expresses a correction as a later line
    // rather than by rewriting history. The summary resolves which one wins.
    expect(await attributionsOf(root)).toHaveLength(2);
  });
});

describe('scorecard add — refusals are usage errors, and each names its remedy', () => {
  it('refuses a malformed run id', async () => {
    const root = await project();
    await expect(
      runScorecardAdd(root, 'not-a-run-id', { criterion: 'E6-01', attribution: 'unique' }, clock),
    ).rejects.toThrow(UsageError);
  });

  it('refuses a run id that is not in the scorecard', async () => {
    const root = await project();
    await expect(
      runScorecardAdd(
        root,
        'run-20261231T235959Z-zzzz',
        { criterion: 'E6-01', attribution: 'unique' },
        clock,
      ),
    ).rejects.toThrow(UsageError);
  });

  it('refuses a malformed criterion id', async () => {
    const root = await project();
    await expect(
      runScorecardAdd(root, RUN_ID, { criterion: 'nonsense', attribution: 'unique' }, clock),
    ).rejects.toThrow(UsageError);
  });

  it('refuses a criterion that did NOT produce a finding in that run', async () => {
    // E6-99 is not among that run's fail/needs_human/error ids. Attributing a defect to a
    // criterion that passed would put a number into the north-star metric that no
    // verification ever produced.
    const root = await project();
    await expect(
      runScorecardAdd(root, RUN_ID, { criterion: 'E6-99', attribution: 'unique' }, clock),
    ).rejects.toThrow(UsageError);
  });

  it('refuses an invalid attribution rather than defaulting one', async () => {
    const root = await project();
    await expect(
      runScorecardAdd(root, RUN_ID, { criterion: 'E6-01', attribution: 'probably' }, clock),
    ).rejects.toThrow(UsageError);
  });

  it('refuses a MISSING attribution — there is no default, ever', async () => {
    // ⚠️ FR-34 is human judgment. A default here would be a machine supplying it.
    const root = await project();
    await expect(
      runScorecardAdd(root, RUN_ID, { criterion: 'E6-01' }, clock),
    ).rejects.toThrow(UsageError);
  });

  it('refuses a missing --criterion', async () => {
    const root = await project();
    await expect(
      runScorecardAdd(root, RUN_ID, { attribution: 'unique' }, clock),
    ).rejects.toThrow(UsageError);
  });

  it('reports an uninitialised project as infrastructure, not usage', async () => {
    // The invocation was fine; the environment is not. `report` sets this precedent.
    const root = await uninitialised();
    await expect(
      runScorecardAdd(root, RUN_ID, { criterion: 'E6-01', attribution: 'unique' }, clock),
    ).rejects.toThrow(InfraError);
  });

  it('writes NOTHING when it refuses', async () => {
    const root = await project();
    await expect(
      runScorecardAdd(root, RUN_ID, { criterion: 'E6-99', attribution: 'unique' }, clock),
    ).rejects.toThrow();

    await expect(
      readFile(join(root, '.specwitness', ATTRIBUTIONS_FILENAME), 'utf8'),
    ).rejects.toThrow();
  });
});

describe('scorecard add — a truncated finding list is REFUSED, not accepted', () => {
  it('refuses a criterion the truncated record does not name, and points at report', async () => {
    // ⚠️ THIS REVERSES AN EARLIER VERSION OF THIS STORY, and the reason is worth keeping.
    // Story 6.5 caps the id arrays at 200 across a record, so when the cap bit an id's
    // absence proves nothing. I first ACCEPTED such an attribution with a warning, to
    // avoid discarding a real north-star data point over a display limit.
    //
    // Round 2 of the codex review showed that let ANY syntactically valid id through, so
    // `attributed` and `uniqueDefects.count` could exceed `findings.total` — a north-star
    // count larger than the number of findings that exist. The trade is asymmetric:
    // refusing costs a narrow, rare case; accepting makes the one number this product
    // exists to produce corruptible by a typo.
    const root = await project([
      scorecardRecord({
        findingCriterionIds: { fail: ['E6-01'], needs_human: [], error: [] },
        findingCriterionIdsTruncated: true,
        criteria: { total: 300, pass: 0, fail: 300, needs_human: 0, skipped: 0, error: 0 },
      }),
    ]);

    await expect(
      runScorecardAdd(root, RUN_ID, { criterion: 'E6-250', attribution: 'unique' }, clock),
    ).rejects.toThrow(UsageError);

    // And nothing was written.
    await expect(
      readFile(join(root, '.specwitness', ATTRIBUTIONS_FILENAME), 'utf8'),
    ).rejects.toThrow();
  });

  it('still accepts a criterion the truncated record DOES name', async () => {
    // The permit half: truncation does not disqualify the ids that are listed.
    const root = await project([
      scorecardRecord({
        findingCriterionIds: { fail: ['E6-01'], needs_human: [], error: [] },
        findingCriterionIdsTruncated: true,
        criteria: { total: 300, pass: 0, fail: 300, needs_human: 0, skipped: 0, error: 0 },
      }),
    ]);

    await runScorecardAdd(root, RUN_ID, { criterion: 'E6-01', attribution: 'unique' }, clock);
    expect(await attributionsOf(root)).toHaveLength(1);
  });
});

/* ── scorecard summary ────────────────────────────────────────────────────────────── */

describe('scorecard summary', () => {
  it('answers over an empty project without throwing', async () => {
    // No scorecard file at all. This is the moment somebody is deciding whether the gate
    // is worth keeping; a stack trace is not an answer.
    const root = await project([]);
    const output = await runScorecardSummary(root, {});
    expect(output.stdout).toMatch(/no runs recorded/i);
    expect(output.stdout).not.toMatch(/NaN|undefined/);
  });

  it('reports the north star with its denominators', async () => {
    const root = await project();
    await runScorecardAdd(root, RUN_ID, { criterion: 'E6-01', attribution: 'unique' }, clock);

    const output = await runScorecardSummary(root, {});
    // One judged `unique`, of 1 attributed, of 2 findings in the run.
    expect(output.stdout).toMatch(/1 of 1 judged, of 2 findings/);
    expect(output.stdout).toMatch(/Unattributed:\s+1/);
  });

  it('emits ONLY the JSON document on stdout under --json', async () => {
    // A harness parses this. One stray human line breaks `JSON.parse` for every consumer.
    const root = await project();
    const output = await runScorecardSummary(root, { json: true });

    expect(() => JSON.parse(output.stdout) as unknown).not.toThrow();
    const parsed = JSON.parse(output.stdout) as { schemaVersion: number };
    expect(parsed.schemaVersion).toBeGreaterThan(0);
  });

  it('puts every human line on stderr under --json', async () => {
    const root = await project();
    const output = await runScorecardSummary(root, { json: true });
    expect(output.stdout.trimStart().startsWith('{')).toBe(true);
    expect(output.stderr).not.toBe('');
  });

  it('reports skipped records rather than shrinking the denominator (ADR-008 §5)', async () => {
    const root = await project();
    await writeFile(
      join(root, '.specwitness', SCORECARD_FILENAME),
      `${serializeScorecardRecord(scorecardRecord())}this line is not json\n`,
      'utf8',
    );

    const output = await runScorecardSummary(root, {});
    expect(output.stdout).toMatch(/Records skipped:\s+1/);
  });

  it('reports an uninitialised project as infrastructure', async () => {
    const root = await uninitialised();
    await expect(runScorecardSummary(root, {})).rejects.toThrow(InfraError);
  });
});

/* ── no-TTY safety (AC1) ──────────────────────────────────────────────────────────── */

describe('no-TTY safety — this command is called by scripts', () => {
  it('emits no ANSI escape sequence in either view', async () => {
    const root = await project();
    await runScorecardAdd(root, RUN_ID, { criterion: 'E6-01', attribution: 'unique' }, clock);

    const human = await runScorecardSummary(root, {});
    const machine = await runScorecardSummary(root, { json: true });
    const added = await runScorecardAdd(
      root,
      RUN_ID,
      { criterion: 'E6-02', attribution: 'duplicate' },
      clock,
    );

    // eslint-disable-next-line no-control-regex
    const ansi = /\[/;
    for (const text of [human.stdout, human.stderr, machine.stdout, machine.stderr, added.stdout]) {
      expect(text).not.toMatch(ansi);
    }
  });

  it('never consults process.stdin.isTTY, and reads nothing from stdin', async () => {
    // Structural: the module's CODE must not reference stdin or isTTY at all. A prompt
    // does not degrade gracefully in a harness — it hangs the script forever.
    //
    // Comments are stripped before scanning, and that is the point rather than a
    // convenience: the module header explains at length that it makes no `isTTY` check,
    // and a scan over raw text would fail on the prose that documents the guarantee. The
    // guarantee is about code, so the scan is about code.
    const source = await readFile(
      new URL('../../../src/cli/commands/scorecard.ts', import.meta.url),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(code).not.toMatch(/isTTY/);
    expect(code).not.toMatch(/process\.stdin/);
    expect(code).not.toMatch(/createInterface|readline|prompt\(/);

    // And the stripping itself must not be vacuous — if it removed everything, the three
    // assertions above would pass over an empty string and prove nothing.
    expect(code).toMatch(/export async function runScorecardAdd/);
  });
});
