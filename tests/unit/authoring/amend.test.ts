import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { amend, MAX_REASON_LENGTH } from '../../../src/authoring/amend.js';
import type { Contract } from '../../../src/domain/contract.js';
import { IntegrityError, UsageError } from '../../../src/domain/errors.js';
import { fingerprint } from '../../../src/schemas/canonical.js';
import { freeze, parseContract, serializeContract } from '../../../src/schemas/contract.js';

/**
 * FR-10 / UJ-5 / ADR-005 — the amendment service.
 *
 * These tests are the audit trail's specification. UJ-5 is the product's reason
 * for existing: an agent that cannot pass a criterion tries to weaken it, the
 * fingerprint catches the edit, and the only legitimate way forward is an
 * explicit, versioned, human-confirmed amendment. Each refusal below is one of
 * the ways that path could be subverted.
 *
 * Everything here is pure: no filesystem, no clock, no terminal. The instant is
 * an argument (AD-9), so the recorded timestamp is asserted exactly rather than
 * matched against a regex.
 */

const AT = new Date('2026-08-31T09:15:00.000Z');
const LATER = new Date('2026-09-01T10:00:00.000Z');

function draftContract(): Contract {
  return {
    spec: {
      epic: 'epic-7',
      version: 1,
      criteria: [
        {
          id: 'E7-01',
          statement: 'The report lists every failing gate with its command output.',
          kind: 'behavioral',
          severity: 'critical',
          verifiability: 'automated',
        },
      ],
    },
    meta: {
      schemaVersion: 1,
      frozen: false,
      fingerprint: null,
      createdAt: '2026-08-30T00:00:00.000Z',
      frozenAt: null,
      provenance: {
        provider: 'codex',
        model: null,
        providerCliVersion: null,
        generatedAt: '2026-08-30T00:00:00.000Z',
      },
      history: [],
    },
  };
}

function frozenContract(): Contract {
  return freeze(draftContract(), new Date('2026-08-30T12:00:00.000Z'));
}

/** A frozen contract whose spec was edited afterwards — the UJ-5 tamper. */
function tamperedContract(): Contract {
  const frozen = frozenContract();
  const original = frozen.spec.criteria[0];
  if (original === undefined) {
    throw new Error('fixture is missing its criterion');
  }

  return {
    ...frozen,
    spec: {
      ...frozen.spec,
      criteria: [
        {
          ...original,
          // The weakening an agent would attempt: "every" becomes "at least one".
          statement: 'The report lists at least one failing gate.',
        },
      ],
    },
  };
}

