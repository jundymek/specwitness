/**
 * AD-5 — the Verification Contract model.
 *
 * A Contract is the frozen, versioned set of Criteria for one epic: the sole
 * authority on WHAT must be true. It has exactly two top-level parts and the
 * split is the whole point of the design:
 *
 *   - `spec` — the epic reference, the version and the criteria. This is the
 *     content, and it is the ONLY thing that is fingerprinted.
 *   - `meta` — the fingerprint itself, the frozen flag, timestamps, generation
 *     provenance and the amendment history. NEVER fingerprinted.
 *
 * Keeping them apart is what makes freeze work at all. If `meta` were inside
 * the hashed region, writing the fingerprint would change the thing the
 * fingerprint describes, and appending an amendment history entry — or
 * recording which model drafted the text — would look identical to someone
 * quietly weakening an expectation. Hashing `spec` only is not a convenience;
 * it is the reason a tamper is distinguishable from bookkeeping.
 *
 * The three vocabularies below are CLOSED, and defined exactly once, here.
 * Their zod mirrors in `schemas/enums.ts` are derived from these arrays rather
 * than re-listing the literals, so the two cannot drift. Widening one of them
 * is an ADR in `docs/adr/`, not an edit — the plan compiler, the report
 * renderers and the Golden Verification Corpus all assert on these literals.
 *
 * AD-1: pure. This module imports nothing — no zod, no `node:crypto`, not even
 * a sibling. Hashing lives in `schemas/canonical.ts` and validation in
 * `schemas/contract.ts`, so the model itself stays testable without any I/O.
 *
 * AD-9: there is no timestamp helper here and no default value that reads a
 * clock. Every instant in this model arrives as a string an edge computed from
 * the injected `Clock`.
 */

/**
 * Criterion classification, guiding verification strategy (PRD Glossary).
 *
 * - `behavioral`  — externally observable behaviour of the running system.
 * - `integration` — behaviour across a seam between components or services.
 * - `invariant`   — something that must hold at all times, not at one moment.
 * - `security`    — an authorization, secrecy or abuse-resistance property.
 * - `structural`  — a property of the artifact itself (layout, boundaries).
 * - `performance` — a bound on time, memory or throughput.
 * - `human`       — a requirement class only a person can judge.
 *
 * `deterministic` is deliberately absent: it describes a verification
 * property, not a class of requirement (PRD Glossary, recorded assumption).
 */
export const KINDS = Object.freeze([
  'behavioral',
  'integration',
  'invariant',
  'security',
  'structural',
  'performance',
  'human',
] as const);

export type Kind = (typeof KINDS)[number];

/**
 * Criterion weight (PRD Glossary).
 *
 * Recorded and reported, but it does NOT soften aggregation in V0: any `fail`
 * is a FAIL regardless of severity (ADR-002 / AD-6). Two levels is the whole
 * vocabulary; a third would imply a weighting rule that does not exist.
 */
export const SEVERITIES = Object.freeze(['critical', 'normal'] as const);

export type Severity = (typeof SEVERITIES)[number];

/**
 * Whether a criterion is machine-checkable (PRD Glossary).
 *
 * `human` criteria always resolve to NEEDS_HUMAN and never auto-PASS — that is
 * one of only two NEEDS_HUMAN triggers in the whole product (architecture
 * question Q39), which is why this is a property of the contract rather than a
 * judgement made later at run time.
 */
export const VERIFIABILITIES = Object.freeze(['automated', 'human'] as const);

export type Verifiability = (typeof VERIFIABILITIES)[number];

/**
 * One independently evaluable expectation.
 *
 * `statement` is written as externally observable behaviour, and it may span
 * several lines. Nothing in this codebase reflows, case-folds or normalises it:
 * it is a human's words about what "done" means, and rewriting them silently is
 * the failure this whole story exists to prevent. Statements that name internal
 * functions or classes are FLAGGED for review by story 2.6, never rejected —
 * a `structural` criterion may legitimately name a module (FR-7; epics.md 2.6).
 */
