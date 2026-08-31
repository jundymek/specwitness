import { describe, expect, it } from 'vitest';

import type { DoctorContext } from '../../../src/cli/doctor/context.js';
import { createRegistry, type DoctorCheck } from '../../../src/cli/doctor/registry.js';

/**
 * The registry is the seam story 2.7 plugs provider checks into, so its contract
 * is tested as a contract: order, isolation, and extension without a single
 * existing check changing.
 */

const ctx = {} as DoctorContext;

function fakeCheck(id: string, overrides: Partial<DoctorCheck> = {}): DoctorCheck {
  return {
    id,
    required: true,
    run: async () => ({ status: 'pass', detail: `${id} ok` }),
    ...overrides,
  };
}

describe('createRegistry', () => {
  it('reports results in registration order, not completion order', async () => {
    const registry = createRegistry();
    // The slow check registers first: were results collected in completion
    // order, 'fast' would overtake it and the JSON snapshot would be unstable.
    registry.register(
      fakeCheck('slow', {
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { status: 'pass', detail: 'slow ok' };
        },
      }),
    );
    registry.register(fakeCheck('fast'));

    const results = await registry.runAll(ctx);

    expect(results.map((result) => result.id)).toEqual(['slow', 'fast']);
  });

  it('isolates a throwing check: it fails, every other check still runs', async () => {
    const registry = createRegistry([
      fakeCheck('before'),
      fakeCheck('boom', {
        run: async () => {
          throw new Error('check exploded');
        },
      }),
      fakeCheck('after'),
    ]);

    const results = await registry.runAll(ctx);

    expect(results.map((result) => [result.id, result.status])).toEqual([
      ['before', 'pass'],
      ['boom', 'fail'],
      ['after', 'pass'],
    ]);
    expect(results[1]?.detail).toContain('check exploded');
  });

  it('survives a check that throws a non-Error value', async () => {
    const registry = createRegistry([
      fakeCheck('rude', {
        run: async () => {
          throw 'not an error object';
        },
      }),
    ]);

    const [result] = await registry.runAll(ctx);

    expect(result?.status).toBe('fail');
    expect(result?.detail).toContain('not an error object');
  });

  it('carries `required` through to the result so the exit rule can read it', async () => {
    const registry = createRegistry([
      fakeCheck('needed', { required: true }),
      fakeCheck('optional', { required: false }),
    ]);

    const results = await registry.runAll(ctx);

    expect(results.map((result) => result.required)).toEqual([true, false]);
  });

  it('rejects a duplicate check id rather than shadowing one silently', () => {
    const registry = createRegistry([fakeCheck('node-version')]);

    expect(() => registry.register(fakeCheck('node-version'))).toThrow(/node-version/);
  });

  it('is the AC3 extension seam: a new check plugs in with no existing check changed', async () => {
    // Story 2.7's rehearsal: register a check the built-ins know nothing about
    // and assert it runs and reports exactly like any other.
    const registry = createRegistry([fakeCheck('builtin')]);
    const providerCheck: DoctorCheck = {
      id: 'claude-cli-present',
      required: false,
      run: async () => ({ status: 'warn', detail: 'claude CLI not found on PATH' }),
    };

    registry.register(providerCheck);
    const results = await registry.runAll(ctx);

    expect(results).toEqual([
      { id: 'builtin', required: true, status: 'pass', detail: 'builtin ok' },
      {
        id: 'claude-cli-present',
        required: false,
        status: 'warn',
        detail: 'claude CLI not found on PATH',
      },
    ]);
  });
});
