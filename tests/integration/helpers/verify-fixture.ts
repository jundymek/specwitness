/**
 * Inline fixtures for the story 3.7 end-to-end suite.
 *
 * **These are NOT Golden Verification Corpus fixtures.** `fixtures/corpus/` is
 * Epic 6 and does not exist yet; the epics file's references to "Golden Corpus
 * fixture 7/8" are forward references. Everything here is built by the test that
 * uses it, in a per-test temp directory, and torn down afterwards — so a passing
 * suite must not be read as corpus coverage.
 *
 * Three rules the whole file exists to keep:
 *
 *  1. **Never this repository.** It has nine live linked worktrees from the agent
 *     harness, so a worktree assertion here would assert on a peer's state.
 *  2. **Never the network, never a real provider CLI, never a credential store.**
 *     Gates are Node scripts this module writes; nothing else is spawned but
 *     `git` and the built `specwitness` binary.
 *  3. **Per-test temp directories** (harness defect H-8: `pnpm test` runs in this
 *     worktree concurrently with the agent).
 *
 * The project is scaffolded by the SHIPPED `specwitness init`, so the fixture
 * exercises the real `.specwitness/` layout — including the nested
 * `.specwitness/.gitignore` (Q11) — rather than a layout invented here. The
 * contract is frozen by the SHIPPED `specwitness contract <epic> --freeze`, so
 * its fingerprint is the one the product computes rather than one a test
 * hand-rolled and could get subtly right for the wrong reason.
 */

import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';

/** The built binary. `tests/setup/build-cli.ts` produces it before the suite runs. */
export const CLI = fileURLToPath(new URL('../../../dist/cli.js', import.meta.url));

/**
 * What a gate script does when it runs.
 *
 * Deterministic by construction: a fixed exit code and fixed output, no clock,
 * no network, no filesystem beyond the marker `spawn-marker` writes. `slow`
 * exists for the kill-mid-run proof, and it is the only one that does not end on
 * its own.
 */
export type GateBehaviour =
  | 'pass'
  | 'fail'
  | 'slow'
  | 'spawn-marker'
  /**
   * Fails AND makes the run directory unwritable first, so the run decides a
   * verdict and then cannot persist it.
   *
   * The property under test is the one pamela (3.3) fixed on her branch and asked
   * to have proven end to end: once an outcome exists, a later failure records
   * itself in the timeline and NEVER replaces the outcome. A gate failure that
   * then fails to write `result.json` must exit **1** with `gateFailed` intact —
   * not 3. Exit 3 tells a harness "the environment is broken, retry", and the
   * retry merges a branch that does not build.
   */
  | 'fail-and-lock-run-dir';

export interface GateSpec {
  /** Gate id as it appears in the config and in `gateFailed`. */
  readonly id: string;
  readonly behaviour: GateBehaviour;
}

/** Which contract the fixture leaves in `.specwitness/contracts/<epic>.yaml`. */
export type ContractState =
  /** Frozen, and deliberately WITHOUT a `human`-verifiability criterion. */
  | 'frozen'
  /** Frozen, WITH a `human` criterion — the NEEDS_HUMAN (exit 2) arm. */
  | 'frozen-with-human'
  /** Generated but never frozen — the guard's second refusal. */
  | 'draft'
  /** Frozen, then edited — the guard's third refusal, and never "not frozen yet". */
  | 'tampered'
  /** No contract file at all — the guard's first refusal. */
  | 'absent';

export interface FixtureOptions {
  /** Canonical epic id. Default `epic-1`, matching the story's AC1. */
  readonly epic?: string;
  /** Gates in declaration order. Default: two passing gates. */
  readonly gates?: readonly GateSpec[];
  /** Default `frozen`. */
  readonly contract?: ContractState;
  /** Base branch written into the config. Default `master`. */
  readonly baseBranch?: string;
}

