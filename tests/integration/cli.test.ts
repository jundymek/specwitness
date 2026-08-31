import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

/**
 * Runs the built binary exactly as a shell would: no TTY, piped stdio,
 * never throwing on a non-zero exit so we can assert on the code itself.
 *
 * Runs in a throwaway directory by default. This used to be `cwd: REPO_ROOT`,
 * which was harmless while every command was a stub that touched nothing, and
 * wrong the moment one did real work: story 1.4's `init` scaffolded a live
 * `.specwitness/` into this repository on every `pnpm test`, and `git add -A`
 * would have staged it — only `runs/` and `scorecard.jsonl` are git-ignored,
 * because in a real target project config.yaml, contracts/ and plans/ are
 * meant to be committed.
 *
 * Tests that genuinely need the repository itself pass `cwd` explicitly.
 */
async function runCli(args: string[], options: { cwd?: string } = {}) {
  const scratch = options.cwd ?? (await mkdtemp(join(tmpdir(), 'specwitness-cli-')));
  try {
    const result = await execa(process.execPath, [CLI, ...args], {
      reject: false,
      cwd: scratch,
      // Prompt-free by contract: nothing may block on stdin.
      input: '',
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } finally {
    if (options.cwd === undefined) {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

/** House style: `ERROR: <what>` then optionally `HINT: <how to fix>`. */
function houseStyleLines(stderr: string) {
  return {
    errors: stderr.split('\n').filter((line) => line.startsWith('ERROR: ')),
    hints: stderr.split('\n').filter((line) => line.startsWith('HINT: ')),
  };
}

describe('bin entry', () => {
  it('is a bundled, executable, shebanged file', async () => {
    await expect(access(CLI, constants.X_OK)).resolves.toBeUndefined();

    const contents = await readFile(CLI, 'utf8');
    expect(contents.startsWith('#!/usr/bin/env node')).toBe(true);

    const info = await stat(CLI);
    // Owner-executable bit, which is what makes `bin` work after install.
    expect(info.mode & 0o100).toBe(0o100);
  });
});

describe('--help (AC1)', () => {
  it('renders help on stdout and exits 0', async () => {
    const { exitCode, stdout, stderr } = await runCli(['--help']);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('specwitness');
    expect(stdout).toContain('Usage:');
    // Help is command output, not a diagnostic.
    expect(stderr).toBe('');
  });

  it('lists the commands registered so far', async () => {
    const { stdout } = await runCli(['--help']);

    expect(stdout).toContain('init');
    expect(stdout).toContain('doctor');
    expect(stdout).toContain('report');
  });
});

describe('--version', () => {
  it('prints the package version and exits 0', async () => {
    const pkg = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };

    const { exitCode, stdout } = await runCli(['--version']);

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(pkg.version);
  });
});

describe('usage errors exit 64 (AC1)', () => {
  it.each([
    ['unknown command', ['nosuchcommand']],
    ['unknown flag', ['--definitely-not-a-flag']],
    ['unknown flag on a known command', ['doctor', '--definitely-not-a-flag']],
    ['no command at all', []],
  ])('%s exits 64 with exactly one ERROR/HINT pair on stderr', async (_label, args) => {
    const { exitCode, stdout, stderr } = await runCli(args);

    expect(exitCode).toBe(64);

    const { errors, hints } = houseStyleLines(stderr);
    // Commander writes its own message too unless suppressed; exactly one
    // pair proves we intercepted it rather than double-printing.
    expect(errors).toHaveLength(1);
    expect(hints).toHaveLength(1);

    // Diagnostics never contaminate stdout — the harness parses stdout.
    expect(stdout).toBe('');
  });

  it('names what was wrong in the ERROR line', async () => {
    const { stderr } = await runCli(['nosuchcommand']);

    expect(stderr).toContain('nosuchcommand');
    expect(stderr).not.toContain('error: error:');
  });

  it('points at --help in the HINT line', async () => {
    const { stderr } = await runCli(['--definitely-not-a-flag']);

    expect(stderr).toMatch(/^HINT: .*--help/m);
  });
});

// The `stub commands exit 3` block is gone: every command it covered (init,
// doctor, report) is implemented and carries its own integration coverage, so
// there was nothing left for it to assert. Its purpose — proving an AD-7 error
// still maps to exit 3 — lives on in each command's own tests and in
// scripts/pack-smoke.sh.

describe('prompt-free operation', () => {
  it('does not block on stdin when stdin is closed', async () => {
    // No TTY assumptions anywhere: an agent-callable command that waits for
    // input would hang the harness rather than fail it.
    const result = await execa(process.execPath, [CLI, '--help'], {
      reject: false,
      stdin: 'ignore',
      timeout: 10_000,
    });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  });
});
