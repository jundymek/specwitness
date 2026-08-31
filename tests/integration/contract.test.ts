import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `specwitness contract <epic>` end to end, against the BUILT binary.
 *
 * Every fixture is a fresh temp directory, and every provider call goes through
 * the shipped `fake` adapter — no `claude`, no `codex`, no network. A test that
 * required a real agent CLI would be a test that cannot run in CI or on a
 * colleague's laptop.
 */

const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A valid drafted response, as the fake provider replays it. */
const DRAFT = JSON.stringify({
  criteria: [
    {
      statement: 'Freezing a reviewed contract prints its fingerprint on stdout.',
      kind: 'behavioral',
      severity: 'critical',
      verifiability: 'automated',
    },
    {
      statement: 'A frozen contract is never overwritten by a regeneration.',
      kind: 'invariant',
      severity: 'critical',
      verifiability: 'automated',
    },
  ],
});

const EPICS_FILE = `# Fixture — Epic Breakdown

## Epic 7: Verification Contracts

Capture the definition of done before the cohort starts.

### Story 7.1: Freeze a contract

As an epic owner,
I want to freeze a reviewed contract,
So that it is the authority on what must be true.

**Acceptance Criteria:**

**Given** a reviewed draft
**When** I freeze it
**Then** the fingerprint is printed.
`;

const CONFIG = `version: 1
project:
  baseBranch: master
ai:
  providers:
    hermetic: { adapter: fake, mode: .specwitness/fixtures }
  roles:
    contract-author: hermetic
`;

/** A temp project: scaffolded `.specwitness/`, an epics file, and a fake script. */
async function project(
  options: { readonly script?: readonly string[]; readonly config?: string } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'specwitness-contract-it-'));
  created.push(root);

  await mkdir(join(root, '.specwitness', 'contracts'), { recursive: true });
  await mkdir(join(root, '.specwitness', 'fixtures'), { recursive: true });
  await mkdir(join(root, 'docs', 'planning-artifacts'), { recursive: true });

  await writeFile(join(root, '.specwitness', 'config.yaml'), options.config ?? CONFIG, 'utf8');
  await writeFile(join(root, 'docs', 'planning-artifacts', 'epics.md'), EPICS_FILE, 'utf8');
  await writeFile(
    join(root, '.specwitness', 'fixtures', 'contract-author.json'),
    JSON.stringify(options.script ?? [DRAFT]),
    'utf8',
  );

  return root;
}

/** Runs the built CLI. `input: ''` proves nothing on these paths reads a TTY. */
async function run(cwd: string, ...args: readonly string[]) {
  return await execa('node', [CLI, ...args], { cwd, input: '', reject: false });
}

async function contractText(root: string): Promise<string> {
  return await readFile(join(root, '.specwitness', 'contracts', 'epic-7.yaml'), 'utf8');
}

describe('contract <epic> — AC1 generation', () => {
  it('writes a draft contract and exits 0', async () => {
    const root = await project();

    const result = await run(root, 'contract', '7');

    expect(result.exitCode).toBe(0);
    expect(await contractText(root)).toContain('epic-7');
  });

  it('assigns stable sequential criterion ids', async () => {
    const root = await project();

    await run(root, 'contract', 'epic-7');

    const yaml = await contractText(root);
    expect(yaml).toContain('E7-01');
    expect(yaml).toContain('E7-02');
  });

  it('writes a human-readable, PR-reviewable file', async () => {
    const root = await project();

    await run(root, 'contract', '7');

    const yaml = await contractText(root);
    expect(yaml).toContain('Freezing a reviewed contract prints its fingerprint on stdout.');
    expect(yaml).toContain('frozen: false');
  });

  it('refuses to regenerate over an existing draft without --force', async () => {
    const root = await project();
    await run(root, 'contract', '7');

    const result = await run(root, 'contract', '7');

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('ERROR:');
    expect(result.stderr).toContain('HINT:');
  });

  it('regenerates over a draft when --force is given', async () => {
    const root = await project();
    await run(root, 'contract', '7');

    const result = await run(root, 'contract', '7', '--force');

    expect(result.exitCode).toBe(0);
  });

  it('refuses a malformed epic id with exit 64, before touching anything', async () => {
    const root = await project();

    const result = await run(root, 'contract', 'seven');

    expect(result.exitCode).toBe(64);
    expect(await readdir(join(root, '.specwitness', 'contracts'))).toEqual([]);
  });

  it('refuses when no contract-author role is configured', async () => {
    const root = await project({
      config: 'version: 1\nproject:\n  baseBranch: master\n',
    });

    const result = await run(root, 'contract', '7');

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('contract-author');
  });

  /**
   * A half-written contract is worse than none: it parses as an expectation
   * nobody wrote. The exit code alone would not prove this.
   */
  it('writes NOTHING when the provider gate is exhausted', async () => {
    const root = await project({ script: ['not json', 'still not json', 'nope', 'nope'] });

    const result = await run(root, 'contract', '7');

    expect(result.exitCode).toBe(3);
    expect(await readdir(join(root, '.specwitness', 'contracts'))).toEqual([]);
  });

  it('recovers when a malformed answer is followed by a valid one', async () => {
    const root = await project({ script: ['not json', DRAFT] });

    const result = await run(root, 'contract', '7');

    expect(result.exitCode).toBe(0);
  });

  it('refuses when the project was never initialised, without creating anything', async () => {
    const root = await mkdtemp(join(tmpdir(), 'specwitness-contract-bare-'));
    created.push(root);

    const result = await run(root, 'contract', '7');

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('init');
    await expect(readdir(join(root, '.specwitness'))).rejects.toThrow();
  });
});

