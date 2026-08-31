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

import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { AcceptanceCriterion, EpicSpec, EpicStory, SourceRef } from '../domain/epic-spec.js';
import { ConfigError, IngestError } from '../domain/errors.js';
import { normalizeEpicId } from '../domain/ids.js';
import { schemaVersionFor } from '../schemas/versions.js';

import { readEpicsFile } from './bmad-v6/epics-file.js';
import { epicDirectoryPattern, readStoryFiles } from './bmad-v6/story-files.js';
import type { EpicSourceReading, ReadStory } from './epic-source.js';

export type {
  EpicSource,
  EpicSourceReading,
  EpicSourceRequest,
  ReadStory,
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

  const fromEpicsFile = readEpicsFile({
    projectRoot,
    epicNumber,
    epicId: canonicalId,
    rootLabel: planningRoot,
  });
  const fromStoryFiles = readStoryFiles({
    projectRoot,
    epicNumber,
    epicId: canonicalId,
    rootLabel: implementationRoot,
  });

  const stories = merge(fromEpicsFile, fromStoryFiles);

  if (stories.length === 0) {
    throw notFound(canonicalId, epicNumber, implementationRoot, fromEpicsFile, fromStoryFiles);
  }

  assertEveryStoryHasCriteria(canonicalId, stories);

  return {
    schemaVersion: schemaVersionFor('epicSpec'),
    id: canonicalId,
    epicNumber,
    title: fromEpicsFile.title ?? '',
    goal: fromEpicsFile.goal ?? '',
    stories: stories as readonly EpicStory[],
    source: fromEpicsFile.epicSource ?? (fromStoryFiles.epicSource as SourceRef),
  };
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

  return relative(projectRoot, resolved).split(sep).join('/');
}

/**
 * The real path of `candidate`, or undefined when it does not exist.
 *
 * A root that is not there yet is a finding for the readers to report ("this
 * directory does not exist"), not a config fault — so its absence must not
 * become a `ConfigError` here.
 */
function realPathOrUndefined(candidate: string): string | undefined {
  try {
    return realpathSync(candidate);
  } catch {
    return undefined;
  }
}

function assertInside(root: string, candidate: string, configured: string, key: string): void {
  if (candidate === root || candidate.startsWith(root + sep)) return;

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
function merge(fromEpicsFile: EpicSourceReading, fromStoryFiles: EpicSourceReading): ReadStory[] {
  const byId = new Map<string, ReadStory>();

  for (const story of fromEpicsFile.stories) byId.set(story.id, story);
  for (const story of fromStoryFiles.stories) byId.set(story.id, story);

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
function notFound(
  canonicalId: string,
  epicNumber: number,
  implementationRoot: string,
  fromEpicsFile: EpicSourceReading,
  fromStoryFiles: EpicSourceReading,
): IngestError {
  const searched = [
    ...fromEpicsFile.searched,
    ...fromStoryFiles.searched,
    `${implementationRoot}/${epicDirectoryPattern(epicNumber)}`,
  ];
  const notes = [...fromEpicsFile.notes, ...fromStoryFiles.notes];

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
