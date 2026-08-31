import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createProcessRunner } from '../../src/infra/process-runner.js';
import { FixedClock } from '../fakes/ports.js';

/**
 * The process seam against a REAL child process.
 *
 * Deliberately spawns `process.execPath` with `node -e`, never `claude` or
 * `codex`: this proves the spawn semantics with no external binary, no network
 * and no credentials anywhere near the test. Story 2.4/2.5 test their adapters
 * against PATH shims; the runner underneath them is proved here.
 */

const NODE = process.execPath;

/** A runner whose durations are exact rather than "some positive number". */
const runner = (...instants: string[]) =>
  createProcessRunner(new FixedClock(...(instants.length > 0 ? instants : ['2026-08-31T00:00:00.000Z'])));

const base = { cwd: process.cwd(), timeoutMs: 15_000, env: { inherit: true } as const };

describe('ProcessRunner: AD-3 — arguments are never a shell string', () => {
  it('passes shell metacharacters through as ONE literal argv element', async () => {
    // This is the property that keeps provider output from ever becoming a
    // command. If a shell were involved anywhere, `;`, `&&` and `$(...)` would
    // be interpreted and this argument would arrive split, expanded, or not at
    // all. It deserves a test rather than a comment.
    const hostile = 'a; rm -rf / && echo $(whoami) "quoted" \'single\' | tee';

    const result = await runner().run({
      ...base,
      binary: NODE,
      args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', hostile, 'second arg'],
    });

    expect(result.outcome).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([hostile, 'second arg']);
  });

  it('preserves an empty-string argument rather than dropping it', async () => {
    const result = await runner().run({
      ...base,
      binary: NODE,
      args: ['-e', 'process.stdout.write(String(process.argv.slice(1).length))', '', 'x'],
    });

    expect(result.stdout).toBe('2');
  });
});

describe('ProcessRunner: outcomes stay distinguishable', () => {
  it('reports a clean run as completed with exit code 0', async () => {
    const result = await runner().run({
      ...base,
      binary: NODE,
      args: ['-e', 'process.stdout.write("out"); process.stderr.write("err")'],
    });

    expect(result).toMatchObject({
      outcome: 'completed',
      exitCode: 0,
      stdout: 'out',
      stderr: 'err',
    });
  });

  it('reports a non-zero exit as completed — "it said no", not "it is broken"', async () => {
    const result = await runner().run({
      ...base,
      binary: NODE,
      args: ['-e', 'process.stderr.write("nope"); process.exit(3)'],
    });

    expect(result.outcome).toBe('completed');
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe('nope');
  });

  it('reports a missing binary as not-found, and does NOT throw', async () => {
    // UJ-4 depends on this: a missing agent CLI is a normal project state that
    // doctor warns about while staying at exit 0. An exception here would force
    // every caller into a `catch` just to avoid turning that into a diagnosis.
    const result = await runner().run({
      ...base,
      binary: 'specwitness-no-such-binary-9f3c',
      args: ['--version'],
    });

    expect(result.outcome).toBe('not-found');
    expect(result.exitCode).toBeNull();
  });

  it('kills a hanging child and reports timed-out', async () => {
    const result = await runner().run({
      ...base,
      binary: NODE,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 300,
    });

    expect(result.outcome).toBe('timed-out');
  });
});

describe('ProcessRunner: AD-4 — the child environment is constructed, never leaked', () => {
  const readVar = (name: string) => [
    '-e',
    `process.stdout.write(process.env[${JSON.stringify(name)}] ?? "<absent>")`,
  ];

  it('withholds a named variable from an otherwise inherited environment', async () => {
    // The FR-15 property 2.4 and 2.5 both build their billing safety on. Set it
    // in THIS process, withhold it, and prove three things at once.
    const name = 'SPECWITNESS_TEST_BILLING_KEY';
    process.env[name] = 'must-not-reach-the-child';
    try {
      const spec = { inherit: true, withhold: [name] };

      const result = await runner().run({
        ...base,
        binary: NODE,
        args: readVar(name),
        env: spec,
      });

      // 1. the child did not see it
      expect(result.stdout).toBe('<absent>');
      // 2. the parent environment still has it afterwards — never mutated
      expect(process.env[name]).toBe('must-not-reach-the-child');
      // 3. the caller's options object is untouched
      expect(spec).toEqual({ inherit: true, withhold: [name] });
    } finally {
      delete process.env[name];
    }
  });

  it('still passes through variables it was not asked to withhold', async () => {
    const name = 'SPECWITNESS_TEST_KEPT';
    process.env[name] = 'kept';
    try {
      const result = await runner().run({
        ...base,
        binary: NODE,
        args: readVar(name),
        env: { inherit: true, withhold: ['SOMETHING_ELSE'] },
      });

      expect(result.stdout).toBe('kept');
    } finally {
      delete process.env[name];
    }
  });

  it('gives the child nothing when inherit is false', async () => {
    const name = 'SPECWITNESS_TEST_NOT_INHERITED';
    process.env[name] = 'parent-only';
    try {
      const result = await runner().run({
        ...base,
        binary: NODE,
        args: readVar(name),
        env: { inherit: false },
      });

      expect(result.stdout).toBe('<absent>');
    } finally {
      delete process.env[name];
    }
  });

  it('sets an explicit variable the parent never had', async () => {
    const result = await runner().run({
      ...base,
      binary: NODE,
      args: readVar('SPECWITNESS_TEST_EXPLICIT'),
      env: { inherit: false, set: { SPECWITNESS_TEST_EXPLICIT: 'injected' } },
    });

    expect(result.stdout).toBe('injected');
    expect(process.env.SPECWITNESS_TEST_EXPLICIT).toBeUndefined();
  });
});

