/**
 * BMAD v6 layout (b): per-story markdown files.
 *
 * `<implementationArtifacts>/epic-<n>-<slug>/<task-id>.md`, each structured as
 *
 *     # Story 7.1: Title
 *     ## Story
 *     <narrative>
 *     ## Acceptance Criteria
 *     1. **Given** … **When** … **Then** …
 *
 * The first client's own `docs/implementation-artifacts/epic-1-*` files are the
 * reference specimens and the parser was written against them.
 *
 * Only `## Story` and `## Acceptance Criteria` are read. `Status:`, `## Tasks /
 * Subtasks`, `## Dev Notes` and the Dev Agent Record are deliberately ignored —
 * a contract is drafted from what must be true, not from how the work was done.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { AcceptanceCriterion, SourceRef } from '../../domain/epic-spec.js';
import { IngestError } from '../../domain/errors.js';
import type {
  EpicSource,
  EpicSourceReading,
  EpicSourceRequest,
  ReadStory,
} from '../epic-source.js';

import { assertInsideRoot, realPathOrUndefined, repoPath } from '../repo-path.js';

import {
  extractCriteria,
  headingText,
  joinTrimmed,
  readMarkdownLines,
  sectionEnd,
} from './markdown.js';

/**
 * `<n>.<m>[-slug].md`.
 *
 * Anchored on the full story number so `7.1-x.md` cannot be mistaken for
 * `7.10-x.md`, and the epic component is checked by the caller.
 */
const STORY_FILE = /^(\d+)\.(\d+)(?:-.*)?\.md$/i;

/** `# Story <n>.<m>: <title>` — the H1 of a per-story file. */
const STORY_TITLE = /^Story\s+(\d+)\.(\d+)\s*(?:[:.–—-]\s*(.*))?$/;

const STORY_SECTION = 'Story';
const CRITERIA_SECTION = 'Acceptance Criteria';

/**
 * Reads every story of one epic from the per-story-file layout.
 *
 * Like the epics-file reader, "nothing found" is an answer rather than an
 * exception: a missing root, an absent epic directory and a directory holding
 * no story files are all reported through `searched` and `notes`, so the AC3
 * error can name every path in one place. Only an unreadable existing file
 * throws.
 */
export function readStoryFiles(request: EpicSourceRequest): EpicSourceReading {
  const rootLabel = repoPath(request.rootLabel);
  const searched: string[] = [rootLabel];
  const notes: string[] = [];
  const rootPath = join(request.projectRoot, request.rootLabel);

  if (!existsSync(rootPath)) {
    return {
      stories: [],
      searched,
      notes: [`${rootLabel} does not exist`],
    };
  }

  // Resolved once: every artifact entry below is checked against it, because a
  // symlinked story directory or epics file inside a legitimate root still
  // reads outside the repository.
  const realRoot = realPathOrUndefined(rootPath);
  const directories = findEpicDirectories(rootPath, request, notes);
  if (directories.length === 0) {
    return { stories: [], searched, notes };
  }

  const stories: ReadStory[] = [];
  let epicSource: SourceRef | undefined;

  for (const directory of directories) {
    const relativeDirectory = repoPath(rootLabel, directory);
    searched.push(relativeDirectory);
    epicSource ??= { path: relativeDirectory, line: 1, layout: 'story-file' };

    const directoryPath = join(rootPath, directory);
    assertInsideRoot(realRoot, directoryPath, relativeDirectory);
    const entries = listEntries(directoryPath, relativeDirectory);
    let found = 0;

    for (const entry of entries) {
      const match = STORY_FILE.exec(entry);
      if (match === null || Number(match[1]) !== request.epicNumber) {
        // Real epic directories hold README files and the like. Skipping them
        // silently would make "I asked for epic 7 and got 2 of my 5 stories"
        // undiagnosable, so every skip is named.
        if (entry.toLowerCase().endsWith('.md')) {
          notes.push(`${relativeDirectory}/${entry} is not named <epic>.<story>[-slug].md — skipped`);
        }
        continue;
      }

      found += 1;
      const relativeFile = repoPath(relativeDirectory, entry);
      searched.push(relativeFile);
      stories.push(
        readStoryFile(
          join(directoryPath, entry),
          relativeFile,
          `${match[1]}.${match[2]}`,
          notes,
          realRoot,
        ),
      );
    }

    if (found === 0) {
      notes.push(`${relativeDirectory} exists but contains no story files`);
    }
  }

  // Numeric ordering, not lexicographic: '7.10' sorts before '7.2' as a string.
  const ordered = [...stories].sort(compareStoryIds);

  return { epicSource, stories: ordered, searched, notes };
}

