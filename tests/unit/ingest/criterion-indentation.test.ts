import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ingestEpic } from '../../../src/ingest/index.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/ingest/', import.meta.url));

/**
 * AC1 "verbatim", the half that nothing else asserts.
 *
 * The story spec says criterion text is "preserved exactly as written apart
 * from trimming leading/trailing whitespace and the list marker itself … Do not
 * normalize case, punctuation, or internal whitespace, and do not reflow."
 *
 * Decision D3 reads "the list marker itself" as including the markdown
 * continuation indent that the marker creates — so exactly
 * `min(indent, contentIndent)` characters come off each continuation line, and
 * NOTHING more. That is the CommonMark dedent, and it is what makes the same
 * criterion produce identical text whether it was written as a numbered item in
 * a story file or as an unmarked block in the epics file.
 *
 * The risk in that reading is over-dedenting: strip a little too much and every
 * nested paragraph, YAML sample and code block inside a criterion loses its
 * shape, silently, in an artifact whose entire job is to say what the spec says.
 * This file is the evidence that it does not happen. Exact equality on a
 * hand-written expected string — never `toContain` — because "the text is
 * roughly right" is precisely the standard this product exists to replace.
 */

function ingestIndentationFixture() {
  return ingestEpic({
    projectRoot: join(FIXTURES, 'indentation'),
    epicId: '7',
    planningArtifacts: 'docs/planning-artifacts',
    implementationArtifacts: 'docs/implementation-artifacts',
  });
}

describe('criterion text keeps indentation deeper than the list content indent', () => {
  it('preserves a nested paragraph and an indented fenced block byte-for-byte', () => {
    const criterion = ingestIndentationFixture().stories[0]?.acceptanceCriteria[0];

    // Hand-written, not captured from the implementation. The list marker
    // `1. ` and the three-space continuation indent it creates are gone; every
    // space beyond that is still here.
    const expected = [
      '**Given** a criterion with a nested indented paragraph',
      '**When** it is ingested',
      '**Then** the nested paragraph keeps its extra indentation:',
      '',
      '    this paragraph is indented four spaces past the content indent',
      '      and this line two further',
      '',
      '**And** an indented fenced block keeps its interior spacing:',
      '',
      '```yaml',
      'planning:',
      '  planningArtifacts: docs/planning-artifacts',
      '    deeper: true',
      '```',
    ].join('\n');

    expect(criterion?.text).toEqual(expected);
  });

  it('removes the list indent and not one character more', () => {
    const text = ingestIndentationFixture().stories[0]?.acceptanceCriteria[0]?.text ?? '';
    const lines = text.split('\n');

    // The Given/When/Then lines sat at the content indent, so they are flush.
    expect(lines[0]?.startsWith('**Given**')).toBe(true);
    expect(lines[1]).toEqual('**When** it is ingested');

    // The nested paragraph was four spaces deeper than the content indent and
    // is still exactly four spaces deep. This is the assertion that fails the
    // moment anyone "simplifies" the dedent to a `trimStart()`.
    expect(lines[4]).toEqual(
      '    this paragraph is indented four spaces past the content indent',
    );
    expect(lines[5]).toEqual('      and this line two further');

    // Relative indentation inside the fenced sample is untouched.
    expect(lines[10]).toEqual('planning:');
    expect(lines[11]).toEqual('  planningArtifacts: docs/planning-artifacts');
    expect(lines[12]).toEqual('    deeper: true');
  });

  it('ends the criterion at the next list item rather than swallowing it', () => {
    // A dedent bug and a block-boundary bug look alike from a single criterion,
    // so pin the boundary too.
    const criteria = ingestIndentationFixture().stories[0]?.acceptanceCriteria ?? [];

    expect(criteria).toHaveLength(2);
    expect(criteria[1]?.text).toEqual(
      '**Given** a second criterion\n**Then** the first one ended where it should.',
    );
  });
});
