/**
 * Story 5.4 — the terminal half of "visibility is the entire mitigation".
 *
 * `terminal.ts` already prints `(flaky)` on a criterion and a run-level flaky count, and
 * its own comment says why: "a renderer is the last place that visibility can be lost".
 * What it could not print until this story is WHAT the failed attempt did, because a pass
 * result carries no expected, no actual and no evidence. A `(flaky)` marker a reader
 * cannot act on is a marker they learn to skim past — which is the laundering defect
 * arriving one step later than expected.
 */
import { describe, expect, it } from 'vitest';

import { renderTerminal } from '../../../src/report/terminal.js';
import type { DerivedCriterionResult } from '../../../src/domain/criterion-result.js';
import type { RunResult } from '../../../src/domain/run-result.js';
import { fullyPopulatedRunResult } from '../../fixtures/run-result.js';

function render(criteria: readonly DerivedCriterionResult[]): string {
  const result: RunResult = { ...fullyPopulatedRunResult(), criteria: [...criteria] };
  return renderTerminal(result);
}

const CLEAN: DerivedCriterionResult = {
  criterionId: 'E5-10',
  status: 'pass',
  statement: 'the health endpoint answers 200',
  severity: 'normal',
};

const FLAKY_PASS: DerivedCriterionResult = {
  criterionId: 'E5-01',
  status: 'pass',
  flaky: true,
  statement: 'the health endpoint answers 200',
  severity: 'critical',
  attempts: [
    {
      attempt: 1,
      outcome: 'fail',
      durationMs: 41,
      expected: '200',
      actual: '500',
      evidence: [{ kind: 'http', path: 'probes/http-e5-01-01.response.txt' }],
    },
    { attempt: 2, outcome: 'pass', durationMs: 17 },
  ],
};

const EXHAUSTED: DerivedCriterionResult = {
  criterionId: 'E5-02',
  status: 'fail',
  statement: 'the search endpoint answers 200',
  severity: 'critical',
  expected: '200',
  actual: '500',
  attempts: [
    { attempt: 1, outcome: 'fail', durationMs: 11 },
    { attempt: 2, outcome: 'fail', durationMs: 12 },
    { attempt: 3, outcome: 'fail', durationMs: 13 },
  ],
};

describe('per-attempt detail beneath a retried criterion', () => {
  it('names every attempt, its outcome and its duration', () => {
    const report = render([FLAKY_PASS]);

    expect(report).toContain('attempt 1 of 2: fail');
    expect(report).toContain('attempt 2 of 2: pass');
  });

  it("shows the FAILED attempt's expected/actual, which the pass result itself has none of", () => {
    const report = render([FLAKY_PASS]);

    expect(report).toContain('500');
    expect(report).toContain('200');
  });

  it("points at the failed attempt's own evidence file", () => {
    expect(render([FLAKY_PASS])).toContain('probes/http-e5-01-01.response.txt');
  });

  it('still prints the merged `(flaky)` marker — the detail supplements it, never replaces it', () => {
    expect(render([FLAKY_PASS])).toContain('(flaky)');
  });

  it('shows all three attempts when retries were exhausted, though nothing is flaky', () => {
    // AC2: retries never change classification, only repetition. A reader debugging an
    // exhausted retry needs the earlier attempts exactly as much as a flake reader does.
    const report = render([EXHAUSTED]);

    expect(report).toContain('attempt 1 of 3: fail');
    expect(report).toContain('attempt 3 of 3: fail');
    expect(report).not.toContain('(flaky)');
  });

  it('prints NO attempt detail for the ordinary single-attempt run', () => {
    // The shipped default is zero retries, so this is what almost every report looks like.
    // Attempt detail there would be noise on every line of every run (FR-29).
    const report = render([CLEAN]);

    expect(report).not.toContain('attempt 1');
    expect(report).toContain('0 flaky');
  });
});

describe('the run-level counts the terminal and the JSON must agree on', () => {
  it('reports the flaky count, and the repetition that produced it', () => {
    const report = render([FLAKY_PASS, EXHAUSTED, CLEAN]);

    expect(report).toContain('1 flaky');
    // SM-C3: the retry-to-green RATE must stay visible, so the denominator is printed too.
    expect(report).toContain('2 retried');
    expect(report).toContain('3 extra attempts');
  });

  it('says zero flaky rather than falling silent when nothing was retried', () => {
    expect(render([CLEAN])).toContain('0 flaky');
  });

  it('omits the repetition figures when there were none, keeping a clean run clean', () => {
    const report = render([CLEAN]);

    expect(report).not.toContain('retried');
    expect(report).not.toContain('extra attempts');
  });
});
