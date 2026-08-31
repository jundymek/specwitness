/**
 * The `fake` provider adapter — a SHIPPED FEATURE, not a test double.
 *
 * Read this before deciding it is in the wrong directory: `tests/fakes/` is
 * where this project's test doubles live (Epic 1 story 1.6's decision, and a
 * fake shipped in the published package is a fake somebody eventually injects in
 * production). This one is the deliberate exception, for one concrete reason:
 * Epic 6's hermetic Golden Corpus end-to-end drives the REAL `specwitness`
 * binary with no agent CLI installed and no network, and stories 2.6 and 2.7
 * configure it the same way in their integration tests. A double that lives only
 * in `tests/` cannot be selected by a config file, so it cannot serve any of
 * that. The spine's Structural Seed lists it here for the same reason
 * ("claude-code-cli, codex-cli, fake adapters" under `src/providers/`).
 *
 * So: `tests/fakes/agent-provider.ts` holds throwaway unit-test doubles; this
 * file is a config-selectable product feature. Do not "fix" either by moving it
 * to where the other one lives.
 *
 * CONFIGURATION — no schema of its own, deliberately:
 *
 *   ai:
 *     providers:
 *       hermetic: { adapter: fake, mode: tests/fixtures/providers/contract }
 *       roles: { contract-author: hermetic }
 *
 * `mode` is reused as the fixture DIRECTORY. Every adapter already has a `mode`
 * string (`subscription`, `api`, `chatgpt`), so the fake needs no new config key
 * and story 1.3's schema needs no change beyond the one enum value.
 *
 * FIXTURE FORMAT: `<mode>/<role>.json` is a JSON array of RAW response strings.
 * Call N of that role returns entry N; once the script is exhausted the LAST
 * entry repeats, so a one-entry fixture is a constant provider. That is what
 * makes AC2 testable end to end: `["not json", "{...valid...}"]` scripts a
 * malformed-then-valid sequence, driving the real gate's retry loop from the
 * outside without a subprocess.
 *
 * Each role has its own counter — otherwise one role's retries would silently
 * consume another role's script.
 *
 * AD-2: like every adapter, this one returns RAW TEXT and never validates,
 * never retries and never parses. Its fixtures are deliberately allowed to be
 * invalid; rejecting them is the gate's job.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import type {
  AgentPrompt,
  AgentProvider,
  AgentRole,
  ProviderDeps,
  ProviderDescriptor,
} from '../domain/agent-provider.js';
import { ProviderError } from '../domain/errors.js';

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * Build the fake adapter.
 *
 * `deps` is accepted and unused: the fake spawns nothing, which is precisely the
 * property AC3's no-subprocess guard asserts. Taking the same parameter as every
 * other adapter keeps `createProvider`'s switch uniform.
 */
export function createFakeProvider(
  descriptor: ProviderDescriptor,
  _deps: ProviderDeps,
): AgentProvider {
  // A relative `mode` is resolved against the process working directory, which
  // is the project root for every CLI entry point. Absolute paths pass through,
  // so a corpus fixture can live outside the project when Epic 6 needs it to.
  const fixtureDir = isAbsolute(descriptor.mode)
    ? descriptor.mode
    : resolve(process.cwd(), descriptor.mode);

  /** Scripts are read once per role and then replayed from memory. */
  const scripts = new Map<AgentRole, readonly string[]>();
  const calls = new Map<AgentRole, number>();

  const loadScript = async (role: AgentRole): Promise<readonly string[]> => {
    const cached = scripts.get(role);
    if (cached !== undefined) {
      return cached;
    }

    const path = join(fixtureDir, `${role}.json`);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      // Deliberately does not distinguish "no directory" from "no file for this
      // role": both mean the same thing to whoever has to fix it, and the path
      // in the message says which.
      throw new ProviderError(
        `provider "${descriptor.name}" (adapter: fake) has no fixture for role "${role}" at ${path}`,
        `create ${path} containing a JSON array of raw response strings, ` +
          `or point '${descriptor.name}.mode' at a directory that has one`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new ProviderError(
        `provider "${descriptor.name}" (adapter: fake) fixture ${path} is not valid JSON: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        'the fixture must be a JSON array of raw response strings',
      );
    }

    if (!isStringArray(parsed) || parsed.length === 0) {
      throw new ProviderError(
        `provider "${descriptor.name}" (adapter: fake) fixture ${path} must be a non-empty ` +
          'JSON array of strings, one raw response per scripted attempt',
        'example: ["not json at all", "{\\"criteria\\": []}"] scripts a malformed-then-valid sequence',
      );
    }

    scripts.set(role, parsed);
    return parsed;
  };

  const generate = async (prompt: AgentPrompt): Promise<string> => {
    const script = await loadScript(prompt.role);
    const index = calls.get(prompt.role) ?? 0;
    calls.set(prompt.role, index + 1);

    // Past the end, the last entry repeats — see the header.
    return script[Math.min(index, script.length - 1)] ?? '';
  };

  return { id: descriptor.name, adapter: descriptor.adapter, generate };
}
