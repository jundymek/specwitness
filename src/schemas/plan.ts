/**
 * The compiled Verification Plan document (AD-5, AD-3, FR-16) — and THE security boundary
 * of Epic 4.
 *
 * `.specwitness/plans/<epic>.yaml` is the executable artifact: compiled once from a frozen
 * contract by the `plan-author` provider, committed to the target project's git (Q11), and
 * thereafter executed with zero provider calls (FR-18). This module owns four things and
 * nothing else:
 *
 *   - the strict, versioned zod schema for the two-key document;
 *   - the text <-> model conversion (`parsePlan` / `serializePlan`);
 *   - the CONTRACT-AWARE draft schema the AD-2 gate validates provider output against
 *     (`planDraftSchemaFor`);
 *   - the pure staleness refusal (`assertPlanMatchesContract`), which story 4.7 calls from
 *     the CLI edge.
 *
 * Everything here is PURE. No filesystem, no clock, no randomness, no subprocess:
 * `parsePlan` takes a string, and every instant arrives as an argument (AD-9). Reading and
 * writing the file is `src/authoring/plan-file.ts`; keeping that out of here is what makes
 * the whole schema exhaustively testable and stops a future story making it depend on the
 * environment. It mirrors `schemas/contract.ts` deliberately — same split, same reasons.
 *
 * ── WHY THIS FILE IS THE SECURITY BOUNDARY ─────────────────────────────────────────────
 *
 * This is the first epic in which AI output becomes an EXECUTABLE artifact. Until now a
 * provider drafted a contract: text a human reads, reviews and freezes, with a person in
 * the loop before it has any authority. From here a provider drafts a plan, and that plan
 * drives probes that spawn processes and issue requests.
 *
 * The defence is not that the provider is trustworthy, and it is not the prompt, and it is
 * not review. It is that **there is nowhere in this schema to put a command string**, so a
 * hostile or merely sloppy draft cannot express the attack:
 *
 *  1. `z.strictObject` AT EVERY LEVEL. A draft carrying `run: "rm -rf /"` fails as an
 *     unknown key naming its path. `src/config/schema.ts`'s header makes the same argument
 *     for the config: strictness is a security property, not a nicety.
 *  2. EXECUTABLES BY CONFIG ID, and the id fields are pattern-constrained to an id-shaped
 *     token — so a command line cannot be smuggled through `commandId` either.
 *  3. NO HOST AND NO ABSOLUTE URL ANYWHERE. An http or browser probe names a declared
 *     SERVICE plus a service-relative path; there is no field that could point a plan at
 *     production (AD-3, "no production URL defaults"). Protocol-relative paths (`//host/x`)
 *     are rejected for the same reason, since they resolve to another origin.
 *  4. HEADER VALUES CANNOT CARRY CR OR LF, so a drafted header cannot inject a second
 *     header or a second request.
 *  5. `z.array(assertion).min(1)` PER PROBE. An assertion-free probe is the quiet version
 *     of the same attack: it executes, observes nothing, and reaches the branch in
 *     `outcomeOf` (`domain/criterion-result.ts`) whose comment says a compiled plan always
 *     gives a probe at least one assertion, "so in practice this is unreachable; it is here
 *     so that the unreachable case is safe rather than merely lucky". This line is what
 *     makes that sentence true.
 *
 * WHAT THIS SCHEMA STRUCTURALLY CANNOT CATCH, stated plainly because an honest boundary is
 * worth more than an overclaim: a draft that asserts something TRIVIALLY TRUE. `expected:
 * "200"` versus `expected: "0"` are both well-formed; only a human reading the committed
 * plan, or the criterion later failing against a defective build, distinguishes a weak
 * expectation from a strong one. Plans are committed and reviewed (Q11) precisely because
 * this class of weakness has no mechanical detector.
 *
 * ── THE DRAFT/DOCUMENT SPLIT ───────────────────────────────────────────────────────────
 *
 * `PlanSchema` validates a persisted document. `planDraftSchemaFor(contract)` validates
 * what a PROVIDER returns, and it is built from the contract because the two rules that
 * matter most are contract-dependent:
 *
 *   - every contract criterion appears exactly once (nothing silently dropped — Q38);
 *   - a `verifiability: human` criterion is carried as needs-human and can never receive a
 *     probe (Q39, and `domain/contract.ts` is unconditional about it).
 *
 * Building them into the schema rather than checking afterwards is deliberate: the AD-2
 * gate feeds validation errors back into the next attempt's prompt (FR-14), so a draft that
 * dropped a criterion gets told so and retries, instead of failing a post-hoc assertion
 * with the budget already spent.
 *
 * NOTE the divergence from `src/authoring/contract.ts`'s `DRAFT_RESPONSE_SCHEMA`, which is
 * deliberately NOT strict so that a volunteered extra key costs no retry. A plan draft is
 * strict, because for a plan the extra key IS the attack.
 *
 * ── AD-1 ───────────────────────────────────────────────────────────────────────────────
 *
 * `src/schemas/**` is core: it imports `src/domain/**`, its own siblings, zod and yaml, and
 * nothing else. It does not hash — `schemas/canonical.ts` is the single hasher and
 * `.dependency-cruiser.cjs`'s `schemas-canonical-is-the-only-hasher` rule enforces it.
 */

