/**
 * BMAD v6 layout (a): the epics file.
 *
 * `<planningArtifacts>/epics.md`, structured as
 *
 *     ## Epic 7: Title
 *     <goal paragraph>
 *     ### Story 7.1: Title
 *     <narrative>
 *     **Acceptance Criteria:**
 *     <blank-line-separated Given/When/Then blocks>
 *     ---
 *
 * The first client's own `docs/planning-artifacts/epics.md` is the reference
 * specimen and the parser was written against it.
 *
 * Everything BMAD-specific stops here (question Q2). This module reports what
 * the file says and what it looked at; it decides nothing about whether the
 * result is acceptable.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { AcceptanceCriterion, SourceRef } from '../../domain/epic-spec.js';
import type {
  EpicSource,
  EpicSourceReading,
  EpicSourceRequest,
  ReadStory,
} from '../epic-source.js';

import { realPathOrUndefined, repoPath } from '../repo-path.js';

import type { MarkdownDoc } from './markdown.js';
import {
  extractCriteria,
  headingText,
  joinTrimmed,
  readMarkdown,
  sectionEnd,
} from './markdown.js';

/** The file name this layout always uses, relative to the planning root. */
export const EPICS_FILE_NAME = 'epics.md';

/**
 * `## Epic <n>: <title>`.
 *
 * The number is captured and compared NUMERICALLY, never matched as a prefix:
 * `## Epic 1:` must not answer a request for epic 10, and `## Epic 7:` must not
 * answer a request for epic 70. The title separator is optional so an epic
 * heading without one still yields the epic (with an empty title) rather than
 * disappearing.
 */
const EPIC_HEADING = /^Epic\s+(\d+)\s*(?:[:.–—-]\s*(.*))?$/;

/** `### Story <n>.<m>: <title>`, with the same full-number discipline. */
const STORY_HEADING = /^Story\s+(\d+)\.(\d+)\s*(?:[:.–—-]\s*(.*))?$/;

/** A heading asserting that a story lives here, however it is then spelled. */
const CLAIMS_TO_BE_A_STORY = /^Story\b/i;

/** The line that opens a criteria block in this layout. */
const CRITERIA_MARKER = /^\*\*Acceptance Criteria:?\*\*:?\s*$/i;

/**
 * Reads one epic out of the epics file.
 *
 * Never throws for "not found" — an absent file, an absent epic and an epic
 * with no stories are all findings, reported through `searched` and `notes` so
 * that `ingestEpic` can name every path it consulted in one message. It throws
 * only when a file exists but cannot be read (`IngestError`, via
 * `readMarkdownLines`), because that is a genuine failure rather than an
 * answer.
 */
export function readEpicsFile(request: EpicSourceRequest): EpicSourceReading {
  const relativePath = repoPath(request.rootLabel, EPICS_FILE_NAME);
  const rootPath = join(request.projectRoot, request.rootLabel);
  const absolutePath = join(rootPath, EPICS_FILE_NAME);
  const searched = [relativePath];

  if (!existsSync(absolutePath)) {
    return { stories: [], searched, notes: [`${relativePath} does not exist`] };
  }

  const doc = readMarkdown(absolutePath, relativePath, realPathOrUndefined(rootPath));
  const { lines } = doc;
  const epicIndex = findEpicHeading(doc, request.epicNumber);

  if (epicIndex === undefined) {
    return {
      stories: [],
      searched,
      notes: [
        `${relativePath} exists but contains no '## Epic ${request.epicNumber}' heading` +
          describeEpicsPresent(doc),
      ],
    };
  }

  const epicEnd = sectionEnd(doc, epicIndex + 1, 2);
  const title = headingText(lines[epicIndex] as string, 2) ?? '';
  const epicTitle = EPIC_HEADING.exec(title)?.[2]?.trim() ?? '';

  const problems: string[] = [];
  const storyStarts = findStoryHeadings(
    doc,
    epicIndex + 1,
    epicEnd,
    request.epicNumber,
    relativePath,
    problems,
  );
  const goalEnd = storyStarts[0]?.index ?? epicEnd;

  const stories = storyStarts.map((start, position) =>
    readStory(
      doc,
      start,
      storyStarts[position + 1]?.index ?? epicEnd,
      relativePath,
    ),
  );

  reportDuplicateIds(stories, relativePath, problems);

  const notes: string[] = [];
  if (stories.length === 0) {
    notes.push(`${relativePath} declares '## Epic ${request.epicNumber}' but no '### Story' under it`);
  }

  return {
    title: epicTitle,
    goal: joinTrimmed(lines, epicIndex + 1, goalEnd),
    epicSource: { path: relativePath, line: epicIndex + 1, layout: 'epics-file' },
    stories,
    searched,
    notes,
    problems,
  };
}

/** The epics file as an `EpicSource` (question Q4's seam). */
export const epicsFileSource: EpicSource = {
  id: 'bmad-v6:epics-file',
  read: readEpicsFile,
};

