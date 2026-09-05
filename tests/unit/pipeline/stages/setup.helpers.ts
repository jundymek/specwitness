import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, type DeclaredCommand, type SpecwitnessConfig } from '../../../../src/config/index.js';
import type { DerivedCriterionResult } from '../../../../src/domain/criterion-result.js';
import { InfraError } from '../../../../src/domain/errors.js';
import type { Evidence } from '../../../../src/domain/evidence.js';
import type { Clock } from '../../../../src/domain/ports.js';
import type {
  ProcessResult,
  ProcessRunOptions,
  ProcessRunner,
} from '../../../../src/domain/process-runner.js';
import type { GateResult } from '../../../../src/domain/result.js';
import type { RunEnvironment, RunResult } from '../../../../src/domain/run-result.js';
import type { RunAccumulator, StageContext } from '../../../../src/pipeline/stage.js';

/**
 * Test doubles for the `setup` stage (story 6.11).
 *
 * Modelled on `data.helpers.ts`, and for the same non-negotiable reason: a `DeclaredCommand` may
 * only be minted inside `src/config/` (AD-3), so every command here is built by writing REAL YAML
 * and loading it through the real `loadConfig`. A test that forged one with `as DeclaredCommand`
 * would assert against a shape the product can never produce — and
 * `tests/unit/config/boundary-scan.test.ts` would reject it anyway.
 *
 * The whole config is returned as well as the command, because this story's central assertion
 * (AC4) is that `doctor` and `verify` agree about ONE loaded config: the agreement test hands the
 * same `SpecwitnessConfig` to the doctor check and to the stage, so the two cannot be reading
 * different files.
 */

