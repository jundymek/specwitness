import { describe, expect, it, vi } from 'vitest';

import {
  createClaudeCodeCliProvider,
  probeClaudeAuth,
  probeClaudeCapability,
} from '../../../src/providers/claude-code-cli.js';
import { ProviderError } from '../../../src/domain/errors.js';
import type { ProcessResult, ProcessRunOptions } from '../../../src/domain/process-runner.js';
import type { ProviderDeps, ProviderDescriptor } from '../../../src/domain/agent-provider.js';

/**
 * Unit tests for the claude adapter, driven entirely through 2.3's
 * `ProcessRunner` seam. No subprocess is spawned here — the PATH-shim
 * integration suite covers the real spawn; these cover the translation.
 */

const CAPABLE_ENVELOPE = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: '{"ok":true}',
  duration_ms: 12,
});

function ok(stdout: string, stderr = ''): ProcessResult {
  return { outcome: 'completed', exitCode: 0, stdout, stderr, durationMs: 1 };
}

function failed(exitCode: number, stderr: string): ProcessResult {
  return { outcome: 'completed', exitCode, stdout: '', stderr, durationMs: 1 };
}

/** Records every spawn and replays scripted results in order, repeating the last. */
function runnerReturning(...results: readonly ProcessResult[]): {
  runner: { run(options: ProcessRunOptions): Promise<ProcessResult> };
  calls: ProcessRunOptions[];
} {
  const calls: ProcessRunOptions[] = [];
  let index = 0;
  return {
    calls,
    runner: {
      async run(options: ProcessRunOptions): Promise<ProcessResult> {
        calls.push(options);
        const result = results[Math.min(index, results.length - 1)];
        index += 1;
        if (result === undefined) {
          throw new Error('runnerReturning was given no results');
        }
        return result;
      },
    },
  };
}

const VERSION_OK = ok('2.1.251 (Claude Code)\n');

function deps(
  runner: { run(options: ProcessRunOptions): Promise<ProcessResult> },
  warn: (message: string) => void = () => {},
): ProviderDeps {
  return {
    processRunner: runner,
    clock: { now: () => new Date('2026-08-31T00:00:00.000Z') },
    warn,
  };
}

function descriptor(mode = 'subscription'): ProviderDescriptor {
  return { name: 'claude', adapter: 'claude-code-cli', mode };
}

