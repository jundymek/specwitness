/**
 * AD-5 — the schema version registry.
 *
 * Every persisted artifact carries a `schemaVersion`, and this is the one place
 * the current version of each is recorded. Versions are integers and evolve
 * ADDITIVELY: bump a number when a shape changes, add a key when a new artifact
 * appears. Never renumber and never remove — a stored run from last week must
 * stay readable.
 *
 * Seeded here by story 1.2 with the artifacts this story actually defines.
 * Later stories register their own with a one-line addition:
 *   - story 1.6 adds `runManifest`
 *   - Epic 2 adds `contract` and `plan`
 *   - Epic 3 adds `jsonReport`
 *
 * Deliberately NOT here: any assert/validate-and-throw helper. What a version
 * MISMATCH means is artifact-specific — a run manifest wants "a newer
 * specwitness wrote this", while a contract may want to migrate, warn, or
 * refuse. A shared helper would quietly freeze one answer for all of them, so
 * the policy lives with each artifact's own schema module.
 */

/**
 * Current schema version of each persisted artifact.
 *
 * `as const` on purpose: adding a key here widens `SchemaVersionKey`
 * automatically, so registering an artifact is a genuine one-line diff and
 * never a two-place edit.
 */
export const SCHEMA_VERSIONS = Object.freeze({
  /**
   * The per-criterion / per-gate result vocabulary defined in `src/domain`
   * and mirrored in `schemas/enums.ts`. Bumping this means the closed
   * taxonomy itself changed — which is an ADR, not a routine edit.
   */
  resultTaxonomy: 1,

  /**
   * The per-run `manifest.json` skeleton written by `RunStore` (story 1.6).
   * Story 3.2 extends it ADDITIVELY with populated worktree paths and pgids;
   * story 3.5 adds the `result.json` finalize. Neither bumps this version,
   * because the reserved arrays are already part of the shape.
   */
  runManifest: 1,

  /**
   * The normalized `EpicSpec` produced by `src/ingest/` (story 2.1). Nothing
   * persists one to disk in V0 — it is handed straight to contract generation —
   * but the seam is versioned from day one, because the day a second ingestion
   * source appears (question Q4) the shape must already be identifiable.
   */
  epicSpec: 1,
} as const satisfies Record<string, number>);

/** Keys of the registry. Derived — never hand-maintained. */
export type SchemaVersionKey = keyof typeof SCHEMA_VERSIONS;

/**
 * Reads a registered schema version.
 *
 * Prefer this over indexing `SCHEMA_VERSIONS` directly so a future bump is one
 * edit in this file and every consumer follows. The key is checked at compile
 * time, so this is total: it cannot throw.
 */
export function schemaVersionFor(key: SchemaVersionKey): number {
  return SCHEMA_VERSIONS[key];
}
