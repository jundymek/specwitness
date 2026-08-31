import { describe, expect, it } from 'vitest';

import type { AcceptanceCriterion, EpicSpec, EpicStory } from '../../../src/domain/epic-spec.js';
import { epicSpecSchema } from '../../../src/schemas/epic-spec.js';
import { SCHEMA_VERSIONS, schemaVersionFor } from '../../../src/schemas/versions.js';

/**
 * The EpicSpec model is the ingestion-plugin seam (FR-6, question Q3): every
 * downstream consumer sees this shape and nothing BMAD-specific. Story 2.6
 * consumes it, so these tests pin the exact published contract — the one both
 * chuck (2.6) and bob (2.2) acked before implementation started.
 */

const criterion: AcceptanceCriterion = {
  ordinal: 1,
  text: '**Given** a thing\n**When** it happens\n**Then** it is so.',
  source: { path: 'docs/planning-artifacts/epics.md', line: 42, layout: 'epics-file' },
};

const story: EpicStory = {
  id: '7.1',
  title: 'First story',
  narrative: 'As a user,\nI want a thing,\nSo that I benefit.',
  acceptanceCriteria: [criterion],
  source: { path: 'docs/planning-artifacts/epics.md', line: 38, layout: 'epics-file' },
};

const spec: EpicSpec = {
  schemaVersion: schemaVersionFor('epicSpec'),
  id: 'epic-7',
  epicNumber: 7,
  title: 'Ingestion Sample',
  goal: 'Prove the reader works.',
  stories: [story],
  source: { path: 'docs/planning-artifacts/epics.md', line: 12, layout: 'epics-file' },
};

describe('EpicSpec schema registration (AD-5)', () => {
  it('registers epicSpec in the version registry', () => {
    expect(SCHEMA_VERSIONS.epicSpec).toBe(1);
    expect(schemaVersionFor('epicSpec')).toBe(1);
  });

  it('does not disturb the versions registered by earlier stories', () => {
    // AD-5: versions evolve additively. Renumbering an existing artifact would
    // make a stored run from last week unreadable.
    expect(SCHEMA_VERSIONS.resultTaxonomy).toBe(1);
    expect(SCHEMA_VERSIONS.runManifest).toBe(1);
  });
});

describe('the zod mirror accepts what the domain model produces', () => {
  it('round-trips a well-formed EpicSpec', () => {
    const parsed = epicSpecSchema.parse(spec);
    expect(parsed).toEqual(spec);
  });

  it('rejects a spec with no stories — AC3 fails closed on an empty result', () => {
    expect(() => epicSpecSchema.parse({ ...spec, stories: [] })).toThrow();
  });

  it('rejects a story with no acceptance criteria', () => {
    const empty = { ...spec, stories: [{ ...story, acceptanceCriteria: [] }] };
    expect(() => epicSpecSchema.parse(empty)).toThrow();
  });

  it('rejects an absolute source path — an EpicSpec must stay portable', () => {
    const absolute = {
      ...spec,
      source: { path: '/Users/someone/repo/docs/epics.md', line: 1, layout: 'epics-file' },
    };
    expect(() => epicSpecSchema.parse(absolute)).toThrow();
  });

  it('rejects a source line below 1 — line numbers are 1-based', () => {
    const badLine = { ...spec, source: { ...spec.source, line: 0 } };
    expect(() => epicSpecSchema.parse(badLine)).toThrow();
  });

  it('rejects an unknown layout value', () => {
    const badLayout = { ...spec, source: { ...spec.source, layout: 'bmad-v4' } };
    expect(() => epicSpecSchema.parse(badLayout)).toThrow();
  });

  it('accepts an empty title and goal — a story-files-only epic has neither', () => {
    // D4: only the epics file carries a title and a goal. Fabricating one from
    // a directory slug would invent content; '' says "absent" honestly.
    const storiesOnly: EpicSpec = {
      ...spec,
      title: '',
      goal: '',
      source: { path: 'docs/implementation-artifacts/epic-7-x', line: 1, layout: 'story-file' },
    };
    expect(() => epicSpecSchema.parse(storiesOnly)).not.toThrow();
  });
});
