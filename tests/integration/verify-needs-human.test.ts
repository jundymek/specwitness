/**
 * Story 5.3, AC1 and AC2 — through the BUILT BINARY, asserting the process exit code.
 *
 * WHY THIS FILE EXISTS AT ALL, rather than an `aggregate()` unit test. Epic 3's version of
 * this exact defect — a `verifiability: human` criterion auto-PASSing at exit 0 because
 * `verifiability` was dropped at the integrity stage — was found by story 3.7's agent when
 * its exit-2 acceptance criterion turned out to be unsatisfiable. Nothing below the process
 * boundary would have caught it: every unit in the chain was individually correct. Epic 4
 * then lost four seam defects the same way, three of them found only by running the built
 * binary (retro §3 lesson 2).
 *
 * So: the real bin entry, a real frozen contract, a real compiled plan, a real exit code.
 *
 * THE FIXTURE IS INLINE — `tests/integration/helpers/probe-fixture.ts`, which builds it in
 * a temp directory on an ephemeral port. **It is NOT "Golden Corpus fixture 6", which this
 * story's acceptance criterion names and which does not exist; the Golden Verification
 * Corpus is Epic 6.** A green run of this file is evidence about this fixture, not corpus
 * coverage.
 *
 * ZERO PROVIDER CALLS. Every run here executes a plan that is already on disk, so no
 * `claude`/`codex` CLI is invoked and none is configured.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { buildProbeFixture, runCli, type ProbeFixture } from './helpers/probe-fixture.js';

interface RunDocument {
  readonly runId: string;
  readonly outcome: { readonly verdict?: string; readonly infraError?: string };
  readonly criteria: readonly {
    readonly criterionId: string;
    readonly status: string;
    readonly statement: string;
    readonly needsHumanReason?: string;
    readonly reviewerGuidance?: { readonly text: string; readonly truncated: boolean };
  }[];
  readonly environment: { readonly runDirectory: string };
}

const CONTRACT_HUMAN_GUIDANCE =
  'read the failure message aloud to somebody who did not write the code';
const DEFERRED_GUIDANCE = 'check this by hand';

/**
 * Every automated criterion deferred to a person — plus one passing gate.
 *
 * The gate is REQUIRED, not decoration. With every criterion deferred and nothing else
 * declared, the merged pipeline refuses the run outright ("this project declares no
 * deterministic gates, and its plan maps no criterion to a probe, so a verification run
 * could not check anything") and exits 3. That refusal is correct and is not this story's
 * to change: a run that checks nothing must not report a verdict. The gate gives the run
 * something real to verify, so the exit code below is about the needs-human path rather
 * than about an empty project.
 */
const DEFERRED_FIXTURE = {
  plannedNeedsHuman: true,
  gates: [{ id: 'lint', passes: true }],
} as const;

const fixtures: ProbeFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => await fixture.cleanup()));
});

async function fixture(...args: Parameters<typeof buildProbeFixture>): Promise<ProbeFixture> {
  const built = await buildProbeFixture(...args);
  fixtures.push(built);
  return built;
}

describe('AC1 — a contract-human criterion: NEEDS_HUMAN, exit 2, guidance in both views', () => {
  it('exits 2 with verdict NEEDS_HUMAN while every automated criterion passes', async () => {
    // The whole acceptance criterion in one assertion set. `aggregate`'s precedence is
    // merged and untouched here: no `fail`, no `error`, one `needs_human` — NEEDS_HUMAN.
    const project = await fixture({ human: true });

    const { exitCode, stdout, stderr } = await runCli(['verify', project.epic, '--json'], {
      cwd: project.root,
    });

    expect(exitCode, stderr).toBe(2);

    const document = JSON.parse(stdout) as RunDocument;
    expect(document.outcome.verdict).toBe('NEEDS_HUMAN');

    const human = document.criteria.find((entry) => entry.criterionId === 'E1-04');
    expect(human?.status).toBe('needs_human');

    // The automated criteria really did pass — otherwise this would be exit 1 for an
    // unrelated reason and the test would prove nothing about the human path.
    const automated = document.criteria.filter((entry) => entry.criterionId !== 'E1-04');
    expect(automated.map((entry) => entry.status)).toEqual(['pass', 'pass', 'pass']);
  });

  it('carries the reviewer guidance and the reason into --json', async () => {
    const project = await fixture({ human: true });

    const { stdout } = await runCli(['verify', project.epic, '--json'], { cwd: project.root });
    const human = (JSON.parse(stdout) as RunDocument).criteria.find(
      (entry) => entry.criterionId === 'E1-04',
    );

    expect(human?.needsHumanReason).toBe('human-verifiability');
    expect(human?.reviewerGuidance?.text).toBe(CONTRACT_HUMAN_GUIDANCE);
  });

  it('carries the same guidance into the human report (AC2)', async () => {
    // Under `--json` the machine document is stdout and every human line goes to stderr,
    // so this is the same run rendered both ways — AD-11's one model, two renderers.
    const project = await fixture({ human: true });

    const { stderr } = await runCli(['verify', project.epic, '--json'], { cwd: project.root });

    expect(stderr).toContain(CONTRACT_HUMAN_GUIDANCE);
    expect(stderr).toContain('no machine may decide it');
  });

  it('tells the reviewer where the evidence is, and that images are not redacted', async () => {
    const project = await fixture({ human: true });

    const { stdout, stderr } = await runCli(['verify', project.epic, '--json'], {
      cwd: project.root,
    });

    const { runDirectory } = (JSON.parse(stdout) as RunDocument).environment;
    expect(stderr).toContain(runDirectory);
    expect(stderr).toContain('screenshots and traces are NOT redacted');
  });

  it('survives the round trip: `report` re-renders the stored run identically', async () => {
    // Q52 — `report` re-renders the persisted `result.json` and never re-executes. If the
    // guidance had been carried in memory but not persisted, this is where it would
    // vanish, and a reviewer reading the run tomorrow is the person who would find out.
    const project = await fixture({ human: true });

    const verified = await runCli(['verify', project.epic, '--json'], { cwd: project.root });
    const { runId } = JSON.parse(verified.stdout) as RunDocument;

    const { exitCode, stdout } = await runCli(['report', runId], { cwd: project.root });

    // EXIT 0, not 2, and that is the merged decision rather than a gap in this story:
    // `report` succeeds whatever verdict it renders, because mapping a STORED verdict to
    // an exit code would be `report` re-adjudicating a run it did not perform
    // (`src/cli/commands/report.ts:128-134`). The exit-2 assertion belongs to `verify`,
    // where it is made above. What matters here is that the guidance survived the disk.
    expect(exitCode).toBe(0);
    expect(stdout).toContain('NEEDS_HUMAN');
    expect(stdout).toContain(CONTRACT_HUMAN_GUIDANCE);
    expect(stdout).toContain('no machine may decide it');
  });
});

