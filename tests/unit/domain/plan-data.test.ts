import { describe, expect, it } from 'vitest';

import { ConfigError } from '../../../src/domain/errors.js';
import type { DataBinding, PlanData } from '../../../src/domain/plan.js';
import {
  deriveVolatileValue,
  reproducibleInputs,
  resolveMechanics,
  resolvePlanData,
  substituteInputs,
  type ResolvedData,
} from '../../../src/domain/plan-data.js';

/**
 * Story 4.3, AC1 — deterministic test data (AD-9, FR-17, NFR-5, Q36).
 *
 * The negative requirement is the whole point: NOTHING here generates fresh data per run.
 * Values are decided at plan compile time and stored in the plan; a binding that legitimately
 * cannot carry a stored value is `volatile` and derives from the plan's recorded seed by a pure
 * function.
 */

const SEED = 'seed-epic-7-a1b2c3';

/**
 * Golden values, HAND-WRITTEN — never produced by the code under test (AD-12's rule for corpus
 * expectations, applied here for the same reason: a golden value the implementation generated
 * proves only that the implementation agrees with itself).
 *
 * Computed with an independent implementation, a Python one-liner over the same definition
 * (FNV-1a 64-bit of `seed + "\0" + name`, rendered as 16 lowercase hex digits):
 *
 *   python3 -c "
 *   def fnv1a64(s):
 *       h = 14695981039346656037
 *       for b in s.encode('utf-8'):
 *           h ^= b
 *           h = (h * 1099511628211) % (1<<64)
 *       return format(h, '016x')
 *   print(fnv1a64('seed-epic-7-a1b2c3' + chr(0) + 'signupEmail'))"
 *
 * If a change to the derivation makes these fail, that is the test doing its job: the derivation
 * is a published contract (`intent.md` §3b), and changing it silently would make every plan
 * compiled before the change resolve differently after it.
 */
const GOLDEN = {
  signupEmail: 'c748ca2c001cf679',
  idempotencyKey: '64d619d4fd278daf',
  /** The SAME name under a different seed. */
  otherSeedSignupEmail: '9d307260ab10444d',
  /** The separator cases: ("ab","c") must not collide with ("a","bc"). */
  abThenC: 'fd61c083ef200867',
  aThenBc: 'ab40f6820d40b523',
} as const;

function planData(bindings: readonly DataBinding[], seed = SEED): PlanData {
  return { seed, bindings };
}

/** The resolved set as a plain, comparable, order-independent object. */
function snapshot(resolved: ResolvedData): Record<string, { value: string; volatile: boolean }> {
  const out: Record<string, { value: string; volatile: boolean }> = {};
  for (const [name, input] of resolved) {
    out[name] = { value: input.value, volatile: input.volatile };
  }
  return out;
}

const BINDINGS: readonly DataBinding[] = [
  { kind: 'fixed', name: 'planTitle', value: 'Quarterly report' },
  { kind: 'fixed', name: 'accountId', value: 'acct-00042' },
  { kind: 'volatile', name: 'signupEmail', reason: 'must not collide with a previous run row' },
  { kind: 'volatile', name: 'idempotencyKey', reason: 'the endpoint rejects a replayed key' },
];