import { parse as parseYaml, stringify as stringifyYaml, YAMLParseError } from 'yaml';
import { z } from 'zod';

import { ConfigError, IntegrityError } from '../domain/errors.js';
import type { Contract } from '../domain/contract.js';
import { isCriterionId, normalizeEpicId, parseCriterionId } from '../domain/ids.js';
import {
  ASSERTION_COMPARISONS,
  HTTP_METHODS,
  NEEDS_HUMAN_REASONS,
  type Assertion,
  type BrowserAssertionTarget,
  type DataBinding,
  type HttpAssertionTarget,
  type ObservationAssertionTarget,
  type Plan,
  type PlanCriterion,
  type ProbeSpec,
  type ShellAssertionTarget,
} from '../domain/plan.js';
import { schemaVersionFor } from './versions.js';

/** Current plan schema version, from the AD-5 registry. */
export const PLAN_SCHEMA_VERSION = schemaVersionFor('plan');

/* ── primitives ─────────────────────────────────────────────────────────────────────── */

const ISO_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

/**
 * True only for a timestamp naming a date that actually exists.
 *
 * The same discipline, and the same reason, as `schemas/contract.ts` and
 * `schemas/manifest.ts`: `Date.parse` accepts `2026-02-31T…` and silently normalises it to
 * 3 March, so a hand-edited plan would be accepted while claiming an instant it does not
 * mean.
 *
 * DUPLICATION, NAMED RATHER THAN HIDDEN: `schemas/contract.ts` has an identical private
 * helper. Exporting it from there was out of scope for this story — story 4.2 must not
 * edit the merged contract module — so it is repeated here with this note instead of
 * quietly diverging. Hoisting both into a shared `schemas/timestamps.ts` is a one-file
 * follow-up, and is recorded as such in the story's PR body.
 */
function isRealUtcInstant(value: string): boolean {
  const m = ISO_UTC_PATTERN.exec(value);
  if (m === null) {
    return false;
  }
  const [, year = '', month = '', day = '', hour = '', minute = '', second = '', ms = ''] = m;

  const date = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Number(ms),
    ),
  );
  if (Number.isNaN(date.getTime())) {
    return false;
  }

  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day) &&
    date.getUTCHours() === Number(hour) &&
    date.getUTCMinutes() === Number(minute) &&
    date.getUTCSeconds() === Number(second) &&
    date.getUTCMilliseconds() === Number(ms)
  );
}

/** ISO-8601 UTC, milliseconds, `Z`-terminated — the house timestamp format. */
const IsoUtcTimestamp = z
  .string()
  .refine((value) => ISO_UTC_PATTERN.test(value), {
    message: 'must be an ISO-8601 UTC timestamp ending in Z',
  })
  .refine(isRealUtcInstant, { message: 'must name a date that exists' });

/** Lowercase hex SHA-256. Uppercase is rejected: one spelling, or two files compare unequal. */
const Fingerprint = z
  .string()
  .regex(/^[0-9a-f]{64}$/, { message: 'must be 64 lowercase hexadecimal characters' });

/**
 * An IDENTIFIER: a config id, a probe id, a data-binding name.
 *
 * THIS PATTERN IS A SECURITY CONTROL, not tidiness. `commandId` is how a plan names an
 * executable, and the whole AD-3 boundary rests on that value being an id rather than a
 * command. Constrained to a leading alphanumeric followed by alphanumerics, underscore,
 * dot and hyphen, it cannot hold a space, a pipe, a semicolon, a redirect, a path
 * separator or a substitution — so `commandId: "rm -rf /"` fails here rather than reaching
 * a config lookup and being reported as a mere typo.
 *
 * It is deliberately STRICTER than the config's own key type, which is `nonEmptyString`.
 * A project may therefore declare a service or observation key that no plan can reference.
 * That fails closed in the right direction, and it is why the "unknown id" diagnostics in
 * `src/authoring/plan.ts` list the project's DECLARED keys rather than assuming every
 * declared key could have matched this pattern (raised by story 4.1's agent at cohort
 * intent-sync).
 */
const Identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, {
    message:
      'must be a config id: letters, digits, underscore, dot or hyphen, starting with a letter or digit (never a command line)',
  });

/** Non-empty once trimmed. `min(1)` alone accepts "   ", which says nothing to a reader. */
const Prose = z.string().refine((value) => value.trim().length > 0, {
  message: 'must not be empty or only whitespace',
});

/**
 * A SERVICE-RELATIVE request path.
 *
 * Must begin with exactly one `/`. That single rule carries AD-3's "no production URL
 * defaults": `https://prod.example.com/x` has no leading slash and is refused, and
 * `//prod.example.com/x` — a protocol-relative URL, which resolves to another origin and is
 * the version of this attack that looks like a path — is refused by the negative lookahead.
 * Whitespace and control characters are refused too, since neither can appear in a real
 * request target and both are how a value gets smuggled past a later naive parser.
 */
