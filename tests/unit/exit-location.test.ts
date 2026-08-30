import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

/**
 * AC1: "no code path outside `cli/exit.ts` defines a process exit code."
 *
 * This is the mechanical check every later story inherits. Stories 1.2–1.6 and
 * every epic after them throw an AD-7 error and let the CLI edge classify it;
 * a second place writing an exit code would silently fork the ADR-002 table.
 */
const ALLOWED = ['cli/exit.ts'];

/** Matches a real write/definition, not the word "exit" in prose. */
const EXIT_CODE_PATTERN = /process\s*\.\s*exit\s*\(|process\s*\.\s*exitCode/;

async function tsFilesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return tsFilesUnder(full);
      return entry.name.endsWith('.ts') ? [full] : [];
    }),
  );
  return files.flat();
}

describe('process exit codes live only in cli/exit.ts (AC1)', () => {
  it('finds source files to scan at all', async () => {
    // Guards against the scan silently passing because it looked at nothing.
    const files = await tsFilesUnder(SRC);

    expect(files.length).toBeGreaterThan(5);
  });

  it('detects a violation when one is present', async () => {
    // Proves the pattern actually works. A scan test that has never matched
    // anything is not evidence.
    expect(EXIT_CODE_PATTERN.test('process.exit(1)')).toBe(true);
    expect(EXIT_CODE_PATTERN.test('process.exitCode = 3')).toBe(true);
    expect(EXIT_CODE_PATTERN.test('process .exit( 0 )')).toBe(true);
    // And that it does not fire on innocent neighbours.
    expect(EXIT_CODE_PATTERN.test('process.argv.slice(2)')).toBe(false);
    expect(EXIT_CODE_PATTERN.test('process.stderr.write(x)')).toBe(false);
    expect(EXIT_CODE_PATTERN.test('// exit codes are the product')).toBe(false);
  });

  it('reports no offender outside the allowed module', async () => {
    const files = await tsFilesUnder(SRC);

    const offenders: string[] = [];
    for (const file of files) {
      const contents = await readFile(file, 'utf8');
      if (!EXIT_CODE_PATTERN.test(contents)) continue;

      const rel = relative(SRC, file).split(sep).join('/');
      if (!ALLOWED.includes(rel)) {
        offenders.push(rel);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('confirms the allowed module really is the one defining them', async () => {
    // The complement of the check above: if exit.ts stopped writing the exit
    // code, the scan would pass vacuously while the contract was gone.
    const contents = await readFile(join(SRC, 'cli/exit.ts'), 'utf8');

    expect(EXIT_CODE_PATTERN.test(contents)).toBe(true);
  });
});
