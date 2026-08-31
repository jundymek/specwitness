import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * NFR-1, as a TESTED property rather than a promise.
 *
 * The PRD states it as a testable consequence: "Doctor never reads
 * `~/.claude/`, `~/.codex/` or equivalent credential storage; auth readiness is
 * probed only via the official CLI's own commands/exit behavior." Story 2.7 adds
 * that auth probing on top of the registry built here, so the guard is written
 * now, while the module is small, and inherited by whatever plugs in later.
 *
 * The scan walks the doctor module's AST rather than grepping, so it sees a home
 * directory reached through any expression form and is not fooled by a name that
 * merely contains the word "home" in prose.
 *
 * Honest limits, stated rather than papered over: a fully computed access
 * (`process.env[someVariable]`) cannot be resolved by any static scan, and this
 * guard covers `src/cli/doctor/**` plus the doctor command — the module that
 * exists today. Deliberate circumvention is a code-review problem; this catches
 * the accident, which is the realistic failure.
 */

const DOCTOR_DIR = join(process.cwd(), 'src', 'cli', 'doctor');
const DOCTOR_COMMAND = join(process.cwd(), 'src', 'cli', 'commands', 'doctor.ts');

/** Home-directory and credential-store routes doctor must never take. */
const FORBIDDEN_CALLS = new Set(['homedir', 'userInfo']);
const FORBIDDEN_ENV = new Set(['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']);
const FORBIDDEN_TEXT = ['.claude', '.codex', 'credentials.json', '.netrc'];

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

function doctorSources(): string[] {
  return [...sourceFiles(DOCTOR_DIR), DOCTOR_COMMAND];
}

interface Violation {
  readonly file: string;
  readonly what: string;
}

