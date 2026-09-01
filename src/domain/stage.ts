/**
 * AD-6 / FR-20 — the verify pipeline's stage vocabulary.
 *
 * `specwitness verify` is an explicit staged state machine, not sequential code, and the
 * eleven names below ARE that machine's alphabet. They are frozen by the spine's
 * Structural Seed and by story 3.3's AC1: four other stories key their timeline entries
 * off these exact strings, and the JSON report publishes them. Renaming, reordering,
 * adding or dropping one is an ADR in `docs/adr/`, not an edit.
 *
 * Two orderings in the sequence are load-bearing rather than incidental:
 *
 *  - **`integrity` precedes `worktree`.** A contract whose content no longer matches its
 *    fingerprint costs nothing: no worktree is created and no command is spawned before
 *    the run refuses (FR-9 at runtime). `tests/unit/pipeline/stages/integrity.test.ts`
 *    asserts that mechanically with a `ProcessRunner` that throws on any call, rather
 *    than asserting it in prose.
 *  - **`teardown` is last, and it always runs.** After an early stop, after a thrown
 *    error, and after an error thrown by teardown itself. See `pipeline/run-pipeline.ts`.
 *
 * AD-1: pure. This module imports nothing at all — not a node builtin, not an npm
 * package, not a sibling. `tsPreCompilationDeps: true` means even a type-only import of
 * zod fails `domain-is-dependency-free`.
 */

/**
 * The eleven stages of a verification run, in execution order.
 *
 * `as const` rather than an enum: these are the literal strings that appear in
 * `result.json` and in the terminal report, and deriving `StageName` from the tuple is
 * what keeps the type and the runtime value from drifting apart.
 */
export const STAGE_NAMES = [
  'resolve',
  'integrity',
  'worktree',
  'setup',
  'gates',
  'services',
  'data',
  'probes',
  'aggregate',
  'persist',
  'teardown',
] as const;

export type StageName = (typeof STAGE_NAMES)[number];

/**
 * How one stage came out. CLOSED, and the four values are not interchangeable.
 *
 * - `ok`      — ran, nothing negative to report.
 * - `failed`  — ran and produced a PRODUCT-relevant negative outcome: the gates stage
 *               found a gate that said no. The pipeline stops early, but the run still
 *               reaches aggregate → persist → teardown and ends in a `Verdict`.
 * - `error`   — the stage threw an AD-7 error. The run cannot reach a product conclusion
 *               and ends with an `{infraError}` outcome (exit 3, never exit 1).
 * - `skipped` — never ran, because an earlier stage stopped the pipeline. Inert.
 *
 * The `failed` / `error` split is the whole reason this epic exists. Collapse them into
 * one "bad" value and a branch that simply does not build starts reporting as "the
 * environment is broken, retry" — after which a retry merges it.
 */
export const STAGE_STATUSES = ['ok', 'failed', 'error', 'skipped'] as const;

export type StageStatus = (typeof STAGE_STATUSES)[number];

/**
 * One row of the run's stage timeline. Every stage produces exactly one, including the
 * skipped ones — a renderer never has to infer that a stage is missing because it did
 * not run (AD-11).
 */
export interface StageTimelineEntry {
  readonly stage: StageName;
  readonly status: StageStatus;
  /**
   * Whole milliseconds, measured with the injected `Clock` (AD-9) and never
   * `Date.now()`. `0` for a stage that was skipped.
   */
  readonly durationMs: number;
  /**
   * One short line of context: why a stage failed, what an error was classified as, or
   * which story fills a placeholder. Never a stack trace and never a secret — this is
   * rendered and persisted.
   */
  readonly detail?: string;
}
