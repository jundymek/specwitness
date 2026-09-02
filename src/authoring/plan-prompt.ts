/**
 * The `plan-author` prompt (FR-16, Q37).
 *
 * This is the ONLY place a provider learns what to compile, which makes it the only place
 * AD-3's boundary and AC4's surface rule can be stated to the model in words. Four
 * properties matter and all four are tested:
 *
 *  1. **THE CRITERIA REACH THE MODEL VERBATIM.** Statements are copied exactly as the
 *     frozen contract holds them. Paraphrasing here would mean the plan was compiled from a
 *     summary of the expectation rather than the expectation. Note the asymmetry with the
 *     ARTIFACT: statements go INTO the prompt and never into the plan (AD-5) — the plan
 *     references criteria by id only, because a second copy of fingerprinted content can
 *     drift from its authority, while a prompt is transient and hashes nothing.
 *
 *  2. **ONLY REAL IDS.** The prompt lists the project's declared service and observation
 *     ids, so the provider references things that exist rather than inventing plausible
 *     ones. This is steering, not enforcement: `planDraftSchemaFor` rejects an undeclared
 *     id at the gate and the rejection is fed back into the next attempt (ADR-001 — a
 *     CLI-side constraint makes malformed output rarer, never impossible).
 *
 *  3. **THE LOWEST ADEQUATE SURFACE RULE IS STATED EXPLICITLY** (brief §32, AC4). An
 *     HTTP-checkable criterion yields an http probe, not a browser probe. There is NO
 *     classifier anywhere in this story and there must not be one: you cannot mechanically
 *     decide from a criterion's prose whether HTTP suffices, and that judgement is exactly
 *     what the plan-author role exists for (Q37). The prompt states the rule; a fixture
 *     spot-check proves the compiled output for an obviously-HTTP criterion is `http`.
 *
 *  4. **AN UNMAPPABLE CRITERION IS RECORDED, NEVER GUESSED AND NEVER DROPPED** (Q38). The
 *     prompt says so in as many words, because "omit what you cannot do" is the single most
 *     natural thing for a model to do and the resulting plan would silently verify less
 *     than the contract requires.
 *
 * Pure and deterministic: same contract and same declared ids, same prompt. AD-1 —
 * application layer, imports domain only.
 */

import type { Contract, Criterion } from '../domain/contract.js';
import type { DeclaredIds } from '../schemas/plan.js';

/**
 * Builds the compilation prompt for one frozen contract.
 *
 * Returns plain text. The response SHAPE is enforced by the schema the gate validates
 * against, not by asking the model nicely — this text explains the job;
 * `src/providers/invoke.ts` is what makes a malformed answer impossible to turn into state.
 */
