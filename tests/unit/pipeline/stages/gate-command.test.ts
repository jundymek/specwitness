import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { firstToken } from '../../../../src/cli/doctor/checks/commands-resolvable.js';
import {
  splitCommandLine,
  usesUnsupportedEscaping,
} from '../../../../src/pipeline/stages/gate-command.js';

/**
 * The `DeclaredCommand` -> `binary` + `argv` split (AD-3).
 *
 * Story 3.4 is the first module in the product that actually EXECUTES a
 * project-declared command, so this is where the command line stops being text
 * and becomes an `execve`. The property that matters is not tested here but
 * expressed by the signature: `ProcessRunner` takes a binary and an argument
 * array and has no `shell` option, so nothing below can produce a shell string
 * however hostile its input.
 *
 * What IS tested here is agreement with doctor. `firstToken()` in
 * `src/cli/doctor/checks/commands-resolvable.ts` decides which token doctor
 * resolves on PATH; `splitCommandLine()` decides which binary actually gets
 * spawned. If those two ever disagree, doctor's verdict stops predicting
 * whether a gate can run — it would pass a command that cannot start, or fail
 * one that runs perfectly well. That is a cross-module contract, so it is
 * pinned by a property rather than by a comment.
 */

describe('splitCommandLine: the ordinary shapes', () => {
  it('splits a bare binary with no arguments', () => {
    expect(splitCommandLine('pnpm')).toEqual({ binary: 'pnpm', args: [] });
  });

  it('splits a binary and its arguments on whitespace', () => {
    expect(splitCommandLine('pnpm run lint')).toEqual({
      binary: 'pnpm',
      args: ['run', 'lint'],
    });
  });

  it('collapses runs of whitespace, including tabs and newlines', () => {
    expect(splitCommandLine('  pnpm \t run\n  lint  ')).toEqual({
      binary: 'pnpm',
      args: ['run', 'lint'],
    });
  });

  it('honours a quoted first token so a path containing spaces resolves', () => {
    // The reason doctor's firstToken handles quotes at all.
    expect(splitCommandLine('"/opt/my tools/runner" --ci')).toEqual({
      binary: '/opt/my tools/runner',
      args: ['--ci'],
    });
  });

  it('honours single quotes the same way as double quotes', () => {
    expect(splitCommandLine("'/opt/my tools/runner' --ci")).toEqual({
      binary: '/opt/my tools/runner',
      args: ['--ci'],
    });
  });

  it('honours a quoted ARGUMENT containing spaces', () => {
    expect(splitCommandLine('node -e "process.exit(1)" --flag')).toEqual({
      binary: 'node',
      args: ['-e', 'process.exit(1)', '--flag'],
    });
  });

  it('keeps a quoted ARGUMENT VALUE as one argv element', () => {
    // `--label="hello world"` is an ordinary shape and it must reach the child
    // as ONE argument. Splitting it means the gate does not execute as the
    // operator declared it — and avoiding a shell never required losing quote
    // grouping, only quote INTERPRETATION.
    expect(splitCommandLine('tool --label="hello world"')).toEqual({
      binary: 'tool',
      args: ['--label=hello world'],
    });
  });

  it('keeps a single-quoted argument value together too', () => {
    expect(splitCommandLine("jest --testPathPattern='a b'")).toEqual({
      binary: 'jest',
      args: ['--testPathPattern=a b'],
    });
  });

  it('handles a quoted segment in the middle of an argument', () => {
    expect(splitCommandLine('tool --x=a"b c"d')).toEqual({
      binary: 'tool',
      args: ['--x=ab cd'],
    });
  });

  it('still splits on whitespace OUTSIDE a quoted argument value', () => {
    expect(splitCommandLine('tool --label="a b" --other c')).toEqual({
      binary: 'tool',
      args: ['--label=a b', '--other', 'c'],
    });
  });

  it('applies quote grouping to arguments but NOT to the executable token', () => {
    // The asymmetry is deliberate and is what lets both properties hold: doctor
    // RESOLVES the executable, so that token must be read exactly as doctor
    // reads it; nothing resolves an argument, so grouping it faithfully costs
    // no agreement. A single rule cannot do both.
    //
    // Only the EXECUTABLE is pinned here. A first token with an embedded quote
    // is malformed, no grouping of the remainder is more correct than another,
    // and asserting one would pin behaviour nobody relies on — what matters is
    // that doctor and the runner still name the same token, so both fail on it
    // the same way.
    const malformed = 'x"y z" --label="a b"';
    expect(splitCommandLine(malformed).binary).toBe(firstToken(malformed));
    expect(splitCommandLine(malformed).binary).toBe('x"y');
  });

  it('treats a quote that does not START a token as a literal character', () => {
    // Matches firstToken, which only strips a quote at position 0. `x"y"z` is
    // one token whose text contains quotes, not an assembled `xyz`.
    expect(splitCommandLine('x"y"z arg')).toEqual({ binary: 'x"y"z', args: ['arg'] });
  });

  it('falls back to whitespace splitting when a quote is never closed', () => {
    // Deliberately NOT "read to end of line": doctor reports `"unterminated`
    // as the token it could not resolve, and the runner must agree.
    expect(splitCommandLine('"unterminated a b')).toEqual({
      binary: '"unterminated',
      args: ['a', 'b'],
    });
  });

  it('degrades only the UNCLOSED token, not the rest of the line', () => {
    // Regression, found by the property below rather than reasoned out. An
    // earlier version checked quote balance across the whole line and fell back
    // to a plain whitespace split when it failed. `firstToken` looks only at the
    // first token, so the two disagreed here: the leading `''` is a closed empty
    // quote and only the third quote is unclosed.
    expect(splitCommandLine("'''")).toEqual({ binary: '', args: ["'"] });
    expect(splitCommandLine("'''")).toEqual({
      binary: firstToken("'''"),
      args: ["'"],
    });
  });

  it('keeps a closed first token when a LATER token is unclosed', () => {
    expect(splitCommandLine('node "ok" "dangling')).toEqual({
      binary: 'node',
      args: ['ok', '"dangling'],
    });
  });
});

