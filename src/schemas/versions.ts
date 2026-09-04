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
 *   - Epic 3 adds `jsonReport` (story 3.5 — done)
 *   - Epic 5 adds `explanation` (story 5.5) and `adaptation` (story 5.6)
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

  /**
   * The persisted run report, `.specwitness/runs/<run-id>/result.json`
   * (story 3.5). A SEPARATE artifact from `runManifest` above, with its own
   * version: the manifest is the crash-recovery record written before any
   * resource exists, this is the finished result written atomically at the end.
   * Story 3.2 populating the manifest's reserved arrays does not bump
   * `runManifest`, and registering this key does not touch it either — every
   * manifest written before Epic 3 stays readable after it.
   *
   * This is the number FR-30's harness contract is versioned by: `--json`
   * stdout and this file are the same bytes (AD-11), so a consumer that can
   * read one can read the other.
   */
  jsonReport: 1,

  /**
   * The Verification Contract document (`.specwitness/contracts/<epic>.yaml`),
   * story 2.2. Version 1 already carries `meta.history` and `meta.provenance`
   * so that story 2.7's amend flow and story 2.6's provenance recording are
   * additive rather than a migration.
   *
   * This number lives in `meta`, never in `spec` — bumping it must not change
   * the fingerprint of semantically unchanged content, or every frozen
   * contract in existence would report tampering the day the schema evolves.
   */
  contract: 1,

  /**
   * The compiled Verification Plan (`.specwitness/plans/<epic>.yaml`), story
   * 4.2. The reserved key this file's header has named since story 1.2.
   *
   * Version 1 already carries the deterministic-data block (seed + bindings,
   * AD-9) and the full four-surface probe union including `browser`, so
   * story 4.3 filling in data semantics and Epic 5 implementing the browser
   * executor are additive rather than migrations.
   *
   * Unlike `contract`, this number gates NOTHING that is fingerprinted: a plan
   * is not hashed, and its integrity question is "was it compiled from this
   * contract", answered by the contract fingerprint it stores.
   */
  plan: 1,

  /**
   * The explainer payload contract, story 5.5 — the shape of an `explainer` provider's
   * response AND of the `explanations` array a run persists from it.
   *
   * The one-line addition this file's header promises. It is registered here for the same
   * reason `epicSpec` is registered while nothing writes one to disk: the seam is
   * versioned from the day it exists, so the day the payload grows a field there is
   * already a number to move.
   *
   * NOTE WHAT DID NOT MOVE. `jsonReport` above is UNCHANGED. Story 5.5 adds one optional
   * key (`explanations`) to the persisted run document, which is the additive case this
   * file describes — every `result.json` written before it still parses, asserted in
   * `tests/unit/schemas/result-explanation.test.ts`. The repo's precedent is commit
   * `ec23ce1` (the optional stage `hint`), story 5.3's `needsHumanReason` /
   * `reviewerGuidance`, and story 5.4's `flakiness`; none of them bumped it either.
   */
  explanation: 1,

  /**
   * The mechanics-adaptation payload a provider returns under `--adapt`
   * (`src/schemas/adaptation.ts`), story 5.6.
   *
   * NOT a persisted artifact: nothing writes an adaptation payload to disk, and
   * the adapted plan is an in-memory COPY that is deliberately never written
   * back (`.specwitness/plans/<epic>.yaml` stays byte-identical across an
   * adapted run). It is registered here anyway for the reason `epicSpec` is —
   * the seam is versioned from day one, because the day the permitted mechanics
   * surface changes, the shape must already be identifiable.
   *
   * Version 1 accepts `path` and `scenario` and NOTHING else. Widening it is a
   * change to what a provider may alter at runtime, which is an ADR and an
   * AD-2 conversation, never a routine bump.
   */
  adaptation: 1,
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
