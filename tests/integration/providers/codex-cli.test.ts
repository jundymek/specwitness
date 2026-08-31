/**
 * Integration tests for the Codex CLI adapter (story 2.5).
 *
 * Unlike the unit suite, these spawn REAL subprocesses — but never the real
 * Codex CLI. A shell script named `codex` is installed into a temp directory
 * placed first on the CHILD's PATH, so the adapter's argv, cwd and environment
 * travel through `execve` exactly as they would in production, and the fake
 * records what actually arrived.
 *
 * That distinction is the point. The unit suite proves the adapter builds the
 * right argv; only this suite proves the argv SURVIVES the trip — that a prompt
 * full of shell metacharacters is inert because there is no shell, and that a
 * withheld variable really is absent from the child rather than merely absent
 * from an options object.
 *
 * NOTHING here touches `~/.codex/`, consumes a ChatGPT subscription, or requires
 * codex to be installed. The one real-CLI test lives at the bottom, tagged and
 * skipped by default (AD-12).
 *
 * Note on the fake credential values below: they are deliberately NOT shaped
 * like a real OpenAI key. A realistic-looking literal in a repository trips
 * secret scanners and teaches the wrong habit; a sentinel proves the same thing.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { SystemClock } from '../../../src/infra/clock.js';
import { createProvider } from '../../../src/providers/index.js';
import { invoke } from '../../../src/providers/invoke.js';
import { createProcessRunner } from '../../../src/infra/process-runner.js';
import { ProviderError } from '../../../src/domain/errors.js';
import {
  createCodexCliProvider,
  probeCodexAuth,
  probeCodexCapability,
  resetCodexProbeCache,
} from '../../../src/providers/codex-cli.js';
import {
  installCodexShim,
  installMissingCodex,
  type CodexShimMode,
} from '../../fixtures/bin/install-shim.js';

const runner = createProcessRunner(new SystemClock());

/** Every spawn in this file is bounded; a hung fake must fail, not hang CI. */
const TIMEOUT_MS = 10_000;

/** A sentinel that must never reach the child. Not key-shaped, on purpose. */
const BILLING_SENTINEL = 'FAKE-BILLING-VALUE-MUST-NOT-REACH-THE-CHILD';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  resetCodexProbeCache();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

/**
 * Installs the fake and puts it FIRST on PATH — for this process, because the
 * adapter inherits the parent environment to build the child's. `vi.stubEnv`
 * restores it after each test, so no other suite is affected.
 */
async function withShim(mode: CodexShimMode = 'capable', answer?: string) {
  const shim = await installCodexShim({ mode, answer });
  cleanups.push(shim.cleanup);
  vi.stubEnv('PATH', shim.pathPrefixedWith(process.env.PATH));
  return shim;
}

function codexProvider(cwd: string, overrides: Record<string, unknown> = {}) {
  return createCodexCliProvider(
    { name: 'codex', mode: 'chatgpt' },
    { runner, warn: vi.fn() },
    { cwd, timeoutMs: TIMEOUT_MS, probeTimeoutMs: TIMEOUT_MS, ...overrides },
  );
}

