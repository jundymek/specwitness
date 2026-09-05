/**
 * `specwitness scorecard add` / `specwitness scorecard summary` — FR-34, AC1/AC2 of
 * story 6.6.
 *
 * ============================================================================
 * ⚠️ NO-TTY SAFE, ABSOLUTELY (AC1)
 * ============================================================================
 *
 * **Every input arrives as a flag.** No prompt, no confirmation, no `isTTY` check, no
 * read from stdin, no colour and no cursor control. This is a repo-wide convention
 * (`CLAUDE.md`: *"agent-callable commands must be prompt-free (no TTY assumptions)"*) and
 * this is the command most likely to be called by a script: an agent in a harness
 * annotates its findings without a human present.
 *
 * A prompt here does not degrade gracefully — it hangs the caller forever. A unit test
 * asserts this module's source contains no `isTTY`, no `process.stdin` and no readline,
 * because a structural guard survives a refactor that a behavioural one may not.
 *
 * ============================================================================
 * ⚠️ THE ATTRIBUTION IS NEVER INFERRED, DEFAULTED OR DERIVED
 * ============================================================================
 *
 * FR-34's classification is human judgment — it is the one input to the north-star metric
 * (PRD SM-1) that no machine can supply. `--attribution` is REQUIRED and its absence is a
 * usage error, never a default. See `src/schemas/scorecard-attribution.ts`.
 *
 * ============================================================================
 * EXIT CODES — THIS STORY ADDS NONE
 * ============================================================================
 *
 * `src/cli/exit.ts` stays the single table (ADR-002 / AD-6). This module writes no exit
 * code and calls `printError` for nothing: it THROWS, and the global handler in `main.ts`
 * classifies and prints exactly one `ERROR:`/`HINT:` pair.
 *
 *  - **`UsageError` → 64.** A malformed or unknown run id, a malformed criterion id, a
 *    criterion that produced no finding, a missing or invalid `--attribution`. Every one
 *    is "fix your invocation". Reporting these as exit 3 would tell a harness the
 *    environment is broken and that retrying might help — it would not.
 *  - **`InfraError` → 3.** The project is not initialised, or a log cannot be read or
 *    written. The invocation was fine; the environment is not.
 *  - **Never 1 or 2.** The scorecard adjudicates nothing. A summary is a report about
 *    verifications, not a verification, so it exits 0 whatever it reports — exactly as
 *    `report` exits 0 whatever verdict it renders.
 *
 * ============================================================================
 * LOCAL ONLY
 * ============================================================================
 *
 * Both stores read and write one file each under the project's own `.specwitness/`, and
 * neither can reach a network (`scorecard-is-local-only` in `.dependency-cruiser.cjs`
 * covers all four scorecard modules). AC2's *"computed from local records only"* is a
 * property of the layer graph here, not a promise.
 *
 * **A run id and a criterion id are INPUTS, NOT PATHS.** Neither ever builds a filesystem
 * path: both stores derive their single path from the project root alone, fixed at
 * construction. Neither reaches a shell — this command spawns no subprocess and mints no
 * `DeclaredCommand` (AD-3). It makes zero provider calls, which is worth stating.
 *
 * AD-1: this is the edge, so it may reach into `infra` and `report`. Nothing beneath the
 * CLI may import back the other way.
 */

import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Command } from 'commander';

import { InfraError, UsageError } from '../../domain/errors.js';
import { isCriterionId, parseCriterionId } from '../../domain/ids.js';
import type { Clock } from '../../domain/ports.js';
import { isRunId, parseRunId } from '../../domain/run-id.js';
import { AttributionStore } from '../../infra/attribution-store.js';
import { SystemClock } from '../../infra/clock.js';
import { ScorecardStore } from '../../infra/scorecard-store.js';
import {
  renderScorecardSummaryJson,
  renderScorecardSummaryTerminal,
  summarizeScorecard,
} from '../../report/scorecard-summary.js';
import {
  ATTRIBUTION_VALUES,
  makeAttributionRecord,
  parseAttributionValue,
} from '../../schemas/scorecard-attribution.js';
import type { ScorecardRecord } from '../../schemas/scorecard.js';

/**
 * What a command produced, split by stream.
 *
 * Returned rather than printed so the whole command is testable without capturing process
 * streams — the same reason story 1.6's renderer returns a string, and the same shape
 * `report` uses. The registered actions below are the only place these reach a real
 * stream.
 */
export interface ScorecardOutput {
  readonly stdout: string;
  readonly stderr: string;
}

export interface ScorecardAddOptions {
  readonly criterion?: string;
  readonly attribution?: string;
  readonly note?: string;
}

export interface ScorecardSummaryOptions {
  readonly json?: boolean;
}

const ATTRIBUTION_LIST = ATTRIBUTION_VALUES.join('|');

