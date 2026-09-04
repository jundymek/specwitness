# ADR-008: Strictness of persisted envelopes vs additive schema evolution

- **Status:** Accepted
- **Date:** 2026-09-04
- **Supersedes:** nothing. **Answers:** action item **e5-D** (Epic 5 retrospective §5, §7).
- **Binding on:** every key in `src/schemas/versions.ts`, and every persisted artifact added after this date — including story 6.5's `.specwitness/scorecard.jsonl`.

## Context

`src/schemas/versions.ts` states the rule the whole project has followed since story 1.2:

> Versions are integers and evolve ADDITIVELY: bump a number when a shape changes, add a key when a new artifact appears. Never renumber and never remove — a stored run from last week must stay readable.

That rule is honoured in one direction and broken in the other, and Epic 5's retrospective found the break:

- **Forwards (old document, new reader) — works.** Every field added since Epic 3 is optional, so a `result.json` written before story 5.3 still parses today. Asserted by `tests/unit/schemas/result-explanation.test.ts` and by the precedent commit `ec23ce1`.
- **Backwards (new document, old reader) — fails, and fails with the wrong word.** Every persisted schema is `.strict()` / `z.strictObject` at every level. When a newer SpecWitness adds an optional key — exactly the additive evolution the registry prescribes — an older build reading that document rejects it as **malformed**, while `schemaVersion` still reads `1` and truthfully says the shape is unchanged. The reader reports a corrupt file when what it actually met was a newer writer.

`src/schemas/manifest.ts:101` already anticipates this in a comment — *"`.strict()` on purpose: an unknown key means a newer writer added something"* — but the diagnosis never reaches the operator, who sees a validation failure naming an unexpected key.

Four registry keys persist to disk and are affected: **`runManifest`**, **`jsonReport`**, **`contract`**, **`plan`**. (`resultTaxonomy`, `epicSpec`, `explanation` and `adaptation` are versioned seams that nothing writes to disk; `adaptation` is additionally a *provider input* boundary, which this ADR deliberately does not touch — see Decision 4.)

The decision became urgent because story 6.5 mints a **new** persisted format, `.specwitness/scorecard.jsonl`, whose whole purpose is to accumulate across many runs and many SpecWitness versions during the ~30–50-task dogfooding window. A scorecard that a slightly older build calls malformed is a scorecard that loses the north-star metric.

## Decision

**1. Strictness stays. The diagnosis changes.**

Persisted schemas remain `.strict()`. Strictness is what catches a typo'd key, a hand-edit and a half-written document, and it is what makes `contract.ts`'s comment true — *"an unknown key in a frozen contract is not a curiosity"*. We do not relax it.

What changes is that **an unknown key is diagnosed as a version skew, not as corruption.** A persisted-artifact reader that fails validation solely because of unrecognised keys must report:

```
ERROR: this <artifact> was written by a newer SpecWitness than the one reading it
HINT:  unknown field(s): <names>. Upgrade specwitness, or read this run with the version that wrote it.
```

and must classify as **`InfraError` (exit 3)** — never as a product FAIL, and never as an `IntegrityError`, which means tampering and must keep meaning only that.

**2. The reader distinguishes "unknown key" from "wrong shape" before it speaks.**

Any other validation failure — a missing required field, a wrong type, an out-of-range enum — stays what it is today: a malformed document. Only the case where *every* error is an unrecognised-key error earns the version-skew message. This is a property of the reader, not of the schema, so it costs nothing at write time and nothing in the fingerprint.

**3. `schemaVersion` keeps its current meaning, and adding an optional key does not bump it.**

The precedent established by `ec23ce1`, story 5.3, story 5.4 and story 5.5 is correct and stays: an added *optional* key is not a version change. Bump the integer only when an existing field changes meaning, type or requiredness. The version number answers *"can this reader interpret the fields it recognises?"*; the unknown-key path answers *"were there fields it did not?"*. Two different questions, two different mechanisms — conflating them is what produced the misleading error.

**4. `contract` is bound by this ADR for reading, and unchanged for fingerprinting.**

A contract's fingerprint covers `spec`, never `meta` (story 2.2's rule, restated in `versions.ts`). Nothing here alters that. An unknown key inside `spec` on a **frozen** contract remains an integrity concern, because the fingerprint will already have failed and that failure is the authoritative one; the version-skew message applies to a contract whose fingerprint *verifies* and whose envelope merely carries an unrecognised `meta` key.

**5. `.specwitness/scorecard.jsonl` (story 6.5) is born under this rule.**

Each line is an independently-parsed record carrying its own `schemaVersion`. A record whose only failure is unknown keys is **skipped with a warning naming the line number and the unknown fields, and the summary continues over the remaining records** — it does not abort the summary. This is the one place the rule is *softer* than for single-document artifacts, and deliberately: a scorecard is an append-only log accumulated across versions, a partially-readable log is still evidence, and refusing to summarise 200 good records because record 47 came from a newer build would destroy the very measurement the file exists for. A malformed line (any non-unknown-key error) is likewise skipped-with-warning rather than fatal, and `scorecard summary` reports the count of skipped records so a silently shrinking denominator is impossible.

## Consequences

- Four existing readers gain an unknown-key branch: the `runManifest`, `jsonReport`, `contract` and `plan` loaders. This is a **behaviour change to merged code owned by no Epic 6 story**, so it is scheduled explicitly rather than left to whoever notices: **story 6.3 owns the reader change for `jsonReport` and `runManifest`** (its classification fixtures are the only place these are read back adversarially) and **story 6.1's e2e runner asserts the message shape**. `contract` and `plan` readers are follow-up work, recorded as action item **e6-carryover** at the epic retrospective if not taken.
- `scorecard summary` gains a `skippedRecords` count in both its terminal and `--json` views. A summary that quietly drops records is worse than one that refuses.
- No fingerprint changes. No schema version bumps. No persisted document written before this date becomes unreadable.
- The rule is testable and must be tested both ways: a document with an unknown key produces the version-skew message and exit 3; a document with a genuinely wrong type still produces the malformed-document error. **A test that only asserts the first would let the second silently become the first**, which would hide real corruption behind a friendly upgrade hint.

## Alternatives considered

- **Relax to `.passthrough()` on persisted envelopes.** Rejected: it makes a typo'd key silently inert, and in `contract.spec` it would let content vary without the fingerprint or the schema noticing.
- **Bump `schemaVersion` on every added optional key.** Rejected: it contradicts four merged precedents, makes every additive change a coordinated multi-artifact edit, and still would not fix the message — an old reader would then reject on the version number instead of the key, which is more accurate but no more actionable.
- **A shared `assertSchemaVersion` helper.** Rejected for the reason `versions.ts` already gives: what a mismatch *means* is artifact-specific, and a shared helper freezes one answer for all of them.
