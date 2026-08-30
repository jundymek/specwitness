# SpecWitness — Founder Input Brief, Part 2 (§59–75, re-supplied 2026-08-30)

> The original briefing was truncated at §58; the author re-supplied the tail verbatim.
> As in part 1, "Proofgate" is the historical working name — read it as SpecWitness.

======================================================================
59. CORE DOMAIN MODEL
======================================================================

During architecture, explicitly design the core domain.

Likely concepts include: ProjectConfig, EpicSpec, StorySpec, VerificationContract, VerificationContractVersion / Fingerprint, Criterion, CriterionType, Severity, VerificationStrategy, VerificationStep, Assertion, Observation, Evidence, CriterionResult, VerificationRun, VerificationVerdict, InfrastructureError, AgentProvider, ExecutionEnvironment, ServiceDefinition, GateDefinition.

These names are illustrative. Choose the right domain terminology.

The important point: stabilize these contracts before parallel implementation begins.

======================================================================
60. IMPORTANT ARCHITECTURAL QUESTIONS
======================================================================

Explicitly resolve during BMAD architecture planning:

1. How does Proofgate locate BMAD epics and stories?
2. How tightly should Proofgate depend on BMAD file layout?
3. Should it normalize BMAD input into a provider-independent EpicSpec?
4. How are non-BMAD specs supported later?
5. What exactly is VerificationContract?
6. What belongs in the contract versus execution strategy?
7. How are criteria typed?
8. How is the contract versioned/frozen?
9. How are legitimate requirement changes approved?
10. What creates the contract fingerprint?
11. What is stored in Git?
12. What is stored only inside local runs?
13. What is project config format?
14. How are commands defined?
15. How are commands safely executed?
16. How are environment variables handled?
17. How are secrets redacted?
18. How is an isolated worktree created?
19. How is worktree cleanup guaranteed?
20. How are stale crashed runs cleaned?
21. Where can Proofgate generate temporary files?
22. How does the executor remain effectively read-only toward application source?
23. How are services started?
24. How are they stopped?
25. How are child processes handled?
26. How are ports allocated?
27. How are port collisions prevented?
28. How is service readiness determined?
29. What happens when readiness times out?
30. How is Playwright integrated?
31. Are generated Playwright artifacts ephemeral?
32. How are traces captured?
33. How are HTTP checks represented?
34. How are DB observations represented generically?
35. Should generic project verification commands return JSON?
36. How is deterministic test data represented?
37. How are criteria mapped to executable strategies?
38. What happens if a criterion cannot be transformed into a safe executable strategy?
39. What precisely triggers NEEDS_HUMAN?
40. How is criterion PASS calculated?
41. How is criterion FAIL calculated?
42. How is infrastructure error represented?
43. How are retries handled?
44. How are flakes surfaced?
45. How is a final run verdict aggregated?
46. What if one critical criterion FAILs and several are NEEDS_HUMAN?
47. What evidence types are supported?
48. How are evidence files referenced from JSON?
49. How is evidence sanitized?
50. How are runs stored?
51. What is run retention locally?
52. How does `report` reconstruct previous runs?
53. What is the stable external JSON interface?
54. What exit codes should be stable?
55. How does the external harness consume the result?
56. How are Claude Code and Codex CLI discovered?
57. How is non-interactive support detected?
58. How is authentication readiness checked safely?
59. How do we avoid reading OAuth secrets?
60. How are potentially dangerous API-key environment variables reported?
61. What is the AgentProvider interface?
62. How are fake AI providers used in tests?
63. How is LLM output schema validated?
64. How are LLM retries bounded?
65. How is model/provider metadata stored in the contract/run for reproducibility?
66. Can existing contracts be verified without LLM?
67. How will future differential verification fit?
68. How will future mutation testing fit?
69. How will historical contracts become a regression suite?
70. How do we measure unique Proofgate value during dogfooding?

For meaningful decisions: create ADRs. Do not answer them only in passing.

======================================================================
61. BMAD PLANNING FOR MY MULTI-AGENT HARNESS
======================================================================

After product/architecture decisions are stable, create implementation epics and stories suitable for my harness.

My execution constraints: one epic = normally one agent cohort; maximum approximately 6-7 stories in an epic; up to approximately 7 coding agents can work in parallel; one supervisor reviews resulting PRs.

Important: DO NOT artificially create 7 stories just because 7 agents exist. An epic may have 2, 3, 4, 5, 6, or 7 stories. Use only as many as make architectural sense.

======================================================================
62. PARALLELIZATION RULES
======================================================================

Stories in the same epic should be independently implementable where practical. Minimize overlapping file ownership.

Avoid plans such as: Agent A invents VerificationContract; Agent B simultaneously invents Criterion; Agent C simultaneously builds CLI around assumptions about both. That is bad parallelization.

