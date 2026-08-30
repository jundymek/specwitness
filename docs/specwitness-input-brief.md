# SpecWitness (né Proofgate) — Founder Input Brief (as received, 2026-08-30)

> Preserved verbatim from the founding product/architecture briefing supplied by jundymek.
> NAMING: the author later renamed the product from "Proofgate" to "SpecWitness" (2026-08-30).
> Occurrences of "Proofgate" below are the historical working name — read them as SpecWitness.
> NOTE: The original message was truncated by the client at Section 58 (mid-"Reasons").
> Sections 59+ (if any existed) were not received and must be re-supplied by the author.
> This document is the authoritative product input for the BMAD planning artifacts under
> `docs/planning-artifacts/`.

======================================================================
0. FIRST ACTIONS
======================================================================

Before producing specifications:

1. Inspect this repository.
2. Detect whether BMAD is already installed or configured.
3. Detect which BMAD version, agents, workflows, templates and conventions are available.
4. If BMAD exists: follow the actual installed BMAD workflow, use its expected artifacts and directory structure, do not invent a parallel planning framework.
5. If BMAD is not installed: determine the appropriate current BMAD setup, initialize it if appropriate, then continue using BMAD conventions.
6. Inspect the local development environment where useful: Node.js, package manager, Git, Claude Code CLI, Codex CLI, Playwright availability.
7. DO NOT implement Proofgate during this phase.
8. Ask questions only when the missing answer genuinely blocks an important product or architecture decision.
9. Otherwise: make a reasonable assumption, clearly record the assumption, continue.
10. Do not silently overturn the product decisions below. If one is technically wrong or creates a serious problem: document the concern, create an ADR / decision entry, explain the alternative, but do not silently redesign the product.

======================================================================
1. WORKING PRODUCT NAME
======================================================================

Working name: Proofgate. The name is temporary. Do not let naming concerns influence architecture.

======================================================================
2. PRODUCT IN ONE SENTENCE
======================================================================

Proofgate is an independent verification gate for agentic software development.

Conceptually: "Your coding agents say the feature is done. Proofgate independently proves whether the assembled feature actually satisfies the original specification."

Alternative framing: "A machine-verifiable Definition of Done for coding agents."

The exact marketing wording is NOT important for MVP. The product behavior is important.

======================================================================
3. WHY THIS PRODUCT EXISTS
======================================================================

Modern coding agents can already: implement features, write unit tests, write integration tests, write Playwright tests, review code, fix their own failures.

Therefore "AI generates tests" is NOT an interesting enough standalone product.

The deeper problem is correlated misunderstanding.

Example requirement: "VAT ID is required for EU companies and optional outside the EU."

A coding agent may misunderstand this as: "VAT ID is optional." It can then:
1. implement exactly that incorrect interpretation,
2. create tests for exactly that behavior,
3. achieve high test coverage,
4. pass lint/typecheck/build,
5. report that the story is complete.

Another reviewing agent may also focus primarily on implementation correctness and fail to notice that the original requirement was misunderstood.

Therefore: GREEN TESTS != CORRECT PRODUCT BEHAVIOR. The system may have perfectly tested the wrong interpretation.

Proofgate exists to create an independent boundary between IMPLEMENTATION and DEFINITION OF DONE.

======================================================================
4. MY EXISTING DEVELOPMENT WORKFLOW
======================================================================

I already have my own multi-agent coding harness. Proofgate is NOT supposed to replace it.

Current workflow:
1. I have an application or feature idea.
2. I plan it using BMAD.
3. BMAD creates: PRD, epics, stories, acceptance criteria, architecture/specification artifacts.
4. Each epic normally contains a maximum of approximately 6-7 stories.
5. One cohort executes one epic.
6. Up to approximately 7 coding agents work in parallel.
7. Normally one coding agent owns one story/task.
8. An additional supervisor agent oversees the cohort.
9. Each coding agent: works in isolation, implements its story, runs tests, creates a PR.
10. PRs can also be independently reviewed with Codex.
11. The supervisor reviews each PR.
12. The supervisor determines whether a story PR is ready to merge.
13. Approved PRs are merged into a dedicated feature branch for the epic (e.g. `feature/epic-07` contains PRs for stories 7.1–7.7).
14. Currently, once all stories have been approved and merged into the epic feature branch, I decide whether `feature/epic-07` can be merged into main/master.

Proofgate should introduce a new gate exactly here.

======================================================================
5. WHERE PROOFGATE ENTERS THE WORKFLOW
======================================================================

The primary Proofgate verification point is:

