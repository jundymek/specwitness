import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

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
 * Hermetic by construction (story 2.8). Until 2.8 these tests wrote scratch
 * modules with FIXED names into the real `src/` and cruised the whole tree.
 * The harness runs `pnpm test` from Codex on every push, inside the agent's
 * own worktree, concurrently with whatever the agent is running — so two
 * vitest processes in one worktree is the normal condition, and process B
 * routinely saw process A's deliberately-violating probe. A red verdict then
 * said nothing about the rules, only about who else was running tests.
 *
 * Every probe now lives in a per-test copy of the tracked source under the OS
 * temp directory, and `depcruise` runs with its `cwd` set there. Nothing is
 * ever written under the real `src/`: concurrent processes have disjoint
 * directories, and a `SIGKILL` — which runs no `afterEach` and no signal
 * handler — can leave nothing behind in the worktree, because nothing in the
 * worktree was ever touched.
 *
 * What the copy must contain, and why each part matters (getting this wrong
 * makes every case pass for the wrong reason, which is worse than failing):
 *
 *  - the TRACKED `src/` only (`git ls-files src`), so a stray `__probe-*.ts`
 *    from an older checkout can never enter the copy;
 *  - `tsconfig.json`, because `tsConfig` + `tsPreCompilationDeps` are what let
 *    the rules see type-only imports at all — the property
 *    `domain-is-dependency-free` rests on;
 *  - `package.json`, because without it dependency-cruiser does not classify
 *    an import of zod or yaml as `dependencyTypes: ['npm']`, and
 *    `schemas-core-only` then fires on the five legitimate core imports —
 *    a clean copy reporting violations, which would make the permit cases
 *    meaningless;
 *  - `node_modules` as a SYMLINK (109 MB; copying it per test is not an
 *    option, and with `package.json` present the classification is correct).
 *
 * The `the temp copy reproduces the real tree` describe below asserts the copy
 * resolves correctly — a clean verdict, identical counts across two
 * independent copies, and every tracked module actually cruised — so a future
 * config addition this copy misses fails loudly instead of quietly weakening
 * every case.
 */

/** Every temp copy this file made, so `afterEach` can remove them. */
const tempCopies: string[] = [];

/** Files the copy needs beyond `src/`; see the header for why each is here. */
const COPIED_ROOT_FILES = ['tsconfig.json', 'package.json', '.dependency-cruiser.cjs'] as const;

/** The tracked source file list, read once — `git ls-files` is not free. */
let trackedSources: string[] = [];

beforeAll(async () => {
  const { stdout } = await execa('git', ['ls-files', 'src'], { cwd: REPO_ROOT });
  trackedSources = stdout.split('\n').filter(Boolean);
  expect(trackedSources.length).toBeGreaterThan(0);
});

/**
 * A fresh copy of the tracked source tree in the OS temp directory. Per test,
 * so two cases never see each other's probes even inside one process, and two
 * processes never share a directory at all.
 */
async function makeTempTree(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'specwitness-depcruise-'));
  tempCopies.push(dir);

  for (const file of trackedSources) {
    const target = join(dir, file);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(REPO_ROOT, file), target);
  }
  for (const file of COPIED_ROOT_FILES) {
    await cp(join(REPO_ROOT, file), join(dir, file));
  }
  await symlink(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'));

  return dir;
}

/** Writes a scratch module into a temp copy. Never touches the real `src/`. */
async function writeModule(tree: string, relativePath: string, contents: string): Promise<void> {
  const full = join(tree, 'src', relativePath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, contents, 'utf8');
}

/**
 * The `depcruise` binary is invoked directly rather than through `pnpm exec`.
 * `pnpm exec` in a directory whose `node_modules` is a symlink out of the tree
 * runs a dependency-status check and tries to `pnpm install`, which fails with
 * ERR_PNPM_UNSAFE_MODULES_DIR. It happens to work under `pnpm test` only
 * because vitest inherits pnpm's own environment — a test that passes because
 * of how it was launched is exactly the kind of accident this story removes.
 */
