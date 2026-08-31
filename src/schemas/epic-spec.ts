/**
 * AD-5 — the zod mirror of `src/domain/epic-spec.ts`.
 *
 * The domain module is plain TypeScript (AD-1: it may not import zod), so the
 * runtime shape lives here. `satisfies z.ZodType<EpicSpec>` at the bottom is
 * what stops the two drifting: change a field in the domain interface without
 * changing it here and `pnpm typecheck` fails.
 *
 * The non-emptiness rules below are the AC3 "no empty EpicSpec" guarantee
 * expressed as data rather than as a comment. Ingestion throws an `IngestError`
 * naming what was searched BEFORE it ever gets here — this schema is the
 * belt-and-braces layer that makes an empty spec unconstructible even by a
 * future caller that skips the reader.
 */

import { z } from 'zod';

import type { EpicSpec } from '../domain/epic-spec.js';

import { schemaVersionFor } from './versions.js';

/** Mirrors `IngestLayout`. Closed: a new layout is a deliberate addition. */
export const ingestLayoutSchema = z.enum(['epics-file', 'story-file']);

/**
 * Mirrors `SourceRef`.
 *
 * The path check is a real invariant, not a formality: an absolute path here
 * would make the same epic on two machines produce two different EpicSpecs, so
 * a spec would stop being diffable exactly when someone needs to diff it.
 */
export const sourceRefSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .refine((value) => !value.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value), {
      message: 'source path must be relative to the project root, not absolute',
    })
    .refine((value) => !value.includes('\\'), {
      message: 'source path must use forward slashes so it is portable across platforms',
    }),
  line: z.int().min(1),
  layout: ingestLayoutSchema,
});

/** Mirrors `AcceptanceCriterion`. */
export const acceptanceCriterionSchema = z.strictObject({
  ordinal: z.int().min(1),
  // A criterion with no text is the zero-criteria bug wearing a disguise.
  text: z.string().min(1),
  source: sourceRefSchema,
});

/** Mirrors `EpicStory`. A story with zero criteria cannot be represented. */
export const epicStorySchema = z.strictObject({
  id: z.string().min(1),
  title: z.string(),
  narrative: z.string(),
  acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1),
  source: sourceRefSchema,
});

/**
 * Mirrors `EpicSpec`. An epic with zero stories cannot be represented.
 *
 * `title` and `goal` are deliberately allowed to be empty: an epic present only
 * as per-story files has neither, and inventing one from a directory slug would
 * be this product fabricating content. Empty says "absent"; a real title never
 * is.
 */
export const epicSpecSchema = z.strictObject({
  schemaVersion: z.int().min(1),
  id: z.string().min(1),
  epicNumber: z.int().min(1),
  title: z.string(),
  goal: z.string(),
  stories: z.array(epicStorySchema).min(1),
  source: sourceRefSchema,
}) satisfies z.ZodType<EpicSpec, unknown>;

/** The version stamped onto every EpicSpec this build produces. */
export const EPIC_SPEC_SCHEMA_VERSION = schemaVersionFor('epicSpec');
