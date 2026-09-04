/**
 * FR-18 / AD-2 — the mechanics-adaptation payload. Story 5.6.
 *
 * ============================================================================
 * THIS FILE IS THE STORY. EVERYTHING ELSE IN 5.6 IS SUPPORTING.
 * ============================================================================
 *
 * SpecWitness is a product whose whole value is that a verification cannot be
 * talked into passing. Every other artifact a provider authors is a DRAFT a
 * human freezes (`contract`, `plan`) or a SENTENCE a human reads (5.5's
 * explanation). This is the one and only place where provider output changes
 * **what gets executed on the next attempt** — so this is the one and only place
 * where a hostile provider could make a failing verification pass.
 *
 * It cannot, and the reason is structural rather than careful:
 *
 *   **THE PAYLOAD HAS NOWHERE TO PUT AN ASSERTION OR AN EXPECTED VALUE.**
 *
 * Not "a validator rejects one". Not "the prompt says not to". There is no key.
 * Every schema below is a `z.strictObject`, so `assertions`, `expected`, `id`,
 * `surface`, `criterionId`, `url`, `host`, `command`, `commandId`, `method`,
 * `headers` and `body` are all UNKNOWN KEYS — and an unknown key fails
 * validation, which sends the whole payload back through the gate and, on
 * exhaustion, applies nothing at all.
 *
 * That technique is not invented here. `src/schemas/plan.ts:458-462` already
 * uses it and states why: a `needs-human` arm is a strict object with no
 * `probes` key, so attaching a probe to a human criterion *"fails as an unknown
 * key rather than as a rule somebody remembered to write"*. **This file follows
 * that precedent exactly.** A rule somebody remembered to write is a rule
 * somebody can later forget; an absent key survives every refactor, because the
 * refactor would have to ADD something to break it.
 *
 * The split this file depends on was built for it, and both halves say so in
 * merged code:
 *
 *   - `src/domain/plan.ts:46-52` — *"a mechanics adaptation may alter mechanics
 *     fields only; assertion and expected-value fields are structurally
 *     read-only in that flow. AI may adapt HOW, never WHAT."*
 *   - `src/schemas/plan.ts:331-338` — the same rule stated at the schema,
 *     *"load-bearing for Epic 5"*.
 *   - **AD-2**, as a spine invariant.
 *
 * ============================================================================
 * WHAT THE PAYLOAD CAN CARRY, AND THE ONE FIELD IT DELIBERATELY CANNOT
 * ============================================================================
 *
 * `BrowserProbeMechanics` has THREE fields (`src/domain/plan.ts:250-266`):
 * `serviceId`, `path`, `scenario`. This payload accepts **two of them**.
 *
 * `serviceId` IS REFUSED, and it is refused on purpose rather than forgotten.
 * FR-18 and AD-2 both gloss the permitted surface as **"(locators,
 * navigation)"**. `path` is navigation; `scenario` is locators and interaction.
 * `serviceId` is neither — it is the ORIGIN BINDING, the field the caller
 * resolves into a base URL through 4.1's `resolveServiceBaseUrl`, and therefore
 * the field that decides which declared service the probe points at.
 *
 * Letting a provider repoint a probe at a different service is not adaptation to
 * cosmetic drift; it changes WHAT IS BEING VERIFIED, which is the exact class of
 * edit this file exists to make impossible. It would stay inside AD-3's boundary
 * either way — every service is config-declared, so no undeclared origin is
 * reachable through it — so this is a narrowing, not a hole being closed. The
 * narrow choice is the right one for a security boundary and it costs nothing: a
 * relabelled button never needs a different service.
 *
 * `probeId` is a **SELECTOR, NOT A RENAME**. It says which probe a proposal is
 * about; there is no field anywhere below that can change a probe's identity,
 * and `applyAdaptation` refuses a `probeId` the plan does not carry. The
 * distinction matters because AC1 asks for a payload "keyed by probe id" in the
 * same breath as one with nowhere to put a probe `id` — those are the same
 * requirement seen from two ends, and this is the shape that satisfies both.
 *
 * ============================================================================
 * THE PRIMITIVES ARE IMPORTED, NEVER RE-DECLARED
 * ============================================================================
 *
 * `RelativePath`, `Identifier` and `Prose` come from `src/schemas/plan.ts`. That
 * import is load-bearing, not tidiness. `RelativePath`'s regex carries AD-3's
 * "no production URL defaults" and its comment records that a BACKSLASH nearly
 * defeated the whole property — `new URL('/\evil.example/x', base)` resolves to
 * `https://evil.example/x` under WHATWG parsing, and every earlier version of
 * the rule passed it. A second copy of that regex in this file would be a second
 * thing to keep in step with an attack somebody already found once. There is one
 * definition of "a service-relative path" in this product, and an adapted path is
 * held to exactly it.
 *
 * DEFENCE IN DEPTH, and it is named as such rather than as the mechanism: after
 * a proposal is applied, `src/authoring/adaptation.ts` re-parses the adapted plan
 * through the merged `parsePlan`. So an adapted plan must satisfy the FULL plan
 * schema, not merely this one. If those two ever disagree, the merged one wins
 * and nothing is applied. **The mechanism is the absent key; that round trip is a
 * second lock on the same door.**
 *
 * AD-1: `src/schemas/**` — imports zod and sibling schemas, nothing else.
 */