describe('resolvePlanData — AC1: identical plans resolve to identical inputs', () => {
  it('resolves twice to a byte-identical input set', () => {
    // THE story's centre of gravity. Resolving once and eyeballing proves nothing about
    // run-to-run stability, so this resolves TWICE, from two separate calls, and diffs.
    const first = resolvePlanData(planData(BINDINGS));
    const second = resolvePlanData(planData(BINDINGS));

    expect(snapshot(second)).toStrictEqual(snapshot(first));
    // Byte-identical, stated as bytes rather than as deep equality.
    expect(JSON.stringify(snapshot(second))).toBe(JSON.stringify(snapshot(first)));
  });

  it('resolves every declared binding and nothing else', () => {
    const resolved = resolvePlanData(planData(BINDINGS));

    expect([...resolved.keys()].sort()).toStrictEqual([
      'accountId',
      'idempotencyKey',
      'planTitle',
      'signupEmail',
    ]);
  });

  it('uses a fixed binding value verbatim', () => {
    const resolved = resolvePlanData(planData(BINDINGS));

    expect(resolved.get('planTitle')?.value).toBe('Quarterly report');
    expect(resolved.get('planTitle')?.volatile).toBe(false);
  });

  it('carries the volatile DECLARATION through rather than dropping it', () => {
    const resolved = resolvePlanData(planData(BINDINGS));

    expect(resolved.get('signupEmail')?.volatile).toBe(true);
    expect(resolved.get('accountId')?.volatile).toBe(false);
  });

  it('resolves an empty binding list to an empty set', () => {
    expect(resolvePlanData(planData([])).size).toBe(0);
  });

  it('rejects a duplicate binding name rather than letting the last one win', () => {
    // Last-wins would make resolution depend on array order, which is precisely the
    // non-determinism this story removes.
    const duplicated: readonly DataBinding[] = [
      { kind: 'fixed', name: 'accountId', value: 'acct-1' },
      { kind: 'fixed', name: 'accountId', value: 'acct-2' },
    ];

    expect(() => resolvePlanData(planData(duplicated))).toThrow(ConfigError);
    expect(() => resolvePlanData(planData(duplicated))).toThrow(/accountId/);
  });

  it('does not resolve a binding through the prototype chain', () => {
    // A Map rather than a Record: `__proto__` must not reach Object.prototype.
    const resolved = resolvePlanData(
      planData([{ kind: 'fixed', name: '__proto__', value: 'harmless' }]),
    );

    expect(resolved.get('__proto__')?.value).toBe('harmless');
    expect(resolved.get('constructor')).toBeUndefined();
    expect(resolved.get('toString')).toBeUndefined();
  });
});

