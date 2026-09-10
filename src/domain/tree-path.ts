/**
 * The grammar of a path a `file` probe may name (story 7.8, ADR-009 §3).
 *
 * ONE DEFINITION, TWO REFUSALS. The plan schema (`src/schemas/plan.ts`) refuses a bad
 * pattern so a hostile draft is never written, and the executor (`src/surfaces/file.ts`)
 * refuses it again before any read, because a plan file can be hand-edited after it was
 * compiled. Both call this function, so the two refusals cannot come to disagree about what
 * a legal path is — the drift that `schemas/plan.ts` records twice for its own
 * draft/persisted schema pair.
 *
 * What this function CANNOT refuse is a symlink. Whether `docs/current` leaves the worktree
 * is a fact about the tree, not about the text, and only the executor can see the tree. That
 * check lives there and is the one a careless implementation breaks.
 *
 * AD-1: pure. No filesystem, no node builtin.
 */

/** Longest pattern accepted, in characters. Generous beside any real repository path. */
export const TREE_PATTERN_MAX_CHARS = 1024;

/**
 * Why `pattern` is not a legal worktree-relative path or glob, or `undefined` when it is.
 *
 * The phrase completes the sentence "the path ...", so both callers can say it in their own
 * voice. Checked in an order that names the most dangerous reading first: a path that is
 * absolute AND contains `..` is reported as absolute.
 *
 * The grammar, stated once:
 *  - relative to the repository root, `/`-separated, no empty, `.` or `..` segment;
 *  - no backslash, no drive letter, no leading `~`, no control character;
 *  - `*` and `?` match within one segment, `**` (a whole segment) matches any depth;
 *  - NO brace expansion — refused rather than read literally, because `docs/{a,b}.md`
 *    silently matching nothing would read as "absent" and fail for the wrong reason;
 *  - square brackets are LITERAL (no character classes), because `app/[id]/page.tsx` is a
 *    real path in real projects and refusing it would make them unverifiable.
 */
export function treePatternProblem(pattern: string): string | undefined {
  if (pattern === '') {
    return 'is empty';
  }
  if (pattern.length > TREE_PATTERN_MAX_CHARS) {
    return `is longer than ${TREE_PATTERN_MAX_CHARS} characters`;
  }
  if (/[\u0000-\u001f\u007f]/.test(pattern)) {
    return 'contains a control character';
  }
  if (pattern.includes('\\')) {
    return 'uses a backslash — paths use forward slashes';
  }
  if (pattern.startsWith('/')) {
    return 'is absolute — paths are relative to the repository root';
  }
  if (/^[A-Za-z]:/.test(pattern)) {
    return 'is a Windows absolute path — paths are relative to the repository root';
  }
  if (pattern.startsWith('~')) {
    return "starts with '~' — paths are relative to the repository root, never to a home directory";
  }
  if (/[{}]/.test(pattern)) {
    return 'uses brace expansion, which is not supported — write one probe per alternative';
  }

  for (const segment of pattern.split('/')) {
    if (segment === '') {
      return "has an empty segment (a leading, doubled or trailing '/')";
    }
    if (segment === '..') {
      return "contains a '..' segment and could leave the worktree";
    }
    if (segment === '.') {
      return "contains a '.' segment — write the path without it";
    }
    if (segment.includes('**') && segment !== '**') {
      return "uses '**' inside a segment — '**' must be a whole segment, e.g. 'docs/**/*.md'";
    }
  }

  return undefined;
}

/** True when `pattern` contains a wildcard, i.e. may select more than one file. */
export function isTreeGlob(pattern: string): boolean {
  return /[*?]/.test(pattern);
}
