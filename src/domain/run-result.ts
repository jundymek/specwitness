/**
 * AD-11 — THE result model. One object, many renderers.
 *
 * The pipeline produces exactly one `RunResult`. The terminal renderer, the `--json`
 * renderer and the stored `result.json` all derive from it, and **no renderer computes a
 * fact of its own**. That rule only holds if nothing is missing here, which makes this
 * file's completeness a design obligation rather than a convenience: every time a
 * renderer would have to look something up — re-read the contract, stat the worktree,
 * ask the process for its node version — that fact belongs in this object instead.
 *
 * Two things are deliberately ABSENT, and their absence is as considered as the fields:
 *
 *  - **`schemaVersion`.** That belongs to the persisted `result.json` DOCUMENT (story
 *    3.5), not to the in-memory domain model. A domain type carrying a storage format's
 *    version number is a domain type that changes when storage changes.
 *  - **Counts.** `domain/result-counts.ts` derives them from the arrays already here.
 *    A stored count sitting beside the array it counts is a second source of truth that
 *    can drift from it; a derived one cannot. AD-11 forbids a renderer INVENTING a fact,
 *    not counting a list it was given — and both views call the same function, so they
 *    cannot disagree.
 *
 * AD-1: pure. Imports only sibling domain modules.
 */

import type { DerivedCriterionResult } from './criterion-result.js';
import type { Evidence } from './evidence.js';
import type { GateResult } from './result.js';
import type { RunOutcome } from './run-outcome.js';
import type { StageTimelineEntry } from './stage.js';

/**
 * One provider invocation (AD-4: "every provider invocation is recorded — role, duration,
 * retries", Q65).
 *
 * **Epic 3 always produces an empty array.** Verify is AI-free by design (FR-18, Q66):
 * the verify path delegates nothing to `claude` or `codex`, and the empty case is proven
 * rather than assumed. The shape exists now so Epics 4 and 5 fill it rather than inventing
 * a second one.
 */
export interface ProviderUsage {
  /** What the provider was invoked for, e.g. `contract-generate`. */
  readonly role: string;
  /** The provider key as declared in the Project Config, e.g. `claude-code`. */
  readonly provider: string;
  readonly durationMs: number;
  /** Total attempts including the successful one; `1` when it worked first time. */
  readonly attempts: number;
  /**
   * `null` on every path today, honestly.
   *
   * `AgentProvider.generate` returns raw text and the AD-2 response envelope has no
   * metadata slot, so there is nothing truthful to put here yet. A guessed model string
   * in an audit field is worse than an honest null. (Story 3.8 wires the CONTRACT's
   * `meta.provenance` — a different artifact, not this.)
   */
  readonly model: string | null;
  readonly providerCliVersion: string | null;
}

/**
 * ONE criterion's non-authoritative root-cause hypothesis (story 5.5, FR-11, AD-2, AD-10).
 *
 * **NOTHING MECHANICAL READS THIS.** No verdict, no status, no count, no exit code and no
 * classification derives from it. It is text a human — or a repair agent — reads, and it
 * is the only free-form provider prose a run carries outside `Evidence.explanation`.
 *
 * WHY IT IS NOT A FIELD ON `DerivedCriterionResult`, which is where a reader would first
 * look for it. Three reasons, and the third is the story's whole point:
 *
 *  1. `DerivedCriterionResult` is produced by exactly one function
 *     (`deriveCriterionResult`), from observed attempts. A field written into it after the
 *     fact by a provider would make that no longer true.
 *  2. `aggregate()` is handed `criteria` and `gates`. A hypothesis living on a criterion is
 *     a hypothesis inside the verdict function's reach; one living here is not — so "an
 *     explanation can never influence a verdict" is a property of the SHAPE rather than a
 *     rule somebody has to keep remembering.
 *  3. It makes the story's headline acceptance criterion mechanically checkable: with the
 *     hypothesis in a side channel, the serialized `criteria` array is byte-for-byte
 *     identical with and without `--explain`, rather than merely equivalent.
 *
 * `criterionId` is matched against the run's OWN criteria when the explanation is
 * attached; an id the run does not carry is dropped. A provider cannot introduce a
 * criterion, and cannot re-point a hypothesis at one it was not shown.
 */
export interface CriterionExplanation {
  /** Always the id of a criterion this same `RunResult` carries. */
  readonly criterionId: string;
  /**
   * AD-10's labeled NON-AUTHORITATIVE text. Redacted and bounded at capture, exactly as
   * every other captured string is, because it is persisted and rendered exactly as they
   * are — and because it is UNTRUSTED provider output.
   */
  readonly explanation: string;
}

/**
 * The environment summary FR-29 requires the terminal report to print.
 *
 * Small and factual on purpose. A renderer must never compute or look any of this up
 * (AD-11), so whatever a report has to say about the machine has to be in here — which
 * is also why `runDirectory` is a field rather than something a renderer derives from
 * `runId`.
 */
