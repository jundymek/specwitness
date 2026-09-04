/**
 * The surface executors (AD-13) — one per `ProbeSurface`, all identically shaped.
 *
 * A THIN RE-EXPORT AND NOTHING ELSE. No logic, no types of its own, no ordering
 * significance. That is deliberate rather than minimal-for-now: three Epic 4 stories land
 * three executors in three branches against one epic branch, and a barrel carrying anything
 * beyond one line per surface turns three trivial conflicts into one bad one. Story 4.4
 * created this file and each sibling adds its own line after 4.4 merges (agreed at cohort
 * intent-sync); on a rebase conflict here, take the epic branch's side and re-add your line.
 *
 * `browser` WAS declared in `PROBE_SURFACES` with no executor throughout Epic 4 — "Epic 5
 * owns it, and nothing in Epic 4 adds `@playwright/test`". Story 5.2 filled the last
 * reserved slot, so this barrel now names all FOUR surfaces and the sentence that said
 * otherwise is corrected here rather than left standing: a barrel naming three surfaces of
 * four reads as a complete list, which is worse than no barrel at all (see 4.7's note
 * below, which learned exactly that).
 *
 * ============================================================================
 * COMPLETED BY 4.7, AND WHY IT COULD NOT STAY THREE `export *` LINES
 * ============================================================================
 *
 * 4.5's and 4.6's lines never landed: both PRs opened before 4.4's did, and neither author
 * was still running when it merged. The gap was cosmetic — nothing imported the barrel —
 * but a barrel naming one surface of three is worse than no barrel, because it reads as a
 * complete list.
 *
 * Adding the two lines surfaces the cost of the cohort's other convention. Each surface
 * DECLARES its own structurally-identical callback types rather than importing a sibling's,
 * so that each compiles whether or not its siblings have merged — and `http.ts` and
 * `observation.ts` both landed a public type called `SurfaceEvidenceWriter`. `export *`
 * three times is therefore a TS2308 ambiguity, not a barrel.
 *
 * Resolved by naming what each surface contributes rather than by renaming a merged
 * surface's public type. That keeps every executor's own API untouched, and it makes the
 * duplication VISIBLE at the one place a reader would look for the product's surface API —
 * which is more useful than hiding it behind a wildcard. Consolidating the three
 * near-identical callback types (and the three private `slugify` helpers all three PRs
 * flagged) is a named follow-up rather than something smuggled in here: it touches three
 * merged modules to buy tidiness, and nothing depends on it.
 *
 * AD-1: `src/surfaces/**` is an adapter directory. It may import `src/domain/**`,
 * `src/schemas/**`, its own siblings and npm — never `src/config/**`, never an application
 * layer, never the edge. `adapters-core-only` enforces it. The consequence worth naming
 * here, because it shapes every constructor in this directory: an executor cannot look a
 * value up, so the CALLER resolves and passes values in.
 */

export * from './http.js';

export {
  OBSERVATION_PROBE_TIMEOUT_MS,
  ObservationSurfaceExecutor,
  type EvidenceSink,
  type ObservationActionRunner,
  type ObservationCommandResolver,
  type ObservationExecutorDeps,
  type ResolvedObservationCommand,
} from './observation.js';

export {
  BROWSER_PROBE_TIMEOUT_MS,
  BROWSER_RUNNER_OVERHEAD_MS,
  BROWSER_STEP_TIMEOUT_MS,
  BrowserSurfaceExecutor,
  type BrowserEvidenceBinaryWriter,
  type BrowserEvidenceRecorder,
  type BrowserEvidenceWriter,
  type BrowserExecutorDeps,
  type BrowserProbeParams,
  type BrowserRuntimeEnvironment,
  type RunPathResolver,
} from './browser.js';

export {
  SHELL_PROBE_TIMEOUT_MS,
  ShellSurfaceExecutor,
  type ResolvedShellCommand,
  type ShellAssertionSpec,
  type ShellEvidenceSink,
  type ShellEvidenceWriter,
  type ShellExecutorDeps,
  type ShellProbeParams,
} from './shell.js';
