/**
 * ADR-008 — telling "a newer writer added a key" apart from "this document is corrupt".
 *
 * `src/schemas/versions.ts` has promised additive evolution since story 1.2: add an
 * optional key, do not bump the number, and a stored artifact stays readable. That held
 * FORWARDS — an old document still parses in a new build, because every added field is
 * optional. It broke BACKWARDS: every persisted schema is `.strict()`, so an older build
 * reading a NEWER document rejected it as **malformed** while `schemaVersion` still read
 * `1` and truthfully said the shape was unchanged. The reader announced corruption when
 * what it had actually met was a newer writer.
 *
 * ADR-008 keeps the strictness — it is what catches a typo'd key, a hand-edit and a
 * half-written file — and changes only the DIAGNOSIS. This module is the "before it
 * speaks" half of ADR-008 §2: *"The reader distinguishes 'unknown key' from 'wrong shape'
 * before it speaks."*
 *
 * ⚠️ **THIS MODULE CLASSIFIES. IT DOES NOT SPEAK, AND THAT SEPARATION IS THE WHOLE
 * DESIGN.** ADR-008 explicitly REJECTED a shared `assertSchemaVersion` helper, for the
 * reason `versions.ts` gives: what a mismatch MEANS is artifact-specific, and a shared
 * helper would freeze one answer for every artifact. Nothing here decides a message, an
 * error class, an exit code or a consequence. It answers one closed question — *were ALL
 * of these issues unrecognised keys, and if so which* — and every caller then writes its
 * own sentence and picks its own outcome. Story 6.3's two readers refuse with an
 * `InfraError` at exit 3; story 6.5's scorecard skips the offending LINE with a warning
 * and carries on summarising, because an append-only log accumulated across versions is
 * still evidence when one record is unreadable (ADR-008 §5). Same question, deliberately
 * different answers.
 *
 * ⚠️ **AND NEVER `IntegrityError`.** Callers must classify a skew as infrastructure.
 * `IntegrityError` means tampering and must keep meaning only that (ADR-008 §1); a skew
 * reported as tampering would make an ordinary upgrade indistinguishable from an attack,
 * and the alarm that is supposed to mean tampering is then the first thing an operator
 * learns to ignore.
 *
 * AD-1: pure. One `zod` import for its error type, no I/O, no clock, no state.
 */

import type { z } from 'zod';

/**
 * Every unrecognised key, path-qualified, when EVERY issue was an unrecognised-key issue;
 * `null` otherwise.
 *
 * ⚠️ **THE `null` IS THE LOAD-BEARING HALF, NOT THE ARRAY.** It is what preserves the
 * malformed-document path, and getting it wrong is a worse defect than the one ADR-008
 * fixed. The temptation is `issues.some(isUnknownKey)`, which answers "was there an
 * unknown key" — a document that is BOTH newer AND corrupt would then be reported as a
 * version skew, and the operator would be told to upgrade rather than to look at a file
 * that is genuinely broken. Upgrading would not fix it. So the test is `every`, and
 * `tests/unit/schemas/version-skew.test.ts` pins exactly that mixed case for both readers.
 *
 * An EMPTY issue list returns `null` rather than an empty array. A `ZodError` carrying no
 * issues should be unreachable, and "every issue was an unknown key" is vacuously true of
 * nothing — which would let a validation failure nobody can explain be reported as a
 * friendly upgrade hint. Fail closed: an unexplained failure is not a version skew.
 *
 * Keys are qualified by their containing path (`outer.id`, not `id`) because an
 * unqualified name is not actionable in a document with several nested objects, and worse,
 * a nested `id` would read identically to one at the root. The root's own keys are
 * returned bare, since there is no path to prefix.
 *
 * The returned array preserves zod's order and may contain duplicates only if zod reports
 * the same key twice, which it does not; callers that print it should not sort it, because
 * the writer's own field order is a hint about which upgrade introduced them.
 */
export function unknownKeysOnly(error: z.ZodError): readonly string[] | null {
  const { issues } = error;

  if (issues.length === 0) {
    return null;
  }

  const names: string[] = [];

  for (const issue of issues) {
    if (issue.code !== 'unrecognized_keys') {
      // One genuine shape defect is enough to make the whole document malformed. There is
      // no partial credit here on purpose: a reader that reported "newer, and also broken"
      // would be handing the operator two diagnoses and no decision.
      return null;
    }

    // `path` is the location of the OBJECT that carried the unexpected keys, so the keys
    // hang off it. At the root the path is empty and the names are returned bare.
    const prefix = issue.path.length === 0 ? '' : `${issue.path.join('.')}.`;
    for (const key of issue.keys) {
      names.push(`${prefix}${key}`);
    }
  }

  return names;
}
