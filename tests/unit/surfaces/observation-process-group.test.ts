/**
 * A seam defect found by story 4.7: an observation probe's process group never reached the
 * run manifest.
 *
 * `ObservationSurfaceExecutor` spawns a real child through `ProcessRunner.run`, which puts
 * it in its own process group — but the merged executor passed no `onProcessGroup` hook, so
 * nothing wrote that pgid down. After an interrupted or crashed run, `specwitness clean`
 * has only the manifest to work from, so the probe and every descendant it started outlive
 * the run with nothing on disk able to name them. That is the exact state AD-8's
 * crash-durable manifest exists to prevent.
 *
 * It is not a novel judgement. **Both merged spawning stages carry the hook for this
 * reason** (`pipeline/stages/gates.ts`, `pipeline/stages/services.ts`, and 4.3's data
 * stage), and 4.6's own Codex review found and fixed the identical omission in
 * `src/surfaces/shell.ts` — its `ShellExecutorDeps.onProcessGroup` documents it as "not
 * optional in spirit, only in type". 4.5 and 4.6 agreed their two command-spawning surfaces
 * would "present one shape to their common caller"; on this field they did not, and 4.7 is
 * the first caller able to see the difference.
 *
 * The fix is 4.6's verbatim: an optional dep forwarded to the runner.
 */

import { describe, expect, it } from 'vitest';

import { ObservationSurfaceExecutor } from '../../../src/surfaces/observation.js';
import { FixedClock } from '../../fakes/ports.js';

import { processResult, RecordingEvidence, resolvedCommand, ScriptedRunner } from './observation.helpers.js';

function request(overrides: Record<string, unknown> = {}) {
  return {
    criterionId: 'E4-01',
    surface: 'observation' as const,
    params: {
      probeId: 'count-companies',
      mechanics: { commandId: 'company-count', args: [] },
      assertions: [
        {
          description: 'exactly one company row exists',
          target: { source: 'jsonPath', path: '$.count', phase: 'snapshot' },
          comparison: 'equals',
          expected: '1',
        },
      ],
      ...overrides,
    },
  };
}

const OUTPUT = processResult({ stdout: '{"count":1}' });

describe('ObservationSurfaceExecutor — AD-8 process-group recording', () => {
  it('forwards onProcessGroup to the runner, so the pgid reaches the manifest', async () => {
    const runner = new ScriptedRunner(OUTPUT);
    const recorded: number[] = [];

    const subject = new ObservationSurfaceExecutor({
      runner,
      clock: new FixedClock('2026-09-01T12:00:00.000Z'),
      cwd: '/tmp/worktree',
      writeEvidence: new RecordingEvidence().write,
      recordEvidence: () => undefined,
      resolveCommand: () => resolvedCommand(),
      onProcessGroup: (pgid) => {
        recorded.push(pgid);
      },
    });

    await subject.execute(request());

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.onProcessGroup).toBeDefined();
  });

  it('records EVERY snapshot of a wrapping observation, not only the first', async () => {
    // A before/after pair spawns the command twice. Recording one pgid and not the other
    // leaves half the groups unreapable, which is the same failure at half the rate.
    const runner = new ScriptedRunner(OUTPUT);

    const subject = new ObservationSurfaceExecutor({
      runner,
      clock: new FixedClock('2026-09-01T12:00:00.000Z'),
      cwd: '/tmp/worktree',
      writeEvidence: new RecordingEvidence().write,
      recordEvidence: () => undefined,
      resolveCommand: () => resolvedCommand(),
      runAction: async () => undefined,
      onProcessGroup: () => undefined,
    });

    await subject.execute(
      request({
        mechanics: { commandId: 'company-count', args: [], around: 'submit-form' },
        assertions: [
          {
            description: 'exactly one company row was created',
            target: { source: 'jsonPath', path: '$.count', phase: 'delta' },
            comparison: 'equals',
            expected: '1',
          },
        ],
      }),
    );

    expect(runner.calls).toHaveLength(2);
    for (const call of runner.calls) {
      expect(call.onProcessGroup).toBeDefined();
    }
  });

  it('still runs when no hook is injected — optional in type, as 4.6 has it', async () => {
    const runner = new ScriptedRunner(OUTPUT);

    const subject = new ObservationSurfaceExecutor({
      runner,
      clock: new FixedClock('2026-09-01T12:00:00.000Z'),
      cwd: '/tmp/worktree',
      writeEvidence: new RecordingEvidence().write,
      recordEvidence: () => undefined,
      resolveCommand: () => resolvedCommand(),
    });

    const attempt = await subject.execute(request());

    expect(attempt.execError).toBeUndefined();
    expect(runner.calls[0]?.onProcessGroup).toBeUndefined();
  });
});
