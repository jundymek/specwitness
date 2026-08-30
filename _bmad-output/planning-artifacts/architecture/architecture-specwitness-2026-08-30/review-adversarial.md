# Adversarial Review — Proofgate Architecture Spine

**Lens:** adversary constructing pairs of story-level units that obey every AD to the letter yet build incompatibly.
**Reviewed:** `ARCHITECTURE-SPINE.md` (final, 2026-08-30) against `prd.md` (glossary + FRs).
**Verdict: CONCERNS** — the spine's invariants are strong on *authority* (who may decide) and *safety* (what may execute), but under-specified on *shared data shapes* and *ownership of cross-story types*. I found seven exploitable seams; six are incompatible-pair holes, one is a structural gap (a required orchestration has no legal home). Each comes with a constructed pair and a proposed AD fix.

---

## Finding 1 — Fingerprint field partition: freeze story vs. verify story permanently disagree

**Constructed units.**
- *Unit A (contract lifecycle story, FR-8):* implements `freeze`. Reads the draft contract YAML, computes SHA-256 via `schemas/canonical.ts` over "the contract's content fields", then writes the file back with `frozen: true`, `fingerprint: <hash>`, `version: 1` as **top-level keys** (natural — they describe the contract, and AD-5 only says the `meta` block is excluded; nothing says these fields must live *inside* `meta`).
- *Unit B (integrity story, FR-9):* implements the verify-time integrity stage. Loads the on-disk YAML, strips the `meta` block per AD-5, canonicalizes via the *same* `schemas/canonical.ts`, compares to the stored fingerprint.

**Both obey every AD.** One shared canonical function (AD-5 ✓), meta excluded (✓), SHA-256 over canonical JSON (✓), IntegrityError from the AD-7 hierarchy (✓), exit 3 (AD-6 ✓).

**Divergence.** Unit A hashed the pre-freeze document; Unit B hashes a document that now contains `frozen`, `fingerprint`, and `version` at top level — not in `meta`, therefore included in the hash. Every frozen contract fails integrity on its first verify, forever. The reverse construction is just as legal: A puts lifecycle fields under `meta` and re-hashes post-write; B assumes pre-freeze content. AD-5 defines the *algorithm* once but never partitions the document into content vs. meta fields, so the two stories cannot converge except by luck.

Secondary ambiguity in the same seam: is the fingerprint of the YAML text or of the parsed model ("canonical JSON form" suggests parsed, but "trimmed strings, LF endings" reads like text-level normalization)? Comment edits to a frozen file (the PRD says frozen files are "reviewable in a PR") would flip integrity results depending on the answer.

**Fix — tighten AD-5.** Specify the contract file's top-level shape normatively: exactly two top-level keys, `meta` (schemaVersion, version, frozen, fingerprint, timestamps, supersedes, provenance — everything mutable-by-lifecycle) and `spec` (epic ref, criteria — everything the fingerprint covers). Fingerprint = SHA-256 over `canonicalize(parse(file).spec)` — parsed model, not file bytes; YAML comments and key order are explicitly non-content. State that freeze writes only into `meta` and that this exact partition is what both FR-8 and FR-9 consume.

---

## Finding 2 — Criterion type has no owner: contract schema vs. plan schema drift

**Constructed units.**
- *Unit A (contract story):* defines `schemas/contract.ts` with `CriterionSchema = { id, statement, kind, severity, verifiability }`, ids per PRD FR-7's example: `E07-01` (zero-padded, as shown in UJ-2 and FR-7).
- *Unit B (plan story, FR-16):* defines `schemas/plan.ts` with its own `PlanCriterionSchema` — and, to make plans self-contained and human-readable (AD-5 says plans are human-readable YAML), **embeds** each criterion's `statement`, `kind`, `severity` alongside its probes. Ids per spine conventions: "criterion IDs `E<epic>-<nn>` (epic number unpadded)" → `E7-01`.

**Both obey every AD.** Each artifact is human-readable YAML with `schemaVersion` (AD-5 ✓); each schema lives in `schemas/` (AD-1 ✓); providers are schema-gated (AD-2 ✓). No AD says Criterion is defined once, and no AD says a Plan references criteria by id rather than embedding them.

