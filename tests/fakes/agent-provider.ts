/**
 * Unit-test doubles for the provider and process ports (AD-12).
 *
 * These live under `tests/` because a fake shipped in the published package is a
 * fake somebody eventually injects in production (Epic 1 story 1.6's decision,
 * and the same reason `FixedClock` lives beside them in `tests/fakes/ports.ts`).
 *
 * NOT TO BE CONFUSED WITH `src/providers/fake.ts`, which is a SHIPPED,
 * config-selectable adapter (`adapter: fake`) that reads canned responses from a
 * fixture directory. That one is a product feature: Epic 6's hermetic corpus
 * end-to-end drives the real `specwitness` binary with no agent CLI installed,
 * which a `tests/`-only double cannot serve. These are throwaway doubles for
 * unit tests. Do not "fix" either by moving it to where the other one lives.
 *
 * Shared with stories 2.4 and 2.5: use these rather than writing a second set.
 */

import type { AgentPrompt, AgentProvider } from '../../src/domain/agent-provider.js';
import type { ProcessResult, ProcessRunOptions, ProcessRunner } from '../../src/domain/process-runner.js';

/** A provider that replays a scripted sequence of raw responses. */
export interface ScriptedProvider extends AgentProvider {
  /** Every prompt the gate handed it, in order — assert the retry feedback here. */
  readonly prompts: AgentPrompt[];
}

/**
 * Returns each scripted response in turn; the last one repeats once exhausted,
 * so a one-entry script is a constant provider and a test never fails merely by
 * asking one more time than it planned.
 */
export function scriptedProvider(...rawResponses: readonly string[]): ScriptedProvider {
  if (rawResponses.length === 0) {
    throw new Error('scriptedProvider needs at least one response');
  }
  const prompts: AgentPrompt[] = [];
  let index = 0;

  return {
    id: 'scripted',
    adapter: 'fake',
    prompts,
    generate: async (prompt) => {
      prompts.push(prompt);
      const raw = rawResponses[Math.min(index, rawResponses.length - 1)];
      index += 1;
      return raw ?? '';
    },
  };
}

/** A provider whose `generate` always rejects — the "the CLI blew up" path. */
export function throwingProvider(error: Error): AgentProvider {
  return {
    id: 'throwing',
    adapter: 'fake',
    generate: async () => {
      throw error;
    },
  };
}

/**
 * A provider that returns unusable text `failures` times, then succeeds.
 * Sugar over `scriptedProvider` for walking the retry matrix.
 */
export function failThenSucceed(failures: number, success: string): ScriptedProvider {
  return scriptedProvider(...Array.from({ length: failures }, () => 'not json at all'), success);
}

/**
 * AC3's guard: a `ProcessRunner` that turns any spawn into a test failure.
 *
 * This is how "zero real subprocesses in the domain/application suites" becomes
 * a tested property rather than a convention — inject it, exercise the fake
 * path, and a stray spawn cannot pass silently.
 */
export function forbiddenProcessRunner(): ProcessRunner {
  return {
    run: async (options: ProcessRunOptions) => {
      throw new Error(
        `AD-12 violation: a domain/application test tried to spawn "${options.binary}". ` +
          'Unit tests must go through a fake provider, never a real subprocess.',
      );
    },
  };
}

/** A `ProcessRunner` replaying scripted results — for 2.4/2.5 adapter unit tests. */
export interface ScriptedProcessRunner extends ProcessRunner {
  readonly calls: ProcessRunOptions[];
}

export function scriptedProcessRunner(...results: readonly ProcessResult[]): ScriptedProcessRunner {
  if (results.length === 0) {
    throw new Error('scriptedProcessRunner needs at least one result');
  }
  const calls: ProcessRunOptions[] = [];
  let index = 0;

  return {
    calls,
    run: async (options) => {
      calls.push(options);
      const result = results[Math.min(index, results.length - 1)];
      index += 1;
      if (result === undefined) {
        throw new Error('scriptedProcessRunner exhausted');
      }
      return result;
    },
  };
}
