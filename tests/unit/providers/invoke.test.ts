import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ProviderError } from '../../../src/domain/errors.js';
import { attemptInvoke, invoke } from '../../../src/providers/invoke.js';
import { failThenSucceed, scriptedProvider, throwingProvider } from '../../fakes/agent-provider.js';
import { FixedClock } from '../../fakes/ports.js';

/**
 * FR-14 / AD-2 — the ONE schema gate and its bounded, recorded retries.
 *
 * Everything here runs through a fake provider: no subprocess is spawned in this
 * file, by construction (AD-12).
 */

const schema = z.object({ title: z.string(), count: z.number() });
const VALID = JSON.stringify({ title: 'ok', count: 1 });

/** A clock that advances 10ms per read, so durations are exact and additive. */
const steppingClock = (stepMs = 10, reads = 32) =>
  new FixedClock(
    ...Array.from({ length: reads }, (_, i) => new Date(Date.UTC(2026, 7, 31) + i * stepMs)),
  );

const request = (overrides: Partial<Parameters<typeof attemptInvoke<{ title: string; count: number }>>[0]> = {}) => ({
  role: 'contract-author' as const,
  prompt: 'Author the contract.',
  responseSchema: schema,
  ...overrides,
});

describe('the gate accepts a valid response', () => {
  it('returns the parsed draft on the first attempt', async () => {
    const provider = scriptedProvider(VALID);

    const result = await attemptInvoke(request(), { provider, clock: steppingClock() });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      expect.unreachable('scripted a valid response');
    }
    expect(result.parsed).toEqual({ title: 'ok', count: 1 });
    expect(result.raw).toBe(VALID);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({ attempt: 1, outcome: 'accepted', errors: [] });
  });

  it('calls the provider exactly once when the first response is good', async () => {
    const provider = scriptedProvider(VALID);

    await attemptInvoke(request(), { provider, clock: steppingClock() });

    expect(provider.prompts).toHaveLength(1);
    // No retry feedback appended to a first attempt.
    expect(provider.prompts[0]?.prompt).toBe('Author the contract.');
  });
});

describe('the gate retries, bounded, and records every attempt', () => {
  it('succeeds on retry 1 and records both attempts', async () => {
    const provider = failThenSucceed(1, VALID);

    const result = await attemptInvoke(request(), { provider, clock: steppingClock() });

    expect(result.ok).toBe(true);
    expect(result.attempts.map((a) => a.outcome)).toEqual(['unparsable', 'accepted']);
    expect(result.attempts.map((a) => a.attempt)).toEqual([1, 2]);
  });

  it('succeeds on retry 2 — the last attempt the default budget allows', async () => {
    const provider = failThenSucceed(2, VALID);

    const result = await attemptInvoke(request(), { provider, clock: steppingClock() });

    expect(result.ok).toBe(true);
    expect(result.attempts).toHaveLength(3);
    expect(result.attempts.at(-1)?.outcome).toBe('accepted');
  });

  it('stops at 3 attempts by default — 2 retries AFTER the first call', async () => {
    // The reading this codebase implements, stated in invoke.ts's header:
    // maxRetries counts retries, not total calls. 2 retries = 3 attempts.
    const provider = scriptedProvider('garbage');

    const result = await attemptInvoke(request(), { provider, clock: steppingClock() });

    expect(result.ok).toBe(false);
    expect(result.attempts).toHaveLength(3);
    expect(provider.prompts).toHaveLength(3);
  });

  it('keeps every rejected payload, in order', async () => {
    const provider = scriptedProvider('first bad', '{"title":1}', 'third bad');

    const result = await attemptInvoke(request(), { provider, clock: steppingClock() });

    expect(result.attempts.map((a) => a.raw)).toEqual(['first bad', '{"title":1}', 'third bad']);
    // The failure arm reports the LAST rejected payload.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.raw).toBe('third bad');
    }
  });

  it('feeds the validation errors of the previous attempt into the retry prompt', async () => {
    // The behaviour that makes a retry worth its quota: the model is told what
    // was wrong, not merely asked again.
    const provider = failThenSucceed(1, VALID);

    await attemptInvoke(request(), { provider, clock: steppingClock() });

    const retryPrompt = provider.prompts[1]?.prompt ?? '';
    expect(retryPrompt).toContain('Author the contract.');
    expect(retryPrompt.toLowerCase()).toContain('reject');
    expect(retryPrompt).toMatch(/JSON/i);
  });

  it('names the offending fields when the payload is valid JSON of the wrong shape', async () => {
    const provider = scriptedProvider('{"title": 5}', VALID);

    const result = await attemptInvoke(request(), { provider, clock: steppingClock() });

    const rejected = result.attempts[0];
    expect(rejected?.outcome).toBe('schema-rejected');
    expect(rejected?.errors.join('\n')).toContain('title');
    expect(rejected?.errors.join('\n')).toContain('count');
    // Those same messages must reach the model.
    expect(provider.prompts[1]?.prompt).toContain('title');
  });
});

