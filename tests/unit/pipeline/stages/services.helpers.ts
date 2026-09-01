import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, type ServiceConfig } from '../../../../src/config/index.js';
import type { Clock } from '../../../../src/domain/ports.js';
import type { DerivedCriterionResult } from '../../../../src/domain/criterion-result.js';
import { InfraError } from '../../../../src/domain/errors.js';
import type { Evidence } from '../../../../src/domain/evidence.js';
import type {
  ProcessResult,
  ProcessRunOptions,
  ProcessRunner,
} from '../../../../src/domain/process-runner.js';
import type { GateResult } from '../../../../src/domain/result.js';
import type { RunEnvironment, RunResult } from '../../../../src/domain/run-result.js';
import type { RunAccumulator, StageContext } from '../../../../src/pipeline/stage.js';
import type { PortProbe, ServiceGroupRegistry } from '../../../../src/pipeline/stages/services.js';

/**
 * Test doubles for the services stage.
 *
 * Modelled on `gates.helpers.ts`, and for the same reason: `ServiceConfig`s are
 * built by writing REAL YAML and loading it through the real `loadConfig`, never
 * by casting an object literal. A `DeclaredCommand` may only be minted inside
 * `src/config` (AD-3), and a test that forged one would assert against a shape
 * the product can never actually produce.
 *
 * The declaration-order proof depends on this too, and more strongly than the
 * gates one does: `services` is a `z.record`, so "declaration order" is a
 * property of yaml + zod preserving object insertion order, not something the
 * schema promises. Only a fixture that travels the real load path can pin it.
 */

/** One service, as it is written in `.specwitness/config.yaml`. */
export interface ServiceFixture {
  readonly id: string;
  readonly run: string;
  readonly port?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly ready:
    | { readonly url: string; readonly timeoutSec?: number }
    | { readonly command: string; readonly timeoutSec?: number };
}

