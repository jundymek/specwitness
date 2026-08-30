/**
 * Consistency Conventions — canonical identifiers.
 *
 * THE single implementation of epic-id normalisation and criterion-id
 * formatting. The CLI, ingestion and every later epic call these rather than
 * writing their own parser: two parsers means `epic-07` resolves to a
 * different contract than `7` somewhere, exactly once, in production.
 *
 * Everything here is pure and deterministic.
 *
 * AD-1: imports only a sibling domain module.
 */

import { UsageError } from './errors.js';

/** `7` / `07` / `epic-7` / `EPIC-07` — optional prefix, digits, nothing else. */
const EPIC_ID_PATTERN = /^(?:epic-)?(\d+)$/i;

/** Canonical criterion id: epic number unpadded, sequence zero-padded to >= 2. */
const CRITERION_ID_PATTERN = /^E([1-9]\d*)-(\d{2,})$/;

const EPIC_ID_HINT =
  "pass an epic number or a canonical epic id, e.g. '7', 'epic-7' or 'epic-07' (all mean epic-7)";

/**
 * Normalises any accepted spelling of an epic identifier to its canonical form.
 *
 *   normalizeEpicId('7')       === 'epic-7'
 *   normalizeEpicId('epic-07') === 'epic-7'
 *   normalizeEpicId('EPIC-7')  === 'epic-7'
 *
 * Surrounding whitespace is trimmed (argument vectors and YAML both leak it).
 * Leading zeros are stripped, so the canonical form is stable and idempotent.
 *
 * Throws `UsageError` (exit 64) on anything else, including `0` and negatives.
 * SpecWitness fails closed and then explains: silently minting `epic-0` for
 * what is almost certainly a caller bug is worse than refusing it.
 */
export function normalizeEpicId(input: string): string {
  const trimmed = input.trim();
  const match = EPIC_ID_PATTERN.exec(trimmed);

  if (match === null) {
    throw new UsageError(`invalid epic id: '${input}'`, EPIC_ID_HINT);
  }

  // `\d+` guarantees digits only, so this cannot be NaN and cannot be negative.
  const epicNumber = Number.parseInt(match[1] as string, 10);
  if (epicNumber < 1) {
    throw new UsageError(`invalid epic id: '${input}' — epic numbers start at 1`, EPIC_ID_HINT);
  }
  // Beyond 2^53-1 `parseInt` silently loses precision — 9007199254740993 and
  // 9007199254740992 both parse to the same number, and a long enough digit
  // string becomes Infinity. Either would let two DIFFERENT epics share one
  // canonical id, i.e. verify the wrong epic's contract. Refuse instead.
  if (!Number.isSafeInteger(epicNumber)) {
    throw new UsageError(
      `invalid epic id: '${input}' — epic number is too large to represent exactly`,
      EPIC_ID_HINT,
    );
  }

  return `epic-${epicNumber}`;
}

const CRITERION_ID_HINT =
  "criterion ids are 'E<epic>-<NN>' with the epic number unpadded and the sequence zero-padded to two digits, e.g. 'E7-01'";

/**
 * Builds a canonical criterion id: `E<n>-<NN>`.
 *
 *   buildCriterionId(7, 1)   === 'E7-01'
 *   buildCriterionId(7, 100) === 'E7-100'
 *
 * The epic number is NOT padded and the sequence is padded to a minimum of two
 * digits, so a sequence past 99 simply grows. (The PRD's `E07-01` examples are
 * illustrative; the conventions table governs and says otherwise.)
 *
 * Throws `UsageError` on out-of-range input rather than emitting an id that
 * would fail its own validator.
 */
export function buildCriterionId(epicNumber: number, sequence: number): string {
  assertPositiveInteger(epicNumber, 'epic number');
  assertPositiveInteger(sequence, 'criterion sequence');
  return `E${epicNumber}-${String(sequence).padStart(2, '0')}`;
}

/** True when `value` is exactly a canonical criterion id. */
export function isCriterionId(value: string): boolean {
  const match = CRITERION_ID_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  const epicNumber = Number.parseInt(match[1] as string, 10);
  const sequence = Number.parseInt(match[2] as string, 10);
  // Reject 'E7-00' and any other zero sequence: sequences are 1-based. Reject
  // values past 2^53-1 for the same precision reason as `normalizeEpicId` —
  // beyond it, `parseCriterionId` would not round-trip.
  return sequence >= 1 && Number.isSafeInteger(epicNumber) && Number.isSafeInteger(sequence);
}

/** The two components of a canonical criterion id. */
export interface CriterionIdParts {
  readonly epicNumber: number;
  readonly sequence: number;
}

/**
 * Splits a canonical criterion id into its parts.
 *
 * Round-trips with `buildCriterionId` for every valid input. Throws
 * `UsageError` (exit 64) on a malformed id — including near-misses like
 * `E07-1`, which are the ones worth catching loudly.
 */
export function parseCriterionId(value: string): CriterionIdParts {
  const match = CRITERION_ID_PATTERN.exec(value);
  if (match === null) {
    throw new UsageError(`invalid criterion id: '${value}'`, CRITERION_ID_HINT);
  }

  const epicNumber = Number.parseInt(match[1] as string, 10);
  const sequence = Number.parseInt(match[2] as string, 10);
  if (sequence < 1) {
    throw new UsageError(
      `invalid criterion id: '${value}' — sequences start at 01`,
      CRITERION_ID_HINT,
    );
  }
  if (!Number.isSafeInteger(epicNumber) || !Number.isSafeInteger(sequence)) {
    throw new UsageError(
      `invalid criterion id: '${value}' — component too large to represent exactly`,
      CRITERION_ID_HINT,
    );
  }

  return { epicNumber, sequence };
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    // isSafeInteger, not isInteger: 2^53 is an integer but cannot round-trip,
    // so an id built from it would not parse back to the same components.
    throw new UsageError(
      `invalid ${label}: ${value} — expected a positive integer below 2^53`,
      CRITERION_ID_HINT,
    );
  }
}
