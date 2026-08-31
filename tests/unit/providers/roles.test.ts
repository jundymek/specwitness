import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ProviderError } from '../../../src/domain/errors.js';
import type { ProviderDescriptor } from '../../../src/domain/agent-provider.js';
import { configSchema } from '../../../src/config/schema.js';
import { resolveRoleProvider } from '../../../src/config/types.js';
import { createProvider, providerForRole } from '../../../src/providers/index.js';
import { attemptInvoke, invoke } from '../../../src/providers/invoke.js';
import { forbiddenProcessRunner } from '../../fakes/agent-provider.js';
import { FixedClock } from '../../fakes/ports.js';

/**
 * FR-11 — roles, any-provider-any-role, graceful degradation — and AC3's
 * "zero real subprocesses" guard.
 *
 * Role RESOLUTION itself is `resolveRoleProvider` in `src/config/types.ts`
 * (merged, story 1.3) and is not re-implemented here; these tests drive it
 * through the provider factory, which is the seam this story owns.
 */

const deps = () => ({
  processRunner: forbiddenProcessRunner(),
  clock: new FixedClock('2026-08-31T00:00:00.000Z'),
  warn: vi.fn(),
});

const config = (ai: unknown) =>
  configSchema.parse({ version: 1, project: { baseBranch: 'master' }, ai });

describe('FR-11: any role may map to any configured provider', () => {
  it('resolves each of the three roles to the provider it names', () => {
    const parsed = config({
      providers: {
        drafter: { adapter: 'fake', mode: 'tests/fixtures/providers/contract' },
        reviewer: { adapter: 'fake', mode: 'tests/fixtures/providers/retry' },
      },
      roles: { 'contract-author': 'drafter', 'plan-author': 'reviewer', explainer: 'drafter' },
    });

    expect(resolveRoleProvider(parsed, 'contract-author')?.name).toBe('drafter');
    expect(resolveRoleProvider(parsed, 'plan-author')?.name).toBe('reviewer');
    expect(resolveRoleProvider(parsed, 'explainer')?.name).toBe('drafter');
  });

  it('lets one provider serve all three roles', () => {
    const parsed = config({
      providers: { only: { adapter: 'fake', mode: 'tests/fixtures/providers/contract' } },
      roles: { 'contract-author': 'only', 'plan-author': 'only', explainer: 'only' },
    });

    const providers = (['contract-author', 'plan-author', 'explainer'] as const).map((role) =>
      providerForRole(resolveRoleProvider(parsed, role), deps()),
    );

    expect(providers.every((p) => p?.id === 'only')).toBe(true);
  });
});

describe('FR-11: an unassigned optional role degrades gracefully', () => {
  it('returns undefined for an unassigned explainer, and throws nothing', () => {
    const parsed = config({
      providers: { drafter: { adapter: 'fake', mode: 'tests/fixtures/providers/contract' } },
      roles: { 'contract-author': 'drafter' },
    });

    // The absence is DATA. UJ-4's edge case: a missing explainer must never
    // break contract generation, so this layer surfaces it and the caller
    // decides — it does not throw and does not substitute a default provider.
    expect(providerForRole(resolveRoleProvider(parsed, 'explainer'), deps())).toBeUndefined();
    expect(providerForRole(resolveRoleProvider(parsed, 'contract-author'), deps())?.id).toBe('drafter');
  });

  it('returns undefined for every role when there is no ai block at all', () => {
    const parsed = config(undefined);

    for (const role of ['contract-author', 'plan-author', 'explainer'] as const) {
      expect(providerForRole(resolveRoleProvider(parsed, role), deps())).toBeUndefined();
    }
  });

  it('never substitutes a default provider for a missing assignment', () => {
    const parsed = config({
      providers: { drafter: { adapter: 'fake', mode: 'tests/fixtures/providers/contract' } },
    });

    // A single configured provider is NOT quietly promoted to fill unassigned
    // roles: silently using a provider the project did not assign is exactly
    // the kind of helpfulness that makes a verification tool untrustworthy.
    expect(providerForRole(resolveRoleProvider(parsed, 'contract-author'), deps())).toBeUndefined();
  });
});

