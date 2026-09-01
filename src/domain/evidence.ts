/**
 * AD-10 / FR-28 — typed evidence, with redaction at capture.
 *
 * Two rules govern this file, and both are security controls rather than formatting:
 *
 *  1. **Redaction happens here, at construction, BEFORE anything is persisted.** Render
 *     layers never re-redact — they cannot, because by the time they see an `Evidence`
 *     the secrets are already gone. There is deliberately NO non-redacting path into the
 *     union: every constructor takes RAW strings and returns the typed member, and none
 *     of them accepts a pre-built member, a pre-built `BoundedText`, or an
 *     "already redacted" flag. The only way to skip redaction is to hand-write an object
 *     literal of the interface type, which is a thing a reviewer sees.
 *  2. **`redactText` exists as its own export, and it does not truncate.** The evidence
 *     stored in a run has two copies: the bounded inline one that lives in `result.json`
 *     and the full one written beside it in the run directory. Both are persistence, so
 *     both must be redacted — but only one may be truncated. Exposing only
 *     `boundedText()` (redact + cap) would have left callers with no way to redact the
 *     full copy without also destroying it, so the full file would have carried secrets
 *     verbatim while the seeded-secret test passed green against the inline copy. That is
 *     a test certifying a defect rather than catching it. Callers writing a full copy
 *     MUST pass it through `redactText` first; story 3.4 asserts that on the exact bytes
 *     handed to `RunStore.writeEvidenceFile`.
 *
 * The union is CLOSED and complete on day one — all six AD-10 kinds plus the labeled
 * non-authoritative `explanation` — even though Epic 3 only produces `gate`, `command`
 * and `provider`. Declaring `http`, `browser` and `observation` now costs nothing and
 * means the union is closed once rather than widened three times by three separate
 * stories in three separate branches.
 *
 * AD-1: pure. Imports one sibling domain module (`errors.ts`) and nothing else — no npm
 * package, no node builtin. `TextEncoder`/`TextDecoder` are ECMAScript globals, not
 * imports, and are as pure as `String`.
 */

import { InfraError } from './errors.js';
import type { GateStatus } from './result.js';

/** What replaces a redacted value. One literal, so a reader learns the vocabulary once. */
export const REDACTED = '[REDACTED]';

/**
 * The six evidence kinds (AD-10, Q47). Closed: widening is an ADR, not an edit.
 *
 * Epic 3 produces `gate`, `command` and `provider`; the other three are produced by the
 * surface executors in Epics 4 and 5.
 */
export const EVIDENCE_KINDS = [
  'http',
  'browser',
  'observation',
  'command',
  'gate',
  'provider',
] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * A pointer to a file inside the run directory.
 *
 * `path` is ALWAYS relative to the run-directory root (Q48), because a run directory has
 * to stay readable after being moved or copied between machines — the whole point of
 * storing evidence is that it outlives the terminal it was printed in.
 */
export interface EvidenceRef {
  readonly kind: EvidenceKind;
  /** Relative to the run-directory root, e.g. `evidence/gate-lint.txt`. */
  readonly path: string;
}

const PATH_HINT =
  'evidence paths are relative to the run directory root, e.g. ' +
  "'evidence/gate-lint.txt' — RunStore.writeEvidenceFile returns one in that form";

/**
 * Validates a run-relative path, or throws.
 *
 * Absolute paths, parent escapes and backslash separators are not merely discouraged:
 * they are refused, so a run directory that cannot survive a copy is not constructible.
 * Backslashes are rejected outright rather than normalised — one canonical spelling
 * means `evidence/x.txt` and `evidence\x.txt` can never end up as two different keys in
 * one document, and it also disposes of `C:\...` and `\\server\share` on the way past.
 */
function assertRunRelativePath(path: string): string {
  const fail = (why: string): never => {
    throw new InfraError(`invalid evidence path '${path}': ${why}`, PATH_HINT);
  };

  if (path.trim() === '') {
    return fail('it is empty');
  }
  if (path.includes('\\')) {
    return fail('it uses backslash separators; use forward slashes');
  }
  if (path.startsWith('/')) {
    return fail('it is absolute');
  }
  if (/^[A-Za-z]:/.test(path)) {
    return fail('it is a Windows absolute path');
  }
  const segments = path.split('/');
  if (segments.includes('..')) {
    return fail("it contains a '..' segment and could escape the run directory");
  }

  return path;
}

