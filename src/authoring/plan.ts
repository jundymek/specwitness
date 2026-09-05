/**
 * Plan compilation — the application service behind `specwitness plan <epic>` (FR-16, UJ-1).
 *
 * The assembly point: a frozen contract in, story 2.3's schema gate in the middle, a
 * `Plan` out. It invents no model, no schema, no retry and no parser — if this file ever
 * grows one, it has taken over another story's job. It mirrors `authoring/contract.ts`
 * deliberately, because contract generation already does this exact dance.
 *
 * NO FILE I/O HERE. The command writes; this function is pure application logic over
 * injected ports, which is what lets every case in `tests/unit/authoring/plan.test.ts` run
 * through a scripted provider with zero subprocesses (AD-12). It is also why a gate
 * exhaustion cannot leave a half-written plan: there is nothing here that could have
 * written one, and `writePlanFileAtomically` is only ever reached after this returns.
 *
 * ── WHAT THE PROVIDER DOES NOT DECIDE (AD-2) ───────────────────────────────────────────
 *
 * The draft schema has no field for the epic id, the contract version, the contract
 * fingerprint, the deterministic-data SEED, the schema version or any timestamp, and every
 * one of those is filled in below from something SpecWitness knows. The seed is the one
 * that might look like a drafting decision and is not: it is the value every volatile input
 * derives from, so a provider choosing it would be a provider choosing how reproducible the
 * plan is. It is minted here through the injected `Ids` port (AD-9), exactly as run ids are.
 *
 * ── WHAT THE PROVIDER CANNOT DO, WHATEVER IT RETURNS ───────────────────────────────────
 *
 * Everything in `src/schemas/plan.ts`'s header: no command string, no host, no
 * assertion-free probe, no probe on a human criterion, no dropped criterion, no undeclared
 * config id. All of it is enforced by the schema the gate validates against, so a hostile
 * draft exhausts the retry budget and raises `ProviderError` (exit 3) rather than producing
 * a plan. **No validation is re-implemented in this file**, and none may be added: AD-2
 * names `src/providers/invoke.ts` as the one gate, and two gates disagree exactly once, in
 * production.
 *
 * AD-1: application layer. Imports `domain/`, `schemas/` and `providers/`; never `cli/`.
 * AD-9: the `Clock` and `Ids` are injected — no `new Date()` and no `Math.random()` here.
 */

import type { AgentProvider, AgentRequest } from '../domain/agent-provider.js';
import type { RedactionOptions } from '../domain/evidence.js';
import type { Contract } from '../domain/contract.js';
import type { Plan } from '../domain/plan.js';
import type { Clock, Ids } from '../domain/ports.js';
import { invoke } from '../providers/invoke.js';
import {
  PLAN_SCHEMA_VERSION,
  planDraftSchemaFor,
  type DeclaredIds,
  type PlanDraft,
} from '../schemas/plan.js';

import { assertVerifiableContract, type LoadedContract } from './verifiable.js';
import { buildPlanPrompt } from './plan-prompt.js';

/**
 * Width of the deterministic-data seed, in base36 characters.
 *
 * Sixteen characters is ~82 bits — far more than collision resistance needs for a per-plan
 * value, and short enough to read in a committed YAML file. The seed is not a secret and is
 * not a security boundary; it exists so two runs of one plan derive the same volatile
 * inputs (AD-9, Q36).
 */
const SEED_LENGTH = 16;

export interface CompilePlanInput {
  /**
   * The contract as the caller found it. Passed as a `LoadedContract` rather than a
   * `Contract` so the not-frozen / tampered / absent refusals come from the merged
   * `assertVerifiableContract` — the single implementation of that question — instead of a
   * fourth "not frozen" message written here.
   */
  readonly loadedContract: LoadedContract;
  /** The ids this project declares, read from config at the edge (AD-1). */
  readonly declared: DeclaredIds;
  readonly provider: AgentProvider;
  readonly clock: Clock;
  readonly ids: Ids;
  /** The `ai.providers` key the `plan-author` role resolved to, for `meta.provenance`. */
  readonly providerName: string;
  /** Model as reported by the CLI, or `null` where it cannot report one. */
  readonly model: string | null;
  /** The AGENT CLI's version (`claude --version`), never SpecWitness's. */
  readonly providerCliVersion: string | null;
  /**
   * The run's redaction options (AD-10), forwarded to the prompt assembly.
   *
   * ⚠️ **ADDED AFTER A CODEX P1**, and the reason is worth keeping. Story 6.8 first gave the
   * prompt BUILDER a `redaction` parameter and left this entry point without one, so the
   * run's config-declared `extraPatterns` could not reach the builder from production at
   * all — the parameter was reachable only from a direct builder test, which is the weakest
   * possible form of "the behaviour is implemented".
   *
   * The built-in patterns always applied and still do. What was unreachable is exactly the
   * *config-declared extra* patterns, i.e. the shapes a project adds precisely because the
   * built-ins do not recognise its own secrets.
   *
   * The seam is now continuous through the whole of `src/authoring/**`. It is still not fed,
   * because **nothing in this product constructs a `RedactionOptions` from config anywhere**
   * — `src/cli/commands/verify.ts` composes its probe dispatcher without one. Building that
   * value is a feature (AD-10's config-declared patterns are unimplemented product-wide),
   * not a refactor, and it is outside story 6.8's layer. When someone does wire it, this is
   * the one place per flow that has to receive it.
   */
  readonly redaction?: RedactionOptions;
}

