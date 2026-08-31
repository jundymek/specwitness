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

import type { MarkdownDoc } from './markdown.js';
import {
  extractCriteria,
  headingText,
  joinTrimmed,
  readMarkdown,
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
  // The directory pattern is named as searched even when nothing matched: AC3
  // asks the error to say WHERE it looked, and "the epic-7 directory" is the
  // thing a reader will go and check. Recording it here rather than in
  // `ingestEpic` is what keeps the orchestrator free of BMAD knowledge.
  const searched: string[] = [
    rootLabel,
    repoPath(rootLabel, epicDirectoryPattern(request.epicNumber)),
  ];
  const notes: string[] = [];
  const problems: string[] = [];
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
    return { stories: [], searched, notes, problems };
  }

  // The layout defines ONE directory per epic. Two matches — `epic-7-old` and
  // `epic-7-new`, say — have no precedence rule between them, so merging their
  // story sets fabricates an epic that exists in neither. Refuse instead.
  if (directories.length > 1) {
    for (const directory of directories) searched.push(repoPath(rootLabel, directory));
    problems.push(
      `${rootLabel} contains ${directories.length} directories for epic ` +
        `${request.epicNumber}: ${directories.join(', ')}`,
    );
    return { stories: [], searched, notes, problems };
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
          problems,
          realRoot,
        ),
      );
    }

    if (found === 0) {
      notes.push(`${relativeDirectory} exists but contains no story files`);
    }
  }

  reportDuplicateIds(stories, problems);

  // Numeric ordering, not lexicographic: '7.10' sorts before '7.2' as a string.
  const ordered = [...stories].sort(compareStoryIds);

  return { epicSource, stories: ordered, searched, notes, problems };
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
    if (!isDirectory(join(rootPath, entry), repoPath(request.rootLabel, entry))) continue;
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

/**
 * Whether `absolutePath` is a directory.
 *
 * `throwIfNoEntry: false` only suppresses ENOENT — an entry whose metadata
 * cannot be read at all (a symlink traversing an EACCES directory, say) still
 * throws. Unclassified, that escapes as "this is a SpecWitness bug", which
 * exits 3 like an IngestError but sends the user to look in entirely the wrong
 * place. A broken symlink, by contrast, is simply not a directory.
 */
