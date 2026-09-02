/**
 * Epic 3 retro debt 2, owner-assigned to story 4.7 — SIGINT on the verify path.
 *
 * ============================================================================
 * WHAT WAS REPRODUCED, BEFORE ANYTHING WAS FIXED
 * ============================================================================
 *
 * A `verify` was started against a fixture with a gate that never ends, interrupted with
 * SIGINT once its process group was recorded, and the wreckage measured:
 *
 *   exit:      no chosen exit code; the process died by signal (SIGINT)
 *   stderr:    ZERO bytes about the interruption
 *   on disk:   the detached worktree survived, still registered with git
 *   processes: the gate's process group survived
 *   manifest:  present, `reaped: false`, carrying the pgid — so `specwitness clean` CAN
 *              reap it
 *   git:       `git status --porcelain` empty — the source repository is untouched (FR-19)
 *
 * **So the recovery path already existed and the operator was simply never told about it.**
 * That is the defect, stated precisely: not the leak, which AD-8's crash-durable manifest is
 * designed to survive, but the silence.
 *
 * ============================================================================
 * THE FIX, AND WHY IT IS A MESSAGE RATHER THAN A TEARDOWN
 * ============================================================================
 *
 * The rider offers two legitimate outcomes and names the trap: a handler that ATTEMPTS full
 * async teardown and is interrupted again leaves a worse state than one that prints a
 * reliable message. The handler installed here is synchronous, removes itself before it
 * prints, and then re-raises SIGINT so the process still dies by signal — so it provably
 * terminates, a second Ctrl+C hits the default disposition, and there is no
 * teardown-during-teardown state to reason about. **No new signal semantics are decided, so
 * no ADR is needed** — which is the fork Epic 3's action item F named.
 *
 * **Exit 130 is NOT added to `cli/exit.ts`.** Re-raising means the OS ends the process and
 * the shell reports the signal death through `WIFSIGNALED`; nothing here CHOOSES an exit
 * code, and ADR-002's table governs chosen codes. `tests/unit/exit-location.test.ts` stays
 * green because `process.kill` is neither `process.exit` nor `process.exitCode`.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

import { buildFixture, CLI, type Fixture } from './helpers/verify-fixture.js';

const fixtures: Fixture[] = [];

afterEach(async () => {
  // REAPING HAPPENS IN THE HOOK, NOT IN THE TEST BODY. Every test here deliberately leaves
  // a live process group behind, so a reap that ran only on the happy path would leak one
  // per failed assertion — and this worktree runs `pnpm test` concurrently with the agent
  // (harness defect H-8). Measured on this machine while writing the suite: 21 orphaned
  // `node gates/slow.cjs` processes from earlier sessions, none newer than two hours old,
  // and neither this suite nor the merged `verify.test.ts` adds to them when either runs to
  // completion. So the leak comes from a test RUN being killed, which is exactly what a
  // hook survives and a test body does not.
  for (const fixture of fixtures) {
    await execa(process.execPath, [CLI, 'clean', '--all'], {
      cwd: fixture.root,
      reject: false,
    });
  }
  await Promise.all(fixtures.splice(0).map(async (fixture) => await fixture.cleanup()));
});

/**
 * Starts a verify and interrupts it once its process group is on disk.
 *
 * Polling the MANIFEST rather than sleeping is what makes this deterministic: the signal is
 * sent when the run demonstrably holds a worktree and a live process group, not at a moment
 * that happens to work on this machine today.
 */