/** Builds a validated pointer to a file under the run directory. Throws on anything absolute. */
export function evidenceRef(kind: EvidenceKind, path: string): EvidenceRef {
  return { kind, path: assertRunRelativePath(path) };
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

export interface RedactionOptions {
  /**
   * Extra patterns from the Project Config (AD-10: "config-declared extra patterns").
   *
   * Epic 3 wires none — the parameter exists now so that when 4.x needs it there is
   * nowhere new to put it, and no second redaction entry point gets invented. A pattern
   * is applied globally whether or not the caller remembered the `g` flag.
   */
  readonly extraPatterns?: readonly RegExp[];
}

/** Header names whose ENTIRE value is a credential. Compared case-insensitively. */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
]);

/**
 * Header lines in free text: `Authorization: Bearer ...`, `Set-Cookie: ...`.
 *
 * Handled separately from the assignment rule below because a header value legitimately
 * contains spaces (`Bearer abc`), while an env-style value does not - one regex covering
 * both would either stop at the first space and leak the rest, or swallow the whole line.
 *
 * DELIBERATELY NOT ANCHORED TO THE START OF A LINE. Captured gate and probe output is full
 * of wire logs whose header lines carry a prefix: curl's verbose mode writes
 * `> Authorization: Bearer ...` and `< Set-Cookie: ...`, and loggers prepend timestamps.
 * An anchored pattern misses every one of those, and the assignment rule does not catch
 * them either (a header value has spaces in it), so the credential would reach persisted
 * evidence.
 *
 * The lookbehind keeps it from over-matching: the header name must not be preceded by
 * another name character, so `X-Custom-Authorization-Policy` is not treated as an
 * `authorization` header by accident.
 *
 * HOW FAR THE VALUE EXTENDS IS DECIDED IN CODE, NOT IN THE PATTERN, and that is the
 * point of `redactHeaderValue` below. Three attempts to express it as a regex each closed
 * one case and opened another - stopping at the next quote leaked
 * `Cookie: session="secret"; HttpOnly`, requiring a quoted unit leaked a truncated
 * `Authorization: "Bearer secret`, and so on - because the pattern was approximating the
 * question rather than asking it. The real question is not "is there a quote in the
 * value"; it is "was this header written INSIDE a quoted shell argument", and the line
 * prefix answers that exactly.
 */
const SENSITIVE_HEADER_LINE =
  /(?<![A-Za-z0-9_-])(authorization|proxy-authorization|set-cookie|cookie|x-api-key|x-auth-token)[^\S\r\n]*:/gi;

/**
 * Index of the first unescaped `quote` in `text`, or -1.
 *
 * A backslash escapes the character after it. Without this,
 * `curl -H "Authorization: prefix\\"Bearer SECRET" ...` ends the value at the ESCAPED
 * quote, and everything after it - the credential - survives into the persisted command.
 *
 * Backslash escaping is applied inside single quotes too, which POSIX `sh` does not do.
 * The divergence is deliberate and one-directional: in the only case where the two
 * readings differ (an escaped delimiter of the same kind), treating it as escaped means
 * scanning FURTHER and redacting MORE. This is a redactor, not a shell parser; where the
 * two disagree it takes the reading that cannot leak.
 */
function indexOfUnescaped(text: string, quote: string): number {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\\') {
      i += 1;
      continue;
    }
    if (text[i] === quote) {
      return i;
    }
  }
  return -1;
}