const RelativePath = z
  .string()
  .regex(/^\/(?!\/)[^\s\u0000-\u001f]*$/, {
    message:
      "must be a service-relative path beginning with a single '/' — a plan names a declared service, never a host",
  });

/** An RFC 7230 header field name. */
const HeaderName = z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, {
  message: 'must be a valid HTTP header field name',
});

/**
 * A header VALUE, with CR and LF refused.
 *
 * A drafted header value containing `\r\n` is header injection: it would append a header,
 * or a whole second request, to something a provider CLI wrote. There is no legitimate
 * newline in a header value, so refusing one costs nothing and closes the hole.
 */
const HeaderValue = z.string().regex(/^[^\r\n\u0000]*$/, {
  message: 'must not contain a carriage return, newline or NUL',
});

/**
 * An argv element for a declared command.
 *
 * NUL and newline are refused: NUL cannot cross the exec boundary intact, and a newline in
 * an argument corrupts every line-oriented evidence rendering downstream. Shell
 * metacharacters are NOT refused, and deliberately so — the merged path from a
 * `DeclaredCommand` to a child (`pipeline/stages/gate-command.ts` ->
 * `ProcessRunner.run(binary, args)`) has no shell in it and no way to add one, so `;` and
 * `$(...)` arrive as literal text. Pretending to filter them here would imply a shell
 * exists somewhere, which is exactly the belief AD-3 is designed to make unnecessary.
 */
const Argument = z.string().regex(/^[^\r\n\u0000]*$/, {
  message: 'must not contain a newline or NUL',
});

/* ── assertions ─────────────────────────────────────────────────────────────────────── */

const AssertionComparisonSchema = z.enum(ASSERTION_COMPARISONS);

/**
 * Builds the assertion schema for one surface.
 *
 * `description` and `expected` are copied verbatim into `AssertionEvaluation` by the
 * executor (AD-13), so both are required and both are strings — including for a status code
 * or a count, because everything here is persisted to `result.json`.
 *
 * There is nowhere to put `satisfied` or `actual`: a plan states expectations and never
 * outcomes.
 */
function assertionSchema<T extends z.ZodType>(target: T) {
  return z.strictObject({
    description: Prose,
    target,
    comparison: AssertionComparisonSchema,
    // NOT `Prose`: an expectation of the empty string ("this header is empty") is a real
    // expectation, and `expected: ""` is unambiguous in a way a blank statement is not.
    expected: z.string(),
  });
}

const HttpAssertionTargetSchema = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('status') }),
  z.strictObject({ source: z.literal('header'), name: HeaderName }),
  z.strictObject({ source: z.literal('body') }),
  z.strictObject({ source: z.literal('jsonPath'), path: Prose }),
]);

const BrowserAssertionTargetSchema = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('url') }),
  z.strictObject({ source: z.literal('title') }),
  z.strictObject({ source: z.literal('text'), selector: Prose }),
  z.strictObject({ source: z.literal('visible'), selector: Prose }),
]);

const ObservationAssertionTargetSchema = z.strictObject({
  source: z.literal('jsonPath'),
  path: Prose,
  phase: z.enum(['snapshot', 'before', 'after', 'delta']),
});

const ShellAssertionTargetSchema = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('exitCode') }),
  z.strictObject({ source: z.literal('stdout') }),
  z.strictObject({ source: z.literal('stderr') }),
]);

/**
 * At least one assertion per probe. See the module header, point 5 — this single `.min(1)`
 * is what makes `outcomeOf`'s "nothing was adjudicated mechanically" branch unreachable
 * from a compiled plan.
 */
function assertions<T extends z.ZodType>(target: T) {
  return z.array(assertionSchema(target)).min(1, {
    message:
      'a probe must carry at least one assertion — a probe that adjudicates nothing cannot mint a PASS',
  });
}

/* ── probes ─────────────────────────────────────────────────────────────────────────── */

/**
 * `mechanics` and `assertions` are SEPARATE sub-objects on every probe, and the separation
 * is load-bearing for Epic 5: story 5.6's mechanics-adaptation flow may alter mechanics
 * fields only, and assertion and expected-value fields are structurally read-only in that
 * flow. AI adapts HOW, never WHAT (AD-2, FR-18).
 */
const HttpProbeSchema = z.strictObject({
  id: Identifier,
  surface: z.literal('http'),
  mechanics: z.strictObject({
    serviceId: Identifier,
    method: z.enum(HTTP_METHODS),
    path: RelativePath,
    headers: z.record(HeaderName, HeaderValue).optional(),
    body: z.string().optional(),
  }),
  assertions: assertions(HttpAssertionTargetSchema),
});

const BrowserProbeSchema = z.strictObject({
  id: Identifier,
  surface: z.literal('browser'),
  mechanics: z.strictObject({
    serviceId: Identifier,
    path: RelativePath,
    // Untrusted provider prose. Epic 5 turns it into an ephemeral Playwright spec in the
    // run directory (Q30/Q31); it must never become a shell string.
    scenario: Prose,
  }),
  assertions: assertions(BrowserAssertionTargetSchema),
});

