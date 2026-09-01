import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  planFileExists,
  planRelativePath,
  readPlanFile,
  resolvePlanPath,
} from '../../../src/authoring/plan-file.js';
import { InfraError } from '../../../src/domain/errors.js';

/**
 * Every fixture is a fresh `mkdtemp` directory with no fixed name or port — the auto-review
 * runs `pnpm test` in this worktree concurrently with the agent (harness defect H-8).
 */
const created: string[] = [];

afterEach(async () => {
  await Promise.all(
    created.splice(0).map(async (dir) => {
      // Restore permissions first, or the unreadable-directory fixture cannot be removed.
      await chmod(dir, 0o755).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }),
  );
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'specwitness-plan-file-'));
  created.push(root);
  await mkdir(join(root, '.specwitness', 'plans'), { recursive: true });
  return root;
}

describe('resolvePlanPath / planRelativePath', () => {
  it('resolves every spelling of an epic id to ONE file', async () => {
    const root = await project();

    const canonical = resolvePlanPath(root, 'epic-7');
    expect(resolvePlanPath(root, '7')).toBe(canonical);
    expect(resolvePlanPath(root, 'epic-07')).toBe(canonical);
    expect(resolvePlanPath(root, 'EPIC-7')).toBe(canonical);
    expect(planRelativePath('7')).toBe('.specwitness/plans/epic-7.yaml');
  });
});

describe('absence and failure are different answers', () => {
  it('reports a missing plan as absent', async () => {
    const root = await project();

    expect(await planFileExists(root, '7')).toBe(false);
    expect(await readPlanFile(root, '7')).toBeUndefined();
  });

  it('reports an existing plan as present', async () => {
    const root = await project();
    await writeFile(resolvePlanPath(root, '7'), 'plan: {}\n', 'utf8');

    expect(await planFileExists(root, '7')).toBe(true);
  });

  /**
   * THE ONE THAT MATTERS. Story 4.7 auto-compiles a plan when none exists. If an unreadable
   * plan reported "absent", 4.7 would replace a reviewed plan it merely failed to open —
   * an infrastructure failure quietly becoming a destructive product action.
   *
   * `readPlanFile` already draws this distinction; `planFileExists` did not until the
   * third Codex review pass pointed it out.
   */
  it('raises InfraError when the plan exists but cannot be reached', async () => {
    const root = await project();
    await writeFile(resolvePlanPath(root, '7'), 'plan: {}\n', 'utf8');
    const plansDir = join(root, '.specwitness', 'plans');
    created.push(plansDir);
    await chmod(plansDir, 0o000);

    // Skipped when the test runs as a user permissions do not constrain (root in some CI
    // images): there the directory is readable regardless and the case cannot be produced.
    if (await planFileExists(root, '7').then(() => true, () => false)) {
      const reachable = await planFileExists(root, '7').catch(() => 'threw');
      if (reachable === true) {
        return;
      }
    }

    await expect(planFileExists(root, '7')).rejects.toThrow(InfraError);
  });

  it('a directory where the plan file belongs is a failure, not an absence', async () => {
    const root = await project();
    await mkdir(resolvePlanPath(root, '7'));

    await expect(readPlanFile(root, '7')).rejects.toThrow(InfraError);
  });
});
