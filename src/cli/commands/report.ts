/**
 * `specwitness report <run-id|epic>` — story 1.6 (AC3), grown by story 3.5.
 *
 * Re-renders a run that has already happened. This is the half of FR-31 that
 * makes evidence outlive the terminal that produced it: story 3.5 persists a
 * `result.json` per run, and this command renders it back.
 *
 * **`report` IS A PURE READ, ABSOLUTELY (Q52).** It creates no directory — not
 * the runs root, not `.specwitness/`, and not even when the project has never
 * been initialised. It spawns nothing, resolves no git ref and contacts no
 * provider. A read that scaffolds storage turns "you have no runs" into "you
 * have an empty runs directory", and it does it in a project the operator has
 * not opted into yet. `tests/unit/cli/report.test.ts` asserts the no-execution
 * half structurally, by checking this module cannot even reach a process
 * runner.
 *
 * THE ARGUMENT RULE (see `classifyReportTarget`): an argument that is a
 * canonical run id names a run; anything else is an epic id. An argument that
 * merely *begins* with `run-` is a mistyped run id and is answered as one.
 *
 * AD-11: `report` is a CALLER of a renderer, never a second renderer. The
 * rendering itself belongs to `src/report/**` (story 3.6) so that the terminal
 * view, the `--json` view and the stored `result.json` cannot drift apart. The
 * human path calls `renderTerminal`; `--json` emits the stored file's own bytes,
 * which is the same document by construction.
 *
 * AD-1: this is the edge, so it may reach into `infra`. Nothing beneath the
 * CLI may import back the other way.
 */

import type { Command } from 'commander';

import { contractFileExists } from '../../authoring/contract-file.js';
import { InfraError } from '../../domain/errors.js';
import { normalizeEpicId } from '../../domain/ids.js';
import { isRunId, parseRunId } from '../../domain/run-id.js';
import { SystemClock } from '../../infra/clock.js';
import { RandomIds } from '../../infra/ids.js';
import { RunStore } from '../../infra/run-store.js';
import { renderTerminal } from '../../report/index.js';
import { toRunResult } from '../../schemas/result.js';

/**
 * What the single positional argument named.
 *
 * A closed two-armed type rather than a string plus a boolean: the caller then
 * cannot forget to handle one of the arms, and "which did the user mean" is
 * decided exactly once, in `classifyReportTarget`.
 */
export type ReportTarget =
  | { readonly kind: 'run'; readonly runId: string }
  | { readonly kind: 'epic'; readonly epic: string };

/** Human-readable statement of the rule, reused in `--help` and in tests. */
export const REPORT_ARGUMENT_RULE =
  'an argument shaped like a run id names that run; anything else is an epic id ' +
  "('7', 'epic-7' and 'epic-07' all mean epic-7) and renders that epic's latest run";

/**
 * Decides whether the argument named a run or an epic.
 *
 * The refinement that matters is the middle branch. `report run-2026-08-30` is
 * a mistyped run id, not an epic; falling through to `normalizeEpicId` would
 * answer "invalid epic id: 'run-2026-08-30'" and send the operator somewhere
 * they were never trying to go. Both paths exit 64 — only the hint differs, so
 * the refinement costs nothing and cannot weaken the rule.
 *
 * Pure: decides from the string alone and never touches the filesystem, so a
 * bad argument is rejected before any storage is looked at.
 */
export function classifyReportTarget(value: string): ReportTarget {
  const trimmed = value.trim();

  if (isRunId(trimmed)) {
    return { kind: 'run', runId: trimmed };
  }

  if (/^run-/i.test(trimmed)) {
    // Reuses the merged validator so there is one run-id error message in the
    // codebase rather than two that drift. Throws `UsageError` (exit 64).
    parseRunId(trimmed);
  }

  // Throws `UsageError` (exit 64) on anything that is not an epic id either.
  return { kind: 'epic', epic: normalizeEpicId(trimmed) };
}

export interface ReportOptions {
  /**
   * Machine-readable output. stdout carries the JSON document and nothing
   * else; everything human goes to stderr (Q53/Q55, and the merged
   * `doctor.ts` is the precedent).
   */
  readonly json?: boolean;
}

/**
 * What the command produced, split by stream.
 *
 * Returned rather than printed so the whole command is testable without
 * capturing process streams — the same reason story 1.6 made its renderer
 * return a string. The `register` action below is the only place these reach a
 * real stream.
 */