describe('the gate distinguishes the ways a response can be wrong', () => {
  it('classifies non-JSON as unparsable, not as a schema rejection', async () => {
    const provider = scriptedProvider('I cannot help with that.');

    const result = await attemptInvoke(request(), { provider, clock: steppingClock() });

    expect(result.attempts[0]?.outcome).toBe('unparsable');
  });

  it('classifies valid JSON of the wrong shape as schema-rejected, never a crash', async () => {
    const provider = scriptedProvider('{"unexpected": true}');

    const result = await attemptInvoke(request(), { provider, clock: steppingClock() });

    expect(result.attempts[0]?.outcome).toBe('schema-rejected');
  });

  it('records an empty response as an attempt with an empty payload', async () => {
    const provider = scriptedProvider('');

    const result = await attemptInvoke(request(), { provider, clock: steppingClock() });

    expect(result.attempts[0]).toMatchObject({ outcome: 'unparsable', raw: '' });
    expect(result.attempts[0]?.errors.length).toBeGreaterThan(0);
  });

  it('records a whitespace-only response rather than treating it as absent', async () => {
    const provider = scriptedProvider('   \n  ');

    const result = await attemptInvoke(request(), { provider, clock: steppingClock() });

    expect(result.attempts[0]?.raw).toBe('   \n  ');
    expect(result.attempts[0]?.outcome).toBe('unparsable');
  });

  it('classifies a provider that THROWS, and retries it rather than swallowing it', async () => {
    const provider = throwingProvider(new Error('claude exited 1'));

    const result = await attemptInvoke(request(), { provider, clock: steppingClock() });

    expect(result.attempts).toHaveLength(3);
    expect(result.attempts.every((a) => a.outcome === 'provider-failed')).toBe(true);
    expect(result.attempts[0]?.errors.join(' ')).toContain('claude exited 1');
    expect(result.attempts[0]?.raw).toBe('');
  });

  it('recovers when a provider throws once and then answers', async () => {
    let called = 0;
    const provider = {
      id: 'flaky',
      adapter: 'fake',
      generate: async () => {
        called += 1;
        if (called === 1) {
          throw new Error('transient');
        }
        return VALID;
      },
    };

    const result = await attemptInvoke(request(), { provider, clock: steppingClock() });

    expect(result.ok).toBe(true);
    expect(result.attempts.map((a) => a.outcome)).toEqual(['provider-failed', 'accepted']);
  });
});

describe('the retry budget is configurable and cannot loop forever', () => {
  it('makes exactly one attempt when maxRetries is 0', async () => {
    const provider = scriptedProvider('garbage');

    const result = await attemptInvoke(request(), {
      provider,
      clock: steppingClock(),
      options: { maxRetries: 0 },
    });

    expect(result.attempts).toHaveLength(1);
    expect(provider.prompts).toHaveLength(1);
  });

  it('clamps a negative retry count to 0 rather than looping or throwing', async () => {
    const provider = scriptedProvider('garbage');

    const result = await attemptInvoke(request(), {
      provider,
      clock: steppingClock(),
      options: { maxRetries: -5 },
    });

    expect(result.attempts).toHaveLength(1);
  });

  it('clamps a non-integer retry count downwards', async () => {
    const provider = scriptedProvider('garbage');

    const result = await attemptInvoke(request(), {
      provider,
      clock: steppingClock(),
      options: { maxRetries: 1.9 },
    });

    expect(result.attempts).toHaveLength(2);
  });

  it('clamps an absurd retry count to the documented ceiling', async () => {
    // Retries cost real subscription quota. A config typo must not be able to
    // spend an unbounded amount of it.
    const provider = scriptedProvider('garbage');

    const result = await attemptInvoke(request(), {
      provider,
      clock: steppingClock(10, 64),
      options: { maxRetries: 1_000 },
    });

    expect(result.attempts.length).toBeLessThanOrEqual(6);
  });

  it('treats NaN as 0 rather than as an unbounded loop', async () => {
    const provider = scriptedProvider('garbage');

    const result = await attemptInvoke(request(), {
      provider,
      clock: steppingClock(),
      options: { maxRetries: Number.NaN },
    });

    expect(result.attempts).toHaveLength(1);
  });
});

