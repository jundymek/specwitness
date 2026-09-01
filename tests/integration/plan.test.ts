import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `specwitness plan <epic>` end to end, against the BUILT binary — and the epic's security
 * exit criterion.
 *
 * Every fixture is a fresh temp directory and every provider call goes through the shipped
 * `fake` adapter reading fixtures from `tests/fixtures/providers/**` — no `claude`, no
 * `codex`, no network (AD-12). The malicious cases drive the REAL gate: nothing here
 * hand-calls a validator, because the property that has to be proven is "this specific
 * attack fails through the path a real provider would take", not "strict objects reject
 * unknown keys".
 *
 * `input: ''` on every invocation is the prompt-free assertion: a command that read a TTY
 * would hang rather than pass.
 */

const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../fixtures/providers', import.meta.url));

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * The contract every plan in this file is compiled from.
 *
 * Written directly rather than generated through `specwitness contract`, because a
 * fingerprint this file did not compute is a fingerprint it cannot assert on — the file
 * below is frozen through the real `contract --freeze`, so the hash is always the product's
 * own.
 */
const CONTRACT_DRAFT = JSON.stringify({
  criteria: [
    {
      statement: 'GET /health responds 200 with a JSON body whose "status" field is "ok".',
      kind: 'behavioral',
      severity: 'critical',
      verifiability: 'automated',
    },
    {
      statement: 'The dashboard reads as a coherent page to a first-time visitor.',
      kind: 'human',
      severity: 'normal',
      verifiability: 'human',
    },
    {
      statement: 'The repository typechecks with no errors.',
      kind: 'structural',
      severity: 'normal',
      verifiability: 'automated',
    },
  ],
});

const EPICS_FILE = `# Fixture — Epic Breakdown

## Epic 7: Behavioral Verification

Prove the assembled epic behaves as specified.

### Story 7.1: Health and typecheck

As an operator,
I want the service and the repository checked,
So that I know the branch is sound.

**Acceptance Criteria:**

**Given** a running service
**When** I request /health
**Then** it answers 200.
`;

/** `planMode` points the plan-author role at one of the fixture directories. */
function config(planMode: string): string {
  return `version: 1
project:
  baseBranch: master
services:
  backend:
    run: node server.js
    port: 8080
    ready:
      url: http://127.0.0.1:8080/health
observations:
  typecheck:
    run: pnpm typecheck
  company-count:
    run: ./scripts/company-count.sh
ai:
  providers:
    contracts: { adapter: fake, mode: .specwitness/fixtures }
    planner: { adapter: fake, mode: ${planMode} }
  roles:
    contract-author: contracts
    plan-author: planner
`;
}

/** Runs the built CLI. `input: ''` proves nothing on these paths reads a TTY. */
async function run(cwd: string, ...args: readonly string[]) {
  return await execa('node', [CLI, ...args], { cwd, input: '', reject: false });
}

/**
 * A temp project with a FROZEN epic-7 contract and the plan-author pointed at `fixture`.
 *
 * The contract is generated and frozen through the real commands, so the fingerprint the
 * plan records is one the product computed rather than one this test pasted.
 */
async function project(fixture: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'specwitness-plan-it-'));
  created.push(root);

  await mkdir(join(root, '.specwitness', 'contracts'), { recursive: true });
  await mkdir(join(root, '.specwitness', 'plans'), { recursive: true });
  await mkdir(join(root, '.specwitness', 'fixtures'), { recursive: true });
  await mkdir(join(root, 'docs', 'planning-artifacts'), { recursive: true });

  await writeFile(join(root, '.specwitness', 'config.yaml'), config(fixture), 'utf8');
  await writeFile(join(root, 'docs', 'planning-artifacts', 'epics.md'), EPICS_FILE, 'utf8');
  await writeFile(
    join(root, '.specwitness', 'fixtures', 'contract-author.json'),
    JSON.stringify([CONTRACT_DRAFT]),
    'utf8',
  );

  await run(root, 'contract', '7');
  await run(root, 'contract', '7', '--freeze');

  return root;
}

const VALID = join(FIXTURES, 'plan', 'valid');
const RETRY = join(FIXTURES, 'plan', 'retry-then-valid');
const malicious = (name: string): string => join(FIXTURES, 'malicious-plan', name);

async function planText(root: string): Promise<string> {
  return await readFile(join(root, '.specwitness', 'plans', 'epic-7.yaml'), 'utf8');
}

async function plansDir(root: string): Promise<string[]> {
  return await readdir(join(root, '.specwitness', 'plans'));
}

