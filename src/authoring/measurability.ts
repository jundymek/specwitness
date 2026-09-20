/**
 * Criterion shapes that make a verdict meaningless, refused at freeze time.
 *
 * WHY THIS EXISTS, and it is a dogfooding finding rather than a requirement.
 * Four epics of the tenstandard project produced, between them, ONE product
 * defect the gate caught (`E5-07`, a 400 where the contract required 422) and
 * ELEVEN criteria that were red or green for reasons having nothing to do with
 * the product. The eleven are the problem this module addresses, because a
 * gate whose reds are mostly noise is a gate nobody reads, and a gate with a
 * green that cannot fail is worse than no gate at all.
 *
 * THE THREE SHAPES, each with its real incident:
 *
 *  - **A criterion that names a test idiom.** `E5-24`, `E5-27` and `E5-41`
 *    required the literal `assertNumQueries`; the project used pytest-django's
 *    `django_assert_num_queries` fixture. The query ceilings existed and were
 *    correct. Three criteria went red because a probe grepped for one spelling
 *    of a thing that has two. A criterion is about what the system DOES, never
 *    about the vocabulary a test uses to check it.
 *
 *  - **A negative claim with no positive partner.** `E4-51` — "a malformed
 *    file writes nothing at all" — passed while observing a refusal at
 *    ARGUMENT PARSING. The epic-4 retrospective's own words: "it would have
 *    passed against a build whose validator did nothing at all." Every
 *    absence-claim is true of a system that does nothing, so it must also
 *    assert the presence that makes the absence mean something.
 *
 *  - **A criterion whose own clauses contradict.** `E5-37` wanted a `count`
 *    under `?ordering=state` while also requiring non-allowlisted ordering
 *    values to return 400. No implementation satisfies both. It was frozen,
 *    and it stayed red through an entire epic because — correctly — the
 *    contract was never unfrozen to make it pass.
 *
 * WHY REFUSE, WHERE `coupling.ts` ONLY FLAGS. That module flags because the
 * difference between "a structural criterion legitimately names a module" and
 * "a behavioral statement leaked an implementation detail" is INTENT, and no
 * heuristic reads intent. These three shapes are different in kind: a
 * criterion that names a test idiom is wrong whatever the author intended, and
 * a self-contradicting one cannot be satisfied by any build. Flagging them
 * would be advice an operator is free to ignore at the exact moment the cost
 * of ignoring it becomes permanent — a frozen contract is, by ADR-005, not
 * editable afterwards except by amendment.
 *
 * WHAT IS DELIBERATELY NOT HERE. Whether a probe CAN go red — the falsification
 * question — is not decidable by reading a contract, because it depends on the
 * observation scripts and the build. That needs a mutation run, and it is not
 * this module. This one reads statements and nothing else.
 *
 * THE ESCAPE HATCH IS THE POINT OF THE DESIGN. Every refusal names the
 * criterion, quotes the text that triggered it, and says what to write
 * instead. A false positive costs one edit to a DRAFT, which is cheap and
 * reversible; the alternative — a frozen criterion that can never be satisfied
 * — costs an epic. That asymmetry runs the opposite way to `coupling.ts`'s,
 * which is why the two modules make opposite choices from the same evidence.
 *
 * Pure and dependency-free: no I/O, no clock. AD-1 — application layer, and it
 * happens to need nothing at all.
 */

/** Which unmeasurable shape a finding names. */
export type MeasurabilityKind =
  | 'test-idiom'
  | 'unpartnered-negative'
  | 'self-contradiction';

/** One reason a criterion cannot produce a meaningful verdict. */
export interface MeasurabilityFinding {
  readonly kind: MeasurabilityKind;
  /** The exact text that triggered it, so the author can find it. */
  readonly match: string;
  /** What to write instead. Imperative, specific, never "consider rewording". */
  readonly remedy: string;
}

