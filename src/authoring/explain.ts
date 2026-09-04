/**
 * FR-11's `explainer` role — story 5.5. The one provider flow in the product whose output
 * NOTHING mechanical consumes.
 *
 * ============================================================================
 * WHAT THIS MODULE IS FOR, AND WHAT IT IS FORBIDDEN TO DO
 * ============================================================================
 *
 * A repair agent handed a bare `expected: 200, actual: 500` starts from zero. A hypothesis
 * — "the service returned 500 on every request after the data reset; the migration in the
 * diff drops a column this endpoint reads" — is a head start. That is the entire value
 * proposition, and it is a CONVENIENCE.
 *
 * Conveniences are where boundaries erode, and this one sits closer to the product's
 * central line than anything else in V0: it reads the evidence, forms an opinion about the
 * failure, and prints it beside the verdict. AD-2 exists because "AI becoming the source
 * of truth" is the failure this product is built against, and `CLAUDE.md`'s first
 * non-negotiable rule is **never ask an LLM whether it passes**.
 *
 * So, precisely:
 *
 *  - **An explainer never touches a verdict.** Not a status, not the aggregation, not an
 *    exit code, not a severity, not an `expected` value. It produces `CriterionExplanation`
 *    values and nothing else, and `CriterionExplanation` has exactly two fields, neither of
 *    which any mechanical path reads.
 *  - **It PROPOSES nothing and MUTATES nothing.** This is the boundary against story 5.6's
 *    adaptation flow, and the distinction is the one worth being loudest about: an
 *    explainer produces **text a human reads**; an adaptation produces **a change to an
 *    executable artifact**. Different authority, different role, different fields. Nothing
 *    in this module can express a change to a plan, a contract, a probe or a result,
 *    because the only type it can return has no place to put one.
 *  - **A hypothesis is not evidence.** It never becomes an `Evidence` member,
 *    `EVIDENCE_KINDS` is not widened, and the persisted field's own name and documentation
 *    say what it is.
 *
 * HOW THAT IS MADE STRUCTURAL RATHER THAN PROMISED. `explainRun` returns a value; it is
 * handed a `RunResult` and has no way to write one. `attachExplanations` is the only path
 * from that value into a run, it copies every other field through untouched, and the field
 * it sets is a SIBLING of `criteria` rather than a member — so a hypothesis is outside the
 * reach of `aggregate()`, which is handed `criteria` and `gates`. The consequence is the
 * story's headline acceptance criterion, and it is checkable rather than arguable: the
 * serialized run is byte-for-byte identical with and without `--explain`, modulo the
 * `explanations` array itself and the `providerUsage` entry recording that a call was made.
 *
 * ============================================================================
 * THE ASYMMETRY: AN EXPLAINER FAILURE MUST NOT FAIL THE RUN
 * ============================================================================
 *
 * This inverts every other provider call in the product. A `plan-author` failure
 * legitimately stops a run — without a plan there is nothing to adjudicate, and
 * `providers/invoke.ts`'s `invoke` throws `ProviderError` (exit 3) to say so. An explainer
 * failure must do none of that: **no explainer configured, provider binary missing,
 * provider error, schema-gate rejection or timeout all leave the verification results
 * exactly as they were, with the explanation simply absent and a note saying why.**
 *
 * A convenience that can break a verification is not a convenience. So this module calls
 * `attemptInvoke` — the gate's envelope-returning arm, which classifies an adapter throw
 * instead of propagating it — and wraps even that in a `catch`, because "never throws" has
 * to hold for reasons this file did not anticipate as well as for the ones it did.
 *
 * ============================================================================
 * WHAT IS SENT, AND WHAT MAY NEVER BE
 * ============================================================================
 *
 * AC1 fixes the inputs: the criterion statement, expected/actual, and evidence summaries.
 * All three are taken from the `RunResult` AS IT ALREADY EXISTS:
 *
 *  - `statement` is the contract author's own words, carried verbatim by
 *    `deriveCriterionResult` from the frozen contract.
 *  - `expected`/`actual` were redacted at derivation (`domain/criterion-result.ts`).
 *  - every evidence member was redacted and bounded at capture, through the constructors
 *    in `domain/evidence.ts` (AD-10).
 *
 * **NOTHING HERE RE-READS A RAW FILE TO GIVE THE MODEL "MORE CONTEXT".** That would be the
 * one path by which a captured credential leaves the machine, and it arrives as
 * helpfulness — a run directory holds the full, redacted copies of every truncated stream,
 * and reaching for them would look like an obvious improvement. It is a security boundary,
 * not a limitation to work around. This module cannot even do it by accident: it is handed
 * a `RunResult` and no file reader, and `src/authoring/**` receives its I/O from callers.
 *
 * A prompt is data leaving the process, and it is also a subscription cost and a context
 * window, so everything below is additionally BOUNDED: a cap on how many criteria are
 * explained at all, a cap per field, and a cap on the whole prompt.
 *
 * ============================================================================
 * ONE CALL PER RUN, AND WHY THE IDS ARE CHECKED ON THE WAY BACK
 * ============================================================================
 *
 * The provider is invoked ONCE for the whole run and answers about every failed criterion
 * in one payload, rather than once per criterion. One invocation is one quota charge, one
 * `providerUsage` entry and one bounded prompt; N invocations would multiply all three by
 * the number of things that went wrong, which is exactly the run where a user least wants
 * a surprise bill.
 *
 * The response's `criterionId`s are matched against the run's own criteria and unknown ones
 * are DROPPED. A provider therefore cannot introduce a criterion, cannot resurrect one the
 * run skipped, and cannot re-point a hypothesis at a criterion it was not shown. The
 * matching is not tidiness: it is the difference between "provider text appears beside a
 * criterion" and "provider text can name any criterion it likes".
 *
 * AD-2: every invocation goes through the ONE gate at `src/providers/invoke.ts`, which
 * parses, validates against the schema below, feeds errors back, counts attempts and
 * classifies failures within a bounded retry budget. There is no second gate here and no
 * bypass, and the budget is neither raised nor nested.
 *
 * AD-1: `src/authoring/**` is the application layer that already composes providers through
 * the gate for contract and plan authoring, which is what makes it this module's home.
 * `src/domain/**` is pure and may not invoke a provider or import zod; `src/providers/**`
 * is an adapter and may not import `src/config/**`; `src/report/**` may import only domain
 * and schemas. The CLI edge resolves the role from config and passes the built provider
 * down, exactly as it does for `plan-author`.
 */

