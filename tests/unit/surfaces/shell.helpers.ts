/**
 * Test doubles for the shell surface executor (story 4.6).
 *
 * The important one is `throwingRunner`. AC2 says an undeclared id or an
 * out-of-allowlist argument is "rejected before any execution", and Epic 3's
 * learning 3 is that a guard must encode the distinguishing fact rather than a
 * proxy for it. Asserting that a `ConfigError` was thrown is a proxy: it would
 * pass just as green if the rejection happened AFTER the spawn. A runner that
 * throws the moment it is called encodes the fact itself — nothing ran.
 *
 * Nothing here mints a `DeclaredCommand`. The executor receives a
 * `ResolvedShellCommand` — a plain-string value object the CALLER builds from
 * `commandText(...)` and `splitCommandLine(...)` — so these fixtures construct
 * exactly what the product constructs, with no cast anywhere.
 */

import type { Evidence } from '../../../src/domain/evidence.js';
import type {
  ProcessResult,
  ProcessRunOptions,
  ProcessRunner,
} from '../../../src/domain/process-runner.js';
import type { ResolvedShellCommand } from '../../../src/surfaces/shell.js';

/** A `ProcessResult` with the fields a real spawn produces. */
export function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    outcome: 'completed',
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 11,
    pgid: 4242,
    ...overrides,
  };
}

export interface RecordingRunner extends ProcessRunner {
  readonly calls: ProcessRunOptions[];
}

/** A runner replaying scripted results and recording every call, in order. */
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
          `the shell executor spawned "${options.binary}" (call ${index}) but only ` +
            `${results.length} result(s) were scripted`,
        );
      }
      return result;
    },
  };
}

/**
 * A runner that FAILS THE TEST if it is called at all.
 *
 * This is the "rejected before any execution" proof. It throws a plain `Error`
 * rather than an `InfraError` deliberately: the executor's own rejection is a
 * `ConfigError`, so a test asserting `ConfigError` cannot accidentally be
 * satisfied by this one, and the failure message names what went wrong instead
 * of being swallowed as an expected rejection.
 */
export function throwingRunner(): RecordingRunner {
  const calls: ProcessRunOptions[] = [];
  return {
    calls,
    run: async (options) => {
      calls.push(options);
      throw new Error(
        `the shell executor spawned "${options.binary}" with args ` +
          `${JSON.stringify(options.args)} — it must reject BEFORE any execution`,
      );
    },
  };
}

export interface RecordingWriter {
  (relativeName: string, contents: string): Promise<string>;
  /** Every file the executor asked to write, in order, with its exact bytes. */
  readonly writes: { name: string; contents: string }[];
}

/**
 * Records the EXACT bytes handed to `RunStore.writeEvidenceFile`.
 *
 * Exact bytes rather than an intention, because the seeded-secret proof is
 * about what lands on disk: an evidence constructor can redact the inline copy
 * perfectly while the full file beside it keeps the secret verbatim, and the
 * obvious test certifies that hole as clean.
 */
export function recordingWriter(): RecordingWriter {
  const writes: { name: string; contents: string }[] = [];
  const writer = async (name: string, contents: string): Promise<string> => {
    writes.push({ name, contents });
    return name;
  };
  return Object.assign(writer, { writes });
}

export interface RecordingSink {
  (evidence: Evidence): void;
  /** Every typed member handed to the sink, in order. */
  readonly members: Evidence[];
}

/**
 * The `recordEvidence` sink 4.7 binds to `context.run.evidence.push`.
 *
 * Cohort-2 shape (bob's ruling, 2026-09-01): a `SurfaceExecutor` cannot reach
 * the run accumulator — `adapters-core-only` forbids it — so the typed member
 * travels through an injected callback instead. Without it `RunResult.evidence`
 * would be empty for every probe and the renderer, whose signature is
 * `(result: RunResult) => string`, could not show probe evidence at all.
 */
export function recordingSink(): RecordingSink {
  const members: Evidence[] = [];
  const sink = (evidence: Evidence): void => {
    members.push(evidence);
  };
  return Object.assign(sink, { members });
}

/** The worktree every fixture reports as the cwd (AD-8). */
export const WORKTREE = '/tmp/specwitness-shell-worktree-fixture';

/**
 * A resolved command exactly as the caller (4.7) builds it.
 *
 * `binary` and `baseArgs` are what `splitCommandLine(commandText(declared))`
 * returns; `displayCommand` is `commandText(declared)`. The executor never sees
 * a `DeclaredCommand` and never mints one.
 */
export function resolvedCommand(
  overrides: Partial<ResolvedShellCommand> = {},
): ResolvedShellCommand {
  return {
    commandId: 'migrations-applied',
    displayCommand: 'node scripts/check.js',
    binary: 'node',
    baseArgs: ['scripts/check.js'],
    ...overrides,
  };
}

/**
 * Builds `ProbeRequest.params` in the MERGED `ShellProbe` shape.
 *
 * Every test goes through this rather than hand-writing an object, because the
 * whole reason the flattened shape survived so long is that each test wrote its
 * own copy of it: a suite built entirely from one hand-written shape cannot
 * detect that the shape is wrong. One builder means one place to be wrong, and
 * `tests/integration/surfaces/shell-plan-shape.test.ts` pins it against a probe
 * parsed from real plan YAML by the merged `parsePlan`.
 */
export function probeParams(
  overrides: {
    id?: string;
    commandId?: string;
    args?: unknown;
    argumentAllowlist?: unknown;
    assertions?: unknown;
    attempt?: number;
  } = {},
): Readonly<Record<string, unknown>> {
  const {
    id = 'migrations-check',
    commandId = 'migrations-applied',
    args = [],
    argumentAllowlist = [],
    assertions = [
      {
        description: 'exits cleanly',
        target: { source: 'exitCode' },
        comparison: 'equals',
        expected: '0',
      },
    ],
    attempt,
  } = overrides;

  return {
    id,
    surface: 'shell',
    mechanics: { commandId, args, argumentAllowlist },
    assertions,
    ...(attempt === undefined ? {} : { attempt }),
  } as Readonly<Record<string, unknown>>;
}