/**
 * Redacts every sensitive header value in `raw`.
 *
 * A hand-written scan rather than `String.replace`, for one reason: the extent of a value
 * cannot be expressed in the pattern (see above), so the pattern matches only `name:` and
 * this loop decides how much of what follows to consume. `replace` cannot do that -
 * whatever the pattern matched is what it skips - and an earlier version that captured to
 * end of line therefore examined only the FIRST sensitive header on each line. A wire log
 * has one header per line and hid that completely; a shell command routinely has several,
 * and `curl -H "Authorization: ..." -H "X-Api-Key: ..."` is exactly the shape
 * `displayCommand` was added for. Found by re-reading this code, not by a review.
 *
 * Line ends and quote state are both tracked INCREMENTALLY as the scan advances - never by
 * searching backwards from a match, and never by re-scanning a line that has already been
 * measured. Every character of the input is examined at most a constant number of times,
 * so k headers on a line of length L cost O(L) rather than O(k*L) - the same quadratic
 * trap this file has already paid for once.
 *
 * The extent rules, restated where they are implemented:
 *
 *  - No quote open at the header: the value IS the rest of the line, so all of it goes. A
 *    quote INSIDE an ordinary header value (`Cookie: session="secret"; HttpOnly`) is an
 *    ordinary character, not a terminator.
 *  - A quote open before the name: the value ends at that argument's closing quote, so
 *    `curl -H "Authorization: ..." http://host/health` keeps its URL.
 *  - Opened and never closed - a truncated capture: the whole line. Fail closed.
 *
 * Quote state comes from the ORIGINAL text, including across a region that was redacted,
 * because it is the shell's quoting that decides where an argument ends.
 */
function redactSensitiveHeaders(raw: string): string {
  const pattern = new RegExp(SENSITIVE_HEADER_LINE.source, SENSITIVE_HEADER_LINE.flags);
  let out = '';
  /** How much of `raw` is already copied (or replaced) into `out`. */
  let emitted = 0;
  /** How far the line/quote tracker has consumed. Only ever moves forwards. */
  let scanned = 0;
  let openQuote: string | undefined;
  /**
   * End of the line the scan is currently in (index of its `\n`, or the length).
   *
   * Cached rather than recomputed per match: `indexOf('\n', ...)` from each match would
   * re-scan to the end of the line every time, which is O(k*L) for k headers on a line of
   * length L. V8's character scan is fast enough that it does not show up at realistic
   * sizes - 4000 headers on a 135 KB line measured 8 ms - but "fast enough today" is
   * exactly what the quadratic this file already fixed looked like from the outside.
   * With the cache each line is scanned once, so the total is genuinely linear.
   */
  let lineEnd = -1;

  /** True when the previous character was a backslash, so the next one is escaped. */
  let escaped = false;

  const trackTo = (index: number): void => {
    for (let i = scanned; i < index; i += 1) {
      const character = raw[i];
      if (escaped) {
        // Carried across calls deliberately: `trackTo` is invoked at arbitrary offsets,
        // and a backslash landing on the boundary must still escape what follows it.
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
      } else if (character === '\n') {
        openQuote = undefined;
        escaped = false;
      } else if (character === '"' || character === "'") {
        if (openQuote === character) {
          openQuote = undefined;
        } else if (openQuote === undefined) {
          openQuote = character;
        }
      }
    }
    scanned = index;
  };

  let match = pattern.exec(raw);
  while (match !== null) {
    const start = match.index;
    trackTo(start);

    const name = match[1] as string;
    const valueStart = start + match[0].length;
    if (valueStart > lineEnd) {
      const newline = raw.indexOf('\n', valueStart);
      lineEnd = newline === -1 ? raw.length : newline;
    }
    const value = raw.slice(valueStart, lineEnd);

    let consumed = value.length;
    if (openQuote !== undefined) {
      const closing = indexOfUnescaped(value, openQuote);
      if (closing !== -1) {
        consumed = closing;
      }
    }

    // The header NAME is kept: "an Authorization header was present" is diagnostic, and
    // dropping it would cost information without buying any safety.
    out += `${raw.slice(emitted, start)}${name}: ${REDACTED}`;
    emitted = valueStart + consumed;
    trackTo(emitted);
    pattern.lastIndex = emitted;
    match = pattern.exec(raw);
  }

  return out + raw.slice(emitted);
}

const ASSIGNMENT_VALUE = String.raw`(\[REDACTED\]|"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;)\]}]*)`;