import { z } from 'zod';

import type { AgentProvider, AgentRequest } from '../domain/agent-provider.js';
import type { DerivedCriterionResult } from '../domain/criterion-result.js';
import {
  boundedText,
  truncationMarker,
  type Evidence,
  type RedactionOptions,
} from '../domain/evidence.js';
import type { Clock } from '../domain/ports.js';
import type {
  CriterionExplanation,
  ProviderUsage,
  RunResult,
} from '../domain/run-result.js';
import { attemptInvoke } from '../providers/invoke.js';
import { schemaVersionFor } from '../schemas/versions.js';

import { assemblePrompt, promptField } from './prompt-assembly.js';

/** The role name, spelled once. Already declared in `AI_ROLES` and `AgentRole`. */
export const EXPLAINER_ROLE = 'explainer' as const;

/**
 * The payload contract's version (AD-5), registered in `schemas/versions.ts`.
 *
 * Not sent to the provider and not persisted — a hypothesis is not a versioned artifact of
 * its own. It exists so the day this payload grows a field there is already a number to
 * move, which is the same reason `epicSpec` is registered while nothing writes one.
 */
export const EXPLANATION_SCHEMA_VERSION = schemaVersionFor('explanation');

/**
 * The most criteria one run will pay to have explained.
 *
 * A cap rather than "all of them" because the prompt, the context window and the bill all
 * grow with it, and a run with ninety failures is a run whose FIRST few failures are what
 * anybody reads. Criteria are taken in the run's own order, so which ones are explained is
 * deterministic rather than dependent on how the map iterated.
 */
export const MAX_EXPLAINED_CRITERIA = 20;

/**
 * Whole-prompt cap, in BYTES. Story 6.8's shared `assemblePrompt` enforces it.
 *
 * 24 000, carried unchanged from story 5.5's `PROMPT_CAP_CHARS`; only the unit moved, from
 * characters to bytes, when the layer stopped keeping two bounding vocabularies. Bytes are
 * what a request actually costs, and for the same number a byte cap is never looser than a
 * character one.
 *
 * WHY THIS ROLE IS CAPPED AT 24 000 WHILE THE AUTHORING ROLES ARE CAPPED AT 200 000
 * (story 6.8, Task 4): losing an evidence summary from an explanation costs a paragraph of
 * a NON-AUTHORITATIVE hypothesis nothing mechanical reads. Losing a criterion from the
 * contract-author prompt would silently narrow a definition of done. Different content,
 * different consequence, different number — deliberately not unified.
 *
 * The per-field cap is `PROMPT_FIELD_CAP_BYTES`, shared with every other builder in the
 * layer. Exported so a test asserts against THIS number rather than a hand-copied duplicate.
 */
