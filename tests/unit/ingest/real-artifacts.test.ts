import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readEpicsFile } from '../../../src/ingest/bmad-v6/epics-file.js';
import { ingestEpic } from '../../../src/ingest/index.js';
import { epicSpecSchema } from '../../../src/schemas/epic-spec.js';

/**
 * The first client's BMAD layout IS this repository's layout (addendum section
 * A), so the best available proof that the parser handles a real artifact is to
 * point it at this repository. Hand-written fixtures prove the rules; this
 * proves the rules were the right ones.
 *
 * These assertions are deliberately about SHAPE (counts, ids, which layout won,
 * non-emptiness) plus one exact criterion text. Asserting every criterion of
 * every epic would turn an ordinary edit to `epics.md` into a failing build for
 * whoever made it, which is a test that costs more than it catches — but a
 * story count that silently halves is exactly what must fail here.
 */

const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function ingest(epicId: string) {
  return ingestEpic({
    projectRoot: PROJECT_ROOT,
    epicId,
    planningArtifacts: 'docs/planning-artifacts',
    implementationArtifacts: 'docs/implementation-artifacts',
  });
}

describe("this repository's own epic 1", () => {
  it('ingests all six stories', () => {
    const spec = ingest('epic-1');

    expect(spec.id).toBe('epic-1');
    expect(spec.epicNumber).toBe(1);
    expect(spec.stories).toHaveLength(6);
    expect(spec.stories.map((story) => story.id)).toEqual([
      '1.1',
      '1.2',
      '1.3',
      '1.4',
      '1.5',
      '1.6',
    ]);
  });

  it('takes the epic title and goal from the epics file', () => {
    const spec = ingest('1');

    expect(spec.title).toBe('Install, Configure & Diagnose');
    expect(spec.goal).toContain('scaffold `.specwitness/`');
    expect(spec.source.path).toBe('docs/planning-artifacts/epics.md');
  });

  it('lets the per-story files win — both layouts exist for epic 1', () => {
    const spec = ingest('1');
    expect(spec.stories.every((story) => story.source.layout === 'story-file')).toBe(true);
  });

  it('gives every story a realistic number of acceptance criteria', () => {
    const spec = ingest('1');

    for (const story of spec.stories) {
      expect(story.acceptanceCriteria.length).toBeGreaterThanOrEqual(2);
      // Sanity ceiling: if the Clarifications bullets ever leak back in, the
      // counts jump well past this and this assertion is what says so.
      expect(story.acceptanceCriteria.length).toBeLessThanOrEqual(6);
    }
  });

  it('excludes the Clarifications bullets from the real story files', () => {
    const spec = ingest('1');
    const all = spec.stories
      .flatMap((story) => story.acceptanceCriteria.map((criterion) => criterion.text))
      .join('\n');

    expect(all).not.toContain('Clarifications');
    expect(all).not.toContain('detail only, no weakening');
    // The preamble line that opens every real criteria section.
    expect(all).not.toContain('authoritative — expand, never weaken');
  });

  it('preserves a real criterion byte-for-byte', () => {
    const spec = ingest('1');
    const story = spec.stories.find((candidate) => candidate.id === '1.4');

    expect(story?.acceptanceCriteria[0]?.text).toBe(
      '**Given** a Git repository without SpecWitness (any stack, no Node project required)\n' +
        '**When** I run `specwitness init`\n' +
        '**Then** `.specwitness/` is created with `config.yaml` skeleton (commented examples ' +
        'for gates/services/observations/ai) and `contracts/`, `plans/`, `runs/` directories, ' +
        'and the command reports what was created.',
    );
  });

  it('points every source reference at a real, repo-relative file', () => {
    const spec = ingest('1');

    for (const story of spec.stories) {
      expect(story.source.path).toMatch(
        /^docs\/implementation-artifacts\/epic-1-install-configure-diagnose\/1\.\d+-.*\.md$/,
      );
      for (const criterion of story.acceptanceCriteria) {
        expect(criterion.source.path).toBe(story.source.path);
        expect(criterion.source.line).toBeGreaterThan(1);
      }
    }
  });

  it('produces a spec that satisfies its own schema', () => {
    expect(() => epicSpecSchema.parse(ingest('1'))).not.toThrow();
  });
});

describe("this repository's own epics file, read on its own", () => {
  it('reads all six stories of epic 1 from the epics file alone', () => {
    // The epics-file layout in isolation — the same epic, the other variant.
    const reading = readEpicsFile({
      projectRoot: PROJECT_ROOT,
      epicNumber: 1,
      epicId: 'epic-1',
      rootLabel: 'docs/planning-artifacts',
    });

    expect(reading.stories).toHaveLength(6);
    expect(reading.stories.map((story) => story.id)).toEqual([
      '1.1',
      '1.2',
      '1.3',
      '1.4',
      '1.5',
      '1.6',
    ]);
    for (const story of reading.stories) {
      expect(story.acceptanceCriteria.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('reads epic 7 — the last epic, whose section runs to the end of the file', () => {
    const reading = readEpicsFile({
      projectRoot: PROJECT_ROOT,
      epicNumber: 7,
      epicId: 'epic-7',
      rootLabel: 'docs/planning-artifacts',
    });

    expect(reading.title).not.toBe('');
    expect(reading.stories.length).toBeGreaterThan(0);
    for (const story of reading.stories) {
      expect(story.id.startsWith('7.')).toBe(true);
      expect(story.acceptanceCriteria.length).toBeGreaterThan(0);
    }
  });

  it('does not answer a request for epic 1 with epic 10-style prefix matching', () => {
    // This repository has seven epics, so a request for 70 must find nothing
    // rather than matching `## Epic 7`.
    const reading = readEpicsFile({
      projectRoot: PROJECT_ROOT,
      epicNumber: 70,
      epicId: 'epic-70',
      rootLabel: 'docs/planning-artifacts',
    });

    expect(reading.stories).toHaveLength(0);
    expect(reading.notes.join('\n')).toContain('declares epics: 1, 2, 3, 4, 5, 6, 7');
  });
});