describe("AC1 — the plan's own refusal (`not-safely-automatable`) renders DIFFERENTLY", () => {
  it('exits 2 and names the second reason, not the first', async () => {
    // Q39's other compile-time trigger, and 4.7's `plannedNeedsHuman` path. Here every
    // AUTOMATED criterion was deferred by the plan-author, so the remedy a reviewer is
    // offered must be the actionable one.
    const project = await fixture(DEFERRED_FIXTURE);

    const { exitCode, stdout, stderr } = await runCli(['verify', project.epic, '--json'], {
      cwd: project.root,
    });

    expect(exitCode, stderr).toBe(2);

    const document = JSON.parse(stdout) as RunDocument;
    expect(document.outcome.verdict).toBe('NEEDS_HUMAN');
    expect(document.criteria.every((entry) => entry.status === 'needs_human')).toBe(true);
    expect(document.criteria[0]?.needsHumanReason).toBe('not-safely-automatable');
    expect(document.criteria[0]?.reviewerGuidance?.text).toBe(DEFERRED_GUIDANCE);

    expect(stderr).toContain('could not be mapped to a safe probe');
    expect(stderr).toContain('sharpening the criterion often makes it automatable');
  });

  it('renders a reason a contract-human criterion never gets, and vice versa', async () => {
    // The two triggers are different facts with different remedies. A run that showed the
    // same sentence for both would tell a reviewer either to attempt the impossible or to
    // give up on the tractable.
    const deferred = await fixture(DEFERRED_FIXTURE);
    const contractHuman = await fixture({ human: true });

    const deferredReport = await runCli(['verify', deferred.epic, '--json'], {
      cwd: deferred.root,
    });
    const humanReport = await runCli(['verify', contractHuman.epic, '--json'], {
      cwd: contractHuman.root,
    });

    expect(deferredReport.stderr).toContain('could not be mapped to a safe probe');
    expect(deferredReport.stderr).not.toContain('no machine may decide it');

    expect(humanReport.stderr).toContain('no machine may decide it');
    expect(humanReport.stderr).not.toContain('could not be mapped to a safe probe');
  });
});

