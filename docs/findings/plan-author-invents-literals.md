# The plan compiler invents literals the contract never named

**Found:** 2026-09-20, while building the freeze-time measurability check.
**Severity:** this is the product's own failure mode, one layer below where it
was being looked for.
**Status:** **fixed 2026-09-21** — `specwitness plan` now names every literal
claim that does not hold against the tree it compiled from. See "The fix, and
what it found" at the end.

## What happened

Epic 5 of the tenstandard dogfooding project closed at 38 pass / 6 fail. Five of
the six reds were written off as "probe artefacts", and three of those five —
`E5-24`, `E5-27`, `E5-41` — were recorded in the retrospective as criteria that
"grep for the literal `assertNumQueries`" while the project uses pytest-django's
`django_assert_num_queries` fixture.

**That attribution was wrong, and the truth is worse.** The criteria say nothing
of the kind. From the frozen contract:

> `E5-41` — The public entities endpoint has a pinned database-query ceiling
> that does not grow with the number of returned entities.
>
> `E5-24` — Editorial list and detail query counts are bounded and do not grow
> with the number of returned cases or their included related records.

Both are clean behavioural statements. Neither names a test framework, a
function, or a spelling. The contract author (codex) did its job.

The literal appears **four times in the compiled plan**
(`.specwitness/plans/epic-5.yaml`), for example:

```yaml
- id: pinned-counts
  surface: file
  mechanics:
    path: backend/tests/cases/test_editorial_api.py
  assertions:
    - description: the query count is pinned by an explicit ceiling, not reasoned about
      target: { source: content }
      comparison: contains
      expected: assertNumQueries
```

So `plan-author` received "a pinned query ceiling that does not grow" and
invented a specific Python identifier that **does not occur anywhere in the
target repository**. It then asserted the file contains it.

## Why this matters more than the criteria it was blamed on

SpecWitness exists to catch agents that hallucinate. Here the hallucination is
the product's own, in the one artefact nothing reviews:

- **The contract is reviewed and frozen.** A human reads every criterion before
  the fingerprint exists.
- **The plan is not.** It is generated after the freeze, it is large, and no
  step checks that a literal it asserts on actually exists.
- **The failure presents as a product defect.** Three red criteria on a correct
  implementation. The operator's rational response is to distrust the gate,
  which is exactly what happened: the epic-5 retrospective concludes the gate is
  "not yet worth trusting unread".

The same shape produced epic 4's `E4-51`, which passed while observing a refusal
at argument parsing — a probe that measured something other than what the
criterion said, and in that case failed *open*.

## The narrow, checkable rule

A `file` surface assertion with `comparison: contains` and a literal `expected`
is a claim that a string occurs in a named file. **That is verifiable at compile
time, against the repository the plan was compiled from.** If the literal is
absent when the plan is written, one of two things is true, and both are worth
stopping for:

1. the implementation does not exist yet — legitimate for a gate compiled before
   the work, and the probe should say so rather than assert a spelling; or
2. the compiler invented the string, which is this finding.

Distinguishing them is the operator's job; **surfacing them is the tool's.** A
warning at `plan` time naming every literal that does not occur in its target
file would have caught all four occurrences here, before the gate ran, at the
moment the cost was one edit.

## Scope notes

- This is **not** the freeze-time measurability check added in
  `src/authoring/measurability.ts`. That check reads criterion statements and
  would not have caught this: the statements were correct. Run against the
  frozen contracts of tenstandard epics 4, 5 and 6 it refuses none of them,
  which is the right answer and is why this document exists separately.
- `plan-author` has been pinned to `claude` since epic 3, because the codex
  adapter fails every plan-author invocation on codex-cli 0.154.0
  (`src/providers/codex-cli.ts`, still one commit, still 0.1.0). Whether the
  other provider invents fewer literals is unknown and untested.
- The prompt already says "a guessed probe" is worse than recording the
  criterion as `needs-human` (`src/authoring/plan-prompt.ts`). It is an
  instruction with no verification behind it, which is the general shape of
  every defence this product exists to replace.

## When this has to be fixed

**Before the epic-6 plan is compiled**, and that is a real date rather than a
preference.

A plan is compiled on the way to `verify`, not at freeze time:
`.specwitness/plans/epic-6.yaml` did not exist when this was found, and will not
until tenstandard's epic 6 closes both its waves. So nothing is burning — the
running agents cannot be harmed by a plan that has not been written.

The consequence of missing the window is precise and already known, because it
has happened: the compiler invents literals, three criteria go red on a correct
implementation, and the operator spends a retrospective deciding whether to
believe the gate. Epic 5 paid that cost once and concluded the gate was "not yet
worth trusting unread". Paying it twice, with the diagnosis already written
down, would be the expensive kind of deferral.

**The fix stays narrow.** A `file` surface assertion with `comparison: contains`
and a literal `expected` is checkable against the repository the plan was
compiled from. Warn — do not refuse — naming every literal that does not occur
in its target file, because "the implementation does not exist yet" is a
legitimate answer for a gate compiled before the work, and only the operator can
tell that apart from an invention.

**What to measure afterwards.** Epic 5's plan carries 383 `expected:` literals.
Counting how many of them occur in their target files, before and after, is the
honest test of whether the warning earns its place — and it is a number, not an
impression.

## The fix, and what it found

`src/authoring/literal-claims.ts` collects every claim of the form "this file
contains this literal" — `file` surface, `target.source: content`,
`comparison: contains`, a literal worth checking — and `specwitness plan`
reports the ones that do not hold, to stderr, after the plan is written.

**A warning, not a refusal, and the exit code is untouched.** A plan is
deliberately compilable before the work exists; "this literal is not in the
tree" therefore has two honest readings, and only a reader can separate them.
Refusing would block the legitimate case, which is the common one early in an
epic.

**Measured on the real plans**, which is the test that mattered:

| Plan | Checkable claims | Not holding |
| --- | --- | --- |
| epic-3 | 21 | 0 |
| epic-4 | 30 | 0 |
| epic-5 | 157 | **4** |

```
E5-24  pinned-counts  "assertNumQueries"  — not in backend/tests/cases/test_editorial_api.py
E5-27  pinned-count   "assertNumQueries"  — not in backend/tests/cases/test_metrics.py
E5-37  allowlist      "ordering_fields"   — not in backend/apps/cases/public_views.py
E5-41  pinned-count   "assertNumQueries"  — not in backend/tests/cases/test_public_entities.py
```

Three are the incident this document was opened for. **The fourth was not
known**: `E5-37` — already recorded as self-contradictory — also asserts
`ordering_fields`, a DRF attribute that module does not use; its allowlist is a
module-level map called `ORDERING_FIELDS`. So that criterion had two
independent defects, and only one of them had been found by reading.

Zero false positives across 208 checked claims in three plans. The detector was
also shown to go quiet: given a file that really contains the literal it
reports nothing, which is the both-directions rule this project holds its own
observations to.

**What is deliberately still unchecked:** globs (`occurrences`,
`filesContaining`), whose members are a filesystem question; `equals` over file
content, a whole-file claim a partial tree legitimately fails; and every
non-file surface, whose truth is about a system that is not running yet.
