/**
 * Story 5.3, AC1 — reviewer guidance survives derivation.
 *
 * The gap this suite guards: the plan schema REQUIRES `reason` and `guidance` on every
 * `needs-human` arm (`src/schemas/plan.ts:474-478`) and the plan-author is explicitly
 * instructed to write them (`src/authoring/plan-prompt.ts:186-187`) — but until this story
 * `deriveCriterionResult` returned `{...base, status: 'needs_human'}` and both values went
 * nowhere. A NEEDS_HUMAN criterion reached a human with the contract's statement and
 * nothing else: no guidance, no reason, no pointer to evidence.
 *
 * That matters because NEEDS_HUMAN is exit 2, and exit 2 is a STOP. A stop that does not
 * say what to look at is a stop people learn to override.
 *
 * WHAT THIS SUITE DOES **NOT** TEST, deliberately: the NEEDS_HUMAN rule itself. That is
 * merged, and it has been defended twice — see the `never auto-passes` suite in
 * `criterion-result.test.ts`. This story extends what the function RETURNS, never what it
 * DECIDES. The one place the two meet is asserted here anyway: guidance must ride along
 * even in the pathological case where a plan wrongly supplied attempts, because a change
 * that carried guidance only on the no-attempt path would have quietly reintroduced the
 * "floor" variant review rejected in Epic 3.
 */

import { describe, expect, it } from 'vitest';

import { deriveCriterionResult } from '../../../src/domain/criterion-result.js';
import type {
  ContractCriterionRef,
  ProbeAttempt,
} from '../../../src/domain/criterion-result.js';
import { EVIDENCE_INLINE_CAP_BYTES } from '../../../src/domain/evidence.js';

const AUTOMATED: ContractCriterionRef = {
  criterionId: 'E5-01',
  statement: 'the checkout total matches the sum of the line items',
  severity: 'critical',
  verifiability: 'automated',
};

const HUMAN: ContractCriterionRef = {
  criterionId: 'E5-09',
  statement: 'the error copy reads as a human wrote it',
  severity: 'normal',
  verifiability: 'human',
};

const GUIDANCE = 'open the checkout page and read the three error states aloud';

function attempt(overrides: Partial<ProbeAttempt> = {}): ProbeAttempt {
  return {
    attempt: 1,
    observations: [],
    assertionEvaluations: [{ description: 'status is 200', satisfied: true }],
    evidence: [],
    durationMs: 10,
    ...overrides,
  };
}

describe('AC1 — a contract-human criterion carries its reviewer guidance', () => {
  it('carries the guidance and the reason the plan recorded', () => {
    const result = deriveCriterionResult(HUMAN, [], {
      needsHumanReason: 'human-verifiability',
      reviewerGuidance: GUIDANCE,
    });

    expect(result.status).toBe('needs_human');
    expect(result.needsHumanReason).toBe('human-verifiability');
    expect(result.reviewerGuidance?.text).toBe(GUIDANCE);
  });

  it('still carries the contract statement verbatim beside it', () => {
    // FR-29's one-line summary is the criterion's own wording, and guidance is an
    // ADDITION to it rather than a replacement: a reviewer needs both the sentence a
    // human wrote in the contract and the instructions the plan-author wrote for reading
    // it. A renderer must never synthesise either.
    const result = deriveCriterionResult(HUMAN, [], {
      needsHumanReason: 'human-verifiability',
      reviewerGuidance: GUIDANCE,
    });

    expect(result.statement).toBe(HUMAN.statement);
    expect(result.severity).toBe('normal');
  });

  it('is UNCONDITIONAL: guidance rides along even when the plan wrongly supplied attempts', () => {
    // The guard on Epic 3's rejected "floor" variant, transposed to this story. Carrying
    // guidance only on the zero-attempt path would make the delivery agree with a rule
    // the product does not have — and the criterion would silently lose its guidance in
    // exactly the case where somebody had wired a probe to a question no machine may
    // answer, which is when a reviewer most needs telling.
    const result = deriveCriterionResult(HUMAN, [attempt()], {
      needsHumanReason: 'human-verifiability',
      reviewerGuidance: GUIDANCE,
    });

    expect(result.status).toBe('needs_human');
    expect(result.reviewerGuidance?.text).toBe(GUIDANCE);
    expect(result.needsHumanReason).toBe('human-verifiability');
  });
});

