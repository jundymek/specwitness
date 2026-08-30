import { fileURLToPath } from 'node:url';

import { execa } from 'execa';

/**
 * Integration tests assert on the real bin entry — shebang, bundling, exit
 * codes and stderr shape as a user's shell sees them — so the bundle has to
 * exist before they run. Building here keeps `pnpm test` self-contained
 * instead of silently depending on a stale `dist/` from an earlier build.
 */
export async function setup(): Promise<void> {
  await execa('pnpm', ['exec', 'tsup'], {
    // fileURLToPath, not `.pathname`: a checkout path containing a space or `#`
    // comes back percent-encoded from `.pathname` ("/work/my%20repo"), which is
    // not a real directory, so global setup would fail for the whole suite.
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    stdio: 'pipe',
  });
}
