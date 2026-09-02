/**
 * Story 4.6 — the shell executor against REAL subprocesses.
 *
 * THE PROOF THIS FILE EXISTS FOR: the no-shell property (AD-3). The unit suite
 * can only assert what was handed to a fake runner. Here the fixture command
 * echoes its OWN `process.argv` back as JSON and the test compares element for
 * element, so "a shell metacharacter arrives as a literal argv element" is
 * demonstrated by the operating system rather than asserted about a mock.
 *
 * HYGIENE (Epic 2 leaked nine `sleep 3600` processes onto a developer's
 * machine):
 *  - every fixture script is written into its own `mkdtemp` directory, so the
 *    suite is safe to run concurrently with the auto-review's own `pnpm test`
 *    in the same worktree (H-8);
 *  - the timeout test spawns a child that exits on its own in ~2s AND is torn
 *    down by process group, so nothing outlives the run either way;
 *  - nothing here touches this repository, the network, `~/.claude/` or
 *    `~/.codex/`.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deriveCriterionResult } from '../../../src/domain/criterion-result.js';
import type {
  ContractCriterionRef,
  ProbeAttempt,
} from '../../../src/domain/criterion-result.js';
import { ConfigError } from '../../../src/domain/errors.js';
import { createProcessRunner } from '../../../src/infra/process-runner.js';
import { SystemClock } from '../../../src/infra/clock.js';
import { ShellSurfaceExecutor } from '../../../src/surfaces/shell.js';
import type { ShellExecutorDeps, ShellProbeParams } from '../../../src/surfaces/shell.js';

import {
  probeParams,
  recordingSink,
  recordingWriter,
  throwingRunner,
  type RecordingSink,
  type RecordingWriter,
} from '../../unit/surfaces/shell.helpers.js';

const AUTOMATED: ContractCriterionRef = {
  criterionId: 'E4-01',
  statement: 'the checker reports a clean tree',
  severity: 'critical',
  verifiability: 'automated',
};

let workdir: string;

/** Absolute path of a fixture script this suite wrote. */
function script(name: string): string {
  return join(workdir, name);
}

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'specwitness-shell-probe-'));

  // Echoes its own argv, so the test can prove what the child actually
  // received. `process.argv.slice(2)` drops the node binary and this script.
  await writeFile(
    script('echo-argv.js'),
    'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
  );

  // Exits with the code it is told to, after printing to both streams.
  await writeFile(
    script('exit-with.js'),
    [
      'const code = Number(process.argv[2] ?? "0");',
      'process.stdout.write("stdout says " + code + "\\n");',
      'process.stderr.write("stderr says " + code + "\\n");',
      'process.exit(code);',
    ].join('\n') + '\n',
  );

  // Runs longer than the injected timeout, but terminates on its own shortly
  // afterwards so nothing can outlive the suite even if teardown regressed.
  await writeFile(script('slow.js'), 'setTimeout(() => process.exit(0), 2000);\n');
});

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

interface Harness {
  readonly attempt: ProbeAttempt;
  readonly writer: RecordingWriter;
  readonly sink: RecordingSink;
}

async function runProbe(
  fixture: string,
  params: Partial<ShellProbeParams>,
  depOverrides: Partial<ShellExecutorDeps> = {},
): Promise<Harness> {
  const writer = recordingWriter();
  const sink = recordingSink();
  const clock = new SystemClock();

  const executor = new ShellSurfaceExecutor({
    runner: createProcessRunner(clock),
    clock,
    // Commands run in the worktree (AD-8). Here that is the fixture directory,
    // which stands in for one — never this repository.
    cwd: workdir,
    command: {
      commandId: 'checker',
      displayCommand: `node ${fixture}`,
      binary: process.execPath,
      baseArgs: [script(fixture)],
    },
    writeEvidence: writer,
    recordEvidence: sink,
    timeoutMs: 30_000,
    ...depOverrides,
  });

  const attempt = await executor.execute({
    criterionId: 'E4-01',
    surface: 'shell',
    params: probeParams({
      id: 'checker-probe',
      commandId: 'checker',
      ...(params as Record<string, unknown>),
    }),
  });

  return { attempt, writer, sink };
}

