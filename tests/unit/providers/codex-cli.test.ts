/**
 * Unit tests for the Codex CLI adapter (story 2.5).
 *
 * These spawn NOTHING. Every subprocess outcome arrives through story 2.3's
 * `scriptedProcessRunner` fake, so the suite is fast, deterministic, and cannot
 * touch a real `codex`, `~/.codex/`, or anyone's ChatGPT subscription. The
 * PATH-shim work — real argv reaching a real process — lives in the integration
 * suite, where it belongs.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProcessResult, ProcessRunOptions, ProcessRunner } from '../../../src/domain/process-runner.js';
import { ProviderError } from '../../../src/domain/errors.js';
import {
  createCodexCliProvider,
  probeCodexAuth,
  probeCodexCapability,
  resetCodexProbeCache,
} from '../../../src/providers/codex-cli.js';

/** A `ProcessResult` with the boring fields filled in. */
function result(over: Partial<ProcessResult> = {}): ProcessResult {
  return {
    outcome: 'completed',
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 1,
    ...over,
  };
}

const VERSION_OK = result({ stdout: 'codex-cli 0.144.4\n' });

/** `codex exec --help` as codex-cli 0.144.4 prints it (verified 2026-08-31). */
const HELP_OK = result({
  stdout: [
    'Usage: codex exec [OPTIONS] [PROMPT]',
    '  -s, --sandbox <SANDBOX_MODE>',
    '  -C, --cd <DIR>',
    '      --skip-git-repo-check',
    '      --output-schema <FILE>',
    '      --json',
    '  -o, --output-last-message <FILE>',
  ].join('\n'),
});

/**
 * A runner that answers from a queue and records every call, so a test can
 * assert on exact argv. Story 2.3 ships `scriptedProcessRunner`; this local
 * variant additionally lets a call WRITE the last-message file, which the
 * adapter reads back — behaviour a pure value-returning fake cannot express.
 */
function recordingRunner(
  responses: readonly (ProcessResult | ((o: ProcessRunOptions) => Promise<ProcessResult>))[],
): ProcessRunner & { calls: ProcessRunOptions[] } {
  const calls: ProcessRunOptions[] = [];
  let index = 0;
  return {
    calls,
    run: async (options) => {
      calls.push(options);
      const next = responses[index++];
      if (next === undefined) {
        throw new Error(`unexpected extra subprocess call: ${options.binary} ${options.args.join(' ')}`);
      }
      return typeof next === 'function' ? next(options) : next;
    },
  };
}

/** Makes the invocation succeed by writing the answer the adapter will read. */
function writesAnswer(answer: string) {
  return async (options: ProcessRunOptions): Promise<ProcessResult> => {
    const at = options.args.indexOf('--output-last-message');
    const path = options.args[at + 1];
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path as string, answer, 'utf8');
    return result({ stdout: 'codex: working...', stderr: 'codex: 1 file read' });
  };
}

const DESCRIPTOR = { name: 'codex', mode: 'chatgpt' } as const;

afterEach(() => {
  resetCodexProbeCache();
  vi.unstubAllEnvs();
});