export interface ReportOutput {
  readonly stdout: string;
  readonly stderr: string;
}

export function register(program: Command): void {
  program
    .command('report')
    .description('render a stored run without re-executing anything')
    .argument('<run-id|epic>', `a run id, or an epic id — ${REPORT_ARGUMENT_RULE}`)
    .option('--json', 'emit the stored result document on stdout (stable schema)')
    .action(async (target: string, options: { json?: boolean }) => {
      const output = await runReport(process.cwd(), target, options);
      process.stdout.write(output.stdout);
      if (output.stderr !== '') {
        process.stderr.write(output.stderr);
      }
    });
}

/**
 * Locates the run the argument named and renders it.
 *
 * Throws rather than writing an exit code: `cli/exit.ts` is the only module
 * permitted to set one, and the global handler in `main.ts` classifies what
 * comes out of here. Note that `report` itself succeeds — and so exits 0 —
 * whatever verdict it renders. Mapping a *stored* verdict to an exit code
 * would be `report` re-adjudicating a run it did not perform; exit 1/2/3 for a
 * run outcome belong to `verify`.
 */
export async function runReport(
  projectRoot: string,
  target: string,
  options: ReportOptions = {},
): Promise<ReportOutput> {
  // Classify FIRST, before touching the filesystem. A typo is a usage error
  // (exit 64); reporting it as exit 3 would tell a harness the environment is
  // broken and that retrying might help.
  const classified = classifyReportTarget(target);

  // The ports are supplied because `RunStore`'s constructor takes them, not
  // because this command uses them: every method called below is a pure read.
  const store = new RunStore(projectRoot, new SystemClock(), new RandomIds());

  if (!store.isInitialized()) {
    throw new InfraError(
      `this project is not initialised for SpecWitness (no .specwitness directory in ${projectRoot})`,
      "run 'specwitness init' first, or change to the project root",
    );
  }

  const runId =
    classified.kind === 'run'
      ? classified.runId
      : await latestRunOfEpic(store, projectRoot, classified.epic);

  if (options.json === true) {
    // Validate, then emit THE FILE'S OWN BYTES.
    //
    // Validating first means a harness never receives something that does not match the
    // published schema — echoing bytes must not mean echoing anything. Emitting the raw
    // text rather than re-serializing the parsed document is what makes stdout
    // byte-identical to `result.json` (Q53) by construction: zod rebuilds a validated
    // object in schema declaration order, which is not the order the evidence
    // constructors use, so a re-serialization would carry the same values in a different
    // byte sequence. `readResult` returns both halves for exactly this reason.
    const stored = await store.readResult(runId);
    return {
      stdout: stored.text,
      // Bounded and human, on stderr where it cannot corrupt the document (Q55). Story
      // 3.6's terminal renderer replaces this line once it lands; the stream discipline
      // does not change when it does.
      stderr: `Rendered ${runId} from ${stored.path}\n`,
    };
  }

  return { stdout: await renderRun(store, runId), stderr: '' };
}

/**
 * The newest run of an epic that actually stored a result.
 *
 * "Newest" is `listRuns()` order — newest first, a plain string sort on the
 * compact timestamp, no date parsing. A newer run WITHOUT a result is skipped
 * rather than rendered: a run that was killed before persisting would
 * otherwise show an empty report while a complete one sat beside it.
 *
 * WALKING NEWEST-FIRST AND RETURNING EARLY IS LOAD-BEARING, not an
 * optimisation. It is what makes an unreadable manifest fail this command only
 * when it could actually have changed the answer — see the comment on the
 * catch below. V0 keeps every run forever (Q51), so a scan that must read
 * every manifest before answering would let one corrupt run directory poison
 * `report` permanently.
 *
 * When nothing matches, the three failures below are deliberately distinct.
 * They are three different operator situations with three different remedies,
 * and collapsing them into "not found" would hide which one happened.
 */