export interface Criterion {
  /**
   * Canonical criterion id, `E<n>-<NN>` — built and validated exclusively by
   * `domain/ids.ts`. Stable across amendments, which is why probes and reports
   * may reference it.
   */
  readonly id: string;
  readonly statement: string;
  readonly kind: Kind;
  readonly severity: Severity;
  readonly verifiability: Verifiability;
}

/**
 * The fingerprinted half of a contract.
 *
 * Criterion ORDER is meaningful and is preserved by canonicalization:
 * reordering criteria changes the fingerprint, because the file a human
 * reviewed and the file being verified should be the same file.
 */
export interface ContractSpec {
  /** Canonical epic id (`epic-7`), normalised by `domain/ids.ts`. */
  readonly epic: string;
  /**
   * Integer, monotonic, starting at 1 (spine Identifiers row). Freezing does
   * NOT bump it; amending does. Being an integer is also what keeps `1` vs
   * `1.0` vs `1e0` from ever becoming a canonicalization question.
   */
  readonly version: number;
  readonly criteria: readonly Criterion[];
}

/**
 * How a draft came to exist (AD-5).
 *
 * Populated by story 2.6 at the CLI edge, where the provider actually runs.
 * Every field is `| null` and an unknown value is written as an explicit
 * `null`, never omitted: an absent key is indistinguishable from a key an
 * older writer never knew about, so "we could not learn the model" has to be
 * recordable as data.
 *
 * `providerCliVersion` is the AGENT CLI's version (`codex --version`,
 * `claude --version`) — that is AD-5's "CLI version", read alongside "model as
 * reported by the CLI". It is NOT the SpecWitness build version: what this
 * block exists to answer is what generated this draft, and the artifact format
 * is already pinned by `meta.schemaVersion`. On the codex path `model` is
 * routinely null, because `--output-last-message` returns message text only.
 */
export interface ContractProvenance {
  readonly provider: string | null;
  readonly model: string | null;
  readonly providerCliVersion: string | null;
  /** ISO-8601 UTC. */
  readonly generatedAt: string | null;
}

/**
 * One superseded version, recorded when a contract is amended (FR-10).
 *
 * Written by story 2.7's amend flow; the shape exists from schema version 1 so
 * that a contract written today is readable by the amend flow tomorrow.
 *
 * There is deliberately no `author` field. V0 has no identity system, and a
 * self-reported name read from the environment would be an attestation with no
 * attester behind it — worse than no field, because a later reader would trust
 * it. Authorship is attested by git history: these files are committed
 * (architecture question Q11).
 */
export interface ContractHistoryEntry {
  /** The version being superseded — not the new one. */
  readonly version: number;
  /** That superseded version's fingerprint. */
  readonly fingerprint: string;
  /** ISO-8601 UTC. */
  readonly timestamp: string;
  /** Operator-supplied reason for the amendment. */
  readonly reason: string;
}

/**
 * The never-fingerprinted half.
 *
 * `schemaVersion` lives HERE rather than in `spec`, and that placement is
 * load-bearing: a future migration that bumps it must not change the
 * fingerprint of semantically unchanged content, or every frozen contract in
 * existence would report tampering the day the schema evolves.
 */
export interface ContractMeta {
  /** From the AD-5 registry, `SCHEMA_VERSIONS.contract`. */
  readonly schemaVersion: number;
  readonly frozen: boolean;
  /** Lowercase hex SHA-256 of the canonical `spec`; `null` until frozen. */
  readonly fingerprint: string | null;
  /** ISO-8601 UTC. */
  readonly createdAt: string;
  /** ISO-8601 UTC; `null` until frozen. */
  readonly frozenAt: string | null;
  readonly provenance: ContractProvenance;
  /** Oldest first. Empty on a first draft. */
  readonly history: readonly ContractHistoryEntry[];
}

/**
 * A whole contract: exactly two top-level keys, `spec` and `meta`.
 *
 * A third key would have to be either fingerprinted or not, and neither answer
 * would be one anybody chose — which is why the zod schema is `.strict()` and
 * an unknown top-level key is an error naming its path rather than a silent
 * drop. A dropped key in a fingerprinted document is a silent expectation
 * change, the exact thing this model exists to make impossible.
 */
export interface Contract {
  readonly spec: ContractSpec;
  readonly meta: ContractMeta;
}