describe('probeCodexCapability', () => {
  it('reports a capable codex, with the version it reported', async () => {
    const runner = recordingRunner([VERSION_OK, HELP_OK]);

    const capability = await probeCodexCapability(runner);

    expect(capability).toEqual({
      binary: 'codex',
      found: true,
      version: '0.144.4',
      execAvailable: true,
      outputSchemaSupported: true,
      skipGitRepoCheckSupported: true,
      reason: undefined,
    });
  });

  it('reports a MISSING binary as a flag, never a throw', async () => {
    // UJ-4: a missing agent CLI must never make `doctor` exit non-zero. Story
    // 2.7 renders this as a warning, so it must arrive as data.
    const runner = recordingRunner([result({ outcome: 'not-found', exitCode: null })]);

    const capability = await probeCodexCapability(runner);

    expect(capability.found).toBe(false);
    expect(capability.execAvailable).toBe(false);
    // The operator reads this before the first real run: it must say what is
    // lost and what still works, not "probe failed".
    expect(capability.reason).toBe(
      'codex not found on PATH — contract generation unavailable; existing plans still run',
    );
  });

  it('does not accept a non-Codex program on PATH as proof of capability', async () => {
    // The nastiest case: a DIFFERENT program named `codex` earlier on PATH. It
    // exits 0 and prints plausible text, so an exit-code-only probe would
    // wrongly report the real CLI as installed.
    const impostor = result({ stdout: 'codex 1.0 - unrelated tool' });
    const runner = recordingRunner([impostor, impostor]);

    const capability = await probeCodexCapability(runner);

    expect(capability.outputSchemaSupported).toBe(false);
    expect(capability.reason).toMatch(/does not accept --output-schema/);
  });

  it('reports a codex whose exec rejects --output-schema', async () => {
    const oldHelp = result({
      stdout: 'Usage: codex exec [OPTIONS] [PROMPT]\n  -C, --cd <DIR>\n  -o, --output-last-message <FILE>',
    });
    const runner = recordingRunner([VERSION_OK, oldHelp]);

    const capability = await probeCodexCapability(runner);

    expect(capability.execAvailable).toBe(true);
    expect(capability.outputSchemaSupported).toBe(false);
    expect(capability.skipGitRepoCheckSupported).toBe(false);
    expect(capability.reason).toContain('--output-schema');
  });

  it('reports a codex with no exec subcommand at all', async () => {
    const runner = recordingRunner([
      VERSION_OK,
      result({ exitCode: 2, stderr: "error: unrecognized subcommand 'exec'" }),
    ]);

    const capability = await probeCodexCapability(runner);

    expect(capability.execAvailable).toBe(false);
    expect(capability.reason).toMatch(/no usable "exec" subcommand/);
  });

  it('reports a failing --version without claiming the binary is absent', async () => {
    // "Found something called codex that we cannot identify" is a different
    // state from "nothing on PATH", and doctor renders them differently.
    const runner = recordingRunner([result({ exitCode: 2, stderr: 'boom' })]);

    const capability = await probeCodexCapability(runner);

    expect(capability.found).toBe(false);
    expect(capability.reason).toMatch(/could not be identified/);
  });

  it('reports a hang as a timeout naming the bound, not as a missing binary', async () => {
    const runner = recordingRunner([result({ outcome: 'timed-out', exitCode: null })]);

    const capability = await probeCodexCapability(runner, { timeoutMs: 5000 });

    expect(capability.reason).toBe(
      'codex did not respond within 5000ms — could not determine capability',
    );
  });

  it('probes ONCE per session even for concurrent callers', async () => {
    // The addendum points both `contract-author` and `plan-author` at codex, and
    // doctor's registry is sequential — so re-probing per role would show up as
    // a slow diagnostic.
    const runner = recordingRunner([VERSION_OK, HELP_OK]);

    const [a, b] = await Promise.all([probeCodexCapability(runner), probeCodexCapability(runner)]);

    expect(a).toEqual(b);
    expect(runner.calls).toHaveLength(2); // --version and exec --help, once each
  });

  it('bounds every probe spawn with an explicit timeout', async () => {
    const runner = recordingRunner([VERSION_OK, HELP_OK]);

    await probeCodexCapability(runner, { timeoutMs: 1234 });

    expect(runner.calls.map((c) => c.timeoutMs)).toEqual([1234, 1234]);
  });
});

