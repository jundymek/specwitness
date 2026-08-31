/**
 * AD-2 — THE schema gate and retry loop. Implemented exactly once, here.
 *
 * AD-2 names this file by path for a reason: if validation lived in each
 * adapter, every future adapter would re-invent it with a slightly different
 * failure mode, and "no free-form model output ever becomes state" would be a
 * property nobody could check. So adapters return raw text and this file does
 * everything else — parse, validate, feed the errors back, count the attempts,
 * classify the failure.
 *
 * THE RETRY BUDGET, stated unambiguously because both readings exist in the
 * wild: `maxRetries` counts retries AFTER the first call. The default of 2
 * therefore means **at most 3 attempts in total** (1 initial + 2 retries).
 * `maxRetries: 0` means exactly one attempt.
 *
 * Retries cost real subscription quota, so they are bounded, never nested (an
 * adapter must not also retry internally), and every attempt is recorded so the
 * cost is visible rather than invisible.
 *
 * WHAT IS RECORDED, and what it is NOT for: each attempt keeps its rejected
 * payload. That text is DIAGNOSTIC ONLY — never parsed for partial data, never
 * merged with a later attempt, never persisted where a reader could mistake it
 * for content. "Never a partial artifact" (FR-14) is enforced by the type
 * system: `parsed` exists only on the `ok: true` arm of `AgentResponse`.
 *
 * AD-1: this is an adapter module. It may import `src/domain/**`, `src/schemas/**`
 * and npm packages — including zod, which the domain may not. It may NOT import
 * `src/config/**`, the application layer or the edge; the caller resolves config
 * and passes values down.
 *
 * AD-9: the `Clock` is injected. No `new Date()` on this path, so attempt
 * timings are exact in tests rather than merely positive.
 */

import { z } from 'zod';

import type {
  AgentAttempt,
  AgentPrompt,
  AgentProvider,
  AgentRequest,
  AgentResponse,
  AgentSuccess,
  AttemptOutcome,
  ResponseValidator,
} from '../domain/agent-provider.js';
import { ProviderError } from '../domain/errors.js';
import type { Clock } from '../domain/ports.js';

/** Retries after the first attempt, when the caller says nothing. */
const DEFAULT_MAX_RETRIES = 2;

/**
 * Upper bound on retries, whatever a caller or a config file asks for.
 *
 * Each retry is a fresh agent session billed against a real subscription. A
 * typo'd `maxRetries: 1000` must not be able to spend an afternoon's quota, and
 * clamping is friendlier than rejecting a config over a number that has an
 * obviously sane interpretation.
 */
const MAX_RETRIES_CEILING = 5;

export interface InvokeOptions {
  /**
   * Retries AFTER the first attempt. Default 2 ⇒ at most 3 attempts total.
   * Clamped to `[0, 5]`; a negative, fractional or NaN value is floored into
   * range rather than looping forever or throwing.
   */
  readonly maxRetries?: number;
}

export interface InvokeDeps {
  readonly provider: AgentProvider;
  readonly clock: Clock;
  readonly options?: InvokeOptions;
}

function clampRetries(requested: number | undefined): number {
  if (requested === undefined) {
    return DEFAULT_MAX_RETRIES;
  }
  // `Number.isFinite` rejects NaN and both infinities in one check; `Math.floor`
  // then makes 1.9 mean one retry rather than an unrepresentable one-and-a-bit.
  if (!Number.isFinite(requested)) {
    return 0;
  }
  return Math.min(Math.max(Math.floor(requested), 0), MAX_RETRIES_CEILING);
}

/**
 * Render a validation failure as messages a model can act on.
 *
 * `ResponseValidator` is structural, so `error` really is `unknown` — a zod
 * `ZodError` in practice, but a hand-written validator in a unit test may hand
 * back anything. Both are handled; neither is allowed to throw out of here,
 * because a formatting crash while reporting a failure would replace a
 * diagnosable rejection with an unclassified stack trace.
 */
function describeValidationError(error: unknown): string[] {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => {
      const path = issue.path.join('.');
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    });
  }
  if (error instanceof Error) {
    return [error.message];
  }
  try {
    return [JSON.stringify(error) ?? String(error)];
  } catch {
    return ['the response did not satisfy the required schema'];
  }
}

/**
 * Build the prompt for a retry: the original ask, plus what was wrong last time.
 *
 * Only the PREVIOUS attempt's errors are appended, not the whole history — a
 * growing transcript costs quota on every round and buries the actionable part.
 */
function withRejectionFeedback(
  original: string,
  previous: AgentAttempt,
  attemptNumber: number,
  totalAttempts: number,
): string {
  const errors = previous.errors.map((message) => `  - ${message}`).join('\n');

  return [
    original,
    '',
    `--- PREVIOUS RESPONSE REJECTED (this is attempt ${attemptNumber} of ${totalAttempts}) ---`,
    'Your previous response did not satisfy the required schema:',
    errors,
    '',
    'Respond again with ONLY a JSON document satisfying the schema.',
    'Do not wrap it in prose, explanation or a markdown code fence.',
  ].join('\n');
}

/**
 * Derive a JSON Schema for CLIs that can constrain their own output
 * (`codex exec --output-schema`, claude's `--json-schema`).
 *
 * It happens HERE, once, rather than in each adapter: two derivation sites can
 * disagree, which is the same failure AD-2 prevents by keeping validation in one
 * place. Adapters take `AgentPrompt.jsonSchema` as given and never derive.
 *
 * Returns `undefined` rather than throwing when the validator is not a zod
 * schema, or when zod cannot represent it — `z.toJSONSchema` defaults to
 * throwing on an unrepresentable construct. Steering is an optimisation; losing
 * it must never fail an invocation, because the gate validates the response
 * either way.
 */
