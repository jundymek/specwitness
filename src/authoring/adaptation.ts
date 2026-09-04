/**
 * FR-18 / AD-2 — the mechanics adaptation flow. Story 5.6.
 *
 * Prompt assembly, ONE invocation through the ONE merged gate, and the translation of
 * whatever came back into a decision the probes stage can act on. It invents no schema, no
 * validator, no retry loop and no parser: if this file ever grows one, it has taken over
 * another module's job. It mirrors `authoring/plan.ts` deliberately, because plan
 * compilation already does this exact dance.
 *
 * ============================================================================
 * WHY THIS LIVES IN `src/authoring/` — a layer decision, not a preference
 * ============================================================================
 *
 *  - `src/domain/**` is pure and dependency-free; it cannot invoke a provider.
 *  - `src/providers/**` is an adapter and may not import `src/config/**` or an application
 *    layer.
 *  - `src/pipeline/**` may not import `src/authoring/**`, which is exactly why
 *    `src/cli/verify/probe-dispatch.ts` exists as a composition root — read its header, it
 *    states the constraint precisely.
 *  - `src/authoring/**` is the application layer that ALREADY composes providers through
 *    the merged gate for contract and plan authoring (`plan.ts`, `plan-prompt.ts`,
 *    `amend.ts`), which makes it the only legal home for a provider-mediated change to a
 *    plan.
 *
 * ⚠️ **DEPCRUISE DOES NOT VALIDATE THIS PLACEMENT, AND SAYING SO WOULD BE A VACUOUS
 * GUARD.** `.dependency-cruiser.cjs` has rules whose `from` matches `^src/domain/`,
 * `^src/schemas/`, `^src/ingest/`, `^src/pipeline/`, `^src/report/` and the adapters — and
 * **none matching `^src/authoring/`**. Planting `authoring -> infra` here cruises clean.
 * Verified directly rather than assumed, after the epic-5 supervisor raised it.
 *
 * What actually holds the placement is the argument itself, which stands without a rule:
 * `src/domain/**` is pure and cannot invoke a provider; `src/pipeline/**` may not import
 * `src/authoring/**` (that half IS enforced, by `pipeline-layer`); and `authoring` is where
 * `plan.ts` and `amend.ts` already compose providers through the one merged gate. The one
 * plant that DOES fire from here is `authoring -> cli`, caught by `nothing-imports-cli`,
 * which is a real guard about a different question.
 *
 * The missing layer rule is NOT authored here: writing one late in a closing wave is how a
 * boundary gets drawn wrong, and it is out of this story's scope. It is carried to the epic
 * retrospective as an owner item, with this module and 5.5's as the evidence that the layer
 * now has several modules and no rule.
 *
 * ============================================================================
 * A REFUSAL IS A VALUE. NOTHING HERE THROWS INTO THE PIPELINE.
 * ============================================================================
 *
 * `attemptInvoke` is used rather than `invoke`, and the difference is load-bearing rather
 * than stylistic. `invoke` raises `ProviderError` when the retry budget is exhausted, and
 * `ProviderError` is AD-7's exit-3 class — so a hostile or merely unhelpful provider would
 * turn a product FAIL into an infrastructure error and MOVE THE EXIT CODE. AC2 forbids that
 * in terms: *a rejected or failed adaptation leaves the criterion exactly as it was*, and
 * must not change the exit code.
 *
 * `attemptInvoke` returns the `ok: false` arm carrying every attempt, so an exhausted budget
 * is recorded and then declined. `parsed` is unreachable on that arm by construction (AD-2),
 * so there is no way to salvage a partial payload even by accident — FR-14's "never a
 * partial artifact" is a type property here, not a rule anyone has to follow.
 *
 * A provider that throws outright — a missing binary, a timeout, a revoked login — is
 * classified by the gate as `provider-failed` and arrives on the same arm. Every route
 * therefore ends in `refused`, and the run carries on with the original failure standing.
 *
 * ============================================================================
 * WHAT IS SENT, AND THE THING THAT IS DELIBERATELY NOT
 * ============================================================================
 *
 * ⚠️ **THE PRECISE CLAIM, because a loose version of it was wrong once already.** An earlier
 * header said "everything sent to the provider is already redacted and bounded" while the
 * compiled mechanics were being copied out of the plan RAW — a scenario can carry a literal
 * a `fill` step types into a form, so a project with a credential in its plan disclosed it.
 * Found by review. So the claim is now stated field by field rather than as a slogan:
 *
 *  - the failing probe's `expected` / `actual` — **redacted at derivation**
 *    (`deriveCriterionResult`, AD-10);
 *  - the compiled `path` and `scenario` — **redacted and bounded by the caller** before the
 *    candidate is built, though they come from the project's own plan;
 *  - the criterion id and the contract's **statement** — sent AS-IS, and that is a decision
 *    rather than an oversight. They are committed SPECIFICATION content: a sentence about
 *    required behaviour, not a value typed into a form. `DerivedCriterionResult.statement`
 *    carries it unredacted for every renderer already, and 5.5's explainer sends it to a
 *    provider on the same footing — redacting it here alone would diverge from both while
 *    protecting a class of content that does not carry secrets by construction.
 *
 * ⚠️ **THE PLAYWRIGHT TRACE IS NEVER READ, AND THAT IS THE MOST IMPORTANT LINE IN THIS
 * FILE.** `src/surfaces/browser.ts:285-323` records that traces are stored UNREDACTED, and
 * that a trace is not merely pixels but a ZIP of DOM snapshots, network requests and
 * responses, console output and every URL visited — machine-readable and greppable. It is
 * simultaneously the artifact a locator proposal would most like to read and the artifact
 * that would leak the most by being read. This module opens no evidence file of any kind,
 * and `AdaptationCandidate` has no field that could carry one.
 *
 * NOTHING HERE MINTS A `DeclaredCommand`, nothing reaches a shell, and no credential store
 * is touched (NFR-1, AD-4, Q59). The adapters withhold billing-risk variables from child
 * environments; this file constructs no child at all.
 *
 * AD-1: application layer. Imports `domain/`, `schemas/` and `providers/`; never `cli/`.
 * AD-9: the `Clock` is injected — no `new Date()` on this path.
 */

