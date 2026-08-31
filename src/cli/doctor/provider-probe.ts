/**
 * Provider probing for doctor — the normalisation seam (FR-3, AD-4, NFR-1).
 *
 * Doctor writes NO probe of its own. Stories 2.4 and 2.5 each expose a typed
 * capability result and an auth probe, and those are the SAME ones a real
 * invocation runs. A doctor-only probe would drift from what an actual
 * invocation does, which is the exact failure mode a diagnostic tool must not
 * have — so this module calls theirs and flattens the two shapes into one.
 *
 * WHY FLATTEN HERE RATHER THAN IN THE CHECK. The adapters' results are
 * deliberately not identical: `ClaudeCapability` has `nonInteractive` and
 * `jsonOutputFormat`, `CodexCapability` has `execAvailable` and
 * `outputSchemaSupported`; `CodexAuthProbe` carries an explicit `conclusive`
 * flag while `ClaudeAuthProbe` expresses the same distinction as
 * `exitCode === null`. A check that branched on which adapter it was talking to
 * would be the first crack in "no hardcoded dependency on any specific
 * provider", and would have to change every time an adapter grew a field.
 * Absorbing the difference at the effects boundary keeps the check one code
 * path over one shape.
 *
 * NFR-1: auth readiness comes only from the CLIs' own public behaviour —
 * `codex doctor`, and the exit code of a trivial `claude` invocation (Q58).
 * Nothing here reads a credential store, and the adapters withhold the
 * billing-risk variables from their probe children exactly as generation does,
 * so a probe cannot report auth a real invocation would not get.
 */

import type { ProviderDescriptor } from '../../domain/agent-provider.js';
import type { ProcessRunner } from '../../domain/process-runner.js';
import { probeClaudeAuth, probeClaudeCapability } from '../../providers/claude-code-cli.js';
import { probeCodexAuth, probeCodexCapability } from '../../providers/codex-cli.js';

/** Bound on every provider probe, matching `checks/git.ts`'s 5s for git. */
export const PROVIDER_PROBE_TIMEOUT_MS = 5_000;

/** Auth readiness, flattened. `conclusive` separates "said no" from "could not tell". */
export interface ProviderAuth {
  readonly ok: boolean;
  /** False when the probe never got an answer — a timeout, or no such subcommand. */
  readonly conclusive: boolean;
  readonly detail?: string;
}

/** One provider's readiness, in the single shape every check reads. */
export interface ProviderProbe {
  /** True for an adapter that spawns nothing and holds no credentials (`fake`). */
  readonly hermetic: boolean;
  readonly binary: string | null;
  readonly found: boolean;
  readonly version?: string;
  /** The adapter-specific capabilities SpecWitness needs, already judged. */
  readonly capable: boolean;
  /** What IS available, in the operator's words — e.g. "exec available". */
  readonly capabilityDetail: string;
  /** Why not found / not capable. Present only when something above is false. */
  readonly reason?: string;
  /** `null` when auth was not probed — a hermetic adapter, or an unusable binary. */
  readonly auth: ProviderAuth | null;
}

/** A provider that runs entirely in-process: nothing to find, nothing to bill. */
const HERMETIC: ProviderProbe = {
  hermetic: true,
  binary: null,
  found: true,
  capable: true,
  capabilityDetail: 'runs in-process against canned responses',
  auth: null,
};

export type ProbeProvider = (descriptor: ProviderDescriptor) => Promise<ProviderProbe>;

function flattenCodexAuth(probe: {
  ok: boolean;
  conclusive: boolean;
  detail?: string;
}): ProviderAuth {
  return {
    ok: probe.ok,
    conclusive: probe.conclusive,
    ...(probe.detail === undefined ? {} : { detail: probe.detail }),
  };
}

/**
 * Claude's probe carries no `conclusive` field: story 2.4 expresses the same
 * distinction as `exitCode === null`, meaning the probe never got an answer at
 * all. Flattening that here is the whole reason this seam exists.
 */
function flattenClaudeAuth(probe: {
  ok: boolean;
  exitCode: number | null;
  detail?: string;
}): ProviderAuth {
  return {
    ok: probe.ok,
    conclusive: probe.ok || probe.exitCode !== null,
    ...(probe.detail === undefined ? {} : { detail: probe.detail }),
  };
}

export function createProviderProbe(runner: ProcessRunner): ProbeProvider {
  return async function probeProvider(descriptor: ProviderDescriptor): Promise<ProviderProbe> {
    const options = { timeoutMs: PROVIDER_PROBE_TIMEOUT_MS };

    if (descriptor.adapter === 'fake') {
      return HERMETIC;
    }

    if (descriptor.adapter === 'claude-code-cli') {
      const capability = await probeClaudeCapability(runner, options);
      // MIRRORS THE ADAPTER'S OWN REFUSAL CONDITION, deliberately and exactly.
      // `createClaudeCodeCliProvider` throws unless `found && nonInteractive`;
      // any other predicate here would make doctor and generation disagree
      // about the same probe result — the drift this whole arrangement exists
      // to prevent, reintroduced in the renderer rather than in a second probe.
      // Being STRICTER is a defect too: it warns about a provider that works.
      const capable = capability.nonInteractive;
      return {
        hermetic: false,
        binary: capability.binary,
        found: capability.found,
        ...(capability.version === undefined ? {} : { version: capability.version }),
        capable,
        capabilityDetail: 'non-interactive available',
        ...(capability.reason === undefined ? {} : { reason: capability.reason }),
        // Auth is probed only when the binary can actually be invoked. Asking
        // an absent or incapable CLI whether it is signed in produces a failure
        // about the wrong thing, and the operator has a more basic problem.
        auth:
          capability.found && capable
            ? flattenClaudeAuth(await probeClaudeAuth(runner, options))
            : null,
      };
    }

    if (descriptor.adapter === 'codex-cli') {
      const capability = await probeCodexCapability(runner, options);
      // Same rule, same reason: `createCodexCliProvider` refuses unless `exec`
      // and `--output-schema` are present AND `missingFlags` is empty. A codex
      // new enough for `--output-schema` but missing `--output-last-message`
      // would otherwise be reported READY here and then refuse at the point of
      // use, which is exactly what AD-4 exists to prevent.
      const capable =
        capability.execAvailable &&
        capability.outputSchemaSupported &&
        (capability.missingFlags?.length ?? 0) === 0;
      return {
        hermetic: false,
        binary: capability.binary,
        found: capability.found,
        ...(capability.version === undefined ? {} : { version: capability.version }),
        capable,
        capabilityDetail: 'exec available',
        ...(capability.reason === undefined ? {} : { reason: capability.reason }),
        auth:
          capability.found && capable
            ? flattenCodexAuth(await probeCodexAuth(runner, options))
            : null,
      };
    }

    // An adapter this build does not know. The config schema rejects unknown
    // adapters, so reaching here means the schema and this function disagree —
    // report that rather than claiming readiness in either direction.
    return {
      hermetic: false,
      binary: null,
      found: false,
      capable: false,
      capabilityDetail: '',
      reason: `unknown adapter "${descriptor.adapter}" — this build of SpecWitness cannot probe it`,
      auth: null,
    };
  };
}
