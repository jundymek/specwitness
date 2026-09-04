/**
 * THE ONE SHARED PROMPT-ASSEMBLY HELPER FOR `src/authoring/**`. Story 6.8, retiring Epic 5
 * action item e5-A.
 *
 * ============================================================================
 * IF YOU ARE ADDING A PROVIDER-FACING MODULE TO THIS LAYER, START HERE
 * ============================================================================
 *
 * Every prompt this product sends is assembled by one of the builders in this layer, and
 * every one of them goes through `assemblePrompt`. **Do not hand-assemble a prompt string
 * and do not write your own redaction or truncation.** `src/domain/evidence.ts` owns the
 * primitives; this module composes them and is the only place that needs to.
 *
 * ============================================================================
 * WHY THIS EXISTS: THE SAME TWO DEFECTS, DERIVED TWICE, FIXED IN NEITHER
 * ============================================================================
 *
 * Epic 5 retro §2 observation 3. Story 5.5 (round 2) and story 5.6 (round 13) EACH found,
 * hours apart and in different modules, that:
 *
 *  1. **bounding the prompt cut off its tail** — and the tail is where "reply with JSON
 *     matching this shape" and "these are the only valid ids" live. So the runs with the
 *     MOST evidence to send were exactly the runs whose prompt never said what to reply
 *     with, and they then burned the whole retry budget on schema rejections. The failure
 *     arrived precisely where the feature was most wanted;
 *  2. **the contract `statement` travels verbatim from the frozen contract** into a prompt
 *     with no earlier boundary redacting it.
 *
 * Neither fix was applied to the other's module, deliberately, because neither story owned
 * the other's code. This module owns both. Duplicated structure produces duplicated
 * defects on a schedule, and that observation — not prompt formatting — is the subject of
 * this file.
 *
 * ============================================================================
 * THE INSTRUCTION TAIL, AND WHY THE OBVIOUS IMPLEMENTATION IS THE BUG
 * ============================================================================
 *
 * The naive bound truncates the assembled string at its end. That IS the defect: a prompt
 * is `head` (fixed instructions) + `body` (variable, untrusted evidence) + `tail` (fixed
 * response rules), and the end of that document is the part that must never be cut.
 *
 * So the bound falls on the **variable middle alone**. `head` and `tail` are concatenated
 * after the body has been bounded and are therefore untouchable at any input size.
 *
 * **When the fixed framing alone exceeds `capBytes`, the framing is returned whole and the
 * body is empty.** That direction is deliberate: a prompt with no evidence is a useless
 * question, while a prompt with no instructions is an unanswerable one that also costs the
 * full retry budget to discover. The cap is a cost control; the instructions are the
 * product.
 *
 * ============================================================================
 * REDACTION IS A PROPERTY OF ASSEMBLY, NOT A STEP A BUILDER MUST REMEMBER
 * ============================================================================
 *
 * `assemblePrompt` redacts **everything placed in `body`**, whether or not the builder
 * called `promptField` on it first. That is the one structural guarantee this story
 * claims: a module in this layer cannot get an unredacted field into a prompt through this
 * function, including by forgetting to.
 *
 * `promptField` therefore exists to BOUND one value, not to be the thing that redacts it.
 *
 * ⚠️ **AND IT CANNOT APPLY A CONFIGURED PATTERN AT ALL** — `PromptFieldOptions` has nowhere
 * to put one. An earlier version of this paragraph said that "redaction is idempotent, so a
 * field that passed through both is redacted once in effect". That is true of the BUILT-IN
 * patterns and **false of `extraPatterns`**, which are arbitrary project regexes: `/E/g`
 * alone turns `EEE` into `[R[REDACTED]DACT[REDACTED]D]`, because the replacement contains an
 * `E`. Raised as a P2 by the codex review — the same wrong sentence had already survived the
 * fix to the defect it described one level down. The configured patterns are applied exactly
 * once, by `assemblePrompt`, over the assembled body.
 *
 * `head` and `tail` are NOT redacted, and that is not an oversight. They are fixed string
 * literals authored in this repository, not text captured from anything — running the
 * redactor over them could only damage them, and an instruction that reads
 * `api_key: [REDACTED]` is an instruction the model cannot follow.
 *
 * **AD-10: unification WIDENS, it never narrows.** Where two call sites disagreed about
 * whether a field needed redacting, this module takes the stricter behaviour. The contract
 * `statement` is the case that matters and it is redacted at every call site now.
 *
 * ============================================================================
 * WHAT THIS MODULE IS NOT
 * ============================================================================
 *
 * **It is not a redaction engine.** There is no regex over untrusted text anywhere in this
 * file, and there must never be one: `redactText` and `boundedText` in
 * `src/domain/evidence.ts` are the single implementation, and a second one here would be
 * exactly the duplication this story was written to remove. If a new secret shape needs
 * recognising, it belongs in `src/domain/evidence.ts`.
 *
 * **It is not an enforcement mechanism (AD-2).** A prompt is advice to a system under no
 * obligation to take it. `src/providers/invoke.ts` and the response schemas are what make
 * a malformed answer impossible to turn into state. This module changes how a question is
 * asked, never what an answer is permitted to be.
 *
 * **It does not decide the caps.** `capBytes` is required and has no default, so every
 * builder has to state its own number and say why. The bounds mean different things in
 * different roles — losing a criterion from the contract-author prompt silently narrows a
 * definition of done, while losing an evidence summary from the explainer costs a
 * paragraph — and a shared default would have quietly asserted they are the same question.
 *
 * Pure and deterministic: same input, same prompt. No clock, no I/O, no randomness.
 * AD-1 — application layer, imports domain only.
 */

