/**
 * The persisted run report (AD-5, AD-11, FR-30, FR-31).
 *
 * `.specwitness/runs/<run-id>/result.json` is what makes a run's evidence outlive the
 * terminal that produced it. It is written by `RunStore` at the persist stage and again
 * after teardown, always through the atomic stage-and-rename finalize, and read back by
 * `specwitness report`.
 *
 * ONE SERIALIZATION, DELIBERATELY (AD-11). `serializeRunResult` below is the ONLY
 * function in the repository that turns a `RunResult` into bytes. `src/infra/run-store.ts`
 * calls it to persist; `src/report/json.ts` calls it for `--json` and returns its result
 * unchanged. That is what makes the harness contract's central promise — the `--json`
 * document and the stored file are the same bytes (Q53) — a property of the code rather
 * than a coincidence two code paths have to keep agreeing on.
 *
 * It lives in `src/schemas/` and not in `src/infra/` for a structural reason rather than a
 * stylistic one: `src/report/**` may import `domain`, `schemas`, siblings and npm, and is
 * forbidden `infra`. A serializer inside `RunStore` would be one the JSON renderer could
 * not legally import, and byte-equality would then be unreachable without a second
 * serializer — precisely the drift this arrangement exists to prevent.
 *
 * THE SERIALIZATION RULE, stated because other stories assert byte-equality against it:
 *
 *   - `JSON.stringify(document, null, 2)` — two-space indentation, matching the manifest
 *     written beside it in the same run directory.
 *   - Exactly ONE trailing newline.
 *   - Key order is the literal construction order in `toRunResultDocument`, NOT
 *     alphabetical. `schemaVersion` first; `contract` last of the mechanically-derived
 *     keys, with story 5.5's optional, non-authoritative `explanations` after it.
 *   - No `undefined`-valued keys are emitted. Optional-and-absent stays absent rather
 *     than becoming `null`, so "this run had no contract" and "the contract was null"
 *     stay distinguishable.
 *   - UTF-8, LF, no BOM.
 *
 * A PARSED DOCUMENT MUST NOT BE RE-SERIALIZED TO REPRODUCE THE FILE. zod rebuilds a
 * validated object in SCHEMA DECLARATION order, which is not the order the domain's
 * evidence constructors build their members in — so `serializeRunResult(parsed)` carries
 * the same VALUES as the file but not the same BYTES. `report --json` therefore validates
 * the stored document and then writes the file's own bytes, which makes byte-equality
 * true by construction rather than true only while two independent key orderings happen
 * to agree. `tests/unit/schemas/result.test.ts` pins this so the shortcut is not taken
 * later by someone who reasonably assumes a round trip is lossless.
 *
 * PATHS. Every path INSIDE evidence is relative to the run-directory root (Q48), so a run
 * directory stays readable after being copied between machines. The schema REJECTS an
 * absolute one rather than discouraging it, on read as well as on write, because a
 * document can arrive from a copy, a hand edit or another tool and a constructor's
 * guarantees do not travel with the file.
 *
 * The one exception is `environment.worktreePath`, absolute BY DESIGN and deliberately not
 * caught by that rule. It is provenance, not a pointer: it records where the run happened,
 * on that machine, at that time, and the directory is normally gone by the time anyone
 * reads the result. `environment.runDirectory` is a third case again — relative to the
 * PROJECT root, not to the run directory. Do not conflate the three.
 *
 * AD-1: `src/schemas/**` may import `src/domain/**`, its own siblings and zod. Nothing
 * else — schemas validate, they do not reach out.
 */

import { z } from 'zod';

import { ATTEMPT_OUTCOMES } from '../domain/criterion-result.js';
import { InfraError } from '../domain/errors.js';
import { EVIDENCE_KINDS } from '../domain/evidence.js';
import { summarizeFlakiness } from '../domain/result-counts.js';
import type { RunResult } from '../domain/run-result.js';
import { STAGE_NAMES, STAGE_STATUSES } from '../domain/stage.js';
import {
  CriterionStatusSchema,
  GateStatusSchema,
  InfraErrorClassificationSchema,
  NeedsHumanReasonSchema,
  SeveritySchema,
  VerdictSchema,
} from './enums.js';
import { IsoUtcTimestamp } from './manifest.js';
import { unknownKeysOnly } from './unknown-keys.js';
import { schemaVersionFor } from './versions.js';

