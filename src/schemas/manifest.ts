/**
 * The run manifest (AD-5, AD-8).
 *
 * `.specwitness/runs/<run-id>/manifest.json` is the crash-recovery record. It
 * is written and fsynced BEFORE a run acquires any resource, so that a run
 * killed with -9 still leaves behind a readable list of what needs reaping.
 * Story 3.2's `specwitness clean` replays these files; that is the entire
 * reason the empty `worktrees` and `processGroups` arrays exist here today.
 *
 * AD-5 additive evolution: story 3.2 populates the reserved arrays and story
 * 3.5 adds `result.json` alongside — neither bumps `schemaVersion`, because
 * the shape already accommodates them. A version bump means a manifest from
 * last week stopped being readable, which is a migration note, not a routine
 * edit.
 *
 * The version-MISMATCH policy lives here rather than in `schemas/versions.ts`.
 * What a mismatch means is artifact-specific: a run manifest wants "a newer
 * specwitness wrote this, upgrade", while a contract may want to migrate or
 * refuse. A shared helper would freeze one answer for all of them.
 */

import { z } from 'zod';

import { InfraError } from '../domain/errors.js';
import { isRunId } from '../domain/run-id.js';
import { schemaVersionFor } from './versions.js';

/** Current manifest schema version, from the AD-5 registry. */
export const RUN_MANIFEST_VERSION = schemaVersionFor('runManifest');

/** The file name, so no other module spells it. */
export const MANIFEST_FILENAME = 'manifest.json';

const ISO_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

/**
 * True only for a timestamp naming a date that actually exists.
 *
 * `Date.parse` is NOT sufficient on its own: it accepts
 * `2026-02-31T14:25:01.123Z` and silently normalises it to 3 March, and
 * likewise turns 29 February in a common year into 1 March. A hand-edited or
 * corrupt crash-recovery manifest would then be accepted while meaning a
 * different instant than it claims. Round-tripping the components back out of
 * the parsed `Date` is what rejects those — the same technique the run-id
 * validator uses, for the same reason.
 */
function isRealUtcInstant(value: string): boolean {
  const m = ISO_UTC_PATTERN.exec(value);
  if (m === null) {
    return false;
  }
  // Defaults are unreachable: the pattern has no optional groups.
  const [, year = '', month = '', day = '', hour = '', minute = '', second = '', ms = ''] = m;

  const date = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Number(ms),
    ),
  );
  if (Number.isNaN(date.getTime())) {
    return false;
  }

  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day) &&
    date.getUTCHours() === Number(hour) &&
    date.getUTCMinutes() === Number(minute) &&
    date.getUTCSeconds() === Number(second) &&
    date.getUTCMilliseconds() === Number(ms)
  );
}

/** ISO-8601 UTC, milliseconds, `Z`-terminated — the house timestamp format. */
const IsoUtcTimestamp = z
  .string()
  .refine((value) => ISO_UTC_PATTERN.test(value), {
    message: 'must be an ISO-8601 UTC timestamp ending in Z',
  })
  .refine(isRealUtcInstant, {
    message: 'must name a date that exists',
  });

/**
 * The manifest shape.
 *
 * `.strict()` on purpose: an unknown key means a newer writer added something,
 * and silently dropping it on read could discard a worktree path that story
 * 3.2 needs in order to clean up. Fail closed and say so.
 */
export const RunManifestSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    runId: z.string().refine(isRunId, { message: 'must be a canonical run id' }),
    createdAt: IsoUtcTimestamp,
    /** The epic under verification, or null for a run not tied to one. */
    epic: z.string().min(1).nullable(),
    /** Detached worktree paths to remove on teardown. Populated in story 3.2. */
    worktrees: z.array(z.string().min(1)),
    /** Process-group ids to kill on teardown. Populated in story 3.2. */
    processGroups: z.array(z.number().int()),
    /** Set once teardown has reaped this run's resources. Story 3.2. */
    reaped: z.boolean(),
  })
  .strict();

export type RunManifest = z.infer<typeof RunManifestSchema>;

/** Everything needed to mint a skeleton. */
export interface NewRunManifestInput {
  readonly runId: string;
  readonly createdAt: Date;
  readonly epic?: string | undefined;
}

/**
 * Builds the AC1 skeleton.
 *
 * `epic` is written as an explicit `null` when absent rather than omitted: the
 * manifest is read back by a later version of this tool, and an absent key is
 * indistinguishable from a key an older writer never knew about.
 */
export function newRunManifest(input: NewRunManifestInput): RunManifest {
  return {
    schemaVersion: RUN_MANIFEST_VERSION,
    runId: input.runId,
    // Full millisecond precision, unlike the run id's whole seconds.
    createdAt: input.createdAt.toISOString(),
    epic: input.epic ?? null,
    worktrees: [],
    processGroups: [],
    reaped: false,
  };
}

/**
 * Parses manifest text, applying the version policy.
 *
 * Always throws `InfraError` naming `path` — never returns undefined and never
 * throws bare. A corrupt manifest is an environment problem (exit 3), and it
 * matters: the run it describes may still own a worktree or a live process
 * group, so treating the file as absent would leak those resources silently.
 */
export function parseRunManifest(text: string, path: string): RunManifest {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    throw new InfraError(
      `run manifest is not valid JSON: ${path}`,
      'the file is corrupt; the run it describes may still own a worktree or a process group, so inspect it before deleting',
    );
  }

  // Read the version BEFORE the full parse, so a manifest from the future
  // produces "upgrade specwitness" rather than a confusing list of shape
  // errors caused by fields this build has never heard of.
  if (typeof json === 'object' && json !== null && 'schemaVersion' in json) {
    const version = (json as { schemaVersion: unknown }).schemaVersion;
    if (typeof version === 'number' && version > RUN_MANIFEST_VERSION) {
      // The spec requires the ERROR line itself to say a newer specwitness
      // wrote it — that is the *what*, not the remedy, so it does not belong
      // in the HINT alone.
      throw new InfraError(
        `run manifest at ${path} was written by a newer specwitness (schemaVersion ${version}, this build understands ${RUN_MANIFEST_VERSION})`,
        'upgrade specwitness to read this run; do not delete it',
      );
    }
  }

  const result = RunManifestSchema.safeParse(json);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new InfraError(
      `run manifest is malformed: ${path} (${detail})`,
      'the file does not match the expected run-manifest shape; it may have been edited by hand',
    );
  }

  return result.data;
}
