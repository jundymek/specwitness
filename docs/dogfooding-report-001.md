# Dogfooding report 001 — the first evidence-based read on the product hypothesis

Written 2026-09-11 against `epic/7-dogfooding-repairs` at `42a6876`, covering every SpecWitness run recorded against a real project to date: **twelve runs on `gitnebula`'s Epic 6** (`epic/6-assembled-viewer`, a pnpm monorepo, 40 frozen criteria, contract fingerprint `fab2a9b7d468`).

This is story 7.3's deliverable (brief §54, §67.18). It answers one question — *does independent verification find defects that the earlier gates missed?* — and it answers it from the scorecard, not from memory.

**Sources.** `.specwitness/runs/` and `.specwitness/scorecard.jsonl` in `gitnebula`; the eleven attributions in `.specwitness/attributions.jsonl` recorded by the owner in this session; `docs/findings/dogfooding-defects-2026-09-05.md`; action items `d1`–`d8` in `sprint-status.yaml`. Every number below was read from `scorecard summary --json` or computed from the stored records, not transcribed from prose.

**A limit stated first.** This is **one project, one epic, one contract author**. A rate at n=1 is not a trend, and the summary renderer says so on every line. Nothing here generalises beyond "this happened, on this evidence".

---

## 1. The verdict, in one line

**Continue — with a calibration pass before any unattended gating.**

SpecWitness found **one real defect that four green deterministic gates passed over**, and it cost **seven false alarms in the first run** to find it. Four of those seven were the instrument's own fault and are now fixed; three were defects in the 815 lines of bespoke JavaScript the tool currently forces onto its client.

The hypothesis survives. The cost of verification does not yet justify letting a FAIL block a merge without a human reading it.

## 2. The north-star number

```
Unique real defects:   1 of 11 judged, of 236 findings
False-positive rate:   7 of 11 (63.6%)
JUDGEMENTS             unique: 1   duplicate: 3   false-positive: 7
```

**Read the denominators carefully, because three different ones appear above.**

- **11** = findings the owner has judged. Every rate is denominated by this.
- **236** = `fail + needs_human + error` summed across all twelve runs — **65 failures and 171 needs_human**. It is not 236 defects. The overwhelming majority is the same 20 human-judgment criteria re-counted once per run, and no run ever produced an `error` status.
- **225** = findings nobody judged. Deliberate: the 20 needs_human criteria are the contract asking a human to look, not the tool reporting a defect. Attributing them would flatter every rate on the page.

## 3. The one finding that is the whole product

**E6-07** (`critical`), found at `c5a10cb`, still failing at `6636e08`:

> The UI and performance suites use one shared `openViewer` helper whose observable behavior matches the former performance-suite helper, every browser spec navigates through that helper rather than calling `page.goto` directly […]

Expected 2 direct `page.goto` calls; the observation counted **3**.

Story 6.3 needed a third direct navigation because story 6.1's `openViewer` waits for a harness handle that a **failed** boot never publishes. Nobody could have known that when the contract was frozen — the constraint did not exist yet.

**Why this is the hypothesis in miniature:** all four deterministic gates (lint, typecheck, test, build) passed on this head, in every run. `pnpm test` was green. The epic looked done. The promised behaviour was not what shipped, and only a contract frozen before the implementation could have caught the difference.

That is precisely the claim the product exists to make, and this is the first time it has been demonstrated on work the author did not write for the purpose.

## 4. What the seven false alarms actually were

The blame splits in a way the single 63.6% figure hides, and the split matters more than the rate:

| # | criteria | root cause | whose defect | status |
|---|---|---|---|---|
| 4 | E6-10, E6-11, E6-12, E6-14 | a browser `visible` read on a selector matching **no element** was reported *absent*, so `expected: "false"` — the standard way a contract says "this must not be showing" — failed on the strongest possible evidence that it is not showing | **SpecWitness** (`d6`) | **fixed**, story 7.5 (`e039add`) |
| 2 | E6-23, E6-28 | a non-recursive `findReport` in gitnebula's own `.mjs` looked in the wrong directory; the report content existed in the epic retrospective | client probe script | **open** — still failing at `6636e08` |
| 1 | E6-09 | the source census counted a literal `__gitnebula` inside a comment explaining the rule, and inside the very assertion that *enforces* it. True counts: 0 and 0 | client probe script | **fixed** in gitnebula `ffe12fc`; criterion passes at `6636e08` |

**Four of seven were ours. Three were the client's.** Both halves are findings about this product, but they call for opposite responses: the first is a bug we fixed, the second is a design cost we imposed.

## 5. Precision improved, and the improvement is measurable

Same contract, same 40 criteria, two heads:

| run | head | pass | fail | needs_human | real signals among failures |
|---|---|---|---|---|---|
| `fegc` 2026-09-09 | `c5a10cb` | 12 | **8** | 20 | 1 of 8 |
| `nzcr` 2026-09-09 | `c5a10cb` | 16 | 4 | 20 | 1 of 4 (post-7.5 re-run) |
| `hddv` 2026-09-10 | `6636e08` | 17 | 3 | 20 | 1 of 3 |
| `iaqd` 2026-09-10 | `6636e08` | 17 | **3** | 20 | 1 of 3 |

