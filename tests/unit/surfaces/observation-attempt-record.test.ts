/**
 * FR-28 on the observation surface: a non-pass criterion must carry at least one evidence
 * reference, and before this story one path produced none.
 *
 * **This gap was disclosed by its own author and assigned to 4.7.** 4.5's PR body names it
 * exactly — *"Mine: `not-found`, a timeout before any output, and a silent `completed` run
 * — each derives to criterion `error` with zero evidence refs"* — and says the right shape
 * is *"a small follow-up across all three … owned by 4.7 or by one cross-surface PR"*.
 *
 * 4.5 held off because it believed the only fix was widening the closed evidence union
 * (an ADR) and that 4.4 had not adopted the alternative. **The second half of that was
 * already stale when it was written**: 4.4's merged `http.ts` had closed its own version of
 * this gap without touching the union, by using the fact that *the typed MEMBER and the
 * evidence REFERENCE are separate channels*. On a refused connection it records no member —
 * `HttpResponseRecord.status` is a bare `number` and inventing `status: 0` would be
 * manufacturing an observation — but it writes a redacted `.request.txt` recording what was
 * ATTEMPTED and refs that. It states a fact without claiming an observation was made.
 *
 * The same move applies here verbatim, and 4.6's `shell.ts` reaches the same place by its
 * own route (`CommandEvidence.exitCode` is `number | null`, so it can record a member).
 * With this, all three surfaces satisfy FR-28 on every non-pass they can produce, no union
 * is widened, and no ADR is needed.
 *
 * Found by the surface-conformance test 4.7 owns — `tests/integration/surfaces/conformance.test.ts`
 * — which is the first thing in the product to drive all three surfaces through one set of
 * situations.
 */

import { describe, expect, it } from 'vitest';

import { deriveCriterionResult } from '../../../src/domain/criterion-result.js';
import type { ContractCriterionRef } from '../../../src/domain/criterion-result.js';
import { ObservationSurfaceExecutor } from '../../../src/surfaces/observation.js';
import { FixedClock } from '../../fakes/ports.js';

import { processResult, RecordingEvidence, resolvedCommand, ScriptedRunner } from './observation.helpers.js';

const AUTOMATED: ContractCriterionRef = {
  criterionId: 'E4-01',
  statement: 'Submitting the form twice creates exactly one company row.',
  severity: 'critical',
  verifiability: 'automated',
};

function build(runner: ScriptedRunner): {
  readonly executor: ObservationSurfaceExecutor;
  readonly evidence: RecordingEvidence;
} {
  const evidence = new RecordingEvidence();
  return {
    evidence,
    executor: new ObservationSurfaceExecutor({
      runner,
      clock: new FixedClock('2026-09-02T12:00:00.000Z'),
      cwd: '/tmp/worktree',
      writeEvidence: evidence.write,
      recordEvidence: evidence.record,
      resolveCommand: () => resolvedCommand(),
    }),
  };
}

const REQUEST = {
  criterionId: 'E4-01',
  surface: 'observation' as const,
  params: {
    id: 'count-companies',
    mechanics: { commandId: 'company-count', args: ['--json'] },
    assertions: [
      {
        description: 'exactly one company row exists',
        target: { source: 'jsonPath', path: '$.count', phase: 'snapshot' },
        comparison: 'equals',
        expected: '1',
      },
    ],
  },
};

describe('FR-28 — an observation that observed NOTHING still carries a reference', () => {
  it.each([
    { name: 'the command was not found', result: processResult({ outcome: 'not-found' }) },
    { name: 'it could not be spawned', result: processResult({ outcome: 'spawn-failed' }) },
    {
      name: 'it timed out before printing anything',
      result: processResult({ outcome: 'timed-out', stdout: '', stderr: '' }),
    },
    {
      name: 'it completed silently, emitting no JSON at all',
      result: processResult({ outcome: 'completed', exitCode: 0, stdout: '', stderr: '' }),
    },
  ])('$name', async ({ result }) => {
    const { executor } = build(new ScriptedRunner(result));

    const attempt = await executor.execute(REQUEST);
    const derived = deriveCriterionResult(AUTOMATED, [attempt]);

    // Infrastructure, never a product FAIL — that classification is 4.5's and is untouched.
    expect(derived.status).toBe('error');
    // The part this test is for: FR-28's reference now exists.
    expect(attempt.evidence.length).toBeGreaterThan(0);
    expect(derived.evidence?.length ?? 0).toBeGreaterThan(0);
  });

  it('records what was ATTEMPTED, and says so — it never claims an observation', async () => {
    // The distinction the whole fix rests on. A record that read as a snapshot would be
    // manufacturing an observation out of an infrastructure failure, which is the sin every
    // surface refuses elsewhere.
    const { executor, evidence } = build(new ScriptedRunner(processResult({ outcome: 'not-found' })));

    await executor.execute(REQUEST);

    const written = evidence.files.map((file) => file.contents).join('\n');
    expect(written).toContain('what was attempted');
    expect(written).not.toContain('snapshot:');
    expect(written).toContain('company-count');
    expect(written).toContain('--json');
  });

  it('records NO typed member on that path — the union cannot represent it honestly', async () => {
    // `ObservationEvidence.snapshot` is a `BoundedText` with no absence marker, so "nothing
    // ran" and "ran and printed nothing" would be indistinguishable in a member. The
    // reference is a different channel and carries the fact instead.
    const { executor, evidence } = build(new ScriptedRunner(processResult({ outcome: 'not-found' })));

    await executor.execute(REQUEST);

    expect(evidence.members).toHaveLength(0);
    expect(evidence.files.length).toBeGreaterThan(0);
  });

  it('redacts the attempt record — it is capture, and capture is where AD-10 redacts', async () => {
    const { executor, evidence } = build(
      new ScriptedRunner(processResult({ outcome: 'not-found' })),
    );

    await executor.execute({
      ...REQUEST,
      params: {
        ...REQUEST.params,
        mechanics: {
          commandId: 'company-count',
          args: ['--token', 'AWS_SECRET_ACCESS_KEY=zzCANARYzz-4f2a'],
        },
      },
    });

    expect(evidence.everythingPersisted()).not.toContain('zzCANARYzz-4f2a');
  });

  it('writes NOTHING extra when the command DID produce output', async () => {
    // The ordinary path is untouched: an attempt record beside a real snapshot would be
    // noise, and would make "no output" indistinguishable from "output" in the file list.
    const { executor, evidence } = build(
      new ScriptedRunner(processResult({ stdout: '{"count":1}' })),
    );

    const attempt = await executor.execute(REQUEST);

    expect(deriveCriterionResult(AUTOMATED, [attempt]).status).toBe('pass');
    expect(evidence.files.some((file) => file.name.includes('.attempt.txt'))).toBe(false);
    expect(evidence.members).toHaveLength(1);
  });
});