Foundational shared contracts must be stabilized BEFORE aggressive parallel work. If necessary: create a small foundational epic first. Example conceptual shape: EPIC 1 — core domain contracts / architecture foundations; then EPIC 2 — several independent adapters/modules in parallel.

Do not optimize for maximum number of concurrent agents. Optimize for: correct parallelization with low merge conflict and low architectural divergence.

======================================================================
63. STORY QUALITY
======================================================================

Every implementation story must include: title, goal, business/technical context, exact scope, explicit out-of-scope, acceptance criteria, likely modules/files, dependencies, upstream contracts/interfaces it relies upon, tests required, integration expectations, manual verification if necessary, security concerns where applicable, failure modes to consider.

A coding agent should be able to take ONE story and implement it without having to redesign the product.

======================================================================
64. EACH PR MUST LEAVE REPOSITORY COHERENT
======================================================================

My supervisor reviews each PR independently. Therefore avoid stories where PR A knowingly breaks the repository and PR B is required later to make it work. Use feature flags, abstractions, staged foundations, or different epic sequencing where necessary. Dependencies must be explicit.

======================================================================
65. EXPECTED HIGH-LEVEL EPIC SHAPE
======================================================================

Do NOT blindly use this. Architecture should determine the final decomposition. However, a reasonable plan may resemble:

Epic 1: Core domain + project configuration + CLI foundation
Epic 2: BMAD ingestion + Verification Contract + AI planner + freeze
Epic 3: Git isolation + process/service execution + deterministic gates
Epic 4: Behavioral verification adapters: Playwright / HTTP / state observation
Epic 5: Evidence + verdict + reports + machine-readable integration
Epic 6: Golden Verification Corpus + reliability/hardening
Epic 7: Real dogfooding + value measurement

This is guidance only. If architecture suggests a better decomposition, use it.

======================================================================
66. DOGFOODING IS PART OF MVP
======================================================================

The MVP is NOT complete just because "CLI works on synthetic tests."

Final phase must include running Proofgate against real work produced by my agent harness. Real workflow: BMAD epic → coding cohort → story PRs → supervisor approvals → feature branch → proofgate verify <epic> → evidence.

We need to evaluate whether Proofgate finds defects earlier gates missed. This is part of product validation.

======================================================================
67. SUCCESS CRITERIA FOR V0
======================================================================

At minimum V0 should demonstrate:

1. Proofgate can initialize in an arbitrary compatible repository.
2. Proofgate can locate/read a BMAD epic and stories.
3. Proofgate can use local Claude Code or Codex CLI without direct API keys.
4. Proofgate can generate a structured Verification Contract.
5. Contract can be frozen/fingerprinted.
6. Proofgate can create an isolated verification environment.
7. Proofgate can run configured deterministic checks.
8. Proofgate can start a real application.
9. Proofgate can execute at least browser/API verification.
10. Proofgate can collect deterministic evidence.
11. Proofgate can distinguish PASS / FAIL / NEEDS_HUMAN / INFRASTRUCTURE ERROR.
12. Proofgate can generate a human report.
13. Proofgate can generate stable JSON.
14. Proofgate returns predictable exit codes.
15. Proofgate cleans up resources.
16. Golden fixtures prove known PASS/FAIL outcomes.
17. At least one real epic from my harness can be verified.
18. We can record whether Proofgate found something previous gates missed.

======================================================================
68. PRODUCT PRINCIPLES
======================================================================

Treat these as architectural principles:

1. Verification over generation.
2. Evidence over AI opinion.
3. Specification before implementation.
4. Frozen expectations.
5. Behavioral verification over implementation coupling.
6. Deterministic checks before expensive AI.
7. AI for semantic reasoning, not mechanical truth.
8. PASS/FAIL should be computed wherever possible.
9. Independent verification context.
10. Supervisor and Proofgate have different jobs.
11. Epic-level integration is the primary initial verification scope.
12. Local-first.
13. CLI-first.
14. npm-first.
15. Use developer subscriptions already available through official agent CLIs.
16. No required LLM APIs in V0.
17. Never scrape OAuth credentials.
18. Use official Claude Code/Codex CLI as subprocess boundaries.
19. Proofgate must work with one provider.
20. Proofgate should ideally rerun existing verification without LLM.
21. Standard ecosystems over proprietary testing frameworks.
22. Playwright over building a browser framework.
23. No SaaS before dogfooding proves value.
24. Infrastructure error != verification failure.
25. Subjective requirement != fake PASS.
26. Deterministic test data.
27. No silent flaky retries.
28. Evidence must allow investigation.
29. Proofgate must stay independent from my proprietary harness.
30. Scope must be aggressively controlled.

======================================================================
69. THINGS THAT WOULD MAKE THIS PROJECT FAIL
======================================================================