describe('createProvider: the adapter registry', () => {
  it('builds the shipped fake adapter', () => {
    const provider = createProvider(
      { name: 'hermetic', adapter: 'fake', mode: 'tests/fixtures/providers/contract' },
      deps(),
    );

    expect(provider).toMatchObject({ id: 'hermetic', adapter: 'fake' });
  });

  it('rejects an unknown adapter with a ProviderError naming it', () => {
    const descriptor: ProviderDescriptor = { name: 'x', adapter: 'gpt-cli', mode: 'api' };

    expect(() => createProvider(descriptor, deps())).toThrow(ProviderError);
    expect(() => createProvider(descriptor, deps())).toThrow(/gpt-cli/);
  });

  it('builds the claude adapter now that story 2.4 has landed', () => {
    const provider = createProvider(
      { name: 'claude', adapter: 'claude-code-cli', mode: 'subscription' },
      deps(),
    );

    // Construction alone spawns nothing: `deps()` supplies the forbidden runner,
    // so probing at build time would fail this test rather than pass it.
    expect(provider).toMatchObject({ id: 'claude', adapter: 'claude-code-cli' });
  });

  it('rejects an adapter that is declared but not yet implemented, clearly', () => {
    // `codex-cli` is a valid config value (the enum has carried it since story
    // 1.3) but has no implementation until story 2.5 lands. Failing loudly beats
    // a stub that pretends to work.
    //
    // Story 2.5: when your adapter lands, this test has no subject left — every
    // declared adapter will be implemented — so DELETE it rather than hunting
    // for another victim. The unknown-adapter test above already covers the
    // `default:` branch durably, and permanently.
    expect(() =>
      createProvider({ name: 'c', adapter: 'codex-cli', mode: 'chatgpt' }, deps()),
    ).toThrow(ProviderError);
  });
});

describe('AD-12 / AC3: the domain and application suites spawn nothing', () => {
  it('completes a full invoke through the fake without touching the ProcessRunner', async () => {
    // The guard is the injected runner: `forbiddenProcessRunner()` throws on any
    // call, so a stray spawn cannot pass silently. A convention would not catch
    // an adapter that grew a subprocess later; this does.
    const runner = forbiddenProcessRunner();
    const spy = vi.spyOn(runner, 'run');

    const provider = createProvider(
      { name: 'hermetic', adapter: 'fake', mode: 'tests/fixtures/providers/contract' },
      { processRunner: runner, clock: new FixedClock('2026-08-31T00:00:00.000Z'), warn: vi.fn() },
    );

    const result = await invoke(
      {
        role: 'contract-author',
        prompt: 'draft it',
        responseSchema: z.object({ title: z.string(), count: z.number() }),
      },
      { provider, clock: new FixedClock('2026-08-31T00:00:00.000Z') },
    );

    expect(result.parsed.title).toBe('Epic 2 verification contract');
    expect(spy).not.toHaveBeenCalled();
  });

  it('drives the malformed-then-valid retry path end to end with no subprocess', async () => {
    const runner = forbiddenProcessRunner();
    const spy = vi.spyOn(runner, 'run');

    const provider = createProvider(
      { name: 'hermetic', adapter: 'fake', mode: 'tests/fixtures/providers/retry' },
      { processRunner: runner, clock: new FixedClock('2026-08-31T00:00:00.000Z'), warn: vi.fn() },
    );

    const response = await attemptInvoke(
      {
        role: 'contract-author',
        prompt: 'draft it',
        responseSchema: z.object({ title: z.string(), count: z.number() }),
      },
      {
        provider,
        clock: new FixedClock(
          ...Array.from({ length: 8 }, (_, i) => new Date(Date.UTC(2026, 7, 31) + i * 5)),
        ),
      },
    );

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.parsed.title).toBe('recovered on the third attempt');
    }
    // Unparsable prose, then valid JSON of the wrong shape, then the good one:
    // the whole AC2 matrix, exercised through the shipped adapter.
    expect(response.attempts.map((a) => a.outcome)).toEqual([
      'unparsable',
      'schema-rejected',
      'accepted',
    ]);
    expect(spy).not.toHaveBeenCalled();
  });
});
