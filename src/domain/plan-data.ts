/**
 * Deterministic test data — resolving a plan's declared scenario inputs into concrete values
 * (AD-9, FR-17, NFR-5, Q36, brief §48). Story 4.3.
 *
 * ============================================================================
 * THIS MODULE EXISTS TO MAKE ONE FAILURE MODE UNREPRESENTABLE, AND IT IS A
 * NEGATIVE REQUIREMENT: **nothing here generates fresh data per run.**
 * ============================================================================
 *
 * AD-9 states the mechanism bluntly: deterministic test data is resolved at plan COMPILE time
 * and stored in the Plan. This module does not invent values — it READS what
 * `src/domain/plan.ts`'s `PlanData` already stored and makes it available to probes. The defect
 * it prevents is "LLM-fresh test data per run", which would make two runs of the same plan
 * against the same revision incomparable; and comparability is the entire premise of a
 * verification gate. A suite that passes today and fails tomorrow with no code change teaches an
 * operator to ignore it. A GATE that does that is worse than no gate, because it was supposed to
 * be the thing you could trust.
 *
 * So: no `Math.random()`, no `crypto.randomUUID()`, no `Date.now()`, no `new Date()`, nothing
 * reading the environment, and no I/O of any kind. `Clock` and `Ids` are injected ports
 * precisely so that nothing on this path reads wall time — and neither is imported here, because
 * nothing here needs one. `tests/unit/domain/plan-data-determinism.test.ts` scans this file for
 * every one of those and fails if one appears.
 *
 * ── THE TWO KINDS OF BINDING, AND WHAT `volatile` ACTUALLY MEANS ───────────────────────────
 *
 * `DataBinding` (4.2, merged) is a discriminated union of exactly two shapes:
 *
 *   - `fixed`    carries a `value` decided once at compile time and used verbatim every run;
 *   - `volatile` carries NO value — only a `name` and a human-readable `reason`.
 *
 * A volatile binding's value is DERIVED from the plan's recorded `seed` (see
 * `deriveVolatileValue`). **`volatile` means "excluded from the reproducibility comparison", not
 * "allowed to be random"** — which is AD-9's own wording: *"fields that legitimately vary per run
 * are declared `volatile` in the plan and excluded from reproducibility comparison"*. The
 * reproducibility guarantee this module underwrites therefore reads:
 *
 *     for two runs of the same plan against the same revision, every probe input is
 *     byte-identical except those whose PLAN DECLARATION marks them volatile.
 *
 * `reproducibleInputs` is that projection, and its exclusion is driven by the declaration's
 * `kind` and never by a field's name. Excluding by name ("anything called `email`") works for a
 * fixture and fails for every real plan.
 *
 * ── A DIVERGENCE FROM 4.2's PROSE, RESOLVED IN FAVOUR OF THE STORY SPEC ────────────────────
 *
 * `src/domain/plan.ts` says a volatile value is derived "from the plan's recorded `seed` plus the
 * RUN IDENTITY". Story 4.3's spec says the opposite and says it three times: a pure function,
 * `(declarations, seed) -> resolved inputs`, "same seed plus same field => same value, every run,
 * on every machine", with anything reading the clock explicitly banned. The spec wins by the
 * project's precedence rule, and it is also the better answer: with run identity in the
 * derivation, an operator holding the committed plan could not reproduce a past run's inputs —
 * which is the premise of the product. Cross-run UNIQUENESS is what the `data.*` reset commands
 * exist for (story 4.3's own AC3): you reset the tree's state, you do not vary the input.
 *
 * The divergence is recorded rather than silently followed — `DECISIONS.md` D1 and the story's PR
 * body carry the contradiction itself, not merely the resolution. Neither `src/schemas/plan.ts`
 * nor `src/domain/plan.ts` is edited by this story; 4.2 owns those fields and said so.
 *
 * ── SUBSTITUTION IS 4.3's SEMANTICS (4.2 left it here deliberately) ────────────────────────
 *
 * A binding is referenced from probe mechanics as `{{name}}`. `resolveMechanics` walks a probe's
 * whole `mechanics` object and replaces every placeholder in every string.
 *
 * WHERE IT HAPPENS IS A SECURITY PROPERTY, agreed with all three surface stories at cohort
 * intent-sync: substitution happens BEFORE an executor is invoked, never inside one.
 * `ProbeRequest.params` in `domain/criterion-result.ts` already says the params are "resolved at
 * plan compile time (AD-9)", and that sentence is the seam. A value substituted AFTER a check is
 * a value that was never checked.
 *
 * The walk covers `ShellProbeMechanics.argumentAllowlist` as well as its `args`, and that is
 * load-bearing rather than incidental. Story 4.6 checks `args ⊆ argumentAllowlist` by exact
 * string equality on the FINAL argv. If only `args` were substituted, a resolved token would be
 * compared against a literal `{{signupEmail}}` and every binding-using shell probe would reject —
 * always, silently — and for a volatile binding there is no string the plan's author could ever
 * have written in the allowlist that would match, because the token is derived. Substituting both
 * sides with the same `ResolvedData` keeps the equality holding and adds NO capability to a
 * hostile author: they already control both arrays and the bindings. The allowlist was never a
 * defence against the plan's own author — it is a review surface (a reviewer reads
 * `{{signupEmail}}` and understands which binding may be passed) plus a defence against a plan
 * HAND-EDITED after compilation, and that second property is untouched. Accepted in writing by
 * story 4.6 at intent-sync.
 *
 * ── AD-1 ───────────────────────────────────────────────────────────────────────────────────
 *
 * Pure, and stricter than it looks: `domain-is-dependency-free` runs with
 * `tsPreCompilationDeps: true`, so even `import type { z } from 'zod'` would be a violation, and
 * so would `node:crypto`. That is why the hash below is hand-rolled rather than delegated —
 * see `deriveVolatileValue`. Two sibling domain imports only.
 */

