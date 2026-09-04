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
        'AD-1: src/schemas/** may import src/domain/**, its own siblings and zod. ' +
        'Nothing else — schemas validate, they do not reach out. `node:crypto` is ' +
        'permitted in exactly one file; see `schemas-canonical-is-the-only-hasher`.',
      severity: 'error',
      // `canonical.ts` is excluded here and constrained by its own rule below.
      // dependency-cruiser's `forbidden` rules are OR-ed, so an exception cannot
      // be added by a later rule — the file has to be lifted out of this one.
      from: { path: '^src/schemas/', pathNot: '^src/schemas/canonical\\.ts$' },
      to: {
        pathNot: '^src/(domain|schemas)/',
        dependencyTypesNot: ['npm'],
      },
    },
    {
      name: 'schemas-canonical-is-the-only-hasher',
      comment:
        'AD-5: `schemas/canonical.ts` is THE single implementation of the contract ' +
        'fingerprint, and a fingerprint needs SHA-256. It may import the core, its ' +
        'siblings, zod and `node:crypto` — nothing else. Scoping the allowance to ' +
        'this one path rather than to `src/schemas/**` is the point: a second module ' +
        'hashing contract content would be a second answer to "has this contract ' +
        'changed", and that is the one question the product cannot have two answers ' +
        'to. Every other schema module importing crypto still fails as ' +
        '`schemas-core-only`, and `tests/unit/dependency-rules.test.ts` pins both ' +
        'directions so this cannot quietly widen back to the whole directory.',
      severity: 'error',
      from: { path: '^src/schemas/canonical\\.ts$' },
      to: {
        pathNot: ['^src/(domain|schemas)/', '^(node:)?crypto$'],
        dependencyTypesNot: ['npm'],
      },
    },
    {
      name: 'schemas-npm-allowlist',
      comment:
        'AD-1: zod and yaml are the only npm dependencies permitted inside ' +
        'src/schemas/**. Both are pure in-memory codecs; neither reaches out.',
      severity: 'error',
      from: { path: '^src/schemas/' },
      to: {
        dependencyTypes: ['npm'],
        // Substring rather than an anchored path: pnpm resolves through its
        // content-addressable store (node_modules/.pnpm/zod@4.5.4/node_modules/zod/…),
        // so an anchored `^node_modules/zod/` would never match under pnpm.
        //
        // `yaml` was added by story 2.2. AD-5 makes contracts human-readable
        // YAML, and their schema module owns the text<->model conversion that
        // `parseContract`/`serializeContract` perform — a pure string
        // transformation with no I/O in it, which is why the rule's actual
        // subject ("schemas validate, they do not reach out") is untouched.
        // The line this rule defends is side effects and layer inversion, not
        // the package count: `execa`, `node:fs` and every adapter import stay
        // forbidden here, and `tests/unit/dependency-rules.test.ts` pins both
        // halves so the allowlist cannot drift into "npm is fine in schemas".
        pathNot: ['node_modules/zod/', 'node_modules/yaml/'],
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
      name: 'pipeline-layer',
      comment:
        'AD-1: src/pipeline/** is application-layer, and a WIDER one than src/ingest. The ' +
        'spine graph gives it PIPE -> DOM, PIPE -> SURF, PIPE -> CFG, PIPE -> INFRA and ' +
        'PIPE -> PROV, so it may import domain, schemas, its own siblings, config, infra, ' +
        'providers, surfaces and npm. What it may NOT import is another APPLICATION layer ' +
        '(authoring, ingest, report) or the edge (cli) — and that is the half with teeth. ' +
        'Two consequences the epic depends on: the pipeline cannot reach a renderer, so no ' +
        'stage can print (AD-11 keeps one result model and many renderers); and the ' +
        'integrity stage cannot import `assertVerifiableContract` from src/authoring, so ' +
        'the CLI edge loads and verifies the contract and passes the result IN, exactly as ' +
        'config is loaded once, validated and passed down. That seam is deliberate, not a ' +
        'workaround. Node built-ins are allowed: the pipeline orchestrates adapters that ' +
        'do I/O, though every stage receives its ports by injection.',
      severity: 'error',
      // `cli` is absent from the permit list rather than called out separately, exactly as
      // `ingest-core-only` leaves it: `nothing-imports-cli` also fires, which is the
      // established shape here and not worth a second rule.
      from: { path: '^src/pipeline/' },
      to: {
        path: '^src/',
        pathNot: ['^src/(domain|schemas|pipeline|config|infra|providers|surfaces)/'],
      },
    },
    {
      name: 'authoring-layer',
      comment:
        'AD-1: src/authoring/** is application-layer — the contract and plan authoring ' +
        'services (generate, freeze, amend, compile, explain, and 5.6\'s mechanics ' +
        'adaptation). The spine\'s layer graph gives it AUTH -> DOM (domain + schemas), ' +
        'AUTH -> ING and AUTH -> PROV, so it may import domain, schemas, its own ' +
        'siblings, ingest, providers and npm. What it may NOT import is an adapter that ' +
        'is not `providers` (config, infra, surfaces), another application layer ' +
        '(pipeline, report) or the edge (cli). ' +
        'THE HALF WITH TEETH IS `infra`. Authoring reads and writes contract and plan ' +
        'FILES with `node:fs` directly (contract-file.ts, plan-file.ts), which is ' +
        'allowed — built-ins are not a layer. But reaching `src/infra/run-store.ts` or ' +
        '`src/infra/vcs.ts` from here would let an authoring service touch run evidence ' +
        'or the repository, and the spine puts both of those behind the pipeline; the ' +
        'CLI edge orchestrates authoring before and outside the pipeline, and the ' +
        'pipeline never authors. `providers` is permitted because AD-2 routes every ' +
        'provider call through the ONE shared invoke gate in src/providers/invoke.ts, ' +
        'which authoring is the principal caller of; `ingest` is permitted because the ' +
        'spine draws that edge, even though nothing under src/authoring uses it today — ' +
        'narrowing a rule below the binding graph would be a redesign made by a lint ' +
        'file rather than by an ADR. ' +
        'This rule is Epic 5 action item e5-C. Its three siblings (`ingest-core-only`, ' +
        '`pipeline-layer`, `report-layer`) existed while `authoring` appeared only ' +
        'inside their prose, so the layer that holds plan.ts, amend.ts, explain.ts and ' +
        'the adaptation modules was fenced by nothing at all: an Epic 5 agent planted ' +
        '`authoring -> infra` and watched depcruise pass, and that is what proved the ' +
        'rule missing. `tests/unit/dependency-rules.test.ts` pins both directions.',
      severity: 'error',
      // `cli` is absent from the permit list rather than called out separately, exactly as
      // `ingest-core-only` and `pipeline-layer` leave it: `nothing-imports-cli` also fires.
      from: { path: '^src/authoring/' },
      to: {
        path: '^src/',
        pathNot: ['^src/(domain|schemas|authoring|ingest|providers)/'],
      },
    },
    {
      name: 'report-layer',
      comment:
        'AD-11/AD-1: src/report/** is application-layer and the STRICTEST of them — the ' +
        "spine's layer graph shows only `REP -> DOM`. It may import src/domain/**, " +
        'src/schemas/**, its own siblings and npm packages. Nothing else, and — unlike ' +
        '`ingest-core-only` — no side-effectful Node built-in either. That last part is ' +
        'the rule\'s real subject: AD-11 says the terminal and JSON renderers derive ' +
        'everything from one RunResult and compute no facts of their own, and this is ' +
        'that promise expressed structurally rather than left to review. A renderer that ' +
        'cannot open a file, read the config or reach the pipeline cannot look up a fact ' +
        'the model does not carry — so the human report and the machine document cannot ' +
        'drift apart, which is the failure AD-11 exists to prevent. It is a security ' +
        'control too: a renderer that cannot import `node:fs` cannot read a credential ' +
        'off disk in order to print it. `cli` is deliberately not re-listed here — ' +
        '`nothing-imports-cli` already covers it, and a guard duplicated is a guard with ' +
        'two places to weaken. The one import this rule was negotiated over: story 3.5 ' +
        "puts the `result.json` serializer in `src/schemas/result.ts` and NOT in " +
        '`src/infra/run-store.ts`, because a serializer inside an adapter is one the JSON ' +
        'renderer could not legally call — and `--json` would then need a second ' +
        'serializer, which is exactly how two byte sequences appear where the harness ' +
        'contract requires one. `tests/unit/dependency-rules.test.ts` pins both ' +
        'directions.',
      severity: 'error',
      from: { path: '^src/report/' },
      to: {
        // Two matchers, OR-ed: every other `src/` layer, plus the side-effect
        // built-ins. npm packages match neither and stay permitted, as do pure
        // built-ins like `node:path` — string work is not I/O.
        path: ['^src/', builtinPattern],
        pathNot: ['^src/(domain|schemas|report)/'],
      },
    },
    {
      name: 'scorecard-is-local-only',
      comment:
        'NFR-4 / AC1 of story 6.5 / the founding local-first product rule: the dogfooding ' +
        'scorecard is written to the operator\'s own disk and goes NOWHERE ELSE. The two ' +
        'scorecard modules may not import a networking built-in (http, https, http2, net, ' +
        'tls, dgram, dns) or an HTTP client. ' +
        'WHY A RULE AND NOT A CONVENTION. `.specwitness/scorecard.jsonl` is the one place ' +
        'in this product where a contributor might reasonably think telemetry belongs — ' +
        'it is literally a file of usage metrics — which is exactly why the acceptance ' +
        'criterion forecloses it and why the ban is structural rather than a comment ' +
        'somebody has to read. `src/schemas/scorecard.ts` is already covered by ' +
        '`schemas-core-only` (schemas may import no built-in at all), so the half that ' +
        'earns this rule its keep is `src/infra/scorecard-store.ts`: `src/infra/**` may ' +
        'legitimately use any Node built-in, and without this rule a single `node:https` ' +
        'import beside the `node:fs` one would pass every other check in this file. ' +
        'THE HONEST LIMIT: dependency-cruiser sees IMPORTS. Node\'s global `fetch` needs ' +
        'none, so it is not caught here — `tests/unit/dependency-rules.test.ts` scans the ' +
        'two modules\' source for it, and plants a `node:https` import to watch this rule ' +
        'fire. Neither guard alone is sufficient; both are cheap.',
      severity: 'error',
      from: { path: '^src/(schemas/scorecard|infra/scorecard-store)\\.ts$' },
      to: {
        path: [
          '^(node:)?(http|https|http2|net|tls|dgram|dns)$',
          // Anything whose job is to fetch. Named rather than inferred: a future
          // dependency added for an unrelated reason must not silently become reachable
          // from this path.
          'node_modules/(axios|node-fetch|undici|got|superagent|ws|request)/',
        ],
      },
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
