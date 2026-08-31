import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runContract } from '../../../src/cli/commands/contract.js';
import { ConfigError, IntegrityError, UsageError } from '../../../src/domain/errors.js';
import { FixedClock } from '../../fakes/ports.js';

/**
 * The command body driven directly, with an injected `Clock` and a real temp
 * project — no subprocess, no wall clock, no `claude`/`codex`.
 *
 * This complements `tests/integration/contract.test.ts` rather than repeating
 * it: the integration suite proves the BUILT binary behaves (exit codes, stream
 * separation as a shell sees them), while these prove the branch logic and let
 * a frozen instant make timestamps exact rather than merely present.
 */

const INSTANT = '2026-08-31T06:12:41.000Z';

const DRAFT = JSON.stringify({
  criteria: [
    {
      statement: 'Freezing prints the fingerprint.',
      kind: 'behavioral',
      severity: 'critical',
      verifiability: 'automated',
    },
  ],
});

const EPICS_FILE = `# Fixture

## Epic 7: Verification Contracts

Capture the definition of done before the cohort starts.

### Story 7.1: Freeze a contract

As an epic owner,
I want to freeze a reviewed contract,
So that it is authoritative.

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

const created: string[] = [];
let cwd: string;

async function project(
  options: { readonly script?: readonly string[]; readonly config?: string } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'specwitness-contract-unit-'));
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

/** The command reads `process.cwd()`; point it at the fixture, not the repo. */
function chdir(root: string): void {
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  cwd = root;
}

let stdout: string[];
let stderr: string[];

beforeEach(() => {
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const clock = (): FixedClock => new FixedClock(INSTANT);

async function contractYaml(): Promise<string> {
  return await readFile(join(cwd, '.specwitness', 'contracts', 'epic-7.yaml'), 'utf8');
}

describe('runContract — generation', () => {
  it('writes a draft and reports where it went', async () => {
    chdir(await project());

    await runContract('7', {}, clock());

    expect(await contractYaml()).toContain('E7-01');
    expect(stdout.join('')).toContain('.specwitness/contracts/epic-7.yaml');
  });

  it('stamps createdAt from the injected clock, not the wall clock', async () => {
    chdir(await project());

    await runContract('7', {}, clock());

    expect(await contractYaml()).toContain(INSTANT);
  });

  it('rejects a malformed epic id as a usage error before any I/O', async () => {
    chdir(await project());

    await expect(runContract('seven', {}, clock())).rejects.toThrow(UsageError);
    expect(await readdir(join(cwd, '.specwitness', 'contracts'))).toEqual([]);
  });

  it('refuses an existing draft without --force', async () => {
    chdir(await project());
    await runContract('7', {}, clock());

    await expect(runContract('7', {}, clock())).rejects.toThrow(IntegrityError);
  });

  it('replaces an existing draft with --force', async () => {
    chdir(await project());
    await runContract('7', {}, clock());

    await expect(runContract('7', { force: true }, clock())).resolves.toBeUndefined();
  });

  it('refuses when no contract-author role is assigned', async () => {
    chdir(await project({ config: 'version: 1\nproject:\n  baseBranch: master\n' }));

    await expect(runContract('7', {}, clock())).rejects.toThrow(ConfigError);
  });

  it('writes nothing when the provider gate is exhausted', async () => {
    chdir(await project({ script: ['nope', 'nope', 'nope', 'nope'] }));

    await expect(runContract('7', {}, clock())).rejects.toThrow();
    expect(await readdir(join(cwd, '.specwitness', 'contracts'))).toEqual([]);
  });

  it('prints coupling advice on stdout when a statement names implementation', async () => {
    const coupled = JSON.stringify({
      criteria: [
        {
          statement: 'The freeze() function stores the fingerprint.',
          kind: 'behavioral',
          severity: 'normal',
          verifiability: 'automated',
        },
      ],
    });
    chdir(await project({ script: [coupled] }));

    await runContract('7', {}, clock());

    expect(stdout.join('')).toContain('E7-01');
    expect(stdout.join('')).toContain('freeze()');
  });
});

describe('runContract — freeze', () => {
  it('prints the full fingerprint on stdout and the summary on stderr', async () => {
    chdir(await project());
    await runContract('7', {}, clock());
    stdout.length = 0;

    await runContract('7', { freeze: true }, clock());

    expect(stdout.join('').trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(stderr.join('')).toContain('Froze');
  });

  it('is idempotent and leaves the file byte-for-byte unchanged', async () => {
    chdir(await project());
    await runContract('7', {}, clock());
    await runContract('7', { freeze: true }, clock());
    const frozen = await contractYaml();
    stdout.length = 0;

    await runContract('7', { freeze: true }, clock());

    expect(await contractYaml()).toBe(frozen);
    expect(stdout.join('').trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses when there is no contract to freeze', async () => {
    chdir(await project());

    await expect(runContract('7', { freeze: true }, clock())).rejects.toThrow(IntegrityError);
  });

  /**
   * Story 2.7's amend leaves a valid DRAFT carrying history, and the operator
   * then freezes it. That draft must take the ordinary freeze path — no special
   * case, no "history must be empty" assumption. This test lives here rather
   * than in 2.7 so a later refactor of THIS freeze path cannot break their flow
   * silently.
   */
  it('freezes a draft carrying amendment history, with no special case', async () => {
    chdir(await project());
    await runContract('7', {}, clock());

    const path = join(cwd, '.specwitness', 'contracts', 'epic-7.yaml');
    const yaml = await readFile(path, 'utf8');
    await writeFile(
      path,
      yaml
        .replace('  version: 1', '  version: 2')
        .replace(
          '  history: []',
          '  history:\n' +
            '    - version: 1\n' +
            `      fingerprint: ${'a'.repeat(64)}\n` +
            `      timestamp: ${INSTANT}\n` +
            '      reason: widened the acceptance criteria',
        ),
      'utf8',
    );
    stdout.length = 0;

    await runContract('7', { freeze: true }, clock());

    const frozen = await contractYaml();
    expect(stdout.join('').trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(frozen).toContain('version: 2');
    expect(frozen).toContain('widened the acceptance criteria');
    expect(frozen).toContain('frozen: true');
  });
});

describe('runContract — status', () => {
  it('reports an absent contract without failing', async () => {
    chdir(await project());

    await runContract('7', { status: true }, clock());

    expect(stdout.join('').toLowerCase()).toContain('no contract');
  });

  it('puts JSON on stdout and the human rendering on stderr', async () => {
    chdir(await project());
    await runContract('7', {}, clock());
    stdout.length = 0;
    stderr.length = 0;

    await runContract('7', { status: true, json: true }, clock());

    expect(JSON.parse(stdout.join(''))).toMatchObject({ state: 'draft', integrity: 'not-frozen' });
    expect(stderr.join('')).toContain('epic-7');
  });

  it('never prompts — no path here reads stdin', async () => {
    chdir(await project());

    // A read of stdin in a no-TTY context would hang the test rather than fail
    // it, so the assertion is simply that it completes.
    await expect(runContract('7', { status: true }, clock())).resolves.toBeUndefined();
  });
});

describe('runContract — project not initialised', () => {
  it('refuses and never creates the project directory', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'specwitness-contract-bare-unit-'));
    created.push(bare);
    chdir(bare);

    await expect(runContract('7', { status: true }, clock())).rejects.toThrow();
    await expect(readdir(join(bare, '.specwitness'))).rejects.toThrow();
  });
});

describe('runContract — option combinations are checked, not silently resolved', () => {
  /**
   * Found by Codex review. Each of these used to "work" by quietly ignoring
   * part of what the operator asked for, and the first is the dangerous one:
   * an invocation that reads like a query performed a MUTATION.
   */
  it('refuses --json without --status instead of generating a draft', async () => {
    chdir(await project());

    await expect(runContract('7', { json: true }, clock())).rejects.toThrow(UsageError);
    // The point of the refusal: nothing was written.
    expect(await readdir(join(cwd, '.specwitness', 'contracts'))).toEqual([]);
  });

  it('refuses --status together with --freeze rather than silently picking one', async () => {
    chdir(await project());

    await expect(runContract('7', { status: true, freeze: true }, clock())).rejects.toThrow(
      UsageError,
    );
  });

  it('refuses --force with --status, which would silently ignore it', async () => {
    chdir(await project());

    await expect(runContract('7', { status: true, force: true }, clock())).rejects.toThrow(
      UsageError,
    );
  });

  /**
   * --force with --freeze is the most misleading of the set: an operator
   * freezing a tampered contract may well believe --force will override the
   * refusal. Silently ignoring it would leave them thinking they forced
   * something. It never overrides a frozen or tampered contract (ADR-005).
   */
  it('refuses --force with --freeze rather than letting it look effective', async () => {
    chdir(await project());

    await expect(runContract('7', { freeze: true, force: true }, clock())).rejects.toThrow(
      UsageError,
    );
  });

  it('still accepts the three documented invocations', async () => {
    chdir(await project());

    await expect(runContract('7', {}, clock())).resolves.toBeUndefined();
    await expect(runContract('7', { freeze: true }, clock())).resolves.toBeUndefined();
    await expect(runContract('7', { status: true, json: true }, clock())).resolves.toBeUndefined();
  });

  it('accepts --force with plain generation, which is where it applies', async () => {
    chdir(await project());
    await runContract('7', {}, clock());

    await expect(runContract('7', { force: true }, clock())).resolves.toBeUndefined();
  });
});