describe('probeClaudeCapability', () => {
  it('reports a capable binary, with the version verbatim', async () => {
    const { runner } = runnerReturning(VERSION_OK, ok(CAPABLE_ENVELOPE));
    const capability = await probeClaudeCapability(runner);

    expect(capability.binary).toBe('claude');
    expect(capability.found).toBe(true);
    expect(capability.nonInteractive).toBe(true);
    expect(capability.jsonOutputFormat).toBe(true);
    // Verbatim: chuck fills bob's `providerCliVersion` provenance field from
    // this, and AC2 forbids parsing it into a feature matrix.
    expect(capability.version).toBe('2.1.251 (Claude Code)');
    expect(capability.reason).toBeUndefined();
  });

  it('reports a missing binary as a value, never a throw', async () => {
    // UJ-4: a missing agent CLI is a normal project state. Doctor must be able
    // to warn about it while leaving its exit code at 0.
    const { runner } = runnerReturning({
      outcome: 'not-found',
      exitCode: null,
      stdout: '',
      stderr: '',
      durationMs: 1,
    });

    const capability = await probeClaudeCapability(runner);
    expect(capability.found).toBe(false);
    expect(capability.nonInteractive).toBe(false);
    expect(capability.reason).toMatch(/not found on PATH/i);
    expect(capability.version).toBeUndefined();
  });

  it('reports a binary that answers --version but rejects the non-interactive flags', async () => {
    // The homonym case: a shell alias or unrelated `claude` on PATH can print
    // anything for --version, so behaviour — not the version string — is proof.
    const { runner } = runnerReturning(VERSION_OK, failed(1, "error: unknown option '--output-format'"));

    const capability = await probeClaudeCapability(runner);
    expect(capability.found).toBe(true);
    expect(capability.version).toBe('2.1.251 (Claude Code)');
    expect(capability.nonInteractive).toBe(false);
    expect(capability.jsonOutputFormat).toBe(false);
    expect(capability.reason).toMatch(/rejected/i);
  });

  it('rejects a binary that accepts the flags but does not emit JSON', async () => {
    // The homonym case the spec warns about, in its most convincing form: a
    // `claude` on PATH that swallows the flags and exits 0 with plain text. If
    // exit code alone were the proof, doctor would report a healthy install
    // while every generation failed later in envelope parsing.
    const { runner } = runnerReturning(VERSION_OK, ok('Hello! I am not Claude Code.\n'));

    const capability = await probeClaudeCapability(runner);
    expect(capability.found).toBe(true);
    expect(capability.jsonOutputFormat).toBe(false);
    expect(capability.nonInteractive).toBe(false);
    expect(capability.reason).toMatch(/json/i);
  });

  it('accepts a JSON object whose fields differ, leaving shape drift to generation', async () => {
    // Capability is "the CLI honours --output-format json", not "the envelope
    // has the fields I expect today". A drifted shape is a real invocation's
    // problem, where the error can name the missing field precisely; failing the
    // capability probe for it would report a version mismatch as a broken
    // install.
    const { runner } = runnerReturning(VERSION_OK, ok(JSON.stringify({ unexpected: 'shape' })));

    const capability = await probeClaudeCapability(runner);
    expect(capability.jsonOutputFormat).toBe(true);
    expect(capability.nonInteractive).toBe(true);
  });

  it('treats a logged-out CLI as CAPABLE — auth is not a capability', async () => {
    // The probe exercises a real invocation, so it fails for reasons that have
    // nothing to do with flag support: logged out, rate limited, quota spent.
    // Reporting those as "the CLI is too old" sends the operator to reinstall a
    // perfectly good binary, and blocks the invocation path that would have
    // shown them the CLI's own message. Flags accepted = capable; readiness is
    // `probeClaudeAuth`'s question.
    const { runner } = runnerReturning(VERSION_OK, failed(1, 'Invalid API key · Please run /login'));

    const capability = await probeClaudeCapability(runner);
    expect(capability.found).toBe(true);
    expect(capability.nonInteractive).toBe(true);
    expect(capability.jsonOutputFormat).toBe(true);
  });

  it('treats a rate-limited CLI as capable too', async () => {
    const { runner } = runnerReturning(VERSION_OK, failed(1, 'rate limit exceeded, try again later'));

    const capability = await probeClaudeCapability(runner);
    expect(capability.nonInteractive).toBe(true);
  });

  it('distinguishes a hung binary from one that said no', async () => {
    const { runner } = runnerReturning({
      outcome: 'timed-out',
      exitCode: null,
      stdout: '',
      stderr: '',
      durationMs: 5000,
    });

    const capability = await probeClaudeCapability(runner);
    // A binary that HUNG was still found: the spawn succeeded, so it is on PATH
    // (ENOENT would have been `not-found`). Reporting it as missing would tell
    // an operator to install a CLI they already have.
    expect(capability.found).toBe(true);
    expect(capability.nonInteractive).toBe(false);
    // "could not tell", not a diagnosis about the user's installation.
    expect(capability.reason).toMatch(/did not respond|timed out/i);
  });

  it('probes with an explicit timeout and never a shell', async () => {
    const { runner, calls } = runnerReturning(VERSION_OK, ok(CAPABLE_ENVELOPE));
    await probeClaudeCapability(runner);

    for (const call of calls) {
      expect(call.binary).toBe('claude');
      expect(call.timeoutMs).toBeGreaterThan(0);
      expect(Array.isArray(call.args)).toBe(true);
    }
    expect(calls[0]?.args).toEqual(['--version']);
  });

  it('caches per runner, so doctor re-probing costs nothing', async () => {
    const { runner, calls } = runnerReturning(VERSION_OK, ok(CAPABLE_ENVELOPE));

    await probeClaudeCapability(runner);
    const spawnsAfterFirst = calls.length;
    await probeClaudeCapability(runner);

    expect(calls.length).toBe(spawnsAfterFirst);
  });
});

describe('probeClaudeAuth', () => {
  it('reports usable auth when a trivial invocation exits 0', async () => {
    const { runner } = runnerReturning(ok(CAPABLE_ENVELOPE));
    const probe = await probeClaudeAuth(runner);

    expect(probe.ok).toBe(true);
    expect(probe.exitCode).toBe(0);
  });

  it('reports a refusal with its exit code — "said no"', async () => {
    const { runner } = runnerReturning(failed(1, 'Invalid API key / not logged in'));
    const probe = await probeClaudeAuth(runner);

    expect(probe.ok).toBe(false);
    expect(probe.exitCode).toBe(1);
    expect(probe.detail).toContain('Invalid API key');
  });

  it('reports "could not tell" with a null exit code on a timeout', async () => {
    // A timed-out probe is NOT a diagnosis about the user's auth, and doctor
    // renders the two differently.
    const { runner } = runnerReturning({
      outcome: 'timed-out',
      exitCode: null,
      stdout: '',
      stderr: '',
      durationMs: 5000,
    });

    const probe = await probeClaudeAuth(runner);
    expect(probe.ok).toBe(false);
    expect(probe.exitCode).toBeNull();
    expect(probe.detail).toMatch(/did not respond|timed out/i);
  });
});