describe('capability probing against a real subprocess', () => {
  it('reports a capable codex', async () => {
    await withShim('capable');

    const capability = await probeCodexCapability(runner, { timeoutMs: TIMEOUT_MS });

    expect(capability.found).toBe(true);
    expect(capability.version).toBe('0.144.4');
    expect(capability.execAvailable).toBe(true);
    expect(capability.outputSchemaSupported).toBe(true);
    expect(capability.skipGitRepoCheckSupported).toBe(true);
  });

  it('reports a genuinely absent binary as not-found, never a throw', async () => {
    // A REAL ENOENT from the operating system: PATH points at a directory with
    // no `codex` in it, rather than a shim pretending to be missing.
    const absent = await installMissingCodex();
    cleanups.push(absent.cleanup);
    vi.stubEnv('PATH', absent.dir);

    const capability = await probeCodexCapability(runner, { timeoutMs: TIMEOUT_MS });

    expect(capability.found).toBe(false);
    expect(capability.reason).toContain('not found on PATH');
  });

  it('rejects a program named codex that is not the Codex CLI', async () => {
    await withShim('not-codex');

    const capability = await probeCodexCapability(runner, { timeoutMs: TIMEOUT_MS });

    // It exited 0 and printed plausible text. Exit status alone would have
    // wrongly accepted it; the `--output-schema` probe is what holds the line.
    expect(capability.outputSchemaSupported).toBe(false);
  });

  it('reports an older codex whose exec lacks --output-schema', async () => {
    await withShim('exec-rejecting');

    const capability = await probeCodexCapability(runner, { timeoutMs: TIMEOUT_MS });

    expect(capability.execAvailable).toBe(true);
    expect(capability.outputSchemaSupported).toBe(false);
  });

  it('times out on a hanging binary instead of hanging the suite', async () => {
    await withShim('hanging');

    const capability = await probeCodexCapability(runner, { timeoutMs: 750 });

    expect(capability.reason).toContain('did not respond within 750ms');
  });
});

describe('auth probing via `codex doctor` (Q58)', () => {
  it('reports usable auth', async () => {
    await withShim('capable');
    await expect(probeCodexAuth(runner, { timeoutMs: TIMEOUT_MS })).resolves.toMatchObject({
      ok: true,
      conclusive: true,
    });
  });

  it('reports "not signed in" as a conclusive no', async () => {
    await withShim('auth-missing');
    await expect(probeCodexAuth(runner, { timeoutMs: TIMEOUT_MS })).resolves.toMatchObject({
      ok: false,
      conclusive: true,
    });
  });

  it('reports a missing doctor subcommand as inconclusive, not as bad auth', async () => {
    await withShim('no-doctor-subcommand');
    await expect(probeCodexAuth(runner, { timeoutMs: TIMEOUT_MS })).resolves.toMatchObject({
      ok: false,
      conclusive: false,
    });
  });
});

