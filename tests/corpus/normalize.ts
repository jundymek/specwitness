/**
 * Normalisation for the Golden Verification Corpus.
 *
 * A corpus fixture must assert on STABLE facts and never on incidental ones. Run ids,
 * timestamps, durations, absolute paths, ephemeral ports and commit shas differ on every
 * run; a fixture that pinned one would fail on Tuesday, and a corpus that fails for reasons
 * nobody believes is a corpus the third person to meet it disables.
 *
 * ⚠️ **WHAT THIS MODULE IS AND IS NOT ALLOWED TO TOUCH — the mirror-image failure.**
 * Normalising too hard swallows a real difference, which is worse than normalising too
 * little because nothing goes red. Two rules keep that closed, and both are structural:
 *
 *  1. **The assertion path does not run through the normaliser.** `expected.json` pins the
 *     exit code, the outcome object and criterion statuses, and the runner compares those
 *     RAW. Normalisation is applied to (a) the text rendered into a failure diff, and
 *     (b) the stderr/stdout text a fixture matches substrings against. A verdict, a
 *     criterion id and a criterion status therefore cannot be normalised away, because they
 *     are never handed to this module on the path that decides pass or fail.
 *  2. **Every replacement is anchored to a SHAPE, never to a value that could be product
 *     output.** `<RUN-ID>` matches the `run-<YYYYMMDDTHHmmssZ>-<4 base36>` shape from
 *     `src/domain/run-id.ts` and nothing else; `<SHA>` requires exactly 40 hex characters,
 *     so a criterion id, a gate id or a verdict can never match one.
 *
 * `tests/unit/corpus/normalize.test.ts` pins BOTH directions: that each volatile shape is
 * replaced, and that documents differing in a REAL way still differ after normalisation.
 */

/** `run-<YYYYMMDDTHHmmssZ>-<4 lowercase base36>` — the shape `src/domain/run-id.ts` mints. */
const RUN_ID = /run-\d{8}T\d{6}Z-[0-9a-z]{4}/g;

/** ISO-8601 UTC, the only timestamp form this product emits (Conventions). */
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z/g;

/** A full git object id. Exactly 40 hex: an abbreviation is not matched, deliberately. */
const FULL_SHA = /\b[0-9a-f]{40}\b/g;

export interface NormalizerInput {
  /**
   * Absolute paths that should read as a placeholder, longest first at application time.
   *
   * Keyed by the placeholder to substitute, e.g. `{ '<WORKSPACE>': '/tmp/sw-corpus-a1b2' }`.
   */
  readonly paths: Readonly<Record<string, string>>;
  /** Ephemeral ports allocated for this fixture, keyed by the name used in the config. */
  readonly ports: Readonly<Record<string, number>>;
}

export interface Normalizer {
  /** Replaces every volatile shape in `text`. Pure; the same input always gives the same output. */
  normalizeText(text: string): string;
  /**
   * Normalises a parsed JSON document for DISPLAY in a failure diff.
   *
   * Strings go through `normalizeText`; numeric duration fields become `<DURATION>` because
   * a millisecond count is never a stable fact. Nothing else is rewritten: keys are
   * untouched, arrays keep their order and length, and no key is dropped — a diff that
   * hides a key is a diff that hides a defect.
   */
  normalizeDocument(value: unknown): unknown;
}

/** Field names whose numeric values are wall-clock measurements rather than facts. */
const DURATION_KEYS = new Set(['durationMs', 'elapsedMs', 'waitedMs']);

/**
 * Escapes a literal string for use inside a `RegExp`.
 *
 * Paths on macOS routinely contain `+` and `.`; a temp directory name is chosen by the OS
 * and is not ours to assume anything about.
 */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createNormalizer(input: NormalizerInput): Normalizer {
  // Longest path first. `/tmp/x/worktree` must be replaced before `/tmp/x`, or the tail of
  // the longer path survives as a fragment glued to a placeholder and the output is a lie
  // that still looks normalised.
  const pathEntries = Object.entries(input.paths).sort(
    ([, a], [, b]) => b.length - a.length,
  );

  const portEntries = Object.entries(input.ports);

  const normalizeText = (text: string): string => {
    let out = text;

    for (const [placeholder, absolute] of pathEntries) {
      out = out.replaceAll(absolute, placeholder);
    }

    for (const [name, port] of portEntries) {
      // Bounded by non-digits so port 4500 does not rewrite the middle of 145002. A port
      // is always adjacent to `:` or whitespace or a quote in real output.
      out = out.replace(new RegExp(`(?<!\\d)${escapeRegExp(String(port))}(?!\\d)`, 'g'), `<PORT:${name}>`);
    }

    out = out.replace(RUN_ID, '<RUN-ID>');
    out = out.replace(FULL_SHA, '<SHA>');
    out = out.replace(ISO_TIMESTAMP, '<TIMESTAMP>');

    return out;
  };

  const normalizeDocument = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return normalizeText(value);
    }
    if (Array.isArray(value)) {
      return value.map((entry) => normalizeDocument(entry));
    }
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        out[key] =
          DURATION_KEYS.has(key) && typeof entry === 'number'
            ? '<DURATION>'
            : normalizeDocument(entry);
      }
      return out;
    }
    return value;
  };

  return { normalizeText, normalizeDocument };
}