describe('ProcessRunner: stdin and timing', () => {
  it('is prompt-free by default — a child reading stdin sees EOF, not a hang', async () => {
    const result = await runner().run({
      ...base,
      binary: NODE,
      args: [
        '-e',
        'let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>process.stdout.write(`[${d}]`))',
      ],
      timeoutMs: 5_000,
    });

    expect(result.outcome).toBe('completed');
    expect(result.stdout).toBe('[]');
  });

  it('writes the supplied input to the child stdin', async () => {
    const result = await runner().run({
      ...base,
      binary: NODE,
      args: [
        '-e',
        'let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>process.stdout.write(d))',
      ],
      input: 'a long prompt',
    });

    expect(result.stdout).toBe('a long prompt');
  });

  it('reports durationMs from the injected Clock, as an integer', async () => {
    // AD-9: no `new Date()` on this path, so a test can assert an exact number
    // rather than "greater than zero", which would pass even if the clock were
    // read once and reused.
    const result = await runner('2026-08-31T00:00:00.000Z', '2026-08-31T00:00:02.250Z').run({
      ...base,
      binary: NODE,
      args: ['-e', ''],
    });

    expect(result.durationMs).toBe(2250);
    expect(Number.isInteger(result.durationMs)).toBe(true);
  });
});

describe('ProcessRunner: a bad cwd is not a missing binary', () => {
  it('reports an invalid cwd as spawn-failed, not not-found', async () => {
    // execa surfaces BOTH "the binary is not on PATH" and "the cwd does not
    // exist" as code ENOENT, so a classifier that trusts ENOENT alone tells the
    // operator to install a CLI that is already installed. `not-found` is the
    // input to doctor's "install it and reopen your shell" diagnosis, which is
    // the single most consequential thing doctor says.
    const result = await runner().run({
      ...base,
      binary: NODE, // definitely exists
      args: ['-e', ''],
      cwd: '/definitely/not/a/directory/specwitness-9f3c',
    });

    expect(result.outcome).toBe('spawn-failed');
    expect(result.stderr).toMatch(/cwd/i);
  });

  it('still reports a missing binary as not-found when the cwd is fine', async () => {
    // The other half of the distinction: fixing the above must not blunt this.
    const result = await runner().run({
      ...base,
      binary: 'specwitness-no-such-binary-9f3c',
      args: ['--version'],
    });

    expect(result.outcome).toBe('not-found');
  });

  it('reports a cwd that exists but is a file as spawn-failed', async () => {
    const result = await runner().run({
      ...base,
      binary: NODE,
      args: ['-e', ''],
      cwd: fileURLToPath(import.meta.url),
    });

    expect(result.outcome).toBe('spawn-failed');
  });
});

describe('ProcessRunner: a timeout fires even when the child forks', () => {
  it('classifies a forking child as timed-out instead of hanging forever', async () => {
    // Reported by story 2.5 with a reproduction, confirmed here: execa's own
    // timeout kills the direct child, but a grandchild inherits the stdio pipes
    // and holds them open, so execa never settles. Before this was handled, a
    // call like this one did not return after 90 seconds.
    //
    // It matters well beyond provider adapters: Epic 3 runs project-declared
    // gates through this port, and `npm test` / `docker compose up` exist to
    // spawn children. A gate that hangs must fail cleanly, not wedge `verify`.
    const dir = await mkdtemp(join(tmpdir(), 'specwitness-hang-'));
    const script = join(dir, 'forks-and-hangs.sh');
    // `while ... sleep` rather than `exec sleep`: the shell stays alive as the
    // parent of a `sleep` grandchild, which is the whole point.
    await writeFile(script, '#!/bin/sh\nwhile true; do sleep 3600; done\n', { mode: 0o755 });

    try {
      const startedAt = Date.now();
      const result = await runner().run({
        ...base,
        binary: '/bin/sh',
        args: [script],
        timeoutMs: 500,
      });
      const wallClock = Date.now() - startedAt;

      expect(result.outcome).toBe('timed-out');
      expect(result.exitCode).toBeNull();
      // The load-bearing assertion: it RETURNED. Without the settlement
      // watchdog this promise never resolves at all.
      expect(wallClock).toBeLessThan(10_000);
      // And it says why, so an operator is not left guessing.
      expect(result.stderr).toMatch(/descendant|timed out/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('still settles promptly for a single-process child, with no grace penalty', async () => {
    // The common case must not pay for the watchdog: a well-behaved child that
    // honours its kill should settle at roughly timeoutMs, not timeoutMs + grace.
    const startedAt = Date.now();

    const result = await runner().run({
      ...base,
      binary: NODE,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 300,
    });

    expect(result.outcome).toBe('timed-out');
    expect(Date.now() - startedAt).toBeLessThan(1_200);
  });
});
