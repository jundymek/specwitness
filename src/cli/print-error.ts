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
