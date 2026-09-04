/**
 * Story 5.6, AC1 — the adaptation block in the human report.
 *
 * ⚠️ **THE PROPERTY UNDER TEST IS THAT AN ADAPTED PASS CANNOT READ AS AN ORDINARY PASS.**
 * A criterion that passed after its probe was rewritten renders in the Criteria section
 * exactly like one that passed as compiled, so the run-level block carries the whole
 * message. If it were missing, silent, or vague about WHICH probe changed, a human reading
 * the report would draw a conclusion the run does not support — and "a verification tool
 * that returns a plausible-looking wrong answer is the worst failure this product has"
 * (Epic 4 retro §2 observation 5).
 *
 * VOCABULARY, agreed with 5.5 at wave-3 intent-sync: this block says "adapted"/"changed"
 * and never "retry", "flaky", "explanation" or "hypothesis". The last test asserts it,
 * because a collision would only be noticed by whoever reads both blocks at once — which is
 * nobody, until it matters.
 */

import { describe, expect, it } from 'vitest';

import type { RunAdaptation } from '../../../src/domain/adaptation.js';
import type { RunResult } from '../../../src/domain/run-result.js';
import { renderTerminal } from '../../../src/report/terminal.js';
import { fullyPopulatedRunResult } from '../../fixtures/run-result.js';

function render(adaptation?: RunAdaptation): string {
  const base = fullyPopulatedRunResult();
  return renderTerminal(adaptation === undefined ? base : { ...base, adaptation });
}

const APPLIED: RunAdaptation = {
  adapted: true,
  applied: [
    {
      criterionId: 'E7-01',
      probeId: 'submit-order',
      field: 'scenario',
      from: { text: 'click "#create-company"', truncated: false, totalBytes: 23 },
      to: { text: 'click "#add-organization"', truncated: false, totalBytes: 25 },
    },
  ],
};

describe('an adapted run says so, and says what changed', () => {
  it('names the probe, the field, and BOTH sides of the change', () => {
    const report = render(APPLIED);

    expect(report).toContain('Adaptation');
    expect(report).toContain('E7-01');
    expect(report).toContain('submit-order');
    expect(report).toContain('scenario');
    // Both sides: a reader cannot judge an adaptation from the new value alone.
    expect(report).toContain('click "#create-company"');
    expect(report).toContain('click "#add-organization"');
  });

  it('warns that a criterion may have passed by looking somewhere else', () => {
    expect(render(APPLIED)).toMatch(/DIFFERENT place/);
  });

  it('states that the plan file on disk was not modified', () => {
    // The reassurance a reader most needs from this block, and a fact rather than a promise:
    // `applyAdaptation` is pure and has no file system in scope.
    expect(render(APPLIED)).toMatch(/plan file on disk was NOT modified/);
  });

  it('sits immediately after the criteria and before the counts', () => {
    // Placement agreed with 5.5: my block here, the non-authoritative one last. A reader who
    // has just seen a criterion pass is the reader who needs to know the probe was changed.
    const report = render(APPLIED);

    expect(report.indexOf('Criteria')).toBeLessThan(report.indexOf('Adaptation'));
    expect(report.indexOf('Adaptation')).toBeLessThan(report.indexOf('Counts'));
  });
});

describe('a refused proposal is shown as a refusal, not as an adaptation', () => {
  const refused: RunAdaptation = {
    adapted: false,
    applied: [],
    refusal: {
      text: 'the mechanics adaptation was refused after 3 attempts: mechanics: Unrecognized key',
      truncated: false,
      totalBytes: 84,
    },
  };

  it('says nothing was applied, and why', () => {
    const report = render(refused);

    expect(report).toMatch(/No adaptation was applied/);
    expect(report).toContain('Unrecognized key');
  });

  it('does not claim a criterion may have passed by looking elsewhere', () => {
    // The refusal path must not borrow the applied path's warning: nothing changed, so the
    // results are exactly what the compiled plan produced and the report says so.
    expect(render(refused)).not.toMatch(/DIFFERENT place/);
    expect(render(refused)).toMatch(/exactly what the compiled plan/);
  });
});

describe('an unadapted run renders no block at all', () => {
  it('says nothing about adaptation', () => {
    const report = render();

    expect(report).not.toContain('Adaptation');
    expect(report).not.toContain('adapted');
  });
});

describe('the vocabulary split with 5.4 and 5.5', () => {
  it('never calls an adaptation a retry or a flake', () => {
    // 5.4 owns `attempts`/`flaky`/`flakiness.*` and they mean repetition of an UNCHANGED
    // probe. One word for two things in one report is how a reader stops trusting either.
    const block = render(APPLIED).split('Adaptation')[1]?.split('Counts')[0] ?? '';

    expect(block).not.toMatch(/retr(y|ied|ies)/i);
    expect(block).not.toMatch(/flak/i);
  });

  it('never calls an adaptation an explanation or a hypothesis', () => {
    // 5.5's words, reserved by agreement so a reader can tell a hypothesis that changed
    // nothing from an applied change to what was executed.
    const block = render(APPLIED).split('Adaptation')[1]?.split('Counts')[0] ?? '';

    expect(block).not.toMatch(/explanation|explainer|hypothesis/i);
  });
});

describe('bounding (FR-29)', () => {
  it('prints truncated content with the one truncation marker and no second cap', () => {
    const long = 'click "#' + 'x'.repeat(400) + '"';
    const report = render({
      adapted: true,
      applied: [
        {
          criterionId: 'E7-01',
          probeId: 'submit-order',
          field: 'scenario',
          from: { text: 'click "#old"', truncated: false, totalBytes: 12 },
          to: { text: long, truncated: true, totalBytes: 4096 },
        },
      ],
    } satisfies RunAdaptation);

    // The renderer prints what it was given and appends the shared marker; it never
    // re-truncates and never opens a file (AD-10, AD-11).
    expect(report).toContain(long);
    expect(report).toMatch(/truncated/i);
  });
});

/** The renderer must never widen a `RunResult` it was handed. */
describe('AD-11 — the renderer computes no fact of its own', () => {
  it('renders only from the record it was given', () => {
    const result: RunResult = { ...fullyPopulatedRunResult(), adaptation: APPLIED };
    const first = renderTerminal(result);

    expect(renderTerminal(result)).toBe(first);
  });
});
