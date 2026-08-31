import { describe, expect, it } from 'vitest';

import {
  CONTRACT_STATUS_SCHEMA_VERSION,
  integrityFor,
  renderStatusHuman,
  renderStatusJson,
  type ContractStatus,
} from '../../../src/cli/contract/render.js';

/**
 * The `--status --json` shape is a PUBLIC CONTRACT from the moment this merges:
 * the harness parses it, and story 2.7 adds a field to it. So it is pinned by
 * hand-written `toEqual` assertions on the whole document, exactly as
 * `tests/unit/doctor/render.test.ts` pins doctor's. There are no snapshot files
 * anywhere in this repository and none are introduced here.
 */

const FROZEN: ContractStatus = {
  epic: 'epic-7',
  path: '.specwitness/contracts/epic-7.yaml',
  state: 'frozen',
  integrity: 'ok',
  version: 2,
  fingerprint: 'a'.repeat(64),
  criteriaCount: 12,
  frozenAt: '2026-08-31T06:12:41.000Z',
};

const ABSENT: ContractStatus = {
  epic: 'epic-9',
  path: '.specwitness/contracts/epic-9.yaml',
  state: 'absent',
  integrity: 'not-applicable',
  version: null,
  fingerprint: null,
  criteriaCount: null,
  frozenAt: null,
};

const DRAFT: ContractStatus = {
  epic: 'epic-7',
  path: '.specwitness/contracts/epic-7.yaml',
  state: 'draft',
  integrity: 'not-frozen',
  version: 1,
  fingerprint: null,
  criteriaCount: 5,
  frozenAt: null,
};

const TAMPERED: ContractStatus = {
  epic: 'epic-7',
  path: '.specwitness/contracts/epic-7.yaml',
  state: 'tampered',
  integrity: 'mismatch',
  version: 1,
  fingerprint: 'b'.repeat(64),
  criteriaCount: 5,
  frozenAt: '2026-08-31T06:12:41.000Z',
};

describe('integrityFor', () => {
  it('maps every contract state to its integrity answer', () => {
    expect(integrityFor('absent')).toBe('not-applicable');
    expect(integrityFor('draft')).toBe('not-frozen');
    expect(integrityFor('frozen')).toBe('ok');
    expect(integrityFor('tampered')).toBe('mismatch');
  });
});

describe('renderStatusJson', () => {
  it('emits the full frozen document, field for field', () => {
    expect(JSON.parse(renderStatusJson(FROZEN))).toEqual({
      schemaVersion: 1,
      epic: 'epic-7',
      path: '.specwitness/contracts/epic-7.yaml',
      state: 'frozen',
      integrity: 'ok',
      version: 2,
      fingerprint: 'a'.repeat(64),
      criteriaCount: 12,
      frozenAt: '2026-08-31T06:12:41.000Z',
    });
  });

  it('reports an absent contract as a complete document with explicit nulls', () => {
    // AC3: absence is a normal status answer. Every key is present and null,
    // never omitted — an absent key is indistinguishable from one an older
    // writer never knew about.
    expect(JSON.parse(renderStatusJson(ABSENT))).toEqual({
      schemaVersion: 1,
      epic: 'epic-9',
      path: '.specwitness/contracts/epic-9.yaml',
      state: 'absent',
      integrity: 'not-applicable',
      version: null,
      fingerprint: null,
      criteriaCount: null,
      frozenAt: null,
    });
  });

  it('reports a tampered contract as a field rather than refusing to answer', () => {
    const parsed = JSON.parse(renderStatusJson(TAMPERED)) as Record<string, unknown>;

    expect(parsed.state).toBe('tampered');
    expect(parsed.integrity).toBe('mismatch');
  });

  it('never omits a key, in any state', () => {
    const keys = [
      'schemaVersion',
      'epic',
      'path',
      'state',
      'integrity',
      'version',
      'fingerprint',
      'criteriaCount',
      'frozenAt',
    ].sort();

    for (const status of [FROZEN, ABSENT, DRAFT, TAMPERED]) {
      expect(Object.keys(JSON.parse(renderStatusJson(status)) as object).sort()).toEqual(keys);
    }
  });

  it('pins schemaVersion at 1 — later changes must be additive', () => {
    expect(CONTRACT_STATUS_SCHEMA_VERSION).toBe(1);
  });

  it('ends with a newline so shell redirection produces a well-formed file', () => {
    expect(renderStatusJson(FROZEN).endsWith('\n')).toBe(true);
  });

  it('is byte-identical across calls, so two status reads diff cleanly', () => {
    expect(renderStatusJson(FROZEN)).toBe(renderStatusJson(FROZEN));
  });

  it('emits parseable JSON and nothing else', () => {
    expect(() => JSON.parse(renderStatusJson(TAMPERED))).not.toThrow();
  });
});

describe('renderStatusHuman', () => {
  it('names the epic, the state and the fingerprint', () => {
    const text = renderStatusHuman(FROZEN);

    expect(text).toContain('epic-7');
    expect(text).toContain('frozen');
    expect(text).toContain('a'.repeat(64));
  });

  it('prints the fingerprint in full, never truncated', () => {
    // UJ-1's climax is the operator seeing the fingerprint. An abbreviated one
    // cannot be compared against a contract file by eye.
    expect(renderStatusHuman(FROZEN)).not.toContain('…');
    expect(renderStatusHuman(FROZEN)).not.toContain('...');
  });

  it('says plainly that no contract exists rather than printing empty fields', () => {
    const text = renderStatusHuman(ABSENT);

    expect(text.toLowerCase()).toContain('no contract');
    expect(text).toContain('epic-9');
  });

  it('states what a draft still needs', () => {
    expect(renderStatusHuman(DRAFT).toLowerCase()).toContain('freeze');
  });

  it('reports tampering unmistakably, not as a footnote', () => {
    const text = renderStatusHuman(TAMPERED).toLowerCase();

    expect(text).toContain('tampered');
    expect(text).toContain('does not match');
  });

  it('ends with a newline', () => {
    expect(renderStatusHuman(FROZEN).endsWith('\n')).toBe(true);
  });
});