Fixing one instrument defect (story 7.5) and one client script (`ffe12fc`) moved the signal-to-noise ratio from **1 in 8** to **1 in 3** without touching the contract. The three surviving failures are E6-07 (real) and E6-23/E6-28 (client script, unfixed).

`d7` estimated "roughly one instrument artifact per two real signals" from the first run alone. With both heads attributed, the first-run figure was worse than that (7 artifacts to 1 signal) and the current figure is better (2 to 1). The direction is right; the absolute level still disqualifies unattended gating.

## 6. What verification cost

```
Median duration:       200632 ms   (3m 21s, median of 12 runs)
AI-free run share:     12 of 12 (100.0%)
Infra-error rate:      2 of 12 (16.7%)
NEEDS_HUMAN rate:      0 of 12 (0.0%)
```

- **Every run was AI-free.** The plan was compiled once; re-verification spends no provider calls. This is the design working as intended — the repair loop is cheap.
- **Two infra errors**, both `run-20260906T0803*`, both the `provisionPlaywright` defect (`d5`): the function was exported, unit-tested, and called from nowhere in `src/`, so a browser probe could never provision. Fixed in story 7.0. Correctly *not* counted as product failures.
- **`NEEDS_HUMAN rate: 0 of 12` is not a bug**, though it reads like one next to 20 needs_human criteria per run. It counts **runs whose verdict was NEEDS_HUMAN**; every run here ended FAIL or infra error. The metric measures something real, but its name invites exactly this misreading — see §8.

**The cost not in this table is the one that matters most.** `specwitness init` scaffolds three lines of config. gitnebula then needed hand-written JavaScript before the plan had anything to probe — and **three of the eight first-run failures were defects in that code**.

Measured in this session at `6636e08`: **815 lines across eight `.mjs` files**. Action item `d8` recorded 645 lines across seven on 2026-09-06; the difference is an eighth script plus growth in the two repaired on 2026-09-10, so the barrier has **widened, not narrowed**, since it was first written down. **Seven of the eight only read the filesystem** — `readFileSync`/`readdirSync`/`existsSync`/`statSync` and nothing else. Only `serve-bundle.mjs` starts a process.

## 7. Half the contract could not be adjudicated

**20 of 40 criteria — every run — returned `needs_human`.** Seventeen are `critical`.

They are honest: statements like *"a reviewer unfamiliar with the implementation judges each of the three loader error screens"* or *"a maintainer's observed run confirms…"* are not mechanically checkable, and the tool reports that rather than guessing. AD-1 holds — no verdict was ever inferred by an LLM.

But a gate that hands back half its criteria to a human is not yet a merge gate. Whether that is a property of **this contract** (drafted by AI from a BMAD epic, never tuned) or of **contracts in general** is the single most important open question for the next dogfooding run, and it is answerable: draft the next contract deliberately aiming for mechanical verifiability and measure the ratio.

## 8. Findings about SpecWitness produced by writing this report

1. **`NEEDS_HUMAN rate` is denominated by runs, not criteria** (`scorecard-summary.ts:488`). At `0 of 12` beside 20 needs_human criteria per run it reads as a defect and is not one. Rename it, or report both.
2. **`scorecard summary` has no per-criterion view.** Producing §4 and §5 required reading `result.json` by hand across four runs. The command answers "how many", never "which".
3. **The attribution taxonomy cannot express "the client's probe script was wrong."** Three findings here are recorded `false-positive`, which is charged against the tool's precision, when their true cause is code SpecWitness required the client to write. The rate overstates the instrument's noise.
4. **`attributions.jsonl` is neither tracked nor ignored.** `.specwitness/.gitignore` lists `runs/` and `scorecard.jsonl` as local-only, and deliberately tracks `config.yaml`, `contracts/` and `plans/`. It says nothing about `attributions.jsonl`, which therefore sits untracked (`??`) in the client repo — the one artifact here that is pure human judgement, unreproducible by re-running anything, and removable by a stray `git clean`. Decide whether attributions are reviewable product artifacts (track them) or local evidence (ignore them), but not neither.

## 9. Recommendation

**Continue, in this order:**

1. **Close the onboarding cost before the next target.** ADR-009's declarative `file` surface (story 7.8) exists precisely because seven of gitnebula's eight scripts only read files — and E6-23/E6-28, two of the three client-script failures, are a report-file lookup a `file` probe expresses without JavaScript. ~~The next dogfooding run should need **zero** bespoke `.mjs`.~~ **Corrected 2026-09-12 by the §10 measurement: "zero" was too strong, and the honest target is "fewer scripts and fewer chances to get one wrong".**
2. **Calibrate on a second project.** One project cannot separate "this contract was untuned" from "contracts are like this". The next target should be a **new** codebase whose criteria are drafted with mechanical verifiability as an explicit goal, so the needs_human ratio becomes a measurement instead of an accident.
3. **Do not gate unattended yet.** At 2 artifacts per real signal a FAIL still needs a human before it blocks a merge. Revisit when a contract drafted deliberately reaches roughly one artifact per signal.
4. **Fix the three reporting defects in §8** — cheap, and each one cost time during this analysis.

