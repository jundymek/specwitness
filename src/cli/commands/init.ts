import type { Command } from 'commander';

import { InfraError } from '../../domain/errors.js';
import { PROJECT_DIR, isGitRepository, scaffold } from '../../infra/scaffold.js';

/**
 * FR-1 — `specwitness init`: one-command onboarding in any Git repository.
 *
 * Deliberately prompt-free (agent-callable): `--force` is the only path that
 * overwrites anything, so there is nothing to confirm and nothing that can
 * block on a TTY. It spawns no subprocess, reads no environment variable and
 * makes no network call — repository detection is a filesystem read.
 *
 * Scaffolding happens at the current working directory. There is no upward
 * search for a project root: `init` writes where it is pointed or refuses
 * (`--root` arrives in Epic 3).
 */
export function register(program: Command): void {
  program
    .command('init')
    .description('scaffold .specwitness/ in the current Git repository')
    .addHelpText(
      'after',
      '\nRun this at the project root — the directory holding .git — because\n' +
        `${PROJECT_DIR}/ is created in the current directory and is not searched for\n` +
        'upward.\n\n' +
        `Re-running is safe: anything missing from ${PROJECT_DIR}/ is created and\n` +
        'nothing existing is modified. --force replaces config.yaml only, and never\n' +
        'the contents of contracts/, plans/ or runs/.\n',
    )
    .option('--force', 'overwrite an existing config.yaml (nothing else is replaced)')
    .action(async (options: { force?: boolean }) => {
      const projectRoot = process.cwd();

      if (!(await isGitRepository(projectRoot))) {
        // InfraError, not UsageError: the invocation is well-formed, the
        // environment is not ready. The global handler renders ERROR/HINT and
        // maps this to exit 3 (ADR-002).
        throw new InfraError(
          `${projectRoot} is not a Git repository`,
          "run inside a Git repository or 'git init' first.",
        );
      }

      report(await scaffold(projectRoot, { force: options.force === true }));
    });
}

/**
 * Prints what happened, one line per path.
 *
 * stdout only: these are the command's output, not diagnostics. The summary
 * always states whether an existing config was kept, because "nothing was
 * overwritten" is the outcome a user re-running `init` most needs to see.
 */
function report(result: Awaited<ReturnType<typeof scaffold>>): void {
  const lines: string[] = [];

  for (const path of result.created) {
    lines.push(`  created  ${path}`);
  }
  for (const path of result.replaced) {
    lines.push(`  replaced ${path}`);
  }
  for (const path of result.skipped) {
    lines.push(`  exists   ${path}`);
  }

  if (result.created.length > 0 || result.replaced.length > 0) {
    lines.push('');
    lines.push(`Next: edit ${PROJECT_DIR}/config.yaml, then run 'specwitness doctor'.`);
  }

  if (!result.configWritten) {
    lines.push('');
    lines.push(
      `Left ${PROJECT_DIR}/config.yaml untouched. Re-run with --force to replace it ` +
        'with a fresh skeleton.',
    );
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}