describe('AD-3 — there is no shell, proven against a real child process', () => {
  it('delivers every declared argument to the child verbatim', async () => {
    const args = ['--flag', 'a value with spaces', ''];
    const { attempt } = await runProbe('echo-argv.js', {
      args,
      argumentAllowlist: args,
      assertions: [
        {
          description: 'argv round-trips',
          target: { source: 'stdout' },
          comparison: 'equals',
          expected: JSON.stringify(args),
        },
      ],
    });

    expect(attempt.execError).toBeUndefined();
    expect(attempt.assertionEvaluations[0]?.satisfied).toBe(true);
  });

  it('passes shell metacharacters as INERT literal argv elements', async () => {
    // If any shell were involved, `; rm -rf /` would be a command separator,
    // `$(whoami)` would substitute, `*` would glob and `&&` would chain. The
    // child reports exactly the strings that were declared, so none of that
    // happened — asserted server-side, from the child's own process.argv.
    const args = ['; rm -rf /', '$(whoami)', '&& echo pwned', '*', '`id`', '|cat'];
    const { attempt, sink } = await runProbe('echo-argv.js', {
      args,
      argumentAllowlist: args,
      assertions: [
        {
          description: 'metacharacters arrive literally',
          target: { source: 'stdout' },
          comparison: 'equals',
          expected: JSON.stringify(args),
        },
      ],
    });

    expect(attempt.assertionEvaluations[0]?.satisfied).toBe(true);
    expect(deriveCriterionResult(AUTOMATED, [attempt]).status).toBe('pass');
    // And the child printed the literals rather than the result of expanding
    // them: `whoami` and `id` never ran.
    const stdout = attempt.assertionEvaluations[0]?.actual ?? '';
    expect(stdout).toContain('$(whoami)');
    expect(stdout).toContain('`id`');
    void sink;
  });
});

describe('AC1 — real exit codes and real output', () => {
  it('passes an exitCode == 0 assertion against a command that exits 0', async () => {
    const { attempt } = await runProbe('exit-with.js', {
      args: ['0'],
      argumentAllowlist: ['0'],
    });

    expect(deriveCriterionResult(AUTOMATED, [attempt]).status).toBe('pass');
  });

  it('PASSES an exitCode == 1 assertion against a command that really exits 1', async () => {
    // The gates stage would call this a failure. A probe asserting a failing
    // command must pass when the command fails.
    const { attempt } = await runProbe('exit-with.js', {
      args: ['1'],
      argumentAllowlist: ['1'],
      assertions: [
        {
          description: 'the checker reports the seeded violation',
          target: { source: 'exitCode' },
          comparison: 'equals',
          expected: '1',
        },
      ],
    });

    expect(attempt.execError).toBeUndefined();
    expect(deriveCriterionResult(AUTOMATED, [attempt]).status).toBe('pass');
  });

  it('fails an exitCode == 0 assertion against a command that exits 3', async () => {
    const { attempt } = await runProbe('exit-with.js', {
      args: ['3'],
      argumentAllowlist: ['3'],
    });

    const derived = deriveCriterionResult(AUTOMATED, [attempt]);
    expect(derived.status).toBe('fail');
    expect(derived.expected).toBe('0');
    expect(derived.actual).toBe('3');
    expect(derived.evidence?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('captures both real streams into evidence', async () => {
    const { attempt, writer } = await runProbe('exit-with.js', {
      args: ['0'],
      argumentAllowlist: ['0'],
    });

    const names = writer.writes.map((write) => write.name);
    // The stem carries both ids and a content-derived discriminator, so the
    // readable prefix is asserted and the 8-hex suffix is matched by shape.
    const stem = /^evidence\/shell-E4-01-checker-probe-[0-9a-f]{8}-1/;
    expect(names.filter((name) => stem.test(name) && name.endsWith('.stdout.txt'))).toHaveLength(1);
    expect(names.filter((name) => stem.test(name) && name.endsWith('.stderr.txt'))).toHaveLength(1);
    expect(names.filter((name) => stem.test(name) && name.endsWith('.json'))).toHaveLength(1);
    expect(attempt.evidence).toHaveLength(3);
  });
});

describe('AC1 — real infrastructure failures are errors, never product FAILs', () => {
  it('a genuinely missing binary derives to error', async () => {
    const { attempt } = await runProbe('echo-argv.js', {}, {
      command: {
        commandId: 'checker',
        displayCommand: 'specwitness-no-such-binary-4-6',
        binary: 'specwitness-no-such-binary-4-6',
        baseArgs: [],
      },
    });

    expect(attempt.execError).toBeDefined();
    expect(attempt.assertionEvaluations).toEqual([]);
    // NOT fail. The branch was never judged.
    expect(deriveCriterionResult(AUTOMATED, [attempt]).status).toBe('error');
  });

  it('a command exceeding an injected millisecond timeout derives to error', async () => {
    const { attempt } = await runProbe('slow.js', {}, { timeoutMs: 150 });

    expect(attempt.execError?.message).toContain('150ms');
    expect(attempt.assertionEvaluations).toEqual([]);
    expect(deriveCriterionResult(AUTOMATED, [attempt]).status).toBe('error');
  });
});

describe('AC2 — rejection happens before a real process is ever created', () => {
  it('rejects an out-of-allowlist argument with a real runner available', async () => {
    // The runner here would genuinely spawn if reached; it throws instead, so
    // a rejection that happened after the spawn could not pass this test.
    await expect(
      runProbe(
        'echo-argv.js',
        { args: ['--not-allowed'], argumentAllowlist: ['--allowed'] },
        { runner: throwingRunner() },
      ),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});
