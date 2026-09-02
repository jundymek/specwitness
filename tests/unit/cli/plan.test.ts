import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runPlan } from '../../../src/cli/commands/plan.js';
import { buildProgram } from '../../../src/cli/main.js';
import { UsageError } from '../../../src/domain/errors.js';
import { ConstantIds, FixedClock } from '../../fakes/ports.js';

/**
 * Unit guards for the `plan` command's EDGE properties.
 *
 * The command's behaviour is proven end to end against the built binary in
 * `tests/integration/plan.test.ts`, which is stronger evidence than a unit test could be —
 * it runs the real commander wiring, the real fake adapter and the real filesystem. What is
 * asserted here is the handful of properties an end-to-end test cannot show, or can only
 * show by accident.
 */

const SOURCE = fileURLToPath(new URL('../../../src/cli/commands/plan.ts', import.meta.url));

describe('the command is registered on the program', () => {
  it('appears in `specwitness --help` with its epic argument', () => {
    const plan = buildProgram()
      .commands.find((command) => command.name() === 'plan');

    expect(plan).toBeDefined();
    expect(plan?.description()).toContain('compile');
  });

  it('carries exactly one option, --force', () => {
    // Kept minimal deliberately. `--no-ai` belongs to story 4.7 and to `verify`, not here;
    // adding it in this story would put two stories' answers in one flag surface.
    const plan = buildProgram().commands.find((command) => command.name() === 'plan');

    expect(plan?.options.map((option) => option.long)).toEqual(['--force']);
  });
});

describe('a malformed epic id is a usage error, raised before any I/O', () => {
  it.each(['seven', '', 'epic-', '0', '-3'])('refuses %o with UsageError (exit 64)', async (bad) => {
    // Normalisation happens FIRST, so this holds from any working directory and without a
    // project: an operator who typed the id wrong must be told that, not "run init".
    await expect(runPlan(bad, {}, new FixedClock('2026-09-01T10:20:30.000Z'), new ConstantIds('k3n8v2qz7m4d1p6b'))).rejects.toThrow(
      UsageError,
    );
  });
});

describe('AD-7: this command defines no exit code of its own', () => {
  it('contains no process.exit or process.exitCode', async () => {
    // `tests/unit/exit-location.test.ts` scans all of `src/` for this; asserting it here as
    // well keeps the property attached to the file it is about, so a future edit fails with
    // a message that names this command rather than a directory listing.
    const source = await readFile(SOURCE, 'utf8');

    expect(source).not.toMatch(/process\s*\.\s*exit\s*\(/);
    expect(source).not.toMatch(/process\s*\.\s*exitCode/);
  });
});

describe('prompt-free: nothing on this path can block on a terminal', () => {
  it('never reads a TTY, opens readline, or prompts', async () => {
    // The spine names `plan` in "Non-interactive first" alongside verify, report, doctor and
    // `contract --status`. Story 4.7 auto-compiles from inside `verify`, which would deadlock
    // against a prompt — and a harness invoking this with a closed stdin would hang rather
    // than fail, which is the worst failure mode available.
    //
    // The integration suite passes `input: ''` to every invocation, which proves the same
    // thing dynamically. This is the static half: it fails at the moment somebody ADDS a
    // prompt, naming the file, rather than when a test later times out.
    const source = await readFile(SOURCE, 'utf8');

    expect(source).not.toContain('readline');
    expect(source).not.toContain('isTTY');
    expect(source).not.toContain('process.stdin');
    expect(source).not.toMatch(/\bprompt\s*\(/);
  });
});