describe('invocation against a real subprocess (AC1)', () => {
  it('sends the exact argv, and codex really receives it', async () => {
    const shim = await withShim('capable', '{"criteria":[]}');
    const work = await mkdtemp(join(tmpdir(), 'specwitness-cwd-'));
    cleanups.push(() => rm(work, { recursive: true, force: true }));

    const raw = await codexProvider(work).generate({
      role: 'contract-author',
      prompt: 'author the contract',
      jsonSchema: { type: 'object' },
    });

    // Exact argv, element by element — the acceptance criterion is the whole
    // array and its ORDER, not that a few flags appear somewhere in it.
    const argv = await shim.argv();
    expect(argv).toEqual([
      'exec',
      '--output-schema',
      expect.stringMatching(/response-schema\.json$/) as unknown as string,
      '--output-last-message',
      expect.stringMatching(/last-message\.txt$/) as unknown as string,
      '--cd',
      work,
      '--skip-git-repo-check',
      'author the contract',
    ]);
    // The target directory is asserted TWICE, by different means, because the
    // adapter sets it two ways and both matter: `--cd <work>` in the argv above
    // (what codex is TOLD), and the spawn's own working directory here (where
    // the process actually STARTED). The fake reports its real `pwd`, so this
    // half would catch a cwd that was merely inherited rather than passed.
    //
    // Compared through `realpath` because macOS resolves `/var` to
    // `/private/var`, so the child's `pwd` is the resolved form of the path we
    // passed — a property of the platform, not a discrepancy in the adapter.
    const { realpath } = await import('node:fs/promises');
    expect(await shim.cwd()).toBe(await realpath(work));
    expect(raw).toBe('{"criteria":[]}');
  });

  it('hands codex the schema the gate produced, byte for byte', async () => {
    const shim = await withShim('capable', '{}');
    const schema = { type: 'object', properties: { criteria: { type: 'array' } } };

    await codexProvider(process.cwd()).generate({
      role: 'contract-author',
      prompt: 'p',
      jsonSchema: schema,
    });

    expect(JSON.parse((await shim.schema()) as string)).toEqual(schema);
  });

  it('a prompt full of shell metacharacters is inert (AD-3)', async () => {
    // The strongest form of this test: a REAL process, a REAL argv, and a side
    // effect that would exist if any shell had ever seen the string.
    const shim = await withShim('capable', '{}');
    const canary = join(tmpdir(), `specwitness-canary-${String(process.pid)}`);
    const hostile = `x; touch ${canary} && echo $(whoami) \`id\` | tee ${canary}`;

    await codexProvider(process.cwd()).generate({
      role: 'contract-author',
      prompt: hostile,
      jsonSchema: {},
    });

    // Arrived whole and uninterpreted...
    expect(await shim.argv()).toContain(hostile);
    // ...and nothing executed it.
    const { access } = await import('node:fs/promises');
    await expect(access(canary)).rejects.toThrow();
  });

  it('sends an oversized prompt on stdin, not in argv', async () => {
    // Linux caps a SINGLE argument at MAX_ARG_STRLEN (128 KiB) independently of
    // the much larger ARG_MAX, so a big prompt that works on macOS fails with
    // E2BIG on Linux and in CI. A contract prompt carries an EpicSpec plus its
    // criteria, so this size is realistic rather than hypothetical. codex
    // documents `-` as "read the instructions from stdin", so this uses the
    // CLI's own mechanism.
    const shim = await withShim('capable', '{}');
    const huge = 'x'.repeat(70 * 1024);

    await codexProvider(process.cwd()).generate({
      role: 'contract-author',
      prompt: huge,
      jsonSchema: {},
    });

    const argv = await shim.argv();
    expect(argv.at(-1)).toBe('-');
    // The prompt itself must NOT also be in argv — that is the whole point.
    expect(argv.some((a) => a.length > 1024)).toBe(false);
    // Exclusive paths: codex appends a piped stdin as a `<stdin>` BLOCK when a
    // prompt argument is present too, so sending both would duplicate it.
    expect(argv.filter((a) => a === '-')).toHaveLength(1);
  });

  it('keeps an ordinary prompt in argv (the trivially-provable AD-3 path)', async () => {
    const shim = await withShim('capable', '{}');

    await codexProvider(process.cwd()).generate({
      role: 'contract-author',
      prompt: 'a normal prompt',
      jsonSchema: {},
    });

    expect((await shim.argv()).at(-1)).toBe('a normal prompt');
  });

  it('surfaces a missing last-message file as a named provider failure', async () => {
    // The shim exits 0 and writes nothing — a real failure mode for a killed or
    // failed run. Never a TypeError, never a silent empty success.
    await withShim('last-message-missing');

    const error = await codexProvider(process.cwd())
      .generate({ role: 'contract-author', prompt: 'p', jsonSchema: {} })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toMatch(
      /wrote no final message to .*last-message\.txt/,
    );
  });

  it('classifies a non-zero exit as a provider error', async () => {
    await withShim('nonzero-exit');

    const error = await codexProvider(process.cwd())
      .generate({ role: 'contract-author', prompt: 'p', jsonSchema: {} })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toContain('stream error');
  });

  it('leaves no temp files behind', async () => {
    const shim = await withShim('capable', '{}');

    await codexProvider(process.cwd()).generate({
      role: 'contract-author',
      prompt: 'p',
      jsonSchema: {},
    });

    const argv = await shim.argv();
    const schemaPath = argv[argv.indexOf('--output-schema') + 1] as string;
    const { access } = await import('node:fs/promises');
    await expect(access(schemaPath)).rejects.toThrow();
  });

  it('does not treat codex progress on stderr as failure', async () => {
    // The capable shim writes to BOTH streams on every exec.
    const shim = await withShim('capable', 'the answer');

    await expect(
      codexProvider(process.cwd()).generate({
        role: 'contract-author',
        prompt: 'p',
        jsonSchema: {},
      }),
    ).resolves.toBe('the answer');
    expect(await shim.invocations()).toBeGreaterThan(0);
  });
});

