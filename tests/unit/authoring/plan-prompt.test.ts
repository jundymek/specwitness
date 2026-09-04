/**
 * `buildPlanPrompt` — the plan-author prompt (story 4.2), given its first dedicated suite by
 * story 6.8.
 *
 * **THIS FILE DID NOT EXIST BEFORE STORY 6.8.** `plan.test.ts` asserted a handful of things
 * about this prompt in passing, as part of testing `compilePlan`; nothing tested the
 * builder's own security or bounding properties, because it had none. That is exactly how
 * Epic 5's two prompt defects survived here: they were found twice, in the two modules that
 * DID have prompt suites, and never looked for in this one.
 *
 * What this file pins:
 *
 *  1. **the contract `statement` is redacted** — Epic 5 retro §2 observation 3's second
 *     defect, which was live in this builder until story 6.8. The statement travelled from
 *     the frozen contract into a provider prompt with no boundary redacting it anywhere
 *     along the way;
 *  2. **the prompt is bounded** — it was not, at all;
 *  3. **the instructions survive**, which here means the head, because this builder states
 *     all of its rules before its content and therefore has no tail to protect.
 *
 * Secrets are asserted ABSENT, never `[REDACTED]`-present (Epic 3 retro §7).
 * Zero subprocesses, zero provider calls — `buildPlanPrompt` is a pure function.
 */

import { describe, expect, it } from 'vitest';

import { PLAN_PROMPT_CAP_BYTES, buildPlanPrompt } from '../../../src/authoring/plan-prompt.js';
import type { DeclaredIds } from '../../../src/schemas/plan.js';
import { SEEDED_SECRET } from '../../fixtures/run-result.js';
import { criterion, frozenContract } from '../../helpers/plan.js';

const encoder = new TextEncoder();
const bytes = (text: string): number => encoder.encode(text).length;

const DECLARED: DeclaredIds = {
  serviceIds: ['backend', 'frontend'],
  commandIds: ['company-count', 'typecheck'],
};

describe('SECURITY — the contract statement passes a redaction boundary (AC2)', () => {
  it('a credential in a criterion statement is absent from the prompt', () => {
    // THE DEFECT EPIC 5 FOUND TWICE AND FIXED IN NEITHER OF THESE TWO MODULES. Before story
    // 6.8 this assertion failed: `renderCriterion` interpolated `criterion.statement`
    // directly, and no earlier boundary redacts it — a contract is a document a person wrote
    // and reads, so nothing between the contract file and here had any reason to.
    const contract = frozenContract([
      criterion('E7-01', { statement: `the endpoint accepts AUTH_TOKEN=${SEEDED_SECRET}` }),
    ]);

    expect(buildPlanPrompt(contract, DECLARED)).not.toContain(SEEDED_SECRET);
  });

  it('a credential arriving as a sensitive header line is absent too', () => {
    const contract = frozenContract([
      criterion('E7-01', {
        statement: `the endpoint requires Authorization: Bearer ${SEEDED_SECRET}`,
      }),
    ]);

    expect(buildPlanPrompt(contract, DECLARED)).not.toContain(SEEDED_SECRET);
  });

  it('a credential in a DECLARED ID is absent — config is untrusted input too', () => {
    // The declared ids come from the project's own `.specwitness/config.yaml`. Committed is
    // not the same as safe: the same argument was made about plan content in story 5.6 and
    // was wrong there for the same reason.
    const contract = frozenContract([criterion('E7-01')]);
    const declared: DeclaredIds = {
      serviceIds: ['backend'],
      commandIds: [`count-with-API_KEY=${SEEDED_SECRET}`],
    };

    expect(buildPlanPrompt(contract, declared)).not.toContain(SEEDED_SECRET);
  });

  it('applies config-declared extra patterns when a caller supplies them', () => {
    const contract = frozenContract([criterion('E7-01', { statement: 'codename ORCHID' })]);

    expect(buildPlanPrompt(contract, DECLARED, { extraPatterns: [/ORCHID/g] })).not.toContain(
      'ORCHID',
    );
  });
});

