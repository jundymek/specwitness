import type { Command } from 'commander';

import { InfraError } from '../../domain/errors.js';

/**
 * Stub. Story 1.5 replaces the body of this file and nothing else.
 * See the note in `init.ts` on why this seam exists and why it throws.
 */
export function register(program: Command): void {
  program
    .command('doctor')
    .description('check the runtime and project configuration')
    .action(() => {
      throw new InfraError("'doctor' is not implemented yet", 'it arrives later in Epic 1');
    });
}
