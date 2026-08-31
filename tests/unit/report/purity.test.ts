import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * AC3 as a source-level property: the renderers cannot invent a fact, because
 * they cannot reach anything that could tell them one.
 *
 * This overlaps the `report-layer` rule in `.dependency-cruiser.cjs`
 * deliberately, and the overlap is the point rather than duplication:
 *
 *  - the depcruise rule is the enforcement. It runs over the resolved module
 *    graph, so it also catches an import reached transitively, and it fails
 *    the build;
 *  - this suite is the *explanation*. It runs in milliseconds inside the unit
 *    suite, names the offending file and the offending import, and fails for
 *    an author who has not run `pnpm depcruise` yet. A guard whose message is
 *    "violation in module x" costs a cycle to interpret; one that says
 *    "src/report/terminal.ts imports node:fs" does not.
 *
 * It scans the directory rather than a fixed file list, so a renderer added
 * later is covered the moment it exists, with no test to remember to update.
 *
 * **Proven red without touching the real `src/`.** The scan is a function over
 * a directory, and the last describe runs it against a temp tree holding
 * deliberately violating modules. Planting a probe under the real `src/report/`
 * would have been the shorter route and it is the one this repo has already
 * paid for: the harness runs `pnpm test` in this worktree concurrently with
 * the agent, so a second vitest process would see the probe and go red for
 * reasons that have nothing to do with the code (harness defect H-8, which
 * story 2.8 rewrote `tests/unit/dependency-rules.test.ts` to remove). The same
 * discipline applies here.
 */

const REPORT_DIR = fileURLToPath(new URL('../../../src/report/', import.meta.url));

/** Node built-ins that perform I/O — the same list `.dependency-cruiser.cjs` forbids. */
const SIDE_EFFECT_BUILTINS = [
  'child_process',
  'cluster',
  'dgram',
  'dns',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'inspector',
  'net',
  'os',
  'process',
  'readline',
  'repl',
  'tls',
  'v8',
  'vm',
  'worker_threads',
];

/**
 * Layers a renderer must not reach. `domain`, `schemas` and its own siblings
 * are the whole permit list — `src/report/**` is the strictest application
 * layer in the spine's graph, which shows only `REP -> DOM`.
 */
const FORBIDDEN_LAYERS = [
  'cli',
  'config',
  'infra',
  'providers',
  'surfaces',
  'pipeline',
  'authoring',
  'ingest',
];

/** Non-determinism: AD-9. A renderer that reads the clock cannot be snapshot-tested. */
const FORBIDDEN_CALLS = ['Date.now(', 'new Date(', 'process.env', 'process.argv', 'Math.random('];

interface Module {
  readonly file: string;
  readonly source: string;
}

/** Every `from '...'` specifier in a module — import and re-export alike. */
function specifiersOf(source: string): string[] {
  return [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');
}

async function scan(dir: string): Promise<Module[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map(async (entry) => {
        const file = join(entry.parentPath, entry.name);
        return { file, source: await readFile(file, 'utf8') };
      }),
  );
}

/**
 * The three checks, as functions returning the violations they found. Returning
 * a list rather than asserting inside lets the red-proof below run the exact
 * same code the real scan runs — a red proof against a reimplementation would
 * prove nothing about the guard that ships.
 */
function builtinViolations(modules: readonly Module[]): string[] {
  return modules.flatMap(({ file, source }) =>
    specifiersOf(source)
      .filter((specifier) => SIDE_EFFECT_BUILTINS.includes(specifier.replace(/^node:/, '')))
      .map((specifier) => `${file} imports ${specifier}`),
  );
}

function layerViolations(modules: readonly Module[]): string[] {
  return modules.flatMap(({ file, source }) =>
    specifiersOf(source)
      .filter((specifier) => {
        const layer = /^\.\.\/([a-z-]+)\//.exec(specifier)?.[1];
        return layer !== undefined && FORBIDDEN_LAYERS.includes(layer);
      })
      .map((specifier) => `${file} imports ${specifier}`),
  );
}

function determinismViolations(modules: readonly Module[]): string[] {
  return modules.flatMap(({ file, source }) =>
    FORBIDDEN_CALLS.filter((call) => source.includes(call)).map((call) => `${file} uses ${call}`),
  );
}

let shipped: Module[] = [];

beforeAll(async () => {
  shipped = await scan(REPORT_DIR);
  // A scan that found nothing would satisfy every assertion below while
  // proving nothing at all.
  expect(shipped.length).toBeGreaterThan(0);
});

describe('src/report/** is pure by construction', () => {
  it('imports no side-effectful Node built-in', () => {
    // The load-bearing one. A renderer that can open a file can look up a fact
    // the RunResult does not carry, and the terminal and JSON views have
    // drifted (AD-11). It is a security control too: a renderer that cannot
    // import `node:fs` cannot read a credential off disk in order to print it.
    expect(builtinViolations(shipped)).toEqual([]);
  });

  it('imports no layer but domain, schemas and its own siblings', () => {
    expect(layerViolations(shipped)).toEqual([]);
  });

  it('reads no clock, no environment and no randomness', () => {
    // AD-9. A renderer that reads the wall clock would render the same
    // RunResult two different ways, which is the one thing a report must never
    // do — and it is what makes the determinism assertions elsewhere in this
    // suite meaningful rather than lucky.
    expect(determinismViolations(shipped)).toEqual([]);
  });
});

describe('the purity scan itself fails on a violating module', () => {
  let tree: string;

  beforeAll(async () => {
    tree = await mkdtemp(join(tmpdir(), 'specwitness-report-purity-'));
    await writeFile(
      join(tree, 'reads-disk.ts'),
      "import { readFileSync } from 'node:fs';\nexport const r = readFileSync;\n",
      'utf8',
    );
    await writeFile(
      join(tree, 'imports-infra.ts'),
      "import { RunStore } from '../infra/run-store.js';\nexport const s = RunStore;\n",
      'utf8',
    );
    await writeFile(
      join(tree, 'reads-clock.ts'),
      'export const stamp = (): number => Date.now();\n',
      'utf8',
    );
  });

  afterAll(async () => {
    await rm(tree, { recursive: true, force: true });
  });

  it('catches each violation, and names the file and the import', async () => {
    const modules = await scan(tree);
    expect(modules).toHaveLength(3);

    expect(builtinViolations(modules)).toEqual([
      expect.stringContaining('reads-disk.ts imports node:fs'),
    ]);
    expect(layerViolations(modules)).toEqual([
      expect.stringContaining('imports-infra.ts imports ../infra/run-store.js'),
    ]);
    expect(determinismViolations(modules)).toEqual([
      expect.stringContaining('reads-clock.ts uses Date.now('),
    ]);
  });
});