**Divergence — three ways.**
1. *Two Criterion definitions.* The verify pipeline joins plan probes to contract criteria; with embedded copies, an amendment (FR-10) changes the contract's statement while the plan carries the stale text — report and evidence cite expectations the frozen contract no longer contains. Nothing detects it: the plan's contract-fingerprint reference (FR-16) protects against a *stale contract*, not against the plan's *own duplicated copy*.
2. *Id format clash.* `E07-04` (PRD, both user journeys, FR-7) vs. `E7-04` (spine conventions, parenthetical "unpadded"). A join on criterion id between Unit A's contract and Unit B's plan matches zero rows; verify reports every criterion `skipped` or errors. Two agents reading "the letter" of PRD vs. spine land on opposite sides.
3. *Enum ownership.* `Kind` (7 values) and `Severity` are glossary terms; the spine's AD-6 pins `CriterionStatus` in `domain/` but is silent on Kind/Severity/Verifiability. Two zod files can (and will) restate them, and additive evolution (AD-5) then forks.

**Fix — new AD (or extend AD-6).** "Canonical domain types are defined exactly once, in named files: `domain/criterion.ts` owns `Criterion`, `Kind`, `Severity`, `Verifiability`, `CriterionId`; `schemas/criterion.ts` is the single zod mirror imported by both contract and plan schemas. Plans reference criteria **by id only** — a plan never embeds statement/kind/severity; renderers join plan→contract at load time. Criterion id format is `E<n>-<nn>` with the epic number **unpadded** and the sequence zero-padded to two digits (`E7-01`); the PRD's `E07-01` examples are superseded — one line in the spine must say so explicitly, or agents will follow the PRD."

---

## Finding 3 — Gate failure is simultaneously an error and a verdict; zero-criteria aggregation says PASS

**Constructed units.**
- *Unit A (gates story, FR-20):* the gates stage runs configured gates; on failure it **throws `GateFailure`** — which is exactly what AD-7 invites: `GateFailure` is a member of the one typed error hierarchy, and "every adapter maps its native failures into this hierarchy at the boundary."
- *Unit B (verdict/aggregation story, FR-27):* implements AD-6's aggregation as written — a pure function over CriterionResults: "any `fail` ⇒ FAIL; else any `error` ⇒ infra; else any `needs_human` ⇒ NEEDS_HUMAN; else PASS."

**Both obey every AD.** A uses the sanctioned hierarchy (AD-7 ✓); B is the pure domain aggregation with no provider access (AD-2, AD-6 ✓).

**Divergence.** Two consistent-but-incompatible mutation paths for the run outcome:
- Path A: `GateFailure` propagates to `cli/exit.ts`. But AD-6's exit table has **no row for GateFailure** — it lists PASS 0 · FAIL 1 · NEEDS_HUMAN 2 · infra/integrity/config/provider 3 · usage 64. AD-7 says the table "consumes only this hierarchy," so a literal implementation buckets GateFailure with the other errors → **exit 3** for a broken build, contradicting AD-6's "gate failure ⇒ FAIL with `gateFailed: true`" (exit 1) and Golden Corpus fixture 7.
- Path B: the pipeline swallows the throw, stage stops early, aggregation runs over **zero CriterionResults** — AD-6's rules bottom out at "else PASS." A broken build exits 0 unless someone special-cases it, and the spine never says *who* (pipeline? aggregation? report?). Two stories can each assume the other does the conversion.

There is also a smaller circularity: AD-7 says exit mapping consumes *only* the error hierarchy, while AD-6's table maps verdicts (PASS/FAIL/NEEDS_HUMAN) that are not errors — and `IngestError` (AD-7) appears in no exit row at all (3? 64?).

**Fix — tighten AD-6 + AD-7.** (a) Aggregation's signature takes gate results as an input: `aggregate(gateResults, criterionResults) → RunOutcome`; any failed gate ⇒ `{ verdict: FAIL, gateFailed: true }` before criterion rules apply, and a run with zero criteria and clean gates is an `InfraError`, never PASS. (b) `GateFailure` is removed from the throwable hierarchy **or** declared pipeline-internal: it must be converted to the FAIL outcome inside the gates→aggregate stage and may never reach `cli/exit.ts`. (c) `cli/exit.ts` signature is `toExitCode(outcome: RunOutcome | ProofgateError)` with an exhaustive row per hierarchy member — including `IngestError → 3` (or 64; pick one) and a compile-error (`never`) check for exhaustiveness.

