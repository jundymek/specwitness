/**
 * Story 5.3, AC2 — the block a human actually reads.
 *
 * AC2 is the half of this story that is easiest to fake: *"the report tells them exactly
 * what to check and where the relevant evidence lives."* A criterion can carry guidance in
 * its JSON and still reach a person as a bare red line, and the suite that only asserts the
 * field exists would not notice.
 *
 * So this file asserts the RENDERED TEXT, and it asserts the absences as hard as the
 * presences. The failure this story exists to fix is not a missing field — it is a stop
 * sign with nothing written on it. NEEDS_HUMAN is exit 2, and a stop that does not say what
 * to look at is a stop people learn to override.
 *
 * TWO THINGS THIS SUITE DEFENDS THAT ARE EASY TO LOSE LATER:
 *
 *  - **A renderer never synthesises.** Guidance comes from the plan, the statement comes
 *    from the frozen contract. A sentence invented here would be a fact the JSON view does
 *    not carry, which is the drift AD-11 forbids — so a criterion with no guidance must
 *    render without inventing text, not "helpfully" fill the gap.
 *  - **The block belongs to `needs_human` alone.** Rendering reviewer instructions under a
 *    green criterion tells a reader to go and check something a machine already answered.
 */

import { describe, expect, it } from 'vitest';

import { boundedText } from '../../../src/domain/evidence.js';
import { CRITERION_STATUSES } from '../../../src/domain/result.js';
import { renderTerminal } from '../../../src/report/terminal.js';
import { ENVIRONMENT, criterion, runResult } from './helpers.js';

const GUIDANCE = 'open the checkout page and read the three error states aloud';

function reportFor(...criteria: ReturnType<typeof criterion>[]): string {
  return renderTerminal(runResult({ outcome: { verdict: 'NEEDS_HUMAN' }, criteria }));
}

const contractHuman = (overrides = {}) =>
  criterion('E5-09', 'needs_human', {
    statement: 'the error copy reads as a human wrote it',
    needsHumanReason: 'human-verifiability',
    reviewerGuidance: boundedText(GUIDANCE),
    ...overrides,
  });

describe('AC2 — what to check', () => {
  it('prints the reviewer guidance beneath the criterion', () => {
    expect(reportFor(contractHuman())).toContain(GUIDANCE);
  });

  it('still prints the contract statement, which the guidance supplements and never replaces', () => {
    // FR-29's one-line summary is the criterion's own wording. A reviewer needs both the
    // sentence a human wrote in the contract and the instructions the plan-author wrote
    // for reading it; guidance that displaced the statement would lose the question.
    const report = reportFor(contractHuman());

    expect(report).toContain('the error copy reads as a human wrote it');
    expect(report).toContain(GUIDANCE);
  });

  it('renders the truncation marker when guidance was bounded, so nothing looks complete that is not', () => {
    const report = reportFor(contractHuman({ reviewerGuidance: boundedText('g'.repeat(9000)) }));

    expect(report).toContain('truncated');
    expect(report).toContain('9000 bytes');
  });

  it('tells the reader WHERE truncated guidance continues, not only how much was withheld', () => {
    // FR-29 wants the bound and a route to the rest. `truncationMarker` gives the first
    // half alone, and it can only print a `fullPath` when a file exists in the RUN to point
    // at — guidance has none, because it is not lost: it is in the compiled plan, and the
    // derivation dropped the tail from the result rather than from the artifact.
    const report = reportFor(contractHuman({ reviewerGuidance: boundedText('g'.repeat(9000)) }));

    expect(report).toContain('the full guidance is in the compiled plan');
  });

  it('does NOT claim a plan lookup when the guidance fits', () => {
    // A pointer on untruncated content sends a reader to look up something they have
    // already read in full — the same reason `BoundedTextSchema` refuses a `fullPath` on
    // untruncated content.
    const report = reportFor(contractHuman());

    expect(report).not.toContain('the full guidance is in the compiled plan');
  });
});

describe('AC2 — WHY it is a human question, in the plan command vocabulary', () => {
  it('tells a `human-verifiability` reviewer that no machine may decide it', () => {
    // The contract's author wrote `verifiability: human`. No amount of sharpening changes
    // that, and the report must not imply otherwise.
    const report = reportFor(contractHuman());

    expect(report).toContain('no machine may decide it');
    expect(report).not.toContain('sharpening');
  });

  it('tells a `not-safely-automatable` reviewer the criterion could not be mapped to a safe probe', () => {
    // Borrowed from `src/cli/commands/plan.ts:357-364` rather than invented, so the
    // product says one thing about this in two places instead of two things.
    const report = reportFor(
      criterion('E5-04', 'needs_human', {
        needsHumanReason: 'not-safely-automatable',
        reviewerGuidance: boundedText('counting rows safely needs a fixture database'),
      }),
    );

    expect(report).toContain('could not be mapped to a safe probe');
    expect(report).toContain('sharpening the criterion often makes it automatable');
  });

  it('renders the two reasons DIFFERENTLY — they are different facts with different remedies', () => {
    // The guard against collapsing Q39's two triggers into one sentence. The second is
    // actionable and the first is not; a reader who cannot tell them apart is told either
    // to attempt the impossible or to give up on the tractable.
    const humanVerifiability = reportFor(contractHuman());
    const notAutomatable = reportFor(
      criterion('E5-04', 'needs_human', {
        needsHumanReason: 'not-safely-automatable',
        reviewerGuidance: boundedText(GUIDANCE),
      }),
    );

    const line = (report: string): string =>
      report.split('\n').find((entry) => entry.includes('why:')) ?? '';

    expect(line(humanVerifiability)).not.toBe('');
    expect(line(notAutomatable)).not.toBe('');
    expect(line(humanVerifiability)).not.toBe(line(notAutomatable));
  });
});

