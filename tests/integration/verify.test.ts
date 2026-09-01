import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

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

  it('offers a gate that fails AFTER blocking the run result write', async () => {
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

    // Fails as a gate — a product-negative result, decided BEFORE the result
    // write is blocked.
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(FAILING_GATE_STDOUT);

    // The block is narrow on purpose: the run directory stays writable, so
    // evidence capture and aggregation still work and the outcome IS decided.
    // Only the rename onto `result.json` can fail, because that name is now a
    // directory.
    expect((await stat(join(runDir, 'result.json'))).isDirectory()).toBe(true);
    await expect(
      writeFile(join(runDir, 'evidence-probe.txt'), 'still writable', 'utf8'),
    ).resolves.toBeUndefined();
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

/** The shape of the persisted document, narrowed to what these tests assert on. */
interface RunDocument {
  readonly runId: string;
  readonly outcome: { verdict?: string; infraError?: string; gateFailed?: string };
  readonly stages: { stage: string; status: string; detail?: string; hint?: string }[];
  readonly gates: { gateId: string; status: string }[];
  readonly criteria: { criterionId: string; status: string }[];
  readonly evidence: { kind: string; gateId?: string; stdout?: { text: string; fullPath?: string } }[];
  readonly environment: { runDirectory: string; worktreePath: string | null };
}

/** A listing of a directory tree with sizes and mtimes — for "nothing was written". */
async function fingerprintTree(dir: string): Promise<string> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const rows = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const full = join(entry.parentPath, entry.name);
        const info = await stat(full);
        return `${relative(dir, full)} ${info.size} ${info.mtimeMs}`;
      }),
  );
  return rows.sort().join('\n');
}

/**
 * AC1 — a contract-bearing project with passing gates verifies PASS, exit 0,
 * with a persisted run whose bytes are the ones printed.
 *
 * The assertions that matter most here are the NEGATIVE ones. A test that only
 * checked `exitCode === 0` would pass if every run returned 0, and a test that
 * only checked `verdict === 'PASS'` would pass for a run in which nothing
 * executed — which is exactly the state story 3.4 made unrepresentable and this
 * suite has to keep unrepresentable.
 */
