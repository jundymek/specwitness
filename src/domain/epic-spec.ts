/**
 * FR-6 — the normalized EpicSpec: the ingestion-plugin seam.
 *
 * Everything downstream of ingestion — contract generation today, a Cursor or
 * CI reader one day — consumes THIS and nothing else. No BMAD type, no markdown
 * type, no file handle crosses the boundary, which is what makes "add a second
 * source" mean "add a reader" rather than "edit contract logic" (question Q4).
 * `.dependency-cruiser.cjs`'s `ingest-core-only` rule enforces the other half of
 * that promise: BMAD-specific types never leave `src/ingest/`.
 *
 * An EpicSpec is a REPORT, not an interpretation. Its job is to say what the
 * planning artifacts say, with enough provenance that a human can go and check.
 * That is why acceptance-criterion text is verbatim and why every element
 * carries the file and line it came from: a silently reworded criterion is the
 * exact "correlated misunderstanding" this product exists to catch.
 *
 * AD-1: this module imports NOTHING — not a sibling, not zod, not a Node
 * built-in. The zod mirror lives in `src/schemas/epic-spec.ts`.
 *
 * AD-5: `schemaVersion` is carried from the registry. Nothing persists an
 * EpicSpec to disk in V0 (it is an in-memory value handed straight to contract
 * generation), but the version is part of the contract from day one so that the
 * day something does persist one, it is already readable.
 */

/** Which BMAD v6 layout a piece of the spec was read from. */
export type IngestLayout =
  /** `<planningArtifacts>/epics.md`. */
  | 'epics-file'
  /** `<implementationArtifacts>/epic-<n>-<slug>/<task-id>.md`. */
  | 'story-file';

/**
 * Where a piece of an EpicSpec came from.
 *
 * `path` is relative to the project root passed into ingestion and always uses
 * forward slashes, so an EpicSpec is portable between machines and diffable
 * between runs. An absolute path here would make two runs of the same epic on
 * two machines produce different specs.
 */
export interface SourceRef {
  /** Repo-relative, forward-slashed path of the file this came from. */
  readonly path: string;
  /** 1-based line where this element starts. */
  readonly line: number;
  /** Which layout supplied it — this is how "which source won" is recorded. */
  readonly layout: IngestLayout;
}

/**
 * One acceptance criterion, verbatim.
 *
 * "Verbatim" is exact: the text is what the artifact says, minus only the list
 * marker, its continuation indent, and surrounding whitespace. No case folding,
 * no punctuation or whitespace normalization, no reflow, no Unicode
 * normalization. A multi-line criterion keeps its line breaks as `\n`.
 *
 * Deliberately NOT carried: a canonical criterion id (`E7-01`). Minting those is
 * a contract concern — the sequence is assigned in draft order across the whole
 * epic, which ingestion neither knows nor should. `buildCriterionId` in
 * `./ids.ts` is the one implementation, and story 2.6 calls it. The stable
 * handle into a criterion from here is `EpicStory.id` + `ordinal` + `source`.
 */
export interface AcceptanceCriterion {
  /** 1-based position within its own story, in source order. */
  readonly ordinal: number;
  /** The criterion exactly as written. Never empty. */
  readonly text: string;
  readonly source: SourceRef;
}

/** One story of an epic, with its acceptance criteria. */
export interface EpicStory {
  /** Task id exactly as written in the artifact, e.g. `7.1` or `7.10`. */
  readonly id: string;
  /** Story title from its heading. */
  readonly title: string;
  /**
   * The "As a … / I want … / so that …" narrative, verbatim. Empty when the
   * artifact carries no narrative — this is reported, never invented.
   */
  readonly narrative: string;
  /** At least one. A story with none is an IngestError, not an empty array. */
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  /** Where the story was read from — and therefore which layout won for it. */
  readonly source: SourceRef;
}

/**
 * One epic, normalized.
 *
 * `stories` is ordered numerically by task id, so `7.10` follows `7.9` rather
 * than `7.1`. Lexicographic ordering here would silently reorder any epic that
 * reaches ten stories.
 */
export interface EpicSpec {
  /** From `SCHEMA_VERSIONS.epicSpec` (AD-5). */
  readonly schemaVersion: number;
  /** Canonical epic id from `normalizeEpicId`, e.g. `epic-7`. */
  readonly id: string;
  /** The epic number, e.g. `7`. Feeds `buildCriterionId` downstream. */
  readonly epicNumber: number;
  /**
   * Epic title. Empty when the epic exists only as per-story files, which
   * carry no epic title — absence is reported, not fabricated from a slug.
   */
  readonly title: string;
  /** Epic goal paragraph. Empty for the same reason as `title`. */
  readonly goal: string;
  /** At least one. Ordered numerically by task id. */
  readonly stories: readonly EpicStory[];
  /**
   * Where the epic itself was declared: the `## Epic <n>` heading when an epics
   * file supplied it, otherwise the per-story directory that was found.
   */
  readonly source: SourceRef;
}
