/**
 * FR-11 — turning a resolved role assignment into a provider instance.
 *
 * WHY THIS FILE DOES NOT LOAD CONFIG. `src/providers/**` may not import
 * `src/config/**` (AD-1, dependency-cruiser's `adapters-core-only`): adapters
 * translate the outside world into core types, they do not read the project's
 * configuration. So role resolution happens at the EDGE, where config is loaded
 * once and passed down (spine, "State & config"):
 *
 *   const resolved = resolveRoleProvider(config, 'contract-author');  // src/config/types.ts
 *   const provider = providerForRole(resolved, {processRunner, clock, warn});
 *
 * `resolveRoleProvider` already exists and is merged; it is not re-implemented
 * here. Its return value is structurally a `ProviderDescriptor`, so it passes
 * straight through with no shim — deliberately, not coincidentally.
 *
 * ADDING AN ADAPTER (stories 2.4 and 2.5): add ONE case to the switch in
 * `createProvider`, immediately above `default:`, and move nothing else. That is
 * the only edit either story makes to this file. Story 2.4 (claude) merges
 * before 2.5 (codex), so 2.5 rebases onto a file that already carries 2.4's case
 * and appends its own at the same fixed point.
 *
 * There are deliberately NO placeholder cases for the unimplemented adapters. A
 * `case 'codex-cli': throw new Error('not yet')` is a placeholder wearing a
 * switch, and a placeholder is a contract nobody agreed to — the same call
 * Epic 1 story 1.5 made about provider doctor checks. `default:` already fails
 * loudly and accurately for them.
 */

import type { AgentProvider, ProviderDeps, ProviderDescriptor } from '../domain/agent-provider.js';
import { ProviderError } from '../domain/errors.js';

import { createFakeProvider } from './fake.js';

export type { ProviderDeps } from '../domain/agent-provider.js';

/** Adapter kinds this build can actually construct. Grows with 2.4 and 2.5. */
const IMPLEMENTED_ADAPTERS = ['fake'] as const;

/**
 * Build the adapter a descriptor names.
 *
 * Throws `ProviderError` (AD-7, exit 3) for an adapter this build cannot
 * construct. Note that `claude-code-cli` and `codex-cli` are VALID config values
 * — story 1.3's schema has carried them since Epic 1 — and still land here until
 * stories 2.4 and 2.5 implement them. Failing loudly, naming the adapter, is the
 * honest behaviour: the alternative is a stub that appears to work and produces
 * nothing.
 */
export function createProvider(descriptor: ProviderDescriptor, deps: ProviderDeps): AgentProvider {
  switch (descriptor.adapter) {
    case 'fake':
      return createFakeProvider(descriptor, deps);

    // ↓ Stories 2.4 (claude-code-cli) and 2.5 (codex-cli) each add ONE case
    //   here, immediately above `default:`. Nothing else in this file moves.

    default:
      throw new ProviderError(
        `provider "${descriptor.name}" names adapter "${descriptor.adapter}", which this ` +
          'build cannot construct',
        `supported adapters: ${IMPLEMENTED_ADAPTERS.join(', ')} — ` +
          "check 'ai.providers' in .specwitness/config.yaml",
      );
  }
}

/**
 * Build the provider for an already-resolved role, or report its absence.
 *
 * `undefined` in ⇒ `undefined` out, and it NEVER throws for an unassigned role.
 * That is FR-11's "unassigned optional roles degrade gracefully", and the
 * emphasis is on where the decision lives: an unassigned role is DATA, and the
 * caller decides what it means. A missing `explainer` must never break contract
 * generation (UJ-4's edge case); a missing `contract-author` should stop the
 * `contract` command with a clear message. Only the caller knows which.
 *
 * It also never substitutes a default. Quietly promoting the project's only
 * configured provider to fill a role nobody assigned is exactly the sort of
 * helpfulness that makes a verification tool untrustworthy.
 */
export function providerForRole(
  resolved: ProviderDescriptor | undefined,
  deps: ProviderDeps,
): AgentProvider | undefined {
  return resolved === undefined ? undefined : createProvider(resolved, deps);
}

export { createFakeProvider } from './fake.js';
export { attemptInvoke, invoke } from './invoke.js';
export type { InvokeDeps, InvokeOptions } from './invoke.js';