/** The YAML text for a project declaring (or not declaring) `setup.install`. */
export function setupYaml(install?: string): string {
  const lines = ['version: 1', 'project:', '  baseBranch: master'];
  if (install !== undefined) {
    lines.push('setup:', `  install: ${JSON.stringify(install)}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * A real `SpecwitnessConfig`, loaded from real YAML on disk.
 *
 * `mkdtemp` rather than a fixed path (harness defect H-8): the auto-review runs `pnpm test` in
 * this worktree concurrently with the agent, and two runs sharing a scratch config would race.
 */
export function loadedConfig(install?: string): SpecwitnessConfig {
  const root = mkdtempSync(join(tmpdir(), 'specwitness-setup-'));
  mkdirSync(join(root, '.specwitness'));
  writeFileSync(join(root, '.specwitness', 'config.yaml'), setupYaml(install));
  return loadConfig(root);
}

/** The declared install command, minted the only way it can legitimately be minted. */
export function declaredInstall(install: string): DeclaredCommand {
  const command = loadedConfig(install).setup.install;
  if (command === undefined) {
    throw new Error(`loadConfig did not carry setup.install for ${JSON.stringify(install)}`);
  }
  return command;
}

/** A `ProcessResult` with the fields a real install spawn produces. */
export function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    outcome: 'completed',
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 4200,
    pgid: 5150,
    ...overrides,
  };
}

export interface RecordingRunner extends ProcessRunner {
  readonly calls: ProcessRunOptions[];
}

/**
 * A runner recording every spawn, with results scripted per call.
 *
 * Spawning MORE times than the test scripted throws with a message naming the extra command.
 * The setup stage runs at most one command, so a second spawn is always a defect — and an
 * assertion on `calls.length` alone would pass even if the stage had spawned twice and ignored
 * the second result.
 */
export function recordingRunner(...results: readonly ProcessResult[]): RecordingRunner {
  const calls: ProcessRunOptions[] = [];
  let index = 0;

  return {
    calls,
    run: async (options) => {
      calls.push(options);
      const scripted = results[index];
      index += 1;
      if (scripted === undefined) {
        throw new Error(
          `the setup stage spawned "${options.binary}" (call ${index}) but only ` +
            `${results.length} result(s) were scripted — it runs at most one command`,
        );
      }

      // The pgid is published BEFORE the outcome, exactly as the real runner does:
      // `onProcessGroup` is awaited before the run proceeds (AD-8, story 3.2).
      if (options.onProcessGroup !== undefined) {
        await options.onProcessGroup(scripted.pgid ?? 40_000 + index);
      }

      return scripted;
    },
  };
}

/** A runner that must never be called. Proves "nothing was spawned". */
export function refusingRunner(): RecordingRunner {
  const calls: ProcessRunOptions[] = [];
  return {
    calls,
    run: async (options) => {
      calls.push(options);
      throw new Error(`nothing should have been spawned, but "${options.binary}" was`);
    },
  };
}

/** An evidence writer recording what it was asked to persist, returning the relative path. */
export function recordingWriter(): ((name: string, contents: string) => Promise<string>) & {
  readonly written: { name: string; contents: string }[];
} {
  const written: { name: string; contents: string }[] = [];
  const write = async (name: string, contents: string): Promise<string> => {
    written.push({ name, contents });
    return name;
  };
  return Object.assign(write, { written });
}

/** An evidence writer that always fails, for the durability paths. */
export function failingWriter(reason = 'ENOSPC: no space left on device') {
  return async (): Promise<string> => {
    throw new Error(reason);
  };
}

/** A `Clock` that advances a fixed step on every read. Never a real clock (AD-9). */
export class SteppingClock implements Clock {
  #current: number;

  constructor(
    start: string | Date = '2026-09-05T00:00:00.000Z',
    private readonly stepMs = 100,
  ) {
    this.#current = (typeof start === 'string' ? new Date(start) : start).getTime();
  }

  now(): Date {
    const instant = new Date(this.#current);
    this.#current += this.stepMs;
    return instant;
  }
}

/**
 * Awaits a stage run that MUST reject with an `InfraError`, and returns it.
 *
 * Same shape and reason as the gates, services and data helpers: a `.catch(e => e)` passes
 * silently when the stage RESOLVES, and "an install that did not happen must never come back as
 * an ordinary result" is precisely this story's central assertion.
 */
export async function infraErrorFrom(run: Promise<unknown>): Promise<InfraError> {
  let resolved: unknown;
  try {
    resolved = await run;
  } catch (error) {
    if (error instanceof InfraError) {
      return error;
    }
    throw error;
  }
  throw new Error(`expected an InfraError but the stage resolved with ${JSON.stringify(resolved)}`);
}

/** The worktree path every fixture context reports. */
export const WORKTREE = '/tmp/specwitness-worktree-setup-fixture';

const ENVIRONMENT: RunEnvironment = {
  nodeVersion: 'v22.13.0',
  platform: 'linux',
  arch: 'x64',
  specwitnessVersion: '0.1.0',
  worktreePath: WORKTREE,
  runDirectory: '.specwitness/runs/run-20260905T000000Z-cd34',
};

export interface ContextOptions {
  readonly worktreePath?: string | null;
  readonly gates?: GateResult[];
  readonly criteria?: DerivedCriterionResult[];
  readonly evidence?: Evidence[];
  readonly clock?: Clock;
}

/** A `StageContext` carrying only what the setup stage legitimately reads. */
export function stageContext(options: ContextOptions = {}): StageContext & {
  readonly run: RunAccumulator;
} {
  const run: RunAccumulator = {
    epic: 'epic-7',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    gates: options.gates ?? [],
    criteria: options.criteria ?? [],
    evidence: options.evidence ?? [],
    providerUsage: [],
    environment: {
      ...ENVIRONMENT,
      worktreePath:
        options.worktreePath === undefined ? ENVIRONMENT.worktreePath : options.worktreePath,
    },
    contractCriteria: [],
  };

  return {
    runId: 'run-20260905T000000Z-cd34',
    clock: options.clock ?? new SteppingClock(),
    run,
    // `setup` is position 4; an outcome does not exist until position 9, and `snapshot()` throws
    // before then. Throwing here proves the stage never reaches for it rather than merely
    // asserting that it should not.
    snapshot: (): RunResult => {
      throw new Error('the setup stage must not call snapshot()');
    },
  };
}