---

## Finding 4 — SurfaceExecutor result shape: capture vs. adjudicate

**Constructed units.**
- *Unit A (http-surface story, FR-23):* the executor **captures** — it performs the request and returns `{ evidence: HttpEvidence, captured: { status, headers, body } }`; assertion evaluation (JSON-path, status equals) happens in pure `domain/` code, which produces the CriterionResult. Motivated by AD-1/AD-2's spirit: judging is domain work.
- *Unit B (browser-surface story, FR-24):* the executor **adjudicates** — Playwright's own `expect` runs inside the scenario, so pass/fail is only knowable inside the adapter; the executor returns `{ status: 'fail', evidence: BrowserEvidence }` directly. Motivated by FR-24's letter: "assertion failure → criterion `fail`; browser/env crash → criterion `error`/Infrastructure Error" — classification stated as the surface's behavior.

**Both obey every AD.** Both attach typed Evidence built via `domain/evidence.ts` constructors with redaction-at-capture (AD-10 ✓); neither lets a provider decide anything (AD-2 ✓); probes are the closed union (AD-3 ✓).

**Divergence.** The pipeline's probes stage receives two structurally different things from the same port: raw captures needing domain assertion vs. finished statuses. There are now **two producers of CriterionResult** — one pure, one inside an adapter — so "verdict aggregation is a pure function" is technically preserved while half the per-criterion judging quietly lives in `surfaces/`. Knock-ons: AD-9 retries ("opt-in per probe class, every attempt recorded") get implemented twice — pipeline-level re-invocation for A, in-executor retry for B — with `flaky: true` computed inconsistently; and the same failure (timeout) is classified differently per surface (A: domain says criterion `error`; B: adapter says `fail`) — exactly what AD-7 exists to prevent, but AD-7 governs *errors*, not assertion outcomes.

**Fix — new AD (probe execution contract).** Define the port result once, in `domain/`: `ProbeExecution = { attempts: Attempt[] }`, `Attempt = { evidence: Evidence[], captured: CapturedValues | { crash: InfraFacts } }`. Executors **capture and never judge**; the single pure asserter `domain/assert.ts` maps `(plan assertions, ProbeExecution) → CriterionResult` for all four surfaces. Browser assertions are expressed as captured observations (element text, URL, screenshot ref) asserted in domain; a Playwright `expect` inside generated scenario code may exist only as a mechanics convenience whose outcome is re-derived from captured values. Retry orchestration lives in one place (pipeline probes stage); executors run exactly one attempt per call. Timeout classification per surface is written into this AD (probe-target timeout ⇒ criterion `error`; infrastructure/browser-launch failure ⇒ `InfraError`).

---

## Finding 5 — Two writers of `.proofgate/runs/<id>/`: eager manifest vs. atomic run store