describe('verify — AC1: green gates verify PASS, exit 0, with a persisted run', () => {
  it('exits 0 with verdict PASS and no failure marker of any kind', async () => {
    const project = await fixture({
      gates: [
        { id: 'lint', behaviour: 'pass' },
        { id: 'build', behaviour: 'pass' },
      ],
    });

    const { exitCode, stdout } = await runCli(['verify', 'epic-1', '--json'], {
      cwd: project.root,
    });

    expect(exitCode).toBe(0);

    const document = JSON.parse(stdout) as RunDocument;
    expect(document.outcome.verdict).toBe('PASS');
    expect(document.outcome.gateFailed).toBeUndefined();
    expect(document.outcome.infraError).toBeUndefined();
  });

  it('actually EXECUTED the declared gates rather than skipping past them', async () => {
    const project = await fixture({
      gates: [
        { id: 'lint', behaviour: 'pass' },
        { id: 'build', behaviour: 'pass' },
      ],
    });

    const { stdout } = await runCli(['verify', 'epic-1', '--json'], { cwd: project.root });
    const document = JSON.parse(stdout) as RunDocument;

    // A run in which nothing was checked and a run in which everything passed
    // are the two states this product must never confuse (story 3.4's words).
    expect(document.gates.map((gate) => [gate.gateId, gate.status])).toEqual([
      ['lint', 'pass'],
      ['build', 'pass'],
    ]);
    // And the honest report story 3.4 emits when nobody wired it must be absent:
    // its presence would mean my wiring is missing, not that my gates passed.
    expect(stdout).not.toContain('no gate runner was wired');
  });

  it('reports every criterion as skipped, because nothing probes them in this epic', async () => {
    const project = await fixture();

    const { stdout } = await runCli(['verify', 'epic-1', '--json'], { cwd: project.root });
    const document = JSON.parse(stdout) as RunDocument;

    expect(document.criteria.length).toBeGreaterThan(0);
    expect(document.criteria.every((criterion) => criterion.status === 'skipped')).toBe(true);
  });

  it('persists a run whose bytes are EXACTLY what --json printed', async () => {
    const project = await fixture();

    const { stdout } = await runCli(['verify', 'epic-1', '--json'], { cwd: project.root });
    const document = JSON.parse(stdout) as RunDocument;

    const resultPath = join(project.root, document.environment.runDirectory, 'result.json');
    const persisted = await readFile(resultPath, 'utf8');

    // BYTE equality, not "parses to the same object": the harness may diff, hash
    // or cache the document (Q53/Q55). Both sides come from one serializer, so
    // this holds by construction — and this assertion is what catches the day
    // somebody adds a second path.
    expect(stdout).toBe(persisted);
  });

  it('puts the document alone on stdout, with everything human on stderr', async () => {
    const project = await fixture();

    const { stdout, stderr } = await runCli(['verify', 'epic-1', '--json'], { cwd: project.root });

    // `verify --json | jq` must work with no filtering.
    expect(() => JSON.parse(stdout) as unknown).not.toThrow();
    expect(stdout.startsWith('{')).toBe(true);
    // The human rendering is not lost — it goes where it cannot corrupt stdout.
    expect(stderr).toContain('VERDICT: PASS');
  });

  it('names a run directory that belongs to the run id it reports', async () => {
    const project = await fixture();

    const { stdout } = await runCli(['verify', 'epic-1', '--json'], { cwd: project.root });
    const document = JSON.parse(stdout) as RunDocument;

    // Nothing else checks this, and a mismatch renders confusingly rather than
    // failing — the worst shape for a defect in a document read weeks later.
    // The edge builds both halves from one minted id, so this pins the one site
    // that could ever get it wrong.
    expect(document.environment.runDirectory.endsWith(document.runId)).toBe(true);
  });

  it('re-renders through `report` without executing or writing anything (Q52, FR-31)', async () => {
    const project = await fixture();

    const first = await runCli(['verify', 'epic-1', '--json'], { cwd: project.root });
    const document = JSON.parse(first.stdout) as RunDocument;
    const runDir = join(project.root, document.environment.runDirectory);

    const before = await fingerprintTree(runDir);
    const rendered = await runCli(['report', document.runId, '--json'], { cwd: project.root });
    const after = await fingerprintTree(runDir);

    expect(rendered.exitCode).toBe(0);
    // Byte-identical to what verify printed AND to what is on disk: report
    // echoes the stored bytes rather than re-serializing a parsed document.
    expect(rendered.stdout).toBe(first.stdout);
    // Listing, sizes and mtimes unchanged — stronger than a throwing runner,
    // because it also catches a write nobody intended.
    expect(after).toBe(before);
  });

  it('leaves the source repository byte-identical, and no worktree behind (AD-8)', async () => {
    const project = await fixture();

    const before = await project.status();
    const refsBefore = await project.refs();

    const { exitCode, stdout } = await runCli(['verify', 'epic-1', '--json'], {
      cwd: project.root,
    });
    const document = JSON.parse(stdout) as RunDocument;

    expect(exitCode).toBe(0);
    // FR-19's whole promise: verification never touches the tree it verifies.
    expect(await project.status()).toBe(before);
    expect(await project.refs()).toBe(refsBefore);

    // And teardown removed the worktree it created, container included.
    expect(document.environment.worktreePath).not.toBeNull();
    await expect(stat(document.environment.worktreePath as string)).rejects.toThrow();
  });
});

/**
 * AC2 — a broken build is a PRODUCT failure: exit 1 with the failing gate
 * named, never exit 3.
 *
 * The mirror image matters as much as the case itself. A gate failure reported
 * as exit 3 tells a harness the environment is broken, so it retries a branch
 * that will never build; an infra failure reported as exit 1 tells it the
 * branch has defects, so it blocks a mergeable one. Both assertions are here.
 */
