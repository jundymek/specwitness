/**
 * The Verification Contract document (AD-5, FR-8, FR-9).
 *
 * `.specwitness/contracts/<epic>.yaml` is the sole authority on WHAT must be
 * true for an epic. This module owns three things and nothing else:
 *
 *   - the strict, versioned zod schema for the two-key document;
 *   - the text <-> model conversion (`parseContract` / `serializeContract`);
 *   - the pure freeze and integrity primitives (`freeze`, `verifyIntegrity`,
 *     `isFrozen`, `contractState`).
 *
 * Everything here is PURE. No filesystem, no clock, no randomness, no
 * subprocess: `parseContract` takes a string and `freeze` takes the instant as
 * an argument (AD-9 — the `Clock` port is injected by the caller at the edge).
 * Reading and writing the file is story 2.6's job at the CLI edge, and keeping
 * that out of here is what makes freeze exhaustively testable and stops any
 * future story from making it depend on the environment.
 *
 * WHY `freeze`/`verifyIntegrity` live beside the schema rather than in
 * `src/authoring/`: they are pure transformations over the model, and
 * `src/authoring/` is the application layer that stories 2.6 and 2.7 own.
 * Splitting the freeze primitives across both layers would have put two
 * agents in one file for no gain.
 *
 * THE PARSE/INTEGRITY SPLIT, which is load-bearing for both consumers:
 * `parseContract` is STRUCTURAL ONLY. It never compares fingerprints, so a
 * tampered file parses cleanly and story 2.6's `contract --status` can report
 * `integrity: mismatch` as a field instead of crashing — and story 2.7's
 * `--amend` can read a tampered contract far enough to refuse it *while naming
 * the version and fingerprint it refused*. Integrity is asked separately, via
 * `contractState` (never throws) or `verifyIntegrity` (throws).
 *
 * The one exception is a document that is internally contradictory — frozen
 * with no fingerprint, or unfrozen carrying one. That is what hand-deleting the
 * fingerprint line produces, and accepting it as a plain draft would launder a
 * tamper into a legitimate-looking redraft, so it raises `IntegrityError` at
 * parse time.
 *
 * AD-1: imports `src/domain/**`, its own siblings, zod and yaml. Both packages
 * are pure in-memory codecs; nothing here reaches out.
 */

import { parse as parseYaml, stringify as stringifyYaml, YAMLParseError } from 'yaml';
import { z } from 'zod';

import type {
  Contract,
  ContractHistoryEntry,
  ContractMeta,
  ContractProvenance,
  ContractSpec,
  Criterion,
} from '../domain/contract.js';
import { ConfigError, IntegrityError } from '../domain/errors.js';
import { isCriterionId, normalizeEpicId, parseCriterionId } from '../domain/ids.js';
import { canonicalize, fingerprint } from './canonical.js';
import { KindSchema, SeveritySchema, VerifiabilitySchema } from './enums.js';
import { schemaVersionFor } from './versions.js';

/** Current contract schema version, from the AD-5 registry. */
export const CONTRACT_SCHEMA_VERSION = schemaVersionFor('contract');

const ISO_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

/**
 * True only for a timestamp naming a date that actually exists.
 *
 * The same discipline as `schemas/manifest.ts`, for the same reason:
 * `Date.parse` accepts `2026-02-31T…` and silently normalises it to 3 March, so
 * a hand-edited contract would be accepted while claiming an instant it does
 * not mean. Round-tripping the components back out of the parsed `Date` is what
 * rejects those.
 */
function isRealUtcInstant(value: string): boolean {
  const m = ISO_UTC_PATTERN.exec(value);
  if (m === null) {
    return false;
  }
  const [, year = '', month = '', day = '', hour = '', minute = '', second = '', ms = ''] = m;

  const date = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Number(ms),
    ),
  );
  if (Number.isNaN(date.getTime())) {
    return false;
  }

  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day) &&
    date.getUTCHours() === Number(hour) &&
    date.getUTCMinutes() === Number(minute) &&
    date.getUTCSeconds() === Number(second) &&
    date.getUTCMilliseconds() === Number(ms)
  );
}

/** ISO-8601 UTC, milliseconds, `Z`-terminated — the house timestamp format. */
const IsoUtcTimestamp = z
  .string()
  .refine((value) => ISO_UTC_PATTERN.test(value), {
    message: 'must be an ISO-8601 UTC timestamp ending in Z',
  })
  .refine(isRealUtcInstant, { message: 'must name a date that exists' });

