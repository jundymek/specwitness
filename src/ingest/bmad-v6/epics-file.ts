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

import {
  extractCriteria,
  headingText,
  joinTrimmed,
  readMarkdownLines,
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
  const relativePath = `${request.rootLabel}/${EPICS_FILE_NAME}`;
  const absolutePath = join(request.projectRoot, request.rootLabel, EPICS_FILE_NAME);
  const searched = [relativePath];

  if (!existsSync(absolutePath)) {
    return { stories: [], searched, notes: [`${relativePath} does not exist`] };
  }

  const lines = readMarkdownLines(absolutePath, relativePath);
  const epicIndex = findEpicHeading(lines, request.epicNumber);

  if (epicIndex === undefined) {
    return {
      stories: [],
      searched,
      notes: [
        `${relativePath} exists but contains no '## Epic ${request.epicNumber}' heading` +
          describeEpicsPresent(lines),
      ],
    };
  }

  const epicEnd = sectionEnd(lines, epicIndex + 1, 2);
  const title = headingText(lines[epicIndex] as string, 2) ?? '';
  const epicTitle = EPIC_HEADING.exec(title)?.[2]?.trim() ?? '';

  const storyStarts = findStoryHeadings(lines, epicIndex + 1, epicEnd, request.epicNumber);
  const goalEnd = storyStarts[0]?.index ?? epicEnd;

  const stories = storyStarts.map((start, position) =>
    readStory(
      lines,
      start,
      storyStarts[position + 1]?.index ?? epicEnd,
      relativePath,
    ),
  );

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
  };
}

/** The epics file as an `EpicSource` (question Q4's seam). */
export const epicsFileSource: EpicSource = {
  id: 'bmad-v6:epics-file',
  read: readEpicsFile,
};

/** Index of the `## Epic <n>` heading for exactly `epicNumber`. */
function findEpicHeading(lines: readonly string[], epicNumber: number): number | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    const text = headingText(lines[index] as string, 2);
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

/** The `### Story <epic>.<m>` headings inside `[start, end)`. */
function findStoryHeadings(
  lines: readonly string[],
  start: number,
  end: number,
  epicNumber: number,
): StoryStart[] {
  const starts: StoryStart[] = [];
  for (let index = start; index < end; index += 1) {
    const text = headingText(lines[index] as string, 3);
    if (text === undefined) continue;
    const match = STORY_HEADING.exec(text);
    // A `### Story 8.1` nested under `## Epic 7` is a documentation bug; take
    // the epic heading's word for which epic this is and skip the stray.
    if (match === null || Number(match[1]) !== epicNumber) continue;
    starts.push({
      index,
      id: `${match[1]}.${match[2]}`,
      title: (match[3] ?? '').trim(),
    });
  }
  return starts;
}

function readStory(
  lines: readonly string[],
  start: StoryStart,
  end: number,
  relativePath: string,
): ReadStory {
  const criteriaMarker = findCriteriaMarker(lines, start.index + 1, end);
  const narrativeEnd = criteriaMarker ?? end;

  const criteria: AcceptanceCriterion[] =
    criteriaMarker === undefined
      ? []
      : extractCriteria(lines, criteriaMarker + 1, end).map((scanned, position) => ({
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

function findCriteriaMarker(
  lines: readonly string[],
  start: number,
  end: number,
): number | undefined {
  for (let index = start; index < end; index += 1) {
    if (CRITERIA_MARKER.test((lines[index] as string).trim())) return index;
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
function describeEpicsPresent(lines: readonly string[]): string {
  const present: string[] = [];
  for (const line of lines) {
    const text = headingText(line, 2);
    if (text === undefined) continue;
    const match = EPIC_HEADING.exec(text);
    if (match !== null) present.push(match[1] as string);
  }
  return present.length === 0
    ? ' (it declares no epics at all)'
    : ` (it declares epics: ${present.join(', ')})`;
}
