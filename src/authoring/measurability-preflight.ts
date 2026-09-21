/**
 * "What will measure this?" — asked of every criterion BEFORE the freeze.
 *
 * WHY THIS EXISTS, and it is the third instance of one asymmetry.
 *
 * A contract is read by a human and frozen; after that, ADR-005 makes the only
 * change an audited amendment. A plan is compiled afterwards, from that frozen
 * contract, and it is the plan that discovers whether a criterion can be
 * measured at all: `plan-author` maps each criterion onto the project's
 * declared observations, and records `needs-human` with reason
 * `not-safely-automatable` for every one it cannot.
 *
 * **So the tool already knows which criteria are unmeasurable — it just learns
 * it one step too late to be useful.** On tenstandard's epic 6 that cost 34 of
 * 91 criteria: they state true, important things, and no declared observation
 * reports the facts they need. The operator saw it only after the fingerprint
 * existed, when the cheap fix — rewording, or declaring another observation —
 * was no longer available without an amendment.
 *
 * This module moves that question to freeze time. It asks the SAME provider
 * that compiles plans, with the SAME declared ids, in a cheaper form: not "emit
 * probes and assertions for all of them" but "for each criterion, name the
 * observation that would report the facts it needs, or say none does".
 *
 * WHY NOT REUSE `compilePlan` DIRECTLY. A plan is the expensive artifact — one
 * response carrying probes, assertions and reviewer guidance for every
 * criterion, and on a 91-criterion contract that is a ~20-minute call that has
 * failed outright before now. A freeze must not depend on it. This asks for one
 * line per criterion, which is small enough to be affordable at freeze time and
 * small enough that the answer arrives.
 *
 * WHAT IT IS NOT. It does not decide whether a criterion is CORRECT, whether it
 * is worth having, or whether the product satisfies it. It answers exactly one
 * question — is there an instrument in this project that can see this? — and
 * hands the answer to the operator, who decides.
 *
 * AND IT NEVER BLOCKS ON ITS OWN JUDGEMENT. The provider is a model; a model
 * that says "nothing measures this" may be wrong, and a freeze refused by a
 * wrong model is worse than a contract with a `needs-human` criterion in it.
 * So the CLI reports and asks; only the operator refuses. That is the same
 * split `coupling.ts` makes and for the same reason: the tool notices, the
 * human decides.
 */

import type { AgentPrompt, AgentProvider, ResponseValidator } from '../domain/agent-provider.js';
import type { Contract } from '../domain/contract.js';
import type { RedactionOptions } from '../domain/evidence.js';
import type { DeclaredIds } from '../schemas/plan.js';
import { invoke } from '../providers/invoke.js';
import type { Clock } from '../domain/ports.js';
import { assemblePrompt } from './prompt-assembly.js';

/** One criterion's answer to "what would measure this?". */
export interface MeasurabilityVerdict {
  readonly criterionId: string;
  /**
   * The declared observation or gate that would report the needed facts, or
   * `null` when the provider found none.
   */
  readonly instrument: string | null;
  /** One sentence: what would have to be observed, or what is missing. */
  readonly note: string;
}

/** The whole preflight answer. */
export interface MeasurabilityReport {
  readonly verdicts: readonly MeasurabilityVerdict[];
  /** Criteria no declared instrument can see. The operator's decision list. */
  readonly unmeasurable: readonly MeasurabilityVerdict[];
  /** Provider attempts spent, so the cost is visible (FR-14). */
  readonly attempts: number;
}

interface PreflightDraft {
  readonly verdicts: readonly MeasurabilityVerdict[];
}

/**
 * Validates the provider's answer structurally, and — the part that matters —
 * **against the contract's own criterion list**.
 *
 * A reply that silently omits criteria would understate the problem, which is
 * the one failure mode that makes this check worse than useless: an operator
 * reading "3 unmeasurable" when 34 are would freeze with more confidence than
 * before. So every id must be present exactly once, and no id may be invented.
 */
function preflightSchemaFor(contract: Contract): ResponseValidator<PreflightDraft> {
  const expected = new Set(contract.spec.criteria.map((criterion) => criterion.id));

  return {
    safeParse(value: unknown) {
      if (typeof value !== 'object' || value === null || !Array.isArray((value as PreflightDraft).verdicts)) {
        return { success: false as const, error: 'expected an object with a "verdicts" array' };
      }

      const verdicts = (value as PreflightDraft).verdicts;
      const errors: string[] = [];
      const seen = new Set<string>();

      for (const [index, verdict] of verdicts.entries()) {
        if (typeof verdict !== 'object' || verdict === null) {
          errors.push(`verdicts[${String(index)}] is not an object`);
          continue;
        }
        const { criterionId, instrument, note } = verdict as MeasurabilityVerdict;
        if (typeof criterionId !== 'string' || !expected.has(criterionId)) {
          errors.push(
            `verdicts[${String(index)}].criterionId "${String(criterionId)}" is not a criterion of this contract`,
          );
          continue;
        }
        if (seen.has(criterionId)) {
          errors.push(`${criterionId} appears more than once`);
          continue;
        }
        seen.add(criterionId);
        if (instrument !== null && typeof instrument !== 'string') {
          errors.push(`${criterionId}.instrument must be a declared id or null`);
        }
        if (typeof note !== 'string' || note.trim() === '') {
          errors.push(`${criterionId}.note must say what would be observed`);
        }
      }

      for (const id of expected) {
        if (!seen.has(id)) {
          errors.push(`${id} is missing — every criterion must be answered, including the easy ones`);
        }
      }

      return errors.length > 0
        ? { success: false as const, error: errors.join('; ') }
        : { success: true as const, data: { verdicts } };
    },
  };
}

