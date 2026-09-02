import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/index.js';
import type { DerivedCriterionResult } from '../../src/domain/criterion-result.js';
import { InfraError } from '../../src/domain/errors.js';
import type { CommandEvidence, Evidence } from '../../src/domain/evidence.js';
import type { RunEnvironment, RunResult } from '../../src/domain/run-result.js';
import { SystemClock } from '../../src/infra/clock.js';
import { createProcessRunner } from '../../src/infra/process-runner.js';
import { createDataStage, type DataStageDeps } from '../../src/pipeline/stages/data.js';
import type { RunAccumulator, StageContext } from '../../src/pipeline/stage.js';

import { SEEDED_API_KEY } from '../unit/pipeline/stages/gates.secrets.js';

/**
 * Story 4.3 against REAL processes and a REAL config load.
 *
 * Two things can only be proved here, and both are the point of the file:
 *
 *  1. **AC3's "in declared order" end to end.** `config.data` is a `z.record`, so declaration
 *     order is an emergent property of `yaml` + zod preserving object insertion order, NOT a
 *     guarantee the schema makes. A unit test with a hand-built object proves only that the
 *     stage iterates whatever it was handed. Only a fixture that travels the real `loadConfig`
 *     path — YAML text on disk, parsed and validated exactly as a project's own config is —
 *     pins the property the stage relies on. This is 4.1's approach for services, matched.
 *  2. **The redaction proof against a real capture path**, with the credential arriving as
 *     bytes a real child process wrote to stdout rather than as a string a fake handed over.
 *
 * SAFETY, inherited from stories 3.2 and 4.1: every command here is a short `node -e` that
 * exits on its own — this story spawns nothing long-lived by design — every scratch directory
 * is an `mkdtemp` and is removed in `afterAll`, and no fixed path or port is used anywhere,
 * because several agents run this suite concurrently on one machine (H-8).
 */

const NODE = process.execPath;

/** Scratch directories this file created, removed in `afterAll`. */
const scratchDirs: string[] = [];

