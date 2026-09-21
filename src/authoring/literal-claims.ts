/**
 * Literals a compiled plan asserts about the tree it was compiled from.
 *
 * WHY THIS EXISTS. `plan-author` invents strings. Epic 5 of the tenstandard
 * dogfooding project froze three clean behavioural criteria —
 *
 *   E5-41  "The public entities endpoint has a pinned database-query ceiling
 *           that does not grow with the number of returned entities."
 *
 * — and the compiler turned them into `file` probes asserting that a test
 * module contains the literal `assertNumQueries`. That identifier occurs
 * NOWHERE in that repository: the project uses pytest-django's
 * `django_assert_num_queries` fixture. Three criteria went red against a
 * correct implementation, the epic's retrospective recorded them as "probe
 * artefacts", and the operator's conclusion was that the gate is "not yet
 * worth trusting unread". The contract was blameless; the plan was not.
 *
 * THE ASYMMETRY THAT MAKES THIS WORTH CHECKING. A contract is reviewed by a
 * human and frozen — every criterion is read before a fingerprint exists. A
 * plan is generated AFTER that freeze, it is large (epic 5's carries 383
 * `expected:` literals), and until now nothing compared a single one of them
 * against the tree. The one artefact nobody reads is the one that decides
 * what red means.
 *
 * WHAT IS CHECKABLE, AND ONLY THIS. A `file` probe whose assertion says
 * `comparison: contains` with a literal `expected` is a claim that a string
 * occurs in a named file, in the tree the plan was compiled from. That is
 * decidable, now, without running anything. Nothing else here is: a `contains`
 * over an HTTP body is about a response that does not exist yet, and
 * `equals` over file content is a whole-file claim that a partial tree
 * legitimately fails.
 *
 * WARN, NEVER REFUSE — and the reason is not timidity. A plan is deliberately
 * compilable BEFORE the work exists: that is the entire point of freezing a
 * contract early, and `specwitness verify` is expected to go red on a tree
 * that has not implemented the epic yet. So an absent literal has two
 * readings, and they are genuinely indistinguishable from here:
 *
 *   1. the implementation does not exist yet — legitimate, and the probe is
 *      describing the future correctly;
 *   2. the compiler invented the string — the incident above.
 *
 * Only a reader can tell those apart, so this reports and stops. The value is
 * not in the verdict: it is that four invented literals would have been named
 * on screen, at compile time, instead of surfacing an epic later as three
 * inexplicable reds on working code.
 *
 * Pure: no I/O and no clock. The caller reads the files, because AD-1 keeps
 * the filesystem at the edge — and because a checker that could fail to read a
 * file would become a gate by accident.
 */

/** One literal a plan claims occurs in a file, with where the claim was made. */
export interface LiteralClaim {
  /** The probe's id, so a reader can find it in the plan. */
  readonly probeId: string;
  /** The criterion the probe was compiled for. */
  readonly criterionId: string;
  /** The file the claim is about, as the plan spells it. */
  readonly path: string;
  /** The string the plan says that file contains. */
  readonly literal: string;
}

/** A claim whose literal was not found in the file the plan named. */
export interface UnmetLiteralClaim extends LiteralClaim {
  /** `false` when the file itself was missing, which reads differently. */
  readonly fileExists: boolean;
}

/**
 * The shape this module needs from a compiled plan.
 *
 * Structural rather than importing `Plan`: it keeps the module honest about
 * using nothing else, and it lets the tests state a two-field probe instead of
 * building a whole valid plan to check one string.
 */
export interface PlanLike {
  readonly criteria: readonly PlanCriterionLike[];
}

/**
 * One compiled criterion, as loosely as this module can state it.
 *
 * `unknown` for `probes` rather than a structural probe type, and the narrowing
 * happens in `collectLiteralClaims` at run time. The real `ProbeSpec` is a
 * discriminated union over six surfaces whose `mechanics` have nothing in
 * common — an `ObservationProbe` carries a `commandId`, not a `path` — so a
 * structural type wide enough to accept the union is a type that asserts
 * nothing, and one narrow enough to be useful rejects the real plan. Reading
 * `surface` first, then the fields that surface implies, is what the surface
 * discriminator is for.
 */
