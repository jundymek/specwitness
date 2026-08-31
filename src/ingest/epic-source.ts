/**
 * The reader seam (architecture question Q4).
 *
 * Q4 is binding and answers the "what about non-BMAD specs" question in these
 * words: "additional `ingest/` readers implementing the same
 * `EpicSource -> EpicSpec` interface; no other layer changes." This module is
 * that interface. Both BMAD v6 readers implement it, and `ingestEpic` merges
 * their results without knowing which is which — so a third reader is a new
 * file here, not an edit to the merge or to anything downstream.
 *
 * A reader reports; it does not judge. It returns what it found and what it
 * looked at, including the cases where it found nothing. The AC3 rules ("an
 * epic with zero stories is an error", "a story with zero criteria is an
 * error") are applied ONCE, after the merge, by `ingestEpic` — because whether
 * a story is empty can only be known after per-story files have had their
 * chance to supersede the epics file.
 */

import type { AcceptanceCriterion, SourceRef } from '../domain/epic-spec.js';

/** What a reader is asked to find. */
export interface EpicSourceRequest {
  /** Absolute, already-resolved project root. */
  readonly projectRoot: string;
  /** The epic number to match on. Full-number match, never a prefix. */
  readonly epicNumber: number;
  /** Canonical epic id (`epic-7`), for messages. */
  readonly epicId: string;
  /**
   * The configured artifact root this reader reads, relative to `projectRoot`
   * and forward-slashed. Readers join it themselves so every path they report
   * is repo-relative by construction.
   */
  readonly rootLabel: string;
}

/**
 * A story as one source saw it, BEFORE the non-emptiness rule is applied.
 *
 * Structurally an `EpicStory` except that `acceptanceCriteria` may be empty:
 * that is a finding to report, not a shape to forbid here.
 */
export interface ReadStory {
  readonly id: string;
  readonly title: string;
  readonly narrative: string;
  /** May be empty. `ingestEpic` turns a surviving empty story into an error. */
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly source: SourceRef;
}

/** What one reader found, and what it looked at to find it. */
export interface EpicSourceReading {
  /** Epic title, when this source carries one. */
  readonly title?: string;
  /** Epic goal, when this source carries one. */
  readonly goal?: string;
  /** Where the epic itself was declared, when this source declared it. */
  readonly epicSource?: SourceRef;
  /** Stories found, in source order. */
  readonly stories: readonly ReadStory[];
  /**
   * Every path this reader actually looked at, repo-relative. This is what
   * makes an AC3 error able to say WHERE it searched rather than just "not
   * found" — so these must be recorded even (especially) when nothing matched.
   */
  readonly searched: readonly string[];
  /** What was found instead: "exists but contains no '## Epic 7'", and so on. */
  readonly notes: readonly string[];
  /**
   * Artifact content that claims to be a story but could not be parsed.
   *
   * Distinct from `notes`, which describe an absence. A problem is a positive
   * statement in the artifact that this reader could not honour — a
   * `### Story 8.1` heading sitting under `## Epic 7`, say. Ingestion refuses
   * outright when any is present: silently returning the subset it COULD parse
   * would drop acceptance criteria from the contract without anyone noticing,
   * which is precisely the fail-open behaviour AC3 forbids.
   */
  readonly problems?: readonly string[];
}

/** A source of epics. One per planning-artifact format. */
export interface EpicSource {
  /** Stable identifier for messages, e.g. `bmad-v6:epics-file`. */
  readonly id: string;
  read(request: EpicSourceRequest): EpicSourceReading;
}
