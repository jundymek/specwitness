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
 * `browser` is declared in `PROBE_SURFACES` and has no executor: Epic 5 owns it, and
 * nothing in Epic 4 adds `@playwright/test`.
 *
 * AD-1: `src/surfaces/**` is an adapter directory. It may import `src/domain/**`,
 * `src/schemas/**`, its own siblings and npm — never `src/config/**`, never an application
 * layer, never the edge. `adapters-core-only` enforces it. The consequence worth naming
 * here, because it shapes every constructor in this directory: an executor cannot look a
 * value up, so the CALLER resolves and passes values in.
 */

export * from './http.js';
