/**
 * The `file` surface executor — story 7.8, ADR-009.
 *
 * A reader of the checked-out tree under verification. It answers static questions — does a
 * path exist, what does a file say, how often does a literal occur, what does a JSON file
 * hold — and it answers them WITHOUT RUNNING ANYTHING. There is no process runner in this
 * module's dependencies and no way to hand it one (`FileExecutorDeps` has no such field);
 * `tests/unit/surfaces/file-spawns-nothing.test.ts` walks this file's runtime imports and
 * proves nothing reachable from here can spawn a process or open a socket.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 *
 * The first client project needed 645 lines of hand-written Node before a plan had anything
 * to probe, and three of the second dogfooding run's eight failures were defects in that
 * code — every one in generic file-reading logic a product would have written once:
 *
 *  1. a directory walk that did not recurse, so a report two directories deeper than the
 *     search looked was reported missing;
 *  2. hand-picked regular expressions that missed the document satisfying the criterion,
 *     because it used other words;
 *  3. a census that counted a forbidden spelling inside COMMENTS and inside the very test
 *     that enforced the convention — reporting 2 where the criterion required 0.
 *
 * This file is where those are written once: `**` recursion, literal case-foldable
 * matching, comment-aware counting and exclusions. It cannot solve the second defect in
 * general — no matcher knows the words an author will choose — and it does not pretend to.
 *
 * ============================================================================
 * THE RULE A CARELESS IMPLEMENTATION BREAKS: NOTHING OUTSIDE THE WORKTREE IS READ
 * ============================================================================
 *
 * The surface takes DATA rather than a command id precisely so that nothing a provider
 * writes can become an executable string. A path that escaped the worktree would reopen that
 * door from the other side — `../../.ssh/id_ed25519` is data too. So, before any read:
 *
 *  - the pattern is checked by `domain/tree-path.ts`, the same function the plan schema
 *    uses: no `..`, no absolute path, no drive letter, no `~`;
 *  - the worktree root is `realpath`-ed once, and every path is resolved segment by segment
 *    from it with `lstat`. A SYMLINK anywhere on the way is resolved and must land inside
 *    the root — a dangling one is judged by where its text points, since it cannot be
 *    resolved. This is the check only the executor can make: whether `docs/vendor` leaves
 *    the tree is a fact about the branch under verification, not about the plan;
 *  - a read opens the resolved real path with `O_NOFOLLOW`, so the last component cannot
 *    have been swapped for a link since it was checked.
 *
 * An escape is an `InfraError` (exit 3) and never a product FAIL: SpecWitness could not
 * perform the read, so nothing was adjudicated. The same stance as the browser surface's
 * origin re-check after every navigation, one surface over.
 *
 * ============================================================================
 * ABSENCE, EXCEPTION, AND WHICH IS WHICH (ADR-009 §5, story 7.5's rule)
 * ============================================================================
 *
 *  - A missing path read as EXISTENCE (`exists`, `fileCount`) is a value — `false`, `0` —
 *    and compares like any other value.
 *  - A missing path read for CONTENT is unsatisfied for every comparison, the negative ones
 *    included: `notContains "TODO"` on a file that is not there has not been met.
 *  - A path that could not be READ — a permission error, a directory where a file was
 *    named, a file that is not UTF-8, JSON that does not parse, a walk past its bound —
 *    is an `execError`. The probe could not look; that is not the same as looking and
 *    finding nothing, and conflating the two is how a broken environment reads as a
 *    passing branch.
 *
 * AD-13: this is a new READER, not a second adjudicator. It returns a `ProbeAttempt` with
 * one evaluation per assertion and no status; `domain/criterion-result.ts` decides.
 *
 * AD-1: an adapter. Imports domain, its sibling `observation.ts` (whose JSON accessor it
 * shares, so a plan's `jsonPath` means one thing on both surfaces), and node builtins.
 */

