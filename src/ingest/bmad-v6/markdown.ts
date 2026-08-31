/**
 * The hand-rolled markdown scanning both BMAD v6 readers share.
 *
 * Deliberately not a markdown AST library: the two layouts use a handful of
 * heading and list shapes, scanning them over `readFile` text is testable and
 * exact, and the Stack table is pinned — adding `remark`/`unified` would be an
 * ADR, not a story decision.
 *
 * Everything here works on an array of lines, and every position it reports is
 * a 0-based index into that array. Callers add 1 when they build a `SourceRef`,
 * because source references are 1-based (that is what an editor shows).
 */

import { readFileSync } from 'node:fs';

import { IngestError } from '../../domain/errors.js';
import { assertInsideRoot } from '../repo-path.js';

/** An opening or closing fence: three or more backticks or tildes. */
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * A markdown file plus, for each line, whether it sits inside a fenced code
 * block.
 *
 * The distinction is load-bearing rather than pedantic. This repository's own
 * story files contain shell examples whose comment lines start with `#`, and
 * one of them opens a fenced block with `# Repeat this pattern ...` — which a
 * heading matcher reads as an H1. A `## Acceptance Criteria` inside an example
 * would truncate a real section, and a `### Story 7.2` would invent a story
 * that does not exist. Structure is read from unfenced lines only; TEXT is
 * always taken verbatim from `lines`, fences included, because a criterion may
 * legitimately contain a code block.
 */
export interface MarkdownDoc {
  /** Every line, verbatim, BOM-stripped and CRLF-normalised. */
  readonly lines: readonly string[];
  /** Parallel to `lines`: true where the line is fence syntax or inside one. */
  readonly fenced: readonly boolean[];
}

/** Marks fence delimiters and everything between them. */
export function fenceMask(lines: readonly string[]): boolean[] {
  const mask = lines.map(() => false);
  let open: string | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const marker = FENCE.exec(lines[index] as string)?.[1];

    if (open === undefined) {
      if (marker !== undefined) {
        open = marker;
        mask[index] = true;
      }
      continue;
    }

    mask[index] = true;
    // A fence closes only if it is the same kind AND at least as long as the
    // opener. Both halves matter: a ``` inside a ~~~ block is content, and so
    // is a ``` inside a ```` block — which is exactly how one writes
    // documentation containing a fenced example, as this repository does.
    // Treating the short one as a close reopens the rest of the file to
    // structural parsing, turning example headings back into real stories.
    if (marker !== undefined && marker[0] === open[0] && marker.length >= open.length) {
      open = undefined;
    }
  }

  return mask;
}

/** `1. `, `1) `, `- `, `* `, `+ ` — with the indent that precedes it. */
const LIST_ITEM = /^(\s*)((?:\d+[.)])|[-*+])(\s+)(.*)$/;

/** A `---` (or longer) thematic break on its own line. */
const THEMATIC_BREAK = /^\s{0,3}(?:-{3,}|_{3,}|\*{3,})\s*$/;

