/**
 * `specwitness contract <epic>` — generate, review, freeze, status
 * (FR-7, FR-8, UJ-1).
 *
 * The only way a verification contract legitimately comes into existence. This
 * is the CLI edge: it loads config once, injects the `Clock`, and wires story
 * 2.1's ingestion, 2.3's provider gate and 2.2's contract model together. All
 * of the judgement lives beneath it in `src/authoring/**`; this file is
 * plumbing and user experience.
 *
 * ONE COMMAND, OPTIONS — NOT SUBCOMMANDS. `--freeze`, `--status`, `--json` and
 * `--force` are registered as a flat `.option()` chain so story 2.7 can append
 * `--amend` and `--reason` without restructuring anything.
 *
 * STREAM DISCIPLINE (AC3). With `--json`, stdout carries the JSON document and
 * NOTHING else — a stray `console.log` breaks `jq`, and the harness parses this.
 * Human rendering goes to stderr, exactly as `doctor --json` does.
 *
 * FAIL CLOSED, THEN EXPLAIN. Every refusal throws; `cli/exit.ts` classifies.
 * This file never sets an exit code and never calls `printError` — the global
 * handler in `main.ts` does both, once, so there is exactly one ERROR/HINT pair
 * per failure.
 *
 * THE REFUSALS, and why each exists:
 *
 *  - **not initialised** → `HINT:` run `init`. This command never creates
 *    `.specwitness/`; a mistyped `cd` must not scaffold a project in someone's
 *    home directory.
 *  - **existing frozen contract** → refused, `HINT:` naming `--amend` and its
 *    TTY requirement. Overwriting a frozen contract is the tamper path ADR-005
 *    exists to make visible.
 *  - **existing draft** → refused without `--force`. Regenerating over a
 *    human's edited draft without asking is the same class of harm as silent
 *    tampering.
 *  - **`--force` on a FROZEN contract** → still refused, identically. `--force`
 *    overrides exactly one refusal, the draft one. If it could overwrite a
 *    frozen contract, story 2.7's TTY-gated `--amend` would be decorative,
 *    because an agent would simply pass `--force`.
 *  - **no `contract-author` role** → refused with a clear message. Never a
 *    crash, and never a fabricated contract.
 *
 * `process.cwd()` is the project root and is not searched upward, matching the
 * merged `init`, `doctor` and `report` (`--root` arrives in Epic 3).
 */

import type { Command } from 'commander';

import type { FlaggedCriterion } from '../../authoring/coupling.js';
import {
  assertProjectInitialised,
  contractRelativePath,
  readContractFile,
  resolveContractPath,
  writeContractFileAtomically,
} from '../../authoring/contract-file.js';
import { generateDraft } from '../../authoring/contract.js';
import { processAmendIo, runAmend } from './contract-amend.js';
import { contractStatusState, type LoadedContract } from '../../authoring/verifiable.js';
import { loadConfig, resolveRoleProvider } from '../../config/index.js';
import type { Contract } from '../../domain/contract.js';
import { ConfigError, IntegrityError, UsageError } from '../../domain/errors.js';
import { normalizeEpicId } from '../../domain/ids.js';
import type { Clock } from '../../domain/ports.js';
import { ingestEpic } from '../../ingest/index.js';
import { providerForRole } from '../../providers/index.js';
import { SystemClock } from '../../infra/clock.js';
import { createProcessRunner } from '../../infra/process-runner.js';
import { freeze, parseContract, serializeContract } from '../../schemas/contract.js';
import {
  integrityFor,
  renderCouplingWarnings,
  renderStatusHuman,
  renderStatusJson,
  type ContractStatus,
} from '../contract/render.js';

interface ContractOptions {
  readonly freeze?: boolean;
  readonly status?: boolean;
  readonly json?: boolean;
  readonly force?: boolean;
  readonly amend?: boolean;
  readonly reason?: string;
}

