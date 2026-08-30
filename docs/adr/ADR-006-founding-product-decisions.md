# ADR-006: Founding product decisions (standalone TS/Node npm CLI; epic-level gate; contract-before-implementation)

- **Status:** Accepted (founder decisions, brief §14–15, §5–8, §58, §68; ratified in planning)
- **Date:** 2026-08-30

## Decisions

1. **TypeScript + Node.js, distributed as an npm package with a CLI** (`specwitness`, `npx`-runnable). Fits the target audience (JS-ecosystem agentic developers), the Playwright ecosystem, and the harness's subprocess invocation model. Node floor >=22.12 per the spine's reviewer-verified stack.
2. **Standalone product, not a harness feature.** SpecWitness lives in its own repo/package with zero dependencies on the author's proprietary harness; the harness is merely client #1 invoking the CLI like `git`/`gh`. Protects the future public-product option and forces a clean external contract (exit codes + JSON).
3. **Epic-level verification boundary.** The gate sits after all story PRs are merged into the epic branch and before merge to base. The supervisor answers "are the pieces good?"; SpecWitness answers "does the assembled system work?". Story-level review is explicitly out of scope — targeting the cross-story/cross-layer defect classes story-level gates structurally miss.
4. **Verification Contract precedes implementation.** The contract is generated from BMAD planning artifacts and frozen *before* the coding cohort starts, so expected behavior can never be derived from the implementation that is being judged (defeats correlated misunderstanding — the product's core insight).
5. **AI-assisted planning, deterministic execution.** LLMs author contracts/plans (semantic reasoning); execution, assertions, and verdicts are mechanical. If something can be computed, it is computed (brief principles 6–8).

## Consequences

- The external contract (CLI flags, exit codes, JSON schema) is a public API from day one and is versioned accordingly.
- Any future harness-specific convenience must land as configuration or documentation, never as a code dependency.
- A criterion that cannot be mechanically verified must surface as NEEDS_HUMAN rather than being faked — trust over coverage.
