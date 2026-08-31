import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readStoryFiles } from '../../../src/ingest/bmad-v6/story-files.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/ingest/', import.meta.url));

function read(project: string, epicNumber: number) {
  const projectRoot = join(FIXTURES, project);
  return readStoryFiles({
    projectRoot,
    epicNumber,
    epicId: `epic-${epicNumber}`,
    rootLabel: 'docs/implementation-artifacts',
  });
}

describe('story-files reader — the happy path (AC1, AC2)', () => {
  it('discovers every story file in the epic directory', () => {
    const reading = read('stories-only', 7);
    expect(reading.stories.map((story) => story.id)).toEqual(['7.1', '7.2', '7.10']);
  });

  it('orders stories numerically, so 7.10 sorts after 7.2 and not after 7.1', () => {
    // Lexicographically '7.10' < '7.2'. An epic silently reordering itself at
    // ten stories is the kind of bug nobody notices until it matters.
    const ids = read('stories-only', 7).stories.map((story) => story.id);
    expect(ids.indexOf('7.10')).toBe(ids.length - 1);
  });

  it('reads the title from the story heading and the narrative from ## Story', () => {
    const story = read('stories-only', 7).stories[0];

    expect(story?.title).toBe('First story from a per-story file');
    expect(story?.narrative).toBe(
      'As a fixture author,\n' +
        'I want a per-story file with a narrative,\n' +
        'so that the story-file reader has something to read.',
    );
  });

  it('reads a numbered criteria list, preserving text exactly', () => {
    const criteria = read('stories-only', 7).stories[0]?.acceptanceCriteria ?? [];

    expect(criteria).toHaveLength(2);
    expect(criteria[0]?.text).toBe(
      '**Given** a per-story file\n**When** it is ingested\n**Then** its criteria are numbered from one.',
    );
    expect(criteria[1]?.ordinal).toBe(2);
  });

  it('excludes the Clarifications bullets that follow the criteria list', () => {
    // The single most consequential parsing rule in this story: criteria are
    // the FIRST contiguous list block, not every bullet in the section.
    const criteria = read('stories-only', 7).stories[0]?.acceptanceCriteria ?? [];
    const all = criteria.map((criterion) => criterion.text).join('\n');

    expect(criteria).toHaveLength(2);
    expect(all).not.toContain('NOT an acceptance criterion');
    expect(all).not.toContain('Neither is this one');
  });

  it('ignores the preamble line before the criteria list', () => {
    const criteria = read('stories-only', 7).stories[0]?.acceptanceCriteria ?? [];
    expect(criteria[0]?.text.startsWith('**Given**')).toBe(true);
  });

  it('reads nothing from Tasks / Subtasks or Dev Notes', () => {
    const all = read('stories-only', 7)
      .stories.flatMap((story) => story.acceptanceCriteria.map((c) => c.text))
      .join('\n');

    expect(all).not.toContain('this section must not be read');
    expect(all).not.toContain('Nothing here is ingested');
  });

  it('accepts a `- ` bulleted criteria list as well as a numbered one', () => {
    const story = read('stories-only', 7).stories.find((candidate) => candidate.id === '7.2');

    expect(story?.acceptanceCriteria).toHaveLength(1);
    expect(story?.acceptanceCriteria[0]?.text).toBe(
      '**Given** a bullet-marked criteria list\n' +
        '**When** it is ingested\n' +
        '**Then** `- ` markers are accepted exactly like numbered ones.',
    );
  });

  it('carries repo-relative source paths and 1-based lines', () => {
    const story = read('stories-only', 7).stories[0];

    expect(story?.source.path).toBe(
      'docs/implementation-artifacts/epic-7-sample-epic/7.1-first.md',
    );
    expect(story?.source.layout).toBe('story-file');
    expect(story?.source.line).toBe(1);
    expect(story?.acceptanceCriteria[0]?.source.line).toBeGreaterThan(1);
  });

  it('reports the directory and every file it searched', () => {
    const reading = read('stories-only', 7);

    expect(reading.searched).toContain('docs/implementation-artifacts/epic-7-sample-epic');
    expect(reading.searched).toContain(
      'docs/implementation-artifacts/epic-7-sample-epic/7.1-first.md',
    );
  });

  it('skips a non-story markdown file but names it, rather than failing or hiding it', () => {
    const reading = read('stories-only', 7);
    expect(reading.notes.join('\n')).toContain('README.md');
  });
});

describe('story-files reader — prefix collisions (failure mode from the spec)', () => {
  it('does not answer a request for epic 1 with the epic-7 directory', () => {
    const reading = read('stories-only', 1);

    expect(reading.stories).toHaveLength(0);
    expect(reading.notes.join('\n')).toContain('epic-1');
  });

  it('lists the epic directories that do exist when none matches', () => {
    const reading = read('stories-only', 1);
    expect(reading.notes.join('\n')).toContain('epic-7-sample-epic');
  });
});

describe('story-files reader — degenerate input (AC3)', () => {
  it('reports a missing implementation-artifacts root without throwing', () => {
    const reading = read('epics-only', 7);

    expect(reading.stories).toHaveLength(0);
    expect(reading.searched).toContain('docs/implementation-artifacts');
    expect(reading.notes.join('\n')).toContain('does not exist');
  });

  it('returns zero criteria for a story file with no ## Acceptance Criteria heading', () => {
    const reading = read('broken', 9);
    const story = reading.stories[0];

    expect(story?.id).toBe('9.1');
    expect(story?.acceptanceCriteria).toHaveLength(0);
    expect(reading.notes.join('\n')).toContain('Acceptance Criteria');
  });

  it('names an epic directory that exists but holds no story files', () => {
    const reading = read('broken', 7);

    expect(reading.stories).toHaveLength(0);
    expect(reading.searched).toContain('docs/implementation-artifacts/epic-7-empty');
    expect(reading.notes.join('\n')).toContain('epic-7-empty');
  });
});
