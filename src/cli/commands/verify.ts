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
 * ============================================================================
 * AI-FREE EXECUTION, AND THE ONE PLACE A PROVIDER MAY BE CALLED (story 4.7)
 * ============================================================================
 *
 * FR-18 and Q66's promise is that **executing a plan makes zero provider
 * calls**. That promise is kept structurally rather than by discipline: the
 * probes stage, the surface executors and everything they reach have no
 * provider in scope at all, and the only `compilePlan` call in this file is
 * guarded and happens BEFORE the pipeline starts.
 *
 * There is exactly one path on which `verify` may spend provider quota — no
 * plan exists yet, so one is compiled first (AC3) — and the run RECORDS it in
 * `RunResult.providerUsage`. The recording is not decoration: a harness reads
 * that document to know what a run cost, and a run that quietly spent
 * subscription quota while `providerUsage` stayed empty would make the whole
 * FR-18 guarantee unauditable. `--no-ai` refuses that path outright rather than
 * skipping it silently: a skip would leave a run with zero criteria that
 * aggregates to PASS, which is the one output this product must never produce
 * by accident.
 *
 * All four cells of `plan present × --no-ai` are exercised in
 * `tests/integration/verify-no-ai.test.ts`.
 */

import { join, relative } from 'node:path';

import type { Command } from 'commander';

import {
  assertVerifiableContract,
  contractStatusState,
  type LoadedContract,
} from '../../authoring/verifiable.js';
import { readContractFile, resolveContractPath } from '../../authoring/contract-file.js';
import {
  assertPlansDirectory,
  planRelativePath,
  readPlanFile,
  resolvePlanPath,
  writePlanFileAtomically,
} from '../../authoring/plan-file.js';
import { createMechanicsAdapter } from '../../authoring/adaptation.js';
import { compilePlan } from '../../authoring/plan.js';
import { loadConfig, resolveRoleProvider, type SpecwitnessConfig } from '../../config/index.js';
import type { MechanicsAdapter } from '../../domain/adaptation-port.js';
import { ConfigError, InfraError, UsageError } from '../../domain/errors.js';
import { normalizeEpicId } from '../../domain/ids.js';
import type { Plan } from '../../domain/plan.js';
import { resolvePlanData } from '../../domain/plan-data.js';
import type { Clock, Ids } from '../../domain/ports.js';
import type { ProviderUsage, RunEnvironment, RunResult } from '../../domain/run-result.js';
import type { RefResolution, RefRole, RepoRoot, RootResolution, Vcs } from '../../domain/vcs.js';
import { SystemClock } from '../../infra/clock.js';
import { RandomIds } from '../../infra/ids.js';
import { createProcessRunner, terminateProcessGroup } from '../../infra/process-runner.js';
import { resolvePlaywrightEnvironment } from '../../infra/playwright-env.js';
import { RunStore } from '../../infra/run-store.js';
import { ScorecardStore } from '../../infra/scorecard-store.js';
import { createGitVcs } from '../../infra/vcs.js';
import { runPipeline } from '../../pipeline/run-pipeline.js';
import { createStages } from '../../pipeline/stages/index.js';
import { createServiceGroupRegistry } from '../../pipeline/stages/services.js';
import { providerForRole } from '../../providers/index.js';
import { renderJson, renderTerminal } from '../../report/index.js';
import { parseContract } from '../../schemas/contract.js';
import { toScorecardRecord } from '../../schemas/scorecard.js';
import {
  assertPlanMatchesContract,
  isReferenceableId,
  parsePlan,
  serializePlan,
  unreferenceableIds,
} from '../../schemas/plan.js';
import type { DeclaredIds } from '../../schemas/plan.js';
import { readProviderProvenance } from '../contract/provenance.js';
import { createDoctorEffects } from '../doctor/effects.js';
import { exitCodeForOutcome, recordExitCode } from '../exit.js';
import { printError, printWarning } from '../print-error.js';
import { armInterruptNotice } from '../verify/interrupt.js';
import { explainVerifiedRun, publishExplainedRun } from '../verify/explain.js';
import { createProbeDispatcher, createRetryPolicy } from '../verify/probe-dispatch.js';
import { releaseRun } from '../verify/teardown.js';

/** Injected at build time by tsup, and by vitest for source-level runs. */
declare const __SW_VERSION__: string;

interface VerifyOptions {
  readonly root?: string;
  readonly base?: string;
  readonly head?: string;
  readonly json?: boolean;
  readonly ai?: boolean;
  readonly explain?: boolean;
  readonly adapt?: boolean;
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
    // Commander turns `--no-ai` into `options.ai === false`, defaulting to `true`. The flag
    // is a REFUSAL switch rather than a mode: with a plan present a run makes zero provider
    // calls whether or not it is passed, so what `--no-ai` actually guarantees is that the
    // command will not compile one behind your back.
    .option('--no-ai', 'refuse to compile a plan; verify only what is already planned (FR-18, Q66)')
    // Story 5.5. OPT-IN, and the default matters more than the feature: without the flag
    // this command reaches no explainer at all, so FR-18's zero-provider-call guarantee is
    // untouched by the flag's existence. What it buys is a NON-AUTHORITATIVE hypothesis
    // beside each failed criterion; it can change no status, no verdict and no exit code.
    .option('--explain', 'ask the explainer role for a non-authoritative failure hypothesis (FR-11)')
    // Story 5.6. OPT-IN, and the default is silence: without it no adapter is wired into
    // the probes stage at all, so there is no provider in scope on the probe path and a
    // default run cannot spend quota (FR-18, Q66, AD-9's "determinism is the default").
    .option(
      '--adapt',
      'let a provider propose new probe MECHANICS for a browser probe that failed on ' +
        'element-not-found; assertions and expected values can never be changed (FR-18)',
    )
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
  assertExplainIsCompatible(options);