Actively design against: multiple agents inventing incompatible core abstractions; Verification Contract being coupled to one application stack; verification being only another LLM code review; same implementation context defining its own success criteria; LLM returning arbitrary PASS/FAIL opinions; verifier editing code it is judging; accidental direct API billing; reading OAuth credential files; unclear PASS semantics; unclear FAIL vs infrastructure error; flaky verification silently passing; Proofgate requiring my custom harness; premature SaaS/dashboard work; excessive provider abstraction before useful MVP; giant generic database layer; proprietary replacement for Playwright; mutation testing too early; trying to test every subjective requirement; implementing before domain contracts stabilize; maximizing agent count instead of correct parallelization.

======================================================================
70. WHAT I WANT YOU TO PRODUCE NOW
======================================================================

Using the appropriate BMAD workflow available in this repository, produce the complete planning package. I expect at minimum:

1. Product brief / product vision. 2. Problem definition. 3. Target initial user: me / developer using agentic development. 4. PRD. 5. Product hypothesis. 6. MVP scope. 7. Explicit non-goals. 8. Functional requirements. 9. Non-functional requirements. 10. Architecture. 11. Core domain model. 12. Verification Contract design. 13. Criterion model. 14. Verification Strategy model. 15. Evidence model. 16. Verdict/error model. 17. CLI UX design. 18. npm/package architecture. 19. Local project configuration design. 20. BMAD ingestion strategy. 21. Internal normalized specification strategy. 22. Git worktree/isolation architecture. 23. Command/process execution architecture. 24. Service lifecycle architecture. 25. Playwright integration design. 26. HTTP verification design. 27. Generic DB/state observation design. 28. AIProvider/AgentProvider architecture. 29. Claude Code CLI adapter design. 30. Codex CLI adapter design. 31. authentication/billing safety design. 32. structured AI output design. 33. deterministic rerun/no-AI design. 34. local run/evidence storage. 35. security threat model. 36. secrets/evidence redaction design. 37. deterministic test data strategy. 38. retry/flakiness policy. 39. testing strategy. 40. Golden Verification Corpus. 41. dogfooding plan. 42. local product-value metrics. 43. ADRs / decision log. 44. epics. 45. implementation-ready stories. 46. dependency graph. 47. recommended cohort execution order. 48. parallelization notes for every epic. 49. risks. 50. deferred roadmap.

======================================================================
71. REQUIRED ADR TOPICS
======================================================================

Create ADRs or equivalent explicit architectural decisions for important topics including at least:

TypeScript/Node + npm CLI; standalone Proofgate vs harness integration; epic-level verification boundary; Verification Contract before implementation; contract freeze/versioning; AI-assisted planning vs deterministic execution; local Claude Code/Codex CLI delegation; no direct API dependency in V0; no credential scraping; provider abstraction; worktree isolation; standard Playwright integration; generic project commands/adapters; evidence-first result model; PASS/FAIL/NEEDS_HUMAN semantics; infrastructure error separation; local-first storage; no SaaS/UI in MVP; differential verification deferred but supported architecturally; mutation testing deferred.

======================================================================
72. FINAL IMPLEMENTATION ROADMAP FORMAT
======================================================================

At the end of planning provide a concise roadmap exactly in this style:

EPIC N — <name> / Purpose / Stories / Dependencies / Can run in parallel / Must run sequentially / Shared contracts that must already be stable / Exit criteria — for all epics.

Then provide: "MVP READY WHEN" (bullets), "DO NOT BUILD YET" (bullets), and "FIRST REAL DOGFOODING PROCEDURE" describing exactly how to use Proofgate for its first real epic (BMAD → Proofgate contract → coding cohort → supervisor PR reviews → merge story PRs to epic branch → Proofgate verify → inspect evidence → repair if required → rerun → merge epic to main), including concrete example commands.

======================================================================
73. PLANNING QUALITY BAR
======================================================================

Do not optimize for documentation volume. Optimize for: removing ambiguity before multiple implementation agents start working.

I would rather have 5 precise architecture decisions than 50 pages of generic developer-tool prose. Every implementation story should be sufficiently specified that an independent coding agent can execute it without inventing fundamental architecture. Shared interfaces must be stabilized early. Avoid premature implementation.

======================================================================
74. FINAL QUESTION ALL DECISIONS MUST SUPPORT
======================================================================

Every design decision should ultimately support this question:

"After several coding agents, tests, Codex review and a supervisor all believe an epic is complete, can Proofgate independently provide reproducible evidence that tells me whether the assembled epic actually satisfies the original specification and is safe to merge?"

If a proposed MVP feature does not materially improve our ability to answer that question: defer it.

======================================================================
75. START NOW
======================================================================

Start by: 1. inspecting the repository, 2. inspecting the available BMAD setup/workflows, 3. inspecting relevant local CLI/tool capabilities where useful, 4. identifying any genuinely blocking questions, 5. then executing the BMAD planning process.

Do NOT implement production code until the planning artifacts, architecture, epics and stories are complete and I explicitly approve implementation.
