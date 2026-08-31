/**
 * FR-5 / FR-6 — the public ingestion entry point.
 *
 * `ingestEpic` locates one epic in a project's BMAD v6 planning artifacts and
 * returns a normalized `EpicSpec`. It is a plain function over explicit
 * arguments: no class, no builder, no module-level cache, and it does not load
 * config — story 2.6 calls `loadConfig` at the CLI edge and passes the two
 * roots in. That keeps ingestion testable without a config file and keeps the
 * "roots come from config, never from a constant" rule (question Q1) true by
 * construction, since there is no constant here to fall back to.
 *
 * It reads files and does nothing else: no subprocess, no network, no
 * environment reads, no writes, and nothing outside the two configured roots
 * under the given project root. NFR-1 is satisfied trivially — the home
 * directory is never touched.
 *
 * Fail closed, then explain: an epic that cannot be found, an epic with no
 * stories, and a story with no acceptance criteria are all `IngestError`
 * (exit 3) naming every path that was searched. An empty `EpicSpec` is never
 * returned, because an empty spec downstream becomes an empty contract, and an
 * empty contract silently passes every future verification run.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { AcceptanceCriterion, EpicSpec, EpicStory, SourceRef } from '../domain/epic-spec.js';
import { ConfigError, IngestError } from '../domain/errors.js';
import { normalizeEpicId } from '../domain/ids.js';
import { schemaVersionFor } from '../schemas/versions.js';

import { bmadV6Sources } from './bmad-v6/index.js';
import type { EpicSourceReading, ReadStory, ResolvedSource } from './epic-source.js';
import { isInside, realPathOrUndefined, repoPath } from './repo-path.js';

export type {
  EpicSource,
  EpicSourceReading,
  EpicSourceRequest,
  ReadStory,
  ResolvedSource,
} from './epic-source.js';

/** Everything ingestion needs. Roots are repo-relative and come from config. */
export interface IngestInput {
  /** Project root. Relative paths in the result are relative to this. */
  readonly projectRoot: string;
  /** Raw user input — `7`, `epic-7` and `epic-07` all mean the same epic. */
  readonly epicId: string;
  /** `config.planning.planningArtifacts`. */
  readonly planningArtifacts: string;
  /** `config.planning.implementationArtifacts`. */
  readonly implementationArtifacts: string;
}

const HINT =
  'check the epic number, and check planning.planningArtifacts / ' +
  'planning.implementationArtifacts in .specwitness/config.yaml';

/**
 * Reads one epic into an `EpicSpec`.
 *
 * Throws `UsageError` (exit 64) on a malformed epic id — that is
 * `normalizeEpicId`'s judgement, not ours; `ConfigError` (exit 3) when a
 * configured root escapes the project root; and `IngestError` (exit 3) when the
 * artifacts cannot yield a non-empty epic.
 */
