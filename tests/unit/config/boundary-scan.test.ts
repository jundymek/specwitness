/**
 * AC3, enforced mechanically across the whole source tree.
 *
 * The type-level test next door proves a raw string cannot be ASSIGNED to a
 * `DeclaredCommand`. That is necessary but not sufficient: two forge paths would
 * still get past the type checker.
 *
 *   1. Importing the minting schema. `declaredCommandSchema` has to be exported
 *      from `declared-command.ts` so `schema.ts` can use it, and zod schemas are
 *      callable — `declaredCommandSchema.parse(anythingAtAll)` returns a
 *      `DeclaredCommand`. depcruise does NOT stop this: its `adapters-core-only`
 *      rule constrains what `src/config/**` may import, and application layers
 *      (`pipeline`, `authoring`, `ingest`, `report`) are permitted to import
 *      `src/config` — as they must, since they consume the config.
 *   2. Casting. `'rm -rf /' as unknown as DeclaredCommand` compiles anywhere.
 *
 * Neither is reachable from the public surface (`index.ts` exports neither the
 * mint nor the schema), but "not currently done" is not the same as "cannot be
 * done", and this is the one invariant in the product where that distinction
 * matters. So it is scanned, in the same style as story 1.1's `process.exit`
 * location test.
 *
 * If a later story needs a command this module does not expose, add a config
 * accessor — do not add an escape hatch, and do not relax this test.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');
const CONFIG_DIR = join(SRC, 'config');

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (entry.endsWith('.ts')) {
      found.push(full);
    }
  }
  return found;
}

/** Every source file except the config module that legitimately owns the mint. */
function filesOutsideConfig(): string[] {
  return sourceFiles(SRC).filter((file) => !file.startsWith(CONFIG_DIR + sep));
}

describe('the DeclaredCommand mint cannot be reached from outside src/config', () => {
  it('no module outside src/config deep-imports past the public surface', () => {
    // Only `config/index.js` may be imported from outside. Banning deep imports
    // wholesale is stronger than naming individual files: `schema.ts` exports
    // `configSchema`, whose `.parse()` also mints, and a future internal module
    // might do the same without anyone remembering to extend this list.
    //
    // Matches the module SPECIFIER rather than the `from` clause, so it catches a
    // dynamic `await import('../config/schema.js')` as well as a static import —
    // the dynamic form was a real gap in the first version of this test. Anchored
    // on the `.js` extension so prose mentioning `src/config/schema.ts` in a doc
    // comment is not a false positive.
    //
    // Honest limit: a computed specifier (`import(someVariable)`) cannot be caught
    // by any static scan. That is a deliberate act of circumvention rather than an
    // accident, and code review is the backstop for it.
    const deepImport = /['"][^'"]*\/config\/(?!index\.js['"])[^'"]*\.js['"]/;

    const offenders = filesOutsideConfig().filter((file) =>
      deepImport.test(readFileSync(file, 'utf8')),
    );

    expect(offenders.map((file) => relative(process.cwd(), file))).toEqual([]);
  });

  it('no module outside src/config casts anything to DeclaredCommand', () => {
    // Catches `x as DeclaredCommand` and `x as unknown as DeclaredCommand`.
    const castPattern = /\bas\s+(?:unknown\s+as\s+)?DeclaredCommand\b/;

    const offenders = filesOutsideConfig().filter((file) =>
      castPattern.test(readFileSync(file, 'utf8')),
    );

    expect(offenders.map((file) => relative(process.cwd(), file))).toEqual([]);
  });

  it('the public surface exports neither the mint nor the minting schema', async () => {
    const surface = await import('../../../src/config/index.js');

    expect(Object.keys(surface)).not.toContain('declaredCommandSchema');
    expect(Object.keys(surface)).not.toContain('declareCommand');
    expect(Object.keys(surface)).not.toContain('configSchema');
  });

  it('scans a non-trivial number of files (the scan itself cannot silently no-op)', () => {
    // A refactor that moved or renamed src/ would otherwise make this suite pass
    // by scanning nothing at all.
    expect(filesOutsideConfig().length).toBeGreaterThan(3);
  });
});
