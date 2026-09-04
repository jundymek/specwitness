/**
 * Story 5.5 — the `explanations` key, persisted ADDITIVELY (AD-5).
 *
 * The failure mode this file guards is the one this document has already hit twice, in one
 * afternoon, on `GateEvidence.displayCommand` and `StageTimelineEntry.hint`, and once more
 * in story 5.3 on `reviewerGuidance`: `RunResultDocumentSchema` is `.strict()`, so a field
 * the domain carries and the mirror does not SERIALIZES perfectly and then FAILS TO PARSE
 * BACK. Runs persist fine and become unreadable weeks later — and the unreadable ones would
 * be exactly the runs that used the feature.
 *
 * The other half is `schemas/versions.ts`: `SCHEMA_VERSIONS.jsonReport` is deliberately NOT
 * bumped for this change, so a `result.json` written before story 5.5 must still parse.
 * That is asserted here rather than asserted in prose.
 *
 * ── VERIFIED RED ────────────────────────────────────────────────────────────────────────
 *   P8  the `explanations` key removed from `RunResultDocumentSchema` (leaving it on the
 *       domain type and in `toRunResultDocument`)  →  "round-trips through the persisted
 *       document" FAILED with `unrecognized_key: explanations`, which is precisely the
 *       serialize-fine-then-refuse-on-read shape described above.
 *   P9  `SCHEMA_VERSIONS.jsonReport` bumped from 1 to 2  →  "does not move the jsonReport
 *       schema version" FAILED. Worth recording that the "a pre-5.5 result.json still
 *       parses" test did NOT fail under it, and that is correct rather than a gap: that
 *       test builds its old document with the CURRENT writer, so a bump moves the document
 *       and the reader together. The version pin is therefore the assertion carrying the
 *       weight here, and the round-trip test is what proves the key is genuinely optional.
 */

import { describe, expect, it } from 'vitest';

import type { CriterionExplanation, RunResult } from '../../../src/domain/run-result.js';
import {
  RUN_RESULT_VERSION,
  parseRunResult,
  serializeRunResult,
  toRunResult,
  toRunResultDocument,
} from '../../../src/schemas/result.js';
import { SCHEMA_VERSIONS } from '../../../src/schemas/versions.js';
import { fullyPopulatedRunResult } from '../../fixtures/run-result.js';

const EXPLANATIONS: readonly CriterionExplanation[] = [
  { criterionId: 'E7-03', explanation: 'the flag parser maps unknown flags onto exit 1' },
  { criterionId: 'E7-06', explanation: 'the probe never reached the database' },
];

function explained(): RunResult {
  return { ...fullyPopulatedRunResult(), explanations: EXPLANATIONS };
}

describe('the explanations key round-trips', () => {
  it('serializes and parses back with the hypotheses intact', () => {
    const text = serializeRunResult(explained());
    const document = parseRunResult(text, '/tmp/result.json');

    expect(document.explanations).toEqual(EXPLANATIONS);
    // And back to the model, so the renderer that reads a STORED run sees what the renderer
    // that read a live one saw.
    expect(toRunResult(document).explanations).toEqual(EXPLANATIONS);
  });

  it('omits the key entirely when a run was not explained', () => {
    const text = serializeRunResult(fullyPopulatedRunResult());

    // Absent, not `null` and not `[]`. "This run was not explained" and "the explainer
    // produced an empty list" would otherwise be indistinguishable, and `JSON.stringify`
    // dropping an undefined-valued key is what keeps an unexplained run's bytes exactly
    // what they were before this story existed.
    expect(text).not.toContain('explanations');
    expect(parseRunResult(text, '/tmp/result.json').explanations).toBeUndefined();
  });

  it('rejects a document whose explanation carries an unknown key', () => {
    const document = toRunResultDocument(explained()) as unknown as Record<string, unknown>;
    document['explanations'] = [
      { criterionId: 'E7-03', explanation: 'text', status: 'pass' },
    ];

    // `.strict()`, and the key chosen for this test is the point: a payload that smuggled a
    // `status` alongside a hypothesis is the exact shape AD-2 exists to make impossible,
    // and it must be refused on READ as well as never written.
    expect(() => parseRunResult(JSON.stringify(document), '/tmp/result.json')).toThrow(
      /malformed/,
    );
  });

  it('rejects an empty hypothesis', () => {
    const document = toRunResultDocument(explained()) as unknown as Record<string, unknown>;
    document['explanations'] = [{ criterionId: 'E7-03', explanation: '' }];

    // An empty hypothesis rendered under a heading reads as a missing value rather than an
    // absent one, and a reader cannot tell those apart.
    expect(() => parseRunResult(JSON.stringify(document), '/tmp/result.json')).toThrow(
      /malformed/,
    );
  });
});

describe('AD-5 — the change is additive, so last week`s runs stay readable', () => {
  it('does not move the jsonReport schema version', () => {
    // Pinned as a NUMBER, not compared to itself: this fails if somebody bumps it, which is
    // the whole point. An added optional key is the additive case, and the repo's precedent
    // is commit `ec23ce1` (stage `hint`), story 5.3 and story 5.4 — none of which bumped it.
    expect(SCHEMA_VERSIONS.jsonReport).toBe(1);
    expect(RUN_RESULT_VERSION).toBe(1);
  });

  it('registers the explanation payload contract as its own key', () => {
    // The one-line addition `schemas/versions.ts` describes. Separate from `jsonReport`
    // because it versions the PAYLOAD shape, not the run document.
    expect(SCHEMA_VERSIONS.explanation).toBe(1);
  });

  it('parses a result.json written before story 5.5 existed', () => {
    // Built by REMOVING the key from a current document rather than by pasting an old
    // literal, so it stays a faithful "document from last week" as the rest of the shape
    // evolves instead of rotting into a fixture nobody updates.
    const document = toRunResultDocument(explained()) as unknown as Record<string, unknown>;
    delete document['explanations'];

    expect(() => parseRunResult(JSON.stringify(document), '/tmp/old-result.json')).not.toThrow();
  });

  it('leaves an unexplained run byte-for-byte what it was', () => {
    // The key is constructed LAST in `toRunResultDocument`, after `contract`, so an absent
    // explanation cannot shift any other key's position in the file. Asserted on the bytes
    // because key ORDER is part of this document's contract, not just its content.
    const text = serializeRunResult(fullyPopulatedRunResult());
    const keys = Object.keys(JSON.parse(text) as Record<string, unknown>);

    expect(keys.at(0)).toBe('schemaVersion');
    expect(keys.at(-1)).toBe('contract');
  });

  it('places the explanations key last when there is one', () => {
    const keys = Object.keys(
      JSON.parse(serializeRunResult(explained())) as Record<string, unknown>,
    );

    // Furthest from everything mechanically derived — the same reason the terminal report
    // puts its block after every other section.
    expect(keys.at(-1)).toBe('explanations');
  });
});
