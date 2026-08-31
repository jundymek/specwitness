import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanupAllShims,
  writeClaudeShim,
  type ShimInvocation,
} from '../../fixtures/bin/claude-shim.js';

/**
 * Tests for the TEST FIXTURE itself.
 *
 * Every adapter test asserts on what the shim recorded, so if the shim
 * misreports argv, cwd or its environment, those tests pass against a fiction
 * while proving nothing. That is the same failure the Golden Corpus rule guards
 * against by hand-writing `expected.json` instead of generating it — a fixture
 * has to be trustworthy independently of the code it is used to test.
 *
 * These are the only tests in the story that spawn the shim directly rather than
 * through the adapter, and they exist so the rest may be believed.
 */

afterEach(async () => {
  await cleanupAllShims();
});

/** Fails loudly when the shim recorded nothing — an empty record is itself a bug. */
function at(invocations: readonly ShimInvocation[], index: number): ShimInvocation {
  const invocation = invocations[index];
  if (invocation === undefined) {
    throw new Error(`shim recorded no invocation at index ${index} (got ${invocations.length})`);
  }
  return invocation;
}

describe('claude PATH shim (fixture self-test)', () => {
  it('records argv element-by-element, without a shell mangling it', async () => {
    const shim = await writeClaudeShim('capable');

    // Every one of these is a shell metacharacter. Through an argv array they
    // are inert data; through a shell they would substitute, glob or split.
    const hostile = 'a b"c\'d $(touch /tmp/pwned) `id` ;rm -rf / *\nsecond line';
    await execa(shim.binary, ['-p', '--output-format', 'json', hostile]);

    const invocation = at(await shim.invocations(), 0);
    expect(invocation.argv).toEqual(['-p', '--output-format', 'json', hostile]);
    // The nasty prompt survived as ONE argument, byte-identical.
    expect(invocation.argv[3]).toBe(hostile);
    expect(invocation.argv).toHaveLength(4);
  });

  it('records the cwd it was started in', async () => {
    const shim = await writeClaudeShim('capable');
    await execa(shim.binary, ['-p'], { cwd: shim.dir });

    const invocation = at(await shim.invocations(), 0);
    // macOS reports /private/var for /var; compare on the resolved suffix.
    expect(invocation.cwd.endsWith(shim.dir.replace(/^\/private/, ''))).toBe(true);
  });

  it('records the environment it actually received, and nothing more', async () => {
    const shim = await writeClaudeShim('capable');
    await execa(shim.binary, ['-p'], {
      extendEnv: false,
      env: { PATH: process.env.PATH ?? '', MARKER: 'present' },
    });

    const invocation = at(await shim.invocations(), 0);
    expect(invocation.env.MARKER).toBe('present');
    // The property the billing-safety tests will rely on: a variable that was
    // not passed is genuinely absent from the record, not merely empty.
    expect('ANTHROPIC_API_KEY' in invocation.env).toBe(false);
  });

  it('appends one record per invocation, in order', async () => {
    const shim = await writeClaudeShim('capable');
    await execa(shim.binary, ['--version']);
    await execa(shim.binary, ['-p', '--output-format', 'json', 'hello']);

    const invocations = await shim.invocations();
    expect(invocations).toHaveLength(2);
    expect(at(invocations, 0).argv).toEqual(['--version']);
    expect(at(invocations, 1).argv).toEqual(['-p', '--output-format', 'json', 'hello']);
  });

  describe('stdin recording (opt-in)', () => {
    it('records an empty stdin for the ordinary argv path', async () => {
      // The path the adapter takes for every normally-sized prompt. Pamela's
      // ProcessRunOptions.input defaults to '', so an empty pipe is what the
      // real CLI receives on EVERY invocation — verified harmless against the
      // live claude 2.1.251, and pinned here so a fixture change cannot hide it.
      const shim = await writeClaudeShim('capable', { recordStdin: true });
      await execa(shim.binary, ['-p', '--output-format', 'json', 'the prompt'], { input: '' });

      const invocation = at(await shim.invocations(), 0);
      expect(invocation.stdin).toBe('');
      expect(invocation.argv).toContain('the prompt');
    });

    it('records a prompt delivered on stdin, with no prompt in argv', async () => {
      // The oversized-prompt path. The prompt must NOT also appear in argv:
      // claude APPENDS piped stdin to an argv prompt rather than replacing it
      // (measured on 2.1.251), so supplying both silently duplicates the prompt.
      const shim = await writeClaudeShim('capable', { recordStdin: true });
      await execa(shim.binary, ['-p', '--output-format', 'json'], { input: 'the big prompt' });

      const invocation = at(await shim.invocations(), 0);
      expect(invocation.stdin).toBe('the big prompt');
      expect(invocation.argv).toEqual(['-p', '--output-format', 'json']);
    });
  });

  describe('modes behave as the adapter tests will assume', () => {
    it('capable: answers --version, and returns an envelope carrying the payload', async () => {
      const shim = await writeClaudeShim('capable');

      const version = await execa(shim.binary, ['--version']);
      expect(version.stdout).toContain('2.1.251');

      const run = await execa(shim.binary, ['-p', '--output-format', 'json', 'x']);
      const envelope = JSON.parse(run.stdout) as { result: string; is_error: boolean };
      expect(envelope.is_error).toBe(false);
      expect(envelope.result).toBe('{"ok":true}');
      // Progress chatter on stderr is normal and must not read as failure.
      expect(run.stderr).not.toBe('');
    });

    it('version-only: answers --version but rejects the non-interactive flags', async () => {
      const shim = await writeClaudeShim('version-only');

      await expect(execa(shim.binary, ['--version'])).resolves.toMatchObject({ exitCode: 0 });

      const rejected = await execa(shim.binary, ['-p', '--output-format', 'json', 'x'], {
        reject: false,
      });
      expect(rejected.exitCode).toBe(1);
      expect(rejected.stderr).toContain('unknown option');
    });

    it('fenced: wraps the payload in a ```json fence', async () => {
      const shim = await writeClaudeShim('fenced');
      const run = await execa(shim.binary, ['-p', '--output-format', 'json', 'x']);
      const envelope = JSON.parse(run.stdout) as { result: string };
      expect(envelope.result).toBe('```json\n{"ok":true}\n```');
    });

    it('malformed: exits 0 with output that is not JSON', async () => {
      const shim = await writeClaudeShim('malformed');
      const run = await execa(shim.binary, ['-p', '--output-format', 'json', 'x']);
      expect(run.exitCode).toBe(0);
      expect(() => JSON.parse(run.stdout)).toThrow();
    });

    it('wrong-shape: valid JSON that is not the envelope', async () => {
      const shim = await writeClaudeShim('wrong-shape');
      const run = await execa(shim.binary, ['-p', '--output-format', 'json', 'x']);
      const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
      expect(parsed.result).toBeUndefined();
    });

    it('empty-payload: a valid envelope whose result is empty', async () => {
      const shim = await writeClaudeShim('empty-payload');
      const run = await execa(shim.binary, ['-p', '--output-format', 'json', 'x']);
      const envelope = JSON.parse(run.stdout) as { result: string };
      expect(envelope.result).toBe('');
    });

    it('refuses: exits non-zero — "said no", distinct from missing or hung', async () => {
      const shim = await writeClaudeShim('refuses');
      const run = await execa(shim.binary, ['-p', '--output-format', 'json', 'x'], {
        reject: false,
      });
      expect(run.exitCode).toBe(1);
    });

    it('hanging: does not exit, and is killed by the caller timeout', async () => {
      const shim = await writeClaudeShim('hanging');
      // The timeout must comfortably exceed Node's own startup, or the shim is
      // killed before it can record and this assertion fails intermittently —
      // which is exactly what happened at 300ms. A hanging shim never exits, so
      // a generous bound still proves the timeout without slowing the suite.
      const run = await execa(shim.binary, ['-p', '--output-format', 'json', 'x'], {
        timeout: 2_000,
        reject: false,
      });
      expect(run.timedOut).toBe(true);
      // It still recorded what it was asked to do before hanging.
      const invocation = at(await shim.invocations(), 0);
      expect(invocation.argv).toContain('-p');
    });
  });
});
