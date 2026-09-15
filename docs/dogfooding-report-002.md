# Dogfooding report 002 — a contract drafted for mechanical verifiability, measured

Written 2026-09-15 against `omdb-specwitness` at `7fe75f0`, covering **three frozen contracts and three completed epics**: Epic 1 (foundation, 24 criteria, `bdc205bfb8d7`), Epic 2 (OMDb data layer, 24 criteria, `2cf85a3b5662`), Epic 3 (search and hybrid pagination, 32 criteria, `86b706e1faf2`).

This report answers the two questions report 001 left open, in the words 001 used to ask them:

> *"Whether that is a property of **this contract** … or of **contracts in general** is the single most important open question for the next dogfooding run, and it is answerable: draft the next contract deliberately aiming for mechanical verifiability and measure the ratio."* — §7

> *"The next dogfooding run should need **zero** bespoke `.mjs`."* — §9.1, later softened to *"fewer scripts and fewer chances to get one wrong"*

Both were answered. One decisively, one more decisively than 001 dared hope.

**Sources.** `omdb-specwitness`'s three frozen contracts and compiled plans, its three epic retrospectives, `docs/implementation-artifacts/sprint-status.yaml`, `docs/automation/README.md`, and six findings in `docs/findings/`. Every number below was read from those files or computed from the repository, not transcribed from memory.

**A limit stated first, and it is a different limit than 001's.** Report 001 stood on a scorecard and eleven owner attributions, which let it compute a false-positive rate. **This report cannot compute one.** `omdb-specwitness` has no `attributions.jsonl`: nobody adjudicated findings one at a time, because the workflow that produced them — a supervised agent cohort with its own review gates — resolved them as they appeared. The scorecard holds 10 runs and is gitignored. So §4 below reports defects *by class and by who found them*, not as a rate. Any comparison with 001's 63.6% is unavailable, and manufacturing one would be worse than admitting the gap.

**A second limit, and it cuts against this report's own headline.** This contract was drafted by the same author, in the same style, with the measurement in view. That is precisely what 001 asked for — and it also means the ratio below is the best case for deliberate drafting, not the average case. See §7.

---

## 1. The verdict, in one line

**The hypothesis holds, and the onboarding cost is closed. Unattended gating is still not earned — for a reason 001 did not anticipate.**

A contract drafted deliberately for mechanical verifiability reached **93.8% mechanical** against gitnebula's 50%, and needed **zero lines of bespoke probe code** against gitnebula's 815. Three epics, three freezes, **zero amendments**.

But the instrument produced **three defects of its own** across the three epics, two of them silent, and every one was caught by a human reading a plan or comparing two verdicts. A gate nobody reads would have shipped a green criterion over a broken product.

## 2. The north-star numbers

```
Criteria across three frozen contracts:  80
Mechanically verifiable:                 75  (93.8%)
Left to a human, by design:               5  (6.2%)
Contract amendments:                      0
Bespoke probe code:                       0 lines, 0 files
```

| | Epic 1 | Epic 2 | Epic 3 | total |
|---|---|---|---|---|
| criteria | 24 | 24 | 32 | **80** |
| mechanical | 22 | 23 | 30 | **75** |
| `verifiability: human` | 2 | 1 | 2 | **5** |
| amendments | 0 | 0 | 0 | **0** |
| plan repairs | 1 | 2 | 0 | **3** |
| final verdict | NEEDS_HUMAN | NEEDS_HUMAN | NEEDS_HUMAN | — |

All three epics closed `NEEDS_HUMAN` with **0 fail**. That is the designed outcome, not a near miss: each contract carries criteria marked `verifiability: human`, and a run exiting 0 would have meant they were weakened.

## 3. Question 1 answered — 50% was a property of that contract

**gitnebula: 20 of 40 `needs_human` (50%, 17 of them critical). omdb-specwitness: 5 of 80 (6.2%), none critical.**

The difference is not subtlety of tooling. It is that every criterion here was written against one question — *could a probe decide this?* — and the ones that could not were **marked so on purpose and left alone**.

The five that stayed human are worth naming, because they show where the ceiling actually is:

| criterion | why no probe can decide it |
|---|---|
| E1-23, E1-24 | judgement about documentation a reviewer must read |
| E2-24 | a data-flow review: *does any path carry the API key?* |
| E3-24 | "appends smoothly without a visible jump" — perceptual |
| E3-28 | a loading indicator visible **while a request is in flight** — the browser surface reads at the moment a probe asks, and the four scenario verbs cannot hold a page at an instant |

