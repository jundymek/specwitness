/**
 * Story 3.5 AC3 — the JSON snapshot. NFR-7's "stable machine contract".
 *
 * This is the guard that makes an unintended change to the persisted shape impossible to
 * merge unnoticed. `result.json` is the harness's contract with SpecWitness (FR-30,
 * Q53/Q55): a field renamed, reordered, dropped or silently added changes what every
 * consumer parses, and the failure mode is that nobody finds out until an automation
 * downstream starts reading a key that is no longer there.
 *
 * WHY THE WHOLE SERIALIZED STRING AND NOT A PARSED OBJECT. The contract is the BYTES —
 * key order, indentation and the trailing newline are all part of it, because `--json`
 * stdout and this file are asserted byte-equal elsewhere. A snapshot over a parsed object
 * would pass through a reordering that breaks that equality.
 *
 * AC3 SAYS "FAIL CI" AND THIS PROJECT'S CI HAS NEVER EXECUTED A STEP.
 * `.github/workflows/ci.yml` has had its `push` and `pull_request` triggers removed
 * (GitHub Actions billing) and its own header states that no version of it has ever run.
 * So this test is written so that it WOULD fail on an unintended shape change, is verified
 * red by hand (see DECISIONS.md, "Verification log"), and runs locally on every
 * `pnpm test` — and the CI half of AC3 is reported as pending-owner in the PR body rather
 * than claimed as satisfied. Epic 1 action item A1, still open after two epics.
 */

import { describe, expect, it } from 'vitest';

import { serializeRunResult } from '../../../src/schemas/result.js';
import { fullyPopulatedRunResult } from '../../fixtures/run-result.js';

describe('the persisted result.json shape (AC3, NFR-7)', () => {
  it('matches the recorded snapshot exactly, bytes included', () => {
    // `fullyPopulatedRunResult` is deterministic by construction — fixed instants, fixed
    // SHAs, fixed durations, no clock and no randomness. A snapshot that changed per run
    // is one the first person to see it fail spuriously would delete.
    expect(serializeRunResult(fullyPopulatedRunResult())).toMatchSnapshot();
  });

  it('is a snapshot of a FULLY populated document, not a half-empty one', () => {
    // A snapshot over a document with absent optionals cannot notice those fields
    // changing, so the fixture's completeness is itself part of the guard. This asserts
    // the fixture has not quietly been trimmed — the way a snapshot silently stops
    // guarding is that somebody simplifies the fixture, not that somebody deletes the
    // test.
    const document = JSON.parse(serializeRunResult(fullyPopulatedRunResult())) as {
      stages: unknown[];
      gates: unknown[];
      criteria: unknown[];
      evidence: { kind: string }[];
      providerUsage: unknown[];
      contract?: unknown;
    };

    expect(document.stages).toHaveLength(11);
    expect(document.gates.length).toBeGreaterThanOrEqual(3);
    expect(document.criteria.length).toBeGreaterThanOrEqual(5);
    expect(new Set(document.evidence.map((e) => e.kind)).size).toBe(6);
    expect(document.providerUsage.length).toBeGreaterThanOrEqual(1);
    expect(document.contract).toBeDefined();
  });
});
