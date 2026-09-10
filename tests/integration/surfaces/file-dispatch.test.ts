import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createProbeDispatcher } from '../../../src/cli/verify/probe-dispatch.js';
import { loadConfig, type SpecwitnessConfig } from '../../../src/config/index.js';
import {
  PROBE_SURFACES,
  deriveCriterionResult,
  type ContractCriterionRef,
  type ProbeSurface,
} from '../../../src/domain/criterion-result.js';
import type { Evidence } from '../../../src/domain/evidence.js';
import type { ProbeSpec } from '../../../src/domain/plan.js';
import type { ProcessRunner } from '../../../src/domain/process-runner.js';
import { FileSurfaceExecutor } from '../../../src/surfaces/index.js';
import type { BrowserRuntimeEnvironment } from '../../../src/surfaces/index.js';
import { FixedClock } from '../../fakes/ports.js';
import {
  BROWSER_PROBE,
  FILE_PROBE,
  HTTP_PROBE,
  OBSERVATION_PROBE,
  SHELL_PROBE,
} from '../../helpers/plan.js';

/**
 * AC3 — the `file` surface is reached through THE dispatch path, not a parallel one.
 *
 * `createProbeDispatcher` is the product's only composition root for probes: the probes
 * stage calls it for every attempt of every probe. This file drives all five surfaces'
 * representative probes through that one function and asserts each comes back as its own
 * surface's executor — so a sixth surface, or a `file` arm that quietly went somewhere else,
 * shows up here rather than in a verdict.
 *
 * Then it executes the `file` arm for real, against a real worktree, with a process runner
 * that FAILS THE TEST if anything calls it. The dispatcher hands every other arm that
 * runner; the `file` arm must not use it, and the type of its executor gives it no way to.
 */

const CRITERION: ContractCriterionRef = {
  criterionId: 'E7-08',
  statement: 'the file surface is dispatched like every other surface',
  severity: 'normal',
  verifiability: 'automated',
};

const PROBES: Readonly<Record<ProbeSurface, ProbeSpec>> = {
  http: HTTP_PROBE,
  browser: BROWSER_PROBE,
  observation: OBSERVATION_PROBE,
  shell: SHELL_PROBE,
  file: FILE_PROBE,
};

/** A runner nobody may call. Every spawn through it is recorded and then refused. */
class RefusingRunner implements ProcessRunner {
  readonly calls: unknown[] = [];

  run(options: unknown): never {
    this.calls.push(options);
    throw new Error('the file surface spawned a process');
  }
}

let scratch: string;
let worktree: string;
let config: SpecwitnessConfig;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'specwitness-file-dispatch-'));
  worktree = join(scratch, 'worktree');
  await mkdir(join(scratch, 'project', '.specwitness'), { recursive: true });
  await mkdir(worktree);

  // A REAL config, loaded by the real loader, declaring what the other four representative
  // probes reference — so every arm resolves exactly as it would in a run.
  await writeFile(
    join(scratch, 'project', '.specwitness', 'config.yaml'),
    [
      'version: 1',
      'project:',
      '  baseBranch: master',
      'services:',
      '  backend: { run: node server.js, port: 18080, ready: { url: "http://127.0.0.1:18080/" } }',
      '  frontend: { run: node web.js, port: 18081, ready: { url: "http://127.0.0.1:18081/" } }',
      'observations:',
      '  company-count: { run: node count.js }',
      '  typecheck: { run: node typecheck.js }',
      '',
    ].join('\n'),
    'utf8',
  );
  config = loadConfig(join(scratch, 'project'));

  await writeFile(join(worktree, 'CHANGELOG.md'), '# Changelog\n\n## 1.2.0\n\n- the file surface\n');
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function dispatcher(runner: ProcessRunner, members: Evidence[] = []) {
  const dispatch = createProbeDispatcher({
    config,
    runner,
    clock: new FixedClock('2026-09-10T12:00:00.000Z'),
    writeEvidence: (name) => Promise.resolve(name),
    writeEvidenceBytes: (name) => Promise.resolve(name),
    resolveRunPath: (name) => join(scratch, 'run', name),
    playwright: { ready: false, source: 'absent', reason: 'not needed here' } as unknown as BrowserRuntimeEnvironment,
    onProcessGroup: () => undefined,
  });

  return (probe: ProbeSpec) =>
    dispatch({
      criterionId: CRITERION.criterionId,
      probe,
      attempt: 1,
      cwd: worktree,
      runAction: () => Promise.resolve(),
      recordEvidence: (member) => {
        members.push(member);
      },
    });
}

describe('AC3 — one dispatch path for all five surfaces', () => {
  it.each(PROBE_SURFACES)('routes a %s probe to that surface’s executor', (surface) => {
    const { executor } = dispatcher(new RefusingRunner())(PROBES[surface]);
    expect(executor.surface).toBe(surface);
  });

  it('routes the file probe to the file executor, with the probe’s own fields as params', () => {
    const { executor, params } = dispatcher(new RefusingRunner())(FILE_PROBE);

    expect(executor).toBeInstanceOf(FileSurfaceExecutor);
    expect(params).toEqual({ ...FILE_PROBE, attempt: 1 });
  });

  it('executes through the dispatcher against the worktree, binding the stage’s evidence sink and spawning nothing', async () => {
    const runner = new RefusingRunner();
    const members: Evidence[] = [];
    const { executor, params } = dispatcher(runner, members)(FILE_PROBE);

    const attempt = await executor.execute({
      criterionId: CRITERION.criterionId,
      surface: 'file',
      params,
    });

    expect(runner.calls).toEqual([]);
    expect(attempt.assertionEvaluations.map((evaluation) => evaluation.satisfied)).toEqual([
      true,
      true,
    ]);
    expect(members).toHaveLength(1);
    expect(members[0]?.kind).toBe('observation');
    expect(deriveCriterionResult(CRITERION, [attempt]).status).toBe('pass');
  });
});