/** The per-story layout as an `EpicSource` (question Q4's seam). */
export const storyFilesSource: EpicSource = {
  id: 'bmad-v6:story-files',
  read: readStoryFiles,
};

/** The directory-name pattern this layout uses, for error messages. */
export function epicDirectoryPattern(epicNumber: number): string {
  return `epic-${epicNumber}[-<slug>]/`;
}

/**
 * Epic directories matching exactly `epicNumber`.
 *
 * `epic-0*<n>` accepts a zero-padded directory (`epic-07-slug`) because
 * `normalizeEpicId` accepts `epic-07` as input, so a project may well have
 * named its directory that way. The number is still matched in full: `epic-1`
 * never answers a request for epic 11.
 */
function findEpicDirectories(
  rootPath: string,
  request: EpicSourceRequest,
  notes: string[],
): string[] {
  const pattern = new RegExp(`^epic-0*${request.epicNumber}(?:-.*)?$`, 'i');
  const entries = listEntries(rootPath, repoPath(request.rootLabel));

  const matched: string[] = [];
  const epicDirectories: string[] = [];

  for (const entry of entries) {
    if (!statSync(join(rootPath, entry), { throwIfNoEntry: false })?.isDirectory()) continue;
    if (/^epic-\d/i.test(entry)) epicDirectories.push(entry);
    if (pattern.test(entry)) matched.push(entry);
  }

  if (matched.length === 0) {
    notes.push(
      `${repoPath(request.rootLabel)} contains no ${epicDirectoryPattern(request.epicNumber)} directory` +
        (epicDirectories.length === 0
          ? ' (it contains no epic directories at all)'
          : ` (it contains: ${epicDirectories.sort().join(', ')})`),
    );
  }

  return matched.sort();
}

function listEntries(absolutePath: string, relativePath: string): string[] {
  try {
    return readdirSync(absolutePath);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    // An EACCES on an artifact directory must surface as a named IngestError,
    // never as an unclassified crash — both exit 3, but only one of them tells
    // the user which directory to look at.
    throw new IngestError(
      `cannot list planning artifacts in ${relativePath}${code === undefined ? '' : ` (${code})`}`,
      'check the directory exists and is readable, and that planning.implementationArtifacts ' +
        'in .specwitness/config.yaml points where you think',
    );
  }
}

function readStoryFile(
  absolutePath: string,
  relativePath: string,
  id: string,
  notes: string[],
  realRoot: string | undefined,
): ReadStory {
  const lines = readMarkdownLines(absolutePath, relativePath, realRoot);

  const narrative = readSection(lines, STORY_SECTION);
  const criteriaSection = findSection(lines, CRITERIA_SECTION);

  if (criteriaSection === undefined) {
    notes.push(`${relativePath} has no '## ${CRITERIA_SECTION}' heading`);
  }

  const criteria: AcceptanceCriterion[] =
    criteriaSection === undefined
      ? []
      : extractCriteria(lines, criteriaSection.start, criteriaSection.end).map(
          (scanned, position) => ({
            ordinal: position + 1,
            text: scanned.text,
            source: { path: relativePath, line: scanned.index + 1, layout: 'story-file' as const },
          }),
        );

  if (criteriaSection !== undefined && criteria.length === 0) {
    notes.push(`${relativePath} has an empty '## ${CRITERIA_SECTION}' section`);
  }

  return {
    id,
    title: readTitle(lines),
    narrative,
    acceptanceCriteria: criteria,
    source: { path: relativePath, line: 1, layout: 'story-file' },
  };
}

/** The H1 title, with the `Story <n>.<m>:` prefix removed when present. */
function readTitle(lines: readonly string[]): string {
  for (const line of lines) {
    const text = headingText(line, 1);
    if (text === undefined) continue;
    return STORY_TITLE.exec(text)?.[3]?.trim() ?? text;
  }
  return '';
}

interface Section {
  readonly start: number;
  readonly end: number;
}

function findSection(lines: readonly string[], name: string): Section | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    if (headingText(lines[index] as string, 2)?.toLowerCase() !== name.toLowerCase()) continue;
    return { start: index + 1, end: sectionEnd(lines, index + 1, 2) };
  }
  return undefined;
}

function readSection(lines: readonly string[], name: string): string {
  const section = findSection(lines, name);
  return section === undefined ? '' : joinTrimmed(lines, section.start, section.end);
}

/** Orders `7.1 < 7.2 < 7.10` — by number, never as strings. */
function compareStoryIds(left: ReadStory, right: ReadStory): number {
  const [leftEpic = 0, leftStory = 0] = left.id.split('.').map(Number);
  const [rightEpic = 0, rightStory = 0] = right.id.split('.').map(Number);
  return leftEpic - rightEpic || leftStory - rightStory;
}