export interface Fixture {
  /** The project root: a real git repository with real commits. */
  readonly root: string;
  readonly epic: string;
  /** Commit on the base branch. */
  readonly baseSha: string;
  /** Commit under verification (`HEAD`). */
  readonly headSha: string;
  /** Absolute path of the contract file, whether or not it exists. */
  readonly contractPath: string;
  /** `git status --porcelain`, for the AD-8 "source repo untouched" assertions. */
  status(): Promise<string>;
  /** Every ref and its sha, for "no fetch occurred". */
  refs(): Promise<string>;
  /** Marker files a `spawn-marker` gate would have written. Empty means it never ran. */
  markers(): Promise<readonly string[]>;
  cleanup(): Promise<void>;
}

const DEFAULT_GATES: readonly GateSpec[] = [
  { id: 'lint', behaviour: 'pass' },
  { id: 'build', behaviour: 'pass' },
];

/**
 * Output a failing gate prints, so the evidence assertion has something
 * unmistakable to look for. Deliberately not a substring of anything else in the
 * fixture.
 */
export const FAILING_GATE_STDOUT = 'GATE-OUTPUT-MARKER: the build is broken on purpose';
export const FAILING_GATE_STDERR = 'GATE-STDERR-MARKER: 1 error in fixture/broken.ts';

/** Written by a `spawn-marker` gate. Its ABSENCE is what the guard tests assert. */
export const SPAWN_MARKER_FILENAME = 'gate-was-spawned.marker';

function gateScript(behaviour: GateBehaviour, runsRoot: string): string {
  switch (behaviour) {
    case 'pass':
      return "process.stdout.write('gate ok\\n');\nprocess.exit(0);\n";
    case 'fail':
      return (
        `process.stdout.write(${JSON.stringify(`${FAILING_GATE_STDOUT}\n`)});\n` +
        `process.stderr.write(${JSON.stringify(`${FAILING_GATE_STDERR}\n`)});\n` +
        'process.exit(1);\n'
      );
    case 'slow':
      // Never resolves on its own: the kill-mid-run proof needs a run that is
      // still holding a worktree and a process group when SIGKILL arrives.
      return "process.stdout.write('gate started\\n');\nsetInterval(() => {}, 1000);\n";
    case 'spawn-marker':
      // Records that it ran AT ALL. Used where the assertion is that nothing was
      // spawned — a refusal that reaches a gate is a refusal that came too late.
      return (
        `require('node:fs').writeFileSync(${JSON.stringify(SPAWN_MARKER_FILENAME)}, 'spawned\\n');\n` +
        'process.exit(0);\n'
      );
    case 'fail-and-lock-run-dir':
      // The runs root is baked in as an absolute path because this script runs
      // with its cwd inside the DETACHED WORKTREE, which knows nothing about the
      // project root. Newest run directory = the run currently executing: run ids
      // begin with a compact UTC timestamp, so a plain string sort is newest-last
      // (the same ordering `RunStore.listRuns` relies on).
      //
      // Mode 0o500 removes write permission, so creating the staged temp file
      // inside the run directory fails — the finalize fails after the gate result
      // is already on the accumulator. Doing it from inside the gate means one
      // process, one run, and no timing race between the test and the run.
      return (
        "const fs = require('node:fs');\n" +
        "const path = require('node:path');\n" +
        `const runsRoot = ${JSON.stringify(runsRoot)};\n` +
        'const runs = fs.readdirSync(runsRoot).filter((name) => name.startsWith(\'run-\')).sort();\n' +
        'const newest = runs[runs.length - 1];\n' +
        'if (newest === undefined) {\n' +
        "  process.stderr.write('fixture: no run directory to lock\\n');\n" +
        '  process.exit(2);\n' +
        '}\n' +
        'fs.chmodSync(path.join(runsRoot, newest), 0o500);\n' +
        `process.stdout.write(${JSON.stringify(`${FAILING_GATE_STDOUT}\n`)});\n` +
        `process.stderr.write(${JSON.stringify(`${FAILING_GATE_STDERR}\n`)});\n` +
        'process.exit(1);\n'
      );
    default: {
      const unreachable: never = behaviour;
      return unreachable;
    }
  }
}

/**
 * A criterion set with NO `human` verifiability.
 *
 * This is load-bearing for AC1 rather than incidental: `needs_human` outranks
 * PASS in `aggregate`, and a criterion whose `verifiability` is `human` is one of
 * only two NEEDS_HUMAN triggers (Q39). A single `human` criterion here would make
 * "green gates ⇒ exit 0 PASS" unsatisfiable — the run would correctly exit 2.
 */