interface PlanCriterionLike {
  readonly criterionId: string;
  readonly probes?: readonly unknown[];
}

/** The `file` probe fields this module reads, once `surface` has been checked. */
interface FileProbeLike {
  readonly id: string;
  readonly surface: string;
  readonly mechanics?: { readonly path?: string };
  readonly assertions?: readonly {
    readonly comparison: string;
    readonly expected: string;
    readonly target: { readonly source: string };
  }[];
}

/** Whether this probe is a `file` probe naming one path. */
function asFileProbe(probe: unknown): FileProbeLike | undefined {
  if (typeof probe !== 'object' || probe === null) {
    return undefined;
  }
  const candidate = probe as FileProbeLike;
  if (candidate.surface !== 'file' || typeof candidate.id !== 'string') {
    return undefined;
  }
  return candidate;
}

/**
 * Literals that carry no information, so finding them absent means nothing.
 *
 * A one-character `expected`, or a bare number, occurs in almost any file by
 * accident — and asserting one is a separate smell this module does not chase.
 * The point of the exclusion is the false-positive budget: every entry in the
 * report costs a reader a look, so a report that includes noise is a report
 * that gets skimmed.
 */
function isCheckableLiteral(literal: string): boolean {
  if (literal.trim().length < 3) {
    return false;
  }
  // A pure number is a status code, a count or a port. `contains: "200"` over
  // a file is unusual, and when it happens it is about digits that occur
  // everywhere; either way its absence is not evidence of invention.
  return !/^\d+$/.test(literal.trim());
}

/**
 * Every claim of the form "this file contains this literal" the plan makes.
 *
 * Restricted to the `file` surface with `target.source` of `content`, because
 * that is the only pairing whose truth is decidable against a tree without
 * executing anything. `occurrences` and `filesContaining` read a GLOB, and a
 * glob's members are a filesystem question the caller would have to answer —
 * left out deliberately rather than approximated.
 */
export function collectLiteralClaims(plan: PlanLike): readonly LiteralClaim[] {
  const claims: LiteralClaim[] = [];

  for (const criterion of plan.criteria) {
    for (const candidate of criterion.probes ?? []) {
      const probe = asFileProbe(candidate);
      if (probe === undefined) {
        continue;
      }

      const path = probe.mechanics?.path;
      if (path === undefined || path.length === 0) {
        continue;
      }

      for (const assertion of probe.assertions ?? []) {
        if (assertion.comparison !== 'contains' || assertion.target.source !== 'content') {
          continue;
        }
        if (!isCheckableLiteral(assertion.expected)) {
          continue;
        }

        claims.push({
          probeId: probe.id,
          criterionId: criterion.criterionId,
          path,
          literal: assertion.expected,
        });
      }
    }
  }

  return claims;
}

/** How the caller answers "what does this file contain?" for one path. */
export type ReadFileContents = (path: string) => string | undefined;

/**
 * The claims whose literal is not in the file the plan named.
 *
 * `read` returns `undefined` for a file that does not exist, which is reported
 * as `fileExists: false` rather than merged with a missing literal: "the file
 * is not there yet" and "the file is there and says something else" point a
 * reader at different things, and the second is the shape an invention takes.
 */
export function findUnmetLiteralClaims(
  claims: readonly LiteralClaim[],
  read: ReadFileContents,
): readonly UnmetLiteralClaim[] {
  const unmet: UnmetLiteralClaim[] = [];
  // One read per path, however many claims are made about it: epic 5's plan
  // makes several claims against the same test module.
  const cache = new Map<string, string | undefined>();

  for (const claim of claims) {
    if (!cache.has(claim.path)) {
      cache.set(claim.path, read(claim.path));
    }
    const contents = cache.get(claim.path);

    if (contents === undefined) {
      unmet.push({ ...claim, fileExists: false });
      continue;
    }

    if (!contents.includes(claim.literal)) {
      unmet.push({ ...claim, fileExists: true });
    }
  }

  return unmet;
}
