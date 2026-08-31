import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

import { contractState, parseContract } from '../../src/schemas/contract.js';

import {
  buildFixture,
  FAILING_GATE_STDERR,
  FAILING_GATE_STDOUT,
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
