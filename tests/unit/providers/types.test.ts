import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type {
  AgentAttempt,
  AgentPrompt,
  AgentProvider,
  AgentRequest,
  AgentResponse,
  AgentRole,
  ProviderDescriptor,
  ResponseValidator,
} from '../../../src/domain/agent-provider.js';
import type { AiRole, ResolvedProvider } from '../../../src/config/index.js';

/**
 * AD-2 as a TYPE property, not a convention.
 *
 * "`parsed` exists only after the shared gate validated it" is worth nothing if
 * a caller can read it off a failed response and get `undefined` at runtime. The
 * assertions below are compile-time: `pnpm typecheck` is what runs them, and a
 * `@ts-expect-error` that stops erroring fails the build just as loudly as a
 * wrong `expect()`.
 */

/** Compile-time assertion that `A` and `B` are mutually assignable. */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const assertType = <T extends true>(): T => true as T;

describe('AD-2: the response envelope makes `parsed` unreachable on failure', () => {
  it('exposes `parsed` only after narrowing to the ok arm', () => {
    const response = {
      ok: true,
      parsed: { criteria: 1 },
      raw: '{"criteria":1}',
      attempts: [],
      durationMs: 0,
    } as AgentResponse<{ criteria: number }>;

    // @ts-expect-error AD-2: `parsed` is not on the union — it must be narrowed first.
    void response.parsed;

    if (response.ok) {
      // Narrowed: `parsed` is `T`, not `T | undefined`. The assignment is the
      // assertion — an optional field would not compile here.
      const parsed: { criteria: number } = response.parsed;
      expect(parsed.criteria).toBe(1);
    } else {
      expect.unreachable('constructed as the ok arm');
    }
  });

  it('does not carry `parsed` on the failure arm at all', () => {
    const failure = {
      ok: false,
      raw: 'not json',
      attempts: [],
      durationMs: 0,
    } as AgentResponse<{ criteria: number }>;

    if (!failure.ok) {
      // @ts-expect-error AD-2: the failure arm has no `parsed`, by construction.
      void failure.parsed;
      expect(failure.raw).toBe('not json');
    }
  });

  it('records an outcome and a rejected payload on every attempt', () => {
    const attempt: AgentAttempt = {
      attempt: 1,
      raw: '{"wrong":true}',
      outcome: 'schema-rejected',
      errors: ['criteria: expected number'],
      durationMs: 12,
    };

    expect(attempt.outcome).toBe('schema-rejected');
    expect(Number.isInteger(attempt.durationMs)).toBe(true);
  });
});

describe('AD-1: the port stays usable without domain importing zod', () => {
  it('accepts a zod schema as a ResponseValidator and infers the parsed type', () => {
    const schema = z.object({ title: z.string() });

    // The whole point of the structural `ResponseValidator<T>`: a real zod
    // schema satisfies it with no wrapper and no cast, while `src/domain/**`
    // imports nothing at all.
    const validator: ResponseValidator<{ title: string }> = schema;

    const ok = validator.safeParse({ title: 'x' });
    expect(ok.success).toBe(true);
    if (ok.success) {
      const title: string = ok.data.title;
      expect(title).toBe('x');
    }

    expect(validator.safeParse({ title: 1 }).success).toBe(false);
  });

  it('builds a request from a prompt plus a schema', () => {
    const schema = z.object({ title: z.string() });
    const request: AgentRequest<{ title: string }> = {
      role: 'contract-author',
      prompt: 'write it',
      responseSchema: schema,
    };

    // An `AgentRequest` IS an `AgentPrompt` — that is what lets the gate hand
    // the adapter the prompt half while keeping the schema to itself.
    const prompt: AgentPrompt = request;
    expect(prompt.role).toBe('contract-author');

    // @ts-expect-error An adapter receives `AgentPrompt`, which has no schema.
    void prompt.responseSchema;
  });

  it('gives an adapter no way to return anything but raw text', () => {
    const provider: AgentProvider = {
      id: 'p',
      adapter: 'fake',
      generate: async () => 'raw',
    };

    // `generate` is typed `Promise<string>`: an adapter cannot return a parsed
    // object even if it wanted to, which is AD-2's "adapters only translate".
    const returned: Promise<string> = provider.generate({ role: 'explainer', prompt: '' });
    expect(returned).toBeInstanceOf(Promise);
  });
});

describe('the domain role union does not drift from the config one', () => {
  it('is bidirectionally assignable with config AiRole', () => {
    // `src/domain/**` may not import `src/config/**` (nor zod), so `AgentRole`
    // is re-declared there. This test is the only thing keeping the two equal:
    // rename a role in either place and it stops compiling.
    expect(assertType<MutuallyAssignable<AgentRole, AiRole>>()).toBe(true);
  });

  it('accepts each kebab-case role key', () => {
    const roles: AgentRole[] = ['contract-author', 'plan-author', 'explainer'];
    expect(roles).toHaveLength(3);
  });

  it('accepts a config ResolvedProvider as a ProviderDescriptor', () => {
    // The structural mirror chuck (2.6) relies on: `resolveRoleProvider`'s
    // return value is passed straight into `providerForRole` with no shim.
    const resolved: ResolvedProvider = { name: 'primary', adapter: 'fake', mode: 'fixtures' };
    const descriptor: ProviderDescriptor = resolved;
    expect(descriptor.adapter).toBe('fake');
  });
});
