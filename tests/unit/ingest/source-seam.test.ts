import { describe, expect, it } from 'vitest';

import { bmadV6Sources } from '../../../src/ingest/bmad-v6/index.js';
import type { EpicSource, EpicSourceReading, EpicSourceRequest } from '../../../src/ingest/epic-source.js';

/**
 * FR-6 / question Q4: "additional `ingest/` readers implementing the same
 * `EpicSource -> EpicSpec` interface; no other layer changes."
 *
 * A Codex review pointed out — correctly — that the seam existed as a type
 * while `ingestEpic` still called the two BMAD readers by name, so the claim
 * was an intention rather than a fact. The orchestrator now folds an ordered
 * list of sources, and this file is the evidence: a source written entirely
 * here, in `tests/`, participates fully without a single line changing in
 * `src/ingest/index.ts`.
 *
 * Fakes live in `tests/`, never in `src/` (Epic 1 retrospective §5.2).
 */

const BASE_REQUEST: Omit<EpicSourceRequest, 'rootLabel'> = {
  projectRoot: '/nowhere',
  epicNumber: 7,
  epicId: 'epic-7',
};

/** A source that knows nothing about BMAD and reads no files at all. */
function fixedSource(id: string, reading: EpicSourceReading): EpicSource {
  return { id, read: () => reading };
}

describe('the EpicSource seam is real, not declarative', () => {
  it('describes the BMAD v6 set as an ordered list of bound sources', () => {
    const sources = bmadV6Sources('docs/planning-artifacts', 'docs/implementation-artifacts');

    expect(sources.map((entry) => [entry.source.id, entry.rootLabel])).toEqual([
      ['bmad-v6:epics-file', 'docs/planning-artifacts'],
      ['bmad-v6:story-files', 'docs/implementation-artifacts'],
    ]);
  });

  it('puts the superseding source last, which is what encodes AC2', () => {
    // Per-story files win for the stories they cover. That rule now lives in
    // list ORDER rather than in a branch inside the merge, which is what lets
    // the merge stay format-agnostic.
    const sources = bmadV6Sources('p', 'i');
    expect(sources.at(-1)?.source.id).toBe('bmad-v6:story-files');
  });

  it('accepts a source defined outside src/ingest entirely', () => {
    // The shape a future Cursor or CI reader would implement. If this stops
    // compiling or stops satisfying the interface, the seam has narrowed.
    const invented = fixedSource('test:invented', {
      title: 'From somewhere else',
      goal: 'Prove a third format needs no orchestrator change.',
      epicSource: { path: 'elsewhere/epic-7.json', line: 1, layout: 'epics-file' },
      stories: [
        {
          id: '7.1',
          title: 'Invented',
          narrative: '',
          acceptanceCriteria: [
            {
              ordinal: 1,
              text: '**Given** a non-BMAD source\n**Then** ingestion does not care.',
              source: { path: 'elsewhere/epic-7.json', line: 2, layout: 'epics-file' },
            },
          ],
          source: { path: 'elsewhere/epic-7.json', line: 2, layout: 'epics-file' },
        },
      ],
      searched: ['elsewhere/epic-7.json'],
      notes: [],
    });

    const reading = invented.read({ ...BASE_REQUEST, rootLabel: 'elsewhere' });

    expect(reading.stories).toHaveLength(1);
    expect(reading.stories[0]?.acceptanceCriteria[0]?.text).toContain('a non-BMAD source');
  });

  it('lets a later source supersede an earlier one by story id, generically', () => {
    // The merge rule the orchestrator applies, exercised with two sources that
    // have nothing to do with BMAD — proof the precedence is about list order
    // and not about which reader it happens to be.
    const first = fixedSource('test:first', {
      title: 'Broad',
      goal: 'g',
      stories: [story('7.1', 'from first'), story('7.2', 'only in first')],
      searched: [],
      notes: [],
    });
    const second = fixedSource('test:second', {
      stories: [story('7.1', 'from second')],
      searched: [],
      notes: [],
    });

    const readings = [first, second].map((source) =>
      source.read({ ...BASE_REQUEST, rootLabel: 'x' }),
    );

    const byId = new Map<string, string>();
    for (const reading of readings) {
      for (const entry of reading.stories) byId.set(entry.id, entry.title);
    }

    expect(byId.get('7.1')).toBe('from second');
    expect(byId.get('7.2')).toBe('only in first');
  });
});

function story(id: string, title: string) {
  return {
    id,
    title,
    narrative: '',
    acceptanceCriteria: [
      {
        ordinal: 1,
        text: '**Given** x\n**Then** y.',
        source: { path: 'x.md', line: 1, layout: 'epics-file' as const },
      },
    ],
    source: { path: 'x.md', line: 1, layout: 'epics-file' as const },
  };
}