export const PROMPT_CAP_BYTES = 24_000;

/**
 * The cap on ONE returned hypothesis, in bytes.
 *
 * Smaller than `EVIDENCE_INLINE_CAP_BYTES` on purpose: this is model-written prose with no
 * length discipline, printed into a report an agent may be reading, and — unlike evidence —
 * there is no full copy of it on disk to point a reader at.
 */
export const EXPLANATION_CAP_BYTES = 1500;

/**
 * The statuses worth explaining.
 *
 * `fail` and `error` — the two ways a criterion can have gone wrong with observed evidence
 * behind it. Deliberately NOT the other three: `pass` has nothing to explain, `skipped`
 * observed nothing to form a hypothesis from, and `needs_human` already has a purpose-built
 * reviewer-facing field written by a human's own plan (story 5.3) — putting a model's guess
 * beside it would put a hypothesis where a person's instructions belong.
 */
const EXPLAINABLE_STATUSES: readonly string[] = ['fail', 'error'];

/**
 * The schema the merged gate validates the provider's answer against.
 *
 * `z.strictObject` throughout, following `src/schemas/plan.ts`'s precedent: a payload
 * carrying a key this shape has never heard of is REJECTED rather than trimmed. There is
 * nothing here a provider could smuggle a status, an expected value or a proposed change
 * into — the only string fields are an id, which is checked against the run, and prose,
 * which nothing reads.
 */
export const EXPLAINER_RESPONSE_SCHEMA = z.strictObject({
  explanations: z
    .array(
      z.strictObject({
        criterionId: z.string().min(1),
        /**
         * Named `hypothesis` on the WIRE and stored as `explanation`.
         *
         * The rename is deliberate and is aimed at the model rather than at the reader:
         * the field a provider is asked to fill is called what it is, so the instruction
         * "this is a hypothesis, not a finding" is restated by the payload's own shape and
         * not only by the prose above it.
         */
        hypothesis: z.string().min(1),
      }),
    )
    .max(MAX_EXPLAINED_CRITERIA),
});

export type ExplainerResponse = z.infer<typeof EXPLAINER_RESPONSE_SCHEMA>;

export interface ExplainRequest {
  /** Read, never written. `explainRun` has no way to modify it. */
  readonly result: RunResult;
  readonly provider: AgentProvider;
  /** The `ai.providers` key, for the `providerUsage` record (Q65). */
  readonly providerName: string;
  readonly clock: Clock;
  /** Provenance, as `readProviderProvenance` reports it. `null` when unknown — never guessed. */
  readonly model?: string | null;
  readonly providerCliVersion?: string | null;
  /**
   * The run's redaction options (AD-10), forwarded to the shared prompt assembly.
   *
   * OPTIONAL AND CURRENTLY UNSET BY EVERY CALLER, which is worth stating rather than
   * leaving for a reader to discover: nothing at the CLI edge builds a `RedactionOptions`
   * today — `src/cli/commands/verify.ts` composes the probe dispatcher with no `redaction`
   * key. The built-in patterns always apply; what this seam adds is the config-declared
   * EXTRA patterns, for the day something wires them. That is exactly the posture
   * `RedactionOptions` documents for itself in `src/domain/evidence.ts`: the parameter
   * exists so that when a caller needs it there is nowhere new to put it, and no second
   * redaction entry point gets invented. Wiring it at the edge is not story 6.8's scope.
   */
  readonly redaction?: RedactionOptions;
}

/**
 * What one explanation attempt produced. **Never an error**, by construction.
 *
 * `note` is present exactly when `explanations` is empty and says why, so AC2's "the
 * explanation is simply absent with a note" is a value the caller prints rather than an
 * exception it has to remember not to rethrow.
 */
export interface ExplainOutcome {
  readonly explanations: readonly CriterionExplanation[];
  /**
   * One entry when the provider was actually invoked, EMPTY when it was not — and it is
   * populated even when the invocation FAILED.
   *
   * Q65 and FR-15 require every provider invocation to be recorded, and a failed attempt
   * spent the same quota a successful one would have. Dropping the record on the failure
   * path would hide precisely the spend a user most wants to see.
   */
  readonly providerUsage: readonly ProviderUsage[];
  /** Present iff nothing was explained. Human-readable, no `ERROR:` prefix — not an error. */
  readonly note?: string;
}