  // ⚠️ `--no-ai --adapt` IS REFUSED, NOT SILENTLY NO-OPED. Story 5.6, and it is a
  // `UsageError` (exit 64) raised before anything is read, spawned or created — the same
  // treatment a malformed epic id gets, and for the same reason: 64 sits outside 0-3 so a
  // flag mistake can never be mistaken for a verdict (ADR-002).
  //
  // The alternative was letting `--no-ai` win and quietly dropping `--adapt`. A flag pair
  // whose combination silently discards one of them is a flag pair people misread, and the
  // one being discarded here is the one that spends subscription quota and changes what
  // gets executed. An operator who typed both wants to be told, not guessed at. 5.5 reached
  // the same answer independently for `--no-ai --explain`.
  if (options.ai === false && options.adapt === true) {
    throw new UsageError(
      '--no-ai and --adapt cannot be combined',
      'adaptation asks a provider to propose new probe mechanics, which is exactly what ' +
        '--no-ai refuses. Drop --adapt for a zero-provider-call run, or drop --no-ai to ' +
        'allow the one invocation adaptation costs',
    );
  }

  const explicitRoot = requireFlagValue('--root', options.root);
  const baseFlag = requireFlagValue('--base', options.base);
  const headFlag = requireFlagValue('--head', options.head);

  // THE REPOSITORY IS RESOLVED FIRST, and everything project-relative hangs off
  // it. `--root` names the repository; without it the `Vcs` port walks up from
  // the current directory, which is what makes `specwitness verify` work from a
  // subdirectory the way `git` does — and what the `--root` help text promises.
  //
  // Reading `.specwitness/` out of the raw cwd instead (the first version of
  // this file) failed from any subdirectory with "no config file at
  // <subdir>/.specwitness/config.yaml", advertising upward discovery and not
  // doing it. Found by review.
  //
  // `worktreeRoot`, NOT `mainWorktreeRoot`: from inside a LINKED worktree the
  // project is the tree you invoked from, so its `.specwitness/` and its run
  // directory are the ones that apply. The main worktree is what error messages
  // NAME as the source repository and what AD-8 proves untouched — a different
  // question, agreed with story 3.1, and the case every agent in this cohort
  // actually works in.
  const runner = createProcessRunner(new SystemClock());
  const vcs = createGitVcs({ runner });
  const root = await resolveRoot(vcs, { explicitRoot, cwd });
  const projectRoot = root.worktreeRoot;

  // Loaded once, at the edge, and passed down (spine Consistency Conventions).
  const config = loadConfig(projectRoot);

  // Read and PARSED here, verified inside the pipeline. Parsing at the edge is
  // what lets the integrity stage receive a plain closure; a contract file that
  // is not valid YAML, or not a contract, fails here as an IntegrityError from
  // story 2.2's parser rather than as a mystery inside a stage.
  const loaded = await loadContract(projectRoot, epic);

  // Refs are resolved HERE, not in the pipeline: `Vcs.resolveRef` never fetches
  // and the pipeline spawns no git, so the SHAs a run is about are fixed before
  // it starts and cannot change under it. The pipeline's resolve stage refuses
  // an empty SHA outright, so this cannot be deferred to it.
  //
  // A CONTRACT THAT CANNOT GATE VERIFICATION OUTRANKS A REF THAT WILL NOT
  // RESOLVE. When both are wrong, reporting the ref first masks the refusal the
  // operator most needs — and for a tampered contract the masked hint is the one
  // naming `--amend`, so the operator is left with "your ref is missing" and
  // reaches for `--freeze` next. That is the laundering ADR-005 exists to
  // prevent, reached by way of an unrelated error message. Found by review.
  //
  // The refusal is normally the integrity STAGE's to report, which is why it is
  // not raised here in the ordinary case: it belongs in the timeline and the
  // persisted run. This path is only for the run that can never be built,
  // because there are no revisions to build it from.
  let baseSha: string;
  let headSha: string;
  try {
    baseSha = await resolveRef(vcs, root, 'base', baseFlag ?? config.project.baseBranch);
    headSha = await resolveRef(vcs, root, 'head', headFlag ?? 'HEAD');
  } catch (refFailure) {
    if (contractStatusState(loaded) !== 'frozen') {
      // Throws the specific refusal — absent, never frozen, or tampered — each
      // with its own hint, exactly as the stage would have.
      assertVerifiableContract(loaded);
    }
    throw refFailure;
  }

  const clock = new SystemClock();
  const store = new RunStore(projectRoot, clock, new RandomIds());

  // ==========================================================================
  // EVERY PROVIDER-INDEPENDENT PRECONDITION RUNS ABOVE THIS LINE.
  // ==========================================================================
  //
  // Resolving the plan may SPEND PROVIDER QUOTA, and compilation happens before
  // a run directory exists — so anything able to fail after it and before
  // `createRun` spends quota that no run document will ever record, which is
  // exactly the auditability this command promises. Refs, the store, the plans
  // directory and the contract-only half of the adjudicability refusal are all
  // answerable without a provider, so all of them are answered first.
  //
  // This was three separate review findings before it was stated as one rule
  // (Codex passes four, five and six, each naming a different check that had
  // drifted below the line). A NEW PRECONDITION THAT NEEDS NO PROVIDER GOES
  // ABOVE HERE — that is the invariant, and it is cheaper to keep than to
  // rediscover one check at a time.
  //
  // THE RESIDUAL, stated because it cannot be closed by ordering: `createRun`
  // can still fail for reasons no pre-check predicts — a full disk, a revoked
  // permission between the check and the write. Quota is then spent with no run
  // document. It is not invisible even so: the compiled plan is written to disk
  // first, and its `meta.provenance` records the provider, the model and the
  // moment. `providerUsage` is the per-RUN view of a spend the artifact already
  // records.
  if (!store.isInitialized()) {
    throw new InfraError(
      `this project is not initialised for SpecWitness (no .specwitness directory in ${projectRoot})`,
      "run 'specwitness init' first, or change to the project root",
    );
  }

  assertCouldEverAdjudicate(config, loaded);