function deriveJsonSchema(responseSchema: ResponseValidator<unknown>): unknown {
  if (!(responseSchema instanceof z.ZodType)) {
    return undefined;
  }
  try {
    return z.toJSONSchema(responseSchema);
  } catch {
    return undefined;
  }
}

interface Generated {
  readonly raw: string;
  readonly outcome: AttemptOutcome;
  readonly errors: readonly string[];
}

/** One call to the adapter, with any throw classified rather than escaping. */
async function generateOnce(provider: AgentProvider, prompt: AgentPrompt): Promise<Generated> {
  try {
    return { raw: await provider.generate(prompt), outcome: 'accepted', errors: [] };
  } catch (error) {
    // A timeout arrives here too, and it is classified as a PROVIDER failure
    // rather than an infra one: the provider failed to deliver. Both map to
    // exit 3, but the classification is what shows up in run metadata and in
    // doctor, where "the CLI hung" and "your disk is full" must not look alike.
    const message = error instanceof Error ? error.message : String(error);
    return { raw: '', outcome: 'provider-failed', errors: [message] };
  }
}

/**
 * Run the gate and return the full envelope. Never throws for a bad response —
 * an exhausted budget is the `ok: false` arm, carrying every attempt.
 *
 * Use this when you want the attempt detail (rendering, diagnostics, run
 * metadata). Use `invoke` when you want a validated draft or a typed error.
 */
export async function attemptInvoke<T>(
  request: AgentRequest<T>,
  deps: InvokeDeps,
): Promise<AgentResponse<T>> {
  const { provider, clock } = deps;
  const totalAttempts = clampRetries(deps.options?.maxRetries) + 1;
  const jsonSchema = request.jsonSchema ?? deriveJsonSchema(request.responseSchema);

  const startedAt = clock.now().getTime();
  let attemptStartedAt = startedAt;
  let elapsedAt = startedAt;

  const attempts: AgentAttempt[] = [];
  let lastRaw = '';

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const previous = attempts.at(-1);
    const prompt: AgentPrompt = {
      role: request.role,
      prompt:
        previous === undefined
          ? request.prompt
          : withRejectionFeedback(request.prompt, previous, attempt, totalAttempts),
      ...(request.contextFiles !== undefined ? { contextFiles: request.contextFiles } : {}),
      ...(jsonSchema !== undefined ? { jsonSchema } : {}),
    };

    const generated = await generateOnce(provider, prompt);

    let outcome: AttemptOutcome = generated.outcome;
    let errors: readonly string[] = generated.errors;
    let parsed: T | undefined;

    if (outcome === 'accepted') {
      lastRaw = generated.raw;
      let value: unknown;
      try {
        value = JSON.parse(generated.raw);
      } catch (error) {
        // Not JSON at all — kept distinct from "JSON of the wrong shape",
        // because they mean different things to whoever reads the attempt log.
        // An empty or whitespace-only response lands here too, and is RECORDED
        // with its empty payload rather than becoming an unclassified crash.
        outcome = 'unparsable';
        errors = [
          generated.raw.trim().length === 0
            ? 'the response was empty'
            : `the response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        ];
      }

      if (outcome === 'accepted') {
        const validated = request.responseSchema.safeParse(value);
        if (validated.success) {
          parsed = validated.data;
        } else {
          outcome = 'schema-rejected';
          errors = describeValidationError(validated.error);
        }
      }
    }

    const now = clock.now().getTime();
    attempts.push({
      attempt,
      raw: generated.raw,
      outcome,
      errors,
      durationMs: Math.round(now - attemptStartedAt),
    });
    attemptStartedAt = now;
    elapsedAt = now;

    if (parsed !== undefined || outcome === 'accepted') {
      return {
        ok: true,
        // `parsed` is set whenever `outcome` stayed 'accepted'; the cast is
        // confined to this one line rather than leaking into the envelope type.
        parsed: parsed as T,
        raw: generated.raw,
        attempts,
        durationMs: Math.round(now - startedAt),
      };
    }
  }

  return {
    ok: false,
    raw: lastRaw,
    attempts,
    durationMs: Math.round(elapsedAt - startedAt),
  };
}

/**
 * The gate as most callers want it: a validated draft, or a `ProviderError`.
 *
 * `ProviderError` is AD-7's exit-3 class — an infra/SpecWitness failure, never a
 * product FAIL. A provider that cannot produce a schema-valid draft has not
 * proved the epic wrong; it has failed to do its job.
 */
export async function invoke<T>(request: AgentRequest<T>, deps: InvokeDeps): Promise<AgentSuccess<T>> {
  const response = await attemptInvoke(request, deps);
  if (response.ok) {
    return response;
  }

  const reasons = response.attempts
    .map((a) => `  attempt ${a.attempt} (${a.outcome}): ${a.errors[0] ?? 'no detail'}`)
    .join('\n');

  throw new ProviderError(
    `provider "${deps.provider.id}" (${deps.provider.adapter}) did not return a schema-valid ` +
      `response for role "${request.role}" after ${response.attempts.length} attempts:\n${reasons}`,
    'rerun to retry, or check the provider CLI is authenticated and responding — ' +
      'no artifact was written, so nothing is half-generated',
  );
}