/** Index of the `## Epic <n>` heading for exactly `epicNumber`. */
function findEpicHeading(doc: MarkdownDoc, epicNumber: number): number | undefined {
  for (let index = 0; index < doc.lines.length; index += 1) {
    if (doc.fenced[index] === true) continue;
    const text = headingText(doc.lines[index] as string, 2);
    if (text === undefined) continue;
    const match = EPIC_HEADING.exec(text);
    if (match !== null && Number(match[1]) === epicNumber) return index;
  }
  return undefined;
}

interface StoryStart {
  readonly index: number;
  readonly id: string;
  readonly title: string;
}

/**
 * The `### Story <epic>.<m>` headings inside `[start, end)`.
 *
 * A level-3 heading that is not about a story at all (`### Notes`) is simply not
 * a story and is skipped. But a heading that CLAIMS to be a story and cannot be
 * parsed — a malformed number, or a `### Story 8.1` sitting under `## Epic 7` —
 * is recorded as a problem, and ingestion then refuses. Skipping it would
 * succeed with a partial EpicSpec, dropping that story's acceptance criteria
 * from the contract silently; the whole point of this gate is that a criterion
 * cannot go missing without anyone being told.
 */
function findStoryHeadings(
  doc: MarkdownDoc,
  start: number,
  end: number,
  epicNumber: number,
  relativePath: string,
  problems: string[],
): StoryStart[] {
  const starts: StoryStart[] = [];
  for (let index = start; index < end; index += 1) {
    if (doc.fenced[index] === true) continue;
    const text = headingText(doc.lines[index] as string, 3);
    if (text === undefined) continue;

    const match = STORY_HEADING.exec(text);
    if (match === null) {
      if (CLAIMS_TO_BE_A_STORY.test(text)) {
        problems.push(
          `${relativePath}:${index + 1}: '### ${text}' looks like a story heading but is not ` +
            `'### Story <epic>.<story>: <title>'`,
        );
      }
      continue;
    }

    if (Number(match[1]) !== epicNumber) {
      problems.push(
        `${relativePath}:${index + 1}: '### ${text}' is inside '## Epic ${epicNumber}' but ` +
          `names epic ${match[1]}`,
      );
      continue;
    }

    starts.push({
      index,
      id: `${match[1]}.${match[2]}`,
      title: (match[3] ?? '').trim(),
    });
  }
  return starts;
}

function readStory(
  doc: MarkdownDoc,
  start: StoryStart,
  end: number,
  relativePath: string,
): ReadStory {
  const { lines } = doc;
  const criteriaMarker = findCriteriaMarker(doc, start.index + 1, end);
  const narrativeEnd = criteriaMarker ?? end;

  const criteria: AcceptanceCriterion[] =
    criteriaMarker === undefined
      ? []
      : extractCriteria(doc, criteriaMarker + 1, end).map((scanned, position) => ({
          ordinal: position + 1,
          text: scanned.text,
          source: sourceRef(relativePath, scanned.index),
        }));

  return {
    id: start.id,
    title: start.title,
    narrative: joinTrimmed(lines, start.index + 1, narrativeEnd),
    acceptanceCriteria: criteria,
    source: sourceRef(relativePath, start.index),
  };
}

/**
 * The same `### Story 7.1` heading twice inside one epic is ambiguous.
 *
 * The merge keeps the last one, which would make the contract depend on
 * document order and drop the other heading's acceptance criteria silently.
 * Cross-SOURCE precedence is deliberate — a per-story file supersedes the epics
 * file — but within one document there is no rule saying which wins, so there
 * must not be a silent one.
 */
function reportDuplicateIds(
  stories: readonly ReadStory[],
  relativePath: string,
  problems: string[],
): void {
  const seen = new Set<string>();
  for (const story of stories) {
    if (seen.has(story.id)) {
      problems.push(`${relativePath}:${story.source.line}: story ${story.id} is declared twice`);
      continue;
    }
    seen.add(story.id);
  }
}

function findCriteriaMarker(doc: MarkdownDoc, start: number, end: number): number | undefined {
  for (let index = start; index < end; index += 1) {
    if (doc.fenced[index] === true) continue;
    if (CRITERIA_MARKER.test((doc.lines[index] as string).trim())) return index;
  }
  return undefined;
}

function sourceRef(path: string, index: number): SourceRef {
  return { path, line: index + 1, layout: 'epics-file' };
}

/**
 * "…and here is what it DOES contain."
 *
 * AC3 asks the error to say what was found instead. Listing the epics the file
 * actually declares turns "epic 7 not found" into a diagnosis — usually "you
 * meant 6" or "you are pointed at the wrong repository".
 */
function describeEpicsPresent(doc: MarkdownDoc): string {
  const present: string[] = [];
  for (const [index, line] of doc.lines.entries()) {
    if (doc.fenced[index] === true) continue;
    const text = headingText(line, 2);
    if (text === undefined) continue;
    const match = EPIC_HEADING.exec(text);
    if (match !== null) present.push(match[1] as string);
  }
  return present.length === 0
    ? ' (it declares no epics at all)'
    : ` (it declares epics: ${present.join(', ')})`;
}
