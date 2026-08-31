import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProcessRunner } from '../../../src/infra/process-runner.js';
import { createProvider } from '../../../src/providers/index.js';
import { invoke } from '../../../src/providers/invoke.js';
import { probeClaudeAuth, probeClaudeCapability } from '../../../src/providers/claude-code-cli.js';
import { ProviderError } from '../../../src/domain/errors.js';
import type { ProviderDeps, ProviderDescriptor } from '../../../src/domain/agent-provider.js';
import {
  cleanupAllShims,
  writeClaudeShim,
  writeEmptyBinDir,
  type ShimMode,
} from '../../fixtures/bin/claude-shim.js';

/**
 * The claude adapter driven end to end through 2.3's REAL execa-backed
 * `ProcessRunner`, against executables named `claude` that this suite writes
 * itself and puts first on the child's PATH.
 *
 * Nothing here invokes the user's real CLI: AD-12 keeps the default suite free
 * of anything needing a subscription. The single real-CLI test at the bottom is
 * skipped unless explicitly enabled.
 *
 * The fake credential values below are deliberately not key-shaped. A realistic
 * placeholder in a repository is a liability even when it is worthless.
 */

const FAKE_KEY = 'not-a-real-key-integration-fixture';

afterEach(async () => {
  await cleanupAllShims();
  vi.restoreAllMocks();
});

const clock = { now: (): Date => new Date('2026-08-31T00:00:00.000Z') };

function depsWithPath(_binDir: string, warn: (message: string) => void = () => {}): ProviderDeps {
  return { processRunner: createProcessRunner(clock), clock, warn };
}

function descriptor(mode = 'subscription'): ProviderDescriptor {
  return { name: 'claude', adapter: 'claude-code-cli', mode };
}

/** Installs a shim by prepending its directory to PATH for the test's duration. */
async function withShimOnPath<T>(
  mode: ShimMode,
  body: (shim: Awaited<ReturnType<typeof writeClaudeShim>>) => Promise<T>,
  options: { recordStdin?: boolean } = {},
): Promise<T> {
  const shim = await writeClaudeShim(mode, options);
  const original = process.env.PATH;
  process.env.PATH = `${shim.dir}:${original ?? ''}`;
  try {
    return await body(shim);
  } finally {
    process.env.PATH = original;
  }
}

