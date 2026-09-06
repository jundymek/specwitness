# SpecWitness defects found during the first real dogfooding (2026-09-05)

Collected by the owner while running Epic 7.1 — the first use of SpecWitness as a real
merge gate, against `gitnebula`'s Epic 6 (`epic/6-assembled-viewer`, five stories, a pnpm
monorepo, 40 frozen criteria).

Unlike `epic-2-harness-defects-2026-08-31.md`, **every entry here is a SpecWitness defect**,
not a harness one. Each is recorded with the reproduction that produced it.

**Both entries are in the same subsystem and neither was reachable before today.** The Epic
6.11 retrospective §9 named the gap in advance: *"Any real `claude` / `codex` invocation —
this epic makes no provider call, so nothing here was verified against a live CLI."* Six
epics of adapter and schema code had never met the binaries they drive. The first two real
invocations found one defect each.

---

## D-1. The plan schema is not expressible in OpenAI structured outputs, so `codex` can never compile a plan

**Cost: the `plan` step is impossible with `plan-author: codex`, for every project, not just
this one.** Worked around by reassigning the role to `claude`, which does not use
`--output-schema`.

**Status: OPEN.** Not fixed today — see "Why this was not patched in the adapter".

### Symptom

```console
$ specwitness plan 6
ERROR: provider "codex" (codex-cli) did not return a schema-valid response for role "plan-author" after 3 attempts:
  attempt 1 (provider-failed): codex exec exited 1: Reading additional input from stdin...
  attempt 2 (provider-failed): codex exec exited 1: Reading additional input from stdin...
  attempt 3 (provider-failed): codex exec exited 1: Reading additional input from stdin...
HINT: rerun to retry, or check the provider CLI is authenticated and responding
```

The message names the wrong subsystem twice over. `Reading additional input from stdin...`
is codex's ordinary first line of output, **not an error** — a hand-run invocation printing
that same line exits 0. And the HINT sends the operator to check authentication, which
`doctor` has already reported healthy (`codex 0.144.4 found, exec available, auth appears
usable`).

### Root cause

`codex exec --output-schema` forwards the schema to OpenAI structured outputs, which rejects
it with HTTP 400 before any model work happens. The real message, recovered by running the
adapter's own argv by hand:

```
"code": "invalid_json_schema",
"message": "Invalid schema for response_format 'codex_output_schema':
  In context=('properties','criteria','items','properties','probes','items','properties','mechanics'),
  'additionalProperties' is required to be supplied and to be false."
"status": 400
```

**Fixing that one node reveals a second violation, and fixing that reveals a third.** Each
was reproduced by patching the generated schema and re-invoking:

| # | structured-outputs rule | what the plan schema does | sites |
| --- | --- | --- | --- |
| 1 | every object needs `additionalProperties: false` | `z.record()` emits a *type* there, not `false` | 1 — `HttpProbeSchema.mechanics.headers` (`src/schemas/plan.ts:345`) |
| 2 | `oneOf` is not permitted | discriminated unions compile to `oneOf` | 6 |
| 3 | `required` must list **every** key in `properties` | `.optional()` leaves the key out | 2 objects (`headers`, `body`, `around`) |

The third rejection states it plainly, and it is the one that decides the shape of any real
fix:

```
'required' is required to be supplied and to be an array including every key in properties.
Missing 'headers'.
```

**`.optional()` is not expressible in structured outputs at all.** This is a schema-design
problem, not an adapter bug.

### What was ruled out, by measurement

| checked | result |
| --- | --- |
| codex authenticated and responding | `echo "Reply with exactly: OK" \| codex exec -` → exit 0 |
| the four required flags exist | `codex exec --help` lists `--cd`, `--skip-git-repo-check`, `--output-schema`, `-o` |
| the adapter's empty-string stdin (`codex-cli.ts:717`) | reproduced via execa with `input: ''` → **exit 0**. Not the cause. |
| the oversized/stdin path (70 KB prompt via `-`) | exit 0 — this path is fine |
| prompt or schema size | plan schema is **7 447 bytes**. Size is not a factor. |
| the other three provider schemas | `contract`, `explainer`, `adaptation` all scan clean — which is why `contract 6` succeeded |

**Two earlier diagnoses were wrong and are recorded here so they are not re-attempted:** the
empty stdin (disproved above), and "`headers` is the cause" (it is one of three).

