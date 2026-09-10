import { describe, expect, it } from 'vitest';

import { InfraError } from '../../../src/domain/errors.js';
import type { RunEnvironment, RunResult } from '../../../src/domain/run-result.js';
import { STAGE_NAMES } from '../../../src/domain/stage.js';
import type { RedactionOptions } from '../../../src/domain/evidence.js';
import { runPipeline } from '../../../src/pipeline/run-pipeline.js';
import { stageOk } from '../../../src/pipeline/stage.js';
import type { Stage } from '../../../src/pipeline/stage.js';
import { FixedClock } from '../../fakes/ports.js';
import { EXTRA_PATTERN_SECRET as SECRET, EXTRA_REDACTION } from './stages/gates.secrets.js';

/**
 * Story 7.4 — the timeline recorder applies the run's config-declared extra patterns.
 *
 * `runPipeline` redacts every stage's detail and hint before recording it, because a timeline
 * entry is persisted in `result.json` and printed through `printError`. It did so with the
 * built-ins only, so a stage error quoting a project-shaped secret reached the most durable
 * artifact of the run intact (AC4). `RunPipelineInput.redaction` closes that.
 */

const ENVIRONMENT: RunEnvironment = {
  nodeVersion: 'v22.12.0',
  platform: 'darwin',
  arch: 'arm64',
  specwitnessVersion: '0.1.0',
  worktreePath: null,
  runDirectory: '.specwitness/runs/run-20260910T000000Z-a3f9',
};

/** Every stage inert except `gates`, which throws an error quoting the secret. */
function stages(): readonly Stage[] {
  return STAGE_NAMES.map(
    (name): Stage =>
      name === 'gates'
        ? {
            name,
            run: async () => {
              throw new InfraError(
                `the gate printed ${SECRET} before it died`,
                `inspect the handle ${SECRET} and rerun`,
              );
            },
          }
        : { name, run: async () => stageOk() },
  );
}

async function run(redaction?: RedactionOptions): Promise<RunResult> {
  return runPipeline({
    runId: 'run-20260910T000000Z-a3f9',
    epic: 'epic-7',
    baseSha: 'b'.repeat(40),
    headSha: 'c'.repeat(40),
    environment: ENVIRONMENT,
    clock: new FixedClock('2026-09-10T00:00:00.000Z'),
    stages: stages(),
    ...(redaction === undefined ? {} : { redaction }),
  });
}

describe('story 7.4 — the timeline recorder takes the run\'s extra patterns (AD-10, AC4)', () => {
  it('a stage detail and hint quoting a project-shaped secret: present on built-ins, ABSENT with the pattern', async () => {
    const control = await run();
    const failed = control.stages.find((entry) => entry.stage === 'gates');
    // The control proves the entry really carries the text, and that the built-ins miss it.
    expect(failed?.detail).toContain(SECRET);
    expect(failed?.hint).toContain(SECRET);

    const result = await run(EXTRA_REDACTION);
    expect(result.stages.find((entry) => entry.stage === 'gates')?.status).toBe('error');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});
