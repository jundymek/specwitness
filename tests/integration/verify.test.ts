import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

import { contractState, parseContract } from '../../src/schemas/contract.js';

import {
  buildFixture,
  FAILING_GATE_STDERR,
  FAILING_GATE_STDOUT,
  runCli,
  type Fixture,
} from './helpers/verify-fixture.js';

/**
 * Story 3.7 — `specwitness verify` end to end, against the BUILT BINARY.
 *
 * Everything here drives `dist/cli.js` as a shell would, because exit codes,
 * stream separation and the shebang only exist at the process boundary: an
 * in-process test can assert a returned number while the shipped binary exits
 * differently.
 *
 * Fixtures are inline (`helpers/verify-fixture.ts`), built per test in a temp
 * directory. They are NOT Golden Verification Corpus fixtures — that is Epic 6.
 */

const fixtures: Fixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function fixture(...args: Parameters<typeof buildFixture>): Promise<Fixture> {
  const built = await buildFixture(...args);
  fixtures.push(built);
  return built;
}

/**
 * The fixtures themselves, asserted before anything is asserted THROUGH them.
 *
 * A fixture nobody checked is a fixture that can pass a test for the wrong
 * reason: "frozen" that is really a draft would turn the AC1 green path into a
 * test of the guard's refusal, and it would still be green.
 */
