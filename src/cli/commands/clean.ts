/**
 * `specwitness clean` — the reaper, FR-27 / AD-8 / NFR-9 (story 3.2).
 *
 * A crashed or `kill -9`'d run leaves two kinds of resource behind: process
 * groups it started, and worktrees it created. Both were written to
 * `manifest.json` and fsynced BEFORE they came into use, precisely so this
 * command can replay them afterwards. Without it, the operator's remedy is `ps`
 * and guesswork.
 *
 * WHAT `--all` MEANS, stated here and in `--help` so it is unambiguous:
 *
 *   specwitness clean         this project's UNREAPED runs
 *   specwitness clean --all   EVERY run, including ones already marked reaped,
 *                             re-verified and reported
 *
 * `--all` re-verifies; it does not widen the blast radius. It never reaches
 * another project, and it deletes nothing that bare `clean` would keep.
 *
 * IT REAPS RESOURCES, NEVER RESULTS (Q51). This command does not delete a run
 * directory, a `result.json`, an evidence file, or the manifest — on any path,
 * including the failure paths. V0 keeps every run; a `--prune` retention flag is
 * deliberately deferred. Getting this wrong would destroy the dogfooding data
 * Epic 7 exists to collect, so there is exactly one test that asserts it after
 * every path and no code here that removes anything under `.specwitness/`.
 *
 * IT IS PROMPT-FREE, `--all` included (Conventions). `clean` is exactly the
 * command an operator scripts, and a confirmation prompt would hang it in CI.
 *
 * THE DANGEROUS PART, and how it is contained: this is the only place in
 * SpecWitness that signals a process group it did not itself spawn. Pid reuse
 * is real. So a pgid is signalled ONLY when all of the following hold —
 *
 *   1. the manifest recorded it;
 *   2. `RunStore` also recorded WHEN it was recorded (the reaping evidence);
 *   3. `ps` reports the group is live;
 *   4. the earliest start time in that group matches the recorded instant
 *      (`src/infra/process-identity.ts`);
 *   5. it is not the process group SpecWitness itself is running in.
 *
 * Anything else is REPORTED and left running. Leaking is visible and
 * recoverable; killing the wrong process tree is neither.
 *
 * AD-1: this is the CLI edge, so it may reach into `infra`. It defines no exit
 * code of its own — it throws an `InfraError` and lets `cli/exit.ts` map it,
 * which is the only exit table in the repository.
 */

import { existsSync } from 'node:fs';

import type { Command } from 'commander';

import { InfraError } from '../../domain/errors.js';
import type { ProcessRunner } from '../../domain/process-runner.js';
import { SystemClock } from '../../infra/clock.js';
import { RandomIds } from '../../infra/ids.js';
import {
  probeProcessGroups,
  startTimeMatchesRecord,
  type ProcessGroupProbe,
} from '../../infra/process-identity.js';
import { createProcessRunner, terminateProcessGroup } from '../../infra/process-runner.js';
import { RunStore } from '../../infra/run-store.js';
import { removeWorktreeAtPath } from '../../infra/worktree-removal.js';

/**
 * The effects `clean` performs on the world, injected so the liveness matrix is
 * testable without spawning anything.
 *
 * `removeWorktree` is a ONE-FUNCTION SEAM on purpose: story 3.1 (alice) owns
 * worktree removal and is in the same wave, so her `src/infra/vcs.ts` does not
 * exist on this branch. Whichever of us merges second deletes the temporary
 * default in `src/infra/worktree-removal.ts` and passes hers here. Agreed in
 * cohort intent-sync; the seam is one function wide so that rewire is one line.
 */
export interface CleanEffects {
  probeProcessGroups(pgids: readonly number[]): Promise<ReadonlyMap<number, ProcessGroupProbe>>;
  terminateProcessGroup(pgid: number): Promise<void>;
  worktreeExists(worktreePath: string): boolean;
  removeWorktree(worktreePath: string): Promise<void>;
}

/** What `clean` did to one run. */
export interface RunCleanReport {
  readonly runId: string;
  /** Set when the run was passed over entirely (already reaped, without --all). */
  readonly skipped?: 'already-reaped';
  readonly killed: readonly number[];
  readonly alreadyGone: readonly number[];
  readonly removedWorktrees: readonly string[];
  readonly absentWorktrees: readonly string[];
  /** Everything this run could not reap, each already a full sentence. */
  readonly problems: readonly string[];
  readonly reaped: boolean;
}

