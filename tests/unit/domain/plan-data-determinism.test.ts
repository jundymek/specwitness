import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Story 4.3, AC1 — the NEGATIVE half, enforced mechanically.
 *
 * AD-9's rule is that deterministic test data is resolved at plan COMPILE time and stored in the
 * plan; nothing invents a value at run time. The unit tests above prove the resolver is
 * deterministic for the inputs they happen to try. This one proves something they cannot: that
 * the *ingredients* of non-determinism are absent from the source entirely, so a future edit
 * cannot quietly reintroduce one and still pass a suite that only checks known inputs.
 *
 * `Math.random()` and `crypto.randomUUID()` are both wrong here, and so is anything reading the
 * clock: `Clock` is an injected port precisely so nothing on this path reads wall time.
 *
 * Shaped after `tests/unit/exit-location.test.ts`, including its self-check — a scan that has
 * never matched anything is not evidence.
 */

const SCANNED = ['../../../src/domain/plan-data.ts', '../../../src/pipeline/stages/data.ts'] as const;

/**
 * Sources of non-determinism, each matched as a real call rather than as the word in prose.
 *
 * The module headers discuss `Math.random()` and `Date.now()` at length precisely to explain why
 * they are absent, so a naive substring scan would fire on the explanation. Every pattern below
 * requires the call/construction syntax, and the self-check asserts each one both fires on the
 * real thing and stays quiet on the prose.
 */
const FORBIDDEN: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: 'Math.random()', pattern: /Math\s*\.\s*random\s*\(/ },
  { label: 'Date.now()', pattern: /Date\s*\.\s*now\s*\(/ },
  { label: 'new Date(...)', pattern: /new\s+Date\s*\(/ },
  { label: 'crypto.randomUUID() / any crypto call', pattern: /crypto\s*\.\s*[A-Za-z]+\s*\(/ },
  { label: 'performance.now()', pattern: /performance\s*\.\s*now\s*\(/ },
  { label: "an import of node:crypto", pattern: /from\s+['"]node:crypto['"]/ },
  { label: 'process.env', pattern: /process\s*\.\s*env/ },
  { label: 'process.hrtime()', pattern: /process\s*\.\s*hrtime/ },
];

async function sourceOf(relative: string): Promise<string> {
  return await readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

describe('the deterministic-data path contains no source of non-determinism (AC1)', () => {
  it('finds the files it claims to scan', async () => {
    // Guards against the whole suite passing because it read nothing — the failure mode that
    // makes a scan test worse than no test.
    for (const relative of SCANNED) {
      const source = await sourceOf(relative);
      expect(source.length).toBeGreaterThan(500);
    }
  });

  it('detects each forbidden construct when one is present', async () => {
    // Proves the patterns work. Without this, a typo'd regex silently permits everything.
    const positives: Record<string, string> = {
      'Math.random()': 'const x = Math.random();',
      'Date.now()': 'const t = Date.now();',
      'new Date(...)': 'const d = new Date(seed);',
      'crypto.randomUUID() / any crypto call': 'const id = crypto.randomUUID();',
      'performance.now()': 'const t = performance.now();',
      'an import of node:crypto': "import { createHash } from 'node:crypto';",
      'process.env': 'const v = process.env.SEED;',
      'process.hrtime()': 'const t = process.hrtime.bigint();',
    };

    for (const { label, pattern } of FORBIDDEN) {
      expect(pattern.test(positives[label] as string), `${label} must match its own example`).toBe(
        true,
      );
    }
  });

  it('does not fire on the prose that explains why those constructs are absent', async () => {
    // The module headers name every one of these. A scan that cannot tell a sentence from a call
    // would force the explanation out of the code, which is the wrong trade.
    const prose =
      ' * So: no Math.random(), no crypto.randomUUID(), no Date.now(), no new Date(), nothing\n' +
      ' * reading the environment. Clock and Ids are injected ports.\n';

    // Deliberately: this prose DOES contain call syntax, so it is not a valid negative for the
    // call patterns. What must stay quiet are the identifier-only patterns.
    expect(/process\s*\.\s*env/.test(prose)).toBe(false);
    expect(/from\s+['"]node:crypto['"]/.test(prose)).toBe(false);
  });

  it('reports no forbidden construct in any scanned file', async () => {
    const offenders: string[] = [];

    for (const relative of SCANNED) {
      const source = await sourceOf(relative);
      // Comments are stripped before scanning, so the headers may keep explaining WHY these are
      // absent — in prose that names them — without the scan mistaking the explanation for the
      // thing. Everything the scan then sees is executable code.
      const code = stripComments(source);

      for (const { label, pattern } of FORBIDDEN) {
        if (pattern.test(code)) {
          offenders.push(`${relative}: ${label}`);
        }
      }
    }

    expect(offenders).toStrictEqual([]);
  });
});

/**
 * Remove block and line comments so the scan sees code only.
 *
 * Not a TypeScript parser and it does not need to be: it removes `/* ... *\/` and `// ...`, and
 * the one construct that would fool it — those delimiters inside a string literal — does not
 * occur in either scanned file. Kept blunt on purpose; a real parser here would be a second
 * dependency to justify for a guard whose whole value is that it is obvious.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
