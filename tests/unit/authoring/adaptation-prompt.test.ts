/**
 * `buildAdaptationPrompt` — the mechanics-adapter prompt (story 5.6), given its first
 * dedicated suite by story 6.8.
 *
 * **THIS FILE DID NOT EXIST BEFORE STORY 6.8**, and its absence is part of the record.
 * Story 5.6 tested the adaptation FLOW (`adaptation.test.ts`, through the real merged gate)
 * and the response SCHEMA (`tests/unit/schemas/adaptation.test.ts`), but nothing asserted
 * anything about the assembled prompt's own bytes. That is precisely the module in which
 * the tail defect was rediscovered at round 13.
 *
 * Two properties are pinned here that this builder could not previously state about itself:
 *
 *  1. the instruction tail survives a candidate set large enough to blow the cap;
 *  2. a credential in ANY candidate field is absent from the assembled prompt, whatever the
 *     caller did or did not do first.
 *
 * On (2), stated precisely rather than loosely, because a loose version of this claim was
 * wrong in this very module's history: the production caller
 * (`src/pipeline/stages/probes.ts:512, 529-530`) redacts and bounds every candidate field
 * before building one, and it still does. What story 6.8 adds is that the guarantee no
 * longer depends on which layer the caller lives in.
 *
 * Secrets are asserted ABSENT, never `[REDACTED]`-present (Epic 3 retro §7).
 * Zero subprocesses, zero provider calls.
 */

import { describe, expect, it } from 'vitest';

import {
  ADAPTATION_PROMPT_CAP_BYTES,
  MAX_PROMPTED_CANDIDATES,
  buildAdaptationPrompt,
} from '../../../src/authoring/adaptation-prompt.js';
import type { AdaptationCandidate } from '../../../src/domain/adaptation-port.js';
import { SEEDED_SECRET } from '../../fixtures/run-result.js';

const encoder = new TextEncoder();
const bytes = (text: string): number => encoder.encode(text).length;

function candidate(overrides: Partial<AdaptationCandidate> = {}): AdaptationCandidate {
  return {
    criterionId: 'E7-01',
    statement: 'A user can create an organization from the orders page.',
    probeId: 'submit-order',
    path: '/orders',
    scenario: 'goto "/orders"\nclick "#create-company"',
    expected: 'Organizations',
    actual: '(no element matched "#create-company")',
    ...overrides,
  };
}

const TAIL_LINES = [
  '=== YOUR RESPONSE ===',
  'Respond with ONLY a JSON document of this shape, with no prose and no markdown fence:',
  '  {"proposals": [{"probeId": "...", "mechanics": {"scenario": "..."}}]}',
  'Include a probe only if you have a concrete reason to believe your proposal fixes it.',
  'Omitting a probe you cannot help is correct and costs nothing; guessing is not.',
];

describe('the instruction tail (story 6.8, AC1)', () => {
  it('survives a candidate set far larger than the cap', () => {
    // THE PATHOLOGICAL CASE for this builder. Twenty candidates is the count cap, and it
    // was the ONLY cap here before story 6.8 — a count says nothing about size, and a
    // scenario has no length limit in the plan schema. Twenty huge candidates is what an
    // unbounded prompt actually looked like.
    const candidates = Array.from({ length: MAX_PROMPTED_CANDIDATES }, (_unused, index) =>
      candidate({ probeId: `probe-${index}`, scenario: `click "#${'a'.repeat(4_000)}"` }),
    );

    const prompt = buildAdaptationPrompt(candidates);

    for (const line of TAIL_LINES) {
      expect(prompt).toContain(line);
    }
    // The bound really was reached, so nothing above passes vacuously.
    expect(bytes(prompt)).toBeLessThanOrEqual(ADAPTATION_PROMPT_CAP_BYTES);
    expect(prompt).toMatch(/… truncated: \d+ of \d+ bytes shown/);
  });

  it('is bounded at all, which it was not before story 6.8', () => {
    const candidates = Array.from({ length: MAX_PROMPTED_CANDIDATES }, () =>
      candidate({ statement: 'x'.repeat(10_000) }),
    );

    expect(bytes(buildAdaptationPrompt(candidates))).toBeLessThanOrEqual(
      ADAPTATION_PROMPT_CAP_BYTES,
    );
  });

  it('describes at most MAX_PROMPTED_CANDIDATES probes', () => {
    const candidates = Array.from({ length: MAX_PROMPTED_CANDIDATES + 5 }, (_unused, index) =>
      candidate({ probeId: `probe-${index}` }),
    );

    const prompt = buildAdaptationPrompt(candidates);

    expect(prompt).toContain('probe-0');
    expect(prompt).toContain(`probe-${MAX_PROMPTED_CANDIDATES - 1}`);
    expect(prompt).not.toContain(`probe-${MAX_PROMPTED_CANDIDATES}`);
  });
});

