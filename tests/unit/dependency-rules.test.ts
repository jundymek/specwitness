import { existsSync } from 'node:fs';
import { mkdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SRC = join(REPO_ROOT, 'src');

/**
 * The AD-1 rules in `.dependency-cruiser.cjs` are inherited by every later
 * story, so their exact behaviour is a cross-story contract — not a config
 * detail. Two properties in particular have already cost several agents a
 * cycle each and are pinned here so nobody re-derives them:
 *
 *  - an adapter MAY import its own siblings (`src/config/load.ts` ->
 *    `src/config/schema.ts`), which relies on dependency-cruiser substituting
 *    the `$1` capture from `from.path` into `to.pathNot`;
 *  - `src/infra/**` MAY use Node built-ins — `RunStore` is by definition the
 *    module that touches the filesystem (AD-8), and `Ids` needs `node:crypto`.
 *
 * Writing them as tests rather than prose also means a dependency-cruiser
 * upgrade that silently drops group matching fails here instead of blocking a
 * story author with a rule that looks correct.
 *
 * Cleanup discipline: these tests write scratch modules under `src/`, which is
 * also where stories 1.2/1.3/1.6 put real, tracked source. So we remove
 * exactly the files we created and only those directories we created
 * ourselves, non-recursively. Never `rm -r` a `src/` subdirectory: once
 * `src/config`, `src/infra` or `src/schemas` hold real modules, that would
 * delete another agent's work on every `pnpm test`.
 */

const createdFiles: string[] = [];
/** Directories this test actually created, shallowest first. */
const createdDirs: string[] = [];

/** Creates missing path segments under src/, recording only the new ones. */
async function ensureDir(dir: string): Promise<void> {
  const rel = relative(SRC, dir);
  if (rel === '' || rel.startsWith('..')) return;

  let current = SRC;
  for (const segment of rel.split(sep)) {
    current = join(current, segment);
    if (!existsSync(current)) {
      await mkdir(current);
      createdDirs.push(current);
    }
  }
}

async function writeModule(relativePath: string, contents: string): Promise<void> {
  const full = join(SRC, relativePath);

  // Belt and braces. Every scratch module is named `__probe-*` so it cannot
  // collide with a real one, but if that ever stopped being true we must fail
  // loudly rather than overwrite — and then delete — another story's source.
  if (existsSync(full)) {
    throw new Error(
      `refusing to overwrite existing module src/${relativePath}: ` +
        'scratch modules must use the __probe- prefix and must not collide with real source',
    );
  }

  await ensureDir(join(full, '..'));
  await writeFile(full, contents, 'utf8');
  createdFiles.push(full);
}

async function depcruise(): Promise<{ exitCode: number | undefined; output: string }> {
  const result = await execa(
    'pnpm',
    ['exec', 'depcruise', 'src', '--config', '.dependency-cruiser.cjs'],
    { cwd: REPO_ROOT, reject: false },
  );
  return { exitCode: result.exitCode, output: `${result.stdout}\n${result.stderr}` };
}

afterEach(async () => {
  for (const file of createdFiles.splice(0)) {
    await rm(file, { force: true });
  }
  // Deepest first, and non-recursive: a directory that turns out to hold real
  // source (because a later story added some) fails with ENOTEMPTY and is
  // correctly left alone.
  for (const dir of createdDirs.splice(0).reverse()) {
    try {
      await rmdir(dir);
    } catch {
      // Not empty, or already gone — either way, leave it.
    }
  }
});

describe('scratch-file cleanup is non-destructive', () => {
  it('leaves a pre-existing directory and its real modules alone', async () => {
    // Simulates story 1.3 having landed src/config/ before this suite runs.
    const configDir = join(SRC, 'config');
    const realModule = join(configDir, 'real-module.ts');
    const preExisted = existsSync(configDir);

    if (!preExisted) await mkdir(configDir);
    await writeFile(realModule, 'export const real = 1;\n', 'utf8');

    try {
      // A scratch file in that same directory, created the normal way.
      await writeModule('config/__probe-scratch.ts', 'export const scratch = 1;\n');

      // Run the same cleanup the suite performs between tests.
      for (const file of createdFiles.splice(0)) await rm(file, { force: true });
      for (const dir of createdDirs.splice(0).reverse()) {
        try {
          await rmdir(dir);
        } catch {
          /* not empty */
        }
      }

      // The scratch file is gone; the real module and its directory survive.
      expect(existsSync(join(configDir, '__probe-scratch.ts'))).toBe(false);
      expect(existsSync(realModule)).toBe(true);
      expect(existsSync(configDir)).toBe(true);
    } finally {
      await rm(realModule, { force: true });
      if (!preExisted) await rmdir(configDir).catch(() => {});
    }
  });
});

describe('AD-1 rules permit what later stories legitimately need', () => {
  it('lets an adapter import its own siblings', async () => {
    // Story 1.3's exact shape. If this fails, `$1` group-matching broke.
    await writeModule('config/__probe-schema.ts', 'export const schema = 1;\n');
    await writeModule(
      'config/__probe-load.ts',
      "import { schema } from './__probe-schema.js';\nexport const load = schema;\n",
    );

    const { exitCode, output } = await depcruise();

    expect(output).not.toContain('adapters-core-only');
    expect(exitCode).toBe(0);
  });

  it('lets src/infra use Node built-ins', async () => {
    // Story 1.6's exact shape: RunStore is the sole writer under
    // .specwitness/runs/ (AD-8) and Ids needs randomness.
    await writeModule(
      'infra/__probe-run-store.ts',
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
    await writeModule(
      'schemas/__probe-manifest.ts',
      "import { z } from 'zod';\nexport const s = z.string();\n",
    );

    const { exitCode, output } = await depcruise();

    expect(output).not.toContain('schemas-npm-allowlist');
    expect(exitCode).toBe(0);
  });

  it('lets src/ingest use Node built-ins, the core, and its own siblings', async () => {
    // Story 2.1's exact shape: ingestion is application-layer, it reads
    // planning artifacts off disk, and it composes the domain model with its
    // zod mirror. If this fails, the ingest reader cannot be written at all.
    await writeModule('ingest/__probe-source.ts', 'export const source = 1;\n');
    await writeModule(
      'ingest/__probe-reader.ts',
      "import { readFileSync } from 'node:fs';\n" +
        "import { join } from 'node:path';\n" +
        "import { IngestError } from '../domain/errors.js';\n" +
        "import { SCHEMA_VERSIONS } from '../schemas/versions.js';\n" +
        "import { source } from './__probe-source.js';\n" +
        'export const read = (d: string) =>\n' +
        '  readFileSync(join(d, "epics.md"), "utf8").length + source + SCHEMA_VERSIONS.runManifest;\n' +
        'export const fail = () => new IngestError("x");\n',
    );

    const { exitCode, output } = await depcruise();

    expect(output).not.toContain('ingest-core-only');
    expect(exitCode).toBe(0);
  });

  it('lets src/schemas use node:crypto', async () => {
    // Story 2.2's exact shape. AD-5 names `schemas/canonical.ts` as THE single
    // implementation of the contract fingerprint, and a fingerprint needs
    // SHA-256. The carve-out lives on `schemas-core-only` rather than in a rule
    // of its own because dependency-cruiser's `forbidden` rules are OR-ed: a
    // later rule cannot un-forbid what an earlier one forbids. If that ever
    // changes, this test still passes and the narrowing test below still fails
    // loudly, which is the ordering we want.
    await writeModule(
      'schemas/__probe-canonical.ts',
      "import { createHash } from 'node:crypto';\n" +
        'export const h = (s: string) => createHash("sha256").update(s).digest("hex");\n',
    );

    const { exitCode, output } = await depcruise();

    expect(output).not.toContain('schemas-core-only');
    expect(exitCode).toBe(0);
  });

  it('lets src/schemas import yaml', async () => {
    // Story 2.2 again: AD-5 makes contracts human-readable YAML, and
    // `schemas/contract.ts` owns `parseContract`/`serializeContract`. A pure
    // text codec is not "reaching out"; the forbidding half is pinned below.
    await writeModule(
      'schemas/__probe-yaml.ts',
      "import { stringify } from 'yaml';\nexport const s = stringify;\n",
    );

    const { exitCode, output } = await depcruise();

    expect(output).not.toContain('schemas-npm-allowlist');
    expect(exitCode).toBe(0);
  });
});

describe('AD-1 rules still forbid what they are meant to forbid', () => {
  it('blocks one adapter importing another', async () => {
    await writeModule('infra/__probe-runner.ts', 'export const runner = 1;\n');
    await writeModule(
      'config/__probe-cross.ts',
      "import { runner } from '../infra/__probe-runner.js';\nexport const bad = runner;\n",
    );

    const { exitCode, output } = await depcruise();

    expect(output).toContain('adapters-core-only');
    expect(exitCode).not.toBe(0);
  });

  it('blocks anything importing the cli edge', async () => {
    await writeModule(
      'config/__probe-to-edge.ts',
      "import { EXIT } from '../cli/exit.js';\nexport const bad = EXIT;\n",
    );

    const { exitCode, output } = await depcruise();

    expect(output).toContain('nothing-imports-cli');
    expect(exitCode).not.toBe(0);
  });

  it('blocks an npm package outside the schemas allowlist', async () => {
    // Was `yaml` until story 2.2, which moved yaml onto the allowlist (AD-5
    // makes contracts human-readable YAML and `schemas/contract.ts` owns the
    // text<->model conversion). `execa` replaces it deliberately: a subprocess
    // runner inside `src/schemas/**` is precisely the "schemas do not reach
    // out" violation this rule exists to catch, so the guarantee is unchanged
    // in substance — only the example moved.
    await writeModule(
      'schemas/__probe-bad.ts',
      "import { execa } from 'execa';\nexport const e = execa;\n",
    );

    const { exitCode, output } = await depcruise();

    expect(output).toContain('schemas-npm-allowlist');
    expect(exitCode).not.toBe(0);
  });

  it('blocks a BMAD type leaking out of src/ingest into an adapter', async () => {
    // The AC4 guarantee, red-tested: FR-6 says no BMAD-specific type may be
    // imported outside `ingest/`. A rule with no proof that it fires is not a
    // guardrail, and Epic 1's retrospective names this lesson explicitly.
    // `src/config` rather than `src/cli`, so the failure can only be
    // `ingest-core-only` and not `nothing-imports-cli`.
    await writeModule(
      'ingest/__probe-leak.ts',
      "import { loadConfig } from '../config/load.js';\nexport const bad = loadConfig;\n",
    );

    const { exitCode, output } = await depcruise();

    expect(output).toContain('ingest-core-only');
    expect(exitCode).not.toBe(0);
  });

  it('blocks a Node built-in other than crypto inside src/schemas', async () => {
    // The other half of story 2.2's `node:crypto` carve-out. Without this the
    // allowance could widen to "src/schemas may use built-ins" and nothing
    // would fail — schemas would be free to read the filesystem, and the whole
    // point of a pure core is that it cannot.
    await writeModule(
      'schemas/__probe-fs.ts',
      "import { readFileSync } from 'node:fs';\nexport const r = readFileSync;\n",
    );

    const { exitCode, output } = await depcruise();

    expect(output).toContain('schemas-core-only');
    expect(exitCode).not.toBe(0);
  });

  it('blocks a side-effectful built-in inside src/domain', async () => {
    // src/domain already holds shipped code, so this file is removed by name
    // and the directory is never touched.
    await writeModule(
      'domain/__probe-scratch.ts',
      "import { readFileSync } from 'node:fs';\nexport const r = readFileSync;\n",
    );

    const { exitCode, output } = await depcruise();

    expect(output).toContain('domain-is-dependency-free');
    expect(exitCode).not.toBe(0);
  });
});
