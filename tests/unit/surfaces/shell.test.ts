/**
 * Story 4.6 — the shell surface executor: skeleton, and the runtime allowlist gate.
 *
 * These tests spawn ZERO subprocesses. Every spawn in this file is a scripted
 * `ProcessResult` from a fake runner, or a runner that fails the test if it is
 * called at all. Real spawning is `tests/integration/surfaces/shell.test.ts`.
 *
 * THE SHAPE OF THE AC2 TESTS IS THE POINT. "Rejected before any execution" is
 * proven by a runner that was never called — never by asserting an error type,
 * which would pass just as green if the rejection happened after the spawn.
 */

import { describe, expect, it } from 'vitest';

import { deriveCriterionResult } from '../../../src/domain/criterion-result.js';
import type { ContractCriterionRef } from '../../../src/domain/criterion-result.js';
import { ConfigError, InfraError } from '../../../src/domain/errors.js';
import { ShellSurfaceExecutor } from '../../../src/surfaces/shell.js';
import type { ShellExecutorDeps, ShellProbeParams } from '../../../src/surfaces/shell.js';
import { FixedClock } from '../../fakes/ports.js';

import {
  processResult,
  recordingRunner,
  recordingSink,
  recordingWriter,
  resolvedCommand,
  throwingRunner,
  WORKTREE,
  type RecordingRunner,
} from './shell.helpers.js';

const CAPTURED_AT = '2026-09-02T00:00:00.000Z';

function params(overrides: Partial<ShellProbeParams> = {}): ShellProbeParams {
  return {
    probeId: 'migrations-check',
    commandId: 'migrations-applied',
    args: [],
    argumentAllowlist: [],
    assertions: [
      {
        description: 'the migration checker exits cleanly',
        target: { source: 'exitCode' },
        comparison: 'equals',
        expected: '0',
      },
    ],
    ...overrides,
  };
}

function deps(overrides: Partial<ShellExecutorDeps> = {}): ShellExecutorDeps {
  return {
    runner: recordingRunner(processResult()),
    clock: new FixedClock(CAPTURED_AT),
    cwd: WORKTREE,
    command: resolvedCommand(),
    writeEvidence: recordingWriter(),
    recordEvidence: recordingSink(),
    ...overrides,
  };
}

function request(overrides: Partial<ShellProbeParams> = {}) {
  return {
    criterionId: 'E4-01',
    surface: 'shell' as const,
    params: params(overrides) as unknown as Readonly<Record<string, unknown>>,
  };
}

/** A criterion the contract marked automated, so attempts actually decide it. */
const AUTOMATED: ContractCriterionRef = {
  criterionId: 'E4-01',
  statement: 'every migration in the repository has been applied',
  severity: 'critical',
  verifiability: 'automated',
};

describe('the shell executor implements the AD-13 contract', () => {
  it('declares surface "shell"', () => {
    expect(new ShellSurfaceExecutor(deps()).surface).toBe('shell');
  });

  it('returns a ProbeAttempt, stamped with the 1-based attempt number', async () => {
    const attempt = await new ShellSurfaceExecutor(deps()).execute(request());

    expect(attempt.attempt).toBe(1);
    expect(attempt.durationMs).toBe(11);
    expect(Array.isArray(attempt.assertionEvaluations)).toBe(true);
  });

  it('stamps the attempt number the request supplied, and never loops internally', async () => {
    // AD-9: retries are opt-in and orchestration is the caller's. The executor
    // executes exactly ONE attempt per call — proven by the scripted runner,
    // which throws if asked for a second spawn.
    const runner = recordingRunner(processResult());
    const attempt = await new ShellSurfaceExecutor(deps({ runner })).execute(
      request({ attempt: 3 }),
    );

    expect(attempt.attempt).toBe(3);
    expect(runner.calls).toHaveLength(1);
  });
});