### Why this was not patched in the adapter

The tempting fix is to rewrite the schema in `codex-cli.ts` just before handing it over.
**It cannot be done correctly:**

- **`oneOf → anyOf` changes meaning.** `oneOf` is "exactly one variant"; `anyOf` is "at
  least one". Across the probe union that is the difference between "this is an http probe"
  and "this may be an http probe and a shell probe at once".
- **`.optional()` has no safe translation.** Forcing `headers` into `required` makes the
  model always emit it; adding `null` to the type changes the data contract. Either way the
  plan the provider returns is not the plan the domain validates.
- **It puts schema authority in two places.** The adapter would be rewriting a schema it
  does not own, and every future change to `src/schemas/plan.ts` could silently drift from
  the rewrite. AD-2 exists to prevent exactly this, and the module's own comments already
  say the adapter must not derive a schema because *"two derivations that can disagree is
  the AD-2 failure of validation happening twice"*.

A green run producing a plan with different semantics from the one SpecWitness validates
would be worse than today's loud failure.

### Suggested fix — a story, not a patch

Redesign the plan response schema so it is expressible in structured outputs:

- arrays of `{name, value}` pairs instead of `z.record()` maps;
- an explicit discriminator field (`z.enum`) instead of `z.discriminatedUnion`;
- explicit `null` instead of `.optional()`.

This changes the plan format, so it touches `PLAN_SCHEMA_VERSION`, the corpus fixtures that
carry pre-compiled plans, and needs an ADR. It should not be done as a hotfix mid-dogfooding.

**Second, independent fix — the error message.** The adapter quotes the child's first stdout
line as the failure reason. When a provider exits non-zero after printing a routine progress
line, the resulting message actively misdirects. Prefer the child's structured error, and
say so when `doctor` and the invocation disagree — that disagreement is itself the signal.

---

## D-2. The generation timeout was sized for contracts, and `plan` is a much larger job

**Cost: three wasted attempts and ~8.5 minutes before any diagnosis was possible.**

**Status: FIXED 2026-09-05** — `DEFAULT_INVOCATION_TIMEOUT_MS` in
`src/providers/claude-code-cli.ts` raised from 300 000 ms to 900 000 ms.

### Symptom

With `plan-author: claude` on the same 40-criterion contract:

```console
attempt 1 (provider-failed): claude timed out after 300000ms while drafting for role "plan-author"
attempt 2 (schema-rejected): data: Invalid input: expected object, received undefined
attempt 3 (schema-rejected): criteria.0.probes.0.mechanics.args: Invalid input: expected array, received undefined
```

Exit 3. No artifact written, as promised.

### Root cause

The constant's own comment read *"Drafting a contract is slow work"* — and that is what it
was sized for. But one constant serves **every** role, and `plan-author` is a much larger
job: a contract draft reads an epic and emits criteria, whereas a plan must emit probes,
assertions and reviewer guidance for **every** criterion in a single response. At 40
criteria the bound fired before the model finished.

Attempts 2 and 3 are the same pressure in a different form: partial and truncated responses
rather than a clean timeout. Attempt 3 reached `criteria[0].probes[0].mechanics` and omitted
its required `args`.

**The retry budget made it worse, not better.** Three attempts against a deterministic wall
spend the budget re-hitting it. A bound that is too low is not recoverable by retrying.

### Fix applied

Raised to fifteen minutes, and deliberately **above** `codex-cli.ts`'s ten, because the two
adapters are not doing equal work: codex is handed a JSON Schema via `--output-schema` and
the API enforces the shape, while this adapter carries the schema **in the prompt** and the
model must hold it while composing. More work per token, so a longer bound. The rationale is
recorded at the constant rather than here, so the next reader finds it where the number is.

`tests/unit/providers` — 206 tests — passes unchanged; no test pinned the old value.

### Carried question

There is still **no configuration surface** for this timeout (`ai.providers.<name>` carries
only `adapter` and `mode`), so a project with a larger contract than gitnebula's 40 criteria
has no recourse but another source change. Worth deciding whether that surface should exist
before a second dogfooding target appears.

---

## D-3. `plan` refuses to recompile after the project declares new surfaces, and says nothing needs recompiling

**Cost: one confusing refusal; recovered with `--force`.** Low severity, but the message
asserts something false.

