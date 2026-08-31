/**
 * Turning a declared command line into a binary and an argument array (AD-3).
 *
 * WHY THIS FILE EXISTS. `DeclaredCommand` is a command-line STRING (`pnpm lint`)
 * — that is the shape the project writes in `.specwitness/config.yaml`. The
 * merged `ProcessRunner` takes a `binary` plus an `args[]` array and has no
 * `shell` option, deliberately: argv-not-a-string is the entire AD-3 mechanism,
 * the thing that makes it impossible for text a model wrote to become an
 * executable command. Something has to bridge those two shapes, and story 3.4
 * is the first module in the product that actually executes a project-declared
 * command, so the bridge is here.
 *
 * WHAT MAKES IT SAFE, stated because this is the boundary's first load-bearing
 * use rather than a theoretical one:
 *
 *   - This goes in the SAFE DIRECTION ONLY. `src/config/declared-command.ts` is
 *     explicit that `DeclaredCommand -> string` is free (reading a declared
 *     command is safe; doctor already resolves one on PATH) while
 *     `string -> DeclaredCommand` is unavailable outside `src/config/`. Nothing
 *     here mints, casts, or imports the brand, and
 *     `tests/unit/config/boundary-scan.test.ts` rejects all three mechanically
 *     across every file under `src/` outside `src/config/`.
 *   - The output is a binary and an argument array. There is no shell on this
 *     path and no way to add one without editing the port, so `&&`, `$(...)`,
 *     `*` and `;` below are inert text that arrives at the child as literal
 *     argv elements. The merged runner proves that one layer down; this module
 *     proves it does not helpfully "handle" them on the way in.
 *
 * THIS IS NOT A SHELL PARSER, and the consequence is stated rather than hidden:
 * no variable expansion, no globbing, no operators, no escapes, no redirection.
 * A command written in shell syntax (`a && b`, `FOO=bar cmd`, a leading `cd`)
 * does not run as written. That is not a regression introduced here — the
 * merged `src/cli/doctor/checks/commands-resolvable.ts` already documents
 * exactly this and already reports such a command's literal first token as
 * unresolvable. Doctor and the gate runner therefore AGREE: a command doctor
 * calls broken does not silently work at verify time, and one doctor calls fine
 * is one the runner can spawn. `tests/unit/pipeline/stages/gate-command.test.ts`
 * pins that agreement against `firstToken()` with a property rather than
 * leaving it to this comment.
 *
 * SHAPE. `splitCommandLine` takes a plain `string`, not a `DeclaredCommand`,
 * following the merged precedent for this exact problem: `firstToken(command:
 * string)` is exported and its caller does `firstToken(commandText(...))`. The
 * AD-3 boundary is expressed at the single call site in `gates.ts`, which
 * obtains its input from `commandText(gate.run)` and from nowhere else.
 *
 * AD-1: pure. No I/O, no clock, no randomness, total for every input.
 */

/** A command line resolved into what `ProcessRunner.run` needs. */
export interface SplitCommand {
  /**
   * The executable token. `''` when the command line carries none — the STAGE
   * decides that an empty binary is an `InfraError`, because classification is
   * a stage concern and a pure splitter that threw would move it here.
   */
  readonly binary: string;
  /** Passed verbatim to the child. Never word-split or expanded again. */
  readonly args: readonly string[];
}

/** Whitespace that separates tokens. Not locale-dependent. */
const SEPARATOR = /\s/;

const QUOTES = new Set(['"', "'"]);

/** Read an unquoted run up to the next separator. Returns the end index. */
function endOfBareToken(line: string, from: number): number {
  let index = from;
  while (index < line.length) {
    const next = line[index];
    if (next === undefined || SEPARATOR.test(next)) {
      break;
    }
    index += 1;
  }
  return index;
}

/**
 * Tokenize a command line into `[binary, ...args]`.
 *
 * Two rules, both chosen to match `firstToken` exactly rather than to be
 * independently reasonable:
 *
 *  1. A quote is significant ONLY at the start of a token. So
 *     `"/opt/my tools/runner"` is one token — the reason quote handling exists
 *     at all, since a path containing spaces must resolve — while `x"y"z` is
 *     one token whose text merely contains quote characters.
 *
 *  2. An unclosed quote degrades THAT TOKEN to a bare token; it does not change
 *     how the rest of the line is read. This is the subtle one, and it was found
 *     by the property test rather than reasoned out: an earlier version checked
 *     balance across the WHOLE line and fell back to a plain whitespace split
 *     when it failed. `firstToken` looks only at the first token, so the two
 *     disagreed on input like `'''` — where `firstToken` yields the empty string
 *     (a closed empty quote) and a whole-line fallback yields `'''`. A
 *     disagreement about which token is the executable is precisely what makes
 *     doctor's verdict stop predicting whether a gate can run.
 */
function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let index = 0;

  while (index < line.length) {
    const char = line[index];
    if (char === undefined) {
      break;
    }
    if (SEPARATOR.test(char)) {
      index += 1;
      continue;
    }

    if (QUOTES.has(char)) {
      const closing = line.indexOf(char, index + 1);
      if (closing !== -1) {
        // An empty quoted token is a REAL argument (`cmd '' x`); dropping it
        // would silently change the command the operator declared.
        tokens.push(line.slice(index + 1, closing));
        index = closing + 1;
        continue;
      }
      // Unclosed: this token is the literal text, quote included — exactly what
      // doctor reports as the token it could not resolve.
    }

    const start = index;
    index = endOfBareToken(line, index);
    tokens.push(line.slice(start, index));
  }

  return tokens;
}

/**
 * Resolve a command line into the binary to spawn and its arguments.
 *
 * Total: every string produces a value, including `''` and whitespace-only
 * input (which `nonEmptyString`'s `min(1)` permits). Both yield an empty
 * `binary`, which the gates stage classifies as an `InfraError` — SpecWitness
 * could not run the gate, which is not the same as the branch being broken.
 */
export function splitCommandLine(commandLine: string): SplitCommand {
  const [binary, ...args] = tokenize(commandLine);
  return { binary: binary ?? '', args };
}