import { InfraError } from '../domain/errors.js';
import {
  boundedText,
  redactText,
  truncationMarker,
  type RedactionOptions,
} from '../domain/evidence.js';

const encoder = new TextEncoder();

const byteLength = (text: string): number => encoder.encode(text).length;

/**
 * Rounds allowed to the marker fixed point below.
 *
 * `truncationMarker` reports "N of M bytes shown", so reserving room for it shrinks N,
 * which can shorten the marker by a digit, which frees a byte. The length is
 * non-increasing, so this converges in one round in every realistic case; the bound is
 * here because an unbounded loop over a length calculation is a hang waiting for an input
 * nobody predicted, and this file is handed untrusted text by definition.
 */
const MARKER_ROUNDS = 3;

/**
 * The shared per-field cap, in BYTES.
 *
 * 400, carried unchanged from story 5.5's `FIELD_CAP_CHARS`. The unit changed from
 * characters to bytes and the number did not: characters and bytes coincide for ASCII and
 * diverge only for text where the byte count is the honest measure of what a request
 * costs. Bytes ≤ characters for the same number, so the change is a tightening, never a
 * loosening.
 */
export const PROMPT_FIELD_CAP_BYTES = 400;

/**
 * ⚠️ **DELIBERATELY NOT `extends RedactionOptions`.** Raised as a P2 by the codex review.
 *
 * `promptField` bounds one field and `assemblePrompt` redacts the body it ends up in. If
 * this type could carry `extraPatterns`, a caller doing both — which is exactly what
 * `explain.ts` does for every field — would apply the configured patterns TWICE. The
 * built-in patterns are idempotent (`evidence.ts:427`) so running them twice is running them
 * once; a project's own regex has no such guarantee, and `/E/g` alone turns `EEE` into
 * `[R[REDACTED]DACT[REDACTED]D]`.
 *
 * Having no field for them makes the double pass **unrepresentable** rather than merely
 * avoided, which is the same discipline `schemas/adaptation.ts` uses for a boundary that
 * must not be crossed by accident.
 */
export interface PromptFieldOptions {
  /** Defaults to `PROMPT_FIELD_CAP_BYTES`. Applies to the RETURNED string, marker included. */
  readonly capBytes?: number;
}

/**
 * Redacts and bounds ONE untrusted value for inclusion in a prompt.
 *
 * Use it to stop a single runaway field from crowding out everything else in the body.
 * It is NOT what makes the value safe — `assemblePrompt` redacts the whole body regardless
 * — so forgetting it costs proportion, never exposure.
 *
 * The cap covers the returned string INCLUDING the truncation marker, so a caller that
 * budgeted 400 bytes receives at most 400 bytes. Story 5.5's `redactAndBound` appended its
 * marker outside the cap; that is a small overshoot rather than a defect, but a cap that
 * means "and then a bit more" is the kind of imprecision two modules later disagree about.
 */
