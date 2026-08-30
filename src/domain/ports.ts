/**
 * AD-9 — the determinism ports.
 *
 * Wall-clock time and randomness are the two things that make a test suite
 * flaky by default, so neither is read directly anywhere in `src/domain` or
 * `src/pipeline`. They arrive through these interfaces, and tests inject fakes
 * (`FixedClock`, `SequenceIds`) that make run ids exact strings rather than
 * shapes.
 *
 * INTERFACES ONLY. This module has no implementations and no imports at all —
 * not a node builtin, not an npm package. `SystemClock` and `RandomIds` live
 * in `src/infra/`, where side effects belong, and `dependency-cruiser`'s
 * `domain-is-dependency-free` and `no-side-effect-builtins-in-core` rules keep
 * it that way.
 *
 * Later epics add their ports here (Epic 3 brings the process runner and the
 * git/worktree seam). Keep this file free of implementations so `domain` stays
 * importable from anywhere.
 */

/**
 * The source of "now".
 *
 * Returns a `Date` rather than a formatted string: formatting is a caller's
 * concern, and a port that formatted would force every consumer to share one
 * precision. Run ids truncate this to whole seconds; manifests keep the full
 * millisecond precision.
 */
export interface Clock {
  now(): Date;
}

/**
 * The source of randomness.
 *
 * Deliberately narrow: it yields base36 text of a requested width, not bytes
 * or numbers. A port that handed out raw entropy would push encoding decisions
 * into every call site, and the run-id suffix would end up formatted two
 * different ways.
 *
 * Implementations must return exactly `length` characters drawn from
 * `[0-9a-z]`, uniformly. Callers validate the result rather than trusting it
 * (fail closed — a bad suffix mints a run directory we could create but never
 * look up again).
 */
export interface Ids {
  randomBase36(length: number): string;
}