  // ⚠️ BUILT HERE, ABOVE `resolvePlan`, BECAUSE IT NEEDS NO PROVIDER — which is exactly the
  // rule the block above states: "A NEW PRECONDITION THAT NEEDS NO PROVIDER GOES ABOVE
  // HERE". Story 5.6, and it was the FOURTH review finding against that same line.
  //
  // Resolving and constructing the adapter is pure config work. Doing it after `resolvePlan`
  // meant that `--adapt` with an unassigned role AND no plan on disk would compile a plan
  // first — spending subscription quota and writing a file — and only then refuse with a
  // configuration error. Raised as a P2 by the codex review of this branch.
  //
  // Built ONLY under `--adapt`, so `adapt` is `undefined` on every default run and the
  // probes stage is handed no provider at all. It REFUSES rather than no-ops when the role
  // is unassigned, for the reason the `--no-ai` clash is refused: an operator who asked for
  // adaptation must be able to tell "nothing needed adapting" from "adaptation was never
  // possible", and a silent no-op makes those two indistinguishable.
  const adapt = options.adapt === true ? buildMechanicsAdapter(config, clock) : undefined;

  // The `--no-ai` refusal and the auto-compilation both have to happen while
  // there is still no run directory, no worktree and no process group in
  // existence — a refusal afterwards would leave a `result.json` on disk
  // describing a run that never adjudicated anything. The refusal ordering
  // above is unaffected: `resolvePlan` verifies the contract before invoking
  // anything, so a tampered contract still refuses with its own hint rather
  // than being masked by a ref error.
  const planning = await resolvePlan({
    projectRoot,
    epic,
    loaded,
    config,
    clock: new SystemClock(),
    ids: new RandomIds(),
    allowCompilation: options.ai !== false,
  });

  assertSomethingToAdjudicate(config, planning.plan);


  // Creates the run directory and fsyncs its manifest BEFORE any resource is
  // acquired (AD-8), so a `kill -9` from here on still leaves a record that
  // `specwitness clean` can reap.
  const created = await store.createRun({ epic });

  // Which Playwright a browser probe would drive, if this plan has one (story 5.1).
  // Resolution performs no network I/O and never spawns; it answers `absent` rather than
  // throwing, which is what lets a run with no browser probes proceed untouched.
  const playwright = await resolvePlaywrightEnvironment({ projectRoot });

  const environment: RunEnvironment = {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    specwitnessVersion: __SW_VERSION__,
    // Filled by the worktree stage; `null` until then, honestly.
    worktreePath: null,
    runDirectory: relative(projectRoot, created.dir),
  };

  // THE PROCESS-GROUP SEAM, bound once and shared by every spawning stage. A pgid
  // reaches the manifest before the child's outcome is observed (AD-8), which is what
  // lets `specwitness clean` reap a run killed mid-gate, mid-service or mid-probe.
  const recordProcessGroup = (pgid: number): Promise<void> =>
    store.recordProcessGroup(created.runId, pgid);
  const writeEvidence = (relativeName: string, contents: string): Promise<string> =>
    store.writeEvidenceFile(created.runId, relativeName, contents);
  // The BINARY twin (story 5.2). A Playwright trace is a `.zip` and a screenshot is a
  // `.png`; the text writer encodes as UTF-8 and would corrupt both. AD-8 keeps `RunStore`
  // the sole writer beneath `.specwitness/runs/`, so the browser executor copies bytes in
  // through here rather than letting the Playwright subprocess write into the run.
  const writeEvidenceBytes = (relativeName: string, contents: Uint8Array): Promise<string> =>
    store.writeEvidenceBytes(created.runId, relativeName, contents);
  // Playwright's own CLI is a separate process and has to OPEN the generated spec and
  // config, which Q30/Q31 require to live in the run directory. Resolving the absolute
  // path is this layer's job precisely so the executor never constructs one.
  const resolveRunPath = (runRelativePath: string): string =>
    join(created.dir, runRelativePath);

  // ONE registry, shared by the services stage and by teardown. Binding services
  // without a way to reap them is the composition `StageDependencies` makes
  // unrepresentable; draining it from teardown is the half this file owes.
  const registry = createServiceGroupRegistry({ terminate: terminateProcessGroup });

  // ARMED THE MOMENT THERE IS SOMETHING TO SAY, and disarmed in the `finally`
  // below. Before `createRun` an interruption leaves nothing behind; from here
  // on it can leave a worktree and a live process group, and the operator has no
  // other way to learn the run directory's name. See `verify/interrupt.ts` for
  // why this prints and re-raises rather than attempting teardown.
  const disarmInterrupt = armInterruptNotice({
    runDirectory: environment.runDirectory,
  });

  try {
    return await execute();
  } finally {
    // A listener outliving its run would name a stale directory on the next
    // interruption, which is worse than saying nothing at all.
    disarmInterrupt();
  }

