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
 * unresolvable. Doctor and the gate runner therefore agree about WHICH TOKEN IS
 * THE EXECUTABLE, and `tests/unit/pipeline/stages/gate-command.test.ts` pins
 * that against `firstToken()` with a property rather than leaving it to this
 * comment. A command doctor calls broken does not silently work at verify time.
 *
 * THE AGREEMENT IS ABOUT THE TOKEN, NOT ABOUT WHETHER IT RESOLVES — stated
 * because the broader claim is tempting and false. Doctor resolves a relative
 * executable (`./scripts/check`) against the PROJECT ROOT; it runs before any
 * worktree exists and structurally cannot do otherwise. Gates run in the
 * verification worktree at the head SHA (AD-8), and must, since spawning in the
 * source repo would verify the wrong tree. So a script that is present in the
 * operator's working copy but UNTRACKED, or absent from the revision under
 * verification, passes doctor and then genuinely cannot be executed by a gate.
 * That is correct behaviour on both sides rather than a defect in either, and
 * the remedy is a diagnosis that names it: `notFoundError` in `gates.ts` tells
 * such an operator to COMMIT the file rather than to install it or to edit
 * their PATH.
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
 *  1. THE EXECUTABLE TOKEN is read exactly as `firstToken` reads it: a quote is
 *     significant only at position 0. `"/opt/my tools/runner"` is one token —
 *     the reason quote handling exists at all, since a path containing spaces
 *     must resolve — while `x"y"z` is one token whose text merely contains
 *     quote characters. This is not a stylistic choice: doctor RESOLVES that
 *     token, so the two must agree about which token it is, or doctor stops
 *     predicting whether a gate can run.
 *
 *  2. ARGUMENT TOKENS are grouped with full quote awareness, so
 *     `tool --label="hello world"` is ONE argv element rather than two.
 *     Nothing resolves an argument, so there is no agreement to preserve — and
 *     losing the grouping means the gate does not execute as declared, which
 *     avoiding a shell never required. (Found in review; the earlier version
 *     applied rule 1 to every token and silently split such arguments.)
 *
 *     Keeping the two rules distinct is what lets both properties hold at once:
 *     exact agreement with doctor on the executable, faithful grouping on the
 *     arguments. A single rule cannot do both, because full quote awareness on
 *     the first token would make `x"y z"` resolve to `xy z` while doctor still
 *     reports `x"y`.
 *
 *  3. An unclosed quote degrades THAT TOKEN to a bare token, quote included; it
 *     does not change how the rest of the line is read. Found by the property
 *     test rather than reasoned out: an earlier version checked balance across
 *     the WHOLE line and fell back to a plain whitespace split, so it disagreed
 *     with `firstToken` on input like `'''` — where `firstToken` yields the
 *     empty string (a closed empty quote) and a whole-line fallback yields the
 *     literal three characters.
 */
function readExecutable(line: string, from: number): { token: string; next: number } {
  const char = line[from];

  if (char !== undefined && QUOTES.has(char)) {
    const closing = line.indexOf(char, from + 1);
    if (closing !== -1) {
      return { token: line.slice(from + 1, closing), next: closing + 1 };
    }
    // Unclosed: fall through and read it bare, quote included — exactly what
    // doctor reports as the token it could not resolve.
  }

  const end = endOfBareToken(line, from);
  return { token: line.slice(from, end), next: end };
}

/**
 * Read one ARGUMENT, honouring quotes wherever they appear inside it.
 *
 * An unterminated quote makes the whole token bare from its start, so
 * `node "ok" "dangling` keeps its final token as the literal `"dangling`
 * rather than swallowing the rest of the line — the same honest degradation
 * rule 3 applies to the executable.
 */
function readArgument(line: string, from: number): { token: string; next: number } {
  let buffer = '';
  let quote: string | undefined;
  let index = from;

  while (index < line.length) {
    const char = line[index];
    if (char === undefined) {
      break;
    }

    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else {
        buffer += char;
      }
      index += 1;
      continue;
    }

    if (SEPARATOR.test(char)) {
      break;
    }

    if (QUOTES.has(char)) {
      quote = char;
      index += 1;
      continue;
    }

    buffer += char;
    index += 1;
  }

  if (quote !== undefined) {
    const end = endOfBareToken(line, from);
    return { token: line.slice(from, end), next: end };
  }

  return { token: buffer, next: index };
}

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

    const read = tokens.length === 0 ? readExecutable(line, index) : readArgument(line, index);
    // An empty quoted token is a REAL argument (`cmd '' x`); dropping it would
    // silently change the command the operator declared.
    tokens.push(read.token);
    index = read.next;
  }

  return tokens;
}

/**
 * Does this command line use backslash escaping of a quote?
 *
 * WHY THIS IS DETECTED AND REFUSED RATHER THAN SUPPORTED.
 *
 * `node -e "console.log(\\"ok\\")"` is a command an operator can reasonably
 * write, and this tokenizer would mis-group it: the escaped quote closes the
 * segment, the argument is corrupted, the child exits non-zero — and the run
 * reports a **product FAIL**. A configuration problem blamed on the branch is
 * the worst answer this stage can give, so the ambiguity is refused loudly and
 * classified as what it is.
 *
 * Refused rather than implemented, deliberately, for three reasons:
 *
 *  1. **There is already a working way to express it.** `-e 'console.log("ok")'`
 *     tokenizes correctly today, because the other quote style groups the whole
 *     value. Escaping is a convenience with an alternative, not a capability
 *     gap — unlike quote GROUPING, without which an argument containing a space
 *     cannot be expressed at all. That is the line between the two.
 *  2. **Doctor's `firstToken` has no escape handling either.** Adding it here
 *     would make the two disagree about the executable for a first token
 *     containing an escape, reintroducing exactly what the property test guards.
 *  3. **Each increment of this kind ends at a shell parser**, in a product whose
 *     security posture is that there is no shell. Grouping was necessary;
 *     escaping, expansion and operators are not, and the boundary is easier to
 *     hold at a stated limit than at a gradient.
 *
 * DELIBERATELY BROAD: any backslash immediately before a quote is refused.
 *
 * An earlier revision narrowed this to quotes followed by more content, so
 * that an ordinary Windows argument like a directory ending in a separator
 * would pass. That narrowing was wrong, and reverting it is the point of this
 * comment rather than an accident of it.
 *
 * A backslash before a quote is genuinely AMBIGUOUS under a tokenizer with no
 * escape convention, and every rule for telling "intended escape" from
 * "literal backslash" is a guess. Each guess has a gap, and the two gaps are
 * not equally costly:
 *
 *  - Refusing a valid command is LOUD. Exit 3, a message naming the cause, and
 *    an operator who rewrites the argument. Recoverable in one edit.
 *  - Failing to refuse an ambiguous one is SILENT. The argument mis-groups, the
 *    child receives something the operator never wrote, it exits non-zero, and
 *    the run reports a PRODUCT FAIL — a configuration problem blamed on the
 *    branch. That is the single wrong answer this whole story exists to
 *    prevent.
 *
 * So the broad rule is kept even though it refuses commands that would have
 * tokenized correctly. The workaround is stated in the hint and costs nothing:
 * use the other quote style, or write the path with forward slashes, which
 * Node accepts on Windows too.
 *
 * A backslash anywhere else — a regex, a path mid-argument, a separator not
 * adjacent to a quote — is an ordinary character and stays one.
 */
export function usesUnsupportedEscaping(commandLine: string): boolean {
  return /\\["']/.test(commandLine);
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
