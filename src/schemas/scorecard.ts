/**
 * The dogfooding scorecard record — FR-33, NFR-4, brief §54, ADR-008 §5 (story 6.5).
 *
 * ============================================================================
 * LOCAL ONLY. THIS IS A PRODUCT RULE, NOT AN OVERSIGHT.
 * ============================================================================
 *
 * `.specwitness/scorecard.jsonl` is written to the operator's own disk and goes
 * NOWHERE ELSE. No HTTP client is imported here or in `src/infra/scorecard-store.ts`;
 * no telemetry endpoint, no "optional" remote sync, no upload behind a flag. That is
 * required by AC1 of this story and by a founding product rule (`CLAUDE.md`:
 * *"Local-first: no SaaS, no web UI, no cloud telemetry"*), and it is enforced
 * structurally by the `scorecard-is-local-only` rule in `.dependency-cruiser.cjs`
 * rather than by anybody remembering.
 *
 * **This is the one place in the product where a contributor might reasonably think
 * telemetry belongs**, which is precisely why the acceptance criterion forecloses it.
 * If you are here to add a "just send us anonymous counts" path: don't. Write an ADR.
 *
 * ============================================================================
 * WHAT THIS FILE IS FOR
 * ============================================================================
 *
 * The product hypothesis (brief §54, PRD SM-1) is that independent epic-level
 * verification finds real defects that already passed coding-agent tests, Codex review
 * and supervisor review. Nobody knows whether that is true. Epic 7 answers it by gating
 * real epics and measuring, over a window of roughly 30–50 tasks across weeks — and
 * **this file is the measurement**. Story 6.6's `scorecard summary` is the arithmetic
 * over it.
 *
 * That gives the record an unusual property: its defects are invisible until they have
 * already destroyed the thing they were measuring. A field 6.6 misreads produces a
 * north-star metric that is confidently wrong, and there is no test in Epic 7 that
 * catches it, because by then the only evidence is the file itself. **So every field
 * below documents its type, its meaning, and how 6.6 should compute over it.**
 *
 * ============================================================================
 * IT IS A PROJECTION, NEVER A SECOND SOURCE OF TRUTH (AD-11)
 * ============================================================================
 *
 * Every number here is derived from the SAME `RunResult` that becomes `result.json`,
 * through the SAME shared derivations (`countCriterionStatuses`, `countGateStatuses`,
 * `summarizeFlakiness` in `src/domain/result-counts.ts`). Nothing is recounted, and
 * `aggregate()` is never re-implemented — the outcome is read, not decided. Where the
 * scorecard and `result.json` could ever disagree, **`result.json` wins**, and the
 * scorecard is the one to be fixed.
 *
 * ============================================================================
 * NO FREE TEXT, AND THEREFORE NO LEAK (AD-10)
 * ============================================================================
 *
 * A scorecard is the file most likely to leave this machine — pasted into an issue,
 * attached to a report, shared to argue a point. So it carries counts, enums,
 * timestamps and structurally-constrained identifiers, and NOT: command output,
 * provider prose, evidence text, error messages, hints, paths, SHAs, or a reviewer's
 * guidance. Every string that does land here is bounded and redacted through
 * `boundedText` anyway, so the guarantee is a property of the code rather than of the
 * fields happening to be safe today.
 *
 * That is also what bounds the LINE SIZE, which is what makes the append safe under
 * concurrency — see `src/infra/scorecard-store.ts` for the guarantee and its limits.
 *
 * AD-1: `src/schemas/**` may import `src/domain/**`, its own siblings and zod. Nothing
 * else — and in this module, deliberately, rather less than that.
 */

import { z } from 'zod';

import { boundedText } from '../domain/evidence.js';
import { countCriterionStatuses, countGateStatuses, summarizeFlakiness } from '../domain/result-counts.js';
import type { CriterionStatus } from '../domain/result.js';
import type { RunResult } from '../domain/run-result.js';
import { STAGE_NAMES } from '../domain/stage.js';
import type { StageName } from '../domain/stage.js';
import { InfraErrorClassificationSchema, VerdictSchema } from './enums.js';
import { IsoUtcTimestamp } from './manifest.js';
import { unknownKeysOnly } from './unknown-keys.js';
import { schemaVersionFor } from './versions.js';