/** Lowercase hex SHA-256. Uppercase is rejected: one spelling, or two files compare unequal. */
const Fingerprint = z
  .string()
  .regex(/^[0-9a-f]{64}$/, { message: 'must be 64 lowercase hexadecimal characters' });

/**
 * A criterion.
 *
 * The id refinement delegates to `domain/ids.ts` rather than restating the
 * pattern: a second regex is a second answer to what a canonical id is, and
 * `E07-1` resolving differently in two places is the bug that costs a day.
 */
export const CriterionSchema = z
  .object({
    id: z
      .string()
      .refine(isCriterionId, { message: "must be a canonical criterion id, e.g. 'E7-01'" }),
    // No max length and no coupling lint. FR-7 offers "rejected by schema-level
    // lint OR flagged for review" and epics.md story 2.6 AC1 chooses flagging:
    // a `structural` criterion may legitimately name a module, and a schema
    // that rejected it would make that criterion unwritable.
    //
    // Emptiness is checked on the TRIMMED length while the value is stored
    // untrimmed. `min(1)` alone accepts "   ", which `canonicalize` then trims
    // to "" — so the criterion is FINGERPRINTED as `"statement":""`,
    // byte-identical to the empty statement rejected on this same line, and
    // frozen as authoritative. A criterion that asserts nothing can never fail:
    // a green result that means nothing, which is the outcome this product
    // exists to make impossible. Trimming itself stays a canonicalization
    // concern, so the model keeps the original text and serialization stays
    // lossless.
    statement: z.string().refine((value) => value.trim().length > 0, {
      message: 'must not be empty or only whitespace',
    }),
    kind: KindSchema,
    severity: SeveritySchema,
    verifiability: VerifiabilitySchema,
  })
  .strict();

/**
 * True when `value` is ALREADY the canonical epic id, e.g. `epic-7`.
 *
 * `normalizeEpicId` is the only normalizer (spine Identifiers row), so
 * canonicality is defined as "normalizing it changes nothing" rather than by a
 * second pattern here. It throws `UsageError` on input it cannot read at all,
 * which for a persisted file is simply "not canonical".
 */
function isCanonicalEpicId(value: string): boolean {
  try {
    return normalizeEpicId(value) === value;
  } catch {
    return false;
  }
}

/** The fingerprinted half. */
export const ContractSpecSchema = z
  .object({
    // Canonical form only. `epic-07`, `7` and `EPIC-7` all *mean* epic-7, but a
    // contract persisting one of those would disagree with the CLI's normalized
    // id and with its own file path — and, living in `spec`, the discrepancy
    // would be frozen and fingerprinted.
    epic: z.string().refine(isCanonicalEpicId, {
      message: "must be a canonical epic id, e.g. 'epic-7' (not 'epic-07' or '7')",
    }),
    // Integer, so `1` vs `1.0` vs `1e0` can never become a canonicalization
    // question: they all parse to the same JS number and only integers are
    // accepted, so the canonical JSON of a version is unambiguous.
    version: z.number().int().positive(),
    // Order is meaningful and preserved. An empty list is schema-valid on
    // purpose — story 2.6 refuses to *write* one (an empty contract would
    // silently pass every verify run), but the amend flow must be able to read
    // a contract mid-edit, and a shape error is the wrong way to say that.
    criteria: z.array(CriterionSchema),
  })
  .strict()
  .superRefine((spec, ctx) => {
    // Two cross-field rules that no per-criterion schema can express, and that
    // both matter because a criterion id is an IDENTITY: plans reference
    // criteria by id only and never embed statements (AD-5), and reports key
    // results on the same id.
    const seen = new Map<string, number>();

    spec.criteria.forEach((criterion, index) => {
      // 1. Uniqueness. Two criteria answering to `E7-01` make a plan reference
      //    ambiguous — a probe could be compiled against one expectation and
      //    its result reported against the other, leaving the second
      //    expectation silently unverified. Frozen, that ambiguity becomes
      //    authoritative.
      const first = seen.get(criterion.id);
      if (first !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['criteria', index, 'id'],
          message: `duplicate criterion id '${criterion.id}' (already used at criteria[${first}]); ids identify a criterion and must be unique within a contract`,
        });
      } else {
        seen.set(criterion.id, index);
      }

      // 2. The id's epic component must be THIS contract's epic. `E8-01` inside
      //    an epic-7 contract is a criterion copy-pasted from another contract;
      //    since the epic number is embedded in the identifier that plans and
      //    reports key on, freezing it would make the wrong epic's expectation
      //    authoritative here.
      try {
        const { epicNumber } = parseCriterionId(criterion.id);
        if (normalizeEpicId(String(epicNumber)) !== spec.epic) {
          ctx.addIssue({
            code: 'custom',
            path: ['criteria', index, 'id'],
            message: `criterion id '${criterion.id}' belongs to a different epic than '${spec.epic}'`,
          });
        }
      } catch {
        // Malformed ids are already reported by `CriterionSchema`'s refinement;
        // reporting them twice would only make the message harder to read.
      }
    });
  });

