import { describe, expect, it } from 'vitest';

import { CRITERION_STATUSES, GATE_STATUSES } from '../../../src/domain/result.js';
import {
  INFRA_ERROR_CLASSIFICATIONS,
  VERDICTS,
  type RunOutcome,
} from '../../../src/domain/run-outcome.js';
import { MARK_WIDTH, criterionMark, gateMark, verdictLine } from '../../../src/report/format.js';

/**
 * Any ANSI escape sequence (CSI). The report must carry no colour on any path,
 * so this is asserted rather than assumed. Written with the `\u001b` escape and
 * not a literal control character, so it survives a copy and shows in a diff.
 */
const ANSI = /\u001b\[/;

describe('status marks', () => {
  it('renders every CriterionStatus, exhaustively', () => {
    // Iterating the closed tuple rather than listing five literals: adding a
    // status without giving it a mark fails here as well as at compile time.
    for (const status of CRITERION_STATUSES) {
      expect(criterionMark(status)).toBeTruthy();
    }
    expect(CRITERION_STATUSES.map(criterionMark)).toEqual([
      '✓ pass',
      '✗ fail',
      '? needs_human',
      '– skipped',
      '! error',
    ]);
  });

  it('renders every GateStatus, exhaustively', () => {
    expect(GATE_STATUSES.map(gateMark)).toEqual(['✓ pass', '✗ fail', '– skipped']);
  });

  it('distinguishes error from fail — the classification this epic exists to preserve', () => {
    // `src/domain/result.ts` states it: `fail` is product evidence ("the branch
    // is wrong"), `error` is infrastructure ("we could not look"). A report that
    // renders them the same way tells an operator to fix a branch that may be
    // perfectly fine, and it is the exit-code table's 3-is-not-1 invariant
    // losing its last mile.
    expect(criterionMark('error')).not.toBe(criterionMark('fail'));
    // Specifically: `error` must not borrow the failure glyph.
    expect(criterionMark('error')).not.toContain('✗');
  });

  it('carries every distinction in text, so nothing depends on colour or on a glyph', () => {
    // The report is read through pipes and agent capture buffers far more often
    // than through a terminal. Each mark therefore names its status in words;
    // strip every non-word character and the five are still distinct.
    for (const status of CRITERION_STATUSES) {
      expect(criterionMark(status)).toContain(status);
      expect(criterionMark(status)).not.toMatch(ANSI);
    }
    const wordsOnly = CRITERION_STATUSES.map((s) => criterionMark(s).replace(/[^a-z_]/g, ''));
    expect(new Set(wordsOnly).size).toBe(CRITERION_STATUSES.length);
  });

  it('pads to one column width, so a marks column aligns without measuring', () => {
    // MARK_WIDTH is a constant rather than a max() over the marks computed at
    // render time: the alignment must not silently change when a status is
    // added, and a renderer measuring its own output is one more thing that can
    // differ between two runs.
    for (const status of CRITERION_STATUSES) {
      expect(criterionMark(status).length).toBeLessThanOrEqual(MARK_WIDTH);
    }
    for (const status of GATE_STATUSES) {
      expect(gateMark(status).length).toBeLessThanOrEqual(MARK_WIDTH);
    }
  });
});

describe('the verdict line', () => {
  it('names each product verdict', () => {
    for (const verdict of VERDICTS) {
      expect(verdictLine({ verdict })).toBe(`VERDICT: ${verdict}`);
    }
  });

  it('names the failing gate by id, because gateFailed carries an id and not a boolean', () => {
    // `src/domain/run-outcome.ts` wins over ADR-003's prose here, and repair
    // automation routes on the id: "fix the build" rather than "a gate failed".
    expect(verdictLine({ verdict: 'FAIL', gateFailed: 'build' })).toBe(
      "VERDICT: FAIL — gate 'build' failed",
    );
  });

  it('never reports an infrastructure failure as a product verdict', () => {
    // The product's central promise, at the last place it can be broken: an
    // infra run has no verdict at all, and the line says so rather than
    // borrowing FAIL. Exit 3, never exit 1.
    for (const classification of INFRA_ERROR_CLASSIFICATIONS) {
      const line = verdictLine({ infraError: classification });
      expect(line).toBe(`VERDICT: (none) — infra error: ${classification}`);
      for (const verdict of VERDICTS) {
        expect(line).not.toContain(verdict);
      }
    }
  });

  it('is deterministic and colourless', () => {
    const outcome: RunOutcome = { verdict: 'FAIL', gateFailed: 'lint' };
    expect(verdictLine(outcome)).toBe(verdictLine(outcome));
    expect(verdictLine(outcome)).not.toMatch(ANSI);
  });
});
