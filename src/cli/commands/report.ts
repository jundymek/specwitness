import type { Command } from 'commander';

import { InfraError } from '../../domain/errors.js';

/**
 * Stub. Story 1.6 replaces the body of this file and nothing else.
 * See the note in `init.ts` on why this seam exists and why it throws.
 */
export function register(program: Command): void {
  program
    .command('report')
    .description('render a stored run')
    .action(() => {
      throw new InfraError("'report' is not implemented yet", 'it arrives later in Epic 1');
    });
}
