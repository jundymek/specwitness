/**
 * Story 4.7, AC3 — auto-compilation and the `--no-ai` refusal, through the built binary.
 *
 * All four cells of `plan present × --no-ai`, because they are four different behaviours
 * and three of them are easy to get subtly wrong:
 *
 *   present + ai       -> execute. Zero provider calls.
 *   present + --no-ai  -> execute. Zero provider calls. IDENTICAL.
 *   absent  + ai       -> compile first, RECORDED in providerUsage, then execute.
 *   absent  + --no-ai  -> REFUSE, hinting `specwitness plan`.
 *
 * **The auto-compilation path is exercised only through the SHIPPED `fake` provider.** A
 * real `claude`/`codex` invocation against a live subscription is the owner's dogfooding
 * step and has never run, so the provenance a real CLI reports remains unverified. Stated
 * here as well as in the PR body, so a green suite is not read as more than it is.
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildProbeFixture, runCli, type ProbeFixture } from './helpers/probe-fixture.js';

interface RunDocument {
  readonly outcome: { readonly verdict?: string; readonly infraError?: string };
  readonly criteria: readonly { readonly criterionId: string; readonly status: string }[];
  readonly providerUsage: readonly {
    readonly role: string;
    readonly provider: string;
    readonly attempts: number;
  }[];
  readonly environment: { readonly runDirectory: string };
}

const fixtures: ProbeFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => await fixture.cleanup()));
});

async function fixture(
  ...args: Parameters<typeof buildProbeFixture>
): Promise<ProbeFixture> {
  const built = await buildProbeFixture(...args);
  fixtures.push(built);
  return built;
}

describe('AC3 — plan present', () => {
  it('with AI allowed: verifies, and makes zero provider calls anyway', async () => {
    const project = await fixture({ fakePlanAuthor: true });

    const { exitCode, stdout } = await runCli(['verify', project.epic, '--json'], {
      cwd: project.root,
    });

    expect(exitCode).toBe(0);
    // A `plan-author` IS configured here, and still nothing was called: a compiled plan
    // executes with no provider in scope at all (FR-18, Q66).
    expect((JSON.parse(stdout) as RunDocument).providerUsage).toEqual([]);
  });

  it('with --no-ai: SUCCEEDS, with the same verdict and the same zero calls', async () => {
    // The interaction AC1 and AC3 share. `--no-ai` constrains COMPILATION; with a plan on
    // disk there is nothing to compile, so the flag must change nothing at all.
    const project = await fixture({ fakePlanAuthor: true });

    const withAi = await runCli(['verify', project.epic, '--json'], { cwd: project.root });
    const withoutAi = await runCli(['verify', project.epic, '--json', '--no-ai'], {
      cwd: project.root,
    });

    expect(withoutAi.exitCode, withoutAi.stderr).toBe(0);
    const document = JSON.parse(withoutAi.stdout) as RunDocument;
    expect(document.providerUsage).toEqual([]);
    expect(document.outcome).toEqual((JSON.parse(withAi.stdout) as RunDocument).outcome);
    expect(document.criteria.map((entry) => entry.status)).toEqual(
      (JSON.parse(withAi.stdout) as RunDocument).criteria.map((entry) => entry.status),
    );
  });
});

describe('AC3 — no plan, --no-ai: a REFUSAL, not a silent skip', () => {
  it('exits 3 with ERROR/HINT naming `specwitness plan`', async () => {
    const project = await fixture({ plan: false, fakePlanAuthor: true });

    const { exitCode, stdout, stderr } = await runCli(['verify', project.epic, '--no-ai'], {
      cwd: project.root,
    });

    expect(exitCode).toBe(3);
    expect(stderr).toContain('ERROR:');
    expect(stderr).toContain('HINT:');
    expect(stderr).toContain(`specwitness plan ${project.epic}`);
    // NOT a PASS with zero criteria. `aggregate([], [])` is PASS, so a silent skip here
    // would report the branch merge-eligible having observed nothing — the one output this
    // product exists to make trustworthy.
    expect(stdout).not.toContain('PASS');
  });

  it('refuses BEFORE creating a run, so no misleading result.json exists', async () => {
    const project = await fixture({ plan: false, fakePlanAuthor: true });

    await runCli(['verify', project.epic, '--no-ai'], { cwd: project.root });

    // Refusing afterwards would persist a document beside a CLI exiting 3, and whoever
    // opens that run directory later has no exit code to compare it against.
    await expect(stat(join(project.root, '.specwitness', 'runs'))).resolves.toBeDefined();
    const { stdout } = await runCli(['report', '--json'], { cwd: project.root });
    expect(stdout).not.toContain('PASS');
  });

  it('does not compile a plan file as a side effect', async () => {
    const project = await fixture({ plan: false, fakePlanAuthor: true });

    await runCli(['verify', project.epic, '--no-ai'], { cwd: project.root });

    await expect(
      stat(join(project.root, '.specwitness', 'plans', `${project.epic}.yaml`)),
    ).rejects.toThrow();
  });
});

describe('AC3 — no plan, AI allowed: compile first, and RECORD it', () => {
  it('compiles, writes the plan, verifies, and records the provider usage', async () => {
    const project = await fixture({ plan: false, fakePlanAuthor: true });

    const { exitCode, stdout, stderr } = await runCli(['verify', project.epic, '--json'], {
      cwd: project.root,
    });

    expect(exitCode, `stderr:\n${stderr}`).toBe(2);
    const document = JSON.parse(stdout) as RunDocument;

    // THE RECORDING IS THE POINT. FR-18's promise is that reruns are AI-free, so a run that
    // DID spend subscription quota must say so in the document a harness reads. An empty
    // `providerUsage` on this path would make the whole guarantee unauditable.
    expect(document.providerUsage).toHaveLength(1);
    expect(document.providerUsage[0]).toMatchObject({
      role: 'plan-author',
      provider: 'hermetic',
      attempts: 1,
    });

    // The compiled plan is on disk, not held in memory — otherwise the NEXT run compiles
    // another, spending quota every time and verifying against a plan nobody reviewed.
    const planPath = join(project.root, '.specwitness', 'plans', `${project.epic}.yaml`);
    await expect(stat(planPath)).resolves.toBeDefined();
    expect(await readFile(planPath, 'utf8')).toContain('status-probe');

    // ...and then it really executed. The fake's draft carries a `not-safely-automatable`
    // criterion, so NEEDS_HUMAN (exit 2) is the correct answer here, not PASS.
    expect(document.outcome).toEqual({ verdict: 'NEEDS_HUMAN' });
    expect(
      document.criteria.find((entry) => entry.criterionId === 'E1-01')?.status,
    ).toBe('pass');
  });

  it('says out loud that the run was not AI-free', async () => {
    const project = await fixture({ plan: false, fakePlanAuthor: true });

    const { stderr } = await runCli(['verify', project.epic], { cwd: project.root });

    expect(stderr).toContain('NOT AI-free');
  });

  it('the SECOND run makes zero provider calls — the whole reason a plan is compiled', async () => {
    const project = await fixture({ plan: false, fakePlanAuthor: true });

    const first = await runCli(['verify', project.epic, '--json'], { cwd: project.root });
    expect((JSON.parse(first.stdout) as RunDocument).providerUsage).toHaveLength(1);

    const second = await runCli(['verify', project.epic, '--json'], { cwd: project.root });
    expect((JSON.parse(second.stdout) as RunDocument).providerUsage).toEqual([]);

    // And the rerun under --no-ai now succeeds, where it refused before the plan existed.
    const third = await runCli(['verify', project.epic, '--json', '--no-ai'], {
      cwd: project.root,
    });
    expect(third.exitCode, third.stderr).toBe(2);
    expect((JSON.parse(third.stdout) as RunDocument).providerUsage).toEqual([]);
  });
});

describe('AC3 — no plan and no provider at all: Epic 3 gates-only survives', () => {
  it('runs the declared gates and says every criterion was skipped', async () => {
    // A project that assigned no `plan-author` never opted into AI. AC3's precondition is
    // "with providers configured", and Epic 3's gates-only mode is shipped, tested and
    // documented — retiring it here would be a redesign, not an integration. The
    // green-for-nothing case is still closed one layer down by
    // `assertSomethingToAdjudicate`.
    const project = await fixture({
      plan: false,
      fakePlanAuthor: false,
      gates: [{ id: 'lint', passes: true }],
    });

    const { exitCode, stdout, stderr } = await runCli(['verify', project.epic, '--json'], {
      cwd: project.root,
    });

    expect(exitCode, `stderr:\n${stderr}`).toBe(0);
    const document = JSON.parse(stdout) as RunDocument;
    expect(document.criteria.every((entry) => entry.status === 'skipped')).toBe(true);
    expect(document.providerUsage).toEqual([]);
    // Never silent about it: an operator reading only the exit code should still be told
    // that nothing behavioural was checked.
    expect(stderr).toContain('every criterion will be reported as skipped');
  });

  it('still refuses when there are no gates either', async () => {
    const project = await fixture({ plan: false, fakePlanAuthor: false, gates: [] });

    const { exitCode, stderr } = await runCli(['verify', project.epic], { cwd: project.root });

    expect(exitCode).toBe(3);
    expect(stderr).toContain('could not check anything');
  });
});

describe('nothing provider-independent may fail AFTER quota has been spent', () => {
  // My own claim, held to: "a run that quietly spent subscription quota while
  // `providerUsage` stayed empty would make the FR-18 guarantee unauditable". Compilation
  // happens before a run directory exists, so anything that can fail after it and before
  // `createRun` spends quota that no run document will ever record. Every such check must
  // therefore run FIRST. Found by the fourth Codex review pass.

  it('refuses an unresolvable ref BEFORE compiling a plan', async () => {
    const project = await fixture({ plan: false, fakePlanAuthor: true });

    const { exitCode, stderr } = await runCli(
      ['verify', project.epic, '--head', 'refs/heads/no-such-branch'],
      { cwd: project.root },
    );

    expect(exitCode).toBe(3);
    expect(stderr).toContain('no-such-branch');
    // THE ASSERTION THAT MATTERS: no plan was compiled, so no quota was spent to learn
    // that a ref does not resolve.
    await expect(
      stat(join(project.root, '.specwitness', 'plans', `${project.epic}.yaml`)),
    ).rejects.toThrow();
  });

  it('refuses a project that could never adjudicate anything BEFORE compiling', async () => {
    // No gates, and a contract whose every criterion is `human`. No plan the compiler could
    // produce would make this verifiable — 4.2's schema requires a human criterion to be
    // carried as needs-human — so compiling one is quota spent to reach a refusal that was
    // knowable in advance.
    const project = await fixture({
      gates: [],
      plan: false,
      fakePlanAuthor: true,
      humanOnly: true,
    });

    const { exitCode, stderr } = await runCli(['verify', project.epic], { cwd: project.root });

    expect(exitCode).toBe(3);
    expect(stderr).toContain('could not check anything');
    await expect(
      stat(join(project.root, '.specwitness', 'plans', `${project.epic}.yaml`)),
    ).rejects.toThrow();
  });

  it('refuses a MISSING plans directory BEFORE invoking the provider', async () => {
    // The instance the previous fix missed: `assertPlansDirectory` is the compiled plan's
    // OUTPUT precondition and ran after compilation, so a project whose `.specwitness/plans`
    // is absent paid for a plan it could not store — and rerunning paid again, since nothing
    // was written.
    //
    // ABSENT, not "present but a file": a plans path that is a file makes `readPlanFile`
    // fail with ENOTDIR long before compilation, so that case refuses identically either
    // way and would make this test pass without proving anything. Checked, and it did.
    //
    // The provider is configured but given NO fixture script, which is what makes an
    // invocation visible from outside: the fake refuses with "has no fixture for role". So
    // the two orderings produce different messages, and this test can tell them apart —
    // without that, both would fail with the same plans-directory error and the test would
    // pass either way.
    const project = await fixture({
      plan: false,
      fakePlanAuthorWithoutScript: true,
      missingPlansDir: true,
    });

    const { exitCode, stderr } = await runCli(['verify', project.epic], { cwd: project.root });

    expect(exitCode).toBe(3);
    expect(stderr).toContain('plans');
    // THE ASSERTION THAT MATTERS: the provider was never reached.
    expect(stderr).not.toContain('has no fixture for role');
  });

  it('still compiles when the run really can proceed', async () => {
    // The guard above must not turn into a refusal for every gate-less project: one whose
    // contract HAS automated criteria is exactly what this epic exists to verify.
    const project = await fixture({ gates: [], plan: false, fakePlanAuthor: true });

    const { exitCode, stdout } = await runCli(['verify', project.epic, '--json'], {
      cwd: project.root,
    });

    expect(exitCode).toBe(2);
    expect((JSON.parse(stdout) as RunDocument).providerUsage).toHaveLength(1);
  });
});

describe('a plan that no longer matches its contract is refused, never recompiled', () => {
  it('exits 3 telling the operator to recompile, rather than silently rewriting it', async () => {
    // A `verify` that quietly rewrote a committed, reviewed artifact would be the same
    // laundering ADR-005 exists to prevent, one artifact over. `specwitness plan` is where
    // that decision is made, and it has its own four overwrite rules.
    const project = await fixture({ fakePlanAuthor: true });
    const planPath = join(project.root, '.specwitness', 'plans', `${project.epic}.yaml`);
    const before = await readFile(planPath, 'utf8');

    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      planPath,
      before.replace(/fingerprint: \S+/, `fingerprint: ${'0'.repeat(64)}`),
      'utf8',
    );

    const { exitCode, stderr } = await runCli(['verify', project.epic], { cwd: project.root });

    expect(exitCode).toBe(3);
    expect(stderr).toContain('specwitness plan');
    // Untouched: the operator's file is theirs.
    expect(await readFile(planPath, 'utf8')).toContain('0'.repeat(64));
  });
});
