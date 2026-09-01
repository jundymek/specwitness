/**
 * House style for user-facing failures (spine Consistency Conventions):
 *
 *   ERROR: <what went wrong>
 *   HINT: <how to fix it>
 *
 * Both go to **stderr**. stdout is reserved for command output — the harness
 * parses it — so a diagnostic there would corrupt a machine-readable result.
 *
 * There is exactly one caller (the global handler in `main.ts`), which is what
 * guarantees exactly one ERROR/HINT pair per failure. Commander's own error
 * output is suppressed via `configureOutput` so it cannot double-print.
 */
export function printError(message: string, hint?: string): void {
  process.stderr.write(`ERROR: ${message}\n`);
  if (hint !== undefined && hint !== '') {
    process.stderr.write(`HINT: ${hint}\n`);
  }
}

/**
 * `WARNING: <what happened>` on stderr — something the operator should know
 * about a command that nonetheless SUCCEEDED.
 *
 * A third level exists because there is a third condition. `ERROR:` says the
 * thing you asked for did not happen; this says it did, and something about it
 * is worth knowing. The case it was added for is the durability barrier after a
 * contract write: `rename(2)` published the file, so reporting a failed write
 * would be false, and saying nothing at all would hide a real fsync failure
 * behind a clean exit (Epic 2 retrospective §5a defect (ii), and the review that
 * pointed out the first fix traded a lie for a silence).
 *
 * stderr, like every other diagnostic, so stdout stays parseable.
 */
export function printWarning(message: string): void {
  process.stderr.write(`WARNING: ${message}\n`);
}
