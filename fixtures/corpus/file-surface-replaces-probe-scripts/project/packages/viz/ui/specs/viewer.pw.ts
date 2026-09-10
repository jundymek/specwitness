// A UI suite spec, shaped like gitnebula's. It is never run — the corpus only
// reads it — and it carries the exact trap `ui-source-census.mjs` fell into: the
// forbidden spelling appears here ONLY in comments, which a regex over raw
// source counts and a comment-aware count does not.
import { HARNESS_HANDLE_KEY } from '../support/handle.js';

// Never spell "__gitnebula" in a spec — import HARNESS_HANDLE_KEY instead.
/* A block comment quoting it too: "__gitnebula" */
// Nor '__gitnebula', nor `__gitnebula` — no quote style belongs in code.
const docs = 'see a // inside a string: it is not a comment'; // this one is

export function readHandle(target: Record<string, unknown>): unknown {
  return target[HARNESS_HANDLE_KEY] ?? docs;
}