describe('probeCodexAuth', () => {
  it('reports usable auth when `codex doctor` exits 0', async () => {
    const runner = recordingRunner([result({ stdout: 'Authentication: OK' })]);

    await expect(probeCodexAuth(runner)).resolves.toEqual({
      ok: true,
      exitCode: 0,
      conclusive: true,
    });
  });

  it('asks `codex doctor` — never the filesystem (Q58, NFR-1)', async () => {
    const runner = recordingRunner([result()]);

    await probeCodexAuth(runner);

    expect(runner.calls[0]?.binary).toBe('codex');
    expect(runner.calls[0]?.args).toEqual(['doctor']);
  });

  it('distinguishes "said no" (conclusive) from "could not tell"', async () => {
    // dolph (2.7) asked for this split: "could not tell" is NOT a diagnosis
    // about the user's auth and must never be rendered as one.
    const saidNo = recordingRunner([
      result({ exitCode: 1, stderr: "Not signed in. Run 'codex login'." }),
    ]);
    await expect(probeCodexAuth(saidNo)).resolves.toEqual({
      ok: false,
      exitCode: 1,
      conclusive: true,
      detail: "Not signed in. Run 'codex login'.",
    });

    resetCodexProbeCache();

    const noSubcommand = recordingRunner([
      result({ exitCode: 2, stderr: "error: unrecognized subcommand 'doctor'" }),
    ]);
    await expect(probeCodexAuth(noSubcommand)).resolves.toEqual({
      ok: false,
      exitCode: 2,
      conclusive: false,
      detail: 'this codex has no "doctor" subcommand — could not determine auth readiness',
    });
  });

  it('reports a timeout as inconclusive with exitCode null', async () => {
    const runner = recordingRunner([result({ outcome: 'timed-out', exitCode: null })]);

    await expect(probeCodexAuth(runner, { timeoutMs: 5000 })).resolves.toEqual({
      ok: false,
      exitCode: null,
      conclusive: false,
      detail: 'codex doctor did not respond within 5000ms — could not determine auth readiness',
    });
  });
});

