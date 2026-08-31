import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { IngestError } from '../../../src/domain/errors.js';
import { readEpicsFile } from '../../../src/ingest/bmad-v6/epics-file.js';
import { ingestEpic } from '../../../src/ingest/index.js';
import { epicSpecSchema } from '../../../src/schemas/epic-spec.js';

/**
 * Regressions for the three defects the Codex review found. Each was
 * reproduced before it was fixed, and each is pinned here so it cannot come
 * back — the review is a moment, the test is the guardrail.
 */

const FIXTURES = fileURLToPath(new URL('../../fixtures/ingest/', import.meta.url));

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'specwitness-ingest-'));
  scratch.push(dir);
  return dir;
}

const EPICS_MD = `# Sample

## Epic 7: Root Level

Goal paragraph.

### Story 7.1: Only story

As a fixture author,
I want one story,
So that a spec can be produced.

**Acceptance Criteria:**

**Given** a root-level artifact layout
**When** the epic is ingested
**Then** it succeeds.

---
`;

describe('P1 — paragraph criteria are not replaced by a trailing bullet list', () => {
  it('keeps the Given/When/Then criteria and ignores the trailing bullets', () => {
    // Before the fix, "any list item anywhere selects list mode" discarded both
    // paragraph criteria and returned the two `Notes` bullets instead — the
    // exact corruption this story exists to prevent, in the mirror direction.
    const reading = readEpicsFile({
      projectRoot: join(FIXTURES, 'paragraph-then-bullets'),
      epicNumber: 7,
      epicId: 'epic-7',
      rootLabel: 'docs/planning-artifacts',
    });

    const criteria = reading.stories[0]?.acceptanceCriteria ?? [];

    expect(criteria).toHaveLength(2);
    expect(criteria[0]?.text).toBe(
      '**Given** paragraph-style criteria\n' +
        '**When** a bullet list follows them\n' +
        '**Then** the paragraphs are still the criteria.',
    );
    expect(criteria[1]?.text).toBe(
      '**Given** a second paragraph criterion\n' +
        '**When** the same section ends with bullets\n' +
        '**Then** this one survives too.',
    );

    const all = criteria.map((criterion) => criterion.text).join('\n');
    expect(all).not.toContain('must never become a criterion');
    expect(all).not.toContain('Notes (not criteria)');
  });

  it('still takes the list when a lead-in paragraph introduces it', () => {
    // The other side of the same decision must not regress: a real story file
    // opens with `From ...:` and its criteria ARE the list that follows.
    const spec = ingestEpic({
      projectRoot: join(FIXTURES, 'stories-only'),
      epicId: '7',
      planningArtifacts: 'docs/planning-artifacts',
      implementationArtifacts: 'docs/implementation-artifacts',
    });

    const first = spec.stories.find((story) => story.id === '7.1');
    expect(first?.acceptanceCriteria).toHaveLength(2);
    expect(first?.acceptanceCriteria[0]?.text.startsWith('**Given** a per-story file')).toBe(true);
  });
});

