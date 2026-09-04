/**
 * Story 5.6, AC1 + AC2 — the structural immutability of the adaptation payload.
 *
 * AC1's operative phrase is **"schema-enforced"**, and this file is where that is
 * proved. Every rejection below is an UNKNOWN-KEY rejection: the payload has
 * nowhere to put the thing being attempted, so it fails validation rather than
 * failing a rule somebody remembered to write.
 *
 * ⚠️ EVERY REJECTION HERE WAS VERIFIED RED against a deliberately neutered
 * schema before being trusted — the planting table is in the story's Dev Agent
 * Record and in the PR body. A guard is only a guard once you have seen it fail
 * (Epic 4 retro section 2 observation 7, section 3 lesson 7), and a passing test
 * against an unfixed implementation is worse than no test at all because it
 * reads as coverage.
 *
 * THE OVER-REFUSAL HALF IS NOT OPTIONAL EITHER. A suite that only ever rejects
 * proves nothing about whether the feature works — `z.never()` would pass it. The
 * `accepts` describe-block is what stops this schema being vacuously safe.
 */

import { describe, expect, it } from 'vitest';

import { MechanicsAdaptationSchema } from '../../../src/schemas/adaptation.js';

/** A payload the schema must accept, used as the base every hostile case mutates. */
const legal = {
  proposals: [{ probeId: 'submit-order', mechanics: { scenario: 'click "#add-organization"' } }],
};

/** Parses and asserts refusal, returning the joined messages for readability. */
function reject(payload: unknown): string {
  const result = MechanicsAdaptationSchema.safeParse(payload);
  expect(result.success, `expected refusal, but the payload parsed: ${JSON.stringify(payload)}`).toBe(
    false,
  );
  return result.success ? '' : result.error.issues.map((issue) => issue.message).join(' | ');
}

describe('accepts a legal mechanics-only payload', () => {
  it('takes a scenario-only proposal — the relabelled-button case FR-18 exists for', () => {
    const parsed = MechanicsAdaptationSchema.safeParse(legal);

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.proposals[0]?.mechanics.scenario).toBe(
      'click "#add-organization"',
    );
  });

  it('takes a path-only proposal', () => {
    expect(
      MechanicsAdaptationSchema.safeParse({
        proposals: [{ probeId: 'p1', mechanics: { path: '/organizations' } }],
      }).success,
    ).toBe(true);
  });

  it('takes both fields at once, and several probes in one payload', () => {
    expect(
      MechanicsAdaptationSchema.safeParse({
        proposals: [
          { probeId: 'p1', mechanics: { path: '/organizations', scenario: 'click "#x"' } },
          { probeId: 'p2', mechanics: { scenario: 'waitFor "#y"' } },
        ],
      }).success,
    ).toBe(true);
  });
});

describe('AC2 — an assertion or expected value has NOWHERE to be written', () => {
  it('refuses an assertion edit inside mechanics', () => {
    expect(
      reject({
        proposals: [
          {
            probeId: 'p1',
            mechanics: {
              scenario: 'click "#x"',
              assertions: [{ target: { source: 'title' }, comparison: 'equals', expected: 'Orders' }],
            },
          },
        ],
      }),
    ).toMatch(/unrecognized|unknown/i);
  });

  it('refuses an assertion edit smuggled in beside the proposal', () => {
    reject({
      proposals: [
        {
          probeId: 'p1',
          mechanics: { scenario: 'click "#x"' },
          assertions: [{ target: { source: 'title' }, comparison: 'equals', expected: 'Orders' }],
        },
      ],
    });
  });

  it('refuses a bare expected-value edit — the single most dangerous field in the product', () => {
    reject({ proposals: [{ probeId: 'p1', mechanics: { scenario: 'click "#x"', expected: '200' } }] });
  });

  it('refuses an ADDED assertion', () => {
    reject({
      proposals: [{ probeId: 'p1', mechanics: { scenario: 'click "#x"' }, addAssertion: { expected: 'ok' } }],
    });
  });

  it('refuses a REMOVED assertion — deletion is an edit too', () => {
    reject({
      proposals: [{ probeId: 'p1', mechanics: { scenario: 'click "#x"' }, removeAssertion: 0 }],
    });
  });

  it('refuses a comparison change', () => {
    reject({ proposals: [{ probeId: 'p1', mechanics: { scenario: 'click "#x"', comparison: 'notEquals' } }] });
  });

  it('refuses an assertion TARGET change — the half of an assertion that is not the expected value', () => {
    reject({
      proposals: [{ probeId: 'p1', mechanics: { scenario: 'click "#x"', target: { source: 'url' } } }],
    });
  });
});

describe('AC2 — a probe identity has nowhere to be written', () => {
  it('refuses a probe id RENAME (probeId selects; it never renames)', () => {
    reject({ proposals: [{ probeId: 'p1', mechanics: { scenario: 'click "#x"' }, id: 'p2' }] });
  });

  it('refuses an id inside mechanics', () => {
    reject({ proposals: [{ probeId: 'p1', mechanics: { scenario: 'click "#x"', id: 'p2' } }] });
  });

  it('refuses a surface change — no probe may become a shell probe', () => {
    reject({ proposals: [{ probeId: 'p1', mechanics: { scenario: 'click "#x"' }, surface: 'shell' }] });
  });

  it('refuses a criterionId — a provider may not move a probe to another criterion', () => {
    reject({ proposals: [{ probeId: 'p1', mechanics: { scenario: 'click "#x"' }, criterionId: 'E1-02' }] });
  });
});