**Status: OPEN.**

### Symptom

After adding six observation commands to `.specwitness/config.yaml` — with the contract
untouched and still frozen at version 1 — recompiling was refused:

```console
$ specwitness plan 6
ERROR: the plan for epic-6 at .specwitness/plans/epic-6.yaml already matches the frozen contract (version 1)
HINT: nothing needs recompiling — pass --force to compile a fresh plan anyway, which discards any mechanics you have edited by hand
```

Exit 3.

### Why the refusal is right and the sentence is wrong

**The guard itself is correct and should stay.** A plan is committed YAML that a human may
edit by hand, and silently overwriting that work would be worse than an extra flag. Exit 3
rather than 1 is also right: nothing about the branch is wrong.

But `nothing needs recompiling` was **false** at the moment it was printed. Recompiling was
exactly what was needed. The check compares the plan against the **contract fingerprint**,
and the contract had not changed — what changed was the set of declared surfaces the plan is
allowed to reference. A plan names commands and services by `commandId` / `serviceId`, so
declaring a new observation genuinely widens what can be planned. The first compile had
mapped 5 of 40 criteria and reported 32 as `not-safely-automatable` **because the surfaces to
map them did not exist yet**; the whole point of adding them was to change that answer.

So the guard is measuring one input to the plan and speaking for all of them.

### Suggested fix

Two options, in order of preference:

1. **Include the declared ids in the staleness check.** The plan already records which
   `commandId` / `serviceId` values it references; the config knows which exist. A plan
   compiled against a smaller set of declared ids than the project now has is legitimately
   stale, and saying so turns a confusing refusal into a useful prompt.
2. **Failing that, narrow the sentence.** `nothing needs recompiling` should be something
   like `the contract has not changed since this plan was compiled` — true, checkable, and
   it does not claim to have considered inputs it never looked at.

Either way the `--force` escape hatch and its warning about hand-edited mechanics stay as
they are.

---

## D-4. A transient provider probe failure spends the whole retry budget in 15 seconds

**Cost: one failed run, immediately recovered by re-running.** Recorded because the shape of
the failure is worth knowing, not because it blocked anything.

**Status: OPEN (observed once, not reproduced).**

### Symptom

```console
$ specwitness plan 6 --force
ERROR: provider "claude" (claude-code-cli) did not return a schema-valid response for role "plan-author" after 3 attempts:
  attempt 1 (provider-failed): provider "claude" cannot run: claude did not respond within 5000ms — state unknown
  attempt 2 (provider-failed): provider "claude" cannot run: claude did not respond within 5000ms — state unknown
  attempt 3 (provider-failed): provider "claude" cannot run: claude did not respond within 5000ms — state unknown
```

Exit 3. Checked immediately afterwards, from the same directory: `claude --version` returned
in **15 ms**, and `specwitness doctor` reported `auth appears usable`, 8 passed. The next
invocation proceeded normally.

### What this is

5 000 ms is `PROBE_TIMEOUT_MS` (`src/providers/claude-code-cli.ts:82`), not the generation
bound — so all three attempts died in the **capability probe**, before any drafting began.
Three attempts against a 5-second probe exhaust the retry budget in about fifteen seconds,
and the run reports a provider that was demonstrably healthy moments later.

The probe timeout itself is defensible and matches doctor's precedent: a diagnostic that
hangs is worse than one that reports a hang. The questionable part is spending all three
recorded attempts on the same instantaneous failure with no pause between them — a retry
that adds no delay cannot recover from a transient condition, which is the only kind of
failure a retry is for.

### Suggested fix

Consider a short backoff between provider attempts, or treating a probe failure as distinct
from a drafting failure for retry purposes. Neither is urgent; a re-run works. Worth deciding
before a harness calls `plan` unattended, where a fifteen-second self-inflicted failure would
look identical to a real outage.

---

## D-5. `provisionPlaywright` is exported, tested, and called by nothing — so a browser probe can never provision

**Cost: browser probes are unreachable on any project that does not already resolve
`@playwright/test` from its own root.** For gitnebula — a pnpm monorepo where Playwright is
a devDependency of `packages/viz` — that is every browser probe in the plan, and the run
stops at exit 3 with five criteria unadjudicated.

**Status: OPEN. This is the most consequential defect found in the first dogfooding run.**

