/**
 * AD-2 — the AI authority boundary, expressed as types.
 *
 * The product rule is that AI authors DRAFTS and nothing free-form ever becomes
 * state. Two properties in this file are what make that structural rather than
 * aspirational:
 *
 * 1. An adapter receives an `AgentPrompt`, which carries no schema. It cannot
 *    validate, cannot retry and cannot parse, because it is never handed the
 *    thing you would need to do any of those. `responseSchema` lives on
 *    `AgentRequest`, which only `src/providers/invoke.ts` — the ONE gate — ever
 *    sees.
 * 2. `AgentResponse` is a discriminated union, so `parsed` is not merely absent
 *    on failure, it is unreachable: reading it without narrowing is a compile
 *    error. AD-2 says "`parsed` exists only after the shared gate"; here that is
 *    a type property, checked by `pnpm typecheck`, not a promise in a comment.
 *
 * INTERFACES ONLY, and this module imports NOTHING — not zod, not a node
 * builtin, not another layer (AD-1, `domain-is-dependency-free`). That
 * constraint is stricter than it looks: dependency-cruiser runs with
 * `tsPreCompilationDeps: true`, so even `import type { z } from 'zod'` is a
 * violation. `ResponseValidator` below is the answer — a minimal structural
 * interface that every zod schema satisfies without anyone importing zod here.
 *
 * `src/domain/ports.ts` holds the determinism ports (`Clock`, `Ids`); the
 * provider port lives in its own file so that stories touching one need not
 * touch the other.
 *
 * Ownership: the envelope is fixed by AD-2 and is not a per-story decision.
 * Widening `AgentResponse` (e.g. a provider-metadata slot for AD-5 provenance)
 * is an additive field plus an ADR, not a quiet edit.
 */

import type { Clock } from './ports.js';
import type { ProcessRunner } from './process-runner.js';

/**
 * The AI roles a project may assign. Kebab-case, matching `ai.roles` in
 * `.specwitness/config.yaml`.
 *
 * Deliberately re-declared rather than imported from `src/config/`: domain may
 * not depend on an adapter. `tests/unit/providers/types.test.ts` asserts this
 * union and config's `AiRole` are bidirectionally assignable, so renaming a role
 * in either place stops compiling instead of silently diverging.
 */
export type AgentRole = 'contract-author' | 'plan-author' | 'explainer';

/** The success arm of a structural validation. */
export interface ValidationSuccess<T> {
  readonly success: true;
  readonly data: T;
}

/**
 * The failure arm. `error` is `unknown` on purpose: typing it as `ZodError`
 * would drag zod into the domain, and the gate is the only thing that inspects
 * it (to render validation messages back into the retry prompt).
 */
export interface ValidationFailure {
  readonly success: false;
  readonly error: unknown;
}

/**
 * A validator for provider output, structurally.
 *
 * Every zod schema satisfies this without a wrapper or a cast — `safeParse` is
 * exactly this shape — which is what lets callers pass `z.object({...})`
 * directly while `src/domain/**` stays dependency-free.
 *
 * Note what this is NOT: typing the field `unknown` and casting at the gate
 * would erase the one guarantee AD-2 asks for, namely that `T` on the response
 * is the type the caller's schema produces.
 */
export interface ResponseValidator<T> {
  safeParse(input: unknown): ValidationSuccess<T> | ValidationFailure;
}

/**
 * What an ADAPTER sees. Note the absence: no schema, of any kind.
 *
 * `jsonSchema` is an already-serialised JSON Schema VALUE (not a zod object),
 * for CLIs that can constrain their own output — `codex exec --output-schema`,
 * and claude 2.1.251's `--json-schema`. The GATE populates it, deriving it from
 * `responseSchema` when the caller did not supply one, so derivation happens in
 * exactly one place and two adapters cannot disagree about it. An adapter takes
 * this value as given and never derives its own.
 *
 * Steering a CLI with a schema is NOT validating against one: every response
 * still goes through the gate. A CLI-side constraint makes malformed output
 * rarer, never impossible (ADR-001).
 */
export interface AgentPrompt {
  readonly role: AgentRole;
  readonly prompt: string;
  /** Paths an adapter may reference; how they reach the CLI is the adapter's call. */
  readonly contextFiles?: readonly string[];
  readonly jsonSchema?: unknown;
}

/**
 * AD-2's request envelope: the prompt an adapter sees, plus the schema only the
 * gate sees. Extending `AgentPrompt` rather than duplicating its fields is what
 * lets the gate pass a request through as a prompt while the schema stays behind.
 */
export interface AgentRequest<T> extends AgentPrompt {
  readonly responseSchema: ResponseValidator<T>;
}

