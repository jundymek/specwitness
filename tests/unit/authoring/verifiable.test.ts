import { describe, expect, it } from 'vitest';

import {
  assertVerifiableContract,
  contractStatusState,
  type LoadedContract,
} from '../../../src/authoring/verifiable.js';
import type { Contract } from '../../../src/domain/contract.js';
import { IntegrityError } from '../../../src/domain/errors.js';
import { ContractNotFrozenError, freeze } from '../../../src/schemas/contract.js';

/**
 * AC4's guard, in isolation. Epic 3 story 3.7 wires it into the verify path;
 * nothing here registers a command.
 */

function draftContract(): Contract {
  return {
    spec: {
      epic: 'epic-7',
      version: 1,
      criteria: [
        {
          id: 'E7-01',
          statement: 'The command prints the fingerprint.',
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
      createdAt: '2026-08-31T06:12:41.000Z',
      frozenAt: null,
      provenance: {
        provider: 'hermetic',
        model: null,
        providerCliVersion: null,
        generatedAt: '2026-08-31T06:12:41.000Z',
      },
      history: [],
    },
  };
}

function frozenContract(): Contract {
  return freeze(draftContract(), new Date('2026-08-31T06:12:41.000Z'));
}

/** A frozen contract whose statement was edited afterwards — the tamper case. */
function tamperedContract(): Contract {
  const frozen = frozenContract();
  return {
    ...frozen,
    spec: {
      ...frozen.spec,
      criteria: [
        { ...(frozen.spec.criteria[0] as Contract['spec']['criteria'][number]), statement: 'Edited after freezing.' },
      ],
    },
  };
}

describe('assertVerifiableContract — absent', () => {
  const absent: LoadedContract = { present: false, epic: 'epic-7', path: '.specwitness/contracts/epic-7.yaml' };

  it('refuses when no contract exists', () => {
    expect(() => assertVerifiableContract(absent)).toThrow(IntegrityError);
  });

  it('names the contract workflow in its hint', () => {
    expect(() => assertVerifiableContract(absent)).toThrow(
      expect.objectContaining({ hint: expect.stringContaining('specwitness contract epic-7') }),
    );
  });

  it('names the expected path so the operator knows where it looked', () => {
    let message = '';
    try {
      assertVerifiableContract(absent);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('.specwitness/contracts/epic-7.yaml');
  });
});

describe('assertVerifiableContract — never frozen', () => {
  const drafted: LoadedContract = {
    present: true,
    epic: 'epic-7',
    path: '.specwitness/contracts/epic-7.yaml',
    contract: draftContract(),
  };

  it('refuses a draft', () => {
    expect(() => assertVerifiableContract(drafted)).toThrow(ContractNotFrozenError);
  });

  it('tells the operator to freeze it, distinctly from the absent case', () => {
    expect(() => assertVerifiableContract(drafted)).toThrow(
      expect.objectContaining({ hint: expect.stringContaining('--freeze') }),
    );
  });
});

describe('assertVerifiableContract — tampered', () => {
  const tampered: LoadedContract = {
    present: true,
    epic: 'epic-7',
    path: '.specwitness/contracts/epic-7.yaml',
    contract: tamperedContract(),
  };

  it('refuses a frozen contract whose content changed', () => {
    expect(() => assertVerifiableContract(tampered)).toThrow(IntegrityError);
  });

  it('is NOT reported as a never-frozen contract', () => {
    // A tamper reported as "not frozen yet" would invite the operator to
    // freeze over it, which launders the edit into a legitimate contract.
    expect(() => assertVerifiableContract(tampered)).not.toThrow(ContractNotFrozenError);
  });

  it('points at the amend flow rather than at --freeze', () => {
    expect(() => assertVerifiableContract(tampered)).toThrow(
      expect.objectContaining({ hint: expect.stringContaining('--amend') }),
    );
  });
});

describe('assertVerifiableContract — frozen and intact', () => {
  it('passes silently', () => {
    expect(() =>
      assertVerifiableContract({
        present: true,
        epic: 'epic-7',
        path: '.specwitness/contracts/epic-7.yaml',
        contract: frozenContract(),
      }),
    ).not.toThrow();
  });
});

describe('contractStatusState — the non-throwing query', () => {
  it('reports absent', () => {
    expect(
      contractStatusState({ present: false, epic: 'epic-7', path: 'p' }),
    ).toBe('absent');
  });

  it('reports draft', () => {
    expect(
      contractStatusState({ present: true, epic: 'epic-7', path: 'p', contract: draftContract() }),
    ).toBe('draft');
  });

  it('reports frozen', () => {
    expect(
      contractStatusState({ present: true, epic: 'epic-7', path: 'p', contract: frozenContract() }),
    ).toBe('frozen');
  });

  it('reports tampered', () => {
    expect(
      contractStatusState({ present: true, epic: 'epic-7', path: 'p', contract: tamperedContract() }),
    ).toBe('tampered');
  });

  it('never throws, for any state — that is the point of it', () => {
    for (const loaded of [
      { present: false as const, epic: 'epic-7', path: 'p' },
      { present: true as const, epic: 'epic-7', path: 'p', contract: draftContract() },
      { present: true as const, epic: 'epic-7', path: 'p', contract: tamperedContract() },
    ]) {
      expect(() => contractStatusState(loaded)).not.toThrow();
    }
  });
});
