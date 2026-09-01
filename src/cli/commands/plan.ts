/**
 * `specwitness plan <epic>` — compile a frozen contract into an executable plan
 * (FR-16, UJ-1).
 *
 * The CLI edge: it loads config once, injects the `Clock` and `Ids`, resolves the
 * `plan-author` role, and wires story 2.2's contract model, story 2.3's provider gate and
 * this story's compilation together. All of the judgement lives beneath it in
 * `src/authoring/**`; this file is plumbing and user experience. It follows
 * `commands/contract.ts`'s shape deliberately — thin `register`, exported testable body.
 *
 * PROMPT-FREE, and this is not optional. `plan` is named in the spine's "Non-interactive
 * first" convention alongside `verify`, `report`, `doctor` and `contract --status`: a
 * harness invokes it, so there is no TTY check, no confirmation and no prompt anywhere on
 * this path. Story 4.7 auto-compiles from inside `verify`, which would deadlock against a
 * prompt.
 *
 * FAIL CLOSED, THEN EXPLAIN. Every refusal throws; `cli/exit.ts` classifies. This file
 * never sets an exit code and never calls `printError` — the global handler in `main.ts`
 * does both, once, so there is exactly one ERROR/HINT pair per failure (AD-7).
 *
 * ONE FLAG, `--force`, AND WHY THE OVERWRITE RULE IS SHAPED THE WAY IT IS.
 *
 * A plan is a derived, regenerable artifact — unlike a contract it carries no authority of
 * its own — but it is COMMITTED and reviewed (Q11), and an operator may have adjusted probe
 * mechanics in it. So the rule follows what recompiling would actually cost:
 *
 *   - **No plan** → compile. Nothing to lose.
 *   - **A STALE plan** (its stored fingerprint no longer matches the frozen contract) →
 *     recompile, no flag. This is the exact remedy the stale-plan refusal tells the
 *     operator to run: `HINT: re-run specwitness plan`. Demanding a flag for the action
 *     our own error message prescribes would be a small, permanent annoyance on the one
 *     path that matters after every amendment.
 *   - **A CURRENT plan** → refuse without `--force`. Recompiling here changes nothing about
 *     which contract is verified and would silently discard any hand-tuned mechanics.
 *   - **An UNPARSEABLE plan** → refuse without `--force`, naming the parse problem. We
 *     cannot tell whether it is current, and overwriting a file the operator may be
 *     mid-edit on is not a decision to make on their behalf.
 *
 * `--force` is deliberately NOT the contract command's `--force`. There it overrides a
 * refusal that protects an audit trail; here there is no audit trail to protect, because a
 * plan's authority is entirely borrowed from the contract fingerprint it records.
 *
 * `process.cwd()` is the project root and is not searched upward, matching the merged
 * `init`, `doctor`, `contract` and `report`.
 */

import type { Command } from 'commander';

import {
  assertPlansDirectory,
  planRelativePath,
  readPlanFile,
  resolvePlanPath,
  writePlanFileAtomically,
} from '../../authoring/plan-file.js';
import { compilePlan } from '../../authoring/plan.js';
import {
  assertVerifiableContract,
  type LoadedContract,
} from '../../authoring/verifiable.js';
import {
  contractRelativePath,
  readContractFile,
  resolveContractPath,
} from '../../authoring/contract-file.js';
import { loadConfig, resolveRoleProvider } from '../../config/index.js';
import type { SpecwitnessConfig } from '../../config/index.js';
import type { Contract } from '../../domain/contract.js';
import { ConfigError, IntegrityError } from '../../domain/errors.js';
import { normalizeEpicId } from '../../domain/ids.js';
import type { Clock, Ids } from '../../domain/ports.js';
import type { Plan } from '../../domain/plan.js';
import { SystemClock } from '../../infra/clock.js';
import { RandomIds } from '../../infra/ids.js';
import { createProcessRunner } from '../../infra/process-runner.js';
import { providerForRole } from '../../providers/index.js';
import { parseContract } from '../../schemas/contract.js';
import {
  assertPlanMatchesContract,
  isReferenceableId,
  parsePlan,
  serializePlan,
  unreferenceableIds,
} from '../../schemas/plan.js';
import type { DeclaredIds } from '../../schemas/plan.js';
import { readProviderProvenance } from '../contract/provenance.js';
import { printWarning } from '../print-error.js';

interface PlanOptions {
  readonly force?: boolean;
}