const AUTOMATED_CRITERIA = `  criteria:
    - id: E1-01
      statement: The CLI exits 0 and prints a report when every gate passes.
      kind: behavioral
      severity: critical
      verifiability: automated
    - id: E1-02
      statement: A failing gate stops the run before any criterion is probed.
      kind: structural
      severity: normal
      verifiability: automated
`;

/** The same set plus one `human` criterion — the NEEDS_HUMAN arm, deliberately. */
const CRITERIA_WITH_HUMAN = `${AUTOMATED_CRITERIA}    - id: E1-03
      statement: The failure message reads clearly to an operator who did not write the code.
      kind: human
      severity: normal
      verifiability: human
`;

function draftContract(epic: string, withHuman: boolean): string {
  return `# Built by tests/integration/helpers/verify-fixture.ts — an inline fixture,
# NOT a Golden Verification Corpus fixture (that is Epic 6).
${withHuman ? '' : '#\n# Deliberately contains NO `human`-verifiability criterion: one would make the\n# run NEEDS_HUMAN (exit 2) rather than PASS, because needs_human outranks PASS.\n'}spec:
  epic: ${epic}
  version: 1
${withHuman ? CRITERIA_WITH_HUMAN : AUTOMATED_CRITERIA}meta:
  schemaVersion: 1
  frozen: false
  fingerprint: null
  createdAt: 2026-08-31T09:00:00.000Z
  frozenAt: null
  provenance:
    provider: fake
    model: null
    providerCliVersion: null
    generatedAt: 2026-08-31T09:00:00.000Z
  history: []
`;
}

function config(gates: readonly GateSpec[], baseBranch: string): string {
  const declared =
    gates.length === 0
      ? 'gates: []\n'
      : `gates:\n${gates
          .map((gate) => `  - { id: ${gate.id}, run: node gates/${gate.id}.cjs }\n`)
          .join('')}`;

  // Gate commands are argv, never a shell line (AD-3): `node gates/<id>.cjs`
  // splits into a binary and two arguments with no quoting, no operators and
  // nothing for a shell to interpret even if one were involved.
  return `version: 1

project:
  baseBranch: ${baseBranch}

${declared}`;
}

/**
 * Puts every run directory back to a removable mode.
 *
 * Only `fail-and-lock-run-dir` produces a locked one, but this runs
 * unconditionally: a cleanup that only works for the fixture that needed it is a
 * cleanup that silently stops working when a case is copied.
 */