import { createHash } from 'node:crypto';
import { constants, type Dirent, type Stats } from 'node:fs';
import { lstat, open, readdir, readlink, realpath, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import type {
  AssertionEvaluation,
  Observation,
  ProbeAttempt,
  ProbeExecError,
  ProbeRequest,
  SurfaceExecutor,
} from '../domain/criterion-result.js';
import { InfraError } from '../domain/errors.js';
import {
  evidenceRef,
  observationEvidence,
  redactText,
  type Evidence,
  type EvidenceRef,
  type RedactionOptions,
} from '../domain/evidence.js';
import {
  ASSERTION_COMPARISONS,
  FILE_COMMENT_SYNTAXES,
  type AssertionComparison,
  type FileAssertionTarget,
  type FileCommentSyntax,
} from '../domain/plan.js';
import type { Clock } from '../domain/ports.js';
import { isTreeGlob, treePatternProblem } from '../domain/tree-path.js';
import { compare, discriminator, readPath, slugify } from './observation.js';

/**
 * The bounds on one probe's read. Each is an `execError` when exceeded, never a partial
 * answer: a count over the first ten thousand files is a count of something the plan did
 * not ask about, and it would be wrong in exactly the direction that passes.
 */
export interface FileReadLimits {
  /** Regular files one pattern may select. */
  readonly maxFiles: number;
  /** Directory entries one probe may list while matching, so `**` cannot walk forever. */
  readonly maxEntries: number;
  /** Size of one file, in bytes. A read never truncates. */
  readonly maxFileBytes: number;
}

export const FILE_READ_LIMITS: FileReadLimits = Object.freeze({
  maxFiles: 10_000,
  maxEntries: 200_000,
  maxFileBytes: 8 * 1024 * 1024,
});

export interface FileExecutorDeps {
  readonly clock: Clock;
  /**
   * The verification worktree — the dispatcher's `cwd`. The only directory this executor
   * will read beneath; `realpath`-ed once per attempt, and every read is confined to it.
   */
  readonly root: string;
  /** `RunStore.writeEvidenceFile`, run id applied. Returns the run-relative path. */
  readonly writeEvidence: (relativeName: string, contents: string) => Promise<string>;
  /** The run's evidence accumulator, bound by the probes stage. */
  readonly recordEvidence: (evidence: Evidence) => void;
  /** Config-declared extra redaction patterns (AD-10). */
  readonly redaction?: RedactionOptions;
  /** Tests narrow these; production uses `FILE_READ_LIMITS`. */
  readonly limits?: Partial<FileReadLimits>;
}

const EVIDENCE_DIR = 'evidence';

/** How much of a file's text an `actual` carries. The text itself is in the worktree. */
const CONTENT_ACTUAL_MAX_CHARS = 4_000;

/**
 * Directory names a WILDCARD never enters: the repository's own metadata, and installed
 * dependencies. The first is not the tree under verification; the second is somebody
 * else's code, and counting in it would make every census about the lockfile. A LITERAL
 * path may still name either — the operator asked for it by name.
 */
const NEVER_WALKED = new Set(['.git', 'node_modules']);

const PARAMS_HINT =
  'this is a wiring defect in SpecWitness or a hand-edited plan file, not a failure of the ' +
  'branch under verification — regenerate the plan with `specwitness plan <epic>` and rerun';

const PATH_HINT =
  'a file probe reads only the checked-out tree under verification. Write the path relative ' +
  "to the repository root in .specwitness/plans/<epic>.yaml, with no '..' and nothing absolute";

const ESCAPE_HINT =
  'a symbolic link in the branch under verification points outside the repository, and ' +
  'SpecWitness does not follow it: nothing was read and nothing was adjudicated. Point the ' +
  'probe at the real file inside the repository, or remove the link';

const UNREADABLE_HINT =
  'SpecWitness could not read the tree to decide this assertion, so it reports an error ' +
  'rather than a result. Fix the file, or narrow the probe to the files it means to read';

function malformed(what: string): never {
  throw new InfraError(`file probe params are malformed: ${what}`, PARAMS_HINT);
}

/**
 * The probe could not read what it was asked to read. Becomes an `execError` in `execute`;
 * never escapes this module. A tagged class rather than a message match, so an `InfraError`
 * can never be caught by mistake on its way out.
 */
class Unreadable extends Error {
  constructor(
    message: string,
    readonly hint: string = UNREADABLE_HINT,
  ) {
    super(message);
  }
}

function codeOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error as { code: unknown };
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function isMissing(error: unknown): boolean {
  const code = codeOf(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function unreadable(what: string, error: unknown): Unreadable {
  const code = codeOf(error);
  const reason =
    code === 'EACCES' || code === 'EPERM'
      ? 'permission denied'
      : code === 'ELOOP'
        ? 'a symbolic link loop'
        : (code ?? 'an unexpected error');
  return new Unreadable(`${what} could not be read: ${reason}`);
}

function directoryWhereFile(rel: string): Unreadable {
  return new Unreadable(
    `'${rel}' is a directory, where a file was named`,
    `a file probe reads files — to read the files inside a directory, use a glob such as ` +
      `'${rel}/*' or '${rel}/**/*'`,
  );
}

function notRegular(rel: string): Unreadable {
  return new Unreadable(`'${rel}' is not a regular file, so it has no text to read`);
}

/**
 * Text that may carry a name read FROM THE TREE, made safe to print.
 *
 * File names are chosen by the branch under verification, and a control character or an
 * ANSI escape in one would otherwise travel through an error message to the operator's
 * terminal. A plan's own paths are already refused if they carry one (`domain/tree-path.ts`);
 * names a glob discovered were never the plan's to vet, so they are escaped on the way out.
 */
function printable(text: string): string {
  return text.replace(
    /[\u0000-\u001f\u007f]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/* ── params ──────────────────────────────────────────────────────────────────────────── */

interface FileAssertionSpec {
  readonly description: string;
  readonly target: FileAssertionTarget;
  readonly comparison: AssertionComparison;
  readonly expected: string;
}

interface FileParams {
  readonly probeId: string;
  readonly path: string;
  readonly exclude: readonly string[];
  readonly assertions: readonly FileAssertionSpec[];
  readonly attempt: number;
  readonly criterionId: string;
}

/** Own properties only — see `observation.ts`'s `own` for the prototype-walk defect. */
function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return malformed(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string') {
    return malformed(`${what} is not a string`);
  }
  return value;
}

function asNonEmptyString(value: unknown, what: string): string {
  const text = asString(value, what);
  if (text === '') {
    return malformed(`${what} is empty`);
  }
  return text;
}

function onlyKeys(record: Record<string, unknown>, allowed: readonly string[], at: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      malformed(`${at}.${key} is not a field this read accepts`);
    }
  }
}

/**
 * The same refusal the plan schema makes, made again before any read, because a plan file
 * can be hand-edited after it was compiled. One grammar, `domain/tree-path.ts`.
 */
function refusePattern(probeId: string, pattern: string): void {
  const problem = treePatternProblem(pattern);
  if (problem !== undefined) {
    throw new InfraError(
      `file probe '${probeId}' names the path ${JSON.stringify(pattern)}, which ${problem}; nothing was read`,
      PATH_HINT,
    );
  }
}

function readFlags(target: Record<string, unknown>, at: string) {
  const ignoreCase = own(target, 'ignoreCase');
  if (ignoreCase !== undefined && typeof ignoreCase !== 'boolean') {
    malformed(`${at}.ignoreCase is not a boolean`);
  }
  const ignoreComments = own(target, 'ignoreComments');
  if (
    ignoreComments !== undefined &&
    !FILE_COMMENT_SYNTAXES.includes(ignoreComments as FileCommentSyntax)
  ) {
    malformed(`${at}.ignoreComments is not one of ${FILE_COMMENT_SYNTAXES.join(', ')}`);
  }
  return {
    ...(ignoreCase === undefined ? {} : { ignoreCase: ignoreCase as boolean }),
    ...(ignoreComments === undefined
      ? {}
      : { ignoreComments: ignoreComments as FileCommentSyntax }),
  };
}

function readTarget(raw: unknown, at: string): FileAssertionTarget {
  const target = asRecord(raw, at);
  const source = own(target, 'source');
  const flagged = ['source', 'ignoreCase', 'ignoreComments'];

  switch (source) {
    case 'exists':
    case 'fileCount':
      onlyKeys(target, ['source'], at);
      return { source };

    case 'content':
      onlyKeys(target, flagged, at);
      return { source, ...readFlags(target, at) };

    case 'jsonPath':
      onlyKeys(target, ['source', 'path'], at);
      return { source, path: asNonEmptyString(own(target, 'path'), `${at}.path`) };

    case 'occurrences':
      onlyKeys(target, [...flagged, 'text'], at);
      return {
        source,
        text: asNonEmptyString(own(target, 'text'), `${at}.text`),
        ...readFlags(target, at),
      };

    case 'filesContaining': {
      onlyKeys(target, [...flagged, 'texts'], at);
      const texts = own(target, 'texts');
      if (!Array.isArray(texts) || texts.length === 0) {
        return malformed(`${at}.texts is not a non-empty array`);
      }
      return {
        source,
        texts: texts.map((text, index) => asNonEmptyString(text, `${at}.texts[${index}]`)),
        ...readFlags(target, at),
      };
    }

    default:
      return malformed(`${at}.source is '${String(source)}', which a file probe cannot read`);
  }
}

function readAssertion(raw: unknown, index: number): FileAssertionSpec {
  const at = `assertions[${index}]`;
  const assertion = asRecord(raw, at);

  const comparison = own(assertion, 'comparison');
  if (
    typeof comparison !== 'string' ||
    !ASSERTION_COMPARISONS.includes(comparison as AssertionComparison)
  ) {
    return malformed(`${at}.comparison is '${String(comparison)}', which is not a known comparison`);
  }

  return {
    description: asNonEmptyString(own(assertion, 'description'), `${at}.description`),
    target: readTarget(own(assertion, 'target'), `${at}.target`),
    comparison: comparison as AssertionComparison,
    expected: asString(own(assertion, 'expected'), `${at}.expected`),
  };
}

function readAttempt(raw: unknown): number {
  if (raw === undefined) {
    return 1;
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    return malformed('attempt is not a positive integer');
  }
  return raw;
}

function readParams(request: ProbeRequest): FileParams {
  const raw = request.params;
  const probeId = asNonEmptyString(own(raw, 'id'), "'id'");
  const mechanics = asRecord(own(raw, 'mechanics'), 'mechanics');
  onlyKeys(mechanics, ['path', 'exclude'], 'mechanics');

  const path = asNonEmptyString(own(mechanics, 'path'), 'mechanics.path');
  refusePattern(probeId, path);

  const rawExclude = own(mechanics, 'exclude');
  let exclude: string[] = [];
  if (rawExclude !== undefined) {
    if (!Array.isArray(rawExclude)) {
      return malformed('mechanics.exclude is not an array');
    }
    exclude = rawExclude.map((entry, index) =>
      asNonEmptyString(entry, `mechanics.exclude[${index}]`),
    );
    for (const entry of exclude) {
      refusePattern(probeId, entry);
    }
  }

  const rawAssertions = own(raw, 'assertions');
  if (!Array.isArray(rawAssertions) || rawAssertions.length === 0) {
    // "A probe that adjudicates nothing cannot mint a PASS" — the plan schema's `.min(1)`,
    // re-checked for a hand-edited plan.
    return malformed('assertions is not a non-empty array');
  }
  const assertions = rawAssertions.map(readAssertion);

  // THE READ AND THE PATH ARE ONE FACT — the schema's pairing, re-checked at run time.
  const glob = isTreeGlob(path);
  if (!glob && rawExclude !== undefined) {
    return malformed(`mechanics.exclude is set, but '${path}' names one path rather than a glob`);
  }
  if (glob) {
    for (const assertion of assertions) {
      const { source } = assertion.target;
      if (source === 'content' || source === 'jsonPath') {
        return malformed(`'${source}' reads exactly one file, but '${path}' is a glob`);
      }
    }
  }

  return {
    probeId,
    path,
    exclude,
    assertions,
    attempt: readAttempt(own(raw, 'attempt')),
    criterionId: request.criterionId,
  };
}

/* ── matching ────────────────────────────────────────────────────────────────────────── */

function isWildSegment(segment: string): boolean {
  return /[*?]/.test(segment);
}

function joinRel(rel: string, name: string): string {
  return rel === '' ? name : `${rel}/${name}`;
}

/**
 * Does one path SEGMENT match one pattern segment? `*` is any run, `?` one character, and
 * everything else — brackets included — is literal. Case-SENSITIVE on every platform.
 *
 * NOT A REGULAR EXPRESSION, and that is a security decision: the pattern is plan text a
 * provider wrote, and `a*a*a*a*…b` compiled to a backtracking regex against a long name is
 * the ReDoS `ASSERTION_COMPARISONS` refuses to hand any executor. This is the classic
 * two-pointer wildcard match, O(pattern × name) at worst.
 */
function wildcardMatches(pattern: string, name: string): boolean {
  let p = 0;
  let n = 0;
  let star = -1;
  let mark = 0;

  while (n < name.length) {
    const char = pattern.charAt(p);
    if (p < pattern.length && char === '*') {
      star = p;
      p += 1;
      mark = n;
    } else if (p < pattern.length && (char === '?' || char === name.charAt(n))) {
      p += 1;
      n += 1;
    } else if (star !== -1) {
      p = star + 1;
      mark += 1;
      n = mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern.charAt(p) === '*') {
    p += 1;
  }
  return p === pattern.length;
}

/** Does a whole relative path match a pattern with `**`? Memoised; used for exclusions. */
function pathMatches(pattern: readonly string[], path: readonly string[]): boolean {
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    const key = i * (path.length + 1) + j;
    const cached = memo.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const segment = pattern[i];
    let result: boolean;
    if (segment === undefined) {
      result = j === path.length;
    } else if (segment === '**') {
      result = go(i + 1, j) || (j < path.length && go(i, j + 1));
    } else {
      const name = path[j];
      result = name !== undefined && wildcardMatches(segment, name) && go(i + 1, j + 1);
    }
    memo.set(key, result);
    return result;
  };
  return go(0, 0);
}

/* ── the confined tree reader ────────────────────────────────────────────────────────── */

type EntryKind = 'file' | 'directory' | 'other';

interface Entry {
  /** As the plan spelled it, `/`-separated from the repository root. */
  readonly rel: string;
  /** The resolved path actually opened — always inside the root. */
  readonly real: string;
  readonly kind: EntryKind;
}

class TreeReader {
  readonly #root: string;
  readonly #probeId: string;
  readonly #limits: FileReadLimits;
  readonly #listings = new Map<string, readonly Dirent[] | undefined>();
  readonly #texts = new Map<string, string>();
  #visited = 0;

  constructor(root: string, probeId: string, limits: FileReadLimits) {
    this.#root = root;
    this.#probeId = probeId;
    this.#limits = limits;
  }

  #inside(candidate: string): boolean {
    return candidate === this.#root || candidate.startsWith(this.#root + sep);
  }

  #escape(rel: string): never {
    throw new InfraError(
      `file probe '${this.#probeId}': ${JSON.stringify(rel)} is a symbolic link that resolves ` +
        'outside the verification worktree, so it was not read',
      ESCAPE_HINT,
    );
  }

  /** Directory entries, or `undefined` when the directory is not there. Cached per probe. */
  async #list(directory: string, rel: string): Promise<readonly Dirent[] | undefined> {
    if (this.#listings.has(directory)) {
      return this.#listings.get(directory);
    }
    let entries: Dirent[] | undefined;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (!isMissing(error)) {
        throw unreadable(rel === '' ? 'the repository root' : `'${rel}'`, error);
      }
      entries = undefined;
    }
    if (entries !== undefined) {
      this.#visited += entries.length;
      if (this.#visited > this.#limits.maxEntries) {
        throw new Unreadable(
          `the probe listed more than ${this.#limits.maxEntries} directory entries without finishing`,
          "narrow the path — for example 'docs/**/*.md' rather than '**/*'",
        );
      }
    }
    this.#listings.set(directory, entries);
    return entries;
  }

  /**
   * Resolves a symlink and CONFINES it: the real target must lie inside the root, or the
   * probe is refused. A dangling link cannot be resolved, so it is judged by where its text
   * points — lexically, from its own (already real) directory — and is otherwise absent.
   */
  async #follow(link: string, rel: string): Promise<string | undefined> {
    let target: string;
    try {
      target = await realpath(link);
    } catch (error) {
      if (!isMissing(error)) {
        throw unreadable(`'${rel}'`, error);
      }
      let pointed: string;
      try {
        pointed = resolve(dirname(link), await readlink(link));
      } catch (inner) {
        throw unreadable(`'${rel}'`, inner);
      }
      if (!this.#inside(pointed)) {
        this.#escape(rel);
      }
      return undefined;
    }
    if (!this.#inside(target)) {
      this.#escape(rel);
    }
    return target;
  }

  async #stat(path: string, rel: string): Promise<Stats | undefined> {
    try {
      return await lstat(path);
    } catch (error) {
      if (isMissing(error)) {
        return undefined;
      }
      throw unreadable(`'${rel}'`, error);
    }
  }

  /**
   * Resolves a literal path segment by segment, matching each name EXACTLY against the
   * directory's own listing — so `readme.md` does not find `README.md` on a macOS volume
   * and fail to find it on Linux. `undefined` is absence.
   */
  async literal(pattern: string): Promise<Entry | undefined> {
    const segments = pattern.split('/');
    let current = this.#root;
    let rel = '';

    for (const [index, name] of segments.entries()) {
      const listing = await this.#list(current, rel);
      rel = joinRel(rel, name);
      const dirent = listing?.find((entry) => entry.name === name);
      if (dirent === undefined) {
        return undefined;
      }

      let next = join(current, name);
      if (dirent.isSymbolicLink()) {
        const followed = await this.#follow(next, rel);
        if (followed === undefined) {
          return undefined;
        }
        next = followed;
      }

      const stats = await this.#stat(next, rel);
      if (stats === undefined) {
        return undefined;
      }
      if (index < segments.length - 1) {
        if (!stats.isDirectory()) {
          return undefined;
        }
        current = next;
        continue;
      }
      return {
        rel,
        real: next,
        kind: stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'other',
      };
    }
    return undefined;
  }

  /** Every regular file a glob selects, minus exclusions, in a stable order. */
  async glob(pattern: string, exclude: readonly string[]): Promise<Entry[]> {
    const segments = pattern.split('/');
    // `docs/**` means everything beneath docs, which is `docs/**/*` spelled shorter.
    if (segments[segments.length - 1] === '**') {
      segments.push('*');
    }
    const firstWild = segments.findIndex(isWildSegment);
    const prefix = segments.slice(0, firstWild);

    let base: { readonly real: string; readonly rel: string } = { real: this.#root, rel: '' };
    if (prefix.length > 0) {
      const entry = await this.literal(prefix.join('/'));
      if (entry?.kind !== 'directory') {
        return [];
      }
      base = entry;
    }

    const found = new Map<string, Entry>();
    await this.#walk(base.real, base.rel, segments.slice(firstWild), found, pattern);

    const excluded = exclude.map((entry) => entry.split('/'));
    return [...found.values()]
      .filter((entry) => !excluded.some((glob) => pathMatches(glob, entry.rel.split('/'))))
      .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  }

  async #walk(
    directory: string,
    rel: string,
    rest: readonly string[],
    found: Map<string, Entry>,
    pattern: string,
  ): Promise<void> {
    const [head, ...tail] = rest;
    if (head === undefined) {
      return;
    }
    const listing = (await this.#list(directory, rel)) ?? [];

    if (head === '**') {
      // Zero directories, then one more directory at a time. A symlinked directory is
      // never entered by a wildcard — it could cycle, and what it points at is reachable
      // by its real path if the plan means it.
      await this.#walk(directory, rel, tail, found, pattern);
      for (const entry of listing) {
        if (entry.isDirectory() && !NEVER_WALKED.has(entry.name)) {
          await this.#walk(join(directory, entry.name), joinRel(rel, entry.name), rest, found, pattern);
        }
      }
      return;
    }

    const wild = isWildSegment(head);
    for (const entry of listing) {
      if ((wild && NEVER_WALKED.has(entry.name)) || !wildcardMatches(head, entry.name)) {
        continue;
      }
      const childRel = joinRel(rel, entry.name);
      const childPath = join(directory, entry.name);

      if (tail.length > 0) {
        if (entry.isDirectory()) {
          await this.#walk(childPath, childRel, tail, found, pattern);
        }
        continue;
      }

      if (entry.isFile()) {
        this.#collect(found, { rel: childRel, real: childPath, kind: 'file' }, pattern);
      } else if (entry.isSymbolicLink()) {
        // A link the pattern selected is followed — and confined, so an escaping one
        // refuses the whole probe rather than being quietly skipped.
        const target = await this.#follow(childPath, childRel);
        if (target === undefined) {
          continue;
        }
        const stats = await this.#stat(target, childRel);
        if (stats?.isFile() === true) {
          this.#collect(found, { rel: childRel, real: target, kind: 'file' }, pattern);
        }
      }
    }
  }

  #collect(found: Map<string, Entry>, entry: Entry, pattern: string): void {
    found.set(entry.rel, entry);
    if (found.size > this.#limits.maxFiles) {
      throw new Unreadable(
        `'${pattern}' matched more than ${this.#limits.maxFiles} files`,
        'narrow the path or add exclusions — a probe reading this much of the tree is rarely ' +
          'checking what its criterion says',
      );
    }
  }

  /**
   * The text of one confined file: UTF-8, byte-order mark dropped, CRLF read as LF, so a
   * Windows checkout and a POSIX one read alike. Never truncated — over the bound it is an
   * `execError`, because a count over part of a file is a count of the wrong thing.
   */
  async text(entry: Entry): Promise<string> {
    const cached = this.#texts.get(entry.rel);
    if (cached !== undefined) {
      return cached;
    }
    if (entry.kind === 'directory') {
      throw directoryWhereFile(entry.rel);
    }
    if (entry.kind !== 'file') {
      throw notRegular(entry.rel);
    }

    let handle: FileHandle;
    try {
      // O_NOFOLLOW: the path was confined when it was resolved, and the last component
      // cannot have become a link since. O_NONBLOCK: a FIFO cannot hold the run open.
      handle = await open(
        entry.real,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
    } catch (error) {
      throw unreadable(`'${entry.rel}'`, error);
    }

    try {
      const stats = await handle.stat();
      if (stats.isDirectory()) {
        throw directoryWhereFile(entry.rel);
      }
      if (!stats.isFile()) {
        throw notRegular(entry.rel);
      }
      const tooLarge = (): Unreadable =>
        new Unreadable(
          `'${entry.rel}' is larger than ${this.#limits.maxFileBytes} bytes, so it was not read`,
          'a file probe reads source and documents; narrow the path so it does not select this file',
        );
      if (stats.size > this.#limits.maxFileBytes) {
        throw tooLarge();
      }
      const bytes = await handle.readFile();
      if (bytes.byteLength > this.#limits.maxFileBytes) {
        throw tooLarge();
      }

      let decoded: string;
      try {
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new Unreadable(
          `'${entry.rel}' is not UTF-8 text, so its content cannot be compared`,
          'narrow the path to text files, for example by extension — a binary file has no text to read',
        );
      }
      const text = decoded.replace(/\r\n/g, '\n');
      this.#texts.set(entry.rel, text);
      return text;
    } finally {
      await handle.close();
    }
  }
}