export interface CompilePlanResult {
  readonly plan: Plan;
  /** How many provider attempts the gate spent. Reported so the cost is visible (FR-14). */
  readonly attempts: number;
}

/**
 * Compiles a plan for one epic from its frozen contract.
 *
 * Throws `IntegrityError` / `ContractNotFrozenError` (exit 3) when the contract is absent,
 * never frozen or tampered — before any provider is invoked, so a project in that state
 * never spends subscription quota to learn it. Throws `ProviderError` (exit 3) when the
 * gate's budget is exhausted; the caller propagates it and writes nothing.
 */
export async function compilePlan(input: CompilePlanInput): Promise<CompilePlanResult> {
  // FIRST, and before anything that costs money: only a frozen, untampered contract may be
  // compiled. A plan compiled from a draft would carry a fingerprint the draft does not
  // have, and a plan compiled from a tampered contract would encode an expectation nobody
  // reviewed.
  const contract = assertVerifiableContract(input.loadedContract);

  const request: AgentRequest<PlanDraft> = {
    role: 'plan-author',
    prompt: buildPlanPrompt(contract, input.declared, input.redaction),
    responseSchema: planDraftSchemaFor(contract, input.declared),
    // `jsonSchema` is deliberately NOT set. The gate derives it from `responseSchema` in
    // exactly one place, so two sites cannot disagree about the shape the model is steered
    // toward versus validated against (ADR-001).
  };

  const response = await invoke(request, { provider: input.provider, clock: input.clock });

  return {
    plan: assemble(contract, response.parsed, input),
    attempts: response.attempts.length,
  };
}

/**
 * Builds the persisted plan from the validated draft plus the facts SpecWitness owns.
 *
 * Constructed field by field rather than by spreading the draft. That is what guarantees no
 * key the model volunteered can reach the artifact — the same discipline
 * `authoring/contract.ts` applies when it builds each `Criterion` explicitly, and belt and
 * braces alongside the strict schema rather than instead of it.
 */
function assemble(contract: Contract, draft: PlanDraft, input: CompilePlanInput): Plan {
  const now = input.clock.now().toISOString();

  return {
    plan: {
      // Already canonical — it came from the frozen contract, not from the operator's
      // argument vector.
      epic: contract.spec.epic,
      contract: {
        version: contract.spec.version,
        // Non-null by construction: `assertVerifiableContract` returned, so the contract is
        // frozen and its fingerprint matched its content. Read from `meta`, never
        // recomputed — `schemas/canonical.ts` is the single hasher.
        fingerprint: contract.meta.fingerprint as string,
      },
      data: {
        seed: input.ids.randomBase36(SEED_LENGTH),
        bindings: draft.data.bindings.map((binding) =>
          binding.kind === 'fixed'
            ? { kind: 'fixed', name: binding.name, value: binding.value }
            : { kind: 'volatile', name: binding.name, reason: binding.reason },
        ),
      },
      // ORDER FOLLOWS THE CONTRACT, not the draft. A plan whose criteria are in contract
      // order reads alongside the contract in a diff, and — since the gate has already
      // proven the draft covers every criterion exactly once — reordering here loses
      // nothing. `find` is safe for the same reason.
      criteria: contract.spec.criteria.map((criterion) => {
        const planned = draft.criteria.find((entry) => entry.criterionId === criterion.id);
        if (planned === undefined) {
          // Unreachable: the draft schema refuses a draft missing any criterion, and this
          // runs only after the gate accepted one. Kept as a fail-closed floor rather than
          // a cast, because the failure it guards against — a criterion silently absent
          // from a plan — is the exact thing Q38 exists to prevent.
          throw new Error(
            `internal: criterion ${criterion.id} passed the draft gate but is missing from the accepted draft`,
          );
        }
        return planned;
      }),
    },
    meta: {
      schemaVersion: PLAN_SCHEMA_VERSION,
      compiledAt: now,
      provenance: {
        provider: input.providerName,
        model: input.model,
        providerCliVersion: input.providerCliVersion,
        generatedAt: now,
      },
    },
  };
}
