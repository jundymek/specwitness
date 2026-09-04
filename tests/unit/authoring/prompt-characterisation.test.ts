/**
 * CHARACTERISATION of every prompt builder in `src/authoring/**`. Story 6.8.
 *
 * ============================================================================
 * WHAT THIS FILE IS FOR
 * ============================================================================
 *
 * Story 6.8 routes four independently-written prompt builders through one shared helper.
 * A refactor is the easiest place in this codebase to change a prompt by accident, so
 * every builder's exact bytes are pinned HERE, in a committed snapshot, BEFORE the
 * migration touches any of them. An unintended change then arrives as a snapshot diff a
 * reviewer can read, rather than as an inference nobody makes.
 *
 * The snapshots are committed in two commits deliberately:
 *
 *  1. the pre-migration bytes, written while every builder was still hand-assembling;
 *  2. the post-migration bytes, whose diff against (1) IS the story's behavioural change.
 *
 * **Where a snapshot changes, that is the point of the story and it is called out per call
 * site in the PR body** — the contract `statement` becoming redacted in the plan-author
 * prompt, and the epic becoming redacted in the contract-author prompt. Where a snapshot
 * does NOT change, the migration was behaviour-preserving and this file is the evidence.
 *
 * This file outlives the story. It is the regression guard that makes the next change to
 * any of these four prompts a deliberate one.
 *
 * Zero subprocesses, zero provider calls (AD-12): every builder here is a pure function.
 */

import { describe, expect, it } from 'vitest';

import { buildAdaptationPrompt } from '../../../src/authoring/adaptation-prompt.js';
import { explainableCriteria, buildExplainPrompt } from '../../../src/authoring/explain.js';
import { buildPlanPrompt } from '../../../src/authoring/plan-prompt.js';
import { buildContractPrompt } from '../../../src/authoring/prompt.js';
import type { AdaptationCandidate } from '../../../src/domain/adaptation-port.js';
import type { EpicSpec } from '../../../src/domain/epic-spec.js';
import type { DeclaredIds } from '../../../src/schemas/plan.js';
import { fullyPopulatedRunResult } from '../../fixtures/run-result.js';
import { criterion, frozenContract } from '../../helpers/plan.js';

const SOURCE = { path: 'docs/planning-artifacts/epics.md', line: 3, layout: 'epics-file' } as const;

const EPIC: EpicSpec = {
  schemaVersion: 1,
  id: 'epic-7',
  epicNumber: 7,
  title: 'Verification Contracts',
  goal: 'Capture the definition of done before the cohort starts.',
  stories: [
    {
      id: '7.1',
      title: 'Freeze a contract',
      narrative: 'As an epic owner,\nI want to freeze a contract,\nSo that it is authoritative.',
      acceptanceCriteria: [
        {
          ordinal: 1,
          text: 'Given a draft, when I freeze it, then a fingerprint is printed.',
          source: SOURCE,
        },
        { ordinal: 2, text: 'Re-freezing an unchanged contract is idempotent.', source: SOURCE },
      ],
      source: SOURCE,
    },
  ],
  source: SOURCE,
};

const DECLARED: DeclaredIds = {
  serviceIds: ['backend', 'frontend'],
  commandIds: ['company-count', 'typecheck'],
};

const CONTRACT = frozenContract([
  criterion('E7-01', {
    statement: 'GET /health responds 200 with a JSON body whose "status" field is "ok".',
  }),
  criterion('E7-02', {
    statement: 'An operator can read the release notes before upgrading.',
    verifiability: 'human',
  }),
]);

const CANDIDATES: readonly AdaptationCandidate[] = [
  {
    criterionId: 'E7-01',
    statement: 'A user can create an organization from the orders page.',
    probeId: 'submit-order',
    path: '/orders',
    scenario: 'goto "/orders"\nclick "#create-company"',
    expected: 'Organizations',
    actual: '(no element matched "#create-company")',
  },
];

describe('the four prompt builders, pinned byte for byte', () => {
  it('contract-author (src/authoring/prompt.ts)', () => {
    expect(buildContractPrompt(EPIC)).toMatchSnapshot();
  });

  it('plan-author (src/authoring/plan-prompt.ts)', () => {
    expect(buildPlanPrompt(CONTRACT, DECLARED)).toMatchSnapshot();
  });

  it('explainer (src/authoring/explain.ts)', () => {
    const result = fullyPopulatedRunResult();
    expect(buildExplainPrompt(result, explainableCriteria(result))).toMatchSnapshot();
  });

  it('mechanics adapter (src/authoring/adaptation-prompt.ts)', () => {
    expect(buildAdaptationPrompt(CANDIDATES)).toMatchSnapshot();
  });
});

/**
 * The SAME untrusted field, offered to all four builders, before the migration.
 *
 * AC2 says the contract `statement` must pass the same redaction boundary at every call
 * site "with the behaviour identical across all call sites". Before story 6.8 it demonstrably
 * was not, and this suite is what records the disagreement rather than asserting it: the
 * snapshot below shows, per builder, whether a secret written into a criterion statement
 * reaches the prompt.
 *
 * ⚠️ THIS SNAPSHOT CONTAINS A LEAK IN ITS PRE-MIGRATION FORM, ON PURPOSE. That is what the
 * story fixes, and pinning it is how the fix is proven to be a widening rather than a
 * claim. The credential is `SEEDED_SECRET`, the repository's one fake, chosen so nothing
 * here ever resembles a real key.
 */
describe('the contract statement, offered to every builder (AC2)', () => {
  // Inlined rather than imported from the fixtures module so the shape being tested is
  // visible on the page: an assignment whose name's last segment is sensitive is exactly
  // what `redactText` recognises, and a reader has to see it to judge the assertion.
  const CARELESS = 'the endpoint accepts AUTH_TOKEN=NOTAREALKEY-0123456789abcdefghij';

  it('plan-author', () => {
    const contract = frozenContract([criterion('E7-01', { statement: CARELESS })]);
    expect(buildPlanPrompt(contract, DECLARED)).toMatchSnapshot();
  });

  it('mechanics adapter', () => {
    expect(buildAdaptationPrompt([{ ...CANDIDATES[0]!, statement: CARELESS }])).toMatchSnapshot();
  });

  it('contract-author (the epic is its untrusted input)', () => {
    const epic: EpicSpec = {
      ...EPIC,
      stories: [
        {
          ...EPIC.stories[0]!,
          acceptanceCriteria: [{ ordinal: 1, text: CARELESS, source: SOURCE }],
        },
      ],
    };
    expect(buildContractPrompt(epic)).toMatchSnapshot();
  });
});