export function register(program: Command): void {
  const scorecard = program
    .command('scorecard')
    .description('record defect attributions and summarise the dogfooding measurement')
    .addHelpText(
      'after',
      '\nRun this at the project root — the directory holding .specwitness/.\n\n' +
        'The scorecard measures whether SpecWitness finds real defects that earlier gates\n' +
        'missed. It records nothing a verify run did not already record, it changes no\n' +
        'verdict, and it never leaves this machine.\n',
    );

  scorecard
    .command('add')
    .description('attribute one finding — a human judgement SpecWitness will never infer')
    .argument('<run-id>', 'the run the finding came from, e.g. run-20260904T120000Z-ab12')
    .requiredOption('--criterion <id>', "the criterion the finding is about, e.g. 'E6-04'")
    .requiredOption(
      '--attribution <value>',
      `your judgement: ${ATTRIBUTION_LIST}. Required — SpecWitness never infers one`,
    )
    .option('--note <text>', 'optional free-text note; redacted and length-bounded')
    .addHelpText(
      'after',
      '\nThis command is prompt-free and safe to call from a script.\n\n' +
        'Changed your mind? Run it again with the new judgement — the log is append-only\n' +
        'and the most recent attribution for a finding is the one the summary counts.\n',
    )
    .action(async (runId: string, options: ScorecardAddOptions) => {
      const output = await runScorecardAdd(process.cwd(), runId, options, new SystemClock());
      process.stdout.write(output.stdout);
      if (output.stderr !== '') {
        process.stderr.write(output.stderr);
      }
    });

  scorecard
    .command('summary')
    .description('report the north-star metric and its companions, from local records only')
    .option('--json', 'emit the summary document on stdout (stable, versioned schema)')
    .action(async (options: ScorecardSummaryOptions) => {
      const output = await runScorecardSummary(process.cwd(), options);
      process.stdout.write(output.stdout);
      if (output.stderr !== '') {
        process.stderr.write(output.stderr);
      }
    });
}

/**
 * Refuses to touch a project that has not opted into SpecWitness.
 *
 * A read that scaffolds storage turns "you have no runs" into "you have an empty runs
 * directory", in a project the operator has not opted into — the rule `report` states as
 * Q52 and this command keeps. **Neither subcommand creates `.specwitness/`.**
 *
 * The directory is derived from the store's own path rather than re-joined here, so there
 * is exactly one spelling of it in this command.
 */
async function assertInitialised(projectRoot: string): Promise<void> {
  const specwitnessDir = dirname(new ScorecardStore(projectRoot).path);
  const found = await stat(specwitnessDir).catch(() => undefined);

  if (found === undefined || !found.isDirectory()) {
    throw new InfraError(
      `this project is not initialised for SpecWitness (no .specwitness directory in ${projectRoot})`,
      "run 'specwitness init' first, or change to the project root",
    );
  }
}

/**
 * AC1 — append one attribution, linked to a run and a criterion.
 *
 * VALIDATION ORDER IS DELIBERATE: every pure, string-only check happens before the
 * filesystem is touched, so a typo is answered as a usage error (exit 64) rather than
 * surfacing after a read failure as though the environment were at fault.
 *
 * NOTHING IS WRITTEN UNLESS EVERY CHECK PASSES. The record is assembled in memory and the
 * append is the first and only mutation.
 */
export async function runScorecardAdd(
  projectRoot: string,
  rawRunId: string,
  options: ScorecardAddOptions,
  clock: Clock,
): Promise<ScorecardOutput> {
  // ── pure checks first ─────────────────────────────────────────────────────────────

  // Reuses the merged validators so there is ONE run-id and ONE criterion-id error
  // message in this codebase rather than several that drift. Both throw `UsageError`.
  const runId = rawRunId.trim();
  if (!isRunId(runId)) {
    parseRunId(runId);
  }

  const criterionId = options.criterion?.trim() ?? '';
  if (criterionId === '') {
    throw new UsageError(
      '--criterion is required: an attribution is about one specific finding',
      "pass the criterion the finding is about, e.g. --criterion E6-04. 'specwitness report <run-id>' lists a run's criteria",
    );
  }
  if (!isCriterionId(criterionId)) {
    parseCriterionId(criterionId);
  }

  const rawAttribution = options.attribution?.trim() ?? '';
  if (rawAttribution === '') {
    // ⚠️ NO DEFAULT. FR-34 is human judgment and this is the one input no machine may
    // supply — a default here would be SpecWitness grading its own homework.
    throw new UsageError(
      '--attribution is required: only you can judge whether a finding is a real defect',
      `pass one of: ${ATTRIBUTION_LIST}. SpecWitness will never infer this`,
    );
  }
  // Throws `UsageError` on anything outside the closed vocabulary.
  const attribution = parseAttributionValue(rawAttribution);

  // ── then the filesystem ───────────────────────────────────────────────────────────

  await assertInitialised(projectRoot);

  const { records, skipped } = await new ScorecardStore(projectRoot).read();
  const record = records.find((entry) => entry.runId === runId);

  if (record === undefined) {
    throw new UsageError(
      `no run '${runId}' in this project's scorecard`,
      skipped.length > 0
        ? `check the run id — note that ${skipped.length} scorecard record(s) could not be read, ` +
          `so the run may be among them; 'specwitness scorecard summary' reports them`
        : "check the run id; only runs that COMPLETED are recorded, and 'specwitness scorecard summary' reports how many there are",
    );
  }

  const warning = warnUnlessCriterionIsAFinding(record, criterionId);

  const built = makeAttributionRecord({
    runId,
    criterionId,
    attribution,
    recordedAt: clock.now().toISOString(),
    ...(options.note === undefined ? {} : { note: options.note }),
  });

  await new AttributionStore(projectRoot).append(built);

  return {
    stdout:
      `Recorded ${criterionId} in ${runId} as ${attribution}` +
      `${built.note === undefined ? '' : ` — ${built.note}`}\n`,
    stderr: warning,
  };
}