export function promptField(value: string, options?: PromptFieldOptions): string {
  return boundWithMarker(
    value,
    options?.capBytes ?? PROMPT_FIELD_CAP_BYTES,
    // NO redaction options, by construction — see `PromptFieldOptions`. The built-in
    // patterns still run, inside `boundedText`, so a field is never returned raw; the
    // CONFIGURED patterns are applied exactly once, later, by `assemblePrompt`.
    undefined,
    // A space, not a newline: a field is rendered inline, on the line its label opens.
    ' ',
  );
}

/**
 * What to do when the untrusted body does not fit inside `capBytes`.
 *
 * ⚠️ **THIS EXISTS BECAUSE A `truncate`-ONLY HELPER WAS WRONG**, and it was raised as a P2
 * by the codex review of story 6.8 against that story's own reasoning.
 * `CONTRACT_PROMPT_CAP_BYTES` already said in as many words that **nothing downstream
 * detects a truncated epic** — and then mitigated that only by choosing a large number.
 *
 * A cap chosen so the bad case is unlikely is not the same as a cap that cannot produce the
 * bad case. `CLAUDE.md`'s "implementation must never silently change expected behavior" has
 * no exception for improbable inputs, and "fail closed, then explain" is the house rule.
 *
 *  - `'truncate'` (the default) — cut the body, mark the cut, carry on. Correct where what
 *    is lost DEGRADES a result: an evidence summary missing from a non-authoritative
 *    hypothesis, or one adaptation candidate the provider was free to decline anyway.
 *  - `'refuse'` — throw `InfraError` and invoke no provider. Correct where what is lost
 *    CHANGES a result: an epic or a contract is the definition of done, and a document
 *    drafted or compiled from a truncated one is silently narrower than the requirement.
 *    Exit 3, never a product FAIL (AD-7) — a prompt SpecWitness declined to build is an
 *    infrastructure limit, not a verdict about the code under test.
 *
 * The refusal happens BEFORE the provider is invoked, so it costs no subscription quota.
 */
export type PromptOverflowPolicy = 'truncate' | 'refuse';

export interface PromptAssembly {
  /**
   * Fixed instruction lines that open the prompt. NEVER redacted and NEVER bounded.
   *
   * String literals authored in this repository only. Anything variable belongs in `body`.
   */
  readonly head: readonly string[];
  /**
   * The variable, UNTRUSTED middle. Redacted and bounded, always, whatever the builder did
   * to it first.
   *
   * Joined with newlines. Everything a provider is being shown — criterion statements,
   * declared ids, evidence summaries, observed values — goes here.
   */
  readonly body: readonly string[];
  /**
   * Fixed instruction lines that close the prompt: the response shape, the valid-ids rule.
   * NEVER redacted and NEVER bounded — this is the guarantee the story exists for.
   *
   * Optional, and an absent tail is an honest answer rather than an omission: a builder
   * whose instructions all PRECEDE its content (`buildContractPrompt`, `buildPlanPrompt`)
   * has no tail to protect, because bounding its body cannot reach an instruction.
   */
  readonly tail?: readonly string[];
  /**
   * The whole-prompt cap, in BYTES. REQUIRED, with no default.
   *
   * Deliberately unavoidable: what a truncated prompt costs differs by role, so a builder
   * that has not decided has not finished. See each builder's constant for its reasoning.
   */
  readonly capBytes: number;
  /** The run's redaction options (AD-10). Built-in patterns apply whether or not this is set. */
  readonly redaction?: RedactionOptions;
  /**
   * What to do when the body does not fit. Defaults to `'truncate'`.
   *
   * The default is the LOSSY one deliberately: a builder that has thought about it says
   * `'refuse'`, and a builder that has not gets the behaviour whose failure mode is visible
   * in the prompt itself, via `truncationMarker`.
   */
  readonly onOverflow?: PromptOverflowPolicy;
}

/**
 * Assembles one prompt: fixed head, redacted and bounded untrusted middle, fixed tail.
 *
 * The returned prompt is at most `capBytes` bytes whenever the fixed framing itself fits.
 * When the framing alone exceeds the cap the framing is returned whole with no body — see
 * the module header for why that is the right direction.
 */
