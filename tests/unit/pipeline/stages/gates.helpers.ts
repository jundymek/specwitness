import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, type GateConfig } from '../../../../src/config/index.js';
import { InfraError } from '../../../../src/domain/errors.js';
import type { DerivedCriterionResult } from '../../../../src/domain/criterion-result.js';
import type { Evidence } from '../../../../src/domain/evidence.js';
import type {
  ProcessResult,
  ProcessRunOptions,
  ProcessRunner,
} from '../../../../src/domain/process-runner.js';
import type { GateResult } from '../../../../src/domain/result.js';
import type { RunEnvironment, RunResult } from '../../../../src/domain/run-result.js';
import type { RunAccumulator, StageContext } from '../../../../src/pipeline/stage.js';
import { FixedClock } from '../../../fakes/ports.js';

/**
 * Test doubles for the gates stage.
 *
 * `GateConfig`s are built by writing real YAML and loading it through the real
 * `loadConfig` — never by casting an object literal. A `DeclaredCommand` may
 * only be minted inside `src/config` (AD-3), and a test that forged one would
 * be asserting against a shape the product can never actually produce. Same
 * rule, same reason, as `tests/unit/doctor/helpers.ts`.
 */

/** Real `GateConfig[]`, minted the only way they can legitimately be minted. */
export function declaredGates(gates: readonly { id: string; run: string }[]): GateConfig[] {
  const root = mkdtempSync(join(tmpdir(), 'specwitness-gates-'));
  mkdirSync(join(root, '.specwitness'));

  const yaml = [
    'version: 1',
    'project:',
    '  baseBranch: master',
    'gates:',
    ...gates.flatMap((gate) => [
      `  - id: ${JSON.stringify(gate.id)}`,
      `    run: ${JSON.stringify(gate.run)}`,
    ]),
  ].join('\n');

  writeFileSync(join(root, '.specwitness', 'config.yaml'), `${yaml}\n`);
  return [...loadConfig(root).gates];
}

/** A `ProcessResult` with the fields a real gate spawn produces. */
export function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    outcome: 'completed',
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 7,
    pgid: 4242,
    ...overrides,
  };
}

export interface RecordingRunner extends ProcessRunner {
  readonly calls: ProcessRunOptions[];
}

/**
 * A runner replaying scripted results and recording every call.
 *
 * Deliberately THROWS when asked for more spawns than were scripted, rather
 * than repeating the last result. "Nothing was spawned after the failure" is
 * this story's early-stop proof (FR-20), and a runner that quietly answered an
 * unscripted call would let that proof pass while the pipeline kept spending.
 */
export function recordingRunner(...results: readonly ProcessResult[]): RecordingRunner {
  const calls: ProcessRunOptions[] = [];
  let index = 0;

  return {
    calls,
    run: async (options) => {
      calls.push(options);
      const result = results[index];
      index += 1;
      if (result === undefined) {
        throw new Error(
          `gates stage spawned "${options.binary}" (call ${index}) but only ` +
            `${results.length} result(s) were scripted — it should have stopped`,
        );
      }
      return result;
    },
  };
}

export interface RecordingWriter {
  (relativeName: string, contents: string): Promise<string>;
  /** Every file the stage asked to write, in order, with its exact bytes. */
  readonly writes: { name: string; contents: string }[];
}

/**
 * Records the EXACT bytes handed to `RunStore.writeEvidenceFile`.
 *
 * Exact bytes rather than an intention, because the seeded-secret proof is
 * about what lands on disk. Story 3.3's review found that an evidence
 * constructor can redact the inline copy perfectly while the full file beside
 * it keeps the secret verbatim — a hole the obvious test certifies as clean.
 *
 * It does NOT model path-traversal rejection: `RunStore` validates and contains
 * `relativeName`, and that behaviour is 3.2's to test. A fake duplicating it
 * would be a second implementation of somebody else's guarantee.
 */
export function recordingWriter(): RecordingWriter {
  const writes: { name: string; contents: string }[] = [];
  const writer = async (name: string, contents: string): Promise<string> => {
    writes.push({ name, contents });
    return name;
  };
  return Object.assign(writer, { writes });
}

/**
 * Awaits a stage run that MUST reject with an `InfraError`, and returns it.
 *
 * A plain `.catch(e => e as InfraError)` types as a union with the resolved
 * stage result, and — worse — passes silently when the stage resolves instead
 * of throwing. AC3's whole point is that a gate which could not start must not
 * come back as an ordinary result, so the assertion has to fail loudly in
 * exactly that case.
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
  throw new Error(
    `expected an InfraError but the stage resolved with ${JSON.stringify(resolved)}`,
  );
}

/** The worktree path every fixture context reports. */
export const WORKTREE = '/tmp/specwitness-worktree-fixture';

const ENVIRONMENT: RunEnvironment = {
  nodeVersion: 'v22.12.0',
  platform: 'darwin',
  arch: 'arm64',
  specwitnessVersion: '0.1.0',
  worktreePath: WORKTREE,
  runDirectory: '.specwitness/runs/run-20260901T000000Z-ab12',
};

export interface ContextOptions {
  readonly worktreePath?: string | null;
  readonly gates?: GateResult[];
  readonly criteria?: DerivedCriterionResult[];
  readonly evidence?: Evidence[];
}

/** A `StageContext` carrying only what the gates stage legitimately reads. */
export function stageContext(options: ContextOptions = {}): StageContext {
  const run: RunAccumulator = {
    epic: 'epic-3',
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
    runId: 'run-20260901T000000Z-ab12',
    clock: new FixedClock('2026-09-01T00:00:00.000Z'),
    run,
    // The gates stage is position 5; an outcome does not exist until position 9,
    // and `snapshot()` throws before then. Throwing here proves the stage never
    // reaches for it rather than merely asserting that it should not.
    snapshot: (): RunResult => {
      throw new Error('the gates stage must not call snapshot()');
    },
  };
}
