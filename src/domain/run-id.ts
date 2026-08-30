/**
 * The canonical run identifier.
 *
 * Format (spine Consistency Conventions, Identifiers row — NORMATIVE):
 *
 *   run-<YYYYMMDDTHHmmssZ>-<4 random base36>      e.g. run-20260830T142501Z-a3f9
 *
 * Three properties the format is buying, none of them accidental:
 *
 *  - **Chronological by construction.** A compact big-endian UTC timestamp
 *    sorts correctly as plain text, so listing runs needs no date parsing and
 *    no index — `listRuns()` sorts strings.
 *  - **Filesystem-safe.** A run id IS a directory name (AD-8). No colons
 *    (which Windows rejects), no separators that could be read as a path, and
 *    a fixed width so nothing truncates.
 *  - **Collision-resistant enough, and fails closed when it is not.** The 4
 *    base36 characters give ~1.7M suffixes within a single second; the
 *    astronomically unlikely same-second-same-suffix case is rejected by
 *    `RunStore` rather than silently reusing a directory.
 *
 * AD-1: this module is pure. No node builtins, no npm packages, no I/O — the
 * time and the randomness both arrive through AD-9 ports.
 */

import { InfraError, UsageError } from './errors.js';
import type { Clock, Ids } from './ports.js';

/** Characters in the random suffix. Part of the normative format. */
export const RUN_ID_SUFFIX_LENGTH = 4;

/** A human-readable statement of the format, reused in every error hint. */
export const RUN_ID_SHAPE = 'run-<YYYYMMDDTHHmmssZ>-<4 lowercase base36>';

/**
 * The one matcher for the format.
 *
 * Anchored, with every field a FIXED width. That is the whole defence against
 * the `Number.parseInt` saturation class of bug (values past 2^53-1 silently
 * collapse onto each other): an over-long digit run fails to match here and
 * never reaches a numeric conversion at all. Widening any `{n}` below
 * re-opens that door.
 */
const RUN_ID_PATTERN =
  /^run-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-([0-9a-z]{4})$/;

/** Suffix charset check, used to validate what the `Ids` port hands back. */
const SUFFIX_PATTERN = /^[0-9a-z]{4}$/;

/** A run id broken into its parts. */
export interface ParsedRunId {
  /** The timestamp field verbatim, e.g. `20260830T142501Z`. */
  readonly timestamp: string;
  /** The instant the id encodes, to whole-second precision. */
  readonly createdAt: Date;
  /** The 4-character random suffix. */
  readonly suffix: string;
}

/**
 * Structural + calendar validation.
 *
 * Returns the parts when valid so `isRunId` and `parseRunId` share exactly one
 * implementation — two validators inevitably drift, and this one guards a
 * directory name.
 */
function match(value: string): ParsedRunId | undefined {
  const m = RUN_ID_PATTERN.exec(value);
  if (m === null) {
    return undefined;
  }

  // Defaults satisfy `noUncheckedIndexedAccess`; they are unreachable, because
  // the pattern above has no optional groups — a match fills all seven.
  const [, year = '', month = '', day = '', hour = '', minute = '', second = '', suffix = ''] = m;

  // Every field is exactly 2–4 digits by the pattern above, so these are
  // bounded well inside the safe-integer range and cannot saturate. The real
  // work here is calendar validity, which a range check alone would miss.
  const ms = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  if (Number.isNaN(ms)) {
    return undefined;
  }

  const createdAt = new Date(ms);
  // Round-trip the components. `Date.UTC` happily rolls 31 February over into
  // 3 March, so comparing back is what actually rejects impossible dates —
  // including 29 February in a common year.
  const roundTripped =
    createdAt.getUTCFullYear() === Number(year) &&
    createdAt.getUTCMonth() === Number(month) - 1 &&
    createdAt.getUTCDate() === Number(day) &&
    createdAt.getUTCHours() === Number(hour) &&
    createdAt.getUTCMinutes() === Number(minute) &&
    createdAt.getUTCSeconds() === Number(second);
  if (!roundTripped) {
    return undefined;
  }

  return { timestamp: `${year}${month}${day}T${hour}${minute}${second}Z`, createdAt, suffix };
}

/** True when `value` is a syntactically and calendrically valid run id. */
export function isRunId(value: string): boolean {
  return match(value) !== undefined;
}

/**
 * Splits a run id into its parts.
 *
 * Throws `UsageError` (exit 64) rather than `InfraError` (exit 3) on a
 * malformed id: it is the caller's typo, and exit 3 would tell a harness that
 * rerunning might help. Callers enumerating a directory should filter with
 * `isRunId` instead of catching this — a stray directory is not a usage error.
 */
export function parseRunId(value: string): ParsedRunId {
  const parsed = match(value);
  if (parsed === undefined) {
    throw new UsageError(
      `not a valid run id: '${value}'`,
      `run ids look like ${RUN_ID_SHAPE}, for example run-20260830T142501Z-a3f9`,
    );
  }
  return parsed;
}

/**
 * Mints a new run id from the injected ports.
 *
 * Truncates to whole seconds by construction (slicing the ISO text rather than
 * rounding), so the id always names an instant at or before the manifest's
 * `createdAt` — a rounded id could claim a second that had not happened yet.
 */
export function makeRunId(clock: Clock, ids: Ids): string {
  const now = clock.now();
  if (Number.isNaN(now.getTime())) {
    throw new InfraError(
      'the clock returned an invalid date',
      'this is a defect in the Clock implementation, not in your project',
    );
  }

  // `toISOString` is always UTC, so the ambient TZ cannot leak into an id.
  // Reading local-time getters here instead would be the classic bug.
  const iso = now.toISOString(); // 2026-08-30T14:25:01.123Z
  const timestamp = `${iso.slice(0, 19).replace(/[-:]/g, '')}Z`;

  const suffix = ids.randomBase36(RUN_ID_SUFFIX_LENGTH);
  if (!SUFFIX_PATTERN.test(suffix)) {
    // Fail closed: an out-of-charset suffix mints a directory we could create
    // but never find again, because every lookup path validates the id.
    throw new InfraError(
      `the id generator returned an invalid suffix: '${suffix}'`,
      `a run-id suffix must be exactly ${RUN_ID_SUFFIX_LENGTH} characters from [0-9a-z]`,
    );
  }

  return `run-${timestamp}-${suffix}`;
}
