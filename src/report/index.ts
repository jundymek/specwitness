/**
 * The report layer's public surface — story 3.6.
 *
 * `src/cli/commands/report.ts` (story 3.5) and `verify` (story 3.7) import
 * from here and nowhere else inside `src/report/`. Keeping the surface to two
 * functions is what makes AD-11 checkable rather than aspirational: there is
 * one model, and exactly two ways to render it.
 *
 * Both take a `RunResult` and nothing else — no clock, no store, no config, no
 * options bag — and both return a string rather than printing. The signature
 * is the architecture: a fact a renderer is not handed is a fact it cannot
 * invent, and a string-returning renderer lets its caller own stream
 * discipline (under `--json`, the JSON document is the whole of stdout and
 * every human line goes to stderr).
 */

export { renderTerminal } from './terminal.js';
export { renderJson } from './json.js';
