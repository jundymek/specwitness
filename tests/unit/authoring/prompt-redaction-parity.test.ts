/**
 * AC2, made checkable rather than asserted. Story 6.8.
 *
 * ============================================================================
 * WHY THIS FILE IS TABLE-DRIVEN AND WHY THAT IS THE POINT
 * ============================================================================
 *
 * AC2 does not ask for redaction at each call site. It asks for **the same** redaction
 * boundary at each call site, "with the behaviour identical across all call sites". Those
 * are different claims, and only the second one closes the defect Epic 5 actually recorded.
 *
 * Four modules each having their own passing security test is precisely the state this
 * layer was in before story 6.8 — `explain.ts` had one, and its existence is what let a
 * later author argue, incorrectly, that a sibling behaved the same way. Per-module tests
 * cannot catch a DIVERGENCE between modules, because no one of them can see another.
 *
 * So every builder is driven from ONE list here. A future module added to the layer that
 * redacts less than its siblings does not merely fail its own test — there is no "its own
 * test" for it to be missing. Adding a row is what registering a new provider-facing module
 * looks like, and forgetting to add one is visible in review as an absent row.
 *
 * ⚠️ WHAT THIS FILE DOES **NOT** CLAIM. It does not mechanically prove that a future module
 * uses the shared helper — nothing can, and story 6.8's AC3 asks for visibility rather than
 * a new enforcement mechanism. The `authoring-layer` depcruise rule fences the layer's
 * IMPORTS; it says nothing about whether a function assembles a string by hand. What is
 * enforced is narrower and worth stating exactly: any text passed to `assemblePrompt`'s
 * `body` is redacted whether or not the caller remembered to redact it. What is
 * CONVENTIONAL is that a new builder calls `assemblePrompt` at all.
 *
 * Secrets are asserted ABSENT, never `[REDACTED]`-present (Epic 3 retro §7).
 * Zero subprocesses, zero provider calls — all four builders are pure functions.
 */

import { describe, expect, it } from 'vitest';

import { buildAdaptationPrompt } from '../../../src/authoring/adaptation-prompt.js';
import { explainableCriteria, buildExplainPrompt } from '../../../src/authoring/explain.js';
import { buildPlanPrompt } from '../../../src/authoring/plan-prompt.js';
import { buildContractPrompt } from '../../../src/authoring/prompt.js';
import type { AdaptationCandidate } from '../../../src/domain/adaptation-port.js';
import type { RedactionOptions } from '../../../src/domain/evidence.js';
import type { EpicSpec } from '../../../src/domain/epic-spec.js';
import type { RunResult } from '../../../src/domain/run-result.js';
import type { DeclaredIds } from '../../../src/schemas/plan.js';
import { SEEDED_SECRET, fullyPopulatedRunResult } from '../../fixtures/run-result.js';
import { criterion, frozenContract } from '../../helpers/plan.js';

const SOURCE = { path: 'docs/planning-artifacts/epics.md', line: 3, layout: 'epics-file' } as const;

const DECLARED: DeclaredIds = { serviceIds: ['backend'], commandIds: ['typecheck'] };

/**
 * Every provider-facing prompt builder in `src/authoring/**`, each reduced to the same
 * shape: given a criterion statement, produce the bytes that would leave the process.
 *
 * The set was enumerated from the source, not from a specification's list — a refactor that
 * misses a builder leaves the defect alive in the module nobody checked, which is exactly
 * how it survived Epic 5.
 */
