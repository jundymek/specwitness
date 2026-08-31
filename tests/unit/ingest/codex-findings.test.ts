import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

describe('P2 (round 2) — an unparseable story heading refuses the whole ingest', () => {
  function ingestMalformed() {
    return ingestEpic({
      projectRoot: join(FIXTURES, 'malformed-story'),
      epicId: '7',
      planningArtifacts: 'docs/planning-artifacts',
      implementationArtifacts: 'docs/implementation-artifacts',
    });
  }

  it('refuses rather than returning only the story it could parse', () => {
    // Before the fix this succeeded with one story, silently dropping two —
    // a plausible EpicSpec that verifies less than it claims to.
    expect(ingestMalformed).toThrow(IngestError);
  });

  it('names the heading that claims a different epic', () => {
    try {
      ingestMalformed();
      throw new Error('expected ingestEpic to throw');
    } catch (error) {
      expect((error as IngestError).message).toContain('names epic 8');
      expect((error as IngestError).message).toContain('docs/planning-artifacts/epics.md:');
    }
  });

  it('names the heading that says Story but does not parse as one', () => {
    try {
      ingestMalformed();
      throw new Error('expected ingestEpic to throw');
    } catch (error) {
      expect((error as IngestError).message).toContain('looks like a story heading');
      expect((error as IngestError).message).toContain('seven-two');
    }
  });

  it('does not complain about a level-3 heading that is not about a story', () => {
    // `### Notes` is not a claim that a story lives there, so it is simply
    // skipped. Treating every unmatched heading as a defect would make the
    // parser refuse ordinary documentation.
    try {
      ingestMalformed();
      throw new Error('expected ingestEpic to throw');
    } catch (error) {
      expect((error as IngestError).message).not.toContain('Notes');
    }
  });

  it('leaves well-formed real artifacts unaffected', () => {
    // The guard must not fire on this repository's own epics, which are the
    // specimens the parser was written against.
    expect(() =>
      ingestEpic({
        projectRoot: fileURLToPath(new URL('../../../', import.meta.url)),
        epicId: '1',
        planningArtifacts: 'docs/planning-artifacts',
        implementationArtifacts: 'docs/implementation-artifacts',
      }),
    ).not.toThrow();
  });
});

describe('P2 (round 2) — unreadable directory metadata is a named IngestError', () => {
  it('reports an EACCES on an artifact entry as an IngestError naming the path', () => {
    // statSync's `throwIfNoEntry: false` suppresses ENOENT only. Unclassified,
    // an EACCES escapes as "this is a SpecWitness bug" — exit 3 either way, but
    // pointing the user at entirely the wrong thing.
    const project = tempProject();
    const implementation = join(project, 'docs', 'implementation-artifacts');
    const locked = join(implementation, 'locked');
    mkdirSync(locked, { recursive: true });
    mkdirSync(join(locked, 'epic-7-hidden'), { recursive: true });
    symlinkSync(join(locked, 'epic-7-hidden'), join(implementation, 'epic-7-via-locked'));
    chmodSync(locked, 0o000);

    try {
      expect(() =>
        ingestEpic({
          projectRoot: project,
          epicId: '7',
          planningArtifacts: 'docs/planning-artifacts',
          implementationArtifacts: 'docs/implementation-artifacts',
        }),
      ).toThrow(IngestError);
    } finally {
      // Restore before afterEach removes the tree, or cleanup itself fails.
      chmodSync(locked, 0o755);
    }
  });
});

describe('P2 (round 3) — a story file whose heading contradicts its filename', () => {
  it('refuses rather than attributing another story\'s criteria to this one', () => {
    // A copied-and-renamed artifact: named 7.1-copied.md, heading says 8.1.
    // Trusting the filename would put story 8.1's acceptance criteria into the
    // contract under 7.1, silently, with a source reference that looks right.
    expect(() =>
      ingestEpic({
        projectRoot: join(FIXTURES, 'heading-mismatch'),
        epicId: '7',
        planningArtifacts: 'docs/planning-artifacts',
        implementationArtifacts: 'docs/implementation-artifacts',
      }),
    ).toThrow(IngestError);
  });

  it('names both the filename story and the heading story', () => {
    try {
      ingestEpic({
        projectRoot: join(FIXTURES, 'heading-mismatch'),
        epicId: '7',
        planningArtifacts: 'docs/planning-artifacts',
        implementationArtifacts: 'docs/implementation-artifacts',
      });
      throw new Error('expected ingestEpic to throw');
    } catch (error) {
      expect((error as IngestError).message).toContain('named for story 7.1');
      expect((error as IngestError).message).toContain('heading says story 8.1');
    }
  });
});