describe('THE NEGATIVE — a passing probe does not buy a human criterion its way to PASS', () => {
  it('a run whose automated criteria all pass still exits 2 because one criterion is human', async () => {
    // Every probe in this run observed and was satisfied; the only thing standing between
    // this branch and a green exit 0 is a criterion whose author wrote that no machine may
    // answer it. Verified red: with the needs-human derivation disabled, this run exits 0
    // — Epic 3's defect exactly, and the alarm story 3.7's agent had to find by hand.
    //
    // WHAT THIS TEST DOES **NOT** PROVE, stated because measuring it was surprising and a
    // later reader would otherwise credit it with more than it earns. It does not isolate
    // the CONTRACT clause (`criterion.verifiability === 'human'`) from the PLAN clause
    // (`plannedNeedsHuman`). Disabling the contract clause alone leaves this suite fully
    // green, because the plan gate REFUSES to compile a `verifiability: human` criterion
    // as anything but a needs-human arm (`schemas/plan.ts:1103-1108`) — so in the shipped
    // pipeline that criterion always arrives with `plannedNeedsHuman: true` as well, and
    // either clause alone is sufficient. The two are belt and braces, deliberately, and no
    // end-to-end fixture can separate them without constructing a plan the product refuses
    // to accept.
    //
    // The contract clause is therefore isolated where it CAN be: at the unit boundary, by
    // `criterion-result.test.ts`'s "stays needs_human even when a probe ran and its
    // assertions held", which calls the derivation directly with no plan in sight.
    const project = await fixture({ human: true });

    const { exitCode, stdout } = await runCli(['verify', project.epic, '--json'], {
      cwd: project.root,
    });

    expect(exitCode).toBe(2);

    const document = JSON.parse(stdout) as RunDocument;
    expect(document.outcome.verdict).not.toBe('PASS');
    expect(document.criteria.find((entry) => entry.criterionId === 'E1-04')?.status).toBe(
      'needs_human',
    );
  });

  it('the same project WITHOUT the human criterion passes at exit 0', async () => {
    // The control. Without it, an exit 2 above could come from anything — a broken fixture,
    // a failing probe, an infra error — and the assertion would be measuring the wrong
    // thing while looking green.
    const project = await fixture({ human: false });

    const { exitCode, stdout } = await runCli(['verify', project.epic, '--json'], {
      cwd: project.root,
    });

    expect(exitCode).toBe(0);
    expect((JSON.parse(stdout) as RunDocument).outcome.verdict).toBe('PASS');
  });
});

describe('the guidance never displaces the frozen contract statement', () => {
  it('reports both the contract wording and the plan wording', async () => {
    // FR-29's one-line summary is the criterion's own sentence, copied verbatim from the
    // frozen contract. Guidance supplements it; a renderer that replaced it would lose the
    // question the reviewer is being asked to answer.
    const project = await fixture({ human: true });

    const { stdout, stderr } = await runCli(['verify', project.epic, '--json'], {
      cwd: project.root,
    });

    const human = (JSON.parse(stdout) as RunDocument).criteria.find(
      (entry) => entry.criterionId === 'E1-04',
    );

    expect(human?.statement).toBe(
      'The failure message reads clearly to an operator who did not write the code.',
    );
    expect(stderr).toContain('The failure message reads clearly to an operator');
    expect(stderr).toContain(CONTRACT_HUMAN_GUIDANCE);
  });
});

describe('ADR-003 — a gate failure must not strip the guidance off a human criterion', () => {
  it('keeps the reason and guidance when a failing gate short-circuits the probes stage', async () => {
    // FOUND BY REVIEW, NOT BY ME. When a gate fails, ADR-003 stops the pipeline early and
    // the probes stage never runs — so the branch that forwards the plan's reason and
    // guidance is never reached. The aggregate stage then materialises the missing results
    // with `deriveCriterionResult(criterion, [])`, and a contract-human criterion stays
    // `needs_human` (the clause is unconditional) while losing both new fields.
    //
    // The verdict is FAIL here, not NEEDS_HUMAN — `fail` outranks `needs_human` (ADR-003,
    // Q45/Q46) and I do not touch that. But the needs_human items are still listed for the
    // eventual human pass, and a listed criterion that says a person must decide while
    // telling them nothing is exactly the stop sign this story exists to write on.
    const project = await fixture({ human: true, gates: [{ id: 'lint', passes: false }] });

    const { exitCode, stdout, stderr } = await runCli(['verify', project.epic, '--json'], {
      cwd: project.root,
    });

    expect(exitCode, stderr).toBe(1);

    const document = JSON.parse(stdout) as RunDocument;
    expect(document.outcome.verdict).toBe('FAIL');

    const human = document.criteria.find((entry) => entry.criterionId === 'E1-04');
    expect(human?.status).toBe('needs_human');
    expect(human?.needsHumanReason).toBe('human-verifiability');
    expect(human?.reviewerGuidance?.text).toBe(CONTRACT_HUMAN_GUIDANCE);

    // And it reaches the person, not only the document.
    expect(stderr).toContain(CONTRACT_HUMAN_GUIDANCE);
  });

  it('still reports the automated criteria as skipped, unchanged', async () => {
    // The guard on my own fix. The aggregate stage materialises EVERY unresolved criterion,
    // so handing it plan metadata must not turn an automated criterion into something new:
    // a plan-deferred criterion becoming `needs_human` on this path would be a decision
    // about ADR-003 semantics, which is 4.7 territory and not mine to take quietly.
    const project = await fixture({ human: true, gates: [{ id: 'lint', passes: false }] });

    const { stdout } = await runCli(['verify', project.epic, '--json'], { cwd: project.root });

    const automated = (JSON.parse(stdout) as RunDocument).criteria.filter(
      (entry) => entry.criterionId !== 'E1-04',
    );

    expect(automated.map((entry) => entry.status)).toEqual(['skipped', 'skipped', 'skipped']);
    expect(automated.every((entry) => entry.reviewerGuidance === undefined)).toBe(true);
    expect(automated.every((entry) => entry.needsHumanReason === undefined)).toBe(true);
  });
});
