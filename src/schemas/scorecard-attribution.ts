/**
 * The FR-34 defect attribution — one human judgement about one finding (story 6.6).
 *
 * ============================================================================
 * ⚠️ THE ONE INPUT NO MACHINE MAY SUPPLY
 * ============================================================================
 *
 * `unique` / `duplicate-of-earlier-gate` / `false-positive` is a call only a developer
 * can make. It is the whole point of FR-34 and it is the single input to the north-star
 * metric (PRD SM-1, brief §54) that nothing in this product can derive.
 *
 * So there is **no default, no inference and no fallback** anywhere in this module.
 * `parseAttributionValue` throws on anything outside the closed vocabulary rather than
 * guessing; the schema makes `attribution` required rather than optional-with-a-default;
 * and a finding nobody has judged stays **unattributed**, which
 * `src/report/scorecard-summary.ts` counts and reports as its own number.
 *
 * **A north-star metric computed as if unattributed findings were `unique` would be the
 * most flattering possible lie about this product.** Everything here is arranged so that
 * cannot happen by accident.
 *
 * ============================================================================
 * LOCAL ONLY, AND A SECOND FILE RATHER THAN A FIELD
 * ============================================================================
 *
 * The attribution lives in `.specwitness/attributions.jsonl`, beside — never inside —
 * story 6.5's `.specwitness/scorecard.jsonl`. Two reasons, and the first is decisive:
 *
 *  - 6.5's record schema is `.strict()`, so a foreign line appended to that file parses
 *    as MALFORMED and is skipped. Writing attributions there would inflate the very
 *    skipped-record count ADR-008 §5 exists to keep honest, and would corrupt the
 *    denominator of every metric computed over it;
 *  - a scorecard line is written by `verify` the instant a run finishes; an attribution
 *    is written by a human days later, possibly more than once for the same finding.
 *    Different writer, different lifecycle, different file.
 *
 * The join key is `(runId, criterionId)` — exactly the key story 6.5 designed its
 * `findingCriterionIds` arrays to expose (its PR #71 §6).
 *
 * Local-first, like the scorecard: no HTTP client is imported here or in
 * `src/infra/attribution-store.ts`, and the `scorecard-is-local-only` rule in
 * `.dependency-cruiser.cjs` is extended to both of this story's modules so the ban is
 * structural rather than remembered.
 *
 * ============================================================================
 * WHAT REDACTION ON `--note` DOES AND DOES NOT BUY (AD-10)
 * ============================================================================
 *
 * `--note` is untrusted free text arriving on a command line and persisted to a file
 * that will be pasted into issues, so it goes through `boundedText` — redact, then cap.
 *
 * **Stated precisely rather than overclaimed:** `redactText` recognises secrets by SHAPE
 * — a sensitive name followed by `:` or `=` (`api_key=…`, `password: …`), and sensitive
 * header lines (`Authorization: …`). A bare opaque token sitting alone in prose matches
 * no pattern and is **not** redacted, because nothing distinguishes it from an ordinary
 * word. That is a property of every redactor, not a defect in this one, and the honest
 * consequence is: the cap always applies, the redaction applies to the shapes it knows,
 * and the file is the operator's own. An earlier draft of this module's test asserted
 * over a bare token and would have passed for the wrong reason while claiming a
 * guarantee the product does not make.
 *
 * AD-1: `src/schemas/**` may import `src/domain/**`, its own siblings and zod.
 */

import { z } from 'zod';

import { boundedText } from '../domain/evidence.js';
import { UsageError } from '../domain/errors.js';
import { IsoUtcTimestamp } from './manifest.js';
import { unknownKeysOnly } from './unknown-keys.js';
import { schemaVersionFor } from './versions.js';

/** The record version, per line. See `SCHEMA_VERSIONS.attribution`. */
export const ATTRIBUTION_RECORD_VERSION = schemaVersionFor('attribution');

/** The file, project-local, beside `scorecard.jsonl`. */
export const ATTRIBUTIONS_FILENAME = 'attributions.jsonl';

/**
 * The three FR-34 judgements, in the spelling AC1 puts on the command line.
 *
 * `duplicate` rather than `duplicate-of-earlier-gate` because AC1 is literal about the
 * flag surface — `--attribution unique|duplicate|false-positive` — and the CLI surface is
 * what agents and scripts type. The PRD's longer spelling is accepted as an input alias
 * (see `ATTRIBUTION_ALIASES`) so that nobody who read FR-34 instead of AC1 is refused,
 * but exactly one value is ever STORED, so the summary never has to reconcile two names
 * for one judgement.
 */
export const ATTRIBUTION_VALUES = ['unique', 'duplicate', 'false-positive'] as const;

export type AttributionValue = (typeof ATTRIBUTION_VALUES)[number];

/**
 * Input spellings accepted in addition to the canonical three.
 *
 * Deliberately tiny, and deliberately not a fuzzy matcher. `duplicate-of-earlier-gate` is
 * in the PRD and in this story's own title, so a person typing it is reading the
 * documentation correctly. Anything else is refused — a near-miss that gets "helpfully"
 * corrected is how a machine ends up supplying a human judgement.
 */