export function register(program: Command): void {
  program
    .command('contract')
    .description('generate, review and freeze an epic verification contract')
    .argument('<epic>', "epic to draft a contract for, e.g. '7' or 'epic-7'")
    .option('--freeze', 'freeze the reviewed draft and print its fingerprint')
    .option('--status', 'report the contract state without prompting')
    .option('--json', 'with --status, emit a machine-readable report on stdout')
    .option('--force', 'regenerate over an existing DRAFT (never a frozen contract)')
    .option('--amend', 'supersede a frozen contract with a new version (operator only, requires a terminal)')
    .option(
      '--reason <text>',
      'with --amend, the audit-trail reason; prompted for when omitted. NOT a confirmation bypass',
    )
    .addHelpText(
      'after',
      '\nRun this at the project root — the directory holding .specwitness/.\n\n' +
        'The usual sequence is: generate a draft, review and edit it by hand, then\n' +
        'freeze it. A frozen contract is the sole authority on what must be true, so\n' +
        'it is never overwritten: changing one is an explicit amendment.\n',
    )
    .action(async (epic: string, options: ContractOptions) => {
      await runContract(epic, options, new SystemClock());
    });
}

/**
 * The command body, with the clock injected so tests need no wall clock.
 *
 * Exported for unit tests; the registered action supplies `SystemClock`.
 */
export async function runContract(
  rawEpic: string,
  options: ContractOptions,
  clock: Clock,
): Promise<void> {
  assertCoherentOptions(options);

  // Normalise FIRST: a malformed epic id is a usage error (exit 64) and must be
  // reported as one before any filesystem or config work makes it look like an
  // environment problem.
  const epic = normalizeEpicId(rawEpic);
  const projectRoot = process.cwd();

  // AMEND DISPATCHES FIRST, BEFORE the project check. The no-TTY refusal is
  // absolute (ADR-005), so it must not depend on filesystem state: run in an
  // uninitialised directory, `assertProjectInitialised` would answer "run init"
  // and an agent would learn that the refusal has an environmental exception.
  // A policy with an exception is not a policy. `runAmend` checks the TTY first
  // and re-asserts initialisation itself, so the interactive path still gets
  // the init hint.
  if (options.amend === true) {
    await runAmend({
      projectRoot,
      epicId: epic,
      ...(options.reason === undefined ? {} : { reason: options.reason }),
      now: clock.now(),
      io: processAmendIo(),
    });
    return;
  }

  await assertProjectInitialised(projectRoot);

  if (options.status === true) {
    await reportStatus(projectRoot, epic, options.json === true);
    return;
  }

  if (options.freeze === true) {
    await freezeContract(projectRoot, epic, clock);
    return;
  }

  await generateContract(projectRoot, epic, options, clock);
}

/**
 * Rejects invocations that ask for two things, or for something this command
 * cannot do, INSTEAD of silently honouring part of the request.
 *
 * The dangerous case, and the reason this exists: `contract 7 --json` reads
 * like a query, and without this check it GENERATED AND WROTE a draft while
 * printing human text. An invocation shaped like a question must never mutate
 * the project by surprise.
 *
 * `--force` is refused alongside `--status`/`--freeze` for a related reason.
 * It applies only to regeneration over an existing draft, and it NEVER
 * overrides a frozen or tampered contract (ADR-005). Someone typing
 * `--freeze --force` at a tampered contract plausibly believes it will override
 * the refusal; silently ignoring the flag would leave them believing they
 * forced something. Refusing says so.
 *
 * MODES ARE MUTUALLY EXCLUSIVE and story 2.7's `--amend` joins this list — one
 * entry in `MODES` and one line in the `--force` check, nothing restructured.
 */
