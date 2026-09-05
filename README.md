# SpecWitness

**An independent verification gate for agentic software development.**

When coding agents and a supervisor believe an epic is finished, SpecWitness runs after
them and proves — with reproducible evidence — whether the assembled epic actually
satisfies the specification that was frozen before the work started. It executes the
branch in an isolated worktree, runs the gates and probes a compiled plan tells it to run,
and returns a verdict computed by arithmetic.

It is built on one rule: **AI writes the verification artifacts; it never decides the
verdict.** A model may draft a verification contract and compile a plan. Whether your epic
passes is a pure aggregation over recorded results, and no model is ever asked the
question.

SpecWitness is local-first: a single npm CLI, no service, no account, no web UI, no
telemetry. It talks to no model API — AI work is delegated to the `claude` and `codex`
CLIs you already have installed, as subprocesses.

> **Status: `0.1.0`, pre-release, not yet published to npm.** Six epics of the V0 scope
> are built and tested; the tool has not yet gated a real epic end to end. See
> [what V0 deliberately does not do](#what-v0-deliberately-does-not-do) before you rely on
> it, and [`docs/versioning.md`](docs/versioning.md) for what the version number will mean.

---

## Contents

- [Why it exists](#why-it-exists)
- [Requirements](#requirements)
- [Install](#install)
- [Quickstart](#quickstart)
- [Commands](#commands)
- [Exit codes](#exit-codes) ← **read this before automating anything**
- [Configuration reference](#configuration-reference)
- [Machine-readable output](#machine-readable-output)
- [What V0 deliberately does not do](#what-v0-deliberately-does-not-do)
- [Security properties](#security-properties)

---

## Why it exists

Coding agents produce plausible work quickly. The gates that check them — lint, types,
unit tests, a supervisor's read of a diff — all evaluate *the change that was made*.
None of them asks the different question: **does the assembled epic do what the
specification said it would?**

SpecWitness asks only that question, and it structures itself so the answer cannot drift:

- The **contract** — what must be true for this epic — is written and **frozen** before
  implementation, and fingerprinted. Changing it later is an explicit, audited amendment,
  never a silent edit.
- The **plan** compiles that contract into probes with explicit assertions. Once compiled,
  a run needs no AI at all.
- The **verdict** is aggregation over what the probes recorded. Evidence is persisted, so
  the answer outlives the terminal that produced it.

---

## Requirements

| | |
| --- | --- |
| **Node** | `>=22.13` (ADR-007 — a hard floor) |
| **Git** | any recent version; SpecWitness runs your branch in a detached worktree |
| **OS** | macOS and Linux. **Windows is not supported** — see below |
| **AI CLIs** | optional. `claude` and/or `codex`, only if you want SpecWitness to *author* contracts and plans |
| **Playwright** | optional. Only for browser probes; everything else works without it |

Installing pulls in four runtime dependencies: `commander`, `execa`, `yaml`, `zod`.

---

## Install

**Not yet published to npm.** When it is:

```bash
npm install -D specwitness
npx specwitness --help
```

Until then, from a clone:

```bash
pnpm install
pnpm build
node dist/cli.js --help
```

---

## Quickstart

Everything below is real output from `specwitness 0.1.0`, pasted as it was printed.

### 1. Scaffold

Run at the project root — the directory holding `.git`.

```console
$ specwitness init
  created  .specwitness
  created  .specwitness/config.yaml
  created  .specwitness/.gitignore
  created  .specwitness/contracts
  created  .specwitness/plans
  created  .specwitness/runs

Next: edit .specwitness/config.yaml, then run 'specwitness doctor'.
```

`config.yaml`, `contracts/` and `plans/` are meant to be committed. `runs/` and
`scorecard.jsonl` are local-only, and `init` writes a `.gitignore` saying so.

### 2. Check the machine

```console
$ specwitness doctor
✓ node-version           Node 22.20.0 (>=22.13)
✓ git-present            git version 2.50.1 (Apple Git-155)
✓ config-valid           .specwitness/config.yaml is valid
✓ base-branch-exists     base branch main resolves
✓ commands-resolvable    no commands declared
⚠ playwright-capability  source: absent, version: unknown, browsers: absent — @playwright/test does not resolve … (optional)
✓ ports-free             no service ports declared
✓ billing-risk-env       no billing-risk API-key variables in the environment
✓ ai-providers           no AI providers configured — contract generation is unavailable by choice

8 passed, 1 warning, 0 failed
```

Exit is `0` when every **required** check passes; warnings do not fail it. A required
failure exits `3`.

### 3. Author, review and freeze a contract

```bash
specwitness contract epic-12            # draft it from your BMAD planning artifacts
$EDITOR .specwitness/contracts/epic-12.yaml   # review it — this is the point of the step
specwitness contract epic-12 --freeze   # fingerprint it
specwitness plan epic-12                # compile the frozen contract into probes
```

**The review is not a formality.** The frozen contract becomes the sole authority on what
"done" means for that epic, and freezing is what stops implementation quietly redefining
it. Commit `.specwitness/` after freezing.

*(Drafting calls a configured AI provider, so it is the one step in this quickstart not
reproduced with real output here — this repository's test suite never invokes a real
`claude` or `codex`. Freezing, planning, verifying and reporting are all shown as they ran.)*

### 4. Verify the assembled epic

```console
$ specwitness verify epic-1 --no-ai
SpecWitness run run-20260905T120449Z-avtq
  Epic:        epic-1
  Contract:    frozen and fingerprint verified — epic-1 v1, 2 criteria, 0 amendments, frozen 2026-09-04T09:15:00.000Z
  Fingerprint: 0a62fbde022f173ed007c140286bf89a46b24344fa9c3fe6898829f55298094b
  Base:        4a58e65c1707ee2c72ec289877f9633aa6fdda98
  Head:        4a58e65c1707ee2c72ec289877f9633aa6fdda98
  Environment: node v22.20.0 · specwitness 0.1.0 · darwin/arm64
  Worktree:    /private/var/folders/…/specwitness-worktree-z8CKsj/worktree
  Run dir:     .specwitness/runs/run-20260905T120449Z-avtq
  Started:     2026-09-05T12:04:49.365Z
  Finished:    2026-09-05T12:04:49.583Z

Stages
  ✓ ok          resolve           0 ms  epic-1: 4a58e65 against 4a58e65
  ✓ ok          integrity         0 ms  epic-1 v1 verified against its fingerprint (2 criteria)
  ✓ ok          worktree         30 ms  detached worktree at 4a58e65
  ✓ ok          setup             0 ms  not implemented yet — Epic 4 runs the configured install command
  ✓ ok          gates            27 ms  1 gate(s) passed
  ✓ ok          services         34 ms  1 service(s) started and ready
  ✓ ok          data              0 ms  no data commands declared
  ✓ ok          probes           59 ms  2 probes executed across 2 planned criteria
  ✓ ok          aggregate         0 ms  verdict: PASS
  ✓ ok          persist           8 ms  result.json written
  ✓ ok          teardown         58 ms  released

Gates
  ✓ pass        lint             18 ms

Criteria
  ✓ pass        E1-01 [critical]  The orders endpoint answers 200 and reports the order state as approved.
  ✓ pass        E1-02 [normal]  The packaged command reports its version.

Counts
  Criteria:  2 pass · 0 fail · 0 needs_human · 0 skipped · 0 error  (0 flaky)
  Gates:     1 pass · 0 fail · 0 skipped

Evidence
  gate lint (pass, exit 0): node gates/lint.cjs
  http GET http://127.0.0.1:47913/orders -> 200
    body:
      {"orders":[],"status":"approved"}
  command version (exit 0): node commands/version.cjs

VERDICT: PASS
```

Exit code `0`.

> **Read the `setup` stage line.** It says *"not implemented yet — Epic 4 runs the
> configured install command"*, and it means it: that stage is a placeholder that always
> reports ok without running your `setup.install` command. It is reproduced here rather
> than tidied away, and explained in
> [the configuration reference](#configuration-reference).

### 5. Re-read a run later, without re-running it

```console
$ specwitness report epic-1
```

`report` is a pure read: it re-renders a stored run and **never re-executes anything**. No
probe runs, no service starts, no provider is contacted — it does not even create a
directory. Pass a run id for a specific run, or an epic id for that epic's latest.

---

## Commands

| Command | What it does |
| --- | --- |
| `init [--force]` | Scaffold `.specwitness/` in the current Git repository. Re-running is safe; `--force` replaces `config.yaml` only, never `contracts/`, `plans/` or `runs/`. |
| `doctor [--json]` | Check the runtime and project configuration. Exits `3` if a required check fails. |
| `contract <epic>` | Draft, inspect, freeze or amend an epic's verification contract. |
| `plan <epic> [--force]` | Compile a frozen contract into an executable plan. |
| `verify <epic>` | Run the verification. **The main event** — flags below. |
| `report <run-id\|epic>` | Re-render a stored run. Re-executes nothing. |
| `clean [--all]` | Reap process groups and worktrees left behind by crashed runs. Never deletes results. |
| `scorecard add\|summary` | Record human attribution of findings, and report the metrics computed from them. **Lands with story 6.6 in this epic — see the note below.** |

Run `specwitness <command> --help` for the authoritative flag list — the binary is always
the truth.

### `scorecard` — measuring whether the tool is worth running

SpecWitness makes a claim: that it finds *real* defects that earlier gates missed. The
scorecard is how you check that claim on your own data rather than taking it on faith.

Every completed run appends a record to a local `.specwitness/scorecard.jsonl`. After a
run, a human attributes each finding — **only a human**: the attribution is never inferred,
never defaulted, and omitting it is a usage error rather than a guess.

```bash
# Attribute one finding. --attribution is required and takes
# unique | duplicate | false-positive
specwitness scorecard add <run-id> --criterion E12-03 --attribution unique

# Report the metrics
specwitness scorecard summary [--json]
```

`summary` reports the north-star number — **unique real defects found after earlier gates
passed** — plus the false-positive, NEEDS_HUMAN, infra-error and flaky rates, median run
duration, AI-free run share, and counts of skipped and unattributed records. Every rate
shows its denominator, and a rate whose denominator is zero is `null`, never `0%`.

Attributions are append-only, and re-attributing is allowed — people change their minds, so
a correction is a later line and the last record wins. `scorecard` adjudicates nothing: it
can exit `0`, `64` or `3`, and never `1` or `2`.

> **⚠️ Status.** These two commands are story 6.6 of this epic, developed in parallel with
> this README and **not yet merged when this section was written**. The surface above is
> the authoritative one its author published at intent-sync, and it is documented here so
> the epic merges with complete documentation rather than a gap. **It is the only section
> of this README not verified against a built binary.** If `specwitness scorecard --help`
> disagrees with the text above, the binary is right and this is a documentation bug —
> please report it.

### `verify` flags

| Flag | Meaning |
| --- | --- |
| `--root <dir>` | Repository to verify. Default: search upward from the current directory. **Only `verify` has this** — see the note below. |
| `--base <ref>` | Ref to verify against. Default: `project.baseBranch` from the config. |
| `--head <ref>` | Ref under verification. Default: `HEAD`. |
| `--json` | Emit the run document on stdout (see [machine-readable output](#machine-readable-output)). |
| `--no-ai` | Refuse to compile a plan; verify only what is already planned. Guarantees zero provider calls. |
| `--explain` | Ask the configured `explainer` role for a **non-authoritative** failure hypothesis. Changes no status, no verdict and no exit code. |
| `--adapt` | Let a provider propose new probe *mechanics* for a browser probe that failed on element-not-found. Assertions and expected values can never be changed. |

> **⚠️ `--root` exists on `verify` and on no other command.** `init`, `doctor`,
> `contract`, `plan`, `report` and `clean` all resolve from the current working directory,
> so invoking them from elsewhere means changing directory first. If you are wiring this
> into a harness, read [the integration guide](docs/harness-integration.md) — it is about
> exactly this.

> **`--explain` is a `verify` flag only.** There is no `report --explain`:
> `specwitness report <epic> --explain` exits `64` with `unknown option '--explain'`.
> That is deliberate. `report` re-renders a persisted document and never re-executes, and
> a merged structural guard keeps it unable to reach a subprocess or a provider at all.
> Explanations are produced during the run that generated them, not bolted on afterwards.

### `contract` flags

| Flag | Meaning |
| --- | --- |
| `--freeze` | Freeze the reviewed draft and print its fingerprint. |
| `--status [--json]` | Report the contract state without prompting. |
| `--force` | Regenerate over an existing **draft** — never over a frozen contract. |
| `--amend` | Supersede a frozen contract with a new version. **Operator only; requires a terminal.** |
| `--reason <text>` | With `--amend`, the audit-trail reason. **Not a confirmation bypass.** |

---

## Exit codes

**Automations branch on these. Get them right and everything else follows.**

| Code | Name | Meaning | What an automation should do |
| :---: | --- | --- | --- |
| **0** | `PASS` | Every criterion passed. Merge-eligible. | Proceed. |
| **1** | `FAIL` | The epic was verified and **defects were found**. | Repair loop. This is a product answer. |
| **2** | `NEEDS_HUMAN` | Verification ran; one or more criteria need human judgement. | Route to a person. |
| **3** | *infra* | **SpecWitness or the environment failed.** No verdict was reached. | Fix the environment and **rerun**. |
| **64** | *usage* | The invocation was wrong — bad flag, bad epic id, missing argument. | Fix the command. |

### The one thing that must not be got wrong

> ### ⚠️ **Exit 3 is NOT a failing verdict.**
>
> Exit `3` means SpecWitness could not answer the question — a service would not start, a
> config was invalid, a worktree could not be created, an unexpected exception was caught.
> **No verdict exists.** An automation that treats `3` as "the epic failed" inverts this
> tool's entire purpose: it reports defects that were never found and teaches its operators
> that a red result means nothing.
>
> **Infra failures are never reported as product FAIL.** That is enforced in code, not by
> convention: `exitCodeForOutcome` in `src/cli/exit.ts` returns `3` whenever an infra error
> is present, *before* it looks at the verdict at all, and the fallback for any
> unclassified exception is also `3` — never `1`.

Two further properties worth relying on:

- **`64` sits outside `0`–`3` on purpose**, so a typo in a flag can never be mistaken for
  `NEEDS_HUMAN`. It is BSD `EX_USAGE`.
- **A bare `specwitness` with no command exits `64`, not `0`.** Exit `0` means
  "merge-eligible", so the tool fails closed rather than emit it by accident.

Errors print an `ERROR:` line and a `HINT:` line to **stderr**:

```console
$ specwitness definitely-not-a-command
ERROR: unknown command 'definitely-not-a-command'
HINT: run 'specwitness --help' to see the available commands and flags
```

`report` is an exception worth knowing: it exits `0` whatever verdict it renders, because
it did not perform the run. Re-adjudicating a stored result is `verify`'s job.

---

## Configuration reference

`.specwitness/config.yaml`. **Only `version` and `project.baseBranch` are required** — a
valid config can be four lines. Unknown keys are rejected with the YAML path that is
wrong, so a typo like `readyness:` is an error rather than a setting that silently does
nothing.

| Key | Required | Default | Notes |
| --- | :---: | --- | --- |
| `version` | **yes** | — | Must be `1`. |
| `project.baseBranch` | **yes** | *none* | **Never assumed.** The branch an epic is verified against. |
| `project.epicBranchPattern` | no | — | Helper for locating an epic branch, e.g. `epic/{n}-{slug}`. `--head` always wins. |
| `planning.format` | no | `bmad-v6` | The only supported format in V0. |
| `planning.planningArtifacts` | no | `docs/planning-artifacts` | Where the PRD, architecture and epics live. |
| `planning.implementationArtifacts` | no | `docs/implementation-artifacts` | Where story files live. |
| `setup.install` | no | — | **⚠️ Accepted and validated, but NOT EXECUTED in `0.1.0`** — see the warning below. |
| `gates[]` | no | `[]` | `{ id, run }`, **run in declaration order; the first failure stops the run.** Every `id` must be unique. |
| `services.<name>.run` | — | — | Command that starts a long-running process. |
| `services.<name>.port` | no | — | Declare it so `doctor` can warn when something already holds it. V0 does not auto-allocate. |
| `services.<name>.ready` | **yes**, per service | — | **Exactly one of `url` or `command`** — both, or neither, is an error. |
| `services.<name>.ready.timeoutSec` | no | `60` | Positive integer. |
| `services.<name>.env` | no | — | String-to-string map. |
| `data.<name>` | no | `{}` | Commands that put test data in a known state. `reset` is the conventional key. |
| `observations.<name>.run` | no | `{}` | Must print **a single JSON object to stdout**. Compared before/after rather than trusted. |
| `retries.{http,browser,observation,shell}` | no | **`0` each** | Opt-in bounded retries, max `5`. **A value above 5 is rejected, not clamped** — what you wrote is what you get. |
| `ai.providers.<name>` | no | — | `{ adapter, mode }`; adapter ∈ `claude-code-cli`, `codex-cli`, `fake`. |
| `ai.roles.<role>` | no | — | Roles: `contract-author`, `plan-author`, `explainer`, `mechanics-adapter`. Each must name a declared provider. |

> ### ⚠️ `setup.install` is not run in `0.1.0`
>
> The config schema accepts it and `doctor`'s `commands-resolvable` check verifies it
> resolves on your machine, so everything *looks* wired. But the pipeline's `setup` stage
> is still a placeholder (`src/pipeline/stages/setup.ts` — it returns ok without doing
> anything, and its own header says *"Filled by Epic 4"*, which has not happened).
>
> **Consequence:** if you rely on `setup.install` to install dependencies inside the
> isolated worktree, they will not be installed, the stage will still report `✓ ok`, and
> your gates will run against a worktree that never had `node_modules`. Until this is
> filled, make your first **gate** do the install instead — gates genuinely execute.

**Every command in this file is a security boundary.** Only commands declared here are ever
executed. Nothing an AI provider returns can introduce a command, a flag or a shell string
— if it is not written in your config, it does not run.

A retried probe that fails and then passes is reported as a **`PASS` marked flaky**, with
every attempt and its evidence recorded. Retries change how often something is tried, never
what the answer means.

`specwitness init` writes a fully commented `config.yaml` with every block above present
and commented out; that file is the fastest way to read this table in context.

---

## Machine-readable output

`verify --json` and `report --json` both emit the run document. It is `schemaVersion: 1`
(the `jsonReport` artifact) and carries:

```
schemaVersion  runId  epic  baseSha  headSha  startedAt  finishedAt
outcome  stages  gates  criteria  flakiness  evidence  providerUsage
environment  contract
```

**`--json` stdout and the persisted `.specwitness/runs/<run-id>/result.json` are the same
bytes.** Not "equivalent" — identical, verifiable with `sha256sum`, because one serializer
produces both. Under `--json`, stdout carries the document and **nothing else**; every
human line goes to stderr.

Timestamps are ISO-8601 UTC with milliseconds (`2026-09-05T12:04:49.365Z`).

If you are consuming this from an agent harness or CI, read
**[`docs/harness-integration.md`](docs/harness-integration.md)** — it covers invocation
from arbitrary directories, the allowlist line, no-TTY guarantees, schema-version skew and
what you can rely on about timestamps.

---

## What V0 deliberately does not do

Listed because a README that describes an intended product is worse than none.

**Not built, by decision:**

- **No SaaS, cloud, accounts, billing, dashboards, hosted execution or browser farms.**
- **No web UI.** The CLI is the whole product.
- **No cloud telemetry.** Nothing leaves your machine; the scorecard is local.
- **No GitHub App**, status checks, GitLab CI integration or MCP server.
- **No ingestion of harness formats other than BMAD v6.**
- **No differential BASE/HEAD execution.** Runs *record* base and head, but V0 executes
  only the head; comparing two executions is v2.
- **No challenge/mutation verification** (`specwitness challenge`) — v2+.
- **No container isolation.** Isolation is a Git worktree plus process-group management.
- **No SQL or native database adapters.** Project-owned observation commands emitting JSON
  are the stack-neutral substitute.
- **No automated repair agents.** Output is repair-*ready*; acting on it is your harness's
  job.
- **No direct Anthropic or OpenAI API usage.** Ever, in V0 — see below.

**Not supported:**

- **Windows.** The win32 code paths exist but have never been executed. macOS and Linux are
  the supported platforms; both are exercised in CI.

**Known rough edges in `0.1.0`:**

- `--root` is accepted by `verify` only; every other command resolves from the working
  directory.
- **The `setup` stage is a placeholder and never runs `setup.install`**, while reporting
  `✓ ok`. See the warning in the configuration reference — this is the one gap in `0.1.0`
  that can silently change what a run means.
- `contract --amend` requires an interactive terminal and cannot be scripted — deliberately,
  since it is an operator action, but it means it is the one command an agent cannot call.

---

## Security properties

Each of these is a property you can check, not a marketing claim. Where a guard is narrower
than the promise, that is said rather than glossed.

**No direct model-API usage.** SpecWitness has no Anthropic, OpenAI or other model SDK
dependency. AI is delegated to the `claude` and `codex` CLIs as subprocesses, reusing the
subscription you already have. Check it: `package.json` declares four runtime dependencies,
and `tests/unit/packaging.test.ts` fails if a model SDK appears in *any* dependency block.

**Credential stores are never read, copied or persisted.** Not `~/.claude/`, not
`~/.codex/`, not `.netrc`. Auth readiness is probed only through each CLI's own commands.
*The mechanically enforced part:* `tests/unit/doctor/credential-boundary.test.ts` walks the
AST of `src/cli/doctor/**` and the `doctor` command and fails on `homedir()`, `userInfo()`,
`HOME`, `USERPROFILE`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or any of those path strings.
**That scan covers the doctor module, not the whole codebase** — it is the module that
probes providers, and the test says so itself. Elsewhere the rule is upheld by review, and
by the corpus suite, which runs every fixture with a constructed environment whose `HOME`
points inside a throwaway directory, so a credential store is not merely unread but
unreachable.

**Only config-declared commands reach a shell.** Provider output cannot introduce a
command. The type system carries this: a raw string becomes an executable `DeclaredCommand`
at exactly one point, inside the config schema, and a test scans for any other route.

**Local-first.** No network calls, no telemetry, no phoning home. Browser probes talk to
your own services; provisioning a browser is the one operation that downloads anything, and
only if you use browser probes.

**Verdicts are never delegated to a model.** Aggregation is a pure function over recorded
results. A provider may draft a contract, compile a plan, or write a clearly-labelled
non-authoritative hypothesis — it can never set a status, change a verdict or move an exit
code.

---

## Further reading

| Document | What it is for |
| --- | --- |
| [`docs/harness-integration.md`](docs/harness-integration.md) | Calling SpecWitness from an agent harness or CI. |
| [`docs/versioning.md`](docs/versioning.md) | Semver policy and the `next` dist-tag plan. |
| `docs/adr/` | Architecture decision records, including the exit-code table (ADR-002). |
| `docs/planning-artifacts/` | PRD, architecture spine and the epic breakdown. |
| `fixtures/corpus/` | The Golden Verification Corpus — hand-written expectations that pin the product's behaviour. |

## License

MIT.
