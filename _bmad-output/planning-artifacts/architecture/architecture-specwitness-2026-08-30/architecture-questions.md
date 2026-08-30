# SpecWitness — Answers to the 70 Architectural Questions (brief §60)

Each answer is binding and cites where it lives (AD-n = ARCHITECTURE-SPINE.md; ADR-n = docs/adr/; FR-n = PRD). Questions whose decision first appears **here** are marked ★ and mirrored into the spine/ADRs where load-bearing.

**Ingestion & specs**
1. **Locating BMAD epics/stories:** via config `planning.planningArtifacts` / `planning.implementationArtifacts` roots + epic id normalized by `domain/ids.ts`; reads the epics file and per-story markdown (`## Story`, `## Acceptance Criteria`). (FR-5; addendum §A)
2. **Coupling to BMAD layout:** confined to `ingest/bmad-v6`; nothing outside `ingest/` may import BMAD types. (AD-1; FR-6)
3. **Normalize to EpicSpec:** yes — versioned, source-independent; the only input to contract generation. (FR-6)
4. **Non-BMAD specs later:** additional `ingest/` readers implementing the same `EpicSource → EpicSpec` interface; no other layer changes. (Spine Deferred)

**Contract**
5. **What is a VerificationContract:** the frozen, versioned set of Criteria for one epic — the sole authority on WHAT must be true; YAML in `.specwitness/contracts/<epic>.yaml`. (PRD Glossary; AD-5)
6. **Contract vs strategy:** contract = WHAT (criteria, statements, kind, severity, verifiability); Plan = HOW (probes, assertions, test data). Plans reference criteria by id only. (AD-5)
7. **Criteria typing:** Kind ∈ {behavioral, integration, invariant, security, structural, performance, human}; Severity ∈ {critical, normal}; Verifiability ∈ {automated, human}. (PRD Glossary)
8. **Versioning/freeze:** integer monotonic version; freeze computes fingerprint and sets `meta.frozen`; only frozen contracts gate. (FR-8; AD-5)
9. **Legitimate changes:** explicit `contract --amend` — new version referencing superseded one, human confirmation, re-freeze; refused in no-TTY contexts. (FR-10; ADR-005)
10. **Fingerprint:** SHA-256 over canonical JSON of the `spec` block only (sorted keys, LF, trimmed), single implementation in `schemas/canonical.ts`. (AD-5)
11. ★ **Stored in Git:** `.specwitness/config.yaml`, `contracts/`, `plans/` are committed (they are reviewable product artifacts); the project's `.gitignore` excludes `.specwitness/runs/` and `.specwitness/scorecard.jsonl` (local-only). `init` writes these ignore entries.
12. **Only in local runs:** run results, evidence, manifests, logs, generated Playwright scenarios, provider raw transcripts. (AD-8, AD-11)

**Config & execution**
13. **Config format:** YAML (`.specwitness/config.yaml`), camelCase keys, zod-validated, `version` field. (FR-2; addendum §D)
14. **Commands defined:** only in config: `setup`, `gates[].run`, `services[].run`, `data.*`, `observations[].run` — strings executed via the shell, declared by the trusted project owner. (AD-3)
15. **Safe execution:** ProcessRunner only; own process group, timeout, captured output; plans reference commands by config id, never inline strings. (AD-3, AD-8)
16. **Env vars:** read only in `cli/`/`infra/`; services get config-declared `env` merged over a pass-through base; provider children get billing-risk vars withheld in subscription modes; parent env never mutated. (Conventions; AD-4)
17. **Secret redaction:** at evidence capture in `domain/evidence.ts` constructors — Authorization/Cookie headers, `*_KEY|*_TOKEN|*_SECRET|password` patterns + config-declared extras. (AD-10)