import { z } from 'zod';

import { Identifier, Prose, RelativePath } from './plan.js';
import { schemaVersionFor } from './versions.js';

/** The registered version of this payload (`schemas/versions.ts`). */
export const ADAPTATION_SCHEMA_VERSION = schemaVersionFor('adaptation');

/**
 * The AI role that authors an adaptation.
 *
 * SEPARATE FROM `explainer` BY REQUIREMENT, not by preference. An explainer
 * produces text a human reads and which changes nothing; this role produces a
 * change to an executable artifact. Sharing one role would mean a project that
 * wanted a failure explainer silently also granted permission to rewrite its
 * probes, which is not a choice anybody should make by accident.
 */
export const ADAPTATION_ROLE = 'mechanics-adapter' as const;

/**
 * Upper bound on proposals in one payload.
 *
 * The gate hands this schema whatever the provider said, and a provider that
 * returns a hundred thousand proposals should be refused by the schema rather
 * than by whatever runs out of memory first. Sixty-four is far above any real
 * plan's browser-probe count and far below anything that costs a run.
 */
const MAX_PROPOSALS = 64;

/**
 * The mutable surface of a browser probe. **This object is the boundary.**
 *
 * Both fields are optional and at least one must be present: the common case is
 * a relabelled control, where the scenario changes and the path does not, and
 * forcing a provider to restate an unchanged path is an invitation to restate it
 * wrongly. What is NOT optional is the shape — `strictObject` means anything
 * that is not one of these two names is a validation failure.
 *
 * Read the list of what that excludes once, because it is the acceptance
 * criterion: `assertions`, `expected`, `comparison`, `target`, `id`, `surface`,
 * `criterionId`, `serviceId`, `url`, `host`, `origin`, `command`, `commandId`,
 * `args`, `method`, `headers`, `body`, `around`. None of them has a key here,
 * and none may ever be given one.
 */
const BrowserMechanicsPatchSchema = z
  .strictObject({
    /**
     * Navigation. Held to the SAME rule a compiled plan is held to, imported
     * rather than restated — see the module header.
     */
    path: RelativePath.optional(),
    /**
     * Locators and interaction. Untrusted provider prose, exactly as the
     * original `scenario` is: 5.2's executor compiles it to a closed union of
     * structured steps and its own header states that the scenario is *"DATA the
     * generated spec READS, never CODE the generated spec BECOMES"*.
     *
     * An adapted scenario is handed to that same executor through the same
     * dispatcher, so it travels 5.2's validation path with no shortcut. This
     * file adds no parsing of its own and must not: a second scenario parser
     * would be a second set of guarantees to argue about.
     */
    scenario: Prose.optional(),
  })
  .refine((patch) => patch.path !== undefined || patch.scenario !== undefined, {
    message:
      'a proposal must change at least one mechanics field (path or scenario) — an empty proposal adapts nothing',
  });

/** One probe's proposed mechanics. `probeId` selects; it never renames. */
const MechanicsProposalSchema = z.strictObject({
  /**
   * Which probe this proposal is about.
   *
   * `Identifier`, so it cannot be a command line or a path. Checked against the
   * plan by `applyAdaptation`, which refuses an id the plan does not carry —
   * a provider may not introduce a probe any more than it may rename one.
   */
  probeId: Identifier,
  mechanics: BrowserMechanicsPatchSchema,
});

/**
 * The whole payload: one invocation per run, several probes per payload.
 *
 * ONE INVOCATION PER RUN is a quota decision and is stated here because the
 * shape encodes it. The alternative — one call per failing criterion — makes
 * spend scale with the number of failures, multiplied by the gate's retry budget
 * (default 2, so at most 3 attempts). A run with twenty failing browser criteria
 * would cost sixty provider calls. This costs at most three, matches what
 * `compilePlan` already does for an entire plan, and is why AC1 asks for a
 * payload "per probe, keyed by probe id" rather than a payload for one probe.
 */
export const MechanicsAdaptationSchema = z.strictObject({
  proposals: z
    .array(MechanicsProposalSchema)
    .min(1, {
      message:
        'return at least one proposal — an empty payload is not an adaptation, and a provider with nothing to propose should say so by failing rather than by returning nothing',
    })
    .max(MAX_PROPOSALS, {
      message: `at most ${MAX_PROPOSALS} proposals in one payload`,
    })
    .superRefine((proposals, ctx) => {
      // Two proposals for one probe would make "what was applied" ambiguous, and
      // an ambiguous audit record is the failure mode this story exists to
      // prevent. Refused rather than last-wins.
      const seen = new Map<string, number>();
      proposals.forEach((proposal, index) => {
        const first = seen.get(proposal.probeId);
        if (first !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'probeId'],
            message: `duplicate proposal for probe '${proposal.probeId}' (already proposed at proposals[${first}])`,
          });
        } else {
          seen.set(proposal.probeId, index);
        }
      });
    }),
});

export type BrowserMechanicsPatch = z.infer<typeof BrowserMechanicsPatchSchema>;
export type MechanicsProposal = z.infer<typeof MechanicsProposalSchema>;
export type MechanicsAdaptation = z.infer<typeof MechanicsAdaptationSchema>;
