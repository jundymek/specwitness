import { describe, expect, it } from 'vitest';

import { InfraError } from '../../../../src/domain/errors.js';
import type { CommandEvidence } from '../../../../src/domain/evidence.js';
import {
  createSetupStage,
  SETUP_INSTALL_ID,
  SETUP_INSTALL_TIMEOUT_MS,
} from '../../../../src/pipeline/stages/setup.js';

import {
  declaredInstall,
  failingWriter,
  infraErrorFrom,
  processResult,
  recordingRunner,
  recordingWriter,
  refusingRunner,
  SteppingClock,
  stageContext,
  WORKTREE,
} from './setup.helpers.js';

/**
 * The `setup` stage (story 6.11).
 *
 * THE ASSERTION WITH TEETH IS THE NEGATIVE ONE, and it is repeated on every failure path: a
 * `setup.install` that did not succeed must be an `InfraError` — exit 3 — and must NEVER be a
 * product-negative stage result. `src/pipeline/stage.ts` makes a product-negative arm the only
 * way a stage can reach exit 1, and this stage never returns one, so the tests below assert both
 * halves: that it throws, and (in `setup-pipeline.test.ts`) that the run that follows the throw
 * classifies as infrastructure with `gates` skipped rather than failed.
 *
 * Every `DeclaredCommand` here is minted by loading real YAML through the real `loadConfig`
 * (`setup.helpers.ts`), because AD-3 permits no other way to produce one.
 */

/** The one `command` evidence record the stage pushes, or a readable failure. */
function commandEvidenceOf(evidence: readonly unknown[]): CommandEvidence {
  const records = evidence.filter(
    (entry): entry is CommandEvidence =>
      typeof entry === 'object' && entry !== null && (entry as { kind?: string }).kind === 'command',
  );
  expect(records).toHaveLength(1);
  return records[0] as CommandEvidence;
}

