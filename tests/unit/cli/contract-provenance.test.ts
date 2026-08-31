import { beforeEach, describe, expect, it } from 'vitest';

import type { ProviderDescriptor } from '../../../src/domain/agent-provider.js';
import type { ProcessResult, ProcessRunOptions } from '../../../src/domain/process-runner.js';
import { readProviderProvenance } from '../../../src/cli/contract/provenance.js';
import { createClaudeCodeCliProvider } from '../../../src/providers/claude-code-cli.js';
import { resetCodexProbeCache } from '../../../src/providers/codex-cli.js';

/**
 * Story 3.8 — what the CLI edge can honestly say about the provider that drafted
 * a contract (AD-5, Q65).
 *
 * Every case runs against a SCRIPTED `ProcessRunner`, never a real CLI. Nothing
 * in this project has ever spawned a real `claude` or `codex`, and nothing here
 * starts: the adapters' own suites establish what each probe does with each kind
 * of process outcome, and this file establishes what the edge writes into
 * `meta.provenance` given those outcomes.
 *
 * The three paths AC1-AC3 name are all here — claude with a version, codex with a
 * version and a null model, and a probe that failed — plus the shipped `fake`
 * adapter, which has no CLI behind it at all.
 */

function ok(stdout: string, stderr = ''): ProcessResult {
  return { outcome: 'completed', exitCode: 0, stdout, stderr, durationMs: 1 };
}

function failed(exitCode: number, stderr = ''): ProcessResult {
  return { outcome: 'completed', exitCode, stdout: '', stderr, durationMs: 1 };
}

function nonCompletion(outcome: 'not-found' | 'timed-out' | 'spawn-failed'): ProcessResult {
  return { outcome, exitCode: null, stdout: '', stderr: '', durationMs: 1 };
}

/** A claude `-p --output-format json` envelope, as story 2.4's adapter expects it. */
function claudeEnvelope(result: string): string {
  return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result });
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
      run(options: ProcessRunOptions): Promise<ProcessResult> {
        calls.push(options);
        const result = results[Math.min(index, results.length - 1)];
        index += 1;
        if (result === undefined) {
          throw new Error('runnerReturning was given no results');
        }
        return Promise.resolve(result);
      },
    },
  };
}

function descriptor(adapter: string, name = 'provider', mode = 'subscription'): ProviderDescriptor {
  return { name, adapter, mode };
}

const CLAUDE_VERSION = ok('2.1.251 (Claude Code)\n');
const CLAUDE_CAPABLE = ok(claudeEnvelope('ok'));
const CODEX_VERSION = ok('codex-cli 0.144.4\n');
const CODEX_HELP = ok('--output-schema  --output-last-message  --skip-git-repo-check  --cd');

beforeEach(() => {
  // The codex probe caches in a module-level Map keyed by binary name, so each
  // case must start from a clean slate or the second test in this file would
  // read the first one's answer. The claude cache is keyed by runner identity
  // and a fresh runner per case clears it automatically.
  resetCodexProbeCache();
});

describe('readProviderProvenance — the claude path (AC1)', () => {
  it('records the version verbatim, exactly as the CLI printed it', async () => {
    const { runner } = runnerReturning(CLAUDE_VERSION, CLAUDE_CAPABLE);

    const provenance = await readProviderProvenance(descriptor('claude-code-cli'), runner);

    // Verbatim and unparsed — story 2.4's stated rule, and the handover comment
    // in its source that this story finally answers. Not `2.1.251`.
    expect(provenance.providerCliVersion).toBe('2.1.251 (Claude Code)');
  });

  it('records a null model, because the CLI does not report one on this path', async () => {
    const { runner } = runnerReturning(CLAUDE_VERSION, CLAUDE_CAPABLE);

    const provenance = await readProviderProvenance(descriptor('claude-code-cli'), runner);

    // AD-2 fixes the provider envelope at RAW TEXT, so a model name cannot reach
    // the edge even if the CLI reported one. An honest null, never a guess.
    expect(provenance.model).toBeNull();
  });
});

describe('readProviderProvenance — the codex path (AC2)', () => {
  it('records the version the adapter pattern-matched, and a null model', async () => {
    const { runner } = runnerReturning(CODEX_VERSION, CODEX_HELP);

    const provenance = await readProviderProvenance(descriptor('codex-cli'), runner);

    // Story 2.5 prefers the bare semver out of `codex-cli 0.144.4`. That is its
    // decision, it is tested there, and this story passes it through unchanged
    // rather than unifying it with claude's verbatim rule. The two adapters
    // legitimately differ.
    expect(provenance.providerCliVersion).toBe('0.144.4');
    // Genuinely absent, not merely unwired: `--output-last-message` returns
    // message text only, so codex reports no model on the path SpecWitness uses.
    expect(provenance.model).toBeNull();
  });

  it('records an explicit null when the version could not be pattern-matched', async () => {
    // Story 2.5 deliberately records NOTHING when its pattern does not match,
    // rather than storing text it could not identify. That silence must arrive
    // here as an explicit null rather than as `undefined` or a crash.
    const { runner } = runnerReturning(ok('\n'), CODEX_HELP);

    const provenance = await readProviderProvenance(descriptor('codex-cli'), runner);

    expect(provenance.providerCliVersion).toBeNull();
    expect(provenance.model).toBeNull();
  });
});

