# Harness integration guide

How to call SpecWitness from an agent harness, a supervisor flow or CI.

This is an API document. Everything in it was verified against the built `0.1.0` binary
rather than read off a specification; where something could not be executed, it says so.
Its audience is both people and agents — so it is precise about flags, exit codes and JSON
shape, and vague about nothing.

Start with the [README](../README.md) for what the tool is. This document covers only the
seven things a harness actually has to get right.

- [1. Invoking from an arbitrary directory](#1-invoking-from-an-arbitrary-directory)
- [2. `--root`, and where it does not exist](#2---root-and-where-it-does-not-exist)
- [3. The machine contract: `--json`](#3-the-machine-contract---json)
- [4. Allowlisting the command](#4-allowlisting-the-command)
- [5. Where the gate sits in a supervisor flow](#5-where-the-gate-sits-in-a-supervisor-flow)
- [6. No-TTY guarantees](#6-no-tty-guarantees)
- [7. Timestamps and freshness](#7-timestamps-and-freshness)
- [8. Version skew](#8-version-skew)
- [Exit codes: the contract you branch on](#exit-codes-the-contract-you-branch-on)

---

## 1. Invoking from an arbitrary directory

A harness runs commands from wherever its own process happens to be. SpecWitness is safe to
invoke by absolute path:

```bash
/abs/path/to/node_modules/.bin/specwitness verify epic-12 --root "$PROJECT_ROOT" --json
```

or, more usually, through the package manager's resolver:

```bash
npx specwitness verify epic-12 --root "$PROJECT_ROOT" --json
```

The binary is a plain Node ESM script with a `#!/usr/bin/env node` shebang and the
executable bit set at build time, mapped as `bin.specwitness → dist/cli.js`. Nothing about
invocation depends on the current directory *except* project resolution, which is item 2
and is the thing to get right.

---

## 2. `--root`, and where it does not exist

> ### ⚠️ `--root` is a flag on `verify` and on no other command.

Verified by running `--help` on all seven commands of `0.1.0`:

| Command | Takes `--root`? | How it finds the project |
| --- | :---: | --- |
| `verify` | **yes** | `--root <dir>`, else searches **upward** from the current directory |
| `init` | no | **current directory only** — deliberately not searched upward, because it *creates* `.specwitness/` |
| `doctor` | no | `process.cwd()` |
| `contract` | no | `process.cwd()` |
| `plan` | no | `process.cwd()` |
| `report` | no | `process.cwd()` |
| `clean` | no | `process.cwd()` |

**What this means for a harness.** Only the verification step can be invoked from anywhere.
Every other step must run with the working directory set to the project root:

```bash
# Correct — verify takes the root as a flag
npx specwitness verify epic-12 --root "$PROJECT_ROOT" --base master --head "origin/epic/12-invoicing" --json

# Correct — everything else needs the cwd
( cd "$PROJECT_ROOT" && npx specwitness report epic-12 --json )

# WRONG — report has no --root; this exits 64 with "unknown option '--root'"
npx specwitness report epic-12 --root "$PROJECT_ROOT"
```

Note the asymmetry between `verify` and `init`: `verify` searches *upward* for the project,
so running it from a subdirectory works. `init` never searches upward, because scaffolding
into a parent you did not mean would be worse than failing. `init` outside a Git repository
exits `3`, not `64` — the invocation was well-formed, the environment was not ready.

---

## 3. The machine contract: `--json`

`verify --json` and `report --json` emit the **run document**. `doctor --json`,
`contract --status --json` and `scorecard summary --json` emit different documents — **do
not write one parser for all of them.** Each versioned document carries its own
`schemaVersion` and they move independently: the run report is the `jsonReport` artifact
(version `1`), the dogfooding summary is `scorecardSummary` (version `1`). Pin the one you
consume.

### The property to rely on

> **`--json` stdout is byte-for-byte identical to the persisted
> `.specwitness/runs/<run-id>/result.json`.**

Not "equivalent", not "the same data" — the same bytes, so you may hash, cache or diff
either one interchangeably. Verified:

```console
$ specwitness report epic-1 --json > stdout.json
$ shasum -a 256 stdout.json .specwitness/runs/run-20260905T120449Z-avtq/result.json
0b67a54d6feba00b745a91eabaa75ba2c24f91f9a26d1bbab39fe3bace463f2e  stdout.json
0b67a54d6feba00b745a91eabaa75ba2c24f91f9a26d1bbab39fe3bace463f2e  .specwitness/runs/run-20260905T120449Z-avtq/result.json
```

This holds by construction rather than by discipline: one serializer
(`serializeRunResult`) produces both, and under `--json` `report` emits the stored file's
own bytes rather than re-serializing a parsed object.

### Schema version

The run document carries **`"schemaVersion": 1`** — the `jsonReport` artifact. Branch on
that field, not on the CLI's `--version`. Top-level keys, in the order they are written:

```
schemaVersion  runId  epic  baseSha  headSha  startedAt  finishedAt
outcome  stages  gates  criteria  flakiness  evidence  providerUsage
environment  contract
```

`outcome.verdict` is `PASS` | `FAIL` | `NEEDS_HUMAN`. When infrastructure failed,
`outcome` carries an `infraError` instead and the process exits `3`.

### Stream discipline

Under `--json`, **stdout carries the document and nothing else.** Every human line goes to
stderr. So this is safe:

```bash
result="$(npx specwitness verify epic-12 --root "$PROJECT_ROOT" --json)"   # pure JSON
rc=$?
```

and stderr will separately carry a line like
`Rendered run-20260905T120449Z-avtq from /…/result.json`. Capture stderr to a log; do not
merge it into stdout.

**Bounded output.** A harness that truncates stdout (the first-client harness truncates at
roughly 12 KB and points at a log file) should read the run document from
`.specwitness/runs/<run-id>/result.json` rather than from a truncated pipe. The `runId` is
printed in the human output and is the first useful field of the JSON.

---

## 4. Allowlisting the command

An agent harness that gates tool calls needs the CLI on its allowlist, or every invocation
prompts. For Claude Code-style agent settings, the line is:

```
Bash(specwitness *)
```

### What that grant actually permits

Be precise about this, because it is a real privilege grant in someone's settings.

It permits the agent to run **any** `specwitness` subcommand with **any** arguments. That
is broader than "run the verification", and it includes at least:

- `specwitness verify …` — which **executes commands declared in that project's
  `.specwitness/config.yaml`**: gates, services, data commands, observation commands. The
  grant is therefore effectively "run this project's declared commands".
- `specwitness init --force` — overwrites `config.yaml` (nothing else).
- `specwitness clean --all` — reaps worktrees and process groups. It never deletes results.
- `specwitness contract <epic> --freeze` — freezes a contract.

It does **not** permit amending a frozen contract non-interactively: `contract --amend`
requires a terminal and refuses without one (item 6).

**The bound worth knowing, stated precisely — because the obvious version of this sentence
is wrong.**

What a provider can **never** do: name an executable, or produce a shell string. A plan
cannot express a command at all — a probe carries a `commandId` referring to a command
declared in `.specwitness/config.yaml`, and the path from a declared command to a child
process is `ProcessRunner.run(binary, args)` with no shell anywhere in it, so `;` and
`$(…)` arrive at the child as literal argv text. **The set of executables that can run
against your project is exactly the set a human committed to the config** — gates,
services, data commands, observations and shell probes.

**SpecWitness also runs its own fixed toolchain, which your config does not list:** `git`
(`src/infra/vcs.ts:495`), the `claude`/`codex` binary behind a configured AI role (the
config names an *adapter*; the adapter supplies the binary), and the Playwright browser
binaries if you use browser probes. Those are hard-coded, not provider-chosen — but a
reader auditing this grant should know that reviewing `config.yaml` enumerates what runs
*from the project*, not everything the process spawns.

What a provider **can** do: **choose the arguments** to one of those commands. A compiled
plan's shell and observation probes carry `mechanics.args`, and `src/surfaces/shell.ts:35`
says so in as many words — *"a shell probe is the one place in the product where a
provider-authored artifact chooses ARGUMENTS to a real command."* Those arguments are
checked against an `argumentAllowlist` twice, at schema time and again immediately before
spawning, by exact string equality (no prefix, glob or regex). But **when the plan is
compiled by AI, the provider authors that allowlist as well as the arguments**, so the
check does not bound the provider — it bounds later edits to the plan file.

**So the honest blast radius is: the executables in your config, invoked with arguments
that may not be in your config.** An argument can itself be a flag, and a flag can change
what a command does.

**The mitigation is the one the quickstart already prescribes, and this is the reason for
it.** Compile the plan with `specwitness plan <epic>`, **read it**, and commit it — a plan
is committed YAML precisely so a human can review it before it executes. Then verify with
`--no-ai`, which refuses to compile a plan and so guarantees no provider is in scope at
all. **A harness that runs `verify` with AI enabled against a project with no committed
plan is executing argument lists nobody has reviewed.**

If you want a narrower grant, allowlist the specific invocations you intend rather than
widening to `Bash(*)`. Do not grant anything broader than the line above on SpecWitness's
account.

---

## 5. Where the gate sits in a supervisor flow

For the first-client harness surveyed in the PRD addendum (§A), the slot is the supervisor
prompt's **§8a, "AC sweep across every story"** — the point after every story PR has merged
into the epic branch and before the epic merges to the base branch. That is precisely the
question SpecWitness answers, and the existing `codex-auto-review.sh` (a foreground
`codex exec review` subprocess) is the closest existing pattern for how to call it.

A full sequence:

1. **Once per project:** `init`, edit `config.yaml`, `doctor` until clean. Add
   `Bash(specwitness *)` to the harness allowlist.
2. **After planning, before the coding cohort launches:** draft the contract, review it by
   hand, `--freeze` it, `plan` it, commit `.specwitness/`. Freezing *before* implementation
   is the point — a contract written afterwards describes what was built.
3. **Cohort runs as usual.** Story PRs merge into the epic branch.
4. **At §8a**, from the supervisor's terminal:
   ```bash
   npx specwitness verify epic-12 --root "$PROJECT_ROOT" \
     --base master --head origin/epic/12-invoicing --json
   ```
   The invocation location is the supervisor's; execution is isolated in a detached
   worktree regardless.
5. **Branch on the exit code** (see below). On `1`, create one repair task per failed
   criterion, feeding each agent the criterion statement, expected/actual and the evidence
   paths from `result.json` — then rerun step 4 with `--no-ai`, since the plan is already
   compiled.
6. **After merging, measure.** Attribute each finding and read the metrics back:
   ```bash
   specwitness scorecard add <run-id> --criterion E12-03 --attribution unique
   specwitness scorecard summary --json
   ```
   This is the step that tells you whether the gate is earning its place. Attribution is a
   human judgement and the CLI will not supply one for you — `--attribution` is required.

   > **⚠️ `scorecard` is not in `0.1.0`** — it is not registered in today's binary and
   > these two invocations exit `64` until story 6.6 merges. Do not wire this step into a
   > harness yet. Every other command in this guide exists today.

**Verify the survey before relying on it.** PRD addendum §A was written on 2026-08-30 and
describes one specific harness. Its §B has already needed a correction. The invocation
facts in it — no TTY, bounded stdout, the allowlist requirement, the §8a slot — are
consistent with the built binary and with this document, but the harness itself may have
moved; check your own supervisor prompt for the slot rather than trusting the section.

---

## 6. No-TTY guarantees

**Every agent-callable command is prompt-free.** Verified by running with stdin redirected
from `/dev/null` and stdout to a pipe — not by trusting the convention:

- `verify`, `report`, `doctor`, `plan`, `clean`, `init` and `contract --status` all run to
  completion with no terminal attached and never block on input.
- `doctor --json < /dev/null | head` produced the full JSON document on stdout with the
  human report on stderr, and exited normally.

### The one exception, and it fails closed

`contract --amend` **requires an interactive terminal** and refuses without one:

```console
$ specwitness contract epic-7 --amend --reason "test" < /dev/null
ERROR: amending a contract requires an interactive terminal
HINT: amendment is an operator action: run it yourself in a terminal. There is deliberately no non-interactive flag — see ADR-005
```

Exit code `3`. **It does not hang** — that is the property a harness needs. Amending a
frozen contract is an operator decision by design, and `--reason` is an audit-trail field,
not a confirmation bypass. Do not attempt to script it; there is no flag that makes it
non-interactive, and its absence is deliberate.

The check requires **both** `stdin` and `stderr` to be TTYs, so redirecting either one is
enough to trigger the refusal.

---

## 7. Timestamps and freshness

Everything time-stamped is **ISO-8601 UTC with milliseconds and a `Z` suffix**:
`2026-09-05T12:04:49.365Z`. There is no local time and no offset form anywhere in the
persisted documents.

What a consumer can rely on:

| Field | Meaning |
| --- | --- |
| `startedAt` | When the run began, before any resource was acquired. |
| `finishedAt` | When the run completed. Present on any run that persisted a result. |
| `runId` | `run-<YYYYMMDDTHHmmssZ>-<4 chars>` — the compact UTC timestamp of the run, plus a suffix for uniqueness. |

**`runId` sorts chronologically as a plain string — to one-second resolution, and no
further.** The id is `run-<YYYYMMDDTHHmmssZ>-<4 base36>`: the timestamp is truncated to
whole seconds and the four trailing characters are **random**, not a counter. So a string
sort orders runs correctly whenever they are more than a second apart, and **orders two
runs from the same second arbitrarily.**

`report <epic>` resolves "latest" with exactly this sort, so the limitation is the
product's and not only a harness's: **two runs started in the same second can be reported
in either order.** In practice a verification run takes far longer than a second, so this
needs deliberate concurrency to hit — but a harness that fires runs in parallel, or a test
that seeds fixtures in a loop, is exactly where it would appear. If you need a total
order, sort on `startedAt` from the run document rather than on the id.

### ⚠️ Freshness: compare SHAs, not timestamps

**To decide whether a stored run covers what you are about to merge, resolve the ref and
compare its SHA to the run's `headSha`. Nothing else is safe.**

```bash
test "$(git rev-parse "$REF")" = "$(jq -r .headSha result.json)"
```

**Do not decide it from timestamps.** Comparing `finishedAt` against the commit timestamp
of the head is the intuitive check and it is **wrong**: commit timestamps are not
monotonic. A rebase, a cherry-pick, an amend or a force-push can put a *newer* head on an
*older* committer date — and clocks on other people's machines are not yours. A run that
verified different code then looks fresh, and **unverified code merges.** Timestamps are
for reporting age to a human, never for deciding coverage.

Do not use the run directory's mtime either: `clean` may touch run directories, and a
rerun does not modify an earlier run's files.

*(An earlier draft of this guide recommended the timestamp comparison. That was a defect
in this document, caught in review, and it is called out here rather than quietly
replaced — a harness that copied the old advice should change it.)*

**A run that never finished has no `result.json`.** `report` answers such a run from the
crash-recovery manifest instead, printing the run id, creation time, epic, whether it was
reaped, and a line saying no result was stored. Under `--json` there is no partial document
— a machine consumer gets a document or an error, never half of one.

---

## 8. Version skew

Persisted artifacts carry `schemaVersion` and evolve **additively**: a new optional key may
appear in a later version, and documents written by older versions stay readable. Several
features have already been added this way without moving `jsonReport` past `1`.

The rule your consumer should follow, and the rule SpecWitness follows itself (ADR-008):

- **An unrecognised key in the run document's envelope means a newer SpecWitness wrote it.**
  The remedy is to upgrade the reader, not to treat the document as corrupt.
- **Append-only logs are read line by line.** The local scorecard is a `.jsonl` file with
  the version on each *line*, so a single unreadable record is skipped with a warning and
  counted, rather than failing the whole read. Refusing to summarise 200 good records
  because record 47 came from a newer build would destroy the measurement the file exists
  for.
- **This does not apply to provider-authored sub-trees.** An unexpected key inside an
  explanation or adaptation payload is *not* treated as version skew — it is the shape of a
  provider returning a field the schema never granted it, and it is rejected. Telling an
  operator to upgrade in that situation would send them away from the document that
  recorded the attempt.

A harness that pins a SpecWitness version and a schema version it understands, and upgrades
them together, will not encounter any of this. One that reads run documents produced by
several versions should branch on `schemaVersion` and ignore keys it does not know.

---

## Exit codes: the contract you branch on

| Code | Name | What it means | Harness action |
| :---: | --- | --- | --- |
| **0** | `PASS` | Every criterion passed; merge-eligible. | Proceed to merge. |
| **1** | `FAIL` | Verified, and **defects were found**. | Repair loop. A product answer. |
| **2** | `NEEDS_HUMAN` | Ran successfully; some criteria need human judgement. | Route to a person. |
| **3** | *infra* | **No verdict was reached.** Environment or SpecWitness failed. | Fix and **rerun**. Never report as a failing epic. |
| **64** | *usage* | Bad invocation — unknown flag, malformed epic id, missing argument. | Fix the command. |

**The table above is true of a run whose output is read to the end.** There is one known
way to get `1` out of a passing run, and because a harness is the thing most likely to hit
it, it has its own section immediately below.

> ### ⚠️ KNOWN DEFECT — a PASS can exit `1` when your reader closes the pipe early
>
> **This violates the exit-code contract, it is unfixed in `0.1.0`, and it is reachable
> from a harness.** If you take one thing from this guide, take this and the `3` note below.
>
> **The shape.** Merge stderr into stdout and feed it to a reader that stops early —
> `2>&1 | head -1`, `2>&1 | grep -q …` — and a run that passed can exit `1`.
>
> **The mechanism**, as measured by the author of story 6.5 who found it: the **second
> write to a closed pipe** is fatal, whichever descriptor carries it. On stderr the `EPIPE`
> arrives as an asynchronous `'error'` event, so no `try`/`catch` in the CLI can contain
> it. It therefore needs *two* writes — typically a warning printed before the report, then
> the report itself. Their measurement: with the pipe closing early, a run that printed a
> warning from merged code before a passing report exited `1`; the same run unpiped exited
> `0`. **Piping stdout alone, with stderr discarded, exited `0`** — a single write to a
> not-yet-closed pipe cannot `EPIPE`.
>
> **It is not fixed because the remedy is a change to stdout error handling at the CLI edge
> and a decision about the ADR-002 contract itself** — merged code that no Epic 6 story
> owns. It was escalated rather than patched, on the principle that several agents fixing
> one defect several different ways is worse than the defect.
>
> **What a harness should do — any one of these avoids it entirely:**
>
> 1. **Do not merge stderr into stdout.** Keep them separate; the guide already recommends
>    it, because under `--json` stdout must carry the document alone.
> 2. **Do not pipe our output into an early-closing reader.** Redirect to a file and read
>    the file: `… --json > result.json 2> verify.log`. `head`, `grep -q` and `head -n1` are
>    the readers that close early.
> 3. **Prefer the persisted document.** `.specwitness/runs/<run-id>/result.json` is the
>    same bytes and is not affected by any of this.
> 4. **Treat exit `1` with no `criteria` reported as suspect** rather than as a verdict. A
>    real `FAIL` always comes with a document naming what failed.
>
> **Honest limit on this note.** I documented this from story 6.5's recorded measurement
> and its own corrected mechanism, and I cite it rather than claim it. **I did not
> reproduce it myself:** five shapes I tried against `0.1.0` — `report --json` piped to
> `head -c 20`, to `head -1`, the human report, `--help`, and all of those again with
> `2>&1` — every one exited `0`. That is consistent with the measurement (those are single
> writes, or the two writes land too close together), and it means the trigger is narrower
> than "any pipe". Take the four rules above as cheap insurance, not as a sign that every
> piped invocation is unsafe.

> ### ⚠️ Do not treat `3` as a failing verdict.
>
> Exit `3` means the question was not answered. Reporting it as "the epic failed" invents
> defects that were never found and inverts the tool's purpose. **Infra failures are never
> reported as product FAIL** — `exitCodeForOutcome` returns `3` whenever an infra error is
> present, before it looks at the verdict, and any unclassified exception also becomes `3`,
> never `1`.
>
> `64` deliberately sits outside `0`–`3` so a typo in a flag can never be read as
> `NEEDS_HUMAN`. And a bare `specwitness` with no command exits `64`, not `0`, because `0`
> means merge-eligible and the tool fails closed.

A minimal, correct branch:

```bash
npx specwitness verify "$EPIC" --root "$PROJECT_ROOT" --json > result.json 2> verify.log
case $? in
  0)  echo "PASS — merge-eligible" ;;
  1)  echo "FAIL — defects found; open repair tasks from result.json" ;;
  2)  echo "NEEDS_HUMAN — route the listed criteria to a reviewer" ;;
  3)  echo "INFRA — not a verdict. Fix the environment and rerun."; cat verify.log ;;
  64) echo "USAGE — fix the invocation"; cat verify.log ;;
esac
```

Errors always print an `ERROR:` line and a `HINT:` line to stderr, so `verify.log` is worth
keeping on every non-zero code.

---

## Things this guide could not verify

Stated explicitly rather than described plausibly:

- **A real `claude` or `codex` invocation.** Contract drafting and plan compilation are
  proven against the shipped `fake` adapter only. The shape of a live provider response is
  unverified here.
- **Windows.** Unsupported and untested; the win32 code paths have never executed.
- **A published npm install.** Nothing is published yet. The install path is proven from a
  packed tarball installed into a clean directory, which is the same artifact, but the
  registry round trip has not happened.
- **The current state of the first-client harness.** PRD addendum §A is a survey from
  2026-08-30; check your own supervisor prompt for the §8a slot.
- **The `scorecard` commands.** They ship with story 6.6 of this epic and had not merged
  when this guide was written, so unlike everything else here their surface comes from
  their author's published specification rather than from a `--help` I ran. Everything
  else in this document was executed.
