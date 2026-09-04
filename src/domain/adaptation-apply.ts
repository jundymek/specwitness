/**
 * FR-18 / AC1 — applying a validated proposal to a plan COPY. Story 5.6.
 *
 * ============================================================================
 * THE FROZEN ARTIFACTS ARE NEVER TOUCHED, AND THAT IS WHAT THIS FILE IS FOR
 * ============================================================================
 *
 * A Verification Plan is persisted at `.specwitness/plans/<epic>.yaml`, committed to the
 * target project's git (Q11), and checked against the frozen contract's fingerprint at the
 * edge by `assertPlanMatchesContract`. **None of that is written on this path.**
 *
 * This function is PURE. It takes a `Plan`, returns a NEW `Plan`, and has no file system,
 * no clock and no I/O of any kind in scope — so "the project's plan file is never written"
 * is not a discipline anybody has to maintain, it is a property of a module that cannot
 * write a file. `src/domain/**` is dependency-free (AD-1), which is exactly why the applier
 * lives here and not beside the flow that calls it.
 *
 * TWO REASONS THE ORIGINAL MUST SURVIVE UNTOUCHED, both load-bearing:
 *
 *  1. **The contract-freeze invariant (AD-5).** Implementation must never silently change
 *     expected behaviour; amendments are explicit and audited. `specwitness contract amend`
 *     is that path. **An adaptation is never an amendment**, and a run that quietly rewrote
 *     the plan would have performed one without anybody approving it.
 *  2. **Provenance.** A plan silently written back would make the NEXT run's provenance a
 *     lie: the file would claim to have been compiled from the contract by the plan-author,
 *     when part of it was written by a different role, at execution time, in response to a
 *     failure. Every subsequent run would inherit that lie invisibly.
 *
 * If a user wants an adaptation persisted, that is an explicit follow-up flow with its own
 * acceptance criteria and its own audit trail. It is not this story, and it is not something
 * to add here "while we are in the file".
 *
 * ============================================================================
 * WHAT A PROPOSAL MAY REACH
 * ============================================================================
 *
 * Only `mechanics.path` and `mechanics.scenario`, and only on a `browser` probe. Everything
 * else about the plan is copied through by identity:
 *
 *  - **`assertions` is copied by REFERENCE** from the original probe. Not rebuilt, not
 *    mapped, not spread. The adapted probe's assertions are the SAME ARRAY OBJECT as the
 *    original's, so `adapted.assertions === original.assertions` is assertable — and any
 *    future edit that broke it would have to replace that line deliberately.
 *  - `id`, `surface` and the criterion's `criterionId` are copied unchanged. A proposal
 *    cannot rename anything; `probeId` selects a probe and nothing more.
 *  - `serviceId` is copied unchanged. The payload schema has no key for it (D2), so this
 *    is belt-and-braces rather than the mechanism.
 *
 * A `probeId` naming a probe the plan does not carry is REFUSED, not ignored. A provider may
 * not introduce a probe any more than it may rename one, and silently dropping an unknown id
 * would let a payload look accepted while doing nothing — the ambiguity that makes an audit
 * record worthless.
 *
 * AD-1: pure. Imports sibling domain modules only.
 */

import type { BrowserProbe, Plan, PlanCriterion, ProbeSpec } from './plan.js';

/** A validated, mechanics-only patch. Mirrors the payload schema's per-probe shape. */
export interface MechanicsPatch {
  readonly probeId: string;
  readonly path?: string;
  readonly scenario?: string;
}

/** One field that actually changed, with both sides, for the run's audit record. */
export interface PlannedMechanicsChange {
  readonly criterionId: string;
  readonly probeId: string;
  readonly field: 'path' | 'scenario';
  readonly from: string;
  readonly to: string;
}

export interface CriteriaAdaptation {
  /** NEW criteria. The input array and every object in it are unmutated. */
  readonly criteria: readonly PlanCriterion[];
  /** Exactly the fields whose value differs from the original. */
  readonly changes: readonly PlannedMechanicsChange[];
}

export interface AdaptationApplication {
  /** A NEW plan. The input is not mutated and is still safe to use. */
  readonly plan: Plan;
  /** Exactly the fields whose value differs from the original. */
  readonly changes: readonly PlannedMechanicsChange[];
}

/**
 * Why a proposal could not be applied. A refusal is a fact about the run, not an exception:
 * `deriveCriterionResult` is untouched and no exit code moves, so the caller records this
 * and carries on with the original failure standing.
 */
export class AdaptationRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'AdaptationRefused';
  }
}

function isBrowserProbe(probe: ProbeSpec): probe is BrowserProbe {
  return probe.surface === 'browser';
}