describe('bounding (AC1)', () => {
  const huge = () =>
    frozenContract(
      Array.from({ length: 50 }, (_unused, index) =>
        criterion(`E7-${index}`, { statement: 'x'.repeat(20_000) }),
      ),
    );

  it('is bounded, which it was not before story 6.8', () => {
    // `+ 1` for the trailing newline this builder appends after assembly, which is outside
    // the assembled document and part of its own long-standing output shape.
    expect(bytes(buildPlanPrompt(huge(), DECLARED))).toBeLessThanOrEqual(
      PLAN_PROMPT_CAP_BYTES + 1,
    );
  });

  it('keeps every instruction when the contract is bounded away', () => {
    // This builder states its rules BEFORE its content, so it has no instruction tail to
    // protect — an honest structural fact rather than an exemption. The guarantee that
    // matters here is the mirror image: bounding the body can never reach the head.
    const prompt = buildPlanPrompt(huge(), DECLARED);

    expect(prompt).toContain('THE PROBE SURFACES — this list is closed. There are no others.');
    expect(prompt).toContain('CHOOSE THE LOWEST ADEQUATE SURFACE');
    expect(prompt).toContain('COMMANDS AND SERVICES ARE REFERENCED BY ID, NEVER BY COMMAND LINE.');
    expect(prompt).toContain('EVERY CRITERION MUST APPEAR EXACTLY ONCE.');
    // The bound really was reached, so nothing above passes vacuously.
    expect(prompt).toMatch(/… truncated: \d+ of \d+ bytes shown/);
  });

  it('puts the declared ids ahead of the criteria, so a cut reaches the criteria first', () => {
    // Order is load-bearing: a bound cuts from the end, so the "you may reference these and
    // nothing else" list survives any truncation the criteria do not.
    const prompt = buildPlanPrompt(frozenContract([criterion('E7-01')]), DECLARED);

    expect(prompt.indexOf('- backend')).toBeLessThan(prompt.indexOf('--- E7-01 ---'));
  });

  it('leaves an ordinary contract completely untouched', () => {
    // The widening must not cost anything on the overwhelmingly common input. Ordinary
    // criterion prose matches neither redaction shape, so it arrives verbatim.
    const statement = 'GET /health responds 200 with a JSON body whose "status" field is "ok".';
    const prompt = buildPlanPrompt(frozenContract([criterion('E7-01', { statement })]), DECLARED);

    expect(prompt).toContain(statement);
    expect(prompt).not.toContain('truncated:');
    expect(prompt).not.toContain('[REDACTED]');
  });
});

describe('what the prompt still says (unchanged by story 6.8)', () => {
  it('carries the criteria and their metadata', () => {
    const contract = frozenContract([
      criterion('E7-01', { statement: 'The service starts.', severity: 'critical' }),
    ]);

    const prompt = buildPlanPrompt(contract, DECLARED);

    expect(prompt).toContain('--- E7-01 ---');
    expect(prompt).toContain('severity: critical');
    expect(prompt).toContain('The service starts.');
  });

  it('repeats the do-not-probe rule for a human-verifiability criterion', () => {
    const contract = frozenContract([
      criterion('E7-02', { statement: 'An operator reads the notes.', verifiability: 'human' }),
    ]);

    const prompt = buildPlanPrompt(contract, DECLARED);

    expect(prompt).toContain('E7-02 is verifiability: human.');
    expect(prompt).toMatch(/Do NOT give it a probe/);
  });

  it('says "none declared" for an empty category rather than omitting the heading', () => {
    const contract = frozenContract([criterion('E7-01')]);

    expect(buildPlanPrompt(contract, { serviceIds: [], commandIds: [] })).toContain(
      '(none declared)',
    );
  });
});