async function restoreRunDirectoryModes(runsRoot: string): Promise<void> {
  const entries = await readdir(runsRoot).catch(() => [] as string[]);
  await Promise.all(
    entries.map((entry) => chmod(join(runsRoot, entry), 0o700).catch(() => undefined)),
  );
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execa('git', args, {
    cwd,
    // A hermetic identity and no user config: the fixture must not depend on
    // whatever the machine running the suite happens to have configured.
    env: {
      GIT_AUTHOR_NAME: 'SpecWitness Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'SpecWitness Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
    extendEnv: true,
  });
  return result.stdout;
}

/** Runs the built binary in the fixture, exactly as a shell would. */
export async function runCli(
  args: readonly string[],
  options: { readonly cwd: string; readonly env?: Readonly<Record<string, string>> },
): Promise<{ exitCode: number | undefined; stdout: string; stderr: string }> {
  const result = await execa(process.execPath, [CLI, ...args], {
    reject: false,
    cwd: options.cwd,
    // Prompt-free by contract: verify must never block on stdin.
    input: '',
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Builds a project: a real git repository, the shipped `.specwitness/` layout,
 * deterministic gate scripts, and a contract in the requested state.
 *
 * Leaves the working tree CLEAN (everything committed), so
 * `git status --porcelain` is the empty string before a run and any change made
 * by `verify` is visible as a diff rather than as noise.
 */
export async function buildFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const epic = options.epic ?? 'epic-1';
  const gates = options.gates ?? DEFAULT_GATES;
  const contractState = options.contract ?? 'frozen';
  const baseBranch = options.baseBranch ?? 'master';

  const root = await mkdtemp(join(tmpdir(), 'specwitness-verify-fixture-'));
  const runsRoot = join(root, '.specwitness', 'runs');
  const cleanup = async () => {
    // A `fail-and-lock-run-dir` gate leaves a 0o500 run directory behind, and rm
    // cannot delete the entries inside one. Restore the mode first so teardown
    // never leaks a temp directory — the suite that leaked nine processes in
    // Epic 2 is the reason this is done rather than assumed.
    await restoreRunDirectoryModes(runsRoot);
    await rm(root, { recursive: true, force: true });
  };

  try {
    await git(root, 'init', '--quiet');
    // `git init -b` needs git 2.28; `symbolic-ref` works back to the 2.17 floor
    // this project supports.
    await git(root, 'symbolic-ref', 'HEAD', `refs/heads/${baseBranch}`);

    await writeFile(join(root, 'README.md'), '# fixture project\n', 'utf8');
    await git(root, 'add', '-A');
    await git(root, 'commit', '--quiet', '-m', 'chore: fixture base commit');
    const baseSha = await git(root, 'rev-parse', 'HEAD');

    await mkdir(join(root, 'gates'), { recursive: true });
    for (const gate of gates) {
      const path = join(root, 'gates', `${gate.id}.cjs`);
      await writeFile(path, gateScript(gate.behaviour, runsRoot), 'utf8');
      await chmod(path, 0o644);
    }

    // The shipped scaffolder, so the fixture uses the real layout (Q11's nested
    // `.specwitness/.gitignore`) rather than one invented here.
    const init = await runCli(['init'], { cwd: root });
    if (init.exitCode !== 0) {
      throw new Error(`fixture: 'specwitness init' failed (${init.exitCode}): ${init.stderr}`);
    }

    await writeFile(join(root, '.specwitness', 'config.yaml'), config(gates, baseBranch), 'utf8');

    const contractPath = join(root, '.specwitness', 'contracts', `${epic}.yaml`);
    if (contractState !== 'absent') {
      await writeFile(
        contractPath,
        draftContract(epic, contractState === 'frozen-with-human'),
        'utf8',
      );

      if (contractState !== 'draft') {
        // The shipped freeze, so the fingerprint is the product's own.
        const frozen = await runCli(['contract', epic, '--freeze'], { cwd: root });
        if (frozen.exitCode !== 0) {
          throw new Error(
            `fixture: 'specwitness contract ${epic} --freeze' failed (${frozen.exitCode}): ${frozen.stderr}`,
          );
        }
      }

      if (contractState === 'tampered') {
        // Edit the FINGERPRINTED half after freezing — a weakened expectation,
        // which is exactly the tamper ADR-005 exists to make detectable. `meta`
        // is untouched, so the stored fingerprint still claims the old content.
        const frozenText = await readFile(contractPath, 'utf8');
        const tampered = frozenText.replace(
          'The CLI exits 0 and prints a report when every gate passes.',
          'The CLI exits 0.',
        );
        if (tampered === frozenText) {
          throw new Error('fixture: tamper edit matched nothing — the draft text moved');
        }
        await writeFile(contractPath, tampered, 'utf8');
      }
    }

    await git(root, 'add', '-A');
    await git(root, 'commit', '--quiet', '-m', 'feat: fixture head commit with specwitness config');
    const headSha = await git(root, 'rev-parse', 'HEAD');

    const clean = await git(root, 'status', '--porcelain');
    if (clean !== '') {
      throw new Error(`fixture: working tree is not clean after setup:\n${clean}`);
    }

    return {
      root,
      epic,
      baseSha,
      headSha,
      contractPath,
      status: () => git(root, 'status', '--porcelain'),
      refs: () => git(root, 'show-ref'),
      markers: async () => {
        const marker = join(root, SPAWN_MARKER_FILENAME);
        return (await readFile(marker, 'utf8').then(
          () => [marker],
          () => [],
        )) as readonly string[];
      },
      cleanup,
    };
  } catch (cause) {
    await cleanup();
    throw cause;
  }
}