/** Current version of the persisted result document, from the AD-5 registry. */
export const RUN_RESULT_VERSION = schemaVersionFor('jsonReport');

/** The file name, so no other module spells it. Mirrors `MANIFEST_FILENAME`. */
export const RESULT_FILENAME = 'result.json';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * True for a path that stays inside the run directory.
 *
 * Rejects, in order of how likely each is to be the actual bug:
 *   - an absolute POSIX path (`/var/...`) — the portability bug this rule exists for;
 *   - a Windows absolute path (`C:\...`) or a UNC share, which a POSIX-only check would
 *     wave straight through into a document meant to be readable anywhere;
 *   - any `..` segment, which escapes the run directory while looking relative;
 *   - an empty or whitespace-only string.
 *
 * Backslashes are normalised before segment analysis rather than rejected: a document
 * written on Windows is still a document we must be able to read.
 */
function isRunRelativePath(value: string): boolean {
  if (value.trim() === '') {
    return false;
  }
  if (value.startsWith('/')) {
    return false;
  }
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) {
    return false;
  }

  return !value.replace(/\\/g, '/').split('/').includes('..');
}

const PATH_MESSAGE =
  'must be relative to the run directory root (no leading slash, no drive letter, no ".." segment)';

/** A path pointing at a file inside the run directory. */
const RunRelativePath = z.string().refine(isRunRelativePath, { message: PATH_MESSAGE });

// ---------------------------------------------------------------------------
// Evidence (AD-10) — the closed union, not bare references
// ---------------------------------------------------------------------------

const EvidenceKindSchema = z.enum(EVIDENCE_KINDS);

const EvidenceRefSchema = z
  .object({
    kind: EvidenceKindSchema,
    path: RunRelativePath,
  })
  .strict();

/**
 * Redacted, size-bounded content.
 *
 * `totalBytes` is the byte length of the REDACTED text before truncation, so it describes
 * the file that actually exists on disk rather than a document nobody is allowed to store.
 * `fullPath` is present only when `truncated` — enforced below, because a pointer on
 * untruncated content would send a reader to a file that was never written.
 */
const BoundedTextSchema = z
  .object({
    text: z.string(),
    truncated: z.boolean(),
    totalBytes: z.number().int().nonnegative(),
    fullPath: RunRelativePath.optional(),
  })
  .strict()
  .refine((value) => value.truncated || value.fullPath === undefined, {
    message: 'fullPath is only meaningful on truncated content',
    path: ['fullPath'],
  });

/** Fields every evidence member carries. */
const evidenceCommon = {
  capturedAt: IsoUtcTimestamp,
  durationMs: z.number().int().nonnegative(),
  /**
   * AD-10's labeled NON-AUTHORITATIVE field — the only place free-form model prose may
   * appear in a run. Nothing mechanical reads it: no verdict, no classification and no
   * count derives from it.
   */
  explanation: z.string().optional(),
} as const;

const HttpEvidenceSchema = z
  .object({
    ...evidenceCommon,
    kind: z.literal('http'),
    request: z
      .object({
        method: z.string().min(1),
        url: z.string().min(1),
        headers: z.record(z.string(), z.string()),
      })
      .strict(),
    response: z
      .object({
        status: z.number().int(),
        headers: z.record(z.string(), z.string()),
        body: BoundedTextSchema,
      })
      .strict(),
  })
  .strict();

const BrowserEvidenceSchema = z
  .object({
    ...evidenceCommon,
    kind: z.literal('browser'),
    url: z.string().min(1),
    trace: EvidenceRefSchema.optional(),
    screenshot: EvidenceRefSchema.optional(),
  })
  .strict();

const ObservationEvidenceSchema = z
  .object({
    ...evidenceCommon,
    kind: z.literal('observation'),
    observationId: z.string().min(1),
    snapshot: BoundedTextSchema,
  })
  .strict();

const CommandEvidenceSchema = z
  .object({
    ...evidenceCommon,
    kind: z.literal('command'),
    commandId: z.string().min(1),
    displayCommand: z.string(),
    exitCode: z.number().int().nullable(),
    stdout: BoundedTextSchema,
    stderr: BoundedTextSchema,
  })
  .strict();