afterAll(async () => {
  await Promise.all(scratchDirs.map(async (dir) => rm(dir, { recursive: true, force: true })));
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

/**
 * A real `.specwitness/config.yaml` on disk, loaded through the real loader.
 *
 * `run` values are written as YAML strings so the file is exactly what a project would commit,
 * and the `DeclaredCommand`s come back minted by the config schema — the only place they may be
 * minted (AD-3). Nothing here casts.
 */
function loadDataCommands(commands: readonly { id: string; run: string }[]) {
  const root = scratch('specwitness-data-int-');
  mkdirSync(join(root, '.specwitness'));

  const lines = ['version: 1', 'project:', '  baseBranch: master', 'data:'];
  for (const command of commands) {
    lines.push(`  ${JSON.stringify(command.id)}: ${JSON.stringify(command.run)}`);
  }
  writeFileSync(join(root, '.specwitness', 'config.yaml'), `${lines.join('\n')}\n`);

  return loadConfig(root).data;
}

const ENVIRONMENT: RunEnvironment = {
  nodeVersion: process.version,
  platform: process.platform,
  arch: process.arch,
  specwitnessVersion: '0.1.0',
  runDirectory: '.specwitness/runs/run-20260902T000000Z-int1',
  worktreePath: null,
};

function stageContext(worktreePath: string): StageContext & { readonly run: RunAccumulator } {
  const run: RunAccumulator = {
    epic: 'epic-7',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    gates: [],
    criteria: [] as DerivedCriterionResult[],
    evidence: [] as Evidence[],
    providerUsage: [],
    environment: { ...ENVIRONMENT, worktreePath },
    contractCriteria: [],
  };

  return {
    runId: 'run-20260902T000000Z-int1',
    clock: new SystemClock(),
    run,
    snapshot: (): RunResult => {
      throw new Error('the data stage must not call snapshot()');
    },
  };
}

function commandEvidenceIn(context: { run: RunAccumulator }): CommandEvidence[] {
  return context.run.evidence.filter((item): item is CommandEvidence => item.kind === 'command');
}

describe('the data stage against real processes (AC3)', () => {
  it('runs declared commands in FILE order, proved through the real config loader', async () => {
    // Deliberately NOT alphabetical and not insertion-friendly: `reset` then `seed` then
    // `migrate` sorts to migrate/reset/seed, so a stage that sorted keys — or a loader that
    // did — would produce a visibly different order rather than an accidentally-right one.
    const worktree = scratch('specwitness-worktree-');
    const data = loadDataCommands([
      { id: 'reset', run: `${JSON.stringify(NODE)} -e "console.log('step:reset')"` },
      { id: 'seed', run: `${JSON.stringify(NODE)} -e "console.log('step:seed')"` },
      { id: 'migrate', run: `${JSON.stringify(NODE)} -e "console.log('step:migrate')"` },
    ]);

    // The property under test, at the loader boundary: the record's key order is the file's.
    expect(Object.keys(data)).toStrictEqual(['reset', 'seed', 'migrate']);

    const context = stageContext(worktree);
    const deps: DataStageDeps = { data, runner: createProcessRunner(new SystemClock()) };

    const result = await createDataStage(deps).run(context);

    expect(result.status).toBe('ok');
    // And the observed EXECUTION order, read back from what each real child actually printed.
    expect(commandEvidenceIn(context).map((item) => item.stdout.text.trim())).toStrictEqual([
      'step:reset',
      'step:seed',
      'step:migrate',
    ]);
  });

  it('runs each command in the worktree, not in the project root', async () => {
    // The containment property, proved by asking the child where it is rather than by
    // inspecting the options object a fake recorded.
    const worktree = scratch('specwitness-worktree-cwd-');
    const data = loadDataCommands([
      { id: 'where', run: `${JSON.stringify(NODE)} -e "console.log(process.cwd())"` },
    ]);
    const context = stageContext(worktree);

    await createDataStage({ data, runner: createProcessRunner(new SystemClock()) }).run(context);

    // `realpath` on macOS resolves /var -> /private/var, so compare on the basename, which is
    // the mkdtemp suffix and is unique to this test.
    expect(commandEvidenceIn(context)[0]?.stdout.text.trim()).toContain(
      worktree.split('/').at(-1) as string,
    );
  });

  it('classifies a failing data command as InfraError and stops there', async () => {
    const worktree = scratch('specwitness-worktree-fail-');
    const data = loadDataCommands([
      { id: 'reset', run: `${JSON.stringify(NODE)} -e "process.exit(3)"` },
      { id: 'seed', run: `${JSON.stringify(NODE)} -e "console.log('must-not-run')"` },
    ]);
    const context = stageContext(worktree);

    await expect(
      createDataStage({ data, runner: createProcessRunner(new SystemClock()) }).run(context),
    ).rejects.toThrow(InfraError);

    // Only the first command ran...
    const evidence = commandEvidenceIn(context);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.commandId).toBe('reset');
    // ...and nothing claims the BRANCH failed. This is AC3's whole point: exit 3, never exit 1.
    expect(context.run.gates).toStrictEqual([]);
    expect(context.run.criteria).toStrictEqual([]);
    expect(context.run.outcome).toBeUndefined();
  });

  it('classifies a missing binary as InfraError naming it', async () => {
    const worktree = scratch('specwitness-worktree-missing-');
    const data = loadDataCommands([
      { id: 'reset', run: 'specwitness-no-such-binary-4-3 --reset' },
    ]);

    await expect(
      createDataStage({ data, runner: createProcessRunner(new SystemClock()) }).run(stageContext(worktree)),
    ).rejects.toThrow(/specwitness-no-such-binary-4-3/);
  });

  it('records evidence for a command that produced output on both streams', async () => {
    const worktree = scratch('specwitness-worktree-streams-');
    const data = loadDataCommands([
      {
        id: 'reset',
        run:
          `${JSON.stringify(NODE)} -e ` +
          `"console.log('out-line');console.error('err-line')"`,
      },
    ]);
    const context = stageContext(worktree);

    await createDataStage({ data, runner: createProcessRunner(new SystemClock()) }).run(context);

    const evidence = commandEvidenceIn(context)[0];
    expect(evidence?.stdout.text).toContain('out-line');
    expect(evidence?.stderr.text).toContain('err-line');
    expect(evidence?.exitCode).toBe(0);
    expect(evidence?.displayCommand).toContain('-e');
  });
});

describe('a seeded secret printed by a real data command never reaches evidence (AD-10)', () => {
  it('is absent from evidence, from the persisted full copy, and from the timeline', async () => {
    // The assertion is ABSENCE of the secret, never presence of `[REDACTED]` — output carrying
    // the marker with the secret still beside it passes a marker-presence assertion green
    // (Epic 3 retro §7). The credential is imported from the shared fixture rather than
    // redeclared: a second seeded-secret constant is a second thing to keep in step with the
    // redactor (story 4.1's note, same reason).
    const worktree = scratch('specwitness-worktree-secret-');
    const written: { name: string; contents: string }[] = [];

    // The child READS the credential from a file in the worktree rather than receiving it as an
    // argument, and that is the point of the fixture rather than a detail. A secret passed on the
    // declared command line would land in `displayCommand`, which is DECLARED text — the
    // operator's own config, redacted as a shell command — so the test would be exercising the
    // wrong half of AD-10. Here the credential exists only as bytes a real child wrote to its
    // streams, i.e. purely as CAPTURE OUTPUT, which is exactly the fail-closed path under test.
    // (It is also what a real `reset` looks like: credentials come from a file, not from argv.)
    writeFileSync(join(worktree, 'secret.txt'), SEEDED_API_KEY);

    const readSecret = "require('fs').readFileSync('secret.txt','utf8').trim()";
    const data = loadDataCommands([
      {
        id: 'reset',
        run:
          `${JSON.stringify(NODE)} -e ` +
          `"console.log('ANTHROPIC_API_KEY=' + ${readSecret});` +
          `console.error('> Authorization: Bearer ' + ${readSecret})"`,
      },
    ]);
    const context = stageContext(worktree);

    await createDataStage({
      data,
      runner: createProcessRunner(new SystemClock()),
      writeEvidence: async (name, contents) => {
        written.push({ name, contents });
        return name;
      },
    }).run(context);

    // The command really did print it — otherwise this test proves nothing.
    const evidence = commandEvidenceIn(context)[0];
    expect(evidence?.stdout.text).toContain('ANTHROPIC_API_KEY=');

    // And it is absent everywhere the output travels.
    expect(JSON.stringify(context.run.evidence)).not.toContain(SEEDED_API_KEY);
    expect(JSON.stringify(written)).not.toContain(SEEDED_API_KEY);
  });
});
