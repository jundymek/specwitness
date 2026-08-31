/**
 * Implementation-coupling hints for criterion statements (FR-7).
 *
 * FR-7 offers two branches for a statement that references internal
 * implementation: "rejected by schema-level lint **or** flagged for review".
 * **This module takes the FLAG branch, deliberately**, and epics.md story 2.6
 * AC1 spells out the same choice: such statements are "flagged in command
 * output for review".
 *
 * WHY FLAG AND NOT REJECT. A `structural` criterion may legitimately name a
 * module — "exit codes are defined in exactly one module" is a real, verifiable
 * architectural invariant, and this codebase enforces one just like it. A
 * heuristic cannot tell that apart from a behavioral statement that leaked an
 * implementation detail, and no heuristic ever will: the difference is intent.
 * Rejecting would block correct contracts; flagging costs a reviewer one
 * glance. So the human decides, which is the whole point of the review pass
 * this output feeds.
 *
 * CONSEQUENCES, all load-bearing:
 *
 *  - A hint NEVER fails the command and NEVER changes an exit code.
 *  - A hint is NEVER a schema rejection — story 2.2's schema accepts a
 *    criterion naming a function, by design.
 *  - Nothing here edits a statement. SpecWitness does not rewrite a human's
 *    expectation, and it does not rewrite a provider's draft either; it reports
 *    what it noticed and stops.
 *  - False positives are ACCEPTABLE and one is documented in the tests. Under a
 *    flag-only policy the cost of a false positive is one glance; under a
 *    reject policy it would be a blocked contract. That asymmetry is why the
 *    patterns below are allowed to be generous.
 *
 * Pure and dependency-free: no I/O, no clock, no imports. AD-1 — this is the
 * application layer and it may not import `src/cli/**`; it happens to need
 * nothing at all.
 */

/** What kind of implementation coupling a hint noticed. */
export type CouplingKind = 'function-call' | 'class-reference' | 'method-call' | 'file-path';

/** One noticed reference. Carries NO verdict — it is advice, not a result. */
export interface CouplingHint {
  readonly kind: CouplingKind;
  /** The exact text that matched, so a reviewer can find it in the statement. */
  readonly match: string;
}

/** A criterion carrying at least one hint, for the command's review output. */
export interface FlaggedCriterion {
  readonly id: string;
  readonly hints: readonly CouplingHint[];
}

/** The minimum a criterion must expose to be flagged. */
export interface FlaggableCriterion {
  readonly id: string;
  readonly statement: string;
}

/**
 * The patterns, in the order their hints are reported.
 *
 * Each requires punctuation that prose does not ordinarily supply — a call's
 * parentheses, the `class` keyword, a slashed path with an extension — because
 * the alternative is flagging every sentence containing a full stop. `e.g.`
 * and "exit code is 0. The report" must stay clean, and there is a test for
 * each.
 */
const PATTERNS: readonly { readonly kind: CouplingKind; readonly pattern: RegExp }[] = [
  // `class Foo` — checked before the call patterns so `class Foo(` reports the
  // more specific finding rather than a bare method call.
  { kind: 'class-reference', pattern: /\bclass\s+[A-Z]\w*/g },
  // `store.createRun(` — a receiver and a call. The dot plus parenthesis is
  // what separates this from an abbreviation or a sentence boundary.
  { kind: 'method-call', pattern: /\b\w+\.\w+\(/g },
  // `verify()` — an empty argument list is the unambiguous shape. A call WITH
  // arguments is left to the method-call pattern above or to the reviewer:
  // matching `\w+\(` alone would flag ordinary parenthetical prose.
  { kind: 'function-call', pattern: /\b\w+\(\)/g },
  // `src/cli/exit.ts`, `report.csv` — a file extension, optionally preceded by
  // directory segments. Generous on purpose; see the module header.
  { kind: 'file-path', pattern: /\b[\w.-]+(?:\/[\w.-]+)*\.[a-z]{2,4}\b/g },
];

/**
 * Finds implementation-coupling references in one statement.
 *
 * Returns findings in pattern order, de-duplicated by (kind, match) so a
 * statement repeating the same call is reported once. Never throws, never
 * mutates its argument, and returns `[]` for an empty statement — a flagger
 * that could fail would become a gate by accident.
 */
export function findCouplingHints(statement: string): readonly CouplingHint[] {
  const hints: CouplingHint[] = [];
  const seen = new Set<string>();
  // Track spans already claimed by an earlier, more specific pattern so
  // `store.createRun(` is not also reported as a file path.
  const claimed: { start: number; end: number }[] = [];

  for (const { kind, pattern } of PATTERNS) {
    // A fresh RegExp per call: a module-level /g regex carries `lastIndex`
    // between calls, so sharing one would make results depend on call order.
    const scanner = new RegExp(pattern.source, pattern.flags);

    for (const match of statement.matchAll(scanner)) {
      const start = match.index;
      const text = match[0];
      if (start === undefined) {
        continue;
      }

      const end = start + text.length;
      if (claimed.some((span) => start < span.end && end > span.start)) {
        continue;
      }

      const key = `${kind}:${text}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      claimed.push({ start, end });
      hints.push({ kind, match: text });
    }
  }

  return hints;
}

/**
 * Selects the criteria a reviewer should look at.
 *
 * Order follows the criteria as given, which is contract order, so the output
 * reads down the file rather than in discovery order. Criteria with no hints
 * are omitted entirely: an empty result means "nothing to review", never
 * "nothing was checked".
 */
export function flagCoupledCriteria(
  criteria: readonly FlaggableCriterion[],
): readonly FlaggedCriterion[] {
  const flagged: FlaggedCriterion[] = [];

  for (const criterion of criteria) {
    const hints = findCouplingHints(criterion.statement);
    if (hints.length > 0) {
      flagged.push({ id: criterion.id, hints });
    }
  }

  return flagged;
}