export function assemblePrompt(input: PromptAssembly): string {
  const tail = input.tail ?? [];

  // The framing measured EXACTLY as it will appear, with the empty string standing in for
  // the body slot so both of the separator newlines the body sits between are counted.
  // Story 5.5 overshot its cap by two characters by measuring `[...head, ...tail]` instead,
  // which undercounts by one separator.
  const framing = byteLength([...input.head, '', ...tail].join('\n'));
  const budget = input.capBytes - framing;

  const raw = input.body.join('\n');

  if ((input.onOverflow ?? 'truncate') === 'refuse') {
    // Measured on the REDACTED text, because that is what would actually be sent — a
    // redaction can only shorten, so measuring the raw text would refuse prompts that fit.
    const redactedBytes = byteLength(redactText(raw, input.redaction));
    if (redactedBytes > budget) {
      throw new InfraError(
        `the assembled prompt is too large: ${redactedBytes} bytes of content with only ` +
          `${Math.max(0, budget)} available under a ${input.capBytes} byte cap`,
        'this content cannot be sent without dropping part of it, and dropping part of it ' +
          'would change what the provider is asked. Split the epic or contract into smaller ' +
          'units, or raise the cap in the builder if the larger prompt is genuinely intended',
      );
    }
  }

  const slot = boundWithMarker(raw, budget, input.redaction, '\n');

  return [...input.head, slot, ...tail].join('\n');
}

/**
 * Redacts `raw`, caps it at `capBytes` and appends `truncationMarker` when it cut.
 *
 * The marker is inside the budget rather than added on top of it, which is what the fixed
 * point below is for. Returns the empty string when nothing — not even the marker — fits;
 * a caller in that state has already spent its whole budget on framing, and adding a bare
 * marker would blow a cap in order to report that a cap was blown.
 *
 * REDACTION HAPPENS FIRST AND ONLY THEN THE CUT, which is `boundedText`'s own documented
 * order (`evidence.ts:653-659`) and matters for a reason worth restating: cutting first
 * could split an assignment so that the pattern no longer matches, leaving the tail of a
 * credential behind in text that looks clean.
 */
function boundWithMarker(
  raw: string,
  capBytes: number,
  redaction: RedactionOptions | undefined,
  separator: string,
): string {
  if (capBytes <= 0 || raw === '') {
    return '';
  }

  // ⚠️ EVERY `boundedText` CALL BELOW STARTS FROM `raw`, NEVER FROM A REDACTED STRING, so
  // each candidate receives EXACTLY ONE redaction pass. Raised as a P1 by the codex review
  // of story 6.8, and correct.
  //
  // The first version redacted here and handed the RESULT to `boundedText`, which redacts
  // again internally. That is harmless for the BUILT-IN patterns, which `evidence.ts:427`
  // documents as idempotent — `[REDACTED]` contains no sensitive assignment, so twice is
  // once.
  //
  // It is NOT harmless for `extraPatterns`, which are arbitrary project-supplied regexes
  // with no idempotence guarantee whatsoever. `/E/g` is enough to break it: the replacement
  // `[REDACTED]` itself contains an `E`, so a second pass rewrites the marker and the text
  // GROWS — `EEE` became `[R[REDACTED]DACT[REDACTED]D]…`.
  //
  // And it grew on the wrong side of the fail-closed check. `assemblePrompt` measures ONE
  // pass to decide whether to refuse, so a larger second pass slipped past the refusal and
  // was silently truncated — defeating `onOverflow: 'refuse'` by way of the very redaction
  // it depends on. A redactor must not rely on the good behaviour of a pattern it did not
  // write.
  let bounded = boundedText(raw, { ...redaction, capBytes });
  let marker = truncationMarker(bounded);
  if (marker === '') {
    return bounded.text;
  }

  const overheadOf = (text: string): number => byteLength(text) + byteLength(separator);

  for (let round = 0; round < MARKER_ROUNDS; round += 1) {
    const limit = capBytes - overheadOf(marker);
    if (limit <= 0) {
      // Not even "… truncated: 0 of N bytes shown" fits. Say nothing rather than overflow.
      return '';
    }

    // From `raw` again, for the reason above: one pass per candidate, always.
    const candidate = boundedText(raw, { ...redaction, capBytes: limit });
    const candidateMarker = truncationMarker(candidate);
    if (candidateMarker === '') {
      // Unreachable — `limit < capBytes` and the content was already too long for
      // `capBytes` — but a fail-safe rather than a cast, because the alternative to
      // returning content that fits is returning content that does not.
      return candidate.text;
    }

    bounded = candidate;
    if (candidateMarker === marker) {
      break;
    }
    marker = candidateMarker;
  }

  return `${bounded.text}${separator}${marker}`;
}
