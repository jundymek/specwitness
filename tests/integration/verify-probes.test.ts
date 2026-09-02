/**
 * Story 4.7, AC1 and AC2 — a full behavioural verify, end to end, through the BUILT BINARY.
 *
 * This suite exists because six stories are individually green and this is the first place
 * their outputs meet. Epic 3's retrospective states the lesson its integration story
 * learned: two decision-contradicting defects were reachable by no unit suite, because each
 * lived in a seam between merged stories, and both were found by wiring the real command.
 * So everything here runs `dist/cli.js` against a real git repository, a real HTTP service
 * on a real socket, and real subprocesses.
 *
 * **NOT Golden Verification Corpus coverage.** The corpus is Epic 6. Every fixture here is
 * inline, built by `helpers/probe-fixture.ts`, and torn down afterwards.
 */

import { mkdtemp, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

import { buildProbeFixture, runCli, type ProbeFixture } from './helpers/probe-fixture.js';

/** Directories to clean up after the PATH-narrowing test. */
const scratch: string[] = [];

/**
 * A PATH carrying exactly the tools the fixture legitimately needs — `node`, `git` and
 * `sh` — and nothing else.
 *
 * Built by SYMLINKING those three into an empty directory rather than by filtering the
 * ambient PATH: filtering asserts on the absence of two names a developer's machine happens
 * not to have in that moment, whereas an allowlisted directory is absent by construction on
 * every machine. The ENOENT a provider would hit therefore comes from the operating system.
 */
async function providerFreePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'specwitness-narrow-path-'));
  scratch.push(dir);

  await symlink(process.execPath, join(dir, 'node'));
  for (const binary of ['git', 'sh']) {
    const located = await execa('sh', ['-c', `command -v ${binary}`]);
    await symlink(located.stdout.trim(), join(dir, binary));
  }

  return dir;
}

/** The persisted run document, as a consumer reads it (FR-30). */
interface RunDocument {
  readonly runId: string;
  readonly outcome: { readonly verdict?: string; readonly infraError?: string };
  readonly criteria: readonly {
    readonly criterionId: string;
    readonly status: string;
    readonly statement?: string;
    readonly expected?: string;
    readonly actual?: string;
    readonly flaky?: boolean;
    readonly evidence?: readonly { readonly kind: string; readonly path: string }[];
  }[];
  readonly evidence: readonly { readonly kind: string }[];
  readonly providerUsage: readonly unknown[];
  readonly environment: { readonly runDirectory: string };
  readonly stages: readonly { readonly stage: string; readonly status: string; readonly detail?: string }[];
}

const fixtures: ProbeFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => await fixture.cleanup()));
  await Promise.all(
    scratch.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })),
  );
});

async function fixture(
  ...args: Parameters<typeof buildProbeFixture>
): Promise<ProbeFixture> {
  const built = await buildProbeFixture(...args);
  fixtures.push(built);
  return built;
}

function criterion(document: RunDocument, id: string) {
  const found = document.criteria.find((entry) => entry.criterionId === id);
  if (found === undefined) {
    throw new Error(
      `no criterion ${id} in the run document; it carries ${document.criteria
        .map((entry) => entry.criterionId)
        .join(', ')}`,
    );
  }
  return found;
}