AFTER: all story PRs belonging to an epic have been implemented, reviewed, approved by the supervisor, merged into the epic feature branch,

BUT BEFORE: feature/epic-X -> main/master.

Conceptual workflow:

BMAD → Epic → (Story 1..7 → Agent → PR → Supervisor → merge) → feature/epic-X → PROOFGATE VERIFY → PASS / FAIL / HUMAN → (PASS → merge to main; FAIL → repair work).

This location in the workflow is deliberate.

======================================================================
6. SUPERVISOR VS PROOFGATE
======================================================================

Proofgate must NOT duplicate the supervisor.

The supervisor performs primarily LOCAL / STORY-LEVEL verification. Typical supervisor question: "Was this story implemented correctly?" Responsibilities: code correctness, architecture, code quality, story acceptance criteria, test quality, implementation sanity, PR readiness, review findings.

Proofgate performs primarily SYSTEM / EPIC-LEVEL verification. Proofgate question: "After composing all accepted stories, does the complete epic actually work according to the original product specification?"

Short version — Supervisor: "Are the pieces good?" Proofgate: "Does the assembled system work?"

This responsibility boundary is fundamental.

======================================================================
7. WHY EPIC-LEVEL VERIFICATION MATTERS
======================================================================

The major target is cross-story and cross-layer failure.

Example: Story A implements frontend, Story B implements backend. Both PRs are individually correct. Frontend sends `status = "approved"`, backend expects `status = "approve"`. Both isolated implementations may pass their own tests. The assembled epic fails.

Other examples:
- one story changes data shape while another story assumes the previous shape,
- authentication middleware conflicts with a newly added endpoint,
- UI displays success while a required database mutation did not happen,
- company creation succeeds but expected audit event is missing,
- repeated user action creates duplicate DB rows,
- admin path works while standard user path returns 500 instead of 403,
- backend validation exists but frontend state prevents correct submission,
- frontend validation exists but backend accepts invalid direct API requests,
- API returns success but response contract is incomplete,
- two independently correct stories create an invalid integrated workflow.

These are the classes of defects Proofgate should be optimized to detect.

======================================================================
8. IMPORTANT: VERIFICATION CONTRACT IS CREATED BEFORE IMPLEMENTATION
======================================================================

Although the main verification RUN occurs after the epic has been assembled, the expected behavior must be captured BEFORE the coding cohort begins.

Conceptual flow: BMAD Epic + Stories → Verification Planner → Verification Contract → FREEZE → Coding Cohort → Epic Feature Branch → Verification Executor.

This prevents implementation from becoming the source of truth for expected behavior.

======================================================================
9. VERIFICATION CONTRACT
======================================================================

Proofgate needs a structured, versioned Verification Contract.

Input: BMAD epic, associated stories, acceptance criteria, relevant project rules, possibly existing product invariants.

Output conceptually: `.proofgate/contracts/epic-07.yaml`

Illustrative example:

```yaml
epic: company-onboarding
criteria:
  - id: E07-01
    description: Authenticated user can create a company
    severity: critical
    type: behavioral
  - id: E07-02
    description: EU company requires VAT ID
    severity: critical
    type: behavioral
  - id: E07-03
    description: Unauthorized user cannot create a company
    severity: critical
    type: security
  - id: E07-04
    description: Successful company creation produces an audit event
    severity: normal
    type: integration
  - id: E07-05
    description: Repeated submission creates exactly one company
    severity: critical
    type: invariant
```

THIS IS ONLY AN EXAMPLE. Do not blindly adopt this schema. Design a proper minimal but extensible domain model.

======================================================================
10. VERIFICATION MUST DESCRIBE BEHAVIOR, NOT IMPLEMENTATION
======================================================================

BAD: "validateVatId() must return false when VAT ID is missing."
GOOD: "A Polish company cannot successfully complete registration without a valid VAT ID."

BAD: "CompanyService.create() must call AuditService.log()."
GOOD: "Successful company creation produces an audit event."

Proofgate should prefer externally observable behavior and system invariants. White-box verification is allowed where appropriate, but implementation-specific coupling should not become the default.

======================================================================
11. CONTRACT IMMUTABILITY / FREEZE
======================================================================

One of the most important product requirements: the coding agent must not be able to silently change the Verification Contract to make its implementation pass.

Forbidden behavior: implementation fails AC → agent edits verification expectation → tests become green.

Proofgate must make this difficult or explicit. For MVP this does NOT require enterprise-grade cryptographic security. But design a proper semantic freeze mechanism.

Possible mechanisms to evaluate: fingerprint/hash, contract version, Git tracking, frozen metadata, explicit regeneration, explicit human approval for contract change.

