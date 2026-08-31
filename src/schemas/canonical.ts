/**
 * AD-5 — the canonical serializer and the contract fingerprint.
 *
 * THE single implementation of a contract content hash. The spine names this
 * file by path, and nothing else in the codebase may compute one: two hashing
 * implementations means two answers to "has this contract changed", and the
 * whole product rests on there being exactly one.
 *
 * What is hashed: the `spec` block, and only the `spec` block. That is enforced
 * structurally rather than by convention — `canonicalize` and `fingerprint`
 * take a `ContractSpec`, so `meta` is not representable in their input. Writing
 * `meta.fingerprint` therefore cannot change the thing the fingerprint
 * describes (the self-reference bug), and neither appending an amendment
 * history entry nor recording which model drafted the text can look like a
 * tamper.
 *
 * Canonical form, in order of application:
 *   1. object keys sorted ascending by UTF-16 code unit (`Array#sort`'s default
 *      on strings) — recursively;
 *   2. array order PRESERVED — criterion order is content, not presentation;
 *   3. string values trimmed at the ends only;
 *   4. members whose value is `undefined` dropped, so present-as-undefined and
 *      absent produce identical bytes;
 *   5. `JSON.stringify` with no indentation, no trailing newline.
 * The fingerprint is SHA-256 over the UTF-8 bytes of that text, lowercase hex.
 *
 * Two decisions that must be deliberate rather than accidental:
 *
 * - **No Unicode normalization.** `café` in NFC and in NFD render identically
 *   and are different bytes, and they get different fingerprints. That is
 *   correct: the contract records what a human wrote, and silently folding one
 *   form into the other would be the tool changing the content. The cost is a
 *   confusing-looking integrity error if an editor rewrites the encoding of a
 *   file; the alternative is the tool quietly editing expectations, which is
 *   the failure this module exists to prevent.
 *
 * - **Trim is ends-only.** Internal newlines and internal indentation inside a
 *   multi-line statement survive untouched. AD-5's "trimmed strings" is about
 *   YAML's habit of leaving whitespace on the ends of scalars; applying it any
 *   further would rewrite a human's stated expectation.
 *
 * AD-1: this module may import `src/domain/**`, its own siblings, and
 * `node:crypto` — the last via a narrowly scoped carve-out in
 * `.dependency-cruiser.cjs` added by this story and pinned in both directions
 * by `tests/unit/dependency-rules.test.ts`. Hashing is pure computation; there
 * is no I/O, no clock and no randomness anywhere in this file.
 */

import { createHash } from 'node:crypto';

import type { ContractSpec } from '../domain/contract.js';

/**
 * A value that survives canonicalization.
 *
 * Deliberately narrow: anything outside it (a function, a symbol, a `Date`, a
 * `Map`) is refused loudly rather than being dropped or coerced. Silent
 * coercion is how two different specs end up with the same fingerprint.
 */
type Canonical = string | number | boolean | null | Canonical[] | { [key: string]: Canonical };

/**
 * Recursively rewrites a value into canonical form.
 *
 * `path` is threaded purely so a refusal can name the offending member — a
 * message saying "version is not finite" is worth far more than "invalid
 * input" when the input is a file somebody hand-edited.
 */
function normalize(value: unknown, path: string): Canonical {
  if (value === null) {
    return null;
  }

  switch (typeof value) {
    case 'string':
      // Ends only. See the module header.
      return value.trim();

    case 'number':
      if (!Number.isFinite(value)) {
        // `JSON.stringify` would write `null` here, which hashes as a real
        // value — so NaN and Infinity would collide with each other and with a
        // genuine null. Refuse instead.
        throw new TypeError(
          `cannot canonicalize ${path}: ${String(value)} is not a finite number`,
        );
      }
      return value;

    case 'boolean':
      return value;

    case 'object': {
      if (Array.isArray(value)) {
        // Order preserved. Indices are part of the path so a bad member inside
        // a long criteria list is findable.
        return value.map((item, index) => normalize(item, `${path}[${index}]`));
      }

      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
        // A Date, Map, Set or class instance would be stringified by whatever
        // `toJSON` it happens to carry — a hash that depends on a library's
        // serialization habits is not a hash of the content.
        throw new TypeError(
          `cannot canonicalize ${path}: expected a plain object, got ${value.constructor?.name ?? 'a non-plain object'}`,
        );
      }

      const source = value as Record<string, unknown>;
      const result: Record<string, Canonical> = {};
      // Sorting here — rather than relying on insertion order — is the whole
      // point: two callers building the same content in different orders must
      // produce the same bytes.
      for (const key of Object.keys(source).sort()) {
        const member = source[key];
        if (member === undefined) {
          // Absent and present-as-undefined must hash alike.
          continue;
        }
        result[key] = normalize(member, path === '' ? key : `${path}.${key}`);
      }
      return result;
    }

    default:
      // undefined at the root, function, symbol, bigint.
      throw new TypeError(
        `cannot canonicalize ${path || '<root>'}: values of type ${typeof value} have no canonical form`,
      );
  }
}

/**
 * The canonical JSON text of a contract's `spec` block.
 *
 * Exported in its own right because a fingerprint mismatch is much easier to
 * diagnose when you can print both sides and diff them — and because the tests
 * assert on the exact bytes, not merely on the hash agreeing with itself.
 */
export function canonicalize(spec: ContractSpec): string {
  return JSON.stringify(normalize(spec, ''));
}

/**
 * SHA-256 of the canonical `spec`, lowercase hex.
 *
 * Takes a `ContractSpec` and not a `Contract`, on purpose: it is what makes
 * "meta is never fingerprinted" a property of the type system rather than a
 * rule someone has to remember during a refactor.
 *
 * The fingerprint is not a secret. It is printed to stdout by `contract
 * --freeze` by design, and it is tamper-EVIDENT rather than tamper-proof
 * (ADR-005): it proves that content changed, not who changed it.
 */
export function fingerprint(spec: ContractSpec): string {
  return createHash('sha256').update(canonicalize(spec), 'utf8').digest('hex');
}