**None of the five is a drafting failure.** Two are perceptual, one is a review, two are about prose. A contract drafted for mechanical verifiability does not reach 100% and should not: E3-28 was attempted as a `browser` criterion during drafting and rewritten, because a probe could only observe it by racing it, and a racing probe reports flakiness as product failure.

**The sample is biased, and the bias is documented at the source.** `epics.md` §"Scope note" states it: favorites (localStorage across a browser restart) and the audit epic (Lighthouse, README quality) were left out of scope, and those are *precisely* the areas where `needs_human` is most likely. The honest reading is therefore: **a contract drafted deliberately, over feature work of this kind, reaches roughly 94% mechanical.** Not "contracts reach 94%".

## 4. Question 2 answered — zero, and the zero was real

**gitnebula: 815 lines of hand-written JavaScript across 8 `.mjs` files, three of which contained defects that became false alarms. omdb-specwitness: 0 lines, 0 files.**

`.specwitness/config.yaml` declares four commands under `observations:` — `typecheck`, `build`, `test`, `lint` — and every one is a `package.json` script the project would have had anyway. No probe script was written for this project. Ever.

This is a stronger result than 001's §10 addendum predicted. That measurement concluded the `file` surface removes about half the script volume and filed the remainder as `d13`, noting the part no surface could close was *"choosing what text to look for"* — and that closing it needed *"a project whose documents nobody has read yet, with criteria written before the implementation exists"*.

**That is what this was, and the answer is that the problem dissolves rather than being solved.** When criteria are written before the code, the text a probe looks for is chosen by the criterion's author as part of stating the requirement — `data-testid="result-list"`, `rel="prev"`, the exact empty-state sentence. There is nothing left for a script to search for, because the search term *is* the specification. `d13` can be closed.

One decision made that possible and deserves naming, because it is transferable: **the selector contract.** Before Epic 3's contract was frozen, `design-direction.md` fixed nine `data-testid` hooks and the exact copy of three UI states. Eleven browser criteria were then written against a DOM that did not exist. Without it, those criteria would have been written after seeing the code — which is fitting the instrument to the result.

## 5. What the instrument got wrong — three defects, two silent

This is the section that argues against unattended gating, and it is the most useful part of this report for SpecWitness's own roadmap.

**E1-14 — an unexecutable browser scenario (loud).** The planner wrote a browser scenario as prose. The executor's grammar is four verbs — `goto`, `click`, `fill`, `waitFor` — and it refused. **Nine criteria were never adjudicated**; the run aborted with exit 3. Loud, unmissable, and repaired by the owner in one commit.

**E2-08 — an assertion that could not fail (silent).** The plan asserted `notContains '"plot":'` against a payload where OMDb emits `"Plot"`, capitalised. The lowercase literal appears in a raw upstream response *never*. The criterion reported `pass` on every run of wave 1 **while the behaviour it describes did not exist**. It was caught by a supervisor noticing that E2-07 — the sibling criterion, same fixture, same request — was failing.

**E2-08 again — the repair could not pass (silent, opposite sign).** The first fix replaced the literal with `jsonPath $.plot equals ""`. But `src/domain/plan.ts` treats a missing path as unsatisfied for *every* comparison, so a response that correctly *omits* `plot` could never satisfy it. The criterion went from always-green to always-red. It was caught by the first agent whose implementation was correct, who reported the captured body **and did not change the product to fit the probe**.

**The lesson, which is now a rule in that project's automation register:** *a repaired probe needs both controls — a run where it must fail, and a run where it must pass.* The first repair was only ever checked against an unimplemented tree, where failing looked like correctness.

**Epic 3 had zero plan repairs**, on the largest contract (32 criteria, 11 of them `browser`) — because the plan was reviewed line by line against those two lessons before the cohort launched, and three assertions were measured rather than trusted. That is the calibration 001 asked for, performed by hand.

## 6. What this project sends back upstream

Six findings, each with a document in `omdb-specwitness/docs/findings/`:

1. **Codex cannot author a plan for this project at all** — `planDraftSchemaFor` renders through `z.toJSONSchema` into a JSON Schema that OpenAI structured outputs rejects three ways (`oneOf` from discriminated unions, `propertyNames` from `z.record`, optional properties absent from `required`). SpecWitness reports `provider-failed` three times and gives up, so an incompatible schema looks like a flaky CLI.
2. **Validate browser scenarios at plan-compile time** against the executor's verb grammar (E1-14).
3. **Reject assertions no read can satisfy** — a missing path against `equals ""` — and literals absent from the fixture the probe will receive (E2-08, both directions).
4. **Record a plan hash in `result.json`.** `verify --head` takes code from the ref but the plan from the invoking worktree (`verify.ts:225`). The same commit produced FAIL from one worktree and NEEDS_HUMAN from another.
5. **Say "gates failed — probes not run"** instead of `N skipped, VERDICT FAIL`, which reads like N defects when it means the instrument declined to report.
6. **`observations:` is misnamed** — it is the one map of declared commands a `shell` probe resolves `commandId` against, and the name cost a plan: the first Epic 1 plan deferred five criteria as `not-safely-automatable` because "this project declares none".