/** Generation provenance. Absence is an explicit `null`, never a missing key. */
export const ContractProvenanceSchema = z
  .object({
    provider: z.string().min(1).nullable(),
    model: z.string().min(1).nullable(),
    /**
     * The AGENT CLI's version (`codex --version`, `claude --version`) — AD-5's
     * "CLI version", read alongside "model as reported by the CLI". Not the
     * SpecWitness build version: this block answers "what generated this
     * draft", and the artifact format is already pinned by `schemaVersion`.
     */
    providerCliVersion: z.string().min(1).nullable(),
    generatedAt: IsoUtcTimestamp.nullable(),
  })
  .strict();

/**
 * One superseded version (story 2.7 populates it).
 *
 * Exactly four fields. There is deliberately no `author`: V0 has no identity
 * system, and a name read from the environment would be an attestation with no
 * attester behind it — a field that looks like identity but is not is what a
 * later reader trusts by accident. Authorship is attested by git history; these
 * files are committed (architecture question Q11).
 */
export const ContractHistoryEntrySchema = z
  .object({
    version: z.number().int().positive(),
    fingerprint: Fingerprint,
    timestamp: IsoUtcTimestamp,
    reason: z.string().min(1),
  })
  .strict();

/** The never-fingerprinted half. */
export const ContractMetaSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    frozen: z.boolean(),
    fingerprint: Fingerprint.nullable(),
    createdAt: IsoUtcTimestamp,
    frozenAt: IsoUtcTimestamp.nullable(),
    provenance: ContractProvenanceSchema,
    history: z.array(ContractHistoryEntrySchema),
  })
  .strict();

/**
 * The whole document: exactly two top-level keys.
 *
 * `.strict()` at every level, and that is not pedantry. An unknown key in a
 * FINGERPRINTED document is a silent expectation change: dropping it on read
 * would mean the file a human reviewed and the value being hashed are not the
 * same thing. Fail closed and name the path.
 */
export const ContractSchema = z
  .object({
    spec: ContractSpecSchema,
    meta: ContractMetaSchema,
  })
  .strict()
  .superRefine((contract, ctx) => {
    // FR-10 makes `meta.history` the auditable record of which version
    // superseded which. Story 2.7's amend flow writes it and a future reader
    // trusts it, so a chain that contradicts `spec.version` misrepresents the
    // audit trail inside a document that reads as authoritative — an incoherent
    // trail is worse than an absent one, precisely because it looks like
    // evidence.
    //
    // The check lives on the document rather than on `ContractMetaSchema`
    // because it needs `spec.version`, which meta cannot see.
    //
    // Contiguity is deliberately NOT required. Story 2.7 appends exactly one
    // entry per amendment, so its output is contiguous anyway; demanding
    // [1..V-1] would reject a legitimate contract whose earlier versions
    // predate this file, and would assert nothing the ordering rule does not.
    let previous = 0;

    contract.meta.history.forEach((entry, index) => {
      if (entry.version >= contract.spec.version) {
        ctx.addIssue({
          code: 'custom',
          path: ['meta', 'history', index, 'version'],
          message: `superseded version ${entry.version} is not below the contract version ${contract.spec.version}`,
        });
      }
      if (entry.version <= previous) {
        ctx.addIssue({
          code: 'custom',
          path: ['meta', 'history', index, 'version'],
          message: `history must ascend: version ${entry.version} follows ${previous}`,
        });
      }
      previous = entry.version;
    });
  });

