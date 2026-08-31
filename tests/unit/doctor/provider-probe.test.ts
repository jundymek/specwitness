import { beforeEach, describe, expect, it } from 'vitest';

import { createProviderProbe } from '../../../src/cli/doctor/provider-probe.js';
import { resetCodexProbeCache } from '../../../src/providers/codex-cli.js';
import type { ProcessResult, ProcessRunner } from '../../../src/domain/process-runner.js';

/**
 * The normalisation seam between the adapters' probes and doctor's checks.
 *
 * THE PROPERTY THESE TESTS EXIST FOR: doctor's verdict must equal the
 * invocation's verdict, for the same probe result. Stories 2.4 and 2.5 each
 * refuse to generate under a specific condition; if this module judges
 * `capable` by any other rule, doctor reports READY for a provider that will
 * refuse — or warns about one that works. That is the probe/invocation drift
 * the one-probe arrangement exists to prevent, and it can be reintroduced in
 * the renderer just as easily as in a second probe.
 *
 * Everything runs through a scripted `ProcessRunner`, so no `claude` and no
 * `codex` is spawned and the results do not depend on what is installed.
 */

function runner(script: (binary: string, args: readonly string[]) => ProcessResult): ProcessRunner {
  return {
    async run(options) {
      return script(options.binary, options.args);
    },
  };
}

const OK = (stdout: string): ProcessResult => ({
  outcome: 'completed',
  exitCode: 0,
  stdout,
  stderr: '',
  durationMs: 1,
});

const NOT_FOUND: ProcessResult = {
  outcome: 'not-found',
  exitCode: null,
  stdout: '',
  stderr: '',
  durationMs: 1,
};

describe('createProviderProbe', () => {
  // Story 2.5 memoises capability per session (AD-4), which is what keeps
  // doctor fast when several roles resolve to one binary. Across TESTS that
  // same cache would leak one case's answer into the next, so it is reset —
  // using the adapter's own exported reset rather than reaching into its state.
  beforeEach(() => {
    resetCodexProbeCache();
  });

  it('reports a codex missing a required exec flag as NOT capable', async () => {
    // The exact case: `exec` exists and `--output-schema` is advertised, but
    // `--output-last-message` is not. Story 2.5's provider refuses to generate
    // on this; doctor must not call it ready. Judging capability on
    // `execAvailable && outputSchemaSupported` alone reported a passing
    // provider that cannot author anything.
    const probe = createProviderProbe(
      runner((_binary, args) => {
        if (args.includes('--version')) {
          return OK('codex-cli 0.140.0');
        }
        // Help text advertises --output-schema but NOT --output-last-message.
        return OK('Usage: codex exec [OPTIONS]\n  --output-schema <FILE>\n  --skip-git-repo-check');
      }),
    );

    const result = await probe({ name: 'codex', adapter: 'codex-cli', mode: 'chatgpt' });

    expect(result.found).toBe(true);
    expect(result.capable).toBe(false);
    // And the adapter's own explanation is carried through rather than replaced.
    expect(result.reason).toContain('contract generation unavailable');
    // Auth is not probed for a provider that cannot generate: the operator has
    // a more basic problem, and a failure about signing in would misdirect.
    expect(result.auth).toBeNull();
  });

  it('reports a fully capable codex as capable, and probes its auth', async () => {
    const probe = createProviderProbe(
      runner((_binary, args) => {
        if (args.includes('--version')) {
          return OK('codex-cli 0.144.4');
        }
        if (args.includes('doctor')) {
          return OK('everything looks good');
        }
        return OK(
          'Usage: codex exec [OPTIONS]\n  --output-schema <FILE>\n  --output-last-message <FILE>\n  --cd <DIR>\n  --skip-git-repo-check',
        );
      }),
    );

    const result = await probe({ name: 'codex', adapter: 'codex-cli', mode: 'chatgpt' });

    expect(result.capable).toBe(true);
    expect(result.auth?.ok).toBe(true);
  });

  it('reports an absent binary as not found, without throwing', async () => {
    // UJ-4: a missing agent CLI must be a value, never an exception, or doctor
    // could not warn and carry on.
    const probe = createProviderProbe(runner(() => NOT_FOUND));

    const result = await probe({ name: 'codex', adapter: 'codex-cli', mode: 'chatgpt' });

    expect(result.found).toBe(false);
    expect(result.capable).toBe(false);
    expect(result.auth).toBeNull();
  });

  it('reports a fake adapter as hermetic without spawning anything', async () => {
    const probe = createProviderProbe(
      runner(() => {
        throw new Error('a hermetic provider must not spawn a subprocess');
      }),
    );

    const result = await probe({ name: 'stub', adapter: 'fake', mode: 'canned' });

    expect(result.hermetic).toBe(true);
    expect(result.found).toBe(true);
    expect(result.auth).toBeNull();
  });

  it('reports an adapter this build does not know rather than guessing', async () => {
    // The config schema rejects unknown adapters, so reaching here means the
    // schema and this switch disagree. Claiming readiness either way would be
    // inventing an answer.
    const probe = createProviderProbe(runner(() => NOT_FOUND));

    const result = await probe({ name: 'x', adapter: 'future-cli', mode: 'whatever' });

    expect(result.capable).toBe(false);
    expect(result.reason).toContain('unknown adapter');
  });
});
