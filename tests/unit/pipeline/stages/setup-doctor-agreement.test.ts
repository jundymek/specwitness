import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  commandsResolvableCheck,
  firstToken,
} from '../../../../src/cli/doctor/checks/commands-resolvable.js';
import { createDoctorContext, type DoctorContext } from '../../../../src/cli/doctor/context.js';
import { loadConfig, type SpecwitnessConfig } from '../../../../src/config/index.js';
import { splitCommandLine } from '../../../../src/pipeline/stages/gate-command.js';
import { createSetupStage } from '../../../../src/pipeline/stages/setup.js';
import { fakeEffects, gitOk } from '../../doctor/helpers.js';

import { processResult, recordingRunner, stageContext } from './setup.helpers.js';

/**
 * ⚠️ **AC4 — `doctor` and `verify` agree about `setup.install`. THIS IS THE REGRESSION TEST FOR
 * THE DEFECT STORY 6.11 CLOSES.**
 *
 * The defect was never that either surface was wrong on its own. `doctor` correctly resolved the
 * key (`src/cli/doctor/checks/commands-resolvable.ts:36-37`) and `verify` correctly ran a
 * placeholder that honestly said it was a placeholder. The defect lived in the GAP: the command
 * whose whole job is pre-flight validation told an operator the key was live, and the command
 * that verifies never read it. Nothing failed. Nothing was red. Two files simply disagreed, and
 * the only way to find out was to read them both.
 *
 * So this file drives BOTH SURFACES FROM ONE LOADED CONFIG, in one test, and asserts they land on
 * the same command. That is what the story's spec means by *"it must not be provable only by
 * reading two files"*: a future change that makes `verify` stop executing the key, or makes
 * `doctor` stop validating it, goes red here rather than becoming folklore for another two epics.
 *
 * Nothing is spawned: the doctor half uses `fakeEffects` and the verify half a recording runner.
 */

/** One project on disk, so the two surfaces cannot be reading different files. */
function project(install: string): { root: string; config: SpecwitnessConfig } {
  const root = mkdtempSync(join(tmpdir(), 'specwitness-agreement-'));
  mkdirSync(join(root, '.specwitness'));
  writeFileSync(
    join(root, '.specwitness', 'config.yaml'),
    ['version: 1', 'project:', '  baseBranch: master', 'setup:', `  install: ${JSON.stringify(install)}`, ''].join(
      '\n',
    ),
    'utf8',
  );
  return { root, config: loadConfig(root) };
}

/** The doctor context for that project, with the install binary present on a fake PATH. */
function doctorContext(root: string, executableFiles: readonly string[]): DoctorContext {
  return createDoctorContext({
    projectRoot: root,
    effects: fakeEffects({ gitDefault: gitOk(), executableFiles: [...executableFiles] }),
    nodeVersion: 'v22.20.0',
    pathVar: '/usr/local/bin:/usr/bin',
    billingRiskEnv: [],
  });
}

describe('doctor and verify agree about setup.install (AC4)', () => {
  it('a key doctor validates is a key verify executes', async () => {
    const { root, config } = project('pnpm install --frozen-lockfile');

    // ---- the DOCTOR half: the key is collected, resolved, and reported as fine.
    const doctorResult = await commandsResolvableCheck.run(
      doctorContext(root, ['/usr/local/bin/pnpm']),
    );
    expect(doctorResult.status).toBe('pass');
    // One declared command — `setup.install`, and nothing else is declared in this config — so
    // this count is the mechanical proof that doctor did not simply ignore the key.
    expect(doctorResult.detail).toContain('all 1 declared commands resolve');

    // ---- the VERIFY half: the SAME config value reaches a real subprocess spawn.
    const runner = recordingRunner(processResult());
    const install = config.setup.install;
    expect(install).toBeDefined();
    await createSetupStage({
      ...(install === undefined ? {} : { install }),
      runner,
    }).run(stageContext());

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({
      binary: 'pnpm',
      args: ['install', '--frozen-lockfile'],
    });
  });

  it('an install doctor cannot resolve is named by doctor, with its config key', async () => {
    const { root } = project('pnpm install');

    // Nothing executable anywhere: doctor must say so, and must say WHICH key.
    const result = await commandsResolvableCheck.run(doctorContext(root, []));

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('setup.install');
    expect(result.detail).toContain('pnpm');
  });

  it('the two surfaces resolve the SAME token out of a declared command line', async () => {
    // The deeper half of the agreement, and the one a status assertion cannot reach: doctor
    // resolves `firstToken(command)` and the setup stage spawns `splitCommandLine(command).binary`.
    // Those are two different functions in two different layers, and `gate-command.ts`'s header
    // states that keeping them reading the same token is what makes doctor's verdict PREDICT
    // whether a command can run. A divergence here would mean doctor resolving one binary and
    // verify spawning another — the same class of gap this story closes, one level down.
    const lines = [
      'pnpm install --frozen-lockfile',
      'sh scripts/install.sh',
      './scripts/install.sh --offline',
      '"/usr/local/bin/pnpm" install',
      'npm ci',
      'make deps',
    ];

    for (const line of lines) {
      expect(splitCommandLine(line).binary).toBe(firstToken(line));
    }
  });
});
