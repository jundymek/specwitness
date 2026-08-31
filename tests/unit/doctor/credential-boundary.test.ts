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