  async function execute(): Promise<ReturnType<typeof exitCodeForOutcome>> {
  const result = await runPipeline({
    runId: created.runId,
    epic,
    baseSha,
    headSha,
    environment,
    clock,
    // Empty on every AI-free run, which is every run with a plan already committed.
    providerUsage: planning.providerUsage,
    stages: createStages({
      assertVerifiableContract: () => assertVerifiableContract(loaded),
      worktree: { vcs, recorder: store, root },
      // The declared `setup.install`, executed in the worktree BEFORE the gates
      // (story 6.11). Bound UNCONDITIONALLY, not only when the project declared
      // one: an absent `install` is a state the stage reports ("no install
      // command declared"), whereas an absent `setup` key would be the state
      // this story exists to remove — a run in which `doctor` validated the key
      // and nothing executed it, so gates ran against an uninstalled worktree
      // and a missing install surfaced as a product FAIL.
      //
      // Spread so a project that declared nothing gets an object with NO
      // `install` key rather than an explicit `undefined`
      // (`exactOptionalPropertyTypes`).
      setup: {
        ...(config.setup.install === undefined ? {} : { install: config.setup.install }),
        runner,
        writeEvidence,
        onProcessGroup: recordProcessGroup,
      },
      // The declared gates, executed in the worktree. `writeEvidence` is bound
      // to the run so the stage cannot address another run's directory, and
      // `onProcessGroup` records each pgid durably — which is what lets
      // `specwitness clean` reap a run killed mid-gate.
      gates: {
        gates: config.gates,
        runner,
        writeEvidence,
        onProcessGroup: recordProcessGroup,
      },
      // The declared services, started in the worktree and reaped from teardown
      // below. `registry` is the SAME object both sides hold: binding services
      // without a way to drain them is the composition `StageDependencies` makes
      // unrepresentable, and a service that outlives its run makes the NEXT run
      // fail on an occupied port with nothing on screen to explain why.
      services: {
        services: config.services,
        runner,
        registry,
        probePort: createDoctorEffects(clock).probePort,
        onProcessGroup: recordProcessGroup,
      },
      // The declared `data.*` commands, in config declaration order. Their output
      // corroborates a step that produces no verdict, so a missing writer would
      // cost only the pointer to a full copy — it is bound anyway, because the
      // seeded-secret proof walks every file a run leaves behind.
      data: {
        data: config.data,
        runner,
        writeEvidence,
        onProcessGroup: recordProcessGroup,
      },
      // The compiled plan, executed with ZERO provider calls. `dispatch` is where
      // every resolution AD-1 and `adapters-core-only` forbid the pipeline and the
      // surfaces lives; `probes.plan` being absent means no plan was compiled, and
      // the stage then executes nothing and says so.
      ...(planning.plan === undefined
        ? {}
        : {
            probes: {
              criteria: planning.plan.plan.criteria,
              data: resolvePlanData(planning.plan.plan.data),
              dispatch: createProbeDispatcher({
                config,
                runner,
                clock,
                writeEvidence,
                writeEvidenceBytes,
                resolveRunPath,
                // Story 5.1's answer, resolved ONCE. Read-only, offline, no spawn - so it
                // costs a run with no browser probes almost nothing, and it is `verify`
                // that resolves rather than `doctor` because `doctor` REPORTS and hints
                // while never downloading. An `absent` answer is passed through rather
                // than thrown here: only a run that actually reaches a browser probe
                // should fail on it, and the executor refuses in 5.1's own words - never
                // a skip, because a criterion that checked nothing must not report PASS.
                playwright,
                onProcessGroup: recordProcessGroup,
              }),
              // Story 5.4. Zero for every surface unless the project declared otherwise,
              // so a run stays deterministic unless somebody asked for repetition (AD-9).
              retries: createRetryPolicy(config),
              // Story 5.6. Spread, so a default run's `ProbesStageDeps` has NO `adapt` key
              // rather than an explicit `undefined` — the difference is what makes "no
              // provider is in scope on the probe path" true of the object itself.
              ...(adapt === undefined ? {} : { adapt }),
            },
          }),
      // Write 1 of two: the crash-durable snapshot, at position 10 of 11. It is
      // what survives a kill DURING teardown. `onComplete` below writes the
      // complete document afterwards — one writer, one serializer, two moments.
      persist: { writeResult: (runId, finished) => store.writeResult(runId, finished) },
      teardown: {
        // Services first, worktree second, and NEITHER failure cancels the other
        // attempt — see `verify/teardown.ts` for both reasons. The composition is
        // extracted so the order and the failure handling are testable without an
        // unkillable process, which is not something a test may create.
        release: async (context) =>
          await releaseRun({
            releaseServices: () => registry.releaseAll(),
            removeWorktree: async () => {
              const worktreePath = context.run.environment.worktreePath;
              if (worktreePath === null) {
                return;
              }
              // The path is the only handle that escapes the stage, and
              // `removeWorktreeAt` also clears the `mkdtemp` container it can prove
              // it owns — so a successful run leaves nothing behind.
              await vcs.removeWorktreeAt(root, worktreePath);
            },
          }),
      },
    }),
    // The complete document, after teardown. The persist stage already wrote a
    // crash-durable snapshot at position 10; this is the same writer and the
    // same serializer, one moment later, with teardown's entry included.
    onComplete: async (finished) => {
      const write = await store.writeResult(created.runId, finished);
      if (!write.durable) {
        // The document IS published — `rename(2)` committed it — and only the
        // durability barrier after it did not. Discarding that left the command
        // exiting normally while the stored run's survival of a power loss was
        // unconfirmed, which is the same silence the contract writer had until
        // this story wired its warning. Found by review.
        //
        // A warning rather than a timeline entry because the timeline is already
        // sealed: `onComplete` receives the FINISHED result, after teardown, so
        // there is nothing left to record into. The persist stage covers the
        // earlier snapshot the same way, in its own detail.
        printWarning(
          `the run result was written but could not be made durable: ${write.barrier ?? 'the directory fsync did not complete'}`,
        );
      }
    },
  });

  // ==========================================================================
  // THE EXPLAINER — story 5.5. Opt-in, after the run, and provably inert.
  // ==========================================================================
  //
  // WHY IT IS HERE AND NOT IN THE PIPELINE. `src/pipeline/**` may not import
  // `src/authoring/**` (AD-1, `pipeline-layer`), and it should not want to: a
  // stage that could reach a provider would be a stage that could let one
  // influence what it recorded. The run is FINISHED and its outcome fixed
  // before this line — every status, every gate, every timestamp — so there is
  // nothing left for a hypothesis to affect even in principle.
  //
  // WHAT CHANGES AND WHAT CANNOT. `explainVerifiedRun` returns a new
  // `RunResult` differing in exactly two fields: the `explanations` array, and
  // one appended `providerUsage` entry recording the call (Q65, FR-15 — a
  // subscription cost this product exists to make visible). `outcome`,
  // `criteria`, `gates`, `evidence`, `stages` and `contract` are carried
  // through by a spread, so `serializeRunResult`'s bytes are identical with and
  // without `--explain` once those two keys are set aside. That is asserted
  // mechanically rather than argued: see `tests/unit/authoring/explain-inert.test.ts`.
  //
  // IT NEVER FAILS THE RUN. `explainVerifiedRun` has no error arm; on every
  // failure route it returns the input object itself and a note. The exit code
  // below is computed from `result.outcome`, which no branch here can reach.
  let published = result;
  if (options.explain === true) {
    const explained = await explainVerifiedRun({
      result,
      config,
      clock,
      warn: (message: string) => process.stderr.write(`${message}\n`),
    });
    published = explained.result;
    if (explained.note !== undefined) {
      // A WARNING, never an ERROR: the verification succeeded and answered the
      // question it was asked. Only the optional extra is missing, and saying
      // so with `ERROR:` would tell the operator — and every log scraper they
      // own — that SpecWitness malfunctioned when it did precisely its job.
      printWarning(explained.note);
    }

    if (published !== result) {
      // A THIRD write, through the SAME sole writer and the SAME serializer
      // (AD-8, AD-11). The persist stage wrote a crash-durable snapshot at
      // position 10 and `onComplete` wrote the finished document after
      // teardown; this republishes it with the hypotheses attached, so the
      // stored run and what is rendered below are the same bytes (Q53).
      //
      // Guarded on identity rather than on the flag: on every failure route
      // `explainVerifiedRun` returns the input object itself, so a run that
      // could not be explained is not rewritten at all — the stored bytes are
      // then not merely equivalent to the unexplained ones, they were never
      // touched.
      //
      // AND IT IS CONTAINED against a write that throws — see `publishExplainedRun`,
      // which is its own function precisely so that failure handling is testable.
      published = await publishExplainedRun({
        explained: published,
        original: result,
        writeResult: async (toStore) => await store.writeResult(created.runId, toStore),
        warn: printWarning,
      });
    }
  }

  // ==========================================================================
  // THE SCORECARD — story 6.5, FR-33, NFR-4, brief §54. Automatic, and inert.
  // ==========================================================================
  //
  // WITHOUT CEREMONY IS THE REQUIREMENT, NOT A NICETY. There is no flag, no
  // opt-in and no command to run afterwards, because the measurement window is
  // ~30-50 real tasks across weeks and anything the operator has to remember to
  // do will not be done. An opt-in scorecard produces a biased sample that
  // nobody can detect after the fact, which is a worse outcome than no
  // scorecard at all.
  //
  // WHICH RUNS RECORD, decided here by POSITION rather than by a condition.
  // `store.createRun` above is the moment an invocation becomes a run;
  // everything that throws before it — an invalid config, an unresolvable ref,
  // a contract that is absent, unfrozen or tampered, `--no-ai` with no plan —
  // never became a run and leaves no record. Everything from here records:
  // PASS, FAIL, NEEDS_HUMAN, and — the case that matters most — a run that
  // ended in the infrastructure arm. Infra-error rate is one of the metrics
  // story 6.6 must report, so a run that dies of infrastructure and leaves no
  // record makes that rate structurally zero, which is a wrong number that
  // reads as good news.
  //
  // `published`, not `result`: this is a projection of the document that was
  // actually persisted and rendered, so the scorecard cannot disagree with
  // `result.json` about what happened (AD-11). Where they could ever disagree,
  // `result.json` wins and the scorecard is the one to fix. It also means an
  // explained run records the explainer's provider call, which is the whole
  // point of `providerInvocations`.
  //
  // ⚠️ IT CANNOT CHANGE THE OUTCOME, AND THAT IS ENFORCED BY THE SIGNATURE.
  // `appendRecord` has no rejection path: a full disk, a read-only directory or
  // a deleted `.specwitness/` becomes a `WARNING:` on stderr and nothing else.
  // There is deliberately no try/catch here, because a caller that had to guard
  // would be a caller that could get the guard wrong. Instrumentation that can
  // fail a verification is worse than no instrumentation.
  //
  // No exit code is added and none is changed; `exitCodeForOutcome(result.outcome)`
  // below is untouched by this block, and nothing it can do is on the path to it.
  await new ScorecardStore(projectRoot).appendRecord(toScorecardRecord(published), printWarning);

  // AD-11: one model, many renderers. Nothing is computed here.
  if (options.json === true) {
    // stdout carries the JSON document and NOTHING else, so `verify --json | jq`
    // works with no filtering. These bytes are byte-identical to the persisted
    // `result.json` — both come from `serializeRunResult` (Q53).
    process.stdout.write(renderJson(published));
    process.stderr.write(renderTerminal(published));
  } else {
    process.stdout.write(renderTerminal(published));
  }

  // `result`, NOT `published`, and deliberately so: this reports the failing
  // STAGE that ended the run, and no stage can have been the explainer.
  reportInfraFailure(result);

  // THE EXIT CODE COMES FROM THE PIPELINE'S OWN OUTCOME. `published.outcome`
  // is the same object — `attachExplanations` spreads it through untouched —
  // but reading it from `result` says out loud that the explainer is not on
  // the path to an exit code, which is the property AD-2 asks for here.
  return exitCodeForOutcome(result.outcome);
  }
}