describe('AC2 — the runtime allowlist gate rejects BEFORE any execution', () => {
  /** Runs the executor with a runner that fails the test if it spawns anything. */
  async function reject(
    overrides: Partial<ShellProbeParams>,
    depOverrides: Partial<ShellExecutorDeps> = {},
  ): Promise<{ error: unknown; runner: RecordingRunner }> {
    const runner = throwingRunner();
    const executor = new ShellSurfaceExecutor(deps({ runner, ...depOverrides }));

    let error: unknown;
    try {
      await executor.execute(request(overrides));
    } catch (caught) {
      error = caught;
    }
    return { error, runner };
  }

  it('rejects an argument that is not in the allowlist, and spawns nothing', async () => {
    const { error, runner } = await reject({
      args: ['--dry-run', '--force'],
      argumentAllowlist: ['--dry-run'],
    });

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain('--force');
    expect((error as ConfigError).hint).toBeDefined();
    // THE PROOF: nothing ran. Not "an error was thrown" — nothing ran.
    expect(runner.calls).toHaveLength(0);
  });

  it('rejects an undeclared command id, and spawns nothing', async () => {
    // The caller resolves the id. A params id that disagrees with the resolved
    // command means the plan referenced something else — it must never silently
    // execute the command that happened to be injected.
    const { error, runner } = await reject({ commandId: 'some-other-command' });

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain('some-other-command');
    expect((error as ConfigError).message).toContain('migrations-applied');
    expect(runner.calls).toHaveLength(0);
  });

  it('rejects any argument when the allowlist is EMPTY — fail closed', async () => {
    // An empty allowlist means NO arguments are permitted. The dangerous
    // reading — "empty means unconstrained" — is the one that looks like a
    // reasonable default, so it gets its own test.
    const { error, runner } = await reject({ args: ['--anything'], argumentAllowlist: [] });

    expect(error).toBeInstanceOf(ConfigError);
    expect(runner.calls).toHaveLength(0);
  });

  it('rejects a PREFIX of an allowed argument — matching is exact', async () => {
    const { error, runner } = await reject({
      args: ['--dry'],
      argumentAllowlist: ['--dry-run'],
    });

    expect(error).toBeInstanceOf(ConfigError);
    expect(runner.calls).toHaveLength(0);
  });

  it('rejects a SUPERSTRING of an allowed argument — so --dry-run never permits --dry-runner', async () => {
    const { error, runner } = await reject({
      args: ['--dry-runner'],
      argumentAllowlist: ['--dry-run'],
    });

    expect(error).toBeInstanceOf(ConfigError);
    expect(runner.calls).toHaveLength(0);
  });

  it('rejects the WHOLE probe when one argument of several is out of the allowlist', async () => {
    // Not "drops the offending argument", not "runs the permitted ones".
    const { error, runner } = await reject({
      args: ['--dry-run', '--verbose', '--force'],
      argumentAllowlist: ['--dry-run', '--verbose'],
    });

    expect(error).toBeInstanceOf(ConfigError);
    expect(runner.calls).toHaveLength(0);
  });

  it('names half-substitution as the likely cause when a placeholder survived', async () => {
    // Cohort agreement with 4.3 (alice, 2026-09-01): `resolveMechanics`
    // substitutes `args` AND `argumentAllowlist` with the same ResolvedData. If
    // a caller ever substitutes one and not the other, EVERY binding-using
    // probe rejects forever with a message that reads like a real allowlist
    // violation. This hint turns that into a named failure.
    const { error } = await reject({
      args: ['9f2c1a5b7d3e4f60'],
      argumentAllowlist: ['{{signupEmail}}'],
    });

    expect((error as ConfigError).hint).toContain('substitut');
  });

  it('PERMITS a repeated argument that is in the allowlist', async () => {
    // The allowlist states WHICH VALUES are permitted, not how many times —
    // matching the merged schema's own `Set` membership test in 4.2's
    // `ShellProbeSchema.superRefine`.
    const runner = recordingRunner(processResult());
    const attempt = await new ShellSurfaceExecutor(deps({ runner })).execute(
      request({ args: ['-v', '-v'], argumentAllowlist: ['-v'] }),
    );

    expect(attempt.execError).toBeUndefined();
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.args).toEqual(['scripts/check.js', '-v', '-v']);
  });

  it('an allowlist entry that is never used is not an error', async () => {
    const runner = recordingRunner(processResult());
    await new ShellSurfaceExecutor(deps({ runner })).execute(
      request({ args: ['-v'], argumentAllowlist: ['-v', '--unused'] }),
    );

    expect(runner.calls).toHaveLength(1);
  });
});