describe('AC1 — a full behavioural verify makes ZERO provider calls', () => {
  it('exits 0 with verdict PASS, having really probed http, observation and shell', async () => {
    const project = await fixture();

    const { exitCode, stdout, stderr } = await runCli([ 'verify', project.epic, '--json' ], {
      cwd: project.root,
    });

    expect(exitCode, `stderr:\n${stderr}`).toBe(0);
    const document = JSON.parse(stdout) as RunDocument;

    expect(document.outcome).toEqual({ verdict: 'PASS' });
    // The whole point of the story: criterion results are REAL. Every criterion in every
    // run before this one was `skipped`.
    expect(criterion(document, 'E1-01').status).toBe('pass');
    expect(criterion(document, 'E1-02').status).toBe('pass');
    expect(criterion(document, 'E1-03').status).toBe('pass');
    expect(document.criteria.some((entry) => entry.status === 'skipped')).toBe(false);
  });

  it('records NO provider usage — the mechanical half of the FR-18 guarantee', async () => {
    const project = await fixture();

    const { exitCode, stdout } = await runCli(['verify', project.epic, '--json'], {
      cwd: project.root,
    });

    expect(exitCode).toBe(0);
    expect((JSON.parse(stdout) as RunDocument).providerUsage).toEqual([]);
  });

  it('completes with the provider binaries ABSENT from PATH', async () => {
    // The version of this assertion that matches how an operator experiences it. A
    // `providerUsage` of `[]` proves nothing was RECORDED; a PATH on which neither
    // `claude` nor `codex` exists proves nothing could have been CALLED. They fail
    // differently, so both are asserted — the count catches a call that happened and went
    // unrecorded, and this catches a call nobody knew about.
    const project = await fixture();
    const path = await providerFreePath();

    // The premise, checked rather than assumed: a PATH that still resolved `claude` would
    // make this test green for the wrong reason for the rest of the product's life.
    for (const binary of ['claude', 'codex']) {
      const found = await execa('sh', ['-c', `command -v ${binary}`], {
        reject: false,
        env: { PATH: path },
        extendEnv: false,
      });
      expect(found.exitCode, `${binary} is still resolvable on the narrowed PATH`).not.toBe(0);
    }

    const { exitCode, stdout, stderr } = await runCli(['verify', project.epic, '--json'], {
      cwd: project.root,
      env: { PATH: path, HOME: project.root },
    });

    expect(exitCode, `stderr:\n${stderr}`).toBe(0);
    const document = JSON.parse(stdout) as RunDocument;
    expect(document.outcome).toEqual({ verdict: 'PASS' });
    expect(document.providerUsage).toEqual([]);
  });

  it('emits the SAME BYTES to --json stdout and to result.json (AD-11, Q53)', async () => {
    const project = await fixture();

    const { exitCode, stdout } = await runCli(['verify', project.epic, '--json'], {
      cwd: project.root,
    });

    expect(exitCode).toBe(0);
    const document = JSON.parse(stdout) as RunDocument;
    const persisted = await readFile(
      join(project.root, document.environment.runDirectory, 'result.json'),
      'utf8',
    );

    expect(stdout).toBe(persisted);
  });

  it('leaves the source repository untouched (AD-8, FR-19)', async () => {
    const project = await fixture();

    await runCli(['verify', project.epic], { cwd: project.root });

    // `.specwitness/runs/` is gitignored by the shipped `init`, so a clean status here is
    // the real assertion rather than an artefact of what the fixture committed.
    expect(await project.status()).toBe('');
  });

  it('starts and REAPS the fixture service — nothing survives the run (FR-21)', async () => {
    const project = await fixture();

    const { exitCode } = await runCli(['verify', project.epic], { cwd: project.root });
    expect(exitCode).toBe(0);

    // The port is free again. If teardown had leaked the service group, binding would fail
    // with EADDRINUSE — and the NEXT run would fail on an occupied port, which is the
    // failure a leak actually produces.
    const { freePort } = await import('./helpers/probe-fixture.js');
    await expect(freePort()).resolves.toBeGreaterThan(0);

    const second = await runCli(['verify', project.epic], { cwd: project.root });
    expect(second.exitCode, second.stderr).toBe(0);
  });
});