A legitimate specification correction must be possible. But it must be explicit.

Example: Proofgate detects "Contract and implementation specification appear inconsistent." Result may be NEEDS_HUMAN. The implementation agent must not silently redefine expected behavior.

======================================================================
12. THREE VERDICTS
======================================================================

Proofgate must support: PASS, FAIL, NEEDS_HUMAN.

It must not pretend that every requirement can be objectively verified.

Examples:
- "Unauthorized users cannot create projects." → mechanically verifiable
- "Successful payment creates exactly one transaction." → mechanically verifiable
- "The UI should feel intuitive." → probably NEEDS_HUMAN
- "Design should look professional." → probably NEEDS_HUMAN

Trustworthiness is more important than pretending to automate everything.

======================================================================
13. REQUIREMENT / CRITERION CLASSIFICATION
======================================================================

Design a minimal useful classification model. Possible categories to evaluate: behavioral, integration, invariant, structural, security, performance, deterministic, human. Do not assume all are needed.

Examples: "missing object returns 404" → behavioral; "unauthorized mutation produces no DB change" → security/invariant; "TypeScript strict mode is enabled" → structural; "page loads below an agreed threshold" → performance; "interface feels intuitive" → human.

The classification should help choose a verification strategy.

======================================================================
14. PROOFGATE IS A SEPARATE PROJECT
======================================================================

Proofgate must be implemented as a standalone project. It must NOT initially live inside my proprietary agent harness.

Architecture: My Harness → invokes CLI → Proofgate. My harness is simply the first Proofgate client. Proofgate should also be usable manually from any normal repository.

This separation is intentional because Proofgate may later become a public developer product. Potential future users: Claude Code users, Codex users, Cursor users, GitHub Actions, CI systems, other agentic coding harnesses, individual developers.

Do not create dependencies on my proprietary harness internals.

======================================================================
15. NPM PACKAGE + CLI
======================================================================

The intended V0 distribution model is: an npm package exposing a CLI. Preferred implementation stack: TypeScript + Node.js.

Possible use: `npm install -D proofgate`, `npx proofgate ...`, `pnpm dlx proofgate ...`

Example product-intent commands:

```
proofgate init
proofgate doctor
proofgate contract epic-07
proofgate verify epic-07
proofgate verify epic-07 --base main --head feature/epic-07
proofgate report epic-07
proofgate verify epic-07 --json
```

Future: `proofgate challenge epic-07`

These exact command names are NOT final requirements. Design a coherent CLI. But preserve the general workflow.

======================================================================
16. HOW I WILL USE IT INSIDE MY HARNESS
======================================================================

My harness runs multiple agents in tmux-like terminal sessions. The supervisor has its own terminal. For V0 I want to manually switch to the supervisor terminal and execute something like `proofgate verify epic-07`.

The supervisor terminal is only the INVOCATION LOCATION. Proofgate should NOT execute directly inside the supervisor's mutable workspace. It should create its own isolated verification environment.

======================================================================
17. ISOLATED VERIFICATION ENVIRONMENT
======================================================================

When invoked: Supervisor terminal → `proofgate verify` → Proofgate → isolated verification workspace.

Potential mechanisms: temporary Git worktree, temporary checkout, dedicated temporary directory. Containers may be supported later. Do not require containers for V0 unless there is a strong technical reason.

Requirements: Proofgate must avoid accidentally modifying the supervisor workspace, implementation branch, or source repository state. The verification executor should ideally be effectively read-only toward the implementation. It may create generated verification scripts, temporary Playwright tests, evidence, and logs inside Proofgate-owned temporary/run directories.

Design cleanup carefully. Crashes must not leave uncontrolled processes/worktrees where avoidable.

======================================================================
18. AI USAGE: KEY PRODUCT DECISION
======================================================================

Proofgate DOES use LLMs. But AI must NOT become the final source of truth for verification.

Design philosophy: AI-assisted specification and planning; deterministic execution and evidence.

Conceptually: natural-language specification → LLM → structured Verification Contract → LLM → structured Verification Strategy → [deterministic execution boundary] → Playwright / HTTP / DB / shell assertions → structured evidence → mechanical verdict.

LLM should be used where semantic reasoning is genuinely required. Deterministic tooling should be used wherever possible.

======================================================================
19. WHAT LLM IS GOOD FOR
======================================================================

