/**
 * ADR-008 — an unknown key is a VERSION SKEW, not corruption (story 6.3's rider).
 *
 * `src/schemas/versions.ts` has promised additive evolution since story 1.2: *"bump a
 * number when a shape changes, add a key when a new artifact appears. Never renumber and
 * never remove — a stored run from last week must stay readable."* That held forwards and
 * broke backwards. Every persisted schema is `.strict()`, so when a NEWER SpecWitness adds
 * an optional key — exactly the additive evolution the registry prescribes — an older
 * build reading that document rejected it as **malformed**, while `schemaVersion` still
 * read `1` and truthfully said the shape was unchanged. The reader reported a corrupt file
 * when what it had actually met was a newer writer.
 *
 * ADR-008 keeps the strictness and changes the DIAGNOSIS. This suite pins both halves of
 * that, for both readers story 6.3 owns (`jsonReport` and `runManifest`).
 *
 * ⚠️ **BOTH DIRECTIONS, AND THE SECOND ONE IS THE POINT.** A test that only asserted the
 * friendly path would let a genuinely malformed document silently become a version skew,
 * and real corruption would then hide behind an upgrade hint — which is worse than the
 * defect ADR-008 was written to fix, because the operator would be told to upgrade rather
 * than to look at the file. ADR-008's own Consequences section says so in terms: *"A test
 * that only asserts the first would let the second silently become the first."* So every
 * skew case below has a malformed twin.
 *
 * ⚠️ **AND NEVER `IntegrityError`.** A skew is `InfraError` (exit 3). `IntegrityError`
 * means tampering and must keep meaning only that (ADR-008 §1): a skew classified as
 * tampering would make an ordinary upgrade indistinguishable from an attack. The corpus
 * fixture `fixtures/corpus/09-tampered-fingerprint/` pins the other side of that same
 * line — what a real tamper looks like — which is why these two changes ship together.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { InfraError, IntegrityError } from '../../../src/domain/errors.js';
import { parseRunManifest } from '../../../src/schemas/manifest.js';
import { parseRunResult } from '../../../src/schemas/result.js';
import { unknownKeysOnly } from '../../../src/schemas/unknown-keys.js';

/* ── the classifier ─────────────────────────────────────────────────────────────────── */

describe('unknownKeysOnly', () => {
  const strict = z.object({ a: z.string() }).strict();

  function issuesFor(schema: z.ZodType, value: unknown): z.ZodError {
    const result = schema.safeParse(value);
    if (result.success) {
      throw new Error('expected this fixture value to FAIL validation');
    }
    return result.error;
  }

  it('names every unrecognised key when that is the only thing wrong', () => {
    expect(unknownKeysOnly(issuesFor(strict, { a: 'x', foo: 1, bar: 2 }))).toEqual([
      'foo',
      'bar',
    ]);
  });

  it('qualifies a nested key by its path, so two "id" keys are told apart', () => {
    // Without the path, a skew report naming `id` would be useless in a document with a
    // dozen nested objects — and worse, indistinguishable from a skew at the root.
    const nested = z
      .object({ outer: z.object({ a: z.string() }).strict() })
      .strict();
    expect(unknownKeysOnly(issuesFor(nested, { outer: { a: 'x', id: 1 } }))).toEqual([
      'outer.id',
    ]);
  });

  it('returns null for a WRONG TYPE — the malformed-document path must survive', () => {
    expect(unknownKeysOnly(issuesFor(strict, { a: 123 }))).toBeNull();
  });

  it('returns null for a MISSING REQUIRED FIELD', () => {
    expect(unknownKeysOnly(issuesFor(strict, {}))).toBeNull();
  });

  it('returns null when an unknown key appears ALONGSIDE a real defect', () => {
    // THE CASE THAT MATTERS MOST, and the one a naive `issues.some(...)` gets wrong. A
    // document that is BOTH newer AND corrupt must be reported as corrupt: telling the
    // operator to upgrade would send them away from a file that is genuinely broken.
    expect(unknownKeysOnly(issuesFor(strict, { a: 123, foo: 1 }))).toBeNull();
  });
});

/* ── the two readers ────────────────────────────────────────────────────────────────── */

/** A minimal, VALID stored run document, so each test alters exactly one thing. */
function validRunResult(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId: 'run-20260904T090000Z-ab12',
    epic: 'epic-1',
    baseSha: '1111111111111111111111111111111111111111',
    headSha: '2222222222222222222222222222222222222222',
    startedAt: '2026-09-04T09:00:00.000Z',
    finishedAt: '2026-09-04T09:00:10.000Z',
    outcome: { verdict: 'PASS' },
    stages: [],
    gates: [],
    criteria: [],
    evidence: [],
    providerUsage: [],
    environment: {
      nodeVersion: 'v22.13.0',
      platform: 'linux',
      arch: 'x64',
      specwitnessVersion: '0.1.0',
      worktreePath: null,
      runDirectory: '.specwitness/runs/run-20260904T090000Z-ab12',
    },
  };
}

