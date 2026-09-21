# One response for a whole contract does not scale

**Found:** 2026-09-21, compiling the plan for tenstandard's epic 6.
**Partly fixed:** `08687b9` makes the time bound follow the work.
**Still open:** batching, which is the actual remedy.

## What happened

`specwitness plan 6` failed three times. Each attempt spent roughly twenty
minutes and then died on `DEFAULT_INVOCATION_TIMEOUT_MS` (900 000 ms), which is
not a recoverable failure: the retry budget went on re-hitting the same wall,
so the run could not finish at all.

The contract has **91 criteria**. The constant was calibrated against 40 — and
the comment above it says, in as many words, that it was itself raised from five
minutes to fifteen because "on a real 40-criterion contract the five-minute
bound fired before the model had finished, three attempts running, and the retry
budget was spent re-hitting the same wall rather than recovering from anything."

So the same defect was recorded, fixed by a bigger constant, and then recurred
one scale up. That is the argument against fixing it with a constant again.

## What is fixed

A request may declare `workUnits` — a hint about size, never about content, and
adapters may ignore it. `compilePlan` sets it to the criterion count; the claude
adapter adds 12 s per unit to the configured base and clamps at one hour. Epic
6's bound becomes ~33 minutes instead of 15.

That unblocks contracts of this size. It does not address the shape of the
problem.

## What is still wrong

**A plan is compiled as ONE response covering every criterion.** Three
consequences, none of which a larger bound removes:

1. **Cost is unbounded in the contract's size.** Every criterion's probes,
   assertions and reviewer guidance must be held and emitted in a single
   completion. A contract twice this size needs a bound twice as large, and the
   ceiling that keeps "bounded" honest eventually collides with it.
2. **A failure costs everything.** Twenty minutes of correct work for eighty
   criteria is discarded because the eighty-first did not arrive. Nothing is
   partial, so nothing is salvageable.
3. **The retry budget cannot help.** Retrying an attempt that failed for a
   size reason reproduces the size, which is why three attempts achieved
   nothing here.

## The remedy

**Compile in batches**: N criteria per invocation, assembled into one plan.

- Each batch is bounded in the same way whatever the contract's total size, so
  the ceiling stops being reachable by growth.
- A failed batch is retried alone. The other batches' work survives, which is
  what makes the retry budget meaningful for the first time.
- Progress becomes reportable — "batch 3 of 6" — where today an operator can
  only watch a process and guess.

**What has to stay true, and it is the part worth care:** the plan is one
artifact validated against the frozen contract as a whole. Batching must not let
a criterion be silently dropped between batches, must not let two batches
disagree about a shared declared id, and must keep `needs-human` dispositions
exactly as they are. The assembly step already validates the draft against
`planDraftSchemaFor(contract, declared)`; batching has to feed that same
validator a union, and the union has to be checked for completeness against the
contract's criterion list — one missing id is a silently narrower gate, which is
the failure this product exists to prevent.

A reasonable batch size is 15–20 criteria: large enough that the per-call
overhead is amortised, small enough that a batch is a few minutes rather than
twenty.