describe('billing safety against a real child process (AC2, FR-15)', () => {
  it('the child process really does not receive OPENAI_API_KEY', async () => {
    // The unit suite asserts the ChildEnvironment we ASK for. This asserts what
    // the operating system actually handed the child — the guarantee that
    // matters, because it is the one that costs money when it is wrong.
    const shim = await withShim('capable', '{}');
    vi.stubEnv('OPENAI_API_KEY', BILLING_SENTINEL);
    const warn = vi.fn();

    await createCodexCliProvider(
      { name: 'codex', mode: 'chatgpt' },
      { runner, warn },
      { cwd: process.cwd(), timeoutMs: TIMEOUT_MS, probeTimeoutMs: TIMEOUT_MS },
    ).generate({ role: 'contract-author', prompt: 'p', jsonSchema: {} });

    const childEnv = await shim.envMap();
    expect(childEnv).not.toHaveProperty('OPENAI_API_KEY');
    // Not merely absent by name — the VALUE never travelled anywhere.
    expect((await shim.env()).join('\n')).not.toContain(BILLING_SENTINEL);
    // The child is otherwise a normal inherited environment.
    expect(childEnv.PATH).toBeDefined();

    expect(warn).toHaveBeenCalledWith(
      '⚠ OPENAI_API_KEY present in environment — withheld from the codex subprocess (mode: chatgpt)',
    );
    // And the parent still has it: withholding is by construction.
    expect(process.env.OPENAI_API_KEY).toBe(BILLING_SENTINEL);
  });

  it('the `codex doctor` child does not receive OPENAI_API_KEY either', async () => {
    // FR-15 is a guarantee about codex SUBPROCESSES, and `codex doctor` is one.
    // It is also the probe story 2.7 renders, so if it saw a credential the
    // invocation withholds, doctor could report auth as usable while generation
    // fails — the diagnostic answering an easier question than the real one.
    const shim = await withShim('capable');
    vi.stubEnv('OPENAI_API_KEY', BILLING_SENTINEL);

    await probeCodexAuth(runner, { timeoutMs: TIMEOUT_MS });

    const childEnv = await shim.envMap();
    expect(childEnv).not.toHaveProperty('OPENAI_API_KEY');
    expect((await shim.env()).join('\n')).not.toContain(BILLING_SENTINEL);
    expect(process.env.OPENAI_API_KEY).toBe(BILLING_SENTINEL);
  });

  it('withholds under an unrecognized mode too', async () => {
    // `mode` is validated only as a non-empty string, and no artifact defines a
    // mode that opts into API billing — so a typo must not become a charge.
    const shim = await withShim('capable', '{}');
    vi.stubEnv('OPENAI_API_KEY', BILLING_SENTINEL);

    await createCodexCliProvider(
      { name: 'codex', mode: 'subscribtion' },
      { runner, warn: vi.fn() },
      { cwd: process.cwd(), timeoutMs: TIMEOUT_MS, probeTimeoutMs: TIMEOUT_MS },
    ).generate({ role: 'contract-author', prompt: 'p', jsonSchema: {} });

    expect(await shim.envMap()).not.toHaveProperty('OPENAI_API_KEY');
  });
});

/**
 * AC3 — a Codex-ONLY project completes generation.
 *
 * "No hardcoded dependency on any specific provider" is a property of the
 * SYSTEM, so it is proven from the config inward: a project declaring only a
 * codex provider, with all three roles pointing at it, resolves and invokes
 * without any Claude adapter being installed, configured or importable. Story
 * 2.4 asserts the mirror image for a Claude-only project; neither adapter names
 * the other outside config-driven resolution.
 */