import { ConfigError } from './errors.js';
import type { DataBinding, PlanData } from './plan.js';

/**
 * One scenario input, resolved.
 *
 * `volatile` is the PLAN's declaration carried forward, not a property of the value. It is what
 * `reproducibleInputs` reads, and carrying it here rather than re-deriving it later is what makes
 * "excluded by declaration" true by construction.
 */
export interface ResolvedInput {
  readonly name: string;
  readonly value: string;
  /** `true` when the plan declared this binding `volatile`. Drives comparison exclusion. */
  readonly volatile: boolean;
}

/**
 * Resolved inputs by binding name.
 *
 * A `Map` rather than a `Record`, and not for taste: a binding named `__proto__`, `constructor`
 * or `toString` must not resolve through the prototype chain into something that is not a
 * declared input. `src/config/types.ts` reaches for `Object.hasOwn` to close the same hazard on
 * its own lookup; a `Map` makes it unrepresentable instead of guarded.
 */
export type ResolvedData = ReadonlyMap<string, ResolvedInput>;

/** FNV-1a 64-bit offset basis. */
const FNV_OFFSET_BASIS = 0xcbf2_9ce4_8422_2325n;

/** FNV-1a 64-bit prime. */
const FNV_PRIME = 0x0000_0100_0000_01b3n;

/** 2^64 - 1, for the wrap that keeps the running hash inside 64 bits. */
const U64_MASK = 0xffff_ffff_ffff_ffffn;

/** Rendered width of a derived value, in hex digits. */
const DERIVED_HEX_DIGITS = 16;

/**
 * Separates seed from name so `("ab", "c")` cannot collide with `("a", "bc")`.
 *
 * NUL rather than `-` or `:` because a binding name is the plan author's own text and may contain
 * any printable character; NUL cannot appear in one that survived the schema, so the split point
 * is unambiguous.
 */
const SEED_NAME_SEPARATOR = '\u0000';

/**
 * The derivation for a volatile binding: FNV-1a 64-bit of `seed + NUL + name`, as 16 lowercase
 * hex digits.
 *
 * Stated in one sentence on purpose — a derivation nobody can restate is a derivation nobody can
 * review. The properties that matter, all of them testable:
 *
 *   - **pure**: the same `(seed, name)` yields the same value on every machine, forever. There is
 *     no clock, no randomness, no run id, no locale and no environment in it;
 *   - **hand-rolled**: `src/domain/**` may not import `node:crypto` (AD-1,
 *     `domain-is-dependency-free`), and this is not a security hash — it is a spreading function
 *     over a reviewed namespace. Collision resistance against an adversary is not a property
 *     anything here relies on: the seed and the names both come from the same committed plan a
 *     human reviewed, and a collision would produce two equal opaque tokens, not an escalation;
 *   - **opaque**: the result is a bare hex token, never a formatted email or URL. A plan needing
 *     a unique address writes `user-{{signupEmail}}@example.test` and this substitutes the token,
 *     so the FORMAT stays where a human can read it — in the plan — rather than being invented
 *     here where nobody would look for it.
 *
 * The golden-value test hard-codes outputs computed by an INDEPENDENT implementation, never by
 * this function (AD-12's rule for corpus expectations, applied for the same reason: a golden value
 * the implementation produced proves only that the implementation agrees with itself). Changing
 * this derivation therefore breaks that test loudly — correct, because the derivation is a
 * published contract and a silent change would make every previously compiled plan resolve
 * differently.
 */