describe('splitCommandLine: nothing is ever interpreted (AD-3)', () => {
  it('passes shell metacharacters through as literal argv elements', () => {
    // There is no shell anywhere on this path, so these are inert text. The
    // merged ProcessRunner proves the same property one layer down; this proves
    // the splitter does not helpfully "handle" them on the way in.
    expect(splitCommandLine('echo a && rm -rf /')).toEqual({
      binary: 'echo',
      args: ['a', '&&', 'rm', '-rf', '/'],
    });
  });

  it('does not expand a command substitution', () => {
    expect(splitCommandLine('echo $(whoami)')).toEqual({
      binary: 'echo',
      args: ['$(whoami)'],
    });
  });

  it('does not expand a variable or a glob', () => {
    expect(splitCommandLine('echo $HOME *.ts')).toEqual({
      binary: 'echo',
      args: ['$HOME', '*.ts'],
    });
  });

  it('treats a leading assignment as the BINARY, not as an environment prefix', () => {
    // `FOO=bar cmd` is shell syntax. Under AD-3 it does not run as written, and
    // doctor already reports `FOO=bar` as the unresolvable token. The honest
    // outcome is a binary that cannot be found -> InfraError -> exit 3, not a
    // silent success and not a product FAIL.
    expect(splitCommandLine('FOO=bar npm test')).toEqual({
      binary: 'FOO=bar',
      args: ['npm', 'test'],
    });
  });
});

