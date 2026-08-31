/**
 * AD-1 enforcement — the dependency direction of the whole codebase.
 *
 * Layer map (spine "Design Paradigm"):
 *   domain + schemas            core
 *     <- pipeline, authoring, ingest, report      application
 *       <- providers, surfaces, infra, config     adapters
 *         <- cli                                   edge
 *
 * Adapters depend on the core; never the reverse. These rules are what every
 * later story inherits, so they are deliberately strict: loosening one is a
 * conversation (or an ADR), not a quiet edit in a feature PR.
 *
 * Scope note: only `src/` is scanned. Tests legitimately import `src/cli/**`
 * (story 1.2's exit-mapping tests do exactly that) and are not part of the
 * shipped dependency graph.
 */

/** Node built-ins that perform I/O or otherwise carry side effects. */
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

const builtinPattern = `^(node:)?(${SIDE_EFFECT_BUILTINS.join('|')})$`;

module.exports = {
  forbidden: [
    {
      name: 'domain-is-dependency-free',
      comment:
        'AD-1: src/domain/** is pure TypeScript. It may import other domain modules and ' +
        'nothing else — no npm packages (zod included: zod belongs in src/schemas/**), ' +
        'no Node built-ins, no other layer. This is what makes verdict and error logic ' +
        'testable without any I/O.',
      severity: 'error',
      from: { path: '^src/domain/' },
      to: { pathNot: '^src/domain/' },
    },
    {
      name: 'schemas-core-only',
      comment:
        'AD-1: src/schemas/** may import src/domain/**, its own siblings, and zod. ' +
        'Nothing else — schemas validate, they do not reach out.',
      severity: 'error',
      from: { path: '^src/schemas/' },
      to: {
        pathNot: '^src/(domain|schemas)/',
        dependencyTypesNot: ['npm'],
      },
    },
    {
      name: 'schemas-npm-allowlist',
      comment: 'AD-1: zod is the only npm dependency permitted inside src/schemas/**.',
      severity: 'error',
      from: { path: '^src/schemas/' },
      to: {
        dependencyTypes: ['npm'],
        // Substring rather than an anchored path: pnpm resolves through its
        // content-addressable store (node_modules/.pnpm/zod@4.5.4/node_modules/zod/…),
        // so an anchored `^node_modules/zod/` would never match under pnpm.
        pathNot: 'node_modules/zod/',
      },
    },
    {
      name: 'no-side-effect-builtins-in-core',
      comment:
        'AD-1: the core never performs I/O. Side effects live behind ports, with the ' +
        'adapters at the edge.',
      severity: 'error',
      from: { path: '^src/(domain|schemas)/' },
      to: { path: builtinPattern, dependencyTypes: ['core'] },
    },
    {
      name: 'nothing-imports-cli',
      comment:
        'AD-1: src/cli/** is the outermost edge (commander wiring, the exit table, ' +
        'argument normalization). Nothing beneath it may depend on it — that would ' +
        'invert the dependency direction and let the exit table leak inward.',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/cli/' },
      to: { path: '^src/cli/' },
    },
    {
      name: 'adapters-core-only',
      comment:
        'AD-1: adapters (config, infra, providers, surfaces) translate the outside ' +
        'world into core types. They may import src/domain/** and src/schemas/** and ' +
        'npm packages — not the application layer, not the edge, not each other. If a ' +
        'story needs an adapter-to-adapter call, that is a port in src/domain/, ' +
        'injected by the caller.',
      severity: 'error',
      from: { path: '^src/(config|infra|providers|surfaces)/' },
      to: {
        path: '^src/',
        // `$1` back-references the adapter matched in `from`, so an adapter may
        // always import its own siblings (src/config/load.ts -> src/config/schema.ts).
        pathNot: ['^src/(domain|schemas)/', '^src/$1/'],
      },
    },
    {
      name: 'ingest-core-only',
      comment:
        'AD-1/Q2: src/ingest/** is application-layer. It may import src/domain/**, ' +
        'src/schemas/**, its own siblings and npm packages — never cli, config, infra, ' +
        'providers or surfaces. This is the other half of the FR-6 promise: BMAD-specific ' +
        'types never leave this directory, so a second ingestion source (question Q4) is a ' +
        'new reader rather than an edit to contract logic. Node built-ins are allowed — ' +
        'reading planning artifacts off disk is exactly what this layer is for.',
      severity: 'error',
      from: { path: '^src/ingest/' },
      // `$1` is not used here: unlike `adapters-core-only`, which back-references
      // the adapter it matched, `src/ingest` is a single named layer, so its own
      // siblings are simply listed alongside the core.
      to: { path: '^src/', pathNot: ['^src/(domain|schemas|ingest)/'] },
    },
    {
      name: 'no-circular',
      comment:
        'A cycle means the layer boundary is already gone and the modules can no longer ' +
        'be reasoned about — or tested — independently.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-unresolvable',
      comment: 'An import that does not resolve is a build waiting to break.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'not-to-dev-dep',
      comment:
        'Shipped code must not import a devDependency: it is absent from the published ' +
        'tarball, so this fails only for the user, only after install.',
      severity: 'error',
      from: { path: '^src/', pathNot: '\\.test\\.ts$' },
      to: { dependencyTypes: ['npm-dev'] },
    },
    {
      name: 'no-deprecated-core',
      comment: 'Deprecated Node core APIs are removed on a schedule we do not control.',
      severity: 'error',
      from: {},
      to: { dependencyTypes: ['core'], path: '^(punycode|domain|sys|constants)$' },
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.js', '.mjs', '.cjs'],
      mainFields: ['module', 'main', 'types'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
