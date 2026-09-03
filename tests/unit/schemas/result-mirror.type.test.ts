/**
 * Story 3.5 — the persisted schema MIRRORS the domain model, checked at compile time.
 *
 * `src/schemas/result.ts` is `.strict()`, so a document carrying a key it has never heard
 * of is rejected on read. That is correct. What is dangerous is the ASYMMETRY it creates
 * with the write path:
 *
 *   `toRunResultDocument` copies the model's arrays and objects through verbatim, and it
 *   does so without a cast — which LOOKS like the compiler is checking that the two shapes
 *   agree. It is not. TypeScript applies excess-property checking only to object
 *   *literals*; a value flowing through a variable carries extra properties silently. So a
 *   field added to a domain type and not mirrored here SERIALIZES fine and then FAILS TO
 *   PARSE BACK.
 *
 * That failure mode is nasty in a specific way: runs persist perfectly and become
 * unreadable weeks later, discovered by whoever opens a stored result rather than by
 * whoever added the field. For `hint` in particular it was self-defeating — the error runs
 * whose remedy had just been preserved would have been the only unreadable ones.
 *
 * IT HAS ALREADY HAPPENED TWICE, in one afternoon, on two different fields:
 * `GateEvidence.displayCommand` and `StageTimelineEntry.hint`. Both times the mirror held
 * because the person adding the field remembered — not because anything checked. Neither
 * time would the fixture have caught it had they added the field without touching the
 * fixture, which is the ordinary case rather than the exotic one.
 *
 * WHY THIS COMPARES STRUCTURE AND NOT KEY NAMES. The first version of this file compared
 * `keyof` unions, and review was right that this was a proxy for the question rather than
 * the question itself: `keyof` discards value types AND optional modifiers, so changing
 * `durationMs` from `number` to `string`, or making a domain field required while the
 * schema left it optional, sailed past a guard whose entire purpose was to catch exactly
 * that. A guard that reads a proxy is wrong precisely on the cases where the proxy and the
 * fact diverge — which are the interesting ones. `Exact` below compares the shapes
 * themselves, in both directions.
 *
 * BOTH DIRECTIONS, deliberately. A domain field with no schema key is the case above. A
 * schema key with no domain field is the one nobody would ever notice: nothing fails at
 * either end, and the document quietly carries a key the model cannot express.
 *
 * HOW A FAILURE READS. Each pair is one property of `mirrors`, typed `Exact<…>`. When two
 * shapes diverge that type becomes `false`, the literal `true` stops being assignable, and
 * `tsc` names the property — so the error says WHICH pair drifted instead of printing one
 * enormous structural diff. The whole-document check is listed first and would catch
 * everything on its own; the per-shape entries exist for legibility.
 */

import { describe, expect, it } from 'vitest';

import type { DerivedCriterionResult } from '../../../src/domain/criterion-result.js';
import type {
  BoundedText,
  BrowserEvidence,
  CommandEvidence,
  Evidence,
  EvidenceRef,
  GateEvidence,
  HttpEvidence,
  ObservationEvidence,
  ProviderEvidence,
} from '../../../src/domain/evidence.js';
import type { GateResult } from '../../../src/domain/result.js';
import type {
  ContractSummary,
  ProviderUsage,
  RunEnvironment,
  RunResult,
} from '../../../src/domain/run-result.js';
import type { StageTimelineEntry } from '../../../src/domain/stage.js';
import type {
  RunResultDocument,
  RunResultDocumentOnlyFields,
} from '../../../src/schemas/result.js';

/**
 * Recursively marks arrays and properties readonly, on both sides of a comparison.
 *
 * Without this every check would fail for an uninteresting reason: the domain declares
 * `readonly StageTimelineEntry[]` while zod infers a mutable `[]`, and a mutable array is
 * assignable to a readonly one but not the reverse. Normalising removes a difference that
 * cannot affect serialization — JSON has no notion of readonly — while leaving the two
 * differences that CAN, value types and optionality, fully compared. The mapped type is
 * homomorphic, so `?` survives it.
 */
type Normalize<T> = T extends readonly (infer E)[]
  ? readonly Normalize<E>[]
  : T extends object
    ? { readonly [K in keyof T]: Normalize<T[K]> }
    : T;

/** True only when the two shapes are mutually assignable after normalisation. */
type Exact<A, B> = [Normalize<A>] extends [Normalize<B>]
  ? [Normalize<B>] extends [Normalize<A>]
    ? true
    : false
  : false;