/**
 * A QUOTED name: `"apiKey": "..."`, `'password' = '...'`.
 *
 * Deliberately UNBOUNDED, and safe: `[^"'\r\n]+` cannot match the quote that terminates
 * it, so the engine never backtracks into it - there is exactly one way to match. The
 * bound on the bare form below would be actively harmful here. A JSON key longer than 256
 * characters is unusual but perfectly legal, and with a bound the name could not reach its
 * closing quote, the backreference would fail, and matching could not restart inside the
 * name because a quote is required at the start - so `"<300 chars>_API_KEY":"secret"` would
 * have gone through unredacted. Found by review, after the bound was added.
 */
const QUOTED_ASSIGNMENT = new RegExp(
  String.raw`(["'])([^"'\r\n]+)\1([^\S\r\n]*[:=][^\S\r\n]*)` + ASSIGNMENT_VALUE,
  'g',
);

/**
 * A BARE name: `ANTHROPIC_API_KEY=...`, `password: ...`.
 *
 * This is the one that needs the length bound, because its character class CAN keep
 * consuming past where the match must fail. Quoted names are handled above and never
 * reach here: a bare match starting inside `"foo"` runs into the closing quote where a
 * `[:=]` is required, and fails.
 */
const BARE_ASSIGNMENT = new RegExp(
  String.raw`([A-Za-z_][A-Za-z0-9_.-]{0,255})([^\S\r\n]*[:=][^\S\r\n]*)` + ASSIGNMENT_VALUE,
  'g',
);

/**
 * The trailing name segment that makes an assignment sensitive.
 *
 * A SET of whole segments rather than a substring match, and that choice has teeth in
 * both directions: `ANTHROPIC_API_KEY` redacts (last segment `key`) while `MONKEY` does
 * not (last segment `monkey`). A too-eager redactor produces evidence nobody can read,
 * and people respond to unreadable evidence by opening the unredacted file — which is
 * strictly worse than a narrower rule.
 */
const SENSITIVE_SEGMENTS = new Set([
  'key',
  'keys',
  'apikey',
  'token',
  'tokens',
  'secret',
  'secrets',
  'cookie',
  'cookies',
  'authorization',
  'password',
  'passwords',
  'passwd',
  'passphrase',
  'credential',
  'credentials',
  'auth',
]);

/** Splits `ANTHROPIC_API_KEY` / `apiKey` / `db-credentials` into lowercase words. */
function nameSegments(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((segment) => segment !== '')
    .map((segment) => segment.toLowerCase());
}

function isSensitiveName(name: string): boolean {
  const last = nameSegments(name).at(-1);
  return last !== undefined && SENSITIVE_SEGMENTS.has(last);
}

/**
 * Redacts secrets from free text WITHOUT truncating it.
 *
 * This is the function that must be applied to anything about to be written to a file.
 * `boundedText` is exactly this followed by a byte cap.
 *
 * Idempotent: `[REDACTED]` contains no sensitive assignment, so redacting twice is the
 * same as redacting once — which matters because evidence gets copied between fields.
 */
export function redactText(raw: string, options?: RedactionOptions): string {
  let text = redactSensitiveHeaders(raw);

  const rewrite = (quote: string, name: string, separator: string, value: string): string => {
    const quoted = value.startsWith('"') || value.startsWith("'");
    const wrapper = quoted ? (value[0] as string) : '';

    if (!isSensitiveName(name)) {
      if (!quoted) {
        return `${quote}${name}${quote}${separator}${value}`;
      }
      // A QUOTED value is consumed whole by the match, so a sensitive assignment nested
      // inside an innocent one — `{"note":"ANTHROPIC_API_KEY=…"}` — would never be
      // examined at all: the scan resumes past the closing quote. Recursing into the
      // inner text closes that hole. It terminates because the inner string is strictly
      // shorter than the value it came from.
      return `${quote}${name}${quote}${separator}${wrapper}${redactText(value.slice(1, -1), options)}${wrapper}`;
    }

    return `${quote}${name}${quote}${separator}${wrapper}${REDACTED}${wrapper}`;
  };

  // Quoted names first, then bare ones. Two passes rather than one alternation because
  // the two forms need different safety properties: the quoted name must be unbounded
  // (a long JSON key is legal) and is safe unbounded, while the bare name must be bounded
  // and cannot be safe otherwise.
  text = text.replace(
    QUOTED_ASSIGNMENT,
    (_match, quote: string, name: string, separator: string, value: string) =>
      rewrite(quote, name, separator, value),
  );

  text = text.replace(
    BARE_ASSIGNMENT,
    (_match, name: string, separator: string, value: string) =>
      rewrite('', name, separator, value),
  );

  for (const pattern of options?.extraPatterns ?? []) {
    // Rebuilt with `g` and with a fresh `lastIndex`: a caller's `/x/g` carries mutable
    // state between calls, so reusing it as given would silently skip matches on the
    // second string it ever saw.
    const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    text = text.replace(global, REDACTED);
  }

  return text;
}