**Isolation & lifecycle**
18. **Worktree creation:** resolve `--head` to SHA → `git worktree add --detach` under OS temp dir. (AD-8; ADR-004)
19. **Cleanup guarantee:** manifest written+fsynced before resource use; teardown stage always runs; process groups SIGTERM→SIGKILL; worktree removed. (AD-8)
20. **Stale crashed runs:** `specwitness clean` replays manifests of unreaped runs. (FR-27-clean; AD-8)
21. **Temp files:** only inside the run directory (`.specwitness/runs/<id>/`) and the OS-temp worktree. (AD-8)
22. **Read-only toward source:** worktree add/remove are the only git writes; nothing writes into the project working tree; corpus test kills verify mid-run and asserts `git status` clean. (FR-19)
23. **Service start:** declared order, in worktree cwd, config env, own process group. (FR-21)
24. **Service stop:** teardown kills process groups (grace then force), always — including on pipeline failure. (AD-8)
25. **Child processes:** per-process-group kill covers grandchildren; macOS/Linux semantics verified by story 3.2 tests (execa 10 concern from review). (AD-8)
26. ★ **Port allocation:** config-declared per service (explicit ports, referenced in readiness URLs); V0 does not auto-allocate. Rationale: deterministic URLs for plans/evidence beat dynamic ports; conflicts are diagnosable.
27. ★ **Collision prevention:** doctor and the services stage pre-check declared ports are free; an occupied port → InfraError naming the port and PID hint — never a product FAIL. (mirrored into FR-21 behavior)
28. **Readiness:** per-service config: URL probe (2xx) or command probe, poll interval + `timeoutSec`. (FR-21)
29. **Readiness timeout:** run ends InfraError (exit 3) with captured service output as evidence. (FR-21; corpus fixture 8)

**Surfaces**
30. **Playwright integration:** standard `@playwright/test` as runner over generated spec files; project's installation preferred, SpecWitness-provisioned fallback in its own cache. (FR-24; spine Stack)
31. **Ephemeral artifacts:** yes — generated scenarios live in the run dir, never the project tree; persisting accepted tests is deferred. (FR-24; Deferred)
32. **Traces:** Playwright trace + failure screenshot per browser probe, stored under `runs/<id>/evidence/`, referenced from results. (FR-24)
33. **HTTP checks:** typed http probe: method, service-relative URL, headers, body, assertions on status/headers/JSON-path values. (FR-23)
34. **Generic DB observation:** config-declared observation commands emitting JSON to stdout; probes assert equals/delta, incl. before/after around an action. (FR-25; brief §34)
35. **JSON from project commands:** yes — observation commands MUST emit JSON; non-JSON output ⇒ criterion `error`. (FR-25)
36. **Deterministic test data:** fixed values + per-plan recorded seed stored in the Plan at compile time; declared-volatile fields exempt; inputs appear in evidence. (FR-17; AD-9)
37. **Criteria → strategies:** plan-author provider drafts probes per criterion within the closed probe union; schema-gated; lowest adequate surface rule. (FR-16; AD-2/3)
38. ★ **Criterion not safely plannable:** compile marks it `needs_human` with reason `not-safely-automatable` (recorded in the plan; surfaced in report). Never silently dropped, never guessed into a probe.
39. **NEEDS_HUMAN triggers:** (a) criterion verifiability=human; (b) plan marks not-safely-automatable (Q38); nothing else — execution-time uncertainty is `error`, not needs_human. (FR-16; AD-6)

**Results**
40. **Criterion PASS:** all its probes' assertion evaluations true across required attempts — computed by the single `domain/criterion-result.ts` function. (AD-13)
41. **Criterion FAIL:** ≥1 assertion evaluated false (probe executed successfully but observed wrong values). (AD-13)
42. **Infra error representation:** criterion-level `error` status (probe could not observe) and run-level `{infraError}` outcome — typed via AD-7 hierarchy; exit 3. (AD-6/7)
43. **Retries:** opt-in per probe class, default 0, bounded, every attempt recorded. (FR-32; AD-9)
44. **Flakes surfaced:** retry-pass ⇒ `flaky: true` on the result, counts in report/JSON/scorecard. (FR-32)
45. **Verdict aggregation:** pure function over gate+criterion results: gate failed ⇒ FAIL(gateFailed); any fail ⇒ FAIL; any error ⇒ infra; any needs_human ⇒ NEEDS_HUMAN; else PASS. (AD-6; ADR-003)
46. **Critical FAIL + several NEEDS_HUMAN:** FAIL — `fail` outranks `needs_human` in aggregation; the needs_human items remain listed for the eventual human pass. (AD-6)

