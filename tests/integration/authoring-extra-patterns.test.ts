/**
 * Story 7.4 — `specwitness contract` and `specwitness plan` send a provider no text a declared
 * extra pattern matches (AC2's authoring path).
 *
 * Both are STANDALONE EDGES: each loads the config and reaches a provider without `verify`, so
 * wiring `verify` alone would have left both still sending a project's own secret shape to the
 * provider. That is why they are tested separately, through the built binary.
 *
 * The prompt is observed from the outside: the provider is the shipped `claude-code-cli` adapter,
 * and `claude` on the child's PATH is a shim that RECORDS its argv and stdin (it never runs the
 * real CLI and reads nothing under `~/.claude/`). The shim answers `{"ok":true}`, which is not a
 * valid draft, so the command ends in the provider gate's refusal, exit 3 — after the prompt this
 * test inspects has been sent. Nothing is written, which the product guarantees separately.
 *
 * Each case has a CONTROL: without the pattern declared, the recorded prompt must carry the
 * secret — proof that it reaches the prompt at all and that the built-ins do not match it.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

import { writeClaudeShim, type ShimHandle } from '../fixtures/bin/claude-shim.js';
import { hermeticHomeEnv } from './helpers/hermetic-home.js';

const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

/** Matches no built-in rule: no assignment name, no header, no vendor shape. */
const SECRET = 'wombat-7x3k9q2m4p';
const PATTERN_BLOCK = "redaction:\n  extraPatterns:\n    - 'wombat-[a-z0-9]+'\n";

const created: string[] = [];
const shims: ShimHandle[] = [];

afterEach(async () => {
  await Promise.all(shims.splice(0).map(async (shim) => await shim.cleanup()));
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const EPICS_FILE = `# Fixture — Epic Breakdown

## Epic 7: Release handles

Every build is issued a release handle, for example ${SECRET}, before it ships.

### Story 7.1: Issue a handle

As an operator,
I want every build to carry its release handle,
So that I can trace a deployment back to its build.

**Acceptance Criteria:**

**Given** a completed build
**When** it is packaged
**Then** the package records handle ${SECRET}.
`;

/** A contract the fake provider drafts, carrying the secret in a criterion statement. */
const CONTRACT_DRAFT = JSON.stringify({
  criteria: [
    {
      statement: `The package records its release handle, as in ${SECRET}.`,
      kind: 'behavioral',
      severity: 'critical',
      verifiability: 'automated',
    },
  ],
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

async function run(cwd: string, shim: ShimHandle, home: string, ...args: readonly string[]) {
  return await execa('node', [CLI, ...args], {
    cwd,
    input: '',
    reject: false,
    env: { ...hermeticHomeEnv(home), PATH: `${shim.dir}:${process.env.PATH ?? ''}` },
  });
}

/** Everything the shim was asked to DRAFT with — not the version and capability probes. */
async function draftingPrompts(shim: ShimHandle): Promise<string> {
  const invocations = await shim.invocations();
  const drafting = invocations.filter(
    (invocation) =>
      !invocation.argv.includes('--version') &&
      !invocation.argv.includes('Reply with the single word: ok'),
  );
  expect(drafting.length, 'the provider must have been asked to draft').toBeGreaterThan(0);
  return drafting.map((invocation) => [...invocation.argv, invocation.stdin ?? ''].join('\n')).join('\n');
}

async function contractPrompt(declare: boolean): Promise<string> {
  const root = await tempDir('specwitness-7-4-contract-');
  const home = await tempDir('specwitness-7-4-home-');
  const shim = await writeClaudeShim('capable', { recordStdin: true });
  shims.push(shim);

  await mkdir(join(root, '.specwitness', 'contracts'), { recursive: true });
  await mkdir(join(root, 'docs', 'planning-artifacts'), { recursive: true });
  await writeFile(join(root, 'docs', 'planning-artifacts', 'epics.md'), EPICS_FILE, 'utf8');
  await writeFile(
    join(root, '.specwitness', 'config.yaml'),
    'version: 1\nproject:\n  baseBranch: master\nai:\n  providers:\n' +
      '    claude: { adapter: claude-code-cli, mode: subscription }\n' +
      '  roles:\n    contract-author: claude\n' +
      (declare ? PATTERN_BLOCK : ''),
    'utf8',
  );

  const result = await run(root, shim, home, 'contract', '7');
  // The shim's answer is not a draft, so the gate refuses after its retries: exit 3, never 1.
  expect(result.exitCode, result.stderr).toBe(3);
  expect(result.stderr).not.toContain(SECRET);
  return await draftingPrompts(shim);
}

async function planPrompt(declare: boolean): Promise<string> {
  const root = await tempDir('specwitness-7-4-plan-');
  const home = await tempDir('specwitness-7-4-home-');
  const shim = await writeClaudeShim('capable', { recordStdin: true });
  shims.push(shim);

  await mkdir(join(root, '.specwitness', 'contracts'), { recursive: true });
  await mkdir(join(root, '.specwitness', 'plans'), { recursive: true });
  await mkdir(join(root, '.specwitness', 'fixtures'), { recursive: true });
  await mkdir(join(root, 'docs', 'planning-artifacts'), { recursive: true });
  await writeFile(join(root, 'docs', 'planning-artifacts', 'epics.md'), EPICS_FILE, 'utf8');
  await writeFile(
    join(root, '.specwitness', 'fixtures', 'contract-author.json'),
    JSON.stringify([CONTRACT_DRAFT]),
    'utf8',
  );

  const configBody =
    'version: 1\nproject:\n  baseBranch: master\nai:\n  providers:\n' +
    '    contracts: { adapter: fake, mode: .specwitness/fixtures }\n' +
    '    claude: { adapter: claude-code-cli, mode: subscription }\n' +
    '  roles:\n    contract-author: contracts\n    plan-author: claude\n';

  // The contract is drafted and frozen with NO pattern declared, so its statement really does
  // carry the secret. Only then is the pattern added — isolating the `plan` edge.
  await writeFile(join(root, '.specwitness', 'config.yaml'), configBody, 'utf8');
  expect((await run(root, shim, home, 'contract', '7')).exitCode).toBe(0);
  expect((await run(root, shim, home, 'contract', '7', '--freeze')).exitCode).toBe(0);
  await writeFile(
    join(root, '.specwitness', 'config.yaml'),
    configBody + (declare ? PATTERN_BLOCK : ''),
    'utf8',
  );

  const result = await run(root, shim, home, 'plan', '7');
  expect(result.exitCode, result.stderr).toBe(3);
  expect(result.stderr).not.toContain(SECRET);
  return await draftingPrompts(shim);
}

describe('story 7.4 — the authoring edges apply the declared patterns to the prompt', () => {
  it('specwitness contract: the epic text reaches the prompt on the built-ins, and is ABSENT with the pattern', async () => {
    expect(await contractPrompt(false), 'control').toContain(SECRET);
    expect(await contractPrompt(true)).not.toContain(SECRET);
  }, 120_000);

  it('specwitness plan: a criterion statement reaches the prompt on the built-ins, and is ABSENT with the pattern', async () => {
    expect(await planPrompt(false), 'control').toContain(SECRET);
    expect(await planPrompt(true)).not.toContain(SECRET);
  }, 120_000);
});