/** A minimal, VALID run manifest. */
function validManifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId: 'run-20260904T090000Z-ab12',
    createdAt: '2026-09-04T09:00:00.000Z',
    epic: 'epic-1',
    worktrees: [],
    processGroups: [],
    reaped: false,
  };
}

describe.each([
  {
    artifact: 'run result',
    parse: (value: unknown) => parseRunResult(JSON.stringify(value), '/runs/r/result.json'),
    valid: validRunResult,
    /** A wrong TYPE on a field this build already knows. */
    corrupt: (doc: Record<string, unknown>) => ({ ...doc, gates: 'not-an-array' }),
  },
  {
    artifact: 'run manifest',
    parse: (value: unknown) => parseRunManifest(JSON.stringify(value), '/runs/r/manifest.json'),
    valid: validManifest,
    corrupt: (doc: Record<string, unknown>) => ({ ...doc, reaped: 'not-a-boolean' }),
  },
])('$artifact reader', ({ artifact, parse, valid, corrupt }) => {
  it('parses the valid document, so every case below alters exactly one thing', () => {
    // The control. Without it, a mistake in these helpers would make every skew test below
    // pass for the wrong reason — the document would be failing validation for a defect
    // the test never intended to plant.
    expect(() => parse(valid())).not.toThrow();
  });

  it('reports an unknown key as a VERSION SKEW naming the field', () => {
    const fromTheFuture = { ...valid(), somethingNewerWrote: 'a value this build never heard of' };

    expect(() => parse(fromTheFuture)).toThrow(InfraError);
    try {
      parse(fromTheFuture);
      expect.unreachable('the reader must refuse a document it cannot fully interpret');
    } catch (error) {
      const infra = error as InfraError;
      // ADR-008 §1: the ERROR line says a newer SpecWitness wrote it — that is the WHAT,
      // so it does not belong in the HINT alone.
      expect(infra.message).toContain('was written by a newer SpecWitness');
      expect(infra.message).toContain(artifact);
      // The unknown field is NAMED. "Something is unrecognised" is not actionable.
      expect(infra.hint).toContain('somethingNewerWrote');
      expect(infra.hint).toContain('Upgrade specwitness');
      // ⚠️ NEVER the malformed wording: that is what sends an operator to inspect a file
      // that is not actually broken.
      expect(infra.message).not.toContain('malformed');
    }
  });

  it('⚠️ still reports a WRONG TYPE as malformed — real corruption must not hide behind an upgrade hint', () => {
    const broken = corrupt(valid());

    expect(() => parse(broken)).toThrow(InfraError);
    try {
      parse(broken);
      expect.unreachable('a malformed document must be refused');
    } catch (error) {
      const infra = error as InfraError;
      expect(infra.message).toContain('malformed');
      expect(infra.message).not.toContain('was written by a newer SpecWitness');
    }
  });

  it('⚠️ reports a document that is BOTH newer AND corrupt as malformed, not as a skew', () => {
    // Upgrading would not fix this file. Saying "upgrade" would send the operator away
    // from a document that is genuinely broken, which is strictly worse than the
    // pre-ADR-008 behaviour it would look like an improvement over.
    const both = { ...corrupt(valid()), somethingNewerWrote: 'x' };

    try {
      parse(both);
      expect.unreachable('a malformed document must be refused');
    } catch (error) {
      expect((error as InfraError).message).toContain('malformed');
    }
  });

  it('⚠️ never raises IntegrityError for a skew — that word must keep meaning tampering', () => {
    // ADR-008 §1. If a version skew surfaced as an integrity failure, an ordinary upgrade
    // would be indistinguishable from an attack, and the alarm that is supposed to mean
    // tampering would be the first thing an operator learns to ignore.
    expect(() => parse({ ...valid(), somethingNewerWrote: 'x' })).not.toThrow(IntegrityError);
  });

  it('keeps the schemaVersion policy ahead of the unknown-key branch (regression guard)', () => {
    // A document from a HIGHER schemaVersion already had its own message before this
    // story, and it is the more specific diagnosis — it names the version numbers. The new
    // branch must not shadow it, or an operator loses "this build understands 1".
    const newer = { ...valid(), schemaVersion: 99, somethingNewerWrote: 'x' };

    try {
      parse(newer);
      expect.unreachable('a document from the future must be refused');
    } catch (error) {
      expect((error as InfraError).message).toContain('schemaVersion 99');
    }
  });
});

/* ── the carve-out: provider-authored payloads are NOT version skews ─────────────────── */