/**
 * The criteria this run would pay to have explained, in the run's own order.
 *
 * Exported because the CLI needs the same answer to decide whether invoking the provider is
 * worth anything at all: a run with nothing to explain must not spend quota discovering
 * that, and two call sites computing "what counts as a failure" separately is two places
 * for them to disagree.
 */
export function explainableCriteria(result: RunResult): readonly DerivedCriterionResult[] {
  return result.criteria
    .filter((criterion) => EXPLAINABLE_STATUSES.includes(criterion.status))
    .slice(0, MAX_EXPLAINED_CRITERIA);
}

/**
 * One line summarising one evidence member (AC1's "evidence summaries").
 *
 * Built from the member's OWN already-redacted, already-bounded fields — a summary, not a
 * dump, and never a re-read. The switch is exhaustive over the closed union, so a seventh
 * evidence kind stops compiling here rather than silently producing a blank line.
 */
function summarizeEvidence(evidence: Evidence): string {
  // NO `redaction` here, deliberately: `promptField` bounds and applies the built-in
  // patterns, and `assemblePrompt` applies the run's CONFIGURED patterns exactly once over
  // the assembled body. Passing them here too applied them twice. Codex P2.
  const field = (value: string): string => promptField(value);

  switch (evidence.kind) {
    case 'http':
      return `http ${evidence.request.method} ${evidence.request.url} -> ${evidence.response.status}; body: ${field(evidence.response.body.text)}`;
    case 'browser':
      return `browser ${evidence.url}${evidence.trace === undefined ? '' : ' (trace captured)'}`;
    case 'observation':
      return `observation ${evidence.observationId}: ${field(evidence.snapshot.text)}`;
    case 'command':
      return `command ${evidence.commandId} exited ${evidence.exitCode ?? 'null'}; stdout: ${field(evidence.stdout.text)}; stderr: ${field(evidence.stderr.text)}`;
    case 'gate':
      return `gate ${evidence.gateId} ${evidence.status} (exit ${evidence.exitCode ?? 'null'}); stdout: ${field(evidence.stdout.text)}; stderr: ${field(evidence.stderr.text)}`;
    case 'provider':
      // The rawResponse of an EARLIER provider call is deliberately not forwarded: it is
      // diagnostic text about a different invocation, and it is the one evidence member
      // whose content is itself model output.
      return `provider ${evidence.role} via ${evidence.provider} (${evidence.attempts} attempts)`;
  }
}

/**
 * The prompt. Assembled from redacted, bounded values and nothing else.
 *
 * Exported so a test can assert on exactly the bytes that would leave the process —
 * including, above all, that a seeded credential is ABSENT from them. Asserting the
 * `[REDACTED]` marker is PRESENT is the weaker check and passes on output that carries the
 * marker with the secret still beside it (Epic 3 retro §7).
 */