describe('P2 (round 3) — the story source line is the heading, not line 1', () => {
  it('points at the H1 even when front matter precedes it', () => {
    // The H1 sits on line 6 of the fixture. Reporting line 1 would send a
    // reader to the front matter instead of to the story.
    const spec = ingestEpic({
      projectRoot: join(FIXTURES, 'frontmatter'),
      epicId: '7',
      planningArtifacts: 'docs/planning-artifacts',
      implementationArtifacts: 'docs/implementation-artifacts',
    });

    const story = spec.stories[0];
    expect(story?.id).toBe('7.1');
    expect(story?.title).toBe('Heading below front matter');
    expect(story?.source.line).toBe(6);
  });

  it('still reports line 1 when the heading really is the first line', () => {
    const spec = ingestEpic({
      projectRoot: join(FIXTURES, 'stories-only'),
      epicId: '7',
      planningArtifacts: 'docs/planning-artifacts',
      implementationArtifacts: 'docs/implementation-artifacts',
    });

    expect(spec.stories.find((story) => story.id === '7.1')?.source.line).toBe(1);
  });
});

describe('P1 (round 4) — a duplicate story id refuses the ingest', () => {
  it('refuses rather than keeping whichever declaration came last', () => {
    // Map.set kept the last one, so the contract depended on document order and
    // the other declaration's criteria vanished without a word.
    expect(() =>
      ingestEpic({
        projectRoot: join(FIXTURES, 'duplicate'),
        epicId: '7',
        planningArtifacts: 'docs/planning-artifacts',
        implementationArtifacts: 'docs/implementation-artifacts',
      }),
    ).toThrow(/story 7\.1 is declared twice/);
  });

  it('refuses two story FILES claiming the same id', () => {
    // 7.1-old.md and 7.1-new.md in one directory: whichever readdir listed last
    // would have won, so the contract depended on filesystem order.
    expect(() =>
      ingestEpic({
        projectRoot: join(FIXTURES, 'duplicate-files'),
        epicId: '7',
        planningArtifacts: 'docs/planning-artifacts',
        implementationArtifacts: 'docs/implementation-artifacts',
      }),
    ).toThrow(/story 7\.1 is defined twice/);
  });

  it('still lets a per-story file supersede the epics file for the same id', () => {
    // Cross-source precedence is deliberate (AC2) and must not be caught by the
    // duplicate rule — only ambiguity WITHIN one source is refused.
    const spec = ingestEpic({
      projectRoot: join(FIXTURES, 'both'),
      epicId: '7',
      planningArtifacts: 'docs/planning-artifacts',
      implementationArtifacts: 'docs/implementation-artifacts',
    });

    expect(spec.stories.map((story) => story.id)).toEqual(['7.1', '7.2', '7.3']);
    expect(spec.stories.find((story) => story.id === '7.1')?.source.layout).toBe('story-file');
  });
});