const DEPCRUISE_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'depcruise');

async function depcruise(tree: string): Promise<{ exitCode: number | undefined; output: string }> {
  const result = await execa(
    DEPCRUISE_BIN,
    ['src', '--config', '.dependency-cruiser.cjs'],
    { cwd: tree, reject: false },
  );
  return { exitCode: result.exitCode, output: `${result.stdout}\n${result.stderr}` };
}

afterEach(async () => {
  for (const dir of tempCopies.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

/*
 * On the one thing this cleanup deliberately does NOT guarantee: a `SIGKILL`
 * mid-test leaves its temp copy behind, because no `afterEach` runs. That is
 * the accepted trade-off, not an oversight. AC3 is about the worktree — a
 * scratch module sitting where real source lives is what corrupts another
 * process's cruise and what `git status` reports as a dirty tree. An abandoned
 * directory under the OS temp dir does neither: it is invisible to git, cannot
 * be picked up by any cruise (each copy is a fresh `mkdtemp`), and is reaped by
 * the OS. Nothing in-process can survive a `SIGKILL`, which is precisely why
 * the design moves the writes out of `src/` instead of trying to clean up
 * better.
 */

describe('the temp copy reproduces the real tree', () => {
  it('cruises the whole tracked tree, cleanly, and identically across copies', async () => {
    // The failure this guards against is the worst one available here: a copy
    // that resolves differently from the real tree makes every case below pass
    // for the wrong reason. A copy missing `package.json`, for instance, stops
    // classifying zod and yaml as `npm` and reports five violations that are
    // not there; a copy missing `tsconfig.json` loses the type-only imports
    // that `domain-is-dependency-free` rests on.
    //
    // Deliberately NOT compared against a live `pnpm depcruise` of the real
    // `src/`. That was the first version of this test and it was wrong: the
    // real tree is mutable, so any file another process or another story was
    // holding there — a probe from an older checkout, a module being written
    // right now — changed the module count and turned this red for reasons
    // that have nothing to do with the rules. That is the exact defect story
    // 2.8 exists to remove, reintroduced in the guard meant to protect it.
    //
    // Two independent copies are compared instead. Both are built from
    // `git ls-files src`, so both are deterministic regardless of what the
    // worktree happens to contain, and any divergence in resolution shows up
    // as a count mismatch.
    const [first, second] = await Promise.all([makeTempTree(), makeTempTree()]);

    const a = await depcruise(first);
    const b = await depcruise(second);

    const counts = (output: string): string | undefined =>
      output.match(/(\d+) modules, (\d+) dependencies cruised/)?.[0];

    expect(a.output).toContain('no dependency violations found');
    expect(a.exitCode).toBe(0);
    expect(counts(a.output)).toBeDefined();
    expect(counts(b.output)).toBe(counts(a.output));

    // A cruise that silently found nothing would also report "no violations",
    // so the tree must demonstrably be non-trivial: every tracked module is
    // expected to be cruised.
    const trackedModuleCount = trackedSources.filter((f) => f.endsWith('.ts')).length;
    const modulesCruised = Number(a.output.match(/(\d+) modules/)?.[1]);
    expect(modulesCruised).toBeGreaterThanOrEqual(trackedModuleCount);
  });

  it('sees a violating probe written into the copy', async () => {
    // The other half: a clean baseline alone proves nothing, because an empty
    // or unresolvable tree is also clean.
    const tree = await makeTempTree();
    await writeModule(
      tree,
      'domain/__probe-canary.ts',
      "import { readFileSync } from 'node:fs';\nexport const r = readFileSync;\n",
    );

    const { exitCode, output } = await depcruise(tree);

    expect(output).toContain('domain-is-dependency-free');
    expect(exitCode).not.toBe(0);
  });

  it('writes nothing under the real src/', async () => {
    // A name unique to this process, so the assertion below is about THIS
    // test's probe and nothing else. Asserting on `__probe-` in general — let
    // alone on an empty `git status` — would go red because of a file some
    // other process or story left in the worktree, which is the very disease
    // this story cures: a verdict about who else is touching the tree rather
    // than about the rules.
    const unique = `__probe-elsewhere-${process.pid}-${Date.now()}`;
    const tree = await makeTempTree();
    await writeModule(tree, `domain/${unique}.ts`, 'export const x = 1;\n');
    await depcruise(tree);

    // The AC3 claim, stated exactly: no scratch module of ours survives where
    // real source lives.
    const { stdout } = await execa('git', ['status', '--porcelain', 'src/'], { cwd: REPO_ROOT });
    expect(stdout.split('\n').filter((line) => line.includes(unique))).toEqual([]);

    // And the probe exists only in the copy.
    await expect(readFile(join(SRC, 'domain', `${unique}.ts`), 'utf8')).rejects.toThrow();
    await expect(readFile(join(tree, 'src', 'domain', `${unique}.ts`), 'utf8')).resolves.toContain(
      'export const x = 1;',
    );
  });
});

describe('AD-1 rules permit what later stories legitimately need', () => {
  it('lets an adapter import its own siblings', async () => {
    // Story 1.3's exact shape. If this fails, `$1` group-matching broke.
    const tree = await makeTempTree();
    await writeModule(tree, 'config/__probe-schema.ts', 'export const schema = 1;\n');
    await writeModule(
      tree,
      'config/__probe-load.ts',
      "import { schema } from './__probe-schema.js';\nexport const load = schema;\n",
    );

    const { exitCode, output } = await depcruise(tree);

    expect(output).not.toContain('adapters-core-only');
    expect(exitCode).toBe(0);
  });

  it('lets src/infra use Node built-ins', async () => {
    // Story 1.6's exact shape: RunStore is the sole writer under
    // .specwitness/runs/ (AD-8) and Ids needs randomness.
    const tree = await makeTempTree();
    await writeModule(
      tree,
      'infra/__probe-run-store.ts',
      "import { randomBytes } from 'node:crypto';\n" +
        "import { mkdirSync } from 'node:fs';\n" +
        "import { join } from 'node:path';\n" +
        'export const id = () => randomBytes(4).toString("hex");\n' +
        'export const mk = (d: string) => mkdirSync(join(d, "runs"), { recursive: true });\n',
    );

    const { exitCode, output } = await depcruise(tree);

    expect(output).not.toContain('no-side-effect-builtins-in-core');
    expect(exitCode).toBe(0);
  });

  it('lets src/schemas import zod', async () => {
    const tree = await makeTempTree();
    await writeModule(
      tree,
      'schemas/__probe-manifest.ts',
      "import { z } from 'zod';\nexport const s = z.string();\n",
    );

    const { exitCode, output } = await depcruise(tree);

    expect(output).not.toContain('schemas-npm-allowlist');
    expect(exitCode).toBe(0);
  });

  it('lets src/ingest use Node built-ins, the core, and its own siblings', async () => {
    // Story 2.1's exact shape: ingestion is application-layer, it reads
    // planning artifacts off disk, and it composes the domain model with its
    // zod mirror. If this fails, the ingest reader cannot be written at all.
    const tree = await makeTempTree();
    await writeModule(tree, 'ingest/__probe-source.ts', 'export const source = 1;\n');
    await writeModule(
      tree,
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

    const { exitCode, output } = await depcruise(tree);

    expect(output).not.toContain('ingest-core-only');
    expect(exitCode).toBe(0);
  });

  it('lets src/schemas/canonical.ts use node:crypto, and only that file', async () => {
    // AD-5 names `schemas/canonical.ts` as THE single implementation of the
    // contract fingerprint, and a fingerprint needs SHA-256. The permission is
    // scoped to that one path rather than to the directory: a second module
    // hashing contract content would be a second answer to "has this changed",
    // which is the one question the product cannot have two answers to.
    //
    // The real `src/schemas/canonical.ts` is the proof that the allowance
    // works — it imports `node:crypto` today and the baseline cruise below is
    // clean. The narrowing half is the next test.
    const tree = await makeTempTree();
    const canonical = await readFile(join(tree, 'src', 'schemas', 'canonical.ts'), 'utf8');
    expect(canonical).toContain("from 'node:crypto'");

    const { exitCode, output } = await depcruise(tree);

    expect(output).not.toContain('schemas-core-only');
    expect(exitCode).toBe(0);
  });

  it('lets src/schemas import yaml', async () => {
    // Story 2.2 again: AD-5 makes contracts human-readable YAML, and
    // `schemas/contract.ts` owns `parseContract`/`serializeContract`. A pure
    // text codec is not "reaching out"; the forbidding half is pinned below.
    const tree = await makeTempTree();
    await writeModule(
      tree,
      'schemas/__probe-yaml.ts',
      "import { stringify } from 'yaml';\nexport const s = stringify;\n",
    );

    const { exitCode, output } = await depcruise(tree);

    expect(output).not.toContain('schemas-npm-allowlist');
    expect(exitCode).toBe(0);
  });
});

describe('AD-1 rules still forbid what they are meant to forbid', () => {
  it('blocks one adapter importing another', async () => {
    const tree = await makeTempTree();
    await writeModule(tree, 'infra/__probe-runner.ts', 'export const runner = 1;\n');
    await writeModule(
      tree,
      'config/__probe-cross.ts',
      "import { runner } from '../infra/__probe-runner.js';\nexport const bad = runner;\n",
    );

    const { exitCode, output } = await depcruise(tree);

    expect(output).toContain('adapters-core-only');
    expect(exitCode).not.toBe(0);
  });

  it('blocks anything importing the cli edge', async () => {
    const tree = await makeTempTree();
    await writeModule(
      tree,
      'config/__probe-to-edge.ts',
      "import { EXIT } from '../cli/exit.js';\nexport const bad = EXIT;\n",
    );

    const { exitCode, output } = await depcruise(tree);

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
    const tree = await makeTempTree();
    await writeModule(
      tree,
      'schemas/__probe-bad.ts',
      "import { execa } from 'execa';\nexport const e = execa;\n",
    );

    const { exitCode, output } = await depcruise(tree);

    expect(output).toContain('schemas-npm-allowlist');
    expect(exitCode).not.toBe(0);
  });

  it('blocks a BMAD type leaking out of src/ingest into an adapter', async () => {
    // The AC4 guarantee, red-tested: FR-6 says no BMAD-specific type may be
    // imported outside `ingest/`. A rule with no proof that it fires is not a
    // guardrail, and Epic 1's retrospective names this lesson explicitly.
    // `src/config` rather than `src/cli`, so the failure can only be
    // `ingest-core-only` and not `nothing-imports-cli`.
    const tree = await makeTempTree();
    await writeModule(
      tree,
      'ingest/__probe-leak.ts',
      "import { loadConfig } from '../config/load.js';\nexport const bad = loadConfig;\n",
    );

    const { exitCode, output } = await depcruise(tree);

    expect(output).toContain('ingest-core-only');
    expect(exitCode).not.toBe(0);
  });

  it('blocks a Node built-in other than crypto inside src/schemas', async () => {
    // The other half of story 2.2's `node:crypto` carve-out. Without this the
    // allowance could widen to "src/schemas may use built-ins" and nothing
    // would fail — schemas would be free to read the filesystem, and the whole
    // point of a pure core is that it cannot.
    const tree = await makeTempTree();
    await writeModule(
      tree,
      'schemas/__probe-fs.ts',
      "import { readFileSync } from 'node:fs';\nexport const r = readFileSync;\n",
    );

    const { exitCode, output } = await depcruise(tree);

    expect(output).toContain('schemas-core-only');
    expect(exitCode).not.toBe(0);
  });

  it('blocks node:crypto in a schemas module that is NOT canonical.ts', async () => {
    // The finding this test exists for: the first version of the carve-out was
    // scoped `from: ^src/schemas/`, so it silently granted every present and
    // future schema module access to crypto — while its own comment claimed to
    // be the narrowest possible exception. AD-5 wants ONE fingerprint
    // implementation, and a rule that permits a second one is not enforcing it.
    const tree = await makeTempTree();
    await writeModule(
      tree,
      'schemas/__probe-second-hash.ts',
      "import { createHash } from 'node:crypto';\n" +
        'export const h = (s: string) => createHash("sha256").update(s).digest("hex");\n',
    );

    const { exitCode, output } = await depcruise(tree);

    expect(output).toContain('schemas-core-only');
    expect(exitCode).not.toBe(0);
  });

  it('blocks a side-effectful built-in inside src/domain', async () => {
    const tree = await makeTempTree();
    await writeModule(
      tree,
      'domain/__probe-scratch.ts',
      "import { readFileSync } from 'node:fs';\nexport const r = readFileSync;\n",
    );

    const { exitCode, output } = await depcruise(tree);

    expect(output).toContain('domain-is-dependency-free');
    expect(exitCode).not.toBe(0);
  });
});

/*
 * Story 3.3 appends this describe; it restructures nothing above. Story 3.6 appends its
 * own for `report-layer` in wave B. The three of us share this file and share zero
 * `expect()`, which is a stronger guarantee than "we coordinated".
 */
describe('the pipeline-layer rule (story 3.3)', () => {
  it('blocks src/pipeline from importing another application layer', async () => {
    // The exact import the integrity stage would most naturally have written:
    // `assertVerifiableContract` lives in src/authoring, and reaching for it is the
    // obvious move until this rule says no. The rule is what turns "we decided the CLI
    // edge passes the verified contract in" into something a later story cannot undo by
    // accident — and this test is what proves the rule actually matches, since a clean
    // depcruise run proves only that nobody has violated it yet.
    const tree = await makeTempTree();
    await writeModule(
      tree,
      'pipeline/__probe-authoring.ts',
      "import { assertVerifiableContract } from '../authoring/verifiable.js';\n" +
        'export const guard = assertVerifiableContract;\n',
    );

    const { exitCode, output } = await depcruise(tree);

    expect(output).toContain('pipeline-layer');
    expect(exitCode).not.toBe(0);
  });

  it('blocks src/pipeline from importing a renderer, so no stage can print', async () => {
    // AD-11's structural half: one result model, many renderers. A pipeline that can
    // reach src/report is a pipeline that can print, and a stage that prints is a second
    // renderer nobody registered.
    const tree = await makeTempTree();
    await writeModule(tree, 'report/__probe-terminal.ts', 'export const render = () => "x";\n');
    await writeModule(
      tree,
      'pipeline/__probe-printing-stage.ts',
      "import { render } from '../report/__probe-terminal.js';\nexport const p = render;\n",
    );

    const { exitCode, output } = await depcruise(tree);

    expect(output).toContain('pipeline-layer');
    expect(exitCode).not.toBe(0);
  });

  it('lets src/pipeline import domain, schemas, config, infra and its own siblings', async () => {
    // The permit half, and it is not decoration: story 3.4's gates stage imports config
    // (to read gate declarations) and infra (the process runner), and story 3.5's persist
    // stage imports the run store. A rule that came out one directory too narrow would
    // block the first wave-B story to write a line — which is why it is pinned here in
    // wave A rather than discovered there.
    const tree = await makeTempTree();
    await writeModule(tree, 'pipeline/__probe-sibling.ts', 'export const sibling = 1;\n');
    await writeModule(
      tree,
      'pipeline/__probe-stage.ts',
      "import { InfraError } from '../domain/errors.js';\n" +
        "import { SCHEMA_VERSIONS } from '../schemas/versions.js';\n" +
        "import { loadConfig } from '../config/index.js';\n" +
        "import { SystemClock } from '../infra/clock.js';\n" +
        "import { sibling } from './__probe-sibling.js';\n" +
        'export const p = { InfraError, SCHEMA_VERSIONS, loadConfig, SystemClock, sibling };\n',
    );

    const { exitCode, output } = await depcruise(tree);

    expect(output).not.toContain('pipeline-layer');
    expect(exitCode).toBe(0);
  });
});


/**
 * Story 3.6 — the `report-layer` rule.
 *
 * APPENDED, deliberately. Story 3.3 appended `pipeline-layer` cases to this
 * same file in wave A and this describe shares **zero `expect()`** with them:
 * two stories in one file that assert on each other's cases is how a rebase
 * turns into a merge negotiation (Epic 2's pattern).
 *
 * What the rule is for. `src/report/**` renders a `RunResult` and computes
 * nothing (AD-11). That promise is enforced structurally rather than by
 * review: a renderer that cannot import `src/infra/`, `src/config/` or
 * `node:fs` cannot look up a fact the model does not already carry, and cannot
 * read a secret off disk to print it either. The spine's layer graph shows
 * `REP -> DOM` and nothing else, which makes this the strictest of the
 * application layers — stricter than `ingest-core-only`, which permits Node
 * built-ins because reading planning artifacts off disk is what ingestion is.
 */
describe('the report layer may reach the core and nothing else', () => {
  it('blocks src/report from importing node:fs', async () => {
    // The AC3 property in its most direct form: a renderer that can open a
    // file can compute a fact the RunResult does not contain, and the terminal
    // and JSON views have drifted before anyone notices.
    const tree = await makeTempTree();
    await writeModule(
      tree,
      'report/__probe-reads-disk.ts',
      "import { readFileSync } from 'node:fs';\n" +
        'export const contractStatus = (p: string) => readFileSync(p, "utf8");\n',
    );

    const { exitCode, output } = await depcruise(tree);

    expect(output).toContain('report-layer');
    expect(exitCode).not.toBe(0);
  });

  it('blocks src/report from importing an adapter', async () => {
    // The specific import this rule was negotiated over: story 3.5's
    // serializer had to live in `src/schemas/result.ts` rather than in
    // `src/infra/run-store.ts`, because a serializer inside infra is one the
    // JSON renderer cannot legally call — and the byte-equality property would
    // then need a second serializer, which is what guarantees drift.
    const tree = await makeTempTree();
    await writeModule(
      tree,
      'report/__probe-imports-infra.ts',
      "import { SystemClock } from '../infra/clock.js';\nexport const c = SystemClock;\n",
    );

    const { exitCode, output } = await depcruise(tree);

    expect(output).toContain('report-layer');
    expect(exitCode).not.toBe(0);
  });

  it('blocks src/report from importing another application layer', async () => {
    // Application layers do not import each other. `report` reading `ingest`
    // (or `authoring`, or `pipeline`) would let a renderer re-derive a fact
    // from the planning artifacts instead of rendering the model it was given.
    const tree = await makeTempTree();
    await writeModule(
      tree,
      'report/__probe-imports-ingest.ts',
      "import { normalizeRepoPath } from '../ingest/repo-path.js';\n" +
        'export const n = normalizeRepoPath;\n',
    );

    const { exitCode, output } = await depcruise(tree);

    expect(output).toContain('report-layer');
    expect(exitCode).not.toBe(0);
  });

  it('lets src/report import the core, its own siblings and npm', async () => {
    // The permit half. A rule that forbids everything is not a guard, it is a
    // wall: this is the exact shape the two renderers ship as — the domain
    // model in, the schemas serializer for the persisted bytes, and one
    // sibling module for the shared vocabulary.
    const tree = await makeTempTree();
    await writeModule(tree, 'report/__probe-glyphs.ts', "export const PASS = '\\u2713 pass';\n");
    await writeModule(
      tree,
      'report/__probe-render.ts',
      "import type { CriterionResult } from '../domain/result.js';\n" +
        "import { SCHEMA_VERSIONS } from '../schemas/versions.js';\n" +
        "import { PASS } from './__probe-glyphs.js';\n" +
        'export const render = (c: CriterionResult): string =>\n' +
        '  `${c.criterionId} ${PASS} ${SCHEMA_VERSIONS.resultTaxonomy}`;\n',
    );

    const { exitCode, output } = await depcruise(tree);

    expect(output).not.toContain('report-layer');
    expect(exitCode).toBe(0);
  });
});