export function buildExplainPrompt(
  result: RunResult,
  criteria: readonly DerivedCriterionResult[],
  redaction?: RedactionOptions,
): string {
  // NO `redaction` here, deliberately: `promptField` bounds and applies the built-in
  // patterns, and `assemblePrompt` applies the run's CONFIGURED patterns exactly once over
  // the assembled body. Passing them here too applied them twice. Codex P2.
  const field = (value: string): string => promptField(value);

  const header: string[] = [
    'You are assisting a verification tool called SpecWitness.',
    '',
    'A verification run has finished and some acceptance criteria did not pass. The',
    'verdict has ALREADY been decided mechanically and is final. Your output is a',
    'NON-AUTHORITATIVE hypothesis that a human or a repair agent reads. It will not',
    'change any status, any verdict or any exit code, and it is stored in a field',
    'labelled as a hypothesis.',
    '',
    'Do NOT propose a change to any file, plan, contract or test. Do NOT state whether',
    'a criterion passes. State, for each criterion below, your best guess at the ROOT',
    'CAUSE of what was observed, in at most three sentences.',
    '',
    `Run: ${result.runId} · epic ${result.epic} · base ${result.baseSha} · head ${result.headSha}`,
    '',
    '--- FAILED CRITERIA ---',
  ];

  const body: string[] = [];

  for (const criterion of criteria) {
    body.push(
      '',
      `criterionId: ${criterion.criterionId}`,
      `status: ${criterion.status} (severity ${criterion.severity})`,
      `statement: ${field(criterion.statement)}`,
    );
    if (criterion.expected !== undefined) {
      body.push(`expected: ${field(criterion.expected)}`);
    }
    if (criterion.actual !== undefined) {
      body.push(`actual: ${field(criterion.actual)}`);
    }
    if (criterion.evidence !== undefined && criterion.evidence.length > 0) {
      body.push(
        `evidence: ${criterion.evidence.map((ref) => `${ref.kind} at ${ref.path}`).join(', ')}`,
      );
    }
  }

  body.push('', '--- EVIDENCE SUMMARIES (already redacted; this is all there is) ---');
  if (result.evidence.length === 0) {
    body.push('(none captured)');
  } else {
    for (const evidence of result.evidence) {
      body.push(`- ${summarizeEvidence(evidence)}`);
    }
  }

  const footer: string[] = [
    '',
    '--- RESPOND WITH ONLY THIS JSON ---',
    '{"explanations":[{"criterionId":"<one of the ids above>","hypothesis":"<your text>"}]}',
    '',
    'Use only criterionIds listed above; any other id is discarded.',
  ];

  // THE CAP FALLS ON THE BODY ALONE, and never on the instructions.
  //
  // Story 5.5's first version clipped the assembled prompt as one string, which bounds it
  // correctly and cuts off the WRONG END: the response-shape line and the valid-ids rule
  // are the LAST thing in the document, so exactly the runs with the most to explain would
  // have sent a provider a prompt that stops mid-sentence and never says what to reply
  // with. Those runs would then burn the whole retry budget on schema rejections — the
  // failure arriving precisely where the feature was most wanted. Found by review.
  //
  // ⚠️ AND THEN STORY 5.6 DERIVED THE SAME DEFECT INDEPENDENTLY, hours later, in
  // `adaptation-prompt.ts`. Two modules, one mistake, twice. That is why the budget
  // arithmetic that used to live here now lives in `assemblePrompt`, which every builder in
  // this layer shares: `header` is its `head`, `footer` is its `tail`, and neither can be
  // reached by any input size. Story 6.8, retiring Epic 5 action item e5-A.
  return assemblePrompt({
    head: header,
    body,
    tail: footer,
    capBytes: PROMPT_CAP_BYTES,
    ...(redaction === undefined ? {} : { redaction }),
  });
}

/**
 * Redacts and bounds one returned hypothesis.
 *
 * `boundedText` is the merged constructor — it redacts first, then caps — so there is no
 * second redaction entry point for this text and no way to get the cap without the
 * redaction. `truncationMarker` is the merged one-and-only marker format; appending it
 * matters because, with no full copy on disk, a silently clipped hypothesis would read as
 * a complete thought that simply stopped making sense.
 */
function redactAndBound(raw: string, redaction: RedactionOptions | undefined): string {
  const bounded = boundedText(raw, { ...redaction, capBytes: EXPLANATION_CAP_BYTES });
  const marker = truncationMarker(bounded);
  return marker === '' ? bounded.text : `${bounded.text} ${marker}`;
}

/**
 * Ask the explainer for hypotheses. **Never throws, for any reason, ever.**
 *
 * That is the contract AC2 turns on, and it is the inverse of `compilePlan`'s. Every route
 * — no criteria to explain, an adapter that throws, a timeout, output that is not JSON,
 * output that is JSON of the wrong shape, an exhausted retry budget — returns an
 * `ExplainOutcome` with no explanations and a note. The caller renders the note and carries
 * on with results it never had a chance to affect.
 */