const GateEvidenceSchema = z
  .object({
    ...evidenceCommon,
    kind: z.literal('gate'),
    gateId: z.string().min(1),
    // Mirrors GateEvidence.displayCommand, added to the domain type in the story 3.3
    // follow-up (owner-approved, requested by story 3.4). Required, like the domain
    // field: without it a stored run names the gate that failed but not the command that
    // produced the output, and a reader must recover the config as it was at that
    // revision. This schema is `.strict()`, so every gate evidence record would fail to
    // parse until the field was mirrored here.
    displayCommand: z.string(),
    status: GateStatusSchema,
    exitCode: z.number().int().nullable(),
    stdout: BoundedTextSchema,
    stderr: BoundedTextSchema,
  })
  .strict();

const ProviderEvidenceSchema = z
  .object({
    ...evidenceCommon,
    kind: z.literal('provider'),
    role: z.string().min(1),
    provider: z.string().min(1),
    attempts: z.number().int().positive(),
    rawResponse: BoundedTextSchema,
  })
  .strict();

/**
 * The closed union, discriminated on `kind`.
 *
 * `discriminatedUnion` rather than a plain union so an unknown `kind` produces "invalid
 * discriminator" naming the offending value, instead of six parallel shape-error reports
 * that between them say nothing useful.
 */
const EvidenceSchema = z.discriminatedUnion('kind', [
  HttpEvidenceSchema,
  BrowserEvidenceSchema,
  ObservationEvidenceSchema,
  CommandEvidenceSchema,
  GateEvidenceSchema,
  ProviderEvidenceSchema,
]);

// ---------------------------------------------------------------------------
// The run's own parts
// ---------------------------------------------------------------------------

/**
 * A product verdict OR an infrastructure error, never both (AD-6).
 *
 * The exclusivity protects the product's central promise: an infra failure is never
 * reported as a product FAIL. `.strict()` on both arms is what enforces it here — a
 * document carrying `verdict` and `infraError` together matches neither arm, exactly as
 * `infraError?: never` makes it a compile error in the domain type.
 */
const RunOutcomeSchema = z.union([
  z
    .object({
      verdict: VerdictSchema,
      /** The FAILING GATE'S ID, a string — never a boolean (ADR-003's prose is stale). */
      gateFailed: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      infraError: InfraErrorClassificationSchema,
    })
    .strict(),
]);

const StageTimelineEntrySchema = z
  .object({
    stage: z.enum(STAGE_NAMES),
    status: z.enum(STAGE_STATUSES),
    durationMs: z.number().int().nonnegative(),
    detail: z.string().optional(),
    // Mirrors StageTimelineEntry.hint (story 3.3 follow-up): the AD-7 remedy from the
    // error that ended the stage. This schema is `.strict()`, so without the mirror a run
    // that recorded a hint SERIALIZES but cannot be parsed back - meaning exactly the
    // error runs whose remedy was just preserved would be unreadable from storage.
    hint: z.string().optional(),
  })
  .strict();

