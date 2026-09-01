/**
 * `specwitness verify <epic>` — story 3.7, the command the whole product is for.
 *
 * Six stories built the parts; this file is where they meet. It does no
 * verification of its own: it resolves what the run needs, hands those things
 * to the pipeline, renders the one `RunResult` through the one set of
 * renderers, and maps the outcome through the one exit table.
 *
 * THE AD-1 SEAM, and the reason this file loads the contract rather than the
 * pipeline doing it: `src/pipeline/**` may not import `src/authoring/**` —
 * application layers do not import each other, and `pipeline-layer` enforces
 * it. The spine's answer is that the CALLER loads and verifies, exactly as
 * config is "loaded once, validated, passed down". So the edge reads the
 * contract file, and `createIntegrityStage` receives a closure over story 2.6's
 * `assertVerifiableContract`. Its three refusals — absent, never frozen,
 * tampered — arrive unchanged, each with its own hint, and `tampered` is never
 * reported as "not frozen yet" (ADR-005: that wording invites freezing over the
 * edit and launders the tamper).
 *
 * EXIT CODES. Nothing here writes one. A failure throws and `main.ts`'s single
 * broad catch classifies it (AD-7, fail closed); a run that REACHED an outcome
 * records `exitCodeForOutcome(outcome)` through `cli/exit.ts`, which stays the
 * only module that knows what any code means. That distinction is the product's
 * central promise: an infrastructure failure exits 3 and never 1, and a gate
 * failure exits 1 and never 3.
 *
 * PROMPT-FREE, always. This is the command a harness runs unattended (Q53–Q55);
 * it makes no TTY assumption and asks nothing.
 *
 * AI-FREE, entirely. Epic 3's verify makes zero provider calls (FR-18, Q66) —
 * there is no provider in this file to call.
 */

import { relative, resolve } from 'node:path';

import type { Command } from 'commander';

import { assertVerifiableContract, type LoadedContract } from '../../authoring/verifiable.js';
import { readContractFile, resolveContractPath } from '../../authoring/contract-file.js';
import { loadConfig, type SpecwitnessConfig } from '../../config/index.js';
import { ConfigError, InfraError, UsageError } from '../../domain/errors.js';
import { normalizeEpicId } from '../../domain/ids.js';
import type { RunEnvironment } from '../../domain/run-result.js';
import type { RefResolution, RefRole, RepoRoot, RootResolution, Vcs } from '../../domain/vcs.js';
import { SystemClock } from '../../infra/clock.js';
import { RandomIds } from '../../infra/ids.js';
import { createProcessRunner } from '../../infra/process-runner.js';
import { RunStore } from '../../infra/run-store.js';
import { createGitVcs } from '../../infra/vcs.js';
import { runPipeline } from '../../pipeline/run-pipeline.js';
import { createStages } from '../../pipeline/stages/index.js';
import { renderJson, renderTerminal } from '../../report/index.js';
import { parseContract } from '../../schemas/contract.js';
import { exitCodeForOutcome, recordExitCode } from '../exit.js';

/** Injected at build time by tsup, and by vitest for source-level runs. */
declare const __SW_VERSION__: string;

interface VerifyOptions {
  readonly root?: string;
  readonly base?: string;
  readonly head?: string;
  readonly json?: boolean;
}

export function register(program: Command): void {
  program
    .command('verify')
    .description('verify an epic against its frozen contract')
    .argument('<epic>', "epic to verify, e.g. '1', 'epic-1' or 'epic-01'")
    .option('--root <dir>', 'repository to verify (default: search upward from this directory)')
    .option('--base <ref>', 'ref to verify against (default: project.baseBranch from the config)')
    .option('--head <ref>', 'ref under verification (default: HEAD)')
    .option('--json', 'emit the run document on stdout (stable schema, FR-30)')
    .action(async (epic: string, options: VerifyOptions) => {
      // Recording is the LAST act, per `cli/exit.ts`: anything that throws
      // before this point is classified by main's catch instead.
      recordExitCode(await verify(epic, options, process.cwd()));
    });
}

/**
 * Runs one verification and returns its exit code.
 *
 * Separated from `register` so the wiring is callable from a test without a
 * commander program, and so the action stays one line — a long action body is
 * how flag parsing and behaviour end up entangled.
 */