export function deriveVolatileValue(seed: string, name: string): string {
  const text = `${seed}${SEED_NAME_SEPARATOR}${name}`;

  let hash = FNV_OFFSET_BASIS;
  // Hash the UTF-8 BYTES, not the UTF-16 code units, so the value does not depend on how a
  // runtime happens to represent a string internally. `TextEncoder` is a global (Node >= 22.12,
  // and a web standard), so this imports nothing.
  for (const byte of new TextEncoder().encode(text)) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & U64_MASK;
  }

  return hash.toString(16).padStart(DERIVED_HEX_DIGITS, '0');
}

/**
 * Resolve a plan's declared data bindings into concrete values.
 *
 * THE entry point, and the whole of AD-9's compile-time contract seen from execution: it reads
 * what the plan stored and derives only what the plan declared as volatile. It invents nothing,
 * defaults nothing, and asks nothing of the environment.
 *
 * A DUPLICATE BINDING NAME IS REFUSED rather than resolved last-wins. Last-wins would make the
 * resolved set depend on the order of an array, which is exactly the non-determinism this module
 * exists to remove — and it would do so invisibly, since both entries are individually valid.
 *
 * @throws {ConfigError} when two bindings share a name.
 */
export function resolvePlanData(data: PlanData): ResolvedData {
  const resolved = new Map<string, ResolvedInput>();

  for (const binding of data.bindings) {
    if (resolved.has(binding.name)) {
      throw new ConfigError(
        `the plan declares two data bindings named "${binding.name}"`,
        'binding names must be unique — resolving a duplicate would make the scenario inputs ' +
          'depend on the order of the bindings list, which is exactly the non-determinism the ' +
          'plan exists to remove. Rename one of them and recompile the plan',
      );
    }

    resolved.set(binding.name, resolveBinding(binding, data.seed));
  }

  return resolved;
}

/** One binding, resolved. The two arms of the merged union, and there is no third. */
function resolveBinding(binding: DataBinding, seed: string): ResolvedInput {
  if (binding.kind === 'fixed') {
    return { name: binding.name, value: binding.value, volatile: false };
  }

  return {
    name: binding.name,
    value: deriveVolatileValue(seed, binding.name),
    volatile: true,
  };
}

/**
 * The subset of resolved inputs a reproducibility comparison covers: every NON-volatile input.
 *
 * This is AC1 expressed as a function. Two runs of the same plan against the same revision must
 * produce byte-identical probe inputs "except fields the plan explicitly declares `volatile`", so
 * the comparison is stated over this projection rather than over the raw set.
 *
 * **Exclusion is driven by the declaration's `kind`, never by the field's name.** A binding called
 * `uniqueEmail` that the plan declared `fixed` is INCLUDED; a binding called `accountId` that the
 * plan declared `volatile` is EXCLUDED. A name-based heuristic passes for the fixture that
 * inspired it and silently mis-compares every real plan.
 *
 * A plain object rather than a `Map` because this is the thing callers DIFF, and a deep-equality
 * assertion over two plain objects is what a reader of the test expects to see. Key insertion
 * order follows the plan's binding order, so a serialised comparison is stable too.
 *
 * AN ORDINARY `{}`, NOT `Object.create(null)`, and the choice is deliberate rather than careless.
 * The prototype hazard that makes `ResolvedData` a `Map` — a binding named `toString` resolving
 * to `Object.prototype.toString` — is a hazard of LOOKING UP a name that was never declared, and
 * lookups happen against the `Map`, which is prototype-safe. Nothing looks a name up in this
 * projection; it exists to be compared whole. A null-prototype object would fail vitest's
 * `toStrictEqual` against an ordinary object literal, which is exactly how every consumer —
 * story 4.7 included — will want to assert on it, so the safer-looking constructor would buy
 * nothing here and cost every caller a confusing "expected {} to strictly equal {}".
 */
export function reproducibleInputs(resolved: ResolvedData): Readonly<Record<string, string>> {
  const comparable: Record<string, string> = {};

  for (const input of resolved.values()) {
    if (!input.volatile) {
      comparable[input.name] = input.value;
    }
  }

  return comparable;
}