describe('amend', () => {
  describe('the happy path', () => {
    it('increments the version by exactly one', () => {
      const result = amend({ contract: frozenContract(), reason: 'scope reduced', at: AT });

      expect(result.spec.version).toBe(2);
    });

    it('records the SUPERSEDED version and ITS fingerprint, not the new one', () => {
      const current = frozenContract();

      const result = amend({ contract: current, reason: 'scope reduced', at: AT });

      expect(result.meta.history).toHaveLength(1);
      expect(result.meta.history[0]).toEqual({
        version: 1,
        fingerprint: current.meta.fingerprint,
        timestamp: '2026-08-31T09:15:00.000Z',
        reason: 'scope reduced',
      });
      // Recording the NEW fingerprint would be circular: it does not exist yet,
      // and the entry exists to say what was superseded.
      expect(result.meta.history[0]?.fingerprint).toBe(fingerprint(current.spec));
    });

    it('returns a valid DRAFT so the human can edit before re-freezing', () => {
      // D1: re-freeze is a second invocation. AC1 asks for a version that is
      // "re-reviewed and re-frozen"; freezing here would close that window and
      // produce version 2 with criteria identical to version 1 — an audit trail
      // recording a change that never happened.
      const result = amend({ contract: frozenContract(), reason: 'scope reduced', at: AT });

      expect(result.meta.frozen).toBe(false);
      expect(result.meta.fingerprint).toBeNull();
      expect(result.meta.frozenAt).toBeNull();
    });

    it('appends to history rather than replacing it, preserving order', () => {
      const first = amend({ contract: frozenContract(), reason: 'first change', at: AT });
      const refrozen = freeze(first, LATER);

      const second = amend({ contract: refrozen, reason: 'second change', at: LATER });

      expect(second.spec.version).toBe(3);
      expect(second.meta.history.map((entry) => entry.reason)).toEqual([
        'first change',
        'second change',
      ]);
      expect(second.meta.history.map((entry) => entry.version)).toEqual([1, 2]);
    });

    it('leaves the criteria untouched — amending versions the contract, it does not edit it', () => {
      const current = frozenContract();

      const result = amend({ contract: current, reason: 'scope reduced', at: AT });

      expect(result.spec.criteria).toEqual(current.spec.criteria);
    });

    it('does not mutate its input', () => {
      const current = frozenContract();
      const before = structuredClone(current);

      amend({ contract: current, reason: 'scope reduced', at: AT });

      expect(current).toEqual(before);
    });

    it('preserves provenance and createdAt across the amendment (AD-5)', () => {
      const current = frozenContract();

      const result = amend({ contract: current, reason: 'scope reduced', at: AT });

      expect(result.meta.provenance).toEqual(current.meta.provenance);
      expect(result.meta.createdAt).toBe(current.meta.createdAt);
    });

    it('records the injected instant, not a wall-clock read (AD-9)', () => {
      const result = amend({ contract: frozenContract(), reason: 'scope reduced', at: AT });

      expect(result.meta.history[0]?.timestamp).toBe('2026-08-31T09:15:00.000Z');
    });

    it('trims the reason but records it otherwise verbatim', () => {
      const result = amend({
        contract: frozenContract(),
        reason: '  criterion E7-01 was unverifiable as written  ',
        at: AT,
      });

      expect(result.meta.history[0]?.reason).toBe('criterion E7-01 was unverifiable as written');
    });

    it('produces a document the schema accepts, including its history-coherence rule', () => {
      // 2.2's `ContractSchema` refines the whole document: every history entry's
      // version must be BELOW `spec.version`, and the entries must ascend. That
      // rule exists because "an incoherent trail is worse than an absent one,
      // precisely because it looks like evidence" — and this flow is the only
      // thing in the product that writes the trail. Asserting the round trip
      // means the two halves are pinned together rather than merely believed to
      // agree; if either side drifts, this fails on the writer's side, which is
      // where the fix belongs.
      const once = amend({ contract: frozenContract(), reason: 'first change', at: AT });
      const twice = amend({ contract: freeze(once, LATER), reason: 'second change', at: LATER });

      const reparsed = parseContract(serializeContract(twice), 'epic-7.yaml');

      expect(reparsed.spec.version).toBe(3);
      expect(reparsed.meta.history.map((entry) => entry.version)).toEqual([1, 2]);
      expect(reparsed.meta.frozen).toBe(false);
    });

    it('produces a draft that freezes to a fingerprint over the AMENDED spec', () => {
      // The second half of the flow, asserted from this side too: whatever the
      // operator edits between --amend and --freeze is what gets fingerprinted,
      // and the history entry is not part of the hash (meta is out of scope by
      // construction — `fingerprint` takes a ContractSpec, not a Contract).
      const amended = amend({ contract: frozenContract(), reason: 'scope reduced', at: AT });

      const refrozen = freeze(amended, LATER);

      expect(refrozen.meta.frozen).toBe(true);
      expect(refrozen.meta.fingerprint).toBe(fingerprint(amended.spec));
      expect(refrozen.meta.history).toEqual(amended.meta.history);
    });
  });

  describe('refusals', () => {
    it('refuses a TAMPERED contract — integrity first, always', () => {
      // The core of UJ-5. Amending a tampered file would launder the tampering
      // into the audit trail as legitimate: the entry would record a fingerprint
      // that no longer describes any content anyone approved, and the next
      // reader would see a clean chain of custody over an edit nobody made
      // deliberately.
      expect(() =>
        amend({ contract: tamperedContract(), reason: 'scope reduced', at: AT }),
      ).toThrow(IntegrityError);
    });

    it('names the epic and points at git when refusing a tampered contract', () => {
      let thrown: unknown;
      try {
        amend({ contract: tamperedContract(), reason: 'scope reduced', at: AT });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(IntegrityError);
      expect((thrown as IntegrityError).message).toContain('epic-7');
      expect((thrown as IntegrityError).hint).toContain('git');
    });

    it('writes nothing into history when it refuses', () => {
      const tampered = tamperedContract();
      const before = structuredClone(tampered);

      expect(() => amend({ contract: tampered, reason: 'scope reduced', at: AT })).toThrow();

      expect(tampered).toEqual(before);
    });

    it('refuses a NEVER-FROZEN draft: there is no version to supersede', () => {
      let thrown: unknown;
      try {
        amend({ contract: draftContract(), reason: 'scope reduced', at: AT });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(IntegrityError);
      // The operator wants --freeze; saying so is more use than inventing a
      // version-0 history entry.
      expect((thrown as IntegrityError).hint).toContain('--freeze');
    });

    it('refuses a contract claiming frozen with no fingerprint', () => {
      const base = frozenContract();
      const contradictory: Contract = {
        ...base,
        meta: { ...base.meta, fingerprint: null },
      };

      // Never fabricate the value: the history entry would otherwise carry a
      // fingerprint nobody computed.
      expect(() =>
        amend({ contract: contradictory, reason: 'scope reduced', at: AT }),
      ).toThrow(IntegrityError);
    });

    it('reports tampering even when the reason is ALSO invalid', () => {
      // Integrity first, always — including when a second thing is wrong. If the
      // reason were validated first, an operator handed a tampered contract
      // would be told to write a better rationale, and would go and write one,
      // for an amendment that can never legitimately happen. The wrong error
      // here does not just misinform, it sends someone off to do work that
      // cannot land.
      let thrown: unknown;
      try {
        amend({ contract: tamperedContract(), reason: '   ', at: AT });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(IntegrityError);
      expect(thrown).not.toBeInstanceOf(UsageError);
    });

    it('reports tampering even when the reason is too long', () => {
      let thrown: unknown;
      try {
        amend({
          contract: tamperedContract(),
          reason: 'x'.repeat(MAX_REASON_LENGTH + 1),
          at: AT,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(IntegrityError);
    });

    it('refuses a blank reason — the reason IS the audit trail', () => {
      expect(() => amend({ contract: frozenContract(), reason: '   ', at: AT })).toThrow(
        UsageError,
      );
    });

    it('refuses a reason longer than the recorded limit', () => {
      const tooLong = 'x'.repeat(MAX_REASON_LENGTH + 1);

      expect(() => amend({ contract: frozenContract(), reason: tooLong, at: AT })).toThrow(
        UsageError,
      );
    });

    it('accepts a reason exactly at the limit', () => {
      const exact = 'x'.repeat(MAX_REASON_LENGTH);

      expect(() => amend({ contract: frozenContract(), reason: exact, at: AT })).not.toThrow();
    });
  });

  describe('purity (AD-1, AD-9)', () => {
    const RAW = readFileSync(join(process.cwd(), 'src', 'authoring', 'amend.ts'), 'utf8');

    /**
     * Comments stripped before scanning.
     *
     * The module header explains WHY there is no `new Date()` here, which means
     * the forbidden string appears in prose — and the first version of this
     * guard failed on its own documentation. A guard that cannot tell code from
     * a comment about code teaches people to delete the comment, which is
     * exactly backwards.
     */
    const SOURCE = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    it('imports no filesystem, process or child-process module', () => {
      // A source scan rather than a mock: the property is "this module cannot
      // do I/O", and mocking every entry point would prove only that the ones
      // we thought of are unused.
      expect(SOURCE).not.toMatch(/from '(node:)?(fs|fs\/promises|child_process|os|path)'/);
    });

    it('never reads the wall clock — the instant is injected', () => {
      // AD-9. `new Date()` with no argument anywhere in src/authoring/** would
      // make the recorded timestamp untestable and the history non-reproducible.
      expect(SOURCE).not.toMatch(/new Date\(\s*\)/);
      expect(SOURCE).not.toMatch(/Date\.now\(/);
    });

    it('does not import the CLI layer', () => {
      // AD-1: src/authoring/** is application layer; depcruise enforces this
      // too, but a reader of this file should see the constraint stated.
      expect(SOURCE).not.toMatch(/from '\.\.\/cli\//);
    });
  });
});

/**
 * Story 3.8 — what an amendment does to provenance, now that provenance is real.
 *
 * Until 3.8, `meta.provenance.model` and `.providerCliVersion` were `null` in
 * every contract ever written, so "amend preserves provenance" was a statement
 * about two nulls and one provider name. It is worth something now, and the
 * story asked for the behaviour to be decided, stated and pinned.
 *
 * THE DECISION: an amended contract PRESERVES the original generation
 * provenance, and today's code already does. That is correct, and not merely
 * convenient. `meta.provenance` answers one question — what generated this
 * draft — and an amendment is a human act with no provider behind it:
 * `amend()` is pure, spawns nothing, and never sees an `AgentProvider`.
 * Overwriting provenance with the amending run's details would claim a provider
 * authored content it never saw, in the one field whose entire purpose is to be
 * trustworthy. The amendment is recorded where amendments belong — in
 * `meta.history`, with the superseded version, its fingerprint, the instant and
 * the operator's reason.
 *
 * So the test is the deliverable. `amend()` keeps provenance through a
 * `...contract.meta` spread, which means preservation is currently a property of
 * a spread operator rather than of a stated intention — exactly the "unasserted
 * half of a decision" that Epic 2's retrospective named as where bugs live. If
 * someone later reaches for `provenance: freshProvenance` in that object, these
 * assertions are what stops them.
 */
describe('amend — provenance is preserved, never re-attributed (AD-5, story 3.8)', () => {
  /** What story 3.8 writes on a claude path where the CLI reported a version. */
  const AUTHORED = {
    provider: 'claude',
    model: null,
    providerCliVersion: '2.1.251 (Claude Code)',
    generatedAt: '2026-08-30T00:00:00.000Z',
  } as const;

  function frozenWithRealProvenance(): Contract {
    const base = frozenContract();
    return { ...base, meta: { ...base.meta, provenance: AUTHORED } };
  }

  it('carries populated provenance through the amendment untouched', () => {
    const current = frozenWithRealProvenance();

    const result = amend({ contract: current, reason: 'scope reduced', at: LATER });

    expect(result.meta.provenance).toEqual(AUTHORED);
    // Field by field, so a partial overwrite cannot hide behind a deep equal on
    // an object that happens to match.
    expect(result.meta.provenance.providerCliVersion).toBe('2.1.251 (Claude Code)');
    expect(result.meta.provenance.provider).toBe('claude');
    expect(result.meta.provenance.model).toBeNull();
  });

  it('does not re-stamp generatedAt with the amending instant', () => {
    // The sharpest form of the mistake: `generatedAt` is the one provenance
    // field an amendment has an obvious wrong answer for, because the amending
    // instant is right there in the call. It belongs to the ORIGINAL generation.
    const current = frozenWithRealProvenance();

    const result = amend({ contract: current, reason: 'scope reduced', at: LATER });

    expect(result.meta.provenance.generatedAt).toBe('2026-08-30T00:00:00.000Z');
    expect(result.meta.provenance.generatedAt).not.toBe(LATER.toISOString());
  });

  it('records the amendment in history rather than in provenance', () => {
    // Where the amendment DOES get recorded, so the two are not confused: the
    // audit trail grows, provenance does not move.
    const current = frozenWithRealProvenance();

    const result = amend({ contract: current, reason: 'scope reduced', at: LATER });

    expect(result.meta.history).toHaveLength(1);
    expect(result.meta.history[0]?.timestamp).toBe(LATER.toISOString());
    expect(result.meta.history[0]?.reason).toBe('scope reduced');
    expect(result.meta.provenance).toEqual(current.meta.provenance);
  });

  it('survives a second amendment, still naming the original generation', () => {
    // Provenance must not decay over a chain of amendments — after two, the
    // contract still says what drafted it, and the history has two entries.
    const first = amend({
      contract: frozenWithRealProvenance(),
      reason: 'scope reduced',
      at: AT,
    });
    const refrozen = freeze(first, LATER);

    const second = amend({ contract: refrozen, reason: 'wording corrected', at: LATER });

    expect(second.meta.provenance).toEqual(AUTHORED);
    expect(second.meta.history).toHaveLength(2);
  });

  it('leaves the amended draft ready to re-freeze with provenance intact', () => {
    // End to end through the real serializer: amend, write, read back. An
    // amendment must not be the place a version string quietly disappears.
    const amended = amend({
      contract: frozenWithRealProvenance(),
      reason: 'scope reduced',
      at: LATER,
    });

    const reparsed = parseContract(serializeContract(amended), 'contracts/epic-7.yaml');

    expect(reparsed.meta.provenance).toEqual(AUTHORED);
    expect(reparsed.spec.version).toBe(amended.spec.version);
    expect(reparsed.meta.frozen).toBe(false);
  });
});
