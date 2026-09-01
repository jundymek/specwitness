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
 *     alphabetical. `schemaVersion` first; `contract` last.
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

import { InfraError } from '../domain/errors.js';
import { EVIDENCE_KINDS } from '../domain/evidence.js';
import type { RunResult } from '../domain/run-result.js';
import { STAGE_NAMES, STAGE_STATUSES } from '../domain/stage.js';
import {
  CriterionStatusSchema,
  GateStatusSchema,
  InfraErrorClassificationSchema,
  SeveritySchema,
  VerdictSchema,
} from './enums.js';
import { IsoUtcTimestamp } from './manifest.js';
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
  })
  .strict();

const GateResultSchema = z
  .object({
    gateId: z.string().min(1),
    status: GateStatusSchema,
    durationMs: z.number().int().nonnegative().optional(),
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
    evidence: z.array(EvidenceSchema),
    providerUsage: z.array(ProviderUsageSchema),
    environment: RunEnvironmentSchema,
    contract: ContractSummarySchema.optional(),
  })
  .strict();

export type RunResultDocument = z.infer<typeof RunResultDocumentSchema>;

/**
 * Turns the in-memory model into the persisted document.
 *
 * Adds `schemaVersion` and NOTHING else — every other value is copied through unchanged.
 * Nothing here redacts, truncates, normalises a path or recomputes a count: redaction
 * happens at capture (AD-10) and counts are derived by `domain/result-counts.ts`. A
 * persistence layer that re-processed its input would be a second place where the meaning
 * of a run could change.
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
    evidence: [...result.evidence],
    providerUsage: [...result.providerUsage],
    environment: result.environment,
    // Spread rather than `contract: result.contract`, so an absent contract leaves the
    // key out entirely instead of emitting `"contract": undefined` for JSON.stringify to
    // drop. Same bytes either way; this states the intent at the point it is decided.
    ...(result.contract === undefined ? {} : { contract: result.contract }),
  };
}

/**
 * The exact inverse of `toRunResultDocument`: drops `schemaVersion` and nothing else.
 *
 * It lives here, beside its inverse, rather than at each call site — for three reasons,
 * agreed with story 3.6 before either module was written. Nobody should have to discover
 * that dropping one key is all it takes; if the document ever grows a second non-model
 * key, exactly one place changes; and it keeps `RunResultDocument` out of `src/report/**`
 * entirely, so a renderer's signature stays `(result: RunResult) => string`.
 *
 * WHY A CAST IS SAFE HERE AND NOT A SHORTCUT. The document schema is derived from the
 * model field by field, and the ONLY key the document adds is `schemaVersion`; the
 * compiler checks that in `toRunResultDocument`, which builds a `RunResultDocument` out of
 * a `RunResult` without a cast. So the two types differ by exactly that key, and removing
 * it yields a `RunResult` by construction. If a future edit adds a second document-only
 * key, `toRunResultDocument` stops compiling first — which is the point.
 */
export function toRunResult(document: RunResultDocument): RunResult {
  const { schemaVersion: _version, ...result } = document;
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