const ObservationProbeSchema = z.strictObject({
  id: Identifier,
  surface: z.literal('observation'),
  mechanics: z.strictObject({
    commandId: Identifier,
    args: z.array(Argument),
    /** The `id` of another probe in the same criterion; validated for existence below. */
    around: Identifier.optional(),
  }),
  assertions: assertions(ObservationAssertionTargetSchema),
});

const ShellProbeSchema = z
  .strictObject({
    id: Identifier,
    surface: z.literal('shell'),
    mechanics: z.strictObject({
      commandId: Identifier,
      args: z.array(Argument),
      argumentAllowlist: z.array(Argument),
    }),
    assertions: assertions(ShellAssertionTargetSchema),
  })
  .superRefine((probe, ctx) => {
    // Story 4.6's AC asks for "schema + runtime double enforcement" of the allowlist. This
    // is the schema half: a hostile draft cannot be WRITTEN with an argument outside the
    // list a reviewer will read. 4.6 checks again before executing, which is what catches a
    // hand-edited plan file that never went through this gate.
    const allowed = new Set(probe.mechanics.argumentAllowlist);
    probe.mechanics.args.forEach((argument, index) => {
      if (!allowed.has(argument)) {
        ctx.addIssue({
          code: 'custom',
          path: ['mechanics', 'args', index],
          message: `argument '${argument}' is not in this probe's argumentAllowlist`,
        });
      }
    });
  });

/**
 * The CLOSED probe union (AD-3, AD-13), discriminated by `surface`.
 *
 * `tests/unit/schemas/plan-surfaces.test.ts` pins this list against the merged
 * `PROBE_SURFACES` in both directions, so the schema and the execution contract cannot
 * drift. Widening it is an ADR, not an edit.
 */
const ProbeSchema = z.discriminatedUnion('surface', [
  HttpProbeSchema,
  BrowserProbeSchema,
  ObservationProbeSchema,
  ShellProbeSchema,
]);

/* ── criteria ───────────────────────────────────────────────────────────────────────── */

const CriterionId = z
  .string()
  .refine(isCriterionId, { message: "must be a canonical criterion id, e.g. 'E7-01'" });

/**
 * How one criterion is verified.
 *
 * A `needs-human` arm is a strict object with NO `probes` key, so attaching a probe to a
 * human criterion fails as an unknown key rather than as a rule somebody remembered to
 * write. There is likewise no `statement` key on either arm: AD-5's "by criterion id only"
 * is made impossible to violate rather than merely discouraged.
 */
const PlanCriterionSchema = z
  .discriminatedUnion('disposition', [
    z.strictObject({
      criterionId: CriterionId,
      disposition: z.literal('automated'),
      probes: z.array(ProbeSchema).min(1, {
        message:
          "an automated criterion must carry at least one probe — if none is safe, record it as needs-human with reason 'not-safely-automatable'",
      }),
    }),
    z.strictObject({
      criterionId: CriterionId,
      disposition: z.literal('needs-human'),
      reason: z.enum(NEEDS_HUMAN_REASONS),
      guidance: Prose,
    }),
  ])
  .superRefine((entry, ctx) => {
    if (entry.disposition !== 'automated') {
      return;
    }

    // Probe ids identify a probe within its criterion: evidence references them, and an
    // observation's `around` names one. Two probes answering to one id would make both
    // ambiguous.
    const seen = new Map<string, number>();
    entry.probes.forEach((probe, index) => {
      const first = seen.get(probe.id);
      if (first !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['probes', index, 'id'],
          message: `duplicate probe id '${probe.id}' (already used at probes[${first}])`,
        });
      } else {
        seen.set(probe.id, index);
      }
    });

    entry.probes.forEach((probe, index) => {
      if (probe.surface !== 'observation' || probe.mechanics.around === undefined) {
        return;
      }
      // A dangling `around` would leave story 4.5 with a before/after wrap around nothing,
      // and its `delta` assertions comparing two snapshots that were never taken.
      if (!seen.has(probe.mechanics.around)) {
        ctx.addIssue({
          code: 'custom',
          path: ['probes', index, 'mechanics', 'around'],
          message: `no probe with id '${probe.mechanics.around}' exists in this criterion`,
        });
      }
      if (probe.mechanics.around === probe.id) {
        ctx.addIssue({
          code: 'custom',
          path: ['probes', index, 'mechanics', 'around'],
          message: 'a probe cannot wrap itself',
        });
      }
    });
  });

/* ── deterministic data (AD-9 / Q36) ────────────────────────────────────────────────── */

/**
 * The deterministic-data block. **Story 4.3 owns the semantics; this story owns the
 * fields.**
 *
 * The union is discriminated so "declared volatile" is structural: a volatile binding has
 * no `value` at all, which is what makes it excludable from the reproducibility comparison
 * without anyone having to remember a convention. A fixed binding without a value, or a
 * volatile one carrying a value, is rejected by construction.
 */
const DataBindingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('fixed'), name: Identifier, value: z.string() }),
  z.strictObject({ kind: z.literal('volatile'), name: Identifier, reason: Prose }),
]);

const PlanDataSchema = z
  .strictObject({
    /**
     * The per-plan recorded seed (AD-9). Minted by SpecWitness at the edge through the
     * `Ids` port, never chosen by the provider — a seed is bookkeeping, like a version or
     * a fingerprint, and `src/authoring/prompt.ts` establishes that those are not the
     * model's to choose.
     */
    seed: Identifier,
    bindings: z.array(DataBindingSchema),
  })
  .superRefine((data, ctx) => {
    const seen = new Map<string, number>();
    data.bindings.forEach((binding, index) => {
      const first = seen.get(binding.name);
      if (first !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['bindings', index, 'name'],
          message: `duplicate binding name '${binding.name}' (already used at bindings[${first}]); a reference by name must be unambiguous`,
        });
      } else {
        seen.set(binding.name, index);
      }
    });
  });

/* ── the document ───────────────────────────────────────────────────────────────────── */

/**
 * True when `value` is ALREADY the canonical epic id, e.g. `epic-7`.
 *
 * Canonicality is defined as "normalizing it changes nothing" rather than by a second
 * pattern, exactly as `schemas/contract.ts` defines it — `normalizeEpicId` is the only
 * normalizer (spine Identifiers row).
 */
function isCanonicalEpicId(value: string): boolean {
  try {
    return normalizeEpicId(value) === value;
  } catch {
    return false;
  }
}

const PlanContractRefSchema = z.strictObject({
  /** What a human reads in a diff. Meaningless to the staleness comparison. */
  version: z.number().int().positive(),
  /** What the staleness comparison actually compares (AC3). */
  fingerprint: Fingerprint,
});

const PlanSpecSchema = z
  .strictObject({
    epic: z.string().refine(isCanonicalEpicId, {
      message: "must be a canonical epic id, e.g. 'epic-7' (not 'epic-07' or '7')",
    }),
    contract: PlanContractRefSchema,
    data: PlanDataSchema,
    criteria: z.array(PlanCriterionSchema),
  })
  .superRefine((spec, ctx) => {
    const seen = new Map<string, number>();

    spec.criteria.forEach((entry, index) => {
      // Two entries for one criterion means two dispositions for one expectation, and
      // nothing downstream could say which one was verified.
      const first = seen.get(entry.criterionId);
      if (first !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['criteria', index, 'criterionId'],
          message: `duplicate criterion id '${entry.criterionId}' (already planned at criteria[${first}])`,
        });
      } else {
        seen.set(entry.criterionId, index);
      }

      // The id's epic component must be THIS plan's epic. `E8-01` inside an epic-7 plan is
      // a criterion copy-pasted from another epic, and it would be executed and reported
      // against an expectation this plan's contract never made.
      try {
        const { epicNumber } = parseCriterionId(entry.criterionId);
        if (normalizeEpicId(String(epicNumber)) !== spec.epic) {
          ctx.addIssue({
            code: 'custom',
            path: ['criteria', index, 'criterionId'],
            message: `criterion id '${entry.criterionId}' belongs to a different epic than '${spec.epic}'`,
          });
        }
      } catch {
        // Malformed ids are already reported by `CriterionId`; twice is harder to read.
      }
    });
  });

/** Generation provenance. Absence is an explicit `null`, never a missing key (AD-5, Q65). */
const PlanProvenanceSchema = z.strictObject({
  provider: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
  /** The AGENT CLI's version (`claude --version`), never SpecWitness's own. */
  providerCliVersion: z.string().min(1).nullable(),
  generatedAt: IsoUtcTimestamp.nullable(),
});

const PlanMetaSchema = z.strictObject({
  schemaVersion: z.number().int().positive(),
  compiledAt: IsoUtcTimestamp,
  provenance: PlanProvenanceSchema,
});

/**
 * The whole document: exactly two top-level keys.
 *
 * `.strict()` at every level. In an artifact that spawns processes and issues requests, a
 * key nobody understands is not something to shrug at — and dropping it on read would mean
 * the file a human reviewed and the thing being executed are not the same document.
 */
export const PlanSchema = z.strictObject({
  plan: PlanSpecSchema,
  meta: PlanMetaSchema,
});

/**
 * Human-readable rendering of a zod failure: `plan.criteria.0.probes.0.mechanics: msg`.
 *
 * An UNRECOGNIZED KEY is expanded to name the key itself, one entry per key. zod reports
 * those at the containing object's path with the offending names in `issue.keys`, so the
 * default rendering says `plan.criteria.0.probes.0.mechanics: Unrecognized key: "run"` —
 * the reader has to combine two halves to find the line to delete. Since an unknown key in
 * a plan is the AD-3 attack rather than a typo, the message points straight at it:
 * `plan.criteria.0.probes.0.mechanics.run: unknown key`.
 */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .flatMap((issue) => {
      const at = issue.path.join('.');
      if (issue.code === 'unrecognized_keys') {
        return issue.keys.map(
          (key) =>
            `${at === '' ? key : `${at}.${key}`}: unknown key — a plan is executed, so nothing here is ignored`,
        );
      }
      return [`${at === '' ? '<root>' : at}: ${issue.message}`];
    })
    .join('; ');
}