export function ingestEpic(input: IngestInput): EpicSpec {
  const canonicalId = normalizeEpicId(input.epicId);
  const epicNumber = Number(canonicalId.slice('epic-'.length));
  const projectRoot = resolve(input.projectRoot);

  const planningRoot = containedRoot(
    projectRoot,
    input.planningArtifacts,
    'planning.planningArtifacts',
  );
  const implementationRoot = containedRoot(
    projectRoot,
    input.implementationArtifacts,
    'planning.implementationArtifacts',
  );

  // The orchestrator knows nothing about BMAD: it folds whatever ordered source
  // list it is given. Swapping in a second format is a new directory beside
  // `bmad-v6/` and a different list here — never an edit to the merge, and
  // never anything downstream (FR-6, question Q4).
  const readings = readAll(bmadV6Sources(planningRoot, implementationRoot), {
    projectRoot,
    epicNumber,
    epicId: canonicalId,
  });

  assertNoUnparseableArtifacts(canonicalId, readings);

  const stories = merge(readings);

  if (stories.length === 0) {
    throw notFound(canonicalId, readings);
  }

  assertEveryStoryHasCriteria(canonicalId, stories);

  // One rule for all three identity fields: the epic's title, goal and point of
  // declaration come from the FIRST source in the list that provides them.
  // Precedence order runs from the broadest artifact (which declares the epic)
  // to the most detailed (which elaborates individual stories), so the earliest
  // reading is the one that actually says what this epic IS. Story CONTENT goes
  // the other way — later sources supersede — which is why the two are separate
  // rules rather than one.
  const describing = readings;

  return {
    schemaVersion: schemaVersionFor('epicSpec'),
    id: canonicalId,
    epicNumber,
    title: describing.find((reading) => reading.title !== undefined)?.title ?? '',
    goal: describing.find((reading) => reading.goal !== undefined)?.goal ?? '',
    stories,
    // The final fallback cannot be reached with a non-empty story list, but
    // pointing at the first story is a truthful answer rather than a cast that
    // would let `undefined` through if that ever changed.
    source:
      describing.find((reading) => reading.epicSource !== undefined)?.epicSource ??
      (stories[0] as EpicStory).source,
  };
}

/** Runs every source in order, keeping their readings in the same order. */
function readAll(
  sources: readonly ResolvedSource[],
  request: { projectRoot: string; epicNumber: number; epicId: string },
): readonly EpicSourceReading[] {
  return sources.map(({ source, rootLabel }) => source.read({ ...request, rootLabel }));
}

/**
 * Resolves a configured root and refuses one that escapes the project.
 *
 * A `ConfigError` rather than an `IngestError` on purpose: the fault is in
 * `.specwitness/config.yaml`, not in the planning artifacts. Both map to
 * exit 3, but `INFRA_ERROR_CLASSIFICATIONS` carries `config` and `ingest` as
 * distinct values that surface in run metadata and in doctor — misclassifying
 * sends the user to re-check the wrong thing entirely.
 *
 * The rule is about where a root LANDS, not about which characters spell it: a
 * `..` segment that resolves back inside the project reads nothing outside and
 * is accepted. Containment is checked twice — once lexically, and once against
 * the real path when the root exists, because `resolve` is purely textual and a
 * symlinked root would otherwise walk straight out of the project.
 *
 * Returns the root as a repo-relative, forward-slashed label, which is what the
 * readers use to build portable `SourceRef` paths.
 */
function containedRoot(projectRoot: string, configured: string, key: string): string {
  const resolved = isAbsolute(configured) ? resolve(configured) : resolve(projectRoot, configured);
  assertInside(projectRoot, resolved, configured, key);

  const realRoot = realPathOrUndefined(resolved);
  if (realRoot !== undefined && realRoot !== resolved) {
    assertInside(realPathOrUndefined(projectRoot) ?? projectRoot, realRoot, configured, key);
  }

  // `repoPath` rather than raw interpolation: a root of `.` makes `relative`
  // return the empty string, and `${''}/epics.md` is `/epics.md` — a path that
  // reads correctly but looks absolute, so it is neither portable nor accepted
  // by `sourceRefSchema`.
  return repoPath(relative(projectRoot, resolved).split(sep).join('/'));
}

function assertInside(root: string, candidate: string, configured: string, key: string): void {
  if (isInside(root, candidate)) return;

  throw new ConfigError(
    `${key}: '${configured}' resolves to ${candidate}, which is outside the project root ${root}`,
    `set ${key} to a path inside the project — artifact roots may not escape it`,
  );
}

/**
 * AC2's precedence rule: per-story files win for the stories they cover.
 *
 * They are the later, more detailed artifact — a story file is written when the
 * story is picked up and routinely expands on the epics file's summary. The
 * epics file still supplies every story the per-story files do not cover, so an
 * epic half-way through implementation ingests completely.
 *
 * Ordering is numeric by task id throughout, so `7.10` follows `7.9`.
 */