/**
 * One evidence member of the persisted document, by discriminant.
 *
 * Compared per `kind` rather than as a whole union, for legibility: a union-level failure
 * reports a diff across six members at once, where a per-kind failure names the member.
 */
type DocEvidence<K extends string> = Extract<RunResultDocument['evidence'][number], { kind: K }>;

/** The discriminants this file actually checks. */
type CheckedEvidenceKinds = 'http' | 'browser' | 'observation' | 'command' | 'gate' | 'provider';

const mirrors: {
  /**
   * THE load-bearing check: the document is the model plus exactly the document-only
   * keys, compared structurally and recursively. On its own this catches every drift
   * below; the rest exist so a failure names the shape rather than dumping the whole tree.
   */
  wholeDocument: Exact<Omit<RunResultDocument, keyof RunResultDocumentOnlyFields>, RunResult>;
  /**
   * The document-only keys are EXACTLY those `RunResultDocumentOnlyFields` names —
   * asserted, not assumed, in both directions.
   *
   * Story 5.4 widened this from the literal `{ schemaVersion: number }` it was until then,
   * and the widening is the guard working rather than being weakened: the exception is now
   * a named, exported type with its reasoning stated at the declaration, so a THIRD
   * document-only key still cannot appear without editing that type and re-reading why the
   * second one was allowed. A count in the document was required by story 5.4's AC1, while
   * `domain/result-counts.ts` refuses to store a count on the mutable model — deriving it
   * here, at write time, from the array the same document carries, is the only shape that
   * satisfies both.
   */
  documentOnlyKeysAreExactlyThose: Exact<
    Omit<RunResultDocument, keyof RunResult>,
    RunResultDocumentOnlyFields
  >;
  /**
   * Every member of the closed union is checked below. DERIVED from the union rather than
   * counted: a fixed tally would stay correct while a seventh evidence kind went entirely
   * unchecked, which is the false negative review caught in the first version of this file.
   */
  everyEvidenceKindIsChecked: Exact<CheckedEvidenceKinds, Evidence['kind']>;

  stages: Exact<RunResultDocument['stages'][number], StageTimelineEntry>;
  gates: Exact<RunResultDocument['gates'][number], GateResult>;
  criteria: Exact<RunResultDocument['criteria'][number], DerivedCriterionResult>;
  providerUsage: Exact<RunResultDocument['providerUsage'][number], ProviderUsage>;
  environment: Exact<RunResultDocument['environment'], RunEnvironment>;
  contract: Exact<NonNullable<RunResultDocument['contract']>, ContractSummary>;

  httpEvidence: Exact<DocEvidence<'http'>, HttpEvidence>;
  browserEvidence: Exact<DocEvidence<'browser'>, BrowserEvidence>;
  observationEvidence: Exact<DocEvidence<'observation'>, ObservationEvidence>;
  commandEvidence: Exact<DocEvidence<'command'>, CommandEvidence>;
  gateEvidence: Exact<DocEvidence<'gate'>, GateEvidence>;
  providerEvidence: Exact<DocEvidence<'provider'>, ProviderEvidence>;

  /**
   * `BoundedText` and `EvidenceRef` carry the PATH fields, so a drift in either lands
   * directly on the Q48 relative-path rule this schema exists to enforce.
   */
  boundedText: Exact<DocEvidence<'gate'>['stdout'], BoundedText>;
  evidenceRef: Exact<NonNullable<DocEvidence<'browser'>['trace']>, EvidenceRef>;
} = {
  wholeDocument: true,
  documentOnlyKeysAreExactlyThose: true,
  everyEvidenceKindIsChecked: true,
  stages: true,
  gates: true,
  criteria: true,
  providerUsage: true,
  environment: true,
  contract: true,
  httpEvidence: true,
  browserEvidence: true,
  observationEvidence: true,
  commandEvidence: true,
  gateEvidence: true,
  providerEvidence: true,
  boundedText: true,
  evidenceRef: true,
};

describe('the persisted schema mirrors the domain model (compile-time)', () => {
  it('is enforced by tsc — this assertion only proves the checks were reached', () => {
    // The real check is the object above: it does not COMPILE when a pair diverges. This
    // exists so the file is a test rather than a lint-exempt oddity, and so a future edit
    // that guts the type annotation still leaves something that fails.
    expect(Object.values(mirrors).every((held) => held)).toBe(true);
  });
});