const ATTRIBUTION_ALIASES: Readonly<Record<string, AttributionValue>> = Object.freeze({
  'duplicate-of-earlier-gate': 'duplicate',
});

const ATTRIBUTION_HINT =
  `pass one of: ${ATTRIBUTION_VALUES.join(', ')} — this is a human judgement about a ` +
  'finding and SpecWitness will never infer it';

/**
 * Resolves a command-line `--attribution` value, or refuses.
 *
 * Throws `UsageError` (exit 64) rather than returning a default. **There is no default**:
 * see this module's header. Case-sensitive on purpose — `UNIQUE` is a typo, and silently
 * accepting one spelling of a judgement while rejecting another is how a vocabulary stops
 * being closed.
 */
export function parseAttributionValue(raw: string): AttributionValue {
  const trimmed = raw.trim();

  if ((ATTRIBUTION_VALUES as readonly string[]).includes(trimmed)) {
    return trimmed as AttributionValue;
  }

  const alias = ATTRIBUTION_ALIASES[trimmed];
  if (alias !== undefined) {
    return alias;
  }

  throw new UsageError(`invalid attribution: '${raw}'`, ATTRIBUTION_HINT);
}

/**
 * The per-field byte cap for a note.
 *
 * Larger than the scorecard's 256 because a note is prose a human wrote and a sentence is
 * worth keeping whole; small enough that one record stays far inside the size where a
 * single `O_APPEND` write is atomic, which is what the concurrent-append design rests on
 * (see `src/infra/attribution-store.ts`).
 */
const NOTE_CAP_BYTES = 512;

/** The cap applied to identifiers, which are already structurally constrained. */
const ID_CAP_BYTES = 256;

/** Bounded AND redacted. Every string that enters a record goes through here. */
function field(raw: string, capBytes: number): string {
  return boundedText(raw, { capBytes }).text;
}

/* ── the record ───────────────────────────────────────────────────────────────────── */

/**
 * One line of `.specwitness/attributions.jsonl` — one judgement about one finding.
 *
 * `(runId, criterionId)` is the join key onto story 6.5's scorecard record. There is
 * deliberately nothing else: no copy of the finding's status, no copy of the run's
 * outcome, no epic id. Every one of those is already on the scorecard record and copying
 * one here would create a second answer to a question that must have one — the same
 * discipline 6.5 applied when it read `result.outcome` instead of re-calling
 * `aggregate()`.
 */
export interface AttributionRecord {
  /** ADR-008 §5: every line carries its own version and is parsed independently. */
  readonly schemaVersion: number;
  /** The run the finding came from. Half of the join key. */
  readonly runId: string;
  /** The criterion the finding is about. The other half. */
  readonly criterionId: string;
  /** **The human judgement.** Never inferred, never defaulted (see the header). */
  readonly attribution: AttributionValue;
  /** ISO-8601 UTC, from the injected `Clock` (AD-9). Never `Date.now()`. */
  readonly recordedAt: string;
  /**
   * Optional free text from `--note`, redacted and capped.
   *
   * ABSENT rather than empty when none was given: an empty string is a value somebody
   * chose, and `undefined` is nobody having said anything. The summary reads neither —
   * a note explains a judgement to a human and no metric is computed from it.
   */
  readonly note?: string;
}

/**
 * `.strict()`, exactly as every other persisted envelope in this repository is.
 *
 * ADR-008 §1 keeps strictness and changes the DIAGNOSIS; §5 then makes the consequence
 * softer for an append-only log — skip the line with a warning and keep going.
 * `parseAttributionLine` below is where that distinction is made.
 */
export const AttributionRecordSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    runId: z.string().min(1),
    criterionId: z.string().min(1),
    attribution: z.enum(ATTRIBUTION_VALUES),
    recordedAt: IsoUtcTimestamp,
    note: z.string().min(1).optional(),
  })
  .strict();

export interface AttributionInput {
  readonly runId: string;
  readonly criterionId: string;
  readonly attribution: AttributionValue;
  /** ISO-8601 UTC from the caller's injected clock. */
  readonly recordedAt: string;
  readonly note?: string;
}

/**
 * Builds a record from validated input.
 *
 * PURE and TOTAL — no clock, no I/O, no randomness. The caller supplies `recordedAt` from
 * the injected `Clock` (AD-9), and every identifier has already been validated at the CLI
 * edge; the caps here are belt-and-braces so that a record cannot grow unbounded even if
 * a future caller forgets.
 *
 * A note that redacts away to nothing is DROPPED rather than stored as an empty string —
 * `note: ""` in a file reads as "the author wrote nothing", which is a different fact
 * from "the author wrote something and all of it was a credential".
 */
export function makeAttributionRecord(input: AttributionInput): AttributionRecord {
  const note = input.note === undefined ? undefined : field(input.note, NOTE_CAP_BYTES).trim();

  return {
    schemaVersion: ATTRIBUTION_RECORD_VERSION,
    runId: field(input.runId, ID_CAP_BYTES),
    criterionId: field(input.criterionId, ID_CAP_BYTES),
    attribution: input.attribution,
    recordedAt: input.recordedAt,
    ...(note === undefined || note === '' ? {} : { note }),
  };
}