async function verify(
  epicArgument: string,
  options: VerifyOptions,
  cwd: string,
): Promise<ReturnType<typeof exitCodeForOutcome>> {
  // A malformed epic id is a UsageError (exit 64) from `domain/ids.ts` — raised
  // before anything is read, spawned or created. 64 sits outside 0–3 so a typo
  // can never be mistaken for a verdict (ADR-002).
  const epic = normalizeEpicId(epicArgument);
  const explicitRoot = requireFlagValue('--root', options.root);
  const baseFlag = requireFlagValue('--base', options.base);
  const headFlag = requireFlagValue('--head', options.head);

  const projectRoot = explicitRoot === undefined ? cwd : resolve(cwd, explicitRoot);

  // Loaded once, at the edge, and passed down (spine Consistency Conventions).
  const config = loadConfig(projectRoot);
  assertSomethingToAdjudicate(config);

  // Read and PARSED here, verified inside the pipeline. Parsing at the edge is
  // what lets the integrity stage receive a plain closure; a contract file that
  // is not valid YAML, or not a contract, fails here as an IntegrityError from
  // story 2.2's parser rather than as a mystery inside a stage.
  const loaded = await loadContract(projectRoot, epic);

  const runner = createProcessRunner(new SystemClock());
  const vcs = createGitVcs({ runner });
  const root = await resolveRoot(vcs, { explicitRoot, cwd });

  // Refs are resolved HERE, not in the pipeline: `Vcs.resolveRef` never fetches
  // and the pipeline spawns no git, so the SHAs a run is about are fixed before
  // it starts and cannot change under it.
  const baseSha = await resolveRef(vcs, root, 'base', baseFlag ?? config.project.baseBranch);
  const headSha = await resolveRef(vcs, root, 'head', headFlag ?? 'HEAD');

  const clock = new SystemClock();
  const store = new RunStore(projectRoot, clock, new RandomIds());
  if (!store.isInitialized()) {
    throw new InfraError(
      `this project is not initialised for SpecWitness (no .specwitness directory in ${projectRoot})`,
      "run 'specwitness init' first, or change to the project root",
    );
  }

  // Creates the run directory and fsyncs its manifest BEFORE any resource is
  // acquired (AD-8), so a `kill -9` from here on still leaves a record that
  // `specwitness clean` can reap.
  const created = await store.createRun({ epic });

  const environment: RunEnvironment = {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    specwitnessVersion: __SW_VERSION__,
    // Filled by the worktree stage; `null` until then, honestly.
    worktreePath: null,
    runDirectory: relative(projectRoot, created.dir),
  };

  const result = await runPipeline({
    runId: created.runId,
    epic,
    baseSha,
    headSha,
    environment,
    clock,
    stages: createStages({
      assertVerifiableContract: () => assertVerifiableContract(loaded),
      worktree: { vcs, recorder: store, root },
      // Write 1 of two: the crash-durable snapshot, at position 10 of 11. It is
      // what survives a kill DURING teardown. `onComplete` below writes the
      // complete document afterwards — one writer, one serializer, two moments.
      persist: { writeResult: (runId, finished) => store.writeResult(runId, finished) },
      teardown: {
        release: async (context) => {
          const worktreePath = context.run.environment.worktreePath;
          if (worktreePath !== null) {
            // The path is the only handle that escapes the stage, and
            // `removeWorktreeAt` also clears the `mkdtemp` container it can
            // prove it owns — so a successful run leaves nothing behind.
            await vcs.removeWorktreeAt(root, worktreePath);
          }
        },
      },
    }),
    // The complete document, after teardown. The persist stage already wrote a
    // crash-durable snapshot at position 10; this is the same writer and the
    // same serializer, one moment later, with teardown's entry included.
    onComplete: async (finished) => {
      await store.writeResult(created.runId, finished);
    },
  });

  // AD-11: one model, many renderers. Nothing is computed here.
  if (options.json === true) {
    // stdout carries the JSON document and NOTHING else, so `verify --json | jq`
    // works with no filtering. These bytes are byte-identical to the persisted
    // `result.json` — both come from `serializeRunResult` (Q53).
    process.stdout.write(renderJson(result));
    process.stderr.write(renderTerminal(result));
  } else {
    process.stdout.write(renderTerminal(result));
  }

  return exitCodeForOutcome(result.outcome);
}

/**
 * Refuses a run that could not adjudicate anything at all.
 *
 * `specwitness init` scaffolds a config with `gates:` commented out, and `gates`
 * has no minimum length. Every criterion is `skipped` in this epic by design
 * (no probes yet — FR-18, Q66), so `aggregate([], [...skipped])` returns PASS:
 * the first-contact sequence `init` → `contract --freeze` → `verify` would
 * report **exit 0, merge-eligible, having executed nothing and observed
 * nothing**. Exit 0 is the one output this product exists to make trustworthy,
 * and a harness reads the verdict, not the prose beside it.
 *
 * Reported by story 3.5 from merged source; the sibling one layer down (an
 * unwired gates stage returning `ok`) was closed by story 3.4 in the same
 * window. Owner chose this refusal on 2026-09-01 over documenting the green as
 * correct; see `DECISIONS.md` 3.7-D4.
 *
 * WHY BEFORE THE RUN. Refusing afterwards would persist a `result.json` saying
 * PASS beside a CLI exiting 3, and whoever opens that run directory later has
 * no exit code to compare against — the stored PASS simply wins. That is not
 * degraded evidence, it is misleading evidence. Refusing first means no such
 * document exists.
 *
 * WHY `ConfigError` (3) AND NOT `UsageError` (64): the invocation was fine; the
 * project's declaration is incomplete. And not NEEDS_HUMAN: Q39 fixes exactly
 * two triggers and this is not a third.
 *
 * **Epic 4 must widen this, not delete it.** The rule is "the run could not
 * adjudicate anything", which today reduces to "no gates declared" only because
 * nothing adjudicates criteria mechanically yet. When probes land, a gate-less
 * project with automated criteria becomes legitimately verifiable and the
 * second clause becomes real.
 */