/** The record version, per line. See `SCHEMA_VERSIONS.scorecard`. */
export const SCORECARD_RECORD_VERSION = schemaVersionFor('scorecard');

/** The file, project-local, beside `runs/`, `contracts/` and `plans/`. */
export const SCORECARD_FILENAME = 'scorecard.jsonl';

/**
 * The per-field byte cap for every string this record carries.
 *
 * Small on purpose. Every string here is already structurally constrained — a run id, a
 * canonical epic id, a `process.platform`, a hex fingerprint — so 256 bytes is far above
 * every real value and far below anything that could bloat a line. It is a BOUND, not a
 * formatting preference: an unbounded string is how a record grows past the size at
 * which a single append stays atomic.
 */
const FIELD_CAP_BYTES = 256;

/**
 * How many finding criterion ids one record carries, ACROSS ALL THREE STATUSES.
 *
 * ⚠️ ONE SHARED BUDGET, not one per status, and the distinction was a P2 from the codex
 * review of this story. A per-bucket cap is not a cap: 150 failures, 150 needs-human and
 * 150 errors is 450 ids in a single record with `findingCriterionIdsTruncated` still
 * false, because no individual bucket exceeded its own allowance. A contract has no
 * criterion-count limit, so that is reachable rather than theoretical.
 *
 * It matters because the LINE SIZE is what the concurrency guarantee rests on — see
 * `src/infra/scorecard-store.ts`. A record that can grow to three times its documented
 * bound is a record that can outgrow the size at which a single `O_APPEND` write stays
 * atomic, which is the one property the whole append design depends on.
 *
 * 200 because a contract with more than 200 findings is not a case anyone summarises
 * per-criterion, and `findingCriterionIdsTruncated` tells story 6.6 the list is partial
 * so it never reports a cut list as a complete one. The per-status COUNTS in
 * `ScorecardCriterionCounts` stay exact regardless, so no denominator ever shrinks.
 */
const MAX_FINDING_IDS = 200;

/** Bounded AND redacted. Every string that enters a record goes through here. */
function field(raw: string): string {
  return boundedText(raw, { capBytes: FIELD_CAP_BYTES }).text;
}

/* ── the record ───────────────────────────────────────────────────────────────────── */

/** Criteria by status, plus the total. `total` is the denominator 6.6 divides by. */
export interface ScorecardCriterionCounts {
  /** `criteria.length`. Zero for a gates-only run, which is a legitimate configuration. */
  readonly total: number;
  readonly pass: number;
  readonly fail: number;
  readonly needs_human: number;
  /**
   * ⚠️ **RECORDED FAITHFULLY, NOT EDITORIALISED.** `skipped` is the subject of open
   * action item **e4-D**: a run whose criteria are all `skipped` currently aggregates to
   * PASS, and whether that is right is an ADR nobody has written. This story does not
   * answer it — it records what happened. 6.6 must NOT fold `skipped` into `pass`, and a
   * summary that reports a high pass rate over runs whose criteria were all skipped is
   * reporting the hazard, not hiding it.
   */
  readonly skipped: number;
  readonly error: number;
}

/** Gates by status, plus the total. */
export interface ScorecardGateCounts {
  readonly total: number;
  readonly pass: number;
  readonly fail: number;
  /** An early stop skips the rest; a skipped gate is not an omission. */
  readonly skipped: number;
}

/** Story 5.4's three numbers, copied verbatim from `summarizeFlakiness`. */
export interface ScorecardFlakiness {
  /** Criteria that passed only on retry (FR-32). The NUMERATOR of retry-to-green. */
  readonly flakyCriteria: number;
  /** Criteria that took more than one attempt, whatever they came out as. */
  readonly retriedCriteria: number;
  /** Attempts beyond the first, summed — the repetition actually spent. */
  readonly extraAttempts: number;
}

/**
 * Which runs a record can be joined to, and where the record was produced.
 *
 * ADR-008 exists because this log accumulates across SpecWitness versions during the
 * dogfooding window, so 6.6 must be able to say "these 12 records came from 0.2.0".
 */
export interface ScorecardEnvironment {
  readonly specwitnessVersion: string;
  /** `process.version`, e.g. `v22.13.0`. */
  readonly nodeVersion: string;
  /** `process.platform`, e.g. `darwin`. */
  readonly platform: string;
  /** `process.arch`, e.g. `arm64`. */
  readonly arch: string;
}