describe('deriveVolatileValue — the documented, machine-independent derivation', () => {
  it('produces the hand-written golden value for a fixed seed and name', () => {
    expect(deriveVolatileValue(SEED, 'signupEmail')).toBe(GOLDEN.signupEmail);
    expect(deriveVolatileValue(SEED, 'idempotencyKey')).toBe(GOLDEN.idempotencyKey);
  });

  it('feeds those exact values into the resolved set', () => {
    const resolved = resolvePlanData(planData(BINDINGS));

    expect(resolved.get('signupEmail')?.value).toBe(GOLDEN.signupEmail);
    expect(resolved.get('idempotencyKey')?.value).toBe(GOLDEN.idempotencyKey);
  });

  it('gives the same name a different value under a different seed', () => {
    expect(deriveVolatileValue('other-seed', 'signupEmail')).toBe(GOLDEN.otherSeedSignupEmail);
    expect(deriveVolatileValue('other-seed', 'signupEmail')).not.toBe(GOLDEN.signupEmail);
  });

  it('gives different names different values under one seed', () => {
    expect(deriveVolatileValue(SEED, 'signupEmail')).not.toBe(
      deriveVolatileValue(SEED, 'idempotencyKey'),
    );
  });

  it('separates seed from name so ("ab","c") cannot collide with ("a","bc")', () => {
    expect(deriveVolatileValue('ab', 'c')).toBe(GOLDEN.abThenC);
    expect(deriveVolatileValue('a', 'bc')).toBe(GOLDEN.aThenBc);
    expect(deriveVolatileValue('ab', 'c')).not.toBe(deriveVolatileValue('a', 'bc'));
  });

  it('always renders 16 lowercase hex digits', () => {
    for (const name of ['a', 'signupEmail', '', 'ünïcøde', 'x'.repeat(500)]) {
      expect(deriveVolatileValue(SEED, name)).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('is stable across repeated calls', () => {
    const once = deriveVolatileValue(SEED, 'signupEmail');
    for (let i = 0; i < 50; i += 1) {
      expect(deriveVolatileValue(SEED, 'signupEmail')).toBe(once);
    }
  });
});

describe('reproducibleInputs — AC1: exclusion is driven by the PLAN, not by a field name', () => {
  it('includes every fixed binding and excludes every volatile one', () => {
    const resolved = resolvePlanData(planData(BINDINGS));

    expect(reproducibleInputs(resolved)).toStrictEqual({
      planTitle: 'Quarterly report',
      accountId: 'acct-00042',
    });
  });

  it('compares equal across two resolutions that differ ONLY in their volatile values', () => {
    // The real assertion behind AC1: "byte-identical EXCEPT fields the plan declares volatile".
    // Two seeds keep every fixed value identical and make every volatile value differ, so this
    // is the exact difference the exclusion is supposed to absorb — and nothing else.
    const a = resolvePlanData(planData(BINDINGS, 'seed-one'));
    const b = resolvePlanData(planData(BINDINGS, 'seed-two'));

    // The raw sets genuinely differ...
    expect(snapshot(b)).not.toStrictEqual(snapshot(a));
    expect(b.get('signupEmail')?.value).not.toBe(a.get('signupEmail')?.value);

    // ...and the comparison the reproducibility guarantee is stated over does not.
    expect(reproducibleInputs(b)).toStrictEqual(reproducibleInputs(a));
  });

  it('excludes by DECLARATION: a binding named like a volatile one but declared fixed is kept', () => {
    // The failure mode this guards: excluding by field name works for the fixture and fails for
    // every real plan. `uniqueEmail` and `signupEmail` are exactly the names a name-based
    // heuristic would reach for.
    const declaredFixed: readonly DataBinding[] = [
      { kind: 'fixed', name: 'uniqueEmail', value: 'someone@example.test' },
      { kind: 'fixed', name: 'signupEmail', value: 'stored@example.test' },
      { kind: 'fixed', name: 'idempotencyKey', value: 'key-fixed' },
    ];

    expect(reproducibleInputs(resolvePlanData(planData(declaredFixed)))).toStrictEqual({
      uniqueEmail: 'someone@example.test',
      signupEmail: 'stored@example.test',
      idempotencyKey: 'key-fixed',
    });
  });

  it('includes by DECLARATION: a plainly-named binding declared volatile is excluded', () => {
    const declaredVolatile: readonly DataBinding[] = [
      { kind: 'fixed', name: 'keep', value: 'kept' },
      { kind: 'volatile', name: 'accountId', reason: 'the account is created per run' },
    ];

    expect(reproducibleInputs(resolvePlanData(planData(declaredVolatile)))).toStrictEqual({
      keep: 'kept',
    });
  });

  it('returns an empty comparison set when every binding is volatile', () => {
    const allVolatile: readonly DataBinding[] = [
      { kind: 'volatile', name: 'a', reason: 'r' },
      { kind: 'volatile', name: 'b', reason: 'r' },
    ];

    expect(reproducibleInputs(resolvePlanData(planData(allVolatile)))).toStrictEqual({});
  });
});

describe('substituteInputs — one string', () => {
  const resolved = resolvePlanData(planData(BINDINGS));

  it('substitutes a declared binding', () => {
    expect(substituteInputs('/accounts/{{accountId}}', resolved)).toBe('/accounts/acct-00042');
  });

  it('substitutes a volatile binding with its derived value', () => {
    expect(substituteInputs('user-{{signupEmail}}@example.test', resolved)).toBe(
      `user-${GOLDEN.signupEmail}@example.test`,
    );
  });

  it('substitutes several occurrences of several bindings', () => {
    expect(substituteInputs('{{accountId}}/{{planTitle}}/{{accountId}}', resolved)).toBe(
      'acct-00042/Quarterly report/acct-00042',
    );
  });

  it('returns text with no placeholder unchanged', () => {
    for (const text of ['', 'plain', '/a/b/c', 'a { b } c', '${shellish}', '{single}']) {
      expect(substituteInputs(text, resolved)).toBe(text);
    }
  });

  it('throws ConfigError naming an undeclared binding, and lists the declared ones', () => {
    // Fail-closed, the same refusal and reasoning as the merged `getObservationCommand`:
    // quietly substituting anything would be a hole in the AD-3 boundary.
    expect(() => substituteInputs('/x/{{nope}}', resolved)).toThrow(ConfigError);
    try {
      substituteInputs('/x/{{nope}}', resolved);
      expect.unreachable('an undeclared binding must not resolve');
    } catch (error) {
      expect((error as ConfigError).message).toContain('nope');
      expect((error as ConfigError).hint).toContain('accountId');
    }
  });

  it('does not rescan a substituted value — substitution is single-pass', () => {
    // A second pass is a template engine, and a template engine over provider-authored text is a
    // class of bug this story has no reason to introduce.
    const nested = resolvePlanData(
      planData([
        { kind: 'fixed', name: 'outer', value: '{{inner}}' },
        { kind: 'fixed', name: 'inner', value: 'SHOULD-NOT-APPEAR' },
      ]),
    );

    expect(substituteInputs('<{{outer}}>', nested)).toBe('<{{inner}}>');
  });
});

describe('resolveMechanics — the deep, structure-preserving walk', () => {
  const resolved = resolvePlanData(planData(BINDINGS));

  it('substitutes strings anywhere in an http probe mechanics object', () => {
    const mechanics = {
      serviceId: 'backend',
      method: 'POST',
      path: '/accounts/{{accountId}}/signup',
      headers: { 'Idempotency-Key': '{{idempotencyKey}}', Accept: 'application/json' },
      body: '{"email":"user-{{signupEmail}}@example.test"}',
    };

    expect(resolveMechanics(mechanics, resolved)).toStrictEqual({
      serviceId: 'backend',
      method: 'POST',
      path: '/accounts/acct-00042/signup',
      headers: { 'Idempotency-Key': GOLDEN.idempotencyKey, Accept: 'application/json' },
      body: `{"email":"user-${GOLDEN.signupEmail}@example.test"}`,
    });
  });

  it('substitutes argumentAllowlist as well as args, with the SAME resolved data', () => {
    // `intent.md` §3d, accepted by 4.6 in writing. Substituting only `args` would compare a
    // resolved token against the literal `{{signupEmail}}`, so EVERY binding-using shell probe
    // would reject — and for a volatile binding no string the plan author could have written
    // would ever match, because the token is derived. Both sides move together or the surface
    // is unusable.
    const mechanics = {
      commandId: 'seed-db',
      args: ['--email', '{{signupEmail}}'],
      argumentAllowlist: ['--email', '{{signupEmail}}', '--dry-run'],
    };

    const out = resolveMechanics(mechanics, resolved);

    expect(out.args).toStrictEqual(['--email', GOLDEN.signupEmail]);
    expect(out.argumentAllowlist).toStrictEqual(['--email', GOLDEN.signupEmail, '--dry-run']);
    // The property 4.6's runtime check depends on: every argument is still in the allowlist.
    for (const arg of out.args) {
      expect(out.argumentAllowlist).toContain(arg);
    }
  });

  it('preserves structure: arrays stay arrays, nesting stays nested', () => {
    const mechanics = {
      list: ['{{accountId}}', ['{{planTitle}}', { deep: '{{accountId}}' }],
      ],
      nested: { a: { b: { c: '{{accountId}}' } } },
    };

    expect(resolveMechanics(mechanics, resolved)).toStrictEqual({
      list: ['acct-00042', ['Quarterly report', { deep: 'acct-00042' }]],
      nested: { a: { b: { c: 'acct-00042' } } },
    });
  });

  it('leaves non-string leaves untouched', () => {
    const mechanics = { n: 42, t: true, z: null, u: undefined, s: '{{accountId}}' };

    expect(resolveMechanics(mechanics, resolved)).toStrictEqual({
      n: 42,
      t: true,
      z: null,
      u: undefined,
      s: 'acct-00042',
    });
  });

  it('does not mutate its input', () => {
    const mechanics = { path: '/x/{{accountId}}', headers: { A: '{{planTitle}}' } };
    const before = JSON.stringify(mechanics);

    resolveMechanics(mechanics, resolved);

    expect(JSON.stringify(mechanics)).toBe(before);
  });

  it('does not substitute object KEYS, only values', () => {
    // A key is a field name in a closed schema, not scenario data. Substituting one would let a
    // plan rename a mechanics field, which is a different and much larger power.
    const mechanics = { '{{accountId}}': 'value' };

    expect(resolveMechanics(mechanics, resolved)).toStrictEqual({ '{{accountId}}': 'value' });
  });

  it('throws ConfigError for an undeclared binding anywhere in the object', () => {
    expect(() => resolveMechanics({ headers: { A: '{{missing}}' } }, resolved)).toThrow(ConfigError);
  });

  it('returns an equal structure when nothing references a binding', () => {
    const mechanics = { serviceId: 'backend', method: 'GET', path: '/health' };

    expect(resolveMechanics(mechanics, resolved)).toStrictEqual(mechanics);
  });

  it('handles an empty resolved set by refusing any placeholder it meets', () => {
    const empty = resolvePlanData(planData([]));

    expect(resolveMechanics({ path: '/health' }, empty)).toStrictEqual({ path: '/health' });
    expect(() => resolveMechanics({ path: '/{{x}}' }, empty)).toThrow(ConfigError);
  });
});