export function register(program: Command): void {
  program
    .command('plan')
    .description('compile a frozen verification contract into an executable plan')
    .argument('<epic>', "epic to compile a plan for, e.g. '7' or 'epic-7'")
    .option('--force', 'recompile over a plan that already matches the frozen contract')
    .addHelpText(
      'after',
      '\nRun this at the project root — the directory holding .specwitness/.\n\n' +
        'A plan maps every criterion of the frozen contract to probes with explicit\n' +
        'assertions, or records it as needing human review. Once compiled it executes with\n' +
        'no AI involved, so the plan is committed and reviewed alongside the contract.\n\n' +
        'A plan that no longer matches its contract is recompiled without --force: that is\n' +
        'the remedy verify tells you to run after amending a contract.\n',
    )
    .action(async (epic: string, options: PlanOptions) => {
      await runPlan(epic, options, new SystemClock(), new RandomIds());
    });
}

/**
 * The command body, with the determinism ports injected so tests need no wall clock and no
 * real randomness (AD-9).
 *
 * Exported for unit tests; the registered action supplies `SystemClock` and `RandomIds`.
 */
export async function runPlan(
  rawEpic: string,
  options: PlanOptions,
  clock: Clock,
  ids: Ids,
): Promise<void> {
  // Normalise FIRST: a malformed epic id is a usage error (exit 64) and must be reported as
  // one before any filesystem or config work makes it look like an environment problem.
  const epic = normalizeEpicId(rawEpic);
  const projectRoot = process.cwd();

  await assertPlansDirectory(projectRoot);

  const loadedContract = await loadContract(projectRoot, epic);
  // Refused here as well as inside `compilePlan`, and deliberately: an operator who has not
  // frozen their contract must be told so before config loading or provider construction
  // can fail first and send them to fix the wrong thing. The refusal itself is the merged
  // `assertVerifiableContract` in both places, so there is still only one implementation.
  const contract = assertVerifiableContract(loadedContract);

  await assertPlanIsReplaceable(projectRoot, epic, contract, options.force === true);

  const config = loadConfig(projectRoot);
  const resolved = resolveRoleProvider(config, 'plan-author');

  if (resolved === undefined) {
    throw new ConfigError(
      'no provider is assigned to the "plan-author" role, so a plan cannot be compiled',
      "assign one under 'ai.roles.plan-author' in .specwitness/config.yaml, naming a " +
        "provider declared under 'ai.providers'",
    );
  }

  // Hoisted rather than inlined so the SAME runner reaches the provenance read below. Both
  // adapters cache their capability probe per session keyed partly by runner identity, so
  // sharing the instance is what makes provenance free: the probe is paid for once and read
  // twice (story 3.8).
  const processRunner = createProcessRunner(clock);

  const provider = providerForRole(resolved, {
    processRunner,
    clock,
    // Adapter warnings (billing risk) are diagnostics, so they go to stderr and never
    // pollute stdout.
    warn: (message: string) => process.stderr.write(`${message}\n`),
  });

  if (provider === undefined) {
    throw new ConfigError(
      `the "plan-author" role names provider "${resolved.name}", which could not be built`,
      "check 'ai.providers' in .specwitness/config.yaml",
    );
  }

  const provenance = await readProviderProvenance(resolved, processRunner);

  // A ProviderError from the gate propagates from here, and NOTHING has been written: the
  // plan is assembled entirely in memory, and the write below is the first and only
  // filesystem mutation (FR-14, "never a partial artifact").
  const { plan, attempts } = await compilePlan({
    loadedContract,
    declared: declaredIds(config, printWarning),
    provider,
    clock,
    ids,
    providerName: resolved.name,
    model: provenance.model,
    providerCliVersion: provenance.providerCliVersion,
  });

  await writePlanFileAtomically(projectRoot, epic, serializePlan(plan), {
    onDurabilityWarning: printWarning,
  });

  report(epic, plan, attempts);
}

/**
 * The ids a plan may reference, read from config at the edge and passed DOWN.
 *
 * `src/schemas/**` and `src/authoring/**` receive plain strings rather than a config value,
 * so neither layer learns the config's shape (AD-1) and neither can reach a
 * `DeclaredCommand`. Compilation needs to know WHICH ids exist; it never needs to know what
 * they run.
 *
 * `observations:` is the one map of declared commands a plan may reference — used by both
 * the observation surface (4.5) and the shell surface (4.6), which differ in what they
 * assert on rather than in where their command comes from.
 *
 * KEYS A PLAN CANNOT NAME ARE WITHHELD, AND SAID OUT LOUD. The config accepts any non-empty
 * string as a key; a plan's id fields are stricter, because that strictness is what stops a
 * command line being smuggled through `commandId` (see `Identifier` in
 * `src/schemas/plan.ts`). A project may therefore declare `services: {"public api": ...}`,
 * which no plan can reference. Passing such a key into the prompt anyway is the bad outcome:
 * the provider drafts a probe naming it, the gate rejects it, and the entire retry budget is
 * spent learning something the prompt could have known. So it is filtered out and the
 * operator is told, by name, with the fix.
 */