/** The frozen contract this run was measured against, when the run got far enough to know. */
export interface ScorecardContract {
  /** Lowercase hex SHA-256 of the canonical spec. Two runs sharing it verified the same spec. */
  readonly fingerprint: string;
  /** `ContractSpec.version` — integer, monotonic. Freezing does not bump it; amending does. */
  readonly version: number;
  /** `ContractMeta.history.length` — recorded amendments. */
  readonly amendments: number;
  /** How many criteria the contract declares, so 6.6 can say "3 of 7 adjudicated". */
  readonly criterionCount: number;
}

/**
 * The criterion ids a FINDING could be about (FR-34 linkability).
 *
 * ⚠️ **THIS IS THE HOOK FOR 6.6's ATTRIBUTION, AND IT IS ALL THIS STORY BUILDS OF IT.**
 * FR-34 classifies each finding as `unique` / `duplicate-of-earlier-gate` /
 * `false-positive`. That classification is 6.6's and is NOT recorded here. What is
 * recorded is the key an attribution needs: **`(runId, criterionId)`** uniquely names one
 * finding, and these three arrays enumerate every criterion id in this run that a
 * finding could be about.
 *
 * Passing criteria are deliberately absent: an attribution is about a finding, and a
 * criterion that passed produced none. Keeping them out is also what keeps the line small.
 */
export interface ScorecardFindingIds {
  readonly fail: readonly string[];
  readonly needs_human: readonly string[];
  readonly error: readonly string[];
}

/**
 * One line of `.specwitness/scorecard.jsonl`.
 *
 * **Story 6.6 reads this and cannot ask me anything, so read the per-field notes.**
 * The metrics 6.6 is expected to compute, and where each comes from:
 *
 *  - **defect-detection (SM-1, the north star)** — `findingCriterionIds` joined against
 *    6.6's own attribution store, denominated by `criteria.total`.
 *  - **infra-error rate** — records whose `outcome.infraError` is present, over all
 *    records. This is only correct because an infra-errored run RECORDS; see
 *    `src/infra/scorecard-store.ts` and this story's PR body for the boundary.
 *  - **AI-free-run share (FR-18, Q66)** — records with `providerInvocations === 0`, over
 *    all records. `providerRoles` says which roles were paid for when it is not zero.
 *  - **retry-to-green rate (SM-C3)** — `flakiness.flakyCriteria` over
 *    `flakiness.retriedCriteria`; `flakiness.extraAttempts` is the repetition bought.
 *  - **cost/time (SM-2)** — `durationMs`, with `stageDurationsMs` for where it went.
 *  - **skipped-record count** — NOT a field. It is produced by reading the file; see
 *    `ScorecardFile.skipped` in `src/infra/scorecard-store.ts`.
 *
 * **There is deliberately no `exitCode` field.** `src/schemas/**` may not import
 * `src/cli/**` (`nothing-imports-cli`), and that is a feature here rather than an
 * obstacle: the scorecard adds no exit code and changes none, and the layer graph is
 * what says so. 6.6 derives the code from `outcome` through `src/cli/exit.ts`, which
 * stays the only module that knows what any code means (ADR-002).
 */