1. Epic/stories → Verification Contract (interpret natural-language requirements).
2. Verification Contract → Verification Strategy. Example criterion "Removing a user revokes existing sessions" → conceptual scenario: create user, authenticate user, preserve session, remove user as admin, retry request using old session, expect authentication failure.
3. Optional failure explanation: given logs, network trace, source diff, evidence, LLM may generate a root-cause hypothesis.
4. Optional recovery planning: if a planned interaction cannot be executed because UI mechanics changed, an LLM may help find an alternative interaction path.

But LLM must not redefine expected product behavior.

======================================================================
20. WHAT LLM MUST NOT BE AUTHORITATIVE FOR
======================================================================

Avoid: "Ask Claude whether the feature passes."

If the result can be calculated mechanically, calculate it mechanically. LLM should NOT be the sole authority deciding PASS or FAIL when structured assertions can provide that answer.

Example criterion "POST /companies creates exactly one database record": Proofgate should collect before_count/after_count and evaluate `after_count - before_count == 1`, not ask an LLM "Does this look correct?"

Final verdict should derive from structured criterion results.

======================================================================
21. CRITICAL AUTHENTICATION / COST DECISION
======================================================================

For V0, Proofgate MUST NOT require direct LLM API access.

I already pay for and use: Claude Code with a Claude Max subscription; Codex CLI authenticated using ChatGPT OAuth. I do NOT currently invoke Anthropic/OpenAI APIs directly.

I do NOT want Proofgate V0 to require ANTHROPIC_API_KEY or OPENAI_API_KEY or separate per-token API billing.

Instead Proofgate should delegate AI reasoning to the official locally installed agent CLIs.

======================================================================
22. INITIAL AI PROVIDERS
======================================================================

Design an AIProvider / AgentProvider abstraction. Initial adapters should be based on local CLI delegation.

Provider A — Claude Code CLI: use locally installed official `claude` command; support user's existing Claude Code authentication; support Claude subscription-based usage; invoke it using its officially supported non-interactive/programmatic mode; inspect current CLI capabilities rather than assuming outdated flags; never read Claude OAuth/session credential files directly; never copy Claude credentials; never persist Claude credentials; authentication remains the responsibility of official Claude Code CLI.

Provider B — Codex CLI: use locally installed official `codex` command; support existing ChatGPT OAuth authentication; invoke it using officially supported non-interactive/programmatic capabilities; inspect current CLI capabilities instead of assuming outdated flags; never read Codex OAuth credential storage directly; never copy Codex credentials; never persist Codex credentials; authentication remains the responsibility of official Codex CLI.

Proofgate should call these CLIs as subprocesses. Proofgate does NOT need access to OAuth tokens.

======================================================================
23. DO NOT SCRAPE AUTHENTICATION CREDENTIALS
======================================================================

Explicitly forbidden architectural shortcut: reading authentication state directly from files such as `~/.claude/...` or `~/.codex/...` or equivalent credential stores.

Proofgate should behave similarly to a tool invoking git, docker, gh. It delegates authentication to the official tool. Do not reverse engineer authentication tokens.

======================================================================
24. API KEYS AND BILLING SAFETY
======================================================================

Because users may have API-related environment variables configured globally, Proofgate must consider accidental fallback to API billing (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY, or provider-specific equivalents).

During architecture: research and document the CURRENT behavior of supported Claude Code and Codex CLI versions. Do not rely on assumptions. Design appropriate safeguards.

Possible behavior: `proofgate doctor` may report installed/authenticated/subscription-compatible auth per provider and warn when API environment variables exist.

Proofgate should clearly communicate when configuration might cause separate API billing. Do not automatically manipulate or remove environment variables unless this is safe, documented and intentionally designed. Prefer diagnostics and explicit provider modes.

Possible conceptual configuration (do not blindly adopt — design it):

```yaml
ai:
  providers:
    codex:
      adapter: codex-cli
      auth: chatgpt
    claude:
      adapter: claude-code-cli
      auth: subscription
```

======================================================================
25. PROOFGATE SHOULD WORK WITH ONE OR BOTH AGENTS
======================================================================

User may have only Claude Code, only Codex, or both. Proofgate should not require both.

Possible role configuration: contract planner: Codex; verification planner: Codex; failure explanation: Claude — or all roles may use one provider.

For my own initial dogfooding: coding agents are primarily Claude Code based, therefore using Codex for independent verification planning may provide useful context/model diversity. But this must NOT become a hard-coded product assumption.

======================================================================
26. PROOFGATE SHOULD BE ABLE TO VERIFY WITHOUT AI
======================================================================

Important architectural property: once a Verification Contract and executable Verification Strategy already exist, Proofgate should ideally be capable of running verification without another LLM call. Conceptually `proofgate verify epic-07 --no-ai` or equivalent architecture (exact CLI option not fixed).