/**
 * Applies validated patches to a copy of `plan`.
 *
 * @throws {AdaptationRefused} when a patch names a probe the plan does not carry, or names
 * a probe that is not a browser probe. Both are wholesale refusals: nothing is applied.
 */
export function adaptCriteria(
  criteria: readonly PlanCriterion[],
  patches: readonly MechanicsPatch[],
): CriteriaAdaptation {
  // INDEXED FIRST, AND EVERY PATCH CHECKED, BEFORE ANYTHING IS BUILT. A patch that refuses
  // must refuse the WHOLE payload (AC2), so the validation pass completes before the
  // construction pass begins -- otherwise a later refusal would leave earlier patches
  // applied to a half-built plan, which is the partial application this story forbids.
  const located = new Map<string, string>();
  for (const criterion of criteria) {
    if (criterion.disposition !== 'automated') {
      continue;
    }
    for (const probe of criterion.probes) {
      // Probe ids are unique within a criterion, not across the plan (4.2's schema checks
      // exactly that). A patch naming an id that two criteria both use is therefore
      // ambiguous, and ambiguity in this flow is refused rather than resolved by order.
      if (located.has(probe.id)) {
        located.set(probe.id, '');
      } else {
        located.set(probe.id, criterion.criterionId);
      }
    }
  }

  for (const patch of patches) {
    const criterionId = located.get(patch.probeId);
    if (criterionId === undefined) {
      throw new AdaptationRefused(
        `proposal names probe '${patch.probeId}', which this plan does not carry`,
      );
    }
    if (criterionId === '') {
      throw new AdaptationRefused(
        `proposal names probe '${patch.probeId}', which more than one criterion declares — ` +
          'an adaptation must be unambiguous about what it changed',
      );
    }
  }

  const byProbeId = new Map(patches.map((patch) => [patch.probeId, patch]));
  const changes: PlannedMechanicsChange[] = [];

  const adaptProbe = (criterionId: string, probe: ProbeSpec): ProbeSpec => {
    const patch = byProbeId.get(probe.id);
    if (patch === undefined) {
      return probe;
    }
    if (!isBrowserProbe(probe)) {
      // The flow only ever offers browser probes as candidates, so this is a wiring guard
      // rather than a live case -- but it is a REFUSAL rather than a silent skip, because
      // the alternative is a payload that looks accepted and changed nothing.
      throw new AdaptationRefused(
        `proposal names probe '${probe.id}', which is a ${probe.surface} probe — ` +
          'mechanics adaptation applies to browser probes only',
      );
    }

    const path = patch.path ?? probe.mechanics.path;
    const scenario = patch.scenario ?? probe.mechanics.scenario;

    if (path !== probe.mechanics.path) {
      changes.push({ criterionId, probeId: probe.id, field: 'path', from: probe.mechanics.path, to: path });
    }
    if (scenario !== probe.mechanics.scenario) {
      changes.push({
        criterionId,
        probeId: probe.id,
        field: 'scenario',
        from: probe.mechanics.scenario,
        to: scenario,
      });
    }

    return {
      id: probe.id,
      surface: 'browser',
      mechanics: {
        // Copied unchanged: the payload has no key for it, and this states that the
        // origin binding survives an adaptation (D2).
        serviceId: probe.mechanics.serviceId,
        path,
        scenario,
      },
      // ⚠️ BY REFERENCE, DELIBERATELY. `adapted.assertions === original.assertions` is the
      // strongest statement this file can make that WHAT MUST BE TRUE did not move, and it
      // is asserted by test. Do not "tidy" this into a spread.
      assertions: probe.assertions,
    };
  };

  const adaptCriterion = (criterion: PlanCriterion): PlanCriterion => {
    if (criterion.disposition !== 'automated') {
      return criterion;
    }
    const probes = criterion.probes.map((probe) => adaptProbe(criterion.criterionId, probe));
    return { ...criterion, probes };
  };

  const adapted = criteria.map(adaptCriterion);

  if (changes.length === 0) {
    throw new AdaptationRefused(
      'the proposal changed nothing — every proposed value already matches the compiled plan',
    );
  }

  return { criteria: adapted, changes };
}

/**
 * The same application, expressed over a whole `Plan`.
 *
 * A THIN WRAPPER, deliberately: the probes stage holds `PlanCriterion[]` and not a `Plan`,
 * so the core above works at that level and this delegates. Two independent implementations
 * of "apply a patch" would be two places for the assertion-immutability property to be true,
 * and the day they disagreed only one of them would be tested.
 *
 * This is the entry point whose byte-identity is asserted against `serializePlan`.
 */
export function applyAdaptation(
  plan: Plan,
  patches: readonly MechanicsPatch[],
): AdaptationApplication {
  const { criteria, changes } = adaptCriteria(plan.plan.criteria, patches);
  return { plan: { ...plan, plan: { ...plan.plan, criteria } }, changes };
}