**Evidence & storage**
47. **Evidence types:** closed union — http, browser (trace/screenshot refs), observation, command, gate, provider; plus labeled non-authoritative `explanation`. (AD-10)
48. **File references from JSON:** relative paths from the run directory root in `evidence[].path`, stable across machine moves of the run dir. (AD-11)
49. **Sanitization:** at capture (Q17); size caps on bodies/logs with truncation markers pointing at full files. (AD-10, AD-11)
50. **Run storage:** `.specwitness/runs/<run-id>/` — manifest.json, result.json, evidence/, logs; RunStore sole writer. (AD-8)
51. ★ **Retention:** V0 keeps all runs (no automatic pruning; dogfooding data is the point); `specwitness clean` reaps resources, not results. A `--prune` retention flag is deferred.
52. **`report` reconstruction:** re-renders persisted result.json (latest run for an epic by default, or by run id); never re-executes. (FR-31)

**External contract**
53. **Stable JSON interface:** versioned `result.json` schema (schemaVersion int, additive evolution, snapshot-tested) — same document on stdout with `--json`. (FR-30; AD-11)
54. **Exit codes:** 0 PASS · 1 FAIL · 2 NEEDS_HUMAN · 3 infra · 64 usage. (ADR-002)
55. **Harness consumption:** exit code for gating + `--json` stdout / persisted result.json for detail; ISO-8601 UTC timestamps for freshness comparison; bounded human output on stderr. (FR-29/30; addendum §A)

**Providers**
56. **CLI discovery:** PATH lookup of `claude` / `codex` + version probe at session start; results cached per run; doctor reports. (AD-4)
57. **Non-interactive detection:** capability probe per adapter (claude: `-p --output-format json` support; codex: `exec` present) — probed, not assumed. (AD-4)
58. **Auth readiness safely:** only via the official CLI's own public surface (e.g. `codex doctor`, exit codes of a trivial invocation); never filesystem inspection of credential stores. (FR-3; AD-4)
59. **Avoiding OAuth secrets:** hard rule — no code path reads `~/.claude/`, `~/.codex/` or equivalents; enforced by review checklist + static test. (NFR-1; AD-4)
60. **API-key env reporting:** doctor + provider invocation warn naming the variable; subscription/chatgpt modes withhold them from child envs. (FR-15)
61. **AgentProvider interface:** request `{role, prompt, responseSchema, contextFiles?}` → response `{ok, parsed?, raw, attempts[], durationMs}`; adapters translate envelope↔CLI only. (AD-2)
62. **Fakes in tests:** FakeAgentProvider implements the port for all domain/application tests; real-CLI tests are a separate tagged suite. (AD-12)
63. **Schema validation:** shared `providers/invoke.ts` gate validating against versioned zod schemas before anything becomes state. (AD-2; FR-14)
64. **Bounded retries:** default 2, validation errors fed back, every attempt recorded, then ProviderError. (FR-14)
65. ★ **Provenance:** contract/plan `meta` records generator provider, model (as reported by the CLI), CLI version, timestamp; runs record every provider invocation (role, provider, duration, attempts). (mirrored into AD-5 meta)

**Future-proofing & value**
66. **Verify without LLM:** yes — frozen contract + compiled plan execute with zero provider calls; `--no-ai` guarantees it. (FR-18)
67. **Differential fit:** every run already records base+head SHAs; differential = orchestrating two runs + a pure comparison over two RunResults — no domain rework. (AR-3; Deferred)
68. **Mutation testing fit:** challenge mode = temporary mutation in a throwaway worktree + existing plan execution + expected-FAIL comparison; depends only on stable Plan/RunResult schemas. (Deferred)
69. **Historical regression suite:** contracts/plans accumulate per epic in Git; a future `verify --all-frozen` iterates them — storage shape already supports it. (Deferred)
70. **Measuring unique value:** local scorecard (auto per-run record) + explicit attribution (`scorecard add … --attribution unique|duplicate|false-positive`) + `scorecard summary` reporting the north-star metric. (FR-33/34; Epic 7)