/** Redacts a header map: sensitive names lose their value entirely, the rest pass through. */
export function redactHeaders(
  headers: Readonly<Record<string, string>>,
  options?: RedactionOptions,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name] =
      SENSITIVE_HEADERS.has(name.toLowerCase()) || isSensitiveName(name)
        ? REDACTED
        : redactText(value, options);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Bounded inline content
// ---------------------------------------------------------------------------

/**
 * The inline size cap, in BYTES (Q49, AD-11: "terminal output is bounded").
 *
 * Bytes rather than characters because the two diverge the moment a gate prints anything
 * non-ASCII, and the thing actually being bounded is how much of a report an agent has to
 * read and how large `result.json` grows.
 */
export const EVIDENCE_INLINE_CAP_BYTES = 8192;

/**
 * Redacted, size-bounded content, with a pointer to the full file when there is one.
 *
 * `text` is final: already redacted, already truncated. A renderer prints it as-is and
 * appends `truncationMarker(bounded)`; it never re-redacts, re-truncates, or reads the
 * file to show more (AD-10, AD-11).
 */
export interface BoundedText {
  readonly text: string;
  readonly truncated: boolean;
  /**
   * Byte length of the REDACTED text before truncation — i.e. of exactly the bytes the
   * full file contains, since that file is redacted too. Reporting the raw length would
   * describe a document nobody is allowed to store.
   */
  readonly totalBytes: number;
  /** Relative path to the full content. Present only when `truncated`. */
  readonly fullPath?: string;
}

export interface BoundedTextOptions extends RedactionOptions {
  /** Defaults to `EVIDENCE_INLINE_CAP_BYTES`. */
  readonly capBytes?: number;
  /** Run-relative path of the full copy. Validated like an `EvidenceRef` path. */
  readonly fullPath?: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Truncates to at most `capBytes` UTF-8 bytes without splitting a character.
 *
 * The walk-back matters: a naive `bytes.slice(0, cap)` can cut a multi-byte character in
 * half, and the half decodes to U+FFFD — a character the process under test never
 * printed, in a record whose only value is being faithful.
 */
function truncateToBytes(text: string, capBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.length <= capBytes) {
    return text;
  }

