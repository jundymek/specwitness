/**
 * Story 3.1 Task 3 — the `worktree` stage.
 *
 * The stage is a thin wiring layer over `src/infra/vcs.ts`, which is where the git
 * behaviour is tested. What is asserted HERE is the wiring, and specifically the three
 * things a later story would silently break:
 *
 *  1. the manifest record happens BEFORE the worktree exists (AD-8);
 *  2. `ctx.run.environment.worktreePath` is set — arnold (3.4) reads it as his gate
 *     spawn's cwd and chuck (3.6) prints it, and a renderer may not look it up (AD-11),
 *     so leaving it null breaks both quietly rather than loudly;
 *  3. a worktree that cannot be created is an INFRASTRUCTURE failure — a thrown
 *     `InfraError`, never a `product-negative` return. Confusing those is how an
 *     unusable environment becomes "your branch has defects" (exit 1 instead of 3).
 *
 * The `Vcs` is a fake rather than real git: this is the wiring test, and the adapter's
 * own suite already drives real repositories.
 */

import { describe, expect, it } from 'vitest';

import { InfraError } from '../../../../src/domain/errors.js';
import type { CreatedWorktree, RepoRoot, Vcs } from '../../../../src/domain/vcs.js';
import type { StageContext } from '../../../../src/pipeline/stage.js';
import { createWorktreeStage } from '../../../../src/pipeline/stages/worktree.js';
import { FixedClock } from '../../../fakes/ports.js';

const ROOT: RepoRoot = {
  worktreeRoot: '/repo',
  mainWorktreeRoot: '/repo',
  gitCommonDir: '/repo/.git',
  linkedWorktree: false,
};

const HEAD_SHA = 'a'.repeat(40);

/** A minimal accumulator — only the fields this stage reads or writes. */
function contextFor(headSha = HEAD_SHA): StageContext {
  return {
    runId: 'run-20260901T083000Z-a3f9',
    clock: new FixedClock('2026-09-01T08:30:00.000Z'),
    run: {
      epic: 'epic-3',
      baseSha: 'b'.repeat(40),
      headSha,
      gates: [],
      criteria: [],
      evidence: [],
      providerUsage: [],
      environment: {
        node: process.version,
        platform: process.platform,
        worktreePath: null,
        runDirectory: '.specwitness/runs/run-20260901T083000Z-a3f9',
      },
      contractCriteria: [],
    },
    snapshot: () => {
      throw new Error('not used by this stage');
    },
  } as unknown as StageContext;
}

/** A `Vcs` whose `addWorktree` records the order things happened in. */
function fakeVcs(
  log: string[],
  overrides: Partial<Vcs> = {},
): Vcs {
  return {
    resolveRoot: async () => ({ outcome: 'resolved', root: ROOT }),
    resolveRef: async () => {
      throw new Error('the stage must not resolve refs — they arrive already resolved');
    },
    listWorktrees: async () => [],
    addWorktree: async (_root, sha, record): Promise<CreatedWorktree> => {
      const path = '/tmp/specwitness-worktree-x/worktree';
      await record(path);
      log.push(`created:${sha}`);
      return { path, sha, container: '/tmp/specwitness-worktree-x' };
    },
    removeWorktree: async () => undefined,
    removeWorktreeAt: async () => undefined,
    ...overrides,
  };
}

describe('the worktree stage', () => {
  it('creates the worktree at the already-resolved head sha', async () => {
    const log: string[] = [];
    const stage = createWorktreeStage({
      vcs: fakeVcs(log),
      recorder: { recordWorktree: async () => undefined },
      root: ROOT,
    });
    const context = contextFor();

    const result = await stage.run(context);

    expect(stage.name).toBe('worktree');
    expect(result.status).toBe('ok');
    // The sha comes from the accumulator: pamela's resolve stage is pure and my
    // `resolveRef` runs at the CLI edge, so the stage never spawns git itself.
    expect(log).toContain(`created:${HEAD_SHA}`);
  });

  it('records the path into the manifest BEFORE the worktree is created', async () => {
    const log: string[] = [];
    const stage = createWorktreeStage({
      vcs: fakeVcs(log),
      recorder: {
        recordWorktree: async (runId, path) => {
          log.push(`recorded:${runId}:${path}`);
        },
      },
      root: ROOT,
    });

    await stage.run(contextFor());

    // AD-8's ordering. A worktree registered before its path was persisted is one
    // `clean` cannot discover after a kill -9.
    expect(log).toEqual([
      'recorded:run-20260901T083000Z-a3f9:/tmp/specwitness-worktree-x/worktree',
      `created:${HEAD_SHA}`,
    ]);
  });

  it('sets environment.worktreePath, which three other stories read', async () => {
    const stage = createWorktreeStage({
      vcs: fakeVcs([]),
      recorder: { recordWorktree: async () => undefined },
      root: ROOT,
    });
    const context = contextFor();

    await stage.run(context);

    // arnold spawns gates with this as cwd; chuck prints it; rambo persists it
    // verbatim. Leaving it null makes all three fail quietly.
    expect(context.run.environment.worktreePath).toBe('/tmp/specwitness-worktree-x/worktree');
  });

  it('THROWS InfraError when the worktree cannot be created', async () => {
    const stage = createWorktreeStage({
      vcs: fakeVcs([], {
        addWorktree: async () => {
          throw new InfraError('could not create the verification worktree', 'check disk space');
        },
      }),
      recorder: { recordWorktree: async () => undefined },
      root: ROOT,
    });

    // NOT a product-negative return. An environment that cannot host a worktree
    // says nothing about whether the branch is any good, so this must reach the
    // exit table as 3, never as 1.
    await expect(stage.run(contextFor())).rejects.toThrow(InfraError);
  });

  it('propagates a failed manifest write rather than proceeding unrecorded', async () => {
    const stage = createWorktreeStage({
      vcs: fakeVcs([]),
      recorder: {
        recordWorktree: async () => {
          throw new InfraError('could not durably write the manifest', 'check free space');
        },
      },
      root: ROOT,
    });
    const context = contextFor();

    await expect(stage.run(context)).rejects.toThrow(InfraError);
    // And nothing claims a worktree exists.
    expect(context.run.environment.worktreePath).toBeNull();
  });

  it('refuses a head sha that was never resolved', async () => {
    const stage = createWorktreeStage({
      vcs: fakeVcs([]),
      recorder: { recordWorktree: async () => undefined },
      root: ROOT,
    });

    // An empty `headSha` means the resolve stage did not run or did not do its
    // job. Creating a worktree at "" would fail obscurely inside git; failing
    // here names the actual problem.
    await expect(stage.run(contextFor(''))).rejects.toThrow(InfraError);
  });
});