/** The YAML text for a set of services — shared by the loader and the order test. */
export function servicesYaml(services: readonly ServiceFixture[]): string {
  const lines = ['version: 1', 'project:', '  baseBranch: master', 'services:'];

  for (const service of services) {
    lines.push(`  ${JSON.stringify(service.id)}:`);
    lines.push(`    run: ${JSON.stringify(service.run)}`);
    if (service.port !== undefined) {
      lines.push(`    port: ${service.port}`);
    }
    if (service.env !== undefined) {
      lines.push('    env:');
      for (const [name, value] of Object.entries(service.env)) {
        lines.push(`      ${JSON.stringify(name)}: ${JSON.stringify(value)}`);
      }
    }
    lines.push('    ready:');
    if ('url' in service.ready) {
      lines.push(`      url: ${JSON.stringify(service.ready.url)}`);
    } else {
      lines.push(`      command: ${JSON.stringify(service.ready.command)}`);
    }
    if (service.ready.timeoutSec !== undefined) {
      lines.push(`      timeoutSec: ${service.ready.timeoutSec}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Real `ServiceConfig`s, minted the only way they can legitimately be minted.
 *
 * `mkdtemp` rather than a fixed path (H-8): the auto-review runs `pnpm test` in
 * this worktree concurrently with the agent, and two runs sharing a scratch
 * config would race.
 */
export function declaredServices(
  services: readonly ServiceFixture[],
): Record<string, ServiceConfig> {
  const root = mkdtempSync(join(tmpdir(), 'specwitness-services-'));
  mkdirSync(join(root, '.specwitness'));
  writeFileSync(join(root, '.specwitness', 'config.yaml'), servicesYaml(services));
  return { ...loadConfig(root).services };
}

/** A `ProcessResult` with the fields a real service spawn produces. */
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
 * A runner recording every spawn, whose results are scripted per call.
 *
 * A service spawn is DIFFERENT from a gate spawn and the double has to model the
 * difference or it proves nothing: a healthy service never exits, so its `run()`
 * promise must stay PENDING while readiness is polled. A double that resolved
 * immediately would let an implementation that (wrongly) awaited `run()` pass.
 *
 * So a scripted result of `'pending'` returns a promise that never settles
 * unless the test settles it through the returned handle.
 */
export function recordingRunner(
  ...results: readonly (ProcessResult | 'pending')[]
): RecordingRunner & { settle(index: number, result: ProcessResult): void } {
  const calls: ProcessRunOptions[] = [];
  const settlers: ((result: ProcessResult) => void)[] = [];
  let index = 0;

  return {
    calls,
    settle(callIndex, result) {
      const settler = settlers[callIndex];
      if (settler === undefined) {
        throw new Error(`no pending spawn at index ${callIndex}`);
      }
      settler(result);
    },
    run: async (options) => {
      calls.push(options);
      const scripted = results[index];
      index += 1;
      if (scripted === undefined) {
        throw new Error(
          `the services stage spawned "${options.binary}" (call ${index}) but only ` +
            `${results.length} result(s) were scripted — it should have stopped`,
        );
      }

      // The pgid is published BEFORE the outcome, exactly as the real runner
      // does: `onProcessGroup` is awaited before the run proceeds (AD-8).
      if (options.onProcessGroup !== undefined) {
        const pgid = scripted === 'pending' ? 40_000 + index : (scripted.pgid ?? 40_000 + index);
        await options.onProcessGroup(pgid);
      }

      if (scripted === 'pending') {
        return await new Promise<ProcessResult>((resolve) => {
          settlers[index - 1] = resolve;
        });
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

/** A `PortProbe` answering from a fixed map; every other port reads as free. */
export function portProbe(occupied: Readonly<Record<number, string>> = {}): PortProbe & {
  readonly asked: number[];
} {
  const asked: number[] = [];
  const probe = async (port: number): Promise<{ free: boolean; reason?: string }> => {
    asked.push(port);
    const reason = occupied[port];
    return reason === undefined ? { free: true } : { free: false, reason };
  };
  return Object.assign(probe, { asked });
}

/**
 * A registry recording what was registered and released, with no real signals.
 *
 * `onRelease` exists because the production `release` is what makes a held spawn
 * settle: terminating the group is what causes the child to exit, and that exit
 * is what publishes the captured output AC2 needs as evidence. Wiring the fake's
 * release to the fake runner's `settle` models that causality exactly, and does
 * it deterministically — the alternative (settling on a timer or a microtask)
 * would make the evidence tests race the implementation.
 */
export function recordingRegistry(
  onRelease?: (serviceId: string, pgid: number) => void,
): ServiceGroupRegistry & {
  /** Groups still live — DRAINED by release, like the real registry. */
  readonly registered: { serviceId: string; pgid: number }[];
  /** Append-only log of every registration, never drained. */
  readonly registrations: { serviceId: string; pgid: number }[];
  readonly released: { serviceId: string; pgid: number }[];
} {
  const registered: { serviceId: string; pgid: number }[] = [];
  const registrations: { serviceId: string; pgid: number }[] = [];
  const released: { serviceId: string; pgid: number }[] = [];

  const take = (serviceId: string): { serviceId: string; pgid: number } | undefined => {
    const index = registered.findIndex((entry) => entry.serviceId === serviceId);
    if (index === -1) {
      return undefined;
    }
    return registered.splice(index, 1).at(0);
  };

  return {
    registered,
    registrations,
    released,
    register(serviceId, pgid) {
      registered.push({ serviceId, pgid });
      registrations.push({ serviceId, pgid });
    },
    async release(serviceId) {
      const entry = take(serviceId);
      if (entry === undefined) {
        return;
      }
      released.push(entry);
      onRelease?.(entry.serviceId, entry.pgid);
    },
    async releaseAll() {
      for (const entry of registered.splice(0)) {
        released.push(entry);
        onRelease?.(entry.serviceId, entry.pgid);
      }
    },
  };
}

/**
 * A `Clock` that advances a fixed step on every read.
 *
 * `FixedClock` cannot be used for the readiness loop: the deadline is computed
 * from the clock (AD-9 — no `Date.now()` in a stage), so a frozen clock makes
 * elapsed time zero forever and the poll loop never terminates. A stepping clock
 * lets a test drive a timeout in a handful of iterations with no real waiting.
 */
export class SteppingClock implements Clock {
  #current: number;

  constructor(
    start: string | Date = '2026-09-01T00:00:00.000Z',
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

/** A `sleep` that records what it was asked to wait for and returns at once. */
export function instantSleep(): ((ms: number) => Promise<void>) & { readonly waits: number[] } {
  const waits: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    waits.push(ms);
  };
  return Object.assign(sleep, { waits });
}

/**
 * Awaits a stage run that MUST reject with an `InfraError`, and returns it.
 *
 * Same shape and same reason as the gates helper: a `.catch(e => e)` passes
 * silently when the stage RESOLVES, and "a service that could not start must not
 * come back as an ordinary result" is precisely this story's central assertion.
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
export const WORKTREE = '/tmp/specwitness-worktree-services-fixture';

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
  readonly clock?: Clock;
}

/** A `StageContext` carrying only what the services stage legitimately reads. */
export function stageContext(options: ContextOptions = {}): StageContext {
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
    runId: 'run-20260901T000000Z-ab12',
    clock: options.clock ?? new SteppingClock(),
    run,
    // Services is position 6; an outcome does not exist until position 9, and
    // `snapshot()` throws before then. Throwing here proves the stage never
    // reaches for it rather than merely asserting that it should not.
    snapshot: (): RunResult => {
      throw new Error('the services stage must not call snapshot()');
    },
  };
}