function assertSomethingToAdjudicate(config: SpecwitnessConfig): void {
  if (config.gates.length > 0) {
    return;
  }

  throw new ConfigError(
    'this project declares no deterministic gates, so a verification run could not check anything',
    "declare at least one gate under 'gates:' in .specwitness/config.yaml — until behavioural probes arrive, gates are the only thing a run can execute, and a PASS that executed nothing would tell your harness the branch is merge-eligible",
  );
}

/**
 * Reads and parses the contract, or reports its absence.
 *
 * Absence is a fact, not an error, here: `assertVerifiableContract` turns it
 * into the first of the three refusals, with the hint that names
 * `specwitness contract <epic>`. Reading it any other way would put a second
 * "no contract" message in the codebase.
 */
async function loadContract(projectRoot: string, epic: string): Promise<LoadedContract> {
  const path = resolveContractPath(projectRoot, epic);
  const text = await readContractFile(projectRoot, epic);

  if (text === undefined) {
    return { present: false, epic, path };
  }

  return { present: true, epic, path, contract: parseContract(text, path) };
}

/**
 * Rejects an empty or whitespace-only flag value as a usage error (exit 64).
 *
 * `--root ''` is not a directory named "" — it is a caller bug, and a shell
 * expanding an unset variable produces exactly this. Resolving it would verify
 * the current directory instead, silently and confidently.
 */
function requireFlagValue(flag: string, value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.trim() === '') {
    throw new UsageError(
      `${flag} was given an empty value`,
      `pass a value after ${flag}, or omit the flag entirely to use the default`,
    );
  }
  return value;
}

/**
 * Turns a root resolution into a repository or an `InfraError` (exit 3).
 *
 * Classified on the OUTCOME, never by matching the adapter's prose — story 3.1
 * returns a closed union precisely so the edge does not string-match. The
 * adapter's `detail` is carried verbatim into the message because it is the
 * part that says WHICH failure this was: "this is a bare git repository, which
 * has no working tree" and "no git repository at or above this directory" are
 * both `not-a-repo`, and telling an operator with a bare repo that they have no
 * repository would be confidently wrong.
 */
async function resolveRoot(
  vcs: Vcs,
  request: { readonly explicitRoot?: string | undefined; readonly cwd: string },
): Promise<RepoRoot> {
  const resolution: RootResolution = await vcs.resolveRoot(request);
  if (resolution.outcome === 'resolved') {
    return resolution.root;
  }

  const where = request.explicitRoot === undefined ? 'the current directory' : '--root';
  const hint =
    request.explicitRoot === undefined
      ? 'run specwitness from inside the repository, or pass --root <dir>'
      : 'pass --root <dir> pointing at a git repository with a working tree';

  if (resolution.outcome === 'git-unavailable') {
    // Never `not a repository`: a git that could not run says nothing about the
    // directory, and reporting it as one would send the operator to fix a
    // repository that is fine (story 3.1's own review found this class fifteen
    // times).
    throw new InfraError(
      `git could not be run: ${resolution.detail}`,
      'install git, or upgrade it, and reopen your shell',
    );
  }

  throw new InfraError(
    `cannot use ${resolution.path} as the repository to verify (${where}): ${resolution.detail}`,
    hint,
  );
}

/**
 * Turns a ref resolution into a SHA or an `InfraError` (exit 3).
 *
 * The missing-ref hint names `git fetch` and says SpecWitness never fetches,
 * because both halves matter: the operator needs the remedy, and the promise
 * that a verdict never depends on network state is the reason the remedy is
 * theirs to run rather than ours (AD-8 — the source repository is read-only).
 */
async function resolveRef(vcs: Vcs, root: RepoRoot, role: RefRole, ref: string): Promise<string> {
  const resolution: RefResolution = await vcs.resolveRef(root, role, ref);

  switch (resolution.outcome) {
    case 'resolved':
      return resolution.sha;

    case 'not-found':
      throw new InfraError(
        `cannot resolve ${role} ref '${ref}' in ${root.mainWorktreeRoot}`,
        'SpecWitness never fetches; run "git fetch" in the source repository and retry',
      );

    case 'ambiguous':
      throw new InfraError(
        `${role} ref '${ref}' is ambiguous in ${root.mainWorktreeRoot}: ${resolution.candidates.join(', ')}`,
        `pass a fully-qualified ref, e.g. 'refs/heads/${ref}' or 'refs/remotes/origin/${ref}'`,
      );

    case 'git-unavailable':
      throw new InfraError(
        `git could not be run: ${resolution.detail}`,
        'install git, or upgrade it, and reopen your shell',
      );

    case 'not-a-repo':
      throw new InfraError(
        `cannot resolve ${role} ref '${ref}': ${resolution.detail}`,
        'pass --root <dir> pointing at a git repository with a working tree',
      );

    default: {
      // Compile-time exhaustiveness: a new resolution outcome must be given a
      // classification here rather than falling through to a resolved SHA.
      const unreachable: never = resolution;
      return unreachable;
    }
  }
}
