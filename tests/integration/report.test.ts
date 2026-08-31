/**
 * Story 1.6 AC3 — `specwitness report <run-id>` (stub).
 *
 * Scope is deliberately narrow: locate a stored run and render its manifest
 * metadata. Full rendering from a `RunResult`, `report <epic>` and `--json`
 * all arrive in Epic 3 (stories 3.5/3.6) — see the note in the command itself
 * on why a partial JSON shape is not invented here.
 *
 * These spawn the BUILT binary in a temp project, so they exercise the real
 * argument parsing, the real exit table and the real stderr formatting.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RunStore } from '../../src/infra/run-store.js';
import { FixedClock, SequenceIds } from '../fakes/ports.js';

const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'specwitness-report-'));
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

/** Runs the built CLI inside the temp project, never in this repository. */
async function runReport(args: string[], cwd = projectRoot) {
  const result = await execa(process.execPath, [CLI, ...args], {
    reject: false,
    cwd,
    input: '',
  });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

/** Seeds a run through RunStore — the only writer allowed to (AD-8). */
async function seedRun(epic?: string) {
  const store = new RunStore(
    projectRoot,
    new FixedClock('2026-08-30T14:25:01.123Z'),
    new SequenceIds('a3f9'),
  );
  return store.createRun(epic === undefined ? {} : { epic });
}

describe('report <run-id> renders a stored run (AC3)', () => {
  it('locates the run and prints its metadata, exit 0', async () => {
    const run = await seedRun('epic-7');

    const { exitCode, stdout, stderr } = await runReport(['report', run.runId]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain(run.runId);
    expect(stdout).toContain('2026-08-30T14:25:01.123Z');
    expect(stdout).toContain('epic-7');
  });

  it('says the run has no result yet, naming Epic 3', async () => {
    // The honest statement of what this stub is: metadata located, rendering
    // still to come. A user must not read "no failures" into an empty report.
    const run = await seedRun('epic-7');

    const { stdout } = await runReport(['report', run.runId]);

    expect(stdout).toMatch(/no result yet/i);
    expect(stdout).toMatch(/Epic 3/i);
  });

  it('reports a run that has no epic without printing "null"', async () => {
    const run = await seedRun();

    const { exitCode, stdout } = await runReport(['report', run.runId]);

    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('null');
    expect(stdout).toMatch(/none/i);
  });

  it('reflects a stored result.json once one exists', async () => {
    // Story 3.5 writes this file; the stub only reports whether it is there.
    const run = await seedRun('epic-7');
    await writeFile(join(run.dir, 'result.json'), '{}', 'utf8');

    const { stdout } = await runReport(['report', run.runId]);

    expect(stdout).not.toMatch(/no result yet/i);
    expect(stdout).toContain('result.json');
  });

  it('reports the reaped flag', async () => {
    const run = await seedRun('epic-7');

    const { stdout } = await runReport(['report', run.runId]);

    expect(stdout).toMatch(/reaped/i);
  });

  it('produces bounded, prompt-free output the harness can consume', async () => {
    const run = await seedRun('epic-7');

    const result = await execa(process.execPath, [CLI, 'report', run.runId], {
      reject: false,
      cwd: projectRoot,
      stdin: 'ignore',
      timeout: 10_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.split('\n').length).toBeLessThan(20);
  });
});

describe('report failure modes (AC3)', () => {
  it('exits 3 with ERROR and HINT for an unknown but well-formed id', async () => {
    const store = new RunStore(
      projectRoot,
      new FixedClock('2026-08-30T14:25:01.000Z'),
      new SequenceIds('a3f9'),
    );
    await store.createRun(); // so .specwitness exists and the run is genuinely absent

    const { exitCode, stdout, stderr } = await runReport(['report', 'run-20260830T142501Z-zzzz']);

    expect(exitCode).toBe(3);
    expect(stderr).toContain('ERROR: ');
    expect(stderr).toContain('HINT: ');
    // Naming what was searched is the difference between a usable error and
    // "not found".
    expect(stderr).toContain('run-20260830T142501Z-zzzz');
    expect(stdout).toBe('');
  });

  it('exits 64 for a malformed id, not 3', async () => {
    // A typo is a usage error. Exit 3 would tell a harness the environment is
    // broken and that retrying might help, which would be a lie.
    const { exitCode, stderr } = await runReport(['report', 'not-a-run-id']);

    expect(exitCode).toBe(64);
    expect(stderr).toContain('ERROR: ');
    expect(stderr).toContain('HINT: ');
  });

  it('exits 64 when no run id is given', async () => {
    const { exitCode } = await runReport(['report']);

    expect(exitCode).toBe(64);
  });

  it('exits 3 and points at init when the project is not initialized', async () => {
    const { exitCode, stderr } = await runReport(['report', 'run-20260830T142501Z-a3f9']);

    expect(exitCode).toBe(3);
    expect(stderr).toMatch(/ERROR: .*not initial/i);
    expect(stderr).toContain('specwitness init');
  });

  it('creates nothing when reporting in an uninitialized project', async () => {
    // A read command that scaffolds storage just by looking is a defect. This
    // pins the invariant rather than relying on the test harness happening to
    // use a temp cwd.
    const { existsSync } = await import('node:fs');

    await runReport(['report', 'run-20260830T142501Z-a3f9']);

    expect(existsSync(join(projectRoot, '.specwitness'))).toBe(false);
  });

  it('never exits 0, 1 or 2 on failure (fail closed)', async () => {
    for (const args of [['report'], ['report', 'garbage'], ['report', 'run-20260830T142501Z-zzzz']]) {
      const { exitCode } = await runReport(args);
      expect([0, 1, 2]).not.toContain(exitCode);
    }
  });
});

/**
 * Story 3.5 AC2 — `report <epic>` through the built binary.
 *
 * APPENDED to story 1.6's file rather than restructuring it: everything above
 * asserts the pure-read guarantee this story must not regress, and it is worth
 * more where it is than reorganised.
 *
 * These cover the arm that only exists at the binary level — that the epic
 * argument reaches the command, that the three empty states each surface as a
 * real `ERROR:`/`HINT:` pair on stderr with exit 3, and that a mistyped run id
 * is exit 64 rather than exit 3. The resolution logic itself is unit-tested in
 * `tests/unit/cli/report.test.ts`, where a subprocess boundary would only make
 * it harder to read.
 */

/** Seeds a run at a chosen instant, so "newest" is decided by the test. */
async function seedRunAt(instant: string, suffix: string, epic?: string) {
  const store = new RunStore(projectRoot, new FixedClock(instant), new SequenceIds(suffix));
  return store.createRun(epic === undefined ? {} : { epic });
}

async function seedContractFile(epic: string): Promise<void> {
  const dir = join(projectRoot, '.specwitness', 'contracts');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${epic}.yaml`), 'spec: {}\n', 'utf8');
}

describe('report <epic> renders the latest run of that epic (3.5 AC2)', () => {
  it('picks the epic latest run, exit 0, nothing on stderr', async () => {
    const older = await seedRunAt('2026-08-30T10:00:00.000Z', 'aaaa', 'epic-7');
    const newer = await seedRunAt('2026-08-30T12:00:00.000Z', 'bbbb', 'epic-7');
    await writeFile(join(older.dir, 'result.json'), '{}', 'utf8');
    await writeFile(join(newer.dir, 'result.json'), '{}', 'utf8');

    const { exitCode, stdout, stderr } = await runReport(['report', 'epic-7']);

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain(newer.runId);
    expect(stdout).not.toContain(older.runId);
  });

  it('accepts a bare epic number and a zero-padded id', async () => {
    const run = await seedRunAt('2026-08-30T10:00:00.000Z', 'aaaa', 'epic-7');
    await writeFile(join(run.dir, 'result.json'), '{}', 'utf8');

    for (const spelling of ['7', 'epic-07']) {
      const { exitCode, stdout } = await runReport(['report', spelling]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain(run.runId);
    }
  });

  it('stays prompt-free and bounded for an epic argument too', async () => {
    const run = await seedRunAt('2026-08-30T10:00:00.000Z', 'aaaa', 'epic-7');
    await writeFile(join(run.dir, 'result.json'), '{}', 'utf8');

    const result = await execa(process.execPath, [CLI, 'report', 'epic-7'], {
      reject: false,
      cwd: projectRoot,
      stdin: 'ignore',
      timeout: 10_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.split('\n').length).toBeLessThan(20);
  });
});

describe('report <epic> empty states, each with its own remedy (3.5 AC2)', () => {
  it('exits 3 and points at contract generate when the epic is unknown', async () => {
    await seedRunAt('2026-08-30T10:00:00.000Z', 'aaaa', 'epic-9');

    const { exitCode, stdout, stderr } = await runReport(['report', 'epic-7']);

    expect(exitCode).toBe(3);
    expect(stderr).toContain('ERROR: ');
    expect(stderr).toContain('HINT: ');
    expect(stderr).toContain('epic-7');
    expect(stderr).toContain('contract generate');
    expect(stdout).toBe('');
  });

  it('exits 3 and points at verify when the epic has a contract but no runs', async () => {
    await seedRunAt('2026-08-30T10:00:00.000Z', 'aaaa', 'epic-9');
    await seedContractFile('epic-7');

    const { exitCode, stderr } = await runReport(['report', 'epic-7']);

    expect(exitCode).toBe(3);
    expect(stderr).toContain('verify epic-7');
  });

  it('exits 3 and points at clean when runs exist but none stored a result', async () => {
    await seedRunAt('2026-08-30T10:00:00.000Z', 'aaaa', 'epic-7');

    const { exitCode, stderr } = await runReport(['report', 'epic-7']);

    expect(exitCode).toBe(3);
    expect(stderr).toContain('clean');
  });
});

describe('report argument rule at the binary boundary (3.5 AC2)', () => {
  it('answers a mistyped run id with the run-id shape, exit 64 not 3', async () => {
    // Exit 3 would tell a harness the environment is broken and that retrying
    // might help. It is a typo.
    const { exitCode, stderr } = await runReport(['report', 'run-2026-08-30']);

    expect(exitCode).toBe(64);
    expect(stderr).toContain('run-<YYYYMMDDTHHmmssZ>');
  });

  it('creates nothing when given an epic in an uninitialised project', async () => {
    const { existsSync } = await import('node:fs');

    await runReport(['report', 'epic-7']);

    expect(existsSync(join(projectRoot, '.specwitness'))).toBe(false);
  });

  it('states the argument rule in --help', async () => {
    const { stdout } = await runReport(['report', '--help']);

    expect(stdout).toMatch(/epic/i);
    expect(stdout).toMatch(/run id/i);
  });
});