describe('P2 (round 4) — markdown inside a fenced block is not document structure', () => {
  function ingestFenced() {
    return ingestEpic({
      projectRoot: join(FIXTURES, 'fenced'),
      epicId: '7',
      planningArtifacts: 'docs/planning-artifacts',
      implementationArtifacts: 'docs/implementation-artifacts',
    });
  }

  it('does not invent a story from a heading inside an example', () => {
    // `### Story 7.2` lives inside a fenced example. Without fence tracking it
    // is a phantom story — or, as it happens here, the fenced
    // `## Acceptance Criteria` above it truncates the epic section first and
    // the phantom never appears. Both are wrong, so assert the whole shape
    // rather than only the story list, or this test passes for the wrong
    // reason.
    const spec = ingestFenced();

    expect(spec.stories.map((story) => story.id)).toEqual(['7.1']);
    expect(spec.stories[0]?.acceptanceCriteria).toHaveLength(2);
    // Every criterion is a real one, not a stray fence line promoted to a
    // criterion by a truncated section.
    expect(
      spec.stories[0]?.acceptanceCriteria.every((criterion) =>
        criterion.text.startsWith('**Given**'),
      ),
    ).toBe(true);
  });

  it('does not let a fenced `## Acceptance Criteria` truncate the real section', () => {
    // The count alone is not a discriminator: truncation also yields two, the
    // second being the literal fence line. Assert what they SAY.
    const criteria = ingestFenced().stories[0]?.acceptanceCriteria ?? [];

    expect(criteria[0]?.text.startsWith('**Given** a criterion containing a fenced example')).toBe(
      true,
    );
    expect(criteria[1]?.text.startsWith('**Given** a second real criterion after the fence')).toBe(
      true,
    );
  });

  it('does not let a fenced --- end the epic section early', () => {
    const spec = ingestFenced();

    expect(spec.title).toBe('Fences');
    expect(spec.stories[0]?.acceptanceCriteria[1]?.text).toContain(
      'a second real criterion after the fence',
    );
  });

  it('keeps the fenced example inside the criterion text, verbatim', () => {
    // Structure is read from unfenced lines; TEXT is always verbatim, because a
    // criterion may legitimately contain a code block.
    const text = ingestFenced().stories[0]?.acceptanceCriteria[0]?.text ?? '';

    expect(text).toContain('```markdown');
    expect(text).toContain('### Story 7.2: A phantom story');
    expect(text).toContain('```');
  });
});

describe('P2 (round 5) — a shorter fence does not close a longer one', () => {
  it('keeps a nested example fenced, so it cannot become a story or a section', () => {
    // CommonMark: a closing fence must be at least as long as the opener. A
    // check that compares only the fence character lets the inner ``` close the
    // outer ````, reopening the rest of the file to structural parsing.
    const spec = ingestEpic({
      projectRoot: join(FIXTURES, 'nested-fence'),
      epicId: '7',
      planningArtifacts: 'docs/planning-artifacts',
      implementationArtifacts: 'docs/implementation-artifacts',
    });

    expect(spec.stories.map((story) => story.id)).toEqual(['7.1']);

    const criteria = spec.stories[0]?.acceptanceCriteria ?? [];
    expect(criteria).toHaveLength(2);
    // Assert what they SAY, not just how many: truncation yields two as well.
    expect(criteria[0]?.text.startsWith('**Given** an outer fence of four backticks')).toBe(true);
    expect(
      criteria[1]?.text.startsWith('**Given** a second real criterion after the outer fence'),
    ).toBe(true);
    // The nested example survives inside the criterion, verbatim.
    expect(criteria[0]?.text).toContain('### Story 7.9: Phantom from a nested fence');
  });
});

describe('P2 (round 5) — an H1 claiming to be a story with no parseable id', () => {
  it('refuses rather than borrowing the id from the filename', () => {
    // `# Story 8.x: Copied` is not `# Story <epic>.<story>`. Treating it as an
    // ordinary title skipped the filename cross-check entirely and attributed
    // these criteria to 7.1 — the same fail-open branch, a third time.
    expect(() =>
      ingestEpic({
        projectRoot: join(FIXTURES, 'malformed-h1'),
        epicId: '7',
        planningArtifacts: 'docs/planning-artifacts',
        implementationArtifacts: 'docs/implementation-artifacts',
      }),
    ).toThrow(/looks like a story heading/);
  });

  it('still accepts an ordinary H1 that makes no claim about a story', () => {
    // A file titled `# Ingestion notes` is not claiming to be story 8.x, so the
    // filename remains the authority. Only a CLAIM triggers the refusal.
    const spec = ingestEpic({
      projectRoot: join(FIXTURES, 'stories-only'),
      epicId: '7',
      planningArtifacts: 'docs/planning-artifacts',
      implementationArtifacts: 'docs/implementation-artifacts',
    });

    expect(spec.stories.map((story) => story.id)).toEqual(['7.1', '7.2', '7.10']);
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
