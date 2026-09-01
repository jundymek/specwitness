import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { loadConfig, type GateConfig } from '../../src/config/index.js';
import { InfraError } from '../../src/domain/errors.js';
import type { GateEvidence } from '../../src/domain/evidence.js';
import { createProcessRunner } from '../../src/infra/process-runner.js';
import { createGatesStage } from '../../src/pipeline/stages/gates.js';
import { FixedClock } from '../fakes/ports.js';
import { recordingWriter, stageContext } from '../unit/pipeline/stages/gates.helpers.js';

/**
 * The classification table, against REAL subprocesses.
 *
 * Story 3.4's spec is emphatic that each of the three outcomes needs a test
 * that can ACTUALLY PRODUCE THE STATE, not a scripted `ProcessResult` asserting
 * that the mapping code does what it says. A mocked `'not-found'` proves the
 * `switch` handles a string; it proves nothing about whether a genuinely
 * missing binary arrives as `'not-found'` at all. The unit suite covers the
 * mapping; this file covers the reality it maps.
 *
 * Every command is `process.execPath` with `-e`, exactly like the merged
 * `tests/integration/process-runner.test.ts`. No `claude`, no `codex`, no
 * network, no external binary, and never this repository — fixtures are built
 * in a per-test temp directory (H-8: the harness runs `pnpm test` in this
 * worktree concurrently with the agent, so nothing may share a fixed path).
 *
 * `fixtures/corpus/` is Epic 6's. The epics file cites "Golden Corpus fixture
 * 7" for AC2, but that fixture does not exist yet — these are inline fixtures
 * and no passing run here should be read as corpus coverage.
 */

const NODE = process.execPath;

/** Every temp directory this file created, removed after each test. */
const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * A real project directory with a real `.specwitness/config.yaml`.
 *
 * The gates come back through the real `loadConfig`, so their `run` values are
 * genuine `DeclaredCommand`s — the only way to obtain one (AD-3). Nothing here
 * casts.
 */
async function project(gates: readonly { id: string; run: string }[]): Promise<{
  root: string;
  gates: GateConfig[];
}> {
  const root = await mkdtemp(join(tmpdir(), 'specwitness-gates-int-'));
  created.push(root);
  await mkdir(join(root, '.specwitness'), { recursive: true });

  const yaml = [
    'version: 1',
    'project:',
    '  baseBranch: master',
    'gates:',
    ...gates.flatMap((gate) => [
      `  - id: ${JSON.stringify(gate.id)}`,
      `    run: ${JSON.stringify(gate.run)}`,
    ]),
  ].join('\n');

  await writeFile(join(root, '.specwitness', 'config.yaml'), `${yaml}\n`);
  return { root, gates: [...loadConfig(root).gates] };
}

const runner = () => createProcessRunner(new FixedClock('2026-09-01T00:00:00.000Z'));

/**
 * Every process group this file spawned, so the suite can prove it left none
 * behind.
 *
 * This is a required assertion, not diligence: Epic 2's timeout test leaked
 * nine `sleep 3600` processes onto the development machine, and nothing in that
 * suite noticed. Story 3.4 spawns real children, including one that is killed
 * for exceeding its timeout, so it is the obvious place for the same leak.
 *
 * The reaping itself is story 3.2's — its runner spawns detached and signals
 * the GROUP, which is what reaches grandchildren. This is the consumer-side
 * check that the mechanism actually held for gate spawns. If it ever fails,
 * that is a real finding about the runner rather than something to fix here.
 */
const spawnedGroups: number[] = [];