Goal: repeated verification should be deterministic, cheaper, faster, reproducible, less flaky. AI should primarily help CREATE verification; it should not necessarily be required to RUN identical verification repeatedly.

======================================================================
27. AI MAY ADAPT MECHANICS, NOT EXPECTATIONS
======================================================================

Suppose a verification strategy expects `click "Create company"` but the UI later labels the action "Add organization". A verification helper may discover the new interaction and adapt: locator, navigation, technical interaction strategy.

It must NOT change "EU company requires VAT ID" into "VAT ID is optional."

Distinguish HOW to verify from WHAT must be true. Expected behavior belongs to the frozen contract.

======================================================================
28. PROJECT CONFIGURATION
======================================================================

Proofgate must be project-stack-independent where practical. Do NOT hardcode React, pnpm, Django, Node backend, PostgreSQL. Provide a project configuration layer.

Illustrative example (design a clean minimal config model; this is only illustrative):

```yaml
setup:
  install: pnpm install
checks:
  lint: pnpm lint
  typecheck: pnpm typecheck
  unit: pnpm test
  build: pnpm build
services:
  frontend:
    command: pnpm dev
    url: http://localhost:3000
  backend:
    command: python manage.py runserver
    url: http://localhost:8000
database:
  reset:
    command: ./scripts/reset-test-db.sh
```

======================================================================
29. PROOFGATE VERIFICATION PIPELINE
======================================================================

The pipeline should be staged. Likely high-level process:

1. Load project configuration.
2. Resolve epic and Verification Contract.
3. Validate contract/fingerprint/version.
4. Resolve base/head revisions.
5. Create isolated Git worktree/environment.
6. Prepare dependencies.
7. Run deterministic gates.
8. Stop early if deterministic gates prove implementation is not viable.
9. Start required services.
10. Wait for explicit readiness/health.
11. Prepare deterministic test data/state.
12. Execute behavioral/integration verification.
13. Collect evidence.
14. Determine each CriterionResult.
15. Aggregate final verdict mechanically.
16. Produce human-readable report.
17. Produce machine-readable JSON report.
18. Store run metadata/evidence locally.
19. Clean up services/worktree/resources.

Design this pipeline formally.

======================================================================
30. DETERMINISTIC GATES FIRST
======================================================================

Do not spend AI/browser resources if normal tooling already proves the branch is broken.

Project-configurable examples: install, lint, typecheck, unit tests, integration tests, build, migrations, existing E2E, schema validation, static/security checks.

Example: if build fails, Proofgate should report a deterministic gate failure. Do not invoke expensive semantic verification unnecessarily.

======================================================================
31. FAILURE TYPES MUST BE DISTINCT
======================================================================

Critical distinction: PRODUCT VERIFICATION FAILURE is different from PROOFGATE INFRASTRUCTURE FAILURE.

FAIL example: criterion says unauthorized requests must return 403; actual result is 500. This is a real verification failure.

INFRASTRUCTURE ERROR example: backend process cannot start because required test dependency is unavailable. Proofgate cannot determine whether the requirement passes.

Do NOT label infrastructure problems as product FAIL. Design explicit models for: criterion PASS, criterion FAIL, criterion NEEDS_HUMAN, skipped/not-executable if needed, run infrastructure error.

======================================================================
32. BEHAVIORAL VERIFICATION INTERFACES
======================================================================

Proofgate should eventually support multiple verification surfaces. For MVP evaluate:

1. Browser via Playwright.
2. HTTP/API.
3. Database/state verification.
4. Command/shell assertions where configured.
5. Logs/process output.

The most important rule: use the lowest-level deterministic mechanism appropriate for the criterion.

Examples: "Company creation returns HTTP 201" → HTTP, no browser necessary. "Frontend displays backend validation error" → requires browser behavior. "Successful company creation produces audit event" → may require browser/API + DB observation.

======================================================================
33. PLAYWRIGHT
======================================================================

Prefer standard Playwright ecosystem. Do not build a proprietary browser automation framework.

Architectural questions to resolve: should Proofgate depend directly on Playwright? should it use project's Playwright? should generated verification tests be ephemeral? should accepted tests ever be persisted? where are traces stored? how are locators selected? how is deterministic test data supplied? how are browser failures classified?

Strong preference: standard tooling over proprietary test formats.

======================================================================
34. DATABASE VERIFICATION
======================================================================

Proofgate should not initially attempt to implement native adapters for every database technology. Evaluate a generic strategy.

Potential approaches: project-configured verification commands, test-only query adapter, HTTP test endpoints where appropriate, SQL adapter later, scripts that emit structured JSON.