async function latestRunOfEpic(
  store: RunStore,
  projectRoot: string,
  epic: string,
): Promise<string> {
  const runIds = await store.listRuns();

  const ofEpic: string[] = [];
  // Deferred rather than thrown at the point of failure — but only just.
  // Because the walk is newest-first, an unreadable manifest seen BEFORE an
  // answer might itself have been that answer: returning the next run down
  // would render an older run while calling it the latest. So it is raised the
  // moment an answer would otherwise be returned, and again if the walk ends
  // with nothing (staying silent would report "this epic has no runs" about a
  // project that may well have one).
  //
  // What this buys is the narrower failure: a corrupt manifest OLDER than the
  // answer is never even read, so it cannot fail the command for a reason that
  // does not exist. V0 keeps every run forever (Q51), so the alternative lets
  // one corrupt run directory poison `report` permanently.
  let unreadable: unknown;

  for (const runId of runIds) {
    let manifest;
    try {
      manifest = await store.readManifest(runId);
    } catch (cause) {
      unreadable ??= cause;
      continue;
    }

    if (manifest.epic === null || normalizeEpicId(manifest.epic) !== epic) {
      continue;
    }

    ofEpic.push(runId);
    if (await store.hasResult(runId)) {
      if (unreadable !== undefined) {
        throw unreadable;
      }
      return runId;
    }
  }

  if (unreadable !== undefined) {
    throw unreadable;
  }

  if (ofEpic.length === 0) {
    // Situation 1 vs 2: has SpecWitness ever heard of this epic at all? A
    // contract file is what "this epic exists" means here — reading whether one
    // is present creates nothing.
    if (await contractFileExists(projectRoot, epic)) {
      throw new InfraError(
        `${epic} has a verification contract but no runs yet`,
        `run 'specwitness verify ${epic}' to produce one`,
      );
    }
    throw new InfraError(
      `no contract and no runs found for ${epic} in ${projectRoot}`,
      `check the epic id, or run 'specwitness contract generate ${epic}' to create its verification contract`,
    );
  }

  // Situation 3. Naming the count is what tells the operator these runs exist
  // and ended early, rather than that they never happened.
  throw new InfraError(
    `${epic} has ${ofEpic.length} ${ofEpic.length === 1 ? 'run' : 'runs'} but none of them stored a result`,
    `those runs ended before persisting — 'specwitness report ${ofEpic[0]}' shows one run's metadata, and 'specwitness clean' reaps anything they left behind`,
  );
}

/**
 * Builds the report text for one stored run.
 *
 * Returns a string rather than printing, so the rendering is testable without
 * capturing stdout.
 *
 * **`report` CALLS a renderer; it is never one (AD-11).** The sectioned output
 * belongs to `src/report/terminal.ts`, and this function's whole job is to
 * fetch the model and hand it over. If a fact is missing from a report, the
 * fix is in the model or in the renderer — adding a line here would be the
 * start of a second renderer, and the terminal view and the JSON view would
 * begin to disagree about the same run.
 *
 * A RUN THAT STORED NOTHING STILL GETS AN ANSWER, and that is deliberately
 * different from `--json`. The machine path must emit a document or nothing,
 * because a partial document is worse than an error — a harness would parse
 * it. The human path has a third option: *there is no document, and here is
 * what there is instead.* The operator asked about a specific run, and "it
 * exists, it was created then, for that epic, and it stored nothing" answers
 * the question they actually had. It also keeps story 1.6's merged guarantee
 * rather than narrowing it silently.
 */
async function renderRun(store: RunStore, runId: string): Promise<string> {
  if (await store.hasResult(runId)) {
    const stored = await store.readResult(runId);
    return renderTerminal(toRunResult(stored.document));
  }

  return renderRunWithoutResult(store, runId);
}

/**
 * What can honestly be said about a run that never stored a result.
 *
 * Everything here comes from the crash-recovery manifest, which is written
 * before the run acquires any resource — so this is exactly the set of facts
 * that survives a run dying early, and no more.
 */
async function renderRunWithoutResult(store: RunStore, runId: string): Promise<string> {
  const manifest = await store.readManifest(runId);

  const lines = [
    `Run:      ${manifest.runId}`,
    `Created:  ${manifest.createdAt}`,
    `Epic:     ${manifest.epic ?? '(none)'}`,
    `Reaped:   ${manifest.reaped ? 'yes' : 'no'}`,
    // Names the remedy rather than only the absence. A run with no result ended
    // before persisting; `clean` is what reaps whatever it left behind.
    'Result:   no result stored — this run ended before persisting.',
    "          Run 'specwitness clean' to reap anything it left behind.",
  ];

  return `${lines.join('\n')}\n`;
}