export async function explainRun(request: ExplainRequest): Promise<ExplainOutcome> {
  const criteria = explainableCriteria(request.result);
  if (criteria.length === 0) {
    // Checked BEFORE the provider, so a clean run never spends a penny to be told it had
    // nothing to explain.
    return {
      explanations: [],
      providerUsage: [],
      note: 'no criterion failed, so there was nothing to explain',
    };
  }

  const startedAt = request.clock.now().getTime();
  const usage = (attempts: number): readonly ProviderUsage[] => [
    {
      role: EXPLAINER_ROLE,
      provider: request.providerName,
      durationMs: Math.max(0, request.clock.now().getTime() - startedAt),
      // `ProviderUsage.attempts` is `positive()` in the persisted schema, so a route that
      // spent a call always reports at least one rather than zero.
      attempts: Math.max(1, attempts),
      model: request.model ?? null,
      providerCliVersion: request.providerCliVersion ?? null,
    },
  ];

  const agentRequest: AgentRequest<ExplainerResponse> = {
    role: EXPLAINER_ROLE,
    prompt: buildExplainPrompt(request.result, criteria, request.redaction),
    responseSchema: EXPLAINER_RESPONSE_SCHEMA,
    // `jsonSchema` deliberately unset: the gate derives it from `responseSchema` in exactly
    // one place, so two sites cannot disagree about it.
  };

  try {
    // `attemptInvoke`, NOT `invoke`. `invoke` throws `ProviderError` on an exhausted
    // budget, which is right for an artifact a run cannot proceed without and wrong for
    // this one. The envelope arm classifies the failure and hands it back as a value.
    const response = await attemptInvoke(agentRequest, {
      provider: request.provider,
      clock: request.clock,
      // The budget is the gate's default (2 retries => at most 3 attempts). Not raised,
      // not lowered, not nested — retries cost real quota and there is exactly one loop.
    });

    if (!response.ok) {
      const last = response.attempts.at(-1);
      return {
        explanations: [],
        providerUsage: usage(response.attempts.length),
        note:
          `the explainer produced no usable hypothesis after ${response.attempts.length} ` +
          `attempt(s) (${last?.outcome ?? 'no attempt recorded'}); ` +
          'verification results are unaffected',
      };
    }

    const known = new Set(criteria.map((criterion) => criterion.criterionId));
    const seen = new Set<string>();
    const explanations: CriterionExplanation[] = [];

    for (const entry of response.parsed.explanations) {
      // UNKNOWN IDS ARE DROPPED, and so are duplicates. A provider may not introduce a
      // criterion, may not name one it was not shown, and may not attach two hypotheses to
      // one criterion — the last of which would make the rendered report say two different
      // things about the same failure with no way to tell which the reader should believe.
      if (!known.has(entry.criterionId) || seen.has(entry.criterionId)) {
        continue;
      }
      seen.add(entry.criterionId);
      const explanation = redactAndBound(entry.hypothesis, request.redaction);
      if (explanation.trim() === '') {
        continue;
      }
      explanations.push({ criterionId: entry.criterionId, explanation });
    }

    if (explanations.length === 0) {
      return {
        explanations: [],
        providerUsage: usage(response.attempts.length),
        note:
          'the explainer answered, but named no criterion this run carries; ' +
          'verification results are unaffected',
      };
    }

    return { explanations, providerUsage: usage(response.attempts.length) };
  } catch (error) {
    // THE BACKSTOP. `attemptInvoke` already classifies an adapter throw rather than
    // propagating it, so nothing is expected to arrive here — which is exactly why it is
    // here. "An explainer failure never fails the run" has to hold for the reasons this
    // file did not anticipate as well as for the ones it did, and a `catch` that is never
    // entered costs nothing while a missing one costs a verification.
    return {
      explanations: [],
      providerUsage: usage(1),
      note:
        `the explainer could not be reached: ${error instanceof Error ? error.message : String(error)}; ` +
        'verification results are unaffected',
    };
  }
}

/**
 * The ONE path from an `ExplainOutcome` into a run. Copies everything else through.
 *
 * Returns a NEW `RunResult`; the input is never mutated. Two fields change and no others:
 * `explanations` is set (only when there is something to set), and the explainer's usage
 * entry is APPENDED to `providerUsage` — appended rather than replacing, because a run that
 * auto-compiled a plan already has an entry there and losing it would understate what the
 * run cost.
 *
 * Everything else — `outcome`, `criteria`, `gates`, `evidence`, `stages`, `environment`,
 * `contract`, every timestamp — is carried through by the spread, which is what makes the
 * byte-identity claim true by construction rather than by inspection.
 */
export function attachExplanations(result: RunResult, outcome: ExplainOutcome): RunResult {
  if (outcome.explanations.length === 0 && outcome.providerUsage.length === 0) {
    // NOTHING HAPPENED, so nothing is rebuilt — the caller gets the object it passed in,
    // by reference. This is the route where no provider was invoked at all (no failed
    // criterion), and returning the same reference is what lets the CLI skip republishing
    // the stored run entirely: its bytes are then not merely equivalent to the unexplained
    // ones, they were never rewritten.
    //
    // Note the condition is on BOTH arrays. A provider that was invoked and failed
    // produced no hypothesis but did spend quota, and that record must survive (Q65).
    return result;
  }

  return {
    ...result,
    providerUsage: [...result.providerUsage, ...outcome.providerUsage],
    ...(outcome.explanations.length === 0 ? {} : { explanations: outcome.explanations }),
  };
}