const BUILDERS: readonly {
  readonly name: string;
  readonly module: string;
  readonly build: (statement: string, redaction?: RedactionOptions) => string;
}[] = [
  {
    name: 'contract-author',
    module: 'src/authoring/prompt.ts',
    build: (statement, redaction) => {
      // The contract-author sees an EPIC rather than a contract, so the equivalent untrusted
      // field is the acceptance criterion the statement will eventually be drafted from.
      const epic: EpicSpec = {
        schemaVersion: 1,
        id: 'epic-7',
        epicNumber: 7,
        title: 'Verification Contracts',
        goal: 'Capture the definition of done.',
        stories: [
          {
            id: '7.1',
            title: 'Freeze a contract',
            narrative: 'As an epic owner,\nI want to freeze a contract.',
            acceptanceCriteria: [{ ordinal: 1, text: statement, source: SOURCE }],
            source: SOURCE,
          },
        ],
        source: SOURCE,
      };
      return buildContractPrompt(epic, redaction);
    },
  },
  {
    name: 'plan-author',
    module: 'src/authoring/plan-prompt.ts',
    build: (statement, redaction) =>
      buildPlanPrompt(frozenContract([criterion('E7-01', { statement })]), DECLARED, redaction),
  },
  {
    name: 'explainer',
    module: 'src/authoring/explain.ts',
    build: (statement, redaction) => {
      const base = fullyPopulatedRunResult();
      const template = base.criteria.find((entry) => entry.status === 'fail');
      if (template === undefined) {
        throw new Error('the shared fixture no longer carries a failed criterion');
      }
      const result: RunResult = { ...base, criteria: [{ ...template, statement }] };
      return buildExplainPrompt(result, explainableCriteria(result), redaction);
    },
  },
  {
    name: 'mechanics-adapter',
    module: 'src/authoring/adaptation-prompt.ts',
    build: (statement, redaction) => {
      const candidate: AdaptationCandidate = {
        criterionId: 'E7-01',
        statement,
        probeId: 'submit-order',
        path: '/orders',
        scenario: 'click "#create-company"',
        expected: 'Organizations',
        actual: '(no element matched)',
      };
      return buildAdaptationPrompt([candidate], redaction);
    },
  },
];

/**
 * The shapes `redactText` recognises, each written the way a careless human actually writes
 * it in a specification rather than the way a test author writes a fixture.
 */
const CARELESS_STATEMENTS: readonly { readonly shape: string; readonly statement: string }[] = [
  { shape: 'a bare assignment', statement: `the API accepts AUTH_TOKEN=${SEEDED_SECRET}` },
  { shape: 'a quoted assignment', statement: `the config holds "apiKey": "${SEEDED_SECRET}"` },
  {
    shape: 'a sensitive header line',
    statement: `every request carries Authorization: Bearer ${SEEDED_SECRET}`,
  },
  { shape: 'a password assignment', statement: `the seeded user has password=${SEEDED_SECRET}` },
  {
    shape: 'an assignment nested in prose',
    statement: `logs show INFO: DB_CREDENTIALS=${SEEDED_SECRET} at startup`,
  },
];

describe('AC2 — the contract statement passes the SAME boundary at every call site', () => {
  for (const { shape, statement } of CARELESS_STATEMENTS) {
    it(`every builder omits the credential when it arrives as ${shape}`, () => {
      // Asserted over the whole set in one test rather than one test per builder, so the
      // failure message names WHICH builder diverged. A per-builder test cannot report a
      // divergence because it cannot see its siblings.
      const leaking = BUILDERS.filter(({ build }) => build(statement).includes(SEEDED_SECRET)).map(
        ({ module }) => module,
      );

      expect(leaking).toEqual([]);
    });
  }

  it('every builder honours config-declared extra patterns identically (AD-10)', () => {
    const redaction: RedactionOptions = { extraPatterns: [/ORCHID/g] };
    const statement = 'the release is codenamed ORCHID';

    const leaking = BUILDERS.filter(({ build }) =>
      build(statement, redaction).includes('ORCHID'),
    ).map(({ module }) => module);

    expect(leaking).toEqual([]);
  });

  it('every builder leaves an ordinary statement verbatim — the widening costs nothing', () => {
    // The other direction, and it matters as much. A redactor eager enough to damage
    // ordinary specification prose would degrade every prompt in the product to close a
    // narrow leak, and people respond to unreadable output by working around it.
    const statement = 'GET /health responds 200 with a JSON body whose "status" field is "ok".';

    const dropping = BUILDERS.filter(({ build }) => !build(statement).includes(statement)).map(
      ({ module }) => module,
    );

    expect(dropping).toEqual([]);
  });

  it('covers every prompt builder the layer actually has', () => {
    // A canary for the failure mode this story exists to prevent: a fifth provider-facing
    // module added to `src/authoring/**` without a row here would leave this suite passing
    // while proving nothing about it. It cannot be enforced mechanically — see the file
    // header on what is enforced and what is conventional — so it is stated as a number a
    // reader has to change deliberately.
    expect(BUILDERS).toHaveLength(4);
  });
});