export interface ScorecardRecord {
  /** ADR-008 §5: every line carries its own version and is parsed independently. */
  readonly schemaVersion: number;
  /**
   * `run-<YYYYMMDDTHHmmssZ>-<4 base36>`.
   *
   * **The join key.** `.specwitness/runs/<runId>/result.json` is the full evidence for
   * this record, on the machine that produced it, and `(runId, criterionId)` is the key
   * a future FR-34 attribution hangs on.
   */
  readonly runId: string;
  /** Canonical epic id, e.g. `epic-6`. 6.6 groups by this. */
  readonly epic: string;
  /** ISO-8601 UTC, from the run's injected `Clock` (AD-9). Never `Date.now()`. */
  readonly startedAt: string;
  /** ISO-8601 UTC. The run's own finishing instant, not the instant this line was appended. */
  readonly finishedAt: string;
  /** Whole milliseconds, `finishedAt - startedAt`. Never negative. */
  readonly durationMs: number;
  /**
   * A product verdict OR an infrastructure error, never both (AD-6).
   *
   * READ, not decided. `aggregate()` is the one place a run outcome is determined and
   * this is a copy of what it already said. `gateFailed` carries the failing gate's id
   * when a gate is what ended the run — it is a config-declared key, not free text.
   */
  readonly outcome:
    | { readonly verdict: 'PASS' | 'FAIL' | 'NEEDS_HUMAN'; readonly gateFailed?: string }
    | { readonly infraError: 'config' | 'ingest' | 'integrity' | 'provider' | 'infra' };
  readonly criteria: ScorecardCriterionCounts;
  readonly gates: ScorecardGateCounts;
  readonly flakiness: ScorecardFlakiness;
  /**
   * `providerUsage.length` — how many times a provider was invoked ON BEHALF OF THIS RUN.
   *
   * **The number that proves the AI-free-run share.** FR-18's promise is that executing a
   * frozen contract plus a compiled plan makes zero provider calls; a run with a
   * committed plan and no `--explain` records `0`, and 6.6 reports the share of runs that
   * did. Non-zero means the run compiled a missing plan (story 4.7) or was explained
   * (story 5.5).
   */
  readonly providerInvocations: number;
  /**
   * The distinct roles invoked, sorted, e.g. `["plan-author"]`. Empty on an AI-free run.
   *
   * Roles are a closed-ish set of config keys (`plan-author`, `explainer`, …), bounded
   * and redacted like every other string here. WHICH role was paid for is what
   * distinguishes "this run compiled a plan" from "this run was explained", and a bare
   * count cannot.
   */
  readonly providerRoles: readonly string[];
  /**
   * Whole milliseconds per stage, keyed by the eleven `STAGE_NAMES`.
   *
   * A PARTIAL record: a stage that was skipped contributes `0` and is present; the key
   * set is closed by the enum, so this cannot grow unbounded. 6.6 uses it to say where
   * verification time goes — the answer to "is this gate worth its wall-clock" (SM-2).
   */
  readonly stageDurationsMs: Readonly<Partial<Record<StageName, number>>>;
  /** See `ScorecardFindingIds`. The FR-34 hook, and nothing more. */
  readonly findingCriterionIds: ScorecardFindingIds;
  /** True when the arrays above were cut at `MAX_FINDING_IDS`. 6.6 must not treat a cut list as complete. */
  readonly findingCriterionIdsTruncated: boolean;
  /**
   * Story 5.6 — whether this run applied and KEPT a mechanics adaptation.
   *
   * An adapted run executed a plan that differed from the committed one, so it is a
   * different measurement and 6.6 should be able to separate the two. `false` on every
   * default run, which is almost all of them.
   */
  readonly adapted: boolean;
  readonly environment: ScorecardEnvironment;
  /**
   * ABSENT when the run ended before or at the integrity stage — which is exactly the
   * runs whose contract could not be verified. Its PRESENCE means the contract was
   * frozen and its content still matched its fingerprint (see `ContractSummary`).
   */
  readonly contract?: ScorecardContract;
}

/* ── the schema ───────────────────────────────────────────────────────────────────── */

/** Every count in this record. Whole, never negative — a metric divides by these. */
const Count = z.number().int().nonnegative();

/**
 * Written out rather than derived from `CRITERION_STATUSES`.
 *
 * A generated key set types as `Record<string, number>`, which would let the record's
 * interface and its schema drift apart silently — and this schema is 6.6's guarantee that
 * the fields mean what they say. The closed taxonomy is instead pinned from the OTHER
 * direction, at compile time, in `tests/unit/schemas/scorecard.test.ts`: adding a status
 * to `CRITERION_STATUSES` without adding it here fails to typecheck.
 */
const CriterionCountsSchema = z
  .object({
    total: Count,
    pass: Count,
    fail: Count,
    needs_human: Count,
    skipped: Count,
    error: Count,
  })
  .strict();

const GateCountsSchema = z
  .object({ total: Count, pass: Count, fail: Count, skipped: Count })
  .strict();

const FlakinessSchema = z
  .object({ flakyCriteria: Count, retriedCriteria: Count, extraAttempts: Count })
  .strict();

const EnvironmentSchema = z
  .object({
    specwitnessVersion: z.string().min(1),
    nodeVersion: z.string().min(1),
    platform: z.string().min(1),
    arch: z.string().min(1),
  })
  .strict();

