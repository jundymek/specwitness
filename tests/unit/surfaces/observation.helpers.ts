/**
 * Test doubles for the observation surface executor.
 *
 * NOTHING HERE CASTS A `DeclaredCommand` and nothing here reaches `src/config/`. The
 * executor never sees one: its caller resolves the observation id and splits the command
 * line (settled with 4.6 at cohort intent-sync, because `adapters-core-only` forbids
 * `src/surfaces/**` both `src/config/**` and `src/pipeline/**`). So a test builds a
 * `ResolvedObservationCommand` directly — that is the real production shape, not a forgery.
 */

import type { Evidence } from '../../../src/domain/evidence.js';
import type {
  ProcessResult,
  ProcessRunner,
  ProcessRunOptions,
} from '../../../src/domain/process-runner.js';
import type { ResolvedObservationCommand } from '../../../src/surfaces/observation.js';

/** A `ProcessResult` with the fields a real observation spawn produces. */
export function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    outcome: 'completed',
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 3,
    pgid: 4242,
    ...overrides,
  };
}

/** A resolved command, as the caller (4.7) would hand one over. */
export function resolvedCommand(
  overrides: Partial<ResolvedObservationCommand> = {},
): ResolvedObservationCommand {
  return {
    commandId: 'company-count',
    displayCommand: 'node ./scripts/count.js',
    binary: 'node',
    baseArgs: ['./scripts/count.js'],
    ...overrides,
  };
}

/** A runner that replays scripted results and records every spawn it was asked for. */
export class ScriptedRunner implements ProcessRunner {
  readonly calls: ProcessRunOptions[] = [];
  readonly #results: ProcessResult[];

  constructor(...results: readonly ProcessResult[]) {
    if (results.length === 0) {
      throw new Error('ScriptedRunner needs at least one result');
    }
    this.#results = [...results];
  }

  run(options: ProcessRunOptions): Promise<ProcessResult> {
    this.calls.push(options);
    // The LAST result repeats, so a before/after pair scripted with one result sees the
    // same snapshot twice rather than failing on exhaustion.
    const index = Math.min(this.calls.length - 1, this.#results.length - 1);
    const result = this.#results[index];
    if (result === undefined) {
      throw new Error('ScriptedRunner exhausted');
    }
    return Promise.resolve(result);
  }
}

/** Everything the executor wrote, so a test can assert on the exact persisted bytes. */
export class RecordingEvidence {
  readonly files: { name: string; contents: string }[] = [];
  readonly members: Evidence[] = [];

  readonly write = (name: string, contents: string): Promise<string> => {
    this.files.push({ name, contents });
    return Promise.resolve(name);
  };

  readonly record = (evidence: Evidence): void => {
    this.members.push(evidence);
  };

  /** Every byte that left the executor: file contents and serialized members. */
  everythingPersisted(): string {
    return [
      ...this.files.map((file) => file.contents),
      ...this.members.map((member) => JSON.stringify(member)),
    ].join('\n');
  }
}