/** Human-readable rendering of a zod failure: `spec.criteria.0.owner: message`. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

/**
 * Reads `meta.schemaVersion` without validating anything else.
 *
 * The `schemas/manifest.ts` policy: a file from the future must produce
 * "upgrade specwitness" rather than a confusing list of shape errors caused by
 * fields this build has never heard of. That means reading the version BEFORE
 * the full parse, defensively, from an `unknown`.
 */
function readSchemaVersion(document: unknown): number | undefined {
  if (typeof document !== 'object' || document === null || !('meta' in document)) {
    return undefined;
  }
  const meta = (document as { meta: unknown }).meta;
  if (typeof meta !== 'object' || meta === null || !('schemaVersion' in meta)) {
    return undefined;
  }
  const version = (meta as { schemaVersion: unknown }).schemaVersion;
  return typeof version === 'number' ? version : undefined;
}

/**
 * `frozen`, `fingerprint` and `frozenAt` record ONE fact, so they must agree.
 *
 * A document where they were edited independently claims a state it cannot
 * substantiate — a contract marked frozen with the fingerprint line deleted, or
 * a draft still carrying the hash of the version it was cut from. Neither is a
 * shape error, which is why this raises `IntegrityError` rather than
 * `ConfigError`: the file is well-formed and dishonest, and silently reading it
 * as an ordinary draft would launder a tamper into a legitimate-looking redraft.
 *
 * Shared by `parseContract` and `freeze` deliberately. `freeze` takes an
 * in-memory `Contract` whose type still permits these combinations, and two
 * functions in one module must not disagree about what a valid contract is: a
 * primitive that can EMIT a document its sibling parser refuses is the same
 * class of defect as a parser that accepts one. `tests/unit/contract/
 * freeze.test.ts` asserts the two agree across every combination.
 *
 * `subject` names the thing being rejected — a path when the caller has one, the
 * epic id when it does not — because a refusal that cannot say what it refused
 * is not much of an audit trail.
 */
function assertLifecycleConsistent(meta: ContractMeta, subject: string): void {
  if (meta.frozen && meta.fingerprint === null) {
    throw new IntegrityError(
      `${subject} is marked frozen but carries no fingerprint`,
      'the fingerprint line appears to have been removed; restore it with `git checkout` or re-freeze from a known-good version, then re-run',
    );
  }
  if (!meta.frozen && meta.fingerprint !== null) {
    throw new IntegrityError(
      `${subject} carries a fingerprint but is not marked frozen`,
      'this is a half-edited frozen contract; restore it with `git checkout`, or clear `meta.fingerprint` and `meta.frozenAt` to make it an honest draft',
    );
  }
  if (meta.frozen && meta.frozenAt === null) {
    throw new IntegrityError(
      `${subject} is marked frozen but records no frozenAt timestamp`,
      'restore the file with `git checkout`, or re-freeze it so the frozen flag, fingerprint and timestamp agree',
    );
  }
  if (!meta.frozen && meta.frozenAt !== null) {
    throw new IntegrityError(
      `${subject} records a frozenAt timestamp but is not marked frozen`,
      'restore the file with `git checkout`, or clear `meta.frozenAt` to make it an honest draft',
    );
  }
}

/**
 * Parses contract YAML into the model. Structural validation only.
 *
 * Throws `ConfigError` (exit 3) for anything malformed, always naming `path`,
 * because the operator is looking at a file rather than at an in-memory value.
 * Throws `IntegrityError` only for the internally contradictory frozen state.
 * It never compares fingerprints — see the module header.
 */
export function parseContract(text: string, path: string): Contract {
  let document: unknown;
  try {
    document = parseYaml(text, {
      // Already the default in yaml 2.x; passed explicitly because silently
      // taking the last of two `version:` keys would mean the file a human
      // reviewed is not the file that got hashed. `src/config/load.ts` does the
      // same for the same reason.
      uniqueKeys: true,
    });
  } catch (cause) {
    const detail = cause instanceof YAMLParseError ? `: ${cause.message}` : '';
    throw new ConfigError(
      `contract is not valid YAML: ${path}${detail}`,
      'fix the YAML syntax; `git diff` on the contract file usually shows what changed',
    );
  }

  if (document === null || document === undefined) {
    throw new ConfigError(
      `contract is empty: ${path}`,
      "a contract has exactly two top-level keys, `spec` and `meta`; run `specwitness contract <epic>` to generate one",
    );
  }

  const version = readSchemaVersion(document);
  if (version !== undefined && version > CONTRACT_SCHEMA_VERSION) {
    // The ERROR line itself says a newer specwitness wrote it — that is the
    // *what*, not the remedy, so it does not belong in the HINT alone.
    throw new ConfigError(
      `contract at ${path} was written by a newer specwitness (schemaVersion ${version}, this build understands ${CONTRACT_SCHEMA_VERSION})`,
      'upgrade specwitness to read this contract; do not edit it by hand to fit an older build',
    );
  }

  const result = ContractSchema.safeParse(document);
  if (!result.success) {
    throw new ConfigError(
      `contract is malformed: ${path} (${describeIssues(result.error)})`,
      'a contract has exactly two top-level keys, `spec` and `meta`; an unknown key is never ignored, because a dropped key in a fingerprinted document is a silent change of expectation',
    );
  }

  const contract = result.data;
  assertLifecycleConsistent(contract.meta, `contract at ${path}`);

  return contract;
}