describe('readProviderProvenance — unknown provenance is data, never a failure (AC3)', () => {
  const brokenProbes: Array<[string, ProcessResult]> = [
    ['the binary is not on PATH', nonCompletion('not-found')],
    ['the probe timed out', nonCompletion('timed-out')],
    ['the binary could not be started', nonCompletion('spawn-failed')],
    ['`--version` exited non-zero', failed(1, 'not claude')],
  ];

  for (const [reason, result] of brokenProbes) {
    it(`yields explicit nulls when ${reason} (claude)`, async () => {
      const { runner } = runnerReturning(result);

      const provenance = await readProviderProvenance(descriptor('claude-code-cli'), runner);

      expect(provenance).toEqual({ model: null, providerCliVersion: null });
    });

    it(`yields explicit nulls when ${reason} (codex)`, async () => {
      resetCodexProbeCache();
      const { runner } = runnerReturning(result);

      const provenance = await readProviderProvenance(descriptor('codex-cli'), runner);

      expect(provenance).toEqual({ model: null, providerCliVersion: null });
    });
  }

  it('never rejects, whatever the probe does — provenance is metadata, not a gate', async () => {
    // Fail-open, deliberately and uniquely. Everywhere else this product fails
    // closed; here, refusing to answer would turn an unreadable version string
    // into a broken product. A runner that throws outright is the harshest case.
    const exploding = {
      run(): Promise<ProcessResult> {
        return Promise.reject(new Error('the runner itself failed'));
      },
    };

    await expect(
      readProviderProvenance(descriptor('claude-code-cli'), exploding),
    ).resolves.toEqual({ model: null, providerCliVersion: null });
  });
});

describe('readProviderProvenance — adapters with no CLI behind them', () => {
  it('yields nulls for the shipped `fake` adapter, and spawns nothing', async () => {
    const { runner, calls } = runnerReturning(CLAUDE_VERSION);

    const provenance = await readProviderProvenance(
      descriptor('fake', 'hermetic', 'tests/fixtures/providers/contract'),
      runner,
    );

    expect(provenance).toEqual({ model: null, providerCliVersion: null });
    // `fake` is a config-selectable product feature that runs in-process. Asking
    // it for a CLI version is a category error, and probing for one would be a
    // subprocess in a path that promises none.
    expect(calls).toHaveLength(0);
  });

  it('yields nulls for an adapter this build does not know, without throwing', async () => {
    // The config schema rejects unknown adapters, so reaching this is a
    // disagreement between the schema and this function. Recording "we do not
    // know" is the only honest answer, and it must not break generation.
    const { runner, calls } = runnerReturning(CLAUDE_VERSION);

    const provenance = await readProviderProvenance(descriptor('some-future-cli'), runner);

    expect(provenance).toEqual({ model: null, providerCliVersion: null });
    expect(calls).toHaveLength(0);
  });
});

describe('readProviderProvenance — it costs no extra subprocess', () => {
  it('shares the one cached capability probe with the invocation that follows', async () => {
    // The whole design constraint. Both adapters cache their capability probe per
    // session and consult it from `generate`; passing the SAME runner means
    // whichever call happens first pays and the other reads it. A second
    // `--version` spawn on every contract generation, for a metadata field whose
    // value is already in hand, is exactly what this asserts against.
    const { runner, calls } = runnerReturning(
      CLAUDE_VERSION,
      CLAUDE_CAPABLE,
      ok(claudeEnvelope('{"criteria":[]}')),
    );

    const provider = createClaudeCodeCliProvider(descriptor('claude-code-cli', 'claude'), {
      processRunner: runner,
      clock: { now: () => new Date('2026-08-31T00:00:00.000Z') },
      warn: () => {},
    });

    await readProviderProvenance(descriptor('claude-code-cli', 'claude'), runner);
    await provider.generate({ role: 'contract-author', prompt: 'draft it' });

    const versionSpawns = calls.filter((call) => call.args.includes('--version'));
    expect(versionSpawns).toHaveLength(1);
  });

  it('probes once however many times provenance is read', async () => {
    const { runner, calls } = runnerReturning(CODEX_VERSION, CODEX_HELP);

    await readProviderProvenance(descriptor('codex-cli'), runner);
    await readProviderProvenance(descriptor('codex-cli'), runner);

    expect(calls.filter((call) => call.args.includes('--version'))).toHaveLength(1);
  });
});
