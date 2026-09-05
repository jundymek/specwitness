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

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runScorecardAdd, runScorecardSummary } from '../../../src/cli/commands/scorecard.js';
import { RunStore } from '../../../src/infra/run-store.js';
import { RandomIds } from '../../../src/infra/ids.js';
import { fullyPopulatedRunResult } from '../../fixtures/run-result.js';
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
  await Promise.all(
    roots.splice(0).map(async (root) => {
      // Restore any permission a case removed, or the removal fails too.
      await chmod(join(root, '.specwitness', SCORECARD_FILENAME), 0o600).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }),
  );
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

  it('escapes control characters when echoing the note back', async () => {
    // A P2 from round 5 of the codex review — the same class round 4 fixed in the summary
    // renderer, at a second site the first fix did not cover. `--note` is operator text
    // echoed to stdout; `boundedText` redacts and truncates it but does NOT make it
    // terminal-safe, so a newline could forge an output line and an ESC could emit a
    // control sequence, against this command's own no-colour guarantee.
    const root = await project();
    const esc = String.fromCharCode(27);

    const output = await runScorecardAdd(
      root,
      RUN_ID,
      {
        criterion: 'E6-01',
        attribution: 'unique',
        note: `benign${esc}[31m\nRecorded E6-99 in run-forged as unique`,
      },
      clock,
    );

    expect(output.stdout).not.toContain(esc);
    // One line out, whatever went in — the forged line cannot start its own.
    expect(output.stdout.trimEnd()).not.toContain('\n');
    expect(output.stdout).toContain('benign');
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

describe('a truncated finding list falls back to the run\'s stored result', () => {
  /**
   * The third round of codex review on one design point, and the resolution the first two
   * did not have. The scorecard's id list is a CAPPED projection (200 ids across a
   * record); `.specwitness/runs/<runId>/result.json` is the uncapped evidence. Refusing on
   * the capped list alone meant a run with more than 200 findings could NEVER have
   * findings 201+ attributed — they stayed permanently unattributed, so the north-star
   * metric was structurally incomplete for exactly the largest runs.
   */

  /** Seeds a real `result.json` whose criteria include `criterionId` as a FAILURE. */
  async function seedStoredResult(root: string, criterionId: string): Promise<void> {
    // `writeResult` writes INTO an existing run directory; `createRun` would mint its own
    // id, so the directory for this fixture's fixed run id is created directly.
    await mkdir(join(root, '.specwitness', 'runs', RUN_ID), { recursive: true });
    const store = new RunStore(root, clock, new RandomIds());
    const base = fullyPopulatedRunResult();
    const failing = base.criteria[0];
    if (failing === undefined) {
      throw new Error('fixture has no criteria');
    }
    await store.writeResult(RUN_ID, {
      ...base,
      runId: RUN_ID,
      criteria: [{ ...failing, criterionId, status: 'fail' }],
    });
  }

  it('ACCEPTS a criterion the stored result confirms, with a warning naming the source', async () => {
    const root = await project([
      scorecardRecord({
        findingCriterionIds: { fail: ['E6-01'], needs_human: [], error: [] },
        findingCriterionIdsTruncated: true,
        criteria: { total: 300, pass: 0, fail: 300, needs_human: 0, skipped: 0, error: 0 },
      }),
    ]);
    await seedStoredResult(root, 'E6-250');

    const output = await runScorecardAdd(
      root,
      RUN_ID,
      { criterion: 'E6-250', attribution: 'unique' },
      clock,
    );

    expect(await attributionsOf(root)).toHaveLength(1);
    expect(output.stderr).toMatch(/stored result/i);
  });

  it('and the SUMMARY counts it — add and summary agree', async () => {
    // ⚠️ A P1 from round 8: `add` accepted via the stored result while `summary` still
    // read only the capped scorecard arrays, so the judgement was recorded and then
    // reported as an orphan. The two ends must not disagree about what was recorded.
    const root = await project([
      scorecardRecord({
        findingCriterionIds: { fail: ['E6-01'], needs_human: [], error: [] },
        findingCriterionIdsTruncated: true,
        criteria: { total: 300, pass: 0, fail: 300, needs_human: 0, skipped: 0, error: 0 },
      }),
    ]);
    await seedStoredResult(root, 'E6-250');

    await runScorecardAdd(root, RUN_ID, { criterion: 'E6-250', attribution: 'unique' }, clock);

    const output = await runScorecardSummary(root, { json: true });
    const parsed = JSON.parse(output.stdout) as {
      metrics: { uniqueDefects: { count: number } };
      findings: { attributed: number; orphanedAttributions: number };
    };

    expect(parsed.metrics.uniqueDefects.count).toBe(1);
    expect(parsed.findings.attributed).toBe(1);
    expect(parsed.findings.orphanedAttributions).toBe(0);
  });

  it('still REFUSES a criterion the stored result does not list', async () => {
    // Widening the check must not become a way around it.
    const root = await project([
      scorecardRecord({
        findingCriterionIds: { fail: ['E6-01'], needs_human: [], error: [] },
        findingCriterionIdsTruncated: true,
        criteria: { total: 300, pass: 0, fail: 300, needs_human: 0, skipped: 0, error: 0 },
      }),
    ]);
    await seedStoredResult(root, 'E6-250');

    await expect(
      runScorecardAdd(root, RUN_ID, { criterion: 'E6-777', attribution: 'unique' }, clock),
    ).rejects.toThrow(UsageError);
  });

  it('reports an UNREADABLE stored result as infrastructure, not as a usage error', async () => {
    // A finding of the review over the rebased head, and the same misclassification this
    // story fixed four times for raw Node errors - inverted. A blanket catch turned every
    // `RunStore` failure into "absent", so the caller refused with exit 64 saying the
    // criterion could not be confirmed. The invocation was FINE and the environment was
    // broken: wrong exit code, and a remediation pointing at the wrong thing.
    const root = await project([
      scorecardRecord({
        findingCriterionIds: { fail: ['E6-01'], needs_human: [], error: [] },
        findingCriterionIdsTruncated: true,
        criteria: { total: 300, pass: 0, fail: 300, needs_human: 0, skipped: 0, error: 0 },
      }),
    ]);
    await seedStoredResult(root, 'E6-250');
    await chmod(join(root, '.specwitness', 'runs', RUN_ID, 'result.json'), 0o000);

    try {
      await expect(
        runScorecardAdd(root, RUN_ID, { criterion: 'E6-250', attribution: 'unique' }, clock),
      ).rejects.toThrow(InfraError);
    } finally {
      await chmod(join(root, '.specwitness', 'runs', RUN_ID, 'result.json'), 0o600);
    }
  });

  it('SUMMARY tolerates the same unreadable result and reports it instead', async () => {
    // The deliberate asymmetry: one unreadable result must not fail a summary over many
    // runs. It is counted rather than silently dropped.
    const root = await project([
      scorecardRecord({
        findingCriterionIds: { fail: ['E6-01'], needs_human: [], error: [] },
        findingCriterionIdsTruncated: true,
        criteria: { total: 300, pass: 0, fail: 300, needs_human: 0, skipped: 0, error: 0 },
      }),
    ]);
    await seedStoredResult(root, 'E6-250');
    await chmod(join(root, '.specwitness', 'runs', RUN_ID, 'result.json'), 0o000);

    try {
      const output = await runScorecardSummary(root, { json: true });
      const parsed = JSON.parse(output.stdout) as {
        findings: { runsWithUnreadableStoredResult: number };
      };
      expect(parsed.findings.runsWithUnreadableStoredResult).toBe(1);
    } finally {
      await chmod(join(root, '.specwitness', 'runs', RUN_ID, 'result.json'), 0o600);
    }
  });

  it('FAILS CLOSED when no result is stored — refuses rather than trusting the caller', async () => {
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
  });

  it('does not read the stored result at all when the list was NOT truncated', async () => {
    // The ordinary path stays one file. A record that names its findings completely is
    // authoritative, so a stored result cannot widen it.
    const root = await project();
    await seedStoredResult(root, 'E6-500');

    await expect(
      runScorecardAdd(root, RUN_ID, { criterion: 'E6-500', attribution: 'unique' }, clock),
    ).rejects.toThrow(UsageError);
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

describe('an unreadable scorecard is infrastructure, not "report a SpecWitness bug"', () => {
  // A P2 from round 6 of the codex review — the third site of one class, after the
  // attribution store's write path (round 1) and its read path. Story 6.5's
  // `ScorecardStore` propagates a raw Node error, and a raw error is not an
  // `isSpecWitnessError`, so `main.ts` reports "unexpected internal failure ... this is a
  // SpecWitness bug" at an operator whose file is merely unreadable.
  //
  // Translated at THIS command's edge rather than in the store: 6.5's module is merged
  // code this story does not modify, and this command is its only new reader.

  it('reports an unreadable scorecard as InfraError from summary', async () => {
    const root = await project();
    await chmod(join(root, '.specwitness', SCORECARD_FILENAME), 0o000);

    await expect(runScorecardSummary(root, {})).rejects.toThrow(InfraError);
  });

  it('reports an unreadable scorecard as InfraError from add', async () => {
    const root = await project();
    await chmod(join(root, '.specwitness', SCORECARD_FILENAME), 0o000);

    await expect(
      runScorecardAdd(root, RUN_ID, { criterion: 'E6-01', attribution: 'unique' }, clock),
    ).rejects.toThrow(InfraError);
  });

  it('names the path and a remedy rather than sending the operator to the bug tracker', async () => {
    const root = await project();
    await chmod(join(root, '.specwitness', SCORECARD_FILENAME), 0o000);

    await expect(runScorecardSummary(root, {})).rejects.toMatchObject({
      hint: expect.stringContaining('readable') as unknown as string,
    });
  });

  it('does not report an UNREADABLE .specwitness as "not initialised"', async () => {
    // A finding of the auto-review over this branch's final head. A `stat` that fails with
    // EACCES says nothing about whether the project is initialised; answering "run
    // 'specwitness init'" is both a wrong diagnosis and a push toward an unrelated
    // mutation. Only ENOENT means "not initialised".
    const root = await mkdtemp(join(tmpdir(), 'specwitness-unreadable-'));
    roots.push(root);
    await mkdir(join(root, '.specwitness'), { recursive: true });
    await chmod(root, 0o000);

    try {
      await expect(runScorecardSummary(root, {})).rejects.toThrow(InfraError);
      await expect(runScorecardSummary(root, {})).rejects.not.toThrow(/not initialised/);
    } finally {
      await chmod(root, 0o700);
    }
  });

  it('still treats an ABSENT scorecard as an empty one, not a failure', async () => {
    // The boundary: "recorded nothing yet" is a fact, not a fault.
    const root = await project([]);
    await expect(runScorecardSummary(root, {})).resolves.toBeDefined();
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