/**
 * `--no-ai --explain` is REFUSED, exit 64 (story 5.5).
 *
 * The two flags contradict each other and there is no reading under which both are
 * honoured: `--no-ai` is the operator asserting this run makes no provider call, and
 * `--explain` asks for one. Three answers were available and only one of them is honest.
 *
 *   - Silently drop `--explain`. Rejected. People misread flag pairs, and a pair whose
 *     combination quietly means something other than what it says is the same class of
 *     defect as a verdict that quietly means something other than what it says. The
 *     operator would believe they had asked for a hypothesis and would get none, with
 *     nothing on screen to say why.
 *   - Silently drop `--no-ai`. Rejected outright and not seriously considered: it would
 *     spend provider quota under the flag whose entire purpose is to forbid that.
 *   - REFUSE and name both flags. Costs one error message and cannot be misread.
 *
 * `UsageError` is exit 64, which sits OUTSIDE 0-3 so a flag mistake can never be mistaken
 * for a verdict (ADR-002). Raised before anything is read, resolved, spawned or created —
 * so a contradictory invocation cannot leave a run directory behind.
 *
 * Note what this does NOT do: it does not consult the config, and it does not care whether
 * an `explainer` role is assigned. A missing role is AC2's "absent with a note" and is a
 * perfectly successful run; a contradictory flag pair is a usage error. Those are different
 * conditions and they get different answers.
 */