/**
 * ONE record as ONE line, newline-terminated.
 *
 * No indentation — this is JSONL, and a pretty-printed record would span lines and stop
 * being independently parseable, which is the property ADR-008 §5 rests on. The trailing
 * newline is part of the record: without it the next append concatenates onto this one.
 */
export function serializeAttributionRecord(record: AttributionRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/* ── reading, ADR-008 §5 ──────────────────────────────────────────────────────────── */

/** Why a line was skipped. The two are not interchangeable — see `parseAttributionLine`. */
export type AttributionSkipReason = 'version-skew' | 'malformed';

export type AttributionLineParse =
  | { readonly ok: true; readonly record: AttributionRecord }
  | { readonly ok: false; readonly reason: AttributionSkipReason; readonly message: string };

/**
 * Parses ONE line, and never throws.
 *
 * ADR-008 §5 in code, asking the same three questions in the same order as story 6.5's
 * `parseScorecardLine`. That symmetry is deliberate: `scorecard summary` reads both logs
 * side by side and reports one skipped-record count over them, so the two files must not
 * disagree about what a newer writer looks like.
 *
 *  - a valid record;
 *  - `version-skew` — a NEWER schemaVersion, or a failure whose every issue was an
 *    unrecognised key. Skipped, and the reader continues;
 *  - `malformed` — anything else: bad JSON, a missing field, a wrong type, an
 *    out-of-vocabulary attribution. Also skipped, also counted, and **diagnosed
 *    differently**, because a test that only covered the skew direction would let real
 *    corruption become an upgrade hint (ADR-008 "Consequences", last bullet).
 *
 * ⚠️ THE VERSION IS READ BEFORE THE SHAPE, and story 6.5 learned that ordering as a P2
 * (its PR #71 §11). The unknown-key branch cannot catch a version bump: ADR-008 §3
 * defines a bump as an EXISTING field changing meaning, type or requiredness, so a
 * version-2 record can carry exactly the version-1 key set and mean something different
 * by it. No unknown keys, every type valid, and every number computed from it wrong.
 *
 * A CEILING, not a wall — only a NEWER version is refused. AD-5's "a stored run from last
 * week must stay readable" governs the other direction.
 *
 * SECURITY: the message carries zod issue PATHS and CODES and the unrecognised KEY NAMES,
 * and never an issue's `message` or a value from the file. Some zod messages echo the
 * offending value, and the key names themselves came out of an untrusted file — so they
 * are bounded and redacted before they are named.
 */
export function parseAttributionLine(
  line: string,
  lineNumber: number,
  path: string,
): AttributionLineParse {
  const where = `${path} line ${lineNumber}`;

  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return {
      ok: false,
      reason: 'malformed',
      message:
        `${where} is not a readable attribution record — record skipped (not valid JSON, ` +
        `most likely a partially-written line).`,
    };
  }

  if (typeof json === 'object' && json !== null && 'schemaVersion' in json) {
    const version = (json as { schemaVersion: unknown }).schemaVersion;
    if (typeof version === 'number' && version > ATTRIBUTION_RECORD_VERSION) {
      return {
        ok: false,
        reason: 'version-skew',
        message:
          `${where} was written by a newer SpecWitness than the one reading it — record ` +
          `skipped (schemaVersion ${version}, this build understands ` +
          `${ATTRIBUTION_RECORD_VERSION}). Upgrade specwitness to read it.`,
      };
    }
  }

  const parsed = AttributionRecordSchema.safeParse(json);
  if (parsed.success) {
    return { ok: true, record: parsed.data };
  }

  // Story 6.3's shared classifier (`src/schemas/unknown-keys.ts`), the same one story 6.5
  // converged onto. It CLASSIFIES and does not speak, so this file still picks its own
  // message and its own consequence.
  const unknown = unknownKeysOnly(parsed.error);
  if (unknown !== null) {
    return {
      ok: false,
      reason: 'version-skew',
      message:
        `${where} was written by a newer SpecWitness than the one reading it — record skipped. ` +
        `Unknown field(s): ${unknown.map((key) => field(key, ID_CAP_BYTES)).join(', ')}. ` +
        `Upgrade specwitness to read it.`,
    };
  }

  // Paths and codes only. Never `issue.message`, which can quote the value it rejected.
  // Every path segment is redacted too — belt-and-braces today, since every segment this
  // schema can produce is one of its own field names, but the day someone adds a
  // free-form-keyed field a path segment becomes attacker-controlled.
  const detail = parsed.error.issues
    .map(
      (issue) =>
        `${issue.path.map((segment) => field(String(segment), ID_CAP_BYTES)).join('.') || '<root>'}: ${issue.code}`,
    )
    .join('; ');

  return {
    ok: false,
    reason: 'malformed',
    message: `${where} is not a readable attribution record — record skipped (${detail}).`,
  };
}
