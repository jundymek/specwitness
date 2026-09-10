import { describe, expect, it } from 'vitest';

import { buildPlanPrompt } from '../../../src/authoring/plan-prompt.js';
import { criterion, frozenContract } from '../../helpers/plan.js';

/**
 * Story 7.8 — the plan-author prompt learns the `file` surface exists, and learns its limit.
 *
 * ADR-009 records the cost it accepted: a declarative matcher makes it CHEAPER to write a
 * probe that passes over unmet work. The prompt is where that cost is either contained or
 * paid, so this file pins two things. The surface is named, with what it can and cannot
 * decide. And the refusal that already existed — map what you can probe safely, carry the
 * rest as needs-human — is still there word for word: a cheap probe must not become the
 * reason a criterion stops being handed to a human.
 */

const PROMPT = buildPlanPrompt(frozenContract([criterion('E7-01')]), {
  serviceIds: [],
  commandIds: [],
});

describe('the plan-author prompt and the file surface', () => {
  it('names file in the closed list of surfaces, beside the other four', () => {
    for (const surface of ['http', 'observation', 'shell', 'browser', 'file']) {
      expect(PROMPT, surface).toMatch(new RegExp(`^- ${surface}\\s+—`, 'm'));
    }
  });

  it('says a file probe reads the checked-out tree, runs nothing and needs no declared id', () => {
    expect(PROMPT).toContain('reads the CHECKED-OUT TREE under verification');
    expect(PROMPT).toContain('It runs no command and needs no declared id.');
  });

  it('forbids deciding a behavioural criterion by reading the source', () => {
    expect(PROMPT).toContain('A FILE PROBE ANSWERS WHAT THE TREE CONTAINS, NEVER WHAT THE SOFTWARE DOES.');
    expect(PROMPT).toContain('Never use it to decide a criterion about behaviour');
  });

  it('says a phrase in a document is a necessary condition, never proof that it explains', () => {
    expect(PROMPT).toContain('NECESSARY condition');
    expect(PROMPT).toContain('never proof that it does');
  });

  it('keeps the refusal to guess, word for word', () => {
    expect(PROMPT).toContain(
      '"not-safely-automatable" is the correct, expected answer, and it is always better than\na guessed probe.',
    );
    expect(PROMPT).toContain('that you cannot map to a probe you are confident in.');
  });

  it('states the file limits before the contract, where no bound can cut them', () => {
    expect(PROMPT.indexOf('NEVER WHAT THE SOFTWARE DOES')).toBeGreaterThan(-1);
    expect(PROMPT.indexOf('NEVER WHAT THE SOFTWARE DOES')).toBeLessThan(
      PROMPT.indexOf('THE FROZEN CONTRACT'),
    );
  });

  it('tells the author how a file path is written, and what is refused', () => {
    expect(PROMPT).toContain('relative to the repository root');
    expect(PROMPT).toContain('Never ".." and never an absolute path');
  });
});