function isDirectory(absolutePath: string, relativePath: string): boolean {
  try {
    return statSync(absolutePath, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    throw new IngestError(
      `cannot inspect ${relativePath}${code === undefined ? '' : ` (${code})`}`,
      'check the entry is readable — SpecWitness must be able to tell a story directory ' +
        'from a file to know which stories exist',
    );
  }
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
  problems: string[],
  realRoot: string | undefined,
): ReadStory {
  const doc = readMarkdown(absolutePath, relativePath, realRoot);

  const narrative = readSection(doc, STORY_SECTION);
  const criteriaSection = findSection(doc, CRITERIA_SECTION);

  // A second section of either kind is silently ignored otherwise, dropping
  // real criteria (or a real narrative) from the contract without a word.
  for (const name of [STORY_SECTION, CRITERIA_SECTION]) {
    const count = countSections(doc, name);
    if (count > 1) {
      problems.push(`${relativePath} has ${count} '## ${name}' sections`);
    }
  }

  if (criteriaSection === undefined) {
    notes.push(`${relativePath} has no '## ${CRITERIA_SECTION}' heading`);
  }

  const criteria: AcceptanceCriterion[] =
    criteriaSection === undefined
      ? []
      : extractCriteria(doc, criteriaSection.start, criteriaSection.end).map(
          (scanned, position) => ({
            ordinal: position + 1,
            text: scanned.text,
            source: { path: relativePath, line: scanned.index + 1, layout: 'story-file' as const },
          }),
        );

  if (criteriaSection !== undefined && criteria.length === 0) {
    notes.push(`${relativePath} has an empty '## ${CRITERIA_SECTION}' section`);
  }

  const heading = findStoryHeading(doc);

  // A file named 7.1-*.md whose H1 says `# Story 8.1` is a copied-and-renamed
  // artifact. Trusting the filename would attribute another story's acceptance
  // criteria to 7.1 in the contract — silently, and with a source reference
  // that looks right. Same fail-closed rule as a mismatched heading in the
  // epics file: SpecWitness either honours the claim or refuses.
  if (heading?.id !== undefined && heading.id !== id) {
    problems.push(
      `${relativePath}:${heading.line}: file is named for story ${id} but its heading says ` +
        `story ${heading.id}`,
    );
  } else if (heading?.malformed === true) {
    problems.push(
      `${relativePath}:${heading.line}: '# ${heading.title}' looks like a story heading but is ` +
        `not '# Story <epic>.<story>: <title>', so it cannot be checked against the filename`,
    );
  }

  return {
    id,
    title: heading?.title ?? '',
    narrative,
    acceptanceCriteria: criteria,
    // The H1's real line, not 1: a file with front matter or `Status:` metadata
    // ahead of its heading would otherwise send the reader to the wrong place.
    source: { path: relativePath, line: heading?.line ?? 1, layout: 'story-file' },
  };
}

/** A heading asserting that a story lives here, however it is then spelled. */
const CLAIMS_TO_BE_A_STORY = /^Story\b/i;

interface StoryHeading {
  /** Title with the `Story <n>.<m>:` prefix removed when there was one. */
  readonly title: string;
  /** 1-based line of the H1. */
  readonly line: number;
  /** The story id the heading claims, when it spells one out. */
  readonly id?: string;
  /** True when the heading claims to be a story but does not parse as one. */
  readonly malformed?: boolean;
}

/** The file's H1, with whatever it claims about which story it is. */
function findStoryHeading(doc: MarkdownDoc): StoryHeading | undefined {
  for (let index = 0; index < doc.lines.length; index += 1) {
    if (doc.fenced[index] === true) continue;
    const text = headingText(doc.lines[index] as string, 1);
    if (text === undefined) continue;

    const match = STORY_TITLE.exec(text);
    if (match === null) {
      // `# Story 8.x: Copied` claims to be a story and is not one. Falling back
      // to "ordinary title" would skip the filename cross-check and attribute
      // this file's criteria to whatever the filename happens to say.
      // `# Story 8.x: Copied` claims to be a story and is not one. Falling back
      // to "ordinary title" would skip the filename cross-check and attribute
      // this file's criteria to whatever the filename happens to say.
      return {
        title: text,
        line: index + 1,
        ...(CLAIMS_TO_BE_A_STORY.test(text) ? { malformed: true } : {}),
      };
    }

    return {
      title: (match[3] ?? '').trim(),
      line: index + 1,
      id: `${match[1]}.${match[2]}`,
    };
  }
  return undefined;
}

interface Section {
  readonly start: number;
  readonly end: number;
}

function findSection(doc: MarkdownDoc, name: string): Section | undefined {
  for (let index = 0; index < doc.lines.length; index += 1) {
    if (doc.fenced[index] === true) continue;
    if (headingText(doc.lines[index] as string, 2)?.toLowerCase() !== name.toLowerCase()) continue;
    return { start: index + 1, end: sectionEnd(doc, index + 1, 2) };
  }
  return undefined;
}

/** How many `## <name>` sections the document declares. */
function countSections(doc: MarkdownDoc, name: string): number {
  let count = 0;
  for (let index = 0; index < doc.lines.length; index += 1) {
    if (doc.fenced[index] === true) continue;
    if (headingText(doc.lines[index] as string, 2)?.toLowerCase() === name.toLowerCase()) {
      count += 1;
    }
  }
  return count;
}

function readSection(doc: MarkdownDoc, name: string): string {
  const section = findSection(doc, name);
  return section === undefined ? '' : joinTrimmed(doc.lines, section.start, section.end);
}

/**
 * Two files claiming the same story is ambiguous, so it is refused.
 *
 * It happens when two `epic-7-*` directories both match, or one directory holds
 * `7.1-old.md` and `7.1-new.md`. Keeping whichever the filesystem happened to
 * list last would make the contract depend on directory order and drop the
 * other story's acceptance criteria without a word. Cross-SOURCE precedence is
 * different and deliberate — a per-story file supersedes the epics file — but
 * within one source there is no rule that says which wins, so there must not be
 * a silent one.
 */
function reportDuplicateIds(stories: readonly ReadStory[], problems: string[]): void {
  const seen = new Map<string, string>();
  for (const story of stories) {
    const previous = seen.get(story.id);
    if (previous !== undefined) {
      problems.push(
        `story ${story.id} is defined twice: ${previous} and ${story.source.path}`,
      );
      continue;
    }
    seen.set(story.id, story.source.path);
  }
}

/** Orders `7.1 < 7.2 < 7.10` — by number, never as strings. */
function compareStoryIds(left: ReadStory, right: ReadStory): number {
  const [leftEpic = 0, leftStory = 0] = left.id.split('.').map(Number);
  const [rightEpic = 0, rightStory = 0] = right.id.split('.').map(Number);
  return leftEpic - rightEpic || leftStory - rightStory;
}