export interface RunEnvironment {
  /** e.g. `v22.12.0`. */
  readonly nodeVersion: string;
  /** `process.platform`, e.g. `darwin`. */
  readonly platform: string;
  /** `process.arch`, e.g. `arm64`. */
  readonly arch: string;
  /** The running specwitness version. */
  readonly specwitnessVersion: string;
  /**
   * Absolute path of the detached worktree the run executed in; `null` when none was
   * created (the run stopped before the worktree stage, or failed to make one).
   *
   * The ONE legitimately absolute path in a stored run, and the exception proves the
   * rule: evidence paths are relative because a run directory must survive being copied
   * between machines (Q48), whereas this is provenance — it records where the run
   * happened, on that machine, at that time, and it will usually not exist any more by
   * the time anyone reads it. Do not "fix" it in either direction.
   */
  readonly worktreePath: string | null;
  /** The run directory, RELATIVE to the project root: `.specwitness/runs/<run-id>`. */
  readonly runDirectory: string;
}

/**
 * What FR-29 calls "contract status, revisions".
 *
 * **Its presence IS fingerprint validity.** The integrity stage fills it only after the
 * merged `assertVerifiableContract` returned, so a `RunResult` carrying a `contract` is
 * one whose contract was frozen and whose content still matched its fingerprint. Absent
 * means the run ended `{infraError: 'integrity'}` — absent, never frozen, or tampered —
 * or died before integrity ran. A renderer therefore never has to ask whether the
 * fingerprint was valid, and must never re-read the contract file to find out.
 */
export interface ContractSummary {
  readonly epic: string;
  /** `ContractSpec.version` — integer, monotonic; freezing does not bump it, amending does. */
  readonly version: number;
  /** `ContractMeta.fingerprint` — lowercase hex SHA-256 of the canonical spec. */
  readonly fingerprint: string;
  /** ISO-8601 UTC. */
  readonly frozenAt: string;
  /** `ContractMeta.history.length` — recorded amendments. */
  readonly amendments: number;
  /** How many criteria the contract declares, so a report can say "3 of 7". */
  readonly criterionCount: number;
}

/**
 * Everything one verification run produced.
 *
 * Story 3.5 persists this as `result.json`; story 3.6 renders it to a terminal and to
 * JSON; story 3.7 maps `outcome` through `exitCodeForOutcome`. None of them adds a field
 * — a missing fact is a message to the owner of this file or a follow-up story, never a
 * parallel edit, because two branches widening one model is how the JSON contract quietly
 * grows two shapes.
 */
export interface RunResult {
  /** `run-<YYYYMMDDTHHmmssZ>-<4 base36>`, minted at the CLI edge (see `domain/run-id.ts`). */
  readonly runId: string;
  /** Canonical epic id, `epic-7` — normalised by the resolve stage via `domain/ids.ts`. */
  readonly epic: string;
  readonly baseSha: string;
  readonly headSha: string;
  /** ISO-8601 UTC, from the injected `Clock` (AD-9). */
  readonly startedAt: string;
  readonly finishedAt: string;
  /**
   * A product verdict OR an infrastructure error, never both (AD-6). The exclusivity is
   * enforced by `run-outcome.ts` through `infraError?: never`, and inherited here.
   */
  readonly outcome: RunOutcome;
  /** All eleven stages, always, in order — including the ones that were skipped. */
  readonly stages: readonly StageTimelineEntry[];
  readonly gates: readonly GateResult[];
  /** Extended additively by `domain/criterion-result.ts`; produced only by its one function. */
  readonly criteria: readonly DerivedCriterionResult[];
  /**
   * The closed evidence UNION, not bare references.
   *
   * Refs alone would discard the redacted, bounded content at the moment it was
   * constructed, and a renderer whose signature is `(result: RunResult) => string` could
   * then only show that content by reading the file — which AD-11 forbids and its
   * signature makes impossible. Each member carries its own relative pointer to the full
   * copy on disk.
   */
  readonly evidence: readonly Evidence[];
  /** Empty in Epic 3 — the verify path invokes no provider (FR-18, Q66). */
  readonly providerUsage: readonly ProviderUsage[];
  readonly environment: RunEnvironment;
  /** Absent only when the run died before or at the integrity stage. */
  readonly contract?: ContractSummary;
  /**
   * Non-authoritative root-cause hypotheses, one per explained criterion (story 5.5).
   *
   * ABSENT on every run that was not explicitly explained — which is every run, unless
   * `verify --explain` was passed AND an `explainer` role is configured AND the provider
   * answered with a schema-valid payload. `--explain` is opt-in precisely so that FR-18's
   * "a frozen contract plus a compiled plan execute with zero provider calls" survives
   * this field's existence.
   *
   * The array is the ONE key this story adds to the model, and it is deliberately a
   * SIBLING of `criteria` rather than a member of it — see `CriterionExplanation` for why
   * that placement is what makes the inertness claim checkable rather than merely stated.
   *
   * Read by exactly two things: the terminal renderer, which prints it under a heading
   * that says it is a hypothesis, and `schemas/result.ts`, which persists it. Nothing
   * else — and above all not `aggregate`, not `deriveCriterionResult` and not
   * `exitCodeForOutcome`.
   */
  readonly explanations?: readonly CriterionExplanation[];
}
