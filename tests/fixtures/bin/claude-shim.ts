import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * PATH shims standing in for the real `claude` binary.
 *
 * AD-12 and this project's testing culture forbid the suite from ever invoking
 * the real CLI: a test that needs a subscription is a test most contributors
 * cannot run, and one that spends the maintainer's money every run is worse. So
 * the adapter is exercised against executables named `claude` that we write
 * ourselves, placed first on the child's PATH.
 *
 * The shims are Node scripts rather than shell scripts on purpose. A shim's job
 * is to report EXACTLY what it received — argv element by element, the cwd, and
 * its environment — and shell quoting mangles precisely the inputs most worth
 * testing (a prompt containing spaces, quotes, `$(...)`, newlines). Node's
 * `process.argv` is the parsed truth with no quoting layer in between, which is
 * what lets a test assert that a shell-metacharacter prompt arrived as one
 * opaque argument.
 *
 * Each shim appends one JSON line per invocation to a record file, so a test can
 * assert on the invocation as data instead of scraping stdout.
 */

/** One recorded invocation of a shim, exactly as the child process saw it. */
export interface ShimInvocation {
  /** Arguments AFTER the binary path — i.e. what the adapter chose to pass. */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /**
   * What arrived on stdin. Present only for shims created with
   * `{ recordStdin: true }` — see `writeClaudeShim`.
   */
  readonly stdin?: string;
}

export type ShimMode =
  /** Behaves like a working Claude Code: valid envelope, payload in `result`. */
  | 'capable'
  /** Answers `--version` but rejects the non-interactive flags (too old / not Claude Code). */
  | 'version-only'
  /** Never exits. Proves the timeout is real rather than aspirational. */
  | 'hanging'
  /** Valid envelope whose `result` is wrapped in a ```json fence. */
  | 'fenced'
  /** Exits 0 but prints something that is not JSON at all. */
  | 'malformed'
  /** Valid JSON that is NOT the envelope shape (a version drift simulation). */
  | 'wrong-shape'
  /** Valid envelope with an empty `result`. */
  | 'empty-payload'
  /** Exits non-zero with output on stderr — "said no". */
  | 'refuses';

export interface ShimHandle {
  /** Directory to place FIRST on the child's PATH. Contains the `claude` shim. */
  readonly dir: string;
  /** Absolute path of the shim itself. */
  readonly binary: string;
  /** Every invocation so far, in order. */
  invocations(): Promise<ShimInvocation[]>;
  /** Invocations that carried the non-interactive flags (i.e. not version probes). */
  cleanup(): Promise<void>;
}

const created: string[] = [];

/**
 * The shim body. `MODE` and `RECORD` are substituted as JSON literals when the
 * file is written, so the script needs no environment of its own — which matters,
 * because the adapter deliberately controls the child's environment and a shim
 * that depended on an inherited variable would break the very test asserting
 * that a variable was withheld.
 */
function shimSource(mode: ShimMode, recordPath: string, recordStdin: boolean): string {
  return `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');

const MODE = ${JSON.stringify(mode)};
const RECORD = ${JSON.stringify(recordPath)};
const RECORD_STDIN = ${JSON.stringify(recordStdin)};

const argv = process.argv.slice(2);

// Reading stdin is OPT-IN. A synchronous read of fd 0 blocks until EOF, so a
// shim that always read it would hang whenever stdin was inherited rather than
// piped — turning an unrelated test into a 30s timeout. Tests that opt in always
// pass an explicit \`input\`, so the pipe is closed and the read returns at once.
let stdin;
if (RECORD_STDIN) {
  try {
    stdin = fs.readFileSync(0, 'utf8');
  } catch {
    stdin = '';
  }
}

// Record before doing anything else, so even a shim that hangs or exits
// non-zero leaves evidence of exactly what it was asked to do.
fs.appendFileSync(
  RECORD,
  JSON.stringify({ argv, cwd: process.cwd(), env: process.env, stdin }) + '\\n',
);

const isVersionProbe = argv.includes('--version');

function envelope(result) {
  // Mirrors the real claude 2.1.251 \`-p --output-format json\` envelope,
  // captured from the live CLI on 2026-08-31 rather than invented: the payload
  // lives in \`result\`, alongside metadata the adapter must NOT depend on.
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 1875,
    duration_api_ms: 1751,
    num_turns: 1,
    result,
    session_id: '8f79b08f-c967-4fb6-b1b1-92873520660f',
    total_cost_usd: 0.0001,
    stop_reason: 'end_turn',
    usage: { input_tokens: 2, output_tokens: 4 },
    uuid: 'd426d702-0798-4573-ba41-a3c99af7de22',
  });
}

if (isVersionProbe) {
  if (MODE === 'hanging') { setInterval(() => {}, 1000); }
  else { process.stdout.write('2.1.251 (Claude Code)\\n'); process.exit(0); }
} else if (MODE === 'version-only') {
  // Exactly how an older or homonymous binary fails: it does not know the flags.
  process.stderr.write("error: unknown option '--output-format'\\n");
  process.exit(1);
} else if (MODE === 'hanging') {
  setInterval(() => {}, 1000);
} else if (MODE === 'malformed') {
  process.stdout.write('not json at all\\n');
  process.exit(0);
} else if (MODE === 'wrong-shape') {
  process.stdout.write(JSON.stringify({ unexpected: 'shape' }) + '\\n');
  process.exit(0);
} else if (MODE === 'refuses') {
  process.stderr.write('Invalid API key / not logged in\\n');
  process.exit(1);
} else if (MODE === 'fenced') {
  process.stdout.write(envelope('\`\`\`json\\n{"ok":true}\\n\`\`\`') + '\\n');
  process.exit(0);
} else if (MODE === 'empty-payload') {
  process.stdout.write(envelope('') + '\\n');
  process.exit(0);
} else {
  // 'capable': progress chatter on stderr is normal and must NOT read as failure.
  process.stderr.write('Thinking...\\n');
  process.stdout.write(envelope('{"ok":true}') + '\\n');
  process.exit(0);
}
`;
}

/**
 * Writes an executable `claude` shim into a fresh temp directory.
 *
 * Returns the directory to prepend to PATH plus an accessor for what the shim
 * recorded. Never writes into the repository: a stray executable named `claude`
 * inside the project would be a genuinely nasty thing to leave behind.
 */
export async function writeClaudeShim(
  mode: ShimMode,
  options: { readonly recordStdin?: boolean } = {},
): Promise<ShimHandle> {
  const dir = await mkdtemp(join(tmpdir(), 'specwitness-claude-shim-'));
  created.push(dir);

  const binary = join(dir, 'claude');
  const recordPath = join(dir, 'invocations.jsonl');

  await writeFile(binary, shimSource(mode, recordPath, options.recordStdin === true), 'utf8');
  await chmod(binary, 0o755);
  await writeFile(recordPath, '', 'utf8');

  return {
    dir,
    binary,
    async invocations(): Promise<ShimInvocation[]> {
      const text = await readFile(recordPath, 'utf8');
      return text
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as ShimInvocation);
    },
    async cleanup(): Promise<void> {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** A directory guaranteed to contain NO `claude` — the "binary absent" case. */
export async function writeEmptyBinDir(): Promise<{ dir: string; cleanup(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'specwitness-no-claude-'));
  created.push(dir);
  return {
    dir,
    async cleanup(): Promise<void> {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Removes every shim directory this module created. Call from `afterEach`. */
export async function cleanupAllShims(): Promise<void> {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}