const ContractSchema = z
  .object({
    fingerprint: z.string().min(1),
    version: z.number().int().positive(),
    amendments: Count,
    criterionCount: Count,
  })
  .strict();

const FindingIdsSchema = z
  .object({
    fail: z.array(z.string().min(1)),
    needs_human: z.array(z.string().min(1)),
    error: z.array(z.string().min(1)),
  })
  .strict();

const OutcomeSchema = z.union([
  z.object({ verdict: VerdictSchema, gateFailed: z.string().min(1).optional() }).strict(),
  z.object({ infraError: InfraErrorClassificationSchema }).strict(),
]);

/**
 * `.strict()`, exactly as every other persisted envelope in this repository is.
 *
 * ADR-008 §1 keeps strictness and changes the DIAGNOSIS: an unknown key means a newer
 * writer, not corruption. §5 then makes the consequence softer for this file alone —
 * skip the line with a warning and keep going — because a partially-readable
 * append-only log is still evidence, and refusing to summarise 200 good records because
 * record 47 came from a newer build would destroy the measurement the file exists for.
 * `parseScorecardLine` below is where that distinction is made.
 */
export const ScorecardRecordSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    runId: z.string().min(1),
    epic: z.string().min(1),
    startedAt: IsoUtcTimestamp,
    finishedAt: IsoUtcTimestamp,
    durationMs: Count,
    outcome: OutcomeSchema,
    criteria: CriterionCountsSchema,
    gates: GateCountsSchema,
    flakiness: FlakinessSchema,
    providerInvocations: Count,
    providerRoles: z.array(z.string().min(1)),
    /**
     * `partialRecord`, not `record`, and the difference is AD-5.
     *
     * The WRITER always emits all eleven — `runPipeline` builds its timeline from
     * `STAGE_NAMES` in order, so every stage is present even when it was skipped. The
     * READER is deliberately tolerant of a subset, because zod's exhaustive `record`
     * would make a record written before a stage existed parse as MALFORMED. The key set
     * is still closed by the enum, so this cannot grow unbounded, and an unrecognised
     * stage name is still a version skew rather than corruption.
     */
    stageDurationsMs: z.partialRecord(z.enum(STAGE_NAMES), Count),
    findingCriterionIds: FindingIdsSchema,
    findingCriterionIdsTruncated: z.boolean(),
    adapted: z.boolean(),
    environment: EnvironmentSchema,
    contract: ContractSchema.optional(),
  })
  .strict();

/* ── the projection ───────────────────────────────────────────────────────────────── */

/**
 * The finding ids, capped ACROSS THE RECORD, with the flag that says whether the cap bit.
 *
 * The budget is spent in a FIXED order — `fail`, then `needs_human`, then `error` — so two
 * runs with the same criteria produce the same record, and so the ids most likely to be
 * worth attributing survive truncation first. A run that overflows the budget is already
 * one nobody attributes id-by-id; what it must not do is silently claim a complete list.
 */
function findingIds(result: RunResult): {
  readonly ids: ScorecardFindingIds;
  readonly truncated: boolean;
} {
  const collect = (status: CriterionStatus): readonly string[] =>
    result.criteria.filter((criterion) => criterion.status === status).map((criterion) => criterion.criterionId);

  const fail = collect('fail');
  const needsHuman = collect('needs_human');
  const error = collect('error');

  let remaining = MAX_FINDING_IDS;
  const take = (ids: readonly string[]): readonly string[] => {
    const taken = ids.slice(0, Math.max(0, remaining)).map(field);
    remaining -= taken.length;
    return taken;
  };

  return {
    ids: {
      fail: take(fail),
      needs_human: take(needsHuman),
      error: take(error),
    },
    truncated: fail.length + needsHuman.length + error.length > MAX_FINDING_IDS,
  };
}

/**
 * Projects a finished run onto its scorecard record.
 *
 * PURE and TOTAL: no clock, no I/O, no randomness, and no branch that can fail. It is
 * called on the path of a run that has already reached its outcome, so it must not be
 * able to throw — a projection that raised would be instrumentation changing a verdict,
 * which is the one thing this story may never do.
 *
 * `aggregate()` is NOT called: the outcome was decided by the aggregate stage and lives
 * on `result.outcome`. Re-deciding it here would create a second answer to the only
 * question this product may have one answer to.
 */