export interface CleanReport {
  readonly runs: readonly RunCleanReport[];
  /** Every problem across every run, in the order they were found. */
  readonly failures: readonly string[];
}

export function register(program: Command): void {
  program
    .command('clean')
    .description('reap process groups and worktrees left behind by crashed runs')
    .option(
      '--all',
      'visit every run, including ones already marked reaped, and re-verify them (never deletes results)',
    )
    .action(async (options: { all?: boolean }) => {
      const projectRoot = process.cwd();
      const store = new RunStore(projectRoot, new SystemClock(), new RandomIds());

      if (!store.isInitialized()) {
        throw new InfraError(
          `this project is not initialised for SpecWitness (no .specwitness directory in ${projectRoot})`,
          "run 'specwitness init' first, or change to the project root",
        );
      }

      const runner = createProcessRunner(new SystemClock());
      const report = await cleanRuns(
        store,
        { all: options.all === true },
        defaultCleanEffects(projectRoot, runner),
      );

      process.stdout.write(renderCleanReport(report));

      if (report.failures.length > 0) {
        // One ERROR/HINT pair, as the house style requires, naming everything
        // that survived. Exit 3 via `cli/exit.ts`: the resources are still out
        // there, so this is an environment problem to fix and retry, never a
        // product verdict.
        throw new InfraError(
          `specwitness clean could not reap ${report.failures.length} resource(s): ${report.failures.join('; ')}`,
          'inspect the named process groups and worktrees by hand; no run directory, result or evidence was deleted',
        );
      }
    });
}

/** The real effects, for the command. Tests inject their own. */
export function defaultCleanEffects(projectRoot: string, runner: ProcessRunner): CleanEffects {
  return {
    probeProcessGroups: (pgids) => probeProcessGroups(runner, pgids, projectRoot),
    terminateProcessGroup: (pgid) => terminateProcessGroup(pgid),
    worktreeExists: (worktreePath) => existsSync(worktreePath),
    removeWorktree: (worktreePath) => removeWorktreeAtPath(runner, projectRoot, worktreePath),
  };
}

/**
 * Replays every manifest and reaps what it can.
 *
 * Returns a report rather than printing, so the decision logic is testable
 * without capturing stdout, and so the command owns the stream discipline.
 *
 * A run is marked reaped only when NOTHING about it was left outstanding. A run
 * with an unverifiable live process group stays unreaped deliberately, so the
 * next `clean` tries again rather than declaring the machine clean on the
 * strength of a resource it refused to touch.
 */
export async function cleanRuns(
  store: RunStore,
  options: { readonly all: boolean },
  effects: CleanEffects,
): Promise<CleanReport> {
  const runs: RunCleanReport[] = [];
  const failures: string[] = [];

  for (const runId of await store.listRuns()) {
    const report = await cleanOneRun(store, runId, options, effects);
    runs.push(report);
    failures.push(...report.problems);
  }

  return { runs, failures };
}

