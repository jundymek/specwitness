import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readEpicsFile } from '../../../src/ingest/bmad-v6/epics-file.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/ingest/', import.meta.url));

function read(project: string, epicNumber: number) {
  const projectRoot = join(FIXTURES, project);
  return readEpicsFile({
    projectRoot,
    epicNumber,
    epicId: `epic-${epicNumber}`,
    rootLabel: 'docs/planning-artifacts',
  });
}

describe('epics-file reader — the happy path (AC1, AC2)', () => {
  it('reads the epic title and goal', () => {
    const reading = read('epics-only', 7);

    expect(reading.title).toBe('Ingestion Sample');
    expect(reading.goal).toBe(
      'Prove that the epics-file reader finds an epic by its full number, keeps its\ngoal paragraph, and preserves every acceptance criterion verbatim.',
    );
  });

  it('reads every story with its title and narrative', () => {
    const reading = read('epics-only', 7);

    expect(reading.stories.map((story) => story.id)).toEqual(['7.1', '7.2']);
    expect(reading.stories[0]?.title).toBe('First story');
    expect(reading.stories[0]?.narrative).toBe(
      'As a fixture author,\nI want a story with two criteria,\nSo that ordering and count are both observable.',
    );
  });

  it('preserves criterion text byte-for-byte, including a trailing **And** line', () => {
    const reading = read('epics-only', 7);
    const criteria = reading.stories[0]?.acceptanceCriteria ?? [];

    expect(criteria).toHaveLength(2);
    // Exact equality, never toContain: a silently reworded criterion is the
    // failure this product exists to catch.
    expect(criteria[0]?.text).toBe(
      '**Given** the epics file exists\n**When** epic 7 is ingested\n**Then** story 7.1 carries exactly two criteria.',
    );
    expect(criteria[1]?.text).toBe(
      '**Given** a criterion spanning several lines\n' +
        '**When** its text is read\n' +
        '**Then** the line breaks survive\n' +
        '**And** a trailing `**And**` line is part of the same criterion.',
    );
  });

  it('numbers criteria from one, in source order', () => {
    const reading = read('epics-only', 7);
    expect(reading.stories[0]?.acceptanceCriteria.map((c) => c.ordinal)).toEqual([1, 2]);
  });

  it('carries a repo-relative source path and a 1-based line for every element', () => {
    const reading = read('epics-only', 7);
    const story = reading.stories[0];

    expect(reading.epicSource?.path).toBe('docs/planning-artifacts/epics.md');
    expect(reading.epicSource?.layout).toBe('epics-file');
    expect(story?.source.path).toBe('docs/planning-artifacts/epics.md');
    expect(story?.source.line).toBeGreaterThan(reading.epicSource?.line ?? 0);
    // The first criterion starts after the story heading it belongs to.
    expect(story?.acceptanceCriteria[0]?.source.line).toBeGreaterThan(story?.source.line ?? 0);
  });

  it('reports the file it searched', () => {
    const reading = read('epics-only', 7);
    expect(reading.searched).toContain('docs/planning-artifacts/epics.md');
  });
});

describe('epics-file reader — prefix collisions (failure mode from the spec)', () => {
  it('does not answer a request for epic 1 with epic 10', () => {
    const reading = read('epics-only', 1);

    expect(reading.stories).toHaveLength(0);
    expect(reading.epicSource).toBeUndefined();
    expect(reading.notes.join('\n')).toContain("no '## Epic 1'");
  });

  it('finds epic 10 as itself, with exactly its own story', () => {
    const reading = read('epics-only', 10);

    expect(reading.title).toBe('Prefix Collision Guard');
    expect(reading.stories.map((story) => story.id)).toEqual(['10.1']);
  });

  it('stops an epic section at the --- rule that closes it', () => {
    // Without the thematic-break terminator, epic 7 would swallow epic 10.
    const reading = read('epics-only', 7);
    expect(reading.stories.map((story) => story.id)).toEqual(['7.1', '7.2']);
  });
});

describe('epics-file reader — degenerate input (AC3)', () => {
  it('finds an epic that has no stories, and reports zero rather than inventing one', () => {
    const reading = read('epics-only', 11);

    expect(reading.title).toBe('Zero Stories');
    expect(reading.stories).toHaveLength(0);
  });

  it('returns a story whose criteria section is empty with zero criteria', () => {
    // The emptiness rule is applied once, after the merge, by ingestEpic.
    const reading = read('broken', 7);
    const empty = reading.stories.find((story) => story.id === '7.1');

    expect(empty).toBeDefined();
    expect(empty?.acceptanceCriteria).toHaveLength(0);
    expect(reading.stories.find((story) => story.id === '7.2')?.acceptanceCriteria).toHaveLength(1);
  });

  it('reports a missing epics file without throwing', () => {
    const reading = read('stories-only', 7);

    expect(reading.stories).toHaveLength(0);
    expect(reading.searched).toContain('docs/planning-artifacts/epics.md');
    expect(reading.notes.join('\n')).toContain('does not exist');
  });
});

describe('epics-file reader — a Windows checkout', () => {
  it('finds headings through a UTF-8 BOM and CRLF line endings', () => {
    const reading = read('crlf-bom', 7);

    expect(reading.title).toBe('Windows Checkout');
    expect(reading.stories).toHaveLength(1);
    const text = reading.stories[0]?.acceptanceCriteria[0]?.text ?? '';
    expect(text).toBe(
      '**Given** a BOM-prefixed CRLF file\n' +
        '**When** it is ingested\n' +
        '**Then** the epic heading is still found\n' +
        '**And** no criterion text ends with a stray carriage return.',
    );
    expect(text).not.toContain('\r');
  });
});