describe('plan <epic> — AC1 compilation', () => {
  it('writes .specwitness/plans/epic-7.yaml and exits 0', async () => {
    const root = await project(VALID);

    const result = await run(root, 'plan', '7');

    expect(result.exitCode).toBe(0);
    expect(await plansDir(root)).toEqual(['epic-7.yaml']);
  });

  it('references the contract version and fingerprint', async () => {
    const root = await project(VALID);
    await run(root, 'plan', '7');

    const contract = await readFile(
      join(root, '.specwitness', 'contracts', 'epic-7.yaml'),
      'utf8',
    );
    const fingerprint = /fingerprint: ([0-9a-f]{64})/.exec(contract)?.[1];
    const plan = await planText(root);

    expect(fingerprint).toBeDefined();
    expect(plan).toContain(`fingerprint: ${fingerprint as string}`);
    expect(plan).toContain('version: 1');
  });

  it('references criteria by id and embeds no criterion statement (AD-5)', async () => {
    const root = await project(VALID);
    await run(root, 'plan', '7');

    const plan = await planText(root);

    expect(plan).toContain('criterionId: E7-01');
    expect(plan).toContain('criterionId: E7-02');
    expect(plan).toContain('criterionId: E7-03');
    expect(plan).not.toContain('GET /health responds 200');
    expect(plan).not.toContain('statement:');
  });

  it('carries the human criterion as needs-human with guidance and no probe', async () => {
    const root = await project(VALID);
    await run(root, 'plan', '7');

    const plan = await planText(root);
    const human = plan.slice(plan.indexOf('criterionId: E7-02'), plan.indexOf('criterionId: E7-03'));

    expect(human).toContain('disposition: needs-human');
    expect(human).toContain('reason: human-verifiability');
    expect(human).toContain('guidance:');
    expect(human).not.toContain('probes:');
  });

  it('records provenance with an honest null model', async () => {
    const root = await project(VALID);
    await run(root, 'plan', '7');

    const plan = await planText(root);

    // The `fake` adapter has no CLI behind it, so there is no version to report. A guessed
    // value in an audit field is worse than an honest null.
    expect(plan).toContain('provider: planner');
    expect(plan).toContain('model: null');
    expect(plan).toContain('providerCliVersion: null');
  });

  it('AC4 spot-check: the obviously-HTTP criterion compiles to an http probe', async () => {
    const root = await project(VALID);
    await run(root, 'plan', '7');

    const plan = await planText(root);
    const first = plan.slice(plan.indexOf('criterionId: E7-01'), plan.indexOf('criterionId: E7-02'));

    expect(first).toContain('surface: http');
    expect(first).not.toContain('surface: browser');
  });

  it('prints a bounded summary naming the file', async () => {
    const root = await project(VALID);

    const result = await run(root, 'plan', '7');

    expect(result.stdout).toContain('.specwitness/plans/epic-7.yaml');
    expect(result.stdout).toContain('3 criteria');
    expect(result.stdout).toContain('1 needing human review');
  });

  it('drives the real retry loop and succeeds on attempt 2', async () => {
    const root = await project(RETRY);

    const result = await run(root, 'plan', '7');

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('2 provider attempts');
    expect(await plansDir(root)).toEqual(['epic-7.yaml']);
  });
});