describe('generate — argv translation (AC1)', () => {
  it('builds the exact argv codex exec expects, in order', async () => {
    const runner = recordingRunner([VERSION_OK, HELP_OK, writesAnswer('{"criteria":[]}')]);
    const provider = createCodexCliProvider(DESCRIPTOR, { runner, warn: vi.fn() }, {
      cwd: '/work/project',
    });

    await provider.generate({ role: 'contract-author', prompt: 'author the contract', jsonSchema: { type: 'object' } });

    const exec = runner.calls[2];
    expect(exec?.binary).toBe('codex');
    // Element-by-element, not a substring match: the ORDER and the exact flags
    // are the acceptance criterion.
    expect(exec?.args).toEqual([
      'exec',
      '--output-schema',
      expect.stringMatching(/response-schema\.json$/) as unknown as string,
      '--output-last-message',
      expect.stringMatching(/last-message\.txt$/) as unknown as string,
      '--cd',
      '/work/project',
      '--skip-git-repo-check',
      'author the contract',
    ]);
    // -C is passed EXPLICITLY; cwd is never merely inherited.
    expect(exec?.cwd).toBe('/work/project');
  });

  it('omits --skip-git-repo-check when the CLI did not advertise it', async () => {
    const helpWithoutSkip = result({
      stdout: 'Usage: codex exec\n      --output-schema <FILE>\n  -o, --output-last-message <FILE>',
    });
    const runner = recordingRunner([VERSION_OK, helpWithoutSkip, writesAnswer('{}')]);
    const provider = createCodexCliProvider(DESCRIPTOR, { runner, warn: vi.fn() });

    await provider.generate({ role: 'contract-author', prompt: 'p', jsonSchema: {} });

    expect(runner.calls[2]?.args).not.toContain('--skip-git-repo-check');
  });

  it('omits --output-schema when the gate supplied no schema', async () => {
    // `jsonSchema` is optional: story 2.3's gate derives it, but an
    // unrepresentable schema (or a non-zod validator in a test) leaves it unset.
    // The adapter must NOT derive one itself — two derivations that can disagree
    // is the AD-2 failure of validation happening twice.
    const runner = recordingRunner([VERSION_OK, HELP_OK, writesAnswer('{}')]);
    const provider = createCodexCliProvider(DESCRIPTOR, { runner, warn: vi.fn() });

    await provider.generate({ role: 'contract-author', prompt: 'p' });

    expect(runner.calls[2]?.args).not.toContain('--output-schema');
  });

  it('writes the gate\'s schema through verbatim', async () => {
    const schema = { type: 'object', properties: { criteria: { type: 'array' } } };
    let written: string | undefined;
    const runner = recordingRunner([
      VERSION_OK,
      HELP_OK,
      async (options) => {
        const { readFile, writeFile } = await import('node:fs/promises');
        written = await readFile(options.args[options.args.indexOf('--output-schema') + 1] as string, 'utf8');
        await writeFile(options.args[options.args.indexOf('--output-last-message') + 1] as string, '{}', 'utf8');
        return result();
      },
    ]);
    const provider = createCodexCliProvider(DESCRIPTOR, { runner, warn: vi.fn() });

    await provider.generate({ role: 'contract-author', prompt: 'p', jsonSchema: schema });

    expect(JSON.parse(written as string)).toEqual(schema);
  });

  it('passes a prompt full of shell metacharacters as ONE inert argv element', async () => {
    // AD-3, proved rather than asserted in a comment. argv arrays reach execve
    // directly, so there is no shell to interpret any of this.
    const hostile = 'x; rm -rf / && echo $(whoami) `id` | tee /tmp/pwned';
    const runner = recordingRunner([VERSION_OK, HELP_OK, writesAnswer('{}')]);
    const provider = createCodexCliProvider(DESCRIPTOR, { runner, warn: vi.fn() });

    await provider.generate({ role: 'contract-author', prompt: hostile, jsonSchema: {} });

    const args = runner.calls[2]?.args ?? [];
    expect(args.at(-1)).toBe(hostile);
    expect(args.filter((a) => a === hostile)).toHaveLength(1);
  });

  it('returns the model text RAW, with a code fence stripped', async () => {
    const runner = recordingRunner([
      VERSION_OK,
      HELP_OK,
      writesAnswer('```json\n{"criteria":[]}\n```\n'),
    ]);
    const provider = createCodexCliProvider(DESCRIPTOR, { runner, warn: vi.fn() });

    const raw = await provider.generate({ role: 'contract-author', prompt: 'p', jsonSchema: {} });

    // Raw TEXT — never parsed, never validated. The gate does that (AD-2).
    expect(raw).toBe('{"criteria":[]}');
  });

  it('does not treat non-empty stderr as failure', async () => {
    // codex writes progress to stderr; that is why we read the answer FILE.
    const runner = recordingRunner([
      VERSION_OK,
      HELP_OK,
      async (options) => {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(options.args[options.args.indexOf('--output-last-message') + 1] as string, 'ok', 'utf8');
        return result({ stderr: 'codex: thinking...\ncodex: 3 files read' });
      },
    ]);
    const provider = createCodexCliProvider(DESCRIPTOR, { runner, warn: vi.fn() });

    await expect(
      provider.generate({ role: 'contract-author', prompt: 'p', jsonSchema: {} }),
    ).resolves.toBe('ok');
  });
});