async function cleanOneRun(
  store: RunStore,
  runId: string,
  options: { readonly all: boolean },
  effects: CleanEffects,
): Promise<RunCleanReport> {
  const empty = {
    runId,
    killed: [],
    alreadyGone: [],
    removedWorktrees: [],
    absentWorktrees: [],
    reaped: false,
  } as const;

  let manifest;
  let records: ReadonlyMap<number, string>;
  try {
    manifest = await store.readManifest(runId);
    records = await store.readProcessGroupRecords(runId);
  } catch (cause) {
    // A corrupt manifest is NAMED and the run is NOT silently skipped: the run
    // it describes may still own a live worktree or process group, so pretending
    // the file is absent would leak them without a word. One bad file must also
    // not stop the reaper visiting every other run.
    return { ...empty, problems: [describeCause(cause)] };
  }

  if (manifest.reaped && !options.all) {
    return { ...empty, skipped: 'already-reaped', reaped: true, problems: [] };
  }

  const killed: number[] = [];
  const alreadyGone: number[] = [];
  const problems: string[] = [];

  const probes = await effects.probeProcessGroups(manifest.processGroups);

  for (const pgid of manifest.processGroups) {
    const probe = probes.get(pgid);
    const recordedAt = records.get(pgid);

    if (probe === undefined || probe.state === 'unknown') {
      problems.push(
        `run ${runId}: process group ${pgid} could not be checked (${probe?.detail ?? 'no probe result'}), so it was NOT signalled`,
      );
      continue;
    }

    if (probe.state === 'gone') {
      // The overwhelmingly common case, and the one where doing nothing is the
      // entire point: signalling a pgid that has exited would signal whatever
      // inherited it.
      alreadyGone.push(pgid);
      continue;
    }

    if (probe.ownProcessGroup === true) {
      problems.push(
        `run ${runId}: process group ${pgid} is SpecWitness own process group, so it was NOT signalled`,
      );
      continue;
    }

    if (recordedAt === undefined) {
      problems.push(
        `run ${runId}: process group ${pgid} is live but SpecWitness has no record of when it started it, so it was NOT signalled`,
      );
      continue;
    }

    if (
      probe.startedAt === undefined ||
      !startTimeMatchesRecord(probe.startedAt, new Date(recordedAt))
    ) {
      problems.push(
        `run ${runId}: process group ${pgid} is live but started at ${probe.startedAt?.toISOString() ?? 'an unknown time'} rather than ${recordedAt}, so it is almost certainly a different process and was NOT signalled`,
      );
      continue;
    }

    try {
      await effects.terminateProcessGroup(pgid);
      killed.push(pgid);
    } catch (cause) {
      problems.push(`run ${runId}: could not terminate process group ${pgid}: ${describeCause(cause)}`);
    }
  }

  const removedWorktrees: string[] = [];
  const absentWorktrees: string[] = [];

  for (const worktreePath of manifest.worktrees) {
    if (!effects.worktreeExists(worktreePath)) {
      absentWorktrees.push(worktreePath);
      continue;
    }
    try {
      await effects.removeWorktree(worktreePath);
      removedWorktrees.push(worktreePath);
    } catch (cause) {
      problems.push(`run ${runId}: could not remove worktree ${worktreePath}: ${describeCause(cause)}`);
    }
  }

  let reaped = manifest.reaped;
  if (problems.length === 0) {
    try {
      await store.markReaped(runId);
      reaped = true;
    } catch (cause) {
      problems.push(`run ${runId}: could not mark the run reaped: ${describeCause(cause)}`);
    }
  }

  return { runId, killed, alreadyGone, removedWorktrees, absentWorktrees, problems, reaped };
}

/**
 * The human report, on stdout.
 *
 * Its own small rendering rather than a `RunResult` one: `clean` never builds a
 * `RunResult` and story 3.6 owns the renderers for the thing that does.
 */
export function renderCleanReport(report: CleanReport): string {
  if (report.runs.length === 0) {
    return 'specwitness clean: no runs to reap\n';
  }

  const lines: string[] = [];

  for (const run of report.runs) {
    if (run.skipped === 'already-reaped') {
      lines.push(`${run.runId}  already reaped (use --all to re-verify)`);
      continue;
    }

    const did: string[] = [];
    for (const pgid of run.killed) {
      did.push(`  killed process group ${pgid}`);
    }
    for (const pgid of run.alreadyGone) {
      did.push(`  process group ${pgid} was already gone`);
    }
    for (const path of run.removedWorktrees) {
      did.push(`  removed worktree ${path}`);
    }
    for (const path of run.absentWorktrees) {
      did.push(`  worktree ${path} was already gone`);
    }
    for (const problem of run.problems) {
      did.push(`  NOT REAPED: ${problem}`);
    }

    lines.push(`${run.runId}  ${run.reaped ? 'reaped' : 'incomplete'}`);
    lines.push(...(did.length > 0 ? did : ['  nothing to reap']));
  }

  const reaped = report.runs.filter((run) => run.reaped).length;
  lines.push('');
  lines.push(
    `${report.runs.length} run(s) visited, ${reaped} reaped, ${report.failures.length} resource(s) left behind.`,
  );
  // Said every time, not only when something was kept: an operator scanning this
  // output should never have to wonder whether their evidence survived.
  lines.push('Run directories, results and evidence are always kept.');

  return `${lines.join('\n')}\n`;
}

/** Best-effort message from an unknown thrown value, for report text. */
function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