describe('contract <epic> --freeze — AC2', () => {
  it('prints the full lowercase-hex fingerprint on stdout', async () => {
    const root = await project();
    await run(root, 'contract', '7');

    const result = await run(root, 'contract', '7', '--freeze');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is idempotent — a second freeze prints the same fingerprint and exits 0', async () => {
    const root = await project();
    await run(root, 'contract', '7');
    const first = await run(root, 'contract', '7', '--freeze');
    const before = await contractText(root);

    const second = await run(root, 'contract', '7', '--freeze');

    expect(second.exitCode).toBe(0);
    expect(second.stdout.trim()).toBe(first.stdout.trim());
    // Re-freezing must not bump the version or rewrite timestamps.
    expect(await contractText(root)).toBe(before);
  });

  it('refuses to freeze when there is no contract', async () => {
    const root = await project();

    const result = await run(root, 'contract', '7', '--freeze');

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('HINT:');
  });
});

describe('contract <epic> — a frozen contract is never overwritten', () => {
  it('refuses regeneration and names the amend flow', async () => {
    const root = await project();
    await run(root, 'contract', '7');
    await run(root, 'contract', '7', '--freeze');

    const result = await run(root, 'contract', '7');

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('--amend');
  });

  /**
   * ADR-005 is a security control, not a UX preference. If --force could
   * overwrite a frozen contract, story 2.7's TTY-gated --amend would be
   * decorative: an agent would simply pass --force.
   */
  it('refuses IDENTICALLY with --force, leaving the file byte-for-byte unchanged', async () => {
    const root = await project();
    await run(root, 'contract', '7');
    await run(root, 'contract', '7', '--freeze');
    const frozen = await contractText(root);

    const plain = await run(root, 'contract', '7');
    const forced = await run(root, 'contract', '7', '--force');

    expect(forced.exitCode).toBe(plain.exitCode);
    expect(forced.stderr).toBe(plain.stderr);
    expect(await contractText(root)).toBe(frozen);
  });
});

describe('contract <epic> --status — AC3', () => {
  it('reports an absent contract as exit 0 with valid JSON', async () => {
    const root = await project();

    const result = await run(root, 'contract', '7', '--status', '--json');

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      epic: 'epic-7',
      path: '.specwitness/contracts/epic-7.yaml',
      state: 'absent',
      integrity: 'not-applicable',
      version: null,
      fingerprint: null,
      criteriaCount: null,
      frozenAt: null,
    });
  });

  it('puts the JSON document and NOTHING else on stdout', async () => {
    const root = await project();
    await run(root, 'contract', '7');

    const result = await run(root, 'contract', '7', '--status', '--json');

    // A stray console.log would break `jq`; the harness parses this.
    expect(() => JSON.parse(result.stdout) as unknown).not.toThrow();
    expect(result.stdout.trimEnd().endsWith('}')).toBe(true);
    expect(result.stdout.trimStart().startsWith('{')).toBe(true);
  });

  it('sends the human rendering to stderr in --json mode', async () => {
    const root = await project();
    await run(root, 'contract', '7');

    const result = await run(root, 'contract', '7', '--status', '--json');

    expect(result.stderr).toContain('epic-7');
  });

  it('reports a draft with its criteria count and no fingerprint', async () => {
    const root = await project();
    await run(root, 'contract', '7');

    const result = await run(root, 'contract', '7', '--status', '--json');
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(payload.state).toBe('draft');
    expect(payload.integrity).toBe('not-frozen');
    expect(payload.version).toBe(1);
    expect(payload.criteriaCount).toBe(2);
    expect(payload.fingerprint).toBeNull();
  });

  it('reports a frozen contract with its fingerprint', async () => {
    const root = await project();
    await run(root, 'contract', '7');
    const frozen = await run(root, 'contract', '7', '--freeze');

    const result = await run(root, 'contract', '7', '--status', '--json');
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(payload.state).toBe('frozen');
    expect(payload.integrity).toBe('ok');
    expect(payload.fingerprint).toBe(frozen.stdout.trim());
  });

  it('runs prompt-free with no TTY', async () => {
    const root = await project();

    const result = await run(root, 'contract', '7', '--status');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toContain('no contract');
  });
});

describe('contract <epic> — a tampered contract', () => {
  /** Editing a frozen contract by hand, which is what tampering looks like. */
  async function tamper(root: string): Promise<void> {
    const path = join(root, '.specwitness', 'contracts', 'epic-7.yaml');
    const yaml = await readFile(path, 'utf8');
    await writeFile(
      path,
      yaml.replace(
        'Freezing a reviewed contract prints its fingerprint on stdout.',
        'Freezing prints something, probably.',
      ),
      'utf8',
    );
  }

  it('is reported by --status as a field, exit 0 — status answered the question', async () => {
    const root = await project();
    await run(root, 'contract', '7');
    await run(root, 'contract', '7', '--freeze');
    await tamper(root);

    const result = await run(root, 'contract', '7', '--status', '--json');
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(result.exitCode).toBe(0);
    expect(payload.state).toBe('tampered');
    expect(payload.integrity).toBe('mismatch');
  });

  it('refuses a re-freeze with exit 3 and an ERROR/HINT pair', async () => {
    const root = await project();
    await run(root, 'contract', '7');
    await run(root, 'contract', '7', '--freeze');
    await tamper(root);

    const result = await run(root, 'contract', '7', '--freeze');

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('ERROR:');
    expect(result.stderr).toContain('HINT:');
  });

  it('exits 3 on a file that cannot be parsed at all', async () => {
    const root = await project();
    await writeFile(
      join(root, '.specwitness', 'contracts', 'epic-7.yaml'),
      'this: is not: valid: yaml: at all\n',
      'utf8',
    );

    const result = await run(root, 'contract', '7', '--status', '--json');

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('ERROR:');
  });
});