describe('plan <epic> — refusals', () => {
  it('refuses a malformed epic id with exit 64, before touching anything', async () => {
    const root = await project(VALID);

    const result = await run(root, 'plan', 'seven');

    expect(result.exitCode).toBe(64);
    expect(await plansDir(root)).toEqual([]);
  });

  it('refuses a never-frozen contract, without spending a provider call', async () => {
    const root = await project(VALID);
    await rm(join(root, '.specwitness', 'contracts', 'epic-7.yaml'));
    await run(root, 'contract', '7');

    const result = await run(root, 'plan', '7');

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('never been frozen');
    expect(result.stderr).toContain('--freeze');
    expect(await plansDir(root)).toEqual([]);
  });

  it('refuses when there is no contract at all', async () => {
    const root = await project(VALID);
    await rm(join(root, '.specwitness', 'contracts', 'epic-7.yaml'));

    const result = await run(root, 'plan', '7');

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('ERROR:');
    expect(result.stderr).toContain('HINT:');
  });

  it('refuses when no plan-author role is configured', async () => {
    const root = await project(VALID);
    const stripped = config(VALID).replace('    plan-author: planner\n', '');
    await writeFile(join(root, '.specwitness', 'config.yaml'), stripped, 'utf8');

    const result = await run(root, 'plan', '7');

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('plan-author');
  });

  it('refuses to recompile a plan that already matches the frozen contract', async () => {
    const root = await project(VALID);
    await run(root, 'plan', '7');
    const before = await planText(root);

    const result = await run(root, 'plan', '7');

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('already matches the frozen contract');
    expect(result.stderr).toContain('--force');
    expect(await planText(root)).toBe(before);
  });

  it('recompiles a matching plan when --force is given', async () => {
    const root = await project(VALID);
    await run(root, 'plan', '7');

    const result = await run(root, 'plan', '7', '--force');

    expect(result.exitCode).toBe(0);
  });

  it('recompiles a STALE plan with no flag — that is the remedy verify prescribes', async () => {
    const root = await project(VALID);
    await run(root, 'plan', '7');

    // Amend the contract so its fingerprint changes, then re-freeze it.
    const path = join(root, '.specwitness', 'contracts', 'epic-7.yaml');
    const contract = await readFile(path, 'utf8');
    await writeFile(
      path,
      contract
        .replace('The repository typechecks with no errors.', 'The repository typechecks cleanly.')
        .replace(/fingerprint: [0-9a-f]{64}/, 'fingerprint: null')
        .replace('frozen: true', 'frozen: false')
        .replace(/frozenAt: \S+/, 'frozenAt: null'),
      'utf8',
    );
    await run(root, 'contract', '7', '--freeze');

    const result = await run(root, 'plan', '7');

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('--force');
  });

  /**
   * The plan's id pattern is stricter than the config's key type, deliberately — it is what
   * stops a command line being smuggled through `commandId`. A project may therefore declare
   * a key no plan can name. The bad outcome is not the restriction; it is DISCOVERING it by
   * watching the provider burn its whole retry budget on a probe the gate will reject.
   *
   * Raised by story 4.1's agent at cohort intent-sync and again by the Codex review pass.
   */
  it('warns by name about a declared key no plan could reference, and still compiles', async () => {
    const root = await project(VALID);
    await writeFile(
      join(root, '.specwitness', 'config.yaml'),
      config(VALID).replace(
        'observations:\n',
        'observations:\n  scripts/company count:\n    run: ./scripts/count.sh\n',
      ),
      'utf8',
    );

    const result = await run(root, 'plan', '7');

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('scripts/company count');
    expect(result.stderr).toContain('cannot be referenced from a plan');
    // The compilation still succeeds: the unusable key is withheld from the prompt rather
    // than turned into a refusal, because the rest of the contract is still plannable.
    expect(await plansDir(root)).toEqual(['epic-7.yaml']);
  });

  /**
   * A plan file whose own `epic:` says something else is a MISPLACED file, not a stale one.
   * The staleness refusal says so in as many words — "recompiling will not reconcile two
   * different epics" — so recompiling over it without asking would contradict our own error
   * message and destroy the evidence of whatever went wrong.
   *
   * Only a FINGERPRINT mismatch bypasses the overwrite guard. Raised by the fourth Codex
   * review pass.
   */
  it('refuses to overwrite a plan that identifies a different epic', async () => {
    const root = await project(VALID);
    await run(root, 'plan', '7');
    const path = join(root, '.specwitness', 'plans', 'epic-7.yaml');
    // The criterion ids move with the epic: a file that merely renamed the epic line would be
    // rejected as unparseable (E7-01 does not belong to epic-9), and would then pass this
    // test for the wrong reason. This is a genuinely MISPLACED plan — internally coherent,
    // just not this epic's.
    const misplaced = (await readFile(path, 'utf8'))
      .replace('epic: epic-7', 'epic: epic-9')
      .replaceAll('E7-0', 'E9-0');
    await writeFile(path, misplaced, 'utf8');

    const result = await run(root, 'plan', '7');

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('epic-9');
    expect(result.stderr).toContain('--force');
    expect(await readFile(path, 'utf8')).toBe(misplaced);
  });

  /**
   * Likewise a plan whose fingerprint still matches but whose criteria no longer cover the
   * contract: it is damaged rather than stale, so the operator is asked before it is
   * replaced.
   */
  it('refuses to overwrite a plan that no longer covers the contract', async () => {
    const root = await project(VALID);
    await run(root, 'plan', '7');
    const path = join(root, '.specwitness', 'plans', 'epic-7.yaml');
    const full = await readFile(path, 'utf8');
    const truncated = full.slice(0, full.indexOf('    - criterionId: E7-03')) +
      full.slice(full.indexOf('meta:'));
    await writeFile(path, truncated, 'utf8');

    const result = await run(root, 'plan', '7');

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('--force');
    expect(await readFile(path, 'utf8')).toBe(truncated);
  });

  it('refuses in a project that was never initialised', async () => {
    const root = await mkdtemp(join(tmpdir(), 'specwitness-plan-bare-'));
    created.push(root);

    const result = await run(root, 'plan', '7');

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('specwitness init');
  });
});