function assertExplainIsCompatible(options: VerifyOptions): void {
  // Commander turns `--no-ai` into `ai === false` and leaves it `true` otherwise.
  if (options.explain === true && options.ai === false) {
    throw new UsageError(
      '--explain and --no-ai contradict each other: --explain asks the explainer role for a ' +
        'hypothesis, which is a provider call, and --no-ai forbids this run from making one',
      'drop --no-ai to allow the explanation, or drop --explain to keep the run AI-free — ' +
        'note that --no-ai also refuses to compile a missing plan, so the two flags are not ' +
        'interchangeable',
    );
  }
}

/**
 * Prints the house `ERROR:`/`HINT:` pair for a run that ended in the
 * infrastructure arm, and for nothing else.
 *
 * WHY THIS EXISTS AT ALL. A stage that throws is caught by the pipeline and
 * turned into an outcome, so `main.ts`'s printer — which only ever sees a throw
 * that ESCAPED a command — never runs for it. Before this, an exit-3 run printed
 * zero bytes on stderr: the diagnosis survived in the timeline and the remedy
 * did not. For a tampered contract that is not cosmetic, because the operator
 * was told the content no longer matches its fingerprint and was NOT told about
 * `--amend`; the obvious next move is then `--freeze`, which launders the tamper
 * ADR-005 exists to make detectable.
 *
 * WHY ONLY THE INFRA ARM. A FAIL is not an error — it is a successful
 * verification whose answer is no, and the report already says so. Printing
 * `ERROR:` there would tell an operator, and every log scraper they own, that
 * SpecWitness malfunctioned when it did precisely its job. NEEDS_HUMAN likewise.
 *
 * The text is the failing stage's own, carried through `StageTimelineEntry` by
 * story 3.3 and already redacted there — the edge composes nothing and holds no
 * second copy of anyone's wording.
 */
function reportInfraFailure(result: RunResult): void {
  if (result.outcome.infraError === undefined) {
    return;
  }

  // The FIRST error entry: with an early stop there is one, and taking the first
  // means the pair names the failure that ended the run rather than a later
  // consequence of it.
  const failed = result.stages.find((stage) => stage.status === 'error');
  if (failed?.detail === undefined) {
    // Fail closed rather than silently: an infra outcome with no explanation is
    // itself worth reporting, and a bare exit 3 with no stderr is the state this
    // function exists to end.
    printError(
      `verification could not reach a conclusion: ${result.outcome.infraError} error`,
      `inspect the stored run at ${result.environment.runDirectory}`,
    );
    return;
  }

  printError(failed.detail, failed.hint);
}

/**
 * The plan this run will execute, and what compiling it cost.
 *
 * `plan` is `undefined` only for a project that declares gates and plans nothing — the
 * gates-only mode Epic 3 shipped and this story preserves.
 */
interface PlanResolution {
  readonly plan?: Plan;
  /**
   * One entry when a plan was compiled during THIS run, empty otherwise.
   *
   * Seeded into the run so `RunResult.providerUsage` is the honest answer to "what did this
   * run spend". FR-18's whole promise is that reruns are AI-free, and a promise a harness
   * cannot audit from the document it already reads is not a guarantee.
   */
  readonly providerUsage: readonly ProviderUsage[];
}

/**
 * Loads the compiled plan, compiling one first where AC3 says to.
 *
 * The four cells of `plan present × --no-ai`, which are the whole of AC3:
 *
 *   present + ai       -> execute it. Zero provider calls.
 *   present + --no-ai  -> execute it. Zero provider calls. IDENTICAL RESULT — the flag
 *                         constrains compilation, and there is nothing to compile.
 *   absent  + ai       -> compile first, RECORD it in `providerUsage`, then execute.
 *                         (AC3's precondition is "with providers configured"; a project
 *                         that assigned no `plan-author` falls through to gates-only —
 *                         see the comment at that branch.)
 *   absent  + --no-ai  -> REFUSE, hinting `specwitness plan`.
 *
 * **The refusal is the cell that must not be got wrong.** Skipping silently would leave a
 * run with zero criteria, and `aggregate([], [])` is PASS — so `--no-ai` on an unplanned
 * project would report the branch merge-eligible having observed nothing. That is the same
 * green-for-nothing `assertSomethingToAdjudicate` exists to prevent, arriving through a
 * flag instead of through an empty config.
 *
 * A plan that exists but does not match its frozen contract is REFUSED by
 * `assertPlanMatchesContract` rather than recompiled. Recompiling would be a `verify` that
 * silently rewrites a committed, reviewed artifact — `specwitness plan` is where that
 * decision is made, and its own four overwrite rules are written for it.
 */
/**
 * Builds the mechanics adapter for `--adapt` (story 5.6).
 *
 * SEPARATE FROM THE PLAN-AUTHOR RESOLUTION ABOVE, deliberately. They are different roles
 * with different authority: a plan-author drafts an artifact a human reviews and commits,
 * while this one changes what is executed inside a run that is already under way. A project
 * that assigned one has not thereby assigned the other, and conflating them would let
 * `ai.roles.plan-author` silently grant a permission nobody asked for.
 *
 * REFUSES rather than warning-and-continuing when the role is unassigned. The precedent
 * above warns for a missing `plan-author` because that path has a legitimate degraded mode
 * (gates-only, every criterion `skipped`). There is no degraded mode here: `--adapt` was
 * typed, so the operator is waiting for adaptation, and a run that quietly did none would
 * be indistinguishable from a run where nothing needed adapting.
 */