/**
 * The byte cap on the assembled preflight prompt.
 *
 * Larger than the 24 000 the verify-edge builders use, and smaller than the plan-author's
 * 200 000, because the input is one line per criterion rather than an epic's prose or a
 * whole plan. tenstandard's epic-6 contract — 91 criteria, the largest this tool has been
 * asked to freeze — assembles to roughly 20 000 bytes here, so this leaves room for a
 * contract several times that before it refuses.
 */
export const PREFLIGHT_PROMPT_CAP_BYTES = 120_000;

/** The prompt. Fixed literals here; the variable half is the criteria below. */
export function buildPreflightPrompt(
  contract: Contract,
  declared: DeclaredIds,
  redaction?: RedactionOptions,
): string {
  const head = [
    'For each acceptance criterion below, answer ONE question:',
    '',
    '  Which of this project\'s DECLARED instruments would report the facts needed',
    '  to decide this criterion — or does none of them?',
    '',
    'You are NOT writing probes, assertions or guidance. One short answer each.',
    '',
    'DECLARED INSTRUMENTS. These are the only ones that exist. An instrument not',
    'listed here does not exist, however reasonable it would be for it to:',
    '',
    `  observations: ${declared.commandIds.join(', ') || '(none)'}`,
    `  services:     ${declared.serviceIds.join(', ') || '(none)'}`,
    '  gates:        the project\'s declared gate commands, which report pass/fail only',
    '  file:         reading a committed file\'s contents or existence',
    '',
    'ANSWER SHAPE. Return JSON: {"verdicts": [{"criterionId", "instrument", "note"}]}',
    '',
    '  - "instrument": the declared id that would report the facts, or the string',
    '    "file" for a criterion decidable by reading a committed file, or null when',
    '    NOTHING listed above can see what the criterion is about.',
    '  - "note": one sentence. When an instrument fits, name the fact it would have',
    '    to report. When none does, name what is missing.',
    '',
    'ANSWER FOR EVERY CRITERION, including the obvious ones. A missing id is worse',
    'than a wrong one: it understates the problem, and the operator reads the count.',
    '',
    'DO NOT be charitable. If an observation reports page-level facts and the',
    'criterion is about one component\'s attributes, the honest answer is null even',
    'though the observation is "about the frontend". Null is the useful answer —',
    'it is what tells the operator to declare an instrument or reword the criterion',
    'while that is still free. A guess here becomes a criterion nobody can measure,',
    'frozen, for the life of the epic.',
    '',
    'CRITERIA:',
    '',
  ];

  // ⚠️ EVERYTHING BELOW THIS LINE IS UNTRUSTED, and the split is the same security decision
  // `prompt.ts` records. `head` is fixed literals authored in this repository; a criterion
  // statement is prose a person wrote in a planning artifact, and "the API accepts
  // AUTH_TOKEN=hunter2" is careless rather than exotic.
  //
  // This builder first assembled its own string — `${head}${body}` — and so carried neither
  // redaction nor a cap, while its four siblings carried both. That is precisely the
  // divergence `tests/unit/authoring/prompt-redaction-parity.test.ts` exists to prevent, and
  // it survived because the builder was not exported and had no row in that table. It is
  // exported now so the table can reach it.
  const body = contract.spec.criteria.map(
    (criterion) => `${criterion.id} [${criterion.kind}] ${criterion.statement}`,
  );

  return assemblePrompt({
    head,
    body,
    // The trailing newline belongs inside the assembly, never appended after it — see the
    // same note in `prompt.ts`, where a byte appended afterwards put the prompt over the cap
    // it advertises.
    tail: [''],
    capBytes: PREFLIGHT_PROMPT_CAP_BYTES,
    // REFUSE RATHER THAN TRUNCATE. A silently shortened prompt asks about fewer criteria
    // than the contract has, and the answer would read as "the rest are measurable" — the
    // false green this preflight exists to prevent, reintroduced by its own prompt.
    onOverflow: 'refuse',
    ...(redaction === undefined ? {} : { redaction }),
  });
}

export interface PreflightInput {
  readonly contract: Contract;
  readonly declared: DeclaredIds;
  readonly provider: AgentProvider;
  readonly clock: Clock;
  /**
   * The project's config-declared redaction (AD-10), forwarded to the prompt assembly.
   *
   * FED by `src/cli/commands/contract.ts` from the loaded `config.redaction`, exactly as the
   * drafting path beside it has been since story 7.4. Optional only so that a caller with no
   * config — a test — need not invent one; the built-in rules apply either way.
   */
  readonly redaction?: RedactionOptions;
}

/**
 * Asks the question and returns the answer. Never throws for a "no" — an
 * unmeasurable criterion is a finding, not an error.
 *
 * A provider failure DOES propagate: if the question could not be asked, the
 * caller must say so rather than report an empty list, which would read as
 * "everything is measurable".
 */
export async function preflightMeasurability(input: PreflightInput): Promise<MeasurabilityReport> {
  const request = {
    role: 'plan-author' as const,
    prompt: buildPreflightPrompt(input.contract, input.declared, input.redaction),
    responseSchema: preflightSchemaFor(input.contract),
    // One line per criterion rather than a probe set, so the bound stays small
    // even on a large contract. See `workUnits` in `AgentPrompt`.
    workUnits: Math.ceil(input.contract.spec.criteria.length / 4),
  } satisfies AgentPrompt & { responseSchema: ResponseValidator<PreflightDraft> };

  const response = await invoke(request, { provider: input.provider, clock: input.clock });
  const verdicts = response.parsed.verdicts;

  return {
    verdicts,
    unmeasurable: verdicts.filter((verdict) => verdict.instrument === null),
    attempts: response.attempts.length,
  };
}
