/**
 * Draft generation — the application service behind `specwitness contract <epic>`
 * (FR-7, UJ-1).
 *
 * This is the assembly point: story 2.1's `EpicSpec` in, story 2.3's schema
 * gate in the middle, story 2.2's `Contract` out. It invents no model, no hash,
 * no retry and no parser — if this file ever grows one, it has taken over
 * another story's job.
 *
 * NO FILE I/O HERE, deliberately. The command writes; this function is pure
 * application logic over injected ports, which is what lets every case in
 * `tests/unit/authoring/contract.test.ts` run through a scripted provider with
 * zero subprocesses (AD-12). It is also why a gate exhaustion cannot leave a
 * half-written contract: there is nothing here that could have written one.
 *
 * WHAT THE PROVIDER DOES NOT DECIDE (AD-2). The draft schema below has **no
 * `id` field**, and any id a model returns anyway is discarded. FR-7 requires
 * criterion ids that survive an amendment, so a provider choosing one would be
 * a provider deciding what survives an amendment. Versions, fingerprints and
 * the frozen flag are equally not its business: `version` starts at 1 here,
 * `fingerprint`/`frozenAt` stay null until story 2.2's `freeze` is called, and
 * nothing in the response envelope can reach any of them.
 *
 * AN EMPTY CONTRACT IS REFUSED AT THE SCHEMA. `criteria` is `.min(1)`, so a
 * provider returning zero criteria exhausts the gate and raises `ProviderError`
 * rather than producing a contract. This is the highest-severity silent wrong
 * answer this story could ship: an empty contract asserts nothing and therefore
 * PASSes every future verify run, for every epic, forever.
 *
 * AD-1: application layer. Imports `domain/`, `schemas/` and `providers/`;
 * never `cli/`. AD-9: the `Clock` is injected — no `new Date()` in this file.
 */

import { z } from 'zod';

import type { AgentProvider, AgentRequest } from '../domain/agent-provider.js';
import {
  KINDS,
  SEVERITIES,
  VERIFIABILITIES,
  type Contract,
  type Criterion,
} from '../domain/contract.js';
import type { EpicSpec } from '../domain/epic-spec.js';
import { buildCriterionId } from '../domain/ids.js';
import type { Clock } from '../domain/ports.js';
import { invoke } from '../providers/invoke.js';
import { CONTRACT_SCHEMA_VERSION } from '../schemas/contract.js';

import { flagCoupledCriteria, type FlaggedCriterion } from './coupling.js';
import { buildContractPrompt } from './prompt.js';

/**
 * The shape a `contract-author` provider must return.
 *
 * Composed from the domain's closed vocabularies rather than re-listing them,
 * so a value added to `KINDS` cannot silently fail to be draftable. `.strict()`
 * is deliberately NOT used: a model that volunteers an extra key (an `id`, a
 * `rationale`) should have that key ignored, not have the whole draft rejected
 * and a retry spent. What matters is that nothing extra reaches the contract —
 * which is guaranteed by construction below, where each `Criterion` is built
 * field by field.
 */
export const DRAFT_RESPONSE_SCHEMA = z.object({
  criteria: z
    .array(
      z.object({
        statement: z.string().min(1),
        kind: z.enum(KINDS),
        severity: z.enum(SEVERITIES),
        verifiability: z.enum(VERIFIABILITIES),
      }),
    )
    // See the module header: an empty contract is the worst artifact this
    // command could produce, so it is impossible rather than merely discouraged.
    .min(1, { message: 'a contract must define at least one criterion' }),
});

export interface GenerateDraftInput {
  readonly epicSpec: EpicSpec;
  readonly provider: AgentProvider;
  readonly clock: Clock;
  /** The `ai.providers` key this role resolved to, for `meta.provenance`. */
  readonly providerName: string;
  /** Model as reported by the CLI, or `null` where it cannot report one. */
  readonly model: string | null;
  /** The AGENT CLI's version (`codex --version`), never SpecWitness's. */
  readonly providerCliVersion: string | null;
}

export interface GenerateDraftResult {
  readonly contract: Contract;
  /** Criteria whose statements name implementation, for the review pass. */
  readonly hints: readonly FlaggedCriterion[];
}

/**
 * Drafts a contract for one epic.
 *
 * Throws `ProviderError` (exit 3) when the gate's budget is exhausted — the
 * caller propagates it and writes nothing.
 */
export async function generateDraft(input: GenerateDraftInput): Promise<GenerateDraftResult> {
  const request: AgentRequest<z.infer<typeof DRAFT_RESPONSE_SCHEMA>> = {
    role: 'contract-author',
    prompt: buildContractPrompt(input.epicSpec),
    responseSchema: DRAFT_RESPONSE_SCHEMA,
    // `jsonSchema` is deliberately NOT set. The gate derives it from
    // `responseSchema` in exactly one place, so that two sites cannot disagree
    // about the shape the model is steered toward versus validated against.
  };

  const response = await invoke(request, { provider: input.provider, clock: input.clock });

  // Ids are minted HERE, sequentially in draft order, from the epic number.
  // Building each Criterion field by field is also what guarantees no extra key
  // the model volunteered can reach the contract.
  const criteria: Criterion[] = response.parsed.criteria.map((drafted, index) => ({
    id: buildCriterionId(input.epicSpec.epicNumber, index + 1),
    statement: drafted.statement,
    kind: drafted.kind,
    severity: drafted.severity,
    verifiability: drafted.verifiability,
  }));

  const now = input.clock.now().toISOString();

  const contract: Contract = {
    spec: {
      // Already canonical — story 2.1 normalises it through `domain/ids.ts`.
      // The raw argument the operator typed never reaches the file.
      epic: input.epicSpec.id,
      version: 1,
      criteria,
    },
    meta: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      frozen: false,
      fingerprint: null,
      createdAt: now,
      frozenAt: null,
      provenance: {
        provider: input.providerName,
        model: input.model,
        providerCliVersion: input.providerCliVersion,
        generatedAt: now,
      },
      history: [],
    },
  };

  return { contract, hints: flagCoupledCriteria(criteria) };
}