export function toScorecardRecord(result: RunResult): ScorecardRecord {
  const criteria = countCriterionStatuses(result.criteria);
  const gates = countGateStatuses(result.gates);
  const flakiness = summarizeFlakiness(result.criteria);
  const findings = findingIds(result);

  const started = Date.parse(result.startedAt);
  const finished = Date.parse(result.finishedAt);
  // Clamped at zero rather than trusted: both timestamps come from the run's own clock,
  // but a hand-edited or fixture-authored result must not be able to put a negative
  // duration into a metric 6.6 averages.
  const durationMs =
    Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : 0;

  const stageDurationsMs: Partial<Record<StageName, number>> = {};
  for (const entry of result.stages) {
    stageDurationsMs[entry.stage] = Math.max(0, Math.trunc(entry.durationMs));
  }

  return {
    schemaVersion: SCORECARD_RECORD_VERSION,
    runId: field(result.runId),
    epic: field(result.epic),
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs,
    outcome:
      result.outcome.infraError === undefined
        ? {
            verdict: result.outcome.verdict,
            ...(result.outcome.gateFailed === undefined
              ? {}
              : { gateFailed: field(result.outcome.gateFailed) }),
          }
        : { infraError: result.outcome.infraError },
    criteria: { total: result.criteria.length, ...criteria },
    gates: { total: result.gates.length, ...gates },
    flakiness,
    providerInvocations: result.providerUsage.length,
    // Sorted and de-duplicated so two runs that invoked the same roles produce the same
    // array, whatever order the calls happened in — 6.6 groups on this.
    providerRoles: [...new Set(result.providerUsage.map((usage) => field(usage.role)))].sort(),
    stageDurationsMs,
    findingCriterionIds: findings.ids,
    findingCriterionIdsTruncated: findings.truncated,
    adapted: result.adaptation?.adapted === true,
    environment: {
      specwitnessVersion: field(result.environment.specwitnessVersion),
      nodeVersion: field(result.environment.nodeVersion),
      platform: field(result.environment.platform),
      arch: field(result.environment.arch),
    },
    ...(result.contract === undefined
      ? {}
      : {
          contract: {
            fingerprint: field(result.contract.fingerprint),
            version: result.contract.version,
            amendments: result.contract.amendments,
            criterionCount: result.contract.criterionCount,
          },
        }),
  };
}

/**
 * ONE record as ONE line, newline-terminated.
 *
 * No indentation — this is JSONL, and a pretty-printed record would span lines and stop
 * being independently parseable, which is the property ADR-008 §5 rests on. The trailing
 * newline is part of the record: without it the next append concatenates onto this one.
 */
