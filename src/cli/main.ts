import { Command, CommanderError } from 'commander';

import { UsageError, isSpecWitnessError } from '../domain/errors.js';
import { register as registerContract } from './commands/contract.js';
import { register as registerDoctor } from './commands/doctor.js';
import { register as registerInit } from './commands/init.js';
import { register as registerReport } from './commands/report.js';
import { EXIT, applyExitCode, exitCodeForError, type ExitCode } from './exit.js';
import { printError } from './print-error.js';

/** Injected at build time by tsup, and by vitest for source-level runs. */
declare const __SW_VERSION__: string;

const HELP_HINT = "run 'specwitness --help' to see the available commands and flags";

/**
 * Builds the commander program.
 *
 * Two settings here carry the whole AC1 contract:
 *
 * - `exitOverride()` stops commander calling `process.exit` itself. Without it
 *   there would be a second definition of exit codes in the codebase, outside
 *   `cli/exit.ts`, and commander's own codes (1, 2) collide with FAIL and
 *   NEEDS_HUMAN.
 * - `configureOutput({ writeErr, outputError })` silences commander's own
 *   error text, so stderr carries exactly one `ERROR:`/`HINT:` pair rather
 *   than commander's message plus ours.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('specwitness')
    .description(
      'Independent verification gate for agentic software development.\n' +
        'Proves, with reproducible evidence, whether an assembled epic satisfies\n' +
        'its frozen specification — before the epic branch merges.',
    )
    .version(__SW_VERSION__, '-V, --version', 'print the SpecWitness version')
    .exitOverride()
    .configureOutput({
      // Help and other requested output stay on stdout.
      writeOut: (str) => process.stdout.write(str),
      // Commander's diagnostics are discarded; the global handler prints ours.
      writeErr: () => {},
      outputError: () => {},
    })
    // Dumping full help after an error would bury the ERROR/HINT pair.
    .showHelpAfterError(false)
    .showSuggestionAfterError(false);

  registerInit(program);
  registerDoctor(program);
  registerContract(program);
  registerReport(program);

  return program;
}

/**
 * Parses and dispatches, returning the exit code rather than exiting, so this
 * is testable and so the process-exit write stays in `exit.ts` alone.
 *
 * This is the only place in the codebase that catches broadly (AD-7).
 */
export async function run(argv: readonly string[]): Promise<ExitCode> {
  try {
    if (argv.length === 0) {
      // Fail closed. Exit 0 means "merge-eligible" to the harness, so a bare
      // invocation must never produce it; ask for --help explicitly instead.
      throw new UsageError('no command given', HELP_HINT);
    }

    await buildProgram().parseAsync([...argv], { from: 'user' });
    return EXIT.PASS;
  } catch (err) {
    return handle(err);
  }
}

function handle(err: unknown): ExitCode {
  if (err instanceof CommanderError) {
    // `--help` and `--version` are successful requests that commander reports
    // by throwing with exit code 0. Their output has already been written.
    if (err.exitCode === 0) {
      return EXIT.PASS;
    }
    // Every parse failure — unknown command, unknown flag, missing argument —
    // is a usage error (AC1). Commander prefixes its messages with "error: ".
    printError(err.message.replace(/^error:\s*/i, ''), HELP_HINT);
    return EXIT.USAGE;
  }

  if (isSpecWitnessError(err)) {
    printError(err.message, err.hint);
    return exitCodeForError(err);
  }

  // AD-7 fail closed: an unclassified exception is infrastructure (3), never
  // a product verdict.
  printError(
    `unexpected internal failure: ${describeUnknown(err)}`,
    'this is a SpecWitness bug — please report it with the command you ran',
  );
  return exitCodeForError(err);
}

function describeUnknown(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  if (typeof err === 'string') {
    return err;
  }
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

applyExitCode(await run(process.argv.slice(2)));
