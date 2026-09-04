/**
 * Story 5.5 — the explainer invocation: what is sent, what comes back, and what happens
 * when nothing does.
 *
 * Two properties this file exists for, above the rest:
 *
 *  - **A seeded credential never reaches the prompt.** Asserted as ABSENCE, never as the
 *    presence of `[REDACTED]` (Epic 3 retro §7: output carrying the marker WITH the secret
 *    still beside it passes a presence check in a way a raw leak does not). A prompt is
 *    data leaving the process; this is the last boundary before it does.
 *  - **Every failure route returns a value, never an exception.** AC2 requires the
 *    verification results to be unaffected in all five cases, and the module's contract is
 *    that `explainRun` cannot throw. Each route gets its own test — five routes, five
 *    tests — rather than one representative.
 *
 * AD-12: no test here spawns anything. The scripted double drives the REAL merged gate
 * (`src/providers/invoke.ts`) from the outside, so the retry loop, the schema rejection and
 * the attempt accounting under test are the shipped ones.
 *
 * ── VERIFIED RED ────────────────────────────────────────────────────────────────────────
 *   P5  `clip()` reduced to `value.slice(0, cap)` with the `redactText` call removed  →
 *       the STATEMENT and ACTUAL tests FAILED. The EVIDENCE test stayed green, correctly,
 *       and the split is the useful part of the finding: evidence is redacted at CAPTURE by
 *       the merged constructors, so `clip` is not what protects it, while `statement`
 *       travels verbatim from the contract and `clip` is its only boundary. Two different
 *       defences, and this plant tells them apart.
 *   P6  `explainRun`'s unknown-id filter (`known.has(...)`) deleted  →  "drops a criterion
 *       id this run does not carry" FAILED.
 *   P7  `attemptInvoke` swapped for `invoke` (the throwing arm)  →  the provider-error and
 *       schema-rejection route tests FAILED with `ProviderError` escaping, which is the
 *       defect the whole AC2 section exists to prevent.
 */

import { describe, expect, it } from 'vitest';

import {
  EXPLANATION_CAP_BYTES,
  MAX_EXPLAINED_CRITERIA,
  PROMPT_CAP_CHARS,
  buildExplainPrompt,
  explainRun,
  explainableCriteria,
} from '../../../src/authoring/explain.js';
import type { DerivedCriterionResult } from '../../../src/domain/criterion-result.js';
import type { RunResult } from '../../../src/domain/run-result.js';
import { scriptedProvider, throwingProvider } from '../../fakes/agent-provider.js';
import { FixedClock } from '../../fakes/ports.js';
import { SEEDED_SECRET, fullyPopulatedRunResult } from '../../fixtures/run-result.js';

const VALID = JSON.stringify({
  explanations: [{ criterionId: 'E7-03', hypothesis: 'the flag parser swallows unknown flags' }],
});

function clock(): FixedClock {
  return new FixedClock('2026-09-04T00:00:00.000Z', '2026-09-04T00:00:01.500Z');
}

async function explain(result: RunResult, provider: Parameters<typeof explainRun>[0]['provider']) {
  return await explainRun({ result, provider, providerName: 'hermetic', clock: clock() });
}

describe('which criteria are explained', () => {
  it('takes only fail and error, in the run order', () => {
    const ids = explainableCriteria(fullyPopulatedRunResult()).map((c) => c.criterionId);

    // `pass` has nothing to explain; `skipped` observed nothing to form a hypothesis from;
    // `needs_human` already carries a human's own reviewer guidance (story 5.3), and a
    // model's guess must not sit where a person's instructions belong.
    expect(ids).toEqual(['E7-03', 'E7-06']);
  });

  it('caps how many criteria one run pays to explain', () => {
    const base = fullyPopulatedRunResult();
    const template = base.criteria.find((c) => c.status === 'fail');
    expect(template).toBeDefined();

    const many: RunResult = {
      ...base,
      criteria: Array.from({ length: MAX_EXPLAINED_CRITERIA + 5 }, (_unused, index) => ({
        ...(template as DerivedCriterionResult),
        criterionId: `E9-${String(index).padStart(2, '0')}`,
      })),
    };

    expect(explainableCriteria(many)).toHaveLength(MAX_EXPLAINED_CRITERIA);
  });
});