describe('verify — AC2: a failing gate is FAIL, exit 1, matching ADR-003', () => {
  const brokenBuild = [
    { id: 'lint', behaviour: 'pass' },
    { id: 'build', behaviour: 'fail' },
    { id: 'unit', behaviour: 'pass' },
  ] as const;

  it('exits 1 with verdict FAIL and gateFailed naming the gate — not exit 3', async () => {
    const project = await fixture({ gates: [...brokenBuild] });

    const { exitCode, stdout } = await runCli(['verify', 'epic-1', '--json'], {
      cwd: project.root,
    });

    expect(exitCode).toBe(1);
    expect(exitCode).not.toBe(3);

    const document = JSON.parse(stdout) as RunDocument;
    expect(document.outcome.verdict).toBe('FAIL');
    // A string carrying the gate id, not a boolean: repair automation routes to
    // "fix the build" rather than to a criterion.
    expect(document.outcome.gateFailed).toBe('build');
    expect(document.outcome.infraError).toBeUndefined();
  });

  it('stops at the failing gate and reports the rest as skipped, not as missing', async () => {
    const project = await fixture({ gates: [...brokenBuild] });

    const { stdout } = await runCli(['verify', 'epic-1', '--json'], { cwd: project.root });
    const document = JSON.parse(stdout) as RunDocument;

    // A missing gate and a skipped gate look identical in a report, and only
    // one of them is true.
    expect(document.gates.map((gate) => [gate.gateId, gate.status])).toEqual([
      ['lint', 'pass'],
      ['build', 'fail'],
      ['unit', 'skipped'],
    ]);
  });

  it('reports ALL criteria as skipped when a gate failed (ADR-003)', async () => {
    const project = await fixture({ gates: [...brokenBuild] });

    const { stdout } = await runCli(['verify', 'epic-1', '--json'], { cwd: project.root });
    const document = JSON.parse(stdout) as RunDocument;

    expect(document.criteria.length).toBeGreaterThan(0);
    expect(document.criteria.every((criterion) => criterion.status === 'skipped')).toBe(true);
  });

  it('captures the gate output as evidence, with a working relative pointer', async () => {
    const project = await fixture({ gates: [...brokenBuild] });

    const { stdout } = await runCli(['verify', 'epic-1', '--json'], { cwd: project.root });
    const document = JSON.parse(stdout) as RunDocument;

    const gateEvidence = document.evidence.find(
      (item) => item.kind === 'gate' && item.gateId === 'build',
    );
    expect(gateEvidence).toBeDefined();
    // The output the operator has to read, inline and bounded.
    expect(gateEvidence?.stdout?.text).toContain(FAILING_GATE_STDOUT);

    // Every evidence path is RELATIVE to the run directory (Q48), so a run
    // directory survives being copied between machines. Resolve it and read it.
    const pointer = gateEvidence?.stdout?.fullPath;
    if (pointer !== undefined) {
      expect(isAbsolute(pointer)).toBe(false);
      const full = join(project.root, document.environment.runDirectory, pointer);
      expect(await readFile(full, 'utf8')).toContain(FAILING_GATE_STDOUT);
    }
  });

  it('says which gate failed in the human report too', async () => {
    const project = await fixture({ gates: [...brokenBuild] });

    const { stdout, stderr } = await runCli(['verify', 'epic-1'], { cwd: project.root });

    expect(stdout).toContain("VERDICT: FAIL — gate 'build' failed");
    // A FAIL is not an error: the run succeeded at verifying, and the answer is
    // no. An ERROR:/HINT: pair here would tell an operator SpecWitness broke.
    expect(stderr).not.toContain('ERROR: ');
  });

  it('keeps the FAIL when the result cannot be persisted afterwards', async () => {
    const project = await fixture({
      gates: [
        { id: 'lint', behaviour: 'pass' },
        { id: 'build', behaviour: 'fail-and-lock-run-dir' },
      ],
    });

    const { exitCode, stdout } = await runCli(['verify', 'epic-1', '--json'], {
      cwd: project.root,
    });

    // Once an outcome is decided, nothing after it may replace one. Exit 3 here
    // would tell a harness "the environment is broken, retry" — and the retry
    // merges a branch that does not build.
    expect(exitCode).toBe(1);
    expect(exitCode).not.toBe(3);

    const document = JSON.parse(stdout) as RunDocument;
    expect(document.outcome.verdict).toBe('FAIL');
    expect(document.outcome.gateFailed).toBe('build');
    // The durability failure is not hidden either — it is recorded where a
    // reader would look for it.
    const persist = document.stages.find((stage) => stage.stage === 'persist');
    expect(persist?.status).toBe('error');
  });
});