describe('claude adapter against a PATH shim', () => {
  it('spawns the exact baseline argv', async () => {
    await withShimOnPath('capable', async (shim) => {
      const provider = createProvider(descriptor(), depsWithPath(shim.dir));
      const raw = await provider.generate({ role: 'contract-author', prompt: 'draft it' });

      expect(raw).toBe('{"ok":true}');

      const invocations = await shim.invocations();
      // Two spawns: the capability probe, then the generation.
      const generation = invocations[invocations.length - 1];
      expect(generation?.argv).toEqual(['-p', '--output-format', 'json', 'draft it']);
    });
  });

  it('withholds the billing variable from the real child process', async () => {
    await withShimOnPath('capable', async (shim) => {
      process.env.ANTHROPIC_API_KEY = FAKE_KEY;
      try {
        const provider = createProvider(descriptor(), depsWithPath(shim.dir));
        await provider.generate({ role: 'contract-author', prompt: 'x' });

        const invocations = await shim.invocations();
        expect(invocations.length).toBeGreaterThan(0);
        for (const invocation of invocations) {
          // The strongest form of this assertion: the child REPORTED its own
          // environment, and the name is absent from it.
          expect('ANTHROPIC_API_KEY' in invocation.env).toBe(false);
        }

        // ...and the parent still has it. Withheld by construction, not by
        // mutating and restoring, which would race with anything concurrent.
        expect(process.env.ANTHROPIC_API_KEY).toBe(FAKE_KEY);
      } finally {
        delete process.env.ANTHROPIC_API_KEY;
      }
    });
  });

  it('warns naming the variable, never its value', async () => {
    await withShimOnPath('capable', async (shim) => {
      process.env.ANTHROPIC_API_KEY = FAKE_KEY;
      try {
        const warn = vi.fn();
        const provider = createProvider(descriptor(), depsWithPath(shim.dir, warn));
        await provider.generate({ role: 'contract-author', prompt: 'x' });

        const message = warn.mock.calls.flat().join('\n');
        expect(message).toContain('ANTHROPIC_API_KEY');
        expect(message).toContain('withheld from the claude subprocess');
        expect(message).not.toContain(FAKE_KEY);
      } finally {
        delete process.env.ANTHROPIC_API_KEY;
      }
    });
  });

  it('passes a shell-metacharacter prompt through as inert data', async () => {
    await withShimOnPath('capable', async (shim) => {
      const provider = createProvider(descriptor(), depsWithPath(shim.dir));
      const hostile = '$(touch /tmp/specwitness-pwned) `id` ; rm -rf / *';

      await provider.generate({ role: 'contract-author', prompt: hostile });

      const invocations = await shim.invocations();
      const generation = invocations[invocations.length - 1];
      // One opaque argument: no word splitting, no glob, no substitution.
      expect(generation?.argv).toEqual(['-p', '--output-format', 'json', hostile]);
    });
  });

  it('strips a fenced payload returned by the CLI', async () => {
    await withShimOnPath('fenced', async (shim) => {
      const provider = createProvider(descriptor(), depsWithPath(shim.dir));
      await expect(provider.generate({ role: 'contract-author', prompt: 'x' })).resolves.toBe(
        '{"ok":true}',
      );
    });
  });

  it('returns an empty payload as empty text', async () => {
    await withShimOnPath('empty-payload', async (shim) => {
      const provider = createProvider(descriptor(), depsWithPath(shim.dir));
      await expect(provider.generate({ role: 'contract-author', prompt: 'x' })).resolves.toBe('');
    });
  });

  it('reports a malformed envelope as a ProviderError, not a crash', async () => {
    await withShimOnPath('malformed', async (shim) => {
      const provider = createProvider(descriptor(), depsWithPath(shim.dir));
      await expect(
        provider.generate({ role: 'contract-author', prompt: 'x' }),
      ).rejects.toBeInstanceOf(ProviderError);
    });
  });

  it('names the expected field when the envelope shape has drifted', async () => {
    await withShimOnPath('wrong-shape', async (shim) => {
      const provider = createProvider(descriptor(), depsWithPath(shim.dir));
      await expect(provider.generate({ role: 'contract-author', prompt: 'x' })).rejects.toThrow(
        /result/i,
      );
    });
  });

  it('sends an oversized prompt on stdin with no prompt in argv', async () => {
    await withShimOnPath(
      'capable',
      async (shim) => {
        const provider = createProvider(descriptor(), depsWithPath(shim.dir));
        const huge = 'y'.repeat(70 * 1024);

        await provider.generate({ role: 'contract-author', prompt: huge });

        const invocations = await shim.invocations();
        const generation = invocations[invocations.length - 1];
        // Mutually exclusive: the real CLI APPENDS stdin to an argv prompt, so
        // sending both would silently duplicate it.
        expect(generation?.argv).toEqual(['-p', '--output-format', 'json']);
        expect(generation?.stdin).toBe(huge);
      },
      { recordStdin: true },
    );
  });

  it('times out a hung CLI and reports it as a provider failure', async () => {
    await withShimOnPath('hanging', async (shim) => {
      const provider = createProvider(descriptor(), depsWithPath(shim.dir));
      // The capability probe is bounded at 5s and hits first; either way the
      // failure is a ProviderError rather than an unbounded hang.
      await expect(
        provider.generate({ role: 'contract-author', prompt: 'x' }),
      ).rejects.toBeInstanceOf(ProviderError);
    });
  }, 30_000);
});