/** True while any process in the group is still alive. */
function groupAlive(pgid: number): boolean {
  try {
    // Signal 0 checks for existence without delivering anything. The negative
    // pid addresses the whole group, so a surviving grandchild counts.
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

afterAll(() => {
  // "No survivors" would also be true if nothing had ever been recorded, which
  // is the way this assertion would most plausibly rot: a signature change that
  // stopped `onProcessGroup` reaching the runner would leave the leak check
  // green and empty. Assert the check had something to check.
  expect(spawnedGroups.length, 'no gate spawn reported a process group').toBeGreaterThan(0);

  const survivors = spawnedGroups.filter(groupAlive);
  expect(survivors, `gate spawns leaked process groups: ${survivors.join(', ')}`).toEqual([]);
});

/**
 * A node one-liner as a declared command line.
 *
 * The script must contain NO double quotes, and the guard below enforces it.
 * That is not a limitation worth working around — it is the AD-3 boundary
 * showing through. `splitCommandLine` deliberately implements no escape
 * handling, exactly like doctor's `firstToken`, because there is no shell on
 * this path to define what an escape would mean. A `JSON.stringify`-ed script
 * containing `\"` is therefore split at that inner quote and the gate runs
 * something else entirely.
 *
 * That is precisely how the first version of this file went wrong: a fixture
 * whose script used double quotes silently became a different command, and the
 * early-stop test passed because the side effect it looked for could never have
 * happened — for a second, unrelated reason. Use single quotes inside scripts.
 */
const node = (script: string): string => {
  if (script.includes('"')) {
    throw new Error(`node() script must not contain double quotes: ${script}`);
  }
  return `${JSON.stringify(NODE)} -e ${JSON.stringify(script)}`;
};

const stage = (gates: GateConfig[], writer = recordingWriter(), timeoutMs = 20_000) =>
  createGatesStage({
    gates,
    runner: runner(),
    writeEvidence: writer,
    timeoutMs,
    // Records every group this file creates so `afterAll` can prove none of
    // them outlived the suite.
    onProcessGroup: (pgid) => {
      spawnedGroups.push(pgid);
    },
  });

describe('AC1: real commands, run in order, in the worktree', () => {
  it('runs three passing gates and reports every one as pass', async () => {
    const { root, gates } = await project([
      { id: 'install', run: node('process.exit(0)') },
      { id: 'lint', run: node('process.exit(0)') },
      { id: 'build', run: node('process.exit(0)') },
    ]);
    const context = stageContext({ worktreePath: root });

    const result = await stage(gates).run(context);

    expect(result.status).toBe('ok');
    expect(context.run.gates.map((gate) => gate.status)).toEqual(['pass', 'pass', 'pass']);
  });

  it('runs the gate in the worktree, proved by the child reporting its own cwd', async () => {
    // The strongest available form of "it ran in the right directory": the
    // child itself says where it was. A gate spawned in the source repo would
    // silently verify the wrong tree.
    const { root, gates } = await project([
      { id: 'pwd', run: node('process.stdout.write(process.cwd())') },
    ]);
    const context = stageContext({ worktreePath: root });

    await stage(gates).run(context);

    const evidence = context.run.evidence[0] as GateEvidence;
    // macOS resolves /var to /private/var, so compare on the unique leaf.
    expect(evidence.stdout.text).toContain(root.split('/').pop() as string);
    expect(evidence.stdout.text).not.toBe(process.cwd());
  });

  it('captures what the gate actually printed on both streams', async () => {
    const { root, gates } = await project([
      {
        id: 'chatty',
        run: node("process.stdout.write('OUT-MARKER'); process.stderr.write('ERR-MARKER')"),
      },
    ]);
    const context = stageContext({ worktreePath: root });

    await stage(gates).run(context);

    const evidence = context.run.evidence[0] as GateEvidence;
    expect(evidence.stdout.text).toContain('OUT-MARKER');
    expect(evidence.stderr.text).toContain('ERR-MARKER');
  });
});

describe('AC2: a real command exiting non-zero is a PRODUCT failure', () => {
  it('is a product-negative stage result with the gate marked fail — never a throw', async () => {
    const { root, gates } = await project([
      { id: 'install', run: node('process.exit(0)') },
      { id: 'lint', run: node("process.stderr.write('2 errors'); process.exit(1)") },
      { id: 'build', run: node('process.exit(0)') },
    ]);
    const context = stageContext({ worktreePath: root });

    const result = await stage(gates).run(context);

    expect(result.status).toBe('product-negative');
    expect(context.run.gates).toEqual([
      { gateId: 'install', status: 'pass', durationMs: expect.any(Number) },
      { gateId: 'lint', status: 'fail', durationMs: expect.any(Number) },
      { gateId: 'build', status: 'skipped' },
    ]);
  });

  it('preserves the real exit code in the evidence', async () => {
    const { root, gates } = await project([{ id: 'lint', run: node('process.exit(7)') }]);
    const context = stageContext({ worktreePath: root });

    await stage(gates).run(context);

    expect((context.run.evidence[0] as GateEvidence).exitCode).toBe(7);
  });

  it('never spawns the gate after the failing one', async () => {
    // Proved by the later gate's own side effect being absent: it writes a
    // file, and that file must not exist.
    //
    // The positive control is not optional. An absent side effect is evidence
    // only if the same command demonstrably produces it when it DOES run —
    // otherwise a fixture that could never have worked passes this test for the
    // wrong reason, which is exactly what happened in the first version of this
    // file.
    const marker = 'GATE-RAN.txt';
    const writes = node(`require('fs').writeFileSync('${marker}', 'x')`);

    const control = await project([{ id: 'build', run: writes }]);
    await stage(control.gates).run(stageContext({ worktreePath: control.root }));
    expect(existsSync(join(control.root, marker))).toBe(true);

    const { root, gates } = await project([
      { id: 'lint', run: node('process.exit(1)') },
      { id: 'build', run: writes },
    ]);
    await stage(gates).run(stageContext({ worktreePath: root }));

    expect(existsSync(join(root, marker))).toBe(false);
  });
});

describe('AC3: a command that CANNOT START is infrastructure, never a FAIL', () => {
  it('a genuinely missing binary throws InfraError and produces NO gate result', async () => {
    // The single most damaging bug available in this story. Reported as FAIL it
    // blocks a mergeable branch, or sends a developer hunting a defect that
    // does not exist.
    const { root, gates } = await project([
      { id: 'lint', run: 'specwitness-no-such-binary-3-4 --version' },
    ]);
    const context = stageContext({ worktreePath: root });

    await expect(stage(gates).run(context)).rejects.toThrow(InfraError);

    expect(context.run.gates).toEqual([]);
  });

  it('an unusable working directory throws InfraError and does NOT blame the binary', async () => {
    // ENOENT has at least two causes. The merged runner separates them by
    // asking the filesystem whether `cwd` is a directory; telling an operator
    // to install a binary they already have is the confidently-wrong answer
    // Epic 2's retrospective records.
    const { gates } = await project([{ id: 'lint', run: node('process.exit(0)') }]);
    const context = stageContext({ worktreePath: '/specwitness/no/such/directory' });

    const error = await stage(gates)
      .run(context)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(InfraError);
    expect((error as InfraError).message).not.toMatch(/not on PATH/);
    expect(context.run.gates).toEqual([]);
  });

  it('a gate that exceeds its timeout throws InfraError, not a FAIL', async () => {
    // A single non-forking sleeper, so this asserts CLASSIFICATION rather than
    // descendant reaping — the latter is story 3.2's, tested in its own suite.
    const { root, gates } = await project([
      { id: 'hang', run: node('setTimeout(() => {}, 60000)') },
    ]);
    const context = stageContext({ worktreePath: root });

    const error = await stage(gates, recordingWriter(), 400)
      .run(context)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(InfraError);
    expect((error as InfraError).message).toMatch(/timed out/i);
    expect(context.run.gates.some((gate) => gate.status === 'fail')).toBe(false);
  }, 30_000);
});

describe('the leak detector itself', () => {
  it('reports a live process group as alive and a dead one as dead', async () => {
    // Without this the suite-end leak assertion is vacuous: a `groupAlive` that
    // always returned false would report "no orphans" no matter how many were
    // left behind, and would look exactly like a clean run. Proved against a
    // group this test creates and destroys itself.
    const { spawn } = await import('node:child_process');
    const child = spawn(NODE, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true });
    const pgid = child.pid as number;

    try {
      expect(groupAlive(pgid)).toBe(true);
    } finally {
      process.kill(-pgid, 'SIGKILL');
    }

    // Reaping is not instantaneous; wait for the child to be reaped rather than
    // racing it.
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));
    expect(groupAlive(pgid)).toBe(false);
  }, 20_000);
});