Example conceptual contract: database observation command `./scripts/proofgate/company-count.sh` returns `{ "count": 3 }`. Proofgate can compare before/after.

Design something safe and stack-neutral. Do not create a giant database abstraction in V0.

======================================================================
35. EVIDENCE IS A FIRST-CLASS PRODUCT CONCEPT
======================================================================

Proofgate must not return "Looks good." Every mechanically verified criterion should have structured evidence.

Potential evidence: scenario inputs, assertion results, HTTP request/response metadata, sanitized response bodies, Playwright trace, screenshot, console output, browser errors, DB observations, before/after state, command output, relevant server logs, durations.

Example:

```json
{
  "criterion": "E07-05",
  "status": "FAIL",
  "expected": { "companiesCreated": 1 },
  "actual": { "companiesCreated": 2 },
  "evidence": { "requests": 2, "databaseRowsCreated": 2, "trace": "trace.zip" }
}
```

Design a typed evidence model. Do not dump arbitrary unstructured LLM text as the primary evidence format.

======================================================================
36. HUMAN-READABLE CLI OUTPUT
======================================================================

Desired experience conceptually: sectioned terminal report (Contract loaded/fingerprint valid; Revision base/head; Environment readiness; Deterministic gates; Verification per-criterion ✓/✗/?; PASS/FAIL/NEEDS_HUMAN counts; VERDICT; Evidence path `.proofgate/runs/<run-id>/`).

Exact UI can differ. Keep it terminal-native and useful. No web UI.

======================================================================
37. MACHINE-READABLE OUTPUT
======================================================================

The harness must eventually be able to consume Proofgate. Provide stable JSON output. Concept: `proofgate verify epic-07 --json` →

```json
{
  "schemaVersion": 1,
  "epic": "epic-07",
  "runId": "...",
  "base": "main",
  "head": "feature/epic-07",
  "verdict": "FAIL",
  "criteria": [
    { "id": "E07-03", "status": "FAIL", "expected": "...", "actual": "...", "evidence": [] }
  ]
}
```

Design a stable schema.

======================================================================
38. EXIT CODES
======================================================================

Design predictable process exit codes. Initial concept: 0 = verification PASS; 1 = verification FAIL; 2 = NEEDS_HUMAN; 3 = Proofgate/infrastructure failure. Review whether this is ideal.

Important: automations must distinguish "application failed verification" from "Proofgate was unable to perform verification."

======================================================================
39. FAILURE -> REPAIR FLOW
======================================================================

Proofgate should NOT implement repair agents in V0. But result output should make repair automation easy later.

Future workflow: Proofgate returns failing criteria (e.g. E07-03 FAIL, E07-05 FAIL) → harness creates repair tasks per criterion → each repair agent receives: original epic context, failed criterion, expected result, actual result, evidence, possibly an optional Proofgate root-cause hypothesis → repair PRs reviewed by supervisor → merged into feature branch → Proofgate runs again.

Design outputs with this future workflow in mind.

======================================================================
40. DIFFERENTIAL VERIFICATION - IMPORTANT FUTURE FEATURE
======================================================================

Do NOT necessarily implement this in initial MVP. But architecture must support it cleanly.

Concept: compare BASE and HEAD. Especially useful for regression tests / bug fixes.

Example: bug "double click creates duplicate invoice"; agent creates a regression test. Expected: BASE FAIL, HEAD PASS. This proves the bug existed, behavior changed, the test catches the old defect, the fix produces expected behavior.

Suspicious case: BASE PASS + HEAD PASS → "The new regression test does not demonstrate the reported defect."

Future CLI concept: `proofgate verify epic-07 --base main --head feature/epic-07`.

Even if V0 primarily verifies HEAD, model revisions/runs in a way that BASE/HEAD comparison can be added without rewriting core domain logic.

======================================================================
41. MUTATION / CHALLENGE VERIFICATION - FUTURE FEATURE
======================================================================

Do NOT implement in MVP unless architecture makes a tiny foundational piece necessary.

Future problem: AI can cheaply generate many tests, but do those tests detect broken behavior? Challenge system may deliberately introduce temporary defects (disable validation, invert EU condition, accept blank value, remove backend validation); relevant verification should then FAIL. If it remains green, the test/verification is weak.

Future concept: `proofgate challenge epic-07` with a verification-strength report (killed/survived mutations). Could become an important future differentiator. Not MVP.

======================================================================
42. PERSISTENT / LIVING VERIFICATION SPECIFICATION
======================================================================

