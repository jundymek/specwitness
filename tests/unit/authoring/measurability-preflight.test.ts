import { describe, expect, it } from 'vitest';

import { preflightMeasurability } from '../../../src/authoring/measurability-preflight.js';
import type { Contract } from '../../../src/domain/contract.js';
import { scriptedProvider } from '../../fakes/agent-provider.js';

/**
 * The question this asks — "which declared instrument would measure this?" — is
 * one `plan-author` already answers, but only after the freeze, when ADR-005
 * has made the cheap fix unavailable. On tenstandard's epic 6 that timing cost
 * 34 criteria of 91.
 *
 * What these tests pin is the part that makes the check trustworthy rather than
 * merely present: an answer that omits criteria must be REJECTED, because an
 * operator reading "3 unmeasurable" when 34 are would freeze with more
 * confidence than they had before, which is worse than not asking.
 */

function contractWith(ids: readonly string[]): Contract {
  return {
    spec: {
      epic: 'epic-1',
      version: 1,
      criteria: ids.map((id) => ({
        id,
        statement: `${id} states something`,
        kind: 'behavioral' as const,
        severity: 'critical' as const,
        verifiability: 'automated' as const,
      })),
    },
    meta: {
      schemaVersion: 1,
      frozen: false,
      fingerprint: null,
      createdAt: '2026-09-21T00:00:00.000Z',
      frozenAt: null,
      provenance: {
        provider: 'codex',
        model: null,
        providerCliVersion: '0.1.0',
        generatedAt: '2026-09-21T00:00:00.000Z',
      },
      history: [],
    },
  } as unknown as Contract;
}

/** Replies with exactly the payload a test hands it, as raw JSON. */
function providerReplying(payload: unknown) {
  return scriptedProvider(JSON.stringify(payload));
}

const clock = { now: () => new Date('2026-09-21T00:00:00.000Z') };

describe('preflightMeasurability', () => {
  it('separates the criteria nothing can measure from the rest', async () => {
    const report = await preflightMeasurability({
      contract: contractWith(['E1-01', 'E1-02']),
      declared: { serviceIds: [], commandIds: ['ui-facts'] },
      provider: providerReplying({
        verdicts: [
          { criterionId: 'E1-01', instrument: 'ui-facts', note: 'reports the heading' },
          { criterionId: 'E1-02', instrument: null, note: 'no observation reports component attributes' },
        ],
      }),
      clock,
    });

    expect(report.verdicts).toHaveLength(2);
    expect(report.unmeasurable.map((v) => v.criterionId)).toEqual(['E1-02']);
  });

  it('rejects an answer that skips a criterion, because a short list understates the problem', async () => {
    await expect(
      preflightMeasurability({
        contract: contractWith(['E1-01', 'E1-02', 'E1-03']),
        declared: { serviceIds: [], commandIds: ['ui-facts'] },
        provider: providerReplying({
          verdicts: [{ criterionId: 'E1-01', instrument: 'ui-facts', note: 'reports it' }],
        }),
        clock,
      }),
    ).rejects.toThrow();
  });

  it('rejects an invented criterion id', async () => {
    await expect(
      preflightMeasurability({
        contract: contractWith(['E1-01']),
        declared: { serviceIds: [], commandIds: [] },
        provider: providerReplying({
          verdicts: [
            { criterionId: 'E1-01', instrument: null, note: 'nothing' },
            { criterionId: 'E1-99', instrument: 'ui-facts', note: 'not in this contract' },
          ],
        }),
        clock,
      }),
    ).rejects.toThrow();
  });

  it('rejects a duplicated criterion, which would let one answer hide another', async () => {
    await expect(
      preflightMeasurability({
        contract: contractWith(['E1-01', 'E1-02']),
        declared: { serviceIds: [], commandIds: [] },
        provider: providerReplying({
          verdicts: [
            { criterionId: 'E1-01', instrument: 'ui-facts', note: 'a' },
            { criterionId: 'E1-01', instrument: null, note: 'b' },
          ],
        }),
        clock,
      }),
    ).rejects.toThrow();
  });

  it('requires a note, so "null" always comes with what is missing', async () => {
    await expect(
      preflightMeasurability({
        contract: contractWith(['E1-01']),
        declared: { serviceIds: [], commandIds: [] },
        provider: providerReplying({ verdicts: [{ criterionId: 'E1-01', instrument: null, note: '  ' }] }),
        clock,
      }),
    ).rejects.toThrow();
  });
});