describe('the setup stage executes the configured install command', () => {
  it('spawns the declared install command in the verification worktree (AC1)', async () => {
    const runner = recordingRunner(processResult({ exitCode: 0, durationMs: 4200 }));
    const stage = createSetupStage({
      install: declaredInstall('pnpm install --frozen-lockfile'),
      runner,
    });
    const context = stageContext();

    const result = await stage.run(context);

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({
      binary: 'pnpm',
      args: ['install', '--frozen-lockfile'],
      cwd: WORKTREE,
      timeoutMs: SETUP_INSTALL_TIMEOUT_MS,
      // The project's own toolchain, exactly as gates, services and data commands get. A package
      // manager that cannot find its own node proves nothing.
      env: { inherit: true },
    });
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('pnpm install --frozen-lockfile');
    expect(result.detail).toContain('exit code 0');
    // The RUNNER's measurement of the child, not the stage's own duration (AD-9, AC1).
    expect(result.detail).toContain('4200ms');
  });

  it('is stack-neutral: it runs whatever binary was declared (AC1)', async () => {
    // A project with no `package.json` at any depth is the normal case this stage must serve,
    // not an edge case — the two corpus fixtures this story ships are exactly that shape.
    const runner = recordingRunner(processResult());
    const stage = createSetupStage({ install: declaredInstall('sh scripts/install.sh'), runner });

    await stage.run(stageContext());

    expect(runner.calls[0]).toMatchObject({ binary: 'sh', args: ['scripts/install.sh'] });
  });

  it('records the install as command evidence, with the config key as its id', async () => {
    const writer = recordingWriter();
    const runner = recordingRunner(
      processResult({ stdout: 'Packages: +155\n', stderr: '', durationMs: 4200 }),
    );
    const stage = createSetupStage({
      install: declaredInstall('pnpm install'),
      runner,
      writeEvidence: writer,
    });
    const context = stageContext({ clock: new SteppingClock('2026-09-05T10:00:00.000Z') });

    await stage.run(context);

    const evidence = commandEvidenceOf(context.run.evidence);
    expect(evidence.commandId).toBe(SETUP_INSTALL_ID);
    expect(evidence.displayCommand).toBe('pnpm install');
    expect(evidence.exitCode).toBe(0);
    expect(evidence.durationMs).toBe(4200);
    expect(evidence.stdout.text).toContain('Packages: +155');
    // ISO-8601 UTC from the injected clock, never a locale string and never a real clock.
    expect(evidence.capturedAt).toBe('2026-09-05T10:00:00.000Z');

    // The full copy goes to its own file under the run directory, at one derived name.
    expect(writer.written.map((entry) => entry.name)).toEqual([
      'evidence/setup-install.stdout.txt',
    ]);
  });

  it('writes no evidence file for an empty stream', async () => {
    const writer = recordingWriter();
    const stage = createSetupStage({
      install: declaredInstall('pnpm install'),
      runner: recordingRunner(processResult({ stdout: '', stderr: '' })),
      writeEvidence: writer,
    });

    await stage.run(stageContext());

    // An empty file is an artifact implying output that never existed.
    expect(writer.written).toEqual([]);
  });

  it('still records inline evidence when no evidence writer is bound', async () => {
    const stage = createSetupStage({
      install: declaredInstall('pnpm install'),
      runner: recordingRunner(processResult({ stdout: 'done\n' })),
    });
    const context = stageContext();

    const result = await stage.run(context);

    expect(result.status).toBe('ok');
    expect(commandEvidenceOf(context.run.evidence).stdout.text).toContain('done');
  });

  it('does not let a failed evidence write rewrite a successful install', async () => {
    // The durability rule `gates.ts` and `data.ts` both record: a write failure must not replace
    // the diagnosis. This stage has no verdict to protect, so a lost pointer costs one file.
    const stage = createSetupStage({
      install: declaredInstall('pnpm install'),
      runner: recordingRunner(processResult({ stdout: 'lots of output\n' })),
      writeEvidence: failingWriter(),
    });
    const context = stageContext();

    const result = await stage.run(context);

    expect(result.status).toBe('ok');
    const evidence = commandEvidenceOf(context.run.evidence);
    expect(evidence.stdout.text).toContain('lots of output');
    expect(evidence.stdout.fullPath).toBeUndefined();
  });

  it('publishes the install process group before the outcome is observed', async () => {
    // Story 3.2's seam. An install is the longest-running thing that happens before anything
    // interesting is on screen, so it is the most likely stage to be interrupted — and
    // `specwitness clean` can only reap what reached the manifest.
    const seen: number[] = [];
    const stage = createSetupStage({
      install: declaredInstall('pnpm install'),
      runner: recordingRunner(processResult({ pgid: 9931 })),
      onProcessGroup: (pgid) => {
        seen.push(pgid);
      },
    });

    await stage.run(stageContext());

    expect(seen).toEqual([9931]);
  });
});

describe('the setup stage when nothing is configured (AC2)', () => {
  it('is ok, spawns nothing and records that nothing was declared', async () => {
    const runner = refusingRunner();
    const stage = createSetupStage({ runner });
    const context = stageContext();

    const result = await stage.run(context);

    expect(result).toEqual({ status: 'ok', detail: 'no install command declared' });
    expect(runner.calls).toEqual([]);
    // No evidence either: a stage that installed nothing has observed nothing.
    expect(context.run.evidence).toEqual([]);
  });

  it('no longer claims to be unimplemented', async () => {
    // The placeholder this story replaced said "not implemented yet — Epic 4 runs the configured
    // install command". Leaving that string would be the stage claiming to be unbuilt after it
    // was built, which is strictly worse than the honest placeholder it replaced.
    const result = await createSetupStage({ runner: refusingRunner() }).run(stageContext());

    expect(result.detail).not.toContain('not implemented');
    expect(result.detail).not.toContain('Epic 4');
  });

  it('does not need a worktree when nothing is declared', async () => {
    // The refusal below is about running a command in the wrong tree, not about the stage
    // existing. A run with no isolation and no install has nothing to refuse.
    const result = await createSetupStage({ runner: refusingRunner() }).run(
      stageContext({ worktreePath: null }),
    );

    expect(result.status).toBe('ok');
  });

  it('installs nothing and says so when no runner is wired at all', async () => {
    const result = await createSetupStage().run(stageContext());

    expect(result.status).toBe('ok');
    expect(result.detail).toContain('nothing was installed');
  });
});