**What would change this verdict.** A second project where the tool finds zero real defects would put the hypothesis in serious doubt. A second project needing hundreds of lines of bespoke probe code would mean ADR-009 did not solve `d8`. Both are cheap to test and neither has been tested.

---

## 10. Addendum 2026-09-12 — how far the `file` surface actually gets, measured

§9's first recommendation was tested before acting on it, by converting gitnebula's eight probe scripts on paper against the `file` surface's real capability envelope. Two of its claims did not survive.

**"815 lines" was the wrong denominator.** `serve-bundle.mjs` (80 lines) is a `services:` entry — it starts an HTTP server so five browser probes have a stable URL. A surface that "runs no command, spawns no process, and opens no socket" was never going to replace it. The real pool is **735 lines**, of which roughly **350 (~48%) convert**. The rest stays by design: ADR-009 §6 already names `analysis-shape.mjs` and `ui-config-shape.mjs` as scripts that must remain, and `ui-source-census.mjs`'s `expect`-argument parser needs bracket matching — "when a check needs a parser, it needs code".

So **"zero bespoke `.mjs`" was too strong** and is withdrawn. The honest target is fewer scripts and fewer chances to get one wrong.

**The stronger result is not about line count.** Of the three defects ADR-009 measured in those scripts, the `file` surface closes **one structurally and one by construction**:

| defect | closed? | why |
|---|---|---|
| non-recursive `findReport` (broke E6-23, E6-28) | **yes, structurally** | a `docs/**/*.md` glob cannot fail to recurse |
| literal counted inside comments (broke E6-09) | **yes, by construction** | `ignoreComments: c-like` is in the product, with tests |
| hand-picked phrases that miss the real documents | **no** | `contains` takes literal text, so the phrase-choice problem is identical |

**And the third one is why this stops here rather than converting gitnebula for real.** The corpus fixture `file-surface-replaces-probe-scripts` already carries this conversion for eight criterion ids including E6-09, E6-23 and E6-28 — on a synthetic tree built to reproduce the defects. Run against the *real* gitnebula, its phrase sets do match: `[validator, unchanged, future]` occurs in three documents, `[content length, viewport height, unreachable]` in one. **E6-23 and E6-28 would flip from fail to pass.**

That flip is not evidence, and converting them would have manufactured a result. The script those criteria came from says so at the point where a maintainer would be tempted:

> Fixing the walk does NOT by itself make those two criteria pass, and that is deliberate: the search terms below are still hand-picked phrases, and the documents that satisfy the criteria use different words. **Widening the regexes to match the documents now known to exist would be fitting the instrument to a result already seen — the one thing a verifier must never do.**

A `contains` list chosen after reading those same documents is the same move in a different syntax. E6-09 offers nothing either: it already passes, since gitnebula's own `ffe12fc` fixed the census, so a conversion would only show the product agreeing with a repaired script.

**What this leaves.** `d8` is *partly* answered — half the script volume is removable, and two defect classes become unavailable to the next client. The part that stays open is the one no surface can close: choosing what text to look for. That needs a project whose documents nobody has read yet, with criteria written **before** the implementation exists — which is exactly what §9's second recommendation calls for, and is now its sharper justification. Filed as `d13`.

## Appendix: the eleven attributions

Recorded with `specwitness scorecard add`, stored in `gitnebula`'s `.specwitness/attributions.jsonl`. The log is append-only; the most recent judgement for a finding is the one the summary counts.

| run | criterion | attribution | why |
|---|---|---|---|
| `fegc` | E6-10 | false-positive | instrument defect `d6`, fixed in story 7.5 |
| `fegc` | E6-11 | false-positive | instrument defect `d6` |
| `fegc` | E6-12 | false-positive | instrument defect `d6` |
| `fegc` | E6-14 | false-positive | instrument defect `d6` |
| `fegc` | E6-09 | false-positive | client probe script; fixed in gitnebula `ffe12fc` |
| `fegc` | E6-23 | false-positive | client probe script (`findReport`), unfixed |
| `fegc` | E6-28 | false-positive | client probe script (`findReport`), unfixed |
| `fegc` | **E6-07** | **unique** | **contract-vs-reality gap; four green gates missed it** |
| `iaqd` | E6-07 | duplicate | same finding, one head later |
| `iaqd` | E6-23 | duplicate | same client-script defect |
| `iaqd` | E6-28 | duplicate | same client-script defect |

Eight of the twelve runs remain unattributed: `bt52`/`ntrr` (3 needs_human and **37 skipped** of 40 — these runs adjudicated almost nothing), `luj6`/`tk12` (infra errors, `d5`), `9cuv`/`dblg` (earlier heads, superseded), `k996`/`nzcr`/`sloa`/`hddv` (intermediate re-runs of heads already attributed). Attributing them would re-count the same findings without adding evidence.