describe('P2 — an artifact root that is the project root itself', () => {
  it('produces relative source paths, not paths that look absolute', () => {
    // `relative(root, root)` is '', so naive interpolation produced
    // '/epics.md': read correctly, but not portable and rejected by the schema.
    const project = tempProject();
    writeFileSync(join(project, 'epics.md'), EPICS_MD, 'utf8');

    const spec = ingestEpic({
      projectRoot: project,
      epicId: '7',
      planningArtifacts: '.',
      implementationArtifacts: '.',
    });

    expect(spec.source.path).toBe('epics.md');
    expect(spec.stories[0]?.source.path).toBe('epics.md');
    expect(spec.stories[0]?.acceptanceCriteria[0]?.source.path).toBe('epics.md');
    expect(() => epicSpecSchema.parse(spec)).not.toThrow();
  });

  it('names a root-level path without a leading slash when the epic is absent', () => {
    const project = tempProject();
    writeFileSync(join(project, 'epics.md'), EPICS_MD, 'utf8');

    try {
      ingestEpic({
        projectRoot: project,
        epicId: '9',
        planningArtifacts: '.',
        implementationArtifacts: '.',
      });
      throw new Error('expected ingestEpic to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(IngestError);
      expect((error as IngestError).message).toContain('- epics.md');
      expect((error as IngestError).message).not.toContain('- /epics.md');
    }
  });
});

describe('P2 — containment holds through a symlink inside the root', () => {
  it('refuses a symlinked epics file pointing outside the project', () => {
    // The root-level realpath check passes here: the root itself is fine, and
    // only the entry inside it escapes. Containment has to be per-entry.
    const outside = tempProject();
    writeFileSync(join(outside, 'elsewhere.md'), EPICS_MD, 'utf8');

    const project = tempProject();
    const planning = join(project, 'docs', 'planning-artifacts');
    mkdirSync(planning, { recursive: true });
    symlinkSync(join(outside, 'elsewhere.md'), join(planning, 'epics.md'));

    expect(() =>
      ingestEpic({
        projectRoot: project,
        epicId: '7',
        planningArtifacts: 'docs/planning-artifacts',
        implementationArtifacts: 'docs/implementation-artifacts',
      }),
    ).toThrow(IngestError);
  });

  it('names the escaping path and classifies it as an artifact fault', () => {
    const outside = tempProject();
    writeFileSync(join(outside, 'elsewhere.md'), EPICS_MD, 'utf8');

    const project = tempProject();
    const planning = join(project, 'docs', 'planning-artifacts');
    mkdirSync(planning, { recursive: true });
    symlinkSync(join(outside, 'elsewhere.md'), join(planning, 'epics.md'));

    try {
      ingestEpic({
        projectRoot: project,
        epicId: '7',
        planningArtifacts: 'docs/planning-artifacts',
        implementationArtifacts: 'docs/implementation-artifacts',
      });
      throw new Error('expected ingestEpic to throw');
    } catch (error) {
      // IngestError, not ConfigError: the config named a legitimate root; the
      // escaping symlink is in the artifact tree, which is where to go look.
      expect(error).toBeInstanceOf(IngestError);
      expect((error as IngestError).message).toContain('docs/planning-artifacts/epics.md');
      expect((error as IngestError).message).toContain('outside the configured artifact root');
    }
  });

  it('refuses a symlinked epic story directory pointing outside the project', () => {
    const outside = tempProject();
    const realStories = join(outside, 'stories');
    mkdirSync(realStories, { recursive: true });
    writeFileSync(
      join(realStories, '7.1-x.md'),
      '# Story 7.1: X\n\n## Acceptance Criteria\n\n1. **Given** a\n   **Then** b.\n',
      'utf8',
    );

    const project = tempProject();
    const implementation = join(project, 'docs', 'implementation-artifacts');
    mkdirSync(implementation, { recursive: true });
    symlinkSync(realStories, join(implementation, 'epic-7-escape'));

    expect(() =>
      ingestEpic({
        projectRoot: project,
        epicId: '7',
        planningArtifacts: 'docs/planning-artifacts',
        implementationArtifacts: 'docs/implementation-artifacts',
      }),
    ).toThrow(/outside the configured artifact root/);
  });

  it('allows a symlink that stays inside the root', () => {
    // The boundary is the root, not the word "symlink" — a project that
    // symlinks one artifact file to another inside the same tree is fine.
    const project = tempProject();
    const planning = join(project, 'docs', 'planning-artifacts');
    mkdirSync(planning, { recursive: true });
    writeFileSync(join(planning, 'real-epics.md'), EPICS_MD, 'utf8');
    symlinkSync(join(planning, 'real-epics.md'), join(planning, 'epics.md'));

    const spec = ingestEpic({
      projectRoot: project,
      epicId: '7',
      planningArtifacts: 'docs/planning-artifacts',
      implementationArtifacts: 'docs/implementation-artifacts',
    });

    expect(spec.stories).toHaveLength(1);
    expect(spec.source.path).toBe('docs/planning-artifacts/epics.md');
  });
});