describe('AC1 — probe evidence reaches the run document AND the rendered report', () => {
  it('records typed probe evidence members, not only refs', async () => {
    // THE ASSERTION THE TWO-CHANNEL DESIGN EXISTS TO MAKE POSSIBLE. All three merged
    // surfaces take a required `recordEvidence` sink; `ProbeAttempt.evidence` carries only
    // REFS to files. A run wired with refs alone would carry gate evidence and no probe
    // evidence at all, silently, with every surface suite green — because no surface test
    // drives a renderer. This one does.
    const project = await fixture();

    const { exitCode, stdout } = await runCli(['verify', project.epic, '--json'], {
      cwd: project.root,
    });

    expect(exitCode).toBe(0);
    const document = JSON.parse(stdout) as RunDocument;
    const kinds = document.evidence.map((entry) => entry.kind);

    expect(document.evidence.length).toBeGreaterThan(0);
    expect(kinds).toContain('http');
    expect(kinds).toContain('observation');
    expect(kinds).toContain('command');
  });

  it('renders that probe evidence in the terminal report', async () => {
    const project = await fixture();

    const { exitCode, stdout } = await runCli(['verify', project.epic], { cwd: project.root });

    expect(exitCode).toBe(0);
    // `report/terminal.ts` switches on `evidence.kind` and renders from the typed MEMBER
    // inline, because AD-11 forbids a renderer to open a file. So these lines exist only if
    // the members really arrived.
    expect(stdout).toMatch(/http GET .*\/status -> 200/);
    expect(stdout).toContain('observation ');
    expect(stdout).toContain('command version');
  });

  it('writes every referenced evidence file, at a RELATIVE path inside the run', async () => {
    const project = await fixture({ statusCode: 500 });

    const { stdout } = await runCli(['verify', project.epic, '--json'], { cwd: project.root });
    const document = JSON.parse(stdout) as RunDocument;

    const refs = document.criteria.flatMap((entry) => entry.evidence ?? []);
    expect(refs.length).toBeGreaterThan(0);

    for (const ref of refs) {
      expect(ref.path.startsWith('/')).toBe(false);
      const file = join(project.root, document.environment.runDirectory, ref.path);
      await expect(stat(file)).resolves.toBeDefined();
    }
  });
});

describe('AC2 — a failing criterion exits 1 and carries what a repair agent needs', () => {
  it('exits 1 with the criterion carrying expected, actual and an evidence ref (FR-28)', async () => {
    const project = await fixture({ statusCode: 503 });

    const { exitCode, stdout, stderr } = await runCli(['verify', project.epic, '--json'], {
      cwd: project.root,
    });

    expect(exitCode, `stderr:\n${stderr}`).toBe(1);

    // ASSERTED ON THE PERSISTED DOCUMENT, not an in-memory object: persistence is where
    // fields get dropped, and `--json` stdout is byte-identical to `result.json`.
    const document = JSON.parse(stdout) as RunDocument;
    const failed = criterion(document, 'E1-01');

    expect(document.outcome).toEqual({ verdict: 'FAIL' });
    expect(failed.status).toBe('fail');
    expect(failed.expected).toBe('200');
    expect(failed.actual).toBe('503');
    expect(failed.evidence?.length ?? 0).toBeGreaterThan(0);
  });

  it('carries the criterion statement verbatim from the frozen contract (FR-29)', async () => {
    const project = await fixture({ statusCode: 503 });

    const { stdout } = await runCli(['verify', project.epic, '--json'], { cwd: project.root });
    const document = JSON.parse(stdout) as RunDocument;

    // A human's own words, not a sentence a renderer synthesised from a status.
    expect(criterion(document, 'E1-01').statement).toBe(
      'The service answers /status with the code its contract promises.',
    );
  });

  it("prints the report in brief §36's shape, with FR-29's sections", async () => {
    const project = await fixture({ statusCode: 503, gates: [{ id: 'lint', passes: true }] });

    const { stdout } = await runCli(['verify', project.epic], { cwd: project.root });

    // Contract status and revisions.
    expect(stdout).toMatch(/contract/i);
    expect(stdout).toMatch(/frozen/i);
    // Environment.
    expect(stdout).toContain(process.version);
    // Gates.
    expect(stdout).toContain('lint');
    // Per-criterion marks with their one-line summaries.
    expect(stdout).toContain('E1-01');
    expect(stdout).toContain('The service answers /status with the code its contract promises.');
    // Counts and verdict.
    expect(stdout).toMatch(/FAIL/);
    // The evidence path an operator opens next.
    expect(stdout).toContain('.specwitness/runs/');
  });

  it('does not print ERROR: for a FAIL — a verdict of no is not a malfunction', async () => {
    const project = await fixture({ statusCode: 503 });

    const { exitCode, stderr } = await runCli(['verify', project.epic], { cwd: project.root });

    expect(exitCode).toBe(1);
    expect(stderr).not.toContain('ERROR:');
  });
});