describe('createClaudeCodeCliProvider — the invocation', () => {
  it('exposes the descriptor identity the port requires', () => {
    const { runner } = runnerReturning(VERSION_OK, ok(CAPABLE_ENVELOPE));
    const provider = createClaudeCodeCliProvider(descriptor(), deps(runner));

    expect(provider.id).toBe('claude');
    expect(provider.adapter).toBe('claude-code-cli');
  });

  it('builds exactly the probed baseline argv, element by element', async () => {
    const { runner, calls } = runnerReturning(VERSION_OK, ok(CAPABLE_ENVELOPE), ok(CAPABLE_ENVELOPE));
    const provider = createClaudeCodeCliProvider(descriptor(), deps(runner));

    await provider.generate({ role: 'contract-author', prompt: 'draft it' });

    const invocation = calls[calls.length - 1];
    // Exact, not a substring: a flag order that "looks right" is how an adapter
    // silently stops being non-interactive.
    expect(invocation?.args).toEqual(['-p', '--output-format', 'json', 'draft it']);
    expect(invocation?.binary).toBe('claude');
    expect(invocation?.timeoutMs).toBeGreaterThan(0);
  });

  it('returns the payload text raw', async () => {
    const { runner } = runnerReturning(VERSION_OK, ok(CAPABLE_ENVELOPE), ok(CAPABLE_ENVELOPE));
    const provider = createClaudeCodeCliProvider(descriptor(), deps(runner));

    await expect(provider.generate({ role: 'contract-author', prompt: 'x' })).resolves.toBe(
      '{"ok":true}',
    );
  });

  it('strips a fenced payload', async () => {
    const fenced = JSON.stringify({ is_error: false, result: '```json\n{"ok":true}\n```' });
    const { runner } = runnerReturning(VERSION_OK, ok(CAPABLE_ENVELOPE), ok(fenced));
    const provider = createClaudeCodeCliProvider(descriptor(), deps(runner));

    await expect(provider.generate({ role: 'contract-author', prompt: 'x' })).resolves.toBe(
      '{"ok":true}',
    );
  });

  it('returns an empty payload as empty text, not as a failure', async () => {
    const empty = JSON.stringify({ is_error: false, result: '' });
    const { runner } = runnerReturning(VERSION_OK, ok(CAPABLE_ENVELOPE), ok(empty));
    const provider = createClaudeCodeCliProvider(descriptor(), deps(runner));

    // Rejecting empty output is the gate's job, not the adapter's.
    await expect(provider.generate({ role: 'contract-author', prompt: 'x' })).resolves.toBe('');
  });

  it('does not treat progress on stderr as failure', async () => {
    const { runner } = runnerReturning(
      VERSION_OK,
      ok(CAPABLE_ENVELOPE),
      ok(CAPABLE_ENVELOPE, 'Thinking...\n'),
    );
    const provider = createClaudeCodeCliProvider(descriptor(), deps(runner));

    await expect(provider.generate({ role: 'contract-author', prompt: 'x' })).resolves.toBe(
      '{"ok":true}',
    );
  });

  it('passes the cwd it was given', async () => {
    const { runner, calls } = runnerReturning(VERSION_OK, ok(CAPABLE_ENVELOPE), ok(CAPABLE_ENVELOPE));
    const provider = createClaudeCodeCliProvider(descriptor(), deps(runner), { cwd: '/tmp/project' });

    await provider.generate({ role: 'contract-author', prompt: 'x' });
    expect(calls[calls.length - 1]?.cwd).toBe('/tmp/project');
  });

  it('appends contextFiles to the prompt rather than inventing a flag', async () => {
    const { runner, calls } = runnerReturning(VERSION_OK, ok(CAPABLE_ENVELOPE), ok(CAPABLE_ENVELOPE));
    const provider = createClaudeCodeCliProvider(descriptor(), deps(runner));

    await provider.generate({
      role: 'contract-author',
      prompt: 'draft it',
      contextFiles: ['docs/a.md', 'docs/b.md'],
    });

    const args = calls[calls.length - 1]?.args ?? [];
    // No unprobed flag appeared.
    expect(args).not.toContain('--add-dir');
    expect(args.slice(0, 3)).toEqual(['-p', '--output-format', 'json']);
    const promptArg = args[3] ?? '';
    expect(promptArg).toContain('draft it');
    expect(promptArg).toContain('docs/a.md');
    expect(promptArg).toContain('docs/b.md');
  });

  it('sends an oversized prompt on stdin, with NO prompt in argv', async () => {
    // Measured on claude 2.1.251: piped stdin is APPENDED to an argv prompt
    // rather than replacing it, so supplying both silently duplicates it. The
    // two paths must be mutually exclusive.
    const { runner, calls } = runnerReturning(VERSION_OK, ok(CAPABLE_ENVELOPE), ok(CAPABLE_ENVELOPE));
    const provider = createClaudeCodeCliProvider(descriptor(), deps(runner));

    const huge = 'x'.repeat(70 * 1024);
    await provider.generate({ role: 'contract-author', prompt: huge });

    const invocation = calls[calls.length - 1];
    expect(invocation?.args).toEqual(['-p', '--output-format', 'json']);
    expect(invocation?.input).toBe(huge);
  });

  it('keeps a normal prompt in argv with an empty stdin', async () => {
    const { runner, calls } = runnerReturning(VERSION_OK, ok(CAPABLE_ENVELOPE), ok(CAPABLE_ENVELOPE));
    const provider = createClaudeCodeCliProvider(descriptor(), deps(runner));

    await provider.generate({ role: 'contract-author', prompt: 'small' });

    const invocation = calls[calls.length - 1];
    expect(invocation?.args).toContain('small');
    expect(invocation?.input ?? '').toBe('');
  });

  it('passes a shell-metacharacter prompt as one opaque argument', async () => {
    const { runner, calls } = runnerReturning(VERSION_OK, ok(CAPABLE_ENVELOPE), ok(CAPABLE_ENVELOPE));
    const provider = createClaudeCodeCliProvider(descriptor(), deps(runner));

    const hostile = '$(rm -rf /) `id` ; echo pwned > /tmp/x';
    await provider.generate({ role: 'contract-author', prompt: hostile });

    const args = calls[calls.length - 1]?.args ?? [];
    expect(args[3]).toBe(hostile);
    expect(args).toHaveLength(4);
  });
});