/** Why one attempt did not yield a validated draft — or that it did. */
export type AttemptOutcome =
  /** Parsed and schema-valid. Terminal, and the only outcome that produces `parsed`. */
  | 'accepted'
  /** The payload was not JSON at all. */
  | 'unparsable'
  /** Valid JSON of the wrong shape. A gate failure, not a parse crash. */
  | 'schema-rejected'
  /** The adapter threw, timed out, or otherwise failed to deliver text. */
  | 'provider-failed';

/**
 * One recorded attempt (FR-14: bounded, RECORDED retries).
 *
 * `raw` is the rejected payload and is DIAGNOSTIC TEXT ONLY. It must never be
 * parsed for partial data, never merged with a later attempt, and never
 * persisted anywhere a downstream reader could mistake it for content. The
 * point of storing it is that a human can see what the model actually said.
 *
 * Retries cost real subscription quota, so the count is recorded to make that
 * cost visible rather than invisible.
 */
export interface AgentAttempt {
  /** 1-based: the first call to the adapter is attempt 1. */
  readonly attempt: number;
  readonly raw: string;
  readonly outcome: AttemptOutcome;
  /**
   * Validation (or failure) messages, which the gate appends to the NEXT
   * attempt's prompt. Empty on an accepted attempt.
   */
  readonly errors: readonly string[];
  /** Integer milliseconds, from the injected `Clock` (AD-9). */
  readonly durationMs: number;
}

/** A validated draft. `parsed` is `T`, never `T | undefined`. */
export interface AgentSuccess<T> {
  readonly ok: true;
  readonly parsed: T;
  /** The raw text of the accepted attempt. */
  readonly raw: string;
  readonly attempts: readonly AgentAttempt[];
  readonly durationMs: number;
}

/**
 * Every attempt failed. Deliberately has NO `parsed` field — not an optional
 * one, none — so "never a partial artifact" is enforced by the compiler.
 */
export interface AgentFailure {
  readonly ok: false;
  /** The LAST rejected payload. Diagnostic only; see `AgentAttempt.raw`. */
  readonly raw: string;
  readonly attempts: readonly AgentAttempt[];
  readonly durationMs: number;
}

export type AgentResponse<T> = AgentSuccess<T> | AgentFailure;

/**
 * The port every provider adapter implements (Epic 2 story 2.4 claude, story 2.5
 * codex, and the shipped `fake`).
 *
 * `generate` returns RAW TEXT. That is the entire surface, and the narrowness is
 * the design: there is nothing else an adapter *could* do. Translating CLI
 * output — unwrapping a `--output-format json` envelope, stripping a markdown
 * fence — is adapter work and happens before the string is returned. Validation,
 * retrying and attempt recording happen after, in the gate, once, for everyone.
 */
export interface AgentProvider {
  /** The `ai.providers` key this instance was built from. */
  readonly id: string;
  /** The adapter kind (`claude-code-cli`, `codex-cli`, `fake`). */
  readonly adapter: string;
  generate(prompt: AgentPrompt): Promise<string>;
}

/**
 * A role assignment resolved to the provider it names.
 *
 * Structurally mirrors `ResolvedProvider` in `src/config/types.ts` —
 * deliberately, not coincidentally: `src/providers/**` may not import
 * `src/config/**` (`adapters-core-only`), so the caller resolves the role at the
 * edge and passes this value down with no shim. `adapter` is widened to `string`
 * rather than the config enum so that domain does not encode the adapter list;
 * the factory in `src/providers/index.ts` is what rejects an unknown one.
 *
 * Narrowing this type would break 2.6's edge wiring. Do not.
 */
export interface ProviderDescriptor {
  readonly name: string;
  readonly adapter: string;
  readonly mode: string;
}

/**
 * How an adapter reports something the operator must see — in practice FR-15's
 * billing warning, naming a variable withheld from a child process.
 *
 * A sink rather than stderr because AD-1 gives output to the edge, and rather
 * than a `warnings[]` on the response because the AD-2 envelope is fixed. It is
 * injected (`ProviderDeps.warn`) and NOT optional: `ProviderDeps` is built in
 * one place, and a billing warning that silently defaults to a no-op is exactly
 * the failure FR-15 exists to prevent.
 */
export type WarnSink = (message: string) => void;

/**
 * Everything an adapter is allowed to reach the outside world with.
 *
 * Declared here, in domain, rather than beside the factory, so that
 * `src/providers/fake.ts` and the factory in `src/providers/index.ts` can both
 * name it without importing each other (`no-circular`). `src/providers/index.ts`
 * re-exports it, which is the import path stories 2.4–2.7 were given.
 *
 * The list is deliberately short. An adapter spawns (through the port, never
 * `child_process` and never execa directly), reads the clock (through the port,
 * never `new Date()`), and warns. Anything else it thinks it needs is a
 * conversation, because the next item added here is the next thing every future
 * adapter can quietly do.
 */
export interface ProviderDeps {
  readonly processRunner: ProcessRunner;
  readonly clock: Clock;
  readonly warn: WarnSink;
}
