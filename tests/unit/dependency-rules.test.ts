import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SRC = join(REPO_ROOT, 'src');

/**
 * The AD-1 rules in `.dependency-cruiser.cjs` are inherited by every later
 * story, so their exact behaviour is a cross-story contract — not a config
 * detail. Two properties in particular have already been questioned once each
 * and are pinned here so nobody has to re-derive them:
 *
 *  - an adapter MAY import its own siblings (`src/config/load.ts` ->
 *    `src/config/schema.ts`), which relies on dependency-cruiser substituting
 *    the `$1` capture from `from.path` into `to.pathNot`;
 *  - `src/infra/**` MAY use Node built-ins — `RunStore` is by definition the
 *    module that touches the filesystem (AD-8), and `Ids` needs `node:crypto`.
 *
 * Writing them as tests rather than prose also means a dependency-cruiser
 * upgrade that silently drops group-matching fails here instead of blocking a
 * story author with a rule that looks correct.
 */

/** Files created by a single test case, removed afterwards. */
const created: string[] = [];

async function writeModule(relativePath: string, contents: string): Promise<void> {
  const full = join(SRC, relativePath);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, contents, 'utf8');
  created.push(full);
}

async function depcruise(): Promise<{ exitCode: number | undefined; output: string }> {
  const result = await execa('pnpm', ['exec', 'depcruise', 'src', '--config', '.dependency-cruiser.cjs'], {
    cwd: REPO_ROOT,
    reject: false,
  });
  return { exitCode: result.exitCode, output: `${result.stdout}\n${result.stderr}` };
}

afterEach(async () => {
  // Remove the scratch directories wholesale; none of them are shipped code.
  for (const dir of ['config', 'infra', 'schemas', 'probe']) {
    await rm(join(SRC, dir), { recursive: true, force: true });
  }
  created.length = 0;
});

describe('AD-1 rules permit what later stories legitimately need', () => {
  it('lets an adapter import its own siblings', async () => {
    // Story 1.3's exact shape. If this ever fails, `$1` group-matching broke.
    await writeModule('config/schema.ts', 'export const schema = 1;\n');
    await writeModule(
      'config/load.ts',
      "import { schema } from './schema.js';\nexport const load = schema;\n",
    );

    const { exitCode, output } = await depcruise();

    expect(output).not.toContain('adapters-core-only');
    expect(exitCode).toBe(0);
  });

  it('lets src/infra use Node built-ins', async () => {
    // Story 1.6's exact shape: RunStore is the sole writer under
    // .specwitness/runs/ (AD-8) and Ids needs randomness.
    await writeModule(
      'infra/run-store.ts',
      "import { randomBytes } from 'node:crypto';\n" +
        "import { mkdirSync } from 'node:fs';\n" +
        "import { join } from 'node:path';\n" +
        'export const id = () => randomBytes(4).toString("hex");\n' +
        'export const mk = (d: string) => mkdirSync(join(d, "runs"), { recursive: true });\n',
    );

    const { exitCode, output } = await depcruise();

    expect(output).not.toContain('no-side-effect-builtins-in-core');
    expect(exitCode).toBe(0);
  });

  it('lets src/schemas import zod', async () => {
    await writeModule('schemas/manifest.ts', "import { z } from 'zod';\nexport const s = z.string();\n");

    const { exitCode, output } = await depcruise();

    expect(output).not.toContain('schemas-npm-allowlist');
    expect(exitCode).toBe(0);
  });
});

describe('AD-1 rules still forbid what they are meant to forbid', () => {
  it('blocks one adapter importing another', async () => {
    await writeModule('infra/runner.ts', 'export const runner = 1;\n');
    await writeModule(
      'config/cross.ts',
      "import { runner } from '../infra/runner.js';\nexport const bad = runner;\n",
    );

    const { exitCode, output } = await depcruise();

    expect(output).toContain('adapters-core-only');
    expect(exitCode).not.toBe(0);
  });

  it('blocks anything importing the cli edge', async () => {
    await writeModule(
      'config/to-edge.ts',
      "import { EXIT } from '../cli/exit.js';\nexport const bad = EXIT;\n",
    );

    const { exitCode, output } = await depcruise();

    expect(output).toContain('nothing-imports-cli');
    expect(exitCode).not.toBe(0);
  });

  it('blocks an npm package other than zod inside src/schemas', async () => {
    await writeModule('schemas/bad.ts', "import { parse } from 'yaml';\nexport const p = parse;\n");

    const { exitCode, output } = await depcruise();

    expect(output).toContain('schemas-npm-allowlist');
    expect(exitCode).not.toBe(0);
  });

  it('blocks a side-effectful built-in inside src/domain', async () => {
    // src/domain already exists and is shipped, so this scratch file is
    // removed by name rather than by dropping the directory.
    const scratch = join(SRC, 'domain', '__scratch.ts');
    await writeFile(scratch, "import { readFileSync } from 'node:fs';\nexport const r = readFileSync;\n", 'utf8');

    try {
      const { exitCode, output } = await depcruise();

      expect(output).toContain('domain-is-dependency-free');
      expect(exitCode).not.toBe(0);
    } finally {
      await rm(scratch, { force: true });
    }
  });
});
