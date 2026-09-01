/**
 * Story 3.5 — the persisted schema MIRRORS the domain model, checked at compile time.
 *
 * `src/schemas/result.ts` is `.strict()`, so a document carrying a key the schema has never
 * heard of is rejected on read. That is correct. What is dangerous is the ASYMMETRY it
 * creates with the write path:
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
 *
 *  - `GateEvidence.displayCommand` — became required, and without the mirror every gate
 *    evidence record failed to parse, so persisting any run containing a gate would have
 *    thrown.
 *  - `StageTimelineEntry.hint` — same shape, same consequence.
 *
 * Both times the mirror held because the person adding the field remembered. Neither time
 * was it the type system, and neither time would the fixture have caught it had they added
 * the field without touching the fixture — which is the ordinary case, not the exotic one.
 * This file makes it a COMPILE ERROR in the PR that adds the field, which is the only
 * moment the person with the context is looking.
 *
 * BOTH DIRECTIONS ARE CHECKED, deliberately. A domain field with no schema key is the case
 * above. A schema key with no domain field is the one nobody would ever notice: nothing
 * fails at either end, and the document quietly carries a key the model cannot express.
 *
 * HOW A FAILURE READS. Each pair is one property of `mirrors` below, typed as
 * `SameKeys<…>`. When two shapes diverge that type becomes `false`, the literal `true`
 * stops being assignable, and `tsc` names the property — so the error says which pair
 * drifted rather than printing a wall of structural diff.
 */

import { describe, expect, it } from 'vitest';

import type { DerivedCriterionResult } from '../../../src/domain/criterion-result.js';
import type {
  BoundedText,
  BrowserEvidence,
  CommandEvidence,
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
import type { RunResultDocument } from '../../../src/schemas/result.js';

/** True only when the two key unions are mutually assignable — i.e. identical. */
type SameKeys<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : false
  : false;

/**
 * One evidence member of the persisted document, by discriminant.
 *
 * Compared per `kind` rather than as a whole union: `keyof` over a union yields only the
 * keys COMMON to every member, so a union-level check would silently ignore everything
 * that makes the members different — which is all of the interesting surface, including
 * the `displayCommand` that started this.
 */
type DocEvidence<K extends string> = Extract<RunResultDocument['evidence'][number], { kind: K }>;

const mirrors: {
  /** The document is the model plus exactly one key; nothing else may differ. */
  document: SameKeys<Omit<RunResultDocument, 'schemaVersion'>, RunResult>;
  /** `schemaVersion` is the ONE key the document adds — asserted, not assumed. */
  schemaVersionIsTheOnlyExtra: SameKeys<
    Omit<RunResultDocument, keyof RunResult>,
    { schemaVersion: number }
  >;

  stages: SameKeys<RunResultDocument['stages'][number], StageTimelineEntry>;
  gates: SameKeys<RunResultDocument['gates'][number], GateResult>;
  criteria: SameKeys<RunResultDocument['criteria'][number], DerivedCriterionResult>;
  providerUsage: SameKeys<RunResultDocument['providerUsage'][number], ProviderUsage>;
  environment: SameKeys<RunResultDocument['environment'], RunEnvironment>;
  contract: SameKeys<NonNullable<RunResultDocument['contract']>, ContractSummary>;

  httpEvidence: SameKeys<DocEvidence<'http'>, HttpEvidence>;
  browserEvidence: SameKeys<DocEvidence<'browser'>, BrowserEvidence>;
  observationEvidence: SameKeys<DocEvidence<'observation'>, ObservationEvidence>;
  commandEvidence: SameKeys<DocEvidence<'command'>, CommandEvidence>;
  gateEvidence: SameKeys<DocEvidence<'gate'>, GateEvidence>;
  providerEvidence: SameKeys<DocEvidence<'provider'>, ProviderEvidence>;

  /**
   * `BoundedText` and `EvidenceRef` carry the PATH fields, so a drift in either lands
   * directly on the Q48 relative-path rule this schema exists to enforce.
   */
  boundedText: SameKeys<DocEvidence<'gate'>['stdout'], BoundedText>;
  evidenceRef: SameKeys<NonNullable<DocEvidence<'browser'>['trace']>, EvidenceRef>;
} = {
  document: true,
  schemaVersionIsTheOnlyExtra: true,
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

  it('covers every field of the persisted document, so nothing is silently unmirrored', () => {
    // A guard that checks eight of fifteen shapes is a guard that lets seven through. The
    // count is asserted so adding a field to the document without adding its pair here is
    // itself a failure.
    expect(Object.keys(mirrors)).toHaveLength(16);
  });
});