/** An ATX heading, capturing its level. */
const ATX_HEADING = /^(#{1,6})\s+(.*)$/;

/**
 * Reads a markdown file into lines, normalized for a real checkout.
 *
 * Strips a UTF-8 BOM and splits on `\r?\n`. Both matter: a BOM sits in front of
 * the very first `#`, so a heading matcher anchored with `^#` silently finds
 * nothing in a file checked out on Windows, and a trailing `\r` would ride
 * along inside every "verbatim" criterion.
 *
 * An unreadable file is an `IngestError` naming the path — never an
 * unclassified crash, which would still exit 3 but with "this is a SpecWitness
 * bug" text that sends the user to the wrong place entirely.
 */
export function readMarkdown(
  absolutePath: string,
  relativePath: string,
  realRoot?: string,
): MarkdownDoc {
  // Containment is per-file, not just per-root: a symlinked `epics.md` inside a
  // legitimate root still reads outside the repository.
  assertInsideRoot(realRoot, absolutePath, relativePath);

  let raw: string;
  try {
    raw = readFileSync(absolutePath, 'utf8');
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    throw new IngestError(
      `cannot read planning artifact ${relativePath}${code === undefined ? '' : ` (${code})`}`,
      'check the file exists and is readable, and that planning.planningArtifacts / ' +
        'planning.implementationArtifacts in .specwitness/config.yaml point where you think',
    );
  }

  const lines = splitLines(stripBom(raw));
  return { lines, fenced: fenceMask(lines) };
}

/** Removes a leading UTF-8 byte-order mark, if present. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Splits on LF or CRLF, so a Windows checkout parses identically. */
export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** The heading level of `line`, or 0 when it is not an ATX heading. */
export function headingLevel(line: string): number {
  return ATX_HEADING.exec(line)?.[1]?.length ?? 0;
}

/** The text of an ATX heading at exactly `level`, or undefined. */
export function headingText(line: string, level: number): string | undefined {
  const match = ATX_HEADING.exec(line);
  if (match === undefined || match === null) return undefined;
  if (match[1]?.length !== level) return undefined;
  // Trailing `#`s are a legal ATX closing sequence; strip them.
  return (match[2] ?? '').replace(/\s+#+\s*$/, '').trim();
}

/** True for a `---` rule. */
export function isThematicBreak(line: string): boolean {
  return THEMATIC_BREAK.test(line);
}

/**
 * The index at which a section that starts at `start` ends.
 *
 * A section ends at the next heading of level `level` or shallower, or at a
 * thematic break. The thematic break is not decoration: every epic section in
 * the first client's own `epics.md` is closed by a `---` before the next
 * `## Epic`, so without it the last story of an epic runs into the next epic
 * (or, for the final epic, to end of file).
 */
export function sectionEnd(doc: MarkdownDoc, start: number, level: number): number {
  for (let index = start; index < doc.lines.length; index += 1) {
    if (doc.fenced[index] === true) continue;
    const line = doc.lines[index] as string;
    if (isThematicBreak(line)) return index;
    const found = headingLevel(line);
    if (found > 0 && found <= level) return index;
  }
  return doc.lines.length;
}

/** One criterion as scanned out of a section: its text and where it began. */
export interface ScannedCriterion {
  readonly text: string;
  /** 0-based index into the lines array. */
  readonly index: number;
}

/**
 * Extracts acceptance criteria from the body of a criteria section.
 *
 * Two shapes exist in the wild and both are supported:
 *
 *  - **List items** — per-story files write `1. **Given** …` with continuation
 *    lines indented under the marker.
 *  - **Paragraph blocks** — the epics file writes bare bold `Given`, `When` and
 *    `Then` lines with no markers at all, one blank-line-separated block per
 *    criterion.
 *
 * The strategy is chosen by WHERE the first list appears among the section's
 * blank-line-separated blocks, and both ends of that decision are load-bearing:
 *
 *  - A real per-story file opens its criteria section with a prose lead-in
 *    (``From `docs/planning-artifacts/epics.md` (authoritative …):``), so
 *    "first line decides" would take the paragraph path and ingest that lead-in
 *    as criterion 1.
 *  - But "any list item anywhere decides" is just as wrong in the other
 *    direction: a paragraph-style section that happens to be followed by a
 *    trailing `Clarifications` list would have its real Given/When/Then
 *    criteria silently DISCARDED and replaced by those bullets. Same corruption,
 *    opposite cause.
 *
 * So: a list at block 0 is the criteria; a list at block 1 is the criteria when
 * block 0 is a lead-in (a paragraph ending in `:`); a list any later is trailing
 * matter, and the paragraphs before it are the criteria.
 */
export function extractCriteria(
  doc: MarkdownDoc,
  start: number,
  end: number,
): ScannedCriterion[] {
  const { lines } = doc;
  const blocks = findBlocks(doc, start, end);
  const firstList = blocks.findIndex(
    (block) => doc.fenced[block.start] !== true && LIST_ITEM.test(lines[block.start] as string),
  );

  if (firstList === 0) {
    return extractListBlock(doc, (blocks[0] as Block).start, end);
  }

  if (firstList === 1 && isLeadIn(lines, blocks[0] as Block)) {
    return extractListBlock(doc, (blocks[1] as Block).start, end);
  }

  // No list, or a list far enough down to be trailing matter: the paragraphs
  // are the criteria, and they stop where that trailing matter begins — which
  // is at the list, or at the lead-in paragraph that introduces it
  // (`Clarifications (detail only, no weakening):` and friends), since that
  // lead-in belongs to the list rather than to the criteria.
  if (firstList === -1) return extractParagraphBlocks(doc, start, end);

  const preceding = blocks[firstList - 1];
  const boundary =
    preceding !== undefined && isLeadIn(lines, preceding)
      ? preceding.start
      : (blocks[firstList] as Block).start;

  return extractParagraphBlocks(doc, start, boundary);
}

/** A blank-line-separated run of non-blank lines. */
interface Block {
  readonly start: number;
  readonly end: number;
}

function findBlocks(doc: MarkdownDoc, start: number, end: number): Block[] {
  const blocks: Block[] = [];
  let blockStart: number | undefined;

  for (let index = start; index < end; index += 1) {
    // A blank line inside a fenced block is code, not a paragraph break.
    const blank = doc.fenced[index] !== true && (doc.lines[index] as string).trim() === '';
    if (blank) {
      if (blockStart !== undefined) blocks.push({ start: blockStart, end: index });
      blockStart = undefined;
    } else {
      blockStart ??= index;
    }
  }
  if (blockStart !== undefined) blocks.push({ start: blockStart, end });

  return blocks;
}

/**
 * True when a paragraph introduces the list that follows it rather than being a
 * criterion in its own right.
 *
 * A lead-in ends in a colon — that is what "here comes the list" looks like in
 * every real specimen, and what distinguishes it from a Given/When/Then
 * criterion, which ends in a full stop.
 */
function isLeadIn(lines: readonly string[], block: Block): boolean {
  return (lines[block.end - 1] as string).trimEnd().endsWith(':');
}

/**
 * The FIRST contiguous list block starting at `start`.
 *
 * "First contiguous block" rather than "every list item in the section" is the
 * single most consequential rule in this file. Every real per-story file in the
 * first client's repository follows its numbered criteria with
 *
 *     Clarifications (detail only, no weakening):
 *
 *     - AC1: …
 *
 * Taking every bullet would ingest those editorial notes as acceptance
 * criteria, and the contract author downstream would draft verification
 * criteria for them. The prose line ends the block, so they are never reached.
 *
 * A blank line only continues the block when the next non-blank line resumes
 * the same list — same indent, same marker kind. That keeps a loose list intact
 * without letting the paragraph after the list pull the next list in with it.
 */
function extractListBlock(doc: MarkdownDoc, start: number, end: number): ScannedCriterion[] {
  const { lines } = doc;
  const first = LIST_ITEM.exec(lines[start] as string);
  /* c8 ignore next */
  if (first === null) return [];

  const baseIndent = (first[1] ?? '').length;
  const ordered = /\d/.test(first[2] ?? '');

  const criteria: ScannedCriterion[] = [];
  let buffer: string[] = [];
  let bufferIndex = start;
  let contentIndent = 0;

  const flush = (): void => {
    if (buffer.length === 0) return;
    const text = buffer.join('\n').trim();
    if (text.length > 0) criteria.push({ text, index: bufferIndex });
    buffer = [];
  };

  for (let index = start; index < end; index += 1) {
    const line = lines[index] as string;
    const fenced = doc.fenced[index] === true;

    if (!fenced && line.trim() === '') {
      const next = nextNonBlank(doc, index + 1, end);
      if (next === undefined) break;
      // A fenced example after a blank line belongs to the item above it.
      if (doc.fenced[next] === true && buffer.length > 0) {
        buffer.push('');
        continue;
      }
      if (!resumesList(lines[next] as string, baseIndent, ordered)) break;
      // A loose list: keep the blank inside the current item and continue.
      buffer.push('');
      continue;
    }

    // Inside a fence, nothing is a list item or prose — it is criterion text.
    if (fenced) {
      const indent = line.length - line.trimStart().length;
      buffer.push(line.slice(Math.min(indent, contentIndent)));
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item !== null && (item[1] ?? '').length === baseIndent) {
      flush();
      bufferIndex = index;
      contentIndent = baseIndent + (item[2] ?? '').length + (item[3] ?? '').length;
      buffer.push(item[4] ?? '');
      continue;
    }

    const indent = line.length - line.trimStart().length;
    if (indent <= baseIndent) break; // Prose at list level ends the block.

    // A continuation line. Remove exactly the list's content indent so the
    // criterion reads as written, while any DEEPER indentation (a nested code
    // block, say) survives relative to it.
    buffer.push(line.slice(Math.min(indent, contentIndent)));
  }

  flush();
  return criteria;
}

/** Blank-line-separated blocks; one block is one criterion. */
function extractParagraphBlocks(doc: MarkdownDoc, start: number, end: number): ScannedCriterion[] {
  const { lines } = doc;
  const criteria: ScannedCriterion[] = [];
  let buffer: string[] = [];
  let bufferIndex = start;

  const flush = (): void => {
    const text = buffer.join('\n').trim();
    if (text.length > 0) criteria.push({ text, index: bufferIndex });
    buffer = [];
  };

  for (let index = start; index < end; index += 1) {
    const line = lines[index] as string;
    if (doc.fenced[index] !== true && line.trim() === '') {
      // A blank line before a fenced example does not end the criterion: the
      // example belongs to the criterion it illustrates. Splitting there would
      // emit the code block on its own as a criterion with no Given/When/Then
      // in it at all.
      const next = nextNonBlank(doc, index + 1, end);
      if (next !== undefined && doc.fenced[next] === true && buffer.length > 0) {
        buffer.push('');
        continue;
      }
      flush();
      continue;
    }
    if (buffer.length === 0) bufferIndex = index;
    buffer.push(line);
  }

  flush();
  return criteria;
}

/** Index of the next non-blank line in `[from, end)`, or undefined. */
function nextNonBlank(doc: MarkdownDoc, from: number, end: number): number | undefined {
  for (let index = from; index < end; index += 1) {
    if (doc.fenced[index] === true) return index;
    if ((doc.lines[index] as string).trim() !== '') return index;
  }
  return undefined;
}

/** True when `line` is a list item continuing the same list. */
function resumesList(line: string, baseIndent: number, ordered: boolean): boolean {
  const item = LIST_ITEM.exec(line);
  if (item === null) return false;
  if ((item[1] ?? '').length !== baseIndent) return false;
  return /\d/.test(item[2] ?? '') === ordered;
}

/** Joins `[start, end)` and trims — used for goal and narrative paragraphs. */
export function joinTrimmed(lines: readonly string[], start: number, end: number): string {
  return lines.slice(start, end).join('\n').trim();
}