describe('AC3 — a Codex-only configuration completes generation', () => {
  it('resolves each role through config and completes THROUGH THE GATE', async () => {
    // The end-to-end the AC actually asks for: config → role resolution →
    // `createProvider` → the shared gate → a validated draft. Nothing here names
    // an adapter in code; `adapter: 'codex-cli'` is a config VALUE, which is what
    // "no hardcoded dependency on any specific provider" means.
    const shim = await withShim('capable', '{"criteria":[{"id":"E7-01"}]}');

    const config = {
      ai: {
        providers: { codex: { adapter: 'codex-cli', mode: 'chatgpt' } },
        roles: {
          'contract-author': 'codex',
          'plan-author': 'codex',
          explainer: 'codex',
        },
      },
    } as const;

    const responseSchema = z.object({
      criteria: z.array(z.object({ id: z.string() })),
    });

    for (const role of ['contract-author', 'plan-author', 'explainer'] as const) {
      // Resolve exactly as the application layer would: role → provider NAME →
      // declared adapter. No Claude adapter is configured, installed, or needed.
      const providerName = config.ai.roles[role];
      const declared = config.ai.providers[providerName];
      const provider = createProvider(
        { name: providerName, adapter: declared.adapter, mode: declared.mode },
        { processRunner: runner, clock: new SystemClock(), warn: vi.fn() },
      );

      expect(provider.adapter).toBe('codex-cli');

      const response = await invoke(
        { role, prompt: `work for ${role}`, responseSchema },
        { provider, clock: new SystemClock() },
      );

      // `parsed` exists only because the GATE validated it — the adapter
      // returned raw text and never touched a schema (AD-2).
      expect(response.ok).toBe(true);
      expect(response.parsed).toEqual({ criteria: [{ id: 'E7-01' }] });
      expect(response.attempts).toHaveLength(1);
    }

    // Three invocations, one capability probe for the session:
    // `--version` + `exec --help` + three execs = 5.
    expect(await shim.invocations()).toBe(5);
  });

  it('resolves every role to codex and invokes it', async () => {
    const shim = await withShim('capable', '{"criteria":[]}');

    const roles = ['contract-author', 'plan-author', 'explainer'] as const;
    const provider = codexProvider(process.cwd());

    for (const role of roles) {
      const raw = await provider.generate({ role, prompt: `work for ${role}`, jsonSchema: {} });
      expect(raw).toBe('{"criteria":[]}');
    }

    // Three invocations, but the capability probe ran ONCE for the session:
    // `--version` + `exec --help` + three execs = 5.
    expect(await shim.invocations()).toBe(5);
  });
});

/**
 * THE ONE REAL-CLI SMOKE TEST (AD-12) — SKIPPED BY DEFAULT.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * HOW TO ENABLE:   SPECWITNESS_REAL_CLI=1 pnpm test
 * ────────────────────────────────────────────────────────────────────────────
 *
 * It must NEVER run in a default `pnpm test`, and story 2.5 must be passable
 * with no ChatGPT subscription at all — which is why every other test in this
 * repository uses the shim above.
 *
 * Even when enabled it deliberately makes NO model call: it runs `--version`,
 * `exec --help` and `codex doctor`, which is exactly the surface the adapter
 * depends on. That keeps the smoke test free — nothing is billed, no
 * subscription is consumed — while still catching the one thing the fake cannot:
 * the real CLI changing its flags underneath us, which ADR-001 names as its
 * first concern.
 *
 * The remaining unverified step is a real `codex exec` with `--output-schema`,
 * which needs a signed-in account and a paid model call. That is the owner's
 * dogfooding step (Epic 7), not a test.
 */
describe.skipIf(process.env.SPECWITNESS_REAL_CLI !== '1')('real Codex CLI smoke test', () => {
  it('the installed codex still supports the flags this adapter depends on', async () => {
    const capability = await probeCodexCapability(runner, { timeoutMs: 15_000 });

    expect(capability.found).toBe(true);
    expect(capability.execAvailable).toBe(true);
    // AD-4's hardcodable minimum: `exec --output-schema`. If this ever fails,
    // the CLI changed and the adapter must be updated — not worked around.
    expect(capability.outputSchemaSupported).toBe(true);
    expect(capability.skipGitRepoCheckSupported).toBe(true);
  });

  it('`codex doctor` answers the auth-readiness probe', async () => {
    const auth = await probeCodexAuth(runner, { timeoutMs: 15_000 });

    // Deliberately NOT asserting `ok`: whether this machine is signed in is not
    // this test's business, and asserting it would make the suite fail for a
    // developer who simply has not logged in. What matters is that the probe
    // reaches a CONCLUSION through the CLI's own public surface.
    expect(auth.conclusive).toBe(true);
  });
});