/** A criterion carrying at least one finding. */
export interface UnmeasurableCriterion {
  readonly id: string;
  readonly findings: readonly MeasurabilityFinding[];
}

/** The minimum a criterion must expose to be analysed. */
export interface MeasurableCriterion {
  readonly id: string;
  readonly statement: string;
}

/**
 * Test-framework vocabulary.
 *
 * Each of these names a way of CHECKING rather than a property of the system.
 * The list is intentionally short and literal: it catches the incident class
 * that actually occurred, and a longer speculative list would start refusing
 * criteria about, say, an "assertion" the product itself makes to a user.
 *
 * `assertNumQueries` is first because it is the one that cost three criteria.
 */
const TEST_IDIOMS: readonly RegExp[] = [
  /\bassert[A-Z]\w*/g,
  /\bdjango_assert_\w+/g,
  /\bpytest\.\w+/g,
  /\b(?:it|describe|expect)\(\s*['"]/g,
  /\b\w*[Ss]pec\.(?:ts|js|py)\b/g,
  /\bunittest\b/g,
  /\bto(?:Equal|Be|Match|Throw|Contain)\b/g,
];

/**
 * Absence words: the claim "X does not happen / is not present".
 *
 * Matching these is the cheap half. The expensive half — deciding whether the
 * same sentence ALSO asserts a presence — is `assertsPresence` below, and it
 * is what keeps this from flagging every well-formed negative criterion.
 */
const NEGATIVE_MARKERS: readonly RegExp[] = [
  /\b(?:never|no|none|not|nothing|neither|nor|without|cannot|refuses?|rejects?|absent|omits?|withholds?|excludes?)\b/gi,
  /\bzero\b/gi,
];

/**
 * Presence words: the partner that makes a negative falsifiable.
 *
 * A criterion saying "the published case renders its title AND the unpublished
 * one does not" contains both, and is exactly the shape that survives a build
 * which does nothing — because the first half fails there.
 *
 * **AN OPEN VERB LIST WAS THE WRONG DESIGN AND WAS REPLACED.** The first draft
 * enumerated presence verbs — renders, returns, exposes — and then reported 22
 * of the tenstandard epic-6 contract's 91 criteria, three quarters of them
 * wrong: it had no `resolve`, no `runs`, no `moves`, no `surfaces`. Lengthening
 * the list would have been chasing English, and the next contract would have
 * found the next missing verb. **Any verb outside the negated clause is a
 * presence claim**, so what remains is to recognise a clause that is not
 * negated, which is `assertsPresence` below.
 *
 * What stays here is only the evidence that does NOT depend on a verb: the
 * contrastive conjunctions, and concrete expected values — "returns 404",
 * "exactly one h1" — which assert presence by themselves.
 */
const PRESENCE_MARKERS: readonly RegExp[] = [
  /\bwhile\b|\bwhereas\b|\balthough\b/gi,
  // A concrete expected value is a presence claim by itself: "returns 404",
  // "exactly one h1", "a 401 whose bodies are byte-identical".
  /\b(?:equals?|exactly)\b/gi,
  /\b[1-5][0-9]{2}\b/g,
];

/**
 * Words that carry no claim of their own.
 *
 * `assertsPresence` treats any surviving verb-like word as a presence, so the
 * words that are merely scaffolding must not count. Without this, "A malformed
 * candidate FILE writes nothing" would pass on the word `file`, and the check
 * would be back to accepting `E4-51`.
 */
const STRUCTURAL_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to', 'for',
  'by', 'with', 'from', 'as', 'that', 'which', 'this', 'these', 'those', 'it',
  'its', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'any', 'all',
  'each', 'every', 'both', 'either', 'other', 'same', 'own', 'only', 'also',
  'than', 'then', 'so', 'such', 'their', 'there', 'when', 'where', 'while',
  'whose', 'what', 'one', 'two', 'three', 'four', 'five', 'six', 'more',
  'most', 'less', 'least', 'must', 'may', 'can', 'will', 'would', 'should',
  'shall', 'does', 'do', 'did', 'has', 'have', 'had', 'file', 'files', 'page',
  'pages', 'case', 'cases', 'source', 'sources', 'code', 'test', 'tests',
  'story', 'epic', 'contract', 'criterion', 'criteria', 'itself', 'them',
  'per', 'into', 'over', 'under', 'after', 'before', 'between', 'through',
  'without', 'beyond', 'across', 'about', 'against',
]);