function assertCoherentOptions(options: ContractOptions): void {
  const MODES: readonly (readonly [string, boolean])[] = [
    ['--status', options.status === true],
    ['--freeze', options.freeze === true],
    ['--amend', options.amend === true],
  ];

  const requested = MODES.filter(([, on]) => on).map(([name]) => name);

  if (requested.length > 1) {
    throw new UsageError(
      `${requested.join(' and ')} ask for different things and cannot be combined`,
      'run them as separate commands — the usual sequence is generate, review, --freeze, then --status',
    );
  }

  if (options.json === true && options.status !== true) {
    throw new UsageError(
      '--json only applies to --status, and on its own it would silently generate a contract',
      `run 'specwitness contract <epic> --status --json' to read the state, or drop --json to generate a draft`,
    );
  }

  // Same rule as `--json` above, and for the same reason: an invocation shaped
  // like an amendment must never generate a contract by surprise.
  // `contract 7 --reason "..."` reads like the amend flow, and silently
  // ignoring the flag would write a fresh draft over the operator's intent.
  if (options.reason !== undefined && options.amend !== true) {
    throw new UsageError(
      '--reason only applies to --amend, and on its own it would silently generate a contract',
      `run 'specwitness contract <epic> --amend' in a terminal to amend a frozen contract`,
    );
  }

  if (options.force === true && requested.length > 0) {
    throw new UsageError(
      `--force does not apply to ${requested[0] as string}`,
      '--force only replaces an existing DRAFT during generation; it never overrides a frozen contract, which is what --amend is for',
    );
  }
}

/** Reads and parses the contract file, distinguishing absence from failure. */
async function load(projectRoot: string, epic: string): Promise<LoadedContract> {
  const path = contractRelativePath(epic);
  const text = await readContractFile(projectRoot, epic);

  if (text === undefined) {
    return { present: false, epic, path };
  }

  // parseContract throws ConfigError for a malformed document and
  // IntegrityError for one whose lifecycle fields contradict each other. Both
  // are exit 3 and both propagate: a file we cannot read is a failure, not a
  // status answer.
  return { present: true, epic, path, contract: parseContract(text, resolveContractPath(projectRoot, epic)) };
}

/**
 * AC3 — report state without prompting.
 *
 * A tampered-but-parseable contract exits 0 with `integrity: "mismatch"`:
 * `--status` answered the question, and "tampered" is the answer. Only a file
 * that cannot be read or parsed at all is a failure (exit 3), because then
 * there is no state to report ABOUT and reporting one would mean inventing it.
 */
async function reportStatus(projectRoot: string, epic: string, json: boolean): Promise<void> {
  const loaded = await load(projectRoot, epic);
  const state = contractStatusState(loaded);

  const status: ContractStatus = {
    epic,
    path: contractRelativePath(epic),
    state,
    integrity: integrityFor(state),
    version: loaded.present ? loaded.contract.spec.version : null,
    fingerprint: loaded.present ? loaded.contract.meta.fingerprint : null,
    criteriaCount: loaded.present ? loaded.contract.spec.criteria.length : null,
    frozenAt: loaded.present ? loaded.contract.meta.frozenAt : null,
  };

  if (json) {
    process.stdout.write(renderStatusJson(status));
    process.stderr.write(renderStatusHuman(status));
    return;
  }

  process.stdout.write(renderStatusHuman(status));
}

/**
 * AC2 — freeze the reviewed draft and print its fingerprint.
 *
 * Idempotence is story 2.2's: `freeze` returns the contract unchanged when it
 * is already frozen and its content still matches, so re-freezing does not bump
 * the version, rewrite timestamps, or rewrite the file. That last part is
 * enforced here: an unchanged result is not written back.
 *
 * A draft carrying a non-empty `meta.history` takes this ordinary path with no
 * special case — that draft is the normal output of story 2.7's amendment and
 * the second half of the only sanctioned change path in the product.
 */