function buildMechanicsAdapter(config: SpecwitnessConfig, clock: Clock): MechanicsAdapter {
  const resolved = resolveRoleProvider(config, 'mechanics-adapter');
  if (resolved === undefined) {
    throw new ConfigError(
      'no provider is assigned to the "mechanics-adapter" role, so --adapt cannot propose anything',
      "assign one under 'ai.roles.mechanics-adapter' in .specwitness/config.yaml, or drop " +
        '--adapt to run the plan exactly as compiled',
    );
  }

  const provider = providerForRole(resolved, {
    processRunner: createProcessRunner(clock),
    clock,
    warn: (message: string) => process.stderr.write(`${message}\n`),
  });
  if (provider === undefined) {
    throw new ConfigError(
      `the "mechanics-adapter" role names provider "${resolved.name}", which could not be built`,
      "check 'ai.providers' in .specwitness/config.yaml",
    );
  }

  return createMechanicsAdapter({ provider, clock });
}

async function resolvePlan(input: {
  readonly projectRoot: string;
  readonly epic: string;
  readonly loaded: LoadedContract;
  readonly config: SpecwitnessConfig;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly allowCompilation: boolean;
}): Promise<PlanResolution> {
  const { projectRoot, epic, loaded, config } = input;

  const existing = await readPlanFile(projectRoot, epic);
  if (existing !== undefined) {
    const plan = parsePlan(existing, resolvePlanPath(projectRoot, epic));
    // Only a frozen, untampered contract can be checked against, and the guard's three
    // refusals are the merged ones. The integrity STAGE reports them in the ordinary case
    // so they land in the timeline and the persisted run; the guard is called here only
    // because comparing a plan to a contract requires a verified contract first.
    assertPlanMatchesContract(plan, assertVerifiableContract(loaded));
    return { plan, providerUsage: [] };
  }

  // NO PLAN. A project that declares no criteria to probe is not in trouble — Epic 3's
  // gates-only mode is still a legitimate configuration — but a contract that declares
  // criteria with no plan means nothing will adjudicate them.
  if (!input.allowCompilation) {
    throw new ConfigError(
      `no plan has been compiled for ${epic}, and --no-ai forbids compiling one now`,
      `run specwitness plan ${epic} first, then verify — a plan is committed and reviewed ` +
        'before it is executed, so compiling one is a deliberate act rather than something ' +
        'verify does on your behalf under --no-ai',
    );
  }

  // NO PROVIDER TO COMPILE WITH. This is NOT a refusal, and the asymmetry with `--no-ai`
  // above is deliberate rather than an oversight:
  //
  //   - `--no-ai` is the operator ASSERTING that a plan exists and must be executed
  //     without AI. No plan means that assertion is false, so the command says so.
  //   - No provider assigned is a project that never opted into AI at all. Epic 3's
  //     gates-only mode is exactly this configuration, it is shipped and documented, and
  //     AC3's precondition is explicitly "with providers configured". Refusing here would
  //     retire a working mode on this story's own judgement, in the last story of an epic.
  //
  // The green-for-nothing case is still closed, one layer down:
  // `assertSomethingToAdjudicate` refuses a project with no gates AND no probes, so a
  // gates-less project cannot reach a PASS through this path. What a gates-ONLY project
  // gets is what Epic 3 gave it — its gates executed and every criterion reported
  // `skipped` in the report. The warning below is so that outcome is never silent.
  const resolvedProvider = resolveRoleProvider(config, 'plan-author');
  if (resolvedProvider === undefined) {
    if (config.gates.length > 0) {
      printWarning(
        `no plan has been compiled for ${epic} and no provider is assigned to the ` +
          '"plan-author" role, so this run executes the declared gates only and every ' +
          `criterion will be reported as skipped. Assign a provider under ` +
          `'ai.roles.plan-author' and run specwitness plan ${epic} to verify behaviour`,
      );
    }
    return { providerUsage: [] };
  }

  // The same runner reaches the provenance read below, so the adapters' capability probe
  // is paid for once and read twice (story 3.8).
  const processRunner = createProcessRunner(input.clock);
  const provider = providerForRole(resolvedProvider, {
    processRunner,
    clock: input.clock,
    warn: (message: string) => process.stderr.write(`${message}\n`),
  });

  if (provider === undefined) {
    throw new ConfigError(
      `the "plan-author" role names provider "${resolvedProvider.name}", which could not be built`,
      "check 'ai.providers' in .specwitness/config.yaml",
    );
  }

  // THE OUTPUT DIRECTORY IS CHECKED BEFORE THE PROVIDER IS INVOKED, not before the write.
  // It is a provider-INDEPENDENT precondition, and every one of those has to run first:
  // compilation happens before a run directory exists, so a failure after it spends quota
  // that no run document records — and rerunning repeats the charge, since nothing was
  // written. `commands/plan.ts` checks this first for the same reason. Found by the fifth
  // Codex review pass, as the instance the fourth one's fix had missed.
  await assertPlansDirectory(projectRoot);

  const provenance = await readProviderProvenance(resolvedProvider, processRunner);
  const startedAt = input.clock.now().getTime();

  // `compilePlan` refuses an absent, unfrozen or tampered contract BEFORE invoking the
  // provider, so a project in that state never spends quota to learn it.
  const { plan, attempts } = await compilePlan({
    loadedContract: loaded,
    declared: declaredPlanIds(config),
    provider,
    clock: input.clock,
    ids: input.ids,
    providerName: resolvedProvider.name,
    model: provenance.model,
    providerCliVersion: provenance.providerCliVersion,
  });

  // WRITTEN TO DISK, not held in memory. A plan is a committed, reviewed artifact (Q11),
  // and a run that compiled one and kept it to itself would make the NEXT run compile
  // another — spending quota every time, and verifying against a plan no human ever saw.
  // `specwitness plan`'s own atomic writer, so there is one write path rather than two.
  await writePlanFileAtomically(projectRoot, epic, serializePlan(plan), {
    onDurabilityWarning: printWarning,
  });

  printWarning(
    `no plan existed for ${epic}, so one was compiled before verifying — this run was NOT ` +
      `AI-free, and its provider usage is recorded in the run document. Subsequent runs ` +
      `will be AI-free; commit ${planRelativePath(epic)} and review it`,
  );

  return {
    plan,
    providerUsage: [
      {
        role: 'plan-author',
        provider: resolvedProvider.name,
        durationMs: Math.max(0, input.clock.now().getTime() - startedAt),
        attempts,
        model: provenance.model,
        providerCliVersion: provenance.providerCliVersion,
      },
    ],
  };
}