async function interruptMidRun(project: Fixture): Promise<{
  readonly signal: string | undefined;
  readonly stderr: string;
  readonly runDirectory: string;
}> {
  const child = execa(process.execPath, [CLI, 'verify', project.epic], {
    cwd: project.root,
    reject: false,
  });

  const runsRoot = join(project.root, '.specwitness', 'runs');
  let runDirectory = '';

  for (let attempt = 0; attempt < 200; attempt += 1) {
    const runs = await readdir(runsRoot).catch(() => [] as string[]);
    const candidate = runs.at(-1);
    if (candidate !== undefined) {
      const manifest = await readFile(join(runsRoot, candidate, 'manifest.json'), 'utf8').catch(
        () => '',
      );
      if (/"processGroups":\s*\[\s*\d/.test(manifest)) {
        runDirectory = candidate;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  expect(runDirectory, 'the run never reached a live process group').not.toBe('');

  child.kill('SIGINT');
  const result = await child;

  // Reaped here AS WELL as in `afterEach`, because one test asserts on the manifest AFTER
  // `clean` has run. `clean` is idempotent, so the hook's second call is a no-op — and the
  // hook is what makes the suite safe when an assertion below this line throws.
  await execa(process.execPath, [CLI, 'clean', '--all'], { cwd: project.root, reject: false });

  return { signal: result.signal, stderr: result.stderr, runDirectory };
}

describe('Ctrl+C during a verify tells the operator what survived', () => {
  it('prints an ERROR/HINT pair naming the run directory and `specwitness clean`', async () => {
    // THE DEFECT IS THE SILENCE. Before this, an interrupted run printed nothing at all
    // about the detached worktree it left on disk or the process group still running — and
    // the manifest that makes both recoverable is in a directory the operator was never
    // told the name of.
    const project = await buildFixture({ gates: [{ id: 'slow', behaviour: 'slow' }] });
    fixtures.push(project);

    const { stderr, runDirectory } = await interruptMidRun(project);

    expect(stderr).toContain('ERROR:');
    expect(stderr).toContain('HINT:');
    expect(stderr).toContain('interrupted');
    // The two facts an operator needs, and cannot otherwise get: WHERE, and WHAT TO RUN.
    expect(stderr).toContain(runDirectory);
    expect(stderr).toContain('specwitness clean');
  }, 90_000);

  it('still dies BY SIGNAL — no exit code is chosen (ADR-002 governs chosen codes)', async () => {
    // The handler re-raises rather than exiting, so the shell still sees `WIFSIGNALED` and
    // reports 130 itself. Adding 130 to `cli/exit.ts` would be claiming SpecWitness decided
    // this outcome, and it did not.
    const project = await buildFixture({ gates: [{ id: 'slow', behaviour: 'slow' }] });
    fixtures.push(project);

    const { signal } = await interruptMidRun(project);

    expect(signal).toBe('SIGINT');
  }, 90_000);

  it('leaves the SOURCE REPOSITORY untouched (FR-19, AD-8)', async () => {
    // Held from before the fix and re-asserted after it: interrupting a run must never
    // modify the tree being verified. This was already true, and a signal handler is exactly
    // the kind of change that could quietly stop it being true.
    const project = await buildFixture({ gates: [{ id: 'slow', behaviour: 'slow' }] });
    fixtures.push(project);

    await interruptMidRun(project);

    expect(await project.status()).toBe('');
  }, 90_000);

  it('leaves a manifest `specwitness clean` can act on — the message is not a promise it cannot keep', async () => {
    // The hint would be worse than silence if `clean` could not in fact reap the run. So
    // the message and the recovery are asserted together: the manifest records the worktree
    // and the process group, and `clean --all` reports the run as reaped afterwards.
    const project = await buildFixture({ gates: [{ id: 'slow', behaviour: 'slow' }] });
    fixtures.push(project);

    const { runDirectory } = await interruptMidRun(project);

    const manifest = JSON.parse(
      await readFile(
        join(project.root, '.specwitness', 'runs', runDirectory, 'manifest.json'),
        'utf8',
      ),
    ) as {
      readonly worktrees?: readonly string[];
      readonly processGroups?: readonly number[];
      readonly reaped?: boolean;
    };

    expect((manifest.worktrees ?? []).length).toBeGreaterThan(0);
    expect((manifest.processGroups ?? []).length).toBeGreaterThan(0);
    // `interruptMidRun` already ran `clean --all`.
    expect(manifest.reaped).toBe(true);
  }, 90_000);

  it('says nothing when there is nothing to say — no run directory, no message', async () => {
    // A usage error is not an interruption, and a handler that fired on every failure would
    // train an operator to ignore the one message that matters.
    const project = await buildFixture();
    fixtures.push(project);

    const result = await execa(process.execPath, [CLI, 'verify', 'not-an-epic'], {
      cwd: project.root,
      reject: false,
    });

    expect(result.exitCode).toBe(64);
    expect(result.stderr).not.toContain('specwitness clean');
  }, 60_000);
});