describe("AC1 — the plan's own refusal (`not-safely-automatable`) carries guidance too", () => {
  it('carries the second reason distinctly from the first', () => {
    // Q39's two triggers are different KINDS of fact with different remedies, and the
    // difference is actionable: sharpening a `not-safely-automatable` criterion often
    // makes it automatable, while a `human-verifiability` one is never going to be.
    // Collapsing them into one value would throw that away.
    const result = deriveCriterionResult(AUTOMATED, [], {
      plannedNeedsHuman: true,
      needsHumanReason: 'not-safely-automatable',
      reviewerGuidance: 'counting rows safely needs a fixture database',
    });

    expect(result.status).toBe('needs_human');
    expect(result.needsHumanReason).toBe('not-safely-automatable');
    expect(result.reviewerGuidance?.text).toBe('counting rows safely needs a fixture database');
  });

  it('is unconditional here too', () => {
    const result = deriveCriterionResult(AUTOMATED, [attempt()], {
      plannedNeedsHuman: true,
      needsHumanReason: 'not-safely-automatable',
      reviewerGuidance: GUIDANCE,
    });

    expect(result.status).toBe('needs_human');
    expect(result.reviewerGuidance?.text).toBe(GUIDANCE);
  });
});

describe('the guidance is UNTRUSTED PROVIDER TEXT — redacted at derivation (AD-10)', () => {
  // It arrives from a plan-author CLI through the schema gate. `Prose` constrains shape,
  // not content. This is the same case `expected`/`actual` already close: those fields
  // "are persisted to result.json and printed to a terminal exactly like evidence is" and
  // would otherwise be "the one path by which a captured credential reaches a stored run
  // unredacted". Guidance is persisted and printed identically.
  //
  // Assembled from parts so the literal is not itself a greppable token in this file.
  const SEEDED = `API_TOKEN=${['sk', 'live'].join('-')}-guidanceleak`;

  it('does not let a seeded secret reach the derived result', () => {
    const result = deriveCriterionResult(HUMAN, [], {
      needsHumanReason: 'human-verifiability',
      reviewerGuidance: `check the admin console with ${SEEDED} in the header`,
    });

    // ABSENCE, not the presence of a marker. Output containing `[REDACTED]` with the
    // secret still beside it survives review in a way a raw leak does not (Epic 3 retro
    // §7), so the assertion that matters is over the whole serialized result.
    expect(JSON.stringify(result)).not.toContain('guidanceleak');
  });

  it('applies config-declared extra patterns to the guidance', () => {
    // AD-10's "config-declared extra patterns" reach the guidance through the same single
    // options bag that carries them to `expected`/`actual` — there is no second redaction
    // entry point for this field.
    const result = deriveCriterionResult(HUMAN, [], {
      needsHumanReason: 'human-verifiability',
      reviewerGuidance: 'the staging tenant is acme-internal-7788',
      extraPatterns: [/acme-internal-\d+/g],
    });

    expect(JSON.stringify(result)).not.toContain('acme-internal-7788');
  });

  it('treats guidance as captured output, never as a shell command', () => {
    // `{shellCommand: true}` narrows how far a sensitive header's value extends and is
    // for DECLARED command text only. Guidance is undeclared prose, so it takes the
    // fail-closed default: redaction runs to end of line.
    const result = deriveCriterionResult(HUMAN, [], {
      needsHumanReason: 'human-verifiability',
      reviewerGuidance: `curl -H "Authorization: Bearer ${SEEDED}" http://host/admin`,
    });

    expect(JSON.stringify(result)).not.toContain('guidanceleak');
  });
});