describe('generate — failure classification', () => {
  it('names the missing file when codex exits 0 but writes no answer', async () => {
    // A failed or killed run can exit 0 having written nothing. This must never
    // surface as a TypeError, and never as a silent empty success.
    const runner = recordingRunner([VERSION_OK, HELP_OK, result({ stderr: 'thinking...' })]);
    const provider = createCodexCliProvider(DESCRIPTOR, { runner, warn: vi.fn() });

    const error = await provider
      .generate({ role: 'contract-author', prompt: 'p', jsonSchema: {} })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toMatch(/wrote no final message to .*last-message\.txt/);
  });

  it('refuses to invoke a codex that cannot do the job (AD-4 capability error)', async () => {
    const runner = recordingRunner([result({ outcome: 'not-found', exitCode: null })]);
    const provider = createCodexCliProvider(DESCRIPTOR, { runner, warn: vi.fn() });

    const error = await provider
      .generate({ role: 'contract-author', prompt: 'p', jsonSchema: {} })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    // A hopeful invocation is exactly what AD-4 forbids: only two calls happen
    // (the probe), never an exec.
    expect(runner.calls).toHaveLength(1);
  });

  it('classifies a timeout as a provider error naming the bound', async () => {
    const runner = recordingRunner([
      VERSION_OK,
      HELP_OK,
      result({ outcome: 'timed-out', exitCode: null }),
    ]);
    const provider = createCodexCliProvider(DESCRIPTOR, { runner, warn: vi.fn() }, { timeoutMs: 900 });

    await expect(
      provider.generate({ role: 'contract-author', prompt: 'p', jsonSchema: {} }),
    ).rejects.toThrow(/did not finish within 900ms/);
  });

  it('classifies a non-zero exit as a provider error carrying what codex said', async () => {
    const runner = recordingRunner([
      VERSION_OK,
      HELP_OK,
      result({ exitCode: 1, stderr: 'stream error: connection reset' }),
    ]);
    const provider = createCodexCliProvider(DESCRIPTOR, { runner, warn: vi.fn() });

    await expect(
      provider.generate({ role: 'contract-author', prompt: 'p', jsonSchema: {} }),
    ).rejects.toThrow(/stream error: connection reset/);
  });
});