/**
 * The ids a plan may reference, read from config at the edge and passed DOWN (AD-1).
 *
 * `observations:` is the one declared-command map a plan may name, used by BOTH the
 * observation surface and the shell surface. Keys a plan cannot legally reference are
 * withheld and the operator told by name, exactly as `commands/plan.ts` does — the two call
 * sites must agree, because a plan compiled against one set of ids and executed against
 * another is a plan whose probes name commands that were never offered.
 */
function declaredPlanIds(config: SpecwitnessConfig): DeclaredIds {
  const all: DeclaredIds = {
    serviceIds: Object.keys(config.services),
    commandIds: Object.keys(config.observations),
  };

  for (const { kind, id } of unreferenceableIds(all)) {
    printWarning(
      `${kind} "${id}" cannot be referenced from a plan: a plan names config ids as ` +
        'letters, digits, underscore, dot or hyphen, starting with a letter or digit. ' +
        `Criteria needing this ${kind} will be recorded as needing human review.`,
    );
  }

  return {
    serviceIds: all.serviceIds.filter(isReferenceableId),
    commandIds: all.commandIds.filter(isReferenceableId),
  };
}

/**
 * The half of the green-for-nothing refusal that is knowable BEFORE a provider is invoked.
 *
 * `assertSomethingToAdjudicate` needs the plan, because whether a criterion carries a probe
 * is the plan's decision. But one case is decidable from the contract alone: a project with
 * no gates whose contract declares NO automated criterion can never be verified mechanically
 * — 4.2's schema requires every `verifiability: human` criterion to be carried as
 * needs-human, so no plan the compiler could produce would contain a probe.
 *
 * Checked here so that case costs no provider quota. Compilation happens before a run
 * directory exists, so quota spent on the way to a refusal is quota no run document records,
 * and this command's whole claim is that such spending is auditable. Found by the fourth
 * Codex review pass.
 *
 * It is deliberately the WEAKER of the two checks and does not replace the other: a contract
 * with automated criteria that the plan-author then declines to automate is only knowable
 * after compiling, and that residual costs one compilation whose output is written to disk
 * with its provenance.
 */
function assertCouldEverAdjudicate(config: SpecwitnessConfig, loaded: LoadedContract): void {
  if (config.gates.length > 0 || !loaded.present) {
    // An absent contract is the integrity stage's refusal to report, not this one's.
    return;
  }

  if (loaded.contract.spec.criteria.some((criterion) => criterion.verifiability === 'automated')) {
    return;
  }

  throw new ConfigError(
    'this project declares no deterministic gates, and every criterion of its contract is ' +
      'marked verifiability: human, so a verification run could not check anything',
    "declare at least one gate under 'gates:' in .specwitness/config.yaml — a contract whose " +
      'criteria may only be adjudicated by a person has nothing for a run to execute, and a ' +
      'PASS that executed nothing would tell your harness the branch is merge-eligible',
  );
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
 * ========================================================================
 * WIDENED BY STORY 4.7 — NOT DELETED, AND THE DIFFERENCE IS THE WHOLE POINT
 * ========================================================================
 *
 * The rule has always been "the run could not adjudicate anything". Until
 * probes landed that reduced to "no gates declared", because nothing else
 * adjudicated a criterion mechanically — the note this comment carried through
 * Epic 4 said so, and said the second clause would become real. It now is:
 *
 *   refuse  <=>  no gates declared  AND  no automated criterion has a probe.
 *
 * So a GATE-LESS PROJECT WHOSE PLAN MAPS CRITERIA TO PROBES IS NOW VERIFIABLE
 * and is no longer refused — that configuration adjudicates plenty, and
 * refusing it would have made behavioural verification unreachable for exactly
 * the projects the epic was built for.
 *
 * And a project with NEITHER still refuses. That is the clause that matters and
 * the reason this was widened rather than removed: `aggregate([], [])` is PASS,
 * so without it the first-contact sequence — or a plan in which every criterion
 * was carried as needs-human, or one with no criteria at all — would exit 0,
 * merge-eligible, having executed nothing and observed nothing.
 *
 * A plan that plans only `needs-human` criteria counts as NOTHING TO ADJUDICATE
 * here even though it produces NEEDS_HUMAN rather than PASS at aggregation.
 * Both halves are deliberate: nothing mechanical runs, so the refusal's own
 * sentence is true, and the operator is told before a worktree is created
 * rather than after a run that could only ever have one answer.
 *
 * Decision 3.7-D4, amended by 4.7. Owner chose the refusal on 2026-09-01 over
 * documenting the green as correct.
 */
function assertSomethingToAdjudicate(config: SpecwitnessConfig, plan: Plan | undefined): void {
  if (config.gates.length > 0) {
    return;
  }

  // A probe is what makes a criterion mechanically adjudicable, so the question is
  // whether ANY automated criterion carries one — not whether a plan exists, and not
  // how many criteria it has. 4.2's schema already refuses an automated criterion with
  // an empty probe list, so in practice this is true whenever one automated criterion is
  // planned; it is written as the property rather than as its consequence, because a
  // future schema change would otherwise silently reopen the hole.
  const probes = (plan?.plan.criteria ?? []).some(
    (criterion) => criterion.disposition === 'automated' && criterion.probes.length > 0,
  );
  if (probes) {
    return;
  }

  throw new ConfigError(
    'this project declares no deterministic gates, and its plan maps no criterion to a ' +
      'probe, so a verification run could not check anything',
    "declare at least one gate under 'gates:' in .specwitness/config.yaml, or compile a " +
      'plan whose criteria carry probes with ' +
      "'specwitness plan <epic>' — a PASS that executed nothing would tell your harness " +
      'the branch is merge-eligible',
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