/**
 * Renders a contract as human-readable YAML.
 *
 * Key order is DECLARED rather than alphabetical: `spec` before `meta` so a
 * reviewer reads the content before the bookkeeping, and within a criterion
 * `id` then `statement` then the classification. The file is reviewed in a pull
 * request by a person (FR-8), so readability is the requirement — canonical
 * ordering is `canonicalize`'s job and applies to the hash, not to the file.
 *
 * The output is stable: serializing a parsed contract reproduces the same bytes,
 * so a cosmetically reformatted file normalises to one canonical rendering.
 */
export function serializeContract(contract: Contract): string {
  const ordered = {
    spec: {
      epic: contract.spec.epic,
      version: contract.spec.version,
      criteria: contract.spec.criteria.map((criterion: Criterion) => ({
        id: criterion.id,
        statement: criterion.statement,
        kind: criterion.kind,
        severity: criterion.severity,
        verifiability: criterion.verifiability,
      })),
    },
    meta: {
      schemaVersion: contract.meta.schemaVersion,
      frozen: contract.meta.frozen,
      fingerprint: contract.meta.fingerprint,
      createdAt: contract.meta.createdAt,
      frozenAt: contract.meta.frozenAt,
      provenance: {
        provider: contract.meta.provenance.provider,
        model: contract.meta.provenance.model,
        providerCliVersion: contract.meta.provenance.providerCliVersion,
        generatedAt: contract.meta.provenance.generatedAt,
      },
      history: contract.meta.history.map((entry: ContractHistoryEntry) => ({
        version: entry.version,
        fingerprint: entry.fingerprint,
        timestamp: entry.timestamp,
        reason: entry.reason,
      })),
    },
  };

  return stringifyYaml(ordered, {
    // No line folding. A folded long statement is still the same string after a
    // round trip, but it is much harder for a human to review a criterion whose
    // sentence has been rewrapped by a tool.
    lineWidth: 0,
    // `null`, not `~` or an empty value: an absent provenance value must read
    // as a recorded absence, and `model:` with nothing after it does not.
    nullStr: 'null',
  });
}

/**
 * Is this contract frozen at all?
 *
 * Reports the FLAG, not the integrity — a tampered contract is frozen and does
 * not match. Story 2.6 needs the two questions separately, or `--status` could
 * not tell an operator which of the two problems they have. Never throws.
 */
export function isFrozen(contract: Contract): boolean {
  return contract.meta.frozen;
}

/** The three states a parsed contract can be in. */
export type ContractState = 'draft' | 'frozen' | 'tampered';

/**
 * The integrity question in non-throwing form.
 *
 * This is what `contract --status --json` renders as a field and what story
 * 2.7's `--amend` gate switches on. Both consumers were built against it
 * deliberately, so that `--status`, `--amend` and Epic 3's `verify` all ask an
 * identical question rather than three slightly different ones.
 *
 * `parseContract` has already rejected the contradictory states, so a `frozen`
 * contract here always has a fingerprint to compare against.
 */
export function contractState(contract: Contract): ContractState {
  if (!contract.meta.frozen || contract.meta.fingerprint === null) {
    return 'draft';
  }
  return fingerprint(contract.spec) === contract.meta.fingerprint ? 'frozen' : 'tampered';
}