  let end = capBytes;
  // A continuation byte is 0b10xxxxxx. While the first EXCLUDED byte is one, the
  // character starting earlier is being split, so step back to its lead byte.
  while (end > 0 && ((bytes[end] ?? 0) & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }

  return decoder.decode(bytes.subarray(0, end));
}

/** Redacts, then caps. The only way to build inline evidence content. */
export function boundedText(raw: string, options?: BoundedTextOptions): BoundedText {
  const capBytes = options?.capBytes ?? EVIDENCE_INLINE_CAP_BYTES;
  const redacted = redactText(raw, options);
  const totalBytes = encoder.encode(redacted).length;
  const truncated = totalBytes > capBytes;
  const text = truncated ? truncateToBytes(redacted, capBytes) : redacted;

  // Validated even when unused, so an absolute path is refused at the point somebody
  // wrote it rather than at the point it happens to be long enough to matter.
  const fullPath = options?.fullPath === undefined ? undefined : assertRunRelativePath(options.fullPath);

  return truncated && fullPath !== undefined
    ? { text, truncated, totalBytes, fullPath }
    : { text, truncated, totalBytes };
}

/**
 * The one truncation marker format (Q49). Renderers print this and define no second cap.
 *
 * Empty string for untruncated content, so a renderer can append it unconditionally
 * rather than branching — one less place for the two views to disagree.
 */
export function truncationMarker(bounded: BoundedText): string {
  if (!bounded.truncated) {
    return '';
  }
  const shown = encoder.encode(bounded.text).length;
  const head = `… truncated: ${shown} of ${bounded.totalBytes} bytes shown`;
  return bounded.fullPath === undefined ? head : `${head}; full output at ${bounded.fullPath}`;
}

// ---------------------------------------------------------------------------
// The closed union
// ---------------------------------------------------------------------------

/**
 * Fields every member carries.
 *
 * `explanation` is AD-10's labeled NON-AUTHORITATIVE field: the only place free-form
 * model prose may appear in a run. Nothing mechanical ever reads it — no verdict, no
 * classification, no count depends on it — and it is redacted like everything else,
 * because it is persisted and rendered like everything else.
 */
interface EvidenceCommon {
  /** ISO-8601 UTC, from the injected `Clock` (AD-9). The producer passes it in. */
  readonly capturedAt: string;
  readonly durationMs: number;
  readonly explanation?: string;
}

export interface HttpRequestRecord {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface HttpResponseRecord {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: BoundedText;
}

/** Produced by the http surface executor (Epic 4). */
export interface HttpEvidence extends EvidenceCommon {
  readonly kind: 'http';
  readonly request: HttpRequestRecord;
  readonly response: HttpResponseRecord;
}

/** Produced by the browser surface executor (Epic 5). Trace and screenshot are refs, not inline blobs. */
export interface BrowserEvidence extends EvidenceCommon {
  readonly kind: 'browser';
  readonly url: string;
  readonly trace?: EvidenceRef;
  readonly screenshot?: EvidenceRef;
}

/** Produced by the observation surface executor (Epic 4). */
export interface ObservationEvidence extends EvidenceCommon {
  readonly kind: 'observation';
  readonly observationId: string;
  readonly snapshot: BoundedText;
}

/** Produced by the shell surface executor and the data stage (Epic 4). */
export interface CommandEvidence extends EvidenceCommon {
  readonly kind: 'command';
  readonly commandId: string;
  /**
   * The command as declared, for display only.
   *
   * A `DeclaredCommand` rendered through `commandText()` — the permitted direction. It is
   * never parsed back, never executed from here, and it is redacted like any other text
   * because a declared command can carry a `--password=` flag.
   */
  readonly displayCommand: string;
  /** `null` when the process was killed or never started. */
  readonly exitCode: number | null;
  readonly stdout: BoundedText;
  readonly stderr: BoundedText;
}

/** Produced by the gates stage (story 3.4). Only for gates that actually RAN. */
export interface GateEvidence extends EvidenceCommon {
  readonly kind: 'gate';
  readonly gateId: string;
  /**
   * The gate's command as the Project Config declared it, for display only.
   *
   * REQUIRED, not optional, and that is the point of it: the only producer is the gates
   * stage, every executed gate has a command, and an optional field is one a caller can
   * skip on the run where it mattered.
   *
   * Without it a run directory is not a self-contained record. A reader six months later
   * has `gateId: 'lint'` and 8 KB of output, and to learn what actually ran must recover
   * the config as it was AT THAT REVISION - worst for the failing gate, which is the one
   * anybody opens the record to understand. `CommandEvidence` already carried this, so
   * its absence here was an asymmetry rather than a decision.
   *
   * A `DeclaredCommand` rendered through `commandText()` - the permitted direction. It is
   * never parsed back and never executed from here, and it is redacted like any other
   * string: a declared command can legitimately carry a credential, e.g.
   * `curl -H "Authorization: Bearer ..."` used as a smoke gate.
   */
  readonly displayCommand: string;
  readonly status: GateStatus;
  readonly exitCode: number | null;
  readonly stdout: BoundedText;
  readonly stderr: BoundedText;
}

/** Produced by provider delegation (Epic 2's authoring flows; never on the verify path). */
export interface ProviderEvidence extends EvidenceCommon {
  readonly kind: 'provider';
  readonly role: string;
  readonly provider: string;
  readonly attempts: number;
  readonly rawResponse: BoundedText;
}

/**
 * The closed evidence union (AD-10, Q47).
 *
 * This — not `EvidenceRef` — is what a `RunResult` carries. A run holding only refs would
 * discard the redacted, bounded content at the moment it was constructed, and a renderer
 * whose signature is `(result: RunResult) => string` would then have a path and no text:
 * it could only show the content by reading the file, which AD-11 forbids and its
 * signature makes impossible. `EvidenceRef` is the validated pointer INSIDE a member.
 */
export type Evidence =
  | HttpEvidence
  | BrowserEvidence
  | ObservationEvidence
  | CommandEvidence
  | GateEvidence
  | ProviderEvidence;

// ---------------------------------------------------------------------------
// The redacting constructors
// ---------------------------------------------------------------------------

/**
 * Builds the options for ONE bounded stream of a two-stream member.
 *
 * `options.fullPath` is deliberately not inherited: gate and command evidence carry two
 * independent streams, and handing both the same pointer makes each truncation marker
 * claim that its own distinct content lives in the other one's file. Callers name the
 * streams separately on the INPUT (`stdoutFullPath` / `stderrFullPath`), where they
 * already know which gate the file belongs to.
 */
function streamOptions(
  options: BoundedTextOptions | undefined,
  fullPath: string | undefined,
): BoundedTextOptions {
  return {
    ...(options?.capBytes === undefined ? {} : { capBytes: options.capBytes }),
    ...(options?.extraPatterns === undefined ? {} : { extraPatterns: options.extraPatterns }),
    ...(fullPath === undefined ? {} : { fullPath }),
  };
}

/**
 * Refuses a single `fullPath` on a two-stream constructor rather than silently ignoring
 * it. A caller who passes one has a specific, wrong belief about where their output was
 * written, and a truncation marker that points at the wrong file is worse than one that
 * points nowhere: someone opens it and reads another stream's content as this one's.
 */
function rejectAmbiguousFullPath(options: BoundedTextOptions | undefined, member: string): void {
  if (options?.fullPath !== undefined) {
    throw new InfraError(
      `${member} carries two streams, so a single fullPath ('${options.fullPath}') is ambiguous`,
      'name the streams separately with stdoutFullPath and stderrFullPath on the input',
    );
  }
}

/** Redacts an optional explanation, preserving "absent" rather than turning it into ''. */
function redactedExplanation(
  explanation: string | undefined,
  options: BoundedTextOptions | undefined,
): { explanation?: string } {
  return explanation === undefined ? {} : { explanation: redactText(explanation, options) };
}

export interface GateEvidenceInput {
  readonly capturedAt: string;
  readonly gateId: string;
  /** RAW command text from `commandText()`. It is redacted here. */
  readonly displayCommand: string;
  readonly status: GateStatus;
  readonly exitCode: number | null;
  /** RAW output. It is redacted and bounded here. */
  readonly stdout: string;
  /** RAW output. It is redacted and bounded here. */
  readonly stderr: string;
  /** Run-relative path of the FULL redacted stdout, when one was written. */
  readonly stdoutFullPath?: string;
  /** Run-relative path of the FULL redacted stderr — a different file from stdout's. */
  readonly stderrFullPath?: string;
  readonly durationMs: number;
  readonly explanation?: string;
}

export function gateEvidence(input: GateEvidenceInput, options?: BoundedTextOptions): GateEvidence {
  rejectAmbiguousFullPath(options, 'gate evidence');
  return {
    kind: 'gate',
    capturedAt: input.capturedAt,
    gateId: input.gateId,
    displayCommand: redactText(input.displayCommand, options),
    status: input.status,
    exitCode: input.exitCode,
    stdout: boundedText(input.stdout, streamOptions(options, input.stdoutFullPath)),
    stderr: boundedText(input.stderr, streamOptions(options, input.stderrFullPath)),
    durationMs: input.durationMs,
    ...redactedExplanation(input.explanation, options),
  };
}

export interface CommandEvidenceInput {
  readonly capturedAt: string;
  readonly commandId: string;
  readonly displayCommand: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Run-relative path of the FULL redacted stdout, when one was written. */
  readonly stdoutFullPath?: string;
  /** Run-relative path of the FULL redacted stderr — a different file from stdout's. */
  readonly stderrFullPath?: string;
  readonly durationMs: number;
  readonly explanation?: string;
}

export function commandEvidence(
  input: CommandEvidenceInput,
  options?: BoundedTextOptions,
): CommandEvidence {
  rejectAmbiguousFullPath(options, 'command evidence');
  return {
    kind: 'command',
    capturedAt: input.capturedAt,
    commandId: input.commandId,
    displayCommand: redactText(input.displayCommand, options),
    exitCode: input.exitCode,
    stdout: boundedText(input.stdout, streamOptions(options, input.stdoutFullPath)),
    stderr: boundedText(input.stderr, streamOptions(options, input.stderrFullPath)),
    durationMs: input.durationMs,
    ...redactedExplanation(input.explanation, options),
  };
}

export interface ProviderEvidenceInput {
  readonly capturedAt: string;
  readonly role: string;
  readonly provider: string;
  readonly attempts: number;
  readonly rawResponse: string;
  readonly durationMs: number;
  readonly explanation?: string;
}

export function providerEvidence(
  input: ProviderEvidenceInput,
  options?: BoundedTextOptions,
): ProviderEvidence {
  return {
    kind: 'provider',
    capturedAt: input.capturedAt,
    role: input.role,
    provider: input.provider,
    attempts: input.attempts,
    rawResponse: boundedText(input.rawResponse, options),
    durationMs: input.durationMs,
    ...redactedExplanation(input.explanation, options),
  };
}

export interface HttpEvidenceInput {
  readonly capturedAt: string;
  readonly method: string;
  readonly url: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly status: number;
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly body: string;
  readonly durationMs: number;
  readonly explanation?: string;
}

export function httpEvidence(input: HttpEvidenceInput, options?: BoundedTextOptions): HttpEvidence {
  return {
    kind: 'http',
    capturedAt: input.capturedAt,
    request: {
      method: input.method,
      url: redactText(input.url, options),
      headers: redactHeaders(input.requestHeaders, options),
    },
    response: {
      status: input.status,
      headers: redactHeaders(input.responseHeaders, options),
      body: boundedText(input.body, options),
    },
    durationMs: input.durationMs,
    ...redactedExplanation(input.explanation, options),
  };
}

export interface ObservationEvidenceInput {
  readonly capturedAt: string;
  readonly observationId: string;
  readonly snapshot: string;
  readonly durationMs: number;
  readonly explanation?: string;
}

export function observationEvidence(
  input: ObservationEvidenceInput,
  options?: BoundedTextOptions,
): ObservationEvidence {
  return {
    kind: 'observation',
    capturedAt: input.capturedAt,
    observationId: input.observationId,
    snapshot: boundedText(input.snapshot, options),
    durationMs: input.durationMs,
    ...redactedExplanation(input.explanation, options),
  };
}

export interface BrowserEvidenceInput {
  readonly capturedAt: string;
  readonly url: string;
  /** Run-relative path; validated here, so an absolute trace path is not constructible. */
  readonly trace?: string;
  /** Run-relative path; validated here. */
  readonly screenshot?: string;
  readonly durationMs: number;
  readonly explanation?: string;
}

export function browserEvidence(
  input: BrowserEvidenceInput,
  options?: BoundedTextOptions,
): BrowserEvidence {
  return {
    kind: 'browser',
    capturedAt: input.capturedAt,
    url: redactText(input.url, options),
    ...(input.trace === undefined ? {} : { trace: evidenceRef('browser', input.trace) }),
    ...(input.screenshot === undefined
      ? {}
      : { screenshot: evidenceRef('browser', input.screenshot) }),
    durationMs: input.durationMs,
    ...redactedExplanation(input.explanation, options),
  };
}
