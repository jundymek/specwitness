import { describe, expect, it } from 'vitest';

import { resolveChildEnvironment } from '../../../src/infra/process-runner.js';

/**
 * AD-4's child-environment construction, unit-tested away from any spawn.
 *
 * The spawning behaviour is proved in `tests/integration/process-runner.test.ts`
 * against a real child; this file pins the resolution RULES, which is where a
 * subtle mistake (withhold applied after set, a mutated parent) would hide.
 *
 * File name note: this is `process-runner-env.test.ts`, not
 * `process-runner.env.test.ts`, because the latter reads as a dotenv path to
 * tooling that scans for secret-bearing files.
 */
describe('resolveChildEnvironment', () => {
  it('starts from the parent environment when inherit is true', () => {
    const parent = { PATH: '/usr/bin', HOME: '/home/x' };

    expect(resolveChildEnvironment({ inherit: true }, parent)).toEqual(parent);
  });

  it('starts from nothing when inherit is false', () => {
    const parent = { PATH: '/usr/bin', SOME_TOKEN: 'value' };

    expect(resolveChildEnvironment({ inherit: false }, parent)).toEqual({});
  });

  it('deletes every withheld name from an inherited environment', () => {
    // FR-15's whole point: a subscription-mode child must not be able to bill an
    // API account. The names are supplied by the caller (2.4/2.5); this port
    // only guarantees the removal.
    const parent = { PATH: '/usr/bin', BILLING_KEY_A: 'secret-a', BILLING_KEY_B: 'secret-b' };

    const child = resolveChildEnvironment(
      { inherit: true, withhold: ['BILLING_KEY_A', 'BILLING_KEY_B'] },
      parent,
    );

    expect(child).toEqual({ PATH: '/usr/bin' });
  });

  it('treats withholding an absent name as a no-op', () => {
    const parent = { PATH: '/usr/bin' };

    expect(resolveChildEnvironment({ inherit: true, withhold: ['NOT_SET'] }, parent)).toEqual({
      PATH: '/usr/bin',
    });
  });

  it('is case-sensitive about withheld names', () => {
    // Documented rather than accidental: POSIX env names are case-sensitive, and
    // matching case-insensitively would make `withhold` mean something different
    // from what its own tests assert.
    const parent = { Billing_Key: 'secret' };

    expect(resolveChildEnvironment({ inherit: true, withhold: ['BILLING_KEY'] }, parent)).toEqual({
      Billing_Key: 'secret',
    });
  });

  it('applies `set` after `withhold`, so an explicitly set name survives', () => {
    // The caller asked for that value by name; honouring the explicit request is
    // less surprising than silently dropping it, and it is the only ordering
    // that lets a caller REPLACE a variable rather than only remove it.
    const child = resolveChildEnvironment(
      { inherit: true, withhold: ['TOKEN'], set: { TOKEN: 'replacement' } },
      { TOKEN: 'original' },
    );

    expect(child).toEqual({ TOKEN: 'replacement' });
  });

  it('lets `set` add names to an empty base', () => {
    const child = resolveChildEnvironment(
      { inherit: false, set: { PATH: '/usr/bin', LANG: 'C' } },
      { HOME: '/home/x' },
    );

    expect(child).toEqual({ PATH: '/usr/bin', LANG: 'C' });
  });

  it('drops parent names whose value is undefined', () => {
    // `process.env` is typed `Record<string, string | undefined>`, and an
    // undefined value must not reach the child as the string "undefined".
    const child = resolveChildEnvironment({ inherit: true }, { PATH: '/usr/bin', EMPTY: undefined });

    expect(child).toEqual({ PATH: '/usr/bin' });
    expect(Object.hasOwn(child, 'EMPTY')).toBe(false);
  });

  it('never mutates the parent environment it was given', () => {
    const parent = { PATH: '/usr/bin', BILLING_KEY: 'secret' };

    resolveChildEnvironment({ inherit: true, withhold: ['BILLING_KEY'], set: { X: '1' } }, parent);

    expect(parent).toEqual({ PATH: '/usr/bin', BILLING_KEY: 'secret' });
  });

  it('never mutates the ChildEnvironment it was given', () => {
    const spec = { inherit: true, withhold: ['A'], set: { B: '1' } };

    resolveChildEnvironment(spec, { A: 'a' });

    expect(spec).toEqual({ inherit: true, withhold: ['A'], set: { B: '1' } });
  });
});