describe('AC1 — the prompt carries the three required inputs, and nothing forbidden', () => {
  it('carries the statement, expected/actual and evidence summaries', () => {
    const result = fullyPopulatedRunResult();
    const prompt = buildExplainPrompt(result, explainableCriteria(result));

    expect(prompt).toContain('An unknown flag exits 64.');
    expect(prompt).toContain('expected: exit code 64');
    expect(prompt).toContain('actual: exit code 1');
    // Evidence summaries, built from each member's own already-bounded fields.
    expect(prompt).toContain('gate lint fail');
    expect(prompt).toContain('http GET');
  });

  it('tells the model its output is non-authoritative and may propose nothing', () => {
    const result = fullyPopulatedRunResult();
    const prompt = buildExplainPrompt(result, explainableCriteria(result));

    // The boundary against story 5.6's flow, stated in the prompt itself and not only in
    // the module header: an explainer produces text a human reads, never a change to an
    // executable artifact.
    expect(prompt).toContain('NON-AUTHORITATIVE');
    expect(prompt).toMatch(/Do NOT propose a change/);
    expect(prompt).toMatch(/Do NOT state whether/);
  });

  it('is bounded', () => {
    const base = fullyPopulatedRunResult();
    const template = base.criteria.find((c) => c.status === 'fail') as DerivedCriterionResult;
    const huge: RunResult = {
      ...base,
      criteria: Array.from({ length: MAX_EXPLAINED_CRITERIA }, (_unused, index) => ({
        ...template,
        criterionId: `E9-${index}`,
        statement: 'x'.repeat(50_000),
        actual: 'y'.repeat(50_000),
      })),
    };

    const prompt = buildExplainPrompt(huge, explainableCriteria(huge));

    // A prompt is a subscription cost and a context window. Summaries, not dumps.
    expect(prompt.length).toBeLessThanOrEqual(PROMPT_CAP_CHARS);
  });

  it('keeps the response instructions when the body is bounded away', () => {
    // FOUND BY REVIEW. Clipping the assembled prompt as one string bounds it correctly and
    // cuts off the WRONG END: the response-shape line and the valid-ids rule are last, so
    // exactly the runs with the most to explain would send a prompt that stops mid-sentence
    // and never says what to reply with — burning the whole retry budget on schema
    // rejections, precisely where the feature was most wanted.
    const base = fullyPopulatedRunResult();
    const template = base.criteria.find((c) => c.status === 'fail') as DerivedCriterionResult;
    const huge: RunResult = {
      ...base,
      criteria: Array.from({ length: MAX_EXPLAINED_CRITERIA }, (_unused, index) => ({
        ...template,
        criterionId: `E9-${index}`,
        statement: 'x'.repeat(50_000),
        actual: 'y'.repeat(50_000),
      })),
      // `result.evidence` is the genuinely UNBOUNDED input here — criteria are capped by
      // `MAX_EXPLAINED_CRITERIA` and every field by `FIELD_CAP_CHARS`, but a long run can
      // hold arbitrarily many evidence members. Repeating the fixture's own members is what
      // pushes this past the whole-prompt cap, so the test exercises the input that can
      // actually overflow it rather than one that merely looks large.
      evidence: Array.from({ length: 60 }, () => base.evidence).flat(),
    };

    const prompt = buildExplainPrompt(huge, explainableCriteria(huge));

    // The bound really was reached, so nothing below passes vacuously.
    expect(prompt.length).toBeGreaterThan(PROMPT_CAP_CHARS - 4_000);
    expect(prompt.length).toBeLessThanOrEqual(PROMPT_CAP_CHARS);

    // The instructions survive at BOTH ends.
    expect(prompt).toContain('NON-AUTHORITATIVE');
    expect(prompt).toMatch(/Do NOT propose a change/);
    expect(prompt).toContain('--- RESPOND WITH ONLY THIS JSON ---');
    expect(prompt).toContain('"criterionId"');
    expect(prompt).toContain('Use only criterionIds listed above');
    // And the body really was cut, so this is not passing because nothing was bounded.
    expect(prompt).toContain('…');
  });
});