function merge(readings: readonly EpicSourceReading[]): ReadStory[] {
  const byId = new Map<string, ReadStory>();

  // Readings arrive lowest-precedence first, so a later source simply
  // overwrites the story ids it covers. Ambiguity WITHIN one source is refused
  // before this point, so every overwrite here is a deliberate supersede.
  for (const reading of readings) {
    for (const story of reading.stories) byId.set(story.id, story);
  }

  return [...byId.values()].sort(compareStoryIds);
}

function compareStoryIds(left: ReadStory, right: ReadStory): number {
  const [leftEpic = 0, leftStory = 0] = left.id.split('.').map(Number);
  const [rightEpic = 0, rightStory = 0] = right.id.split('.').map(Number);
  return leftEpic - rightEpic || leftStory - rightStory;
}

/**
 * The AC3 error.
 *
 * "Not found" on its own is a failing implementation of this AC. The message
 * names the canonical epic id, every path both readers actually consulted
 * (expanded, not as a glob), and what was found instead — so the reader can
 * tell "wrong epic number" from "wrong root" from "artifact not written yet"
 * without opening a single file.
 */
function notFound(canonicalId: string, readings: readonly EpicSourceReading[]): IngestError {
  const searched = readings.flatMap((reading) => reading.searched);
  const notes = readings.flatMap((reading) => reading.notes);

  const lines = [
    `${canonicalId}: no stories found in the configured planning artifacts.`,
    'searched:',
    ...unique(searched).map((path) => `  - ${path}`),
  ];
  if (notes.length > 0) {
    lines.push('found instead:', ...unique(notes).map((note) => `  - ${note}`));
  }

  return new IngestError(lines.join('\n'), HINT);
}

/**
 * AC3, fail-closed: artifact content that claims to be a story but cannot be
 * parsed refuses the whole ingest.
 *
 * The tempting alternative — skip the malformed heading and return the stories
 * that DID parse — produces a perfectly plausible EpicSpec that is quietly
 * missing a story and all of its acceptance criteria. That contract then passes
 * verification while the epic it claims to cover is only partly verified, which
 * is the single worst failure this product can have: a green result that means
 * nothing. Refusing is noisy and correct.
 */
function assertNoUnparseableArtifacts(
  canonicalId: string,
  readings: readonly EpicSourceReading[],
): void {
  const problems = readings.flatMap((reading) => reading.problems ?? []);
  if (problems.length === 0) return;

  throw new IngestError(
    [
      `${canonicalId}: the planning artifacts contain content that could not be parsed.`,
      ...problems.map((problem) => `  - ${problem}`),
    ].join('\n'),
    'fix the heading in the planning artifact — SpecWitness refuses to ingest a partial ' +
      'epic, because a contract missing a story silently verifies less than it claims to',
  );
}

/**
 * AC3's other half: an epic found with a story carrying zero criteria is an
 * error, not a successful result with an empty array.
 *
 * A criterion-less story reaches the contract author as a story with nothing to
 * verify, and the contract that comes back passes vacuously. Refusing here is
 * the difference between a verification gate and a rubber stamp.
 */
function assertEveryStoryHasCriteria(canonicalId: string, stories: readonly ReadStory[]): void {
  const empty = stories.filter((story) => story.acceptanceCriteria.length === 0);
  if (empty.length === 0) return;

  const lines = [
    `${canonicalId}: ${empty.length === 1 ? 'a story has' : `${empty.length} stories have`} no acceptance criteria.`,
    ...empty.map((story) => `  - story ${story.id} (${story.source.path}:${story.source.line})`),
  ];

  throw new IngestError(
    lines.join('\n'),
    "add an '## Acceptance Criteria' section to the story, or correct the artifact root — " +
      'SpecWitness will not draft a contract for a story with nothing to verify',
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Re-exported so consumers import the model through the seam they use. */
export type { AcceptanceCriterion, EpicSpec, EpicStory, SourceRef };
