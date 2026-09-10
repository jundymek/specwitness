# ADR-009: A declarative surface for static facts about the tree

- **Status:** Accepted
- **Date:** 2026-09-10
- **Supersedes:** nothing. **Answers:** the onboarding cost measured during the second dogfooding run (`d8`).
- **Binding on:** `src/schemas/plan.ts`'s closed probe union, `src/config/schema.ts`, `src/surfaces/`, and `templates/config.yaml`.

## Context

A `specwitness init` produces a `templates/config.yaml` that, with the comments stripped, is three lines:

```yaml
version: 1
project:
  baseBranch: master
```

Everything a plan can actually probe is then the operator's to write. In the first client project (`gitnebula`, Epic 6) that came to **645 lines of hand-written JavaScript across seven `.mjs` files**, declared as seven `observations:` entries. The PRD's definition of the surface those entries use anticipated something else:

> **Observation Command** — a project-configured, trusted command that emits structured JSON about system state (**e.g. row counts**), used for before/after state comparison.

Row counts are genuinely project-specific and genuinely need code. But five of gitnebula's seven scripts touch no system state at all. They read the filesystem:

| script | what it actually does |
| --- | --- |
| `pkg-scripts.mjs` | reads `package.json`, reports whether a script exists and what it invokes |
| `docs-presence.mjs` | reports whether a `.md` file exists and whether it contains given phrases |
| `file-integrity.mjs` | hashes files, counts declared dependencies |
| `ui-source-census.mjs` | counts pattern occurrences across `.ts` files |
| `testid-census.mjs` | counts pattern occurrences across files |

Only `analysis-shape.mjs` (reads the product's own build output) and `ui-config-shape.mjs` (parses a TypeScript config) are the kind of project-specific code the PRD had in mind.

**The cost is not the writing, it is the defects.** The second dogfooding run against a real implementation produced eight failures. Three were defects in these hand-written scripts, and every one is a bug in generic file-reading logic that a product would have written once:

1. `findReport` in `docs-presence.mjs:59-69` uses `readdirSync` over three fixed directories and does not recurse, while the reports it looks for live in `docs/dev/epic-6/<story>/` — one level deeper (criteria E6-23, E6-28).
2. The same function's search terms are hand-picked regexes that do not match the documents that satisfy the criterion. The reports exist, with the right content, under different wording.
3. `literalHandleKeyCount` in `ui-source-census.mjs:54` counts `"__gitnebula"` with a regex over raw source, so it counts occurrences in **comments** and in the very test file that enforces the convention it measures — reporting 2 where the criterion requires 0 (criterion E6-09).

Three defects in 645 lines of code that is not the operator's product, that every future SpecWitness user rewrites from scratch, and that fails in the direction that matters: a probe reporting FAIL over correct work, or — worse and not yet observed — reporting clean over unmet work.

The strategic frame is the owner's: **SpecWitness should reach automatic or semi-automatic operation.** Today the path from `npm i -g specwitness` to a meaningful first verdict runs through several hundred lines of bespoke Node. That is the single largest barrier to the package being usable by anyone who did not build it.

## Decision

**1. A fifth probe surface, `file`, is added to the closed union in `src/schemas/plan.ts`.**

`src/schemas/plan.ts:436-447` states that widening the union "is an ADR, not an edit". This is that ADR. The union becomes `http | browser | observation | shell | file`, and `PROBE_SURFACES` is extended in step, with the existing two-way pin in `tests/unit/schemas/plan-surfaces.test.ts` continuing to hold.

**2. `file` reads the verification worktree and nothing else.**

It answers static questions about the tree under verification: does a path exist, what does a file contain, how many times does a pattern occur, what does a JSON document hold at a given path. It runs no command, spawns no process, and opens no socket. Its inputs are data in the plan, not a command id — which is precisely why it does not need `observations:` and does not widen the AD-3 command surface. **Nothing a provider writes can become an executable string through this surface**, because there is no execution.

**3. Path access is confined to the worktree, checked before any read.**

A `file` probe may not read outside the checked-out worktree root. `..` traversal, absolute paths and symlinks that resolve outside it are refused as an `InfraError`, never as a product FAIL — SpecWitness could not perform the read, so nothing was adjudicated. This mirrors the origin re-check the browser surface performs after every navigation (`src/surfaces/browser.ts`, the AD-3 comment).

**4. It obeys AD-13 unchanged.**

`file` implements the same `SurfaceExecutor` interface, returns the same `ProbeAttempt`, evaluates assertions mechanically, and never produces a `CriterionStatus`. Retry orchestration, `flaky` marking and error classification stay in `domain/criterion-result.ts`. A new surface is a new *reader*, not a second adjudicator.

**5. Absence is a fact, and its meaning is decided per source — the rule story 7.5 established.**

A missing path read as `exists` is the value `false`, compared like any other value. A missing path read for its *content* is unsatisfied for every comparison: an expectation about text cannot be met by text that does not exist. An unreadable path — a permission error, a directory where a file was named — escapes as an `execError`. The distinction between an absence and an exception is the one `src/surfaces/browser.ts:580-593` protects, and it is carried into this surface deliberately rather than rediscovered.

**6. `observation` keeps its meaning and is not deprecated.**

A command emitting JSON about live system state is what the PRD described and is the right tool for row counts, service introspection and anything requiring the project's own code to run. This ADR narrows what operators *should* reach for it, not what it can do. `analysis-shape.mjs` and `ui-config-shape.mjs` remain correct as observations.

**7. `templates/config.yaml` ships worked `file` examples.**

The three-line template is the second half of the onboarding cost. The template gains commented examples that a new project can uncomment and edit, so that the first useful verdict does not require writing any code at all.

## Consequences

**Good.**

- A new project reaches a meaningful first verdict without writing JavaScript. Five of gitnebula's seven scripts become declarations; a greenfield project of similar shape likely needs none.
- Recursion, glob semantics, comment-aware matching and encoding handling are implemented once, in a tested product, instead of once per project with the defects measured above.
- The three known probe defects become product bugs with corpus fixtures rather than per-project accidents.
- It moves the product toward the semi-automatic operation the roadmap targets: the remaining hand-written surface is the part that genuinely requires the project's own code.

**Costs, accepted.**

- The closed union grows by one, and every place that switches on `surface` grows a branch. That is the cost AD-13 was designed to bound, and the two-way pin keeps schema and executor from drifting.
- A declarative matcher is less expressive than arbitrary Node. Some criteria will still need an `observation`, and the design must not chase completeness — when a check needs a parser, it needs code, and `observation` is where code belongs.
- **A declarative matcher makes it easier to write a probe that passes over unmet work.** This is the failure mode the whole product exists to prevent, and lowering the cost of authoring probes lowers the cost of authoring bad ones. The plan-authoring prompt already refuses to map a criterion it cannot probe safely; that refusal must not weaken because a `file` probe is cheap to emit.

**Not decided here.**

- The concrete assertion vocabulary (`exists`, `contains`, `matches`, `jsonPath`, count comparisons) is the implementing story's, constrained by this ADR's rules 2, 3 and 5.
- Whether `file` can express a before/after comparison the way `observation` does with `mechanics.around`. It reads a static tree, so the burden is on the implementing story to show a real criterion that needs it.
- Retrofitting gitnebula's five scripts. That is a follow-up in the client project, not a condition of this decision.