/* ── comments ────────────────────────────────────────────────────────────────────────── */

/** Keywords after which a `/` starts a regular expression rather than a division. */
const REGEX_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/** Punctuation after which a `/` starts a regular expression. */
const REGEX_AFTER = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '~', '+', '-', '*', '%', '<', '>', '^']);

function isIdentifierChar(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char);
}

/** End index (exclusive) of a quoted literal starting at `start`. */
function scanQuoted(text: string, start: number, quote: string, stopAtNewline: boolean): number {
  let index = start + 1;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === quote) {
      return index + 1;
    }
    if (stopAtNewline && char === '\n') {
      return index;
    }
    index += 1;
  }
  return text.length;
}

/** End index of a regex literal starting at `start`, or -1 when it is not one. */
function scanRegex(text: string, start: number): number {
  let index = start + 1;
  let inClass = false;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === '\n') {
      return -1;
    }
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '[') {
      inClass = true;
    } else if (char === ']') {
      inClass = false;
    } else if (char === '/' && !inClass) {
      index += 1;
      while (index < text.length && /[a-z]/.test(text.charAt(index))) {
        index += 1;
      }
      return index;
    }
    index += 1;
  }
  return -1;
}

type Stripped =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly line: number; readonly what: string };

/**
 * Blanks `//` and `/* *\/` comments with spaces, keeping every newline, for `c-like` source.
 *
 * A LEXER, NOT A SEARCH-AND-REPLACE. The census this replaces counted a spelling inside a
 * comment; a naive stripper fails in the opposite and worse direction, deleting CODE — a
 * `"http://…"` string or a `/\/\//` regex would swallow the rest of its line, and a real
 * occurrence after it would vanish, so a "must be 0" count would pass over the violation.
 * So strings, template literals and regex literals are recognised and kept. Comments become
 * SPACES rather than nothing, so `a/* x *\/b` cannot turn into a match for `ab`.
 *
 * TEMPLATE LITERALS NEST, and the lexer tracks it: `${` opens code inside a template, that
 * code can hold strings, comments, object literals and further templates, and only the `}`
 * that balances it returns to the template. The first version did not, and the codex review
 * of this branch showed what that cost: in `` `${`http://x`}`; forbidden(); `` the inner
 * backtick ended the outer template, the `//` became a comment, and `forbidden()` was hidden
 * — an undercount, which is the direction that passes over unmet work.
 *
 * Where no safe reading exists — an unterminated block comment, template literal or
 * interpolation — the file is refused (`ok: false`), which becomes an execError. Guessing
 * where a construct ends is how code disappears from a count. A quote that is not closed by
 * the end of its LINE ends there, as it does in every c-like language, which can only keep
 * text and so only over-count.
 */