describe('createClaudeCodeCliProvider — billing safety (FR-15)', () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  function withKey<T>(value: string | undefined, body: () => Promise<T>): Promise<T> {
    // Set on a COPY of the name only for the duration of the assertion; the
    // adapter must never mutate the parent environment itself.
    if (value === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = value;
    }
    return body().finally(() => {
      if (originalKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = originalKey;
      }
    });
  }

  it('withholds the billing variable by construction', async () => {
    const { runner, calls } = runnerReturning(VERSION_OK, ok(CAPABLE_ENVELOPE), ok(CAPABLE_ENVELOPE));
    const provider = createClaudeCodeCliProvider(descriptor(), deps(runner));

    await provider.generate({ role: 'contract-author', prompt: 'x' });

    const env = calls[calls.length - 1]?.env;
    expect(env?.inherit).toBe(true);
    expect(env?.withhold).toContain('ANTHROPIC_API_KEY');
  });

  it('withholds on EVERY invocation, including the capability probe', async () => {
    const { runner, calls } = runnerReturning(VERSION_OK, ok(CAPABLE_ENVELOPE), ok(CAPABLE_ENVELOPE));
    const provider = createClaudeCodeCliProvider(descriptor(), deps(runner));

    await provider.generate({ role: 'contract-author', prompt: 'x' });

    for (const call of calls) {
      expect(call.env.withhold).toContain('ANTHROPIC_API_KEY');
    }
  });

  it('warns naming the variable when it is present', async () => {
    await withKey('not-a-real-key-unit-fixture', async () => {
      const warn = vi.fn();
      const { runner } = runnerReturning(VERSION_OK, ok(CAPABLE_ENVELOPE), ok(CAPABLE_ENVELOPE));
      const provider = createClaudeCodeCliProvider(descriptor(), deps(runner, warn));

      await provider.generate({ role: 'contract-author', prompt: 'x' });

      const message = warn.mock.calls.flat().join('\n');
      expect(message).toContain('ANTHROPIC_API_KEY');
      expect(message).toContain('withheld from the claude subprocess');
      expect(message).toContain('mode: subscription');
      // Never the VALUE — that would leak a credential into scrollback.
      expect(message).not.toContain('not-a-real-key-unit-fixture');
    });
  });

  it('does not mutate the parent environment', async () => {
    await withKey('not-a-real-key-unit-fixture', async () => {
      const { runner } = runnerReturning(VERSION_OK, ok(CAPABLE_ENVELOPE), ok(CAPABLE_ENVELOPE));
      const provider = createClaudeCodeCliProvider(descriptor(), deps(runner));

      await provider.generate({ role: 'contract-author', prompt: 'x' });

      expect(process.env.ANTHROPIC_API_KEY).toBe('not-a-real-key-unit-fixture');
    });
  });

  it('treats a set-but-empty variable as present', async () => {
    await withKey('', async () => {
      const warn = vi.fn();
      const { runner } = runnerReturning(VERSION_OK, ok(CAPABLE_ENVELOPE), ok(CAPABLE_ENVELOPE));
      const provider = createClaudeCodeCliProvider(descriptor(), deps(runner, warn));

      await provider.generate({ role: 'contract-author', prompt: 'x' });

      expect(warn.mock.calls.flat().join('\n')).toContain('ANTHROPIC_API_KEY');
    });
  });

  it('does not warn when the variable is absent', async () => {
    await withKey(undefined, async () => {
      const warn = vi.fn();
      const { runner } = runnerReturning(VERSION_OK, ok(CAPABLE_ENVELOPE), ok(CAPABLE_ENVELOPE));
      const provider = createClaudeCodeCliProvider(descriptor(), deps(runner, warn));

      await provider.generate({ role: 'contract-author', prompt: 'x' });

      expect(warn.mock.calls.flat().join('\n')).not.toContain('ANTHROPIC_API_KEY present');
    });
  });

  it('withholds even in an UNRECOGNIZED mode, and says so', async () => {
    // `mode` is an unconstrained non-empty string in config, so `subscribtion`
    // validates. A conditional withhold would bill the user for a typo.
    await withKey('not-a-real-key-unit-fixture', async () => {
      const warn = vi.fn();
      const { runner, calls } = runnerReturning(
        VERSION_OK,
        ok(CAPABLE_ENVELOPE),
        ok(CAPABLE_ENVELOPE),
      );
      const provider = createClaudeCodeCliProvider(descriptor('subscribtion'), deps(runner, warn));

      await provider.generate({ role: 'contract-author', prompt: 'x' });

      expect(calls[calls.length - 1]?.env.withhold).toContain('ANTHROPIC_API_KEY');
      const message = warn.mock.calls.flat().join('\n');
      expect(message).toMatch(/unrecognized provider mode/i);
      expect(message).toContain('subscribtion');
    });
  });

  it('warns BEFORE the first subprocess, and even when the probe fails', async () => {
    // The capability probe spawns `claude` itself. If the warning came after it,
    // the first subprocess of the session would run unannounced — and a probe
    // that failed would throw with no warning at all, so an operator whose key
    // is set would never learn it. The variable is withheld from the probe
    // either way; this is about the warning contract, not about safety.
    await withKey('not-a-real-key-unit-fixture', async () => {
      const warn = vi.fn();
      const { runner } = runnerReturning({
        outcome: 'not-found',
        exitCode: null,
        stdout: '',
        stderr: '',
        durationMs: 1,
      });
      const provider = createClaudeCodeCliProvider(descriptor(), deps(runner, warn));

      await expect(
        provider.generate({ role: 'contract-author', prompt: 'x' }),
      ).rejects.toBeInstanceOf(ProviderError);

      expect(warn.mock.calls.flat().join('\n')).toContain('ANTHROPIC_API_KEY');
    });
  });

  it('withholds every known Anthropic credential variable BY DEFAULT', async () => {
    // The default has to be complete on its own. `createProvider` builds this
    // adapter with no options, and the provider config schema is a strictObject
    // of {adapter, mode} with nowhere to name an extra variable — so anything
    // not in this default is simply never withheld in production, whatever the
    // injection seam below allows. AD-4 says "provider equivalents", plural.
    const { runner, calls } = runnerReturning(VERSION_OK, ok(CAPABLE_ENVELOPE), ok(CAPABLE_ENVELOPE));
    const provider = createClaudeCodeCliProvider(descriptor(), deps(runner));

    await provider.generate({ role: 'contract-author', prompt: 'x' });

    const withheld = calls[calls.length - 1]?.env.withhold ?? [];
    expect(withheld).toEqual(
      expect.arrayContaining(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']),
    );
  });

  it('withholds caller-configured equivalents too', async () => {
    const { runner, calls } = runnerReturning(VERSION_OK, ok(CAPABLE_ENVELOPE), ok(CAPABLE_ENVELOPE));
    const provider = createClaudeCodeCliProvider(descriptor(), deps(runner), {
      billingEnvVars: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    });

    await provider.generate({ role: 'contract-author', prompt: 'x' });

    expect(calls[calls.length - 1]?.env.withhold).toEqual(
      expect.arrayContaining(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']),
    );
  });
});

describe('createClaudeCodeCliProvider — failure translation', () => {
  it('raises ProviderError when the binary is missing', async () => {
    const { runner } = runnerReturning({
      outcome: 'not-found',
      exitCode: null,
      stdout: '',
      stderr: '',
      durationMs: 1,
    });
    const provider = createClaudeCodeCliProvider(descriptor(), deps(runner));

    await expect(provider.generate({ role: 'contract-author', prompt: 'x' })).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it('raises ProviderError on a timeout', async () => {
    const { runner } = runnerReturning(VERSION_OK, ok(CAPABLE_ENVELOPE), {
      outcome: 'timed-out',
      exitCode: null,
      stdout: '',
      stderr: '',
      durationMs: 60_000,
    });
    const provider = createClaudeCodeCliProvider(descriptor(), deps(runner));

    await expect(provider.generate({ role: 'contract-author', prompt: 'x' })).rejects.toThrow(
      /timed out|did not respond/i,
    );
  });

  it('raises ProviderError naming what was expected when the envelope is malformed', async () => {
    const { runner } = runnerReturning(VERSION_OK, ok(CAPABLE_ENVELOPE), ok('not json at all'));
    const provider = createClaudeCodeCliProvider(descriptor(), deps(runner));

    // Never a TypeError from a property access on undefined.
    await expect(provider.generate({ role: 'contract-author', prompt: 'x' })).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it('raises ProviderError when the envelope shape drifted', async () => {
    const drifted = JSON.stringify({ unexpected: 'shape' });
    const { runner } = runnerReturning(VERSION_OK, ok(CAPABLE_ENVELOPE), ok(drifted));
    const provider = createClaudeCodeCliProvider(descriptor(), deps(runner));

    await expect(provider.generate({ role: 'contract-author', prompt: 'x' })).rejects.toThrow(
      /result/i,
    );
  });

  it('raises ProviderError when the CLI reports is_error', async () => {
    const errored = JSON.stringify({ is_error: true, result: 'rate limited' });
    const { runner } = runnerReturning(VERSION_OK, ok(CAPABLE_ENVELOPE), ok(errored));
    const provider = createClaudeCodeCliProvider(descriptor(), deps(runner));

    await expect(provider.generate({ role: 'contract-author', prompt: 'x' })).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it('raises ProviderError when the CLI exits non-zero', async () => {
    const { runner } = runnerReturning(VERSION_OK, ok(CAPABLE_ENVELOPE), failed(1, 'not logged in'));
    const provider = createClaudeCodeCliProvider(descriptor(), deps(runner));

    await expect(provider.generate({ role: 'contract-author', prompt: 'x' })).rejects.toThrow(
      /not logged in/,
    );
  });

  it('raises a capability ProviderError when the CLI cannot do non-interactive', async () => {
    const { runner } = runnerReturning(VERSION_OK, failed(1, "unknown option '--output-format'"));
    const provider = createClaudeCodeCliProvider(descriptor(), deps(runner));

    await expect(provider.generate({ role: 'contract-author', prompt: 'x' })).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it("surfaces a logged-out CLI's own message, never install-or-update advice", async () => {
    // The regression this guards: while the probe treated an auth failure as a
    // capability failure, a logged-out operator was told to reinstall a working
    // binary and never saw the CLI's actual complaint.
    const { runner } = runnerReturning(VERSION_OK, failed(1, 'Invalid API key - please run /login'));
    const provider = createClaudeCodeCliProvider(descriptor(), deps(runner));

    const failure = await provider
      .generate({ role: 'contract-author', prompt: 'x' })
      .then(() => undefined)
      .catch((error: unknown) => error as Error);

    expect(failure?.message).toMatch(/please run \/login/i);
    expect(failure?.message).not.toMatch(/too old/i);
  });
});