### Symptom

```console
$ specwitness verify 6 --no-ai
...
  ✓ ok      setup      installed with 'pnpm install --frozen-lockfile' (exit code 0)
  ✓ ok      gates      4 passed
  ...18 observations executed, 9 criteria adjudicated...

VERDICT: (none) — infra error: infra
ERROR: infra: browser probe for E6-10 cannot run: @playwright/test does not resolve from /Users/jundymek/dev/gitnebula and is not in the SpecWitness cache
HINT: run `specwitness doctor` to resolve or provision Playwright — a browser probe is never skipped, because a criterion that checked nothing must not report PASS
```

Run twice, identically. `~/Library/Caches/specwitness/` **does not exist** afterwards:
nothing was downloaded, and nothing tried.

### Root cause

```console
$ grep -n "export.*provisionPlaywright" src/infra/playwright-env.ts
931:export async function provisionPlaywright(options: ProvisionOptions): Promise<PlaywrightResolved> {

$ grep -rn "provisionPlaywright(" src/ | grep -v export
(no output)

$ grep -rln "provisionPlaywright" tests/
tests/unit/infra/playwright-env.test.ts
tests/unit/infra/playwright-pin.test.ts
tests/provisioning/playwright.provision.ts
```

**The function is written, unit-tested, and called from nowhere in `src/`.** The only
callers are its own tests. `src/surfaces/browser.ts` resolves the environment, finds none,
and throws — it never provisions.

This is structurally the same defect story 6.11 closed for `setup.install`: a capability the
config surface advertises, the diagnostics validate, and the pipeline never invokes. It went
unnoticed for the same reason — Epic 5's browser suites self-skip on every runner that has
no chromium, so nothing ever executed the path in anger. The 6.11 retrospective §9 listed
"the first dogfooding procedure" among the gates no agent could run; this is what was behind
it.

### The messages promise what the code does not do

Two user-facing strings describe provisioning as something that will happen:

- `doctor` (`src/cli/doctor/checks/playwright-capability.ts:131`) — *"or let SpecWitness
  provision one into `<cacheDir>` **on the first browser probe**"*. There is no such
  provisioning on the first browser probe, or on any later one.
- `verify` (`src/surfaces/browser.ts:1140`) — *"run `specwitness doctor` to resolve or
  provision Playwright"*. `doctor` deliberately never downloads
  (`src/cli/doctor/effects.ts:81-82`, and AD-12 requires it to do no network I/O), so this
  HINT sends the operator to a command that cannot honour it.

An operator following both messages moves between two commands, neither of which provisions,
with no indication that the capability is simply absent.

### What is NOT wrong here

Worth stating, because the surrounding design is careful and should not be "fixed" by
accident:

- **Refusing to skip is correct.** The module header is emphatic — an unavailable browser
  environment is `InfraError` (exit 3) or criterion `error`, **never** `skipped`, because
  Epic 4's retrospective recorded twice that a criterion nobody could adjudicate reported
  PASS. The run stopping is the right behaviour.
- **Exit 3 rather than 1 is correct.** A missing browser says nothing about the branch.
- **`doctor` not downloading is correct**, and is required by AD-12.

The defect is only that the provisioning step those decisions assume exists is not wired in.

### Suggested fix

1. **Call `provisionPlaywright` from the browser executor** when resolution finds nothing and
   the operator has not opted out — the behaviour `doctor`'s own message already describes.
   Provisioning spawns `npm` and Playwright's `cli.js` as SpecWitness's own hard-coded argv
   invocations, which the module header already justifies against AD-3, so no new boundary
   question is opened.
2. **Failing that, make the messages true.** If provisioning is to stay manual, `doctor` must
   stop saying it happens on the first browser probe, and `verify`'s HINT must name the
   command that actually provisions rather than pointing at `doctor`.

Option 2 without option 1 leaves the product unable to run a browser probe on a monorepo
without a manual step nothing documents. Option 1 is what every message in the codebase
already claims.

### Note for the corpus

No fixture covers this: the corpus fixtures ship pre-compiled plans and none of them carries
a browser probe against an unprovisioned environment. A fixture that pins "an unprovisioned
browser probe is exit 3, not PASS" would have caught the *classification* — but not this,
since the classification is already right. What went unpinned is that provisioning is
reachable at all.