/**
 * Reads `meta.schemaVersion` without validating anything else.
 *
 * The `schemas/manifest.ts` / `schemas/contract.ts` policy: a file from the future must
 * produce "upgrade specwitness" rather than a confusing list of shape errors caused by
 * fields this build has never heard of.
 */
function readSchemaVersion(document: unknown): number | undefined {
  if (typeof document !== 'object' || document === null || !('meta' in document)) {
    return undefined;
  }
  const meta = (document as { meta: unknown }).meta;
  if (typeof meta !== 'object' || meta === null || !('schemaVersion' in meta)) {
    return undefined;
  }
  const version = (meta as { schemaVersion: unknown }).schemaVersion;
  return typeof version === 'number' ? version : undefined;
}

/**
 * Parses plan YAML into the model. Structural validation only.
 *
 * Throws `ConfigError` (exit 3) for anything malformed, always naming `path`, because the
 * operator is looking at a file rather than at an in-memory value. It never compares
 * fingerprints — staleness is asked separately, via `assertPlanMatchesContract`, so that a
 * stale plan still parses far enough to be REFUSED BY NAME rather than crashing.
 */
export function parsePlan(text: string, path: string): Plan {
  let document: unknown;
  try {
    document = parseYaml(text, {
      // Silently taking the last of two `criteria:` keys would mean the file a human
      // reviewed is not the file being executed. `src/config/load.ts` and
      // `schemas/contract.ts` do the same, for the same reason.
      uniqueKeys: true,
    });
  } catch (cause) {
    const detail = cause instanceof YAMLParseError ? `: ${cause.message}` : '';
    throw new ConfigError(
      `plan is not valid YAML: ${path}${detail}`,
      'fix the YAML syntax, or re-run `specwitness plan <epic>` to regenerate the file',
    );
  }

  if (document === null || document === undefined) {
    throw new ConfigError(
      `plan is empty: ${path}`,
      'a plan has exactly two top-level keys, `plan` and `meta`; run `specwitness plan <epic>` to compile one',
    );
  }

  const version = readSchemaVersion(document);
  if (version !== undefined && version > PLAN_SCHEMA_VERSION) {
    throw new ConfigError(
      `plan at ${path} was written by a newer specwitness (schemaVersion ${version}, this build understands ${PLAN_SCHEMA_VERSION})`,
      'upgrade specwitness to read this plan; do not edit it by hand to fit an older build',
    );
  }

  const result = PlanSchema.safeParse(document);
  if (!result.success) {
    throw new ConfigError(
      `plan is malformed: ${path} (${describeIssues(result.error)})`,
      'a plan has exactly two top-level keys, `plan` and `meta`; an unknown key is never ignored, because a plan is executed rather than merely read — re-run `specwitness plan <epic>` to regenerate it',
    );
  }

  return result.data as Plan;
}

/* ── serialization ──────────────────────────────────────────────────────────────────── */

/** Drops `undefined`-valued keys so an absent optional never renders as `null`. */
function present<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function orderedAssertion(assertion: Assertion<unknown>): Record<string, unknown> {
  return {
    description: assertion.description,
    target: assertion.target,
    comparison: assertion.comparison,
    expected: assertion.expected,
  };
}

function orderedProbe(probe: ProbeSpec): Record<string, unknown> {
  const head = { id: probe.id, surface: probe.surface };
  const tail = (mechanics: Record<string, unknown>): Record<string, unknown> => ({
    ...head,
    mechanics: present(mechanics),
    assertions: probe.assertions.map((assertion) =>
      orderedAssertion(
        assertion as Assertion<
          HttpAssertionTarget | BrowserAssertionTarget | ObservationAssertionTarget | ShellAssertionTarget
        >,
      ),
    ),
  });

  switch (probe.surface) {
    case 'http':
      return tail({
        serviceId: probe.mechanics.serviceId,
        method: probe.mechanics.method,
        path: probe.mechanics.path,
        headers: probe.mechanics.headers,
        body: probe.mechanics.body,
      });
    case 'browser':
      return tail({
        serviceId: probe.mechanics.serviceId,
        path: probe.mechanics.path,
        scenario: probe.mechanics.scenario,
      });
    case 'observation':
      return tail({
        commandId: probe.mechanics.commandId,
        args: [...probe.mechanics.args],
        around: probe.mechanics.around,
      });
    case 'shell':
      return tail({
        commandId: probe.mechanics.commandId,
        args: [...probe.mechanics.args],
        argumentAllowlist: [...probe.mechanics.argumentAllowlist],
      });
    default: {
      // Compile-time exhaustiveness: a surface added to the union must be given a
      // rendering here rather than silently serializing as nothing.
      const unreachable: never = probe;
      return unreachable;
    }
  }
}