describe('⚠️ an unknown key inside a PROVIDER-AUTHORED payload stays malformed', () => {
  /**
   * ADR-008's premise — an unrecognised key means a newer SpecWitness wrote this — is true
   * of the ENVELOPE, where additive evolution actually happens, and false of a sub-object
   * whose content came from a provider. An unexpected key there is the shape of a provider
   * smuggling a field the schema never granted it, and "upgrade specwitness" would send the
   * operator away from the document that recorded the attempt.
   *
   * ADR-008 draws exactly this line already — its Context excludes `adaptation` as a
   * "provider input boundary ... which this ADR deliberately does not touch" — and simply
   * did not notice that `jsonReport`, which it DOES assign, contains provider-authored
   * sub-objects. Honouring the carve-out makes the new branch narrower than the ADR's
   * literal text, never wider, which is the fail-closed direction.
   *
   * `tests/unit/schemas/result-explanation.test.ts` is the merged guard this protects:
   * "a payload that smuggled a `status` alongside a hypothesis is the exact shape AD-2
   * exists to make impossible, and it must be refused on READ as well as never written."
   * These cases exist so that guard cannot be undone from THIS side, by someone widening
   * the skew branch without realising what it reaches.
   */
  function withExplanations(entries: unknown): string {
    return JSON.stringify({
      ...validRunResult(),
      explanations: entries,
    });
  }

  it('refuses a smuggled verdict-shaped field as malformed, not as an upgrade prompt', () => {
    const smuggled = withExplanations([
      { criterionId: 'E1-01', explanation: 'a hypothesis', status: 'pass' },
    ]);

    try {
      parseRunResult(smuggled, '/runs/r/result.json');
      expect.unreachable('a provider payload carrying an undeclared field must be refused');
    } catch (error) {
      const infra = error as InfraError;
      expect(infra.message).toContain('malformed');
      // THE ASSERTION WITH TEETH. Reporting a version skew here would tell the operator to
      // upgrade, and the smuggled `status` would never be looked at by anyone.
      expect(infra.message).not.toContain('was written by a newer SpecWitness');
      expect(infra.hint ?? '').not.toContain('Upgrade specwitness');
    }
  });

  it('⚠️ reports an AD-6 EXCLUSIVITY violation as malformed, never as a skew', () => {
    // THE VERDICT-BEARING FIELD, and the one place a wrong answer would be worst.
    // `RunOutcomeSchema` is a `z.union` of two strict objects, so a document claiming BOTH
    // a product verdict AND an infrastructure error — which AD-6 says can never both be
    // true — fails as `invalid_union` rather than as `unrecognized_keys`. `unknownKeysOnly`
    // therefore returns null and the malformed message stands.
    //
    // This is asserted rather than assumed BECAUSE it is a property of how zod reports
    // union failures, not something this codebase controls. If a zod upgrade ever flattened
    // that to bare unrecognised-key issues, a document asserting a PASS and an infra error
    // at the same time would start telling the operator to upgrade SpecWitness. This test
    // is what would go red.
    const contradictory = JSON.parse(JSON.stringify(validRunResult())) as Record<string, unknown>;
    contradictory['outcome'] = { verdict: 'PASS', infraError: 'infra' };

    try {
      parseRunResult(JSON.stringify(contradictory), '/runs/r/result.json');
      expect.unreachable('an outcome claiming both a verdict and an infra error must be refused');
    } catch (error) {
      const infra = error as InfraError;
      expect(infra.message).toContain('malformed');
      expect(infra.message).not.toContain('was written by a newer SpecWitness');
    }
  });

  it('reports an unknown key INSIDE the outcome as a skew, path-qualified', () => {
    // The other direction, and it is the correct one: `outcome` is produced mechanically by
    // `aggregate()`, never by a provider, so an extra key there really would be a newer
    // SpecWitness recording something this build does not know about. The name is
    // path-qualified so the operator is told WHERE, not merely that something was
    // unexpected.
    const document = JSON.parse(JSON.stringify(validRunResult())) as Record<string, unknown>;
    document['outcome'] = { verdict: 'PASS', settledBy: 'a-future-field' };

    try {
      parseRunResult(JSON.stringify(document), '/runs/r/result.json');
      expect.unreachable('an unrecognised outcome key must be refused');
    } catch (error) {
      const infra = error as InfraError;
      expect(infra.message).toContain('was written by a newer SpecWitness');
      expect(infra.hint).toContain('outcome.settledBy');
    }
  });

  it('still reports a ROOT-level unknown key as a skew even when explanations are present', () => {
    // The other direction, so the carve-out is a scalpel rather than a blanket: a run that
    // legitimately carries explanations must still get the friendly diagnosis when the
    // unrecognised key is in the envelope, where additive evolution really happens.
    const document = JSON.parse(
      withExplanations([{ criterionId: 'E1-01', explanation: 'a hypothesis' }]),
    ) as Record<string, unknown>;
    document['aKeyFromTheFuture'] = 1;

    try {
      parseRunResult(JSON.stringify(document), '/runs/r/result.json');
      expect.unreachable('an unrecognised envelope key must still be refused');
    } catch (error) {
      expect((error as InfraError).message).toContain('was written by a newer SpecWitness');
    }
  });
});