/**
 * A contract that was never frozen.
 *
 * A REFINEMENT of `IntegrityError`, not a seventh AD-7 class: `instanceof
 * IntegrityError` still classifies it, so it maps to exit 3 through
 * `cli/exit.ts` with no new branch there. It exists because story 2.6's verify
 * guard must distinguish "run --freeze first" from "someone edited this" — two
 * problems with two different remedies.
 */
export class ContractNotFrozenError extends IntegrityError {
  constructor(message: string, hint?: string) {
    super(message, hint);
  }
}

/**
 * Validates a frozen contract's content against its stored fingerprint (FR-9).
 *
 * Throws `ContractNotFrozenError` when the contract was never frozen, and
 * `IntegrityError` when the content no longer matches. An integrity failure is
 * neither PASS nor FAIL: it is an infrastructure-class outcome, exit 3 (Golden
 * Corpus fixture 9 semantics).
 *
 * There is no override parameter and there will not be one. Freeze is
 * tamper-EVIDENT, not tamper-proof (ADR-005) — but an escape hatch would make
 * the evidence worthless, because the first agent to hit an integrity error
 * would find it.
 */
export function verifyIntegrity(contract: Contract): void {
  if (!contract.meta.frozen || contract.meta.fingerprint === null) {
    throw new ContractNotFrozenError(
      `contract for ${contract.spec.epic} is not frozen`,
      'review the draft and run `specwitness contract <epic> --freeze`; only a frozen contract can gate verification',
    );
  }

  const actual = fingerprint(contract.spec);
  if (actual !== contract.meta.fingerprint) {
    throw new IntegrityError(
      `contract integrity error for ${contract.spec.epic}: content does not match the frozen fingerprint (stored ${contract.meta.fingerprint}, actual ${actual})`,
      'inspect the change with `git diff` on the contract file; if the change is legitimate, record it through `specwitness contract <epic> --amend` rather than editing a frozen contract',
    );
  }
}

/**
 * Freezes a contract: records its fingerprint and marks it authoritative.
 *
 * Pure, and the instant is an argument — `freeze` never calls `new Date()`
 * (AD-9). Returns a new value; the input is not mutated.
 *
 * IDEMPOTENT (FR-8): freezing an already-frozen contract whose content still
 * matches returns it unchanged — same fingerprint, same `frozenAt`, version not
 * bumped — so story 2.6's `--freeze` run twice does not rewrite the file or
 * churn git history.
 *
 * Freezing a frozen contract whose `spec` has CHANGED throws `IntegrityError`.
 * That is not a re-freeze; it is either tampering or a legitimate amendment,
 * and the amendment has its own audited flow (story 2.7, ADR-005). Silently
 * re-fingerprinting here would be exactly the silent redefinition the product
 * exists to prevent.
 *
 * Freezing works identically on a draft carrying a non-empty `meta.history` —
 * the normal output of an amendment. History is preserved in order and never
 * inspected: `freeze` has no special case for it, which is what lets the amend
 * flow end here.
 */
export function freeze(contract: Contract, at: Date): Contract {
  // Before anything else: refuse a contract whose lifecycle fields contradict
  // each other. Without this, the idempotent return below would hand back a
  // frozen contract with no `frozenAt` — a value that serializes into a file
  // `parseContract` then rejects — and the freezing branch would silently
  // overwrite a stale fingerprint on a draft, laundering a half-edited frozen
  // contract into a clean freeze.
  assertLifecycleConsistent(contract.meta, `contract for ${contract.spec.epic}`);

  const actual = fingerprint(contract.spec);

  if (contract.meta.frozen && contract.meta.fingerprint !== null) {
    if (contract.meta.fingerprint === actual) {
      return contract;
    }
    throw new IntegrityError(
      `cannot re-freeze ${contract.spec.epic}: its content changed after it was frozen (stored ${contract.meta.fingerprint}, actual ${actual})`,
      'inspect the change with `git diff` on the contract file; if the change is legitimate, record it through `specwitness contract <epic> --amend`',
    );
  }

  const meta: ContractMeta = {
    ...contract.meta,
    frozen: true,
    fingerprint: actual,
    frozenAt: at.toISOString(),
  };

  return { spec: contract.spec, meta };
}

/**
 * The canonical JSON a fingerprint was computed over.
 *
 * Re-exported here so a consumer diagnosing a mismatch can print both sides and
 * diff them without reaching past this module for the hashing internals.
 */
export { canonicalize, fingerprint };

export type { Contract, ContractMeta, ContractProvenance, ContractSpec, Criterion };