describe('fixture preconditions', () => {
  it('produces a real git repository with two commits and a clean tree', async () => {
    const project = await fixture();

    expect(project.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(project.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(project.headSha).not.toBe(project.baseSha);
    // The AD-8 baseline: anything `verify` changes shows up as a diff, not noise.
    expect(await project.status()).toBe('');
  });

  it('scaffolds the shipped .specwitness layout, including the nested .gitignore', async () => {
    const project = await fixture();

    await expect(stat(join(project.root, '.specwitness', 'contracts'))).resolves.toBeDefined();
    await expect(stat(join(project.root, '.specwitness', 'runs'))).resolves.toBeDefined();

    // Q11: the ignore entries live in a NESTED .specwitness/.gitignore, not in
    // the project's root .gitignore. A fixture that invented its own layout
    // would prove nothing about the product.
    const ignore = await readFile(join(project.root, '.specwitness', '.gitignore'), 'utf8');
    expect(ignore).toContain('runs/');
  });

  it('freezes the contract with the shipped freeze, so the fingerprint is the product’s own', async () => {
    const project = await fixture();

    const contract = parseContract(await readFile(project.contractPath, 'utf8'), project.contractPath);

    expect(contractState(contract)).toBe('frozen');
    expect(contract.meta.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('leaves the default contract free of human-verifiability criteria (AC1 depends on it)', async () => {
    const project = await fixture();

    const contract = parseContract(await readFile(project.contractPath, 'utf8'), project.contractPath);

    // needs_human outranks PASS in aggregate (Q39), so a single `human`
    // criterion here would make "green gates => exit 0 PASS" unsatisfiable.
    expect(contract.spec.criteria.map((criterion) => criterion.verifiability)).not.toContain(
      'human',
    );
    expect(contract.spec.criteria.length).toBeGreaterThan(0);
  });

  it('offers a frozen contract WITH a human criterion for the NEEDS_HUMAN arm', async () => {
    const project = await fixture({ contract: 'frozen-with-human' });

    const contract = parseContract(await readFile(project.contractPath, 'utf8'), project.contractPath);

    expect(contractState(contract)).toBe('frozen');
    expect(contract.spec.criteria.map((criterion) => criterion.verifiability)).toContain('human');
  });

  it('distinguishes a never-frozen draft from a tampered contract', async () => {
    const draft = await fixture({ contract: 'draft' });
    const tampered = await fixture({ contract: 'tampered' });

    const draftContract = parseContract(await readFile(draft.contractPath, 'utf8'), draft.contractPath);
    const tamperedContract = parseContract(
      await readFile(tampered.contractPath, 'utf8'),
      tampered.contractPath,
    );

    expect(contractState(draftContract)).toBe('draft');
    // The distinction the guard's third refusal rests on: a tampered contract is
    // NOT a draft, and must never be reported as one — that wording invites
    // freezing over the edit and launders the tamper (ADR-005).
    expect(contractState(tamperedContract)).toBe('tampered');
  });

  it('omits the contract entirely when asked', async () => {
    const project = await fixture({ contract: 'absent' });

    await expect(stat(project.contractPath)).rejects.toThrow();
  });

  it('writes gate scripts that pass and fail deterministically, with usable output', async () => {
    const project = await fixture({
      gates: [
        { id: 'lint', behaviour: 'pass' },
        { id: 'build', behaviour: 'fail' },
      ],
    });

    const passing = await execa(process.execPath, ['gates/lint.cjs'], {
      cwd: project.root,
      reject: false,
    });
    const failing = await execa(process.execPath, ['gates/build.cjs'], {
      cwd: project.root,
      reject: false,
    });

    expect(passing.exitCode).toBe(0);
    expect(failing.exitCode).toBe(1);
    // The evidence assertion in AC2 needs something unmistakable to look for.
    expect(failing.stdout).toContain(FAILING_GATE_STDOUT);
    expect(failing.stderr).toContain(FAILING_GATE_STDERR);
  });

  it('offers a gate that fails AFTER making the run directory unwritable', async () => {
    const project = await fixture({
      gates: [{ id: 'build', behaviour: 'fail-and-lock-run-dir' }],
    });

    // Stand in for the run directory `verify` would have created by the time a
    // gate runs, so the script can be exercised without a pipeline.
    const runDir = join(project.root, '.specwitness', 'runs', 'run-20260901T000000Z-aaaa');
    await mkdir(runDir, { recursive: true });

    const result = await execa(process.execPath, ['gates/build.cjs'], {
      cwd: project.root,
      reject: false,
    });

    // Fails as a gate — a product-negative result, decided BEFORE the run
    // directory becomes unwritable.
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(FAILING_GATE_STDOUT);

    // And the run directory can no longer be written to, which is what makes the
    // persist failure happen in the same run rather than in a second one.
    const mode = (await stat(runDir)).mode & 0o777;
    expect(mode & 0o200).toBe(0);
    await expect(writeFile(join(runDir, 'probe.json'), '{}', 'utf8')).rejects.toThrow();
  });

  it('declares those gates in the config, in declaration order', async () => {
    const project = await fixture({
      gates: [
        { id: 'lint', behaviour: 'pass' },
        { id: 'typecheck', behaviour: 'pass' },
        { id: 'build', behaviour: 'fail' },
      ],
    });

    const config = await readFile(join(project.root, '.specwitness', 'config.yaml'), 'utf8');

    expect(config.indexOf('id: lint')).toBeLessThan(config.indexOf('id: typecheck'));
    expect(config.indexOf('id: typecheck')).toBeLessThan(config.indexOf('id: build'));
    // AD-3: argv, not a shell line. Nothing here needs quoting or a shell.
    expect(config).toContain('run: node gates/lint.cjs');
  });
});

/** House style: `ERROR: <what>` then `HINT: <how to fix>`, both on stderr. */
function houseStyleLines(stderr: string) {
  return {
    errors: stderr.split('\n').filter((line) => line.startsWith('ERROR: ')),
    hints: stderr.split('\n').filter((line) => line.startsWith('HINT: ')),
  };
}


/** The single ERROR: line, without its prefix. */
function errorLine(stderr: string): string {
  return houseStyleLines(stderr).errors.join('\n');
}

/** The single HINT: line, without its prefix. */
function hintLine(stderr: string): string {
  return houseStyleLines(stderr).hints.join('\n');
}

/**
 * The exit table, proven live through the built binary.
 *
 * Every case asserts the EXACT code rather than a negation. Story 3.2 shipped
 * and fixed a bug where the CLI could exit **13** — a code that is not in the
 * table at all — from a top-level await over an unref'd timer, with no output
 * and no ERROR/HINT pair. An assertion written as "not 1" would have passed
 * straight over it.
 */
describe('verify — usage errors exit 64 (ADR-002)', () => {
  it.each([
    ['a malformed epic id', ['verify', 'not-an-epic']],
    ['epic 0, which does not exist', ['verify', '0']],
    ['an empty --root value', ['verify', '1', '--root', '']],
    ['an empty --head value', ['verify', '1', '--head', '']],
    ['an unknown flag', ['verify', '1', '--definitely-not-a-flag']],
  ])('%s exits 64 with one ERROR/HINT pair and nothing on stdout', async (_label, args) => {
    const project = await fixture();

    const { exitCode, stdout, stderr } = await runCli(args, { cwd: project.root });

    // 64 sits outside 0–3 precisely so a typo can never be read as a verdict.
    expect(exitCode).toBe(64);

    const { errors, hints } = houseStyleLines(stderr);
    expect(errors).toHaveLength(1);
    expect(hints).toHaveLength(1);
    // The harness parses stdout; a diagnostic there would corrupt it.
    expect(stdout).toBe('');
  });

  it('treats every accepted spelling of the epic id as the same epic', async () => {
    const project = await fixture({ contract: 'absent' });

    // All three name epic-1, so all three must fail on the SAME missing
    // contract rather than resolve three different lookups.
    for (const spelling of ['1', 'epic-1', 'epic-01']) {
      const { exitCode, stdout } = await runCli(['verify', spelling], { cwd: project.root });

      expect(exitCode).toBe(3);
      expect(stdout).toContain('epic-1');
    }
  });
});

describe('verify — a project that declares nothing is refused, never PASSed (DECISIONS 3.7-D4)', () => {
  it('exits 3 with an ERROR/HINT pair rather than reporting merge-eligible', async () => {
    const project = await fixture({ gates: [] });

    const { exitCode, stdout, stderr } = await runCli(['verify', 'epic-1'], { cwd: project.root });

    // Without this refusal the run reaches PASS having executed nothing, and
    // exit 0 tells a harness the branch is merge-eligible.
    expect(exitCode).toBe(3);
    expect(exitCode).not.toBe(0);

    const { errors, hints } = houseStyleLines(stderr);
    expect(errors).toHaveLength(1);
    expect(hints).toHaveLength(1);
    expect(stderr).toContain('declares no deterministic gates');
    expect(stdout).toBe('');
  });

  it('refuses BEFORE the run, so no run directory and no result.json exist', async () => {
    const project = await fixture({ gates: [] });

    await runCli(['verify', 'epic-1'], { cwd: project.root });

    // A persisted PASS beside a CLI exiting 3 would be worse than the defect it
    // fixes: whoever opens the run directory later has no exit code to compare
    // against, so the stored verdict simply wins.
    expect(await readdir(join(project.root, '.specwitness', 'runs'))).toEqual([]);
  });
});

/**
 * The verifiability guard, through the binary (FR-8, ADR-005).
 *
 * All three refusals classify as `integrity`, so the CLASSIFICATION cannot tell
 * them apart and the hint is the only thing that can. That is why each case
 * asserts its own hint, and why the tampered one asserts an ABSENCE: the remedy
 * an operator would otherwise reach for — freeze it again — is exactly the one
 * that must never be offered, because freezing over an edit launders the tamper
 * and destroys the only evidence it happened.
 */
describe('verify — the contract guard refuses, exits 3, and says how to fix it', () => {
  it('refuses when there is no contract, naming the command that makes one', async () => {
    const project = await fixture({ contract: 'absent' });

    const { exitCode, stdout, stderr } = await runCli(['verify', 'epic-1'], { cwd: project.root });

    expect(exitCode).toBe(3);
    expect(exitCode).not.toBe(1);
    expect(hintLine(stderr)).toContain('specwitness contract epic-1');
    expect(stdout).toContain('VERDICT: (none) — infra error: integrity');
  });

  it('refuses a never-frozen draft, pointing at --freeze', async () => {
    const project = await fixture({ contract: 'draft' });

    const { exitCode, stderr } = await runCli(['verify', 'epic-1'], { cwd: project.root });

    expect(exitCode).toBe(3);
    expect(errorLine(stderr)).toContain('never been frozen');
    expect(hintLine(stderr)).toContain('--freeze');
  });

  it('refuses a TAMPERED contract with --amend, and never offers --freeze', async () => {
    const project = await fixture({ contract: 'tampered' });

    const { exitCode, stderr } = await runCli(['verify', 'epic-1'], { cwd: project.root });

    expect(exitCode).toBe(3);
    // The diagnosis must say what actually happened...
    expect(errorLine(stderr)).toContain('edited after it was frozen');
    expect(errorLine(stderr)).not.toContain('never been frozen');
    // ...and the remedy must be amendment, never a second freeze.
    expect(hintLine(stderr)).toContain('--amend');
    expect(hintLine(stderr)).not.toContain('--freeze');
  });

  it.each([
    ['absent', 'absent'],
    ['draft', 'draft'],
    ['tampered', 'tampered'],
  ] as const)('refuses a %s contract BEFORE creating a worktree', async (_label, contract) => {
    const project = await fixture({ contract });

    const { stdout } = await runCli(['verify', 'epic-1'], { cwd: project.root });

    // `integrity` precedes `worktree` precisely so a contract that cannot gate
    // verification costs nothing: no worktree, no spawn, no cleanup to get wrong.
    expect(stdout).toMatch(/–\s+skipped\s+worktree/);
    expect(stdout).toContain('Worktree:    (none)');
  });

  it('prints exactly one ERROR/HINT pair for a refusal', async () => {
    const project = await fixture({ contract: 'tampered' });

    const { stderr } = await runCli(['verify', 'epic-1'], { cwd: project.root });

    const { errors, hints } = houseStyleLines(stderr);
    expect(errors).toHaveLength(1);
    expect(hints).toHaveLength(1);
  });
});

/**
 * The NEEDS_HUMAN arm (exit 2) — the fourth code, and the one nothing else in
 * this epic can produce.
 *
 * `verifiability: human` is a property of the CONTRACT, not of what ran: a
 * criterion a person must judge can never be machine-passed (Q39, and
 * `domain/contract.ts` says so in its own words). So this asserts the
 * UNCONDITIONAL form — the run below declares gates and they are executed, and
 * the answer is still NEEDS_HUMAN.
 */
describe('verify — a human-verifiability criterion yields NEEDS_HUMAN, exit 2 (Q39)', () => {
  it('exits 2 with verdict NEEDS_HUMAN rather than PASS', async () => {
    const project = await fixture({ contract: 'frozen-with-human' });

    const { exitCode, stdout } = await runCli(['verify', 'epic-1', '--json'], {
      cwd: project.root,
    });

    expect(exitCode).toBe(2);
    // Not PASS: a criterion nobody adjudicated must never be reported as one
    // that was satisfied.
    expect(exitCode).not.toBe(0);

    const document = JSON.parse(stdout) as {
      outcome: { verdict?: string; infraError?: string; gateFailed?: string };
      criteria: { criterionId: string; status: string }[];
    };

    expect(document.outcome.verdict).toBe('NEEDS_HUMAN');
    expect(document.outcome.infraError).toBeUndefined();
    expect(document.outcome.gateFailed).toBeUndefined();

    // The human criterion is the one that changed the verdict; the automated
    // ones stay `skipped`, because nothing probes them in this epic.
    const byId = new Map(document.criteria.map((c) => [c.criterionId, c.status]));
    expect(byId.get('E1-03')).toBe('needs_human');
    expect(byId.get('E1-01')).toBe('skipped');
    expect(byId.get('E1-02')).toBe('skipped');
  });

  it('exits 0 for the same fixture without the human criterion, so the rule is not "everything needs a human"', async () => {
    const project = await fixture();

    const { exitCode } = await runCli(['verify', 'epic-1'], { cwd: project.root });

    expect(exitCode).toBe(0);
  });
});
