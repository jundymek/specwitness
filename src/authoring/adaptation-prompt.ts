/**
 * The `mechanics-adapter` prompt (FR-18, Q53-Q55). Story 5.6.
 *
 * The only place a provider learns what it may propose — which makes it the only place the
 * boundary can be stated in words. Four properties matter, and the FOURTH is the one that
 * distinguishes this prompt from every other prompt in the product:
 *
 *  1. **THE CRITERION'S STATEMENT REACHES THE MODEL VERBATIM**, from the verified contract,
 *     never from the plan's copy (AD-5). Adapting a locator without knowing what the
 *     criterion is trying to establish is how a proposal ends up making the probe look at
 *     something else that happens to be present.
 *
 *  2. **ONLY WHAT THE PROBE ACTUALLY SAW.** The failing assertion's `expected` and `actual`,
 *     already redacted and bounded by `deriveCriterionResult` (AD-10). Nothing here reads an
 *     evidence file, and the Playwright trace — which is stored UNREDACTED and is a ZIP of
 *     DOM snapshots, network payloads and console output — is never opened. See
 *     `authoring/adaptation.ts` and `domain/adaptation.ts` for why that absence is a
 *     security property rather than a limitation to work around.
 *
 *  3. **THE SCENARIO GRAMMAR IS STATED**, because 5.2's executor refuses an unparseable
 *     directive with an `InfraError` before any I/O. A provider that writes "log in as
 *     alice, then click Submit" produces a proposal that cannot be executed, which costs a
 *     retry for nothing. Stating the four verbs is steering — the executor's refusal is the
 *     enforcement.
 *
 *  4. ⚠️ **THE PROHIBITION IS STATED, AND IT IS NOT THE MECHANISM.** The prompt tells the
 *     provider it may not touch assertions, expected values, identities, origins or
 *     commands. That text improves the success rate and NOTHING MORE. The enforcement is
 *     that `MechanicsAdaptationSchema` HAS NOWHERE TO PUT ANY OF THEM — a `z.strictObject`
 *     carrying two keys, so an attempt is an unknown-key rejection at the gate.
 *
 *     This distinction is the whole story. AC1 says *schema-enforced*, and a prompt is the
 *     weakest possible form of enforcement: it is advice to a system that is under no
 *     obligation to take it, and a provider that ignores it entirely still cannot cross the
 *     boundary. **Never treat this file as a control.** If the sentence below were deleted
 *     the boundary would hold and the success rate would drop; if the schema were widened
 *     the sentence would hold and the product would be broken.
 *
 * Pure and deterministic: same candidates, same prompt. No clock, no I/O, no randomness.
 * AD-1 — application layer, imports domain only.
 */

import type { AdaptationCandidate } from '../domain/adaptation-port.js';

/**
 * The most candidates one prompt will describe.
 *
 * Matches the stage's `MAX_ADAPTED_PROBES` and 5.5's `MAX_EXPLAINED_CRITERIA`, so both
 * provider paths on the verify edge cost the same order of magnitude.
 */
export const MAX_PROMPTED_CANDIDATES = 20;

/** One candidate, rendered. Values are already redacted and bounded by the caller. */
function candidateBlock(candidate: AdaptationCandidate, index: number): string {
  const lines = [
    `${index + 1}. probeId: ${candidate.probeId}`,
    `   criterion ${candidate.criterionId}: ${candidate.statement}`,
    `   current path: ${candidate.path}`,
    '   current scenario:',
    ...candidate.scenario.split('\n').map((line) => `     ${line}`),
  ];

  if (candidate.expected !== undefined) {
    lines.push(`   the assertion expected: ${candidate.expected}`);
  }
  if (candidate.actual !== undefined) {
    lines.push(`   the page actually gave: ${candidate.actual}`);
  }

  return lines.join('\n');
}

/**
 * Builds the one prompt for the one invocation of a run.
 *
 * Every candidate is offered together, so the provider answers once for the whole run — see
 * `schemas/adaptation.ts` for why the payload is shaped that way and what the alternative
 * would cost in quota.
 */
export function buildAdaptationPrompt(candidates: readonly AdaptationCandidate[]): string {
  // The caller already caps the candidate set (`MAX_ADAPTED_PROBES`); this is the same bound
  // asserted here so the function is safe for any caller, present or future. A prompt whose
  // size depends on how many criteria a plan happens to have is a context-limit failure and
  // a quota bill waiting to happen. Raised as a P2 by the codex review.

  return [
    'You are adapting the MECHANICS of browser probes in a verification plan.',
    '',
    'Each probe below failed because an element it looked for was not found. The usual',
    'cause is cosmetic drift: a control was relabelled or moved, while the behaviour the',
    'criterion describes did not change. Your job is to propose a new way to LOOK for the',
    'same thing.',
    '',
    '=== WHAT YOU MAY CHANGE ===',
    '',
    'ONLY these two fields, per probe:',
    '',
    '  path      - the service-relative starting path. Must begin with a single "/".',
    '  scenario  - the interaction script (the grammar is below).',
    '',
    'At least one of them must be present in each proposal.',
    '',
    '=== WHAT YOU MAY NOT CHANGE, AND CANNOT ===',
    '',
    'You may NOT change what must be TRUE. Assertions, expected values, comparisons and',
    'assertion targets are not yours to touch. Neither is a probe id, a surface, a',
    'criterion id, or the service the probe points at.',
    '',
    'You also may not introduce a URL, a host, an origin, a shell command or any argument',
    'to one. A probe names a declared service and a relative path; it never names a host.',
    '',
    'This is not a request. The response schema has no field for any of them, so a response',
    'containing one is rejected in full and NOTHING you proposed is applied - including the',
    'parts that were legitimate. If you believe a criterion can only pass by changing what',
    'is asserted, propose nothing for that probe: a human amends the contract, and doing',
    'that is an explicit, audited step that is not available to you.',
    '',
    '=== THE SCENARIO GRAMMAR ===',
    '',
    'One directive per line, arguments double-quoted. A line that is not one of these four',
    'verbs is refused before the browser starts, so do not write prose:',
    '',
    '  goto     "/orders"',
    '  click    "#submit"',
    '  fill     "#email" "alice@example.com"',
    '  waitFor  "#confirmation"',
    '',
    'Prefer a stable selector over a brittle one: an id or a data attribute beats a text',
    'match, and a text match beats a positional or generated class name.',
    '',
    '=== THE FAILING PROBES ===',
    '',
    candidates.slice(0, MAX_PROMPTED_CANDIDATES).map(candidateBlock).join('\n\n'),
    '',
    '=== YOUR RESPONSE ===',
    '',
    'Respond with ONLY a JSON document of this shape, with no prose and no markdown fence:',
    '',
    '  {"proposals": [{"probeId": "...", "mechanics": {"scenario": "..."}}]}',
    '',
    'Include a probe only if you have a concrete reason to believe your proposal fixes it.',
    'Omitting a probe you cannot help is correct and costs nothing; guessing is not.',
  ].join('\n');
}
