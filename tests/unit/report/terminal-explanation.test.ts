/**
 * Story 5.5 — the hypotheses block, and the label that is part of the acceptance criterion.
 *
 * "Clearly labeled non-authoritative" is in AC1, and the reason is a fact about readers
 * rather than about formatting: **an unlabelled hypothesis printed beside a verdict becomes
 * a finding in the reader's mind.** So this file asserts the label the way a reader would
 * meet it — on the heading, on every line, and before the verdict rather than after any
 * evidence — and asserts that the whole block is ABSENT, not empty, on a run nobody asked
 * to have explained.
 *
 * AD-11 is the other subject here: `src/report/**` renders a `RunResult` and computes
 * nothing. The renderer joins hypotheses to criteria by the id the model already carries,
 * and it neither re-redacts nor re-truncates — both happened at capture.
 *
 * ── VERIFIED RED ────────────────────────────────────────────────────────────────────────
 *   P10  the `NON-AUTHORITATIVE` marker removed from `EXPLANATION_HEADING`  →  the label
 *        test FAILED.
 *   P11  the `explanations === undefined` guard in `renderTerminal` replaced with an
 *        unconditional `section(...)`  →  "prints no block at all when nothing was
 *        explained" FAILED with an empty heading rendered over a run that never called a
 *        provider — the shape that would put an AI-shaped section on every AI-free run.
 */

import { describe, expect, it } from 'vitest';

import type { RunResult } from '../../../src/domain/run-result.js';
import { renderTerminal } from '../../../src/report/index.js';
import {
  EXPLANATION_DISCLAIMER,
  EXPLANATION_HEADING,
} from '../../../src/report/terminal.js';
import { SEEDED_SECRET, fullyPopulatedRunResult } from '../../fixtures/run-result.js';

function explained(explanation: string): RunResult {
  return {
    ...fullyPopulatedRunResult(),
    explanations: [{ criterionId: 'E7-03', explanation }],
  };
}

describe('AC1 — the block is clearly labeled non-authoritative', () => {
  it('names it as a hypothesis on the heading and on every line', () => {
    const output = renderTerminal(explained('the flag parser swallows unknown flags'));

    expect(output).toContain(EXPLANATION_HEADING);
    expect(output).toContain('NON-AUTHORITATIVE');
    expect(output).toContain(EXPLANATION_DISCLAIMER);
    // Repeated per line, so a hypothesis quoted out of the report into a ticket carries its
    // own status with it rather than arriving as an unattributed statement of fact.
    expect(output).toContain('(hypothesis)');
  });

  it('says out loud that it changed nothing', () => {
    const output = renderTerminal(explained('a guess'));

    // The specific claim a reader needs, in words rather than by implication.
    expect(output).toMatch(/did not affect the verdict/);
    expect(output).toMatch(/exit code/);
  });

  it('prints the hypothesis beside the criterion it belongs to', () => {
    const output = renderTerminal(explained('the flag parser swallows unknown flags'));

    expect(output).toMatch(/E7-03\s+\(hypothesis\) the flag parser swallows unknown flags/);
  });

  it('indents a multi-line hypothesis so it cannot read as a report row', () => {
    const output = renderTerminal(explained('first line\nsecond line'));
    const lines = output.split('\n');
    const index = lines.findIndex((line) => line.includes('first line'));

    expect(index).toBeGreaterThan(-1);
    // Model prose has no line discipline. An unindented continuation would read as a new
    // row in a report whose every other row is a mechanically derived fact.
    expect(lines[index + 1]).toMatch(/^\s{20,}second line$/);
  });
});

describe('the block is absent, not empty, when nothing was explained', () => {
  it('prints no block at all for a default run', () => {
    const output = renderTerminal(fullyPopulatedRunResult());

    // Absent rather than "(none)". Every other section prints a placeholder because its
    // subject always exists; a hypothesis section on an AI-free run would advertise a
    // feature the run deliberately did not use, on every run, forever.
    expect(output).not.toContain('hypothes');
    expect(output).not.toContain('NON-AUTHORITATIVE');
  });

  it('prints no block for an explicitly empty array either', () => {
    const output = renderTerminal({ ...fullyPopulatedRunResult(), explanations: [] });

    expect(output).not.toContain('NON-AUTHORITATIVE');
  });
});

describe('placement and hygiene', () => {
  it('sits after every mechanically derived section and before the verdict', () => {
    const output = renderTerminal(explained('a guess'));

    const evidence = output.indexOf('\nEvidence');
    const block = output.indexOf(EXPLANATION_HEADING);
    const verdict = output.trimEnd().lastIndexOf('\n');

    // A reader who stops before the block has read only facts, and the verdict still has
    // the last word — the non-authoritative material never gets to be the closing line.
    expect(evidence).toBeLessThan(block);
    expect(block).toBeLessThan(verdict);
  });

  it('does not re-redact or re-truncate — but a leak would still be visible here', () => {
    // Redaction happens at capture (AD-10) and renderers never re-redact. This asserts the
    // OUTCOME rather than the mechanism: whatever route the text took, the secret is not on
    // the terminal. Absence, never the presence of a marker (Epic 3 retro §7).
    const output = renderTerminal(explained('a hypothesis that mentions nothing secret'));

    expect(output).not.toContain(SEEDED_SECRET);
  });
});