describe('AD-3 — no URL, host, origin or command may be introduced', () => {
  it('refuses a url field outright', () => {
    reject({ proposals: [{ probeId: 'p1', mechanics: { url: 'https://prod.example.com/x' } }] });
  });

  it('refuses a host field outright', () => {
    reject({ proposals: [{ probeId: 'p1', mechanics: { scenario: 'click "#x"', host: 'prod.example.com' } }] });
  });

  it('refuses an absolute URL smuggled through the path field', () => {
    reject({ proposals: [{ probeId: 'p1', mechanics: { path: 'https://prod.example.com/x' } }] });
  });

  it('refuses a PROTOCOL-RELATIVE url through the path field', () => {
    reject({ proposals: [{ probeId: 'p1', mechanics: { path: '//prod.example.com/x' } }] });
  });

  it('refuses the BACKSLASH host escape — WHATWG resolves /\\evil/x to https://evil/x', () => {
    // The attack `src/schemas/plan.ts` records as the one that nearly got through.
    // It is refused here because this schema IMPORTS that rule rather than restating it;
    // a second copy of the regex is a second thing to keep in step with this attack.
    reject({ proposals: [{ probeId: 'p1', mechanics: { path: '/\\evil.example.com/x' } }] });
  });

  it('refuses a command string', () => {
    reject({ proposals: [{ probeId: 'p1', mechanics: { scenario: 'click "#x"', command: 'rm -rf /' } }] });
  });

  it('refuses a commandId — no probe may acquire a declared command', () => {
    reject({ proposals: [{ probeId: 'p1', mechanics: { scenario: 'click "#x"', commandId: 'seed' } }] });
  });

  it('refuses args', () => {
    reject({ proposals: [{ probeId: 'p1', mechanics: { scenario: 'click "#x"', args: ['--force'] } }] });
  });

  it('refuses a probeId that is a command line rather than a config id', () => {
    reject({ proposals: [{ probeId: 'rm -rf /', mechanics: { scenario: 'click "#x"' } }] });
  });
});

describe('D2 — serviceId is refused, deliberately', () => {
  it('refuses a service repoint even though serviceId is a mechanics field', () => {
    // FR-18 and AD-2 permit "(locators, navigation)". serviceId is the ORIGIN BINDING and
    // is neither; repointing a probe at another declared service changes WHAT is verified.
    // Narrower than the merged mechanics type on purpose — see the module header and D2.
    reject({ proposals: [{ probeId: 'p1', mechanics: { serviceId: 'other-backend' } }] });
  });

  it('refuses serviceId even alongside a legal scenario change', () => {
    reject({
      proposals: [{ probeId: 'p1', mechanics: { serviceId: 'other-backend', scenario: 'click "#x"' } }],
    });
  });
});

describe('AC2 — nothing partially applies', () => {
  it('refuses a MIXED payload entirely: one legal proposal, one illegal', () => {
    // FR-14 and `src/providers/invoke.ts:20-24` — a rejected payload is "never parsed for
    // partial data, never merged with a later attempt". The legal half is NOT salvaged.
    const payload = {
      proposals: [
        { probeId: 'legal-probe', mechanics: { scenario: 'click "#add-organization"' } },
        { probeId: 'hostile-probe', mechanics: { scenario: 'click "#x"', expected: 'anything' } },
      ],
    };

    const result = MechanicsAdaptationSchema.safeParse(payload);

    expect(result.success).toBe(false);
    // The whole payload is refused, so there is no `data` to salvage the legal half from.
    // This is the type-level property AD-2 gives us, asserted rather than assumed.
    expect(result.success ? result.data : undefined).toBeUndefined();
  });

  it('refuses a mixed payload where the ILLEGAL half comes first', () => {
    reject({
      proposals: [
        { probeId: 'hostile-probe', mechanics: { assertions: [] } },
        { probeId: 'legal-probe', mechanics: { scenario: 'click "#add-organization"' } },
      ],
    });
  });
});

describe('payload shape', () => {
  it('refuses an unknown top-level key', () => {
    reject({ proposals: legal.proposals, note: 'trust me' });
  });

  it('refuses an empty proposal — a change that changes nothing', () => {
    expect(reject({ proposals: [{ probeId: 'p1', mechanics: {} }] })).toMatch(
      /at least one mechanics field/,
    );
  });

  it('refuses an empty proposals array', () => {
    expect(reject({ proposals: [] })).toMatch(/at least one proposal/);
  });

  it('refuses two proposals for one probe — an ambiguous audit record is not an audit record', () => {
    expect(
      reject({
        proposals: [
          { probeId: 'p1', mechanics: { scenario: 'click "#a"' } },
          { probeId: 'p1', mechanics: { scenario: 'click "#b"' } },
        ],
      }),
    ).toMatch(/duplicate proposal/);
  });

  it('refuses an unbounded payload', () => {
    reject({
      proposals: Array.from({ length: 65 }, (_unused, index) => ({
        probeId: `p${index}`,
        mechanics: { scenario: 'click "#x"' },
      })),
    });
  });

  it('refuses a whitespace-only scenario', () => {
    reject({ proposals: [{ probeId: 'p1', mechanics: { scenario: '   ' } }] });
  });

  it('refuses a non-object payload', () => {
    reject('nothing to see here');
  });
});