describe('splitCommandLine: totality', () => {
  it('reports an empty binary for an empty command rather than throwing', () => {
    // Total, like firstToken. The STAGE decides that an empty binary is an
    // InfraError; a pure splitter that threw would move that decision here.
    expect(splitCommandLine('')).toEqual({ binary: '', args: [] });
  });

  it('reports an empty binary for a whitespace-only command', () => {
    // `nonEmptyString` in the config schema is `min(1)`, which "   " satisfies.
    expect(splitCommandLine('   \t \n ')).toEqual({ binary: '', args: [] });
  });

  it('never returns undefined or null inside args', () => {
    const { args } = splitCommandLine('a  b   c');
    expect(args.every((a) => typeof a === 'string')).toBe(true);
  });
});

describe('splitCommandLine agrees with doctor about the executable', () => {
  /**
   * The cross-module contract. Doctor tells an operator "this command
   * resolves"; the gate runner then spawns something. If they disagree about
   * WHICH token is the executable, doctor's answer stops predicting whether a
   * gate can run — the worst kind of diagnostic, because it is confidently
   * wrong rather than silent.
   */
  const CORPUS = [
    'pnpm lint',
    'pnpm run build',
    'node -e "process.exit(0)"',
    '"/opt/my tools/runner" --ci',
    "'/opt/my tools/runner' --ci",
    './scripts/gate.sh',
    '/usr/local/bin/thing --x',
    'x"y"z arg',
    '"unterminated a b',
    'FOO=bar npm test',
    'a && b',
    'echo $(whoami)',
    '   spaced   out   ',
    '',
    '   ',
    'single',
    // Counterexamples the property found. Kept as named cases so a future
    // reader sees WHICH shapes are load-bearing rather than trusting 500
    // random runs to rediscover them.
    "'''",
    '"""',
    "'",
    "''",
    'node "ok" "dangling',
  ];

  it.each(CORPUS)('binary matches firstToken for %j', (command) => {
    expect(splitCommandLine(command).binary).toBe(firstToken(command));
  });

  it('agrees with firstToken on arbitrary command lines', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[ \t]*[!-~]{0,12}([ \t]+[!-~]{0,12}){0,4}[ \t]*$/),
        (command) => {
          expect(splitCommandLine(command).binary).toBe(firstToken(command));
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('splitCommandLine: reassembly keeps every token', () => {
  it('loses no token from an unquoted command line', () => {
    const { binary, args } = splitCommandLine('a b c d e');
    expect([binary, ...args]).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('keeps an argument that is only a quote-stripped empty string', () => {
    // `''` is a real, meaningful argument to many CLIs. Dropping it would
    // silently change the command the operator declared.
    expect(splitCommandLine("cmd '' x")).toEqual({ binary: 'cmd', args: ['', 'x'] });
  });
});

describe('usesUnsupportedEscaping: the ambiguity is detected, not guessed at', () => {
  it('flags a backslash-escaped double quote', () => {
    expect(usesUnsupportedEscaping('node -e "console.log(\\"ok\\")"')).toBe(true);
  });

  it('flags a backslash-escaped single quote', () => {
    expect(usesUnsupportedEscaping("sh -c 'it\\'s'")).toBe(true);
  });

  it('does NOT flag a backslash that is not before a quote', () => {
    // A Windows path or a regex is an ordinary argument and must stay one.
    expect(usesUnsupportedEscaping('tool --path C:\\Users\\dev')).toBe(false);
    expect(usesUnsupportedEscaping('grep --regex \\d+')).toBe(false);
  });

  it('does NOT flag the alternate-quote form, which works today', () => {
    // The whole reason escaping is refused rather than implemented: there is
    // already a way to express the same command, and it tokenizes correctly.
    const supported = 'node -e \'console.log("ok")\'';
    expect(usesUnsupportedEscaping(supported)).toBe(false);
    expect(splitCommandLine(supported)).toEqual({
      binary: 'node',
      args: ['-e', 'console.log("ok")'],
    });
  });

  it('does NOT flag ordinary commands', () => {
    for (const command of ['pnpm lint', 'node -e "a b"', "jest --p='x y'"]) {
      expect(usesUnsupportedEscaping(command)).toBe(false);
    }
  });
});
