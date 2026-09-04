/**
 * Story 5.5, AC1 — THE INERTNESS PROOF. This file is the story.
 *
 * The acceptance criterion that matters is not "the explanation is useful". It is that the
 * verdict and results are **byte-identical with and without `--explain`** — and the point
 * of doing it here, over one `RunResult` object, is that NOTHING ELSE CAN VARY.
 *
 * Comparing two separate CLI invocations would force a long list of exclusions — run id,
 * both timestamps, every duration, the worktree path — every one of which differs between
 * any two runs whether or not `--explain` was passed. A comparison with a dozen exclusions
 * is a comparison that can hide a leak inside one of them. Here there is exactly one run,
 * explained and not explained, and exactly two exclusions:
 *
 *   1. `explanations` — the field the flag exists to add. Excluding the thing being added
 *      is the definition of the comparison, not a concession.
 *   2. `providerUsage` — an explained run GENUINELY made a provider call, so it genuinely
 *      has a usage entry. Q65 and FR-15 require every invocation to be recorded, and
 *      dropping the record to make this test pass would hide a subscription cost that
 *      those requirements exist to make visible. It is excluded from the byte comparison
 *      and asserted SEPARATELY and positively below, in both directions.
 *
 * Nothing else is excluded. If a third exclusion ever seems necessary, that is a defect
 * report, not a test edit.
 *
 * `tests/integration/verify-explain.test.ts` corroborates this end to end through the built
 * binary, where the run-varying fields DO have to be normalised — and validates that
 * normaliser against a control pair, so the normalisation cannot be what makes it pass.
 *
 * ── VERIFIED RED ────────────────────────────────────────────────────────────────────────
 * Four separate plants, each reverted immediately after (Epic 4 retro §3 lesson 7 — a
 * guard is only a guard once you have seen it fail):
 *
 *   P1  `attachExplanations` written to flip the first explained criterion's `status` to
 *       'pass'  →  "byte-identical" FAILED, and so did "the criteria array is untouched".
 *   P2  `attachExplanations` written to overwrite that criterion's `expected` with the
 *       hypothesis  →  "byte-identical" FAILED.
 *   P3  `explainRun`'s usage entry dropped on the success path  →  "the invocation is
 *       recorded" FAILED while "byte-identical" still passed — which is the exact pair of
 *       outcomes that would tempt somebody into deleting the record to go green.
 *   P4  the `outcome` object rebuilt by spread instead of carried through  →  "the outcome
 *       object is the SAME REFERENCE" FAILED while the byte comparison still passed,
 *       confirming the reference check tests something the bytes do not.
 */

import { describe, expect, it } from 'vitest';

import {
  attachExplanations,
  explainRun,
  type ExplainOutcome,
} from '../../../src/authoring/explain.js';
import type { RunResult } from '../../../src/domain/run-result.js';
import { serializeRunResult, toRunResultDocument } from '../../../src/schemas/result.js';
import { scriptedProvider } from '../../fakes/agent-provider.js';
import { FixedClock } from '../../fakes/ports.js';
import { fullyPopulatedRunResult } from '../../fixtures/run-result.js';

/** The fixture carries `E7-03` (fail) and `E7-06` (error) — the two explainable statuses. */
const VALID_RESPONSE = JSON.stringify({
  explanations: [
    { criterionId: 'E7-03', hypothesis: 'the flag parser maps unknown flags onto the generic failure path' },
    { criterionId: 'E7-06', hypothesis: 'the migration probe never reached the database' },
  ],
});

function clock(): FixedClock {
  return new FixedClock('2026-09-04T00:00:00.000Z', '2026-09-04T00:00:02.000Z');
}

async function explainFixture(base: RunResult): Promise<ExplainOutcome> {
  return await explainRun({
    result: base,
    provider: scriptedProvider(VALID_RESPONSE),
    providerName: 'hermetic',
    clock: clock(),
  });
}

/**
 * The explained run with EXACTLY the two stated exclusions removed.
 *
 * `providerUsage` is restored to the unexplained run's own array rather than sliced by
 * length, so a defect that reordered or rewrote a pre-existing entry (a run that
 * auto-compiled a plan already has one) cannot survive by leaving the count right.
 */
function withoutExplainerFields(explained: RunResult, base: RunResult): RunResult {
  return { ...explained, providerUsage: base.providerUsage, explanations: undefined };
}

