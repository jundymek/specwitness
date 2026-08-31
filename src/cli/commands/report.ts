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
 * view, the `--json` view and the stored `result.json` cannot drift apart.
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
    .action(async (target: string) => {
      const output = await runReport(process.cwd(), target);
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
  _options: ReportOptions = {},
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
  for (const runId of runIds) {
    // A corrupt manifest PROPAGATES rather than being skipped. Skipping would
    // be the worse failure: the unreadable manifest may be the newest run of
    // this epic, so ignoring it renders an older run while calling it the
    // latest. `parseRunManifest` already refuses to treat a corrupt manifest as
    // absent, and this must not undo that.
    const manifest = await store.readManifest(runId);
    if (manifest.epic !== null && normalizeEpicId(manifest.epic) === epic) {
      ofEpic.push(runId);
    }
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

  for (const runId of ofEpic) {
    if (await store.hasResult(runId)) {
      return runId;
    }
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
 * STILL THE STORY 1.6 SHAPE. Full rendering from the persisted `RunResult`
 * arrives with story 3.6's renderers, which this command will call rather than
 * reimplement (AD-11).
 */
async function renderRun(store: RunStore, runId: string): Promise<string> {
  const manifest = await store.readManifest(runId);
  const hasResult = await store.hasResult(runId);

  const lines = [
    `Run:      ${manifest.runId}`,
    `Created:  ${manifest.createdAt}`,
    `Epic:     ${manifest.epic ?? '(none)'}`,
    `Reaped:   ${manifest.reaped ? 'yes' : 'no'}`,
    `Result:   ${
      hasResult
        ? 'result.json is present (full rendering arrives in Epic 3)'
        : 'no result yet — run verification arrives in Epic 3'
    }`,
  ];

  return `${lines.join('\n')}\n`;
}
