import { describe, expect, it, vi } from 'vitest';

import { ProviderError } from '../../../src/domain/errors.js';
import { createFakeProvider } from '../../../src/providers/fake.js';
import { forbiddenProcessRunner } from '../../fakes/agent-provider.js';
import { FixedClock } from '../../fakes/ports.js';

/**
 * The SHIPPED `fake` adapter (`adapter: fake` in Project Config).
 *
 * Not a test double: Epic 6's hermetic corpus end-to-end drives the real
 * `specwitness` binary with no agent CLI installed, and stories 2.6 and 2.7 both
 * configure it in their integration tests. Its unit tests live here.
 */

const deps = () => ({
  processRunner: forbiddenProcessRunner(),
  clock: new FixedClock('2026-08-31T00:00:00.000Z'),
  warn: vi.fn(),
});

const fake = (mode: string) => createFakeProvider({ name: 'hermetic', adapter: 'fake', mode }, deps());

describe('the fake adapter replays canned responses by role', () => {
  it('returns the fixture for the requested role', async () => {
    const provider = fake('tests/fixtures/providers/contract');

    const raw = await provider.generate({ role: 'contract-author', prompt: 'x' });

    expect(JSON.parse(raw)).toEqual({ title: 'Epic 2 verification contract', count: 3 });
  });

  it('keys fixtures by role, so two roles get two different responses', async () => {
    const provider = fake('tests/fixtures/providers/contract');

    const drafted = await provider.generate({ role: 'contract-author', prompt: 'x' });
    const explained = await provider.generate({ role: 'explainer', prompt: 'x' });

    expect(drafted).not.toBe(explained);
    expect(JSON.parse(explained)).toMatchObject({ title: 'why it failed' });
  });

  it('walks the scripted sequence, one entry per call', async () => {
    const provider = fake('tests/fixtures/providers/retry');

    const first = await provider.generate({ role: 'contract-author', prompt: 'x' });
    const second = await provider.generate({ role: 'contract-author', prompt: 'x' });
    const third = await provider.generate({ role: 'contract-author', prompt: 'x' });

    expect(first).toContain("I'll help you");
    expect(second).toBe('{"title":5}');
    expect(JSON.parse(third)).toMatchObject({ title: 'recovered on the third attempt' });
  });

  it('repeats the last entry once the script is exhausted', async () => {
    // So a one-entry fixture is a constant provider, and a test that asks once
    // more than it scripted gets a defined answer rather than a crash.
    const provider = fake('tests/fixtures/providers/retry');

    for (let i = 0; i < 3; i += 1) {
      await provider.generate({ role: 'contract-author', prompt: 'x' });
    }
    const extra = await provider.generate({ role: 'contract-author', prompt: 'x' });

    expect(JSON.parse(extra)).toMatchObject({ title: 'recovered on the third attempt' });
  });

  it('advances each role independently', async () => {
    const provider = fake('tests/fixtures/providers/contract');

    await provider.generate({ role: 'contract-author', prompt: 'x' });
    const explained = await provider.generate({ role: 'explainer', prompt: 'x' });

    // The explainer is on ITS first entry, not the second entry of a shared
    // counter — otherwise one role's retries would silently consume another's
    // script.
    expect(JSON.parse(explained)).toMatchObject({ title: 'why it failed' });
  });

  it('is deterministic: two instances over one fixture agree', async () => {
    const a = await fake('tests/fixtures/providers/contract').generate({
      role: 'contract-author',
      prompt: 'x',
    });
    const b = await fake('tests/fixtures/providers/contract').generate({
      role: 'contract-author',
      prompt: 'x',
    });

    expect(a).toBe(b);
  });
});

describe('the fake adapter fails clearly rather than mysteriously', () => {
  it('raises ProviderError naming the path when the fixture directory is absent', async () => {
    const provider = fake('tests/fixtures/providers/does-not-exist');

    const thrown = await provider
      .generate({ role: 'contract-author', prompt: 'x' })
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ProviderError);
    expect((thrown as ProviderError).message).toContain('does-not-exist');
    expect((thrown as ProviderError).hint).toBeDefined();
  });

  it('raises ProviderError naming the role when that role has no fixture', async () => {
    const provider = fake('tests/fixtures/providers/contract');

    const thrown = await provider.generate({ role: 'plan-author', prompt: 'x' }).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ProviderError);
    expect((thrown as ProviderError).message).toContain('plan-author');
  });

  it('raises ProviderError when the fixture is not an array of strings', async () => {
    // A hand-written fixture is easy to get subtly wrong; an ENOENT-shaped
    // TypeError three frames away is not a useful way to find out.
    const provider = fake('tests/fixtures/providers/malformed');

    const thrown = await provider
      .generate({ role: 'contract-author', prompt: 'x' })
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ProviderError);
    expect((thrown as ProviderError).message).toMatch(/array of strings/i);
  });
});

describe('the fake adapter honours the port contract', () => {
  it('reports its config key and adapter kind', () => {
    const provider = fake('tests/fixtures/providers/contract');

    expect(provider.id).toBe('hermetic');
    expect(provider.adapter).toBe('fake');
  });

  it('returns raw text and never parses or validates it', async () => {
    const provider = fake('tests/fixtures/providers/retry');

    const raw = await provider.generate({ role: 'contract-author', prompt: 'x' });

    // The first scripted entry is deliberately not JSON. An adapter that
    // validated would have rejected it; the port says raw text out, so it
    // arrives verbatim and the GATE is what rejects it.
    expect(typeof raw).toBe('string');
    expect(() => JSON.parse(raw)).toThrow();
  });
});