import type {
  AdaptationCandidate,
  AdaptationDecision,
  MechanicsAdapter,
} from '../domain/adaptation-port.js';
import type { MechanicsPatch } from '../domain/adaptation-apply.js';
import type { AgentProvider, AgentRequest } from '../domain/agent-provider.js';
import type { Clock } from '../domain/ports.js';
import type { ProviderUsage } from '../domain/run-result.js';
import { attemptInvoke, type InvokeOptions } from '../providers/invoke.js';
import {
  ADAPTATION_ROLE,
  MechanicsAdaptationSchema,
  type MechanicsAdaptation,
} from '../schemas/adaptation.js';

import { buildAdaptationPrompt } from './adaptation-prompt.js';

export interface AdaptationDeps {
  readonly provider: AgentProvider;
  readonly clock: Clock;
  /**
   * Passed straight through to the merged gate. NOT raised here and NOT nested: the budget
   * is the gate's (default 2, so at most 3 attempts, clamped to [0, 5]) and every retry is
   * a fresh session billed against a real subscription.
   */
  readonly options?: InvokeOptions;
}

/** The gate's own accounting, translated into the run's audit shape (FR-15, Q65). */
function usageOf(
  provider: AgentProvider,
  attempts: number,
  durationMs: number,
): ProviderUsage {
  return {
    role: ADAPTATION_ROLE,
    provider: provider.id,
    durationMs,
    attempts,
    // `null` on every path, honestly: `AgentProvider.generate` returns raw text and the
    // AD-2 envelope has no metadata slot. A guessed model string in an audit field is
    // worse than an honest null — the same call `ProviderUsage` documents for itself.
    model: null,
    providerCliVersion: null,
  };
}

/**
 * Turns a validated payload into the patches the applier takes.
 *
 * A PURE RESHAPE. It adds nothing, defaults nothing and drops nothing: the payload already
 * satisfies `MechanicsAdaptationSchema`, so every field present here is a field the schema
 * permitted, and every field the schema forbids is a field that never reached this
 * function. That is why there is no validation in this file — a second gate would be a
 * second opinion, and AD-2 says there is exactly one.
 */
function toPatches(payload: MechanicsAdaptation): MechanicsPatch[] {
  return payload.proposals.map((proposal) => ({
    probeId: proposal.probeId,
    ...(proposal.mechanics.path === undefined ? {} : { path: proposal.mechanics.path }),
    ...(proposal.mechanics.scenario === undefined ? {} : { scenario: proposal.mechanics.scenario }),
  }));
}

/**
 * Builds the adapter the probes stage is injected with.
 *
 * ONE INVOCATION PER RUN, covering every adaptable probe at once. See
 * `schemas/adaptation.ts` for why the payload is shaped to allow it: one call per failing
 * criterion would make spend scale with the number of failures, multiplied by the retry
 * budget.
 */
export function createMechanicsAdapter(deps: AdaptationDeps): MechanicsAdapter {
  return async (candidates: readonly AdaptationCandidate[]): Promise<AdaptationDecision> => {
    const request: AgentRequest<MechanicsAdaptation> = {
      role: ADAPTATION_ROLE,
      prompt: buildAdaptationPrompt(candidates),
      responseSchema: MechanicsAdaptationSchema,
      // `jsonSchema` is deliberately NOT set. The gate derives it from `responseSchema` in
      // one place, so two callers cannot disagree about what a CLI is steered towards —
      // and steering is an optimisation, never a substitute for the gate.
    };

    const response = await attemptInvoke(request, {
      provider: deps.provider,
      clock: deps.clock,
      ...(deps.options === undefined ? {} : { options: deps.options }),
    });

    const usage = usageOf(deps.provider, response.attempts.length, response.durationMs);

    if (!response.ok) {
      // Every failure route lands here: not JSON, JSON of the wrong shape, an assertion or
      // expected value the payload had nowhere to put, a provider that threw, a budget that
      // ran out. The reason names the LAST attempt's first error, which is the one a human
      // can act on; the full attempt list is the gate's to keep and is not re-persisted
      // here, because `AgentAttempt.raw` is diagnostic text a reader must never mistake for
      // content.
      const last = response.attempts.at(-1);
      const detail = last?.errors[0] ?? 'no detail';
      return {
        outcome: 'refused',
        reason:
          `the mechanics adaptation was refused after ${response.attempts.length} ` +
          `${response.attempts.length === 1 ? 'attempt' : 'attempts'} (${last?.outcome ?? 'unknown'}): ${detail}`,
        usage,
      };
    }

    return { outcome: 'proposed', patches: toPatches(response.parsed), usage };
  };
}
