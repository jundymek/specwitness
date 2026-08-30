# SpecWitness Decision Log — ADR Index

Maps every required decision topic (brief §71) to its explicit home. AD-n = ARCHITECTURE-SPINE.md invariants; memlogs beside each artifact carry rationale history.

| # | Topic (brief §71) | Decided in |
|---|---|---|
| 1 | TypeScript/Node + npm CLI | ADR-006 §1; spine Stack table |
| 2 | Standalone SpecWitness vs harness integration | ADR-006 §2 |
| 3 | Epic-level verification boundary | ADR-006 §3; PRD §5 non-goals |
| 4 | Verification Contract before implementation | ADR-006 §4; FR-8 (verify refuses unfrozen) |
| 5 | Contract freeze/versioning | ADR-005; AD-5 (spec/meta partition, canonical fingerprint) |
| 6 | AI-assisted planning vs deterministic execution | ADR-006 §5; AD-2 (LLM authority boundary) |
| 7 | Local Claude Code/Codex CLI delegation | ADR-001; AD-4 |
| 8 | No direct API dependency in V0 | ADR-001; FR-15 |
| 9 | No credential scraping | ADR-001; AD-4; NFR-1 |
| 10 | Provider abstraction | AD-2 (envelope + shared invoke gate); FR-11 (roles, fake) |
| 11 | Worktree isolation | ADR-004; AD-8 |
| 12 | Standard Playwright integration | AD (spine Stack: @playwright/test runner over ephemeral generated specs); FR-24; questions doc Q30–32 |
| 13 | Generic project commands/adapters | AD-3 (trusted-command boundary); FR-25/26 (observation + shell-by-config-id) |
| 14 | Evidence-first result model | AD-10, AD-11; FR-28 |
| 15 | PASS/FAIL/NEEDS_HUMAN semantics | AD-6; questions doc Q39–46; ADR-003 (gate failure → FAIL, pending author confirmation) |
| 16 | Infrastructure error separation | AD-6/AD-7; ADR-002 (exit 3); corpus fixture 8 |
| 17 | Local-first storage | PRD §5; AD-8/AD-11; questions doc Q11/12/50/51 (Git vs local, keep-all retention) |
| 18 | No SaaS/UI in MVP | PRD §5 non-goals (explicit list) |
| 19 | Differential verification deferred but architecturally supported | spine Deferred; AR-3 (base+head recorded per run); questions doc Q67 |
| 20 | Mutation testing deferred | spine Deferred; questions doc Q68 |

Supporting decisions not on the §71 list: ADR-002 (exit codes 0/1/2/3/64), AD-13 (probe execution contract), AD-1 (pure domain core), questions doc Q26/27 (explicit ports), Q38 (unplannable criterion ⇒ needs_human), Q65 (provider/model provenance in meta).