describe('AC1 — the persisted run is byte-identical with and without --explain', () => {
  it('serializes to the same bytes once the explanation and the usage record are set aside', async () => {
    const base = fullyPopulatedRunResult();
    const before = serializeRunResult(base);

    const outcome = await explainFixture(base);
    const explained = attachExplanations(base, outcome);

    // The whole story, in one assertion, over the ONE function that turns a `RunResult`
    // into bytes (`src/schemas/result.ts`). Not "the verdict was the same" — that is the
    // weaker claim, and it would pass over a real leak of the explainer into results.
    expect(serializeRunResult(withoutExplainerFields(explained, base))).toBe(before);

    // And the explanation really was produced, so the assertion above is not passing
    // because nothing happened.
    expect(explained.explanations).toHaveLength(2);
  });

  it('does not mutate the run it was given', async () => {
    const base = fullyPopulatedRunResult();
    const before = serializeRunResult(base);

    attachExplanations(base, await explainFixture(base));

    // `explainRun` is handed the result and returns a value; `attachExplanations` spreads.
    // Neither may write through the reference it was given — a caller that rendered `base`
    // after explaining would otherwise see a different report than the one it persisted.
    expect(serializeRunResult(base)).toBe(before);
    expect(base.explanations).toBeUndefined();
  });

  it('leaves the criteria array byte-for-byte untouched', async () => {
    const base = fullyPopulatedRunResult();
    const explained = attachExplanations(base, await explainFixture(base));

    // Stated separately from the whole-document comparison because it is the array a
    // verdict is computed from, and because it localises a failure: this assertion names
    // `criteria` where the document-wide one would only say "the bytes differ".
    expect(JSON.stringify(explained.criteria)).toBe(JSON.stringify(base.criteria));
    // Reference identity, not just equality: the array is carried through, not rebuilt.
    expect(explained.criteria).toBe(base.criteria);
  });

  it('carries the outcome, gates, evidence and stages through by reference', async () => {
    const base = fullyPopulatedRunResult();
    const explained = attachExplanations(base, await explainFixture(base));

    // Reference identity is strictly stronger than the byte comparison and catches a
    // different defect: a field REBUILT from its own parts serializes identically today
    // and drifts the first time either side grows an optional key.
    expect(explained.outcome).toBe(base.outcome);
    expect(explained.gates).toBe(base.gates);
    expect(explained.evidence).toBe(base.evidence);
    expect(explained.stages).toBe(base.stages);
    expect(explained.contract).toBe(base.contract);
    expect(explained.environment).toBe(base.environment);
  });

  it('changes exactly two top-level document keys and no others', async () => {
    const base = fullyPopulatedRunResult();
    const explained = attachExplanations(base, await explainFixture(base));

    const before = toRunResultDocument(base) as unknown as Record<string, unknown>;
    const after = toRunResultDocument(explained) as unknown as Record<string, unknown>;

    // Enumerated rather than asserted one by one, so a key added to the document by a
    // future story is covered by this guard the day it appears rather than the day
    // somebody remembers to extend a list.
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
      (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
    );

    expect(changed.sort()).toEqual(['explanations', 'providerUsage']);
  });
});

describe('AC1 — the weaker guard: the verdict itself never moves', () => {
  it('reports the same outcome with and without an explanation', async () => {
    const base = fullyPopulatedRunResult();
    const explained = attachExplanations(base, await explainFixture(base));

    // Deliberately the SECOND assertion in this file and not the first. "The verdict was
    // the same in both runs" is what a reader expects this story to check, and it is the
    // claim that would pass over a leak into `expected`, into an evidence member or into a
    // criterion's status while the top-level verdict happened to stay put.
    expect(explained.outcome).toEqual(base.outcome);
    expect(explained.criteria.map((c) => c.status)).toEqual(base.criteria.map((c) => c.status));
  });
});

describe('Q65/FR-15 — the excluded provider usage is recorded, not dropped', () => {
  it('appends exactly one explainer entry, preserving what was already there', async () => {
    const base = fullyPopulatedRunResult();
    const explained = attachExplanations(base, await explainFixture(base));

    expect(explained.providerUsage).toHaveLength(base.providerUsage.length + 1);
    // The pre-existing entries are untouched and still first — a run that auto-compiled a
    // plan must not lose its `plan-author` record to this append.
    expect(explained.providerUsage.slice(0, base.providerUsage.length)).toEqual(
      base.providerUsage,
    );

    const added = explained.providerUsage.at(-1);
    expect(added?.role).toBe('explainer');
    expect(added?.provider).toBe('hermetic');
    expect(added?.attempts).toBe(1);
    // Never guessed. `AgentProvider.generate` returns raw text and the AD-2 envelope has
    // no metadata slot, so an honest null beats an invented model string.
    expect(added?.model).toBeNull();
  });

  it('records nothing at all when the explainer was never invoked', async () => {
    const base = fullyPopulatedRunResult();

    // The other direction, and the one that catches a usage entry minted for a call that
    // never happened: a run with no explainable criterion spends nothing and reports
    // nothing.
    const clean: RunResult = {
      ...base,
      criteria: base.criteria.filter((c) => c.status !== 'fail' && c.status !== 'error'),
    };

    const outcome = await explainRun({
      result: clean,
      provider: scriptedProvider(VALID_RESPONSE),
      providerName: 'hermetic',
      clock: clock(),
    });

    expect(outcome.providerUsage).toEqual([]);
    expect(outcome.explanations).toEqual([]);
    expect(outcome.note).toMatch(/nothing to explain/);
    expect(attachExplanations(clean, outcome).providerUsage).toBe(clean.providerUsage);
  });
});