describe('SECURITY — a seeded credential never reaches the prompt', () => {
  /**
   * The three routes a secret could take into a prompt, seeded one at a time so a failure
   * names which boundary leaked rather than only that one did.
   */
  function seeded(where: 'statement' | 'actual'): RunResult {
    const base = fullyPopulatedRunResult();
    return {
      ...base,
      criteria: base.criteria.map((criterion) =>
        criterion.criterionId === 'E7-03'
          ? { ...criterion, [where]: `AWS_SECRET_ACCESS_KEY=${SEEDED_SECRET}` }
          : criterion,
      ),
    };
  }

  it('not through the criterion statement — the one field nothing upstream redacts', () => {
    const result = seeded('statement');
    // `statement` travels VERBATIM from the frozen contract by design, so no earlier
    // boundary cleans it. This is the last line before the bytes leave the process.
    expect(buildExplainPrompt(result, explainableCriteria(result))).not.toContain(SEEDED_SECRET);
  });

  it('not through actual', () => {
    const result = seeded('actual');
    expect(buildExplainPrompt(result, explainableCriteria(result))).not.toContain(SEEDED_SECRET);
  });

  it('not through the evidence summaries', () => {
    // The fixture's gate evidence carries the secret in `displayCommand` AND in `stdout`,
    // fed through the real redacting constructors at capture.
    const result = fullyPopulatedRunResult();
    expect(buildExplainPrompt(result, explainableCriteria(result))).not.toContain(SEEDED_SECRET);
  });

  it('never re-reads a raw evidence file to enrich the prompt', () => {
    const result = fullyPopulatedRunResult();
    const prompt = buildExplainPrompt(result, explainableCriteria(result));

    // Structural, and the stronger claim: the module is handed a `RunResult` and no file
    // reader, so it CANNOT reach the full copies on disk. The prompt says as much to the
    // model, so a future maintainer reading the output sees the rule too.
    expect(prompt).toContain('already redacted; this is all there is');
  });

  it('redacts and bounds the hypothesis coming back — it is untrusted provider text', async () => {
    const result = fullyPopulatedRunResult();
    const outcome = await explain(
      result,
      scriptedProvider(
        JSON.stringify({
          explanations: [
            {
              criterionId: 'E7-03',
              hypothesis: `the service logged AWS_SECRET_ACCESS_KEY=${SEEDED_SECRET} ${'z'.repeat(5000)}`,
            },
          ],
        }),
      ),
    );

    const [entry] = outcome.explanations;
    expect(entry).toBeDefined();
    // ABSENCE, not the presence of a marker.
    expect(entry?.explanation).not.toContain(SEEDED_SECRET);
    // Bounded, with the merged truncation-marker format so a clipped hypothesis does not
    // read as a complete thought that simply stopped making sense.
    expect(Buffer.byteLength(entry?.explanation ?? '', 'utf8')).toBeLessThan(
      EXPLANATION_CAP_BYTES + 200,
    );
    expect(entry?.explanation).toContain('truncated:');
  });
});

describe('the provider may not introduce a criterion', () => {
  it('drops a criterion id this run does not carry', async () => {
    const outcome = await explain(
      fullyPopulatedRunResult(),
      scriptedProvider(
        JSON.stringify({
          explanations: [
            { criterionId: 'E7-99', hypothesis: 'a criterion nobody ran' },
            { criterionId: 'E7-01', hypothesis: 'a criterion that PASSED' },
            { criterionId: 'E7-03', hypothesis: 'the one it was actually shown' },
          ],
        }),
      ),
    );

    // Not tidiness: this is the difference between "provider text appears beside a
    // criterion" and "provider text can name any criterion it likes" — including one that
    // passed, where a hypothesis would read as a finding against a green result.
    expect(outcome.explanations.map((e) => e.criterionId)).toEqual(['E7-03']);
  });

  it('keeps only the first hypothesis when one criterion is named twice', async () => {
    const outcome = await explain(
      fullyPopulatedRunResult(),
      scriptedProvider(
        JSON.stringify({
          explanations: [
            { criterionId: 'E7-03', hypothesis: 'first' },
            { criterionId: 'E7-03', hypothesis: 'second, contradicting the first' },
          ],
        }),
      ),
    );

    // Two hypotheses on one failure would make the report say two different things about
    // it with no way for a reader to tell which to believe.
    expect(outcome.explanations).toEqual([{ criterionId: 'E7-03', explanation: 'first' }]);
  });
});