function scan(file: string): Violation[] {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
  const violations: Violation[] = [];

  const visit = (node: ts.Node): void => {
    // `homedir()` / `os.homedir()` / `userInfo().homedir`
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee)
          ? callee.text
          : undefined;
      if (name !== undefined && FORBIDDEN_CALLS.has(name)) {
        violations.push({ file, what: `${name}()` });
      }
    }

    // `process.env.HOME` and `process.env['HOME']`
    if (ts.isPropertyAccessExpression(node) && FORBIDDEN_ENV.has(node.name.text)) {
      violations.push({ file, what: `process.env.${node.name.text}` });
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      FORBIDDEN_ENV.has(node.argumentExpression.text)
    ) {
      violations.push({ file, what: `env['${node.argumentExpression.text}']` });
    }

    // A literal path into a credential store, however it is later used.
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      for (const needle of FORBIDDEN_TEXT) {
        if (node.text.includes(needle)) {
          violations.push({ file, what: `string literal containing "${needle}"` });
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return violations;
}

describe('NFR-1: doctor never reads a credential store', () => {
  it('scans a non-empty set of doctor sources', () => {
    // A guard that silently scans nothing is worse than no guard: it reports
    // success forever.
    expect(doctorSources().length).toBeGreaterThan(5);
  });

  it('reaches for no home directory and no credential path', () => {
    const violations = doctorSources().flatMap(scan);

    expect(violations).toEqual([]);
  });

  it('reads exactly one environment variable, PATH', () => {
    const envReads = doctorSources().flatMap((file) => {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.ESNext,
        true,
      );
      const names: string[] = [];
      const visit = (node: ts.Node): void => {
        if (
          ts.isElementAccessExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'env' &&
          ts.isStringLiteral(node.argumentExpression)
        ) {
          names.push(node.argumentExpression.text);
        }
        if (
          ts.isPropertyAccessExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'env'
        ) {
          names.push(node.name.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      return names;
    });

    expect([...new Set(envReads)]).toEqual(['PATH']);
  });
});

/**
 * NFR-1 for `src/providers/**` — the same property, its own scan, its own list.
 *
 * WHY A SECOND BLOCK RATHER THAN A WIDER `doctorSources()`. Story 2.3's spec
 * said to extend the existing helper and widen the existing env allow-list into
 * a union. Stories 2.3 and 2.7 agreed in writing to do it this way instead, for
 * two reasons:
 *
 *  - The existing env assertion reads from `doctorSources()`. Widening that
 *    helper would silently change what that assertion covers without changing a
 *    line of its text — a test whose meaning moves while its diff does not.
 *  - Doctor and the providers have genuinely different sets of legitimate env
 *    reads. One union list stops being a guard and becomes "everything anyone
 *    ever needed"; two exact lists each stay reviewable.
 *
 * So: one scan helper per module, one exact allow-list per module, a
 * justification per name. The homedir and credential-path assertions are
 * repeated verbatim rather than relaxed — those have no legitimate exception in
 * any module, ever.
 *
 * The honest limit is unchanged: `process.env[computedName]` defeats any static
 * scan. This catches the accident, which is the realistic failure; deliberate
 * circumvention is a code-review problem.
 */

const PROVIDERS_DIR = join(process.cwd(), 'src', 'providers');
const PROCESS_RUNNER = join(process.cwd(), 'src', 'infra', 'process-runner.ts');

/**
 * Everything that spawns, or could spawn, an agent CLI.
 *
 * `src/infra/process-runner.ts` is included deliberately: it is not under
 * `src/providers/`, but it is the file that actually builds a child environment,
 * so leaving it out would put the one place credentials could realistically leak
 * outside the guard.
 */
function providerSources(): string[] {
  return [...sourceFiles(PROVIDERS_DIR), PROCESS_RUNNER];
}

/**
 * Environment variables `src/providers/**` may name, and why each is permitted.
 *
 * The load-bearing distinction, and the whole reason two of these are here:
 * naming a variable in order to WITHHOLD it from a child process, or to warn
 * that it is present, is the categorical opposite of reading a credential store.
 * No value is ever read, logged, persisted or sent anywhere.
 *
 * Adding a name is meant to be a deliberate act with a justification attached.
 * Do NOT relax this to `toContain`, and do not widen it to "any variable" —
 * either change deletes the guard while leaving a green test behind.
 */
const PROVIDER_ENV_ALLOWLIST = new Map<string, string>([
  ['PATH', 'binary lookup for a spawned agent CLI — the same read doctor makes'],
  [
    'ANTHROPIC_API_KEY',
    'AD-4/FR-15: named so it can be WITHHELD from a subscription-mode claude child. ' +
      'The name is used; the value never is.',
  ],
  [
    'OPENAI_API_KEY',
    'AD-4/FR-15: named so it can be WITHHELD from a chatgpt-mode codex child. ' +
      'The name is used; the value never is.',
  ],
]);

/** Every environment variable named by these files, in source order. */
function collectEnvReads(files: readonly string[]): string[] {
  return files.flatMap((file) => {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true);
    const names: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isElementAccessExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'env' &&
        ts.isStringLiteral(node.argumentExpression)
      ) {
        names.push(node.argumentExpression.text);
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'env'
      ) {
        names.push(node.name.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return names;
  });
}

describe('NFR-1: no provider adapter reads a credential store', () => {
  it('scans a non-empty set of provider sources', () => {
    // A guard that silently scans nothing reports success forever — and this one
    // scans a directory that did not exist before this story, so an empty result
    // is a plausible mistake rather than a paranoid one.
    expect(providerSources().length).toBeGreaterThan(2);
  });

  it('reaches for no home directory and no credential path', () => {
    // ~/.claude, ~/.codex, credentials.json, .netrc, homedir(), userInfo() —
    // none of them, in any expression form, anywhere under src/providers/**.
    const violations = providerSources().flatMap(scan);

    expect(violations).toEqual([]);
  });

  it('names no environment variable outside the justified allow-list', () => {
    const named = [...new Set(collectEnvReads(providerSources()))];

    const unjustified = named.filter((name) => !PROVIDER_ENV_ALLOWLIST.has(name));

    expect(unjustified).toEqual([]);
  });

  it('keeps a justification attached to every permitted name', () => {
    // The allow-list is only a guard while each entry carries a reason someone
    // reviewed. An entry added with an empty reason is an entry added silently.
    for (const [name, reason] of PROVIDER_ENV_ALLOWLIST) {
      expect(reason.length, `${name} has no justification`).toBeGreaterThan(20);
    }
  });
});
