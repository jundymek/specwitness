# ADR-007: The Node runtime floor is >=22.13, set by the pinned package manager

- **Status:** Accepted
- **Date:** 2026-09-04
- **Supersedes:** the `>=22.12` floor recorded in ADR-006 §1 and the spine's Stack table

## Context

The floor was set to `>=22.12` on 2026-08-30 by the spine's reviewer-verified
stack (`review-version-reality.md` F-1): Node 20 is EOL, and commander 15,
execa 10 and dependency-cruiser 18 all require >=22.12. Nothing about that
reasoning was wrong, and it is not what changed.

What changed is that the same stack pins `packageManager: pnpm@11.24.0`, and
**pnpm 11.24.0 declares `engines.node >=22.13`**. The two pins contradicted each
other: a runtime at the declared floor of 22.12 could not start the declared
package manager, so the floor named a configuration that cannot install the
project at all.

This went unseen for four epics because CI never executed a step (Epic 1 action
item A1, open through Epic 4) and every local run used Node 22.20. It surfaced
within seconds of the first real CI run, on 2026-09-04, once the repository was
made public and Actions minutes stopped applying — failing identically on
`ubuntu-latest` and `macos-latest`:

```
ERROR: This version of pnpm requires at least Node.js v22.13
The current version of Node.js is v22.12.0
```

## Decision

**The floor is `>=22.13`.**

The floor is defined as *the highest minimum required by any pinned element of
the stack*, and it is the package manager — not the runtime libraries — that
currently sets it. Verified against the registry on 2026-09-04:

| Pinned element | `engines.node` |
| --- | --- |
| pnpm 11.24.0 (`packageManager`) | **>=22.13** |
| commander 15.0.0 | >=22.12 |
| execa 10.0.1 | >=22 |
| @playwright/test 1.62.1 (optional peer) | >=20 |

22.13 therefore satisfies every pin, and no dependency needed to move.

## Alternative considered and rejected

**Downgrade pnpm to a release that runs on 22.12**, defending the recorded floor
instead of changing it. Rejected because it defends a number rather than a
property: 22.12 was never chosen for its own sake, only as the highest minimum
then known, and the same contradiction returns at the next pnpm bump. Raising
the floor keeps the original rule intact and re-derives it from current facts.

Also rejected: pinning CI above `engines.node`. That hides the contradiction
rather than resolving it, and costs exactly the signal CI was re-enabled to
provide — the floor would once again be a number nothing executes.

## Consequences

- `engines.node` is `>=22.13`; `.npmrc` keeps `engine-strict=true`, so an
  install on 22.12 now fails at install time rather than at `corepack enable`.
- `src/cli/doctor/checks/node-version.ts` enforces 22.13 (FR-3). `doctor` fails
  on 22.12 — a behaviour change for any user on exactly that version, and the
  correct one: they cannot install the project's toolchain either.
- `ci.yml` pins `node-version: '22.13'`, the floor itself, so a feature newer
  than the floor cannot creep in unnoticed. **This pin must track
  `engines.node`**; if they drift, CI stops testing what the package promises.
- ADR-006 §1 and the spine Stack table are updated to `>=22.13` with a pointer
  here. Story specs and retrospectives written before this date say "Node
  exactly 22.12" when naming what CI had never verified; they are historical
  records of what was true when written and are deliberately not rewritten.

## What this does not decide

Whether Node 22 remains the right major. 22 is Maintenance LTS (26 is Active);
moving to a newer major is a separate decision with a different rationale, and
nothing here anticipates it.