describe('durations come from the injected Clock (AD-9)', () => {
  it('reports integer millisecond durations per attempt and overall', async () => {
    const provider = failThenSucceed(1, VALID);

    // Reads: overall start, then one per attempt. 10ms apart.
    const result = await attemptInvoke(request(), { provider, clock: steppingClock(10) });

    expect(result.attempts.map((a) => a.durationMs)).toEqual([10, 10]);
    expect(result.durationMs).toBe(20);
    expect(Number.isInteger(result.durationMs)).toBe(true);
  });
});

describe('the gate derives the JSON Schema exactly once, on the adapter’s behalf', () => {
  it('passes a caller-supplied jsonSchema through untouched', async () => {
    const provider = scriptedProvider(VALID);
    const supplied = { type: 'object', 'x-marker': 'callers-own' };

    await attemptInvoke(request({ jsonSchema: supplied }), { provider, clock: steppingClock() });

    expect(provider.prompts[0]?.jsonSchema).toBe(supplied);
  });

  it('derives one from the zod schema when the caller supplied none', async () => {
    // So story 2.5's `codex exec --output-schema` is unconditional, without the
    // adapter ever touching `responseSchema` — two derivation sites could
    // disagree, which is the AD-2 failure of validating twice.
    const provider = scriptedProvider(VALID);

    await attemptInvoke(request(), { provider, clock: steppingClock() });

    const derived = provider.prompts[0]?.jsonSchema as Record<string, unknown> | undefined;
    expect(derived).toBeDefined();
    expect(derived?.type).toBe('object');
    expect(Object.keys((derived?.properties ?? {}) as object)).toEqual(['title', 'count']);
  });

  it('degrades to undefined rather than crashing on a non-zod validator', async () => {
    const provider = scriptedProvider(VALID);
    const structural = {
      safeParse: (input: unknown) => ({ success: true as const, data: input as { title: string; count: number } }),
    };

    const result = await attemptInvoke(
      { role: 'explainer', prompt: 'x', responseSchema: structural },
      { provider, clock: steppingClock() },
    );

    expect(result.ok).toBe(true);
    expect(provider.prompts[0]?.jsonSchema).toBeUndefined();
  });

  it('hands the adapter the prompt half only — never the schema', async () => {
    const provider = scriptedProvider(VALID);

    await attemptInvoke(request(), { provider, clock: steppingClock() });

    // AD-2, at runtime as well as in the types: an adapter is not given the
    // means to validate.
    expect(provider.prompts[0]).not.toHaveProperty('responseSchema');
  });

  it('forwards contextFiles and the role to the adapter', async () => {
    const provider = scriptedProvider(VALID);

    await attemptInvoke(request({ contextFiles: ['docs/epics.md'] }), {
      provider,
      clock: steppingClock(),
    });

    expect(provider.prompts[0]).toMatchObject({
      role: 'contract-author',
      contextFiles: ['docs/epics.md'],
    });
  });
});

describe('invoke(): exhaustion raises ProviderError and never a partial artifact', () => {
  it('throws ProviderError carrying the attempt count', async () => {
    const provider = scriptedProvider('garbage');

    const thrown = await invoke(request(), { provider, clock: steppingClock() }).catch(
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(ProviderError);
    const error = thrown as ProviderError;
    expect(error.message).toContain('3');
    expect(error.hint).toBeDefined();
  });

  it('names the provider so an operator knows which one misbehaved', async () => {
    const provider = scriptedProvider('garbage');

    const thrown = (await invoke(request(), { provider, clock: steppingClock() }).catch(
      (e: unknown) => e,
    )) as ProviderError;

    expect(thrown.message).toContain('scripted');
  });

  it('returns the parsed draft directly on success, with no narrowing needed', async () => {
    const provider = scriptedProvider(VALID);

    const success = await invoke(request(), { provider, clock: steppingClock() });

    // `parsed` is `T` on this type, not `T | undefined` — the assignment is the
    // assertion.
    const parsed: { title: string; count: number } = success.parsed;
    expect(parsed.title).toBe('ok');
    expect(success.ok).toBe(true);
  });

  it('does not swallow a provider that throws — it still surfaces as ProviderError', async () => {
    const provider = throwingProvider(new Error('spawn failed'));

    const thrown = await invoke(request(), { provider, clock: steppingClock() }).catch(
      (e: unknown) => e,
    );

    expect(thrown).toBeInstanceOf(ProviderError);
  });
});