describe('the guidance is BOUNDED — FR-29 forbids unbounded output in a report', () => {
  it('truncates guidance past the cap and reports how much was withheld', () => {
    // An unbounded prose field written by a language model, printed into a terminal that
    // is often an agent's context window, is the FR-29 failure. The cap and the marker
    // format are the merged ones (Q49): renderers "print this and define no second cap".
    const long = 'g'.repeat(EVIDENCE_INLINE_CAP_BYTES + 500);

    const result = deriveCriterionResult(HUMAN, [], {
      needsHumanReason: 'human-verifiability',
      reviewerGuidance: long,
    });

    expect(result.reviewerGuidance?.truncated).toBe(true);
    expect(result.reviewerGuidance?.totalBytes).toBe(EVIDENCE_INLINE_CAP_BYTES + 500);
    expect(result.reviewerGuidance?.text.length).toBeLessThan(long.length);
  });

  it('leaves ordinary-length guidance untruncated and unpointed', () => {
    const result = deriveCriterionResult(HUMAN, [], {
      needsHumanReason: 'human-verifiability',
      reviewerGuidance: GUIDANCE,
    });

    expect(result.reviewerGuidance?.truncated).toBe(false);
    // No `fullPath`: guidance has no full copy on disk, and a pointer to a file that was
    // never written is worse than no pointer at all.
    expect(result.reviewerGuidance?.fullPath).toBeUndefined();
  });
});

describe('absence is handled without inventing anything', () => {
  it('omits both fields when the caller supplied neither', () => {
    // An older plan, or a direct API caller. The result must still be a valid
    // `needs_human` — it simply carries no guidance, and a renderer must not fill the gap
    // with a synthesised sentence.
    const result = deriveCriterionResult(HUMAN, []);

    expect(result.status).toBe('needs_human');
    expect(result.reviewerGuidance).toBeUndefined();
    expect(result.needsHumanReason).toBeUndefined();
  });

  it('does NOT infer the reason from the contract even though it could', () => {
    // `verifiability: human` implies `human-verifiability` — but inferring it here would
    // put a fact in the result whose source is this function rather than a recorded
    // input, and the plan gate (`schemas/plan.ts:1103-1124`) already refuses any plan
    // where the two disagree. Carried, never derived.
    const result = deriveCriterionResult(HUMAN, [], { reviewerGuidance: GUIDANCE });

    expect(result.needsHumanReason).toBeUndefined();
    expect(result.reviewerGuidance?.text).toBe(GUIDANCE);
  });

  it('omits guidance when the plan recorded an empty string', () => {
    // `Prose` has a minimum length, so this is unreachable through a parsed plan. It is
    // asserted because an empty guidance line rendered beneath a criterion reads as a
    // missing value rather than an absent one, and a reviewer cannot tell which.
    const result = deriveCriterionResult(HUMAN, [], {
      needsHumanReason: 'human-verifiability',
      reviewerGuidance: '',
    });

    expect(result.reviewerGuidance).toBeUndefined();
    expect(result.needsHumanReason).toBe('human-verifiability');
  });
});

describe('no other status gains these fields', () => {
  it.each(['pass', 'fail', 'error', 'skipped'] as const)(
    'a %s criterion carries neither, even when the options bag holds them',
    (status) => {
      // The options bag is shared by every derivation in a run (there is exactly ONE, by
      // design). Guidance leaking onto an automated criterion's result would put a
      // reviewer instruction on a criterion a machine already answered — and would render
      // a "what to check" block under a green line.
      const attempts: ProbeAttempt[] =
        status === 'skipped'
          ? []
          : [
              attempt({
                assertionEvaluations:
                  status === 'error'
                    ? []
                    : [{ description: 'status is 200', satisfied: status === 'pass' }],
                ...(status === 'error' ? { execError: { message: 'connection refused' } } : {}),
              }),
            ];

      const result = deriveCriterionResult(AUTOMATED, attempts, {
        needsHumanReason: 'not-safely-automatable',
        reviewerGuidance: GUIDANCE,
      });

      expect(result.status).toBe(status);
      expect(result.reviewerGuidance).toBeUndefined();
      expect(result.needsHumanReason).toBeUndefined();
    },
  );
});
