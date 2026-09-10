import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createProbeDispatcher } from '../../../src/cli/verify/probe-dispatch.js';
import { loadConfig, type SpecwitnessConfig } from '../../../src/config/index.js';
import { InfraError } from '../../../src/domain/errors.js';
import type { RedactionOptions } from '../../../src/domain/evidence.js';
import type { ProcessRunner } from '../../../src/domain/process-runner.js';
import type { BrowserRuntimeEnvironment } from '../../../src/surfaces/index.js';
import { FixedClock } from '../../fakes/ports.js';
import { BROWSER_PROBE } from '../../helpers/plan.js';

/**
 * Story 7.4 — the browser arm of the dispatcher carries the run's extra patterns (AC2).
 *
 * The other four surfaces are proven end to end through the built binary
 * (`tests/integration/verify-extra-patterns.test.ts`, the `redaction-extra-patterns` corpus
 * fixture). The browser surface cannot be: no hermetic run has a browser. So its arm is pinned
 * here, with the pattern loaded by the REAL loader from a real config file, and an environment
 * that is not ready — the executor then refuses quoting the environment's reason, which is the
 * one browser message every machine without Playwright produces.
 *
 * The control, without the options, must quote the secret, which proves the refusal really
 * carries the reason and that no built-in rule matches it.
 */

const SECRET = 'wombat-7x3k9q2m4p';

class RefusingRunner implements ProcessRunner {
  run(): never {
    throw new Error('a refused browser probe must spawn nothing');
  }
}

let scratch: string;
let config: SpecwitnessConfig;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'specwitness-7-4-dispatch-'));
  await mkdir(join(scratch, 'project', '.specwitness'), { recursive: true });
  await writeFile(
    join(scratch, 'project', '.specwitness', 'config.yaml'),
    [
      'version: 1',
      'project:',
      '  baseBranch: master',
      'services:',
      '  frontend: { run: node web.js, port: 18081, ready: { url: "http://127.0.0.1:18081/" } }',
      'redaction:',
      '  extraPatterns:',
      "    - 'wombat-[a-z0-9]+'",
      '',
    ].join('\n'),
    'utf8',
  );
  config = loadConfig(join(scratch, 'project'));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function refusal(redaction?: RedactionOptions): Promise<InfraError> {
  const dispatch = createProbeDispatcher({
    config,
    runner: new RefusingRunner(),
    clock: new FixedClock('2026-09-10T12:00:00.000Z'),
    writeEvidence: (name) => Promise.resolve(name),
    writeEvidenceBytes: (name) => Promise.resolve(name),
    resolveRunPath: (name) => join(scratch, 'run', name),
    playwright: {
      ready: false,
      source: 'absent',
      reason: `@playwright/test does not resolve from ${join(scratch, SECRET, 'project')}`,
    } as unknown as BrowserRuntimeEnvironment,
    onProcessGroup: () => undefined,
    ...(redaction === undefined ? {} : { redaction }),
  });

  const { executor, params } = dispatch({
    criterionId: 'E7-04',
    probe: BROWSER_PROBE,
    attempt: 1,
    cwd: scratch,
    runAction: () => Promise.resolve(),
    recordEvidence: () => undefined,
  });

  try {
    await executor.execute({ criterionId: 'E7-04', surface: 'browser', params });
  } catch (error) {
    if (error instanceof InfraError) {
      return error;
    }
    throw error;
  }
  throw new Error('an unready browser environment must be refused, never skipped');
}

describe('story 7.4 — the browser arm of the dispatcher (AD-10, AC2)', () => {
  it('a refusal quoting a project-shaped path: present on built-ins, ABSENT with the loaded pattern', async () => {
    expect((await refusal()).message, 'control').toContain(SECRET);

    const error = await refusal(config.redaction);
    expect(`${error.message}\n${error.hint ?? ''}`).not.toContain(SECRET);
  });
});