function stripCLikeComments(text: string): Stripped {
  const out: string[] = [];
  // One entry per open `${`: the brace depth of the code that was interrupted, so the `}`
  // closing the interpolation can be told from the `}` closing an object literal inside it.
  const interpolations: number[] = [];
  let depth = 0;
  let index = 0;
  let previous = '';
  let word = '';

  const blank = (chunk: string): string => chunk.replace(/[^\n]/g, ' ');
  const lineAt = (at: number): number => text.slice(0, at).split('\n').length;

  /**
   * Copies template text from `from` (just past a backtick or an interpolation's `}`) up to
   * and including the closing backtick or the next `${`. `undefined` when the file ends first.
   */
  const templateText = (from: number): { readonly end: number; readonly opens: boolean } | undefined => {
    let at = from;
    while (at < text.length) {
      const char = text.charAt(at);
      if (char === '\\') {
        at += 2;
        continue;
      }
      if (char === '`') {
        return { end: at + 1, opens: false };
      }
      if (char === '$' && text.charAt(at + 1) === '{') {
        return { end: at + 2, opens: true };
      }
      at += 1;
    }
    return undefined;
  };

  /** Consumes template text starting at `start`; returns a refusal when it never ends. */
  const inTemplate = (start: number): Stripped | undefined => {
    const scanned = templateText(start + 1);
    if (scanned === undefined) {
      return { ok: false, line: lineAt(start), what: 'template literal' };
    }
    out.push(text.slice(start, scanned.end));
    index = scanned.end;
    word = '';
    if (scanned.opens) {
      interpolations.push(depth);
      depth = 0;
      previous = '{';
    } else {
      previous = '`';
    }
    return undefined;
  };

  while (index < text.length) {
    const char = text.charAt(index);
    const next = text.charAt(index + 1);

    if (char === '/' && next === '/') {
      let end = text.indexOf('\n', index);
      if (end === -1) {
        end = text.length;
      }
      out.push(blank(text.slice(index, end)));
      index = end;
      continue;
    }

    if (char === '/' && next === '*') {
      const close = text.indexOf('*/', index + 2);
      if (close === -1) {
        return { ok: false, line: lineAt(index), what: 'block comment' };
      }
      out.push(blank(text.slice(index, close + 2)));
      index = close + 2;
      continue;
    }

    if (char === '"' || char === "'") {
      const end = scanQuoted(text, index, char, true);
      out.push(text.slice(index, end));
      previous = char;
      word = '';
      index = end;
      continue;
    }

    if (char === '`') {
      const refused = inTemplate(index);
      if (refused !== undefined) {
        return refused;
      }
      continue;
    }

    if (char === '}' && depth === 0 && interpolations.length > 0) {
      // This `}` closes an interpolation: back into the template it interrupted.
      depth = interpolations.pop() as number;
      const refused = inTemplate(index);
      if (refused !== undefined) {
        return refused;
      }
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth = Math.max(0, depth - 1);
    }

    if (char === '/') {
      const regexAllowed =
        REGEX_AFTER.has(previous) || (isIdentifierChar(previous) && REGEX_KEYWORDS.has(word));
      if (regexAllowed) {
        const end = scanRegex(text, index);
        if (end !== -1) {
          out.push(text.slice(index, end));
          previous = '/';
          word = '';
          index = end;
          continue;
        }
      }
    }

    out.push(char);
    if (isIdentifierChar(char)) {
      word = isIdentifierChar(previous) ? word + char : char;
      previous = char;
    } else if (!/\s/.test(char)) {
      previous = char;
      word = '';
    }
    index += 1;
  }

  if (interpolations.length > 0) {
    return { ok: false, line: lineAt(text.length), what: 'template literal' };
  }
  return { ok: true, text: out.join('') };
}