Long-term vision: Verification Contracts accumulate (`.proofgate/contracts/authentication.yaml`, `company-onboarding.yaml`, `billing.yaml`, ...). When a new epic is ready, Proofgate may eventually run the new epic contract + critical historical contracts. This becomes a living executable product specification. Specifications do not disappear after code generation; they become persistent product expectations.

MVP can focus on current-epic verification.

======================================================================
43. LOCAL-FIRST
======================================================================

Proofgate V0 is local-first. No cloud required. No account required. No SaaS required. Evidence/run history should initially live locally.

Possible structure (exact structure should be designed):

```
.proofgate/
  config.*
  contracts/
  plans/
  runs/
```

======================================================================
44. NO UI / SAAS IN MVP
======================================================================

Explicitly DO NOT BUILD: Next.js dashboard, React dashboard, cloud service, authentication, user accounts, Stripe, billing, organization management, team dashboard, cloud browser farm, Slack integration, Jira integration, Linear integration, GitHub App, hosted execution, Chrome extension.

Proofgate V0 is CLI infrastructure.

======================================================================
45. MCP / CI / GITHUB ARE FUTURE INTEGRATIONS
======================================================================

Do not implement them now unless needed for architecture compatibility. Future possibilities: MCP server, Claude Code integration, Codex integration beyond local CLI provider, Cursor, GitHub Actions, GitHub status checks, GitLab CI, other agentic harnesses. Core architecture should not prevent them. But they are NOT MVP.

======================================================================
46. PROOFGATE DOCTOR
======================================================================

Strongly consider a diagnostic command `proofgate doctor` reporting: Runtime (Node, Git, package manager, Playwright capability); Claude Code (binary found, non-interactive mode available, authentication appears usable, configured provider mode, API env var warnings); Codex (same); Project (config valid, base branch exists, required commands available).

This is particularly useful because Proofgate depends on local developer tooling. Design how authentication readiness can be checked without reading secret credentials.

======================================================================
47. SECURITY MODEL
======================================================================

Proofgate can execute: project-configured shell commands, applications, browsers, database scripts, local AI CLIs. Treat this seriously. Threat-model the MVP.

Important principles:
1. Do not allow raw LLM output to execute arbitrary privileged shell commands.
2. Project execution commands should come from trusted project configuration.
3. Generated verification plans should use constrained operations/adapters wherever possible.
4. Do not connect to production environments by default.
5. Destructive DB operations must be explicitly test/local environment oriented.
6. Redact: passwords, API tokens, Authorization headers, cookies where necessary, secrets.
7. Evidence must avoid unnecessary sensitive data.
8. Official Claude/Codex CLI remains responsible for its own authentication.
9. Proofgate must never store OAuth credentials.
10. Processes/worktrees should be cleaned reliably.
11. Document the trust boundary: Proofgate operates on a repository the user intentionally chose to verify.

======================================================================
48. DETERMINISTIC TEST DATA
======================================================================

Verification should be reproducible. Design support for deterministic test data. Possible principles: stable seeds, explicit fixtures, repeatable setup, clean database state, scenario input stored in evidence.

Same verification plan should ideally produce the same inputs. Avoid LLM randomly generating different test data on every verification run unless semantic exploration is explicitly requested.

======================================================================
49. RETRIES / FLAKINESS
======================================================================

Do not hide failures using automatic retries. Design clear semantics. Potential distinction: deterministic failure, execution flake, infrastructure flake, confirmed application defect.

If retries exist: record them, expose them, never silently convert flaky behavior into PASS. Proofgate itself must build trust.

======================================================================
50. GOLDEN VERIFICATION CORPUS
======================================================================

Proofgate is itself a verification system. Its own testing standard must be unusually strong. Create a Golden Verification Corpus: small intentionally designed fixture repositories/apps with known outcomes.

Potential fixtures:
1. Everything correct → PASS
2. Frontend succeeds but API contract is wrong → FAIL
3. UI success message but DB mutation missing → FAIL
4. Permission violation → FAIL
5. Double submission creates duplicate rows → FAIL
6. Subjective criterion → NEEDS_HUMAN
7. Build broken → deterministic gate failure
8. Service cannot start → infrastructure error, NOT product FAIL
9. Verification Contract fingerprint modified → contract integrity error / explicit handling
10. Multiple story modules individually correct but integrated epic broken → FAIL
11. LLM unavailable but pre-generated deterministic plan exists → verification still executes where supported
12. Future BASE/HEAD regression scenario → suitable for later differential testing

Exact fixtures may differ, but the concept is mandatory. Known expected outcomes must not be defined dynamically by the same implementation being tested.