const GateResultSchema = z
  .object({
    gateId: z.string().min(1),
    status: GateStatusSchema,
    durationMs: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * One attempt of a retried criterion (story 5.4, AD-9's "every attempt recorded").
 *
 * Present on the criterion below only when it took MORE THAN ONE attempt — see
 * `DerivedCriterionResult.attempts` for why a single attempt gets no record. The outcome
 * vocabulary is `ATTEMPT_OUTCOMES`, DERIVED from the domain rather than re-listed, exactly
 * as `schemas/enums.ts` derives every other closed vocabulary: an attempt is never
 * `skipped`, because a criterion can be skipped but an attempt that ran cannot.
 */
const CriterionAttemptSchema = z
  .object({
    attempt: z.number().int().positive(),
    // Which probe the attempt belongs to. A criterion may declare several probes and
    // reports one result, so records from more than one probe can share this array — see
    // `select` in `pipeline/stages/probes.ts`, and `CriterionAttemptRecord.probeId`.
    probeId: z.string().min(1).optional(),
    outcome: z.enum(ATTEMPT_OUTCOMES),
    durationMs: z.number().int().nonnegative(),
    expected: z.string().optional(),
    actual: z.string().optional(),
    evidence: z.array(EvidenceRefSchema).readonly().optional(),
  })
  .strict();

const CriterionResultSchema = z
  .object({
    criterionId: z.string().min(1),
    status: CriterionStatusSchema,
    flaky: z.boolean().optional(),
    statement: z.string().min(1),
    severity: SeveritySchema,
    expected: z.string().optional(),
    actual: z.string().optional(),
    // `.readonly()` so the inferred document type mirrors the domain's `readonly
    // EvidenceRef[]`. Without it the document type is structurally narrower than the model
    // it is built from, and `toRunResultDocument` would need a cast — which is exactly the
    // kind of cast that later hides a real mismatch.
    evidence: z.array(EvidenceRefSchema).readonly().optional(),
    attempts: z.array(CriterionAttemptSchema).readonly().optional(),
    // Story 5.3, ADDITIVE (AD-5). Both are present only on `needs_human` results.
    //
    // Declared here because this schema is `.strict()`: a field the domain carries but the
    // mirror does not would make exactly the runs that used the feature unreadable from
    // storage — serialized fine, refused on the way back. That is the shape the story 3.3
    // follow-up hit with the stage `hint` mirror a few lines above.
    //
    // `SCHEMA_VERSIONS.jsonReport` is deliberately NOT bumped for these. An added optional
    // key is the additive case `schemas/versions.ts` describes, every document written
    // before this change still parses (asserted in `tests/unit/schemas/result-guidance.test.ts`),
    // and the repo's own precedent is commit `ec23ce1`, which added the optional `hint` key
    // to a strict sub-schema of THIS document after story 3.5 registered the version, and
    // did not bump it either.
    needsHumanReason: NeedsHumanReasonSchema.optional(),
    // The same `BoundedTextSchema` evidence uses — not a second inline-content shape.
    // Guidance is redacted and bounded at derivation, so what reaches here is already
    // final: a reader prints `text` and appends `truncationMarker`, never re-redacting.
    reviewerGuidance: BoundedTextSchema.optional(),
  })
  .strict();

const ProviderUsageSchema = z
  .object({
    role: z.string().min(1),
    provider: z.string().min(1),
    durationMs: z.number().int().nonnegative(),
    attempts: z.number().int().positive(),
    model: z.string().nullable(),
    providerCliVersion: z.string().nullable(),
  })
  .strict();

/**
 * One non-authoritative root-cause hypothesis (story 5.5), mirroring
 * `domain/run-result.ts`'s `CriterionExplanation`.
 *
 * `.strict()` like every other member here, and `explanation` is a bare string rather than
 * a `BoundedText`: unlike 5.3's `reviewerGuidance` there is no full copy of a hypothesis on
 * disk to point a truncation marker at — the provider's answer is bounded at capture and
 * what is bounded IS the whole of it. A `BoundedText` would promise a `fullPath` that can
 * never exist.
 *
 * Nothing mechanical reads this field, here or anywhere else. It is not counted, not
 * aggregated, and not consulted by any status.
 */
const CriterionExplanationSchema = z
  .object({
    criterionId: z.string().min(1),
    explanation: z.string().min(1),
  })
  .strict();

const RunEnvironmentSchema = z
  .object({
    nodeVersion: z.string().min(1),
    platform: z.string().min(1),
    arch: z.string().min(1),
    specwitnessVersion: z.string().min(1),
    /**
     * ABSOLUTE by design, and deliberately NOT validated as run-relative.
     *
     * The one legitimately absolute path in a stored run. It is provenance rather than a
     * pointer — it records where the run executed, and that directory is normally gone by
     * the time anyone reads this. Making it relative would not make the document more
     * portable; it would make it wrong.
     */
    worktreePath: z.string().min(1).nullable(),
    /** Relative to the PROJECT root, not the run directory: `.specwitness/runs/<run-id>`. */
    runDirectory: z.string().min(1),
  })
  .strict();

const ContractSummarySchema = z
  .object({
    epic: z.string().min(1),
    version: z.number().int().positive(),
    /** Lowercase hex SHA-256 of the canonical spec. */
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex sha256'),
    frozenAt: IsoUtcTimestamp,
    amendments: z.number().int().nonnegative(),
    criterionCount: z.number().int().nonnegative(),
  })
  .strict();

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/**
 * FR-33's per-run retry/flake counts, as the persisted document carries them (story 5.4).
 *
 * **The `scorecard` command that reads these is Epic 7 and does not exist yet.** What
 * exists is the obligation that the numbers be IN the stored run, so Epic 7 can build a
 * scorecard out of stored evidence instead of re-running a verification to recount it.
 */
const FlakinessCountsSchema = z
  .object({
    flakyCriteria: z.number().int().nonnegative(),
    retriedCriteria: z.number().int().nonnegative(),
    extraAttempts: z.number().int().nonnegative(),
  })
  .strict();

/**
 * THE KEYS THE DOCUMENT ADDS TO THE MODEL — all of them, in one place.
 *
 * Until story 5.4 there was exactly one (`schemaVersion`), and three merged guards said so
 * in three different ways: this module's own comments, `toRunResult`'s "document minus
 * model = {schemaVersion}" reliance, and `tests/unit/schemas/result-mirror.type.test.ts`'s
 * compile-time `schemaVersionIsTheOnlyExtra`. Those guards did their job — they made this
 * a decision that had to be written down rather than one that could be slipped in.
 *
 * WHY `flakiness` JOINS IT. AC1 of story 5.4 requires flaky counts in the JSON, and
 * `domain/result-counts.ts` records the opposite-facing decision that counts are DERIVED
 * and never stored on `RunResult`, because "a persisted `{pass: 3}` next to four passing
 * criteria is a document that contradicts itself and no reader can tell which half is
 * right". Both hold at once only here: the value is derived by the shared
 * `summarizeFlakiness` from the very `criteria` array this same document carries, in the
 * same instant, so it cannot contradict its own file — and it never exists on the mutable
 * model at all, so no stage can let it drift.
 *
 * The exception is NAMED AND TYPED rather than implicit, which keeps the guards at full
 * strength instead of weakening them: the mirror test compares the document minus these
 * keys against the model in both directions, and `toRunResult` strips exactly these. A
 * fourth document-only key still cannot appear without editing this type and every guard
 * that reads it.
 */
export interface RunResultDocumentOnlyFields {
  readonly schemaVersion: number;
  /**
   * OPTIONAL on read, always written. A `result.json` stored before story 5.4 does not
   * carry it, and `.strict()` would refuse such a document if this key were required —
   * which is precisely the "a stored run from last week must stay readable" rule
   * `schemas/versions.ts` states, and the reason `SCHEMA_VERSIONS.jsonReport` does not
   * move for this change.
   */
  readonly flakiness?: z.infer<typeof FlakinessCountsSchema>;
}

/* -- the mechanics adaptation (story 5.6) ----------------------------------------------- */

/**
 * The mirror of `domain/adaptation.ts`.
 *
 * `.strict()` like everything else here: an unknown key means a newer writer added
 * something this build does not understand, and acting on a partial view of it would be
 * exactly the silent drift `RunResultDocumentSchema` fails closed against.
 *
 * `from` and `to` are `BoundedTextSchema` -- the SAME inline-content shape evidence and
 * 5.3's reviewer guidance use, not a second one. `to` is provider-authored text that was
 * applied to an executable artifact, so it is persisted through the one bounded, redacted
 * channel this file already has.
 */
const AppliedMechanicsChangeSchema = z
  .object({
    criterionId: z.string().min(1),
    probeId: z.string().min(1),
    field: z.enum(['path', 'scenario']),
    from: BoundedTextSchema,
    to: BoundedTextSchema,
  })
  .strict();

/**
 * AC1's run-level marker plus its audit record.
 *
 * `adapted` is a boolean rather than a `z.literal(true)` BECAUSE a refused proposal is
 * recorded here with `adapted: false`. Recording the refusal is what keeps a hostile
 * provider distinguishable from an absent one; making the marker a literal would force
 * that fact to be thrown away to keep the shape legal.
 */
const RunAdaptationSchema = z
  .object({
    adapted: z.boolean(),
    applied: z.array(AppliedMechanicsChangeSchema),
    /** Executed, then thrown away because the criterion did not improve. See the domain type. */
    discarded: z.array(AppliedMechanicsChangeSchema).optional(),
    refusal: BoundedTextSchema.optional(),
  })
  .strict()
  .refine((value) => !value.adapted || value.applied.length > 0, {
    message:
      "a run marked adapted must record what was applied -- an announced adaptation with no record is not auditable",
    path: ['applied'],
  });

/**
 * The persisted shape.
 *
 * `.strict()` for the same reason the manifest is: an unknown key means a newer writer
 * added something this build does not understand, and silently dropping it would let a
 * reader act on a partial view of a run it believes it has read completely. Fail closed
 * and say so.
 */
export const RunResultDocumentSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    runId: z.string().min(1),
    epic: z.string().min(1),
    baseSha: z.string().min(1),
    headSha: z.string().min(1),
    startedAt: IsoUtcTimestamp,
    finishedAt: IsoUtcTimestamp,
    outcome: RunOutcomeSchema,
    stages: z.array(StageTimelineEntrySchema),
    gates: z.array(GateResultSchema),
    criteria: z.array(CriterionResultSchema),
    /** Derived from `criteria` at serialization time; see `RunResultDocumentOnlyFields`. */
    flakiness: FlakinessCountsSchema.optional(),
    evidence: z.array(EvidenceSchema),
    providerUsage: z.array(ProviderUsageSchema),
    environment: RunEnvironmentSchema,
    contract: ContractSummarySchema.optional(),
    /**
     * Story 5.5, ADDITIVE (AD-5) — the non-authoritative hypotheses, when a run was
     * explicitly explained. Absent on every other run, which is every run by default.
     *
     * Declared here because this schema is `.strict()`: a field the domain carries but the
     * mirror does not would make exactly the runs that used the feature unreadable from
     * storage — serialized fine, refused on the way back. That is the shape the story 3.3
     * follow-up hit with the stage `hint` mirror, and story 5.3 hit again with
     * `reviewerGuidance`.
     *
     * `SCHEMA_VERSIONS.jsonReport` is deliberately NOT bumped: an added optional key is
     * the additive case `schemas/versions.ts` describes, and every document written before
     * this change still parses (asserted in `tests/unit/schemas/result-explanation.test.ts`).
     */
    explanations: z.array(CriterionExplanationSchema).readonly().optional(),
    /**
     * OPTIONAL on read, and ABSENT on any run that did not adapt (story 5.6).
     *
     * `SCHEMA_VERSIONS.jsonReport` does NOT move for this key, following `flakiness`
     * (5.4) and `needsHumanReason`/`reviewerGuidance` (5.3): a `result.json` stored
     * before 5.6 does not carry it, and `.strict()` would refuse such a document if this
     * key were required -- which is precisely the "a stored run from last week must stay
     * readable" rule `schemas/versions.ts` states.
     */
    adaptation: RunAdaptationSchema.optional(),
  })
  .strict();

export type RunResultDocument = z.infer<typeof RunResultDocumentSchema>;

/**
 * Turns the in-memory model into the persisted document.
 *
 * Adds exactly the keys `RunResultDocumentOnlyFields` names and NOTHING else — every other
 * value is copied through unchanged. Nothing here redacts, truncates or normalises a path:
 * redaction happens at capture (AD-10). A persistence layer that re-processed its input
 * would be a second place where the meaning of a run could change.
 *
 * `flakiness` is the one computed value, and it is computed rather than copied precisely
 * so that it cannot be stale: `domain/result-counts.ts` refuses to store a count beside
 * the array it counts, and deriving it here — from `result.criteria`, at the instant that
 * same array is written — is how the document carries the number without the model ever
 * holding a second source of truth. `summarizeFlakiness` is the SAME function
 * `report/terminal.ts` calls, so the human report and this file cannot disagree (AD-11).
 *
 * THE KEY ORDER OF THIS OBJECT LITERAL IS THE KEY ORDER OF THE FILE. `JSON.stringify`
 * preserves insertion order for string keys, which is what makes the byte sequence
 * deterministic without sorting. Reordering these lines changes every stored document and
 * breaks the snapshot test — the intended alarm, not an inconvenience.
 */
export function toRunResultDocument(result: RunResult): RunResultDocument {
  return {
    schemaVersion: RUN_RESULT_VERSION,
    runId: result.runId,
    epic: result.epic,
    baseSha: result.baseSha,
    headSha: result.headSha,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    outcome: result.outcome,
    stages: [...result.stages],
    gates: [...result.gates],
    criteria: [...result.criteria],
    flakiness: summarizeFlakiness(result.criteria),
    evidence: [...result.evidence],
    providerUsage: [...result.providerUsage],
    environment: result.environment,
    // Spread rather than `contract: result.contract`, so an absent contract leaves the
    // key out entirely instead of emitting `"contract": undefined` for JSON.stringify to
    // drop. Same bytes either way; this states the intent at the point it is decided.
    ...(result.contract === undefined ? {} : { contract: result.contract }),
    // LAST, and the position is the decision (story 5.5). Everything above this line is
    // mechanically derived from what the run observed; this is the one key that is not,
    // so it sits after all of it — the same reason the terminal report puts its block
    // furthest from the verdict. It is also the position that leaves every existing key's
    // byte offset untouched for a run that was not explained, which is every run by
    // default: `JSON.stringify` drops an `undefined`-valued key entirely, so an
    // unexplained run's document is byte-for-byte what it was before this story.
    ...(result.explanations === undefined ? {} : { explanations: result.explanations }),
    // Same spread, same reason (story 5.6). THIS KEY IS LAST ON PURPOSE: the key order of
    // this literal is the byte order of every stored document, so appending is the only
    // change that leaves existing runs' prefixes identical.
    ...(result.adaptation === undefined
      ? {}
      : {
          // `applied` is spread for the reason `criteria` and `gates` are: the model's
          // arrays are `readonly` and the document's are not. Copying here rather than
          // widening either type keeps the domain immutable where it should be.
          // Built explicitly rather than spread: the model's arrays are `readonly` and the
          // document's are not, so a spread would carry the readonly type through. Same
          // reason `criteria` and `gates` are copied above.
          adaptation: {
            adapted: result.adaptation.adapted,
            applied: [...result.adaptation.applied],
            ...(result.adaptation.discarded === undefined
              ? {}
              : { discarded: [...result.adaptation.discarded] }),
            ...(result.adaptation.refusal === undefined
              ? {}
              : { refusal: result.adaptation.refusal }),
          },
        }),
  };
}

/**
 * The exact inverse of `toRunResultDocument`: drops the document-only keys and nothing
 * else.
 *
 * It lives here, beside its inverse, rather than at each call site — for three reasons,
 * agreed with story 3.6 before either module was written. Nobody should have to discover
 * that dropping one key is all it takes; if the document ever grows a second non-model
 * key, exactly one place changes; and it keeps `RunResultDocument` out of `src/report/**`
 * entirely, so a renderer's signature stays `(result: RunResult) => string`.
 *
 * WHY A CAST IS SAFE HERE AND NOT A SHORTCUT. The document schema is derived from the
 * model field by field, and the keys the document adds are exactly those of
 * `RunResultDocumentOnlyFields`; `tests/unit/schemas/result-mirror.type.test.ts` checks
 * that at COMPILE time, in both directions, against that named type. So the two types
 * differ by exactly those keys, and removing them yields a `RunResult` by construction.
 * Adding a third document-only key means editing `RunResultDocumentOnlyFields`, and every
 * guard that reads it — including the destructure below — has to be revisited with it,
 * which is the point.
 *
 * `flakiness` is DROPPED rather than carried onto the model, deliberately: it is derived,
 * and a model that carried a count would be the second source of truth
 * `domain/result-counts.ts` refuses. A renderer handed the recovered model recomputes it
 * from `criteria` and gets the same three numbers.
 */
export function toRunResult(document: RunResultDocument): RunResult {
  const { schemaVersion: _version, flakiness: _flakiness, ...result } = document;
  return result as RunResult;
}

/**
 * THE serializer. The only `RunResult` → bytes function in the repository.
 *
 * `JSON.stringify` drops `undefined`-valued keys, which is the behaviour the optional
 * fields rely on: absent stays absent rather than becoming `null`.
 */
export function serializeRunResult(result: RunResult): string {
  return `${JSON.stringify(toRunResultDocument(result), null, 2)}\n`;
}

/**
 * Sub-trees of `result.json` whose CONTENT originated with a provider (AD-2).
 *
 * ⚠️ **AN UNKNOWN KEY IN HERE IS NOT A VERSION SKEW, AND SAYING IT IS WOULD WEAKEN A
 * SECURITY GUARD.** ADR-008's whole premise is that an unrecognised key means *a newer
 * SpecWitness wrote this document* — true for the envelope, which is where additive
 * evolution actually happens (story 5.5 added `explanations`, 5.6 added `adaptation`, 5.4
 * added `flakiness`). It is NOT true here. These sub-trees carry text a provider produced,
 * and an unexpected key inside one is the shape of a provider smuggling a field the schema
 * never granted it — `{criterionId, explanation, status}` being the worked example, where
 * `status` is a verdict-shaped field in a payload that AD-2 says is non-authoritative.
 * Telling an operator to *upgrade specwitness* in that situation sends them away from the
 * one document that recorded the attempt.
 *
 * ADR-008 already draws this line and simply did not notice it ran through `jsonReport`.
 * Its Context excludes `adaptation` from the ADR because it "is additionally a *provider
 * input* boundary, which this ADR deliberately does not touch — see Decision 4" — but
 * `jsonReport`, which the ADR does assign, CONTAINS provider-authored sub-objects. So the
 * carve-out is honoured here, at the reader, which is exactly where ADR-008 §2 puts this
 * kind of judgement: *"This is a property of the reader, not of the schema."*
 *
 * The effect is to make the new branch NARROWER than the ADR's literal text, never wider.
 * Anything excluded here keeps the pre-existing malformed-document behaviour, which is the
 * fail-closed direction — and `tests/unit/schemas/result-explanation.test.ts` ("rejects a
 * document whose explanation carries an unknown key") is the merged guard that proves it
 * still holds, unchanged by this story.
 */
const PROVIDER_AUTHORED_PAYLOADS = ['explanations', 'adaptation'] as const;

/**
 * Whether any unrecognised key sits inside a provider-authored payload.
 *
 * Matches on the path PREFIX, so `explanations.0.status` is caught while a root-level key
 * that merely begins with the same letters is not. A bare match on the payload name itself
 * cannot occur — those keys are declared, so they are never "unrecognised" — but it is
 * included so the predicate reads as "at or under", which is what it means.
 */
function touchesProviderAuthoredPayload(unknownKeys: readonly string[]): boolean {
  return unknownKeys.some((key) =>
    PROVIDER_AUTHORED_PAYLOADS.some(
      (payload) => key === payload || key.startsWith(`${payload}.`),
    ),
  );
}

/**
 * Parses a stored document, applying the version policy.
 *
 * Always throws `InfraError` naming `path` — never returns undefined and never throws
 * bare. A corrupt or unreadable result is an environment problem (exit 3), never a product
 * FAIL: the run it describes may well have been a clean PASS, and reporting exit 1 because
 * the FILE is broken is exactly the confusion the exit table exists to prevent.
 */
export function parseRunResult(text: string, path: string): RunResultDocument {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new InfraError(
      `stored run result is not valid JSON: ${path}`,
      'the file is corrupt; the run it describes cannot be re-rendered, but its evidence files are still on disk beside it',
    );
  }

  // The version is read BEFORE the full parse, so a document written by a newer
  // SpecWitness produces "upgrade specwitness" rather than a confusing list of shape errors
  // caused by fields this build has never heard of. The mismatch policy lives here, with
  // the artifact, because what a mismatch MEANS is artifact-specific — see the note in
  // `schemas/versions.ts` on why no shared assert helper exists.
  if (typeof json === 'object' && json !== null && 'schemaVersion' in json) {
    const version = (json as { schemaVersion: unknown }).schemaVersion;
    if (typeof version === 'number' && version > RUN_RESULT_VERSION) {
      throw new InfraError(
        `stored run result at ${path} was written by a newer specwitness (schemaVersion ${version}, this build understands ${RUN_RESULT_VERSION})`,
        'upgrade specwitness to read this run; do not delete it',
      );
    }
  }

  const result = RunResultDocumentSchema.safeParse(json);
  if (!result.success) {
    // ADR-008: an unknown key is a VERSION SKEW, not corruption. Strictness stays — it is
    // what catches a typo'd key and a half-written file — but when the ONLY thing wrong is
    // fields this build has never heard of, the honest diagnosis is that a newer
    // SpecWitness wrote this document, not that the document is broken.
    //
    // `unknownKeysOnly` returns `null` the moment any other issue is present, so a
    // document that is BOTH newer AND corrupt keeps the malformed message below. That
    // direction is the one with teeth: telling an operator to upgrade would send them away
    // from a file that is genuinely broken, and upgrading would not fix it.
    //
    // ⚠️ `InfraError`, NEVER `IntegrityError` (ADR-008 §1). `IntegrityError` means
    // tampering and must keep meaning only that, or an ordinary upgrade becomes
    // indistinguishable from an attack.
    const unknown = unknownKeysOnly(result.error);
    if (unknown !== null && !touchesProviderAuthoredPayload(unknown)) {
      throw new InfraError(
        `this stored run result was written by a newer SpecWitness than the one reading it: ${path}`,
        `unknown field(s): ${unknown.join(', ')}. Upgrade specwitness, or read this run with the version that wrote it`,
      );
    }

    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new InfraError(
      `stored run result is malformed: ${path} (${detail})`,
      'the file does not match the expected result shape; it may have been edited by hand or written by a different tool',
    );
  }

  return result.data;
}