describe('SECURITY — a seeded credential never reaches the prompt (AC2)', () => {
  // Every field a candidate can carry, including the two that come from the project's own
  // committed plan. Plan content is not safe by virtue of being committed: `fill
  // "#password" "hunter2"` is an ordinary plan line, and a path can carry a query value.
  const fields = ['statement', 'path', 'scenario', 'expected', 'actual'] as const;

  for (const field of fields) {
    it(`is absent when it is seeded into ${field}`, () => {
      const prompt = buildAdaptationPrompt([
        candidate({ [field]: `AUTH_TOKEN=${SEEDED_SECRET}` }),
      ]);

      expect(prompt).not.toContain(SEEDED_SECRET);
    });
  }

  it('is absent when it arrives as a sensitive header line', () => {
    const prompt = buildAdaptationPrompt([
      candidate({ actual: `Authorization: Bearer ${SEEDED_SECRET}` }),
    ]);

    expect(prompt).not.toContain(SEEDED_SECRET);
  });

  it('applies config-declared extra patterns when a caller supplies them', () => {
    const prompt = buildAdaptationPrompt([candidate({ actual: 'codename ORCHID' })], {
      extraPatterns: [/ORCHID/g],
    });

    expect(prompt).not.toContain('ORCHID');
  });
});

describe('what the prompt still says (unchanged by story 6.8)', () => {
  it('states the prohibition, which is steering and not the mechanism', () => {
    // `MechanicsAdaptationSchema` is what enforces this — a `z.strictObject` with nowhere to
    // put an assertion. The sentence improves the success rate and nothing more. Story 6.8
    // changed assembly, never authority (AD-2).
    const prompt = buildAdaptationPrompt([candidate()]);

    expect(prompt).toContain('=== WHAT YOU MAY NOT CHANGE, AND CANNOT ===');
    expect(prompt).toMatch(/You may NOT change what must be TRUE/);
    expect(prompt).toMatch(/never names a host/);
  });

  it('states the four-verb scenario grammar', () => {
    const prompt = buildAdaptationPrompt([candidate()]);

    for (const verb of ['goto', 'click', 'fill', 'waitFor']) {
      expect(prompt).toContain(verb);
    }
  });

  it('carries the criterion statement and the probe mechanics', () => {
    const prompt = buildAdaptationPrompt([candidate()]);

    expect(prompt).toContain('A user can create an organization from the orders page.');
    expect(prompt).toContain('current path: /orders');
    expect(prompt).toContain('click "#create-company"');
    expect(prompt).toContain('the page actually gave: (no element matched "#create-company")');
  });

  it('omits expected and actual when the probe recorded neither', () => {
    const bare = candidate();
    const prompt = buildAdaptationPrompt([
      { ...bare, expected: undefined, actual: undefined } as AdaptationCandidate,
    ]);

    expect(prompt).not.toContain('the assertion expected:');
    expect(prompt).not.toContain('the page actually gave:');
  });
});