/**
 * Presence words that the negation itself consumed.
 *
 * Found by the tests, not by reading: "a malformed file WRITES NOTHING at all"
 * matched `writes?` and so counted as its own positive partner, and the
 * detector silently stopped detecting the very incident it was built for
 * (`E4-51`). The verb is governed by the negative — it is the thing that does
 * not happen — so it cannot also be the thing that must happen.
 *
 * Stripping these spans before looking for a presence is what keeps the check
 * honest. The window is deliberately short: "nothing at all is written" needs
 * to reach backwards too, so both orders are covered.
 */
const NEGATED_VERB_SPANS: readonly RegExp[] = [
  // The verb BEFORE the negation: "writes nothing", "exposes no field".
  // This order is the one that mattered — the first draft only stripped
  // forwards, left "writes" standing, and let E4-51 through.
  /\b\w+\b(?=\s+(?:nothing|none|no\b|neither|nor)\b)/gi,
  // The verb AFTER it: "never renders", "does not return", "without exposing".
  /\b(?:never|not|no|none|nothing|neither|nor|without|cannot)\b\s+(?:\w+\s+){0,2}\w+/gi,
];

/** The statement with the clauses the negation governs removed. */
function stripNegatedClauses(statement: string): string {
  let stripped = statement;
  for (const pattern of NEGATED_VERB_SPANS) {
    stripped = stripped.replace(new RegExp(pattern.source, pattern.flags), ' ');
  }
  return stripped;
}

/**
 * Phrases that pair a claim with its own falsifier.
 *
 * A criterion built this way is doing the right thing on purpose, and it often
 * contains many negative words while doing it. Recognising the construction
 * avoids the most annoying class of false positive.
 */
const EXPLICIT_PAIRING: readonly RegExp[] = [
  /\bwhile\b[^.]*\b(?:not|never|no|none|nothing)\b/i,
  /\bboth\b[^.]*\band\b/i,
  /\band\s+(?:the\s+)?same\b/i,
  /\brather than\b/i,
];

/**
 * Contradiction pairs: two requirements that cannot hold at once.
 *
 * Deliberately TINY. Detecting general logical inconsistency in prose is not
 * possible, and pretending otherwise would produce confident nonsense. This
 * catches the narrow, recurring shape where one sentence demands a successful
 * result for an input another sentence demands be refused — which is `E5-37`
 * exactly.
 *
 * Each entry names a status-or-outcome pair that cannot both apply to one
 * input, plus the word that must be present for the pair to be about the same
 * thing.
 */
const CONTRADICTION_PAIRS: readonly {
  readonly a: RegExp;
  readonly b: RegExp;
  readonly about: RegExp;
  readonly describe: string;
}[] = [
  {
    a: /\b(?:returns?|responds?|answers?)\s+(?:a\s+)?400\b/i,
    b: /\b(?:returns?|responds?|answers?|yields?)\s+(?:a\s+)?(?:200|success|count)\b/i,
    about: /\bordering|sort|filter|parameter|query\b/i,
    describe: 'requires both a 400 refusal and a successful result for the same parameter',
  },
  {
    a: /\brefuses?\b|\brejects?\b/i,
    b: /\baccepts?\b|\bpermits?\b|\ballows?\b/i,
    about: /\bsame\b/i,
    describe: 'requires the same input to be both refused and accepted',
  },
];