describe('generate — billing safety (AC2, FR-15)', () => {
  it('withholds OPENAI_API_KEY from the child and warns naming it', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'FAKE-BILLING-VALUE-MUST-NOT-REACH-THE-CHILD');
    const warn = vi.fn();
    const runner = recordingRunner([VERSION_OK, HELP_OK, writesAnswer('{}')]);
    const provider = createCodexCliProvider(DESCRIPTOR, { runner, warn });

    await provider.generate({ role: 'contract-author', prompt: 'p', jsonSchema: {} });

    expect(runner.calls[2]?.env).toEqual({ inherit: true, withhold: ['OPENAI_API_KEY'] });
    expect(warn).toHaveBeenCalledWith(
      '⚠ OPENAI_API_KEY present in environment — withheld from the codex subprocess (mode: chatgpt)',
    );
  });

  it('NEVER mutates the parent environment', async () => {
    // Withholding is by CONSTRUCTION. No `delete process.env.X`, no assignment.
    // Getting this wrong would break the surrounding process, and the bug would
    // surface far away from this file.
    vi.stubEnv('OPENAI_API_KEY', 'FAKE-BILLING-VALUE-MUST-NOT-REACH-THE-CHILD');
    const runner = recordingRunner([VERSION_OK, HELP_OK, writesAnswer('{}')]);
    const provider = createCodexCliProvider(DESCRIPTOR, { runner, warn: vi.fn() });

    await provider.generate({ role: 'contract-author', prompt: 'p', jsonSchema: {} });

    expect(process.env.OPENAI_API_KEY).toBe('FAKE-BILLING-VALUE-MUST-NOT-REACH-THE-CHILD');
  });

  it('counts a SET BUT EMPTY variable as present', async () => {
    // Presence of the NAME is what matters; we never look at the value. Agreed
    // with story 2.4 so the two adapters cannot disagree.
    vi.stubEnv('OPENAI_API_KEY', '');
    const warn = vi.fn();
    const runner = recordingRunner([VERSION_OK, HELP_OK, writesAnswer('{}')]);
    const provider = createCodexCliProvider(DESCRIPTOR, { runner, warn });

    await provider.generate({ role: 'contract-author', prompt: 'p', jsonSchema: {} });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('OPENAI_API_KEY present in environment'));
  });

  it('does not warn when no billing variable is present', async () => {
    vi.stubEnv('OPENAI_API_KEY', undefined);
    const warn = vi.fn();
    const runner = recordingRunner([VERSION_OK, HELP_OK, writesAnswer('{}')]);
    const provider = createCodexCliProvider(DESCRIPTOR, { runner, warn });

    await provider.generate({ role: 'contract-author', prompt: 'p', jsonSchema: {} });

    expect(warn).not.toHaveBeenCalled();
    // Withholding a name that is absent is a harmless no-op, so it stays in the
    // list: the guarantee must not depend on what happened to be set.
    expect(runner.calls[2]?.env).toEqual({ inherit: true, withhold: ['OPENAI_API_KEY'] });
  });

  it('withholds project-declared billing variables too', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'a');
    vi.stubEnv('OPENAI_ORG_KEY', 'b');
    const warn = vi.fn();
    const runner = recordingRunner([VERSION_OK, HELP_OK, writesAnswer('{}')]);
    const provider = createCodexCliProvider(DESCRIPTOR, { runner, warn }, {
      billingEnvVars: ['OPENAI_ORG_KEY'],
    });

    await provider.generate({ role: 'contract-author', prompt: 'p', jsonSchema: {} });

    expect(runner.calls[2]?.env).toEqual({
      inherit: true,
      withhold: ['OPENAI_API_KEY', 'OPENAI_ORG_KEY'],
    });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('withholds even under an UNRECOGNIZED mode, and says so', async () => {
    // There is no mode that opts into API billing: `mode` is validated only as a
    // non-empty string (story 1.3), and no planning artifact defines an
    // API-billing mode. So a typo like `subscribtion` must not become a silent
    // charge on the user's account. Failing safe on money is cheaper than the
    // alternative, and story 2.4 makes the same call.
    vi.stubEnv('OPENAI_API_KEY', 'FAKE-BILLING-VALUE');
    const warn = vi.fn();
    const runner = recordingRunner([VERSION_OK, HELP_OK, writesAnswer('{}')]);
    const provider = createCodexCliProvider(
      { name: 'codex', mode: 'subscribtion' },
      { runner, warn },
    );

    await provider.generate({ role: 'contract-author', prompt: 'p', jsonSchema: {} });

    expect(runner.calls[2]?.env).toEqual({ inherit: true, withhold: ['OPENAI_API_KEY'] });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('unrecognized provider mode "subscribtion"'),
    );
  });

  it('never puts a billing value into the argv or the env `set` block', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'FAKE-BILLING-VALUE-MUST-NOT-REACH-THE-CHILD');
    const runner = recordingRunner([VERSION_OK, HELP_OK, writesAnswer('{}')]);
    const provider = createCodexCliProvider(DESCRIPTOR, { runner, warn: vi.fn() });

    await provider.generate({ role: 'contract-author', prompt: 'p', jsonSchema: {} });

    for (const call of runner.calls) {
      expect(JSON.stringify(call.args)).not.toContain('FAKE-BILLING-VALUE-MUST-NOT-REACH-THE-CHILD');
      expect(JSON.stringify(call.env)).not.toContain('FAKE-BILLING-VALUE-MUST-NOT-REACH-THE-CHILD');
    }
  });
});