describe('AC2 — where the evidence lives', () => {
  it('names the run directory', () => {
    expect(reportFor(contractHuman())).toContain(ENVIRONMENT.runDirectory);
  });

  it('says honestly that the criterion has no evidence of its OWN', () => {
    // A `needs-human` plan arm is a strict object with no `probes` key at all
    // (`schemas/plan.ts:474-478`), so nothing probed this criterion and it has no evidence
    // by construction. Fabricating per-criterion refs to fill the block would be the
    // mirror of the defect this product exists to prevent.
    expect(reportFor(contractHuman())).toContain('no evidence of its own');
  });

  it('warns that screenshots and traces are NOT redacted', () => {
    // Coordinated verbatim with story 5.2 (see DECISIONS.md D5), not invented here. A
    // reviewer opening a trace must know that a text redactor cannot scrub pixels — and
    // the trace matters more than the screenshot, because a Playwright trace is a .zip
    // carrying page snapshots, network payloads and console text.
    const report = reportFor(contractHuman());

    expect(report).toContain('screenshots and traces are NOT redacted');
    expect(report).toContain('cannot be scrubbed by a text redactor');
  });

  it('names the trace as the LARGER exposure, with the reason the first line does not give', () => {
    // The first line's reason — a text redactor cannot scrub image content — is true of a
    // screenshot and NOT of a trace, whose content is text: DOM snapshots, network payloads
    // and console output. A reviewer acting on the first line alone would conclude the trace
    // is the safer of the two, when a credential inside one is greppable rather than merely
    // visible. Raised by 5.2 after its own review sharpened the fact.
    const report = reportFor(contractHuman());

    expect(report).toContain('a trace is the larger exposure');
    expect(report).toContain('DOM snapshots, network payloads and console output');
  });
});

describe('the block belongs to needs_human alone', () => {
  it.each(CRITERION_STATUSES.filter((status) => status !== 'needs_human'))(
    'renders no reviewer block for a %s criterion, even carrying the fields',
    (status) => {
      // The fields cannot legitimately appear on these statuses — `deriveCriterionResult`
      // never sets them there. Asserted anyway: a renderer is the last place this
      // visibility can be lost, and a hand-edited or third-party document can carry
      // anything.
      const report = renderTerminal(
        runResult({
          criteria: [
            criterion('E5-02', status, {
              needsHumanReason: 'human-verifiability',
              reviewerGuidance: boundedText(GUIDANCE),
            }),
          ],
        }),
      );

      expect(report).not.toContain(GUIDANCE);
      expect(report).not.toContain('check:');
      expect(report).not.toContain('screenshots and traces are NOT redacted');
    },
  );
});

describe('absence: it renders without crashing and without inventing text', () => {
  it('renders a needs_human criterion carrying no guidance at all', () => {
    // An older run, or a contract-human criterion whose plan predates this change. The
    // report must degrade to what it always showed rather than throw.
    const report = reportFor(criterion('E5-09', 'needs_human'));

    expect(report).toContain('E5-09');
    expect(report).toContain('NEEDS_HUMAN');
  });

  it('invents NOTHING when guidance is absent — no placeholder, no synthesised sentence', () => {
    // The named failure mode. A renderer that fills the gap reports a fact the JSON view
    // does not carry (AD-11), and the reader cannot tell the invented sentence from the
    // plan-author's own.
    const report = reportFor(criterion('E5-09', 'needs_human'));

    expect(report).not.toContain('check:');
    expect(report).not.toContain('(none)');
    expect(report).not.toContain('undefined');
  });

  it('still points at the evidence and the caveat when only the reason is missing', () => {
    // Guidance present, reason absent: the two fields are independent, and losing one must
    // not suppress the other.
    const report = reportFor(
      criterion('E5-09', 'needs_human', { reviewerGuidance: boundedText(GUIDANCE) }),
    );

    expect(report).toContain(GUIDANCE);
    expect(report).toContain(ENVIRONMENT.runDirectory);
    expect(report).not.toContain('why:');
  });

  it('renders the reason with no guidance without leaving a dangling label', () => {
    const report = reportFor(
      criterion('E5-09', 'needs_human', { needsHumanReason: 'human-verifiability' }),
    );

    expect(report).toContain('no machine may decide it');
    expect(report).not.toContain('check:');
  });
});

describe('FR-29 — the block stays bounded', () => {
  it('adds a small, fixed number of lines per needs_human criterion', () => {
    // An agent reading this report has a context window. The block is a handful of lines
    // whose only unbounded input is the guidance, which is capped at derivation.
    const withBlock = reportFor(contractHuman()).split('\n').length;
    const without = reportFor(criterion('E5-09', 'needs_human')).split('\n').length;

    expect(withBlock - without).toBeLessThanOrEqual(6);
  });
});