Two more, found while running cohorts rather than while verifying:

7. **Concurrent `verify` runs share a fixed service port.** Four agents verifying in parallel on port 3000 contaminated three runs in one wave — one agent's probes read another's server, and one run lost its server mid-probe. Nothing refuses the overlap. A per-run port, or a refusal, would close it.
8. **Run evidence breaks the client's own gates.** `.specwitness/runs/**` holds generated CommonJS specs that failed this project's `lint` and `test` — and a failed gate skips every probe. `specwitness init` should scaffold the exclusions.

## 7. What this report does not establish

**It is one author.** The criteria for all three contracts were written by the same model in the same session-style, with the measurement in view. 001's caveat about n=1 applies here with a twist: this is n=2 *projects* but n=1 *drafting practice*. A second author drafting deliberately would tell us whether 94% is a property of the practice or of this practitioner.

**No false-positive rate.** See the limit at the top. The three instrument defects in §5 are a count, not a rate, because the denominator — findings a human adjudicated one by one — does not exist here.

**The cohort is a confound.** These epics were implemented by supervised agents whose own gates (Codex review, security sign-off, rebase freshness) ran *before* SpecWitness saw the code. Some defects SpecWitness might have caught were caught earlier by those gates. That makes "did verification find what the gates missed?" unanswerable here in 001's terms — and it is worth noting that 001's headline finding came from exactly that question.

**Three criteria were green before their stories began.** After Epic 3's wave 1, E3-13, E3-25 and E3-26 passed on work done by a different story. Not a defect — the spec assigned those hooks deliberately — but a criterion green before its owner starts cannot detect that owner's work, and only a by-hand check found it.

## 8. Recommendation

**Continue. Two of 001's three preconditions are now met.**

1. **`d8` and `d13` are closed.** Zero bespoke probe code, on a real project, with criteria frozen before implementation. The `file` surface plus criteria-first drafting removed the whole category.
2. **Question 1 is answered for deliberate contracts** — 93.8%, with a stated sample bias. The 50% was a property of that contract, not of contracts.
3. **Unattended gating is still not earned, and §5 is why.** Three plan defects in three epics, two of them silently green or silently red. Every one was caught by a person: a supervisor comparing two verdicts, an agent refusing to bend a product to a probe, an owner reading a plan line by line. Fix items 2 and 3 in §6 — both are decidable at compile time — and the argument changes.

**What would change this verdict.** A third project, drafted by a different author, landing near 90% would make the practice look transferable. One landing near 60% would mean this report measured a practitioner. And a compile-time check that rejects unfailable and unpassable assertions would remove the two defect classes that most argue against letting a FAIL block a merge unread.

---

## Appendix: what it cost

| | Epic 1 | Epic 2 | Epic 3 |
|---|---|---|---|
| stories | 3 | 7 | 7 |
| waves | 1 | 2 | 3 |
| launch → last merge | 1 h 42 min | 22 min + 47 min | 22 + 65 + 46 min |
| tests on the tip | — | 213 | 471 |
| plan repairs | 1 | 2 | 0 |

Four calendar days, 132 commits, 2026-09-12 to 2026-09-15.

**The pre-freeze review paid for itself every time.** Epic 2's caught a criterion already green on the base and one no surface could arrange. Epic 3's caught eight base-green expectations, two missing fixtures, and a criterion naming *"a service configured with JavaScript disabled"* — which cannot be declared, because `serviceSchema` carries `run`/`port`/`ready`/`env` only and the browser executor has no JavaScript toggle. It was rewritten as an `http` criterion asserting a real anchor in server-rendered HTML, which is the stronger evidence anyway.

**And the drafter itself needed reviewing.** Epic 3's contract came back from `specwitness contract` with 31 criteria against 35 source criteria — a tidy-looking −4 that hid four separate defects: a conjunction unpacked back into two (re-introducing a criterion green on an empty tree, the same defect Epic 2 had), a criterion silently dropped, two criteria invented from nothing, and three deliberate surface distinctions merged away. A matching count would have proved nothing. Only a criterion-by-criterion mapping found them.