function declaredIds(config: SpecwitnessConfig, warn: (message: string) => void): DeclaredIds {
  const all: DeclaredIds = {
    serviceIds: Object.keys(config.services),
    commandIds: Object.keys(config.observations),
  };

  for (const { kind, id } of unreferenceableIds(all)) {
    warn(
      `${kind} "${id}" cannot be referenced from a plan: a plan names config ids as ` +
        'letters, digits, underscore, dot or hyphen, starting with a letter or digit — the ' +
        'restriction is what stops a command line being smuggled through an id field. ' +
        `Criteria needing this ${kind} will be recorded as needing human review. Rename the ` +
        'key in .specwitness/config.yaml to make it usable.',
    );
  }

  return {
    serviceIds: all.serviceIds.filter(isReferenceableId),
    commandIds: all.commandIds.filter(isReferenceableId),
  };
}

/** Reads and parses the contract file, distinguishing absence from failure. */
async function loadContract(projectRoot: string, epic: string): Promise<LoadedContract> {
  const path = contractRelativePath(epic);
  const text = await readContractFile(projectRoot, epic);

  if (text === undefined) {
    return { present: false, epic, path };
  }

  return {
    present: true,
    epic,
    path,
    contract: parseContract(text, resolveContractPath(projectRoot, epic)),
  };
}

/**
 * Refuses to overwrite an existing plan unless doing so is the sanctioned remedy.
 *
 * See the module header for the four cases and why each is shaped the way it is.
 */
async function assertPlanIsReplaceable(
  projectRoot: string,
  epic: string,
  contract: Contract,
  force: boolean,
): Promise<void> {
  const text = await readPlanFile(projectRoot, epic);
  if (text === undefined || force) {
    return;
  }

  const relative = planRelativePath(epic);

  let existing: Plan;
  try {
    existing = parsePlan(text, resolvePlanPath(projectRoot, epic));
  } catch (cause) {
    throw new IntegrityError(
      `a plan for ${epic} already exists at ${relative} but could not be read: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
      `inspect it with 'git diff ${relative}', or pass --force to replace it — recompiling discards whatever is in that file`,
    );
  }

  try {
    assertPlanMatchesContract(existing, contract);
  } catch {
    // Stale, or compiled for another epic. Recompiling is exactly what `verify` tells the
    // operator to do in that situation, so it must not require a flag.
    return;
  }

  throw new IntegrityError(
    `the plan for ${epic} at ${relative} already matches the frozen contract ` +
      `(version ${contract.spec.version})`,
    'nothing needs recompiling — pass --force to compile a fresh plan anyway, which discards any mechanics you have edited by hand',
  );
}

/**
 * A bounded summary on stdout.
 *
 * Bounded on purpose: a compiled plan can hold hundreds of probes, and a command that
 * prints all of them buries the two numbers an operator acts on. The plan itself is the
 * artifact to read, and its path is the first thing printed.
 */
function report(epic: string, plan: Plan, attempts: number): void {
  const criteria = plan.plan.criteria;
  const automated = criteria.filter((entry) => entry.disposition === 'automated');
  const probes = automated.reduce(
    (total, entry) => total + (entry.disposition === 'automated' ? entry.probes.length : 0),
    0,
  );
  const needsHuman = criteria.length - automated.length;

  process.stdout.write(
    `Wrote ${planRelativePath(epic)} — ${criteria.length} criteria, ` +
      `${probes} ${probes === 1 ? 'probe' : 'probes'}, ` +
      `${needsHuman} needing human review.\n`,
  );

  // Not-safely-automatable is the case an operator must actually look at: the contract
  // marked the criterion automated and compilation could not honour that. Naming the ids
  // is the difference between a number and an action.
  const unmappable = criteria
    .filter((entry) => entry.disposition === 'needs-human' && entry.reason === 'not-safely-automatable')
    .map((entry) => entry.criterionId);

  if (unmappable.length > 0) {
    process.stdout.write(
      `\n${unmappable.length} automated ${unmappable.length === 1 ? 'criterion' : 'criteria'} could not be mapped to a safe probe ` +
        `and will report NEEDS_HUMAN: ${unmappable.join(', ')}.\n` +
        'Review the guidance recorded for each; sharpening the criterion often makes it automatable.\n',
    );
  }

  if (attempts > 1) {
    // Retries cost real subscription quota, so the count is visible rather than invisible.
    process.stderr.write(`Compiled after ${attempts} provider attempts.\n`);
  }
}