**Constructed units.**
- *Unit A (isolation/lifecycle story, FR-19/21, AD-8):* must record worktree paths and pgids in `manifest.json` **before** the resources exist-in-use. Simplest legal implementation: create the run directory itself at the worktree stage and write/append `manifest.json` directly with `fs` (legal — it's `pipeline/`+`infra/`, not `domain/`, so AD-1 permits it).
- *Unit B (run-store story, FR-31, AD-11):* implements `RunStore` in `infra/` as the owner of `.proofgate/runs/<run-id>/`, with atomic persistence — write the whole run (result.json, evidence, logs) into a staging dir, fsync, rename into place at the persist stage, so a crashed run never leaves a half-readable run directory for `report`/scorecard.

**Both obey every AD.** A satisfies AD-8's write-before-use ordering to the letter; B satisfies AD-11 and FR-31's "report re-renders a stored run."

**Divergence.** If B's atomicity wins, the eagerly-written manifest lives in the staging dir and a `kill -9` mid-run **loses the manifest** — `proofgate clean` (which "replays manifests to reap leftovers from crashed runs") finds nothing, defeating AD-8's entire purpose. If A wins, two modules write into one directory with different lifecycles: who creates `<run-id>/`? who owns fsync? does teardown's manifest update go through RunStore or `fs`? Additional trap: AD-5 says "every artifact carries `schemaVersion`" and "Runs are JSON under `.proofgate/runs/`" — if A treats the manifest as internal scratch (no schemaVersion) while the `clean` story validates manifests with a zod schema requiring one, `clean` silently skips every manifest.

**Fix — tighten AD-8.** "The run directory has exactly one writer: `RunStore` (`infra/run-store.ts`). RunStore creates `<run-id>/` at the resolve stage and exposes two write modes: `appendManifest(entry)` — durable immediately (write + fsync, never staged, never renamed away), called before each resource is brought into use — and `persistResult(...)` — atomic finalize for result.json/evidence. `manifest.json` is a versioned artifact (carries `schemaVersion`; `clean` validates it and reports, not skips, unknown versions). Teardown updates (resource reaped) also flow through `appendManifest`."

---

## Finding 6 — AgentProvider envelope undefined: two adapters, two validation/retry stacks

**Constructed units.**
- *Unit A (claude adapter story, FR-12):* `claude -p --output-format json` returns claude's own JSON envelope whose payload is a **string field containing model text**. So this adapter extracts the text, parses it as JSON, validates against the role's zod schema, and on failure re-prompts with the validation errors ("repair" retry), up to 2 times — implementing AD-2's "bounded recorded retries" *inside the adapter*.
- *Unit B (codex adapter story, FR-13):* `codex exec --output-schema` makes the CLI itself enforce a JSON schema. This adapter converts the zod schema to JSON-schema, passes it to codex, and returns already-conforming output; its "retry" is re-running the identical invocation (no repair prompt). It reasons the validation gate is thereby satisfied upstream and returns a parsed object.

**Both obey every AD.** Official binaries via `ProcessRunner`, runtime capability probing, credential/billing rules (AD-4 ✓); responses schema-gated with bounded recorded retries (AD-2 ✓ — AD-2 never says *where* the gate runs or what a retry *is*).

**Divergence.** The port has no defined request/response envelope, so: (1) the two adapters return different things (raw text vs. parsed object) — the pipeline's call site can't be written against both; (2) the AD-2 validation gate exists **twice**, with different retry semantics, different "recorded retries" shapes in generation metadata (AD-4 requires role/duration/retries recorded — in what structure?), and different raw-rejected-payload logging (FR-14); (3) role prompts (contract-author/plan-author/explainer) get authored per adapter, so the two providers systematically produce differently-shaped drafts that only accidentally both pass the schema; (4) `FakeAgentProvider` (AD-12) must fake whichever envelope it was written against — tests pass against one real adapter and not the other.

**Fix — new AD (provider envelope).** Define the port in `domain/`: `AgentProvider.invoke(req: ProviderRequest) → ProviderRawResponse` where `ProviderRequest = { role, prompt, schemaRef, timeoutMs }` and the response is **always raw text + invocation metadata** — adapters are transport only. One shared driver (`providers/driver.ts`) owns: role prompt construction, extraction, zod validation, the bounded repair-retry loop (retry = re-prompt with validation errors appended; default 2), and the recorded `ProviderInvocation { role, provider, durationMs, attempts[], rejectedPayloads[] }` shape that run/generation metadata and FR-14 logging consume. `--output-schema`-style CLI enforcement is an adapter optimization that never replaces the driver's validation. `FakeAgentProvider` fakes the port, not the driver.

---

## Finding 7 — Structural gap: contract/plan generation has no legal home, and epic-id normalization has two

**(a) Homeless orchestration.** The capability map places FR-7..10 (contract generate/freeze/integrity/amend) in `domain/`, `schemas/`, `cli/` — but generation must call the `contract-author` provider. Per AD-1's dependency graph, `cli` has edges only to `pipeline`, `ingest`, `report`; **no edge cli→providers exists**, `domain` may import nothing, and `ingest` is "bmad reader → EpicSpec." So the story implementing `proofgate contract` has no sanctioned module for its orchestration (ingest → provider draft → schema gate → review file). Constructed units: one agent adds `cli→providers` (violating the drawn graph, which the dependency-cruiser check from AD-1 will encode — or worse, weakening that check to admit it); another stuffs it into `pipeline/` (which the spine defines as *the verify state machine*, so now the "staged pipeline" has non-stage command logic); a third invents `generation/`. Three stories, three shapes, and the AD-1 lint rule gets configured differently by whoever lands first. Same issue for `plan` compilation (FR-16 maps to `domain/`+`pipeline/`, but plan-author provider access from a not-yet-defined stage) and for §6.1's "plan auto-invoked by verify when missing" — the pipeline's stage list (resolve→integrity→worktree→…) has **no plan stage**, so the cli story and the pipeline story can each assume the other performs auto-plan.

**(b) Normalization in two places.** Conventions put epic-id normalization (`7 ≡ epic-7 ≡ epic-07 → epic-7`) in play, and the structural seed assigns "arg normalization" to `cli/`. But `ingest/` must match epic identifiers as they appear in BMAD artifacts (`epic-07` directories/headings), and contract/plan file paths are `.proofgate/contracts/<epic>.yaml` — built by whichever module has the id in hand. Two stories legally implement normalization twice (cli for args, ingest for matching); a padded id sneaks into a file path or criterion-id derivation the moment any non-cli entry point (tests, corpus fixtures, `report <run>`) bypasses cli. This composes with Finding 2's `E07-01`/`E7-01` clash.

**Fix — tighten AD-1 + structural seed.** (a) Add an application-layer module to the seed — `generation/` (or `lifecycle/`) — owning contract-generation, amendment, and plan-compilation orchestration, with graph edges `CLI → GEN`, `GEN → ING`, `GEN → PROV`, `GEN → DOM`; state explicitly that `pipeline/` is verify-only and whether verify auto-invokes plan (and if so, that it does it by calling `generation/`, as a pre-stage before `resolve`). (b) One normalization function, `domain/epic-id.ts`; `cli/` and `ingest/` both call it; canonical form appears in *every* persisted path, key, and criterion id; matching against source artifacts compares normalized-to-normalized.

---

## Minor observations (no pair constructed, worth one line each)

- **Config schema location:** conventions say config is "validated with zod" in `config/`, but `schemas/` is named the home of versioned zod schemas — say which, or two stories put `ConfigSchema` in both.
- **`RunResult` vs. stored `result.json`:** AD-11 says all renderers derive from one `RunResult`, AD-5 says runs are JSON with `schemaVersion` — state that `result.json` *is* the serialized `RunResult` via one schema in `schemas/run.ts`, or the JSON-renderer story and run-store story will define sibling shapes.
- **`GateResult` type owner:** AD-6 says gate results "are their own type" but not where; put it in `domain/` next to `CriterionStatus` (folds into Finding 3's fix).
- **Doctor's degraded mode** (UJ-4: no provider installed ⇒ execution still works) implies provider checks are per-role-required, not global — worth a sentence so the doctor story and provider story agree on what "required" means.

---

## Summary of required AD changes

| # | Action | Closes |
| --- | --- | --- |
| 1 | AD-5: normative `meta`/`spec` top-level partition; fingerprint over parsed `spec` only | Finding 1 |
| 2 | New AD: canonical-type ownership table (`domain/criterion.ts` et al.); plans reference criteria by id only; id format `E7-01` declared, PRD examples superseded | Finding 2 |
| 3 | AD-6/AD-7: aggregation takes gate results; zero-criteria ⇒ InfraError; GateFailure pipeline-internal (or exit row added); exhaustive `toExitCode(RunOutcome \| ProofgateError)` incl. IngestError | Finding 3 |
| 4 | New AD: `ProbeExecution` capture-only executor contract; single `domain/assert.ts`; retry orchestration in one place; per-surface timeout classification | Finding 4 |
| 5 | AD-8: RunStore sole writer of run dir; durable `appendManifest` vs. atomic `persistResult`; manifest is a versioned artifact | Finding 5 |
| 6 | New AD: provider request/response envelope; shared validation/retry driver; recorded `ProviderInvocation` shape; adapters are transport only | Finding 6 |
| 7 | AD-1 + seed: add `generation/` module with explicit graph edges; pipeline is verify-only; auto-plan ownership stated; single `domain/epic-id.ts` normalizer | Finding 7 |
