import type { Command } from 'commander';

import { InfraError } from '../../domain/errors.js';

/**
 * Stub. Story 1.4 replaces the body of this file and nothing else — this
 * per-command file is the ownership seam that lets wave C (1.4/1.5/1.6) run in
 * parallel without three PRs colliding on `main.ts`.
 *
 * The stub throws rather than printing and exiting inline: exit 3 must come
 * from the one exit table, and routing through the global handler keeps a
 * single ERROR/HINT print path.
 */
export function register(program: Command): void {
  program
    .command('init')
    .description('scaffold .specwitness/ in the current Git repository')
    .action(() => {
      throw new InfraError("'init' is not implemented yet", 'it arrives later in Epic 1');
    });
}