describe('capability and auth probes against a PATH shim', () => {
  it('reports a capable CLI with its version verbatim', async () => {
    await withShimOnPath('capable', async () => {
      const capability = await probeClaudeCapability(createProcessRunner(clock));

      expect(capability.found).toBe(true);
      expect(capability.nonInteractive).toBe(true);
      expect(capability.version).toContain('2.1.251');
    });
  });

  it('reports an absent binary without throwing, so doctor can stay exit 0', async () => {
    const empty = await writeEmptyBinDir();
    const original = process.env.PATH;
    // An EMPTY PATH: nothing named claude is reachable at all.
    process.env.PATH = empty.dir;
    try {
      const capability = await probeClaudeCapability(createProcessRunner(clock));
      expect(capability.found).toBe(false);
      expect(capability.reason).toMatch(/not found on PATH/i);
      // The actionable half UJ-4 asks for.
      expect(capability.reason).toMatch(/existing plans still run/i);
    } finally {
      process.env.PATH = original;
      await empty.cleanup();
    }
  });

  it('reports a binary that rejects the non-interactive flags', async () => {
    await withShimOnPath('version-only', async () => {
      const capability = await probeClaudeCapability(createProcessRunner(clock));

      expect(capability.found).toBe(true);
      expect(capability.nonInteractive).toBe(false);
      expect(capability.reason).toMatch(/rejected/i);
    });
  });

  it('reports auth as usable when a trivial invocation exits 0', async () => {
    await withShimOnPath('capable', async () => {
      const probe = await probeClaudeAuth(createProcessRunner(clock));
      expect(probe.ok).toBe(true);
      expect(probe.exitCode).toBe(0);
    });
  });

  it('reports a refusal with its exit code', async () => {
    await withShimOnPath('refuses', async () => {
      const probe = await probeClaudeAuth(createProcessRunner(clock));
      expect(probe.ok).toBe(false);
      expect(probe.exitCode).toBe(1);
      expect(probe.detail).toContain('Invalid API key');
    });
  });
});

describe('a claude-only configuration completes generation through the gate', () => {
  it('drives 2.3 gate → adapter → mocked binary with no codex anywhere', async () => {
    // The epic exit criterion: a project configuring ONLY claude must complete
    // provider invocation. Nothing here references the codex adapter, so a
    // hidden dependency on it would fail this test rather than Epic 7.
    await withShimOnPath('capable', async (shim) => {
      const provider = createProvider(descriptor(), depsWithPath(shim.dir));

      const response = await invoke(
        {
          role: 'contract-author',
          prompt: 'draft the contract',
          responseSchema: {
            safeParse(input: unknown) {
              return typeof input === 'object' && input !== null && 'ok' in input
                ? { success: true as const, data: input as { ok: boolean } }
                : { success: false as const, error: 'not the expected shape' };
            },
          },
        },
        { provider, clock },
      );

      expect(response.ok).toBe(true);
      expect(response.raw).toBe('{"ok":true}');
    });
  });
});

/**
 * The single real-CLI test (AD-12), SKIPPED BY DEFAULT.
 *
 * Enable deliberately with:
 *
 *   SPECWITNESS_REAL_CLI=1 pnpm vitest run tests/integration/providers
 *
 * It spawns the operator's actual `claude`, which consumes their subscription,
 * so it must never run in a default `pnpm test` and is never required for a PR.
 * This repo configures no vitest tag mechanism, so an env guard is the available
 * lever — see DECISIONS.md D13.
 */
describe.skipIf(process.env.SPECWITNESS_REAL_CLI === undefined)('real claude CLI (opt-in)', () => {
  it('completes one non-interactive round trip', async () => {
    const provider = createProvider(descriptor(), {
      processRunner: createProcessRunner(clock),
      clock,
      warn: () => {},
    });

    const raw = await provider.generate({
      role: 'contract-author',
      prompt: 'Reply with exactly: ok',
    });

    expect(raw.trim().length).toBeGreaterThan(0);
  }, 120_000);
});