export function buildPlanPrompt(contract: Contract, declared: DeclaredIds): string {
  const sections: string[] = [
    'You are compiling an executable verification plan from a FROZEN verification contract.',
    '',
    'The contract is the sole authority on WHAT must be true. Your job is HOW: for each',
    'criterion, the concrete probes and explicit assertions that will decide it',
    'mechanically. Once compiled, this plan is executed with no AI in the loop at all, so',
    'everything a run needs must be written down now.',
    '',
    'THE PROBE SURFACES — this list is closed. There are no others.',
    '',
    '- http        — a request to a DECLARED SERVICE at a service-relative path.',
    '- observation — a DECLARED OBSERVATION COMMAND that prints JSON to stdout; you assert',
    '                on values in that JSON, optionally comparing a before/after delta',
    '                around another probe in the same criterion.',
    '- shell       — a DECLARED COMMAND whose exit code and output you assert on.',
    '- browser     — a scripted browser interaction. Expensive and slow.',
    '',
    'CHOOSE THE LOWEST ADEQUATE SURFACE. If a criterion can be checked over HTTP, compile an',
    'http probe — NOT a browser probe. Use browser only when the criterion is genuinely',
    'about what a user sees or does in a page and nothing cheaper can decide it. A browser',
    'probe where an http probe would do is a wrong answer even when it passes.',
    '',
    'COMMANDS AND SERVICES ARE REFERENCED BY ID, NEVER BY COMMAND LINE.',
    '',
    'There is no field anywhere in the response schema that accepts a command string, a',
    'shell line, a host or a URL. A shell or observation probe names a declared command id;',
    'an http or browser probe names a declared service id and a path beginning with "/".',
    'Anything else is rejected. Do not attempt to work around this — a plan that could name',
    'an executable would be a plan that could run anything, which is the one thing this',
    'product does not permit.',
    '',
    'ASSERTIONS ARE DATA, AND EVERY PROBE MUST HAVE AT LEAST ONE.',
    '',
    'Each assertion carries a human-readable description, what to read, a comparison and an',
    'expected value. Expected values are strings, including for numbers ("200", "0", "3").',
    'A probe with no assertions observes nothing and decides nothing; it is rejected.',
    'Make each expectation as specific as the criterion allows: an assertion that would',
    'hold against a broken build is worse than no probe at all, because it reports green.',
    '',
    'EVERY CRITERION MUST APPEAR EXACTLY ONCE.',
    '',
    'For each criterion, choose one of:',
    '',
    '  - disposition "automated"    — one or more probes with explicit assertions.',
    '  - disposition "needs-human"  — with a reason and reviewer guidance:',
    '      * reason "human-verifiability"    for a criterion the contract marks',
    '        verifiability: human. These NEVER receive a probe. No machine may decide them.',
    '      * reason "not-safely-automatable" for a criterion the contract marks automated',
    '        that you cannot map to a probe you are confident in.',
    '',
    'DO NOT omit a criterion you find hard. An omitted criterion disappears from',
    'verification and nobody is told. Recording it as needs-human with reason',
    '"not-safely-automatable" is the correct, expected answer, and it is always better than',
    'a guessed probe.',
    '',
    'DETERMINISTIC TEST DATA.',
    '',
    'Scenario inputs are fixed now, at compile time, so that every run uses identical',
    'inputs. Declare them as data bindings:',
    '',
    '  - kind "fixed"    — a name and the exact value to use every run.',
    '  - kind "volatile" — a name and the reason it CANNOT be fixed (a value that must be',
    '                      unique per run, such as a signup email). Declare these',
    '                      explicitly; an undeclared varying input silently destroys',
    '                      reproducibility.',
    '',
    'Do not invent timestamps, random ids or "now"-dependent values as fixed data.',
    '',
    'WHAT NOT TO RETURN.',
    '',
    '- DO NOT return the epic id, the contract version, the contract fingerprint, a seed, a',
    '  schema version or any timestamp. SpecWitness records all of those.',
    '- DO NOT return criterion statements. Reference each criterion by its id only.',
    '',
  ];

  sections.push(...renderDeclared(declared), '', ...renderContract(contract));

  return `${sections.join('\n')}\n`;
}

/**
 * The project's declared ids.
 *
 * An empty category is stated as "none declared" rather than omitted. An omitted heading
 * reads as "this section did not apply", and a model that infers surfaces are available
 * when they are not will draft probes the gate then rejects, spending a retry to learn
 * something the prompt could simply have said.
 */
function renderDeclared(declared: DeclaredIds): string[] {
  const list = (ids: readonly string[]): string =>
    ids.length === 0 ? '  (none declared)' : ids.map((id) => `  - ${id}`).join('\n');

  return [
    'THIS PROJECT DECLARES THE FOLLOWING IDS. You may reference these and nothing else.',
    '',
    'Service ids (for http and browser probes):',
    list(declared.serviceIds),
    '',
    'Observation / command ids (for observation and shell probes):',
    list(declared.commandIds),
  ];
}

function renderContract(contract: Contract): string[] {
  const lines = [
    'THE FROZEN CONTRACT',
    '',
    `Epic: ${contract.spec.epic}`,
    `Contract version: ${contract.spec.version}`,
    '',
    `It has ${contract.spec.criteria.length} ${contract.spec.criteria.length === 1 ? 'criterion' : 'criteria'}. Plan every one of them.`,
  ];

  for (const criterion of contract.spec.criteria) {
    lines.push('', ...renderCriterion(criterion));
  }

  return lines;
}

function renderCriterion(criterion: Criterion): string[] {
  const lines = [
    `--- ${criterion.id} ---`,
    `kind: ${criterion.kind}`,
    `severity: ${criterion.severity}`,
    `verifiability: ${criterion.verifiability}`,
    '',
    'Statement, verbatim from the frozen contract:',
    criterion.statement,
  ];

  if (criterion.verifiability === 'human') {
    // Repeated per criterion rather than left to the general rules above: this is the one
    // instruction whose violation is not merely a bad plan but a machine answering the one
    // question its author wrote down that no machine may answer.
    lines.push(
      '',
      `${criterion.id} is verifiability: human. Carry it as needs-human with reason`,
      '"human-verifiability" and reviewer guidance. Do NOT give it a probe.',
    );
  }

  return lines;
}
