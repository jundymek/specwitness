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
import { RandomIds } from '../../infra/ids.js';
import { RunStore } from '../../infra/run-store.js';
import { ScorecardStore } from '../../infra/scorecard-store.js';
import {
  printable,
  renderScorecardSummaryJson,
  renderScorecardSummaryTerminal,
  summarizeScorecard,
} from '../../report/scorecard-summary.js';
import {
  ATTRIBUTION_VALUES,
  makeAttributionRecord,
  parseAttributionValue,
} from '../../schemas/scorecard-attribution.js';
import { toRunResult } from '../../schemas/result.js';
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

  let found;
  try {
    found = await stat(specwitnessDir);
  } catch (cause) {
    // ⚠️ ONLY ENOENT MEANS "NOT INITIALISED", and conflating the two was a finding of the
    // auto-review over this branch's final head. A `stat` that fails with EACCES or EIO
    // says nothing about whether the project is initialised — reporting "run
    // 'specwitness init'" then gives an incorrect diagnosis AND points the operator at a
    // mutation that will not help and may not be what they want.
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new InfraError(
        `the SpecWitness directory could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
        `check that ${specwitnessDir} is readable, then run the command again`,
      );
    }
    found = undefined;
  }

  if (found === undefined || !found.isDirectory()) {
    throw new InfraError(
      `this project is not initialised for SpecWitness (no .specwitness directory in ${projectRoot})`,
      "run 'specwitness init' first, or change to the project root",
    );
  }
}

/**
 * Reads story 6.5's scorecard, translating a filesystem failure into an `InfraError`.
 *
 * A P2 from round 6 of the codex review, and the third site of one class: a raw Node
 * `EACCES`/`EIO` is not an `isSpecWitnessError`, so the global handler in `main.ts`
 * reports *"unexpected internal failure ... this is a SpecWitness bug - please report
 * it"* at an operator whose file is merely unreadable. Reproduced against the built
 * binary with a `chmod 000` scorecard.
 *
 * TRANSLATED HERE RATHER THAN IN THE STORE, deliberately. `ScorecardStore` is story 6.5's
 * merged module and this story does not modify it - my own `AttributionStore` translates
 * at its own boundary because I own it. This command is the only new caller of
 * `ScorecardStore.read()`, so wrapping at my edge fixes the symptom on my path without
 * changing behaviour for `verify`, which calls the store's WRITE path and has its own
 * (deliberately unfailable) contract.
 *
 * An ABSENT file is not a failure and never reaches here: the store answers an empty
 * scorecard for `ENOENT`, which is the correct reading of "this project has recorded
 * nothing yet".
 */
async function readScorecard(projectRoot: string) {
  const store = new ScorecardStore(projectRoot);
  try {
    return await store.read();
  } catch (cause) {
    throw new InfraError(
      `the scorecard could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
      `check that ${store.path} is readable, then run the command again`,
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

  const { records, skipped } = await readScorecard(projectRoot);
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

  // The scorecard's id list is a CAPPED projection (200 ids across the record). When it
  // was cut, its silence is not evidence, so the run's own stored result — which is
  // uncapped — is consulted before refusing. Read only on that rare path, so an ordinary
  // attribution still touches one file.
  const stored = record.findingCriterionIdsTruncated
    ? await storedFindingIds(projectRoot, runId, clock)
    : undefined;

  const warning =
    stored !== undefined && stored.has(criterionId)
      ? `WARNING: run ${runId} names only some of its findings in the scorecard; ${criterionId} ` +
        `was confirmed against ${runId}'s stored result instead.\n`
      : assertCriterionIsAFinding(record, criterionId);

  const built = makeAttributionRecord({
    runId,
    criterionId,
    attribution,
    recordedAt: clock.now().toISOString(),
    ...(options.note === undefined ? {} : { note: options.note }),
  });

  await new AttributionStore(projectRoot).append(built);

  // THE NOTE IS ESCAPED ON THE WAY BACK OUT, and round 5 of the codex review found
  // this second site after round 4 fixed the first. `--note` is operator-supplied text
  // echoed to stdout; `boundedText` redacts and truncates it but does NOT make it
  // terminal-safe, so a newline or an ESC in a note could forge an output line or emit a
  // control sequence - against this command's own no-colour, no-control guarantee.
  //
  // `runId` and `criterionId` need no escaping: both are validated against canonical
  // patterns above and cannot contain a control character. They are left raw so the
  // confirmation reads exactly as the operator typed it.
  return {
    stdout:
      `Recorded ${criterionId} in ${runId} as ${attribution}` +
      `${built.note === undefined ? '' : ` — ${printable(built.note)}`}\n`,
    stderr: warning,
  };
}

/**
 * Refuses an attribution for a criterion the run's record does not name as a finding.
 *
 * **Why refuse.** Attributing a defect to a criterion that produced no finding would put a
 * number into the north-star metric that no verification ever produced. The scorecard
 * record names exactly the criteria a finding could be about (`findingCriterionIds`,
 * which is what story 6.5 built that field for), so this is checkable rather than assumed.
 *
 * ============================================================================
 * ⚠️ NO EXCEPTION FOR A TRUNCATED FINDING LIST — AND THIS REVERSES AN EARLIER DECISION
 * ============================================================================
 *
 * Story 6.5 caps those arrays at 200 ids ACROSS the record and sets
 * `findingCriterionIdsTruncated`. When the cap bit, an id's absence proves nothing: the
 * list is not the set. **An earlier version of this story ACCEPTED an unlisted criterion
 * on a truncated record, with a warning**, reasoning that refusing would discard a real
 * north-star data point over a display limit.
 *
 * **That was wrong, and the codex review of this branch found why.** With the check
 * relaxed, *any* syntactically valid criterion id was accepted for a truncated run —
 * including ids that never existed. The summary then counted each one as a genuine
 * judgement, so `findings.attributed` and `uniqueDefects.count` could **exceed
 * `findings.total`**: a north-star count larger than the number of findings that exist.
 * The clamp on `unattributed` hid the overflow rather than preventing it.
 *
 * The trade is starkly asymmetric, which is what settles it:
 *
 *  - **refusing** costs the ability to attribute findings beyond the 200 a record names,
 *    in a run with more than 200 findings — narrow, rare, and already degenerate;
 *  - **accepting** makes the one number this product exists to produce corruptible by a
 *    typo, in a way nothing downstream would catch.
 *
 * Fail closed, then explain. The hint points at `specwitness report`, which renders the
 * run's full criteria list from `result.json` — so the information the truncated record
 * lacks is still one command away, and the operator is told where it is.
 *
 * Returns `''` when the criterion is a finding; throws `UsageError` (exit 64) otherwise.
 * A string return is kept rather than `void` so a future advisory has somewhere to go
 * without changing every call site.
 */
function assertCriterionIsAFinding(record: ScorecardRecord, criterionId: string): string {
  const findings = [
    ...record.findingCriterionIds.fail,
    ...record.findingCriterionIds.needs_human,
    ...record.findingCriterionIds.error,
  ];

  if (findings.includes(criterionId)) {
    return '';
  }

  const total = record.criteria.fail + record.criteria.needs_human + record.criteria.error;

  if (record.findingCriterionIdsTruncated) {
    throw new UsageError(
      `run ${record.runId} names only ${findings.length} of its ${total} findings individually, ` +
        `and ${criterionId} is not among them, so SpecWitness cannot confirm it produced one`,
      `check the criterion id against 'specwitness report ${record.runId}', which renders the ` +
        `run's full criteria list. An unverifiable attribution is refused rather than recorded, ` +
        `because a wrong id would count toward the defect metric as if it were real`,
    );
  }

  throw new UsageError(
    `criterion ${criterionId} produced no finding in run ${record.runId}, so there is nothing to attribute`,
    total === 0
      ? 'that run had no failures, needs-human criteria or errors at all — check the run id'
      : `that run's findings are: ${findings.join(', ')}`,
  );
}

/**
 * The criterion ids a run's STORED RESULT records as findings, or `undefined`.
 *
 * ⚠️ THE AUTHORITATIVE LIST, consulted only when the scorecard's own is TRUNCATED. A P2
 * from round 7 of the codex review, and the third round to visit this one design point —
 * the two before it are worth stating because the sequence is the argument:
 *
 *  - **round 1:** `add` accepted an unlisted criterion on a truncated record while the
 *    summary orphaned it, so the operator was told "Recorded" for a judgement no metric
 *    could count;
 *  - **round 2:** counting them instead let ANY valid id count, so the north star could
 *    exceed the number of findings that exist. I made `add` refuse;
 *  - **round 7:** refusing means a run with more than 200 findings can NEVER have findings
 *    201+ attributed — they stay permanently unattributed, so the north-star metric is
 *    structurally incomplete for exactly the largest runs.
 *
 * All three are right, and the resolution none of the first two had is to stop treating
 * the capped projection as the source of truth. `.specwitness/runs/<runId>/result.json` is
 * the full evidence for a run — story 6.5's record header calls it exactly that — and it
 * is uncapped. `report` already reads it the same way, at this same CLI edge.
 *
 * ABSENCE AND FAILURE ARE DIFFERENT ANSWERS, and conflating them was a finding of the
 * review over the rebased head. A blanket catch turned every `RunStore` failure - `EACCES`,
 * `EIO`, a malformed stored result - into `undefined`, and the caller then refused with a
 * USAGE error (exit 64) saying the criterion could not be confirmed. The invocation was
 * fine and the environment was broken, so that is both the wrong exit code and a
 * remediation pointing at the wrong thing. It is the same misclassification this story
 * fixed four times over for raw Node errors, inverted: not an infra failure dressed as a
 * bug report, but an infra failure dressed as the operator's mistake.
 *
 * So:
 *
 *  - NO STORED RESULT -> `undefined`. A genuine absence, and the narrower fallback: the
 *    caller refuses, because an attribution SpecWitness cannot verify must never reach the
 *    metric. Fail closed - widening the check must not become a way around it.
 *  - ANYTHING ELSE -> `InfraError` (exit 3), naming the path and a remedy.
 *
 * The two CALLERS then differ deliberately, and the asymmetry is one this product already
 * draws between a targeted operation and an aggregate:
 *
 *  - `scorecard add` lets it propagate. The operator asked about ONE run; if that run's
 *    evidence cannot be read, the honest answer is to say so, not to guess.
 *  - `scorecard summary` catches it and counts the run in
 *    `findings.runsWithUnreadableStoredResult`. Failing a whole summary because one run of
 *    forty has an unreadable result would destroy the measurement over a local fault - the
 *    same reasoning ADR-008 section 5 applies to a single damaged line.
 *
 * The run id was validated as canonical before this is reached, and `RunStore` builds the
 * path; no operator string is concatenated into one here.
 */
async function storedFindingIds(
  projectRoot: string,
  runId: string,
  clock: Clock,
): Promise<ReadonlySet<string> | undefined> {
  const store = new RunStore(projectRoot, clock, new RandomIds());

  // NO CATCH AROUND `hasResult`, deliberately. It already draws exactly this distinction
  // itself (`src/infra/run-store.ts`): `ENOENT` answers `false`, and `EACCES`/`EIO`/
  // `ENOTDIR` raise an `InfraError` — with a comment saying that swallowing them would
  // make a command "exit 0 claiming the run has no result, which is precisely the kind of
  // infra-failure-as-product-answer this project treats as a first-order defect".
  //
  // An earlier version of this function wrapped it in a blanket catch and rationalised the
  // wrap in a comment. That undid a distinction merged code had already made correctly, and
  // reintroduced the very defect being fixed one line below. Found by the review of the
  // head after that fix - the same misclassification twice in one function.
  if (!(await store.hasResult(runId))) {
    return undefined;
  }

  try {
    const stored = await store.readResult(runId);
    const result = toRunResult(stored.document);
    return new Set(
      result.criteria
        .filter((criterion) => criterion.status !== 'pass' && criterion.status !== 'skipped')
        .map((criterion) => criterion.criterionId),
    );
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw new InfraError(
      `run ${runId} has a stored result that could not be read, so SpecWitness cannot ` +
        `confirm this criterion: ${cause instanceof Error ? cause.message : String(cause)}`,
      `check that .specwitness/runs/${runId}/result.json is readable and well-formed, ` +
        `then run the command again`,
    );
  }
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

  const scorecard = await readScorecard(projectRoot);
  const attributions = await new AttributionStore(projectRoot).read();

  // ⚠️ THE SAME AUTHORITATIVE LIST `add` VALIDATES AGAINST, handed to the summariser so
  // the two ends cannot disagree. A P1 from round 8 of the codex review: `add` had learned
  // to confirm an unlisted criterion against the run's stored result, and this summary had
  // not, so a judgement the command accepted was reported as an orphan and never counted.
  //
  // Read ONLY for runs whose record truncated its own list — rare — and the summariser
  // stays pure and file-free, which is what `report-layer` requires and what keeps the
  // terminal and `--json` views derived from one model.
  const authoritativeFindingIds = new Map<string, ReadonlySet<string>>();
  for (const record of scorecard.records) {
    if (!record.findingCriterionIdsTruncated) {
      continue;
    }
    // TOLERATED HERE, unlike in `add`. One unreadable result must not fail a summary over
    // forty runs; the run is counted in `findings.runsWithUnreadableStoredResult` instead,
    // so the fallback is reported rather than silent.
    const ids = await storedFindingIds(projectRoot, record.runId, new SystemClock()).catch(
      () => undefined,
    );
    if (ids !== undefined) {
      authoritativeFindingIds.set(record.runId, ids);
    }
  }

  const summary = summarizeScorecard({ scorecard, attributions, authoritativeFindingIds });

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
