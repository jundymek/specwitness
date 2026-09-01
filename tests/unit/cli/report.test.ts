/**
 * Story 3.5 AC2 — `specwitness report <epic>` and the argument rule.
 *
 * These exercise the command's own functions directly rather than through the
 * built binary: the binary-level assertions already live in
 * `tests/integration/report.test.ts` (story 1.6, appended to rather than
 * restructured), and the interesting behaviour here is resolution logic that a
 * subprocess boundary would only make harder to read.
 *
 * TWO INVARIANTS ARE PINNED THROUGHOUT, not just in one test:
 *
 *  - `report` CREATES NOTHING. Not the runs root, not `.specwitness/`, not in
 *    an uninitialised project. A read that scaffolds storage turns "you have no
 *    runs" into "you have an empty runs directory".
 *  - `report` EXECUTES NOTHING (Q52). No subprocess, no git ref resolution, no
 *    provider. There is nothing to inject a throwing `ProcessRunner` into
 *    because the command imports no runner at all — the stronger property, and
 *    the last test below asserts it structurally.
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  classifyReportTarget,
  runReport,
  type ReportTarget,
} from '../../../src/cli/commands/report.js';
import { InfraError, UsageError } from '../../../src/domain/errors.js';
import { RunStore } from '../../../src/infra/run-store.js';
import { FixedClock, SequenceIds } from '../../fakes/ports.js';

let projectRoot: string;

beforeEach(async () => {
  // Per-test temp directory: the harness may run `pnpm test` in this worktree
  // concurrently with the agent (harness defect H-8), so no fixed-name scratch.
  projectRoot = await mkdtemp(join(tmpdir(), 'specwitness-report-unit-'));
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

/** Seeds a run through RunStore — the only writer allowed to (AD-8). */
async function seedRun(instant: string, suffix: string, epic?: string) {
  const store = new RunStore(projectRoot, new FixedClock(instant), new SequenceIds(suffix));
  return store.createRun(epic === undefined ? {} : { epic });
}