/**
 * Refuses an attribution for a criterion that produced no finding — with one exception.
 *
 * **Why refuse at all.** Attributing a defect to a criterion that PASSED would put a
 * number into the north-star metric that no verification ever produced. The scorecard
 * record names exactly the criteria a finding could be about (`findingCriterionIds`,
 * which is what story 6.5 built that field for), so this is checkable rather than
 * assumed.
 *
 * **The exception, and why it is an acceptance rather than a refusal.** Story 6.5 caps
 * those arrays at 200 ids ACROSS the record and sets `findingCriterionIdsTruncated`. When
 * the cap bit, an id's absence from the list means nothing — the list is not the set. The
 * choice is then between refusing a judgement that may well be legitimate, and accepting
 * it with a warning that says membership could not be confirmed. **Refusing would discard
 * a real north-star data point over a display limit**, and the per-status COUNTS in the
 * same record already prove findings exist beyond the ones named. So: accept, and warn.
 *
 * Returns the warning text (empty when there is none) rather than printing it, so the
 * caller owns stream discipline. Throws `UsageError` when the refusal stands.
 */
function warnUnlessCriterionIsAFinding(record: ScorecardRecord, criterionId: string): string {
  const findings = [
    ...record.findingCriterionIds.fail,
    ...record.findingCriterionIds.needs_human,
    ...record.findingCriterionIds.error,
  ];

  if (findings.includes(criterionId)) {
    return '';
  }

  if (record.findingCriterionIdsTruncated) {
    return (
      `WARNING: run ${record.runId} has a truncated finding list — it had more findings ` +
      `than its record names individually, so SpecWitness could not confirm that ` +
      `${criterionId} was one of them. The attribution was recorded.\n`
    );
  }

  const total = record.criteria.fail + record.criteria.needs_human + record.criteria.error;

  throw new UsageError(
    `criterion ${criterionId} produced no finding in run ${record.runId}, so there is nothing to attribute`,
    total === 0
      ? 'that run had no failures, needs-human criteria or errors at all — check the run id'
      : `that run's findings are: ${findings.join(', ')}`,
  );
}

/**
 * AC2 — the seven metrics, the skipped-record count, and the unattributed count.
 *
 * READS both logs and computes NOTHING itself: the arithmetic lives in
 * `src/report/scorecard-summary.ts`, which structurally cannot open a file. That split is
 * AD-11 — one model, two renderers — expressed by the layer graph rather than by review.
 *
 * **Exits 0 whatever it reports**, like `report`. A summary is a report about
 * verifications, not a verification; mapping a measured rate onto a product exit code
 * would be the scorecard adjudicating something, which AD-6 forbids.
 *
 * STREAM DISCIPLINE (AD-11, Q53/Q55). With `--json`, stdout carries the document and
 * NOTHING else — a harness parses it, and one stray human line breaks `JSON.parse` for
 * every consumer. The human line goes to stderr, exactly as `doctor --json` and
 * `report --json` do.
 */
export async function runScorecardSummary(
  projectRoot: string,
  options: ScorecardSummaryOptions,
): Promise<ScorecardOutput> {
  await assertInitialised(projectRoot);

  const scorecard = await new ScorecardStore(projectRoot).read();
  const attributions = await new AttributionStore(projectRoot).read();

  const summary = summarizeScorecard({ scorecard, attributions });

  if (options.json === true) {
    return {
      stdout: renderScorecardSummaryJson(summary),
      stderr:
        `Summarised ${summary.records.read} run(s) and ${summary.attributionsRead} ` +
        `attribution(s); ${summary.skippedRecords.total} record(s) skipped.\n`,
    };
  }

  return { stdout: renderScorecardSummaryTerminal(summary), stderr: '' };
}