describe('AC2 — every failure route leaves results untouched, with a note', () => {
  it('route 1: no criterion failed, so the provider is never invoked at all', async () => {
    const base = fullyPopulatedRunResult();
    const clean: RunResult = {
      ...base,
      criteria: base.criteria.filter((c) => c.status !== 'fail' && c.status !== 'error'),
    };

    // The throwing double is the assertion: if anything called it, this test fails loudly
    // instead of quietly spending quota on a run with nothing to explain.
    const outcome = await explain(clean, throwingProvider(new Error('must not be called')));

    expect(outcome.explanations).toEqual([]);
    expect(outcome.providerUsage).toEqual([]);
    expect(outcome.note).toMatch(/nothing to explain/);
  });

  it('route 2: the provider binary is missing — the adapter throws ENOENT', async () => {
    const outcome = await explain(
      fullyPopulatedRunResult(),
      throwingProvider(new Error('spawn claude ENOENT')),
    );

    expect(outcome.explanations).toEqual([]);
    expect(outcome.note).toMatch(/no usable hypothesis/);
    // The quota question: the gate retried, and every attempt is RECORDED even though none
    // succeeded. A failed call spent what a successful one would have (Q65, FR-15).
    expect(outcome.providerUsage).toHaveLength(1);
    expect(outcome.providerUsage[0]?.attempts).toBe(3);
  });

  it('route 3: the provider errors mid-flight', async () => {
    const outcome = await explain(
      fullyPopulatedRunResult(),
      throwingProvider(new Error('the agent session was terminated')),
    );

    expect(outcome.explanations).toEqual([]);
    expect(outcome.note).toContain('verification results are unaffected');
  });

  it('route 4: the merged schema gate rejects the response — no partial artifact', async () => {
    const outcome = await explain(
      fullyPopulatedRunResult(),
      // Valid JSON of the wrong shape, three times over: the gate's budget is 2 retries.
      scriptedProvider(JSON.stringify({ explanations: [{ criterionId: 'E7-03' }] })),
    );

    expect(outcome.explanations).toEqual([]);
    expect(outcome.note).toMatch(/schema-rejected/);
    // FR-14: `parsed` exists only on the success arm, so there is no half-built payload to
    // salvage and none is salvaged.
    expect(outcome.providerUsage[0]?.attempts).toBe(3);
  });

  it('route 4b: output that is not JSON at all is told apart from JSON of the wrong shape', async () => {
    const outcome = await explain(
      fullyPopulatedRunResult(),
      scriptedProvider('I think the migration is broken, honestly'),
    );

    expect(outcome.explanations).toEqual([]);
    expect(outcome.note).toMatch(/unparsable/);
  });

  it('route 5: a timeout is classified as a provider failure, not an infra error', async () => {
    // A timeout arrives at the gate as a throw from the adapter and is classified
    // `provider-failed` — "the CLI hung" and "your disk is full" must not look alike.
    const outcome = await explain(
      fullyPopulatedRunResult(),
      throwingProvider(new Error('timed out after 120000ms')),
    );

    expect(outcome.explanations).toEqual([]);
    expect(outcome.note).toMatch(/provider-failed/);
  });

  it('recovers when a malformed response is followed by a valid one', async () => {
    // The retry loop is the merged gate's, exercised from the outside. Nothing here
    // implements a second one.
    const outcome = await explain(
      fullyPopulatedRunResult(),
      scriptedProvider('not json at all', VALID),
    );

    expect(outcome.explanations).toHaveLength(1);
    expect(outcome.note).toBeUndefined();
    expect(outcome.providerUsage[0]?.attempts).toBe(2);
  });

  it('never throws, whatever the provider does', async () => {
    // The blanket claim, stated once as a claim rather than only implied by the routes
    // above. `explainRun`'s contract is that it has no throwing arm at all.
    const explosive = {
      id: 'explosive',
      adapter: 'fake',
      generate: () => {
        throw new Error('synchronous explosion before any promise exists');
      },
    };

    await expect(explain(fullyPopulatedRunResult(), explosive)).resolves.toMatchObject({
      explanations: [],
    });
  });
});
