/**
 * AC3, enforced mechanically across the whole source tree — with a parser, not a
 * regex.
 *
 * The type-level test next door proves a raw string cannot be ASSIGNED to a
 * `DeclaredCommand`. That is necessary but not sufficient: two families of bypass
 * still satisfy the type checker.
 *
 *   1. Reaching a minting function. `schema.ts` exports `configSchema`, whose
 *      `.parse()` mints. depcruise does NOT stop this: its `adapters-core-only`
 *      rule constrains what `src/config/**` may import, while application layers
 *      (`pipeline`, `authoring`, `ingest`, `report`) are permitted to import
 *      `src/config` — as they must, since they consume the config. So only
 *      `config/index.js` may be imported from outside, and it exports no mint.
 *   2. Asserting. `'rm -rf /' as DeclaredCommand` compiles anywhere.
 *
 * This guard began as a regex and was wrong twice, which is the argument for
 * parsing rather than pattern-matching: the first version missed
 * `await import('../config/schema.js')`, and the second still missed
 * `<DeclaredCommand>x` and `import type { DeclaredCommand as DC }` followed by
 * `x as DC`. Rather than keep patching a pattern against a hostile search space,
 * the scan now walks the TypeScript AST — syntactically, with no type checker, so
 * it stays fast — covering every assertion form, alias, namespace qualification
 * and import style uniformly.
 *
 * Remaining honest limit: a computed module specifier (`import(someVariable)`)
 * cannot be resolved by any static scan. That is deliberate circumvention rather
 * than an accident, and code review is the backstop for it.
 *
 * If a later story needs a command the public surface does not expose, add a
 * config accessor — do not add an escape hatch, and do not relax this test.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');
const CONFIG_DIR = join(SRC, 'config');
const BRAND = 'DeclaredCommand';

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

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
}

function eachNode(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => eachNode(child, visit));
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

/** A module specifier pointing inside src/config at anything but its index. */
function isDeepConfigImport(specifier: string): boolean {
  const match = /(^|\/)config\/(.+)$/.exec(specifier);
  if (match === null) {
    return false;
  }
  const rest = match[2] ?? '';
  return rest !== 'index.js' && rest !== 'index';
}

/**
 * Every local name in this file that refers to the brand type: the plain name,
 * any `as` alias, and any namespace import it could be qualified through.
 */
function brandAliases(source: ts.SourceFile): Set<string> {
  const names = new Set<string>([BRAND]);

  eachNode(source, (node) => {
    if (!ts.isImportDeclaration(node)) {
      return;
    }
    const bindings = node.importClause?.namedBindings;
    if (bindings === undefined) {
      return;
    }
    if (ts.isNamespaceImport(bindings)) {
      // `import * as cfg` -> a `cfg.DeclaredCommand` qualified reference.
      names.add(bindings.name.text);
      return;
    }
    for (const element of bindings.elements) {
      if ((element.propertyName?.text ?? element.name.text) === BRAND) {
        names.add(element.name.text);
      }
    }
  });

  return names;
}

/** Does this type node mention the brand under any of its local names? */
function mentionsBrand(type: ts.TypeNode | undefined, names: ReadonlySet<string>): boolean {
  if (type === undefined) {
    return false;
  }
  let found = false;
  eachNode(type, (node) => {
    if (ts.isIdentifier(node) && names.has(node.text)) {
      found = true;
    }
  });
  return found;
}

interface Offence {
  file: string;
  detail: string;
}

function scan(check: (source: ts.SourceFile, names: Set<string>) => string | undefined): Offence[] {
  const offences: Offence[] = [];
  for (const file of filesOutsideConfig()) {
    const source = parse(file);
    const detail = check(source, brandAliases(source));
    if (detail !== undefined) {
      offences.push({ file: relative(process.cwd(), file), detail });
    }
  }
  return offences;
}

describe('the DeclaredCommand mint cannot be reached from outside src/config', () => {
  it('no module outside src/config imports past the public surface', () => {
    const offences = scan((source) => {
      let detail: string | undefined;
      eachNode(source, (node) => {
        // Static `import ... from '...'` and `export ... from '...'`.
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier !== undefined &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          isDeepConfigImport(node.moduleSpecifier.text)
        ) {
          detail ??= `static import of ${node.moduleSpecifier.text} at line ${lineOf(source, node)}`;
        }
        // Dynamic `await import('...')`.
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments[0] !== undefined &&
          ts.isStringLiteral(node.arguments[0]) &&
          isDeepConfigImport(node.arguments[0].text)
        ) {
          detail ??= `dynamic import of ${node.arguments[0].text} at line ${lineOf(source, node)}`;
        }
        // Type-position `import('...').Foo`.
        if (
          ts.isImportTypeNode(node) &&
          ts.isLiteralTypeNode(node.argument) &&
          ts.isStringLiteral(node.argument.literal) &&
          isDeepConfigImport(node.argument.literal.text)
        ) {
          detail ??= `import type of ${node.argument.literal.text} at line ${lineOf(source, node)}`;
        }
      });
      return detail;
    });

    expect(offences).toEqual([]);
  });

  it('no module outside src/config asserts anything into a DeclaredCommand', () => {
    const offences = scan((source, names) => {
      let detail: string | undefined;
      eachNode(source, (node) => {
        // `x as DeclaredCommand`, including `x as unknown as DC`.
        if (ts.isAsExpression(node) && mentionsBrand(node.type, names)) {
          detail ??= `as-assertion at line ${lineOf(source, node)}`;
        }
        // `<DeclaredCommand>x` — legal in .ts files.
        if (ts.isTypeAssertionExpression(node) && mentionsBrand(node.type, names)) {
          detail ??= `angle-bracket assertion at line ${lineOf(source, node)}`;
        }
        // `cast<DeclaredCommand>(x)` / `new Box<DeclaredCommand>(x)` — an explicit
        // type argument turns any generic helper into a forge.
        if (
          (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
          node.typeArguments?.some((argument) => mentionsBrand(argument, names)) === true
        ) {
          detail ??= `brand as an explicit type argument at line ${lineOf(source, node)}`;
        }
      });
      return detail;
    });

    expect(offences).toEqual([]);
  });

  it('the public surface exports nothing that can mint', async () => {
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