/**
 * AC2 — the epic's security exit criterion.
 *
 * Each case drives a hostile draft through the shipped fake adapter and the REAL AD-2 gate.
 * Two things are asserted every time: the compilation is refused, and **nothing was written
 * to `.specwitness/plans/`** (FR-14's "never a partial artifact", which the type system
 * already enforces by putting `parsed` only on the `ok: true` arm — this proves it end to
 * end).
 *
 * Exit 3, never exit 1: a provider that cannot draft a valid plan has not proved the epic
 * wrong. Reporting a hostile draft as a product FAIL would be a defect of the first order.
 */
describe('plan <epic> — AC2: a malicious plan-author is rejected at the schema gate', () => {
  const CASES: readonly (readonly [string, string])[] = [
    ['an inline shell command string on a shell probe', 'inline-shell-string'],
    ['a command string smuggled into an http probe', 'command-string-in-http'],
    ['a command line smuggled through a config id', 'command-line-as-command-id'],
    ['an argument outside the probe’s own allowlist', 'argument-outside-allowlist'],
    ['an assertion-free probe', 'assertion-free-probe'],
    ['a probe attached to a human criterion', 'probe-on-human-criterion'],
    ['a human criterion mislabelled not-safely-automatable', 'human-criterion-mislabelled'],
    ['a contract criterion silently dropped', 'dropped-criterion'],
    ['an absolute URL pointing at production', 'absolute-url'],
    ['a protocol-relative URL, which resolves to another host', 'protocol-relative-url'],
    ['a CRLF header injection', 'header-injection'],
    ['a service the project never declared', 'undeclared-service'],
    ['a command the project never declared', 'undeclared-command'],
    ['a criterion belonging to another epic', 'criterion-from-another-epic'],
  ];

  it.each(CASES)('rejects %s, writing nothing', async (_description, fixture) => {
    const root = await project(malicious(fixture));

    const result = await run(root, 'plan', '7');

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('ERROR:');
    expect(result.stderr).toContain('HINT:');
    expect(await plansDir(root)).toEqual([]);
  });

  it('classifies every rejection as a provider failure, never a product FAIL', async () => {
    const root = await project(malicious('inline-shell-string'));

    const result = await run(root, 'plan', '7');

    expect(result.exitCode).toBe(3);
    expect(result.exitCode).not.toBe(1);
    expect(result.stderr).toContain('no artifact was written');
  });

  /**
   * A DROPPED CRITERION MUST BE CAUGHT BY THE GATE, not by a floor further downstream.
   *
   * The "writing nothing" case above passes either way: `compilePlan` has a fail-closed
   * floor that throws if an accepted draft is missing a criterion, and exit 3 looks the
   * same from outside. What only the gate-level check can produce is THIS — the drop
   * reported as a validation error, fed back into the next attempt's prompt (FR-14), and
   * the second attempt succeeding. A floor would have aborted the run instead.
   *
   * Verified red against a mutant that deletes the coverage rule from the draft schema.
   */
  it('reports a dropped criterion to the gate, so the provider can correct it', async () => {
    const root = await project(join(FIXTURES, 'plan', 'dropped-then-valid'));

    const result = await run(root, 'plan', '7');

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('2 provider attempts');
    expect(await planText(root)).toContain('criterionId: E7-03');
  });

  it('spends the whole retry budget and reports every attempt', async () => {
    const root = await project(malicious('assertion-free-probe'));

    const result = await run(root, 'plan', '7');

    // 1 initial call + 2 retries. Recorded so the subscription cost is visible.
    expect(result.stderr).toContain('after 3 attempts');
  });

  /**
   * THE HONEST BOUNDARY — this case is ACCEPTED, and saying so is the point.
   *
   * A schema can prove a plan is well-formed. It cannot prove an expectation is strong:
   * `expected: "200"` with `equals` and `expected: "999"` with `notEquals` are equally
   * valid documents, and the second passes against almost any response. Only a human
   * reading the committed plan (Q11) or the criterion later failing against a defective
   * build distinguishes them.
   *
   * Asserting the acceptance rather than omitting the case is deliberate: a suite that
   * silently skipped it would read as though the schema covered this class of mutation.
   */
  it('does NOT catch a trivially-true expectation — a schema structurally cannot', async () => {
    const root = await project(malicious('trivially-true-expectation'));

    const result = await run(root, 'plan', '7');

    expect(result.exitCode).toBe(0);
    expect(await planText(root)).toContain('comparison: notEquals');
  });
});