function orderedCriterion(entry: PlanCriterion): Record<string, unknown> {
  if (entry.disposition === 'automated') {
    return {
      criterionId: entry.criterionId,
      disposition: entry.disposition,
      probes: entry.probes.map(orderedProbe),
    };
  }
  return {
    criterionId: entry.criterionId,
    disposition: entry.disposition,
    reason: entry.reason,
    guidance: entry.guidance,
  };
}

function orderedBinding(binding: DataBinding): Record<string, unknown> {
  return binding.kind === 'fixed'
    ? { kind: binding.kind, name: binding.name, value: binding.value }
    : { kind: binding.kind, name: binding.name, reason: binding.reason };
}

/**
 * Renders a plan as human-readable YAML.
 *
 * Key order is DECLARED rather than alphabetical: `plan` before `meta` so a reviewer reads
 * what will be executed before the bookkeeping, and within a probe `id`, `surface`,
 * `mechanics`, `assertions` — the order in which someone reads "what is this, how does it
 * look, and what must be true". Plans are reviewed in a pull request (Q11), so readability
 * is the requirement.
 *
 * The output is stable: serializing a parsed plan reproduces the same bytes, so a
 * cosmetically reformatted file normalises to one canonical rendering.
 */
export function serializePlan(plan: Plan): string {
  const ordered = {
    plan: {
      epic: plan.plan.epic,
      contract: {
        version: plan.plan.contract.version,
        fingerprint: plan.plan.contract.fingerprint,
      },
      data: {
        seed: plan.plan.data.seed,
        bindings: plan.plan.data.bindings.map(orderedBinding),
      },
      criteria: plan.plan.criteria.map(orderedCriterion),
    },
    meta: {
      schemaVersion: plan.meta.schemaVersion,
      compiledAt: plan.meta.compiledAt,
      provenance: {
        provider: plan.meta.provenance.provider,
        model: plan.meta.provenance.model,
        providerCliVersion: plan.meta.provenance.providerCliVersion,
        generatedAt: plan.meta.provenance.generatedAt,
      },
    },
  };

  return stringifyYaml(ordered, {
    // No line folding: a folded scenario or guidance sentence round-trips identically but
    // is much harder for a human to review.
    lineWidth: 0,
    // `null`, not `~` or an empty value: an absent provenance value must READ as a recorded
    // absence, and `model:` with nothing after it does not.
    nullStr: 'null',
  });
}

/* ── the provider draft ─────────────────────────────────────────────────────────────── */

/**
 * What a `plan-author` provider returns, before SpecWitness adds the bookkeeping.
 *
 * The provider decides the criteria's dispositions, probes and data bindings. It does NOT
 * decide the epic, the contract version, the fingerprint, the seed, the schema version or
 * the timestamp — those are bookkeeping, and `src/authoring/prompt.ts` establishes for
 * contracts that bookkeeping is not the model's to choose. Here the schema simply has
 * nowhere to put any of them, so an instruction to that effect is belt and braces.
 */
export interface PlanDraft {
  readonly data: { readonly bindings: readonly DataBinding[] };
  readonly criteria: readonly PlanCriterion[];
}

/**
 * The CONTRACT-AWARE draft schema handed to the AD-2 gate as `responseSchema`.
 *
 * Three rules can only be expressed against a specific contract, and all three are the
 * story's acceptance criteria rather than nice-to-haves:
 *
 *  1. **Every contract criterion appears, exactly once.** A criterion missing from a plan
 *     disappears from verification and nothing reports its absence — the failure mode Q38
 *     exists to prevent. A criterion the contract does not contain is equally refused: it
 *     would be executed against an expectation nobody froze.
 *  2. **A `verifiability: human` criterion can never receive a probe.** `domain/contract.ts`
 *     is unconditional: human criteria "always resolve to NEEDS_HUMAN and never auto-PASS".
 *     Epic 3 caught and reverted a variant that softened this, and review called it a
 *     silent redesign of a recorded decision. It is carried as needs-human with reason
 *     `human-verifiability`, never `not-safely-automatable` — the two reasons record
 *     different facts (Q39) and swapping them would misreport why a human is needed.
 *  3. **An `automated` criterion may be deferred only as `not-safely-automatable`.** A
 *     draft claiming `human-verifiability` for a criterion whose contract says otherwise is
 *     contradicting the frozen document.
 *
 * They are enforced HERE, inside the schema, rather than after the gate returns, because
 * `src/providers/invoke.ts` feeds validation messages back into the next attempt's prompt
 * (FR-14). A draft that dropped a criterion is told exactly which one and retries; a
 * post-hoc check would only fail after the budget was spent.
 */