async function freezeContract(projectRoot: string, epic: string, clock: Clock): Promise<void> {
  const loaded = await load(projectRoot, epic);

  if (!loaded.present) {
    throw new IntegrityError(
      `no contract for ${epic} to freeze (expected ${contractRelativePath(epic)})`,
      `generate one first with 'specwitness contract ${epic}'`,
    );
  }

  // Throws IntegrityError when a frozen contract's content changed — that is a
  // tamper, not a re-freeze, and story 2.7's --amend is the way to record a
  // legitimate change.
  const frozen = freeze(loaded.contract, clock.now());

  if (frozen !== loaded.contract) {
    await writeContractFileAtomically(projectRoot, epic, serializeContract(frozen));
  }

  // UJ-1's climax: the full lowercase-hex fingerprint, never truncated.
  process.stdout.write(`${frozen.meta.fingerprint ?? ''}\n`);
  process.stderr.write(
    `Froze ${contractRelativePath(epic)} at version ${frozen.spec.version} ` +
      `(${frozen.spec.criteria.length} criteria).\n`,
  );
}

/** AC1 — draft a contract, refusing rather than overwriting. */
async function generateContract(
  projectRoot: string,
  epic: string,
  options: ContractOptions,
  clock: Clock,
): Promise<void> {
  const existing = await load(projectRoot, epic);

  if (existing.present) {
    const state = contractStatusState(existing);

    // --force does NOT reach this branch. Overwriting a frozen contract is the
    // tamper path ADR-005 exists to make visible, and if --force could do it,
    // story 2.7's TTY-gated --amend would be trivially bypassable.
    if (state === 'frozen' || state === 'tampered') {
      throw new IntegrityError(
        `the contract for ${epic} is frozen (version ${existing.contract.spec.version}); ` +
          'regenerating would overwrite a frozen contract',
        `amend it explicitly with 'specwitness contract ${epic} --amend' (requires an ` +
          `interactive terminal), or remove ${contractRelativePath(epic)} deliberately if this ` +
          'contract was never real',
      );
    }

    if (options.force !== true) {
      throw new IntegrityError(
        `a draft contract for ${epic} already exists at ${contractRelativePath(epic)}`,
        `review it, freeze it with 'specwitness contract ${epic} --freeze', or pass --force to ` +
          'replace it — regenerating discards any edits you have made',
      );
    }
  }

  const config = loadConfig(projectRoot);
  const resolved = resolveRoleProvider(config, 'contract-author');

  if (resolved === undefined) {
    throw new ConfigError(
      'no provider is assigned to the "contract-author" role, so a contract cannot be drafted',
      "assign one under 'ai.roles.contract-author' in .specwitness/config.yaml, naming a " +
        "provider declared under 'ai.providers'",
    );
  }

  const provider = providerForRole(resolved, {
    processRunner: createProcessRunner(clock),
    clock,
    // Adapter warnings (billing risk) are diagnostics, so they go to stderr and
    // never pollute stdout.
    warn: (message: string) => process.stderr.write(`${message}\n`),
  });

  if (provider === undefined) {
    throw new ConfigError(
      `the "contract-author" role names provider "${resolved.name}", which could not be built`,
      "check 'ai.providers' in .specwitness/config.yaml",
    );
  }

  const epicSpec = ingestEpic({
    projectRoot,
    epicId: epic,
    planningArtifacts: config.planning.planningArtifacts,
    implementationArtifacts: config.planning.implementationArtifacts,
  });

  // A ProviderError from the gate propagates from here, and NOTHING has been
  // written: the draft is assembled entirely in memory, and the write below is
  // the first and only filesystem mutation.
  const { contract, hints } = await generateDraft({
    epicSpec,
    provider,
    clock,
    providerName: resolved.name,
    // The response envelope reports no model today; recording the absence
    // explicitly beats inventing a value (AD-5).
    model: null,
    providerCliVersion: null,
  });

  await writeContractFileAtomically(projectRoot, epic, serializeContract(contract));

  report(epic, contract, hints);
}

function report(epic: string, contract: Contract, hints: readonly FlaggedCriterion[]): void {
  process.stdout.write(
    `Wrote ${contractRelativePath(epic)} — ${contract.spec.criteria.length} criteria, draft.\n`,
  );

  const warnings = renderCouplingWarnings(hints);
  if (warnings !== '') {
    process.stdout.write(`\n${warnings}`);
  }

  process.stdout.write(
    `\nReview it, then freeze it with 'specwitness contract ${epic} --freeze'.\n`,
  );
}
