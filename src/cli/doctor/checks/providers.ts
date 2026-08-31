/**
 * Configured AI providers (FR-3's provider half, UJ-4, AD-4, NFR-1 — optional).
 *
 * Story 1.5 built the registry, shipped seven checks, and deliberately refused
 * to stub this one: "a placeholder is a contract nobody agreed to". This is the
 * consumer that seam was built for, and it adds a file without touching one
 * line of the seven.
 *
 * ONE CHECK OVER ALL CONFIGURED PROVIDERS, not one check per provider. That is
 * the house pattern already set by `commands-resolvable` (every declared gate)
 * and `ports-free` (every declared service port): a check owns a config-declared
 * COLLECTION and reports each member in its detail. It also keeps the `--json`
 * check-id list identical on every project, which is what makes that list worth
 * pinning with an exact `toEqual` — ids that varied with the config would make
 * the shape unassertable and force every consumer to discover ids at runtime.
 *
 * WHAT IT REPORTS, per FR-3, for each configured provider: binary found,
 * version, non-interactive capability, auth-appears-usable, configured mode —
 * and, when something is missing, what that costs the operator.
 *
 * THIS MODULE PROBES NOTHING. It renders. The capability and auth probes belong
 * to the adapters (2.4 `claude-code-cli`, 2.5 `codex-cli`), are reached through
 * `effects.probeProvider`, and are the SAME probes a real invocation runs. A
 * second, doctor-only probe would drift from what an actual invocation does,
 * which is the exact failure mode a diagnostic tool must not have. The
 * adapter-specific result shapes are normalised in `effects.ts`, so their
 * signatures can move without this file changing.
 *
 * NFR-1: auth readiness comes exclusively from the CLIs' own public behaviour —
 * `codex doctor`, and the exit code of a trivial `claude` invocation (Q58). No
 * path here or beneath it reads `~/.claude/`, `~/.codex/`, `CLAUDE_CONFIG_DIR`,
 * `CODEX_HOME`, `.netrc` or any credential file. The AST guard in
 * `tests/unit/doctor/credential-boundary.test.ts` asserts it mechanically.
 *
 * OPTIONAL, ALWAYS (`required: false`). UJ-4's edge case is explicit: with no
 * agent CLI installed, contract GENERATION is unavailable but execution of
 * existing plans still works. A missing provider must warn and leave doctor's
 * exit code at 0. Marking this required would turn a normal project state into
 * an environment failure — and would make `specwitness doctor` fail on every
 * machine that has not installed an agent CLI it may never need.
 *
 * THREE AUTH OUTCOMES, RENDERED DISTINCTLY. "The CLI said no" and "we could not
 * tell" are different facts, and only the first is a diagnosis about the
 * operator's account. A timed-out probe reported as "not authenticated" would
 * send someone to re-login because their machine was slow.
 */

import type { ProviderConfig } from '../../../config/index.js';
import type { ProviderProbe } from '../effects.js';
import type { CheckStatus, DoctorCheck } from '../registry.js';

interface ProviderLine {
  readonly status: CheckStatus;
  readonly text: string;
}

function describeAuth(probe: ProviderProbe): string | undefined {
  const { auth } = probe;
  if (auth === null) {
    return undefined;
  }
  if (auth.ok) {
    return 'auth appears usable';
  }
  if (!auth.conclusive) {
    return `auth state unknown (${auth.detail ?? 'the probe returned no answer'})`;
  }
  return `auth does not appear usable (${auth.detail ?? 'the CLI reported a failure'})`;
}

function describeProvider(
  name: string,
  provider: ProviderConfig,
  probe: ProviderProbe,
): ProviderLine {
  const label = `${name} (${provider.adapter}, mode: ${provider.mode})`;

  // A `fake` provider is configured-and-hermetic: no binary, no version, no
  // auth, no subprocess. Reporting it as a missing binary would be a lie about
  // a deliberate, working configuration.
  if (probe.hermetic) {
    // The probe supplies the wording, not this renderer: the seam knows what
    // hermetic means for each adapter, and duplicating it here would let the
    // two drift.
    return {
      status: 'pass',
      text: `${label}: ${probe.capabilityDetail} — no binary, no subprocess, no credentials`,
    };
  }

  const binary = probe.binary ?? provider.adapter;

  if (!probe.found) {
    return {
      status: 'warn',
      text: `${label}: ${
        probe.reason ??
        `${binary} not found on PATH — contract generation unavailable; existing plans still run`
      }`,
    };
  }

  const version = probe.version === undefined ? '' : ` ${probe.version}`;

  if (!probe.capable) {
    return {
      status: 'warn',
      text: `${label}: ${binary}${version} found but ${
        probe.reason ?? 'is missing a capability SpecWitness needs'
      } — contract generation unavailable; existing plans still run`,
    };
  }

  const auth = describeAuth(probe);
  const capability = `${binary}${version} found, ${probe.capabilityDetail}`;

  if (auth === undefined) {
    return { status: 'pass', text: `${label}: ${capability}` };
  }

  return {
    status: probe.auth?.ok === true ? 'pass' : 'warn',
    text: `${label}: ${capability}, ${auth}`,
  };
}

export const providersCheck: DoctorCheck = {
  id: 'ai-providers',
  required: false,
  async run(ctx) {
    if (!ctx.config.ok) {
      // `config-valid` already reports this one fault; repeating it here would
      // turn a single problem into two and send the reader looking twice.
      return {
        status: 'warn',
        detail: 'cannot check AI providers: the project config did not load (see config-valid)',
      };
    }

    const providers = Object.entries(ctx.config.value.ai.providers ?? {});

    // NO `ai` BLOCK AT ALL IS A NORMAL PROJECT STATE, not a diagnosis. Gate and
    // HTTP verification never touch a provider; only contract and plan authoring
    // do. Reporting an absence as a warning would train the operator to ignore
    // this line on every project that does not use AI authoring.
    if (providers.length === 0) {
      return {
        status: 'pass',
        detail: 'no AI providers configured — contract generation is unavailable by choice',
      };
    }

    const lines: ProviderLine[] = [];
    for (const [name, provider] of providers) {
      const probe = await ctx.effects.probeProvider({
        name,
        adapter: provider.adapter,
        mode: provider.mode,
      });
      lines.push(describeProvider(name, provider, probe));
    }

    // Worst status wins, and it is never worse than `warn`: this check is
    // optional, so nothing it finds may move the exit code.
    const status: CheckStatus = lines.some((line) => line.status !== 'pass') ? 'warn' : 'pass';

    return { status, detail: lines.map((line) => line.text).join('; ') };
  },
};