======================================================================
51. TESTING STRATEGY FOR PROOFGATE ITSELF
======================================================================

Plan at minimum:

UNIT TESTS for: config parser, Verification Contract schema, criterion model, verdict aggregation, evidence model, result JSON, fingerprint/versioning, AI provider abstraction, command execution abstraction, error classification.

INTEGRATION TESTS for: temporary Git repos, Git worktrees, service lifecycle, process cleanup, CLI exit codes, Claude/Codex adapter mocks/fakes, project commands, JSON output, run storage.

END-TO-END TESTS against Golden Verification Corpus.

Do not rely only on mocked LLM calls. For deterministic core behavior use deterministic fixtures. Real-agent integration tests may exist separately and should not make the entire suite depend on external subscription availability.

======================================================================
52. AI PROVIDER TESTABILITY
======================================================================

The Claude Code/Codex CLI adapters must be abstracted so tests can use fake providers. Conceptually: AgentProvider → ClaudeCodeCliProvider / CodexCliProvider / FakeAgentProvider.

Domain tests should not spawn real Claude/Codex processes. Separate provider integration tests from core product logic.

======================================================================
53. STRUCTURED AI OUTPUT
======================================================================

When LLM is used for contract/strategy generation: prefer schema-constrained structured results. Do not build the core around parsing arbitrary Markdown responses.

Flow: LLM → schema validation → valid → domain model | invalid → controlled retry/error.

Use versioned schemas. The LLM does not directly write arbitrary internal state without validation.

======================================================================
54. INITIAL PRODUCT HYPOTHESIS
======================================================================

The first goal is NOT revenue. The first goal is dogfooding and hypothesis validation.

Hypothesis: "Independent epic-level verification detects real product defects that passed coding-agent tests and supervisor/Codex review."

I want to run Proofgate on real work produced by my harness. Measure approximately the first multiple epics / roughly 30-50 agentic tasks.

Track: defects caught by coding agent tests; defects caught by Codex review; defects caught by supervisor; defects caught uniquely by Proofgate; Proofgate duplicate findings; Proofgate false positives; NEEDS_HUMAN count/rate; infrastructure errors; verification duration; LLM usage; retry/flakiness rate.

Most important metric: UNIQUE REAL DEFECTS FOUND BY PROOFGATE AFTER EARLIER QUALITY GATES PASSED.

If Proofgate finds 0 unique meaningful defects over substantial real usage, the product hypothesis may be weak. If Proofgate repeatedly finds real integration/specification errors that earlier gates miss, we have evidence to continue.

Design local instrumentation for this validation. Do NOT add cloud telemetry for this purpose.

======================================================================
55. NORTH-STAR MVP QUESTION
======================================================================

Everything in MVP should serve this question:

"After several coding agents and a supervisor believe an epic is complete, can Proofgate independently provide reproducible evidence showing whether the assembled epic is actually safe to merge?"

If a proposed feature does not materially improve our ability to answer that question: defer it.

======================================================================
56. MVP PROBABLE SCOPE
======================================================================

Strongly consider the following for V0/V1: standalone npm package; TypeScript/Node CLI; `init`; `doctor`; project configuration; BMAD epic/story ingestion; normalized internal EpicSpec if appropriate; Verification Contract generation; Claude Code CLI adapter; Codex CLI adapter; no direct API requirement; structured LLM output validation; contract version/fingerprint; isolated Git worktree; deterministic project gates; service lifecycle; health/readiness; Playwright verification; basic HTTP verification; minimal generic DB observation mechanism; deterministic test data; evidence; PASS/FAIL/NEEDS_HUMAN; infrastructure error classification; human CLI report; JSON output; stable exit codes; local run storage; cleanup; Golden Verification Corpus; local Proofgate value metrics.

Challenge this list during planning. Bias toward the smallest genuinely useful version.

======================================================================
57. EXPLICITLY DEFER
======================================================================

Unless a foundational abstraction is required, defer: SaaS; dashboard; cloud; accounts; billing; GitHub App; MCP server; automated repair agents; full persistent regression execution; mutation testing; differential BASE/HEAD verification beyond architecture support; cloud browser infrastructure; mobile testing; visual regression platform; accessibility platform; native database integrations for every database; direct OpenAI API integration; direct Anthropic API integration; arbitrary multi-provider platform complexity.

======================================================================
58. TECHNOLOGY
======================================================================

Preferred: TypeScript + Node.js

Reasons

[Sections 59–75 were truncated in the original message and re-supplied verbatim by the author on 2026-08-30 — see docs/specwitness-input-brief-part2.md. The header note about truncation is retained for historical accuracy.]
