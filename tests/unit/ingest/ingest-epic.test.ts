import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ConfigError, IngestError, UsageError } from '../../../src/domain/errors.js';
import { ingestEpic } from '../../../src/ingest/index.js';
import { epicSpecSchema } from '../../../src/schemas/epic-spec.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/ingest/', import.meta.url));

function ingest(project: string, epicId: string) {
  return ingestEpic({
    projectRoot: join(FIXTURES, project),
    epicId,
    planningArtifacts: 'docs/planning-artifacts',
    implementationArtifacts: 'docs/implementation-artifacts',
  });
}

describe('ingestEpic — epic id normalization (AC1)', () => {
  it('accepts 7, epic-7 and epic-07 as the same epic', () => {
    const forms = ['7', 'epic-7', 'epic-07', 'EPIC-7'].map((input) =>
      ingest('epics-only', input),
    );

    for (const spec of forms) {
      expect(spec.id).toBe('epic-7');
      expect(spec.epicNumber).toBe(7);
    }
    expect(forms[0]).toEqual(forms[3]);
  });

  it('rejects a malformed epic id as a UsageError (exit 64), not an IngestError', () => {
    // normalizeEpicId owns this: ingestion must not re-parse epic ids.
    expect(() => ingest('epics-only', 'seven')).toThrow(UsageError);
    expect(() => ingest('epics-only', '0')).toThrow(UsageError);
  });
});

describe('ingestEpic — single layout (AC2)', () => {
  it('ingests an epic present only in the epics file', () => {
    const spec = ingest('epics-only', '7');

    expect(spec.title).toBe('Ingestion Sample');
    expect(spec.stories.map((story) => story.id)).toEqual(['7.1', '7.2']);
    expect(spec.stories.every((story) => story.source.layout === 'epics-file')).toBe(true);
  });

  it('ingests an epic present only as per-story files', () => {
    const spec = ingest('stories-only', '7');

    expect(spec.stories.map((story) => story.id)).toEqual(['7.1', '7.2', '7.10']);
    expect(spec.stories.every((story) => story.source.layout === 'story-file')).toBe(true);
  });

  it('reports an absent epic title and goal as empty rather than inventing them', () => {
    // D4: only the epics file carries a title and goal. A slug is not a title.
    const spec = ingest('stories-only', '7');

    expect(spec.title).toBe('');
    expect(spec.goal).toBe('');
    expect(spec.source.layout).toBe('story-file');
  });

  it('stamps the registered schema version on every spec (AD-5)', () => {
    expect(ingest('epics-only', '7').schemaVersion).toBe(1);
  });

  it('produces a spec its own zod schema accepts', () => {
    expect(() => epicSpecSchema.parse(ingest('epics-only', '7'))).not.toThrow();
    expect(() => epicSpecSchema.parse(ingest('stories-only', '7'))).not.toThrow();
  });
});

describe('ingestEpic — both layouts merge (AC2)', () => {
  it('lets per-story files win for the stories they cover', () => {
    const spec = ingest('both', '7');
    const first = spec.stories.find((story) => story.id === '7.1');

    expect(first?.title).toBe('Title from the story file');
    expect(first?.source.layout).toBe('story-file');
    expect(first?.acceptanceCriteria).toHaveLength(2);
  });

  it('takes the epic title and goal from the epics file, which alone carries them', () => {
    const spec = ingest('both', '7');

    expect(spec.title).toBe('Merge Precedence');
    expect(spec.goal).toBe(
      'The epics file supplies the epic title and goal, plus any story the per-story\nfiles do not cover.',
    );
    expect(spec.source.layout).toBe('epics-file');
  });

  it('keeps a story the per-story files do not cover, sourced from the epics file', () => {
    const spec = ingest('both', '7');
    const third = spec.stories.find((story) => story.id === '7.3');

    expect(third?.source.layout).toBe('epics-file');
    expect(third?.title).toBe('Only in the epics file');
  });

  it('records which source won for every story', () => {
    const spec = ingest('both', '7');
    expect(spec.stories.map((story) => [story.id, story.source.layout])).toEqual([
      ['7.1', 'story-file'],
      ['7.2', 'story-file'],
      ['7.3', 'epics-file'],
    ]);
  });

  it('does not duplicate a story that both layouts describe', () => {
    const spec = ingest('both', '7');
    expect(spec.stories.map((story) => story.id)).toEqual(['7.1', '7.2', '7.3']);
  });
});