export function serializeScorecardRecord(record: ScorecardRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/* ── reading, ADR-008 §5 ──────────────────────────────────────────────────────────── */

/** Why a line was skipped. The two are not interchangeable — see `parseScorecardLine`. */
export type ScorecardSkipReason = 'version-skew' | 'malformed';

export type ScorecardLineParse =
  | { readonly ok: true; readonly record: ScorecardRecord }
  | { readonly ok: false; readonly reason: ScorecardSkipReason; readonly message: string };

/**
 * Parses ONE line, and never throws.
 *
 * ADR-008 §5 in code. Three outcomes, and the distinction between the last two is the
 * whole point:
 *
 *  - a valid record;
 *  - `version-skew` — every validation failure was an unrecognised key, i.e. a NEWER
 *    SpecWitness wrote this line. The record is skipped and the reader continues;
 *  - `malformed` — anything else: bad JSON, a missing field, a wrong type, an
 *    out-of-range enum. Also skipped, also counted, and **diagnosed differently**,
 *    because a test that only covered the skew direction would let real corruption
 *    become an upgrade hint (ADR-008 "Consequences", last bullet).
 *
 * SECURITY: the message carries zod issue PATHS and CODES and the unrecognised KEY
 * NAMES, and never an issue's `message` or a value from the file. Some zod messages echo
 * the offending value, and the key names themselves came out of an untrusted file — so
 * they are bounded and redacted before they are named. A scorecard is the file most
 * likely to be pasted into an issue; a warning about it must not be the leak.
 */
export function parseScorecardLine(line: string, lineNumber: number, path: string): ScorecardLineParse {
  const where = `${path} line ${lineNumber}`;

  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return {
      ok: false,
      reason: 'malformed',
      message: `${where} is not a readable scorecard record — record skipped (not valid JSON, most likely a partially-written line).`,
    };
  }

  // ⚠️ THE VERSION IS READ BEFORE THE SHAPE, and that ordering is the whole point — the
  // same ordering `parseRunResult` uses for `result.json`. Raised as a P2 by the codex
  // review of this branch, and it is the sharpest defect this story could have shipped.
  //
  // The unknown-key branch below cannot catch a version bump, because ADR-008 §3 defines
  // a bump as an EXISTING field changing meaning, type or requiredness. A version-2
  // record can therefore carry exactly the version-1 key set and mean something different
  // by it: no unknown keys, every type valid, and every number 6.6 computes from it
  // wrong. That is the failure this whole story is written against — a north-star metric
  // that is confidently wrong, with nothing on screen to say so.
  //
  // A CEILING, not a wall. Only a NEWER version is refused; a record at this build's own
  // version is what every line written here carries, and AD-5's "a stored run from last
  // week must stay readable" governs the other direction.
  if (typeof json === 'object' && json !== null && 'schemaVersion' in json) {
    const version = (json as { schemaVersion: unknown }).schemaVersion;
    if (typeof version === 'number' && version > SCORECARD_RECORD_VERSION) {
      return {
        ok: false,
        reason: 'version-skew',
        message:
          `${where} was written by a newer SpecWitness than the one reading it — record ` +
          `skipped (schemaVersion ${version}, this build understands ` +
          `${SCORECARD_RECORD_VERSION}). Upgrade specwitness to read it.`,
      };
    }
  }

  const parsed = ScorecardRecordSchema.safeParse(json);
  if (parsed.success) {
    return { ok: true, record: parsed.data };
  }

  // `unknownKeysOnly` is story 6.3's shared classifier (`src/schemas/unknown-keys.ts`),
  // and this call site is the convergence its author and I agreed on before either branch
  // was written. Three readers in this epic ask a `ZodError` the same question — 6.3's two
  // and this one — and three hand-written copies of "was EVERY issue an unrecognised key"
  // is how the second one quietly gets nested paths wrong.
  //
  // It CLASSIFIES and does not speak, which is what keeps it clear of the shared
  // `assertSchemaVersion` helper ADR-008 rejected: what a mismatch MEANS stays
  // artifact-specific, and this file still picks its own message and its own consequence
  // — a skip that continues, where 6.3's readers refuse with exit 3 (ADR-008 §5).
  const unknown = unknownKeysOnly(parsed.error);
  if (unknown !== null) {
    return {
      ok: false,
      reason: 'version-skew',
      message:
        `${where} was written by a newer SpecWitness than the one reading it — record skipped. ` +
        `Unknown field(s): ${unknown.map(field).join(', ')}. Upgrade specwitness to read it.`,
    };
  }

  // Paths and codes only. Never `issue.message`, which can quote the value it rejected.
  //
  // EVERY PATH SEGMENT GOES THROUGH `field()` TOO, and that is belt-and-braces rather than
  // a fix for a reachable leak — stated precisely because overclaiming a vulnerability is
  // its own kind of wrong. Raised as a P2 by the codex review of this branch on the theory
  // that an attacker-controlled map key reaches `issue.path`; measured against this schema,
  // it does not. An unexpected key under `stageDurationsMs` produces an `unrecognized_keys`
  // issue carrying the key in `issue.keys` with `path` stopping at `stageDurationsMs`, so
  // it routes to the branch above, which already redacts. Every path segment this schema
  // can produce today is one of its own field names, a `STAGE_NAMES` enum member, or an
  // array index.
  //
  // It is applied anyway because that argument is a property of TODAY'S FIELD LIST, not of
  // this function: the day someone adds a free-form-keyed field — 6.6 has every reason to
  // want one — a path segment becomes attacker-controlled and this would silently become a
  // leak in the file least able to afford one. One `.map(field)` makes the module header's
  // claim true by construction instead of by an argument that has to be re-derived.
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.map((segment) => field(String(segment))).join('.') || '<root>'}: ${issue.code}`)
    .join('; ');

  return {
    ok: false,
    reason: 'malformed',
    message: `${where} is not a readable scorecard record — record skipped (${detail}).`,
  };
}
