/**
 * The edge composition for `verify --explain` (story 5.5).
 *
 * `src/authoring/explain.ts` holds the flow — the prompt, the response schema, the one
 * gated invocation — and promises never to throw. This module is the other half of that
 * promise: the part that happens BEFORE `explainRun` can be called, where a `ProviderError`
 * is still reachable.
 *
 * There are three such places, and every one of them is a route AC2 names:
 *
 *  1. **No `explainer` role assigned.** `resolveRoleProvider` answers `undefined`, which
 *     `providerForRole` passes straight through — FR-11's "unassigned optional roles
 *     degrade gracefully", with the caller deciding what it means. Here it means a note.
 *  2. **The role names a provider this build cannot construct.** `createProvider` throws
 *     `ProviderError`. For `plan-author` that is fatal; here it is a note.
 *  3. **The provider binary is missing.** That surfaces later, from `generate`, and
 *     `attemptInvoke` classifies it as `provider-failed` rather than propagating it.
 *
 * WHY IT IS ITS OWN MODULE RATHER THAN TEN LINES IN `commands/verify.ts`. Because those ten
 * lines would be ten lines inside a 900-line command, wrapped in a `try` whose purpose a
 * later reader has to reconstruct — and the thing being guaranteed is a NEGATIVE ("this can
 * never fail the run"), which is exactly the kind of guarantee that erodes when it is
 * spread across a file that does many other things. `verify/probe-dispatch.ts`,
 * `verify/teardown.ts` and `verify/interrupt.ts` are the established precedent for lifting
 * one such concern out of the command.
 *
 * THE ASYMMETRY, restated because it is the one thing to get right here: an explainer
 * failure **never** changes an exit code, **never** turns a run into an infra error and
 * **never** fails the run. `explainVerifiedRun` has no error arm — it returns a
 * `RunResult` and a note, always.
 *
 * AD-1: this is the edge, so it resolves config and builds adapters. Nothing beneath the
 * CLI may import it.
 */

import { attachExplanations, explainRun, explainableCriteria } from '../../authoring/explain.js';
import { resolveRoleProvider, type SpecwitnessConfig } from '../../config/index.js';
import type { Clock } from '../../domain/ports.js';
import type { ProcessRunner } from '../../domain/process-runner.js';
import type { RunResult } from '../../domain/run-result.js';
import { createProcessRunner } from '../../infra/process-runner.js';
import { providerForRole } from '../../providers/index.js';
import { readProviderProvenance } from '../contract/provenance.js';

export interface ExplainVerifiedRunInput {
  /** The FINISHED run. Read, never mutated; a new value is returned. */
  readonly result: RunResult;
  readonly config: SpecwitnessConfig;
  readonly clock: Clock;
  /** Where a billing warning from an adapter goes (FR-15). */
  readonly warn: (message: string) => void;
  /**
   * How the adapter's `ProcessRunner` is built. Defaults to the real one.
   *
   * Injected for ONE reason, and it is worth stating because the seam otherwise looks
   * gratuitous. The `explainableCriteria(...) === 0` guard below is a cost optimisation
   * whose OUTPUT is identical to the guard `explainRun` already applies one layer down —
   * both answer "nothing to explain" and neither changes the run. Deleting it therefore
   * broke no assertion at all when it was planted, which made it an untested claim sitting
   * in a file whose entire subject is untested claims.
   *
   * What it actually buys is real but invisible from the outside with the `fake` adapter:
   * for `claude-code-cli` it avoids BUILDING an adapter and spawning `claude --version` for
   * a provenance record nobody is going to use. Injecting the runner is what lets a test
   * hand in `forbiddenProcessRunner()` and assert that a clean run reaches neither — which
   * turns the optimisation into a guarantee somebody can check.
   */
  readonly createRunner?: (clock: Clock) => ProcessRunner;
}

export interface ExplainVerifiedRunOutput {
  /**
   * The run to persist and render.
   *
   * On every failure route this is the INPUT OBJECT ITSELF, unchanged — not a copy, not a
   * reconstruction. Returning the same reference is the cheapest possible proof that the
   * failure paths altered nothing.
   */
  readonly result: RunResult;
  /** Present iff no hypothesis was produced. Printed as a `WARNING:`, never as an `ERROR:`. */
  readonly note?: string;
}

/**
 * Explain a finished run, or say why it could not be explained. **Never throws.**
 *
 * Called only when `--explain` was passed; a default invocation does not reach this module
 * at all, which is what keeps FR-18/Q66's zero-provider-call guarantee true.
 */
export async function explainVerifiedRun(
  input: ExplainVerifiedRunInput,
): Promise<ExplainVerifiedRunOutput> {
  const { result, config, clock } = input;

  // CHEAPEST REFUSAL FIRST. A run with nothing to explain must not build a provider, spawn
  // a capability probe or spend a token to discover that — and the answer comes from the
  // same function `explainRun` uses, so the two cannot disagree about what counts as a
  // failure worth explaining.
  if (explainableCriteria(result).length === 0) {
    return { result, note: 'no criterion failed, so there was nothing to explain' };
  }

  const resolved = resolveRoleProvider(config, 'explainer');
  if (resolved === undefined) {
    return {
      result,
      note:
        '--explain was requested but no provider is assigned to the "explainer" role, so ' +
        "no hypothesis was produced. Assign one under 'ai.roles.explainer' in " +
        '.specwitness/config.yaml. The verification results are unaffected',
    };
  }

  try {
    const runner = (input.createRunner ?? createProcessRunner)(clock);
    const provider = providerForRole(resolved, { processRunner: runner, clock, warn: input.warn });
    if (provider === undefined) {
      // Unreachable: `providerForRole` returns `undefined` only for an undefined
      // descriptor, which the branch above already answered. Handled anyway, because the
      // alternative to a note here is a crash on a path whose entire contract is that it
      // cannot crash.
      return {
        result,
        note: `the "explainer" role names provider "${resolved.name}", which could not be built; verification results are unaffected`,
      };
    }

    // The SAME runner the provider was built with, so the adapters' cached capability probe
    // is paid for once and read twice (story 3.8). It fails open by design: unknown
    // provenance is recorded as `null` rather than guessed.
    const provenance = await readProviderProvenance(resolved, runner);

    const outcome = await explainRun({
      result,
      provider,
      providerName: resolved.name,
      clock,
      model: provenance.model,
      providerCliVersion: provenance.providerCliVersion,
    });

    return {
      // `attachExplanations` records the provider usage even when no hypothesis came back
      // (Q65, FR-15: a failed attempt spent the same quota a successful one would have), so
      // the augmented result is returned on both arms.
      result: attachExplanations(result, outcome),
      ...(outcome.note === undefined ? {} : { note: outcome.note }),
    };
  } catch (error) {
    // `createProvider` throws `ProviderError` for an adapter this build cannot construct,
    // and `readProviderProvenance` is documented as failing open but is not this module's
    // code to trust blindly. Either way the run is returned UNTOUCHED — the same object
    // that came in — because a convenience that can break a verification is not a
    // convenience.
    return {
      result,
      note:
        `--explain could not be honoured: ${error instanceof Error ? error.message : String(error)}. ` +
        'The verification results are unaffected',
    };
  }
}