describe('the three failure causes stay distinguishable in practice', () => {
  it('produces different errors for a missing binary and an unusable cwd', async () => {
    // The property that matters to an operator: the answer names the actual
    // problem. Three failures that all said "gate failed" would be useless even
    // though each individual classification test passed.
    const missing = await project([{ id: 'g', run: 'no-such-binary-3-4-x' }]);
    const ok = await project([{ id: 'g', run: node('process.exit(0)') }]);

    const notFound = await stage(missing.gates)
      .run(stageContext({ worktreePath: missing.root }))
      .catch((thrown: unknown) => thrown as InfraError);
    const badCwd = await stage(ok.gates)
      .run(stageContext({ worktreePath: '/specwitness/no/such/directory' }))
      .catch((thrown: unknown) => thrown as InfraError);

    expect(notFound).toBeInstanceOf(InfraError);
    expect(badCwd).toBeInstanceOf(InfraError);
    expect((notFound as InfraError).message).not.toBe((badCwd as InfraError).message);
  });
});

describe('FR-28 end to end: a real gate printing a credential', () => {
  it('keeps it out of the evidence AND out of the bytes written to the run directory', async () => {
    // Assembled rather than written literally — see
    // tests/unit/pipeline/stages/gates.secrets.ts for why. The shapes are the
    // ones a real gate prints: curl's `> Authorization:` and a timestamped log
    // line, not only the assignment form a line-anchored pattern would catch.
    const key = ['sk', 'ant', 'example', '444555666777'].join('-');
    const script =
      `process.stdout.write('ANTHROPIC_API_KEY=${key}');` +
      `process.stdout.write('\\n> Authorization: Bearer ${key}');` +
      `process.stderr.write('2026-09-01T00:00:00Z INFO Authorization: Bearer ${key}')`;

    const { root, gates } = await project([{ id: 'leaky', run: node(script) }]);
    const writer = recordingWriter();
    const context = stageContext({ worktreePath: root });

    await stage(gates, writer).run(context);

    expect(JSON.stringify(context.run.evidence)).not.toContain(key);
    expect(writer.writes.length).toBeGreaterThan(0);
    for (const write of writer.writes) {
      expect(write.contents).not.toContain(key);
    }
  });
});
