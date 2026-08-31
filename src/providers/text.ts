/**
 * CLI-output text translation, shared by every agent-CLI adapter.
 *
 * Both official CLIs are asked for JSON and both sometimes answer with the JSON
 * wrapped in a markdown code fence — that is a property of the *model*, not of
 * either CLI, so unwrapping it is one behaviour needed in two adapters.
 *
 * It lives here, once, deliberately: story 2.4 (claude) owns this file on behalf
 * of story 2.5 (codex), agreed in writing during cohort intent-sync, so the two
 * adapters cannot drift into two subtly different strippers. Sibling imports
 * inside `src/providers/` are permitted by the `adapters-core-only` rule's `$1`
 * group substitution.
 *
 * Why this belongs to the adapters and not to `providers/invoke.ts`: fences are
 * a CLI/model output artifact, and AD-2 keeps the shared schema gate purely
 * about schemas. The gate validates; adapters translate.
 *
 * This module has no imports, performs no I/O, and never throws.
 */

/** ``` or longer, a language tag, then end-of-line. Anchored: the fence must open the text. */
const OPENING_FENCE = /^(`{3,})[^\n`]*\r?\n/;

/**
 * Removes one leading markdown code fence and its matching closing fence.
 *
 * Recognition is deliberately strict, and the strictness is the feature. An
 * adapter's job is to return the model's text RAW so the schema gate can accept
 * or reject it honestly (AD-2). Anything not positively recognised as a fully
 * fenced payload is therefore returned BYTE-IDENTICAL rather than guessed at:
 *
 * - an unterminated fence is a truncated response — a real failure mode, and
 *   inventing an ending would hand the gate a silently-corrupted body instead of
 *   letting it record an honest rejected attempt;
 * - prose before the fence means the model returned a *message* containing a
 *   code block, not a fenced payload, and editing that is not this function's
 *   call to make.
 *
 * Only the outermost fence is removed: a payload that is itself a fenced block
 * is content, not packaging.
 *
 * @param raw the model's text, exactly as the CLI reported it
 * @returns the unwrapped payload, or `raw` unchanged when it is not fenced
 */
export function stripCodeFence(raw: string): string {
  // Surrounding whitespace is packaging too — but only strip it once we know we
  // are looking at a fence, so unfenced text really is returned untouched.
  const trimmed = raw.trim();

  const opening = OPENING_FENCE.exec(trimmed);
  if (opening === null) {
    return raw;
  }

  // The closing fence must be at least as long as the opening one (CommonMark),
  // which is what keeps a ```` wrapper from being closed by an inner ```.
  const backticks = opening[1];
  const body = trimmed.slice(opening[0].length);

  // Leading horizontal whitespace before the closing fence is allowed, because
  // the `trim()` above already accepted an indented OPENING fence. Refusing the
  // matching closing marker would half-recognise a uniformly indented block and
  // hand the gate a still-wrapped payload it would then reject — a wrapped
  // payload is exactly what this function exists to prevent.
  const closing = new RegExp(`(?:^|\\r?\\n)[ \\t]*${backticks}\`*[ \\t]*$`).exec(body);
  if (closing === null) {
    // Unterminated: see the note above. Raw, not repaired.
    return raw;
  }

  return body.slice(0, closing.index);
}

/**
 * Append an envelope's `contextFiles` to a prompt as a delimited path list.
 *
 * Shared by every agent-CLI adapter, and shared deliberately: the gate hands
 * each adapter the SAME envelope for the same roles, so a model that never
 * learns which files matter produces a worse contract on one provider than on
 * the other — and story 2.6, which consumes the result, cannot see the
 * difference in order to compensate for it. Two private copies of this format
 * would eventually diverge; one function cannot.
 *
 * Appended as text rather than passed through a flag because neither CLI has a
 * probed flag for attaching text files, and AD-4 forbids reaching for one that
 * has not been tested.
 *
 * Takes PRIMITIVES rather than `AgentPrompt`, for the same reason
 * `stripCodeFence` takes a string: it keeps this module import-free, which is
 * what makes it trivially safe for any adapter to pull in.
 *
 * An absent or empty list returns the prompt UNCHANGED — no trailing header for
 * a section with nothing in it.
 *
 * Landed here by story 2.5 with story 2.4's written agreement. 2.4 owns this
 * file and had already merged, so the alternative was a duplicated format in
 * both adapters — the exact drift this file exists to prevent.
 */
export function withContextFiles(prompt: string, contextFiles?: readonly string[]): string {
  if (contextFiles === undefined || contextFiles.length === 0) {
    return prompt;
  }
  const list = contextFiles.map((file) => `- ${file}`).join('\n');
  return `${prompt}\n\nContext files:\n${list}`;
}