describe('ingestEpic — failure names what was searched (AC3)', () => {
  function messageFor(project: string, epicId: string): string {
    try {
      ingest(project, epicId);
    } catch (error) {
      expect(error).toBeInstanceOf(IngestError);
      return (error as IngestError).message;
    }
    throw new Error('expected ingestEpic to throw');
  }

  it('names the canonical epic id', () => {
    expect(messageFor('epics-only', '42')).toContain('epic-42');
  });

  it('names BOTH roots and BOTH layout patterns, expanded', () => {
    const message = messageFor('epics-only', '42');

    expect(message).toContain('docs/planning-artifacts/epics.md');
    expect(message).toContain('docs/implementation-artifacts');
    expect(message).toContain('epic-42');
  });

  it('says what was found instead, not merely that nothing was found', () => {
    const message = messageFor('epics-only', '42');

    expect(message).toContain('exists but contains no');
    // The epics it DOES declare — this is what turns "not found" into a
    // diagnosis ("you meant 10") rather than a dead end.
    expect(message).toMatch(/declares epics: .*10/);
  });

  it('carries a HINT pointing at the config keys that choose the roots', () => {
    try {
      ingest('epics-only', '42');
    } catch (error) {
      expect((error as IngestError).hint).toContain('planning.planningArtifacts');
    }
  });

  it('refuses an epic with zero stories rather than returning an empty spec', () => {
    const message = messageFor('epics-only', '11');

    expect(message).toContain('epic-11');
    expect(message).toMatch(/no.*stor/i);
  });

  it('refuses a story with zero acceptance criteria, naming that story and its file', () => {
    const message = messageFor('broken', '7');

    expect(message).toContain('7.1');
    expect(message).toContain('docs/planning-artifacts/epics.md');
    expect(message).toMatch(/no acceptance criteria/i);
  });

  it('names the empty epic directory it searched', () => {
    expect(messageFor('broken', '8')).toContain('epic-8');
  });
});

describe('ingestEpic — security (roots stay inside the project)', () => {
  it('rejects a root escaping the project root as a ConfigError, not an IngestError', () => {
    // The fault is in .specwitness/config.yaml, not in the planning artifacts.
    // Both exit 3, but `config` and `ingest` are distinct run-metadata
    // classifications and misclassifying sends the user to the wrong file.
    expect(() =>
      ingestEpic({
        projectRoot: join(FIXTURES, 'epics-only'),
        epicId: '7',
        planningArtifacts: '../../../../etc',
        implementationArtifacts: 'docs/implementation-artifacts',
      }),
    ).toThrow(ConfigError);
  });

  it('accepts a `..` segment that resolves back inside the project', () => {
    // The rule is about where a root LANDS, not about which characters spell
    // it. This path reads nothing outside the project, so refusing it would be
    // security theatre that breaks a legitimate config.
    const spec = ingestEpic({
      projectRoot: join(FIXTURES, 'epics-only'),
      epicId: '7',
      planningArtifacts: '../epics-only/docs/planning-artifacts',
      implementationArtifacts: 'docs/implementation-artifacts',
    });

    expect(spec.stories).toHaveLength(2);
    expect(spec.source.path).toBe('docs/planning-artifacts/epics.md');
  });

  it('names the resolved path in the ConfigError', () => {
    try {
      ingestEpic({
        projectRoot: join(FIXTURES, 'epics-only'),
        epicId: '7',
        planningArtifacts: '../../../etc',
        implementationArtifacts: 'docs/implementation-artifacts',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain('planning.planningArtifacts');
      expect((error as ConfigError).message).toContain('etc');
    }
  });

  it('rejects an absolute root outside the project root', () => {
    expect(() =>
      ingestEpic({
        projectRoot: join(FIXTURES, 'epics-only'),
        epicId: '7',
        planningArtifacts: 'docs/planning-artifacts',
        implementationArtifacts: '/etc',
      }),
    ).toThrow(ConfigError);
  });
});