/* ── reading and evaluating ──────────────────────────────────────────────────────────── */

type Selection =
  | { readonly glob: false; readonly entry: Entry | undefined }
  | { readonly glob: true; readonly files: readonly Entry[] };

type FileRead =
  | { readonly found: true; readonly value: string }
  | { readonly found: false; readonly why: string };

interface ReadOutcome {
  readonly read: FileRead;
  /** What the evidence records about this read — never a file's text. */
  readonly report: Record<string, unknown>;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) {
      return count;
    }
    count += 1;
    from = at + needle.length;
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** What an `actual` shows of a file's text. The evaluation compared all of it. */
function shown(text: string): string {
  return text.length <= CONTENT_ACTUAL_MAX_CHARS
    ? text
    : `${text.slice(0, CONTENT_ACTUAL_MAX_CHARS)}… [${text.length - CONTENT_ACTUAL_MAX_CHARS} more characters not shown]`;
}

export class FileSurfaceExecutor implements SurfaceExecutor {
  readonly surface = 'file' as const;

  readonly #deps: FileExecutorDeps;

  constructor(deps: FileExecutorDeps) {
    this.#deps = deps;
  }

  async execute(request: ProbeRequest): Promise<ProbeAttempt> {
    // Refusals FIRST, before the root is touched: a hostile path is refused having read
    // nothing at all.
    const params = readParams(request);
    const started = this.#deps.clock.now().getTime();
    const elapsed = (): number =>
      Math.max(0, Math.round(this.#deps.clock.now().getTime() - started));

    const root = await this.#root(params);
    const limits = { ...FILE_READ_LIMITS, ...this.#deps.limits };
    const reader = new TreeReader(root, params.probeId, limits);

    let selection: Selection;
    const outcomes: ReadOutcome[] = [];
    try {
      // Selection is COMPLETE before any file is opened, so an escaping link anywhere in
      // what the pattern selects refuses the probe before a single byte has been read.
      selection = isTreeGlob(params.path)
        ? { glob: true, files: await reader.glob(params.path, params.exclude) }
        : { glob: false, entry: await reader.literal(params.path) };

      for (const assertion of params.assertions) {
        outcomes.push(await this.#read(reader, selection, assertion, params));
      }
    } catch (error) {
      if (!(error instanceof Unreadable)) {
        throw error;
      }
      const execError: ProbeExecError = {
        message: redactText(
          printable(`file probe '${params.probeId}': ${error.message}`),
          this.#redaction(),
        ),
        hint: printable(error.hint),
      };
      const ref = await this.#attemptRecord(params, execError.message);
      return {
        attempt: params.attempt,
        observations: [],
        assertionEvaluations: [],
        evidence: [ref],
        execError,
        durationMs: elapsed(),
      };
    }

    const evaluations = params.assertions.map((assertion, index) =>
      this.#evaluate(assertion, (outcomes[index] as ReadOutcome).read),
    );
    const observations: Observation[] = [
      {
        name: `file:${params.path}`,
        value: selection.glob
          ? `${selection.files.length} ${selection.files.length === 1 ? 'file' : 'files'} matched`
          : (selection.entry?.kind ?? 'absent'),
      },
    ];
    const evidence = await this.#persist(params, selection, outcomes, elapsed());

    return {
      attempt: params.attempt,
      observations,
      assertionEvaluations: evaluations,
      evidence,
      durationMs: elapsed(),
    };
  }

  async #root(params: FileParams): Promise<string> {
    try {
      return await realpath(this.#deps.root);
    } catch (error) {
      throw new InfraError(
        `file probe '${params.probeId}' cannot read the verification worktree: it could not be ` +
          `resolved (${codeOf(error) ?? 'unknown error'})`,
        'this is an environment problem, not a failure of the branch under verification — ' +
          'rerun, and run `specwitness clean` if a previous run was interrupted',
      );
    }
  }

  #redaction(): RedactionOptions {
    // Capture output, never declared command text — the fail-closed default, as on every
    // other surface.
    return { ...this.#deps.redaction, shellCommand: false };
  }

  /** The files a CONTENT read looks at. A directory or other non-file refuses. */
  #filesOf(selection: Selection): readonly Entry[] {
    if (selection.glob) {
      return selection.files;
    }
    const { entry } = selection;
    if (entry === undefined) {
      return [];
    }
    if (entry.kind === 'directory') {
      throw directoryWhereFile(entry.rel);
    }
    if (entry.kind !== 'file') {
      throw notRegular(entry.rel);
    }
    return [entry];
  }

  async #prepared(
    reader: TreeReader,
    entry: Entry,
    syntax: FileCommentSyntax | undefined,
  ): Promise<string> {
    const text = await reader.text(entry);
    if (syntax === undefined) {
      return text;
    }
    const stripped = stripCLikeComments(text);
    if (!stripped.ok) {
      throw new Unreadable(
        `'${entry.rel}' has an unterminated ${stripped.what} (line ${stripped.line}), so its ` +
          'comments cannot be told from its code',
        "fix the file, or drop 'ignoreComments' from this probe",
      );
    }
    return stripped.text;
  }

  async #read(
    reader: TreeReader,
    selection: Selection,
    assertion: FileAssertionSpec,
    params: FileParams,
  ): Promise<ReadOutcome> {
    const { target } = assertion;
    const nothing = selection.glob
      ? `'${params.path}' matched no file`
      : `'${params.path}' does not exist`;
    const absent = (why: string): ReadOutcome => ({
      read: { found: false, why: `absent: ${why}` },
      report: { source: target.source, value: null, absent: why },
    });

    switch (target.source) {
      case 'exists': {
        const value = String(
          selection.glob ? selection.files.length > 0 : selection.entry !== undefined,
        );
        return { read: { found: true, value }, report: { source: target.source, value } };
      }

      case 'fileCount': {
        const value = String(this.#filesOf(selection).length);
        return { read: { found: true, value }, report: { source: target.source, value } };
      }

      case 'content': {
        const [entry] = this.#filesOf(selection);
        if (entry === undefined) {
          return absent(nothing);
        }
        const text = await this.#prepared(reader, entry, target.ignoreComments);
        return {
          read: { found: true, value: text },
          report: {
            source: target.source,
            file: entry.rel,
            characters: text.length,
            sha256: sha256(text),
            ...(target.ignoreComments === undefined ? {} : { ignoreComments: target.ignoreComments }),
          },
        };
      }

      case 'jsonPath': {
        const [entry] = this.#filesOf(selection);
        if (entry === undefined) {
          return absent(nothing);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(await reader.text(entry)) as unknown;
        } catch (error) {
          if (error instanceof Unreadable) {
            throw error;
          }
          throw new Unreadable(
            `'${entry.rel}' is not valid JSON, so '${target.path}' cannot be read from it`,
          );
        }
        const value = readPath(parsed, target.path);
        if (!value.found) {
          return absent(`'${target.path}' is not present in '${entry.rel}'`);
        }
        return {
          read: { found: true, value: value.value },
          report: { source: target.source, file: entry.rel, path: target.path, value: value.value },
        };
      }

      case 'occurrences': {
        const files = this.#filesOf(selection);
        if (files.length === 0) {
          return absent(nothing);
        }
        const fold = (text: string): string => (target.ignoreCase === true ? text.toLowerCase() : text);
        const needle = fold(target.text);
        const perFile: Record<string, number> = {};
        let total = 0;
        for (const entry of files) {
          const count = countOccurrences(
            fold(await this.#prepared(reader, entry, target.ignoreComments)),
            needle,
          );
          perFile[entry.rel] = count;
          total += count;
        }
        const value = String(total);
        return {
          read: { found: true, value },
          report: { source: target.source, text: target.text, ...this.#flags(target), value, perFile },
        };
      }

      case 'filesContaining': {
        const files = this.#filesOf(selection);
        if (files.length === 0) {
          return absent(nothing);
        }
        const fold = (text: string): string => (target.ignoreCase === true ? text.toLowerCase() : text);
        const needles = target.texts.map(fold);
        const perFile: Record<string, boolean> = {};
        let total = 0;
        for (const entry of files) {
          const text = fold(await this.#prepared(reader, entry, target.ignoreComments));
          const all = needles.every((needle) => text.includes(needle));
          perFile[entry.rel] = all;
          total += all ? 1 : 0;
        }
        const value = String(total);
        return {
          read: { found: true, value },
          report: { source: target.source, texts: target.texts, ...this.#flags(target), value, perFile },
        };
      }

      default: {
        const unreachable: never = target;
        return malformed(`unknown read '${String(unreachable)}'`);
      }
    }
  }

  #flags(target: { readonly ignoreCase?: boolean; readonly ignoreComments?: FileCommentSyntax }) {
    return {
      ...(target.ignoreCase === undefined ? {} : { ignoreCase: target.ignoreCase }),
      ...(target.ignoreComments === undefined ? {} : { ignoreComments: target.ignoreComments }),
    };
  }

  /**
   * One evaluation per assertion, satisfied ones included — `deriveCriterionResult` reads
   * the first unsatisfied one, and dropping satisfied ones would make a pass look like a
   * probe that adjudicated nothing. Assertions are data, compared mechanically; nothing is
   * interpreted and no model is consulted.
   */
  #evaluate(assertion: FileAssertionSpec, read: FileRead): AssertionEvaluation {
    const options = this.#redaction();
    const { target } = assertion;
    const folds = target.source === 'content' && target.ignoreCase === true;
    const fold = (text: string): string => (folds ? text.toLowerCase() : text);

    const satisfied =
      read.found && compare(assertion.comparison, fold(read.value), fold(assertion.expected));

    return {
      description: assertion.description,
      satisfied,
      expected: redactText(assertion.expected, options),
      actual: redactText(
        read.found ? (target.source === 'content' ? shown(read.value) : read.value) : read.why,
        options,
      ),
    };
  }

  /** The evidence filename stem: criterion + probe + a digest of both (see observation.ts). */
  #stem(params: FileParams): string {
    return (
      `${EVIDENCE_DIR}/file-${slugify(params.criterionId)}-${slugify(params.probeId)}` +
      `-${discriminator(params.criterionId, params.probeId)}-${params.attempt}`
    );
  }

  /**
   * The read report and the typed member, both redacted.
   *
   * Kind `observation`: a file read IS an observation of the tree, and `EVIDENCE_KINDS` is a
   * closed union that ADR-009 does not widen. The member's id names this surface so a report
   * reads `observation file:<probe>` rather than borrowing a command's name. The report
   * records WHERE each count came from — per file — which is what would have shown the first
   * reader of the evidence that a census was counting a comment.
   */
  async #persist(
    params: FileParams,
    selection: Selection,
    outcomes: readonly ReadOutcome[],
    durationMs: number,
  ): Promise<EvidenceRef[]> {
    const options = this.#redaction();
    const report = {
      surface: 'file',
      probe: params.probeId,
      path: params.path,
      ...(params.exclude.length === 0 ? {} : { exclude: params.exclude }),
      ...(selection.glob
        ? { matched: selection.files.map((entry) => entry.rel) }
        : { entry: selection.entry === undefined ? 'absent' : selection.entry.kind }),
      reads: outcomes.map((outcome) => outcome.report),
    };
    const text = redactText(`${JSON.stringify(report, null, 2)}\n`, options);
    const stem = this.#stem(params);

    const fullPath = await this.#deps.writeEvidence(`${stem}.read.json`, text);
    const member = observationEvidence(
      {
        capturedAt: this.#deps.clock.now().toISOString(),
        observationId: `file:${params.probeId}`,
        snapshot: text,
        durationMs,
        explanation: `what file probe '${params.probeId}' matched and read in the verification worktree`,
      },
      { ...options, fullPath },
    );
    this.#deps.recordEvidence(member);

    return [
      evidenceRef('observation', fullPath),
      evidenceRef(
        'observation',
        await this.#deps.writeEvidence(`${stem}.json`, `${JSON.stringify(member, null, 2)}\n`),
      ),
    ];
  }

  /**
   * A record of what was ATTEMPTED, for a read that observed nothing — the observation
   * surface's move, down to the opening sentence. No member: nothing was observed, and a
   * snapshot saying otherwise would manufacture evidence out of a failure to read.
   */
  async #attemptRecord(params: FileParams, message: string): Promise<EvidenceRef> {
    const lines = [
      'nothing was observed; this records what was attempted, not what was observed',
      '',
      `probe:    ${params.probeId}`,
      `path:     ${params.path}`,
      ...params.exclude.map((entry) => `exclude:  ${entry}`),
      `attempt:  ${params.attempt}`,
      '',
      `error:    ${message}`,
    ];
    const path = await this.#deps.writeEvidence(
      `${this.#stem(params)}.attempt.txt`,
      `${redactText(lines.join('\n'), this.#redaction())}\n`,
    );
    return evidenceRef('observation', path);
  }
}
