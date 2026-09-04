/**
 * The mechanics-adaptation PORT (AD-1). Story 5.6.
 *
 * Split from `domain/adaptation.ts` for a structural reason rather than a stylistic one:
 * that module describes what a RUN SAYS about an adaptation and is therefore imported by
 * `domain/run-result.ts`, while this one describes HOW AN ADAPTATION IS OBTAINED and needs
 * `ProviderUsage` from that same module. Keeping both in one file made
 * `adaptation -> run-result -> adaptation` a cycle, which `no-circular` refuses. The split
 * is the fix the layer rules prescribe, and each half now has one job.
 *
 * AD-1: pure. Imports sibling domain modules only.
 */

import type { MechanicsPatch } from './adaptation-apply.js';
import type { ProviderUsage } from './run-result.js';

/**
 * One failing browser probe offered to the adapter, and EVERYTHING it is offered.
 *
 * ⚠️ **THIS SHAPE IS A SECURITY BOUNDARY, AND ITS NARROWNESS IS THE POINT.** Every string
 * here has ALREADY been redacted and bounded at its own capture point before it reaches
 * this object, and nothing in the adaptation flow re-reads a raw artifact to enrich it.
 *
 * WHAT IS DELIBERATELY ABSENT, AND WHY IT MATTERS MORE THAN WHAT IS PRESENT:
 *
 *   **THE PLAYWRIGHT TRACE.** `src/surfaces/browser.ts:285-323` states that traces and
 *   screenshots are NOT redacted, and that a trace is not merely pixels — it is a ZIP of
 *   DOM snapshots, network requests and responses, console output and every URL visited,
 *   which makes a secret inside it machine-readable and greppable. Codex raised it as a P1
 *   on 5.2 and the owner ruled merge-as-is; it is an open pending-owner item.
 *
 *   A trace is exactly what a locator proposal would most like to read, and feeding one
 *   into a prompt would send unredacted network payloads to a provider CLI. So there is NO
 *   FIELD HERE THAT CAN CARRY ONE, and the flow opens no evidence file. If a future story
 *   concludes a proposal genuinely needs page structure, the answer is a redaction pass
 *   over trace archives — an ADR — not a field added to this interface.
 */
export interface AdaptationCandidate {
  readonly criterionId: string;
  /** The contract's statement, from the verified contract. Never the plan's copy (AD-5). */
  readonly statement: string;
  readonly probeId: string;
  /** The compiled mechanics, so the adapter can propose a change relative to them. */
  readonly path: string;
  readonly scenario: string;
  /** The failing assertion, ALREADY redacted and bounded by `deriveCriterionResult`. */
  readonly expected?: string;
  readonly actual?: string;
}

/**
 * What the adapter decided.
 *
 * A REFUSAL IS A VALUE, NOT AN EXCEPTION. A hostile payload, an exhausted retry budget and
 * a provider that could not be reached all arrive here as `refused` with a reason — never
 * as a throw. That is what keeps AC2 true: a rejected or failed adaptation leaves the
 * criterion exactly as it was and **changes no exit code**. A `ProviderError` escaping this
 * seam would turn a product FAIL into an exit-3 infra error, which is precisely the
 * confusion the exit table exists to prevent.
 */
export type AdaptationDecision =
  | {
      readonly outcome: 'proposed';
      readonly patches: readonly MechanicsPatch[];
      readonly usage: ProviderUsage;
    }
  | {
      readonly outcome: 'refused';
      readonly reason: string;
      /**
       * ABSENT only when no provider was reached at all. A REFUSED payload still cost
       * quota, and FR-15/Q65 require every invocation to be recorded — a run that spent a
       * subscription's budget on a payload it then threw away is exactly the spend an
       * operator most wants to see, so it is reported rather than quietly dropped.
       */
      readonly usage?: ProviderUsage;
    };

/**
 * The port the probes stage is injected with (AD-1).
 *
 * `src/pipeline/**` may not import `src/authoring/**`, so the stage names this type and the
 * EDGE supplies an implementation — the same direction `dispatch` and `retries` already
 * travel, and the remedy `adapters-core-only` prescribes in its own words: *"if a story
 * needs an adapter-to-adapter call, that is a port in src/domain/, injected by the caller"*.
 *
 * Absent by default. A `verify` run without `--adapt` is handed nothing, so the adaptation
 * path is not merely skipped — there is no provider in scope for it to reach (FR-18, Q66).
 */
export type MechanicsAdapter = (
  candidates: readonly AdaptationCandidate[],
) => Promise<AdaptationDecision>;