describe('generate — temp file hygiene', () => {
  it('removes its workspace on the SUCCESS path', async () => {
    let schemaPath = '';
    const runner = recordingRunner([
      VERSION_OK,
      HELP_OK,
      async (options) => {
        schemaPath = options.args[options.args.indexOf('--output-schema') + 1] as string;
        const { writeFile } = await import('node:fs/promises');
        await writeFile(options.args[options.args.indexOf('--output-last-message') + 1] as string, '{}', 'utf8');
        return result();
      },
    ]);
    const provider = createCodexCliProvider(DESCRIPTOR, { runner, warn: vi.fn() });

    await provider.generate({ role: 'contract-author', prompt: 'p', jsonSchema: {} });

    const { access } = await import('node:fs/promises');
    await expect(access(schemaPath)).rejects.toThrow();
  });

  it('removes its workspace on the THROW path', async () => {
    // A failed invocation must leave nothing behind: cleanup is in a `finally`.
    let schemaPath = '';
    const runner = recordingRunner([
      VERSION_OK,
      HELP_OK,
      async (options) => {
        schemaPath = options.args[options.args.indexOf('--output-schema') + 1] as string;
        return result({ exitCode: 1, stderr: 'boom' });
      },
    ]);
    const provider = createCodexCliProvider(DESCRIPTOR, { runner, warn: vi.fn() });

    await provider
      .generate({ role: 'contract-author', prompt: 'p', jsonSchema: {} })
      .catch(() => undefined);

    const { access } = await import('node:fs/promises');
    await expect(access(schemaPath)).rejects.toThrow();
  });

  it('gives concurrent invocations non-colliding workspaces', async () => {
    const seen: string[] = [];
    const answering = async (options: ProcessRunOptions): Promise<ProcessResult> => {
      const path = options.args[options.args.indexOf('--output-last-message') + 1] as string;
      seen.push(path);
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path, '{}', 'utf8');
      return result();
    };

    // Warm the SESSION cache first. Capability is memoised per binary for the
    // process, not per provider instance — that is the point of it (several
    // configured roles resolve to one codex and must probe once) — so the two
    // providers below each perform exactly ONE subprocess call, the exec.
    await probeCodexCapability(recordingRunner([VERSION_OK, HELP_OK]));

    await Promise.all(
      [recordingRunner([answering]), recordingRunner([answering])].map((runner) =>
        createCodexCliProvider(DESCRIPTOR, { runner, warn: vi.fn() }).generate({
          role: 'contract-author',
          prompt: 'p',
          jsonSchema: {},
        }),
      ),
    );

    // Two `mkdtemp` workspaces, so a filename collision is impossible by
    // construction rather than by an entropy scheme we would have to trust.
    expect(seen).toHaveLength(2);
    expect(new Set(seen).size).toBe(2);
  });

  it('shares the capability cache across provider instances', async () => {
    // Stated as its own assertion because the test above DEPENDS on it, and a
    // dependency that is only implied is one a later edit can silently break.
    await probeCodexCapability(recordingRunner([VERSION_OK, HELP_OK]));

    const runner = recordingRunner([writesAnswer('{}')]);
    await createCodexCliProvider(DESCRIPTOR, { runner, warn: vi.fn() }).generate({
      role: 'contract-author',
      prompt: 'p',
      jsonSchema: {},
    });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.args[0]).toBe('exec');
  });
});

describe('the adapter identity', () => {
  it('reports its config key and adapter id, and hardcodes no role', async () => {
    // Epic 4 reuses this adapter for `plan-author`, so nothing role-specific may
    // be baked in. The role travels in the envelope and changes no behaviour.
    const runner = recordingRunner([VERSION_OK, HELP_OK, writesAnswer('{}'), writesAnswer('{}')]);
    const provider = createCodexCliProvider({ name: 'my-codex', mode: 'chatgpt' }, {
      runner,
      warn: vi.fn(),
    });

    expect(provider.id).toBe('my-codex');
    expect(provider.adapter).toBe('codex-cli');

    await provider.generate({ role: 'contract-author', prompt: 'same', jsonSchema: {} });
    await provider.generate({ role: 'plan-author', prompt: 'same', jsonSchema: {} });

    const withoutTempPaths = (args: readonly string[]): string[] =>
      args.filter((a) => !a.includes('specwitness-codex-'));
    expect(withoutTempPaths(runner.calls[2]?.args ?? [])).toEqual(
      withoutTempPaths(runner.calls[3]?.args ?? []),
    );
  });
});