/** Writes a contract file, so an epic "exists" without any run having happened. */
async function seedContract(epic: string): Promise<void> {
  const dir = join(projectRoot, '.specwitness', 'contracts');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${epic}.yaml`), 'spec: {}\n', 'utf8');
}

/** The thrown value, so a rejection can be asserted on without try/catch noise. */
async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the call to reject, but it resolved');
    },
    (err: unknown) => err,
  );
}

describe('classifyReportTarget — the argument rule (AC2)', () => {
  it('reads a canonical run id as a run id', () => {
    const target: ReportTarget = classifyReportTarget('run-20260830T142501Z-a3f9');

    expect(target).toEqual({ kind: 'run', runId: 'run-20260830T142501Z-a3f9' });
  });

  it.each(['7', 'epic-7', 'epic-07', 'EPIC-7', ' 7 '])(
    'reads %j as the canonical epic id',
    (input) => {
      expect(classifyReportTarget(input)).toEqual({ kind: 'epic', epic: 'epic-7' });
    },
  );

  it('rejects a malformed run id with the RUN-ID shape, not the epic hint', () => {
    // The value that could plausibly be read as either. `run-2026-08-30` is a
    // mistyped run id, and answering "invalid epic id" would send the operator
    // to entirely the wrong place. Exit 64 either way; only the hint differs.
    const thrown = (() => {
      try {
        classifyReportTarget('run-2026-08-30');
        return undefined;
      } catch (err) {
        return err;
      }
    })();

    expect(thrown).toBeInstanceOf(UsageError);
    const error = thrown as UsageError;
    expect(error.message).toContain('run-2026-08-30');
    expect(error.hint).toContain('run-<YYYYMMDDTHHmmssZ>');
    expect(error.hint).not.toMatch(/epic/i);
  });

  it('rejects an argument that is neither, naming the epic-id shape', () => {
    const thrown = (() => {
      try {
        classifyReportTarget('not-a-run-id');
        return undefined;
      } catch (err) {
        return err;
      }
    })();

    expect(thrown).toBeInstanceOf(UsageError);
    expect((thrown as UsageError).hint).toMatch(/epic/i);
  });

  it('never treats a run-shaped argument as an epic, even a nearly-valid one', () => {
    // One character short in the suffix: still unmistakably an attempted run id.
    expect(() => classifyReportTarget('run-20260830T142501Z-a3f')).toThrow(UsageError);
  });
});

describe('report <epic> — resolves the newest run for that epic (AC2)', () => {
  it('renders the newest run of the epic, not the newest run overall', async () => {
    const older = await seedRun('2026-08-30T10:00:00.000Z', 'aaaa', 'epic-7');
    const newer = await seedRun('2026-08-30T12:00:00.000Z', 'bbbb', 'epic-7');
    // A LATER run belonging to a different epic must not win.
    await seedRun('2026-08-30T14:00:00.000Z', 'cccc', 'epic-9');

    await writeFile(join(older.dir, 'result.json'), '{}', 'utf8');
    await writeFile(join(newer.dir, 'result.json'), '{}', 'utf8');

    const { stdout } = await runReport(projectRoot, 'epic-7');

    expect(stdout).toContain(newer.runId);
    expect(stdout).not.toContain(older.runId);
  });

  it('accepts any spelling of the epic id', async () => {
    const run = await seedRun('2026-08-30T10:00:00.000Z', 'aaaa', 'epic-7');
    await writeFile(join(run.dir, 'result.json'), '{}', 'utf8');

    for (const spelling of ['7', 'epic-7', 'epic-07', 'EPIC-7']) {
      const { stdout } = await runReport(projectRoot, spelling);
      expect(stdout).toContain(run.runId);
    }
  });

  it('picks the newest run that HAS a result, skipping later resultless ones', async () => {
    // A crashed run may be newer and have stored nothing. Rendering it would
    // show an empty report where a complete one exists.
    const withResult = await seedRun('2026-08-30T10:00:00.000Z', 'aaaa', 'epic-7');
    await writeFile(join(withResult.dir, 'result.json'), '{}', 'utf8');
    await seedRun('2026-08-30T12:00:00.000Z', 'bbbb', 'epic-7');

    const { stdout } = await runReport(projectRoot, 'epic-7');

    expect(stdout).toContain(withResult.runId);
  });

  it('ignores runs that are not tied to any epic', async () => {
    const untied = await seedRun('2026-08-30T14:00:00.000Z', 'cccc');
    await writeFile(join(untied.dir, 'result.json'), '{}', 'utf8');
    const tied = await seedRun('2026-08-30T10:00:00.000Z', 'aaaa', 'epic-7');
    await writeFile(join(tied.dir, 'result.json'), '{}', 'utf8');

    const { stdout } = await runReport(projectRoot, 'epic-7');

    expect(stdout).toContain(tied.runId);
    expect(stdout).not.toContain(untied.runId);
  });
});

describe('report <epic> — the three empty states are distinct (AC2)', () => {
  it('1. no such epic: no contract and no runs', async () => {
    await seedRun('2026-08-30T10:00:00.000Z', 'aaaa', 'epic-9'); // so .specwitness exists

    const error = await failureOf(runReport(projectRoot, 'epic-7'));

    expect(error).toBeInstanceOf(InfraError);
    expect((error as InfraError).message).toMatch(/epic-7/);
    expect((error as InfraError).hint).toMatch(/contract generate/);
  });

  it('2. the epic exists but has never been verified', async () => {
    await seedRun('2026-08-30T10:00:00.000Z', 'aaaa', 'epic-9');
    await seedContract('epic-7');

    const error = await failureOf(runReport(projectRoot, 'epic-7'));

    expect(error).toBeInstanceOf(InfraError);
    expect((error as InfraError).message).toMatch(/no runs/i);
    expect((error as InfraError).hint).toMatch(/verify epic-7/);
  });

  it('3. runs exist for the epic but none stored a result', async () => {
    await seedRun('2026-08-30T10:00:00.000Z', 'aaaa', 'epic-7');
    await seedRun('2026-08-30T12:00:00.000Z', 'bbbb', 'epic-7');

    const error = await failureOf(runReport(projectRoot, 'epic-7'));

    expect(error).toBeInstanceOf(InfraError);
    // Naming the count tells the operator these runs exist and died, rather
    // than that they never happened.
    expect((error as InfraError).message).toMatch(/2 runs/);
    expect((error as InfraError).hint).toMatch(/clean/);
  });

  it('gives three DIFFERENT hints — the whole point of separating them', async () => {
    const hints: string[] = [];

    await seedRun('2026-08-30T10:00:00.000Z', 'aaaa', 'epic-9');
    hints.push(((await failureOf(runReport(projectRoot, 'epic-7'))) as InfraError).hint ?? '');

    await seedContract('epic-7');
    hints.push(((await failureOf(runReport(projectRoot, 'epic-7'))) as InfraError).hint ?? '');

    await seedRun('2026-08-30T11:00:00.000Z', 'bbbb', 'epic-7');
    hints.push(((await failureOf(runReport(projectRoot, 'epic-7'))) as InfraError).hint ?? '');

    expect(new Set(hints).size).toBe(3);
  });
});

describe('report reads a corrupt manifest honestly (AC2)', () => {
  it('refuses rather than silently skipping it', async () => {
    // Skipping would be worse than failing: the unreadable manifest might be
    // the NEWEST run of this epic, so skipping it renders an older run while
    // calling it the latest. The merged parseRunManifest already refuses to
    // treat a corrupt manifest as absent; this asserts report does not undo it.
    const good = await seedRun('2026-08-30T10:00:00.000Z', 'aaaa', 'epic-7');
    await writeFile(join(good.dir, 'result.json'), '{}', 'utf8');
    const broken = await seedRun('2026-08-30T12:00:00.000Z', 'bbbb', 'epic-7');
    await writeFile(join(broken.dir, 'manifest.json'), '{ not json', 'utf8');

    const error = await failureOf(runReport(projectRoot, 'epic-7'));

    expect(error).toBeInstanceOf(InfraError);
    expect((error as InfraError).message).toContain(broken.runId);
  });

  it('is not blocked by a corrupt manifest OLDER than the answer', async () => {
    // The failure must be the minimal honest one. A manifest that cannot be
    // read but is older than the run being returned could not have changed the
    // answer, so refusing on account of it would make `report` fail for a
    // reason that does not exist — and V0 keeps every run forever (Q51), so
    // one corrupt directory would poison the command permanently.
    const broken = await seedRun('2026-08-30T08:00:00.000Z', 'zzzz', 'epic-7');
    await writeFile(join(broken.dir, 'manifest.json'), '{ not json', 'utf8');
    const answer = await seedRun('2026-08-30T12:00:00.000Z', 'bbbb', 'epic-7');
    await writeFile(join(answer.dir, 'result.json'), '{}', 'utf8');

    const { stdout } = await runReport(projectRoot, 'epic-7');

    expect(stdout).toContain(answer.runId);
  });

  it('still refuses when no answer was found and a manifest is unreadable', async () => {
    // Nothing to return, so the unreadable manifest might have been the answer.
    // Staying silent here would report "this epic has no runs" about a project
    // that may well have one.
    const broken = await seedRun('2026-08-30T08:00:00.000Z', 'zzzz', 'epic-7');
    await writeFile(join(broken.dir, 'manifest.json'), '{ not json', 'utf8');

    const error = await failureOf(runReport(projectRoot, 'epic-7'));

    expect(error).toBeInstanceOf(InfraError);
    expect((error as InfraError).message).toContain(broken.runId);
  });
});

describe('report is a pure read (AC2, Q52)', () => {
  it('creates nothing in an uninitialised project', async () => {
    await runReport(projectRoot, 'epic-7').catch(() => undefined);
    await runReport(projectRoot, 'run-20260830T142501Z-a3f9').catch(() => undefined);

    expect(existsSync(join(projectRoot, '.specwitness'))).toBe(false);
  });

  it('creates nothing when the epic has no runs', async () => {
    await seedRun('2026-08-30T10:00:00.000Z', 'aaaa', 'epic-9');
    const runsRoot = join(projectRoot, '.specwitness', 'runs');
    const before = await readdir(runsRoot);

    await runReport(projectRoot, 'epic-7').catch(() => undefined);

    expect(await readdir(runsRoot)).toEqual(before);
    expect(existsSync(join(projectRoot, '.specwitness', 'contracts'))).toBe(false);
  });

  it('executes nothing: the module imports no process runner at all', async () => {
    // Structural rather than behavioural. An injected throwing ProcessRunner
    // proves a runner was not CALLED; this proves the command cannot reach one,
    // which a refactor cannot quietly undo.
    const source = await readFile(
      fileURLToPath(new URL('../../../src/cli/commands/report.ts', import.meta.url)),
      'utf8',
    );

    expect(source).not.toMatch(/process-runner/);
    expect(source).not.toMatch(/\bexeca\b/);
    expect(source).not.toMatch(/node:child_process/);
    expect(source).not.toMatch(/\bvcs\b/i);
  });
});