describe('the setup stage when the install does not succeed (AC3)', () => {
  it('raises an InfraError for a non-zero exit, never a product failure', async () => {
    const stage = createSetupStage({
      install: declaredInstall('pnpm install --frozen-lockfile'),
      runner: recordingRunner(processResult({ exitCode: 1, stderr: 'ERR_PNPM_OUTDATED_LOCKFILE' })),
    });
    const context = stageContext();

    const error = await infraErrorFrom(stage.run(context));

    expect(error).toBeInstanceOf(InfraError);
    expect(error.message).toContain('failed with exit code 1');
    // ERROR: + HINT:, and the hint names the config key so an operator can find it (AD-7).
    expect(error.hint).toContain(SETUP_INSTALL_ID);
    expect(error.hint).toContain('.specwitness/config.yaml');
    // The classification argument, stated in the remedy rather than only in a header.
    expect(error.hint).toContain('environment problem');
    // The failing install is exactly the output an operator needs, so it is recorded BEFORE the
    // throw. The accumulator survives a thrown stage.
    expect(commandEvidenceOf(context.run.evidence).stderr.text).toContain(
      'ERR_PNPM_OUTDATED_LOCKFILE',
    );
  });

  it('distinguishes a binary missing from PATH from a file missing in the worktree', async () => {
    const missingOnPath = await infraErrorFrom(
      createSetupStage({
        install: declaredInstall('pnpm install'),
        runner: recordingRunner(processResult({ outcome: 'not-found', exitCode: null })),
      }).run(stageContext()),
    );
    expect(missingOnPath.message).toContain("'pnpm' is not on PATH");
    expect(missingOnPath.hint).toContain("install 'pnpm'");

    const missingInTree = await infraErrorFrom(
      createSetupStage({
        install: declaredInstall('./scripts/install.sh'),
        runner: recordingRunner(processResult({ outcome: 'not-found', exitCode: null })),
      }).run(stageContext()),
    );
    // `doctor` resolves a relative command against the PROJECT ROOT; the install runs in the
    // worktree at the head SHA. An untracked script passes doctor and cannot run here, and the
    // useful instruction is "commit it", not "install it".
    expect(missingInTree.message).toContain('does not exist in the verification worktree');
    expect(missingInTree.hint).toContain('commit');
  });

  it('raises an InfraError when the install times out', async () => {
    const error = await infraErrorFrom(
      createSetupStage({
        install: declaredInstall('pnpm install'),
        runner: recordingRunner(processResult({ outcome: 'timed-out', exitCode: null })),
        timeoutMs: 400,
      }).run(stageContext()),
    );

    expect(error.message).toContain('timed out after 400ms');
    expect(error.hint).toContain('says nothing about whether the branch is mergeable');
  });

  it('raises an InfraError when the install could not be spawned', async () => {
    const error = await infraErrorFrom(
      createSetupStage({
        install: declaredInstall('pnpm install'),
        runner: recordingRunner(
          processResult({ outcome: 'spawn-failed', exitCode: null, stderr: 'EACCES' }),
        ),
      }).run(stageContext()),
    );

    expect(error.message).toContain('could not be spawned');
    expect(error.message).toContain('EACCES');
  });

  /**
   * ⚠️ FOUND BY REVIEW, and it is a real AC3 gap rather than a formatting preference.
   *
   * The timeout and spawn-failure arms originally said only "the install command", naming
   * neither the declared command line nor the config key. Unlike a gate — whose id the operator
   * chose and which the message carries — an install is identified by a fixed key, so a
   * diagnostic that does not spell out `setup.install` leaves the operator holding an exit 3
   * with no pointer to the line they have to change.
   *
   * Asserted over EVERY runtime failure path at once, so a later arm added without the context
   * fails here rather than being noticed in production.
   */
  it('names both the declared command and the config key on every failure path (AC3)', async () => {
    const failures = [
      processResult({ outcome: 'completed', exitCode: 1 }),
      processResult({ outcome: 'timed-out', exitCode: null }),
      processResult({ outcome: 'spawn-failed', exitCode: null, stderr: 'EACCES' }),
    ];

    for (const failure of failures) {
      const error = await infraErrorFrom(
        createSetupStage({
          install: declaredInstall('pnpm install --frozen-lockfile'),
          runner: recordingRunner(failure),
        }).run(stageContext()),
      );

      expect(error.message).toContain('pnpm install --frozen-lockfile');
      expect(`${error.message} ${error.hint ?? ''}`).toContain(SETUP_INSTALL_ID);
      expect(`${error.message} ${error.hint ?? ''}`).toContain('.specwitness/config.yaml');
    }

    // `not-found` is the fourth path and states the config key in its hint; its MESSAGE names the
    // binary rather than the whole line, deliberately, because the binary is the thing that could
    // not be resolved and repeating the arguments would bury it.
    const notFound = await infraErrorFrom(
      createSetupStage({
        install: declaredInstall('pnpm install --frozen-lockfile'),
        runner: recordingRunner(processResult({ outcome: 'not-found', exitCode: null })),
      }).run(stageContext()),
    );
    expect(notFound.message).toContain('pnpm');
    expect(notFound.hint).toContain(SETUP_INSTALL_ID);
    expect(notFound.hint).toContain('.specwitness/config.yaml');
  });

  it('refuses to install into the project root when no worktree was created', async () => {
    const runner = refusingRunner();

    const error = await infraErrorFrom(
      createSetupStage({ install: declaredInstall('pnpm install'), runner }).run(
        stageContext({ worktreePath: null }),
      ),
    );

    // An install in the operator's own directory does not merely verify the wrong tree: it
    // rewrites that tree's dependencies (AD-8, FR-19).
    expect(error.message).toContain('no verification worktree was created');
    expect(runner.calls).toEqual([]);
  });
});

