/**
 * `fenceMask` and the tagged inner fence — action item **e2-5a-i**, carried
 * from Epic 2 and closed here.
 *
 * WHY THIS FILE EXISTS AT ALL, and why it is not a corpus fixture. e2-5a-i was
 * scheduled as a rider on story 6.2 on the expectation that "its fixtures
 * ingest real BMAD markdown" (`sprint-status.yaml`). They do not, and cannot:
 * every Golden Corpus fixture ships a PRECOMPILED plan, so `verify` compiles
 * nothing and never reaches `src/ingest/**` (FR-18). The defect is real and it
 * is reachable — through the `contract` authoring path, which reads a project's
 * epics and story files — but not through anything the corpus runs. So it is
 * pinned here, at the unit boundary, where the behaviour actually lives.
 *
 * WHAT WAS WRONG. A closing fence may not carry an info string (CommonMark
 * §4.5): ```` ```js ```` can only ever OPEN a block. `fenceMask` compared only
 * the marker's kind and length, so a tagged fence written inside a plain block
 * closed it. Everything after it was then read as document structure until the
 * block's real close re-opened the mask — so the damage is not one line but the
 * remainder of the file, with the mask inverted. `markdown.ts`'s own header
 * says what that costs: "a `### Story 7.2` inside an example would invent a
 * story that does not exist".
 *
 * A story file showing a tagged example inside a plain fenced block is an
 * entirely ordinary thing to write, which is what made this worth closing.
 */

import { describe, expect, it } from 'vitest';

import { fenceMask } from '../../../src/ingest/bmad-v6/markdown.js';

describe('fenceMask and the info string', () => {
  it('does not let a tagged inner fence close the block that contains it', () => {
    const lines = [
      'Before the block.',
      '```',
      'An example, written inside a code block:',
      '```js',
      '### Story 9.9: a heading that exists only inside the example',
      '```',
      'After the block.',
    ];

    // Line 3 carries an info string, so it cannot be a close — it is content.
    // Line 4 is therefore content too, and the epics reader must never see it
    // as a heading. Line 5 is bare and closes the block.
    //
    // BEFORE THE FIX this returned `[false, true, true, true, false, true,
    // true]`: line 3 closed the block, line 4 escaped and became STRUCTURAL,
    // and line 5 re-opened the mask so the text after the block was swallowed.
    // Both halves of that are wrong and the second is the one that keeps going.
    expect(fenceMask(lines)).toEqual([false, true, true, true, true, true, false]);
  });

  it('still closes a plain block on a bare fence of the same kind and length', () => {
    // The behaviour that must NOT change. A guard that fixed the tagged case by
    // refusing to close anything would replace one wrong mask with another.
    expect(fenceMask(['a', '```', 'b', '```', 'c'])).toEqual([false, true, true, true, false]);
  });

  it('still treats a shorter or different inner fence as content', () => {
    // Both pre-existing rules, re-asserted here because this change touches the
    // same condition: a ``` inside a ```` block is content (length), and a ```
    // inside a ~~~ block is content (kind).
    expect(fenceMask(['````', '```', '````', 'after'])).toEqual([true, true, true, false]);
    expect(fenceMask(['~~~', '```', '~~~', 'after'])).toEqual([true, true, true, false]);
  });

  it('closes on a bare fence that is padded with trailing whitespace', () => {
    // Trailing spaces are not an info string. Refusing to close on them would
    // be a new false negative introduced by the fix itself.
    expect(fenceMask(['```', 'b', '```   ', 'c'])).toEqual([true, true, true, false]);
  });

  it('lets a tagged fence open a block, as it always could', () => {
    expect(fenceMask(['```ts', 'b', '```', 'c'])).toEqual([true, true, true, false]);
  });
});