function matchesAny(statement: string, patterns: readonly RegExp[]): string | undefined {
  for (const pattern of patterns) {
    // A fresh RegExp per call: a module-level /g regex carries `lastIndex`
    // between calls, so sharing one would make results depend on call order.
    const scanner = new RegExp(pattern.source, pattern.flags);
    const match = scanner.exec(statement);
    if (match !== null) {
      return match[0];
    }
  }
  return undefined;
}

/** Whether the statement also claims something is present. */
function assertsPresence(statement: string): boolean {
  if (EXPLICIT_PAIRING.some((pattern) => pattern.test(statement))) {
    return true;
  }

  // The presence must survive OUTSIDE the negated clause; see
  // NEGATED_VERB_SPANS for the incident that made this necessary.
  const remainder = stripNegatedClauses(statement);

  if (matchesAny(remainder, PRESENCE_MARKERS) !== undefined) {
    return true;
  }

  // Any content word left standing outside the negation is a claim about what
  // the system does. Counted rather than enumerated: see PRESENCE_MARKERS for
  // why an open verb list was the wrong design.
  const contentWords = remainder
    .toLowerCase()
    .split(/[^a-z-]+/)
    .filter((word) => word.length > 2 && !STRUCTURAL_WORDS.has(word));

  // THREE. Calibrated against the real contracts of tenstandard epics 4, 5 and
  // 6 rather than guessed: "A malformed candidate file writes nothing at all"
  // (`E4-51`, the false green this module exists for) leaves one word, while
  // every correctly paired criterion in epic 6 leaves five or more. A pure
  // absence-claim leaves only fragments of its own subject; a clause that says
  // what must happen leaves a subject, a verb and an object.
  return contentWords.length >= 3;
}

/**
 * Finds shapes that would make this criterion's verdict meaningless.
 *
 * Returns findings in kind order, at most one per kind, so a statement with
 * three test idioms reports one actionable finding rather than three copies of
 * the same advice. Never throws, never mutates its argument, and returns `[]`
 * for an empty statement — an analyser that could fail would become a gate by
 * accident.
 */
export function findMeasurabilityFindings(
  statement: string,
): readonly MeasurabilityFinding[] {
  const findings: MeasurabilityFinding[] = [];

  const idiom = matchesAny(statement, TEST_IDIOMS);
  if (idiom !== undefined) {
    findings.push({
      kind: 'test-idiom',
      match: idiom,
      remedy:
        'state the behaviour the test checks, not the vocabulary it uses: a probe grepping one spelling goes red on a project that spells it another way, while the behaviour is correct',
    });
  }

  const negative = matchesAny(statement, NEGATIVE_MARKERS);
  if (negative !== undefined && !assertsPresence(statement)) {
    findings.push({
      kind: 'unpartnered-negative',
      match: negative,
      remedy:
        'add the presence that makes the absence meaningful — an absence-claim is true of a system that does nothing, so assert what must be there alongside what must not',
    });
  }

  for (const pair of CONTRADICTION_PAIRS) {
    if (pair.a.test(statement) && pair.b.test(statement) && pair.about.test(statement)) {
      findings.push({
        kind: 'self-contradiction',
        match: pair.describe,
        remedy:
          'split it into two criteria, one per input — a criterion no implementation can satisfy stays red for the life of the epic and teaches nothing',
      });
      break;
    }
  }

  return findings;
}

/**
 * Analyses a whole contract's criteria.
 *
 * Returns only the criteria carrying findings, in input order, so the caller
 * can report `[]` as "nothing to refuse" without filtering again.
 */
export function findUnmeasurableCriteria(
  criteria: readonly MeasurableCriterion[],
): readonly UnmeasurableCriterion[] {
  const flagged: UnmeasurableCriterion[] = [];

  for (const criterion of criteria) {
    const findings = findMeasurabilityFindings(criterion.statement);
    if (findings.length > 0) {
      flagged.push({ id: criterion.id, findings });
    }
  }

  return flagged;
}
