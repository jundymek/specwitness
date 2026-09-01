import { describe, expect, it } from 'vitest';

import { isReferenceableId, unreferenceableIds } from '../../../src/schemas/plan.js';

/**
 * The plan's id pattern is STRICTER than the config's key type, and that asymmetry is
 * deliberate — but it must be diagnosed rather than discovered.
 *
 * `src/config/schema.ts` accepts any non-empty string as a `services:` or
 * `observations:` key. A plan's `serviceId` / `commandId` is constrained to an
 * id-shaped token, because that constraint is what stops a command line being smuggled
 * through the field. So a project CAN declare a key no plan is able to reference.
 *
 * Loosening the pattern is not on the table: it is a security control, and the whole epic's
 * boundary rests on it. What was wrong was the FAILURE MODE — the plan-author was told
 * about a key it could not use, drafted a probe naming it, and burned the whole retry
 * budget learning that. Now the key is withheld from the prompt and the operator is told,
 * by name, with the fix.
 *
 * Raised by story 4.1's agent at cohort intent-sync and again by the Codex review pass.
 */

describe('isReferenceableId', () => {
  it.each(['backend', 'company-count', 'api_v2', 'db.primary', 'a', 'A1'])(
    'accepts the id-shaped key %o',
    (id) => {
      expect(isReferenceableId(id)).toBe(true);
    },
  );

  it.each([
    ['a space', 'public api'],
    ['a slash', 'scripts/count'],
    ['a leading hyphen', '-hidden'],
    ['a command line', 'rm -rf /'],
    ['a pipe', 'count | sh'],
    ['empty', ''],
  ])('rejects %s', (_why, id) => {
    expect(isReferenceableId(id)).toBe(false);
  });
});

describe('unreferenceableIds', () => {
  it('names every declared key a plan could not reference', () => {
    expect(
      unreferenceableIds({
        serviceIds: ['backend', 'public api'],
        commandIds: ['company-count', 'scripts/count'],
      }),
    ).toEqual([
      { kind: 'service', id: 'public api' },
      { kind: 'observation', id: 'scripts/count' },
    ]);
  });

  it('is empty for a project whose keys are all id-shaped', () => {
    expect(
      unreferenceableIds({ serviceIds: ['backend'], commandIds: ['company-count'] }),
    ).toEqual([]);
  });
});