describe('the exit table, live, through the built binary (ADR-002)', () => {
  it('0 — every criterion passes', async () => {
    const project = await fixture();
    const { exitCode } = await runCli(['verify', project.epic], { cwd: project.root });
    expect(exitCode).toBe(0);
  });

  it('1 — a criterion fails', async () => {
    const project = await fixture({ statusCode: 503 });
    const { exitCode } = await runCli(['verify', project.epic], { cwd: project.root });
    expect(exitCode).toBe(1);
  });

  it('1 — a gate fails, and no probe ever runs (ADR-003)', async () => {
    const project = await fixture({ gates: [{ id: 'build', passes: false }] });

    const { exitCode, stdout } = await runCli(['verify', project.epic, '--json'], {
      cwd: project.root,
    });

    expect(exitCode).toBe(1);
    const document = JSON.parse(stdout) as RunDocument;

    expect(document.outcome).toMatchObject({ verdict: 'FAIL' });
    // The whole criterion set is present and every entry is `skipped` — materialised by
    // the AGGREGATE stage, which is the one stage a gate-failed run still reaches.
    expect(document.criteria).toHaveLength(3);
    expect(document.criteria.every((entry) => entry.status === 'skipped')).toBe(true);
    expect(
      document.stages.find((stage) => stage.stage === 'probes')?.status,
    ).toBe('skipped');
  });

  it('2 — a human criterion, in a run where probes really executed and PASSED', async () => {
    // THE EPIC 3 DEFECT, ONE EPIC LATER. `verifiability: human` is decided before attempts
    // are looked at, unconditionally — so a run in which every automated criterion passed
    // must still be NEEDS_HUMAN. Epic 3 found and reverted a "floor" variant of this and
    // called it a silent redesign of a recorded decision (Q39).
    const project = await fixture({ human: true });

    const { exitCode, stdout } = await runCli(['verify', project.epic, '--json'], {
      cwd: project.root,
    });

    expect(exitCode).toBe(2);
    const document = JSON.parse(stdout) as RunDocument;

    expect(document.outcome).toEqual({ verdict: 'NEEDS_HUMAN' });
    expect(criterion(document, 'E1-04').status).toBe('needs_human');
    // ...and the probes really did run and pass. Without this the test would also pass on a
    // build where nothing executed at all.
    expect(criterion(document, 'E1-01').status).toBe('pass');
    expect(criterion(document, 'E1-03').status).toBe('pass');
  });

  it('2 — a plan that refused to automate every criterion, with gates green', async () => {
    // Q38's `not-safely-automatable` is Q39's OTHER trigger, and before this story it
    // derived to `skipped` — which `aggregate` treats as inert, so the run reported PASS at
    // exit 0. A criterion the plan-author explicitly refused to automate, reported
    // merge-eligible.
    const project = await fixture({
      plannedNeedsHuman: true,
      gates: [{ id: 'lint', passes: true }],
    });

    const { exitCode, stdout } = await runCli(['verify', project.epic, '--json'], {
      cwd: project.root,
    });

    expect(exitCode).toBe(2);
    const document = JSON.parse(stdout) as RunDocument;
    expect(document.outcome).toEqual({ verdict: 'NEEDS_HUMAN' });
    expect(document.criteria.every((entry) => entry.status === 'needs_human')).toBe(true);
  });

  it('3 — an observation command that emits non-JSON is INFRA, never a product FAIL', async () => {
    // Q35 makes "exit 0 and emit JSON" the observation command's declared contract, so a
    // broken one is criterion `error` — exit 3, "SpecWitness could not reach a conclusion".
    // Exit 1 here would tell a harness the branch has defects and route repair automation
    // at code that is fine.
    const project = await fixture({ brokenObservation: true });

    const { exitCode, stdout, stderr } = await runCli(['verify', project.epic, '--json'], {
      cwd: project.root,
    });

    expect(exitCode).toBe(3);
    const document = JSON.parse(stdout) as RunDocument;
    expect(document.outcome).toEqual({ infraError: 'infra' });
    expect(criterion(document, 'E1-02').status).toBe('error');
    // An exit-3 run must never print zero bytes on stderr: the diagnosis without the remedy
    // is the state Epic 3 found and fixed.
    expect(stderr).toContain('ERROR:');
  });

  it('64 — a malformed epic id, before anything is read or spawned', async () => {
    const project = await fixture();
    const { exitCode, stderr } = await runCli(['verify', 'not-an-epic'], { cwd: project.root });

    expect(exitCode).toBe(64);
    expect(stderr).toContain('ERROR:');
  });
});