/**
 * Matches one `{{name}}` placeholder.
 *
 * Deliberately narrow. A name may not contain `{` or `}`, so a malformed `{{a{{b}}` cannot be
 * read two ways; and the pattern is anchored to nothing, so `{single}` and `${shellish}` are
 * ordinary text. `{{…}}` was chosen over `${…}` so a plan's text never LOOKS like a shell
 * expansion: there is no shell anywhere on this path, but a reviewer should not have to know that
 * to read a plan safely.
 */
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

/**
 * Substitute every `{{name}}` in one string with its resolved value.
 *
 * SINGLE-PASS: a resolved value that itself contains `{{x}}` is returned as-is and never
 * re-scanned. A second pass is a template engine, and a template engine over provider-authored
 * text is a class of bug this story has no reason to introduce.
 *
 * FAIL-CLOSED: an undeclared name throws rather than substituting an empty string. The refusal
 * and its reasoning are the merged `getObservationCommand`'s, one artifact over — *"quietly
 * substituting anything would be a hole in the AD-3 boundary"*. A silently-empty value would
 * produce a probe that ran, observed something meaningless and reported it as a product result.
 *
 * @throws {ConfigError} when the text references a binding the plan did not declare.
 */
export function substituteInputs(text: string, resolved: ResolvedData): string {
  // Fast path, and the common one: most plan strings reference no binding at all.
  if (!text.includes('{{')) {
    return text;
  }

  // `replace` with a function, so each match is looked up exactly once and a value containing
  // `$&` or `$1` cannot be reinterpreted as a replacement pattern — which a string replacement
  // would do, and which would be a genuine injection of plan text into plan text.
  return text.replace(PLACEHOLDER, (_match, name: string) => {
    const input = resolved.get(name);
    if (input === undefined) {
      throw new ConfigError(
        `the plan references an undeclared data binding "${name}"`,
        declaredNamesHint(resolved),
      );
    }
    return input.value;
  });
}

/** Names the plan did declare, so the refusal is actionable rather than merely correct. */
function declaredNamesHint(resolved: ResolvedData): string {
  const declared = [...resolved.keys()];

  return declared.length > 0
    ? `declare it under the plan's data.bindings, or use one of: ${declared.join(', ')}`
    : "the plan declares no data bindings at all — add one under data.bindings and recompile";
}

/**
 * Deep-substitute every string inside a probe's `mechanics`, preserving the structure exactly.
 *
 * Generic and structural rather than per-surface, for three reasons that all point the same way:
 * the four probe shapes in `domain/plan.ts` put strings at different depths (`headers` values,
 * `args` elements, `argumentAllowlist` elements, `body`, `path`, `scenario`); a per-field version
 * would need editing every time a surface gained a field, and the story that gained it would be
 * the one that forgot; and Epic 5's `browser` mechanics already exist in the union with nothing
 * executing them, so a field-by-field walk would be wrong for `browser` from the day it shipped.
 *
 * VALUES ONLY, NEVER KEYS. An object key is a field name in a closed schema, not scenario data.
 * Substituting one would let a plan rename a mechanics field, which is a categorically larger
 * power than filling in a value, and nothing in the acceptance criteria asks for it.
 *
 * Returns a NEW structure; the input is not mutated. Callers hold a `ProbeSpec` read out of a
 * parsed plan, and mutating it would mean the second read of the same plan object saw already-
 * substituted text — a state in which a re-resolution silently differs from the first.
 *
 * @throws {ConfigError} when any string references an undeclared binding.
 */
export function resolveMechanics<T>(mechanics: T, resolved: ResolvedData): T {
  return walk(mechanics, resolved) as T;
}

/** The recursive half of `resolveMechanics`, over the JSON-shaped space a mechanics object is. */
function walk(node: unknown, resolved: ResolvedData): unknown {
  if (typeof node === 'string') {
    return substituteInputs(node, resolved);
  }

  if (Array.isArray(node)) {
    return node.map((element) => walk(element, resolved));
  }

  // `typeof null === 'object'`, so the null check is not redundant. Anything that is not a plain
  // object — a number, a boolean, `undefined`, `null` — is returned untouched: a plan is parsed
  // from YAML by a strict zod schema, so no exotic value reaches here, and returning the node as
  // it is keeps this total rather than guessing at something it cannot have.
  if (typeof node === 'object' && node !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      // The KEY is copied verbatim — see the doc comment above.
      out[key] = walk(value, resolved);
    }
    return out;
  }

  return node;
}