describe('a rejection is never a product FAIL', () => {
  it('throws rather than returning an attempt that could derive to fail', async () => {
    // AD-6/AD-7. An out-of-allowlist argument means THE PLAN IS WRONG, which
    // says nothing about whether the branch satisfies its contract. Exit 1
    // would tell a harness the branch has defects; exit 3 says SpecWitness
    // could not reach a conclusion, which is what actually happened.
    const executor = new ShellSurfaceExecutor(deps({ runner: throwingRunner() }));

    await expect(
      executor.execute(request({ args: ['--nope'], argumentAllowlist: [] })),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('a criterion with no attempts is skipped, not failed', () => {
    // The state a rejected probe leaves behind: the throw propagates, so the
    // criterion never receives an attempt at all.
    expect(deriveCriterionResult(AUTOMATED, []).status).toBe('skipped');
  });
});

describe('malformed params are a WIRING defect, not a broken environment', () => {
  /**
   * Cohort-2 agreement (bob, 2026-09-01): params that do not match the shape
   * are an `InfraError` — SpecWitness was assembled wrong — never an
   * `execError`, which would disguise a pipeline bug as an environment flake.
   * Both are exit 3; only one names the right culprit.
   */
  async function malformed(params: unknown): Promise<unknown> {
    const executor = new ShellSurfaceExecutor(deps({ runner: throwingRunner() }));
    try {
      await executor.execute({
        criterionId: 'E4-01',
        surface: 'shell',
        params: params as Readonly<Record<string, unknown>>,
      });
    } catch (error) {
      return error;
    }
    return undefined;
  }

  it('rejects params that are not an object', async () => {
    expect(await malformed('migrations-applied')).toBeInstanceOf(InfraError);
  });

  it('rejects a missing argumentAllowlist rather than defaulting it', async () => {
    // Defaulting an absent allowlist to "everything" is the fail-OPEN mistake;
    // defaulting it to "nothing" would silently disable a probe. Refuse.
    const { argumentAllowlist, ...withoutAllowlist } = params();
    void argumentAllowlist;
    expect(await malformed(withoutAllowlist)).toBeInstanceOf(InfraError);
  });

  it('rejects a non-string argument', async () => {
    expect(await malformed({ ...params(), args: [7] })).toBeInstanceOf(InfraError);
  });

  it('rejects a probe with no assertions', async () => {
    // A probe that adjudicates nothing cannot mint a PASS. The merged schema
    // enforces `.min(1)`; a hand-edited plan can still reach here.
    expect(await malformed({ ...params(), assertions: [] })).toBeInstanceOf(InfraError);
  });

  it('rejects an unknown assertion comparison', async () => {
    expect(
      await malformed({
        ...params(),
        assertions: [
          {
            description: 'matches',
            target: { source: 'stdout' },
            comparison: 'regex',
            expected: '.*',
          },
        ],
      }),
    ).toBeInstanceOf(InfraError);
  });

  it('rejects an unknown assertion target source', async () => {
    expect(
      await malformed({
        ...params(),
        assertions: [
          {
            description: 'reads a file',
            target: { source: 'file' },
            comparison: 'equals',
            expected: 'x',
          },
        ],
      }),
    ).toBeInstanceOf(InfraError);
  });
});

describe('AD-8 — commands run in the verification worktree', () => {
  it('spawns with the injected cwd', async () => {
    const runner = recordingRunner(processResult());
    await new ShellSurfaceExecutor(deps({ runner })).execute(request());

    expect(runner.calls[0]?.cwd).toBe(WORKTREE);
  });

  it('passes the declared command as binary + argv, never a command line', async () => {
    // AD-3, the whole story: there is no shell, so the binary and every
    // argument travel as separate argv elements.
    const runner = recordingRunner(processResult());
    await new ShellSurfaceExecutor(deps({ runner })).execute(
      request({ args: ['--out', 'a b'], argumentAllowlist: ['--out', 'a b'] }),
    );

    expect(runner.calls[0]?.binary).toBe('node');
    expect(runner.calls[0]?.args).toEqual(['scripts/check.js', '--out', 'a b']);
  });

  it('passes shell metacharacters through as literal argv elements', async () => {
    // Not filtered, not escaped, not refused — INERT, because nothing on this
    // path has a shell to interpret them. The integration suite proves the
    // child actually receives them verbatim by echoing its own process.argv.
    const runner = recordingRunner(processResult());
    const smuggled = '; rm -rf / && echo $(whoami) *';
    await new ShellSurfaceExecutor(deps({ runner })).execute(
      request({ args: [smuggled], argumentAllowlist: [smuggled] }),
    );

    expect(runner.calls[0]?.args).toEqual(['scripts/check.js', smuggled]);
  });

  it('spawns with an explicit timeout, so an unbounded probe is not expressible', async () => {
    const runner = recordingRunner(processResult());
    await new ShellSurfaceExecutor(deps({ runner, timeoutMs: 250 })).execute(request());

    expect(runner.calls[0]?.timeoutMs).toBe(250);
  });
});