describe('the setup stage refuses malformed declared commands before spawning (AD-3)', () => {
  const malformed: readonly { readonly declared: string; readonly expected: string }[] = [
    { declared: 'node -e \\"install()\\"', expected: 'backslash-escaped quotes' },
    { declared: "sh -c 'pnpm install", expected: 'unterminated quote' },
    { declared: '"/usr/local/bin/pnpm"install', expected: 'text attached to its quoted executable' },
  ];

  for (const { declared, expected } of malformed) {
    it(`refuses ${expected}`, async () => {
      const runner = refusingRunner();

      const error = await infraErrorFrom(
        createSetupStage({ install: declaredInstall(declared), runner }).run(stageContext()),
      );

      expect(error.message).toContain(expected);
      expect(error.hint).toContain(SETUP_INSTALL_ID);
      // Refused BEFORE spawning. The alternative is worse than a refusal: the argument
      // mis-groups, the install fails for a reason that is not the branch, and the gates then run
      // against an uninstalled tree.
      expect(runner.calls).toEqual([]);
    });
  }

  it('refuses a declaration with no executable, and refuses it before the worktree check', async () => {
    const error = await infraErrorFrom(
      createSetupStage({ install: declaredInstall('   '), runner: refusingRunner() }).run(
        stageContext({ worktreePath: null }),
      ),
    );

    // Naming the malformed declaration rather than the missing worktree: the config line is what
    // the operator has to change, and it is the first thing wrong.
    expect(error.message).toContain('declares no executable');
  });
});

describe('the install timeout', () => {
  it('is ten minutes, between a data command and a gate', async () => {
    // Not a guess: a data command is local (5 min in `data.ts`), a gate is an install plus a test
    // run (15 min in `gates.ts`), and an install is network-bound but a single phase. Pinned so
    // that changing it is a deliberate edit to a stated decision.
    expect(SETUP_INSTALL_TIMEOUT_MS).toBe(10 * 60 * 1000);
  });
});