export function planDraftSchemaFor(contract: Contract): z.ZodType<PlanDraft> {
  const byId = new Map(contract.spec.criteria.map((criterion) => [criterion.id, criterion]));

  const schema = z
    .strictObject({
      data: z.strictObject({ bindings: z.array(DataBindingSchema) }),
      criteria: z.array(PlanCriterionSchema),
    })
    .superRefine((draft, ctx) => {
      const planned = new Map<string, number>();

      draft.criteria.forEach((entry, index) => {
        const criterion = byId.get(entry.criterionId);

        if (criterion === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['criteria', index, 'criterionId'],
            message: `'${entry.criterionId}' is not a criterion of the frozen contract for ${contract.spec.epic}`,
          });
          return;
        }

        const first = planned.get(entry.criterionId);
        if (first !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['criteria', index, 'criterionId'],
            message: `'${entry.criterionId}' is planned twice (already at criteria[${first}]); plan each criterion exactly once`,
          });
        } else {
          planned.set(entry.criterionId, index);
        }

        if (criterion.verifiability === 'human') {
          if (entry.disposition !== 'needs-human') {
            ctx.addIssue({
              code: 'custom',
              path: ['criteria', index, 'disposition'],
              message: `'${entry.criterionId}' is declared verifiability: human in the frozen contract, so it must be carried as needs-human with reason 'human-verifiability' — no probe may adjudicate it`,
            });
          } else if (entry.reason !== 'human-verifiability') {
            ctx.addIssue({
              code: 'custom',
              path: ['criteria', index, 'reason'],
              message: `'${entry.criterionId}' is verifiability: human in the contract, so its reason must be 'human-verifiability', not '${entry.reason}'`,
            });
          }
          return;
        }

        if (entry.disposition === 'needs-human' && entry.reason !== 'not-safely-automatable') {
          ctx.addIssue({
            code: 'custom',
            path: ['criteria', index, 'reason'],
            message: `'${entry.criterionId}' is verifiability: automated in the contract, so deferring it to a human is only valid with reason 'not-safely-automatable'`,
          });
        }
      });

      // Reported LAST and at the criteria array itself, because it is a statement about the
      // whole draft rather than about one entry — and it is the message the retry prompt
      // most needs to carry verbatim.
      const missing = contract.spec.criteria
        .map((criterion) => criterion.id)
        .filter((id) => !planned.has(id));

      if (missing.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['criteria'],
          message: `every criterion of the frozen contract must appear exactly once; missing: ${missing.join(', ')}. A criterion you cannot map to a safe probe is carried as needs-human with reason 'not-safely-automatable' — never omitted`,
        });
      }
    });

  return schema as unknown as z.ZodType<PlanDraft>;
}

/* ── the staleness refusal (AC3) ────────────────────────────────────────────────────── */

/**
 * Refuses a plan that was not compiled from THIS contract (AC3, FR-16).
 *
 * Story 4.7 calls this from the CLI edge when `verify` loads a plan; it is exported as a
 * pure function so it is testable without a pipeline, and so there is exactly one
 * implementation of the question.
 *
 * THE HINT, and why its wording is deliberate. ADR-005 exists because telling an operator
 * their CONTRACT "no longer matches" invites `--freeze`, which launders a tamper and
 * destroys the evidence. A stale PLAN is the opposite case and must not inherit that
 * caution: a plan is a derived, regenerable artifact with no authority of its own, so the
 * remedy genuinely is to recompile, and saying so precisely is the point. What the hint
 * must never do is invite recompiling over a problem recompiling cannot fix — which is why
 * a plan for a DIFFERENT EPIC gets its own message and its own remedy.
 *
 * Contract INTEGRITY is not re-asked here. `assertVerifiableContract` is the single place
 * that decides whether a contract is frozen and untampered, and 4.7 calls it before this;
 * a second implementation would eventually disagree with the first. What this function
 * needs from the contract is the fingerprint it recorded when it was frozen.
 *
 * @throws {IntegrityError} when the plan names another epic, when the contract carries no
 *   frozen fingerprint to compare against, or when the fingerprints differ.
 */
export function assertPlanMatchesContract(plan: Plan, contract: Contract): void {
  if (plan.plan.epic !== contract.spec.epic) {
    throw new IntegrityError(
      `the plan is compiled for ${plan.plan.epic}, but the contract being verified is for ${contract.spec.epic}`,
      `verify the epic the plan belongs to, or compile a plan for ${contract.spec.epic} with 'specwitness plan ${contract.spec.epic}' — recompiling will not reconcile two different epics`,
    );
  }

  if (!contract.meta.frozen || contract.meta.fingerprint === null) {
    throw new IntegrityError(
      `cannot check the plan for ${plan.plan.epic} against a contract that is not frozen`,
      `freeze the contract with 'specwitness contract ${contract.spec.epic} --freeze' first; only a frozen contract has a fingerprint a plan can be checked against`,
    );
  }

  if (plan.plan.contract.fingerprint !== contract.meta.fingerprint) {
    throw new IntegrityError(
      `the plan for ${plan.plan.epic} was compiled from a different version of the contract: ` +
        `it records fingerprint ${plan.plan.contract.fingerprint} (contract version ` +
        `${plan.plan.contract.version}), and the frozen contract now reads ` +
        `${contract.meta.fingerprint} (version ${contract.spec.version}) — the plan no longer matches`,
      `re-run 'specwitness plan ${contract.spec.epic}' to recompile the plan against the current contract`,
    );
  }
}

export type { Plan, PlanCriterion, ProbeSpec };