describe('the amended green-for-nothing refusal (DECISIONS 3.7-D4, widened by 4.7)', () => {
  it('VERIFIES a gate-less project whose plan maps criteria to probes', async () => {
    // Previously refused. A gate-less project with probes adjudicates plenty, and refusing
    // it would have made behavioural verification unreachable for exactly the projects this
    // epic was built for.
    const project = await fixture({ gates: [] });

    const { exitCode, stderr } = await runCli(['verify', project.epic], { cwd: project.root });

    expect(exitCode, `stderr:\n${stderr}`).toBe(0);
    expect(stderr).not.toContain('could not check anything');
  });

  it('STILL REFUSES a project with neither gates nor probes — the clause that matters', async () => {
    // This is why the refusal was widened rather than removed. `aggregate([], [])` is PASS.
    const project = await fixture({ gates: [], plannedNeedsHuman: true });

    const { exitCode, stdout, stderr } = await runCli(['verify', project.epic], {
      cwd: project.root,
    });

    expect(exitCode).toBe(3);
    expect(stderr).toContain('ERROR:');
    expect(stderr).toContain('HINT:');
    expect(stderr).toContain('could not check anything');
    // REFUSED BEFORE THE RUN: no run directory exists to hold a misleading PASS beside a
    // CLI exiting 3.
    expect(stdout).toBe('');
    await expect(readdir(join(project.root, '.specwitness', 'runs'))).resolves.toEqual([]);
  });
});

describe('AD-8 — every probe process group reaches the manifest', () => {
  it('records a pgid for the observation and shell probes it spawned', async () => {
    // Without this, `specwitness clean` cannot reap a probe or its descendants after an
    // interrupted run. Every other spawning module records one; the observation surface did
    // not until this story.
    const project = await fixture();

    const { exitCode, stdout } = await runCli(['verify', project.epic, '--json'], {
      cwd: project.root,
    });
    expect(exitCode).toBe(0);

    const document = JSON.parse(stdout) as RunDocument;
    const manifest = JSON.parse(
      await readFile(
        join(project.root, document.environment.runDirectory, 'manifest.json'),
        'utf8',
      ),
    ) as { readonly processGroups?: readonly number[] };

    // One service, one data command, three probe spawns (two observation snapshots plus a
    // shell probe) — the count is not asserted, because it is an implementation detail; the
    // property is that probes contribute at all.
    expect((manifest.processGroups ?? []).length).toBeGreaterThanOrEqual(4);
  });
});

describe('every stage really ran, in the frozen order', () => {
  it('reports services, data and probes as `ok` rather than as placeholders', async () => {
    const project = await fixture();

    const { stdout } = await runCli(['verify', project.epic, '--json'], { cwd: project.root });
    const document = JSON.parse(stdout) as RunDocument;

    const byName = new Map(document.stages.map((stage) => [stage.stage, stage]));
    for (const name of ['services', 'data', 'probes']) {
      expect(byName.get(name)?.status, `stage ${name}`).toBe('ok');
      expect(byName.get(name)?.detail ?? '').not.toContain('not implemented yet');
    }
    expect(byName.get('probes')?.detail).toMatch(/probes executed/);
  });
});
